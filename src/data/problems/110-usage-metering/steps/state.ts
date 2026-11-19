import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis windowed counters with atomic add-and-flag',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry', 'idempotent-requests'],
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter is the Redis counter behind every report:
\`apply_usage(account, request_id, route, units, gateway)\` reads the window's \`units\` from
\`usage:{account}:{window}\`, checks \`EXISTS\` on the record key, writes the record with \`HSET\` and
adds the units with \`HINCRBY\`, one command at a time. It answers
\`{counted, total, cap, over, window}\` and hides three flaws.

**Failure mode the checks target.** Two gateways delivering the same retry at the same instant both
pass the \`EXISTS\` and both count. Past the plan cap the starter refuses the report, so usage the
customer really sent never reaches billing. And no key ever expires, so Redis keeps every hour of
every account forever.

- One **Lua script** (keys \`window_key\`, \`record_key\` from \`metering.ledger\`) does the whole
  report: if the record exists, answer \`counted: 0\`; else \`HSET\` the record, \`HINCRBY\` the units.
- Metering observes, it does not block: past \`plan_cap(account)\` the report is still counted, the
  window's \`overage\` field becomes \`1\` and the answer has \`over: true\`.
- The script sets \`EXPIRE\` of \`RETAIN_SECONDS\` on the record and on a new window key.`,
  sequence: {
    participants: ['usaged', 'Redis'],
    messages: [
      {
        from: 'usaged',
        to: 'Redis',
        label: 'EVALSHA apply · KEYS[usage:{acct}:{w}, usage:record:{acct}:{req}]',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Redis',
        label: 'EXISTS record → HSET record · HINCRBY units · HSET cap, overage · EXPIRE',
        kind: 'sync',
      },
      {from: 'Redis', to: 'usaged', label: '{counted, total, cap, over}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'counts',
      title: 'Counts reports into the hour they arrive in',
      detail:
        'Each new report adds its units to `usage:{account}:{window}` and leaves its record under `usage:record:{account}:{request_id}`; the next hour starts a new window.',
      match: {
        python: {all: [/def apply_usage\(/, /window_key\(/, /record_key\(/]},
        typescript: {all: [/function applyUsage\(/, /windowKey\(/, /recordKey\(/]},
        go: {all: [/func applyUsage\(/, /ledger\.WindowKey\(/, /ledger\.RecordKey\(/]},
        scala: {all: [/def applyUsage\(/, /Ledger\.windowKey\(/, /Ledger\.recordKey\(/]},
        cpp: {all: [/applyUsage\(/, /ledger::windowKey\(/, /ledger::recordKey\(/]},
      },
    },
    {
      id: 'atomic',
      title: 'Dedupes and counts in one script',
      detail:
        'The record check, the record write and the `HINCRBY` run in one Lua script (`register_script`/`eval`, `defineCommand`, `NewScript`), so a second delivery of the same request id cannot land between them. The starter sends them one command at a time.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]EXISTS['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/r\.exists\(/, /r\.hincrby\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]EXISTS['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/redis\.exists\(/, /redis\.hincrby\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]EXISTS['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/rdb\.Exists\(/, /rdb\.HIncrBy\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]EXISTS['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/jedis\.exists\(/, /jedis\.hincrBy\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]EXISTS['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/redis\.exists\(/, /redis\.hincrby\(/],
        },
      },
    },
    {
      id: 'overage',
      title: 'Flags overage instead of refusing',
      detail:
        "A report that takes the window past the plan cap is counted; the window's `overage` becomes `1` in the same script as the count and the answer says `over`. A window exactly at its cap is not over. The starter refuses it when `total + units` passes the cap.",
      match: {
        python: {all: [/total\s*>\s*cap/, /['"]overage['"]/], none: [/total\s*\+\s*units\s*>\s*cap/]},
        typescript: {all: [/total\s*>\s*cap/, /['"]overage['"]/], none: [/total\s*\+\s*units\s*>\s*cap/]},
        go: {all: [/total\s*>\s*cap/, /['"]overage['"]/], none: [/total\s*\+\s*units\s*>\s*(cap|planCap)/]},
        scala: {all: [/total\s*>\s*cap/, /['"]overage['"]/], none: [/total\s*\+\s*units\s*>\s*cap/]},
        cpp: {all: [/total\s*>\s*cap/, /['"]overage['"]/], none: [/total\s*\+\s*units\s*>\s*cap/]},
      },
    },
    {
      id: 'expire',
      title: 'Expires the window and the record',
      detail:
        'The script that writes the record and creates the window sets their `EXPIRE` of `RETAIN_SECONDS`, the window only when it is new, so an hour stops costing memory once it can no longer be closed. The starter sets no expiry.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /RETAIN_SECONDS/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /RETAIN_SECONDS/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /ledger\.RetainSeconds/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /Ledger\.RetainSeconds/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /ledger::kRetainSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from metering.ledger import RETAIN_SECONDS, current_window, plan_cap, record_key, window_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def apply_usage(account: str, request_id: str, route: str, units: int, gateway: str) -> dict:
    """Count one report once in the current window: {counted, total, cap, over, window}."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    window = current_window()
    key = window_key(account, window)
    cap = plan_cap(account)
    total = int(r.hget(key, "units") or 0)
    if r.exists(record_key(account, request_id)):
        return {"counted": False, "total": total, "cap": cap, "over": total > cap, "window": window}
    if total + units > cap:
        return {"counted": False, "total": total, "cap": cap, "over": True, "window": window}
    record = {"request_id": request_id, "account": account, "route": route, "units": units, "gateway": gateway, "window": window}
    r.hset(record_key(account, request_id), mapping=record)
    total = r.hincrby(key, "units", units)
    r.hset(key, mapping={"cap": cap, "overage": 0})
    return {"counted": True, "total": total, "cap": cap, "over": False, "window": window}
`,
      solution: `import redis

from metering.ledger import RETAIN_SECONDS, current_window, plan_cap, record_key, window_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}
# ARGV: units, cap, retain seconds, window, request_id, account, route, gateway
APPLY_LUA = """
local cap = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then
  local seen = tonumber(redis.call('HGET', KEYS[1], 'units') or '0')
  local was = 0
  if seen > cap then was = 1 end
  return {0, seen, cap, was}
end
redis.call('HSET', KEYS[2], 'request_id', ARGV[5], 'account', ARGV[6], 'route', ARGV[7], 'units', ARGV[1], 'gateway', ARGV[8], 'window', ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local total = redis.call('HINCRBY', KEYS[1], 'units', ARGV[1])
local over = 0
if total > cap then over = 1 end
redis.call('HSET', KEYS[1], 'cap', cap, 'overage', over)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, total, cap, over}
"""
apply = r.register_script(APPLY_LUA)


def apply_usage(account: str, request_id: str, route: str, units: int, gateway: str) -> dict:
    """Count one report once in the current window: {counted, total, cap, over, window}."""
    window = current_window()
    # One script: nothing can land between the dedupe, the record and the count.
    counted, total, cap, over = apply(
        keys=[window_key(account, window), record_key(account, request_id)],
        args=[units, plan_cap(account), RETAIN_SECONDS, window, request_id, account, route, gateway],
    )
    return {"counted": counted == 1, "total": total, "cap": cap, "over": over == 1, "window": window}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Applied, RETAIN_SECONDS, currentWindow, planCap, recordKey, windowKey} from 'metering/ledger';

const redis = new Redis({host: 'redis', port: 6379});

/** Count one report once in the current window. */
export async function applyUsage(account: string, requestId: string, route: string, units: number, gateway: string): Promise<Applied> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const window = currentWindow();
  const key = windowKey(account, window);
  const cap = await planCap(account);
  let total = Number((await redis.hget(key, 'units')) ?? 0);
  if ((await redis.exists(recordKey(account, requestId))) === 1) return {counted: false, total, cap, over: total > cap, window};
  if (total + units > cap) return {counted: false, total, cap, over: true, window};
  await redis.hset(recordKey(account, requestId), {request_id: requestId, account, route, units: String(units), gateway, window: String(window)});
  total = await redis.hincrby(key, 'units', units);
  await redis.hset(key, {cap: String(cap), overage: '0'});
  return {counted: true, total, cap, over: false, window};
}
`,
      solution: `import Redis from 'ioredis';

import {type Applied, RETAIN_SECONDS, currentWindow, planCap, recordKey, windowKey} from 'metering/ledger';

// KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}
// ARGV: units, cap, retain seconds, window, request_id, account, route, gateway
export const APPLY_LUA = \`
local cap = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then
  local seen = tonumber(redis.call('HGET', KEYS[1], 'units') or '0')
  local was = 0
  if seen > cap then was = 1 end
  return {0, seen, cap, was}
end
redis.call('HSET', KEYS[2], 'request_id', ARGV[5], 'account', ARGV[6], 'route', ARGV[7], 'units', ARGV[1], 'gateway', ARGV[8], 'window', ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local total = redis.call('HINCRBY', KEYS[1], 'units', ARGV[1])
local over = 0
if total > cap then over = 1 end
redis.call('HSET', KEYS[1], 'cap', cap, 'overage', over)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, total, cap, over}
\`;

interface ApplyRedis extends Redis {
  applyUsage(windowKey: string, recordKey: string, ...args: (string | number)[]): Promise<number[]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ApplyRedis;
redis.defineCommand('applyUsage', {numberOfKeys: 2, lua: APPLY_LUA});

/** Count one report once in the current window. */
export async function applyUsage(account: string, requestId: string, route: string, units: number, gateway: string): Promise<Applied> {
  const window = currentWindow();
  // One script: nothing can land between the dedupe, the record and the count.
  const [counted, total, cap, over] = await redis.applyUsage(
    windowKey(account, window),
    recordKey(account, requestId),
    units,
    await planCap(account),
    RETAIN_SECONDS,
    window,
    requestId,
    account,
    route,
    gateway,
  );
  return {counted: counted === 1, total, cap, over: over === 1, window};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"metering/ledger" // ledger.CurrentWindow, WindowKey, RecordKey, PlanCap, RetainSeconds, Applied
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// applyUsage counts one report once in the current window.
func applyUsage(ctx context.Context, account, requestID, route string, units int64, gateway string) (ledger.Applied, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	window := ledger.CurrentWindow()
	key := ledger.WindowKey(account, window)
	cap := ledger.PlanCap(ctx, account)
	total, _ := rdb.HGet(ctx, key, "units").Int64()
	if rdb.Exists(ctx, ledger.RecordKey(account, requestID)).Val() == 1 {
		return ledger.Applied{Counted: false, Total: total, Cap: cap, Over: total > cap, Window: window}, nil
	}
	if total+units > cap {
		return ledger.Applied{Counted: false, Total: total, Cap: cap, Over: true, Window: window}, nil
	}
	record := map[string]any{"request_id": requestID, "account": account, "route": route, "units": units, "gateway": gateway, "window": window}
	if err := rdb.HSet(ctx, ledger.RecordKey(account, requestID), record).Err(); err != nil {
		return ledger.Applied{}, err
	}
	total, err := rdb.HIncrBy(ctx, key, "units", units).Result()
	if err != nil {
		return ledger.Applied{}, err
	}
	rdb.HSet(ctx, key, "cap", cap, "overage", 0)
	return ledger.Applied{Counted: true, Total: total, Cap: cap, Over: false, Window: window}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"metering/ledger" // ledger.CurrentWindow, WindowKey, RecordKey, PlanCap, RetainSeconds, Applied
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// applyScript runs on KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}
// with ARGV units, cap, retain seconds, window, request_id, account, route, gateway.
var applyScript = redis.NewScript(\`
local cap = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then
  local seen = tonumber(redis.call('HGET', KEYS[1], 'units') or '0')
  local was = 0
  if seen > cap then was = 1 end
  return {0, seen, cap, was}
end
redis.call('HSET', KEYS[2], 'request_id', ARGV[5], 'account', ARGV[6], 'route', ARGV[7], 'units', ARGV[1], 'gateway', ARGV[8], 'window', ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local total = redis.call('HINCRBY', KEYS[1], 'units', ARGV[1])
local over = 0
if total > cap then over = 1 end
redis.call('HSET', KEYS[1], 'cap', cap, 'overage', over)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, total, cap, over}
\`)

// applyUsage counts one report once in the current window.
func applyUsage(ctx context.Context, account, requestID, route string, units int64, gateway string) (ledger.Applied, error) {
	window := ledger.CurrentWindow()
	keys := []string{ledger.WindowKey(account, window), ledger.RecordKey(account, requestID)}
	// One script: nothing can land between the dedupe, the record and the count.
	out, err := applyScript.Run(ctx, rdb, keys, units, ledger.PlanCap(ctx, account), ledger.RetainSeconds, window, requestID, account, route, gateway).Int64Slice()
	if err != nil {
		return ledger.Applied{}, err
	}
	return ledger.Applied{Counted: out[0] == 1, Total: out[1], Cap: out[2], Over: out[3] == 1, Window: window}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import metering.Ledger // Ledger.currentWindow, windowKey, recordKey, planCap, RetainSeconds, Applied

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Count one report once in the current window. */
  def applyUsage(account: String, requestId: String, route: String, units: Long, gateway: String): Ledger.Applied = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val window = Ledger.currentWindow()
    val key = Ledger.windowKey(account, window)
    val cap = Ledger.planCap(account)
    val total = Option(jedis.hget(key, "units")).map(_.toLong).getOrElse(0L)
    if (jedis.exists(Ledger.recordKey(account, requestId))) Ledger.Applied(counted = false, total, cap, total > cap, window)
    else if (total + units > cap) Ledger.Applied(counted = false, total, cap, over = true, window)
    else {
      val record = Map("request_id" -> requestId, "account" -> account, "route" -> route, "units" -> units.toString, "gateway" -> gateway, "window" -> window.toString)
      jedis.hset(Ledger.recordKey(account, requestId), record.asJava)
      val counted = jedis.hincrBy(key, "units", units)
      jedis.hset(key, Map("cap" -> cap.toString, "overage" -> "0").asJava)
      Ledger.Applied(counted = true, counted, cap, over = false, window)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import metering.Ledger // Ledger.currentWindow, windowKey, recordKey, planCap, RetainSeconds, Applied

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}; ARGV units, cap, retain seconds, window, request_id, account, route, gateway. */
  val ApplyLua: String =
    """local cap = tonumber(ARGV[2])
      |if redis.call('EXISTS', KEYS[2]) == 1 then
      |  local seen = tonumber(redis.call('HGET', KEYS[1], 'units') or '0')
      |  local was = 0
      |  if seen > cap then was = 1 end
      |  return {0, seen, cap, was}
      |end
      |redis.call('HSET', KEYS[2], 'request_id', ARGV[5], 'account', ARGV[6], 'route', ARGV[7], 'units', ARGV[1], 'gateway', ARGV[8], 'window', ARGV[4])
      |redis.call('EXPIRE', KEYS[2], ARGV[3])
      |local total = redis.call('HINCRBY', KEYS[1], 'units', ARGV[1])
      |local over = 0
      |if total > cap then over = 1 end
      |redis.call('HSET', KEYS[1], 'cap', cap, 'overage', over)
      |if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
      |return {1, total, cap, over}
      |""".stripMargin

  /** Count one report once in the current window. */
  def applyUsage(account: String, requestId: String, route: String, units: Long, gateway: String): Ledger.Applied = {
    val window = Ledger.currentWindow()
    val keys = List(Ledger.windowKey(account, window), Ledger.recordKey(account, requestId)).asJava
    val args = List(units.toString, Ledger.planCap(account).toString, Ledger.RetainSeconds.toString, window.toString, requestId, account, route, gateway).asJava
    // One script: nothing can land between the dedupe, the record and the count.
    val out = jedis.eval(ApplyLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    Ledger.Applied(out(0) == 1L, out(1), out(2), out(3) == 1L, window)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "metering/ledger.h"  // ledger::currentWindow, windowKey, recordKey, planCap, kRetainSeconds, Applied

sw::redis::Redis redis("tcp://redis:6379");

// Count one report once in the current window.
ledger::Applied applyUsage(const std::string& account, const std::string& request_id, const std::string& route, long long units,
                           const std::string& gateway) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const long long window = ledger::currentWindow();
  const std::string key = ledger::windowKey(account, window);
  const long long cap = ledger::planCap(account);
  const auto seen = redis.hget(key, "units");
  long long total = seen ? std::stoll(*seen) : 0;
  if (redis.exists(ledger::recordKey(account, request_id))) return ledger::Applied{false, total, cap, total > cap, window};
  if (total + units > cap) return ledger::Applied{false, total, cap, true, window};
  redis.hset(ledger::recordKey(account, request_id), {{"request_id", request_id}, {"account", account}, {"route", route},
                                                      {"units", std::to_string(units)}, {"gateway", gateway}, {"window", std::to_string(window)}});
  total = redis.hincrby(key, "units", units);
  redis.hset(key, {{"cap", std::to_string(cap)}, {"overage", "0"}});
  return ledger::Applied{true, total, cap, false, window};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "metering/ledger.h"  // ledger::currentWindow, windowKey, recordKey, planCap, kRetainSeconds, Applied

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}
// ARGV: units, cap, retain seconds, window, request_id, account, route, gateway
const std::string kApplyLua = R"lua(
local cap = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then
  local seen = tonumber(redis.call('HGET', KEYS[1], 'units') or '0')
  local was = 0
  if seen > cap then was = 1 end
  return {0, seen, cap, was}
end
redis.call('HSET', KEYS[2], 'request_id', ARGV[5], 'account', ARGV[6], 'route', ARGV[7], 'units', ARGV[1], 'gateway', ARGV[8], 'window', ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local total = redis.call('HINCRBY', KEYS[1], 'units', ARGV[1])
local over = 0
if total > cap then over = 1 end
redis.call('HSET', KEYS[1], 'cap', cap, 'overage', over)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, total, cap, over}
)lua";

// Count one report once in the current window.
ledger::Applied applyUsage(const std::string& account, const std::string& request_id, const std::string& route, long long units,
                           const std::string& gateway) {
  const long long window = ledger::currentWindow();
  const std::vector<std::string> keys = {ledger::windowKey(account, window), ledger::recordKey(account, request_id)};
  const std::vector<std::string> args = {std::to_string(units), std::to_string(ledger::planCap(account)), std::to_string(ledger::kRetainSeconds),
                                         std::to_string(window), request_id, account, route, gateway};
  // One script: nothing can land between the dedupe, the record and the count.
  const auto out = redis.eval<std::vector<long long>>(kApplyLua, keys, args);
  return ledger::Applied{out[0] == 1, out[1], out[2], out[3] == 1, window};
}
`,
    },
  },
  harness: {
    python: `import time

from metering import ledger


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_counts(ctx):
    m = ctx.load("state")
    w = ledger.current_window()
    first = m.apply_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    assert first.get("counted") is True and first.get("total") == 1200 and first.get("window") == w, f"the first report must be counted into window {w} with total 1200, got {first}"
    second = m.apply_usage("acct_1", "req_2", "/v1/embed", 300, "gw-eu-1")
    assert second.get("total") == 1500, f"a second report of 300 units must bring the window to 1500, got {second}"
    assert ledger.read_window("acct_1", w)["units"] == 1500, f"usage:acct_1:{w} holds {ledger.read_window('acct_1', w)}, expected 1500 units"
    record = ledger.find_record("acct_1", "req_1")
    assert record is not None and record["gateway"] == "gw-eu-1" and record["units"] == 1200 and record["window"] == w, f"usage:record:acct_1:req_1 holds {record}"
    ctx.clock.advance(ledger.WINDOW_SECONDS)
    later = m.apply_usage("acct_1", "req_3", "/v1/generate", 50, "gw-eu-1")
    assert later.get("window") == w + 1 and later.get("total") == 50, f"a report an hour later must open window {w + 1} with 50 units, got {later}"


def check_atomic(ctx):
    m = ctx.load("state")
    w = ledger.current_window()
    # Another gateway delivers the same retry while this one is between its commands.
    rival = ctx.redis_after(ledger.record_key("acct_1", "req_1"), lambda: m.apply_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-us-2"))
    mine = m.apply_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    theirs = _settled(rival, "the record key")
    units = ledger.read_window("acct_1", w)["units"]
    assert units == 1200, f"two deliveries of req_1 landing together left {units} units in the window: the dedupe and the count must run in one script"
    counted = [a.get("counted") for a in (mine, theirs)]
    assert sorted(counted) == [False, True], f"exactly one of the two deliveries may be counted, they answered counted {counted}"


def check_overage(ctx):
    m = ctx.load("state")
    w = ledger.current_window()
    ledger.set_plan_cap("acct_1", 1000)
    first = m.apply_usage("acct_1", "req_1", "/v1/generate", 600, "gw-eu-1")
    assert first.get("counted") is True and first.get("over") is False, f"600 of a 1000-unit plan must be counted and not over, got {first}"
    at_cap = m.apply_usage("acct_1", "req_2", "/v1/generate", 400, "gw-eu-1")
    assert at_cap.get("counted") is True and at_cap.get("total") == 1000 and at_cap.get("over") is False, f"a window at exactly its 1000-unit cap is not over it, got {at_cap}"
    past = m.apply_usage("acct_1", "req_3", "/v1/generate", 200, "gw-eu-1")
    assert past.get("counted") is True and past.get("total") == 1200, f"a report past the plan cap was refused ({past}): metering counts what was used and flags it, it does not block"
    assert past.get("over") is True and past.get("cap") == 1000, f"a window at 1200 of a 1000-unit plan must answer over true with cap 1000, got {past}"
    flags = ctx.redis.hgetall(ledger.window_key("acct_1", w))
    assert flags.get("overage") == "1" and flags.get("cap") == "1000", f"usage:acct_1:{w} holds {flags}: the window must carry cap 1000 and overage 1"
    # Another gateway's report lands right after this one's count: the flag must describe the window's final total.
    ledger.set_plan_cap("acct_2", 1000)
    rival = ctx.redis_after(ledger.window_key("acct_2", w), lambda: m.apply_usage("acct_2", "req_b", "/v1/generate", 600, "gw-us-2"))
    m.apply_usage("acct_2", "req_a", "/v1/generate", 600, "gw-eu-1")
    _settled(rival, "the window key of acct_2")
    raced = ctx.redis.hgetall(ledger.window_key("acct_2", w))
    assert raced.get("units") == "1200" and raced.get("overage") == "1", f"two reports of 600 landing together on a 1000-unit plan left usage:acct_2:{w} at {raced}: the overage flag must be written in the same script as the count, or a slower report overwrites it"


def check_expire(ctx):
    m = ctx.load("state")
    # The scenario spans a minute: start it early enough in an hour that it stays in one window.
    left = ledger.WINDOW_SECONDS - int(time.time()) % ledger.WINDOW_SECONDS
    if left <= 120:
        ctx.clock.advance(left)
    w = ledger.current_window()
    window_key, record_key = ledger.window_key("acct_1", w), ledger.record_key("acct_1", "req_1")
    # The TTL the moment each key is created: a key without one in between lives forever if the process dies.
    at_create = {key: ctx.redis_after(key, lambda key=key: ctx.redis.ttl(key)) for key in (window_key, record_key)}
    m.apply_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    for key in (window_key, record_key):
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= ledger.RETAIN_SECONDS, f"{key} has TTL {ttl}: it must expire within RETAIN_SECONDS ({ledger.RETAIN_SECONDS} s), or Redis keeps every hour of every account"
        ttl = _settled(at_create[key], key)
        assert 0 < ttl <= ledger.RETAIN_SECONDS, f"right after the command that created {key} its TTL was {ttl}: the expiry must be set by the same script that writes the key"
    ctx.clock.advance(60)
    m.apply_usage("acct_1", "req_2", "/v1/generate", 300, "gw-eu-1")
    assert ledger.read_window("acct_1", w)["units"] == 1500, f"a report a minute later must land in window {w}, it holds {ledger.read_window('acct_1', w)}"
    ttl = ctx.redis.ttl(window_key)
    assert 0 < ttl <= ledger.RETAIN_SECONDS - 60, f"a minute after the window opened another report left {window_key} with TTL {ttl}: the expiry is set on a new window key only, or a busy hour never expires"
`,
    typescript: `function state(ctx) {
  return {m: ctx.load('state'), ledger: ctx.load('/support/metering/ledger.ts')};
}

export async function check_counts(ctx) {
  const {m, ledger} = state(ctx);
  const w = ledger.currentWindow();
  const first = await m.applyUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  assert(first.counted === true && first.total === 1200 && first.window === w, \`the first report must be counted into window \${w} with total 1200, got \${JSON.stringify(first)}\`);
  const second = await m.applyUsage('acct_1', 'req_2', '/v1/embed', 300, 'gw-eu-1');
  assert.equal(second.total, 1500, \`a second report of 300 units must bring the window to 1500, got \${JSON.stringify(second)}\`);
  assert.equal((await ledger.readWindow('acct_1', w)).units, 1500, \`usage:acct_1:\${w} must hold 1500 units\`);
  const record = await ledger.findRecord('acct_1', 'req_1');
  assert(record !== null && record.gateway === 'gw-eu-1' && record.units === 1200 && record.window === w, \`usage:record:acct_1:req_1 holds \${JSON.stringify(record)}\`);
  ctx.clock.advance(ledger.WINDOW_SECONDS);
  const later = await m.applyUsage('acct_1', 'req_3', '/v1/generate', 50, 'gw-eu-1');
  assert(later.window === w + 1 && later.total === 50, \`a report an hour later must open window \${w + 1} with 50 units, got \${JSON.stringify(later)}\`);
}

export async function check_atomic(ctx) {
  const {m, ledger} = state(ctx);
  const w = ledger.currentWindow();
  // Two gateways deliver the same retry at the same moment: their commands interleave on the event loop.
  const [mine, theirs] = await Promise.all([
    m.applyUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1'),
    m.applyUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-us-2'),
  ]);
  const units = (await ledger.readWindow('acct_1', w)).units;
  assert.equal(units, 1200, \`two deliveries of req_1 landing together left \${units} units in the window: the dedupe and the count must run in one script\`);
  const counted = [mine.counted, theirs.counted].sort();
  assert.deepStrictEqual(counted, [false, true], \`exactly one of the two deliveries may be counted, they answered counted \${JSON.stringify(counted)}\`);
}

export async function check_overage(ctx) {
  const {m, ledger} = state(ctx);
  const w = ledger.currentWindow();
  await ledger.setPlanCap('acct_1', 1000);
  const first = await m.applyUsage('acct_1', 'req_1', '/v1/generate', 600, 'gw-eu-1');
  assert(first.counted === true && first.over === false, \`600 of a 1000-unit plan must be counted and not over, got \${JSON.stringify(first)}\`);
  const atCap = await m.applyUsage('acct_1', 'req_2', '/v1/generate', 400, 'gw-eu-1');
  assert(atCap.counted === true && atCap.total === 1000 && atCap.over === false, \`a window at exactly its 1000-unit cap is not over it, got \${JSON.stringify(atCap)}\`);
  const past = await m.applyUsage('acct_1', 'req_3', '/v1/generate', 200, 'gw-eu-1');
  assert(past.counted === true && past.total === 1200, \`a report past the plan cap was refused (\${JSON.stringify(past)}): metering counts what was used and flags it, it does not block\`);
  assert(past.over === true && past.cap === 1000, \`a window at 1200 of a 1000-unit plan must answer over true with cap 1000, got \${JSON.stringify(past)}\`);
  const flags = ctx.redis.hgetall(ledger.windowKey('acct_1', w));
  assert(flags.overage === '1' && flags.cap === '1000', \`usage:acct_1:\${w} holds \${JSON.stringify(flags)}: the window must carry cap 1000 and overage 1\`);
  // Another usaged instance counts a report right after this one's count: the flag must describe the window's final total.
  await ledger.setPlanCap('acct_2', 1000);
  const {APPLY_LUA} = ctx.load('/support/metering/usage.ts');
  const rival = ctx.redisAfter(ledger.windowKey('acct_2', w), () =>
    ctx.redis.eval(APPLY_LUA, 2, ledger.windowKey('acct_2', w), ledger.recordKey('acct_2', 'req_b'), 600, 1000, ledger.RETAIN_SECONDS, w, 'req_b', 'acct_2', '/v1/generate', 'gw-us-2'),
  );
  await m.applyUsage('acct_2', 'req_a', '/v1/generate', 600, 'gw-eu-1');
  assert(rival.fired, 'nothing touched the window key of acct_2');
  if (rival.error !== undefined) throw rival.error;
  const raced = ctx.redis.hgetall(ledger.windowKey('acct_2', w));
  assert(raced.units === '1200' && raced.overage === '1', \`two reports of 600 landing together on a 1000-unit plan left usage:acct_2:\${w} at \${JSON.stringify(raced)}: the overage flag must be written in the same script as the count, or a slower report overwrites it\`);
}

export async function check_expire(ctx) {
  const {m, ledger} = state(ctx);
  // The scenario spans a minute: start it early enough in an hour that it stays in one window.
  const left = ledger.WINDOW_SECONDS - (Math.floor(ctx.clock.now() / 1000) % ledger.WINDOW_SECONDS);
  if (left <= 120) ctx.clock.advance(left);
  const w = ledger.currentWindow();
  const keys = [ledger.windowKey('acct_1', w), ledger.recordKey('acct_1', 'req_1')];
  // The TTL the moment each key is created: a key without one in between lives forever if the process dies.
  const atCreate = keys.map(key => ctx.redisAfter(key, () => ctx.redis.ttl(key)));
  await m.applyUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  keys.forEach((key, i) => {
    const ttl = ctx.redis.ttl(key);
    assert(ttl > 0 && ttl <= ledger.RETAIN_SECONDS, \`\${key} has TTL \${ttl}: it must expire within RETAIN_SECONDS (\${ledger.RETAIN_SECONDS} s), or Redis keeps every hour of every account\`);
    const probe = atCreate[i];
    assert(probe.fired, \`nothing touched \${key}\`);
    if (probe.error !== undefined) throw probe.error;
    assert(probe.result > 0 && probe.result <= ledger.RETAIN_SECONDS, \`right after the command that created \${key} its TTL was \${probe.result}: the expiry must be set by the same script that writes the key\`);
  });
  ctx.clock.advance(60);
  await m.applyUsage('acct_1', 'req_2', '/v1/generate', 300, 'gw-eu-1');
  const units = (await ledger.readWindow('acct_1', w)).units;
  assert.equal(units, 1500, \`a report a minute later must land in window \${w}; its units\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 0 && ttl <= ledger.RETAIN_SECONDS - 60, \`a minute after the window opened another report left \${keys[0]} with TTL \${ttl}: the expiry is set on a new window key only, or a busy hour never expires\`);
}
`,
    go: `package main

import (
	"context"
	"sort"

	"metering/ledger"

	"leetbuild/harness"
)

var hStateBg = context.Background()

func hMustApply(ctx *harness.Ctx, requestID string, units int64, gateway string) ledger.Applied {
	applied, err := applyUsage(hStateBg, "acct_1", requestID, "/v1/generate", units, gateway)
	ctx.NoError(err, "applyUsage(acct_1, %s) failed", requestID)
	return applied
}

func CheckCounts(ctx *harness.Ctx) {
	w := ledger.CurrentWindow()
	first := hMustApply(ctx, "req_1", 1200, "gw-eu-1")
	ctx.Assert(first.Counted && first.Total == 1200 && first.Window == w, "the first report must be counted into window %d with total 1200, got %+v", w, first)
	second := hMustApply(ctx, "req_2", 300, "gw-eu-1")
	ctx.Equal(second.Total, int64(1500), "a second report of 300 units must bring the window to 1500; the total")
	ctx.Equal(ledger.ReadWindow(hStateBg, "acct_1", w).Units, int64(1500), "usage:acct_1:%d units", w)
	record := ledger.FindRecord(hStateBg, "acct_1", "req_1")
	ctx.Assert(record != nil && record.Gateway == "gw-eu-1" && record.Units == 1200 && record.Window == w, "usage:record:acct_1:req_1 holds %+v", record)
	ctx.Clock.Advance(ledger.WindowSeconds)
	later := hMustApply(ctx, "req_3", 50, "gw-eu-1")
	ctx.Assert(later.Window == w+1 && later.Total == 50, "a report an hour later must open window %d with 50 units, got %+v", w+1, later)
}

func CheckAtomic(ctx *harness.Ctx) {
	w := ledger.CurrentWindow()
	// Another gateway delivers the same retry while this one is between its commands.
	rival := ctx.Redis.After(ledger.RecordKey("acct_1", "req_1"), func() any {
		applied, err := applyUsage(hStateBg, "acct_1", "req_1", "/v1/generate", 1200, "gw-us-2")
		ctx.NoError(err, "the rival delivery failed")
		return applied
	})
	mine := hMustApply(ctx, "req_1", 1200, "gw-eu-1")
	ctx.Assert(rival.Fired, "nothing touched the record key")
	ctx.Assert(rival.Err == nil, "the rival delivery failed: %v", rival.Err)
	units := ledger.ReadWindow(hStateBg, "acct_1", w).Units
	ctx.Assert(units == 1200, "two deliveries of req_1 landing together left %d units in the window: the dedupe and the count must run in one script", units)
	theirs, _ := rival.Result.(ledger.Applied)
	counted := []bool{mine.Counted, theirs.Counted}
	sort.Slice(counted, func(i, j int) bool { return !counted[i] && counted[j] })
	ctx.Equal(counted, []bool{false, true}, "exactly one of the two deliveries may be counted; counted")
}

func CheckOverage(ctx *harness.Ctx) {
	w := ledger.CurrentWindow()
	ledger.SetPlanCap(hStateBg, "acct_1", 1000)
	first := hMustApply(ctx, "req_1", 600, "gw-eu-1")
	ctx.Assert(first.Counted && !first.Over, "600 of a 1000-unit plan must be counted and not over, got %+v", first)
	atCap := hMustApply(ctx, "req_2", 400, "gw-eu-1")
	ctx.Assert(atCap.Counted && atCap.Total == 1000 && !atCap.Over, "a window at exactly its 1000-unit cap is not over it, got %+v", atCap)
	past := hMustApply(ctx, "req_3", 200, "gw-eu-1")
	ctx.Assert(past.Counted && past.Total == 1200, "a report past the plan cap was refused (%+v): metering counts what was used and flags it, it does not block", past)
	ctx.Assert(past.Over && past.Cap == 1000, "a window at 1200 of a 1000-unit plan must answer over true with cap 1000, got %+v", past)
	flags := ctx.Redis.HGetAll(ledger.WindowKey("acct_1", w))
	ctx.Assert(flags["overage"] == "1" && flags["cap"] == "1000", "usage:acct_1:%d holds %v: the window must carry cap 1000 and overage 1", w, flags)
	// Another gateway's report lands right after this one's count: the flag must describe the window's final total.
	ledger.SetPlanCap(hStateBg, "acct_2", 1000)
	rival := ctx.Redis.After(ledger.WindowKey("acct_2", w), func() any {
		applied, err := applyUsage(hStateBg, "acct_2", "req_b", "/v1/generate", 600, "gw-us-2")
		ctx.NoError(err, "the rival report failed")
		return applied
	})
	_, err := applyUsage(hStateBg, "acct_2", "req_a", "/v1/generate", 600, "gw-eu-1")
	ctx.NoError(err, "applyUsage(acct_2, req_a) failed")
	ctx.Assert(rival.Fired, "nothing touched the window key of acct_2")
	ctx.Assert(rival.Err == nil, "the rival report failed: %v", rival.Err)
	raced := ctx.Redis.HGetAll(ledger.WindowKey("acct_2", w))
	ctx.Assert(raced["units"] == "1200" && raced["overage"] == "1", "two reports of 600 landing together on a 1000-unit plan left usage:acct_2:%d at %v: the overage flag must be written in the same script as the count, or a slower report overwrites it", w, raced)
}

func CheckExpire(ctx *harness.Ctx) {
	// The scenario spans a minute: start it early enough in an hour that it stays in one window.
	if left := ledger.WindowSeconds - (ctx.Clock.Now()/1000)%ledger.WindowSeconds; left <= 120 {
		ctx.Clock.Advance(float64(left))
	}
	w := ledger.CurrentWindow()
	windowKey, recordKey := ledger.WindowKey("acct_1", w), ledger.RecordKey("acct_1", "req_1")
	// The TTL the moment each key is created: a key without one in between lives forever if the process dies.
	windowAt := ctx.Redis.After(windowKey, func() any { return ctx.Redis.TTL(windowKey) })
	recordAt := ctx.Redis.After(recordKey, func() any { return ctx.Redis.TTL(recordKey) })
	hMustApply(ctx, "req_1", 1200, "gw-eu-1")
	for _, key := range []string{windowKey, recordKey} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 0 && ttl <= ledger.RetainSeconds, "%s has TTL %d: it must expire within RetainSeconds (%d s), or Redis keeps every hour of every account", key, ttl, ledger.RetainSeconds)
	}
	ctx.Assert(windowAt.Fired && recordAt.Fired, "nothing touched %s or %s", windowKey, recordKey)
	ctx.Assert(windowAt.Err == nil && recordAt.Err == nil, "reading the TTL right after the count failed: %v %v", windowAt.Err, recordAt.Err)
	windowTTL, _ := windowAt.Result.(int64)
	recordTTL, _ := recordAt.Result.(int64)
	ctx.Assert(windowTTL > 0 && windowTTL <= ledger.RetainSeconds, "right after the command that created %s its TTL was %d: the expiry must be set by the same script that writes the key", windowKey, windowTTL)
	ctx.Assert(recordTTL > 0 && recordTTL <= ledger.RetainSeconds, "right after the command that created %s its TTL was %d: the expiry must be set by the same script that writes the key", recordKey, recordTTL)
	ctx.Clock.Advance(60)
	hMustApply(ctx, "req_2", 300, "gw-eu-1")
	ctx.Equal(ledger.ReadWindow(hStateBg, "acct_1", w).Units, int64(1500), "a report a minute later must land in window %d; its units", w)
	ttl := ctx.Redis.TTL(windowKey)
	ctx.Assert(ttl > 0 && ttl <= ledger.RetainSeconds-60, "a minute after the window opened another report left %s with TTL %d: the expiry is set on a new window key only, or a busy hour never expires", windowKey, ttl)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "metering/ledger.h"

namespace {

// The rival delivery's outcome: whether it ran, what it answered, what it threw.
struct HRival {
  bool fired = false;
  ledger::Applied applied;
  std::optional<std::string> err;
};

}  // namespace

void CheckCounts(harness::Ctx& ctx) {
  const long long w = ledger::currentWindow();
  const auto first = applyUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  ctx.Assert(first.counted && first.total == 1200 && first.window == w, "the first report must be counted into window %d with total 1200, got counted %t total %d window %d", w, first.counted, first.total, first.window);
  const auto second = applyUsage("acct_1", "req_2", "/v1/embed", 300, "gw-eu-1");
  ctx.Equal(second.total, 1500LL, "a second report of 300 units must bring the window to 1500; the total");
  ctx.Equal(ledger::readWindow("acct_1", w).units, 1500LL, "usage:acct_1:%d units", w);
  const auto record = ledger::findRecord("acct_1", "req_1");
  ctx.Assert(record && record->gateway == "gw-eu-1" && record->units == 1200 && record->window == w, "usage:record:acct_1:req_1 holds gateway %q units %d window %d", record ? record->gateway : "", record ? record->units : 0LL, record ? record->window : 0LL);
  ctx.Clock.Advance(static_cast<double>(ledger::kWindowSeconds));
  const auto later = applyUsage("acct_1", "req_3", "/v1/generate", 50, "gw-eu-1");
  ctx.Assert(later.window == w + 1 && later.total == 50, "a report an hour later must open window %d with 50 units, got window %d total %d", w + 1, later.window, later.total);
}

void CheckAtomic(harness::Ctx& ctx) {
  const long long w = ledger::currentWindow();
  // Another gateway delivers the same retry while this one is between its commands.
  auto rival = std::make_shared<HRival>();
  ctx.Redis.After(ledger::recordKey("acct_1", "req_1"), [rival] {
    rival->fired = true;
    try {
      rival->applied = applyUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-us-2");
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const auto mine = applyUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  ctx.Assert(rival->fired, "nothing touched the record key");
  ctx.Assert(!rival->err, "the rival delivery failed: %s", rival->err.value_or(""));
  const long long units = ledger::readWindow("acct_1", w).units;
  ctx.Assert(units == 1200, "two deliveries of req_1 landing together left %d units in the window: the dedupe and the count must run in one script", units);
  ctx.Assert(mine.counted != rival->applied.counted, "exactly one of the two deliveries may be counted, they answered counted %t and %t", mine.counted, rival->applied.counted);
}

void CheckOverage(harness::Ctx& ctx) {
  const long long w = ledger::currentWindow();
  ledger::setPlanCap("acct_1", 1000);
  const auto first = applyUsage("acct_1", "req_1", "/v1/generate", 600, "gw-eu-1");
  ctx.Assert(first.counted && !first.over, "600 of a 1000-unit plan must be counted and not over, got counted %t over %t", first.counted, first.over);
  const auto atCap = applyUsage("acct_1", "req_2", "/v1/generate", 400, "gw-eu-1");
  ctx.Assert(atCap.counted && atCap.total == 1000 && !atCap.over, "a window at exactly its 1000-unit cap is not over it, got counted %t total %d over %t", atCap.counted, atCap.total, atCap.over);
  const auto past = applyUsage("acct_1", "req_3", "/v1/generate", 200, "gw-eu-1");
  ctx.Assert(past.counted && past.total == 1200, "a report past the plan cap was refused (counted %t, total %d): metering counts what was used and flags it, it does not block", past.counted, past.total);
  ctx.Assert(past.over && past.cap == 1000, "a window at 1200 of a 1000-unit plan must answer over true with cap 1000, got over %t cap %d", past.over, past.cap);
  const auto flags = ctx.Redis.HGetAll(ledger::windowKey("acct_1", w));
  ctx.Assert(flags.count("overage") && flags.at("overage") == "1" && flags.count("cap") && flags.at("cap") == "1000", "usage:acct_1:%d holds %v: the window must carry cap 1000 and overage 1", w, flags);
  // Another gateway's report lands right after this one's count: the flag must describe the window's final total.
  ledger::setPlanCap("acct_2", 1000);
  auto rival = std::make_shared<HRival>();
  ctx.Redis.After(ledger::windowKey("acct_2", w), [rival] {
    rival->fired = true;
    try {
      rival->applied = applyUsage("acct_2", "req_b", "/v1/generate", 600, "gw-us-2");
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  applyUsage("acct_2", "req_a", "/v1/generate", 600, "gw-eu-1");
  ctx.Assert(rival->fired, "nothing touched the window key of acct_2");
  ctx.Assert(!rival->err, "the rival report failed: %s", rival->err.value_or(""));
  const auto raced = ctx.Redis.HGetAll(ledger::windowKey("acct_2", w));
  ctx.Assert(raced.count("units") && raced.at("units") == "1200" && raced.count("overage") && raced.at("overage") == "1", "two reports of 600 landing together on a 1000-unit plan left usage:acct_2:%d at %v: the overage flag must be written in the same script as the count, or a slower report overwrites it", w, raced);
}

void CheckExpire(harness::Ctx& ctx) {
  // The scenario spans a minute: start it early enough in an hour that it stays in one window.
  const long long left = ledger::kWindowSeconds - (ctx.Clock.Now() / 1000) % ledger::kWindowSeconds;
  if (left <= 120) ctx.Clock.Advance(static_cast<double>(left));
  const long long w = ledger::currentWindow();
  const std::string windowKey = ledger::windowKey("acct_1", w);
  const std::string recordKey = ledger::recordKey("acct_1", "req_1");
  // The TTL the moment each key is created: a key without one in between lives forever if the process dies.
  auto windowAt = std::make_shared<std::optional<long long>>();
  auto recordAt = std::make_shared<std::optional<long long>>();
  ctx.Redis.After(windowKey, [&ctx, windowKey, windowAt] { *windowAt = ctx.Redis.TTL(windowKey); });
  ctx.Redis.After(recordKey, [&ctx, recordKey, recordAt] { *recordAt = ctx.Redis.TTL(recordKey); });
  applyUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  for (const std::string& key : {windowKey, recordKey}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 0 && ttl <= ledger::kRetainSeconds, "%s has TTL %d: it must expire within kRetainSeconds (%d s), or Redis keeps every hour of every account", key, ttl, ledger::kRetainSeconds);
  }
  ctx.Assert(windowAt->has_value() && recordAt->has_value(), "nothing touched %s or %s", windowKey, recordKey);
  ctx.Assert(windowAt->value_or(-2) > 0 && windowAt->value_or(-2) <= ledger::kRetainSeconds, "right after the command that created %s its TTL was %d: the expiry must be set by the same script that writes the key", windowKey, windowAt->value_or(-2));
  ctx.Assert(recordAt->value_or(-2) > 0 && recordAt->value_or(-2) <= ledger::kRetainSeconds, "right after the command that created %s its TTL was %d: the expiry must be set by the same script that writes the key", recordKey, recordAt->value_or(-2));
  ctx.Clock.Advance(60);
  applyUsage("acct_1", "req_2", "/v1/generate", 300, "gw-eu-1");
  ctx.Equal(ledger::readWindow("acct_1", w).units, 1500LL, "a report a minute later must land in window %d; its units", w);
  const long long ttl = ctx.Redis.TTL(windowKey);
  ctx.Assert(ttl > 0 && ttl <= ledger::kRetainSeconds - 60, "a minute after the window opened another report left %s with TTL %d: the expiry is set on a new window key only, or a busy hour never expires", windowKey, ttl);
}
`,
  },
  hints: [
    'Deliver one request id from two gateways at the same moment: the window counts it twice. Push an account past its plan: the report is dropped. Look at the keys a day later: every hour is still there.',
    'Each command is its own round trip, so a second delivery can run between the `EXISTS` and the `HINCRBY`. The cap check returns before the count, and no command ever sets a TTL.',
    'Move the `EXISTS`, `HSET` record, `HINCRBY`, `HSET cap overage` and `EXPIRE` into one Lua script over the window and record keys, with `overage = total > cap ? 1 : 0` written instead of the early return.',
  ],
  debrief: `Redis runs a Lua script without interleaving other commands, so moving the check and the writes into one script turns "check, then write" into a single step a second delivery cannot split. The cap went from a gate to a flag because the meter's job is to record what was used: refusing past the cap loses revenue silently, while a flag lets billing, alerts and the read in step 5 decide what to do. Expiring a window two hours after it opens keeps it long enough for the close in step 3 and no longer. Production meters also bucket by event time instead of arrival time, and accept late events into a closed window through an adjustment rather than rewriting it.`,
};
