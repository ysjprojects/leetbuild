import type {Step} from '@/lib/types';

export const fillLockStep: Step = {
  id: 'fill-lock',
  title: 'Cache-aside: one key, one lock, one load',
  concept: 'redis',
  file: 'product_cache',
  focus: ['app', 'redis'],
  task: `## Task

Implement \`get_product(product_id, load)\` and \`invalidate(product_id)\` over two keys: \`product:{id}\` holds the
product as JSON, \`lock:product:{id}\` is held by whoever is filling it. \`load(product_id)\` is the slow source —
it returns the product (a dict/object) or \`None\` when there is no such product, and may raise.

- **Hit**: \`GET product:{id}\`. JSON → return it decoded. The sentinel \`__missing__\` → return \`None\` without
  calling \`load\`.
- **Miss**: \`SET lock:product:{id} 1 NX EX 5\` (\`LOCK_TTL_S = 5\`). The caller that **wins** the lock \`GET\`s the key
  once more (a loser may have just filled it), and only on a second miss calls \`load\`. A product is written
  with \`SET product:{id} <json> EX 3600\` (\`TTL_S\`); \`None\` is written as \`__missing__\` with \`EX 60\`
  (\`MISSING_TTL_S\`). The lock is deleted afterwards — **always**, also when \`load\` raises, and the error is
  re-raised.
- A caller that **loses** the lock sleeps \`POLL_S = 0.05\` s and \`GET\`s the key, repeatedly, for at most
  \`LOCK_TTL_S\`; the first value it sees is its answer. If nothing appears by then, the lock has expired with
  its holder: start over from the miss.
- \`invalidate(product_id)\` deletes \`product:{id}\`. The next call loads.
- The stored JSON is exactly what \`load\` returned; nothing is added or renamed.

:::widget cache-aside {"stampede": true}

> One \`SET NX EX\` is the whole stampede defence: the winner pays the load, the losers pay a few 50 ms
> sleeps, and the database sees one query per key per hour — or per minute, for products that do not exist.`,
  sequence: {
    participants: ['req A', 'req B', 'Redis', 'source'],
    messages: [
      {from: 'req A', to: 'Redis', label: 'GET product:42', kind: 'sync'},
      {from: 'Redis', to: 'req A', label: '(nil)', kind: 'reply'},
      {from: 'req A', to: 'Redis', label: 'SET lock:product:42 1 NX EX 5', kind: 'sync'},
      {from: 'Redis', to: 'req A', label: 'OK — A fills', kind: 'reply'},
      {from: 'req B', to: 'Redis', label: 'GET product:42 → nil · SET lock NX → nil', kind: 'sync'},
      {from: 'Redis', to: 'req B', label: 'B lost: sleep 50 ms, GET again', kind: 'reply'},
      {from: 'req A', to: 'Redis', label: 'GET product:42 (still nil)', kind: 'sync'},
      {from: 'req A', to: 'source', label: 'load(42)', kind: 'sync'},
      {from: 'source', to: 'req A', label: '{"id": 42, …} or None', kind: 'reply'},
      {
        from: 'req A',
        to: 'Redis',
        label: 'SET product:42 <json> EX 3600 (or __missing__ EX 60) · DEL lock',
        kind: 'sync',
      },
      {from: 'req B', to: 'Redis', label: 'GET product:42', kind: 'sync'},
      {from: 'Redis', to: 'req B', label: '{"id": 42, …} — no load', kind: 'reply'},
    ],
  },
  hints: [
    'Write the hit path first: `GET`, then three cases — nothing, the sentinel string, JSON. Every other path ends by going through it again.',
    '`SET key 1 NX EX 5` is one atomic command; its reply (OK or nil) is the whole election. Put the load and the writes in a `try`, the `DEL` of the lock in `finally`, and `GET` once more right after winning: the loser who finished a moment ago may have filled the key.',
    'The loser’s loop is `sleep(0.05)` then `GET`, with a deadline `LOCK_TTL_S` ahead on the monotonic clock; when the deadline passes with no value, the holder died and its lock expired — call yourself again.',
  ],
  checks: [
    {
      id: 'miss-then-hit',
      title: 'A miss loads once; the hit serves the JSON until the TTL',
      detail:
        'The first call loads and writes `product:{id}` with the exact JSON `load` returned and a TTL of 3600 s; a second call returns the same product without calling `load`; once the TTL has passed, the next call loads again.',
      match: {
        python: {all: [/r\.get\(key\)/, /json\.dumps\(product\),\s*ex=TTL_S/]},
        typescript: {all: [/redis\.get\(key\)/, /JSON\.stringify\(product\),\s*'EX',\s*TTL_S/]},
        go: {all: [/rdb\.Get\(ctx, key\)/, /rdb\.Set\(ctx, key, body, ttl\)/]},
        scala: {all: [/jedis\.get\(key\)/, /jedis\.setex\(key, TtlSeconds, product\.compactPrint\)/]},
        cpp: {all: [/redis\.get\(key\)/, /redis\.set\(key, product->dump\(\), kTtl\)/]},
      },
    },
    {
      id: 'negative-cache',
      title: 'A missing product is cached as the sentinel for 60 s',
      detail:
        'When `load` returns nothing, `product:{id}` holds `__missing__` with a TTL of 60 s and the next calls answer `None` without calling `load`; after 60 s the source is asked again.',
      match: {
        python: {all: [/MISSING,\s*ex=MISSING_TTL_S/, /== MISSING/]},
        typescript: {all: [/MISSING,\s*'EX',\s*MISSING_TTL_S/, /=== MISSING/]},
        go: {all: [/rdb\.Set\(ctx, key, missing, missingTTL\)/, /== missing/]},
        scala: {all: [/jedis\.setex\(key, MissingTtlSeconds, Missing\)/, /== Missing/]},
        cpp: {all: [/redis\.set\(key, kMissing, kMissingTtl\)/, /== kMissing/]},
      },
    },
    {
      id: 'invalidate',
      title: 'invalidate deletes the key so the next call loads',
      detail:
        '`invalidate(id)` removes `product:{id}` — a product or the sentinel — and the next `get_product` goes to the source and caches what it finds; invalidating an unknown id is harmless.',
      match: {
        python: {all: [/def invalidate\([\s\S]*?r\.delete\(/]},
        typescript: {all: [/export async function invalidate\([\s\S]*?redis\.del\(/]},
        go: {all: [/func invalidate\([\s\S]*?rdb\.Del\(/]},
        scala: {all: [/def invalidate\([\s\S]*?jedis\.del\(/]},
        cpp: {all: [/void invalidate\([\s\S]*?redis\.del\(/]},
      },
    },
    {
      id: 'single-flight',
      title: 'Concurrent misses load once',
      detail:
        'Two callers missing the same key at the same moment call `load` once: the lock is `SET NX EX 5`, the winner re-reads the key after winning, the loser polls every 50 ms and returns what the winner wrote; no lock is left behind.',
      match: {
        python: {all: [/nx=True,\s*ex=LOCK_TTL_S/, /time\.sleep\(POLL_S\)/, /r\.get\(key\)[\s\S]*r\.get\(key\)/]},
        typescript: {
          all: [/'EX',\s*LOCK_TTL_S,\s*'NX'/, /sleep\(POLL_MS\)/, /redis\.get\(key\)[\s\S]*redis\.get\(key\)/],
        },
        go: {
          all: [
            /rdb\.SetNX\(ctx, lock, "1", lockTTL\)/,
            /time\.Sleep\(poll\)/,
            /rdb\.Get\(ctx, key\)[\s\S]*rdb\.Get\(ctx, key\)/,
          ],
        },
        scala: {
          all: [
            /\.nx\(\)\.ex\(LockTtlSeconds\)/,
            /Thread\.sleep\(PollMillis\)/,
            /jedis\.get\(key\)[\s\S]*jedis\.get\(key\)/,
          ],
        },
        cpp: {
          all: [
            /kLockTtl, sw::redis::UpdateType::NOT_EXIST/,
            /std::this_thread::sleep_for\(kPoll\)/,
            /redis\.get\(key\)[\s\S]*redis\.get\(key\)/,
          ],
        },
      },
    },
    {
      id: 'lock-released',
      title: 'A failed fill releases the lock and re-raises',
      detail:
        'When `load` raises, the error reaches the caller, nothing is cached, and `lock:product:{id}` is gone, so the very next call can take the lock and load.',
      match: {
        python: {order: [/try:/, /load\(product_id\)/, /finally:/, /r\.delete\(lock\)/]},
        typescript: {order: [/try \{/, /await load\(productId\)/, /finally \{/, /redis\.del\(lock\)/]},
        go: {order: [/defer rdb\.Del\(ctx, lock\)/, /load\(productID\)/]},
        scala: {order: [/try \{/, /load\(productId\)/, /finally jedis\.del\(lock\)/]},
        cpp: {order: [/try \{/, /load\(product_id\)/, /catch \(\.\.\.\)/, /redis\.del\(lock\)/]},
      },
    },
    {
      id: 'stale-lock',
      title: 'A loser waits at most the lock TTL, then takes over',
      detail:
        'With a lock left by a holder that died, a caller polls for `LOCK_TTL_S` (5 s of virtual time) and then, the lock having expired, loads itself — exactly once, and never while the stale lock is still alive.',
      match: {
        python: {all: [/deadline = time\.monotonic\(\) \+ LOCK_TTL_S/, /while time\.monotonic\(\) < deadline/]},
        typescript: {all: [/deadline = Date\.now\(\) \+ LOCK_TTL_S \* 1000/, /while \(Date\.now\(\) < deadline\)/]},
        go: {all: [/deadline := time\.Now\(\)\.Add\(lockTTL\)/, /for time\.Now\(\)\.Before\(deadline\)/]},
        scala: {
          all: [
            /deadline = System\.currentTimeMillis\(\) \+ LockTtlSeconds \* 1000L/,
            /while \(found\.isEmpty && System\.currentTimeMillis\(\) < deadline\)/,
          ],
        },
        cpp: {
          all: [
            /deadline = std::chrono::steady_clock::now\(\) \+ kLockTtl/,
            /while \(std::chrono::steady_clock::now\(\) < deadline\)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock."""
import json
import time
from typing import Callable

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600
MISSING_TTL_S = 60
LOCK_TTL_S = 5
POLL_S = 0.05
MISSING = "__missing__"


def decode(cached: str) -> dict | None:
    """What a stored value means: the sentinel is None, anything else is the product."""
    return None if cached == MISSING else json.loads(cached)


def get_product(product_id: str, load: Callable[[str], dict | None]) -> dict | None:
    """GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write."""
    # TODO
    raise NotImplementedError


def invalidate(product_id: str) -> None:
    """Delete product:{id}; the next call loads."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock."""
import json
import time
from typing import Callable

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600
MISSING_TTL_S = 60
LOCK_TTL_S = 5
POLL_S = 0.05
MISSING = "__missing__"


def decode(cached: str) -> dict | None:
    """What a stored value means: the sentinel is None, anything else is the product."""
    return None if cached == MISSING else json.loads(cached)


def get_product(product_id: str, load: Callable[[str], dict | None]) -> dict | None:
    """GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write."""
    key = f"product:{product_id}"
    cached = r.get(key)
    if cached is not None:
        return decode(cached)
    lock = f"lock:product:{product_id}"
    if r.set(lock, "1", nx=True, ex=LOCK_TTL_S):
        try:
            cached = r.get(key)  # a loser that just finished may have filled it
            if cached is not None:
                return decode(cached)
            product = load(product_id)
            if product is None:
                r.set(key, MISSING, ex=MISSING_TTL_S)
            else:
                r.set(key, json.dumps(product), ex=TTL_S)
            return product
        finally:
            r.delete(lock)
    deadline = time.monotonic() + LOCK_TTL_S
    while time.monotonic() < deadline:
        time.sleep(POLL_S)
        cached = r.get(key)
        if cached is not None:
            return decode(cached)
    return get_product(product_id, load)  # the holder died and its lock expired: start over


def invalidate(product_id: str) -> None:
    """Delete product:{id}; the next call loads."""
    r.delete(f"product:{product_id}")
`,
    },
    typescript: {
      starter: `/** Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 3600;
export const MISSING_TTL_S = 60;
export const LOCK_TTL_S = 5;
export const POLL_MS = 50;
export const MISSING = '__missing__';

export type Product = Record<string, unknown>;
export type Load = (productId: string) => Promise<Product | null> | Product | null;

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** What a stored value means: the sentinel is null, anything else is the product. */
function decode(cached: string): Product | null {
  return cached === MISSING ? null : (JSON.parse(cached) as Product);
}

/** GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write. */
export async function getProduct(productId: string, load: Load): Promise<Product | null> {
  // TODO
  throw new Error('not implemented');
}

/** Delete product:{id}; the next call loads. */
export async function invalidate(productId: string): Promise<void> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 3600;
export const MISSING_TTL_S = 60;
export const LOCK_TTL_S = 5;
export const POLL_MS = 50;
export const MISSING = '__missing__';

export type Product = Record<string, unknown>;
export type Load = (productId: string) => Promise<Product | null> | Product | null;

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** What a stored value means: the sentinel is null, anything else is the product. */
function decode(cached: string): Product | null {
  return cached === MISSING ? null : (JSON.parse(cached) as Product);
}

/** GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write. */
export async function getProduct(productId: string, load: Load): Promise<Product | null> {
  const key = \`product:\${productId}\`;
  let cached = await redis.get(key);
  if (cached !== null) return decode(cached);
  const lock = \`lock:product:\${productId}\`;
  const won = await redis.set(lock, '1', 'EX', LOCK_TTL_S, 'NX');
  if (won === 'OK') {
    try {
      cached = await redis.get(key); // a loser that just finished may have filled it
      if (cached !== null) return decode(cached);
      const product = await load(productId);
      if (product === null) await redis.set(key, MISSING, 'EX', MISSING_TTL_S);
      else await redis.set(key, JSON.stringify(product), 'EX', TTL_S);
      return product;
    } finally {
      await redis.del(lock);
    }
  }
  const deadline = Date.now() + LOCK_TTL_S * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    cached = await redis.get(key);
    if (cached !== null) return decode(cached);
  }
  return getProduct(productId, load); // the holder died and its lock expired: start over
}

/** Delete product:{id}; the next call loads. */
export async function invalidate(productId: string): Promise<void> {
  await redis.del(\`product:\${productId}\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl        = 3600 * time.Second
	missingTTL = 60 * time.Second
	lockTTL    = 5 * time.Second
	poll       = 50 * time.Millisecond
	missing    = "__missing__"
)

// Product is whatever the source returns; nil means there is no such product.
type Product map[string]any

// Load is the slow source: the product, nil when it does not exist, or an error.
type Load func(productID string) (Product, error)

// decode is what a stored value means: the sentinel is nil, anything else is the product.
func decode(cached string) (Product, error) {
	if cached == missing {
		return nil, nil
	}
	var product Product
	if err := json.Unmarshal([]byte(cached), &product); err != nil {
		return nil, fmt.Errorf("product cache: %w", err)
	}
	return product, nil
}

// getProduct GETs product:{id}; on a miss it wins lock:product:{id} (SET NX EX 5) and fills, or waits for the winner's write.
func getProduct(ctx context.Context, productID string, load Load) (Product, error) {
	// TODO
	panic("not implemented")
}

// invalidate deletes product:{id}; the next call loads.
func invalidate(ctx context.Context, productID string) error {
	// TODO
	panic("not implemented")
}

func main() {
	ctx := context.Background()
	product, err := getProduct(ctx, "42", func(id string) (Product, error) { return Product{"id": id}, nil })
	fmt.Println(product, err)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl        = 3600 * time.Second
	missingTTL = 60 * time.Second
	lockTTL    = 5 * time.Second
	poll       = 50 * time.Millisecond
	missing    = "__missing__"
)

// Product is whatever the source returns; nil means there is no such product.
type Product map[string]any

// Load is the slow source: the product, nil when it does not exist, or an error.
type Load func(productID string) (Product, error)

// decode is what a stored value means: the sentinel is nil, anything else is the product.
func decode(cached string) (Product, error) {
	if cached == missing {
		return nil, nil
	}
	var product Product
	if err := json.Unmarshal([]byte(cached), &product); err != nil {
		return nil, fmt.Errorf("product cache: %w", err)
	}
	return product, nil
}

// getProduct GETs product:{id}; on a miss it wins lock:product:{id} (SET NX EX 5) and fills, or waits for the winner's write.
func getProduct(ctx context.Context, productID string, load Load) (Product, error) {
	key := "product:" + productID
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return decode(cached)
	}
	if err != redis.Nil {
		return nil, err
	}
	lock := "lock:product:" + productID
	won, err := rdb.SetNX(ctx, lock, "1", lockTTL).Result()
	if err != nil {
		return nil, err
	}
	if won {
		return fill(ctx, key, lock, productID, load)
	}
	deadline := time.Now().Add(lockTTL)
	for time.Now().Before(deadline) {
		time.Sleep(poll)
		cached, err := rdb.Get(ctx, key).Result()
		if err == nil {
			return decode(cached)
		}
		if err != redis.Nil {
			return nil, err
		}
	}
	return getProduct(ctx, productID, load) // the holder died and its lock expired: start over
}

// fill runs under the lock: re-read (a loser may have just filled it), load, write, and always release.
func fill(ctx context.Context, key, lock, productID string, load Load) (Product, error) {
	defer rdb.Del(ctx, lock)
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return decode(cached)
	}
	if err != redis.Nil {
		return nil, err
	}
	product, err := load(productID)
	if err != nil {
		return nil, err
	}
	if product == nil {
		return nil, rdb.Set(ctx, key, missing, missingTTL).Err()
	}
	body, err := json.Marshal(product)
	if err != nil {
		return nil, err
	}
	if err := rdb.Set(ctx, key, body, ttl).Err(); err != nil {
		return nil, err
	}
	return product, nil
}

// invalidate deletes product:{id}; the next call loads.
func invalidate(ctx context.Context, productID string) error {
	return rdb.Del(ctx, "product:"+productID).Err()
}

func main() {
	ctx := context.Background()
	product, err := getProduct(ctx, "42", func(id string) (Product, error) { return Product{"id": id}, nil })
	fmt.Println(product, err)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

/** Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock. */
object ProductCache {
  val jedis = new JedisPooled("redis", 6379)
  val TtlSeconds = 3600L
  val MissingTtlSeconds = 60L
  val LockTtlSeconds = 5L
  val PollMillis = 50L
  val Missing = "__missing__"

  /** What a stored value means: the sentinel is None, anything else is the product. */
  def decode(cached: String): Option[JsValue] =
    if (cached == Missing) None else Some(JsonParser(cached))

  /** GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write. */
  def getProduct(productId: String, load: String => Option[JsValue]): Option[JsValue] = {
    ??? // TODO
  }

  /** Delete product:{id}; the next call loads. */
  def invalidate(productId: String): Unit = {
    ??? // TODO
  }

  def main(args: Array[String]): Unit =
    println(getProduct("42", id => Some(JsObject("id" -> JsString(id)))))
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

/** Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock. */
object ProductCache {
  val jedis = new JedisPooled("redis", 6379)
  val TtlSeconds = 3600L
  val MissingTtlSeconds = 60L
  val LockTtlSeconds = 5L
  val PollMillis = 50L
  val Missing = "__missing__"

  /** What a stored value means: the sentinel is None, anything else is the product. */
  def decode(cached: String): Option[JsValue] =
    if (cached == Missing) None else Some(JsonParser(cached))

  /** GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write. */
  def getProduct(productId: String, load: String => Option[JsValue]): Option[JsValue] = {
    val key = s"product:$productId"
    Option(jedis.get(key)) match {
      case Some(cached) => decode(cached)
      case None =>
        val lock = s"lock:product:$productId"
        if (jedis.set(lock, "1", SetParams.setParams().nx().ex(LockTtlSeconds)) != null) {
          try {
            Option(jedis.get(key)) match { // a loser that just finished may have filled it
              case Some(cached) => decode(cached)
              case None =>
                val product = load(productId)
                product match {
                  case Some(product) => jedis.setex(key, TtlSeconds, product.compactPrint)
                  case None => jedis.setex(key, MissingTtlSeconds, Missing)
                }
                product
            }
          } finally jedis.del(lock)
        } else {
          val deadline = System.currentTimeMillis() + LockTtlSeconds * 1000L
          var found: Option[String] = None
          while (found.isEmpty && System.currentTimeMillis() < deadline) {
            Thread.sleep(PollMillis)
            found = Option(jedis.get(key))
          }
          found match {
            case Some(cached) => decode(cached)
            case None => getProduct(productId, load) // the holder died and its lock expired: start over
          }
        }
    }
  }

  /** Delete product:{id}; the next call loads. */
  def invalidate(productId: String): Unit =
    jedis.del(s"product:$productId")

  def main(args: Array[String]): Unit =
    println(getProduct("42", id => Some(JsObject("id" -> JsString(id)))))
}
`,
    },
    cpp: {
      starter: `// Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <functional>
#include <iostream>
#include <optional>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{3600};
constexpr std::chrono::seconds kMissingTtl{60};
constexpr std::chrono::seconds kLockTtl{5};
constexpr std::chrono::milliseconds kPoll{50};
const std::string kMissing = "__missing__";

// The slow source: the product, nullopt when it does not exist; may throw.
using Load = std::function<std::optional<json>(const std::string&)>;

// What a stored value means: the sentinel is nullopt, anything else is the product.
std::optional<json> decode(const std::string& cached) {
  if (cached == kMissing) return std::nullopt;
  return json::parse(cached);
}

// GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write.
std::optional<json> get_product(const std::string& product_id, const Load& load) {
  // TODO
  throw std::logic_error("not implemented");
}

// Delete product:{id}; the next call loads.
void invalidate(const std::string& product_id) {
  // TODO
  throw std::logic_error("not implemented");
}

int main() {
  auto product = get_product("42", [](const std::string& id) { return std::optional<json>(json{{"id", id}}); });
  std::cout << (product ? product->dump() : "none") << "\\n";
}
`,
      solution: `// Cache-aside for products: product:{id} with a TTL, a negative sentinel, and a fill lock.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <functional>
#include <iostream>
#include <optional>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{3600};
constexpr std::chrono::seconds kMissingTtl{60};
constexpr std::chrono::seconds kLockTtl{5};
constexpr std::chrono::milliseconds kPoll{50};
const std::string kMissing = "__missing__";

// The slow source: the product, nullopt when it does not exist; may throw.
using Load = std::function<std::optional<json>(const std::string&)>;

// What a stored value means: the sentinel is nullopt, anything else is the product.
std::optional<json> decode(const std::string& cached) {
  if (cached == kMissing) return std::nullopt;
  return json::parse(cached);
}

// GET product:{id}; on a miss, win lock:product:{id} (SET NX EX 5) and fill, or wait for the winner's write.
std::optional<json> get_product(const std::string& product_id, const Load& load) {
  const std::string key = "product:" + product_id;
  if (auto cached = redis.get(key)) return decode(*cached);
  const std::string lock = "lock:product:" + product_id;
  if (redis.set(lock, "1", kLockTtl, sw::redis::UpdateType::NOT_EXIST)) {
    std::optional<json> product;
    try {
      if (auto cached = redis.get(key)) {  // a loser that just finished may have filled it
        product = decode(*cached);
      } else {
        product = load(product_id);
        if (product) {
          redis.set(key, product->dump(), kTtl);
        } else {
          redis.set(key, kMissing, kMissingTtl);
        }
      }
    } catch (...) {
      redis.del(lock);
      throw;
    }
    redis.del(lock);
    return product;
  }
  const auto deadline = std::chrono::steady_clock::now() + kLockTtl;
  while (std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(kPoll);
    if (auto cached = redis.get(key)) return decode(*cached);
  }
  return get_product(product_id, load);  // the holder died and its lock expired: start over
}

// Delete product:{id}; the next call loads.
void invalidate(const std::string& product_id) {
  redis.del("product:" + product_id);
}

int main() {
  auto product = get_product("42", [](const std::string& id) { return std::optional<json>(json{{"id", id}}); });
  std::cout << (product ? product->dump() : "none") << "\\n";
}
`,
    },
  },
  harness: {
    python: `import json
import time

PRODUCT = {"id": "42", "name": "Espresso machine", "price_cents": 24900, "tags": ["kitchen", "coffee"]}


def source(ctx, catalogue, lock_must_be_live=True):
    """A slow source the harness can count: returns catalogue[id] (None when absent); asserts the fill lock is held while it runs."""
    calls = []

    def load(product_id):
        calls.append(product_id)
        if lock_must_be_live:
            ttl = ctx.redis.ttl(f"lock:product:{product_id}")
            assert 0 < ttl <= 5, f"load must run under lock:product:{product_id} with SET NX EX 5; its TTL is {ttl} (-2 = no lock, -1 = no expiry)"
        return catalogue.get(product_id)

    return load, calls


def check_miss_then_hit(ctx):
    m = ctx.load("product_cache")
    load, calls = source(ctx, {"42": PRODUCT})
    assert m.get_product("42", load) == PRODUCT, "a miss must return what load returned"
    assert calls == ["42"], f"a miss calls load once with the product id; it was called with {calls}"
    raw = ctx.redis.get("product:42")
    assert raw is not None, "the product must be written to product:42"
    assert json.loads(raw) == PRODUCT, f"product:42 must hold exactly the JSON load returned, it holds {raw!r}"
    ttl = ctx.redis.ttl("product:42")
    assert 3590 < ttl <= 3600, f"product:42 must expire in 3600 s (TTL_S); its TTL is {ttl}"
    assert m.get_product("42", load) == PRODUCT, "a hit must return the cached product"
    assert calls == ["42"], f"a hit must not call load; load has been called {len(calls)} times"
    assert m.get_product("42", load) == PRODUCT
    assert len(calls) == 1
    ctx.clock.advance(3601)
    assert ctx.redis.get("product:42") is None, "after 3600 s the key must have expired"
    assert m.get_product("42", load) == PRODUCT
    assert calls == ["42", "42"], "once the TTL has passed the next call must load again"
    assert not ctx.redis.exists("lock:product:42"), "no lock may remain after a fill"


def check_negative_cache(ctx):
    m = ctx.load("product_cache")
    catalogue = {}
    load, calls = source(ctx, catalogue)
    assert m.get_product("7", load) is None, "a product the source does not have is None"
    assert calls == ["7"]
    assert ctx.redis.get("product:7") == "__missing__", f"a missing product must be cached as the sentinel '__missing__'; product:7 holds {ctx.redis.get('product:7')!r}"
    ttl = ctx.redis.ttl("product:7")
    assert 50 < ttl <= 60, f"the sentinel must expire in 60 s (MISSING_TTL_S); its TTL is {ttl}"
    assert m.get_product("7", load) is None, "the sentinel must be served as None"
    assert m.get_product("7", load) is None
    assert calls == ["7"], f"the sentinel must answer without calling load; load was called {len(calls)} times"
    catalogue["7"] = {"id": "7", "name": "Grinder"}
    assert m.get_product("7", load) is None, "while the sentinel lives a product that appeared in the source is still unseen"
    ctx.clock.advance(61)
    assert m.get_product("7", load) == {"id": "7", "name": "Grinder"}, "after 60 s the source is asked again"
    assert calls == ["7", "7"]
    assert json.loads(ctx.redis.get("product:7")) == {"id": "7", "name": "Grinder"}


def check_invalidate(ctx):
    m = ctx.load("product_cache")
    catalogue = {"42": dict(PRODUCT)}
    load, calls = source(ctx, catalogue)
    assert m.get_product("42", load) == PRODUCT
    catalogue["42"] = {**PRODUCT, "price_cents": 19900}
    assert m.get_product("42", load)["price_cents"] == 24900, "until invalidated, the cached price is served"
    m.invalidate("42")
    assert ctx.redis.get("product:42") is None, "invalidate must delete product:42"
    assert m.get_product("42", load)["price_cents"] == 19900, "after invalidate the next call must load the new product"
    assert calls == ["42", "42"], f"invalidate then get must load exactly once more; load calls: {calls}"
    assert json.loads(ctx.redis.get("product:42"))["price_cents"] == 19900, "the reloaded product must be cached"
    assert m.get_product("9", load) is None
    assert ctx.redis.get("product:9") == "__missing__"
    catalogue["9"] = {"id": "9"}
    m.invalidate("9")
    assert m.get_product("9", load) == {"id": "9"}, "invalidate must also clear a sentinel: a product created after a miss becomes visible"
    m.invalidate("never-cached")
    assert ctx.redis.keys("*") == ["product:42", "product:9"] or set(ctx.redis.keys("*")) == {"product:42", "product:9"}, "invalidating an unknown id must touch nothing else"


def check_single_flight(ctx):
    m1 = ctx.load("product_cache")
    m2 = ctx.reload("product_cache")
    load, calls = source(ctx, {"42": PRODUCT})
    # The second worker's request lands the instant the first one has seen the miss, before it takes the lock.
    probe = ctx.redis_after("product:42", lambda: m2.get_product("42", load))
    first = m1.get_product("42", load)
    assert probe.fired, "the first call must start with GET product:42"
    assert probe.error is None, f"the concurrent call failed: {probe.error!r}"
    assert first == PRODUCT, "the first caller must return the product"
    assert probe.result == PRODUCT, "the concurrent caller must return the same product"
    assert len(calls) == 1, f"two concurrent misses must call load once, it was called {len(calls)} times: after winning the lock, GET the key again — the other request has already filled it"
    assert not ctx.redis.exists("lock:product:42"), "lock:product:42 must be deleted once the fill is done"
    assert json.loads(ctx.redis.get("product:42")) == PRODUCT
    assert m1.get_product("42", load) == PRODUCT and m2.get_product("42", load) == PRODUCT
    assert len(calls) == 1


def check_lock_released(ctx):
    m = ctx.load("product_cache")

    class SourceDown(Exception):
        pass

    attempts = []

    def failing(product_id):
        attempts.append(product_id)
        raise SourceDown("catalogue unreachable")

    try:
        m.get_product("42", failing)
    except SourceDown:
        pass
    else:
        raise AssertionError("when load raises, get_product must re-raise the error, not swallow it or cache anything")
    assert attempts == ["42"]
    assert ctx.redis.get("product:42") is None, "a failed load must cache nothing — not the sentinel either"
    assert not ctx.redis.exists("lock:product:42"), "a failed fill must delete lock:product:42: otherwise every caller waits 5 s for a fill that will never come"
    load, calls = source(ctx, {"42": PRODUCT})
    slept = ctx.clock.slept
    assert m.get_product("42", load) == PRODUCT, "the next call after a failure must take the lock and load"
    assert calls == ["42"]
    assert ctx.clock.slept == slept, "the next call after a failure must not have to wait: the lock was released, so it wins it at once"
    assert not ctx.redis.exists("lock:product:42")


def check_stale_lock(ctx):
    m = ctx.load("product_cache")
    ctx.redis.set("lock:product:42", "stale", ex=5)  # a worker took the lock and died
    calls = []

    def load(product_id):
        calls.append(product_id)
        assert ctx.redis.get("lock:product:42") != "stale", "load ran while another worker's lock was still alive: a loser must wait for the lock's TTL, not load on its own"
        return PRODUCT

    started = time.time()
    assert m.get_product("42", load) == PRODUCT, "once the stale lock has expired the caller must load and return the product"
    waited = time.time() - started
    assert waited >= 4.9, f"the caller must poll every 50 ms for the lock's TTL (5 s) before giving up on the holder; it waited {waited:.2f} s"
    assert waited < 12, f"the wait is bounded by the lock's TTL; this took {waited:.2f} s of virtual time"
    assert calls == ["42"], f"the stale lock must cost exactly one load; load was called {len(calls)} times"
    assert json.loads(ctx.redis.get("product:42")) == PRODUCT
    assert not ctx.redis.exists("lock:product:42")
`,
    typescript: `const PRODUCT = {id: '42', name: 'Espresso machine', price_cents: 24900, tags: ['kitchen', 'coffee']};

type Product = Record<string, unknown>;

/** A slow source the harness can count: returns catalogue[id] (null when absent); asserts the fill lock is held while it runs. */
function source(ctx, catalogue: Record<string, Product>, lockMustBeLive = true) {
  const calls: string[] = [];
  const load = (productId: string): Product | null => {
    calls.push(productId);
    if (lockMustBeLive) {
      const ttl = ctx.redis.ttl(\`lock:product:\${productId}\`);
      assert(0 < ttl && ttl <= 5, \`load must run under lock:product:\${productId} with SET NX EX 5; its TTL is \${ttl} (-2 = no lock, -1 = no expiry)\`);
    }
    return catalogue[productId] ?? null;
  };
  return {load, calls};
}

export async function check_miss_then_hit(ctx) {
  const m = ctx.load('product_cache');
  const {load, calls} = source(ctx, {'42': PRODUCT});
  assert.deepEqual(await m.getProduct('42', load), PRODUCT, 'a miss must return what load returned');
  assert.deepEqual(calls, ['42'], \`a miss calls load once with the product id; it was called with \${JSON.stringify(calls)}\`);
  const raw = ctx.redis.get('product:42');
  assert(raw !== null, 'the product must be written to product:42');
  assert.deepEqual(JSON.parse(raw), PRODUCT, \`product:42 must hold exactly the JSON load returned, it holds \${JSON.stringify(raw)}\`);
  const ttl = ctx.redis.ttl('product:42');
  assert(3590 < ttl && ttl <= 3600, \`product:42 must expire in 3600 s (TTL_S); its TTL is \${ttl}\`);
  assert.deepEqual(await m.getProduct('42', load), PRODUCT, 'a hit must return the cached product');
  assert.deepEqual(calls, ['42'], \`a hit must not call load; load has been called \${calls.length} times\`);
  assert.deepEqual(await m.getProduct('42', load), PRODUCT);
  assert.equal(calls.length, 1);
  ctx.clock.advance(3601);
  assert.equal(ctx.redis.get('product:42'), null, 'after 3600 s the key must have expired');
  assert.deepEqual(await m.getProduct('42', load), PRODUCT);
  assert.deepEqual(calls, ['42', '42'], 'once the TTL has passed the next call must load again');
  assert.equal(ctx.redis.exists('lock:product:42'), 0, 'no lock may remain after a fill');
}

export async function check_negative_cache(ctx) {
  const m = ctx.load('product_cache');
  const catalogue: Record<string, Product> = {};
  const {load, calls} = source(ctx, catalogue);
  assert.equal(await m.getProduct('7', load), null, 'a product the source does not have is null');
  assert.deepEqual(calls, ['7']);
  assert.equal(ctx.redis.get('product:7'), '__missing__', \`a missing product must be cached as the sentinel '__missing__'; product:7 holds \${JSON.stringify(ctx.redis.get('product:7'))}\`);
  const ttl = ctx.redis.ttl('product:7');
  assert(50 < ttl && ttl <= 60, \`the sentinel must expire in 60 s (MISSING_TTL_S); its TTL is \${ttl}\`);
  assert.equal(await m.getProduct('7', load), null, 'the sentinel must be served as null');
  assert.equal(await m.getProduct('7', load), null);
  assert.deepEqual(calls, ['7'], \`the sentinel must answer without calling load; load was called \${calls.length} times\`);
  catalogue['7'] = {id: '7', name: 'Grinder'};
  assert.equal(await m.getProduct('7', load), null, 'while the sentinel lives a product that appeared in the source is still unseen');
  ctx.clock.advance(61);
  assert.deepEqual(await m.getProduct('7', load), {id: '7', name: 'Grinder'}, 'after 60 s the source is asked again');
  assert.deepEqual(calls, ['7', '7']);
  assert.deepEqual(JSON.parse(ctx.redis.get('product:7')), {id: '7', name: 'Grinder'});
}

export async function check_invalidate(ctx) {
  const m = ctx.load('product_cache');
  const catalogue: Record<string, Product> = {'42': {...PRODUCT}};
  const {load, calls} = source(ctx, catalogue);
  assert.deepEqual(await m.getProduct('42', load), PRODUCT);
  catalogue['42'] = {...PRODUCT, price_cents: 19900};
  assert.equal((await m.getProduct('42', load)).price_cents, 24900, 'until invalidated, the cached price is served');
  await m.invalidate('42');
  assert.equal(ctx.redis.get('product:42'), null, 'invalidate must delete product:42');
  assert.equal((await m.getProduct('42', load)).price_cents, 19900, 'after invalidate the next call must load the new product');
  assert.deepEqual(calls, ['42', '42'], \`invalidate then get must load exactly once more; load calls: \${JSON.stringify(calls)}\`);
  assert.equal(JSON.parse(ctx.redis.get('product:42')).price_cents, 19900, 'the reloaded product must be cached');
  assert.equal(await m.getProduct('9', load), null);
  assert.equal(ctx.redis.get('product:9'), '__missing__');
  catalogue['9'] = {id: '9'};
  await m.invalidate('9');
  assert.deepEqual(await m.getProduct('9', load), {id: '9'}, 'invalidate must also clear a sentinel: a product created after a miss becomes visible');
  await m.invalidate('never-cached');
  assert.deepEqual([...ctx.redis.keys('*')].sort(), ['product:42', 'product:9'], 'invalidating an unknown id must touch nothing else');
}

export async function check_single_flight(ctx) {
  const m1 = ctx.load('product_cache');
  const m2 = ctx.reload('product_cache');
  const {load, calls} = source(ctx, {'42': PRODUCT});
  // The second worker's request lands the instant the first one has taken the lock, before it has loaded anything.
  let second: Promise<Product | null> | undefined;
  const probe = ctx.redisAfter('lock:product:42', () => {
    second = m2.getProduct('42', load);
  });
  const first = await m1.getProduct('42', load);
  assert(probe.fired, 'a miss must take lock:product:42');
  assert.deepEqual(first, PRODUCT, 'the first caller must return the product');
  assert.deepEqual(await second, PRODUCT, 'the caller that lost the lock must return what the winner wrote');
  assert.equal(calls.length, 1, \`two concurrent misses must call load once, it was called \${calls.length} times: the loser polls product:42 every 50 ms instead of loading\`);
  assert.equal(ctx.redis.exists('lock:product:42'), 0, 'lock:product:42 must be deleted once the fill is done');
  assert.deepEqual(JSON.parse(ctx.redis.get('product:42')), PRODUCT);
  // The other order: the second request lands between the first one's miss and its lock, fills, and releases.
  const {load: load2, calls: calls2} = source(ctx, {'43': {id: '43'}});
  let third: Promise<Product | null> | undefined;
  ctx.redisAfter('product:43', () => {
    third = m2.getProduct('43', load2);
  });
  assert.deepEqual(await m1.getProduct('43', load2), {id: '43'});
  assert.deepEqual(await third, {id: '43'});
  assert.equal(calls2.length, 1, \`when the other request fills the key between this one's miss and its lock, load must still run once (it ran \${calls2.length} times): GET the key again after winning the lock\`);
  assert.equal(ctx.redis.exists('lock:product:43'), 0);
}

export async function check_lock_released(ctx) {
  const m = ctx.load('product_cache');
  const attempts: string[] = [];
  const failing = (productId: string): Product | null => {
    attempts.push(productId);
    throw new Error('catalogue unreachable');
  };
  await assert.rejects(m.getProduct('42', failing), /catalogue unreachable/, 'when load throws, getProduct must reject with that error, not swallow it or cache anything');
  assert.deepEqual(attempts, ['42']);
  assert.equal(ctx.redis.get('product:42'), null, 'a failed load must cache nothing — not the sentinel either');
  assert.equal(ctx.redis.exists('lock:product:42'), 0, 'a failed fill must delete lock:product:42: otherwise every caller waits 5 s for a fill that will never come');
  const {load, calls} = source(ctx, {'42': PRODUCT});
  const sleeps = ctx.clock.sleeps;
  assert.deepEqual(await m.getProduct('42', load), PRODUCT, 'the next call after a failure must take the lock and load');
  assert.deepEqual(calls, ['42']);
  assert.equal(ctx.clock.sleeps, sleeps, 'the next call after a failure must not have to wait: the lock was released, so it wins it at once');
  assert.equal(ctx.redis.exists('lock:product:42'), 0);
}

export async function check_stale_lock(ctx) {
  const m = ctx.load('product_cache');
  ctx.redis.set('lock:product:42', 'stale', 'EX', 5); // a worker took the lock and died
  const calls: string[] = [];
  const load = (productId: string): Product | null => {
    calls.push(productId);
    assert.notEqual(ctx.redis.get('lock:product:42'), 'stale', "load ran while another worker's lock was still alive: a loser must wait for the lock's TTL, not load on its own");
    return PRODUCT;
  };
  const started = ctx.clock.now();
  assert.deepEqual(await m.getProduct('42', load), PRODUCT, 'once the stale lock has expired the caller must load and return the product');
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited >= 4.9, \`the caller must poll every 50 ms for the lock's TTL (5 s) before giving up on the holder; it waited \${waited.toFixed(2)} s\`);
  assert(waited < 12, \`the wait is bounded by the lock's TTL; this took \${waited.toFixed(2)} s of virtual time\`);
  assert.deepEqual(calls, ['42'], \`the stale lock must cost exactly one load; load was called \${calls.length} times\`);
  assert.deepEqual(JSON.parse(ctx.redis.get('product:42')), PRODUCT);
  assert.equal(ctx.redis.exists('lock:product:42'), 0);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"leetbuild/harness"
)

var (
	caBg      = context.Background()
	caProduct = Product{"id": "42", "name": "Espresso machine", "price_cents": 24900, "tags": []string{"kitchen", "coffee"}}
)

// caJSON is v as JSON decodes it (numbers float64, arrays []any), so a product compares the same
// whether load returned it or the cache decoded it; a nil Product is nil.
func caJSON(ctx *harness.Ctx, v any) any {
	body, err := json.Marshal(v)
	ctx.NoError(err, "the product %v does not encode as JSON", v)
	var out any
	ctx.NoError(json.Unmarshal(body, &out), "the product %v does not decode from JSON", v)
	return out
}

// caStored is the JSON value at key, decoded.
func caStored(ctx *harness.Ctx, key string) any {
	raw, ok := ctx.Redis.Get(key)
	ctx.Assert(ok, "%s must hold the product's JSON, it does not exist", key)
	var out any
	ctx.Assert(json.Unmarshal([]byte(raw), &out) == nil, "%s must hold the product as JSON, it holds %q", key, raw)
	return out
}

// caField is one field of a decoded product (nil when the product is nil).
func caField(product any, field string) any {
	fields, _ := product.(map[string]any)
	return fields[field]
}

func caGet(ctx *harness.Ctx, productID string, load Load) any {
	product, err := getProduct(caBg, productID, load)
	ctx.NoError(err, "getProduct(%q) returned an error", productID)
	return caJSON(ctx, product)
}

func caInvalidate(ctx *harness.Ctx, productID string) {
	ctx.NoError(invalidate(caBg, productID), "invalidate(%q) returned an error", productID)
}

func caCached(ctx *harness.Ctx, key string) any {
	if raw, ok := ctx.Redis.Get(key); ok {
		return raw
	}
	return nil
}

// caSource is a slow source the harness can count: returns catalogue[id] (nil when absent); asserts
// the fill lock is held while it runs.
type caSource struct {
	ctx       *harness.Ctx
	catalogue map[string]Product
	calls     []string
}

func (s *caSource) load(productID string) (Product, error) {
	s.calls = append(s.calls, productID)
	ttl := s.ctx.Redis.TTL("lock:product:" + productID)
	s.ctx.Assert(0 < ttl && ttl <= 5, "load must run under lock:product:%s with SET NX EX 5; its TTL is %d (-2 = no lock, -1 = no expiry)", productID, ttl)
	return s.catalogue[productID], nil
}

// caCall is a getProduct running in its own goroutine, as a second worker's request.
type caCall struct {
	productID string
	done      chan struct{}
	product   Product
	err       error
	failure   any
}

func caGo(productID string, load Load) *caCall {
	call := &caCall{productID: productID, done: make(chan struct{})}
	go func() {
		defer close(call.done)
		defer func() { call.failure = recover() }()
		call.product, call.err = getProduct(caBg, productID, load)
	}()
	return call
}

// result lets the call finish and returns what it returned, decoded as JSON.
func (call *caCall) result(ctx *harness.Ctx) any {
	ctx.Settle()
	select {
	case <-call.done:
	default:
		ctx.Fatalf("the concurrent getProduct(%q) never returned", call.productID)
	}
	if call.failure != nil {
		panic(call.failure)
	}
	ctx.NoError(call.err, "the concurrent getProduct(%q) returned an error", call.productID)
	return caJSON(ctx, call.product)
}

func CheckMissThenHit(ctx *harness.Ctx) {
	src := &caSource{ctx: ctx, catalogue: map[string]Product{"42": caProduct}}
	want := caJSON(ctx, caProduct)
	ctx.Equal(caGet(ctx, "42", src.load), want, "a miss must return what load returned")
	ctx.Equal(src.calls, []string{"42"}, "a miss calls load once with the product id: the load calls")
	ctx.Assert(ctx.Redis.Exists("product:42") == 1, "the product must be written to product:42")
	ctx.Equal(caStored(ctx, "product:42"), want, "product:42 must hold exactly the JSON load returned")
	ttl := ctx.Redis.TTL("product:42")
	ctx.Assert(3590 < ttl && ttl <= 3600, "product:42 must expire in 3600 s (ttl); its TTL is %d", ttl)
	ctx.Equal(caGet(ctx, "42", src.load), want, "a hit must return the cached product")
	ctx.Equal(len(src.calls), 1, "a hit must not call load: the number of load calls")
	ctx.Equal(caGet(ctx, "42", src.load), want, "the second hit")
	ctx.Equal(len(src.calls), 1, "the number of load calls after two hits")
	ctx.Clock.Advance(3601)
	ctx.Equal(caCached(ctx, "product:42"), nil, "after 3600 s the key must have expired")
	ctx.Equal(caGet(ctx, "42", src.load), want, "the call after the TTL")
	ctx.Equal(src.calls, []string{"42", "42"}, "once the TTL has passed the next call must load again: the load calls")
	ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "no lock may remain after a fill")
}

func CheckNegativeCache(ctx *harness.Ctx) {
	src := &caSource{ctx: ctx, catalogue: map[string]Product{}}
	ctx.Equal(caGet(ctx, "7", src.load), nil, "a product the source does not have is nil")
	ctx.Equal(src.calls, []string{"7"}, "the load calls")
	ctx.Equal(caCached(ctx, "product:7"), "__missing__", "a missing product must be cached as the sentinel %q: product:7", "__missing__")
	ttl := ctx.Redis.TTL("product:7")
	ctx.Assert(50 < ttl && ttl <= 60, "the sentinel must expire in 60 s (missingTTL); its TTL is %d", ttl)
	ctx.Equal(caGet(ctx, "7", src.load), nil, "the sentinel must be served as nil")
	ctx.Equal(caGet(ctx, "7", src.load), nil, "the sentinel served a second time")
	ctx.Equal(len(src.calls), 1, "the sentinel must answer without calling load: the number of load calls")
	src.catalogue["7"] = Product{"id": "7", "name": "Grinder"}
	ctx.Equal(caGet(ctx, "7", src.load), nil, "while the sentinel lives a product that appeared in the source is still unseen")
	ctx.Clock.Advance(61)
	grinder := caJSON(ctx, Product{"id": "7", "name": "Grinder"})
	ctx.Equal(caGet(ctx, "7", src.load), grinder, "after 60 s the source is asked again")
	ctx.Equal(src.calls, []string{"7", "7"}, "the load calls")
	ctx.Equal(caStored(ctx, "product:7"), grinder, "product:7 must hold the product loaded after the sentinel expired")
}

func CheckInvalidate(ctx *harness.Ctx) {
	src := &caSource{ctx: ctx, catalogue: map[string]Product{"42": caProduct}}
	ctx.Equal(caGet(ctx, "42", src.load), caJSON(ctx, caProduct), "the first call returns the product")
	src.catalogue["42"] = Product{"id": "42", "name": "Espresso machine", "price_cents": 19900, "tags": []string{"kitchen", "coffee"}}
	ctx.Equal(caField(caGet(ctx, "42", src.load), "price_cents"), 24900, "until invalidated, the cached price is served")
	caInvalidate(ctx, "42")
	ctx.Equal(caCached(ctx, "product:42"), nil, "invalidate must delete product:42")
	ctx.Equal(caField(caGet(ctx, "42", src.load), "price_cents"), 19900, "after invalidate the next call must load the new product")
	ctx.Equal(src.calls, []string{"42", "42"}, "invalidate then get must load exactly once more: the load calls")
	ctx.Equal(caField(caStored(ctx, "product:42"), "price_cents"), 19900, "the reloaded product must be cached")
	ctx.Equal(caGet(ctx, "9", src.load), nil, "an unknown product is nil")
	ctx.Equal(caCached(ctx, "product:9"), "__missing__", "product:9 must hold the sentinel")
	src.catalogue["9"] = Product{"id": "9"}
	caInvalidate(ctx, "9")
	ctx.Equal(caGet(ctx, "9", src.load), caJSON(ctx, Product{"id": "9"}), "invalidate must also clear a sentinel: a product created after a miss becomes visible")
	caInvalidate(ctx, "never-cached")
	ctx.Equal(ctx.Redis.Keys("*"), []string{"product:42", "product:9"}, "invalidating an unknown id must touch nothing else: the keys")
}

func CheckSingleFlight(ctx *harness.Ctx) {
	src := &caSource{ctx: ctx, catalogue: map[string]Product{"42": caProduct}}
	want := caJSON(ctx, caProduct)
	// The second worker's request lands the instant the first one has taken the lock, before it has loaded anything.
	var second *caCall
	probe := ctx.Redis.After("lock:product:42", func() any {
		second = caGo("42", src.load)
		return nil
	})
	first := caGet(ctx, "42", src.load)
	ctx.Assert(probe.Fired, "a miss must take lock:product:42")
	ctx.Equal(first, want, "the first caller must return the product")
	ctx.Equal(second.result(ctx), want, "the caller that lost the lock must return what the winner wrote")
	ctx.Assert(len(src.calls) == 1, "two concurrent misses must call load once, it was called %d times: the loser polls product:42 every 50 ms instead of loading", len(src.calls))
	ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "lock:product:42 must be deleted once the fill is done")
	ctx.Equal(caStored(ctx, "product:42"), want, "product:42 must hold the product")
	// The other order: the second request lands between the first one's miss and its lock, fills, and releases.
	src2 := &caSource{ctx: ctx, catalogue: map[string]Product{"43": {"id": "43"}}}
	want2 := caJSON(ctx, Product{"id": "43"})
	var third any
	probe2 := ctx.Redis.After("product:43", func() any {
		product, err := getProduct(caBg, "43", src2.load)
		ctx.NoError(err, "the concurrent getProduct(%q) returned an error", "43")
		third = caJSON(ctx, product)
		return nil
	})
	ctx.Equal(caGet(ctx, "43", src2.load), want2, "the first caller must return product 43")
	ctx.Assert(probe2.Err == nil, "the concurrent getProduct(%q) failed: %v", "43", probe2.Err)
	ctx.Equal(third, want2, "the concurrent caller must return product 43")
	ctx.Assert(len(src2.calls) == 1, "when the other request fills the key between this one's miss and its lock, load must still run once (it ran %d times): GET the key again after winning the lock", len(src2.calls))
	ctx.Equal(ctx.Redis.Exists("lock:product:43"), 0, "lock:product:43 must be deleted once the fill is done")
}

func CheckLockReleased(ctx *harness.Ctx) {
	attempts := []string{}
	failing := func(productID string) (Product, error) {
		attempts = append(attempts, productID)
		return nil, errors.New("catalogue unreachable")
	}
	_, err := getProduct(caBg, "42", failing)
	ctx.Assert(err != nil && strings.Contains(err.Error(), "catalogue unreachable"), "when load fails, getProduct must return that error, not swallow it or cache anything: it returned %v", err)
	ctx.Equal(attempts, []string{"42"}, "the load attempts")
	ctx.Equal(caCached(ctx, "product:42"), nil, "a failed load must cache nothing, not the sentinel either")
	ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "a failed fill must delete lock:product:42: otherwise every caller waits 5 s for a fill that will never come")
	src := &caSource{ctx: ctx, catalogue: map[string]Product{"42": caProduct}}
	sleeps := ctx.Clock.Sleeps()
	ctx.Equal(caGet(ctx, "42", src.load), caJSON(ctx, caProduct), "the next call after a failure must take the lock and load")
	ctx.Equal(src.calls, []string{"42"}, "the load calls")
	ctx.Equal(ctx.Clock.Sleeps(), sleeps, "the next call after a failure must not have to wait: the lock was released, so it wins it at once (sleeps)")
	ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "no lock may remain after the fill")
}

func CheckStaleLock(ctx *harness.Ctx) {
	ctx.Redis.Set("lock:product:42", "stale", "EX", 5) // a worker took the lock and died
	calls := []string{}
	load := func(productID string) (Product, error) {
		calls = append(calls, productID)
		held, _ := ctx.Redis.Get("lock:product:42")
		ctx.Assert(held != "stale", "load ran while another worker's lock was still alive: a loser must wait for the lock's TTL, not load on its own")
		return caProduct, nil
	}
	started := ctx.Clock.Now()
	ctx.Equal(caGet(ctx, "42", load), caJSON(ctx, caProduct), "once the stale lock has expired the caller must load and return the product")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited >= 4.9, "the caller must poll every 50 ms for the lock's TTL (5 s) before giving up on the holder; it waited %.2f s", waited)
	ctx.Assert(waited < 12, "the wait is bounded by the lock's TTL; this took %.2f s of virtual time", waited)
	ctx.Assert(len(calls) == 1, "the stale lock must cost exactly one load; load was called %d times", len(calls))
	ctx.Equal(caStored(ctx, "product:42"), caJSON(ctx, caProduct), "product:42 must hold the product")
	ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "no lock may remain after the fill")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <atomic>
#include <exception>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

namespace {

const json caProduct = {{"id", "42"}, {"name", "Espresso machine"}, {"price_cents", 24900}, {"tags", {"kitchen", "coffee"}}};

// caJSON is a product as its canonical JSON text, so a product compares the same whether load
// returned it or the cache decoded it; no product is nullopt.
std::optional<std::string> caJSON(const std::optional<json>& product) {
  if (!product) return std::nullopt;
  return product->dump();
}

// caStored is the JSON value at key, as canonical JSON text.
std::string caStored(harness::Ctx& ctx, const std::string& key) {
  const auto raw = ctx.Redis.Get(key);
  ctx.Assert(raw.has_value(), "%s must hold the product's JSON, it does not exist", key);
  const json out = json::parse(*raw, nullptr, false);
  ctx.Assert(!out.is_discarded(), "%s must hold the product as JSON, it holds %q", key, *raw);
  return out.dump();
}

// caField is one numeric field of a product as canonical JSON text (nullopt when there is none).
std::optional<double> caField(const std::optional<std::string>& product, const std::string& field) {
  if (!product) return std::nullopt;
  const json fields = json::parse(*product);
  if (!fields.is_object() || !fields.contains(field) || !fields[field].is_number()) return std::nullopt;
  return fields[field].get<double>();
}

// caSource is a slow source the harness can count: returns catalogue[id] (nullopt when absent);
// asserts the fill lock is held while it runs.
struct caSource {
  harness::Ctx& ctx;
  std::map<std::string, json> catalogue;
  std::vector<std::string> calls;

  Load load() {
    return [this](const std::string& productID) -> std::optional<json> {
      calls.push_back(productID);
      const long long ttl = ctx.Redis.TTL("lock:product:" + productID);
      ctx.Assert(0 < ttl && ttl <= 5, "load must run under lock:product:%s with SET NX EX 5; its TTL is %d (-2 = no lock, -1 = no expiry)", productID, ttl);
      const auto it = catalogue.find(productID);
      if (it == catalogue.end()) return std::nullopt;
      return it->second;
    };
  }
};

// caCall is a get_product running on its own thread, as a second worker's request.
struct caCall {
  std::string productID;
  std::atomic<bool> done{false};
  std::optional<json> product;
  std::exception_ptr failure;

  // result lets the call finish and returns what it returned, as canonical JSON text.
  std::optional<std::string> result(harness::Ctx& ctx) {
    ctx.Settle();
    if (!done) ctx.Fatalf("the concurrent getProduct(%q) never returned", productID);
    if (failure) std::rethrow_exception(failure);
    return caJSON(product);
  }
};

std::shared_ptr<caCall> caGo(const std::string& productID, Load load) {
  auto call = std::make_shared<caCall>();
  call->productID = productID;
  std::thread([call, load] {
    try {
      call->product = get_product(call->productID, load);
    } catch (...) {
      call->failure = std::current_exception();
    }
    call->done = true;
  }).detach();
  return call;
}

}  // namespace

void CheckMissThenHit(harness::Ctx& ctx) {
  caSource src{ctx, {{"42", caProduct}}};
  const auto want = caJSON(caProduct);
  ctx.Equal(caJSON(get_product("42", src.load())), want, "a miss must return what load returned");
  ctx.Equal(src.calls, {"42"}, "a miss calls load once with the product id: the load calls");
  ctx.Assert(ctx.Redis.Exists("product:42") == 1, "the product must be written to product:42");
  ctx.Equal(caStored(ctx, "product:42"), want, "product:42 must hold exactly the JSON load returned");
  const long long ttl = ctx.Redis.TTL("product:42");
  ctx.Assert(3590 < ttl && ttl <= 3600, "product:42 must expire in 3600 s (ttl); its TTL is %d", ttl);
  ctx.Equal(caJSON(get_product("42", src.load())), want, "a hit must return the cached product");
  ctx.Equal(src.calls.size(), 1, "a hit must not call load: the number of load calls");
  ctx.Equal(caJSON(get_product("42", src.load())), want, "the second hit");
  ctx.Equal(src.calls.size(), 1, "the number of load calls after two hits");
  ctx.Clock.Advance(3601);
  ctx.Equal(ctx.Redis.Get("product:42"), nullptr, "after 3600 s the key must have expired");
  ctx.Equal(caJSON(get_product("42", src.load())), want, "the call after the TTL");
  ctx.Equal(src.calls, {"42", "42"}, "once the TTL has passed the next call must load again: the load calls");
  ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "no lock may remain after a fill");
}

void CheckNegativeCache(harness::Ctx& ctx) {
  caSource src{ctx, {}};
  ctx.Equal(caJSON(get_product("7", src.load())), nullptr, "a product the source does not have is nil");
  ctx.Equal(src.calls, {"7"}, "the load calls");
  ctx.Equal(ctx.Redis.Get("product:7"), "__missing__", "a missing product must be cached as the sentinel %q: product:7", "__missing__");
  const long long ttl = ctx.Redis.TTL("product:7");
  ctx.Assert(50 < ttl && ttl <= 60, "the sentinel must expire in 60 s (missingTTL); its TTL is %d", ttl);
  ctx.Equal(caJSON(get_product("7", src.load())), nullptr, "the sentinel must be served as nil");
  ctx.Equal(caJSON(get_product("7", src.load())), nullptr, "the sentinel served a second time");
  ctx.Equal(src.calls.size(), 1, "the sentinel must answer without calling load: the number of load calls");
  const json grinderProduct = {{"id", "7"}, {"name", "Grinder"}};
  src.catalogue["7"] = grinderProduct;
  ctx.Equal(caJSON(get_product("7", src.load())), nullptr, "while the sentinel lives a product that appeared in the source is still unseen");
  ctx.Clock.Advance(61);
  const auto grinder = caJSON(grinderProduct);
  ctx.Equal(caJSON(get_product("7", src.load())), grinder, "after 60 s the source is asked again");
  ctx.Equal(src.calls, {"7", "7"}, "the load calls");
  ctx.Equal(caStored(ctx, "product:7"), grinder, "product:7 must hold the product loaded after the sentinel expired");
}

void CheckInvalidate(harness::Ctx& ctx) {
  caSource src{ctx, {{"42", caProduct}}};
  ctx.Equal(caJSON(get_product("42", src.load())), caJSON(caProduct), "the first call returns the product");
  src.catalogue["42"] = json{{"id", "42"}, {"name", "Espresso machine"}, {"price_cents", 19900}, {"tags", {"kitchen", "coffee"}}};
  ctx.Equal(caField(caJSON(get_product("42", src.load())), "price_cents"), 24900, "until invalidated, the cached price is served");
  invalidate("42");
  ctx.Equal(ctx.Redis.Get("product:42"), nullptr, "invalidate must delete product:42");
  ctx.Equal(caField(caJSON(get_product("42", src.load())), "price_cents"), 19900, "after invalidate the next call must load the new product");
  ctx.Equal(src.calls, {"42", "42"}, "invalidate then get must load exactly once more: the load calls");
  ctx.Equal(caField(caStored(ctx, "product:42"), "price_cents"), 19900, "the reloaded product must be cached");
  ctx.Equal(caJSON(get_product("9", src.load())), nullptr, "an unknown product is nil");
  ctx.Equal(ctx.Redis.Get("product:9"), "__missing__", "product:9 must hold the sentinel");
  src.catalogue["9"] = json{{"id", "9"}};
  invalidate("9");
  ctx.Equal(caJSON(get_product("9", src.load())), caJSON(json{{"id", "9"}}), "invalidate must also clear a sentinel: a product created after a miss becomes visible");
  invalidate("never-cached");
  ctx.Equal(ctx.Redis.Keys("*"), {"product:42", "product:9"}, "invalidating an unknown id must touch nothing else: the keys");
}

void CheckSingleFlight(harness::Ctx& ctx) {
  caSource src{ctx, {{"42", caProduct}}};
  const auto want = caJSON(caProduct);
  // The second worker's request lands the instant the first one has taken the lock, before it has loaded anything.
  std::shared_ptr<caCall> second;
  ctx.Redis.After("lock:product:42", [&] { second = caGo("42", src.load()); });
  const auto first = caJSON(get_product("42", src.load()));
  ctx.Assert(second != nullptr, "a miss must take lock:product:42");
  ctx.Equal(first, want, "the first caller must return the product");
  ctx.Equal(second->result(ctx), want, "the caller that lost the lock must return what the winner wrote");
  ctx.Assert(src.calls.size() == 1, "two concurrent misses must call load once, it was called %d times: the loser polls product:42 every 50 ms instead of loading", src.calls.size());
  ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "lock:product:42 must be deleted once the fill is done");
  ctx.Equal(caStored(ctx, "product:42"), want, "product:42 must hold the product");
  // The other order: the second request lands between the first one's miss and its lock, fills, and releases.
  caSource src2{ctx, {{"43", json{{"id", "43"}}}}};
  const auto want2 = caJSON(json{{"id", "43"}});
  std::optional<std::string> third;
  std::exception_ptr thirdFailure;
  ctx.Redis.After("product:43", [&] {
    try {
      third = caJSON(get_product("43", src2.load()));
    } catch (...) {
      thirdFailure = std::current_exception();
    }
  });
  ctx.Equal(caJSON(get_product("43", src2.load())), want2, "the first caller must return product 43");
  if (thirdFailure) std::rethrow_exception(thirdFailure);
  ctx.Equal(third, want2, "the concurrent caller must return product 43");
  ctx.Assert(src2.calls.size() == 1, "when the other request fills the key between this one's miss and its lock, load must still run once (it ran %d times): GET the key again after winning the lock", src2.calls.size());
  ctx.Equal(ctx.Redis.Exists("lock:product:43"), 0, "lock:product:43 must be deleted once the fill is done");
}

void CheckLockReleased(harness::Ctx& ctx) {
  std::vector<std::string> attempts;
  const Load failing = [&attempts](const std::string& productID) -> std::optional<json> {
    attempts.push_back(productID);
    throw std::runtime_error("catalogue unreachable");
  };
  std::string err = "<nil>";
  try {
    get_product("42", failing);
  } catch (const std::exception& e) {
    err = e.what();
  }
  ctx.Assert(err.find("catalogue unreachable") != std::string::npos, "when load fails, getProduct must return that error, not swallow it or cache anything: it returned %v", err);
  ctx.Equal(attempts, {"42"}, "the load attempts");
  ctx.Equal(ctx.Redis.Get("product:42"), nullptr, "a failed load must cache nothing, not the sentinel either");
  ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "a failed fill must delete lock:product:42: otherwise every caller waits 5 s for a fill that will never come");
  caSource src{ctx, {{"42", caProduct}}};
  const int sleeps = ctx.Clock.Sleeps();
  ctx.Equal(caJSON(get_product("42", src.load())), caJSON(caProduct), "the next call after a failure must take the lock and load");
  ctx.Equal(src.calls, {"42"}, "the load calls");
  ctx.Equal(ctx.Clock.Sleeps(), sleeps, "the next call after a failure must not have to wait: the lock was released, so it wins it at once (sleeps)");
  ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "no lock may remain after the fill");
}

void CheckStaleLock(harness::Ctx& ctx) {
  ctx.Redis.Set("lock:product:42", "stale", "EX", 5);  // a worker took the lock and died
  std::vector<std::string> calls;
  const Load load = [&](const std::string& productID) -> std::optional<json> {
    calls.push_back(productID);
    const auto held = ctx.Redis.Get("lock:product:42");
    ctx.Assert(held != "stale", "load ran while another worker's lock was still alive: a loser must wait for the lock's TTL, not load on its own");
    return caProduct;
  };
  const int64_t started = ctx.Clock.Now();
  ctx.Equal(caJSON(get_product("42", load)), caJSON(caProduct), "once the stale lock has expired the caller must load and return the product");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited >= 4.9, "the caller must poll every 50 ms for the lock's TTL (5 s) before giving up on the holder; it waited %.2f s", waited);
  ctx.Assert(waited < 12, "the wait is bounded by the lock's TTL; this took %.2f s of virtual time", waited);
  ctx.Assert(calls.size() == 1, "the stale lock must cost exactly one load; load was called %d times", calls.size());
  ctx.Equal(caStored(ctx, "product:42"), caJSON(caProduct), "product:42 must hold the product");
  ctx.Equal(ctx.Redis.Exists("lock:product:42"), 0, "no lock may remain after the fill");
}
`,
  },
  debrief: `Three decisions carry this file. The lock is \`SET NX EX\`, one command, because the election and its safety net must be atomic: a holder that dies leaves a lock that expires on its own, and nobody has to detect the death — the losers' bounded wait is sized by that same TTL, which is why \`LOCK_TTL_S\` appears in both places. The winner reads the key **again** after winning, because "miss, then lock" is not atomic: between the two, another request may have finished the whole fill and released, and without the re-read the lock serialises the loads instead of collapsing them. And the sentinel is a value with its own, shorter TTL rather than an absence, because an absence is indistinguishable from a miss — a product page for an id that was deleted or never existed would otherwise cost a database query per request, forever. The \`finally\` around the fill is what makes a failing database a slow minute rather than a stuck hour: with the lock released, the next caller retries at once instead of polling a key nobody will write. Real systems add jitter to the TTL so a batch import does not expire everything in the same second, refresh hot keys ahead of expiry so the lock is rarely contended, coalesce identical requests inside one process before they reach Redis, and push \`invalidate\` through a change stream rather than trusting every writer to call it.`,
};
