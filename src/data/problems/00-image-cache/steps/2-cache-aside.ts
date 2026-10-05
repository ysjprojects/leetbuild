import type {Step} from '@/lib/types';

export const cacheAsideStep: Step = {
  id: 'cache-aside',
  title: 'Cache-aside with a TTL and negative caching',
  concept: 'redis',
  file: 'thumb_cache',
  focus: ['thumbs', 'redis'],
  task: `## Task

Implement \`get_thumb(id, width)\` as a **cache-aside** lookup in Redis. \`render(id, width)\` is provided
(you build it in step 4): it produces the JPEG bytes, or nothing when the origin has no such image.

- The key is \`thumb:{id}:{width}\` — one entry per rendered size.
- Read the cache first. On a hit, return the bytes.
- On a miss, render, store the result with a **TTL of 86400 s**, and return it.
- When the origin has no such image, store a short-lived sentinel (**60 s**) so repeated requests for a
  missing image do not hit the resizer every time (**negative caching**), and return nothing.

:::widget cache-aside {}`,
  sequence: {
    participants: ['thumbs', 'Redis', 'render'],
    messages: [
      {from: 'thumbs', to: 'Redis', label: 'GET thumb:cat:256', kind: 'sync'},
      {from: 'Redis', to: 'thumbs', label: '(nil)', kind: 'reply'},
      {from: 'thumbs', to: 'render', label: 'render(cat, 256)', kind: 'sync'},
      {from: 'render', to: 'thumbs', label: 'jpeg bytes', kind: 'reply'},
      {from: 'thumbs', to: 'Redis', label: 'SET thumb:cat:256 <bytes> EX 86400', kind: 'sync'},
      {from: 'thumbs', to: 'Redis', label: 'GET thumb:cat:256 → hit', kind: 'sync'},
    ],
  },
  hints: [
    'Three branches: hit, miss-and-rendered, miss-and-missing. Write the hit branch first; it is the one that runs 99% of the time.',
    'The negative-cache sentinel is just another cached value; on a hit, check whether the value is the sentinel before returning it.',
    'Both writes go through the same SET with an expiry — only the value and the TTL differ (86400 s for images, 60 s for the sentinel).',
  ],
  checks: [
    {
      id: 'key',
      title: 'Cache key names the image and the width',
      detail: 'Use `thumb:{id}:{width}` so every rendered size is its own entry.',
      match: {
        python: {all: [/f["']thumb:\{image_id\}:\{width\}["']/]},
        go: {all: [/"thumb:%s:%d"/]},
        scala: {all: [/s"thumb:\$\{?id\}?:\$\{?width\}?"/]},
        cpp: {all: [/"thumb:"\s*\+\s*id\s*\+\s*":"\s*\+\s*std::to_string\(\s*width\s*\)/]},
      },
    },
    {
      id: 'read-first',
      title: 'Reads the cache before rendering',
      detail: 'Cache-aside means GET first and only render on a miss.',
      match: {
        python: {order: [/\br\.get\(\s*key\s*\)/, /render\(/]},
        go: {order: [/rdb\.Get\(\s*ctx\s*,\s*key\s*\)/, /render\(/]},
        scala: {order: [/jedis\.get\(\s*key(\.getBytes)?\s*\)/, /render\(/]},
        cpp: {order: [/redis\.get\(\s*key\s*\)/, /render\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Cached thumbnails expire',
      detail: 'Store rendered bytes with an expiry (86400 s); a cache without TTLs only grows.',
      match: {
        python: {
          all: [/\.set\(\s*key\s*,\s*data\s*,\s*ex\s*=\s*TTL_S\s*\)|\.setex\(\s*key\s*,\s*TTL_S\s*,\s*data\s*\)/],
        },
        go: {all: [/rdb\.Set\(\s*ctx\s*,\s*key\s*,\s*data\s*,\s*ttl\s*\)/]},
        scala: {all: [/jedis\.setex\(\s*key\.getBytes[^\n]*TtlSeconds|jedis\.setex\(\s*key\s*,\s*TtlSeconds/]},
        cpp: {all: [/redis\.set\(\s*key\s*,\s*\*?data\s*,\s*kTtl\s*\)|redis\.setex\(\s*key\s*,\s*kTtl/]},
      },
    },
    {
      id: 'negative',
      title: 'Caches misses briefly',
      detail:
        'A missing image is stored as a sentinel with a short TTL (60 s) so the resizer is not asked again and again.',
      match: {
        python: {
          all: [
            /\.set\(\s*key\s*,\s*MISSING\s*,\s*ex\s*=\s*MISSING_TTL_S\s*\)|\.setex\(\s*key\s*,\s*MISSING_TTL_S\s*,\s*MISSING\s*\)/,
            /==\s*MISSING/,
          ],
        },
        go: {all: [/rdb\.Set\(\s*ctx\s*,\s*key\s*,\s*missing\s*,\s*missingTTL\s*\)/, /==\s*missing/]},
        scala: {
          all: [
            /jedis\.setex\([^\n]*MissingTtlSeconds[^\n]*Missing\b|jedis\.setex\([^\n]*Missing\b[^\n]*MissingTtlSeconds/,
            /sameElements\(\s*Missing\s*\)|==\s*Missing/,
          ],
        },
        cpp: {
          all: [
            /redis\.set\(\s*key\s*,\s*kMissing\s*,\s*kMissingTtl\s*\)|redis\.setex\(\s*key\s*,\s*kMissingTtl\s*,\s*kMissing\s*\)/,
            /==\s*kMissing/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379)

TTL_S = 86400
MISSING_TTL_S = 60
MISSING = b"__missing__"


def render(image_id: str, width: int) -> bytes | None:
    """Fetch the original and resize it (built in step 4); None when the origin has no such image."""
    raise NotImplementedError


def get_thumb(image_id: str, width: int) -> bytes | None:
    key = ...  # TODO: thumb:{id}:{width}
    # TODO: GET first; a hit returns the bytes (or None when it is the MISSING sentinel)
    # TODO: miss → render(); None → SET MISSING with MISSING_TTL_S; bytes → SET with TTL_S
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379)

TTL_S = 86400
MISSING_TTL_S = 60
MISSING = b"__missing__"


def render(image_id: str, width: int) -> bytes | None:
    """Fetch the original and resize it (built in step 4); None when the origin has no such image."""
    raise NotImplementedError


def get_thumb(image_id: str, width: int) -> bytes | None:
    key = f"thumb:{image_id}:{width}"
    cached = r.get(key)
    if cached is not None:
        return None if cached == MISSING else cached
    data = render(image_id, width)
    if data is None:
        r.set(key, MISSING, ex=MISSING_TTL_S)
        return None
    r.set(key, data, ex=TTL_S)
    return data
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl        = 24 * time.Hour
	missingTTL = time.Minute
	missing    = "__missing__"
)

// render fetches the original and resizes it (built in step 4); nil, nil when the origin has no such image.
func render(ctx context.Context, id string, width int) ([]byte, error) {
	panic("not implemented")
}

func getThumb(ctx context.Context, id string, width int) ([]byte, error) {
	key := "" // TODO: thumb:{id}:{width}
	// TODO: GET first; a hit returns the bytes (or nil when it is the missing sentinel)
	// TODO: miss → render(); nil → SET missing with missingTTL; bytes → SET with ttl
	_ = key
	_ = fmt.Sprintf
	_ = errors.Is
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl        = 24 * time.Hour
	missingTTL = time.Minute
	missing    = "__missing__"
)

// render fetches the original and resizes it (built in step 4); nil, nil when the origin has no such image.
func render(ctx context.Context, id string, width int) ([]byte, error) {
	panic("not implemented")
}

func getThumb(ctx context.Context, id string, width int) ([]byte, error) {
	key := fmt.Sprintf("thumb:%s:%d", id, width)
	cached, err := rdb.Get(ctx, key).Bytes()
	if err == nil {
		if string(cached) == missing {
			return nil, nil
		}
		return cached, nil
	}
	if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	data, err := render(ctx, id, width)
	if err != nil {
		return nil, err
	}
	if data == nil {
		rdb.Set(ctx, key, missing, missingTTL)
		return nil, nil
	}
	rdb.Set(ctx, key, data, ttl)
	return data, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object ThumbCache {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 86400L
  val MissingTtlSeconds = 60L
  val Missing: Array[Byte] = "__missing__".getBytes

  /** Fetch the original and resize it (built in step 4); None when the origin has no such image. */
  def render(id: String, width: Int): Option[Array[Byte]] = ???

  def getThumb(id: String, width: Int): Option[Array[Byte]] = {
    val key: String = ??? // TODO: thumb:{id}:{width}
    // TODO: GET first; a hit returns the bytes (or None when it is the Missing sentinel)
    // TODO: miss → render(); None → SETEX Missing with MissingTtlSeconds; bytes → SETEX with TtlSeconds
    None
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

object ThumbCache {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 86400L
  val MissingTtlSeconds = 60L
  val Missing: Array[Byte] = "__missing__".getBytes

  /** Fetch the original and resize it (built in step 4); None when the origin has no such image. */
  def render(id: String, width: Int): Option[Array[Byte]] = ???

  def getThumb(id: String, width: Int): Option[Array[Byte]] = {
    val key = s"thumb:$id:$width"
    Option(jedis.get(key.getBytes)) match {
      case Some(cached) => if (cached.sameElements(Missing)) None else Some(cached)
      case None =>
        render(id, width) match {
          case Some(data) =>
            jedis.setex(key.getBytes, TtlSeconds, data)
            Some(data)
          case None =>
            jedis.setex(key.getBytes, MissingTtlSeconds, Missing)
            None
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{86400};
constexpr std::chrono::seconds kMissingTtl{60};
const std::string kMissing = "__missing__";

// Fetch the original and resize it (built in step 4); nullopt when the origin has no such image.
std::optional<std::string> render(const std::string& id, int width);

std::optional<std::string> get_thumb(const std::string& id, int width) {
  const std::string key = "";  // TODO: thumb:{id}:{width}
  // TODO: GET first; a hit returns the bytes (or nullopt when it is the kMissing sentinel)
  // TODO: miss → render(); nullopt → SET kMissing with kMissingTtl; bytes → SET with kTtl
  return std::nullopt;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{86400};
constexpr std::chrono::seconds kMissingTtl{60};
const std::string kMissing = "__missing__";

// Fetch the original and resize it (built in step 4); nullopt when the origin has no such image.
std::optional<std::string> render(const std::string& id, int width);

std::optional<std::string> get_thumb(const std::string& id, int width) {
  const std::string key = "thumb:" + id + ":" + std::to_string(width);
  if (const auto cached = redis.get(key)) {
    if (*cached == kMissing) return std::nullopt;
    return cached;
  }
  const auto data = render(id, width);
  if (!data) {
    redis.set(key, kMissing, kMissingTtl);
    return std::nullopt;
  }
  redis.set(key, *data, kTtl);
  return data;
}
`,
    },
  },
  debrief: `Cache-aside keeps the cache a pure optimisation: if Redis is flushed the service still works, only slower. The TTL bounds staleness and memory; the sentinel turns a class of expensive repeated misses into cheap hits. Real caches add jittered TTLs so entries written together do not expire together, and size limits with an eviction policy (\`allkeys-lru\`).`,
};
