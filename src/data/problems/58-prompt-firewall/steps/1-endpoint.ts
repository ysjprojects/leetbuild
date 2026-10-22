import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/firewall/screen: screening that fails closed on error',
  concept: 'http',
  file: 'api',
  focus: ['client', 'firewall', 'rules'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the screen endpoint: it
parses the body, runs a substring scan and answers. It compiles, it serves the happy path, and it
hides three defects that only surface when something goes wrong. Review it like the service owner,
fix it, and prove the fix with the checks below.

Implement \`POST /v1/firewall/screen\` with body \`{"prompt": "…", "channel": "user"}\`.

- \`prompt\` is a non-empty string of at most **128 KiB** (\`1 << 17\` bytes) of UTF-8; an empty
  prompt is **400**, a longer one is **413**.
- \`channel\` is one of \`user\`, \`tool\`, \`retrieval\` (**400** otherwise). An unknown channel may
  never be silently treated as \`user\`: the channel decides how aggressive the rules are, so
  guessing it is a security decision made by accident.
- Screen with the active rule set and answer with \`decision\` (\`allow\`, \`strip\` or \`block\`),
  the matched **rule ids** and the matched **spans** (character offsets) — and nothing else.
- **Fail closed.** When the rule engine raises, the answer is \`block\` with a failsafe rule id and
  no spans. An internal error must never produce \`allow\`: an outage that opens the firewall is
  worse than an outage that closes it.
- The prompt never appears in the response body. A block response is for the caller's logs and the
  on-call dashboard; echoing the prompt back turns the firewall into the place the prompt leaks from.

**Failure mode the checks target.** Three quiet ones. The draft's \`except\` returns \`allow\`, so a
broken rule store turns every injection attempt into a pass. The draft reads \`channel\` but never
validates it, so a client that sends \`channel: "system"\` gets the weakest rule set by accident. And
the draft ships the prompt back under a \`debug_prompt\` field "for debugging", which copies tenant
content into every response log and every error report that body reaches.`,
  sequence: {
    participants: ['Client', 'Prompt Firewall', 'Rule engine'],
    messages: [
      {
        from: 'Client',
        to: 'Prompt Firewall',
        label: 'POST /v1/firewall/screen · channel=user|tool|retrieval',
        kind: 'sync',
      },
      {from: 'Prompt Firewall', to: 'Client', label: '400 unknown channel · 413 over 128 KiB', kind: 'reply'},
      {from: 'Prompt Firewall', to: 'Rule engine', label: 'evaluate(prompt, channel) · active rules', kind: 'sync'},
      {from: 'Rule engine', to: 'Prompt Firewall', label: 'raise: rule store unavailable', kind: 'reply'},
      {
        from: 'Prompt Firewall',
        to: 'Client',
        label: '{decision: "block", rules: ["failsafe"], spans: []}',
        kind: 'reply',
      },
      {from: 'Prompt Firewall', to: 'Client', label: '{decision, rules, spans} · never the prompt', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'prompt-cap',
      title: 'Caps the prompt at 128 KiB and rejects an empty one',
      detail:
        'A prompt over `1 << 17` bytes is **413** and an empty prompt is **400**. The draft enforces neither, so one request can carry an unbounded amount of text through the rule engine.',
      match: {
        python: {all: [/MAX_PROMPT_BYTES/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_PROMPT_BYTES/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxPromptBytes/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {all: [/MaxPromptBytes/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxPromptBytes/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'channel',
      title: 'Validates the channel instead of defaulting it to user',
      detail:
        'The channel is checked against `user`/`tool`/`retrieval` and an unknown one is **400**. The draft never validates it, so a caller picks whichever rule set it likes — including none.',
      match: {
        python: {all: [/CHANNELS/, /"retrieval"/, /status_code\s*=\s*400/]},
        typescript: {all: [/CHANNELS/, /retrieval\s*:\s*true/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedChannels/, /"retrieval"/, /StatusBadRequest/]},
        scala: {all: [/AllowedChannels/, /"retrieval"/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kChannels/, /"retrieval"/, /\b400\b/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'An internal error blocks, it never allows',
      detail:
        'The rule-engine call is guarded and the failure path returns `block` with a `failsafe` rule id. The draft catches the same exception and returns `allow`, so a rule store outage opens the firewall completely.',
      match: {
        python: {all: [/except Exception/, /"failsafe"/]},
        typescript: {all: [/\bcatch\b/, /'failsafe'/]},
        go: {all: [/recover\(\)/, /"failsafe"/]},
        scala: {all: [/\bTry\b/, /"failsafe"/]},
        cpp: {all: [/catch\s*\(\s*\.\.\.\s*\)/, /"failsafe"/]},
      },
    },
    {
      id: 'response-shape',
      title: 'Answers with decision, rule ids and spans — never the prompt',
      detail:
        'The response body carries `decision`, `rules` and `spans` and never the prompt text. The draft returns the prompt under `debug_prompt`, which is how tenant content ends up in every response log that touches a block.',
      match: {
        python: {all: [/"decision"/, /"rules"/, /"spans"/], none: [/debug_prompt/]},
        typescript: {all: [/\bdecision\b/, /\brules\b/, /\bspans\b/], none: [/debug_prompt/]},
        go: {all: [/"decision"/, /"rules"/, /"spans"/], none: [/debug_prompt/]},
        scala: {all: [/\bdecision\b/, /\brules\b/, /\bspans\b/], none: [/debug_prompt/]},
        cpp: {all: [/"decision"/, /"rules"/, /"spans"/], none: [/debug_prompt/]},
      },
    },
    {
      id: 'rule-ids',
      title: 'Resolves the decision from a rule set with ids',
      detail:
        'The decision comes from evaluating a rule set and reports which rules matched, so a reviewer can see why a prompt was blocked. The draft scans a list of substrings and reports the substrings themselves, which are neither stable ids nor auditable.',
      match: {
        python: {all: [/RULES/, /def evaluate\(/, /matched/]},
        typescript: {all: [/RULES/, /function evaluate\(/, /matched/]},
        go: {all: [/func evaluate\(/, /\brules\b/, /matched/]},
        scala: {all: [/def evaluate\(/, /\bRules\b/, /matched/]},
        cpp: {all: [/kRules/, /evaluate\(/, /matched/]},
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
logger = logging.getLogger("firewall")

BLOCK_PATTERNS = ("ignore all previous", "assistant:")


class ScreenRequest(BaseModel):
    prompt: str
    channel: str = "user"


@app.post("/v1/firewall/screen")
def screen(body: ScreenRequest) -> JSONResponse:
    # TODO: the draft returns allow on any internal error, never validates the channel, and echoes
    # the prompt back under debug_prompt. Fail closed with a failsafe rule id, answer 400 for an
    # unknown channel, and return decision, rule ids and spans only.
    try:
        matched = [pattern for pattern in BLOCK_PATTERNS if pattern in body.prompt]
    except Exception:
        logger.exception("screen failed")
        return JSONResponse({"decision": "allow"}, status_code=200)
    decision = "block" if matched else "allow"
    return JSONResponse({"decision": decision, "debug_prompt": body.prompt}, status_code=200)
`,
      solution: `import logging
import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("firewall")

MAX_PROMPT_BYTES = 1 << 17
CHANNELS = {"user", "tool", "retrieval"}
FAILSAFE_RULES = ["failsafe"]

RULES = (
    {"id": "inj-ignore", "pattern": re.compile(r"ignore (all )?previous", re.I), "decision": "block"},
    {"id": "inj-delimiter", "pattern": re.compile(r"<\\|[^|]*\\|>"), "decision": "block"},
    {"id": "exfil-url", "pattern": re.compile(r"https?://\\S+"), "decision": "strip"},
)


class ScreenRequest(BaseModel):
    prompt: str
    channel: str = "user"


def evaluate(prompt: str, channel: str) -> dict:
    """Evaluate the active rule set: the decision, the matched rule ids and the character spans."""
    matched = [rule for rule in RULES if rule["pattern"].search(prompt)]
    spans = [
        {"start": match.start(), "end": match.end()}
        for rule in matched
        for match in rule["pattern"].finditer(prompt)
    ]
    if not matched:
        return {"decision": "allow", "rules": [], "spans": []}
    decision = "block" if any(rule["decision"] == "block" for rule in matched) else "strip"
    return {"decision": decision, "rules": [rule["id"] for rule in matched], "spans": spans}


@app.post("/v1/firewall/screen")
def screen(body: ScreenRequest) -> JSONResponse:
    if body.prompt == "":
        raise HTTPException(status_code=400, detail="prompt must be non-empty")
    if body.channel not in CHANNELS:
        raise HTTPException(status_code=400, detail="unknown channel")
    if len(body.prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise HTTPException(status_code=413, detail="prompt exceeds 128 KiB")

    try:
        result = evaluate(body.prompt, body.channel)
    except Exception:
        logger.exception("screen failed channel=%s", body.channel)
        return JSONResponse({"decision": "block", "rules": FAILSAFE_RULES, "spans": []}, status_code=200)

    logger.info("screen decision=%s rules=%s channel=%s", result["decision"], result["rules"], body.channel)
    return JSONResponse(result, status_code=200)
`,
    },
    typescript: {
      starter: `/** A model-generated draft of POST /v1/firewall/screen that fails open. */
import Fastify from 'fastify';

export const app = Fastify();

const BLOCK_PATTERNS = ['ignore all previous', 'assistant:'];

interface ScreenBody {
  prompt: string;
  channel?: string;
}

app.post('/v1/firewall/screen', async (request, reply) => {
  // TODO: the draft returns allow on any internal error, never validates the channel, and echoes
  // the prompt back under debug_prompt. Fail closed with a failsafe rule id, answer 400 for an
  // unknown channel, and return decision, rule ids and spans only.
  const body = request.body as ScreenBody;
  try {
    const matched = BLOCK_PATTERNS.filter(pattern => body.prompt.includes(pattern));
    const decision = matched.length > 0 ? 'block' : 'allow';
    return reply.code(200).send({decision, debug_prompt: body.prompt});
  } catch {
    request.log.error('screen failed');
    return reply.code(200).send({decision: 'allow'});
  }
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/firewall/screen: validate, evaluate the active rules, fail closed on error. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_PROMPT_BYTES = 1 << 17;
const CHANNELS: Record<string, true> = {user: true, tool: true, retrieval: true};
const FAILSAFE_RULES = ['failsafe'];

interface Rule {
  id: string;
  pattern: RegExp;
  decision: 'block' | 'strip';
}

const RULES: Rule[] = [
  {id: 'inj-ignore', pattern: /ignore (all )?previous/i, decision: 'block'},
  {id: 'inj-delimiter', pattern: /<\\|[^|]*\\|>/, decision: 'block'},
  {id: 'exfil-url', pattern: /https?:\\/\\/\\S+/, decision: 'strip'},
];

interface ScreenBody {
  prompt: string;
  channel?: string;
}

export function evaluate(prompt: string, channel: string) {
  const matched = RULES.filter(rule => rule.pattern.test(prompt));
  const spans = matched.flatMap(rule => {
    const found: {start: number; end: number}[] = [];
    for (const match of prompt.matchAll(new RegExp(rule.pattern.source, 'g')))
      found.push({start: match.index ?? 0, end: (match.index ?? 0) + match[0].length});
    return found;
  });
  if (matched.length === 0) return {decision: 'allow', rules: [] as string[], spans};
  const decision = matched.some(rule => rule.decision === 'block') ? 'block' : 'strip';
  return {decision, rules: matched.map(rule => rule.id), spans};
}

app.post('/v1/firewall/screen', async (request, reply) => {
  const body = request.body as Partial<ScreenBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.prompt !== 'string' || body.prompt === '')
    return reply.code(400).send({error: 'prompt must be a non-empty string'});
  const channel = body.channel ?? 'user';
  if (CHANNELS[channel] !== true) return reply.code(400).send({error: 'unknown channel'});
  if (Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES)
    return reply.code(413).send({error: 'prompt exceeds 128 KiB'});

  try {
    const result = evaluate(body.prompt, channel);
    request.log.info({decision: result.decision, rules: result.rules, channel}, 'screened');
    return reply.code(200).send(result);
  } catch {
    request.log.error({channel}, 'screen failed');
    return reply.code(200).send({decision: 'block', rules: FAILSAFE_RULES, spans: []});
  }
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
	"strings"
)

var blockPatterns = []string{"ignore all previous", "assistant:"}

type ScreenRequest struct {
	Prompt  string \`json:"prompt"\`
	Channel string \`json:"channel"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func screen(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft returns allow on any internal error, never validates the channel, and echoes
	// the prompt back under debug_prompt. Fail closed with a failsafe rule id, answer 400 for an
	// unknown channel, and return decision, rule ids and spans only.
	var body ScreenRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	matched := []string{}
	for _, pattern := range blockPatterns {
		if strings.Contains(body.Prompt, pattern) {
			matched = append(matched, pattern)
		}
	}
	decision := "allow"
	if len(matched) > 0 {
		decision = "block"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"decision": decision, "debug_prompt": body.Prompt})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/firewall/screen", screen)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
)

const maxPromptBytes = 1 << 17 // 128 KiB

var allowedChannels = map[string]bool{"user": true, "tool": true, "retrieval": true}

var failsafeRules = []string{"failsafe"}

type Rule struct {
	ID       string
	Pattern  *regexp.Regexp
	Decision string
}

var rules = []Rule{
	{ID: "inj-ignore", Pattern: regexp.MustCompile(\`(?i)ignore (all )?previous\`), Decision: "block"},
	{ID: "inj-delimiter", Pattern: regexp.MustCompile(\`<\\|[^|]*\\|>\`), Decision: "block"},
	{ID: "exfil-url", Pattern: regexp.MustCompile(\`https?://\\S+\`), Decision: "strip"},
}

type ScreenRequest struct {
	Prompt  string \`json:"prompt"\`
	Channel string \`json:"channel"\`
}

type Span struct {
	Start int \`json:"start"\`
	End   int \`json:"end"\`
}

type Verdict struct {
	Decision string   \`json:"decision"\`
	Rules    []string \`json:"rules"\`
	Spans    []Span   \`json:"spans"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// evaluate matches the prompt against the active rule set and reports what matched.
func evaluate(prompt, channel string) Verdict {
	verdict := Verdict{Decision: "allow", Rules: []string{}, Spans: []Span{}}
	var matched []Rule
	for _, rule := range rules {
		if rule.Pattern.MatchString(prompt) {
			matched = append(matched, rule)
		}
	}
	for _, rule := range matched {
		verdict.Rules = append(verdict.Rules, rule.ID)
		for _, loc := range rule.Pattern.FindAllStringIndex(prompt, -1) {
			verdict.Spans = append(verdict.Spans, Span{Start: loc[0], End: loc[1]})
		}
		if rule.Decision == "block" {
			verdict.Decision = "block"
		} else if verdict.Decision == "allow" {
			verdict.Decision = "strip"
		}
	}
	return verdict
}

// screenSafely fails closed: a panic inside the rule engine blocks, it never allows.
func screenSafely(prompt, channel string) (verdict Verdict) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("screen failed channel=%s: %v", channel, recovered)
			verdict = Verdict{Decision: "block", Rules: failsafeRules, Spans: []Span{}}
		}
	}()
	return evaluate(prompt, channel)
}

func screen(rw http.ResponseWriter, r *http.Request) {
	var body ScreenRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Prompt == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "prompt must be non-empty"})
		return
	}
	channel := body.Channel
	if channel == "" {
		channel = "user"
	}
	if !allowedChannels[channel] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown channel"})
		return
	}
	if len([]byte(body.Prompt)) > maxPromptBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "prompt exceeds 128 KiB"})
		return
	}
	verdict := screenSafely(body.Prompt, channel)
	log.Printf("screen decision=%s rules=%v channel=%s", verdict.Decision, verdict.Rules, channel)
	writeJSON(rw, http.StatusOK, verdict)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/firewall/screen", screen)
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

final case class ScreenRequest(prompt: String, channel: String)

object FirewallApi {
  implicit val system: ActorSystem = ActorSystem("prompt-firewall")
  implicit val requestFormat: RootJsonFormat[ScreenRequest] = jsonFormat2(ScreenRequest)

  val BlockPatterns = List("ignore all previous", "assistant:")

  val route: Route =
    path("v1" / "firewall" / "screen") {
      post {
        entity(as[ScreenRequest]) { body =>
          // TODO: the draft returns allow on any internal error, never validates the channel, and
          // echoes the prompt back under debug_prompt. Fail closed with a failsafe rule id, answer
          // 400 for an unknown channel, and return decision, rule ids and spans only.
          val matched = BlockPatterns.filter(body.prompt.contains)
          val decision = if (matched.nonEmpty) "block" else "allow"
          complete(StatusCodes.OK, s"""{"decision":"$decision","debug_prompt":"\${body.prompt}"}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.util.Try

final case class ScreenRequest(prompt: String, channel: String)
final case class Span(start: Int, end: Int)
final case class Verdict(decision: String, rules: List[String], spans: List[Span])
final case class Rule(id: String, pattern: String, decision: String)

object FirewallApi {
  implicit val system: ActorSystem = ActorSystem("prompt-firewall")
  implicit val requestFormat: RootJsonFormat[ScreenRequest] = jsonFormat2(ScreenRequest)
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat2(Span)
  implicit val verdictFormat: RootJsonFormat[Verdict] = jsonFormat3(Verdict)

  val MaxPromptBytes = 1 << 17
  val AllowedChannels = Set("user", "tool", "retrieval")
  val FailsafeRules = List("failsafe")

  val Rules = List(
    Rule("inj-ignore", "(?i)ignore (all )?previous", "block"),
    Rule("inj-delimiter", "<\\\\|[^|]*\\\\|>", "block"),
    Rule("exfil-url", "https?://\\\\S+", "strip"),
  )

  def evaluate(prompt: String, channel: String): Verdict = {
    val matched = Rules.filter(rule => rule.pattern.r.findFirstIn(prompt).nonEmpty)
    if (matched.isEmpty) Verdict("allow", Nil, Nil)
    else {
      val decision = if (matched.exists(_.decision == "block")) "block" else "strip"
      val spans = matched.flatMap(rule => rule.pattern.r.findAllMatchIn(prompt).map(m => Span(m.start, m.end)))
      Verdict(decision, matched.map(_.id), spans)
    }
  }

  val route: Route =
    path("v1" / "firewall" / "screen") {
      post {
        entity(as[ScreenRequest]) { body =>
          if (body.prompt.isEmpty) complete(StatusCodes.BadRequest, "prompt must be non-empty")
          else if (!AllowedChannels.contains(body.channel)) complete(StatusCodes.BadRequest, "unknown channel")
          else if (body.prompt.getBytes("UTF-8").length > MaxPromptBytes)
            complete(StatusCodes.RequestEntityTooLarge, "prompt exceeds 128 KiB")
          else {
            val verdict = Try(evaluate(body.prompt, body.channel)).recover { case error =>
              system.log.error(error, s"screen failed channel=\${body.channel}")
              Verdict("block", FailsafeRules, Nil)
            }.get
            system.log.info(s"screen decision=\${verdict.decision} rules=\${verdict.rules} channel=\${body.channel}")
            complete(StatusCodes.OK, verdict)
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

const std::vector<std::string> kBlockPatterns = {"ignore all previous", "assistant:"};

std::string screenDecision(const std::string& prompt) {
  for (const auto& pattern : kBlockPatterns) {
    if (prompt.find(pattern) != std::string::npos) return "block";
  }
  return "allow";
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/firewall/screen", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: the draft returns allow on any internal error, never validates the channel, and echoes
    // the prompt back under debug_prompt. Fail closed with a failsafe rule id, answer 400 for an
    // unknown channel, and return decision, rule ids and spans only.
    const auto prompt = body.value("prompt", std::string());
    const auto decision = screenDecision(prompt);
    std::cerr << "screen prompt=" << prompt << "\\n";
    res.status = 200;
    res.set_content(json{{"decision", decision}, {"debug_prompt", prompt}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <regex>
#include <set>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxPromptBytes = 1 << 17;
const std::set<std::string> kChannels = {"user", "tool", "retrieval"};
const std::vector<std::string> kFailsafeRules = {"failsafe"};

struct Rule {
  std::string id;
  std::regex pattern;
  std::string decision;
};

const std::vector<Rule> kRules = {
    {"inj-ignore", std::regex("ignore (all )?previous", std::regex::icase), "block"},
    {"inj-delimiter", std::regex(R"(<\\|[^|]*\\|>)"), "block"},
    {"exfil-url", std::regex(R"(https?://\\S+)"), "strip"},
};

json evaluate(const std::string& prompt, const std::string& channel) {
  std::string decision = "allow";
  std::vector<std::string> matched;
  json spans = json::array();
  for (const auto& rule : kRules) {
    bool hit = false;
    for (auto it = std::sregex_iterator(prompt.begin(), prompt.end(), rule.pattern); it != std::sregex_iterator(); ++it) {
      hit = true;
      spans.push_back({{"start", static_cast<int>(it->position())},
                       {"end", static_cast<int>(it->position() + it->length())}});
    }
    if (!hit) continue;
    matched.push_back(rule.id);
    if (rule.decision == "block") decision = "block";
    else if (decision == "allow") decision = "strip";
  }
  return json{{"decision", decision}, {"rules", matched}, {"spans", spans}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/firewall/screen", [](const httplib::Request& req, httplib::Response& res) {
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
    const auto channel = body.value("channel", std::string("user"));
    if (kChannels.count(channel) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown channel"})", "application/json");
      return;
    }
    if (prompt.size() > kMaxPromptBytes) {
      res.status = 413;
      res.set_content(R"({"error":"prompt exceeds 128 KiB"})", "application/json");
      return;
    }

    json verdict;
    try {
      verdict = evaluate(prompt, channel);
    } catch (...) {
      std::clog << "screen failed channel=" << channel << "\\n";
      verdict = json{{"decision", "block"}, {"rules", kFailsafeRules}, {"spans", json::array()}};
    }
    res.status = 200;
    res.set_content(verdict.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order: prompt shape, channel whitelist, byte length. All three reject before the rule engine runs, and all three answer with a status the caller can act on (400/413) instead of a decision it has to interpret.',
    'The failure path is the whole point of the step. Wrap only the rule-engine call, and make the fallback a *block* with a rule id of its own (`failsafe`), so an outage reads in the audit trail exactly like a blocked prompt — never like an allowed one. `except: return allow` is the single line that turns a rule outage into an open firewall.',
    'The response is an interface. `decision`, `rules`, `spans` are enough for the caller to log, alert and render; the prompt itself belongs to the tenant. If debugging needs the input, log its length and a hash beside the decision — never the text, and never in the response body.',
  ],
  debrief: `The interviewer is testing the failure policy of a gate, which is the only part of a firewall that a reviewer cannot read off the happy path. Three defects are checked: validation of the channel (the caller must not be able to pick its own ruleset), the cap (cheap rejection before expensive work), and the fail-closed handler. The last one is the interview: an exception in the rule engine must degrade to \`block\`, not to \`allow\`, because the two failure modes are not symmetric — a false block is a support ticket, a false allow is an incident. The fourth, quietest defect is the echoed prompt: a block response carrying the input is a copy of the tenant's data in a place you do not control. Real firewalls add per-rule confidence thresholds, a rule-version stamp on every decision (step 5), and a rate limit on how often a single rule may fire before it pages someone.`,
};
