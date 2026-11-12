import type {Step} from '@/lib/types';

export const askEndpointStep: Step = {
  id: 'ask-endpoint',
  title: 'POST /v1/ask: tokens, control characters, repeated tokens',
  concept: 'http',
  file: 'ask_api',
  focus: ['client', 'api', 'docs', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/ask\` with body
\`{"document_id": "…", "question": "…"}\`: 401 without \`X-User-Id\`, 413 above 2 000 characters,
then \`admit(user)\` (step 2; 429 with \`Retry-After\`), the document from the provided store (404 when
unknown), \`respond(user, document_id, document, question)\` (step 4; 503 on \`ModelUnavailable\`),
\`remember\` (step 2), and 200 with the decision. It serves the demo and hides four flaws.

**Failure mode the checks target.** The source's 450 encoded backspaces fit in a few hundred
characters and are 450 tokens to the model; a character cap measures the wrong unit and passes
them straight into the template. \`jq_THREADS\` repeated 2 048 times passes too, and a client that
retries a slow answer pays for a second model call.

- \`strip_controls\` removes \`CONTROL_CHARS\` (raw \`\\x00\`–\`\\x08\`, \`\\x0b\`–\`\\x1f\`, \`\\x7f\`; tab and
  newline stay; and the typed escapes \`\\b\`, \`\\r\`) before anything is measured; an empty question
  is 400.
- Cap in tokens with the provided \`tokenize\`: more than \`MAX_QUESTION_TOKENS = 512\` is 413.
- At 64 tokens or more, \`repeat_ratio\` above \`MAX_REPEAT_RATIO = 0.5\` is 422.
- \`Idempotency-Key\` is required (400); \`asks.get(user, key)\` returns a stored decision before
  \`admit\`, and \`asks.put(user, key, decision)\` keeps a new one.`,
  sequence: {
    participants: ['File viewer', 'promptguard', 'Redis', 'answer guard'],
    messages: [
      {from: 'File viewer', to: 'promptguard', label: 'POST /v1/ask · X-User-Id · Idempotency-Key', kind: 'sync'},
      {from: 'promptguard', to: 'promptguard', label: 'strip controls · tokenize · 512 · repeat ratio', kind: 'sync'},
      {from: 'promptguard', to: 'Redis', label: 'asks.get(user, key) · admit(user) · doc:{id}', kind: 'sync'},
      {from: 'promptguard', to: 'answer guard', label: 'respond(user, document_id, document, question)', kind: 'sync'},
      {from: 'answer guard', to: 'promptguard', label: 'decision', kind: 'reply'},
      {from: 'promptguard', to: 'Redis', label: 'remember · asks.put(user, key, decision)', kind: 'async'},
      {
        from: 'promptguard',
        to: 'File viewer',
        label: '200 decision · 400 / 401 / 404 / 413 / 422 / 429 / 503',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Symptom: a short-looking question full of backspaces gets an answer that ignores the document, `jq_THREADS` pasted 2 048 times reaches the model, a long but ordinary question is refused, and a client retry costs a second model call.',
    'Mechanism: the starter measures `len(body.question)` in characters, never strips control characters before the question reaches the template, never looks at repetition, and has no `(user, Idempotency-Key)` lookup.',
    'Change: `question = strip_controls(body.question).strip()`; `tokens = tokenize(question)`; 413 above 512, 422 when `len(tokens) >= 64` and `repeat_ratio(tokens) > 0.5`; require the key, `asks.get` before `admit`, `asks.put` after `respond`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/ask',
      detail:
        'A valid question answers 200 with the decision (request_id, document_hash, answer, spans, refused, signals, signature); no X-User-Id is 401, an unknown document 404, a user over the limit 429 with Retry-After and no model call.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/ask["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/ask['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/ask"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"ask"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/ask"/]},
      },
    },
    {
      id: 'control-chars',
      title: 'Strips control characters and their escape strings first',
      detail:
        'A question of 400 backspaces, 450 typed \\b escapes and "What is the notice period?" reaches the model as the question alone; a question of nothing but controls is 400. The starter forwards the text untouched.',
      match: {
        python: {all: [/CONTROL_CHARS\s*=/, /strip_controls\(\s*body\.question\s*\)/]},
        typescript: {all: [/CONTROL_CHARS\s*=/, /stripControls\(\s*body\.question\s*\)/]},
        go: {all: [/controlChars\s*=/, /stripControls\(\s*body\.Question\s*\)/]},
        scala: {all: [/ControlChars\s*[:=]/, /stripControls\(\s*body\.question\s*\)/]},
        cpp: {all: [/kControlChars\(/, /strip_controls\(\s*raw_question\s*\)/]},
      },
    },
    {
      id: 'token-cap',
      title: 'Caps the question at 512 tokens, not 2 000 characters',
      detail:
        'A 940-character question of 600 tokens is 413 with no model call; a 3 200-character question of 190 tokens is answered. The starter counts characters, so it does the opposite.',
      match: {
        python: {
          all: [/MAX_QUESTION_TOKENS\s*=\s*512/, /len\(tokens\)\s*>\s*MAX_QUESTION_TOKENS/],
          none: [/MAX_QUESTION_CHARS/],
        },
        typescript: {
          all: [/MAX_QUESTION_TOKENS\s*=\s*512/, /tokens\.length\s*>\s*MAX_QUESTION_TOKENS/],
          none: [/MAX_QUESTION_CHARS/],
        },
        go: {all: [/maxQuestionTokens\s*=\s*512/, /len\(toks\)\s*>\s*maxQuestionTokens/], none: [/maxQuestionChars/]},
        scala: {all: [/MaxQuestionTokens\s*=\s*512/, /toks\.size\s*>\s*MaxQuestionTokens/], none: [/MaxQuestionChars/]},
        cpp: {
          all: [/kMaxQuestionTokens\s*=\s*512/, /toks\.size\(\)\s*>\s*kMaxQuestionTokens/],
          none: [/kMaxQuestionChars/],
        },
      },
    },
    {
      id: 'repeat-ratio',
      title: 'Rejects a question that is one phrase repeated',
      detail:
        'jq_THREADS 100 times and "/goto maiden" 40 times are 422 with no model call; a 40-token repeat (under 64 tokens) and a varied 80-token question are answered. The starter has no repetition check.',
      match: {
        python: {all: [/repeat_ratio\(\s*tokens\s*\)\s*>\s*MAX_REPEAT_RATIO/, /status_code\s*=\s*422/]},
        typescript: {all: [/repeatRatio\(\s*tokens\s*\)\s*>\s*MAX_REPEAT_RATIO/, /code\(\s*422\s*\)/]},
        go: {all: [/tokens\.RepeatRatio\(\s*toks\s*\)\s*>\s*maxRepeatRatio/, /StatusUnprocessableEntity/]},
        scala: {all: [/Tokens\.repeatRatio\(\s*toks\s*\)\s*>\s*MaxRepeatRatio/, /UnprocessableEntity/]},
        cpp: {all: [/tokens::repeat_ratio\(\s*toks\s*\)\s*>\s*kMaxRepeatRatio/, /\b422\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (user, Idempotency-Key)',
      detail:
        'Without Idempotency-Key the request is 400; a replay of the same (user, key) answers the stored decision with no second model call; another user with the same key gets an answer of their own. The starter ignores the header.',
      match: {
        python: {all: [/Idempotency-Key/, /asks\.get\(\s*user\s*,/, /asks\.put\(\s*user\s*,/]},
        typescript: {all: [/idempotency-key/, /asks\.get\(\s*user\s*,/, /asks\.put\(\s*user\s*,/]},
        go: {all: [/Idempotency-Key/, /asks\.Get\(/, /asks\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /Asks\.get\(/, /Asks\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /asks::get\(/, /asks::put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/ask: a question about a document."""
import logging
from dataclasses import asdict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from answer_guard import respond  # step 4: the decision (model call, guard, event)
from limits import admit, remember  # step 2: the user's window, the session
from promptguard import documents
from promptguard.types import ModelUnavailable

app = FastAPI()
logger = logging.getLogger("promptguard.api")

MAX_QUESTION_CHARS = 2000


class AskRequest(BaseModel):
    document_id: str
    question: str


@app.post("/v1/ask")
def ask(body: AskRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    user = request.headers.get("X-User-Id", "")
    if user == "":
        return JSONResponse({"error": "missing X-User-Id"}, status_code=401)
    if len(body.question) > MAX_QUESTION_CHARS:
        return JSONResponse({"error": "question too long"}, status_code=413)
    admission = admit(user)
    if not admission.ok:
        return JSONResponse({"error": "rate limited"}, status_code=429, headers={"Retry-After": str(admission.retry_after)})
    document = documents.get(body.document_id)
    if document is None:
        return JSONResponse({"error": "unknown document"}, status_code=404)
    try:
        decision = respond(user, body.document_id, document, body.question)
    except ModelUnavailable:
        return JSONResponse({"error": "model unavailable"}, status_code=503)
    remember(user, body.document_id, body.question)
    logger.info("ask user=%s doc=%s chars=%d refused=%s", user, body.document_id, len(body.question), decision.refused)
    return JSONResponse(asdict(decision), status_code=200)
`,
      solution: `"""POST /v1/ask: a question about a document, measured in tokens before anything else sees it."""
import logging
import re
from dataclasses import asdict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from answer_guard import respond  # step 4: the decision (model call, guard, event)
from limits import admit, remember  # step 2: the user's window, the session
from promptguard import asks, documents
from promptguard.tokens import repeat_ratio, tokenize
from promptguard.types import ModelUnavailable

app = FastAPI()
logger = logging.getLogger("promptguard.api")

MAX_QUESTION_TOKENS = 512
MIN_REPEAT_TOKENS = 64
MAX_REPEAT_RATIO = 0.5
# Raw control characters except tab and newline, and the escape strings \\b and \\r as typed.
CONTROL_CHARS = re.compile(r"[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]")


class AskRequest(BaseModel):
    document_id: str
    question: str


def strip_controls(text: str) -> str:
    return CONTROL_CHARS.sub("", text)


@app.post("/v1/ask")
def ask(body: AskRequest, request: Request) -> JSONResponse:
    user = request.headers.get("X-User-Id", "")
    if user == "":
        return JSONResponse({"error": "missing X-User-Id"}, status_code=401)
    idem_key = request.headers.get("Idempotency-Key", "")
    if idem_key == "":
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    question = strip_controls(body.question).strip()
    if question == "":
        return JSONResponse({"error": "the question is empty"}, status_code=400)
    tokens = tokenize(question)
    if len(tokens) > MAX_QUESTION_TOKENS:
        return JSONResponse({"error": "the question is over 512 tokens"}, status_code=413)
    if len(tokens) >= MIN_REPEAT_TOKENS and repeat_ratio(tokens) > MAX_REPEAT_RATIO:
        return JSONResponse({"error": "the question repeats one sequence"}, status_code=422)

    stored = asks.get(user, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)
    admission = admit(user)
    if not admission.ok:
        return JSONResponse({"error": "rate limited"}, status_code=429, headers={"Retry-After": str(admission.retry_after)})
    document = documents.get(body.document_id)
    if document is None:
        return JSONResponse({"error": "unknown document"}, status_code=404)
    try:
        decision = respond(user, body.document_id, document, question)
    except ModelUnavailable:
        return JSONResponse({"error": "model unavailable"}, status_code=503)
    remember(user, body.document_id, question)
    asks.put(user, idem_key, asdict(decision))
    logger.info("ask user=%s doc=%s tokens=%d refused=%s", user, body.document_id, len(tokens), decision.refused)
    return JSONResponse(asdict(decision), status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/ask: a question about a document. */
import Fastify from 'fastify';

import {respond} from './answer_guard'; // step 4: the decision (model call, guard, event)
import {admit, remember} from './limits'; // step 2: the user's window, the session
import {documents} from 'promptguard/documents';
import {ModelUnavailable} from 'promptguard/types';

export const app = Fastify();

export const MAX_QUESTION_CHARS = 2000;

interface AskBody {
  document_id: string;
  question: string;
}

app.post('/v1/ask', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const body = request.body as AskBody;
  if (body.question.length > MAX_QUESTION_CHARS) return reply.code(413).send({error: 'question too long'});
  const admission = await admit(user);
  if (!admission.ok) return reply.code(429).header('Retry-After', String(admission.retry_after)).send({error: 'rate limited'});
  const document = await documents.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  try {
    const decision = await respond(user, body.document_id, document, body.question);
    await remember(user, body.document_id, body.question);
    request.log.info({user, doc: body.document_id, chars: body.question.length, refused: decision.refused}, 'ask');
    return reply.code(200).send(decision);
  } catch (err) {
    if (err instanceof ModelUnavailable) return reply.code(503).send({error: 'model unavailable'});
    throw err;
  }
});
`,
      solution: `/** POST /v1/ask: a question about a document, measured in tokens before anything else sees it. */
import Fastify from 'fastify';

import {respond} from './answer_guard'; // step 4: the decision (model call, guard, event)
import {admit, remember} from './limits'; // step 2: the user's window, the session
import {asks} from 'promptguard/asks';
import {documents} from 'promptguard/documents';
import {repeatRatio, tokenize} from 'promptguard/tokens';
import {ModelUnavailable} from 'promptguard/types';

export const app = Fastify();

export const MAX_QUESTION_TOKENS = 512;
export const MIN_REPEAT_TOKENS = 64;
export const MAX_REPEAT_RATIO = 0.5;
/** Raw control characters except tab and newline, and the escape strings \\b and \\r as typed. */
export const CONTROL_CHARS = /[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]/g;

export const stripControls = (text: string): string => text.replace(CONTROL_CHARS, '');

interface AskBody {
  document_id: string;
  question: string;
}

app.post('/v1/ask', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as AskBody;
  const question = stripControls(body.question).trim();
  if (question === '') return reply.code(400).send({error: 'the question is empty'});
  const tokens = tokenize(question);
  if (tokens.length > MAX_QUESTION_TOKENS) return reply.code(413).send({error: 'the question is over 512 tokens'});
  if (tokens.length >= MIN_REPEAT_TOKENS && repeatRatio(tokens) > MAX_REPEAT_RATIO)
    return reply.code(422).send({error: 'the question repeats one sequence'});

  const stored = await asks.get(user, idemKey);
  if (stored !== null) return reply.code(200).send(stored);
  const admission = await admit(user);
  if (!admission.ok) return reply.code(429).header('Retry-After', String(admission.retry_after)).send({error: 'rate limited'});
  const document = await documents.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  try {
    const decision = await respond(user, body.document_id, document, question);
    await remember(user, body.document_id, question);
    await asks.put(user, idemKey, decision);
    request.log.info({user, doc: body.document_id, tokens: tokens.length, refused: decision.refused}, 'ask');
    return reply.code(200).send(decision);
  } catch (err) {
    if (err instanceof ModelUnavailable) return reply.code(503).send({error: 'model unavailable'});
    throw err;
  }
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"promptguard/documents" // documents.Get(ctx, id) — provided
	"promptguard/types"     // types.Admission, types.Decision, types.ErrModelUnavailable — provided
)

const maxQuestionChars = 2000

// Built in step 2 (limits.go): the user's window and the session.
var (
	admit    = func(ctx context.Context, user string) (types.Admission, error) { panic("built in step 2") }
	remember = func(ctx context.Context, user, documentID, question string) error { panic("built in step 2") }
)

// Built in step 4 (answer_guard.go): the decision (model call, guard, event).
var respond = func(ctx context.Context, user, documentID, document, question string) (types.Decision, error) {
	panic("built in step 4")
}

type AskRequest struct {
	DocumentID string \`json:"document_id"\`
	Question   string \`json:"question"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func ask(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	user := r.Header.Get("X-User-Id")
	if user == "" {
		fail(rw, http.StatusUnauthorized, "missing X-User-Id")
		return
	}
	var body AskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, http.StatusBadRequest, "invalid json")
		return
	}
	if len(body.Question) > maxQuestionChars {
		fail(rw, http.StatusRequestEntityTooLarge, "question too long")
		return
	}
	admission, err := admit(ctx, user)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, "try again")
		return
	}
	if !admission.OK {
		rw.Header().Set("Retry-After", strconv.FormatInt(admission.RetryAfter, 10))
		fail(rw, http.StatusTooManyRequests, "rate limited")
		return
	}
	document, ok, err := documents.Get(ctx, body.DocumentID)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, "try again")
		return
	}
	if !ok {
		fail(rw, http.StatusNotFound, "unknown document")
		return
	}
	decision, err := respond(ctx, user, body.DocumentID, document, body.Question)
	if errors.Is(err, types.ErrModelUnavailable) {
		fail(rw, http.StatusServiceUnavailable, "model unavailable")
		return
	}
	if err != nil {
		fail(rw, http.StatusInternalServerError, "internal error")
		return
	}
	if err := remember(ctx, user, body.DocumentID, body.Question); err != nil {
		log.Printf("session not kept user=%s: %v", user, err)
	}
	log.Printf("ask user=%s doc=%s chars=%d refused=%v", user, body.DocumentID, len(body.Question), decision.Refused)
	writeJSON(rw, http.StatusOK, decision)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/ask", ask)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"promptguard/asks"      // asks.Get(ctx, user, key), asks.Put(ctx, user, key, d) — provided
	"promptguard/documents" // documents.Get(ctx, id) — provided
	"promptguard/tokens"    // tokens.Tokenize, tokens.RepeatRatio — provided
	"promptguard/types"     // types.Admission, types.Decision, types.ErrModelUnavailable — provided
)

const (
	maxQuestionTokens = 512
	minRepeatTokens   = 64
	maxRepeatRatio    = 0.5
)

// controlChars: raw control characters except tab and newline, and the escape strings \\b and \\r as typed.
var controlChars = regexp.MustCompile(\`[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]\`)

// Built in step 2 (limits.go): the user's window and the session.
var (
	admit    = func(ctx context.Context, user string) (types.Admission, error) { panic("built in step 2") }
	remember = func(ctx context.Context, user, documentID, question string) error { panic("built in step 2") }
)

// Built in step 4 (answer_guard.go): the decision (model call, guard, event).
var respond = func(ctx context.Context, user, documentID, document, question string) (types.Decision, error) {
	panic("built in step 4")
}

type AskRequest struct {
	DocumentID string \`json:"document_id"\`
	Question   string \`json:"question"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func stripControls(text string) string { return controlChars.ReplaceAllString(text, "") }

func ask(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := r.Header.Get("X-User-Id")
	if user == "" {
		fail(rw, http.StatusUnauthorized, "missing X-User-Id")
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		fail(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body AskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, http.StatusBadRequest, "invalid json")
		return
	}
	question := strings.TrimSpace(stripControls(body.Question))
	if question == "" {
		fail(rw, http.StatusBadRequest, "the question is empty")
		return
	}
	toks := tokens.Tokenize(question)
	if len(toks) > maxQuestionTokens {
		fail(rw, http.StatusRequestEntityTooLarge, "the question is over 512 tokens")
		return
	}
	if len(toks) >= minRepeatTokens && tokens.RepeatRatio(toks) > maxRepeatRatio {
		fail(rw, http.StatusUnprocessableEntity, "the question repeats one sequence")
		return
	}

	stored, err := asks.Get(ctx, user, idemKey)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, "try again")
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	admission, err := admit(ctx, user)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, "try again")
		return
	}
	if !admission.OK {
		rw.Header().Set("Retry-After", strconv.FormatInt(admission.RetryAfter, 10))
		fail(rw, http.StatusTooManyRequests, "rate limited")
		return
	}
	document, ok, err := documents.Get(ctx, body.DocumentID)
	if err != nil {
		fail(rw, http.StatusServiceUnavailable, "try again")
		return
	}
	if !ok {
		fail(rw, http.StatusNotFound, "unknown document")
		return
	}
	decision, err := respond(ctx, user, body.DocumentID, document, question)
	if errors.Is(err, types.ErrModelUnavailable) {
		fail(rw, http.StatusServiceUnavailable, "model unavailable")
		return
	}
	if err != nil {
		fail(rw, http.StatusInternalServerError, "internal error")
		return
	}
	if err := remember(ctx, user, body.DocumentID, question); err != nil {
		log.Printf("session not kept user=%s: %v", user, err)
	}
	if err := asks.Put(ctx, user, idemKey, decision); err != nil {
		log.Printf("answer not kept user=%s: %v", user, err)
	}
	log.Printf("ask user=%s doc=%s tokens=%d refused=%v", user, body.DocumentID, len(toks), decision.Refused)
	writeJSON(rw, http.StatusOK, decision)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/ask", ask)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import promptguard.{Documents, ModelUnavailable}

final case class AskRequest(document_id: String, question: String)

/** POST /v1/ask: a question about a document. */
object AskApi {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val requestFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)

  val MaxQuestionChars = 2000

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private def error(status: StatusCode, message: String): Route = json(status, ujson.write(ujson.Obj("error" -> message)))

  val route: Route =
    path("v1" / "ask") {
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          entity(as[AskRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!userOpt.exists(_.nonEmpty)) error(StatusCodes.Unauthorized, "missing X-User-Id")
            else if (body.question.length > MaxQuestionChars) error(StatusCodes.PayloadTooLarge, "question too long")
            else {
              val user = userOpt.get
              val admission = Limits.admit(user)
              if (!admission.ok)
                respondWithHeader(RawHeader("Retry-After", admission.retryAfter.toString)) {
                  error(StatusCodes.TooManyRequests, "rate limited")
                }
              else
                Documents.get(body.document_id) match {
                  case None => error(StatusCodes.NotFound, "unknown document")
                  case Some(document) =>
                    try {
                      val decision = AnswerGuard.respond(user, body.document_id, document, body.question)
                      Limits.remember(user, body.document_id, body.question)
                      system.log.info(s"ask user=$user doc=\${body.document_id} chars=\${body.question.length}")
                      json(StatusCodes.OK, ujson.write(decision.toJson))
                    } catch {
                      case _: ModelUnavailable => error(StatusCodes.ServiceUnavailable, "model unavailable")
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
      solution: `import scala.util.matching.Regex

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import promptguard.{Asks, Documents, ModelUnavailable, Tokens}

final case class AskRequest(document_id: String, question: String)

/** POST /v1/ask: a question about a document, measured in tokens before anything else sees it. */
object AskApi {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val requestFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)

  val MaxQuestionTokens = 512
  val MinRepeatTokens = 64
  val MaxRepeatRatio = 0.5
  /** Raw control characters except tab and newline, and the escape strings \\b and \\r as typed. */
  val ControlChars: Regex = """[\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br]""".r

  def stripControls(text: String): String = ControlChars.replaceAllIn(text, "")

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private def error(status: StatusCode, message: String): Route = json(status, ujson.write(ujson.Obj("error" -> message)))

  val route: Route =
    path("v1" / "ask") {
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[AskRequest]) { body =>
              val question = stripControls(body.question).trim
              val toks = Tokens.tokenize(question)
              if (!userOpt.exists(_.nonEmpty)) error(StatusCodes.Unauthorized, "missing X-User-Id")
              else if (!idemOpt.exists(_.nonEmpty)) error(StatusCodes.BadRequest, "Idempotency-Key is required")
              else if (question.isEmpty) error(StatusCodes.BadRequest, "the question is empty")
              else if (toks.size > MaxQuestionTokens) error(StatusCodes.PayloadTooLarge, "the question is over 512 tokens")
              else if (toks.size >= MinRepeatTokens && Tokens.repeatRatio(toks) > MaxRepeatRatio)
                error(StatusCodes.UnprocessableEntity, "the question repeats one sequence")
              else {
                val user = userOpt.get
                val idemKey = idemOpt.get
                Asks.get(user, idemKey) match {
                  case Some(stored) => json(StatusCodes.OK, stored)
                  case None =>
                    val admission = Limits.admit(user)
                    if (!admission.ok)
                      respondWithHeader(RawHeader("Retry-After", admission.retryAfter.toString)) {
                        error(StatusCodes.TooManyRequests, "rate limited")
                      }
                    else
                      Documents.get(body.document_id) match {
                        case None => error(StatusCodes.NotFound, "unknown document")
                        case Some(document) =>
                          try {
                            val decision = AnswerGuard.respond(user, body.document_id, document, question)
                            Limits.remember(user, body.document_id, question)
                            Asks.put(user, idemKey, decision)
                            system.log.info(s"ask user=$user doc=\${body.document_id} tokens=\${toks.size}")
                            json(StatusCodes.OK, ujson.write(decision.toJson))
                          } catch {
                            case _: ModelUnavailable => error(StatusCodes.ServiceUnavailable, "model unavailable")
                          }
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

#include "promptguard/documents.h"  // documents::get(id) — provided
#include "promptguard/types.h"      // Admission, Decision, ModelUnavailable — provided

constexpr size_t kMaxQuestionChars = 2000;

// Built in step 2 (limits.cpp): the user's window and the session.
Admission admit(const std::string& user);
void remember(const std::string& user, const std::string& document_id, const std::string& question);
// Built in step 4 (answer_guard.cpp): the decision (model call, guard, event); throws ModelUnavailable.
Decision respond(const std::string& user, const std::string& document_id, const std::string& document, const std::string& question);

void reply_json(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void ask(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reply_json(res, 401, {{"error", "missing X-User-Id"}});
  const auto body = nlohmann::json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("document_id") || !body["document_id"].is_string() || !body.contains("question") || !body["question"].is_string())
    return reply_json(res, 400, {{"error", "invalid json"}});
  const std::string document_id = body["document_id"].get<std::string>();
  const std::string raw_question = body["question"].get<std::string>();
  if (raw_question.size() > kMaxQuestionChars) return reply_json(res, 413, {{"error", "question too long"}});
  const Admission admission = admit(user);
  if (!admission.ok) {
    res.set_header("Retry-After", std::to_string(admission.retry_after));
    return reply_json(res, 429, {{"error", "rate limited"}});
  }
  const auto document = documents::get(document_id);
  if (!document) return reply_json(res, 404, {{"error", "unknown document"}});
  Decision decision;
  try {
    decision = respond(user, document_id, *document, raw_question);
  } catch (const ModelUnavailable&) {
    return reply_json(res, 503, {{"error", "model unavailable"}});
  }
  remember(user, document_id, raw_question);
  std::cerr << "ask user=" << user << " doc=" << document_id << " chars=" << raw_question.size() << "\\n";
  reply_json(res, 200, decision.to_json());
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/ask", ask); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <regex>
#include <string>

#include "promptguard/asks.h"       // asks::get(user, key), asks::put(user, key, decision) — provided
#include "promptguard/documents.h"  // documents::get(id) — provided
#include "promptguard/tokens.h"     // tokens::tokenize, tokens::repeat_ratio — provided
#include "promptguard/types.h"      // Admission, Decision, ModelUnavailable — provided

constexpr size_t kMaxQuestionTokens = 512;
constexpr size_t kMinRepeatTokens = 64;
constexpr double kMaxRepeatRatio = 0.5;
// Raw control characters except tab and newline, and the escape strings \\b and \\r as typed.
const std::regex kControlChars(R"([\\x00-\\x08\\x0b-\\x1f\\x7f]|\\\\[br])");

// Built in step 2 (limits.cpp): the user's window and the session.
Admission admit(const std::string& user);
void remember(const std::string& user, const std::string& document_id, const std::string& question);
// Built in step 4 (answer_guard.cpp): the decision (model call, guard, event); throws ModelUnavailable.
Decision respond(const std::string& user, const std::string& document_id, const std::string& document, const std::string& question);

void reply_json(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string strip_controls(const std::string& text) { return std::regex_replace(text, kControlChars, ""); }

std::string trimmed(const std::string& text) {
  const size_t start = text.find_first_not_of(" \\t\\n");
  if (start == std::string::npos) return "";
  return text.substr(start, text.find_last_not_of(" \\t\\n") - start + 1);
}

void ask(const httplib::Request& req, httplib::Response& res) {
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reply_json(res, 401, {{"error", "missing X-User-Id"}});
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reply_json(res, 400, {{"error", "Idempotency-Key is required"}});
  const auto body = nlohmann::json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("document_id") || !body["document_id"].is_string() || !body.contains("question") || !body["question"].is_string())
    return reply_json(res, 400, {{"error", "invalid json"}});
  const std::string document_id = body["document_id"].get<std::string>();
  const std::string raw_question = body["question"].get<std::string>();
  const std::string question = trimmed(strip_controls(raw_question));
  if (question.empty()) return reply_json(res, 400, {{"error", "the question is empty"}});
  const auto toks = tokens::tokenize(question);
  if (toks.size() > kMaxQuestionTokens) return reply_json(res, 413, {{"error", "the question is over 512 tokens"}});
  if (toks.size() >= kMinRepeatTokens && tokens::repeat_ratio(toks) > kMaxRepeatRatio)
    return reply_json(res, 422, {{"error", "the question repeats one sequence"}});

  if (const auto stored = asks::get(user, idem_key)) return reply_json(res, 200, *stored);
  const Admission admission = admit(user);
  if (!admission.ok) {
    res.set_header("Retry-After", std::to_string(admission.retry_after));
    return reply_json(res, 429, {{"error", "rate limited"}});
  }
  const auto document = documents::get(document_id);
  if (!document) return reply_json(res, 404, {{"error", "unknown document"}});
  Decision decision;
  try {
    decision = respond(user, document_id, *document, question);
  } catch (const ModelUnavailable&) {
    return reply_json(res, 503, {{"error", "model unavailable"}});
  }
  remember(user, document_id, question);
  asks::put(user, idem_key, decision);
  std::cerr << "ask user=" << user << " doc=" << document_id << " tokens=" << toks.size() << "\\n";
  reply_json(res, 200, decision.to_json());
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/ask", ask); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import string
import time

import prompt_defence_pb2
import prompt_defence_pb2_grpc
from promptguard import config, model

DOC_ID = "contract-7"
DOC = "The notice period is thirty days. Either party may end the contract in writing."
FIRST = "The notice period is thirty days."
FIELDS = ("request_id", "document_hash", "answer", "spans", "refused", "signals", "signature")


class ModelServicer(prompt_defence_pb2_grpc.ModelServicer):
    """The stand-in model: answers from promptguard.model."""

    def Complete(self, request, context):
        return prompt_defence_pb2.CompleteReply(text=model.complete(request.prompt))


def _api(ctx):
    ctx.grpc.serve(prompt_defence_pb2_grpc.add_ModelServicer_to_server, ModelServicer(), config.MODEL)
    ctx.redis.set(f"doc:{DOC_ID}", DOC)
    m = ctx.load("ask_api")
    return ctx.client(m.app)


async def _ask(c, question, user="u-ana", key="k-1", doc=DOC_ID, with_key=True):
    headers = {"X-User-Id": user} if user else {}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/ask", json={"document_id": doc, "question": question}, headers=headers)


def _calls(ctx):
    return len(ctx.grpc.calls_to("Complete"))


def _sent(ctx):
    """The question part of the last prompt the model received."""
    return ctx.grpc.calls_to("Complete")[-1].request.prompt.split("DOCUMENT>>>")[-1]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _ask(c, "What is the notice period?")
        assert r.status_code == 200, f"a valid question answered {r.status_code}: {r.text}"
        body = r.json()
        missing = [f for f in FIELDS if f not in body]
        assert not missing, f"the 200 body lacks {missing}: {body}"
        assert body["answer"] == FIRST and body["refused"] is False, f"the decision answers from the document: {body}"
        r = await c.post("/v1/ask", json={"document_id": DOC_ID, "question": "Hi?"}, headers={"Idempotency-Key": "k-2"})
        assert r.status_code == 401, f"without X-User-Id the request must be 401, got {r.status_code}"
        r = await _ask(c, "What is the notice period?", key="k-3", doc="missing-doc")
        assert r.status_code == 404, f"an unknown document must be 404, got {r.status_code}"
        ctx.redis.set(f"limits:u-busy:{int(time.time()) // 60}", 30, ex=60)
        calls = _calls(ctx)
        r = await _ask(c, "What is the notice period?", user="u-busy", key="k-4")
        assert r.status_code == 429, f"a user whose window is full must be 429, got {r.status_code}"
        assert r.headers.get("retry-after", "").isdigit(), f"a 429 carries Retry-After in seconds, got {r.headers.get('retry-after')!r}"
        assert _calls(ctx) == calls, "a refused user must not reach the model"


async def check_control_chars(ctx):
    async with _api(ctx) as c:
        question = "\\x08" * 400 + "\\\\b" * 450 + "What is the notice period?"
        r = await _ask(c, question)
        assert r.status_code == 200, f"a question that is the real question once its controls are stripped must be answered, got {r.status_code}: {r.text[:200]}"
        sent = _sent(ctx)
        assert "\\x08" not in sent and "\\\\b" not in sent, f"the model received {sent.count(chr(8))} backspaces and {sent.count(chr(92) + 'b')} typed \\\\b escapes: strip CONTROL_CHARS before the question is measured or used"
        assert "What is the notice period?" in sent, f"the question itself must reach the model: {sent[:200]!r}"
        calls = _calls(ctx)
        r = await _ask(c, "\\x00\\x07\\\\r\\\\b\\x7f", key="k-2")
        assert r.status_code == 400, f"a question of nothing but control characters must be 400, got {r.status_code}"
        assert _calls(ctx) == calls, "an empty question must not reach the model"


async def check_token_cap(ctx):
    async with _api(ctx) as c:
        wordy = " ".join(f"clause{i:03d}wording" for i in range(190))
        r = await _ask(c, wordy, key="k-wordy")
        assert r.status_code == 200, f"a {len(wordy)}-character question of 190 tokens is under the 512-token cap, got {r.status_code}: the cap counts tokens, not characters"
        dense = "".join(f"{string.ascii_lowercase[i % 26]}{i // 26}." for i in range(300))
        calls = _calls(ctx)
        r = await _ask(c, dense, key="k-dense")
        assert r.status_code == 413, f"a {len(dense)}-character question of 600 tokens must be 413, got {r.status_code}"
        assert _calls(ctx) == calls, "a question over the cap must not reach the model"


async def check_repeat_ratio(ctx):
    async with _api(ctx) as c:
        calls = _calls(ctx)
        for i, question in enumerate(["jq_THREADS " * 100, "/goto maiden " * 40]):
            r = await _ask(c, question, key=f"k-rep-{i}")
            assert r.status_code == 422, f"{question[:24]!r} repeated is a divergence attack and must be 422, got {r.status_code}"
        assert _calls(ctx) == calls, "a repeated-token question must not reach the model"
        r = await _ask(c, "dog " * 40, key="k-short")
        assert r.status_code == 200, f"a 40-token repeat is under MIN_REPEAT_TOKENS = 64 and must be answered, got {r.status_code}"
        r = await _ask(c, " ".join(f"w{i}" for i in range(80)), key="k-varied")
        assert r.status_code == 200, f"a varied 80-token question must be answered, got {r.status_code}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _ask(c, "What is the notice period?", with_key=False)
        assert r.status_code == 400, f"a question without Idempotency-Key must be 400, got {r.status_code}"
        assert _calls(ctx) == 0, "a question without Idempotency-Key must not reach the model"
        first = await _ask(c, "What is the notice period?", key="k-7")
        replay = await _ask(c, "What is the notice period?", key="k-7")
        assert first.status_code == 200 and replay.status_code == 200, f"the question and its replay answered {first.status_code} and {replay.status_code}"
        assert replay.json().get("request_id") == first.json().get("request_id"), "a replay of the same (user, Idempotency-Key) must return the stored decision"
        assert _calls(ctx) == 1, f"a client retry cost {_calls(ctx)} model calls: look up (user, key) before asking the model"
        other = await _ask(c, "What is the notice period?", user="u-ben", key="k-7")
        assert other.status_code == 200 and other.json().get("request_id") != first.json().get("request_id"), "another user with the same key gets an answer of their own"
`,
    typescript: `const DOC_ID = 'contract-7';
const DOC = 'The notice period is thirty days. Either party may end the contract in writing.';
const FIRST = 'The notice period is thirty days.';
const FIELDS = ['request_id', 'document_hash', 'answer', 'spans', 'refused', 'signals', 'signature'];

/** The stand-in model at MODEL, the document in the store, the learner's app. */
function api(ctx) {
  const {promptdefence} = ctx.proto('prompt_defence.proto');
  const config = ctx.load('/support/promptguard/config.ts');
  const model = ctx.load('/support/promptguard/model.ts');
  ctx.grpc.serve(
    promptdefence.Model.service,
    {
      Complete(call, callback) {
        callback(null, {text: model.complete(call.request.prompt)});
      },
    },
    config.MODEL,
  );
  ctx.redis.set(\`doc:\${DOC_ID}\`, DOC);
  return ctx.client(ctx.load('ask_api').app);
}

async function ask(c, question: string, {user = 'u-ana', key = 'k-1', doc = DOC_ID, withKey = true} = {}) {
  const headers: Record<string, string> = {};
  if (user !== '') headers['X-User-Id'] = user;
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/ask', {json: {document_id: doc, question}, headers});
}

const calls = ctx => ctx.grpc.callsTo('Complete').length;
/** The question part of the last prompt the model received. */
const sent = ctx => ctx.grpc.callsTo('Complete').at(-1).request.prompt.split('DOCUMENT>>>').at(-1);

export async function check_route(ctx) {
  const c = api(ctx);
  let r = await ask(c, 'What is the notice period?');
  assert.equal(r.status, 200, \`a valid question answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const missing = FIELDS.filter(f => !(f in body));
  assert.equal(missing.length, 0, \`the 200 body lacks \${JSON.stringify(missing)}: \${r.text}\`);
  assert(body.answer === FIRST && body.refused === false, \`the decision answers from the document: \${r.text}\`);
  r = await c.post('/v1/ask', {json: {document_id: DOC_ID, question: 'Hi?'}, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(r.status, 401, \`without X-User-Id the request must be 401, got \${r.status}\`);
  r = await ask(c, 'What is the notice period?', {key: 'k-3', doc: 'missing-doc'});
  assert.equal(r.status, 404, \`an unknown document must be 404, got \${r.status}\`);
  ctx.redis.set(\`limits:u-busy:\${Math.floor(Date.now() / 1000 / 60)}\`, 30, 'EX', 60);
  const before = calls(ctx);
  r = await ask(c, 'What is the notice period?', {user: 'u-busy', key: 'k-4'});
  assert.equal(r.status, 429, \`a user whose window is full must be 429, got \${r.status}\`);
  assert(/^\\d+$/.test(r.headers['retry-after'] ?? ''), \`a 429 carries Retry-After in seconds, got \${JSON.stringify(r.headers['retry-after'])}\`);
  assert.equal(calls(ctx), before, 'a refused user must not reach the model');
}

export async function check_control_chars(ctx) {
  const c = api(ctx);
  const question = '\\x08'.repeat(400) + '\\\\b'.repeat(450) + 'What is the notice period?';
  let r = await ask(c, question);
  assert.equal(r.status, 200, \`a question that is the real question once its controls are stripped must be answered, got \${r.status}: \${r.text.slice(0, 200)}\`);
  const prompt: string = sent(ctx);
  assert(!prompt.includes('\\x08') && !prompt.includes('\\\\b'), \`the model received \${prompt.split('\\x08').length - 1} backspaces and \${prompt.split('\\\\b').length - 1} typed \\\\b escapes: strip CONTROL_CHARS before the question is measured or used\`);
  assert(prompt.includes('What is the notice period?'), \`the question itself must reach the model: \${JSON.stringify(prompt.slice(0, 200))}\`);
  const before = calls(ctx);
  r = await ask(c, '\\x00\\x07\\\\r\\\\b\\x7f', {key: 'k-2'});
  assert.equal(r.status, 400, \`a question of nothing but control characters must be 400, got \${r.status}\`);
  assert.equal(calls(ctx), before, 'an empty question must not reach the model');
}

export async function check_token_cap(ctx) {
  const c = api(ctx);
  const wordy = Array.from({length: 190}, (_, i) => \`clause\${String(i).padStart(3, '0')}wording\`).join(' ');
  let r = await ask(c, wordy, {key: 'k-wordy'});
  assert.equal(r.status, 200, \`a \${wordy.length}-character question of 190 tokens is under the 512-token cap, got \${r.status}: the cap counts tokens, not characters\`);
  const dense = Array.from({length: 300}, (_, i) => \`\${'abcdefghijklmnopqrstuvwxyz'[i % 26]}\${Math.floor(i / 26)}.\`).join('');
  const before = calls(ctx);
  r = await ask(c, dense, {key: 'k-dense'});
  assert.equal(r.status, 413, \`a \${dense.length}-character question of 600 tokens must be 413, got \${r.status}\`);
  assert.equal(calls(ctx), before, 'a question over the cap must not reach the model');
}

export async function check_repeat_ratio(ctx) {
  const c = api(ctx);
  const before = calls(ctx);
  for (const [i, question] of ['jq_THREADS '.repeat(100), '/goto maiden '.repeat(40)].entries()) {
    const r = await ask(c, question, {key: \`k-rep-\${i}\`});
    assert.equal(r.status, 422, \`\${JSON.stringify(question.slice(0, 24))} repeated is a divergence attack and must be 422, got \${r.status}\`);
  }
  assert.equal(calls(ctx), before, 'a repeated-token question must not reach the model');
  let r = await ask(c, 'dog '.repeat(40), {key: 'k-short'});
  assert.equal(r.status, 200, \`a 40-token repeat is under MIN_REPEAT_TOKENS = 64 and must be answered, got \${r.status}\`);
  r = await ask(c, Array.from({length: 80}, (_, i) => \`w\${i}\`).join(' '), {key: 'k-varied'});
  assert.equal(r.status, 200, \`a varied 80-token question must be answered, got \${r.status}\`);
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const r = await ask(c, 'What is the notice period?', {withKey: false});
  assert.equal(r.status, 400, \`a question without Idempotency-Key must be 400, got \${r.status}\`);
  assert.equal(calls(ctx), 0, 'a question without Idempotency-Key must not reach the model');
  const first = await ask(c, 'What is the notice period?', {key: 'k-7'});
  const replay = await ask(c, 'What is the notice period?', {key: 'k-7'});
  assert(first.status === 200 && replay.status === 200, \`the question and its replay answered \${first.status} and \${replay.status}\`);
  assert.equal(replay.json().request_id, first.json().request_id, 'a replay of the same (user, Idempotency-Key) must return the stored decision');
  assert.equal(calls(ctx), 1, \`a client retry cost \${calls(ctx)} model calls: look up (user, key) before asking the model\`);
  const other = await ask(c, 'What is the notice period?', {user: 'u-ben', key: 'k-7'});
  assert(other.status === 200 && other.json().request_id !== first.json().request_id, 'another user with the same key gets an answer of their own');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"

	"promptguard/model"
	"promptguard/types"

	"leetbuild/harness"
)

const (
	askDocID = "contract-7"
	askDoc   = "The notice period is thirty days. Either party may end the contract in writing."
	askFirst = "The notice period is thirty days."
)

// askQuestions are the questions respond received, in order.
var askQuestions []string

// askClient serves the learner's route over stand-ins for steps 2 and 4: every user but u-busy is
// admitted, sessions are kept nowhere, and respond answers the document's first sentence.
func askClient(ctx *harness.Ctx) *harness.HTTP {
	askQuestions = nil
	ctx.Redis.Set("doc:"+askDocID, askDoc)
	admit = func(_ context.Context, user string) (types.Admission, error) {
		if user == "u-busy" {
			return types.Admission{OK: false, RetryAfter: 17}, nil
		}
		return types.Admission{OK: true, Remaining: 29}, nil
	}
	remember = func(context.Context, string, string, string) error { return nil }
	respond = func(_ context.Context, _, _, document, question string) (types.Decision, error) {
		askQuestions = append(askQuestions, question)
		sum := sha256.Sum256([]byte(document))
		first := model.FirstSentence(document)
		return types.Decision{RequestID: fmt.Sprintf("r-%d", len(askQuestions)), DocumentHash: hex.EncodeToString(sum[:]), Answer: first, Spans: []string{first}, Signals: []string{}}, nil
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func askPost(c *harness.HTTP, question, user, key, doc string) *harness.Response {
	body := map[string]any{"document_id": doc, "question": question}
	headers := []string{}
	if user != "" {
		headers = append(headers, "X-User-Id", user)
	}
	if key != "" {
		headers = append(headers, "Idempotency-Key", key)
	}
	return c.Post("/v1/ask", body, headers...)
}

func askField(ctx *harness.Ctx, r *harness.Response, field string) any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body[field]
}

func CheckRoute(ctx *harness.Ctx) {
	c := askClient(ctx)
	r := askPost(c, "What is the notice period?", "u-ana", "k-1", askDocID)
	ctx.Equal(r.Status, 200, "a valid question (%s)", r.Text())
	for _, f := range []string{"request_id", "document_hash", "answer", "spans", "refused", "signals", "signature"} {
		body, _ := r.JSON().(map[string]any)
		_, ok := body[f]
		ctx.Assert(ok, "the 200 body lacks %s: %s", f, r.Text())
	}
	ctx.Assert(askField(ctx, r, "answer") == askFirst && askField(ctx, r, "refused") == false, "the decision answers from the document: %s", r.Text())
	ctx.Equal(askPost(c, "Hi?", "", "k-2", askDocID).Status, 401, "without X-User-Id")
	ctx.Equal(askPost(c, "What is the notice period?", "u-ana", "k-3", "missing-doc").Status, 404, "an unknown document")
	before := len(askQuestions)
	r = askPost(c, "What is the notice period?", "u-busy", "k-4", askDocID)
	ctx.Equal(r.Status, 429, "a user whose window is full")
	ctx.Equal(r.Header.Get("Retry-After"), "17", "a 429 carries the admission's Retry-After")
	ctx.Equal(len(askQuestions), before, "a refused user must not reach respond; calls")
}

func CheckControlChars(ctx *harness.Ctx) {
	c := askClient(ctx)
	question := strings.Repeat("\\x08", 400) + strings.Repeat("\\\\b", 450) + "What is the notice period?"
	r := askPost(c, question, "u-ana", "k-1", askDocID)
	ctx.Equal(r.Status, 200, "a question that is the real question once its controls are stripped")
	ctx.Assert(len(askQuestions) == 1, "the question must reach respond once")
	got := askQuestions[0]
	ctx.Assert(!strings.Contains(got, "\\x08") && !strings.Contains(got, "\\\\b"), "respond received %d backspaces and %d typed \\\\b escapes: strip controlChars before the question is measured or used", strings.Count(got, "\\x08"), strings.Count(got, "\\\\b"))
	ctx.Equal(got, "What is the notice period?", "the question respond receives")
	r = askPost(c, "\\x00\\x07\\\\r\\\\b\\x7f", "u-ana", "k-2", askDocID)
	ctx.Equal(r.Status, 400, "a question of nothing but control characters")
	ctx.Equal(len(askQuestions), 1, "an empty question must not reach respond; calls")
}

func CheckTokenCap(ctx *harness.Ctx) {
	c := askClient(ctx)
	words := make([]string, 190)
	for i := range words {
		words[i] = fmt.Sprintf("clause%03dwording", i)
	}
	wordy := strings.Join(words, " ")
	ctx.Equal(askPost(c, wordy, "u-ana", "k-wordy", askDocID).Status, 200, "a %d-character question of 190 tokens is under the 512-token cap: the cap counts tokens, not characters", len(wordy))
	var dense strings.Builder
	for i := 0; i < 300; i++ {
		fmt.Fprintf(&dense, "%c%d.", 'a'+rune(i%26), i/26)
	}
	before := len(askQuestions)
	ctx.Equal(askPost(c, dense.String(), "u-ana", "k-dense", askDocID).Status, 413, "a %d-character question of 600 tokens", dense.Len())
	ctx.Equal(len(askQuestions), before, "a question over the cap must not reach respond; calls")
}

func CheckRepeatRatio(ctx *harness.Ctx) {
	c := askClient(ctx)
	for i, question := range []string{strings.Repeat("jq_THREADS ", 100), strings.Repeat("/goto maiden ", 40)} {
		ctx.Equal(askPost(c, question, "u-ana", fmt.Sprintf("k-rep-%d", i), askDocID).Status, 422, "%q repeated is a divergence attack", question[:12])
	}
	ctx.Equal(len(askQuestions), 0, "a repeated-token question must not reach respond; calls")
	ctx.Equal(askPost(c, strings.Repeat("dog ", 40), "u-ana", "k-short", askDocID).Status, 200, "a 40-token repeat is under minRepeatTokens = 64")
	varied := make([]string, 80)
	for i := range varied {
		varied[i] = fmt.Sprintf("w%d", i)
	}
	ctx.Equal(askPost(c, strings.Join(varied, " "), "u-ana", "k-varied", askDocID).Status, 200, "a varied 80-token question")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := askClient(ctx)
	ctx.Equal(askPost(c, "What is the notice period?", "u-ana", "", askDocID).Status, 400, "a question without Idempotency-Key")
	ctx.Equal(len(askQuestions), 0, "a question without Idempotency-Key must not reach respond; calls")
	first := askPost(c, "What is the notice period?", "u-ana", "k-7", askDocID)
	replay := askPost(c, "What is the notice period?", "u-ana", "k-7", askDocID)
	ctx.Assert(first.Status == 200 && replay.Status == 200, "the question and its replay answered %d and %d", first.Status, replay.Status)
	ctx.Equal(askField(ctx, replay, "request_id"), askField(ctx, first, "request_id"), "a replay of the same (user, Idempotency-Key) must return the stored decision; request_id")
	ctx.Equal(len(askQuestions), 1, "a client retry must not cost a second model call: look up (user, key) first; respond calls")
	other := askPost(c, "What is the notice period?", "u-ben", "k-7", askDocID)
	ctx.Assert(other.Status == 200 && askField(ctx, other, "request_id") != askField(ctx, first, "request_id"), "another user with the same key gets an answer of their own")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdio>
#include <string>
#include <vector>

#include "digest.h"
#include "promptguard/model.h"
#include "promptguard/types.h"

namespace {

const std::string kDocId = "contract-7";
const std::string kDoc = "The notice period is thirty days. Either party may end the contract in writing.";
const std::string kFirst = "The notice period is thirty days.";

// The questions respond received, in order.
std::vector<std::string> gQuestions;

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    gQuestions.clear();
    ctx.Redis.Set("doc:" + kDocId, kDoc);
    register_routes(svr);
  }

  harness::Response post(const std::string& question, const std::string& user = "u-ana", const std::string& key = "k-1", const std::string& doc = kDocId) {
    const std::string body = nlohmann::json{{"document_id", doc}, {"question", question}}.dump();
    if (user.empty()) return http.Post("/v1/ask", body, "Idempotency-Key", key);
    if (key.empty()) return http.Post("/v1/ask", body, "X-User-Id", user);
    return http.Post("/v1/ask", body, "X-User-Id", user, "Idempotency-Key", key);
  }
};

nlohmann::json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

std::string repeated(const std::string& text, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += text;
  return out;
}

size_t occurrences(const std::string& text, const std::string& needle) {
  size_t n = 0;
  for (size_t at = text.find(needle); at != std::string::npos; at = text.find(needle, at + needle.size())) n++;
  return n;
}

}  // namespace

// Stand-ins for steps 2 and 4: every user but u-busy is admitted, sessions are kept nowhere, and
// respond answers the document's first sentence.
Admission admit(const std::string& user) { return user == "u-busy" ? Admission{false, 0, 17} : Admission{true, 29, 0}; }

void remember(const std::string&, const std::string&, const std::string&) {}

Decision respond(const std::string&, const std::string&, const std::string& document, const std::string& question) {
  gQuestions.push_back(question);
  const std::string first = model::first_sentence(document);
  return {"r-" + std::to_string(gQuestions.size()), sha256_hex(document), first, {first}, false, {}, ""};
}

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post("What is the notice period?");
  ctx.Equal(r.Status, 200, "a valid question (%s)", r.Text());
  const auto body = bodyOf(ctx, r);
  for (const char* f : {"request_id", "document_hash", "answer", "spans", "refused", "signals", "signature"}) ctx.Assert(body.contains(f), "the 200 body lacks %s: %s", f, r.Text());
  ctx.Assert(body["answer"] == kFirst && body["refused"] == false, "the decision answers from the document: %s", r.Text());
  ctx.Equal(api.post("Hi?", "", "k-2").Status, 401, "without X-User-Id");
  ctx.Equal(api.post("What is the notice period?", "u-ana", "k-3", "missing-doc").Status, 404, "an unknown document");
  const size_t before = gQuestions.size();
  r = api.post("What is the notice period?", "u-busy", "k-4");
  ctx.Equal(r.Status, 429, "a user whose window is full");
  ctx.Equal(r.HeaderValue("Retry-After"), "17", "a 429 carries the admission's Retry-After");
  ctx.Equal(gQuestions.size(), before, "a refused user must not reach respond; calls");
}

void CheckControlChars(harness::Ctx& ctx) {
  Api api(ctx);
  const std::string question = repeated("\\x08", 400) + repeated("\\\\b", 450) + "What is the notice period?";
  ctx.Equal(api.post(question).Status, 200, "a question that is the real question once its controls are stripped");
  ctx.Equal(gQuestions.size(), 1, "the question must reach respond once; calls");
  const std::string got = gQuestions[0];
  ctx.Assert(got.find('\\x08') == std::string::npos && got.find("\\\\b") == std::string::npos, "respond received %d backspaces and %d typed \\\\b escapes: strip kControlChars before the question is measured or used", occurrences(got, "\\x08"), occurrences(got, "\\\\b"));
  ctx.Equal(got, "What is the notice period?", "the question respond receives");
  ctx.Equal(api.post(std::string("\\x00\\x07\\\\r\\\\b\\x7f", 7), "u-ana", "k-2").Status, 400, "a question of nothing but control characters");
  ctx.Equal(gQuestions.size(), 1, "an empty question must not reach respond; calls");
}

void CheckTokenCap(harness::Ctx& ctx) {
  Api api(ctx);
  std::string wordy;
  for (int i = 0; i < 190; i++) {
    char word[32];
    std::snprintf(word, sizeof word, "%sclause%03dwording", i == 0 ? "" : " ", i);
    wordy += word;
  }
  ctx.Equal(api.post(wordy, "u-ana", "k-wordy").Status, 200, "a %d-character question of 190 tokens is under the 512-token cap: the cap counts tokens, not characters", wordy.size());
  std::string dense;
  for (int i = 0; i < 300; i++) dense += std::string(1, static_cast<char>('a' + i % 26)) + std::to_string(i / 26) + ".";
  const size_t before = gQuestions.size();
  ctx.Equal(api.post(dense, "u-ana", "k-dense").Status, 413, "a %d-character question of 600 tokens", dense.size());
  ctx.Equal(gQuestions.size(), before, "a question over the cap must not reach respond; calls");
}

void CheckRepeatRatio(harness::Ctx& ctx) {
  Api api(ctx);
  ctx.Equal(api.post(repeated("jq_THREADS ", 100), "u-ana", "k-rep-0").Status, 422, "jq_THREADS repeated is a divergence attack");
  ctx.Equal(api.post(repeated("/goto maiden ", 40), "u-ana", "k-rep-1").Status, 422, "/goto maiden repeated is a divergence attack");
  ctx.Equal(gQuestions.size(), 0, "a repeated-token question must not reach respond; calls");
  ctx.Equal(api.post(repeated("dog ", 40), "u-ana", "k-short").Status, 200, "a 40-token repeat is under kMinRepeatTokens = 64");
  std::string varied;
  for (int i = 0; i < 80; i++) varied += (i == 0 ? "w" : " w") + std::to_string(i);
  ctx.Equal(api.post(varied, "u-ana", "k-varied").Status, 200, "a varied 80-token question");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  ctx.Equal(api.post("What is the notice period?", "u-ana", "").Status, 400, "a question without Idempotency-Key");
  ctx.Equal(gQuestions.size(), 0, "a question without Idempotency-Key must not reach respond; calls");
  const auto first = api.post("What is the notice period?", "u-ana", "k-7");
  const auto replay = api.post("What is the notice period?", "u-ana", "k-7");
  ctx.Assert(first.Status == 200 && replay.Status == 200, "the question and its replay answered %d and %d", first.Status, replay.Status);
  ctx.Equal(bodyOf(ctx, replay)["request_id"], bodyOf(ctx, first)["request_id"], "a replay of the same (user, Idempotency-Key) must return the stored decision; request_id");
  ctx.Equal(gQuestions.size(), 1, "a client retry must not cost a second model call: look up (user, key) first; respond calls");
  const auto other = api.post("What is the notice period?", "u-ben", "k-7");
  ctx.Assert(other.Status == 200 && bodyOf(ctx, other)["request_id"] != bodyOf(ctx, first)["request_id"], "another user with the same key gets an answer of their own");
}
`,
  },
  debrief: `The guards run in cost order: identity and key first, then normalisation, then measurement, then the lookups that touch Redis, and only then the model. Normalisation precedes measurement because a cap on the raw text would count characters that are about to vanish, and the cap is in tokens because that is the unit the model and the attack both count in: the source's backspaces were cheap in characters and expensive in tokens. The repeat ratio looks at one to three token windows since a phrase, not only a single token, drives divergence, and it waits for 64 tokens so a short "yes yes yes" is still a question. Keying idempotency by \`(user, key)\` makes a retry cost a Redis read. Production services keep one tokenizer per model and an allow-list of control characters for workloads, such as code questions, where a tab or an escape sequence is content.`,
};
