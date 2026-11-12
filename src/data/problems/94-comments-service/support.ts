/**
 * Hand-written support modules the comments-service steps import but no step builds: the `comments`
 * package. `comments.store` is the comment store (Redis stands in for the comments database): one
 * JSON document per comment, a per-thread index scored by a store-wide sequence, the recorded
 * Idempotency-Keys, and the two queues step 3 writes to. `comments.threads` is step 2's commit and
 * counters as later steps use them: `commit_comment` (the comment and its counters in one Lua
 * script), the readers `thread_count` / `reply_counts` / `hot_threads`, and `recount_thread`. The
 * five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'comments/__init__.py': '',
  'comments/store.py': `"""
The comment store (provided). Redis stands in for the comments database:
  comment:{tenant}:{id}              the comment, one JSON document
  thread:{tenant}:{thread}:comments  the thread's index: comment ids scored by seq
  idem:{tenant}:{key}                the comment id an Idempotency-Key created
  comment:seq                        the store-wide sequence (ids are c-1, c-2, …: newest = highest)
  review:queue                       "{tenant}:{id}" of comments waiting for a human moderator
  notify:retry                       JSON {"tenant", "comment_id", "request_id"} of notifications to retry
A comment is a dict: id, seq, thread_id, parent_id ("" for a top-level comment), author_id, text (as
the author wrote it), html (rendered), created_at (ms), revision, deleted, status.
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def row_key(tenant: str, comment_id: str) -> str:
    return f"comment:{tenant}:{comment_id}"


def index_key(tenant: str, thread_id: str) -> str:
    return f"thread:{tenant}:{thread_id}:comments"


def new_comment(thread_id: str, parent_id: str, author_id: str, text: str, html: str) -> dict:
    """A comment not stored yet: the next id and seq, created_at now, revision 1, status "new"."""
    seq = r.incr("comment:seq")
    return {
        "id": f"c-{seq}",
        "seq": seq,
        "thread_id": thread_id,
        "parent_id": parent_id or "",
        "author_id": author_id,
        "text": text,
        "html": html,
        "created_at": int(time.time() * 1000),
        "revision": 1,
        "deleted": False,
        "status": "new",
    }


def insert(tenant: str, comment: dict) -> dict:
    """Store the comment and index it under its thread, in one MULTI/EXEC; returns the comment."""
    tx = r.pipeline()
    tx.set(row_key(tenant, comment["id"]), json.dumps(comment))
    tx.zadd(index_key(tenant, comment["thread_id"]), {comment["id"]: comment["seq"]})
    tx.execute()
    return comment


def get(tenant: str, comment_id: str) -> dict | None:
    """The tenant's comment, or None."""
    raw = r.get(row_key(tenant, comment_id))
    return json.loads(raw) if raw else None


def get_many(tenant: str, ids: list[str]) -> list[dict | None]:
    """The tenant's comments in the order of ids (None where one is missing), in one MGET."""
    if not ids:
        return []
    return [json.loads(raw) if raw else None for raw in r.mget([row_key(tenant, i) for i in ids])]


def _save(tenant: str, comment: dict) -> dict:
    r.set(row_key(tenant, comment["id"]), json.dumps(comment))
    return comment


def soft_delete(tenant: str, comment_id: str) -> dict | None:
    """Mark the comment deleted and bump its revision; the row (text included) stays for audit. Returns the new row."""
    comment = get(tenant, comment_id)
    if comment is None:
        return None
    return _save(tenant, {**comment, "deleted": True, "revision": comment["revision"] + 1})


def set_status(tenant: str, comment_id: str, status: str) -> dict | None:
    """Record the moderation outcome (allowed, blocked, pending_review) on the comment."""
    comment = get(tenant, comment_id)
    if comment is None:
        return None
    return _save(tenant, {**comment, "status": status})


def by_key(tenant: str, key: str) -> dict | None:
    """The comment the tenant's Idempotency-Key created, or None."""
    comment_id = r.get(f"idem:{tenant}:{key}")
    return get(tenant, comment_id) if comment_id else None


def remember_key(tenant: str, key: str, comment_id: str) -> None:
    """Record that the tenant's Idempotency-Key created comment_id."""
    r.set(f"idem:{tenant}:{key}", comment_id)


def indexed_count(tenant: str, thread_id: str) -> int:
    """How many comments the thread's index holds (ZCARD)."""
    return r.zcard(index_key(tenant, thread_id))


def enqueue_review(tenant: str, comment_id: str) -> None:
    """Queue the comment for a human moderator."""
    r.rpush("review:queue", f"{tenant}:{comment_id}")


def enqueue_notify_retry(tenant: str, comment_id: str, request_id: str) -> None:
    """Queue a notification to retry later, with the request_id its retry must carry."""
    r.rpush("notify:retry", json.dumps({"tenant": tenant, "comment_id": comment_id, "request_id": request_id}))
`,
  'comments/threads.py': `"""
The thread counters (provided; step 2 builds the same functions):
  thread:{tenant}:{thread}:count    how many comments the thread has
  thread:{tenant}:{thread}:replies  a hash: parent comment id -> how many replies it has
  hot:{tenant}                      the tenant's hot threads: thread id -> comments, expiring HOT_TTL_S after the last
commit_comment writes the comment, its index entry and every counter in one Lua script, so no reader
sees one without the other. recount_thread resets the counter from the index in one script.
"""
import json

import redis

from comments import store

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOT_TTL_S = 3600
HOT_PAGE_SIZE = 10

COMMIT_LUA = """
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
local count = redis.call('INCR', KEYS[3])
if ARGV[4] ~= '' then
  redis.call('HINCRBY', KEYS[4], ARGV[4], 1)
end
redis.call('ZINCRBY', KEYS[5], 1, ARGV[5])
redis.call('EXPIRE', KEYS[5], ARGV[6])
return count
"""

RECOUNT_LUA = """
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
"""


def count_key(tenant: str, thread_id: str) -> str:
    return f"thread:{tenant}:{thread_id}:count"


def replies_key(tenant: str, thread_id: str) -> str:
    return f"thread:{tenant}:{thread_id}:replies"


def hot_key(tenant: str) -> str:
    return f"hot:{tenant}"


def commit_comment(tenant: str, comment: dict) -> int:
    """Store the comment and count it, atomically; returns the thread's new comment count."""
    thread_id = comment["thread_id"]
    keys = [
        store.row_key(tenant, comment["id"]),
        store.index_key(tenant, thread_id),
        count_key(tenant, thread_id),
        replies_key(tenant, thread_id),
        hot_key(tenant),
    ]
    args = [json.dumps(comment), comment["seq"], comment["id"], comment["parent_id"], thread_id, HOT_TTL_S]
    return int(r.eval(COMMIT_LUA, len(keys), *keys, *args))


def recount_thread(tenant: str, thread_id: str) -> int:
    """Reset the thread's counter from its index, in one script; returns the count."""
    return int(r.eval(RECOUNT_LUA, 2, store.index_key(tenant, thread_id), count_key(tenant, thread_id)))


def thread_count(tenant: str, thread_id: str) -> int:
    return int(r.get(count_key(tenant, thread_id)) or 0)


def reply_counts(tenant: str, thread_id: str, ids: list[str]) -> dict[str, int]:
    """Each id's reply count (0 when it has none), in one HMGET."""
    if not ids:
        return {}
    return {i: int(n or 0) for i, n in zip(ids, r.hmget(replies_key(tenant, thread_id), ids))}


def hot_threads(tenant: str) -> list[str]:
    """The tenant's first page of hot threads, most comments first."""
    return r.zrevrange(hot_key(tenant), 0, HOT_PAGE_SIZE - 1)
`,
};

export const supportModulesTs: Record<string, string> = {
  'comments/store.ts': `/**
 * The comment store (provided). Redis stands in for the comments database:
 *   comment:{tenant}:{id}              the comment, one JSON document
 *   thread:{tenant}:{thread}:comments  the thread's index: comment ids scored by seq
 *   idem:{tenant}:{key}                the comment id an Idempotency-Key created
 *   comment:seq                        the store-wide sequence (ids are c-1, c-2, …: newest = highest)
 *   review:queue                       "{tenant}:{id}" of comments waiting for a human moderator
 *   notify:retry                       JSON {"tenant", "comment_id", "request_id"} of notifications to retry
 * parent_id is "" for a top-level comment; text is what the author wrote, html its rendering.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Comment {
  id: string;
  seq: number;
  thread_id: string;
  parent_id: string;
  author_id: string;
  text: string;
  html: string;
  created_at: number;
  revision: number;
  deleted: boolean;
  status: string;
}

export const rowKey = (tenant: string, commentId: string): string => \`comment:\${tenant}:\${commentId}\`;
export const indexKey = (tenant: string, threadId: string): string => \`thread:\${tenant}:\${threadId}:comments\`;

/** A comment not stored yet: the next id and seq, created_at now, revision 1, status "new". */
export async function newComment(threadId: string, parentId: string, authorId: string, text: string, html: string): Promise<Comment> {
  const seq = await redis.incr('comment:seq');
  return {
    id: \`c-\${seq}\`,
    seq,
    thread_id: threadId,
    parent_id: parentId ?? '',
    author_id: authorId,
    text,
    html,
    created_at: Date.now(),
    revision: 1,
    deleted: false,
    status: 'new',
  };
}

/** Store the comment and index it under its thread, in one MULTI/EXEC; returns the comment. */
export async function insert(tenant: string, comment: Comment): Promise<Comment> {
  await redis
    .multi()
    .set(rowKey(tenant, comment.id), JSON.stringify(comment))
    .zadd(indexKey(tenant, comment.thread_id), comment.seq, comment.id)
    .exec();
  return comment;
}

/** The tenant's comment, or null. */
export async function get(tenant: string, commentId: string): Promise<Comment | null> {
  const raw = await redis.get(rowKey(tenant, commentId));
  return raw === null ? null : (JSON.parse(raw) as Comment);
}

/** The tenant's comments in the order of ids (null where one is missing), in one MGET. */
export async function getMany(tenant: string, ids: string[]): Promise<(Comment | null)[]> {
  if (ids.length === 0) return [];
  const raws = await redis.mget(ids.map(id => rowKey(tenant, id)));
  return raws.map(raw => (raw === null ? null : (JSON.parse(raw) as Comment)));
}

async function save(tenant: string, comment: Comment): Promise<Comment> {
  await redis.set(rowKey(tenant, comment.id), JSON.stringify(comment));
  return comment;
}

/** Mark the comment deleted and bump its revision; the row (text included) stays for audit. Returns the new row. */
export async function softDelete(tenant: string, commentId: string): Promise<Comment | null> {
  const comment = await get(tenant, commentId);
  return comment === null ? null : save(tenant, {...comment, deleted: true, revision: comment.revision + 1});
}

/** Record the moderation outcome (allowed, blocked, pending_review) on the comment. */
export async function setStatus(tenant: string, commentId: string, status: string): Promise<Comment | null> {
  const comment = await get(tenant, commentId);
  return comment === null ? null : save(tenant, {...comment, status});
}

/** The comment the tenant's Idempotency-Key created, or null. */
export async function byKey(tenant: string, key: string): Promise<Comment | null> {
  const commentId = await redis.get(\`idem:\${tenant}:\${key}\`);
  return commentId === null ? null : get(tenant, commentId);
}

/** Record that the tenant's Idempotency-Key created commentId. */
export async function rememberKey(tenant: string, key: string, commentId: string): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, commentId);
}

/** How many comments the thread's index holds (ZCARD). */
export async function indexedCount(tenant: string, threadId: string): Promise<number> {
  return redis.zcard(indexKey(tenant, threadId));
}

/** Queue the comment for a human moderator. */
export async function enqueueReview(tenant: string, commentId: string): Promise<void> {
  await redis.rpush('review:queue', \`\${tenant}:\${commentId}\`);
}

/** Queue a notification to retry later, with the request_id its retry must carry. */
export async function enqueueNotifyRetry(tenant: string, commentId: string, requestId: string): Promise<void> {
  await redis.rpush('notify:retry', JSON.stringify({tenant, comment_id: commentId, request_id: requestId}));
}
`,
  'comments/threads.ts': `/**
 * The thread counters (provided; step 2 builds the same functions):
 *   thread:{tenant}:{thread}:count    how many comments the thread has
 *   thread:{tenant}:{thread}:replies  a hash: parent comment id -> how many replies it has
 *   hot:{tenant}                      the tenant's hot threads: thread id -> comments, expiring HOT_TTL_S after the last
 * commitComment writes the comment, its index entry and every counter in one Lua script, so no reader
 * sees one without the other. recountThread resets the counter from the index in one script.
 */
import Redis from 'ioredis';

import {type Comment, indexKey, rowKey} from 'comments/store';

export const HOT_TTL_S = 3600;
export const HOT_PAGE_SIZE = 10;

export const COMMIT_LUA = \`
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
local count = redis.call('INCR', KEYS[3])
if ARGV[4] ~= '' then
  redis.call('HINCRBY', KEYS[4], ARGV[4], 1)
end
redis.call('ZINCRBY', KEYS[5], 1, ARGV[5])
redis.call('EXPIRE', KEYS[5], ARGV[6])
return count
\`;

export const RECOUNT_LUA = \`
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
\`;

const redis = new Redis({host: 'redis', port: 6379});

export const countKey = (tenant: string, threadId: string): string => \`thread:\${tenant}:\${threadId}:count\`;
export const repliesKey = (tenant: string, threadId: string): string => \`thread:\${tenant}:\${threadId}:replies\`;
export const hotKey = (tenant: string): string => \`hot:\${tenant}\`;

/** Store the comment and count it, atomically; resolves the thread's new comment count. */
export async function commitComment(tenant: string, comment: Comment): Promise<number> {
  const threadId = comment.thread_id;
  const keys = [rowKey(tenant, comment.id), indexKey(tenant, threadId), countKey(tenant, threadId), repliesKey(tenant, threadId), hotKey(tenant)];
  const args = [JSON.stringify(comment), comment.seq, comment.id, comment.parent_id, threadId, HOT_TTL_S];
  return Number(await redis.eval(COMMIT_LUA, keys.length, ...keys, ...args));
}

/** Reset the thread's counter from its index, in one script; resolves the count. */
export async function recountThread(tenant: string, threadId: string): Promise<number> {
  return Number(await redis.eval(RECOUNT_LUA, 2, indexKey(tenant, threadId), countKey(tenant, threadId)));
}

export async function threadCount(tenant: string, threadId: string): Promise<number> {
  return Number((await redis.get(countKey(tenant, threadId))) ?? 0);
}

/** Each id's reply count (0 when it has none), in one HMGET. */
export async function replyCounts(tenant: string, threadId: string, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const counts = await redis.hmget(repliesKey(tenant, threadId), ...ids);
  return Object.fromEntries(ids.map((id, i) => [id, Number(counts[i] ?? 0)]));
}

/** The tenant's first page of hot threads, most comments first. */
export async function hotThreads(tenant: string): Promise<string[]> {
  return redis.zrevrange(hotKey(tenant), 0, HOT_PAGE_SIZE - 1);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'comments/store/store.go': `// Package store is the comment store (provided). Redis stands in for the comments database:
//
//	comment:{tenant}:{id}              the comment, one JSON document
//	thread:{tenant}:{thread}:comments  the thread's index: comment ids scored by seq
//	idem:{tenant}:{key}                the comment id an Idempotency-Key created
//	comment:seq                        the store-wide sequence (ids are c-1, c-2, …: newest = highest)
//	review:queue                       "{tenant}:{id}" of comments waiting for a human moderator
//	notify:retry                       JSON {"tenant", "comment_id", "request_id"} of notifications to retry
//
// ParentID is "" for a top-level comment; Text is what the author wrote, HTML its rendering.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Comment is one comment as the store keeps it.
type Comment struct {
	ID        string \`json:"id"\`
	Seq       int64  \`json:"seq"\`
	ThreadID  string \`json:"thread_id"\`
	ParentID  string \`json:"parent_id"\`
	AuthorID  string \`json:"author_id"\`
	Text      string \`json:"text"\`
	HTML      string \`json:"html"\`
	CreatedAt int64  \`json:"created_at"\`
	Revision  int    \`json:"revision"\`
	Deleted   bool   \`json:"deleted"\`
	Status    string \`json:"status"\`
}

// RowKey holds the comment's JSON document.
func RowKey(tenant, commentID string) string { return "comment:" + tenant + ":" + commentID }

// IndexKey is the thread's index: comment ids scored by seq.
func IndexKey(tenant, threadID string) string { return "thread:" + tenant + ":" + threadID + ":comments" }

// NewComment is a comment not stored yet: the next id and seq, CreatedAt now, revision 1, status "new".
func NewComment(ctx context.Context, threadID, parentID, authorID, text, html string) (Comment, error) {
	seq, err := rdb.Incr(ctx, "comment:seq").Result()
	if err != nil {
		return Comment{}, err
	}
	return Comment{
		ID: fmt.Sprintf("c-%d", seq), Seq: seq, ThreadID: threadID, ParentID: parentID, AuthorID: authorID,
		Text: text, HTML: html, CreatedAt: time.Now().UnixMilli(), Revision: 1, Status: "new",
	}, nil
}

// Insert stores the comment and indexes it under its thread, in one MULTI/EXEC.
func Insert(ctx context.Context, tenant string, c Comment) error {
	raw, _ := json.Marshal(c)
	tx := rdb.TxPipeline()
	tx.Set(ctx, RowKey(tenant, c.ID), raw, 0)
	tx.ZAdd(ctx, IndexKey(tenant, c.ThreadID), redis.Z{Score: float64(c.Seq), Member: c.ID})
	_, err := tx.Exec(ctx)
	return err
}

func decode(raw string) *Comment {
	var c Comment
	if json.Unmarshal([]byte(raw), &c) != nil {
		return nil
	}
	return &c
}

// Get is the tenant's comment, or nil.
func Get(ctx context.Context, tenant, commentID string) *Comment {
	raw, err := rdb.Get(ctx, RowKey(tenant, commentID)).Result()
	if err != nil {
		return nil
	}
	return decode(raw)
}

// GetMany is the tenant's comments in the order of ids (nil where one is missing), in one MGET.
func GetMany(ctx context.Context, tenant string, ids []string) []*Comment {
	if len(ids) == 0 {
		return nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = RowKey(tenant, id)
	}
	values, _ := rdb.MGet(ctx, keys...).Result()
	out := make([]*Comment, len(ids))
	for i, v := range values {
		if s, ok := v.(string); ok {
			out[i] = decode(s)
		}
	}
	return out
}

func save(ctx context.Context, tenant string, c Comment) *Comment {
	raw, _ := json.Marshal(c)
	rdb.Set(ctx, RowKey(tenant, c.ID), raw, 0)
	return &c
}

// SoftDelete marks the comment deleted and bumps its revision; the row (text included) stays for
// audit. It returns the new row, or nil when there is no such comment.
func SoftDelete(ctx context.Context, tenant, commentID string) *Comment {
	c := Get(ctx, tenant, commentID)
	if c == nil {
		return nil
	}
	c.Deleted = true
	c.Revision++
	return save(ctx, tenant, *c)
}

// SetStatus records the moderation outcome (allowed, blocked, pending_review) on the comment.
func SetStatus(ctx context.Context, tenant, commentID, status string) *Comment {
	c := Get(ctx, tenant, commentID)
	if c == nil {
		return nil
	}
	c.Status = status
	return save(ctx, tenant, *c)
}

// ByKey is the comment the tenant's Idempotency-Key created, or nil.
func ByKey(ctx context.Context, tenant, key string) *Comment {
	commentID, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, tenant, commentID)
}

// RememberKey records that the tenant's Idempotency-Key created commentID.
func RememberKey(ctx context.Context, tenant, key, commentID string) {
	rdb.Set(ctx, "idem:"+tenant+":"+key, commentID, 0)
}

// IndexedCount is how many comments the thread's index holds (ZCARD).
func IndexedCount(ctx context.Context, tenant, threadID string) int64 {
	return rdb.ZCard(ctx, IndexKey(tenant, threadID)).Val()
}

// EnqueueReview queues the comment for a human moderator.
func EnqueueReview(ctx context.Context, tenant, commentID string) {
	rdb.RPush(ctx, "review:queue", tenant+":"+commentID)
}

// EnqueueNotifyRetry queues a notification to retry later, with the request_id its retry must carry.
func EnqueueNotifyRetry(ctx context.Context, tenant, commentID, requestID string) {
	raw, _ := json.Marshal(map[string]string{"tenant": tenant, "comment_id": commentID, "request_id": requestID})
	rdb.RPush(ctx, "notify:retry", raw)
}
`,
  'comments/threads/threads.go': `// Package threads is the thread counters (provided; step 2 builds the same functions):
//
//	thread:{tenant}:{thread}:count    how many comments the thread has
//	thread:{tenant}:{thread}:replies  a hash: parent comment id -> how many replies it has
//	hot:{tenant}                      the tenant's hot threads: thread id -> comments, expiring HotTTL after the last
//
// CommitComment writes the comment, its index entry and every counter in one Lua script, so no
// reader sees one without the other. RecountThread resets the counter from the index in one script.
package threads

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"

	"comments/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	// HotTTLSeconds is how long a tenant's hot list lives after its last comment.
	HotTTLSeconds = 3600
	// HotPageSize is how many hot threads a read returns.
	HotPageSize = 10
)

// Commit writes the comment, its index entry and its counters.
var Commit = redis.NewScript(\`
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
local count = redis.call('INCR', KEYS[3])
if ARGV[4] ~= '' then
  redis.call('HINCRBY', KEYS[4], ARGV[4], 1)
end
redis.call('ZINCRBY', KEYS[5], 1, ARGV[5])
redis.call('EXPIRE', KEYS[5], ARGV[6])
return count
\`)

// Recount resets the counter from the index.
var Recount = redis.NewScript(\`
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
\`)

func CountKey(tenant, threadID string) string   { return "thread:" + tenant + ":" + threadID + ":count" }
func RepliesKey(tenant, threadID string) string { return "thread:" + tenant + ":" + threadID + ":replies" }
func HotKey(tenant string) string               { return "hot:" + tenant }

// CommitComment stores the comment and counts it, atomically; it returns the thread's new comment count.
func CommitComment(ctx context.Context, tenant string, c store.Comment) (int64, error) {
	raw, _ := json.Marshal(c)
	keys := []string{store.RowKey(tenant, c.ID), store.IndexKey(tenant, c.ThreadID), CountKey(tenant, c.ThreadID), RepliesKey(tenant, c.ThreadID), HotKey(tenant)}
	return Commit.Run(ctx, rdb, keys, string(raw), c.Seq, c.ID, c.ParentID, c.ThreadID, HotTTLSeconds).Int64()
}

// RecountThread resets the thread's counter from its index, in one script; it returns the count.
func RecountThread(ctx context.Context, tenant, threadID string) (int64, error) {
	return Recount.Run(ctx, rdb, []string{store.IndexKey(tenant, threadID), CountKey(tenant, threadID)}).Int64()
}

// ThreadCount is how many comments the thread has.
func ThreadCount(ctx context.Context, tenant, threadID string) int64 {
	n, _ := rdb.Get(ctx, CountKey(tenant, threadID)).Int64()
	return n
}

// ReplyCounts is each id's reply count (0 when it has none), in one HMGET.
func ReplyCounts(ctx context.Context, tenant, threadID string, ids []string) map[string]int64 {
	out := map[string]int64{}
	if len(ids) == 0 {
		return out
	}
	values, _ := rdb.HMGet(ctx, RepliesKey(tenant, threadID), ids...).Result()
	for i, id := range ids {
		s, _ := values[i].(string)
		n, _ := strconv.ParseInt(s, 10, 64)
		out[id] = n
	}
	return out
}

// HotThreads is the tenant's first page of hot threads, most comments first.
func HotThreads(ctx context.Context, tenant string) ([]string, error) {
	return rdb.ZRevRange(ctx, HotKey(tenant), 0, HotPageSize-1).Result()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'comments/store.h': `// The comment store (provided). Redis stands in for the comments database:
//   comment:{tenant}:{id}              the comment, one JSON document
//   thread:{tenant}:{thread}:comments  the thread's index: comment ids scored by seq
//   idem:{tenant}:{key}                the comment id an Idempotency-Key created
//   comment:seq                        the store-wide sequence (ids are c-1, c-2, …: newest = highest)
//   review:queue                       "{tenant}:{id}" of comments waiting for a human moderator
//   notify:retry                       JSON {"tenant", "comment_id", "request_id"} of notifications to retry
// parent_id is "" for a top-level comment; text is what the author wrote, html its rendering.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace store {

struct Comment {
  std::string id;
  long long seq = 0;
  std::string thread_id;
  std::string parent_id;
  std::string author_id;
  std::string text;
  std::string html;
  long long created_at = 0;
  int revision = 1;
  bool deleted = false;
  std::string status = "new";
};

inline nlohmann::json toJson(const Comment& c) {
  return nlohmann::json{{"id", c.id},       {"seq", c.seq},           {"thread_id", c.thread_id}, {"parent_id", c.parent_id},
                        {"author_id", c.author_id}, {"text", c.text}, {"html", c.html},           {"created_at", c.created_at},
                        {"revision", c.revision},   {"deleted", c.deleted}, {"status", c.status}};
}

inline Comment fromJson(const nlohmann::json& j) {
  Comment c;
  c.id = j.value("id", "");
  c.seq = j.value("seq", 0LL);
  c.thread_id = j.value("thread_id", "");
  c.parent_id = j.value("parent_id", "");
  c.author_id = j.value("author_id", "");
  c.text = j.value("text", "");
  c.html = j.value("html", "");
  c.created_at = j.value("created_at", 0LL);
  c.revision = j.value("revision", 1);
  c.deleted = j.value("deleted", false);
  c.status = j.value("status", "new");
  return c;
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string rowKey(const std::string& tenant, const std::string& comment_id) { return "comment:" + tenant + ":" + comment_id; }
inline std::string indexKey(const std::string& tenant, const std::string& thread_id) { return "thread:" + tenant + ":" + thread_id + ":comments"; }

// A comment not stored yet: the next id and seq, created_at now, revision 1, status "new".
inline Comment newComment(const std::string& thread_id, const std::string& parent_id, const std::string& author_id,
                          const std::string& text, const std::string& html) {
  Comment c;
  c.seq = redis().incr("comment:seq");
  c.id = "c-" + std::to_string(c.seq);
  c.thread_id = thread_id;
  c.parent_id = parent_id;
  c.author_id = author_id;
  c.text = text;
  c.html = html;
  c.created_at = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return c;
}

// Store the comment and index it under its thread, in one MULTI/EXEC; returns the comment.
inline Comment insert(const std::string& tenant, const Comment& c) {
  auto tx = redis().transaction();
  tx.set(rowKey(tenant, c.id), toJson(c).dump()).zadd(indexKey(tenant, c.thread_id), c.id, static_cast<double>(c.seq)).exec();
  return c;
}

// The tenant's comment, or none.
inline std::optional<Comment> get(const std::string& tenant, const std::string& comment_id) {
  const auto raw = redis().get(rowKey(tenant, comment_id));
  if (!raw) return std::nullopt;
  return fromJson(nlohmann::json::parse(*raw));
}

// The tenant's comments in the order of ids (none where one is missing), in one MGET.
inline std::vector<std::optional<Comment>> getMany(const std::string& tenant, const std::vector<std::string>& ids) {
  std::vector<std::optional<Comment>> out;
  if (ids.empty()) return out;
  std::vector<std::string> keys;
  for (const auto& id : ids) keys.push_back(rowKey(tenant, id));
  std::vector<std::optional<std::string>> raws;
  redis().mget(keys.begin(), keys.end(), std::back_inserter(raws));
  for (const auto& raw : raws) out.push_back(raw ? std::optional<Comment>(fromJson(nlohmann::json::parse(*raw))) : std::nullopt);
  return out;
}

inline Comment save(const std::string& tenant, const Comment& c) {
  redis().set(rowKey(tenant, c.id), toJson(c).dump());
  return c;
}

// Mark the comment deleted and bump its revision; the row (text included) stays for audit. Returns the new row.
inline std::optional<Comment> softDelete(const std::string& tenant, const std::string& comment_id) {
  auto c = store::get(tenant, comment_id);
  if (!c) return std::nullopt;
  c->deleted = true;
  c->revision += 1;
  return save(tenant, *c);
}

// Record the moderation outcome (allowed, blocked, pending_review) on the comment.
inline std::optional<Comment> setStatus(const std::string& tenant, const std::string& comment_id, const std::string& status) {
  auto c = store::get(tenant, comment_id);
  if (!c) return std::nullopt;
  c->status = status;
  return save(tenant, *c);
}

// The comment the tenant's Idempotency-Key created, or none.
inline std::optional<Comment> byKey(const std::string& tenant, const std::string& key) {
  const auto comment_id = redis().get("idem:" + tenant + ":" + key);
  if (!comment_id) return std::nullopt;
  return store::get(tenant, *comment_id);
}

// Record that the tenant's Idempotency-Key created comment_id.
inline void rememberKey(const std::string& tenant, const std::string& key, const std::string& comment_id) {
  redis().set("idem:" + tenant + ":" + key, comment_id);
}

// How many comments the thread's index holds (ZCARD).
inline long long indexedCount(const std::string& tenant, const std::string& thread_id) { return redis().zcard(indexKey(tenant, thread_id)); }

// Queue the comment for a human moderator.
inline void enqueueReview(const std::string& tenant, const std::string& comment_id) {
  redis().rpush("review:queue", tenant + ":" + comment_id);
}

// Queue a notification to retry later, with the request_id its retry must carry.
inline void enqueueNotifyRetry(const std::string& tenant, const std::string& comment_id, const std::string& request_id) {
  redis().rpush("notify:retry", nlohmann::json{{"tenant", tenant}, {"comment_id", comment_id}, {"request_id", request_id}}.dump());
}

}  // namespace store
`,
  'comments/threads.h': `// The thread counters (provided; step 2 builds the same functions):
//   thread:{tenant}:{thread}:count    how many comments the thread has
//   thread:{tenant}:{thread}:replies  a hash: parent comment id -> how many replies it has
//   hot:{tenant}                      the tenant's hot threads: thread id -> comments, expiring kHotTtlSeconds after the last
// commitComment writes the comment, its index entry and every counter in one Lua script, so no
// reader sees one without the other. recountThread resets the counter from the index in one script.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "comments/store.h"

namespace threads {

constexpr long long kHotTtlSeconds = 3600;
constexpr long long kHotPageSize = 10;

inline const std::string kCommitLua = R"lua(
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
local count = redis.call('INCR', KEYS[3])
if ARGV[4] ~= '' then
  redis.call('HINCRBY', KEYS[4], ARGV[4], 1)
end
redis.call('ZINCRBY', KEYS[5], 1, ARGV[5])
redis.call('EXPIRE', KEYS[5], ARGV[6])
return count
)lua";

inline const std::string kRecountLua = R"lua(
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
)lua";

inline std::string countKey(const std::string& tenant, const std::string& thread_id) { return "thread:" + tenant + ":" + thread_id + ":count"; }
inline std::string repliesKey(const std::string& tenant, const std::string& thread_id) { return "thread:" + tenant + ":" + thread_id + ":replies"; }
inline std::string hotKey(const std::string& tenant) { return "hot:" + tenant; }

// Store the comment and count it, atomically; returns the thread's new comment count.
inline long long commitComment(const std::string& tenant, const store::Comment& c) {
  return store::redis().eval<long long>(
      kCommitLua,
      {store::rowKey(tenant, c.id), store::indexKey(tenant, c.thread_id), countKey(tenant, c.thread_id), repliesKey(tenant, c.thread_id), hotKey(tenant)},
      {store::toJson(c).dump(), std::to_string(c.seq), c.id, c.parent_id, c.thread_id, std::to_string(kHotTtlSeconds)});
}

// Reset the thread's counter from its index, in one script; returns the count.
inline long long recountThread(const std::string& tenant, const std::string& thread_id) {
  return store::redis().eval<long long>(kRecountLua, {store::indexKey(tenant, thread_id), countKey(tenant, thread_id)}, {});
}

inline long long threadCount(const std::string& tenant, const std::string& thread_id) {
  const auto n = store::redis().get(countKey(tenant, thread_id));
  return n ? std::stoll(*n) : 0;
}

// Each id's reply count (0 when it has none), in one HMGET.
inline std::map<std::string, long long> replyCounts(const std::string& tenant, const std::string& thread_id, const std::vector<std::string>& ids) {
  std::map<std::string, long long> out;
  if (ids.empty()) return out;
  std::vector<std::optional<std::string>> values;
  store::redis().hmget(repliesKey(tenant, thread_id), ids.begin(), ids.end(), std::back_inserter(values));
  for (size_t i = 0; i < ids.size(); i++) out[ids[i]] = i < values.size() && values[i] ? std::stoll(*values[i]) : 0;
  return out;
}

// The tenant's first page of hot threads, most comments first.
inline std::vector<std::string> hotThreads(const std::string& tenant) {
  return store::redis().zrevrange(hotKey(tenant), 0, kHotPageSize - 1);
}

}  // namespace threads
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('comments', 'Store')]: `package comments

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The comment store (provided). Redis stands in for the comments database:
 *   comment:{tenant}:{id}              the comment, one JSON document
 *   thread:{tenant}:{thread}:comments  the thread's index: comment ids scored by seq
 *   idem:{tenant}:{key}                the comment id an Idempotency-Key created
 *   comment:seq                        the store-wide sequence (ids are c-1, c-2, …: newest = highest)
 *   review:queue                       "{tenant}:{id}" of comments waiting for a human moderator
 *   notify:retry                       JSON {"tenant", "comment_id", "request_id"} of notifications to retry
 * parentId is "" for a top-level comment; text is what the author wrote, html its rendering.
 */
object Store {
  final case class Comment(
      id: String,
      seq: Long,
      threadId: String,
      parentId: String,
      authorId: String,
      text: String,
      html: String,
      createdAt: Long,
      revision: Int,
      deleted: Boolean,
      status: String
  )

  def toJson(c: Comment): JsObject = JsObject(
    "id" -> JsString(c.id), "seq" -> JsNumber(c.seq), "thread_id" -> JsString(c.threadId), "parent_id" -> JsString(c.parentId),
    "author_id" -> JsString(c.authorId), "text" -> JsString(c.text), "html" -> JsString(c.html), "created_at" -> JsNumber(c.createdAt),
    "revision" -> JsNumber(c.revision), "deleted" -> JsBoolean(c.deleted), "status" -> JsString(c.status))

  def fromJson(raw: String): Comment = {
    val f = raw.parseJson.asJsObject.fields
    Comment(f("id").convertTo[String], f("seq").convertTo[Long], f("thread_id").convertTo[String], f("parent_id").convertTo[String],
      f("author_id").convertTo[String], f("text").convertTo[String], f("html").convertTo[String], f("created_at").convertTo[Long],
      f("revision").convertTo[Int], f("deleted").convertTo[Boolean], f("status").convertTo[String])
  }

  val jedis = new JedisPooled("redis", 6379)

  def rowKey(tenant: String, commentId: String): String = s"comment:$tenant:$commentId"
  def indexKey(tenant: String, threadId: String): String = s"thread:$tenant:$threadId:comments"

  /** A comment not stored yet: the next id and seq, createdAt now, revision 1, status "new". */
  def newComment(threadId: String, parentId: String, authorId: String, text: String, html: String): Comment = {
    val seq = jedis.incr("comment:seq")
    Comment(s"c-$seq", seq, threadId, parentId, authorId, text, html, System.currentTimeMillis(), 1, deleted = false, "new")
  }

  /** Store the comment and index it under its thread, in one MULTI/EXEC; returns the comment. */
  def insert(tenant: String, c: Comment): Comment = {
    val tx = jedis.multi()
    tx.set(rowKey(tenant, c.id), toJson(c).compactPrint)
    tx.zadd(indexKey(tenant, c.threadId), c.seq.toDouble, c.id)
    tx.exec()
    c
  }

  /** The tenant's comment, if any. */
  def get(tenant: String, commentId: String): Option[Comment] = Option(jedis.get(rowKey(tenant, commentId))).map(fromJson)

  /** The tenant's comments in the order of ids (None where one is missing), in one MGET. */
  def getMany(tenant: String, ids: Seq[String]): Seq[Option[Comment]] =
    if (ids.isEmpty) Seq.empty else jedis.mget(ids.map(rowKey(tenant, _)): _*).asScala.toSeq.map(raw => Option(raw).map(fromJson))

  private def save(tenant: String, c: Comment): Comment = {
    jedis.set(rowKey(tenant, c.id), toJson(c).compactPrint)
    c
  }

  /** Mark the comment deleted and bump its revision; the row (text included) stays for audit. Returns the new row. */
  def softDelete(tenant: String, commentId: String): Option[Comment] =
    get(tenant, commentId).map(c => save(tenant, c.copy(deleted = true, revision = c.revision + 1)))

  /** Record the moderation outcome (allowed, blocked, pending_review) on the comment. */
  def setStatus(tenant: String, commentId: String, status: String): Option[Comment] =
    get(tenant, commentId).map(c => save(tenant, c.copy(status = status)))

  /** The comment the tenant's Idempotency-Key created, if any. */
  def byKey(tenant: String, key: String): Option[Comment] = Option(jedis.get(s"idem:$tenant:$key")).flatMap(get(tenant, _))

  /** Record that the tenant's Idempotency-Key created commentId. */
  def rememberKey(tenant: String, key: String, commentId: String): Unit = jedis.set(s"idem:$tenant:$key", commentId)

  /** How many comments the thread's index holds (ZCARD). */
  def indexedCount(tenant: String, threadId: String): Long = jedis.zcard(indexKey(tenant, threadId))

  /** Queue the comment for a human moderator. */
  def enqueueReview(tenant: String, commentId: String): Unit = jedis.rpush("review:queue", s"$tenant:$commentId")

  /** Queue a notification to retry later, with the request_id its retry must carry. */
  def enqueueNotifyRetry(tenant: String, commentId: String, requestId: String): Unit =
    jedis.rpush("notify:retry", JsObject("tenant" -> JsString(tenant), "comment_id" -> JsString(commentId), "request_id" -> JsString(requestId)).compactPrint)
}
`,
  [scalaPath('comments', 'Threads')]: `package comments

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The thread counters (provided; step 2 builds the same functions):
 *   thread:{tenant}:{thread}:count    how many comments the thread has
 *   thread:{tenant}:{thread}:replies  a hash: parent comment id -> how many replies it has
 *   hot:{tenant}                      the tenant's hot threads: thread id -> comments, expiring HotTtlSeconds after the last
 * commitComment writes the comment, its index entry and every counter in one Lua script, so no
 * reader sees one without the other. recountThread resets the counter from the index in one script.
 */
object Threads {
  val HotTtlSeconds = 3600L
  val HotPageSize = 10

  val CommitLua: String =
    """redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
      |local count = redis.call('INCR', KEYS[3])
      |if ARGV[4] ~= '' then
      |  redis.call('HINCRBY', KEYS[4], ARGV[4], 1)
      |end
      |redis.call('ZINCRBY', KEYS[5], 1, ARGV[5])
      |redis.call('EXPIRE', KEYS[5], ARGV[6])
      |return count
      |""".stripMargin

  val RecountLua: String =
    """local n = redis.call('ZCARD', KEYS[1])
      |redis.call('SET', KEYS[2], n)
      |return n
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def countKey(tenant: String, threadId: String): String = s"thread:$tenant:$threadId:count"
  def repliesKey(tenant: String, threadId: String): String = s"thread:$tenant:$threadId:replies"
  def hotKey(tenant: String): String = s"hot:$tenant"

  /** Store the comment and count it, atomically; returns the thread's new comment count. */
  def commitComment(tenant: String, c: Store.Comment): Long = {
    val keys = List(Store.rowKey(tenant, c.id), Store.indexKey(tenant, c.threadId), countKey(tenant, c.threadId), repliesKey(tenant, c.threadId), hotKey(tenant))
    val args = List(Store.toJson(c).compactPrint, c.seq.toString, c.id, c.parentId, c.threadId, HotTtlSeconds.toString)
    jedis.eval(CommitLua, keys.asJava, args.asJava).asInstanceOf[java.lang.Long]
  }

  /** Reset the thread's counter from its index, in one script; returns the count. */
  def recountThread(tenant: String, threadId: String): Long =
    jedis.eval(RecountLua, List(Store.indexKey(tenant, threadId), countKey(tenant, threadId)).asJava, List.empty[String].asJava).asInstanceOf[java.lang.Long]

  def threadCount(tenant: String, threadId: String): Long = Option(jedis.get(countKey(tenant, threadId))).map(_.toLong).getOrElse(0L)

  /** Each id's reply count (0 when it has none), in one HMGET. */
  def replyCounts(tenant: String, threadId: String, ids: Seq[String]): Map[String, Long] =
    if (ids.isEmpty) Map.empty
    else ids.zip(jedis.hmget(repliesKey(tenant, threadId), ids: _*).asScala).map { case (id, n) => id -> Option(n).map(_.toLong).getOrElse(0L) }.toMap

  /** The tenant's first page of hot threads, most comments first. */
  def hotThreads(tenant: String): Seq[String] = jedis.zrevrange(hotKey(tenant), 0, HotPageSize - 1).asScala.toSeq
}
`,
};
