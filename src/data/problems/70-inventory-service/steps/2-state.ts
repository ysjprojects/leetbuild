import type {Step} from '@/lib/types';

const LUA_GET_STOCK = /redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[1\]/;
const LUA_INSUFFICIENT = /return\s+-2/;
const LUA_UNKNOWN = /return\s+-1/;
const LUA_DECRBY = /redis\.call\(\s*['"]DECRBY['"]\s*,\s*KEYS\[1\]/;
const LUA_SET_HOLD = /redis\.call\(\s*['"]SET['"]\s*,\s*KEYS\[2\]\s*,\s*ARGV\[2\]\s*,\s*['"]EX['"]\s*,\s*ttl\s*\)/;

export const stateStep: Step = {
  id: 'state',
  title: 'Redis atomic decrement with a floor at zero',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the \`StockCounter\` module every reserve call goes through: it
reads \`stock:{sku}\` with \`get\`, compares the quantity in the handler, runs \`decrby\`, and mirrors the
hold with its own hardcoded TTL. It compiles, serves the demo and hides five flaws.

**Failure mode the checks target.** \`get\`, compare, \`decrby\` passes every serial test and
oversells the first time two buyers press *Buy* in the same second: both read \`1\`, both write \`0\`.
The 3600-second hold outlives the 900-second reservation by 45 minutes.

- **The check and the decrement are one atomic unit.** The whole transition runs as **one Lua
  script**, registered once with the client
  (\`register_script\` / \`defineCommand\` / \`NewScript\` / \`scriptLoad\` / \`script_load\`). The script
  reads the counter and decides; the handler only builds keys and arguments.
- **The floor lives inside the script.** A missing key returns \`-1\` (unknown sku). When the counter
  holds fewer units than requested the script returns \`-2\` and touches nothing; the \`DECRBY\` runs
  only after that guard, so the counter cannot go negative.
- **The hold mirrors the reservation's TTL exactly.** The script writes
  \`SET hold:{reservation_id} <sku:quantity> EX <ttl>\` in the same call, with the TTL passed in as
  the reservation's own \`RESERVATION_TTL_S = 900\`.
- **\`reserve(sku, quantity, reservation_id, ttl_s)\` returns an outcome**, not a boolean:
  \`RESERVED\` (with the new count, possibly \`0\`), \`INSUFFICIENT_STOCK\` (a **409** the caller must
  not retry blindly) or \`UNKNOWN_SKU\`.
- **Two racing callers against the last unit get one \`RESERVED\` and one \`INSUFFICIENT_STOCK\`.**`,
  sequence: {
    participants: ['Reserve handler', 'StockCounter', 'Redis'],
    messages: [
      {
        from: 'Reserve handler',
        to: 'StockCounter',
        label: 'reserve(sku, quantity, reservation_id, ttl_s)',
        kind: 'sync',
      },
      {
        from: 'StockCounter',
        to: 'Redis',
        label: 'EVALSHA DECREMENT_SCRIPT · KEYS[stock:{sku}, hold:{reservation_id}]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'GET stock · DECRBY only after the floor check', kind: 'sync'},
      {from: 'Redis', to: 'StockCounter', label: 'new available | -1 unknown sku | -2 insufficient', kind: 'reply'},
      {
        from: 'StockCounter',
        to: 'Reserve handler',
        label: 'RESERVED | UNKNOWN_SKU | INSUFFICIENT_STOCK → 409',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Symptom: the morning after a flash sale, `stock:{sku}` reads `-3` and a unit a buyer released at minute 15 stays locked for another 45 minutes.',
    'Mechanism: the handler reads the counter, compares, and only then decrements, so two callers interleave between the read and the write; the hold is written with its own 3600 instead of the reservation TTL.',
    'Change: move the read, the floor check and the `DECRBY` into one registered Lua script that returns `-1`/`-2`/new count, write the hold with `SET ... EX ttl_s` inside it, and map the result to an outcome.',
  ],
  checks: [
    {
      id: 'lua-decrement',
      title: 'One registered script reads the counter and decrements it',
      detail:
        'The floor check and the `DECRBY` are in one Lua script registered once with the client (`register_script` / `defineCommand` / `NewScript` / `scriptLoad` / `script_load`), so every call is one atomic step.',
      match: {
        python: {
          all: [/\bDECREMENT_SCRIPT\b/, /register_script\(\s*DECREMENT_SCRIPT\s*\)/, LUA_DECRBY],
        },
        typescript: {
          all: [
            /DECREMENT_SCRIPT/,
            /defineCommand\(\s*['"]reserveStock['"]\s*,\s*\{[^}]*lua:\s*DECREMENT_SCRIPT/,
            LUA_DECRBY,
          ],
        },
        go: {all: [/decrementLua/, /redis\.NewScript\(\s*decrementLua\s*\)/, LUA_DECRBY]},
        scala: {all: [/DecrementScript/, /scriptLoad\(\s*DecrementScript\s*\)/, LUA_DECRBY]},
        cpp: {all: [/kDecrementScript/, /script_load\(\s*kDecrementScript\s*\)/, LUA_DECRBY]},
      },
    },
    {
      id: 'floor',
      title: 'Refuses below zero inside the script',
      detail:
        'The script reads `stock:{sku}`, returns `-1` for a missing key and `-2` when the requested quantity is not there, and only then runs the `DECRBY`.',
      match: {
        python: {order: [LUA_GET_STOCK, LUA_UNKNOWN, LUA_INSUFFICIENT, LUA_DECRBY]},
        typescript: {order: [LUA_GET_STOCK, LUA_UNKNOWN, LUA_INSUFFICIENT, LUA_DECRBY]},
        go: {order: [LUA_GET_STOCK, LUA_UNKNOWN, LUA_INSUFFICIENT, LUA_DECRBY]},
        scala: {order: [LUA_GET_STOCK, LUA_UNKNOWN, LUA_INSUFFICIENT, LUA_DECRBY]},
        cpp: {order: [LUA_GET_STOCK, LUA_UNKNOWN, LUA_INSUFFICIENT, LUA_DECRBY]},
      },
    },
    {
      id: 'atomic',
      title: 'No read-then-decrement in the host path',
      detail:
        'The handler calls the script and reads its sentinel; there is no client-side `GET` followed by a comparison followed by a separate `DECRBY`. A bare `available >= quantity` guard in the handler is exactly the race the script removes.',
      match: {
        python: {
          all: [/register_script\(\s*DECREMENT_SCRIPT\s*\)/, /\bdecrement_script\(/],
          none: [/\bavailable\s*>=\s*quantity\b/, /\br\.get\(\s*(f?["']stock:|stock_key\()/, /\br\.decrby\(/],
        },
        typescript: {
          all: [/defineCommand\(\s*['"]reserveStock['"]/, /\.reserveStock\(/],
          none: [/\bavailable\s*>=\s*quantity\b/, /redis\.get\(\s*(stockKey\(|`stock:)/, /\.decrby\(/],
        },
        go: {
          all: [/redis\.NewScript\(\s*decrementLua\s*\)/, /decrementScript\.Run\(/],
          none: [/\bavailable\s*>=\s*quantity\b/, /rdb\.Get\(\s*ctx\s*,\s*(stockKey\(|"stock:)/, /rdb\.DecrBy\(/],
        },
        scala: {
          all: [/scriptLoad\(\s*DecrementScript\s*\)/, /jedis\.evalsha\(/],
          none: [/\bavailable\s*>=\s*quantity\b/, /jedis\.get\(\s*(stockKey\(|s"stock:)/, /jedis\.decrBy\(/],
        },
        cpp: {
          all: [/script_load\(\s*kDecrementScript\s*\)/, /redis\.evalsha</],
          none: [/\bavailable\s*>=\s*quantity\b/, /redis\.get\(\s*(stockKey\(|"stock:)/, /\.decrby\(/],
        },
      },
    },
    {
      id: 'concurrent-last-unit',
      title: 'Two racers against the last unit: one winner',
      detail:
        'The script result is mapped to an outcome enum: one racing caller gets `RESERVED`, the other `INSUFFICIENT_STOCK`, which the API maps to a **409** conflict the caller must not retry blindly.',
      match: {
        python: {
          all: [/RESERVED/, /INSUFFICIENT_STOCK/, /UNKNOWN_SKU/, /\b409\b/],
          none: [/\br\.get\(/, /\br\.decrby\(/, /\bavailable\s*>=\s*quantity\b/],
        },
        typescript: {
          all: [/RESERVED/, /INSUFFICIENT_STOCK/, /UNKNOWN_SKU/, /\b409\b/],
          none: [/redis\.get\(/, /\.decrby\(/, /\bavailable\s*>=\s*quantity\b/],
        },
        go: {
          all: [/Reserved\b/, /InsufficientStock/, /UnknownSKU/, /\b409\b/],
          none: [/rdb\.Get\(/, /rdb\.DecrBy\(/, /\bavailable\s*>=\s*quantity\b/],
        },
        scala: {
          all: [/Reserved\b/, /InsufficientStock/, /UnknownSku/, /\b409\b/],
          none: [/jedis\.get\(/, /jedis\.decrBy\(/, /\bavailable\s*>=\s*quantity\b/],
        },
        cpp: {
          all: [/Reserved/, /InsufficientStock/, /UnknownSku/, /\b409\b/],
          none: [/redis\.get\(/, /\.decrby\(/, /\bavailable\s*>=\s*quantity\b/],
        },
      },
    },
    {
      id: 'hold-ttl',
      title: "Mirrors the reservation's TTL on the hold key",
      detail:
        "The hold is written in the same script with `SET hold:{reservation_id} <sku:quantity> EX ttl`, and the TTL is the reservation's own `RESERVATION_TTL_S = 900`, passed in as `ttl_s` / `ttlS`.",
      match: {
        python: {
          all: [/RESERVATION_TTL_S\s*=\s*900/, LUA_SET_HOLD, /ttl_s/],
          none: [/3600/],
        },
        typescript: {
          all: [/RESERVATION_TTL_S\s*=\s*900/, LUA_SET_HOLD, /ttlS/],
          none: [/3600/],
        },
        go: {all: [/reservationTTLS\s*=\s*900/, LUA_SET_HOLD, /ttlS/], none: [/3600/]},
        scala: {all: [/ReservationTtlS\s*=\s*900/, LUA_SET_HOLD, /ttlS/], none: [/3600/]},
        cpp: {all: [/kReservationTtlS\s*=\s*900/, LUA_SET_HOLD, /ttl_s/], none: [/3600/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The reservation expires after 900 seconds.
HOLD_TTL_S = 3600


def stock_key(sku: str) -> str:
    return f"stock:{sku}"


def hold_key(reservation_id: str) -> str:
    return f"hold:{reservation_id}"


class StockCounter:
    def reserve(self, sku: str, quantity: int, reservation_id: str) -> str:
        """Takes quantity units of sku and mirrors the hold for the reservation."""
        # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
        available = r.get(stock_key(sku))
        if available is None:
            return "unknown_sku"
        if int(available) >= quantity:
            r.decrby(stock_key(sku), quantity)
            r.set(hold_key(reservation_id), f"{sku}:{quantity}", ex=HOLD_TTL_S)
            return "reserved"
        return "insufficient_stock"
`,
      solution: `from enum import Enum

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RESERVATION_TTL_S = 900  # the reservation window the hold must mirror exactly

# KEYS[1] = stock:{sku}   KEYS[2] = hold:{reservation_id}
# ARGV[1] = quantity      ARGV[2] = "{sku}:{quantity}"      ARGV[3] = ttl_s
DECREMENT_SCRIPT = """
local stock = redis.call('GET', KEYS[1])
if stock == false then
  return -1
end
local quantity = tonumber(ARGV[1])
if tonumber(stock) < quantity then
  return -2
end
local remaining = redis.call('DECRBY', KEYS[1], quantity)
local ttl = tonumber(ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
return remaining
"""


class ReservationOutcome(str, Enum):
    RESERVED = "reserved"
    INSUFFICIENT_STOCK = "insufficient_stock"
    UNKNOWN_SKU = "unknown_sku"


# The API layer turns the outcome into a status: a conflict is a 409 and must not be retried blindly.
OUTCOME_HTTP_STATUS = {
    ReservationOutcome.RESERVED: 200,
    ReservationOutcome.INSUFFICIENT_STOCK: 409,
    ReservationOutcome.UNKNOWN_SKU: 404,
}

decrement_script = r.register_script(DECREMENT_SCRIPT)


def stock_key(sku: str) -> str:
    return f"stock:{sku}"


def hold_key(reservation_id: str) -> str:
    return f"hold:{reservation_id}"


class StockCounter:
    def reserve(
        self,
        sku: str,
        quantity: int,
        reservation_id: str,
        ttl_s: int = RESERVATION_TTL_S,
    ) -> ReservationOutcome:
        """One atomic transition: the floor check, the decrement and the hold, or nothing."""
        result = int(
            decrement_script(
                keys=[stock_key(sku), hold_key(reservation_id)],
                args=[quantity, f"{sku}:{quantity}", ttl_s],
            )
        )
        if result == -1:
            return ReservationOutcome.UNKNOWN_SKU
        if result == -2:
            return ReservationOutcome.INSUFFICIENT_STOCK
        return ReservationOutcome.RESERVED
`,
    },
    typescript: {
      starter: `/** The reservation counter. */
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

// The reservation expires after 900 seconds.
export const HOLD_TTL_S = 3600;

export function stockKey(sku: string): string {
  return \`stock:\${sku}\`;
}

export function holdKey(reservationId: string): string {
  return \`hold:\${reservationId}\`;
}

export class StockCounter {
  async reserve(sku: string, quantity: number, reservationId: string): Promise<string> {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const raw = await redis.get(stockKey(sku));
    if (raw === null) return 'unknown_sku';
    const available = Number(raw);
    if (available >= quantity) {
      await redis.decrby(stockKey(sku), quantity);
      await redis.set(holdKey(reservationId), \`\${sku}:\${quantity}\`, 'EX', HOLD_TTL_S);
      return 'reserved';
    }
    return 'insufficient_stock';
  }
}
`,
      solution: `/** The reservation counter: one atomic Lua transition with the floor inside the script. */
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

export const RESERVATION_TTL_S = 900; // the reservation window the hold must mirror exactly

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{reservation_id}
// ARGV[1] = quantity      ARGV[2] = "{sku}:{quantity}"      ARGV[3] = ttl_s
export const DECREMENT_SCRIPT = \`
local stock = redis.call('GET', KEYS[1])
if stock == false then
  return -1
end
local quantity = tonumber(ARGV[1])
if tonumber(stock) < quantity then
  return -2
end
local remaining = redis.call('DECRBY', KEYS[1], quantity)
local ttl = tonumber(ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
return remaining
\`;

export enum ReservationOutcome {
  RESERVED = 'reserved',
  INSUFFICIENT_STOCK = 'insufficient_stock',
  UNKNOWN_SKU = 'unknown_sku',
}

// The API layer turns the outcome into a status: a conflict is a 409 and must not be retried blindly.
export const OUTCOME_HTTP_STATUS: Record<ReservationOutcome, number> = {
  [ReservationOutcome.RESERVED]: 200,
  [ReservationOutcome.INSUFFICIENT_STOCK]: 409,
  [ReservationOutcome.UNKNOWN_SKU]: 404,
};

interface StockRedis extends Redis {
  reserveStock(stockKey: string, holdKey: string, quantity: number, hold: string, ttlS: number): Promise<number>;
}

redis.defineCommand('reserveStock', {numberOfKeys: 2, lua: DECREMENT_SCRIPT});

const stockRedis = redis as StockRedis;

export function stockKey(sku: string): string {
  return \`stock:\${sku}\`;
}

export function holdKey(reservationId: string): string {
  return \`hold:\${reservationId}\`;
}

export class StockCounter {
  /** One atomic transition: the floor check, the decrement and the hold, or nothing. */
  async reserve(
    sku: string,
    quantity: number,
    reservationId: string,
    ttlS: number = RESERVATION_TTL_S,
  ): Promise<ReservationOutcome> {
    const result = await stockRedis.reserveStock(
      stockKey(sku),
      holdKey(reservationId),
      quantity,
      \`\${sku}:\${quantity}\`,
      ttlS,
    );
    if (result === -1) return ReservationOutcome.UNKNOWN_SKU;
    if (result === -2) return ReservationOutcome.INSUFFICIENT_STOCK;
    return ReservationOutcome.RESERVED;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The reservation expires after 900 seconds.
const holdTTLS = 3600

func stockKey(sku string) string {
	return "stock:" + sku
}

func holdKey(reservationID string) string {
	return "hold:" + reservationID
}

type StockCounter struct{}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func (StockCounter) Reserve(ctx context.Context, sku string, quantity int, reservationID string) (string, error) {
	raw, err := rdb.Get(ctx, stockKey(sku)).Result()
	if errors.Is(err, redis.Nil) {
		return "unknown_sku", nil
	}
	if err != nil {
		return "", err
	}
	available, err := strconv.Atoi(raw)
	if err != nil {
		return "", err
	}
	if available >= quantity {
		if err := rdb.DecrBy(ctx, stockKey(sku), int64(quantity)).Err(); err != nil {
			return "", err
		}
		hold := sku + ":" + strconv.Itoa(quantity)
		if err := rdb.Set(ctx, holdKey(reservationID), hold, time.Duration(holdTTLS)*time.Second).Err(); err != nil {
			return "", err
		}
		return "reserved", nil
	}
	return "insufficient_stock", nil
}
`,
      solution:
        `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const reservationTTLS = 900 // the reservation window the hold must mirror exactly

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{reservation_id}
// ARGV[1] = quantity      ARGV[2] = "{sku}:{quantity}"      ARGV[3] = ttl_s
const decrementLua = ` +
        '`' +
        `
local stock = redis.call('GET', KEYS[1])
if stock == false then
  return -1
end
local quantity = tonumber(ARGV[1])
if tonumber(stock) < quantity then
  return -2
end
local remaining = redis.call('DECRBY', KEYS[1], quantity)
local ttl = tonumber(ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
return remaining
` +
        '`' +
        `

var decrementScript = redis.NewScript(decrementLua)

type ReservationOutcome int

const (
	Reserved ReservationOutcome = iota
	InsufficientStock
	UnknownSKU
)

// The API layer turns the outcome into a status: a conflict is a 409 and must not be retried blindly.
var outcomeHTTPStatus = map[ReservationOutcome]int{
	Reserved:          200,
	InsufficientStock: 409,
	UnknownSKU:        404,
}

func stockKey(sku string) string {
	return "stock:" + sku
}

func holdKey(reservationID string) string {
	return "hold:" + reservationID
}

type StockCounter struct{}

// Reserve is one atomic transition: the floor check, the decrement and the hold, or nothing.
func (StockCounter) Reserve(ctx context.Context, sku string, quantity int, reservationID string, ttlS int) (ReservationOutcome, error) {
	result, err := decrementScript.Run(
		ctx,
		rdb,
		[]string{stockKey(sku), holdKey(reservationID)},
		quantity,
		fmt.Sprintf("%s:%d", sku, quantity),
		ttlS,
	).Int()
	if err != nil {
		return UnknownSKU, err
	}
	switch result {
	case -1:
		return UnknownSKU, nil
	case -2:
		return InsufficientStock, nil
	default:
		return Reserved, nil
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object StockCounter {
  val jedis = new Jedis("redis", 6379)

  // The reservation expires after 900 seconds.
  val HoldTtlS = 3600L

  def stockKey(sku: String): String = s"stock:$sku"

  def holdKey(reservationId: String): String = s"hold:$reservationId"

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def reserve(sku: String, quantity: Long, reservationId: String): String = {
    val raw = jedis.get(stockKey(sku))
    if (raw == null) {
      "unknown_sku"
    } else {
      val available = raw.toLong
      if (available >= quantity) {
        jedis.decrBy(stockKey(sku), quantity)
        jedis.set(holdKey(reservationId), s"$sku:$quantity", "EX", HoldTtlS)
        "reserved"
      } else {
        "insufficient_stock"
      }
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object StockCounter {
  val jedis = new Jedis("redis", 6379)

  val ReservationTtlS = 900L // the reservation window the hold must mirror exactly

  // KEYS[1] = stock:{sku}   KEYS[2] = hold:{reservation_id}
  // ARGV[1] = quantity      ARGV[2] = "{sku}:{quantity}"      ARGV[3] = ttl_s
  val DecrementScript: String =
    """local stock = redis.call('GET', KEYS[1])
      |if stock == false then
      |  return -1
      |end
      |local quantity = tonumber(ARGV[1])
      |if tonumber(stock) < quantity then
      |  return -2
      |end
      |local remaining = redis.call('DECRBY', KEYS[1], quantity)
      |local ttl = tonumber(ARGV[3])
      |redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
      |return remaining
      |""".stripMargin

  sealed trait ReservationOutcome
  object ReservationOutcome {
    case object Reserved extends ReservationOutcome
    case object InsufficientStock extends ReservationOutcome
    case object UnknownSku extends ReservationOutcome
  }

  // The API layer turns the outcome into a status: a conflict is a 409 and must not be retried blindly.
  val OutcomeHttpStatus: Map[ReservationOutcome, Int] = Map(
    ReservationOutcome.Reserved -> 200,
    ReservationOutcome.InsufficientStock -> 409,
    ReservationOutcome.UnknownSku -> 404,
  )

  private val decrementSha = jedis.scriptLoad(DecrementScript)

  def stockKey(sku: String): String = s"stock:$sku"

  def holdKey(reservationId: String): String = s"hold:$reservationId"

  /** One atomic transition: the floor check, the decrement and the hold, or nothing. */
  def reserve(
      sku: String,
      quantity: Long,
      reservationId: String,
      ttlS: Long = ReservationTtlS,
  ): ReservationOutcome = {
    val keys = Seq(stockKey(sku), holdKey(reservationId)).asJava
    val args = Seq(quantity.toString, s"$sku:$quantity", ttlS.toString).asJava
    jedis.evalsha(decrementSha, keys, args).asInstanceOf[java.lang.Long] match {
      case -1L => ReservationOutcome.UnknownSku
      case -2L => ReservationOutcome.InsufficientStock
      case _   => ReservationOutcome.Reserved
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// The reservation expires after 900 seconds.
constexpr int kHoldTtlS = 3600;

std::string stockKey(const std::string& sku) { return "stock:" + sku; }
std::string holdKey(const std::string& reservationId) { return "hold:" + reservationId; }

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
std::string reserve(const std::string& sku, long long quantity, const std::string& reservationId) {
  auto raw = redis.get(stockKey(sku));
  if (!raw) return "unknown_sku";
  const long long available = std::stoll(*raw);
  if (available >= quantity) {
    redis.decrby(stockKey(sku), quantity);
    redis.set(holdKey(reservationId), sku + ":" + std::to_string(quantity), std::chrono::seconds(kHoldTtlS));
    return "reserved";
  }
  return "insufficient_stock";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kReservationTtlS = 900; // the reservation window the hold must mirror exactly

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{reservation_id}
// ARGV[1] = quantity      ARGV[2] = "{sku}:{quantity}"      ARGV[3] = ttl_s
const std::string kDecrementScript = R"lua(
local stock = redis.call('GET', KEYS[1])
if stock == false then
  return -1
end
local quantity = tonumber(ARGV[1])
if tonumber(stock) < quantity then
  return -2
end
local remaining = redis.call('DECRBY', KEYS[1], quantity)
local ttl = tonumber(ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
return remaining
)lua";

const std::string kDecrementSha = redis.script_load(kDecrementScript);

enum class ReservationOutcome { Reserved, InsufficientStock, UnknownSku };

// The API layer turns the outcome into a status: a conflict is a 409 and must not be retried blindly.
const std::map<ReservationOutcome, int> kOutcomeHttpStatus{
    {ReservationOutcome::Reserved, 200},
    {ReservationOutcome::InsufficientStock, 409},
    {ReservationOutcome::UnknownSku, 404},
};

std::string stockKey(const std::string& sku) { return "stock:" + sku; }
std::string holdKey(const std::string& reservationId) { return "hold:" + reservationId; }

// One atomic transition: the floor check, the decrement and the hold, or nothing.
ReservationOutcome reserve(
    const std::string& sku,
    long long quantity,
    const std::string& reservationId,
    long long ttl_s = kReservationTtlS) {
  const std::vector<std::string> keys{stockKey(sku), holdKey(reservationId)};
  const std::vector<std::string> args{
      std::to_string(quantity), sku + ":" + std::to_string(quantity), std::to_string(ttl_s)};
  const auto result = redis.evalsha<long long>(kDecrementSha, keys.begin(), keys.end(), args.begin(), args.end());
  if (result == -1) return ReservationOutcome::UnknownSku;
  if (result == -2) return ReservationOutcome::InsufficientStock;
  return ReservationOutcome::Reserved;
}
`,
    },
  },
  debrief: `The fix has the shape of one script because Redis executes a script with nothing interleaved: the read, the floor comparison and the \`DECRBY\` become a single step, and the loser of a race sees \`-2\` instead of a counter that went negative. Returning an outcome rather than a boolean is what lets the API turn that loss into a 409 the storefront can render as sold out. The TTL half is the subtle one: a hold that outlives its reservation keeps a unit locked for a buyer who is long gone, and nothing in the demo notices because the demo does not wait. Production platforms also shard hot skus across several counters to spread one key's write load, keep the script's SHA client-side with a \`NOSCRIPT\` fallback to \`EVAL\`, and reconcile the Redis counter against the warehouse's allocation of record.`,
};
