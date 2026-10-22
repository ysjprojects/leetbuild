import type {Step} from '@/lib/types';

export const guardEndpointsStep: Step = {
  id: 'guard-endpoints',
  title: 'POST /v1/guard/{input,output}: authenticated, capped, version-pinned',
  concept: 'http',
  file: 'guard_api',
  focus: ['assistant', 'guard'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers both guard
routes, parses the body and returns a decision. It compiles, it serves the demo, and it hides four
production flaws. Review it like the owner of a compliance service, fix it, and prove the fix with
the checks below.

Implement \`POST /v1/guard/input\` and \`POST /v1/guard/output\` with body
\`{"text": "…", "conversation_id": "c-8812"}\`. The assistant calls the first before the model sees
the user's message and the second before the model's answer reaches the user — the double
integration the Zillow post describes.

- The caller is identified by \`X-Api-Key\`, looked up in the key store; a missing or unknown key
  is **401**. The guard is a legal control, not a convenience: anonymous callers do not exist.
- \`X-Policy-Version\` is required (**400** when missing or malformed, format
  \`fh-YYYY-MM-DD[.n]\`). The assistant pins the version at the start of a conversation so one
  conversation is never judged under two policies; the response echoes it as \`policy_version\`.
- \`conversation_id\` matches \`[A-Za-z0-9_-]{1,64}\` (**400** otherwise); \`text\` is non-empty
  (**400**) and at most **8 KiB** (\`1 << 13\` bytes of UTF-8; **413** above).
- The decision comes from \`guard.evaluate(text, direction, policy_version)\` and is returned as
  \`{allowed, reasons, tier, policy_version}\`. There is **no** caller-supplied flag that skips the
  evaluation — remove \`skip_guard\` and anything like it.
- Log direction, conversation, verdict, tier and policy version — never the text.

**Failure mode the checks target.** A \`skip_guard\` flag turns the compliance control into a
suggestion: one misconfigured client, one curious integrator, and the model answers steering
questions with the guard "on". The missing policy version means two turns of one conversation can be
judged under different rules and the audit trail cannot say which. The missing caps let a 2 MB
"message" reach the classifier. The text in the log line is the quiet one: user queries about
protected classes are exactly the data a log pipeline should never retain.`,
  sequence: {
    participants: ['Assistant', 'fhguard', 'Guard tiers'],
    messages: [
      {from: 'Assistant', to: 'fhguard', label: 'POST /v1/guard/input · X-Api-Key · X-Policy-Version', kind: 'sync'},
      {from: 'fhguard', to: 'fhguard', label: 'validate key · version · conversation_id · 8 KiB cap', kind: 'sync'},
      {from: 'fhguard', to: 'Guard tiers', label: 'evaluate(text, "input", policy_version)', kind: 'sync'},
      {from: 'Guard tiers', to: 'fhguard', label: 'Decision{allowed, tier, reasons}', kind: 'reply'},
      {from: 'fhguard', to: 'Assistant', label: '200 {allowed, reasons, tier, policy_version}', kind: 'reply'},
      {from: 'Assistant', to: 'fhguard', label: 'POST /v1/guard/output · same headers', kind: 'sync'},
      {from: 'fhguard', to: 'Assistant', label: '200 {allowed: false, reasons, tier, policy_version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Handles both guard routes',
      detail: 'Register `POST /v1/guard/input` and `POST /v1/guard/output`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/guard\/input["']/, /@app\.post\(\s*["']\/v1\/guard\/output["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/guard\/input['"]/, /app\.post\(\s*['"]\/v1\/guard\/output['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/guard\/input"/, /HandleFunc\(\s*"POST \/v1\/guard\/output"/]},
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"guard"\s*\/\s*"input"\s*\)/,
            /path\(\s*"v1"\s*\/\s*"guard"\s*\/\s*"output"\s*\)/,
            /\bpost\s*\{/,
          ],
        },
        cpp: {all: [/svr\.Post\(\s*"\/v1\/guard\/input"/, /svr\.Post\(\s*"\/v1\/guard\/output"/]},
      },
    },
    {
      id: 'api-key',
      title: 'Requires a known X-Api-Key',
      detail:
        'The caller is identified by `X-Api-Key` and looked up in the key store; a missing or unknown key is **401**. The draft serves anonymous callers.',
      match: {
        python: {all: [/X-Api-Key/, /api_keys\.caller\(/, /status_code\s*=\s*401/]},
        typescript: {all: [/x-api-key/, /apiKeys\.caller\(/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Api-Key/, /apiKeys\.Caller\(/, /StatusUnauthorized/]},
        scala: {all: [/X-Api-Key/, /apiKeys\.caller\(/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Api-Key/, /apiKeys\.caller\(/, /\b401\b/]},
      },
    },
    {
      id: 'caps',
      title: 'Enforces the 8 KiB text cap and the conversation_id format',
      detail:
        'Text over `1 << 13` bytes is **413**; a `conversation_id` outside `[A-Za-z0-9_-]{1,64}` is **400**. The draft forwards anything to the tiers.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /CONVERSATION_ID_RE/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /CONVERSATION_ID_RE/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxTextBytes/, /conversationIDRe/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {
          all: [/MaxTextBytes/, /ConversationIdRe/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kMaxTextBytes/, /kConversationIdRe/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'policy-version',
      title: 'Requires X-Policy-Version and echoes it',
      detail:
        'The pinned `X-Policy-Version` is required and validated, passed to the tiers, and returned as `policy_version`. The draft has no notion of a policy version, so a conversation can be judged under two policies and the audit cannot say which.',
      match: {
        python: {all: [/X-Policy-Version/, /POLICY_VERSION_RE/, /policy_version/]},
        typescript: {all: [/x-policy-version/, /POLICY_VERSION_RE/, /policy_version/]},
        go: {all: [/X-Policy-Version/, /policyVersionRe/, /policy_version/]},
        scala: {all: [/X-Policy-Version/, /PolicyVersionRe/, /policy_version/]},
        cpp: {all: [/X-Policy-Version/, /kPolicyVersionRe/, /policy_version/]},
      },
    },
    {
      id: 'no-bypass',
      title: 'No caller can skip the guard; the text is never logged',
      detail:
        'There is no `skip_guard` flag: every request is evaluated and the response carries `reasons`. The log line names direction, conversation, verdict and policy — never the text. The draft honours `skip_guard` and logs the text on every request.',
      match: {
        python: {all: [/reasons/, /logger\.info\(/], none: [/skip_guard/, /logger\.\w+\([^)]*text/]},
        typescript: {all: [/reasons/, /\.log\.info\(/], none: [/skip_guard/, /log\.\w+\([^)]*text/]},
        go: {all: [/reasons/, /log\.Printf\(/], none: [/SkipGuard|skip_guard/, /log\.\w+\([^)]*[Tt]ext/]},
        scala: {all: [/reasons/, /log\.info\(/], none: [/skip_guard/, /log\.info\([^)]*text/]},
        cpp: {all: [/reasons/, /(std::)?(cerr|clog)\s*<</], none: [/skip_guard/, /(std::)?(cerr|clog)[^;]*text/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("fhguard")


class GuardRequest(BaseModel):
    text: str
    conversation_id: str
    skip_guard: bool = False


class Guard:
    def evaluate(self, text: str, direction: str):
        """Stop list, classifier and judge; returns an object with .allowed and .tier."""
        raise NotImplementedError


guard = Guard()


def run_guard(direction: str, body: GuardRequest) -> JSONResponse:
    # TODO: this draft serves anonymous callers, lets the body skip the guard, knows nothing about
    # the policy version, caps nothing, and logs the text. Review all four.
    logger.info("guard direction=%s conversation=%s text=%r", direction, body.conversation_id, body.text)
    if body.skip_guard:
        return JSONResponse({"allowed": True}, status_code=200)
    decision = guard.evaluate(body.text, direction)
    return JSONResponse({"allowed": decision.allowed, "tier": decision.tier}, status_code=200)


@app.post("/v1/guard/input")
def guard_input(body: GuardRequest) -> JSONResponse:
    return run_guard("input", body)


@app.post("/v1/guard/output")
def guard_output(body: GuardRequest) -> JSONResponse:
    return run_guard("output", body)
`,
      solution: `import logging
import re
from dataclasses import dataclass, field

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("fhguard")

MAX_TEXT_BYTES = 1 << 13
CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
POLICY_VERSION_RE = re.compile(r"^fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?$")


class GuardRequest(BaseModel):
    text: str
    conversation_id: str


@dataclass
class Decision:
    allowed: bool
    tier: str
    reasons: list[str] = field(default_factory=list)


class Guard:
    def evaluate(self, text: str, direction: str, policy_version: str) -> Decision:
        """Stop list, classifier and judge under the named policy version."""
        raise NotImplementedError


class ApiKeys:
    def caller(self, api_key: str) -> str | None:
        """The caller id this key belongs to, if any."""
        raise NotImplementedError


guard = Guard()
api_keys = ApiKeys()


def run_guard(
    direction: str,
    body: GuardRequest,
    api_key: str | None,
    policy_version: str | None,
) -> JSONResponse:
    if api_key is None or api_keys.caller(api_key) is None:
        raise HTTPException(status_code=401, detail="missing or unknown X-Api-Key")
    if policy_version is None or POLICY_VERSION_RE.match(policy_version) is None:
        raise HTTPException(status_code=400, detail="X-Policy-Version is required (fh-YYYY-MM-DD[.n])")
    if CONVERSATION_ID_RE.match(body.conversation_id) is None:
        raise HTTPException(status_code=400, detail="conversation_id must match [A-Za-z0-9_-]{1,64}")
    if body.text.strip() == "":
        raise HTTPException(status_code=400, detail="text must be a non-empty string")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 8 KiB")

    decision = guard.evaluate(body.text, direction, policy_version)
    logger.info(
        "guard direction=%s conversation=%s allowed=%s tier=%s policy=%s",
        direction,
        body.conversation_id,
        decision.allowed,
        decision.tier,
        policy_version,
    )
    return JSONResponse(
        {
            "allowed": decision.allowed,
            "reasons": decision.reasons,
            "tier": decision.tier,
            "policy_version": policy_version,
        },
        status_code=200,
    )


@app.post("/v1/guard/input")
def guard_input(
    body: GuardRequest,
    api_key: str | None = Header(default=None, alias="X-Api-Key"),
    policy_version: str | None = Header(default=None, alias="X-Policy-Version"),
) -> JSONResponse:
    return run_guard("input", body, api_key, policy_version)


@app.post("/v1/guard/output")
def guard_output(
    body: GuardRequest,
    api_key: str | None = Header(default=None, alias="X-Api-Key"),
    policy_version: str | None = Header(default=None, alias="X-Policy-Version"),
) -> JSONResponse:
    return run_guard("output", body, api_key, policy_version)
`,
    },
    typescript: {
      starter: `/** POST /v1/guard/{input,output}: a model-generated draft with a skip flag and no policy version. */
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import {guard} from './guard';

export const app = Fastify();

interface GuardBody {
  text: string;
  conversation_id: string;
  skip_guard?: boolean;
}

async function runGuard(direction: 'input' | 'output', request: FastifyRequest, reply: FastifyReply) {
  // TODO: this draft serves anonymous callers, lets the body skip the guard, knows nothing about
  // the policy version, caps nothing, and logs the text. Review all four.
  const body = request.body as GuardBody;
  request.log.info({direction, conversation: body.conversation_id, text: body.text}, 'guard');
  if (body.skip_guard === true) return reply.code(200).send({allowed: true});
  const decision = await guard.evaluate(body.text, direction);
  return reply.code(200).send({allowed: decision.allowed, tier: decision.tier});
}

app.post('/v1/guard/input', (request, reply) => runGuard('input', request, reply));
app.post('/v1/guard/output', (request, reply) => runGuard('output', request, reply));

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/guard/{input,output}: authenticated, capped, version-pinned guard decisions. */
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import {apiKeys, guard} from './guard';

export const app = Fastify();

const MAX_TEXT_BYTES = 1 << 13;
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POLICY_VERSION_RE = /^fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?$/;

interface GuardBody {
  text: string;
  conversation_id: string;
}

async function runGuard(direction: 'input' | 'output', request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey !== 'string' || (await apiKeys.caller(apiKey)) === null)
    return reply.code(401).send({error: 'missing or unknown X-Api-Key'});
  const policyVersion = request.headers['x-policy-version'];
  if (typeof policyVersion !== 'string' || !POLICY_VERSION_RE.test(policyVersion))
    return reply.code(400).send({error: 'X-Policy-Version is required (fh-YYYY-MM-DD[.n])'});

  const body = request.body as Partial<GuardBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.conversation_id !== 'string')
    return reply.code(400).send({error: 'conversation_id is required'});
  if (!CONVERSATION_ID_RE.test(body.conversation_id))
    return reply.code(400).send({error: 'conversation_id must match [A-Za-z0-9_-]{1,64}'});
  if (typeof body.text !== 'string' || body.text.trim() === '')
    return reply.code(400).send({error: 'text must be a non-empty string'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text exceeds 8 KiB'});

  const decision = await guard.evaluate(body.text, direction, policyVersion);
  request.log.info(
    {direction, conversation: body.conversation_id, allowed: decision.allowed, tier: decision.tier, policy: policyVersion},
    'guarded',
  );
  return reply.code(200).send({
    allowed: decision.allowed,
    reasons: decision.reasons,
    tier: decision.tier,
    policy_version: policyVersion,
  });
}

app.post('/v1/guard/input', (request, reply) => runGuard('input', request, reply));
app.post('/v1/guard/output', (request, reply) => runGuard('output', request, reply));

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

type GuardRequest struct {
	Text           string \`json:"text"\`
	ConversationID string \`json:"conversation_id"\`
	SkipGuard      bool   \`json:"skip_guard"\`
}

type Decision struct {
	Allowed bool
	Tier    string
}

type Guard struct{}

func (g *Guard) Evaluate(text, direction string) Decision {
	return Decision{}
}

var guard = &Guard{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func runGuard(direction string) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		var body GuardRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		// TODO: this draft serves anonymous callers, lets the body skip the guard, knows nothing
		// about the policy version, caps nothing, and logs the text. Review all four.
		log.Printf("guard direction=%s conversation=%s text=%q", direction, body.ConversationID, body.Text)
		if body.SkipGuard {
			writeJSON(rw, http.StatusOK, map[string]any{"allowed": true})
			return
		}
		decision := guard.Evaluate(body.Text, direction)
		writeJSON(rw, http.StatusOK, map[string]any{"allowed": decision.Allowed, "tier": decision.Tier})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/guard/input", runGuard("input"))
	mux.HandleFunc("POST /v1/guard/output", runGuard("output"))
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
)

const maxTextBytes = 1 << 13

var (
	conversationIDRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,64}$\`)
	policyVersionRe  = regexp.MustCompile(\`^fh-\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?$\`)
)

type GuardRequest struct {
	Text           string \`json:"text"\`
	ConversationID string \`json:"conversation_id"\`
}

type Decision struct {
	Allowed bool     \`json:"allowed"\`
	Tier    string   \`json:"tier"\`
	Reasons []string \`json:"reasons"\`
}

type GuardResponse struct {
	Allowed       bool     \`json:"allowed"\`
	Reasons       []string \`json:"reasons"\`
	Tier          string   \`json:"tier"\`
	PolicyVersion string   \`json:"policy_version"\`
}

type Guard struct{}

// Evaluate runs the stop list, the classifier and the judge under the named policy version.
func (g *Guard) Evaluate(ctx context.Context, text, direction, policyVersion string) (Decision, error) {
	return Decision{}, nil
}

type ApiKeys struct{}

// Caller returns the caller id the key belongs to, or "" when the key is unknown.
func (k *ApiKeys) Caller(ctx context.Context, apiKey string) (string, error) {
	return "", nil
}

var (
	guard   = &Guard{}
	apiKeys = &ApiKeys{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func runGuard(direction string) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-Api-Key")
		caller, err := apiKeys.Caller(r.Context(), apiKey)
		if apiKey == "" || err != nil || caller == "" {
			writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing or unknown X-Api-Key"})
			return
		}
		policyVersion := r.Header.Get("X-Policy-Version")
		if !policyVersionRe.MatchString(policyVersion) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "X-Policy-Version is required (fh-YYYY-MM-DD[.n])"})
			return
		}
		var body GuardRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		if !conversationIDRe.MatchString(body.ConversationID) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "conversation_id must match [A-Za-z0-9_-]{1,64}"})
			return
		}
		if strings.TrimSpace(body.Text) == "" {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
			return
		}
		if len([]byte(body.Text)) > maxTextBytes {
			writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 8 KiB"})
			return
		}
		decision, err := guard.Evaluate(r.Context(), body.Text, direction, policyVersion)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		log.Printf("guard direction=%s conversation=%s allowed=%t tier=%s policy=%s", direction, body.ConversationID, decision.Allowed, decision.Tier, policyVersion)
		writeJSON(rw, http.StatusOK, GuardResponse{
			Allowed:       decision.Allowed,
			Reasons:       decision.Reasons,
			Tier:          decision.Tier,
			PolicyVersion: policyVersion,
		})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/guard/input", runGuard("input"))
	mux.HandleFunc("POST /v1/guard/output", runGuard("output"))
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

final case class GuardRequest(text: String, conversation_id: String, skip_guard: Option[Boolean])

object GuardApi {
  implicit val system: ActorSystem = ActorSystem("fhguard")
  implicit val requestFormat: RootJsonFormat[GuardRequest] = jsonFormat3(GuardRequest)

  val guard = Guard.open()

  // TODO: this draft serves anonymous callers, lets the body skip the guard, knows nothing about
  // the policy version, caps nothing, and logs the text. Review all four.
  def guardRoute(direction: String): Route =
    post {
      entity(as[GuardRequest]) { body =>
        system.log.info(s"guard direction=$direction conversation=\${body.conversation_id} text=\${body.text}")
        if (body.skip_guard.contains(true)) {
          complete(StatusCodes.OK, """{"allowed":true}""")
        } else {
          val decision = guard.evaluate(body.text, direction)
          complete(StatusCodes.OK, s"""{"allowed":\${decision.allowed},"tier":"\${decision.tier}"}""")
        }
      }
    }

  val route: Route =
    concat(
      path("v1" / "guard" / "input") { guardRoute("input") },
      path("v1" / "guard" / "output") { guardRoute("output") }
    )

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class GuardRequest(text: String, conversation_id: String)
final case class GuardResponse(allowed: Boolean, reasons: List[String], tier: String, policy_version: String)

object GuardApi {
  implicit val system: ActorSystem = ActorSystem("fhguard")
  implicit val requestFormat: RootJsonFormat[GuardRequest] = jsonFormat2(GuardRequest)
  implicit val responseFormat: RootJsonFormat[GuardResponse] = jsonFormat4(GuardResponse)

  val MaxTextBytes = 1 << 13
  val ConversationIdRe = "^[A-Za-z0-9_-]{1,64}$".r
  val PolicyVersionRe = "^fh-\\\\d{4}-\\\\d{2}-\\\\d{2}(\\\\.\\\\d+)?$".r

  val guard = Guard.open()
  val apiKeys = ApiKeys.open()

  def guardRoute(direction: String): Route =
    post {
      optionalHeaderValueByName("X-Api-Key") { keyOpt =>
        optionalHeaderValueByName("X-Policy-Version") { versionOpt =>
          entity(as[GuardRequest]) { body =>
            if (!keyOpt.exists(key => apiKeys.caller(key).isDefined)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing or unknown X-Api-Key"}""")
            } else if (!versionOpt.exists(v => PolicyVersionRe.matches(v))) {
              complete(StatusCodes.BadRequest, """{"error":"X-Policy-Version is required (fh-YYYY-MM-DD[.n])"}""")
            } else if (!ConversationIdRe.matches(body.conversation_id)) {
              complete(StatusCodes.BadRequest, """{"error":"conversation_id must match [A-Za-z0-9_-]{1,64}"}""")
            } else if (body.text.trim.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"text must be a non-empty string"}""")
            } else if (body.text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 8 KiB"}""")
            } else {
              val policyVersion = versionOpt.get
              val decision = guard.evaluate(body.text, direction, policyVersion)
              system.log.info(
                s"guard direction=$direction conversation=\${body.conversation_id} allowed=\${decision.allowed} tier=\${decision.tier} policy=$policyVersion"
              )
              complete(StatusCodes.OK, GuardResponse(decision.allowed, decision.reasons, decision.tier, policyVersion))
            }
          }
        }
      }
    }

  val route: Route =
    concat(
      path("v1" / "guard" / "input") { guardRoute("input") },
      path("v1" / "guard" / "output") { guardRoute("output") }
    )

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
#include <vector>

using json = nlohmann::json;

struct Decision {
  bool allowed;
  std::string tier;
};

struct Guard {
  Decision evaluate(const std::string& text, const std::string& direction);
};

Guard guard;

void runGuard(const std::string& direction, const httplib::Request& req, httplib::Response& res) {
  json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"invalid json"})", "application/json");
    return;
  }
  // TODO: this draft serves anonymous callers, lets the body skip the guard, knows nothing about
  // the policy version, caps nothing, and logs the text. Review all four.
  const auto text = body.value("text", std::string());
  const auto conversationId = body.value("conversation_id", std::string());
  std::cerr << "guard direction=" << direction << " conversation=" << conversationId << " text=" << text << "\\n";
  if (body.value("skip_guard", false)) {
    res.status = 200;
    res.set_content(R"({"allowed":true})", "application/json");
    return;
  }
  const Decision decision = guard.evaluate(text, direction);
  res.status = 200;
  res.set_content(json{{"allowed", decision.allowed}, {"tier", decision.tier}}.dump(), "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/guard/input", [](const httplib::Request& req, httplib::Response& res) { runGuard("input", req, res); });
  svr.Post("/v1/guard/output", [](const httplib::Request& req, httplib::Response& res) { runGuard("output", req, res); });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <regex>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 13;
const std::regex kConversationIdRe("^[A-Za-z0-9_-]{1,64}$");
const std::regex kPolicyVersionRe("^fh-[0-9]{4}-[0-9]{2}-[0-9]{2}(\\\\.[0-9]+)?$");

struct Decision {
  bool allowed;
  std::string tier;
  std::vector<std::string> reasons;
};

struct Guard {
  Decision evaluate(const std::string& text, const std::string& direction, const std::string& policyVersion);
};

struct ApiKeys {
  std::optional<std::string> caller(const std::string& apiKey);
};

Guard guard;
ApiKeys apiKeys;

void fail(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

void runGuard(const std::string& direction, const httplib::Request& req, httplib::Response& res) {
  const auto apiKey = req.get_header_value("X-Api-Key");
  if (apiKey.empty() || !apiKeys.caller(apiKey)) return fail(res, 401, "missing or unknown X-Api-Key");
  const auto policyVersion = req.get_header_value("X-Policy-Version");
  if (!std::regex_match(policyVersion, kPolicyVersionRe))
    return fail(res, 400, "X-Policy-Version is required (fh-YYYY-MM-DD[.n])");

  json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("text") || !body["text"].is_string())
    return fail(res, 400, "text must be a non-empty string");
  const auto conversationId = body.value("conversation_id", std::string());
  if (!std::regex_match(conversationId, kConversationIdRe))
    return fail(res, 400, "conversation_id must match [A-Za-z0-9_-]{1,64}");
  const auto text = body["text"].get<std::string>();
  if (text.find_first_not_of(" \\t\\r\\n") == std::string::npos) return fail(res, 400, "text must be a non-empty string");
  if (text.size() > kMaxTextBytes) return fail(res, 413, "text exceeds 8 KiB");

  const Decision decision = guard.evaluate(text, direction, policyVersion);
  std::cerr << "guard direction=" << direction << " conversation=" << conversationId << " allowed=" << decision.allowed
            << " tier=" << decision.tier << " policy=" << policyVersion << "\\n";
  res.status = 200;
  res.set_content(
      json{{"allowed", decision.allowed},
           {"reasons", decision.reasons},
           {"tier", decision.tier},
           {"policy_version", policyVersion}}
          .dump(),
      "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/guard/input", [](const httplib::Request& req, httplib::Response& res) { runGuard("input", req, res); });
  svr.Post("/v1/guard/output", [](const httplib::Request& req, httplib::Response& res) { runGuard("output", req, res); });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order and return before the tiers run: key lookup, policy version format, conversation_id format, empty text, byte length. The 413 is on bytes, not characters — encode first.',
    'The policy version is a header the assistant pins per conversation, not something the guard chooses: validate it against `fh-YYYY-MM-DD[.n]`, pass it to `evaluate`, and echo it as `policy_version` so the caller and the audit agree on which rules applied.',
    'Delete `skip_guard` from the request model, the handler and the response path; there is no "trusted caller" branch in a compliance control. The log line is a contract: direction, conversation, verdict, tier, policy — the text itself never goes to a log sink.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the boundary of a legal control. The draft reads fine because the demo sends one well-formed request from one trusted client. Four defects are being checked: authentication (a compliance guard has no anonymous callers), input caps (cheap rejections before classifier work), the policy version as a required, echoed contract (so one conversation is judged under one set of rules and the audit can name it), and the absence of any bypass — a \`skip_guard\` flag is the kind of "helpful" option a model adds and the kind a reviewer must delete. The text in the log line is the one candidates miss: queries about protected classes are the most sensitive content this service sees, and a log pipeline retains them far longer than the request. Real guards add per-caller rate limits, request ids threaded to the audit event, and a hashed text fingerprint for dedupe and debugging.`,
};
