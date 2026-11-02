import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis thread counters and hot-thread cache',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter inserts the comment, then runs a separate \`INCR\` on
\`thread_count:{thread_id}\`, a \`ZINCRBY\` on one shared \`trending:threads\` set, and reads the hot
list from that same set. It compiles, the counters look right in a demo, and it hides five flaws.

**Failure mode the checks target.** A crash after the insert and before the \`INCR\` leaves the
thread one comment short for good, with no path to repair it; the hot-thread set has no tenant and no
expiry, so one tenant's trending thread surfaces on another tenant's homepage and a quiet tenant's
scores accumulate forever.

- Every comment write commits its counters **in the same atomic step as the insert**: one Lua script
  (\`COMMIT_COMMENT_LUA\`) bumps the thread counter, bumps the parent's reply counter when the
  comment is a reply, and touches the tenant's hot-thread set, inside the transaction that inserts
  the comment.
- The thread counter key is \`thread:{tenant}:{thread_id}:count\`, incremented with \`INCR\` from
  inside the script. Two tenants with the same thread id are two different threads.
- The reply counter key is \`thread:{tenant}:{thread_id}:replies:{parent_id}\`, bumped only when
  the comment has a parent (pass an empty key otherwise).
- The hot-thread set is tenant-scoped: \`hot:{tenant}\`, a sorted set where a new comment adds one
  to the thread's score (\`ZINCRBY\`), with an expiry of \`HOT_TTL_S\` seconds refreshed on the
  atomic path.
- The read of the hot list returns only the **first page** (\`HOT_PAGE_SIZE\` members, highest score
  first).
- \`recount_thread(tenant, thread_id)\` recomputes the counter from the durable store
  (\`count_for_thread\`) and \`SET\`s the Redis key: the reconciliation path after a lost script or a
  restored backup. The store, not Redis, is the source of truth.`,
  sequence: {
    participants: ['Comments API', 'Redis', 'comment store'],
    messages: [
      {from: 'Comments API', to: 'comment store', label: 'BEGIN · insert(comment)', kind: 'sync'},
      {
        from: 'Comments API',
        to: 'Redis',
        label: 'EVAL COMMIT_COMMENT_LUA · KEYS[count, replies, hot:{tenant}]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Comments API', label: 'INCR · ZINCRBY · EXPIRE → thread count', kind: 'reply'},
      {from: 'Comments API', to: 'comment store', label: 'COMMIT (insert and counters land together)', kind: 'sync'},
      {from: 'Comments API', to: 'Redis', label: 'recount_thread: SET counter = count_for_thread(...)', kind: 'async'},
      {
        from: 'Comments API',
        to: 'Comments API',
        label: 'hot_threads: ZREVRANGE hot:{tenant} 0..HOT_PAGE_SIZE-1',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic',
      title: 'Commits the counters with the write in one script',
      detail:
        'A single Lua script (`COMMIT_COMMENT_LUA`) bumps the counters inside the same transaction as the insert. The starter increments with a separate command after the write, so a crash between the two undercounts the thread permanently.',
      match: {
        python: {all: [/COMMIT_COMMENT_LUA/, /\.eval\(/, /INCR/]},
        typescript: {all: [/COMMIT_COMMENT_LUA/, /\.eval\(/, /INCR/]},
        go: {all: [/commitCommentScript/, /\.Run\(/, /INCR/]},
        scala: {all: [/CommitCommentLua/, /\.eval\(/, /INCR/]},
        cpp: {all: [/kCommitCommentLua/, /\.eval</, /INCR/]},
      },
    },
    {
      id: 'counter-key',
      title: 'Keys the thread counter by tenant and thread',
      detail:
        'The counter key is `thread:{tenant}:{thread_id}:count`; a tenant-less key lets two tenants with the same thread id share one counter.',
      match: {
        python: {all: [/thread:\{tenant\}:\{thread_id\}:count/]},
        typescript: {all: [/thread:\$\{tenant\}:\$\{threadId\}:count/]},
        go: {all: [/thread:%s:%s:count/]},
        scala: {all: [/thread:\$tenant:\$threadId:count/]},
        cpp: {all: [/"thread:"/, /":count"/]},
      },
    },
    {
      id: 'hot-tenant',
      title: 'Scopes the hot-thread key to the tenant',
      detail:
        'The hot set is `hot:{tenant}`. The starter uses one shared `trending:threads` key, so one tenant’s trending list is served to every other tenant.',
      match: {
        python: {all: [/hot:\{tenant\}/]},
        typescript: {all: [/hot:\$\{tenant\}/]},
        go: {all: [/hot:%s/]},
        scala: {all: [/hot:\$tenant/]},
        cpp: {all: [/"hot:"/]},
      },
    },
    {
      id: 'recount',
      title: 'Recounts the counter from the durable store',
      detail:
        '`recount_thread` counts the comments in the store (`count_for_thread`) and `SET`s the Redis counter to that value: the reconciliation path that makes the counter derived state rather than the truth.',
      match: {
        python: {all: [/def recount_thread\(/, /count_for_thread\(/, /\.set\(/]},
        typescript: {all: [/export async function recountThread\(/, /countForThread\(/, /\.set\(/]},
        go: {all: [/func recountThread\(/, /CountForThread\(/, /\.Set\(/]},
        scala: {all: [/def recountThread\(/, /countForThread\(/, /\.set\(/]},
        cpp: {all: [/recountThread\(/, /countForThread\(/, /\.set\(/]},
      },
    },
    {
      id: 'hot-page',
      title: 'Serves a bounded, expiring first page of hot threads',
      detail:
        'The hot list is read as a bounded page (`ZREVRANGE` 0…`HOT_PAGE_SIZE - 1`) and the set carries a `HOT_TTL_S` expiry, so a quiet tenant’s cache disappears instead of accumulating.',
      match: {
        python: {all: [/HOT_TTL_S/, /zrevrange\(/]},
        typescript: {all: [/HOT_TTL_S/, /zrevrange\(/]},
        go: {all: [/hotTTLS/, /ZRevRange\(/]},
        scala: {all: [/HotTtlS/, /zrevrange\(/]},
        cpp: {all: [/kHotTtlS/, /zrevrange\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOT_PAGE_SIZE = 20


class CommentRequest(BaseModel):
    thread_id: str
    parent_id: str | None = None
    text: str


class CommentStore:
    def insert(self, comment: dict) -> None:
        """Persist the comment."""
        raise NotImplementedError


store = CommentStore()


@app.post("/v1/comments")
def create_comment(body: CommentRequest, tenant: str = Header(default="", alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    comment = {"thread_id": body.thread_id, "parent_id": body.parent_id, "text": body.text}
    store.insert(comment)
    r.incr(f"thread_count:{body.thread_id}")
    r.zincrby("trending:threads", 1, body.thread_id)
    return JSONResponse({"thread_count": r.get(f"thread_count:{body.thread_id}")}, status_code=201)


def hot_threads(tenant: str) -> list[str]:
    return r.zrevrange("trending:threads", 0, HOT_PAGE_SIZE - 1)
`,
      solution: `import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOT_TTL_S = 300
HOT_PAGE_SIZE = 20

COMMIT_COMMENT_LUA = """
redis.call('INCR', KEYS[1])
if KEYS[2] ~= '' then
  redis.call('INCR', KEYS[2])
end
redis.call('ZINCRBY', KEYS[3], 1, ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return redis.call('GET', KEYS[1])
"""


class CommentRequest(BaseModel):
    thread_id: str
    parent_id: str | None = None
    text: str


class CommentStore:
    def insert(self, comment: dict) -> None:
        """Persist the comment."""
        raise NotImplementedError

    def count_for_thread(self, tenant: str, thread_id: str) -> int:
        """The number of comments the durable store holds for this tenant's thread."""
        raise NotImplementedError


store = CommentStore()


def thread_count_key(tenant: str, thread_id: str) -> str:
    return f"thread:{tenant}:{thread_id}:count"


def reply_key(tenant: str, comment: dict) -> str:
    parent_id = comment.get("parent_id")
    if parent_id is None:
        return ""
    return f"thread:{tenant}:{comment['thread_id']}:replies:{parent_id}"


def hot_key(tenant: str) -> str:
    return f"hot:{tenant}"


def commit_comment(tenant: str, comment: dict) -> int:
    """Insert the comment and commit its counters in one step: neither lands without the other."""
    print("BEGIN")
    store.insert(comment)
    count = int(
        r.eval(
            COMMIT_COMMENT_LUA,
            3,
            thread_count_key(tenant, comment["thread_id"]),
            reply_key(tenant, comment),
            hot_key(tenant),
            comment["thread_id"],
            HOT_TTL_S,
        )
    )
    print("COMMIT")
    return count


def recount_thread(tenant: str, thread_id: str) -> int:
    """Recompute the counter from the durable store — the crash-recovery path."""
    total = store.count_for_thread(tenant, thread_id)
    r.set(thread_count_key(tenant, thread_id), total)
    return total


@app.post("/v1/comments")
def create_comment(body: CommentRequest, tenant: str = Header(default="", alias="X-Tenant-Id")) -> JSONResponse:
    comment = {"thread_id": body.thread_id, "parent_id": body.parent_id, "text": body.text}
    count = commit_comment(tenant, comment)
    return JSONResponse({"thread_count": count}, status_code=201)


def hot_threads(tenant: str) -> list[str]:
    """The first page of this tenant's hot threads, from the tenant's own key."""
    return r.zrevrange(hot_key(tenant), 0, HOT_PAGE_SIZE - 1)
`,
    },
    typescript: {
      starter: `/** POST /v1/comments: flawed code that counts after the write. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const HOT_PAGE_SIZE = 20;

interface CommentBody {
  thread_id: string;
  parent_id?: string | null;
  text: string;
}

app.post('/v1/comments', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as CommentBody;
  const comment = {thread_id: body.thread_id, parent_id: body.parent_id ?? null, text: body.text};
  await store.insert(tenant, comment);
  await r.incr(\`thread_count:\${body.thread_id}\`);
  await r.zincrby('trending:threads', 1, body.thread_id);
  const count = await r.get(\`thread_count:\${body.thread_id}\`);
  return reply.code(201).send({thread_count: Number(count)});
});

export async function hotThreads(tenant: string): Promise<string[]> {
  return r.zrevrange('trending:threads', 0, HOT_PAGE_SIZE - 1);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/comments: thread counters and hot threads committed with the comment. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const HOT_TTL_S = 300;
const HOT_PAGE_SIZE = 20;

const COMMIT_COMMENT_LUA = \`
redis.call('INCR', KEYS[1])
if KEYS[2] ~= '' then
  redis.call('INCR', KEYS[2])
end
redis.call('ZINCRBY', KEYS[3], 1, ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return redis.call('GET', KEYS[1])
\`;

interface CommentBody {
  thread_id: string;
  parent_id?: string | null;
  text: string;
}

function threadCountKey(tenant: string, threadId: string): string {
  return \`thread:\${tenant}:\${threadId}:count\`;
}

function replyKey(tenant: string, threadId: string, parentId: string | null): string {
  return parentId === null ? '' : \`thread:\${tenant}:\${threadId}:replies:\${parentId}\`;
}

function hotKey(tenant: string): string {
  return \`hot:\${tenant}\`;
}

/** Insert the comment and commit its counters in one step: neither lands without the other. */
async function commitComment(tenant: string, comment: {thread_id: string; parent_id: string | null; text: string}): Promise<number> {
  return store.transaction(async tx => {
    await tx.insert(tenant, comment);
    const count = await r.eval(
      COMMIT_COMMENT_LUA,
      3,
      threadCountKey(tenant, comment.thread_id),
      replyKey(tenant, comment.thread_id, comment.parent_id),
      hotKey(tenant),
      comment.thread_id,
      String(HOT_TTL_S),
    );
    await tx.commit();
    return Number(count);
  });
}

/** Recompute the counter from the durable store — the crash-recovery path. */
export async function recountThread(tenant: string, threadId: string): Promise<number> {
  const total = await store.countForThread(tenant, threadId);
  await r.set(threadCountKey(tenant, threadId), String(total));
  return total;
}

/** The first page of this tenant's hot threads, from the tenant's own key. */
export async function hotThreads(tenant: string): Promise<string[]> {
  return r.zrevrange(hotKey(tenant), 0, HOT_PAGE_SIZE - 1);
}

app.post('/v1/comments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as CommentBody;
  const comment = {thread_id: body.thread_id, parent_id: body.parent_id ?? null, text: body.text};
  const count = await commitComment(tenant, comment);
  return reply.code(201).send({thread_count: count});
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

	"github.com/redis/go-redis/v9"
)

const hotPageSize = 20

var rdb *redis.Client

type Comment struct {
	ID       string  \`json:"id"\`
	ThreadID string  \`json:"thread_id"\`
	ParentID *string \`json:"parent_id"\`
	Text     string  \`json:"text"\`
}

type CommentStore struct{}

func (s *CommentStore) Insert(ctx context.Context, comment *Comment) error { return nil }

var store = &CommentStore{}

func createComment(rw http.ResponseWriter, r *http.Request) {
	var comment Comment
	if err := json.NewDecoder(r.Body).Decode(&comment); err != nil {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	_ = store.Insert(r.Context(), &comment)
	rdb.Incr(r.Context(), "thread_count:"+comment.ThreadID)
	rdb.ZIncrBy(r.Context(), "trending:threads", 1, comment.ThreadID)
	count, _ := rdb.Get(r.Context(), "thread_count:"+comment.ThreadID).Result()
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"thread_count":\` + count + \`}\`))
}

func hotThreads(ctx context.Context, tenant string) []string {
	threads, _ := rdb.ZRevRange(ctx, "trending:threads", 0, hotPageSize-1).Result()
	return threads
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const (
	hotTTLS     = 300
	hotPageSize = 20
)

var commitCommentScript = redis.NewScript(\`
redis.call('INCR', KEYS[1])
if KEYS[2] ~= '' then
  redis.call('INCR', KEYS[2])
end
redis.call('ZINCRBY', KEYS[3], 1, ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return redis.call('GET', KEYS[1])
\`)

var rdb *redis.Client

type Comment struct {
	ID       string  \`json:"id"\`
	ThreadID string  \`json:"thread_id"\`
	ParentID *string \`json:"parent_id"\`
	Text     string  \`json:"text"\`
}

type CommentStore struct{}

func (s *CommentStore) InsertTx(ctx context.Context, tx *Tx, comment *Comment) error { return nil }

func (s *CommentStore) CountForThread(ctx context.Context, tenant, threadID string) (int64, error) {
	return 0, nil
}

var store = &CommentStore{}

func threadCountKey(tenant, threadID string) string {
	return fmt.Sprintf("thread:%s:%s:count", tenant, threadID)
}

func replyKey(tenant, threadID string, parentID *string) string {
	if parentID == nil {
		return ""
	}
	return fmt.Sprintf("thread:%s:%s:replies:%s", tenant, threadID, *parentID)
}

func hotKey(tenant string) string {
	return fmt.Sprintf("hot:%s", tenant)
}

// commitComment inserts the comment and commits its counters in one step: neither lands without
// the other, so a crash cannot leave the store holding a comment the counter never saw.
func commitComment(ctx context.Context, tenant string, comment *Comment) (int64, error) {
	tx := store.Begin(ctx)
	if err := store.InsertTx(ctx, tx, comment); err != nil {
		tx.Rollback(ctx)
		return 0, err
	}
	count, err := commitCommentScript.Run(ctx, rdb, []string{
		threadCountKey(tenant, comment.ThreadID),
		replyKey(tenant, comment.ThreadID, comment.ParentID),
		hotKey(tenant),
	}, comment.ThreadID, hotTTLS).Int64()
	if err != nil {
		tx.Rollback(ctx)
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return count, nil
}

// recountThread recomputes the counter from the durable store — the crash-recovery path.
func recountThread(ctx context.Context, tenant, threadID string) (int64, error) {
	total, err := store.CountForThread(ctx, tenant, threadID)
	if err != nil {
		return 0, err
	}
	if err := rdb.Set(ctx, threadCountKey(tenant, threadID), total, 0).Err(); err != nil {
		return 0, err
	}
	return total, nil
}

func createComment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var comment Comment
	if err := json.NewDecoder(r.Body).Decode(&comment); err != nil {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	count, err := commitComment(r.Context(), tenant, &comment)
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"thread_count":%d}\`, count)))
}

// hotThreads returns the first page of this tenant's hot threads, from the tenant's own key.
func hotThreads(ctx context.Context, tenant string) []string {
	threads, _ := rdb.ZRevRange(ctx, hotKey(tenant), 0, hotPageSize-1).Result()
	return threads
}

func main() {}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object CommentState {
  val HotPageSize = 20L

  val jedis = new Jedis("redis", 6379)
  val store = CommentStore.open()

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def createComment(tenant: String, comment: Comment): Long = {
    store.insert(comment)
    val count = jedis.incr(s"thread_count:\${comment.thread_id}")
    jedis.zincrby("trending:threads", 1, comment.thread_id)
    count
  }

  def hotThreads(tenant: String): java.util.List[String] =
    jedis.zrevrange("trending:threads", 0, HotPageSize - 1)
}
`,
      solution: `import redis.clients.jedis.Jedis

final case class Comment(id: String, thread_id: String, parent_id: Option[String], text: String)

object CommentState {
  val HotTtlS = 300L
  val HotPageSize = 20L

  val jedis = new Jedis("redis", 6379)
  val store = CommentStore.open()

  val CommitCommentLua =
    """
      |redis.call('INCR', KEYS[1])
      |if KEYS[2] ~= '' then
      |  redis.call('INCR', KEYS[2])
      |end
      |redis.call('ZINCRBY', KEYS[3], 1, ARGV[1])
      |redis.call('EXPIRE', KEYS[3], ARGV[2])
      |return redis.call('GET', KEYS[1])
      |""".stripMargin

  def threadCountKey(tenant: String, threadId: String): String = s"thread:$tenant:$threadId:count"

  def replyKey(tenant: String, threadId: String, parentId: Option[String]): String =
    parentId.map(id => s"thread:$tenant:$threadId:replies:$id").getOrElse("")

  def hotKey(tenant: String): String = s"hot:$tenant"

  /** Insert the comment and commit its counters in one step: neither lands without the other. */
  def commitComment(tenant: String, comment: Comment): Long =
    store.transaction { tx =>
      tx.insert(comment)
      val keys = java.util.List.of(
        threadCountKey(tenant, comment.thread_id),
        replyKey(tenant, comment.thread_id, comment.parent_id),
        hotKey(tenant)
      )
      val count = jedis
        .eval(CommitCommentLua, keys, java.util.List.of(comment.thread_id, HotTtlS.toString))
        .asInstanceOf[String]
        .toLong
      tx.commit()
      count
    }

  /** Recompute the counter from the durable store — the crash-recovery path. */
  def recountThread(tenant: String, threadId: String): Long = {
    val total = store.countForThread(tenant, threadId)
    jedis.set(threadCountKey(tenant, threadId), total.toString)
    total
  }

  /** The first page of this tenant's hot threads, from the tenant's own key. */
  def hotThreads(tenant: String): java.util.List[String] =
    jedis.zrevrange(hotKey(tenant), 0, HotPageSize - 1)

  def createComment(tenant: String, comment: Comment): Long = commitComment(tenant, comment)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

constexpr long long kHotPageSize = 20;

struct CommentStore {
  void insert(const Comment& comment);
};

struct Comment {
  std::string id;
  std::string threadId;
  std::optional<std::string> parentId;
  std::string text;
};

CommentStore store;

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
long long createComment(sw::redis::Redis& redis, const std::string& tenant, const Comment& comment) {
  store.insert(comment);
  redis.incr("thread_count:" + comment.threadId);
  redis.zincrby("trending:threads", 1, comment.threadId);
  return redis.get("thread_count:" + comment.threadId).value_or("0") == "0" ? 0 : 1;
}

std::vector<std::string> hotThreads(sw::redis::Redis& redis, const std::string& tenant) {
  std::vector<std::string> threads;
  redis.zrevrange("trending:threads", 0, kHotPageSize - 1, std::back_inserter(threads));
  return threads;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

constexpr long long kHotTtlS = 300;
constexpr long long kHotPageSize = 20;

const char* kCommitCommentLua = R"LUA(
redis.call('INCR', KEYS[1])
if KEYS[2] ~= '' then
  redis.call('INCR', KEYS[2])
end
redis.call('ZINCRBY', KEYS[3], 1, ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return redis.call('GET', KEYS[1])
)LUA";

struct Comment {
  std::string id;
  std::string threadId;
  std::optional<std::string> parentId;
  std::string text;
};

struct CommentStore {
  std::unique_ptr<Tx> begin();
  void insertTx(Tx& tx, const Comment& comment);
  long long countForThread(const std::string& tenant, const std::string& threadId);
};

CommentStore store;

static std::string threadCountKey(const std::string& tenant, const std::string& threadId) {
  return "thread:" + tenant + ":" + threadId + ":count";
}

static std::string replyKey(const std::string& tenant, const std::string& threadId, const std::optional<std::string>& parentId) {
  return parentId ? "thread:" + tenant + ":" + threadId + ":replies:" + *parentId : std::string();
}

static std::string hotKey(const std::string& tenant) { return "hot:" + tenant; }

// commitComment inserts the comment and commits its counters in one step: neither lands without
// the other, so a crash cannot leave the store holding a comment the counter never saw.
static long long commitComment(sw::redis::Redis& redis, const std::string& tenant, const Comment& comment) {
  auto tx = store.begin();
  store.insertTx(*tx, comment);
  const auto count = redis.eval<long long>(
      kCommitCommentLua,
      {threadCountKey(tenant, comment.threadId), replyKey(tenant, comment.threadId, comment.parentId), hotKey(tenant)},
      {comment.threadId, kHotTtlS});
  tx->commit();
  return count;
}

// recountThread recomputes the counter from the durable store — the crash-recovery path.
static long long recountThread(sw::redis::Redis& redis, const std::string& tenant, const std::string& threadId) {
  const auto total = store.countForThread(tenant, threadId);
  redis.set(threadCountKey(tenant, threadId), std::to_string(total));
  return total;
}

long long createComment(sw::redis::Redis& redis, const std::string& tenant, const Comment& comment) {
  return commitComment(redis, tenant, comment);
}

// hotThreads returns the first page of this tenant's hot threads, from the tenant's own key.
static std::vector<std::string> hotThreads(sw::redis::Redis& redis, const std::string& tenant) {
  std::vector<std::string> threads;
  redis.zrevrange(hotKey(tenant), 0, kHotPageSize - 1, std::back_inserter(threads));
  return threads;
}
`,
    },
  },
  hints: [
    'Kill the process between `store.insert` and `r.incr` and the thread count stays one short for good. Open the trending list as tenant B and thread ids from tenant A are on it.',
    'Two commands are two failure points; only one of them is inside the transaction. And `trending:threads` has no tenant in its name and no `EXPIRE`, so every tenant reads one set that only grows.',
    'Move the `INCR`, the parent `INCR` and `ZINCRBY` plus `EXPIRE HOT_TTL_S` into `COMMIT_COMMENT_LUA` run by `r.eval` next to the insert; key by `thread:{tenant}:{thread_id}:count` and `hot:{tenant}`; add `recount_thread` with `count_for_thread` and `set`.',
  ],
  debrief: `The fix is one Lua script that moves every counter mutation into the same commit as the insert, because the question behind the step is "what can disagree, and for how long?". A counter incremented in a second command can disagree with the store forever, since nothing else knows the comment exists; the only repair is a recount from the durable side, which is why \`recount_thread\` is part of the feature rather than an ops script. The tenant belongs in every key because Redis has no notion of tenancy: a key that forgets it turns a cache into a cross-tenant leak that no query can prevent, because the query never runs. Production services go further with hot-thread decay, so scores fade instead of growing, and sharded counters for threads with millions of comments, where one key becomes a hotspot.`,
};
