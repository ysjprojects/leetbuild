import type {Step} from '@/lib/types';

export const stampedeStep: Step = {
  id: 'stampede',
  title: 'One render per key: stampede protection',
  concept: 'redis',
  file: 'thumb_fill',
  focus: ['thumbs', 'redis', 'resizer'],
  task: `## Task

When a popular thumbnail expires, hundreds of requests miss at once and would all call the resizer.
Implement \`fill(key, id, width)\`, the miss path, so only **one** request renders:

- Try to take a lock: \`SET lock:{key} 1 NX EX 5\` (\`store(key, data)\` is provided: it writes the value with
  the right TTL, sentinel included).
- If you got the lock: render, store, **release the lock** (DEL), return the bytes.
- Otherwise: poll the cache every 50 ms, up to the lock TTL. When the leader's value appears, return it.
- If the lock TTL passes and nothing appeared (the leader died), render yourself.

:::widget cache-aside {"stampede": true}`,
  sequence: {
    participants: ['req A', 'req B', 'Redis', 'render'],
    messages: [
      {from: 'req A', to: 'Redis', label: 'SET lock:thumb:cat:256 NX EX 5 → OK', kind: 'sync'},
      {from: 'req B', to: 'Redis', label: 'SET lock:… NX → (nil)', kind: 'sync'},
      {from: 'req A', to: 'render', label: 'render(cat, 256)', kind: 'sync'},
      {from: 'req B', to: 'Redis', label: 'GET thumb:cat:256 (poll)', kind: 'sync'},
      {from: 'render', to: 'req A', label: 'bytes', kind: 'reply'},
      {from: 'req A', to: 'Redis', label: 'SET thumb:cat:256 EX 86400 · DEL lock', kind: 'sync'},
      {from: 'Redis', to: 'req B', label: 'bytes (hit)', kind: 'reply'},
    ],
  },
  hints: [
    'The lock is a plain key. `NX` makes the SET succeed for exactly one caller; `EX` guarantees it disappears even if that caller crashes.',
    'Release the lock in a `finally`/`defer`/scope guard so an exception in `render` does not leave followers waiting for the full TTL.',
    'Followers need a deadline: compute `now + lock TTL` once, then loop `sleep → GET` until the value shows up or the deadline passes.',
  ],
  checks: [
    {
      id: 'lock-nx',
      title: 'Takes the lock with SET NX and an expiry',
      detail: '`NX` makes only one caller win; `EX` makes a crashed leader harmless.',
      match: {
        python: {all: [/\.set\([^\n]*nx\s*=\s*True/, /\.set\([^\n]*ex\s*=\s*LOCK_TTL_S/]},
        typescript: {
          all: [/\.set\(\s*lock\s*,[^\n]*['"]NX['"]/, /\.set\(\s*lock\s*,[^\n]*['"]EX['"]\s*,\s*LOCK_TTL_S/],
        },
        go: {all: [/rdb\.SetNX\(\s*ctx\s*,\s*lock\s*,[^\n]*lockTTL\s*\)/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(\s*LockTtlSeconds\s*\)/]},
        cpp: {all: [/redis\.set\(\s*lock\s*,[^\n]*kLockTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/]},
      },
    },
    {
      id: 'release',
      title: 'Releases the lock after storing',
      detail:
        'The winner must `store(key, …)` the rendered value and then DEL the lock — in a `finally`/`defer`/scope guard, so followers stop polling right away even when `render` fails.',
      match: {
        python: {all: [/store\(\s*key\s*,/, /\.delete\(\s*lock\s*\)/]},
        typescript: {all: [/store\(\s*key\s*,/, /\.del\(\s*lock\s*\)/]},
        go: {all: [/store\(\s*ctx\s*,\s*key\s*,/, /rdb\.Del\(\s*ctx\s*,\s*lock\s*\)/]},
        scala: {all: [/store\(\s*key\s*,/, /jedis\.del\(\s*lock\s*\)/]},
        cpp: {all: [/store\(\s*key\s*,/, /redis\.del\(\s*lock\s*\)/]},
      },
    },
    {
      id: 'wait-recheck',
      title: 'Followers wait and re-read the cache',
      detail: 'Callers that did not win the lock sleep briefly and GET the key again instead of rendering.',
      match: {
        python: {all: [/time\.sleep\(/, /\br\.get\(\s*key\s*\)/]},
        typescript: {all: [/\bsleep\(|setTimeout\(/, /\bredis\.get(Buffer)?\(\s*key\s*\)/]},
        go: {all: [/time\.Sleep\(/, /rdb\.Get\(\s*ctx\s*,\s*key\s*\)/]},
        scala: {all: [/Thread\.sleep\(/, /jedis\.get\(\s*key/]},
        cpp: {all: [/sleep_for\(/, /redis\.get\(\s*key\s*\)/]},
      },
    },
    {
      id: 'bounded-wait',
      title: 'Waiting is bounded by the lock TTL',
      detail: 'Compute a deadline from the lock TTL; past it, assume the leader died and render.',
      match: {
        python: {all: [/monotonic\(\)|time\.time\(\)/, /LOCK_TTL_S/]},
        typescript: {all: [/Date\.now\(\)|performance\.now\(\)/, /LOCK_TTL_S/]},
        go: {all: [/time\.Now\(\)|time\.After\(/, /lockTTL/]},
        scala: {all: [/System\.nanoTime\(\)|currentTimeMillis\(\)/, /LockTtlSeconds/]},
        cpp: {all: [/steady_clock::now\(\)/, /kLockTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379)

LOCK_TTL_S = 5
POLL_S = 0.05
MISSING = b"__missing__"


def render(image_id: str, width: int) -> bytes | None:
    """Built in step 4; None when the origin has no such image."""
    raise NotImplementedError


def store(key: str, data: bytes | None) -> None:
    """SET with the right TTL (sentinel when data is None) — from step 2."""
    raise NotImplementedError


def fill(key: str, image_id: str, width: int) -> bytes | None:
    """The miss path: render at most once per key while others wait for the value."""
    lock = f"lock:{key}"
    # TODO: SET lock NX EX LOCK_TTL_S; winner renders, stores, releases the lock
    # TODO: others poll r.get(key) every POLL_S until the lock TTL passes
    # TODO: past the deadline, render anyway
    raise NotImplementedError
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379)

LOCK_TTL_S = 5
POLL_S = 0.05
MISSING = b"__missing__"


def render(image_id: str, width: int) -> bytes | None:
    """Built in step 4; None when the origin has no such image."""
    raise NotImplementedError


def store(key: str, data: bytes | None) -> None:
    """SET with the right TTL (sentinel when data is None) — from step 2."""
    raise NotImplementedError


def fill(key: str, image_id: str, width: int) -> bytes | None:
    """The miss path: render at most once per key while others wait for the value."""
    lock = f"lock:{key}"
    if r.set(lock, b"1", nx=True, ex=LOCK_TTL_S):
        try:
            data = render(image_id, width)
            store(key, data)
            return data
        finally:
            r.delete(lock)
    deadline = time.monotonic() + LOCK_TTL_S
    while time.monotonic() < deadline:
        time.sleep(POLL_S)
        cached = r.get(key)
        if cached is not None:
            return None if cached == MISSING else cached
    return render(image_id, width)  # the leader died: render ourselves
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LOCK_TTL_S = 5;
export const POLL_MS = 50;
export const MISSING = '__missing__';

/** The resizer (built in step 4): null when the origin has no such image. */
export const resizer = {
  async render(imageId: string, width: number): Promise<Buffer | null> {
    throw new Error('not implemented');
  },
};

/** The cache (step 2): SET with the right TTL — the bytes, or the sentinel when data is null. */
export const cache = {
  async store(key: string, data: Buffer | null): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The miss path: render at most once per key while others wait for the value. */
export async function fill(key: string, imageId: string, width: number): Promise<Buffer | null> {
  const lock = \`lock:\${key}\`;
  // TODO: SET lock NX EX LOCK_TTL_S; the winner renders, stores, releases the lock (finally)
  // TODO: others poll redis.get(key) every POLL_MS until the lock TTL passes
  // TODO: past the deadline, render anyway
  throw new Error('not implemented');
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LOCK_TTL_S = 5;
export const POLL_MS = 50;
export const MISSING = '__missing__';

/** The resizer (built in step 4): null when the origin has no such image. */
export const resizer = {
  async render(imageId: string, width: number): Promise<Buffer | null> {
    throw new Error('not implemented');
  },
};

/** The cache (step 2): SET with the right TTL — the bytes, or the sentinel when data is null. */
export const cache = {
  async store(key: string, data: Buffer | null): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The miss path: render at most once per key while others wait for the value. */
export async function fill(key: string, imageId: string, width: number): Promise<Buffer | null> {
  const lock = \`lock:\${key}\`;
  if ((await redis.set(lock, '1', 'EX', LOCK_TTL_S, 'NX')) === 'OK') {
    try {
      const data = await resizer.render(imageId, width);
      await cache.store(key, data);
      return data;
    } finally {
      await redis.del(lock);
    }
  }
  const deadline = Date.now() + LOCK_TTL_S * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const cached = await redis.getBuffer(key);
    if (cached !== null) return cached.toString() === MISSING ? null : cached;
  }
  return resizer.render(imageId, width); // the leader died: render ourselves
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	lockTTL = 5 * time.Second
	poll    = 50 * time.Millisecond
	missing = "__missing__"
)

// render is built in step 4; nil, nil when the origin has no such image.
var render = func(ctx context.Context, id string, width int) ([]byte, error) {
	panic("not implemented")
}

// store writes the value with the right TTL (sentinel when data is nil) — from step 2.
var store = func(ctx context.Context, key string, data []byte) {
	panic("not implemented")
}

// fill is the miss path: render at most once per key while others wait for the value.
func fill(ctx context.Context, key, id string, width int) ([]byte, error) {
	lock := "lock:" + key
	// TODO: SetNX lock with lockTTL; winner renders, stores, releases the lock
	// TODO: others poll rdb.Get(ctx, key) every poll until the lock TTL passes
	// TODO: past the deadline, render anyway
	_ = lock
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	lockTTL = 5 * time.Second
	poll    = 50 * time.Millisecond
	missing = "__missing__"
)

// render is built in step 4; nil, nil when the origin has no such image.
var render = func(ctx context.Context, id string, width int) ([]byte, error) {
	panic("not implemented")
}

// store writes the value with the right TTL (sentinel when data is nil) — from step 2.
var store = func(ctx context.Context, key string, data []byte) {
	panic("not implemented")
}

// fill is the miss path: render at most once per key while others wait for the value.
func fill(ctx context.Context, key, id string, width int) ([]byte, error) {
	lock := "lock:" + key
	won, err := rdb.SetNX(ctx, lock, "1", lockTTL).Result()
	if err != nil {
		return nil, err
	}
	if won {
		defer rdb.Del(ctx, lock)
		data, err := render(ctx, id, width)
		if err != nil {
			return nil, err
		}
		store(ctx, key, data)
		return data, nil
	}
	deadline := time.Now().Add(lockTTL)
	for time.Now().Before(deadline) {
		time.Sleep(poll)
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
	}
	return render(ctx, id, width) // the leader died: render ourselves
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object ThumbFill {
  val jedis = new JedisPooled("redis", 6379)

  val LockTtlSeconds = 5L
  val PollMillis = 50L
  val Missing: Array[Byte] = "__missing__".getBytes

  /** Built in step 4; None when the origin has no such image. */
  def render(id: String, width: Int): Option[Array[Byte]] = ???

  /** SETEX with the right TTL (sentinel when data is None) — from step 2. */
  def store(key: String, data: Option[Array[Byte]]): Unit = ???

  /** The miss path: render at most once per key while others wait for the value. */
  def fill(key: String, id: String, width: Int): Option[Array[Byte]] = {
    val lock = s"lock:$key"
    // TODO: SET lock NX EX LockTtlSeconds; winner renders, stores, releases the lock
    // TODO: others poll jedis.get(key) every PollMillis until the lock TTL passes
    // TODO: past the deadline, render anyway
    None
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object ThumbFill {
  val jedis = new JedisPooled("redis", 6379)

  val LockTtlSeconds = 5L
  val PollMillis = 50L
  val Missing: Array[Byte] = "__missing__".getBytes

  /** Built in step 4; None when the origin has no such image. */
  def render(id: String, width: Int): Option[Array[Byte]] = ???

  /** SETEX with the right TTL (sentinel when data is None) — from step 2. */
  def store(key: String, data: Option[Array[Byte]]): Unit = ???

  /** The miss path: render at most once per key while others wait for the value. */
  def fill(key: String, id: String, width: Int): Option[Array[Byte]] = {
    val lock = s"lock:$key"
    val won = jedis.set(lock, "1", SetParams.setParams().nx().ex(LockTtlSeconds)) != null
    if (won) {
      try {
        val data = render(id, width)
        store(key, data)
        data
      } finally jedis.del(lock)
    } else {
      val deadline = System.nanoTime() + LockTtlSeconds * 1000000000L
      var found: Option[Array[Byte]] = None
      var done = false
      while (!done && System.nanoTime() < deadline) {
        Thread.sleep(PollMillis)
        Option(jedis.get(key.getBytes)).foreach { cached =>
          found = if (cached.sameElements(Missing)) None else Some(cached)
          done = true
        }
      }
      if (done) found else render(id, width) // the leader died: render ourselves
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
#include <thread>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kLockTtl{5};
constexpr std::chrono::milliseconds kPoll{50};
const std::string kMissing = "__missing__";

// Built in step 4; nullopt when the origin has no such image.
std::optional<std::string> render(const std::string& id, int width);

// SET with the right TTL (sentinel when data is nullopt) — from step 2.
void store(const std::string& key, const std::optional<std::string>& data);

// The miss path: render at most once per key while others wait for the value.
std::optional<std::string> fill(const std::string& key, const std::string& id, int width) {
  const std::string lock = "lock:" + key;
  // TODO: SET lock NX EX kLockTtl; winner renders, stores, releases the lock
  // TODO: others poll redis.get(key) every kPoll until the lock TTL passes
  // TODO: past the deadline, render anyway
  return std::nullopt;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <thread>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kLockTtl{5};
constexpr std::chrono::milliseconds kPoll{50};
const std::string kMissing = "__missing__";

// Built in step 4; nullopt when the origin has no such image.
std::optional<std::string> render(const std::string& id, int width);

// SET with the right TTL (sentinel when data is nullopt) — from step 2.
void store(const std::string& key, const std::optional<std::string>& data);

// The miss path: render at most once per key while others wait for the value.
std::optional<std::string> fill(const std::string& key, const std::string& id, int width) {
  const std::string lock = "lock:" + key;
  if (redis.set(lock, "1", kLockTtl, sw::redis::UpdateType::NOT_EXIST)) {
    struct Release {
      const std::string& lock;
      ~Release() { redis.del(lock); }
    } release{lock};
    const auto data = render(id, width);
    store(key, data);
    return data;
  }
  const auto deadline = std::chrono::steady_clock::now() + kLockTtl;
  while (std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(kPoll);
    if (const auto cached = redis.get(key)) {
      if (*cached == kMissing) return std::nullopt;
      return cached;
    }
  }
  return render(id, width);  // the leader died: render ourselves
}
`,
    },
  },
  harness: {
    python: `MISSING = b"__missing__"


def _fill(ctx, render=None):
    m = ctx.load("thumb_fill")
    m.render = render or (lambda image_id, width: b"JPEG")
    m.store = lambda key, data: ctx.redis_bytes.set(key, MISSING if data is None else data, ex=86400)
    return m


def check_lock_nx(ctx):
    seen = {}

    def render(image_id, width):
        seen["held"] = ctx.redis.exists("lock:thumb:cat:256")
        seen["ttl"] = ctx.redis.ttl("lock:thumb:cat:256")
        return b"JPEG"

    m = _fill(ctx, render)
    assert m.fill("thumb:cat:256", "cat", 256) == b"JPEG", "the winner returns the rendered bytes"
    assert seen.get("held") == 1, "lock:thumb:cat:256 must be held while the winner renders"
    assert 0 < seen["ttl"] <= 5, f"the lock must expire within 5 s (TTL {seen['ttl']})"
    # Someone else holds the lock: NX must fail and this caller must not render.
    ctx.redis.set("lock:thumb:dog:256", "1", ex=5)
    ctx.redis_bytes.set("thumb:dog:256", b"LEADER")
    calls = []
    m.render = lambda image_id, width: calls.append(image_id) or b"X"
    assert m.fill("thumb:dog:256", "dog", 256) == b"LEADER", "a caller that did not win the lock returns the leader's value"
    assert calls == [], "a caller that did not win the lock must not render"


def check_release(ctx):
    m = _fill(ctx)
    assert m.fill("thumb:cat:256", "cat", 256) == b"JPEG"
    assert ctx.redis_bytes.get("thumb:cat:256") == b"JPEG", "the winner must store() the rendered value"
    assert not ctx.redis.exists("lock:thumb:cat:256"), "the lock must be released once the value is stored"

    def boom(image_id, width):
        raise RuntimeError("origin down")

    m.render = boom
    try:
        m.fill("thumb:bad:256", "bad", 256)
    except RuntimeError:
        pass
    assert not ctx.redis.exists("lock:thumb:bad:256"), "the lock must be released even when render fails"


def check_wait_recheck(ctx):
    m = _fill(ctx)
    ctx.redis.set("lock:thumb:cat:256", "1", ex=5)
    reads = []
    real_get = m.r.get

    def get(key, *args, **kwargs):
        reads.append(key)
        if len(reads) == 2:
            ctx.redis_bytes.set("thumb:cat:256", b"LEADER")  # the leader finishes
        return real_get(key, *args, **kwargs)

    m.r.get = get
    calls = []
    m.render = lambda image_id, width: calls.append(image_id) or b"X"
    assert m.fill("thumb:cat:256", "cat", 256) == b"LEADER", "the follower must return the value the leader stored"
    assert calls == [], "the follower must not render while the lock is held"
    assert ctx.clock.sleeps >= 1, "poll by sleeping briefly between reads, not in a tight loop"
    assert len(reads) >= 2, "the follower must re-read the key until the value appears"


def check_bounded_wait(ctx):
    m = _fill(ctx)
    ctx.redis.set("lock:thumb:cat:256", "1", ex=5)  # the leader died holding the lock
    calls = []
    m.render = lambda image_id, width: calls.append(image_id) or b"MINE"
    ctx.clock.sleep_limit = 1000
    assert m.fill("thumb:cat:256", "cat", 256) == b"MINE", "once the lock TTL passes the follower must render itself"
    assert calls == ["cat"]
    assert 50 <= ctx.clock.sleeps <= 200, f"waited through {ctx.clock.sleeps} polls; a 50 ms poll over a 5 s lock TTL is about 100"
`,
    typescript: `const MISSING = '__missing__';
/** Fake JPEG bytes: the real SOI marker (FF D8 FF, not valid UTF-8) and a label. */
const jpeg = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(label)]);
const hex = (b: Buffer | null) => (b === null ? 'null' : b.toString('hex'));

/** The resizer and the cache's store() (steps 4 and 2), swapped onto the learner's provided objects. */
function fill(ctx, render?: (imageId: string, width: number) => Promise<Buffer | null>) {
  const m = ctx.load('thumb_fill');
  m.resizer.render = render ?? (async () => jpeg('JPEG'));
  m.cache.store = async (key: string, data: Buffer | null) => {
    ctx.redis.set(key, data ?? MISSING, 'EX', 86400);
  };
  return m;
}

export async function check_lock_nx(ctx) {
  const seen: {held?: number; ttl?: number} = {};
  const m = fill(ctx, async () => {
    seen.held = ctx.redis.exists('lock:thumb:cat:256');
    seen.ttl = ctx.redis.ttl('lock:thumb:cat:256');
    return jpeg('JPEG');
  });
  const won = await m.fill('thumb:cat:256', 'cat', 256);
  assert(won !== null && jpeg('JPEG').equals(won), \`the winner returns the rendered bytes: got \${hex(won)}\`);
  assert.equal(seen.held, 1, 'lock:thumb:cat:256 must be held while the winner renders');
  assert(0 < seen.ttl && seen.ttl <= 5, \`the lock must expire within 5 s (TTL \${seen.ttl})\`);
  // Someone else holds the lock: NX must fail and this caller must not render.
  ctx.redis.set('lock:thumb:dog:256', '1', 'EX', 5);
  ctx.redis.set('thumb:dog:256', jpeg('LEADER'));
  const calls: string[] = [];
  m.resizer.render = async (imageId: string) => {
    calls.push(imageId);
    return Buffer.from('X');
  };
  const followed = await m.fill('thumb:dog:256', 'dog', 256);
  assert(followed !== null && jpeg('LEADER').equals(followed), \`a caller that did not win the lock returns the leader's value verbatim: got \${hex(followed)}, expected \${hex(jpeg('LEADER'))}\`);
  assert.deepEqual(calls, [], 'a caller that did not win the lock must not render');
}

export async function check_release(ctx) {
  const m = fill(ctx);
  const won = await m.fill('thumb:cat:256', 'cat', 256);
  assert(won !== null && jpeg('JPEG').equals(won));
  const stored = ctx.redis.getBuffer('thumb:cat:256');
  assert(jpeg('JPEG').equals(stored), \`the winner must store() the rendered value: stored \${hex(stored)}\`);
  assert(!ctx.redis.exists('lock:thumb:cat:256'), 'the lock must be released once the value is stored');
  m.resizer.render = async () => {
    throw new Error('origin down');
  };
  await assert.rejects(m.fill('thumb:bad:256', 'bad', 256), /origin down/, 'a failing render must propagate');
  assert(!ctx.redis.exists('lock:thumb:bad:256'), 'the lock must be released even when render fails');
}

export async function check_wait_recheck(ctx) {
  const m = fill(ctx);
  ctx.redis.set('lock:thumb:cat:256', '1', 'EX', 5);
  // The leader finishes right after the follower's first read of the key.
  ctx.redisAfter('thumb:cat:256', () => ctx.redis.set('thumb:cat:256', jpeg('LEADER')));
  const calls: string[] = [];
  m.resizer.render = async (imageId: string) => {
    calls.push(imageId);
    return Buffer.from('X');
  };
  const followed = await m.fill('thumb:cat:256', 'cat', 256);
  assert(followed !== null && jpeg('LEADER').equals(followed), \`the follower must return the value the leader stored, verbatim: got \${hex(followed)}, expected \${hex(jpeg('LEADER'))}\`);
  assert.deepEqual(calls, [], 'the follower must not render while the lock is held');
  assert(ctx.clock.sleeps >= 1, 'poll by sleeping briefly between reads, not in a tight loop');
}

export async function check_bounded_wait(ctx) {
  const m = fill(ctx);
  ctx.redis.set('lock:thumb:cat:256', '1', 'EX', 5); // the leader died holding the lock
  const calls: string[] = [];
  m.resizer.render = async (imageId: string) => {
    calls.push(imageId);
    return Buffer.from('MINE');
  };
  const result = await ctx.drain(m.fill('thumb:cat:256', 'cat', 256));
  assert(result !== undefined, \`waited through \${ctx.clock.sleeps} polls and never rendered: once the lock TTL passes the follower must render itself\`);
  assert.equal(String(result), 'MINE', 'once the lock TTL passes the follower must render itself');
  assert.deepEqual(calls, ['cat']);
  assert(50 <= ctx.clock.sleeps && ctx.clock.sleeps <= 200, \`waited through \${ctx.clock.sleeps} polls; a 50 ms poll over a 5 s lock TTL is about 100\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"strings"

	"leetbuild/harness"
)

const spMissing = "__missing__"

var spBg = context.Background()

// spJPEG is fake JPEG bytes: the real SOI marker (FF D8 FF, not valid UTF-8) and a label.
func spJPEG(label string) []byte { return append([]byte{0xff, 0xd8, 0xff}, label...) }

// spHex shows bytes as hex, nil as nil.
func spHex(b []byte) string {
	if b == nil {
		return "nil"
	}
	return hex.EncodeToString(b)
}

// spStandIns stands in for the resizer's render (step 4), answering JPEG bytes, and the cache's
// store (step 2), writing the value (the sentinel for nil) with a day's TTL.
func spStandIns(ctx *harness.Ctx) {
	render = func(context.Context, string, int) ([]byte, error) { return spJPEG("JPEG"), nil }
	store = func(_ context.Context, key string, data []byte) {
		var value any = data
		if data == nil {
			value = spMissing
		}
		ctx.Redis.Set(key, value, "EX", 86400)
	}
}

// spRecorder stands in for render with one that records the image ids it is asked for and answers reply.
func spRecorder(reply string) *[]string {
	calls := &[]string{}
	render = func(_ context.Context, id string, _ int) ([]byte, error) {
		*calls = append(*calls, id)
		return []byte(reply), nil
	}
	return calls
}

func spFill(ctx *harness.Ctx, key, id string, width int) []byte {
	data, err := fill(spBg, key, id, width)
	ctx.NoError(err, "fill(ctx, %q, %q, %d) returned an error", key, id, width)
	return data
}

// spStored is the bytes at key, nil when there is no such key.
func spStored(ctx *harness.Ctx, key string) []byte {
	if v, ok := ctx.Redis.Get(key); ok {
		return []byte(v)
	}
	return nil
}

func CheckLockNx(ctx *harness.Ctx) {
	spStandIns(ctx)
	var held, ttl int64
	render = func(context.Context, string, int) ([]byte, error) {
		held = ctx.Redis.Exists("lock:thumb:cat:256")
		ttl = ctx.Redis.TTL("lock:thumb:cat:256")
		return spJPEG("JPEG"), nil
	}
	won := spFill(ctx, "thumb:cat:256", "cat", 256)
	ctx.Assert(won != nil && bytes.Equal(won, spJPEG("JPEG")), "the winner returns the rendered bytes: got %s", spHex(won))
	ctx.Equal(held, 1, "lock:thumb:cat:256 must be held while the winner renders")
	ctx.Assert(0 < ttl && ttl <= 5, "the lock must expire within 5 s (TTL %d)", ttl)
	// Someone else holds the lock: NX must fail and this caller must not render.
	ctx.Redis.Set("lock:thumb:dog:256", "1", "EX", 5)
	ctx.Redis.Set("thumb:dog:256", spJPEG("LEADER"))
	calls := spRecorder("X")
	followed := spFill(ctx, "thumb:dog:256", "dog", 256)
	ctx.Assert(followed != nil && bytes.Equal(followed, spJPEG("LEADER")), "a caller that did not win the lock returns the leader's value verbatim: got %s, expected %s", spHex(followed), spHex(spJPEG("LEADER")))
	ctx.Equal(len(*calls), 0, "a caller that did not win the lock must not render")
}

func CheckRelease(ctx *harness.Ctx) {
	spStandIns(ctx)
	won := spFill(ctx, "thumb:cat:256", "cat", 256)
	ctx.Assert(won != nil && bytes.Equal(won, spJPEG("JPEG")), "the winner returns the rendered bytes: got %s", spHex(won))
	stored := spStored(ctx, "thumb:cat:256")
	ctx.Assert(bytes.Equal(stored, spJPEG("JPEG")), "the winner must store() the rendered value: stored %s", spHex(stored))
	ctx.Equal(ctx.Redis.Exists("lock:thumb:cat:256"), 0, "the lock must be released once the value is stored")
	render = func(context.Context, string, int) ([]byte, error) { return nil, errors.New("origin down") }
	_, err := fill(spBg, "thumb:bad:256", "bad", 256)
	ctx.Assert(err != nil && strings.Contains(err.Error(), "origin down"), "a failing render must propagate: fill returned the error %v", err)
	ctx.Equal(ctx.Redis.Exists("lock:thumb:bad:256"), 0, "the lock must be released even when render fails")
}

func CheckWaitRecheck(ctx *harness.Ctx) {
	spStandIns(ctx)
	ctx.Redis.Set("lock:thumb:cat:256", "1", "EX", 5)
	// The leader finishes right after the follower's first read of the key.
	ctx.Redis.After("thumb:cat:256", func() any { return ctx.Redis.Set("thumb:cat:256", spJPEG("LEADER")) })
	calls := spRecorder("X")
	followed := spFill(ctx, "thumb:cat:256", "cat", 256)
	ctx.Assert(followed != nil && bytes.Equal(followed, spJPEG("LEADER")), "the follower must return the value the leader stored, verbatim: got %s, expected %s", spHex(followed), spHex(spJPEG("LEADER")))
	ctx.Equal(len(*calls), 0, "the follower must not render while the lock is held")
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "poll by sleeping briefly between reads, not in a tight loop")
}

func CheckBoundedWait(ctx *harness.Ctx) {
	spStandIns(ctx)
	ctx.Redis.Set("lock:thumb:cat:256", "1", "EX", 5) // the leader died holding the lock
	calls := spRecorder("MINE")
	var result []byte
	var err error
	returned := ctx.Drain(func() { result, err = fill(spBg, "thumb:cat:256", "cat", 256) })
	ctx.Assert(returned, "waited through %d polls and never rendered: once the lock TTL passes the follower must render itself", ctx.Clock.Sleeps())
	ctx.NoError(err, "fill(ctx, %q, %q, %d) returned an error", "thumb:cat:256", "cat", 256)
	ctx.Equal(string(result), "MINE", "once the lock TTL passes the follower must render itself")
	ctx.Equal(*calls, []string{"cat"}, "render calls once the lock TTL passed")
	sleeps := ctx.Clock.Sleeps()
	ctx.Assert(50 <= sleeps && sleeps <= 200, "waited through %d polls; a 50 ms poll over a 5 s lock TTL is about 100", sleeps)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

const std::string spMissing = "__missing__";

// spJPEG is fake JPEG bytes: the real SOI marker (FF D8 FF, not valid UTF-8) and a label.
std::string spJPEG(const std::string& label) { return "\\xff\\xd8\\xff" + label; }

// spHex shows bytes as hex, nullopt as nil.
std::string spHex(const std::optional<std::string>& b) {
  if (!b) return "nil";
  static const char* digits = "0123456789abcdef";
  std::string out;
  for (unsigned char c : *b) {
    out += digits[c >> 4];
    out += digits[c & 15];
  }
  return out;
}

// What the render and store stand-ins do (Go reassigns the render and store variables).
std::function<std::optional<std::string>(const std::string&, int)> spRender;
harness::Ctx* spCtx = nullptr;

// spStandIns stands in for the resizer's render (step 4), answering JPEG bytes, and the cache's
// store (step 2), writing the value (the sentinel for nullopt) with a day's TTL.
void spStandIns(harness::Ctx& ctx) {
  spCtx = &ctx;
  spRender = [](const std::string&, int) { return std::optional<std::string>(spJPEG("JPEG")); };
}

// spRecorder stands in for render with one that records the image ids it is asked for and answers reply.
std::vector<std::string>& spRecorder(const std::string& reply) {
  static std::vector<std::string> calls;
  calls.clear();
  spRender = [reply](const std::string& id, int) {
    calls.push_back(id);
    return std::optional<std::string>(reply);
  };
  return calls;
}

// fill, failing the check when it throws (Go's ctx.NoError on the returned error).
std::optional<std::string> spFill(harness::Ctx& ctx, const std::string& key, const std::string& id, int width) {
  try {
    return fill(key, id, width);
  } catch (const std::exception& e) {
    ctx.Fatalf("fill(%q, %q, %d) threw: %s", key, id, width, e.what());
  }
}

}  // namespace

std::optional<std::string> render(const std::string& id, int width) { return spRender(id, width); }

void store(const std::string& key, const std::optional<std::string>& data) {
  spCtx->Redis.Set(key, data ? *data : spMissing, "EX", 86400);
}

void CheckLockNx(harness::Ctx& ctx) {
  spStandIns(ctx);
  long long held = 0, ttl = 0;
  spRender = [&](const std::string&, int) {
    held = ctx.Redis.Exists("lock:thumb:cat:256");
    ttl = ctx.Redis.TTL("lock:thumb:cat:256");
    return std::optional<std::string>(spJPEG("JPEG"));
  };
  const auto won = spFill(ctx, "thumb:cat:256", "cat", 256);
  ctx.Assert(won == spJPEG("JPEG"), "the winner returns the rendered bytes: got %s", spHex(won));
  ctx.Equal(held, 1, "lock:thumb:cat:256 must be held while the winner renders");
  ctx.Assert(0 < ttl && ttl <= 5, "the lock must expire within 5 s (TTL %d)", ttl);
  // Someone else holds the lock: NX must fail and this caller must not render.
  ctx.Redis.Set("lock:thumb:dog:256", "1", "EX", 5);
  ctx.Redis.Set("thumb:dog:256", spJPEG("LEADER"));
  auto& calls = spRecorder("X");
  const auto followed = spFill(ctx, "thumb:dog:256", "dog", 256);
  ctx.Assert(followed == spJPEG("LEADER"),
             "a caller that did not win the lock returns the leader's value verbatim: got %s, expected %s",
             spHex(followed), spHex(spJPEG("LEADER")));
  ctx.Equal(calls.size(), 0, "a caller that did not win the lock must not render");
}

void CheckRelease(harness::Ctx& ctx) {
  spStandIns(ctx);
  const auto won = spFill(ctx, "thumb:cat:256", "cat", 256);
  ctx.Assert(won == spJPEG("JPEG"), "the winner returns the rendered bytes: got %s", spHex(won));
  const auto stored = ctx.Redis.Get("thumb:cat:256");
  ctx.Assert(stored == spJPEG("JPEG"), "the winner must store() the rendered value: stored %s", spHex(stored));
  ctx.Equal(ctx.Redis.Exists("lock:thumb:cat:256"), 0, "the lock must be released once the value is stored");
  // Go's render returns an error; here it throws, and fill must let the exception through.
  spRender = [](const std::string&, int) -> std::optional<std::string> { throw std::runtime_error("origin down"); };
  std::string err = "<nil>";
  try {
    fill("thumb:bad:256", "bad", 256);
  } catch (const std::exception& e) {
    err = e.what();
  }
  ctx.Assert(err.find("origin down") != std::string::npos, "a failing render must propagate: fill threw %v", err);
  ctx.Equal(ctx.Redis.Exists("lock:thumb:bad:256"), 0, "the lock must be released even when render fails");
}

void CheckWaitRecheck(harness::Ctx& ctx) {
  spStandIns(ctx);
  ctx.Redis.Set("lock:thumb:cat:256", "1", "EX", 5);
  // The leader finishes right after the follower's first read of the key.
  ctx.Redis.After("thumb:cat:256", [&ctx] { ctx.Redis.Set("thumb:cat:256", spJPEG("LEADER")); });
  auto& calls = spRecorder("X");
  const auto followed = spFill(ctx, "thumb:cat:256", "cat", 256);
  ctx.Assert(followed == spJPEG("LEADER"),
             "the follower must return the value the leader stored, verbatim: got %s, expected %s", spHex(followed),
             spHex(spJPEG("LEADER")));
  ctx.Equal(calls.size(), 0, "the follower must not render while the lock is held");
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "poll by sleeping briefly between reads, not in a tight loop");
}

void CheckBoundedWait(harness::Ctx& ctx) {
  spStandIns(ctx);
  ctx.Redis.Set("lock:thumb:cat:256", "1", "EX", 5);  // the leader died holding the lock
  auto& calls = spRecorder("MINE");
  std::optional<std::string> result;
  const bool returned = ctx.Drain([&] { result = spFill(ctx, "thumb:cat:256", "cat", 256); });
  ctx.Assert(returned,
             "waited through %d polls and never rendered: once the lock TTL passes the follower must render itself",
             ctx.Clock.Sleeps());
  ctx.Equal(result.value_or(""), "MINE", "once the lock TTL passes the follower must render itself");
  ctx.Equal(calls, {"cat"}, "render calls once the lock TTL passed");
  const int sleeps = ctx.Clock.Sleeps();
  ctx.Assert(50 <= sleeps && sleeps <= 200, "waited through %d polls; a 50 ms poll over a 5 s lock TTL is about 100",
             sleeps);
}
`,
  },
  debrief: `This is a per-key mutex made of one Redis key: \`NX\` for exclusion, \`EX\` for liveness. Followers trade a few polls for one shared render — the "single flight" pattern. Production variants avoid polling (Pub/Sub on the key, or in-process single-flight so one machine only ever makes one call), and serve the *stale* value while one request refreshes it in the background (stale-while-revalidate), which removes the wait entirely.`,
};
