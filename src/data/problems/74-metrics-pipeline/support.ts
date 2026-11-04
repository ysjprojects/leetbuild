/**
 * Hand-written support modules the metrics-pipeline steps import but no step builds: the `metrics`
 * package. `metrics.model` is the series model every step shares (series ids, 10-second windows,
 * window ids, the shard map, the tenants' label allowlists). `metrics.windows` is the window store of
 * step 2 as the other steps use it (`merge_batch`, the atomic merge; `series_in_range` and
 * `read_windows`, the read side). `metrics.flush` is the shard-writer client of step 3 as step 4 uses
 * it; `metrics.outbox` the outbox a relay republishes from. The five languages keep the same keys,
 * so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'metrics/__init__.py': '',
  'metrics/model.py': `"""
The series model every step shares (provided). A sample is {"metric", "labels", "timestamp",
"value"}; its series is the metric with its sorted labels (series_id); it lands in the 10-second
window that holds its timestamp (window_start). A closed window is {"tenant", "series", "start",
"count", "sum"}; window_id names it for the shard writers, shard_for picks the shard its series
lives on. allowed_labels is each tenant's label allowlist.
"""
WINDOW_SECONDS = 10
RETENTION_SECONDS = 86400
SHARDS = ("shard-0:9000", "shard-1:9000", "shard-2:9000")

_BASE_LABELS = frozenset({"env", "host", "job", "region", "service"})
_TENANT_LABELS = {"acme": _BASE_LABELS | {"method", "pod", "route", "status", "zone"}}


def allowed_labels(tenant: str) -> frozenset:
    """The label names the tenant may send."""
    return _TENANT_LABELS.get(tenant, _BASE_LABELS)


def series_id(metric: str, labels: dict) -> str:
    """cpu_seconds{host=a,region=eu}: the metric with its labels sorted by name."""
    return metric + "{" + ",".join(f"{name}={labels[name]}" for name in sorted(labels)) + "}"


def window_start(timestamp: int) -> int:
    """The start of the 10-second window that holds timestamp."""
    return timestamp - timestamp % WINDOW_SECONDS


def window_id(window: dict) -> str:
    """{tenant}/{series}@{start}: what a shard writer deduplicates a window by."""
    return f"{window['tenant']}/{window['series']}@{window['start']}"


def shard_for(series: str) -> str:
    """The shard writer a series lives on: FNV-1a of the series id over SHARDS."""
    h = 0x811C9DC5
    for byte in series.encode():
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return SHARDS[h % len(SHARDS)]
`,
  'metrics/windows.py': `"""
The window store (provided; step 2 builds merge_batch). win:{tenant}:{series}:{start} is a hash
with count and sum, expiring RETENTION_SECONDS after its window closes; idx:{tenant}:{metric} is a
sorted set of a metric's window keys scored by window start; batch:{tenant}:{batch_id} claims a
batch for a day. merge_batch claims the batch and applies every sample in one Lua script: it
returns False for a batch already applied. series_in_range and read_windows are the read side.
"""
import redis

from metrics.model import RETENTION_SECONDS, WINDOW_SECONDS, series_id, window_start

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM_TTL_SECONDS = 86400

MERGE_LUA = """
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
"""
merge = r.register_script(MERGE_LUA)


def window_key(tenant: str, series: str, start: int) -> str:
    return f"win:{tenant}:{series}:{start}"


def index_key(tenant: str, metric: str) -> str:
    return f"idx:{tenant}:{metric}"


def batch_key(tenant: str, batch_id: str) -> str:
    return f"batch:{tenant}:{batch_id}"


def merge_batch(tenant: str, batch_id: str, samples: list) -> bool:
    """Apply every sample of the batch once, atomically; False when the batch id was applied before."""
    keys = [batch_key(tenant, batch_id)]
    args = [CLAIM_TTL_SECONDS, WINDOW_SECONDS + RETENTION_SECONDS]
    for sample in samples:
        start = window_start(sample["timestamp"])
        keys += [window_key(tenant, series_id(sample["metric"], sample["labels"]), start), index_key(tenant, sample["metric"])]
        args += [start, sample["value"]]
    return merge(keys=keys, args=args) == 1


def _split(tenant: str, key: str) -> tuple:
    series, _, start = key[len(f"win:{tenant}:"):].rpartition(":")
    return series, int(start)


def series_in_range(tenant: str, metric: str, start: int, end: int) -> list:
    """The sorted series ids of the metric with a window starting in [start, end]."""
    return sorted({_split(tenant, key)[0] for key in r.zrangebyscore(index_key(tenant, metric), start, end)})


def read_windows(tenant: str, metric: str, names: list, start: int, end: int) -> list:
    """The windows of the named series of the metric starting in [start, end], by series then start."""
    wanted = set(names)
    out = []
    for key in r.zrangebyscore(index_key(tenant, metric), start, end):
        series, begin = _split(tenant, key)
        if series not in wanted:
            continue
        fields = r.hgetall(key)
        if fields:  # an expired window leaves its index entry behind
            out.append({"tenant": tenant, "series": series, "start": begin, "count": int(fields["count"]), "sum": float(fields["sum"])})
    out.sort(key=lambda w: (w["series"], w["start"]))
    return out
`,
  'metrics/flush.py': `"""
The shard-writer client (provided; step 3 builds flush_windows). Every window goes to the shard its
series lives on, with a 2-second deadline per call; a round retries only the shards that still
hold pending windows, at most FLUSH_ATTEMPTS rounds. The result names the window ids the shards
accepted and, per shard target, the ids still pending for the next tick.
"""
import grpc

import metrics_pipeline_pb2 as pb
import metrics_pipeline_pb2_grpc as pb_grpc
from metrics.model import SHARDS, shard_for, window_id

FLUSH_DEADLINE_S = 2
FLUSH_ATTEMPTS = 3

stubs = {target: pb_grpc.MetricsWriterStub(grpc.insecure_channel(target)) for target in SHARDS}


def flush_windows(windows: list) -> dict:
    """{"accepted": [window ids], "pending": {shard target: [window ids]}}."""
    pending = {}
    for w in windows:
        pending.setdefault(shard_for(w["series"]), {})[window_id(w)] = w
    accepted = []
    for _ in range(FLUSH_ATTEMPTS):
        for target, batch in pending.items():
            if not batch:
                continue
            request = pb.WriteRequest(
                shard=target,
                windows=[
                    pb.Window(window_id=wid, tenant=w["tenant"], series=w["series"], start=w["start"], count=w["count"], sum=w["sum"])
                    for wid, w in batch.items()
                ],
            )
            try:
                reply = stubs[target].WriteWindows(request, timeout=FLUSH_DEADLINE_S)
            except grpc.RpcError:
                continue
            for wid in reply.accepted:
                if batch.pop(wid, None) is not None:
                    accepted.append(wid)
        if not any(pending.values()):
            break
    return {"accepted": accepted, "pending": {target: sorted(batch) for target, batch in pending.items() if batch}}
`,
  'metrics/outbox.py': `"""
The outbox (provided): rows a relay republishes once the broker is back. Each row of the Redis
list outbox is a JSON document {"topic", "key", "payload"}.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'metrics/model.ts': `/**
 * The series model every step shares (provided). A Sample's series is the metric with its sorted
 * labels (seriesId); it lands in the 10-second window that holds its timestamp (windowStart). A
 * closed Window names its tenant, series, start, count and sum; windowId names it for the shard
 * writers, shardFor picks the shard its series lives on. allowedLabels is each tenant's allowlist.
 */
