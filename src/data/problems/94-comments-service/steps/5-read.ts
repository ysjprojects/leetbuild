import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET a thread: cursor pages, tombstones and counts from the counters',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/threads/{thread_id}/comments\` (tenant from
\`X-Tenant-Id\`, 401 without one). It reads \`cursor\` as a row offset, takes \`PAGE_SIZE\` (20) ids
newest first with \`ZREVRANGE\` on the thread's index, loads them with \`store.get_many\`, and
answers \`{comments, next_cursor, comment_count}\` with \`next_cursor\` = offset + 20,
\`comment_count\` = the page's length, and each \`reply_count\` counting replies on the same page.
It serves the demo and hides three flaws.

**Failure mode the checks target.** Three comments arrive while a reader is on page 1, and page 2
repeats three comments; the last page still offers a next one; a deleted comment's author and text
are still served; the badge says 20 on a thread of 25, and a comment whose replies sit on another
page shows none.

- \`next_cursor\` is opaque (\`encode_cursor\`) and resumes after the last row's \`seq\`:
  \`ZREVRANGEBYSCORE index (seq -inf LIMIT 0 PAGE_SIZE\`. It is \`null\` when the page is not
  full; a cursor \`decode_cursor\` cannot read is 400.
- A deleted comment keeps its place as a tombstone: \`id\`, \`parent_id\`, \`created_at\`,
  \`revision\`, \`reply_count\`, \`deleted: true\`, and no \`author_id\`, \`text\` or \`html\`.
- \`comment_count\` is \`threads.thread_count\`; each \`reply_count\` comes from
  \`threads.reply_counts\`.`,
  sequence: {
    participants: ['Client', 'Comments API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Comments API', label: 'GET /v1/threads/t-1/comments?cursor=…', kind: 'sync'},
      {from: 'Comments API', to: 'Comments API', label: 'decode_cursor → seq · else 400', kind: 'sync'},
      {from: 'Comments API', to: 'Redis', label: 'ZREVRANGEBYSCORE index (seq -inf LIMIT 0 20', kind: 'sync'},
      {from: 'Comments API', to: 'Redis', label: 'MGET comments · HMGET replies · GET count', kind: 'sync'},
      {
        from: 'Comments API',
        to: 'Client',
        label: '200 {comments (tombstones without text), next_cursor, comment_count}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/threads/{thread_id}/comments',
      detail:
        'A thread’s comments come back newest first for the tenant in `X-Tenant-Id`; a request without one is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/threads\/\{thread_id\}\/comments["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/threads\/:threadId\/comments['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/threads\/\{id\}\/comments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"threads"\s*\/\s*Segment\s*\/\s*"comments"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/threads\//]},
      },
    },
    {
      id: 'cursor',
      title: 'Pages resume after a position, not an offset',
      detail:
        '`next_cursor` encodes the last row’s `seq` and the next page starts strictly below it (`ZREVRANGEBYSCORE (seq -inf LIMIT 0 PAGE_SIZE`), so comments posted meanwhile neither repeat nor shift a page; it is null on a page that is not full, and an unreadable cursor is 400. The starter counts rows, which move.',
      match: {
        python: {all: [/zrevrangebyscore\(/, /def encode_cursor/, /def decode_cursor/], none: [/\boffset\b/]},
        typescript: {
          all: [/zrevrangebyscore\(/, /function encodeCursor/, /function decodeCursor/],
          none: [/\boffset\b/],
        },
        go: {all: [/ZRevRangeByScore\(/, /func encodeCursor/, /func decodeCursor/], none: [/\boffset\b/]},
        scala: {all: [/zrevrangeByScore\(/, /def encodeCursor/, /def decodeCursor/], none: [/\boffset\b/]},
        cpp: {all: [/zrevrangebyscore\(/, /encodeCursor\(/, /decodeCursor\(/], none: [/\boffset\b/]},
      },
    },
    {
      id: 'tombstone',
      title: 'A deleted comment is a tombstone without its words',
      detail:
        'A deleted comment stays in the page (its replies still point at it) with `deleted: true` and its ids, revision and reply count, but no `author_id`, `text` or `html`. The starter serves the row as stored.',
      match: {
        python: {all: [/def serialize_comment/, /if row\[["']deleted["']\]/]},
        typescript: {all: [/function serializeComment/, /if \(row\.deleted\)/]},
        go: {all: [/func serializeComment/, /if row\.Deleted/]},
        scala: {all: [/def serializeComment/, /if \(row\.deleted\)/]},
        cpp: {all: [/serializeComment\(/, /if \(row\.deleted\)/]},
      },
    },
    {
      id: 'counts',
      title: 'Counts come from the counters, not the page',
      detail:
        '`comment_count` is the thread counter (`threads.thread_count`) and each `reply_count` the replies hash (`threads.reply_counts`), so both hold on every page. The starter counts what happens to be on the page.',
      match: {
        python: {
          all: [/threads\.thread_count\(/, /threads\.reply_counts\(/],
          none: [/["']comment_count["']\s*:\s*len\(/],
        },
        typescript: {all: [/threadCount\(/, /replyCounts\(/], none: [/comment_count:\s*rows\.length/]},
        go: {all: [/threads\.ThreadCount\(/, /threads\.ReplyCounts\(/], none: [/"comment_count":\s*len\(/]},
        scala: {
          all: [/Threads\.threadCount\(/, /Threads\.replyCounts\(/],
          none: [/"comment_count"\s*->\s*JsNumber\(rows\.size\)/],
        },
        cpp: {
          all: [/threads::threadCount\(/, /threads::replyCounts\(/],
          none: [/\{"comment_count",\s*rows\.size\(\)\}/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from comments import store  # store.index_key, get_many
from comments import threads  # threads.thread_count, reply_counts

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

PAGE_SIZE = 20


def serialize_comment(row: dict, page: list[dict]) -> dict:
    return {
        "id": row["id"],
        "parent_id": row["parent_id"],
        "author_id": row["author_id"],
        "text": row["text"],
        "html": row["html"],
        "created_at": row["created_at"],
        "revision": row["revision"],
        "deleted": row["deleted"],
        "reply_count": sum(1 for other in page if other["parent_id"] == row["id"]),
    }


@app.get("/v1/threads/{thread_id}/comments")
def list_comments(thread_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    offset = int(request.query_params.get("cursor") or 0)
    ids = r.zrevrange(store.index_key(tenant, thread_id), offset, offset + PAGE_SIZE - 1)
    rows = [row for row in store.get_many(tenant, ids) if row is not None]
    return JSONResponse({
        "comments": [serialize_comment(row, rows) for row in rows],
        "next_cursor": str(offset + PAGE_SIZE),
        "comment_count": len(rows),
    })
`,
      solution: `import base64

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from comments import store  # store.index_key, get_many
from comments import threads  # threads.thread_count, reply_counts

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

PAGE_SIZE = 20


def encode_cursor(seq: int) -> str:
    """An opaque position: the page resumes strictly below this seq."""
    return base64.urlsafe_b64encode(f"seq:{seq}".encode()).decode()


def decode_cursor(cursor: str) -> int:
    """The seq a cursor resumes below; ValueError when it is not one of ours."""
    raw = base64.urlsafe_b64decode(cursor.encode()).decode()
    if not raw.startswith("seq:"):
        raise ValueError(cursor)
    return int(raw[4:])


def serialize_comment(row: dict, reply_count: int) -> dict:
    item = {
        "id": row["id"],
        "parent_id": row["parent_id"],
        "created_at": row["created_at"],
        "revision": row["revision"],
        "reply_count": reply_count,
        "deleted": row["deleted"],
    }
    if row["deleted"]:
        return item  # a tombstone keeps its place and its replies, not its words
    return {**item, "author_id": row["author_id"], "text": row["text"], "html": row["html"]}


@app.get("/v1/threads/{thread_id}/comments")
def list_comments(thread_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    cursor = request.query_params.get("cursor")
    try:
        top = f"({decode_cursor(cursor)}" if cursor else "+inf"
    except ValueError:
        return JSONResponse({"error": "unreadable cursor"}, status_code=400)
    # A position, not a count: comments posted meanwhile land above it and shift nothing.
    ids = r.zrevrangebyscore(store.index_key(tenant, thread_id), top, "-inf", start=0, num=PAGE_SIZE)
    rows = [row for row in store.get_many(tenant, ids) if row is not None]
    counts = threads.reply_counts(tenant, thread_id, [row["id"] for row in rows])
    return JSONResponse({
        "comments": [serialize_comment(row, counts[row["id"]]) for row in rows],
        "next_cursor": encode_cursor(rows[-1]["seq"]) if len(rows) == PAGE_SIZE else None,
        "comment_count": threads.thread_count(tenant, thread_id),
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {type Comment, getMany, indexKey} from 'comments/store';
import {replyCounts, threadCount} from 'comments/threads';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const PAGE_SIZE = 20;

export function serializeComment(row: Comment, page: Comment[]) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    author_id: row.author_id,
    text: row.text,
    html: row.html,
    created_at: row.created_at,
    revision: row.revision,
    deleted: row.deleted,
    reply_count: page.filter(other => other.parent_id === row.id).length,
  };
}

app.get('/v1/threads/:threadId/comments', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {threadId} = request.params as {threadId: string};
  const {cursor} = request.query as {cursor?: string};
  const offset = Number(cursor ?? 0) || 0;
  const ids = await redis.zrevrange(indexKey(tenant, threadId), offset, offset + PAGE_SIZE - 1);
  const rows = (await getMany(tenant, ids)).filter((row): row is Comment => row !== null);
  return {comments: rows.map(row => serializeComment(row, rows)), next_cursor: String(offset + PAGE_SIZE), comment_count: rows.length};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {type Comment, getMany, indexKey} from 'comments/store';
import {replyCounts, threadCount} from 'comments/threads';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const PAGE_SIZE = 20;

/** An opaque position: the page resumes strictly below this seq. */
export function encodeCursor(seq: number): string {
  return Buffer.from(\`seq:\${seq}\`).toString('base64url');
}

/** The seq a cursor resumes below, or null when it is not one of ours. */
export function decodeCursor(cursor: string): number | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^seq:\\d+$/.test(raw) ? Number(raw.slice(4)) : null;
}

export function serializeComment(row: Comment, replyCount: number) {
  const item = {id: row.id, parent_id: row.parent_id, created_at: row.created_at, revision: row.revision, reply_count: replyCount, deleted: row.deleted};
  if (row.deleted) return item; // a tombstone keeps its place and its replies, not its words
  return {...item, author_id: row.author_id, text: row.text, html: row.html};
}

app.get('/v1/threads/:threadId/comments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {threadId} = request.params as {threadId: string};
  const {cursor} = request.query as {cursor?: string};
  const below = cursor === undefined || cursor === '' ? null : decodeCursor(cursor);
  if (cursor && below === null) return reply.code(400).send({error: 'unreadable cursor'});
  // A position, not a count: comments posted meanwhile land above it and shift nothing.
  const ids = await redis.zrevrangebyscore(indexKey(tenant, threadId), below === null ? '+inf' : \`(\${below}\`, '-inf', 'LIMIT', 0, PAGE_SIZE);
  const rows = (await getMany(tenant, ids)).filter((row): row is Comment => row !== null);
  const counts = await replyCounts(tenant, threadId, rows.map(row => row.id));
  return {
    comments: rows.map(row => serializeComment(row, counts[row.id] ?? 0)),
    next_cursor: rows.length === PAGE_SIZE ? encodeCursor(rows[rows.length - 1].seq) : null,
    comment_count: await threadCount(tenant, threadId),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"comments/store" // store.Comment, IndexKey, GetMany
)

const pageSize = 20

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func serializeComment(row store.Comment, page []store.Comment) map[string]any {
	replies := 0
	for _, other := range page {
		if other.ParentID == row.ID {
			replies++
		}
	}
	return map[string]any{
		"id": row.ID, "parent_id": row.ParentID, "author_id": row.AuthorID, "text": row.Text, "html": row.HTML,
		"created_at": row.CreatedAt, "revision": row.Revision, "deleted": row.Deleted, "reply_count": replies,
	}
}

func listComments(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	threadID := r.PathValue("id")
	offset, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	ids, err := rdb.ZRevRange(r.Context(), store.IndexKey(tenant, threadID), offset, offset+pageSize-1).Result()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	var rows []store.Comment
	for _, row := range store.GetMany(r.Context(), tenant, ids) {
		if row != nil {
			rows = append(rows, *row)
		}
	}
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, serializeComment(row, rows))
	}
	writeJSON(rw, http.StatusOK, map[string]any{"comments": items, "next_cursor": strconv.FormatInt(offset+pageSize, 10), "comment_count": len(rows)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/threads/{id}/comments", listComments)
}
`,
      solution: `package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"comments/store"   // store.Comment, IndexKey, GetMany
	"comments/threads" // threads.ThreadCount, ReplyCounts
)

const pageSize = 20

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// encodeCursor is an opaque position: the page resumes strictly below this seq.
func encodeCursor(seq int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("seq:%d", seq)))
}

// decodeCursor is the seq a cursor resumes below; an error when it is not one of ours.
func decodeCursor(cursor string) (int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || !strings.HasPrefix(string(raw), "seq:") {
		return 0, fmt.Errorf("unreadable cursor %q", cursor)
	}
	return strconv.ParseInt(string(raw[4:]), 10, 64)
}

func serializeComment(row store.Comment, replyCount int64) map[string]any {
	item := map[string]any{
		"id": row.ID, "parent_id": row.ParentID, "created_at": row.CreatedAt, "revision": row.Revision,
		"reply_count": replyCount, "deleted": row.Deleted,
	}
	if row.Deleted {
		return item // a tombstone keeps its place and its replies, not its words
	}
	item["author_id"], item["text"], item["html"] = row.AuthorID, row.Text, row.HTML
	return item
}

func listComments(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	threadID := r.PathValue("id")
	top := "+inf"
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		below, err := decodeCursor(cursor)
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unreadable cursor"})
			return
		}
		top = fmt.Sprintf("(%d", below)
	}
	// A position, not a count: comments posted meanwhile land above it and shift nothing.
	ids, err := rdb.ZRevRangeByScore(r.Context(), store.IndexKey(tenant, threadID), &redis.ZRangeBy{Max: top, Min: "-inf", Count: pageSize}).Result()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	var rows []store.Comment
	for _, row := range store.GetMany(r.Context(), tenant, ids) {
		if row != nil {
			rows = append(rows, *row)
		}
	}
	rowIDs := make([]string, len(rows))
	for i, row := range rows {
		rowIDs[i] = row.ID
	}
	counts := threads.ReplyCounts(r.Context(), tenant, threadID, rowIDs)
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, serializeComment(row, counts[row.ID]))
	}
	var next any
	if len(rows) == pageSize {
		next = encodeCursor(rows[len(rows)-1].Seq)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"comments": items, "next_cursor": next, "comment_count": threads.ThreadCount(r.Context(), tenant, threadID)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/threads/{id}/comments", listComments)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import comments.{Store, Threads} // Store.Comment, indexKey, getMany; Threads.threadCount, replyCounts

object Read {
  val PageSize = 20
  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  def serializeComment(row: Store.Comment, page: Seq[Store.Comment]): JsObject = JsObject(
    "id" -> JsString(row.id), "parent_id" -> JsString(row.parentId), "author_id" -> JsString(row.authorId),
    "text" -> JsString(row.text), "html" -> JsString(row.html), "created_at" -> JsNumber(row.createdAt),
    "revision" -> JsNumber(row.revision), "deleted" -> JsBoolean(row.deleted),
    "reply_count" -> JsNumber(page.count(_.parentId == row.id)))

  val route: Route =
    path("v1" / "threads" / Segment / "comments") { threadId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          parameter("cursor".optional) { cursor =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val tenant = tenantHeader.getOrElse("")
            if (tenant.isEmpty) complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
            else {
              val offset = cursor.flatMap(_.toLongOption).getOrElse(0L)
              val ids = jedis.zrevrange(Store.indexKey(tenant, threadId), offset, offset + PageSize - 1).asScala.toSeq
              val rows = Store.getMany(tenant, ids).flatten
              complete(json(StatusCodes.OK, JsObject(
                "comments" -> JsArray(rows.map(serializeComment(_, rows)).toVector),
                "next_cursor" -> JsString((offset + PageSize).toString),
                "comment_count" -> JsNumber(rows.size))))
            }
          }
        }
      }
    }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.util.Base64

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._
import scala.util.Try

import comments.{Store, Threads} // Store.Comment, indexKey, getMany; Threads.threadCount, replyCounts

object Read {
  val PageSize = 20
  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** An opaque position: the page resumes strictly below this seq. */
  def encodeCursor(seq: Long): String = Base64.getUrlEncoder.withoutPadding.encodeToString(s"seq:$seq".getBytes(UTF_8))

  /** The seq a cursor resumes below, if it is one of ours. */
  def decodeCursor(cursor: String): Option[Long] =
    Try(new String(Base64.getUrlDecoder.decode(cursor), UTF_8)).toOption.filter(_.startsWith("seq:")).flatMap(_.drop(4).toLongOption)

  def serializeComment(row: Store.Comment, replyCount: Long): JsObject = {
    val item = JsObject(
      "id" -> JsString(row.id), "parent_id" -> JsString(row.parentId), "created_at" -> JsNumber(row.createdAt),
      "revision" -> JsNumber(row.revision), "reply_count" -> JsNumber(replyCount), "deleted" -> JsBoolean(row.deleted))
    if (row.deleted) item // a tombstone keeps its place and its replies, not its words
    else JsObject(item.fields ++ Map("author_id" -> JsString(row.authorId), "text" -> JsString(row.text), "html" -> JsString(row.html)))
  }

  val route: Route =
    path("v1" / "threads" / Segment / "comments") { threadId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          parameter("cursor".optional) { cursor =>
            val tenant = tenantHeader.getOrElse("")
            val below = cursor.filter(_.nonEmpty).map(decodeCursor)
            if (tenant.isEmpty) complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
            else if (below.contains(None)) complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("unreadable cursor"))))
            else {
              val top = below.flatten.map(seq => s"($seq").getOrElse("+inf")
              // A position, not a count: comments posted meanwhile land above it and shift nothing.
              val ids = jedis.zrevrangeByScore(Store.indexKey(tenant, threadId), top, "-inf", 0, PageSize).asScala.toSeq
              val rows = Store.getMany(tenant, ids).flatten
              val counts = Threads.replyCounts(tenant, threadId, rows.map(_.id))
              val next = if (rows.size == PageSize) JsString(encodeCursor(rows.last.seq)) else JsNull
              complete(json(StatusCodes.OK, JsObject(
                "comments" -> JsArray(rows.map(row => serializeComment(row, counts.getOrElse(row.id, 0L))).toVector),
                "next_cursor" -> next,
                "comment_count" -> JsNumber(Threads.threadCount(tenant, threadId)))))
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
#include <sw/redis++/redis++.h>

#include <cstdlib>
#include <string>
#include <vector>

#include "comments/store.h"    // store::Comment, indexKey, getMany
#include "comments/threads.h"  // threads::threadCount, replyCounts

using json = nlohmann::json;

constexpr long long kPageSize = 20;

sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

json serializeComment(const store::Comment& row, const std::vector<store::Comment>& page) {
  long long replies = 0;
  for (const auto& other : page) replies += other.parent_id == row.id ? 1 : 0;
  return json{{"id", row.id},         {"parent_id", row.parent_id},   {"author_id", row.author_id}, {"text", row.text},
              {"html", row.html},     {"created_at", row.created_at}, {"revision", row.revision},   {"deleted", row.deleted},
              {"reply_count", replies}};
}

void list_comments(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "X-Tenant-Id is required"}}.dump(), "application/json");
    return;
  }
  const std::string thread_id = req.matches[1];
  const long long offset = req.has_param("cursor") ? std::atoll(req.get_param_value("cursor").c_str()) : 0;
  const auto ids = client().zrevrange(store::indexKey(tenant, thread_id), offset, offset + kPageSize - 1);
  std::vector<store::Comment> rows;
  for (const auto& row : store::getMany(tenant, ids)) {
    if (row) rows.push_back(*row);
  }
  json items = json::array();
  for (const auto& row : rows) items.push_back(serializeComment(row, rows));
  res.set_content(json{{"comments", items}, {"next_cursor", std::to_string(offset + kPageSize)}, {"comment_count", rows.size()}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/threads/([\\w-]+)/comments)", list_comments);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

#include "comments/store.h"    // store::Comment, indexKey, getMany
#include "comments/threads.h"  // threads::threadCount, replyCounts

using json = nlohmann::json;

constexpr long long kPageSize = 20;

sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// An opaque position: the page resumes strictly below this seq.
std::string encodeCursor(long long seq) {
  const std::string raw = "seq:" + std::to_string(seq);
  std::vector<unsigned char> out(4 * ((raw.size() + 2) / 3) + 1);
  EVP_EncodeBlock(out.data(), reinterpret_cast<const unsigned char*>(raw.data()), static_cast<int>(raw.size()));
  return reinterpret_cast<const char*>(out.data());
}

// The seq a cursor resumes below, or none when it is not one of ours.
std::optional<long long> decodeCursor(const std::string& cursor) {
  std::vector<unsigned char> out(3 * (cursor.size() / 4) + 1, 0);
  if (EVP_DecodeBlock(out.data(), reinterpret_cast<const unsigned char*>(cursor.data()), static_cast<int>(cursor.size())) < 0) return std::nullopt;
  const std::string raw = reinterpret_cast<const char*>(out.data());
  if (raw.rfind("seq:", 0) != 0 || raw.size() == 4 || raw.find_first_not_of("0123456789", 4) != std::string::npos) return std::nullopt;
  return std::stoll(raw.substr(4));
}

json serializeComment(const store::Comment& row, long long reply_count) {
  json item = {{"id", row.id},           {"parent_id", row.parent_id},   {"created_at", row.created_at},
               {"revision", row.revision}, {"reply_count", reply_count}, {"deleted", row.deleted}};
  if (row.deleted) return item;  // a tombstone keeps its place and its replies, not its words
  item["author_id"] = row.author_id;
  item["text"] = row.text;
  item["html"] = row.html;
  return item;
}

void list_comments(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "X-Tenant-Id is required"}}.dump(), "application/json");
    return;
  }
  const std::string thread_id = req.matches[1];
  const std::string cursor = req.has_param("cursor") ? req.get_param_value("cursor") : "";
  const auto below = cursor.empty() ? std::nullopt : decodeCursor(cursor);
  if (!cursor.empty() && !below) {
    res.status = 400;
    res.set_content(json{{"error", "unreadable cursor"}}.dump(), "application/json");
    return;
  }
  // A position, not a count: comments posted meanwhile land above it and shift nothing.
  std::vector<std::string> ids;
  const std::string key = store::indexKey(tenant, thread_id);
  if (below) {
    client().zrevrangebyscore(key, sw::redis::RightBoundedInterval<double>(static_cast<double>(*below), sw::redis::BoundType::RIGHT_OPEN),
                              sw::redis::LimitOptions{0, kPageSize}, std::back_inserter(ids));
  } else {
    client().zrevrangebyscore(key, sw::redis::UnboundedInterval<double>{}, sw::redis::LimitOptions{0, kPageSize}, std::back_inserter(ids));
  }
  std::vector<store::Comment> rows;
  for (const auto& row : store::getMany(tenant, ids)) {
    if (row) rows.push_back(*row);
  }
  std::vector<std::string> row_ids;
  for (const auto& row : rows) row_ids.push_back(row.id);
  const auto counts = threads::replyCounts(tenant, thread_id, row_ids);
  json items = json::array();
  for (const auto& row : rows) items.push_back(serializeComment(row, counts.at(row.id)));
  const json next = rows.size() == static_cast<size_t>(kPageSize) ? json(encodeCursor(rows.back().seq)) : json(nullptr);
  res.set_content(json{{"comments", items}, {"next_cursor", next}, {"comment_count", threads::threadCount(tenant, thread_id)}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/threads/([\\w-]+)/comments)", list_comments);
}
`,
    },
  },
  harness: {
    python: `from comments import store, threads

SECRET = "call me on 555-0100"


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _seed(n, parent_of=None, text=None):
    """n comments in acme's thread t-1, committed with their counters; parent_of maps an index (1-based) to its parent's index."""
    made = []
    for i in range(1, n + 1):
        parent = made[parent_of[i] - 1]["id"] if parent_of and i in parent_of else ""
        body = text(i) if text else f"comment {i}"
        comment = store.new_comment("t-1", parent, "u-1", body, body)
        threads.commit_comment("acme", comment)
        made.append(comment)
    return made


def _more(n):
    for _ in range(n):
        comment = store.new_comment("t-1", "", "u-2", "late", "late")
        threads.commit_comment("acme", comment)


async def _page(c, cursor=None):
    r = await c.get("/v1/threads/t-1/comments", params={"cursor": cursor} if cursor else None, headers={"X-Tenant-Id": "acme"})
    assert r.status_code == 200, f"GET /v1/threads/t-1/comments{'?cursor=' + cursor if cursor else ''} answered {r.status_code}: {r.text}"
    return r.json()


def _ids(page):
    return [item["id"] for item in page.get("comments", [])]


async def check_route(ctx):
    made = _seed(3)
    async with _api(ctx) as c:
        page = await _page(c)
        anonymous = await c.get("/v1/threads/t-1/comments")
    assert _ids(page) == [m["id"] for m in reversed(made)], f"the page lists {_ids(page)}, expected the thread newest first: {[m['id'] for m in reversed(made)]}"
    assert anonymous.status_code == 401, f"a request without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_cursor(ctx):
    made = _seed(25)
    async with _api(ctx) as c:
        first = await _page(c)
        assert _ids(first) == [m["id"] for m in reversed(made[5:])], f"page 1 lists {_ids(first)}, expected the 20 newest comments"
        assert first.get("next_cursor"), f"a full page must carry a next_cursor, got {first.get('next_cursor')!r}"
        _more(3)  # three comments arrive while the reader is on page 1
        second = await _page(c, first["next_cursor"])
        repeated = sorted(set(_ids(first)) & set(_ids(second)))
        assert not repeated, f"page 2 repeats {repeated} from page 1: three comments arrived and every row moved down three places. Resume below the last row's seq, not at a row count"
        assert _ids(second) == [m["id"] for m in reversed(made[:5])], f"page 2 lists {_ids(second)}, expected the 5 oldest comments"
        assert second.get("next_cursor") is None, f"the last page (5 of 20) must carry next_cursor null, got {second.get('next_cursor')!r}"
        bad = await c.get("/v1/threads/t-1/comments", params={"cursor": "not-a-cursor"}, headers={"X-Tenant-Id": "acme"})
    assert bad.status_code == 400, f"an unreadable cursor answered {bad.status_code}, expected 400"


async def check_tombstone(ctx):
    root, reply, _ = _seed(3, parent_of={2: 1}, text=lambda i: SECRET if i == 1 else f"comment {i}")
    store.soft_delete("acme", root["id"])
    async with _api(ctx) as c:
        r = await c.get("/v1/threads/t-1/comments", headers={"X-Tenant-Id": "acme"})
    items = {item["id"]: item for item in r.json().get("comments", [])}
    assert root["id"] in items, f"the deleted comment {root['id']} vanished from the page: its reply {reply['id']} now hangs off nothing. Keep it as a tombstone"
    tomb = items[root["id"]]
    assert tomb.get("deleted") is True, f"the deleted comment must say deleted: true, got {tomb}"
    assert "555-0100" not in r.text, f"the page still serves the deleted comment's words: {tomb}"
    leaked = [k for k in ("author_id", "text", "html") if tomb.get(k)]
    assert not leaked, f"the tombstone still carries {leaked}: {tomb}"
    assert items[reply["id"]].get("parent_id") == root["id"] and items[reply["id"]].get("text"), f"the reply must still point at its deleted parent and keep its own text, got {items[reply['id']]}"


async def check_counts(ctx):
    made = _seed(25, parent_of={23: 1, 24: 1, 25: 2})
    async with _api(ctx) as c:
        first = await _page(c)
        second = await _page(c, first.get("next_cursor") or "20")
    for n, page in ((1, first), (2, second)):
        assert page.get("comment_count") == 25, f"page {n} says comment_count {page.get('comment_count')} on a thread of 25 comments: read the thread counter, not the page"
    items = {item["id"]: item for item in second.get("comments", [])}
    assert made[0]["id"] in items and made[1]["id"] in items, f"page 2 lists {list(items)}, expected the oldest comments"
    counts = (items[made[0]["id"]].get("reply_count"), items[made[1]["id"]].get("reply_count"))
    assert counts == (2, 1), f"on page 2, {made[0]['id']} shows {counts[0]} replies and {made[1]['id']} shows {counts[1]}, expected 2 and 1: their replies are on page 1, the replies hash counts them all"
`,
    typescript: `const SECRET = 'call me on 555-0100';

function read(ctx) {
  return {
    c: ctx.client(ctx.load('read').app),
    store: ctx.load('/support/comments/store.ts'),
    threads: ctx.load('/support/comments/threads.ts'),
  };
}

/** n comments in acme's thread t-1, committed with their counters; parentOf maps an index (1-based) to its parent's index. */
async function seed({store, threads}, n: number, parentOf: Record<number, number> = {}, text = (i: number) => \`comment \${i}\`) {
  const made = [];
  for (let i = 1; i <= n; i++) {
    const parent = parentOf[i] ? made[parentOf[i] - 1].id : '';
    const comment = await store.newComment('t-1', parent, 'u-1', text(i), text(i));
    await threads.commitComment('acme', comment);
    made.push(comment);
  }
  return made;
}

async function page(c, cursor?: string) {
  const r = await c.get('/v1/threads/t-1/comments', {headers: {'X-Tenant-Id': 'acme'}, query: cursor ? {cursor} : {}});
  assert.equal(r.status, 200, \`GET /v1/threads/t-1/comments\${cursor ? '?cursor=' + cursor : ''} answered \${r.status}: \${r.text}\`);
  return r.json();
}

const ids = p => (p.comments ?? []).map(item => item.id);
const newestFirst = made => made.map(m => m.id).reverse();

export async function check_route(ctx) {
  const env = read(ctx);
  const made = await seed(env, 3);
  const p = await page(env.c);
  assert.deepStrictEqual(ids(p), newestFirst(made), \`the page lists \${JSON.stringify(ids(p))}, expected the thread newest first\`);
  const anonymous = await env.c.get('/v1/threads/t-1/comments');
  assert.equal(anonymous.status, 401, \`a request without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_cursor(ctx) {
  const env = read(ctx);
  const made = await seed(env, 25);
  const first = await page(env.c);
  assert.deepStrictEqual(ids(first), newestFirst(made.slice(5)), \`page 1 lists \${JSON.stringify(ids(first))}, expected the 20 newest comments\`);
  assert(first.next_cursor, \`a full page must carry a next_cursor, got \${JSON.stringify(first.next_cursor)}\`);
  for (let i = 0; i < 3; i++) await env.threads.commitComment('acme', await env.store.newComment('t-1', '', 'u-2', 'late', 'late')); // three comments arrive meanwhile
  const second = await page(env.c, first.next_cursor);
  const repeated = ids(second).filter(id => ids(first).includes(id));
  assert.equal(repeated.length, 0, \`page 2 repeats \${JSON.stringify(repeated)} from page 1: three comments arrived and every row moved down three places. Resume below the last row's seq, not at a row count\`);
  assert.deepStrictEqual(ids(second), newestFirst(made.slice(0, 5)), \`page 2 lists \${JSON.stringify(ids(second))}, expected the 5 oldest comments\`);
  assert.equal(second.next_cursor, null, \`the last page (5 of 20) must carry next_cursor null, got \${JSON.stringify(second.next_cursor)}\`);
  const bad = await env.c.get('/v1/threads/t-1/comments', {headers: {'X-Tenant-Id': 'acme'}, query: {cursor: 'not-a-cursor'}});
  assert.equal(bad.status, 400, \`an unreadable cursor answered \${bad.status}, expected 400\`);
}

export async function check_tombstone(ctx) {
  const env = read(ctx);
  const [root, reply] = await seed(env, 3, {2: 1}, i => (i === 1 ? SECRET : \`comment \${i}\`));
  await env.store.softDelete('acme', root.id);
  const r = await env.c.get('/v1/threads/t-1/comments', {headers: {'X-Tenant-Id': 'acme'}});
  const items = Object.fromEntries((r.json().comments ?? []).map(item => [item.id, item]));
  assert(items[root.id], \`the deleted comment \${root.id} vanished from the page: its reply \${reply.id} now hangs off nothing. Keep it as a tombstone\`);
  const tomb = items[root.id];
  assert.equal(tomb.deleted, true, \`the deleted comment must say deleted: true, got \${JSON.stringify(tomb)}\`);
  assert(!r.text.includes('555-0100'), \`the page still serves the deleted comment's words: \${JSON.stringify(tomb)}\`);
  const leaked = ['author_id', 'text', 'html'].filter(k => tomb[k]);
  assert.equal(leaked.length, 0, \`the tombstone still carries \${JSON.stringify(leaked)}: \${JSON.stringify(tomb)}\`);
  assert(items[reply.id]?.parent_id === root.id && items[reply.id]?.text, \`the reply must still point at its deleted parent and keep its own text, got \${JSON.stringify(items[reply.id])}\`);
}

export async function check_counts(ctx) {
  const env = read(ctx);
  const made = await seed(env, 25, {23: 1, 24: 1, 25: 2});
  const first = await page(env.c);
  const second = await page(env.c, first.next_cursor || '20');
  for (const [n, p] of [[1, first], [2, second]]) {
    assert.equal(p.comment_count, 25, \`page \${n} says comment_count \${p.comment_count} on a thread of 25 comments: read the thread counter, not the page\`);
  }
  const items = Object.fromEntries((second.comments ?? []).map(item => [item.id, item]));
  assert(items[made[0].id] && items[made[1].id], \`page 2 lists \${JSON.stringify(Object.keys(items))}, expected the oldest comments\`);
  const counts = [items[made[0].id].reply_count, items[made[1].id].reply_count];
  assert.deepStrictEqual(counts, [2, 1], \`on page 2, \${made[0].id} shows \${counts[0]} replies and \${made[1].id} shows \${counts[1]}, expected 2 and 1: their replies are on page 1, the replies hash counts them all\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"comments/store"
	"comments/threads"

	"leetbuild/harness"
)

const secret = "call me on 555-0100"

var readBg = context.Background()

type pageItem struct {
	ID         string \`json:"id"\`
	ParentID   string \`json:"parent_id"\`
	AuthorID   string \`json:"author_id"\`
	Text       string \`json:"text"\`
	HTML       string \`json:"html"\`
	Deleted    bool   \`json:"deleted"\`
	ReplyCount int64  \`json:"reply_count"\`
}

type threadPage struct {
	Comments     []pageItem \`json:"comments"\`
	NextCursor   *string    \`json:"next_cursor"\`
	CommentCount int64      \`json:"comment_count"\`
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// seed commits n comments in acme's thread t-1 with their counters; parentOf maps an index (1-based) to its parent's index.
func seed(ctx *harness.Ctx, n int, parentOf map[int]int, text func(int) string) []store.Comment {
	var made []store.Comment
	for i := 1; i <= n; i++ {
		parent := ""
		if p, ok := parentOf[i]; ok {
			parent = made[p-1].ID
		}
		body := fmt.Sprintf("comment %d", i)
		if text != nil {
			body = text(i)
		}
		c, err := store.NewComment(readBg, "t-1", parent, "u-1", body, body)
		ctx.NoError(err, "store.NewComment failed")
		_, err = threads.CommitComment(readBg, "acme", c)
		ctx.NoError(err, "threads.CommitComment failed")
		made = append(made, c)
	}
	return made
}

func fetchPage(ctx *harness.Ctx, c *harness.HTTP, cursor string) threadPage {
	path := "/v1/threads/t-1/comments"
	if cursor != "" {
		path += "?cursor=" + url.QueryEscape(cursor)
	}
	r := c.Get(path, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET %s (%s)", path, r.Text())
	var p threadPage
	r.Decode(&p)
	return p
}

func pageIDs(p threadPage) []string {
	out := []string{}
	for _, item := range p.Comments {
		out = append(out, item.ID)
	}
	return out
}

func newestFirst(made []store.Comment) []string {
	out := []string{}
	for i := len(made) - 1; i >= 0; i-- {
		out = append(out, made[i].ID)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	made := seed(ctx, 3, nil, nil)
	c := readClient(ctx)
	ctx.Equal(pageIDs(fetchPage(ctx, c, "")), newestFirst(made), "the page must list the thread newest first")
	ctx.Equal(c.Get("/v1/threads/t-1/comments").Status, 401, "a request without X-Tenant-Id")
}

func CheckCursor(ctx *harness.Ctx) {
	made := seed(ctx, 25, nil, nil)
	c := readClient(ctx)
	first := fetchPage(ctx, c, "")
	ctx.Equal(pageIDs(first), newestFirst(made[5:]), "page 1 must list the 20 newest comments")
	ctx.Assert(first.NextCursor != nil && *first.NextCursor != "", "a full page must carry a next_cursor")
	for i := 0; i < 3; i++ { // three comments arrive while the reader is on page 1
		late, _ := store.NewComment(readBg, "t-1", "", "u-2", "late", "late")
		threads.CommitComment(readBg, "acme", late)
	}
	second := fetchPage(ctx, c, *first.NextCursor)
	var repeated []string
	for _, id := range pageIDs(second) {
		for _, seen := range pageIDs(first) {
			if id == seen {
				repeated = append(repeated, id)
			}
		}
	}
	ctx.Assert(len(repeated) == 0, "page 2 repeats %q from page 1: three comments arrived and every row moved down three places. Resume below the last row's seq, not at a row count", repeated)
	ctx.Equal(pageIDs(second), newestFirst(made[:5]), "page 2 must list the 5 oldest comments")
	ctx.Assert(second.NextCursor == nil, "the last page (5 of 20) must carry next_cursor null, got %q", second.NextCursor)
	ctx.Equal(c.Get("/v1/threads/t-1/comments?cursor=not-a-cursor", "X-Tenant-Id", "acme").Status, 400, "an unreadable cursor")
}

func CheckTombstone(ctx *harness.Ctx) {
	made := seed(ctx, 3, map[int]int{2: 1}, func(i int) string {
		if i == 1 {
			return secret
		}
		return fmt.Sprintf("comment %d", i)
	})
	root, reply := made[0], made[1]
	store.SoftDelete(readBg, "acme", root.ID)
	r := readClient(ctx).Get("/v1/threads/t-1/comments", "X-Tenant-Id", "acme")
	var p threadPage
	r.Decode(&p)
	items := map[string]pageItem{}
	for _, item := range p.Comments {
		items[item.ID] = item
	}
	tomb, ok := items[root.ID]
	ctx.Assert(ok, "the deleted comment %s vanished from the page: its reply %s now hangs off nothing. Keep it as a tombstone", root.ID, reply.ID)
	ctx.Assert(tomb.Deleted, "the deleted comment must say deleted: true, got %+v", tomb)
	ctx.Assert(!strings.Contains(r.Text(), "555-0100"), "the page still serves the deleted comment's words: %+v", tomb)
	ctx.Assert(tomb.AuthorID == "" && tomb.Text == "" && tomb.HTML == "", "the tombstone still carries its author or words: %+v", tomb)
	ctx.Assert(items[reply.ID].ParentID == root.ID && items[reply.ID].Text != "", "the reply must still point at its deleted parent and keep its own text, got %+v", items[reply.ID])
}

func CheckCounts(ctx *harness.Ctx) {
	made := seed(ctx, 25, map[int]int{23: 1, 24: 1, 25: 2}, nil)
	c := readClient(ctx)
	first := fetchPage(ctx, c, "")
	cursor := "20"
	if first.NextCursor != nil {
		cursor = *first.NextCursor
	}
	second := fetchPage(ctx, c, cursor)
	ctx.Equal(first.CommentCount, 25, "page 1's comment_count on a thread of 25 comments (read the thread counter, not the page)")
	ctx.Equal(second.CommentCount, 25, "page 2's comment_count on a thread of 25 comments (read the thread counter, not the page)")
	items := map[string]pageItem{}
	for _, item := range second.Comments {
		items[item.ID] = item
	}
	_, has0 := items[made[0].ID]
	_, has1 := items[made[1].ID]
	ctx.Assert(has0 && has1, "page 2 lists %q, expected the oldest comments", pageIDs(second))
	ctx.Assert(items[made[0].ID].ReplyCount == 2 && items[made[1].ID].ReplyCount == 1, "on page 2, %s shows %d replies and %s shows %d, expected 2 and 1: their replies are on page 1, the replies hash counts them all",
		made[0].ID, items[made[0].ID].ReplyCount, made[1].ID, items[made[1].ID].ReplyCount)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cctype>
#include <cstdio>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "comments/store.h"
#include "comments/threads.h"

namespace {

const std::string kSecret = "call me on 555-0100";

harness::HTTP readClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// n comments in acme's thread t-1, committed with their counters; parent_of maps an index (1-based) to its parent's index.
std::vector<store::Comment> seed(int n, const std::map<int, int>& parent_of = {}, const std::function<std::string(int)>& text = nullptr) {
  std::vector<store::Comment> made;
  for (int i = 1; i <= n; i++) {
    const std::string parent = parent_of.count(i) ? made[parent_of.at(i) - 1].id : "";
    const std::string body = text ? text(i) : "comment " + std::to_string(i);
    const store::Comment c = store::newComment("t-1", parent, "u-1", body, body);
    threads::commitComment("acme", c);
    made.push_back(c);
  }
  return made;
}

std::string escape(const std::string& s) {
  std::string out;
  for (const unsigned char ch : s) {
    if (std::isalnum(ch) || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
      out += static_cast<char>(ch);
    } else {
      char hex[4];
      std::snprintf(hex, sizeof hex, "%%%02X", ch);
      out += hex;
    }
  }
  return out;
}

nlohmann::json fetchPage(harness::Ctx& ctx, harness::HTTP& c, const std::string& cursor = "") {
  const std::string path = "/v1/threads/t-1/comments" + (cursor.empty() ? "" : "?cursor=" + escape(cursor));
  const auto r = c.Get(path, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET %s (%s)", path, r.Text());
  const auto page = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(page.is_object() && page.contains("comments") && page["comments"].is_array(), "the page is not {comments: [...]}: %s", r.Text());
  return page;
}

std::vector<std::string> pageIds(const nlohmann::json& page) {
  std::vector<std::string> out;
  for (const auto& item : page["comments"]) out.push_back(item.value("id", ""));
  return out;
}

std::vector<std::string> newestFirst(const std::vector<store::Comment>& made, size_t from, size_t to) {
  std::vector<std::string> out;
  for (size_t i = to; i > from; i--) out.push_back(made[i - 1].id);
  return out;
}

std::map<std::string, nlohmann::json> byId(const nlohmann::json& page) {
  std::map<std::string, nlohmann::json> out;
  for (const auto& item : page["comments"]) out[item.value("id", "")] = item;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const auto made = seed(3);
  auto c = readClient(ctx);
  ctx.Equal(pageIds(fetchPage(ctx, c)), newestFirst(made, 0, 3), "the page must list the thread newest first");
  ctx.Equal(c.Get("/v1/threads/t-1/comments").Status, 401, "a request without X-Tenant-Id");
}

void CheckCursor(harness::Ctx& ctx) {
  const auto made = seed(25);
  auto c = readClient(ctx);
  const auto first = fetchPage(ctx, c);
  ctx.Equal(pageIds(first), newestFirst(made, 5, 25), "page 1 must list the 20 newest comments");
  ctx.Assert(first.contains("next_cursor") && first["next_cursor"].is_string() && !first["next_cursor"].get<std::string>().empty(), "a full page must carry a next_cursor, got %s", first.dump());
  for (int i = 0; i < 3; i++) threads::commitComment("acme", store::newComment("t-1", "", "u-2", "late", "late"));  // three comments arrive meanwhile
  const auto second = fetchPage(ctx, c, first["next_cursor"].get<std::string>());
  std::vector<std::string> repeated;
  for (const auto& id : pageIds(second)) {
    for (const auto& seen : pageIds(first)) {
      if (id == seen) repeated.push_back(id);
    }
  }
  ctx.Assert(repeated.empty(), "page 2 repeats %q from page 1: three comments arrived and every row moved down three places. Resume below the last row's seq, not at a row count", repeated);
  ctx.Equal(pageIds(second), newestFirst(made, 0, 5), "page 2 must list the 5 oldest comments");
  ctx.Assert(second.contains("next_cursor") && second["next_cursor"].is_null(), "the last page (5 of 20) must carry next_cursor null, got %s", second.value("next_cursor", nlohmann::json()).dump());
  ctx.Equal(c.Get("/v1/threads/t-1/comments?cursor=not-a-cursor", "X-Tenant-Id", "acme").Status, 400, "an unreadable cursor");
}

void CheckTombstone(harness::Ctx& ctx) {
  const auto made = seed(3, {{2, 1}}, [](int i) { return i == 1 ? kSecret : "comment " + std::to_string(i); });
  const store::Comment& root = made[0];
  const store::Comment& reply = made[1];
  store::softDelete("acme", root.id);
  auto c = readClient(ctx);
  const auto r = c.Get("/v1/threads/t-1/comments", "X-Tenant-Id", "acme");
  const auto page = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(page.is_object() && page.contains("comments"), "the page is not {comments: [...]}: %s", r.Text());
  const auto items = byId(page);
  ctx.Assert(items.count(root.id) == 1, "the deleted comment %s vanished from the page: its reply %s now hangs off nothing. Keep it as a tombstone", root.id, reply.id);
  const auto& tomb = items.at(root.id);
  ctx.Assert(tomb.value("deleted", false), "the deleted comment must say deleted: true, got %s", tomb.dump());
  ctx.Assert(r.Text().find("555-0100") == std::string::npos, "the page still serves the deleted comment's words: %s", tomb.dump());
  ctx.Assert(!tomb.contains("author_id") && !tomb.contains("text") && !tomb.contains("html"), "the tombstone still carries its author or words: %s", tomb.dump());
  ctx.Assert(items.count(reply.id) && items.at(reply.id).value("parent_id", "") == root.id && !items.at(reply.id).value("text", "").empty(),
             "the reply must still point at its deleted parent and keep its own text, got %s", items.count(reply.id) ? items.at(reply.id).dump() : "nothing");
}

void CheckCounts(harness::Ctx& ctx) {
  const auto made = seed(25, {{23, 1}, {24, 1}, {25, 2}});
  auto c = readClient(ctx);
  const auto first = fetchPage(ctx, c);
  const std::string cursor = first.contains("next_cursor") && first["next_cursor"].is_string() ? first["next_cursor"].get<std::string>() : "20";
  const auto second = fetchPage(ctx, c, cursor);
  ctx.Equal(first.value("comment_count", 0), 25, "page 1's comment_count on a thread of 25 comments (read the thread counter, not the page)");
  ctx.Equal(second.value("comment_count", 0), 25, "page 2's comment_count on a thread of 25 comments (read the thread counter, not the page)");
  const auto items = byId(second);
  ctx.Assert(items.count(made[0].id) && items.count(made[1].id), "page 2 lists %q, expected the oldest comments", pageIds(second));
  const long long r0 = items.at(made[0].id).value("reply_count", 0LL);
  const long long r1 = items.at(made[1].id).value("reply_count", 0LL);
  ctx.Assert(r0 == 2 && r1 == 1, "on page 2, %s shows %d replies and %s shows %d, expected 2 and 1: their replies are on page 1, the replies hash counts them all", made[0].id, r0, made[1].id, r1);
}
`,
  },
  hints: [
    'Open page 1 of a busy thread, post three comments, open page 2: it starts with three comments you just read. A deleted comment still shows its words, and the badge reads 20.',
    'The cursor is a row count, and every new comment pushes every row down one. `serialize_comment` copies the row whatever its `deleted` flag says, and both counts are computed from the 20 rows in hand.',
    '`encode_cursor(rows[-1]["seq"])` when the page is full; `ZREVRANGEBYSCORE index (seq -inf` with `start=0, num=PAGE_SIZE`; drop `author_id`, `text`, `html` when `row["deleted"]`; take the counts from `threads.thread_count` and `threads.reply_counts`.',
  ],
  debrief: `A cursor names a position, an offset counts rows, and on a thread people are writing to the rows move between two requests: resuming strictly below the last \`seq\` is the only reading that cannot repeat or skip, and it turns each page into a range read on the index. The cursor stays opaque so the encoding can change without breaking clients. A tombstone keeps the tree whole, replies still point at it, while the words leave the response; the row itself stays for moderators. The counts come from the counters because a page only knows itself. What a cursor does not give is a way back: a production API adds a \`prev\` cursor, and caches the first page of a hot thread, the page almost every reader asks for.`,
};
