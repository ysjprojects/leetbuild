import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/requests/{id}: the trail as it was pinned',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/requests/{id}\`: it loads the request
(\`store.load\`, 404 when there is none), resolves its chain with \`policy.resolve_approvers\`, reads
\`step_index\`, \`status\` and each step's \`decision:{i}\` and \`actor:{i}\` from
\`approval:{id}:state\` one \`HGET\` at a time, and answers
\`{request_id, chain_id, chain_version, status, step_index, steps: [{step, approver, state, actor}]}\`
with \`Cache-Control: public, max-age=60\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** Anybody who guesses an id reads another tenant's approvals;
after a policy edit the trail lists approvers the request never had; a decision landing mid-read
yields a trail that contradicts itself; a shared cache hands one tenant's trail, stale, to the next
caller.

- \`X-Tenant-Id\` is required (**401**); another tenant's request is **404**, like one that does not
  exist.
- The chain is the one **pinned on the request** (\`chain_version\`, \`approvers\`); the policy is not
  consulted.
- The state is read in **one command** (\`HGETALL\`), so every field is from the same moment; an
  undecided step is \`pending\`.
- The response carries \`Cache-Control: private, no-store\`.`,
  sequence: {
    participants: ['Client', 'Approval API', 'request store', 'Redis'],
    messages: [
      {from: 'Client', to: 'Approval API', label: 'GET /v1/requests/r-1 · X-Tenant-Id', kind: 'sync'},
      {from: 'Approval API', to: 'request store', label: 'load(r-1)', kind: 'sync'},
      {from: 'request store', to: 'Approval API', label: 'tenant · chain_version 3 · approvers', kind: 'reply'},
      {from: 'Approval API', to: 'Approval API', label: 'other tenant → 404', kind: 'sync'},
      {from: 'Approval API', to: 'Redis', label: 'HGETALL approval:r-1:state', kind: 'sync'},
      {from: 'Redis', to: 'Approval API', label: 'step_index · status · decision:{i} · actor:{i}', kind: 'reply'},
      {from: 'Approval API', to: 'Client', label: '200 · Cache-Control: private, no-store', kind: 'reply'},
    ],
  },
  hints: [
    'Read r-1 with another tenant’s header: the trail comes back. Edit the chain policy and read again: the steps follow the new policy. Approve while a read is running: the step index and the steps disagree.',
    'Nothing reads `X-Tenant-Id`; the steps come from `resolve_approvers` (today’s policy) instead of the stored request; each field is its own `HGET`, a separate moment; and the response is marked `public`.',
    'Require the header (401) and 404 unless `stored["tenant"]` matches; build the steps from `stored["approvers"]` and `stored["chain_version"]`; read the state with one `hgetall`; send `Cache-Control: private, no-store`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/requests/{id}',
      detail: 'Register the read on `GET /v1/requests/{id}` and answer every step of the chain with its own state.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/requests\/\{/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/requests\/:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/requests\/\{/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"requests"\s*\/\s*Segment\s*\)/, /\bget\b/]},
        cpp: {all: [/svr\.Get\(\s*R?"[^"]*\/v1\/requests\//]},
      },
    },
    {
      id: 'tenant-404',
      title: 'Another tenant’s request is 404',
      detail:
        'The read requires `X-Tenant-Id` (401) and answers 404 when the stored request belongs to another tenant: not the trail, and not a 403 that confirms the id exists.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized|\b401\b/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'pinned-chain',
      title: 'Reports the chain pinned on the request',
      detail:
        'The steps and `chain_version` come from the stored request, which pinned them at submit time; the current policy is not consulted, so a policy edit cannot rewrite a trail.',
      match: {
        python: {all: [/chain_version/], none: [/resolve_approvers/]},
        typescript: {all: [/chain_version/], none: [/resolveApprovers/]},
        go: {all: [/ChainVersion/], none: [/ResolveApprovers/]},
        scala: {all: [/chainVersion/], none: [/resolveApprovers/]},
        cpp: {all: [/chain_version/], none: [/resolveApprovers/]},
      },
    },
    {
      id: 'one-snapshot',
      title: 'Reads the state in one command',
      detail:
        'The whole state hash is read with one `HGETALL`, so the step index, the status and every decision come from the same moment; separate `HGET`s let a decision land between them.',
      match: {
        python: {all: [/\.hgetall\(/], none: [/\.hget\(/]},
        typescript: {all: [/\.hgetall\(/], none: [/\.hget\(/]},
        go: {all: [/\.HGetAll\(/], none: [/\.HGet\(/]},
        scala: {all: [/\.hgetAll\(/], none: [/\.hget\(/]},
        cpp: {all: [/\.hgetall\(/], none: [/\.hget\(/]},
      },
    },
    {
      id: 'no-store',
      title: 'Keeps the trail out of shared caches',
      detail:
        'The response carries `Cache-Control: private, no-store`: a trail is per tenant and changes with every decision, so no shared cache may keep it.',
      match: {
        python: {all: [/no-store/], none: [/public/]},
        typescript: {all: [/no-store/], none: [/public/]},
        go: {all: [/no-store/], none: [/public/]},
        scala: {all: [/no-store/], none: [/public/]},
        cpp: {all: [/no-store/], none: [/public/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from approvals import policy, store  # policy.resolve_approvers · store.load

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/requests/{request_id}")
def read_request(request_id: str) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    stored = store.load(request_id)
    if stored is None:
        return JSONResponse({"error": "no such request"}, status_code=404)
    current = policy.resolve_approvers(stored["chain_id"])
    key = f"approval:{request_id}:state"
    step_index = int(r.hget(key, "step_index") or 0)
    status = r.hget(key, "status") or ""
    steps = [
        {"step": i, "approver": approver, "state": r.hget(key, f"decision:{i}") or "pending", "actor": r.hget(key, f"actor:{i}") or ""}
        for i, approver in enumerate(current["approvers"])
    ]
    body = {
        "request_id": request_id,
        "chain_id": stored["chain_id"],
        "chain_version": current["version"],
        "status": status,
        "step_index": step_index,
        "steps": steps,
    }
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=60"})  # the trail page polls this
`,
      solution: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from approvals import store  # store.load

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/requests/{request_id}")
def read_request(request_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    stored = store.load(request_id)
    if stored is None or stored["tenant"] != tenant:
        # Another tenant's request does not exist for this caller: same answer, nothing confirmed.
        return JSONResponse({"error": "no such request"}, status_code=404)
    state = r.hgetall(f"approval:{request_id}:state")  # one command: every field from the same moment
    # The chain pinned at submit time, whatever the policy says today.
    steps = [
        {"step": i, "approver": approver, "state": state.get(f"decision:{i}", "pending"), "actor": state.get(f"actor:{i}", "")}
        for i, approver in enumerate(stored["approvers"])
    ]
    body = {
        "request_id": request_id,
        "chain_id": stored["chain_id"],
        "chain_version": stored["chain_version"],
        "status": state.get("status", ""),
        "step_index": int(state.get("step_index", 0)),
        "steps": steps,
    }
    return JSONResponse(body, headers={"Cache-Control": "private, no-store"})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as policy from 'approvals/policy'; // policy.resolveApprovers
import * as store from 'approvals/store'; // store.load

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/requests/:requestId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {requestId} = request.params as {requestId: string};
  const stored = await store.load(requestId);
  if (stored === null) return reply.code(404).send({error: 'no such request'});
  const current = await policy.resolveApprovers(stored.chain_id);
  const key = \`approval:\${requestId}:state\`;
  const stepIndex = Number((await redis.hget(key, 'step_index')) ?? 0);
  const status = (await redis.hget(key, 'status')) ?? '';
  const steps = [];
  for (const [i, approver] of (current?.approvers ?? []).entries()) {
    const state = (await redis.hget(key, \`decision:\${i}\`)) ?? 'pending';
    const actor = (await redis.hget(key, \`actor:\${i}\`)) ?? '';
    steps.push({step: i, approver, state, actor});
  }
  reply.header('Cache-Control', 'public, max-age=60'); // the trail page polls this
  return {request_id: requestId, chain_id: stored.chain_id, chain_version: current?.version, status, step_index: stepIndex, steps};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as store from 'approvals/store'; // store.load

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/requests/:requestId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {requestId} = request.params as {requestId: string};
  const stored = await store.load(requestId);
  // Another tenant's request does not exist for this caller: same answer, nothing confirmed.
  if (stored === null || stored.tenant !== tenant) return reply.code(404).send({error: 'no such request'});
  const state = await redis.hgetall(\`approval:\${requestId}:state\`); // one command: every field from the same moment
  // The chain pinned at submit time, whatever the policy says today.
  const steps = stored.approvers.map((approver, i) => ({
    step: i,
    approver,
    state: state[\`decision:\${i}\`] ?? 'pending',
    actor: state[\`actor:\${i}\`] ?? '',
  }));
  reply.header('Cache-Control', 'private, no-store');
  return {
    request_id: requestId,
    chain_id: stored.chain_id,
    chain_version: stored.chain_version,
    status: state.status ?? '',
    step_index: Number(state.step_index ?? 0),
    steps,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"approvals/policy" // policy.ResolveApprovers
	"approvals/store"  // store.Load
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type stepView struct {
	Step     int    \`json:"step"\`
	Approver string \`json:"approver"\`
	State    string \`json:"state"\`
	Actor    string \`json:"actor"\`
}

type requestView struct {
	RequestID    string     \`json:"request_id"\`
	ChainID      string     \`json:"chain_id"\`
	ChainVersion int        \`json:"chain_version"\`
	Status       string     \`json:"status"\`
	StepIndex    int        \`json:"step_index"\`
	Steps        []stepView \`json:"steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRequest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	requestID := r.PathValue("id")
	stored, err := store.Load(ctx, requestID)
	if err != nil || stored == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such request"})
		return
	}
	current, err := policy.ResolveApprovers(ctx, stored.ChainID)
	if err != nil || current == nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "no chain policy"})
		return
	}
	key := "approval:" + requestID + ":state"
	stepIndex, _ := strconv.Atoi(rdb.HGet(ctx, key, "step_index").Val())
	view := requestView{RequestID: requestID, ChainID: stored.ChainID, ChainVersion: current.Version, Status: rdb.HGet(ctx, key, "status").Val(), StepIndex: stepIndex, Steps: []stepView{}}
	for i, approver := range current.Approvers {
		state := rdb.HGet(ctx, key, fmt.Sprintf("decision:%d", i)).Val()
		if state == "" {
			state = "pending"
		}
		view.Steps = append(view.Steps, stepView{Step: i, Approver: approver, State: state, Actor: rdb.HGet(ctx, key, fmt.Sprintf("actor:%d", i)).Val()})
	}
	rw.Header().Set("Cache-Control", "public, max-age=60") // the trail page polls this
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/requests/{id}", readRequest)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"approvals/store" // store.Load
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type stepView struct {
	Step     int    \`json:"step"\`
	Approver string \`json:"approver"\`
	State    string \`json:"state"\`
	Actor    string \`json:"actor"\`
}

type requestView struct {
	RequestID    string     \`json:"request_id"\`
	ChainID      string     \`json:"chain_id"\`
	ChainVersion int        \`json:"chain_version"\`
	Status       string     \`json:"status"\`
	StepIndex    int        \`json:"step_index"\`
	Steps        []stepView \`json:"steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRequest(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	requestID := r.PathValue("id")
	stored, err := store.Load(ctx, requestID)
	if err != nil || stored == nil || stored.Tenant != tenant {
		// Another tenant's request does not exist for this caller: same answer, nothing confirmed.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such request"})
		return
	}
	state, err := rdb.HGetAll(ctx, "approval:"+requestID+":state").Result() // one command: every field from the same moment
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	stepIndex, _ := strconv.Atoi(state["step_index"])
	view := requestView{RequestID: requestID, ChainID: stored.ChainID, ChainVersion: stored.ChainVersion, Status: state["status"], StepIndex: stepIndex, Steps: []stepView{}}
	// The chain pinned at submit time, whatever the policy says today.
	for i, approver := range stored.Approvers {
		decision, decided := state[fmt.Sprintf("decision:%d", i)]
		if !decided {
			decision = "pending"
		}
		view.Steps = append(view.Steps, stepView{Step: i, Approver: approver, State: decision, Actor: state[fmt.Sprintf("actor:%d", i)]})
	}
	rw.Header().Set("Cache-Control", "private, no-store")
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/requests/{id}", readRequest)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import approvals.{Policy, Store} // Policy.resolveApprovers · Store.load

object Read {
  val jedis = new JedisPooled("redis", 6379)

  def read(tenant: String, requestId: String): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    Store.load(requestId) match {
      case None => HttpResponse(StatusCodes.NotFound, entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"no such request"}"""))
      case Some(stored) =>
        val current = Policy.resolveApprovers(stored.chainId).getOrElse(Policy.Chain(0, Seq.empty))
        val key = s"approval:$requestId:state"
        val stepIndex = Option(jedis.hget(key, "step_index")).map(_.toLong).getOrElse(0L)
        val status = Option(jedis.hget(key, "status")).getOrElse("")
        val steps = current.approvers.zipWithIndex.map { case (approver, i) =>
          JsObject(
            "step" -> JsNumber(i),
            "approver" -> JsString(approver),
            "state" -> JsString(Option(jedis.hget(key, s"decision:$i")).getOrElse("pending")),
            "actor" -> JsString(Option(jedis.hget(key, s"actor:$i")).getOrElse("")))
        }
        val body = JsObject(
          "request_id" -> JsString(requestId), "chain_id" -> JsString(stored.chainId), "chain_version" -> JsNumber(current.version),
          "status" -> JsString(status), "step_index" -> JsNumber(stepIndex), "steps" -> JsArray(steps.toVector))
        // the trail page polls this
        HttpResponse(StatusCodes.OK, headers = List(RawHeader("Cache-Control", "public, max-age=60")),
          entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
    }
  }

  val route: Route = path("v1" / "requests" / Segment) { requestId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        complete(read(tenant.getOrElse(""), requestId))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import approvals.Store // Store.load

object Read {
  val jedis = new JedisPooled("redis", 6379)

  private def error(status: StatusCode, message: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject("error" -> JsString(message)).compactPrint))

  def read(tenant: String, requestId: String): HttpResponse = {
    if (tenant.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    Store.load(requestId).filter(_.tenant == tenant) match {
      // Another tenant's request does not exist for this caller: same answer, nothing confirmed.
      case None => error(StatusCodes.NotFound, "no such request")
      case Some(stored) =>
        val state = jedis.hgetAll(s"approval:$requestId:state").asScala // one command: every field from the same moment
        // The chain pinned at submit time, whatever the policy says today.
        val steps = stored.approvers.zipWithIndex.map { case (approver, i) =>
          JsObject(
            "step" -> JsNumber(i),
            "approver" -> JsString(approver),
            "state" -> JsString(state.getOrElse(s"decision:$i", "pending")),
            "actor" -> JsString(state.getOrElse(s"actor:$i", "")))
        }
        val body = JsObject(
          "request_id" -> JsString(requestId), "chain_id" -> JsString(stored.chainId), "chain_version" -> JsNumber(stored.chainVersion),
          "status" -> JsString(state.getOrElse("status", "")), "step_index" -> JsNumber(state.get("step_index").map(_.toLong).getOrElse(0L)),
          "steps" -> JsArray(steps.toVector))
        HttpResponse(StatusCodes.OK, headers = List(RawHeader("Cache-Control", "private, no-store")),
          entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
    }
  }

  val route: Route = path("v1" / "requests" / Segment) { requestId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        complete(read(tenant.getOrElse(""), requestId))
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

#include "approvals/policy.h"  // policy::resolveApprovers
#include "approvals/store.h"   // store::load

using json = nlohmann::json;

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

void read_request(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string request_id = req.matches[1];
  const auto stored = store::load(request_id);
  if (!stored) {
    res.status = 404;
    res.set_content(R"({"error":"no such request"})", "application/json");
    return;
  }
  const policy::Chain current = policy::resolveApprovers(stored->chain_id).value_or(policy::Chain{});
  const std::string key = "approval:" + request_id + ":state";
  const auto step_index = redis().hget(key, "step_index");
  const auto status = redis().hget(key, "status");
  json steps = json::array();
  for (size_t i = 0; i < current.approvers.size(); i++) {
    const auto decision = redis().hget(key, "decision:" + std::to_string(i));
    const auto actor = redis().hget(key, "actor:" + std::to_string(i));
    steps.push_back({{"step", i}, {"approver", current.approvers[i]}, {"state", decision ? *decision : "pending"}, {"actor", actor ? *actor : ""}});
  }
  const json body = {{"request_id", request_id},       {"chain_id", stored->chain_id},
                     {"chain_version", current.version}, {"status", status ? *status : ""},
                     {"step_index", step_index ? std::stol(*step_index) : 0L}, {"steps", steps}};
  res.set_header("Cache-Control", "public, max-age=60");  // the trail page polls this
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/requests/([\\w-]+))", read_request); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "approvals/store.h"  // store::load

using json = nlohmann::json;

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

void read_request(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"X-Tenant-Id is required"})", "application/json");
    return;
  }
  const std::string request_id = req.matches[1];
  const auto stored = store::load(request_id);
  if (!stored || stored->tenant != tenant) {
    // Another tenant's request does not exist for this caller: same answer, nothing confirmed.
    res.status = 404;
    res.set_content(R"({"error":"no such request"})", "application/json");
    return;
  }
  // one command: every field from the same moment
  const std::unordered_map<std::string, std::string> state = redis().hgetall("approval:" + request_id + ":state");
  const auto field = [&state](const std::string& name, const std::string& fallback) {
    const auto found = state.find(name);
    return found == state.end() ? fallback : found->second;
  };
  // The chain pinned at submit time, whatever the policy says today.
  json steps = json::array();
  for (size_t i = 0; i < stored->approvers.size(); i++) {
    steps.push_back({{"step", i},
                     {"approver", stored->approvers[i]},
                     {"state", field("decision:" + std::to_string(i), "pending")},
                     {"actor", field("actor:" + std::to_string(i), "")}});
  }
  const json body = {{"request_id", request_id},
                     {"chain_id", stored->chain_id},
                     {"chain_version", stored->chain_version},
                     {"status", field("status", "")},
                     {"step_index", std::stol(field("step_index", "0"))},
                     {"steps", steps}};
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/requests/([\\w-]+))", read_request); }
`,
    },
  },
  harness: {
    python: `from approvals import chain, policy, store

ACME = {"X-Tenant-Id": "t-acme"}


def _read(ctx):
    policy.define_chain("spend", 3, ["u-mgr", "u-dir"])
    store.put({"request_id": "r-1", "tenant": "t-acme", "requester": "u-req", "chain_id": "spend", "chain_version": 3,
               "approvers": ["u-mgr", "u-dir"], "why": "new laptop", "amount_cents": 420000}, "k-1")
    chain.start_chain("r-1", ["u-mgr", "u-dir"])
    return ctx.client(ctx.load("read").app)


def _step(i, approver, state, actor=""):
    return {"step": i, "approver": approver, "state": state, "actor": actor}


async def check_route(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/requests/r-1", headers=ACME)
        assert r.status_code == 200, f"GET /v1/requests/r-1 answered {r.status_code}: {r.text}"
        body = r.json()
        assert (body.get("request_id"), body.get("status"), body.get("step_index")) == ("r-1", "pending", 0), f"a fresh request reads as {body}"
        assert body.get("steps") == [_step(0, "u-mgr", "pending"), _step(1, "u-dir", "pending")], f"a fresh request lists the steps {body.get('steps')}"
        chain.advance("r-1", 0, "u-mgr", "approved")
        body = (await c.get("/v1/requests/r-1", headers=ACME)).json()
        assert body.get("step_index") == 1 and body.get("steps") == [_step(0, "u-mgr", "approved", "u-mgr"), _step(1, "u-dir", "pending")], f"after the manager's approval the trail reads {body}"
        missing = await c.get("/v1/requests/r-404", headers=ACME)
    assert missing.status_code == 404, f"a request that does not exist answered {missing.status_code}, expected 404"


async def check_tenant_404(ctx):
    async with _read(ctx) as c:
        anonymous = await c.get("/v1/requests/r-1")
        foreign = await c.get("/v1/requests/r-1", headers={"X-Tenant-Id": "t-globex"})
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert foreign.status_code == 404, f"tenant t-globex reading t-acme's request answered {foreign.status_code}: {foreign.text}. Another tenant's request is 404"
    assert "u-mgr" not in foreign.text, f"the 404 for another tenant leaks the trail: {foreign.text}"


async def check_pinned_chain(ctx):
    async with _read(ctx) as c:
        policy.define_chain("spend", 4, ["u-mgr", "u-cfo", "u-ceo"])
        body = (await c.get("/v1/requests/r-1", headers=ACME)).json()
    assert body.get("chain_version") == 3, f"after a policy edit the read reports chain_version {body.get('chain_version')}, expected the pinned 3"
    approvers = [s.get("approver") for s in body.get("steps", [])]
    assert approvers == ["u-mgr", "u-dir"], f"after a policy edit the trail lists {approvers}: the request was pinned to u-mgr, u-dir"


async def check_one_snapshot(ctx):
    async with _read(ctx) as c:
        # The manager approves while the read is in flight, right after its first command on the state.
        rival = ctx.redis_after("approval:r-1:state", lambda: chain.advance("r-1", 0, "u-mgr", "approved"))
        body = (await c.get("/v1/requests/r-1", headers=ACME)).json()
        assert rival.fired, "the read never touched approval:r-1:state"
        if rival.error is not None:
            raise rival.error
        approved = sum(1 for s in body.get("steps", []) if s.get("state") == "approved")
        assert approved == body.get("step_index"), f"the read mixed two moments: step_index {body.get('step_index')} with {approved} approved step(s) in {body.get('steps')}. Read the state in one command"
        after = (await c.get("/v1/requests/r-1", headers=ACME)).json()
    assert after.get("step_index") == 1 and after.get("steps", [{}])[0].get("state") == "approved", f"after the approval the trail reads {after}"


async def check_no_store(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/requests/r-1", headers=ACME)
    cache = r.headers.get("cache-control", "")
    assert "no-store" in cache and "public" not in cache, f"the trail is served with Cache-Control {cache!r}: a shared cache would hand one tenant's trail, stale, to the next caller. Send private, no-store"
`,
    typescript: `const ACME = {'X-Tenant-Id': 't-acme'};

async function read(ctx) {
  const policy = ctx.load('/support/approvals/policy.ts');
  const chain = ctx.load('/support/approvals/chain.ts');
  await policy.defineChain('spend', 3, ['u-mgr', 'u-dir']);
  await ctx.load('/support/approvals/store.ts').put(
    {request_id: 'r-1', tenant: 't-acme', requester: 'u-req', chain_id: 'spend', chain_version: 3, approvers: ['u-mgr', 'u-dir'], why: 'new laptop', amount_cents: 420000},
    'k-1',
  );
  await chain.startChain('r-1', ['u-mgr', 'u-dir']);
  return {c: ctx.client(ctx.load('read').app), policy, chain};
}

const step = (i: number, approver: string, state: string, actor = '') => ({step: i, approver, state, actor});

export async function check_route(ctx) {
  const {c, chain} = await read(ctx);
  const r = await c.get('/v1/requests/r-1', {headers: ACME});
  assert.equal(r.status, 200, \`GET /v1/requests/r-1 answered \${r.status}: \${r.text}\`);
  let body = r.json();
  assert(body.request_id === 'r-1' && body.status === 'pending' && body.step_index === 0, \`a fresh request reads as \${r.text}\`);
  assert.deepEqual(body.steps, [step(0, 'u-mgr', 'pending'), step(1, 'u-dir', 'pending')], \`a fresh request lists the steps \${JSON.stringify(body.steps)}\`);
  await chain.advance('r-1', 0, 'u-mgr', 'approved');
  body = (await c.get('/v1/requests/r-1', {headers: ACME})).json();
  assert.equal(body.step_index, 1, \`after the manager's approval the trail reads \${JSON.stringify(body)}\`);
  assert.deepEqual(body.steps, [step(0, 'u-mgr', 'approved', 'u-mgr'), step(1, 'u-dir', 'pending')], \`after the manager's approval the trail reads \${JSON.stringify(body)}\`);
  const missing = await c.get('/v1/requests/r-404', {headers: ACME});
  assert.equal(missing.status, 404, \`a request that does not exist answered \${missing.status}, expected 404\`);
}

export async function check_tenant_404(ctx) {
  const {c} = await read(ctx);
  const anonymous = await c.get('/v1/requests/r-1');
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const foreign = await c.get('/v1/requests/r-1', {headers: {'X-Tenant-Id': 't-globex'}});
  assert.equal(foreign.status, 404, \`tenant t-globex reading t-acme's request answered \${foreign.status}: \${foreign.text}. Another tenant's request is 404\`);
  assert(!foreign.text.includes('u-mgr'), \`the 404 for another tenant leaks the trail: \${foreign.text}\`);
}

export async function check_pinned_chain(ctx) {
  const {c, policy} = await read(ctx);
  await policy.defineChain('spend', 4, ['u-mgr', 'u-cfo', 'u-ceo']);
  const body = (await c.get('/v1/requests/r-1', {headers: ACME})).json();
  assert.equal(body.chain_version, 3, \`after a policy edit the read reports chain_version \${body.chain_version}, expected the pinned 3\`);
  const approvers = (body.steps ?? []).map(s => s.approver);
  assert.deepEqual(approvers, ['u-mgr', 'u-dir'], \`after a policy edit the trail lists \${JSON.stringify(approvers)}: the request was pinned to u-mgr, u-dir\`);
}

export async function check_one_snapshot(ctx) {
  const {c, chain} = await read(ctx);
  // The manager approves while the read is in flight, right after its first command on the state.
  const rival = ctx.redisAfter('approval:r-1:state', () => chain.advance('r-1', 0, 'u-mgr', 'approved'));
  const body = (await c.get('/v1/requests/r-1', {headers: ACME})).json();
  assert(rival.fired, 'the read never touched approval:r-1:state');
  if (rival.error !== undefined) throw rival.error;
  await rival.result;
  const approved = (body.steps ?? []).filter(s => s.state === 'approved').length;
  assert.equal(approved, body.step_index, \`the read mixed two moments: step_index \${body.step_index} with \${approved} approved step(s) in \${JSON.stringify(body.steps)}. Read the state in one command\`);
  const after = (await c.get('/v1/requests/r-1', {headers: ACME})).json();
  assert(after.step_index === 1 && after.steps?.[0]?.state === 'approved', \`after the approval the trail reads \${JSON.stringify(after)}\`);
}

export async function check_no_store(ctx) {
  const {c} = await read(ctx);
  const r = await c.get('/v1/requests/r-1', {headers: ACME});
  const cache = String(r.headers['cache-control'] ?? '');
  assert(cache.includes('no-store') && !cache.includes('public'), \`the trail is served with Cache-Control \${JSON.stringify(cache)}: a shared cache would hand one tenant's trail, stale, to the next caller. Send private, no-store\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"approvals/chain"
	"approvals/policy"
	"approvals/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func readServe(ctx *harness.Ctx) *harness.HTTP {
	ctx.NoError(policy.DefineChain(readBg, "spend", 3, []string{"u-mgr", "u-dir"}), "defining the spend chain")
	record := &store.Request{RequestID: "r-1", Tenant: "t-acme", Requester: "u-req", ChainID: "spend", ChainVersion: 3, Approvers: []string{"u-mgr", "u-dir"}, Why: "new laptop", AmountCents: 420000}
	ctx.NoError(store.Put(readBg, record, "k-1"), "store.Put(r-1)")
	ctx.NoError(chain.StartChain(readBg, "r-1", record.Approvers), "chain.StartChain(r-1)")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(ctx *harness.Ctx, c *harness.HTTP) requestView {
	r := c.Get("/v1/requests/r-1", "X-Tenant-Id", "t-acme")
	ctx.Equal(r.Status, 200, "GET /v1/requests/r-1 (%s)", r.Text())
	var view requestView
	r.Decode(&view)
	return view
}

func readAdvance(ctx *harness.Ctx) chain.Outcome {
	o, err := chain.Advance(readBg, "r-1", 0, "u-mgr", "approved")
	ctx.NoError(err, "chain.Advance(r-1, 0, u-mgr)")
	return o
}

func CheckRoute(ctx *harness.Ctx) {
	c := readServe(ctx)
	view := readGet(ctx, c)
	ctx.Assert(view.RequestID == "r-1" && view.Status == "pending" && view.StepIndex == 0, "a fresh request reads as %+v", view)
	ctx.Equal(view.Steps, []stepView{{0, "u-mgr", "pending", ""}, {1, "u-dir", "pending", ""}}, "a fresh request's steps")
	readAdvance(ctx)
	view = readGet(ctx, c)
	ctx.Equal(view.StepIndex, 1, "after the manager's approval, step_index")
	ctx.Equal(view.Steps, []stepView{{0, "u-mgr", "approved", "u-mgr"}, {1, "u-dir", "pending", ""}}, "after the manager's approval, the steps")
	ctx.Equal(c.Get("/v1/requests/r-404", "X-Tenant-Id", "t-acme").Status, 404, "a request that does not exist")
}

func CheckTenant404(ctx *harness.Ctx) {
	c := readServe(ctx)
	ctx.Equal(c.Get("/v1/requests/r-1").Status, 401, "a read without X-Tenant-Id")
	foreign := c.Get("/v1/requests/r-1", "X-Tenant-Id", "t-globex")
	ctx.Equal(foreign.Status, 404, "tenant t-globex reading t-acme's request (%s): another tenant's request is 404", foreign.Text())
	ctx.Assert(!strings.Contains(foreign.Text(), "u-mgr"), "the 404 for another tenant leaks the trail: %s", foreign.Text())
}

func CheckPinnedChain(ctx *harness.Ctx) {
	c := readServe(ctx)
	ctx.NoError(policy.DefineChain(readBg, "spend", 4, []string{"u-mgr", "u-cfo", "u-ceo"}), "redefining the spend chain")
	view := readGet(ctx, c)
	ctx.Equal(view.ChainVersion, 3, "after a policy edit the read must report the pinned chain_version")
	var approvers []string
	for _, s := range view.Steps {
		approvers = append(approvers, s.Approver)
	}
	ctx.Equal(approvers, []string{"u-mgr", "u-dir"}, "after a policy edit the trail must list the pinned approvers")
}

func CheckOneSnapshot(ctx *harness.Ctx) {
	c := readServe(ctx)
	// The manager approves while the read is in flight, right after its first command on the state.
	rival := ctx.Redis.After("approval:r-1:state", func() any { return readAdvance(ctx) })
	view := readGet(ctx, c)
	ctx.Assert(rival.Fired, "the read never touched approval:r-1:state")
	approved := 0
	for _, s := range view.Steps {
		if s.State == "approved" {
			approved++
		}
	}
	ctx.Assert(approved == view.StepIndex, "the read mixed two moments: step_index %d with %d approved step(s) in %+v. Read the state in one command", view.StepIndex, approved, view.Steps)
	after := readGet(ctx, c)
	ctx.Assert(after.StepIndex == 1 && len(after.Steps) > 0 && after.Steps[0].State == "approved", "after the approval the trail reads %+v", after)
}

func CheckNoStore(ctx *harness.Ctx) {
	c := readServe(ctx)
	r := c.Get("/v1/requests/r-1", "X-Tenant-Id", "t-acme")
	cache := r.Header.Get("Cache-Control")
	ctx.Assert(strings.Contains(cache, "no-store") && !strings.Contains(cache, "public"), "the trail is served with Cache-Control %q: a shared cache would hand one tenant's trail, stale, to the next caller. Send private, no-store", cache)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "approvals/chain.h"
#include "approvals/policy.h"
#include "approvals/store.h"

namespace {

harness::HTTP readServe(harness::Ctx& ctx) {
  policy::defineChain("spend", 3, {"u-mgr", "u-dir"});
  store::put(store::Request{"r-1", "t-acme", "u-req", "spend", 3, {"u-mgr", "u-dir"}, "new laptop", 420000}, "k-1");
  chain::startChain("r-1", {"u-mgr", "u-dir"});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json readGet(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Get("/v1/requests/r-1", "X-Tenant-Id", "t-acme");
  ctx.Equal(r.Status, 200, "GET /v1/requests/r-1 (%s)", r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

nlohmann::json stepOf(long i, const std::string& approver, const std::string& state, const std::string& actor) {
  return {{"step", i}, {"approver", approver}, {"state", state}, {"actor", actor}};
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readServe(ctx);
  auto body = readGet(ctx, c);
  ctx.Assert(body.value("request_id", "") == "r-1" && body.value("status", "") == "pending" && body.value("step_index", -1L) == 0, "a fresh request reads as %s", body.dump());
  ctx.Equal(body["steps"], nlohmann::json{stepOf(0, "u-mgr", "pending", ""), stepOf(1, "u-dir", "pending", "")}, "a fresh request's steps");
  chain::advance("r-1", 0, "u-mgr", "approved");
  body = readGet(ctx, c);
  ctx.Equal(body.value("step_index", -1L), 1, "after the manager's approval, step_index");
  ctx.Equal(body["steps"], nlohmann::json{stepOf(0, "u-mgr", "approved", "u-mgr"), stepOf(1, "u-dir", "pending", "")}, "after the manager's approval, the steps");
  ctx.Equal(c.Get("/v1/requests/r-404", "X-Tenant-Id", "t-acme").Status, 404, "a request that does not exist");
}

void CheckTenant404(harness::Ctx& ctx) {
  auto c = readServe(ctx);
  ctx.Equal(c.Get("/v1/requests/r-1").Status, 401, "a read without X-Tenant-Id");
  const auto foreign = c.Get("/v1/requests/r-1", "X-Tenant-Id", "t-globex");
  ctx.Equal(foreign.Status, 404, "tenant t-globex reading t-acme's request (%s): another tenant's request is 404", foreign.Text());
  ctx.Assert(foreign.Text().find("u-mgr") == std::string::npos, "the 404 for another tenant leaks the trail: %s", foreign.Text());
}

void CheckPinnedChain(harness::Ctx& ctx) {
  auto c = readServe(ctx);
  policy::defineChain("spend", 4, {"u-mgr", "u-cfo", "u-ceo"});
  const auto body = readGet(ctx, c);
  ctx.Equal(body.value("chain_version", -1L), 3, "after a policy edit the read must report the pinned chain_version");
  std::vector<std::string> approvers;
  for (const auto& s : body["steps"]) approvers.push_back(s.value("approver", ""));
  ctx.Equal(approvers, std::vector<std::string>{"u-mgr", "u-dir"}, "after a policy edit the trail must list the pinned approvers");
}

void CheckOneSnapshot(harness::Ctx& ctx) {
  auto c = readServe(ctx);
  // The manager approves while the read is in flight, right after its first command on the state.
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After("approval:r-1:state", [fired] {
    *fired = true;
    chain::advance("r-1", 0, "u-mgr", "approved");
  });
  const auto body = readGet(ctx, c);
  ctx.Assert(*fired, "the read never touched approval:r-1:state");
  long approved = 0;
  for (const auto& s : body["steps"]) approved += s.value("state", "") == "approved" ? 1 : 0;
  ctx.Assert(approved == body.value("step_index", -1L), "the read mixed two moments: step_index %d with %d approved step(s) in %s. Read the state in one command", body.value("step_index", -1L), approved, body["steps"].dump());
  const auto after = readGet(ctx, c);
  ctx.Assert(after.value("step_index", -1L) == 1 && after["steps"][0].value("state", "") == "approved", "after the approval the trail reads %s", after.dump());
}

void CheckNoStore(harness::Ctx& ctx) {
  auto c = readServe(ctx);
  const auto r = c.Get("/v1/requests/r-1", "X-Tenant-Id", "t-acme");
  const std::string cache = r.HeaderValue("Cache-Control");
  ctx.Assert(cache.find("no-store") != std::string::npos && cache.find("public") == std::string::npos,
             "the trail is served with Cache-Control %q: a shared cache would hand one tenant's trail, stale, to the next caller. Send private, no-store", cache);
}
`,
  },
  debrief: `A trail is evidence, so each fix is about whose evidence and from when. The tenant check answers 404 because a 403 would confirm the id exists to someone who should not know it. The steps come from the stored request because the chain was pinned at submit time; reading today's policy rewrites history the moment someone edits it. One \`HGETALL\` is the cheapest consistent read Redis offers for a single hash: a decision lands before it or after it, never in the middle. \`no-store\` keeps a per-tenant, fast-changing document out of every shared cache. Production systems add who read the trail and when, since access to approval records is itself audited, and export closed trails to write-once storage.`,
};
