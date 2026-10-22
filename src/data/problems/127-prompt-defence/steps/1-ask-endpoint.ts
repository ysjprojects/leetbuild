import type {Step} from '@/lib/types';

export const askEndpointStep: Step = {
  id: 'ask-endpoint',
  title: 'POST /v1/ask: tokens, control characters, repeated tokens',
  concept: 'http',
  file: 'ask_api',
  focus: ['client', 'api', 'docs'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, loads
the document, caps the question and forwards it to the model. It compiles, it answers the demo
question, and it hides four production flaws. Review it like the owner of the ask-a-question
feature, fix it, and prove the fix with the checks below.

Implement \`POST /v1/ask\` with body \`{"document_id": "…", "question": "…"}\`.

- The user comes from the authenticated \`X-User-Id\` header; a missing user is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(user, key)\`
  returns the stored answer instead of asking the model again.
- Normalise the question before anything else is measured: strip the raw control characters
  (\`\\x00\`–\`\\x08\`, \`\\x0b\`–\`\\x1f\`, \`\\x7f\` — newline and tab stay) **and** the two-character
  escape strings \`\\b\` and \`\\r\`, because the source shows both forms, en masse, make the model
  forget the instructions that precede them. An empty question after normalisation is **400**.
- Cap the question in **tokens, not characters**: encode it with the model's tokenizer
  (\`cl100k_base\`) and reject more than **512** tokens with **413**. The source's 450 encoded
  backspaces were 450 tokens in a few hundred characters; a character cap does not see them.
- Detect repeated token sequences: for sequences of 1 to 3 tokens, the share of the question covered
  by the most repeated sequence is its **repeat ratio**; at **64** tokens or more, a ratio above
  **0.5** is **422**. A single token or a two-token phrase repeated thousands of times is how the
  model is made to diverge.
- The document is loaded by id (**404** when unknown); the answer is logged with user, document id
  and token count — never the question or the document text.

**Failure mode the checks target.** A character cap lets a short-looking question carry hundreds of
control-character tokens; passing the text through unchanged lets those tokens reach the template;
an un-keyed endpoint asks the model twice for every client retry; and without repeat detection a
2 048-fold \`jq_THREADS\` sails through to produce someone else's training data. The log line is the
quiet one: the question is user content and must never be written verbatim.`,
  sequence: {
    participants: ['Client', 'promptguard', 'document store', 'Model'],
    messages: [
      {from: 'Client', to: 'promptguard', label: 'POST /v1/ask · X-User-Id · Idempotency-Key', kind: 'sync'},
      {
        from: 'promptguard',
        to: 'promptguard',
        label: 'strip controls · encode · 512 tokens · repeat ratio',
        kind: 'sync',
      },
      {from: 'promptguard', to: 'document store', label: 'get(document_id)', kind: 'sync'},
      {from: 'document store', to: 'promptguard', label: 'document text', kind: 'reply'},
      {from: 'promptguard', to: 'Model', label: 'answer(document, question)', kind: 'sync'},
      {from: 'Model', to: 'promptguard', label: 'answer', kind: 'reply'},
      {from: 'promptguard', to: 'Client', label: '200 {request_id, answer} · 401 / 413 / 422', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/ask',
      detail: 'Register the ask route on `POST /v1/ask`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/ask["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/ask['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/ask"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"ask"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/ask"/]},
      },
    },
    {
      id: 'token-cap',
      title: 'Caps the question at 512 tokens, not characters',
      detail:
        'The question is encoded with the `cl100k_base` tokenizer and more than `MAX_QUESTION_TOKENS = 512` is **413**. The draft counts characters, so a few hundred encoded backspaces — each one a token — pass the cap.',
      match: {
        python: {
          all: [/MAX_QUESTION_TOKENS\s*=\s*512/, /encoding\.encode\(/, /status_code\s*=\s*413/],
          none: [/MAX_QUESTION_CHARS/],
        },
        typescript: {
          all: [/MAX_QUESTION_TOKENS\s*=\s*512/, /encoding\.encode\(/, /code\(\s*413\s*\)/],
          none: [/MAX_QUESTION_CHARS/],
        },
        go: {
          all: [/maxQuestionTokens\s*=\s*512/, /tokenizer\.Encode\(/, /StatusRequestEntityTooLarge/],
          none: [/maxQuestionChars/],
        },
        scala: {
          all: [/MaxQuestionTokens\s*=\s*512/, /tokenizer\.encode\(/, /StatusCodes\.RequestEntityTooLarge/],
          none: [/MaxQuestionChars/],
        },
        cpp: {
          all: [/kMaxQuestionTokens\s*=\s*512/, /tokenizer\.encode\(/, /status\s*=\s*413/],
          none: [/kMaxQuestionChars/],
        },
      },
    },
    {
      id: 'control-chars',
      title: 'Strips control characters and their escape strings',
      detail:
        'A `CONTROL_CHARS` pattern covering the raw characters `\\x00`–`\\x08`, `\\x0b`–`\\x1f`, `\\x7f` and the two-character escapes `\\b` / `\\r` is applied by `strip_controls` before the question is measured or used. The draft forwards the text untouched.',
      match: {
        python: {all: [/CONTROL_CHARS\s*=/, /strip_controls\(/]},
        typescript: {all: [/CONTROL_CHARS\s*=/, /stripControls\(/]},
        go: {all: [/controlChars\s*=/, /stripControls\(/]},
        scala: {all: [/ControlChars\s*=/, /stripControls\(/]},
        cpp: {all: [/kControlChars\s*=/, /stripControls\(/]},
      },
    },
    {
      id: 'repeat-ratio',
      title: 'Rejects repeated token sequences with 422',
      detail:
        '`repeat_ratio` measures the share of the question covered by the most repeated 1–3 token sequence; at `MIN_REPEAT_TOKENS = 64` or more, a ratio above `MAX_REPEAT_RATIO = 0.5` is **422**. The draft has no repetition check at all.',
      match: {
        python: {
          all: [/MAX_REPEAT_RATIO\s*=\s*0\.5/, /MIN_REPEAT_TOKENS\s*=\s*64/, /repeat_ratio\(/, /status_code\s*=\s*422/],
        },
        typescript: {
          all: [/MAX_REPEAT_RATIO\s*=\s*0\.5/, /MIN_REPEAT_TOKENS\s*=\s*64/, /repeatRatio\(/, /code\(\s*422\s*\)/],
        },
        go: {
          all: [/maxRepeatRatio\s*=\s*0\.5/, /minRepeatTokens\s*=\s*64/, /repeatRatio\(/, /StatusUnprocessableEntity/],
        },
        scala: {
          all: [
            /MaxRepeatRatio\s*=\s*0\.5/,
            /MinRepeatTokens\s*=\s*64/,
            /repeatRatio\(/,
            /StatusCodes\.UnprocessableEntity/,
          ],
        },
        cpp: {all: [/kMaxRepeatRatio\s*=\s*0\.5/, /kMinRepeatTokens\s*=\s*64/, /repeatRatio\(/, /status\s*=\s*422/]},
      },
    },
    {
      id: 'auth-idempotency',
      title: 'Authenticates the user and keys retries by (user, Idempotency-Key)',
      detail:
        'A missing `X-User-Id` is **401**; `Idempotency-Key` is required and the answer is stored under `(user, key)` so a replay returns it instead of asking the model again. The draft ignores both.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/code\(\s*401\s*\)/, /idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/StatusUnauthorized/, /Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/status\s*=\s*401/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
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

MAX_QUESTION_CHARS = 2000


class AskRequest(BaseModel):
    document_id: str
    question: str


class DocumentStore:
    def get(self, document_id: str) -> str | None:
        """The text of the document, if the id is known."""
        raise NotImplementedError


docs = DocumentStore()


@app.post("/v1/ask")
def ask(body: AskRequest, user: str = Header(alias="X-User-Id")) -> JSONResponse:
    # TODO: this draft caps the question in characters, forwards control characters and repeated
    # tokens to the template, ignores Idempotency-Key and logs the question. Review all four.
    if len(body.question) > MAX_QUESTION_CHARS:
        raise HTTPException(status_code=413, detail="question too long")
    document = docs.get(body.document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="unknown document")
    result = answer(document, body.question)
    logger.info("ask user=%s question=%r", user, body.question)
    return JSONResponse({"answer": result.answer}, status_code=200)
`,
      solution: `import hashlib
import logging
import re
import uuid

import tiktoken
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from model_call import answer

app = FastAPI()
logger = logging.getLogger("promptguard")
encoding = tiktoken.get_encoding("cl100k_base")

MAX_QUESTION_TOKENS = 512
MIN_REPEAT_TOKENS = 64
MAX_REPEAT_RATIO = 0.5
CONTROL_CHARS = re.compile(r"[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]")


class AskRequest(BaseModel):
    document_id: str
    question: str


class DocumentStore:
    def get(self, document_id: str) -> str | None:
        """The text of the document, if the id is known."""
        raise NotImplementedError


class AskStore:
    def get(self, user: str, idem_key: str) -> dict | None:
        """The answer stored for (user, idem_key), if any."""
        raise NotImplementedError

    def put(self, user: str, idem_key: str, decision: dict) -> None:
        """Store the answer under (user, idem_key)."""
        raise NotImplementedError


docs = DocumentStore()
store = AskStore()


def strip_controls(text: str) -> str:
    """Raw control characters and the escape strings \\\\b and \\\\r are not part of a question."""
    return CONTROL_CHARS.sub("", text)


def repeat_ratio(tokens: list[int]) -> float:
    """Share of the tokens covered by the most repeated 1-, 2- or 3-token sequence."""
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


@app.post("/v1/ask")
def ask(
    body: AskRequest,
    user: str | None = Header(default=None, alias="X-User-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if user is None or user == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    question = strip_controls(body.question).strip()
    if question == "":
        raise HTTPException(status_code=400, detail="question must be a non-empty string")
    tokens = encoding.encode(question)
    if len(tokens) > MAX_QUESTION_TOKENS:
        raise HTTPException(status_code=413, detail="question exceeds 512 tokens")
    if repeat_ratio(tokens) > MAX_REPEAT_RATIO:
        raise HTTPException(status_code=422, detail="repeated token sequence")

    stored = store.get(user, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    document = docs.get(body.document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="unknown document")
    result = answer(document, question)
    decision = {
        "request_id": str(uuid.uuid4()),
        "document_hash": hashlib.sha256(document.encode("utf-8")).hexdigest(),
        "answer": result.answer,
    }
    store.put(user, idem_key, decision)
    logger.info("ask user=%s doc=%s tokens=%d", user, body.document_id, len(tokens))
    return JSONResponse(decision, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/ask: a model-generated draft that caps characters and forwards the text as is. */
import Fastify from 'fastify';

import {docs} from './docs';
import {answer} from './model_call';

export const app = Fastify();

const MAX_QUESTION_CHARS = 2000;

interface AskBody {
  document_id: string;
  question: string;
}

app.post('/v1/ask', async (request, reply) => {
  // TODO: this draft caps the question in characters, forwards control characters and repeated
  // tokens to the template, ignores Idempotency-Key and logs the question. Review all four.
  const user = request.headers['x-user-id'] as string;
  const body = request.body as AskBody;
  if (body.question.length > MAX_QUESTION_CHARS) return reply.code(413).send({error: 'question too long'});
  const document = await docs.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  const result = await answer(document, body.question);
  request.log.info({user, question: body.question}, 'asked');
  return reply.code(200).send({answer: result.answer});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/ask: token-capped, control-stripped, repetition-checked, idempotent questions. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {getEncoding} from 'js-tiktoken';

import {docs} from './docs';
import {answer} from './model_call';
import {store} from './store';

export const app = Fastify();
const encoding = getEncoding('cl100k_base');

const MAX_QUESTION_TOKENS = 512;
const MIN_REPEAT_TOKENS = 64;
const MAX_REPEAT_RATIO = 0.5;
const CONTROL_CHARS = /[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]/g;

interface AskBody {
  document_id: string;
  question: string;
}

interface Decision {
  request_id: string;
  document_hash: string;
  answer: string;
}

/** Raw control characters and the escape strings \\\\b and \\\\r are not part of a question. */
function stripControls(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** Share of the tokens covered by the most repeated 1-, 2- or 3-token sequence. */
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

app.post('/v1/ask', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<AskBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.question !== 'string' || typeof body.document_id !== 'string')
    return reply.code(400).send({error: 'document_id and question are required'});
  const question = stripControls(body.question).trim();
  if (question === '') return reply.code(400).send({error: 'question must be a non-empty string'});
  const tokens = encoding.encode(question);
  if (tokens.length > MAX_QUESTION_TOKENS) return reply.code(413).send({error: 'question exceeds 512 tokens'});
  if (repeatRatio(tokens) > MAX_REPEAT_RATIO) return reply.code(422).send({error: 'repeated token sequence'});

  const stored: Decision | null = await store.get(user, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const document = await docs.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  const result = await answer(document, question);
  const decision: Decision = {
    request_id: randomUUID(),
    document_hash: createHash('sha256').update(document).digest('hex'),
    answer: result.answer,
  };
  await store.put(user, idemKey, decision);
  request.log.info({user, document_id: body.document_id, tokens: tokens.length}, 'asked');
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

const maxQuestionChars = 2000

type AskRequest struct {
	DocumentID string \`json:"document_id"\`
	Question   string \`json:"question"\`
}

type DocumentStore struct{}

func (s *DocumentStore) Get(id string) (string, bool) {
	return "", false
}

var docs = &DocumentStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ask(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	var body AskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft caps the question in characters, forwards control characters and repeated
	// tokens to the template, ignores Idempotency-Key and logs the question. Review all four.
	if len(body.Question) > maxQuestionChars {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "question too long"})
		return
	}
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
	log.Printf("ask user=%s question=%q", user, body.Question)
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
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

const (
	maxQuestionTokens = 512
	minRepeatTokens   = 64
	maxRepeatRatio    = 0.5
)

// Raw control characters (newline and tab stay) and the escape strings \\b and \\r.
var controlChars = regexp.MustCompile(\`[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]\`)

// Tokenizer is the model's own tokenizer (cl100k_base); counting tokens is the only cap that sees
// what the model sees.
type Tokenizer interface {
	Encode(text string) []int
}

var tokenizer Tokenizer

type AskRequest struct {
	DocumentID string \`json:"document_id"\`
	Question   string \`json:"question"\`
}

type DocumentStore struct{}

func (s *DocumentStore) Get(id string) (string, bool) {
	return "", false
}

type AskStore struct{}

func (s *AskStore) Get(ctx context.Context, user, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *AskStore) Put(ctx context.Context, user, idemKey string, decision map[string]any) error {
	return nil
}

var (
	docs  = &DocumentStore{}
	store = &AskStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func stripControls(text string) string {
	return controlChars.ReplaceAllString(text, "")
}

// repeatRatio is the share of the tokens covered by the most repeated 1-, 2- or 3-token sequence.
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

func ask(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body AskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	question := strings.TrimSpace(stripControls(body.Question))
	if question == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "question must be a non-empty string"})
		return
	}
	tokens := tokenizer.Encode(question)
	if len(tokens) > maxQuestionTokens {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "question exceeds 512 tokens"})
		return
	}
	if repeatRatio(tokens) > maxRepeatRatio {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "repeated token sequence"})
		return
	}
	stored, err := store.Get(r.Context(), user, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	document, ok := docs.Get(body.DocumentID)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown document"})
		return
	}
	result, err := answer(r.Context(), document, question)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	sum := sha256.Sum256([]byte(document))
	decision := map[string]any{
		"request_id":    uuid.NewString(),
		"document_hash": hex.EncodeToString(sum[:]),
		"answer":        result.Answer,
	}
	if err := store.Put(r.Context(), user, idemKey, decision); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("ask user=%s doc=%s tokens=%d", user, body.DocumentID, len(tokens))
	writeJSON(rw, http.StatusOK, decision)
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

object AskApi {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val askFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)

  val MaxQuestionChars = 2000
  val docs = DocumentStore.open()

  val route: Route =
    path("v1" / "ask") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[AskRequest]) { body =>
            // TODO: this draft caps the question in characters, forwards control characters and
            // repeated tokens to the template, ignores Idempotency-Key and logs the question.
            if (body.question.length > MaxQuestionChars) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"question too long"}""")
            } else {
              docs.get(body.document_id) match {
                case None => complete(StatusCodes.NotFound, """{"error":"unknown document"}""")
                case Some(document) =>
                  val result = ModelCall.answer(document, body.question)
                  system.log.info(s"ask user=$user question=\${body.question}")
                  complete(StatusCodes.OK, s"""{"answer":"\${result.answer}"}""")
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
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AskRequest(document_id: String, question: String)
final case class Decision(request_id: String, document_hash: String, answer: String)

object AskApi {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val askFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat3(Decision)

  val MaxQuestionTokens = 512
  val MinRepeatTokens = 64
  val MaxRepeatRatio = 0.5
  // Raw control characters (newline and tab stay) and the escape strings \\\\b and \\\\r.
  val ControlChars = "[\\\\x00-\\\\x08\\\\x0b-\\\\x1f\\\\x7f]|\\\\\\\\[br]".r

  val docs = DocumentStore.open()
  val store = AskStore.open()
  val tokenizer = Tokenizer.open("cl100k_base")

  def stripControls(text: String): String = ControlChars.replaceAllIn(text, "")

  /** Share of the tokens covered by the most repeated 1-, 2- or 3-token sequence. */
  def repeatRatio(tokens: Seq[Int]): Double = {
    if (tokens.length < MinRepeatTokens) 0.0
    else
      (1 to 3).map { n =>
        val top = tokens.sliding(n).toSeq.groupBy(identity).values.map(_.size).max
        top.toDouble * n / tokens.length
      }.max
  }

  def sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  val route: Route =
    path("v1" / "ask") {
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[AskRequest]) { body =>
              val question = stripControls(body.question).trim
              lazy val tokens = tokenizer.encode(question)
              if (!userOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (question.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"question must be a non-empty string"}""")
              } else if (tokens.length > MaxQuestionTokens) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"question exceeds 512 tokens"}""")
              } else if (repeatRatio(tokens) > MaxRepeatRatio) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"repeated token sequence"}""")
              } else {
                val user = userOpt.get
                val idemKey = idemOpt.get
                store.get(user, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    docs.get(body.document_id) match {
                      case None => complete(StatusCodes.NotFound, """{"error":"unknown document"}""")
                      case Some(document) =>
                        val result = ModelCall.answer(document, question)
                        val decision = Decision(UUID.randomUUID().toString, sha256(document), result.answer)
                        store.put(user, idemKey, decision)
                        system.log.info(s"ask user=$user doc=\${body.document_id} tokens=\${tokens.length}")
                        complete(StatusCodes.OK, decision)
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
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxQuestionChars = 2000;

struct DocumentStore {
  std::optional<std::string> get(const std::string& documentId);
};

DocumentStore docs;

struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

ModelAnswer answer(const std::string& document, const std::string& question);

int main() {
  httplib::Server svr;

  svr.Post("/v1/ask", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft caps the question in characters, forwards control characters and repeated
    // tokens to the template, ignores Idempotency-Key and logs the question. Review all four.
    const auto question = body.value("question", std::string());
    if (question.size() > kMaxQuestionChars) {
      res.status = 413;
      res.set_content(R"({"error":"question too long"})", "application/json");
      return;
    }
    const auto document = docs.get(body.value("document_id", std::string()));
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document"})", "application/json");
      return;
    }
    const auto result = answer(*document, question);
    std::cerr << "ask user=" << user << " question=" << question << "\\n";
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
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxQuestionTokens = 512;
constexpr std::size_t kMinRepeatTokens = 64;
constexpr double kMaxRepeatRatio = 0.5;
// Raw control characters (newline and tab stay) and the escape strings \\\\b and \\\\r.
const std::regex kControlChars = std::regex(R"([\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br])");

// The model's own tokenizer (cl100k_base): counting tokens is the only cap that sees what the model sees.
struct Tokenizer {
  std::vector<int> encode(const std::string& text);
};

struct DocumentStore {
  std::optional<std::string> get(const std::string& documentId);
};

struct AskStore {
  std::optional<json> get(const std::string& user, const std::string& idemKey);
  void put(const std::string& user, const std::string& idemKey, const json& decision);
};

Tokenizer tokenizer;
DocumentStore docs;
AskStore store;

struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

ModelAnswer answer(const std::string& document, const std::string& question);
std::string sha256Hex(const std::string& text);
std::string uuidString();

std::string stripControls(const std::string& text) {
  return std::regex_replace(text, kControlChars, "");
}

// Share of the tokens covered by the most repeated 1-, 2- or 3-token sequence.
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

std::string trim(const std::string& text) {
  const auto first = text.find_first_not_of(" \\t\\n");
  if (first == std::string::npos) return "";
  const auto last = text.find_last_not_of(" \\t\\n");
  return text.substr(first, last - first + 1);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/ask", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    if (user.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("question") || !body["question"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    const auto question = trim(stripControls(body["question"].get<std::string>()));
    if (question.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    const auto tokens = tokenizer.encode(question);
    if (tokens.size() > kMaxQuestionTokens) {
      res.status = 413;
      res.set_content(R"({"error":"question exceeds 512 tokens"})", "application/json");
      return;
    }
    if (repeatRatio(tokens) > kMaxRepeatRatio) {
      res.status = 422;
      res.set_content(R"({"error":"repeated token sequence"})", "application/json");
      return;
    }
    const auto stored = store.get(user, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto documentId = body.value("document_id", std::string());
    const auto document = docs.get(documentId);
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document"})", "application/json");
      return;
    }
    const auto result = answer(*document, question);
    const json decision = {
        {"request_id", uuidString()},
        {"document_hash", sha256Hex(*document)},
        {"answer", result.answer},
    };
    store.put(user, idemKey, decision);
    std::cerr << "ask user=" << user << " doc=" << documentId << " tokens=" << tokens.size() << "\\n";
    res.status = 200;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order: user, Idempotency-Key, normalise, encode, token cap, repeat ratio, idempotency lookup, document, model. Every rejection happens before the model is paid for, and the normalisation happens before anything is measured — a cap on the raw text would count control characters that are about to be stripped.',
    'The source’s point is that the model sees tokens, not characters: 450 JSON-encoded backspaces are 450 tokens. Encode the normalised question with `cl100k_base` and compare the length to 512. For the repeat ratio, count every 1-, 2- and 3-token window; the largest `count × n / len` is how much of the question one phrase covers.',
    'The idempotency lookup is keyed by `(user, key)` and returns the stored decision with 200 before the document is loaded. Log user, document id and token count only — the question is user content, so it never goes into a log line verbatim.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of an LLM feature. The draft reads fine because the demo sends short, clean questions. Four defects are being checked: caps counted in the unit the model counts in (tokens), normalisation of control characters and their escape strings before anything is measured, detection of repeated 1–3 token sequences by the share of the input they cover, and authentication plus idempotency keyed by user so a retry cannot ask the model twice. The log line is the one candidates miss: the question is user content and must never be logged verbatim. Real services add a tokenizer per model, an allow-list for legitimate control characters in code-review use cases (the source names that trade-off), and a per-document token budget so the context cannot crowd out the instructions.`,
};
