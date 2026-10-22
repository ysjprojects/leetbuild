import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/threads/{id}/comments: pagination that does not skip',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it returns "the next 20
comments", it is one query, and it works perfectly until the thread is busy. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/threads/{id}/comments\` — top-level comments of a thread, one page at a time.

- Pagination is a **cursor** on \`(created_at, comment id)\`: \`encode_cursor\` turns the last row
  of the page into an opaque token, \`decode_cursor\` turns a token back into the position to resume
  after (the epoch and an empty id for the first page). Offset is never used: \`OFFSET\` re-counts
  rows every request, so an insert or delete above the window shifts it.
- The query is a **keyset** predicate, not a count:
  \`... WHERE thread_id = $1 AND parent_id IS NULL AND (created_at, id) > ($2, $3)
  ORDER BY created_at, id LIMIT $4\`. \`next_cursor\` is set only when the page came back full, so
  the last page terminates instead of looping.
- The page carries the **thread's comment count** from the same Redis counter the write path keeps
  (\`thread:{tenant}:{thread_id}:count\`) and each item's **reply count** from the per-comment
  counters (\`thread:{tenant}:{thread_id}:replies:{comment_id}\`), so the numbers the UI shows are
  the numbers the write path committed.
- Deleted comments stay in the page as **tombstones**: identity, parent and reply count, and
  \`deleted: true\`, with **no text**. Dropping the row would break the reply tree; returning its
  text would resurrect content the author deleted.
- The first page is what a new reader sees, and the same comment must never appear twice across a
  page walk, whatever is written while they read.

**Failure mode the checks target.** The draft paginates by **offset**, which is not a position but a
count: post three comments while the reader is on page 2 and everything shifts, so one comment is
skipped entirely and another is served again — the bug users describe as "the thread showed the same
comment twice". It also returns **deleted comments with their text intact**, so a deleted reply keeps
rendering, and it reports no counts at all, leaving the UI to guess how many comments a thread has
instead of reading the counter the write path keeps.`,
  sequence: {
    participants: ['Client', 'Comments API', 'comment store', 'Redis'],
    messages: [
      {from: 'Client', to: 'Comments API', label: 'GET /v1/threads/{id}/comments?cursor=…', kind: 'sync'},
      {from: 'Comments API', to: 'Comments API', label: 'decode_cursor → (created_at, id)', kind: 'sync'},
      {
        from: 'Comments API',
        to: 'comment store',
        label: 'WHERE (created_at, id) > ($2, $3) ORDER BY created_at, id LIMIT 20',
        kind: 'sync',
      },
      {from: 'comment store', to: 'Comments API', label: 'rows · tombstones without text', kind: 'reply'},
      {from: 'Comments API', to: 'Redis', label: 'GET thread:{tenant}:{thread}:count · replies:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Comments API', label: 'comment_count · reply counts', kind: 'reply'},
      {from: 'Comments API', to: 'Client', label: '200 {comments, next_cursor, comment_count}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/threads/{id}/comments',
      detail: 'Register the read route on `GET /v1/threads/{id}/comments`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/threads\/\{thread_id\}\/comments["']\)/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/threads\/:id\/comments['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/threads\/\{id\}\/comments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"threads"\s*\/\s*Segment\s*\/\s*"comments"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/kListPath/, /svr\.Get\(kListPath/]},
      },
    },
    {
      id: 'cursor',
      title: 'Paginates on a (created_at, id) cursor',
      detail:
        'The page position is encoded and decoded as an opaque cursor on `(created_at, id)`. The draft uses an integer offset, which is a count of rows, not a position.',
      match: {
        python: {all: [/def encode_cursor\(/, /def decode_cursor\(/]},
        typescript: {all: [/function encodeCursor\(/, /function decodeCursor\(/]},
        go: {all: [/func encodeCursor\(/, /func decodeCursor\(/]},
        scala: {all: [/def encodeCursor\(/, /def decodeCursor\(/]},
        cpp: {all: [/encodeCursor\(/, /decodeCursor\(/]},
      },
    },
    {
      id: 'keyset',
      title: 'Reads with a keyset predicate and a limit',
      detail:
        'The query filters by `(created_at, id) > ($2, $3)` and ends with `LIMIT $4`, so each page is a range scan from a position. The draft runs `OFFSET`, which re-counts every row the thread has written.',
      match: {
        python: {all: [/\(created_at, id\) >/, /LIMIT/]},
        typescript: {all: [/\(created_at, id\) >/, /LIMIT/]},
        go: {all: [/\(created_at, id\) >/, /LIMIT/]},
        scala: {all: [/\(created_at, id\) >/, /LIMIT/]},
        cpp: {all: [/\(created_at, id\) >/, /LIMIT/]},
      },
    },
    {
      id: 'tombstone',
      title: 'Returns deleted comments as tombstones without text',
      detail:
        'A deleted row serialises to identity, parent, reply count and `deleted: true` — the text is never included. The draft returns deleted comments with their bodies intact.',
      match: {
        python: {all: [/def serialize_comment\(/, /if row\["deleted"\]/, /"deleted": True/]},
        typescript: {all: [/function serializeComment\(/, /if \(row\.deleted\)/, /deleted: true/]},
        go: {all: [/func serializeComment\(/, /if row\.Deleted \{/, /"deleted":\s+true/]},
        scala: {all: [/def serializeComment\(/, /if \(row\.deleted\)/, /"deleted" -> JsBoolean\(true\)/]},
        cpp: {all: [/serializeComment\(/, /row\.deleted/, /"deleted", true/]},
      },
    },
    {
      id: 'counters',
      title: 'Reports counts from the write path’s counters',
      detail:
        'The thread’s `comment_count` and each item’s `reply_count` are read from the Redis counters the write path keeps (`counters.get(...)`), not guessed from the page length.',
      match: {
        python: {all: [/def thread_count\(/, /def reply_counts\(/, /counters\.get\(/]},
        typescript: {all: [/function threadCount\(/, /function replyCounts\(/, /counters\.get\(/]},
        go: {all: [/func threadCount\(/, /func replyCounts\(/, /Counters\.Get\(/]},
        scala: {all: [/def threadCount\(/, /def replyCounts\(/, /counters\.get\(/]},
        cpp: {all: [/threadCount\(/, /replyCounts\(/, /counters\.get\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse

app = FastAPI()
counters = redis.Redis(host="redis", port=6379, decode_responses=True)

PAGE_SIZE = 20


class CommentStore:
    def page(self, thread_id: str, offset: int, limit: int) -> list[dict]:
        """The next window of top-level comments for this thread."""
        raise NotImplementedError


store = CommentStore()


@app.get("/v1/threads/{thread_id}/comments")
def list_comments(
    thread_id: str,
    tenant: str = Header(default="", alias="X-Tenant-Id"),
    offset: int = Query(default=0),
) -> JSONResponse:
    # TODO: this draft paginates by offset, so a comment posted while the reader scrolls shifts the
    # window: one comment is skipped and another is shown twice. It also returns deleted comments
    # with their text and reports no counters at all. Review all three.
    rows = store.page(thread_id, offset, PAGE_SIZE)
    return JSONResponse({"comments": [serialize_comment(row) for row in rows], "next_offset": offset + PAGE_SIZE})


def serialize_comment(row: dict) -> dict:
    return row
`,
      solution: `import base64

import redis
from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse

app = FastAPI()
counters = redis.Redis(host="redis", port=6379, decode_responses=True)

PAGE_SIZE = 20
FIRST_CURSOR = ("1970-01-01T00:00:00+00:00", "")
SQL_PAGE = """
SELECT id, parent_id, created_at, revision, deleted, reply_count, text
FROM comments
WHERE thread_id = $1 AND parent_id IS NULL AND (created_at, id) > ($2, $3)
ORDER BY created_at, id
LIMIT $4
"""


class CommentStore:
    def page_keyset(self, thread_id: str, created_at: str, comment_id: str, limit: int) -> list[dict]:
        """Rows after a position: the keyset predicate above, never an offset."""
        raise NotImplementedError


store = CommentStore()


def encode_cursor(row: dict) -> str:
    """A cursor is the last row's (created_at, id) — a position, not a count of rows."""
    return base64.urlsafe_b64encode(f"{row['created_at']}|{row['id']}".encode()).decode()


def decode_cursor(cursor: str | None) -> tuple[str, str]:
    """The (created_at, id) position to resume after; the epoch and an empty id for page one."""
    if cursor is None or cursor == "":
        return FIRST_CURSOR
    created_at, comment_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|", 1)
    return (created_at, comment_id)


def serialize_comment(row: dict) -> dict:
    """A deleted comment is a tombstone: identity and reply count, never its text."""
    if row["deleted"]:
        return {
            "id": row["id"],
            "parent_id": row["parent_id"],
            "deleted": True,
            "reply_count": row["reply_count"],
        }
    return {
        "id": row["id"],
        "parent_id": row["parent_id"],
        "created_at": row["created_at"],
        "deleted": False,
        "reply_count": row["reply_count"],
        "text": row["text"],
    }


def thread_count(tenant: str, thread_id: str) -> int:
    """The same counter the write path keeps: the UI never counts a page and calls it a total."""
    return int(counters.get(f"thread:{tenant}:{thread_id}:count") or 0)


def reply_counts(tenant: str, thread_id: str, comment_ids: list[str]) -> dict[str, int]:
    """Per-comment reply counters, read from the keys the comment write commits with."""
    return {
        comment_id: int(counters.get(f"thread:{tenant}:{thread_id}:replies:{comment_id}") or 0)
        for comment_id in comment_ids
    }


@app.get("/v1/threads/{thread_id}/comments")
def list_comments(
    thread_id: str,
    tenant: str = Header(default="", alias="X-Tenant-Id"),
    cursor: str | None = Query(default=None),
) -> JSONResponse:
    created_at, comment_id = decode_cursor(cursor)
    rows = store.page_keyset(thread_id, created_at, comment_id, PAGE_SIZE)
    counts = reply_counts(tenant, thread_id, [row["id"] for row in rows])
    comments = [{**serialize_comment(row), "reply_count": counts[row["id"]]} for row in rows]
    next_cursor = encode_cursor(rows[-1]) if len(rows) == PAGE_SIZE else None
    return JSONResponse(
        {
            "comments": comments,
            "next_cursor": next_cursor,
            "comment_count": thread_count(tenant, thread_id),
        }
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/threads/:id/comments: a model-generated draft that pages by offset. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const PAGE_SIZE = 20;

interface CommentRow {
  id: string;
  parent_id: string | null;
  created_at: string;
  deleted: boolean;
  reply_count: number;
  text: string;
}

app.get('/v1/threads/:id/comments', async (request, reply) => {
  // TODO: this draft paginates by offset, so a comment posted while the reader scrolls shifts the
  // window: one comment is skipped and another is shown twice. It also returns deleted comments
  // with their text and reports no counters at all. Review all three.
  const {id} = request.params as {id: string};
  const offset = Number((request.query as {offset?: string}).offset ?? 0);
  const rows = await store.page(id, offset, PAGE_SIZE);
  return reply.code(200).send({comments: rows.map((row: CommentRow) => row), next_offset: offset + PAGE_SIZE});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/threads/:id/comments: keyset pagination, tombstones and counter-backed totals. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const counters = new Redis('redis://redis:6379');

const PAGE_SIZE = 20;
const FIRST_CURSOR = ['1970-01-01T00:00:00.000Z', ''] as const;
const SQL_PAGE = \`
SELECT id, parent_id, created_at, revision, deleted, reply_count, text
FROM comments
WHERE thread_id = $1 AND parent_id IS NULL AND (created_at, id) > ($2, $3)
ORDER BY created_at, id
LIMIT $4
\`;

interface CommentRow {
  id: string;
  parent_id: string | null;
  created_at: string;
  deleted: boolean;
  reply_count: number;
  text: string;
}

/** A cursor is the last row's (created_at, id) — a position, not a count of rows. */
function encodeCursor(row: CommentRow): string {
  return Buffer.from(\`\${row.created_at}|\${row.id}\`, 'utf8').toString('base64url');
}

/** The (created_at, id) position to resume after; the epoch and an empty id for page one. */
function decodeCursor(cursor: string | null): [string, string] {
  if (cursor === null || cursor === '') return [FIRST_CURSOR[0], FIRST_CURSOR[1]];
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return [createdAt, id ?? ''];
}

/** A deleted comment is a tombstone: identity and reply count, never its text. */
function serializeComment(row: CommentRow): Record<string, unknown> {
  if (row.deleted) return {id: row.id, parent_id: row.parent_id, deleted: true, reply_count: row.reply_count};
  return {
    id: row.id,
    parent_id: row.parent_id,
    created_at: row.created_at,
    deleted: false,
    reply_count: row.reply_count,
    text: row.text,
  };
}

/** The same counter the write path keeps: the UI never counts a page and calls it a total. */
async function threadCount(tenant: string, threadId: string): Promise<number> {
  return Number((await counters.get(\`thread:\${tenant}:\${threadId}:count\`)) ?? 0);
}

/** Per-comment reply counters, read from the keys the comment write commits with. */
async function replyCounts(tenant: string, threadId: string, ids: string[]): Promise<Record<string, number>> {
  const values = await Promise.all(ids.map(id => counters.get(\`thread:\${tenant}:\${threadId}:replies:\${id}\`)));
  return Object.fromEntries(ids.map((id, index) => [id, Number(values[index] ?? 0)]));
}

app.get('/v1/threads/:id/comments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const [createdAt, commentId] = decodeCursor((request.query as {cursor?: string}).cursor ?? null);
  const rows: CommentRow[] = await store.pageKeyset(id, createdAt, commentId, PAGE_SIZE, SQL_PAGE);
  const counts = await replyCounts(tenant, id, rows.map(row => row.id));
  const nextCursor = rows.length === PAGE_SIZE ? encodeCursor(rows[rows.length - 1]) : null;
  return reply.code(200).send({
    comments: rows.map(row => ({...serializeComment(row), reply_count: counts[row.id]})),
    next_cursor: nextCursor,
    comment_count: await threadCount(tenant, id),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
)

const pageSize = 20

type CommentRow struct {
	ID         string
	ParentID   *string
	CreatedAt  string
	Deleted    bool
	ReplyCount int
	Text       string
}

type CommentStore struct{}

func (s *CommentStore) Page(ctx context.Context, threadID string, offset, limit int) []CommentRow {
	return nil
}

var store = &CommentStore{}

func listComments(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft paginates by offset, so a comment posted while the reader scrolls shifts the
	// window: one comment is skipped and another is shown twice. It also returns deleted comments
	// with their text and reports no counters at all. Review all three.
	threadID := r.PathValue("id")
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	rows := store.Page(r.Context(), threadID, offset, pageSize)
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"comments": rows, "next_offset": offset + pageSize})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/threads/{id}/comments", listComments)
}
`,
      solution: `package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"
)

const pageSize = 20

const sqlPage = \`
SELECT id, parent_id, created_at, revision, deleted, reply_count, text
FROM comments
WHERE thread_id = $1 AND parent_id IS NULL AND (created_at, id) > ($2, $3)
ORDER BY created_at, id
LIMIT $4
\`

var (
	Counters *redis.Client
	firstCursor = struct{ created, id string }{"1970-01-01T00:00:00Z", ""}
)

type CommentRow struct {
	ID         string
	ParentID   *string
	CreatedAt  string
	Deleted    bool
	ReplyCount int
	Text       string
}

// encodeCursor turns the last row of a page into a position: (created_at, id), never a count.
func encodeCursor(row CommentRow) string {
	return base64.RawURLEncoding.EncodeToString([]byte(row.CreatedAt + "|" + row.ID))
}

// decodeCursor turns a token back into the position to resume after.
func decodeCursor(cursor string) (string, string) {
	if cursor == "" {
		return firstCursor.created, firstCursor.id
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return firstCursor.created, firstCursor.id
	}
	parts := strings.SplitN(string(raw), "|", 2)
	return parts[0], parts[1]
}

// serializeComment renders a deleted comment as a tombstone: identity and reply count, never text.
func serializeComment(row CommentRow) map[string]any {
	if row.Deleted {
		return map[string]any{
			"id":          row.ID,
			"parent_id":   row.ParentID,
			"deleted":     true,
			"reply_count": row.ReplyCount,
		}
	}
	return map[string]any{
		"id":          row.ID,
		"parent_id":   row.ParentID,
		"created_at":  row.CreatedAt,
		"deleted":     false,
		"reply_count": row.ReplyCount,
		"text":        row.Text,
	}
}

// threadCount reads the counter the write path commits with: the UI never counts a page instead.
func threadCount(ctx context.Context, tenant, threadID string) int {
	value, _ := Counters.Get(ctx, "thread:"+tenant+":"+threadID+":count").Int()
	return value
}

// replyCounts reads the per-comment counters the comment write commits with.
func replyCounts(ctx context.Context, tenant, threadID string, ids []string) map[string]int {
	counts := make(map[string]int, len(ids))
	for _, commentID := range ids {
		value, _ := Counters.Get(ctx, "thread:"+tenant+":"+threadID+":replies:"+commentID).Int()
		counts[commentID] = value
	}
	return counts
}

func listComments(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	threadID := r.PathValue("id")
	createdAt, commentID := decodeCursor(r.URL.Query().Get("cursor"))
	rows := store.PageKeyset(r.Context(), threadID, createdAt, commentID, pageSize, sqlPage)
	ids := make([]string, 0, len(rows))
	comments := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		comments = append(comments, serializeComment(row))
	}
	counts := replyCounts(r.Context(), tenant, threadID, ids)
	for index, id := range ids {
		comments[index]["reply_count"] = counts[id]
	}
	var nextCursor any
	if len(rows) == pageSize {
		nextCursor = encodeCursor(rows[len(rows)-1])
	}
	payload := map[string]any{
		"comments":      comments,
		"next_cursor":   nextCursor,
		"comment_count": threadCount(r.Context(), tenant, threadID),
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/threads/{id}/comments", listComments)
}
`,
    },
    scala: {
      starter: `import spray.json._

object CommentRead {
  val PageSize = 20
  val store = CommentStore.open()

  // TODO: this draft paginates by offset, so a comment posted while the reader scrolls shifts the
  // window: one comment is skipped and another is shown twice. It also returns deleted comments
  // with their text and reports no counters at all. Review all three.
  def list(threadId: String, offset: Long): String = {
    val rows = store.page(threadId, offset, PageSize)
    s"""{"comments":\${rows.map(_.toJson.compactPrint).mkString("[", ",", "]")},"next_offset":\${offset + PageSize}}"""
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.Base64

import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

final case class CommentRow(
    id: String,
    parent_id: Option[String],
    created_at: String,
    deleted: Boolean,
    reply_count: Int,
    text: String
)

object CommentRead {
  val PageSize = 20
  val FirstCursor = ("1970-01-01T00:00:00Z", "")

  val SqlPage =
    """
      |SELECT id, parent_id, created_at, revision, deleted, reply_count, text
      |FROM comments
      |WHERE thread_id = $1 AND parent_id IS NULL AND (created_at, id) > ($2, $3)
      |ORDER BY created_at, id
      |LIMIT $4
      |""".stripMargin

  val counters = new Jedis("redis", 6379)
  val store = CommentStore.open()

  /** A cursor is the last row's (created_at, id) — a position, not a count of rows. */
  def encodeCursor(row: CommentRow): String =
    Base64.getUrlEncoder.withoutPadding.encodeToString(s"\${row.created_at}|\${row.id}".getBytes(StandardCharsets.UTF_8))

  /** The (created_at, id) position to resume after; the epoch and an empty id for page one. */
  def decodeCursor(cursor: Option[String]): (String, String) = cursor match {
    case None | Some("") => FirstCursor
    case Some(value) =>
      val parts = new String(Base64.getUrlDecoder.decode(value), StandardCharsets.UTF_8).split("\\|", 2)
      (parts(0), parts(1))
  }

  /** A deleted comment is a tombstone: identity and reply count, never its text. */
  def serializeComment(row: CommentRow): JsObject =
    if (row.deleted) {
      JsObject(
        "id" -> JsString(row.id),
        "parent_id" -> row.parent_id.map(JsString(_)).getOrElse(JsNull),
        "deleted" -> JsBoolean(true),
        "reply_count" -> JsNumber(row.reply_count)
      )
    } else {
      JsObject(
        "id" -> JsString(row.id),
        "parent_id" -> row.parent_id.map(JsString(_)).getOrElse(JsNull),
        "created_at" -> JsString(row.created_at),
        "deleted" -> JsBoolean(false),
        "reply_count" -> JsNumber(row.reply_count),
        "text" -> JsString(row.text)
      )
    }

  /** The counter the write path commits with: the UI never counts a page and calls it a total. */
  def threadCount(tenant: String, threadId: String): Long =
    Option(counters.get(s"thread:$tenant:$threadId:count")).map(_.toLong).getOrElse(0L)

  /** The per-comment reply counters the comment write commits with. */
  def replyCounts(tenant: String, threadId: String, ids: List[String]): Map[String, Long] =
    ids.map(id => id -> Option(counters.get(s"thread:$tenant:$threadId:replies:$id")).map(_.toLong).getOrElse(0L)).toMap

  val route: Route =
    path("v1" / "threads" / Segment / "comments") { threadId =>
      get {
        parameter("cursor".?) { cursorOpt =>
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            val tenant = tenantOpt.getOrElse("")
            val (createdAt, commentId) = decodeCursor(cursorOpt)
            val rows = store.pageKeyset(threadId, createdAt, commentId, PageSize, SqlPage)
            val counts = replyCounts(tenant, threadId, rows.map(_.id))
            val comments = rows.map { row =>
              JsObject(serializeComment(row).fields + ("reply_count" -> JsNumber(counts.getOrElse(row.id, 0L))))
            }
            val nextCursor = if (rows.size == PageSize) Some(encodeCursor(rows.last)) else None
            val payload = JsObject(
              "comments" -> JsArray(comments.toVector),
              "next_cursor" -> nextCursor.map(JsString(_)).getOrElse(JsNull),
              "comment_count" -> JsNumber(threadCount(tenant, threadId))
            )
            complete(StatusCodes.OK, payload.compactPrint)
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

using json = nlohmann::json;

constexpr int kPageSize = 20;

// TODO: this draft paginates by offset, so a comment posted while the reader scrolls shifts the
// window: one comment is skipped and another is shown twice. It also returns deleted comments with
// their text and reports no counters at all. Review all three.
void listComments(CommentStore& store, const httplib::Request& req, httplib::Response& res) {
  const auto threadId = req.matches[1];
  const int offset = req.has_param("offset") ? std::stoi(req.get_param_value("offset")) : 0;
  const auto rows = store.page(threadId, offset, kPageSize);
  res.status = 200;
  res.set_content(json{{"comments", rows}, {"next_offset", offset + kPageSize}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;
  CommentStore store;
  svr.Get(R"(/v1/threads/([^/]+)/comments)", [&store](const httplib::Request& req, httplib::Response& res) {
    listComments(store, req, res);
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <regex>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kPageSize = 20;
const std::regex kListPath("/v1/threads/([^/]+)/comments");

const char* kSqlPage = R"SQL(
SELECT id, parent_id, created_at, revision, deleted, reply_count, text
FROM comments
WHERE thread_id = $1 AND parent_id IS NULL AND (created_at, id) > ($2, $3)
ORDER BY created_at, id
LIMIT $4
)SQL";

struct CommentRow {
  std::string id;
  std::string parentId;
  std::string createdAt;
  bool deleted = false;
  int replyCount = 0;
  std::string text;
};

std::string base64UrlEncode(const std::string& raw);
std::string base64UrlDecode(const std::string& token);

// encodeCursor turns the last row of a page into a position: (created_at, id), never a count.
std::string encodeCursor(const CommentRow& row) { return base64UrlEncode(row.createdAt + "|" + row.id); }

// decodeCursor turns a token back into the position to resume after.
std::pair<std::string, std::string> decodeCursor(const std::string& cursor) {
  if (cursor.empty()) return {"1970-01-01T00:00:00Z", ""};
  const auto raw = base64UrlDecode(cursor);
  const auto at = raw.find('|');
  if (at == std::string::npos) return {"1970-01-01T00:00:00Z", ""};
  return {raw.substr(0, at), raw.substr(at + 1)};
}

// serializeComment renders a deleted comment as a tombstone: identity and reply count, never text.
json serializeComment(const CommentRow& row) {
  if (row.deleted) {
    return json{{"id", row.id}, {"parent_id", row.parentId}, {"deleted", true}, {"reply_count", row.replyCount}};
  }
  return json{{"id", row.id},
              {"parent_id", row.parentId},
              {"created_at", row.createdAt},
              {"deleted", false},
              {"reply_count", row.replyCount},
              {"text", row.text}};
}

// threadCount reads the counter the write path commits with: the UI never counts a page instead.
int threadCount(sw::redis::Redis& counters, const std::string& tenant, const std::string& threadId) {
  return std::stoi(counters.get("thread:" + tenant + ":" + threadId + ":count").value_or("0"));
}

// replyCounts reads the per-comment counters the comment write commits with.
std::map<std::string, int> replyCounts(
    sw::redis::Redis& counters,
    const std::string& tenant,
    const std::string& threadId,
    const std::vector<std::string>& ids) {
  std::map<std::string, int> counts;
  for (const auto& id : ids) {
    counts[id] = std::stoi(counters.get("thread:" + tenant + ":" + threadId + ":replies:" + id).value_or("0"));
  }
  return counts;
}

int main() {
  sw::redis::Redis counters("tcp://redis:6379");
  httplib::Server svr;
  CommentStore store;

  svr.Get(kListPath, [&store, &counters](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto threadId = req.matches[1].str();
    const auto [createdAt, commentId] = decodeCursor(req.has_param("cursor") ? req.get_param_value("cursor") : "");
    const auto rows = store.pageKeyset(threadId, createdAt, commentId, kPageSize, kSqlPage);
    std::vector<std::string> ids;
    json comments = json::array();
    for (const auto& row : rows) {
      ids.push_back(row.id);
      comments.push_back(serializeComment(row));
    }
    const auto counts = replyCounts(counters, tenant, threadId, ids);
    for (auto& comment : comments) {
      comment["reply_count"] = counts.at(comment["id"].get<std::string>());
    }
    json payload = {
        {"comments", comments},
        {"next_cursor", rows.size() == static_cast<std::size_t>(kPageSize) ? json(encodeCursor(rows.back())) : json(nullptr)},
        {"comment_count", threadCount(counters, tenant, threadId)},
    };
    res.status = 200;
    res.set_content(payload.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A cursor is a position, not a count: encode `(created_at, id)` of the last row, decode it into the `WHERE (created_at, id) > ($2, $3)` predicate, and order by the same pair. `OFFSET` re-counts rows on every request, so any insert above the window moves what "20" means.',
    'Reply counts and the thread total are not page arithmetic. Read `thread:{tenant}:{thread_id}:count` and `thread:{tenant}:{thread_id}:replies:{comment_id}` from Redis — the same keys the write path commits with — so the numbers the UI shows cannot drift from the counters the service keeps.',
    'Deleted comments must not vanish from a page: a missing row breaks the reply tree, and its text is content the author retracted. Serialise a tombstone — id, parent, reply count, `deleted: true` — and prove the walk never repeats a comment while new ones land.',
  ],
  debrief: `The interviewer is asking whether you can keep a promise across a page walk. Offset pagination has no way to do it: the offset is a count of rows, and rows move, so a busy thread serves one comment twice and skips another — exactly the bug users report. A keyset cursor is stable because it names a position, and it also gives the database an index range scan instead of a sort-and-skip. The two other contracts belong to the read path because that is where they are visible: a deleted comment has to stay in the tree as a tombstone without its text, and the totals the UI shows have to come from the counters the write path committed, or the page and the badge will disagree forever. Real services add a stable secondary sort for ties, a snapshot revision so a long scroll is self-consistent, and precomputed reply counts for the first page of a popular thread.`,
};
