import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/guardrails/check: the pre-model gate',
  concept: 'http',
  file: 'api',
  focus: ['client', 'guardrail', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and answers with a verdict from the rules the caller sent. It compiles, it serves the demo,
and it hides three production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement \`POST /v1/guardrails/check\` with body \`{"direction": "input", "text": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`direction\` is \`input\` or \`output\`; anything else is **400**. The draft trims nothing and
  treats an unknown direction as \`input\`, so \`"INPUT"\` and \`"system"\` both silently scan the
  wrong rule set.
- \`text\` is a non-empty string of at most **64 KiB** (\`1 << 16\` bytes) of UTF-8; a larger text is
  **413**. It is checked before any rule runs, because scanning a 10 MiB document is the expensive
  part of the request.
- The rules come from **server-side config** (\`SERVER_RULES\`, resolved by \`resolveRules\`), never
  from the request body. The draft accepts \`rules: ["…"]\` and evaluates whatever the caller sends:
  a caller can switch the gate off by sending an empty list or an unknown rule id that never fires.
  A rule the tenant does not own is not a rule.
- The verdict is \`allow\`, \`block\` or \`review\` (\`VERDICT_ALLOW\`, \`VERDICT_BLOCK\`,
  \`VERDICT_REVIEW\`). A \`block\`-severity rule that matches yields \`block\`; \`review\`-severity
  matches yield \`review\` when nothing blocked, and \`allow\` when nothing matched.
- A verdict of \`block\` returns the **rule ids** that fired and their **spans** — the
  \`[start, end)\` character offsets of each match — and never the offending text. The draft echoes
  the whole text back, which copies tenant content into every caller's logs and traces.
- Log the decision with tenant, direction, verdict and rule ids. The text never reaches a log line.

**Failure mode the checks target.** The subtle one is the rule source: a guardrail whose policy
arrives in the request is not a guardrail, it is a suggestion, and the failure is invisible because
the demo sends the right list. The loud one is the echoed text on a block, which turns the moment you
most want to be careful into a second, uncontrolled copy of prompt content. The caps are the cheap
one: reject before scanning, and the gate cannot be used as a free parser.`,
  sequence: {
    participants: ['Client', 'Guardrail Service', 'rule config'],
    messages: [
      {
        from: 'Client',
        to: 'Guardrail Service',
        label: 'POST /v1/guardrails/check · X-Tenant-Id · direction · text',
        kind: 'sync',
      },
      {
        from: 'Guardrail Service',
        to: 'Guardrail Service',
        label: '401 tenant · 400 direction · 413 over 64 KiB',
        kind: 'sync',
      },
      {from: 'Guardrail Service', to: 'rule config', label: 'resolveRules(direction)', kind: 'sync'},
      {from: 'rule config', to: 'Guardrail Service', label: 'server-side rule set (body rules ignored)', kind: 'reply'},
      {from: 'Guardrail Service', to: 'Guardrail Service', label: 'scan spans · combine block/review', kind: 'sync'},
      {from: 'Guardrail Service', to: 'Client', label: '200 {verdict, rule_ids, spans}', kind: 'reply'},
    ],
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, direction, text shape, byte length. Each one returns before a single regex runs, so a malformed or oversized request costs nothing.',
    'The body is data, not policy: parse `direction` and `text` and drop every other key. `SERVER_RULES` is the service’s own config — resolve it by the validated direction so the caller cannot name a rule set, or an empty one.',
    'Spans are what makes the response useful without the text: record each match’s `[start, end)` while you scan, and return `rule_ids` deduped and sorted. If a reviewer needs the phrase they can slice the text they already hold; the response must not carry it.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/guardrails/check',
      detail: 'Register the check route on `POST /v1/guardrails/check`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/guardrails\/check["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/guardrails\/check['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/guardrails\/check"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"guardrails"\s*\/\s*"check"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/guardrails\/check"/]},
      },
    },
    {
      id: 'server-rules',
      title: 'Resolves the rules from server-side config',
      detail:
        'The rule set comes from `SERVER_RULES` through `resolveRules(direction)`; nothing in the request body contributes a rule. The draft evaluates `body.rules`, so a caller can pass an empty list or an id that never fires and the gate answers `allow`.',
      match: {
        python: {all: [/SERVER_RULES/, /def resolve_rules\(/]},
        typescript: {all: [/SERVER_RULES/, /function resolveRules\(/]},
        go: {all: [/serverRules/, /func resolveRules\(/]},
        scala: {all: [/ServerRules/, /def resolveRules\(/]},
        cpp: {all: [/kServerRules/, /resolveRules\(/]},
      },
    },
    {
      id: 'input-guards',
      title: 'Validates the direction and the 64 KiB cap',
      detail:
        '`direction` is checked against `input`/`output` (**400** otherwise) and the UTF-8 length of `text` is capped at `1 << 16` bytes (**413**). The draft validates neither, so an unknown direction scans the wrong policy and an oversized body is parsed anyway.',
      match: {
        python: {all: [/DIRECTIONS/, /status_code\s*=\s*400/, /MAX_TEXT_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/DIRECTIONS/, /code\(\s*400\s*\)/, /MAX_TEXT_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/directions/, /StatusBadRequest/, /maxTextBytes/, /StatusRequestEntityTooLarge/]},
        scala: {
          all: [/Directions/, /StatusCodes\.BadRequest/, /MaxTextBytes/, /StatusCodes\.RequestEntityTooLarge/],
        },
        cpp: {all: [/kDirections/, /\b400\b/, /kMaxTextBytes/, /\b413\b/]},
      },
    },
    {
      id: 'verdicts',
      title: 'Answers allow, block or review from rule severity',
      detail:
        'The verdict is one of `VERDICT_ALLOW`/`VERDICT_BLOCK`/`VERDICT_REVIEW`: a blocking match wins, a review-only match yields `review`, no match yields `allow`. The draft collapses everything to `block`/`allow` from a boolean.',
      match: {
        python: {all: [/VERDICT_ALLOW/, /VERDICT_BLOCK/, /VERDICT_REVIEW/]},
        typescript: {all: [/VERDICT_ALLOW/, /VERDICT_BLOCK/, /VERDICT_REVIEW/]},
        go: {all: [/verdictAllow/, /verdictBlock/, /verdictReview/]},
        scala: {all: [/VerdictAllow/, /VerdictBlock/, /VerdictReview/]},
        cpp: {all: [/kVerdictAllow/, /kVerdictBlock/, /kVerdictReview/]},
      },
    },
    {
      id: 'no-text-leak',
      title: 'Returns rule ids and spans, never the text',
      detail:
        'A block answers with `rule_ids` and `spans`; the text never appears in the response or in a log line. The draft echoes `text` back and logs it, so tenant content leaves the service twice per request.',
      match: {
        python: {all: [/spans/, /rule_ids/], none: [/"text"\s*:/, /logger\.\w+\([^)]*text/i]},
        typescript: {all: [/spans/, /rule_ids/], none: [/text:\s*body\.text/, /log\.\w+\([^)]*\btext\b/]},
        go: {all: [/Spans/, /RuleIDs/], none: [/"text":\s*/, /log\.\w+\([^)]*[Tt]ext/]},
        scala: {all: [/spans/, /rule_ids/], none: [/"text"\s*:/, /log\.info\([^)]*text/]},
        cpp: {all: [/spans/, /rule_ids/], none: [/\{\s*"text"\s*,/, /(std::)?(cerr|clog)\s*<<[^;]*text/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import re

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("guardrail")

MAX_TEXT_BYTES = 1 << 16


class CheckRequest(BaseModel):
    direction: str = "input"
    text: str
    rules: list[str] = []


def check_rules(text: str, rules: list[str]) -> list[str]:
    """The draft: the caller names the rules, and a name that never fires allows the text."""
    return [rule for rule in rules if re.search(rule, text)]


@app.post("/v1/guardrails/check")
def check(body: CheckRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: resolve the rules from SERVER_RULES instead of body.rules, answer 400 for an unknown
    # direction and 413 for text over 64 KiB, and return rule ids with spans instead of the text.
    fired = check_rules(body.text, body.rules)
    verdict = "block" if fired else "allow"
    logger.info("guardrail tenant=%s text=%r", tenant, body.text)
    return JSONResponse({"verdict": verdict, "rule_ids": fired, "text": body.text}, status_code=200)
`,
      solution: `import logging
import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("guardrail")

MAX_TEXT_BYTES = 1 << 16
VERDICT_ALLOW = "allow"
VERDICT_BLOCK = "block"
VERDICT_REVIEW = "review"
DIRECTIONS = ("input", "output")

# Server-side policy: the caller names a direction, the service owns the rules and their severity.
SERVER_RULES = {
    "input": [
        {"id": "prompt-injection", "pattern": r"ignore (all )?previous instructions", "severity": "block"},
        {"id": "system-prompt-probe", "pattern": r"repeat your (system )?prompt", "severity": "review"},
        {"id": "secret-probe", "pattern": r"(api[_-]?key|password)s*[:=]", "severity": "block"},
    ],
    "output": [
        {"id": "pii-email", "pattern": r"[w.+-]+@[w-]+.[w.]+", "severity": "review"},
        {"id": "malware-recipe", "pattern": r"rm -rf /", "severity": "block"},
    ],
}


class CheckRequest(BaseModel):
    direction: str
    text: str


def resolve_rules(direction: str) -> list[dict]:
    """The rule set the service owns for this direction; the request body never contributes."""
    return SERVER_RULES[direction]


def scan(text: str, direction: str) -> tuple[str, list[str], list[list[int]]]:
    verdict = VERDICT_ALLOW
    fired: set[str] = set()
    spans: list[list[int]] = []
    for rule in resolve_rules(direction):
        for match in re.finditer(rule["pattern"], text, re.IGNORECASE):
            fired.add(rule["id"])
            spans.append([match.start(), match.end()])
            if rule["severity"] == "block":
                verdict = VERDICT_BLOCK
            elif verdict == VERDICT_ALLOW:
                verdict = VERDICT_REVIEW
    return verdict, sorted(fired), spans


@app.post("/v1/guardrails/check")
def check(body: CheckRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.direction not in DIRECTIONS:
        raise HTTPException(status_code=400, detail="direction must be input or output")
    if body.text == "":
        raise HTTPException(status_code=400, detail="text must be a non-empty string")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 64 KiB")
    verdict, rule_ids, spans = scan(body.text, body.direction)
    logger.info("guardrail tenant=%s direction=%s verdict=%s rules=%s", tenant, body.direction, verdict, rule_ids)
    return JSONResponse({"verdict": verdict, "rule_ids": rule_ids, "spans": spans}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/guardrails/check: a model-generated draft that trusts the caller's rules. */
import Fastify from 'fastify';

export const app = Fastify();

interface CheckBody {
  direction?: string;
  text: string;
  rules?: string[];
}

app.post('/v1/guardrails/check', async (request, reply) => {
  // TODO: resolve the rules from SERVER_RULES instead of the request body, answer 400 for an
  // unknown direction and 413 for text over 64 KiB, and return rule ids with spans, not the text.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as CheckBody;
  const rules = body.rules ?? [];
  const fired = rules.filter(rule => new RegExp(rule).test(body.text));
  const verdict = fired.length > 0 ? 'block' : 'allow';
  request.log.info({tenant, text: body.text}, 'checked');
  return reply.code(200).send({verdict, rule_ids: fired, text: body.text});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/guardrails/check: server-side rules, validated input, verdicts with spans. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_TEXT_BYTES = 1 << 16;
const VERDICT_ALLOW = 'allow';
const VERDICT_BLOCK = 'block';
const VERDICT_REVIEW = 'review';
const DIRECTIONS = ['input', 'output'];

interface Rule {
  id: string;
  pattern: RegExp;
  severity: 'block' | 'review';
}

/** Server-side policy: the caller names a direction, the service owns the rules and their severity. */
const SERVER_RULES: Record<string, Rule[]> = {
  input: [
    {id: 'prompt-injection', pattern: /ignore (all )?previous instructions/i, severity: 'block'},
    {id: 'system-prompt-probe', pattern: /repeat your (system )?prompt/i, severity: 'review'},
    {id: 'secret-probe', pattern: /(api[_-]?key|password)s*[:=]/i, severity: 'block'},
  ],
  output: [
    {id: 'pii-email', pattern: /[w.+-]+@[w-]+.[w.]+/, severity: 'review'},
    {id: 'malware-recipe', pattern: /rm -rf //, severity: 'block'},
  ],
};

interface CheckBody {
  direction: string;
  text: string;
}

interface ScanResult {
  verdict: string;
  rule_ids: string[];
  spans: Array<[number, number]>;
}

function resolveRules(direction: string): Rule[] {
  return SERVER_RULES[direction];
}

function scan(content: string, direction: string): ScanResult {
  const fired = new Set<string>();
  const spans: Array<[number, number]> = [];
  let verdict: string = VERDICT_ALLOW;
  for (const rule of resolveRules(direction)) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : \`\${rule.pattern.flags}g\`;
    for (const match of content.matchAll(new RegExp(rule.pattern.source, flags))) {
      fired.add(rule.id);
      const start = match.index ?? 0;
      spans.push([start, start + match[0].length]);
      if (rule.severity === 'block') verdict = VERDICT_BLOCK;
      else if (verdict === VERDICT_ALLOW) verdict = VERDICT_REVIEW;
    }
  }
  return {verdict, rule_ids: [...fired].sort(), spans};
}

app.post('/v1/guardrails/check', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<CheckBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.text !== 'string' || body.text === '')
    return reply.code(400).send({error: 'text must be a non-empty string'});
  const direction = body.direction;
  if (typeof direction !== 'string' || !DIRECTIONS.includes(direction))
    return reply.code(400).send({error: 'direction must be input or output'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES)
    return reply.code(413).send({error: 'text exceeds 64 KiB'});

  const result = scan(body.text, direction);
  request.log.info({tenant, direction, verdict: result.verdict, rule_ids: result.rule_ids}, 'checked');
  return reply.code(200).send(result);
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
	"regexp"
)

type CheckRequest struct {
	Direction string   \`json:"direction"\`
	Text      string   \`json:"text"\`
	Rules     []string \`json:"rules"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func check(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: resolve the rules from serverRules instead of body.Rules, answer 400 for an unknown
	// direction and 413 for text over 64 KiB, and return rule ids with spans, not the text.
	fired := []string{}
	for _, rule := range body.Rules {
		if re, err := regexp.Compile(rule); err == nil && re.MatchString(body.Text) {
			fired = append(fired, rule)
		}
	}
	verdict := "allow"
	if len(fired) > 0 {
		verdict = "block"
	}
	log.Printf("guardrail tenant=%s text=%q", tenant, body.Text)
	writeJSON(rw, http.StatusOK, map[string]any{"verdict": verdict, "rule_ids": fired, "text": body.Text})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/guardrails/check", check)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"sort"
)

const (
	maxTextBytes  = 1 << 16
	verdictAllow  = "allow"
	verdictBlock  = "block"
	verdictReview = "review"
)

var directions = map[string]bool{"input": true, "output": true}

type rule struct {
	ID       string
	Pattern  *regexp.Regexp
	Severity string
}

// serverRules is service-owned policy: the caller names a direction, never a rule.
var serverRules = map[string][]rule{
	"input": {
		{ID: "prompt-injection", Pattern: regexp.MustCompile(\`(?i)ignore (all )?previous instructions\`), Severity: "block"},
		{ID: "system-prompt-probe", Pattern: regexp.MustCompile(\`(?i)repeat your (system )?prompt\`), Severity: "review"},
		{ID: "secret-probe", Pattern: regexp.MustCompile(\`(?i)(api[_-]?key|password)\\s*[:=]\`), Severity: "block"},
	},
	"output": {
		{ID: "pii-email", Pattern: regexp.MustCompile(\`[\\w.+-]+@[\\w-]+\\.[\\w.]+\`), Severity: "review"},
		{ID: "malware-recipe", Pattern: regexp.MustCompile(\`rm -rf /\`), Severity: "block"},
	},
}

type CheckRequest struct {
	Direction string \`json:"direction"\`
	Text      string \`json:"text"\`
}

type Span struct {
	Start int \`json:"start"\`
	End   int \`json:"end"\`
}

type CheckResponse struct {
	Verdict string   \`json:"verdict"\`
	RuleIDs []string \`json:"rule_ids"\`
	Spans   []Span   \`json:"spans"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func resolveRules(direction string) []rule {
	return serverRules[direction]
}

func scan(content, direction string) CheckResponse {
	seen := map[string]bool{}
	spans := []Span{}
	verdict := verdictAllow
	for _, r := range resolveRules(direction) {
		for _, loc := range r.Pattern.FindAllStringIndex(content, -1) {
			seen[r.ID] = true
			spans = append(spans, Span{Start: loc[0], End: loc[1]})
			if r.Severity == "block" {
				verdict = verdictBlock
			} else if verdict == verdictAllow {
				verdict = verdictReview
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return CheckResponse{Verdict: verdict, RuleIDs: ids, Spans: spans}
}

func check(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !directions[body.Direction] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "direction must be input or output"})
		return
	}
	if body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
		return
	}
	if len([]byte(body.Text)) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 64 KiB"})
		return
	}
	result := scan(body.Text, body.Direction)
	log.Printf("guardrail tenant=%s direction=%s verdict=%s rules=%v", tenant, body.Direction, result.Verdict, result.RuleIDs)
	writeJSON(rw, http.StatusOK, result)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/guardrails/check", check)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.regex.Pattern

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CheckRequest(direction: String, text: String, rules: List[String])

object GuardrailApi {
  implicit val system: ActorSystem = ActorSystem("guardrail")
  implicit val checkFormat: RootJsonFormat[CheckRequest] = jsonFormat3(CheckRequest)

  val route: Route =
    path("v1" / "guardrails" / "check") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[CheckRequest]) { body =>
            // TODO: resolve the rules from ServerRules instead of body.rules, answer 400 for an
            // unknown direction and 413 over 64 KiB, and return rule ids with spans, not the text.
            val fired = body.rules.filter(rule => rule.nonEmpty && Pattern.compile(rule).matcher(body.text).find())
            val verdict = if (fired.nonEmpty) "block" else "allow"
            system.log.info(s"guardrail tenant=$tenant text=\${body.text}")
            complete(StatusCodes.OK, s"""{"verdict":"$verdict","rule_ids":[],"text":"\${body.text}"}""")
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
import java.util.regex.Pattern

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CheckRequest(direction: String, text: String)
final case class Span(start: Int, end: Int)
final case class CheckResponse(verdict: String, rule_ids: List[String], spans: List[Span])
final case class Rule(id: String, pattern: Pattern, severity: String)

object GuardrailApi {
  implicit val system: ActorSystem = ActorSystem("guardrail")
  implicit val checkFormat: RootJsonFormat[CheckRequest] = jsonFormat2(CheckRequest)
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat2(Span)
  implicit val responseFormat: RootJsonFormat[CheckResponse] = jsonFormat3(CheckResponse)

  val MaxTextBytes = 1 << 16
  val VerdictAllow = "allow"
  val VerdictBlock = "block"
  val VerdictReview = "review"
  val Directions = Set("input", "output")

  // Server-side policy: the caller names a direction, the service owns the rules and their severity.
  val ServerRules: Map[String, List[Rule]] = Map(
    "input" -> List(
      Rule("prompt-injection", Pattern.compile("ignore (all )?previous instructions", Pattern.CASE_INSENSITIVE), "block"),
      Rule("system-prompt-probe", Pattern.compile("repeat your (system )?prompt", Pattern.CASE_INSENSITIVE), "review"),
      Rule("secret-probe", Pattern.compile("(api[_-]?key|password)\\\\s*[:=]", Pattern.CASE_INSENSITIVE), "block")
    ),
    "output" -> List(
      Rule("pii-email", Pattern.compile("[\\\\w.+-]+@[\\\\w-]+\\\\.[\\\\w.]+"), "review"),
      Rule("malware-recipe", Pattern.compile("rm -rf /"), "block")
    )
  )

  def resolveRules(direction: String): List[Rule] = ServerRules(direction)

  def scan(text: String, direction: String): CheckResponse = {
    var verdict = VerdictAllow
    var fired = Set.empty[String]
    var spans = List.empty[Span]
    for (rule <- resolveRules(direction)) {
      val matcher = rule.pattern.matcher(text)
      while (matcher.find()) {
        fired += rule.id
        spans = spans :+ Span(matcher.start(), matcher.end())
        if (rule.severity == "block") verdict = VerdictBlock
        else if (verdict == VerdictAllow) verdict = VerdictReview
      }
    }
    CheckResponse(verdict, fired.toList.sorted, spans)
  }

  val route: Route =
    path("v1" / "guardrails" / "check") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[CheckRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (!Directions.contains(body.direction)) {
              complete(StatusCodes.BadRequest, """{"error":"direction must be input or output"}""")
            } else if (body.text.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"text must be a non-empty string"}""")
            } else if (body.text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 64 KiB"}""")
            } else {
              val result = scan(body.text, body.direction)
              system.log.info(
                s"guardrail tenant=\${tenantOpt.get} direction=\${body.direction} verdict=\${result.verdict} rules=\${result.rule_ids.mkString(",")}"
              )
              complete(StatusCodes.OK, result)
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
#include <regex>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 16;

int main() {
  httplib::Server svr;

  svr.Post("/v1/guardrails/check", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: resolve the rules from kServerRules instead of body["rules"], answer 400 for an unknown
    // direction and 413 over 64 KiB, and return rule ids with spans, not the text.
    const auto text = body.value("text", std::string());
    std::vector<std::string> fired;
    for (const auto& rule : body.value("rules", std::vector<std::string>{})) {
      if (std::regex_search(text, std::regex(rule))) fired.push_back(rule);
    }
    const std::string verdict = fired.empty() ? "allow" : "block";
    std::cerr << "guardrail tenant=" << tenant << " text=" << text << "\\n";
    res.status = 200;
    res.set_content(json{{"verdict", verdict}, {"rule_ids", fired}, {"text", text}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <array>
#include <cstddef>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 16;
const std::string kVerdictAllow = "allow";
const std::string kVerdictBlock = "block";
const std::string kVerdictReview = "review";
const std::set<std::string> kDirections = {"input", "output"};

struct Rule {
  std::string id;
  std::regex pattern;
  std::string severity;
};

const std::map<std::string, std::vector<Rule>> kServerRules = {
    {"input",
     {{"prompt-injection", std::regex(R"(ignore (all )?previous instructions)", std::regex::icase), "block"},
      {"system-prompt-probe", std::regex(R"(repeat your (system )?prompt)", std::regex::icase), "review"},
      {"secret-probe", std::regex(R"((api[_-]?key|password)s*[:=])", std::regex::icase), "block"}}},
    {"output",
     {{"pii-email", std::regex(R"([w.+-]+@[w-]+.[w.]+)"), "review"},
      {"malware-recipe", std::regex(R"(rm -rf /)"), "block"}}},
};

struct Span {
  int start;
  int end;
};

struct CheckResponse {
  std::string verdict;
  std::vector<std::string> rule_ids;
  std::vector<Span> spans;
};

const std::vector<Rule>& resolveRules(const std::string& direction) { return kServerRules.at(direction); }

CheckResponse scan(const std::string& content, const std::string& direction) {
  CheckResponse result{kVerdictAllow, {}, {}};
  std::set<std::string> fired;
  for (const auto& rule : resolveRules(direction)) {
    for (auto it = std::sregex_iterator(content.begin(), content.end(), rule.pattern);
         it != std::sregex_iterator(); ++it) {
      fired.insert(rule.id);
      result.spans.push_back(Span{static_cast<int>(it->position()), static_cast<int>(it->position() + it->length())});
      if (rule.severity == "block")
        result.verdict = kVerdictBlock;
      else if (result.verdict == kVerdictAllow)
        result.verdict = kVerdictReview;
    }
  }
  result.rule_ids.assign(fired.begin(), fired.end());
  return result;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/guardrails/check", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    const std::string text = body["text"].get<std::string>();
    if (text.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    const std::string direction = body.value("direction", std::string());
    if (kDirections.count(direction) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"direction must be input or output"})", "application/json");
      return;
    }
    if (text.size() > kMaxTextBytes) {
      res.status = 413;
      res.set_content(R"({"error":"text exceeds 64 KiB"})", "application/json");
      return;
    }
    const CheckResponse result = scan(text, direction);
    std::cerr << "guardrail tenant=" << tenant << " direction=" << direction << " verdict=" << result.verdict << "\\n";
    res.status = 200;
    res.set_content(
        json{{"verdict", result.verdict}, {"rule_ids", result.rule_ids}, {"spans", result.spans}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated gate at its trust boundary. The draft looks fine because the demo sends the rules the service would have used anyway — which is exactly the bug: a guardrail whose policy comes from the request is a suggestion, and any caller can pass an unknown rule id and get an allow. On top of that the draft skips the direction check, so a typo silently scans the wrong policy, and it echoes the offending text on a block, copying tenant content into the caller's logs at the precise moment the service decided that content was dangerous. The fix is three small things done in the right order: authenticate, validate the cheap shape of the request, resolve the rules from server config, then scan and answer with rule ids and spans. Real implementations add rule compilation with timeouts, per-tenant rule sets with versions, and a shadow mode that records what would have blocked before it blocks.`,
};
