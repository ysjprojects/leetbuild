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
        typescript: {
          all: [/`book:\$\{symbol\}`|['"]book:['"]\s*\+\s*symbol/, /\.hset\(/],
          none: [/\.expire\(|['"]EX['"]|\.hexpire\(/],
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
        typescript: {all: [/\{[^}]*\bbid\b[^}]*\bask\b[^}]*\blast\b[^}]*\}/]},
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
        typescript: {
          all: [
            /`ticks:\$\{symbol\}`|['"]ticks:['"]\s*\+\s*symbol/,
            /\.publish\(/,
            /\{\s*symbol\s*[,}]|symbol:\s*symbol\b/,
          ],
        },
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
        typescript: {
          order: [/\.multi\(\)/, /\.hset\(/, /\.publish\(/, /\.exec\(\)/],
          none: [/\.pipeline\(/, /\bredis\.hset\(/, /\bredis\.publish\(/],
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
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Called by the engine after every order that changed the book; 0 means an empty side / no trade yet. */
export async function publishTopOfBook(symbol: string, bid: number, ask: number, last: number): Promise<void> {
  // TODO: key book:{symbol}, channel ticks:{symbol}; fields {bid, ask, last}; payload = fields + symbol as JSON
  // TODO: one MULTI/EXEC (redis.multi()…exec()): HSET the fields (no TTL) and PUBLISH the payload
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Called by the engine after every order that changed the book; 0 means an empty side / no trade yet. */
export async function publishTopOfBook(symbol: string, bid: number, ask: number, last: number): Promise<void> {
  const key = \`book:\${symbol}\`;
  const channel = \`ticks:\${symbol}\`;
  const fields = {bid, ask, last};
  const payload = JSON.stringify({symbol, ...fields});
  // MULTI … EXEC: readers see the new hash and the tick together, or neither.
  await redis.multi().hset(key, fields).publish(channel, payload).exec();
}
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
  harness: {
    python: `import json


def _market(ctx):
    """The module, with the fixed client r instrumented: direct commands and the pipelines it opens are recorded."""
    m = ctx.load("market_data")
    direct = []  # command names issued on the plain client
    pipelines = []  # (transaction flag, command names queued at execute time)
    r = m.r
    real_execute_command = r.execute_command
    real_pipeline = r.pipeline

    def execute_command(*args, **kwargs):
        direct.append(str(args[0]).upper())
        return real_execute_command(*args, **kwargs)

    def pipeline(transaction=True, shard_hint=None):
        pipe = real_pipeline(transaction=transaction, shard_hint=shard_hint)
        real_execute = pipe.execute

        def execute(*args, **kwargs):
            pipelines.append((bool(pipe.transaction), [str(cmd[0][0]).upper() for cmd in pipe.command_stack]))
            return real_execute(*args, **kwargs)

        pipe.execute = execute
        return pipe

    r.execute_command = execute_command
    r.pipeline = pipeline
    return m, direct, pipelines


def _subscriber(ctx, symbol):
    pubsub = ctx.redis.pubsub(ignore_subscribe_messages=True)
    pubsub.subscribe("ticks:" + symbol)
    pubsub.get_message(timeout=0.01)  # consume the subscribe confirmation
    return pubsub


def check_hash(ctx):
    m, _, _ = _market(ctx)
    m.publish_top_of_book("ACME", 10.05, 10.06, 10.05)
    assert ctx.redis.type("book:ACME") == "hash", f"book:ACME is {ctx.redis.type('book:ACME')!r}, expected a hash"
    assert ctx.redis.ttl("book:ACME") == -1, f"book:ACME has a TTL of {ctx.redis.ttl('book:ACME')}s; the top of book is state, not a cache entry"
    m.publish_top_of_book("ACME", 10.07, 10.08, 10.07)
    assert float(ctx.redis.hget("book:ACME", "bid")) == 10.07, "a second update must overwrite the hash with the current top of book"


def check_fields(ctx):
    m, _, _ = _market(ctx)
    m.publish_top_of_book("ACME", 10.05, 10.06, 10.0)
    fields = ctx.redis.hgetall("book:ACME")
    assert set(fields) == {"bid", "ask", "last"}, f"book:ACME has fields {sorted(fields)}, expected exactly bid, ask, last"
    values = {k: float(v) for k, v in fields.items()}
    assert values == {"bid": 10.05, "ask": 10.06, "last": 10.0}, f"book:ACME holds {values}, expected bid 10.05, ask 10.06, last 10.0"
    m.publish_top_of_book("NEW", 0, 10.5, 0)
    assert {k: float(v) for k, v in ctx.redis.hgetall("book:NEW").items()} == {"bid": 0.0, "ask": 10.5, "last": 0.0}, "an empty side (0) must still be stored as 0"


def check_publish(ctx):
    m, _, _ = _market(ctx)
    pubsub = _subscriber(ctx, "ACME")
    other = _subscriber(ctx, "BETA")
    m.publish_top_of_book("ACME", 10.05, 10.06, 10.05)
    message = pubsub.get_message(timeout=0.2)
    assert message is not None, "nothing was published on ticks:ACME"
    tick = json.loads(message["data"])
    assert tick.get("symbol") == "ACME", f"the tick must name the symbol, got {tick}"
    assert (float(tick.get("bid", -1)), float(tick.get("ask", -1)), float(tick.get("last", -1))) == (10.05, 10.06, 10.05), f"the tick must repeat bid/ask/last, got {tick}"
    assert other.get_message(timeout=0.05) is None, "the tick for ACME leaked onto ticks:BETA"


def check_atomic(ctx):
    m, direct, pipelines = _market(ctx)
    pubsub = _subscriber(ctx, "ACME")
    m.publish_top_of_book("ACME", 10.05, 10.06, 10.05)
    assert ctx.redis.hgetall("book:ACME") and pubsub.get_message(timeout=0.2) is not None, "the hash and the tick must both be produced"
    plain = [c for c in direct if c in ("HSET", "HMSET", "PUBLISH")]
    assert not plain, f"{plain} were issued on the plain client, outside any transaction"
    assert pipelines, "no pipeline was executed: HSET and PUBLISH must run in one MULTI/EXEC"
    transaction, commands = pipelines[-1]
    assert transaction, "the pipeline was opened with transaction=False: without MULTI/EXEC a reader can see one command without the other"
    assert any(c in ("HSET", "HMSET") for c in commands) and "PUBLISH" in commands, f"the transaction queued {commands}; it must hold both the HSET and the PUBLISH"
`,
    typescript: `/** Another connection subscribed to ticks:{symbol}: every message it received, in order. */
function subscriber(ctx, symbol: string): string[] {
  const received: string[] = [];
  ctx.redisSubscribe('ticks:' + symbol, (_channel: string, message: string) => received.push(message));
  return received;
}

/** Pub/Sub delivery lands a microtask after the PUBLISH. */
async function delivered(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export async function check_hash(ctx) {
  const m = ctx.load('market_data');
  await m.publishTopOfBook('ACME', 10.05, 10.06, 10.05);
  assert.equal(ctx.redis.type('book:ACME'), 'hash', \`book:ACME is \${JSON.stringify(ctx.redis.type('book:ACME'))}, expected a hash\`);
  assert.equal(ctx.redis.ttl('book:ACME'), -1, \`book:ACME has a TTL of \${ctx.redis.ttl('book:ACME')} s; the top of book is state, not a cache entry\`);
  await m.publishTopOfBook('ACME', 10.07, 10.08, 10.07);
  assert.equal(Number(ctx.redis.hget('book:ACME', 'bid')), 10.07, 'a second update must overwrite the hash with the current top of book');
}

export async function check_fields(ctx) {
  const m = ctx.load('market_data');
  await m.publishTopOfBook('ACME', 10.05, 10.06, 10.0);
  const fields = ctx.redis.hgetall('book:ACME');
  assert.deepEqual(Object.keys(fields).sort(), ['ask', 'bid', 'last'], \`book:ACME has fields \${JSON.stringify(Object.keys(fields).sort())}, expected exactly bid, ask, last\`);
  const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Number(v)]));
  assert.deepEqual(values, {bid: 10.05, ask: 10.06, last: 10.0}, \`book:ACME holds \${JSON.stringify(values)}, expected bid 10.05, ask 10.06, last 10.0\`);
  await m.publishTopOfBook('NEW', 0, 10.5, 0);
  const empty = Object.fromEntries(Object.entries(ctx.redis.hgetall('book:NEW')).map(([k, v]) => [k, Number(v)]));
  assert.deepEqual(empty, {bid: 0, ask: 10.5, last: 0}, 'an empty side (0) must still be stored as 0');
}

export async function check_publish(ctx) {
  const m = ctx.load('market_data');
  const received = subscriber(ctx, 'ACME');
  const other = subscriber(ctx, 'BETA');
  await m.publishTopOfBook('ACME', 10.05, 10.06, 10.05);
  await delivered();
  assert(received.length > 0, 'nothing was published on ticks:ACME');
  const tick = JSON.parse(received[0]);
  assert.equal(tick.symbol, 'ACME', \`the tick must name the symbol, got \${received[0]}\`);
  assert.deepEqual([Number(tick.bid ?? -1), Number(tick.ask ?? -1), Number(tick.last ?? -1)], [10.05, 10.06, 10.05], \`the tick must repeat bid/ask/last, got \${received[0]}\`);
  assert.deepEqual(other, [], 'the tick for ACME leaked onto ticks:BETA');
}

export async function check_atomic(ctx) {
  const m = ctx.load('market_data');
  ctx.redis.hset('book:ACME', 'bid', '1', 'ask', '2', 'last', '1');
  const received = subscriber(ctx, 'ACME');
  // Two readers that land between the commands, as another connection's request would:
  // one reads the hash the moment a tick is out, the other announces itself the moment the hash changed.
  let bidWhenTickOut: unknown = null;
  ctx.redisAfter('ticks:ACME', () => (bidWhenTickOut = ctx.redis.hget('book:ACME', 'bid')));
  ctx.redisAfter('book:ACME', () => ctx.redis.publish('ticks:ACME', 'reader saw the hash'));
  await m.publishTopOfBook('ACME', 10.05, 10.06, 10.05);
  await delivered();
  assert(Object.keys(ctx.redis.hgetall('book:ACME')).length > 0 && received.length > 0, 'the hash and the tick must both be produced');
  assert.equal(Number(bidWhenTickOut), 10.05, \`the tick was published while book:ACME still held bid \${JSON.stringify(bidWhenTickOut)}: a reader woken by the tick would read a stale hash. HSET and PUBLISH belong in one MULTI/EXEC\`);
  assert.notEqual(received[0], 'reader saw the hash', 'a reader saw the new book:ACME before any tick announced it: without MULTI/EXEC a reader can see one command without the other');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"

	"leetbuild/harness"
)

func publishTop(ctx *harness.Ctx, symbol string, bid, ask, last float64) {
	ctx.NoError(publishTopOfBook(context.Background(), symbol, bid, ask, last), "publishTopOfBook(%q, %v, %v, %v) returned an error", symbol, bid, ask, last)
}

// tickListener is another connection subscribed to ticks:{symbol}: every message it received, in order.
func tickListener(ctx *harness.Ctx, symbol string) *[]string {
	received := &[]string{}
	ctx.Redis.Subscribe("ticks:"+symbol, func(_, message string) { *received = append(*received, message) })
	return received
}

// numericHash is the hash with every value read as a number.
func numericHash(ctx *harness.Ctx, key string) map[string]float64 {
	out := map[string]float64{}
	for k, v := range ctx.Redis.HGetAll(key) {
		n, err := strconv.ParseFloat(v, 64)
		ctx.NoError(err, "%s field %s holds %q, not a number", key, k, v)
		out[k] = n
	}
	return out
}

// asNumber is the TypeScript Number(v ?? -1): a JSON number, or a string holding one.
func asNumber(v any) any {
	switch n := v.(type) {
	case nil:
		return -1.0
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil {
			return f
		}
	}
	return v
}

func CheckHash(ctx *harness.Ctx) {
	publishTop(ctx, "ACME", 10.05, 10.06, 10.05)
	ctx.Equal(ctx.Redis.Type("book:ACME"), "hash", "the type of book:ACME")
	ttl := ctx.Redis.TTL("book:ACME")
	ctx.Equal(ttl, -1, "book:ACME has a TTL of %d s; the top of book is state, not a cache entry; TTL", ttl)
	publishTop(ctx, "ACME", 10.07, 10.08, 10.07)
	ctx.Equal(numericHash(ctx, "book:ACME")["bid"], 10.07, "a second update must overwrite the hash with the current top of book; bid")
}

func CheckFields(ctx *harness.Ctx) {
	publishTop(ctx, "ACME", 10.05, 10.06, 10.0)
	fields := []string{}
	for k := range ctx.Redis.HGetAll("book:ACME") {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"ask", "bid", "last"}, "book:ACME must have exactly the fields bid, ask, last")
	ctx.Equal(numericHash(ctx, "book:ACME"), map[string]float64{"bid": 10.05, "ask": 10.06, "last": 10.0}, "book:ACME must hold bid 10.05, ask 10.06, last 10.0")
	publishTop(ctx, "NEW", 0, 10.5, 0)
	ctx.Equal(numericHash(ctx, "book:NEW"), map[string]float64{"bid": 0, "ask": 10.5, "last": 0}, "an empty side (0) must still be stored as 0")
}

func CheckPublish(ctx *harness.Ctx) {
	received := tickListener(ctx, "ACME")
	other := tickListener(ctx, "BETA")
	publishTop(ctx, "ACME", 10.05, 10.06, 10.05)
	ctx.Settle()
	ctx.Assert(len(*received) > 0, "nothing was published on ticks:ACME")
	var tick map[string]any
	ctx.NoError(json.Unmarshal([]byte((*received)[0]), &tick), "the tick must be JSON, got %q", (*received)[0])
	ctx.Equal(tick["symbol"], "ACME", "the tick must name the symbol, got %s; symbol", (*received)[0])
	ctx.Equal([]any{asNumber(tick["bid"]), asNumber(tick["ask"]), asNumber(tick["last"])}, []any{10.05, 10.06, 10.05}, "the tick must repeat bid/ask/last, got %s", (*received)[0])
	ctx.Equal(len(*other), 0, "the tick for ACME leaked onto ticks:BETA; messages there")
}

func CheckAtomic(ctx *harness.Ctx) {
	ctx.Redis.Do("HSET", "book:ACME", "bid", "1", "ask", "2", "last", "1")
	received := tickListener(ctx, "ACME")
	// Two readers that land between the commands, as another connection's request would: one reads
	// the hash the moment a tick is out, the other announces itself the moment the hash changed.
	var bidWhenTickOut any
	ctx.Redis.After("ticks:ACME", func() any {
		bidWhenTickOut, _ = ctx.Redis.HGet("book:ACME", "bid")
		return nil
	})
	ctx.Redis.After("book:ACME", func() any { return ctx.Redis.Publish("ticks:ACME", "reader saw the hash") })
	publishTop(ctx, "ACME", 10.05, 10.06, 10.05)
	ctx.Settle()
	ctx.Assert(len(ctx.Redis.HGetAll("book:ACME")) > 0 && len(*received) > 0, "the hash and the tick must both be produced")
	ctx.Equal(asNumber(bidWhenTickOut), 10.05, "the tick was published while book:ACME still held an older bid: a reader woken by the tick would read a stale hash. HSet and Publish belong in one TxPipelined; bid when the tick was out")
	ctx.Assert((*received)[0] != "reader saw the hash", "a reader saw the new book:ACME before any tick announced it: without MULTI/EXEC (TxPipelined) a reader can see one command without the other")
}
`,
  },
  debrief: `Two commands, one unit: the transaction is what lets the next step trust a subscriber's tick without re-reading the hash, and lets the snapshot endpoint trust the hash without a tick. The hash has no TTL because expiring it would turn "stale" into "absent", which is a worse lie. A single writer per key (thanks to the partition key) keeps the transaction simple — no WATCH, no Lua. Real market-data feeds add a sequence number to every tick so subscribers can detect gaps, keep the full depth (\`ZADD\` per price level, or a proper feed handler), and multicast at the network layer instead of Pub/Sub, which drops messages for slow subscribers.`,
};
