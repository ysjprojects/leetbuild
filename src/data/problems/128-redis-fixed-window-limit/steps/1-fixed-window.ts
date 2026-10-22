import type {Step} from '@/lib/types';

export const fixedWindowStep: Step = {
  id: 'fixed-window',
  title: 'INCR a per-window key, EXPIRE it once, answer the TTL when full',
  concept: 'redis',
  file: 'rate_limit',
  focus: ['gateway', 'redis'],
  task: `## Task

Implement \`allow(client_id) -> (allowed, retry_after_s)\`: at most \`LIMIT = 100\` requests per client
per fixed \`WINDOW_S = 60\`-second window, counted in Redis so every worker of the gateway shares the
same count.

- \`window = now // WINDOW_S\` (integer division of the current time in seconds); the key is
  \`rl:{client_id}:{window}\` — one counter per client per window, never a shared one.
- \`INCR\` the key and keep the number it returns. When it is **1** this request created the key:
  \`EXPIRE\` it for \`WINDOW_S\` seconds, so a key nobody touches again disappears on its own. Later hits
  do **not** touch the TTL — the window ends when it ends.
- The request is **allowed** while the count is \`<= LIMIT\`; answer \`(True, 0)\`.
- Otherwise **deny** with \`retry_after_s = TTL\` of the key, and never less than 1 — \`(False, ttl)\`.
- Never \`GET\` the count and \`SET\` it back: two workers would both read 99 and both write 100. The
  increment happens on the server, in one command, or it is not a count.

> One \`INCR\` on a key whose name already contains the window is the whole algorithm: the server
> serialises the increments, the name does the bucketing, the TTL does the cleanup.`,
  sequence: {
    participants: ['gateway', 'Redis'],
    messages: [
      {from: 'gateway', to: 'Redis', label: 'INCR rl:alice:29876', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '1 — first hit of the window', kind: 'reply'},
      {from: 'gateway', to: 'Redis', label: 'EXPIRE rl:alice:29876 60', kind: 'sync'},
      {from: 'gateway', to: 'gateway', label: '1 ≤ 100 → (true, 0)', kind: 'sync'},
      {from: 'gateway', to: 'Redis', label: 'INCR rl:alice:29876 (request 101)', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '101', kind: 'reply'},
      {from: 'gateway', to: 'Redis', label: 'TTL rl:alice:29876', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '43', kind: 'reply'},
      {from: 'gateway', to: 'gateway', label: '101 > 100 → (false, 43)', kind: 'sync'},
    ],
  },
  hints: [
    'The key name does the bucketing: `rl:{client_id}:{int(time.time() // 60)}`. A new minute is a new key that starts at zero; you never reset anything.',
    '`INCR` returns the new value. That one number tells you everything: `1` means you created the key (set the TTL now), anything above `LIMIT` means deny.',
    'On a deny, read `TTL key` and hand it back as `retry_after_s`; clamp it to at least 1 so a caller never retries immediately.',
  ],
  checks: [
    {
      id: 'limit',
      title: 'Admits LIMIT requests per window and denies the next',
      detail:
        'In a fresh window the first 100 calls for one client answer `(True, 0)`; the 101st and every call after it answer `(False, …)` until the window ends, and the count lives in `rl:{client_id}:{window}`.',
      match: {
        python: {all: [/\.incr\(/, /<=\s*LIMIT|>\s*LIMIT/]},
        typescript: {all: [/\.incr\(/, /<=\s*LIMIT|>\s*LIMIT/]},
        go: {all: [/\.Incr\(/, /<=\s*limit|>\s*limit/]},
        scala: {all: [/\.incr\(/, /<=\s*Limit|>\s*Limit/]},
        cpp: {all: [/\.incr\(/, /<=\s*kLimit|>\s*kLimit/]},
      },
    },
    {
      id: 'retry-after',
      title: 'A denied call answers the window’s remaining TTL, at least 1',
      detail:
        '`retry_after_s` equals `TTL rl:{client_id}:{window}` at the moment of the deny: about 60 right after the window filled, about 43 seventeen seconds later, and still at least 1 — never 0 — in the window’s last second.',
      match: {
        python: {all: [/\.ttl\(/, /max\(/]},
        typescript: {all: [/\.ttl\(/, /Math\.max\(/]},
        go: {all: [/\.TTL\(/, /retry < 1/]},
        scala: {all: [/\.ttl\(/, /math\.max\(/]},
        cpp: {all: [/\.ttl\(/, /std::max/]},
      },
    },
    {
      id: 'window-rolls',
      title: 'The next window admits a full LIMIT again',
      detail:
        'Once the clock crosses the next multiple of 60 seconds, a client that was denied is allowed again, counted from 1 in `rl:{client_id}:{window + 1}`, and gets another 100 before the next deny.',
      match: {
        python: {all: [/time\.time\(\)/, /\/\/\s*WINDOW_S/]},
        typescript: {all: [/Date\.now\(\)/, /\/\s*WINDOW_S/]},
        go: {all: [/time\.Now\(\)/, /\/\s*windowS/]},
        scala: {all: [/System\.currentTimeMillis\(\)/, /\/\s*WindowSeconds/]},
        cpp: {all: [/std::time\(nullptr\)/, /\/\s*kWindowS/]},
      },
    },
    {
      id: 'ttl-set',
      title: 'The key carries a 60 s TTL from its first hit, and later hits leave it alone',
      detail:
        'After the first call the key exists with value `1` and a TTL in `(0, 60]`; it is never left without a TTL; thirty seconds and ten more hits later the TTL is about 30 — hits after the first do not re-arm it.',
      match: {
        python: {all: [/\.expire\(/, /==\s*1/]},
        typescript: {all: [/\.expire\(/, /===\s*1/]},
        go: {all: [/\.Expire\(/, /==\s*1/]},
        scala: {all: [/\.expire\(/, /==\s*1/]},
        cpp: {all: [/\.expire\(/, /==\s*1/]},
      },
    },
    {
      id: 'per-client',
      title: 'Clients do not share a counter',
      detail:
        'With one client’s window full, another client’s first call is allowed and lands in its own key `rl:{other}:{window}` with value `1`; the first client stays denied.',
      match: {
        python: {all: [/f"rl:\{client_id\}:\{window\}"/]},
        typescript: {all: [/`rl:\$\{clientId\}:\$\{window\}`/]},
        go: {all: [/"rl:%s:%d"/]},
        scala: {all: [/s"rl:\$clientId:\$window"/]},
        cpp: {all: [/"rl:" \+ client_id \+ ":" \+ std::to_string\(window\)/]},
      },
    },
    {
      id: 'atomic-incr',
      title: 'Counting is one INCR on the server, not GET then SET',
      detail:
        'A request from another worker that lands right after this worker’s first command on the key must still be counted: the key then holds `2`, and this worker is denied one call earlier because the other worker used a slot. A read-modify-write loses that update.',
      match: {
        python: {all: [/\.incr\(/], none: [/r\.get\(/, /r\.set\(/]},
        typescript: {all: [/\.incr\(/], none: [/redis\.get\(/, /redis\.set\(/]},
        go: {all: [/\.Incr\(/], none: [/rdb\.Get\(/, /rdb\.Set\(/]},
        scala: {all: [/\.incr\(/], none: [/jedis\.get\(/, /jedis\.set\(/]},
        cpp: {all: [/\.incr\(/], none: [/redis\.get\(/, /redis\.set\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Fixed-window rate limit: one INCR per request on a key named after the client and the window."""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT = 100
WINDOW_S = 60


def allow(client_id: str) -> tuple[bool, int]:
    """(allowed, retry_after_s): at most LIMIT requests per client per WINDOW_S-second window."""
    # TODO: window = now divided by WINDOW_S; INCR rl:{client_id}:{window}; EXPIRE WINDOW_S when the
    # count came back 1; allowed while the count is at or below LIMIT; otherwise (False, TTL of the key, at least 1)
    raise NotImplementedError
`,
      solution: `"""Fixed-window rate limit: one INCR per request on a key named after the client and the window."""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT = 100
WINDOW_S = 60


def allow(client_id: str) -> tuple[bool, int]:
    """(allowed, retry_after_s): at most LIMIT requests per client per WINDOW_S-second window."""
    window = int(time.time() // WINDOW_S)
    key = f"rl:{client_id}:{window}"
    count = r.incr(key)
    if count == 1:
        r.expire(key, WINDOW_S)  # the first hit arms the window; later hits leave the TTL alone
    if count <= LIMIT:
        return True, 0
    return False, max(r.ttl(key), 1)
`,
    },
    typescript: {
      starter: `/** Fixed-window rate limit: one INCR per request on a key named after the client and the window. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LIMIT = 100;
export const WINDOW_S = 60;

/** [allowed, retryAfterS]: at most LIMIT requests per client per WINDOW_S-second window. */
export async function allow(clientId: string): Promise<[boolean, number]> {
  // TODO: window = now divided by WINDOW_S; INCR rl:{clientId}:{window}; EXPIRE WINDOW_S when the
  // count came back 1; allowed while the count is at or below LIMIT; otherwise [false, TTL of the key, at least 1]
  throw new Error('not implemented');
}
`,
      solution: `/** Fixed-window rate limit: one INCR per request on a key named after the client and the window. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LIMIT = 100;
export const WINDOW_S = 60;

/** [allowed, retryAfterS]: at most LIMIT requests per client per WINDOW_S-second window. */
export async function allow(clientId: string): Promise<[boolean, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const key = \`rl:\${clientId}:\${window}\`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_S); // the first hit arms the window; later hits leave the TTL alone
  if (count <= LIMIT) return [true, 0];
  return [false, Math.max(await redis.ttl(key), 1)];
}
`,
    },
    go: {
      starter: `// Fixed-window rate limit: one INCR per request on a key named after the client and the window.
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit   = 100
	windowS = 60
)

// allow answers (allowed, retryAfterS): at most limit requests per client per windowS-second window.
func allow(ctx context.Context, clientID string) (bool, int, error) {
	// TODO: window = now divided by windowS; INCR rl:{clientID}:{window}; EXPIRE windowS when the
	// count came back 1; allowed while the count is at or below limit; otherwise (false, TTL of the key, at least 1)
	panic("not implemented")
}

func main() {
	ctx := context.Background()
	_ = time.Now
	for i := 0; i < 3; i++ {
		allowed, retry, err := allow(ctx, "demo")
		if err != nil {
			panic(err)
		}
		fmt.Println(allowed, retry)
	}
}
`,
      solution: `// Fixed-window rate limit: one INCR per request on a key named after the client and the window.
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit   = 100
	windowS = 60
)

// allow answers (allowed, retryAfterS): at most limit requests per client per windowS-second window.
func allow(ctx context.Context, clientID string) (bool, int, error) {
	window := time.Now().Unix() / windowS
	key := fmt.Sprintf("rl:%s:%d", clientID, window)
	count, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return false, 0, err
	}
	if count == 1 {
		// The first hit arms the window; later hits leave the TTL alone.
		if err := rdb.Expire(ctx, key, windowS*time.Second).Err(); err != nil {
			return false, 0, err
		}
	}
	if count <= limit {
		return true, 0, nil
	}
	ttl, err := rdb.TTL(ctx, key).Result()
	if err != nil {
		return false, 0, err
	}
	retry := int(ttl.Seconds())
	if retry < 1 {
		retry = 1
	}
	return false, retry, nil
}

func main() {
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		allowed, retry, err := allow(ctx, "demo")
		if err != nil {
			panic(err)
		}
		fmt.Println(allowed, retry)
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

/** Fixed-window rate limit: one INCR per request on a key named after the client and the window. */
object RateLimit {
  val jedis = new JedisPooled("redis", 6379)
  val Limit = 100
  val WindowSeconds = 60

  /** (allowed, retryAfterSeconds): at most Limit requests per client per WindowSeconds-second window. */
  def allow(clientId: String): (Boolean, Int) = {
    ??? // TODO: window = now divided by WindowSeconds; INCR rl:{clientId}:{window}; EXPIRE WindowSeconds when the
    //         count came back 1; allowed while the count is at or below Limit; otherwise (false, TTL of the key, at least 1)
  }

  def main(args: Array[String]): Unit =
    (1 to 3).foreach(_ => println(allow("demo")))
}
`,
      solution: `import redis.clients.jedis.JedisPooled

/** Fixed-window rate limit: one INCR per request on a key named after the client and the window. */
object RateLimit {
  val jedis = new JedisPooled("redis", 6379)
  val Limit = 100
  val WindowSeconds = 60

  /** (allowed, retryAfterSeconds): at most Limit requests per client per WindowSeconds-second window. */
  def allow(clientId: String): (Boolean, Int) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val key = s"rl:$clientId:$window"
    val count = jedis.incr(key)
    if (count == 1) jedis.expire(key, WindowSeconds.toLong) // the first hit arms the window; later hits leave the TTL alone
    if (count <= Limit) (true, 0)
    else (false, math.max(jedis.ttl(key).toInt, 1))
  }

  def main(args: Array[String]): Unit =
    (1 to 3).foreach(_ => println(allow("demo")))
}
`,
    },
    cpp: {
      starter: `// Fixed-window rate limit: one INCR per request on a key named after the client and the window.
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <ctime>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 100;
constexpr long long kWindowS = 60;

// {allowed, retry_after_s}: at most kLimit requests per client per kWindowS-second window.
std::pair<bool, int> allow(const std::string& client_id) {
  // TODO: window = now divided by kWindowS; INCR rl:{client_id}:{window}; EXPIRE kWindowS when the
  // count came back 1; allowed while the count is at or below kLimit; otherwise {false, TTL of the key, at least 1}
  throw std::logic_error("not implemented");
}

int main() {
  for (int i = 0; i < 3; ++i) {
    const auto [allowed, retry] = allow("demo");
    std::cout << allowed << ' ' << retry << '\\n';
  }
}
`,
      solution: `// Fixed-window rate limit: one INCR per request on a key named after the client and the window.
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <ctime>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 100;
constexpr long long kWindowS = 60;

// {allowed, retry_after_s}: at most kLimit requests per client per kWindowS-second window.
std::pair<bool, int> allow(const std::string& client_id) {
  const long long window = static_cast<long long>(std::time(nullptr)) / kWindowS;
  const std::string key = "rl:" + client_id + ":" + std::to_string(window);
  const long long count = redis.incr(key);
  if (count == 1) redis.expire(key, std::chrono::seconds(kWindowS));  // the first hit arms the window
  if (count <= kLimit) return {true, 0};
  return {false, static_cast<int>(std::max<long long>(redis.ttl(key), 1))};
}

int main() {
  for (int i = 0; i < 3; ++i) {
    const auto [allowed, retry] = allow("demo");
    std::cout << allowed << ' ' << retry << '\\n';
  }
}
`,
    },
  },
  harness: {
    python: `import time

LIMIT = 100
WINDOW = 60


def align(ctx):
    """Park the clock one second into a window so a check's hundred calls never straddle a boundary; returns the window number."""
    ctx.clock.advance(WINDOW - (time.time() % WINDOW) + 1)
    return int(time.time() // WINDOW)


def key(client, window):
    return f"rl:{client}:{window}"


def fill(m, client):
    """LIMIT calls, every one of which must be allowed."""
    for i in range(LIMIT):
        allowed, retry = m.allow(client)
        assert allowed is True, f"call {i + 1} of {LIMIT} for {client!r} in a fresh window must be allowed, it was denied (retry_after_s {retry})"
        assert retry == 0, f"an allowed call answers retry_after_s 0; call {i + 1} for {client!r} answered {retry}"


def check_limit(ctx):
    window = align(ctx)
    m = ctx.load("rate_limit")
    fill(m, "alice")
    allowed, retry = m.allow("alice")
    assert allowed is False, f"call {LIMIT + 1} must be denied: the limit is {LIMIT} per 60-second window"
    assert isinstance(retry, int) and retry >= 1, f"a denied call answers retry_after_s as an integer of at least 1, got {retry!r}"
    allowed, _ = m.allow("alice")
    assert allowed is False, "every call past the limit stays denied until the window ends"
    count = ctx.redis.get(key("alice", window))
    assert count is not None and int(count) >= LIMIT, f"the count must live in rl:alice:{window}; it holds {count!r}"


def check_retry_after(ctx):
    window = align(ctx)
    m = ctx.load("rate_limit")
    k = key("bob", window)
    fill(m, "bob")
    allowed, retry = m.allow("bob")
    ttl = ctx.redis.ttl(k)
    assert allowed is False
    assert abs(retry - ttl) <= 1, f"retry_after_s must be the key's TTL ({ttl} s left on {k}), it was {retry}"
    ctx.clock.advance(17)
    allowed, retry = m.allow("bob")
    ttl = ctx.redis.ttl(k)
    assert allowed is False, "17 s into a full window the client is still denied"
    assert abs(retry - ttl) <= 1 and 41 <= retry <= 44, f"17 s later about 43 s are left; retry_after_s was {retry} (TTL {ttl})"
    ctx.clock.advance(WINDOW - 0.4 - time.time() % WINDOW)
    allowed, retry = m.allow("bob")
    ttl = ctx.redis.ttl(k)
    assert allowed is False, "400 ms before the window ends it is still full"
    assert retry >= 1 and abs(retry - ttl) <= 1, f"in the window's last second retry_after_s is still the TTL ({ttl}) and never 0 — a caller must not retry at once; got {retry}"


def check_window_rolls(ctx):
    window = align(ctx)
    m = ctx.load("rate_limit")
    fill(m, "carol")
    assert m.allow("carol")[0] is False
    ctx.clock.advance(WINDOW)
    allowed, retry = m.allow("carol")
    assert allowed is True, "60 s later a new window has started: carol's first call in it must be allowed"
    assert retry == 0
    fresh = ctx.redis.get(key("carol", window + 1))
    assert fresh == "1", f"the new window counts from 1 in its own key rl:carol:{window + 1}; it holds {fresh!r}"
    for i in range(LIMIT - 1):
        assert m.allow("carol")[0] is True, f"the new window admits a full {LIMIT} again; call {i + 2} was denied"
    assert m.allow("carol")[0] is False, f"call {LIMIT + 1} of the new window is denied like the old one's"


def check_ttl_set(ctx):
    window = align(ctx)
    m = ctx.load("rate_limit")
    k = key("dan", window)
    m.allow("dan")
    assert ctx.redis.get(k) == "1", f"after one call {k} must hold 1, it holds {ctx.redis.get(k)!r}"
    ttl = ctx.redis.ttl(k)
    assert ttl != -1, f"{k} has no TTL: a counter without an expiry never goes away, and the client it belongs to stays blocked forever once it fills"
    assert 0 < ttl <= WINDOW, f"the first hit sets a TTL of {WINDOW} s; {k} has {ttl}"
    ctx.clock.advance(30)
    for _ in range(10):
        m.allow("dan")
    ttl = ctx.redis.ttl(k)
    assert 0 < ttl <= WINDOW - 30 + 1, f"30 s and ten hits later about 30 s should be left on {k}, not {ttl}: only the hit that created the key sets the TTL, later hits must not re-arm it"


def check_per_client(ctx):
    window = align(ctx)
    m = ctx.load("rate_limit")
    fill(m, "erin")
    assert m.allow("erin")[0] is False
    allowed, retry = m.allow("frank")
    assert allowed is True, "frank has made no requests; erin's full window must not block him"
    assert retry == 0
    assert ctx.redis.get(key("frank", window)) == "1", f"frank's count lives in rl:frank:{window} and starts at 1; it holds {ctx.redis.get(key('frank', window))!r}"
    assert int(ctx.redis.get(key("erin", window))) >= LIMIT, "frank's call must not touch erin's counter"
    assert m.allow("erin")[0] is False, "erin stays denied after frank's call"


def check_atomic_incr(ctx):
    window = align(ctx)
    m = ctx.load("rate_limit")
    k = key("gus", window)
    probe = ctx.redis_after(k, lambda: ctx.redis.incr(k))
    allowed, _ = m.allow("gus")
    assert probe.fired, f"allow('gus') never touched {k}: the count must live in that key"
    assert allowed is True, "the first call of a window is allowed even when another worker's request lands right behind it"
    held = ctx.redis.get(k)
    assert held == "2", f"after allow('gus') plus one concurrent request from another worker {k} must hold 2, it holds {held!r}: a GET-then-SET overwrote the other worker's increment"
    for i in range(LIMIT - 2):
        assert m.allow("gus")[0] is True, f"call {i + 3} of the window (counting the other worker's) must be allowed"
    allowed, _ = m.allow("gus")
    assert allowed is False, f"the other worker used one slot, so this is request {LIMIT + 1} of the window: it must be denied — a lost update would let it through"
    assert int(ctx.redis.get(k)) >= LIMIT, f"{k} must have counted every request, it holds {ctx.redis.get(k)!r}"
`,
    typescript: `const LIMIT = 100;
const WINDOW = 60;

/** Park the clock one second into a window so a check's hundred calls never straddle a boundary; returns the window number. */
function align(ctx): number {
  const nowS = ctx.clock.now() / 1000;
  ctx.clock.advance(WINDOW - (nowS % WINDOW) + 1);
  return Math.floor(ctx.clock.now() / 1000 / WINDOW);
}

const key = (client: string, window: number) => \`rl:\${client}:\${window}\`;

/** LIMIT calls, every one of which must be allowed. */
async function fill(m, client: string) {
  for (let i = 0; i < LIMIT; i++) {
    const [allowed, retry] = await m.allow(client);
    assert.equal(allowed, true, \`call \${i + 1} of \${LIMIT} for '\${client}' in a fresh window must be allowed, it was denied (retryAfterS \${retry})\`);
    assert.equal(retry, 0, \`an allowed call answers retryAfterS 0; call \${i + 1} for '\${client}' answered \${retry}\`);
  }
}

export async function check_limit(ctx) {
  const window = align(ctx);
  const m = ctx.load('rate_limit');
  await fill(m, 'alice');
  let [allowed, retry] = await m.allow('alice');
  assert.equal(allowed, false, \`call \${LIMIT + 1} must be denied: the limit is \${LIMIT} per 60-second window\`);
  assert(Number.isInteger(retry) && retry >= 1, \`a denied call answers retryAfterS as an integer of at least 1, got \${JSON.stringify(retry)}\`);
  [allowed] = await m.allow('alice');
  assert.equal(allowed, false, 'every call past the limit stays denied until the window ends');
  const count = ctx.redis.get(key('alice', window));
  assert(count !== null && Number(count) >= LIMIT, \`the count must live in rl:alice:\${window}; it holds \${JSON.stringify(count)}\`);
}

export async function check_retry_after(ctx) {
  const window = align(ctx);
  const m = ctx.load('rate_limit');
  const k = key('bob', window);
  await fill(m, 'bob');
  let [allowed, retry] = await m.allow('bob');
  let ttl = ctx.redis.ttl(k) as number;
  assert.equal(allowed, false);
  assert(Math.abs(retry - ttl) <= 1, \`retryAfterS must be the key's TTL (\${ttl} s left on \${k}), it was \${retry}\`);
  ctx.clock.advance(17);
  [allowed, retry] = await m.allow('bob');
  ttl = ctx.redis.ttl(k) as number;
  assert.equal(allowed, false, '17 s into a full window the client is still denied');
  assert(Math.abs(retry - ttl) <= 1 && 41 <= retry && retry <= 44, \`17 s later about 43 s are left; retryAfterS was \${retry} (TTL \${ttl})\`);
  ctx.clock.advance(WINDOW - 0.4 - ((ctx.clock.now() / 1000) % WINDOW));
  [allowed, retry] = await m.allow('bob');
  ttl = ctx.redis.ttl(k) as number;
  assert.equal(allowed, false, '400 ms before the window ends it is still full');
  assert(retry >= 1 && Math.abs(retry - ttl) <= 1, \`in the window's last second retryAfterS is still the TTL (\${ttl}) and never 0 — a caller must not retry at once; got \${retry}\`);
}

export async function check_window_rolls(ctx) {
  const window = align(ctx);
  const m = ctx.load('rate_limit');
  await fill(m, 'carol');
  assert.equal((await m.allow('carol'))[0], false);
  ctx.clock.advance(WINDOW);
  const [allowed, retry] = await m.allow('carol');
  assert.equal(allowed, true, "60 s later a new window has started: carol's first call in it must be allowed");
  assert.equal(retry, 0);
  const fresh = ctx.redis.get(key('carol', window + 1));
  assert.equal(fresh, '1', \`the new window counts from 1 in its own key rl:carol:\${window + 1}; it holds \${JSON.stringify(fresh)}\`);
  for (let i = 0; i < LIMIT - 1; i++) {
    assert.equal((await m.allow('carol'))[0], true, \`the new window admits a full \${LIMIT} again; call \${i + 2} was denied\`);
  }
  assert.equal((await m.allow('carol'))[0], false, \`call \${LIMIT + 1} of the new window is denied like the old one's\`);
}

export async function check_ttl_set(ctx) {
  const window = align(ctx);
  const m = ctx.load('rate_limit');
  const k = key('dan', window);
  await m.allow('dan');
  assert.equal(ctx.redis.get(k), '1', \`after one call \${k} must hold 1, it holds \${JSON.stringify(ctx.redis.get(k))}\`);
  let ttl = ctx.redis.ttl(k) as number;
  assert.notEqual(ttl, -1, \`\${k} has no TTL: a counter without an expiry never goes away, and the client it belongs to stays blocked forever once it fills\`);
  assert(0 < ttl && ttl <= WINDOW, \`the first hit sets a TTL of \${WINDOW} s; \${k} has \${ttl}\`);
  ctx.clock.advance(30);
  for (let i = 0; i < 10; i++) await m.allow('dan');
  ttl = ctx.redis.ttl(k) as number;
  assert(0 < ttl && ttl <= WINDOW - 30 + 1, \`30 s and ten hits later about 30 s should be left on \${k}, not \${ttl}: only the hit that created the key sets the TTL, later hits must not re-arm it\`);
}

export async function check_per_client(ctx) {
  const window = align(ctx);
  const m = ctx.load('rate_limit');
  await fill(m, 'erin');
  assert.equal((await m.allow('erin'))[0], false);
  const [allowed, retry] = await m.allow('frank');
  assert.equal(allowed, true, "frank has made no requests; erin's full window must not block him");
  assert.equal(retry, 0);
  assert.equal(ctx.redis.get(key('frank', window)), '1', \`frank's count lives in rl:frank:\${window} and starts at 1; it holds \${JSON.stringify(ctx.redis.get(key('frank', window)))}\`);
  assert(Number(ctx.redis.get(key('erin', window))) >= LIMIT, "frank's call must not touch erin's counter");
  assert.equal((await m.allow('erin'))[0], false, "erin stays denied after frank's call");
}

export async function check_atomic_incr(ctx) {
  const window = align(ctx);
  const m = ctx.load('rate_limit');
  const k = key('gus', window);
  const probe = ctx.redisAfter(k, () => ctx.redis.incr(k));
  const [allowed] = await m.allow('gus');
  assert(probe.fired, \`allow('gus') never touched \${k}: the count must live in that key\`);
  assert.equal(allowed, true, "the first call of a window is allowed even when another worker's request lands right behind it");
  const held = ctx.redis.get(k);
  assert.equal(held, '2', \`after allow('gus') plus one concurrent request from another worker \${k} must hold 2, it holds \${JSON.stringify(held)}: a GET-then-SET overwrote the other worker's increment\`);
  for (let i = 0; i < LIMIT - 2; i++) {
    assert.equal((await m.allow('gus'))[0], true, \`call \${i + 3} of the window (counting the other worker's) must be allowed\`);
  }
  const [denied] = await m.allow('gus');
  assert.equal(denied, false, \`the other worker used one slot, so this is request \${LIMIT + 1} of the window: it must be denied — a lost update would let it through\`);
  assert(Number(ctx.redis.get(k)) >= LIMIT, \`\${k} must have counted every request, it holds \${JSON.stringify(ctx.redis.get(k))}\`);
}
`,
  },
  debrief: `Everything hangs on where the increment happens. \`INCR\` runs on the server, single-threaded, so a hundred gateway workers hammering one client's key produce one correct count with no lock and no read-modify-write; \`GET\` then \`SET\` would let two workers both see 99 and both write 100, which is exactly the lost update the race check lands. The window lives in the key **name**, so nothing is ever reset: a new minute is a new key that starts from nothing, and the old one is garbage the moment its TTL fires — which is why the TTL is set on the hit that returns 1 and never touched again (re-arming it on every hit would keep a busy client's key alive forever and extend nothing useful). Answering \`TTL\` as \`retry_after_s\` costs one extra command on the deny path only, and clamping it to 1 keeps a client from retrying inside the same second. Real systems add two things: a Lua script or \`SET key 0 EX 60 NX\` before the \`INCR\` so a crash between \`INCR\` and \`EXPIRE\` cannot leave a key without a TTL, and a **sliding** window (or a token bucket) when the boundary burst — 100 requests at 0:59 and 100 more at 1:00 — is not acceptable.`,
};
