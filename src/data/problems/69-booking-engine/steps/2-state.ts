import type {Step} from '@/lib/types';

export const bookingStateStep: Step = {
  id: 'state',
  title: 'Redis hold map with one atomic transition',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the slot map, checks
it, writes the hold. It works when one person books at a time, which is not a property of a booking
engine. Review it like the service owner, fix it, and prove the fix with the checks below.

A hold is one row per slot in a Redis hash, and taking one is a single atomic transition.

- The slot map is \`resource:{resource_id}:slots\`: one field per slot (the slot's epoch minute is a
  fine field name) whose value is the id of the hold that owns it, or \`booked:{booking_id}\` once
  the booking is confirmed.
- A hold lives at \`hold:{hold_id}\` with a TTL of **900** seconds — the payment window. An abandoned
  checkout must free its slots when the window closes, so the TTL is the only thing keeping a
  forgotten hold alive.
- \`take_hold\` runs as **one Lua script** in one round trip: if any requested slot field already
  exists the script returns \`0\` and writes nothing; otherwise it writes every slot field in the same
  script and sets the hold key with \`EX ttl\`. There is no client-side "check, then write": between
  those two calls another request is free to take the slot.
- Callers turn \`0\` into a \`slot_taken\` conflict — exactly one of two concurrent requests for one
  slot can win, because only one of them can be the script that returns \`1\`.
- \`confirm_hold\` converts the hold: each slot still pointing at that hold becomes
  \`booked:{booking_id}\`, and the hold key is rewritten **without a TTL**, so nothing expires a
  confirmed booking back into the free set.
- \`release_hold\` is the sweeper's path and it is guarded: it deletes a slot field only while it
  still points at **this** hold, so a slot that a later request already re-booked is never freed.

**Failure mode the checks target.** The draft does \`HEXISTS\` in the handler and \`HSET\` afterwards,
so two concurrent bookings both observe a free slot and both win — the exact double-booking this
course is about. Its hold key has no expiry, so every abandoned checkout blocks a slot forever, and
it deletes the hold key on cancellation without checking who owns the slot.`,
  sequence: {
    participants: ['Booking API', 'Redis hold map', 'Sweeper'],
    messages: [
      {from: 'Booking API', to: 'Redis hold map', label: 'EVALSHA take_hold slots · hold · ttl · slots…', kind: 'sync'},
      {from: 'Redis hold map', to: 'Booking API', label: '1 held · 0 slot already taken', kind: 'reply'},
      {from: 'Booking API', to: 'Booking API', label: '0 → 409 slot_taken, no partial hold', kind: 'sync'},
      {
        from: 'Booking API',
        to: 'Redis hold map',
        label: 'confirm: slots → booked:{id} · hold → confirmed',
        kind: 'async',
      },
      {from: 'Sweeper', to: 'Redis hold map', label: 'release_hold when hold:{id} is gone', kind: 'sync'},
      {from: 'Redis hold map', to: 'Sweeper', label: 'slots freed only while they still point at it', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-hold',
      title: 'Checks and takes the slot map inside one Lua script',
      detail:
        'The decision and the write are one `EVAL`/`EVALSHA` run over the slot map and the hold key — `HEXISTS` then `HSET` inside the same script. The draft asks Redis `HEXISTS` from the client and writes the hold in a later call, so two requests race.',
      match: {
        python: {all: [/TAKE_HOLD_SCRIPT/, /redis\.call\('HEXISTS'/, /redis\.call\('HSET'/], none: [/\.hexists\(/]},
        typescript: {all: [/TAKE_HOLD_SCRIPT/, /redis\.call\('HEXISTS'/, /redis\.call\('HSET'/], none: [/\.hexists\(/]},
        go: {all: [/takeHoldScript/, /redis\.call\('HEXISTS'/, /redis\.call\('HSET'/], none: [/\.HExists\(/]},
        scala: {all: [/TakeHoldScript/, /redis\.call\('HEXISTS'/, /redis\.call\('HSET'/], none: [/\.hexists\(/]},
        cpp: {all: [/kTakeHoldScript/, /redis\.call\('HEXISTS'/, /redis\.call\('HSET'/], none: [/\.hexists\(/]},
      },
    },
    {
      id: 'hold-ttl',
      title: 'Expires the hold after the 900 s payment window',
      detail:
        'The hold key is written with `EX ttl` from a `900`-second constant, so an abandoned checkout frees its slots when the window closes. The draft writes a hold key that never expires.',
      match: {
        python: {all: [/HOLD_TTL_S/, /redis\.call\('SET', hold_key, 'held', 'EX', ttl\)/]},
        typescript: {all: [/HOLD_TTL_S/, /redis\.call\('SET', hold_key, 'held', 'EX', ttl\)/]},
        go: {all: [/holdTTLS/, /redis\.call\('SET', hold_key, 'held', 'EX', ttl\)/]},
        scala: {all: [/HoldTtlS/, /redis\.call\('SET', hold_key, 'held', 'EX', ttl\)/]},
        cpp: {all: [/kHoldTtlS/, /redis\.call\('SET', hold_key, 'held', 'EX', ttl\)/]},
      },
    },
    {
      id: 'single-winner',
      title: 'Lets exactly one of two concurrent requests win',
      detail:
        'The script returns `0` when any requested slot is already present and the caller turns that into a `slot_taken` conflict, so a losing request takes nothing at all. The draft writes the slots it could check and returns a plain boolean.',
      match: {
        python: {all: [/return 0/, /slot_taken/, /def reserve\(/]},
        typescript: {all: [/return 0/, /slot_taken/, /function reserve\(/]},
        go: {all: [/return 0/, /slot_taken/, /func reserve\(/]},
        scala: {all: [/return 0/, /slot_taken/, /def reserve\(/]},
        cpp: {all: [/return 0/, /slot_taken/, /reserve\(/]},
      },
    },
    {
      id: 'release-guarded',
      title: 'Frees a slot only while it still points at this hold',
      detail:
        'The release path runs in a script and deletes a slot field only when its value is still this hold id, so a slot a later request re-booked is never freed. The draft deletes the hold key and leaves the map alone.',
      match: {
        python: {all: [/def release_hold\(/, /local released = 0/, /redis\.call\('HDEL'/, /== hold_id/]},
        typescript: {all: [/function releaseHold\(/, /local released = 0/, /redis\.call\('HDEL'/, /== hold_id/]},
        go: {all: [/func releaseHold\(/, /local released = 0/, /redis\.call\('HDEL'/, /== hold_id/]},
        scala: {all: [/def releaseHold\(/, /local released = 0/, /redis\.call\('HDEL'/, /== hold_id/]},
        cpp: {all: [/releaseHold\(/, /local released = 0/, /redis\.call\('HDEL'/, /== hold_id/]},
      },
    },
    {
      id: 'confirm-converts',
      title: 'Converts a confirmed hold without re-entering the free set',
      detail:
        'Confirmation rewrites each slot field to `booked:{booking_id}` and rewrites the hold key without a TTL, so the payment window can never expire a booking back into the free set. The draft just drops the hold key.',
      match: {
        python: {
          all: [/def confirm_hold\(/, /'booked:' \.\. booking_id/, /redis\.call\('SET', hold_key, 'confirmed'\)/],
        },
        typescript: {
          all: [/function confirmHold\(/, /'booked:' \.\. booking_id/, /redis\.call\('SET', hold_key, 'confirmed'\)/],
        },
        go: {all: [/func confirmHold\(/, /'booked:' \.\. booking_id/, /redis\.call\('SET', hold_key, 'confirmed'\)/]},
        scala: {all: [/def confirmHold\(/, /'booked:' \.\. booking_id/, /redis\.call\('SET', hold_key, 'confirmed'\)/]},
        cpp: {all: [/confirmHold\(/, /'booked:' \.\. booking_id/, /redis\.call\('SET', hold_key, 'confirmed'\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis as redis_lib

r = redis_lib.Redis()


def slots_key(resource_id: str) -> str:
    return f"resource:{resource_id}:slots"


def take_hold(resource_id: str, slot_fields: list[str], hold_id: str) -> bool:
    # TODO: this draft checks the slot map with HEXISTS from the client and writes the hold in a
    # later call, so two concurrent requests both see a free slot and both book; its hold key has
    # no TTL, so an abandoned checkout blocks the slot forever; and confirming just deletes the
    # hold key. Make the take atomic, give the hold a TTL of 900 seconds, and convert the hold.
    for field in slot_fields:
        if r.hexists(slots_key(resource_id), field):
            return False
    for field in slot_fields:
        r.hset(slots_key(resource_id), field, hold_id)
    r.set(f"hold:{hold_id}", "held")
    return True


def confirm_hold(resource_id: str, slot_fields: list[str], hold_id: str) -> None:
    r.delete(f"hold:{hold_id}")
`,
      solution: `import uuid

import redis as redis_lib
from fastapi import HTTPException

r = redis_lib.Redis()

HOLD_TTL_S = 900  # the payment window: an abandoned checkout frees its slots after 15 minutes

TAKE_HOLD_SCRIPT = """
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local ttl = tonumber(ARGV[1])
local hold_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HEXISTS', slots_key, ARGV[i]) == 1 then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', slots_key, ARGV[i], hold_id)
end
redis.call('SET', hold_key, 'held', 'EX', ttl)
redis.call('EXPIRE', slots_key, ttl * 4)
return 1
"""

CONFIRM_HOLD_SCRIPT = """
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local hold_id = ARGV[1]
local booking_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HSET', slots_key, ARGV[i], 'booked:' .. booking_id)
  end
end
redis.call('SET', hold_key, 'confirmed')
return 1
"""

RELEASE_HOLD_SCRIPT = """
local slots_key = KEYS[1]
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HDEL', slots_key, ARGV[i])
    released = released + 1
  end
end
return released
"""

take_hold_script = r.register_script(TAKE_HOLD_SCRIPT)
confirm_hold_script = r.register_script(CONFIRM_HOLD_SCRIPT)
release_hold_script = r.register_script(RELEASE_HOLD_SCRIPT)


def slots_key(resource_id: str) -> str:
    return f"resource:{resource_id}:slots"


def hold_key(hold_id: str) -> str:
    return f"hold:{hold_id}"


def reserve(resource_id: str, slot_fields: list[str]) -> dict:
    """One atomic transition: every slot free and held, or nothing taken."""
    hold_id = str(uuid.uuid4())
    taken = take_hold_script(
        keys=[slots_key(resource_id), hold_key(hold_id)],
        args=[HOLD_TTL_S, hold_id, *slot_fields],
    )
    if int(taken) == 0:
        raise HTTPException(status_code=409, detail="slot_taken")
    return {"hold_id": hold_id, "expires_in": HOLD_TTL_S}


def confirm_hold(resource_id: str, slot_fields: list[str], hold_id: str, booking_id: str) -> None:
    """Convert the hold into a booking: those slots are no longer free and cannot expire into it."""
    confirm_hold_script(
        keys=[slots_key(resource_id), hold_key(hold_id)],
        args=[hold_id, booking_id, *slot_fields],
    )


def release_hold(resource_id: str, slot_fields: list[str], hold_id: str) -> int:
    """The sweeper's path: called when hold:{hold_id} is gone, frees only the slots it still owns."""
    return int(release_hold_script(keys=[slots_key(resource_id)], args=[hold_id, *slot_fields]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

export function slotsKey(resourceId: string): string {
  return \`resource:\${resourceId}:slots\`;
}

export async function takeHold(resourceId: string, slotFields: string[], holdId: string): Promise<boolean> {
  // TODO: this draft checks the slot map with HEXISTS from the client and writes the hold in a
  // later call, so two concurrent requests both see a free slot and both book; its hold key has no
  // TTL, so an abandoned checkout blocks the slot forever; and confirming just deletes the hold
  // key. Make the take atomic, give the hold a TTL of 900 seconds, and convert the hold.
  for (const field of slotFields) {
    if (await redis.hexists(slotsKey(resourceId), field)) return false;
  }
  for (const field of slotFields) {
    await redis.hset(slotsKey(resourceId), field, holdId);
  }
  await redis.set(\`hold:\${holdId}\`, 'held');
  return true;
}

export async function confirmHold(resourceId: string, slotFields: string[], holdId: string): Promise<void> {
  await redis.del(\`hold:\${holdId}\`);
}
`,
      solution: `import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

export const HOLD_TTL_S = 900; // the payment window: an abandoned checkout frees its slots after 15 minutes

export const TAKE_HOLD_SCRIPT = \`
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local ttl = tonumber(ARGV[1])
local hold_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HEXISTS', slots_key, ARGV[i]) == 1 then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', slots_key, ARGV[i], hold_id)
end
redis.call('SET', hold_key, 'held', 'EX', ttl)
redis.call('EXPIRE', slots_key, ttl * 4)
return 1
\`;

const CONFIRM_HOLD_SCRIPT = \`
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local hold_id = ARGV[1]
local booking_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HSET', slots_key, ARGV[i], 'booked:' .. booking_id)
  end
end
redis.call('SET', hold_key, 'confirmed')
return 1
\`;

const RELEASE_HOLD_SCRIPT = \`
local slots_key = KEYS[1]
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HDEL', slots_key, ARGV[i])
    released = released + 1
  end
end
return released
\`;

interface HoldRedis extends Redis {
  takeHold(slotsKey: string, holdKey: string, ttl: number, holdId: string, ...fields: string[]): Promise<number>;
  confirmHold(slotsKey: string, holdKey: string, holdId: string, bookingId: string, ...fields: string[]): Promise<number>;
  releaseHold(slotsKey: string, holdId: string, ...fields: string[]): Promise<number>;
}

// Loaded once: every call is an EVALSHA, with EVAL as the fallback on NOSCRIPT.
redis.defineCommand('takeHold', {numberOfKeys: 2, lua: TAKE_HOLD_SCRIPT});
redis.defineCommand('confirmHold', {numberOfKeys: 2, lua: CONFIRM_HOLD_SCRIPT});
redis.defineCommand('releaseHold', {numberOfKeys: 1, lua: RELEASE_HOLD_SCRIPT});

const holdRedis = redis as HoldRedis;

export function slotsKey(resourceId: string): string {
  return \`resource:\${resourceId}:slots\`;
}

export function holdKey(holdId: string): string {
  return \`hold:\${holdId}\`;
}

/** One atomic transition: every slot free and held, or nothing taken. */
export async function reserve(resourceId: string, slotFields: string[]): Promise<{holdId: string; expiresIn: number}> {
  const holdId = randomUUID();
  const taken = await holdRedis.takeHold(slotsKey(resourceId), holdKey(holdId), HOLD_TTL_S, holdId, ...slotFields);
  if (taken === 0) throw Object.assign(new Error('slot_taken'), {statusCode: 409});
  return {holdId, expiresIn: HOLD_TTL_S};
}

/** Convert the hold into a booking: those slots are no longer free and cannot expire into it. */
export async function confirmHold(
  resourceId: string,
  slotFields: string[],
  holdId: string,
  bookingId: string,
): Promise<void> {
  await holdRedis.confirmHold(slotsKey(resourceId), holdKey(holdId), holdId, bookingId, ...slotFields);
}

/** The sweeper's path: called when hold:{holdId} is gone, frees only the slots it still owns. */
export async function releaseHold(resourceId: string, slotFields: string[], holdId: string): Promise<number> {
  return holdRedis.releaseHold(slotsKey(resourceId), holdId, ...slotFields);
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

func slotsKey(resourceID string) string {
	return "resource:" + resourceID + ":slots"
}

func takeHold(ctx context.Context, resourceID string, slotFields []string, holdID string) (bool, error) {
	// TODO: this draft checks the slot map with HExists from the client and writes the hold in a
	// later call, so two concurrent requests both see a free slot and both book; its hold key has
	// no TTL, so an abandoned checkout blocks the slot forever; and confirming just deletes the
	// hold key. Make the take atomic, give the hold a TTL of 900 seconds, and convert the hold.
	for _, field := range slotFields {
		held, err := rdb.HExists(ctx, slotsKey(resourceID), field).Result()
		if err != nil {
			return false, err
		}
		if held {
			return false, nil
		}
	}
	for _, field := range slotFields {
		if err := rdb.HSet(ctx, slotsKey(resourceID), field, holdID).Err(); err != nil {
			return false, err
		}
	}
	return true, rdb.Set(ctx, "hold:"+holdID, "held", 0).Err()
}

func confirmHold(ctx context.Context, resourceID string, slotFields []string, holdID string) error {
	return rdb.Del(ctx, "hold:"+holdID).Err()
}
`,
      solution: `package main

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const holdTTLS = 900 // the payment window: an abandoned checkout frees its slots after 15 minutes

var errSlotTaken = errors.New("slot_taken")

// Run uses EVALSHA and falls back to EVAL once when the script is not loaded yet.
var takeHoldScript = redis.NewScript(\`
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local ttl = tonumber(ARGV[1])
local hold_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HEXISTS', slots_key, ARGV[i]) == 1 then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', slots_key, ARGV[i], hold_id)
end
redis.call('SET', hold_key, 'held', 'EX', ttl)
redis.call('EXPIRE', slots_key, ttl * 4)
return 1
\`)

var confirmHoldScript = redis.NewScript(\`
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local hold_id = ARGV[1]
local booking_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HSET', slots_key, ARGV[i], 'booked:' .. booking_id)
  end
end
redis.call('SET', hold_key, 'confirmed')
return 1
\`)

var releaseHoldScript = redis.NewScript(\`
local slots_key = KEYS[1]
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HDEL', slots_key, ARGV[i])
    released = released + 1
  end
end
return released
\`)

func slotsKey(resourceID string) string {
	return "resource:" + resourceID + ":slots"
}

func holdKey(holdID string) string {
	return "hold:" + holdID
}

// reserve takes the whole range in one atomic transition: every slot free and held, or nothing.
func reserve(ctx context.Context, resourceID string, slotFields []string) (string, error) {
	holdID := uuid.NewString()
	args := []any{holdTTLS, holdID}
	for _, field := range slotFields {
		args = append(args, field)
	}
	taken, err := takeHoldScript.Run(ctx, rdb, []string{slotsKey(resourceID), holdKey(holdID)}, args...).Int()
	if err != nil {
		return "", err
	}
	if taken == 0 {
		return "", errSlotTaken
	}
	return holdID, nil
}

// confirmHold converts the hold into a booking: those slots are no longer free and cannot expire
// back into the free set.
func confirmHold(ctx context.Context, resourceID string, slotFields []string, holdID, bookingID string) error {
	args := []any{holdID, bookingID}
	for _, field := range slotFields {
		args = append(args, field)
	}
	return confirmHoldScript.Run(ctx, rdb, []string{slotsKey(resourceID), holdKey(holdID)}, args...).Err()
}

// releaseHold is the sweeper's path: called when hold:{holdID} is gone, frees only the slots it
// still owns.
func releaseHold(ctx context.Context, resourceID string, slotFields []string, holdID string) (int64, error) {
	args := []any{holdID}
	for _, field := range slotFields {
		args = append(args, field)
	}
	return releaseHoldScript.Run(ctx, rdb, []string{slotsKey(resourceID)}, args...).Int64()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object HoldMap {
  val jedis = new JedisPooled("redis", 6379)

  def slotsKey(resourceId: String): String = s"resource:$resourceId:slots"

  def takeHold(resourceId: String, slotFields: Seq[String], holdId: String): Boolean = {
    // TODO: this draft checks the slot map with hexists from the client and writes the hold in a
    // later call, so two concurrent requests both see a free slot and both book; its hold key has
    // no TTL, so an abandoned checkout blocks the slot forever; and confirming just deletes the
    // hold key. Make the take atomic, give the hold a TTL of 900 seconds, and convert the hold.
    if (slotFields.exists(field => jedis.hexists(slotsKey(resourceId), field))) {
      false
    } else {
      slotFields.foreach(field => jedis.hset(slotsKey(resourceId), field, holdId))
      jedis.set(s"hold:$holdId", "held")
      true
    }
  }

  def confirmHold(resourceId: String, slotFields: Seq[String], holdId: String): Unit =
    jedis.del(s"hold:$holdId")
}
`,
      solution: `import java.util.UUID

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object HoldMap {
  val jedis = new JedisPooled("redis", 6379)

  val HoldTtlS = 900 // the payment window: an abandoned checkout frees its slots after 15 minutes

  val TakeHoldScript: String =
    """local slots_key = KEYS[1]
      |local hold_key = KEYS[2]
      |local ttl = tonumber(ARGV[1])
      |local hold_id = ARGV[2]
      |for i = 3, #ARGV do
      |  if redis.call('HEXISTS', slots_key, ARGV[i]) == 1 then
      |    return 0
      |  end
      |end
      |for i = 3, #ARGV do
      |  redis.call('HSET', slots_key, ARGV[i], hold_id)
      |end
      |redis.call('SET', hold_key, 'held', 'EX', ttl)
      |redis.call('EXPIRE', slots_key, ttl * 4)
      |return 1
      |""".stripMargin

  val ConfirmHoldScript: String =
    """local slots_key = KEYS[1]
      |local hold_key = KEYS[2]
      |local hold_id = ARGV[1]
      |local booking_id = ARGV[2]
      |for i = 3, #ARGV do
      |  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
      |    redis.call('HSET', slots_key, ARGV[i], 'booked:' .. booking_id)
      |  end
      |end
      |redis.call('SET', hold_key, 'confirmed')
      |return 1
      |""".stripMargin

  val ReleaseHoldScript: String =
    """local slots_key = KEYS[1]
      |local hold_id = ARGV[1]
      |local released = 0
      |for i = 2, #ARGV do
      |  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
      |    redis.call('HDEL', slots_key, ARGV[i])
      |    released = released + 1
      |  end
      |end
      |return released
      |""".stripMargin

  private val takeSha = jedis.scriptLoad(TakeHoldScript)
  private val confirmSha = jedis.scriptLoad(ConfirmHoldScript)
  private val releaseSha = jedis.scriptLoad(ReleaseHoldScript)

  def slotsKey(resourceId: String): String = s"resource:$resourceId:slots"

  def holdKey(holdId: String): String = s"hold:$holdId"

  /** One atomic transition: every slot free and held, or nothing taken. */
  def reserve(resourceId: String, slotFields: Seq[String]): String = {
    val holdId = UUID.randomUUID().toString
    val args = (Seq(HoldTtlS.toString, holdId) ++ slotFields).asJava
    val keys = Seq(slotsKey(resourceId), holdKey(holdId)).asJava
    val reply = jedis.evalsha(takeSha, keys, args).asInstanceOf[java.lang.Long]
    if (reply == 0L) throw new IllegalStateException("slot_taken")
    holdId
  }

  /** Convert the hold into a booking: those slots are no longer free and cannot expire into it. */
  def confirmHold(resourceId: String, slotFields: Seq[String], holdId: String, bookingId: String): Unit = {
    val args = (Seq(holdId, bookingId) ++ slotFields).asJava
    jedis.evalsha(confirmSha, Seq(slotsKey(resourceId), holdKey(holdId)).asJava, args)
  }

  /** The sweeper's path: called when hold:{holdId} is gone, frees only the slots it still owns. */
  def releaseHold(resourceId: String, slotFields: Seq[String], holdId: String): Long = {
    val args = (Seq(holdId) ++ slotFields).asJava
    jedis.evalsha(releaseSha, Seq(slotsKey(resourceId)).asJava, args).asInstanceOf[java.lang.Long]
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

std::string slotsKey(const std::string& resourceId) { return "resource:" + resourceId + ":slots"; }

bool takeHold(const std::string& resourceId, const std::vector<std::string>& slotFields,
              const std::string& holdId) {
  // TODO: this draft checks the slot map with hexists from the client and writes the hold in a
  // later call, so two concurrent requests both see a free slot and both book; its hold key has no
  // TTL, so an abandoned checkout blocks the slot forever; and confirming just deletes the hold
  // key. Make the take atomic, give the hold a TTL of 900 seconds, and convert the hold.
  for (const auto& field : slotFields) {
    if (redis.hexists(slotsKey(resourceId), field)) return false;
  }
  for (const auto& field : slotFields) {
    redis.hset(slotsKey(resourceId), field, holdId);
  }
  redis.set("hold:" + holdId, "held");
  return true;
}

void confirmHold(const std::string& resourceId, const std::vector<std::string>& slotFields,
                 const std::string& holdId) {
  redis.del("hold:" + holdId);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kHoldTtlS = 900; // the payment window: an abandoned checkout frees its slots

const std::string kTakeHoldScript = R"lua(
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local ttl = tonumber(ARGV[1])
local hold_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HEXISTS', slots_key, ARGV[i]) == 1 then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', slots_key, ARGV[i], hold_id)
end
redis.call('SET', hold_key, 'held', 'EX', ttl)
redis.call('EXPIRE', slots_key, ttl * 4)
return 1
)lua";

const std::string kConfirmHoldScript = R"lua(
local slots_key = KEYS[1]
local hold_key = KEYS[2]
local hold_id = ARGV[1]
local booking_id = ARGV[2]
for i = 3, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HSET', slots_key, ARGV[i], 'booked:' .. booking_id)
  end
end
redis.call('SET', hold_key, 'confirmed')
return 1
)lua";

const std::string kReleaseHoldScript = R"lua(
local slots_key = KEYS[1]
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', slots_key, ARGV[i]) == hold_id then
    redis.call('HDEL', slots_key, ARGV[i])
    released = released + 1
  end
end
return released
)lua";

const std::string kTakeHoldSha = redis.script_load(kTakeHoldScript);
const std::string kConfirmHoldSha = redis.script_load(kConfirmHoldScript);
const std::string kReleaseHoldSha = redis.script_load(kReleaseHoldScript);

std::string slotsKey(const std::string& resourceId) { return "resource:" + resourceId + ":slots"; }
std::string holdKey(const std::string& holdId) { return "hold:" + holdId; }

// One atomic transition: every slot free and held, or nothing taken.
std::string reserve(const std::string& resourceId, const std::vector<std::string>& slotFields) {
  const std::string holdId = newId();
  std::vector<std::string> args{std::to_string(kHoldTtlS), holdId};
  args.insert(args.end(), slotFields.begin(), slotFields.end());
  std::vector<long long> reply;
  redis.evalsha(kTakeHoldSha, {slotsKey(resourceId), holdKey(holdId)}, args, std::back_inserter(reply));
  if (reply.empty() || reply[0] == 0) throw std::runtime_error("slot_taken");
  return holdId;
}

// Convert the hold into a booking: those slots are no longer free and cannot expire into it.
void confirmHold(const std::string& resourceId, const std::vector<std::string>& slotFields,
                 const std::string& holdId, const std::string& bookingId) {
  std::vector<std::string> args{holdId, bookingId};
  args.insert(args.end(), slotFields.begin(), slotFields.end());
  redis.evalsha(kConfirmHoldSha, {slotsKey(resourceId), holdKey(holdId)}, args);
}

// The sweeper's path: called when hold:{holdId} is gone, frees only the slots it still owns.
long long releaseHold(const std::string& resourceId, const std::vector<std::string>& slotFields,
                      const std::string& holdId) {
  std::vector<std::string> args{holdId};
  args.insert(args.end(), slotFields.begin(), slotFields.end());
  std::vector<long long> reply;
  redis.evalsha(kReleaseHoldSha, {slotsKey(resourceId)}, args, std::back_inserter(reply));
  return reply.empty() ? 0 : reply[0];
}
`,
    },
  },
  hints: [
    'Anything you can only check and then write is a race. Both the existence check and the write have to happen in one script so Redis runs them with nothing in between.',
    'A hold with no TTL is a permanent reservation nobody meant to make: the payment window is what turns "abandoned" into "free again". Write the hold key with `EX`, and keep the slot map alive long enough to outlive it.',
    'The sweeper must be suspicious. When `hold:{id}` is gone, only the slots whose value is still that hold are free again — a slot a later request re-booked, and a slot a confirmed booking owns, must be left alone.',
  ],
  debrief: `The interviewer is testing whether you can turn a two-step check into one atomic transition, which
is the whole reason a booking engine uses Redis and not a database read-modify-write. Three defects
are being checked: the client-side read-then-write that lets two concurrent requests win one slot,
the missing TTL that makes an abandoned checkout block a slot forever, and a confirmation path that
must not let a confirmed booking expire back into the free set. The guarded release is the subtle
one — a sweeper that deletes by slot index without checking the owner will free a slot somebody else
already booked. Real systems add a scheduled sweeper (or Redis keyspace notifications) to run the
release, a per-resource lock around long ranges, and a second index to list a hold's slots.`,
};
