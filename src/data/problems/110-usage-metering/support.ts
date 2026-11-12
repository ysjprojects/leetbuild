/**
 * Hand-written support modules the usage-metering steps import but no step builds: the `metering`
 * package. `metering.ledger` holds every key usaged shares (the hourly window hash, the per-request
 * record, the plan cap, the last billing close), the two-command writer step 1 counts with and the
 * reads steps 3 and 5 use. `metering.usage` is step 2's `apply_usage` as the later steps use it: one
 * Lua script that dedupes, counts, flags overage and sets the expiry. The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'metering/__init__.py': '',
  'metering/ledger.py': `"""
The usage ledger (provided): every key usaged shares. usage:{account}:{window} is an account's hash
for one hour (units, cap, overage); usage:record:{account}:{request_id} the hash of one counted report
(request_id, account, route, units, gateway, window); plan:{account} the plan (cap);
close:{account} the last billing close that tied out (close_id, window, units). A window is
floor(unix seconds / WINDOW_SECONDS); window and record keys live RETAIN_SECONDS, so the previous
hour can still be closed. record_usage is the two-command writer step 1 counts with.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_SECONDS = 3600
RETAIN_SECONDS = 2 * WINDOW_SECONDS
DEFAULT_CAP = 100_000


def current_window() -> int:
    return int(time.time()) // WINDOW_SECONDS


def window_key(account: str, window: int) -> str:
    return f"usage:{account}:{window}"


def record_key(account: str, request_id: str) -> str:
    return f"usage:record:{account}:{request_id}"


def plan_cap(account: str) -> int:
    """The account's plan cap in units per window."""
    cap = r.hget(f"plan:{account}", "cap")
    return int(cap) if cap else DEFAULT_CAP


def set_plan_cap(account: str, cap: int) -> None:
    r.hset(f"plan:{account}", "cap", cap)


def find_record(account: str, request_id: str) -> dict | None:
    """The record counted for (account, request_id), or None: request_id, account, route, units, gateway, window."""
    raw = r.hgetall(record_key(account, request_id))
    if not raw:
        return None
    return {
        "request_id": raw.get("request_id", request_id),
        "account": raw.get("account", account),
        "route": raw.get("route", ""),
        "units": int(raw.get("units", 0)),
        "gateway": raw.get("gateway", ""),
        "window": int(raw.get("window", 0)),
    }


def record_usage(record: dict) -> int:
    """Store the record (its fields as given) in the current window and add its units: two commands, not one. Returns the window's total."""
    window = current_window()
    key = record_key(record["account"], record["request_id"])
    r.hset(key, mapping={**{name: str(value) for name, value in record.items()}, "window": window})
    r.expire(key, RETAIN_SECONDS)
    total = r.hincrby(window_key(record["account"], window), "units", record["units"])
    r.expire(window_key(record["account"], window), RETAIN_SECONDS)
    return total


def read_window(account: str, window: int) -> dict:
    """The window's units, cap and overage flag; an untouched window has 0 units, the plan's cap, no overage."""
    raw = r.hgetall(window_key(account, window))
    cap = int(raw["cap"]) if raw.get("cap") else plan_cap(account)
    return {"units": int(raw.get("units", 0)), "cap": cap, "overage": raw.get("overage") == "1"}


def mark_closed(account: str, window: int, close_id: str, units: int) -> None:
    """Record the billing close that tied out for the window."""
    r.hset(f"close:{account}", mapping={"close_id": close_id, "window": window, "units": units})


def last_close(account: str) -> dict | None:
    """The last close that tied out (close_id, window, units), or None."""
    raw = r.hgetall(f"close:{account}")
    if not raw:
        return None
    return {"close_id": raw["close_id"], "window": int(raw["window"]), "units": int(raw["units"])}
`,
  'metering/usage.py': `"""
apply_usage (provided; step 2 builds the same function): one Lua script dedupes the report on its
record key, writes the record, adds the units to the window, flags overage past the plan cap and
sets the expiry of a new key. It answers {counted, total, cap, over, window}.
"""
import redis

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
    window = current_window()
    counted, total, cap, over = apply(
        keys=[window_key(account, window), record_key(account, request_id)],
        args=[units, plan_cap(account), RETAIN_SECONDS, window, request_id, account, route, gateway],
    )
    return {"counted": counted == 1, "total": total, "cap": cap, "over": over == 1, "window": window}
`,
};

export const supportModulesTs: Record<string, string> = {
  'metering/ledger.ts': `/**
 * The usage ledger (provided): every key usaged shares. usage:{account}:{window} is an account's
 * hash for one hour (units, cap, overage); usage:record:{account}:{request_id} the hash of one
 * counted report (request_id, account, route, units, gateway, window); plan:{account} the plan
 * (cap); close:{account} the last billing close that tied out (close_id, window, units). A window
 * is floor(unix seconds / WINDOW_SECONDS); window and record keys live RETAIN_SECONDS, so the
 * previous hour can still be closed. recordUsage is the two-command writer step 1 counts with.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const WINDOW_SECONDS = 3600;
export const RETAIN_SECONDS = 2 * WINDOW_SECONDS;
export const DEFAULT_CAP = 100_000;

/** One counted report. */
export interface UsageRecord {
  request_id: string;
  account: string;
  route: string;
  units: number;
  gateway: string;
  window: number;
}

