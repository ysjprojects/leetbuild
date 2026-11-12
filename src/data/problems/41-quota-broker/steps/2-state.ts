import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis ledger: one script per take and per refund',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['broker', 'redis'],
  task: `## Task

**Starting point.** The starter is the ledger the reserve path writes. \`reserve(team, window,
resource_class, amount, source_version)\` reads \`reserved\` and \`consumed\` from the hash
\`quota:{team}\` with two \`HGET\`s, compares them plus the amount with \`limit_of(team)\` (provided in
\`quota.ledger\`), \`HINCRBY\`s \`reserved\` and writes \`reservation:{team}:{reservation_id}\`.
\`release(team, reservation_id)\` reads that record, decrements \`quota:{team}\` and deletes the record.
It serves the demo and hides four flaws.

**Failure mode the checks target.** Two brokers that both read \`reserved = 0\` grant 6 of 8 units
each; a team's 14:00 jobs spend its 15:00 quota; the ledger keeps every window it ever served; and a
retried release refunds the same units twice.

- One hash per window: \`quota:{team}:{window}\` with \`limit\`, \`reserved\` and \`consumed\`.
- \`reserve\` reads, compares, increments and records in **one Lua script**, and returns nothing when
  \`reserved + consumed + amount\` exceeds the limit.
- The same script \`EXPIRE\`s the window hash and the reservation after \`TTL_S\` (86400 s).
- \`release\` reads the reservation, refunds the window it recorded and deletes it in **one script**;
  a reservation that is gone reports false.`,
  sequence: {
    participants: ['Broker A', 'Broker B', 'Redis'],
    messages: [
      {from: 'Broker A', to: 'Redis', label: 'EVAL reserve quota:research:14:00 · amount 6 · limit 8', kind: 'sync'},
      {
        from: 'Broker B',
        to: 'Redis',
        label: 'EVAL reserve quota:research:14:00 · amount 6 (waits for A)',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Broker A', label: 'reserved 6 · reservation recorded · EXPIRE 86400', kind: 'reply'},
      {from: 'Redis', to: 'Broker B', label: '0: 6 + 6 > 8, nothing written', kind: 'reply'},
      {from: 'Broker A', to: 'Redis', label: 'EVAL release reservation:research:{id}', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Broker A',
        label: 'refund the recorded window · DEL · 1 (a second release: 0)',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'window-key',
      title: 'Keeps one ledger hash per team and window',
      detail:
        'Reserves land in `quota:{team}:{window}`, so 6 units at 14:00 and 6 at 15:00 both fit an 8-unit limit, and a release refunds the window its reservation recorded; the starter keeps one `quota:{team}` hash for every window.',
      match: {
        python: {all: [/quota:\{team\}:\{window\}/]},
        typescript: {all: [/quota:\$\{team\}:\$\{window\}/]},
        go: {all: [/"quota:"\s*\+\s*team\s*\+\s*":"\s*\+\s*window|"quota:%s:%s"/]},
        scala: {all: [/s"quota:\$team:\$window"/]},
        cpp: {all: [/"quota:"\s*\+\s*team\s*\+\s*":"\s*\+\s*window/]},
      },
    },
    {
      id: 'atomic-take',
      title: 'Compares and takes in one Lua script',
      detail:
        'A second broker reserving 6 of 8 units between this reserve’s read and its write is refused, because the read, the comparison, the `HINCRBY` and the reservation record run as one script; the starter’s `HGET`, compare, `HINCRBY` sequence grants both.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\br\.hincrby\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/redis\.hincrby\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/rdb\.HIncrBy\(/],
        },
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/jedis\.hincrBy\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/redis\.hincrby\(/]},
      },
    },
    {
      id: 'expire-window',
      title: 'Expires the window hash and the reservation',
      detail:
        'The window hash and the reservation carry a TTL between an hour and `TTL_S` (86400 s) after a reserve, set inside the script; the starter sets none, so Redis keeps every window the broker ever served.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /TTL_S/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /TTL_S/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /\bttl\b/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /TtlSeconds/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /kTtlSeconds/]},
      },
    },
    {
      id: 'release-once',
      title: 'Refunds a reservation exactly once',
      detail:
        'Two releases of one reservation that overlap refund it once: one reports true, the other false, and `reserved` returns to 0; the starter reads the record, refunds and deletes in three commands, so both releases refund.',
      match: {
        python: {all: [/redis\.call\(\s*['"]DEL['"]/], none: [/\br\.delete\(/, /\br\.hgetall\(/]},
        typescript: {all: [/redis\.call\(\s*['"]DEL['"]/], none: [/redis\.del\(/, /redis\.hgetall\(/]},
        go: {all: [/redis\.call\(\s*['"]DEL['"]/], none: [/rdb\.Del\(/, /rdb\.HGetAll\(/]},
        scala: {all: [/redis\.call\(\s*['"]DEL['"]/], none: [/jedis\.del\(/, /jedis\.hgetAll\(/]},
        cpp: {all: [/redis\.call\(\s*['"]DEL['"]/], none: [/redis\.del\(/, /redis\.hgetall\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from quota.ledger import limit_of, new_reservation_id

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def reserve(team: str, window: str, resource_class: str, amount: int, source_version: str = "") -> str | None:
    """Take amount units from the team's window; the reservation id, or None when the window cannot cover it."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"quota:{team}"
    used = int(r.hget(key, "reserved") or 0) + int(r.hget(key, "consumed") or 0)
    if used + amount > limit_of(team):
        return None
    r.hincrby(key, "reserved", amount)
    reservation_id = new_reservation_id()
    r.hset(
        f"reservation:{team}:{reservation_id}",
        mapping={"window": window, "resource_class": resource_class, "amount": amount, "source_version": source_version},
    )
    return reservation_id


def release(team: str, reservation_id: str) -> bool:
    """Give a reservation's units back to the window it recorded; False when there is no such reservation."""
    record = r.hgetall(f"reservation:{team}:{reservation_id}")
    if not record:
        return False
    r.hincrby(f"quota:{team}", "reserved", -int(record["amount"]))
    r.delete(f"reservation:{team}:{reservation_id}")
    return True
`,
      solution: `import redis

from quota.ledger import limit_of, new_reservation_id

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 86400  # a day: every window a reservation can name has ended by then

# KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version.
RESERVE_LUA = """
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
"""

# KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window.
RELEASE_LUA = """
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
"""

reserve_script = r.register_script(RESERVE_LUA)
release_script = r.register_script(RELEASE_LUA)


def window_key(team: str, window: str) -> str:
    return f"quota:{team}:{window}"


def reservation_key(team: str, reservation_id: str) -> str:
    return f"reservation:{team}:{reservation_id}"


def reserve(team: str, window: str, resource_class: str, amount: int, source_version: str = "") -> str | None:
    """Take amount units from the team's window; the reservation id, or None when the window cannot cover it."""
    reservation_id = new_reservation_id()
    taken = reserve_script(
        keys=[window_key(team, window), reservation_key(team, reservation_id)],
        args=[amount, limit_of(team), TTL_S, window, resource_class, source_version],
    )
    return reservation_id if taken == 1 else None


def release(team: str, reservation_id: str) -> bool:
    """Give a reservation's units back to the window it recorded; False when there is no such reservation."""
    return release_script(keys=[reservation_key(team, reservation_id)], args=[f"quota:{team}:"]) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {limitOf, newReservationId} from 'quota/ledger';

const redis = new Redis({host: 'redis', port: 6379});

/** Take amount units from the team's window; the reservation id, or null when the window cannot cover it. */
export async function reserve(team: string, window: string, resourceClass: string, amount: number, sourceVersion = ''): Promise<string | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`quota:\${team}\`;
  const used = Number((await redis.hget(key, 'reserved')) ?? 0) + Number((await redis.hget(key, 'consumed')) ?? 0);
  if (used + amount > (await limitOf(team))) return null;
  await redis.hincrby(key, 'reserved', amount);
  const reservationId = newReservationId();
  await redis.hset(\`reservation:\${team}:\${reservationId}\`, {
    window,
    resource_class: resourceClass,
    amount: String(amount),
    source_version: sourceVersion,
  });
  return reservationId;
}

/** Give a reservation's units back to the window it recorded; false when there is no such reservation. */
export async function release(team: string, reservationId: string): Promise<boolean> {
  const record = await redis.hgetall(\`reservation:\${team}:\${reservationId}\`);
  if (Object.keys(record).length === 0) return false;
  await redis.hincrby(\`quota:\${team}\`, 'reserved', -Number(record.amount));
  await redis.del(\`reservation:\${team}:\${reservationId}\`);
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import {limitOf, newReservationId} from 'quota/ledger';

export const TTL_S = 86400; // a day: every window a reservation can name has ended by then

/** KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version. */
export const RESERVE_LUA = \`
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
\`;

/** KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window. */
export const RELEASE_LUA = \`
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
\`;

interface LedgerRedis extends Redis {
  reserveUnits(
    windowKey: string,
    reservationKey: string,
    amount: number,
    limit: number,
    ttl: number,
    window: string,
    resourceClass: string,
    sourceVersion: string,
  ): Promise<number>;
  releaseUnits(reservationKey: string, prefix: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('reserveUnits', {numberOfKeys: 2, lua: RESERVE_LUA});
redis.defineCommand('releaseUnits', {numberOfKeys: 1, lua: RELEASE_LUA});

export const windowKey = (team: string, window: string): string => \`quota:\${team}:\${window}\`;
export const reservationKey = (team: string, reservationId: string): string => \`reservation:\${team}:\${reservationId}\`;

/** Take amount units from the team's window; the reservation id, or null when the window cannot cover it. */
export async function reserve(team: string, window: string, resourceClass: string, amount: number, sourceVersion = ''): Promise<string | null> {
  const reservationId = newReservationId();
  const taken = await redis.reserveUnits(
    windowKey(team, window),
    reservationKey(team, reservationId),
    amount,
    await limitOf(team),
    TTL_S,
    window,
    resourceClass,
    sourceVersion,
  );
  return taken === 1 ? reservationId : null;
}

/** Give a reservation's units back to the window it recorded; false when there is no such reservation. */
export async function release(team: string, reservationId: string): Promise<boolean> {
  return (await redis.releaseUnits(reservationKey(team, reservationId), \`quota:\${team}:\`)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"quota/ledger" // ledger.LimitOf, NewReservationID
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserve takes amount units from the team's window: the reservation id, or "" when the window cannot cover it.
func reserve(ctx context.Context, team, window, resourceClass string, amount int64, sourceVersion string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "quota:" + team
	reserved, _ := rdb.HGet(ctx, key, "reserved").Int64()
	consumed, _ := rdb.HGet(ctx, key, "consumed").Int64()
	if reserved+consumed+amount > ledger.LimitOf(ctx, team) {
		return "", nil
	}
	if err := rdb.HIncrBy(ctx, key, "reserved", amount).Err(); err != nil {
		return "", err
	}
	reservationID := ledger.NewReservationID()
	err := rdb.HSet(ctx, "reservation:"+team+":"+reservationID,
		"window", window, "resource_class", resourceClass, "amount", amount, "source_version", sourceVersion).Err()
	return reservationID, err
}

// release gives a reservation's units back to the window it recorded; false when there is no such reservation.
func release(ctx context.Context, team, reservationID string) (bool, error) {
	key := "reservation:" + team + ":" + reservationID
	record, err := rdb.HGetAll(ctx, key).Result()
	if err != nil || len(record) == 0 {
		return false, err
	}
	amount, _ := strconv.ParseInt(record["amount"], 10, 64)
	if err := rdb.HIncrBy(ctx, "quota:"+team, "reserved", -amount).Err(); err != nil {
		return false, err
	}
	return true, rdb.Del(ctx, key).Err()
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"quota/ledger" // ledger.LimitOf, NewReservationID
)

const ttl = 24 * time.Hour // a day: every window a reservation can name has ended by then

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserveScript: KEYS window hash, reservation; ARGV amount, limit, ttl, window, resource_class, source_version.
var reserveScript = redis.NewScript(\`
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
\`)

// releaseScript: KEYS reservation; ARGV the team's window-key prefix (quota:{team}:). Refunds the recorded window.
var releaseScript = redis.NewScript(\`
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
\`)

func windowKey(team, window string) string { return "quota:" + team + ":" + window }

func reservationKey(team, reservationID string) string {
	return "reservation:" + team + ":" + reservationID
}

// reserve takes amount units from the team's window: the reservation id, or "" when the window cannot cover it.
func reserve(ctx context.Context, team, window, resourceClass string, amount int64, sourceVersion string) (string, error) {
	reservationID := ledger.NewReservationID()
	keys := []string{windowKey(team, window), reservationKey(team, reservationID)}
	taken, err := reserveScript.Run(ctx, rdb, keys, amount, ledger.LimitOf(ctx, team), int64(ttl/time.Second), window, resourceClass, sourceVersion).Int64()
	if err != nil || taken != 1 {
		return "", err
	}
	return reservationID, nil
}

// release gives a reservation's units back to the window it recorded; false when there is no such reservation.
func release(ctx context.Context, team, reservationID string) (bool, error) {
	n, err := releaseScript.Run(ctx, rdb, []string{reservationKey(team, reservationID)}, "quota:"+team+":").Int64()
	return n == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import quota.Ledger // Ledger.limitOf, newReservationId

object State {
  val jedis = new JedisPooled("redis", 6379)

  private def field(key: String, name: String): Long = Option(jedis.hget(key, name)).map(_.toLong).getOrElse(0L)

  /** Take amount units from the team's window; the reservation id, or None when the window cannot cover it. */
  def reserve(team: String, window: String, resourceClass: String, amount: Long, sourceVersion: String = ""): Option[String] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"quota:$team"
    if (field(key, "reserved") + field(key, "consumed") + amount > Ledger.limitOf(team)) None
    else {
      jedis.hincrBy(key, "reserved", amount)
      val reservationId = Ledger.newReservationId()
      jedis.hset(
        s"reservation:$team:$reservationId",
        Map("window" -> window, "resource_class" -> resourceClass, "amount" -> amount.toString, "source_version" -> sourceVersion).asJava
      )
      Some(reservationId)
    }
  }

  /** Give a reservation's units back to the window it recorded; false when there is no such reservation. */
  def release(team: String, reservationId: String): Boolean = {
    val record = jedis.hgetAll(s"reservation:$team:$reservationId").asScala
    if (record.isEmpty) false
    else {
      jedis.hincrBy(s"quota:$team", "reserved", -record("amount").toLong)
      jedis.del(s"reservation:$team:$reservationId")
      true
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import quota.Ledger // Ledger.limitOf, newReservationId

object State {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 86400L // a day: every window a reservation can name has ended by then

  /** KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version. */
  val ReserveLua: String =
    """local amount = tonumber(ARGV[1])
      |local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
      |if used + amount > tonumber(ARGV[2]) then return 0 end
      |redis.call('HSET', KEYS[1], 'limit', ARGV[2])
      |redis.call('HINCRBY', KEYS[1], 'reserved', amount)
      |redis.call('HINCRBY', KEYS[1], 'consumed', 0)
      |redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |redis.call('EXPIRE', KEYS[2], ARGV[3])
      |return 1
      |""".stripMargin

  /** KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window. */
  val ReleaseLua: String =
    """local window = redis.call('HGET', KEYS[1], 'window')
      |if not window then return 0 end
      |redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
      |redis.call('DEL', KEYS[1])
      |return 1
      |""".stripMargin

  def windowKey(team: String, window: String): String = s"quota:$team:$window"
  def reservationKey(team: String, reservationId: String): String = s"reservation:$team:$reservationId"

  /** Take amount units from the team's window; the reservation id, or None when the window cannot cover it. */
  def reserve(team: String, window: String, resourceClass: String, amount: Long, sourceVersion: String = ""): Option[String] = {
    val reservationId = Ledger.newReservationId()
    val keys = List(windowKey(team, window), reservationKey(team, reservationId)).asJava
    val args = List(amount.toString, Ledger.limitOf(team).toString, TtlSeconds.toString, window, resourceClass, sourceVersion).asJava
    if (jedis.eval(ReserveLua, keys, args).asInstanceOf[java.lang.Long] == 1L) Some(reservationId) else None
  }

  /** Give a reservation's units back to the window it recorded; false when there is no such reservation. */
  def release(team: String, reservationId: String): Boolean =
    jedis.eval(ReleaseLua, List(reservationKey(team, reservationId)).asJava, List(s"quota:$team:").asJava).asInstanceOf[java.lang.Long] == 1L
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

#include "quota/ledger.h"  // ledger::limitOf, newReservationId

sw::redis::Redis redis("tcp://redis:6379");

long long field(const std::string& key, const std::string& name) {
  const auto raw = redis.hget(key, name);
  return raw ? std::stoll(*raw) : 0;
}

// Take amount units from the team's window: the reservation id, or none when the window cannot cover it.
std::optional<std::string> reserve(const std::string& team, const std::string& window, const std::string& resource_class,
                                   long long amount, const std::string& source_version = "") {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "quota:" + team;
  if (field(key, "reserved") + field(key, "consumed") + amount > ledger::limitOf(team)) return std::nullopt;
  redis.hincrby(key, "reserved", amount);
  const std::string reservation_id = ledger::newReservationId();
  redis.hset("reservation:" + team + ":" + reservation_id,
             {std::make_pair(std::string("window"), window), std::make_pair(std::string("resource_class"), resource_class),
              std::make_pair(std::string("amount"), std::to_string(amount)), std::make_pair(std::string("source_version"), source_version)});
  return reservation_id;
}

// Give a reservation's units back to the window it recorded; false when there is no such reservation.
bool release(const std::string& team, const std::string& reservation_id) {
  const std::string key = "reservation:" + team + ":" + reservation_id;
  std::unordered_map<std::string, std::string> record;
  redis.hgetall(key, std::inserter(record, record.begin()));
  if (record.empty()) return false;
  redis.hincrby("quota:" + team, "reserved", -std::stoll(record["amount"]));
  redis.del(key);
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "quota/ledger.h"  // ledger::limitOf, newReservationId

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kTtlSeconds = 86400;  // a day: every window a reservation can name has ended by then

// KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version.
const std::string kReserveLua = R"lua(
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
)lua";

// KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window.
const std::string kReleaseLua = R"lua(
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
)lua";

std::string windowKey(const std::string& team, const std::string& window) { return "quota:" + team + ":" + window; }

std::string reservationKey(const std::string& team, const std::string& reservation_id) {
  return "reservation:" + team + ":" + reservation_id;
}

// Take amount units from the team's window: the reservation id, or none when the window cannot cover it.
std::optional<std::string> reserve(const std::string& team, const std::string& window, const std::string& resource_class,
                                   long long amount, const std::string& source_version = "") {
  const std::string reservation_id = ledger::newReservationId();
  const long long taken = redis.eval<long long>(
      kReserveLua, {windowKey(team, window), reservationKey(team, reservation_id)},
      {std::to_string(amount), std::to_string(ledger::limitOf(team)), std::to_string(kTtlSeconds), window, resource_class, source_version});
  if (taken != 1) return std::nullopt;
  return reservation_id;
}

// Give a reservation's units back to the window it recorded; false when there is no such reservation.
bool release(const std::string& team, const std::string& reservation_id) {
  return redis.eval<long long>(kReleaseLua, {reservationKey(team, reservation_id)}, {"quota:" + team + ":"}) == 1;
}
`,
    },
  },
  harness: {
    python: `W1 = "2026-11-02T14:00Z"
W2 = "2026-11-02T15:00Z"


def _reserved(ctx, key):
    return int(ctx.redis.hget(key, "reserved") or 0)


def _ledger_reserved(ctx):
    """The units reserved over every hash the code keeps for team research."""
    return sum(_reserved(ctx, k) for k in ctx.redis.keys("quota:research*") if ctx.redis.type(k) == "hash")


def _settled(probe):
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_window_key(ctx):
    m = ctx.load("state")
    first = m.reserve("research", W1, "gpu-a100", 6)
    assert first, "a reserve of 6 of research's 8 units in an empty window was refused"
    second = m.reserve("research", W2, "gpu-a100", 6)
    assert second, f"a reserve of 6 units in the next window ({W2}) was refused: the 14:00 jobs spent the 15:00 quota (keys: {sorted(ctx.redis.keys('quota:research*'))}). Keep one hash per window"
    assert _reserved(ctx, f"quota:research:{W1}") == 6 and _reserved(ctx, f"quota:research:{W2}") == 6, f"each window's hash must hold reserved 6, Redis holds {sorted(ctx.redis.keys('quota:research*'))}"
    assert m.release("research", first) is True, "releasing the 14:00 reservation must report True"
    assert _reserved(ctx, f"quota:research:{W1}") == 0 and _reserved(ctx, f"quota:research:{W2}") == 6, f"the release must refund the window its reservation recorded: 14:00 holds {_reserved(ctx, f'quota:research:{W1}')}, 15:00 holds {_reserved(ctx, f'quota:research:{W2}')}"


def check_atomic_take(ctx):
    m = ctx.load("state")
    # A second broker reserves 6 units right after this reserve's first command on research's hash.
    probes = [ctx.redis_after(key, lambda: m.reserve("research", W1, "gpu-h100", 6)) for key in (f"quota:research:{W1}", "quota:research")]
    mine = m.reserve("research", W1, "gpu-a100", 6)
    fired = [p for p in probes if p.fired]
    assert fired, "the reserve never touched research's window hash"
    theirs = _settled(fired[0])
    granted = [x for x in (mine, theirs) if x]
    total = _ledger_reserved(ctx)
    assert len(granted) == 1 and total == 6, f"two overlapping reserves of 6 against research's 8 units: {len(granted)} granted and the ledger holds reserved {total}. The read, the comparison and the increment must run as one script"


def check_expire_window(ctx):
    m = ctx.load("state")
    assert m.reserve("research", W1, "gpu-a100", 2), "a reserve of 2 units was refused"
    keys = sorted(ctx.redis.keys("quota:research*")) + sorted(ctx.redis.keys("reservation:research:*"))
    assert len(keys) == 2, f"a reserve must leave the window hash and the reservation, Redis holds {keys}"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 3600 <= ttl <= 86400, f"{key} has TTL {ttl}: the window hash and the reservation must expire after TTL_S (86400 s), or Redis keeps every window the broker ever served"


def check_release_once(ctx):
    m = ctx.load("state")
    reservation_id = m.reserve("research", W1, "gpu-a100", 4)
    assert reservation_id, "a reserve of 4 units was refused"
    # The scheduler's retry releases the same reservation while this release is running.
    rival = ctx.redis_after(f"reservation:research:{reservation_id}", lambda: m.release("research", reservation_id))
    mine = m.release("research", reservation_id)
    assert rival.fired, f"the release never touched reservation:research:{reservation_id}"
    theirs = _settled(rival)
    total = _ledger_reserved(ctx)
    assert total == 0, f"two overlapping releases of one 4-unit reservation left reserved at {total}: the units were refunded twice. Read, refund and delete in one script"
    assert [mine, theirs].count(True) == 1, f"two releases of one reservation reported {mine} and {theirs}: exactly one may refund"
    assert m.release("research", reservation_id) is False, "a release of a reservation that is gone must report False"
`,
    typescript: `const W1 = '2026-11-02T14:00Z';
const W2 = '2026-11-02T15:00Z';

const reserved = (ctx, key: string): number => Number(ctx.redis.hget(key, 'reserved') ?? 0);

/** The units reserved over every hash the code keeps for team research. */
const ledgerReserved = (ctx): number =>
  (ctx.redis.keys('quota:research*') as string[]).filter(k => ctx.redis.type(k) === 'hash').reduce((sum, k) => sum + reserved(ctx, k), 0);

async function settled(probe) {
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_window_key(ctx) {
  const m = ctx.load('state');
  const first = await m.reserve('research', W1, 'gpu-a100', 6);
  assert(first, "a reserve of 6 of research's 8 units in an empty window was refused");
  const second = await m.reserve('research', W2, 'gpu-a100', 6);
  assert(second, \`a reserve of 6 units in the next window (\${W2}) was refused: the 14:00 jobs spent the 15:00 quota (keys: \${JSON.stringify(ctx.redis.keys('quota:research*'))}). Keep one hash per window\`);
  assert(reserved(ctx, \`quota:research:\${W1}\`) === 6 && reserved(ctx, \`quota:research:\${W2}\`) === 6, \`each window's hash must hold reserved 6, Redis holds \${JSON.stringify(ctx.redis.keys('quota:research*'))}\`);
  assert.equal(await m.release('research', first), true, 'releasing the 14:00 reservation must report true');
  assert(reserved(ctx, \`quota:research:\${W1}\`) === 0 && reserved(ctx, \`quota:research:\${W2}\`) === 6, \`the release must refund the window its reservation recorded: 14:00 holds \${reserved(ctx, \`quota:research:\${W1}\`)}, 15:00 holds \${reserved(ctx, \`quota:research:\${W2}\`)}\`);
}

export async function check_atomic_take(ctx) {
  const m = ctx.load('state');
  // A second broker reserves 6 units right after this reserve's first command on research's hash.
  const probes = [\`quota:research:\${W1}\`, 'quota:research'].map(key => ctx.redisAfter(key, () => m.reserve('research', W1, 'gpu-h100', 6)));
  const mine = await m.reserve('research', W1, 'gpu-a100', 6);
  const fired = probes.filter(p => p.fired);
  assert(fired.length > 0, "the reserve never touched research's window hash");
  const theirs = await settled(fired[0]);
  const granted = [mine, theirs].filter(x => x).length;
  const total = ledgerReserved(ctx);
  assert(granted === 1 && total === 6, \`two overlapping reserves of 6 against research's 8 units: \${granted} granted and the ledger holds reserved \${total}. The read, the comparison and the increment must run as one script\`);
}

export async function check_expire_window(ctx) {
  const m = ctx.load('state');
  assert(await m.reserve('research', W1, 'gpu-a100', 2), 'a reserve of 2 units was refused');
  const keys = [...ctx.redis.keys('quota:research*').sort(), ...ctx.redis.keys('reservation:research:*').sort()];
  assert.equal(keys.length, 2, \`a reserve must leave the window hash and the reservation, Redis holds \${JSON.stringify(keys)}\`);
  for (const key of keys) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl >= 3600 && ttl <= 86400, \`\${key} has TTL \${ttl}: the window hash and the reservation must expire after TTL_S (86400 s), or Redis keeps every window the broker ever served\`);
  }
}

export async function check_release_once(ctx) {
  const m = ctx.load('state');
  const reservationId = await m.reserve('research', W1, 'gpu-a100', 4);
  assert(reservationId, 'a reserve of 4 units was refused');
  // The scheduler's retry releases the same reservation while this release is running.
  const rival = ctx.redisAfter(\`reservation:research:\${reservationId}\`, () => m.release('research', reservationId));
  const mine = await m.release('research', reservationId);
  assert(rival.fired, \`the release never touched reservation:research:\${reservationId}\`);
  const theirs = await settled(rival);
  const total = ledgerReserved(ctx);
  assert.equal(total, 0, \`two overlapping releases of one 4-unit reservation left reserved at \${total}: the units were refunded twice. Read, refund and delete in one script\`);
  assert.equal([mine, theirs].filter(x => x === true).length, 1, \`two releases of one reservation reported \${mine} and \${theirs}: exactly one may refund\`);
  assert.equal(await m.release('research', reservationId), false, 'a release of a reservation that is gone must report false');
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

const (
	stateW1 = "2026-11-02T14:00Z"
	stateW2 = "2026-11-02T15:00Z"
)

var stateBg = context.Background()

func hashReserved(ctx *harness.Ctx, key string) int64 {
	raw, _ := ctx.Redis.HGet(key, "reserved")
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

// ledgerReserved is the units reserved over every hash the code keeps for team research.
func ledgerReserved(ctx *harness.Ctx) int64 {
	var total int64
	for _, key := range ctx.Redis.Keys("quota:research*") {
		if ctx.Redis.Type(key) == "hash" {
			total += hashReserved(ctx, key)
		}
	}
	return total
}

func mustReserve(ctx *harness.Ctx, window, class string, amount int64) string {
	id, err := reserve(stateBg, "research", window, class, amount, "")
	ctx.NoError(err, "reserve(research, %s, %s, %d) failed", window, class, amount)
	return id
}

func mustRelease(ctx *harness.Ctx, id string) bool {
	released, err := release(stateBg, "research", id)
	ctx.NoError(err, "release(research, %s) failed", id)
	return released
}

func CheckWindowKey(ctx *harness.Ctx) {
	first := mustReserve(ctx, stateW1, "gpu-a100", 6)
	ctx.Assert(first != "", "a reserve of 6 of research's 8 units in an empty window was refused")
	second := mustReserve(ctx, stateW2, "gpu-a100", 6)
	ctx.Assert(second != "", "a reserve of 6 units in the next window (%s) was refused: the 14:00 jobs spent the 15:00 quota (keys: %q). Keep one hash per window", stateW2, ctx.Redis.Keys("quota:research*"))
	ctx.Assert(hashReserved(ctx, "quota:research:"+stateW1) == 6 && hashReserved(ctx, "quota:research:"+stateW2) == 6, "each window's hash must hold reserved 6, Redis holds %q", ctx.Redis.Keys("quota:research*"))
	ctx.Equal(mustRelease(ctx, first), true, "releasing the 14:00 reservation; released")
	ctx.Assert(hashReserved(ctx, "quota:research:"+stateW1) == 0 && hashReserved(ctx, "quota:research:"+stateW2) == 6, "the release must refund the window its reservation recorded: 14:00 holds %d, 15:00 holds %d", hashReserved(ctx, "quota:research:"+stateW1), hashReserved(ctx, "quota:research:"+stateW2))
}

func CheckAtomicTake(ctx *harness.Ctx) {
	// A second broker reserves 6 units right after this reserve's first command on research's hash.
	var probes []func() (bool, any, error)
	for _, key := range []string{"quota:research:" + stateW1, "quota:research"} {
		p := ctx.Redis.After(key, func() any {
			id, err := reserve(stateBg, "research", stateW1, "gpu-h100", 6, "")
			ctx.NoError(err, "the rival reserve failed")
			return id
		})
		probes = append(probes, func() (bool, any, error) { return p.Fired, p.Result, p.Err })
	}
	mine := mustReserve(ctx, stateW1, "gpu-a100", 6)
	var theirs string
	fired := false
	for _, probe := range probes {
		if ok, result, err := probe(); ok {
			ctx.Assert(err == nil, "the rival reserve failed: %v", err)
			theirs, _ = result.(string)
			fired = true
			break
		}
	}
	ctx.Assert(fired, "the reserve never touched research's window hash")
	granted := 0
	for _, id := range []string{mine, theirs} {
		if id != "" {
			granted++
		}
	}
	total := ledgerReserved(ctx)
	ctx.Assert(granted == 1 && total == 6, "two overlapping reserves of 6 against research's 8 units: %d granted and the ledger holds reserved %d. The read, the comparison and the increment must run as one script", granted, total)
}

func CheckExpireWindow(ctx *harness.Ctx) {
	ctx.Assert(mustReserve(ctx, stateW1, "gpu-a100", 2) != "", "a reserve of 2 units was refused")
	keys := append(ctx.Redis.Keys("quota:research*"), ctx.Redis.Keys("reservation:research:*")...)
	ctx.Equal(len(keys), 2, "a reserve must leave the window hash and the reservation (Redis holds %q); the keys", keys)
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 3600 && ttl <= 86400, "%s has TTL %d: the window hash and the reservation must expire after a day (86400 s), or Redis keeps every window the broker ever served", key, ttl)
	}
}

func CheckReleaseOnce(ctx *harness.Ctx) {
	id := mustReserve(ctx, stateW1, "gpu-a100", 4)
	ctx.Assert(id != "", "a reserve of 4 units was refused")
	// The scheduler's retry releases the same reservation while this release is running.
	rival := ctx.Redis.After("reservation:research:"+id, func() any {
		released, err := release(stateBg, "research", id)
		ctx.NoError(err, "the rival release failed")
		return released
	})
	mine := mustRelease(ctx, id)
	ctx.Assert(rival.Fired, "the release never touched reservation:research:%s", id)
	ctx.Assert(rival.Err == nil, "the rival release failed: %v", rival.Err)
	theirs, _ := rival.Result.(bool)
	total := ledgerReserved(ctx)
	ctx.Equal(total, int64(0), "two overlapping releases of one 4-unit reservation refunded it twice (read, refund and delete in one script); reserved")
	refunds := 0
	for _, released := range []bool{mine, theirs} {
		if released {
			refunds++
		}
	}
	ctx.Equal(refunds, 1, "two releases of one reservation reported %t and %t: exactly one may refund; the refunds", mine, theirs)
	ctx.Equal(mustRelease(ctx, id), false, "a release of a reservation that is gone; released")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kW1 = "2026-11-02T14:00Z";
const std::string kW2 = "2026-11-02T15:00Z";

long long hashReserved(harness::Ctx& ctx, const std::string& key) {
  const auto raw = ctx.Redis.HGet(key, "reserved");
  return raw && !raw->empty() ? std::stoll(*raw) : 0;
}

// The units reserved over every hash the code keeps for team research.
long long ledgerReserved(harness::Ctx& ctx) {
  long long total = 0;
  for (const auto& key : ctx.Redis.Keys("quota:research*")) {
    if (ctx.Redis.Type(key) == "hash") total += hashReserved(ctx, key);
  }
  return total;
}

// A probe's outcome: whether it fired, what the parallel call returned, what it threw.
struct Rival {
  bool fired = false;
  std::optional<std::string> reserved;
  bool released = false;
  std::optional<std::string> err;
};

std::shared_ptr<Rival> rivalReserve(harness::Ctx& ctx, const std::string& key) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out] {
    out->fired = true;
    try {
      out->reserved = reserve("research", kW1, "gpu-h100", 6);
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

}  // namespace

void CheckWindowKey(harness::Ctx& ctx) {
  const auto first = reserve("research", kW1, "gpu-a100", 6);
  ctx.Assert(first.has_value(), "a reserve of 6 of research's 8 units in an empty window was refused");
  const auto second = reserve("research", kW2, "gpu-a100", 6);
  ctx.Assert(second.has_value(), "a reserve of 6 units in the next window (%s) was refused: the 14:00 jobs spent the 15:00 quota (keys: %q). Keep one hash per window", kW2, ctx.Redis.Keys("quota:research*"));
  ctx.Assert(hashReserved(ctx, "quota:research:" + kW1) == 6 && hashReserved(ctx, "quota:research:" + kW2) == 6, "each window's hash must hold reserved 6, Redis holds %q", ctx.Redis.Keys("quota:research*"));
  ctx.Equal(release("research", *first), true, "releasing the 14:00 reservation; released");
  ctx.Assert(hashReserved(ctx, "quota:research:" + kW1) == 0 && hashReserved(ctx, "quota:research:" + kW2) == 6, "the release must refund the window its reservation recorded: 14:00 holds %d, 15:00 holds %d", hashReserved(ctx, "quota:research:" + kW1), hashReserved(ctx, "quota:research:" + kW2));
}

void CheckAtomicTake(harness::Ctx& ctx) {
  // A second broker reserves 6 units right after this reserve's first command on research's hash.
  const std::vector<std::shared_ptr<Rival>> probes = {rivalReserve(ctx, "quota:research:" + kW1), rivalReserve(ctx, "quota:research")};
  const auto mine = reserve("research", kW1, "gpu-a100", 6);
  std::shared_ptr<Rival> fired;
  for (const auto& p : probes) {
    if (p->fired) {
      fired = p;
      break;
    }
  }
  ctx.Assert(fired != nullptr, "the reserve never touched research's window hash");
  ctx.Assert(!fired->err, "the rival reserve failed: %s", fired->err.value_or(""));
  const int granted = (mine ? 1 : 0) + (fired->reserved ? 1 : 0);
  const long long total = ledgerReserved(ctx);
  ctx.Assert(granted == 1 && total == 6, "two overlapping reserves of 6 against research's 8 units: %d granted and the ledger holds reserved %d. The read, the comparison and the increment must run as one script", granted, total);
}

void CheckExpireWindow(harness::Ctx& ctx) {
  ctx.Assert(reserve("research", kW1, "gpu-a100", 2).has_value(), "a reserve of 2 units was refused");
  auto keys = ctx.Redis.Keys("quota:research*");
  for (const auto& k : ctx.Redis.Keys("reservation:research:*")) keys.push_back(k);
  ctx.Equal(keys.size(), 2, "a reserve must leave the window hash and the reservation (Redis holds %q); the keys", keys);
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl >= 3600 && ttl <= 86400, "%s has TTL %d: the window hash and the reservation must expire after kTtlSeconds (86400 s), or Redis keeps every window the broker ever served", key, ttl);
  }
}

void CheckReleaseOnce(harness::Ctx& ctx) {
  const auto id = reserve("research", kW1, "gpu-a100", 4);
  ctx.Assert(id.has_value(), "a reserve of 4 units was refused");
  // The scheduler's retry releases the same reservation while this release is running.
  auto rival = std::make_shared<Rival>();
  const std::string reservation_id = *id;
  ctx.Redis.After("reservation:research:" + reservation_id, [rival, reservation_id] {
    rival->fired = true;
    try {
      rival->released = release("research", reservation_id);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const bool mine = release("research", reservation_id);
  ctx.Assert(rival->fired, "the release never touched reservation:research:%s", reservation_id);
  ctx.Assert(!rival->err, "the rival release failed: %s", rival->err.value_or(""));
  ctx.Equal(ledgerReserved(ctx), 0, "two overlapping releases of one 4-unit reservation refunded it twice (read, refund and delete in one script); reserved");
  ctx.Equal((mine ? 1 : 0) + (rival->released ? 1 : 0), 1, "two releases of one reservation reported %t and %t: exactly one may refund; the refunds", mine, rival->released);
  ctx.Equal(release("research", reservation_id), false, "a release of a reservation that is gone; released");
}
`,
  },
  hints: [
    'Run two reserves of 6 against research’s 8 units at the same moment: both are granted and `reserved` reads 12. Release one reservation twice in parallel and `reserved` goes negative.',
    'The two `HGET`s, the comparison and the `HINCRBY` are separate round trips, so another broker’s commands fit between them, and the release reads and deletes in two more. The hash has no window in its key and nothing sets a TTL.',
    'Key `quota:{team}:{window}`; put the reads, the comparison, the `HINCRBY`, the reservation `HSET` and both `EXPIRE`s in one script; release does `HGET` window and amount, `HINCRBY` on that window and `DEL` in a second script.',
  ],
  debrief: `Redis runs a script without interleaving another client's commands, so the comparison and the take become one step and the limit holds however many brokers race. The window belongs in the key because a quota is per window; the TTL bounds the ledger to windows that can still matter. The release reads its window from the reservation instead of trusting the caller, and deleting the record inside the same script is what turns a retried release into a no-op that reports false. Production ledgers keep a released record with a state field for audit instead of deleting it, and push a limit change into the windows already open.`,
};
