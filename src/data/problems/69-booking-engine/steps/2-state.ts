import type {Step} from '@/lib/types';

export const bookingStateStep: Step = {
  id: 'state',
  title: 'Redis hold map with one atomic transition',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry', 'leases'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the hold map behind \`POST /v1/bookings\`: \`take_hold\` checks each
slot of \`resource:{id}:slots\` and writes it, \`confirm_hold\` drops the hold key, \`release_hold\` frees
the slots. It serves the demo, where one person books at a time, and hides five flaws.

**Failure mode the checks target.** Two requests for one slot that arrive together, a checkout that is
abandoned, a payment that completes, and a sweeper that runs after the slot changed hands.

- \`take_hold(resource_id, slot_fields)\` runs as **one Lua script**: a slot is taken when its entry is
  \`booked:…\` or a hold id whose \`hold:{id}\` key still exists; if any requested slot is taken the
  script returns \`0\` and writes nothing, otherwise it writes every slot and \`SET hold:{id} held EX 900\`
  in the same script. The caller gets \`None\` / \`null\` on \`0\`, else \`{hold_id, expires_in}\`.
- The slot map itself **never expires**: \`hold:{id}\` carries the payment window, the map carries the
  bookings.
- \`confirm_hold(resource_id, slot_fields, hold_id, booking_id)\` rewrites each slot the hold still owns
  to \`booked:{booking_id}\` and deletes the hold key.
- \`release_hold(resource_id, slot_fields, hold_id)\` deletes a slot only while it still points at
  **this** hold, then the hold key, and returns how many it freed.`,
  sequence: {
    participants: ['Booking API', 'Redis hold map', 'Sweeper'],
    messages: [
      {from: 'Booking API', to: 'Redis hold map', label: 'EVALSHA take_hold · hold_id · 900 · slots…', kind: 'sync'},
      {from: 'Redis hold map', to: 'Booking API', label: '1 held · 0 slot already taken', kind: 'reply'},
      {from: 'Booking API', to: 'Booking API', label: '0 → 409 slot_taken, nothing written', kind: 'sync'},
      {from: 'Booking API', to: 'Redis hold map', label: 'confirm: slots → booked:{id} · DEL hold:{id}', kind: 'async'},
      {from: 'Sweeper', to: 'Redis hold map', label: 'release_hold once hold:{id} is gone', kind: 'sync'},
      {from: 'Redis hold map', to: 'Sweeper', label: 'freed only the slots still pointing at it', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-hold',
      title: 'Lets exactly one of two racing requests win',
      detail:
        'The check and the write run inside one `EVAL`/`EVALSHA`, so a request landing between them cannot see the same free slot. The starter asks `HEXISTS` from the client and writes with a later `HSET`.',
      match: {
        python: {
          all: [/redis\.call\(\s*'H(GET|EXISTS)'/, /redis\.call\(\s*'HSET'/, /register_script\(|\.eval\(|\.evalsha\(/],
          none: [/\.hexists\(/, /\.hset\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*'H(GET|EXISTS)'/, /redis\.call\(\s*'HSET'/, /defineCommand\(|\.eval\(|\.evalsha\(/],
          none: [/\.hexists\(/, /\.hset\(/],
        },
        go: {
          all: [/redis\.call\(\s*'H(GET|EXISTS)'/, /redis\.call\(\s*'HSET'/, /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/],
          none: [/\.HExists\(/, /\.HSet\(/],
        },
        scala: {
          all: [/redis\.call\(\s*'H(GET|EXISTS)'/, /redis\.call\(\s*'HSET'/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.hexists\(/, /jedis\.hset\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*'H(GET|EXISTS)'/, /redis\.call\(\s*'HSET'/, /\.eval(sha)?[<(]/],
          none: [/\.hexists\(/, /\.hset\(/],
        },
      },
    },
    {
      id: 'hold-ttl',
      title: 'Expires the hold after the 900 s payment window, never the map',
      detail:
        'The hold key is written with `EX` and the 900-second window; the slot map gets no `EXPIRE`, or confirmed bookings would vanish with it. The starter writes a hold key that never expires.',
      match: {
        python: {all: [/redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/redis\.call\(\s*'EXPIRE'/]},
        typescript: {all: [/redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/redis\.call\(\s*'EXPIRE'/]},
        go: {all: [/redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/redis\.call\(\s*'EXPIRE'/]},
        scala: {all: [/redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/redis\.call\(\s*'EXPIRE'/]},
        cpp: {all: [/redis\.call\(\s*'SET'[^\n]*'EX'/], none: [/redis\.call\(\s*'EXPIRE'/]},
      },
    },
    {
      id: 'single-winner',
      title: 'A refused request writes nothing',
      detail:
        'The script checks every requested slot before it writes the first one: a request refused on its second slot must not have taken its first. The starter checks and writes slot by slot.',
      match: {
        python: {order: [/return 0/, /redis\.call\(\s*'HSET'/]},
        typescript: {order: [/return 0/, /redis\.call\(\s*'HSET'/]},
        go: {order: [/return 0/, /redis\.call\(\s*'HSET'/]},
        scala: {order: [/return 0/, /redis\.call\(\s*'HSET'/]},
        cpp: {order: [/return 0/, /redis\.call\(\s*'HSET'/]},
      },
    },
    {
      id: 'release-guarded',
      title: 'Frees a slot only while it still points at this hold',
      detail:
        'The release compares each slot’s owner with the hold id inside the script and deletes only matches, so a slot a later request re-took stays taken. The starter deletes every slot it is handed.',
      match: {
        python: {all: [/redis\.call\(\s*'HGET'[^\n]*\)\s*[=~]=/, /redis\.call\(\s*'HDEL'/], none: [/\.hdel\(/]},
        typescript: {all: [/redis\.call\(\s*'HGET'[^\n]*\)\s*[=~]=/, /redis\.call\(\s*'HDEL'/], none: [/\.hdel\(/]},
        go: {all: [/redis\.call\(\s*'HGET'[^\n]*\)\s*[=~]=/, /redis\.call\(\s*'HDEL'/], none: [/\.HDel\(/]},
        scala: {all: [/redis\.call\(\s*'HGET'[^\n]*\)\s*[=~]=/, /redis\.call\(\s*'HDEL'/], none: [/jedis\.hdel\(/]},
        cpp: {all: [/redis\.call\(\s*'HGET'[^\n]*\)\s*[=~]=/, /redis\.call\(\s*'HDEL'/], none: [/\.hdel\(/]},
      },
    },
    {
      id: 'confirm-converts',
      title: 'Converts a confirmed hold without re-entering the free set',
      detail:
        'Confirmation rewrites each slot the hold owns to `booked:{booking_id}`; the map has no TTL, so the payment window cannot expire a booking. The starter only deletes the hold key, so the slots are free an hour later.',
      match: {
        python: {all: [/'booked:'\s*\.\./], none: [/redis\.call\(\s*'EXPIRE'/]},
        typescript: {all: [/'booked:'\s*\.\./], none: [/redis\.call\(\s*'EXPIRE'/]},
        go: {all: [/'booked:'\s*\.\./], none: [/redis\.call\(\s*'EXPIRE'/]},
        scala: {all: [/'booked:'\s*\.\./], none: [/redis\.call\(\s*'EXPIRE'/]},
        cpp: {all: [/'booked:'\s*\.\./], none: [/redis\.call\(\s*'EXPIRE'/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from booking.slots import HOLD_TTL_S, hold_key, slots_key
from booking.store import new_id

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def take_hold(resource_id: str, slot_fields: list[str]) -> dict | None:
    """Hold every slot of the range, or None when one is taken."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    hold_id = new_id()
    key = slots_key(resource_id)
    for field in slot_fields:
        if r.hexists(key, field):
            return None
        r.hset(key, field, hold_id)
    r.set(hold_key(hold_id), "held")
    return {"hold_id": hold_id, "expires_in": HOLD_TTL_S}


def confirm_hold(resource_id: str, slot_fields: list[str], hold_id: str, booking_id: str) -> int:
    """The payment went through: the hold is a booking now."""
    r.delete(hold_key(hold_id))
    return len(slot_fields)


def release_hold(resource_id: str, slot_fields: list[str], hold_id: str) -> int:
    """The sweeper's path, and the rejection path: give the slots back."""
    r.hdel(slots_key(resource_id), *slot_fields)
    r.delete(hold_key(hold_id))
    return len(slot_fields)
`,
      solution: `import redis

from booking.slots import HOLD_TTL_S, hold_key, slots_key
from booking.store import new_id

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# A slot is taken while its entry is a confirmed booking or a hold whose key still lives; the check
# and the write happen in the one script, so no request can land between them.
TAKE_HOLD_SCRIPT = """
local hold_id, ttl = ARGV[1], tonumber(ARGV[2])
for i = 3, #ARGV do
  local owner = redis.call('HGET', KEYS[1], ARGV[i])
  if owner and (string.sub(owner, 1, 7) == 'booked:' or redis.call('EXISTS', 'hold:' .. owner) == 1) then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], hold_id)
end
redis.call('SET', KEYS[2], 'held', 'EX', ttl)
return 1
"""

CONFIRM_HOLD_SCRIPT = """
local hold_id, booking_id = ARGV[1], ARGV[2]
local converted = 0
for i = 3, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HSET', KEYS[1], ARGV[i], 'booked:' .. booking_id)
    converted = converted + 1
  end
end
redis.call('DEL', KEYS[2])
return converted
"""

RELEASE_HOLD_SCRIPT = """
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HDEL', KEYS[1], ARGV[i])
    released = released + 1
  end
end
redis.call('DEL', KEYS[2])
return released
"""

take_hold_script = r.register_script(TAKE_HOLD_SCRIPT)
confirm_hold_script = r.register_script(CONFIRM_HOLD_SCRIPT)
release_hold_script = r.register_script(RELEASE_HOLD_SCRIPT)


def take_hold(resource_id: str, slot_fields: list[str]) -> dict | None:
    """Hold every slot of the range, or None when one is taken: one transition, nothing partial."""
    hold_id = new_id()
    held = take_hold_script(keys=[slots_key(resource_id), hold_key(hold_id)], args=[hold_id, HOLD_TTL_S, *slot_fields])
    if int(held) == 0:
        return None
    return {"hold_id": hold_id, "expires_in": HOLD_TTL_S}


def confirm_hold(resource_id: str, slot_fields: list[str], hold_id: str, booking_id: str) -> int:
    """The payment went through: each slot the hold still owns becomes booked:{booking_id}, for good."""
    return int(confirm_hold_script(keys=[slots_key(resource_id), hold_key(hold_id)], args=[hold_id, booking_id, *slot_fields]))


def release_hold(resource_id: str, slot_fields: list[str], hold_id: str) -> int:
    """The sweeper's path, and the rejection path: free only the slots that still point at this hold."""
    return int(release_hold_script(keys=[slots_key(resource_id), hold_key(hold_id)], args=[hold_id, *slot_fields]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {HOLD_TTL_S, holdKey, slotsKey} from 'booking/slots';
import {newId} from 'booking/store';

const redis = new Redis({host: 'redis', port: 6379});

export interface Hold {
  hold_id: string;
  expires_in: number;
}

/** Hold every slot of the range, or null when one is taken. */
export async function takeHold(resourceId: string, slotFields: string[]): Promise<Hold | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const holdId = newId();
  const key = slotsKey(resourceId);
  for (const field of slotFields) {
    if (await redis.hexists(key, field)) return null;
    await redis.hset(key, field, holdId);
  }
  await redis.set(holdKey(holdId), 'held');
  return {hold_id: holdId, expires_in: HOLD_TTL_S};
}

/** The payment went through: the hold is a booking now. */
export async function confirmHold(resourceId: string, slotFields: string[], holdId: string, bookingId: string): Promise<number> {
  await redis.del(holdKey(holdId));
  return slotFields.length;
}

/** The sweeper's path, and the rejection path: give the slots back. */
export async function releaseHold(resourceId: string, slotFields: string[], holdId: string): Promise<number> {
  await redis.hdel(slotsKey(resourceId), ...slotFields);
  await redis.del(holdKey(holdId));
  return slotFields.length;
}
`,
      solution: `import Redis from 'ioredis';

import {HOLD_TTL_S, holdKey, slotsKey} from 'booking/slots';
import {newId} from 'booking/store';

// A slot is taken while its entry is a confirmed booking or a hold whose key still lives; the check
// and the write happen in the one script, so no request can land between them.
const TAKE_HOLD_SCRIPT = \`
local hold_id, ttl = ARGV[1], tonumber(ARGV[2])
for i = 3, #ARGV do
  local owner = redis.call('HGET', KEYS[1], ARGV[i])
  if owner and (string.sub(owner, 1, 7) == 'booked:' or redis.call('EXISTS', 'hold:' .. owner) == 1) then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], hold_id)
end
redis.call('SET', KEYS[2], 'held', 'EX', ttl)
return 1
\`;

const CONFIRM_HOLD_SCRIPT = \`
local hold_id, booking_id = ARGV[1], ARGV[2]
local converted = 0
for i = 3, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HSET', KEYS[1], ARGV[i], 'booked:' .. booking_id)
    converted = converted + 1
  end
end
redis.call('DEL', KEYS[2])
return converted
\`;

const RELEASE_HOLD_SCRIPT = \`
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HDEL', KEYS[1], ARGV[i])
    released = released + 1
  end
end
redis.call('DEL', KEYS[2])
return released
\`;

interface HoldRedis extends Redis {
  takeHold(slotsKey: string, holdKey: string, holdId: string, ttl: number, ...fields: string[]): Promise<number>;
  confirmHold(slotsKey: string, holdKey: string, holdId: string, bookingId: string, ...fields: string[]): Promise<number>;
  releaseHold(slotsKey: string, holdKey: string, holdId: string, ...fields: string[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as HoldRedis;
redis.defineCommand('takeHold', {numberOfKeys: 2, lua: TAKE_HOLD_SCRIPT});
redis.defineCommand('confirmHold', {numberOfKeys: 2, lua: CONFIRM_HOLD_SCRIPT});
redis.defineCommand('releaseHold', {numberOfKeys: 2, lua: RELEASE_HOLD_SCRIPT});

export interface Hold {
  hold_id: string;
  expires_in: number;
}

/** Hold every slot of the range, or null when one is taken: one transition, nothing partial. */
export async function takeHold(resourceId: string, slotFields: string[]): Promise<Hold | null> {
  const holdId = newId();
  const held = await redis.takeHold(slotsKey(resourceId), holdKey(holdId), holdId, HOLD_TTL_S, ...slotFields);
  return held === 0 ? null : {hold_id: holdId, expires_in: HOLD_TTL_S};
}

/** The payment went through: each slot the hold still owns becomes booked:{bookingId}, for good. */
export async function confirmHold(resourceId: string, slotFields: string[], holdId: string, bookingId: string): Promise<number> {
  return redis.confirmHold(slotsKey(resourceId), holdKey(holdId), holdId, bookingId, ...slotFields);
}

/** The sweeper's path, and the rejection path: free only the slots that still point at this hold. */
export async function releaseHold(resourceId: string, slotFields: string[], holdId: string): Promise<number> {
  return redis.releaseHold(slotsKey(resourceId), holdKey(holdId), holdId, ...slotFields);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"booking/slots"
	"booking/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// takeHold holds every slot of the range, or returns nil when one is taken.
func takeHold(ctx context.Context, resourceID string, slotFields []string) (*store.Hold, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	holdID := store.NewID()
	key := slots.Key(resourceID)
	for _, field := range slotFields {
		taken, err := rdb.HExists(ctx, key, field).Result()
		if err != nil {
			return nil, err
		}
		if taken {
			return nil, nil
		}
		if err := rdb.HSet(ctx, key, field, holdID).Err(); err != nil {
			return nil, err
		}
	}
	if err := rdb.Set(ctx, slots.HoldKey(holdID), "held", 0).Err(); err != nil {
		return nil, err
	}
	return &store.Hold{HoldID: holdID, ExpiresIn: slots.HoldTTLS}, nil
}

// confirmHold: the payment went through, the hold is a booking now.
func confirmHold(ctx context.Context, resourceID string, slotFields []string, holdID, bookingID string) (int, error) {
	if err := rdb.Del(ctx, slots.HoldKey(holdID)).Err(); err != nil {
		return 0, err
	}
	return len(slotFields), nil
}

// releaseHold is the sweeper's path, and the rejection path: give the slots back.
func releaseHold(ctx context.Context, resourceID string, slotFields []string, holdID string) (int, error) {
	if err := rdb.HDel(ctx, slots.Key(resourceID), slotFields...).Err(); err != nil {
		return 0, err
	}
	if err := rdb.Del(ctx, slots.HoldKey(holdID)).Err(); err != nil {
		return 0, err
	}
	return len(slotFields), nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"booking/slots"
	"booking/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// A slot is taken while its entry is a confirmed booking or a hold whose key still lives; the check
// and the write happen in the one script, so no request can land between them.
var takeHoldScript = redis.NewScript(\`
local hold_id, ttl = ARGV[1], tonumber(ARGV[2])
for i = 3, #ARGV do
  local owner = redis.call('HGET', KEYS[1], ARGV[i])
  if owner and (string.sub(owner, 1, 7) == 'booked:' or redis.call('EXISTS', 'hold:' .. owner) == 1) then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], hold_id)
end
redis.call('SET', KEYS[2], 'held', 'EX', ttl)
return 1
\`)

var confirmHoldScript = redis.NewScript(\`
local hold_id, booking_id = ARGV[1], ARGV[2]
local converted = 0
for i = 3, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HSET', KEYS[1], ARGV[i], 'booked:' .. booking_id)
    converted = converted + 1
  end
end
redis.call('DEL', KEYS[2])
return converted
\`)

var releaseHoldScript = redis.NewScript(\`
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HDEL', KEYS[1], ARGV[i])
    released = released + 1
  end
end
redis.call('DEL', KEYS[2])
return released
\`)

func scriptArgs(head []any, fields []string) []any {
	for _, f := range fields {
		head = append(head, f)
	}
	return head
}

// takeHold holds every slot of the range, or returns nil when one is taken: one transition, nothing partial.
func takeHold(ctx context.Context, resourceID string, slotFields []string) (*store.Hold, error) {
	holdID := store.NewID()
	keys := []string{slots.Key(resourceID), slots.HoldKey(holdID)}
	args := scriptArgs([]any{holdID, slots.HoldTTLS}, slotFields)
	held, err := takeHoldScript.Run(ctx, rdb, keys, args...).Int()
	if err != nil {
		return nil, err
	}
	if held == 0 {
		return nil, nil
	}
	return &store.Hold{HoldID: holdID, ExpiresIn: slots.HoldTTLS}, nil
}

// confirmHold: the payment went through, each slot the hold still owns becomes booked:{bookingID}, for good.
func confirmHold(ctx context.Context, resourceID string, slotFields []string, holdID, bookingID string) (int, error) {
	keys := []string{slots.Key(resourceID), slots.HoldKey(holdID)}
	args := scriptArgs([]any{holdID, bookingID}, slotFields)
	return confirmHoldScript.Run(ctx, rdb, keys, args...).Int()
}

// releaseHold is the sweeper's path, and the rejection path: free only the slots that still point at this hold.
func releaseHold(ctx context.Context, resourceID string, slotFields []string, holdID string) (int, error) {
	keys := []string{slots.Key(resourceID), slots.HoldKey(holdID)}
	args := scriptArgs([]any{holdID}, slotFields)
	return releaseHoldScript.Run(ctx, rdb, keys, args...).Int()
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._

import booking.{Slots, Store}
import redis.clients.jedis.JedisPooled

final case class Hold(hold_id: String, expires_in: Int)

object HoldMap {
  val jedis = new JedisPooled("redis", 6379)

  /** Hold every slot of the range, or None when one is taken. */
  def takeHold(resourceId: String, slotFields: Seq[String]): Option[Hold] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val holdId = Store.newId()
    val key = Slots.key(resourceId)
    for (field <- slotFields) {
      if (jedis.hexists(key, field)) return None
      jedis.hset(key, field, holdId)
    }
    jedis.set(Slots.holdKey(holdId), "held")
    Some(Hold(holdId, Slots.HoldTtlS))
  }

  /** The payment went through: the hold is a booking now. */
  def confirmHold(resourceId: String, slotFields: Seq[String], holdId: String, bookingId: String): Long = {
    jedis.del(Slots.holdKey(holdId))
    slotFields.size.toLong
  }

  /** The sweeper's path, and the rejection path: give the slots back. */
  def releaseHold(resourceId: String, slotFields: Seq[String], holdId: String): Long = {
    jedis.hdel(Slots.key(resourceId), slotFields: _*)
    jedis.del(Slots.holdKey(holdId))
    slotFields.size.toLong
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import booking.{Slots, Store}
import redis.clients.jedis.JedisPooled

final case class Hold(hold_id: String, expires_in: Int)

object HoldMap {
  val jedis = new JedisPooled("redis", 6379)

  // A slot is taken while its entry is a confirmed booking or a hold whose key still lives; the check
  // and the write happen in the one script, so no request can land between them.
  val TakeHoldScript: String =
    """
      |local hold_id, ttl = ARGV[1], tonumber(ARGV[2])
      |for i = 3, #ARGV do
      |  local owner = redis.call('HGET', KEYS[1], ARGV[i])
      |  if owner and (string.sub(owner, 1, 7) == 'booked:' or redis.call('EXISTS', 'hold:' .. owner) == 1) then
      |    return 0
      |  end
      |end
      |for i = 3, #ARGV do
      |  redis.call('HSET', KEYS[1], ARGV[i], hold_id)
      |end
      |redis.call('SET', KEYS[2], 'held', 'EX', ttl)
      |return 1
      |""".stripMargin

  val ConfirmHoldScript: String =
    """
      |local hold_id, booking_id = ARGV[1], ARGV[2]
      |local converted = 0
      |for i = 3, #ARGV do
      |  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
      |    redis.call('HSET', KEYS[1], ARGV[i], 'booked:' .. booking_id)
      |    converted = converted + 1
      |  end
      |end
      |redis.call('DEL', KEYS[2])
      |return converted
      |""".stripMargin

  val ReleaseHoldScript: String =
    """
      |local hold_id = ARGV[1]
      |local released = 0
      |for i = 2, #ARGV do
      |  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
      |    redis.call('HDEL', KEYS[1], ARGV[i])
      |    released = released + 1
      |  end
      |end
      |redis.call('DEL', KEYS[2])
      |return released
      |""".stripMargin

  private def run(script: String, resourceId: String, holdId: String, args: Seq[String]): Long =
    jedis.eval(script, List(Slots.key(resourceId), Slots.holdKey(holdId)).asJava, args.asJava).asInstanceOf[Long]

  /** Hold every slot of the range, or None when one is taken: one transition, nothing partial. */
  def takeHold(resourceId: String, slotFields: Seq[String]): Option[Hold] = {
    val holdId = Store.newId()
    val held = run(TakeHoldScript, resourceId, holdId, Seq(holdId, Slots.HoldTtlS.toString) ++ slotFields)
    if (held == 0L) None else Some(Hold(holdId, Slots.HoldTtlS))
  }

  /** The payment went through: each slot the hold still owns becomes booked:{bookingId}, for good. */
  def confirmHold(resourceId: String, slotFields: Seq[String], holdId: String, bookingId: String): Long =
    run(ConfirmHoldScript, resourceId, holdId, Seq(holdId, bookingId) ++ slotFields)

  /** The sweeper's path, and the rejection path: free only the slots that still point at this hold. */
  def releaseHold(resourceId: String, slotFields: Seq[String], holdId: String): Long =
    run(ReleaseHoldScript, resourceId, holdId, Seq(holdId) ++ slotFields)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

#include "booking/slots.h"
#include "booking/store.h"

sw::redis::Redis redis("tcp://redis:6379");

using booking::Hold;

// Hold every slot of the range, or nothing when one is taken.
std::optional<Hold> takeHold(const std::string& resource_id, const std::vector<std::string>& slot_fields) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string hold_id = booking::NewId();
  const std::string key = booking::slots::Key(resource_id);
  for (const auto& field : slot_fields) {
    if (redis.hexists(key, field)) return std::nullopt;
    redis.hset(key, field, hold_id);
  }
  redis.set(booking::slots::HoldKey(hold_id), "held");
  return Hold{hold_id, booking::slots::kHoldTtlS};
}

// The payment went through: the hold is a booking now.
long long confirmHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id, const std::string& booking_id) {
  redis.del(booking::slots::HoldKey(hold_id));
  return static_cast<long long>(slot_fields.size());
}

// The sweeper's path, and the rejection path: give the slots back.
long long releaseHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id) {
  redis.hdel(booking::slots::Key(resource_id), slot_fields.begin(), slot_fields.end());
  redis.del(booking::slots::HoldKey(hold_id));
  return static_cast<long long>(slot_fields.size());
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

#include "booking/slots.h"
#include "booking/store.h"

sw::redis::Redis redis("tcp://redis:6379");

// A slot is taken while its entry is a confirmed booking or a hold whose key still lives; the check
// and the write happen in the one script, so no request can land between them.
const std::string kTakeHoldScript = R"lua(
local hold_id, ttl = ARGV[1], tonumber(ARGV[2])
for i = 3, #ARGV do
  local owner = redis.call('HGET', KEYS[1], ARGV[i])
  if owner and (string.sub(owner, 1, 7) == 'booked:' or redis.call('EXISTS', 'hold:' .. owner) == 1) then
    return 0
  end
end
for i = 3, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], hold_id)
end
redis.call('SET', KEYS[2], 'held', 'EX', ttl)
return 1
)lua";

const std::string kConfirmHoldScript = R"lua(
local hold_id, booking_id = ARGV[1], ARGV[2]
local converted = 0
for i = 3, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HSET', KEYS[1], ARGV[i], 'booked:' .. booking_id)
    converted = converted + 1
  end
end
redis.call('DEL', KEYS[2])
return converted
)lua";

const std::string kReleaseHoldScript = R"lua(
local hold_id = ARGV[1]
local released = 0
for i = 2, #ARGV do
  if redis.call('HGET', KEYS[1], ARGV[i]) == hold_id then
    redis.call('HDEL', KEYS[1], ARGV[i])
    released = released + 1
  end
end
redis.call('DEL', KEYS[2])
return released
)lua";

using booking::Hold;

static std::vector<std::string> scriptArgs(std::vector<std::string> head, const std::vector<std::string>& fields) {
  head.insert(head.end(), fields.begin(), fields.end());
  return head;
}

// Hold every slot of the range, or nothing when one is taken: one transition, nothing partial.
std::optional<Hold> takeHold(const std::string& resource_id, const std::vector<std::string>& slot_fields) {
  const std::string hold_id = booking::NewId();
  const std::vector<std::string> keys = {booking::slots::Key(resource_id), booking::slots::HoldKey(hold_id)};
  const long long held = redis.eval<long long>(
      kTakeHoldScript, keys, scriptArgs({hold_id, std::to_string(booking::slots::kHoldTtlS)}, slot_fields));
  if (held == 0) return std::nullopt;
  return Hold{hold_id, booking::slots::kHoldTtlS};
}

// The payment went through: each slot the hold still owns becomes booked:{booking_id}, for good.
long long confirmHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id, const std::string& booking_id) {
  const std::vector<std::string> keys = {booking::slots::Key(resource_id), booking::slots::HoldKey(hold_id)};
  return redis.eval<long long>(kConfirmHoldScript, keys, scriptArgs({hold_id, booking_id}, slot_fields));
}

// The sweeper's path, and the rejection path: free only the slots that still point at this hold.
long long releaseHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id) {
  const std::vector<std::string> keys = {booking::slots::Key(resource_id), booking::slots::HoldKey(hold_id)};
  return redis.eval<long long>(kReleaseHoldScript, keys, scriptArgs({hold_id}, slot_fields));
}
`,
    },
  },
  harness: {
    python: `from booking.slots import hold_key, slots_key

R = "r1"
F = ["29520480", "29520510", "29520540", "29520570"]  # four consecutive 30-minute slots, as epoch minutes


def _owner(ctx, field):
    return ctx.redis.hget(slots_key(R), field)


def check_atomic_hold(ctx):
    m = ctx.load("state")
    # Another instance's request for the same slot lands right after the learner's first command on
    # the map, before the next one: it takes the slot if it is free.
    def other_request():
        won = ctx.redis.hsetnx(slots_key(R), F[0], "h-other")
        if won:
            ctx.redis.set(hold_key("h-other"), "held", ex=900)
        return int(won)

    probe = ctx.redis_after(slots_key(R), other_request)
    hold = m.take_hold(R, [F[0]])
    assert probe.fired, "take_hold never touched resource:r1:slots"
    winners = probe.result + (1 if hold is not None else 0)
    assert winners == 1, f"two requests for one slot and {winners} won: the other request took the slot between your check and your write, so the check and the write must be one Lua script"
    expected = "h-other" if probe.result else hold["hold_id"]
    assert _owner(ctx, F[0]) == expected, f"the slot points at {_owner(ctx, F[0])!r} but {expected!r} won it"


def check_hold_ttl(ctx):
    m = ctx.load("state")
    hold = m.take_hold(R, F[:2])
    assert hold is not None, "take_hold refused a free range"
    ttl = ctx.redis.ttl(hold_key(hold["hold_id"]))
    assert 850 <= ttl <= 900, f"hold:{{id}} has TTL {ttl}, expected the 900 s payment window (SET … EX 900 in the script)"
    assert ctx.redis.ttl(slots_key(R)) == -1, f"resource:r1:slots has TTL {ctx.redis.ttl(slots_key(R))}: the map carries confirmed bookings and must never expire"
    ctx.clock.advance(901)
    assert ctx.redis.exists(hold_key(hold["hold_id"])) == 0, "hold:{id} is still there after the payment window"
    again = m.take_hold(R, F[:2])
    assert again is not None, "the hold expired but take_hold still refuses the slots: a slot whose hold:{id} key is gone is free again"


def check_single_winner(ctx):
    m = ctx.load("state")
    first = m.take_hold(R, [F[1], F[2]])
    assert first is not None, "take_hold refused a free range"
    second = m.take_hold(R, [F[0], F[1]])
    assert second is None, f"a range overlapping a held slot was granted ({second})"
    assert _owner(ctx, F[0]) is None, f"the refused request still wrote slot {F[0]} (owner {_owner(ctx, F[0])!r}) before it saw {F[1]} was taken: check every slot, then write"
    holds = ctx.redis.keys("hold:*")
    assert holds == [hold_key(first["hold_id"])], f"hold keys after one granted and one refused request: {holds}, expected only the first"


def check_release_guarded(ctx):
    m = ctx.load("state")
    first = m.take_hold(R, [F[1], F[2]])
    assert first is not None, "take_hold refused a free range"
    ctx.clock.advance(901)  # the first checkout was abandoned
    second = m.take_hold(R, [F[2], F[3]])
    assert second is not None, f"slot {F[2]} points at an expired hold and must be free again"
    freed = m.release_hold(R, [F[1], F[2]], first["hold_id"])
    assert _owner(ctx, F[2]) == second["hold_id"], f"the sweeper freed slot {F[2]} (owner now {_owner(ctx, F[2])!r}) which a later request holds: release only the slots still pointing at this hold"
    assert _owner(ctx, F[1]) is None, f"slot {F[1]} still points at {_owner(ctx, F[1])!r} after its hold was released"
    assert freed == 1, f"release_hold reported {freed} freed slots, expected 1"


def check_confirm_converts(ctx):
    m = ctx.load("state")
    hold = m.take_hold(R, [F[0], F[1]])
    assert hold is not None, "take_hold refused a free range"
    m.confirm_hold(R, [F[0], F[1]], hold["hold_id"], "b-1")
    owners = [_owner(ctx, f) for f in F[:2]]
    assert owners == ["booked:b-1", "booked:b-1"], f"after confirmation the slots point at {owners}, expected booked:b-1"
    ctx.clock.advance(3601)  # the payment window is long over
    owners = [_owner(ctx, f) for f in F[:2]]
    assert owners == ["booked:b-1", "booked:b-1"], f"an hour after confirmation the slots point at {owners}: a confirmed booking must never expire back into the free set"
    assert m.take_hold(R, [F[0]]) is None, "a confirmed slot was granted to a new hold"
    assert ctx.redis.ttl(slots_key(R)) == -1, f"resource:r1:slots has TTL {ctx.redis.ttl(slots_key(R))}: the map must never expire"
`,
    typescript: `import {holdKey, slotsKey} from 'booking/slots';

const R = 'r1';
const F = ['29520480', '29520510', '29520540', '29520570']; // four consecutive 30-minute slots, as epoch minutes

const owner = (ctx, field: string): string | null => ctx.redis.hget(slotsKey(R), field) as string | null;

export async function check_atomic_hold(ctx) {
  const m = ctx.load('state');
  // Another instance's request for the same slot lands right after the learner's first command on
  // the map, before the next one: it takes the slot if it is free.
  const probe = ctx.redisAfter(slotsKey(R), () => {
    const won = Number(ctx.redis.hsetnx(slotsKey(R), F[0], 'h-other'));
    if (won === 1) ctx.redis.set(holdKey('h-other'), 'held', 'EX', 900);
    return won;
  });
  const hold = await m.takeHold(R, [F[0]]);
  assert(probe.fired, 'takeHold never touched resource:r1:slots');
  const winners = (probe.result as number) + (hold !== null ? 1 : 0);
  assert.equal(winners, 1, \`two requests for one slot and \${winners} won: the other request took the slot between your check and your write, so the check and the write must be one Lua script\`);
  const expected = probe.result === 1 ? 'h-other' : hold.hold_id;
  assert.equal(owner(ctx, F[0]), expected, \`the slot points at \${JSON.stringify(owner(ctx, F[0]))} but \${expected} won it\`);
}

export async function check_hold_ttl(ctx) {
  const m = ctx.load('state');
  const hold = await m.takeHold(R, F.slice(0, 2));
  assert(hold !== null, 'takeHold refused a free range');
  const ttl = ctx.redis.ttl(holdKey(hold.hold_id));
  assert(850 <= ttl && ttl <= 900, \`hold:{id} has TTL \${ttl}, expected the 900 s payment window (SET … EX 900 in the script)\`);
  assert.equal(ctx.redis.ttl(slotsKey(R)), -1, \`resource:r1:slots has TTL \${ctx.redis.ttl(slotsKey(R))}: the map carries confirmed bookings and must never expire\`);
  ctx.clock.advance(901);
  assert.equal(ctx.redis.exists(holdKey(hold.hold_id)), 0, 'hold:{id} is still there after the payment window');
  const again = await m.takeHold(R, F.slice(0, 2));
  assert(again !== null, 'the hold expired but takeHold still refuses the slots: a slot whose hold:{id} key is gone is free again');
}

export async function check_single_winner(ctx) {
  const m = ctx.load('state');
  const first = await m.takeHold(R, [F[1], F[2]]);
  assert(first !== null, 'takeHold refused a free range');
  const second = await m.takeHold(R, [F[0], F[1]]);
  assert.equal(second, null, \`a range overlapping a held slot was granted (\${JSON.stringify(second)})\`);
  assert.equal(owner(ctx, F[0]), null, \`the refused request still wrote slot \${F[0]} (owner \${JSON.stringify(owner(ctx, F[0]))}) before it saw \${F[1]} was taken: check every slot, then write\`);
  const holds = ctx.redis.keys('hold:*');
  assert.deepEqual(holds, [holdKey(first.hold_id)], \`hold keys after one granted and one refused request: \${JSON.stringify(holds)}, expected only the first\`);
}

export async function check_release_guarded(ctx) {
  const m = ctx.load('state');
  const first = await m.takeHold(R, [F[1], F[2]]);
  assert(first !== null, 'takeHold refused a free range');
  ctx.clock.advance(901); // the first checkout was abandoned
  const second = await m.takeHold(R, [F[2], F[3]]);
  assert(second !== null, \`slot \${F[2]} points at an expired hold and must be free again\`);
  const freed = await m.releaseHold(R, [F[1], F[2]], first.hold_id);
  assert.equal(owner(ctx, F[2]), second.hold_id, \`the sweeper freed slot \${F[2]} (owner now \${JSON.stringify(owner(ctx, F[2]))}) which a later request holds: release only the slots still pointing at this hold\`);
  assert.equal(owner(ctx, F[1]), null, \`slot \${F[1]} still points at \${JSON.stringify(owner(ctx, F[1]))} after its hold was released\`);
  assert.equal(freed, 1, \`releaseHold reported \${freed} freed slots, expected 1\`);
}

export async function check_confirm_converts(ctx) {
  const m = ctx.load('state');
  const hold = await m.takeHold(R, [F[0], F[1]]);
  assert(hold !== null, 'takeHold refused a free range');
  await m.confirmHold(R, [F[0], F[1]], hold.hold_id, 'b-1');
  let owners = F.slice(0, 2).map(f => owner(ctx, f));
  assert.deepEqual(owners, ['booked:b-1', 'booked:b-1'], \`after confirmation the slots point at \${JSON.stringify(owners)}, expected booked:b-1\`);
  ctx.clock.advance(3601); // the payment window is long over
  owners = F.slice(0, 2).map(f => owner(ctx, f));
  assert.deepEqual(owners, ['booked:b-1', 'booked:b-1'], \`an hour after confirmation the slots point at \${JSON.stringify(owners)}: a confirmed booking must never expire back into the free set\`);
  assert.equal(await m.takeHold(R, [F[0]]), null, 'a confirmed slot was granted to a new hold');
  assert.equal(ctx.redis.ttl(slotsKey(R)), -1, \`resource:r1:slots has TTL \${ctx.redis.ttl(slotsKey(R))}: the map must never expire\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"

	"booking/slots"
	"booking/store"
)

const stateResource = "r1"

// Four consecutive 30-minute slots, as epoch minutes.
var stateFields = []string{"29520480", "29520510", "29520540", "29520570"}

func stateOwner(ctx *harness.Ctx, field string) (string, bool) {
	return ctx.Redis.HGet(slots.Key(stateResource), field)
}

func stateHold(ctx *harness.Ctx, fields []string) *store.Hold {
	hold, err := takeHold(context.Background(), stateResource, fields)
	ctx.NoError(err, "takeHold")
	return hold
}

func CheckAtomicHold(ctx *harness.Ctx) {
	// Another instance's request for the same slot lands right after the learner's first command on
	// the map, before the next one: it takes the slot if it is free.
	won := int64(0)
	ctx.Redis.After(slots.Key(stateResource), func() any {
		if v, ok := ctx.Redis.Do("HSETNX", slots.Key(stateResource), stateFields[0], "h-other").(int64); ok {
			won = v
		}
		if won == 1 {
			ctx.Redis.Do("SET", slots.HoldKey("h-other"), "held", "EX", 900)
		}
		return won
	})
	hold := stateHold(ctx, stateFields[:1])
	winners := int(won)
	if hold != nil {
		winners++
	}
	ctx.Assert(winners == 1, "two requests for one slot and %d won: the other request took the slot between your check and your write, so the check and the write must be one Lua script", winners)
	expected := "h-other"
	if won == 0 {
		expected = hold.HoldID
	}
	owner, _ := stateOwner(ctx, stateFields[0])
	ctx.Equal(owner, expected, "the slot's owner must be the request that won it")
}

func CheckHoldTtl(ctx *harness.Ctx) {
	hold := stateHold(ctx, stateFields[:2])
	ctx.Assert(hold != nil, "takeHold refused a free range")
	ttl := ctx.Redis.TTL(slots.HoldKey(hold.HoldID))
	ctx.Assert(850 <= ttl && ttl <= 900, "hold:{id} has TTL %d, expected the 900 s payment window (SET … EX 900 in the script)", ttl)
	ctx.Equal(ctx.Redis.TTL(slots.Key(stateResource)), -1, "resource:r1:slots carries confirmed bookings and must never expire; its TTL")
	ctx.Clock.Advance(901)
	ctx.Equal(ctx.Redis.Exists(slots.HoldKey(hold.HoldID)), 0, "hold:{id} after the payment window")
	again := stateHold(ctx, stateFields[:2])
	ctx.Assert(again != nil, "the hold expired but takeHold still refuses the slots: a slot whose hold:{id} key is gone is free again")
}

func CheckSingleWinner(ctx *harness.Ctx) {
	first := stateHold(ctx, []string{stateFields[1], stateFields[2]})
	ctx.Assert(first != nil, "takeHold refused a free range")
	second := stateHold(ctx, []string{stateFields[0], stateFields[1]})
	ctx.Assert(second == nil, "a range overlapping a held slot was granted (%v)", second)
	owner, written := stateOwner(ctx, stateFields[0])
	ctx.Assert(!written, "the refused request still wrote slot %s (owner %q) before it saw %s was taken: check every slot, then write", stateFields[0], owner, stateFields[1])
	ctx.Equal(ctx.Redis.Keys("hold:*"), []string{slots.HoldKey(first.HoldID)}, "hold keys after one granted and one refused request (expected only the first)")
}

func CheckReleaseGuarded(ctx *harness.Ctx) {
	first := stateHold(ctx, []string{stateFields[1], stateFields[2]})
	ctx.Assert(first != nil, "takeHold refused a free range")
	ctx.Clock.Advance(901) // the first checkout was abandoned
	second := stateHold(ctx, []string{stateFields[2], stateFields[3]})
	ctx.Assert(second != nil, "slot %s points at an expired hold and must be free again", stateFields[2])
	freed, err := releaseHold(context.Background(), stateResource, []string{stateFields[1], stateFields[2]}, first.HoldID)
	ctx.NoError(err, "releaseHold")
	owner, _ := stateOwner(ctx, stateFields[2])
	ctx.Assert(owner == second.HoldID, "the sweeper freed slot %s (owner now %q) which a later request holds: release only the slots still pointing at this hold", stateFields[2], owner)
	owner, written := stateOwner(ctx, stateFields[1])
	ctx.Assert(!written, "slot %s still points at %q after its hold was released", stateFields[1], owner)
	ctx.Equal(freed, 1, "releaseHold's count of freed slots")
}

func CheckConfirmConverts(ctx *harness.Ctx) {
	hold := stateHold(ctx, stateFields[:2])
	ctx.Assert(hold != nil, "takeHold refused a free range")
	_, err := confirmHold(context.Background(), stateResource, stateFields[:2], hold.HoldID, "b-1")
	ctx.NoError(err, "confirmHold")
	owners := func() []string {
		a, _ := stateOwner(ctx, stateFields[0])
		b, _ := stateOwner(ctx, stateFields[1])
		return []string{a, b}
	}
	ctx.Equal(owners(), []string{"booked:b-1", "booked:b-1"}, "the slots after confirmation")
	ctx.Clock.Advance(3601) // the payment window is long over
	ctx.Equal(owners(), []string{"booked:b-1", "booked:b-1"}, "the slots an hour after confirmation (a confirmed booking must never expire back into the free set)")
	ctx.Assert(stateHold(ctx, stateFields[:1]) == nil, "a confirmed slot was granted to a new hold")
	ctx.Equal(ctx.Redis.TTL(slots.Key(stateResource)), -1, "resource:r1:slots must never expire; its TTL")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kStateResource = "r1";
// Four consecutive 30-minute slots, as epoch minutes.
const std::vector<std::string> kStateFields = {"29520480", "29520510", "29520540", "29520570"};

std::optional<std::string> stateOwner(harness::Ctx& ctx, const std::string& field) {
  return ctx.Redis.HGet(booking::slots::Key(kStateResource), field);
}

}  // namespace

void CheckAtomicHold(harness::Ctx& ctx) {
  // Another instance's request for the same slot lands right after the learner's first command on
  // the map, before the next one: it takes the slot if it is free.
  long long won = 0;
  ctx.Redis.After(booking::slots::Key(kStateResource), [&] {
    won = ctx.Redis.Do("HSETNX", booking::slots::Key(kStateResource), kStateFields[0], "h-other").Int();
    if (won == 1) ctx.Redis.Do("SET", booking::slots::HoldKey("h-other"), "held", "EX", 900);
  });
  const auto hold = takeHold(kStateResource, {kStateFields[0]});
  const int winners = static_cast<int>(won) + (hold ? 1 : 0);
  ctx.Assert(winners == 1,
             "two requests for one slot and %d won: the other request took the slot between your check and your "
             "write, so the check and the write must be one Lua script",
             winners);
  const std::string expected = won == 1 ? "h-other" : hold->hold_id;
  ctx.Equal(stateOwner(ctx, kStateFields[0]), expected, "the slot's owner must be the request that won it");
}

void CheckHoldTtl(harness::Ctx& ctx) {
  const auto hold = takeHold(kStateResource, {kStateFields[0], kStateFields[1]});
  ctx.Assert(hold.has_value(), "takeHold refused a free range");
  const long long ttl = ctx.Redis.TTL(booking::slots::HoldKey(hold->hold_id));
  ctx.Assert(850 <= ttl && ttl <= 900, "hold:{id} has TTL %d, expected the 900 s payment window (SET … EX 900 in the script)", ttl);
  ctx.Equal(ctx.Redis.TTL(booking::slots::Key(kStateResource)), -1,
            "resource:r1:slots carries confirmed bookings and must never expire; its TTL");
  ctx.Clock.Advance(901);
  ctx.Equal(ctx.Redis.Exists(booking::slots::HoldKey(hold->hold_id)), 0, "hold:{id} after the payment window");
  const auto again = takeHold(kStateResource, {kStateFields[0], kStateFields[1]});
  ctx.Assert(again.has_value(),
             "the hold expired but takeHold still refuses the slots: a slot whose hold:{id} key is gone is free again");
}

void CheckSingleWinner(harness::Ctx& ctx) {
  const auto first = takeHold(kStateResource, {kStateFields[1], kStateFields[2]});
  ctx.Assert(first.has_value(), "takeHold refused a free range");
  const auto second = takeHold(kStateResource, {kStateFields[0], kStateFields[1]});
  ctx.Assert(!second.has_value(), "a range overlapping a held slot was granted (%s)", second ? second->hold_id : "");
  const auto owner = stateOwner(ctx, kStateFields[0]);
  ctx.Assert(!owner.has_value(),
             "the refused request still wrote slot %s (owner %q) before it saw %s was taken: check every slot, then write",
             kStateFields[0], owner, kStateFields[1]);
  ctx.Equal(ctx.Redis.Keys("hold:*"), {booking::slots::HoldKey(first->hold_id)},
            "hold keys after one granted and one refused request (expected only the first)");
}

void CheckReleaseGuarded(harness::Ctx& ctx) {
  const auto first = takeHold(kStateResource, {kStateFields[1], kStateFields[2]});
  ctx.Assert(first.has_value(), "takeHold refused a free range");
  ctx.Clock.Advance(901);  // the first checkout was abandoned
  const auto second = takeHold(kStateResource, {kStateFields[2], kStateFields[3]});
  ctx.Assert(second.has_value(), "slot %s points at an expired hold and must be free again", kStateFields[2]);
  const long long freed = releaseHold(kStateResource, {kStateFields[1], kStateFields[2]}, first->hold_id);
  const auto owner = stateOwner(ctx, kStateFields[2]);
  ctx.Assert(owner == second->hold_id,
             "the sweeper freed slot %s (owner now %q) which a later request holds: release only the slots still "
             "pointing at this hold",
             kStateFields[2], owner);
  const auto freedOwner = stateOwner(ctx, kStateFields[1]);
  ctx.Assert(!freedOwner.has_value(), "slot %s still points at %q after its hold was released", kStateFields[1], freedOwner);
  ctx.Equal(freed, 1, "releaseHold's count of freed slots");
}

void CheckConfirmConverts(harness::Ctx& ctx) {
  const auto hold = takeHold(kStateResource, {kStateFields[0], kStateFields[1]});
  ctx.Assert(hold.has_value(), "takeHold refused a free range");
  confirmHold(kStateResource, {kStateFields[0], kStateFields[1]}, hold->hold_id, "b-1");
  const auto owners = [&] {
    return std::vector<std::string>{stateOwner(ctx, kStateFields[0]).value_or(""),
                                    stateOwner(ctx, kStateFields[1]).value_or("")};
  };
  ctx.Equal(owners(), {"booked:b-1", "booked:b-1"}, "the slots after confirmation");
  ctx.Clock.Advance(3601);  // the payment window is long over
  ctx.Equal(owners(), {"booked:b-1", "booked:b-1"},
            "the slots an hour after confirmation (a confirmed booking must never expire back into the free set)");
  ctx.Assert(!takeHold(kStateResource, {kStateFields[0]}).has_value(), "a confirmed slot was granted to a new hold");
  ctx.Equal(ctx.Redis.TTL(booking::slots::Key(kStateResource)), -1, "resource:r1:slots must never expire; its TTL");
}
`,
  },
  hints: [
    'Two guests click "book" on the same hour within the same second; both see a confirmation page. A week later the room is double-booked, and a checkout abandoned on Monday still blocks Friday.',
    'Between `HEXISTS` and `HSET` the other request runs the same `HEXISTS` and also sees a free slot. Redis runs one Lua script at a time: a check and a write inside one script cannot interleave.',
    'Move check-all-then-write-all into one script that ends with `SET hold:{id} held EX 900`; treat an owner as taken only if it is `booked:…` or its `hold:` key exists; confirm rewrites to `booked:{id}`; release compares before `HDEL`.',
  ],
  debrief: `The hold map is one hash and one script because the question "are all of these free, and if so, take them" has to be answered by something that runs with nothing in between, and Redis executes a script that way. The TTL lives on the hold key and not on the map for the same reason the confirm script rewrites the slots instead of deleting them: the map is the record of bookings, and a record of bookings must not expire. The guarded release follows from that too, since a slot can change hands between a hold's expiry and the sweeper's visit. Production systems run the sweeper from keyspace notifications or a cron, keep a second index from hold id to its slots so the sweeper needs no argument list, and shard the map by resource and month before one hash grows past a few thousand fields.`,
};
