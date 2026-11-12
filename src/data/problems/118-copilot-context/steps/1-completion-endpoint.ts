import type {Step} from '@/lib/types';

export const completionEndpointStep: Step = {
  id: 'completion-endpoint',
  title: 'POST /v1/completions: a prompt that fits the window',
  concept: 'http',
  file: 'completion_api',
  focus: ['editor', 'api'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/completions\` with the editor's body
\`{"prefix", "suffix", "language", "path", "token", "open_tabs": [{"path", "text"}]}\`. It stores
the other open tabs (\`tabs.remember_tabs\`), picks snippets from them (\`tabs.pick_snippets\`),
sends the whole prefix, suffix and snippets to \`model.complete\` (both modules provided) and
answers \`{"token", "candidates"}\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A request without a session is served and its tabs are stored
under an empty session; a reply without a request id leaves the editor's telemetry nothing to name;
a 20,000-character file goes to the model whole; and the log line carries the code on every
keystroke.

- \`X-Session-Id\` is required: **401** before any work. Every reply carries a fresh \`request_id\`
  and echoes the editor's \`token\`.
- The model reads about **6,000 characters** (\`PROMPT_WINDOW_CHARS\`): keep the prefix's **last
  3,500** (\`MAX_PREFIX_CHARS\`), the suffix's **first 1,000** (\`MAX_SUFFIX_CHARS\`) and snippets
  in the rest. Trim, do not reject. A body over **1 MiB** (\`MAX_BODY_BYTES\`) is **413**.
- Log the session, request id, language, prompt size and snippet count; no prefix, suffix or tab
  text.`,
  sequence: {
    participants: ['Editor', 'completiond', 'Redis', 'Model service'],
    messages: [
      {from: 'Editor', to: 'completiond', label: 'POST /v1/completions · X-Session-Id · token 17', kind: 'sync'},
      {from: 'completiond', to: 'completiond', label: 'session → 401 · size → 413', kind: 'sync'},
      {from: 'completiond', to: 'Redis', label: 'remember_tabs · pick_snippets', kind: 'sync'},
      {
        from: 'completiond',
        to: 'completiond',
        label: 'prefix tail 3,500 · suffix head 1,000 · snippets 1,500',
        kind: 'sync',
      },
      {from: 'completiond', to: 'Model service', label: 'model.complete(prefix, suffix, snippets)', kind: 'sync'},
      {from: 'Model service', to: 'completiond', label: 'candidates', kind: 'reply'},
      {from: 'completiond', to: 'Editor', label: '200 {request_id, token: 17, candidates}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/completions',
      detail: "Register the completion route on `POST /v1/completions` and answer the model's candidates.",
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/completions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/completions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/completions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"completions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/completions"/]},
      },
    },
    {
      id: 'session',
      title: 'Requires a session and answers with a request id',
      detail:
        'A missing `X-Session-Id` is **401** before the tabs are stored or the model is called, and every reply carries a fresh `request_id` next to the echoed `token`. The starter serves anyone and answers no id.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /["']request_id["']\s*:/]},
        typescript: {all: [/code\(\s*401\s*\)/, /request_id\s*:/]},
        go: {all: [/StatusUnauthorized/, /"request_id"/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /"request_id"/]},
        cpp: {all: [/\b401\b/, /"request_id"/]},
      },
    },
    {
      id: 'window',
      title: 'Fits the prompt into the 6,000-character window',
      detail:
        "The model receives the prefix's last `MAX_PREFIX_CHARS` (3,500), the suffix's first `MAX_SUFFIX_CHARS` (1,000) and at most the rest of `PROMPT_WINDOW_CHARS` (6,000) in snippets; a body over `MAX_BODY_BYTES` is **413**. The starter sends whole files.",
      match: {
        python: {
          all: [
            /MAX_PREFIX_CHARS\s*=\s*3500/,
            /\[\s*-\s*MAX_PREFIX_CHARS\s*:\s*\]/,
            /\[\s*:\s*MAX_SUFFIX_CHARS\s*\]/,
            /\b413\b/,
          ],
        },
        typescript: {
          all: [
            /MAX_PREFIX_CHARS\s*=\s*3500/,
            /slice\(\s*-\s*MAX_PREFIX_CHARS\s*\)/,
            /slice\(\s*0\s*,\s*MAX_SUFFIX_CHARS\s*\)/,
            /bodyLimit:\s*MAX_BODY_BYTES/,
          ],
        },
        go: {all: [/maxPrefixChars\s*=\s*3500/, /maxSuffixChars/, /MaxBytesReader|StatusRequestEntityTooLarge/]},
        scala: {
          all: [
            /MaxPrefixChars\s*=\s*3500/,
            /takeRight\(\s*MaxPrefixChars\s*\)/,
            /take\(\s*MaxSuffixChars\s*\)/,
            /RequestEntityTooLarge|withSizeLimit/,
          ],
        },
        cpp: {all: [/kMaxPrefixChars\s*=\s*3500/, /kMaxSuffixChars/, /\b413\b/]},
      },
    },
    {
      id: 'no-code-log',
      title: 'Logs ids and sizes, not the code',
      detail:
        'The completion is logged with the session, the request id, the language, the prompt size and the snippet count; the prefix, the suffix and the tab text reach no log line. The starter logs the prefix and the suffix on every keystroke.',
      match: {
        python: {all: [/logger\.info\([^)]*request_id/], none: [/logger\.\w+\([^)]*body\.(prefix|suffix|open_tabs)/]},
        typescript: {
          all: [/log\.info\(\s*\{[^}]*request_id/],
          none: [/log\.\w+\(\s*\{[^}]*\b(prefix|suffix|open_tabs)\s*:/],
        },
        go: {all: [/log\.Printf\([^)]*requestID/], none: [/log\.\w+\([^)]*body\.(Prefix|Suffix|OpenTabs)/]},
        scala: {
          all: [/System\.err\.println\([^)]*requestId/],
          none: [/System\.err\.println\([^)]*body\.(prefix|suffix|openTabs)/],
        },
        cpp: {
          all: [/std::cerr\s*<<[^;]*request_id/],
          none: [/std::cerr\s*<<[^;]*body\[\s*"(prefix|suffix|open_tabs)"/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from copilot import model, tabs  # model.complete, tabs.remember_tabs, tabs.pick_snippets

app = FastAPI()
logger = logging.getLogger("completiond")
logger.setLevel(logging.INFO)


class OpenTab(BaseModel):
    path: str
    text: str


class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str
    path: str
    token: int = 0
    open_tabs: list[OpenTab] = []


@app.post("/v1/completions")
def completions(body: CompletionRequest, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    session = request.headers.get("x-session-id", "")
    logger.info("complete session=%s path=%s prefix=%r suffix=%r", session, body.path, body.prefix, body.suffix)
    others = [(tab.path, tab.text) for tab in body.open_tabs if tab.path != body.path]
    tabs.remember_tabs(session, others)
    snippets = tabs.pick_snippets(session, [path for path, _ in others], body.prefix)
    candidates = model.complete(body.prefix, body.suffix, snippets, body.language)
    return JSONResponse({"token": body.token, "candidates": candidates})
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from copilot import model, tabs  # model.complete, tabs.remember_tabs, tabs.pick_snippets

app = FastAPI()
logger = logging.getLogger("completiond")
logger.setLevel(logging.INFO)

PROMPT_WINDOW_CHARS = 6000
MAX_PREFIX_CHARS = 3500
MAX_SUFFIX_CHARS = 1000
MAX_SNIPPET_CHARS = PROMPT_WINDOW_CHARS - MAX_PREFIX_CHARS - MAX_SUFFIX_CHARS
MAX_BODY_BYTES = 1 << 20


class OpenTab(BaseModel):
    path: str
    text: str


class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str
    path: str
    token: int = 0
    open_tabs: list[OpenTab] = []


def fit_window(prefix: str, suffix: str, snippets: list[str]) -> tuple[str, str, list[str]]:
    """The lines nearest the cursor matter most: the prefix keeps its tail, the suffix its head, snippets fill the rest."""
    kept: list[str] = []
    left = MAX_SNIPPET_CHARS
    for snippet in snippets:
        if left <= 0:
            break
        kept.append(snippet[:left])
        left -= len(kept[-1])
    return prefix[-MAX_PREFIX_CHARS:], suffix[:MAX_SUFFIX_CHARS], kept


@app.post("/v1/completions")
def completions(body: CompletionRequest, request: Request) -> JSONResponse:
    session = request.headers.get("x-session-id", "")
    if session == "":
        raise HTTPException(status_code=401, detail="X-Session-Id is required")
    if int(request.headers.get("content-length", "0")) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="the request exceeds 1 MiB")
    request_id = str(uuid.uuid4())
    others = [(tab.path, tab.text) for tab in body.open_tabs if tab.path != body.path]
    tabs.remember_tabs(session, others)
    picked = tabs.pick_snippets(session, [path for path, _ in others], body.prefix)
    prefix, suffix, snippets = fit_window(body.prefix, body.suffix, picked)
    candidates = model.complete(prefix, suffix, snippets, body.language)
    prompt_chars = len(prefix) + len(suffix) + sum(len(s) for s in snippets)
    logger.info(
        "complete session=%s request_id=%s language=%s prompt_chars=%d snippets=%d",
        session,
        request_id,
        body.language,
        prompt_chars,
        len(snippets),
    )
    return JSONResponse({"request_id": request_id, "token": body.token, "candidates": candidates})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {complete} from 'copilot/model';
import {type Tab, pickSnippets, rememberTabs} from 'copilot/tabs';

export const app = Fastify({logger: true});

interface CompletionRequest {
  prefix: string;
  suffix?: string;
  language: string;
  path: string;
  token?: number;
  open_tabs?: Tab[];
}

app.post('/v1/completions', async request => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const session = String(request.headers['x-session-id'] ?? '');
  const body = request.body as CompletionRequest;
  request.log.info({session, path: body.path, prefix: body.prefix, suffix: body.suffix}, 'complete');
  const others = (body.open_tabs ?? []).filter(tab => tab.path !== body.path);
  await rememberTabs(session, others);
  const snippets = await pickSnippets(session, others.map(tab => tab.path), body.prefix);
  const candidates = await complete(body.prefix, body.suffix ?? '', snippets, body.language);
  return {token: body.token ?? 0, candidates};
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {complete} from 'copilot/model';
import {type Tab, pickSnippets, rememberTabs} from 'copilot/tabs';

export const PROMPT_WINDOW_CHARS = 6000;
export const MAX_PREFIX_CHARS = 3500;
export const MAX_SUFFIX_CHARS = 1000;
export const MAX_SNIPPET_CHARS = PROMPT_WINDOW_CHARS - MAX_PREFIX_CHARS - MAX_SUFFIX_CHARS;
export const MAX_BODY_BYTES = 1024 * 1024;

export const app = Fastify({logger: true, bodyLimit: MAX_BODY_BYTES});

interface CompletionRequest {
  prefix: string;
  suffix?: string;
  language: string;
  path: string;
  token?: number;
  open_tabs?: Tab[];
}

/** The lines nearest the cursor matter most: the prefix keeps its tail, the suffix its head, snippets fill the rest. */
export function fitWindow(prefix: string, suffix: string, snippets: string[]): [string, string, string[]] {
  const kept: string[] = [];
  let left = MAX_SNIPPET_CHARS;
  for (const snippet of snippets) {
    if (left <= 0) break;
    kept.push(snippet.slice(0, left));
    left -= kept[kept.length - 1].length;
  }
  return [prefix.slice(-MAX_PREFIX_CHARS), suffix.slice(0, MAX_SUFFIX_CHARS), kept];
}

app.post('/v1/completions', async (request, reply) => {
  const session = request.headers['x-session-id'];
  if (typeof session !== 'string' || session === '') return reply.code(401).send({error: 'X-Session-Id is required'});
  const body = request.body as CompletionRequest;
  const requestId = randomUUID();
  const others = (body.open_tabs ?? []).filter(tab => tab.path !== body.path);
  await rememberTabs(session, others);
  const picked = await pickSnippets(session, others.map(tab => tab.path), body.prefix);
  const [prefix, suffix, snippets] = fitWindow(body.prefix, body.suffix ?? '', picked);
  const candidates = await complete(prefix, suffix, snippets, body.language);
  const promptChars = prefix.length + suffix.length + snippets.reduce((n, s) => n + s.length, 0);
  request.log.info(
    {session, request_id: requestId, language: body.language, prompt_chars: promptChars, snippets: snippets.length},
    'complete',
  );
  return {request_id: requestId, token: body.token ?? 0, candidates};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"copilot/model" // model.Complete
	"copilot/tabs"  // tabs.RememberTabs, tabs.PickSnippets
)

type completionRequest struct {
	Prefix   string     \`json:"prefix"\`
	Suffix   string     \`json:"suffix"\`
	Language string     \`json:"language"\`
	Path     string     \`json:"path"\`
	Token    int        \`json:"token"\`
	OpenTabs []tabs.Tab \`json:"open_tabs"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func completions(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	session := r.Header.Get("X-Session-Id")
	var body completionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	log.Printf("complete session=%s path=%s prefix=%q suffix=%q", session, body.Path, body.Prefix, body.Suffix)
	others, paths := []tabs.Tab{}, []string{}
	for _, tab := range body.OpenTabs {
		if tab.Path != body.Path {
			others = append(others, tab)
			paths = append(paths, tab.Path)
		}
	}
	if err := tabs.RememberTabs(r.Context(), session, others); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "tab cache unavailable"})
		return
	}
	snippets, err := tabs.PickSnippets(r.Context(), session, paths, body.Prefix)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "tab cache unavailable"})
		return
	}
	candidates := model.Complete(r.Context(), body.Prefix, body.Suffix, snippets, body.Language)
	writeJSON(rw, http.StatusOK, map[string]any{"token": body.Token, "candidates": candidates})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/completions", completions)
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/google/uuid"

	"copilot/model" // model.Complete
	"copilot/tabs"  // tabs.RememberTabs, tabs.PickSnippets
)

const (
	promptWindowChars = 6000
	maxPrefixChars    = 3500
	maxSuffixChars    = 1000
	maxSnippetChars   = promptWindowChars - maxPrefixChars - maxSuffixChars
	maxBodyBytes      = 1 << 20
)

type completionRequest struct {
	Prefix   string     \`json:"prefix"\`
	Suffix   string     \`json:"suffix"\`
	Language string     \`json:"language"\`
	Path     string     \`json:"path"\`
	Token    int        \`json:"token"\`
	OpenTabs []tabs.Tab \`json:"open_tabs"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// fitWindow keeps what matters most, the lines nearest the cursor: the prefix's tail, the suffix's head, snippets in the rest.
func fitWindow(prefix, suffix string, snippets []string) (string, string, []string) {
	if len(prefix) > maxPrefixChars {
		prefix = prefix[len(prefix)-maxPrefixChars:]
	}
	if len(suffix) > maxSuffixChars {
		suffix = suffix[:maxSuffixChars]
	}
	kept := []string{}
	left := maxSnippetChars
	for _, snippet := range snippets {
		if left <= 0 {
			break
		}
		if len(snippet) > left {
			snippet = snippet[:left]
		}
		kept = append(kept, snippet)
		left -= len(snippet)
	}
	return prefix, suffix, kept
}

func completions(rw http.ResponseWriter, r *http.Request) {
	session := r.Header.Get("X-Session-Id")
	if session == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Session-Id is required"})
		return
	}
	r.Body = http.MaxBytesReader(rw, r.Body, maxBodyBytes)
	var body completionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "the request exceeds 1 MiB"})
			return
		}
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	requestID := uuid.NewString()
	others, paths := []tabs.Tab{}, []string{}
	for _, tab := range body.OpenTabs {
		if tab.Path != body.Path {
			others = append(others, tab)
			paths = append(paths, tab.Path)
		}
	}
	if err := tabs.RememberTabs(r.Context(), session, others); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "tab cache unavailable"})
		return
	}
	picked, err := tabs.PickSnippets(r.Context(), session, paths, body.Prefix)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "tab cache unavailable"})
		return
	}
	prefix, suffix, snippets := fitWindow(body.Prefix, body.Suffix, picked)
	candidates := model.Complete(r.Context(), prefix, suffix, snippets, body.Language)
	promptChars := len(prefix) + len(suffix)
	for _, snippet := range snippets {
		promptChars += len(snippet)
	}
	log.Printf("complete session=%s request_id=%s language=%s prompt_chars=%d snippets=%d", session, requestID, body.Language, promptChars, len(snippets))
	writeJSON(rw, http.StatusOK, map[string]any{"request_id": requestID, "token": body.Token, "candidates": candidates})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/completions", completions)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import copilot.{Model, Tabs} // Model.complete, Tabs.rememberTabs, Tabs.pickSnippets

object CompletionApi {
  final case class CompletionRequest(prefix: String, suffix: String, language: String, path: String, token: Long, openTabs: Seq[Tabs.Tab])

  private def parse(raw: String): CompletionRequest = {
    val fields = raw.parseJson.asJsObject.fields
    def text(o: Map[String, JsValue], name: String): String = o.get(name).collect { case JsString(s) => s }.getOrElse("")
    val open = fields.get("open_tabs").collect { case JsArray(items) => items.map(i => Tabs.Tab(text(i.asJsObject.fields, "path"), text(i.asJsObject.fields, "text"))) }
    val token = fields.get("token").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
    CompletionRequest(text(fields, "prefix"), text(fields, "suffix"), text(fields, "language"), text(fields, "path"), token, open.getOrElse(Vector.empty))
  }

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "completions") {
    post {
      optionalHeaderValueByName("X-Session-Id") { header =>
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val session = header.getOrElse("")
          val body = parse(raw)
          System.err.println(s"complete session=$session path=\${body.path} prefix=\${body.prefix} suffix=\${body.suffix}")
          val others = body.openTabs.filter(_.path != body.path)
          Tabs.rememberTabs(session, others)
          val snippets = Tabs.pickSnippets(session, others.map(_.path), body.prefix)
          val candidates = Model.complete(body.prefix, body.suffix, snippets, body.language)
          complete(json(StatusCodes.OK, JsObject("token" -> JsNumber(body.token), "candidates" -> JsArray(candidates.map(JsString(_)).toVector))))
        }
      }
    }
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import copilot.{Model, Tabs} // Model.complete, Tabs.rememberTabs, Tabs.pickSnippets

object CompletionApi {
  val PromptWindowChars = 6000
  val MaxPrefixChars = 3500
  val MaxSuffixChars = 1000
  val MaxSnippetChars: Int = PromptWindowChars - MaxPrefixChars - MaxSuffixChars
  val MaxBodyBytes: Long = 1L << 20

  final case class CompletionRequest(prefix: String, suffix: String, language: String, path: String, token: Long, openTabs: Seq[Tabs.Tab])

  private def parse(raw: String): CompletionRequest = {
    val fields = raw.parseJson.asJsObject.fields
    def text(o: Map[String, JsValue], name: String): String = o.get(name).collect { case JsString(s) => s }.getOrElse("")
    val open = fields.get("open_tabs").collect { case JsArray(items) => items.map(i => Tabs.Tab(text(i.asJsObject.fields, "path"), text(i.asJsObject.fields, "text"))) }
    val token = fields.get("token").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
    CompletionRequest(text(fields, "prefix"), text(fields, "suffix"), text(fields, "language"), text(fields, "path"), token, open.getOrElse(Vector.empty))
  }

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The lines nearest the cursor matter most: the prefix keeps its tail, the suffix its head, snippets fill the rest. */
  def fitWindow(prefix: String, suffix: String, snippets: Seq[String]): (String, String, Seq[String]) = {
    val kept = snippets
      .scanLeft(("", MaxSnippetChars)) { case ((_, left), snippet) => (snippet.take(left), left - snippet.take(left).length) }
      .drop(1)
      .map(_._1)
      .filter(_.nonEmpty)
    (prefix.takeRight(MaxPrefixChars), suffix.take(MaxSuffixChars), kept)
  }

  val route: Route = path("v1" / "completions") {
    post {
      optionalHeaderValueByName("X-Session-Id") {
        case None | Some("") =>
          complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Session-Id is required"))))
        case Some(session) =>
          withSizeLimit(MaxBodyBytes) {
            entity(as[String]) { raw =>
              val body = parse(raw)
              val requestId = UUID.randomUUID().toString
              val others = body.openTabs.filter(_.path != body.path)
              Tabs.rememberTabs(session, others)
              val picked = Tabs.pickSnippets(session, others.map(_.path), body.prefix)
              val (prefix, suffix, snippets) = fitWindow(body.prefix, body.suffix, picked)
              val candidates = Model.complete(prefix, suffix, snippets, body.language)
              val promptChars = prefix.length + suffix.length + snippets.map(_.length).sum
              System.err.println(s"complete session=$session request_id=$requestId language=\${body.language} prompt_chars=$promptChars snippets=\${snippets.size}")
              complete(
                json(
                  StatusCodes.OK,
                  JsObject("request_id" -> JsString(requestId), "token" -> JsNumber(body.token), "candidates" -> JsArray(candidates.map(JsString(_)).toVector))
                )
              )
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

#include <iostream>
#include <string>
#include <vector>

#include "copilot/model.h"  // model::complete
#include "copilot/tabs.h"   // tabs::rememberTabs, tabs::pickSnippets

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void completions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string session = req.get_header_value("X-Session-Id");
  const json body = json::parse(req.body);
  const std::string prefix = body.value("prefix", "");
  const std::string suffix = body.value("suffix", "");
  const std::string path = body.value("path", "");
  std::cerr << "complete session=" << session << " path=" << path << " prefix=" << prefix << " suffix=" << suffix << "\\n";
  std::vector<tabs::Tab> others;
  std::vector<std::string> paths;
  for (const json& tab : body.value("open_tabs", json::array())) {
    if (tab.value("path", "") == path) continue;
    others.push_back({tab.value("path", ""), tab.value("text", "")});
    paths.push_back(tab.value("path", ""));
  }
  tabs::rememberTabs(session, others);
  const auto snippets = tabs::pickSnippets(session, paths, prefix);
  const auto candidates = model::complete(prefix, suffix, snippets, body.value("language", ""));
  reply(res, 200, {{"token", body.value("token", 0)}, {"candidates", candidates}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/completions", completions); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <uuid/uuid.h>

#include <iostream>
#include <string>
#include <tuple>
#include <vector>

#include "copilot/model.h"  // model::complete
#include "copilot/tabs.h"   // tabs::rememberTabs, tabs::pickSnippets

using json = nlohmann::json;

constexpr std::size_t kPromptWindowChars = 6000;
constexpr std::size_t kMaxPrefixChars = 3500;
constexpr std::size_t kMaxSuffixChars = 1000;
constexpr std::size_t kMaxSnippetChars = kPromptWindowChars - kMaxPrefixChars - kMaxSuffixChars;
constexpr std::size_t kMaxBodyBytes = 1 << 20;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string newRequestId() {
  uuid_t id;
  uuid_generate(id);
  char text[37];
  uuid_unparse_lower(id, text);
  return text;
}

// The lines nearest the cursor matter most: the prefix keeps its tail, the suffix its head, snippets fill the rest.
std::tuple<std::string, std::string, std::vector<std::string>> fitWindow(const std::string& prefix, const std::string& suffix,
                                                                        const std::vector<std::string>& snippets) {
  std::vector<std::string> kept;
  std::size_t left = kMaxSnippetChars;
  for (const std::string& snippet : snippets) {
    if (left == 0) break;
    kept.push_back(snippet.substr(0, left));
    left -= kept.back().size();
  }
  const std::string tail = prefix.size() > kMaxPrefixChars ? prefix.substr(prefix.size() - kMaxPrefixChars) : prefix;
  return {tail, suffix.substr(0, kMaxSuffixChars), kept};
}

void completions(const httplib::Request& req, httplib::Response& res) {
  const std::string session = req.get_header_value("X-Session-Id");
  if (session.empty()) return reply(res, 401, {{"error", "X-Session-Id is required"}});
  if (req.body.size() > kMaxBodyBytes) return reply(res, 413, {{"error", "the request exceeds 1 MiB"}});
  const json body = json::parse(req.body);
  const std::string path = body.value("path", "");
  const std::string language = body.value("language", "");
  std::vector<tabs::Tab> others;
  std::vector<std::string> paths;
  for (const json& tab : body.value("open_tabs", json::array())) {
    if (tab.value("path", "") == path) continue;
    others.push_back({tab.value("path", ""), tab.value("text", "")});
    paths.push_back(tab.value("path", ""));
  }
  const std::string request_id = newRequestId();
  tabs::rememberTabs(session, others);
  const auto picked = tabs::pickSnippets(session, paths, body.value("prefix", ""));
  const auto [prefix, suffix, snippets] = fitWindow(body.value("prefix", ""), body.value("suffix", ""), picked);
  const auto candidates = model::complete(prefix, suffix, snippets, language);
  std::size_t prompt_chars = prefix.size() + suffix.size();
  for (const std::string& snippet : snippets) prompt_chars += snippet.size();
  std::cerr << "complete session=" << session << " request_id=" << request_id << " language=" << language
            << " prompt_chars=" << prompt_chars << " snippets=" << snippets.size() << "\\n";
  reply(res, 200, {{"request_id", request_id}, {"token", body.value("token", 0)}, {"candidates", candidates}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/completions", completions); }
`,
    },
  },
  harness: {
    python: `import contextlib
import io
import logging

import copilot_context_pb2 as pb
import copilot_context_pb2_grpc as pb_grpc

SESSION = {"X-Session-Id": "s-ada"}
ANSWER = ["conn.cursor()", "conn.close()"]
PREFIX = "".join(f"line_{i} = {i}\\n" for i in range(2000)) + "value = "
SUFFIX = "".join(f"after_{i}()\\n" for i in range(500))
TABS = [(f"lib/t{k}.py", "".join(f"line_{1960 + j} = compute({k})\\n" for j in range(40))) for k in range(6)]


class ModelPeer(pb_grpc.ModelServicer):
    """The stand-in model service: records every request, answers two candidates."""

    def __init__(self):
        self.requests = []

    def Complete(self, request, context):
        self.requests.append(request)
        return pb.CompleteReply(candidates=[pb.Candidate(text=text) for text in ANSWER])


def _world(ctx):
    peer = ModelPeer()
    ctx.grpc.serve(pb_grpc.add_ModelServicer_to_server, peer, "model:9000")
    m = ctx.load("completion_api")
    return ctx.client(m.app), peer


def _body(prefix="def load(conn):\\n    return ", suffix="\\n", open_tabs=(), token=17):
    return {
        "prefix": prefix,
        "suffix": suffix,
        "language": "python",
        "path": "db/conn.py",
        "token": token,
        "open_tabs": [{"path": path, "text": text} for path, text in open_tabs],
    }


async def check_route(ctx):
    client, peer = _world(ctx)
    async with client as c:
        r = await c.post("/v1/completions", json=_body(), headers=SESSION)
    assert r.status_code == 200, f"POST /v1/completions answered {r.status_code}: {r.text}"
    assert r.json().get("candidates") == ANSWER, f"the reply must carry the model's candidates {ANSWER}, got {r.json()}"
    assert len(peer.requests) == 1 and peer.requests[0].language == "python", f"one Complete call with the request's language expected, saw {len(peer.requests)}"


async def check_session(ctx):
    client, peer = _world(ctx)
    async with client as c:
        r = await c.post("/v1/completions", json=_body(open_tabs=TABS[:1]))
        assert r.status_code == 401, f"a request without X-Session-Id answered {r.status_code}, expected 401"
        assert peer.requests == [], "a request without a session reached the model"
        assert ctx.redis.keys("tabs:*") == [], f"a request without a session stored tabs: {ctx.redis.keys('tabs:*')}"
        first = await c.post("/v1/completions", json=_body(token=17), headers=SESSION)
        second = await c.post("/v1/completions", json=_body(token=18), headers=SESSION)
    assert first.status_code == 200 and second.status_code == 200, f"two completions answered {first.status_code} and {second.status_code}"
    a, b = first.json(), second.json()
    assert isinstance(a.get("request_id"), str) and a["request_id"] != "", f"the reply must carry a request_id, got {a}"
    assert a["request_id"] != b.get("request_id"), "two requests answered the same request_id: it must be fresh per request"
    assert a.get("token") == 17 and b.get("token") == 18, f"each reply must echo its own token, got {a.get('token')} and {b.get('token')}"


async def check_window(ctx):
    client, peer = _world(ctx)
    async with client as c:
        r = await c.post("/v1/completions", json=_body(PREFIX, SUFFIX, TABS), headers=SESSION)
        assert r.status_code == 200, f"a 25,000-character file answered {r.status_code}: trim it, do not reject it"
        sent = peer.requests[-1]
        assert sent.prefix == PREFIX[-3500:], f"the model received a prefix of {len(sent.prefix)} characters: keep the last 3,500, the lines nearest the cursor"
        assert sent.suffix == SUFFIX[:1000], f"the model received a suffix of {len(sent.suffix)} characters: keep the first 1,000"
        snippet_chars = sum(len(s) for s in sent.snippets)
        assert 0 < snippet_chars <= 1500, f"the snippets took {snippet_chars} characters: they get what is left of the 6,000-character window (1,500)"
        calls = len(peer.requests)
        big = await c.post("/v1/completions", json=_body("a" * 1_100_000), headers=SESSION)
    assert big.status_code == 413, f"a body over 1 MiB answered {big.status_code}, expected 413"
    assert len(peer.requests) == calls, "a body over 1 MiB reached the model"


async def check_no_code_log(ctx):
    client, peer = _world(ctx)
    canary = "CANARY_7731"
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    logging.getLogger().addHandler(handler)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            async with client as c:
                r = await c.post(
                    "/v1/completions",
                    json=_body(f"secret = '{canary}'\\nvalue = ", f"\\n# {canary}\\n", [("lib/keys.py", f"secret = '{canary}'")]),
                    headers=SESSION,
                )
    finally:
        logging.getLogger().removeHandler(handler)
    logged = captured.getvalue()
    assert r.status_code == 200, f"POST /v1/completions answered {r.status_code}: {r.text}"
    assert canary not in logged, f"the code reached a log line: {logged.strip()!r}"
    request_id = r.json().get("request_id")
    assert request_id and request_id in logged, f"no log line names the request id {request_id!r}; log ids and sizes: {logged.strip()!r}"
`,
    typescript: `const SESSION = {'X-Session-Id': 's-ada'};
const ANSWER = ['conn.cursor()', 'conn.close()'];
const PREFIX = Array.from({length: 2000}, (_, i) => \`line_\${i} = \${i}\\n\`).join('') + 'value = ';
const SUFFIX = Array.from({length: 500}, (_, i) => \`after_\${i}()\\n\`).join('');
const TABS = Array.from({length: 6}, (_, k) => ({
  path: \`lib/t\${k}.py\`,
  text: Array.from({length: 40}, (_, j) => \`line_\${1960 + j} = compute(\${k})\\n\`).join(''),
}));

/** The stand-in model service at model:9000 (records every request, answers two candidates) and the learner's app. */
function world(ctx) {
  const {copilotctx} = ctx.proto('copilot_context.proto');
  const requests = [];
  ctx.grpc.serve(
    copilotctx.Model.service,
    {
      Complete(call, callback) {
        requests.push(call.request);
        callback(null, {candidates: ANSWER.map(text => ({text, truncated: false}))});
      },
    },
    'model:9000',
  );
  const m = ctx.load('completion_api');
  return {c: ctx.client(m.app), requests};
}

const body = ({prefix = 'def load(conn):\\n    return ', suffix = '\\n', openTabs = [], token = 17} = {}) => ({
  prefix,
  suffix,
  language: 'python',
  path: 'db/conn.py',
  token,
  open_tabs: openTabs,
});

export async function check_route(ctx) {
  const {c, requests} = world(ctx);
  const r = await c.post('/v1/completions', {json: body(), headers: SESSION});
  assert.equal(r.status, 200, \`POST /v1/completions answered \${r.status}: \${r.text}\`);
  assert.deepEqual(r.json().candidates, ANSWER, \`the reply must carry the model's candidates, got \${r.text}\`);
  assert(requests.length === 1 && requests[0].language === 'python', \`one Complete call with the request's language expected, saw \${requests.length}\`);
}

export async function check_session(ctx) {
  const {c, requests} = world(ctx);
  const r = await c.post('/v1/completions', {json: body({openTabs: TABS.slice(0, 1)})});
  assert.equal(r.status, 401, \`a request without X-Session-Id answered \${r.status}, expected 401\`);
  assert.equal(requests.length, 0, 'a request without a session reached the model');
  assert.deepEqual(ctx.redis.keys('tabs:*'), [], \`a request without a session stored tabs: \${JSON.stringify(ctx.redis.keys('tabs:*'))}\`);
  const first = await c.post('/v1/completions', {json: body({token: 17}), headers: SESSION});
  const second = await c.post('/v1/completions', {json: body({token: 18}), headers: SESSION});
  assert(first.status === 200 && second.status === 200, \`two completions answered \${first.status} and \${second.status}\`);
  const a = first.json();
  const b = second.json();
  assert(typeof a.request_id === 'string' && a.request_id !== '', \`the reply must carry a request_id, got \${first.text}\`);
  assert.notEqual(a.request_id, b.request_id, 'two requests answered the same request_id: it must be fresh per request');
  assert(a.token === 17 && b.token === 18, \`each reply must echo its own token, got \${a.token} and \${b.token}\`);
}

export async function check_window(ctx) {
  const {c, requests} = world(ctx);
  const r = await c.post('/v1/completions', {json: body({prefix: PREFIX, suffix: SUFFIX, openTabs: TABS}), headers: SESSION});
  assert.equal(r.status, 200, \`a 25,000-character file answered \${r.status}: trim it, do not reject it\`);
  const sent = requests[requests.length - 1];
  assert.equal(sent.prefix, PREFIX.slice(-3500), \`the model received a prefix of \${sent.prefix.length} characters: keep the last 3,500, the lines nearest the cursor\`);
  assert.equal(sent.suffix, SUFFIX.slice(0, 1000), \`the model received a suffix of \${sent.suffix.length} characters: keep the first 1,000\`);
  const snippetChars = (sent.snippets ?? []).reduce((n, s) => n + s.length, 0);
  assert(snippetChars > 0 && snippetChars <= 1500, \`the snippets took \${snippetChars} characters: they get what is left of the 6,000-character window (1,500)\`);
  const calls = requests.length;
  const big = await c.post('/v1/completions', {json: body({prefix: 'a'.repeat(1_100_000)}), headers: SESSION});
  assert.equal(big.status, 413, \`a body over 1 MiB answered \${big.status}, expected 413\`);
  assert.equal(requests.length, calls, 'a body over 1 MiB reached the model');
}

export async function check_no_code_log(ctx) {
  const {c} = world(ctx);
  const canary = 'CANARY_7731';
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  let r;
  try {
    r = await c.post('/v1/completions', {
      json: body({prefix: \`secret = '\${canary}'\\nvalue = \`, suffix: \`\\n# \${canary}\\n\`, openTabs: [{path: 'lib/keys.py', text: \`secret = '\${canary}'\`}]}),
      headers: SESSION,
    });
  } finally {
    Object.assign(console, prior);
  }
  assert.equal(r.status, 200, \`POST /v1/completions answered \${r.status}: \${r.text}\`);
  const leak = logged.find(line => line.includes(canary));
  assert(leak === undefined, \`the code reached a log line: \${leak}\`);
  const requestId = r.json().request_id;
  assert(requestId && logged.some(line => line.includes(requestId)), \`no log line names the request id \${requestId}; log ids and sizes: \${logged.join(' | ')}\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	pb "copilot/gen/copilot_context"

	"leetbuild/harness"
)

var apiAnswer = []string{"conn.cursor()", "conn.close()"}

// apiModel is the stand-in model service: records every request, answers two candidates.
type apiModel struct {
	pb.UnimplementedModelServer
	requests []*pb.CompleteRequest
}

func (m *apiModel) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	m.requests = append(m.requests, req)
	reply := &pb.CompleteReply{}
	for _, text := range apiAnswer {
		reply.Candidates = append(reply.Candidates, &pb.Candidate{Text: text})
	}
	return reply, nil
}

func apiWorld(ctx *harness.Ctx) (*harness.HTTP, *apiModel) {
	peer := &apiModel{}
	pb.RegisterModelServer(ctx.GRPC.Server("model:9000"), peer)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), peer
}

func apiLines(n int, line func(i int) string) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteString(line(i))
	}
	return b.String()
}

var apiPrefix = apiLines(2000, func(i int) string { return fmt.Sprintf("line_%d = %d\\n", i, i) }) + "value = "
var apiSuffix = apiLines(500, func(i int) string { return fmt.Sprintf("after_%d()\\n", i) })

func apiTabs() []map[string]string {
	out := []map[string]string{}
	for k := 0; k < 6; k++ {
		text := apiLines(40, func(j int) string { return fmt.Sprintf("line_%d = compute(%d)\\n", 1960+j, k) })
		out = append(out, map[string]string{"path": fmt.Sprintf("lib/t%d.py", k), "text": text})
	}
	return out
}

func apiBody(prefix, suffix string, openTabs []map[string]string, token int) map[string]any {
	if openTabs == nil {
		openTabs = []map[string]string{}
	}
	return map[string]any{"prefix": prefix, "suffix": suffix, "language": "python", "path": "db/conn.py", "token": token, "open_tabs": openTabs}
}

const apiShortPrefix = "def load(conn):\\n    return "

func CheckRoute(ctx *harness.Ctx) {
	c, peer := apiWorld(ctx)
	r := c.Post("/v1/completions", apiBody(apiShortPrefix, "\\n", nil, 17), "X-Session-Id", "s-ada")
	ctx.Equal(r.Status, 200, "POST /v1/completions (%s)", r.Text())
	out, _ := r.JSON().(map[string]any)
	ctx.Equal(out["candidates"], []any{"conn.cursor()", "conn.close()"}, "the reply must carry the model's candidates")
	ctx.Assert(len(peer.requests) == 1 && peer.requests[0].GetLanguage() == "python", "one Complete call with the request's language expected, saw %d", len(peer.requests))
}

func CheckSession(ctx *harness.Ctx) {
	c, peer := apiWorld(ctx)
	r := c.Post("/v1/completions", apiBody(apiShortPrefix, "\\n", apiTabs()[:1], 17))
	ctx.Equal(r.Status, 401, "a request without X-Session-Id")
	ctx.Equal(len(peer.requests), 0, "a request without a session reached the model; Complete calls")
	ctx.Equal(len(ctx.Redis.Keys("tabs:*")), 0, "a request without a session stored tabs (%v); keys", ctx.Redis.Keys("tabs:*"))
	first := c.Post("/v1/completions", apiBody(apiShortPrefix, "\\n", nil, 17), "X-Session-Id", "s-ada")
	second := c.Post("/v1/completions", apiBody(apiShortPrefix, "\\n", nil, 18), "X-Session-Id", "s-ada")
	ctx.Assert(first.Status == 200 && second.Status == 200, "two completions answered %d and %d", first.Status, second.Status)
	a, _ := first.JSON().(map[string]any)
	b, _ := second.JSON().(map[string]any)
	id, _ := a["request_id"].(string)
	ctx.Assert(id != "", "the reply must carry a request_id, got %s", first.Text())
	ctx.Assert(a["request_id"] != b["request_id"], "two requests answered the same request_id: it must be fresh per request")
	ctx.Assert(a["token"] == float64(17) && b["token"] == float64(18), "each reply must echo its own token, got %v and %v", a["token"], b["token"])
}

func CheckWindow(ctx *harness.Ctx) {
	c, peer := apiWorld(ctx)
	r := c.Post("/v1/completions", apiBody(apiPrefix, apiSuffix, apiTabs(), 17), "X-Session-Id", "s-ada")
	ctx.Equal(r.Status, 200, "a 25,000-character file must be trimmed, not rejected (%s)", r.Text())
	sent := peer.requests[len(peer.requests)-1]
	ctx.Assert(sent.GetPrefix() == apiPrefix[len(apiPrefix)-3500:], "the model received a prefix of %d characters: keep the last 3,500, the lines nearest the cursor", len(sent.GetPrefix()))
	ctx.Assert(sent.GetSuffix() == apiSuffix[:1000], "the model received a suffix of %d characters: keep the first 1,000", len(sent.GetSuffix()))
	snippetChars := 0
	for _, s := range sent.GetSnippets() {
		snippetChars += len(s)
	}
	ctx.Assert(snippetChars > 0 && snippetChars <= 1500, "the snippets took %d characters: they get what is left of the 6,000-character window (1,500)", snippetChars)
	calls := len(peer.requests)
	big := c.Post("/v1/completions", apiBody(strings.Repeat("a", 1100000), "\\n", nil, 17), "X-Session-Id", "s-ada")
	ctx.Equal(big.Status, 413, "a body over 1 MiB")
	ctx.Equal(len(peer.requests), calls, "a body over 1 MiB reached the model; Complete calls")
}

func CheckNoCodeLog(ctx *harness.Ctx) {
	c, _ := apiWorld(ctx)
	const canary = "CANARY_7731"
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	tab := []map[string]string{{"path": "lib/keys.py", "text": "secret = '" + canary + "'"}}
	r := c.Post("/v1/completions", apiBody("secret = '"+canary+"'\\nvalue = ", "\\n# "+canary+"\\n", tab, 17), "X-Session-Id", "s-ada")
	log.SetOutput(os.Stderr)
	ctx.Equal(r.Status, 200, "POST /v1/completions (%s)", r.Text())
	ctx.Assert(!strings.Contains(logged.String(), canary), "the code reached a log line: %q", strings.TrimSpace(logged.String()))
	out, _ := r.JSON().(map[string]any)
	id, _ := out["request_id"].(string)
	ctx.Assert(id != "" && strings.Contains(logged.String(), id), "no log line names the request id %q; log ids and sizes: %q", id, strings.TrimSpace(logged.String()))
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "copilot_context.grpc.pb.h"

namespace {

const std::vector<std::string> kApiAnswer = {"conn.cursor()", "conn.close()"};
const std::string kApiShortPrefix = "def load(conn):\\n    return ";

// The stand-in model service: records every request, answers two candidates.
class ApiModel final : public copilotctx::Model::Service {
 public:
  std::vector<copilotctx::CompleteRequest> requests;
  grpc::Status Complete(grpc::ServerContext*, const copilotctx::CompleteRequest* req, copilotctx::CompleteReply* reply) override {
    requests.push_back(*req);
    for (const std::string& text : kApiAnswer) reply->add_candidates()->set_text(text);
    return grpc::Status::OK;
  }
};

struct ApiWorld {
  ApiModel peer;
  httplib::Server svr;
};

ApiWorld& apiWorld(harness::Ctx& ctx) {
  static ApiWorld* world = nullptr;
  delete world;
  world = new ApiWorld();
  ctx.GRPC.Server("model:9000")->RegisterService(&world->peer);
  register_routes(world->svr);
  return *world;
}

std::string apiPrefix() {
  std::string out;
  for (int i = 0; i < 2000; i++) out += "line_" + std::to_string(i) + " = " + std::to_string(i) + "\\n";
  return out + "value = ";
}

std::string apiSuffix() {
  std::string out;
  for (int i = 0; i < 500; i++) out += "after_" + std::to_string(i) + "()\\n";
  return out;
}

nlohmann::json apiTabs() {
  nlohmann::json out = nlohmann::json::array();
  for (int k = 0; k < 6; k++) {
    std::string text;
    for (int j = 0; j < 40; j++) text += "line_" + std::to_string(1960 + j) + " = compute(" + std::to_string(k) + ")\\n";
    out.push_back({{"path", "lib/t" + std::to_string(k) + ".py"}, {"text", text}});
  }
  return out;
}

std::string apiBody(const std::string& prefix, const std::string& suffix, const nlohmann::json& open_tabs, int token) {
  return nlohmann::json{{"prefix", prefix}, {"suffix", suffix}, {"language", "python"}, {"path", "db/conn.py"}, {"token", token}, {"open_tabs", open_tabs}}.dump();
}

harness::Response apiPost(harness::HTTP& c, const std::string& body) {
  return c.Post("/v1/completions", body, "Content-Type", "application/json", "X-Session-Id", "s-ada");
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto& w = apiWorld(ctx);
  auto c = ctx.HTTP(w.svr);
  const auto r = apiPost(c, apiBody(kApiShortPrefix, "\\n", nlohmann::json::array(), 17));
  ctx.Equal(r.Status, 200, "POST /v1/completions (%s)", r.Text());
  const auto out = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(out.is_object() && out.value("candidates", nlohmann::json()) == nlohmann::json(kApiAnswer), "the reply must carry the model's candidates, got %s", r.Text());
  ctx.Assert(w.peer.requests.size() == 1 && w.peer.requests[0].language() == "python", "one Complete call with the request's language expected, saw %d", w.peer.requests.size());
}

void CheckSession(harness::Ctx& ctx) {
  auto& w = apiWorld(ctx);
  auto c = ctx.HTTP(w.svr);
  nlohmann::json one = nlohmann::json::array({apiTabs()[0]});
  const auto r = c.Post("/v1/completions", apiBody(kApiShortPrefix, "\\n", one, 17), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a request without X-Session-Id");
  ctx.Equal(w.peer.requests.size(), 0, "a request without a session reached the model; Complete calls");
  ctx.Equal(ctx.Redis.Keys("tabs:*").size(), 0, "a request without a session stored tabs; keys");
  const auto first = apiPost(c, apiBody(kApiShortPrefix, "\\n", nlohmann::json::array(), 17));
  const auto second = apiPost(c, apiBody(kApiShortPrefix, "\\n", nlohmann::json::array(), 18));
  ctx.Assert(first.Status == 200 && second.Status == 200, "two completions answered %d and %d", first.Status, second.Status);
  const auto a = nlohmann::json::parse(first.Text(), nullptr, false);
  const auto b = nlohmann::json::parse(second.Text(), nullptr, false);
  const std::string id = a.is_object() ? a.value("request_id", "") : "";
  ctx.Assert(!id.empty(), "the reply must carry a request_id, got %s", first.Text());
  ctx.Assert(id != (b.is_object() ? b.value("request_id", "") : ""), "two requests answered the same request_id: it must be fresh per request");
  ctx.Assert(a.value("token", 0) == 17 && b.value("token", 0) == 18, "each reply must echo its own token, got %s and %s", first.Text(), second.Text());
}

void CheckWindow(harness::Ctx& ctx) {
  auto& w = apiWorld(ctx);
  auto c = ctx.HTTP(w.svr);
  const std::string prefix = apiPrefix();
  const std::string suffix = apiSuffix();
  const auto r = apiPost(c, apiBody(prefix, suffix, apiTabs(), 17));
  ctx.Equal(r.Status, 200, "a 25,000-character file must be trimmed, not rejected (%s)", r.Text());
  const auto& sent = w.peer.requests.back();
  ctx.Assert(sent.prefix() == prefix.substr(prefix.size() - 3500), "the model received a prefix of %d characters: keep the last 3,500, the lines nearest the cursor", sent.prefix().size());
  ctx.Assert(sent.suffix() == suffix.substr(0, 1000), "the model received a suffix of %d characters: keep the first 1,000", sent.suffix().size());
  std::size_t snippet_chars = 0;
  for (const auto& s : sent.snippets()) snippet_chars += s.size();
  ctx.Assert(snippet_chars > 0 && snippet_chars <= 1500, "the snippets took %d characters: they get what is left of the 6,000-character window (1,500)", snippet_chars);
  const std::size_t calls = w.peer.requests.size();
  const auto big = apiPost(c, apiBody(std::string(1100000, 'a'), "\\n", nlohmann::json::array(), 17));
  ctx.Equal(big.Status, 413, "a body over 1 MiB");
  ctx.Equal(w.peer.requests.size(), calls, "a body over 1 MiB reached the model; Complete calls");
}

void CheckNoCodeLog(harness::Ctx& ctx) {
  auto& w = apiWorld(ctx);
  auto c = ctx.HTTP(w.svr);
  const std::string canary = "CANARY_7731";
  nlohmann::json tab = nlohmann::json::array({{{"path", "lib/keys.py"}, {"text", "secret = '" + canary + "'"}}});
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  const auto r = apiPost(c, apiBody("secret = '" + canary + "'\\nvalue = ", "\\n# " + canary + "\\n", tab, 17));
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Equal(r.Status, 200, "POST /v1/completions (%s)", r.Text());
  ctx.Assert(logged.str().find(canary) == std::string::npos, "the code reached a log line: %q", logged.str());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  const std::string id = body.is_object() ? body.value("request_id", "") : "";
  ctx.Assert(!id.empty() && logged.str().find(id) != std::string::npos, "no log line names the request id %q; log ids and sizes: %q", id, logged.str());
}
`,
  },
  hints: [
    'Send a request without `X-Session-Id`: it is served. Send a 20,000-character file: the model call carries all of it, and the service log holds the code you typed.',
    'The handler never reads the header as a requirement and mints no id; it hands `body.prefix` and `body.suffix` to the model untouched; its log line formats the prefix and the suffix.',
    'Answer 401 on an empty session and 413 over `MAX_BODY_BYTES`; send `prefix[-MAX_PREFIX_CHARS:]`, `suffix[:MAX_SUFFIX_CHARS]` and snippets cut to the rest of 6,000; add a `uuid4` `request_id`; log ids, language and sizes only.',
  ],
  debrief: `The handler sits at a trust boundary and sees source code on every keystroke, so the cheap rejections come first: no session, no work. The window is a budget, not a validator: the prefix keeps its tail and the suffix its head because the lines nearest the cursor carry the most signal, and snippets get what is left. The request id is what later telemetry names, and the echoed token lets the editor drop a reply that arrived after the next keystroke. The log line changes shape because a logging pipeline keeps data longer than a session does. A production service would measure the window in model tokens rather than characters and rate-limit each session.`,
};