/** What applyUsage answers. */
export interface Applied {
  counted: boolean;
  total: number;
  cap: number;
  over: boolean;
  window: number;
}

/** A window's units, cap and overage flag. */
export interface WindowTotals {
  units: number;
  cap: number;
  overage: boolean;
}

/** A billing close that tied out. */
export interface Close {
  close_id: string;
  window: number;
  units: number;
}

export const currentWindow = (): number => Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
export const windowKey = (account: string, window: number): string => \`usage:\${account}:\${window}\`;
export const recordKey = (account: string, requestId: string): string => \`usage:record:\${account}:\${requestId}\`;

/** The account's plan cap in units per window. */
export async function planCap(account: string): Promise<number> {
  const cap = await redis.hget(\`plan:\${account}\`, 'cap');
  return cap ? Number(cap) : DEFAULT_CAP;
}

export async function setPlanCap(account: string, cap: number): Promise<void> {
  await redis.hset(\`plan:\${account}\`, 'cap', String(cap));
}

/** The record counted for (account, requestId), or null. */
export async function findRecord(account: string, requestId: string): Promise<UsageRecord | null> {
  const raw = await redis.hgetall(recordKey(account, requestId));
  if (Object.keys(raw).length === 0) return null;
  return {
    request_id: raw.request_id ?? requestId,
    account: raw.account ?? account,
    route: raw.route ?? '',
    units: Number(raw.units ?? 0),
    gateway: raw.gateway ?? '',
    window: Number(raw.window ?? 0),
  };
}

/** Store the record (its fields as given) in the current window and add its units: two commands, not one. Returns the window's total. */
export async function recordUsage(record: {request_id: string; account: string; route: string; units: number; gateway?: string}): Promise<number> {
  const window = currentWindow();
  const key = recordKey(record.account, record.request_id);
  const fields: Record<string, string> = {window: String(window)};
  for (const [name, value] of Object.entries(record)) if (value !== undefined) fields[name] = String(value);
  await redis.hset(key, fields);
  await redis.expire(key, RETAIN_SECONDS);
  const total = await redis.hincrby(windowKey(record.account, window), 'units', record.units);
  await redis.expire(windowKey(record.account, window), RETAIN_SECONDS);
  return total;
}

/** The window's units, cap and overage flag; an untouched window has 0 units, the plan's cap, no overage. */
export async function readWindow(account: string, window: number): Promise<WindowTotals> {
  const raw = await redis.hgetall(windowKey(account, window));
  const cap = raw.cap ? Number(raw.cap) : await planCap(account);
  return {units: Number(raw.units ?? 0), cap, overage: raw.overage === '1'};
}

/** Record the billing close that tied out for the window. */
export async function markClosed(account: string, window: number, closeId: string, units: number): Promise<void> {
  await redis.hset(\`close:\${account}\`, {close_id: closeId, window: String(window), units: String(units)});
}

/** The last close that tied out, or null. */
export async function lastClose(account: string): Promise<Close | null> {
  const raw = await redis.hgetall(\`close:\${account}\`);
  if (Object.keys(raw).length === 0) return null;
  return {close_id: raw.close_id, window: Number(raw.window), units: Number(raw.units)};
}
`,
  'metering/usage.ts': `/**
 * applyUsage (provided; step 2 builds the same function): one Lua script dedupes the report on its
 * record key, writes the record, adds the units to the window, flags overage past the plan cap and
 * sets the expiry of a new key. It answers {counted, total, cap, over, window}.
 */
import Redis from 'ioredis';

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

export async function applyUsage(account: string, requestId: string, route: string, units: number, gateway: string): Promise<Applied> {
  const window = currentWindow();
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
};

export const supportModulesGo: Record<string, string> = {
  'metering/ledger/ledger.go': `// Package ledger is the usage ledger (provided): every key usaged shares. usage:{account}:{window}
