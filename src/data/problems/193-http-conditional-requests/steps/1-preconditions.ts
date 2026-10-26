import type {Step} from '@/lib/types';

export const preconditionsStep: Step = {
  id: 'preconditions',
  title: 'GET, PUT and DELETE /docs/{id}: preconditions in RFC 9110 order',
  concept: 'http',
  file: 'docs_api',
  focus: ['client', 'service'],
  task: `## Task

Serve \`GET\`, \`PUT\` and \`DELETE\` on \`/docs/{id}\`. The PUT body is JSON \`{"text": "…"}\`; the module-level store
\`DOCS\` (TypeScript: \`docs\`) maps an id to \`{text, etag, modified}\` with \`modified\` in epoch seconds. The store,
the validators, the date parser and the plain routes are provided; you write \`preconditions\` and the 428.

- **Validators.** \`ETag\` is strong: the first **16** hex digits of \`sha256(text)\`, in double quotes.
  \`Last-Modified\` is the IMF-fixdate of \`modified\` (virtual clock at write time, whole seconds), e.g.
  \`Thu, 22 Oct 2026 10:00:00 GMT\`. A 200 or 201 carries both.
- **404 first:** GET and DELETE on a missing doc answer **404** \`{"error": "not_found"}\` before any precondition.
- **Comparison.** Header values are comma-separated tag lists. Strong: neither tag starts with \`W/\` and the
  strings are equal. Weak: equal after dropping \`W/\` from both. \`*\` matches an existing doc and never a missing
  one. A date that does not parse is ignored, as if the header were absent.

Then RFC 9110 §13.2.2, in this order (412 answers \`{"error": "precondition_failed"}\`):

1. \`If-Match\` present: no listed tag matches with **strong** comparison → **412**.
2. Else \`If-Unmodified-Since\` with a valid date: \`modified\` later than the date → **412**.
3. \`If-None-Match\` present: a listed tag matches with **weak** comparison → GET answers **304** (\`ETag\` and
   \`Last-Modified\`, no body), PUT and DELETE answer **412**.
4. Else, GET only, \`If-Modified-Since\` with a valid date: \`modified\` at or before the date → **304**.

After the table:

- **No blind writes:** PUT or DELETE on an existing doc without \`If-Match\` answers **428**
  \`{"error": "precondition_required"}\` (RFC 6585 §3) and changes nothing. A PUT on a missing doc needs no
  precondition.
- **Writes.** PUT stores \`{text, etag, modified}\` and answers **201** (created) or **200** (replaced) with
  \`{"text": …}\` and the new \`ETag\` and \`Last-Modified\`. \`If-None-Match: *\` makes a PUT create-only. DELETE
  answers **204**.

> A validator is a version number the client hands back. \`If-Match\` turns "replace the doc" into "replace the doc
> I read", which is the whole defence against the lost update.`,
  sequence: {
    participants: ['Alice', 'docs', 'Bob'],
    messages: [
      {from: 'Alice', to: 'docs', label: 'GET /docs/plan', kind: 'sync'},
      {from: 'docs', to: 'Alice', label: '200 · ETag "e1"', kind: 'reply'},
      {from: 'Bob', to: 'docs', label: 'GET /docs/plan', kind: 'sync'},
      {from: 'docs', to: 'Bob', label: '200 · ETag "e1"', kind: 'reply'},
      {from: 'Alice', to: 'docs', label: 'PUT · If-Match: "e1"', kind: 'sync'},
      {from: 'docs', to: 'Alice', label: '200 · ETag "e2"', kind: 'reply'},
      {from: 'Bob', to: 'docs', label: 'PUT · If-Match: "e1"', kind: 'sync'},
      {from: 'docs', to: 'Bob', label: '412 Precondition Failed', kind: 'reply'},
      {from: 'Bob', to: 'docs', label: 'retry · If-Match: "e2"', kind: 'sync'},
      {from: 'docs', to: 'Bob', label: '200 · ETag "e3"', kind: 'reply'},
    ],
  },
  hints: [
    'Write two helpers first: one that splits a header into tags (`split(",")`, trim) and two comparisons. Strong: `t == "*"` or (`t` does not start with `W/` and `t == etag`). Weak: `t == "*"` or the tags are equal with `W/` removed. `*` only ever reaches them for an existing doc.',
    'The order is the whole mechanism: `If-Match`, else `If-Unmodified-Since`; then `If-None-Match`, else `If-Modified-Since` (GET only). A header that is present wins over its date sibling even when it passes, so test presence, not outcome. Return 304, 412 or nothing.',
    'After the preconditions pass, a PUT or DELETE on an existing doc still needs `If-Match` (428), so `If-Unmodified-Since` or `If-None-Match` alone never authorises an overwrite. `If-None-Match: *` on a PUT needs no special case: step 3 already answers 412 when the doc exists.',
  ],
  checks: [
    {
      id: 'not-modified',
      title: 'A revalidating GET answers 304 with ETag, Last-Modified and no body',
      detail:
        '`If-None-Match` with the current tag, or `If-Modified-Since` at or after `Last-Modified`, answers `304` repeating both validators and sending no body; a stale tag or an older date gets the `200`.',
      match: {
        python: {all: [/["']if-none-match["']/i, /["']if-modified-since["']/i, /\b304\b/]},
        typescript: {all: [/['"]if-none-match['"]/i, /['"]if-modified-since['"]/i, /\b304\b/]},
        go: {all: [/"If-None-Match"/, /"If-Modified-Since"/, /http\.StatusNotModified|\b304\b/]},
        scala: {all: [/"If-None-Match"/, /"If-Modified-Since"/, /StatusCodes\.NotModified|\b304\b/]},
        cpp: {all: [/"If-None-Match"/, /"If-Modified-Since"/, /\b304\b/]},
      },
    },
    {
      id: 'precedence',
      title: 'If-None-Match outranks If-Modified-Since; If-Match outranks If-Unmodified-Since',
      detail:
        'Evaluate in RFC 9110 §13.2.2 order: `If-Match`, else `If-Unmodified-Since`, then `If-None-Match`, else `If-Modified-Since`. A present tag header makes its date sibling irrelevant, and a failed `If-Match` answers 412 before `If-None-Match` could answer 304.',
      match: {
        python: {
          order: [
            /["']if-match["']/i,
            /["']if-unmodified-since["']/i,
            /["']if-none-match["']/i,
            /["']if-modified-since["']/i,
          ],
        },
        typescript: {
          order: [
            /['"]if-match['"]/i,
            /['"]if-unmodified-since['"]/i,
            /['"]if-none-match['"]/i,
            /['"]if-modified-since['"]/i,
          ],
        },
        go: {
          order: [/"If-Match"/, /"If-Unmodified-Since"/, /"If-None-Match"/, /"If-Modified-Since"/],
          none: [/http\.ServeContent\(/],
        },
        scala: {
          order: [/"If-Match"/, /"If-Unmodified-Since"/, /"If-None-Match"/, /"If-Modified-Since"/],
          none: [/\bconditional\s*\(/],
        },
        cpp: {order: [/"If-Match"/, /"If-Unmodified-Since"/, /"If-None-Match"/, /"If-Modified-Since"/]},
      },
    },
    {
      id: 'lost-update',
      title: 'The second writer with the same ETag gets 412',
      detail:
        'Two writers read ETag `"e1"`; the first `PUT` with `If-Match: "e1"` answers 200 with a new ETag and `Last-Modified`, the second answers `412` and the doc keeps the first write. A `DELETE` with a stale tag is refused the same way.',
      match: {
        python: {all: [/["']if-match["']/i, /\b412\b/]},
        typescript: {all: [/['"]if-match['"]/i, /\b412\b/]},
        go: {all: [/"If-Match"/, /http\.StatusPreconditionFailed|\b412\b/]},
        scala: {all: [/"If-Match"/, /StatusCodes\.PreconditionFailed|\b412\b/]},
        cpp: {all: [/"If-Match"/, /\b412\b/]},
      },
    },
    {
      id: 'precondition-required',
      title: 'PUT or DELETE on an existing doc without If-Match answers 428',
      detail:
        'A write to a doc that exists must name the version it replaces: without `If-Match` answer `428 Precondition Required` (RFC 6585), even when `If-Unmodified-Since` or a non-matching `If-None-Match` is present. A PUT on a missing doc still creates (201).',
      match: {
        python: {all: [/\b428\b/, /["']if-match["']/i]},
        typescript: {all: [/\b428\b/, /['"]if-match['"]/i]},
        go: {all: [/http\.StatusPreconditionRequired|\b428\b/, /"If-Match"/]},
        scala: {all: [/StatusCodes\.PreconditionRequired|\b428\b/, /"If-Match"/]},
        cpp: {all: [/\b428\b/, /"If-Match"/]},
      },
    },
    {
      id: 'create-only',
      title: 'PUT with If-None-Match: * creates only when the doc is absent',
      detail:
        'The first `PUT` with `If-None-Match: *` answers `201` with the validators; a second one answers `412` and the text stays. `If-Match: *` is the opposite: 412 on a missing doc, 200 on an existing one.',
      match: {
        python: {all: [/==\s*["']\*["']/, /["']if-none-match["']/i, /\b201\b/]},
        typescript: {all: [/===\s*['"]\*['"]/, /['"]if-none-match['"]/i, /\b201\b/]},
        go: {all: [/==\s*"\*"/, /"If-None-Match"/, /http\.StatusCreated|\b201\b/]},
        scala: {all: [/==\s*"\*"/, /"If-None-Match"/, /StatusCodes\.Created|\b201\b/]},
        cpp: {all: [/==\s*"\*"/, /"If-None-Match"/, /\b201\b/]},
      },
    },
    {
      id: 'weak-strong',
      title: 'W/ tags never match If-Match but match If-None-Match; bad dates are ignored',
      detail:
        '`If-Match: W/"…"` answers 412 even for the current tag (strong comparison); `If-None-Match: W/"…"` matches it (weak comparison). Tag lists are searched. An unparseable `If-Modified-Since` or `If-Unmodified-Since` is ignored.',
      match: {
        python: {all: [/["']W\/["']/, /except\b/]},
        typescript: {all: [/['"]W\/['"]/, /isNaN\(/]},
        go: {all: [/"W\/"/, /http\.ParseTime\(/]},
        scala: {all: [/"W\/"/, /\bTry\(/]},
        cpp: {all: [/"W\/"/, /\.fail\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import time
from email.utils import formatdate, parsedate_to_datetime

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

app = FastAPI()

ETAG_HEX = 16
DOCS: dict[str, dict] = {}  # id -> {"text": str, "etag": '"<16 hex>"', "modified": epoch seconds}


def etag_of(text: str) -> str:
    return '"' + hashlib.sha256(text.encode()).hexdigest()[:ETAG_HEX] + '"'


def validators(doc: dict) -> dict[str, str]:
    return {"ETag": doc["etag"], "Last-Modified": formatdate(doc["modified"], usegmt=True)}


def http_date(value: str | None) -> int | None:
    """Epoch seconds of an HTTP date, or None when absent or unparseable."""
    if value is None:
        return None
    try:
        return int(parsedate_to_datetime(value).timestamp())
    except (TypeError, ValueError, IndexError):
        return None


def preconditions(request: Request, doc: dict | None) -> int | None:
    """RFC 9110 §13.2.2: None to perform the method, or the status that ends it (304 or 412)."""
    # TODO: 1. If-Match (strong; * = exists) fails -> 412   2. else If-Unmodified-Since earlier than modified -> 412
    # TODO: 3. If-None-Match (weak; * = exists) matches -> 304 on GET, 412 otherwise
    # TODO: 4. else, GET only, If-Modified-Since at or after modified -> 304
    return None


def stop(status: int, doc: dict | None) -> Response:
    if status == 304:
        return Response(status_code=304, headers=validators(doc))
    return JSONResponse({"error": "precondition_failed"}, status_code=412)


@app.get("/docs/{doc_id}")
async def get_doc(doc_id: str, request: Request) -> Response:
    doc = DOCS.get(doc_id)
    if doc is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    status = preconditions(request, doc)
    if status is not None:
        return stop(status, doc)
    return JSONResponse({"text": doc["text"]}, headers=validators(doc))


@app.put("/docs/{doc_id}")
async def put_doc(doc_id: str, request: Request) -> Response:
    current = DOCS.get(doc_id)
    status = preconditions(request, current)
    if status is not None:
        return stop(status, current)
    # TODO: an existing doc without If-Match -> 428 precondition_required
    try:
        text = (await request.json()).get("text")
    except (ValueError, AttributeError):
        text = None
    if not isinstance(text, str):
        return JSONResponse({"error": "text_required"}, status_code=400)
    doc = {"text": text, "etag": etag_of(text), "modified": int(time.time())}
    DOCS[doc_id] = doc
    return JSONResponse({"text": text}, status_code=201 if current is None else 200, headers=validators(doc))


@app.delete("/docs/{doc_id}")
async def delete_doc(doc_id: str, request: Request) -> Response:
    current = DOCS.get(doc_id)
    if current is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    status = preconditions(request, current)
    if status is not None:
        return stop(status, current)
    # TODO: without If-Match -> 428 precondition_required
    del DOCS[doc_id]
    return Response(status_code=204)
`,
      solution: `import hashlib
import time
from email.utils import formatdate, parsedate_to_datetime

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

app = FastAPI()

ETAG_HEX = 16
DOCS: dict[str, dict] = {}  # id -> {"text": str, "etag": '"<16 hex>"', "modified": epoch seconds}


def etag_of(text: str) -> str:
    return '"' + hashlib.sha256(text.encode()).hexdigest()[:ETAG_HEX] + '"'


def validators(doc: dict) -> dict[str, str]:
    return {"ETag": doc["etag"], "Last-Modified": formatdate(doc["modified"], usegmt=True)}


def http_date(value: str | None) -> int | None:
    """Epoch seconds of an HTTP date, or None when absent or unparseable."""
    if value is None:
        return None
    try:
        return int(parsedate_to_datetime(value).timestamp())
    except (TypeError, ValueError, IndexError):
        return None


def tags(header: str) -> list[str]:
    return [t.strip() for t in header.split(",") if t.strip()]


def strong_match(header: str, etag: str) -> bool:
    return any(t == "*" or (not t.startswith("W/") and t == etag) for t in tags(header))


def weak_match(header: str, etag: str) -> bool:
    return any(t == "*" or t.removeprefix("W/") == etag.removeprefix("W/") for t in tags(header))


def preconditions(request: Request, doc: dict | None) -> int | None:
    """RFC 9110 §13.2.2: None to perform the method, or the status that ends it (304 or 412)."""
    h = request.headers
    if "if-match" in h:
        if doc is None or not strong_match(h["if-match"], doc["etag"]):
            return 412
    elif doc is not None:
        since = http_date(h.get("if-unmodified-since"))
        if since is not None and doc["modified"] > since:
            return 412
    if "if-none-match" in h:
        if doc is not None and weak_match(h["if-none-match"], doc["etag"]):
            return 304 if request.method == "GET" else 412
    elif request.method == "GET" and doc is not None:
        since = http_date(h.get("if-modified-since"))
        if since is not None and doc["modified"] <= since:
            return 304
    return None


def stop(status: int, doc: dict | None) -> Response:
    if status == 304:
        return Response(status_code=304, headers=validators(doc))
    return JSONResponse({"error": "precondition_failed"}, status_code=412)


def required() -> Response:
    return JSONResponse({"error": "precondition_required"}, status_code=428)


@app.get("/docs/{doc_id}")
async def get_doc(doc_id: str, request: Request) -> Response:
    doc = DOCS.get(doc_id)
    if doc is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    status = preconditions(request, doc)
    if status is not None:
        return stop(status, doc)
    return JSONResponse({"text": doc["text"]}, headers=validators(doc))


@app.put("/docs/{doc_id}")
async def put_doc(doc_id: str, request: Request) -> Response:
    current = DOCS.get(doc_id)
    status = preconditions(request, current)
    if status is not None:
        return stop(status, current)
    if current is not None and "if-match" not in request.headers:
        return required()
    try:
        text = (await request.json()).get("text")
    except (ValueError, AttributeError):
        text = None
    if not isinstance(text, str):
        return JSONResponse({"error": "text_required"}, status_code=400)
    doc = {"text": text, "etag": etag_of(text), "modified": int(time.time())}
    DOCS[doc_id] = doc
    return JSONResponse({"text": text}, status_code=201 if current is None else 200, headers=validators(doc))


@app.delete("/docs/{doc_id}")
async def delete_doc(doc_id: str, request: Request) -> Response:
    current = DOCS.get(doc_id)
    if current is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    status = preconditions(request, current)
    if status is not None:
        return stop(status, current)
    if "if-match" not in request.headers:
        return required()
    del DOCS[doc_id]
    return Response(status_code=204)
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';
import Fastify, {type FastifyReply} from 'fastify';

export const app = Fastify();

export const ETAG_HEX = 16;

export interface Doc {
  text: string;
  /** '"<16 hex>"' */
  etag: string;
  /** Epoch seconds. */
  modified: number;
}

export const docs = new Map<string, Doc>();

type Headers = Record<string, string | string[] | undefined>;

export function etagOf(text: string): string {
  return \`"\${createHash('sha256').update(text).digest('hex').slice(0, ETAG_HEX)}"\`;
}

function validators(doc: Doc): Record<string, string> {
  return {etag: doc.etag, 'last-modified': new Date(doc.modified * 1000).toUTCString()};
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Epoch seconds of an HTTP date, or null when absent or unparseable. */
function httpDate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** RFC 9110 §13.2.2: null to perform the method, or the status that ends it (304 or 412). */
export function preconditions(method: string, headers: Headers, doc: Doc | undefined): 304 | 412 | null {
  // TODO: 1. If-Match (strong; * = exists) fails -> 412   2. else If-Unmodified-Since earlier than modified -> 412
  // TODO: 3. If-None-Match (weak; * = exists) matches -> 304 on GET, 412 otherwise
  // TODO: 4. else, GET only, If-Modified-Since at or after modified -> 304
  return null;
}

function stop(reply: FastifyReply, status: 304 | 412, doc: Doc | undefined) {
  if (status === 304 && doc !== undefined) return reply.code(304).headers(validators(doc)).send();
  return reply.code(412).send({error: 'precondition_failed'});
}

app.get('/docs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const doc = docs.get(id);
  if (doc === undefined) return reply.code(404).send({error: 'not_found'});
  const status = preconditions(request.method, request.headers, doc);
  if (status !== null) return stop(reply, status, doc);
  return reply.headers(validators(doc)).send({text: doc.text});
});

app.put('/docs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const current = docs.get(id);
  const status = preconditions(request.method, request.headers, current);
  if (status !== null) return stop(reply, status, current);
  // TODO: an existing doc without If-Match -> 428 precondition_required
  const {text} = (request.body ?? {}) as {text?: unknown};
  if (typeof text !== 'string') return reply.code(400).send({error: 'text_required'});
  const doc: Doc = {text, etag: etagOf(text), modified: Math.floor(Date.now() / 1000)};
  docs.set(id, doc);
  return reply
    .code(current === undefined ? 201 : 200)
    .headers(validators(doc))
    .send({text});
});

app.delete('/docs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const current = docs.get(id);
  if (current === undefined) return reply.code(404).send({error: 'not_found'});
  const status = preconditions(request.method, request.headers, current);
  if (status !== null) return stop(reply, status, current);
  // TODO: without If-Match -> 428 precondition_required
  docs.delete(id);
  return reply.code(204).send();
});
`,
      solution: `import {createHash} from 'node:crypto';
import Fastify, {type FastifyReply} from 'fastify';

export const app = Fastify();

export const ETAG_HEX = 16;

export interface Doc {
  text: string;
  /** '"<16 hex>"' */
  etag: string;
  /** Epoch seconds. */
  modified: number;
}

export const docs = new Map<string, Doc>();

type Headers = Record<string, string | string[] | undefined>;

export function etagOf(text: string): string {
  return \`"\${createHash('sha256').update(text).digest('hex').slice(0, ETAG_HEX)}"\`;
}

function validators(doc: Doc): Record<string, string> {
  return {etag: doc.etag, 'last-modified': new Date(doc.modified * 1000).toUTCString()};
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Epoch seconds of an HTTP date, or null when absent or unparseable. */
function httpDate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function tags(value: string): string[] {
  return value
    .split(',')
    .map(t => t.trim())
    .filter(t => t !== '');
}

const opaque = (tag: string): string => (tag.startsWith('W/') ? tag.slice(2) : tag);

function strongMatch(value: string, etag: string): boolean {
  return tags(value).some(t => t === '*' || (!t.startsWith('W/') && t === etag));
}

function weakMatch(value: string, etag: string): boolean {
  return tags(value).some(t => t === '*' || opaque(t) === opaque(etag));
}

/** RFC 9110 §13.2.2: null to perform the method, or the status that ends it (304 or 412). */
export function preconditions(method: string, headers: Headers, doc: Doc | undefined): 304 | 412 | null {
  const ifMatch = header(headers, 'if-match');
  if (ifMatch !== undefined) {
    if (doc === undefined || !strongMatch(ifMatch, doc.etag)) return 412;
  } else if (doc !== undefined) {
    const since = httpDate(header(headers, 'if-unmodified-since'));
    if (since !== null && doc.modified > since) return 412;
  }
  const ifNoneMatch = header(headers, 'if-none-match');
  if (ifNoneMatch !== undefined) {
    if (doc !== undefined && weakMatch(ifNoneMatch, doc.etag)) return method === 'GET' ? 304 : 412;
  } else if (method === 'GET' && doc !== undefined) {
    const since = httpDate(header(headers, 'if-modified-since'));
    if (since !== null && doc.modified <= since) return 304;
  }
  return null;
}

function stop(reply: FastifyReply, status: 304 | 412, doc: Doc | undefined) {
  if (status === 304 && doc !== undefined) return reply.code(304).headers(validators(doc)).send();
  return reply.code(412).send({error: 'precondition_failed'});
}

app.get('/docs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const doc = docs.get(id);
  if (doc === undefined) return reply.code(404).send({error: 'not_found'});
  const status = preconditions(request.method, request.headers, doc);
  if (status !== null) return stop(reply, status, doc);
  return reply.headers(validators(doc)).send({text: doc.text});
});

app.put('/docs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const current = docs.get(id);
  const status = preconditions(request.method, request.headers, current);
  if (status !== null) return stop(reply, status, current);
  if (current !== undefined && request.headers['if-match'] === undefined)
    return reply.code(428).send({error: 'precondition_required'});
  const {text} = (request.body ?? {}) as {text?: unknown};
  if (typeof text !== 'string') return reply.code(400).send({error: 'text_required'});
  const doc: Doc = {text, etag: etagOf(text), modified: Math.floor(Date.now() / 1000)};
  docs.set(id, doc);
  return reply
    .code(current === undefined ? 201 : 200)
    .headers(validators(doc))
    .send({text});
});

app.delete('/docs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  const current = docs.get(id);
  if (current === undefined) return reply.code(404).send({error: 'not_found'});
  const status = preconditions(request.method, request.headers, current);
  if (status !== null) return stop(reply, status, current);
  if (request.headers['if-match'] === undefined) return reply.code(428).send({error: 'precondition_required'});
  docs.delete(id);
  return reply.code(204).send();
});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

const etagHex = 16

type doc struct {
	Text     string
	ETag     string    // "<16 hex>"
	Modified time.Time // whole seconds, UTC
}

var (
	mu   sync.Mutex
	docs = map[string]*doc{}
)

func etagOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "\\"" + hex.EncodeToString(sum[:])[:etagHex] + "\\""
}

func setValidators(w http.ResponseWriter, d *doc) {
	w.Header().Set("ETag", d.ETag)
	w.Header().Set("Last-Modified", d.Modified.Format(http.TimeFormat))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

// checkPreconditions is RFC 9110 §13.2.2: 0 to perform the method, or 304 / 412.
func checkPreconditions(r *http.Request, d *doc) int {
	// TODO: 1. If-Match (strong; * = exists) fails -> 412   2. else If-Unmodified-Since earlier than Modified -> 412
	// TODO: 3. If-None-Match (weak; * = exists) matches -> 304 on GET, 412 otherwise
	// TODO: 4. else, GET only, If-Modified-Since at or after Modified -> 304
	return 0
}

func stop(w http.ResponseWriter, status int, d *doc) {
	if status == http.StatusNotModified {
		setValidators(w, d)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusPreconditionFailed, map[string]string{"error": "precondition_failed"})
}

func getDoc(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	d := docs[r.PathValue("id")]
	if d == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	if status := checkPreconditions(r, d); status != 0 {
		stop(w, status, d)
		return
	}
	setValidators(w, d)
	writeJSON(w, http.StatusOK, map[string]string{"text": d.Text})
}

func putDoc(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	decodeErr := json.NewDecoder(r.Body).Decode(&body)
	mu.Lock()
	defer mu.Unlock()
	id := r.PathValue("id")
	current := docs[id]
	if status := checkPreconditions(r, current); status != 0 {
		stop(w, status, current)
		return
	}
	// TODO: an existing doc without If-Match -> 428 precondition_required
	text, ok := body["text"].(string)
	if decodeErr != nil || !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text_required"})
		return
	}
	next := &doc{Text: text, ETag: etagOf(text), Modified: time.Now().UTC().Truncate(time.Second)}
	docs[id] = next
	setValidators(w, next)
	status := http.StatusOK
	if current == nil {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]string{"text": text})
}

func deleteDoc(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	id := r.PathValue("id")
	current := docs[id]
	if current == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	if status := checkPreconditions(r, current); status != 0 {
		stop(w, status, current)
		return
	}
	// TODO: without If-Match -> 428 precondition_required
	delete(docs, id)
	w.WriteHeader(http.StatusNoContent)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /docs/{id}", getDoc)
	mux.HandleFunc("PUT /docs/{id}", putDoc)
	mux.HandleFunc("DELETE /docs/{id}", deleteDoc)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const etagHex = 16

type doc struct {
	Text     string
	ETag     string    // "<16 hex>"
	Modified time.Time // whole seconds, UTC
}

var (
	mu   sync.Mutex
	docs = map[string]*doc{}
)

func etagOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "\\"" + hex.EncodeToString(sum[:])[:etagHex] + "\\""
}

func setValidators(w http.ResponseWriter, d *doc) {
	w.Header().Set("ETag", d.ETag)
	w.Header().Set("Last-Modified", d.Modified.Format(http.TimeFormat))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func tags(header []string) []string {
	var out []string
	for _, h := range header {
		for _, t := range strings.Split(h, ",") {
			if t = strings.TrimSpace(t); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

func strongMatch(header []string, etag string) bool {
	for _, t := range tags(header) {
		if t == "*" || (!strings.HasPrefix(t, "W/") && t == etag) {
			return true
		}
	}
	return false
}

func weakMatch(header []string, etag string) bool {
	for _, t := range tags(header) {
		if t == "*" || strings.TrimPrefix(t, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

// checkPreconditions is RFC 9110 §13.2.2: 0 to perform the method, or 304 / 412.
func checkPreconditions(r *http.Request, d *doc) int {
	if ifMatch, ok := r.Header["If-Match"]; ok {
		if d == nil || !strongMatch(ifMatch, d.ETag) {
			return http.StatusPreconditionFailed
		}
	} else if d != nil {
		if since, err := http.ParseTime(r.Header.Get("If-Unmodified-Since")); err == nil && d.Modified.After(since) {
			return http.StatusPreconditionFailed
		}
	}
	if ifNoneMatch, ok := r.Header["If-None-Match"]; ok {
		if d != nil && weakMatch(ifNoneMatch, d.ETag) {
			if r.Method == http.MethodGet {
				return http.StatusNotModified
			}
			return http.StatusPreconditionFailed
		}
	} else if r.Method == http.MethodGet && d != nil {
		if since, err := http.ParseTime(r.Header.Get("If-Modified-Since")); err == nil && !d.Modified.After(since) {
			return http.StatusNotModified
		}
	}
	return 0
}

func stop(w http.ResponseWriter, status int, d *doc) {
	if status == http.StatusNotModified {
		setValidators(w, d)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusPreconditionFailed, map[string]string{"error": "precondition_failed"})
}

func hasIfMatch(r *http.Request) bool {
	_, ok := r.Header["If-Match"]
	return ok
}

func getDoc(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	d := docs[r.PathValue("id")]
	if d == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	if status := checkPreconditions(r, d); status != 0 {
		stop(w, status, d)
		return
	}
	setValidators(w, d)
	writeJSON(w, http.StatusOK, map[string]string{"text": d.Text})
}

func putDoc(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	decodeErr := json.NewDecoder(r.Body).Decode(&body)
	mu.Lock()
	defer mu.Unlock()
	id := r.PathValue("id")
	current := docs[id]
	if status := checkPreconditions(r, current); status != 0 {
		stop(w, status, current)
		return
	}
	if current != nil && !hasIfMatch(r) {
		writeJSON(w, http.StatusPreconditionRequired, map[string]string{"error": "precondition_required"})
		return
	}
	text, ok := body["text"].(string)
	if decodeErr != nil || !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text_required"})
		return
	}
	next := &doc{Text: text, ETag: etagOf(text), Modified: time.Now().UTC().Truncate(time.Second)}
	docs[id] = next
	setValidators(w, next)
	status := http.StatusOK
	if current == nil {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]string{"text": text})
}

func deleteDoc(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	id := r.PathValue("id")
	current := docs[id]
	if current == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	if status := checkPreconditions(r, current); status != 0 {
		stop(w, status, current)
		return
	}
	if !hasIfMatch(r) {
		writeJSON(w, http.StatusPreconditionRequired, map[string]string{"error": "precondition_required"})
		return
	}
	delete(docs, id)
	w.WriteHeader(http.StatusNoContent)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /docs/{id}", getDoc)
	mux.HandleFunc("PUT /docs/{id}", putDoc)
	mux.HandleFunc("DELETE /docs/{id}", deleteDoc)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import java.time.{Instant, ZoneOffset, ZonedDateTime}
import java.time.format.DateTimeFormatter
import java.util.Locale

import scala.collection.mutable
import scala.util.Try

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object DocsApi {
  val EtagHex = 16

  /** etag is "<16 hex>", modified is epoch seconds. */
  final case class Doc(text: String, etag: String, modified: Long)

  val docs = mutable.Map.empty[String, Doc]

  private val imfFixdate =
    DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US).withZone(ZoneOffset.UTC)

  def etagOf(text: String): String =
    "\\"" + MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString.take(EtagHex) + "\\""

  private def validators(d: Doc): List[HttpHeader] =
    List(RawHeader("ETag", d.etag), RawHeader("Last-Modified", imfFixdate.format(Instant.ofEpochSecond(d.modified))))

  /** Epoch seconds of an HTTP date, or None when absent or unparseable. */
  private def httpDate(value: Option[String]): Option[Long] =
    value.flatMap(v => Try(ZonedDateTime.parse(v, imfFixdate).toEpochSecond).toOption)

  private def header(req: HttpRequest, name: String): Option[String] =
    req.headers.find(_.is(name.toLowerCase)).map(_.value)

  /** RFC 9110 §13.2.2: None to perform the method, or the status that ends it (304 or 412). */
  def preconditions(req: HttpRequest, doc: Option[Doc]): Option[StatusCode] = {
    // TODO: 1. If-Match (strong; * = exists) fails -> 412   2. else If-Unmodified-Since earlier than modified -> 412
    // TODO: 3. If-None-Match (weak; * = exists) matches -> 304 on GET, 412 otherwise
    // TODO: 4. else, GET only, If-Modified-Since at or after modified -> 304
    None
  }

  private def json(status: StatusCode, body: JsValue, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))

  private def error(status: StatusCode, code: String): Route = json(status, JsObject("error" -> JsString(code)))

  private def stop(status: StatusCode, doc: Option[Doc]): Route =
    if (status == StatusCodes.NotModified) complete(HttpResponse(StatusCodes.NotModified, headers = validators(doc.get)))
    else error(StatusCodes.PreconditionFailed, "precondition_failed")

  val route: Route =
    path("docs" / Segment) { id =>
      extractRequest { req =>
        concat(
          get {
            docs.synchronized(docs.get(id)) match {
              case None => error(StatusCodes.NotFound, "not_found")
              case Some(d) =>
                preconditions(req, Some(d)) match {
                  case Some(status) => stop(status, Some(d))
                  case None         => json(StatusCodes.OK, JsObject("text" -> JsString(d.text)), validators(d))
                }
            }
          },
          put {
            entity(as[String]) { raw =>
              docs.synchronized {
                val current = docs.get(id)
                preconditions(req, current) match {
                  case Some(status) => stop(status, current)
                  // TODO: an existing doc without If-Match -> 428 precondition_required
                  case None =>
                    Try(raw.parseJson.asJsObject.fields("text")).toOption match {
                      case Some(JsString(text)) =>
                        val next = Doc(text, etagOf(text), Instant.now().getEpochSecond)
                        docs.put(id, next)
                        val status = if (current.isEmpty) StatusCodes.Created else StatusCodes.OK
                        json(status, JsObject("text" -> JsString(text)), validators(next))
                      case _ => error(StatusCodes.BadRequest, "text_required")
                    }
                }
              }
            }
          },
          delete {
            docs.synchronized {
              docs.get(id) match {
                case None => error(StatusCodes.NotFound, "not_found")
                case current =>
                  preconditions(req, current) match {
                    case Some(status) => stop(status, current)
                    // TODO: without If-Match -> 428 precondition_required
                    case None =>
                      docs.remove(id)
                      complete(StatusCodes.NoContent)
                  }
              }
            }
          }
        )
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("docs")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest
import java.time.{Instant, ZoneOffset, ZonedDateTime}
import java.time.format.DateTimeFormatter
import java.util.Locale

import scala.collection.mutable
import scala.util.Try

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object DocsApi {
  val EtagHex = 16

  /** etag is "<16 hex>", modified is epoch seconds. */
  final case class Doc(text: String, etag: String, modified: Long)

  val docs = mutable.Map.empty[String, Doc]

  private val imfFixdate =
    DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US).withZone(ZoneOffset.UTC)

  def etagOf(text: String): String =
    "\\"" + MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString.take(EtagHex) + "\\""

  private def validators(d: Doc): List[HttpHeader] =
    List(RawHeader("ETag", d.etag), RawHeader("Last-Modified", imfFixdate.format(Instant.ofEpochSecond(d.modified))))

  /** Epoch seconds of an HTTP date, or None when absent or unparseable. */
  private def httpDate(value: Option[String]): Option[Long] =
    value.flatMap(v => Try(ZonedDateTime.parse(v, imfFixdate).toEpochSecond).toOption)

  private def header(req: HttpRequest, name: String): Option[String] =
    req.headers.find(_.is(name.toLowerCase)).map(_.value)

  private def tags(value: String): List[String] = value.split(",").map(_.trim).filter(_.nonEmpty).toList

  def strongMatch(value: String, etag: String): Boolean =
    tags(value).exists(t => t == "*" || (!t.startsWith("W/") && t == etag))

  def weakMatch(value: String, etag: String): Boolean =
    tags(value).exists(t => t == "*" || t.stripPrefix("W/") == etag.stripPrefix("W/"))

  /** RFC 9110 §13.2.2: None to perform the method, or the status that ends it (304 or 412). */
  def preconditions(req: HttpRequest, doc: Option[Doc]): Option[StatusCode] = {
    val isGet = req.method == HttpMethods.GET
    val writeGate: Option[StatusCode] = header(req, "If-Match") match {
      case Some(ifMatch) =>
        if (doc.exists(d => strongMatch(ifMatch, d.etag))) None else Some(StatusCodes.PreconditionFailed)
      case None =>
        val since = httpDate(header(req, "If-Unmodified-Since"))
        if (doc.exists(d => since.exists(d.modified > _))) Some(StatusCodes.PreconditionFailed) else None
    }
    writeGate.orElse(header(req, "If-None-Match") match {
      case Some(ifNoneMatch) =>
        if (doc.exists(d => weakMatch(ifNoneMatch, d.etag)))
          Some(if (isGet) StatusCodes.NotModified else StatusCodes.PreconditionFailed)
        else None
      case None =>
        val since = httpDate(header(req, "If-Modified-Since"))
        if (isGet && doc.exists(d => since.exists(d.modified <= _))) Some(StatusCodes.NotModified) else None
    })
  }

  private def json(status: StatusCode, body: JsValue, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))

  private def error(status: StatusCode, code: String): Route = json(status, JsObject("error" -> JsString(code)))

  private def stop(status: StatusCode, doc: Option[Doc]): Route =
    if (status == StatusCodes.NotModified) complete(HttpResponse(StatusCodes.NotModified, headers = validators(doc.get)))
    else error(StatusCodes.PreconditionFailed, "precondition_failed")

  val route: Route =
    path("docs" / Segment) { id =>
      extractRequest { req =>
        val hasIfMatch = header(req, "If-Match").isDefined
        concat(
          get {
            docs.synchronized(docs.get(id)) match {
              case None => error(StatusCodes.NotFound, "not_found")
              case Some(d) =>
                preconditions(req, Some(d)) match {
                  case Some(status) => stop(status, Some(d))
                  case None         => json(StatusCodes.OK, JsObject("text" -> JsString(d.text)), validators(d))
                }
            }
          },
          put {
            entity(as[String]) { raw =>
              docs.synchronized {
                val current = docs.get(id)
                preconditions(req, current) match {
                  case Some(status) => stop(status, current)
                  case None if current.isDefined && !hasIfMatch =>
                    error(StatusCodes.PreconditionRequired, "precondition_required")
                  case None =>
                    Try(raw.parseJson.asJsObject.fields("text")).toOption match {
                      case Some(JsString(text)) =>
                        val next = Doc(text, etagOf(text), Instant.now().getEpochSecond)
                        docs.put(id, next)
                        val status = if (current.isEmpty) StatusCodes.Created else StatusCodes.OK
                        json(status, JsObject("text" -> JsString(text)), validators(next))
                      case _ => error(StatusCodes.BadRequest, "text_required")
                    }
                }
              }
            }
          },
          delete {
            docs.synchronized {
              docs.get(id) match {
                case None => error(StatusCodes.NotFound, "not_found")
                case current =>
                  preconditions(req, current) match {
                    case Some(status) => stop(status, current)
                    case None if !hasIfMatch =>
                      error(StatusCodes.PreconditionRequired, "precondition_required")
                    case None =>
                      docs.remove(id)
                      complete(StatusCodes.NoContent)
                  }
              }
            }
          }
        )
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("docs")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <ctime>
#include <iomanip>
#include <locale>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

using json = nlohmann::json;

constexpr size_t kEtagHex = 16;

struct Doc {
  std::string text;
  std::string etag;     // "<16 hex>"
  std::time_t modified;  // epoch seconds
};

std::mutex mu;
std::map<std::string, Doc> docs;

std::string etag_of(const std::string& text) { return "\\"" + sha256_hex(text).substr(0, kEtagHex) + "\\""; }

std::string imf_fixdate(std::time_t t) {
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[64];
  std::strftime(buf, sizeof buf, "%a, %d %b %Y %H:%M:%S GMT", &tm);
  return buf;
}

// Epoch seconds of an HTTP date, or nullopt when unparseable.
std::optional<std::time_t> http_date(const std::string& value) {
  std::tm tm{};
  std::istringstream in(value);
  in.imbue(std::locale::classic());
  in >> std::get_time(&tm, "%a, %d %b %Y %H:%M:%S GMT");
  if (in.fail()) return std::nullopt;
  return timegm(&tm);
}

void set_validators(httplib::Response& res, const Doc& doc) {
  res.set_header("ETag", doc.etag);
  res.set_header("Last-Modified", imf_fixdate(doc.modified));
}

void send_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// RFC 9110 §13.2.2: 0 to perform the method, or 304 / 412.
int preconditions(const httplib::Request& req, const Doc* doc) {
  // TODO: 1. If-Match (strong; * = exists) fails -> 412   2. else If-Unmodified-Since earlier than modified -> 412
  // TODO: 3. If-None-Match (weak; * = exists) matches -> 304 on GET, 412 otherwise
  // TODO: 4. else, GET only, If-Modified-Since at or after modified -> 304
  return 0;
}

void stop(httplib::Response& res, int status, const Doc* doc) {
  if (status == 304) {
    res.status = 304;
    set_validators(res, *doc);
    return;
  }
  send_json(res, 412, {{"error", "precondition_failed"}});
}

int main() {
  httplib::Server svr;
  const char* route = R"(/docs/([\\w-]+))";

  svr.Get(route, [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const auto it = docs.find(req.matches[1]);
    if (it == docs.end()) return send_json(res, 404, {{"error", "not_found"}});
    if (const int status = preconditions(req, &it->second)) return stop(res, status, &it->second);
    set_validators(res, it->second);
    send_json(res, 200, {{"text", it->second.text}});
  });

  svr.Put(route, [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const std::string id = req.matches[1];
    const auto it = docs.find(id);
    const Doc* current = it == docs.end() ? nullptr : &it->second;
    if (const int status = preconditions(req, current)) return stop(res, status, current);
    // TODO: an existing doc without If-Match -> 428 precondition_required
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string())
      return send_json(res, 400, {{"error", "text_required"}});
    const std::string text = body["text"];
    const bool created = current == nullptr;
    docs[id] = Doc{text, etag_of(text), std::time(nullptr)};
    set_validators(res, docs[id]);
    send_json(res, created ? 201 : 200, {{"text", text}});
  });

  svr.Delete(route, [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const auto it = docs.find(req.matches[1]);
    if (it == docs.end()) return send_json(res, 404, {{"error", "not_found"}});
    if (const int status = preconditions(req, &it->second)) return stop(res, status, &it->second);
    // TODO: without If-Match -> 428 precondition_required
    docs.erase(it);
    res.status = 204;
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <ctime>
#include <iomanip>
#include <locale>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

using json = nlohmann::json;

constexpr size_t kEtagHex = 16;

struct Doc {
  std::string text;
  std::string etag;     // "<16 hex>"
  std::time_t modified;  // epoch seconds
};

std::mutex mu;
std::map<std::string, Doc> docs;

std::string etag_of(const std::string& text) { return "\\"" + sha256_hex(text).substr(0, kEtagHex) + "\\""; }

std::string imf_fixdate(std::time_t t) {
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[64];
  std::strftime(buf, sizeof buf, "%a, %d %b %Y %H:%M:%S GMT", &tm);
  return buf;
}

// Epoch seconds of an HTTP date, or nullopt when unparseable.
std::optional<std::time_t> http_date(const std::string& value) {
  std::tm tm{};
  std::istringstream in(value);
  in.imbue(std::locale::classic());
  in >> std::get_time(&tm, "%a, %d %b %Y %H:%M:%S GMT");
  if (in.fail()) return std::nullopt;
  return timegm(&tm);
}

void set_validators(httplib::Response& res, const Doc& doc) {
  res.set_header("ETag", doc.etag);
  res.set_header("Last-Modified", imf_fixdate(doc.modified));
}

void send_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::vector<std::string> tags(const std::string& header) {
  std::vector<std::string> out;
  std::stringstream in(header);
  std::string tag;
  while (std::getline(in, tag, ',')) {
    const auto first = tag.find_first_not_of(' ');
    if (first == std::string::npos) continue;
    out.push_back(tag.substr(first, tag.find_last_not_of(' ') - first + 1));
  }
  return out;
}

bool is_weak(const std::string& tag) { return tag.rfind("W/", 0) == 0; }

std::string opaque(const std::string& tag) { return is_weak(tag) ? tag.substr(2) : tag; }

bool strong_match(const std::string& header, const std::string& etag) {
  for (const auto& t : tags(header))
    if (t == "*" || (!is_weak(t) && t == etag)) return true;
  return false;
}

bool weak_match(const std::string& header, const std::string& etag) {
  for (const auto& t : tags(header))
    if (t == "*" || opaque(t) == opaque(etag)) return true;
  return false;
}

// RFC 9110 §13.2.2: 0 to perform the method, or 304 / 412.
int preconditions(const httplib::Request& req, const Doc* doc) {
  if (req.has_header("If-Match")) {
    if (!doc || !strong_match(req.get_header_value("If-Match"), doc->etag)) return 412;
  } else if (doc && req.has_header("If-Unmodified-Since")) {
    const auto since = http_date(req.get_header_value("If-Unmodified-Since"));
    if (since && doc->modified > *since) return 412;
  }
  if (req.has_header("If-None-Match")) {
    if (doc && weak_match(req.get_header_value("If-None-Match"), doc->etag)) return req.method == "GET" ? 304 : 412;
  } else if (doc && req.method == "GET" && req.has_header("If-Modified-Since")) {
    const auto since = http_date(req.get_header_value("If-Modified-Since"));
    if (since && doc->modified <= *since) return 304;
  }
  return 0;
}

void stop(httplib::Response& res, int status, const Doc* doc) {
  if (status == 304) {
    res.status = 304;
    set_validators(res, *doc);
    return;
  }
  send_json(res, 412, {{"error", "precondition_failed"}});
}

int main() {
  httplib::Server svr;
  const char* route = R"(/docs/([\\w-]+))";

  svr.Get(route, [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const auto it = docs.find(req.matches[1]);
    if (it == docs.end()) return send_json(res, 404, {{"error", "not_found"}});
    if (const int status = preconditions(req, &it->second)) return stop(res, status, &it->second);
    set_validators(res, it->second);
    send_json(res, 200, {{"text", it->second.text}});
  });

  svr.Put(route, [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const std::string id = req.matches[1];
    const auto it = docs.find(id);
    const Doc* current = it == docs.end() ? nullptr : &it->second;
    if (const int status = preconditions(req, current)) return stop(res, status, current);
    if (current && !req.has_header("If-Match")) return send_json(res, 428, {{"error", "precondition_required"}});
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string())
      return send_json(res, 400, {{"error", "text_required"}});
    const std::string text = body["text"];
    const bool created = current == nullptr;
    docs[id] = Doc{text, etag_of(text), std::time(nullptr)};
    set_validators(res, docs[id]);
    send_json(res, created ? 201 : 200, {{"text", text}});
  });

  svr.Delete(route, [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const auto it = docs.find(req.matches[1]);
    if (it == docs.end()) return send_json(res, 404, {{"error", "not_found"}});
    if (const int status = preconditions(req, &it->second)) return stop(res, status, &it->second);
    if (!req.has_header("If-Match")) return send_json(res, 428, {{"error", "precondition_required"}});
    docs.erase(it);
    res.status = 204;
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  debrief: `The handler is a function of two things the client sent back (a tag and a date) and two the server holds (the current tag and \`modified\`), evaluated in the order RFC 9110 §13.2.2 fixes so that every server gives the same answer to the same headers. The tag headers outrank their date siblings because a tag is exact and a date has one-second resolution: two writes in the same second share a \`Last-Modified\` but never an ETag. \`If-Match\` compares strongly because a write must replace exactly the bytes the writer read; \`If-None-Match\` compares weakly because a cache only needs "equivalent". The 428 closes the gap the RFC leaves open: preconditions are optional for the client, so a server that wants no lost updates has to refuse writes without one. In production the check and the write must be atomic (a lock, a compare-and-set in the store, or \`UPDATE … WHERE version = ?\`), the ETag usually comes from a version column rather than a content hash, \`Vary\` and \`Cache-Control\` tell shared caches how to reuse the 200, and HEAD and range requests (\`If-Range\`) join the same table.`,
  harness: {
    python: `import hashlib
from email.utils import formatdate, parsedate_to_datetime

STALE = '"0000000000000000"'


def _etag(text):
    return '"' + hashlib.sha256(text.encode()).hexdigest()[:16] + '"'


def _ts(http_date):
    return int(parsedate_to_datetime(http_date).timestamp())


def _date(ts):
    return formatdate(ts, usegmt=True)


async def _create(c, doc_id, text):
    r = await c.put(f"/docs/{doc_id}", json={"text": text})
    assert r.status_code == 201, f"PUT /docs/{doc_id} on a missing doc without preconditions answered {r.status_code}, not 201"
    ok = await c.get(f"/docs/{doc_id}")
    assert ok.status_code == 200, f"GET /docs/{doc_id} after creating it answered {ok.status_code}"
    return ok.headers.get("etag"), ok.headers.get("last-modified")


async def check_not_modified(ctx):
    m = ctx.load("docs_api")
    async with ctx.client(m.app) as c:
        await _create(c, "readme", "hello")
        ok = await c.get("/docs/readme")
        assert ok.json() == {"text": "hello"}, f"GET answered {ok.json()!r}, not {{'text': 'hello'}}"
        etag, lm = ok.headers.get("etag"), ok.headers.get("last-modified")
        assert etag == _etag("hello"), f"ETag was {etag!r}, expected the quoted first 16 hex digits of sha256(text): {_etag('hello')!r}"
        assert lm and _date(_ts(lm)) == lm, f"Last-Modified was {lm!r}, not an IMF-fixdate like 'Thu, 22 Oct 2026 10:00:00 GMT'"
        r = await c.get("/docs/readme", headers={"If-None-Match": etag})
        assert r.status_code == 304, f"If-None-Match with the current ETag answered {r.status_code}, not 304"
        assert r.content == b"", f"a 304 carries no body, got {r.content!r}"
        assert r.headers.get("etag") == etag, f"the 304 must repeat ETag {etag!r}, got {r.headers.get('etag')!r}"
        assert r.headers.get("last-modified") == lm, f"the 304 must repeat Last-Modified {lm!r}, got {r.headers.get('last-modified')!r}"
        r = await c.get("/docs/readme", headers={"If-None-Match": STALE})
        assert r.status_code == 200, f"If-None-Match with a stale tag answered {r.status_code}, not 200"
        r = await c.get("/docs/readme", headers={"If-Modified-Since": lm})
        assert r.status_code == 304, f"If-Modified-Since equal to Last-Modified answered {r.status_code}, not 304"
        assert r.content == b"" and r.headers.get("etag") == etag and r.headers.get("last-modified") == lm, "the If-Modified-Since 304 must carry ETag and Last-Modified and no body"
        r = await c.get("/docs/readme", headers={"If-Modified-Since": _date(_ts(lm) + 3600)})
        assert r.status_code == 304, f"If-Modified-Since an hour after Last-Modified answered {r.status_code}, not 304"
        r = await c.get("/docs/readme", headers={"If-Modified-Since": _date(_ts(lm) - 1)})
        assert r.status_code == 200, f"If-Modified-Since one second before Last-Modified answered {r.status_code}, not 200"
        r = await c.get("/docs/ghost", headers={"If-None-Match": "*"})
        assert r.status_code == 404, f"GET of a missing doc with If-None-Match: * answered {r.status_code}, not 404"


async def check_precedence(ctx):
    m = ctx.load("docs_api")
    async with ctx.client(m.app) as c:
        etag, lm = await _create(c, "log", "a")
        t = _ts(lm)
        r = await c.get("/docs/log", headers={"If-None-Match": STALE, "If-Modified-Since": lm})
        assert r.status_code == 200, f"a stale If-None-Match with a fresh If-Modified-Since answered {r.status_code}: If-None-Match is present, so If-Modified-Since is ignored (200)"
        r = await c.get("/docs/log", headers={"If-None-Match": etag, "If-Modified-Since": _date(t - 3600)})
        assert r.status_code == 304, f"a matching If-None-Match with an old If-Modified-Since answered {r.status_code}, not 304"
        r = await c.get("/docs/log", headers={"If-Unmodified-Since": _date(t - 1)})
        assert r.status_code == 412, f"If-Unmodified-Since one second before Last-Modified answered {r.status_code}, not 412"
        r = await c.get("/docs/log", headers={"If-Unmodified-Since": lm})
        assert r.status_code == 200, f"If-Unmodified-Since equal to Last-Modified answered {r.status_code}, not 200"
        r = await c.get("/docs/log", headers={"If-Match": STALE, "If-None-Match": etag})
        assert r.status_code == 412, f"a failing If-Match with a matching If-None-Match answered {r.status_code}: If-Match is evaluated first (412)"
        r = await c.put("/docs/log", json={"text": "b"}, headers={"If-Match": etag, "If-Unmodified-Since": _date(t - 3600)})
        assert r.status_code == 200, f"a matching If-Match with an old If-Unmodified-Since answered {r.status_code}: If-Match is present, so If-Unmodified-Since is ignored (200)"
        r = await c.put("/docs/log", json={"text": "c"}, headers={"If-Match": etag, "If-Unmodified-Since": _date(t + 3600)})
        assert r.status_code == 412, f"a stale If-Match with a passing If-Unmodified-Since answered {r.status_code}, not 412"
        r = await c.get("/docs/log")
        assert r.json() == {"text": "b"}, f"the doc should hold 'b', got {r.json()!r}"


async def check_lost_update(ctx):
    m = ctx.load("docs_api")
    async with ctx.client(m.app) as c:
        await _create(c, "plan", "v1")
        alice = await c.get("/docs/plan")
        bob = await c.get("/docs/plan")
        e1 = alice.headers.get("etag")
        assert e1 and bob.headers.get("etag") == e1, "two reads of the same doc must see the same ETag"
        lm1 = _ts(alice.headers["last-modified"])
        ctx.clock.advance(30)
        a = await c.put("/docs/plan", json={"text": "alice"}, headers={"If-Match": e1})
        assert a.status_code == 200, f"Alice's PUT with the current If-Match answered {a.status_code}, not 200"
        assert a.headers.get("etag") == _etag("alice"), f"a successful write returns the new ETag {_etag('alice')!r}, got {a.headers.get('etag')!r}"
        lm2 = a.headers.get("last-modified")
        assert lm2 and 29 <= _ts(lm2) - lm1 <= 32, f"30 s later the write's Last-Modified should move 30 s: was {alice.headers['last-modified']!r}, now {lm2!r}"
        b = await c.put("/docs/plan", json={"text": "bob"}, headers={"If-Match": e1})
        assert b.status_code == 412, f"Bob's PUT with the ETag Alice already replaced answered {b.status_code}, not 412 (a lost update)"
        now = await c.get("/docs/plan")
        assert now.json() == {"text": "alice"}, f"after Bob's refused write the doc must hold Alice's text, got {now.json()!r}"
        retry = await c.put("/docs/plan", json={"text": "alice + bob"}, headers={"If-Match": now.headers["etag"]})
        assert retry.status_code == 200, f"Bob's retry with the fresh ETag answered {retry.status_code}, not 200"
        r = await c.delete("/docs/plan", headers={"If-Match": e1})
        assert r.status_code == 412, f"DELETE with a stale If-Match answered {r.status_code}, not 412"
        r = await c.delete("/docs/plan", headers={"If-Match": retry.headers["etag"]})
        assert r.status_code == 204, f"DELETE with the current If-Match answered {r.status_code}, not 204"
        r = await c.get("/docs/plan")
        assert r.status_code == 404, f"GET after the DELETE answered {r.status_code}, not 404"


async def check_precondition_required(ctx):
    m = ctx.load("docs_api")
    async with ctx.client(m.app) as c:
        _, lm = await _create(c, "spec", "draft")
        r = await c.put("/docs/spec", json={"text": "blind"})
        assert r.status_code == 428, f"PUT on an existing doc without If-Match answered {r.status_code}, not 428"
        r = await c.put("/docs/spec", json={"text": "blind"}, headers={"If-Unmodified-Since": lm})
        assert r.status_code == 428, f"PUT with only a passing If-Unmodified-Since answered {r.status_code}, not 428: If-Match is required"
        r = await c.put("/docs/spec", json={"text": "blind"}, headers={"If-None-Match": STALE})
        assert r.status_code == 428, f"PUT with only a non-matching If-None-Match answered {r.status_code}, not 428"
        r = await c.delete("/docs/spec")
        assert r.status_code == 428, f"DELETE on an existing doc without If-Match answered {r.status_code}, not 428"
        r = await c.get("/docs/spec")
        assert r.status_code == 200 and r.json() == {"text": "draft"}, f"a 428 must change nothing, the doc is now {r.status_code} {r.text!r}"
        r = await c.delete("/docs/ghost", headers={"If-Match": STALE})
        assert r.status_code == 404, f"DELETE of a missing doc answered {r.status_code}, not 404"
        r = await c.put("/docs/fresh", json={"text": "new"})
        assert r.status_code == 201, f"PUT on a missing doc without preconditions answered {r.status_code}, not 201"


async def check_create_only(ctx):
    m = ctx.load("docs_api")
    async with ctx.client(m.app) as c:
        r = await c.put("/docs/notes", json={"text": "first"}, headers={"If-None-Match": "*"})
        assert r.status_code == 201, f"PUT with If-None-Match: * on a missing doc answered {r.status_code}, not 201"
        assert r.headers.get("etag") == _etag("first"), f"the 201 carries ETag {_etag('first')!r}, got {r.headers.get('etag')!r}"
        lm = r.headers.get("last-modified")
        assert lm and _date(_ts(lm)) == lm, f"the 201 carries an IMF-fixdate Last-Modified, got {lm!r}"
        r = await c.put("/docs/notes", json={"text": "second"}, headers={"If-None-Match": "*"})
        assert r.status_code == 412, f"a second PUT with If-None-Match: * answered {r.status_code}, not 412"
        r = await c.get("/docs/notes")
        assert r.json() == {"text": "first"}, f"the refused create must not overwrite, the doc holds {r.json()!r}"
        r = await c.put("/docs/other", json={"text": "x"}, headers={"If-Match": "*"})
        assert r.status_code == 412, f"PUT with If-Match: * on a missing doc answered {r.status_code}, not 412"
        r = await c.get("/docs/other")
        assert r.status_code == 404, "If-Match: * on a missing doc must not create it"
        r = await c.put("/docs/notes", json={"text": "third"}, headers={"If-Match": "*"})
        assert r.status_code == 200, f"PUT with If-Match: * on an existing doc answered {r.status_code}, not 200"
        assert r.headers.get("etag") == _etag("third"), f"the 200 carries ETag {_etag('third')!r}, got {r.headers.get('etag')!r}"
        r = await c.get("/docs/notes", headers={"If-None-Match": "*"})
        assert r.status_code == 304, f"GET with If-None-Match: * on an existing doc answered {r.status_code}, not 304"


async def check_weak_strong(ctx):
    m = ctx.load("docs_api")
    async with ctx.client(m.app) as c:
        etag, _ = await _create(c, "faq", "q")
        weak = "W/" + etag
        r = await c.put("/docs/faq", json={"text": "x"}, headers={"If-Match": weak})
        assert r.status_code == 412, f"PUT with If-Match: {weak} answered {r.status_code}: a weak tag never matches strongly (412)"
        r = await c.get("/docs/faq", headers={"If-Match": weak})
        assert r.status_code == 412, f"GET with If-Match: {weak} answered {r.status_code}, not 412"
        r = await c.get("/docs/faq", headers={"If-None-Match": weak})
        assert r.status_code == 304, f"GET with If-None-Match: {weak} answered {r.status_code}: weak comparison ignores W/ (304)"
        r = await c.put("/docs/faq", json={"text": "x"}, headers={"If-Match": etag, "If-None-Match": weak})
        assert r.status_code == 412, f"PUT whose If-None-Match matches weakly answered {r.status_code}, not 412"
        r = await c.get("/docs/faq", headers={"If-Match": f"{STALE}, {etag}"})
        assert r.status_code == 200, f"If-Match listing the current tag second answered {r.status_code}, not 200"
        r = await c.get("/docs/faq", headers={"If-None-Match": f"{STALE}, {weak}"})
        assert r.status_code == 304, f"If-None-Match listing the weak current tag second answered {r.status_code}, not 304"
        r = await c.get("/docs/faq", headers={"If-Modified-Since": "not a date"})
        assert r.status_code == 200, f"an unparseable If-Modified-Since answered {r.status_code}: it is ignored (200)"
        r = await c.get("/docs/faq", headers={"If-Unmodified-Since": "yesterday"})
        assert r.status_code == 200, f"an unparseable If-Unmodified-Since answered {r.status_code}: it is ignored (200)"
        r = await c.put("/docs/faq", json={"text": "a"}, headers={"If-Match": etag})
        assert r.status_code == 200, f"PUT with the strong current tag answered {r.status_code}, not 200"
        r = await c.get("/docs/faq")
        assert r.json() == {"text": "a"}, f"the doc should hold 'a', got {r.json()!r}"
`,
    typescript: `import {createHash} from 'node:crypto';

const STALE = '"0000000000000000"';

const etagOf = (text: string): string => \`"\${createHash('sha256').update(text).digest('hex').slice(0, 16)}"\`;
const ts = (httpDate: string): number => Math.floor(Date.parse(httpDate) / 1000);
const date = (seconds: number): string => new Date(seconds * 1000).toUTCString();

async function create(c, id: string, text: string): Promise<[string, string]> {
  const r = await c.put(\`/docs/\${id}\`, {json: {text}});
  assert.equal(r.status, 201, \`PUT /docs/\${id} on a missing doc without preconditions answered \${r.status}, not 201\`);
  const ok = await c.get(\`/docs/\${id}\`);
  assert.equal(ok.status, 200, \`GET /docs/\${id} after creating it answered \${ok.status}\`);
  return [ok.headers['etag'], ok.headers['last-modified']];
}

export async function check_not_modified(ctx) {
  const m = ctx.load('docs_api');
  const c = ctx.client(m.app);
  await create(c, 'readme', 'hello');
  const ok = await c.get('/docs/readme');
  assert.deepEqual(ok.json(), {text: 'hello'}, \`GET answered \${ok.text}, not {"text": "hello"}\`);
  const etag = ok.headers['etag'];
  const lm = ok.headers['last-modified'];
  assert.equal(etag, etagOf('hello'), \`ETag was \${etag}, expected the quoted first 16 hex digits of sha256(text): \${etagOf('hello')}\`);
  assert(lm && date(ts(lm)) === lm, \`Last-Modified was \${lm}, not an IMF-fixdate like 'Thu, 22 Oct 2026 10:00:00 GMT'\`);
  let r = await c.get('/docs/readme', {headers: {'If-None-Match': etag}});
  assert.equal(r.status, 304, \`If-None-Match with the current ETag answered \${r.status}, not 304\`);
  assert.equal(r.text, '', \`a 304 carries no body, got \${r.text}\`);
  assert.equal(r.headers['etag'], etag, \`the 304 must repeat ETag \${etag}, got \${r.headers['etag']}\`);
  assert.equal(r.headers['last-modified'], lm, \`the 304 must repeat Last-Modified \${lm}, got \${r.headers['last-modified']}\`);
  r = await c.get('/docs/readme', {headers: {'If-None-Match': STALE}});
  assert.equal(r.status, 200, \`If-None-Match with a stale tag answered \${r.status}, not 200\`);
  r = await c.get('/docs/readme', {headers: {'If-Modified-Since': lm}});
  assert.equal(r.status, 304, \`If-Modified-Since equal to Last-Modified answered \${r.status}, not 304\`);
  assert(r.text === '' && r.headers['etag'] === etag && r.headers['last-modified'] === lm, 'the If-Modified-Since 304 must carry ETag and Last-Modified and no body');
  r = await c.get('/docs/readme', {headers: {'If-Modified-Since': date(ts(lm) + 3600)}});
  assert.equal(r.status, 304, \`If-Modified-Since an hour after Last-Modified answered \${r.status}, not 304\`);
  r = await c.get('/docs/readme', {headers: {'If-Modified-Since': date(ts(lm) - 1)}});
  assert.equal(r.status, 200, \`If-Modified-Since one second before Last-Modified answered \${r.status}, not 200\`);
  r = await c.get('/docs/ghost', {headers: {'If-None-Match': '*'}});
  assert.equal(r.status, 404, \`GET of a missing doc with If-None-Match: * answered \${r.status}, not 404\`);
}

export async function check_precedence(ctx) {
  const m = ctx.load('docs_api');
  const c = ctx.client(m.app);
  const [etag, lm] = await create(c, 'log', 'a');
  const t = ts(lm);
  let r = await c.get('/docs/log', {headers: {'If-None-Match': STALE, 'If-Modified-Since': lm}});
  assert.equal(r.status, 200, \`a stale If-None-Match with a fresh If-Modified-Since answered \${r.status}: If-None-Match is present, so If-Modified-Since is ignored (200)\`);
  r = await c.get('/docs/log', {headers: {'If-None-Match': etag, 'If-Modified-Since': date(t - 3600)}});
  assert.equal(r.status, 304, \`a matching If-None-Match with an old If-Modified-Since answered \${r.status}, not 304\`);
  r = await c.get('/docs/log', {headers: {'If-Unmodified-Since': date(t - 1)}});
  assert.equal(r.status, 412, \`If-Unmodified-Since one second before Last-Modified answered \${r.status}, not 412\`);
  r = await c.get('/docs/log', {headers: {'If-Unmodified-Since': lm}});
  assert.equal(r.status, 200, \`If-Unmodified-Since equal to Last-Modified answered \${r.status}, not 200\`);
  r = await c.get('/docs/log', {headers: {'If-Match': STALE, 'If-None-Match': etag}});
  assert.equal(r.status, 412, \`a failing If-Match with a matching If-None-Match answered \${r.status}: If-Match is evaluated first (412)\`);
  r = await c.put('/docs/log', {json: {text: 'b'}, headers: {'If-Match': etag, 'If-Unmodified-Since': date(t - 3600)}});
  assert.equal(r.status, 200, \`a matching If-Match with an old If-Unmodified-Since answered \${r.status}: If-Match is present, so If-Unmodified-Since is ignored (200)\`);
  r = await c.put('/docs/log', {json: {text: 'c'}, headers: {'If-Match': etag, 'If-Unmodified-Since': date(t + 3600)}});
  assert.equal(r.status, 412, \`a stale If-Match with a passing If-Unmodified-Since answered \${r.status}, not 412\`);
  r = await c.get('/docs/log');
  assert.deepEqual(r.json(), {text: 'b'}, \`the doc should hold 'b', got \${r.text}\`);
}

export async function check_lost_update(ctx) {
  const m = ctx.load('docs_api');
  const c = ctx.client(m.app);
  await create(c, 'plan', 'v1');
  const alice = await c.get('/docs/plan');
  const bob = await c.get('/docs/plan');
  const e1 = alice.headers['etag'];
  assert(e1 && bob.headers['etag'] === e1, 'two reads of the same doc must see the same ETag');
  const lm1 = ts(alice.headers['last-modified']);
  ctx.clock.advance(30);
  const a = await c.put('/docs/plan', {json: {text: 'alice'}, headers: {'If-Match': e1}});
  assert.equal(a.status, 200, \`Alice's PUT with the current If-Match answered \${a.status}, not 200\`);
  assert.equal(a.headers['etag'], etagOf('alice'), \`a successful write returns the new ETag \${etagOf('alice')}, got \${a.headers['etag']}\`);
  const lm2 = a.headers['last-modified'];
  const moved = lm2 ? ts(lm2) - lm1 : NaN;
  assert(moved >= 29 && moved <= 32, \`30 s later the write's Last-Modified should move 30 s: was \${alice.headers['last-modified']}, now \${lm2}\`);
  const b = await c.put('/docs/plan', {json: {text: 'bob'}, headers: {'If-Match': e1}});
  assert.equal(b.status, 412, \`Bob's PUT with the ETag Alice already replaced answered \${b.status}, not 412 (a lost update)\`);
  const now = await c.get('/docs/plan');
  assert.deepEqual(now.json(), {text: 'alice'}, \`after Bob's refused write the doc must hold Alice's text, got \${now.text}\`);
  const retry = await c.put('/docs/plan', {json: {text: 'alice + bob'}, headers: {'If-Match': now.headers['etag']}});
  assert.equal(retry.status, 200, \`Bob's retry with the fresh ETag answered \${retry.status}, not 200\`);
  let r = await c.delete('/docs/plan', {headers: {'If-Match': e1}});
  assert.equal(r.status, 412, \`DELETE with a stale If-Match answered \${r.status}, not 412\`);
  r = await c.delete('/docs/plan', {headers: {'If-Match': retry.headers['etag']}});
  assert.equal(r.status, 204, \`DELETE with the current If-Match answered \${r.status}, not 204\`);
  r = await c.get('/docs/plan');
  assert.equal(r.status, 404, \`GET after the DELETE answered \${r.status}, not 404\`);
}

export async function check_precondition_required(ctx) {
  const m = ctx.load('docs_api');
  const c = ctx.client(m.app);
  const [, lm] = await create(c, 'spec', 'draft');
  let r = await c.put('/docs/spec', {json: {text: 'blind'}});
  assert.equal(r.status, 428, \`PUT on an existing doc without If-Match answered \${r.status}, not 428\`);
  r = await c.put('/docs/spec', {json: {text: 'blind'}, headers: {'If-Unmodified-Since': lm}});
  assert.equal(r.status, 428, \`PUT with only a passing If-Unmodified-Since answered \${r.status}, not 428: If-Match is required\`);
  r = await c.put('/docs/spec', {json: {text: 'blind'}, headers: {'If-None-Match': STALE}});
  assert.equal(r.status, 428, \`PUT with only a non-matching If-None-Match answered \${r.status}, not 428\`);
  r = await c.delete('/docs/spec');
  assert.equal(r.status, 428, \`DELETE on an existing doc without If-Match answered \${r.status}, not 428\`);
  r = await c.get('/docs/spec');
  assert(r.status === 200 && r.json().text === 'draft', \`a 428 must change nothing, the doc is now \${r.status} \${r.text}\`);
  r = await c.delete('/docs/ghost', {headers: {'If-Match': STALE}});
  assert.equal(r.status, 404, \`DELETE of a missing doc answered \${r.status}, not 404\`);
  r = await c.put('/docs/fresh', {json: {text: 'new'}});
  assert.equal(r.status, 201, \`PUT on a missing doc without preconditions answered \${r.status}, not 201\`);
}

export async function check_create_only(ctx) {
  const m = ctx.load('docs_api');
  const c = ctx.client(m.app);
  let r = await c.put('/docs/notes', {json: {text: 'first'}, headers: {'If-None-Match': '*'}});
  assert.equal(r.status, 201, \`PUT with If-None-Match: * on a missing doc answered \${r.status}, not 201\`);
  assert.equal(r.headers['etag'], etagOf('first'), \`the 201 carries ETag \${etagOf('first')}, got \${r.headers['etag']}\`);
  const lm = r.headers['last-modified'];
  assert(lm && date(ts(lm)) === lm, \`the 201 carries an IMF-fixdate Last-Modified, got \${lm}\`);
  r = await c.put('/docs/notes', {json: {text: 'second'}, headers: {'If-None-Match': '*'}});
  assert.equal(r.status, 412, \`a second PUT with If-None-Match: * answered \${r.status}, not 412\`);
  r = await c.get('/docs/notes');
  assert.deepEqual(r.json(), {text: 'first'}, \`the refused create must not overwrite, the doc holds \${r.text}\`);
  r = await c.put('/docs/other', {json: {text: 'x'}, headers: {'If-Match': '*'}});
  assert.equal(r.status, 412, \`PUT with If-Match: * on a missing doc answered \${r.status}, not 412\`);
  r = await c.get('/docs/other');
  assert.equal(r.status, 404, 'If-Match: * on a missing doc must not create it');
  r = await c.put('/docs/notes', {json: {text: 'third'}, headers: {'If-Match': '*'}});
  assert.equal(r.status, 200, \`PUT with If-Match: * on an existing doc answered \${r.status}, not 200\`);
  assert.equal(r.headers['etag'], etagOf('third'), \`the 200 carries ETag \${etagOf('third')}, got \${r.headers['etag']}\`);
  r = await c.get('/docs/notes', {headers: {'If-None-Match': '*'}});
  assert.equal(r.status, 304, \`GET with If-None-Match: * on an existing doc answered \${r.status}, not 304\`);
}

export async function check_weak_strong(ctx) {
  const m = ctx.load('docs_api');
  const c = ctx.client(m.app);
  const [etag] = await create(c, 'faq', 'q');
  const weak = \`W/\${etag}\`;
  let r = await c.put('/docs/faq', {json: {text: 'x'}, headers: {'If-Match': weak}});
  assert.equal(r.status, 412, \`PUT with If-Match: \${weak} answered \${r.status}: a weak tag never matches strongly (412)\`);
  r = await c.get('/docs/faq', {headers: {'If-Match': weak}});
  assert.equal(r.status, 412, \`GET with If-Match: \${weak} answered \${r.status}, not 412\`);
  r = await c.get('/docs/faq', {headers: {'If-None-Match': weak}});
  assert.equal(r.status, 304, \`GET with If-None-Match: \${weak} answered \${r.status}: weak comparison ignores W/ (304)\`);
  r = await c.put('/docs/faq', {json: {text: 'x'}, headers: {'If-Match': etag, 'If-None-Match': weak}});
  assert.equal(r.status, 412, \`PUT whose If-None-Match matches weakly answered \${r.status}, not 412\`);
  r = await c.get('/docs/faq', {headers: {'If-Match': \`\${STALE}, \${etag}\`}});
  assert.equal(r.status, 200, \`If-Match listing the current tag second answered \${r.status}, not 200\`);
  r = await c.get('/docs/faq', {headers: {'If-None-Match': \`\${STALE}, \${weak}\`}});
  assert.equal(r.status, 304, \`If-None-Match listing the weak current tag second answered \${r.status}, not 304\`);
  r = await c.get('/docs/faq', {headers: {'If-Modified-Since': 'not a date'}});
  assert.equal(r.status, 200, \`an unparseable If-Modified-Since answered \${r.status}: it is ignored (200)\`);
  r = await c.get('/docs/faq', {headers: {'If-Unmodified-Since': 'yesterday'}});
  assert.equal(r.status, 200, \`an unparseable If-Unmodified-Since answered \${r.status}: it is ignored (200)\`);
  r = await c.put('/docs/faq', {json: {text: 'a'}, headers: {'If-Match': etag}});
  assert.equal(r.status, 200, \`PUT with the strong current tag answered \${r.status}, not 200\`);
  r = await c.get('/docs/faq');
  assert.deepEqual(r.json(), {text: 'a'}, \`the doc should hold 'a', got \${r.text}\`);
}
`,
    go: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"time"

	"leetbuild/harness"
)

const condStale = "\\"0000000000000000\\""

func condEtagOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "\\"" + hex.EncodeToString(sum[:])[:16] + "\\""
}

// condTS is the epoch seconds of an HTTP date, NaN when it does not parse.
func condTS(httpDate string) float64 {
	t, err := http.ParseTime(httpDate)
	if err != nil {
		return math.NaN()
	}
	return float64(t.Unix())
}

// condDate is epoch seconds as an IMF-fixdate.
func condDate(seconds float64) string {
	return time.Unix(int64(seconds), 0).UTC().Format(http.TimeFormat)
}

// condIMF reports whether lm is an IMF-fixdate that survives a round trip.
func condIMF(lm string) bool {
	return lm != "" && !math.IsNaN(condTS(lm)) && condDate(condTS(lm)) == lm
}

func condCreate(ctx *harness.Ctx, c *harness.HTTP, id, text string) (string, string) {
	r := c.Put("/docs/"+id, map[string]any{"text": text})
	ctx.Equal(r.Status, 201, "PUT /docs/%s on a missing doc without preconditions", id)
	ok := c.Get("/docs/" + id)
	ctx.Equal(ok.Status, 200, "GET /docs/%s after creating it", id)
	return ok.Header.Get("ETag"), ok.Header.Get("Last-Modified")
}

func CheckNotModified(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	condCreate(ctx, c, "readme", "hello")
	ok := c.Get("/docs/readme")
	ctx.Equal(ok.JSON(), map[string]any{"text": "hello"}, "GET /docs/readme")
	etag := ok.Header.Get("ETag")
	lm := ok.Header.Get("Last-Modified")
	ctx.Equal(etag, condEtagOf("hello"), "ETag must be the quoted first 16 hex digits of sha256(text)")
	ctx.Assert(condIMF(lm), "Last-Modified was %q, not an IMF-fixdate like 'Thu, 22 Oct 2026 10:00:00 GMT'", lm)
	r := c.Get("/docs/readme", "If-None-Match", etag)
	ctx.Equal(r.Status, 304, "If-None-Match with the current ETag")
	ctx.Equal(r.Text(), "", "a 304 carries no body")
	ctx.Equal(r.Header.Get("ETag"), etag, "the 304 must repeat ETag")
	ctx.Equal(r.Header.Get("Last-Modified"), lm, "the 304 must repeat Last-Modified")
	r = c.Get("/docs/readme", "If-None-Match", condStale)
	ctx.Equal(r.Status, 200, "If-None-Match with a stale tag")
	r = c.Get("/docs/readme", "If-Modified-Since", lm)
	ctx.Equal(r.Status, 304, "If-Modified-Since equal to Last-Modified")
	ctx.Assert(r.Text() == "" && r.Header.Get("ETag") == etag && r.Header.Get("Last-Modified") == lm, "the If-Modified-Since 304 must carry ETag and Last-Modified and no body")
	r = c.Get("/docs/readme", "If-Modified-Since", condDate(condTS(lm)+3600))
	ctx.Equal(r.Status, 304, "If-Modified-Since an hour after Last-Modified")
	r = c.Get("/docs/readme", "If-Modified-Since", condDate(condTS(lm)-1))
	ctx.Equal(r.Status, 200, "If-Modified-Since one second before Last-Modified")
	r = c.Get("/docs/ghost", "If-None-Match", "*")
	ctx.Equal(r.Status, 404, "GET of a missing doc with If-None-Match: *")
}

func CheckPrecedence(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	etag, lm := condCreate(ctx, c, "log", "a")
	t := condTS(lm)
	r := c.Get("/docs/log", "If-None-Match", condStale, "If-Modified-Since", lm)
	ctx.Equal(r.Status, 200, "a stale If-None-Match with a fresh If-Modified-Since (If-None-Match is present, so If-Modified-Since is ignored)")
	r = c.Get("/docs/log", "If-None-Match", etag, "If-Modified-Since", condDate(t-3600))
	ctx.Equal(r.Status, 304, "a matching If-None-Match with an old If-Modified-Since")
	r = c.Get("/docs/log", "If-Unmodified-Since", condDate(t-1))
	ctx.Equal(r.Status, 412, "If-Unmodified-Since one second before Last-Modified")
	r = c.Get("/docs/log", "If-Unmodified-Since", lm)
	ctx.Equal(r.Status, 200, "If-Unmodified-Since equal to Last-Modified")
	r = c.Get("/docs/log", "If-Match", condStale, "If-None-Match", etag)
	ctx.Equal(r.Status, 412, "a failing If-Match with a matching If-None-Match (If-Match is evaluated first)")
	r = c.Put("/docs/log", map[string]any{"text": "b"}, "If-Match", etag, "If-Unmodified-Since", condDate(t-3600))
	ctx.Equal(r.Status, 200, "a matching If-Match with an old If-Unmodified-Since (If-Match is present, so If-Unmodified-Since is ignored)")
	r = c.Put("/docs/log", map[string]any{"text": "c"}, "If-Match", etag, "If-Unmodified-Since", condDate(t+3600))
	ctx.Equal(r.Status, 412, "a stale If-Match with a passing If-Unmodified-Since")
	r = c.Get("/docs/log")
	ctx.Equal(r.JSON(), map[string]any{"text": "b"}, "the doc should hold 'b'")
}

func CheckLostUpdate(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	condCreate(ctx, c, "plan", "v1")
	alice := c.Get("/docs/plan")
	bob := c.Get("/docs/plan")
	e1 := alice.Header.Get("ETag")
	ctx.Assert(e1 != "" && bob.Header.Get("ETag") == e1, "two reads of the same doc must see the same ETag")
	lm1 := condTS(alice.Header.Get("Last-Modified"))
	ctx.Clock.Advance(30)
	a := c.Put("/docs/plan", map[string]any{"text": "alice"}, "If-Match", e1)
	ctx.Equal(a.Status, 200, "Alice's PUT with the current If-Match")
	ctx.Equal(a.Header.Get("ETag"), condEtagOf("alice"), "a successful write returns the new ETag")
	lm2 := a.Header.Get("Last-Modified")
	moved := math.NaN()
	if lm2 != "" {
		moved = condTS(lm2) - lm1
	}
	ctx.Assert(moved >= 29 && moved <= 32, "30 s later the write's Last-Modified should move 30 s: was %q, now %q", alice.Header.Get("Last-Modified"), lm2)
	b := c.Put("/docs/plan", map[string]any{"text": "bob"}, "If-Match", e1)
	ctx.Equal(b.Status, 412, "Bob's PUT with the ETag Alice already replaced (a lost update)")
	now := c.Get("/docs/plan")
	ctx.Equal(now.JSON(), map[string]any{"text": "alice"}, "after Bob's refused write the doc must hold Alice's text")
	retry := c.Put("/docs/plan", map[string]any{"text": "alice + bob"}, "If-Match", now.Header.Get("ETag"))
	ctx.Equal(retry.Status, 200, "Bob's retry with the fresh ETag")
	r := c.Delete("/docs/plan", "If-Match", e1)
	ctx.Equal(r.Status, 412, "DELETE with a stale If-Match")
	r = c.Delete("/docs/plan", "If-Match", retry.Header.Get("ETag"))
	ctx.Equal(r.Status, 204, "DELETE with the current If-Match")
	r = c.Get("/docs/plan")
	ctx.Equal(r.Status, 404, "GET after the DELETE")
}

func CheckPreconditionRequired(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	_, lm := condCreate(ctx, c, "spec", "draft")
	r := c.Put("/docs/spec", map[string]any{"text": "blind"})
	ctx.Equal(r.Status, 428, "PUT on an existing doc without If-Match")
	r = c.Put("/docs/spec", map[string]any{"text": "blind"}, "If-Unmodified-Since", lm)
	ctx.Equal(r.Status, 428, "PUT with only a passing If-Unmodified-Since (If-Match is required)")
	r = c.Put("/docs/spec", map[string]any{"text": "blind"}, "If-None-Match", condStale)
	ctx.Equal(r.Status, 428, "PUT with only a non-matching If-None-Match")
	r = c.Delete("/docs/spec")
	ctx.Equal(r.Status, 428, "DELETE on an existing doc without If-Match")
	r = c.Get("/docs/spec")
	var got struct {
		Text any \`json:"text"\`
	}
	if r.Status == 200 {
		r.Decode(&got)
	}
	ctx.Assert(r.Status == 200 && got.Text == "draft", "a 428 must change nothing, the doc is now %d %s", r.Status, r.Text())
	r = c.Delete("/docs/ghost", "If-Match", condStale)
	ctx.Equal(r.Status, 404, "DELETE of a missing doc")
	r = c.Put("/docs/fresh", map[string]any{"text": "new"})
	ctx.Equal(r.Status, 201, "PUT on a missing doc without preconditions")
}

func CheckCreateOnly(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	r := c.Put("/docs/notes", map[string]any{"text": "first"}, "If-None-Match", "*")
	ctx.Equal(r.Status, 201, "PUT with If-None-Match: * on a missing doc")
	ctx.Equal(r.Header.Get("ETag"), condEtagOf("first"), "the 201's ETag")
	lm := r.Header.Get("Last-Modified")
	ctx.Assert(condIMF(lm), "the 201 carries an IMF-fixdate Last-Modified, got %q", lm)
	r = c.Put("/docs/notes", map[string]any{"text": "second"}, "If-None-Match", "*")
	ctx.Equal(r.Status, 412, "a second PUT with If-None-Match: *")
	r = c.Get("/docs/notes")
	ctx.Equal(r.JSON(), map[string]any{"text": "first"}, "the refused create must not overwrite")
	r = c.Put("/docs/other", map[string]any{"text": "x"}, "If-Match", "*")
	ctx.Equal(r.Status, 412, "PUT with If-Match: * on a missing doc")
	r = c.Get("/docs/other")
	ctx.Equal(r.Status, 404, "If-Match: * on a missing doc must not create it")
	r = c.Put("/docs/notes", map[string]any{"text": "third"}, "If-Match", "*")
	ctx.Equal(r.Status, 200, "PUT with If-Match: * on an existing doc")
	ctx.Equal(r.Header.Get("ETag"), condEtagOf("third"), "the 200's ETag")
	r = c.Get("/docs/notes", "If-None-Match", "*")
	ctx.Equal(r.Status, 304, "GET with If-None-Match: * on an existing doc")
}

func CheckWeakStrong(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	etag, _ := condCreate(ctx, c, "faq", "q")
	weak := "W/" + etag
	r := c.Put("/docs/faq", map[string]any{"text": "x"}, "If-Match", weak)
	ctx.Equal(r.Status, 412, "PUT with If-Match: %s (a weak tag never matches strongly)", weak)
	r = c.Get("/docs/faq", "If-Match", weak)
	ctx.Equal(r.Status, 412, "GET with If-Match: %s", weak)
	r = c.Get("/docs/faq", "If-None-Match", weak)
	ctx.Equal(r.Status, 304, "GET with If-None-Match: %s (weak comparison ignores W/)", weak)
	r = c.Put("/docs/faq", map[string]any{"text": "x"}, "If-Match", etag, "If-None-Match", weak)
	ctx.Equal(r.Status, 412, "PUT whose If-None-Match matches weakly")
	r = c.Get("/docs/faq", "If-Match", condStale+", "+etag)
	ctx.Equal(r.Status, 200, "If-Match listing the current tag second")
	r = c.Get("/docs/faq", "If-None-Match", condStale+", "+weak)
	ctx.Equal(r.Status, 304, "If-None-Match listing the weak current tag second")
	r = c.Get("/docs/faq", "If-Modified-Since", "not a date")
	ctx.Equal(r.Status, 200, "an unparseable If-Modified-Since (it is ignored)")
	r = c.Get("/docs/faq", "If-Unmodified-Since", "yesterday")
	ctx.Equal(r.Status, 200, "an unparseable If-Unmodified-Since (it is ignored)")
	r = c.Put("/docs/faq", map[string]any{"text": "a"}, "If-Match", etag)
	ctx.Equal(r.Status, 200, "PUT with the strong current tag")
	r = c.Get("/docs/faq")
	ctx.Equal(r.JSON(), map[string]any{"text": "a"}, "the doc should hold 'a'")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <map>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "sha256.h"

namespace {

const std::string condStale = R"("0000000000000000")";

std::map<std::string, std::string> condText(const std::string& text) { return {{"text", text}}; }

std::string condBody(const std::string& text) { return nlohmann::json{{"text", text}}.dump(); }

std::string condEtagOf(const std::string& text) { return "\\"" + sha256_hex(text).substr(0, 16) + "\\""; }

// condTS is the epoch seconds of an HTTP date, NaN when it does not parse.
double condTS(const std::string& httpDate) {
  static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  char wday[4] = {}, mon[4] = {};
  int day = 0, year = 0, h = 0, m = 0, s = 0, used = 0;
  if (std::sscanf(httpDate.c_str(), "%3[A-Za-z], %d %3[A-Za-z] %d %d:%d:%d GMT%n", wday, &day, mon, &year, &h, &m, &s,
                  &used) != 7 ||
      used != static_cast<int>(httpDate.size()))
    return std::nan("");
  int month = -1;
  for (int i = 0; i < 12; i++)
    if (std::strcmp(mon, months[i]) == 0) month = i;
  if (month < 0) return std::nan("");
  std::tm tm{};
  tm.tm_year = year - 1900;
  tm.tm_mon = month;
  tm.tm_mday = day;
  tm.tm_hour = h;
  tm.tm_min = m;
  tm.tm_sec = s;
  return static_cast<double>(timegm(&tm));
}

// condDate is epoch seconds as an IMF-fixdate.
std::string condDate(double seconds) {
  std::time_t t = static_cast<std::time_t>(seconds);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[64];
  std::strftime(buf, sizeof buf, "%a, %d %b %Y %H:%M:%S GMT", &tm);
  return buf;
}

// condIMF reports whether lm is an IMF-fixdate that survives a round trip.
bool condIMF(const std::string& lm) { return !lm.empty() && !std::isnan(condTS(lm)) && condDate(condTS(lm)) == lm; }

std::pair<std::string, std::string> condCreate(harness::Ctx& ctx, harness::HTTP& c, const std::string& id,
                                               const std::string& text) {
  auto r = c.Put("/docs/" + id, condBody(text));
  ctx.Equal(r.Status, 201, "PUT /docs/%s on a missing doc without preconditions", id);
  auto ok = c.Get("/docs/" + id);
  ctx.Equal(ok.Status, 200, "GET /docs/%s after creating it", id);
  return {ok.HeaderValue("ETag"), ok.HeaderValue("Last-Modified")};
}

}  // namespace

void CheckNotModified(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  condCreate(ctx, c, "readme", "hello");
  auto ok = c.Get("/docs/readme");
  ctx.Equal(ok.JSON(), condText("hello"), "GET /docs/readme");
  const std::string etag = ok.HeaderValue("ETag");
  const std::string lm = ok.HeaderValue("Last-Modified");
  ctx.Equal(etag, condEtagOf("hello"), "ETag must be the quoted first 16 hex digits of sha256(text)");
  ctx.Assert(condIMF(lm), "Last-Modified was %q, not an IMF-fixdate like 'Thu, 22 Oct 2026 10:00:00 GMT'", lm);
  auto r = c.Get("/docs/readme", "If-None-Match", etag);
  ctx.Equal(r.Status, 304, "If-None-Match with the current ETag");
  ctx.Equal(r.Text(), "", "a 304 carries no body");
  ctx.Equal(r.HeaderValue("ETag"), etag, "the 304 must repeat ETag");
  ctx.Equal(r.HeaderValue("Last-Modified"), lm, "the 304 must repeat Last-Modified");
  r = c.Get("/docs/readme", "If-None-Match", condStale);
  ctx.Equal(r.Status, 200, "If-None-Match with a stale tag");
  r = c.Get("/docs/readme", "If-Modified-Since", lm);
  ctx.Equal(r.Status, 304, "If-Modified-Since equal to Last-Modified");
  ctx.Assert(r.Text() == "" && r.HeaderValue("ETag") == etag && r.HeaderValue("Last-Modified") == lm,
             "the If-Modified-Since 304 must carry ETag and Last-Modified and no body");
  r = c.Get("/docs/readme", "If-Modified-Since", condDate(condTS(lm) + 3600));
  ctx.Equal(r.Status, 304, "If-Modified-Since an hour after Last-Modified");
  r = c.Get("/docs/readme", "If-Modified-Since", condDate(condTS(lm) - 1));
  ctx.Equal(r.Status, 200, "If-Modified-Since one second before Last-Modified");
  r = c.Get("/docs/ghost", "If-None-Match", "*");
  ctx.Equal(r.Status, 404, "GET of a missing doc with If-None-Match: *");
}

void CheckPrecedence(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const auto [etag, lm] = condCreate(ctx, c, "log", "a");
  const double t = condTS(lm);
  auto r = c.Get("/docs/log", "If-None-Match", condStale, "If-Modified-Since", lm);
  ctx.Equal(r.Status, 200, "a stale If-None-Match with a fresh If-Modified-Since (If-None-Match is present, so If-Modified-Since is ignored)");
  r = c.Get("/docs/log", "If-None-Match", etag, "If-Modified-Since", condDate(t - 3600));
  ctx.Equal(r.Status, 304, "a matching If-None-Match with an old If-Modified-Since");
  r = c.Get("/docs/log", "If-Unmodified-Since", condDate(t - 1));
  ctx.Equal(r.Status, 412, "If-Unmodified-Since one second before Last-Modified");
  r = c.Get("/docs/log", "If-Unmodified-Since", lm);
  ctx.Equal(r.Status, 200, "If-Unmodified-Since equal to Last-Modified");
  r = c.Get("/docs/log", "If-Match", condStale, "If-None-Match", etag);
  ctx.Equal(r.Status, 412, "a failing If-Match with a matching If-None-Match (If-Match is evaluated first)");
  r = c.Put("/docs/log", condBody("b"), "If-Match", etag, "If-Unmodified-Since", condDate(t - 3600));
  ctx.Equal(r.Status, 200, "a matching If-Match with an old If-Unmodified-Since (If-Match is present, so If-Unmodified-Since is ignored)");
  r = c.Put("/docs/log", condBody("c"), "If-Match", etag, "If-Unmodified-Since", condDate(t + 3600));
  ctx.Equal(r.Status, 412, "a stale If-Match with a passing If-Unmodified-Since");
  r = c.Get("/docs/log");
  ctx.Equal(r.JSON(), condText("b"), "the doc should hold 'b'");
}

void CheckLostUpdate(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  condCreate(ctx, c, "plan", "v1");
  auto alice = c.Get("/docs/plan");
  auto bob = c.Get("/docs/plan");
  const std::string e1 = alice.HeaderValue("ETag");
  ctx.Assert(e1 != "" && bob.HeaderValue("ETag") == e1, "two reads of the same doc must see the same ETag");
  const double lm1 = condTS(alice.HeaderValue("Last-Modified"));
  ctx.Clock.Advance(30);
  auto a = c.Put("/docs/plan", condBody("alice"), "If-Match", e1);
  ctx.Equal(a.Status, 200, "Alice's PUT with the current If-Match");
  ctx.Equal(a.HeaderValue("ETag"), condEtagOf("alice"), "a successful write returns the new ETag");
  const std::string lm2 = a.HeaderValue("Last-Modified");
  double moved = std::nan("");
  if (lm2 != "") moved = condTS(lm2) - lm1;
  ctx.Assert(moved >= 29 && moved <= 32, "30 s later the write's Last-Modified should move 30 s: was %q, now %q",
             alice.HeaderValue("Last-Modified"), lm2);
  auto b = c.Put("/docs/plan", condBody("bob"), "If-Match", e1);
  ctx.Equal(b.Status, 412, "Bob's PUT with the ETag Alice already replaced (a lost update)");
  auto now = c.Get("/docs/plan");
  ctx.Equal(now.JSON(), condText("alice"), "after Bob's refused write the doc must hold Alice's text");
  auto retry = c.Put("/docs/plan", condBody("alice + bob"), "If-Match", now.HeaderValue("ETag"));
  ctx.Equal(retry.Status, 200, "Bob's retry with the fresh ETag");
  auto r = c.Delete("/docs/plan", "If-Match", e1);
  ctx.Equal(r.Status, 412, "DELETE with a stale If-Match");
  r = c.Delete("/docs/plan", "If-Match", retry.HeaderValue("ETag"));
  ctx.Equal(r.Status, 204, "DELETE with the current If-Match");
  r = c.Get("/docs/plan");
  ctx.Equal(r.Status, 404, "GET after the DELETE");
}

void CheckPreconditionRequired(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::string lm = condCreate(ctx, c, "spec", "draft").second;
  auto r = c.Put("/docs/spec", condBody("blind"));
  ctx.Equal(r.Status, 428, "PUT on an existing doc without If-Match");
  r = c.Put("/docs/spec", condBody("blind"), "If-Unmodified-Since", lm);
  ctx.Equal(r.Status, 428, "PUT with only a passing If-Unmodified-Since (If-Match is required)");
  r = c.Put("/docs/spec", condBody("blind"), "If-None-Match", condStale);
  ctx.Equal(r.Status, 428, "PUT with only a non-matching If-None-Match");
  r = c.Delete("/docs/spec");
  ctx.Equal(r.Status, 428, "DELETE on an existing doc without If-Match");
  r = c.Get("/docs/spec");
  bool draft = false;
  if (r.Status == 200) {
    const auto got = nlohmann::json::parse(r.Text(), nullptr, false);
    draft = got.is_object() && got.contains("text") && got["text"] == "draft";
  }
  ctx.Assert(r.Status == 200 && draft, "a 428 must change nothing, the doc is now %d %s", r.Status, r.Text());
  r = c.Delete("/docs/ghost", "If-Match", condStale);
  ctx.Equal(r.Status, 404, "DELETE of a missing doc");
  r = c.Put("/docs/fresh", condBody("new"));
  ctx.Equal(r.Status, 201, "PUT on a missing doc without preconditions");
}

void CheckCreateOnly(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  auto r = c.Put("/docs/notes", condBody("first"), "If-None-Match", "*");
  ctx.Equal(r.Status, 201, "PUT with If-None-Match: * on a missing doc");
  ctx.Equal(r.HeaderValue("ETag"), condEtagOf("first"), "the 201's ETag");
  const std::string lm = r.HeaderValue("Last-Modified");
  ctx.Assert(condIMF(lm), "the 201 carries an IMF-fixdate Last-Modified, got %q", lm);
  r = c.Put("/docs/notes", condBody("second"), "If-None-Match", "*");
  ctx.Equal(r.Status, 412, "a second PUT with If-None-Match: *");
  r = c.Get("/docs/notes");
  ctx.Equal(r.JSON(), condText("first"), "the refused create must not overwrite");
  r = c.Put("/docs/other", condBody("x"), "If-Match", "*");
  ctx.Equal(r.Status, 412, "PUT with If-Match: * on a missing doc");
  r = c.Get("/docs/other");
  ctx.Equal(r.Status, 404, "If-Match: * on a missing doc must not create it");
  r = c.Put("/docs/notes", condBody("third"), "If-Match", "*");
  ctx.Equal(r.Status, 200, "PUT with If-Match: * on an existing doc");
  ctx.Equal(r.HeaderValue("ETag"), condEtagOf("third"), "the 200's ETag");
  r = c.Get("/docs/notes", "If-None-Match", "*");
  ctx.Equal(r.Status, 304, "GET with If-None-Match: * on an existing doc");
}

void CheckWeakStrong(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::string etag = condCreate(ctx, c, "faq", "q").first;
  const std::string weak = "W/" + etag;
  auto r = c.Put("/docs/faq", condBody("x"), "If-Match", weak);
  ctx.Equal(r.Status, 412, "PUT with If-Match: %s (a weak tag never matches strongly)", weak);
  r = c.Get("/docs/faq", "If-Match", weak);
  ctx.Equal(r.Status, 412, "GET with If-Match: %s", weak);
  r = c.Get("/docs/faq", "If-None-Match", weak);
  ctx.Equal(r.Status, 304, "GET with If-None-Match: %s (weak comparison ignores W/)", weak);
  r = c.Put("/docs/faq", condBody("x"), "If-Match", etag, "If-None-Match", weak);
  ctx.Equal(r.Status, 412, "PUT whose If-None-Match matches weakly");
  r = c.Get("/docs/faq", "If-Match", condStale + ", " + etag);
  ctx.Equal(r.Status, 200, "If-Match listing the current tag second");
  r = c.Get("/docs/faq", "If-None-Match", condStale + ", " + weak);
  ctx.Equal(r.Status, 304, "If-None-Match listing the weak current tag second");
  r = c.Get("/docs/faq", "If-Modified-Since", "not a date");
  ctx.Equal(r.Status, 200, "an unparseable If-Modified-Since (it is ignored)");
  r = c.Get("/docs/faq", "If-Unmodified-Since", "yesterday");
  ctx.Equal(r.Status, 200, "an unparseable If-Unmodified-Since (it is ignored)");
  r = c.Put("/docs/faq", condBody("a"), "If-Match", etag);
  ctx.Equal(r.Status, 200, "PUT with the strong current tag");
  r = c.Get("/docs/faq");
  ctx.Equal(r.JSON(), condText("a"), "the doc should hold 'a'");
}
`,
  },
};
