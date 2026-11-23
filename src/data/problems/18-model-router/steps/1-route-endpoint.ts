import type {Step} from '@/lib/types';

// ---- 1. POST /v1/route -----------------------------------------------------------------------------
export const routeEndpointStep: Step = {
  id: 'route-endpoint',
  title: 'POST /v1/route: the router picks the model',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'router_api',
  focus: ['client', 'router', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/route\` with body
\`{"prompt", "max_tokens": 256, "policy": "auto"}\`. It takes the tenant from
\`Authorization: Bearer <tenant>\` through the provided \`authenticate\`, estimates the cost with the
provided \`estimate_tokens(prompt, max_tokens)\`, maps the policy to a model through \`MODELS\`, logs
the request and answers \`{id, model, policy, estimated_tokens}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A caller who names a model and gets it, a prompt nobody capped,
a client retry that routes twice, and a prompt copied into the logs.

- \`policy\` is \`auto\`, \`small\` or \`large\`; anything else is **400**. \`small\` is
  \`SMALL_MODEL\` (\`gpt-4o-mini\`), \`large\` is \`LARGE_MODEL\` (\`gpt-4o\`), and \`auto\` is the
  small model when the estimate is at most **AUTO_SMALL_MAX_TOKENS = 2048**, the large one above.
- An empty prompt is **400**, a prompt over **MAX_PROMPT_BYTES** (256 KiB of UTF-8) is **413**, and
  \`max_tokens\` outside **1…4096** is **400**.
- \`Idempotency-Key\` is required (**400**). The decision is stored once at
  \`decision:{tenant}:{key}\` (\`SET … NX EX 86400\`); a retry with the same key answers the stored
  decision.
- The log line carries the tenant, the model and the estimate, not the prompt.`,
  sequence: {
    participants: ['Client', 'routerd', 'Redis'],
    messages: [
      {from: 'Client', to: 'routerd', label: 'POST /v1/route · Bearer acme · Idempotency-Key: k-1', kind: 'sync'},
      {from: 'routerd', to: 'routerd', label: 'caps · policy ∈ {auto, small, large} · estimate', kind: 'sync'},
      {from: 'routerd', to: 'Redis', label: 'SET decision:acme:k-1 {…} NX EX 86400', kind: 'sync'},
      {from: 'Redis', to: 'routerd', label: 'OK (first time) / nil (a retry)', kind: 'reply'},
      {from: 'routerd', to: 'Client', label: '200 {id, model: gpt-4o-mini, policy, estimated_tokens}', kind: 'reply'},
      {from: 'Client', to: 'routerd', label: 'POST /v1/route · policy: gpt-4o', kind: 'sync'},
      {from: 'routerd', to: 'Client', label: '400 (the router picks the model)', kind: 'reply'},
    ],
  },
  hints: [
    'A tenant sends `policy: "gpt-4o"` and is served gpt-4o; a 2 MB prompt is routed like any other; a client that retried after a timeout holds two decisions with two ids; a log search turns up customer prompts.',
    "`MODELS.get(policy, policy)` hands back whatever string came in, and `auto` maps to the small model whatever the estimate says; nothing compares the prompt's bytes or `max_tokens` to a limit; nobody reads `Idempotency-Key`; the log line formats `prompt`.",
    'Answer 400 for a policy outside the three and choose `auto` by `estimate <= AUTO_SMALL_MAX_TOKENS`; check the bytes (413) and `max_tokens` (400) first; `SET decision:{tenant}:{key} <json> NX EX 86400` and answer the stored value when it exists; drop `prompt` from the log.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/route behind the bearer token',
      detail:
        'A handler is registered for `POST /v1/route`; it authenticates the tenant through the provided `authenticate` and answers the decision as JSON.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/route["']/, /authenticate\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/route['"]/, /authenticate\(/]},
        go: {all: [/"POST \/v1\/route"/, /auth\.Tenant\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/route"/, /routerd::tenant\(/]},
      },
    },
    {
      id: 'validate',
      title: 'Caps the prompt at 256 KiB and max_tokens at 1…4096',
      detail:
        'A prompt over `MAX_PROMPT_BYTES` UTF-8 bytes (not characters) answers 413, an empty prompt or `max_tokens` outside 1…4096 answers 400 (both ends are allowed), and a rejected request stores no decision.',
      match: {
        python: {all: [/>\s*MAX_PROMPT_BYTES/, /\b413\b/, /[<>]=?\s*MAX_OUTPUT_TOKENS/]},
        typescript: {all: [/>\s*MAX_PROMPT_BYTES/, /\b413\b/, /[<>]=?\s*MAX_OUTPUT_TOKENS/]},
        go: {all: [/>\s*maxPromptBytes/, /http\.StatusRequestEntityTooLarge|\b413\b/, /[<>]=?\s*maxOutputTokens/]},
        cpp: {all: [/>\s*kMaxPromptBytes/, /\b413\b/, /[<>]=?\s*kMaxOutputTokens/]},
      },
    },
    {
      id: 'policy',
      title: 'The router picks the model from the policy and the estimate',
      detail:
        'Only `auto`, `small` and `large` are accepted (400 otherwise); `auto` compares the estimate with `AUTO_SMALL_MAX_TOKENS`. Passing an unknown policy through as the model name lets any caller pick any model.',
      match: {
        python: {all: [/[<>]=?\s*AUTO_SMALL_MAX_TOKENS/], none: [/\.get\(\s*body\.policy\s*,\s*body\.policy\s*\)/]},
        typescript: {all: [/[<>]=?\s*AUTO_SMALL_MAX_TOKENS/], none: [/\?\?\s*policy\b/]},
        go: {all: [/[<>]=?\s*autoSmallMaxTokens/], none: [/model\s*=\s*body\.Policy/]},
        cpp: {all: [/[<>]=?\s*kAutoSmallMaxTokens/], none: [/:\s*policy\s*;/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Stores one decision per (tenant, Idempotency-Key)',
      detail:
        "`Idempotency-Key` is required; the decision is written with `SET decision:{tenant}:{key} … NX EX 86400` and a retry answers the stored decision instead of routing again. When another replica stores a decision for the same key between two of this request's commands, the request answers that decision; the key has its expiry from the command that creates it.",
      match: {
        python: {all: [/["']idempotency-key["']/i, /nx\s*=\s*True/]},
        typescript: {all: [/['"]idempotency-key['"]/i, /['"]NX['"]/]},
        go: {all: [/"Idempotency-Key"/, /\.SetNX\(|\.SetArgs\(/]},
        cpp: {all: [/"Idempotency-Key"/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'no-prompt-log',
      title: 'Logs the decision without the prompt',
      detail:
        'The log line names the tenant, the model and the estimate; neither it nor the answer carries the prompt. A prompt in a log file is customer data in a place with no access control.',
      match: {
        python: {none: [/logg?(er|ing)\.[a-z]+\([^\n]*prompt/i, /print\([^\n]*prompt/i]},
        typescript: {none: [/console\.(log|info|debug|warn|error)\([^\n]*prompt/i]},
        go: {none: [/(log|fmt)\.Print[a-z]*\([^\n]*Prompt/]},
        cpp: {none: [/std::c(out|err)[^\n]*prompt/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Request
from pydantic import BaseModel

from routerd.auth import authenticate
from routerd.tokens import estimate_tokens

app = FastAPI()
logger = logging.getLogger("routerd")

MAX_PROMPT_BYTES = 1 << 18
MAX_OUTPUT_TOKENS = 4096
AUTO_SMALL_MAX_TOKENS = 2048
SMALL_MODEL = "gpt-4o-mini"
LARGE_MODEL = "gpt-4o"
DECISION_TTL_S = 86400
MODELS = {"small": SMALL_MODEL, "large": LARGE_MODEL, "auto": SMALL_MODEL}


class RouteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256
    policy: str = "auto"


# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
@app.post("/v1/route")
def route(body: RouteRequest, request: Request) -> dict:
    tenant = authenticate(request.headers.get("authorization"))
    estimate = estimate_tokens(body.prompt, body.max_tokens)
    model = MODELS.get(body.policy, body.policy)
    logger.info("route tenant=%s policy=%s prompt=%s", tenant, body.policy, body.prompt)
    return {"id": str(uuid.uuid4()), "model": model, "policy": body.policy, "estimated_tokens": estimate}
`,
      solution: `import json
import logging
import uuid

import redis
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from routerd.auth import authenticate
from routerd.tokens import estimate_tokens

app = FastAPI()
logger = logging.getLogger("routerd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_PROMPT_BYTES = 1 << 18
MAX_OUTPUT_TOKENS = 4096
AUTO_SMALL_MAX_TOKENS = 2048
SMALL_MODEL = "gpt-4o-mini"
LARGE_MODEL = "gpt-4o"
DECISION_TTL_S = 86400
MODELS = {"small": SMALL_MODEL, "large": LARGE_MODEL}


class RouteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256
    policy: str = "auto"


@app.post("/v1/route")
def route(body: RouteRequest, request: Request) -> dict:
    tenant = authenticate(request.headers.get("authorization"))
    key = request.headers.get("idempotency-key")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not body.prompt:
        raise HTTPException(status_code=400, detail="prompt must not be empty")
    if len(body.prompt.encode()) > MAX_PROMPT_BYTES:
        raise HTTPException(status_code=413, detail="prompt exceeds 256 KiB")
    if not 1 <= body.max_tokens <= MAX_OUTPUT_TOKENS:
        raise HTTPException(status_code=400, detail="max_tokens must be between 1 and 4096")
    if body.policy != "auto" and body.policy not in MODELS:
        raise HTTPException(status_code=400, detail="policy must be auto, small or large")
    estimate = estimate_tokens(body.prompt, body.max_tokens)
    if body.policy == "auto":
        model = SMALL_MODEL if estimate <= AUTO_SMALL_MAX_TOKENS else LARGE_MODEL
    else:
        model = MODELS[body.policy]
    decision = {"id": str(uuid.uuid4()), "model": model, "policy": body.policy, "estimated_tokens": estimate}
    stored = f"decision:{tenant}:{key}"
    if not r.set(stored, json.dumps(decision), nx=True, ex=DECISION_TTL_S):
        return json.loads(r.get(stored))  # a retry: the decision made the first time
    logger.info("route tenant=%s model=%s estimate=%d", tenant, model, estimate)
    return decision
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {authenticate} from 'routerd/auth';
import {estimateTokens} from 'routerd/tokens';

export const app = Fastify();

export const MAX_PROMPT_BYTES = 1 << 18;
export const MAX_OUTPUT_TOKENS = 4096;
export const AUTO_SMALL_MAX_TOKENS = 2048;
export const SMALL_MODEL = 'gpt-4o-mini';
export const LARGE_MODEL = 'gpt-4o';
export const DECISION_TTL_S = 86_400;
const MODELS: Record<string, string> = {small: SMALL_MODEL, large: LARGE_MODEL, auto: SMALL_MODEL};

interface RouteRequest {
  prompt: string;
  max_tokens?: number;
  policy?: string;
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
app.post('/v1/route', async request => {
  const tenant = authenticate(request.headers.authorization);
  const body = request.body as RouteRequest;
  const maxTokens = body.max_tokens ?? 256;
  const policy = body.policy ?? 'auto';
  const estimate = estimateTokens(body.prompt, maxTokens);
  const model = MODELS[policy] ?? policy;
  console.log('route', tenant, policy, body.prompt);
  return {id: randomUUID(), model, policy, estimated_tokens: estimate};
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';
import {authenticate} from 'routerd/auth';
import {estimateTokens} from 'routerd/tokens';

export const app = Fastify();

export const MAX_PROMPT_BYTES = 1 << 18;
export const MAX_OUTPUT_TOKENS = 4096;
export const AUTO_SMALL_MAX_TOKENS = 2048;
export const SMALL_MODEL = 'gpt-4o-mini';
export const LARGE_MODEL = 'gpt-4o';
export const DECISION_TTL_S = 86_400;
const MODELS: Record<string, string> = {small: SMALL_MODEL, large: LARGE_MODEL};

const redis = new Redis({host: 'redis', port: 6379});

interface RouteRequest {
  prompt: string;
  max_tokens?: number;
  policy?: string;
}

app.post('/v1/route', async (request, reply) => {
  const tenant = authenticate(request.headers.authorization);
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as RouteRequest;
  const maxTokens = body.max_tokens ?? 256;
  const policy = body.policy ?? 'auto';
  if (typeof body.prompt !== 'string' || body.prompt === '') {
    return reply.code(400).send({error: 'prompt must not be empty'});
  }
  if (Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return reply.code(413).send({error: 'prompt exceeds 256 KiB'});
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) {
    return reply.code(400).send({error: 'max_tokens must be between 1 and 4096'});
  }
  if (policy !== 'auto' && !Object.hasOwn(MODELS, policy)) {
    return reply.code(400).send({error: 'policy must be auto, small or large'});
  }
  const estimate = estimateTokens(body.prompt, maxTokens);
  const model = policy === 'auto' ? (estimate <= AUTO_SMALL_MAX_TOKENS ? SMALL_MODEL : LARGE_MODEL) : MODELS[policy];
  const decision = {id: randomUUID(), model, policy, estimated_tokens: estimate};
  const stored = \`decision:\${tenant}:\${key}\`;
  if ((await redis.set(stored, JSON.stringify(decision), 'EX', DECISION_TTL_S, 'NX')) === null) {
    return JSON.parse((await redis.get(stored)) ?? '{}'); // a retry: the decision made the first time
  }
  console.log('route', tenant, model, estimate);
  return decision;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"

	"routerd/auth"
	"routerd/tokens"
)

const (
	maxPromptBytes     = 1 << 18
	maxOutputTokens    = 4096
	autoSmallMaxTokens = 2048
	smallModel         = "gpt-4o-mini"
	largeModel         = "gpt-4o"
	decisionTTL        = 24 * time.Hour
)

var models = map[string]string{"small": smallModel, "large": largeModel, "auto": smallModel}

type routeRequest struct {
	Prompt    string \`json:"prompt"\`
	MaxTokens *int   \`json:"max_tokens"\`
	Policy    string \`json:"policy"\`
}

type decision struct {
	ID              string \`json:"id"\`
	Model           string \`json:"model"\`
	Policy          string \`json:"policy"\`
	EstimatedTokens int    \`json:"estimated_tokens"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
func route(rw http.ResponseWriter, r *http.Request) {
	tenant, ok := auth.Tenant(r)
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	var body routeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	maxTokens := 256
	if body.MaxTokens != nil {
		maxTokens = *body.MaxTokens
	}
	if body.Policy == "" {
		body.Policy = "auto"
	}
	estimate := tokens.Estimate(body.Prompt, maxTokens)
	model, known := models[body.Policy]
	if !known {
		model = body.Policy
	}
	log.Printf("route tenant=%s policy=%s prompt=%q", tenant, body.Policy, body.Prompt)
	writeJSON(rw, http.StatusOK, decision{ID: uuid.NewString(), Model: model, Policy: body.Policy, EstimatedTokens: estimate})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/route", route)
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"routerd/auth"
	"routerd/tokens"
)

const (
	maxPromptBytes     = 1 << 18
	maxOutputTokens    = 4096
	autoSmallMaxTokens = 2048
	smallModel         = "gpt-4o-mini"
	largeModel         = "gpt-4o"
	decisionTTL        = 24 * time.Hour
)

var models = map[string]string{"small": smallModel, "large": largeModel}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type routeRequest struct {
	Prompt    string \`json:"prompt"\`
	MaxTokens *int   \`json:"max_tokens"\`
	Policy    string \`json:"policy"\`
}

type decision struct {
	ID              string \`json:"id"\`
	Model           string \`json:"model"\`
	Policy          string \`json:"policy"\`
	EstimatedTokens int    \`json:"estimated_tokens"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func route(rw http.ResponseWriter, r *http.Request) {
	tenant, ok := auth.Tenant(r)
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body routeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	maxTokens := 256
	if body.MaxTokens != nil {
		maxTokens = *body.MaxTokens
	}
	if body.Policy == "" {
		body.Policy = "auto"
	}
	if body.Prompt == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "prompt must not be empty"})
		return
	}
	if len(body.Prompt) > maxPromptBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "prompt exceeds 256 KiB"})
		return
	}
	if maxTokens < 1 || maxTokens > maxOutputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_tokens must be between 1 and 4096"})
		return
	}
	estimate := tokens.Estimate(body.Prompt, maxTokens)
	model, known := models[body.Policy]
	if body.Policy == "auto" {
		model, known = largeModel, true
		if estimate <= autoSmallMaxTokens {
			model = smallModel
		}
	}
	if !known {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "policy must be auto, small or large"})
		return
	}
	d := decision{ID: uuid.NewString(), Model: model, Policy: body.Policy, EstimatedTokens: estimate}
	value, _ := json.Marshal(d)
	stored := "decision:" + tenant + ":" + key
	created, err := rdb.SetNX(r.Context(), stored, value, decisionTTL).Result()
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !created {
		previous, err := rdb.Get(r.Context(), stored).Result() // a retry: the decision made the first time
		if err != nil {
			writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(rw, http.StatusOK, json.RawMessage(previous))
		return
	}
	log.Printf("route tenant=%s model=%s estimate=%d", tenant, model, estimate)
	writeJSON(rw, http.StatusOK, d)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/route", route)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <iostream>
#include <map>
#include <random>
#include <string>

#include "routerd/auth.h"
#include "routerd/tokens.h"

constexpr size_t kMaxPromptBytes = 1 << 18;
constexpr int kMaxOutputTokens = 4096;
constexpr long long kAutoSmallMaxTokens = 2048;
const std::string kSmallModel = "gpt-4o-mini";
const std::string kLargeModel = "gpt-4o";
constexpr long long kDecisionTtlSeconds = 86400;
const std::map<std::string, std::string> kModels = {{"small", kSmallModel}, {"large", kLargeModel}, {"auto", kSmallModel}};

std::string decision_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  char buf[33];
  std::snprintf(buf, sizeof buf, "%016llx%016llx", static_cast<unsigned long long>(rng()),
                static_cast<unsigned long long>(rng()));
  return buf;
}

void answer(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
void route(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = routerd::tenant(req);
  if (!tenant) return answer(res, 401, {{"error", "missing bearer token"}});
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(req.body);
  } catch (const std::exception&) {
    return answer(res, 400, {{"error", "invalid json"}});
  }
  const std::string prompt = body.value("prompt", "");
  const int max_tokens = body.value("max_tokens", 256);
  const std::string policy = body.value("policy", "auto");
  const long long estimate = routerd::estimate_tokens(prompt, max_tokens);
  const auto it = kModels.find(policy);
  const std::string model = it != kModels.end() ? it->second : policy;
  std::cout << "route " << *tenant << " " << policy << " prompt=" << prompt << "\\n";
  answer(res, 200, {{"id", decision_id()}, {"model", model}, {"policy", policy}, {"estimated_tokens", estimate}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/route", route);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdio>
#include <iostream>
#include <map>
#include <random>
#include <string>

#include "routerd/auth.h"
#include "routerd/tokens.h"

constexpr size_t kMaxPromptBytes = 1 << 18;
constexpr int kMaxOutputTokens = 4096;
constexpr long long kAutoSmallMaxTokens = 2048;
const std::string kSmallModel = "gpt-4o-mini";
const std::string kLargeModel = "gpt-4o";
constexpr long long kDecisionTtlSeconds = 86400;
const std::map<std::string, std::string> kModels = {{"small", kSmallModel}, {"large", kLargeModel}};

sw::redis::Redis redis("tcp://redis:6379");

std::string decision_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  char buf[33];
  std::snprintf(buf, sizeof buf, "%016llx%016llx", static_cast<unsigned long long>(rng()),
                static_cast<unsigned long long>(rng()));
  return buf;
}

void answer(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void route(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = routerd::tenant(req);
  if (!tenant) return answer(res, 401, {{"error", "missing bearer token"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return answer(res, 400, {{"error", "Idempotency-Key is required"}});
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(req.body);
  } catch (const std::exception&) {
    return answer(res, 400, {{"error", "invalid json"}});
  }
  const std::string prompt = body.value("prompt", "");
  const int max_tokens = body.value("max_tokens", 256);
  const std::string policy = body.value("policy", "auto");
  if (prompt.empty()) return answer(res, 400, {{"error", "prompt must not be empty"}});
  if (prompt.size() > kMaxPromptBytes) return answer(res, 413, {{"error", "prompt exceeds 256 KiB"}});
  if (max_tokens < 1 || max_tokens > kMaxOutputTokens) {
    return answer(res, 400, {{"error", "max_tokens must be between 1 and 4096"}});
  }
  if (policy != "auto" && !kModels.count(policy)) {
    return answer(res, 400, {{"error", "policy must be auto, small or large"}});
  }
  const long long estimate = routerd::estimate_tokens(prompt, max_tokens);
  std::string model = estimate <= kAutoSmallMaxTokens ? kSmallModel : kLargeModel;
  if (policy != "auto") model = kModels.at(policy);
  const nlohmann::json decision = {{"id", decision_id()}, {"model", model}, {"policy", policy}, {"estimated_tokens", estimate}};
  const std::string stored = "decision:" + *tenant + ":" + key;
  if (!redis.set(stored, decision.dump(), std::chrono::seconds(kDecisionTtlSeconds), sw::redis::UpdateType::NOT_EXIST)) {
    const auto previous = redis.get(stored);  // a retry: the decision made the first time
    return answer(res, 200, nlohmann::json::parse(previous.value_or("{}")));
  }
  std::cout << "route " << *tenant << " " << model << " estimate=" << estimate << "\\n";
  answer(res, 200, decision);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/route", route);
}
`,
    },
  },
  harness: {
    python: `import contextlib
import io
import json
import logging

AUTH = {"Authorization": "Bearer acme"}
CANARY = "CANARY-7731 my card number is 4111"
PROMPT = "Summarise this ticket in one line."


def _body(prompt=PROMPT, max_tokens=256, policy="auto"):
    return {"prompt": prompt, "max_tokens": max_tokens, "policy": policy}


async def _route(ctx, m, body, key="k-1", tenant="acme"):
    headers = {}
    if tenant:
        headers["Authorization"] = f"Bearer {tenant}"
    if key:
        headers["Idempotency-Key"] = key
    async with ctx.client(m.app) as c:
        return await c.post("/v1/route", json=body, headers=headers)


async def check_route(ctx):
    m = ctx.load("router_api")
    r = await _route(ctx, m, _body())
    assert r.status_code == 200, f"POST /v1/route answered {r.status_code}: {r.text}"
    assert r.headers.get("content-type", "").startswith("application/json"), f"the answer must be JSON, got Content-Type {r.headers.get('content-type')!r}"
    out = r.json()
    assert isinstance(out.get("id"), str) and out["id"], f"the decision carries no id: {out}"
    assert out.get("policy") == "auto", f"the decision must name the policy it applied, got {out.get('policy')!r}"
    assert out.get("estimated_tokens") == 9 + 256, f"estimated_tokens is {out.get('estimated_tokens')!r}, expected estimate_tokens(prompt, 256) = 265"
    anonymous = await _route(ctx, m, _body(), tenant=None)
    assert anonymous.status_code == 401, f"a request without a bearer token answered {anonymous.status_code}, expected 401"


async def check_validate(ctx):
    m = ctx.load("router_api")
    bad = [
        ("a prompt of 256 KiB + 1 byte", _body(prompt="x" * ((1 << 18) + 1)), 413),
        ("a prompt of 131 073 two-byte characters (256 KiB + 2 bytes of UTF-8)", _body(prompt="é" * ((1 << 17) + 1)), 413),
        ("an empty prompt", _body(prompt=""), 400),
        ("max_tokens 0", _body(max_tokens=0), 400),
        ("max_tokens 4097", _body(max_tokens=4097), 400),
    ]
    for i, (what, body, status) in enumerate(bad):
        r = await _route(ctx, m, body, key=f"bad-{i}")
        assert r.status_code == status, f"{what} answered {r.status_code}, expected {status}"
    stored = sorted(ctx.redis.keys("decision:*"))
    assert stored == [], f"rejected requests stored decisions: {stored}"
    ok = await _route(ctx, m, _body(prompt="x" * (1 << 18), max_tokens=4096, policy="large"), key="edge")
    assert ok.status_code == 200, f"a request at the limits (256 KiB, max_tokens 4096) answered {ok.status_code}: {ok.text}"
    least = await _route(ctx, m, _body(max_tokens=1), key="edge-1")
    assert least.status_code == 200, f"a request with max_tokens 1 answered {least.status_code}: {least.text}"


async def check_policy(ctx):
    m = ctx.load("router_api")
    cases = [
        ("policy small with a long prompt", _body(prompt="x" * 20000, policy="small"), "gpt-4o-mini"),
        ("policy large with a short prompt", _body(policy="large"), "gpt-4o"),
        ("policy auto at exactly 2048 estimated tokens", _body(prompt="x" * 7168), "gpt-4o-mini"),
        ("policy auto at 2049 estimated tokens", _body(prompt="x" * 7172), "gpt-4o"),
    ]
    for i, (what, body, model) in enumerate(cases):
        r = await _route(ctx, m, body, key=f"p-{i}")
        assert r.status_code == 200, f"{what} answered {r.status_code}: {r.text}"
        assert r.json().get("model") == model, f"{what} routed to {r.json().get('model')!r}, expected {model!r}"
    for i, policy in enumerate(("gpt-4o", "o1-pro", "")):
        r = await _route(ctx, m, _body(policy=policy), key=f"x-{i}")
        assert r.status_code == 400, f"policy {policy!r} answered {r.status_code} with {r.text}: only auto, small and large are policies, the caller does not name the model"


async def check_idempotency_key(ctx):
    m = ctx.load("router_api")
    first = await _route(ctx, m, _body(), key="k-1")
    assert first.status_code == 200, f"POST /v1/route answered {first.status_code}: {first.text}"
    retry = await _route(ctx, m, _body(), key="k-1")
    assert retry.status_code == 200, f"the retry answered {retry.status_code}: {retry.text}"
    assert retry.json().get("id") == first.json().get("id"), f"a retry with the same Idempotency-Key answered a new decision ({retry.json().get('id')} after {first.json().get('id')}): the client now holds two"
    ttl = ctx.redis.ttl("decision:acme:k-1")
    assert 86000 <= ttl <= 86400, f"decision:acme:k-1 has TTL {ttl} (keys: {sorted(ctx.redis.keys('decision:*'))}), expected the decision stored for 86400 s"
    other = await _route(ctx, m, _body(), key="k-1", tenant="beta")
    assert other.status_code == 200 and other.json().get("id") != first.json().get("id"), "another tenant using the same Idempotency-Key received acme's decision: the key is per tenant"
    missing = await _route(ctx, m, _body(), key=None)
    assert missing.status_code == 400, f"a request without Idempotency-Key answered {missing.status_code}, expected 400"
    # Another replica stores its decision for k-2 right after this request's first command on the key.
    rival_decision = {"id": "d-rival", "model": "gpt-4o-mini", "policy": "auto", "estimated_tokens": 265}
    rival = ctx.redis_after("decision:acme:k-2", lambda: (bool(ctx.redis.set("decision:acme:k-2", json.dumps(rival_decision), nx=True, ex=86400)), ctx.redis.ttl("decision:acme:k-2")))
    raced = await _route(ctx, m, _body(), key="k-2")
    assert rival.fired, "the request with Idempotency-Key k-2 never touched decision:acme:k-2"
    if rival.error is not None:
        raise rival.error
    rival_won, ttl_then = rival.result
    assert raced.status_code == 200, f"the request with Idempotency-Key k-2 answered {raced.status_code}: {raced.text}"
    if rival_won:
        held = json.loads(ctx.redis.get("decision:acme:k-2") or "{}").get("id")
        assert raced.json().get("id") == "d-rival" and held == "d-rival", f"another replica stored decision d-rival for k-2 between this request's first command on the key and its write, yet this one answered {raced.json().get('id')!r} and decision:acme:k-2 holds {held!r}: the client holds two decisions. Check and store in one command"
    else:
        assert 0 < ttl_then <= 86400, f"right after the request stored decision:acme:k-2 its TTL was {ttl_then}: a crash before the expiry is set keeps the decision for good. Store the decision and its expiry in one command"


async def check_no_prompt_log(ctx):
    m = ctx.load("router_api")
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    root = logging.getLogger()
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            r = await _route(ctx, m, _body(prompt=CANARY))
    finally:
        root.removeHandler(handler)
        root.setLevel(level)
    assert r.status_code == 200, f"POST /v1/route answered {r.status_code}: {r.text}"
    assert "CANARY-7731" not in r.text, f"the answer echoes the prompt: {r.text}"
    logged = captured.getvalue()
    assert "CANARY-7731" not in logged, f"the prompt was printed or logged: {logged.strip()!r}"
    missing = [field for field in ("acme", "gpt-4o-mini", "265") if field not in logged]
    assert not missing, f"the log line must name the tenant, the model and the estimate; {missing} not found in {logged.strip()!r}"
`,
    typescript: `const CANARY = 'CANARY-7731 my card number is 4111';
const PROMPT = 'Summarise this ticket in one line.';

const body = (o: {prompt?: string; max_tokens?: number; policy?: string} = {}) => ({
  prompt: o.prompt ?? PROMPT,
  max_tokens: o.max_tokens ?? 256,
  policy: o.policy ?? 'auto',
});

function router(ctx) {
  const m = ctx.load('router_api');
  const c = ctx.client(m.app);
  const route = (b: unknown, key: string | null = 'k-1', tenant: string | null = 'acme') => {
    const headers: Record<string, string> = {};
    if (tenant !== null) headers.Authorization = \`Bearer \${tenant}\`;
    if (key !== null) headers['Idempotency-Key'] = key;
    return c.post('/v1/route', {body: b, headers});
  };
  return {m, route};
}

export async function check_route(ctx) {
  const {route} = router(ctx);
  const r = await route(body());
  assert.equal(r.status, 200, \`POST /v1/route answered \${r.status}: \${r.text}\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`the answer must be JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  const out = r.json();
  assert(typeof out.id === 'string' && out.id !== '', \`the decision carries no id: \${r.text}\`);
  assert.equal(out.policy, 'auto', \`the decision must name the policy it applied, got \${JSON.stringify(out.policy)}\`);
  assert.equal(out.estimated_tokens, 9 + 256, \`estimated_tokens is \${JSON.stringify(out.estimated_tokens)}, expected estimateTokens(prompt, 256) = 265\`);
  const anonymous = await route(body(), 'k-1', null);
  assert.equal(anonymous.status, 401, \`a request without a bearer token answered \${anonymous.status}, expected 401\`);
}

export async function check_validate(ctx) {
  const {route} = router(ctx);
  const bad: [string, unknown, number][] = [
    ['a prompt of 256 KiB + 1 byte', body({prompt: 'x'.repeat((1 << 18) + 1)}), 413],
    ['a prompt of 131 073 two-byte characters (256 KiB + 2 bytes of UTF-8)', body({prompt: 'é'.repeat((1 << 17) + 1)}), 413],
    ['an empty prompt', body({prompt: ''}), 400],
    ['max_tokens 0', body({max_tokens: 0}), 400],
    ['max_tokens 4097', body({max_tokens: 4097}), 400],
  ];
  for (const [i, [what, b, status]] of bad.entries()) {
    const r = await route(b, \`bad-\${i}\`);
    assert.equal(r.status, status, \`\${what} answered \${r.status}, expected \${status}\`);
  }
  const stored = ctx.redis.keys('decision:*').sort();
  assert.deepStrictEqual(stored, [], \`rejected requests stored decisions: \${JSON.stringify(stored)}\`);
  const ok = await route(body({prompt: 'x'.repeat(1 << 18), max_tokens: 4096, policy: 'large'}), 'edge');
  assert.equal(ok.status, 200, \`a request at the limits (256 KiB, max_tokens 4096) answered \${ok.status}: \${ok.text}\`);
  const least = await route(body({max_tokens: 1}), 'edge-1');
  assert.equal(least.status, 200, \`a request with max_tokens 1 answered \${least.status}: \${least.text}\`);
}

export async function check_policy(ctx) {
  const {route} = router(ctx);
  const cases: [string, unknown, string][] = [
    ['policy small with a long prompt', body({prompt: 'x'.repeat(20000), policy: 'small'}), 'gpt-4o-mini'],
    ['policy large with a short prompt', body({policy: 'large'}), 'gpt-4o'],
    ['policy auto at exactly 2048 estimated tokens', body({prompt: 'x'.repeat(7168)}), 'gpt-4o-mini'],
    ['policy auto at 2049 estimated tokens', body({prompt: 'x'.repeat(7172)}), 'gpt-4o'],
  ];
  for (const [i, [what, b, model]] of cases.entries()) {
    const r = await route(b, \`p-\${i}\`);
    assert.equal(r.status, 200, \`\${what} answered \${r.status}: \${r.text}\`);
    assert.equal(r.json().model, model, \`\${what} routed to \${JSON.stringify(r.json().model)}, expected \${JSON.stringify(model)}\`);
  }
  for (const [i, policy] of ['gpt-4o', 'o1-pro', ''].entries()) {
    const r = await route(body({policy}), \`x-\${i}\`);
    assert.equal(r.status, 400, \`policy \${JSON.stringify(policy)} answered \${r.status} with \${r.text}: only auto, small and large are policies, the caller does not name the model\`);
  }
}

export async function check_idempotency_key(ctx) {
  const {route} = router(ctx);
  const first = await route(body(), 'k-1');
  assert.equal(first.status, 200, \`POST /v1/route answered \${first.status}: \${first.text}\`);
  const retry = await route(body(), 'k-1');
  assert.equal(retry.status, 200, \`the retry answered \${retry.status}: \${retry.text}\`);
  assert.equal(retry.json().id, first.json().id, \`a retry with the same Idempotency-Key answered a new decision (\${retry.json().id} after \${first.json().id}): the client now holds two\`);
  const ttl = Number(ctx.redis.ttl('decision:acme:k-1'));
  assert(86000 <= ttl && ttl <= 86400, \`decision:acme:k-1 has TTL \${ttl} (keys: \${JSON.stringify(ctx.redis.keys('decision:*').sort())}), expected the decision stored for 86400 s\`);
  const other = await route(body(), 'k-1', 'beta');
  assert(other.status === 200 && other.json().id !== first.json().id, "another tenant using the same Idempotency-Key received acme's decision: the key is per tenant");
  const missing = await route(body(), null);
  assert.equal(missing.status, 400, \`a request without Idempotency-Key answered \${missing.status}, expected 400\`);
  // Another replica stores its decision for k-2 right after this request's first command on the key.
  const rivalDecision = {id: 'd-rival', model: 'gpt-4o-mini', policy: 'auto', estimated_tokens: 265};
  const rival = ctx.redisAfter('decision:acme:k-2', () => [ctx.redis.set('decision:acme:k-2', JSON.stringify(rivalDecision), 'EX', 86400, 'NX') !== null, Number(ctx.redis.ttl('decision:acme:k-2'))]);
  const raced = await route(body(), 'k-2');
  assert(rival.fired, 'the request with Idempotency-Key k-2 never touched decision:acme:k-2');
  if (rival.error !== undefined) throw rival.error;
  const [rivalWon, ttlThen] = rival.result as [boolean, number];
  assert.equal(raced.status, 200, \`the request with Idempotency-Key k-2 answered \${raced.status}: \${raced.text}\`);
  if (rivalWon) {
    const held = JSON.parse(ctx.redis.get('decision:acme:k-2') ?? '{}').id;
    assert(raced.json().id === 'd-rival' && held === 'd-rival', \`another replica stored decision d-rival for k-2 between this request's first command on the key and its write, yet this one answered \${JSON.stringify(raced.json().id)} and decision:acme:k-2 holds \${JSON.stringify(held)}: the client holds two decisions. Check and store in one command\`);
  } else {
    assert(ttlThen > 0 && ttlThen <= 86400, \`right after the request stored decision:acme:k-2 its TTL was \${ttlThen}: a crash before the expiry is set keeps the decision for good. Store the decision and its expiry in one command\`);
  }
}

export async function check_no_prompt_log(ctx) {
  const {route} = router(ctx);
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  let r;
  try {
    r = await route(body({prompt: CANARY}));
  } finally {
    Object.assign(console, prior);
  }
  assert.equal(r.status, 200, \`POST /v1/route answered \${r.status}: \${r.text}\`);
  assert(!r.text.includes('CANARY-7731'), \`the answer echoes the prompt: \${r.text}\`);
  const leak = logged.find(l => l.includes('CANARY-7731'));
  assert(leak === undefined, \`the prompt was printed or logged: \${JSON.stringify(leak)}\`);
  const all = logged.join('\\n');
  const absent = ['acme', 'gpt-4o-mini', '265'].filter(field => !all.includes(field));
  assert.deepStrictEqual(absent, [], \`the log line must name the tenant, the model and the estimate; \${JSON.stringify(absent)} not found in \${JSON.stringify(all)}\`);
}
`,
    go: `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"leetbuild/harness"
)

const (
	kHRouteCanary = "CANARY-7731 my card number is 4111"
	kHRoutePrompt = "Summarise this ticket in one line."
)

func hRouteServer(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hRouteBody(prompt string, maxTokens int, policy string) map[string]any {
	return map[string]any{"prompt": prompt, "max_tokens": maxTokens, "policy": policy}
}

func hRouteAs(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	header := []string{"Content-Type", "application/json"}
	if tenant != "" {
		header = append(header, "Authorization", "Bearer "+tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/route", body, header...)
}

func hRouteOut(r *harness.Response) map[string]any {
	out, _ := r.JSON().(map[string]any)
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := hRouteServer(ctx)
	r := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "k-1", "acme")
	ctx.Equal(r.Status, 200, "POST /v1/route (%s)", r.Text())
	ctype := r.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "application/json"), "the answer must be JSON, got Content-Type %q", ctype)
	out := hRouteOut(r)
	id, _ := out["id"].(string)
	ctx.Assert(id != "", "the decision carries no id: %s", r.Text())
	ctx.Equal(out["policy"], "auto", "the decision must name the policy it applied")
	ctx.Equal(out["estimated_tokens"], float64(9+256), "estimated_tokens (tokens.Estimate(prompt, 256) = 265)")
	anonymous := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "k-1", "")
	ctx.Equal(anonymous.Status, 401, "a request without a bearer token")
}

func CheckValidate(ctx *harness.Ctx) {
	c := hRouteServer(ctx)
	bad := []struct {
		what   string
		body   map[string]any
		status int
	}{
		{"a prompt of 256 KiB + 1 byte", hRouteBody(strings.Repeat("x", 1<<18+1), 256, "auto"), 413},
		{"a prompt of 131 073 two-byte characters (256 KiB + 2 bytes of UTF-8)", hRouteBody(strings.Repeat("é", 1<<17+1), 256, "auto"), 413},
		{"an empty prompt", hRouteBody("", 256, "auto"), 400},
		{"max_tokens 0", hRouteBody(kHRoutePrompt, 0, "auto"), 400},
		{"max_tokens 4097", hRouteBody(kHRoutePrompt, 4097, "auto"), 400},
	}
	for i, b := range bad {
		r := hRouteAs(c, b.body, fmt.Sprintf("bad-%d", i), "acme")
		ctx.Equal(r.Status, b.status, "%s", b.what)
	}
	stored := ctx.Redis.Keys("decision:*")
	ctx.Assert(len(stored) == 0, "rejected requests stored decisions: %v", stored)
	ok := hRouteAs(c, hRouteBody(strings.Repeat("x", 1<<18), 4096, "large"), "edge", "acme")
	ctx.Equal(ok.Status, 200, "a request at the limits (256 KiB, max_tokens 4096) (%s)", ok.Text())
	least := hRouteAs(c, hRouteBody(kHRoutePrompt, 1, "auto"), "edge-1", "acme")
	ctx.Equal(least.Status, 200, "a request with max_tokens 1 (%s)", least.Text())
}

func CheckPolicy(ctx *harness.Ctx) {
	c := hRouteServer(ctx)
	cases := []struct {
		what  string
		body  map[string]any
		model string
	}{
		{"policy small with a long prompt", hRouteBody(strings.Repeat("x", 20000), 256, "small"), "gpt-4o-mini"},
		{"policy large with a short prompt", hRouteBody(kHRoutePrompt, 256, "large"), "gpt-4o"},
		{"policy auto at exactly 2048 estimated tokens", hRouteBody(strings.Repeat("x", 7168), 256, "auto"), "gpt-4o-mini"},
		{"policy auto at 2049 estimated tokens", hRouteBody(strings.Repeat("x", 7172), 256, "auto"), "gpt-4o"},
	}
	for i, tc := range cases {
		r := hRouteAs(c, tc.body, fmt.Sprintf("p-%d", i), "acme")
		ctx.Equal(r.Status, 200, "%s (%s)", tc.what, r.Text())
		ctx.Equal(hRouteOut(r)["model"], tc.model, "%s: the model", tc.what)
	}
	for i, policy := range []string{"gpt-4o", "o1-pro"} {
		r := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, policy), fmt.Sprintf("x-%d", i), "acme")
		ctx.Equal(r.Status, 400, "policy %q answered %s: only auto, small and large are policies, the caller does not name the model; the status", policy, r.Text())
	}
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := hRouteServer(ctx)
	first := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "k-1", "acme")
	ctx.Equal(first.Status, 200, "POST /v1/route (%s)", first.Text())
	retry := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "k-1", "acme")
	ctx.Equal(retry.Status, 200, "the retry (%s)", retry.Text())
	ctx.Equal(hRouteOut(retry)["id"], hRouteOut(first)["id"], "a retry with the same Idempotency-Key answered a new decision (the client now holds two); the id")
	ttl := ctx.Redis.TTL("decision:acme:k-1")
	ctx.Assert(86000 <= ttl && ttl <= 86400, "decision:acme:k-1 has TTL %d (keys: %v), expected the decision stored for 86400 s", ttl, ctx.Redis.Keys("decision:*"))
	other := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "k-1", "beta")
	ctx.Assert(other.Status == 200 && hRouteOut(other)["id"] != hRouteOut(first)["id"], "another tenant using the same Idempotency-Key received acme's decision: the key is per tenant")
	missing := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "", "acme")
	ctx.Equal(missing.Status, 400, "a request without Idempotency-Key")
	// Another replica stores its decision for k-2 right after this request's first command on the key.
	rivalDecision := "{\\"id\\":\\"d-rival\\",\\"model\\":\\"gpt-4o-mini\\",\\"policy\\":\\"auto\\",\\"estimated_tokens\\":265}"
	rival := ctx.Redis.After("decision:acme:k-2", func() any {
		return []any{ctx.Redis.Set("decision:acme:k-2", rivalDecision, "EX", 86400, "NX"), ctx.Redis.TTL("decision:acme:k-2")}
	})
	raced := hRouteAs(c, hRouteBody(kHRoutePrompt, 256, "auto"), "k-2", "acme")
	ctx.Assert(rival.Fired, "the request with Idempotency-Key k-2 never touched decision:acme:k-2")
	ctx.Assert(rival.Err == nil, "the rival request failed: %v", rival.Err)
	got, _ := rival.Result.([]any)
	rivalWon, _ := got[0].(bool)
	ttlThen, _ := got[1].(int64)
	ctx.Equal(raced.Status, 200, "the request with Idempotency-Key k-2 (%s)", raced.Text())
	if rivalWon {
		stored, _ := ctx.Redis.Get("decision:acme:k-2")
		var held struct {
			ID string \`json:"id"\`
		}
		json.Unmarshal([]byte(stored), &held)
		ctx.Assert(hRouteOut(raced)["id"] == "d-rival" && held.ID == "d-rival", "another replica stored decision d-rival for k-2 between this request's first command on the key and its write, yet this one answered %v and decision:acme:k-2 holds %q: the client holds two decisions. Check and store in one command", hRouteOut(raced)["id"], held.ID)
	} else {
		ctx.Assert(ttlThen > 0 && ttlThen <= 86400, "right after the request stored decision:acme:k-2 its TTL was %d: a crash before the expiry is set keeps the decision for good. Store the decision and its expiry in one command", ttlThen)
	}
}

func CheckNoPromptLog(ctx *harness.Ctx) {
	c := hRouteServer(ctx)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	r := hRouteAs(c, hRouteBody(kHRouteCanary, 256, "auto"), "k-1", "acme")
	ctx.Equal(r.Status, 200, "POST /v1/route (%s)", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "CANARY-7731"), "the answer echoes the prompt: %s", r.Text())
	ctx.Assert(!strings.Contains(logged.String(), "CANARY-7731"), "the prompt was printed or logged: %q", strings.TrimSpace(logged.String()))
	absent := []string{}
	for _, field := range []string{"acme", "gpt-4o-mini", "265"} {
		if !strings.Contains(logged.String(), field) {
			absent = append(absent, field)
		}
	}
	ctx.Assert(len(absent) == 0, "the log line must name the tenant, the model and the estimate; %v not found in %q", absent, strings.TrimSpace(logged.String()))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace {

const std::string kHRouteCanary = "CANARY-7731 my card number is 4111";
const std::string kHRoutePrompt = "Summarise this ticket in one line.";

harness::HTTP hRouteServer(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string hRouteBody(const std::string& prompt = kHRoutePrompt, int max_tokens = 256, const std::string& policy = "auto") {
  return nlohmann::json{{"prompt", prompt}, {"max_tokens", max_tokens}, {"policy", policy}}.dump();
}

harness::Response hRouteAs(harness::HTTP& c, const std::string& body, const std::string& key = "k-1", const std::string& tenant = "acme") {
  if (tenant.empty()) return c.Post("/v1/route", body, "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/route", body, "Authorization", "Bearer " + tenant);
  return c.Post("/v1/route", body, "Authorization", "Bearer " + tenant, "Idempotency-Key", key);
}

nlohmann::json hRouteOut(const harness::Response& r) {
  const auto out = nlohmann::json::parse(r.Text(), nullptr, false);
  return out.is_object() ? out : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = hRouteServer(ctx);
  const auto r = hRouteAs(c, hRouteBody());
  ctx.Equal(r.Status, 200, "POST /v1/route (%s)", r.Text());
  const std::string ctype = r.HeaderValue("Content-Type");
  ctx.Assert(ctype.rfind("application/json", 0) == 0, "the answer must be JSON, got Content-Type %q", ctype);
  const auto out = hRouteOut(r);
  ctx.Assert(!out.value("id", "").empty(), "the decision carries no id: %s", r.Text());
  ctx.Equal(out.value("policy", ""), "auto", "the decision must name the policy it applied");
  ctx.Equal(out.value("estimated_tokens", -1LL), 9 + 256LL, "estimated_tokens (routerd::estimate_tokens(prompt, 256) = 265)");
  const auto anonymous = hRouteAs(c, hRouteBody(), "k-1", "");
  ctx.Equal(anonymous.Status, 401, "a request without a bearer token");
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = hRouteServer(ctx);
  struct Bad {
    std::string what, body;
    int status;
  };
  std::string two_byte;
  for (int i = 0; i < (1 << 17) + 1; i++) two_byte += "é";
  const std::vector<Bad> bad = {
      {"a prompt of 256 KiB + 1 byte", hRouteBody(std::string((1 << 18) + 1, 'x')), 413},
      {"a prompt of 131 073 two-byte characters (256 KiB + 2 bytes of UTF-8)", hRouteBody(two_byte), 413},
      {"an empty prompt", hRouteBody(""), 400},
      {"max_tokens 0", hRouteBody(kHRoutePrompt, 0), 400},
      {"max_tokens 4097", hRouteBody(kHRoutePrompt, 4097), 400},
  };
  for (size_t i = 0; i < bad.size(); i++) {
    const auto r = hRouteAs(c, bad[i].body, "bad-" + std::to_string(i));
    ctx.Equal(r.Status, bad[i].status, "%s", bad[i].what);
  }
  const auto stored = ctx.Redis.Keys("decision:*");
  ctx.Assert(stored.empty(), "rejected requests stored decisions: %v", stored);
  const auto ok = hRouteAs(c, hRouteBody(std::string(1 << 18, 'x'), 4096, "large"), "edge");
  ctx.Equal(ok.Status, 200, "a request at the limits (256 KiB, max_tokens 4096) (%s)", ok.Text());
  const auto least = hRouteAs(c, hRouteBody(kHRoutePrompt, 1), "edge-1");
  ctx.Equal(least.Status, 200, "a request with max_tokens 1 (%s)", least.Text());
}

void CheckPolicy(harness::Ctx& ctx) {
  auto c = hRouteServer(ctx);
  struct Case {
    std::string what, body, model;
  };
  const std::vector<Case> cases = {
      {"policy small with a long prompt", hRouteBody(std::string(20000, 'x'), 256, "small"), "gpt-4o-mini"},
      {"policy large with a short prompt", hRouteBody(kHRoutePrompt, 256, "large"), "gpt-4o"},
      {"policy auto at exactly 2048 estimated tokens", hRouteBody(std::string(7168, 'x')), "gpt-4o-mini"},
      {"policy auto at 2049 estimated tokens", hRouteBody(std::string(7172, 'x')), "gpt-4o"},
  };
  for (size_t i = 0; i < cases.size(); i++) {
    const auto r = hRouteAs(c, cases[i].body, "p-" + std::to_string(i));
    ctx.Equal(r.Status, 200, "%s (%s)", cases[i].what, r.Text());
    ctx.Equal(hRouteOut(r).value("model", ""), cases[i].model, "%s: the model", cases[i].what);
  }
  const std::vector<std::string> policies = {"gpt-4o", "o1-pro"};
  for (size_t i = 0; i < policies.size(); i++) {
    const auto r = hRouteAs(c, hRouteBody(kHRoutePrompt, 256, policies[i]), "x-" + std::to_string(i));
    ctx.Equal(r.Status, 400, "policy %q answered %s: only auto, small and large are policies, the caller does not name the model; the status", policies[i], r.Text());
  }
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = hRouteServer(ctx);
  const auto first = hRouteAs(c, hRouteBody(), "k-1");
  ctx.Equal(first.Status, 200, "POST /v1/route (%s)", first.Text());
  const auto retry = hRouteAs(c, hRouteBody(), "k-1");
  ctx.Equal(retry.Status, 200, "the retry (%s)", retry.Text());
  ctx.Equal(hRouteOut(retry).value("id", ""), hRouteOut(first).value("id", ""), "a retry with the same Idempotency-Key answered a new decision (the client now holds two); the id");
  const long long ttl = ctx.Redis.TTL("decision:acme:k-1");
  ctx.Assert(86000 <= ttl && ttl <= 86400, "decision:acme:k-1 has TTL %d (keys: %v), expected the decision stored for 86400 s", ttl, ctx.Redis.Keys("decision:*"));
  const auto other = hRouteAs(c, hRouteBody(), "k-1", "beta");
  ctx.Assert(other.Status == 200 && hRouteOut(other).value("id", "") != hRouteOut(first).value("id", ""), "another tenant using the same Idempotency-Key received acme's decision: the key is per tenant");
  const auto missing = hRouteAs(c, hRouteBody(), "", "acme");
  ctx.Equal(missing.Status, 400, "a request without Idempotency-Key");
  // Another replica stores its decision for k-2 right after this request's first command on the key.
  const std::string rival_decision = nlohmann::json{{"id", "d-rival"}, {"model", "gpt-4o-mini"}, {"policy", "auto"}, {"estimated_tokens", 265}}.dump();
  auto fired = std::make_shared<bool>(false);
  auto rival_won = std::make_shared<bool>(false);
  auto ttl_then = std::make_shared<long long>(0);
  auto failed = std::make_shared<std::string>();
  ctx.Redis.After("decision:acme:k-2", [&ctx, rival_decision, fired, rival_won, ttl_then, failed] {
    *fired = true;
    try {
      *rival_won = ctx.Redis.Set("decision:acme:k-2", rival_decision, "EX", "86400", "NX");
      *ttl_then = ctx.Redis.TTL("decision:acme:k-2");
    } catch (const std::exception& e) {
      *failed = e.what();
    }
  });
  const auto raced = hRouteAs(c, hRouteBody(), "k-2");
  ctx.Assert(*fired, "the request with Idempotency-Key k-2 never touched decision:acme:k-2");
  ctx.Assert(failed->empty(), "the rival request failed: %s", *failed);
  ctx.Equal(raced.Status, 200, "the request with Idempotency-Key k-2 (%s)", raced.Text());
  if (*rival_won) {
    const auto held = nlohmann::json::parse(ctx.Redis.Get("decision:acme:k-2").value_or("{}"), nullptr, false);
    const std::string held_id = held.is_object() ? held.value("id", "") : "";
    ctx.Assert(hRouteOut(raced).value("id", "") == "d-rival" && held_id == "d-rival", "another replica stored decision d-rival for k-2 between this request's first command on the key and its write, yet this one answered %s and decision:acme:k-2 holds %s: the client holds two decisions. Check and store in one command", hRouteOut(raced).value("id", ""), held_id);
  } else {
    ctx.Assert(*ttl_then > 0 && *ttl_then <= 86400, "right after the request stored decision:acme:k-2 its TTL was %d: a crash before the expiry is set keeps the decision for good. Store the decision and its expiry in one command", *ttl_then);
  }
}

void CheckNoPromptLog(harness::Ctx& ctx) {
  auto c = hRouteServer(ctx);
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  const auto r = hRouteAs(c, hRouteBody(kHRouteCanary));
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Equal(r.Status, 200, "POST /v1/route (%s)", r.Text());
  ctx.Assert(r.Text().find("CANARY-7731") == std::string::npos, "the answer echoes the prompt: %s", r.Text());
  ctx.Assert(logged.str().find("CANARY-7731") == std::string::npos, "the prompt was printed or logged: %q", logged.str());
  std::vector<std::string> absent;
  for (const std::string field : {"acme", "gpt-4o-mini", "265"}) {
    if (logged.str().find(field) == std::string::npos) absent.push_back(field);
  }
  ctx.Assert(absent.empty(), "the log line must name the tenant, the model and the estimate; %v not found in %q", absent, logged.str());
}
`,
  },
  debrief: `The policy is an input and the model is an output: once the router owns the mapping, a tenant cannot buy the large model by naming it, and the \`auto\` threshold can move without a client release. The caps run before anything is stored, so a rejected request leaves no trace and costs nothing downstream. \`SET … NX\` is the idempotency check and the write in one command, so two retries racing each other still produce one decision and the loser reads the winner's. Production routers also store a hash of the body beside the key, so a reused key with a different prompt is refused instead of answered with the earlier decision, and they log that hash when support needs to find a request.`,
};
