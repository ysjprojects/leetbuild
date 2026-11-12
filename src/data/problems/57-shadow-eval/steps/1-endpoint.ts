import type {Step} from '@/lib/types';

export const shadowEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/shadow/configs: a shadow that is observe-only',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'shadow', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/shadow/configs\` on \`shadow.store\`: it reads
\`X-Tenant-Id\` and an optional \`Idempotency-Key\`, answers a replayed key from
\`recall(IDEMPOTENCY_NS, …)\`, otherwise stores \`{candidate_version, share, metrics}\` with
\`create_config\`, records the key with \`remember(IDEMPOTENCY_NS, …)\` and answers 201 with the config.
It serves the demo and hides four flaws.

**Failure mode the checks target.** A shadow config that reaches production. A config with no tenant
is stored; a share of 100 sends every request to the candidate; a metric nothing produces is
accepted; and the key lands in the idempotency store production's request path uses, so production
answers its next request with that key from a shadow config.

- A missing or empty \`X-Tenant-Id\` is **401**.
- \`share\` is an integer from \`MIN_SHARE\` = 1 to \`MAX_SHARE\` = 20; outside that is **400**.
- \`metrics\` is a non-empty subset of \`ALLOWED_METRICS\` (latency, cost, quality); anything else is
  **400**.
- Keys are recalled and remembered in \`SHADOW_NS\` (\`shadow:idem:{tenant}:{key}\`): a replay answers
  **200** with the recorded config, and production's records are neither read nor written.`,
  sequence: {
    participants: ['Client', 'Shadow runner', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Shadow runner',
        label: 'POST /v1/shadow/configs · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Shadow runner', to: 'Shadow runner', label: 'tenant → 401 · share 1..20 · metrics → 400', kind: 'sync'},
      {from: 'Shadow runner', to: 'Redis', label: 'GET shadow:idem:{tenant}:{key}', kind: 'sync'},
      {from: 'Redis', to: 'Shadow runner', label: 'config id (replay → 200) / nil', kind: 'reply'},
      {from: 'Shadow runner', to: 'Redis', label: 'create_config · SET shadow:idem:{tenant}:{key}', kind: 'sync'},
      {
        from: 'Shadow runner',
        to: 'Client',
        label: '201 {config_id, tenant, candidate_version, share, metrics}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/shadow/configs',
      detail: 'Register `POST /v1/shadow/configs`; a valid request answers 201 with the stored config.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/shadow\/configs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/shadow\/configs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/shadow\/configs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shadow"\s*\/\s*"configs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/shadow\/configs"/]},
      },
    },
    {
      id: 'share',
      title: 'Caps the traffic share at 1 to 20 percent',
      detail:
        'A share below `MIN_SHARE` (1) or above `MAX_SHARE` (20) is **400** and stores nothing. The starter stores any share, so one config can send every request to the candidate.',
      match: {
        python: {
          all: [
            /MIN_SHARE\s*=\s*1\b/,
            /MAX_SHARE\s*=\s*20\b/,
            /MIN_SHARE[\s\S]*MIN_SHARE/,
            /MAX_SHARE[\s\S]*MAX_SHARE/,
          ],
        },
        typescript: {
          all: [
            /MIN_SHARE\s*=\s*1\b/,
            /MAX_SHARE\s*=\s*20\b/,
            /MIN_SHARE[\s\S]*MIN_SHARE/,
            /MAX_SHARE[\s\S]*MAX_SHARE/,
          ],
        },
        go: {all: [/minShare\s*=\s*1\b/, /maxShare\s*=\s*20\b/, /minShare[\s\S]*minShare/, /maxShare[\s\S]*maxShare/]},
        scala: {
          all: [/MinShare\s*=\s*1\b/, /MaxShare\s*=\s*20\b/, /MinShare[\s\S]*MinShare/, /MaxShare[\s\S]*MaxShare/],
        },
        cpp: {
          all: [
            /kMinShare\s*=\s*1\b/,
            /kMaxShare\s*=\s*20\b/,
            /kMinShare[\s\S]*kMinShare/,
            /kMaxShare[\s\S]*kMaxShare/,
          ],
        },
      },
    },
    {
      id: 'tenant',
      title: 'Rejects a request without a tenant',
      detail:
        'A missing or empty `X-Tenant-Id` is **401** and stores nothing. The starter stores the config under an empty tenant, where no tenant can read its report.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'isolate',
      title: "Keeps idempotency records in the shadow's own namespace",
      detail:
        "The key is recalled and remembered in `SHADOW_NS` (`shadow:idem:{tenant}:{key}`), and production's `idem:{tenant}:{key}` records are neither read nor written. The starter uses `IDEMPOTENCY_NS`, so a shadow config answers production's next request with that key.",
      match: {
        python: {
          all: [/(recall|remember)\(\s*store\.SHADOW_NS/],
          none: [/(recall|remember)\(\s*store\.IDEMPOTENCY_NS/],
        },
        typescript: {all: [/(recall|remember)\(\s*SHADOW_NS/], none: [/(recall|remember)\(\s*IDEMPOTENCY_NS/]},
        go: {
          all: [/(Recall|Remember)\([^\n]*store\.ShadowNS/],
          none: [/(Recall|Remember)\([^\n]*store\.IdempotencyNS/],
        },
        scala: {all: [/(recall|remember)\(\s*Store\.ShadowNs/], none: [/(recall|remember)\(\s*Store\.IdempotencyNs/]},
        cpp: {all: [/(recall|remember)\(\s*store::kShadowNs/], none: [/(recall|remember)\(\s*store::kIdempotencyNs/]},
      },
    },
    {
      id: 'metrics',
      title: 'Validates the metric set against an allow-list',
      detail:
        '`metrics` must be a non-empty subset of `ALLOWED_METRICS` (latency, cost, quality); anything else is **400**. The starter stores any names, so the report later compares metrics nothing produces.',
      match: {
        python: {all: [/ALLOWED_METRICS\b[^\n]*=/, /ALLOWED_METRICS[\s\S]*ALLOWED_METRICS/, /\b400\b/]},
        typescript: {all: [/ALLOWED_METRICS\b[^\n]*=/, /ALLOWED_METRICS[\s\S]*ALLOWED_METRICS/, /\b400\b/]},
        go: {all: [/allowedMetrics\b[^\n]*=/, /allowedMetrics[\s\S]*allowedMetrics/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/AllowedMetrics\b[^\n]*=/, /AllowedMetrics[\s\S]*AllowedMetrics/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedMetrics\b[^\n]*=/, /kAllowedMetrics[\s\S]*kAllowedMetrics/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from shadow import store  # create_config, get_config, recall, remember, IDEMPOTENCY_NS, SHADOW_NS

app = FastAPI()


class ShadowConfig(BaseModel):
    candidate_version: str
    share: int
    metrics: list[str]


@app.post("/v1/shadow/configs")
def create_shadow_config(body: ShadowConfig, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    key = request.headers.get("idempotency-key", "")
    if key:
        replayed = store.recall(store.IDEMPOTENCY_NS, tenant, key)
        if replayed is not None:
            return JSONResponse(store.get_config(replayed), status_code=200)
    config = store.create_config(tenant, body.candidate_version, body.share, body.metrics)
    if key:
        store.remember(store.IDEMPOTENCY_NS, tenant, key, config["config_id"])
    return JSONResponse(config, status_code=201)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from shadow import store  # create_config, get_config, recall, remember, IDEMPOTENCY_NS, SHADOW_NS

app = FastAPI()

MIN_SHARE = 1
MAX_SHARE = 20
ALLOWED_METRICS = {"latency", "cost", "quality"}


class ShadowConfig(BaseModel):
    candidate_version: str
    share: int
    metrics: list[str]


@app.post("/v1/shadow/configs")
def create_shadow_config(body: ShadowConfig, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    if not MIN_SHARE <= body.share <= MAX_SHARE:
        return JSONResponse({"error": f"share must be {MIN_SHARE} to {MAX_SHARE} percent"}, status_code=400)
    unknown = sorted(set(body.metrics) - ALLOWED_METRICS)
    if not body.metrics or unknown:
        return JSONResponse({"error": "metrics must be a non-empty subset of latency, cost, quality", "unknown": unknown}, status_code=400)
    key = request.headers.get("idempotency-key", "")
    # The shadow's own namespace: production's idempotency records are neither read nor written here.
    if key:
        replayed = store.recall(store.SHADOW_NS, tenant, key)
        if replayed is not None:
            return JSONResponse(store.get_config(replayed), status_code=200)
    config = store.create_config(tenant, body.candidate_version, body.share, body.metrics)
    if key:
        store.remember(store.SHADOW_NS, tenant, key, config["config_id"])
    return JSONResponse(config, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {IDEMPOTENCY_NS, SHADOW_NS, createConfig, getConfig, recall, remember} from 'shadow/store';

export const app = Fastify();

interface ShadowConfigBody {
  candidate_version: string;
  share: number;
  metrics: string[];
}

app.post('/v1/shadow/configs', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const key = (request.headers['idempotency-key'] as string | undefined) ?? '';
  const body = request.body as ShadowConfigBody;
  if (key !== '') {
    const replayed = await recall(IDEMPOTENCY_NS, tenant, key);
    if (replayed !== null) return reply.code(200).send(await getConfig(replayed));
  }
  const config = await createConfig(tenant, body.candidate_version, body.share, body.metrics);
  if (key !== '') await remember(IDEMPOTENCY_NS, tenant, key, config.config_id);
  return reply.code(201).send(config);
});
`,
      solution: `import Fastify from 'fastify';

import {SHADOW_NS, createConfig, getConfig, recall, remember} from 'shadow/store';

export const app = Fastify();

const MIN_SHARE = 1;
const MAX_SHARE = 20;
const ALLOWED_METRICS: Record<string, true> = {latency: true, cost: true, quality: true};

interface ShadowConfigBody {
  candidate_version: string;
  share: number;
  metrics: string[];
}

app.post('/v1/shadow/configs', async (request, reply) => {
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as ShadowConfigBody;
  if (!Number.isInteger(body.share) || body.share < MIN_SHARE || body.share > MAX_SHARE) {
    return reply.code(400).send({error: \`share must be \${MIN_SHARE} to \${MAX_SHARE} percent\`});
  }
  const metrics = Array.isArray(body.metrics) ? body.metrics : [];
  const unknown = metrics.filter(m => ALLOWED_METRICS[m] !== true);
  if (metrics.length === 0 || unknown.length > 0) {
    return reply.code(400).send({error: 'metrics must be a non-empty subset of latency, cost, quality', unknown});
  }
  const key = (request.headers['idempotency-key'] as string | undefined) ?? '';
  // The shadow's own namespace: production's idempotency records are neither read nor written here.
  if (key !== '') {
    const replayed = await recall(SHADOW_NS, tenant, key);
    if (replayed !== null) return reply.code(200).send(await getConfig(replayed));
  }
  const config = await createConfig(tenant, body.candidate_version, body.share, metrics);
  if (key !== '') await remember(SHADOW_NS, tenant, key, config.config_id);
  return reply.code(201).send(config);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"shadow/store" // store.CreateConfig, GetConfig, Recall, Remember, IdempotencyNS, ShadowNS
)

type configRequest struct {
	CandidateVersion string   \`json:"candidate_version"\`
	Share            int      \`json:"share"\`
	Metrics          []string \`json:"metrics"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createShadowConfig(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	key := r.Header.Get("Idempotency-Key")
	var body configRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if key != "" {
		if replayed := store.Recall(r.Context(), store.IdempotencyNS, tenant, key); replayed != "" {
			writeJSON(rw, http.StatusOK, store.GetConfig(r.Context(), replayed))
			return
		}
	}
	config := store.CreateConfig(r.Context(), tenant, body.CandidateVersion, body.Share, body.Metrics)
	if key != "" {
		store.Remember(r.Context(), store.IdempotencyNS, tenant, key, config.ConfigID)
	}
	writeJSON(rw, http.StatusCreated, config)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/shadow/configs", createShadowConfig)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"shadow/store" // store.CreateConfig, GetConfig, Recall, Remember, IdempotencyNS, ShadowNS
)

const (
	minShare = 1
	maxShare = 20
)

var allowedMetrics = map[string]bool{"latency": true, "cost": true, "quality": true}

type configRequest struct {
	CandidateVersion string   \`json:"candidate_version"\`
	Share            int      \`json:"share"\`
	Metrics          []string \`json:"metrics"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createShadowConfig(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body configRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.Share < minShare || body.Share > maxShare {
		http.Error(rw, fmt.Sprintf("share must be %d to %d percent", minShare, maxShare), http.StatusBadRequest)
		return
	}
	if len(body.Metrics) == 0 {
		http.Error(rw, "metrics must name at least one of latency, cost, quality", http.StatusBadRequest)
		return
	}
	for _, m := range body.Metrics {
		if !allowedMetrics[m] {
			http.Error(rw, "unknown metric "+m, http.StatusBadRequest)
			return
		}
	}
	key := r.Header.Get("Idempotency-Key")
	// The shadow's own namespace: production's idempotency records are neither read nor written here.
	if key != "" {
		if replayed := store.Recall(r.Context(), store.ShadowNS, tenant, key); replayed != "" {
			writeJSON(rw, http.StatusOK, store.GetConfig(r.Context(), replayed))
			return
		}
	}
	config := store.CreateConfig(r.Context(), tenant, body.CandidateVersion, body.Share, body.Metrics)
	if key != "" {
		store.Remember(r.Context(), store.ShadowNS, tenant, key, config.ConfigID)
	}
	writeJSON(rw, http.StatusCreated, config)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/shadow/configs", createShadowConfig)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import shadow.Store // Store.createConfig, getConfig, recall, remember, IdempotencyNs, ShadowNs

object ShadowApi {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "shadow" / "configs") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val tenant = tenantHeader.getOrElse("")
            val key = keyHeader.getOrElse("")
            val body = raw.parseJson.asJsObject.fields
            val candidateVersion = body.get("candidate_version").collect { case JsString(s) => s }.getOrElse("")
            val share = body.get("share").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
            val metrics = body.get("metrics").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
            val replayed = if (key.isEmpty) None else Store.recall(Store.IdempotencyNs, tenant, key)
            replayed match {
              case Some(configId) => complete(json(StatusCodes.OK, Store.getConfig(configId).map(_.toJson).getOrElse(JsNull)))
              case None =>
                val config = Store.createConfig(tenant, candidateVersion, share, metrics)
                if (key.nonEmpty) Store.remember(Store.IdempotencyNs, tenant, key, config.configId)
                complete(json(StatusCodes.Created, config.toJson))
            }
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

import shadow.Store // Store.createConfig, getConfig, recall, remember, IdempotencyNs, ShadowNs

object ShadowApi {
  val MinShare = 1
  val MaxShare = 20
  val AllowedMetrics: Set[String] = Set("latency", "cost", "quality")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route = path("v1" / "shadow" / "configs") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
          entity(as[String]) { raw =>
            val tenant = tenantHeader.getOrElse("")
            val key = keyHeader.getOrElse("")
            val body = raw.parseJson.asJsObject.fields
            val candidateVersion = body.get("candidate_version").collect { case JsString(s) => s }.getOrElse("")
            val share = body.get("share").collect { case JsNumber(n) if n.isValidInt => n.toInt }
            val metrics = body.get("metrics").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
            if (tenant.isEmpty) complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            else if (!share.exists(s => s >= MinShare && s <= MaxShare)) complete(error(StatusCodes.BadRequest, s"share must be $MinShare to $MaxShare percent"))
            else if (metrics.isEmpty || !metrics.forall(AllowedMetrics.contains)) complete(error(StatusCodes.BadRequest, "metrics must be a non-empty subset of latency, cost, quality"))
            else {
              // The shadow's own namespace: production's idempotency records are neither read nor written here.
              val replayed = if (key.isEmpty) None else Store.recall(Store.ShadowNs, tenant, key)
              replayed match {
                case Some(configId) => complete(json(StatusCodes.OK, Store.getConfig(configId).map(_.toJson).getOrElse(JsNull)))
                case None =>
                  val config = Store.createConfig(tenant, candidateVersion, share.get, metrics)
                  if (key.nonEmpty) Store.remember(Store.ShadowNs, tenant, key, config.configId)
                  complete(json(StatusCodes.Created, config.toJson))
              }
            }
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

#include <string>
#include <vector>

#include "shadow/store.h"  // store::createConfig, getConfig, recall, remember, kIdempotencyNs, kShadowNs

using json = nlohmann::json;

void create_shadow_config(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string key = req.get_header_value("Idempotency-Key");
  const json body = json::parse(req.body);
  const std::string candidate_version = body.value("candidate_version", "");
  const long share = body.value("share", 0L);
  const std::vector<std::string> metrics = body.value("metrics", std::vector<std::string>{});
  if (!key.empty()) {
    if (const auto replayed = store::recall(store::kIdempotencyNs, tenant, key)) {
      const auto config = store::getConfig(*replayed);
      res.set_content(config ? store::toJson(*config).dump() : "null", "application/json");
      return;
    }
  }
  const store::Config config = store::createConfig(tenant, candidate_version, share, metrics);
  if (!key.empty()) store::remember(store::kIdempotencyNs, tenant, key, config.config_id);
  res.status = 201;
  res.set_content(store::toJson(config).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/shadow/configs", create_shadow_config); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "shadow/store.h"  // store::createConfig, getConfig, recall, remember, kIdempotencyNs, kShadowNs

using json = nlohmann::json;

constexpr long kMinShare = 1;
constexpr long kMaxShare = 20;
const std::set<std::string> kAllowedMetrics = {"latency", "cost", "quality"};

void reject(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void create_shadow_config(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body);
  const std::string candidate_version = body.value("candidate_version", "");
  if (!body.contains("share") || !body["share"].is_number_integer() || body["share"].get<long>() < kMinShare ||
      body["share"].get<long>() > kMaxShare) {
    return reject(res, 400, "share must be " + std::to_string(kMinShare) + " to " + std::to_string(kMaxShare) + " percent");
  }
  const long share = body["share"].get<long>();
  const std::vector<std::string> metrics = body.value("metrics", std::vector<std::string>{});
  bool known = !metrics.empty();
  for (const auto& m : metrics) known = known && kAllowedMetrics.count(m) > 0;
  if (!known) return reject(res, 400, "metrics must be a non-empty subset of latency, cost, quality");
  const std::string key = req.get_header_value("Idempotency-Key");
  // The shadow's own namespace: production's idempotency records are neither read nor written here.
  if (!key.empty()) {
    if (const auto replayed = store::recall(store::kShadowNs, tenant, key)) {
      const auto config = store::getConfig(*replayed);
      res.set_content(config ? store::toJson(*config).dump() : "null", "application/json");
      return;
    }
  }
  const store::Config config = store::createConfig(tenant, candidate_version, share, metrics);
  if (!key.empty()) store::remember(store::kShadowNs, tenant, key, config.config_id);
  res.status = 201;
  res.set_content(store::toJson(config).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/shadow/configs", create_shadow_config); }
`,
    },
  },
  harness: {
    python: `from shadow import store

BODY = {"candidate_version": "cand-2026-04", "share": 5, "metrics": ["latency", "cost"]}
T1 = {"X-Tenant-Id": "t1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, body=None, headers=None):
    return await c.post("/v1/shadow/configs", json=BODY if body is None else body, headers=T1 if headers is None else headers)


def _stored(ctx):
    return int(ctx.redis.get("shadow:config:seq") or 0)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _create(c)
    assert r.status_code == 201, f"POST /v1/shadow/configs answered {r.status_code}: {r.text}"
    body = r.json()
    config = store.get_config(body.get("config_id", ""))
    assert config is not None, f"the answer {body} names no stored config"
    assert config["tenant"] == "t1" and config["share"] == 5 and config["candidate_version"] == "cand-2026-04", f"the stored config is {config}"
    assert body == config, f"the answer {body} must be the stored config {config}"


async def check_share(ctx):
    async with _api(ctx) as c:
        for share in (0, 21, 100, -5):
            r = await _create(c, {**BODY, "share": share})
            assert r.status_code == 400, f"a share of {share} percent answered {r.status_code}, expected 400: a share above 20 percent puts that much of production's traffic on the candidate"
        for share in (1, 20):
            r = await _create(c, {**BODY, "share": share})
            assert r.status_code == 201, f"a share of {share} percent answered {r.status_code}: {r.text}"
    assert _stored(ctx) == 2, f"{_stored(ctx)} configs were stored, expected only the two with a share from 1 to 20"


async def check_tenant(ctx):
    async with _api(ctx) as c:
        r = await _create(c, headers={})
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _create(c, headers={"X-Tenant-Id": ""})
        assert r.status_code == 401, f"a request with an empty X-Tenant-Id answered {r.status_code}, expected 401"
    assert _stored(ctx) == 0, f"{_stored(ctx)} configs were stored without a tenant"


async def check_isolate(ctx):
    ctx.redis.set("idem:t1:k-2", "order-77")  # production's own record of a request with key k-2
    async with _api(ctx) as c:
        first = await _create(c, headers={**T1, "Idempotency-Key": "k-1"})
        assert first.status_code == 201, f"the first request with key k-1 answered {first.status_code}: {first.text}"
        config_id = first.json()["config_id"]
        assert ctx.redis.exists("idem:t1:k-1") == 0, "the shadow config wrote production's idempotency record idem:t1:k-1: production's next request with that key would be answered with a shadow config"
        assert ctx.redis.get("shadow:idem:t1:k-1") == config_id, f"shadow:idem:t1:k-1 holds {ctx.redis.get('shadow:idem:t1:k-1')!r}, expected {config_id}: the shadow records its keys in its own namespace"
        replay = await _create(c, headers={**T1, "Idempotency-Key": "k-1"})
        assert replay.status_code == 200 and replay.json().get("config_id") == config_id, f"a replay of k-1 answered {replay.status_code} {replay.text}, expected 200 with {config_id}"
        other = await _create(c, headers={**T1, "Idempotency-Key": "k-2"})
        assert other.status_code == 201 and other.json() is not None and other.json().get("config_id") not in (None, config_id), f"key k-2, which production already used, answered {other.status_code} {other.text}: the shadow read production's idempotency store"
    assert ctx.redis.get("idem:t1:k-2") == "order-77", f"production's record idem:t1:k-2 now holds {ctx.redis.get('idem:t1:k-2')!r}"
    assert _stored(ctx) == 2, f"{_stored(ctx)} configs were stored, expected 2 (k-1 once, k-2 once)"


async def check_metrics(ctx):
    async with _api(ctx) as c:
        for metrics in (["latency", "bleu"], [], ["accuracy"]):
            r = await _create(c, {**BODY, "metrics": metrics})
            assert r.status_code == 400, f"metrics {metrics} answered {r.status_code}, expected 400: only latency, cost and quality are measured for a pair"
        r = await _create(c, {**BODY, "metrics": ["quality"]})
        assert r.status_code == 201, f"metrics ['quality'] answered {r.status_code}: {r.text}"
    assert _stored(ctx) == 1, f"{_stored(ctx)} configs were stored, expected only the one with known metrics"
`,
    typescript: `const BODY = {candidate_version: 'cand-2026-04', share: 5, metrics: ['latency', 'cost']};
const T1 = {'X-Tenant-Id': 't1'};

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), store: ctx.load('/support/shadow/store.ts')};
}

const create = (c, body = BODY, headers: Record<string, string> = T1) => c.post('/v1/shadow/configs', {json: body, headers});
const stored = (ctx): number => Number(ctx.redis.get('shadow:config:seq') ?? 0);

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await create(c);
  assert.equal(r.status, 201, \`POST /v1/shadow/configs answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const config = await store.getConfig(body.config_id ?? '');
  assert(config !== null, \`the answer \${r.text} names no stored config\`);
  assert(config.tenant === 't1' && config.share === 5 && config.candidate_version === 'cand-2026-04', \`the stored config is \${JSON.stringify(config)}\`);
  assert.deepStrictEqual(body, config, \`the answer \${r.text} must be the stored config \${JSON.stringify(config)}\`);
}

export async function check_share(ctx) {
  const {c} = api(ctx);
  for (const share of [0, 21, 100, -5]) {
    const r = await create(c, {...BODY, share});
    assert.equal(r.status, 400, \`a share of \${share} percent answered \${r.status}, expected 400: a share above 20 percent puts that much of production's traffic on the candidate\`);
  }
  for (const share of [1, 20]) {
    const r = await create(c, {...BODY, share});
    assert.equal(r.status, 201, \`a share of \${share} percent answered \${r.status}: \${r.text}\`);
  }
  assert.equal(stored(ctx), 2, \`\${stored(ctx)} configs were stored, expected only the two with a share from 1 to 20\`);
}

export async function check_tenant(ctx) {
  const {c} = api(ctx);
  let r = await create(c, BODY, {});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await create(c, BODY, {'X-Tenant-Id': ''});
  assert.equal(r.status, 401, \`a request with an empty X-Tenant-Id answered \${r.status}, expected 401\`);
  assert.equal(stored(ctx), 0, \`\${stored(ctx)} configs were stored without a tenant\`);
}

export async function check_isolate(ctx) {
  const {c} = api(ctx);
  ctx.redis.set('idem:t1:k-2', 'order-77'); // production's own record of a request with key k-2
  const first = await create(c, BODY, {...T1, 'Idempotency-Key': 'k-1'});
  assert.equal(first.status, 201, \`the first request with key k-1 answered \${first.status}: \${first.text}\`);
  const configId = first.json().config_id;
  assert.equal(ctx.redis.exists('idem:t1:k-1'), 0, "the shadow config wrote production's idempotency record idem:t1:k-1: production's next request with that key would be answered with a shadow config");
  assert.equal(ctx.redis.get('shadow:idem:t1:k-1'), configId, \`shadow:idem:t1:k-1 holds \${JSON.stringify(ctx.redis.get('shadow:idem:t1:k-1'))}, expected \${configId}: the shadow records its keys in its own namespace\`);
  const replay = await create(c, BODY, {...T1, 'Idempotency-Key': 'k-1'});
  assert(replay.status === 200 && replay.json()?.config_id === configId, \`a replay of k-1 answered \${replay.status} \${replay.text}, expected 200 with \${configId}\`);
  const other = await create(c, BODY, {...T1, 'Idempotency-Key': 'k-2'});
  const otherId = other.json()?.config_id;
  assert(other.status === 201 && otherId !== undefined && otherId !== configId, \`key k-2, which production already used, answered \${other.status} \${other.text}: the shadow read production's idempotency store\`);
  assert.equal(ctx.redis.get('idem:t1:k-2'), 'order-77', \`production's record idem:t1:k-2 now holds \${JSON.stringify(ctx.redis.get('idem:t1:k-2'))}\`);
  assert.equal(stored(ctx), 2, \`\${stored(ctx)} configs were stored, expected 2 (k-1 once, k-2 once)\`);
}

export async function check_metrics(ctx) {
  const {c} = api(ctx);
  for (const metrics of [['latency', 'bleu'], [], ['accuracy']]) {
    const r = await create(c, {...BODY, metrics});
    assert.equal(r.status, 400, \`metrics \${JSON.stringify(metrics)} answered \${r.status}, expected 400: only latency, cost and quality are measured for a pair\`);
  }
  const r = await create(c, {...BODY, metrics: ['quality']});
  assert.equal(r.status, 201, \`metrics ["quality"] answered \${r.status}: \${r.text}\`);
  assert.equal(stored(ctx), 1, \`\${stored(ctx)} configs were stored, expected only the one with known metrics\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strconv"

	"shadow/store"

	"leetbuild/harness"
)

var apiBody = map[string]any{"candidate_version": "cand-2026-04", "share": 5, "metrics": []string{"latency", "cost"}}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func withField(name string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range apiBody {
		out[k] = v
	}
	out[name] = value
	return out
}

func storedConfigs(ctx *harness.Ctx) int {
	seq, _ := ctx.Redis.Get("shadow:config:seq")
	n, _ := strconv.Atoi(seq)
	return n
}

func configIDOf(r *harness.Response) string {
	var body struct {
		ConfigID string \`json:"config_id"\`
	}
	r.Decode(&body)
	return body.ConfigID
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/shadow/configs", apiBody, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/shadow/configs (%s)", r.Text())
	var body store.Config
	r.Decode(&body)
	config := store.GetConfig(context.Background(), body.ConfigID)
	ctx.Assert(config != nil, "the answer %s names no stored config", r.Text())
	ctx.Assert(config.Tenant == "t1" && config.Share == 5 && config.CandidateVersion == "cand-2026-04", "the stored config is %+v", config)
	ctx.Equal(body, *config, "the answer must be the stored config")
}

func CheckShare(ctx *harness.Ctx) {
	c := api(ctx)
	for _, share := range []int{0, 21, 100, -5} {
		r := c.Post("/v1/shadow/configs", withField("share", share), "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 400, "a share of %d percent (a share above 20 percent puts that much of production's traffic on the candidate); the status", share)
	}
	for _, share := range []int{1, 20} {
		r := c.Post("/v1/shadow/configs", withField("share", share), "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 201, "a share of %d percent (%s)", share, r.Text())
	}
	ctx.Equal(storedConfigs(ctx), 2, "only the two configs with a share from 1 to 20 may be stored; the configs stored")
}

func CheckTenant(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/shadow/configs", apiBody)
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
	r = c.Post("/v1/shadow/configs", apiBody, "X-Tenant-Id", "")
	ctx.Equal(r.Status, 401, "a request with an empty X-Tenant-Id")
	ctx.Equal(storedConfigs(ctx), 0, "no config may be stored without a tenant; the configs stored")
}

func CheckIsolate(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Redis.Set("idem:t1:k-2", "order-77") // production's own record of a request with key k-2
	first := c.Post("/v1/shadow/configs", apiBody, "X-Tenant-Id", "t1", "Idempotency-Key", "k-1")
	ctx.Equal(first.Status, 201, "the first request with key k-1 (%s)", first.Text())
	configID := configIDOf(first)
	ctx.Equal(ctx.Redis.Exists("idem:t1:k-1"), int64(0), "the shadow config wrote production's idempotency record idem:t1:k-1: production's next request with that key would be answered with a shadow config; it exists")
	recorded, _ := ctx.Redis.Get("shadow:idem:t1:k-1")
	ctx.Equal(recorded, configID, "the shadow records its keys in its own namespace; shadow:idem:t1:k-1")
	replay := c.Post("/v1/shadow/configs", apiBody, "X-Tenant-Id", "t1", "Idempotency-Key", "k-1")
	ctx.Assert(replay.Status == 200 && configIDOf(replay) == configID, "a replay of k-1 answered %d %s, expected 200 with %s", replay.Status, replay.Text(), configID)
	other := c.Post("/v1/shadow/configs", apiBody, "X-Tenant-Id", "t1", "Idempotency-Key", "k-2")
	otherID := configIDOf(other)
	ctx.Assert(other.Status == 201 && otherID != "" && otherID != configID, "key k-2, which production already used, answered %d %s: the shadow read production's idempotency store", other.Status, other.Text())
	production, _ := ctx.Redis.Get("idem:t1:k-2")
	ctx.Equal(production, "order-77", "production's record idem:t1:k-2")
	ctx.Equal(storedConfigs(ctx), 2, "k-1 once and k-2 once; the configs stored")
}

func CheckMetrics(ctx *harness.Ctx) {
	c := api(ctx)
	for _, metrics := range [][]string{{"latency", "bleu"}, {}, {"accuracy"}} {
		r := c.Post("/v1/shadow/configs", withField("metrics", metrics), "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 400, "metrics %q (only latency, cost and quality are measured for a pair); the status", metrics)
	}
	r := c.Post("/v1/shadow/configs", withField("metrics", []string{"quality"}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "metrics [quality] (%s)", r.Text())
	ctx.Equal(storedConfigs(ctx), 1, "only the config with known metrics may be stored; the configs stored")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

nlohmann::json apiBody() { return {{"candidate_version", "cand-2026-04"}, {"share", 5}, {"metrics", {"latency", "cost"}}}; }

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json withField(const std::string& name, const nlohmann::json& value) {
  nlohmann::json body = apiBody();
  body[name] = value;
  return body;
}

long storedConfigs(harness::Ctx& ctx) {
  const auto seq = ctx.Redis.Get("shadow:config:seq");
  return seq ? std::stol(*seq) : 0;
}

std::string configIdOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("config_id", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Post("/v1/shadow/configs", apiBody().dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 201, "POST /v1/shadow/configs (%s)", r.Text());
  const auto config = store::getConfig(configIdOf(r));
  ctx.Assert(config.has_value(), "the answer %s names no stored config", r.Text());
  ctx.Assert(config->tenant == "t1" && config->share == 5 && config->candidate_version == "cand-2026-04", "the stored config is %s", store::toJson(*config).dump());
  ctx.Equal(nlohmann::json::parse(r.Text()), store::toJson(*config), "the answer must be the stored config");
}

void CheckShare(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (int share : {0, 21, 100, -5}) {
    const auto r = c.Post("/v1/shadow/configs", withField("share", share).dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
    ctx.Equal(r.Status, 400, "a share of %d percent (a share above 20 percent puts that much of production's traffic on the candidate); the status", share);
  }
  for (int share : {1, 20}) {
    const auto r = c.Post("/v1/shadow/configs", withField("share", share).dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
    ctx.Equal(r.Status, 201, "a share of %d percent (%s)", share, r.Text());
  }
  ctx.Equal(storedConfigs(ctx), 2, "only the two configs with a share from 1 to 20 may be stored; the configs stored");
}

void CheckTenant(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/shadow/configs", apiBody().dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
  r = c.Post("/v1/shadow/configs", apiBody().dump(), "Content-Type", "application/json", "X-Tenant-Id", "");
  ctx.Equal(r.Status, 401, "a request with an empty X-Tenant-Id");
  ctx.Equal(storedConfigs(ctx), 0, "no config may be stored without a tenant; the configs stored");
}

void CheckIsolate(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Redis.Set("idem:t1:k-2", "order-77");  // production's own record of a request with key k-2
  const auto first = c.Post("/v1/shadow/configs", apiBody().dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1", "Idempotency-Key", "k-1");
  ctx.Equal(first.Status, 201, "the first request with key k-1 (%s)", first.Text());
  const std::string config_id = configIdOf(first);
  ctx.Equal(ctx.Redis.Exists("idem:t1:k-1"), 0, "the shadow config wrote production's idempotency record idem:t1:k-1: production's next request with that key would be answered with a shadow config; it exists");
  ctx.Equal(ctx.Redis.Get("shadow:idem:t1:k-1").value_or(""), config_id, "the shadow records its keys in its own namespace; shadow:idem:t1:k-1");
  const auto replay = c.Post("/v1/shadow/configs", apiBody().dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1", "Idempotency-Key", "k-1");
  ctx.Assert(replay.Status == 200 && configIdOf(replay) == config_id, "a replay of k-1 answered %d %s, expected 200 with %s", replay.Status, replay.Text(), config_id);
  const auto other = c.Post("/v1/shadow/configs", apiBody().dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1", "Idempotency-Key", "k-2");
  const std::string other_id = configIdOf(other);
  ctx.Assert(other.Status == 201 && !other_id.empty() && other_id != config_id, "key k-2, which production already used, answered %d %s: the shadow read production's idempotency store", other.Status, other.Text());
  ctx.Equal(ctx.Redis.Get("idem:t1:k-2").value_or(""), "order-77", "production's record idem:t1:k-2");
  ctx.Equal(storedConfigs(ctx), 2, "k-1 once and k-2 once; the configs stored");
}

void CheckMetrics(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const auto& metrics : {nlohmann::json::array({"latency", "bleu"}), nlohmann::json::array(), nlohmann::json::array({"accuracy"})}) {
    const auto r = c.Post("/v1/shadow/configs", withField("metrics", metrics).dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
    ctx.Equal(r.Status, 400, "metrics %s (only latency, cost and quality are measured for a pair); the status", metrics.dump());
  }
  const auto r = c.Post("/v1/shadow/configs", withField("metrics", nlohmann::json::array({"quality"})).dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 201, "metrics [quality] (%s)", r.Text());
  ctx.Equal(storedConfigs(ctx), 1, "only the config with known metrics may be stored; the configs stored");
}
`,
  },
  hints: [
    "Create a config with a share of 100 and no tenant header: it is stored. Then send production a request with the key you used: production answers with the shadow's config.",
    "The handler stores whatever the body says, and `IDEMPOTENCY_NS` is the namespace production's request path reads: a key the shadow remembers there is a key production treats as already answered, and the other way round.",
    '401 on an empty tenant; 400 unless `MIN_SHARE <= share <= MAX_SHARE`; 400 unless metrics is non-empty and inside `ALLOWED_METRICS`; then `recall` and `remember` with `store.SHADOW_NS`.',
  ],
  debrief: `The guards run before anything is stored, so a rejected config leaves no trace, and the share cap is what bounds the extra load: at 20 percent the candidate sees a fifth of production's traffic, not all of it. The namespace is the observe-only boundary. A shadow that shares production's idempotency store can answer production's requests, which is a write into production by another name; its own namespace makes that impossible by construction rather than by care. Platforms enforce the same boundary in credentials as well: a Redis ACL user for the shadow runner limited to the \`shadow:*\` key pattern cannot touch production's records even when the code tries.`,
};
