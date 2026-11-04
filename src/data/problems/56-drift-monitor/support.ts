/**
 * Hand-written support modules the drift-monitor steps import but no step builds: the `drift`
 * package. `drift.store` is the monitor store (monitors as Redis hashes, the Idempotency-Key index,
 * the model registry's promoted set, the quiet-tick counter and the outbox list). `drift.sketch` is
 * the sketch store of step 2 as later steps use it: windowed live sketches merged by one Lua script,
 * baselines written once, and the PSI distance between two sketches. The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'drift/__init__.py': '',
  'drift/store.py': `"""
The monitor store (provided): every monitor is a Redis hash monitor:{id} with monitor_id, tenant,
model_version, metric, window_s, baseline and threshold; ids come from monitor:seq as m-{n};
monitor:key:{tenant}:{key} names the monitor an Idempotency-Key registered. registry:promoted is
the model registry's set of promoted versions, drift:quiet:{monitor_id} counts a monitor's
evaluations that did not cross, and outbox lists the events the broker did not take, as JSON rows
{topic, key, payload}. A monitor is a dict: window_s an int, threshold a float.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FIELDS = ("tenant", "model_version", "metric", "window_s", "baseline", "threshold")


def _monitor(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "monitor_id": raw["monitor_id"],
        "tenant": raw["tenant"],
        "model_version": raw["model_version"],
        "metric": raw["metric"],
        "window_s": int(raw["window_s"]),
        "baseline": raw["baseline"],
        "threshold": float(raw["threshold"]),
    }


def create_monitor(fields: dict) -> dict:
    """Store a new monitor (tenant, model_version, metric, window_s, baseline, threshold) under the next id; returns it."""
    monitor_id = f"m-{r.incr('monitor:seq')}"
    r.hset(f"monitor:{monitor_id}", mapping={**{name: str(fields[name]) for name in FIELDS}, "monitor_id": monitor_id})
    return get_monitor(monitor_id)


def get_monitor(monitor_id: str) -> dict | None:
    """The monitor with this id, whoever owns it (the evaluator's lookup), or None."""
    return _monitor(r.hgetall(f"monitor:{monitor_id}"))


def monitor_for(tenant: str, monitor_id: str) -> dict | None:
    """The monitor with this id if tenant owns it, else None."""
    monitor = get_monitor(monitor_id)
    return monitor if monitor is not None and monitor["tenant"] == tenant else None


def monitor_for_key(tenant: str, key: str) -> dict | None:
    """The monitor tenant registered with this Idempotency-Key, if any."""
    monitor_id = r.get(f"monitor:key:{tenant}:{key}")
    return get_monitor(monitor_id) if monitor_id else None


def remember_key(tenant: str, key: str, monitor_id: str) -> None:
    """Record that tenant's Idempotency-Key registered monitor_id, for its replays."""
    r.set(f"monitor:key:{tenant}:{key}", monitor_id)


def is_promoted(model_version: str) -> bool:
    """Whether the model registry has promoted this version."""
    return bool(r.sismember("registry:promoted", model_version))


def count_quiet(monitor_id: str) -> int:
    """Count one evaluation of the monitor that did not cross; returns the count so far."""
    return int(r.incr(f"drift:quiet:{monitor_id}"))


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take, for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'drift/sketch.py': `"""
The sketch store (provided; step 2 builds merge_batch and freeze_baseline the same way). A live
sketch is the hash sketch:live:{tenant}:{monitor_id}:{window} of bucket → count, where window is
the window's start (now // window_s * window_s); one Lua script merges a batch into it and sets
its expiry to the window's end. A baseline is the JSON object {bucket: count} under
sketch:baseline:{tenant}:{baseline_ref}, written once. psi is the population stability index of a
live sketch against its baseline.
"""
import json
import math
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total.
MERGE_LUA = """
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
"""
merge = r.register_script(MERGE_LUA)

# A bucket share below this counts as this, so an empty bucket on one side stays finite.
EPSILON = 1e-4


def window_start(now: int, window_s: int) -> int:
    return now // window_s * window_s


def live_key(tenant: str, monitor_id: str, window: int) -> str:
    return f"sketch:live:{tenant}:{monitor_id}:{window}"


def baseline_key(tenant: str, baseline_ref: str) -> str:
    return f"sketch:baseline:{tenant}:{baseline_ref}"


def merge_batch(tenant: str, monitor_id: str, window_s: int, batch: dict[int, int]) -> int:
    """Merge a batch of bucket counts into the current window's sketch; returns the window's sample count."""
    now = int(time.time())
    window = window_start(now, window_s)
    args: list[int] = []
    for bucket, count in sorted(batch.items()):
        args += [bucket, count]
    args.append(window + window_s - now)
    return int(merge(keys=[live_key(tenant, monitor_id, window)], args=args))


def freeze_baseline(tenant: str, baseline_ref: str, batch: dict[int, int]) -> bool:
    """Write the baseline once; False when it already exists (it is left as it was)."""
    payload = json.dumps({str(bucket): count for bucket, count in sorted(batch.items())})
    return bool(r.set(baseline_key(tenant, baseline_ref), payload, nx=True))


def read_live(tenant: str, monitor_id: str, window: int) -> dict[int, int]:
    """The live sketch of a window ({} when nothing was merged into it)."""
    return {int(bucket): int(count) for bucket, count in r.hgetall(live_key(tenant, monitor_id, window)).items()}


def read_baseline(tenant: str, baseline_ref: str) -> dict[int, int]:
    """The frozen baseline ({} when it was never frozen)."""
    raw = r.get(baseline_key(tenant, baseline_ref))
    return {int(bucket): int(count) for bucket, count in json.loads(raw).items()} if raw else {}


def psi(live: dict[int, int], baseline: dict[int, int]) -> float:
    """Population stability index: sum over buckets of (live share - baseline share) * ln(live share / baseline share)."""
    live_total, baseline_total = sum(live.values()), sum(baseline.values())
    if live_total == 0 or baseline_total == 0:
        return 0.0
    distance = 0.0
    for bucket in sorted(set(live) | set(baseline)):
        p = max(live.get(bucket, 0) / live_total, EPSILON)
        q = max(baseline.get(bucket, 0) / baseline_total, EPSILON)
        distance += (p - q) * math.log(p / q)
    return distance
`,
};

export const supportModulesTs: Record<string, string> = {
  'drift/store.ts': `/**
 * The monitor store (provided): every monitor is a Redis hash monitor:{id} with monitor_id, tenant,
 * model_version, metric, window_s, baseline and threshold; ids come from monitor:seq as m-{n};
 * monitor:key:{tenant}:{key} names the monitor an Idempotency-Key registered. registry:promoted is
 * the model registry's set of promoted versions, drift:quiet:{monitor_id} counts a monitor's
 * evaluations that did not cross, and outbox lists the events the broker did not take, as JSON rows
 * {topic, key, payload}.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Monitor {
  monitor_id: string;
  tenant: string;
  model_version: string;
  metric: string;
  window_s: number;
  baseline: string;
  threshold: number;
}

function monitor(raw: Record<string, string>): Monitor | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    monitor_id: raw.monitor_id,
    tenant: raw.tenant,
    model_version: raw.model_version,
    metric: raw.metric,
    window_s: Number(raw.window_s),
    baseline: raw.baseline,
    threshold: Number(raw.threshold),
  };
}

/** Store a new monitor under the next id; returns it. */
export async function createMonitor(fields: Omit<Monitor, 'monitor_id'>): Promise<Monitor> {
  const monitorId = \`m-\${await redis.incr('monitor:seq')}\`;
  await redis.hset(\`monitor:\${monitorId}\`, {
    monitor_id: monitorId,
    tenant: fields.tenant,
    model_version: fields.model_version,
    metric: fields.metric,
    window_s: String(fields.window_s),
    baseline: fields.baseline,
    threshold: String(fields.threshold),
  });
  return (await getMonitor(monitorId)) as Monitor;
}

/** The monitor with this id, whoever owns it (the evaluator's lookup), or null. */
export async function getMonitor(monitorId: string): Promise<Monitor | null> {
  return monitor(await redis.hgetall(\`monitor:\${monitorId}\`));
}

/** The monitor with this id if tenant owns it, else null. */
export async function monitorFor(tenant: string, monitorId: string): Promise<Monitor | null> {
  const found = await getMonitor(monitorId);
  return found !== null && found.tenant === tenant ? found : null;
}

/** The monitor tenant registered with this Idempotency-Key, if any. */
export async function monitorForKey(tenant: string, key: string): Promise<Monitor | null> {
  const monitorId = await redis.get(\`monitor:key:\${tenant}:\${key}\`);
  return monitorId === null ? null : getMonitor(monitorId);
}

/** Record that tenant's Idempotency-Key registered monitorId, for its replays. */
export async function rememberKey(tenant: string, key: string, monitorId: string): Promise<void> {
  await redis.set(\`monitor:key:\${tenant}:\${key}\`, monitorId);
}

/** Whether the model registry has promoted this version. */
export async function isPromoted(modelVersion: string): Promise<boolean> {
  return (await redis.sismember('registry:promoted', modelVersion)) === 1;
}

/** Count one evaluation of the monitor that did not cross; returns the count so far. */
export async function countQuiet(monitorId: string): Promise<number> {
  return redis.incr(\`drift:quiet:\${monitorId}\`);
}

/** Keep an event the broker did not take, for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'drift/sketch.ts': `/**
 * The sketch store (provided; step 2 builds mergeBatch and freezeBaseline the same way). A live
 * sketch is the hash sketch:live:{tenant}:{monitor_id}:{window} of bucket → count, where window is
 * the window's start; one Lua script merges a batch into it and sets its expiry to the window's
 * end. A baseline is the JSON object {bucket: count} under sketch:baseline:{tenant}:{baseline_ref},
 * written once. psi is the population stability index of a live sketch against its baseline.
 */
import Redis from 'ioredis';

/** HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total. */
export const MERGE_LUA = \`
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
\`;

interface SketchRedis extends Redis {
  mergeSketch(key: string, ...args: number[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SketchRedis;
redis.defineCommand('mergeSketch', {numberOfKeys: 1, lua: MERGE_LUA});

/** Bucket id → count. */
export type Sketch = Record<number, number>;

/** A bucket share below this counts as this, so an empty bucket on one side stays finite. */
export const EPSILON = 1e-4;

export const windowStart = (now: number, windowS: number): number => Math.floor(now / windowS) * windowS;
export const liveKey = (tenant: string, monitorId: string, window: number): string => \`sketch:live:\${tenant}:\${monitorId}:\${window}\`;
export const baselineKey = (tenant: string, baselineRef: string): string => \`sketch:baseline:\${tenant}:\${baselineRef}\`;

const entries = (sketch: Sketch): [number, number][] =>
  Object.entries(sketch)
    .map(([bucket, count]): [number, number] => [Number(bucket), Number(count)])
    .sort((a, b) => a[0] - b[0]);

/** Merge a batch of bucket counts into the current window's sketch; returns the window's sample count. */
export async function mergeBatch(tenant: string, monitorId: string, windowS: number, batch: Sketch): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const window = windowStart(now, windowS);
  const args = entries(batch).flat();
  args.push(window + windowS - now);
  return Number(await redis.mergeSketch(liveKey(tenant, monitorId, window), ...args));
}

/** Write the baseline once; false when it already exists (it is left as it was). */
export async function freezeBaseline(tenant: string, baselineRef: string, batch: Sketch): Promise<boolean> {
  const payload = JSON.stringify(Object.fromEntries(entries(batch)));
  return (await redis.set(baselineKey(tenant, baselineRef), payload, 'NX')) === 'OK';
}

/** The live sketch of a window ({} when nothing was merged into it). */
export async function readLive(tenant: string, monitorId: string, window: number): Promise<Sketch> {
  const raw = await redis.hgetall(liveKey(tenant, monitorId, window));
  return Object.fromEntries(Object.entries(raw).map(([bucket, count]) => [Number(bucket), Number(count)]));
}

/** The frozen baseline ({} when it was never frozen). */
export async function readBaseline(tenant: string, baselineRef: string): Promise<Sketch> {
  const raw = await redis.get(baselineKey(tenant, baselineRef));
  return raw === null ? {} : (JSON.parse(raw) as Sketch);
}

/** Population stability index: sum over buckets of (live share - baseline share) * ln(live share / baseline share). */
export function psi(live: Sketch, baseline: Sketch): number {
  const total = (s: Sketch): number => entries(s).reduce((n, [, count]) => n + count, 0);
  const liveTotal = total(live);
  const baselineTotal = total(baseline);
  if (liveTotal === 0 || baselineTotal === 0) return 0;
  const buckets = [...new Set([...entries(live), ...entries(baseline)].map(([bucket]) => bucket))].sort((a, b) => a - b);
  let distance = 0;
  for (const bucket of buckets) {
    const p = Math.max((live[bucket] ?? 0) / liveTotal, EPSILON);
    const q = Math.max((baseline[bucket] ?? 0) / baselineTotal, EPSILON);
    distance += (p - q) * Math.log(p / q);
  }
  return distance;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'drift/store/store.go': `// Package store is the monitor store (provided): every monitor is a Redis hash monitor:{id} with
// monitor_id, tenant, model_version, metric, window_s, baseline and threshold; ids come from
// monitor:seq as m-{n}; monitor:key:{tenant}:{key} names the monitor an Idempotency-Key registered.
// registry:promoted is the model registry's set of promoted versions, drift:quiet:{monitor_id}
// counts a monitor's evaluations that did not cross, and outbox lists the events the broker did not
// take, as JSON rows {topic, key, payload}.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Monitor is one registered monitor.
type Monitor struct {
	MonitorID    string  \`json:"monitor_id"\`
	Tenant       string  \`json:"tenant"\`
	ModelVersion string  \`json:"model_version"\`
	Metric       string  \`json:"metric"\`
	WindowS      int64   \`json:"window_s"\`
	Baseline     string  \`json:"baseline"\`
	Threshold    float64 \`json:"threshold"\`
}

func monitor(raw map[string]string) *Monitor {
	if len(raw) == 0 {
		return nil
	}
	windowS, _ := strconv.ParseInt(raw["window_s"], 10, 64)
	threshold, _ := strconv.ParseFloat(raw["threshold"], 64)
	return &Monitor{MonitorID: raw["monitor_id"], Tenant: raw["tenant"], ModelVersion: raw["model_version"], Metric: raw["metric"], WindowS: windowS, Baseline: raw["baseline"], Threshold: threshold}
}

// CreateMonitor stores m under the next id (its MonitorID is ignored) and returns it.
func CreateMonitor(ctx context.Context, m Monitor) *Monitor {
	monitorID := fmt.Sprintf("m-%d", rdb.Incr(ctx, "monitor:seq").Val())
	rdb.HSet(ctx, "monitor:"+monitorID, map[string]any{
		"monitor_id":    monitorID,
		"tenant":        m.Tenant,
		"model_version": m.ModelVersion,
		"metric":        m.Metric,
		"window_s":      strconv.FormatInt(m.WindowS, 10),
		"baseline":      m.Baseline,
		"threshold":     strconv.FormatFloat(m.Threshold, 'g', -1, 64),
	})
	return GetMonitor(ctx, monitorID)
}

// GetMonitor is the monitor with this id, whoever owns it (the evaluator's lookup), or nil.
func GetMonitor(ctx context.Context, monitorID string) *Monitor {
	return monitor(rdb.HGetAll(ctx, "monitor:"+monitorID).Val())
}

// MonitorFor is the monitor with this id if tenant owns it, else nil.
func MonitorFor(ctx context.Context, tenant, monitorID string) *Monitor {
	if m := GetMonitor(ctx, monitorID); m != nil && m.Tenant == tenant {
		return m
	}
	return nil
}

// MonitorForKey is the monitor tenant registered with this Idempotency-Key, if any.
func MonitorForKey(ctx context.Context, tenant, key string) *Monitor {
	monitorID, err := rdb.Get(ctx, "monitor:key:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	return GetMonitor(ctx, monitorID)
}

// RememberKey records that tenant's Idempotency-Key registered monitorID, for its replays.
func RememberKey(ctx context.Context, tenant, key, monitorID string) {
	rdb.Set(ctx, "monitor:key:"+tenant+":"+key, monitorID, 0)
}

// IsPromoted reports whether the model registry has promoted this version.
func IsPromoted(ctx context.Context, modelVersion string) bool {
	return rdb.SIsMember(ctx, "registry:promoted", modelVersion).Val()
}

// CountQuiet counts one evaluation of the monitor that did not cross and returns the count so far.
func CountQuiet(ctx context.Context, monitorID string) int64 {
	return rdb.Incr(ctx, "drift:quiet:"+monitorID).Val()
}

// InsertOutbox keeps an event the broker did not take, for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
  'drift/sketch/sketch.go': `// Package sketch is the sketch store (provided; step 2 builds mergeBatch and freezeBaseline the
// same way). A live sketch is the hash sketch:live:{tenant}:{monitor_id}:{window} of bucket →
// count, where window is the window's start; one Lua script merges a batch into it and sets its
// expiry to the window's end. A baseline is the JSON object {bucket: count} under
// sketch:baseline:{tenant}:{baseline_ref}, written once. PSI is the population stability index of
// a live sketch against its baseline.
package sketch

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Merge HINCRBYs every (bucket, count) pair of ARGV, expires the hash after ARGV[#ARGV] seconds and returns its total.
var Merge = redis.NewScript(\`
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
\`)

// Epsilon: a bucket share below this counts as this, so an empty bucket on one side stays finite.
const Epsilon = 1e-4

// WindowStart is the start of the window now falls in.
func WindowStart(now, windowS int64) int64 { return now / windowS * windowS }

// LiveKey is the live sketch of a monitor's window.
func LiveKey(tenant, monitorID string, window int64) string {
	return fmt.Sprintf("sketch:live:%s:%s:%d", tenant, monitorID, window)
}

// BaselineKey is the frozen baseline a reference names.
func BaselineKey(tenant, baselineRef string) string {
	return "sketch:baseline:" + tenant + ":" + baselineRef
}

func buckets(sketches ...map[int]int64) []int {
	seen := map[int]bool{}
	var out []int
	for _, s := range sketches {
		for bucket := range s {
			if !seen[bucket] {
				seen[bucket] = true
				out = append(out, bucket)
			}
		}
	}
	sort.Ints(out)
	return out
}

// MergeBatch merges a batch of bucket counts into the current window's sketch and returns the window's sample count.
func MergeBatch(ctx context.Context, tenant, monitorID string, windowS int64, batch map[int]int64) (int64, error) {
	now := time.Now().Unix()
	window := WindowStart(now, windowS)
	var args []any
	for _, bucket := range buckets(batch) {
		args = append(args, bucket, batch[bucket])
	}
	args = append(args, window+windowS-now)
	return Merge.Run(ctx, rdb, []string{LiveKey(tenant, monitorID, window)}, args...).Int64()
}

// FreezeBaseline writes the baseline once; false when it already exists (it is left as it was).
func FreezeBaseline(ctx context.Context, tenant, baselineRef string, batch map[int]int64) (bool, error) {
	payload, _ := json.Marshal(batch)
	return rdb.SetNX(ctx, BaselineKey(tenant, baselineRef), payload, 0).Result()
}

// ReadLive is the live sketch of a window (empty when nothing was merged into it).
func ReadLive(ctx context.Context, tenant, monitorID string, window int64) map[int]int64 {
	out := map[int]int64{}
	for bucket, count := range rdb.HGetAll(ctx, LiveKey(tenant, monitorID, window)).Val() {
		b, _ := strconv.Atoi(bucket)
		n, _ := strconv.ParseInt(count, 10, 64)
		out[b] = n
	}
	return out
}

// ReadBaseline is the frozen baseline (empty when it was never frozen).
func ReadBaseline(ctx context.Context, tenant, baselineRef string) map[int]int64 {
	out := map[int]int64{}
	raw, err := rdb.Get(ctx, BaselineKey(tenant, baselineRef)).Result()
	if err == nil {
		json.Unmarshal([]byte(raw), &out)
	}
	return out
}

// Total is a sketch's sample count.
func Total(s map[int]int64) int64 {
	var n int64
	for _, count := range s {
		n += count
	}
	return n
}

// PSI is the population stability index: the sum over buckets of (live share - baseline share) *
// ln(live share / baseline share).
func PSI(live, baseline map[int]int64) float64 {
	liveTotal, baselineTotal := Total(live), Total(baseline)
	if liveTotal == 0 || baselineTotal == 0 {
		return 0
	}
	distance := 0.0
	for _, bucket := range buckets(live, baseline) {
		p := math.Max(float64(live[bucket])/float64(liveTotal), Epsilon)
		q := math.Max(float64(baseline[bucket])/float64(baselineTotal), Epsilon)
		distance += (p - q) * math.Log(p/q)
	}
	return distance
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'drift/store.h': `// The monitor store (provided): every monitor is a Redis hash monitor:{id} with monitor_id, tenant,
// model_version, metric, window_s, baseline and threshold; ids come from monitor:seq as m-{n};
// monitor:key:{tenant}:{key} names the monitor an Idempotency-Key registered. registry:promoted is
// the model registry's set of promoted versions, drift:quiet:{monitor_id} counts a monitor's
// evaluations that did not cross, and outbox lists the events the broker did not take, as JSON rows
// {topic, key, payload}.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

namespace store {

struct Monitor {
  std::string monitor_id;
  std::string tenant;
  std::string model_version;
  std::string metric;
  long window_s = 0;
  std::string baseline;
  double threshold = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline nlohmann::json toJson(const Monitor& m) {
  return nlohmann::json{{"monitor_id", m.monitor_id}, {"tenant", m.tenant},     {"model_version", m.model_version},
                        {"metric", m.metric},         {"window_s", m.window_s}, {"baseline", m.baseline},
                        {"threshold", m.threshold}};
}

// The monitor with this id, whoever owns it (the evaluator's lookup), or none.
inline std::optional<Monitor> getMonitor(const std::string& monitor_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("monitor:" + monitor_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Monitor{text("monitor_id"), text("tenant"), text("model_version"), text("metric"), std::stol(text("window_s")),
                 text("baseline"), std::stod(text("threshold"))};
}

// Store m under the next id (its monitor_id is ignored); returns it.
inline Monitor createMonitor(const Monitor& m) {
  const std::string monitor_id = "m-" + std::to_string(redis().incr("monitor:seq"));
  redis().hset("monitor:" + monitor_id, {{"monitor_id", monitor_id},
                                         {"tenant", m.tenant},
                                         {"model_version", m.model_version},
                                         {"metric", m.metric},
                                         {"window_s", std::to_string(m.window_s)},
                                         {"baseline", m.baseline},
                                         {"threshold", nlohmann::json(m.threshold).dump()}});
  return *getMonitor(monitor_id);
}

// The monitor with this id if tenant owns it, else none.
inline std::optional<Monitor> monitorFor(const std::string& tenant, const std::string& monitor_id) {
  auto m = getMonitor(monitor_id);
  if (m && m->tenant == tenant) return m;
  return std::nullopt;
}

// The monitor tenant registered with this Idempotency-Key, if any.
inline std::optional<Monitor> monitorForKey(const std::string& tenant, const std::string& key) {
  const auto monitor_id = redis().get("monitor:key:" + tenant + ":" + key);
  if (!monitor_id) return std::nullopt;
  return getMonitor(*monitor_id);
}

// Record that tenant's Idempotency-Key registered monitor_id, for its replays.
inline void rememberKey(const std::string& tenant, const std::string& key, const std::string& monitor_id) {
  redis().set("monitor:key:" + tenant + ":" + key, monitor_id);
}

// Whether the model registry has promoted this version.
inline bool isPromoted(const std::string& model_version) { return redis().sismember("registry:promoted", model_version); }

// Count one evaluation of the monitor that did not cross; returns the count so far.
inline long long countQuiet(const std::string& monitor_id) { return redis().incr("drift:quiet:" + monitor_id); }

// Keep an event the broker did not take, for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'drift/sketch.h': `// The sketch store (provided; step 2 builds mergeBatch and freezeBaseline the same way). A live
// sketch is the hash sketch:live:{tenant}:{monitor_id}:{window} of bucket → count, where window is
// the window's start; one Lua script merges a batch into it and sets its expiry to the window's
// end. A baseline is the JSON object {bucket: count} under sketch:baseline:{tenant}:{baseline_ref},
// written once. psi is the population stability index of a live sketch against its baseline.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace sketch {

// Bucket id → count.
using Sketch = std::map<int, long>;

// HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total.
inline const std::string kMergeLua = R"lua(
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
)lua";

// A bucket share below this counts as this, so an empty bucket on one side stays finite.
constexpr double kEpsilon = 1e-4;

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long windowStart(long now, long window_s) { return now / window_s * window_s; }

inline std::string liveKey(const std::string& tenant, const std::string& monitor_id, long window) {
  return "sketch:live:" + tenant + ":" + monitor_id + ":" + std::to_string(window);
}

inline std::string baselineKey(const std::string& tenant, const std::string& baseline_ref) {
  return "sketch:baseline:" + tenant + ":" + baseline_ref;
}

inline nlohmann::json toJson(const Sketch& s) {
  nlohmann::json out = nlohmann::json::object();
  for (const auto& [bucket, count] : s) out[std::to_string(bucket)] = count;
  return out;
}

// Merge a batch of bucket counts into the current window's sketch; returns the window's sample count.
inline long long mergeBatch(const std::string& tenant, const std::string& monitor_id, long window_s, const Sketch& batch) {
  const long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long window = windowStart(now, window_s);
  std::vector<std::string> args;
  for (const auto& [bucket, count] : batch) {
    args.push_back(std::to_string(bucket));
    args.push_back(std::to_string(count));
  }
  args.push_back(std::to_string(window + window_s - now));
  const std::vector<std::string> keys = {liveKey(tenant, monitor_id, window)};
  return redis().eval<long long>(kMergeLua, keys.begin(), keys.end(), args.begin(), args.end());
}

// Write the baseline once; false when it already exists (it is left as it was).
inline bool freezeBaseline(const std::string& tenant, const std::string& baseline_ref, const Sketch& batch) {
  return redis().set(baselineKey(tenant, baseline_ref), toJson(batch).dump(), std::chrono::milliseconds(0),
                     sw::redis::UpdateType::NOT_EXIST);
}

// The live sketch of a window (empty when nothing was merged into it).
inline Sketch readLive(const std::string& tenant, const std::string& monitor_id, long window) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(liveKey(tenant, monitor_id, window));
  Sketch out;
  for (const auto& [bucket, count] : raw) out[std::stoi(bucket)] = std::stol(count);
  return out;
}

// The frozen baseline (empty when it was never frozen).
inline Sketch readBaseline(const std::string& tenant, const std::string& baseline_ref) {
  Sketch out;
  const auto raw = redis().get(baselineKey(tenant, baseline_ref));
  if (!raw) return out;
  const nlohmann::json stored = nlohmann::json::parse(*raw);
  for (const auto& [bucket, count] : stored.items()) out[std::stoi(bucket)] = count.get<long>();
  return out;
}

// A sketch's sample count.
inline long total(const Sketch& s) {
  long n = 0;
  for (const auto& [bucket, count] : s) n += count;
  return n;
}

// Population stability index: the sum over buckets of (live share - baseline share) *
// ln(live share / baseline share).
inline double psi(const Sketch& live, const Sketch& baseline) {
  const long live_total = total(live);
  const long baseline_total = total(baseline);
  if (live_total == 0 || baseline_total == 0) return 0;
  std::set<int> buckets;
  for (const auto& [bucket, count] : live) buckets.insert(bucket);
  for (const auto& [bucket, count] : baseline) buckets.insert(bucket);
  double distance = 0;
  for (const int bucket : buckets) {
    const double p = std::max(static_cast<double>(live.count(bucket) ? live.at(bucket) : 0) / live_total, kEpsilon);
    const double q = std::max(static_cast<double>(baseline.count(bucket) ? baseline.at(bucket) : 0) / baseline_total, kEpsilon);
    distance += (p - q) * std::log(p / q);
  }
  return distance;
}

}  // namespace sketch
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('drift', 'Store')]: `package drift

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The monitor store (provided): every monitor is a Redis hash monitor:{id} with monitor_id, tenant,
 * model_version, metric, window_s, baseline and threshold; ids come from monitor:seq as m-{n};
 * monitor:key:{tenant}:{key} names the monitor an Idempotency-Key registered. registry:promoted is
 * the model registry's set of promoted versions, drift:quiet:{monitor_id} counts a monitor's
 * evaluations that did not cross, and outbox lists the events the broker did not take, as JSON rows
 * {topic, key, payload}.
 */
object Store {
  final case class Monitor(monitorId: String, tenant: String, modelVersion: String, metric: String, windowS: Long, baseline: String, threshold: Double)

  val jedis = new JedisPooled("redis", 6379)

  def toJson(m: Monitor): JsObject = JsObject(
    "monitor_id" -> JsString(m.monitorId),
    "tenant" -> JsString(m.tenant),
    "model_version" -> JsString(m.modelVersion),
    "metric" -> JsString(m.metric),
    "window_s" -> JsNumber(m.windowS),
    "baseline" -> JsString(m.baseline),
    "threshold" -> JsNumber(m.threshold))

  /** The monitor with this id, whoever owns it (the evaluator's lookup). */
  def getMonitor(monitorId: String): Option[Monitor] = {
    val raw = jedis.hgetAll(s"monitor:$monitorId").asScala
    if (raw.isEmpty) None
    else Some(Monitor(raw("monitor_id"), raw("tenant"), raw("model_version"), raw("metric"), raw("window_s").toLong, raw("baseline"), raw("threshold").toDouble))
  }

  /** Store m under the next id (its monitorId is ignored); returns it. */
  def createMonitor(m: Monitor): Monitor = {
    val monitorId = s"m-\${jedis.incr("monitor:seq")}"
    jedis.hset(s"monitor:$monitorId", Map(
      "monitor_id" -> monitorId, "tenant" -> m.tenant, "model_version" -> m.modelVersion, "metric" -> m.metric,
      "window_s" -> m.windowS.toString, "baseline" -> m.baseline, "threshold" -> m.threshold.toString).asJava)
    getMonitor(monitorId).get
  }

  /** The monitor with this id if tenant owns it. */
  def monitorFor(tenant: String, monitorId: String): Option[Monitor] = getMonitor(monitorId).filter(_.tenant == tenant)

  /** The monitor tenant registered with this Idempotency-Key, if any. */
  def monitorForKey(tenant: String, key: String): Option[Monitor] = Option(jedis.get(s"monitor:key:$tenant:$key")).flatMap(getMonitor)

  /** Record that tenant's Idempotency-Key registered monitorId, for its replays. */
  def rememberKey(tenant: String, key: String, monitorId: String): Unit = jedis.set(s"monitor:key:$tenant:$key", monitorId)

  /** Whether the model registry has promoted this version. */
  def isPromoted(modelVersion: String): Boolean = jedis.sismember("registry:promoted", modelVersion)

  /** Count one evaluation of the monitor that did not cross; returns the count so far. */
  def countQuiet(monitorId: String): Long = jedis.incr(s"drift:quiet:$monitorId")

  /** Keep an event the broker did not take, for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('drift', 'Sketch')]: `package drift

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The sketch store (provided; step 2 builds mergeBatch and freezeBaseline the same way). A live
 * sketch is the hash sketch:live:{tenant}:{monitor_id}:{window} of bucket → count, where window is
 * the window's start; one Lua script merges a batch into it and sets its expiry to the window's
 * end. A baseline is the JSON object {bucket: count} under sketch:baseline:{tenant}:{baseline_ref},
 * written once. psi is the population stability index of a live sketch against its baseline.
 */
object Sketch {
  val jedis = new JedisPooled("redis", 6379)

  /** HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total. */
  val MergeLua: String =
    """for i = 1, #ARGV - 1, 2 do
      |  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
      |end
      |redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
      |local total = 0
      |for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
      |  total = total + tonumber(count)
      |end
      |return total
      |""".stripMargin

  /** A bucket share below this counts as this, so an empty bucket on one side stays finite. */
  val Epsilon = 1e-4

  def windowStart(now: Long, windowS: Long): Long = now / windowS * windowS
  def liveKey(tenant: String, monitorId: String, window: Long): String = s"sketch:live:$tenant:$monitorId:$window"
  def baselineKey(tenant: String, baselineRef: String): String = s"sketch:baseline:$tenant:$baselineRef"

  /** Merge a batch of bucket counts into the current window's sketch; returns the window's sample count. */
  def mergeBatch(tenant: String, monitorId: String, windowS: Long, batch: Map[Int, Long]): Long = {
    val now = System.currentTimeMillis() / 1000
    val window = windowStart(now, windowS)
    val args = batch.toSeq.sortBy(_._1).flatMap { case (bucket, count) => Seq(bucket.toString, count.toString) } :+ (window + windowS - now).toString
    jedis.eval(MergeLua, List(liveKey(tenant, monitorId, window)).asJava, args.asJava).asInstanceOf[java.lang.Long]
  }

  /** Write the baseline once; false when it already exists (it is left as it was). */
  def freezeBaseline(tenant: String, baselineRef: String, batch: Map[Int, Long]): Boolean = {
    val payload = JsObject(batch.map { case (bucket, count) => bucket.toString -> JsNumber(count) }).compactPrint
    jedis.set(baselineKey(tenant, baselineRef), payload, SetParams.setParams().nx()) != null
  }

  /** The live sketch of a window (empty when nothing was merged into it). */
  def readLive(tenant: String, monitorId: String, window: Long): Map[Int, Long] =
    jedis.hgetAll(liveKey(tenant, monitorId, window)).asScala.map { case (bucket, count) => bucket.toInt -> count.toLong }.toMap

  /** The frozen baseline (empty when it was never frozen). */
  def readBaseline(tenant: String, baselineRef: String): Map[Int, Long] =
    Option(jedis.get(baselineKey(tenant, baselineRef))).map(_.parseJson.asJsObject.fields.map {
      case (bucket, JsNumber(count)) => bucket.toInt -> count.toLong
      case (bucket, _) => bucket.toInt -> 0L
    }).getOrElse(Map.empty)

  /** Population stability index: the sum over buckets of (live share - baseline share) * ln(live share / baseline share). */
  def psi(live: Map[Int, Long], baseline: Map[Int, Long]): Double = {
    val liveTotal = live.values.sum
    val baselineTotal = baseline.values.sum
    if (liveTotal == 0 || baselineTotal == 0) 0.0
    else (live.keySet ++ baseline.keySet).toSeq.sorted.map { bucket =>
      val p = math.max(live.getOrElse(bucket, 0L).toDouble / liveTotal, Epsilon)
      val q = math.max(baseline.getOrElse(bucket, 0L).toDouble / baselineTotal, Epsilon)
      (p - q) * math.log(p / q)
    }.sum
  }
}
`,
};
