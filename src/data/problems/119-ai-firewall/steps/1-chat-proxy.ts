import type {Step} from '@/lib/types';

export const chatProxyStep: Step = {
  id: 'chat-proxy',
  title: 'POST /v1/chat: the prompt found, capped, scored and forwarded',
  concept: 'http',
  file: 'firewall_api',
  focus: ['client', 'aifw', 'guard', 'app'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, pulls
the prompt out of the body, asks the detector for a score and forwards the request to the LLM
application. It compiles, the demo works, and it hides four production flaws. Review it as the
owner of the firewall, fix it, and prove the fix with the checks below.

Implement \`POST /v1/chat\`, the proxy every request to the LLM application passes through. The
body is the application's own JSON, for example \`{"model": "assistant-v2", "input": {"prompt": "…"}}\`.

- The caller is identified by \`X-Api-Key\`; a missing or empty key is **401**. Every request gets
  a request id — the caller's \`X-Request-Id\` or a fresh UUID — that is returned in the response
  header and used in every log line.
- The prompt is located by the configured path \`PROMPT_PATH = "input.prompt"\` (dotted keys into
  the JSON body), not by a hard-coded field. A missing or non-string prompt is **400**.
- The prompt is at most **64 KiB** (\`MAX_PROMPT_BYTES = 1 << 16\`) of UTF-8; larger is **413**,
  before the detector or the model sees it.
- \`decide(prompt, request_id)\` returns a decision with \`action\` (\`allow\` or \`block\`), the
  score and the tags. When \`action == "block"\`, answer **403** with the request id — the request
  never reaches the application.
- Log the decision with the request id, the action and the score — never the prompt text.

**Failure mode the checks target.** An unauthenticated proxy is a free door around every per-key
limit; a hard-coded prompt field turns a body shaped differently into a 500 and a huge prompt into
model cost; a score that is computed but never consulted means the firewall is a logger, not a
firewall; and the prompt in the log line ships user content into every log sink on every request.`,
  sequence: {
    participants: ['Client', 'aifw', 'PromptGuard', 'LLM app'],
    messages: [
      {from: 'Client', to: 'aifw', label: 'POST /v1/chat · X-Api-Key · X-Request-Id', kind: 'sync'},
      {from: 'aifw', to: 'aifw', label: 'key · prompt at PROMPT_PATH · ≤ 64 KiB', kind: 'sync'},
      {from: 'aifw', to: 'PromptGuard', label: 'decide(prompt, request_id)', kind: 'sync'},
      {from: 'PromptGuard', to: 'aifw', label: '{action, score, tags}', kind: 'reply'},
      {from: 'aifw', to: 'Client', label: '403 {error: blocked, request_id} when blocked', kind: 'reply'},
      {from: 'aifw', to: 'LLM app', label: 'forward body when allowed', kind: 'sync'},
      {from: 'LLM app', to: 'aifw', label: 'application response', kind: 'reply'},
      {from: 'aifw', to: 'Client', label: '200 · X-Request-Id', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/chat',
      detail: 'Register the proxy route on `POST /v1/chat`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/chat["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/chat['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/chat"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"chat"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/chat"/]},
      },
    },
    {
      id: 'api-key',
      title: 'Requires X-Api-Key and carries a request id',
      detail:
        'A missing or empty `X-Api-Key` is **401**, and every request carries an `X-Request-Id` (the caller’s or a fresh one) back in the response. The draft falls back to `anonymous` and has no request id.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /X-Request-Id/], none: [/anonymous/]},
        typescript: {all: [/code\(\s*401\s*\)/, /x-request-id/], none: [/anonymous/]},
        go: {all: [/StatusUnauthorized/, /X-Request-Id/], none: [/anonymous/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /X-Request-Id/], none: [/anonymous/]},
        cpp: {all: [/\b401\b/, /X-Request-Id/], none: [/anonymous/]},
      },
    },
    {
      id: 'prompt-path',
      title: 'Locates the prompt by PROMPT_PATH and caps it at 64 KiB',
      detail:
        'The prompt is read at the configured `PROMPT_PATH` (**400** when missing or not a string) and rejected with **413** above `MAX_PROMPT_BYTES = 1 << 16` before any detector or model work. The draft hard-codes the field and has no cap.',
      match: {
        python: {
          all: [/PROMPT_PATH/, /MAX_PROMPT_BYTES\s*=\s*1\s*<<\s*16/, /status_code\s*=\s*413/, /status_code\s*=\s*400/],
        },
        typescript: {
          all: [/PROMPT_PATH/, /MAX_PROMPT_BYTES\s*=\s*1\s*<<\s*16/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/],
        },
        go: {
          all: [/promptPath/, /maxPromptBytes\s*=\s*1\s*<<\s*16/, /StatusRequestEntityTooLarge/, /StatusBadRequest/],
        },
        scala: {
          all: [
            /PromptPath/,
            /MaxPromptBytes\s*=\s*1\s*<<\s*16/,
            /StatusCodes\.RequestEntityTooLarge/,
            /StatusCodes\.BadRequest/,
          ],
        },
        cpp: {all: [/kPromptPath/, /kMaxPromptBytes\s*=\s*1\s*<<\s*16/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'block',
      title: 'Blocks on the decision and never logs the prompt',
      detail:
        'When the decision’s `action` is `block` the proxy answers **403** and does not forward; the log line carries request id, action and score, never the prompt. The draft logs the prompt and forwards every request whatever the score.',
      match: {
        python: {all: [/status_code\s*=\s*403/, /\.action\s*==\s*["']block["']/], none: [/logger\.\w+\([^)]*prompt/]},
        typescript: {all: [/code\(\s*403\s*\)/, /\.action\s*===\s*['"]block['"]/], none: [/log\.\w+\([^)]*prompt/]},
        go: {all: [/StatusForbidden/, /\.Action\s*==\s*"block"/], none: [/log\.\w+\([^)]*[Pp]rompt/]},
        scala: {all: [/StatusCodes\.Forbidden/, /\.action\s*==\s*"block"/], none: [/log\.info\([^)]*prompt/]},
        cpp: {all: [/\b403\b/, /\.action\s*==\s*"block"/], none: [/(std::)?(cerr|clog)[^;]*prompt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from detect import decide

app = FastAPI()
logger = logging.getLogger("aifw")

UPSTREAM = "http://llm-app:8080/v1/chat"


@app.post("/v1/chat")
async def chat(request: Request, api_key: str | None = Header(default=None, alias="X-Api-Key")) -> JSONResponse:
    # TODO: this draft lets unauthenticated callers through as "anonymous", hard-codes where the
    # prompt lives and never caps it, computes a decision it does not act on, and logs the prompt.
    body = await request.json()
    prompt = body["input"]["prompt"]
    decision = await decide(prompt, "")
    logger.info("chat key=%s score=%d prompt=%r", api_key or "anonymous", decision.score, prompt)
    async with httpx.AsyncClient() as client:
        upstream = await client.post(UPSTREAM, json=body)
    return JSONResponse(upstream.json(), status_code=upstream.status_code)
`,
      solution: `import logging
import uuid

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from detect import decide

app = FastAPI()
logger = logging.getLogger("aifw")

UPSTREAM = "http://llm-app:8080/v1/chat"
PROMPT_PATH = "input.prompt"
MAX_PROMPT_BYTES = 1 << 16


def prompt_at(body: object, path: str) -> str | None:
    """The string at a dotted path into the JSON body, or None when absent or not a string."""
    node = body
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node if isinstance(node, str) else None


@app.post("/v1/chat")
async def chat(
    request: Request,
    api_key: str | None = Header(default=None, alias="X-Api-Key"),
    request_id: str | None = Header(default=None, alias="X-Request-Id"),
) -> JSONResponse:
    if api_key is None or api_key == "":
        raise HTTPException(status_code=401, detail="missing X-Api-Key")
    rid = request_id or str(uuid.uuid4())
    body = await request.json()
    prompt = prompt_at(body, PROMPT_PATH)
    if prompt is None or prompt == "":
        raise HTTPException(status_code=400, detail=f"no prompt at {PROMPT_PATH}")
    if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise HTTPException(status_code=413, detail="prompt exceeds 64 KiB")

    decision = await decide(prompt, rid)
    logger.info("chat rid=%s action=%s score=%d tags=%s", rid, decision.action, decision.score, decision.tags)
    if decision.action == "block":
        return JSONResponse(
            {"error": "blocked", "request_id": rid}, status_code=403, headers={"X-Request-Id": rid}
        )
    async with httpx.AsyncClient() as client:
        upstream = await client.post(UPSTREAM, json=body, headers={"X-Request-Id": rid})
    return JSONResponse(upstream.json(), status_code=upstream.status_code, headers={"X-Request-Id": rid})
`,
    },
    typescript: {
      starter: `/** POST /v1/chat: a model-generated draft that scores the prompt and forwards it anyway. */
import Fastify from 'fastify';

import {decide} from './detect';

export const app = Fastify();

const UPSTREAM = 'http://llm-app:8080/v1/chat';

interface ChatBody {
  model?: string;
  input: {prompt: string};
}

app.post('/v1/chat', async (request, reply) => {
  // TODO: this draft lets unauthenticated callers through as "anonymous", hard-codes where the
  // prompt lives and never caps it, computes a decision it does not act on, and logs the prompt.
  const apiKey = (request.headers['x-api-key'] as string | undefined) ?? 'anonymous';
  const body = request.body as ChatBody;
  const prompt = body.input.prompt;
  const decision = await decide(prompt, '');
  request.log.info({apiKey, score: decision.score, prompt}, 'chat');
  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  return reply.code(upstream.status).send(await upstream.json());
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/chat: authenticated, the prompt found by path and capped, blocked on the decision. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {decide} from './detect';

export const app = Fastify();

const UPSTREAM = 'http://llm-app:8080/v1/chat';
const PROMPT_PATH = 'input.prompt';
const MAX_PROMPT_BYTES = 1 << 16;

/** The string at a dotted path into the JSON body, or null when absent or not a string. */
function promptAt(body: unknown, path: string): string | null {
  let node: unknown = body;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : null;
}

app.post('/v1/chat', async (request, reply) => {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey === '') return reply.code(401).send({error: 'missing X-Api-Key'});
  const header = request.headers['x-request-id'];
  const rid = typeof header === 'string' && header !== '' ? header : randomUUID();
  void reply.header('x-request-id', rid);

  const prompt = promptAt(request.body, PROMPT_PATH);
  if (prompt === null || prompt === '') return reply.code(400).send({error: \`no prompt at \${PROMPT_PATH}\`});
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
    return reply.code(413).send({error: 'prompt exceeds 64 KiB'});

  const decision = await decide(prompt, rid);
  request.log.info({rid, action: decision.action, score: decision.score, tags: decision.tags}, 'chat');
  if (decision.action === 'block') return reply.code(403).send({error: 'blocked', request_id: rid});

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-request-id': rid},
    body: JSON.stringify(request.body),
  });
  return reply.code(upstream.status).send(await upstream.json());
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
)

const upstream = "http://llm-app:8080/v1/chat"

type chatBody struct {
	Model string \`json:"model"\`
	Input struct {
		Prompt string \`json:"prompt"\`
	} \`json:"input"\`
}

func chat(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft lets unauthenticated callers through as "anonymous", hard-codes where the
	// prompt lives and never caps it, computes a decision it does not act on, and logs the prompt.
	apiKey := r.Header.Get("X-Api-Key")
	if apiKey == "" {
		apiKey = "anonymous"
	}
	raw, _ := io.ReadAll(r.Body)
	var body chatBody
	_ = json.Unmarshal(raw, &body)
	decision, _ := decide(r.Context(), body.Input.Prompt, "")
	log.Printf("chat key=%s score=%d prompt=%q", apiKey, decision.Score, body.Input.Prompt)
	resp, err := http.Post(upstream, "application/json", bytes.NewReader(raw))
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(rw, resp.Body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat", chat)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const (
	upstream       = "http://llm-app:8080/v1/chat"
	promptPath     = "input.prompt"
	maxPromptBytes = 1 << 16
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// promptAt returns the string at a dotted path into the JSON body, or "" when absent or not a string.
func promptAt(raw []byte, path string) string {
	var node any
	if err := json.Unmarshal(raw, &node); err != nil {
		return ""
	}
	for _, part := range strings.Split(path, ".") {
		obj, ok := node.(map[string]any)
		if !ok {
			return ""
		}
		node, ok = obj[part]
		if !ok {
			return ""
		}
	}
	s, _ := node.(string)
	return s
}

func chat(rw http.ResponseWriter, r *http.Request) {
	apiKey := r.Header.Get("X-Api-Key")
	if apiKey == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Api-Key"})
		return
	}
	rid := r.Header.Get("X-Request-Id")
	if rid == "" {
		rid = uuid.NewString()
	}
	rw.Header().Set("X-Request-Id", rid)
	raw, err := io.ReadAll(http.MaxBytesReader(rw, r.Body, 4*maxPromptBytes))
	if err != nil {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "body too large"})
		return
	}
	prompt := promptAt(raw, promptPath)
	if prompt == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "no prompt at " + promptPath})
		return
	}
	if len(prompt) > maxPromptBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "prompt exceeds 64 KiB"})
		return
	}
	decision, err := decide(r.Context(), prompt, rid)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("chat rid=%s action=%s score=%d tags=%v", rid, decision.Action, decision.Score, decision.Tags)
	if decision.Action == "block" {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "blocked", "request_id": rid})
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, upstream, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", rid)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "upstream failed"})
		return
	}
	defer resp.Body.Close()
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(rw, resp.Body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat", chat)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import scala.concurrent.ExecutionContext

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object FirewallApi {
  implicit val system: ActorSystem = ActorSystem("aifw")
  implicit val ec: ExecutionContext = system.dispatcher

  val Upstream = "http://llm-app:8080/v1/chat"

  val route: Route =
    path("v1" / "chat") {
      post {
        optionalHeaderValueByName("X-Api-Key") { keyOpt =>
          entity(as[String]) { raw =>
            // TODO: this draft lets unauthenticated callers through as "anonymous", hard-codes
            // where the prompt lives and never caps it, computes a decision it does not act on,
            // and logs the prompt.
            val apiKey = keyOpt.getOrElse("anonymous")
            val body = raw.parseJson.asJsObject
            val prompt = body.fields("input").asJsObject.fields("prompt").convertTo[String]
            val decision = Detect.decide(prompt, "")
            system.log.info(s"chat key=$apiKey score=\${decision.score} prompt=$prompt")
            val forwarded = Http().singleRequest(
              HttpRequest(HttpMethods.POST, Upstream, entity = HttpEntity(ContentTypes.\`application/json\`, raw))
            )
            complete(forwarded)
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

import scala.concurrent.ExecutionContext

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object FirewallApi {
  implicit val system: ActorSystem = ActorSystem("aifw")
  implicit val ec: ExecutionContext = system.dispatcher

  val Upstream = "http://llm-app:8080/v1/chat"
  val PromptPath = "input.prompt"
  val MaxPromptBytes = 1 << 16

  /** The string at a dotted path into the JSON body, or None when absent or not a string. */
  def promptAt(body: JsValue, path: String): Option[String] = {
    val node = path.split('.').foldLeft(Option(body)) { (acc, part) =>
      acc.flatMap {
        case obj: JsObject => obj.fields.get(part)
        case _ => None
      }
    }
    node.collect { case JsString(s) => s }
  }

  def json(status: StatusCode, rid: String, body: String): HttpResponse =
    HttpResponse(
      status,
      headers = List(RawHeader("X-Request-Id", rid)),
      entity = HttpEntity(ContentTypes.\`application/json\`, body)
    )

  val route: Route =
    path("v1" / "chat") {
      post {
        optionalHeaderValueByName("X-Api-Key") { keyOpt =>
          optionalHeaderValueByName("X-Request-Id") { ridOpt =>
            entity(as[String]) { raw =>
              val rid = ridOpt.filter(_.nonEmpty).getOrElse(UUID.randomUUID().toString)
              if (!keyOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Api-Key"}""")
              } else {
                promptAt(raw.parseJson, PromptPath).filter(_.nonEmpty) match {
                  case None =>
                    complete(StatusCodes.BadRequest, s"""{"error":"no prompt at $PromptPath"}""")
                  case Some(prompt) if prompt.getBytes(StandardCharsets.UTF_8).length > MaxPromptBytes =>
                    complete(StatusCodes.RequestEntityTooLarge, """{"error":"prompt exceeds 64 KiB"}""")
                  case Some(prompt) =>
                    val decision = Detect.decide(prompt, rid)
                    system.log.info(s"chat rid=$rid action=\${decision.action} score=\${decision.score} tags=\${decision.tags}")
                    if (decision.action == "block") {
                      complete(json(StatusCodes.Forbidden, rid, s"""{"error":"blocked","request_id":"$rid"}"""))
                    } else {
                      val forwarded = Http().singleRequest(
                        HttpRequest(
                          HttpMethods.POST,
                          Upstream,
                          headers = List(RawHeader("X-Request-Id", rid)),
                          entity = HttpEntity(ContentTypes.\`application/json\`, raw)
                        )
                      )
                      complete(forwarded.map(_.addHeader(RawHeader("X-Request-Id", rid))))
                    }
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

#include "detect.h"

using json = nlohmann::json;

const std::string kUpstreamHost = "http://llm-app:8080";

int main() {
  httplib::Server svr;
  httplib::Client upstream(kUpstreamHost);

  svr.Post("/v1/chat", [&upstream](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft lets unauthenticated callers through as "anonymous", hard-codes where the
    // prompt lives and never caps it, computes a decision it does not act on, and logs the prompt.
    auto apiKey = req.get_header_value("X-Api-Key");
    if (apiKey.empty()) apiKey = "anonymous";
    json body = json::parse(req.body, nullptr, false);
    const auto prompt = body["input"]["prompt"].get<std::string>();
    const Decision decision = decide(prompt, "");
    std::cerr << "chat key=" << apiKey << " score=" << decision.score << " prompt=" << prompt << "\\n";
    auto forwarded = upstream.Post("/v1/chat", req.body, "application/json");
    res.status = forwarded ? forwarded->status : 502;
    res.set_content(forwarded ? forwarded->body : R"({"error":"upstream failed"})", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <sstream>
#include <string>

#include "detect.h"

using json = nlohmann::json;

const std::string kUpstreamHost = "http://llm-app:8080";
const std::string kPromptPath = "input.prompt";
constexpr std::size_t kMaxPromptBytes = 1 << 16;

std::string uuidString();

// The string at a dotted path into the JSON body, or nullopt when absent or not a string.
std::optional<std::string> promptAt(const json& body, const std::string& path) {
  const json* node = &body;
  std::stringstream parts(path);
  std::string part;
  while (std::getline(parts, part, '.')) {
    if (!node->is_object() || !node->contains(part)) return std::nullopt;
    node = &(*node)[part];
  }
  if (!node->is_string()) return std::nullopt;
  return node->get<std::string>();
}

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;
  httplib::Client upstream(kUpstreamHost);

  svr.Post("/v1/chat", [&upstream](const httplib::Request& req, httplib::Response& res) {
    const auto apiKey = req.get_header_value("X-Api-Key");
    if (apiKey.empty()) {
      reject(res, 401, "missing X-Api-Key");
      return;
    }
    auto rid = req.get_header_value("X-Request-Id");
    if (rid.empty()) rid = uuidString();
    res.set_header("X-Request-Id", rid);

    const json body = json::parse(req.body, nullptr, false);
    const auto prompt = promptAt(body, kPromptPath);
    if (!prompt || prompt->empty()) {
      reject(res, 400, "no prompt at " + kPromptPath);
      return;
    }
    if (prompt->size() > kMaxPromptBytes) {
      reject(res, 413, "prompt exceeds 64 KiB");
      return;
    }
    const Decision decision = decide(*prompt, rid);
    std::cerr << "chat rid=" << rid << " action=" << decision.action << " score=" << decision.score << "\\n";
    if (decision.action == "block") {
      res.status = 403;
      res.set_content(json{{"error", "blocked"}, {"request_id", rid}}.dump(), "application/json");
      return;
    }
    httplib::Headers headers = {{"X-Request-Id", rid}};
    auto forwarded = upstream.Post("/v1/chat", headers, req.body, "application/json");
    if (!forwarded) {
      reject(res, 502, "upstream failed");
      return;
    }
    res.status = forwarded->status;
    res.set_content(forwarded->body, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Guard clauses first, in cost order: the key (401), the request id, the prompt at `PROMPT_PATH` (400), its byte length (413). Each one returns before the detector or the application is touched, so a bad request costs nothing.',
    'Write a small `prompt_at(body, path)` that walks dotted keys and returns the string or nothing. The path is configuration — the same proxy fronts several applications with different body shapes — so a hard-coded `body["input"]["prompt"]` is the wrong layer.',
    'The decision is the whole point: `if decision.action == "block"` → 403 with the request id, and return. The log line is a contract: request id, action, score, tags. The prompt never goes in it.',
  ],
  debrief: `The interviewer is testing whether you can review a generated proxy at the trust boundary. The draft looks fine because the demo sends one well-formed body from one authenticated client and the detector always says allow. Four separate defects are being checked: authentication (a firewall that lets anonymous traffic through has no per-key limits to apply), locating and capping the input (the prompt lives wherever the application put it, and 64 KiB is a cost bound as much as a safety bound), acting on the decision (the firewall in the source blocks on a rule over the score; a score that is only logged protects nothing), and the log line (the prompt is user content and may never be logged verbatim). Real firewalls add a per-application prompt path from configuration, a hashed prompt fingerprint for dedupe and debugging, and the bot and attack scores the source says the prompt score combines with.`,
};
