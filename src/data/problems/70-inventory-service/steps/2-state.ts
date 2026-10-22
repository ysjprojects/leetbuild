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

**Review premise.** The starter is a plausible model-generated draft of the reservation counter: it
reads the available stock, compares the quantity in the handler, decrements, and mirrors the hold, so
the demo sells the last unit to one buyer at a time. Under a flash sale both buyers read the same
number. Review the draft as the owner of the inventory service, fix it, and prove the fix with the
checks below.

Implement the Redis side of the reservation — the \`StockCounter\` module every reserve call goes
through. No route belongs here; the handler in step 1 calls it.

- **The check and the decrement are one atomic unit.** Available stock lives at \`stock:{sku}\` and the
  whole transition runs as **one Lua script**, registered once with the client
  (\`register_script\` / \`defineCommand\` / \`NewScript\` / \`scriptLoad\` / \`script_load\`). The script
  reads the counter, and it — not the handler — decides. A \`get\` in the handler followed by a
  \`decrby\` after it is three round trips with a race in the middle: both buyers read \`1\`, both
  compare \`1 >= 1\`, both write \`0\`, and the unit is sold twice.
- **The floor lives inside the script.** A missing key returns \`-1\` (unknown sku). When the counter
  holds fewer units than requested the script returns \`-2\` and touches nothing; the \`DECRBY\` runs
  only after that guard. The counter can never go negative, because the comparison and the write
  cannot be interleaved.
- **The hold mirrors the reservation's TTL exactly.** The script writes
  \`SET hold:{reservation_id} <sku:quantity> EX <ttl>\` in the same atomic call, where the TTL is the
  reservation's expiry — \`RESERVATION_TTL_S = 900\` seconds. A hold written with a different duration
  (the draft hardcodes \`3600\`) keeps stock reserved past the reservation's own expiry, so a unit the
  buyer released never returns to the free set.
- **\`reserve(sku, quantity, reservation_id, ttl_s)\` returns the outcome**, not a boolean:
  \`RESERVED\`, \`INSUFFICIENT_STOCK\` or \`UNKNOWN_SKU\`. \`INSUFFICIENT_STOCK\` is a **409** conflict —
  the storefront shows "sold out" and the caller must not retry blindly. The winning caller gets the
  new available count back, which may be \`0\`.
- **Two racing callers against the last unit get one \`RESERVED\` and one \`INSUFFICIENT_STOCK\`**,
  because only one of them can be the script that passes the floor check and decrements. There is no
  read-modify-write anywhere in the path.

**Failure mode the checks target.** The draft's \`get\` → compare → \`decrby\` is the oversell the whole
course is about: it is correct in every serial test and wrong the first time two buyers press *Buy* in
the same second. The 3600-second hold is the quiet one — the reservation expires after 900 seconds and
the hold outlives it by 45 minutes.`,
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
    'Anything you can only check and then write is a race. The read, the comparison and the `DECRBY` have to happen in one script, because that is the only place Redis runs them with nothing in between; the handler only builds the keys and the arguments and reads the integer that comes back.',
    'Lua sees Redis values as strings, so compare `tonumber(stock)` with `tonumber(ARGV[1])`. A missing key comes back as `false`, which is the `-1` unknown-sku case; when the comparison fails return `-2` before touching the counter, so a refusal cannot decrement anything.',
    "The hold must expire exactly when the reservation does. Pass the reservation's TTL into the script as an argument and write the hold with `SET ... EX` in the same call; the draft's hardcoded 3600-second hold outlives the 900-second reservation by 45 minutes.",
  ],
  checks: [
    {
      id: 'lua-decrement',
      title: 'One registered script reads the counter and decrements it',
      detail:
        'The floor check and the `DECRBY` are in one Lua script registered once with the client (`register_script` / `defineCommand` / `NewScript` / `scriptLoad` / `script_load`), so every call is one atomic step. The draft has no script at all: it reads, compares and writes as three separate client calls.',
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
        'The script reads `stock:{sku}`, returns `-1` for a missing key and `-2` when the requested quantity is not there, and only then runs the `DECRBY`. The draft compares in the handler and decrements unconditionally, so the counter can go negative.',
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
        'The handler calls the script and reads its sentinel; there is no client-side `GET` followed by a comparison followed by a separate `DECRBY`. A bare `available >= quantity` guard in the handler is exactly the race the script removes — the draft has it, and the losing buyer then decrements anyway.',
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
        'The script result is mapped to an outcome enum — one racing caller gets `RESERVED`, the other `INSUFFICIENT_STOCK`, which the API maps to a **409** conflict the caller must not retry blindly. The draft returns a boolean from a read-modify-write, so both racers pass the check.',
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
        "The hold is written in the same script with `SET hold:{reservation_id} <sku:quantity> EX ttl`, and the TTL is the reservation's own `RESERVATION_TTL_S = 900`, passed in as `ttl_s` / `ttlS`. The draft hardcodes a different duration (`3600`), so the hold outlives the reservation it mirrors.",
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

# The reservation expires after 900 seconds; the draft mirrors the hold with its own longer window.
HOLD_TTL_S = 3600


def stock_key(sku: str) -> str:
    return f"stock:{sku}"


def hold_key(reservation_id: str) -> str:
    return f"hold:{reservation_id}"


class StockCounter:
    def reserve(self, sku: str, quantity: int, reservation_id: str) -> str:
        """Takes quantity units of sku and mirrors the hold for the reservation."""
        # TODO: this draft reads the counter with GET, compares in the handler and only then
        # DECRBYs, so two concurrent buyers both pass the check and the stock goes negative; it
        # mirrors the hold with a hardcoded 3600-second TTL instead of the reservation's 900
        # seconds; and it never runs the check and the decrement as one atomic script. Run the whole
        # transition in one registered Lua script and map its result to an outcome.
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
      starter: `/** The reservation counter: a model-generated draft that reads, checks and then decrements. */
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

// The reservation expires after 900 seconds; the draft mirrors the hold with its own longer window.
export const HOLD_TTL_S = 3600;

export function stockKey(sku: string): string {
  return \`stock:\${sku}\`;
}

export function holdKey(reservationId: string): string {
  return \`hold:\${reservationId}\`;
}

export class StockCounter {
  async reserve(sku: string, quantity: number, reservationId: string): Promise<string> {
    // TODO: this draft reads the counter with GET, compares in the handler and only then DECRBYs,
    // so two concurrent buyers both pass the check and the stock goes negative; it mirrors the hold
    // with a hardcoded 3600-second TTL instead of the reservation's 900 seconds; and it never runs
    // the check and the decrement as one atomic script. Run the whole transition in one registered
    // Lua script and map its result to an outcome.
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

// The reservation expires after 900 seconds; the draft mirrors the hold with its own longer window.
const holdTTLS = 3600

func stockKey(sku string) string {
	return "stock:" + sku
}

func holdKey(reservationID string) string {
	return "hold:" + reservationID
}

type StockCounter struct{}

// TODO: this draft reads the counter with Get, compares in the handler and only then DecrBy's, so
// two concurrent buyers both pass the check and the stock goes negative; it mirrors the hold with a
// hardcoded 3600-second TTL instead of the reservation's 900 seconds; and it never runs the check
// and the decrement as one atomic script. Run the whole transition in one registered Lua script and
// map its result to an outcome.
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

  // The reservation expires after 900 seconds; the draft mirrors the hold with its own longer window.
  val HoldTtlS = 3600L

  def stockKey(sku: String): String = s"stock:$sku"

  def holdKey(reservationId: String): String = s"hold:$reservationId"

  // TODO: this draft reads the counter with get, compares in the handler and only then decrBy's, so
  // two concurrent buyers both pass the check and the stock goes negative; it mirrors the hold with a
  // hardcoded 3600-second TTL instead of the reservation's 900 seconds; and it never runs the check
  // and the decrement as one atomic script. Run the whole transition in one registered Lua script
  // and map its result to an outcome.
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

// The reservation expires after 900 seconds; the draft mirrors the hold with its own longer window.
constexpr int kHoldTtlS = 3600;

std::string stockKey(const std::string& sku) { return "stock:" + sku; }
std::string holdKey(const std::string& reservationId) { return "hold:" + reservationId; }

// TODO: this draft reads the counter with get, compares in the handler and only then decrby's, so
// two concurrent buyers both pass the check and the stock goes negative; it mirrors the hold with a
// hardcoded 3600-second TTL instead of the reservation's 900 seconds; and it never runs the check
// and the decrement as one atomic script. Run the whole transition in one registered Lua script and
// map its result to an outcome.
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
  debrief: `The interviewer is testing the one property that makes an inventory counter safe under a flash
sale: the floor check and the decrement are a single operation. Three defects are being checked — the
client-side read-then-write that lets two buyers both pass the check and drive the counter negative,
the hold TTL that does not match the reservation's expiry, and an outcome the API can turn into a
conflict instead of a silent success. The TTL half is the subtle one: a hold that outlives its
reservation keeps a unit locked for a buyer who is long gone, and nothing in the demo notices because
the demo never waits. Real platforms shard hot skus across several counters to spread one key's write
load, keep the script's SHA client-side with a \`NOSCRIPT\` fallback to \`EVAL\`, and reconcile the Redis
counter against the warehouse's allocation of record.`,
};
