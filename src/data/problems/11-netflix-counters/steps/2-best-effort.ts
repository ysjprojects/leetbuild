import type {Step} from '@/lib/types';

export const bestEffortStep: Step = {
  id: 'best-effort',
  title: 'Best-effort counters: INCRBY with a TTL set once',
  concept: 'redis',
  file: 'best_effort',
  focus: ['api', 'redis'],
  task: `## Task

A best-effort counter is a number in a cache: cheap, immediately readable, and allowed to be lost.
Implement \`add_count(ns, name, delta)\`, \`get_count(ns, name)\` and \`clear_count(ns, name)\` on Redis.

- The key is \`counter:{ns}:{name}\`.
- An add is \`INCRBY\` and returns the new count. The key must carry a **TTL of \`TTL_S\`** (3600 s)
  measured from its **creation**: send \`SET key 0 NX EX 3600\` and the \`INCRBY\` together in one
  **pipeline** — one round trip, and the \`NX\` makes the \`SET\` a no-op once the key exists.
- Do **not** refresh the TTL on every add. A hot counter that re-arms its own expiry never leaves the
  cache; a counter whose lifetime is fixed at creation is bounded by configuration, not by traffic.
  (Memcached's \`incr\` leaves the expiry alone, which is exactly the behaviour you are reproducing.)
- \`get_count\` is a \`GET\` — **0** when the key is missing or expired. \`clear_count\` is a \`DEL\`.

:::widget cache-aside {}

> There is no store behind this cache. A best-effort counter that expires or is evicted starts again
> from zero, and that is the contract: approximate, fast, cheap.`,
  sequence: {
    participants: ['counters', 'Redis'],
    messages: [
      {
        from: 'counters',
        to: 'Redis',
        label: 'MULTI · SET counter:views:trailer-7 0 NX EX 3600 · INCRBY counter:views:trailer-7 1 · EXEC',
        kind: 'sync',
      },
      {from: 'Redis', to: 'counters', label: '[OK, 1]', kind: 'reply'},
      {
        from: 'counters',
        to: 'Redis',
        label: 'MULTI · SET … 0 NX EX 3600 · INCRBY … 1 · EXEC (20 min later)',
        kind: 'sync',
      },
      {from: 'Redis', to: 'counters', label: '[nil, 2] · TTL still 2400', kind: 'reply'},
      {from: 'counters', to: 'Redis', label: 'GET counter:views:trailer-7', kind: 'sync'},
      {from: 'Redis', to: 'counters', label: '"2"', kind: 'reply'},
    ],
  },
  hints: [
    'Open a pipeline, queue the `SET … NX EX` and then the `INCRBY`, execute once: the second reply is the new count. `SET NX` returns nil when the key already exists, which is what keeps the TTL untouched.',
    'An `EXPIRE` after every `INCRBY` is the bug this step is about; if your client offers `EXPIRE … NX` that is an acceptable alternative to `SET NX`, but a plain `EXPIRE` is not.',
    '`GET` on a missing key is nil, not 0: convert explicitly. `DEL` on a missing key is fine — clearing an unknown counter is not an error.',
  ],
  checks: [
    {
      id: 'key',
      title: 'Key is counter:{ns}:{name}',
      detail: 'Every operation addresses `counter:{ns}:{name}`, so one namespace cannot collide with another.',
      match: {
        python: {all: [/f["']counter:\{ns\}:\{name\}["']/]},
        typescript: {all: [/`counter:\$\{ns\}:\$\{name\}`/]},
        go: {all: [/"counter:"\s*\+\s*ns\s*\+\s*":"\s*\+\s*name|"counter:%s:%s"/]},
        scala: {all: [/s"counter:\$ns:\$name"|s"counter:\$\{ns\}:\$\{name\}"/]},
        cpp: {all: [/"counter:"\s*\+\s*ns\s*\+\s*":"\s*\+\s*name/]},
      },
    },
    {
      id: 'incrby',
      title: 'Adds with INCRBY and returns the new count',
      detail:
        '`INCRBY key delta` is atomic and answers the value after the add; that reply is what `add_count` returns.',
      match: {
        python: {all: [/\.incrby\(\s*\w+\s*,\s*delta\s*\)/]},
        typescript: {all: [/\.incrby\(\s*\w+\s*,\s*delta\s*\)/]},
        go: {all: [/\.IncrBy\(\s*ctx\s*,\s*\w+\s*,\s*delta\s*\)/]},
        scala: {all: [/\.incrBy\(\s*\w+\s*,\s*delta\s*\)/]},
        cpp: {all: [/\.incrby\(\s*\w+\s*,\s*delta\s*\)/]},
      },
    },
    {
      id: 'ttl-on-create',
      title: 'Sets the TTL when the key is created',
      detail:
        '`SET key 0 NX EX TTL_S` (or `EXPIRE key TTL_S NX`) arms the expiry exactly once — on the add that creates the counter.',
      match: {
        python: {
          all: [
            /\.set\(\s*\w+\s*,\s*0\s*,[^\n]*nx\s*=\s*True[^\n]*ex\s*=\s*TTL_S|\.set\(\s*\w+\s*,\s*0\s*,[^\n]*ex\s*=\s*TTL_S[^\n]*nx\s*=\s*True|\.expire\(\s*\w+\s*,\s*TTL_S\s*,\s*nx\s*=\s*True/,
          ],
        },
        typescript: {
          all: [
            /\.set\(\s*\w+\s*,\s*0\s*,[^\n]*['"]NX['"][^\n]*['"]EX['"]\s*,\s*TTL_S|\.set\(\s*\w+\s*,\s*0\s*,[^\n]*['"]EX['"]\s*,\s*TTL_S[^\n]*['"]NX['"]|\.expire\(\s*\w+\s*,\s*TTL_S\s*,\s*['"]NX['"]/,
          ],
        },
        go: {all: [/\.SetNX\(\s*ctx\s*,\s*\w+\s*,\s*0\s*,\s*ttl\s*\)|\.ExpireNX\(\s*ctx\s*,\s*\w+\s*,\s*ttl\s*\)/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(\s*TtlSeconds\s*\)|expire\(\s*\w+\s*,\s*TtlSeconds\s*,\s*ExpiryOption\.NX/]},
        cpp: {all: [/\.set\(\s*\w+\s*,\s*"0"\s*,\s*kTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/]},
      },
    },
    {
      id: 'pipelined',
      title: 'Sends SET NX and INCRBY in one pipeline and never re-arms the TTL',
      detail:
        'Both commands go to Redis in one round trip; a plain `EXPIRE` after the add would turn a fixed lifetime into a sliding one.',
      match: {
        python: {all: [/\.pipeline\(/, /\.execute\(\)/], none: [/\.expire\(\s*\w+\s*,\s*TTL_S\s*\)/]},
        typescript: {all: [/\.(multi|pipeline)\(\)/, /\.exec\(\)/], none: [/\.expire\(\s*\w+\s*,\s*TTL_S\s*\)/]},
        go: {
          all: [/\.(Tx)?Pipeline\(\)|\.(Tx)?Pipelined\(/, /\.Exec\(\s*ctx\s*\)/],
          none: [/\.Expire\(\s*ctx\s*,\s*\w+\s*,\s*ttl\s*\)/],
        },
        scala: {all: [/\.pipelined\(\)/, /\.sync\(\)/], none: [/\.expire\(\s*\w+\s*,\s*TtlSeconds\s*\)/]},
        cpp: {all: [/\.pipeline\(/, /\.exec\(\)/], none: [/\.expire\(\s*\w+\s*,\s*kTtl\s*\)/]},
      },
    },
    {
      id: 'get-clear',
      title: 'Reads with GET (0 when missing) and clears with DEL',
      detail: '`get_count` converts the `GET` reply to an integer and treats nil as 0; `clear_count` deletes the key.',
      match: {
        python: {all: [/\br\.get\(/, /int\(/, /\br\.delete\(/]},
        typescript: {all: [/\bredis\.get\(/, /Number\(|parseInt\(/, /\bredis\.del\(/]},
        go: {all: [/rdb\.Get\(/, /redis\.Nil/, /rdb\.Del\(/]},
        scala: {all: [/jedis\.get\(/, /\.toLong|getOrElse\(\s*0L?\s*\)/, /jedis\.del\(/]},
        cpp: {all: [/redis\.get\(/, /std::stoll\(|value_or\(/, /redis\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600  # a best-effort counter lives an hour from its creation, however busy it is


def key_of(ns: str, name: str) -> str:
    return ...  # TODO: counter:{ns}:{name}


def add_count(ns: str, name: str, delta: int) -> int:
    key = key_of(ns, name)
    # TODO: one pipeline: SET key 0 NX EX TTL_S, then INCRBY key delta; return the INCRBY reply
    # TODO: never EXPIRE on every add: the TTL is armed once, when the key is created
    raise NotImplementedError


def get_count(ns: str, name: str) -> int:
    # TODO: GET; a missing or expired key reads as 0
    raise NotImplementedError


def clear_count(ns: str, name: str) -> None:
    # TODO: DEL
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600  # a best-effort counter lives an hour from its creation, however busy it is


def key_of(ns: str, name: str) -> str:
    return f"counter:{ns}:{name}"


def add_count(ns: str, name: str, delta: int) -> int:
    key = key_of(ns, name)
    pipe = r.pipeline()
    pipe.set(key, 0, nx=True, ex=TTL_S)  # arms the TTL on the add that creates the key; a no-op afterwards
    pipe.incrby(key, delta)
    _, count = pipe.execute()
    return int(count)


def get_count(ns: str, name: str) -> int:
    value = r.get(key_of(ns, name))
    return int(value) if value is not None else 0


def clear_count(ns: str, name: str) -> None:
    r.delete(key_of(ns, name))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 3600; // a best-effort counter lives an hour from its creation, however busy it is

export function keyOf(ns: string, name: string): string {
  return ''; // TODO: counter:{ns}:{name}
}

export async function addCount(ns: string, name: string, delta: number): Promise<number> {
  const key = keyOf(ns, name);
  // TODO: one MULTI/EXEC pipeline: SET key 0 NX EX TTL_S, then INCRBY key delta; return the INCRBY reply
  // TODO: never EXPIRE on every add: the TTL is armed once, when the key is created
  throw new Error('not implemented');
}

export async function getCount(ns: string, name: string): Promise<number> {
  // TODO: GET; a missing or expired key reads as 0
  throw new Error('not implemented');
}

export async function clearCount(ns: string, name: string): Promise<void> {
  // TODO: DEL
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 3600; // a best-effort counter lives an hour from its creation, however busy it is

export function keyOf(ns: string, name: string): string {
  return \`counter:\${ns}:\${name}\`;
}

export async function addCount(ns: string, name: string, delta: number): Promise<number> {
  const key = keyOf(ns, name);
  const replies = await redis
    .multi()
    .set(key, 0, 'EX', TTL_S, 'NX') // arms the TTL on the add that creates the key; a no-op afterwards
    .incrby(key, delta)
    .exec();
  const [, count] = replies![1];
  return Number(count);
}

export async function getCount(ns: string, name: string): Promise<number> {
  const value = await redis.get(keyOf(ns, name));
  return value === null ? 0 : Number(value);
}

export async function clearCount(ns: string, name: string): Promise<void> {
  await redis.del(keyOf(ns, name));
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

const ttl = time.Hour // a best-effort counter lives an hour from its creation, however busy it is

func keyOf(ns, name string) string {
	return "" // TODO: counter:{ns}:{name}
}

func addCount(ctx context.Context, ns, name string, delta int64) (int64, error) {
	key := keyOf(ns, name)
	// TODO: one TxPipeline: SetNX key 0 ttl, then IncrBy key delta; return the IncrBy result
	// TODO: never Expire on every add: the TTL is armed once, when the key is created
	_ = key
	return 0, errors.New("not implemented")
}

func getCount(ctx context.Context, ns, name string) (int64, error) {
	// TODO: Get; redis.Nil (missing or expired) reads as 0
	return 0, errors.New("not implemented")
}

func clearCount(ctx context.Context, ns, name string) error {
	// TODO: Del
	return errors.New("not implemented")
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

const ttl = time.Hour // a best-effort counter lives an hour from its creation, however busy it is

func keyOf(ns, name string) string {
	return "counter:" + ns + ":" + name
}

func addCount(ctx context.Context, ns, name string, delta int64) (int64, error) {
	key := keyOf(ns, name)
	pipe := rdb.TxPipeline()
	pipe.SetNX(ctx, key, 0, ttl) // arms the TTL on the add that creates the key; a no-op afterwards
	incr := pipe.IncrBy(ctx, key, delta)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return incr.Val(), nil
}

func getCount(ctx context.Context, ns, name string) (int64, error) {
	count, err := rdb.Get(ctx, keyOf(ns, name)).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return count, err
}

func clearCount(ctx context.Context, ns, name string) error {
	return rdb.Del(ctx, keyOf(ns, name)).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object BestEffort {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 3600L // a best-effort counter lives an hour from its creation, however busy it is

  def keyOf(ns: String, name: String): String = ??? // TODO: counter:{ns}:{name}

  def addCount(ns: String, name: String, delta: Long): Long = {
    val key = keyOf(ns, name)
    // TODO: one pipeline: SET key "0" NX EX TtlSeconds, then INCRBY key delta; sync and return the INCRBY reply
    // TODO: never EXPIRE on every add: the TTL is armed once, when the key is created
    ???
  }

  def getCount(ns: String, name: String): Long = {
    // TODO: GET; a missing or expired key reads as 0
    ???
  }

  def clearCount(ns: String, name: String): Unit = {
    // TODO: DEL
    ???
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object BestEffort {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 3600L // a best-effort counter lives an hour from its creation, however busy it is

  def keyOf(ns: String, name: String): String = s"counter:$ns:$name"

  def addCount(ns: String, name: String, delta: Long): Long = {
    val key = keyOf(ns, name)
    val pipe = jedis.pipelined()
    pipe.set(key, "0", SetParams.setParams().nx().ex(TtlSeconds)) // arms the TTL on the add that creates the key; a no-op afterwards
    val count = pipe.incrBy(key, delta)
    pipe.sync()
    count.get()
  }

  def getCount(ns: String, name: String): Long =
    Option(jedis.get(keyOf(ns, name))).map(_.toLong).getOrElse(0L)

  def clearCount(ns: String, name: String): Unit =
    jedis.del(keyOf(ns, name))
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{3600};  // a best-effort counter lives an hour from its creation, however busy it is

std::string key_of(const std::string& ns, const std::string& name) {
  return "";  // TODO: counter:{ns}:{name}
}

long long add_count(const std::string& ns, const std::string& name, long long delta) {
  const std::string key = key_of(ns, name);
  // TODO: one pipeline: set(key, "0", kTtl, UpdateType::NOT_EXIST), then incrby(key, delta); exec and return the incrby reply
  // TODO: never expire on every add: the TTL is armed once, when the key is created
  return 0;
}

long long get_count(const std::string& ns, const std::string& name) {
  // TODO: get; a missing or expired key reads as 0
  return 0;
}

void clear_count(const std::string& ns, const std::string& name) {
  // TODO: del
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{3600};  // a best-effort counter lives an hour from its creation, however busy it is

std::string key_of(const std::string& ns, const std::string& name) {
  return "counter:" + ns + ":" + name;
}

long long add_count(const std::string& ns, const std::string& name, long long delta) {
  const std::string key = key_of(ns, name);
  auto pipe = redis.pipeline();
  // The SET arms the TTL on the add that creates the key and is a no-op afterwards.
  auto replies = pipe.set(key, "0", kTtl, sw::redis::UpdateType::NOT_EXIST).incrby(key, delta).exec();
  return replies.get<long long>(1);
}

long long get_count(const std::string& ns, const std::string& name) {
  const auto value = redis.get(key_of(ns, name));
  return value ? std::stoll(*value) : 0;
}

void clear_count(const std::string& ns, const std::string& name) {
  redis.del(key_of(ns, name));
}
`,
    },
  },
  harness: {
    python: `KEY = "counter:views:trailer-7"


def check_key(ctx):
    m = ctx.load("best_effort")
    assert m.add_count("views", "trailer-7", 3) == 3, "the first add of 3 must return 3"
    assert ctx.redis.get(KEY) == "3", f"the counter must live under {KEY}, keys are {ctx.redis.keys()}"
    m.add_count("views", "trailer-8", 1)
    assert ctx.redis.get("counter:views:trailer-8") == "1" and ctx.redis.get(KEY) == "3", "each counter has its own key"


def check_incrby(ctx):
    m = ctx.load("best_effort")
    assert m.add_count("views", "trailer-7", 3) == 3
    assert m.add_count("views", "trailer-7", 4) == 7, "the second add returns the running count 7"
    assert m.add_count("views", "trailer-7", -2) == 5, "a negative delta decrements: expected 5"
    assert ctx.redis.get(KEY) == "5", f"after +3 +4 -2 the key holds 5, got {ctx.redis.get(KEY)!r}"


def check_ttl_on_create(ctx):
    m = ctx.load("best_effort")
    m.add_count("views", "trailer-7", 1)
    ttl = ctx.redis.ttl(KEY)
    assert ttl > 0, f"{KEY} has no expiry (TTL {ttl}): a best-effort counter must leave the cache on its own"
    assert 3600 - 5 <= ttl <= 3600, f"{KEY} expires in {ttl} s, expected TTL_S (3600)"
    ctx.clock.advance(3601)
    assert ctx.redis.exists(KEY) == 0, f"{KEY} must be gone after TTL_S"
    assert m.get_count("views", "trailer-7") == 0, "an expired counter reads as 0"
    assert m.add_count("views", "trailer-7", 2) == 2, "an add after expiry starts a fresh counter at the delta"
    assert 3600 - 5 <= ctx.redis.ttl(KEY) <= 3600, "the fresh counter gets a fresh TTL"


def check_pipelined(ctx):
    m = ctx.load("best_effort")
    m.add_count("views", "trailer-7", 1)
    ctx.clock.advance(1200)
    m.add_count("views", "trailer-7", 1)
    ttl = ctx.redis.ttl(KEY)
    assert ttl <= 3600 - 1200 + 5, f"20 minutes after creation a second add left the TTL at {ttl} s: the expiry was re-armed, so a busy counter would never expire"
    assert ttl >= 3600 - 1200 - 5, f"TTL is {ttl} s, expected about {3600 - 1200}"
    assert ctx.redis.get(KEY) == "2", "both adds must count"
    ctx.clock.advance(2401)
    assert ctx.redis.exists(KEY) == 0, "the counter expires 3600 s after its creation, regardless of later adds"
    # The counter's hour runs out in the middle of an add: only an add whose SET NX and INCRBY reach
    # Redis as one unit (a MULTI/EXEC pipeline) cannot leave a counter behind without an expiry.
    m.add_count("views", "trailer-7", 1)
    ctx.clock.advance(3599)
    probe = ctx.redis_after(KEY, lambda: ctx.clock.advance(2))
    m.add_count("views", "trailer-7", 1)
    assert probe.fired, f"add_count never touched {KEY}"
    ttl = ctx.redis.ttl(KEY)
    assert ttl != -1, f"the counter's hour ran out between the SET NX and the INCRBY of one add, and the INCRBY recreated {KEY} without any expiry (it now holds {ctx.redis.get(KEY)!r} forever): send both in one MULTI/EXEC pipeline so nothing lands between them"


def check_get_clear(ctx):
    m = ctx.load("best_effort")
    assert m.get_count("views", "trailer-7") == 0, "a counter that was never added to reads as 0, not nil and not an error"
    m.add_count("views", "trailer-7", 5)
    assert m.get_count("views", "trailer-7") == 5, "get_count returns the current count as an integer"
    assert isinstance(m.get_count("views", "trailer-7"), int), "get_count must return an int, not the raw string reply"
    m.clear_count("views", "trailer-7")
    assert ctx.redis.exists(KEY) == 0, f"clear_count must DEL {KEY}"
    assert m.get_count("views", "trailer-7") == 0, "a cleared counter reads as 0"
    m.clear_count("views", "never-existed")  # clearing an unknown counter is not an error
`,
    typescript: `const KEY = 'counter:views:trailer-7';

export async function check_key(ctx) {
  const m = ctx.load('best_effort');
  assert.equal(await m.addCount('views', 'trailer-7', 3), 3, 'the first add of 3 must return 3');
  assert.equal(ctx.redis.get(KEY), '3', \`the counter must live under \${KEY}, keys are \${JSON.stringify(ctx.redis.keys('*'))}\`);
  await m.addCount('views', 'trailer-8', 1);
  assert(ctx.redis.get('counter:views:trailer-8') === '1' && ctx.redis.get(KEY) === '3', 'each counter has its own key');
}

export async function check_incrby(ctx) {
  const m = ctx.load('best_effort');
  assert.equal(await m.addCount('views', 'trailer-7', 3), 3);
  assert.equal(await m.addCount('views', 'trailer-7', 4), 7, 'the second add returns the running count 7');
  assert.equal(await m.addCount('views', 'trailer-7', -2), 5, 'a negative delta decrements: expected 5');
  assert.equal(ctx.redis.get(KEY), '5', \`after +3 +4 -2 the key holds 5, got \${JSON.stringify(ctx.redis.get(KEY))}\`);
}

export async function check_ttl_on_create(ctx) {
  const m = ctx.load('best_effort');
  await m.addCount('views', 'trailer-7', 1);
  const ttl = ctx.redis.ttl(KEY);
  assert(ttl > 0, \`\${KEY} has no expiry (TTL \${ttl}): a best-effort counter must leave the cache on its own\`);
  assert(3600 - 5 <= ttl && ttl <= 3600, \`\${KEY} expires in \${ttl} s, expected TTL_S (3600)\`);
  ctx.clock.advance(3601);
  assert.equal(ctx.redis.exists(KEY), 0, \`\${KEY} must be gone after TTL_S\`);
  assert.equal(await m.getCount('views', 'trailer-7'), 0, 'an expired counter reads as 0');
  assert.equal(await m.addCount('views', 'trailer-7', 2), 2, 'an add after expiry starts a fresh counter at the delta');
  const fresh = ctx.redis.ttl(KEY);
  assert(3600 - 5 <= fresh && fresh <= 3600, 'the fresh counter gets a fresh TTL');
}

export async function check_pipelined(ctx) {
  const m = ctx.load('best_effort');
  await m.addCount('views', 'trailer-7', 1);
  ctx.clock.advance(1200);
  await m.addCount('views', 'trailer-7', 1);
  let ttl = ctx.redis.ttl(KEY);
  assert(ttl <= 3600 - 1200 + 5, \`20 minutes after creation a second add left the TTL at \${ttl} s: the expiry was re-armed, so a busy counter would never expire\`);
  assert(ttl >= 3600 - 1200 - 5, \`TTL is \${ttl} s, expected about \${3600 - 1200}\`);
  assert.equal(ctx.redis.get(KEY), '2', 'both adds must count');
  ctx.clock.advance(2401);
  assert.equal(ctx.redis.exists(KEY), 0, 'the counter expires 3600 s after its creation, regardless of later adds');
  // The counter's hour runs out in the middle of an add: only an add whose SET NX and INCRBY reach
  // Redis as one unit (a MULTI/EXEC pipeline) cannot leave a counter behind without an expiry.
  await m.addCount('views', 'trailer-7', 1);
  ctx.clock.advance(3599);
  let fired = false;
  ctx.redisAfter(KEY, () => {
    fired = true;
    ctx.clock.advance(2);
  });
  await m.addCount('views', 'trailer-7', 1);
  assert(fired, \`addCount never touched \${KEY}\`);
  ttl = ctx.redis.ttl(KEY);
  assert(ttl !== -1, \`the counter's hour ran out between the SET NX and the INCRBY of one add, and the INCRBY recreated \${KEY} without any expiry (it now holds \${JSON.stringify(ctx.redis.get(KEY))} forever): send both in one MULTI/EXEC pipeline so nothing lands between them\`);
}

export async function check_get_clear(ctx) {
  const m = ctx.load('best_effort');
  assert.equal(await m.getCount('views', 'trailer-7'), 0, 'a counter that was never added to reads as 0, not null and not an error');
  await m.addCount('views', 'trailer-7', 5);
  const count = await m.getCount('views', 'trailer-7');
  assert.equal(count, 5, 'getCount returns the current count as a number');
  assert.equal(typeof count, 'number', 'getCount must return a number, not the raw string reply');
  await m.clearCount('views', 'trailer-7');
  assert.equal(ctx.redis.exists(KEY), 0, \`clearCount must DEL \${KEY}\`);
  assert.equal(await m.getCount('views', 'trailer-7'), 0, 'a cleared counter reads as 0');
  await m.clearCount('views', 'never-existed'); // clearing an unknown counter is not an error
}
`,
  },
  debrief: `A best-effort counter is the cheapest thing that can be called a counter: one key, one atomic INCRBY, no log and no reconciliation. The subtle part is the lifetime. Memcached's incr (what Netflix's EVCache sits on) never touches a key's expiry, and this step reproduces that deliberately: the TTL is a configuration of the namespace, not a side effect of traffic, so a counter nobody reads anymore disappears on schedule and a counter everybody hits does too — the next add simply starts it again. Pipelining the SET NX with the INCRBY keeps the add at one round trip. Real deployments replicate the cache across regions, accept that replicas may disagree briefly, and reach for the eventually consistent kind the moment a number has to be right.`,
};
