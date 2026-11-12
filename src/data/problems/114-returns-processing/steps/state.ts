import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis returnable quantities with atomic decrements',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the ledger every other step imports as \`returns.ledger\`:
\`register_return(order_line_id, return_id, quantity, fields)\` reads \`line:{id}:returnable\`,
compares, \`DECRBY\`s it, then \`HSET\`s the record \`return:{id}\` (\`return_id\`, \`order_line_id\`,
\`quantity\`, \`state\` \`registered\`, plus \`fields\`); \`cancel_return(order_line_id, return_id)\`
checks the record exists, \`INCR\`s the counter and marks it \`canceled\`. It serves the demo and
hides three flaws.

**Failure mode the checks target.** Two returns for the last unit land together and both take it;
canceling a return of three units gives one back; a cancel that is replayed, or sent twice at once,
gives the units back twice and the line ends up with more to return than was ordered.

- \`register_return\` is **one Lua script** (\`EVAL\` or a registered script): read the counter,
  return 0 and touch nothing when \`quantity\` is above it, else \`DECRBY\` and \`HSET\` the record,
  and return 1.
- \`cancel_return\` is one script too: it restores the record's **own \`quantity\`** with
  \`INCRBY\`, and only while the record's \`state\` is \`registered\`; it marks it \`canceled\` and
  returns the units restored (0 for an unknown or already canceled return).`,
  sequence: {
    participants: ['Returns API', 'Redis', 'Support console'],
    messages: [
      {from: 'Returns API', to: 'Redis', label: 'EVAL register · line:L1:returnable · return:ret-7 · 1', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Returns API',
        label: '1: DECRBY + HSET in one script · 0: too few left, nothing written',
        kind: 'reply',
      },
      {from: 'Support console', to: 'Redis', label: 'EVAL cancel · line:L1:returnable · return:ret-7', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Support console',
        label: "INCRBY the record's quantity, state canceled · 0 when already canceled",
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-register',
      title: 'Checks, decrements and records in one script',
      detail:
        'The comparison, the `DECRBY` and the record `HSET` run inside one Lua script, so a second return for the last unit cannot land between the read and the decrement, and no decrement exists without its record. The starter does all three as separate commands.',
      match: {
        python: {
          all: [
            /register_script\(|\.eval\(/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.call\(\s*['"]HSET['"],\s*KEYS\[2\]/,
          ],
          none: [/\.decrby\(/],
        },
        typescript: {
          all: [
            /defineCommand\(|\.eval\(/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.call\(\s*['"]HSET['"],\s*KEYS\[2\]/,
          ],
          none: [/\.decrby\(/],
        },
        go: {
          all: [
            /redis\.NewScript\(|\.Eval\(/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.call\(\s*['"]HSET['"],\s*KEYS\[2\]/,
          ],
          none: [/\.DecrBy\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]DECRBY['"]/, /redis\.call\(\s*['"]HSET['"],\s*KEYS\[2\]/],
          none: [/jedis\.decrBy\(/],
        },
        cpp: {
          all: [/\.eval(sha)?</, /redis\.call\(\s*['"]DECRBY['"]/, /redis\.call\(\s*['"]HSET['"],\s*KEYS\[2\]/],
          none: [/\.decrby\(/],
        },
      },
    },
    {
      id: 'cancel-exact',
      title: 'A cancel gives back the return’s own quantity',
      detail:
        'The cancel script reads the record’s `quantity` and `INCRBY`s the counter by it; the starter `INCR`s by one whatever the return took.',
      match: {
        python: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]quantity['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/\.incr\(/],
        },
        typescript: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]quantity['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/\.incr\(/],
        },
        go: {all: [/HGET['"],\s*KEYS\[2\],\s*['"]quantity['"]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.Incr\(/]},
        scala: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]quantity['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/jedis\.incr\(/],
        },
        cpp: {all: [/HGET['"],\s*KEYS\[2\],\s*['"]quantity['"]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incr\(/]},
      },
    },
    {
      id: 'cancel-once',
      title: 'A return is canceled once',
      detail:
        'The cancel script restores only while the record’s `state` is `registered` and marks it `canceled` in the same script, so a replayed or concurrent cancel restores nothing. The starter checks only that the record exists, from the client.',
      match: {
        python: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]state['"]/, /HSET['"],\s*KEYS\[2\],\s*['"]state['"],\s*['"]canceled['"]/],
          none: [/\.exists\(/],
        },
        typescript: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]state['"]/, /HSET['"],\s*KEYS\[2\],\s*['"]state['"],\s*['"]canceled['"]/],
          none: [/\.exists\(/],
        },
        go: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]state['"]/, /HSET['"],\s*KEYS\[2\],\s*['"]state['"],\s*['"]canceled['"]/],
          none: [/\.Exists\(/],
        },
        scala: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]state['"]/, /HSET['"],\s*KEYS\[2\],\s*['"]state['"],\s*['"]canceled['"]/],
          none: [/jedis\.exists\(/],
        },
        cpp: {
          all: [/HGET['"],\s*KEYS\[2\],\s*['"]state['"]/, /HSET['"],\s*KEYS\[2\],\s*['"]state['"],\s*['"]canceled['"]/],
          none: [/\.exists\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def counter_key(order_line_id: str) -> str:
    return f"line:{order_line_id}:returnable"


def record_key(return_id: str) -> str:
    return f"return:{return_id}"


def remaining(order_line_id: str) -> int:
    """The units of the line still returnable."""
    return int(r.get(counter_key(order_line_id)) or 0)


def register_return(order_line_id: str, return_id: str, quantity: int, fields: dict) -> bool:
    """Take quantity units off the line and record the return, or nothing when fewer remain."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if quantity > remaining(order_line_id):
        return False
    r.decrby(counter_key(order_line_id), quantity)
    record = {"return_id": return_id, "order_line_id": order_line_id, "quantity": quantity, "state": "registered", **fields}
    r.hset(record_key(return_id), mapping=record)
    return True


def cancel_return(order_line_id: str, return_id: str) -> int:
    """Give the return's own quantity back to the line, once; the units restored."""
    if not r.exists(record_key(return_id)):
        return 0
    r.incr(counter_key(order_line_id))
    r.hset(record_key(return_id), "state", "canceled")
    return 1
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: the line's counter, the return's record. ARGV: quantity, return_id, order_line_id, then field/value pairs.
REGISTER_LUA = """
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
"""

# Restores the record's own quantity, only from registered, and marks it canceled in the same step.
CANCEL_LUA = """
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
"""

register = r.register_script(REGISTER_LUA)
cancel = r.register_script(CANCEL_LUA)


def counter_key(order_line_id: str) -> str:
    return f"line:{order_line_id}:returnable"


def record_key(return_id: str) -> str:
    return f"return:{return_id}"


def remaining(order_line_id: str) -> int:
    """The units of the line still returnable."""
    return int(r.get(counter_key(order_line_id)) or 0)


def register_return(order_line_id: str, return_id: str, quantity: int, fields: dict) -> bool:
    """Take quantity units off the line and record the return, or nothing when fewer remain."""
    args = [quantity, return_id, order_line_id]
    for name, value in fields.items():
        args += [name, value]
    return register(keys=[counter_key(order_line_id), record_key(return_id)], args=args) == 1


def cancel_return(order_line_id: str, return_id: str) -> int:
    """Give the return's own quantity back to the line, once; the units restored."""
    return int(cancel(keys=[counter_key(order_line_id), record_key(return_id)], args=[]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const counterKey = (orderLineId: string): string => \`line:\${orderLineId}:returnable\`;
export const recordKey = (returnId: string): string => \`return:\${returnId}\`;

/** The units of the line still returnable. */
export async function remaining(orderLineId: string): Promise<number> {
  return Number((await redis.get(counterKey(orderLineId))) ?? 0);
}

/** Take quantity units off the line and record the return, or nothing when fewer remain. */
export async function registerReturn(orderLineId: string, returnId: string, quantity: number, fields: Record<string, string>): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (quantity > (await remaining(orderLineId))) return false;
  await redis.decrby(counterKey(orderLineId), quantity);
  await redis.hset(recordKey(returnId), {return_id: returnId, order_line_id: orderLineId, quantity: String(quantity), state: 'registered', ...fields});
  return true;
}

/** Give the return's own quantity back to the line, once; the units restored. */
export async function cancelReturn(orderLineId: string, returnId: string): Promise<number> {
  if (!(await redis.exists(recordKey(returnId)))) return 0;
  await redis.incr(counterKey(orderLineId));
  await redis.hset(recordKey(returnId), 'state', 'canceled');
  return 1;
}
`,
      solution: `import Redis from 'ioredis';

// KEYS: the line's counter, the return's record. ARGV: quantity, return_id, order_line_id, then field/value pairs.
export const REGISTER_LUA = \`
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
\`;

// Restores the record's own quantity, only from registered, and marks it canceled in the same step.
export const CANCEL_LUA = \`
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
\`;

interface LedgerRedis extends Redis {
  registerScript(counter: string, record: string, ...args: (string | number)[]): Promise<number>;
  cancelScript(counter: string, record: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('registerScript', {numberOfKeys: 2, lua: REGISTER_LUA});
redis.defineCommand('cancelScript', {numberOfKeys: 2, lua: CANCEL_LUA});

export const counterKey = (orderLineId: string): string => \`line:\${orderLineId}:returnable\`;
export const recordKey = (returnId: string): string => \`return:\${returnId}\`;

/** The units of the line still returnable. */
export async function remaining(orderLineId: string): Promise<number> {
  return Number((await redis.get(counterKey(orderLineId))) ?? 0);
}

/** Take quantity units off the line and record the return, or nothing when fewer remain. */
export async function registerReturn(orderLineId: string, returnId: string, quantity: number, fields: Record<string, string>): Promise<boolean> {
  const pairs = Object.entries(fields).flat();
  return (await redis.registerScript(counterKey(orderLineId), recordKey(returnId), quantity, returnId, orderLineId, ...pairs)) === 1;
}

/** Give the return's own quantity back to the line, once; the units restored. */
export async function cancelReturn(orderLineId: string, returnId: string): Promise<number> {
  return Number(await redis.cancelScript(counterKey(orderLineId), recordKey(returnId)));
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

func counterKey(orderLineID string) string { return "line:" + orderLineID + ":returnable" }
func recordKey(returnID string) string     { return "return:" + returnID }

// remaining is the units of the line still returnable.
func remaining(ctx context.Context, orderLineID string) (int64, error) {
	n, err := rdb.Get(ctx, counterKey(orderLineID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}

// registerReturn takes quantity units off the line and records the return, or does nothing when fewer remain.
func registerReturn(ctx context.Context, orderLineID, returnID string, quantity int64, fields map[string]string) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	left, err := remaining(ctx, orderLineID)
	if err != nil {
		return false, err
	}
	if quantity > left {
		return false, nil
	}
	if err := rdb.DecrBy(ctx, counterKey(orderLineID), quantity).Err(); err != nil {
		return false, err
	}
	record := map[string]any{"return_id": returnID, "order_line_id": orderLineID, "quantity": quantity, "state": "registered"}
	for name, value := range fields {
		record[name] = value
	}
	return true, rdb.HSet(ctx, recordKey(returnID), record).Err()
}

// cancelReturn gives the return's own quantity back to the line, once; the units restored.
func cancelReturn(ctx context.Context, orderLineID, returnID string) (int64, error) {
	n, err := rdb.Exists(ctx, recordKey(returnID)).Result()
	if err != nil || n == 0 {
		return 0, err
	}
	if err := rdb.Incr(ctx, counterKey(orderLineID)).Err(); err != nil {
		return 0, err
	}
	return 1, rdb.HSet(ctx, recordKey(returnID), "state", "canceled").Err()
}
`,
      solution: `package main

import (
	"context"
	"sort"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// registerScript: KEYS the line's counter and the return's record; ARGV quantity, return_id,
// order_line_id, then field/value pairs.
var registerScript = redis.NewScript(\`
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
\`)

// cancelScript restores the record's own quantity, only from registered, and marks it canceled in the same step.
var cancelScript = redis.NewScript(\`
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
\`)

func counterKey(orderLineID string) string { return "line:" + orderLineID + ":returnable" }
func recordKey(returnID string) string     { return "return:" + returnID }

// remaining is the units of the line still returnable.
func remaining(ctx context.Context, orderLineID string) (int64, error) {
	n, err := rdb.Get(ctx, counterKey(orderLineID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}

// registerReturn takes quantity units off the line and records the return, or does nothing when fewer remain.
func registerReturn(ctx context.Context, orderLineID, returnID string, quantity int64, fields map[string]string) (bool, error) {
	args := []any{quantity, returnID, orderLineID}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		args = append(args, name, fields[name])
	}
	n, err := registerScript.Run(ctx, rdb, []string{counterKey(orderLineID), recordKey(returnID)}, args...).Int64()
	return n == 1, err
}

// cancelReturn gives the return's own quantity back to the line, once; the units restored.
func cancelReturn(ctx context.Context, orderLineID, returnID string) (int64, error) {
	return cancelScript.Run(ctx, rdb, []string{counterKey(orderLineID), recordKey(returnID)}).Int64()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  def counterKey(orderLineId: String): String = s"line:$orderLineId:returnable"
  def recordKey(returnId: String): String = s"return:$returnId"

  /** The units of the line still returnable. */
  def remaining(orderLineId: String): Long = Option(jedis.get(counterKey(orderLineId))).map(_.toLong).getOrElse(0L)

  /** Take quantity units off the line and record the return, or nothing when fewer remain. */
  def registerReturn(orderLineId: String, returnId: String, quantity: Long, fields: Map[String, String]): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if (quantity > remaining(orderLineId)) false
    else {
      jedis.decrBy(counterKey(orderLineId), quantity)
      val record = Map("return_id" -> returnId, "order_line_id" -> orderLineId, "quantity" -> quantity.toString, "state" -> "registered") ++ fields
      jedis.hset(recordKey(returnId), record.asJava)
      true
    }
  }

  /** Give the return's own quantity back to the line, once; the units restored. */
  def cancelReturn(orderLineId: String, returnId: String): Long =
    if (!jedis.exists(recordKey(returnId))) 0L
    else {
      jedis.incr(counterKey(orderLineId))
      jedis.hset(recordKey(returnId), "state", "canceled")
      1L
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** KEYS: the line's counter, the return's record. ARGV: quantity, return_id, order_line_id, then field/value pairs. */
  val RegisterLua: String =
    """local left = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local quantity = tonumber(ARGV[1])
      |if quantity > left then return 0 end
      |redis.call('DECRBY', KEYS[1], quantity)
      |redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
      |for i = 4, #ARGV, 2 do
      |  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
      |end
      |return 1
      |""".stripMargin

  /** Restores the record's own quantity, only from registered, and marks it canceled in the same step. */
  val CancelLua: String =
    """if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
      |local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
      |redis.call('INCRBY', KEYS[1], quantity)
      |redis.call('HSET', KEYS[2], 'state', 'canceled')
      |return quantity
      |""".stripMargin

  def counterKey(orderLineId: String): String = s"line:$orderLineId:returnable"
  def recordKey(returnId: String): String = s"return:$returnId"

  /** The units of the line still returnable. */
  def remaining(orderLineId: String): Long = Option(jedis.get(counterKey(orderLineId))).map(_.toLong).getOrElse(0L)

  /** Take quantity units off the line and record the return, or nothing when fewer remain. */
  def registerReturn(orderLineId: String, returnId: String, quantity: Long, fields: Map[String, String]): Boolean = {
    val args = List(quantity.toString, returnId, orderLineId) ++ fields.toList.flatMap { case (name, value) => List(name, value) }
    jedis.eval(RegisterLua, List(counterKey(orderLineId), recordKey(returnId)).asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Give the return's own quantity back to the line, once; the units restored. */
  def cancelReturn(orderLineId: String, returnId: String): Long =
    jedis.eval(CancelLua, List(counterKey(orderLineId), recordKey(returnId)).asJava, List.empty[String].asJava).asInstanceOf[java.lang.Long]
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <unordered_map>

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string counterKey(const std::string& order_line_id) { return "line:" + order_line_id + ":returnable"; }
std::string recordKey(const std::string& return_id) { return "return:" + return_id; }

// The units of the line still returnable.
long long remaining(const std::string& order_line_id) {
  const auto value = redis().get(counterKey(order_line_id));
  return value ? std::stoll(*value) : 0;
}

// Take quantity units off the line and record the return, or nothing when fewer remain.
bool registerReturn(const std::string& order_line_id, const std::string& return_id, long long quantity,
                    const std::map<std::string, std::string>& fields) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (quantity > remaining(order_line_id)) return false;
  redis().decrby(counterKey(order_line_id), quantity);
  std::unordered_map<std::string, std::string> record(fields.begin(), fields.end());
  record["return_id"] = return_id;
  record["order_line_id"] = order_line_id;
  record["quantity"] = std::to_string(quantity);
  record["state"] = "registered";
  redis().hset(recordKey(return_id), record.begin(), record.end());
  return true;
}

// Give the return's own quantity back to the line, once; the units restored.
long long cancelReturn(const std::string& order_line_id, const std::string& return_id) {
  if (!redis().exists(recordKey(return_id))) return 0;
  redis().incr(counterKey(order_line_id));
  redis().hset(recordKey(return_id), "state", "canceled");
  return 1;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

// KEYS: the line's counter, the return's record. ARGV: quantity, return_id, order_line_id, then field/value pairs.
const std::string kRegisterLua = R"lua(
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
)lua";

// Restores the record's own quantity, only from registered, and marks it canceled in the same step.
const std::string kCancelLua = R"lua(
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
)lua";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string counterKey(const std::string& order_line_id) { return "line:" + order_line_id + ":returnable"; }
std::string recordKey(const std::string& return_id) { return "return:" + return_id; }

// The units of the line still returnable.
long long remaining(const std::string& order_line_id) {
  const auto value = redis().get(counterKey(order_line_id));
  return value ? std::stoll(*value) : 0;
}

// Take quantity units off the line and record the return, or nothing when fewer remain.
bool registerReturn(const std::string& order_line_id, const std::string& return_id, long long quantity,
                    const std::map<std::string, std::string>& fields) {
  const std::vector<std::string> keys = {counterKey(order_line_id), recordKey(return_id)};
  std::vector<std::string> args = {std::to_string(quantity), return_id, order_line_id};
  for (const auto& [name, value] : fields) {
    args.push_back(name);
    args.push_back(value);
  }
  return redis().eval<long long>(kRegisterLua, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Give the return's own quantity back to the line, once; the units restored.
long long cancelReturn(const std::string& order_line_id, const std::string& return_id) {
  return redis().eval<long long>(kCancelLua, {counterKey(order_line_id), recordKey(return_id)}, {});
}
`,
    },
  },
  harness: {
    python: `FIELDS = {"tenant": "t-1", "reason_code": "changed_mind", "photo_ref": ""}


def _units(ctx, n):
    ctx.redis.set("line:L1:returnable", n)


def _left(ctx):
    return int(ctx.redis.get("line:L1:returnable") or 0)


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_atomic_register(ctx):
    m = ctx.load("state")
    _units(ctx, 1)
    # A second return for the last unit lands right after this one first touches the counter.
    rival = ctx.redis_after("line:L1:returnable", lambda: m.register_return("L1", "ret-2", 1, FIELDS))
    mine = m.register_return("L1", "ret-1", 1, FIELDS)
    theirs = _settled(rival, "line:L1:returnable")
    assert [mine, theirs].count(True) == 1, f"two returns raced for the last unit and register_return answered {mine} and {theirs}: exactly one may take it"
    assert _left(ctx) == 0, f"line:L1:returnable is {_left(ctx)} after the race for its last unit, expected 0"
    records = [key for key in ("return:ret-1", "return:ret-2") if ctx.redis.exists(key)]
    assert len(records) == 1, f"the race left the records {records}: the winner has one, the refused return none"
    record = ctx.redis.hgetall(records[0])
    want = {"order_line_id": "L1", "quantity": "1", "state": "registered", "tenant": "t-1", "reason_code": "changed_mind"}
    assert all(record.get(k) == v for k, v in want.items()), f"{records[0]} holds {record}, expected {want}"
    assert m.register_return("L1", "ret-3", 1, FIELDS) is False, "a return of 1 unit on a line with none left must be refused"
    assert not ctx.redis.exists("return:ret-3") and _left(ctx) == 0, "a refused return must write nothing"


def check_cancel_exact(ctx):
    m = ctx.load("state")
    _units(ctx, 5)
    assert m.register_return("L1", "ret-1", 3, FIELDS) is True, "a return of 3 of 5 units must be registered"
    assert m.register_return("L1", "ret-2", 1, FIELDS) is True, "a return of 1 of the 2 units left must be registered"
    restored = m.cancel_return("L1", "ret-1")
    assert restored == 3 and _left(ctx) == 4, f"canceling the return of 3 units restored {restored} and left the line at {_left(ctx)}, expected 3 restored and 4 left: a cancel gives back exactly what its return took"
    assert ctx.redis.hget("return:ret-1", "state") == "canceled", f"return:ret-1 is {ctx.redis.hget('return:ret-1', 'state')!r} after its cancel"
    assert ctx.redis.hget("return:ret-2", "state") == "registered", "canceling ret-1 touched ret-2"
    restored = m.cancel_return("L1", "ret-404")
    assert restored == 0 and _left(ctx) == 4, f"canceling a return that does not exist restored {restored} units"


def check_cancel_once(ctx):
    m = ctx.load("state")
    _units(ctx, 4)
    m.register_return("L1", "ret-1", 1, FIELDS)
    first = m.cancel_return("L1", "ret-1")
    again = m.cancel_return("L1", "ret-1")
    assert first == 1 and again == 0 and _left(ctx) == 4, f"a cancel and its replay restored {first} and {again}, and the line now has {_left(ctx)} returnable units of the 4 ordered: a return is canceled once"
    m.register_return("L1", "ret-2", 1, FIELDS)
    # Two cancels of the same return land together: the second right after the first touches the record.
    rival = ctx.redis_after("return:ret-2", lambda: m.cancel_return("L1", "ret-2"))
    mine = m.cancel_return("L1", "ret-2")
    theirs = _settled(rival, "return:ret-2")
    assert mine + theirs == 1 and _left(ctx) == 4, f"two concurrent cancels of a return of 1 unit restored {mine} and {theirs}, leaving {_left(ctx)} returnable units of the 4 ordered"
`,
    typescript: `const FIELDS = {tenant: 't-1', reason_code: 'changed_mind', photo_ref: ''};

const units = (ctx, n: number): void => {
  ctx.redis.set('line:L1:returnable', String(n));
};
const left = (ctx): number => Number(ctx.redis.get('line:L1:returnable') ?? 0);

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_atomic_register(ctx) {
  const m = ctx.load('state');
  units(ctx, 1);
  // A second return for the last unit lands right after this one first touches the counter.
  const rival = ctx.redisAfter('line:L1:returnable', () => m.registerReturn('L1', 'ret-2', 1, FIELDS));
  const mine = await m.registerReturn('L1', 'ret-1', 1, FIELDS);
  const theirs = await settled(rival, 'line:L1:returnable');
  assert.equal([mine, theirs].filter(won => won === true).length, 1, \`two returns raced for the last unit and registerReturn answered \${mine} and \${theirs}: exactly one may take it\`);
  assert.equal(left(ctx), 0, \`line:L1:returnable is \${left(ctx)} after the race for its last unit, expected 0\`);
  const records = ['return:ret-1', 'return:ret-2'].filter(key => ctx.redis.exists(key) === 1);
  assert.equal(records.length, 1, \`the race left the records \${JSON.stringify(records)}: the winner has one, the refused return none\`);
  const record = ctx.redis.hgetall(records[0]);
  const want = {order_line_id: 'L1', quantity: '1', state: 'registered', tenant: 't-1', reason_code: 'changed_mind'};
  assert(Object.entries(want).every(([k, v]) => record[k] === v), \`\${records[0]} holds \${JSON.stringify(record)}, expected \${JSON.stringify(want)}\`);
  assert.equal(await m.registerReturn('L1', 'ret-3', 1, FIELDS), false, 'a return of 1 unit on a line with none left must be refused');
  assert(ctx.redis.exists('return:ret-3') === 0 && left(ctx) === 0, 'a refused return must write nothing');
}

export async function check_cancel_exact(ctx) {
  const m = ctx.load('state');
  units(ctx, 5);
  assert.equal(await m.registerReturn('L1', 'ret-1', 3, FIELDS), true, 'a return of 3 of 5 units must be registered');
  assert.equal(await m.registerReturn('L1', 'ret-2', 1, FIELDS), true, 'a return of 1 of the 2 units left must be registered');
  let restored = await m.cancelReturn('L1', 'ret-1');
  assert(restored === 3 && left(ctx) === 4, \`canceling the return of 3 units restored \${restored} and left the line at \${left(ctx)}, expected 3 restored and 4 left: a cancel gives back exactly what its return took\`);
  assert.equal(ctx.redis.hget('return:ret-1', 'state'), 'canceled', 'return:ret-1 must be canceled');
  assert.equal(ctx.redis.hget('return:ret-2', 'state'), 'registered', 'canceling ret-1 touched ret-2');
  restored = await m.cancelReturn('L1', 'ret-404');
  assert(restored === 0 && left(ctx) === 4, \`canceling a return that does not exist restored \${restored} units\`);
}

export async function check_cancel_once(ctx) {
  const m = ctx.load('state');
  units(ctx, 4);
  await m.registerReturn('L1', 'ret-1', 1, FIELDS);
  const first = await m.cancelReturn('L1', 'ret-1');
  const again = await m.cancelReturn('L1', 'ret-1');
  assert(first === 1 && again === 0 && left(ctx) === 4, \`a cancel and its replay restored \${first} and \${again}, and the line now has \${left(ctx)} returnable units of the 4 ordered: a return is canceled once\`);
  await m.registerReturn('L1', 'ret-2', 1, FIELDS);
  // Two cancels of the same return land together: the second right after the first touches the record.
  const rival = ctx.redisAfter('return:ret-2', () => m.cancelReturn('L1', 'ret-2'));
  const mine = await m.cancelReturn('L1', 'ret-2');
  const theirs = await settled(rival, 'return:ret-2');
  assert(mine + theirs === 1 && left(ctx) === 4, \`two concurrent cancels of a return of 1 unit restored \${mine} and \${theirs}, leaving \${left(ctx)} returnable units of the 4 ordered\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

var (
	stateBg     = context.Background()
	stateFields = map[string]string{"tenant": "t-1", "reason_code": "changed_mind", "photo_ref": ""}
)

func stateUnits(ctx *harness.Ctx, n int) { ctx.Redis.Set("line:L1:returnable", n) }

func stateLeft(ctx *harness.Ctx) int {
	v, _ := ctx.Redis.Get("line:L1:returnable")
	n, _ := strconv.Atoi(v)
	return n
}

func mustRegister(ctx *harness.Ctx, returnID string, quantity int64) bool {
	ok, err := registerReturn(stateBg, "L1", returnID, quantity, stateFields)
	ctx.NoError(err, "registerReturn(L1, %s, %d) failed", returnID, quantity)
	return ok
}

func mustCancel(ctx *harness.Ctx, returnID string) int64 {
	n, err := cancelReturn(stateBg, "L1", returnID)
	ctx.NoError(err, "cancelReturn(L1, %s) failed", returnID)
	return n
}

func CheckAtomicRegister(ctx *harness.Ctx) {
	stateUnits(ctx, 1)
	// A second return for the last unit lands right after this one first touches the counter.
	rival := ctx.Redis.After("line:L1:returnable", func() any {
		ok, err := registerReturn(stateBg, "L1", "ret-2", 1, stateFields)
		ctx.NoError(err, "the rival registerReturn failed")
		return ok
	})
	mine := mustRegister(ctx, "ret-1", 1)
	ctx.Assert(rival.Fired, "nothing touched line:L1:returnable")
	theirs, _ := rival.Result.(bool)
	ctx.Assert(mine != theirs, "two returns raced for the last unit and registerReturn answered %v and %v: exactly one may take it", mine, theirs)
	ctx.Equal(stateLeft(ctx), 0, "line:L1:returnable after the race for its last unit")
	var records []string
	for _, key := range []string{"return:ret-1", "return:ret-2"} {
		if ctx.Redis.Exists(key) == 1 {
			records = append(records, key)
		}
	}
	ctx.Equal(len(records), 1, "the race must leave one record, the winner's (records %v)", records)
	record := ctx.Redis.HGetAll(records[0])
	ctx.Assert(record["order_line_id"] == "L1" && record["quantity"] == "1" && record["state"] == "registered" && record["tenant"] == "t-1" && record["reason_code"] == "changed_mind", "%s holds %v", records[0], record)
	ctx.Equal(mustRegister(ctx, "ret-3", 1), false, "a return of 1 unit on a line with none left must be refused; registered")
	ctx.Assert(ctx.Redis.Exists("return:ret-3") == 0 && stateLeft(ctx) == 0, "a refused return must write nothing")
}

func CheckCancelExact(ctx *harness.Ctx) {
	stateUnits(ctx, 5)
	ctx.Equal(mustRegister(ctx, "ret-1", 3), true, "a return of 3 of 5 units; registered")
	ctx.Equal(mustRegister(ctx, "ret-2", 1), true, "a return of 1 of the 2 units left; registered")
	restored := mustCancel(ctx, "ret-1")
	ctx.Assert(restored == 3 && stateLeft(ctx) == 4, "canceling the return of 3 units restored %d and left the line at %d, expected 3 restored and 4 left: a cancel gives back exactly what its return took", restored, stateLeft(ctx))
	state, _ := ctx.Redis.HGet("return:ret-1", "state")
	ctx.Equal(state, "canceled", "return:ret-1's state after its cancel")
	state, _ = ctx.Redis.HGet("return:ret-2", "state")
	ctx.Equal(state, "registered", "return:ret-2's state (canceling ret-1 must not touch it)")
	restored = mustCancel(ctx, "ret-404")
	ctx.Assert(restored == 0 && stateLeft(ctx) == 4, "canceling a return that does not exist restored %d units", restored)
}

func CheckCancelOnce(ctx *harness.Ctx) {
	stateUnits(ctx, 4)
	mustRegister(ctx, "ret-1", 1)
	first := mustCancel(ctx, "ret-1")
	again := mustCancel(ctx, "ret-1")
	ctx.Assert(first == 1 && again == 0 && stateLeft(ctx) == 4, "a cancel and its replay restored %d and %d, and the line now has %d returnable units of the 4 ordered: a return is canceled once", first, again, stateLeft(ctx))
	mustRegister(ctx, "ret-2", 1)
	// Two cancels of the same return land together: the second right after the first touches the record.
	rival := ctx.Redis.After("return:ret-2", func() any {
		n, err := cancelReturn(stateBg, "L1", "ret-2")
		ctx.NoError(err, "the rival cancelReturn failed")
		return n
	})
	mine := mustCancel(ctx, "ret-2")
	ctx.Assert(rival.Fired, "nothing touched return:ret-2")
	theirs, _ := rival.Result.(int64)
	ctx.Assert(mine+theirs == 1 && stateLeft(ctx) == 4, "two concurrent cancels of a return of 1 unit restored %d and %d, leaving %d returnable units of the 4 ordered", mine, theirs, stateLeft(ctx))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::map<std::string, std::string> kFields = {{"tenant", "t-1"}, {"reason_code", "changed_mind"}, {"photo_ref", ""}};

void units(harness::Ctx& ctx, long long n) { ctx.Redis.Set("line:L1:returnable", std::to_string(n)); }

long long unitsLeft(harness::Ctx& ctx) {
  const auto v = ctx.Redis.Get("line:L1:returnable");
  return v ? std::stoll(*v) : 0;
}

// A probe's outcome: whether it fired, what the rival call returned, what it threw.
struct Rival {
  bool fired = false;
  long long result = 0;
  std::optional<std::string> err;
};

template <class F>
std::shared_ptr<Rival> rival(harness::Ctx& ctx, const std::string& key, F call) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out, call] {
    out->fired = true;
    try {
      out->result = call();
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

void settled(harness::Ctx& ctx, const Rival& r, const std::string& what) {
  ctx.Assert(r.fired, "nothing touched %s", what);
  ctx.Assert(!r.err, "the rival call failed: %s", r.err.value_or(""));
}

}  // namespace

void CheckAtomicRegister(harness::Ctx& ctx) {
  units(ctx, 1);
  // A second return for the last unit lands right after this one first touches the counter.
  const auto other = rival(ctx, "line:L1:returnable", [] { return registerReturn("L1", "ret-2", 1, kFields) ? 1LL : 0LL; });
  const bool mine = registerReturn("L1", "ret-1", 1, kFields);
  settled(ctx, *other, "line:L1:returnable");
  const bool theirs = other->result == 1;
  ctx.Assert(mine != theirs, "two returns raced for the last unit and registerReturn answered %t and %t: exactly one may take it", mine, theirs);
  ctx.Equal(unitsLeft(ctx), 0, "line:L1:returnable after the race for its last unit");
  std::vector<std::string> records;
  for (const std::string key : {"return:ret-1", "return:ret-2"}) {
    if (ctx.Redis.Exists(key) == 1) records.push_back(key);
  }
  ctx.Equal(records.size(), 1, "the race must leave one record, the winner's (records %q)", records);
  auto record = ctx.Redis.HGetAll(records[0]);
  ctx.Assert(record["order_line_id"] == "L1" && record["quantity"] == "1" && record["state"] == "registered" && record["tenant"] == "t-1" && record["reason_code"] == "changed_mind",
             "%s holds order_line_id %q, quantity %q, state %q, tenant %q", records[0], record["order_line_id"], record["quantity"], record["state"], record["tenant"]);
  ctx.Equal(registerReturn("L1", "ret-3", 1, kFields), false, "a return of 1 unit on a line with none left must be refused; registered");
  ctx.Assert(ctx.Redis.Exists("return:ret-3") == 0 && unitsLeft(ctx) == 0, "a refused return must write nothing");
}

void CheckCancelExact(harness::Ctx& ctx) {
  units(ctx, 5);
  ctx.Equal(registerReturn("L1", "ret-1", 3, kFields), true, "a return of 3 of 5 units; registered");
  ctx.Equal(registerReturn("L1", "ret-2", 1, kFields), true, "a return of 1 of the 2 units left; registered");
  long long restored = cancelReturn("L1", "ret-1");
  ctx.Assert(restored == 3 && unitsLeft(ctx) == 4, "canceling the return of 3 units restored %d and left the line at %d, expected 3 restored and 4 left: a cancel gives back exactly what its return took", restored, unitsLeft(ctx));
  ctx.Equal(ctx.Redis.HGet("return:ret-1", "state").value_or(""), "canceled", "return:ret-1's state after its cancel");
  ctx.Equal(ctx.Redis.HGet("return:ret-2", "state").value_or(""), "registered", "return:ret-2's state (canceling ret-1 must not touch it)");
  restored = cancelReturn("L1", "ret-404");
  ctx.Assert(restored == 0 && unitsLeft(ctx) == 4, "canceling a return that does not exist restored %d units", restored);
}

void CheckCancelOnce(harness::Ctx& ctx) {
  units(ctx, 4);
  registerReturn("L1", "ret-1", 1, kFields);
  const long long first = cancelReturn("L1", "ret-1");
  const long long again = cancelReturn("L1", "ret-1");
  ctx.Assert(first == 1 && again == 0 && unitsLeft(ctx) == 4, "a cancel and its replay restored %d and %d, and the line now has %d returnable units of the 4 ordered: a return is canceled once", first, again, unitsLeft(ctx));
  registerReturn("L1", "ret-2", 1, kFields);
  // Two cancels of the same return land together: the second right after the first touches the record.
  const auto other = rival(ctx, "return:ret-2", [] { return cancelReturn("L1", "ret-2"); });
  const long long mine = cancelReturn("L1", "ret-2");
  settled(ctx, *other, "return:ret-2");
  ctx.Assert(mine + other->result == 1 && unitsLeft(ctx) == 4, "two concurrent cancels of a return of 1 unit restored %d and %d, leaving %d returnable units of the 4 ordered", mine, other->result, unitsLeft(ctx));
}
`,
  },
  hints: [
    'Send two returns for the last unit at the same moment: both get 201. Cancel a return of three units: the line gets one back. Cancel it again: another unit appears.',
    'Between the client’s `GET` and its `DECRBY` another request can read the same count; the cancel adds a constant, and nothing remembers that the return was already canceled.',
    'One script for register: GET, compare, `DECRBY`, `HSET` the record. One for cancel: return 0 unless `HGET state` is `registered`, then `INCRBY` by `HGET quantity` and set `canceled`.',
  ],
  debrief: `Both scripts follow one rule: the decision and the write it justifies happen in one Redis execution, against values read in that same execution. Register reads the counter it decrements and writes the record that explains the decrement; cancel reads the quantity it restores and the state that says whether it may, then changes that state. That is what makes a double submit, a replayed cancel and two support agents clicking at once harmless without any client-side locking. A returns platform keeps the counter as a cache of the order ledger and reconciles the two nightly, and it records every cancel with who asked and why, so a units count that drifts can be traced to the change that moved it.`,
};
