import type {Step} from '@/lib/types';

export const routeEndpointStep: Step = {
  id: 'route-endpoint',
  title: 'POST /v1/route: validated, idempotent routing',
  concept: 'http',
  file: 'router_api',
  focus: ['client', 'router', 'db', 'provider'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a routing decision. It compiles, it serves the demo, and it hides four
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/route\` with body \`{"prompt": "…", "max_tokens": 256, "policy": "auto"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`prompt\` is a non-empty string of at most **256 KiB** (\`1 << 18\` bytes) of UTF-8; a larger
  prompt is **413**.
- \`max_tokens\` is an integer from **1** to **4096** (**400** otherwise) and defaults to 256.
- \`policy\` is one of \`auto\`, \`small\`, \`large\` (**400** otherwise). The model is chosen
  server-side: \`auto\` routes to the small model when the estimate is at most **2048** tokens and
  to the large model above that; \`small\` and \`large\` pin the choice. Never echo a caller-supplied
  string as the model name — the caller picks a policy, the router picks the model.
- The estimate is \`len(prompt) // 4 + max_tokens\`.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same
  \`(tenant, key)\` returns the stored decision instead of routing again.
- Log the decision with tenant, model and estimate — never the prompt text.

**Failure mode the checks target.** Trusting \`policy\` as a model name lets a caller name any model
the provider serves; the missing caps turn one huge prompt into an unbounded bill; an un-keyed route
endpoint double-routes every client retry. The prompt in the log line is the quiet one: it ships
tenant content into the log pipeline on every request, where it outlives the request, the tenant and
the retention policy.`,
  sequence: {
    participants: ['Client', 'Model Router', 'policy store'],
    messages: [
      {from: 'Client', to: 'Model Router', label: 'POST /v1/route · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Model Router', to: 'Model Router', label: 'validate tenant · caps · policy', kind: 'sync'},
      {from: 'Model Router', to: 'policy store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'policy store', to: 'Model Router', label: 'stored decision / none', kind: 'reply'},
      {from: 'Model Router', to: 'policy store', label: 'put(tenant, idem_key, decision)', kind: 'async'},
      {from: 'Model Router', to: 'Client', label: '200 {model, policy, estimated_tokens}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/route',
      detail: 'Register the routing route on `POST /v1/route`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/route["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/route['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/route"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"route"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/route"/]},
      },
    },
    {
      id: 'validate',
      title: 'Enforces the 256 KiB prompt cap and the max_tokens range',
      detail:
        'A prompt over `1 << 18` bytes is **413**; `max_tokens` outside 1..4096 is **400**. The draft skips both caps, so one request can blow the provider budget and a non-integer `max_tokens` reaches the call.',
      match: {
        python: {all: [/MAX_PROMPT_BYTES/, /MAX_OUTPUT_TOKENS/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_PROMPT_BYTES/, /MAX_OUTPUT_TOKENS/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxPromptBytes/, /maxOutputTokens/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {
          all: [/MaxPromptBytes/, /MaxOutputTokens/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kMaxPromptBytes/, /kMaxOutputTokens/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'tenant-policy',
      title: 'Authenticates the tenant and picks the model server-side',
      detail:
        'The tenant is required — **401** when absent — and `policy` is checked against `auto`/`small`/`large`; the model is derived from the policy and the estimate (auto → small at ≤ 2048 tokens, large above). The draft returns the caller’s `policy` string as the model name.',
      match: {
        python: {all: [/ALLOWED_POLICIES/, /status_code\s*=\s*401/, /SMALL_MODEL/, /AUTO_SMALL_MAX_TOKENS/]},
        typescript: {all: [/ALLOWED_POLICIES/, /code\(\s*401\s*\)/, /SMALL_MODEL/, /AUTO_SMALL_MAX_TOKENS/]},
        go: {all: [/allowedPolicies/, /StatusUnauthorized/, /smallModel/, /autoSmallMaxTokens/]},
        scala: {all: [/AllowedPolicies/, /StatusCodes\.Unauthorized/, /SmallModel/, /AutoSmallMaxTokens/]},
        cpp: {all: [/kAllowedPolicies/, /\b401\b/, /kSmallModel/, /kAutoSmallMaxTokens/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the decision is stored under `(tenant, key)`; a replay returns the stored decision instead of routing twice. The draft ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'no-prompt-log',
      title: 'Logs the decision, never the prompt',
      detail:
        'The routing decision is logged with tenant, model and estimate; the prompt text never reaches a log line. The draft logs `prompt` on every request.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*prompt/]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*prompt/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*[Pp]rompt/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^)]*prompt/]},
        cpp: {all: [/(std::)?(cerr|clog)\s*<</], none: [/(std::)?(cerr|clog)[^;]*prompt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("router")


class RouteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256
    policy: str = "auto"


class RouteStore:
    def get(self, tenant: str, idem_key: str):
        """The decision stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, decision: dict) -> None:
        """Store the decision under (tenant, idem_key)."""
        raise NotImplementedError


store = RouteStore()


@app.post("/v1/route")
def route(body: RouteRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft treats the caller's policy as the model name, checks neither the prompt
    # size nor max_tokens, ignores Idempotency-Key, and logs the prompt. Review all four.
    estimate = len(body.prompt) // 4 + body.max_tokens
    logger.info("route tenant=%s prompt=%r", tenant, body.prompt)
    return JSONResponse({"model": body.policy, "estimated_tokens": estimate}, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("router")

SMALL_MODEL = "small-model"
LARGE_MODEL = "large-model"
MAX_PROMPT_BYTES = 1 << 18
MAX_OUTPUT_TOKENS = 4096
AUTO_SMALL_MAX_TOKENS = 2048
ALLOWED_POLICIES = {"auto", "small", "large"}


class RouteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256
    policy: str = "auto"


class RouteStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The decision stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, decision: dict) -> None:
        """Store the decision under (tenant, idem_key)."""
        raise NotImplementedError


store = RouteStore()


def pick_model(policy: str, estimate: int) -> str:
    if policy == "small":
        return SMALL_MODEL
    if policy == "large":
        return LARGE_MODEL
    return SMALL_MODEL if estimate <= AUTO_SMALL_MAX_TOKENS else LARGE_MODEL


@app.post("/v1/route")
def route(
    body: RouteRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.prompt == "":
        raise HTTPException(status_code=400, detail="prompt must be a non-empty string")
    if len(body.prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise HTTPException(status_code=413, detail="prompt exceeds 256 KiB")
    if not 1 <= body.max_tokens <= MAX_OUTPUT_TOKENS:
        raise HTTPException(status_code=400, detail="max_tokens must be 1..4096")
    if body.policy not in ALLOWED_POLICIES:
        raise HTTPException(status_code=400, detail="unknown policy")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    estimate = len(body.prompt) // 4 + body.max_tokens
    decision = {
        "request_id": str(uuid.uuid4()),
        "model": pick_model(body.policy, estimate),
        "policy": body.policy,
        "estimated_tokens": estimate,
    }
    store.put(tenant, idem_key, decision)
    logger.info("route tenant=%s model=%s policy=%s est=%d", tenant, decision["model"], body.policy, estimate)
    return JSONResponse(decision, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/route: a model-generated draft that echoes the caller's policy. */
import Fastify from 'fastify';

export const app = Fastify();

interface RouteBody {
  prompt: string;
  max_tokens?: number;
  policy?: string;
}

app.post('/v1/route', async (request, reply) => {
  // TODO: this draft returns the caller's policy as the model name, checks neither the prompt
  // size nor max_tokens, ignores Idempotency-Key, and logs the prompt. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RouteBody;
  const estimate = Math.floor(body.prompt.length / 4) + (body.max_tokens ?? 256);
  request.log.info({tenant, prompt: body.prompt}, 'routed');
  return reply.code(200).send({model: body.policy ?? 'auto', estimated_tokens: estimate});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/route: authenticated, capped, and idempotent routing decisions. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const SMALL_MODEL = 'small-model';
const LARGE_MODEL = 'large-model';
const MAX_PROMPT_BYTES = 1 << 18;
const MAX_OUTPUT_TOKENS = 4096;
const AUTO_SMALL_MAX_TOKENS = 2048;
const ALLOWED_POLICIES: Record<string, true> = {auto: true, small: true, large: true};

interface RouteBody {
  prompt: string;
  max_tokens?: number;
  policy?: string;
}

interface Decision {
  request_id: string;
  model: string;
  policy: string;
  estimated_tokens: number;
}

function pickModel(policy: string, estimate: number): string {
  if (policy === 'small') return SMALL_MODEL;
  if (policy === 'large') return LARGE_MODEL;
  return estimate <= AUTO_SMALL_MAX_TOKENS ? SMALL_MODEL : LARGE_MODEL;
}

app.post('/v1/route', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<RouteBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.prompt !== 'string' || body.prompt === '')
    return reply.code(400).send({error: 'prompt must be a non-empty string'});
  if (Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES)
    return reply.code(413).send({error: 'prompt exceeds 256 KiB'});
  const maxTokens = body.max_tokens ?? 256;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS)
    return reply.code(400).send({error: 'max_tokens must be 1..4096'});
  const policy = body.policy ?? 'auto';
  if (ALLOWED_POLICIES[policy] !== true) return reply.code(400).send({error: 'unknown policy'});

  const stored: Decision | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const estimate = Math.floor(Buffer.byteLength(body.prompt, 'utf8') / 4) + maxTokens;
  const decision: Decision = {
    request_id: randomUUID(),
    model: pickModel(policy, estimate),
    policy,
    estimated_tokens: estimate,
  };
  await store.put(tenant, idemKey, decision);
  request.log.info({tenant, model: decision.model, policy, estimated_tokens: estimate}, 'routed');
  return reply.code(200).send(decision);
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

type RouteRequest struct {
	Prompt    string \`json:"prompt"\`
	MaxTokens int    \`json:"max_tokens"\`
	Policy    string \`json:"policy"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func route(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft returns the caller's policy as the model name, checks neither the prompt
	// size nor max_tokens, ignores Idempotency-Key, and logs the prompt. Review all four.
	estimate := len([]byte(body.Prompt))/4 + body.MaxTokens
	log.Printf("route tenant=%s prompt=%q", tenant, body.Prompt)
	writeJSON(rw, http.StatusOK, map[string]any{"model": body.Policy, "estimated_tokens": estimate})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/route", route)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	smallModel         = "small-model"
	largeModel         = "large-model"
	maxPromptBytes     = 1 << 18
	maxOutputTokens    = 4096
	autoSmallMaxTokens = 2048
)

var allowedPolicies = map[string]bool{"auto": true, "small": true, "large": true}

type RouteRequest struct {
	Prompt    string \`json:"prompt"\`
	MaxTokens int    \`json:"max_tokens"\`
	Policy    string \`json:"policy"\`
}

type RouteStore struct{}

func (s *RouteStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RouteStore) Put(ctx context.Context, tenant, idemKey string, decision map[string]any) error {
	return nil
}

var store = &RouteStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func pickModel(policy string, estimate int) string {
	switch policy {
	case "small":
		return smallModel
	case "large":
		return largeModel
	}
	if estimate <= autoSmallMaxTokens {
		return smallModel
	}
	return largeModel
}

func route(rw http.ResponseWriter, r *http.Request) {
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
	var body RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Prompt == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "prompt must be a non-empty string"})
		return
	}
	if len([]byte(body.Prompt)) > maxPromptBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "prompt exceeds 256 KiB"})
		return
	}
	maxTokens := body.MaxTokens
	if maxTokens == 0 {
		maxTokens = 256
	}
	if maxTokens < 1 || maxTokens > maxOutputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_tokens must be 1..4096"})
		return
	}
	policy := body.Policy
	if policy == "" {
		policy = "auto"
	}
	if !allowedPolicies[policy] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown policy"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	estimate := len([]byte(body.Prompt))/4 + maxTokens
	decision := map[string]any{
		"request_id":       uuid.NewString(),
		"model":            pickModel(policy, estimate),
		"policy":           policy,
		"estimated_tokens": estimate,
	}
	if err := store.Put(r.Context(), tenant, idemKey, decision); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("route tenant=%s model=%s policy=%s est=%d", tenant, decision["model"], policy, estimate)
	writeJSON(rw, http.StatusOK, decision)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/route", route)
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RouteRequest(prompt: String, max_tokens: Int, policy: String)
final case class Decision(request_id: String, model: String, policy: String, estimated_tokens: Int)

object RouteApi {
  implicit val system: ActorSystem = ActorSystem("model-router")
  implicit val routeFormat: RootJsonFormat[RouteRequest] = jsonFormat3(RouteRequest)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat4(Decision)

  val store = RouteStore.open()

  val route: Route =
    path("v1" / "route") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RouteRequest]) { body =>
            // TODO: this draft returns the caller's policy as the model name, checks neither the
            // prompt size nor max_tokens, ignores Idempotency-Key, and logs the prompt.
            val estimate = body.prompt.getBytes("UTF-8").length / 4 + body.max_tokens
            system.log.info(s"route tenant=$tenant prompt=\${body.prompt}")
            complete(StatusCodes.OK, s"""{"model":"\${body.policy}","estimated_tokens":$estimate}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RouteRequest(prompt: String, max_tokens: Int, policy: String)
final case class Decision(request_id: String, model: String, policy: String, estimated_tokens: Int)

object RouteApi {
  implicit val system: ActorSystem = ActorSystem("model-router")
  implicit val routeFormat: RootJsonFormat[RouteRequest] = jsonFormat3(RouteRequest)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat4(Decision)

  val SmallModel = "small-model"
  val LargeModel = "large-model"
  val MaxPromptBytes = 1 << 18
  val MaxOutputTokens = 4096
  val AutoSmallMaxTokens = 2048
  val AllowedPolicies = Set("auto", "small", "large")

  val store = RouteStore.open()

  def pickModel(policy: String, estimate: Int): String = policy match {
    case "small" => SmallModel
    case "large" => LargeModel
    case _ => if (estimate <= AutoSmallMaxTokens) SmallModel else LargeModel
  }

  val route: Route =
    path("v1" / "route") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RouteRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.prompt.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"prompt must be a non-empty string"}""")
              } else if (body.prompt.getBytes(StandardCharsets.UTF_8).length > MaxPromptBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"prompt exceeds 256 KiB"}""")
              } else if (body.max_tokens < 1 || body.max_tokens > MaxOutputTokens) {
                complete(StatusCodes.BadRequest, """{"error":"max_tokens must be 1..4096"}""")
              } else if (!AllowedPolicies.contains(body.policy)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown policy"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val estimate = body.prompt.getBytes(StandardCharsets.UTF_8).length / 4 + body.max_tokens
                    val decision =
                      Decision(UUID.randomUUID().toString, pickModel(body.policy, estimate), body.policy, estimate)
                    store.put(tenant, idemKey, decision)
                    system.log.info(s"route tenant=$tenant model=\${decision.model} policy=\${body.policy} est=$estimate")
                    complete(StatusCodes.OK, decision)
                }
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

struct RouteStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& decision);
};

RouteStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/route", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft returns the caller's policy as the model name, checks neither the prompt
    // size nor max_tokens, ignores Idempotency-Key, and logs the prompt. Review all four.
    const auto prompt = body.value("prompt", std::string());
    const int maxTokens = body.value("max_tokens", 256);
    const int estimate = static_cast<int>(prompt.size()) / 4 + maxTokens;
    std::cerr << "route tenant=" << tenant << " prompt=" << prompt << "\\n";
    res.status = 200;
    res.set_content(
        json{{"model", body.value("policy", std::string("auto"))}, {"estimated_tokens", estimate}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::string kSmallModel = "small-model";
const std::string kLargeModel = "large-model";
constexpr std::size_t kMaxPromptBytes = 1 << 18;
constexpr int kMaxOutputTokens = 4096;
constexpr int kAutoSmallMaxTokens = 2048;
const std::set<std::string> kAllowedPolicies = {"auto", "small", "large"};

struct RouteStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& decision);
};

RouteStore store;
std::string uuidString();

std::string pickModel(const std::string& policy, int estimate) {
  if (policy == "small") return kSmallModel;
  if (policy == "large") return kLargeModel;
  return estimate <= kAutoSmallMaxTokens ? kSmallModel : kLargeModel;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/route", [](const httplib::Request& req, httplib::Response& res) {
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
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("prompt") || !body["prompt"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"prompt must be a non-empty string"})", "application/json");
      return;
    }
    const auto prompt = body["prompt"].get<std::string>();
    if (prompt.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"prompt must be a non-empty string"})", "application/json");
      return;
    }
    if (prompt.size() > kMaxPromptBytes) {
      res.status = 413;
      res.set_content(R"({"error":"prompt exceeds 256 KiB"})", "application/json");
      return;
    }
    const int maxTokens = body.value("max_tokens", 256);
    if (maxTokens < 1 || maxTokens > kMaxOutputTokens) {
      res.status = 400;
      res.set_content(R"({"error":"max_tokens must be 1..4096"})", "application/json");
      return;
    }
    const auto policy = body.value("policy", std::string("auto"));
    if (kAllowedPolicies.count(policy) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown policy"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const int estimate = static_cast<int>(prompt.size()) / 4 + maxTokens;
    const json decision = {
        {"request_id", uuidString()},
        {"model", pickModel(policy, estimate)},
        {"policy", policy},
        {"estimated_tokens", estimate},
    };
    store.put(tenant, idemKey, decision);
    std::cerr << "route tenant=" << tenant << " model=" << decision["model"] << " est=" << estimate << "\\n";
    res.status = 200;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, prompt shape, byte length, max_tokens range, policy whitelist. Every one of them returns before any provider work, so the endpoint can never spend money on a malformed request.',
    'The idempotency lookup is keyed by `(tenant, key)` and happens before routing; a hit returns the stored decision with 200. Storing the decision — not just the request hash — is what lets a replay answer without re-estimating or re-routing.',
    'The log line is a contract: tenant, model, policy, estimate. The prompt belongs to the caller; if you need it for debugging, hash it or keep only its length. `logger.info(..., body.prompt)` leaks tenant content into every log sink.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends well-formed requests from one tenant and never retries. Four separate defects are being checked: authentication (the tenant is never optional), input caps (cheap rejections before expensive work), server-side policy resolution (the caller names a policy, never a model), and idempotency keyed by tenant so a retry cannot double-route. The log line is the fourth one that candidates miss in interviews: the prompt has to be assumed sensitive, so it may never be logged verbatim. Real routers add per-tenant policy overrides from config, request-scoped trace ids, and a hashed prompt fingerprint for dedupe and debugging.`,
};
