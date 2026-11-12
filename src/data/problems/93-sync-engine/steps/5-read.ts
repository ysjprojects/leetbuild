import type {Step} from '@/lib/types';

export const pullReadStep: Step = {
  id: 'read',
  concept: 'http',
  file: 'read',
  title: 'GET /v1/sync/pull: a cursor that covers exactly the page',
  focus: ['device', 'sync', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/sync/pull?cursor={revision}&limit={n}\` with
\`X-Device-Id\` (401 without it): it reads the doc ids at positions \`cursor\` to
\`cursor + limit - 1\` of the \`changes\` log (\`ZRANGE\`), answers each head as
\`{doc_id, revision, content_hash, body}\` in \`entries\`, \`cursor\` as the newest revision in
\`rev:seq\`, and \`has_more\` when the page is full. It serves the demo phone and hides three flaws.

**Failure mode the checks target.** A phone back with 2,400 changes waiting gets the first page and
a cursor equal to the newest write, and never pulls the rest. While someone edits, a document moves
to the end of the log and a resuming device skips the one that slid into its place. A client that
asks for a million entries gets them.

- Read the documents changed **after** the cursor, by revision: \`ZRANGEBYSCORE changes (cursor +inf\`.
- \`cursor\` is the revision of the **last entry returned** (the request's cursor when there are
  none), and \`has_more\` is true only when changes remain after the page: read one entry past it.
- \`limit\` defaults to \`DEFAULT_LIMIT\` (100) and is capped at \`MAX_LIMIT\` (1000).`,
  sequence: {
    participants: ['Device', 'syncd', 'Redis'],
    messages: [
      {from: 'Device', to: 'syncd', label: 'GET /v1/sync/pull?cursor=2&limit=2 · X-Device-Id', kind: 'sync'},
      {from: 'syncd', to: 'Redis', label: 'ZRANGEBYSCORE changes (2 +inf WITHSCORES LIMIT 0 3', kind: 'sync'},
      {from: 'Redis', to: 'syncd', label: 'd-3 3 · d-4 4 · d-1 5', kind: 'reply'},
      {from: 'syncd', to: 'Redis', label: 'head(d-3) · head(d-4)', kind: 'sync'},
      {from: 'syncd', to: 'Device', label: '200 {entries, cursor: 4, has_more: true}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/sync/pull',
      detail:
        'Register `GET /v1/sync/pull`: a device with no cursor gets every document in revision order; a pull without `X-Device-Id` is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/sync\/pull["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/sync\/pull['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/sync\/pull"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sync"\s*\/\s*"pull"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/sync\/pull"/]},
      },
    },
    {
      id: 'revision-cursor',
      title: 'Reads the log by revision, not by position',
      detail:
        'The page is the documents whose revision is above the cursor (`ZRANGEBYSCORE`); `ZRANGE` reads positions, which shift when an edit moves a document to the end of the log.',
      match: {
        python: {all: [/zrangebyscore\(/], none: [/\.zrange\(/]},
        typescript: {all: [/zrangebyscore\(/], none: [/\.zrange\(/]},
        go: {all: [/ZRangeByScore/], none: [/\.ZRange\(/]},
        scala: {all: [/zrangeByScore/], none: [/\.zrange\(/]},
        cpp: {all: [/zrangebyscore\(/], none: [/\.zrange\(/]},
      },
    },
    {
      id: 'page-cursor',
      title: 'The cursor is the last revision returned, and has_more is exact',
      detail:
        'The answered cursor is the revision of the last entry in the page, not the newest revision in `rev:seq`; one entry read past the page (or a count) decides `has_more`.',
      match: {
        python: {all: [/limit\s*\+\s*1|zcount/i], none: [/REVISION_KEY/]},
        typescript: {all: [/limit\s*\+\s*1|zcount/i], none: [/REVISION_KEY/]},
        go: {all: [/limit\s*\+\s*1|ZCount/], none: [/RevisionKey/]},
        scala: {all: [/limit\s*\+\s*1|zcount/i], none: [/RevisionKey/]},
        cpp: {all: [/limit\s*\+\s*1|zcount/i], none: [/kRevisionKey/]},
      },
    },
    {
      id: 'limit-cap',
      title: 'Caps a page at 1000 entries',
      detail: 'The requested `limit` is capped at `MAX_LIMIT` (1000), so one request cannot read the whole log.',
      match: {
        python: {all: [/MAX_LIMIT/, /min\(/]},
        typescript: {all: [/MAX_LIMIT/, /Math\.min\(/]},
        go: {all: [/maxLimit/, /limit\s*>\s*maxLimit|min\(/]},
        scala: {all: [/MaxLimit/, /min\(/]},
        cpp: {all: [/kMaxLimit/, /std::min\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from docsync import store  # head, CHANGES_KEY, REVISION_KEY

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEFAULT_LIMIT = 100


@app.get("/v1/sync/pull")
def pull(request: Request):
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if not request.headers.get("x-device-id"):
        return JSONResponse({"error": "missing_device"}, status_code=401)
    cursor = int(request.query_params.get("cursor", "0"))
    limit = int(request.query_params.get("limit", DEFAULT_LIMIT))
    entries = []
    for doc_id in r.zrange(store.CHANGES_KEY, cursor, cursor + limit - 1):
        head = store.head(doc_id)
        entries.append({"doc_id": doc_id, "revision": head["revision"], "content_hash": head["content_hash"], "body": head["body"]})
    return {"entries": entries, "cursor": int(r.get(store.REVISION_KEY) or 0), "has_more": len(entries) == limit}
`,
      solution: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from docsync import store  # head, CHANGES_KEY

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEFAULT_LIMIT = 100
MAX_LIMIT = 1000


@app.get("/v1/sync/pull")
def pull(request: Request):
    if not request.headers.get("x-device-id"):
        return JSONResponse({"error": "missing_device"}, status_code=401)
    cursor = int(request.query_params.get("cursor", "0"))
    limit = min(int(request.query_params.get("limit", DEFAULT_LIMIT)), MAX_LIMIT)
    # By revision, not by position: an edit moves a document to the end of the log, a revision stays put.
    # One row past the page says whether there is more.
    rows = r.zrangebyscore(store.CHANGES_KEY, f"({cursor}", "+inf", start=0, num=limit + 1, withscores=True)
    page = rows[:limit]
    entries = []
    for doc_id, _ in page:
        head = store.head(doc_id)
        entries.append({"doc_id": doc_id, "revision": head["revision"], "content_hash": head["content_hash"], "body": head["body"]})
    # The cursor covers exactly the page: resuming from it misses nothing and repeats nothing.
    next_cursor = int(page[-1][1]) if page else cursor
    return {"entries": entries, "cursor": next_cursor, "has_more": len(rows) > limit}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {CHANGES_KEY, REVISION_KEY, head} from 'docsync/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const DEFAULT_LIMIT = 100;

app.get('/v1/sync/pull', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (!request.headers['x-device-id']) return reply.code(401).send({error: 'missing_device'});
  const query = request.query as {cursor?: string; limit?: string};
  const cursor = Number(query.cursor ?? 0);
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  const entries: {doc_id: string; revision: number; content_hash: string; body: string}[] = [];
  for (const docId of await redis.zrange(CHANGES_KEY, cursor, cursor + limit - 1)) {
    const doc = await head(docId);
    if (doc !== null) entries.push({doc_id: docId, revision: doc.revision, content_hash: doc.content_hash, body: doc.body});
  }
  return {entries, cursor: Number((await redis.get(REVISION_KEY)) ?? 0), has_more: entries.length === limit};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {CHANGES_KEY, head} from 'docsync/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

app.get('/v1/sync/pull', async (request, reply) => {
  if (!request.headers['x-device-id']) return reply.code(401).send({error: 'missing_device'});
  const query = request.query as {cursor?: string; limit?: string};
  const cursor = Number(query.cursor ?? 0);
  const limit = Math.min(Number(query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  // By revision, not by position: an edit moves a document to the end of the log, a revision stays put.
  // One row past the page says whether there is more.
  const rows = await redis.zrangebyscore(CHANGES_KEY, \`(\${cursor}\`, '+inf', 'WITHSCORES', 'LIMIT', 0, limit + 1);
  const found = rows.length / 2;
  const size = Math.min(found, limit);
  const entries: {doc_id: string; revision: number; content_hash: string; body: string}[] = [];
  for (let i = 0; i < size; i++) {
    const doc = await head(rows[2 * i]);
    if (doc !== null) entries.push({doc_id: doc.doc_id, revision: doc.revision, content_hash: doc.content_hash, body: doc.body});
  }
  // The cursor covers exactly the page: resuming from it misses nothing and repeats nothing.
  const next = size > 0 ? Number(rows[2 * size - 1]) : cursor;
  return {entries, cursor: next, has_more: found > limit};
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

	"docsync/store" // store.Head, ChangesKey, RevisionKey
)

const defaultLimit = 100

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type entry struct {
	DocID       string \`json:"doc_id"\`
	Revision    int64  \`json:"revision"\`
	ContentHash string \`json:"content_hash"\`
	Body        string \`json:"body"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func queryInt(r *http.Request, name string, fallback int64) int64 {
	if n, err := strconv.ParseInt(r.URL.Query().Get(name), 10, 64); err == nil {
		return n
	}
	return fallback
}

func pull(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if r.Header.Get("X-Device-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_device"})
		return
	}
	cursor := queryInt(r, "cursor", 0)
	limit := queryInt(r, "limit", defaultLimit)
	ids, err := rdb.ZRange(r.Context(), store.ChangesKey, cursor, cursor+limit-1).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	entries := []entry{}
	for _, docID := range ids {
		if head := store.Head(r.Context(), docID); head != nil {
			entries = append(entries, entry{DocID: docID, Revision: head.Revision, ContentHash: head.ContentHash, Body: head.Body})
		}
	}
	latest, _ := strconv.ParseInt(rdb.Get(r.Context(), store.RevisionKey).Val(), 10, 64)
	writeJSON(rw, http.StatusOK, map[string]any{"entries": entries, "cursor": latest, "has_more": int64(len(entries)) == limit})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sync/pull", pull)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"docsync/store" // store.Head, ChangesKey
)

const (
	defaultLimit = 100
	maxLimit     = 1000
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type entry struct {
	DocID       string \`json:"doc_id"\`
	Revision    int64  \`json:"revision"\`
	ContentHash string \`json:"content_hash"\`
	Body        string \`json:"body"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func queryInt(r *http.Request, name string, fallback int64) int64 {
	if n, err := strconv.ParseInt(r.URL.Query().Get(name), 10, 64); err == nil {
		return n
	}
	return fallback
}

func pull(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Device-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_device"})
		return
	}
	cursor := queryInt(r, "cursor", 0)
	limit := queryInt(r, "limit", defaultLimit)
	if limit > maxLimit {
		limit = maxLimit
	}
	// By revision, not by position: an edit moves a document to the end of the log, a revision stays put.
	// One row past the page says whether there is more.
	rows, err := rdb.ZRangeByScoreWithScores(r.Context(), store.ChangesKey, &redis.ZRangeBy{Min: fmt.Sprintf("(%d", cursor), Max: "+inf", Count: limit + 1}).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	page := rows
	if int64(len(page)) > limit {
		page = page[:limit]
	}
	entries := []entry{}
	next := cursor
	for _, row := range page {
		docID, _ := row.Member.(string)
		if head := store.Head(r.Context(), docID); head != nil {
			entries = append(entries, entry{DocID: docID, Revision: head.Revision, ContentHash: head.ContentHash, Body: head.Body})
		}
		next = int64(row.Score) // the cursor covers exactly the page: resuming from it misses nothing and repeats nothing
	}
	writeJSON(rw, http.StatusOK, map[string]any{"entries": entries, "cursor": next, "has_more": int64(len(rows)) > limit})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sync/pull", pull)
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

import docsync.Store // Store.head, ChangesKey, RevisionKey

object Read {
  val DefaultLimit = 100

  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def entry(doc: Store.Doc): JsObject =
    JsObject("doc_id" -> JsString(doc.docId), "revision" -> JsNumber(doc.revision), "content_hash" -> JsString(doc.contentHash), "body" -> JsString(doc.body))

  val route: Route = path("v1" / "sync" / "pull") {
    get {
      optionalHeaderValueByName("X-Device-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_device"))))
        case Some(_) =>
          parameterMap { params =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val cursor = params.get("cursor").flatMap(_.toLongOption).getOrElse(0L)
            val limit = params.get("limit").flatMap(_.toIntOption).getOrElse(DefaultLimit)
            val entries = jedis.zrange(Store.ChangesKey, cursor, cursor + limit - 1).asScala.toVector.flatMap(Store.head).map(entry)
            val latest = Option(jedis.get(Store.RevisionKey)).map(_.toLong).getOrElse(0L)
            complete(json(StatusCodes.OK, JsObject("entries" -> JsArray(entries), "cursor" -> JsNumber(latest), "has_more" -> JsBoolean(entries.size == limit))))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import docsync.Store // Store.head, ChangesKey

object Read {
  val DefaultLimit = 100
  val MaxLimit = 1000

  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def entry(doc: Store.Doc): JsObject =
    JsObject("doc_id" -> JsString(doc.docId), "revision" -> JsNumber(doc.revision), "content_hash" -> JsString(doc.contentHash), "body" -> JsString(doc.body))

  val route: Route = path("v1" / "sync" / "pull") {
    get {
      optionalHeaderValueByName("X-Device-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_device"))))
        case Some(_) =>
          parameterMap { params =>
            val cursor = params.get("cursor").flatMap(_.toLongOption).getOrElse(0L)
            val limit = math.min(params.get("limit").flatMap(_.toIntOption).getOrElse(DefaultLimit), MaxLimit)
            // By revision, not by position: an edit moves a document to the end of the log, a revision stays put.
            // One row past the page says whether there is more.
            val rows = jedis.zrangeByScoreWithScores(Store.ChangesKey, s"($cursor", "+inf", 0, limit + 1).asScala.toVector
            val page = rows.take(limit)
            val entries = page.flatMap(row => Store.head(row.getElement)).map(entry)
            // The cursor covers exactly the page: resuming from it misses nothing and repeats nothing.
            val next = page.lastOption.map(_.getScore.toLong).getOrElse(cursor)
            complete(json(StatusCodes.OK, JsObject("entries" -> JsArray(entries), "cursor" -> JsNumber(next), "has_more" -> JsBoolean(rows.size > limit))))
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

#include <string>

#include "docsync/store.h"  // store::head, kChangesKey, kRevisionKey

using json = nlohmann::json;

constexpr long long kDefaultLimit = 100;

sw::redis::Redis redis("tcp://redis:6379");

long long queryInt(const httplib::Request& req, const std::string& name, long long fallback) {
  if (!req.has_param(name)) return fallback;
  try {
    return std::stoll(req.get_param_value(name));
  } catch (const std::exception&) {
    return fallback;
  }
}

void pull(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (req.get_header_value("X-Device-Id").empty()) {
    res.status = 401;
    res.set_content(json{{"error", "missing_device"}}.dump(), "application/json");
    return;
  }
  const long long cursor = queryInt(req, "cursor", 0);
  const long long limit = queryInt(req, "limit", kDefaultLimit);
  json entries = json::array();
  for (const std::string& doc_id : redis.zrange(store::kChangesKey, cursor, cursor + limit - 1)) {
    if (const auto doc = store::head(doc_id)) {
      entries.push_back(json{{"doc_id", doc->doc_id}, {"revision", doc->revision}, {"content_hash", doc->content_hash}, {"body", doc->body}});
    }
  }
  const auto latest = redis.get(store::kRevisionKey);
  const long long newest = latest ? std::stoll(*latest) : 0;
  res.set_content(json{{"entries", entries}, {"cursor", newest}, {"has_more", static_cast<long long>(entries.size()) == limit}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get("/v1/sync/pull", pull);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include "docsync/store.h"  // store::head, kChangesKey

using json = nlohmann::json;

constexpr long long kDefaultLimit = 100;
constexpr long long kMaxLimit = 1000;

sw::redis::Redis redis("tcp://redis:6379");

long long queryInt(const httplib::Request& req, const std::string& name, long long fallback) {
  if (!req.has_param(name)) return fallback;
  try {
    return std::stoll(req.get_param_value(name));
  } catch (const std::exception&) {
    return fallback;
  }
}

void pull(const httplib::Request& req, httplib::Response& res) {
  if (req.get_header_value("X-Device-Id").empty()) {
    res.status = 401;
    res.set_content(json{{"error", "missing_device"}}.dump(), "application/json");
    return;
  }
  const long long cursor = queryInt(req, "cursor", 0);
  const long long limit = std::min(queryInt(req, "limit", kDefaultLimit), kMaxLimit);
  // By revision, not by position: an edit moves a document to the end of the log, a revision stays put.
  // One row past the page says whether there is more.
  std::vector<std::pair<std::string, double>> rows;
  redis.zrangebyscore(store::kChangesKey, sw::redis::LeftBoundedInterval<double>(static_cast<double>(cursor), sw::redis::BoundType::LEFT_OPEN),
                      sw::redis::LimitOptions{0, limit + 1}, std::back_inserter(rows));
  json entries = json::array();
  long long next = cursor;
  for (size_t i = 0; i < rows.size() && static_cast<long long>(i) < limit; i++) {
    if (const auto doc = store::head(rows[i].first)) {
      entries.push_back(json{{"doc_id", doc->doc_id}, {"revision", doc->revision}, {"content_hash", doc->content_hash}, {"body", doc->body}});
    }
    next = static_cast<long long>(rows[i].second);  // the cursor covers exactly the page: resuming from it misses nothing and repeats nothing
  }
  res.set_content(json{{"entries", entries}, {"cursor", next}, {"has_more", static_cast<long long>(rows.size()) > limit}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get("/v1/sync/pull", pull);
}
`,
    },
  },
  harness: {
    python: `from docsync import store
from docsync.revisions import apply_change


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _write(doc_id, base, body, device="laptop"):
    return apply_change(doc_id, base, store.content_hash(body), body, device)["revision"]


async def _pull(c, cursor=None, limit=None):
    params = {k: v for k, v in (("cursor", cursor), ("limit", limit)) if v is not None}
    r = await c.get("/v1/sync/pull", params=params, headers={"X-Device-Id": "phone"})
    assert r.status_code == 200, f"GET /v1/sync/pull with {params} answered {r.status_code}: {r.text}"
    return r.json()


def _ids(page):
    return [e.get("doc_id") for e in page.get("entries", [])]


async def check_route(ctx):
    for n, body in enumerate(("groceries", "call the plumber", "packing list"), 1):
        _write(f"d-{n}", 0, body)
    async with _api(ctx) as c:
        page = await _pull(c, cursor=0)
        anonymous = await c.get("/v1/sync/pull")
    assert _ids(page) == ["d-1", "d-2", "d-3"], f"a device at cursor 0 must get d-1, d-2, d-3 in revision order, got {_ids(page)}"
    first = page["entries"][0]
    want = {"doc_id": "d-1", "revision": 1, "content_hash": store.content_hash("groceries"), "body": "groceries"}
    assert first == want, f"an entry must be the head's doc_id, revision, content_hash and body, got {first}"
    assert page.get("cursor") == 3 and page.get("has_more") is False, f"after every change the answer must be cursor 3 and has_more false, got cursor {page.get('cursor')} has_more {page.get('has_more')}"
    assert anonymous.status_code == 401, f"a pull without X-Device-Id answered {anonymous.status_code}, expected 401"


async def check_revision_cursor(ctx):
    _write("d-1", 0, "groceries")
    _write("d-2", 0, "call the plumber")
    _write("d-3", 0, "packing list")
    _write("d-1", 1, "groceries: milk")  # revision 4: d-1 moves to the end of the log
    async with _api(ctx) as c:
        page = await _pull(c, cursor=2)
    assert _ids(page) == ["d-3", "d-1"], f"a device at cursor 2 must get what changed after revision 2 (d-3 at 3, d-1 at 4), got {_ids(page)}: the cursor is a revision, not a position in the log"
    assert page["entries"][1].get("body") == "groceries: milk" and page.get("cursor") == 4, f"the page must end with d-1's new body at cursor 4, got {page}"


async def check_page_cursor(ctx):
    for n in range(1, 5):
        _write(f"d-{n}", 0, f"note {n}")
    async with _api(ctx) as c:
        first = await _pull(c, cursor=0, limit=2)
        assert _ids(first) == ["d-1", "d-2"], f"the first page of 2 must be d-1, d-2, got {_ids(first)}"
        assert first.get("cursor") == 2, f"the first page returned revisions 1 and 2 and answered cursor {first.get('cursor')}: a device resuming from it skips everything in between. The cursor is the last revision returned"
        assert first.get("has_more") is True, f"two of four changes were returned and has_more is {first.get('has_more')}"
        second = await _pull(c, cursor=first["cursor"], limit=2)
    assert _ids(second) == ["d-3", "d-4"] and second.get("cursor") == 4, f"resuming from cursor 2 must give d-3, d-4 and cursor 4, got {_ids(second)} and cursor {second.get('cursor')}"
    assert second.get("has_more") is False, f"the second page returned the last two changes and answered has_more {second.get('has_more')}: the device asks again for nothing. Read one row past the page"


async def check_limit_cap(ctx):
    pipe = ctx.redis.pipeline()
    for n in range(1, 1006):
        doc_id, body = f"d-{n}", f"note {n}"
        pipe.hset(f"doc:{doc_id}", mapping={"doc_id": doc_id, "revision": n, "content_hash": store.content_hash(body), "body": body, "device": "laptop"})
        pipe.zadd("changes", {doc_id: n})
    pipe.set("rev:seq", 1005)
    pipe.execute()
    async with _api(ctx) as c:
        page = await _pull(c, cursor=0, limit=5000)
    count = len(page.get("entries", []))
    assert count == 1000, f"a pull asking for 5000 entries got {count}: cap a page at MAX_LIMIT (1000)"
    assert page.get("cursor") == 1000 and page.get("has_more") is True, f"a capped page must answer cursor 1000 and has_more true, got cursor {page.get('cursor')} has_more {page.get('has_more')}"
`,
    typescript: `function api(ctx) {
  const m = ctx.load('read');
  return {c: ctx.client(m.app), store: ctx.load('/support/docsync/store.ts'), revisions: ctx.load('/support/docsync/revisions.ts')};
}

async function write(store, revisions, docId: string, base: number, body: string): Promise<number> {
  return (await revisions.applyChange(docId, base, store.contentHash(body), body, 'laptop')).revision;
}

async function pull(c, query: string) {
  const r = await c.get(\`/v1/sync/pull?\${query}\`, {headers: {'X-Device-Id': 'phone'}});
  assert.equal(r.status, 200, \`GET /v1/sync/pull?\${query} answered \${r.status}: \${r.text}\`);
  return r.json();
}

const ids = page => (page.entries ?? []).map(e => e.doc_id);

export async function check_route(ctx) {
  const {c, store, revisions} = api(ctx);
  for (const [n, body] of [[1, 'groceries'], [2, 'call the plumber'], [3, 'packing list']] as const) await write(store, revisions, \`d-\${n}\`, 0, body);
  const page = await pull(c, 'cursor=0');
  const anonymous = await c.get('/v1/sync/pull');
  assert.deepStrictEqual(ids(page), ['d-1', 'd-2', 'd-3'], \`a device at cursor 0 must get d-1, d-2, d-3 in revision order, got \${JSON.stringify(ids(page))}\`);
  assert.deepStrictEqual(page.entries[0], {doc_id: 'd-1', revision: 1, content_hash: store.contentHash('groceries'), body: 'groceries'}, \`an entry must be the head's doc_id, revision, content_hash and body, got \${JSON.stringify(page.entries[0])}\`);
  assert(page.cursor === 3 && page.has_more === false, \`after every change the answer must be cursor 3 and has_more false, got cursor \${page.cursor} has_more \${page.has_more}\`);
  assert.equal(anonymous.status, 401, \`a pull without X-Device-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_revision_cursor(ctx) {
  const {c, store, revisions} = api(ctx);
  await write(store, revisions, 'd-1', 0, 'groceries');
  await write(store, revisions, 'd-2', 0, 'call the plumber');
  await write(store, revisions, 'd-3', 0, 'packing list');
  await write(store, revisions, 'd-1', 1, 'groceries: milk'); // revision 4: d-1 moves to the end of the log
  const page = await pull(c, 'cursor=2');
  assert.deepStrictEqual(ids(page), ['d-3', 'd-1'], \`a device at cursor 2 must get what changed after revision 2 (d-3 at 3, d-1 at 4), got \${JSON.stringify(ids(page))}: the cursor is a revision, not a position in the log\`);
  assert(page.entries[1].body === 'groceries: milk' && page.cursor === 4, \`the page must end with d-1's new body at cursor 4, got \${JSON.stringify(page)}\`);
}

export async function check_page_cursor(ctx) {
  const {c, store, revisions} = api(ctx);
  for (let n = 1; n <= 4; n++) await write(store, revisions, \`d-\${n}\`, 0, \`note \${n}\`);
  const first = await pull(c, 'cursor=0&limit=2');
  assert.deepStrictEqual(ids(first), ['d-1', 'd-2'], \`the first page of 2 must be d-1, d-2, got \${JSON.stringify(ids(first))}\`);
  assert.equal(first.cursor, 2, \`the first page returned revisions 1 and 2 and answered cursor \${first.cursor}: a device resuming from it skips everything in between. The cursor is the last revision returned\`);
  assert.equal(first.has_more, true, \`two of four changes were returned and has_more is \${first.has_more}\`);
  const second = await pull(c, \`cursor=\${first.cursor}&limit=2\`);
  assert(JSON.stringify(ids(second)) === '["d-3","d-4"]' && second.cursor === 4, \`resuming from cursor 2 must give d-3, d-4 and cursor 4, got \${JSON.stringify(ids(second))} and cursor \${second.cursor}\`);
  assert.equal(second.has_more, false, \`the second page returned the last two changes and answered has_more \${second.has_more}: the device asks again for nothing. Read one row past the page\`);
}

export async function check_limit_cap(ctx) {
  const {c, store} = api(ctx);
  for (let n = 1; n <= 1005; n++) {
    const body = \`note \${n}\`;
    ctx.redis.hset(\`doc:d-\${n}\`, {doc_id: \`d-\${n}\`, revision: n, content_hash: store.contentHash(body), body, device: 'laptop'});
    ctx.redis.zadd('changes', n, \`d-\${n}\`);
  }
  ctx.redis.set('rev:seq', 1005);
  const page = await pull(c, 'cursor=0&limit=5000');
  assert.equal(page.entries.length, 1000, \`a pull asking for 5000 entries got \${page.entries.length}: cap a page at MAX_LIMIT (1000)\`);
  assert(page.cursor === 1000 && page.has_more === true, \`a capped page must answer cursor 1000 and has_more true, got cursor \${page.cursor} has_more \${page.has_more}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"docsync/revisions"
	"docsync/store"

	"leetbuild/harness"
)

var readBg = context.Background()

type readPage struct {
	Entries []struct {
		DocID       string \`json:"doc_id"\`
		Revision    int64  \`json:"revision"\`
		ContentHash string \`json:"content_hash"\`
		Body        string \`json:"body"\`
	} \`json:"entries"\`
	Cursor  int64 \`json:"cursor"\`
	HasMore bool  \`json:"has_more"\`
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readWrite(ctx *harness.Ctx, docID string, base int64, body string) {
	_, err := revisions.ApplyChange(readBg, docID, base, store.ContentHash(body), body, "laptop")
	ctx.NoError(err, "writing %s", docID)
}

func readPull(ctx *harness.Ctx, c *harness.HTTP, query string) readPage {
	r := c.Get("/v1/sync/pull?"+query, "X-Device-Id", "phone")
	ctx.Equal(r.Status, 200, "GET /v1/sync/pull?%s (%s)", query, r.Text())
	var page readPage
	r.Decode(&page)
	return page
}

func readIDs(page readPage) []string {
	ids := []string{}
	for _, e := range page.Entries {
		ids = append(ids, e.DocID)
	}
	return ids
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	for n, body := range []string{"groceries", "call the plumber", "packing list"} {
		readWrite(ctx, fmt.Sprintf("d-%d", n+1), 0, body)
	}
	page := readPull(ctx, c, "cursor=0")
	ctx.Equal(readIDs(page), []string{"d-1", "d-2", "d-3"}, "a device at cursor 0 must get every document in revision order")
	first := page.Entries[0]
	ctx.Assert(first.DocID == "d-1" && first.Revision == 1 && first.ContentHash == store.ContentHash("groceries") && first.Body == "groceries", "an entry must be the head's doc_id, revision, content_hash and body, got %+v", first)
	ctx.Assert(page.Cursor == 3 && !page.HasMore, "after every change the answer must be cursor 3 and has_more false, got cursor %d has_more %v", page.Cursor, page.HasMore)
	ctx.Equal(c.Get("/v1/sync/pull").Status, 401, "a pull without X-Device-Id")
}

func CheckRevisionCursor(ctx *harness.Ctx) {
	c := readAPI(ctx)
	readWrite(ctx, "d-1", 0, "groceries")
	readWrite(ctx, "d-2", 0, "call the plumber")
	readWrite(ctx, "d-3", 0, "packing list")
	readWrite(ctx, "d-1", 1, "groceries: milk") // revision 4: d-1 moves to the end of the log
	page := readPull(ctx, c, "cursor=2")
	ctx.Equal(readIDs(page), []string{"d-3", "d-1"}, "a device at cursor 2 must get what changed after revision 2, d-3 at 3 and d-1 at 4 (the cursor is a revision, not a position in the log)")
	ctx.Assert(page.Entries[1].Body == "groceries: milk" && page.Cursor == 4, "the page must end with d-1's new body at cursor 4, got %+v", page)
}

func CheckPageCursor(ctx *harness.Ctx) {
	c := readAPI(ctx)
	for n := 1; n <= 4; n++ {
		readWrite(ctx, fmt.Sprintf("d-%d", n), 0, fmt.Sprintf("note %d", n))
	}
	first := readPull(ctx, c, "cursor=0&limit=2")
	ctx.Equal(readIDs(first), []string{"d-1", "d-2"}, "the first page of 2")
	ctx.Equal(first.Cursor, int64(2), "the first page returned revisions 1 and 2: a device resuming from a later cursor skips everything in between. The cursor is the last revision returned; the cursor")
	ctx.Equal(first.HasMore, true, "two of four changes were returned; has_more")
	second := readPull(ctx, c, fmt.Sprintf("cursor=%d&limit=2", first.Cursor))
	ctx.Assert(len(second.Entries) == 2 && second.Entries[0].DocID == "d-3" && second.Entries[1].DocID == "d-4" && second.Cursor == 4, "resuming from cursor 2 must give d-3, d-4 and cursor 4, got %v and cursor %d", readIDs(second), second.Cursor)
	ctx.Equal(second.HasMore, false, "the second page returned the last two changes (the device would ask again for nothing: read one row past the page); has_more")
}

func CheckLimitCap(ctx *harness.Ctx) {
	c := readAPI(ctx)
	for n := 1; n <= 1005; n++ {
		docID, body := fmt.Sprintf("d-%d", n), fmt.Sprintf("note %d", n)
		ctx.Redis.Do("HSET", "doc:"+docID, "doc_id", docID, "revision", n, "content_hash", store.ContentHash(body), "body", body, "device", "laptop")
		ctx.Redis.Do("ZADD", "changes", n, docID)
	}
	ctx.Redis.Set("rev:seq", 1005)
	page := readPull(ctx, c, "cursor=0&limit=5000")
	ctx.Equal(len(page.Entries), 1000, "a pull asking for 5000 entries must be capped at MAX_LIMIT (1000); the entries")
	ctx.Assert(page.Cursor == 1000 && page.HasMore, "a capped page must answer cursor 1000 and has_more true, got cursor %d has_more %v", page.Cursor, page.HasMore)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "docsync/revisions.h"
#include "docsync/store.h"

namespace {

using Json = nlohmann::json;

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

void readWrite(const std::string& doc_id, long long base, const std::string& body) {
  revisions::applyChange(doc_id, base, store::contentHash(body), body, "laptop");
}

Json readPull(harness::Ctx& ctx, harness::HTTP& c, const std::string& query) {
  const auto r = c.Get("/v1/sync/pull?" + query, "X-Device-Id", "phone");
  ctx.Equal(r.Status, 200, "GET /v1/sync/pull?%s (%s)", query, r.Text());
  return Json::parse(r.Text(), nullptr, false);
}

std::vector<std::string> readIds(const Json& page) {
  std::vector<std::string> ids;
  for (const Json& e : page.value("entries", Json::array())) ids.push_back(e.value("doc_id", ""));
  return ids;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  readWrite("d-1", 0, "groceries");
  readWrite("d-2", 0, "call the plumber");
  readWrite("d-3", 0, "packing list");
  const Json page = readPull(ctx, c, "cursor=0");
  ctx.Equal(readIds(page), {"d-1", "d-2", "d-3"}, "a device at cursor 0 must get every document in revision order");
  const Json want = {{"doc_id", "d-1"}, {"revision", 1}, {"content_hash", store::contentHash("groceries")}, {"body", "groceries"}};
  ctx.Assert(page["entries"][0] == want, "an entry must be the head's doc_id, revision, content_hash and body, got %s", page["entries"][0].dump());
  ctx.Assert(page.value("cursor", 0LL) == 3 && page.value("has_more", true) == false, "after every change the answer must be cursor 3 and has_more false, got %s", page.dump());
  ctx.Equal(c.Get("/v1/sync/pull").Status, 401, "a pull without X-Device-Id");
}

void CheckRevisionCursor(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  readWrite("d-1", 0, "groceries");
  readWrite("d-2", 0, "call the plumber");
  readWrite("d-3", 0, "packing list");
  readWrite("d-1", 1, "groceries: milk");  // revision 4: d-1 moves to the end of the log
  const Json page = readPull(ctx, c, "cursor=2");
  ctx.Equal(readIds(page), {"d-3", "d-1"}, "a device at cursor 2 must get what changed after revision 2, d-3 at 3 and d-1 at 4 (the cursor is a revision, not a position in the log)");
  ctx.Assert(page["entries"][1].value("body", "") == "groceries: milk" && page.value("cursor", 0LL) == 4, "the page must end with d-1's new body at cursor 4, got %s", page.dump());
}

void CheckPageCursor(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  for (int n = 1; n <= 4; n++) readWrite("d-" + std::to_string(n), 0, "note " + std::to_string(n));
  const Json first = readPull(ctx, c, "cursor=0&limit=2");
  ctx.Equal(readIds(first), {"d-1", "d-2"}, "the first page of 2");
  ctx.Equal(first.value("cursor", 0LL), 2LL, "the first page returned revisions 1 and 2: a device resuming from a later cursor skips everything in between. The cursor is the last revision returned; the cursor");
  ctx.Equal(first.value("has_more", false), true, "two of four changes were returned; has_more");
  const Json second = readPull(ctx, c, "cursor=" + std::to_string(first.value("cursor", 0LL)) + "&limit=2");
  ctx.Assert(readIds(second) == std::vector<std::string>{"d-3", "d-4"} && second.value("cursor", 0LL) == 4, "resuming from cursor 2 must give d-3, d-4 and cursor 4, got %s", second.dump());
  ctx.Equal(second.value("has_more", true), false, "the second page returned the last two changes (the device would ask again for nothing: read one row past the page); has_more");
}

void CheckLimitCap(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  for (int n = 1; n <= 1005; n++) {
    const std::string doc_id = "d-" + std::to_string(n), body = "note " + std::to_string(n);
    ctx.Redis.Do("HSET", "doc:" + doc_id, "doc_id", doc_id, "revision", n, "content_hash", store::contentHash(body), "body", body, "device", "laptop");
    ctx.Redis.Do("ZADD", "changes", n, doc_id);
  }
  ctx.Redis.Set("rev:seq", 1005);
  const Json page = readPull(ctx, c, "cursor=0&limit=5000");
  ctx.Equal(page.value("entries", Json::array()).size(), size_t{1000}, "a pull asking for 5000 entries must be capped at MAX_LIMIT (1000); the entries");
  ctx.Assert(page.value("cursor", 0LL) == 1000 && page.value("has_more", false), "a capped page must answer cursor 1000 and has_more true, got cursor %d", page.value("cursor", 0LL));
}
`,
  },
  hints: [
    'Pull two entries out of four: the answer’s cursor already says 4, so the next pull returns nothing. Edit an old document between two pulls: another one vanishes from the second page.',
    '`ZRANGE` counts positions, and an edit moves a document to the end of the log, shifting every position after it. The answered cursor is the newest revision anywhere, not the last one in the page.',
    '`ZRANGEBYSCORE changes (cursor +inf WITHSCORES LIMIT 0 limit+1` with `limit = min(limit, MAX_LIMIT)`; return the first `limit`, answer the last one’s score as the cursor and `has_more = len(rows) > limit`.',
  ],
  debrief: `A cursor is only safe to hand out if it means "everything up to here", which is why it is the revision of the last entry returned rather than the newest one anywhere, and why the read is by score rather than position: a revision does not move when someone edits, a position does. Reading one row past the page answers has_more exactly, so a client on the last page stops instead of asking again. Because the log keeps one entry per document, a device away for a month gets each document once, at its newest revision. Dropbox keeps its cursor opaque so it can change what the cursor encodes; a production pull would do the same, sign it, and add long polling so an idle device waits for the next change instead of asking on a timer.`,
};
