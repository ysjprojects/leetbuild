import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Counters committed with the comment in one Lua script',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the counting half of the write path:
\`commit_comment(tenant, comment)\` writes the comment with \`store.insert\`, then \`INCR\`s
\`thread:{thread}:count\`, adds a reply to the \`thread:{thread}:replies\` hash and bumps
\`hot:threads\`; \`recount_thread\` reads \`store.indexed_count\` and \`SET\`s the counter;
\`thread_count\`, \`reply_counts\` and \`hot_threads\` read them back. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A reader (or a crash) between the insert and the \`INCR\` finds
a comment the counter does not count; two tenants with a thread \`t-1\` share one counter and one hot
list; the hot list never expires and is read whole; a comment committed while \`recount_thread\`
runs is counted out again.

- One Lua script writes the comment (\`SET\` its \`store.row_key\`, \`ZADD\` its \`store.index_key\`
  by \`seq\`) and its counters: \`INCR thread:{tenant}:{thread}:count\`, \`HINCRBY\`
  \`thread:{tenant}:{thread}:replies\` for a reply, \`ZINCRBY hot:{tenant}\` with
  \`EXPIRE HOT_TTL_S\` (3600). It returns the thread's count.
- \`hot_threads\` returns the first \`HOT_PAGE_SIZE\` (10), most comments first.
- \`recount_thread\` counts the index (\`ZCARD\`) and sets the counter in one script.`,
  sequence: {
    participants: ['Comments API', 'Redis', 'Reader'],
    messages: [
      {
        from: 'Comments API',
        to: 'Redis',
        label: 'EVAL COMMIT_LUA · SET comment · ZADD index · INCR count · HINCRBY replies · ZINCRBY + EXPIRE hot',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Comments API', label: 'the thread’s count', kind: 'reply'},
      {from: 'Reader', to: 'Redis', label: 'ZCARD index · GET count: always equal', kind: 'sync'},
      {from: 'Comments API', to: 'Redis', label: 'EVAL RECOUNT_LUA · ZCARD index → SET count', kind: 'sync'},
      {from: 'Reader', to: 'Redis', label: 'ZREVRANGE hot:{tenant} 0 HOT_PAGE_SIZE-1', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-commit',
      title: 'The comment and its counters land in one script',
      detail:
        'One Lua script `SET`s the comment, `ZADD`s it to the thread index and `INCR`s the counters, so the instant the comment is indexed its counter already counts it. The starter inserts first and increments afterwards, in separate commands.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
            /redis\.call\(\s*['"]INCR['"]/,
            /\.eval\(|register_script\(/,
          ],
          none: [/store\.insert\(/],
        },
        typescript: {
          all: [
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
            /redis\.call\(\s*['"]INCR['"]/,
            /\.eval\(|defineCommand\(/,
          ],
          none: [/\binsert\(/],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
            /redis\.call\(\s*['"]INCR['"]/,
            /redis\.NewScript\(|\.Eval\(/,
          ],
          none: [/store\.Insert\(/],
        },
        scala: {
          all: [
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
            /redis\.call\(\s*['"]INCR['"]/,
            /jedis\.eval(sha)?\(/,
          ],
          none: [/Store\.insert\(/],
        },
        cpp: {
          all: [
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
            /redis\.call\(\s*['"]INCR['"]/,
            /\.eval(sha)?</,
          ],
          none: [/store::insert\(/],
        },
      },
    },
    {
      id: 'tenant-keys',
      title: 'Counters and hot lists are per tenant',
      detail:
        'The counter is `thread:{tenant}:{thread}:count`, the replies hash `thread:{tenant}:{thread}:replies`, the hot list `hot:{tenant}`; the starter leaves the tenant out, so tenants with the same thread id add into one counter and read each other’s hot threads.',
      match: {
        python: {
          all: [/thread:\{tenant\}:\{\w+\}:count/, /thread:\{tenant\}:\{\w+\}:replies/, /hot:\{tenant\}/],
          none: [/hot:threads/],
        },
        typescript: {
          all: [/thread:\$\{tenant\}:\$\{\w+\}:count/, /thread:\$\{tenant\}:\$\{\w+\}:replies/, /hot:\$\{tenant\}/],
          none: [/hot:threads/],
        },
        go: {all: [/"thread:"\s*\+\s*tenant/, /":count"/, /":replies"/, /"hot:"\s*\+\s*tenant/], none: [/hot:threads/]},
        scala: {
          all: [/thread:\$tenant:\$\w+:count/, /thread:\$tenant:\$\w+:replies/, /hot:\$tenant/],
          none: [/hot:threads/],
        },
        cpp: {
          all: [/"thread:"\s*\+\s*tenant/, /":count"/, /":replies"/, /"hot:"\s*\+\s*tenant/],
          none: [/hot:threads/],
        },
      },
    },
    {
      id: 'hot-expiry',
      title: 'The hot list expires and is read one page at a time',
      detail:
        'The script refreshes `EXPIRE hot:{tenant} HOT_TTL_S` (3600) on every comment, and `hot_threads` reads `HOT_PAGE_SIZE` (10) entries, most comments first. The starter never expires the set and reads it whole.',
      match: {
        python: {all: [/HOT_TTL_S\s*=\s*3600/, /['"]EXPIRE['"]/, /HOT_PAGE_SIZE\s*-\s*1/]},
        typescript: {all: [/HOT_TTL_S\s*=\s*3600/, /['"]EXPIRE['"]/, /HOT_PAGE_SIZE\s*-\s*1/]},
        go: {all: [/hotTTLSeconds\s*=\s*3600/, /['"]EXPIRE['"]/, /hotPageSize\s*-\s*1/]},
        scala: {all: [/HotTtlSeconds\s*=\s*3600/, /['"]EXPIRE['"]/, /HotPageSize\s*-\s*1/]},
        cpp: {all: [/kHotTtlSeconds\s*=\s*3600/, /['"]EXPIRE['"]/, /kHotPageSize\s*-\s*1/]},
      },
    },
    {
      id: 'recount',
      title: 'The recount counts and sets in one script',
      detail:
        '`recount_thread` runs `ZCARD` on the index and `SET`s the counter inside one script, so a comment committed meanwhile is counted either before or after, never erased. The starter reads the count, then writes it, with a gap between.',
      match: {
        python: {all: [/redis\.call\(\s*['"]ZCARD['"]/, /def recount_thread/], none: [/store\.indexed_count\(/]},
        typescript: {all: [/redis\.call\(\s*['"]ZCARD['"]/, /function recountThread/], none: [/\bindexedCount\(/]},
        go: {all: [/redis\.call\(\s*['"]ZCARD['"]/, /func recountThread/], none: [/store\.IndexedCount\(/]},
        scala: {all: [/redis\.call\(\s*['"]ZCARD['"]/, /def recountThread/], none: [/Store\.indexedCount\(/]},
        cpp: {all: [/redis\.call\(\s*['"]ZCARD['"]/, /recountThread\(/], none: [/store::indexedCount\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from comments import store  # store.insert, indexed_count, row_key, index_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def commit_comment(tenant: str, comment: dict) -> int:
    """Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot threads. Returns the thread's count."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    store.insert(tenant, comment)
    count = r.incr(f"thread:{comment['thread_id']}:count")
    if comment["parent_id"]:
        r.hincrby(f"thread:{comment['thread_id']}:replies", comment["parent_id"], 1)
    r.zincrby("hot:threads", 1, comment["thread_id"])
    return count


def recount_thread(tenant: str, thread_id: str) -> int:
    """Reset the thread's counter from its index, the repair after a crash; returns the count."""
    n = store.indexed_count(tenant, thread_id)
    r.set(f"thread:{thread_id}:count", n)
    return n


def thread_count(tenant: str, thread_id: str) -> int:
    return int(r.get(f"thread:{thread_id}:count") or 0)


def reply_counts(tenant: str, thread_id: str, ids: list[str]) -> dict[str, int]:
    """Each id's reply count (0 when it has none)."""
    if not ids:
        return {}
    return {i: int(n or 0) for i, n in zip(ids, r.hmget(f"thread:{thread_id}:replies", ids))}


def hot_threads(tenant: str) -> list[str]:
    """The tenant's hot threads, most comments first."""
    return r.zrevrange("hot:threads", 0, -1)
`,
      solution: `import json

import redis

from comments import store  # store.insert, indexed_count, row_key, index_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOT_TTL_S = 3600
HOT_PAGE_SIZE = 10

# The comment, its index entry and every counter: Redis runs the script with nothing in between.
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
    """Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot threads. Returns the thread's count."""
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
    """Reset the thread's counter from its index, the repair after a crash; returns the count."""
    return int(r.eval(RECOUNT_LUA, 2, store.index_key(tenant, thread_id), count_key(tenant, thread_id)))


def thread_count(tenant: str, thread_id: str) -> int:
    return int(r.get(count_key(tenant, thread_id)) or 0)


def reply_counts(tenant: str, thread_id: str, ids: list[str]) -> dict[str, int]:
    """Each id's reply count (0 when it has none)."""
    if not ids:
        return {}
    return {i: int(n or 0) for i, n in zip(ids, r.hmget(replies_key(tenant, thread_id), ids))}


def hot_threads(tenant: str) -> list[str]:
    """The tenant's hot threads, most comments first."""
    return r.zrevrange(hot_key(tenant), 0, HOT_PAGE_SIZE - 1)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Comment, indexedCount, insert} from 'comments/store';

const redis = new Redis({host: 'redis', port: 6379});

/** Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot threads. Resolves the thread's count. */
export async function commitComment(tenant: string, comment: Comment): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await insert(tenant, comment);
  const count = await redis.incr(\`thread:\${comment.thread_id}:count\`);
  if (comment.parent_id !== '') await redis.hincrby(\`thread:\${comment.thread_id}:replies\`, comment.parent_id, 1);
  await redis.zincrby('hot:threads', 1, comment.thread_id);
  return count;
}

/** Reset the thread's counter from its index, the repair after a crash; resolves the count. */
export async function recountThread(tenant: string, threadId: string): Promise<number> {
  const n = await indexedCount(tenant, threadId);
  await redis.set(\`thread:\${threadId}:count\`, n);
  return n;
}

export async function threadCount(tenant: string, threadId: string): Promise<number> {
  return Number((await redis.get(\`thread:\${threadId}:count\`)) ?? 0);
}

/** Each id's reply count (0 when it has none). */
export async function replyCounts(tenant: string, threadId: string, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const counts = await redis.hmget(\`thread:\${threadId}:replies\`, ...ids);
  return Object.fromEntries(ids.map((id, i) => [id, Number(counts[i] ?? 0)]));
}

/** The tenant's hot threads, most comments first. */
export async function hotThreads(tenant: string): Promise<string[]> {
  return redis.zrevrange('hot:threads', 0, -1);
}
`,
      solution: `import Redis from 'ioredis';

import {type Comment, indexKey, rowKey} from 'comments/store';

const redis = new Redis({host: 'redis', port: 6379});

export const HOT_TTL_S = 3600;
export const HOT_PAGE_SIZE = 10;

// The comment, its index entry and every counter: Redis runs the script with nothing in between.
const COMMIT_LUA = \`
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

const RECOUNT_LUA = \`
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
\`;

const countKey = (tenant: string, threadId: string): string => \`thread:\${tenant}:\${threadId}:count\`;
const repliesKey = (tenant: string, threadId: string): string => \`thread:\${tenant}:\${threadId}:replies\`;
const hotKey = (tenant: string): string => \`hot:\${tenant}\`;

/** Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot threads. Resolves the thread's count. */
export async function commitComment(tenant: string, comment: Comment): Promise<number> {
  const threadId = comment.thread_id;
  const keys = [rowKey(tenant, comment.id), indexKey(tenant, threadId), countKey(tenant, threadId), repliesKey(tenant, threadId), hotKey(tenant)];
  const args = [JSON.stringify(comment), comment.seq, comment.id, comment.parent_id, threadId, HOT_TTL_S];
  return Number(await redis.eval(COMMIT_LUA, keys.length, ...keys, ...args));
}

/** Reset the thread's counter from its index, the repair after a crash; resolves the count. */
export async function recountThread(tenant: string, threadId: string): Promise<number> {
  return Number(await redis.eval(RECOUNT_LUA, 2, indexKey(tenant, threadId), countKey(tenant, threadId)));
}

export async function threadCount(tenant: string, threadId: string): Promise<number> {
  return Number((await redis.get(countKey(tenant, threadId))) ?? 0);
}

/** Each id's reply count (0 when it has none). */
export async function replyCounts(tenant: string, threadId: string, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const counts = await redis.hmget(repliesKey(tenant, threadId), ...ids);
  return Object.fromEntries(ids.map((id, i) => [id, Number(counts[i] ?? 0)]));
}

/** The tenant's hot threads, most comments first. */
export async function hotThreads(tenant: string): Promise<string[]> {
  return redis.zrevrange(hotKey(tenant), 0, HOT_PAGE_SIZE - 1);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"comments/store" // store.Comment, Insert, IndexedCount, RowKey, IndexKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// commitComment stores the comment and counts it: the thread's comments, the parent's replies, the
// tenant's hot threads. It returns the thread's count.
func commitComment(ctx context.Context, tenant string, c store.Comment) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if err := store.Insert(ctx, tenant, c); err != nil {
		return 0, err
	}
	count, err := rdb.Incr(ctx, "thread:"+c.ThreadID+":count").Result()
	if err != nil {
		return 0, err
	}
	if c.ParentID != "" {
		rdb.HIncrBy(ctx, "thread:"+c.ThreadID+":replies", c.ParentID, 1)
	}
	rdb.ZIncrBy(ctx, "hot:threads", 1, c.ThreadID)
	return count, nil
}

// recountThread resets the thread's counter from its index, the repair after a crash; it returns the count.
func recountThread(ctx context.Context, tenant, threadID string) (int64, error) {
	n := store.IndexedCount(ctx, tenant, threadID)
	return n, rdb.Set(ctx, "thread:"+threadID+":count", n, 0).Err()
}

func threadCount(ctx context.Context, tenant, threadID string) int64 {
	n, _ := rdb.Get(ctx, "thread:"+threadID+":count").Int64()
	return n
}

// replyCounts is each id's reply count (0 when it has none).
func replyCounts(ctx context.Context, tenant, threadID string, ids []string) map[string]int64 {
	out := map[string]int64{}
	if len(ids) == 0 {
		return out
	}
	values, _ := rdb.HMGet(ctx, "thread:"+threadID+":replies", ids...).Result()
	for i, id := range ids {
		s, _ := values[i].(string)
		out[id], _ = strconv.ParseInt(s, 10, 64)
	}
	return out
}

// hotThreads is the tenant's hot threads, most comments first.
func hotThreads(ctx context.Context, tenant string) ([]string, error) {
	return rdb.ZRevRange(ctx, "hot:threads", 0, -1).Result()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"

	"comments/store" // store.Comment, Insert, IndexedCount, RowKey, IndexKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	hotTTLSeconds = 3600
	hotPageSize   = 10
)

// commitScript writes the comment, its index entry and every counter: Redis runs it with nothing in between.
var commitScript = redis.NewScript(\`
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

var recountScript = redis.NewScript(\`
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
\`)

func countKey(tenant, threadID string) string   { return "thread:" + tenant + ":" + threadID + ":count" }
func repliesKey(tenant, threadID string) string { return "thread:" + tenant + ":" + threadID + ":replies" }
func hotKey(tenant string) string               { return "hot:" + tenant }

// commitComment stores the comment and counts it: the thread's comments, the parent's replies, the
// tenant's hot threads. It returns the thread's count.
func commitComment(ctx context.Context, tenant string, c store.Comment) (int64, error) {
	raw, _ := json.Marshal(c)
	keys := []string{store.RowKey(tenant, c.ID), store.IndexKey(tenant, c.ThreadID), countKey(tenant, c.ThreadID), repliesKey(tenant, c.ThreadID), hotKey(tenant)}
	return commitScript.Run(ctx, rdb, keys, string(raw), c.Seq, c.ID, c.ParentID, c.ThreadID, hotTTLSeconds).Int64()
}

// recountThread resets the thread's counter from its index, the repair after a crash; it returns the count.
func recountThread(ctx context.Context, tenant, threadID string) (int64, error) {
	return recountScript.Run(ctx, rdb, []string{store.IndexKey(tenant, threadID), countKey(tenant, threadID)}).Int64()
}

func threadCount(ctx context.Context, tenant, threadID string) int64 {
	n, _ := rdb.Get(ctx, countKey(tenant, threadID)).Int64()
	return n
}

// replyCounts is each id's reply count (0 when it has none).
func replyCounts(ctx context.Context, tenant, threadID string, ids []string) map[string]int64 {
	out := map[string]int64{}
	if len(ids) == 0 {
		return out
	}
	values, _ := rdb.HMGet(ctx, repliesKey(tenant, threadID), ids...).Result()
	for i, id := range ids {
		s, _ := values[i].(string)
		out[id], _ = strconv.ParseInt(s, 10, 64)
	}
	return out
}

// hotThreads is the tenant's hot threads, most comments first.
func hotThreads(ctx context.Context, tenant string) ([]string, error) {
	return rdb.ZRevRange(ctx, hotKey(tenant), 0, hotPageSize-1).Result()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import comments.Store // Store.Comment, insert, indexedCount, rowKey, indexKey

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot threads. Returns the thread's count. */
  def commitComment(tenant: String, comment: Store.Comment): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Store.insert(tenant, comment)
    val count = jedis.incr(s"thread:\${comment.threadId}:count")
    if (comment.parentId.nonEmpty) jedis.hincrBy(s"thread:\${comment.threadId}:replies", comment.parentId, 1L)
    jedis.zincrby("hot:threads", 1.0, comment.threadId)
    count
  }

  /** Reset the thread's counter from its index, the repair after a crash; returns the count. */
  def recountThread(tenant: String, threadId: String): Long = {
    val n = Store.indexedCount(tenant, threadId)
    jedis.set(s"thread:$threadId:count", n.toString)
    n
  }

  def threadCount(tenant: String, threadId: String): Long =
    Option(jedis.get(s"thread:$threadId:count")).map(_.toLong).getOrElse(0L)

  /** Each id's reply count (0 when it has none). */
  def replyCounts(tenant: String, threadId: String, ids: Seq[String]): Map[String, Long] =
    if (ids.isEmpty) Map.empty
    else ids.zip(jedis.hmget(s"thread:$threadId:replies", ids: _*).asScala).map { case (id, n) => id -> Option(n).map(_.toLong).getOrElse(0L) }.toMap

  /** The tenant's hot threads, most comments first. */
  def hotThreads(tenant: String): Seq[String] = jedis.zrevrange("hot:threads", 0, -1).asScala.toSeq
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import comments.Store // Store.Comment, insert, indexedCount, rowKey, indexKey

object State {
  val jedis = new JedisPooled("redis", 6379)

  val HotTtlSeconds = 3600L
  val HotPageSize = 10

  /** The comment, its index entry and every counter: Redis runs the script with nothing in between. */
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

  def countKey(tenant: String, threadId: String): String = s"thread:$tenant:$threadId:count"
  def repliesKey(tenant: String, threadId: String): String = s"thread:$tenant:$threadId:replies"
  def hotKey(tenant: String): String = s"hot:$tenant"

  /** Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot threads. Returns the thread's count. */
  def commitComment(tenant: String, comment: Store.Comment): Long = {
    val threadId = comment.threadId
    val keys = List(Store.rowKey(tenant, comment.id), Store.indexKey(tenant, threadId), countKey(tenant, threadId), repliesKey(tenant, threadId), hotKey(tenant))
    val args = List(Store.toJson(comment).compactPrint, comment.seq.toString, comment.id, comment.parentId, threadId, HotTtlSeconds.toString)
    jedis.eval(CommitLua, keys.asJava, args.asJava).asInstanceOf[java.lang.Long]
  }

  /** Reset the thread's counter from its index, the repair after a crash; returns the count. */
  def recountThread(tenant: String, threadId: String): Long =
    jedis.eval(RecountLua, List(Store.indexKey(tenant, threadId), countKey(tenant, threadId)).asJava, List.empty[String].asJava).asInstanceOf[java.lang.Long]

  def threadCount(tenant: String, threadId: String): Long =
    Option(jedis.get(countKey(tenant, threadId))).map(_.toLong).getOrElse(0L)

  /** Each id's reply count (0 when it has none). */
  def replyCounts(tenant: String, threadId: String, ids: Seq[String]): Map[String, Long] =
    if (ids.isEmpty) Map.empty
    else ids.zip(jedis.hmget(repliesKey(tenant, threadId), ids: _*).asScala).map { case (id, n) => id -> Option(n).map(_.toLong).getOrElse(0L) }.toMap

  /** The tenant's hot threads, most comments first. */
  def hotThreads(tenant: String): Seq[String] = jedis.zrevrange(hotKey(tenant), 0, HotPageSize - 1).asScala.toSeq
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "comments/store.h"  // store::Comment, insert, indexedCount, rowKey, indexKey

sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot
// threads. Returns the thread's count.
long long commitComment(const std::string& tenant, const store::Comment& c) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  store::insert(tenant, c);
  const long long count = client().incr("thread:" + c.thread_id + ":count");
  if (!c.parent_id.empty()) client().hincrby("thread:" + c.thread_id + ":replies", c.parent_id, 1);
  client().zincrby("hot:threads", 1, c.thread_id);
  return count;
}

// Reset the thread's counter from its index, the repair after a crash; returns the count.
long long recountThread(const std::string& tenant, const std::string& thread_id) {
  const long long n = store::indexedCount(tenant, thread_id);
  client().set("thread:" + thread_id + ":count", std::to_string(n));
  return n;
}

long long threadCount(const std::string& tenant, const std::string& thread_id) {
  const auto n = client().get("thread:" + thread_id + ":count");
  return n ? std::stoll(*n) : 0;
}

// Each id's reply count (0 when it has none).
std::map<std::string, long long> replyCounts(const std::string& tenant, const std::string& thread_id, const std::vector<std::string>& ids) {
  std::map<std::string, long long> out;
  if (ids.empty()) return out;
  std::vector<std::optional<std::string>> values;
  client().hmget("thread:" + thread_id + ":replies", ids.begin(), ids.end(), std::back_inserter(values));
  for (size_t i = 0; i < ids.size(); i++) out[ids[i]] = i < values.size() && values[i] ? std::stoll(*values[i]) : 0;
  return out;
}

// The tenant's hot threads, most comments first.
std::vector<std::string> hotThreads(const std::string& tenant) { return client().zrevrange("hot:threads", 0, -1); }
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "comments/store.h"  // store::Comment, insert, indexedCount, rowKey, indexKey

constexpr long long kHotTtlSeconds = 3600;
constexpr long long kHotPageSize = 10;

// The comment, its index entry and every counter: Redis runs the script with nothing in between.
const std::string kCommitLua = R"lua(
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

const std::string kRecountLua = R"lua(
local n = redis.call('ZCARD', KEYS[1])
redis.call('SET', KEYS[2], n)
return n
)lua";

sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string countKey(const std::string& tenant, const std::string& thread_id) { return "thread:" + tenant + ":" + thread_id + ":count"; }
std::string repliesKey(const std::string& tenant, const std::string& thread_id) { return "thread:" + tenant + ":" + thread_id + ":replies"; }
std::string hotKey(const std::string& tenant) { return "hot:" + tenant; }

// Store the comment and count it: the thread's comments, the parent's replies, the tenant's hot
// threads. Returns the thread's count.
long long commitComment(const std::string& tenant, const store::Comment& c) {
  return client().eval<long long>(
      kCommitLua,
      {store::rowKey(tenant, c.id), store::indexKey(tenant, c.thread_id), countKey(tenant, c.thread_id), repliesKey(tenant, c.thread_id), hotKey(tenant)},
      {store::toJson(c).dump(), std::to_string(c.seq), c.id, c.parent_id, c.thread_id, std::to_string(kHotTtlSeconds)});
}

// Reset the thread's counter from its index, the repair after a crash; returns the count.
long long recountThread(const std::string& tenant, const std::string& thread_id) {
  return client().eval<long long>(kRecountLua, {store::indexKey(tenant, thread_id), countKey(tenant, thread_id)}, {});
}

long long threadCount(const std::string& tenant, const std::string& thread_id) {
  const auto n = client().get(countKey(tenant, thread_id));
  return n ? std::stoll(*n) : 0;
}

// Each id's reply count (0 when it has none).
std::map<std::string, long long> replyCounts(const std::string& tenant, const std::string& thread_id, const std::vector<std::string>& ids) {
  std::map<std::string, long long> out;
  if (ids.empty()) return out;
  std::vector<std::optional<std::string>> values;
  client().hmget(repliesKey(tenant, thread_id), ids.begin(), ids.end(), std::back_inserter(values));
  for (size_t i = 0; i < ids.size(); i++) out[ids[i]] = i < values.size() && values[i] ? std::stoll(*values[i]) : 0;
  return out;
}

// The tenant's hot threads, most comments first.
std::vector<std::string> hotThreads(const std::string& tenant) { return client().zrevrange(hotKey(tenant), 0, kHotPageSize - 1); }
`,
    },
  },
  harness: {
    python: `from comments import store

INDEX = "thread:acme:t-1:comments"


def _comment(thread_id="t-1", parent_id=""):
    return store.new_comment(thread_id, parent_id, "u-1", "hello", "hello")


def _counted(ctx):
    """What every thread counter in Redis adds up to, whatever the keys are called."""
    return sum(int(ctx.redis.get(k) or 0) for k in ctx.redis.keys("*:count"))


def check_atomic_commit(ctx):
    m = ctx.load("state")
    first = _comment()
    # The instant the comment reaches the thread's index, what the counters say.
    seen = ctx.redis_after(INDEX, lambda: (ctx.redis.zcard(INDEX), _counted(ctx)))
    count = m.commit_comment("acme", first)
    assert seen.fired, f"commit_comment never wrote the thread's index {INDEX}"
    indexed, counted = seen.result
    assert indexed == counted, f"the instant the comment was indexed, the thread held {indexed} comment(s) and its counter said {counted}: a crash there leaves the counter short for good. Write the comment and its counters in one script"
    assert count == 1, f"commit_comment of the thread's first comment returned {count}, expected 1"
    reply = _comment(parent_id=first["id"])
    assert m.commit_comment("acme", reply) == 2, "the second comment of t-1 must return 2"
    assert m.thread_count("acme", "t-1") == 2, f"thread_count gives {m.thread_count('acme', 't-1')} after two comments"
    replies = m.reply_counts("acme", "t-1", [first["id"], reply["id"]])
    assert replies == {first["id"]: 1, reply["id"]: 0}, f"reply_counts gives {replies}, expected one reply under {first['id']}"
    assert store.get("acme", reply["id"]) == reply, f"the comment itself must be stored under {store.row_key('acme', reply['id'])}"


def check_tenant_keys(ctx):
    m = ctx.load("state")
    for thread_id in ("t-1", "t-1", "t-1", "t-2"):
        m.commit_comment("acme", _comment(thread_id))
    root = _comment()
    m.commit_comment("globex", root)
    m.commit_comment("globex", _comment(parent_id=root["id"]))
    assert m.thread_count("acme", "t-1") == 3 and m.thread_count("globex", "t-1") == 2, f"acme's t-1 counts {m.thread_count('acme', 't-1')} and globex's t-1 counts {m.thread_count('globex', 't-1')}, expected 3 and 2: two tenants' threads share one counter"
    assert m.reply_counts("acme", "t-1", [root["id"]]) == {root["id"]: 0}, "globex's reply is counted in acme's thread"
    assert m.reply_counts("globex", "t-1", [root["id"]]) == {root["id"]: 1}, "globex's reply must count under its parent"
    assert m.hot_threads("globex") == ["t-1"], f"globex's hot threads are {m.hot_threads('globex')}: acme's threads must not show up on another tenant's list"
    assert ctx.redis.get("thread:acme:t-1:count") == "3", f"thread:acme:t-1:count holds {ctx.redis.get('thread:acme:t-1:count')!r} (keys: {sorted(ctx.redis.keys('thread:*'))})"
    assert ctx.redis.hget("thread:globex:t-1:replies", root["id"]) == "1", "the reply must count in thread:globex:t-1:replies"
    assert ctx.redis.zscore("hot:acme", "t-1") == 3, f"hot:acme must score t-1 with its 3 comments (keys: {sorted(ctx.redis.keys('hot:*'))})"


def check_hot_expiry(ctx):
    m = ctx.load("state")
    for n in range(1, 13):
        m.commit_comment("acme", _comment(f"t-{n}"))
    for thread_id in ("t-5", "t-5", "t-9"):
        m.commit_comment("acme", _comment(thread_id))
    hot = m.hot_threads("acme")
    assert len(hot) == 10, f"hot_threads returned {len(hot)} threads, expected the first page of HOT_PAGE_SIZE = 10"
    assert hot[:2] == ["t-5", "t-9"], f"hot_threads starts {hot[:2]}, expected the busiest threads first: t-5 (3 comments), t-9 (2)"
    for key in ctx.redis.keys("hot:*"):
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= 3600, f"the hot list {key} has TTL {ttl}: it must expire HOT_TTL_S = 3600 s after the tenant's last comment, or it holds every thread ever posted to"


def check_recount(ctx):
    m = ctx.load("state")
    for _ in range(3):
        m.commit_comment("acme", _comment())
    assert m.recount_thread("acme", "t-1") == 3, "recount_thread of a thread with 3 comments must return 3"
    late = _comment()
    # Another server commits a comment while the recount is running.
    rival = ctx.redis_after(INDEX, lambda: m.commit_comment("acme", late))
    m.recount_thread("acme", "t-1")
    assert rival.fired, f"recount_thread never read the thread's index {INDEX}"
    if rival.error is not None:
        raise rival.error
    counted, indexed = m.thread_count("acme", "t-1"), store.indexed_count("acme", "t-1")
    assert counted == indexed == 4, f"a comment committed while recount_thread ran left the counter at {counted} with {indexed} comments indexed: the count and the SET must be one script"
`,
    typescript: `const INDEX = 'thread:acme:t-1:comments';

function state(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/comments/store.ts')};
}

const comment = (store, threadId = 't-1', parentId = '') => store.newComment(threadId, parentId, 'u-1', 'hello', 'hello');

/** What every thread counter in Redis adds up to, whatever the keys are called. */
const counted = ctx => (ctx.redis.keys('*:count') as string[]).reduce((sum, k) => sum + Number(ctx.redis.get(k) ?? 0), 0);

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_atomic_commit(ctx) {
  const {m, store} = state(ctx);
  const first = await comment(store);
  // The instant the comment reaches the thread's index, what the counters say.
  const seen = ctx.redisAfter(INDEX, () => [ctx.redis.zcard(INDEX), counted(ctx)]);
  const count = await m.commitComment('acme', first);
  const [indexed, total] = await settled(seen, INDEX);
  assert.equal(total, indexed, \`the instant the comment was indexed, the thread held \${indexed} comment(s) and its counter said \${total}: a crash there leaves the counter short for good. Write the comment and its counters in one script\`);
  assert.equal(count, 1, "commitComment of the thread's first comment must resolve 1");
  const reply = await comment(store, 't-1', first.id);
  assert.equal(await m.commitComment('acme', reply), 2, 'the second comment of t-1 must resolve 2');
  assert.equal(await m.threadCount('acme', 't-1'), 2, 'threadCount after two comments');
  assert.deepStrictEqual(await m.replyCounts('acme', 't-1', [first.id, reply.id]), {[first.id]: 1, [reply.id]: 0}, \`replyCounts must show one reply under \${first.id}\`);
  assert.deepStrictEqual(await store.get('acme', reply.id), reply, \`the comment itself must be stored under \${store.rowKey('acme', reply.id)}\`);
}

export async function check_tenant_keys(ctx) {
  const {m, store} = state(ctx);
  for (const threadId of ['t-1', 't-1', 't-1', 't-2']) await m.commitComment('acme', await comment(store, threadId));
  const root = await comment(store);
  await m.commitComment('globex', root);
  await m.commitComment('globex', await comment(store, 't-1', root.id));
  const [acme, globex] = [await m.threadCount('acme', 't-1'), await m.threadCount('globex', 't-1')];
  assert(acme === 3 && globex === 2, \`acme's t-1 counts \${acme} and globex's t-1 counts \${globex}, expected 3 and 2: two tenants' threads share one counter\`);
  assert.deepStrictEqual(await m.replyCounts('acme', 't-1', [root.id]), {[root.id]: 0}, "globex's reply is counted in acme's thread");
  assert.deepStrictEqual(await m.replyCounts('globex', 't-1', [root.id]), {[root.id]: 1}, "globex's reply must count under its parent");
  const hot = await m.hotThreads('globex');
  assert.deepStrictEqual(hot, ['t-1'], \`globex's hot threads are \${JSON.stringify(hot)}: acme's threads must not show up on another tenant's list\`);
  assert.equal(ctx.redis.get('thread:acme:t-1:count'), '3', \`thread:acme:t-1:count must hold 3 (keys: \${JSON.stringify(ctx.redis.keys('thread:*'))})\`);
  assert.equal(ctx.redis.hget('thread:globex:t-1:replies', root.id), '1', 'the reply must count in thread:globex:t-1:replies');
  assert.equal(Number(ctx.redis.zscore('hot:acme', 't-1')), 3, \`hot:acme must score t-1 with its 3 comments (keys: \${JSON.stringify(ctx.redis.keys('hot:*'))})\`);
}

export async function check_hot_expiry(ctx) {
  const {m, store} = state(ctx);
  for (let n = 1; n <= 12; n++) await m.commitComment('acme', await comment(store, \`t-\${n}\`));
  for (const threadId of ['t-5', 't-5', 't-9']) await m.commitComment('acme', await comment(store, threadId));
  const hot = await m.hotThreads('acme');
  assert.equal(hot.length, 10, \`hotThreads returned \${hot.length} threads, expected the first page of HOT_PAGE_SIZE = 10\`);
  assert.deepStrictEqual(hot.slice(0, 2), ['t-5', 't-9'], \`hotThreads starts \${JSON.stringify(hot.slice(0, 2))}, expected the busiest threads first: t-5 (3 comments), t-9 (2)\`);
  for (const key of ctx.redis.keys('hot:*') as string[]) {
    const ttl = Number(ctx.redis.ttl(key));
    assert(ttl > 0 && ttl <= 3600, \`the hot list \${key} has TTL \${ttl}: it must expire HOT_TTL_S = 3600 s after the tenant's last comment, or it holds every thread ever posted to\`);
  }
}

export async function check_recount(ctx) {
  const {m, store} = state(ctx);
  for (let i = 0; i < 3; i++) await m.commitComment('acme', await comment(store));
  assert.equal(await m.recountThread('acme', 't-1'), 3, 'recountThread of a thread with 3 comments must resolve 3');
  const late = await comment(store);
  // Another server commits a comment while the recount is running.
  const rival = ctx.redisAfter(INDEX, () => m.commitComment('acme', late));
  await m.recountThread('acme', 't-1');
  await settled(rival, INDEX);
  const [total, indexed] = [await m.threadCount('acme', 't-1'), await store.indexedCount('acme', 't-1')];
  assert(total === 4 && indexed === 4, \`a comment committed while recountThread ran left the counter at \${total} with \${indexed} comments indexed: the count and the SET must be one script\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"comments/store"

	"leetbuild/harness"
)

const index = "thread:acme:t-1:comments"

var stateBg = context.Background()

func newTestComment(ctx *harness.Ctx, threadID, parentID string) store.Comment {
	c, err := store.NewComment(stateBg, threadID, parentID, "u-1", "hello", "hello")
	ctx.NoError(err, "store.NewComment failed")
	return c
}

func mustCommit(ctx *harness.Ctx, tenant string, c store.Comment) int64 {
	count, err := commitComment(stateBg, tenant, c)
	ctx.NoError(err, "commitComment(%s, %s) failed", tenant, c.ID)
	return count
}

// counted is what every thread counter in Redis adds up to, whatever the keys are called.
func counted(ctx *harness.Ctx) int64 {
	var total int64
	for _, k := range ctx.Redis.Keys("*:count") {
		v, _ := ctx.Redis.Get(k)
		var n int64
		fmt.Sscan(v, &n)
		total += n
	}
	return total
}

func zcard(ctx *harness.Ctx, key string) int64 { return ctx.Redis.Do("ZCARD", key).(int64) }

func CheckAtomicCommit(ctx *harness.Ctx) {
	first := newTestComment(ctx, "t-1", "")
	// The instant the comment reaches the thread's index, what the counters say.
	seen := ctx.Redis.After(index, func() any { return [2]int64{zcard(ctx, index), counted(ctx)} })
	count := mustCommit(ctx, "acme", first)
	ctx.Assert(seen.Fired, "commitComment never wrote the thread's index %s", index)
	got, _ := seen.Result.([2]int64)
	ctx.Assert(got[0] == got[1], "the instant the comment was indexed, the thread held %d comment(s) and its counter said %d: a crash there leaves the counter short for good. Write the comment and its counters in one script", got[0], got[1])
	ctx.Equal(count, 1, "commitComment of the thread's first comment")
	reply := newTestComment(ctx, "t-1", first.ID)
	ctx.Equal(mustCommit(ctx, "acme", reply), 2, "commitComment of the second comment of t-1")
	ctx.Equal(threadCount(stateBg, "acme", "t-1"), 2, "threadCount after two comments")
	ctx.Equal(replyCounts(stateBg, "acme", "t-1", []string{first.ID, reply.ID}), map[string]int64{first.ID: 1, reply.ID: 0}, "replyCounts after one reply under %s", first.ID)
	stored := store.Get(stateBg, "acme", reply.ID)
	ctx.Assert(stored != nil && *stored == reply, "the comment itself must be stored under %s, got %+v", store.RowKey("acme", reply.ID), stored)
}

func CheckTenantKeys(ctx *harness.Ctx) {
	for _, threadID := range []string{"t-1", "t-1", "t-1", "t-2"} {
		mustCommit(ctx, "acme", newTestComment(ctx, threadID, ""))
	}
	root := newTestComment(ctx, "t-1", "")
	mustCommit(ctx, "globex", root)
	mustCommit(ctx, "globex", newTestComment(ctx, "t-1", root.ID))
	acme, globex := threadCount(stateBg, "acme", "t-1"), threadCount(stateBg, "globex", "t-1")
	ctx.Assert(acme == 3 && globex == 2, "acme's t-1 counts %d and globex's t-1 counts %d, expected 3 and 2: two tenants' threads share one counter", acme, globex)
	ctx.Equal(replyCounts(stateBg, "acme", "t-1", []string{root.ID}), map[string]int64{root.ID: 0}, "globex's reply must not count in acme's thread; acme's replyCounts")
	ctx.Equal(replyCounts(stateBg, "globex", "t-1", []string{root.ID}), map[string]int64{root.ID: 1}, "globex's reply must count under its parent; globex's replyCounts")
	hot, err := hotThreads(stateBg, "globex")
	ctx.NoError(err, "hotThreads(globex) failed")
	ctx.Equal(hot, []string{"t-1"}, "globex's hot threads (acme's threads must not show up on another tenant's list)")
	v, _ := ctx.Redis.Get("thread:acme:t-1:count")
	ctx.Equal(v, "3", "thread:acme:t-1:count (keys: %q)", ctx.Redis.Keys("thread:*"))
	r, _ := ctx.Redis.HGet("thread:globex:t-1:replies", root.ID)
	ctx.Equal(r, "1", "the reply's count in thread:globex:t-1:replies")
	ctx.Equal(fmt.Sprint(ctx.Redis.Do("ZSCORE", "hot:acme", "t-1")), "3", "hot:acme's score for t-1 (keys: %q)", ctx.Redis.Keys("hot:*"))
}

func CheckHotExpiry(ctx *harness.Ctx) {
	for n := 1; n <= 12; n++ {
		mustCommit(ctx, "acme", newTestComment(ctx, fmt.Sprintf("t-%d", n), ""))
	}
	for _, threadID := range []string{"t-5", "t-5", "t-9"} {
		mustCommit(ctx, "acme", newTestComment(ctx, threadID, ""))
	}
	hot, err := hotThreads(stateBg, "acme")
	ctx.NoError(err, "hotThreads(acme) failed")
	ctx.Equal(len(hot), 10, "hotThreads must return the first page of hotPageSize = 10 threads; the threads")
	ctx.Assert(len(hot) >= 2 && hot[0] == "t-5" && hot[1] == "t-9", "hotThreads starts %q, expected the busiest threads first: t-5 (3 comments), t-9 (2)", hot)
	for _, key := range ctx.Redis.Keys("hot:*") {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 0 && ttl <= 3600, "the hot list %s has TTL %d: it must expire hotTTLSeconds = 3600 s after the tenant's last comment, or it holds every thread ever posted to", key, ttl)
	}
}

func CheckRecount(ctx *harness.Ctx) {
	for i := 0; i < 3; i++ {
		mustCommit(ctx, "acme", newTestComment(ctx, "t-1", ""))
	}
	n, err := recountThread(stateBg, "acme", "t-1")
	ctx.NoError(err, "recountThread failed")
	ctx.Equal(n, 3, "recountThread of a thread with 3 comments")
	late := newTestComment(ctx, "t-1", "")
	// Another server commits a comment while the recount is running.
	rival := ctx.Redis.After(index, func() any {
		_, err := commitComment(stateBg, "acme", late)
		return err
	})
	_, err = recountThread(stateBg, "acme", "t-1")
	ctx.NoError(err, "recountThread failed")
	ctx.Assert(rival.Fired, "recountThread never read the thread's index %s", index)
	ctx.Assert(rival.Result == nil, "the rival commit failed: %v", rival.Result)
	total, indexed := threadCount(stateBg, "acme", "t-1"), store.IndexedCount(stateBg, "acme", "t-1")
	ctx.Assert(total == 4 && indexed == 4, "a comment committed while recountThread ran left the counter at %d with %d comments indexed: the count and the SET must be one script", total, indexed)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <array>
#include <map>
#include <string>
#include <vector>

#include "comments/store.h"

namespace {

const std::string kIndex = "thread:acme:t-1:comments";

store::Comment testComment(const std::string& thread_id = "t-1", const std::string& parent_id = "") {
  return store::newComment(thread_id, parent_id, "u-1", "hello", "hello");
}

// What every thread counter in Redis adds up to, whatever the keys are called.
long long counted(harness::Ctx& ctx) {
  long long total = 0;
  for (const auto& k : ctx.Redis.Keys("*:count")) total += std::stoll(ctx.Redis.Get(k).value_or("0"));
  return total;
}

}  // namespace

void CheckAtomicCommit(harness::Ctx& ctx) {
  const store::Comment first = testComment();
  // The instant the comment reaches the thread's index, what the counters say.
  bool fired = false;
  std::array<long long, 2> seen{-1, -1};
  ctx.Redis.After(kIndex, [&] {
    fired = true;
    seen = {ctx.Redis.ZCard(kIndex), counted(ctx)};
  });
  const long long count = commitComment("acme", first);
  ctx.Assert(fired, "commitComment never wrote the thread's index %s", kIndex);
  ctx.Assert(seen[0] == seen[1], "the instant the comment was indexed, the thread held %d comment(s) and its counter said %d: a crash there leaves the counter short for good. Write the comment and its counters in one script", seen[0], seen[1]);
  ctx.Equal(count, 1, "commitComment of the thread's first comment");
  const store::Comment reply = testComment("t-1", first.id);
  ctx.Equal(commitComment("acme", reply), 2, "commitComment of the second comment of t-1");
  ctx.Equal(threadCount("acme", "t-1"), 2, "threadCount after two comments");
  const auto replies = replyCounts("acme", "t-1", {first.id, reply.id});
  ctx.Assert(replies.size() == 2 && replies.at(first.id) == 1 && replies.at(reply.id) == 0, "replyCounts must show one reply under %s and none under %s", first.id, reply.id);
  const auto stored = store::get("acme", reply.id);
  ctx.Assert(stored && stored->id == reply.id && stored->parent_id == first.id && stored->seq == reply.seq, "the comment itself must be stored under %s", store::rowKey("acme", reply.id));
}

void CheckTenantKeys(harness::Ctx& ctx) {
  for (const std::string thread_id : {"t-1", "t-1", "t-1", "t-2"}) commitComment("acme", testComment(thread_id));
  const store::Comment root = testComment();
  commitComment("globex", root);
  commitComment("globex", testComment("t-1", root.id));
  const long long acme = threadCount("acme", "t-1");
  const long long globex = threadCount("globex", "t-1");
  ctx.Assert(acme == 3 && globex == 2, "acme's t-1 counts %d and globex's t-1 counts %d, expected 3 and 2: two tenants' threads share one counter", acme, globex);
  ctx.Equal(replyCounts("acme", "t-1", {root.id}).at(root.id), 0, "globex's reply must not count in acme's thread; acme's replyCounts for %s", root.id);
  ctx.Equal(replyCounts("globex", "t-1", {root.id}).at(root.id), 1, "globex's reply must count under its parent; globex's replyCounts for %s", root.id);
  ctx.Equal(hotThreads("globex"), std::vector<std::string>{"t-1"}, "globex's hot threads (acme's threads must not show up on another tenant's list)");
  ctx.Equal(ctx.Redis.Get("thread:acme:t-1:count").value_or(""), "3", "thread:acme:t-1:count (keys: %q)", ctx.Redis.Keys("thread:*"));
  ctx.Equal(ctx.Redis.HGet("thread:globex:t-1:replies", root.id).value_or(""), "1", "the reply's count in thread:globex:t-1:replies");
  ctx.Equal(ctx.Redis.ZScore("hot:acme", "t-1").value_or(0), 3.0, "hot:acme's score for t-1 (keys: %q)", ctx.Redis.Keys("hot:*"));
}

void CheckHotExpiry(harness::Ctx& ctx) {
  for (int n = 1; n <= 12; n++) commitComment("acme", testComment("t-" + std::to_string(n)));
  for (const std::string thread_id : {"t-5", "t-5", "t-9"}) commitComment("acme", testComment(thread_id));
  const auto hot = hotThreads("acme");
  ctx.Equal(hot.size(), 10, "hotThreads must return the first page of kHotPageSize = 10 threads; the threads");
  ctx.Assert(hot.size() >= 2 && hot[0] == "t-5" && hot[1] == "t-9", "hotThreads starts %q, expected the busiest threads first: t-5 (3 comments), t-9 (2)", hot);
  for (const auto& key : ctx.Redis.Keys("hot:*")) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 0 && ttl <= 3600, "the hot list %s has TTL %d: it must expire kHotTtlSeconds = 3600 s after the tenant's last comment, or it holds every thread ever posted to", key, ttl);
  }
}

void CheckRecount(harness::Ctx& ctx) {
  for (int i = 0; i < 3; i++) commitComment("acme", testComment());
  ctx.Equal(recountThread("acme", "t-1"), 3, "recountThread of a thread with 3 comments");
  const store::Comment late = testComment();
  // Another server commits a comment while the recount is running.
  bool fired = false;
  std::string failed;
  ctx.Redis.After(kIndex, [&] {
    fired = true;
    try {
      commitComment("acme", late);
    } catch (const std::exception& e) {
      failed = e.what();
    }
  });
  recountThread("acme", "t-1");
  ctx.Assert(fired, "recountThread never read the thread's index %s", kIndex);
  ctx.Assert(failed.empty(), "the rival commit failed: %s", failed);
  const long long total = threadCount("acme", "t-1");
  const long long indexed = store::indexedCount("acme", "t-1");
  ctx.Assert(total == 4 && indexed == 4, "a comment committed while recountThread ran left the counter at %d with %d comments indexed: the count and the SET must be one script", total, indexed);
}
`,
  },
  hints: [
    'Read the thread counter the instant a comment reaches the index: it is one short. Open globex’s hot list: acme’s threads are on it, and they are still there a month later.',
    '`store.insert` and the `INCR` are separate commands, so a reader or a crash between them sees half a commit. The keys carry no tenant, `hot:threads` never gets an `EXPIRE`, and `recount_thread` reads, then writes.',
    'One `COMMIT_LUA` with `SET`, `ZADD`, `INCR`, the reply `HINCRBY`, `ZINCRBY` and `EXPIRE HOT_TTL_S`, run with `r.eval`; keys `thread:{tenant}:{thread}:…` and `hot:{tenant}`; read `0, HOT_PAGE_SIZE - 1`; `RECOUNT_LUA` does `ZCARD` then `SET`.',
  ],
  debrief: `A counter is derived state, and derived state stays honest only when it is written in the same atomic step as what it counts. Redis runs a Lua script with no other command in between, so the comment, its index entry and every counter land together; a separate \`INCR\` leaves a window that a crash or a reader turns into a lasting off-by-one. The recount is one script for the same reason: a count and a \`SET\` with a gap between can erase a comment committed in the gap. Production systems usually keep comments in a database and counters in Redis, which cannot share a script, so they increment from the change stream, once per comment id, and recount on a schedule. Hot lists there decay their scores instead of expiring whole.`,
};
