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
  debrief: `The read is where the hybrid pays off: one pipeline, a handful of replies, a sort of at most a few dozen ids — regardless of how many followers the celebrities have. Both sources answer the same question ("posts older than the cursor, newest first") and the merge hides which one each id came from. The honest limitation: a plain list cannot seek by time, so deep pagination over the pushed ids degrades — real feeds keep the timeline itself as a sorted set scored by \`created_at\` (or a time-sortable id such as a Snowflake), apply ranking after this candidate step, and cache the hydrated first page per user for a few seconds.`,
};
