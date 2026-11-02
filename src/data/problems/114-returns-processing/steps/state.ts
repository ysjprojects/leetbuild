import type {Step} from '@/lib/types';

/**
 * Step 2 — the returnable counter. One atomic script per state change: register rejects, decrements
 * and records the return together, and cancel restores exactly what its return consumed, once.
 */
export const stateStep: Step = {
  id: 'state',
  title: 'Redis returnable quantities with atomic decrements',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter owns the Redis state behind the returns API: \`register_return\`
reads the counter at \`line:{order_line_id}:returnable\`, compares, \`DECRBY\`s it, then \`HSET\`s
the record at \`return:{return_id}\`; \`cancel_return\` reads the record's quantity and \`INCRBY\`s
it back. It compiles, serves the demo, and hides 5 flaws.

**Failure mode the checks target.** Two returns for the same line arrive in the same millisecond
and both take the last unit; a crash between the decrement and the record leaves a unit nobody can
cancel; a replayed cancel inflates the line past its ordered quantity.

- The counter is seeded to the ordered quantity when the line is delivered. The record hash carries
  at least \`line_id\`, \`quantity\`, \`reason_code\`, \`photo_ref\` and \`state\`.
- \`register_return\` rejects, decrements and records in **one Lua script run through \`EVAL\`**. A
  quantity above what remains makes the script return \`quantity_exceeds_remaining\` with the
  remaining count and touch nothing; otherwise the script \`DECRBY\`s the counter and \`HSET\`s the
  record with \`state = 'registered'\` in the same execution.
- \`cancel_return(order_line_id, return_id)\` restores **exactly what its return consumed**: the
  script reads the record's own \`quantity\`, \`INCRBY\`s the counter by it and marks the record
  \`canceled\`. The restore amount is never anything the caller sends.
- A **second cancel restores nothing**: the script sees \`state == 'canceled'\` and returns
  \`already_canceled\` with 0 restored.
- No client-side read-then-write path remains: no \`GET\`/\`HGET\` in one round trip followed by a
  \`DECRBY\`/\`INCRBY\`/\`HSET\` in the next.`,
  sequence: {
    participants: ['Returns API', 'Redis', 'Returns consumer'],
    messages: [
      {
        from: 'Returns API',
        to: 'Redis',
        label: 'EVAL register · line:17:returnable · return:ret_9f3 · qty 1',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Returns API',
        label: "DECRBY + HSET in the same script · 'quantity_exceeds_remaining' when the line is short",
        kind: 'reply',
      },
      {
        from: 'Returns consumer',
        to: 'Redis',
        label: 'EVAL cancel · return:ret_9f3 · reads quantity, marks canceled',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Returns consumer',
        label: 'restored = 1 · 0 when already canceled',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-decrement',
      title: 'Rejects and decrements inside one atomic script',
      detail:
        'The remaining quantity is read, compared and decremented inside one Lua script run through `EVAL`, and a quantity above what remains returns `quantity_exceeds_remaining` before the counter is touched. The starter reads with a client-side `GET` and decrements with a separate `DECRBY`, so two concurrent returns both pass the last unit.',
      match: {
        python: {
          all: [/RETURNS_LUA/, /\.eval\(/, /redis\.call\('GET'/, /redis\.call\('DECRBY'/, /quantity_exceeds_remaining/],
          order: [/quantity_exceeds_remaining/, /redis\.call\('DECRBY'/],
        },
        typescript: {
          all: [/RETURNS_LUA/, /\.eval\(/, /redis\.call\('GET'/, /redis\.call\('DECRBY'/, /quantity_exceeds_remaining/],
          order: [/quantity_exceeds_remaining/, /redis\.call\('DECRBY'/],
        },
        go: {
          all: [/returnsLua/, /\.Eval\(/, /redis\.call\('GET'/, /redis\.call\('DECRBY'/, /quantity_exceeds_remaining/],
          order: [/quantity_exceeds_remaining/, /redis\.call\('DECRBY'/],
        },
        scala: {
          all: [/ReturnsLua/, /\.eval\(/, /redis\.call\('GET'/, /redis\.call\('DECRBY'/, /quantity_exceeds_remaining/],
          order: [/quantity_exceeds_remaining/, /redis\.call\('DECRBY'/],
        },
        cpp: {
          all: [
            /kReturnsLua/,
            /redisCommand\(\s*ctx,\s*"EVAL/,
            /redis\.call\('GET'/,
            /redis\.call\('DECRBY'/,
            /quantity_exceeds_remaining/,
          ],
          order: [/quantity_exceeds_remaining/, /redis\.call\('DECRBY'/],
        },
      },
    },
    {
      id: 'record-in-script',
      title: 'The return record is written by the same script',
      detail:
        'The return’s own record — `line_id`, `quantity`, the reason and its evidence, state `registered` — is written by the same script that decrements the counter, so a decrement can never exist without a return. The starter writes the record from the client after the counter already moved.',
      match: {
        python: {
          all: [/RETURNS_LUA/, /redis\.call\('DECRBY'/, /redis\.call\('HSET'/, /'registered'/],
          none: [/\.hset\(/],
        },
        typescript: {
          all: [/RETURNS_LUA/, /redis\.call\('DECRBY'/, /redis\.call\('HSET'/, /'registered'/],
          none: [/\.hset\(/],
        },
        go: {
          all: [/returnsLua/, /redis\.call\('DECRBY'/, /redis\.call\('HSET'/, /'registered'/],
          none: [/\.HSet\(/],
        },
        scala: {
          all: [/ReturnsLua/, /redis\.call\('DECRBY'/, /redis\.call\('HSET'/, /'registered'/],
          none: [/\.hset\(/],
        },
        cpp: {
          all: [/kReturnsLua/, /redis\.call\('DECRBY'/, /redis\.call\('HSET'/, /'registered'/],
          none: [/redisCommand\(\s*ctx,\s*"HSET/],
        },
      },
    },
    {
      id: 'cancel-exact',
      title: 'Cancel restores exactly the quantity its return consumed',
      detail:
        'The cancel path runs the script: it reads the return record’s own `quantity` and `INCRBY`s the line’s counter by exactly that amount, so a cancel can only give back what the registration took — never an amount from the caller.',
      match: {
        python: {
          all: [
            /def cancel_return\(/,
            /\.eval\(/,
            /redis\.call\('HGET', KEYS\[2\], 'quantity'\)/,
            /redis\.call\('INCRBY', KEYS\[1\], quantity\)/,
          ],
          order: [/redis\.call\('HGET', KEYS\[2\], 'quantity'\)/, /redis\.call\('INCRBY'/],
        },
        typescript: {
          all: [
            /async function cancelReturn\(/,
            /\.eval\(/,
            /redis\.call\('HGET', KEYS\[2\], 'quantity'\)/,
            /redis\.call\('INCRBY', KEYS\[1\], quantity\)/,
          ],
          order: [/redis\.call\('HGET', KEYS\[2\], 'quantity'\)/, /redis\.call\('INCRBY'/],
        },
        go: {
          all: [
            /func CancelReturn\(/,
            /\.Eval\(/,
            /redis\.call\('HGET', KEYS\[2\], 'quantity'\)/,
            /redis\.call\('INCRBY', KEYS\[1\], quantity\)/,
          ],
          order: [/redis\.call\('HGET', KEYS\[2\], 'quantity'\)/, /redis\.call\('INCRBY'/],
        },
        scala: {
          all: [
            /def cancelReturn\(/,
            /\.eval\(/,
            /redis\.call\('HGET', KEYS\[2\], 'quantity'\)/,
            /redis\.call\('INCRBY', KEYS\[1\], quantity\)/,
          ],
          order: [/redis\.call\('HGET', KEYS\[2\], 'quantity'\)/, /redis\.call\('INCRBY'/],
        },
        cpp: {
          all: [
            /int cancelReturn\(/,
            /redisCommand\(\s*ctx,\s*"EVAL/,
            /redis\.call\('HGET', KEYS\[2\], 'quantity'\)/,
            /redis\.call\('INCRBY', KEYS\[1\], quantity\)/,
          ],
          order: [/redis\.call\('HGET', KEYS\[2\], 'quantity'\)/, /redis\.call\('INCRBY'/],
        },
      },
    },
    {
      id: 'cancel-idempotent',
      title: 'A second cancel restores nothing',
      detail:
        'The script reads the record’s `state`, flips it to `canceled` when it restores, and returns `already_canceled` with 0 restored the next time — so replaying a cancel cannot inflate the line. The starter restores the record’s quantity without ever looking at its state.',
      match: {
        python: {
          all: [
            /redis\.call\('HGET', KEYS\[2\], 'state'\)/,
            /redis\.call\('HSET', KEYS\[2\], 'state', 'canceled'\)/,
            /already_canceled/,
            /redis\.call\('INCRBY'/,
          ],
          order: [/already_canceled/, /redis\.call\('INCRBY'/],
        },
        typescript: {
          all: [
            /redis\.call\('HGET', KEYS\[2\], 'state'\)/,
            /redis\.call\('HSET', KEYS\[2\], 'state', 'canceled'\)/,
            /already_canceled/,
            /redis\.call\('INCRBY'/,
          ],
          order: [/already_canceled/, /redis\.call\('INCRBY'/],
        },
        go: {
          all: [
            /redis\.call\('HGET', KEYS\[2\], 'state'\)/,
            /redis\.call\('HSET', KEYS\[2\], 'state', 'canceled'\)/,
            /already_canceled/,
            /redis\.call\('INCRBY'/,
          ],
          order: [/already_canceled/, /redis\.call\('INCRBY'/],
        },
        scala: {
          all: [
            /redis\.call\('HGET', KEYS\[2\], 'state'\)/,
            /redis\.call\('HSET', KEYS\[2\], 'state', 'canceled'\)/,
            /already_canceled/,
            /redis\.call\('INCRBY'/,
          ],
          order: [/already_canceled/, /redis\.call\('INCRBY'/],
        },
        cpp: {
          all: [
            /redis\.call\('HGET', KEYS\[2\], 'state'\)/,
            /redis\.call\('HSET', KEYS\[2\], 'state', 'canceled'\)/,
            /already_canceled/,
            /redis\.call\('INCRBY'/,
          ],
          order: [/already_canceled/, /redis\.call\('INCRBY'/],
        },
      },
    },
    {
      id: 'no-client-round-trip',
      title: 'No read-then-write path left in the application code',
      detail:
        'The module talks to Redis only through the scripts: no client-side `GET`/`HGET` read followed by a separate `DECRBY`/`INCRBY`/`HSET` write remains. The starter does exactly that pair in both directions, which is where the concurrent over-return and the double restore live.',
      match: {
        python: {none: [/r\.get\(/, /r\.hget\(/, /r\.decrby\(/, /r\.incrby\(/, /r\.hset\(/]},
        typescript: {none: [/r\.get\(/, /r\.hget\(/, /r\.decrby\(/, /r\.incrby\(/, /r\.hset\(/]},
        go: {none: [/rdb\.(Get|HGet|DecrBy|IncrBy|HSet)\(/]},
        scala: {none: [/jedis\.(get|hget|decrBy|incrBy|hset)\(/]},
        cpp: {none: [/redisCommand\(\s*ctx,\s*"(GET|HGET|DECRBY|INCRBY|HSET)\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from uuid import uuid4

import redis as redis_client

logger = logging.getLogger("returns")

r = redis_client.Redis(host="redis", port=6379, decode_responses=True)


def returnable_key(order_line_id: str) -> str:
    """Remaining returnable quantity for the line, seeded when the line is delivered."""
    return f"line:{order_line_id}:returnable"


def return_key(return_id: str) -> str:
    """The return's own record: the line, the quantity it consumed, and its state."""
    return f"return:{return_id}"


def register_return(order_line_id: str, quantity: int, reason_code: str, photo_ref: str | None) -> tuple[str | None, int]:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    remaining = int(r.get(returnable_key(order_line_id)) or 0)
    if quantity > remaining:
        return None, remaining
    r.decrby(returnable_key(order_line_id), quantity)
    return_id = f"ret_{uuid4().hex}"
    r.hset(
        return_key(return_id),
        mapping={
            "line_id": order_line_id,
            "quantity": quantity,
            "reason_code": reason_code,
            "photo_ref": photo_ref or "",
            "state": "registered",
        },
    )
    logger.info("return registered line=%s return=%s qty=%d", order_line_id, return_id, quantity)
    return return_id, remaining - quantity


def cancel_return(order_line_id: str, return_id: str) -> int:
    quantity = int(r.hget(return_key(return_id), "quantity") or 0)
    r.incrby(returnable_key(order_line_id), quantity)
    logger.info("return canceled line=%s return=%s restored=%d", order_line_id, return_id, quantity)
    return quantity
`,
      solution: `import logging
from uuid import uuid4

import redis as redis_client

logger = logging.getLogger("returns")

# One script per state change: the counter check, the DECRBY and the return's record are a single
# step, and a cancel gives back exactly the quantity the record shows the return consumed.
RETURNS_LUA = """
local mode = ARGV[1]
if mode == 'register' then
  local remaining = tonumber(redis.call('GET', KEYS[1]) or '0')
  local quantity = tonumber(ARGV[2])
  if quantity > remaining then
    return {'quantity_exceeds_remaining', remaining}
  end
  redis.call('DECRBY', KEYS[1], quantity)
  redis.call('HSET', KEYS[2], 'line_id', ARGV[3], 'quantity', quantity, 'reason_code', ARGV[4], 'photo_ref', ARGV[5], 'state', 'registered')
  return {'ok', remaining - quantity}
end
local state = redis.call('HGET', KEYS[2], 'state')
if state == false then
  return {'unknown_return', 0}
end
if state == 'canceled' then
  return {'already_canceled', 0}
end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('HSET', KEYS[2], 'state', 'canceled')
redis.call('INCRBY', KEYS[1], quantity)
return {'ok', quantity}
"""

r = redis_client.Redis(host="redis", port=6379, decode_responses=True)


def returnable_key(order_line_id: str) -> str:
    """Remaining returnable quantity for the line, seeded when the line is delivered."""
    return f"line:{order_line_id}:returnable"


def return_key(return_id: str) -> str:
    """The return's own record: the line, the quantity it consumed, and its state."""
    return f"return:{return_id}"


def register_return(order_line_id: str, quantity: int, reason_code: str, photo_ref: str | None) -> tuple[str | None, int]:
    """Reject, decrement and record in one atomic step: (return_id, remaining).

    A quantity above what remains returns (None, remaining) and moves nothing.
    """
    return_id = f"ret_{uuid4().hex}"
    status, value = r.eval(
        RETURNS_LUA,
        2,
        returnable_key(order_line_id),
        return_key(return_id),
        "register",
        quantity,
        order_line_id,
        reason_code,
        photo_ref or "",
    )
    if status != "ok":
        logger.info("return rejected line=%s status=%s", order_line_id, status)
        return None, int(value)
    logger.info("return registered line=%s return=%s qty=%d", order_line_id, return_id, quantity)
    return return_id, int(value)


def cancel_return(order_line_id: str, return_id: str) -> int:
    """Give back exactly what this return consumed; a second cancel restores nothing."""
    status, value = r.eval(RETURNS_LUA, 2, returnable_key(order_line_id), return_key(return_id), "cancel")
    if status != "ok":
        logger.info("cancel ignored line=%s return=%s status=%s", order_line_id, return_id, status)
        return 0
    logger.info("return canceled line=%s return=%s restored=%d", order_line_id, return_id, int(value))
    return int(value)
`,
    },
    typescript: {
      starter: `/** Redis returnable quantities for the returns service. */
import {randomUUID} from 'node:crypto';

import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

export const returnableKey = (orderLineId: string): string => \`line:\${orderLineId}:returnable\`;
export const returnKey = (returnId: string): string => \`return:\${returnId}\`;

export interface Registration {
  returnId: string | null;
  remaining: number;
}

export async function registerReturn(
  orderLineId: string,
  quantity: number,
  reasonCode: string,
  photoRef?: string,
): Promise<Registration> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const remaining = Number((await r.get(returnableKey(orderLineId))) ?? 0);
  if (quantity > remaining) return {returnId: null, remaining};
  await r.decrby(returnableKey(orderLineId), quantity);
  const returnId = \`ret_\${randomUUID().replace(/-/g, '')}\`;
  await r.hset(returnKey(returnId), {
    line_id: orderLineId,
    quantity: String(quantity),
    reason_code: reasonCode,
    photo_ref: photoRef ?? '',
    state: 'registered',
  });
  console.info({line: orderLineId, returnId, quantity}, 'return registered');
  return {returnId, remaining: remaining - quantity};
}

export async function cancelReturn(orderLineId: string, returnId: string): Promise<number> {
  const restored = Number((await r.hget(returnKey(returnId), 'quantity')) ?? 0);
  await r.incrby(returnableKey(orderLineId), restored);
  console.info({line: orderLineId, returnId, restored}, 'return canceled');
  return restored;
}
`,
      solution: `/** Redis returnable quantities for the returns service: one atomic script per state change. */
import {randomUUID} from 'node:crypto';

import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

// One script per state change: the counter check, the DECRBY and the return's record are a single
// step, and a cancel gives back exactly the quantity the record shows the return consumed.
const RETURNS_LUA = \`
local mode = ARGV[1]
if mode == 'register' then
  local remaining = tonumber(redis.call('GET', KEYS[1]) or '0')
  local quantity = tonumber(ARGV[2])
  if quantity > remaining then
    return {'quantity_exceeds_remaining', remaining}
  end
  redis.call('DECRBY', KEYS[1], quantity)
  redis.call('HSET', KEYS[2], 'line_id', ARGV[3], 'quantity', quantity, 'reason_code', ARGV[4], 'photo_ref', ARGV[5], 'state', 'registered')
  return {'ok', remaining - quantity}
end
local state = redis.call('HGET', KEYS[2], 'state')
if state == false then
  return {'unknown_return', 0}
end
if state == 'canceled' then
  return {'already_canceled', 0}
end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('HSET', KEYS[2], 'state', 'canceled')
redis.call('INCRBY', KEYS[1], quantity)
return {'ok', quantity}
\`;

export const returnableKey = (orderLineId: string): string => \`line:\${orderLineId}:returnable\`;
export const returnKey = (returnId: string): string => \`return:\${returnId}\`;

export interface Registration {
  returnId: string | null;
  remaining: number;
}

export async function registerReturn(
  orderLineId: string,
  quantity: number,
  reasonCode: string,
  photoRef?: string,
): Promise<Registration> {
  const returnId = \`ret_\${randomUUID().replace(/-/g, '')}\`;
  const [status, value] = (await r.eval(
    RETURNS_LUA,
    2,
    returnableKey(orderLineId),
    returnKey(returnId),
    'register',
    quantity,
    orderLineId,
    reasonCode,
    photoRef ?? '',
  )) as [string, number];
  if (status !== 'ok') {
    console.info({line: orderLineId, status}, 'return rejected');
    return {returnId: null, remaining: value};
  }
  console.info({line: orderLineId, returnId, quantity}, 'return registered');
  return {returnId, remaining: value};
}

/** Give back exactly what this return consumed; a second cancel restores nothing. */
export async function cancelReturn(orderLineId: string, returnId: string): Promise<number> {
  const [status, value] = (await r.eval(
    RETURNS_LUA,
    2,
    returnableKey(orderLineId),
    returnKey(returnId),
    'cancel',
  )) as [string, number];
  if (status !== 'ok') {
    console.info({line: orderLineId, returnId, status}, 'cancel ignored');
    return 0;
  }
  console.info({line: orderLineId, returnId, restored: value}, 'return canceled');
  return value;
}
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"fmt"
	"log"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func returnableKey(orderLineID string) string {
	return fmt.Sprintf("line:%s:returnable", orderLineID)
}

func returnKey(returnID string) string {
	return fmt.Sprintf("return:%s", returnID)
}

// RegisterReturn registers the return against the line's returnable quantity.
func RegisterReturn(ctx context.Context, orderLineID string, quantity int, reasonCode, photoRef string) (string, int) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	counter := returnableKey(orderLineID)
	remaining, err := rdb.Get(ctx, counter).Int()
	if err == redis.Nil {
		remaining, err = 0, nil
	}
	if err != nil {
		log.Printf("read failed line=%s err=%v", orderLineID, err)
		return "", 0
	}
	if quantity > remaining {
		return "", remaining
	}
	rdb.DecrBy(ctx, counter, int64(quantity))
	returnID := "ret_" + uuid.NewString()
	rdb.HSet(ctx, returnKey(returnID), "line_id", orderLineID, "quantity", quantity, "reason_code", reasonCode, "photo_ref", photoRef, "state", "registered")
	log.Printf("return registered line=%s return=%s qty=%d", orderLineID, returnID, quantity)
	return returnID, remaining - quantity
}

// CancelReturn gives the return's quantity back to the line.
func CancelReturn(ctx context.Context, orderLineID, returnID string) int {
	restored, _ := rdb.HGet(ctx, returnKey(returnID), "quantity").Int()
	rdb.IncrBy(ctx, returnableKey(orderLineID), int64(restored))
	log.Printf("return canceled line=%s return=%s restored=%d", orderLineID, returnID, restored)
	return restored
}
`,
      solution: `package state

import (
	"context"
	"fmt"
	"log"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// One script per state change: the counter check, the DECRBY and the return's record are a single
// step, and a cancel gives back exactly the quantity the record shows the return consumed.
const returnsLua = \`
local mode = ARGV[1]
if mode == 'register' then
  local remaining = tonumber(redis.call('GET', KEYS[1]) or '0')
  local quantity = tonumber(ARGV[2])
  if quantity > remaining then
    return {'quantity_exceeds_remaining', remaining}
  end
  redis.call('DECRBY', KEYS[1], quantity)
  redis.call('HSET', KEYS[2], 'line_id', ARGV[3], 'quantity', quantity, 'reason_code', ARGV[4], 'photo_ref', ARGV[5], 'state', 'registered')
  return {'ok', remaining - quantity}
end
local state = redis.call('HGET', KEYS[2], 'state')
if state == false then
  return {'unknown_return', 0}
end
if state == 'canceled' then
  return {'already_canceled', 0}
end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('HSET', KEYS[2], 'state', 'canceled')
redis.call('INCRBY', KEYS[1], quantity)
return {'ok', quantity}
\`

var rdb *redis.Client

func returnableKey(orderLineID string) string {
	return fmt.Sprintf("line:%s:returnable", orderLineID)
}

func returnKey(returnID string) string {
	return fmt.Sprintf("return:%s", returnID)
}

// scriptReply reads the script's [status, value] reply: status is "ok" or an error code, value the
// remaining quantity after a register or the restored quantity after a cancel.
func scriptReply(values []any) (string, int) {
	if len(values) != 2 {
		return "script_failed", 0
	}
	status, _ := values[0].(string)
	value, _ := values[1].(int64)
	return status, int(value)
}

// RegisterReturn rejects, decrements and records in one atomic step: the return id is empty when
// the line cannot cover the quantity, and the remaining count is what the line still allows.
func RegisterReturn(ctx context.Context, orderLineID string, quantity int, reasonCode, photoRef string) (string, int) {
	returnID := "ret_" + uuid.NewString()
	values, err := rdb.Eval(ctx, returnsLua, []string{returnableKey(orderLineID), returnKey(returnID)},
		"register", quantity, orderLineID, reasonCode, photoRef).Slice()
	if err != nil {
		log.Printf("register failed line=%s err=%v", orderLineID, err)
		return "", 0
	}
	status, remaining := scriptReply(values)
	if status != "ok" {
		log.Printf("return rejected line=%s status=%s", orderLineID, status)
		return "", remaining
	}
	log.Printf("return registered line=%s return=%s qty=%d", orderLineID, returnID, quantity)
	return returnID, remaining
}

// CancelReturn gives back exactly what this return consumed; a second cancel restores nothing.
func CancelReturn(ctx context.Context, orderLineID, returnID string) int {
	values, err := rdb.Eval(ctx, returnsLua, []string{returnableKey(orderLineID), returnKey(returnID)}, "cancel").Slice()
	if err != nil {
		log.Printf("cancel failed line=%s return=%s err=%v", orderLineID, returnID, err)
		return 0
	}
	status, restored := scriptReply(values)
	if status != "ok" {
		log.Printf("cancel ignored line=%s return=%s status=%s", orderLineID, returnID, status)
		return 0
	}
	log.Printf("return canceled line=%s return=%s restored=%d", orderLineID, returnID, restored)
	return restored
}
`,
    },
    scala: {
      starter: `import java.util

import redis.clients.jedis.Jedis

object ReturnsState {
  val jedis = new Jedis("redis", 6379)

  def returnableKey(orderLineId: String): String = s"line:$orderLineId:returnable"

  def returnKey(returnId: String): String = s"return:$returnId"

  def registerReturn(orderLineId: String, quantity: Int, reasonCode: String, photoRef: Option[String]): (Option[String], Int) = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val remaining = Option(jedis.get(returnableKey(orderLineId))).map(_.toInt).getOrElse(0)
    if (quantity > remaining) {
      (None, remaining)
    } else {
      jedis.decrBy(returnableKey(orderLineId), quantity.toLong)
      val returnId = "ret_" + util.UUID.randomUUID().toString.replace("-", "")
      jedis.hset(
        returnKey(returnId),
        util.Map.of(
          "line_id",
          orderLineId,
          "quantity",
          quantity.toString,
          "reason_code",
          reasonCode,
          "photo_ref",
          photoRef.getOrElse(""),
          "state",
          "registered"
        )
      )
      println(s"return registered line=$orderLineId return=$returnId qty=$quantity")
      (Some(returnId), remaining - quantity)
    }
  }

  def cancelReturn(orderLineId: String, returnId: String): Int = {
    val restored = Option(jedis.hget(returnKey(returnId), "quantity")).map(_.toInt).getOrElse(0)
    jedis.incrBy(returnableKey(orderLineId), restored.toLong)
    println(s"return canceled line=$orderLineId return=$returnId restored=$restored")
    restored
  }
}
`,
      solution: `import java.util

import redis.clients.jedis.Jedis

object ReturnsState {
  // One script per state change: the counter check, the DECRBY and the return's record are a single
  // step, and a cancel gives back exactly the quantity the record shows the return consumed.
  val ReturnsLua: String =
    """
local mode = ARGV[1]
if mode == 'register' then
  local remaining = tonumber(redis.call('GET', KEYS[1]) or '0')
  local quantity = tonumber(ARGV[2])
  if quantity > remaining then
    return {'quantity_exceeds_remaining', remaining}
  end
  redis.call('DECRBY', KEYS[1], quantity)
  redis.call('HSET', KEYS[2], 'line_id', ARGV[3], 'quantity', quantity, 'reason_code', ARGV[4], 'photo_ref', ARGV[5], 'state', 'registered')
  return {'ok', remaining - quantity}
end
local state = redis.call('HGET', KEYS[2], 'state')
if state == false then
  return {'unknown_return', 0}
end
if state == 'canceled' then
  return {'already_canceled', 0}
end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('HSET', KEYS[2], 'state', 'canceled')
redis.call('INCRBY', KEYS[1], quantity)
return {'ok', quantity}
"""

  val jedis = new Jedis("redis", 6379)

  def returnableKey(orderLineId: String): String = s"line:$orderLineId:returnable"

  def returnKey(returnId: String): String = s"return:$returnId"

  /** The script's [status, value] reply: remaining after a register, restored after a cancel. */
  private def reply(raw: Object): (String, Int) = {
    val values = raw.asInstanceOf[util.List[Object]]
    (values.get(0).toString, values.get(1).asInstanceOf[java.lang.Long].longValue().toInt)
  }

  /** Reject, decrement and record in one atomic step: (Some(return_id), remaining) or (None, remaining). */
  def registerReturn(orderLineId: String, quantity: Int, reasonCode: String, photoRef: Option[String]): (Option[String], Int) = {
    val returnId = "ret_" + util.UUID.randomUUID().toString.replace("-", "")
    val (status, remaining) = reply(
      jedis.eval(
        ReturnsLua,
        util.List.of(returnableKey(orderLineId), returnKey(returnId)),
        util.List.of("register", quantity.toString, orderLineId, reasonCode, photoRef.getOrElse(""))
      )
    )
    if (status != "ok") {
      println(s"return rejected line=$orderLineId status=$status")
      (None, remaining)
    } else {
      println(s"return registered line=$orderLineId return=$returnId qty=$quantity")
      (Some(returnId), remaining)
    }
  }

  /** Give back exactly what this return consumed; a second cancel restores nothing. */
  def cancelReturn(orderLineId: String, returnId: String): Int = {
    val (status, restored) = reply(
      jedis.eval(
        ReturnsLua,
        util.List.of(returnableKey(orderLineId), returnKey(returnId)),
        util.List.of("cancel")
      )
    )
    if (status != "ok") {
      println(s"cancel ignored line=$orderLineId return=$returnId status=$status")
      0
    } else {
      println(s"return canceled line=$orderLineId return=$returnId restored=$restored")
      restored
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <hiredis/hiredis.h>

#include <iostream>
#include <random>
#include <string>
#include <utility>

std::string returnableKey(const std::string& orderLineId) {
  return "line:" + orderLineId + ":returnable";
}

std::string returnKey(const std::string& returnId) {
  return "return:" + returnId;
}

std::string newReturnId() {
  static std::mt19937_64 rng{std::random_device{}()};
  return "ret_" + std::to_string(rng());
}

// Register the return against the line's returnable quantity.
std::pair<std::string, int> registerReturn(redisContext* ctx, const std::string& orderLineId, int quantity,
                                           const std::string& reasonCode, const std::string& photoRef) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string counter = returnableKey(orderLineId);
  redisReply* read = (redisReply*)redisCommand(ctx, "GET %s", counter.c_str());
  const int remaining = read != nullptr && read->type == REDIS_REPLY_STRING ? std::stoi(read->str) : 0;
  freeReplyObject(read);
  if (quantity > remaining) {
    return {"", remaining};
  }
  redisReply* moved = (redisReply*)redisCommand(ctx, "DECRBY %s %d", counter.c_str(), quantity);
  freeReplyObject(moved);
  const std::string returnId = newReturnId();
  redisReply* written = (redisReply*)redisCommand(ctx, "HSET %s state registered quantity %d", returnKey(returnId).c_str(), quantity);
  freeReplyObject(written);
  std::cerr << "return registered line=" << orderLineId << " return=" << returnId << " qty=" << quantity << std::endl;
  return {returnId, remaining - quantity};
}

// Give the return's quantity back to the line.
int cancelReturn(redisContext* ctx, const std::string& orderLineId, const std::string& returnId) {
  redisReply* read = (redisReply*)redisCommand(ctx, "HGET %s quantity", returnKey(returnId).c_str());
  const int restored = read != nullptr && read->type == REDIS_REPLY_STRING ? std::stoi(read->str) : 0;
  freeReplyObject(read);
  redisReply* moved = (redisReply*)redisCommand(ctx, "INCRBY %s %d", returnableKey(orderLineId).c_str(), restored);
  freeReplyObject(moved);
  std::cerr << "return canceled line=" << orderLineId << " return=" << returnId << " restored=" << restored << std::endl;
  return restored;
}
`,
      solution: `#include <hiredis/hiredis.h>

#include <iostream>
#include <random>
#include <string>
#include <utility>

// One script per state change: the counter check, the DECRBY and the return's record are a single
// step, and a cancel gives back exactly the quantity the record shows the return consumed.
const char* kReturnsLua = R"LUA(
local mode = ARGV[1]
if mode == 'register' then
  local remaining = tonumber(redis.call('GET', KEYS[1]) or '0')
  local quantity = tonumber(ARGV[2])
  if quantity > remaining then
    return {'quantity_exceeds_remaining', remaining}
  end
  redis.call('DECRBY', KEYS[1], quantity)
  redis.call('HSET', KEYS[2], 'line_id', ARGV[3], 'quantity', quantity, 'reason_code', ARGV[4], 'photo_ref', ARGV[5], 'state', 'registered')
  return {'ok', remaining - quantity}
end
local state = redis.call('HGET', KEYS[2], 'state')
if state == false then
  return {'unknown_return', 0}
end
if state == 'canceled' then
  return {'already_canceled', 0}
end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('HSET', KEYS[2], 'state', 'canceled')
redis.call('INCRBY', KEYS[1], quantity)
return {'ok', quantity}
)LUA";

std::string returnableKey(const std::string& orderLineId) {
  return "line:" + orderLineId + ":returnable";
}

std::string returnKey(const std::string& returnId) {
  return "return:" + returnId;
}

std::string newReturnId() {
  static std::mt19937_64 rng{std::random_device{}()};
  return "ret_" + std::to_string(rng());
}

// EVAL's reply is [status, value]: status is "ok" or an error code, value the remaining quantity
// after a register or the restored quantity after a cancel.
std::pair<std::string, int> scriptReply(redisReply* reply) {
  if (reply == nullptr || reply->type != REDIS_REPLY_ARRAY || reply->elements != 2) {
    return {"script_failed", 0};
  }
  return {std::string(reply->element[0]->str), static_cast<int>(reply->element[1]->integer)};
}

// Reject, decrement and record in one atomic step: {return id, remaining}; the id is empty when the
// line cannot cover the quantity.
std::pair<std::string, int> registerReturn(redisContext* ctx, const std::string& orderLineId, int quantity,
                                           const std::string& reasonCode, const std::string& photoRef) {
  const std::string counter = returnableKey(orderLineId);
  const std::string returnId = newReturnId();
  const std::string record = returnKey(returnId);
  redisReply* reply = (redisReply*)redisCommand(ctx, "EVAL %s 2 %s %s register %d %s %s %s", kReturnsLua, counter.c_str(),
                                               record.c_str(), quantity, orderLineId.c_str(), reasonCode.c_str(),
                                               photoRef.c_str());
  const auto [status, remaining] = scriptReply(reply);
  freeReplyObject(reply);
  if (status != "ok") {
    std::cerr << "return rejected line=" << orderLineId << " status=" << status << std::endl;
    return {"", remaining};
  }
  std::cerr << "return registered line=" << orderLineId << " return=" << returnId << " qty=" << quantity << std::endl;
  return {returnId, remaining};
}

// Give back exactly what this return consumed; a second cancel restores nothing.
int cancelReturn(redisContext* ctx, const std::string& orderLineId, const std::string& returnId) {
  const std::string counter = returnableKey(orderLineId);
  const std::string record = returnKey(returnId);
  redisReply* reply = (redisReply*)redisCommand(ctx, "EVAL %s 2 %s %s cancel", kReturnsLua, counter.c_str(), record.c_str());
  const auto [status, restored] = scriptReply(reply);
  freeReplyObject(reply);
  if (status != "ok") {
    std::cerr << "cancel ignored line=" << orderLineId << " return=" << returnId << " status=" << status << std::endl;
    return 0;
  }
  std::cerr << "return canceled line=" << orderLineId << " return=" << returnId << " restored=" << restored << std::endl;
  return restored;
}
`,
    },
  },
  hints: [
    'Under load the counter for a popular line goes negative, support finds returns the counter does not account for, and one canceled return raised a line above its ordered quantity.',
    'Every path is two round trips: a read in the client, then a write. Between them another request reads the same value. Cancel also trusts the record without checking whether it was already canceled.',
    'Move each path into one `EVAL` script: compare and `DECRBY` and `HSET` the record together; on cancel, read `quantity` and `state` from the record, `INCRBY` only when state is not `canceled`, then flip it.',
  ],
  debrief: `The shape of the fix is one script per state change. Redis runs a Lua script without interleaving other commands, so the compare, the decrement and the record write become a single step and the gap the second return used to land in no longer exists. The record has to travel with the decrement: a decrement without a record is a unit nobody can cancel, a record without the decrement is a return that was never counted. Cancel is the same move in reverse with two rules: restore the quantity the record says was taken, and flip the state so a replay restores nothing. What this step leaves out: loading the scripts once with \`SCRIPT LOAD\` and calling \`EVALSHA\`, a reconciliation job that compares counters against return rows, and an audit trail per cancel.`,
};
