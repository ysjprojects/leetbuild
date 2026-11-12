import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis headroom per sku and hour window',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the guard the publish path asks before a price moves:
\`reserve(sku, current_cents, target_cents)\` compares the change's basis points with \`MAX_MOVE_BP\`,
then \`GET\`s and \`INCRBY\`s a \`guard:{sku}\` counter and returns \`ok\`, \`moved_bp\`, \`headroom_bp\` and
\`bound_cents\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Ten 15 % changes in one hour each pass and compound to four
times the price; two changes that land together both spend the same headroom; one busy hour caps
the sku for good; and a refusal tells the caller neither what is left nor how far it may go.

- The budget is per sku and hour window: one hash \`guard:{sku}:{window}\` (\`window\` is unix time
  \`// WINDOW_S\`, 3600 s) whose \`moved_bp\` field adds up every change in the window. The key
  expires with its window.
- A change fits when the window's \`moved_bp\` plus the change stays within \`MAX_MOVE_BP\` (2000).
- Read, check and spend in **one Lua script** (\`EVAL\`), so no other reservation runs in between.
- A refusal spends nothing and reports \`headroom_bp\` (what the window has left) and
  \`bound_cents\`: the furthest price that headroom allows from \`current_cents\` in the change's
  direction.`,
  sequence: {
    participants: ['Pricing API', 'Redis guard'],
    messages: [
      {
        from: 'Pricing API',
        to: 'Redis guard',
        label: 'EVAL RESERVE_LUA guard:SKU-1:{window} · 1500 bp · limit 2000',
        kind: 'sync',
      },
      {from: 'Redis guard', to: 'Pricing API', label: '{1, 2000}: spent, 500 left', kind: 'reply'},
      {from: 'Pricing API', to: 'Redis guard', label: 'EVAL RESERVE_LUA guard:SKU-1:{window} · 1500 bp', kind: 'sync'},
      {
        from: 'Redis guard',
        to: 'Pricing API',
        label: '{0, 500}: refused · headroom_bp 500 · bound_cents',
        kind: 'reply',
      },
      {from: 'Redis guard', to: 'Redis guard', label: 'EXPIRE at the end of the window', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'shared-headroom',
      title: 'The window adds up every change',
      detail:
        "A change is judged against the window's accumulated `moved_bp` (read with `HGET` in the script), not alone: two 15 % changes in one window do not both fit 20 %. The starter compares each change with `MAX_MOVE_BP` by itself.",
      match: {
        python: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/\bmove\s*>\s*MAX_MOVE_BP\b/]},
        typescript: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/\bmove\s*>\s*MAX_MOVE_BP\b/]},
        go: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/\bmove\s*>\s*maxMoveBP\b/]},
        scala: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/\bmove\s*>\s*MaxMoveBp\b/]},
        cpp: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/\bmove\s*>\s*kMaxMoveBp\b/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Headroom is read, checked and spent in one script',
      detail:
        'One Lua script (`EVAL`) reads the window, compares and `HINCRBY`s it on the server. The starter reads with `GET` and writes with `INCRBY` from the client, so a reservation that lands in between spends headroom the first one already counted.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\br\.(get|incrby|hget|hincrby)\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/redis\.(get|incrby|hget|hincrby)\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/rdb\.(Get|IncrBy|HGet|HIncrBy)\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/jedis\.(get|incrBy|hget|hincrBy)\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/redis\.(get|incrby|hget|hincrby)\(/],
        },
      },
    },
    {
      id: 'window-expiry',
      title: 'The budget is per hour window and expires',
      detail:
        'The key carries the window (`guard:{sku}:{window}`, `window = unix time // WINDOW_S`) and the script sets `EXPIRE` on the write that created it. The starter keeps one `guard:{sku}` counter with no TTL, so a busy hour caps the sku for good.',
      match: {
        python: {all: [/WINDOW_S\s*=\s*3600/, /\/\/\s*WINDOW_S/, /redis\.call\(\s*['"]P?EXPIRE['"]/]},
        typescript: {all: [/WINDOW_S\s*=\s*3600/, /\/\s*WINDOW_S/, /redis\.call\(\s*['"]P?EXPIRE['"]/]},
        go: {all: [/windowS\s*=\s*3600/, /\/\s*windowS/, /redis\.call\(\s*['"]P?EXPIRE['"]/]},
        scala: {all: [/WindowS\s*=\s*3600/, /\/\s*WindowS/, /redis\.call\(\s*['"]P?EXPIRE['"]/]},
        cpp: {all: [/kWindowS\s*=\s*3600/, /\/\s*kWindowS/, /redis\.call\(\s*['"]P?EXPIRE['"]/]},
      },
    },
    {
      id: 'refusal-bound',
      title: 'A refusal reports the headroom and the bound',
      detail:
        "A refused change spends nothing and answers `headroom_bp`, what the window has left, and `bound_cents`, the furthest price that allows from `current_cents` in the change's direction. The starter refuses with both at zero.",
      match: {
        python: {all: [/bound_cents\(/], none: [/["']headroom_bp["']\s*:\s*0\b/]},
        typescript: {all: [/boundCents\(/], none: [/headroom_bp:\s*0\b/]},
        go: {all: [/boundCents\(/], none: [/Reservation\{OK:\s*false,\s*MovedBP:\s*move\}/]},
        scala: {all: [/boundCents\(/], none: [/Reservation\(\s*false,\s*move,\s*0L?,\s*0L?\s*\)/]},
        cpp: {all: [/boundCents\(/], none: [/Reservation\{\s*false,\s*move,\s*0,\s*0\s*\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_MOVE_BP = 2000


def move_bp(current_cents: int, target_cents: int) -> int:
    """The change in basis points of the current price (100 bp = 1 %)."""
    return abs(target_cents - current_cents) * 10_000 // current_cents


def reserve(sku: str, current_cents: int, target_cents: int) -> dict:
    """Spend the change's basis points from the sku's budget or refuse it: ok, moved_bp (this change), headroom_bp (left afterwards), bound_cents."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"guard:{sku}"
    move = move_bp(current_cents, target_cents)
    moved = int(r.get(key) or 0)
    if move > MAX_MOVE_BP:
        return {"ok": False, "moved_bp": move, "headroom_bp": 0, "bound_cents": 0}
    r.incrby(key, move)
    return {"ok": True, "moved_bp": move, "headroom_bp": MAX_MOVE_BP - moved - move, "bound_cents": target_cents}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 3600
MAX_MOVE_BP = 2000

# KEYS[1] the window's hash; ARGV: the change's basis points, the limit, the window's TTL.
# Returns {1 spent | 0 refused, the basis points the window had available before this change}.
RESERVE_LUA = """
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
"""
reserve_headroom = r.register_script(RESERVE_LUA)


def guard_key(sku: str, window: int) -> str:
    return f"guard:{sku}:{window}"


def move_bp(current_cents: int, target_cents: int) -> int:
    """The change in basis points of the current price (100 bp = 1 %)."""
    return abs(target_cents - current_cents) * 10_000 // current_cents


def bound_cents(current_cents: int, target_cents: int, available_bp: int) -> int:
    """The furthest price available_bp allows from current_cents, in the direction of target_cents."""
    delta = current_cents * available_bp // 10_000
    return current_cents + delta if target_cents >= current_cents else current_cents - delta


def reserve(sku: str, current_cents: int, target_cents: int) -> dict:
    """Spend the change's basis points from the sku's budget or refuse it: ok, moved_bp (this change), headroom_bp (left afterwards), bound_cents."""
    move = move_bp(current_cents, target_cents)
    window = int(time.time()) // WINDOW_S
    # Read, check and spend on the server: no other reservation runs between the read and the write.
    ok, available = reserve_headroom(keys=[guard_key(sku, window)], args=[move, MAX_MOVE_BP, WINDOW_S])
    return {
        "ok": ok == 1,
        "moved_bp": move,
        "headroom_bp": available - move if ok == 1 else available,
        "bound_cents": bound_cents(current_cents, target_cents, available),
    }
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_MOVE_BP = 2000;

export interface Reservation {
  ok: boolean;
  moved_bp: number;
  headroom_bp: number;
  bound_cents: number;
}

/** The change in basis points of the current price (100 bp = 1 %). */
export const moveBp = (currentCents: number, targetCents: number): number =>
  Math.floor((Math.abs(targetCents - currentCents) * 10_000) / currentCents);

/** Spend the change's basis points from the sku's budget or refuse it. */
export async function reserve(sku: string, currentCents: number, targetCents: number): Promise<Reservation> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`guard:\${sku}\`;
  const move = moveBp(currentCents, targetCents);
  const moved = Number((await redis.get(key)) ?? 0);
  if (move > MAX_MOVE_BP) return {ok: false, moved_bp: move, headroom_bp: 0, bound_cents: 0};
  await redis.incrby(key, move);
  return {ok: true, moved_bp: move, headroom_bp: MAX_MOVE_BP - moved - move, bound_cents: targetCents};
}
`,
      solution: `import Redis from 'ioredis';

export const WINDOW_S = 3600;
export const MAX_MOVE_BP = 2000;

/**
 * KEYS[1] the window's hash; ARGV: the change's basis points, the limit, the window's TTL. Returns
 * {1 spent | 0 refused, the basis points the window had available before this change}.
 */
export const RESERVE_LUA = \`
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
\`;

interface GuardRedis extends Redis {
  reserveHeadroom(key: string, move: number, limit: number, ttl: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as GuardRedis;
redis.defineCommand('reserveHeadroom', {numberOfKeys: 1, lua: RESERVE_LUA});

export interface Reservation {
  ok: boolean;
  moved_bp: number;
  headroom_bp: number;
  bound_cents: number;
}

export const guardKey = (sku: string, window: number): string => \`guard:\${sku}:\${window}\`;

/** The change in basis points of the current price (100 bp = 1 %). */
export const moveBp = (currentCents: number, targetCents: number): number =>
  Math.floor((Math.abs(targetCents - currentCents) * 10_000) / currentCents);

/** The furthest price availableBp allows from currentCents, in the direction of targetCents. */
export function boundCents(currentCents: number, targetCents: number, availableBp: number): number {
  const delta = Math.floor((currentCents * availableBp) / 10_000);
  return targetCents >= currentCents ? currentCents + delta : currentCents - delta;
}

/** Spend the change's basis points from the sku's budget or refuse it. */
export async function reserve(sku: string, currentCents: number, targetCents: number): Promise<Reservation> {
  const move = moveBp(currentCents, targetCents);
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  // Read, check and spend on the server: no other reservation runs between the read and the write.
  const [ok, available] = await redis.reserveHeadroom(guardKey(sku, window), move, MAX_MOVE_BP, WINDOW_S);
  return {
    ok: ok === 1,
    moved_bp: move,
    headroom_bp: ok === 1 ? available - move : available,
    bound_cents: boundCents(currentCents, targetCents, available),
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const maxMoveBP = 2000

// Reservation is the outcome of reserve: MovedBP is this change, HeadroomBP what is left afterwards.
type Reservation struct {
	OK         bool  \`json:"ok"\`
	MovedBP    int64 \`json:"moved_bp"\`
	HeadroomBP int64 \`json:"headroom_bp"\`
	BoundCents int64 \`json:"bound_cents"\`
}

// moveBP is the change in basis points of the current price (100 bp = 1 %).
func moveBP(currentCents, targetCents int64) int64 {
	delta := targetCents - currentCents
	if delta < 0 {
		delta = -delta
	}
	return delta * 10_000 / currentCents
}

// reserve spends the change's basis points from the sku's budget or refuses it.
func reserve(ctx context.Context, sku string, currentCents, targetCents int64) (Reservation, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "guard:" + sku
	move := moveBP(currentCents, targetCents)
	moved, err := rdb.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return Reservation{}, err
	}
	if move > maxMoveBP {
		return Reservation{OK: false, MovedBP: move}, nil
	}
	if err := rdb.IncrBy(ctx, key, move).Err(); err != nil {
		return Reservation{}, err
	}
	return Reservation{OK: true, MovedBP: move, HeadroomBP: maxMoveBP - moved - move, BoundCents: targetCents}, nil
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

const (
	windowS   = 3600
	maxMoveBP = 2000
)

// reserveHeadroom: KEYS[1] the window's hash; ARGV the change's basis points, the limit, the
// window's TTL. Returns {1 spent | 0 refused, the basis points the window had available before}.
var reserveHeadroom = redis.NewScript(\`
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
\`)

// Reservation is the outcome of reserve: MovedBP is this change, HeadroomBP what is left afterwards.
type Reservation struct {
	OK         bool  \`json:"ok"\`
	MovedBP    int64 \`json:"moved_bp"\`
	HeadroomBP int64 \`json:"headroom_bp"\`
	BoundCents int64 \`json:"bound_cents"\`
}

func guardKey(sku string, window int64) string {
	return fmt.Sprintf("guard:%s:%d", sku, window)
}

// moveBP is the change in basis points of the current price (100 bp = 1 %).
func moveBP(currentCents, targetCents int64) int64 {
	delta := targetCents - currentCents
	if delta < 0 {
		delta = -delta
	}
	return delta * 10_000 / currentCents
}

// boundCents is the furthest price availableBP allows from currentCents, in the direction of targetCents.
func boundCents(currentCents, targetCents, availableBP int64) int64 {
	delta := currentCents * availableBP / 10_000
	if targetCents >= currentCents {
		return currentCents + delta
	}
	return currentCents - delta
}

// reserve spends the change's basis points from the sku's budget or refuses it.
func reserve(ctx context.Context, sku string, currentCents, targetCents int64) (Reservation, error) {
	move := moveBP(currentCents, targetCents)
	window := time.Now().Unix() / windowS
	// Read, check and spend on the server: no other reservation runs between the read and the write.
	out, err := reserveHeadroom.Run(ctx, rdb, []string{guardKey(sku, window)}, move, maxMoveBP, windowS).Int64Slice()
	if err != nil {
		return Reservation{}, err
	}
	ok, available := out[0] == 1, out[1]
	headroom := available
	if ok {
		headroom = available - move
	}
	return Reservation{OK: ok, MovedBP: move, HeadroomBP: headroom, BoundCents: boundCents(currentCents, targetCents, available)}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  /** The outcome of reserve: movedBp is this change, headroomBp what is left afterwards. */
  final case class Reservation(ok: Boolean, movedBp: Long, headroomBp: Long, boundCents: Long)

  val jedis = new JedisPooled("redis", 6379)

  val MaxMoveBp = 2000L

  /** The change in basis points of the current price (100 bp = 1 %). */
  def moveBp(currentCents: Long, targetCents: Long): Long = math.abs(targetCents - currentCents) * 10000 / currentCents

  /** Spend the change's basis points from the sku's budget or refuse it. */
  def reserve(sku: String, currentCents: Long, targetCents: Long): Reservation = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"guard:$sku"
    val move = moveBp(currentCents, targetCents)
    val moved = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (move > MaxMoveBp) Reservation(false, move, 0L, 0L)
    else {
      jedis.incrBy(key, move)
      Reservation(true, move, MaxMoveBp - moved - move, targetCents)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  /** The outcome of reserve: movedBp is this change, headroomBp what is left afterwards. */
  final case class Reservation(ok: Boolean, movedBp: Long, headroomBp: Long, boundCents: Long)

  val jedis = new JedisPooled("redis", 6379)

  val WindowS = 3600L
  val MaxMoveBp = 2000L

  /** KEYS[1] the window's hash; ARGV the change's basis points, the limit, the window's TTL. Returns {1 spent | 0 refused, the basis points available before this change}. */
  val ReserveLua: String =
    """local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
      |local available = tonumber(ARGV[2]) - moved
      |local move = tonumber(ARGV[1])
      |if move > available then
      |  return {0, available}
      |end
      |redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |return {1, available}
      |""".stripMargin

  def guardKey(sku: String, window: Long): String = s"guard:$sku:$window"

  /** The change in basis points of the current price (100 bp = 1 %). */
  def moveBp(currentCents: Long, targetCents: Long): Long = math.abs(targetCents - currentCents) * 10000 / currentCents

  /** The furthest price availableBp allows from currentCents, in the direction of targetCents. */
  def boundCents(currentCents: Long, targetCents: Long, availableBp: Long): Long = {
    val delta = currentCents * availableBp / 10000
    if (targetCents >= currentCents) currentCents + delta else currentCents - delta
  }

  /** Spend the change's basis points from the sku's budget or refuse it. */
  def reserve(sku: String, currentCents: Long, targetCents: Long): Reservation = {
    val move = moveBp(currentCents, targetCents)
    val window = System.currentTimeMillis() / 1000 / WindowS
    // Read, check and spend on the server: no other reservation runs between the read and the write.
    val out = jedis.eval(ReserveLua, List(guardKey(sku, window)).asJava, List(move.toString, MaxMoveBp.toString, WindowS.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    val ok = out.head == 1L
    val available = out(1)
    Reservation(ok, move, if (ok) available - move else available, boundCents(currentCents, targetCents, available))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kMaxMoveBp = 2000;

// The outcome of reserve: moved_bp is this change, headroom_bp what is left afterwards.
struct Reservation {
  bool ok = false;
  long long moved_bp = 0;
  long long headroom_bp = 0;
  long long bound_cents = 0;
};

// The change in basis points of the current price (100 bp = 1 %).
long long moveBp(long long current_cents, long long target_cents) {
  const long long delta = target_cents > current_cents ? target_cents - current_cents : current_cents - target_cents;
  return delta * 10000 / current_cents;
}

// Spend the change's basis points from the sku's budget or refuse it.
Reservation reserve(const std::string& sku, long long current_cents, long long target_cents) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "guard:" + sku;
  const long long move = moveBp(current_cents, target_cents);
  const auto raw = redis.get(key);
  const long long moved = raw ? std::stoll(*raw) : 0;
  if (move > kMaxMoveBp) return Reservation{false, move, 0, 0};
  redis.incrby(key, move);
  return Reservation{true, move, kMaxMoveBp - moved - move, target_cents};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowS = 3600;
constexpr long long kMaxMoveBp = 2000;

// KEYS[1] the window's hash; ARGV the change's basis points, the limit, the window's TTL. Returns
// {1 spent | 0 refused, the basis points the window had available before this change}.
const std::string kReserveLua = R"lua(
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
)lua";

// The outcome of reserve: moved_bp is this change, headroom_bp what is left afterwards.
struct Reservation {
  bool ok = false;
  long long moved_bp = 0;
  long long headroom_bp = 0;
  long long bound_cents = 0;
};

std::string guardKey(const std::string& sku, long long window) { return "guard:" + sku + ":" + std::to_string(window); }

// The change in basis points of the current price (100 bp = 1 %).
long long moveBp(long long current_cents, long long target_cents) {
  const long long delta = target_cents > current_cents ? target_cents - current_cents : current_cents - target_cents;
  return delta * 10000 / current_cents;
}

// The furthest price available_bp allows from current_cents, in the direction of target_cents.
long long boundCents(long long current_cents, long long target_cents, long long available_bp) {
  const long long delta = current_cents * available_bp / 10000;
  return target_cents >= current_cents ? current_cents + delta : current_cents - delta;
}

// Spend the change's basis points from the sku's budget or refuse it.
Reservation reserve(const std::string& sku, long long current_cents, long long target_cents) {
  const long long move = moveBp(current_cents, target_cents);
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long window = now / kWindowS;
  // Read, check and spend on the server: no other reservation runs between the read and the write.
  std::vector<long long> out;
  redis.eval(kReserveLua, {guardKey(sku, window)}, {std::to_string(move), std::to_string(kMaxMoveBp), std::to_string(kWindowS)},
             std::back_inserter(out));
  const bool ok = out.at(0) == 1;
  const long long available = out.at(1);
  return Reservation{ok, move, ok ? available - move : available, boundCents(current_cents, target_cents, available)};
}
`,
    },
  },
  harness: {
    python: `def _key(ctx, sku="SKU-1"):
    return f"guard:{sku}:{int(ctx.clock.time()) // 3600}"


def check_shared_headroom(ctx):
    m = ctx.load("state")
    first = m.reserve("SKU-1", 1000, 1150)
    assert first["ok"] is True and first["headroom_bp"] == 500, f"the first 15 % change in an empty window answered {first}, expected ok with headroom_bp 500"
    second = m.reserve("SKU-1", 1000, 1150)
    assert second["ok"] is False, f"a second 15 % change in the same window answered {second}: two changes that each fit 20 % moved the price 30 % in one hour. The window's budget is shared"
    third = m.reserve("SKU-1", 1000, 1050)
    assert third["ok"] is True and third["headroom_bp"] == 0, f"a 5 % change that fits the 500 bp left answered {third}, expected ok with headroom_bp 0"


def check_atomic_reserve(ctx):
    m = ctx.load("state")
    # A second reservation lands right after this one's first command on the guard key.
    probes = [ctx.redis_after(key, lambda: m.reserve("SKU-1", 1000, 1150)) for key in ("guard:SKU-1", _key(ctx))]
    mine = m.reserve("SKU-1", 1000, 1150)
    fired = [p for p in probes if p.fired]
    assert fired, f"the reservation touched neither guard:SKU-1 nor {_key(ctx)}"
    if fired[0].error is not None:
        raise fired[0].error
    rival = fired[0].result
    oks = [mine["ok"], rival["ok"]]
    assert oks.count(True) == 1, f"two 15 % changes raced for one window and answered ok={oks[1]} (the one that landed in between) and ok={oks[0]}: only one fits a 20 % budget. Read, check and spend in one script"
    spent = ctx.redis.hget(_key(ctx), "moved_bp")
    assert spent == "1500", f"{_key(ctx)} records moved_bp {spent!r} after the race, expected 1500"


def check_window_expiry(ctx):
    m = ctx.load("state")
    assert m.reserve("SKU-1", 1000, 1150)["ok"] is True, "a 15 % change in an empty window must fit"
    key = _key(ctx)
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 3600, f"{key} has TTL {ttl} (guard keys: {sorted(ctx.redis.keys('guard:*'))}): the budget lives in one key per sku and hour window, and the key expires with its window"
    ctx.clock.advance(3600)
    later = m.reserve("SKU-1", 1000, 1150)
    assert later["ok"] is True and later["headroom_bp"] == 500, f"a 15 % change in the next hour answered {later}: the new window starts with the whole 2000 bp"
    assert ctx.redis.hget(_key(ctx), "moved_bp") == "1500", f"the new window {_key(ctx)} records {ctx.redis.hget(_key(ctx), 'moved_bp')!r}, expected 1500"


def check_refusal_bound(ctx):
    m = ctx.load("state")
    big = m.reserve("SKU-1", 1000, 1300)
    assert big["ok"] is False, f"a 30 % rise answered {big}, expected a refusal"
    assert big["headroom_bp"] == 2000 and big["bound_cents"] == 1200, f"a refused 30 % rise in an empty window answered {big}, expected headroom_bp 2000 and bound_cents 1200"
    assert m.reserve("SKU-1", 1000, 1150)["ok"] is True, "a 15 % change after a refusal must fit: a refusal spends nothing"
    cut = m.reserve("SKU-1", 1000, 900)
    assert cut["ok"] is False and cut["headroom_bp"] == 500 and cut["bound_cents"] == 950, f"a 10 % cut with 500 bp left answered {cut}, expected a refusal with headroom_bp 500 and bound_cents 950"
`,
    typescript: `const keyOf = (ctx, sku = 'SKU-1') => \`guard:\${sku}:\${Math.floor(ctx.clock.now() / 1000 / 3600)}\`;

export async function check_shared_headroom(ctx) {
  const m = ctx.load('state');
  const first = await m.reserve('SKU-1', 1000, 1150);
  assert(first.ok === true && first.headroom_bp === 500, \`the first 15 % change in an empty window answered \${JSON.stringify(first)}, expected ok with headroom_bp 500\`);
  const second = await m.reserve('SKU-1', 1000, 1150);
  assert.equal(second.ok, false, \`a second 15 % change in the same window answered \${JSON.stringify(second)}: two changes that each fit 20 % moved the price 30 % in one hour. The window's budget is shared\`);
  const third = await m.reserve('SKU-1', 1000, 1050);
  assert(third.ok === true && third.headroom_bp === 0, \`a 5 % change that fits the 500 bp left answered \${JSON.stringify(third)}, expected ok with headroom_bp 0\`);
}

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('state');
  // A second reservation lands right after this one's first command on the guard key.
  const probes = ['guard:SKU-1', keyOf(ctx)].map(key => ctx.redisAfter(key, () => m.reserve('SKU-1', 1000, 1150)));
  const mine = await m.reserve('SKU-1', 1000, 1150);
  const fired = probes.filter(p => p.fired);
  assert(fired.length > 0, \`the reservation touched neither guard:SKU-1 nor \${keyOf(ctx)}\`);
  if (fired[0].error !== undefined) throw fired[0].error;
  const rival = await fired[0].result;
  const oks = [mine.ok, rival.ok];
  assert.equal(oks.filter(Boolean).length, 1, \`two 15 % changes raced for one window and answered ok=\${oks[1]} (the one that landed in between) and ok=\${oks[0]}: only one fits a 20 % budget. Read, check and spend in one script\`);
  const spent = ctx.redis.hget(keyOf(ctx), 'moved_bp');
  assert.equal(spent, '1500', \`\${keyOf(ctx)} records moved_bp \${JSON.stringify(spent)} after the race, expected 1500\`);
}

export async function check_window_expiry(ctx) {
  const m = ctx.load('state');
  assert.equal((await m.reserve('SKU-1', 1000, 1150)).ok, true, 'a 15 % change in an empty window must fit');
  const key = keyOf(ctx);
  const ttl = ctx.redis.ttl(key);
  assert(ttl > 0 && ttl <= 3600, \`\${key} has TTL \${ttl} (guard keys: \${JSON.stringify(ctx.redis.keys('guard:*'))}): the budget lives in one key per sku and hour window, and the key expires with its window\`);
  ctx.clock.advance(3600);
  const later = await m.reserve('SKU-1', 1000, 1150);
  assert(later.ok === true && later.headroom_bp === 500, \`a 15 % change in the next hour answered \${JSON.stringify(later)}: the new window starts with the whole 2000 bp\`);
  assert.equal(ctx.redis.hget(keyOf(ctx), 'moved_bp'), '1500', \`the new window \${keyOf(ctx)} must record 1500\`);
}

export async function check_refusal_bound(ctx) {
  const m = ctx.load('state');
  const big = await m.reserve('SKU-1', 1000, 1300);
  assert.equal(big.ok, false, \`a 30 % rise answered \${JSON.stringify(big)}, expected a refusal\`);
  assert(big.headroom_bp === 2000 && big.bound_cents === 1200, \`a refused 30 % rise in an empty window answered \${JSON.stringify(big)}, expected headroom_bp 2000 and bound_cents 1200\`);
  assert.equal((await m.reserve('SKU-1', 1000, 1150)).ok, true, 'a 15 % change after a refusal must fit: a refusal spends nothing');
  const cut = await m.reserve('SKU-1', 1000, 900);
  assert(cut.ok === false && cut.headroom_bp === 500 && cut.bound_cents === 950, \`a 10 % cut with 500 bp left answered \${JSON.stringify(cut)}, expected a refusal with headroom_bp 500 and bound_cents 950\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateKey(ctx *harness.Ctx) string {
	return fmt.Sprintf("guard:SKU-1:%d", ctx.Clock.Now()/1000/3600)
}

func mustReserve(ctx *harness.Ctx, current, target int64) Reservation {
	res, err := reserve(stateBg, "SKU-1", current, target)
	ctx.NoError(err, "reserve(SKU-1, %d, %d) failed", current, target)
	return res
}

func CheckSharedHeadroom(ctx *harness.Ctx) {
	first := mustReserve(ctx, 1000, 1150)
	ctx.Assert(first.OK && first.HeadroomBP == 500, "the first 15 %% change in an empty window answered %+v, expected ok with headroom_bp 500", first)
	second := mustReserve(ctx, 1000, 1150)
	ctx.Assert(!second.OK, "a second 15 %% change in the same window answered %+v: two changes that each fit 20 %% moved the price 30 %% in one hour. The window's budget is shared", second)
	third := mustReserve(ctx, 1000, 1050)
	ctx.Assert(third.OK && third.HeadroomBP == 0, "a 5 %% change that fits the 500 bp left answered %+v, expected ok with headroom_bp 0", third)
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	// A second reservation lands right after this one's first command on the guard key.
	var rivals []Reservation
	for _, key := range []string{"guard:SKU-1", stateKey(ctx)} {
		ctx.Redis.After(key, func() any {
			res, err := reserve(stateBg, "SKU-1", 1000, 1150)
			ctx.NoError(err, "the rival reservation failed")
			rivals = append(rivals, res)
			return nil
		})
	}
	mine := mustReserve(ctx, 1000, 1150)
	ctx.Assert(len(rivals) > 0, "the reservation touched neither guard:SKU-1 nor %s", stateKey(ctx))
	ctx.Assert(mine.OK != rivals[0].OK, "two 15 %% changes raced for one window and answered ok=%v (the one that landed in between) and ok=%v: only one fits a 20 %% budget. Read, check and spend in one script", rivals[0].OK, mine.OK)
	spent, _ := ctx.Redis.HGet(stateKey(ctx), "moved_bp")
	ctx.Equal(spent, "1500", "%s after the race; moved_bp", stateKey(ctx))
}

func CheckWindowExpiry(ctx *harness.Ctx) {
	ctx.Assert(mustReserve(ctx, 1000, 1150).OK, "a 15 %% change in an empty window must fit")
	key := stateKey(ctx)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl > 0 && ttl <= 3600, "%s has TTL %d (guard keys: %q): the budget lives in one key per sku and hour window, and the key expires with its window", key, ttl, ctx.Redis.Keys("guard:*"))
	ctx.Clock.Advance(3600)
	later := mustReserve(ctx, 1000, 1150)
	ctx.Assert(later.OK && later.HeadroomBP == 500, "a 15 %% change in the next hour answered %+v: the new window starts with the whole 2000 bp", later)
	spent, _ := ctx.Redis.HGet(stateKey(ctx), "moved_bp")
	ctx.Equal(spent, "1500", "the new window %s; moved_bp", stateKey(ctx))
}

func CheckRefusalBound(ctx *harness.Ctx) {
	big := mustReserve(ctx, 1000, 1300)
	ctx.Assert(!big.OK, "a 30 %% rise answered %+v, expected a refusal", big)
	ctx.Assert(big.HeadroomBP == 2000 && big.BoundCents == 1200, "a refused 30 %% rise in an empty window answered %+v, expected headroom_bp 2000 and bound_cents 1200", big)
	ctx.Assert(mustReserve(ctx, 1000, 1150).OK, "a 15 %% change after a refusal must fit: a refusal spends nothing")
	cut := mustReserve(ctx, 1000, 900)
	ctx.Assert(!cut.OK && cut.HeadroomBP == 500 && cut.BoundCents == 950, "a 10 %% cut with 500 bp left answered %+v, expected a refusal with headroom_bp 500 and bound_cents 950", cut)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

std::string stateKey(harness::Ctx& ctx) { return "guard:SKU-1:" + std::to_string(ctx.Clock.Now() / 1000 / 3600); }

std::string text(const Reservation& r) {
  return "{ok: " + std::string(r.ok ? "true" : "false") + ", moved_bp: " + std::to_string(r.moved_bp) +
         ", headroom_bp: " + std::to_string(r.headroom_bp) + ", bound_cents: " + std::to_string(r.bound_cents) + "}";
}

struct Rival {
  bool fired = false;
  std::optional<Reservation> result;
  std::optional<std::string> err;
};

}  // namespace

void CheckSharedHeadroom(harness::Ctx& ctx) {
  const Reservation first = reserve("SKU-1", 1000, 1150);
  ctx.Assert(first.ok && first.headroom_bp == 500, "the first 15 %% change in an empty window answered %s, expected ok with headroom_bp 500", text(first));
  const Reservation second = reserve("SKU-1", 1000, 1150);
  ctx.Assert(!second.ok, "a second 15 %% change in the same window answered %s: two changes that each fit 20 %% moved the price 30 %% in one hour. The window's budget is shared", text(second));
  const Reservation third = reserve("SKU-1", 1000, 1050);
  ctx.Assert(third.ok && third.headroom_bp == 0, "a 5 %% change that fits the 500 bp left answered %s, expected ok with headroom_bp 0", text(third));
}

void CheckAtomicReserve(harness::Ctx& ctx) {
  // A second reservation lands right after this one's first command on the guard key.
  auto rival = std::make_shared<Rival>();
  for (const std::string& key : {std::string("guard:SKU-1"), stateKey(ctx)}) {
    ctx.Redis.After(key, [rival] {
      if (rival->fired) return;
      rival->fired = true;
      try {
        rival->result = reserve("SKU-1", 1000, 1150);
      } catch (const std::exception& e) {
        rival->err = e.what();
      }
    });
  }
  const Reservation mine = reserve("SKU-1", 1000, 1150);
  ctx.Assert(rival->fired, "the reservation touched neither guard:SKU-1 nor %s", stateKey(ctx));
  ctx.Assert(!rival->err, "the rival reservation failed: %s", rival->err.value_or(""));
  ctx.Assert(mine.ok != rival->result->ok, "two 15 %% changes raced for one window and answered ok=%t (the one that landed in between) and ok=%t: only one fits a 20 %% budget. Read, check and spend in one script", rival->result->ok, mine.ok);
  ctx.Equal(ctx.Redis.HGet(stateKey(ctx), "moved_bp"), std::optional<std::string>("1500"), "%s after the race; moved_bp", stateKey(ctx));
}

void CheckWindowExpiry(harness::Ctx& ctx) {
  ctx.Assert(reserve("SKU-1", 1000, 1150).ok, "a 15 %% change in an empty window must fit");
  const std::string key = stateKey(ctx);
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl > 0 && ttl <= 3600, "%s has TTL %d (guard keys: %q): the budget lives in one key per sku and hour window, and the key expires with its window", key, ttl, ctx.Redis.Keys("guard:*"));
  ctx.Clock.Advance(3600);
  const Reservation later = reserve("SKU-1", 1000, 1150);
  ctx.Assert(later.ok && later.headroom_bp == 500, "a 15 %% change in the next hour answered %s: the new window starts with the whole 2000 bp", text(later));
  ctx.Equal(ctx.Redis.HGet(stateKey(ctx), "moved_bp"), std::optional<std::string>("1500"), "the new window %s; moved_bp", stateKey(ctx));
}

void CheckRefusalBound(harness::Ctx& ctx) {
  const Reservation big = reserve("SKU-1", 1000, 1300);
  ctx.Assert(!big.ok, "a 30 %% rise answered %s, expected a refusal", text(big));
  ctx.Assert(big.headroom_bp == 2000 && big.bound_cents == 1200, "a refused 30 %% rise in an empty window answered %s, expected headroom_bp 2000 and bound_cents 1200", text(big));
  ctx.Assert(reserve("SKU-1", 1000, 1150).ok, "a 15 %% change after a refusal must fit: a refusal spends nothing");
  const Reservation cut = reserve("SKU-1", 1000, 900);
  ctx.Assert(!cut.ok && cut.headroom_bp == 500 && cut.bound_cents == 950, "a 10 %% cut with 500 bp left answered %s, expected a refusal with headroom_bp 500 and bound_cents 950", text(cut));
}
`,
  },
  hints: [
    'Reserve a 15 % change twice for one sku in the same hour: both answer ok, so the price moved 30 % against a 20 % limit. A refused 30 % change comes back with no headroom and no bound.',
    'The starter judges each change alone against `MAX_MOVE_BP` and spends with an `INCRBY` after a separate `GET`, so another reservation can run in between; `guard:{sku}` has no window in its name and no TTL.',
    'One `RESERVE_LUA` on `guard:{sku}:{window}`: `HGET moved_bp`, return `{0, available}` when the change exceeds it, else `HINCRBY` and `EXPIRE` on the first write; derive `headroom_bp` and `bound_cents` from `available`.',
  ],
  debrief: `A window budget is shared state, and shared state read, judged and written from the client is a race: the script makes the three one step on the server, so the second of two concurrent reservations sees the first one's spend. The window lives in the key name rather than in a reset job, so it expires on its own and nothing has to run on time to reopen it. Reporting the headroom on a refusal lets the caller propose a smaller change instead of retrying blind. A fixed hour still allows 40 % across a boundary (20 % at 10:59, 20 % at 11:01); guardrails that must hold tighter use a sliding window or a decaying budget, and often keep separate room for rises and cuts.`,
};
