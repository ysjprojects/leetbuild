import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/comments: replies that stay in their thread',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the JSON, writes a row and returns \`201\`. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/comments\` with body
\`{"thread_id": "t-1", "parent_id": "c-7", "text": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same
  \`(tenant, key)\` returns the comment that was created the first time — same \`id\`, same
  \`created_at\` — and never inserts a second row.
- \`text\` is a non-empty string of at most **16 KiB** (\`16 * 1024\` bytes) of UTF-8; a longer body
  is **413**.
- \`parent_id\` is optional. When present it must name a comment **in the same thread**: a parent
  from another thread (or a parent that does not exist) is **422** — a reply is never grafted onto
  a thread it does not belong to.
- \`thread_id\` is required and must be a non-empty string (**400** otherwise).
- The body is stored **escaped**: raw client markup is never persisted as markup. Rendering is a
  separate, explicit step that unescapes only tags in the safe subset
  (\`b\`, \`i\`, \`code\`, \`pre\`, \`a\`, \`br\`), so a \`<script>\` in a comment survives as text
  and never as an element.
- A created comment answers **201** with \`{"id", "thread_id", "parent_id", "created_at",
  "revision", "text"}\`; a replay answers **200** with the stored comment.

**Failure mode the checks target.** Three defects, and every one of them is invisible in a demo.
The draft never compares \`parent_id\`'s thread with the \`thread_id\` in the request, so a reply
can be grafted onto any thread — the parent lookup is the only thing that knows where a comment
lives. It ignores \`Idempotency-Key\` entirely, so a client retry (or a queue redelivery) creates a
second comment with a second id. And it stores \`text\` verbatim, so whatever markup the client sent
is markup the next client renders — the classic stored-XSS handoff between two services that both
believe the other one escaped.`,
  sequence: {
    participants: ['Client', 'Comments API', 'comment store'],
    messages: [
      {from: 'Client', to: 'Comments API', label: 'POST /v1/comments · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Comments API', to: 'Comments API', label: 'validate tenant · key · text cap', kind: 'sync'},
      {from: 'Comments API', to: 'comment store', label: 'get_by_key(tenant, key)', kind: 'sync'},
      {from: 'comment store', to: 'Comments API', label: 'stored comment / none', kind: 'reply'},
      {from: 'Comments API', to: 'comment store', label: 'parent_thread(parent_id)', kind: 'sync'},
      {from: 'comment store', to: 'Comments API', label: 'thread id / none', kind: 'reply'},
      {from: 'Comments API', to: 'comment store', label: 'insert(comment with escaped text)', kind: 'sync'},
      {from: 'Comments API', to: 'Client', label: '201 created · 422 foreign parent · 413 too large', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/comments',
      detail: 'Register the create-comment route on `POST /v1/comments`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/comments["']\)/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/comments['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/comments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"comments"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/comments"/]},
      },
    },
    {
      id: 'body-cap',
      title: 'Caps the body at 16 KiB',
      detail:
        'A body over `16 * 1024` bytes is **413** before anything is stored. The draft accepts any size, so one client can write an unbounded row.',
      match: {
        python: {all: [/MAX_BODY_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_BODY_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxBodyBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxBodyBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxBodyBytes/, /\b413\b/]},
      },
    },
    {
      id: 'parent-thread',
      title: 'Rejects a parent from another thread with 422',
      detail:
        'The parent is looked up and its thread compared with the request’s `thread_id`; a mismatch is **422**. The draft never resolves the parent, so a reply can be grafted onto any thread.',
      match: {
        python: {all: [/parent_thread\(/, /status_code\s*=\s*422/]},
        typescript: {all: [/store\.parentThread\(/, /code\(\s*422\s*\)/]},
        go: {all: [/store\.ParentThread\(/, /StatusUnprocessableEntity/]},
        scala: {all: [/parentThread\(/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/parentThread\(/, /\b422\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required, looked up under `(tenant, key)` and the created comment is stored under it; a replay returns the stored comment instead of inserting again. The draft ignores the header.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get_by_key\(/, /store\.insert\(/]},
        typescript: {all: [/idempotency-key/, /store\.getByKey\(/, /store\.insert\(/]},
        go: {all: [/Idempotency-Key/, /GetByKey\(/, /\.Insert\(/]},
        scala: {all: [/Idempotency-Key/, /getByKey\(/, /store\.insert\(/]},
        cpp: {all: [/Idempotency-Key/, /getByKey\(/, /store\.insert\(/]},
      },
    },
    {
      id: 'escape-at-rest',
      title: 'Stores the body escaped and renders from a safe subset',
      detail:
        'The body is escaped before it is stored (`html.escape` / `escapeHtml` / `html.EscapeString`) and rendering unescapes only the tags in `ALLOWED_MARKUP`. The draft stores the client’s markup verbatim.',
      match: {
        python: {all: [/html\.escape\(/, /ALLOWED_MARKUP/]},
        typescript: {all: [/escapeHtml\(/, /ALLOWED_MARKUP/]},
        go: {all: [/html\.EscapeString\(/, /allowedMarkup/]},
        scala: {all: [/escapeHtml\(/, /AllowedMarkup/]},
        cpp: {all: [/escapeHtml\(/, /kAllowedMarkup/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class CommentRequest(BaseModel):
    thread_id: str
    parent_id: str | None = None
    text: str


class CommentStore:
    def insert(self, comment: dict) -> None:
        """Persist the comment."""
        raise NotImplementedError

    def get_by_key(self, tenant: str, idem_key: str) -> dict | None:
        """The comment stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def parent_thread(self, parent_id: str) -> str | None:
        """The thread a parent comment belongs to, or None when it does not exist."""
        raise NotImplementedError


store = CommentStore()


@app.post("/v1/comments")
def create_comment(body: CommentRequest, tenant: str = Header(default="", alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts a parent from another thread, ignores Idempotency-Key so a replay
    # posts twice, stores the body as markup the client renders raw and caps no size. Review all of it.
    comment = {
        "id": str(uuid.uuid4()),
        "thread_id": body.thread_id,
        "parent_id": body.parent_id,
        "text": body.text,
    }
    store.insert(comment)
    return JSONResponse(comment, status_code=201)
`,
      solution: `import html
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_BODY_BYTES = 16 * 1024
ALLOWED_MARKUP = frozenset({"b", "i", "code", "pre", "a", "br"})


class CommentRequest(BaseModel):
    thread_id: str
    parent_id: str | None = None
    text: str


class CommentStore:
    def insert(self, comment: dict) -> None:
        """Persist the comment."""
        raise NotImplementedError

    def get_by_key(self, tenant: str, idem_key: str) -> dict | None:
        """The comment stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def parent_thread(self, parent_id: str) -> str | None:
        """The thread a parent comment belongs to, or None when it does not exist."""
        raise NotImplementedError


store = CommentStore()


def render_text(stored: str) -> str:
    """Render a stored body: escaped at rest, markup only for tags in the safe subset."""
    rendered = stored
    for name in ALLOWED_MARKUP:
        rendered = rendered.replace(f"&lt;{name}&gt;", f"<{name}>")
        rendered = rendered.replace(f"&lt;/{name}&gt;", f"</{name}>")
    return rendered


@app.post("/v1/comments")
def create_comment(
    body: CommentRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.thread_id == "" or body.text.strip() == "":
        raise HTTPException(status_code=400, detail="thread_id and text are required")
    if len(body.text.encode("utf-8")) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 16 KiB")

    stored = store.get_by_key(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    if body.parent_id is not None and store.parent_thread(body.parent_id) != body.thread_id:
        raise HTTPException(status_code=422, detail="parent_id belongs to another thread")

    comment = {
        "id": str(uuid.uuid4()),
        "thread_id": body.thread_id,
        "parent_id": body.parent_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "revision": 1,
        "text": html.escape(body.text, quote=True),
    }
    store.insert(comment)
    return JSONResponse(comment, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/comments: a model-generated draft that trusts its client. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface CommentBody {
  thread_id: string;
  parent_id?: string | null;
  text: string;
}

app.post('/v1/comments', async (request, reply) => {
  // TODO: this draft accepts a parent from another thread, ignores Idempotency-Key so a replay
  // posts twice, stores the body as markup the client renders raw and caps no size.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as CommentBody;
  const comment = {
    id: randomUUID(),
    thread_id: body.thread_id,
    parent_id: body.parent_id ?? null,
    created_at: new Date().toISOString(),
    revision: 1,
    text: body.text,
  };
  await store.insert(comment);
  request.log.info({tenant, thread_id: body.thread_id}, 'comment created');
  return reply.code(201).send(comment);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/comments: threaded replies that stay in their thread, capped and idempotent. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_MARKUP: Record<string, true> = {b: true, i: true, code: true, pre: true, a: true, br: true};

interface CommentBody {
  thread_id: string;
  parent_id?: string | null;
  text: string;
}

interface Comment {
  id: string;
  thread_id: string;
  parent_id: string | null;
  created_at: string;
  revision: number;
  text: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a stored body: escaped at rest, markup only for the tags in the safe subset. */
function renderText(stored: string): string {
  let rendered = stored;
  for (const name of Object.keys(ALLOWED_MARKUP)) {
    rendered = rendered.split(\`&lt;\${name}&gt;\`).join(\`<\${name}>\`);
    rendered = rendered.split(\`&lt;/\${name}&gt;\`).join(\`</\${name}>\`);
  }
  return rendered;
}

app.post('/v1/comments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<CommentBody> | null;
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof body.thread_id !== 'string' ||
    body.thread_id === '' ||
    typeof body.text !== 'string' ||
    body.text.trim() === ''
  )
    return reply.code(400).send({error: 'thread_id and text are required'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_BODY_BYTES)
    return reply.code(413).send({error: 'text exceeds 16 KiB'});

  const stored: Comment | null = await store.getByKey(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const parentId = body.parent_id ?? null;
  if (parentId !== null) {
    const parentThread = await store.parentThread(parentId);
    if (parentThread !== body.thread_id)
      return reply.code(422).send({error: 'parent_id belongs to another thread'});
  }

  const comment: Comment = {
    id: randomUUID(),
    thread_id: body.thread_id,
    parent_id: parentId,
    created_at: new Date().toISOString(),
    revision: 1,
    text: escapeHtml(body.text),
  };
  await store.insert(comment);
  request.log.info({tenant, thread_id: comment.thread_id, comment_id: comment.id}, 'comment created');
  return reply.code(201).send(comment);
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
	"time"

	"github.com/google/uuid"
)

type CommentRequest struct {
	ThreadID string  \`json:"thread_id"\`
	ParentID *string \`json:"parent_id"\`
	Text     string  \`json:"text"\`
}

type Comment struct {
	ID        string  \`json:"id"\`
	ThreadID  string  \`json:"thread_id"\`
	ParentID  *string \`json:"parent_id"\`
	CreatedAt string  \`json:"created_at"\`
	Revision  int     \`json:"revision"\`
	Text      string  \`json:"text"\`
}

type CommentStore struct{}

func (s *CommentStore) Insert(ctx context.Context, comment *Comment) error { return nil }

func (s *CommentStore) GetByKey(ctx context.Context, tenant, idemKey string) (*Comment, error) {
	return nil, nil
}

func (s *CommentStore) ParentThread(ctx context.Context, parentID string) (string, error) {
	return "", nil
}

var store = &CommentStore{}

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(payload)
}

func createComment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var req CommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts a parent from another thread, ignores Idempotency-Key so a replay
	// posts twice, stores the text as markup the client renders raw and caps no size.
	comment := &Comment{
		ID:        uuid.NewString(),
		ThreadID:  req.ThreadID,
		ParentID:  req.ParentID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Revision:  1,
		Text:      req.Text,
	}
	_ = store.Insert(r.Context(), comment)
	log.Printf("comment created tenant=%s thread=%s id=%s", tenant, comment.ThreadID, comment.ID)
	writeJSON(rw, http.StatusCreated, comment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/comments", createComment)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"html"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

const maxBodyBytes = 16 * 1024

var allowedMarkup = map[string]bool{"b": true, "i": true, "code": true, "pre": true, "a": true, "br": true}

type CommentRequest struct {
	ThreadID string  \`json:"thread_id"\`
	ParentID *string \`json:"parent_id"\`
	Text     string  \`json:"text"\`
}

type Comment struct {
	ID        string  \`json:"id"\`
	ThreadID  string  \`json:"thread_id"\`
	ParentID  *string \`json:"parent_id"\`
	CreatedAt string  \`json:"created_at"\`
	Revision  int     \`json:"revision"\`
	Text      string  \`json:"text"\`
}

type CommentStore struct{}

func (s *CommentStore) Insert(ctx context.Context, comment *Comment) error { return nil }

func (s *CommentStore) GetByKey(ctx context.Context, tenant, idemKey string) (*Comment, error) {
	return nil, nil
}

func (s *CommentStore) ParentThread(ctx context.Context, parentID string) (string, error) {
	return "", nil
}

var store = &CommentStore{}

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(payload)
}

// renderText renders a stored body: escaped at rest, markup only for the tags in the safe subset.
func renderText(stored string) string {
	rendered := stored
	for name := range allowedMarkup {
		rendered = strings.ReplaceAll(rendered, "&lt;"+name+"&gt;", "<"+name+">")
		rendered = strings.ReplaceAll(rendered, "&lt;/"+name+"&gt;", "</"+name+">")
	}
	return rendered
}

func createComment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var req CommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if req.ThreadID == "" || strings.TrimSpace(req.Text) == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "thread_id and text are required"})
		return
	}
	if len([]byte(req.Text)) > maxBodyBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 16 KiB"})
		return
	}
	stored, err := store.GetByKey(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	if req.ParentID != nil {
		parentThread, err := store.ParentThread(r.Context(), *req.ParentID)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if parentThread != req.ThreadID {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "parent_id belongs to another thread"})
			return
		}
	}
	comment := &Comment{
		ID:        uuid.NewString(),
		ThreadID:  req.ThreadID,
		ParentID:  req.ParentID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Revision:  1,
		Text:      html.EscapeString(req.Text),
	}
	if err := store.Insert(r.Context(), comment); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("comment created tenant=%s thread=%s id=%s", tenant, comment.ThreadID, comment.ID)
	writeJSON(rw, http.StatusCreated, comment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/comments", createComment)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CommentRequest(thread_id: String, parent_id: Option[String], text: String)
final case class Comment(
    id: String,
    thread_id: String,
    parent_id: Option[String],
    created_at: String,
    revision: Int,
    text: String
)

object CommentsApi {
  implicit val system: ActorSystem = ActorSystem("comments-service")
  implicit val requestFormat: RootJsonFormat[CommentRequest] = jsonFormat3(CommentRequest)
  implicit val commentFormat: RootJsonFormat[Comment] = jsonFormat6(Comment)

  val store = CommentStore.open()

  val route: Route =
    path("v1" / "comments") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[CommentRequest]) { body =>
            // TODO: this draft accepts a parent from another thread, ignores Idempotency-Key so a
            // replay posts twice, stores the text as markup the client renders raw and caps no size.
            val comment = Comment(
              UUID.randomUUID().toString,
              body.thread_id,
              body.parent_id,
              java.time.Instant.now.toString,
              1,
              body.text
            )
            store.insert(comment)
            system.log.info(s"comment created tenant=$tenant thread=\${comment.thread_id}")
            complete(StatusCodes.Created, comment)
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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CommentRequest(thread_id: String, parent_id: Option[String], text: String)
final case class Comment(
    id: String,
    thread_id: String,
    parent_id: Option[String],
    created_at: String,
    revision: Int,
    text: String
)

object CommentsApi {
  implicit val system: ActorSystem = ActorSystem("comments-service")
  implicit val requestFormat: RootJsonFormat[CommentRequest] = jsonFormat3(CommentRequest)
  implicit val commentFormat: RootJsonFormat[Comment] = jsonFormat6(Comment)

  val MaxBodyBytes = 16 * 1024
  val AllowedMarkup = Set("b", "i", "code", "pre", "a", "br")

  val store = CommentStore.open()

  def escapeHtml(raw: String): String =
    raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\"", "&quot;")

  /** Render a stored body: escaped at rest, markup only for the tags in the safe subset. */
  def renderText(stored: String): String =
    AllowedMarkup.foldLeft(stored) { (rendered, name) =>
      rendered.replace(s"&lt;$name&gt;", s"<$name>").replace(s"&lt;/$name&gt;", s"</$name>")
    }

  val route: Route =
    path("v1" / "comments") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[CommentRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.thread_id.isEmpty || body.text.trim.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"thread_id and text are required"}""")
              } else if (body.text.getBytes(StandardCharsets.UTF_8).length > MaxBodyBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 16 KiB"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.getByKey(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val foreignParent = body.parent_id.exists(parentId => store.parentThread(parentId) != Some(body.thread_id))
                    if (foreignParent) {
                      complete(StatusCodes.UnprocessableEntity, """{"error":"parent_id belongs to another thread"}""")
                    } else {
                      val comment = Comment(
                        UUID.randomUUID().toString,
                        body.thread_id,
                        body.parent_id,
                        java.time.Instant.now.toString,
                        1,
                        escapeHtml(body.text)
                      )
                      store.insert(comment)
                      system.log.info(s"comment created tenant=$tenant thread=\${comment.thread_id}")
                      complete(StatusCodes.Created, comment)
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

#include <ctime>
#include <iostream>
#include <string>

using json = nlohmann::json;

struct CommentStore {
  std::optional<json> getByKey(const std::string& tenant, const std::string& idemKey);
  std::optional<std::string> parentThread(const std::string& parentId);
  void insert(const json& comment);
};

CommentStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/comments", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts a parent from another thread, ignores Idempotency-Key so a replay
    // posts twice, stores the text as markup the client renders raw and caps no size.
    const json comment = {
        {"id", uuidString()},
        {"thread_id", body.value("thread_id", std::string())},
        {"parent_id", body.contains("parent_id") ? body["parent_id"] : json(nullptr)},
        {"revision", 1},
        {"text", body.value("text", std::string())},
    };
    store.insert(comment);
    std::cerr << "comment created tenant=" << tenant << " thread=" << comment["thread_id"] << "\\n";
    res.status = 201;
    res.set_content(comment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxBodyBytes = 16 * 1024;
const std::set<std::string> kAllowedMarkup = {"b", "i", "code", "pre", "a", "br"};

struct CommentStore {
  std::optional<json> getByKey(const std::string& tenant, const std::string& idemKey);
  std::optional<std::string> parentThread(const std::string& parentId);
  void insert(const json& comment);
};

CommentStore store;
std::string uuidString();

static std::string escapeHtml(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (const char c : raw) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += c;
    }
  }
  return out;
}

// renderText renders a stored body: escaped at rest, markup only for the tags in the safe subset.
static std::string renderText(const std::string& stored) {
  std::string rendered = stored;
  for (const auto& name : kAllowedMarkup) {
    for (const auto& [from, to] : {std::pair{"&lt;" + name + "&gt;", "<" + name + ">"},
                                   std::pair{"&lt;/" + name + "&gt;", "</" + name + ">"}}) {
      for (std::size_t at = rendered.find(from); at != std::string::npos; at = rendered.find(from, at + to.size())) {
        rendered.replace(at, from.size(), to);
      }
    }
  }
  return rendered;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/comments", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("thread_id") || !body["thread_id"].is_string() ||
        !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"thread_id and text are required"})", "application/json");
      return;
    }
    const auto threadId = body["thread_id"].get<std::string>();
    const auto text = body["text"].get<std::string>();
    if (threadId.empty() || text.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"thread_id and text are required"})", "application/json");
      return;
    }
    if (text.size() > kMaxBodyBytes) {
      res.status = 413;
      res.set_content(R"({"error":"text exceeds 16 KiB"})", "application/json");
      return;
    }
    if (const auto stored = store.getByKey(tenant, idemKey)) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    if (body.contains("parent_id") && body["parent_id"].is_string()) {
      const auto parentId = body["parent_id"].get<std::string>();
      const auto parentThread = store.parentThread(parentId);
      if (!parentThread || *parentThread != threadId) {
        res.status = 422;
        res.set_content(R"({"error":"parent_id belongs to another thread"})", "application/json");
        return;
      }
    }
    const json comment = {
        {"id", uuidString()},
        {"thread_id", threadId},
        {"parent_id", body.contains("parent_id") ? body["parent_id"] : json(nullptr)},
        {"revision", 1},
        {"text", escapeHtml(text)},
    };
    store.insert(comment);
    std::cerr << "comment created tenant=" << tenant << " thread=" << threadId << "\\n";
    res.status = 201;
    res.set_content(comment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guard clauses by cost: tenant, `Idempotency-Key`, thread/text shape, byte length, then the parent lookup. The lookup is the only expensive one, so it runs after every cheap rejection.',
    'The parent check is a comparison of two thread ids, not a truthiness test: `parent_thread(parent_id) != thread_id` is 422, which also covers a parent that does not exist. Fetch the parent’s thread from the store rather than trusting a client-supplied `thread_id`.',
    'Escape once, at the boundary where the value becomes durable: `html.escape(text)` / `escapeHtml(text)` / `html.EscapeString(text)` before the insert. Rendering then unescapes only the tags in the safe subset — storing raw markup means the renderer is the only thing standing between a comment and the next client.',
  ],
  debrief: `The interviewer is testing whether you review a generated write endpoint at two boundaries at once: the trust boundary (who says which thread this reply belongs to) and the data boundary (what a client’s bytes become once they are stored). The draft is convincing because every demo passes: one thread, one well-formed body, no retries. The parent comparison is the subtle one — the request carries both ids, and only the store can say whether they agree; grafting a reply onto another thread silently corrupts a thread’s tree and cannot be repaired by a later read. Idempotency keyed by \`(tenant, key)\` is what makes a retried POST safe, and it has to be checked before the insert, not after. Escaping at rest is the third: two services that each assume the other escaped are how stored XSS ships. Real comment services add a moderation hook before the write is visible, an edit revision column, soft deletes, and a rate limit per author — the next steps of this course build exactly those.`,
};
