/**
 * Hand-written support modules the training-scheduler steps import but no step builds: the
 * `trainsched` package. `runs` is the run store (one Redis hash per run, the Idempotency-Key
 * bindings, a run-id sequence), `queue` the run queue and start leases of step 2 as the other steps
 * use it, `outbox` the rows a relay republishes when the broker did not take an event, and `cluster`
 * the cluster's own view of which nodes hold a run. The five languages keep the same keys, so a
 * harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

const CLAIM_LUA = `local id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if not id then return false end
local position = redis.call('ZSCORE', KEYS[1], id)
redis.call('ZREM', KEYS[1], id)
redis.call('SET', 'training:lease:' .. id, ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], id)
redis.call('HSET', 'run:' .. id, 'state', 'starting', 'worker', ARGV[1], 'position', position)
return id`;

const CONFIRM_LUA = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('HSET', 'run:' .. ARGV[2], 'state', 'running')
return 1`;

const REAP_LUA = `local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('DEL', 'training:lease:' .. id)
  redis.call('ZADD', KEYS[1], redis.call('HGET', 'run:' .. id, 'position'), id)
  redis.call('HSET', 'run:' .. id, 'state', 'queued', 'worker', '')
end
return #ids`;

/** The queue module's header comment, the same in every language. */
const QUEUE_DOC = [
  'The run queue (provided; step 2 builds the same functions): training:queue is a sorted set with',
  'one member per waiting run, scored band * BAND_SPAN_MS + enqueued_at_ms, so band 0 comes first and',
  'a band is first come, first served. A start is a lease: claim_next takes the head in one Lua',
  'script, remembers its score in the run hash (position), sets training:lease:{run_id} to the worker',
  'for LEASE_TTL_MS and records the deadline in training:leases. confirm_start turns the lease into',
  'a running run only for the worker that still holds it; reap_expired puts every run whose lease',
  'ran out back at the position it had.',
];

const doc = (lines: string[], prefix: string): string => lines.map(l => `${prefix}${l}`.trimEnd()).join('\n');