export const WINDOW_SECONDS = 10;
export const RETENTION_SECONDS = 86400;
export const SHARDS = ['shard-0:9000', 'shard-1:9000', 'shard-2:9000'] as const;

export interface Sample {
  metric: string;
  labels: Record<string, string>;
  timestamp: number;
  value: number;
}

export interface Window {
  tenant: string;
  series: string;
  start: number;
  count: number;
  sum: number;
}

/** What a flush did: the window ids the shards accepted, and per shard target the ids still pending. */
export interface FlushResult {
  accepted: string[];
  pending: Record<string, string[]>;
}

const BASE_LABELS = ['env', 'host', 'job', 'region', 'service'];
const TENANT_LABELS: Record<string, string[]> = {acme: [...BASE_LABELS, 'method', 'pod', 'route', 'status', 'zone']};

/** The label names the tenant may send. */
export const allowedLabels = (tenant: string): Set<string> => new Set(TENANT_LABELS[tenant] ?? BASE_LABELS);

/** cpu_seconds{host=a,region=eu}: the metric with its labels sorted by name. */
export const seriesId = (metric: string, labels: Record<string, string>): string =>
  \`\${metric}{\${Object.keys(labels)
    .sort()
    .map(name => \`\${name}=\${labels[name]}\`)
    .join(',')}}\`;

/** The start of the 10-second window that holds timestamp. */
export const windowStart = (timestamp: number): number => timestamp - (timestamp % WINDOW_SECONDS);

/** {tenant}/{series}@{start}: what a shard writer deduplicates a window by. */
export const windowId = (w: Window): string => \`\${w.tenant}/\${w.series}@\${w.start}\`;

/** The shard writer a series lives on: FNV-1a of the series id over SHARDS. */
export function shardFor(series: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(series)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return SHARDS[h % SHARDS.length];
}
`,
  'metrics/windows.ts': `/**
 * The window store (provided; step 2 builds mergeBatch). win:{tenant}:{series}:{start} is a hash
 * with count and sum, expiring RETENTION_SECONDS after its window closes; idx:{tenant}:{metric} is a
 * sorted set of a metric's window keys scored by window start; batch:{tenant}:{batchId} claims a
 * batch for a day. mergeBatch claims the batch and applies every sample in one Lua script: it
 * resolves false for a batch already applied. seriesInRange and readWindows are the read side.
 */
import Redis from 'ioredis';

import {RETENTION_SECONDS, type Sample, type Window, WINDOW_SECONDS, seriesId, windowStart} from 'metrics/model';

const redis = new Redis({host: 'redis', port: 6379});

export const CLAIM_TTL_SECONDS = 86400;

export const MERGE_LUA = \`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
\`;

export const windowKey = (tenant: string, series: string, start: number): string => \`win:\${tenant}:\${series}:\${start}\`;
export const indexKey = (tenant: string, metric: string): string => \`idx:\${tenant}:\${metric}\`;
export const batchKey = (tenant: string, batchId: string): string => \`batch:\${tenant}:\${batchId}\`;

/** Apply every sample of the batch once, atomically; false when the batch id was applied before. */
export async function mergeBatch(tenant: string, batchId: string, samples: Sample[]): Promise<boolean> {
  const keys = [batchKey(tenant, batchId)];
  const args: (string | number)[] = [CLAIM_TTL_SECONDS, WINDOW_SECONDS + RETENTION_SECONDS];
  for (const s of samples) {
    const start = windowStart(s.timestamp);
    keys.push(windowKey(tenant, seriesId(s.metric, s.labels), start), indexKey(tenant, s.metric));
    args.push(start, s.value);
  }
  return (await redis.eval(MERGE_LUA, keys.length, ...keys, ...args)) === 1;
}

function split(tenant: string, key: string): [string, number] {
  const rest = key.slice(\`win:\${tenant}:\`.length);
  const at = rest.lastIndexOf(':');
  return [rest.slice(0, at), Number(rest.slice(at + 1))];
}

/** The sorted series ids of the metric with a window starting in [start, end]. */
export async function seriesInRange(tenant: string, metric: string, start: number, end: number): Promise<string[]> {
  const keys = await redis.zrangebyscore(indexKey(tenant, metric), start, end);
  return [...new Set(keys.map(key => split(tenant, key)[0]))].sort();
}

/** The windows of the named series of the metric starting in [start, end], by series then start. */
export async function readWindows(tenant: string, metric: string, names: string[], start: number, end: number): Promise<Window[]> {
  const wanted = new Set(names);
  const out: Window[] = [];
  for (const key of await redis.zrangebyscore(indexKey(tenant, metric), start, end)) {
    const [series, begin] = split(tenant, key);
    if (!wanted.has(series)) continue;
    const fields = await redis.hgetall(key);
    // An expired window leaves its index entry behind.
    if (fields.count !== undefined) out.push({tenant, series, start: begin, count: Number(fields.count), sum: Number(fields.sum)});
  }
  return out.sort((a, b) => (a.series === b.series ? a.start - b.start : a.series < b.series ? -1 : 1));
}
`,
  'metrics/flush.ts': `/**
 * The shard-writer client (provided; step 3 builds flushWindows). Every window goes to the shard its
 * series lives on, with a 2-second deadline per call; a round retries only the shards that still
 * hold pending windows, at most FLUSH_ATTEMPTS rounds. The result names the window ids the shards
 * accepted and, per shard target, the ids still pending for the next tick.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type FlushResult, SHARDS, type Window, shardFor, windowId} from 'metrics/model';

export const FLUSH_DEADLINE_MS = 2000;
export const FLUSH_ATTEMPTS = 3;

interface WriteRequest {
  shard: string;
  windows: {window_id: string; tenant: string; series: string; start: number; count: number; sum: number}[];
}

type Writer = grpc.Client & {
  WriteWindows(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{accepted: string[]}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('metrics_pipeline.proto')) as unknown as {
  metricsd: {MetricsWriter: grpc.ServiceClientConstructor};
};
const writers: Record<string, Writer> = Object.fromEntries(
  SHARDS.map(target => [target, new pkg.metricsd.MetricsWriter(target, grpc.credentials.createInsecure()) as Writer]),
);

export async function flushWindows(windows: Window[]): Promise<FlushResult> {
  const pending = new Map<string, Map<string, Window>>();
  for (const w of windows) {
    const target = shardFor(w.series);
    if (!pending.has(target)) pending.set(target, new Map());
    pending.get(target)?.set(windowId(w), w);
  }
  const accepted: string[] = [];
  for (let round = 0; round < FLUSH_ATTEMPTS; round += 1) {
    for (const [target, batch] of pending) {
      if (batch.size === 0) continue;
      const request = {shard: target, windows: [...batch].map(([window_id, w]) => ({window_id, ...w}))};
      let reply: {accepted: string[]};
      try {
        reply = await writers[target].WriteWindows(request, new grpc.Metadata(), {deadline: Date.now() + FLUSH_DEADLINE_MS});
      } catch {
        continue;
      }
      for (const id of reply.accepted ?? []) if (batch.delete(id)) accepted.push(id);
    }
    if ([...pending.values()].every(batch => batch.size === 0)) break;
  }
  const left: Record<string, string[]> = {};
  for (const [target, batch] of pending) if (batch.size > 0) left[target] = [...batch.keys()].sort();
  return {accepted, pending: left};
}
`,
  'metrics/outbox.ts': `/**
 * The outbox (provided): rows a relay republishes once the broker is back. Each row of the Redis
 * list outbox is a JSON document {topic, key, payload}.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'metrics/model/model.go': `// Package model is the series model every step shares (provided). A Sample's series is the metric
