import type {Step} from '@/lib/types';

export const shadowEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/shadow/configs: a shadow that is observe-only',
  concept: 'http',
  file: 'api',
  focus: ['client', 'shadow', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the config route,
parses the body and stores a config. It compiles, it serves the demo, and it hides the flaw that
makes a shadow dangerous — the candidate path can act. Review it like the service owner, fix it, and
prove the fix with the checks below.

Implement \`POST /v1/shadow/configs\` with body
\`{"candidate_version": "candidate-2026-04", "share": 5, "metrics": ["latency", "cost"]}\`. A shadow
config names a candidate version, the percentage of live traffic it observes, and the metrics the
comparison will track.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing).
- \`candidate_version\` is a non-empty string (**400** otherwise).
- \`share\` is an integer from **1** to **20** percent inclusive; anything outside that range is
  **400** — a shadow must never be the majority of traffic.
- \`metrics\` is a non-empty subset of \`latency\`, \`cost\` and \`quality\`; an unknown metric is
  **400**.
- The candidate path is **observe-only**. Everything the shadow writes goes into its own analytics
  namespace \`shadow:analytics\`; the production object store and the production idempotency store are
  never written by this route.
- A caller that presents a **production** idempotency key (one prefixed \`prod:\`) is **409**: the
  shadow may not consume a key production still needs.
- Return the stored config with its \`config_id\`, \`status\` and namespace; log ids and the share,
  never the request body.

**Failure mode the checks target.** The draft shares the production request object with the
candidate and lets the candidate write to the same idempotency store, so one shadow response can
consume the very key production needs for the real request. It also accepts any share and any metric
set, and never checks the tenant, so a shadow can be pushed to 100 percent of traffic with metrics
nothing downstream understands.`,
  sequence: {
    participants: ['Client', 'Shadow Service', 'config store'],
    messages: [
      {from: 'Client', to: 'Shadow Service', label: 'POST /v1/shadow/configs · X-Tenant-Id', kind: 'sync'},
      {from: 'Shadow Service', to: 'Shadow Service', label: 'validate tenant · share · metrics', kind: 'sync'},
      {from: 'Shadow Service', to: 'config store', label: 'reject prod: idempotency key (409)', kind: 'sync'},
      {from: 'Shadow Service', to: 'config store', label: 'shadow_write shadow:analytics:{id}:status', kind: 'sync'},
      {from: 'config store', to: 'Shadow Service', label: 'config stored · observe_only', kind: 'reply'},
      {from: 'Shadow Service', to: 'Client', label: '201 {config_id, status, namespace}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/shadow/configs',
      detail: 'Register the config route on `POST /v1/shadow/configs`.',
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
      title: 'Caps the traffic share at 1..20 percent',
      detail:
        'The share is validated as an integer between 1 and 20 inclusive; anything outside is **400**. The draft stores whatever percentage the caller sends, so a shadow can become 100 percent of live traffic.',
      match: {
        python: {all: [/MIN_SHARE\s*=\s*1/, /MAX_SHARE\s*=\s*20/, /status_code\s*=\s*400/]},
        typescript: {all: [/MIN_SHARE\s*=\s*1/, /MAX_SHARE\s*=\s*20/, /code\(\s*400\s*\)/]},
        go: {all: [/minShare\s*=\s*1/, /maxShare\s*=\s*20/, /StatusBadRequest/]},
        scala: {all: [/MinShare\s*=\s*1/, /MaxShare\s*=\s*20/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMinShare\s*=\s*1/, /kMaxShare\s*=\s*20/, /\b400\b/]},
      },
    },
    {
      id: 'tenant',
      title: 'Requires the tenant and a candidate version',
      detail:
        'A missing `X-Tenant-Id` is **401** and an empty `candidate_version` is **400**. The draft reads the tenant header but never rejects its absence, and it stores an empty candidate version without complaint.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/, /candidate_version/]},
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/, /candidate_version/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/, /CandidateVersion/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/, /candidate_version/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/, /candidate_version/]},
      },
    },
    {
      id: 'isolate',
      title: 'Writes only into the shadow analytics namespace',
      detail:
        'The shadow writes into its own `shadow:analytics` namespace and rejects a production idempotency key (prefix `prod:`) with **409**. The draft writes the candidate result into the same idempotency store production uses, so a shadow response consumes the key production needs.',
      match: {
        python: {all: [/SHADOW_NS/, /PRODUCTION_KEY_PREFIX/, /status_code\s*=\s*409/]},
        typescript: {all: [/SHADOW_NS/, /PRODUCTION_KEY_PREFIX/, /code\(\s*409\s*\)/]},
        go: {all: [/shadowNS/, /productionKeyPrefix/, /StatusConflict/]},
        scala: {all: [/ShadowNs/, /ProductionKeyPrefix/, /StatusCodes\.Conflict/]},
        cpp: {all: [/kShadowNs/, /kProductionKeyPrefix/, /\b409\b/]},
      },
    },
    {
      id: 'metrics',
      title: 'Validates the metric set against an allow-list',
      detail:
        '`metrics` must be a non-empty subset of the allowed set, and an unknown metric is **400**. The draft stores any metric names, so the comparison later divides by metrics nothing produces.',
      match: {
        python: {all: [/ALLOWED_METRICS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_METRICS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedMetrics/, /StatusBadRequest/]},
        scala: {all: [/AllowedMetrics/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedMetrics/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("shadow")


class ShadowConfig(BaseModel):
    candidate_version: str
    share: int
    metrics: list[str]


class ShadowConfigStore:
    def put(self, tenant: str, config: dict) -> None:
        """Persist the config under its tenant."""
        raise NotImplementedError


store = ShadowConfigStore()


@app.post("/v1/shadow/configs")
def create_shadow_config(
    body: ShadowConfig,
    tenant: str = Header(alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    # TODO: the draft shares the production request object with the candidate and writes the shadow
    # answer into the production idempotency store, accepts any share and any metric, and never
    # checks that the tenant is present. Review all four.
    config = {
        "config_id": str(uuid.uuid4()),
        "candidate_version": body.candidate_version,
        "share": body.share,
        "metrics": body.metrics,
    }
    store.put(tenant, config)
    if idem_key is not None:
        store.put(f"{tenant}:{idem_key}", config)
    logger.info("shadow.config tenant=%s config=%s", tenant, config["config_id"])
    return JSONResponse(config, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("shadow")

MIN_SHARE = 1
MAX_SHARE = 20
MAX_METRICS = 8
ALLOWED_METRICS = {"latency", "cost", "quality"}
SHADOW_NS = "shadow:analytics"
PRODUCTION_KEY_PREFIX = "prod:"


class ShadowConfig(BaseModel):
    candidate_version: str
    share: int
    metrics: list[str]


class ShadowConfigStore:
    def shadow_write(self, config_id: str, key: str, value: str) -> None:
        """Write into the shadow analytics namespace shadow:{config_id}:* and nowhere else."""
        raise NotImplementedError

    def put(self, tenant: str, config: dict) -> None:
        """Persist the observe-only config under its tenant."""
        raise NotImplementedError


store = ShadowConfigStore()


@app.post("/v1/shadow/configs")
def create_shadow_config(
    body: ShadowConfig,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    # The shadow path may never consume a key production still needs.
    if idem_key.startswith(PRODUCTION_KEY_PREFIX):
        raise HTTPException(status_code=409, detail="production idempotency key cannot be shadowed")
    if body.candidate_version.strip() == "":
        raise HTTPException(status_code=400, detail="candidate_version is required")
    if not MIN_SHARE <= body.share <= MAX_SHARE:
        raise HTTPException(status_code=400, detail="share must be 1..20 percent")
    if not 1 <= len(body.metrics) <= MAX_METRICS:
        raise HTTPException(status_code=400, detail="metrics must be 1..8 entries")
    if not set(body.metrics) <= ALLOWED_METRICS:
        raise HTTPException(status_code=400, detail="unknown metric")

    config_id = str(uuid.uuid4())
    config = {
        "config_id": config_id,
        "candidate_version": body.candidate_version,
        "share": body.share,
        "metrics": sorted(body.metrics),
        "status": "observe_only",
        "namespace": SHADOW_NS,
    }
    # Side effects stay inside the shadow namespace; the production store is never written.
    store.shadow_write(config_id, f"{SHADOW_NS}:{config_id}:status", "observe_only")
    store.put(tenant, config)
    logger.info("shadow.config tenant=%s config=%s share=%d", tenant, config_id, body.share)
    return JSONResponse(config, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/shadow/configs: a model-generated draft that lets the shadow act. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {configStore} from './store';

export const app = Fastify();

interface ShadowConfigBody {
  candidate_version?: string;
  share?: number;
  metrics?: string[];
}

app.post('/v1/shadow/configs', async (request, reply) => {
  // TODO: the draft shares the production request object with the candidate and writes the shadow
  // answer into the production idempotency store, accepts any share and any metric, and never
  // checks that the tenant is present. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const idemKey = request.headers['idempotency-key'] as string | undefined;
  const body = request.body as ShadowConfigBody;
  const config = {
    config_id: randomUUID(),
    candidate_version: body.candidate_version ?? '',
    share: body.share ?? 5,
    metrics: body.metrics ?? [],
  };
  await configStore.put(tenant, config);
  if (idemKey !== undefined) await configStore.put(\`\${tenant}:\${idemKey}\`, config);
  request.log.info({tenant, config_id: config.config_id}, 'shadow.config');
  return reply.code(200).send(config);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/shadow/configs: configs that can only observe, never act. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {configStore} from './store';

export const app = Fastify();

const MIN_SHARE = 1;
const MAX_SHARE = 20;
const MAX_METRICS = 8;
const ALLOWED_METRICS: Record<string, true> = {latency: true, cost: true, quality: true};
const SHADOW_NS = 'shadow:analytics';
const PRODUCTION_KEY_PREFIX = 'prod:';

interface ShadowConfigBody {
  candidate_version?: string;
  share?: number;
  metrics?: string[];
}

app.post('/v1/shadow/configs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});
  // The shadow path may never consume a key production still needs.
  if (idemKey.startsWith(PRODUCTION_KEY_PREFIX))
    return reply.code(409).send({error: 'production idempotency key cannot be shadowed'});

  const body = request.body as ShadowConfigBody | null;
  const candidateVersion = body?.candidate_version;
  if (typeof candidateVersion !== 'string' || candidateVersion.trim() === '')
    return reply.code(400).send({error: 'candidate_version is required'});
  const share = body?.share;
  if (typeof share !== 'number' || !Number.isInteger(share) || share < MIN_SHARE || share > MAX_SHARE)
    return reply.code(400).send({error: 'share must be 1..20 percent'});
  const metrics = body?.metrics ?? [];
  if (metrics.length < 1 || metrics.length > MAX_METRICS)
    return reply.code(400).send({error: 'metrics must be 1..8 entries'});
  if (metrics.some(metric => ALLOWED_METRICS[metric] !== true))
    return reply.code(400).send({error: 'unknown metric'});

  const configId = randomUUID();
  const config = {
    config_id: configId,
    candidate_version: candidateVersion,
    share,
    metrics: [...metrics].sort(),
    status: 'observe_only',
    namespace: SHADOW_NS,
  };
  // Side effects stay inside the shadow namespace; the production store is never written.
  await configStore.shadowWrite(configId, \`\${SHADOW_NS}:\${configId}:status\`, 'observe_only');
  await configStore.put(tenant, config);
  request.log.info({tenant, config_id: configId, share}, 'shadow.config');
  return reply.code(201).send(config);
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

	"github.com/google/uuid"
)

type ShadowConfigRequest struct {
	CandidateVersion string   \`json:"candidate_version"\`
	Share            int      \`json:"share"\`
	Metrics          []string \`json:"metrics"\`
}

type ConfigStore struct{}

func (s *ConfigStore) Put(tenant string, config map[string]any) {}

var configStore = &ConfigStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createShadowConfig(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft shares the production request object with the candidate and writes the shadow
	// answer into the production idempotency store, accepts any share and any metric, and never
	// checks that the tenant is present. Review all four.
	tenant := r.Header.Get("X-Tenant-Id")
	idemKey := r.Header.Get("Idempotency-Key")
	var body ShadowConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	config := map[string]any{
		"config_id":         uuid.NewString(),
		"candidate_version": body.CandidateVersion,
		"share":             body.Share,
		"metrics":           body.Metrics,
	}
	configStore.Put(tenant, config)
	configStore.Put(tenant+":"+idemKey, config)
	log.Printf("shadow.config tenant=%s config=%s", tenant, config["config_id"])
	writeJSON(rw, http.StatusOK, config)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/shadow/configs", createShadowConfig)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const (
	minShare            = 1
	maxShare            = 20
	maxMetrics          = 8
	shadowNS            = "shadow:analytics"
	productionKeyPrefix = "prod:"
)

var allowedMetrics = map[string]bool{"latency": true, "cost": true, "quality": true}

type ShadowConfigRequest struct {
	CandidateVersion string   \`json:"candidate_version"\`
	Share            int      \`json:"share"\`
	Metrics          []string \`json:"metrics"\`
}

type ConfigStore struct{}

func (s *ConfigStore) ShadowWrite(configID, key, value string) {}

func (s *ConfigStore) Put(tenant string, config map[string]any) {}

var configStore = &ConfigStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createShadowConfig(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	// The shadow path may never consume a key production still needs.
	if strings.HasPrefix(idemKey, productionKeyPrefix) {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "production idempotency key cannot be shadowed"})
		return
	}
	var body ShadowConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.CandidateVersion) == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "candidate_version is required"})
		return
	}
	if body.Share < minShare || body.Share > maxShare {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "share must be 1..20 percent"})
		return
	}
	if len(body.Metrics) < 1 || len(body.Metrics) > maxMetrics {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "metrics must be 1..8 entries"})
		return
	}
	for _, metric := range body.Metrics {
		if !allowedMetrics[metric] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown metric"})
			return
		}
	}
	configID := uuid.NewString()
	config := map[string]any{
		"config_id":         configID,
		"candidate_version": body.CandidateVersion,
		"share":             body.Share,
		"metrics":           body.Metrics,
		"status":            "observe_only",
		"namespace":         shadowNS,
	}
	// Side effects stay inside the shadow namespace; the production store is never written.
	configStore.ShadowWrite(configID, shadowNS+":"+configID+":status", "observe_only")
	configStore.Put(tenant, config)
	log.Printf("shadow.config tenant=%s config=%s share=%d", tenant, configID, body.Share)
	writeJSON(rw, http.StatusCreated, config)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/shadow/configs", createShadowConfig)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ShadowConfig(candidate_version: String, share: Int, metrics: List[String])

object ShadowApi {
  implicit val system: ActorSystem = ActorSystem("shadow-eval")
  implicit val configFormat: RootJsonFormat[ShadowConfig] = jsonFormat3(ShadowConfig)

  val configStore = ConfigStore.open()

  val route: Route =
    path("v1" / "shadow" / "configs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ShadowConfig]) { body =>
            // TODO: the draft shares the production request object with the candidate and writes
            // the shadow answer into the production idempotency store, accepts any share and any
            // metric, and never checks that the tenant is present. Review all four.
            val configId = UUID.randomUUID().toString
            configStore.put(tenant, configId)
            configStore.put(s"$tenant:shadow", configId)
            system.log.info(s"shadow.config tenant=$tenant config=$configId")
            complete(StatusCodes.OK, s"""{"config_id":"$configId","share":\${body.share}}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ShadowConfig(candidate_version: String, share: Int, metrics: List[String])

object ShadowApi {
  implicit val system: ActorSystem = ActorSystem("shadow-eval")
  implicit val configFormat: RootJsonFormat[ShadowConfig] = jsonFormat3(ShadowConfig)

  val MinShare = 1
  val MaxShare = 20
  val MaxMetrics = 8
  val ShadowNs = "shadow:analytics"
  val ProductionKeyPrefix = "prod:"
  val AllowedMetrics = Set("latency", "cost", "quality")

  val configStore = ConfigStore.open()

  val route: Route =
    path("v1" / "shadow" / "configs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[ShadowConfig]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (idemOpt.exists(_.startsWith(ProductionKeyPrefix))) {
                complete(StatusCodes.Conflict, """{"error":"production idempotency key cannot be shadowed"}""")
              } else if (body.candidate_version.trim.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"candidate_version is required"}""")
              } else if (body.share < MinShare || body.share > MaxShare) {
                complete(StatusCodes.BadRequest, """{"error":"share must be 1..20 percent"}""")
              } else if (body.metrics.isEmpty || body.metrics.size > MaxMetrics) {
                complete(StatusCodes.BadRequest, """{"error":"metrics must be 1..8 entries"}""")
              } else if (!body.metrics.forall(AllowedMetrics.contains)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown metric"}""")
              } else {
                val tenant = tenantOpt.get
                val configId = UUID.randomUUID().toString
                // Side effects stay inside the shadow namespace; the production store is never written.
                configStore.shadowWrite(configId, s"$ShadowNs:$configId:status", "observe_only")
                configStore.put(tenant, configId)
                system.log.info(s"shadow.config tenant=$tenant config=$configId share=\${body.share}")
                complete(StatusCodes.Created, s"""{"config_id":"$configId","namespace":"$ShadowNs"}""")
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct ConfigStore {
  void put(const std::string& tenant, const json& config);
};

ConfigStore configStore;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/shadow/configs", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the draft shares the production request object with the candidate and writes the shadow
    // answer into the production idempotency store, accepts any share and any metric, and never
    // checks that the tenant is present. Review all four.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto idemKey = req.get_header_value("Idempotency-Key");
    json body = json::parse(req.body, nullptr, false);
    const json config = {
        {"config_id", uuidString()},
        {"candidate_version", body.value("candidate_version", std::string())},
        {"share", body.value("share", 5)},
        {"metrics", body.value("metrics", json::array())},
    };
    configStore.put(tenant, config);
    configStore.put(tenant + ":" + idemKey, config);
    std::cerr << "shadow.config tenant=" << tenant << "\\n";
    res.status = 200;
    res.set_content(config.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <iostream>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kMinShare = 1;
constexpr int kMaxShare = 20;
constexpr int kMaxMetrics = 8;
const std::string kShadowNs = "shadow:analytics";
const std::string kProductionKeyPrefix = "prod:";
const std::set<std::string> kAllowedMetrics = {"latency", "cost", "quality"};

struct ConfigStore {
  void shadowWrite(const std::string& configId, const std::string& key, const std::string& value);
  void put(const std::string& tenant, const json& config);
};

ConfigStore configStore;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/shadow/configs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    // The shadow path may never consume a key production still needs.
    if (idemKey.rfind(kProductionKeyPrefix, 0) == 0) {
      res.status = 409;
      res.set_content(R"({"error":"production idempotency key cannot be shadowed"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto candidateVersion = body.value("candidate_version", std::string());
    if (candidateVersion.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"candidate_version is required"})", "application/json");
      return;
    }
    const int share = body.value("share", 0);
    if (share < kMinShare || share > kMaxShare) {
      res.status = 400;
      res.set_content(R"({"error":"share must be 1..20 percent"})", "application/json");
      return;
    }
    const auto metrics = body.value("metrics", json::array());
    if (!metrics.is_array() || metrics.empty() || metrics.size() > static_cast<std::size_t>(kMaxMetrics)) {
      res.status = 400;
      res.set_content(R"({"error":"metrics must be 1..8 entries"})", "application/json");
      return;
    }
    for (const auto& metric : metrics) {
      if (!metric.is_string() || kAllowedMetrics.count(metric.get<std::string>()) == 0) {
        res.status = 400;
        res.set_content(R"({"error":"unknown metric"})", "application/json");
        return;
      }
    }
    const auto configId = uuidString();
    const json config = {
        {"config_id", configId},
        {"candidate_version", candidateVersion},
        {"share", share},
        {"metrics", metrics},
        {"status", "observe_only"},
        {"namespace", kShadowNs},
    };
    // Side effects stay inside the shadow namespace; the production store is never written.
    configStore.shadowWrite(configId, kShadowNs + ":" + configId + ":status", "observe_only");
    configStore.put(tenant, config);
    std::cerr << "shadow.config tenant=" << tenant << " config=" << configId << " share=" << share << "\\n";
    res.status = 201;
    res.set_content(config.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate in cost order and return before any write: tenant (401), Idempotency-Key (400), production-key prefix (409), candidate version, share range, metric set. Every guard runs before the shadow is created, so a malformed config never becomes state.',
    'The namespace is the safety property: the shadow may write only under `shadow:analytics:{config_id}:`. A production idempotency key (`prod:` prefix) is not a cache hint — answering it would let the shadow consume the key the real request needs, so it is a 409.',
    'Keep the config response honest: `config_id`, `status: "observe_only"` and the namespace, plus the share in the log. Never echo the request body back — the body can carry caller-controlled fields you did not validate.',
  ],
  debrief: `The interviewer is testing whether you can review a generated endpoint for the property that defines a shadow: it must be incapable of acting. The draft looks fine because it answers 200 and stores a config, but it shares the production request object with the candidate and writes into the production idempotency store, so a shadow response can consume the key the real request needs — the shadow has reached production through the back door. The other three defects are cheaper to see and just as real: an uncapped share can turn a shadow into all of traffic, an unvalidated metric set breaks the comparison downstream, and a missing tenant check makes the config anonymous. Real shadow runners add a server-side share rollout, a signed config version, and a per-config kill switch that is checked before the candidate is even called.`,
};
