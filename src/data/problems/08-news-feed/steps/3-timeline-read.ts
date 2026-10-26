import type {Step} from '@/lib/types';

export const timelineReadStep: Step = {
  id: 'timeline-read',
  title: 'Read the timeline: merge pushed and pulled',
  concept: 'redis',
  file: 'timeline',
  focus: ['api', 'redis'],
  task: `## Task

Implement \`read(user, cursor, limit)\`, the function \`GET /feed\` calls. A user's page is the union of
two sources: the ids the fan-out worker **pushed** into \`timeline:{user}\`, and the recent posts of the
celebrities the user follows, **pulled** from their \`posts:{celebrity}\` sorted sets (score = \`created_at\`).
\`graph.celebrities_followed(user)\` and \`created_at(post_id)\` are provided (ids carry their timestamp).

- Pushed ids: \`LRANGE timeline:{user} 0 2*limit-1\` — the list is newest-first; keep the ids older than
  the cursor.
- Pulled ids: for every followed celebrity, \`ZREVRANGEBYSCORE posts:{celebrity} (cursor -inf LIMIT 0 limit\`
  (\`+inf\` when there is no cursor; the \`(\` makes the bound exclusive).
- Send **all** of these in **one pipeline** — a page must not cost one round trip per celebrity.
- Merge the ids, drop duplicates, sort by \`created_at\` **descending**, cut to \`limit\`.
- \`next_cursor\` is the \`created_at\` of the last post returned, or nothing when the page is empty.

:::widget cache-aside {}

> **Push vs pull.** The pushed list is a precomputed answer: cheap to read, expensive to keep up to date
> (step 2). The pulled sets are the opposite. Hybrid feeds use push for the long tail of authors and
> pull for the few whose fan-out would be ruinous — the read merges both so the client cannot tell.`,
  sequence: {
    participants: ['feed-api', 'graph', 'Redis'],
    messages: [
      {from: 'feed-api', to: 'graph', label: 'celebrities_followed(alice)', kind: 'sync'},
      {from: 'graph', to: 'feed-api', label: '[taylor, nasa]', kind: 'reply'},
      {from: 'feed-api', to: 'Redis', label: 'LRANGE timeline:alice 0 39', kind: 'sync'},
      {
        from: 'feed-api',
        to: 'Redis',
        label: 'ZREVRANGEBYSCORE posts:taylor +inf -inf LIMIT 0 20 · posts:nasa …',
        kind: 'sync',
      },
      {from: 'Redis', to: 'feed-api', label: '3 replies (one pipeline)', kind: 'reply'},
      {from: 'feed-api', to: 'feed-api', label: 'merge · sort by created_at desc · [:20]', kind: 'sync'},
    ],
  },
  hints: [
    'Queue the LRANGE first, then one ZREVRANGEBYSCORE per celebrity, then execute once: the first reply is the pushed list, the rest line up with the celebrity list.',
    'The cursor filter is the same predicate for both sources — `created_at(id) < cursor` — but Redis can apply it for the sorted sets (the `(cursor` max bound) while the list needs it in code.',
    'Sort the merged ids with `created_at` as the key, newest first, slice to `limit`, and derive the cursor from the last element of that slice.',
  ],
  checks: [
    {
      id: 'pushed',
      title: 'Reads the pushed ids from timeline:{user}',
      detail:
        '`LRANGE timeline:{user} 0 2*limit-1` fetches the head of the fan-out list — enough to fill a page after the cursor filter.',
      match: {
        python: {
          all: [
            /f"timeline:\{user_id\}"/,
            /\.lrange\([^\n]*,\s*0\s*,\s*(2\s*\*\s*limit|limit\s*\*\s*2|TIMELINE_LEN\s*-\s*1|999)/,
          ],
        },
        typescript: {
          all: [
            /`timeline:\$\{userId\}`|['"]timeline:['"]\s*\+\s*userId/,
            /\.lrange\([^\n]*,\s*0\s*,\s*(2\s*\*\s*limit|limit\s*\*\s*2|TIMELINE_LEN\s*-\s*1|999)/,
          ],
        },
        go: {
          all: [
            /"timeline:"\s*\+\s*userID|"timeline:%s"/,
            /\.LRange\(\s*ctx\s*,[^\n]*,\s*0\s*,\s*(int64\()?\s*(2\s*\*\s*limit|limit\s*\*\s*2|timelineLen\s*-\s*1|999)/,
          ],
        },
        scala: {
          all: [
            /s"timeline:\$\{?userId\}?"/,
            /\.lrange\([^\n]*,\s*0\s*,\s*(2\s*\*\s*limit|limit\s*\*\s*2|TimelineLen\s*-\s*1|999)/,
          ],
        },
        cpp: {
          all: [
            /"timeline:"\s*\+\s*user\b/,
            /\.lrange\([^\n]*,\s*0\s*,\s*(2\s*\*\s*limit|limit\s*\*\s*2|kTimelineLen\s*-\s*1|999)/,
          ],
        },
      },
    },
    {
      id: 'pulled',
      title: 'Pulls recent posts of every followed celebrity',
      detail:
        'For each id from `graph.celebrities_followed`, `ZREVRANGEBYSCORE posts:{celebrity} <max> -inf LIMIT 0 limit` returns the newest posts under the cursor.',
      match: {
        python: {
          all: [
            /graph\.celebrities_followed\(/,
            /f"posts:\{/,
            /\.zrevrangebyscore\(|\.zrange\([^\n]*byscore\s*=\s*True/,
          ],
        },
        typescript: {
          all: [/graph\.celebritiesFollowed\(/, /`posts:\$\{/, /\.zrevrangebyscore\(|\.zrange\([^\n]*['"]REV['"]/],
        },
        go: {all: [/graph\.CelebritiesFollowed\(/, /"posts:"\s*\+|"posts:%s"/, /\.ZRevRangeByScore\(|Rev:\s*true/]},
        scala: {all: [/Graph\.celebritiesFollowed\(/, /s"posts:\$/, /\.zrevrangeByScore\(|\.rev\(\)/]},
        cpp: {all: [/graph::celebrities_followed\(/, /"posts:"\s*\+/, /\.zrevrangebyscore\(/]},
      },
    },
    {
      id: 'single-pipeline',
      title: 'Fetches everything in one pipeline',
      detail:
        'Queue the LRANGE and every ZREVRANGEBYSCORE on one pipeline and execute once; a direct call per source costs a round trip each.',
      match: {
        python: {
          all: [/\br\.pipeline\(/, /\.execute\(\)/],
          none: [/\br\.lrange\(|\br\.zrevrangebyscore\(|\br\.zrange\(/],
        },
        typescript: {
          all: [/\bredis\.pipeline\(/, /\.exec\(\)/],
          none: [/\bredis\.lrange\(|\bredis\.zrevrangebyscore\(|\bredis\.zrange\(/],
        },
        go: {
          all: [/rdb\.Pipeline\(\)/, /\.Exec\(\s*ctx\s*\)/],
          none: [/rdb\.LRange\(|rdb\.ZRevRangeByScore\(|rdb\.ZRangeArgs\(/],
        },
        scala: {
          all: [/jedis\.pipelined\(\)/, /\.sync(AndReturnAll)?\(\)/],
          none: [/jedis\.lrange\(|jedis\.zrevrangeByScore\(|jedis\.zrange\(/],
        },
        cpp: {all: [/redis\.pipeline\(/, /\.exec\(\)/], none: [/redis\.lrange\(|redis\.zrevrangebyscore\(/]},
      },
    },
    {
      id: 'merged',
      title: 'Merges newest-first and cuts to limit',
      detail: 'Sort the union of both sources by `created_at` descending and keep the first `limit` ids.',
      match: {
        python: {all: [/(sorted|\.sort)\([^\n]*created_at[^\n]*\)/, /reverse\s*=\s*True/, /\[\s*:\s*limit\s*\]/]},
        typescript: {all: [/\.sort\([^\n]*createdAt/, /\.slice\(\s*0\s*,\s*limit\s*\)/]},
        go: {all: [/sort\.Slice\(|slices\.SortFunc\(/, /CreatedAt\(/, /\[\s*:\s*limit\s*\]/]},
        scala: {all: [/\.sortBy\(|\.sortWith\(|\.sorted\b/, /createdAt\(/, /\.take\(\s*limit\s*\)/]},
        cpp: {all: [/std::(stable_)?sort\(/, /created_at\(/, /\.resize\(\s*limit\s*\)|\.erase\([^\n]*\+\s*limit/]},
      },
    },
    {
      id: 'cursor',
      title: 'Applies the cursor and returns the next one',
      detail:
        'Pushed ids at or after the cursor are dropped (`created_at(id) < cursor`), and `next_cursor` is the `created_at` of the last post of the page.',
      match: {
        python: {all: [/created_at\(\s*\w+\s*\)\s*(<|>=)\s*cursor/, /created_at\(\s*\w+\[\s*-1\s*\]\s*\)/]},
        typescript: {
          all: [
            /createdAt\(\s*\w+\s*\)\s*(<|>=)\s*cursor/,
            /createdAt\(\s*\w+\[\s*\w+\.length\s*-\s*1\s*\]\s*\)|createdAt\(\s*\w+\.at\(\s*-1\s*\)\s*\)/,
          ],
        },
        go: {
          all: [
            /CreatedAt\(\s*\w+\s*\)\s*(<|>=)\s*\*?cursor/,
            /CreatedAt\(\s*\w+\[\s*len\(\s*\w+\s*\)\s*-\s*1\s*\]\s*\)/,
          ],
        },
        scala: {
          all: [
            /createdAt\(\s*\w+\s*\)\s*(<|>=)\s*\w+/,
            /\.lastOption\.map\([^\n]*createdAt|createdAt\(\s*\w+\.last\s*\)/,
          ],
        },
        cpp: {all: [/created_at\(\s*\w+\s*\)\s*(<|>=)\s*\*?cursor/, /created_at\(\s*\w+\.back\(\)\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from feed import graph  # provided: graph.celebrities_followed(user_id) -> list[str]
from feed.ids import created_at  # provided: created_at(post_id) -> int (ms; the id carries its timestamp)

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TIMELINE_LEN = 1000


def read(user_id: str, cursor: int | None, limit: int) -> tuple[list[str], int | None]:
    """Post ids for the home timeline, newest first, and the cursor of the next page."""
    celebrities = graph.celebrities_followed(user_id)
    # TODO: one pipeline: LRANGE timeline:{user_id} 0 2*limit-1, then ZREVRANGEBYSCORE posts:{c} (cursor -inf LIMIT 0 limit per celebrity
    # TODO: keep pushed ids with created_at < cursor; merge, dedupe, sort by created_at desc, cut to limit
    # TODO: next_cursor = created_at of the last id, or None
    raise NotImplementedError
`,
      solution: `import redis

from feed import graph  # provided: graph.celebrities_followed(user_id) -> list[str]
from feed.ids import created_at  # provided: created_at(post_id) -> int (ms; the id carries its timestamp)

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TIMELINE_LEN = 1000


def read(user_id: str, cursor: int | None, limit: int) -> tuple[list[str], int | None]:
    """Post ids for the home timeline, newest first, and the cursor of the next page."""
    celebrities = graph.celebrities_followed(user_id)
    max_score = f"({cursor}" if cursor is not None else "+inf"
    pipe = r.pipeline(transaction=False)
    pipe.lrange(f"timeline:{user_id}", 0, 2 * limit - 1)
    for celebrity in celebrities:
        pipe.zrevrangebyscore(f"posts:{celebrity}", max_score, "-inf", start=0, num=limit)
    pushed, *pulled = pipe.execute()
    candidates = {pid for pid in pushed if cursor is None or created_at(pid) < cursor}
    for ids in pulled:
        candidates.update(ids)
    page = sorted(candidates, key=created_at, reverse=True)[:limit]
    next_cursor = created_at(page[-1]) if page else None
    return page, next_cursor
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {graph} from 'feed/graph'; // provided: graph.celebritiesFollowed(userId) → string[]
import {createdAt} from 'feed/ids'; // provided: createdAt(postId) → ms (the id carries its timestamp)

const redis = new Redis({host: 'redis', port: 6379});

export const TIMELINE_LEN = 1000;

/** Post ids for the home timeline, newest first, and the cursor of the next page. */
export async function read(userId: string, cursor: number | null, limit: number): Promise<[string[], number | null]> {
  const celebrities = graph.celebritiesFollowed(userId);
  // TODO: one pipeline: LRANGE timeline:{userId} 0 2*limit-1, then ZREVRANGEBYSCORE posts:{c} (cursor -inf LIMIT 0 limit per celebrity
  // TODO: keep pushed ids with createdAt < cursor; merge, dedupe, sort by createdAt desc, cut to limit
  // TODO: next_cursor = createdAt of the last id, or null
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

import {graph} from 'feed/graph'; // provided: graph.celebritiesFollowed(userId) → string[]
import {createdAt} from 'feed/ids'; // provided: createdAt(postId) → ms (the id carries its timestamp)

const redis = new Redis({host: 'redis', port: 6379});

export const TIMELINE_LEN = 1000;

/** Post ids for the home timeline, newest first, and the cursor of the next page. */
export async function read(userId: string, cursor: number | null, limit: number): Promise<[string[], number | null]> {
  const celebrities = graph.celebritiesFollowed(userId);
  const maxScore = cursor === null ? '+inf' : \`(\${cursor}\`;
  const pipe = redis.pipeline();
  pipe.lrange(\`timeline:\${userId}\`, 0, 2 * limit - 1);
  for (const celebrity of celebrities) pipe.zrevrangebyscore(\`posts:\${celebrity}\`, maxScore, '-inf', 'LIMIT', 0, limit);
  const [[, pushed], ...pulled] = (await pipe.exec()) as [Error | null, string[]][];
  const candidates = new Set(pushed.filter(id => cursor === null || createdAt(id) < cursor));
  for (const [, ids] of pulled) for (const id of ids) candidates.add(id);
  const page = [...candidates].sort((a, b) => createdAt(b) - createdAt(a)).slice(0, limit);
  const nextCursor = page.length === 0 ? null : createdAt(page[page.length - 1]);
  return [page, nextCursor];
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"

	"feed/graph" // graph.CelebritiesFollowed(ctx, userID) ([]string, error) — provided
	"feed/ids"   // ids.CreatedAt(postID) int64 — provided (ms; the id carries its timestamp)
)

const timelineLen = 1000

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Read returns post ids for the home timeline, newest first, and the cursor of the next page.
func Read(ctx context.Context, userID string, cursor *int64, limit int) ([]string, *int64, error) {
	celebrities, err := graph.CelebritiesFollowed(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	// TODO: one pipeline: LRange timeline:{userID} 0 2*limit-1, then ZRevRangeByScore posts:{c} (cursor -inf LIMIT 0 limit per celebrity
	// TODO: keep pushed ids with ids.CreatedAt < *cursor; merge, dedupe, sort by CreatedAt desc, cut to limit
	// TODO: next cursor = CreatedAt of the last id, or nil
	_, _ = fmt.Sprintf, sort.Slice
	_, _ = celebrities, ids.CreatedAt
	return nil, nil, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"

	"feed/graph" // graph.CelebritiesFollowed(ctx, userID) ([]string, error) — provided
	"feed/ids"   // ids.CreatedAt(postID) int64 — provided (ms; the id carries its timestamp)
)

const timelineLen = 1000

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Read returns post ids for the home timeline, newest first, and the cursor of the next page.
func Read(ctx context.Context, userID string, cursor *int64, limit int) ([]string, *int64, error) {
	celebrities, err := graph.CelebritiesFollowed(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	maxScore := "+inf"
	if cursor != nil {
		maxScore = fmt.Sprintf("(%d", *cursor)
	}
	pipe := rdb.Pipeline()
	pushed := pipe.LRange(ctx, "timeline:"+userID, 0, int64(2*limit-1))
	pulled := make([]*redis.StringSliceCmd, 0, len(celebrities))
	for _, c := range celebrities {
		pulled = append(pulled, pipe.ZRevRangeByScore(ctx, "posts:"+c, &redis.ZRangeBy{Max: maxScore, Min: "-inf", Offset: 0, Count: int64(limit)}))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, nil, err
	}
	seen := make(map[string]bool, 2*limit)
	merged := make([]string, 0, 2*limit)
	add := func(id string) {
		if seen[id] || (cursor != nil && ids.CreatedAt(id) >= *cursor) {
			return
		}
		seen[id] = true
		merged = append(merged, id)
	}
	for _, id := range pushed.Val() {
		add(id)
	}
	for _, cmd := range pulled {
		for _, id := range cmd.Val() {
			add(id)
		}
	}
	sort.Slice(merged, func(i, j int) bool { return ids.CreatedAt(merged[i]) > ids.CreatedAt(merged[j]) })
	if len(merged) > limit {
		merged = merged[:limit]
	}
	if len(merged) == 0 {
		return merged, nil, nil
	}
	next := ids.CreatedAt(merged[len(merged)-1])
	return merged, &next, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

import feed.graph.Graph // Graph.celebritiesFollowed(userId): Seq[String] — provided
import feed.ids.Ids // Ids.createdAt(postId): Long — provided (ms; the id carries its timestamp)

object Timeline {
  val TimelineLen = 1000L
  val jedis = new JedisPooled("redis", 6379)

  /** Post ids for the home timeline, newest first, and the cursor of the next page. */
  def read(userId: String, cursor: Option[Long], limit: Int): (Seq[String], Option[Long]) = {
    val celebrities = Graph.celebritiesFollowed(userId)
    // TODO: one pipeline: lrange timeline:{userId} 0 2*limit-1, then zrevrangeByScore posts:{c} (cursor -inf 0 limit per celebrity
    // TODO: keep pushed ids with Ids.createdAt < cursor; merge, dedupe, sort by createdAt desc, take limit
    // TODO: next cursor = createdAt of the last id, or None
    (Nil, None)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

import feed.graph.Graph // Graph.celebritiesFollowed(userId): Seq[String] — provided
import feed.ids.Ids // Ids.createdAt(postId): Long — provided (ms; the id carries its timestamp)

object Timeline {
  val TimelineLen = 1000L
  val jedis = new JedisPooled("redis", 6379)

  /** Post ids for the home timeline, newest first, and the cursor of the next page. */
  def read(userId: String, cursor: Option[Long], limit: Int): (Seq[String], Option[Long]) = {
    val celebrities = Graph.celebritiesFollowed(userId)
    val maxScore = cursor.map(c => s"($c").getOrElse("+inf")
    val p = jedis.pipelined()
    val pushed = p.lrange(s"timeline:$userId", 0, 2 * limit - 1)
    val pulled = celebrities.map(c => p.zrevrangeByScore(s"posts:$c", maxScore, "-inf", 0, limit))
    p.sync()
    val fromList = pushed.get.asScala.filter(id => cursor.forall(c => Ids.createdAt(id) < c))
    val candidates = (fromList ++ pulled.flatMap(_.get.asScala)).distinct
    val page = candidates.sortBy(id => -Ids.createdAt(id)).take(limit)
    (page, page.lastOption.map(Ids.createdAt))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <limits>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

#include "feed/graph.h"  // graph::celebrities_followed(user) -> std::vector<std::string> — provided
#include "feed/ids.h"    // ids::created_at(post_id) -> int64_t — provided (ms; the id carries its timestamp)

constexpr long long kTimelineLen = 1000;

sw::redis::Redis redis("tcp://redis:6379");

struct Page {
  std::vector<std::string> items;
  std::optional<int64_t> next_cursor;
};

// Post ids for the home timeline, newest first, and the cursor of the next page.
Page read(const std::string& user, std::optional<int64_t> cursor, int limit) {
  const auto celebrities = graph::celebrities_followed(user);
  // TODO: one pipeline: lrange timeline:{user} 0 2*limit-1, then zrevrangebyscore posts:{c} (cursor -inf LIMIT 0 limit per celebrity
  // TODO: keep pushed ids with ids::created_at < *cursor; merge, dedupe, sort by created_at desc, resize to limit
  // TODO: next_cursor = created_at of the last id, or nullopt
  return Page{};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <limits>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

#include "feed/graph.h"  // graph::celebrities_followed(user) -> std::vector<std::string> — provided
#include "feed/ids.h"    // ids::created_at(post_id) -> int64_t — provided (ms; the id carries its timestamp)

constexpr long long kTimelineLen = 1000;

sw::redis::Redis redis("tcp://redis:6379");

struct Page {
  std::vector<std::string> items;
  std::optional<int64_t> next_cursor;
};

// Post ids for the home timeline, newest first, and the cursor of the next page.
Page read(const std::string& user, std::optional<int64_t> cursor, int limit) {
  using namespace sw::redis;
  const auto celebrities = graph::celebrities_followed(user);
  const double max_score = cursor ? static_cast<double>(*cursor) : std::numeric_limits<double>::infinity();
  auto pipe = redis.pipeline(false);
  pipe.lrange("timeline:" + user, 0, 2 * limit - 1);
  for (const auto& c : celebrities)
    pipe.zrevrangebyscore("posts:" + c, RightBoundedInterval<double>(max_score, BoundType::OPEN), LimitOptions{0, limit});
  auto replies = pipe.exec();

  std::vector<std::string> merged;
  std::unordered_set<std::string> seen;
  auto add = [&](const std::string& id) {
    if (cursor && ids::created_at(id) >= *cursor) return;
    if (seen.insert(id).second) merged.push_back(id);
  };
  for (std::size_t i = 0; i < replies.size(); ++i)
    for (const auto& id : replies.get<std::vector<std::string>>(i)) add(id);  // reply 0 = pushed, then one per celebrity

  std::sort(merged.begin(), merged.end(),
            [](const std::string& a, const std::string& b) { return ids::created_at(a) > ids::created_at(b); });
  if (merged.size() > static_cast<std::size_t>(limit)) merged.resize(limit);
  Page page{merged, std::nullopt};
  if (!merged.empty()) page.next_cursor = ids::created_at(merged.back());
  return page;
}
`,
    },
  },
  harness: {
    python: `def _pid(ms, tag="a"):
    """Ids carry their timestamp: '<created_at ms>-<suffix>' (feed.ids.created_at parses the prefix)."""
    return f"{ms}-{tag}"


def _ms(pid):
    return int(pid.split("-", 1)[0])


def _reader(ctx, celebrities=None):
    m = ctx.load("timeline")
    celebrities = celebrities or {}
    m.graph.celebrities_followed = lambda user: list(celebrities.get(user, []))
    return m


def _push(ctx, user, *ids):
    """Fan-out writes: ids given oldest first end up newest first in the list."""
    for pid in ids:
        ctx.redis.lpush(f"timeline:{user}", pid)


def _pull(ctx, author, *ids):
    ctx.redis.zadd(f"posts:{author}", {pid: _ms(pid) for pid in ids})


def _spy(r):
    """Round trips the learner's client makes: direct command names, and the size of every executed pipeline."""
    trips = {"direct": [], "pipelines": []}
    real_pipeline, real_execute = r.pipeline, r.execute_command

    def pipeline(*args, **kwargs):
        pipe = real_pipeline(*args, **kwargs)
        real_pipe_execute = pipe.execute

        def execute(*a, **k):
            trips["pipelines"].append(len(pipe.command_stack))
            return real_pipe_execute(*a, **k)

        pipe.execute = execute
        return pipe

    def execute_command(*args, **kwargs):
        trips["direct"].append(str(args[0]).lower())
        return real_execute(*args, **kwargs)

    r.pipeline = pipeline
    r.execute_command = execute_command
    return trips


def check_pushed(ctx):
    ids = [_pid(100 + i) for i in range(10)]
    _push(ctx, "alice", *ids)
    m = _reader(ctx)
    page, next_cursor = m.read("alice", None, 3)
    assert page == [_pid(109), _pid(108), _pid(107)], f"with 10 pushed ids and limit 3 the page must be the 3 newest, got {page}"
    assert next_cursor == 107, f"next_cursor must be the created_at of the last id of the page (107), got {next_cursor!r}"
    page, _ = m.read("alice", None, 20)
    assert page == list(reversed(ids)), f"with limit 20 every pushed id must be returned newest first, got {page}"


def check_pulled(ctx):
    taylor = [_pid(200 + i, "t") for i in range(5)]
    nasa = [_pid(150, "n"), _pid(151, "n")]
    _pull(ctx, "taylor", *taylor)
    _pull(ctx, "nasa", *nasa)
    m = _reader(ctx, {"alice": ["taylor", "nasa"]})
    page, next_cursor = m.read("alice", None, 4)
    assert page == [_pid(204, "t"), _pid(203, "t"), _pid(202, "t"), _pid(201, "t")], f"nothing was pushed: the page must be the 4 newest celebrity posts, got {page}"
    assert next_cursor == 201, f"next_cursor must be 201, got {next_cursor!r}"
    page, _ = m.read("alice", None, 10)
    assert page == list(reversed(taylor)) + list(reversed(nasa)), f"every post of every followed celebrity must be pulled, newest first: {page}"
    page, _ = m.read("bob", None, 10)
    assert page == [], f"bob follows no celebrity and has no timeline: expected an empty page, got {page}"


def check_single_pipeline(ctx):
    _push(ctx, "alice", _pid(100), _pid(300))
    _pull(ctx, "taylor", _pid(200, "t"))
    _pull(ctx, "nasa", _pid(400, "n"))
    m = _reader(ctx, {"alice": ["taylor", "nasa"]})
    trips = _spy(m.r)
    page, _ = m.read("alice", None, 10)
    assert page == [_pid(400, "n"), _pid(300), _pid(200, "t"), _pid(100)], f"unexpected page {page}"
    reads = [c for c in trips["direct"] if c in ("lrange", "zrevrangebyscore", "zrange")]
    assert not reads, f"{len(reads)} Redis read(s) were sent outside a pipeline ({reads}): queue the LRANGE and every ZREVRANGEBYSCORE on one pipeline"
    assert len(trips["pipelines"]) == 1, f"a page must cost one round trip: observed {len(trips['pipelines'])} pipeline execute(s)"
    assert trips["pipelines"][0] == 3, f"the pipeline must carry the LRANGE and one ZREVRANGEBYSCORE per celebrity (3 commands for 2 celebrities), got {trips['pipelines'][0]}"


def check_merged(ctx):
    _push(ctx, "alice", _pid(100), _pid(300), _pid(500))
    _pull(ctx, "taylor", _pid(200, "t"), _pid(400, "t"), _pid(600, "t"))
    _pull(ctx, "nasa", _pid(500))  # the same post also arrived through fan-out
    m = _reader(ctx, {"alice": ["taylor", "nasa"]})
    page, next_cursor = m.read("alice", None, 4)
    assert page == [_pid(600, "t"), _pid(500), _pid(400, "t"), _pid(300)], f"pushed and pulled ids must be merged newest first and cut to limit, got {page}"
    assert next_cursor == 300, f"next_cursor must be 300, got {next_cursor!r}"
    page, _ = m.read("alice", None, 10)
    assert page.count(_pid(500)) == 1, f"an id present in both sources must appear once, got {page}"
    assert page == [_pid(600, "t"), _pid(500), _pid(400, "t"), _pid(300), _pid(200, "t"), _pid(100)], f"the full merge must be every distinct id newest first, got {page}"


def check_cursor(ctx):
    _push(ctx, "alice", *[_pid(100 + 2 * i) for i in range(10)])  # 100, 102, ..., 118; LRANGE 0 5 sees 118..108
    _pull(ctx, "taylor", _pid(109, "t"), _pid(113, "t"), _pid(115, "t"), _pid(121, "t"))
    m = _reader(ctx, {"alice": ["taylor"]})
    page, next_cursor = m.read("alice", 115, 3)
    assert page == [_pid(114), _pid(113, "t"), _pid(112)], f"with cursor 115 only ids created before 115 may appear (the bound is exclusive, from both sources), got {page}"
    assert next_cursor == 112, f"next_cursor must be 112, got {next_cursor!r}"
    page, next_cursor = m.read("alice", next_cursor, 3)
    assert page == [_pid(110), _pid(109, "t"), _pid(108)], f"the next page must continue below the cursor without overlap, got {page}"
    assert next_cursor == 108, f"next_cursor must be 108, got {next_cursor!r}"
    page, next_cursor = m.read("alice", 100, 3)
    assert page == [], f"nothing is older than 100: expected an empty page, got {page}"
    assert next_cursor is None, f"an empty page has no next_cursor, got {next_cursor!r}"
`,
    typescript: `import {CELEBRITIES_FOLLOWED} from 'feed/graph';

/** Ids carry their timestamp: '<created_at ms>-<suffix>' (feed/ids createdAt parses the prefix). */
const pid = (ms: number, tag = 'a'): string => \`\${ms}-\${tag}\`;

function reader(ctx, celebrities: Record<string, string[]> = {}) {
  const m = ctx.load('timeline');
  for (const [user, list] of Object.entries(celebrities)) CELEBRITIES_FOLLOWED[user] = list;
  return m;
}

/** Fan-out writes: ids given oldest first end up newest first in the list. */
function push(ctx, user: string, ...ids: string[]) {
  for (const id of ids) ctx.redis.lpush(\`timeline:\${user}\`, id);
}

function pull(ctx, author: string, ...ids: string[]) {
  for (const id of ids) ctx.redis.zadd(\`posts:\${author}\`, Number(id.split('-', 1)[0]), id);
}

export async function check_pushed(ctx) {
  const ids = Array.from({length: 10}, (_, i) => pid(100 + i));
  push(ctx, 'alice', ...ids);
  const m = reader(ctx);
  let [page, nextCursor] = await m.read('alice', null, 3);
  assert.deepEqual(page, [pid(109), pid(108), pid(107)], \`with 10 pushed ids and limit 3 the page must be the 3 newest, got \${JSON.stringify(page)}\`);
  assert.equal(nextCursor, 107, \`next_cursor must be the created_at of the last id of the page (107), got \${JSON.stringify(nextCursor)}\`);
  [page] = await m.read('alice', null, 20);
  assert.deepEqual(page, [...ids].reverse(), \`with limit 20 every pushed id must be returned newest first, got \${JSON.stringify(page)}\`);
}

export async function check_pulled(ctx) {
  const taylor = Array.from({length: 5}, (_, i) => pid(200 + i, 't'));
  const nasa = [pid(150, 'n'), pid(151, 'n')];
  pull(ctx, 'taylor', ...taylor);
  pull(ctx, 'nasa', ...nasa);
  const m = reader(ctx, {alice: ['taylor', 'nasa']});
  let [page, nextCursor] = await m.read('alice', null, 4);
  assert.deepEqual(page, [pid(204, 't'), pid(203, 't'), pid(202, 't'), pid(201, 't')], \`nothing was pushed: the page must be the 4 newest celebrity posts, got \${JSON.stringify(page)}\`);
  assert.equal(nextCursor, 201, \`next_cursor must be 201, got \${JSON.stringify(nextCursor)}\`);
  [page] = await m.read('alice', null, 10);
  assert.deepEqual(page, [...taylor].reverse().concat([...nasa].reverse()), \`every post of every followed celebrity must be pulled, newest first: \${JSON.stringify(page)}\`);
  [page] = await m.read('bob', null, 10);
  assert.deepEqual(page, [], \`bob follows no celebrity and has no timeline: expected an empty page, got \${JSON.stringify(page)}\`);
}

export async function check_single_pipeline(ctx) {
  push(ctx, 'alice', pid(100), pid(300));
  pull(ctx, 'taylor', pid(200, 't'));
  pull(ctx, 'nasa', pid(400, 'n'));
  const m = reader(ctx, {alice: ['taylor', 'nasa']});
  const [page] = await m.read('alice', null, 10);
  assert.deepEqual(page, [pid(400, 'n'), pid(300), pid(200, 't'), pid(100)], \`unexpected page \${JSON.stringify(page)}\`);
  const trips = ctx.redisRoundTrips();
  const reads = trips.filter(t => t.length === 1 && ['LRANGE', 'ZREVRANGEBYSCORE', 'ZRANGE'].includes(t[0]));
  assert.equal(reads.length, 0, \`\${reads.length} Redis read(s) were sent outside a pipeline (\${JSON.stringify(reads.flat())}): queue the LRANGE and every ZREVRANGEBYSCORE on one pipeline\`);
  const pipelines = trips.filter(t => t.length > 1);
  assert.equal(pipelines.length, 1, \`a page must cost one round trip: observed \${pipelines.length} pipeline exec(s)\`);
  assert.equal(pipelines[0].length, 3, \`the pipeline must carry the LRANGE and one ZREVRANGEBYSCORE per celebrity (3 commands for 2 celebrities), got \${pipelines[0].length}\`);
}

export async function check_merged(ctx) {
  push(ctx, 'alice', pid(100), pid(300), pid(500));
  pull(ctx, 'taylor', pid(200, 't'), pid(400, 't'), pid(600, 't'));
  pull(ctx, 'nasa', pid(500)); // the same post also arrived through fan-out
  const m = reader(ctx, {alice: ['taylor', 'nasa']});
  let [page, nextCursor] = await m.read('alice', null, 4);
  assert.deepEqual(page, [pid(600, 't'), pid(500), pid(400, 't'), pid(300)], \`pushed and pulled ids must be merged newest first and cut to limit, got \${JSON.stringify(page)}\`);
  assert.equal(nextCursor, 300, \`next_cursor must be 300, got \${JSON.stringify(nextCursor)}\`);
  [page] = await m.read('alice', null, 10);
  assert.equal(page.filter(id => id === pid(500)).length, 1, \`an id present in both sources must appear once, got \${JSON.stringify(page)}\`);
  assert.deepEqual(page, [pid(600, 't'), pid(500), pid(400, 't'), pid(300), pid(200, 't'), pid(100)], \`the full merge must be every distinct id newest first, got \${JSON.stringify(page)}\`);
}

export async function check_cursor(ctx) {
  push(ctx, 'alice', ...Array.from({length: 10}, (_, i) => pid(100 + 2 * i))); // 100, 102, ..., 118; LRANGE 0 5 sees 118..108
  pull(ctx, 'taylor', pid(109, 't'), pid(113, 't'), pid(115, 't'), pid(121, 't'));
  const m = reader(ctx, {alice: ['taylor']});
  let [page, nextCursor] = await m.read('alice', 115, 3);
  assert.deepEqual(page, [pid(114), pid(113, 't'), pid(112)], \`with cursor 115 only ids created before 115 may appear (the bound is exclusive, from both sources), got \${JSON.stringify(page)}\`);
  assert.equal(nextCursor, 112, \`next_cursor must be 112, got \${JSON.stringify(nextCursor)}\`);
  [page, nextCursor] = await m.read('alice', nextCursor, 3);
  assert.deepEqual(page, [pid(110), pid(109, 't'), pid(108)], \`the next page must continue below the cursor without overlap, got \${JSON.stringify(page)}\`);
  assert.equal(nextCursor, 108, \`next_cursor must be 108, got \${JSON.stringify(nextCursor)}\`);
  [page, nextCursor] = await m.read('alice', 100, 3);
  assert.deepEqual(page, [], \`nothing is older than 100: expected an empty page, got \${JSON.stringify(page)}\`);
  assert.equal(nextCursor, null, \`an empty page has no next_cursor, got \${JSON.stringify(nextCursor)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"leetbuild/harness"

	"feed/graph"
)

// postIDAt is a post id carrying its timestamp: "<created_at ms>-<tag>" (ids.CreatedAt parses the prefix).
func postIDAt(ms int, tag string) string { return fmt.Sprintf("%d-%s", ms, tag) }

// pushIDs are fan-out writes: ids given oldest first end up newest first in the list.
func pushIDs(ctx *harness.Ctx, user string, ids ...string) {
	for _, id := range ids {
		ctx.Redis.Do("LPUSH", "timeline:"+user, id)
	}
}

func pullIDs(ctx *harness.Ctx, author string, ids ...string) {
	for _, id := range ids {
		prefix, _, _ := strings.Cut(id, "-")
		ms, _ := strconv.Atoi(prefix)
		ctx.Redis.Do("ZADD", "posts:"+author, ms, id)
	}
}

func readTimeline(ctx *harness.Ctx, userID string, cursor *int64, limit int) ([]string, *int64) {
	page, next, err := Read(context.Background(), userID, cursor, limit)
	ctx.NoError(err, "Read(%q, %v, %d) returned an error", userID, cursorValue(cursor), limit)
	return page, next
}

// cursorValue is the cursor a pointer holds, nil for none.
func cursorValue(cursor *int64) any {
	if cursor == nil {
		return nil
	}
	return *cursor
}

func cursorAt(ms int64) *int64 { return &ms }

func CheckPushed(ctx *harness.Ctx) {
	var ids []string
	for i := range 10 {
		ids = append(ids, postIDAt(100+i, "a"))
	}
	pushIDs(ctx, "alice", ids...)
	page, next := readTimeline(ctx, "alice", nil, 3)
	ctx.Equal(page, []string{postIDAt(109, "a"), postIDAt(108, "a"), postIDAt(107, "a")}, "with 10 pushed ids and limit 3 the page must be the 3 newest")
	ctx.Equal(cursorValue(next), 107, "the next cursor must be the created_at of the last id of the page (107)")
	page, _ = readTimeline(ctx, "alice", nil, 20)
	var newestFirst []string
	for i := len(ids) - 1; i >= 0; i-- {
		newestFirst = append(newestFirst, ids[i])
	}
	ctx.Equal(page, newestFirst, "with limit 20 every pushed id must be returned newest first")
}

func CheckPulled(ctx *harness.Ctx) {
	var taylor []string
	for i := range 5 {
		taylor = append(taylor, postIDAt(200+i, "t"))
	}
	nasa := []string{postIDAt(150, "n"), postIDAt(151, "n")}
	pullIDs(ctx, "taylor", taylor...)
	pullIDs(ctx, "nasa", nasa...)
	graph.CelebritiesFollowedBy["alice"] = []string{"taylor", "nasa"}
	page, next := readTimeline(ctx, "alice", nil, 4)
	ctx.Equal(page, []string{postIDAt(204, "t"), postIDAt(203, "t"), postIDAt(202, "t"), postIDAt(201, "t")}, "nothing was pushed: the page must be the 4 newest celebrity posts")
	ctx.Equal(cursorValue(next), 201, "the next cursor")
	page, _ = readTimeline(ctx, "alice", nil, 10)
	want := []string{taylor[4], taylor[3], taylor[2], taylor[1], taylor[0], nasa[1], nasa[0]}
	ctx.Equal(page, want, "every post of every followed celebrity must be pulled, newest first")
	page, _ = readTimeline(ctx, "bob", nil, 10)
	ctx.Assert(len(page) == 0, "bob follows no celebrity and has no timeline: expected an empty page, got %q", page)
}

func CheckSinglePipeline(ctx *harness.Ctx) {
	pushIDs(ctx, "alice", postIDAt(100, "a"), postIDAt(300, "a"))
	pullIDs(ctx, "taylor", postIDAt(200, "t"))
	pullIDs(ctx, "nasa", postIDAt(400, "n"))
	graph.CelebritiesFollowedBy["alice"] = []string{"taylor", "nasa"}
	page, _ := readTimeline(ctx, "alice", nil, 10)
	ctx.Equal(page, []string{postIDAt(400, "n"), postIDAt(300, "a"), postIDAt(200, "t"), postIDAt(100, "a")}, "unexpected page")
	var reads []string
	var pipelines [][]string
	for _, trip := range ctx.Redis.RoundTrips() {
		if len(trip) > 1 {
			pipelines = append(pipelines, trip)
		} else if len(trip) == 1 && (trip[0] == "LRANGE" || trip[0] == "ZREVRANGEBYSCORE" || trip[0] == "ZRANGE") {
			reads = append(reads, trip[0])
		}
	}
	ctx.Assert(len(reads) == 0, "%d Redis read(s) were sent outside a pipeline (%v): queue the LRange and every ZRevRangeByScore on one pipeline", len(reads), reads)
	ctx.Equal(len(pipelines), 1, "a page must cost one round trip: pipeline Execs observed")
	ctx.Equal(len(pipelines[0]), 3, "the pipeline must carry the LRange and one ZRevRangeByScore per celebrity (3 commands for 2 celebrities)")
}

func CheckMerged(ctx *harness.Ctx) {
	pushIDs(ctx, "alice", postIDAt(100, "a"), postIDAt(300, "a"), postIDAt(500, "a"))
	pullIDs(ctx, "taylor", postIDAt(200, "t"), postIDAt(400, "t"), postIDAt(600, "t"))
	pullIDs(ctx, "nasa", postIDAt(500, "a")) // the same post also arrived through fan-out
	graph.CelebritiesFollowedBy["alice"] = []string{"taylor", "nasa"}
	page, next := readTimeline(ctx, "alice", nil, 4)
	ctx.Equal(page, []string{postIDAt(600, "t"), postIDAt(500, "a"), postIDAt(400, "t"), postIDAt(300, "a")}, "pushed and pulled ids must be merged newest first and cut to limit")
	ctx.Equal(cursorValue(next), 300, "the next cursor")
	page, _ = readTimeline(ctx, "alice", nil, 10)
	copies := 0
	for _, id := range page {
		if id == postIDAt(500, "a") {
			copies++
		}
	}
	ctx.Assert(copies == 1, "an id present in both sources must appear once, got %q", page)
	ctx.Equal(page, []string{postIDAt(600, "t"), postIDAt(500, "a"), postIDAt(400, "t"), postIDAt(300, "a"), postIDAt(200, "t"), postIDAt(100, "a")}, "the full merge must be every distinct id newest first")
}

func CheckCursor(ctx *harness.Ctx) {
	for i := range 10 {
		pushIDs(ctx, "alice", postIDAt(100+2*i, "a")) // 100, 102, ..., 118; LRANGE 0 5 sees 118..108
	}
	pullIDs(ctx, "taylor", postIDAt(109, "t"), postIDAt(113, "t"), postIDAt(115, "t"), postIDAt(121, "t"))
	graph.CelebritiesFollowedBy["alice"] = []string{"taylor"}
	page, next := readTimeline(ctx, "alice", cursorAt(115), 3)
	ctx.Equal(page, []string{postIDAt(114, "a"), postIDAt(113, "t"), postIDAt(112, "a")}, "with cursor 115 only ids created before 115 may appear (the bound is exclusive, from both sources)")
	ctx.Equal(cursorValue(next), 112, "the next cursor")
	page, next = readTimeline(ctx, "alice", next, 3)
	ctx.Equal(page, []string{postIDAt(110, "a"), postIDAt(109, "t"), postIDAt(108, "a")}, "the next page must continue below the cursor without overlap")
	ctx.Equal(cursorValue(next), 108, "the next cursor")
	page, next = readTimeline(ctx, "alice", cursorAt(100), 3)
	ctx.Assert(len(page) == 0, "nothing is older than 100: expected an empty page, got %q", page)
	ctx.Equal(cursorValue(next), nil, "an empty page has no next cursor")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <optional>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace {

// postIDAt is a post id carrying its timestamp: "<created_at ms>-<tag>" (ids::created_at parses the prefix).
std::string postIDAt(int ms, const std::string& tag) { return std::to_string(ms) + "-" + tag; }

// pushIDs are fan-out writes: ids given oldest first end up newest first in the list.
void pushIDs(harness::Ctx& ctx, const std::string& user, const std::vector<std::string>& ids) {
  for (const auto& id : ids) ctx.Redis.Do("LPUSH", "timeline:" + user, id);
}

void pullIDs(harness::Ctx& ctx, const std::string& author, const std::vector<std::string>& ids) {
  for (const auto& id : ids) ctx.Redis.Do("ZADD", "posts:" + author, id.substr(0, id.find('-')), id);
}

// readTimeline is the learner's read; what it throws fails the check (Go's ctx.NoError on the error).
std::pair<std::vector<std::string>, std::optional<int64_t>> readTimeline(harness::Ctx& ctx, const std::string& user,
                                                                         std::optional<int64_t> cursor, int limit) {
  try {
    Page page = read(user, cursor, limit);
    return {page.items, page.next_cursor};
  } catch (const std::exception& e) {
    ctx.Fatalf("read(%q, %v, %d) threw: %s", user, cursor, limit, e.what());
  }
}

}  // namespace

void CheckPushed(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (int i = 0; i < 10; i++) ids.push_back(postIDAt(100 + i, "a"));
  pushIDs(ctx, "alice", ids);
  auto [page, next] = readTimeline(ctx, "alice", std::nullopt, 3);
  ctx.Equal(page, {postIDAt(109, "a"), postIDAt(108, "a"), postIDAt(107, "a")}, "with 10 pushed ids and limit 3 the page must be the 3 newest");
  ctx.Equal(next, 107, "the next cursor must be the created_at of the last id of the page (107)");
  page = readTimeline(ctx, "alice", std::nullopt, 20).first;
  const std::vector<std::string> newestFirst(ids.rbegin(), ids.rend());
  ctx.Equal(page, newestFirst, "with limit 20 every pushed id must be returned newest first");
}

void CheckPulled(harness::Ctx& ctx) {
  std::vector<std::string> taylor;
  for (int i = 0; i < 5; i++) taylor.push_back(postIDAt(200 + i, "t"));
  const std::vector<std::string> nasa = {postIDAt(150, "n"), postIDAt(151, "n")};
  pullIDs(ctx, "taylor", taylor);
  pullIDs(ctx, "nasa", nasa);
  graph::celebrities_followed_by["alice"] = {"taylor", "nasa"};
  auto [page, next] = readTimeline(ctx, "alice", std::nullopt, 4);
  ctx.Equal(page, {postIDAt(204, "t"), postIDAt(203, "t"), postIDAt(202, "t"), postIDAt(201, "t")}, "nothing was pushed: the page must be the 4 newest celebrity posts");
  ctx.Equal(next, 201, "the next cursor");
  page = readTimeline(ctx, "alice", std::nullopt, 10).first;
  ctx.Equal(page, {taylor[4], taylor[3], taylor[2], taylor[1], taylor[0], nasa[1], nasa[0]}, "every post of every followed celebrity must be pulled, newest first");
  page = readTimeline(ctx, "bob", std::nullopt, 10).first;
  ctx.Assert(page.empty(), "bob follows no celebrity and has no timeline: expected an empty page, got %q", page);
}

void CheckSinglePipeline(harness::Ctx& ctx) {
  pushIDs(ctx, "alice", {postIDAt(100, "a"), postIDAt(300, "a")});
  pullIDs(ctx, "taylor", {postIDAt(200, "t")});
  pullIDs(ctx, "nasa", {postIDAt(400, "n")});
  graph::celebrities_followed_by["alice"] = {"taylor", "nasa"};
  const auto page = readTimeline(ctx, "alice", std::nullopt, 10).first;
  ctx.Equal(page, {postIDAt(400, "n"), postIDAt(300, "a"), postIDAt(200, "t"), postIDAt(100, "a")}, "unexpected page");
  std::vector<std::string> reads;
  std::vector<std::vector<std::string>> pipelines;
  for (const auto& trip : ctx.Redis.RoundTrips()) {
    if (trip.size() > 1) pipelines.push_back(trip);
    else if (trip.size() == 1 && (trip[0] == "LRANGE" || trip[0] == "ZREVRANGEBYSCORE" || trip[0] == "ZRANGE")) reads.push_back(trip[0]);
  }
  ctx.Assert(reads.empty(), "%d Redis read(s) were sent outside a pipeline (%v): queue the lrange and every zrevrangebyscore on one pipeline", reads.size(), reads);
  ctx.Equal(pipelines.size(), 1, "a page must cost one round trip: pipeline execs observed");
  ctx.Equal(pipelines[0].size(), 3, "the pipeline must carry the lrange and one zrevrangebyscore per celebrity (3 commands for 2 celebrities)");
}

void CheckMerged(harness::Ctx& ctx) {
  pushIDs(ctx, "alice", {postIDAt(100, "a"), postIDAt(300, "a"), postIDAt(500, "a")});
  pullIDs(ctx, "taylor", {postIDAt(200, "t"), postIDAt(400, "t"), postIDAt(600, "t")});
  pullIDs(ctx, "nasa", {postIDAt(500, "a")});  // the same post also arrived through fan-out
  graph::celebrities_followed_by["alice"] = {"taylor", "nasa"};
  auto [page, next] = readTimeline(ctx, "alice", std::nullopt, 4);
  ctx.Equal(page, {postIDAt(600, "t"), postIDAt(500, "a"), postIDAt(400, "t"), postIDAt(300, "a")}, "pushed and pulled ids must be merged newest first and cut to limit");
  ctx.Equal(next, 300, "the next cursor");
  page = readTimeline(ctx, "alice", std::nullopt, 10).first;
  int copies = 0;
  for (const auto& id : page)
    if (id == postIDAt(500, "a")) copies++;
  ctx.Assert(copies == 1, "an id present in both sources must appear once, got %q", page);
  ctx.Equal(page, {postIDAt(600, "t"), postIDAt(500, "a"), postIDAt(400, "t"), postIDAt(300, "a"), postIDAt(200, "t"), postIDAt(100, "a")}, "the full merge must be every distinct id newest first");
}

void CheckCursor(harness::Ctx& ctx) {
  for (int i = 0; i < 10; i++) pushIDs(ctx, "alice", {postIDAt(100 + 2 * i, "a")});  // 100, 102, ..., 118; LRANGE 0 5 sees 118..108
  pullIDs(ctx, "taylor", {postIDAt(109, "t"), postIDAt(113, "t"), postIDAt(115, "t"), postIDAt(121, "t")});
  graph::celebrities_followed_by["alice"] = {"taylor"};
  auto [page, next] = readTimeline(ctx, "alice", int64_t{115}, 3);
  ctx.Equal(page, {postIDAt(114, "a"), postIDAt(113, "t"), postIDAt(112, "a")}, "with cursor 115 only ids created before 115 may appear (the bound is exclusive, from both sources)");
  ctx.Equal(next, 112, "the next cursor");
  std::tie(page, next) = readTimeline(ctx, "alice", next, 3);
  ctx.Equal(page, {postIDAt(110, "a"), postIDAt(109, "t"), postIDAt(108, "a")}, "the next page must continue below the cursor without overlap");
  ctx.Equal(next, 108, "the next cursor");
  std::tie(page, next) = readTimeline(ctx, "alice", int64_t{100}, 3);
  ctx.Assert(page.empty(), "nothing is older than 100: expected an empty page, got %q", page);
  ctx.Equal(next, nullptr, "an empty page has no next cursor");
}
`,
  },
  debrief: `The read is where the hybrid pays off: one pipeline, a handful of replies, a sort of at most a few dozen ids — regardless of how many followers the celebrities have. Both sources answer the same question ("posts older than the cursor, newest first") and the merge hides which one each id came from. The honest limitation: a plain list cannot seek by time, so deep pagination over the pushed ids degrades — real feeds keep the timeline itself as a sorted set scored by \`created_at\` (or a time-sortable id such as a Snowflake), apply ranking after this candidate step, and cache the hydrated first page per user for a few seconds.`,
};
