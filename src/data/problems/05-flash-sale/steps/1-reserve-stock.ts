import type {Step} from '@/lib/types';

const LUA_EXISTS_HOLD = /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)\s*==\s*1/i;
const LUA_GET_STOCK = /redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[1\]\s*\)/i;
// Any ordering comparison between the GET and the DECRBY: `stock < qty`, `qty > have`, `tonumber(ARGV[1]) > n`…
const LUA_COMPARE = /[<>]=?/;
const LUA_DECRBY = /redis\.call\(\s*['"]DECRBY['"]\s*,\s*KEYS\[1\]/i;
const LUA_SET_HOLD =
  /redis\.call\(\s*['"]SET['"]\s*,\s*KEYS\[2\]\s*,\s*ARGV\[\d\]\s*,\s*['"]EX['"]|redis\.call\(\s*['"]SETEX['"]\s*,\s*KEYS\[2\]\s*,/i;
const LUA_ZADD = /redis\.call\(\s*['"]ZADD['"]\s*,\s*KEYS\[3\]\s*,\s*ARGV\[\d\]\s*,\s*ARGV\[\d\]/i;

export const reserveStockStep: Step = {
  id: 'reserve-stock',
  title: 'Reserve stock atomically with a Lua script',
  concept: 'redis',
  file: 'reservations',
  focus: ['checkout', 'redis'],
  task: `## Task

Ten thousand people press *Buy* in the same second for 500 pairs of shoes. Implement
\`reserve(sku, order_id, qty)\` so the counter in Redis can never go negative and never hands the same
unit to two orders:

- All of it runs as **one Lua script**. Redis executes a script atomically, so nobody can read
  \`stock:{sku}\` between your check and your decrement.
- If \`hold:{order_id}\` already exists, return **1** without touching stock: the checkout API retries,
  and a retry must not reserve twice.
- Read \`stock:{sku}\`; if it is smaller than \`qty\`, return **0** (sold out).
- Otherwise \`DECRBY stock:{sku} qty\`, \`SET hold:{order_id} <member> EX <2 × 600 s>\` and
  \`ZADD holds <now + 600> <member>\` where the member is \`{order_id}:{sku}:{qty}\`; return **1**.
- Register the script once (\`register_script\` / \`NewScript\` / \`scriptLoad\` / \`script_load\`) so
  each call is an \`EVALSHA\`, not a 300-byte upload.

:::widget idempotency {}

> The sorted set is the expiry queue the sweeper (step 5) drains; the key's TTL is only garbage
> collection, twice as long so a slow sweeper still finds the hold. A client-side \`GET\` followed by a
> \`DECRBY\` would let two requests both see "1 left" and both take it.`,
  sequence: {
    participants: ['checkout', 'Redis'],
    messages: [
      {from: 'checkout', to: 'Redis', label: 'EVALSHA reserve · stock:shoe-42 hold:o1 holds · qty 2', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'GET stock → 3 · DECRBY 2 · SET hold EX · ZADD holds', kind: 'sync'},
      {from: 'Redis', to: 'checkout', label: '1', kind: 'reply'},
      {from: 'checkout', to: 'Redis', label: 'EVALSHA reserve · hold:o2 · qty 2', kind: 'sync'},
      {from: 'Redis', to: 'checkout', label: '0 (1 left < 2)', kind: 'reply'},
      {from: 'checkout', to: 'Redis', label: 'EVALSHA reserve · hold:o1 again (retry)', kind: 'sync'},
      {from: 'Redis', to: 'checkout', label: '1 (hold exists, stock untouched)', kind: 'reply'},
    ],
  },
  hints: [
    'Everything that reads stock and everything that writes it belongs inside the script; the client only builds keys and arguments and looks at the integer that comes back.',
    'Lua sees Redis values as strings: wrap the `GET` in `tonumber(... or "0")` and compare with `tonumber(ARGV[1])`. Put the `EXISTS hold` check first so a retried order returns 1 before any arithmetic.',
    'Pass three KEYS (`stock:{sku}`, `hold:{order_id}`, `holds`) and four ARGV (qty, member, key TTL, expiry timestamp). Registering the script gives you a callable or a SHA; invoke it with those lists and compare the result with 1.',
  ],
  checks: [
    {
      id: 'idempotent-retry',
      title: 'A retried order does not reserve twice',
      detail:
        'The script checks `EXISTS hold:{order_id}` before any arithmetic and returns 1 when the hold is already there.',
      match: {
        python: {order: [LUA_EXISTS_HOLD, LUA_DECRBY]},
        typescript: {order: [LUA_EXISTS_HOLD, LUA_DECRBY]},
        go: {order: [LUA_EXISTS_HOLD, LUA_DECRBY]},
        scala: {order: [LUA_EXISTS_HOLD, LUA_DECRBY]},
        cpp: {order: [LUA_EXISTS_HOLD, LUA_DECRBY]},
      },
    },
    {
      id: 'check-then-decrement',
      title: 'Checks stock and decrements inside the script',
      detail:
        'The Lua script reads `stock:{sku}`, compares it with the quantity and only then `DECRBY`s — the check and the write are one atomic unit.',
      match: {
        python: {order: [LUA_GET_STOCK, LUA_COMPARE, LUA_DECRBY]},
        typescript: {order: [LUA_GET_STOCK, LUA_COMPARE, LUA_DECRBY]},
        go: {order: [LUA_GET_STOCK, LUA_COMPARE, LUA_DECRBY]},
        scala: {order: [LUA_GET_STOCK, LUA_COMPARE, LUA_DECRBY]},
        cpp: {order: [LUA_GET_STOCK, LUA_COMPARE, LUA_DECRBY]},
      },
    },
    {
      id: 'hold-ttl',
      title: 'Writes the hold with an expiry',
      detail:
        'A successful reservation `SET`s `hold:{order_id}` with `EX` (or `SETEX`); a hold key without a TTL would outlive every crash of the sweeper.',
      match: {
        python: {all: [LUA_SET_HOLD]},
        typescript: {all: [LUA_SET_HOLD]},
        go: {all: [LUA_SET_HOLD]},
        scala: {all: [LUA_SET_HOLD]},
        cpp: {all: [LUA_SET_HOLD]},
      },
    },
    {
      id: 'expiry-index',
      title: 'Indexes the hold in the holds sorted set',
      detail:
        '`ZADD holds <expiry> <member>` is what lets the sweeper find expired holds by time instead of scanning keys.',
      match: {
        python: {all: [LUA_ZADD]},
        typescript: {all: [LUA_ZADD]},
        go: {all: [LUA_ZADD]},
        scala: {all: [LUA_ZADD]},
        cpp: {all: [LUA_ZADD]},
      },
    },
    {
      id: 'script-once',
      title: 'Registers the script once; no client-side read-modify-write',
      detail:
        'Load the script once (`register_script` / `NewScript` / `scriptLoad` / `script_load`) and call it by SHA — no per-call `EVAL` upload; a `GET` followed by a `DECRBY` from the client is exactly the race the script exists to remove.',
      match: {
        python: {
          all: [/\br\.register_script\(\s*RESERVE_LUA\s*\)/, /\bkeys\s*=\s*\[|\(\s*\[\s*f?["']stock:/],
          none: [/\br\.get\(/, /\br\.decrby\(/, /\br\.eval\(/],
        },
        typescript: {
          all: [/\bredis\.defineCommand\(\s*['"]reserve['"]\s*,\s*\{[^}]*lua:\s*RESERVE_LUA/, /\bredis\.reserve\(/],
          none: [/\bredis\.get\(/, /\bredis\.decrby\(/, /\bredis\.eval\(/],
        },
        go: {
          all: [/redis\.NewScript\(\s*reserveLua\s*\)/, /\.(Run|EvalSha)\(\s*ctx\s*,\s*rdb\s*,/],
          none: [/rdb\.Get\(/, /rdb\.DecrBy\(/, /rdb\.Eval\(/],
        },
        scala: {
          all: [/jedis\.scriptLoad\(\s*ReserveLua\s*\)/, /jedis\.evalsha\(/],
          none: [/jedis\.get\(/, /jedis\.decrBy\(/, /jedis\.eval\(/],
        },
        cpp: {
          all: [/redis\.script_load\(\s*kReserveLua\s*\)/, /redis\.evalsha<\s*long(\s+long)?\s*>\(/],
          none: [/redis\.get\(/, /redis\.decrby\(/, /redis\.eval</],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379)

HOLD_TTL_S = 600

# KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
# ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
RESERVE_LUA = """
return 0
"""

# TODO: register RESERVE_LUA once so every call is an EVALSHA, not a script upload


def reserve(sku: str, order_id: str, qty: int) -> bool:
    """Takes qty units of sku for order_id; False when the drop is sold out."""
    expires_at = int(time.time()) + HOLD_TTL_S
    member = f"{order_id}:{sku}:{qty}"
    # TODO: the script: EXISTS hold → 1; GET stock < qty → 0; DECRBY, SET hold EX, ZADD holds → 1
    # TODO: run it with the three keys and four args; never GET/DECRBY from here
    raise NotImplementedError
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379)

HOLD_TTL_S = 600

# KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
# ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
RESERVE_LUA = """
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 1
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock < tonumber(ARGV[1]) then
  return 0
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
return 1
"""

reserve_script = r.register_script(RESERVE_LUA)


def reserve(sku: str, order_id: str, qty: int) -> bool:
    """Takes qty units of sku for order_id; False when the drop is sold out."""
    expires_at = int(time.time()) + HOLD_TTL_S
    member = f"{order_id}:{sku}:{qty}"
    keys = [f"stock:{sku}", f"hold:{order_id}", "holds"]
    args = [qty, member, 2 * HOLD_TTL_S, expires_at]
    return reserve_script(keys=keys, args=args) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

export const HOLD_TTL_S = 600;

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
const RESERVE_LUA = \`
return 0
\`;

/** The client with the reservation script registered as a command. */
interface ReservingRedis extends Redis {
  reserve(
    stockKey: string,
    holdKey: string,
    holdsKey: string,
    qty: number,
    member: string,
    ttl: number,
    expiresAt: number,
  ): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReservingRedis;
// TODO: register RESERVE_LUA once with defineCommand so every call is an EVALSHA, not a script upload

/** Takes qty units of sku for orderId; false when the drop is sold out. */
export async function reserve(sku: string, orderId: string, qty: number): Promise<boolean> {
  const expiresAt = Math.floor(Date.now() / 1000) + HOLD_TTL_S;
  const member = \`\${orderId}:\${sku}:\${qty}\`;
  // TODO: the script: EXISTS hold → 1; GET stock < qty → 0; DECRBY, SET hold EX, ZADD holds → 1
  // TODO: run it with the three keys and four args; never GET/DECRBY from here
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

export const HOLD_TTL_S = 600;

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
const RESERVE_LUA = \`
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 1
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock < tonumber(ARGV[1]) then
  return 0
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
return 1
\`;

/** The client with the reservation script registered as a command. */
interface ReservingRedis extends Redis {
  reserve(
    stockKey: string,
    holdKey: string,
    holdsKey: string,
    qty: number,
    member: string,
    ttl: number,
    expiresAt: number,
  ): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReservingRedis;
redis.defineCommand('reserve', {numberOfKeys: 3, lua: RESERVE_LUA});

/** Takes qty units of sku for orderId; false when the drop is sold out. */
export async function reserve(sku: string, orderId: string, qty: number): Promise<boolean> {
  const expiresAt = Math.floor(Date.now() / 1000) + HOLD_TTL_S;
  const member = \`\${orderId}:\${sku}:\${qty}\`;
  const result = await redis.reserve(\`stock:\${sku}\`, \`hold:\${orderId}\`, 'holds', qty, member, 2 * HOLD_TTL_S, expiresAt);
  return result === 1;
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

const holdTTL = 10 * time.Minute

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
const reserveLua = \`
return 0
\`

var reserveScript *redis.Script // TODO: redis.NewScript(reserveLua), once; Run then uses EVALSHA

// reserve takes qty units of sku for orderID; false when the drop is sold out.
func reserve(ctx context.Context, sku, orderID string, qty int) (bool, error) {
	expiresAt := time.Now().Add(holdTTL).Unix()
	member := fmt.Sprintf("%s:%s:%d", orderID, sku, qty)
	// TODO: the script: EXISTS hold → 1; GET stock < qty → 0; DECRBY, SET hold EX, ZADD holds → 1
	// TODO: Run it with the three keys and four args; never Get/DecrBy from here
	_ = expiresAt
	_ = member
	return false, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const holdTTL = 10 * time.Minute

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
const reserveLua = \`
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 1
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock < tonumber(ARGV[1]) then
  return 0
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
return 1
\`

var reserveScript = redis.NewScript(reserveLua)

// reserve takes qty units of sku for orderID; false when the drop is sold out.
func reserve(ctx context.Context, sku, orderID string, qty int) (bool, error) {
	expiresAt := time.Now().Add(holdTTL).Unix()
	member := fmt.Sprintf("%s:%s:%d", orderID, sku, qty)
	keys := []string{"stock:" + sku, "hold:" + orderID, "holds"}
	n, err := reserveScript.Run(ctx, rdb, keys, qty, member, int(2*holdTTL/time.Second), expiresAt).Int()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object Reservations {
  val jedis = new JedisPooled("redis", 6379)
  val HoldTtlSeconds = 600L

  // KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
  // ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
  val ReserveLua: String =
    """
      |return 0
      |""".stripMargin

  // TODO: scriptLoad the script once and keep the SHA; every call is then an EVALSHA

  /** Takes qty units of sku for orderId; false when the drop is sold out. */
  def reserve(sku: String, orderId: String, qty: Int): Boolean = {
    val expiresAt = System.currentTimeMillis() / 1000 + HoldTtlSeconds
    val member = s"$orderId:$sku:$qty"
    // TODO: the script: EXISTS hold → 1; GET stock < qty → 0; DECRBY, SET hold EX, ZADD holds → 1
    // TODO: evalsha it with the three keys and four args; never get/decrBy from here
    false
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object Reservations {
  val jedis = new JedisPooled("redis", 6379)
  val HoldTtlSeconds = 600L

  // KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
  // ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
  val ReserveLua: String =
    """
      |if redis.call('EXISTS', KEYS[2]) == 1 then
      |  return 1
      |end
      |local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
      |if stock < tonumber(ARGV[1]) then
      |  return 0
      |end
      |redis.call('DECRBY', KEYS[1], ARGV[1])
      |redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
      |redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
      |return 1
      |""".stripMargin

  private val reserveSha: String = jedis.scriptLoad(ReserveLua)

  /** Takes qty units of sku for orderId; false when the drop is sold out. */
  def reserve(sku: String, orderId: String, qty: Int): Boolean = {
    val expiresAt = System.currentTimeMillis() / 1000 + HoldTtlSeconds
    val member = s"$orderId:$sku:$qty"
    val keys = List(s"stock:$sku", s"hold:$orderId", "holds").asJava
    val args = List(qty.toString, member, (2 * HoldTtlSeconds).toString, expiresAt.toString).asJava
    jedis.evalsha(reserveSha, keys, args).asInstanceOf[Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kHoldTtl{600};

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
const std::string kReserveLua = R"lua(
return 0
)lua";

// TODO: script_load the script once and keep the SHA; every call is then an EVALSHA

// Takes qty units of sku for order_id; false when the drop is sold out.
bool reserve(const std::string& sku, const std::string& order_id, int qty) {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  const long long expires_at = std::chrono::duration_cast<std::chrono::seconds>(now).count() + kHoldTtl.count();
  const std::string member = order_id + ":" + sku + ":" + std::to_string(qty);
  // TODO: the script: EXISTS hold → 1; GET stock < qty → 0; DECRBY, SET hold EX, ZADD holds → 1
  // TODO: evalsha<long long> it with the three keys and four args; never get/decrby from here
  (void)expires_at;
  (void)member;
  return false;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kHoldTtl{600};

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"   ARGV[3] = key TTL   ARGV[4] = expiry timestamp
const std::string kReserveLua = R"lua(
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 1
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock < tonumber(ARGV[1]) then
  return 0
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
return 1
)lua";

const std::string reserve_sha = redis.script_load(kReserveLua);

// Takes qty units of sku for order_id; false when the drop is sold out.
bool reserve(const std::string& sku, const std::string& order_id, int qty) {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  const long long expires_at = std::chrono::duration_cast<std::chrono::seconds>(now).count() + kHoldTtl.count();
  const std::string member = order_id + ":" + sku + ":" + std::to_string(qty);
  const std::vector<std::string> keys{"stock:" + sku, "hold:" + order_id, "holds"};
  const std::vector<std::string> args{std::to_string(qty), member, std::to_string(2 * kHoldTtl.count()),
                                      std::to_string(expires_at)};
  return redis.evalsha<long long>(reserve_sha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}
`,
    },
  },
  harness: {
    python: `import time

SKU = "shoe-42"
STOCK = "stock:shoe-42"


def _reservations(ctx, stock):
    ctx.redis.set(STOCK, stock)
    return ctx.load("reservations")


def check_idempotent_retry(ctx):
    m = _reservations(ctx, 3)
    assert m.reserve(SKU, "o1", 2), "3 in stock must cover an order of 2: expected True"
    assert ctx.redis.get(STOCK) == "1", f"stock after reserving 2 of 3 is {ctx.redis.get(STOCK)!r}, expected 1"
    assert m.reserve(SKU, "o1", 2), "a retried order whose hold exists must return True"
    assert ctx.redis.get(STOCK) == "1", f"the retry decremented stock again: {ctx.redis.get(STOCK)!r}, expected still 1"
    assert ctx.redis.zcard("holds") == 1, f"holds has {ctx.redis.zcard('holds')} members after a retry, expected 1"
    assert ctx.redis.get("hold:o1") == "o1:shoe-42:2", "the retry must leave the existing hold in place"


def check_check_then_decrement(ctx):
    m = _reservations(ctx, 3)
    assert m.reserve(SKU, "o1", 2), "3 in stock must cover an order of 2: expected True"
    assert ctx.redis.get(STOCK) == "1", f"stock is {ctx.redis.get(STOCK)!r} after reserving 2 of 3, expected 1"
    assert not m.reserve(SKU, "o2", 2), "1 left cannot cover an order of 2: expected False (sold out)"
    assert ctx.redis.get(STOCK) == "1", f"a refused reservation changed stock to {ctx.redis.get(STOCK)!r}; it must stay 1"
    assert ctx.redis.exists("hold:o2") == 0, "a refused reservation must not write hold:o2"
    assert m.reserve(SKU, "o3", 1), "1 left must cover an order of 1"
    assert ctx.redis.get(STOCK) == "0", f"stock is {ctx.redis.get(STOCK)!r}, expected 0"
    assert not m.reserve(SKU, "o4", 1), "stock 0 must refuse every further order; the counter may never go negative"
    assert ctx.redis.get(STOCK) == "0", f"stock went to {ctx.redis.get(STOCK)!r}: the script must not decrement below zero"
    assert not m.reserve("never-stocked", "o5", 1), "a missing stock key counts as 0: expected False"


def check_hold_ttl(ctx):
    m = _reservations(ctx, 5)
    assert m.reserve(SKU, "o1", 2), "5 in stock must cover an order of 2"
    assert ctx.redis.get("hold:o1") == "o1:shoe-42:2", f"hold:o1 is {ctx.redis.get('hold:o1')!r}, expected the member o1:shoe-42:2"
    ttl = ctx.redis.ttl("hold:o1")
    assert ttl > 0, "hold:o1 has no TTL: a crashed sweeper would leave it forever"
    assert 1190 <= ttl <= 1200, f"hold:o1 TTL is {ttl} s, expected 2 x HOLD_TTL_S = 1200 s"
    ctx.clock.advance(1201)
    assert ctx.redis.get("hold:o1") is None, "hold:o1 must be gone once its TTL has passed"


def check_expiry_index(ctx):
    m = _reservations(ctx, 5)
    before = int(time.time())
    assert m.reserve(SKU, "o1", 2), "5 in stock must cover an order of 2"
    score = ctx.redis.zscore("holds", "o1:shoe-42:2")
    assert score is not None, f"holds contains {ctx.redis.zrange('holds', 0, -1)}, expected the member o1:shoe-42:2"
    assert before + 599 <= score <= time.time() + 601, f"the member's score is {score}, expected now + 600 s ({before + 600})"
    assert not m.reserve(SKU, "o2", 9), "9 of 3 left must be refused"
    assert ctx.redis.zcard("holds") == 1, "a refused reservation must not be indexed in holds"


def check_script_once(ctx):
    m = _reservations(ctx, 5)
    client = m.r
    counts = {"eval": 0, "evalsha": 0, "script_load": 0}

    def forbid(name):
        def call(*args, **kwargs):
            raise AssertionError(f"r.{name}() was called from the client: every read and write of stock and holds belongs inside the script")

        return call

    def counting(name):
        original = getattr(client, name)

        def call(*args, **kwargs):
            counts[name] += 1
            return original(*args, **kwargs)

        return call

    for name in ("get", "decrby", "decr", "incrby", "set", "setex", "zadd"):
        setattr(client, name, forbid(name))
    for name in counts:
        setattr(client, name, counting(name))
    for i in range(3):
        assert m.reserve(SKU, f"o{i}", 1), f"order o{i} must be reserved"
    assert counts["eval"] == 0, f"EVAL was sent {counts['eval']} times: register the script once and call it by SHA"
    assert counts["evalsha"] >= 3, f"expected one EVALSHA per reserve call, saw {counts['evalsha']}"
    assert counts["script_load"] <= 1, f"the script was uploaded {counts['script_load']} times; once is enough"
    assert ctx.redis.get(STOCK) == "2", f"stock is {ctx.redis.get(STOCK)!r} after three reservations of 1, expected 2"
`,
    typescript: `const SKU = 'shoe-42';
const STOCK = 'stock:shoe-42';

function reservations(ctx, stock: number) {
  ctx.redis.set(STOCK, stock);
  return ctx.load('reservations');
}

export async function check_idempotent_retry(ctx) {
  const m = reservations(ctx, 3);
  assert(await m.reserve(SKU, 'o1', 2), '3 in stock must cover an order of 2: expected true');
  assert.equal(ctx.redis.get(STOCK), '1', \`stock after reserving 2 of 3 is \${JSON.stringify(ctx.redis.get(STOCK))}, expected 1\`);
  assert(await m.reserve(SKU, 'o1', 2), 'a retried order whose hold exists must return true');
  assert.equal(ctx.redis.get(STOCK), '1', \`the retry decremented stock again: \${JSON.stringify(ctx.redis.get(STOCK))}, expected still 1\`);
  assert.equal(ctx.redis.zcard('holds'), 1, \`holds has \${ctx.redis.zcard('holds')} members after a retry, expected 1\`);
  assert.equal(ctx.redis.get('hold:o1'), 'o1:shoe-42:2', 'the retry must leave the existing hold in place');
}

export async function check_check_then_decrement(ctx) {
  const m = reservations(ctx, 3);
  assert(await m.reserve(SKU, 'o1', 2), '3 in stock must cover an order of 2: expected true');
  assert.equal(ctx.redis.get(STOCK), '1', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after reserving 2 of 3, expected 1\`);
  assert(!(await m.reserve(SKU, 'o2', 2)), '1 left cannot cover an order of 2: expected false (sold out)');
  assert.equal(ctx.redis.get(STOCK), '1', \`a refused reservation changed stock to \${JSON.stringify(ctx.redis.get(STOCK))}; it must stay 1\`);
  assert.equal(ctx.redis.exists('hold:o2'), 0, 'a refused reservation must not write hold:o2');
  assert(await m.reserve(SKU, 'o3', 1), '1 left must cover an order of 1');
  assert.equal(ctx.redis.get(STOCK), '0', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))}, expected 0\`);
  assert(!(await m.reserve(SKU, 'o4', 1)), 'stock 0 must refuse every further order; the counter may never go negative');
  assert.equal(ctx.redis.get(STOCK), '0', \`stock went to \${JSON.stringify(ctx.redis.get(STOCK))}: the script must not decrement below zero\`);
  assert(!(await m.reserve('never-stocked', 'o5', 1)), 'a missing stock key counts as 0: expected false');
}

export async function check_hold_ttl(ctx) {
  const m = reservations(ctx, 5);
  assert(await m.reserve(SKU, 'o1', 2), '5 in stock must cover an order of 2');
  assert.equal(ctx.redis.get('hold:o1'), 'o1:shoe-42:2', \`hold:o1 is \${JSON.stringify(ctx.redis.get('hold:o1'))}, expected the member o1:shoe-42:2\`);
  const ttl = ctx.redis.ttl('hold:o1');
  assert(ttl > 0, 'hold:o1 has no TTL: a crashed sweeper would leave it forever');
  assert(1190 <= ttl && ttl <= 1200, \`hold:o1 TTL is \${ttl} s, expected 2 x HOLD_TTL_S = 1200 s\`);
  ctx.clock.advance(1201);
  assert.equal(ctx.redis.get('hold:o1'), null, 'hold:o1 must be gone once its TTL has passed');
}

export async function check_expiry_index(ctx) {
  const m = reservations(ctx, 5);
  const before = Math.floor(ctx.clock.now() / 1000);
  assert(await m.reserve(SKU, 'o1', 2), '5 in stock must cover an order of 2');
  const raw = ctx.redis.zscore('holds', 'o1:shoe-42:2');
  assert(raw !== null, \`holds contains \${JSON.stringify(ctx.redis.zrange('holds', 0, -1))}, expected the member o1:shoe-42:2\`);
  const score = Number(raw);
  assert(before + 599 <= score && score <= ctx.clock.now() / 1000 + 601, \`the member's score is \${score}, expected now + 600 s (\${before + 600})\`);
  assert(!(await m.reserve(SKU, 'o2', 9)), '9 of 3 left must be refused');
  assert.equal(ctx.redis.zcard('holds'), 1, 'a refused reservation must not be indexed in holds');
}

export async function check_script_once(ctx) {
  const m = reservations(ctx, 5);
  for (let i = 0; i < 3; i++) assert(await m.reserve(SKU, \`o\${i}\`, 1), \`order o\${i} must be reserved\`);
  assert.equal(ctx.redis.get(STOCK), '2', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after three reservations of 1, expected 2\`);
  // Another API replica takes the last unit right after the first command that touches stock:
  // inside one script nothing can land there; a client-side GET then DECRBY goes negative.
  ctx.redis.set(STOCK, 1);
  ctx.redisAfter(STOCK, () => ctx.redis.set(STOCK, 0));
  await m.reserve(SKU, 'o9', 1);
  const stock = Number(ctx.redis.get(STOCK));
  assert(stock >= 0, \`stock is \${stock} after another worker took the last unit between your read and your decrement: the check and the DECRBY must run inside one script\`);
  assert.equal(ctx.redis.zcard('holds'), ctx.redis.keys('hold:*').length, \`holds has \${ctx.redis.zcard('holds')} members for \${ctx.redis.keys('hold:*').length} hold keys: the hold and its index must be written together\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strconv"

	"leetbuild/harness"
)

const (
	shoeSKU   = "shoe-42"
	shoeStock = "stock:shoe-42"
)

// stockUp puts stock units of shoe-42 on sale.
func stockUp(ctx *harness.Ctx, stock int) { ctx.Redis.Set(shoeStock, stock) }

// reserved is reserve(sku, orderID, qty); an error fails the check.
func reserved(ctx *harness.Ctx, sku, orderID string, qty int) bool {
	ok, err := reserve(context.Background(), sku, orderID, qty)
	ctx.NoError(err, "reserve(%q, %q, %d) returned an error", sku, orderID, qty)
	return ok
}

// valueAt is the string at key, nil when it does not exist.
func valueAt(ctx *harness.Ctx, key string) any {
	if v, ok := ctx.Redis.Get(key); ok {
		return v
	}
	return nil
}

func CheckIdempotentRetry(ctx *harness.Ctx) {
	stockUp(ctx, 3)
	ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "3 in stock must cover an order of 2: expected true")
	ctx.Equal(valueAt(ctx, shoeStock), "1", "stock after reserving 2 of 3")
	ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "a retried order whose hold exists must return true")
	ctx.Equal(valueAt(ctx, shoeStock), "1", "the retry must not decrement stock again")
	ctx.Equal(ctx.Redis.ZCard("holds"), 1, "members of holds after a retry")
	ctx.Equal(valueAt(ctx, "hold:o1"), "o1:shoe-42:2", "the retry must leave the existing hold in place")
}

func CheckCheckThenDecrement(ctx *harness.Ctx) {
	stockUp(ctx, 3)
	ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "3 in stock must cover an order of 2: expected true")
	ctx.Equal(valueAt(ctx, shoeStock), "1", "stock after reserving 2 of 3")
	ctx.Assert(!reserved(ctx, shoeSKU, "o2", 2), "1 left cannot cover an order of 2: expected false (sold out)")
	ctx.Equal(valueAt(ctx, shoeStock), "1", "a refused reservation must leave stock at 1")
	ctx.Equal(ctx.Redis.Exists("hold:o2"), 0, "a refused reservation must not write hold:o2")
	ctx.Assert(reserved(ctx, shoeSKU, "o3", 1), "1 left must cover an order of 1")
	ctx.Equal(valueAt(ctx, shoeStock), "0", "stock after the last unit is reserved")
	ctx.Assert(!reserved(ctx, shoeSKU, "o4", 1), "stock 0 must refuse every further order; the counter may never go negative")
	ctx.Equal(valueAt(ctx, shoeStock), "0", "the script must not decrement stock below zero")
	ctx.Assert(!reserved(ctx, "never-stocked", "o5", 1), "a missing stock key counts as 0: expected false")
}

func CheckHoldTtl(ctx *harness.Ctx) {
	stockUp(ctx, 5)
	ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "5 in stock must cover an order of 2")
	ctx.Equal(valueAt(ctx, "hold:o1"), "o1:shoe-42:2", "hold:o1 must hold the member")
	ttl := ctx.Redis.TTL("hold:o1")
	ctx.Assert(ttl > 0, "hold:o1 has no TTL: a crashed sweeper would leave it forever")
	ctx.Assert(1190 <= ttl && ttl <= 1200, "hold:o1 TTL is %d s, expected 2 x holdTTL = 1200 s", ttl)
	ctx.Clock.Advance(1201)
	ctx.Equal(valueAt(ctx, "hold:o1"), nil, "hold:o1 must be gone once its TTL has passed")
}

func CheckExpiryIndex(ctx *harness.Ctx) {
	stockUp(ctx, 5)
	before := ctx.Clock.Now() / 1000
	ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "5 in stock must cover an order of 2")
	score, ok := ctx.Redis.ZScore("holds", "o1:shoe-42:2")
	ctx.Assert(ok, "holds contains %q, expected the member o1:shoe-42:2", ctx.Redis.Do("ZRANGE", "holds", 0, -1))
	ctx.Assert(float64(before+599) <= score && score <= float64(ctx.Clock.Now())/1000+601, "the member's score is %v, expected now + 600 s (%d)", score, before+600)
	ctx.Assert(!reserved(ctx, shoeSKU, "o2", 9), "9 of 3 left must be refused")
	ctx.Equal(ctx.Redis.ZCard("holds"), 1, "a refused reservation must not be indexed in holds")
}

func CheckScriptOnce(ctx *harness.Ctx) {
	stockUp(ctx, 5)
	for i := range 3 {
		ctx.Assert(reserved(ctx, shoeSKU, fmt.Sprintf("o%d", i), 1), "order o%d must be reserved", i)
	}
	ctx.Equal(valueAt(ctx, shoeStock), "2", "stock after three reservations of 1")
	// Another API replica takes the last unit right after the first command that touches stock:
	// inside one script nothing can land there; a client-side Get then DecrBy goes negative.
	stockUp(ctx, 1)
	ctx.Redis.After(shoeStock, func() any { return ctx.Redis.Set(shoeStock, 0) })
	reserved(ctx, shoeSKU, "o9", 1)
	got, _ := ctx.Redis.Get(shoeStock)
	stock, _ := strconv.Atoi(got)
	ctx.Assert(stock >= 0, "stock is %d after another worker took the last unit between your read and your decrement: the check and the DECRBY must run inside one script", stock)
	holds, keys := ctx.Redis.ZCard("holds"), len(ctx.Redis.Keys("hold:*"))
	ctx.Assert(holds == int64(keys), "holds has %d members for %d hold keys: the hold and its index must be written together", holds, keys)
}
`,
    cpp: `#include <leetbuild/harness.h>

namespace {

const std::string shoeSKU = "shoe-42";
const std::string shoeStock = "stock:shoe-42";

// stockUp puts stock units of shoe-42 on sale.
void stockUp(harness::Ctx& ctx, int stock) { ctx.Redis.Set(shoeStock, stock); }

// reserved is reserve(sku, orderID, qty); an exception fails the check.
bool reserved(harness::Ctx& ctx, const std::string& sku, const std::string& orderID, int qty) {
  try {
    return reserve(sku, orderID, qty);
  } catch (const std::exception& e) {
    ctx.Fatalf("reserve(%q, %q, %d) returned an error: %v", sku, orderID, qty, std::string(e.what()));
  }
}

// valueAt is the string at key, nil when it does not exist.
std::optional<std::string> valueAt(harness::Ctx& ctx, const std::string& key) { return ctx.Redis.Get(key); }

}  // namespace

void CheckIdempotentRetry(harness::Ctx& ctx) {
  stockUp(ctx, 3);
  ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "3 in stock must cover an order of 2: expected true");
  ctx.Equal(valueAt(ctx, shoeStock), "1", "stock after reserving 2 of 3");
  ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "a retried order whose hold exists must return true");
  ctx.Equal(valueAt(ctx, shoeStock), "1", "the retry must not decrement stock again");
  ctx.Equal(ctx.Redis.ZCard("holds"), 1, "members of holds after a retry");
  ctx.Equal(valueAt(ctx, "hold:o1"), "o1:shoe-42:2", "the retry must leave the existing hold in place");
}

void CheckCheckThenDecrement(harness::Ctx& ctx) {
  stockUp(ctx, 3);
  ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "3 in stock must cover an order of 2: expected true");
  ctx.Equal(valueAt(ctx, shoeStock), "1", "stock after reserving 2 of 3");
  ctx.Assert(!reserved(ctx, shoeSKU, "o2", 2), "1 left cannot cover an order of 2: expected false (sold out)");
  ctx.Equal(valueAt(ctx, shoeStock), "1", "a refused reservation must leave stock at 1");
  ctx.Equal(ctx.Redis.Exists("hold:o2"), 0, "a refused reservation must not write hold:o2");
  ctx.Assert(reserved(ctx, shoeSKU, "o3", 1), "1 left must cover an order of 1");
  ctx.Equal(valueAt(ctx, shoeStock), "0", "stock after the last unit is reserved");
  ctx.Assert(!reserved(ctx, shoeSKU, "o4", 1), "stock 0 must refuse every further order; the counter may never go negative");
  ctx.Equal(valueAt(ctx, shoeStock), "0", "the script must not decrement stock below zero");
  ctx.Assert(!reserved(ctx, "never-stocked", "o5", 1), "a missing stock key counts as 0: expected false");
}

void CheckHoldTtl(harness::Ctx& ctx) {
  stockUp(ctx, 5);
  ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "5 in stock must cover an order of 2");
  ctx.Equal(valueAt(ctx, "hold:o1"), "o1:shoe-42:2", "hold:o1 must hold the member");
  const long long ttl = ctx.Redis.TTL("hold:o1");
  ctx.Assert(ttl > 0, "hold:o1 has no TTL: a crashed sweeper would leave it forever");
  ctx.Assert(1190 <= ttl && ttl <= 1200, "hold:o1 TTL is %d s, expected 2 x kHoldTtl = 1200 s", ttl);
  ctx.Clock.Advance(1201);
  ctx.Equal(valueAt(ctx, "hold:o1"), nullptr, "hold:o1 must be gone once its TTL has passed");
}

void CheckExpiryIndex(harness::Ctx& ctx) {
  stockUp(ctx, 5);
  const int64_t before = ctx.Clock.Now() / 1000;
  ctx.Assert(reserved(ctx, shoeSKU, "o1", 2), "5 in stock must cover an order of 2");
  const auto score = ctx.Redis.ZScore("holds", "o1:shoe-42:2");
  ctx.Assert(score.has_value(), "holds contains %q, expected the member o1:shoe-42:2", ctx.Redis.Do("ZRANGE", "holds", 0, -1).Strings());
  ctx.Assert(static_cast<double>(before + 599) <= *score && *score <= static_cast<double>(ctx.Clock.Now()) / 1000 + 601,
             "the member's score is %v, expected now + 600 s (%d)", *score, before + 600);
  ctx.Assert(!reserved(ctx, shoeSKU, "o2", 9), "9 of 3 left must be refused");
  ctx.Equal(ctx.Redis.ZCard("holds"), 1, "a refused reservation must not be indexed in holds");
}

void CheckScriptOnce(harness::Ctx& ctx) {
  stockUp(ctx, 5);
  for (int i = 0; i < 3; i++) {
    ctx.Assert(reserved(ctx, shoeSKU, "o" + std::to_string(i), 1), "order o%d must be reserved", i);
  }
  ctx.Equal(valueAt(ctx, shoeStock), "2", "stock after three reservations of 1");
  // Another API replica takes the last unit right after the first command that touches stock:
  // inside one script nothing can land there; a client-side GET then DECRBY goes negative.
  stockUp(ctx, 1);
  ctx.Redis.After(shoeStock, [&] { ctx.Redis.Set(shoeStock, 0); });
  reserved(ctx, shoeSKU, "o9", 1);
  const int stock = std::atoi(ctx.Redis.Get(shoeStock).value_or("").c_str());
  ctx.Assert(stock >= 0, "stock is %d after another worker took the last unit between your read and your decrement: the check and the DECRBY must run inside one script", stock);
  const long long holds = ctx.Redis.ZCard("holds");
  const size_t keys = ctx.Redis.Keys("hold:*").size();
  ctx.Assert(holds == static_cast<long long>(keys), "holds has %d members for %d hold keys: the hold and its index must be written together", holds, keys);
}
`,
  },
  debrief: `The whole reservation is one round trip and one atomic unit: check, decrement, hold and expiry entry either all happen or none do, and the \`EXISTS\` guard makes a retry harmless. Real systems shard hot SKUs across several counters to spread one key's write load, cache the script SHA client-side with a \`NOSCRIPT\` fallback, and back the Redis counter with the allocation the warehouse makes in step 4 — Redis says "probably yours", the ledger says "yours".`,
};
