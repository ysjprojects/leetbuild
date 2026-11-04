import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis stock transitions: one script per move, holds that expire',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the \`state\` module behind every reservation:
\`reserve(sku, quantity, reservation_id)\` reads \`stock:{sku}\`, compares, runs \`DECRBY\`, then records
the hold in \`holds:{sku}\` and \`hold:{id}\` with \`HOLD_TTL_S = 3600\`; \`release\` and \`confirm\` read
the hold's quantity from \`holds:{sku}\`, then credit the counter or drop the hold. It serves the
demo, where one buyer clicks at a time, and hides four flaws.

**Failure mode the checks target.** Two buyers for the last unit in the same millisecond, a cart
abandoned an hour ago whose units never come back, and a release and a warehouse confirmation of
one reservation landing together.

- \`reserve\` is **one Lua script**: give back the units of every reservation in \`holds:{sku}\` whose
  \`hold:{id}\` key is gone, then check the counter, \`DECRBY\`, record the hold and
  \`SET hold:{id} <quantity> EX <ttl>\`. It returns whether it reserved.
- The hold lives as long as the reservation: \`RESERVATION_TTL_S\` (900 s) from \`inventory.stock\`.
- \`release\` and \`confirm\` are each one script that acts only while the reservation is in
  \`holds:{sku}\`: release credits its units once, confirm drops the hold without crediting, and
  the one that comes second returns 0.`,
  sequence: {
    participants: ['Inventory API', 'Redis', 'Warehouse path'],
    messages: [
      {
        from: 'Inventory API',
        to: 'Redis',
        label: 'EVALSHA reserve · stock:{sku} holds:{sku} hold:{id} · qty · 900',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'expired holds → INCRBY back · check · DECRBY · SET EX', kind: 'sync'},
      {from: 'Redis', to: 'Inventory API', label: '1 reserved · 0 not enough units', kind: 'reply'},
      {from: 'Warehouse path', to: 'Redis', label: 'EVALSHA confirm · hold leaves holds:{sku}', kind: 'sync'},
      {from: 'Inventory API', to: 'Redis', label: 'EVALSHA release · credits only if still held', kind: 'sync'},
      {from: 'Redis', to: 'Inventory API', label: 'units released (0: already sold)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Lets exactly one of two buyers take the last unit',
      detail:
        'Another buyer lands right after the first command on `stock:{sku}`: exactly one of the two gets the unit and the counter never goes below 0. The starter reads, compares and decrements in three commands.',
      match: {
        python: {all: [/redis\.call\(\s*'DECRBY'/, /register_script\(|\.eval\(/], none: [/\.decrby\(/]},
        typescript: {all: [/redis\.call\(\s*'DECRBY'/, /defineCommand\(|\.eval\(/], none: [/\.decrby\(/]},
        go: {all: [/redis\.call\(\s*'DECRBY'/, /redis\.NewScript\(|\.Eval\(/], none: [/\.DecrBy\(/]},
        scala: {all: [/redis\.call\(\s*'DECRBY'/, /jedis\.eval(sha)?\(/], none: [/jedis\.decrBy\(/]},
        cpp: {all: [/redis\.call\(\s*'DECRBY'/, /\.eval(sha)?[<(]/], none: [/\.decrby\(/]},
      },
    },
    {
      id: 'hold-ttl',
      title: "Gives the hold the reservation's 900 s TTL",
      detail:
        '`hold:{id}` expires with the reservation, `RESERVATION_TTL_S` from `inventory.stock`, set by `EX` inside the script. The starter holds the units for an hour.',
      match: {
        python: {all: [/RESERVATION_TTL_S/, /redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/\b3600\b/]},
        typescript: {all: [/RESERVATION_TTL_S/, /redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/\b3600\b/]},
        go: {all: [/stock\.ReservationTTLS/, /redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/\b3600\b/]},
        scala: {all: [/Stock\.ReservationTtlS/, /redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/\b3600\b/]},
        cpp: {all: [/kReservationTtlS/, /redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/\b3600\b/]},
      },
    },
    {
      id: 'reclaim-expired',
      title: "Gives an expired hold's units back before it checks the counter",
      detail:
        'A cart that held the whole stock and was abandoned an hour ago does not block the next buyer: the script credits every reservation whose `hold:{id}` is gone, then checks. The starter never gives expired units back.',
      match: {
        python: {order: [/redis\.call\(\s*'EXISTS'/, /redis\.call\(\s*'DECRBY'/]},
        typescript: {order: [/redis\.call\(\s*'EXISTS'/, /redis\.call\(\s*'DECRBY'/]},
        go: {order: [/redis\.call\(\s*'EXISTS'/, /redis\.call\(\s*'DECRBY'/]},
        scala: {order: [/redis\.call\(\s*'EXISTS'/, /redis\.call\(\s*'DECRBY'/]},
        cpp: {order: [/redis\.call\(\s*'EXISTS'/, /redis\.call\(\s*'DECRBY'/]},
      },
    },
    {
      id: 'settle-once',
      title: 'Releases or sells a reservation once, never both',
      detail:
        'A warehouse confirmation lands in the middle of a release, and a cancellation in the middle of a confirm: the units end up either back on the counter or sold, and the second caller gets 0. The starter reads the hold, then acts on what it read.',
      match: {
        python: {all: [/redis\.call\(\s*'HGET'/], none: [/\.incrby\(/, /\.hdel\(/]},
        typescript: {all: [/redis\.call\(\s*'HGET'/], none: [/\.incrby\(/, /\.hdel\(/]},
        go: {all: [/redis\.call\(\s*'HGET'/], none: [/\.IncrBy\(/, /\.HDel\(/]},
        scala: {all: [/redis\.call\(\s*'HGET'/], none: [/jedis\.incrBy\(/, /jedis\.hdel\(/]},
        cpp: {all: [/redis\.call\(\s*'HGET'/], none: [/\.incrby\(/, /\.hdel\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from inventory.stock import hold_key, holds_key, stock_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOLD_TTL_S = 3600


def reserve(sku: str, quantity: int, reservation_id: str) -> bool:
    """Hold quantity units for the reservation; False when the sku has fewer available."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    available = int(r.get(stock_key(sku)) or 0)
    if available < quantity:
        return False
    r.decrby(stock_key(sku), quantity)
    r.hset(holds_key(sku), reservation_id, quantity)
    r.set(hold_key(reservation_id), quantity, ex=HOLD_TTL_S)
    return True


def release(sku: str, reservation_id: str) -> int:
    """Give the reservation's units back; the units released (0 when it holds none)."""
    quantity = int(r.hget(holds_key(sku), reservation_id) or 0)
    r.incrby(stock_key(sku), quantity)
    r.hdel(holds_key(sku), reservation_id)
    r.delete(hold_key(reservation_id))
    return quantity


def confirm(sku: str, reservation_id: str) -> int:
    """The warehouse allocated the units: the hold becomes a sale; the units sold."""
    quantity = int(r.hget(holds_key(sku), reservation_id) or 0)
    r.hdel(holds_key(sku), reservation_id)
    r.delete(hold_key(reservation_id))
    return quantity
`,
      solution: `import redis

from inventory.stock import RESERVATION_TTL_S, hold_key, holds_key, stock_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Every transition is one script: Redis runs it with nothing in between, so no other buyer, release
# or confirmation can act on what this one read.
# KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
RESERVE_LUA = """
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
"""

RELEASE_LUA = """
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
"""

CONFIRM_LUA = """
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
"""

reserve_script = r.register_script(RESERVE_LUA)
release_script = r.register_script(RELEASE_LUA)
confirm_script = r.register_script(CONFIRM_LUA)


def _keys(sku: str, reservation_id: str) -> list[str]:
    return [stock_key(sku), holds_key(sku), hold_key(reservation_id)]


def reserve(sku: str, quantity: int, reservation_id: str) -> bool:
    """Hold quantity units for the reservation; False when the sku has fewer available."""
    return reserve_script(keys=_keys(sku, reservation_id), args=[quantity, reservation_id, RESERVATION_TTL_S]) == 1


def release(sku: str, reservation_id: str) -> int:
    """Give the reservation's units back; the units released (0 when it holds none)."""
    return int(release_script(keys=_keys(sku, reservation_id), args=[reservation_id]))


def confirm(sku: str, reservation_id: str) -> int:
    """The warehouse allocated the units: the hold becomes a sale; the units sold."""
    return int(confirm_script(keys=_keys(sku, reservation_id), args=[reservation_id]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {holdKey, holdsKey, stockKey} from 'inventory/stock';

const redis = new Redis({host: 'redis', port: 6379});

export const HOLD_TTL_S = 3600;

/** Hold quantity units for the reservation; false when the sku has fewer available. */
export async function reserve(sku: string, quantity: number, reservationId: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const available = Number((await redis.get(stockKey(sku))) ?? 0);
  if (available < quantity) return false;
  await redis.decrby(stockKey(sku), quantity);
  await redis.hset(holdsKey(sku), reservationId, quantity);
  await redis.set(holdKey(reservationId), quantity, 'EX', HOLD_TTL_S);
  return true;
}

/** Give the reservation's units back; the units released (0 when it holds none). */
export async function release(sku: string, reservationId: string): Promise<number> {
  const quantity = Number((await redis.hget(holdsKey(sku), reservationId)) ?? 0);
  await redis.incrby(stockKey(sku), quantity);
  await redis.hdel(holdsKey(sku), reservationId);
  await redis.del(holdKey(reservationId));
  return quantity;
}

/** The warehouse allocated the units: the hold becomes a sale; the units sold. */
export async function confirm(sku: string, reservationId: string): Promise<number> {
  const quantity = Number((await redis.hget(holdsKey(sku), reservationId)) ?? 0);
  await redis.hdel(holdsKey(sku), reservationId);
  await redis.del(holdKey(reservationId));
  return quantity;
}
`,
      solution: `import Redis from 'ioredis';

import {RESERVATION_TTL_S, holdKey, holdsKey, stockKey} from 'inventory/stock';

// Every transition is one script: Redis runs it with nothing in between, so no other buyer, release
// or confirmation can act on what this one read.
// KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
const RESERVE_LUA = \`
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
\`;

const RELEASE_LUA = \`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
\`;

const CONFIRM_LUA = \`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
\`;

interface StateRedis extends Redis {
  reserveUnits(stock: string, holds: string, hold: string, quantity: number, reservationId: string, ttl: number): Promise<number>;
  releaseUnits(stock: string, holds: string, hold: string, reservationId: string): Promise<number>;
  confirmUnits(stock: string, holds: string, hold: string, reservationId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('reserveUnits', {numberOfKeys: 3, lua: RESERVE_LUA});
redis.defineCommand('releaseUnits', {numberOfKeys: 3, lua: RELEASE_LUA});
redis.defineCommand('confirmUnits', {numberOfKeys: 3, lua: CONFIRM_LUA});

/** Hold quantity units for the reservation; false when the sku has fewer available. */
export async function reserve(sku: string, quantity: number, reservationId: string): Promise<boolean> {
  const held = await redis.reserveUnits(stockKey(sku), holdsKey(sku), holdKey(reservationId), quantity, reservationId, RESERVATION_TTL_S);
  return Number(held) === 1;
}

/** Give the reservation's units back; the units released (0 when it holds none). */
export async function release(sku: string, reservationId: string): Promise<number> {
  return Number(await redis.releaseUnits(stockKey(sku), holdsKey(sku), holdKey(reservationId), reservationId));
}

/** The warehouse allocated the units: the hold becomes a sale; the units sold. */
export async function confirm(sku: string, reservationId: string): Promise<number> {
  return Number(await redis.confirmUnits(stockKey(sku), holdsKey(sku), holdKey(reservationId), reservationId));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"inventory/stock"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const holdTTL = 3600 * time.Second

// reserve holds quantity units for the reservation; false when the sku has fewer available.
func reserve(ctx context.Context, sku string, quantity int, reservationID string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	available, err := rdb.Get(ctx, stock.Key(sku)).Int()
	if err != nil && err != redis.Nil {
		return false, err
	}
	if available < quantity {
		return false, nil
	}
	if err := rdb.DecrBy(ctx, stock.Key(sku), int64(quantity)).Err(); err != nil {
		return false, err
	}
	if err := rdb.HSet(ctx, stock.HoldsKey(sku), reservationID, quantity).Err(); err != nil {
		return false, err
	}
	return true, rdb.Set(ctx, stock.HoldKey(reservationID), quantity, holdTTL).Err()
}

// release gives the reservation's units back and returns how many (0 when it holds none).
func release(ctx context.Context, sku, reservationID string) (int, error) {
	quantity, err := rdb.HGet(ctx, stock.HoldsKey(sku), reservationID).Int()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	rdb.IncrBy(ctx, stock.Key(sku), int64(quantity))
	rdb.HDel(ctx, stock.HoldsKey(sku), reservationID)
	rdb.Del(ctx, stock.HoldKey(reservationID))
	return quantity, nil
}

// confirm turns the hold into a sale after the warehouse allocated the units; it returns the units sold.
func confirm(ctx context.Context, sku, reservationID string) (int, error) {
	quantity, err := rdb.HGet(ctx, stock.HoldsKey(sku), reservationID).Int()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	rdb.HDel(ctx, stock.HoldsKey(sku), reservationID)
	rdb.Del(ctx, stock.HoldKey(reservationID))
	return quantity, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"inventory/stock"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Every transition is one script: Redis runs it with nothing in between, so no other buyer, release
// or confirmation can act on what this one read.
// KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
var reserveScript = redis.NewScript(\`
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
\`)

var releaseScript = redis.NewScript(\`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
\`)

var confirmScript = redis.NewScript(\`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
\`)

func stateKeys(sku, reservationID string) []string {
	return []string{stock.Key(sku), stock.HoldsKey(sku), stock.HoldKey(reservationID)}
}

// reserve holds quantity units for the reservation; false when the sku has fewer available.
func reserve(ctx context.Context, sku string, quantity int, reservationID string) (bool, error) {
	held, err := reserveScript.Run(ctx, rdb, stateKeys(sku, reservationID), quantity, reservationID, stock.ReservationTTLS).Int()
	return held == 1, err
}

// release gives the reservation's units back and returns how many (0 when it holds none).
func release(ctx context.Context, sku, reservationID string) (int, error) {
	return releaseScript.Run(ctx, rdb, stateKeys(sku, reservationID), reservationID).Int()
}

// confirm turns the hold into a sale after the warehouse allocated the units; it returns the units sold.
func confirm(ctx context.Context, sku, reservationID string) (int, error) {
	return confirmScript.Run(ctx, rdb, stateKeys(sku, reservationID), reservationID).Int()
}
`,
    },
    scala: {
      starter: `import inventory.Stock // Stock.key, holdsKey, holdKey, ReservationTtlS
import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  val HoldTtlS = 3600L

  /** Hold quantity units for the reservation; false when the sku has fewer available. */
  def reserve(sku: String, quantity: Int, reservationId: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val available = Option(jedis.get(Stock.key(sku))).map(_.toLong).getOrElse(0L)
    if (available < quantity) false
    else {
      jedis.decrBy(Stock.key(sku), quantity.toLong)
      jedis.hset(Stock.holdsKey(sku), reservationId, quantity.toString)
      jedis.setex(Stock.holdKey(reservationId), HoldTtlS, quantity.toString)
      true
    }
  }

  /** Give the reservation's units back; the units released (0 when it holds none). */
  def release(sku: String, reservationId: String): Long = {
    val quantity = Option(jedis.hget(Stock.holdsKey(sku), reservationId)).map(_.toLong).getOrElse(0L)
    jedis.incrBy(Stock.key(sku), quantity)
    jedis.hdel(Stock.holdsKey(sku), reservationId)
    jedis.del(Stock.holdKey(reservationId))
    quantity
  }

  /** The warehouse allocated the units: the hold becomes a sale; the units sold. */
  def confirm(sku: String, reservationId: String): Long = {
    val quantity = Option(jedis.hget(Stock.holdsKey(sku), reservationId)).map(_.toLong).getOrElse(0L)
    jedis.hdel(Stock.holdsKey(sku), reservationId)
    jedis.del(Stock.holdKey(reservationId))
    quantity
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import inventory.Stock // Stock.key, holdsKey, holdKey, ReservationTtlS
import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  // Every transition is one script: Redis runs it with nothing in between, so no other buyer,
  // release or confirmation can act on what this one read.
  // KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
  val ReserveLua: String =
    """
      |local entries = redis.call('HGETALL', KEYS[2])
      |for i = 1, #entries, 2 do
      |  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
      |    redis.call('HDEL', KEYS[2], entries[i])
      |    redis.call('INCRBY', KEYS[1], entries[i + 1])
      |  end
      |end
      |local quantity = tonumber(ARGV[1])
      |if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
      |redis.call('DECRBY', KEYS[1], quantity)
      |redis.call('HSET', KEYS[2], ARGV[2], quantity)
      |redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
      |return 1
      |""".stripMargin

  val ReleaseLua: String =
    """
      |local quantity = redis.call('HGET', KEYS[2], ARGV[1])
      |if not quantity then return 0 end
      |redis.call('HDEL', KEYS[2], ARGV[1])
      |redis.call('DEL', KEYS[3])
      |redis.call('INCRBY', KEYS[1], quantity)
      |return tonumber(quantity)
      |""".stripMargin

  val ConfirmLua: String =
    """
      |local quantity = redis.call('HGET', KEYS[2], ARGV[1])
      |if not quantity then return 0 end
      |redis.call('HDEL', KEYS[2], ARGV[1])
      |redis.call('DEL', KEYS[3])
      |return tonumber(quantity)
      |""".stripMargin

  private def run(script: String, sku: String, reservationId: String, args: Seq[String]): Long =
    jedis.eval(script, List(Stock.key(sku), Stock.holdsKey(sku), Stock.holdKey(reservationId)).asJava, args.asJava).asInstanceOf[java.lang.Long]

  /** Hold quantity units for the reservation; false when the sku has fewer available. */
  def reserve(sku: String, quantity: Int, reservationId: String): Boolean =
    run(ReserveLua, sku, reservationId, Seq(quantity.toString, reservationId, Stock.ReservationTtlS.toString)) == 1L

  /** Give the reservation's units back; the units released (0 when it holds none). */
  def release(sku: String, reservationId: String): Long = run(ReleaseLua, sku, reservationId, Seq(reservationId))

  /** The warehouse allocated the units: the hold becomes a sale; the units sold. */
  def confirm(sku: String, reservationId: String): Long = run(ConfirmLua, sku, reservationId, Seq(reservationId))
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "inventory/stock.h"  // stock::Key, HoldsKey, HoldKey, kReservationTtlS

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kHoldTtlS = 3600;

// Hold quantity units for the reservation; false when the sku has fewer available.
bool reserve(const std::string& sku, int quantity, const std::string& reservation_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto available = redis.get(inventory::stock::Key(sku));
  if (!available || std::stoll(*available) < quantity) return false;
  redis.decrby(inventory::stock::Key(sku), quantity);
  redis.hset(inventory::stock::HoldsKey(sku), reservation_id, std::to_string(quantity));
  redis.set(inventory::stock::HoldKey(reservation_id), std::to_string(quantity), std::chrono::seconds(kHoldTtlS));
  return true;
}

// Give the reservation's units back; the units released (0 when it holds none).
long long release(const std::string& sku, const std::string& reservation_id) {
  const auto quantity = redis.hget(inventory::stock::HoldsKey(sku), reservation_id);
  if (!quantity) return 0;
  redis.incrby(inventory::stock::Key(sku), std::stoll(*quantity));
  redis.hdel(inventory::stock::HoldsKey(sku), reservation_id);
  redis.del(inventory::stock::HoldKey(reservation_id));
  return std::stoll(*quantity);
}

// The warehouse allocated the units: the hold becomes a sale; the units sold.
long long confirm(const std::string& sku, const std::string& reservation_id) {
  const auto quantity = redis.hget(inventory::stock::HoldsKey(sku), reservation_id);
  if (!quantity) return 0;
  redis.hdel(inventory::stock::HoldsKey(sku), reservation_id);
  redis.del(inventory::stock::HoldKey(reservation_id));
  return std::stoll(*quantity);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "inventory/stock.h"  // stock::Key, HoldsKey, HoldKey, kReservationTtlS

sw::redis::Redis redis("tcp://redis:6379");

// Every transition is one script: Redis runs it with nothing in between, so no other buyer, release
// or confirmation can act on what this one read.
// KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
const std::string kReserveLua = R"lua(
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
)lua";

const std::string kReleaseLua = R"lua(
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
)lua";

const std::string kConfirmLua = R"lua(
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
)lua";

static std::vector<std::string> stateKeys(const std::string& sku, const std::string& reservation_id) {
  return {inventory::stock::Key(sku), inventory::stock::HoldsKey(sku), inventory::stock::HoldKey(reservation_id)};
}

// Hold quantity units for the reservation; false when the sku has fewer available.
bool reserve(const std::string& sku, int quantity, const std::string& reservation_id) {
  const std::vector<std::string> args = {std::to_string(quantity), reservation_id, std::to_string(inventory::stock::kReservationTtlS)};
  return redis.eval<long long>(kReserveLua, stateKeys(sku, reservation_id), args) == 1;
}

// Give the reservation's units back; the units released (0 when it holds none).
long long release(const std::string& sku, const std::string& reservation_id) {
  return redis.eval<long long>(kReleaseLua, stateKeys(sku, reservation_id), std::vector<std::string>{reservation_id});
}

// The warehouse allocated the units: the hold becomes a sale; the units sold.
long long confirm(const std::string& sku, const std::string& reservation_id) {
  return redis.eval<long long>(kConfirmLua, stateKeys(sku, reservation_id), std::vector<std::string>{reservation_id});
}
`,
    },
  },
  harness: {
    python: `from inventory.stock import hold_key, holds_key, stock_key

SKU = "sku-1"


def _units(ctx):
    return int(ctx.redis.get(stock_key(SKU)) or 0)


def _held(ctx, reservation_id, quantity):
    """A reservation already holding units, as the reserve script leaves it."""
    ctx.redis.hset(holds_key(SKU), reservation_id, quantity)
    ctx.redis.set(hold_key(reservation_id), quantity, ex=900)


def check_atomic_reserve(ctx):
    m = ctx.load("state")
    ctx.redis.set(stock_key(SKU), 1)

    # Another buyer's reserve lands right after the learner's first command on the counter.
    def other_buyer():
        if int(ctx.redis.get(stock_key(SKU)) or 0) < 1:
            return 0
        ctx.redis.decrby(stock_key(SKU), 1)
        _held(ctx, "r-other", 1)
        return 1

    probe = ctx.redis_after(stock_key(SKU), other_buyer)
    won = m.reserve(SKU, 1, "r-1")
    assert probe.fired, "reserve never touched stock:sku-1"
    assert _units(ctx) >= 0, f"two buyers raced for the last unit and stock:sku-1 is {_units(ctx)}: the other buyer took it between your read and your DECRBY, so the check and the decrement must be one Lua script"
    winners = probe.result + (1 if won else 0)
    assert winners == 1, f"two buyers raced for the last unit and {winners} got it"


def check_hold_ttl(ctx):
    m = ctx.load("state")
    ctx.redis.set(stock_key(SKU), 5)
    assert m.reserve(SKU, 2, "r-1") is True, "reserve refused 2 of 5 units"
    ttl = ctx.redis.ttl(hold_key("r-1"))
    assert 850 <= ttl <= 900, f"hold:r-1 has TTL {ttl}, expected the reservation's RESERVATION_TTL_S (900 s): a hold that outlives its reservation blocks units nobody can buy"
    assert ctx.redis.hget(holds_key(SKU), "r-1") == "2", f"holds:sku-1 maps r-1 to {ctx.redis.hget(holds_key(SKU), 'r-1')!r}, expected 2"
    assert _units(ctx) == 3, f"stock:sku-1 is {_units(ctx)} after reserving 2 of 5"


def check_reclaim_expired(ctx):
    m = ctx.load("state")
    ctx.redis.set(stock_key(SKU), 3)
    assert m.reserve(SKU, 3, "r-1") is True, "reserve refused 3 of 3 units"
    ctx.clock.advance(3601)  # the cart was abandoned an hour ago: its hold key is gone
    assert ctx.redis.exists(hold_key("r-1")) == 0, "hold:r-1 still exists an hour later"
    again = m.reserve(SKU, 3, "r-2")
    assert again is True, "a cart abandoned an hour ago still blocks all 3 units: give back the units of every reservation whose hold key is gone, inside the script, before checking the counter"
    assert _units(ctx) == 0, f"stock:sku-1 is {_units(ctx)} after the expired 3 came back and 3 were reserved again, expected 0"
    holds = ctx.redis.hgetall(holds_key(SKU))
    assert holds == {"r-2": "3"}, f"holds:sku-1 is {holds}, expected only the live reservation r-2"


def check_settle_once(ctx):
    m = ctx.load("state")
    ctx.redis.set(stock_key(SKU), 5)
    _held(ctx, "r-1", 3)
    _held(ctx, "r-2", 2)

    # The warehouse's confirmation of r-1 lands right after the release's first command on the holds.
    def warehouse_confirms():
        quantity = ctx.redis.hget(holds_key(SKU), "r-1")
        if quantity is None:
            return 0
        ctx.redis.hdel(holds_key(SKU), "r-1")
        ctx.redis.delete(hold_key("r-1"))
        return int(quantity)

    probe = ctx.redis_after(holds_key(SKU), warehouse_confirms)
    released = m.release(SKU, "r-1")
    assert probe.fired, "release never touched holds:sku-1"
    sold = probe.result
    assert released + sold == 3, f"r-1's 3 units were sold to the warehouse ({sold}) and put back on the counter ({released}) at once: release must act only while the hold is still in holds:sku-1, in one script"
    assert _units(ctx) == 5 + released, f"stock:sku-1 is {_units(ctx)}, expected {5 + released}"

    # A cancellation of r-2 lands right after the confirm's first command on the holds.
    def buyer_cancels():
        quantity = ctx.redis.hget(holds_key(SKU), "r-2")
        if quantity is None:
            return 0
        ctx.redis.hdel(holds_key(SKU), "r-2")
        ctx.redis.delete(hold_key("r-2"))
        ctx.redis.incrby(stock_key(SKU), int(quantity))
        return int(quantity)

    probe = ctx.redis_after(holds_key(SKU), buyer_cancels)
    confirmed = m.confirm(SKU, "r-2")
    assert probe.fired, "confirm never touched holds:sku-1"
    assert confirmed + probe.result == 2, f"r-2's 2 units were put back ({probe.result}) and confirmed as sold ({confirmed}) at once: confirm must act only while the hold is still in holds:sku-1, in one script"
`,
    typescript: `import {holdKey, holdsKey, stockKey} from 'inventory/stock';

const SKU = 'sku-1';

const units = (ctx): number => Number(ctx.redis.get(stockKey(SKU)) ?? 0);

/** A reservation already holding units, as the reserve script leaves it. */
function held(ctx, reservationId: string, quantity: number) {
  ctx.redis.hset(holdsKey(SKU), reservationId, String(quantity));
  ctx.redis.set(holdKey(reservationId), String(quantity), 'EX', 900);
}

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('state');
  ctx.redis.set(stockKey(SKU), '1');
  // Another buyer's reserve lands right after the learner's first command on the counter.
  const probe = ctx.redisAfter(stockKey(SKU), () => {
    if (Number(ctx.redis.get(stockKey(SKU)) ?? 0) < 1) return 0;
    ctx.redis.decrby(stockKey(SKU), 1);
    held(ctx, 'r-other', 1);
    return 1;
  });
  const won = await m.reserve(SKU, 1, 'r-1');
  assert(probe.fired, 'reserve never touched stock:sku-1');
  assert(units(ctx) >= 0, \`two buyers raced for the last unit and stock:sku-1 is \${units(ctx)}: the other buyer took it between your read and your DECRBY, so the check and the decrement must be one Lua script\`);
  const winners = (probe.result as number) + (won ? 1 : 0);
  assert.equal(winners, 1, \`two buyers raced for the last unit and \${winners} got it\`);
}

export async function check_hold_ttl(ctx) {
  const m = ctx.load('state');
  ctx.redis.set(stockKey(SKU), '5');
  assert.equal(await m.reserve(SKU, 2, 'r-1'), true, 'reserve refused 2 of 5 units');
  const ttl = ctx.redis.ttl(holdKey('r-1'));
  assert(850 <= ttl && ttl <= 900, \`hold:r-1 has TTL \${ttl}, expected the reservation's RESERVATION_TTL_S (900 s): a hold that outlives its reservation blocks units nobody can buy\`);
  assert.equal(ctx.redis.hget(holdsKey(SKU), 'r-1'), '2', \`holds:sku-1 maps r-1 to \${ctx.redis.hget(holdsKey(SKU), 'r-1')}, expected 2\`);
  assert.equal(units(ctx), 3, \`stock:sku-1 is \${units(ctx)} after reserving 2 of 5\`);
}

export async function check_reclaim_expired(ctx) {
  const m = ctx.load('state');
  ctx.redis.set(stockKey(SKU), '3');
  assert.equal(await m.reserve(SKU, 3, 'r-1'), true, 'reserve refused 3 of 3 units');
  ctx.clock.advance(3601); // the cart was abandoned an hour ago: its hold key is gone
  assert.equal(ctx.redis.exists(holdKey('r-1')), 0, 'hold:r-1 still exists an hour later');
  const again = await m.reserve(SKU, 3, 'r-2');
  assert.equal(again, true, 'a cart abandoned an hour ago still blocks all 3 units: give back the units of every reservation whose hold key is gone, inside the script, before checking the counter');
  assert.equal(units(ctx), 0, \`stock:sku-1 is \${units(ctx)} after the expired 3 came back and 3 were reserved again, expected 0\`);
  const holds = ctx.redis.hgetall(holdsKey(SKU));
  assert.deepEqual(holds, {'r-2': '3'}, \`holds:sku-1 is \${JSON.stringify(holds)}, expected only the live reservation r-2\`);
}

export async function check_settle_once(ctx) {
  const m = ctx.load('state');
  ctx.redis.set(stockKey(SKU), '5');
  held(ctx, 'r-1', 3);
  held(ctx, 'r-2', 2);
  // The warehouse's confirmation of r-1 lands right after the release's first command on the holds.
  let probe = ctx.redisAfter(holdsKey(SKU), () => {
    const quantity = ctx.redis.hget(holdsKey(SKU), 'r-1');
    if (quantity === null) return 0;
    ctx.redis.hdel(holdsKey(SKU), 'r-1');
    ctx.redis.del(holdKey('r-1'));
    return Number(quantity);
  });
  const released = await m.release(SKU, 'r-1');
  assert(probe.fired, 'release never touched holds:sku-1');
  const sold = probe.result as number;
  assert.equal(released + sold, 3, \`r-1's 3 units were sold to the warehouse (\${sold}) and put back on the counter (\${released}) at once: release must act only while the hold is still in holds:sku-1, in one script\`);
  assert.equal(units(ctx), 5 + released, \`stock:sku-1 is \${units(ctx)}, expected \${5 + released}\`);
  // A cancellation of r-2 lands right after the confirm's first command on the holds.
  probe = ctx.redisAfter(holdsKey(SKU), () => {
    const quantity = ctx.redis.hget(holdsKey(SKU), 'r-2');
    if (quantity === null) return 0;
    ctx.redis.hdel(holdsKey(SKU), 'r-2');
    ctx.redis.del(holdKey('r-2'));
    ctx.redis.incrby(stockKey(SKU), Number(quantity));
    return Number(quantity);
  });
  const confirmed = await m.confirm(SKU, 'r-2');
  assert(probe.fired, 'confirm never touched holds:sku-1');
  assert.equal(confirmed + (probe.result as number), 2, \`r-2's 2 units were put back (\${probe.result}) and confirmed as sold (\${confirmed}) at once: confirm must act only while the hold is still in holds:sku-1, in one script\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"

	"inventory/stock"
)

const stateSKU = "sku-1"

func stateUnits(ctx *harness.Ctx) int {
	value, _ := ctx.Redis.Get(stock.Key(stateSKU))
	n, _ := strconv.Atoi(value)
	return n
}

// stateHeld is a reservation already holding units, as the reserve script leaves it.
func stateHeld(ctx *harness.Ctx, reservationID string, quantity int) {
	ctx.Redis.Do("HSET", stock.HoldsKey(stateSKU), reservationID, quantity)
	ctx.Redis.Set(stock.HoldKey(reservationID), quantity, "EX", 900)
}

// stateTake removes a reservation from the hold map, as a settled transition does, and returns its units.
func stateTake(ctx *harness.Ctx, reservationID string) int {
	value, ok := ctx.Redis.HGet(stock.HoldsKey(stateSKU), reservationID)
	if !ok {
		return 0
	}
	ctx.Redis.Do("HDEL", stock.HoldsKey(stateSKU), reservationID)
	ctx.Redis.Del(stock.HoldKey(reservationID))
	n, _ := strconv.Atoi(value)
	return n
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	ctx.Redis.Set(stock.Key(stateSKU), 1)
	// Another buyer's reserve lands right after the learner's first command on the counter.
	other := 0
	probe := ctx.Redis.After(stock.Key(stateSKU), func() any {
		if stateUnits(ctx) >= 1 {
			ctx.Redis.Do("DECRBY", stock.Key(stateSKU), 1)
			stateHeld(ctx, "r-other", 1)
			other = 1
		}
		return other
	})
	won, err := reserve(context.Background(), stateSKU, 1, "r-1")
	ctx.NoError(err, "reserve")
	ctx.Assert(probe.Fired, "reserve never touched stock:sku-1")
	ctx.Assert(stateUnits(ctx) >= 0, "two buyers raced for the last unit and stock:sku-1 is %d: the other buyer took it between your read and your DECRBY, so the check and the decrement must be one Lua script", stateUnits(ctx))
	winners := other
	if won {
		winners++
	}
	ctx.Equal(winners, 1, "two buyers raced for the last unit; the buyers who got it")
}

func CheckHoldTtl(ctx *harness.Ctx) {
	ctx.Redis.Set(stock.Key(stateSKU), 5)
	ok, err := reserve(context.Background(), stateSKU, 2, "r-1")
	ctx.NoError(err, "reserve")
	ctx.Assert(ok, "reserve refused 2 of 5 units")
	ttl := ctx.Redis.TTL(stock.HoldKey("r-1"))
	ctx.Assert(850 <= ttl && ttl <= 900, "hold:r-1 has TTL %d, expected the reservation's RESERVATION_TTL_S (900 s): a hold that outlives its reservation blocks units nobody can buy", ttl)
	quantity, _ := ctx.Redis.HGet(stock.HoldsKey(stateSKU), "r-1")
	ctx.Equal(quantity, "2", "holds:sku-1's entry for r-1")
	ctx.Equal(stateUnits(ctx), 3, "stock:sku-1 after reserving 2 of 5")
}

func CheckReclaimExpired(ctx *harness.Ctx) {
	ctx.Redis.Set(stock.Key(stateSKU), 3)
	ok, err := reserve(context.Background(), stateSKU, 3, "r-1")
	ctx.NoError(err, "reserve")
	ctx.Assert(ok, "reserve refused 3 of 3 units")
	ctx.Clock.Advance(3601) // the cart was abandoned an hour ago: its hold key is gone
	ctx.Equal(ctx.Redis.Exists(stock.HoldKey("r-1")), 0, "hold:r-1 an hour later")
	again, err := reserve(context.Background(), stateSKU, 3, "r-2")
	ctx.NoError(err, "reserve")
	ctx.Assert(again, "a cart abandoned an hour ago still blocks all 3 units: give back the units of every reservation whose hold key is gone, inside the script, before checking the counter")
	ctx.Equal(stateUnits(ctx), 0, "stock:sku-1 after the expired 3 came back and 3 were reserved again")
	ctx.Equal(ctx.Redis.HGetAll(stock.HoldsKey(stateSKU)), map[string]string{"r-2": "3"}, "holds:sku-1 (only the live reservation r-2)")
}

func CheckSettleOnce(ctx *harness.Ctx) {
	ctx.Redis.Set(stock.Key(stateSKU), 5)
	stateHeld(ctx, "r-1", 3)
	stateHeld(ctx, "r-2", 2)
	// The warehouse's confirmation of r-1 lands right after the release's first command on the holds.
	sold := 0
	probe := ctx.Redis.After(stock.HoldsKey(stateSKU), func() any {
		sold = stateTake(ctx, "r-1")
		return sold
	})
	released, err := release(context.Background(), stateSKU, "r-1")
	ctx.NoError(err, "release")
	ctx.Assert(probe.Fired, "release never touched holds:sku-1")
	ctx.Assert(released+sold == 3, "r-1's 3 units were sold to the warehouse (%d) and put back on the counter (%d) at once: release must act only while the hold is still in holds:sku-1, in one script", sold, released)
	ctx.Equal(stateUnits(ctx), 5+released, "stock:sku-1 after the release")
	// A cancellation of r-2 lands right after the confirm's first command on the holds.
	cancelled := 0
	probe = ctx.Redis.After(stock.HoldsKey(stateSKU), func() any {
		cancelled = stateTake(ctx, "r-2")
		ctx.Redis.Do("INCRBY", stock.Key(stateSKU), cancelled)
		return cancelled
	})
	confirmed, err := confirm(context.Background(), stateSKU, "r-2")
	ctx.NoError(err, "confirm")
	ctx.Assert(probe.Fired, "confirm never touched holds:sku-1")
	ctx.Assert(confirmed+cancelled == 2, "r-2's 2 units were put back (%d) and confirmed as sold (%d) at once: confirm must act only while the hold is still in holds:sku-1, in one script", cancelled, confirmed)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>

#include "inventory/stock.h"

namespace {

const std::string kStateSku = "sku-1";

long long stateUnits(harness::Ctx& ctx) {
  const auto value = ctx.Redis.Get(inventory::stock::Key(kStateSku));
  return value ? std::stoll(*value) : 0;
}

// A reservation already holding units, as the reserve script leaves it.
void stateHeld(harness::Ctx& ctx, const std::string& reservation_id, int quantity) {
  ctx.Redis.Do("HSET", inventory::stock::HoldsKey(kStateSku), reservation_id, quantity);
  ctx.Redis.Do("SET", inventory::stock::HoldKey(reservation_id), quantity, "EX", 900);
}

// Remove a reservation from the hold map, as a settled transition does; its units.
long long stateTake(harness::Ctx& ctx, const std::string& reservation_id) {
  const auto value = ctx.Redis.HGet(inventory::stock::HoldsKey(kStateSku), reservation_id);
  if (!value) return 0;
  ctx.Redis.Do("HDEL", inventory::stock::HoldsKey(kStateSku), reservation_id);
  ctx.Redis.Do("DEL", inventory::stock::HoldKey(reservation_id));
  return std::stoll(*value);
}

}  // namespace

void CheckAtomicReserve(harness::Ctx& ctx) {
  ctx.Redis.Do("SET", inventory::stock::Key(kStateSku), 1);
  // Another buyer's reserve lands right after the learner's first command on the counter.
  bool fired = false;
  int other = 0;
  ctx.Redis.After(inventory::stock::Key(kStateSku), [&] {
    fired = true;
    if (stateUnits(ctx) >= 1) {
      ctx.Redis.Do("DECRBY", inventory::stock::Key(kStateSku), 1);
      stateHeld(ctx, "r-other", 1);
      other = 1;
    }
  });
  const bool won = reserve(kStateSku, 1, "r-1");
  ctx.Assert(fired, "reserve never touched stock:sku-1");
  ctx.Assert(stateUnits(ctx) >= 0,
             "two buyers raced for the last unit and stock:sku-1 is %d: the other buyer took it between your read and your "
             "DECRBY, so the check and the decrement must be one Lua script",
             stateUnits(ctx));
  ctx.Equal(other + (won ? 1 : 0), 1, "two buyers raced for the last unit; the buyers who got it");
}

void CheckHoldTtl(harness::Ctx& ctx) {
  ctx.Redis.Do("SET", inventory::stock::Key(kStateSku), 5);
  ctx.Assert(reserve(kStateSku, 2, "r-1"), "reserve refused 2 of 5 units");
  const long long ttl = ctx.Redis.TTL(inventory::stock::HoldKey("r-1"));
  ctx.Assert(850 <= ttl && ttl <= 900,
             "hold:r-1 has TTL %d, expected the reservation's RESERVATION_TTL_S (900 s): a hold that outlives its reservation "
             "blocks units nobody can buy",
             ttl);
  ctx.Equal(ctx.Redis.HGet(inventory::stock::HoldsKey(kStateSku), "r-1").value_or(""), "2", "holds:sku-1's entry for r-1");
  ctx.Equal(stateUnits(ctx), 3, "stock:sku-1 after reserving 2 of 5");
}

void CheckReclaimExpired(harness::Ctx& ctx) {
  ctx.Redis.Do("SET", inventory::stock::Key(kStateSku), 3);
  ctx.Assert(reserve(kStateSku, 3, "r-1"), "reserve refused 3 of 3 units");
  ctx.Clock.Advance(3601);  // the cart was abandoned an hour ago: its hold key is gone
  ctx.Equal(ctx.Redis.Exists(inventory::stock::HoldKey("r-1")), 0, "hold:r-1 an hour later");
  ctx.Assert(reserve(kStateSku, 3, "r-2"),
             "a cart abandoned an hour ago still blocks all 3 units: give back the units of every reservation whose hold key "
             "is gone, inside the script, before checking the counter");
  ctx.Equal(stateUnits(ctx), 0, "stock:sku-1 after the expired 3 came back and 3 were reserved again");
  ctx.Equal(ctx.Redis.HGetAll(inventory::stock::HoldsKey(kStateSku)), std::map<std::string, std::string>{{"r-2", "3"}},
            "holds:sku-1 (only the live reservation r-2)");
}

void CheckSettleOnce(harness::Ctx& ctx) {
  ctx.Redis.Do("SET", inventory::stock::Key(kStateSku), 5);
  stateHeld(ctx, "r-1", 3);
  stateHeld(ctx, "r-2", 2);
  // The warehouse's confirmation of r-1 lands right after the release's first command on the holds.
  bool fired = false;
  long long sold = 0;
  ctx.Redis.After(inventory::stock::HoldsKey(kStateSku), [&] {
    fired = true;
    sold = stateTake(ctx, "r-1");
  });
  const long long released = release(kStateSku, "r-1");
  ctx.Assert(fired, "release never touched holds:sku-1");
  ctx.Assert(released + sold == 3,
             "r-1's 3 units were sold to the warehouse (%d) and put back on the counter (%d) at once: release must act only "
             "while the hold is still in holds:sku-1, in one script",
             sold, released);
  ctx.Equal(stateUnits(ctx), 5 + released, "stock:sku-1 after the release");
  // A cancellation of r-2 lands right after the confirm's first command on the holds.
  fired = false;
  long long cancelled = 0;
  ctx.Redis.After(inventory::stock::HoldsKey(kStateSku), [&] {
    fired = true;
    cancelled = stateTake(ctx, "r-2");
    ctx.Redis.Do("INCRBY", inventory::stock::Key(kStateSku), cancelled);
  });
  const long long confirmed = confirm(kStateSku, "r-2");
  ctx.Assert(fired, "confirm never touched holds:sku-1");
  ctx.Assert(confirmed + cancelled == 2,
             "r-2's 2 units were put back (%d) and confirmed as sold (%d) at once: confirm must act only while the hold is "
             "still in holds:sku-1, in one script",
             cancelled, confirmed);
}
`,
  },
  hints: [
    'During a flash sale the last unit is sold to two buyers and the counter reads -1; a cart abandoned an hour ago still blocks its units; a cancelled order that the warehouse also shipped shows up as stock again.',
    'Between the `GET` and the `DECRBY` another buyer runs the same `GET` and sees the same unit. Redis runs one script at a time, so a read and a write inside one script cannot interleave with anyone else.',
    'Move each function into one script: reserve credits holds whose `hold:{id}` is gone, checks, `DECRBY`s and `SET … EX` with `RESERVATION_TTL_S`; release and confirm `HGET` the hold, return 0 if it is gone, else `HDEL` and (release only) `INCRBY`.',
  ],
  debrief: `Each transition is one script because the question "is it still there, and if so, take it" must be answered by something nothing else can interrupt, and Redis runs a script that way. The hold map is what makes release and confirm safe to race: whoever removes the entry first wins, and the loser sees nothing to act on. Expired holds are given back inside the reserve script, so a cart that was abandoned costs nothing once its TTL has passed, without a sweeper on the critical path. Production systems still run a sweeper, from keyspace notifications or a cron, so an expired hold's units come back even on a sku nobody reserves, and they shard the counters of hot skus so one key does not carry the whole sale.`,
};
