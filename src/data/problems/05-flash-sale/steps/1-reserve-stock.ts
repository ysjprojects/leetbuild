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
  debrief: `The whole reservation is one round trip and one atomic unit: check, decrement, hold and expiry entry either all happen or none do, and the \`EXISTS\` guard makes a retry harmless. Real systems shard hot SKUs across several counters to spread one key's write load, cache the script SHA client-side with a \`NOSCRIPT\` fallback, and back the Redis counter with the allocation the warehouse makes in step 4 — Redis says "probably yours", the ledger says "yours".`,
};
