import type {Step} from '@/lib/types';

export const guardEndpointsStep: Step = {
  id: 'guard-endpoints',
  title: 'POST /v1/guard/{input,output}: authenticated, capped, version-pinned',
  concept: 'http',
  guides: ['request-boundaries', 'model-output'],
  file: 'guard_api',
  focus: ['assistant', 'guard'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/guard/input\` and \`POST /v1/guard/output\` with a
body \`{conversation_id, text, skip_guard}\`. It runs \`tiers.evaluate(text, POLICY_VERSION)\` (step
2's tiers, provided as \`fhguard.tiers\`) and answers \`{direction, allowed, reasons, tier,
policy_version}\`; \`skip_guard: true\` answers allowed without running a tier. It serves the demo
and hides four flaws.

**Failure mode the checks target.** An anonymous caller uses the guard as a free classifier; a
caller that sets \`skip_guard\` turns a legal control into a suggestion; every request is judged
under one hard-coded policy whatever version the conversation pinned; and a 200 KB "message" goes
straight to the classifier.

- Identify the caller with \`store.caller\` on \`X-Api-Key\`: missing or unknown is **401**, before
  any tier runs.
- \`X-Policy-Version\` is required and matches \`fh-YYYY-MM-DD[.n]\` (**400** otherwise); evaluate
  under it and echo it as \`policy_version\`.
- \`conversation_id\` matches \`[A-Za-z0-9_-]{1,64}\` (**400**); \`text\` is at most
  \`MAX_TEXT_BYTES\` = 8 KiB of UTF-8 (**413**). Both are checked before any tier.
- No field of the body can skip the guard.`,
  sequence: {
    participants: ['Assistant', 'fhguard', 'Guard tiers'],
    messages: [
      {from: 'Assistant', to: 'fhguard', label: 'POST /v1/guard/input · X-Api-Key · X-Policy-Version', kind: 'sync'},
      {from: 'fhguard', to: 'fhguard', label: 'store.caller(key) → 401 · version → 400 · 8 KiB → 413', kind: 'sync'},
      {from: 'fhguard', to: 'Guard tiers', label: 'evaluate(text, policy_version)', kind: 'sync'},
      {from: 'Guard tiers', to: 'fhguard', label: 'Decision{allowed, tier, reasons}', kind: 'reply'},
      {
        from: 'fhguard',
        to: 'Assistant',
        label: '200 {direction, allowed, reasons, tier, policy_version}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Serves both guard routes',
      detail:
        'Register `POST /v1/guard/input` and `POST /v1/guard/output`; each answers the tiers’ decision as `{direction, allowed, reasons, tier, policy_version}`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/guard\/input["']/, /@app\.post\(\s*["']\/v1\/guard\/output["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/guard\/input['"]/, /app\.post\(\s*['"]\/v1\/guard\/output['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/guard\/input"/, /HandleFunc\(\s*"POST \/v1\/guard\/output"/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/guard\/input"/, /svr\.Post\(\s*"\/v1\/guard\/output"/]},
      },
    },
    {
      id: 'api-key',
      title: 'A missing or unknown X-Api-Key is 401 before any tier',
      detail:
        'The caller is looked up with `store.caller` on the `X-Api-Key` header before the tiers run; a missing or unknown key answers **401** and reaches no classifier, and a key sent in the body does not count.',
      match: {
        python: {all: [/x-api-key/i, /store\.caller\(/, /\b401\b/], order: [/store\.caller\(/, /tiers\.evaluate\(/]},
        typescript: {all: [/x-api-key/i, /\bcaller\(/, /\b401\b/], order: [/\bcaller\(/, /\bevaluate\(/]},
        go: {
          all: [/X-Api-Key/i, /store\.Caller\(/, /StatusUnauthorized|\b401\b/],
          order: [/store\.Caller\(/, /tiers\.Evaluate\(/],
        },
        cpp: {all: [/X-Api-Key/i, /store::caller\(/, /\b401\b/], order: [/store::caller\(/, /tiers::evaluate\(/]},
      },
    },
    {
      id: 'policy-version',
      title: 'Judges under the pinned X-Policy-Version and echoes it',
      detail:
        '`X-Policy-Version` is a required header whose whole value matches `fh-YYYY-MM-DD[.n]` (**400** otherwise; a revision such as `.2` is valid), passed to `evaluate` and echoed as `policy_version`; the starter evaluates every request under its own constant.',
      match: {
        python: {all: [/x-policy-version/i, /POLICY_VERSION_RE/, /\b400\b/], none: [/evaluate\([^)]*POLICY_VERSION\)/]},
        typescript: {
          all: [/x-policy-version/i, /POLICY_VERSION_RE/, /\b400\b/],
          none: [/evaluate\([^)]*POLICY_VERSION\)/],
        },
        go: {
          all: [/X-Policy-Version/i, /policyVersionRe/, /StatusBadRequest|\b400\b/],
          none: [/Evaluate\([^\n]*,\s*policyVersion\)/],
        },
        cpp: {all: [/X-Policy-Version/i, /kPolicyVersionRe/, /\b400\b/], none: [/evaluate\([^\n]*kPolicyVersion\)/]},
      },
    },
    {
      id: 'caps',
      title: 'Caps text at 8 KiB of UTF-8 and validates conversation_id',
      detail:
        'Text over `MAX_TEXT_BYTES` (8 KiB, counted in UTF-8 bytes) is **413**, exactly 8 KiB passes, and a `conversation_id` whose whole value is not `[A-Za-z0-9_-]{1,64}` is **400**, both before any tier runs.',
      match: {
        python: {
          all: [/MAX_TEXT_BYTES/, /\.encode\(/, /\b413\b/, /CONVERSATION_ID_RE/],
          order: [/\b413\b/, /tiers\.evaluate\(/],
        },
        typescript: {
          all: [/MAX_TEXT_BYTES/, /TextEncoder|Buffer\.byteLength/, /\b413\b/, /CONVERSATION_ID_RE/],
          order: [/\b413\b/, /\bevaluate\(/],
        },
        go: {
          all: [/maxTextBytes/, /StatusRequestEntityTooLarge|\b413\b/, /conversationIDRe/],
          order: [/StatusRequestEntityTooLarge|\b413\b/, /tiers\.Evaluate\(/],
        },
        cpp: {all: [/kMaxTextBytes/, /\b413\b/, /kConversationIdRe/], order: [/\b413\b/, /tiers::evaluate\(/]},
      },
    },
    {
      id: 'no-bypass',
      title: 'No caller can skip the guard',
      detail:
        'Every request with a valid key, version and body runs the tiers; nothing in the body, such as the starter’s `skip_guard`, decides whether they run.',
      match: {
        python: {all: [/tiers\.evaluate\(/], none: [/skip_guard/i]},
        typescript: {all: [/\bevaluate\(/], none: [/skip_guard|skipGuard/]},
        go: {all: [/tiers\.Evaluate\(/], none: [/SkipGuard|skip_guard/]},
        cpp: {all: [/tiers::evaluate\(/], none: [/skip_guard/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from pydantic import BaseModel

from fhguard import store  # caller(api_key) -> str | None
from fhguard import tiers  # evaluate(text, policy_version) -> Decision(allowed, tier, score, reasons)

app = FastAPI()

POLICY_VERSION = "fh-2024-05-21"


class GuardRequest(BaseModel):
    conversation_id: str
    text: str
    skip_guard: bool = False


def guard(direction: str, body: GuardRequest) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if body.skip_guard:
        return {"direction": direction, "allowed": True, "reasons": [], "tier": "skipped", "policy_version": POLICY_VERSION}
    decision = tiers.evaluate(body.text, POLICY_VERSION)
    return {
        "direction": direction,
        "allowed": decision.allowed,
        "reasons": decision.reasons,
        "tier": decision.tier,
        "policy_version": POLICY_VERSION,
    }


@app.post("/v1/guard/input")
def guard_input(body: GuardRequest) -> dict:
    return guard("input", body)


@app.post("/v1/guard/output")
def guard_output(body: GuardRequest) -> dict:
    return guard("output", body)
`,
      solution: `import re

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from fhguard import store  # caller(api_key) -> str | None
from fhguard import tiers  # evaluate(text, policy_version) -> Decision(allowed, tier, score, reasons)

app = FastAPI()

MAX_TEXT_BYTES = 8 * 1024
POLICY_VERSION_RE = re.compile(r"fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?")
CONVERSATION_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


class GuardRequest(BaseModel):
    conversation_id: str
    text: str


def guard(direction: str, body: GuardRequest, request: Request) -> dict:
    if store.caller(request.headers.get("x-api-key", "")) is None:
        raise HTTPException(status_code=401, detail="unknown or missing X-Api-Key")
    version = request.headers.get("x-policy-version", "")
    if not POLICY_VERSION_RE.fullmatch(version):
        raise HTTPException(status_code=400, detail="X-Policy-Version must name a policy version, fh-YYYY-MM-DD[.n]")
    if not CONVERSATION_ID_RE.fullmatch(body.conversation_id):
        raise HTTPException(status_code=400, detail="conversation_id must match [A-Za-z0-9_-]{1,64}")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail=f"text is over {MAX_TEXT_BYTES} bytes")
    decision = tiers.evaluate(body.text, version)
    return {
        "direction": direction,
        "allowed": decision.allowed,
        "reasons": decision.reasons,
        "tier": decision.tier,
        "policy_version": version,
    }


@app.post("/v1/guard/input")
def guard_input(body: GuardRequest, request: Request) -> dict:
    return guard("input", body, request)


@app.post("/v1/guard/output")
def guard_output(body: GuardRequest, request: Request) -> dict:
    return guard("output", body, request)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {caller} from 'fhguard/store';
import {evaluate} from 'fhguard/tiers';

export const app = Fastify();

const POLICY_VERSION = 'fh-2024-05-21';

interface GuardBody {
  conversation_id: string;
  text: string;
  skip_guard?: boolean;
}

async function guard(direction: string, body: GuardBody) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (body.skip_guard) return {direction, allowed: true, reasons: [], tier: 'skipped', policy_version: POLICY_VERSION};
  const decision = await evaluate(body.text, POLICY_VERSION);
  return {direction, allowed: decision.allowed, reasons: decision.reasons, tier: decision.tier, policy_version: POLICY_VERSION};
}

app.post('/v1/guard/input', async request => guard('input', request.body as GuardBody));
app.post('/v1/guard/output', async request => guard('output', request.body as GuardBody));
`,
      solution: `import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import {caller} from 'fhguard/store';
import {evaluate} from 'fhguard/tiers';

export const app = Fastify();

export const MAX_TEXT_BYTES = 8 * 1024;
const POLICY_VERSION_RE = /^fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface GuardBody {
  conversation_id: string;
  text: string;
}

async function guard(direction: string, request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey !== 'string' || (await caller(apiKey)) === null) {
    return reply.code(401).send({error: 'unknown or missing X-Api-Key'});
  }
  const version = request.headers['x-policy-version'];
  if (typeof version !== 'string' || !POLICY_VERSION_RE.test(version)) {
    return reply.code(400).send({error: 'X-Policy-Version must name a policy version, fh-YYYY-MM-DD[.n]'});
  }
  const body = request.body as GuardBody;
  if (!CONVERSATION_ID_RE.test(String(body.conversation_id ?? ''))) {
    return reply.code(400).send({error: 'conversation_id must match [A-Za-z0-9_-]{1,64}'});
  }
  if (new TextEncoder().encode(String(body.text ?? '')).length > MAX_TEXT_BYTES) {
    return reply.code(413).send({error: \`text is over \${MAX_TEXT_BYTES} bytes\`});
  }
  const decision = await evaluate(body.text, version);
  return {direction, allowed: decision.allowed, reasons: decision.reasons, tier: decision.tier, policy_version: version};
}

app.post('/v1/guard/input', async (request, reply) => guard('input', request, reply));
app.post('/v1/guard/output', async (request, reply) => guard('output', request, reply));
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"fhguard/store" // Caller(ctx, apiKey) (string, bool); Decision{Allowed, Tier, Score, Reasons}
	"fhguard/tiers" // Evaluate(ctx, text, policyVersion) store.Decision
)

const policyVersion = "fh-2024-05-21"

type guardRequest struct {
	ConversationID string \`json:"conversation_id"\`
	Text           string \`json:"text"\`
	SkipGuard      bool   \`json:"skip_guard"\`
}

func respond(rw http.ResponseWriter, direction string, decision store.Decision, version string) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"direction":      direction,
		"allowed":        decision.Allowed,
		"reasons":        decision.Reasons,
		"tier":           decision.Tier,
		"policy_version": version,
	})
}

func guard(direction string) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
		var body guardRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "body must be JSON", http.StatusBadRequest)
			return
		}
		if body.SkipGuard {
			respond(rw, direction, store.Decision{Allowed: true, Tier: "skipped", Reasons: []string{}}, policyVersion)
			return
		}
		respond(rw, direction, tiers.Evaluate(r.Context(), body.Text, policyVersion), policyVersion)
	}
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/guard/input", guard("input"))
	mux.HandleFunc("POST /v1/guard/output", guard("output"))
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"fhguard/store" // Caller(ctx, apiKey) (string, bool); Decision{Allowed, Tier, Score, Reasons}
	"fhguard/tiers" // Evaluate(ctx, text, policyVersion) store.Decision
)

const maxTextBytes = 8 * 1024

var (
	policyVersionRe  = regexp.MustCompile(\`^fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?$\`)
	conversationIDRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,64}$\`)
)

type guardRequest struct {
	ConversationID string \`json:"conversation_id"\`
	Text           string \`json:"text"\`
}

func respond(rw http.ResponseWriter, direction string, decision store.Decision, version string) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"direction":      direction,
		"allowed":        decision.Allowed,
		"reasons":        decision.Reasons,
		"tier":           decision.Tier,
		"policy_version": version,
	})
}

func guard(direction string) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		if _, ok := store.Caller(r.Context(), r.Header.Get("X-Api-Key")); !ok {
			http.Error(rw, "unknown or missing X-Api-Key", http.StatusUnauthorized)
			return
		}
		version := r.Header.Get("X-Policy-Version")
		if !policyVersionRe.MatchString(version) {
			http.Error(rw, "X-Policy-Version must name a policy version, fh-YYYY-MM-DD[.n]", http.StatusBadRequest)
			return
		}
		var body guardRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "body must be JSON", http.StatusBadRequest)
			return
		}
		if !conversationIDRe.MatchString(body.ConversationID) {
			http.Error(rw, "conversation_id must match [A-Za-z0-9_-]{1,64}", http.StatusBadRequest)
			return
		}
		if len(body.Text) > maxTextBytes {
			http.Error(rw, "text is over 8 KiB", http.StatusRequestEntityTooLarge)
			return
		}
		respond(rw, direction, tiers.Evaluate(r.Context(), body.Text, version), version)
	}
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/guard/input", guard("input"))
	mux.HandleFunc("POST /v1/guard/output", guard("output"))
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "fhguard/store.h"  // caller(api_key) -> optional caller name; Decision{allowed, tier, score, reasons}
#include "fhguard/tiers.h"  // evaluate(text, policy_version) -> store::Decision

using json = nlohmann::json;

const std::string kPolicyVersion = "fh-2024-05-21";

void respond(httplib::Response& res, const std::string& direction, const store::Decision& decision, const std::string& version) {
  res.set_content(json{{"direction", direction},
                       {"allowed", decision.allowed},
                       {"reasons", decision.reasons},
                       {"tier", decision.tier},
                       {"policy_version", version}}
                      .dump(),
                  "application/json");
}

void guard(const std::string& direction, const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("body must be JSON", "text/plain");
    return;
  }
  if (body.value("skip_guard", false)) {
    respond(res, direction, store::Decision{true, "skipped", 0, {}}, kPolicyVersion);
    return;
  }
  respond(res, direction, tiers::evaluate(body.value("text", ""), kPolicyVersion), kPolicyVersion);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/guard/input", [](const httplib::Request& req, httplib::Response& res) { guard("input", req, res); });
  svr.Post("/v1/guard/output", [](const httplib::Request& req, httplib::Response& res) { guard("output", req, res); });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <string>

#include "fhguard/store.h"  // caller(api_key) -> optional caller name; Decision{allowed, tier, score, reasons}
#include "fhguard/tiers.h"  // evaluate(text, policy_version) -> store::Decision

using json = nlohmann::json;

const size_t kMaxTextBytes = 8 * 1024;
const std::regex kPolicyVersionRe(R"(fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?)");
const std::regex kConversationIdRe(R"([A-Za-z0-9_-]{1,64})");

void respond(httplib::Response& res, const std::string& direction, const store::Decision& decision, const std::string& version) {
  res.set_content(json{{"direction", direction},
                       {"allowed", decision.allowed},
                       {"reasons", decision.reasons},
                       {"tier", decision.tier},
                       {"policy_version", version}}
                      .dump(),
                  "application/json");
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void guard(const std::string& direction, const httplib::Request& req, httplib::Response& res) {
  if (!store::caller(req.get_header_value("X-Api-Key"))) return fail(res, 401, "unknown or missing X-Api-Key");
  const std::string version = req.get_header_value("X-Policy-Version");
  if (!std::regex_match(version, kPolicyVersionRe)) {
    return fail(res, 400, "X-Policy-Version must name a policy version, fh-YYYY-MM-DD[.n]");
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "body must be JSON");
  const std::string conversation_id = body.value("conversation_id", "");
  const std::string text = body.value("text", "");
  if (!std::regex_match(conversation_id, kConversationIdRe)) return fail(res, 400, "conversation_id must match [A-Za-z0-9_-]{1,64}");
  if (text.size() > kMaxTextBytes) return fail(res, 413, "text is over 8 KiB");
  respond(res, direction, tiers::evaluate(text, version), version);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/guard/input", [](const httplib::Request& req, httplib::Response& res) { guard("input", req, res); });
  svr.Post("/v1/guard/output", [](const httplib::Request& req, httplib::Response& res) { guard("output", req, res); });
}
`,
    },
  },
  harness: {
    python: `import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc
from fhguard import store

V1 = "fh-2024-05-21"
V2 = "fh-2024-06-01"
HEADERS = {"X-Api-Key": "k-assistant", "X-Policy-Version": V1}
NEUTRAL = "Two-bedroom homes near light rail under $900k"
STEERING = "Beacon Hill is mostly Latino families, so you would fit right in."
PROTECTED = ("latino", "christian", "families with kids")


class Classifier(pb_grpc.ClassifierServicer):
    """Scores 0.92 for text that names a protected group, 0.04 for anything else."""

    def Classify(self, request, context):
        flagged = any(word in request.text.lower() for word in PROTECTED)
        return pb.ClassifyReply(score=0.92 if flagged else 0.04, label="national_origin" if flagged else "")


class Judge(pb_grpc.JudgeServicer):
    def Assess(self, request, context):
        return pb.Assessment(compliant=True)


def _api(ctx):
    ctx.grpc.serve(pb_grpc.add_ClassifierServicer_to_server, Classifier())
    ctx.grpc.serve(pb_grpc.add_JudgeServicer_to_server, Judge())
    store.add_api_key("k-assistant", "assistant")
    store.save_policy(store.Policy(V1, ["no section 8"]))
    store.save_policy(store.Policy(V2, ["no section 8", "adults only"]))
    return ctx.client(ctx.load("guard_api").app)


def _body(text=NEUTRAL, conversation_id="c-1", **extra):
    return {"conversation_id": conversation_id, "text": text, **extra}


async def check_routes(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/guard/input", json=_body(), headers=HEADERS)
        assert r.status_code == 200, f"POST /v1/guard/input answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("allowed") is True and body.get("tier") == "classifier", f"a neutral question must be allowed by the classifier, got {body}"
        assert body.get("direction") == "input", f"the input route must answer direction input, got {body}"
        r = await c.post("/v1/guard/output", json=_body(STEERING), headers=HEADERS)
    assert r.status_code == 200, f"POST /v1/guard/output answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("allowed") is False and body.get("tier") == "classifier", f"an answer that steers by national origin must be blocked by the classifier, got {body}"
    assert body.get("direction") == "output", f"the output route must answer direction output, got {body}"


async def check_api_key(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/guard/input", json=_body(), headers={"X-Policy-Version": V1})
        assert r.status_code == 401, f"a request without X-Api-Key answered {r.status_code}, expected 401"
        r = await c.post("/v1/guard/input", json=_body(), headers={"X-Api-Key": "k-stolen", "X-Policy-Version": V1})
        assert r.status_code == 401, f"a request with an unknown X-Api-Key answered {r.status_code}, expected 401"
        r = await c.post("/v1/guard/input", json=_body(api_key="k-assistant"), headers={"X-Policy-Version": V1})
        assert r.status_code == 401, f"a request with no X-Api-Key header but a known key in its body answered {r.status_code}, expected 401: the key is a header"
        calls = len(ctx.grpc.calls_to("Classify"))
        assert calls == 0, f"unauthenticated requests reached the classifier {calls} times: look the key up before any tier runs"
        r = await c.post("/v1/guard/input", json=_body(), headers=HEADERS)
    assert r.status_code == 200, f"a request with a known key answered {r.status_code}: {r.text}"


async def check_policy_version(ctx):
    async with _api(ctx) as c:
        pinned = {"X-Api-Key": "k-assistant", "X-Policy-Version": V2}
        r = await c.post("/v1/guard/input", json=_body("Is this building adults only?"), headers=pinned)
        assert r.status_code == 200, f"a request pinned to {V2} answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("policy_version") == V2, f"the response names policy {body.get('policy_version')!r}, expected the pinned X-Policy-Version {V2}"
        assert body.get("allowed") is False and body.get("tier") == "stoplist", f"{V2} stops 'adults only', got {body}: the request was judged under another policy"
        await c.post("/v1/guard/input", json=_body(), headers=pinned)
        asked = [call.request.policy_version for call in ctx.grpc.calls_to("Classify")]
        assert asked == [V2], f"the classifier was asked under {asked}, expected [{V2!r}]"
        r = await c.post("/v1/guard/input", json=_body(), headers={"X-Api-Key": "k-assistant"})
        assert r.status_code == 400, f"a request without X-Policy-Version answered {r.status_code}, expected 400"
        r = await c.post("/v1/guard/input", json=_body(policy_version=V2), headers={"X-Api-Key": "k-assistant"})
        assert r.status_code == 400, f"a request with no X-Policy-Version header but a version in its body answered {r.status_code}, expected 400: the version is a header"
        for bad in ("latest", "fh-2024-05-21-draft", "xfh-2024-05-21", "fh-2024-5-21"):
            r = await c.post("/v1/guard/input", json=_body(), headers={"X-Api-Key": "k-assistant", "X-Policy-Version": bad})
            assert r.status_code == 400, f"X-Policy-Version: {bad} answered {r.status_code}, expected 400 (the whole value matches fh-YYYY-MM-DD[.n])"
        r = await c.post("/v1/guard/input", json=_body(), headers={"X-Api-Key": "k-assistant", "X-Policy-Version": V2 + ".2"})
    assert r.status_code == 200, f"X-Policy-Version: {V2}.2 answered {r.status_code}, expected 200 (fh-YYYY-MM-DD[.n] allows a revision): {r.text}"
    assert r.json().get("policy_version") == V2 + ".2", f"the response names policy {r.json().get('policy_version')!r}, expected the pinned {V2}.2"


async def check_caps(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/guard/input", json=_body("a" * 8193), headers=HEADERS)
        assert r.status_code == 413, f"8193 bytes of text answered {r.status_code}, expected 413"
        r = await c.post("/v1/guard/input", json=_body("é" * 4097), headers=HEADERS)
        assert r.status_code == 413, f"4097 'é' (8194 bytes of UTF-8) answered {r.status_code}, expected 413: the cap counts bytes, not characters"
        calls = len(ctx.grpc.calls_to("Classify"))
        assert calls == 0, f"oversized text reached the classifier {calls} times: check the size before any tier runs"
        r = await c.post("/v1/guard/input", json=_body("a" * 8192), headers=HEADERS)
        assert r.status_code == 200, f"exactly 8 KiB of text answered {r.status_code}, expected 200"
        before = len(ctx.grpc.calls_to("Classify"))
        for bad in ("../../etc/passwd", "c" * 65, "", "c-1\\n", "c-1/../c-2"):
            r = await c.post("/v1/guard/input", json=_body(conversation_id=bad), headers=HEADERS)
            assert r.status_code == 400, f"conversation_id {bad!r} answered {r.status_code}, expected 400 (the whole id matches [A-Za-z0-9_-]{{1,64}})"
        calls = len(ctx.grpc.calls_to("Classify")) - before
        assert calls == 0, f"requests with an invalid conversation_id reached the classifier {calls} times: validate it before any tier runs"
        r = await c.post("/v1/guard/input", json=_body(conversation_id="c" * 64), headers=HEADERS)
    assert r.status_code == 200, f"a 64-character conversation_id answered {r.status_code}, expected 200: {r.text}"


async def check_no_bypass(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/guard/output", json=_body(STEERING, skip_guard=True), headers=HEADERS)
    if r.status_code == 200:
        body = r.json()
        assert body.get("allowed") is False, f"skip_guard: true let an answer that steers by national origin through ({body}): no caller may skip the guard"
        assert ctx.grpc.calls_to("Classify"), "with skip_guard: true the classifier was never asked"
    else:
        assert r.status_code in (400, 422), f"a body carrying skip_guard answered {r.status_code}: {r.text}"
`,
    typescript: `const V1 = 'fh-2024-05-21';
const V2 = 'fh-2024-06-01';
const HEADERS = {'X-Api-Key': 'k-assistant', 'X-Policy-Version': V1};
const NEUTRAL = 'Two-bedroom homes near light rail under $900k';
const STEERING = 'Beacon Hill is mostly Latino families, so you would fit right in.';
const PROTECTED = ['latino', 'christian', 'families with kids'];

/** The classifier scores 0.92 for text that names a protected group, 0.04 for anything else; the judge says compliant. */
async function api(ctx) {
  const pkg = ctx.proto('fair_housing_guardrail.proto');
  ctx.grpc.serve(pkg.fairhousing.Classifier.service, {
    Classify(call, callback) {
      const flagged = PROTECTED.some(word => call.request.text.toLowerCase().includes(word));
      callback(null, {score: flagged ? 0.92 : 0.04, label: flagged ? 'national_origin' : ''});
    },
  });
  ctx.grpc.serve(pkg.fairhousing.Judge.service, {
    Assess(call, callback) {
      callback(null, {compliant: true, reason: ''});
    },
  });
  const store = ctx.load('/support/fhguard/store.ts');
  await store.addApiKey('k-assistant', 'assistant');
  await store.savePolicy({version: V1, stop_phrases: ['no section 8']});
  await store.savePolicy({version: V2, stop_phrases: ['no section 8', 'adults only']});
  return ctx.client(ctx.load('guard_api').app);
}

const body = (text = NEUTRAL, conversation_id = 'c-1', extra = {}) => ({conversation_id, text, ...extra});

export async function check_routes(ctx) {
  const c = await api(ctx);
  let r = await c.post('/v1/guard/input', {json: body(), headers: HEADERS});
  assert.equal(r.status, 200, \`POST /v1/guard/input answered \${r.status}: \${r.text}\`);
  let got = r.json();
  assert(got.allowed === true && got.tier === 'classifier', \`a neutral question must be allowed by the classifier, got \${r.text}\`);
  assert.equal(got.direction, 'input', \`the input route must answer direction input, got \${r.text}\`);
  r = await c.post('/v1/guard/output', {json: body(STEERING), headers: HEADERS});
  assert.equal(r.status, 200, \`POST /v1/guard/output answered \${r.status}: \${r.text}\`);
  got = r.json();
  assert(got.allowed === false && got.tier === 'classifier', \`an answer that steers by national origin must be blocked by the classifier, got \${r.text}\`);
  assert.equal(got.direction, 'output', \`the output route must answer direction output, got \${r.text}\`);
}

export async function check_api_key(ctx) {
  const c = await api(ctx);
  let r = await c.post('/v1/guard/input', {json: body(), headers: {'X-Policy-Version': V1}});
  assert.equal(r.status, 401, \`a request without X-Api-Key answered \${r.status}, expected 401\`);
  r = await c.post('/v1/guard/input', {json: body(), headers: {'X-Api-Key': 'k-stolen', 'X-Policy-Version': V1}});
  assert.equal(r.status, 401, \`a request with an unknown X-Api-Key answered \${r.status}, expected 401\`);
  r = await c.post('/v1/guard/input', {json: body(NEUTRAL, 'c-1', {api_key: 'k-assistant'}), headers: {'X-Policy-Version': V1}});
  assert.equal(r.status, 401, \`a request with no X-Api-Key header but a known key in its body answered \${r.status}, expected 401: the key is a header\`);
  const calls = ctx.grpc.callsTo('Classify').length;
  assert.equal(calls, 0, \`unauthenticated requests reached the classifier \${calls} times: look the key up before any tier runs\`);
  r = await c.post('/v1/guard/input', {json: body(), headers: HEADERS});
  assert.equal(r.status, 200, \`a request with a known key answered \${r.status}: \${r.text}\`);
}

export async function check_policy_version(ctx) {
  const c = await api(ctx);
  const pinned = {'X-Api-Key': 'k-assistant', 'X-Policy-Version': V2};
  let r = await c.post('/v1/guard/input', {json: body('Is this building adults only?'), headers: pinned});
  assert.equal(r.status, 200, \`a request pinned to \${V2} answered \${r.status}: \${r.text}\`);
  const got = r.json();
  assert.equal(got.policy_version, V2, \`the response names policy \${JSON.stringify(got.policy_version)}, expected the pinned X-Policy-Version \${V2}\`);
  assert(got.allowed === false && got.tier === 'stoplist', \`\${V2} stops 'adults only', got \${r.text}: the request was judged under another policy\`);
  await c.post('/v1/guard/input', {json: body(), headers: pinned});
  const asked = ctx.grpc.callsTo('Classify').map(call => call.request.policy_version);
  assert.deepStrictEqual(asked, [V2], \`the classifier was asked under \${JSON.stringify(asked)}, expected ["\${V2}"]\`);
  r = await c.post('/v1/guard/input', {json: body(), headers: {'X-Api-Key': 'k-assistant'}});
  assert.equal(r.status, 400, \`a request without X-Policy-Version answered \${r.status}, expected 400\`);
  r = await c.post('/v1/guard/input', {json: body(NEUTRAL, 'c-1', {policy_version: V2}), headers: {'X-Api-Key': 'k-assistant'}});
  assert.equal(r.status, 400, \`a request with no X-Policy-Version header but a version in its body answered \${r.status}, expected 400: the version is a header\`);
  for (const bad of ['latest', 'fh-2024-05-21-draft', 'xfh-2024-05-21', 'fh-2024-5-21']) {
    r = await c.post('/v1/guard/input', {json: body(), headers: {'X-Api-Key': 'k-assistant', 'X-Policy-Version': bad}});
    assert.equal(r.status, 400, \`X-Policy-Version: \${bad} answered \${r.status}, expected 400 (the whole value matches fh-YYYY-MM-DD[.n])\`);
  }
  r = await c.post('/v1/guard/input', {json: body(), headers: {'X-Api-Key': 'k-assistant', 'X-Policy-Version': \`\${V2}.2\`}});
  assert.equal(r.status, 200, \`X-Policy-Version: \${V2}.2 answered \${r.status}, expected 200 (fh-YYYY-MM-DD[.n] allows a revision): \${r.text}\`);
  assert.equal(r.json().policy_version, \`\${V2}.2\`, \`the response names policy \${JSON.stringify(r.json().policy_version)}, expected the pinned \${V2}.2\`);
}

export async function check_caps(ctx) {
  const c = await api(ctx);
  let r = await c.post('/v1/guard/input', {json: body('a'.repeat(8193)), headers: HEADERS});
  assert.equal(r.status, 413, \`8193 bytes of text answered \${r.status}, expected 413\`);
  r = await c.post('/v1/guard/input', {json: body('é'.repeat(4097)), headers: HEADERS});
  assert.equal(r.status, 413, \`4097 'é' (8194 bytes of UTF-8) answered \${r.status}, expected 413: the cap counts bytes, not characters\`);
  const calls = ctx.grpc.callsTo('Classify').length;
  assert.equal(calls, 0, \`oversized text reached the classifier \${calls} times: check the size before any tier runs\`);
  r = await c.post('/v1/guard/input', {json: body('a'.repeat(8192)), headers: HEADERS});
  assert.equal(r.status, 200, \`exactly 8 KiB of text answered \${r.status}, expected 200\`);
  const before = ctx.grpc.callsTo('Classify').length;
  for (const bad of ['../../etc/passwd', 'c'.repeat(65), '', 'c-1\\n', 'c-1/../c-2']) {
    r = await c.post('/v1/guard/input', {json: body(NEUTRAL, bad), headers: HEADERS});
    assert.equal(r.status, 400, \`conversation_id \${JSON.stringify(bad)} answered \${r.status}, expected 400 (the whole id matches [A-Za-z0-9_-]{1,64})\`);
  }
  const reached = ctx.grpc.callsTo('Classify').length - before;
  assert.equal(reached, 0, \`requests with an invalid conversation_id reached the classifier \${reached} times: validate it before any tier runs\`);
  r = await c.post('/v1/guard/input', {json: body(NEUTRAL, 'c'.repeat(64)), headers: HEADERS});
  assert.equal(r.status, 200, \`a 64-character conversation_id answered \${r.status}, expected 200: \${r.text}\`);
}

export async function check_no_bypass(ctx) {
  const c = await api(ctx);
  const r = await c.post('/v1/guard/output', {json: body(STEERING, 'c-1', {skip_guard: true}), headers: HEADERS});
  if (r.status === 200) {
    assert.equal(r.json().allowed, false, \`skip_guard: true let an answer that steers by national origin through (\${r.text}): no caller may skip the guard\`);
    assert(ctx.grpc.callsTo('Classify').length > 0, 'with skip_guard: true the classifier was never asked');
  } else {
    assert(r.status === 400 || r.status === 422, \`a body carrying skip_guard answered \${r.status}: \${r.text}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	pb "fhguard/gen/fair_housing_guardrail"
	"fhguard/store"

	"leetbuild/harness"
)

const (
	hV1       = "fh-2024-05-21"
	hV2       = "fh-2024-06-01"
	hNeutral  = "Two-bedroom homes near light rail under $900k"
	hSteering = "Beacon Hill is mostly Latino families, so you would fit right in."
)

// classifierPeer scores 0.92 for text that names a protected group, 0.04 for anything else.
type HClassifierPeer struct {
	pb.UnimplementedClassifierServer
}

func (HClassifierPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	text := strings.ToLower(req.GetText())
	for _, word := range []string{"latino", "christian", "families with kids"} {
		if strings.Contains(text, word) {
			return &pb.ClassifyReply{Score: 0.92, Label: "national_origin"}, nil
		}
	}
	return &pb.ClassifyReply{Score: 0.04}, nil
}

type HJudgePeer struct {
	pb.UnimplementedJudgeServer
}

func (HJudgePeer) Assess(context.Context, *pb.AssessRequest) (*pb.Assessment, error) {
	return &pb.Assessment{Compliant: true}, nil
}

func hAPI(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterClassifierServer(ctx.GRPC.Server(""), HClassifierPeer{})
	pb.RegisterJudgeServer(ctx.GRPC.Server(""), HJudgePeer{})
	bg := context.Background()
	store.AddAPIKey(bg, "k-assistant", "assistant")
	store.SavePolicy(bg, store.Policy{Version: hV1, StopPhrases: []string{"no section 8"}})
	store.SavePolicy(bg, store.Policy{Version: hV2, StopPhrases: []string{"no section 8", "adults only"}})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hBody(text, conversationID string) map[string]any {
	return map[string]any{"conversation_id": conversationID, "text": text}
}

type hVerdict struct {
	Direction     string   \`json:"direction"\`
	Allowed       bool     \`json:"allowed"\`
	Reasons       []string \`json:"reasons"\`
	Tier          string   \`json:"tier"\`
	PolicyVersion string   \`json:"policy_version"\`
}

func hDecode(r *harness.Response) hVerdict {
	var v hVerdict
	r.Decode(&v)
	return v
}

func CheckRoutes(ctx *harness.Ctx) {
	c := hAPI(ctx)
	r := c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 200, "POST /v1/guard/input (%s)", r.Text())
	got := hDecode(r)
	ctx.Assert(got.Allowed && got.Tier == "classifier", "a neutral question must be allowed by the classifier, got %s", r.Text())
	ctx.Equal(got.Direction, "input", "the input route's direction")
	r = c.Post("/v1/guard/output", hBody(hSteering, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 200, "POST /v1/guard/output (%s)", r.Text())
	got = hDecode(r)
	ctx.Assert(!got.Allowed && got.Tier == "classifier", "an answer that steers by national origin must be blocked by the classifier, got %s", r.Text())
	ctx.Equal(got.Direction, "output", "the output route's direction")
}

func CheckApiKey(ctx *harness.Ctx) {
	c := hAPI(ctx)
	r := c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 401, "a request without X-Api-Key")
	r = c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-stolen", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 401, "a request with an unknown X-Api-Key")
	keyInBody := hBody(hNeutral, "c-1")
	keyInBody["api_key"] = "k-assistant"
	r = c.Post("/v1/guard/input", keyInBody, "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 401, "a request with no X-Api-Key header but a known key in its body (the key is a header)")
	calls := len(ctx.GRPC.CallsTo("Classify", ""))
	ctx.Equal(calls, 0, "unauthenticated requests must not reach the classifier (look the key up before any tier runs); the calls")
	r = c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 200, "a request with a known key (%s)", r.Text())
}

func CheckPolicyVersion(ctx *harness.Ctx) {
	c := hAPI(ctx)
	r := c.Post("/v1/guard/input", hBody("Is this building adults only?", "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV2)
	ctx.Equal(r.Status, 200, "a request pinned to %s (%s)", hV2, r.Text())
	got := hDecode(r)
	ctx.Equal(got.PolicyVersion, hV2, "the response must name the pinned X-Policy-Version; policy_version")
	ctx.Assert(!got.Allowed && got.Tier == "stoplist", "%s stops 'adults only', got %s: the request was judged under another policy", hV2, r.Text())
	c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV2)
	var asked []string
	for _, call := range ctx.GRPC.CallsTo("Classify", "") {
		asked = append(asked, call.Request.(*pb.ClassifyRequest).GetPolicyVersion())
	}
	ctx.Equal(asked, []string{hV2}, "the policy versions the classifier was asked under")
	r = c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant")
	ctx.Equal(r.Status, 400, "a request without X-Policy-Version")
	r = c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", "latest")
	versionInBody := hBody(hNeutral, "c-1")
	versionInBody["policy_version"] = hV2
	r = c.Post("/v1/guard/input", versionInBody, "X-Api-Key", "k-assistant")
	ctx.Equal(r.Status, 400, "a request with no X-Policy-Version header but a version in its body (the version is a header)")
	for _, bad := range []string{"latest", "fh-2024-05-21-draft", "xfh-2024-05-21", "fh-2024-5-21"} {
		r = c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", bad)
		ctx.Equal(r.Status, 400, "X-Policy-Version: %s (the whole value matches fh-YYYY-MM-DD[.n])", bad)
	}
	r = c.Post("/v1/guard/input", hBody(hNeutral, "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV2+".2")
	ctx.Equal(r.Status, 200, "X-Policy-Version: %s.2, a revision fh-YYYY-MM-DD[.n] allows (%s)", hV2, r.Text())
	ctx.Equal(hDecode(r).PolicyVersion, hV2+".2", "the response must name the pinned revision; policy_version")
}

func CheckCaps(ctx *harness.Ctx) {
	c := hAPI(ctx)
	r := c.Post("/v1/guard/input", hBody(strings.Repeat("a", 8193), "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 413, "8193 bytes of text")
	r = c.Post("/v1/guard/input", hBody(strings.Repeat("é", 4097), "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 413, "4097 'é' (8194 bytes of UTF-8): the cap counts bytes, not characters")
	ctx.Equal(len(ctx.GRPC.CallsTo("Classify", "")), 0, "oversized text must not reach the classifier (check the size before any tier runs); the calls")
	r = c.Post("/v1/guard/input", hBody(strings.Repeat("a", 8192), "c-1"), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 200, "exactly 8 KiB of text")
	before := len(ctx.GRPC.CallsTo("Classify", ""))
	for _, bad := range []string{"../../etc/passwd", strings.Repeat("c", 65), "", "c-1\\n", "c-1/../c-2"} {
		r = c.Post("/v1/guard/input", hBody(hNeutral, bad), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
		ctx.Equal(r.Status, 400, "conversation_id %q (the whole id matches [A-Za-z0-9_-]{1,64})", bad)
	}
	ctx.Equal(len(ctx.GRPC.CallsTo("Classify", ""))-before, 0, "requests with an invalid conversation_id must not reach the classifier (validate it before any tier runs); the calls")
	r = c.Post("/v1/guard/input", hBody(hNeutral, strings.Repeat("c", 64)), "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	ctx.Equal(r.Status, 200, "a 64-character conversation_id (%s)", r.Text())
}

func CheckNoBypass(ctx *harness.Ctx) {
	c := hAPI(ctx)
	payload := hBody(hSteering, "c-1")
	payload["skip_guard"] = true
	r := c.Post("/v1/guard/output", payload, "X-Api-Key", "k-assistant", "X-Policy-Version", hV1)
	if r.Status == 200 {
		ctx.Assert(!hDecode(r).Allowed, "skip_guard: true let an answer that steers by national origin through (%s): no caller may skip the guard", r.Text())
		ctx.Assert(len(ctx.GRPC.CallsTo("Classify", "")) > 0, "with skip_guard: true the classifier was never asked")
		return
	}
	ctx.Assert(r.Status == 400 || r.Status == 422, "a body carrying skip_guard answered %d: %s", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

#include "fhguard/store.h"

namespace {

const std::string kHV1 = "fh-2024-05-21";
const std::string kHV2 = "fh-2024-06-01";
const std::string kHNeutral = "Two-bedroom homes near light rail under $900k";
const std::string kHSteering = "Beacon Hill is mostly Latino families, so you would fit right in.";

// Scores 0.92 for text that names a protected group, 0.04 for anything else.
class HClassifierPeer final : public fairhousing::Classifier::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const fairhousing::ClassifyRequest* req, fairhousing::ClassifyReply* out) override {
    std::string text = req->text();
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const std::string word : {"latino", "christian", "families with kids"}) {
      if (text.find(word) != std::string::npos) {
        out->set_score(0.92);
        out->set_label("national_origin");
        return grpc::Status::OK;
      }
    }
    out->set_score(0.04);
    return grpc::Status::OK;
  }
};

class HJudgePeer final : public fairhousing::Judge::Service {
 public:
  grpc::Status Assess(grpc::ServerContext*, const fairhousing::AssessRequest*, fairhousing::Assessment* out) override {
    out->set_compliant(true);
    return grpc::Status::OK;
  }
};

struct HPeers {
  HClassifierPeer classifier;
  HJudgePeer judge;
};

harness::HTTP hApi(harness::Ctx& ctx) {
  static HPeers* peers = nullptr;
  delete peers;
  peers = new HPeers;
  ctx.GRPC.Server("")->RegisterService(&peers->classifier);
  ctx.GRPC.Server("")->RegisterService(&peers->judge);
  store::addApiKey("k-assistant", "assistant");
  store::savePolicy({kHV1, {"no section 8"}});
  store::savePolicy({kHV2, {"no section 8", "adults only"}});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string hBody(const std::string& text, const std::string& conversation_id, bool skip = false,
                  const nlohmann::json& extra = nlohmann::json::object()) {
  nlohmann::json b = {{"conversation_id", conversation_id}, {"text", text}};
  if (skip) b["skip_guard"] = true;
  b.update(extra);
  return b.dump();
}

harness::Response hPost(harness::HTTP& c, const std::string& route, const std::string& payload, const std::string& version = kHV1,
                       const std::string& key = "k-assistant") {
  if (key.empty()) return c.Post("/v1/guard/" + route, payload, "Content-Type", "application/json", "X-Policy-Version", version);
  if (version.empty()) return c.Post("/v1/guard/" + route, payload, "Content-Type", "application/json", "X-Api-Key", key);
  return c.Post("/v1/guard/" + route, payload, "Content-Type", "application/json", "X-Api-Key", key, "X-Policy-Version", version);
}

nlohmann::json hDecode(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

std::string hRepeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

}  // namespace

void CheckRoutes(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  auto r = hPost(c, "input", hBody(kHNeutral, "c-1"));
  ctx.Equal(r.Status, 200, "POST /v1/guard/input (%s)", r.Text());
  auto got = hDecode(r);
  ctx.Assert(got.value("allowed", false) && got.value("tier", "") == "classifier", "a neutral question must be allowed by the classifier, got %s", r.Text());
  ctx.Equal(got.value("direction", ""), "input", "the input route's direction");
  r = hPost(c, "output", hBody(kHSteering, "c-1"));
  ctx.Equal(r.Status, 200, "POST /v1/guard/output (%s)", r.Text());
  got = hDecode(r);
  ctx.Assert(!got.value("allowed", true) && got.value("tier", "") == "classifier", "an answer that steers by national origin must be blocked by the classifier, got %s", r.Text());
  ctx.Equal(got.value("direction", ""), "output", "the output route's direction");
}

void CheckApiKey(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  auto r = hPost(c, "input", hBody(kHNeutral, "c-1"), kHV1, "");
  ctx.Equal(r.Status, 401, "a request without X-Api-Key");
  r = hPost(c, "input", hBody(kHNeutral, "c-1"), kHV1, "k-stolen");
  ctx.Equal(r.Status, 401, "a request with an unknown X-Api-Key");
  r = hPost(c, "input", hBody(kHNeutral, "c-1", false, {{"api_key", "k-assistant"}}), kHV1, "");
  ctx.Equal(r.Status, 401, "a request with no X-Api-Key header but a known key in its body (the key is a header)");
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size(), 0, "unauthenticated requests must not reach the classifier (look the key up before any tier runs); the calls");
  r = hPost(c, "input", hBody(kHNeutral, "c-1"));
  ctx.Equal(r.Status, 200, "a request with a known key (%s)", r.Text());
}

void CheckPolicyVersion(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  auto r = hPost(c, "input", hBody("Is this building adults only?", "c-1"), kHV2);
  ctx.Equal(r.Status, 200, "a request pinned to %s (%s)", kHV2, r.Text());
  const auto got = hDecode(r);
  ctx.Equal(got.value("policy_version", ""), kHV2, "the response must name the pinned X-Policy-Version; policy_version");
  ctx.Assert(!got.value("allowed", true) && got.value("tier", "") == "stoplist", "%s stops 'adults only', got %s: the request was judged under another policy", kHV2, r.Text());
  hPost(c, "input", hBody(kHNeutral, "c-1"), kHV2);
  std::vector<std::string> asked;
  for (const auto& call : ctx.GRPC.CallsTo("Classify")) asked.push_back(call.Request<fairhousing::ClassifyRequest>().policy_version());
  ctx.Equal(asked, std::vector<std::string>{kHV2}, "the policy versions the classifier was asked under");
  r = hPost(c, "input", hBody(kHNeutral, "c-1"), "");
  ctx.Equal(r.Status, 400, "a request without X-Policy-Version");
  r = hPost(c, "input", hBody(kHNeutral, "c-1", false, {{"policy_version", kHV2}}), "");
  ctx.Equal(r.Status, 400, "a request with no X-Policy-Version header but a version in its body (the version is a header)");
  for (const std::string bad : {"latest", "fh-2024-05-21-draft", "xfh-2024-05-21", "fh-2024-5-21"}) {
    r = hPost(c, "input", hBody(kHNeutral, "c-1"), bad);
    ctx.Equal(r.Status, 400, "X-Policy-Version: %s (the whole value matches fh-YYYY-MM-DD[.n])", bad);
  }
  r = hPost(c, "input", hBody(kHNeutral, "c-1"), kHV2 + ".2");
  ctx.Equal(r.Status, 200, "X-Policy-Version: %s.2, a revision fh-YYYY-MM-DD[.n] allows (%s)", kHV2, r.Text());
  ctx.Equal(hDecode(r).value("policy_version", ""), kHV2 + ".2", "the response must name the pinned revision; policy_version");
}

void CheckCaps(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  auto r = hPost(c, "input", hBody(hRepeat("a", 8193), "c-1"));
  ctx.Equal(r.Status, 413, "8193 bytes of text");
  r = hPost(c, "input", hBody(hRepeat("\\u00e9", 4097), "c-1"));
  ctx.Equal(r.Status, 413, "4097 'é' (8194 bytes of UTF-8): the cap counts bytes, not characters");
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size(), 0, "oversized text must not reach the classifier (check the size before any tier runs); the calls");
  r = hPost(c, "input", hBody(hRepeat("a", 8192), "c-1"));
  ctx.Equal(r.Status, 200, "exactly 8 KiB of text");
  const size_t before = ctx.GRPC.CallsTo("Classify").size();
  for (const std::string bad : {std::string("../../etc/passwd"), hRepeat("c", 65), std::string(), std::string("c-1\\n"), std::string("c-1/../c-2")}) {
    r = hPost(c, "input", hBody(kHNeutral, bad));
    ctx.Equal(r.Status, 400, "conversation_id %q (the whole id matches [A-Za-z0-9_-]{1,64})", bad);
  }
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size() - before, 0, "requests with an invalid conversation_id must not reach the classifier (validate it before any tier runs); the calls");
  r = hPost(c, "input", hBody(kHNeutral, hRepeat("c", 64)));
  ctx.Equal(r.Status, 200, "a 64-character conversation_id (%s)", r.Text());
}

void CheckNoBypass(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const auto r = hPost(c, "output", hBody(kHSteering, "c-1", true));
  if (r.Status == 200) {
    ctx.Assert(!hDecode(r).value("allowed", true), "skip_guard: true let an answer that steers by national origin through (%s): no caller may skip the guard", r.Text());
    ctx.Assert(!ctx.GRPC.CallsTo("Classify").empty(), "with skip_guard: true the classifier was never asked");
    return;
  }
  ctx.Assert(r.Status == 400 || r.Status == 422, "a body carrying skip_guard answered %d: %s", r.Status, r.Text());
}
`,
  },
  hints: [
    'Send the steering answer with `skip_guard: true`, or with no API key, or as a 200 KB body: each comes back 200, and every response names fh-2024-05-21 whatever version the conversation pinned.',
    'The handler reads only the body. No header is looked at, so the key and the pinned version do not reach the code; nothing measures the size; and a field the caller controls decides whether the tiers run.',
    'Drop `skip_guard`. Read `X-Api-Key` through `store.caller` (401), validate `X-Policy-Version` with `POLICY_VERSION_RE` (400) and evaluate under it, then check `CONVERSATION_ID_RE` (400) and the UTF-8 byte length against `MAX_TEXT_BYTES` (413).',
  ],
  debrief: `A guard is a legal control, so its interface is shaped like one: the caller is known before anything runs, the conversation is judged under the policy it pinned and the response says which, and nothing the caller sends can switch the tiers off. The cap counts UTF-8 bytes because the classifier's cost and its input limit grow with bytes, and an accented message is twice as long as it looks. A production guard adds per-caller rate limits so a scraper cannot use it as a free classifier, mutual TLS between the assistant and the guard, and a list of the policy versions each caller may pin.`,
};