// with its sorted labels (SeriesID); it lands in the 10-second window that holds its timestamp
// (WindowStart). A closed Window names its tenant, series, start, count and sum; WindowID names it
// for the shard writers, ShardFor picks the shard its series lives on. AllowedLabels is each
// tenant's label allowlist.
package model

import (
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
)

const (
	WindowSeconds    = 10
	RetentionSeconds = 86400
)

// Shards are the shard writers' targets.
var Shards = []string{"shard-0:9000", "shard-1:9000", "shard-2:9000"}

// Sample is one datapoint as a client sends it.
type Sample struct {
	Metric    string            \`json:"metric"\`
	Labels    map[string]string \`json:"labels"\`
	Timestamp int64             \`json:"timestamp"\`
	Value     float64           \`json:"value"\`
}

// Window is one closed aggregation window of one series of one tenant.
type Window struct {
	Tenant string  \`json:"tenant"\`
	Series string  \`json:"series"\`
	Start  int64   \`json:"start"\`
	Count  int64   \`json:"count"\`
	Sum    float64 \`json:"sum"\`
}

// FlushResult is what a flush did: the window ids the shards accepted, and per shard target the ids still pending.
type FlushResult struct {
	Accepted []string
	Pending  map[string][]string
}

var baseLabels = []string{"env", "host", "job", "region", "service"}

var tenantLabels = map[string][]string{"acme": append(append([]string{}, baseLabels...), "method", "pod", "route", "status", "zone")}

// AllowedLabels is the set of label names the tenant may send.
func AllowedLabels(tenant string) map[string]bool {
	names, ok := tenantLabels[tenant]
	if !ok {
		names = baseLabels
	}
	out := map[string]bool{}
	for _, name := range names {
		out[name] = true
	}
	return out
}

// SeriesID is cpu_seconds{host=a,region=eu}: the metric with its labels sorted by name.
func SeriesID(metric string, labels map[string]string) string {
	names := make([]string, 0, len(labels))
	for name := range labels {
		names = append(names, name)
	}
	sort.Strings(names)
	pairs := make([]string, len(names))
	for i, name := range names {
		pairs[i] = name + "=" + labels[name]
	}
	return metric + "{" + strings.Join(pairs, ",") + "}"
}

// WindowStart is the start of the 10-second window that holds timestamp.
func WindowStart(timestamp int64) int64 { return timestamp - timestamp%WindowSeconds }

// WindowID is {tenant}/{series}@{start}: what a shard writer deduplicates a window by.
func WindowID(w Window) string { return fmt.Sprintf("%s/%s@%d", w.Tenant, w.Series, w.Start) }

// ShardFor is the shard writer a series lives on: FNV-1a of the series id over Shards.
func ShardFor(series string) string {
	h := fnv.New32a()
	h.Write([]byte(series))
	return Shards[h.Sum32()%uint32(len(Shards))]
}
`,
  'metrics/windows/windows.go': `// Package windows is the window store (provided; step 2 builds mergeBatch).
// win:{tenant}:{series}:{start} is a hash with count and sum, expiring RetentionSeconds after its
// window closes; idx:{tenant}:{metric} is a sorted set of a metric's window keys scored by window
// start; batch:{tenant}:{batchID} claims a batch for a day. MergeBatch claims the batch and applies
// every sample in one Lua script: it reports false for a batch already applied. SeriesInRange and
// ReadWindows are the read side.
package windows

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"metrics/model"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ClaimTTLSeconds = 86400

// Merge claims KEYS[1] and applies each (window key, index key) pair of KEYS with its (start, value) in ARGV.
var Merge = redis.NewScript(\`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
\`)

func WindowKey(tenant, series string, start int64) string {
	return "win:" + tenant + ":" + series + ":" + strconv.FormatInt(start, 10)
}

func IndexKey(tenant, metric string) string { return "idx:" + tenant + ":" + metric }

func BatchKey(tenant, batchID string) string { return "batch:" + tenant + ":" + batchID }

// MergeBatch applies every sample of the batch once, atomically; false when the batch id was applied before.
func MergeBatch(ctx context.Context, tenant, batchID string, samples []model.Sample) (bool, error) {
	keys := []string{BatchKey(tenant, batchID)}
	args := []any{ClaimTTLSeconds, model.WindowSeconds + model.RetentionSeconds}
	for _, s := range samples {
		start := model.WindowStart(s.Timestamp)
		keys = append(keys, WindowKey(tenant, model.SeriesID(s.Metric, s.Labels), start), IndexKey(tenant, s.Metric))
		args = append(args, start, strconv.FormatFloat(s.Value, 'f', -1, 64))
	}
	applied, err := Merge.Run(ctx, rdb, keys, args...).Int64()
	return applied == 1, err
}

func split(tenant, key string) (string, int64) {
	rest := strings.TrimPrefix(key, "win:"+tenant+":")
	at := strings.LastIndex(rest, ":")
	start, _ := strconv.ParseInt(rest[at+1:], 10, 64)
	return rest[:at], start
}

func indexed(ctx context.Context, tenant, metric string, start, end int64) ([]string, error) {
	return rdb.ZRangeByScore(ctx, IndexKey(tenant, metric), &redis.ZRangeBy{Min: strconv.FormatInt(start, 10), Max: strconv.FormatInt(end, 10)}).Result()
}

// SeriesInRange is the sorted series ids of the metric with a window starting in [start, end].
func SeriesInRange(ctx context.Context, tenant, metric string, start, end int64) ([]string, error) {
	keys, err := indexed(ctx, tenant, metric, start, end)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	names := []string{}
	for _, key := range keys {
		series, _ := split(tenant, key)
		if !seen[series] {
			seen[series] = true
			names = append(names, series)
		}
	}
	sort.Strings(names)
	return names, nil
}

// ReadWindows is the windows of the named series of the metric starting in [start, end], by series then start.
func ReadWindows(ctx context.Context, tenant, metric string, names []string, start, end int64) ([]model.Window, error) {
	wanted := map[string]bool{}
	for _, name := range names {
		wanted[name] = true
	}
	keys, err := indexed(ctx, tenant, metric, start, end)
	if err != nil {
		return nil, err
	}
	out := []model.Window{}
	for _, key := range keys {
		series, begin := split(tenant, key)
		if !wanted[series] {
			continue
		}
		fields, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		if len(fields) == 0 {
			continue // an expired window leaves its index entry behind
		}
		count, _ := strconv.ParseInt(fields["count"], 10, 64)
		sum, _ := strconv.ParseFloat(fields["sum"], 64)
		out = append(out, model.Window{Tenant: tenant, Series: series, Start: begin, Count: count, Sum: sum})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Series != out[j].Series {
			return out[i].Series < out[j].Series
		}
		return out[i].Start < out[j].Start
	})
	return out, nil
}
`,
  'metrics/flush/flush.go': `// Package flush is the shard-writer client (provided; step 3 builds flushWindows). Every window goes
// to the shard its series lives on, with a 2-second deadline per call; a round retries only the
// shards that still hold pending windows, at most FlushAttempts rounds. The result names the window
// ids the shards accepted and, per shard target, the ids still pending for the next tick.
package flush

import (
	"context"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "metrics/gen/metrics_pipeline"
	"metrics/model"
)

const (
	FlushDeadline = 2 * time.Second
	FlushAttempts = 3
)

var writers = newWriters()

func newWriters() map[string]pb.MetricsWriterClient {
	out := map[string]pb.MetricsWriterClient{}
	for _, target := range model.Shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewMetricsWriterClient(conn)
	}
	return out
}

// FlushWindows sends every window to its shard and reports what was accepted and what is pending.
func FlushWindows(ctx context.Context, windows []model.Window) model.FlushResult {
	pending := map[string]map[string]model.Window{}
	for _, w := range windows {
		target := model.ShardFor(w.Series)
		if pending[target] == nil {
			pending[target] = map[string]model.Window{}
		}
		pending[target][model.WindowID(w)] = w
	}
	accepted := []string{}
	for round := 0; round < FlushAttempts; round++ {
		left := 0
		for _, target := range model.Shards {
			batch := pending[target]
			if len(batch) == 0 {
				continue
			}
			request := &pb.WriteRequest{Shard: target}
			for id, w := range batch {
				request.Windows = append(request.Windows, &pb.Window{WindowId: id, Tenant: w.Tenant, Series: w.Series, Start: w.Start, Count: w.Count, Sum: w.Sum})
			}
			callCtx, cancel := context.WithTimeout(ctx, FlushDeadline)
			reply, err := writers[target].WriteWindows(callCtx, request)
			cancel()
			if err == nil {
				for _, id := range reply.GetAccepted() {
					if _, ok := batch[id]; ok {
						delete(batch, id)
						accepted = append(accepted, id)
					}
				}
			}
			left += len(batch)
		}
		if left == 0 {
			break
		}
	}
	result := model.FlushResult{Accepted: accepted, Pending: map[string][]string{}}
	for target, batch := range pending {
		if len(batch) == 0 {
			continue
		}
		ids := make([]string, 0, len(batch))
		for id := range batch {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		result.Pending[target] = ids
	}
	return result
}
`,
  'metrics/outbox/outbox.go': `// Package outbox is the outbox (provided): rows a relay republishes once the broker is back. Each row
// of the Redis list outbox is a JSON document {"topic", "key", "payload"}.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert appends a row for the relay.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'metrics/model.h': `// The series model every step shares (provided). A Sample's series is the metric with its sorted
// labels (seriesId); it lands in the 10-second window that holds its timestamp (windowStart). A
// closed Window names its tenant, series, start, count and sum; windowId names it for the shard
// writers, shardFor picks the shard its series lives on. allowedLabels is each tenant's allowlist.
#pragma once

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace metrics {

constexpr long long kWindowSeconds = 10;
constexpr long long kRetentionSeconds = 86400;
inline const std::vector<std::string> kShards = {"shard-0:9000", "shard-1:9000", "shard-2:9000"};

// One datapoint as a client sends it.
struct Sample {
  std::string metric;
  std::map<std::string, std::string> labels;
  long long timestamp = 0;
  double value = 0;
};

// One closed aggregation window of one series of one tenant.
struct Window {
  std::string tenant;
  std::string series;
  long long start = 0;
  long long count = 0;
  double sum = 0;
};

// What a flush did: the window ids the shards accepted, and per shard target the ids still pending.
struct FlushResult {
  std::vector<std::string> accepted;
  std::map<std::string, std::vector<std::string>> pending;
};

// The label names the tenant may send.
inline std::set<std::string> allowedLabels(const std::string& tenant) {
  std::set<std::string> names = {"env", "host", "job", "region", "service"};
  if (tenant == "acme") names.insert({"method", "pod", "route", "status", "zone"});
  return names;
}

// cpu_seconds{host=a,region=eu}: the metric with its labels sorted by name.
inline std::string seriesId(const std::string& metric, const std::map<std::string, std::string>& labels) {
  std::string out = metric + "{";
  bool first = true;
  for (const auto& [name, value] : labels) {
    if (!first) out += ",";
    out += name + "=" + value;
    first = false;
  }
  return out + "}";
}

// The start of the 10-second window that holds timestamp.
inline long long windowStart(long long timestamp) { return timestamp - timestamp % kWindowSeconds; }

// {tenant}/{series}@{start}: what a shard writer deduplicates a window by.
inline std::string windowId(const Window& w) { return w.tenant + "/" + w.series + "@" + std::to_string(w.start); }

// The shard writer a series lives on: FNV-1a of the series id over kShards.
inline std::string shardFor(const std::string& series) {
  uint32_t h = 0x811C9DC5u;
  for (unsigned char byte : series) h = (h ^ byte) * 0x01000193u;
  return kShards[h % kShards.size()];
}

}  // namespace metrics
`,
  'metrics/windows.h': `// The window store (provided; step 2 builds mergeBatch). win:{tenant}:{series}:{start} is a hash
// with count and sum, expiring kRetentionSeconds after its window closes; idx:{tenant}:{metric} is a
// sorted set of a metric's window keys scored by window start; batch:{tenant}:{batch_id} claims a
// batch for a day. mergeBatch claims the batch and applies every sample in one Lua script: it
// returns false for a batch already applied. seriesInRange and readWindows are the read side.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "metrics/model.h"

namespace metrics {

constexpr long long kClaimTtlSeconds = 86400;

inline const std::string kMergeLua = R"lua(
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
)lua";

inline sw::redis::Redis& windowStore() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string windowKey(const std::string& tenant, const std::string& series, long long start) {
  return "win:" + tenant + ":" + series + ":" + std::to_string(start);
}

inline std::string indexKey(const std::string& tenant, const std::string& metric) { return "idx:" + tenant + ":" + metric; }

inline std::string batchKey(const std::string& tenant, const std::string& batch_id) { return "batch:" + tenant + ":" + batch_id; }

inline std::string formatValue(double value) {
  std::ostringstream out;
  out.precision(17);
  out << value;
  return out.str();
}

// Apply every sample of the batch once, atomically; false when the batch id was applied before.
inline bool mergeBatch(const std::string& tenant, const std::string& batch_id, const std::vector<Sample>& samples) {
  std::vector<std::string> keys = {batchKey(tenant, batch_id)};
  std::vector<std::string> args = {std::to_string(kClaimTtlSeconds), std::to_string(kWindowSeconds + kRetentionSeconds)};
  for (const Sample& s : samples) {
    const long long start = windowStart(s.timestamp);
    keys.push_back(windowKey(tenant, seriesId(s.metric, s.labels), start));
    keys.push_back(indexKey(tenant, s.metric));
    args.push_back(std::to_string(start));
    args.push_back(formatValue(s.value));
  }
  return windowStore().eval<long long>(kMergeLua, keys, args) == 1;
}

inline std::pair<std::string, long long> splitWindowKey(const std::string& tenant, const std::string& key) {
  const std::string rest = key.substr(("win:" + tenant + ":").size());
  const size_t at = rest.rfind(':');
  return {rest.substr(0, at), std::stoll(rest.substr(at + 1))};
}

inline std::vector<std::string> indexedWindows(const std::string& tenant, const std::string& metric, long long start, long long end) {
  std::vector<std::string> keys;
  windowStore().zrangebyscore(indexKey(tenant, metric),
                              sw::redis::BoundedInterval<double>(static_cast<double>(start), static_cast<double>(end), sw::redis::BoundType::CLOSED),
                              std::back_inserter(keys));
  return keys;
}

// The sorted series ids of the metric with a window starting in [start, end].
inline std::vector<std::string> seriesInRange(const std::string& tenant, const std::string& metric, long long start, long long end) {
  std::set<std::string> names;
  for (const std::string& key : indexedWindows(tenant, metric, start, end)) names.insert(splitWindowKey(tenant, key).first);
  return std::vector<std::string>(names.begin(), names.end());
}

// The windows of the named series of the metric starting in [start, end], by series then start.
inline std::vector<Window> readWindows(const std::string& tenant, const std::string& metric, const std::vector<std::string>& names,
                                       long long start, long long end) {
  const std::set<std::string> wanted(names.begin(), names.end());
  std::vector<Window> out;
  for (const std::string& key : indexedWindows(tenant, metric, start, end)) {
    const auto [series, begin] = splitWindowKey(tenant, key);
    if (wanted.count(series) == 0) continue;
    const std::unordered_map<std::string, std::string> fields = windowStore().hgetall(key);
    if (fields.empty()) continue;  // an expired window leaves its index entry behind
    out.push_back(Window{tenant, series, begin, std::stoll(fields.at("count")), std::stod(fields.at("sum"))});
  }
  std::sort(out.begin(), out.end(), [](const Window& a, const Window& b) {
    return a.series != b.series ? a.series < b.series : a.start < b.start;
  });
  return out;
}

}  // namespace metrics
`,
  'metrics/flush.h': `// The shard-writer client (provided; step 3 builds flushWindows). Every window goes to the shard its
