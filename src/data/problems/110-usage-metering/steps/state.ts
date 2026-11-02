import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis windowed counters with atomic add-and-cap',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'coverage'],
  task: `## Task

**Starting point.** The starter is the Redis layer behind \`POST /v1/usage\`: \`apply_usage\` reads the
account's counter with \`GET\`, compares it to the plan cap, refuses with \`429\` when over, and
otherwise \`INCRBY\`s the counter in a second call and returns the total. It compiles, serves the
demo and hides five flaws.

**Failure mode the checks target.** A crash or a concurrent writer between the read and the
increment loses a report and leaves the total apart from any record; the key has no expiry and no
hour bucket, so the "hour" never ends; and the cap check refuses traffic, so a Redis hiccup becomes
a \`429\` storm on a path that was only supposed to count.

- Each account gets one counter per hour: the key is \`usage:{account}:{window}\`, where \`window\` is
  \`floor(unix_seconds / WINDOW_SECONDS)\` with \`WINDOW_SECONDS = 3600\`.
- One **atomic Lua script** increments the window's units (\`HINCRBY\`), sets the window's expiry
  (\`EXPIRE\`) when the key is created, and compares the running total against the plan cap, all in
  a single round trip.
- **Metering observes; it does not block.** Past the plan cap the script writes an \`overage\` flag
  into the window and returns it; the report is still counted and nothing answers \`429\`.
- The usage record (request id, account, route, units, gateway) commits in the **same script** as
  the counters, so the row and the total cannot disagree after recovery.
- The layer returns the window total, the cap and whether the account is over, so the API can report
  cap state without gating traffic.`,
  sequence: {
    participants: ['Metering API', 'Redis', 'Plan coverage'],
    messages: [
      {
        from: 'Metering API',
        to: 'Redis',
        label: 'EVAL apply_usage · KEYS[usage:{acct}:{hour}, usage:record:{req}]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'HINCRBY units · HSET record · EXPIRE window', kind: 'sync'},
      {from: 'Redis', to: 'Metering API', label: '{total, cap, over}', kind: 'reply'},
      {from: 'Metering API', to: 'Plan coverage', label: 'overage flag · never refuse', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'script',
      title: 'Increments with one atomic Lua script',
      detail:
        'The window counter and the usage record are written by one `EVAL`/`NewScript` call, not by a client-side read followed by a separate increment. The starter reads with `GET` and increments with `INCRBY`, so a crash between them loses the report.',
      match: {
        python: {all: [/APPLY_LUA/, /\.eval\(/, /HINCRBY/]},
        typescript: {all: [/APPLY_LUA/, /\.eval\(/, /HINCRBY/]},
        go: {all: [/(applyScript|NewScript)/, /\.Run\(/, /HINCRBY/]},
        scala: {all: [/ApplyLua/, /\.eval\(/, /HINCRBY/]},
        cpp: {all: [/kApplyLua/, /\.eval</, /HINCRBY/]},
      },
    },
    {
      id: 'expire',
      title: 'Window key expires on its boundary',
      detail:
        'The script sets the window key’s expiry (`EXPIRE`) from the window length when it creates it. Without a TTL the "hour" never ends and an account’s usage only ever grows. The starter sets none.',
      match: {
        python: {all: [/EXPIRE/, /WINDOW_SECONDS/]},
        typescript: {all: [/EXPIRE/, /WINDOW_SECONDS/]},
        go: {all: [/EXPIRE/, /windowSeconds/]},
        scala: {all: [/EXPIRE/, /WindowSeconds/]},
        cpp: {all: [/EXPIRE/, /kWindowSeconds/]},
      },
    },
    {
      id: 'cap-flag',
      title: 'Caps flag instead of blocking',
      detail:
        'Passing the plan cap writes an `overage` flag and returns it; the report is still counted and nothing is refused. The starter answers `429`, so a metering outage becomes an availability outage.',
      match: {
        python: {all: [/overage/], none: [/\b429\b/]},
        typescript: {all: [/overage/], none: [/\b429\b/]},
        go: {all: [/overage/], none: [/TooManyRequests|\b429\b/]},
        scala: {all: [/overage/], none: [/TooManyRequests|\b429\b/]},
        cpp: {all: [/overage/], none: [/\b429\b/]},
      },
    },
    {
      id: 'commit',
      title: 'Commits the record with the counters',
      detail:
        'The same script that increments the window also writes the per-request usage record (`HSET`), so the row and the total move together. The starter increments the counter and writes no record at all.',
      match: {
        python: {all: [/RECORD_PREFIX/, /HSET/]},
        typescript: {all: [/RECORD_PREFIX/, /HSET/]},
        go: {all: [/(recordPrefix|RecordPrefix)/, /HSET/]},
        scala: {all: [/RecordPrefix/, /HSET/]},
        cpp: {all: [/kRecordPrefix/, /HSET/]},
      },
    },
    {
      id: 'window-key',
      title: 'Keys by account and hour window',
      detail:
        'The window key is `usage:{account}:{window}` built from the account and the hour bucket; a window-less key never resets. The starter keys by account alone.',
      match: {
        python: {all: [/def window_key\(/, /WINDOW_SECONDS/]},
        typescript: {all: [/windowKey\(|window_key/, /WINDOW_SECONDS/]},
        go: {all: [/(windowKey|WindowKey)\(/, /windowSeconds/]},
        scala: {all: [/def windowKey\(/, /WindowSeconds/]},
        cpp: {all: [/(windowKey|WindowKey)\(/, /kWindowSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PLAN_CAP = 1_000_000


def apply_usage(account: str, request_id: str, route: str, units: int, gateway: str) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    key = f"usage:{account}"
    total = int(r.get(key) or 0)
    if total + units > PLAN_CAP:
        return {"allowed": False, "status": 429, "total": total, "cap": PLAN_CAP}
    total = r.incrby(key, units)
    return {"allowed": True, "status": 200, "total": total, "cap": PLAN_CAP, "over": False}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_SECONDS = 3600
PLAN_CAP = 1_000_000
RECORD_PREFIX = "usage:record:"

APPLY_LUA = """
local window_key = KEYS[1]
local record_key = KEYS[2]
local units = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local total = redis.call('HINCRBY', window_key, 'units', units)
redis.call('HSET', record_key, 'units', units, 'account', ARGV[4], 'route', ARGV[5], 'gateway', ARGV[6])
local over = 0
if total > cap then
  over = 1
  redis.call('HSET', window_key, 'overage', 1)
end
if redis.call('TTL', window_key) < 0 then
  redis.call('EXPIRE', window_key, ttl)
end
return {total, cap, over}
"""


def window_key(account: str, window: int) -> str:
    return f"usage:{{{account}}}:{window}"


def apply_usage(
    account: str, request_id: str, route: str, units: int, gateway: str, now: int | None = None
) -> dict:
    window = (now or int(time.time())) // WINDOW_SECONDS
    key = window_key(account, window)
    record_key = RECORD_PREFIX + request_id
    total, cap, over = r.eval(
        APPLY_LUA, 2, key, record_key, units, PLAN_CAP, WINDOW_SECONDS, account, route, gateway
    )
    return {"total": int(total), "cap": int(cap), "over": bool(over)}
`,
    },
    typescript: {
      starter: `/** Redis metering layer: flawed code that blocks and never expires. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const PLAN_CAP = 1_000_000;

export interface WindowResult {
  allowed: boolean;
  status: number;
  total: number;
  cap: number;
  over: boolean;
}

export async function applyUsage(account: string, units: number): Promise<WindowResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const key = \`usage:\${account}\`;
  const total = Number((await r.get(key)) ?? 0);
  if (total + units > PLAN_CAP) {
    const error = new Error('plan cap reached');
    Object.assign(error, {statusCode: 429});
    throw error;
  }
  const next = await r.incrby(key, units);
  return {allowed: true, status: 200, total: next, cap: PLAN_CAP, over: false};
}
`,
      solution: `/** Redis metering layer: one atomic script adds the units, writes the record and flags overage. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const WINDOW_SECONDS = 3600;
const PLAN_CAP = 1_000_000;
const RECORD_PREFIX = 'usage:record:';

const APPLY_LUA = \`
local window_key = KEYS[1]
local record_key = KEYS[2]
local units = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local total = redis.call('HINCRBY', window_key, 'units', units)
redis.call('HSET', record_key, 'units', units, 'account', ARGV[4], 'route', ARGV[5], 'gateway', ARGV[6])
local over = 0
if total > cap then
  over = 1
  redis.call('HSET', window_key, 'overage', 1)
end
if redis.call('TTL', window_key) < 0 then
  redis.call('EXPIRE', window_key, ttl)
end
return {total, cap, over}
\`;

export interface WindowResult {
  total: number;
  cap: number;
  over: boolean;
}

const windowKey = (account: string, window: number): string => \`usage:{\${account}}:\${window}\`;

export async function applyUsage(
  account: string,
  requestId: string,
  route: string,
  units: number,
  gateway: string,
): Promise<WindowResult> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = windowKey(account, window);
  const recordKey = RECORD_PREFIX + requestId;
  const [total, cap, over] = (await r.eval(
    APPLY_LUA,
    2,
    key,
    recordKey,
    units,
    PLAN_CAP,
    WINDOW_SECONDS,
    account,
    route,
    gateway,
  )) as [number, number, number];
  return {total, cap, over: over === 1};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const planCap = 1_000_000

var errPlanCapReached = errors.New("plan cap reached")

func ApplyUsage(ctx context.Context, account, requestID, route string, units int, gateway string) (map[string]any, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	key := "usage:" + account
	total, err := r.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if total+int64(units) > planCap {
		return map[string]any{"allowed": false, "status": 429, "total": total, "cap": planCap}, errPlanCapReached
	}
	next, err := r.IncrBy(ctx, key, int64(units)).Result()
	if err != nil {
		return nil, err
	}
	return map[string]any{"allowed": true, "status": 200, "total": next, "cap": planCap, "over": false}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds = 3600
	planCap       = 1_000_000
	recordPrefix  = "usage:record:"
)

const applyLua = \`
local window_key = KEYS[1]
local record_key = KEYS[2]
local units = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local total = redis.call('HINCRBY', window_key, 'units', units)
redis.call('HSET', record_key, 'units', units, 'account', ARGV[4], 'route', ARGV[5], 'gateway', ARGV[6])
local over = 0
if total > cap then
  over = 1
  redis.call('HSET', window_key, 'overage', 1)
end
if redis.call('TTL', window_key) < 0 then
  redis.call('EXPIRE', window_key, ttl)
end
return {total, cap, over}
\`

var applyScript = redis.NewScript(applyLua)

func windowKey(account string, window int64) string {
	return "usage:{" + account + "}:" + strconv.FormatInt(window, 10)
}

func ApplyUsage(ctx context.Context, account, requestID, route string, units int, gateway string) (map[string]any, error) {
	window := time.Now().Unix() / windowSeconds
	key := windowKey(account, window)
	recordKey := recordPrefix + requestID
	res, err := applyScript.Run(
		ctx, r, []string{key, recordKey}, units, planCap, windowSeconds, account, route, gateway,
	).Result()
	if err != nil {
		return nil, err
	}
	values := res.([]any)
	return map[string]any{
		"total": values[0],
		"cap":   values[1],
		"over":  values[2],
	}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object MeteringState {
  val r = new Jedis("redis", 6379)

  val PlanCap = 1_000_000

  def applyUsage(account: String, request_id: String, route: String, units: Int, gateway: String): Map[String, Any] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val key = s"usage:$account"
    val total = r.get(key).toLongOption.getOrElse(0L)
    if (total + units > PlanCap) {
      Map("allowed" -> false, "status" -> 429, "total" -> total, "cap" -> PlanCap)
    } else {
      val next = r.incrBy(key, units.toLong)
      Map("allowed" -> true, "status" -> 200, "total" -> next, "cap" -> PlanCap, "over" -> false)
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object MeteringState {
  val r = new Jedis("redis", 6379)

  val WindowSeconds = 3600
  val PlanCap = 1_000_000
  val RecordPrefix = "usage:record:"

  val ApplyLua =
    """
local window_key = KEYS[1]
local record_key = KEYS[2]
local units = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local total = redis.call('HINCRBY', window_key, 'units', units)
redis.call('HSET', record_key, 'units', units, 'account', ARGV[4], 'route', ARGV[5], 'gateway', ARGV[6])
local over = 0
if total > cap then
  over = 1
  redis.call('HSET', window_key, 'overage', 1)
end
if redis.call('TTL', window_key) < 0 then
  redis.call('EXPIRE', window_key, ttl)
end
return {total, cap, over}
"""

  def windowKey(account: String, window: Long): String = s"usage:{$account}:$window"

  def applyUsage(account: String, request_id: String, route: String, units: Int, gateway: String): Map[String, Any] = {
    val window = System.currentTimeMillis() / 1000L / WindowSeconds
    val key = windowKey(account, window)
    val recordKey = RecordPrefix + request_id
    val values = r.eval(
      ApplyLua,
      java.util.List.of(key, recordKey),
      java.util.List.of(units.toString, PlanCap.toString, WindowSeconds.toString, account, route, gateway)
    )
    Map("total" -> values.get(0).toLong, "cap" -> values.get(1).toLong, "over" -> (values.get(2).toLong == 1L))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <cstdlib>
#include <string>

using namespace sw::redis;

constexpr long long kPlanCap = 1'000'000;

long long applyUsage(Redis& r, const std::string& account, const std::string& request_id,
                     const std::string& route, int units, const std::string& gateway) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto key = "usage:" + account;
  const auto current = r.get(key);
  const long long total = current ? std::stoll(*current) : 0;
  if (total + units > kPlanCap) {
    return 429;
  }
  return r.incrby(key, units);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

using namespace sw::redis;

constexpr long long kWindowSeconds = 3600;
constexpr long long kPlanCap = 1'000'000;
const std::string kRecordPrefix = "usage:record:";

const std::string kApplyLua = R"lua(
local window_key = KEYS[1]
local record_key = KEYS[2]
local units = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local total = redis.call('HINCRBY', window_key, 'units', units)
redis.call('HSET', record_key, 'units', units, 'account', ARGV[4], 'route', ARGV[5], 'gateway', ARGV[6])
local over = 0
if total > cap then
  over = 1
  redis.call('HSET', window_key, 'overage', 1)
end
if redis.call('TTL', window_key) < 0 then
  redis.call('EXPIRE', window_key, ttl)
end
return {total, cap, over}
)lua";

std::string windowKey(const std::string& account, long long window) {
  return "usage:{" + account + "}:" + std::to_string(window);
}

long long applyUsage(Redis& r, const std::string& account, const std::string& request_id,
                     const std::string& route, int units, const std::string& gateway) {
  const long long window = std::chrono::system_clock::now().time_since_epoch() / std::chrono::seconds(1) / kWindowSeconds;
  const auto key = windowKey(account, window);
  const auto recordKey = kRecordPrefix + request_id;
  const auto result = r.eval<long long, long long, long long>(
      kApplyLua,
      {key, recordKey},
      {std::to_string(units), std::to_string(kPlanCap), std::to_string(kWindowSeconds), account, route, gateway});
  return std::get<0>(result);
}
`,
    },
  },
  hints: [
    'An account that hit its cap on Monday is still refused on Friday, and during a Redis blip every report from every account comes back `429`. Totals also drift from what the gateway logged.',
    'The starter does `GET`, compare, then `INCRBY`: two round trips with nothing holding them together, a key with no TTL and no hour bucket, and a cap branch that raises instead of recording.',
    'Move the decision into one Lua script run with `eval`: `HINCRBY` units, `HSET` the record under `RECORD_PREFIX`, `EXPIRE` by `WINDOW_SECONDS` on creation, set `overage` past the cap. Key by `window_key(account, now)`.',
  ],
  debrief: `The script has its shape because every piece of the decision depends on the same number: the
increment, the record, the expiry and the cap flag all read the running total, and only Redis can
give them one consistent view of it. Moving them into one \`EVAL\` makes the crash window disappear
rather than shrink. The expiry lives next to the increment for the same reason: a key that is created
without its TTL is a key that outlives its hour. Flagging instead of refusing follows from what
metering is: a side effect of serving the request, not a gate on it. Production meters usually keep a
local fallback counter for the seconds Redis is unreachable and run a reconciliation job that compares
window totals against the gateways' own request logs.`,
};