// is an account's hash for one hour (units, cap, overage); usage:record:{account}:{request_id} the
// hash of one counted report (request_id, account, route, units, gateway, window); plan:{account}
// the plan (cap); close:{account} the last billing close that tied out (close_id, window, units).
// A window is floor(unix seconds / WindowSeconds); window and record keys live RetainSeconds, so
// the previous hour can still be closed. RecordUsage is the two-command writer step 1 counts with.
package ledger

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	WindowSeconds = 3600
	RetainSeconds = 2 * WindowSeconds
	DefaultCap    = 100000
)

// Record is one counted report.
type Record struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int64  \`json:"units"\`
	Gateway   string \`json:"gateway"\`
	Window    int64  \`json:"window"\`
}

// Applied is what ApplyUsage answers.
type Applied struct {
	Counted bool  \`json:"counted"\`
	Total   int64 \`json:"total"\`
	Cap     int64 \`json:"cap"\`
	Over    bool  \`json:"over"\`
	Window  int64 \`json:"window"\`
}

// Totals is a window's units, cap and overage flag.
type Totals struct {
	Units   int64 \`json:"units"\`
	Cap     int64 \`json:"cap"\`
	Overage bool  \`json:"overage"\`
}

// Close is a billing close that tied out.
type Close struct {
	CloseID string \`json:"close_id"\`
	Window  int64  \`json:"window"\`
	Units   int64  \`json:"units"\`
}

// CurrentWindow is the hour now falls in.
func CurrentWindow() int64 { return time.Now().Unix() / WindowSeconds }

// WindowKey is the account's hash for one window.
func WindowKey(account string, window int64) string { return fmt.Sprintf("usage:%s:%d", account, window) }

// RecordKey is the hash of one counted report.
func RecordKey(account, requestID string) string { return "usage:record:" + account + ":" + requestID }

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// PlanCap is the account's plan cap in units per window.
func PlanCap(ctx context.Context, account string) int64 {
	if cap, err := rdb.HGet(ctx, "plan:"+account, "cap").Result(); err == nil && cap != "" {
		return atoi(cap)
	}
	return DefaultCap
}

// SetPlanCap sets the account's plan cap.
func SetPlanCap(ctx context.Context, account string, cap int64) {
	rdb.HSet(ctx, "plan:"+account, "cap", cap)
}

// FindRecord is the record counted for (account, requestID), or nil.
func FindRecord(ctx context.Context, account, requestID string) *Record {
	raw := rdb.HGetAll(ctx, RecordKey(account, requestID)).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Record{RequestID: requestID, Account: account, Route: raw["route"], Units: atoi(raw["units"]), Gateway: raw["gateway"], Window: atoi(raw["window"])}
}

// RecordUsage stores the record in the current window and adds its units: two commands, not one.
// It returns the window's total.
func RecordUsage(ctx context.Context, record Record) (int64, error) {
	window := CurrentWindow()
	key := RecordKey(record.Account, record.RequestID)
	fields := map[string]any{"request_id": record.RequestID, "account": record.Account, "route": record.Route, "units": record.Units, "gateway": record.Gateway, "window": window}
	if err := rdb.HSet(ctx, key, fields).Err(); err != nil {
		return 0, err
	}
	rdb.Expire(ctx, key, RetainSeconds*time.Second)
	total, err := rdb.HIncrBy(ctx, WindowKey(record.Account, window), "units", record.Units).Result()
	if err != nil {
		return 0, err
	}
	rdb.Expire(ctx, WindowKey(record.Account, window), RetainSeconds*time.Second)
	return total, nil
}

// ReadWindow is the window's units, cap and overage flag; an untouched window has 0 units, the
// plan's cap, no overage.
func ReadWindow(ctx context.Context, account string, window int64) Totals {
	raw := rdb.HGetAll(ctx, WindowKey(account, window)).Val()
	cap := atoi(raw["cap"])
	if raw["cap"] == "" {
		cap = PlanCap(ctx, account)
	}
	return Totals{Units: atoi(raw["units"]), Cap: cap, Overage: raw["overage"] == "1"}
}

// MarkClosed records the billing close that tied out for the window.
func MarkClosed(ctx context.Context, account string, window int64, closeID string, units int64) {
	rdb.HSet(ctx, "close:"+account, map[string]any{"close_id": closeID, "window": window, "units": units})
}

// LastClose is the last close that tied out, or nil.
func LastClose(ctx context.Context, account string) *Close {
	raw := rdb.HGetAll(ctx, "close:"+account).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Close{CloseID: raw["close_id"], Window: atoi(raw["window"]), Units: atoi(raw["units"])}
}
`,
  'metering/usage/usage.go': `// Package usage holds ApplyUsage (provided; step 2 builds the same function): one Lua script
// dedupes the report on its record key, writes the record, adds the units to the window, flags
// overage past the plan cap and sets the expiry of a new key.
package usage

import (
	"context"

	"github.com/redis/go-redis/v9"

	"metering/ledger"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Apply runs on KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}
// with ARGV units, cap, retain seconds, window, request_id, account, route, gateway.
var Apply = redis.NewScript(\`
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

// ApplyUsage counts one report once and answers {counted, total, cap, over, window}.
func ApplyUsage(ctx context.Context, account, requestID, route string, units int64, gateway string) (ledger.Applied, error) {
	window := ledger.CurrentWindow()
	keys := []string{ledger.WindowKey(account, window), ledger.RecordKey(account, requestID)}
	out, err := Apply.Run(ctx, rdb, keys, units, ledger.PlanCap(ctx, account), ledger.RetainSeconds, window, requestID, account, route, gateway).Int64Slice()
	if err != nil {
		return ledger.Applied{}, err
	}
	return ledger.Applied{Counted: out[0] == 1, Total: out[1], Cap: out[2], Over: out[3] == 1, Window: window}, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'metering/ledger.h': `// The usage ledger (provided): every key usaged shares. usage:{account}:{window} is an account's
