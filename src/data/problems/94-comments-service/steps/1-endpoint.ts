import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/comments: replies that stay in their thread',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/comments\` with body
\`{"thread_id", "parent_id", "author_id", "text"}\`: it reads the tenant from \`X-Tenant-Id\` (401
without one), takes a new comment from \`store.new_comment\` with \`html = render_html(text)\`,
writes it with \`store.insert\` and answers **201** with the comment. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A client that retries after a timeout posts the comment twice;
a 2 MB paste is stored whole; a reply naming a parent from another thread lands in this one; and a
\`<script>\` in a comment reaches every reader's page through \`html\`.

- \`Idempotency-Key\` is required (**400** without it). Look the \`(tenant, key)\` up with
  \`store.by_key\` before writing: a retry answers **200** with the comment the first attempt made.
  After the insert, \`store.remember_key\`.
- \`text\` is at most \`MAX_TEXT_BYTES = 16 * 1024\` bytes of UTF-8 (bytes, not characters):
  longer is **413**, and nothing is written.
- A \`parent_id\` must name a comment of this tenant **in the same thread** (\`store.get\`):
  otherwise **422**.
- \`render_html\` escapes the whole text, then turns back on only \`ALLOWED_TAGS\` (\`b\`, \`i\`,
  \`code\`) and line breaks (\`<br>\`). \`text\` stays as written.`,
  sequence: {
    participants: ['Client', 'Comments API', 'comment store'],
    messages: [
      {from: 'Client', to: 'Comments API', label: 'POST /v1/comments · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Comments API', to: 'comment store', label: 'by_key(tenant, key)', kind: 'sync'},
      {from: 'comment store', to: 'Comments API', label: 'the first attempt’s comment → 200', kind: 'reply'},
      {from: 'Comments API', to: 'Comments API', label: 'text ≤ MAX_TEXT_BYTES · else 413', kind: 'sync'},
      {
        from: 'Comments API',
        to: 'comment store',
        label: 'get(tenant, parent_id) · same thread · else 422',
        kind: 'sync',
      },
      {
        from: 'Comments API',
        to: 'comment store',
        label: 'insert(new_comment(…, render_html(text))) · remember_key',
        kind: 'sync',
      },
      {from: 'Comments API', to: 'Client', label: '201 {id, thread_id, parent_id, text, html, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/comments',
      detail: 'A comment posted with a tenant and a key answers 201 with its id and is stored under its thread.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/comments["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/comments['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/comments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"comments"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/comments"/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'A retried POST answers the first comment',
      detail:
        'The `Idempotency-Key` is required (400 without it) and looked up per tenant before anything is written; a retry answers 200 with the first comment, and a new comment records its key. The starter ignores the header, so every retry is a second comment.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.by_key\(/, /store\.remember_key\(/, /\b400\b/],
          order: [/store\.by_key\(/, /store\.insert\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /byKey\(/, /rememberKey\(/, /\b400\b/],
          order: [/byKey\(/, /\binsert\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.ByKey\(/, /store\.RememberKey\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.ByKey\(/, /store\.Insert\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.byKey\(/, /Store\.rememberKey\(/, /BadRequest|\b400\b/],
          order: [/Store\.byKey\(/, /Store\.insert\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::byKey\(/, /store::rememberKey\(/, /\b400\b/],
          order: [/store::byKey\(/, /store::insert\(/],
        },
      },
    },
    {
      id: 'body-cap',
      title: 'Caps the text at 16 KiB of UTF-8',
      detail:
        'A text over `MAX_TEXT_BYTES` (16 × 1024) bytes answers 413 and writes nothing; the cap counts encoded bytes, so 8,193 two-byte characters are over it. The starter stores any size.',
      match: {
        python: {all: [/MAX_TEXT_BYTES\s*=\s*(16\s*\*\s*1024|16384)/, /\b413\b/, /\.encode\(/]},
        typescript: {
          all: [/MAX_TEXT_BYTES\s*=\s*(16\s*\*\s*1024|16384)/, /\b413\b/, /Buffer\.byteLength\(|TextEncoder/],
        },
        go: {
          all: [
            /maxTextBytes\s*=\s*(16\s*\*\s*1024|16384)/,
            /StatusRequestEntityTooLarge|\b413\b/,
            /len\(\s*body\.Text\s*\)/,
          ],
        },
        scala: {
          all: [
            /MaxTextBytes(:\s*Int)?\s*=\s*(16\s*\*\s*1024|16384)/,
            /PayloadTooLarge|RequestEntityTooLarge|\b413\b/,
            /getBytes\(/,
          ],
        },
        cpp: {all: [/kMaxTextBytes\s*=\s*(16\s*\*\s*1024|16384)/, /\b413\b/, /text\.size\(\)|text\.length\(\)/]},
      },
    },
    {
      id: 'parent-thread',
      title: 'A reply’s parent must be in the same thread',
      detail:
        'The parent is loaded with the tenant’s `store.get` and its `thread_id` compared with the request’s; a missing parent, another tenant’s, or one in another thread answers 422. The starter writes whatever `parent_id` it is sent.',
      match: {
        python: {all: [/store\.get\(/, /\["thread_id"\]\s*!=|!=\s*\w+\["thread_id"\]/, /\b422\b/]},
        typescript: {all: [/\bget\(\s*tenant/, /\.thread_id\s*!==|!==\s*\w+\.thread_id/, /\b422\b/]},
        go: {all: [/store\.Get\(/, /\.ThreadID\s*!=/, /StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/Store\.get\(/, /\.threadId\s*!=|!=\s*\w+\.threadId/, /UnprocessableEntity|\b422\b/]},
        cpp: {all: [/store::get\(/, /thread_id\s*!=/, /\b422\b/]},
      },
    },
    {
      id: 'safe-render',
      title: 'Renders html from escaped text and a safe tag list',
      detail:
        '`render_html` escapes every `<`, `>`, `&` and quote, then turns back on only `ALLOWED_TAGS` and line breaks, so a `<script>` or an `onerror` attribute arrives as text. The starter only turns newlines into `<br>`.',
      match: {
        python: {all: [/html\.escape\(/, /ALLOWED_TAGS/]},
        typescript: {all: [/ALLOWED_TAGS/, /&lt;/, /&amp;/]},
        go: {all: [/html\.EscapeString\(/, /allowedTags/]},
        scala: {all: [/AllowedTags/, /&lt;/, /&amp;/]},
        cpp: {all: [/kAllowedTags/, /&lt;/, /&amp;/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from comments import store  # new_comment, insert, get, by_key, remember_key

app = FastAPI()


class CommentIn(BaseModel):
    thread_id: str = ""
    parent_id: str | None = None
    author_id: str = ""
    text: str = ""


def render_html(text: str) -> str:
    """The comment as a page shows it: line breaks become <br>."""
    return text.replace("\\n", "<br>")


@app.post("/v1/comments")
def create_comment(body: CommentIn, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    if not body.thread_id or not body.text:
        return JSONResponse({"error": "thread_id and text are required"}, status_code=400)
    comment = store.new_comment(body.thread_id, body.parent_id or "", body.author_id, body.text, render_html(body.text))
    store.insert(tenant, comment)
    return JSONResponse(comment, status_code=201)
`,
      solution: `import html

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from comments import store  # new_comment, insert, get, by_key, remember_key

app = FastAPI()

MAX_TEXT_BYTES = 16 * 1024
ALLOWED_TAGS = ("b", "i", "code")


class CommentIn(BaseModel):
    thread_id: str = ""
    parent_id: str | None = None
    author_id: str = ""
    text: str = ""


def render_html(text: str) -> str:
    """The comment as a page shows it: everything escaped, then the safe tags and line breaks back."""
    out = html.escape(text)
    for tag in ALLOWED_TAGS:
        out = out.replace(f"&lt;{tag}&gt;", f"<{tag}>").replace(f"&lt;/{tag}&gt;", f"</{tag}>")
    return out.replace("\\n", "<br>")


@app.post("/v1/comments")
def create_comment(body: CommentIn, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    key = request.headers.get("idempotency-key", "")
    if not key:
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    first = store.by_key(tenant, key)
    if first is not None:
        return JSONResponse(first, status_code=200)  # a retry answers the comment the first attempt made
    if not body.thread_id or not body.text:
        return JSONResponse({"error": "thread_id and text are required"}, status_code=400)
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        return JSONResponse({"error": f"text is over {MAX_TEXT_BYTES} bytes"}, status_code=413)
    parent_id = body.parent_id or ""
    if parent_id:
        parent = store.get(tenant, parent_id)
        if parent is None or parent["thread_id"] != body.thread_id:
            return JSONResponse({"error": "parent_id is not a comment of this thread"}, status_code=422)
    comment = store.new_comment(body.thread_id, parent_id, body.author_id, body.text, render_html(body.text))
    store.insert(tenant, comment)
    store.remember_key(tenant, key, comment["id"])
    return JSONResponse(comment, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {byKey, get, insert, newComment, rememberKey} from 'comments/store';

export const app = Fastify();

interface CommentIn {
  thread_id?: string;
  parent_id?: string | null;
  author_id?: string;
  text?: string;
}

/** The comment as a page shows it: line breaks become <br>. */
export function renderHtml(text: string): string {
  return text.replace(/\\n/g, '<br>');
}

app.post('/v1/comments', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as CommentIn;
  if (!body.thread_id || !body.text) return reply.code(400).send({error: 'thread_id and text are required'});
  const comment = await newComment(body.thread_id, body.parent_id ?? '', body.author_id ?? '', body.text, renderHtml(body.text));
  await insert(tenant, comment);
  return reply.code(201).send(comment);
});
`,
      solution: `import Fastify from 'fastify';

import {byKey, get, insert, newComment, rememberKey} from 'comments/store';

export const app = Fastify();

export const MAX_TEXT_BYTES = 16 * 1024;
export const ALLOWED_TAGS = ['b', 'i', 'code'];

interface CommentIn {
  thread_id?: string;
  parent_id?: string | null;
  author_id?: string;
  text?: string;
}

const ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'};

/** The comment as a page shows it: everything escaped, then the safe tags and line breaks back. */
export function renderHtml(text: string): string {
  let out = text.replace(/[&<>"']/g, ch => ESCAPES[ch]);
  for (const tag of ALLOWED_TAGS) out = out.replaceAll(\`&lt;\${tag}&gt;\`, \`<\${tag}>\`).replaceAll(\`&lt;/\${tag}&gt;\`, \`</\${tag}>\`);
  return out.replace(/\\n/g, '<br>');
}

app.post('/v1/comments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const first = await byKey(tenant, key);
  if (first !== null) return reply.code(200).send(first); // a retry answers the comment the first attempt made
  const body = (request.body ?? {}) as CommentIn;
  if (!body.thread_id || !body.text) return reply.code(400).send({error: 'thread_id and text are required'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) return reply.code(413).send({error: \`text is over \${MAX_TEXT_BYTES} bytes\`});
  const parentId = body.parent_id ?? '';
  if (parentId !== '') {
    const parent = await get(tenant, parentId);
    if (parent === null || parent.thread_id !== body.thread_id) return reply.code(422).send({error: 'parent_id is not a comment of this thread'});
  }
  const comment = await newComment(body.thread_id, parentId, body.author_id ?? '', body.text, renderHtml(body.text));
  await insert(tenant, comment);
  await rememberKey(tenant, key, comment.id);
  return reply.code(201).send(comment);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"comments/store" // store.NewComment, Insert, Get, ByKey, RememberKey
)

type commentIn struct {
	ThreadID string \`json:"thread_id"\`
	ParentID string \`json:"parent_id"\`
	AuthorID string \`json:"author_id"\`
	Text     string \`json:"text"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// renderHTML is the comment as a page shows it: line breaks become <br>.
func renderHTML(text string) string {
	return strings.ReplaceAll(text, "\\n", "<br>")
}

func createComment(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body commentIn
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ThreadID == "" || body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "thread_id and text are required"})
		return
	}
	c, err := store.NewComment(r.Context(), body.ThreadID, body.ParentID, body.AuthorID, body.Text, renderHTML(body.Text))
	if err == nil {
		err = store.Insert(r.Context(), tenant, c)
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, c)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/comments", createComment)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"strings"

	"comments/store" // store.NewComment, Insert, Get, ByKey, RememberKey
)

const maxTextBytes = 16 * 1024

var allowedTags = []string{"b", "i", "code"}

type commentIn struct {
	ThreadID string \`json:"thread_id"\`
	ParentID string \`json:"parent_id"\`
	AuthorID string \`json:"author_id"\`
	Text     string \`json:"text"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// renderHTML is the comment as a page shows it: everything escaped, then the safe tags and line breaks back.
func renderHTML(text string) string {
	out := html.EscapeString(text)
	for _, tag := range allowedTags {
		out = strings.ReplaceAll(out, "&lt;"+tag+"&gt;", "<"+tag+">")
		out = strings.ReplaceAll(out, "&lt;/"+tag+"&gt;", "</"+tag+">")
	}
	return strings.ReplaceAll(out, "\\n", "<br>")
}

func createComment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if first := store.ByKey(r.Context(), tenant, key); first != nil {
		writeJSON(rw, http.StatusOK, first) // a retry answers the comment the first attempt made
		return
	}
	var body commentIn
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ThreadID == "" || body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "thread_id and text are required"})
		return
	}
	if len(body.Text) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("text is over %d bytes", maxTextBytes)})
		return
	}
	if body.ParentID != "" {
		parent := store.Get(r.Context(), tenant, body.ParentID)
		if parent == nil || parent.ThreadID != body.ThreadID {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "parent_id is not a comment of this thread"})
			return
		}
	}
	c, err := store.NewComment(r.Context(), body.ThreadID, body.ParentID, body.AuthorID, body.Text, renderHTML(body.Text))
	if err == nil {
		err = store.Insert(r.Context(), tenant, c)
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	store.RememberKey(r.Context(), tenant, key, c.ID)
	writeJSON(rw, http.StatusCreated, c)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/comments", createComment)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import comments.Store // Store.newComment, insert, get, byKey, rememberKey

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def field(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  /** The comment as a page shows it: line breaks become <br>. */
  def renderHtml(text: String): String = text.replace("\\n", "<br>")

  val route: Route =
    path("v1" / "comments") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val tenant = tenantHeader.getOrElse("")
            val body = raw.parseJson.asJsObject
            val (threadId, text) = (field(body, "thread_id"), field(body, "text"))
            if (tenant.isEmpty) complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            else if (threadId.isEmpty || text.isEmpty) complete(error(StatusCodes.BadRequest, "thread_id and text are required"))
            else {
              val comment = Store.newComment(threadId, field(body, "parent_id"), field(body, "author_id"), text, renderHtml(text))
              Store.insert(tenant, comment)
              complete(json(StatusCodes.Created, Store.toJson(comment)))
            }
          }
        }
      }
    }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import comments.Store // Store.newComment, insert, get, byKey, rememberKey

object Api {
  val MaxTextBytes: Int = 16 * 1024
  val AllowedTags: Seq[String] = Seq("b", "i", "code")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def field(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  /** The comment as a page shows it: everything escaped, then the safe tags and line breaks back. */
  def renderHtml(text: String): String = {
    val escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\"", "&quot;").replace("'", "&#x27;")
    val tagged = AllowedTags.foldLeft(escaped)((out, tag) => out.replace(s"&lt;$tag&gt;", s"<$tag>").replace(s"&lt;/$tag&gt;", s"</$tag>"))
    tagged.replace("\\n", "<br>")
  }

  /** Why a reply cannot hang off parentId in this thread, if it cannot. */
  private def parentProblem(tenant: String, threadId: String, parentId: String): Option[String] =
    if (parentId.isEmpty) None
    else Store.get(tenant, parentId) match {
      case Some(parent) if parent.threadId == threadId => None
      case Some(parent) if parent.threadId != threadId => Some("parent_id is in another thread")
      case _ => Some("parent_id is not a comment of this tenant")
    }

  val route: Route =
    path("v1" / "comments") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
            entity(as[String]) { raw =>
              val tenant = tenantHeader.getOrElse("")
              val key = keyHeader.getOrElse("")
              val body = raw.parseJson.asJsObject
              val (threadId, parentId, text) = (field(body, "thread_id"), field(body, "parent_id"), field(body, "text"))
              lazy val first = Store.byKey(tenant, key)
              if (tenant.isEmpty) complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
              else if (key.isEmpty) complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
              else if (first.isDefined) complete(json(StatusCodes.OK, Store.toJson(first.get))) // a retry answers the comment the first attempt made
              else if (threadId.isEmpty || text.isEmpty) complete(error(StatusCodes.BadRequest, "thread_id and text are required"))
              else if (text.getBytes(UTF_8).length > MaxTextBytes) complete(error(StatusCodes.PayloadTooLarge, s"text is over $MaxTextBytes bytes"))
              else parentProblem(tenant, threadId, parentId) match {
                case Some(problem) => complete(error(StatusCodes.UnprocessableEntity, problem))
                case None =>
                  val comment = Store.newComment(threadId, parentId, field(body, "author_id"), text, renderHtml(text))
                  Store.insert(tenant, comment)
                  Store.rememberKey(tenant, key, comment.id)
                  complete(json(StatusCodes.Created, Store.toJson(comment)))
              }
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

#include <string>

#include "comments/store.h"  // store::newComment, insert, get, byKey, rememberKey

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string field(const json& body, const char* name) {
  return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
  for (size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
  return s;
}

// The comment as a page shows it: line breaks become <br>.
std::string renderHtml(const std::string& text) { return replaceAll(text, "\\n", "<br>"); }

void create_comment(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const std::string thread_id = field(body, "thread_id");
  const std::string text = field(body, "text");
  if (thread_id.empty() || text.empty()) return reply(res, 400, {{"error", "thread_id and text are required"}});
  const store::Comment comment = store::newComment(thread_id, field(body, "parent_id"), field(body, "author_id"), text, renderHtml(text));
  store::insert(tenant, comment);
  reply(res, 201, store::toJson(comment));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/comments", create_comment);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "comments/store.h"  // store::newComment, insert, get, byKey, rememberKey

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 16 * 1024;
const std::vector<std::string> kAllowedTags = {"b", "i", "code"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string field(const json& body, const char* name) {
  return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
  for (size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
  return s;
}

// The comment as a page shows it: everything escaped, then the safe tags and line breaks back.
std::string renderHtml(const std::string& text) {
  std::string out;
  for (const char ch : text) {
    switch (ch) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\\'': out += "&#x27;"; break;
      default: out += ch;
    }
  }
  for (const std::string& tag : kAllowedTags) {
    out = replaceAll(out, "&lt;" + tag + "&gt;", "<" + tag + ">");
    out = replaceAll(out, "&lt;/" + tag + "&gt;", "</" + tag + ">");
  }
  return replaceAll(out, "\\n", "<br>");
}

void create_comment(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, {{"error", "Idempotency-Key is required"}});
  if (const auto first = store::byKey(tenant, key)) return reply(res, 200, store::toJson(*first));  // a retry answers the comment the first attempt made
  const json body = json::parse(req.body, nullptr, false);
  const std::string thread_id = field(body, "thread_id");
  const std::string parent_id = field(body, "parent_id");
  const std::string text = field(body, "text");
  if (thread_id.empty() || text.empty()) return reply(res, 400, {{"error", "thread_id and text are required"}});
  if (text.size() > kMaxTextBytes) return reply(res, 413, {{"error", "text is over " + std::to_string(kMaxTextBytes) + " bytes"}});
  if (!parent_id.empty()) {
    const auto parent = store::get(tenant, parent_id);
    if (!parent || parent->thread_id != thread_id) return reply(res, 422, {{"error", "parent_id is not a comment of this thread"}});
  }
  const store::Comment comment = store::newComment(thread_id, parent_id, field(body, "author_id"), text, renderHtml(text));
  store::insert(tenant, comment);
  store::rememberKey(tenant, key, comment.id);
  reply(res, 201, store::toJson(comment));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/comments", create_comment);
}
`,
    },
  },
  harness: {
    python: `from comments import store

SCRIPT = 'Nice <b>point</b>\\n<script>alert(1)</script><img src=x onerror="alert(2)">'


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, key, tenant="acme", **fields):
    headers = {"X-Tenant-Id": tenant}
    if key is not None:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/comments", json={"thread_id": "t-1", "author_id": "u-1", "text": "First!", **fields}, headers=headers)


def _created(r, what):
    assert r.status_code == 201, f"{what} answered {r.status_code}, expected 201: {r.text}"
    return r.json()


async def check_route(ctx):
    async with _api(ctx) as c:
        body = _created(await _post(c, "k-1"), "POST /v1/comments with a tenant and a key")
    assert body.get("id") and body.get("thread_id") == "t-1", f"the 201 must carry the comment's id and thread_id, got {body}"
    stored = store.get("acme", body["id"])
    assert stored is not None and stored["text"] == "First!", f"the comment {body['id']} is not in the store: {stored}"
    assert store.indexed_count("acme", "t-1") == 1, f"thread t-1 indexes {store.indexed_count('acme', 't-1')} comments after one POST"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        first = _created(await _post(c, "k-1"), "the first POST")
        retry = await _post(c, "k-1")
        assert retry.status_code == 200 and retry.json().get("id") == first["id"], f"a retry with the same Idempotency-Key answered {retry.status_code} {retry.text}, expected 200 with comment {first['id']}"
        assert store.indexed_count("acme", "t-1") == 1, f"one comment retried once left {store.indexed_count('acme', 't-1')} comments in thread t-1"
        other = _created(await _post(c, "k-1", tenant="globex"), "another tenant's POST with the same key")
        assert other["id"] != first["id"], "keys are per tenant: globex's k-1 must create its own comment"
        missing = await _post(c, None)
    assert missing.status_code == 400, f"a POST without Idempotency-Key answered {missing.status_code}, expected 400"
    assert store.indexed_count("acme", "t-1") == 1, "a POST without a key must write nothing"


async def check_body_cap(ctx):
    async with _api(ctx) as c:
        _created(await _post(c, "k-1", text="a" * 16384), "a text of exactly 16 KiB")
        over = await _post(c, "k-2", text="a" * 16385)
        assert over.status_code == 413, f"a text of 16385 bytes answered {over.status_code}, expected 413"
        wide = await _post(c, "k-3", text="é" * 8193)
    assert wide.status_code == 413, f"8193 two-byte characters (16386 bytes of UTF-8) answered {wide.status_code}, expected 413: the cap counts bytes, not characters"
    assert store.indexed_count("acme", "t-1") == 1, f"thread t-1 indexes {store.indexed_count('acme', 't-1')} comments: a text over the cap must not be written"


async def check_parent_thread(ctx):
    async with _api(ctx) as c:
        root = _created(await _post(c, "k-1"), "a top-level comment in t-1")
        elsewhere = _created(await _post(c, "k-2", thread_id="t-2"), "a comment in t-2")
        foreign = _created(await _post(c, "k-3", tenant="globex"), "globex's comment in t-1")
        reply = _created(await _post(c, "k-4", parent_id=root["id"]), "a reply to a comment of the same thread")
        assert reply.get("parent_id") == root["id"], f"the reply must carry parent_id {root['id']}, got {reply}"
        cross = await _post(c, "k-5", parent_id=elsewhere["id"])
        assert cross.status_code == 422, f"a reply in t-1 to {elsewhere['id']} (a comment of t-2) answered {cross.status_code}, expected 422"
        ghost = await _post(c, "k-6", parent_id="c-404")
        assert ghost.status_code == 422, f"a reply to a comment that does not exist answered {ghost.status_code}, expected 422"
        other_tenant = await _post(c, "k-7", parent_id=foreign["id"])
    assert other_tenant.status_code == 422, f"acme's reply to globex's comment {foreign['id']} answered {other_tenant.status_code}, expected 422"
    assert store.indexed_count("acme", "t-1") == 2, f"thread t-1 indexes {store.indexed_count('acme', 't-1')} comments, expected the root and its one valid reply"


async def check_safe_render(ctx):
    async with _api(ctx) as c:
        body = _created(await _post(c, "k-1", text=SCRIPT), "a comment with markup")
    page = body.get("html", "")
    assert "<script" not in page and "<img" not in page, f"html carries live markup a reader's browser would run: {page!r}. Escape the text, then turn back on only ALLOWED_TAGS"
    assert "&lt;script&gt;" in page, f"the script must arrive escaped, as text: {page!r}"
    assert "<b>point</b>" in page and "<br>" in page, f"the allowed tags and line breaks must still render: {page!r}"
    stored = store.get("acme", body["id"])
    assert stored is not None and stored["html"] == page and stored["text"] == SCRIPT, f"the store must keep the text as written and the html as rendered, got {stored}"
`,
    typescript: `const SCRIPT = 'Nice <b>point</b>\\n<script>alert(1)</script><img src=x onerror="alert(2)">';

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/comments/store.ts')};
}

function post(c, key: string | null, fields: Record<string, unknown> = {}, tenant = 'acme') {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/comments', {json: {thread_id: 't-1', author_id: 'u-1', text: 'First!', ...fields}, headers});
}

function created(r, what: string) {
  assert.equal(r.status, 201, \`\${what} answered \${r.status}, expected 201: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const body = created(await post(c, 'k-1'), 'POST /v1/comments with a tenant and a key');
  assert(body.id && body.thread_id === 't-1', \`the 201 must carry the comment's id and thread_id, got \${JSON.stringify(body)}\`);
  const stored = await store.get('acme', body.id);
  assert(stored !== null && stored.text === 'First!', \`the comment \${body.id} is not in the store: \${JSON.stringify(stored)}\`);
  assert.equal(await store.indexedCount('acme', 't-1'), 1, 'thread t-1 must index one comment after one POST');
}

export async function check_idempotency_key(ctx) {
  const {c, store} = api(ctx);
  const first = created(await post(c, 'k-1'), 'the first POST');
  const retry = await post(c, 'k-1');
  assert(retry.status === 200 && retry.json().id === first.id, \`a retry with the same Idempotency-Key answered \${retry.status} \${retry.text}, expected 200 with comment \${first.id}\`);
  assert.equal(await store.indexedCount('acme', 't-1'), 1, 'one comment retried once must leave one comment in thread t-1');
  const other = created(await post(c, 'k-1', {}, 'globex'), "another tenant's POST with the same key");
  assert(other.id !== first.id, "keys are per tenant: globex's k-1 must create its own comment");
  const missing = await post(c, null);
  assert.equal(missing.status, 400, \`a POST without Idempotency-Key answered \${missing.status}, expected 400\`);
  assert.equal(await store.indexedCount('acme', 't-1'), 1, 'a POST without a key must write nothing');
}

export async function check_body_cap(ctx) {
  const {c, store} = api(ctx);
  created(await post(c, 'k-1', {text: 'a'.repeat(16384)}), 'a text of exactly 16 KiB');
  const over = await post(c, 'k-2', {text: 'a'.repeat(16385)});
  assert.equal(over.status, 413, \`a text of 16385 bytes answered \${over.status}, expected 413\`);
  const wide = await post(c, 'k-3', {text: 'é'.repeat(8193)});
  assert.equal(wide.status, 413, \`8193 two-byte characters (16386 bytes of UTF-8) answered \${wide.status}, expected 413: the cap counts bytes, not characters\`);
  assert.equal(await store.indexedCount('acme', 't-1'), 1, 'a text over the cap must not be written');
}

export async function check_parent_thread(ctx) {
  const {c, store} = api(ctx);
  const root = created(await post(c, 'k-1'), 'a top-level comment in t-1');
  const elsewhere = created(await post(c, 'k-2', {thread_id: 't-2'}), 'a comment in t-2');
  const foreign = created(await post(c, 'k-3', {}, 'globex'), "globex's comment in t-1");
  const reply = created(await post(c, 'k-4', {parent_id: root.id}), 'a reply to a comment of the same thread');
  assert.equal(reply.parent_id, root.id, \`the reply must carry parent_id \${root.id}\`);
  const cross = await post(c, 'k-5', {parent_id: elsewhere.id});
  assert.equal(cross.status, 422, \`a reply in t-1 to \${elsewhere.id} (a comment of t-2) answered \${cross.status}, expected 422\`);
  const ghost = await post(c, 'k-6', {parent_id: 'c-404'});
  assert.equal(ghost.status, 422, \`a reply to a comment that does not exist answered \${ghost.status}, expected 422\`);
  const otherTenant = await post(c, 'k-7', {parent_id: foreign.id});
  assert.equal(otherTenant.status, 422, \`acme's reply to globex's comment \${foreign.id} answered \${otherTenant.status}, expected 422\`);
  assert.equal(await store.indexedCount('acme', 't-1'), 2, 'thread t-1 must index the root and its one valid reply');
}

export async function check_safe_render(ctx) {
  const {c, store} = api(ctx);
  const body = created(await post(c, 'k-1', {text: SCRIPT}), 'a comment with markup');
  const page = String(body.html ?? '');
  assert(!page.includes('<script') && !page.includes('<img'), \`html carries live markup a reader's browser would run: \${JSON.stringify(page)}. Escape the text, then turn back on only ALLOWED_TAGS\`);
  assert(page.includes('&lt;script&gt;'), \`the script must arrive escaped, as text: \${JSON.stringify(page)}\`);
  assert(page.includes('<b>point</b>') && page.includes('<br>'), \`the allowed tags and line breaks must still render: \${JSON.stringify(page)}\`);
  const stored = await store.get('acme', body.id);
  assert(stored !== null && stored.html === page && stored.text === SCRIPT, \`the store must keep the text as written and the html as rendered, got \${JSON.stringify(stored)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"comments/store"

	"leetbuild/harness"
)

const script = "Nice <b>point</b>\\n<script>alert(1)</script><img src=x onerror=\\"alert(2)\\">"

type postedComment struct {
	ID       string \`json:"id"\`
	ThreadID string \`json:"thread_id"\`
	ParentID string \`json:"parent_id"\`
	HTML     string \`json:"html"\`
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func postComment(c *harness.HTTP, tenant, key string, fields map[string]any) *harness.Response {
	body := map[string]any{"thread_id": "t-1", "author_id": "u-1", "text": "First!"}
	for k, v := range fields {
		body[k] = v
	}
	header := []string{"X-Tenant-Id", tenant}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/comments", body, header...)
}

func created(ctx *harness.Ctx, r *harness.Response, what string) postedComment {
	ctx.Equal(r.Status, 201, "%s (%s)", what, r.Text())
	var p postedComment
	r.Decode(&p)
	return p
}

func indexed(tenant, threadID string) int64 { return store.IndexedCount(context.Background(), tenant, threadID) }

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	p := created(ctx, postComment(c, "acme", "k-1", nil), "POST /v1/comments with a tenant and a key")
	ctx.Assert(p.ID != "" && p.ThreadID == "t-1", "the 201 must carry the comment's id and thread_id, got %+v", p)
	stored := store.Get(context.Background(), "acme", p.ID)
	ctx.Assert(stored != nil && stored.Text == "First!", "the comment %s is not in the store: %+v", p.ID, stored)
	ctx.Equal(indexed("acme", "t-1"), 1, "the comments thread t-1 indexes after one POST")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := created(ctx, postComment(c, "acme", "k-1", nil), "the first POST")
	retry := postComment(c, "acme", "k-1", nil)
	var again postedComment
	if retry.Status == 200 {
		retry.Decode(&again)
	}
	ctx.Assert(retry.Status == 200 && again.ID == first.ID, "a retry with the same Idempotency-Key answered %d %s, expected 200 with comment %s", retry.Status, retry.Text(), first.ID)
	ctx.Equal(indexed("acme", "t-1"), 1, "one comment retried once: the comments in thread t-1")
	other := created(ctx, postComment(c, "globex", "k-1", nil), "another tenant's POST with the same key")
	ctx.Assert(other.ID != first.ID, "keys are per tenant: globex's k-1 must create its own comment")
	missing := postComment(c, "acme", "", nil)
	ctx.Equal(missing.Status, 400, "a POST without Idempotency-Key")
	ctx.Equal(indexed("acme", "t-1"), 1, "a POST without a key must write nothing; the comments in thread t-1")
}

func CheckBodyCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	created(ctx, postComment(c, "acme", "k-1", map[string]any{"text": strings.Repeat("a", 16384)}), "a text of exactly 16 KiB")
	over := postComment(c, "acme", "k-2", map[string]any{"text": strings.Repeat("a", 16385)})
	ctx.Equal(over.Status, 413, "a text of 16385 bytes")
	wide := postComment(c, "acme", "k-3", map[string]any{"text": strings.Repeat("é", 8193)})
	ctx.Equal(wide.Status, 413, "8193 two-byte characters (16386 bytes of UTF-8): the cap counts bytes, not characters")
	ctx.Equal(indexed("acme", "t-1"), 1, "a text over the cap must not be written; the comments in thread t-1")
}

func CheckParentThread(ctx *harness.Ctx) {
	c := apiClient(ctx)
	root := created(ctx, postComment(c, "acme", "k-1", nil), "a top-level comment in t-1")
	elsewhere := created(ctx, postComment(c, "acme", "k-2", map[string]any{"thread_id": "t-2"}), "a comment in t-2")
	foreign := created(ctx, postComment(c, "globex", "k-3", nil), "globex's comment in t-1")
	reply := created(ctx, postComment(c, "acme", "k-4", map[string]any{"parent_id": root.ID}), "a reply to a comment of the same thread")
	ctx.Equal(reply.ParentID, root.ID, "the reply's parent_id")
	cross := postComment(c, "acme", "k-5", map[string]any{"parent_id": elsewhere.ID})
	ctx.Equal(cross.Status, 422, "a reply in t-1 to %s (a comment of t-2)", elsewhere.ID)
	ghost := postComment(c, "acme", "k-6", map[string]any{"parent_id": "c-404"})
	ctx.Equal(ghost.Status, 422, "a reply to a comment that does not exist")
	otherTenant := postComment(c, "acme", "k-7", map[string]any{"parent_id": foreign.ID})
	ctx.Equal(otherTenant.Status, 422, "acme's reply to globex's comment %s", foreign.ID)
	ctx.Equal(indexed("acme", "t-1"), 2, "thread t-1 must index the root and its one valid reply")
}

func CheckSafeRender(ctx *harness.Ctx) {
	c := apiClient(ctx)
	p := created(ctx, postComment(c, "acme", "k-1", map[string]any{"text": script}), "a comment with markup")
	ctx.Assert(!strings.Contains(p.HTML, "<script") && !strings.Contains(p.HTML, "<img"), "html carries live markup a reader's browser would run: %q. Escape the text, then turn back on only allowedTags", p.HTML)
	ctx.Assert(strings.Contains(p.HTML, "&lt;script&gt;"), "the script must arrive escaped, as text: %q", p.HTML)
	ctx.Assert(strings.Contains(p.HTML, "<b>point</b>") && strings.Contains(p.HTML, "<br>"), "the allowed tags and line breaks must still render: %q", p.HTML)
	stored := store.Get(context.Background(), "acme", p.ID)
	ctx.Assert(stored != nil && stored.HTML == p.HTML && stored.Text == script, "the store must keep the text as written and the html as rendered, got %+v", stored)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "comments/store.h"

namespace {

const std::string kScript = "Nice <b>point</b>\\n<script>alert(1)</script><img src=x onerror=\\"alert(2)\\">";

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response postComment(harness::HTTP& c, const std::string& tenant, const std::string& key, const nlohmann::json& fields = nlohmann::json::object()) {
  nlohmann::json body = {{"thread_id", "t-1"}, {"author_id", "u-1"}, {"text", "First!"}};
  for (const auto& item : fields.items()) body[item.key()] = item.value();
  if (key.empty()) return c.Post("/v1/comments", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/comments", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json created(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 201, "%s (%s)", what, r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "%s: the body is not a JSON object: %s", what, r.Text());
  return body;
}

std::string text(const nlohmann::json& j, const char* name) { return j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : ""; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto body = created(ctx, postComment(c, "acme", "k-1"), "POST /v1/comments with a tenant and a key");
  ctx.Assert(!text(body, "id").empty() && text(body, "thread_id") == "t-1", "the 201 must carry the comment's id and thread_id, got %s", body.dump());
  const auto stored = store::get("acme", text(body, "id"));
  ctx.Assert(stored && stored->text == "First!", "the comment %s is not in the store", text(body, "id"));
  ctx.Equal(store::indexedCount("acme", "t-1"), 1, "the comments thread t-1 indexes after one POST");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto first = created(ctx, postComment(c, "acme", "k-1"), "the first POST");
  const auto retry = postComment(c, "acme", "k-1");
  const auto again = nlohmann::json::parse(retry.Text(), nullptr, false);
  ctx.Assert(retry.Status == 200 && again.is_object() && text(again, "id") == text(first, "id"),
             "a retry with the same Idempotency-Key answered %d %s, expected 200 with comment %s", retry.Status, retry.Text(), text(first, "id"));
  ctx.Equal(store::indexedCount("acme", "t-1"), 1, "one comment retried once: the comments in thread t-1");
  const auto other = created(ctx, postComment(c, "globex", "k-1"), "another tenant's POST with the same key");
  ctx.Assert(text(other, "id") != text(first, "id"), "keys are per tenant: globex's k-1 must create its own comment");
  const auto missing = postComment(c, "acme", "");
  ctx.Equal(missing.Status, 400, "a POST without Idempotency-Key");
  ctx.Equal(store::indexedCount("acme", "t-1"), 1, "a POST without a key must write nothing; the comments in thread t-1");
}

void CheckBodyCap(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  created(ctx, postComment(c, "acme", "k-1", {{"text", std::string(16384, 'a')}}), "a text of exactly 16 KiB");
  const auto over = postComment(c, "acme", "k-2", {{"text", std::string(16385, 'a')}});
  ctx.Equal(over.Status, 413, "a text of 16385 bytes");
  std::string wide;
  for (int i = 0; i < 8193; i++) wide += "é";
  const auto r = postComment(c, "acme", "k-3", {{"text", wide}});
  ctx.Equal(r.Status, 413, "8193 two-byte characters (16386 bytes of UTF-8): the cap counts bytes, not characters");
  ctx.Equal(store::indexedCount("acme", "t-1"), 1, "a text over the cap must not be written; the comments in thread t-1");
}

void CheckParentThread(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto root = created(ctx, postComment(c, "acme", "k-1"), "a top-level comment in t-1");
  const auto elsewhere = created(ctx, postComment(c, "acme", "k-2", {{"thread_id", "t-2"}}), "a comment in t-2");
  const auto foreign = created(ctx, postComment(c, "globex", "k-3"), "globex's comment in t-1");
  const auto reply = created(ctx, postComment(c, "acme", "k-4", {{"parent_id", text(root, "id")}}), "a reply to a comment of the same thread");
  ctx.Equal(text(reply, "parent_id"), text(root, "id"), "the reply's parent_id");
  const auto cross = postComment(c, "acme", "k-5", {{"parent_id", text(elsewhere, "id")}});
  ctx.Equal(cross.Status, 422, "a reply in t-1 to %s (a comment of t-2)", text(elsewhere, "id"));
  const auto ghost = postComment(c, "acme", "k-6", {{"parent_id", "c-404"}});
  ctx.Equal(ghost.Status, 422, "a reply to a comment that does not exist");
  const auto otherTenant = postComment(c, "acme", "k-7", {{"parent_id", text(foreign, "id")}});
  ctx.Equal(otherTenant.Status, 422, "acme's reply to globex's comment %s", text(foreign, "id"));
  ctx.Equal(store::indexedCount("acme", "t-1"), 2, "thread t-1 must index the root and its one valid reply");
}

void CheckSafeRender(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto body = created(ctx, postComment(c, "acme", "k-1", {{"text", kScript}}), "a comment with markup");
  const std::string page = text(body, "html");
  ctx.Assert(page.find("<script") == std::string::npos && page.find("<img") == std::string::npos,
             "html carries live markup a reader's browser would run: %q. Escape the text, then turn back on only kAllowedTags", page);
  ctx.Assert(page.find("&lt;script&gt;") != std::string::npos, "the script must arrive escaped, as text: %q", page);
  ctx.Assert(page.find("<b>point</b>") != std::string::npos && page.find("<br>") != std::string::npos, "the allowed tags and line breaks must still render: %q", page);
  const auto stored = store::get("acme", text(body, "id"));
  ctx.Assert(stored && stored->html == page && stored->text == kScript, "the store must keep the text as written and the html as rendered");
}
`,
  },
  hints: [
    'Post one comment, let the client time out and retry: the thread shows it twice. Reply to a comment of another thread and the reply appears here. Post `<script>`: it runs on the page.',
    'The handler does not read `Idempotency-Key`, measure the text or load the parent, and `render_html` only swaps newlines, so whatever markup the author typed becomes the page’s markup.',
    'Require the key and answer `store.by_key` when it hits; 413 when `len(text.encode()) > MAX_TEXT_BYTES`; 422 unless `store.get(tenant, parent_id)` has your `thread_id`; `html.escape`, then restore `ALLOWED_TAGS`; `store.remember_key` after the insert.',
  ],
  debrief: `The guards run cheapest first and all of them before the insert: header checks, the idempotency lookup, the byte count, then the one store read that can tell whether the parent and the request agree on a thread. A reply grafted onto another thread is a corrupt tree no read can repair, so it is refused at the door. Rendering at write time, from escaped text and a short allow list, is what Discourse calls cooking: readers get HTML rendered once, and the raw text stays for edits. One gap remains between the insert and \`remember_key\`, where two concurrent retries can both miss the key; a production service writes the key and the comment in one transaction, and renders with a full sanitizer that understands links and attributes.`,
};