export const supportModules: Record<string, string> = {
  'trainsched/__init__.py': '',
  'trainsched/runs.py': `"""
The run store (provided): every training run is a Redis hash run:{run_id} with run_id, tenant,
recipe_version, dataset_version, priority, band, state (queued, starting or running),
enqueued_at_ms, worker, nodes (comma-separated) and checkpoint_id. run:key:{tenant}:{key} names
the run a submission's Idempotency-Key created. A run is returned as a dict: priority, band and
enqueued_at_ms as ints, nodes as a list.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FIELDS = (
    "run_id", "tenant", "recipe_version", "dataset_version", "priority", "band",
    "state", "enqueued_at_ms", "worker", "nodes", "checkpoint_id",
)
INTS = ("priority", "band", "enqueued_at_ms")


def run_key(run_id: str) -> str:
    return f"run:{run_id}"


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ",".join(value)
    return str(value)


def new_run_id() -> str:
    """A run id no other submission gets, on this replica or any other: a Redis sequence."""
    return f"run-{r.incr('run:seq')}"


def put(run: dict) -> None:
    """Write the whole run row (a field the dict lacks is written empty)."""
    r.hset(run_key(run["run_id"]), mapping={name: _text(run.get(name)) for name in FIELDS})


def get(run_id: str) -> dict | None:
    """The run row, or None."""
    raw = r.hgetall(run_key(run_id))
    if not raw.get("run_id"):
        return None
    run = {name: raw.get(name, "") for name in FIELDS}
    for name in INTS:
        run[name] = int(run[name] or 0)
    run["nodes"] = [n for n in run["nodes"].split(",") if n]
    return run


def set_nodes(run_id: str, nodes: list[str]) -> None:
    """Record the nodes the worker placed the run on."""
    r.hset(run_key(run_id), "nodes", ",".join(nodes))


def set_checkpoint(run_id: str, checkpoint_id: str) -> None:
    """Record the run's latest checkpoint: the point it resumes from."""
    r.hset(run_key(run_id), "checkpoint_id", checkpoint_id)


def run_for_key(tenant: str, key: str) -> str | None:
    """The run the tenant's Idempotency-Key created, if any."""
    return r.get(f"run:key:{tenant}:{key}")


def bind_key(tenant: str, key: str, run_id: str) -> None:
    """Remember that the tenant's Idempotency-Key created run_id, for its retries."""
    r.set(f"run:key:{tenant}:{key}", run_id)
`,
  'trainsched/queue.py': `"""
${doc(QUEUE_DOC, '')}
"""
import redis

from trainsched.runs import run_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "training:queue"
LEASES_KEY = "training:leases"
BAND_SPAN_MS = 10**13
LEASE_TTL_MS = 15_000

CLAIM_LUA = """
${CLAIM_LUA}
"""
CONFIRM_LUA = """
${CONFIRM_LUA}
"""
REAP_LUA = """
${REAP_LUA}
"""
claim_script = r.register_script(CLAIM_LUA)
confirm_script = r.register_script(CONFIRM_LUA)
reap_script = r.register_script(REAP_LUA)


def lease_key(run_id: str) -> str:
    return f"training:lease:{run_id}"


def position_score(band: int, enqueued_at_ms: int) -> int:
    """Where a run waits: its band first, then its submission time."""
    return band * BAND_SPAN_MS + enqueued_at_ms


def enqueue(run_id: str, band: int, enqueued_at_ms: int) -> None:
    """Put the run in the queue at its position and mark it queued."""
    r.zadd(QUEUE_KEY, {run_id: position_score(band, enqueued_at_ms)})
    r.hset(run_key(run_id), "state", "queued")


def claim_next(worker: str, now_ms: int) -> str | None:
    """Lease the head of the queue to worker; None when the queue is empty."""
    return claim_script(keys=[QUEUE_KEY, LEASES_KEY], args=[worker, LEASE_TTL_MS, now_ms + LEASE_TTL_MS])


def confirm_start(run_id: str, worker: str) -> bool:
    """The worker's process is up: the run is running, if worker still holds its lease."""
    return int(confirm_script(keys=[lease_key(run_id), LEASES_KEY], args=[worker, run_id])) == 1


def reap_expired(now_ms: int) -> int:
    """Put every run whose lease ran out by now_ms back at its position; how many."""
    return int(reap_script(keys=[QUEUE_KEY, LEASES_KEY], args=[now_ms]))
`,
  'trainsched/outbox.py': `"""
The outbox (provided): a Redis list, outbox, of JSON rows {"topic", "key", "payload"} the broker did
not acknowledge; a relay republishes them in order.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take, for the relay."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'trainsched/cluster.py': `"""
The cluster's view (provided): the node agents report which nodes hold each run in the hash
cluster:assignments, run_id -> comma-separated node names. A run the cluster does not know has no
field.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def assignment(run_id: str) -> list[str] | None:
    """The nodes the cluster says hold the run, or None when the cluster has no such run."""
    nodes = r.hget("cluster:assignments", run_id)
    if nodes is None:
        return None
    return [n for n in nodes.split(",") if n]
`,
};

export const supportModulesTs: Record<string, string> = {
  'trainsched/runs.ts': `/**
 * The run store (provided): every training run is a Redis hash run:{run_id} with run_id, tenant,
 * recipe_version, dataset_version, priority, band, state (queued, starting or running),
 * enqueued_at_ms, worker, nodes (comma-separated) and checkpoint_id. run:key:{tenant}:{key} names
 * the run a submission's Idempotency-Key created.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Run {
  run_id: string;
  tenant: string;
  recipe_version: string;
  dataset_version: string;
  priority: number;
  band: number;
  state: string;
  enqueued_at_ms: number;
  worker: string;
  nodes: string[];
  checkpoint_id: string;
}

export const runKey = (runId: string): string => \`run:\${runId}\`;

/** A run id no other submission gets, on this replica or any other: a Redis sequence. */
export async function newRunId(): Promise<string> {
  return \`run-\${await redis.incr('run:seq')}\`;
}

/** Write the whole run row. */
export async function put(run: Run): Promise<void> {
  await redis.hset(runKey(run.run_id), {
    run_id: run.run_id,
    tenant: run.tenant,
    recipe_version: run.recipe_version,
    dataset_version: run.dataset_version,
    priority: String(run.priority),
    band: String(run.band),
    state: run.state,
    enqueued_at_ms: String(run.enqueued_at_ms),
    worker: run.worker,
    nodes: run.nodes.join(','),
    checkpoint_id: run.checkpoint_id,
  });
}

/** The run row, or null. */
export async function get(runId: string): Promise<Run | null> {
  const raw = await redis.hgetall(runKey(runId));
  if (!raw.run_id) return null;
  return {
    run_id: raw.run_id,
    tenant: raw.tenant ?? '',
    recipe_version: raw.recipe_version ?? '',
    dataset_version: raw.dataset_version ?? '',
    priority: Number(raw.priority || 0),
    band: Number(raw.band || 0),
    state: raw.state ?? '',
    enqueued_at_ms: Number(raw.enqueued_at_ms || 0),
    worker: raw.worker ?? '',
    nodes: (raw.nodes ?? '').split(',').filter(n => n !== ''),
    checkpoint_id: raw.checkpoint_id ?? '',
  };
}

/** Record the nodes the worker placed the run on. */
export async function setNodes(runId: string, nodes: string[]): Promise<void> {
  await redis.hset(runKey(runId), 'nodes', nodes.join(','));
}

/** Record the run's latest checkpoint: the point it resumes from. */
export async function setCheckpoint(runId: string, checkpointId: string): Promise<void> {
  await redis.hset(runKey(runId), 'checkpoint_id', checkpointId);
}

/** The run the tenant's Idempotency-Key created, if any. */
export async function runForKey(tenant: string, key: string): Promise<string | null> {
  return redis.get(\`run:key:\${tenant}:\${key}\`);
}

/** Remember that the tenant's Idempotency-Key created runId, for its retries. */
export async function bindKey(tenant: string, key: string, runId: string): Promise<void> {
  await redis.set(\`run:key:\${tenant}:\${key}\`, runId);
}
`,
  'trainsched/queue.ts': `/**
${doc(QUEUE_DOC, ' * ')}
 */
import Redis from 'ioredis';

import {runKey} from 'trainsched/runs';

const redis = new Redis({host: 'redis', port: 6379});

export const QUEUE_KEY = 'training:queue';
export const LEASES_KEY = 'training:leases';
export const BAND_SPAN_MS = 10 ** 13;
export const LEASE_TTL_MS = 15_000;

export const CLAIM_LUA = \`
${CLAIM_LUA}
\`;
export const CONFIRM_LUA = \`
${CONFIRM_LUA}
\`;
export const REAP_LUA = \`
${REAP_LUA}
\`;

export const leaseKey = (runId: string): string => \`training:lease:\${runId}\`;

/** Where a run waits: its band first, then its submission time. */
export const positionScore = (band: number, enqueuedAtMs: number): number => band * BAND_SPAN_MS + enqueuedAtMs;

/** Put the run in the queue at its position and mark it queued. */
export async function enqueue(runId: string, band: number, enqueuedAtMs: number): Promise<void> {
  await redis.zadd(QUEUE_KEY, positionScore(band, enqueuedAtMs), runId);
  await redis.hset(runKey(runId), 'state', 'queued');
}

/** Lease the head of the queue to worker; null when the queue is empty. */
export async function claimNext(worker: string, nowMs: number): Promise<string | null> {
  const id = await redis.eval(CLAIM_LUA, 2, QUEUE_KEY, LEASES_KEY, worker, LEASE_TTL_MS, nowMs + LEASE_TTL_MS);
  return (id as string | null) ?? null;
}

/** The worker's process is up: the run is running, if worker still holds its lease. */
export async function confirmStart(runId: string, worker: string): Promise<boolean> {
  return Number(await redis.eval(CONFIRM_LUA, 2, leaseKey(runId), LEASES_KEY, worker, runId)) === 1;
}

/** Put every run whose lease ran out by nowMs back at its position; how many. */
export async function reapExpired(nowMs: number): Promise<number> {
  return Number(await redis.eval(REAP_LUA, 2, QUEUE_KEY, LEASES_KEY, nowMs));
}
`,
  'trainsched/outbox.ts': `/**
 * The outbox (provided): a Redis list, outbox, of JSON rows {topic, key, payload} the broker did
 * not acknowledge; a relay republishes them in order.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Keep an event the broker did not take, for the relay. */
export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'trainsched/cluster.ts': `/**
 * The cluster's view (provided): the node agents report which nodes hold each run in the hash
 * cluster:assignments, run_id -> comma-separated node names. A run the cluster does not know has no
 * field.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** The nodes the cluster says hold the run, or null when the cluster has no such run. */
export async function assignment(runId: string): Promise<string[] | null> {
  const nodes = await redis.hget('cluster:assignments', runId);
  return nodes === null ? null : nodes.split(',').filter(n => n !== '');
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'trainsched/runs/runs.go': `// Package runs is the run store (provided): every training run is a Redis hash run:{run_id} with
// run_id, tenant, recipe_version, dataset_version, priority, band, state (queued, starting or
// running), enqueued_at_ms, worker, nodes (comma-separated) and checkpoint_id.
// run:key:{tenant}:{key} names the run a submission's Idempotency-Key created.
package runs

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Run is one training run.
type Run struct {
	RunID          string   \`json:"run_id"\`
	Tenant         string   \`json:"tenant"\`
	RecipeVersion  string   \`json:"recipe_version"\`
	DatasetVersion string   \`json:"dataset_version"\`
	Priority       int      \`json:"priority"\`
	Band           int      \`json:"band"\`
	State          string   \`json:"state"\`
	EnqueuedAtMs   int64    \`json:"enqueued_at_ms"\`
	Worker         string   \`json:"worker"\`
	Nodes          []string \`json:"nodes"\`
	CheckpointID   string   \`json:"checkpoint_id"\`
}

// RunKey is the hash of a run.
func RunKey(runID string) string { return "run:" + runID }

// NewRunID is a run id no other submission gets, on this replica or any other: a Redis sequence.
func NewRunID(ctx context.Context) string {
	return fmt.Sprintf("run-%d", rdb.Incr(ctx, "run:seq").Val())
}

// Put writes the whole run row.
func Put(ctx context.Context, run *Run) error {
	return rdb.HSet(ctx, RunKey(run.RunID), map[string]any{
		"run_id":          run.RunID,
		"tenant":          run.Tenant,
		"recipe_version":  run.RecipeVersion,
		"dataset_version": run.DatasetVersion,
		"priority":        strconv.Itoa(run.Priority),
		"band":            strconv.Itoa(run.Band),
		"state":           run.State,
		"enqueued_at_ms":  strconv.FormatInt(run.EnqueuedAtMs, 10),
		"worker":          run.Worker,
		"nodes":           strings.Join(run.Nodes, ","),
		"checkpoint_id":   run.CheckpointID,
	}).Err()
}

// Get is the run row, or nil.
func Get(ctx context.Context, runID string) *Run {
	raw := rdb.HGetAll(ctx, RunKey(runID)).Val()
	if raw["run_id"] == "" {
		return nil
	}
	priority, _ := strconv.Atoi(raw["priority"])
	band, _ := strconv.Atoi(raw["band"])
	at, _ := strconv.ParseInt(raw["enqueued_at_ms"], 10, 64)
	nodes := []string{}
	for _, n := range strings.Split(raw["nodes"], ",") {
		if n != "" {
			nodes = append(nodes, n)
		}
	}
	return &Run{RunID: raw["run_id"], Tenant: raw["tenant"], RecipeVersion: raw["recipe_version"], DatasetVersion: raw["dataset_version"],
		Priority: priority, Band: band, State: raw["state"], EnqueuedAtMs: at, Worker: raw["worker"], Nodes: nodes, CheckpointID: raw["checkpoint_id"]}
}

// SetNodes records the nodes the worker placed the run on.
func SetNodes(ctx context.Context, runID string, nodes []string) error {
	return rdb.HSet(ctx, RunKey(runID), "nodes", strings.Join(nodes, ",")).Err()
}

// SetCheckpoint records the run's latest checkpoint: the point it resumes from.
func SetCheckpoint(ctx context.Context, runID, checkpointID string) error {
	return rdb.HSet(ctx, RunKey(runID), "checkpoint_id", checkpointID).Err()
}

// RunForKey is the run the tenant's Idempotency-Key created, or "".
func RunForKey(ctx context.Context, tenant, key string) string {
	return rdb.Get(ctx, "run:key:"+tenant+":"+key).Val()
}

// BindKey remembers that the tenant's Idempotency-Key created runID, for its retries.
func BindKey(ctx context.Context, tenant, key, runID string) error {
	return rdb.Set(ctx, "run:key:"+tenant+":"+key, runID, 0).Err()
}
`,
  'trainsched/queue/queue.go': `${doc(
    QUEUE_DOC.map((l, i) => (i === 0 ? l.replace('The run queue', 'Package queue is the run queue') : l)),
    '// ',
  )}
package queue

import (
	"context"

	"github.com/redis/go-redis/v9"

	"trainsched/runs"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	QueueKey   = "training:queue"
	LeasesKey  = "training:leases"
	BandSpanMs = int64(10_000_000_000_000)
	LeaseTTLMs = int64(15_000)
)

var claimScript = redis.NewScript(\`
${CLAIM_LUA}
\`)

var confirmScript = redis.NewScript(\`
${CONFIRM_LUA}
\`)

var reapScript = redis.NewScript(\`
${REAP_LUA}
\`)

// LeaseKey holds the worker a run is leased to.
func LeaseKey(runID string) string { return "training:lease:" + runID }

// PositionScore is where a run waits: its band first, then its submission time.
func PositionScore(band int, enqueuedAtMs int64) int64 {
	return int64(band)*BandSpanMs + enqueuedAtMs
}

// Enqueue puts the run in the queue at its position and marks it queued.
func Enqueue(ctx context.Context, runID string, band int, enqueuedAtMs int64) error {
	if err := rdb.ZAdd(ctx, QueueKey, redis.Z{Score: float64(PositionScore(band, enqueuedAtMs)), Member: runID}).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, runs.RunKey(runID), "state", "queued").Err()
}

// ClaimNext leases the head of the queue to worker; "" when the queue is empty.
func ClaimNext(ctx context.Context, worker string, nowMs int64) (string, error) {
	id, err := claimScript.Run(ctx, rdb, []string{QueueKey, LeasesKey}, worker, LeaseTTLMs, nowMs+LeaseTTLMs).Text()
	if err == redis.Nil {
		return "", nil
	}
	return id, err
}

// ConfirmStart: the worker's process is up, the run is running, if worker still holds its lease.
func ConfirmStart(ctx context.Context, runID, worker string) (bool, error) {
	n, err := confirmScript.Run(ctx, rdb, []string{LeaseKey(runID), LeasesKey}, worker, runID).Int()
	return n == 1, err
}

// ReapExpired puts every run whose lease ran out by nowMs back at its position; how many.
func ReapExpired(ctx context.Context, nowMs int64) (int, error) {
	return reapScript.Run(ctx, rdb, []string{QueueKey, LeasesKey}, nowMs).Int()
}
`,
  'trainsched/outbox/outbox.go': `// Package outbox (provided): a Redis list, outbox, of JSON rows {"topic", "key", "payload"} the
// broker did not acknowledge; a relay republishes them in order.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert keeps an event the broker did not take, for the relay.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}
`,
  'trainsched/cluster/cluster.go': `// Package cluster is the cluster's view (provided): the node agents report which nodes hold each run
// in the hash cluster:assignments, run_id -> comma-separated node names. A run the cluster does not
// know has no field.
package cluster

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Assignment is the nodes the cluster says hold the run; known is false when the cluster has no such run.
func Assignment(ctx context.Context, runID string) (nodes []string, known bool) {
	raw, err := rdb.HGet(ctx, "cluster:assignments", runID).Result()
	if err != nil {
		return nil, false
	}
	nodes = []string{}
	for _, n := range strings.Split(raw, ",") {
		if n != "" {
			nodes = append(nodes, n)
		}
	}
	return nodes, true
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'trainsched/runs.h': `// The run store (provided): every training run is a Redis hash run:{run_id} with run_id, tenant,
// recipe_version, dataset_version, priority, band, state (queued, starting or running),
// enqueued_at_ms, worker, nodes (comma-separated) and checkpoint_id. run:key:{tenant}:{key} names
// the run a submission's Idempotency-Key created.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace runs {

struct Run {
  std::string run_id;
  std::string tenant;
  std::string recipe_version;
  std::string dataset_version;
  int priority = 0;
  int band = 0;
  std::string state;
  long long enqueued_at_ms = 0;
  std::string worker;
  std::vector<std::string> nodes;
  std::string checkpoint_id;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string runKey(const std::string& run_id) { return "run:" + run_id; }

inline std::string joinNodes(const std::vector<std::string>& nodes) {
  std::string out;
  for (const auto& n : nodes) out += (out.empty() ? "" : ",") + n;
  return out;
}

inline std::vector<std::string> splitNodes(const std::string& text) {
  std::vector<std::string> out;
  std::string current;
  for (const char c : text + ",") {
    if (c != ',') {
      current += c;
    } else if (!current.empty()) {
      out.push_back(current);
      current.clear();
    }
  }
  return out;
}

// A run id no other submission gets, on this replica or any other: a Redis sequence.
inline std::string newRunId() { return "run-" + std::to_string(redis().incr("run:seq")); }

// Write the whole run row.
inline void put(const Run& run) {
  const std::unordered_map<std::string, std::string> row = {
      {"run_id", run.run_id},
      {"tenant", run.tenant},
      {"recipe_version", run.recipe_version},
      {"dataset_version", run.dataset_version},
      {"priority", std::to_string(run.priority)},
      {"band", std::to_string(run.band)},
      {"state", run.state},
      {"enqueued_at_ms", std::to_string(run.enqueued_at_ms)},
      {"worker", run.worker},
      {"nodes", joinNodes(run.nodes)},
      {"checkpoint_id", run.checkpoint_id}};
  redis().hset(runKey(run.run_id), row.begin(), row.end());
}

// The run row, or none.
inline std::optional<Run> get(const std::string& run_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(runKey(run_id), std::inserter(raw, raw.begin()));
  if (raw["run_id"].empty()) return std::nullopt;
  Run run;
  run.run_id = raw["run_id"];
  run.tenant = raw["tenant"];
  run.recipe_version = raw["recipe_version"];
  run.dataset_version = raw["dataset_version"];
  run.priority = raw["priority"].empty() ? 0 : std::stoi(raw["priority"]);
  run.band = raw["band"].empty() ? 0 : std::stoi(raw["band"]);
  run.state = raw["state"];
  run.enqueued_at_ms = raw["enqueued_at_ms"].empty() ? 0 : std::stoll(raw["enqueued_at_ms"]);
  run.worker = raw["worker"];
  run.nodes = splitNodes(raw["nodes"]);
  run.checkpoint_id = raw["checkpoint_id"];
  return run;
}

// Record the nodes the worker placed the run on.
inline void setNodes(const std::string& run_id, const std::vector<std::string>& nodes) {
  redis().hset(runKey(run_id), "nodes", joinNodes(nodes));
}

// Record the run's latest checkpoint: the point it resumes from.
inline void setCheckpoint(const std::string& run_id, const std::string& checkpoint_id) {
  redis().hset(runKey(run_id), "checkpoint_id", checkpoint_id);
}

// The run the tenant's Idempotency-Key created, if any.
inline std::optional<std::string> runForKey(const std::string& tenant, const std::string& key) {
  const auto run_id = redis().get("run:key:" + tenant + ":" + key);
  if (!run_id) return std::nullopt;
  return *run_id;
}

// Remember that the tenant's Idempotency-Key created run_id, for its retries.
inline void bindKey(const std::string& tenant, const std::string& key, const std::string& run_id) {
  redis().set("run:key:" + tenant + ":" + key, run_id);
}

}  // namespace runs
`,
  'trainsched/queue.h': `${doc(QUEUE_DOC, '// ')}
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "trainsched/runs.h"

namespace queue {

const std::string kQueueKey = "training:queue";
const std::string kLeasesKey = "training:leases";
constexpr long long kBandSpanMs = 10'000'000'000'000LL;
constexpr long long kLeaseTtlMs = 15'000;

inline const std::string kClaimLua = R"lua(
${CLAIM_LUA}
)lua";

inline const std::string kConfirmLua = R"lua(
${CONFIRM_LUA}
)lua";

inline const std::string kReapLua = R"lua(
${REAP_LUA}
)lua";

inline std::string leaseKey(const std::string& run_id) { return "training:lease:" + run_id; }

// Where a run waits: its band first, then its submission time.
inline long long positionScore(int band, long long enqueued_at_ms) { return band * kBandSpanMs + enqueued_at_ms; }

// Put the run in the queue at its position and mark it queued.
inline void enqueue(const std::string& run_id, int band, long long enqueued_at_ms) {
  runs::redis().zadd(kQueueKey, run_id, static_cast<double>(positionScore(band, enqueued_at_ms)));
  runs::redis().hset(runs::runKey(run_id), "state", "queued");
}

// Lease the head of the queue to worker; none when the queue is empty.
inline std::optional<std::string> claimNext(const std::string& worker, long long now_ms) {
  const auto id = runs::redis().eval<sw::redis::OptionalString>(
      kClaimLua, {kQueueKey, kLeasesKey}, {worker, std::to_string(kLeaseTtlMs), std::to_string(now_ms + kLeaseTtlMs)});
  if (!id) return std::nullopt;
  return *id;
}

// The worker's process is up: the run is running, if worker still holds its lease.
inline bool confirmStart(const std::string& run_id, const std::string& worker) {
  return runs::redis().eval<long long>(kConfirmLua, {leaseKey(run_id), kLeasesKey}, {worker, run_id}) == 1;
}

// Put every run whose lease ran out by now_ms back at its position; how many.
inline long long reapExpired(long long now_ms) {
  return runs::redis().eval<long long>(kReapLua, {kQueueKey, kLeasesKey}, {std::to_string(now_ms)});
}

}  // namespace queue
`,
  'trainsched/outbox.h': `// The outbox (provided): a Redis list, outbox, of JSON rows {"topic", "key", "payload"} the broker
// did not acknowledge; a relay republishes them in order.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

#include "trainsched/runs.h"

namespace outbox {

// Keep an event the broker did not take, for the relay.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  runs::redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
  'trainsched/cluster.h': `// The cluster's view (provided): the node agents report which nodes hold each run in the hash
// cluster:assignments, run_id -> comma-separated node names. A run the cluster does not know has no
// field.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "trainsched/runs.h"

namespace cluster {

// The nodes the cluster says hold the run, or none when the cluster has no such run.
inline std::optional<std::vector<std::string>> assignment(const std::string& run_id) {
  const auto nodes = runs::redis().hget("cluster:assignments", run_id);
  if (!nodes) return std::nullopt;
  return runs::splitNodes(*nodes);
}

}  // namespace cluster
`,
};

const scalaLua = (lua: string): string =>
  lua
    .split('\n')
    .map((l, i) => (i === 0 ? l : `      |${l}`))
    .join('\n');

export const supportModulesScala: Record<string, string> = {
  [scalaPath('trainsched', 'Runs')]: `package trainsched

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The run store (provided): every training run is a Redis hash run:{run_id} with run_id, tenant,
 * recipe_version, dataset_version, priority, band, state (queued, starting or running),
 * enqueued_at_ms, worker, nodes (comma-separated) and checkpoint_id. run:key:{tenant}:{key} names
 * the run a submission's Idempotency-Key created.
 */
object Runs {
  final case class Run(
      runId: String,
      tenant: String,
      recipeVersion: String,
      datasetVersion: String,
      priority: Int,
      band: Int,
      state: String,
      enqueuedAtMs: Long,
      worker: String = "",
      nodes: Seq[String] = Nil,
      checkpointId: String = "")

  val jedis = new JedisPooled("redis", 6379)

  def runKey(runId: String): String = s"run:$runId"

  /** A run id no other submission gets, on this replica or any other: a Redis sequence. */
  def newRunId(): String = s"run-\${jedis.incr("run:seq")}"

  /** Write the whole run row. */
  def put(run: Run): Unit =
    jedis.hset(
      runKey(run.runId),
      Map(
        "run_id" -> run.runId,
        "tenant" -> run.tenant,
        "recipe_version" -> run.recipeVersion,
        "dataset_version" -> run.datasetVersion,
        "priority" -> run.priority.toString,
        "band" -> run.band.toString,
        "state" -> run.state,
        "enqueued_at_ms" -> run.enqueuedAtMs.toString,
        "worker" -> run.worker,
        "nodes" -> run.nodes.mkString(","),
        "checkpoint_id" -> run.checkpointId
      ).asJava
    )

  /** The run row, if any. */
  def get(runId: String): Option[Run] = {
    val raw = jedis.hgetAll(runKey(runId)).asScala.toMap.withDefaultValue("")
    if (raw("run_id").isEmpty) None
    else
      Some(
        Run(
          raw("run_id"),
          raw("tenant"),
          raw("recipe_version"),
          raw("dataset_version"),
          raw("priority").toIntOption.getOrElse(0),
          raw("band").toIntOption.getOrElse(0),
          raw("state"),
          raw("enqueued_at_ms").toLongOption.getOrElse(0L),
          raw("worker"),
          raw("nodes").split(",").toSeq.filter(_.nonEmpty),
          raw("checkpoint_id")
        ))
  }

  /** Record the nodes the worker placed the run on. */
  def setNodes(runId: String, nodes: Seq[String]): Unit = jedis.hset(runKey(runId), "nodes", nodes.mkString(","))

  /** Record the run's latest checkpoint: the point it resumes from. */
  def setCheckpoint(runId: String, checkpointId: String): Unit = jedis.hset(runKey(runId), "checkpoint_id", checkpointId)

  /** The run the tenant's Idempotency-Key created, if any. */
  def runForKey(tenant: String, key: String): Option[String] = Option(jedis.get(s"run:key:$tenant:$key"))

  /** Remember that the tenant's Idempotency-Key created runId, for its retries. */
  def bindKey(tenant: String, key: String, runId: String): Unit = jedis.set(s"run:key:$tenant:$key", runId)
}
`,
  [scalaPath('trainsched', 'Queue')]: `package trainsched

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
${doc(QUEUE_DOC, ' * ')}
 */
object Queue {
  val jedis = new JedisPooled("redis", 6379)

  val QueueKey = "training:queue"
  val LeasesKey = "training:leases"
  val BandSpanMs: Long = 10000000000000L
  val LeaseTtlMs: Long = 15000L

  val ClaimLua: String =
    """${scalaLua(CLAIM_LUA)}
      |""".stripMargin

  val ConfirmLua: String =
    """${scalaLua(CONFIRM_LUA)}
      |""".stripMargin

  val ReapLua: String =
    """${scalaLua(REAP_LUA)}
      |""".stripMargin

  def leaseKey(runId: String): String = s"training:lease:$runId"

  /** Where a run waits: its band first, then its submission time. */
  def positionScore(band: Int, enqueuedAtMs: Long): Long = band * BandSpanMs + enqueuedAtMs

  /** Put the run in the queue at its position and mark it queued. */
  def enqueue(runId: String, band: Int, enqueuedAtMs: Long): Unit = {
    jedis.zadd(QueueKey, positionScore(band, enqueuedAtMs).toDouble, runId)
    jedis.hset(Runs.runKey(runId), "state", "queued")
  }

  /** Lease the head of the queue to worker; None when the queue is empty. */
  def claimNext(worker: String, nowMs: Long): Option[String] =
    Option(jedis.eval(ClaimLua, List(QueueKey, LeasesKey).asJava, List(worker, LeaseTtlMs.toString, (nowMs + LeaseTtlMs).toString).asJava))
      .map(_.toString)

  /** The worker's process is up: the run is running, if worker still holds its lease. */
  def confirmStart(runId: String, worker: String): Boolean =
    jedis.eval(ConfirmLua, List(leaseKey(runId), LeasesKey).asJava, List(worker, runId).asJava).asInstanceOf[java.lang.Long] == 1L

  /** Put every run whose lease ran out by nowMs back at its position; how many. */
  def reapExpired(nowMs: Long): Long =
    jedis.eval(ReapLua, List(QueueKey, LeasesKey).asJava, List(nowMs.toString).asJava).asInstanceOf[java.lang.Long]
}
`,
  [scalaPath('trainsched', 'Outbox')]: `package trainsched

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): a Redis list, outbox, of JSON rows {"topic", "key", "payload"} the broker
 * did not acknowledge; a relay republishes them in order.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Keep an event the broker did not take, for the relay. */
  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('trainsched', 'Cluster')]: `package trainsched

import redis.clients.jedis.JedisPooled

/**
 * The cluster's view (provided): the node agents report which nodes hold each run in the hash
 * cluster:assignments, run_id -> comma-separated node names. A run the cluster does not know has no
 * field.
 */
object Cluster {
  val jedis = new JedisPooled("redis", 6379)

  /** The nodes the cluster says hold the run, or None when the cluster has no such run. */
  def assignment(runId: String): Option[Seq[String]] =
    Option(jedis.hget("cluster:assignments", runId)).map(_.split(",").toSeq.filter(_.nonEmpty))
}
`,
};
