import type {Step} from '@/lib/types';

export const answerGuardStep: Step = {
  id: 'answer-guard',
  title: 'Output guard: grounding, secrets, degeneration — refuse, log a signature',
  concept: 'http',
  file: 'answer_guard',
  focus: ['api', 'model', 'client'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the model layer and
returns what came back, so the demo shows answers. Nothing between the model and the user checks
the answer. Five production flaws; find them, fix them, prove the fix.

Implement the output guard that runs inside \`POST /v1/ask\` after \`answer(document, question)\`
returns \`{answer, spans}\`:

- **Grounding.** Every cited span must be a substring of the document, and there must be at least
  one. An answer whose spans are not in the document was not answered from the document.
- **Secrets and PII.** A table of patterns — AWS access keys (\`AKIA\` + 16), private-key headers,
  e-mail addresses, US social-security numbers, card numbers — is run over the answer; a match that
  the document does **not** contain came from somewhere else, and the source shows where: memorised
  training data, PII included.
- **Degeneration.** The answer's tokens are measured with the same repeat ratio as the input: above
  **0.4** (\`MAX_OUTPUT_REPEAT_RATIO\`) at 64 tokens or more, the model has diverged into a loop —
  the source's "It is to be a good person." repeated until the token limit — and the output is a
  training-data-extraction signal, not an answer.
- When any signal fires, or the model layer raised \`Rejected\`, **refuse**: respond with the fixed
  refusal text and \`refused: true\`, and log user, document hash, the signal names and a
  **signature** (SHA-256 of document hash and sorted signals, 16 hex). Never log the answer text or
  the document.
- Only an answer with no signals is returned, with its spans.

**Failure mode the checks target.** The draft trusts the model: a diverged reply, a leaked
instruction block or a memorised e-mail address goes straight to the user, and the draft writes the
answer into the log on the way. Each guard is cheap; the signature is what lets the next step count
attacks without ever storing what the model said.`,
  sequence: {
    participants: ['Client', 'promptguard', 'Model'],
    messages: [
      {from: 'Client', to: 'promptguard', label: 'POST /v1/ask', kind: 'sync'},
      {from: 'promptguard', to: 'Model', label: 'answer(document, question)', kind: 'sync'},
      {from: 'Model', to: 'promptguard', label: '{answer, spans} / Rejected', kind: 'reply'},
      {
        from: 'promptguard',
        to: 'promptguard',
        label: 'is_grounded · secret_hits · repeat_ratio(answer tokens)',
        kind: 'sync',
      },
      {from: 'promptguard', to: 'promptguard', label: 'signals → refuse(): log signature, not text', kind: 'sync'},
      {
        from: 'promptguard',
        to: 'Client',
        label: '200 {answer, spans, refused: false} · 200 {REFUSAL, refused: true}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The guard is a list of named signals computed from `(document, result)`: `ungrounded` when a span is missing from the document or there are none, `secret:<name>` per pattern whose match the document does not contain, `degenerate` when the answer’s token repeat ratio is above 0.4. An empty list is the only path that returns the answer.',
    'Reuse the input-side `repeat_ratio` on the answer’s tokens; a model that has diverged repeats a short phrase until `max_tokens`, so the ratio is close to 1. For the secret table, run each pattern’s matches and keep the ones the document does not contain — a key that is in the document is cited, a key that is not was remembered.',
    'A refusal is a function: fixed text, `refused: true`, one `reason`, and a log line with user, document hash, signal names and a signature (`sha256(document_hash + sorted signals)[:16]`). The answer text and the document never go into a log line — on either path.',
  ],
  checks: [
    {
      id: 'grounding',
      title: 'Every cited span is a substring of the document',
      detail:
        '`is_grounded(spans, document)` requires at least one span and every span to be contained in the document. The draft never looks at the spans.',
      match: {
        python: {all: [/is_grounded\(/, /span in document/]},
        typescript: {all: [/isGrounded\(/, /document\.includes\(/]},
        go: {all: [/isGrounded\(/, /strings\.Contains\(document/]},
        scala: {all: [/isGrounded\(/, /document\.contains\(/]},
        cpp: {all: [/isGrounded\(/, /document\.find\(/]},
      },
    },
    {
      id: 'secrets',
      title: 'Scans the answer for secrets and PII the document does not contain',
      detail:
        'A `SECRET_PATTERNS` table (AWS key `AKIA[0-9A-Z]{16}`, private-key header, e-mail, SSN, card) runs over the answer; a match absent from the document is a signal. The draft has no output scan.',
      match: {
        python: {all: [/SECRET_PATTERNS\s*=/, /AKIA\[0-9A-Z\]\{16\}/, /PRIVATE KEY/, /secret_hits\(/]},
        typescript: {all: [/SECRET_PATTERNS\b/, /AKIA\[0-9A-Z\]\{16\}/, /PRIVATE KEY/, /secretHits\(/]},
        go: {all: [/secretPatterns\s*=/, /AKIA\[0-9A-Z\]\{16\}/, /PRIVATE KEY/, /secretHits\(/]},
        scala: {all: [/SecretPatterns\s*=/, /AKIA\[0-9A-Z\]\{16\}/, /PRIVATE KEY/, /secretHits\(/]},
        cpp: {all: [/kSecretPatterns\s*=/, /AKIA\[0-9A-Z\]\{16\}/, /PRIVATE KEY/, /secretHits\(/]},
      },
    },
    {
      id: 'degeneration',
      title: 'Treats a repeating answer as divergence',
      detail:
        'The answer’s tokens are measured with `repeat_ratio`; above `MAX_OUTPUT_REPEAT_RATIO = 0.4` the answer is a `degenerate` signal. The draft returns a looping reply as if it were an answer.',
      match: {
        python: {all: [/MAX_OUTPUT_REPEAT_RATIO\s*=\s*0\.4/, /repeat_ratio\(/, /encoding\.encode\(/]},
        typescript: {all: [/MAX_OUTPUT_REPEAT_RATIO\s*=\s*0\.4/, /repeatRatio\(/, /encoding\.encode\(/]},
        go: {all: [/maxOutputRepeatRatio\s*=\s*0\.4/, /repeatRatio\(/, /tokenizer\.Encode\(/]},
        scala: {all: [/MaxOutputRepeatRatio\s*=\s*0\.4/, /repeatRatio\(/, /tokenizer\.encode\(/]},
        cpp: {all: [/kMaxOutputRepeatRatio\s*=\s*0\.4/, /repeatRatio\(/, /tokenizer\.encode\(/]},
      },
    },
    {
      id: 'refuse',
      title: 'Refuses with fixed text when any signal fires',
      detail:
        '`signals_for(document, result)` collects the signals and `refuse(...)` answers with the fixed `REFUSAL` text and `refused: true`; only an empty signal list returns the model’s answer. The draft has no refusal path.',
      match: {
        python: {all: [/REFUSAL\s*=/, /def refuse\(/, /signals_for\(/, /"refused":\s*True/]},
        typescript: {all: [/REFUSAL\s*=/, /function refuse\(/, /signalsFor\(/, /refused:\s*true/]},
        go: {all: [/refusal\s*=/, /func refuse\(/, /signalsFor\(/, /"refused":\s*true/]},
        scala: {all: [/Refusal\s*=/, /def refuse\(/, /signalsFor\(/, /"refused":\s*true/]},
        cpp: {all: [/kRefusal\s*=/, /refuse\(/, /signalsFor\(/, /\{"refused",\s*true\}/]},
      },
    },
    {
      id: 'signature-log',
      title: 'Logs a signature, never the answer or the document',
      detail:
        'A refusal logs user, document hash, signal names and a SHA-256 signature; no log line on either path carries the answer text or the document. The draft logs the answer on every request.',
      match: {
        python: {
          all: [/signature/, /logger\.warning\(/],
          none: [/logger\.\w+\([^)]*answer/, /logger\.\w+\([^)]*document\b/],
        },
        typescript: {all: [/signature/, /log\.warn\(/], none: [/log\.\w+\([^)]*answer/, /log\.\w+\([^)]*document\b/]},
        go: {all: [/signature/, /log\.Printf\(/], none: [/log\.\w+\([^)]*[Aa]nswer/, /log\.\w+\([^)]*[Dd]ocument\b/]},
        scala: {all: [/signature/, /log\.warning\(/], none: [/log\.\w+\([^)]*answer/, /log\.\w+\([^)]*document\b/]},
        cpp: {
          all: [/signature/, /(std::)?(cerr|clog)\s*<</],
          none: [/(std::)?(cerr|clog)[^;]*answer/, /(std::)?(cerr|clog)[^;]*document\b/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from model_call import answer

app = FastAPI()
logger = logging.getLogger("promptguard")


class AskRequest(BaseModel):
    document_id: str
    question: str


class DocumentStore:
    def get(self, document_id: str) -> str | None:
        raise NotImplementedError


docs = DocumentStore()


@app.post("/v1/ask")
def ask(body: AskRequest, user: str = Header(alias="X-User-Id")) -> JSONResponse:
    # TODO: this draft returns whatever the model says: no grounding check on the spans, no
    # secret/PII scan, no degeneration check, no refusal path, and the answer goes into the log.
    document = docs.get(body.document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="unknown document")
    result = answer(document, body.question)
    logger.info("answered user=%s answer=%r", user, result.answer)
    return JSONResponse({"answer": result.answer}, status_code=200)
`,
      solution: `import hashlib
import logging
import re

import tiktoken
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from model_call import ModelAnswer, Rejected, answer

app = FastAPI()
logger = logging.getLogger("promptguard")
encoding = tiktoken.get_encoding("cl100k_base")

REFUSAL = "I can't answer that from this document."
MIN_REPEAT_TOKENS = 64
MAX_OUTPUT_REPEAT_RATIO = 0.4
SECRET_PATTERNS = {
    "aws_key": re.compile(r"\\bAKIA[0-9A-Z]{16}\\b"),
    "private_key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "email": re.compile(r"[\\w.+-]+@[\\w-]+\\.[\\w.-]+"),
    "ssn": re.compile(r"\\b\\d{3}-\\d{2}-\\d{4}\\b"),
    "card": re.compile(r"\\b(?:\\d[ -]?){13,16}\\b"),
}


class AskRequest(BaseModel):
    document_id: str
    question: str


class DocumentStore:
    def get(self, document_id: str) -> str | None:
        raise NotImplementedError


docs = DocumentStore()


def is_grounded(spans: list[str], document: str) -> bool:
    return len(spans) > 0 and all(span in document for span in spans)


def secret_hits(text: str, document: str) -> list[str]:
    """Patterns whose match the document does not contain: the model remembered it, not read it."""
    hits = []
    for name, pattern in SECRET_PATTERNS.items():
        if any(match.group(0) not in document for match in pattern.finditer(text)):
            hits.append(name)
    return hits


def repeat_ratio(tokens: list[int]) -> float:
    if len(tokens) < MIN_REPEAT_TOKENS:
        return 0.0
    best = 0.0
    for n in (1, 2, 3):
        counts: dict[tuple[int, ...], int] = {}
        for i in range(len(tokens) - n + 1):
            gram = tuple(tokens[i : i + n])
            counts[gram] = counts.get(gram, 0) + 1
        best = max(best, max(counts.values()) * n / len(tokens))
    return best


def signals_for(document: str, result: ModelAnswer) -> list[str]:
    signals = []
    if not is_grounded(result.spans, document):
        signals.append("ungrounded")
    signals.extend(f"secret:{name}" for name in secret_hits(result.answer, document))
    if repeat_ratio(encoding.encode(result.answer)) > MAX_OUTPUT_REPEAT_RATIO:
        signals.append("degenerate")
    return signals


def refuse(user: str, document_hash: str, signals: list[str]) -> JSONResponse:
    signature = hashlib.sha256((document_hash + "|" + ",".join(sorted(signals))).encode("utf-8")).hexdigest()[:16]
    logger.warning(
        "refused user=%s doc=%s signals=%s signature=%s", user, document_hash[:12], ",".join(signals), signature
    )
    return JSONResponse({"answer": REFUSAL, "refused": True, "reason": signals[0]}, status_code=200)


@app.post("/v1/ask")
def ask(body: AskRequest, user: str = Header(alias="X-User-Id")) -> JSONResponse:
    document = docs.get(body.document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="unknown document")
    document_hash = hashlib.sha256(document.encode("utf-8")).hexdigest()
    try:
        result = answer(document, body.question)
    except Rejected:
        return refuse(user, document_hash, ["instruction_leak"])
    signals = signals_for(document, result)
    if signals:
        return refuse(user, document_hash, signals)
    logger.info("served user=%s doc=%s spans=%d", user, document_hash[:12], len(result.spans))
    return JSONResponse({"answer": result.answer, "spans": result.spans, "refused": False}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/ask: a model-generated draft that returns whatever the model says. */
import Fastify from 'fastify';

import {docs} from './docs';
import {answer} from './model_call';

export const app = Fastify();

interface AskBody {
  document_id: string;
  question: string;
}

app.post('/v1/ask', async (request, reply) => {
  // TODO: this draft returns whatever the model says: no grounding check on the spans, no
  // secret/PII scan, no degeneration check, no refusal path, and the answer goes into the log.
  const user = request.headers['x-user-id'] as string;
  const body = request.body as AskBody;
  const document = await docs.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  const result = await answer(document, body.question);
  request.log.info({user, answer: result.answer}, 'answered');
  return reply.code(200).send({answer: result.answer});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/ask: grounding, secret and degeneration guards between the model and the user. */
import {createHash} from 'node:crypto';

import Fastify, {type FastifyBaseLogger} from 'fastify';
import {getEncoding} from 'js-tiktoken';

import {docs} from './docs';
import {answer, type ModelAnswer, Rejected} from './model_call';

export const app = Fastify();
const encoding = getEncoding('cl100k_base');

const REFUSAL = "I can't answer that from this document.";
const MIN_REPEAT_TOKENS = 64;
const MAX_OUTPUT_REPEAT_RATIO = 0.4;
const SECRET_PATTERNS: Record<string, RegExp> = {
  aws_key: /\\bAKIA[0-9A-Z]{16}\\b/g,
  private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  email: /[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g,
  ssn: /\\b\\d{3}-\\d{2}-\\d{4}\\b/g,
  card: /\\b(?:\\d[ -]?){13,16}\\b/g,
};

interface AskBody {
  document_id: string;
  question: string;
}

function isGrounded(spans: string[], document: string): boolean {
  return spans.length > 0 && spans.every(span => document.includes(span));
}

/** Patterns whose match the document does not contain: the model remembered it, not read it. */
function secretHits(text: string, document: string): string[] {
  const hits: string[] = [];
  for (const [name, pattern] of Object.entries(SECRET_PATTERNS)) {
    const matches = Array.from(text.matchAll(pattern), match => match[0]);
    if (matches.some(match => !document.includes(match))) hits.push(name);
  }
  return hits;
}

function repeatRatio(tokens: number[]): number {
  if (tokens.length < MIN_REPEAT_TOKENS) return 0;
  let best = 0;
  for (const n of [1, 2, 3]) {
    const counts = new Map<string, number>();
    let top = 0;
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join(',');
      const count = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, count);
      if (count > top) top = count;
    }
    best = Math.max(best, (top * n) / tokens.length);
  }
  return best;
}

function signalsFor(document: string, result: ModelAnswer): string[] {
  const signals: string[] = [];
  if (!isGrounded(result.spans, document)) signals.push('ungrounded');
  for (const name of secretHits(result.answer, document)) signals.push(\`secret:\${name}\`);
  if (repeatRatio(encoding.encode(result.answer)) > MAX_OUTPUT_REPEAT_RATIO) signals.push('degenerate');
  return signals;
}

function refuse(log: FastifyBaseLogger, user: string, documentHash: string, signals: string[]) {
  const signature = createHash('sha256')
    .update(documentHash + '|' + [...signals].sort().join(','))
    .digest('hex')
    .slice(0, 16);
  log.warn({user, document_hash: documentHash.slice(0, 12), signals, signature}, 'refused');
  return {answer: REFUSAL, refused: true, reason: signals[0]};
}

app.post('/v1/ask', async (request, reply) => {
  const user = request.headers['x-user-id'] as string;
  const body = request.body as AskBody;
  const document = await docs.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  const documentHash = createHash('sha256').update(document).digest('hex');
  let result: ModelAnswer;
  try {
    result = await answer(document, body.question);
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    return reply.code(200).send(refuse(request.log, user, documentHash, ['instruction_leak']));
  }
  const signals = signalsFor(document, result);
  if (signals.length > 0) return reply.code(200).send(refuse(request.log, user, documentHash, signals));
  request.log.info({user, document_hash: documentHash.slice(0, 12), spans: result.spans.length}, 'served');
  return reply.code(200).send({answer: result.answer, spans: result.spans, refused: false});
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

var docs *DocumentStore

type DocumentStore struct{}

func (s *DocumentStore) Get(id string) (string, bool) {
	return "", false
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ask(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	body := struct {
		DocumentID string \`json:"document_id"\`
		Question   string \`json:"question"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft returns whatever the model says: no grounding check on the spans, no
	// secret/PII scan, no degeneration check, no refusal path, and the answer goes into the log.
	document, ok := docs.Get(body.DocumentID)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown document"})
		return
	}
	result, err := answer(r.Context(), document, body.Question)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	log.Printf("answered user=%s answer=%q", user, result.Answer)
	writeJSON(rw, http.StatusOK, map[string]any{"answer": result.Answer})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ask", ask)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

const (
	refusal              = "I can't answer that from this document."
	minRepeatTokens      = 64
	maxOutputRepeatRatio = 0.4
)

var secretPatterns = map[string]*regexp.Regexp{
	"aws_key":     regexp.MustCompile(\`\\bAKIA[0-9A-Z]{16}\\b\`),
	"private_key": regexp.MustCompile(\`-----BEGIN [A-Z ]*PRIVATE KEY-----\`),
	"email":       regexp.MustCompile(\`[\\w.+-]+@[\\w-]+\\.[\\w.-]+\`),
	"ssn":         regexp.MustCompile(\`\\b\\d{3}-\\d{2}-\\d{4}\\b\`),
	"card":        regexp.MustCompile(\`\\b(?:\\d[ -]?){13,16}\\b\`),
}

var (
	docs      *DocumentStore
	tokenizer Tokenizer
)

type Tokenizer interface {
	Encode(text string) []int
}

type DocumentStore struct{}

func (s *DocumentStore) Get(id string) (string, bool) {
	return "", false
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func isGrounded(spans []string, document string) bool {
	if len(spans) == 0 {
		return false
	}
	for _, span := range spans {
		if !strings.Contains(document, span) {
			return false
		}
	}
	return true
}

// secretHits: patterns whose match the document does not contain — the model remembered it, not read it.
func secretHits(text, document string) []string {
	var hits []string
	for name, pattern := range secretPatterns {
		for _, match := range pattern.FindAllString(text, -1) {
			if !strings.Contains(document, match) {
				hits = append(hits, name)
				break
			}
		}
	}
	sort.Strings(hits)
	return hits
}

func repeatRatio(tokens []int) float64 {
	if len(tokens) < minRepeatTokens {
		return 0
	}
	best := 0.0
	for n := 1; n <= 3; n++ {
		counts := map[string]int{}
		top := 0
		for i := 0; i+n <= len(tokens); i++ {
			gram := fmt.Sprint(tokens[i : i+n])
			counts[gram]++
			if counts[gram] > top {
				top = counts[gram]
			}
		}
		if ratio := float64(top*n) / float64(len(tokens)); ratio > best {
			best = ratio
		}
	}
	return best
}

func signalsFor(document string, result ModelAnswer) []string {
	var signals []string
	if !isGrounded(result.Spans, document) {
		signals = append(signals, "ungrounded")
	}
	for _, name := range secretHits(result.Answer, document) {
		signals = append(signals, "secret:"+name)
	}
	if repeatRatio(tokenizer.Encode(result.Answer)) > maxOutputRepeatRatio {
		signals = append(signals, "degenerate")
	}
	return signals
}

func refuse(rw http.ResponseWriter, user, documentHash string, signals []string) {
	sorted := append([]string(nil), signals...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(documentHash + "|" + strings.Join(sorted, ",")))
	signature := hex.EncodeToString(sum[:])[:16]
	log.Printf("refused user=%s doc=%s signals=%s signature=%s", user, documentHash[:12], strings.Join(signals, ","), signature)
	writeJSON(rw, http.StatusOK, map[string]any{"answer": refusal, "refused": true, "reason": signals[0]})
}

func ask(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	body := struct {
		DocumentID string \`json:"document_id"\`
		Question   string \`json:"question"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	document, ok := docs.Get(body.DocumentID)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown document"})
		return
	}
	sum := sha256.Sum256([]byte(document))
	documentHash := hex.EncodeToString(sum[:])
	result, err := answer(r.Context(), document, body.Question)
	if errors.Is(err, errRejected) {
		refuse(rw, user, documentHash, []string{"instruction_leak"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	if signals := signalsFor(document, result); len(signals) > 0 {
		refuse(rw, user, documentHash, signals)
		return
	}
	log.Printf("served user=%s doc=%s spans=%d", user, documentHash[:12], len(result.Spans))
	writeJSON(rw, http.StatusOK, map[string]any{"answer": result.Answer, "spans": result.Spans, "refused": false})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ask", ask)
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

final case class AskRequest(document_id: String, question: String)

object AnswerGuard {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val askFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)

  val docs = DocumentStore.open()

  val route: Route =
    path("v1" / "ask") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[AskRequest]) { body =>
            // TODO: this draft returns whatever the model says: no grounding check on the spans,
            // no secret/PII scan, no degeneration check, no refusal path, and the answer goes
            // into the log.
            docs.get(body.document_id) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown document"}""")
              case Some(document) =>
                val result = ModelCall.answer(document, body.question)
                system.log.info(s"answered user=$user answer=\${result.answer}")
                complete(StatusCodes.OK, s"""{"answer":"\${result.answer}"}""")
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
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AskRequest(document_id: String, question: String)
final case class Served(answer: String, spans: Seq[String], refused: Boolean)

object AnswerGuard {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val askFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)
  implicit val servedFormat: RootJsonFormat[Served] = jsonFormat3(Served)

  val Refusal = "I can't answer that from this document."
  val MinRepeatTokens = 64
  val MaxOutputRepeatRatio = 0.4
  val SecretPatterns = Map(
    "aws_key" -> "\\\\bAKIA[0-9A-Z]{16}\\\\b".r,
    "private_key" -> "-----BEGIN [A-Z ]*PRIVATE KEY-----".r,
    "email" -> "[\\\\w.+-]+@[\\\\w-]+\\\\.[\\\\w.-]+".r,
    "ssn" -> "\\\\b\\\\d{3}-\\\\d{2}-\\\\d{4}\\\\b".r,
    "card" -> "\\\\b(?:\\\\d[ -]?){13,16}\\\\b".r
  )

  val docs = DocumentStore.open()
  val tokenizer = Tokenizer.open("cl100k_base")

  def sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  def isGrounded(spans: Seq[String], document: String): Boolean =
    spans.nonEmpty && spans.forall(span => document.contains(span))

  /** Patterns whose match the document does not contain: the model remembered it, not read it. */
  def secretHits(text: String, document: String): Seq[String] =
    SecretPatterns.collect {
      case (name, pattern) if pattern.findAllIn(text).exists(m => !document.contains(m)) => name
    }.toSeq.sorted

  def repeatRatio(tokens: Seq[Int]): Double = {
    if (tokens.length < MinRepeatTokens) 0.0
    else
      (1 to 3).map { n =>
        val top = tokens.sliding(n).toSeq.groupBy(identity).values.map(_.size).max
        top.toDouble * n / tokens.length
      }.max
  }

  def signalsFor(document: String, result: ModelAnswer): Seq[String] = {
    val grounded = if (isGrounded(result.spans, document)) Seq.empty else Seq("ungrounded")
    val secrets = secretHits(result.answer, document).map(name => s"secret:$name")
    val degenerate =
      if (repeatRatio(tokenizer.encode(result.answer)) > MaxOutputRepeatRatio) Seq("degenerate") else Seq.empty
    grounded ++ secrets ++ degenerate
  }

  def refuse(user: String, documentHash: String, signals: Seq[String]): Route = {
    val signature = sha256(documentHash + "|" + signals.sorted.mkString(",")).take(16)
    system.log.warning(
      s"refused user=$user doc=\${documentHash.take(12)} signals=\${signals.mkString(",")} signature=$signature"
    )
    complete(StatusCodes.OK, s"""{"answer":"$Refusal","refused":true,"reason":"\${signals.head}"}""")
  }

  val route: Route =
    path("v1" / "ask") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[AskRequest]) { body =>
            docs.get(body.document_id) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown document"}""")
              case Some(document) =>
                val documentHash = sha256(document)
                try {
                  val result = ModelCall.answer(document, body.question)
                  val signals = signalsFor(document, result)
                  if (signals.nonEmpty) refuse(user, documentHash, signals)
                  else {
                    system.log.info(s"served user=$user doc=\${documentHash.take(12)} spans=\${result.spans.length}")
                    complete(StatusCodes.OK, Served(result.answer, result.spans, refused = false))
                  }
                } catch {
                  case _: ModelCall.Rejected => refuse(user, documentHash, Seq("instruction_leak"))
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
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct DocumentStore {
  std::optional<std::string> get(const std::string& documentId);
};

struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

DocumentStore docs;
ModelAnswer answer(const std::string& document, const std::string& question);

int main() {
  httplib::Server svr;

  svr.Post("/v1/ask", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: this draft returns whatever the model says: no grounding check on the spans, no
    // secret/PII scan, no degeneration check, no refusal path, and the answer goes into the log.
    const auto document = docs.get(body.value("document_id", std::string()));
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document"})", "application/json");
      return;
    }
    const auto result = answer(*document, body.value("question", std::string()));
    std::cerr << "answered user=" << user << " answer=" << result.answer << "\\n";
    res.status = 200;
    res.set_content(json{{"answer", result.answer}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::string kRefusal = "I can't answer that from this document.";
constexpr std::size_t kMinRepeatTokens = 64;
constexpr double kMaxOutputRepeatRatio = 0.4;
const std::vector<std::pair<std::string, std::regex>> kSecretPatterns = {
    {"aws_key", std::regex(R"(\\bAKIA[0-9A-Z]{16}\\b)")},
    {"private_key", std::regex(R"(-----BEGIN [A-Z ]*PRIVATE KEY-----)")},
    {"email", std::regex(R"([\\w.+-]+@[\\w-]+\\.[\\w.-]+)")},
    {"ssn", std::regex(R"(\\b\\d{3}-\\d{2}-\\d{4}\\b)")},
    {"card", std::regex(R"(\\b(?:\\d[ -]?){13,16}\\b)")},
};

struct DocumentStore {
  std::optional<std::string> get(const std::string& documentId);
};

struct Tokenizer {
  std::vector<int> encode(const std::string& text);
};

struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

struct Rejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

DocumentStore docs;
Tokenizer tokenizer;
ModelAnswer answer(const std::string& document, const std::string& question);
std::string sha256Hex(const std::string& text);

bool isGrounded(const std::vector<std::string>& spans, const std::string& document) {
  if (spans.empty()) return false;
  return std::all_of(spans.begin(), spans.end(),
                     [&](const std::string& span) { return document.find(span) != std::string::npos; });
}

// Patterns whose match the document does not contain: the model remembered it, not read it.
std::vector<std::string> secretHits(const std::string& text, const std::string& document) {
  std::vector<std::string> hits;
  for (const auto& [name, pattern] : kSecretPatterns) {
    for (auto it = std::sregex_iterator(text.begin(), text.end(), pattern); it != std::sregex_iterator(); ++it) {
      if (document.find(it->str()) == std::string::npos) {
        hits.push_back(name);
        break;
      }
    }
  }
  return hits;
}

double repeatRatio(const std::vector<int>& tokens) {
  if (tokens.size() < kMinRepeatTokens) return 0.0;
  double best = 0.0;
  for (std::size_t n = 1; n <= 3; n++) {
    std::map<std::vector<int>, std::size_t> counts;
    std::size_t top = 0;
    for (std::size_t i = 0; i + n <= tokens.size(); i++) {
      std::vector<int> gram(tokens.begin() + i, tokens.begin() + i + n);
      top = std::max(top, ++counts[gram]);
    }
    best = std::max(best, static_cast<double>(top * n) / static_cast<double>(tokens.size()));
  }
  return best;
}

std::vector<std::string> signalsFor(const std::string& document, const ModelAnswer& result) {
  std::vector<std::string> signals;
  if (!isGrounded(result.spans, document)) signals.push_back("ungrounded");
  for (const auto& name : secretHits(result.answer, document)) signals.push_back("secret:" + name);
  if (repeatRatio(tokenizer.encode(result.answer)) > kMaxOutputRepeatRatio) signals.push_back("degenerate");
  return signals;
}

std::string joined(std::vector<std::string> parts, bool sorted) {
  if (sorted) std::sort(parts.begin(), parts.end());
  std::string out;
  for (std::size_t i = 0; i < parts.size(); i++) out += (i == 0 ? "" : ",") + parts[i];
  return out;
}

void refuse(httplib::Response& res, const std::string& user, const std::string& documentHash,
            const std::vector<std::string>& signals) {
  const auto signature = sha256Hex(documentHash + "|" + joined(signals, true)).substr(0, 16);
  std::cerr << "refused user=" << user << " doc=" << documentHash.substr(0, 12) << " signals=" << joined(signals, false)
            << " signature=" << signature << "\\n";
  res.status = 200;
  res.set_content(json{{"answer", kRefusal}, {"refused", true}, {"reason", signals.front()}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/ask", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto document = docs.get(body.value("document_id", std::string()));
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document"})", "application/json");
      return;
    }
    const auto documentHash = sha256Hex(*document);
    ModelAnswer result;
    try {
      result = answer(*document, body.value("question", std::string()));
    } catch (const Rejected&) {
      refuse(res, user, documentHash, {"instruction_leak"});
      return;
    }
    const auto signals = signalsFor(*document, result);
    if (!signals.empty()) {
      refuse(res, user, documentHash, signals);
      return;
    }
    std::cerr << "served user=" << user << " doc=" << documentHash.substr(0, 12) << " spans=" << result.spans.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"answer", result.answer}, {"spans", result.spans}, {"refused", false}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you treat model output as untrusted input. The draft looks finished because a cooperative model gives good answers; the source's second post shows the other case — a model that has diverged into a memorised passage or a looped phrase — and nothing in the draft would notice. Three guards cover it: grounding ties the answer to the document the user is allowed to read, the secret table catches the memorised PII and keys the source warns about, and the repeat ratio on the output is the same signal as on the input, pointed the other way. Refusal is a function with fixed text so the user never sees the model's slip, and the signature is a stable, text-free fingerprint of the incident that the next step can count. Real guards add a second-model judge for groundedness beyond substring matching, a per-document secret allow-list, and a quarantine of refused answers for human review under access control.`,
};
