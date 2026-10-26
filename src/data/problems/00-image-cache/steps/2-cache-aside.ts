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
        typescript: {all: [/`thumb:\$\{imageId\}:\$\{width\}`/]},
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
        typescript: {order: [/\bredis\.get(Buffer)?\(\s*key\s*\)/, /render\(/]},
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
        typescript: {
          all: [/\.set\(\s*key\s*,\s*data[^\n]*['"]EX['"]\s*,\s*TTL_S\s*\)|\.setex\(\s*key\s*,\s*TTL_S\s*,\s*data/],
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
        typescript: {
          all: [
            /\.set\(\s*key\s*,\s*MISSING\s*,\s*['"]EX['"]\s*,\s*MISSING_TTL_S\s*\)|\.setex\(\s*key\s*,\s*MISSING_TTL_S\s*,\s*MISSING\s*\)/,
            /===?\s*MISSING/,
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
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 86400;
export const MISSING_TTL_S = 60;
export const MISSING = '__missing__';

/** The resizer (built in step 4): the JPEG bytes, or null when the origin has no such image. */
export const resizer = {
  async render(imageId: string, width: number): Promise<Buffer | null> {
    throw new Error('not implemented');
  },
};

/** Thumbnails are bytes: read them with getBuffer, never as a UTF-8 string. */
export async function getThumb(imageId: string, width: number): Promise<Buffer | null> {
  const key = ''; // TODO: thumb:{id}:{width}
  // TODO: GET first; a hit returns the bytes (or null when it is the MISSING sentinel)
  // TODO: miss → resizer.render(); null → SET MISSING with MISSING_TTL_S; bytes → SET with TTL_S
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 86400;
export const MISSING_TTL_S = 60;
export const MISSING = '__missing__';

/** The resizer (built in step 4): the JPEG bytes, or null when the origin has no such image. */
export const resizer = {
  async render(imageId: string, width: number): Promise<Buffer | null> {
    throw new Error('not implemented');
  },
};

/** Thumbnails are bytes: read them with getBuffer, never as a UTF-8 string. */
export async function getThumb(imageId: string, width: number): Promise<Buffer | null> {
  const key = \`thumb:\${imageId}:\${width}\`;
  const cached = await redis.getBuffer(key);
  if (cached !== null) return cached.toString() === MISSING ? null : cached;
  const data = await resizer.render(imageId, width);
  if (data === null) {
    await redis.set(key, MISSING, 'EX', MISSING_TTL_S);
    return null;
  }
  await redis.set(key, data, 'EX', TTL_S);
  return data;
}
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
var render = func(ctx context.Context, id string, width int) ([]byte, error) {
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
var render = func(ctx context.Context, id string, width int) ([]byte, error) {
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
  harness: {
    python: `def _cache(ctx, calls):
    m = ctx.load("thumb_cache")

    def render(image_id, width):
        calls.append((image_id, width))
        return b"JPEG-" + image_id.encode() if image_id == "cat" else None

    m.render = render
    return m


def check_key(ctx):
    m = _cache(ctx, [])
    assert m.get_thumb("cat", 256) == b"JPEG-cat", "a miss must return the rendered bytes"
    assert ctx.redis.exists("thumb:cat:256"), "after a miss the bytes must be stored under thumb:cat:256"
    assert ctx.redis_bytes.get("thumb:cat:256") == b"JPEG-cat", "the cached value must be the rendered bytes"
    m.get_thumb("cat", 64)
    assert ctx.redis.exists("thumb:cat:64"), "every width is its own entry: thumb:cat:64"


def check_read_first(ctx):
    calls = []
    m = _cache(ctx, calls)
    ctx.redis_bytes.set("thumb:cat:256", b"CACHED")
    assert m.get_thumb("cat", 256) == b"CACHED", "a hit must return the cached bytes"
    assert calls == [], "render() must not run on a hit"
    assert m.get_thumb("cat", 128) == b"JPEG-cat"
    assert calls == [("cat", 128)], "a miss renders exactly once"


def check_ttl(ctx):
    m = _cache(ctx, [])
    m.get_thumb("cat", 256)
    ttl = ctx.redis.ttl("thumb:cat:256")
    assert 86000 <= ttl <= 86400, f"expected a TTL of 86400 s on thumb:cat:256, got {ttl}"
    ctx.clock.advance(86401)
    assert ctx.redis.get("thumb:cat:256") is None, "the entry must be gone once the TTL passes"


def check_negative(ctx):
    calls = []
    m = _cache(ctx, calls)
    assert m.get_thumb("ghost", 256) is None, "a missing image returns nothing"
    assert m.get_thumb("ghost", 256) is None, "a missing image still returns nothing on the second call"
    assert len(calls) == 1, f"render ran {len(calls)} times for a missing image; the second call must hit the negative cache"
    ttl = ctx.redis.ttl("thumb:ghost:256")
    assert 0 < ttl <= 60, f"the negative entry must expire within 60 s, got TTL {ttl}"
    ctx.clock.advance(61)
    m.get_thumb("ghost", 256)
    assert len(calls) == 2, "once the sentinel expires the image is rendered again"
`,
    typescript: `/** Fake JPEG bytes: the real SOI marker (FF D8 FF, not valid UTF-8) and a label. */
const jpeg = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(label)]);
const hex = (b: Buffer | null) => (b === null ? 'null' : b.toString('hex'));

/** The resizer (step 4): knows cat, records every call. Swapped onto the learner's provided resizer object. */
function cache(ctx, calls: [string, number][]) {
  const m = ctx.load('thumb_cache');
  m.resizer.render = async (imageId: string, width: number) => {
    calls.push([imageId, width]);
    return imageId === 'cat' ? jpeg(\`JPEG-\${imageId}\`) : null;
  };
  return m;
}

export async function check_key(ctx) {
  const m = cache(ctx, []);
  const got = await m.getThumb('cat', 256);
  assert(got !== null && jpeg('JPEG-cat').equals(got), \`a miss must return the rendered bytes: got \${hex(got)}, expected \${hex(jpeg('JPEG-cat'))}\`);
  assert(ctx.redis.exists('thumb:cat:256'), \`after a miss the bytes must be stored under thumb:cat:256, keys are \${JSON.stringify(ctx.redis.keys('*'))}\`);
  const stored = ctx.redis.getBuffer('thumb:cat:256');
  assert(jpeg('JPEG-cat').equals(stored), \`the cached value must be the rendered bytes, verbatim: stored \${hex(stored)}, expected \${hex(jpeg('JPEG-cat'))}\`);
  await m.getThumb('cat', 64);
  assert(ctx.redis.exists('thumb:cat:64'), 'every width is its own entry: thumb:cat:64');
}

export async function check_read_first(ctx) {
  const calls: [string, number][] = [];
  const m = cache(ctx, calls);
  ctx.redis.set('thumb:cat:256', jpeg('CACHED'));
  const hit = await m.getThumb('cat', 256);
  assert(hit !== null && jpeg('CACHED').equals(hit), \`a hit must return the cached bytes verbatim (read them as bytes, not as a UTF-8 string): got \${hex(hit)}, expected \${hex(jpeg('CACHED'))}\`);
  assert.deepEqual(calls, [], 'render() must not run on a hit');
  const miss = await m.getThumb('cat', 128);
  assert(miss !== null && jpeg('JPEG-cat').equals(miss));
  assert.deepEqual(calls, [['cat', 128]], 'a miss renders exactly once');
}

export async function check_ttl(ctx) {
  const m = cache(ctx, []);
  await m.getThumb('cat', 256);
  const ttl = ctx.redis.ttl('thumb:cat:256');
  assert(86000 <= ttl && ttl <= 86400, \`expected a TTL of 86400 s on thumb:cat:256, got \${ttl}\`);
  ctx.clock.advance(86401);
  assert.equal(ctx.redis.get('thumb:cat:256'), null, 'the entry must be gone once the TTL passes');
}

export async function check_negative(ctx) {
  const calls: [string, number][] = [];
  const m = cache(ctx, calls);
  assert.equal(await m.getThumb('ghost', 256), null, 'a missing image returns nothing');
  assert.equal(await m.getThumb('ghost', 256), null, 'a missing image still returns nothing on the second call');
  assert.equal(calls.length, 1, \`render ran \${calls.length} times for a missing image; the second call must hit the negative cache\`);
  const ttl = ctx.redis.ttl('thumb:ghost:256');
  assert(0 < ttl && ttl <= 60, \`the negative entry must expire within 60 s, got TTL \${ttl}\`);
  ctx.clock.advance(61);
  await m.getThumb('ghost', 256);
  assert.equal(calls.length, 2, 'once the sentinel expires the image is rendered again');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/hex"

	"leetbuild/harness"
)

var caBg = context.Background()

// caJPEG is fake JPEG bytes: the real SOI marker (FF D8 FF, not valid UTF-8) and a label.
func caJPEG(label string) []byte { return append([]byte{0xff, 0xd8, 0xff}, label...) }

// caHex shows bytes as hex, nil as nil.
func caHex(b []byte) string {
	if b == nil {
		return "nil"
	}
	return hex.EncodeToString(b)
}

// caCall is one render call the stand-in saw.
type caCall struct {
	id    string
	width int
}

// caResizer stands in for render (the resizer, step 4): it knows cat and records every call.
func caResizer() *[]caCall {
	calls := &[]caCall{}
	render = func(_ context.Context, id string, width int) ([]byte, error) {
		*calls = append(*calls, caCall{id, width})
		if id != "cat" {
			return nil, nil
		}
		return caJPEG("JPEG-" + id), nil
	}
	return calls
}

func caGetThumb(ctx *harness.Ctx, id string, width int) []byte {
	data, err := getThumb(caBg, id, width)
	ctx.NoError(err, "getThumb(ctx, %q, %d) returned an error", id, width)
	return data
}

// caStored is the bytes at key, nil when there is no such key.
func caStored(ctx *harness.Ctx, key string) []byte {
	if v, ok := ctx.Redis.Get(key); ok {
		return []byte(v)
	}
	return nil
}

func CheckKey(ctx *harness.Ctx) {
	caResizer()
	got := caGetThumb(ctx, "cat", 256)
	ctx.Assert(got != nil && bytes.Equal(got, caJPEG("JPEG-cat")), "a miss must return the rendered bytes: got %s, expected %s", caHex(got), caHex(caJPEG("JPEG-cat")))
	ctx.Assert(ctx.Redis.Exists("thumb:cat:256") == 1, "after a miss the bytes must be stored under thumb:cat:256, keys are %s", harness.Show(ctx.Redis.Keys("*")))
	stored := caStored(ctx, "thumb:cat:256")
	ctx.Assert(bytes.Equal(stored, caJPEG("JPEG-cat")), "the cached value must be the rendered bytes, verbatim: stored %s, expected %s", caHex(stored), caHex(caJPEG("JPEG-cat")))
	caGetThumb(ctx, "cat", 64)
	ctx.Assert(ctx.Redis.Exists("thumb:cat:64") == 1, "every width is its own entry: thumb:cat:64")
}

func CheckReadFirst(ctx *harness.Ctx) {
	calls := caResizer()
	ctx.Redis.Set("thumb:cat:256", caJPEG("CACHED"))
	hit := caGetThumb(ctx, "cat", 256)
	ctx.Assert(hit != nil && bytes.Equal(hit, caJPEG("CACHED")), "a hit must return the cached bytes verbatim: got %s, expected %s", caHex(hit), caHex(caJPEG("CACHED")))
	ctx.Equal(len(*calls), 0, "render() must not run on a hit")
	miss := caGetThumb(ctx, "cat", 128)
	ctx.Assert(miss != nil && bytes.Equal(miss, caJPEG("JPEG-cat")), "a miss must return the rendered bytes: got %s, expected %s", caHex(miss), caHex(caJPEG("JPEG-cat")))
	ctx.Equal(*calls, []caCall{{"cat", 128}}, "a miss renders exactly once")
}

func CheckTtl(ctx *harness.Ctx) {
	caResizer()
	caGetThumb(ctx, "cat", 256)
	ttl := ctx.Redis.TTL("thumb:cat:256")
	ctx.Assert(86000 <= ttl && ttl <= 86400, "expected a TTL of 86400 s on thumb:cat:256, got %d", ttl)
	ctx.Clock.Advance(86401)
	ctx.Assert(caStored(ctx, "thumb:cat:256") == nil, "the entry must be gone once the TTL passes")
}

func CheckNegative(ctx *harness.Ctx) {
	calls := caResizer()
	ctx.Assert(caGetThumb(ctx, "ghost", 256) == nil, "a missing image returns nothing")
	ctx.Assert(caGetThumb(ctx, "ghost", 256) == nil, "a missing image still returns nothing on the second call")
	ctx.Equal(len(*calls), 1, "render calls for a missing image: the second call must hit the negative cache")
	ttl := ctx.Redis.TTL("thumb:ghost:256")
	ctx.Assert(0 < ttl && ttl <= 60, "the negative entry must expire within 60 s, got TTL %d", ttl)
	ctx.Clock.Advance(61)
	caGetThumb(ctx, "ghost", 256)
	ctx.Equal(len(*calls), 2, "once the sentinel expires the image is rendered again")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

// caJPEG is fake JPEG bytes: the real SOI marker (FF D8 FF, not valid UTF-8) and a label.
std::string caJPEG(const std::string& label) { return "\\xff\\xd8\\xff" + label; }

// caHex shows bytes as hex, nullopt as nil.
std::string caHex(const std::optional<std::string>& b) {
  if (!b) return "nil";
  static const char* digits = "0123456789abcdef";
  std::string out;
  for (unsigned char c : *b) {
    out += digits[c >> 4];
    out += digits[c & 15];
  }
  return out;
}

// One render call the stand-in saw: (id, width).
using CaCall = std::pair<std::string, int>;
std::vector<CaCall> caCalls;

// caResizer stands in for render (the resizer, step 4): it knows cat and records every call.
std::vector<CaCall>& caResizer() {
  caCalls.clear();
  return caCalls;
}

// get_thumb, failing the check when it throws (Go's ctx.NoError on the returned error).
std::optional<std::string> caGetThumb(harness::Ctx& ctx, const std::string& id, int width) {
  try {
    return get_thumb(id, width);
  } catch (const std::exception& e) {
    ctx.Fatalf("get_thumb(%q, %d) threw: %s", id, width, e.what());
  }
}

}  // namespace

// The resizer of step 4, stood in for (Go swaps the render variable instead).
std::optional<std::string> render(const std::string& id, int width) {
  caCalls.push_back({id, width});
  if (id != "cat") return std::nullopt;
  return caJPEG("JPEG-" + id);
}

void CheckKey(harness::Ctx& ctx) {
  caResizer();
  const auto got = caGetThumb(ctx, "cat", 256);
  ctx.Assert(got == caJPEG("JPEG-cat"), "a miss must return the rendered bytes: got %s, expected %s", caHex(got),
             caHex(caJPEG("JPEG-cat")));
  ctx.Assert(ctx.Redis.Exists("thumb:cat:256") == 1, "after a miss the bytes must be stored under thumb:cat:256, keys are %q",
             ctx.Redis.Keys("*"));
  const auto stored = ctx.Redis.Get("thumb:cat:256");
  ctx.Assert(stored == caJPEG("JPEG-cat"), "the cached value must be the rendered bytes, verbatim: stored %s, expected %s",
             caHex(stored), caHex(caJPEG("JPEG-cat")));
  caGetThumb(ctx, "cat", 64);
  ctx.Assert(ctx.Redis.Exists("thumb:cat:64") == 1, "every width is its own entry: thumb:cat:64");
}

void CheckReadFirst(harness::Ctx& ctx) {
  auto& calls = caResizer();
  ctx.Redis.Set("thumb:cat:256", caJPEG("CACHED"));
  const auto hit = caGetThumb(ctx, "cat", 256);
  ctx.Assert(hit == caJPEG("CACHED"), "a hit must return the cached bytes verbatim: got %s, expected %s", caHex(hit),
             caHex(caJPEG("CACHED")));
  ctx.Equal(calls.size(), 0, "render() must not run on a hit");
  const auto miss = caGetThumb(ctx, "cat", 128);
  ctx.Assert(miss == caJPEG("JPEG-cat"), "a miss must return the rendered bytes: got %s, expected %s", caHex(miss),
             caHex(caJPEG("JPEG-cat")));
  ctx.Equal(calls, std::vector<CaCall>{{"cat", 128}}, "a miss renders exactly once");
}

void CheckTtl(harness::Ctx& ctx) {
  caResizer();
  caGetThumb(ctx, "cat", 256);
  const long long ttl = ctx.Redis.TTL("thumb:cat:256");
  ctx.Assert(86000 <= ttl && ttl <= 86400, "expected a TTL of 86400 s on thumb:cat:256, got %d", ttl);
  ctx.Clock.Advance(86401);
  ctx.Assert(!ctx.Redis.Get("thumb:cat:256"), "the entry must be gone once the TTL passes");
}

void CheckNegative(harness::Ctx& ctx) {
  auto& calls = caResizer();
  ctx.Assert(!caGetThumb(ctx, "ghost", 256), "a missing image returns nothing");
  ctx.Assert(!caGetThumb(ctx, "ghost", 256), "a missing image still returns nothing on the second call");
  ctx.Equal(calls.size(), 1, "render calls for a missing image: the second call must hit the negative cache");
  const long long ttl = ctx.Redis.TTL("thumb:ghost:256");
  ctx.Assert(0 < ttl && ttl <= 60, "the negative entry must expire within 60 s, got TTL %d", ttl);
  ctx.Clock.Advance(61);
  caGetThumb(ctx, "ghost", 256);
  ctx.Equal(calls.size(), 2, "once the sentinel expires the image is rendered again");
}
`,
  },
  debrief: `Cache-aside keeps the cache a pure optimisation: if Redis is flushed the service still works, only slower. The TTL bounds staleness and memory; the sentinel turns a class of expensive repeated misses into cheap hits. Real caches add jittered TTLs so entries written together do not expire together, and size limits with an eviction policy (\`allkeys-lru\`).`,
};
