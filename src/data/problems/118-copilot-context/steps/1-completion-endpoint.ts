import type {Step} from '@/lib/types';

export const completionEndpointStep: Step = {
  id: 'completion-endpoint',
  title: 'POST /v1/completions: a prompt that fits the window',
  concept: 'http',
  file: 'completion_api',
  focus: ['editor', 'api'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the editor's request and returns candidates. It compiles, it serves the demo, and it hides four
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/completions\` with body
\`{"prefix": "…", "suffix": "…", "language": "python", "path": "db/conn.py", "token": 17, "open_tabs": [{"path": "…", "text": "…"}]}\`.

- The session comes from the authenticated \`X-Session-Id\` header; a missing session is **401**.
  Completions are per developer: the open tabs in the body are that developer's code, and the
  reply must never be served to anyone else.
- The model reads about **6,000 characters** (\`PROMPT_WINDOW_CHARS\`). The editor sends the whole
  file; the service makes it fit: the prefix keeps its **last 3,500** characters
  (\`MAX_PREFIX_CHARS\`), the suffix its **first 1,000** (\`MAX_SUFFIX_CHARS\`), and the open-tab
  snippets fill what is left (\`MAX_TABS_CHARS\`), at most **20** tabs (\`MAX_OPEN_TABS\`). Trim,
  do not reject: a 40 KB file is normal.
- A request whose prefix, suffix and tabs together exceed **1 MiB** (\`MAX_BODY_BYTES\`) is **413**;
  an empty \`language\` or \`path\` is **400**.
- Every reply carries a fresh \`request_id\` and echoes the editor's \`token\`: the editor fires on
  every keystroke and drops any reply whose token is older than its latest request.
- Log session, request id, language, prompt size and snippet count — never the prefix, the
  suffix or a tab's text.

**Failure mode the checks target.** Serving without a session makes one developer's open tabs
another developer's context; an untrimmed prefix either fails at the model or costs the window
that the neighboring-tab snippets needed; a reply with no id cannot be matched to a keystroke, so
a slow reply overwrites a newer one. The log line is the quiet one: it ships source code into the
log pipeline on every keystroke, where it outlives the session and the retention policy.`,
  sequence: {
    participants: ['Editor', 'completiond', 'Model service'],
    messages: [
      {from: 'Editor', to: 'completiond', label: 'POST /v1/completions · X-Session-Id · token 17', kind: 'sync'},
      {
        from: 'completiond',
        to: 'completiond',
        label: 'validate session · size · fit the 6,000-char window',
        kind: 'sync',
      },
      {from: 'completiond', to: 'Model service', label: 'Complete(prefix tail, suffix head, snippets)', kind: 'sync'},
      {from: 'Model service', to: 'completiond', label: 'candidates', kind: 'reply'},
      {from: 'completiond', to: 'Editor', label: '200 {request_id, token: 17, candidates}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/completions',
      detail: 'Register the completion route on `POST /v1/completions`.',
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
        'A missing `X-Session-Id` is **401**, and every reply carries a fresh `request_id` next to the echoed `token`. The draft serves anyone and returns candidates the editor cannot match to a keystroke.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /request_id/]},
        typescript: {all: [/code\(\s*401\s*\)/, /request_id|requestId/]},
        go: {all: [/StatusUnauthorized/, /requestID|request_id/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /requestId|request_id/]},
        cpp: {all: [/\b401\b/, /requestId|request_id/]},
      },
    },
    {
      id: 'window',
      title: 'Fits the prompt into the 6,000-character window',
      detail:
        'The prefix keeps its last `MAX_PREFIX_CHARS`, the suffix its first `MAX_SUFFIX_CHARS`, snippets fill the rest of `PROMPT_WINDOW_CHARS = 6000`, and a request over `MAX_BODY_BYTES` is **413**. The draft sends whole files and never checks the size.',
      match: {
        python: {
          all: [/PROMPT_WINDOW_CHARS\s*=\s*6000/, /MAX_PREFIX_CHARS/, /MAX_SUFFIX_CHARS/, /status_code\s*=\s*413/],
        },
        typescript: {
          all: [/PROMPT_WINDOW_CHARS\s*=\s*6000/, /MAX_PREFIX_CHARS/, /MAX_SUFFIX_CHARS/, /code\(\s*413\s*\)/],
        },
        go: {all: [/promptWindowChars\s*=\s*6000/, /maxPrefixChars/, /maxSuffixChars/, /StatusRequestEntityTooLarge/]},
        scala: {
          all: [
            /PromptWindowChars\s*=\s*6000/,
            /MaxPrefixChars/,
            /MaxSuffixChars/,
            /StatusCodes\.RequestEntityTooLarge/,
          ],
        },
        cpp: {all: [/kPromptWindowChars\s*=\s*6000/, /kMaxPrefixChars/, /kMaxSuffixChars/, /\b413\b/]},
      },
    },
    {
      id: 'no-code-log',
      title: 'Logs ids and sizes, never the code',
      detail:
        'The completion is logged with session, request id, language, prompt size and snippet count; the prefix, suffix and tab text never reach a log line. The draft logs the prefix and suffix on every keystroke.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*(prefix|suffix|open_tabs)/]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*(prefix|suffix|open_tabs|openTabs)/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*([Pp]refix|[Ss]uffix|OpenTabs)/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^)]*(prefix|suffix|open_tabs)/]},
        cpp: {all: [/(std::)?(cerr|clog)\s*<</], none: [/(std::)?(cerr|clog)[^;]*(prefix|suffix|open_tabs)/]},
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
logger = logging.getLogger("completiond")


class OpenTab(BaseModel):
    path: str
    text: str


class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str = ""
    path: str = ""
    token: int = 0
    open_tabs: list[OpenTab] = []


def complete(prefix: str, suffix: str, snippets: list[str], language: str) -> list[str]:
    """Candidates from the model service (the gRPC step)."""
    raise NotImplementedError


@app.post("/v1/completions")
def completions(body: CompletionRequest, session: str = Header(default="", alias="X-Session-Id")) -> JSONResponse:
    # TODO: this draft serves anyone without a session, sends whole files into the prompt, returns
    # no request id for the editor to match replies against, and logs the code. Review all four.
    logger.info("complete session=%s path=%s prefix=%r suffix=%r", session, body.path, body.prefix, body.suffix)
    snippets = [tab.text for tab in body.open_tabs]
    candidates = complete(body.prefix, body.suffix, snippets, body.language)
    return JSONResponse({"token": body.token, "candidates": candidates}, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("completiond")

PROMPT_WINDOW_CHARS = 6000
MAX_PREFIX_CHARS = 3500
MAX_SUFFIX_CHARS = 1000
MAX_TABS_CHARS = PROMPT_WINDOW_CHARS - MAX_PREFIX_CHARS - MAX_SUFFIX_CHARS
MAX_OPEN_TABS = 20
MAX_BODY_BYTES = 1 << 20


class OpenTab(BaseModel):
    path: str
    text: str


class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str = ""
    path: str = ""
    token: int = 0
    open_tabs: list[OpenTab] = []


def complete(prefix: str, suffix: str, snippets: list[str], language: str) -> list[str]:
    """Candidates from the model service (the gRPC step)."""
    raise NotImplementedError


def fit_window(prefix: str, suffix: str, snippets: list[str]) -> tuple[str, str, list[str]]:
    """The prefix keeps its tail, the suffix its head, and snippets fill what is left of the window."""
    prefix = prefix[-MAX_PREFIX_CHARS:]
    suffix = suffix[:MAX_SUFFIX_CHARS]
    kept: list[str] = []
    left = MAX_TABS_CHARS
    for snippet in snippets:
        if left <= 0:
            break
        kept.append(snippet[:left])
        left -= len(kept[-1])
    return prefix, suffix, kept


@app.post("/v1/completions")
def completions(
    body: CompletionRequest, session: str | None = Header(default=None, alias="X-Session-Id")
) -> JSONResponse:
    if session is None or session == "":
        raise HTTPException(status_code=401, detail="missing X-Session-Id")
    size = len(body.prefix) + len(body.suffix) + sum(len(tab.text) for tab in body.open_tabs)
    if size > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="request exceeds 1 MiB")
    if body.language == "" or body.path == "":
        raise HTTPException(status_code=400, detail="language and path are required")

    request_id = str(uuid.uuid4())
    tabs = [tab.text for tab in body.open_tabs[:MAX_OPEN_TABS] if tab.path != body.path]
    prefix, suffix, snippets = fit_window(body.prefix, body.suffix, tabs)
    candidates = complete(prefix, suffix, snippets, body.language)
    prompt_chars = len(prefix) + len(suffix) + sum(len(s) for s in snippets)
    logger.info(
        "complete session=%s request=%s lang=%s chars=%d snippets=%d",
        session,
        request_id,
        body.language,
        prompt_chars,
        len(snippets),
    )
    return JSONResponse(
        {"request_id": request_id, "token": body.token, "candidates": candidates}, status_code=200
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/completions: a model-generated draft that sends whole files and logs them. */
import Fastify from 'fastify';

import {complete} from './fim_call';

export const app = Fastify();

interface OpenTab {
  path: string;
  text: string;
}

interface CompletionBody {
  prefix: string;
  suffix?: string;
  language?: string;
  path?: string;
  token?: number;
  open_tabs?: OpenTab[];
}

app.post('/v1/completions', async (request, reply) => {
  // TODO: this draft serves anyone without a session, sends whole files into the prompt, returns
  // no request id for the editor to match replies against, and logs the code. Review all four.
  const session = request.headers['x-session-id'] as string;
  const body = request.body as CompletionBody;
  request.log.info({session, path: body.path, prefix: body.prefix, suffix: body.suffix}, 'complete');
  const snippets = (body.open_tabs ?? []).map(tab => tab.text);
  const candidates = await complete(body.prefix, body.suffix ?? '', snippets, body.language ?? '');
  return reply.code(200).send({token: body.token ?? 0, candidates});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/completions: a session, a prompt that fits the window, an id per reply, no code in logs. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {complete} from './fim_call';

export const app = Fastify();

const PROMPT_WINDOW_CHARS = 6000;
const MAX_PREFIX_CHARS = 3500;
const MAX_SUFFIX_CHARS = 1000;
const MAX_TABS_CHARS = PROMPT_WINDOW_CHARS - MAX_PREFIX_CHARS - MAX_SUFFIX_CHARS;
const MAX_OPEN_TABS = 20;
const MAX_BODY_BYTES = 1 << 20;

interface OpenTab {
  path: string;
  text: string;
}

interface CompletionBody {
  prefix: string;
  suffix?: string;
  language?: string;
  path?: string;
  token?: number;
  open_tabs?: OpenTab[];
}

/** The prefix keeps its tail, the suffix its head, and snippets fill what is left of the window. */
function fitWindow(prefix: string, suffix: string, snippets: string[]): [string, string, string[]] {
  const kept: string[] = [];
  let left = MAX_TABS_CHARS;
  for (const snippet of snippets) {
    if (left <= 0) break;
    const piece = snippet.slice(0, left);
    kept.push(piece);
    left -= piece.length;
  }
  return [prefix.slice(-MAX_PREFIX_CHARS), suffix.slice(0, MAX_SUFFIX_CHARS), kept];
}

app.post('/v1/completions', async (request, reply) => {
  const session = request.headers['x-session-id'];
  if (typeof session !== 'string' || session === '') return reply.code(401).send({error: 'missing X-Session-Id'});
  const body = request.body as Partial<CompletionBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.prefix !== 'string')
    return reply.code(400).send({error: 'prefix must be a string'});
  const suffix = body.suffix ?? '';
  const openTabs = body.open_tabs ?? [];
  const size = body.prefix.length + suffix.length + openTabs.reduce((sum, tab) => sum + tab.text.length, 0);
  if (size > MAX_BODY_BYTES) return reply.code(413).send({error: 'request exceeds 1 MiB'});
  const language = body.language ?? '';
  const path = body.path ?? '';
  if (language === '' || path === '') return reply.code(400).send({error: 'language and path are required'});

  const requestId = randomUUID();
  const tabs = openTabs
    .slice(0, MAX_OPEN_TABS)
    .filter(tab => tab.path !== path)
    .map(tab => tab.text);
  const [prefix, suffixHead, snippets] = fitWindow(body.prefix, suffix, tabs);
  const candidates = await complete(prefix, suffixHead, snippets, language);
  const promptChars = prefix.length + suffixHead.length + snippets.reduce((sum, s) => sum + s.length, 0);
  request.log.info({session, requestId, language, promptChars, snippets: snippets.length}, 'complete');
  return reply.code(200).send({request_id: requestId, token: body.token ?? 0, candidates});
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

type OpenTab struct {
	Path string \`json:"path"\`
	Text string \`json:"text"\`
}

type CompletionRequest struct {
	Prefix   string    \`json:"prefix"\`
	Suffix   string    \`json:"suffix"\`
	Language string    \`json:"language"\`
	Path     string    \`json:"path"\`
	Token    int       \`json:"token"\`
	OpenTabs []OpenTab \`json:"open_tabs"\`
}

// complete asks the model service for candidates (the gRPC step).
func complete(prefix, suffix string, snippets []string, language string) ([]string, error) {
	return nil, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func completions(rw http.ResponseWriter, r *http.Request) {
	session := r.Header.Get("X-Session-Id")
	var body CompletionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft serves anyone without a session, sends whole files into the prompt, returns
	// no request id for the editor to match replies against, and logs the code. Review all four.
	log.Printf("complete session=%s path=%s prefix=%q suffix=%q", session, body.Path, body.Prefix, body.Suffix)
	snippets := make([]string, 0, len(body.OpenTabs))
	for _, tab := range body.OpenTabs {
		snippets = append(snippets, tab.Text)
	}
	candidates, err := complete(body.Prefix, body.Suffix, snippets, body.Language)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model unavailable"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"token": body.Token, "candidates": candidates})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/completions", completions)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	promptWindowChars = 6000
	maxPrefixChars    = 3500
	maxSuffixChars    = 1000
	maxTabsChars      = promptWindowChars - maxPrefixChars - maxSuffixChars
	maxOpenTabs       = 20
	maxBodyBytes      = 1 << 20
)

type OpenTab struct {
	Path string \`json:"path"\`
	Text string \`json:"text"\`
}

type CompletionRequest struct {
	Prefix   string    \`json:"prefix"\`
	Suffix   string    \`json:"suffix"\`
	Language string    \`json:"language"\`
	Path     string    \`json:"path"\`
	Token    int       \`json:"token"\`
	OpenTabs []OpenTab \`json:"open_tabs"\`
}

// complete asks the model service for candidates (the gRPC step).
func complete(prefix, suffix string, snippets []string, language string) ([]string, error) {
	return nil, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// fitWindow keeps the prefix's tail and the suffix's head; snippets fill what is left of the window.
func fitWindow(prefix, suffix string, snippets []string) (string, string, []string) {
	if len(prefix) > maxPrefixChars {
		prefix = prefix[len(prefix)-maxPrefixChars:]
	}
	if len(suffix) > maxSuffixChars {
		suffix = suffix[:maxSuffixChars]
	}
	kept := make([]string, 0, len(snippets))
	left := maxTabsChars
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
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Session-Id"})
		return
	}
	var body CompletionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	size := len(body.Prefix) + len(body.Suffix)
	for _, tab := range body.OpenTabs {
		size += len(tab.Text)
	}
	if size > maxBodyBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "request exceeds 1 MiB"})
		return
	}
	if body.Language == "" || body.Path == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "language and path are required"})
		return
	}

	requestID := uuid.NewString()
	tabs := make([]string, 0, maxOpenTabs)
	for i, tab := range body.OpenTabs {
		if i >= maxOpenTabs {
			break
		}
		if tab.Path != body.Path {
			tabs = append(tabs, tab.Text)
		}
	}
	prefix, suffix, snippets := fitWindow(body.Prefix, body.Suffix, tabs)
	candidates, err := complete(prefix, suffix, snippets, body.Language)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model unavailable"})
		return
	}
	promptChars := len(prefix) + len(suffix)
	for _, s := range snippets {
		promptChars += len(s)
	}
	log.Printf("complete session=%s request=%s lang=%s chars=%d snippets=%d", session, requestID, body.Language, promptChars, len(snippets))
	writeJSON(rw, http.StatusOK, map[string]any{"request_id": requestID, "token": body.Token, "candidates": candidates})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/completions", completions)
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

final case class OpenTab(path: String, text: String)
final case class CompletionRequest(
    prefix: String,
    suffix: String,
    language: String,
    path: String,
    token: Int,
    open_tabs: List[OpenTab]
)
final case class CompletionReply(token: Int, candidates: List[String])

object CompletionApi {
  implicit val system: ActorSystem = ActorSystem("completiond")
  implicit val tabFormat: RootJsonFormat[OpenTab] = jsonFormat2(OpenTab)
  implicit val requestFormat: RootJsonFormat[CompletionRequest] = jsonFormat6(CompletionRequest)
  implicit val replyFormat: RootJsonFormat[CompletionReply] = jsonFormat2(CompletionReply)

  val route: Route =
    path("v1" / "completions") {
      post {
        optionalHeaderValueByName("X-Session-Id") { sessionOpt =>
          entity(as[CompletionRequest]) { body =>
            // TODO: this draft serves anyone without a session, sends whole files into the prompt,
            // returns no request id for the editor to match replies against, and logs the code.
            val session = sessionOpt.getOrElse("")
            system.log.info(s"complete session=$session path=\${body.path} prefix=\${body.prefix} suffix=\${body.suffix}")
            val snippets = body.open_tabs.map(_.text)
            val candidates = FimCall.complete(body.prefix, body.suffix, snippets, body.language)
            complete(StatusCodes.OK, CompletionReply(body.token, candidates))
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

final case class OpenTab(path: String, text: String)
final case class CompletionRequest(
    prefix: String,
    suffix: String,
    language: String,
    path: String,
    token: Int,
    open_tabs: List[OpenTab]
)
final case class CompletionReply(request_id: String, token: Int, candidates: List[String])

object CompletionApi {
  implicit val system: ActorSystem = ActorSystem("completiond")
  implicit val tabFormat: RootJsonFormat[OpenTab] = jsonFormat2(OpenTab)
  implicit val requestFormat: RootJsonFormat[CompletionRequest] = jsonFormat6(CompletionRequest)
  implicit val replyFormat: RootJsonFormat[CompletionReply] = jsonFormat3(CompletionReply)

  val PromptWindowChars = 6000
  val MaxPrefixChars = 3500
  val MaxSuffixChars = 1000
  val MaxTabsChars = PromptWindowChars - MaxPrefixChars - MaxSuffixChars
  val MaxOpenTabs = 20
  val MaxBodyBytes = 1 << 20

  /** The prefix keeps its tail, the suffix its head, and snippets fill what is left of the window. */
  def fitWindow(prefix: String, suffix: String, snippets: List[String]): (String, String, List[String]) = {
    val kept = List.newBuilder[String]
    var left = MaxTabsChars
    snippets.foreach { snippet =>
      if (left > 0) {
        val piece = snippet.take(left)
        kept += piece
        left -= piece.length
      }
    }
    (prefix.takeRight(MaxPrefixChars), suffix.take(MaxSuffixChars), kept.result())
  }

  val route: Route =
    path("v1" / "completions") {
      post {
        optionalHeaderValueByName("X-Session-Id") { sessionOpt =>
          entity(as[CompletionRequest]) { body =>
            val size = body.prefix.length + body.suffix.length + body.open_tabs.map(_.text.length).sum
            if (!sessionOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Session-Id"}""")
            } else if (size > MaxBodyBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"request exceeds 1 MiB"}""")
            } else if (body.language.isEmpty || body.path.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"language and path are required"}""")
            } else {
              val session = sessionOpt.get
              val requestId = UUID.randomUUID().toString
              val tabs = body.open_tabs.take(MaxOpenTabs).filter(_.path != body.path).map(_.text)
              val (prefix, suffix, snippets) = fitWindow(body.prefix, body.suffix, tabs)
              val candidates = FimCall.complete(prefix, suffix, snippets, body.language)
              val promptChars = prefix.length + suffix.length + snippets.map(_.length).sum
              system.log.info(
                s"complete session=$session request=$requestId lang=\${body.language} chars=$promptChars snippets=\${snippets.size}"
              )
              complete(StatusCodes.OK, CompletionReply(requestId, body.token, candidates))
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
#include <vector>

using json = nlohmann::json;

// Candidates from the model service (the gRPC step).
std::vector<std::string> complete(
    const std::string& prefix,
    const std::string& suffix,
    const std::vector<std::string>& snippets,
    const std::string& language);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/completions", [](const httplib::Request& req, httplib::Response& res) {
    const auto session = req.get_header_value("X-Session-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft serves anyone without a session, sends whole files into the prompt, returns
    // no request id for the editor to match replies against, and logs the code. Review all four.
    const auto prefix = body.value("prefix", std::string());
    const auto suffix = body.value("suffix", std::string());
    const auto language = body.value("language", std::string());
    std::cerr << "complete session=" << session << " prefix=" << prefix << " suffix=" << suffix << "\\n";
    std::vector<std::string> snippets;
    for (const auto& tab : body.value("open_tabs", json::array())) {
      snippets.push_back(tab.value("text", std::string()));
    }
    const auto candidates = complete(prefix, suffix, snippets, language);
    res.status = 200;
    res.set_content(json{{"token", body.value("token", 0)}, {"candidates", candidates}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <iostream>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kPromptWindowChars = 6000;
constexpr std::size_t kMaxPrefixChars = 3500;
constexpr std::size_t kMaxSuffixChars = 1000;
constexpr std::size_t kMaxTabsChars = kPromptWindowChars - kMaxPrefixChars - kMaxSuffixChars;
constexpr std::size_t kMaxOpenTabs = 20;
constexpr std::size_t kMaxBodyBytes = 1 << 20;

// Candidates from the model service (the gRPC step).
std::vector<std::string> complete(
    const std::string& prefix,
    const std::string& suffix,
    const std::vector<std::string>& snippets,
    const std::string& language);
std::string uuidString();

// The prefix keeps its tail, the suffix its head, and snippets fill what is left of the window.
std::tuple<std::string, std::string, std::vector<std::string>> fitWindow(
    const std::string& prefix,
    const std::string& suffix,
    const std::vector<std::string>& snippets) {
  std::vector<std::string> kept;
  std::size_t left = kMaxTabsChars;
  for (const auto& snippet : snippets) {
    if (left == 0) break;
    kept.push_back(snippet.substr(0, left));
    left -= kept.back().size();
  }
  const auto tail = prefix.size() > kMaxPrefixChars ? prefix.substr(prefix.size() - kMaxPrefixChars) : prefix;
  return {tail, suffix.substr(0, kMaxSuffixChars), kept};
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/completions", [](const httplib::Request& req, httplib::Response& res) {
    const auto session = req.get_header_value("X-Session-Id");
    if (session.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Session-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("prefix") || !body["prefix"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"prefix must be a string"})", "application/json");
      return;
    }
    const auto prefix = body["prefix"].get<std::string>();
    const auto suffix = body.value("suffix", std::string());
    const auto language = body.value("language", std::string());
    const auto path = body.value("path", std::string());
    const json openTabs = body.value("open_tabs", json::array());
    std::size_t size = prefix.size() + suffix.size();
    for (const auto& tab : openTabs) size += tab.value("text", std::string()).size();
    if (size > kMaxBodyBytes) {
      res.status = 413;
      res.set_content(R"({"error":"request exceeds 1 MiB"})", "application/json");
      return;
    }
    if (language.empty() || path.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"language and path are required"})", "application/json");
      return;
    }

    const auto requestId = uuidString();
    std::vector<std::string> tabs;
    for (std::size_t i = 0; i < openTabs.size() && i < kMaxOpenTabs; i++) {
      if (openTabs[i].value("path", std::string()) != path) tabs.push_back(openTabs[i].value("text", std::string()));
    }
    const auto [prefixTail, suffixHead, snippets] = fitWindow(prefix, suffix, tabs);
    const auto candidates = complete(prefixTail, suffixHead, snippets, language);
    std::size_t promptChars = prefixTail.size() + suffixHead.size();
    for (const auto& s : snippets) promptChars += s.size();
    std::cerr << "complete session=" << session << " request=" << requestId << " lang=" << language
              << " chars=" << promptChars << " snippets=" << snippets.size() << "\\n";
    res.status = 200;
    res.set_content(
        json{{"request_id", requestId}, {"token", body.value("token", 0)}, {"candidates", candidates}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: session, total size, language and path. Every one of them returns before the model is touched, so a malformed request never spends a model call.',
    'The window is a budget, not a validator: slice the prefix from the end (`prefix[-MAX_PREFIX_CHARS:]`), the suffix from the start, then hand the remaining characters to the snippets in order. `PROMPT_WINDOW_CHARS - MAX_PREFIX_CHARS - MAX_SUFFIX_CHARS` is what the tabs get.',
    'The reply needs two ids: a server-made `request_id` for telemetry and the editor’s `token` echoed back so a stale reply can be dropped. The log line is a contract: session, request id, language, character count, snippet count — compute the count into a variable first so no `prefix` lands inside the logging call.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a product that sees source code on every keystroke. The draft reads fine because the demo sends small files from one session and never retries. Four defects are being checked: authentication (the session is never optional, because the open tabs in the request are one developer's code), the window budget (the model reads about 6,000 characters, so the service trims the prefix to its tail, the suffix to its head and gives the rest to snippets, instead of sending whole files or refusing them), a reply id so the editor can discard stale completions, and a log line that carries sizes and ids but never code. Real completion services add a per-session rate limit on keystrokes, a language allow-list, and a hashed prompt fingerprint for caching and debugging.`,
};