// series lives on, with a 2-second deadline per call; a round retries only the shards that still
// hold pending windows, at most kFlushAttempts rounds. The result names the window ids the shards
// accepted and, per shard target, the ids still pending for the next tick.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "metrics/model.h"
#include "metrics_pipeline.grpc.pb.h"

namespace metrics {

constexpr std::chrono::seconds kFlushDeadline{2};
constexpr int kFlushAttempts = 3;

inline std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>>& shardWriters() {
  static std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>> writers = [] {
    std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>> out;
    for (const std::string& target : kShards) {
      out[target] = metricsd::MetricsWriter::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
    }
    return out;
  }();
  return writers;
}

// Send every window to its shard; what was accepted and what is pending.
inline FlushResult flushWindows(const std::vector<Window>& windows) {
  std::map<std::string, std::map<std::string, Window>> pending;
  for (const Window& w : windows) pending[shardFor(w.series)][windowId(w)] = w;
  FlushResult result;
  for (int round = 0; round < kFlushAttempts; round++) {
    size_t left = 0;
    for (auto& [target, batch] : pending) {
      if (batch.empty()) continue;
      metricsd::WriteRequest request;
      request.set_shard(target);
      for (const auto& [id, w] : batch) {
        metricsd::Window* out = request.add_windows();
        out->set_window_id(id);
        out->set_tenant(w.tenant);
        out->set_series(w.series);
        out->set_start(w.start);
        out->set_count(w.count);
        out->set_sum(w.sum);
      }
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kFlushDeadline);
      metricsd::WriteReply reply;
      if (shardWriters()[target]->WriteWindows(&ctx, request, &reply).ok()) {
        for (const std::string& id : reply.accepted()) {
          if (batch.erase(id) > 0) result.accepted.push_back(id);
        }
      }
      left += batch.size();
    }
    if (left == 0) break;
  }
  for (const auto& [target, batch] : pending) {
    for (const auto& [id, w] : batch) result.pending[target].push_back(id);
  }
  return result;
}

}  // namespace metrics
`,
  'metrics/outbox.h': `// The outbox (provided): rows a relay republishes once the broker is back. Each row of the Redis