// hash for one hour (units, cap, overage); usage:record:{account}:{request_id} the hash of one
// counted report (request_id, account, route, units, gateway, window); plan:{account} the plan
// (cap); close:{account} the last billing close that tied out (close_id, window, units). A window
// is floor(unix seconds / kWindowSeconds); window and record keys live kRetainSeconds, so the
// previous hour can still be closed. recordUsage is the two-command writer step 1 counts with.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>

namespace ledger {

constexpr long long kWindowSeconds = 3600;
constexpr long long kRetainSeconds = 2 * kWindowSeconds;
constexpr long long kDefaultCap = 100000;

// One counted report.
struct Record {
  std::string request_id;
  std::string account;
  std::string route;
  long long units = 0;
  std::string gateway;
  long long window = 0;
};

// What applyUsage answers.
struct Applied {
  bool counted = false;
  long long total = 0;
  long long cap = 0;
  bool over = false;
  long long window = 0;
};

// A window's units, cap and overage flag.
struct Totals {
  long long units = 0;
  long long cap = 0;
  bool overage = false;
};

// A billing close that tied out.
struct Close {
  std::string close_id;
  long long window = 0;
  long long units = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long currentWindow() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::seconds>(now).count() / kWindowSeconds;
}

inline std::string windowKey(const std::string& account, long long window) {
  return "usage:" + account + ":" + std::to_string(window);
}

inline std::string recordKey(const std::string& account, const std::string& request_id) {
  return "usage:record:" + account + ":" + request_id;
}

inline long long toInt(const std::unordered_map<std::string, std::string>& raw, const char* name) {
  const auto it = raw.find(name);
  return it == raw.end() || it->second.empty() ? 0 : std::stoll(it->second);
}

// The account's plan cap in units per window.
inline long long planCap(const std::string& account) {
  const auto cap = redis().hget("plan:" + account, "cap");
  return cap && !cap->empty() ? std::stoll(*cap) : kDefaultCap;
}

inline void setPlanCap(const std::string& account, long long cap) { redis().hset("plan:" + account, "cap", std::to_string(cap)); }

// The record counted for (account, request_id), or none.
inline std::optional<Record> findRecord(const std::string& account, const std::string& request_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(recordKey(account, request_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Record{request_id, account, text("route"), toInt(raw, "units"), text("gateway"), toInt(raw, "window")};
}

// Store the record in the current window and add its units: two commands, not one. Returns the
// window's total.
inline long long recordUsage(const Record& record) {
  const long long window = currentWindow();
  const std::string key = recordKey(record.account, record.request_id);
  redis().hset(key, {{"request_id", record.request_id}, {"account", record.account}, {"route", record.route},
                     {"units", std::to_string(record.units)}, {"gateway", record.gateway}, {"window", std::to_string(window)}});
  redis().expire(key, kRetainSeconds);
  const long long total = redis().hincrby(windowKey(record.account, window), "units", record.units);
  redis().expire(windowKey(record.account, window), kRetainSeconds);
  return total;
}

// The window's units, cap and overage flag; an untouched window has 0 units, the plan's cap, no overage.
inline Totals readWindow(const std::string& account, long long window) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(windowKey(account, window));
  const bool hasCap = raw.count("cap") && !raw.at("cap").empty();
  return Totals{toInt(raw, "units"), hasCap ? toInt(raw, "cap") : planCap(account), raw.count("overage") && raw.at("overage") == "1"};
}

// Record the billing close that tied out for the window.
inline void markClosed(const std::string& account, long long window, const std::string& close_id, long long units) {
  redis().hset("close:" + account, {{"close_id", close_id}, {"window", std::to_string(window)}, {"units", std::to_string(units)}});
}

// The last close that tied out, or none.
inline std::optional<Close> lastClose(const std::string& account) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("close:" + account);
  if (raw.empty()) return std::nullopt;
  return Close{raw.at("close_id"), toInt(raw, "window"), toInt(raw, "units")};
}

}  // namespace ledger
`,
  'metering/usage.h': `// applyUsage (provided; step 2 builds the same function): one Lua script dedupes the report on its
