import type {Step} from '@/lib/types';

export const topOfBookStep: Step = {
  id: 'top-of-book',
  title: 'Top of book in Redis, updated and published atomically',
  concept: 'redis',
  file: 'market_data',
  focus: ['engine', 'redis'],
  task: `## Task

After every order that changed the book, the engine calls \`publish_top_of_book(symbol, bid, ask, last)\`
(\`0\` when a side is empty or nothing has traded yet). Implement it so Redis holds the **current** top of
book and every subscriber hears about the change.

- Store the three values as fields \`bid\`, \`ask\`, \`last\` of the hash **\`book:{symbol}\`**.
- \`PUBLISH\` a JSON tick on the channel **\`ticks:{symbol}\`** containing the symbol and the same three fields.
- Do both inside **one \`MULTI\`/\`EXEC\` transaction**: no reader may ever see a tick that the hash does not
  yet reflect, or a hash that no tick announced.
- **No TTL** on the hash. This is state, not a cache — an expired top of book would read as "no such symbol".

:::widget kafka-partitions {"partitions": 8}

> Market data is keyed by symbol for the same reason orders are: the engine that owns \`ACME\`'s partition is the
> only writer of \`book:ACME\`, so the transaction protects readers from a torn update, not writers from each other.`,
  sequence: {
    participants: ['engine', 'Redis', 'Subscribers'],
    messages: [
      {from: 'engine', to: 'Redis', label: 'MULTI', kind: 'sync'},
      {from: 'engine', to: 'Redis', label: 'HSET book:ACME bid 10.05 ask 10.06 last 10.05', kind: 'sync'},
      {from: 'engine', to: 'Redis', label: 'PUBLISH ticks:ACME {"symbol":"ACME",…}', kind: 'sync'},
      {from: 'engine', to: 'Redis', label: 'EXEC', kind: 'sync'},
      {from: 'Redis', to: 'engine', label: '[3, 12] (fields set, subscribers reached)', kind: 'reply'},
      {from: 'Redis', to: 'Subscribers', label: 'message ticks:ACME', kind: 'async'},
    ],
  },
  hints: [
    'Build the two names first — `book:{symbol}` and `ticks:{symbol}` — and the fields map once; the tick payload is that same map plus the symbol.',
    'A transaction is a pipeline that Redis executes as one unit: open it (`pipeline(transaction=True)`, `TxPipelined`, `multi()`, `transaction()`), queue HSET and PUBLISH on it — not on the plain client — and execute.',
    'The `MULTI` needs one connection for its whole lifetime; with a pooled client (Jedis) borrow a connection for the call and return it afterwards.',
  ],
  checks: [
    {
      id: 'hash',
      title: 'Writes book:{symbol} as a hash with no TTL',
      detail:
        'The top of book lives in the hash `book:{symbol}`, set with HSET and never given an expiry: it is current state, not a cache entry.',
      match: {
        python: {
          all: [/f"book:\{symbol\}"/, /\.hset\([^\n]*mapping\s*=/],
          none: [/\.expire\(|\bex\s*=|\.hexpire\(/],
        },
        go: {all: [/"book:"\s*\+\s*symbol/, /\.HSet\(\s*ctx\s*,/], none: [/\.Expire\(|\.HExpire\(/]},
        scala: {all: [/s"book:\$symbol"/, /\.hset\(/], none: [/\.expire\(|\.hexpire\(/]},
        cpp: {all: [/"book:"\s*\+\s*symbol/, /\.hset\(/], none: [/\.expire\(|\.hexpire\(/]},
      },
    },
    {
      id: 'fields',
      title: 'Stores bid, ask and last',
      detail:
        'The hash carries exactly the three fields subscribers and the snapshot endpoint read: `bid`, `ask`, `last`.',
      match: {
        python: {all: [/"bid":\s*bid\b/, /"ask":\s*ask\b/, /"last":\s*last\b/]},
        go: {all: [/"bid":\s*bid\b/, /"ask":\s*ask\b/, /"last":\s*last\b/]},
        scala: {all: [/"bid"\s*->\s*bid\b/, /"ask"\s*->\s*ask\b/, /"last"\s*->\s*last\b/]},
        cpp: {all: [/\{"bid",\s*/, /\{"ask",\s*/, /\{"last",\s*/]},
      },
    },
    {
      id: 'publish',
      title: 'Publishes a tick with the symbol on ticks:{symbol}',
      detail:
        'PUBLISH on `ticks:{symbol}` a JSON document that names the symbol and repeats bid/ask/last, so a subscriber never has to read the hash.',
      match: {
        python: {all: [/f"ticks:\{symbol\}"/, /\.publish\(/, /"symbol":\s*symbol/]},
        go: {all: [/"ticks:"\s*\+\s*symbol/, /\.Publish\(\s*ctx\s*,/, /"symbol":\s*symbol/]},
        scala: {all: [/s"ticks:\$symbol"/, /\.publish\(/, /"symbol":"\$symbol"/]},
        cpp: {all: [/"ticks:"\s*\+\s*symbol/, /\.publish\(/, /\{"symbol",\s*symbol\}/]},
      },
    },
    {
      id: 'atomic',
      title: 'HSET and PUBLISH run in one MULTI/EXEC',
      detail:
        'Both commands are queued on a transaction and executed together; issuing either on the plain client lets a reader observe one without the other.',
      match: {
        python: {
          order: [/\.pipeline\(/, /\.hset\(/, /\.publish\(/, /\.execute\(\)/],
          none: [/transaction\s*=\s*False/, /\br\.hset\(/, /\br\.publish\(/],
        },
        go: {order: [/rdb\.TxPipelined?\(/, /\.HSet\(/, /\.Publish\(/], none: [/rdb\.HSet\(/, /rdb\.Publish\(/]},
        scala: {
          order: [/\.multi\(\)/, /\.hset\(/, /\.publish\(/, /\.exec\(\)/],
          none: [/jedis\.hset\(/, /jedis\.publish\(/],
        },
        cpp: {
          order: [/redis\.transaction\(\)/, /\.hset\(/, /\.publish\(/, /\.exec\(\)/],
          none: [/redis\.hset\(/, /redis\.publish\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def publish_top_of_book(symbol: str, bid: float, ask: float, last: float) -> None:
    """Called by the engine after every order that changed the book; 0 means an empty side / no trade yet."""
    # TODO: key book:{symbol}, channel ticks:{symbol}; fields {bid, ask, last}; payload = fields + symbol as JSON
    # TODO: one MULTI/EXEC: HSET the fields (no TTL) and PUBLISH the payload
    _ = json.dumps
    raise NotImplementedError
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def publish_top_of_book(symbol: str, bid: float, ask: float, last: float) -> None:
    """Called by the engine after every order that changed the book; 0 means an empty side / no trade yet."""
    key = f"book:{symbol}"
    channel = f"ticks:{symbol}"
    fields = {"bid": bid, "ask": ask, "last": last}
    payload = json.dumps({"symbol": symbol, **fields})
    pipe = r.pipeline(transaction=True)
    pipe.hset(key, mapping=fields)
    pipe.publish(channel, payload)
    pipe.execute()  # MULTI … EXEC: readers see the new hash and the tick together, or neither
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// publishTopOfBook is called by the engine after every order that changed the book; 0 means an empty
// side / no trade yet.
func publishTopOfBook(ctx context.Context, symbol string, bid, ask, last float64) error {
	// TODO: key book:{symbol}, channel ticks:{symbol}; fields {bid, ask, last}; payload = fields + symbol as JSON
	// TODO: one TxPipelined: HSet the fields (no TTL) and Publish the payload
	_ = json.Marshal
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// publishTopOfBook is called by the engine after every order that changed the book; 0 means an empty
// side / no trade yet.
func publishTopOfBook(ctx context.Context, symbol string, bid, ask, last float64) error {
	key := "book:" + symbol
	channel := "ticks:" + symbol
	fields := map[string]any{"bid": bid, "ask": ask, "last": last}
	payload, _ := json.Marshal(map[string]any{"symbol": symbol, "bid": bid, "ask": ask, "last": last})
	// MULTI … EXEC: readers see the new hash and the tick together, or neither.
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, key, fields)
		pipe.Publish(ctx, channel, payload)
		return nil
	})
	return err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPool
import scala.jdk.CollectionConverters._
import scala.util.Using

object MarketData {
  // MULTI/EXEC needs one dedicated connection for its whole lifetime: borrow one per call.
  private val pool = new JedisPool("redis", 6379)

  /** Called by the engine after every order that changed the book; 0 means an empty side / no trade yet. */
  def publishTopOfBook(symbol: String, bid: Double, ask: Double, last: Double): Unit = {
    // TODO: key book:{symbol}, channel ticks:{symbol}; fields {bid, ask, last}; payload = fields + symbol as JSON
    // TODO: Using.resource(pool.getResource) { jedis => one multi()/exec(): hset the fields (no TTL) and publish the payload }
    val _ = (pool, Using)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPool
import scala.jdk.CollectionConverters._
import scala.util.Using

object MarketData {
  // MULTI/EXEC needs one dedicated connection for its whole lifetime: borrow one per call.
  private val pool = new JedisPool("redis", 6379)

  /** Called by the engine after every order that changed the book; 0 means an empty side / no trade yet. */
  def publishTopOfBook(symbol: String, bid: Double, ask: Double, last: Double): Unit = {
    val key = s"book:$symbol"
    val channel = s"ticks:$symbol"
    val fields = Map("bid" -> bid.toString, "ask" -> ask.toString, "last" -> last.toString)
    val payload = s"""{"symbol":"$symbol","bid":$bid,"ask":$ask,"last":$last}"""
    Using.resource(pool.getResource) { jedis =>
      val tx = jedis.multi()
      tx.hset(key, fields.asJava)
      tx.publish(channel, payload)
      tx.exec() // readers see the new hash and the tick together, or neither
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// Called by the engine after every order that changed the book; 0 means an empty side / no trade yet.
void publish_top_of_book(const std::string& symbol, double bid, double ask, double last) {
  // TODO: key book:{symbol}, channel ticks:{symbol}; fields {bid, ask, last}; payload = fields + symbol as JSON
  // TODO: one redis.transaction(): hset the fields (no TTL) and publish the payload, then exec()
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// Called by the engine after every order that changed the book; 0 means an empty side / no trade yet.
void publish_top_of_book(const std::string& symbol, double bid, double ask, double last) {
  const std::string key = "book:" + symbol;
  const std::string channel = "ticks:" + symbol;
  const std::vector<std::pair<std::string, std::string>> fields = {
      {"bid", std::to_string(bid)}, {"ask", std::to_string(ask)}, {"last", std::to_string(last)}};
  const std::string payload = json{{"symbol", symbol}, {"bid", bid}, {"ask", ask}, {"last", last}}.dump();
  auto tx = redis.transaction();
  tx.hset(key, fields.begin(), fields.end()).publish(channel, payload).exec();  // MULTI … EXEC
}
`,
    },
  },
  debrief: `Two commands, one unit: the transaction is what lets the next step trust a subscriber's tick without re-reading the hash, and lets the snapshot endpoint trust the hash without a tick. The hash has no TTL because expiring it would turn "stale" into "absent", which is a worse lie. A single writer per key (thanks to the partition key) keeps the transaction simple — no WATCH, no Lua. Real market-data feeds add a sequence number to every tick so subscribers can detect gaps, keep the full depth (\`ZADD\` per price level, or a proper feed handler), and multicast at the network layer instead of Pub/Sub, which drops messages for slow subscribers.`,
};