// list outbox is a JSON document {"topic", "key", "payload"}.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace metrics {

inline void outboxInsert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  static sw::redis::Redis r("tcp://redis:6379");
  r.rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace metrics
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('metrics', 'Model')]: `package metrics

import java.nio.charset.StandardCharsets.UTF_8

/**
 * The series model every step shares (provided). A Sample's series is the metric with its sorted
 * labels (seriesId); it lands in the 10-second window that holds its timestamp (windowStart). A
 * closed Window names its tenant, series, start, count and sum; windowId names it for the shard
 * writers, shardFor picks the shard its series lives on. allowedLabels is each tenant's allowlist.
 */
object Model {
  val WindowSeconds = 10L
  val RetentionSeconds = 86400L
  val Shards: Seq[String] = Seq("shard-0:9000", "shard-1:9000", "shard-2:9000")

  final case class Sample(metric: String, labels: Map[String, String], timestamp: Long, value: Double)
  final case class Window(tenant: String, series: String, start: Long, count: Long, sum: Double)
  /** What a flush did: the window ids the shards accepted, and per shard target the ids still pending. */
  final case class FlushResult(accepted: Seq[String], pending: Map[String, Seq[String]])

  private val BaseLabels = Set("env", "host", "job", "region", "service")
  private val TenantLabels = Map("acme" -> (BaseLabels ++ Set("method", "pod", "route", "status", "zone")))

  /** The label names the tenant may send. */
  def allowedLabels(tenant: String): Set[String] = TenantLabels.getOrElse(tenant, BaseLabels)

  /** cpu_seconds{host=a,region=eu}: the metric with its labels sorted by name. */
  def seriesId(metric: String, labels: Map[String, String]): String =
    labels.toSeq.sortBy(_._1).map { case (name, value) => s"$name=$value" }.mkString(metric + "{", ",", "}")

  /** The start of the 10-second window that holds timestamp. */
  def windowStart(timestamp: Long): Long = timestamp - timestamp % WindowSeconds

  /** {tenant}/{series}@{start}: what a shard writer deduplicates a window by. */
  def windowId(w: Window): String = s"\${w.tenant}/\${w.series}@\${w.start}"

  /** The shard writer a series lives on: FNV-1a of the series id over Shards. */
  def shardFor(series: String): String = {
    var h = 0x811c9dc5L
    series.getBytes(UTF_8).foreach(b => h = ((h ^ (b & 0xff)) * 0x01000193L) & 0xffffffffL)
    Shards((h % Shards.size).toInt)
  }
}
`,
  [scalaPath('metrics', 'Windows')]: `package metrics

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import metrics.Model.{RetentionSeconds, Sample, Window, WindowSeconds, seriesId, windowStart}

/**
 * The window store (provided; step 2 builds mergeBatch). win:{tenant}:{series}:{start} is a hash
 * with count and sum, expiring RetentionSeconds after its window closes; idx:{tenant}:{metric} is a
 * sorted set of a metric's window keys scored by window start; batch:{tenant}:{batchId} claims a
 * batch for a day. mergeBatch claims the batch and applies every sample in one Lua script: it
 * returns false for a batch already applied. seriesInRange and readWindows are the read side.
 */
object Windows {
  val jedis = new JedisPooled("redis", 6379)

  val ClaimTtlSeconds = 86400L

  val MergeLua: String =
    """if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
      |for i = 2, #KEYS, 2 do
      |  local start = tonumber(ARGV[i + 1])
      |  redis.call('HINCRBY', KEYS[i], 'count', 1)
      |  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
      |  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
      |  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
      |end
      |return 1
      |""".stripMargin

  def windowKey(tenant: String, series: String, start: Long): String = s"win:$tenant:$series:$start"
  def indexKey(tenant: String, metric: String): String = s"idx:$tenant:$metric"
  def batchKey(tenant: String, batchId: String): String = s"batch:$tenant:$batchId"

  /** Apply every sample of the batch once, atomically; false when the batch id was applied before. */
  def mergeBatch(tenant: String, batchId: String, samples: Seq[Sample]): Boolean = {
    val keys = batchKey(tenant, batchId) +: samples.flatMap { s =>
      Seq(windowKey(tenant, seriesId(s.metric, s.labels), windowStart(s.timestamp)), indexKey(tenant, s.metric))
    }
    val args = Seq(ClaimTtlSeconds.toString, (WindowSeconds + RetentionSeconds).toString) ++
      samples.flatMap(s => Seq(windowStart(s.timestamp).toString, s.value.toString))
    jedis.eval(MergeLua, keys.asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  private def split(tenant: String, key: String): (String, Long) = {
    val rest = key.stripPrefix(s"win:$tenant:")
    val at = rest.lastIndexOf(':')
    (rest.substring(0, at), rest.substring(at + 1).toLong)
  }

  private def indexed(tenant: String, metric: String, start: Long, end: Long): Seq[String] =
    jedis.zrangeByScore(indexKey(tenant, metric), start.toDouble, end.toDouble).asScala.toSeq

  /** The sorted series ids of the metric with a window starting in [start, end]. */
  def seriesInRange(tenant: String, metric: String, start: Long, end: Long): Seq[String] =
    indexed(tenant, metric, start, end).map(split(tenant, _)._1).distinct.sorted

  /** The windows of the named series of the metric starting in [start, end], by series then start. */
  def readWindows(tenant: String, metric: String, names: Seq[String], start: Long, end: Long): Seq[Window] = {
    val wanted = names.toSet
    indexed(tenant, metric, start, end)
      .map(key => (key, split(tenant, key)))
      .filter { case (_, (series, _)) => wanted(series) }
      .flatMap { case (key, (series, begin)) =>
        val fields = jedis.hgetAll(key).asScala
        // An expired window leaves its index entry behind.
        if (fields.isEmpty) None else Some(Window(tenant, series, begin, fields("count").toLong, fields("sum").toDouble))
      }
      .sortBy(w => (w.series, w.start))
  }
}
`,
  [scalaPath('metrics', 'Flush')]: `package metrics

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import metrics.Model.{FlushResult, Shards, Window, shardFor, windowId}
import metricsd.metrics_pipeline.{MetricsWriterGrpc, WriteRequest, Window => WireWindow}

/**
 * The shard-writer client (provided; step 3 builds flushWindows). Every window goes to the shard its
 * series lives on, with a 2-second deadline per call; a round retries only the shards that still
 * hold pending windows, at most FlushAttempts rounds. The result names the window ids the shards
 * accepted and, per shard target, the ids still pending for the next tick.
 */
object Flush {
  val FlushDeadlineSeconds = 2L
  val FlushAttempts = 3

  private val writers = Shards.map(target => target -> MetricsWriterGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build())).toMap

  def flushWindows(windows: Seq[Window]): FlushResult = {
    val pending = scala.collection.mutable.Map.empty[String, scala.collection.mutable.Map[String, Window]]
    windows.foreach(w => pending.getOrElseUpdate(shardFor(w.series), scala.collection.mutable.Map.empty)(windowId(w)) = w)
    val accepted = scala.collection.mutable.ArrayBuffer.empty[String]
    var round = 0
    while (round < FlushAttempts && pending.values.exists(_.nonEmpty)) {
      for ((target, batch) <- pending if batch.nonEmpty) {
        val request = WriteRequest(target, batch.toSeq.map { case (id, w) => WireWindow(id, w.tenant, w.series, w.start, w.count, w.sum) })
        try {
          val reply = writers(target).withDeadlineAfter(FlushDeadlineSeconds, TimeUnit.SECONDS).writeWindows(request)
          reply.accepted.foreach(id => if (batch.remove(id).isDefined) accepted += id)
        } catch { case _: StatusRuntimeException => () }
      }
      round += 1
    }
    FlushResult(accepted.toSeq, pending.collect { case (target, batch) if batch.nonEmpty => target -> batch.keys.toSeq.sorted }.toMap)
  }
}
`,
  [scalaPath('metrics', 'Outbox')]: `package metrics

import redis.clients.jedis.JedisPooled
import spray.json._

/** The outbox (provided): rows a relay republishes once the broker is back. Each row of the Redis list outbox is a JSON document {topic, key, payload}. */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