// record key, writes the record, adds the units to the window, flags overage past the plan cap and
// sets the expiry of a new key.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "metering/ledger.h"

namespace usage {

// KEYS[1] usage:{account}:{window}, KEYS[2] usage:record:{account}:{request_id}
// ARGV: units, cap, retain seconds, window, request_id, account, route, gateway
inline const std::string kApplyLua = R"lua(
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

// Count one report once; answers {counted, total, cap, over, window}.
inline ledger::Applied applyUsage(const std::string& account, const std::string& request_id, const std::string& route, long long units,
                                  const std::string& gateway) {
  const long long window = ledger::currentWindow();
  const std::vector<std::string> keys = {ledger::windowKey(account, window), ledger::recordKey(account, request_id)};
  const std::vector<std::string> args = {std::to_string(units), std::to_string(ledger::planCap(account)), std::to_string(ledger::kRetainSeconds),
                                         std::to_string(window), request_id, account, route, gateway};
  const auto out = ledger::redis().eval<std::vector<long long>>(kApplyLua, keys, args);
  return ledger::Applied{out[0] == 1, out[1], out[2], out[3] == 1, window};
}

}  // namespace usage
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('metering', 'Ledger')]: `package metering

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The usage ledger (provided): every key usaged shares. usage:{account}:{window} is an account's
 * hash for one hour (units, cap, overage); usage:record:{account}:{request_id} the hash of one
 * counted report (request_id, account, route, units, gateway, window); plan:{account} the plan
 * (cap); close:{account} the last billing close that tied out (close_id, window, units). A window
 * is floor(unix seconds / WindowSeconds); window and record keys live RetainSeconds, so the
 * previous hour can still be closed. recordUsage is the two-command writer step 1 counts with.
 */
object Ledger {
  final case class Record(requestId: String, account: String, route: String, units: Long, gateway: String = "", window: Long = 0L)
  final case class Applied(counted: Boolean, total: Long, cap: Long, over: Boolean, window: Long)
  final case class Totals(units: Long, cap: Long, overage: Boolean)
  final case class Close(closeId: String, window: Long, units: Long)

  val WindowSeconds = 3600L
  val RetainSeconds: Long = 2 * WindowSeconds
  val DefaultCap = 100000L

  val jedis = new JedisPooled("redis", 6379)

  def currentWindow(): Long = System.currentTimeMillis() / 1000 / WindowSeconds
  def windowKey(account: String, window: Long): String = s"usage:$account:$window"
  def recordKey(account: String, requestId: String): String = s"usage:record:$account:$requestId"

  private def long(raw: Map[String, String], name: String): Long = raw.get(name).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)

  /** The account's plan cap in units per window. */
  def planCap(account: String): Long = Option(jedis.hget(s"plan:$account", "cap")).filter(_.nonEmpty).map(_.toLong).getOrElse(DefaultCap)

  def setPlanCap(account: String, cap: Long): Unit = jedis.hset(s"plan:$account", "cap", cap.toString)

  /** The record counted for (account, requestId), if any. */
  def findRecord(account: String, requestId: String): Option[Record] = {
    val raw = jedis.hgetAll(recordKey(account, requestId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Record(requestId, account, raw.getOrElse("route", ""), long(raw, "units"), raw.getOrElse("gateway", ""), long(raw, "window")))
  }

  /** Store the record in the current window and add its units: two commands, not one. Returns the window's total. */
  def recordUsage(record: Record): Long = {
    val window = currentWindow()
    val key = recordKey(record.account, record.requestId)
    jedis.hset(key, Map("request_id" -> record.requestId, "account" -> record.account, "route" -> record.route,
      "units" -> record.units.toString, "gateway" -> record.gateway, "window" -> window.toString).asJava)
    jedis.expire(key, RetainSeconds)
    val total = jedis.hincrBy(windowKey(record.account, window), "units", record.units)
    jedis.expire(windowKey(record.account, window), RetainSeconds)
    total
  }

  /** The window's units, cap and overage flag; an untouched window has 0 units, the plan's cap, no overage. */
  def readWindow(account: String, window: Long): Totals = {
    val raw = jedis.hgetAll(windowKey(account, window)).asScala.toMap
    Totals(long(raw, "units"), raw.get("cap").filter(_.nonEmpty).map(_.toLong).getOrElse(planCap(account)), raw.get("overage").contains("1"))
  }

  /** Record the billing close that tied out for the window. */
  def markClosed(account: String, window: Long, closeId: String, units: Long): Unit =
    jedis.hset(s"close:$account", Map("close_id" -> closeId, "window" -> window.toString, "units" -> units.toString).asJava)

  /** The last close that tied out, if any. */
  def lastClose(account: String): Option[Close] = {
    val raw = jedis.hgetAll(s"close:$account").asScala.toMap
    if (raw.isEmpty) None else Some(Close(raw("close_id"), long(raw, "window"), long(raw, "units")))
  }
}
`,
  [scalaPath('metering', 'Usage')]: `package metering

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * applyUsage (provided; step 2 builds the same function): one Lua script dedupes the report on its
 * record key, writes the record, adds the units to the window, flags overage past the plan cap and
 * sets the expiry of a new key.
 */
object Usage {
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

  /** Count one report once; answers counted, total, cap, over and the window. */
  def applyUsage(account: String, requestId: String, route: String, units: Long, gateway: String): Ledger.Applied = {
    val window = Ledger.currentWindow()
    val keys = List(Ledger.windowKey(account, window), Ledger.recordKey(account, requestId)).asJava
    val args = List(units.toString, Ledger.planCap(account).toString, Ledger.RetainSeconds.toString, window.toString, requestId, account, route, gateway).asJava
    val out = jedis.eval(ApplyLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    Ledger.Applied(out(0) == 1L, out(1), out(2), out(3) == 1L, window)
  }
}
`,
};
