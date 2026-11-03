/**
 * Hand-written support modules the batch inference steps import but no step builds: the `batch`
 * package. `config` is the contract every step agrees on (the model server's address, the topic, the
 * shard size and the cap, the lease, the key layout); `jobs` is the batch store; `manifests` reads
 * the input manifest's metadata (the object store's HEAD); `shards` seeds a batch's shard queue;
 * `records` holds the record and shard-result types steps 3 and 4 share; `outputs` writes a shard's
 * output object; `outbox` keeps the events the broker refused; and `model` is the deterministic
 * stand-in the checks serve over gRPC in place of the model server.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'batch/__init__.py': '',
  'batch/config.py': `"""Addresses, topics, sizes and keys every step of batchd agrees on."""
# The model server's gRPC address: a stand-in served by the checks (batch.model).
MODEL_SERVER = "model:9000"
# One event per finished shard, keyed by batch id, for the coordinator.
TOPIC = "batch.shard"
# The coordinator's consumer group.
GROUP = "batch-coordinator"
# Records per shard: a batch of n records has ceil(n / SHARD_SIZE) shards, numbered from 0.
SHARD_SIZE = 1_000
# The most records one batch may hold.
MAX_RECORDS = 1_000_000
# How long a claimed shard stays a worker's without a heartbeat.
LEASE_S = 30

# A batch's keys in Redis. pending: a list of shard ids waiting for a worker. owners: a hash, shard
# id -> the worker holding its lease. deadlines: a sorted set, shard id scored by the unix second its
# lease runs out. shards: a hash, shard id -> pending | running | done | failed (the live shard set).
# outputs: a hash, shard id -> the folded output entry (JSON: uri, checksum, completed, failed).
# totals: a hash of the folded record counts (completed, failed).


def pending_key(batch_id: str) -> str:
    return f"batch:pending:{batch_id}"


def owners_key(batch_id: str) -> str:
    return f"batch:owners:{batch_id}"


def deadlines_key(batch_id: str) -> str:
    return f"batch:deadlines:{batch_id}"


def shards_key(batch_id: str) -> str:
    return f"batch:shards:{batch_id}"


def outputs_key(batch_id: str) -> str:
    return f"batch:outputs:{batch_id}"


def totals_key(batch_id: str) -> str:
    return f"batch:totals:{batch_id}"
`,
  'batch/jobs.py': `"""The batch store (provided): batches in Redis, keyed by id and by (tenant, Idempotency-Key)."""
import json

import redis

JOB_TTL_S = 7 * 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class JobStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The batch this tenant submitted under idem_key, if any."""
        batch_id = r.get(f"batch:idem:{tenant}:{idem_key}")
        return self.by_id(batch_id) if batch_id else None

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the batch under its id and under (tenant, idem_key); the row carries the tenant."""
        row = dict(job, tenant=tenant)
        r.set(f"batch:job:{job['batch_id']}", json.dumps(row), ex=JOB_TTL_S)
        r.set(f"batch:idem:{tenant}:{idem_key}", job["batch_id"], ex=JOB_TTL_S)

    def by_id(self, batch_id: str) -> dict | None:
        """The batch row (the batch plus its tenant), None when there is none."""
        raw = r.get(f"batch:job:{batch_id}")
        return json.loads(raw) if raw else None


store = JobStore()
`,
  'batch/manifests.py': `"""The input manifests (provided): the object store's metadata for a manifest, read with a HEAD."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def head(uri: str) -> dict | None:
    """{"record_count", "sealed"} for the manifest at uri, None when there is no object there.

    An upload in progress is visible with the records written so far and sealed False; the uploader
    seals the manifest when its last part lands.
    """
    meta = r.hgetall(f"batch:manifest:{uri}")
    if not meta:
        return None
    return {"record_count": int(meta["record_count"]), "sealed": meta.get("sealed") == "1"}


def put(uri: str, record_count: int, sealed: bool) -> None:
    """What the uploader writes: the records so far and whether the manifest is sealed."""
    r.hset(f"batch:manifest:{uri}", mapping={"record_count": record_count, "sealed": "1" if sealed else "0"})
`,
  'batch/shards.py': `"""The shard queue's seed (provided): a new batch's shards, all pending."""
import redis

from batch.config import pending_key, shards_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def seed(batch_id: str, shard_count: int) -> None:
    """Queue shards 0..shard_count-1 on the pending list and mark each pending in the shard set."""
    if shard_count <= 0:
        return
    ids = [str(i) for i in range(shard_count)]
    pipe = r.pipeline()
    pipe.rpush(pending_key(batch_id), *ids)
    pipe.hset(shards_key(batch_id), mapping={i: "pending" for i in ids})
    pipe.execute()
`,
  'batch/records.py': `"""The record and the shard result (provided): what a worker runs and what it hands to publish."""
from dataclasses import dataclass, field


@dataclass
class Record:
    record_id: str
    input: str


@dataclass
class Output:
    record_id: str
    output: str
    model: str  # the model version that answered


@dataclass
class RecordError:
    record_id: str
    reason: str  # the gRPC status name in lower case: unavailable, deadline, invalid_argument, ...


@dataclass
class ShardResult:
    batch_id: str
    shard_id: int
    model: str  # the model version the batch was submitted with
    completed: int = 0
    failed: int = 0
    outputs: list[Output] = field(default_factory=list)
    errors: list[RecordError] = field(default_factory=list)
`,
  'batch/outputs.py': `"""The output objects (provided): one JSONL object per shard in the object store."""
import hashlib
import json

import redis

from batch.records import ShardResult

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def output_uri(batch_id: str, shard_id: int) -> str:
    return f"s3://batch-outputs/{batch_id}/shard-{shard_id:05d}.jsonl"


def write(result: ShardResult) -> dict:
    """Write the shard's outputs and errors as one JSONL object; {"uri", "checksum"} once it is stored.

    The checksum is the SHA-256 (hex) of the object's bytes.
    """
    lines = [json.dumps({"record_id": o.record_id, "output": o.output, "model": o.model}) for o in result.outputs]
    lines += [json.dumps({"record_id": e.record_id, "error": e.reason}) for e in result.errors]
    body = "".join(line + "\\n" for line in lines)
    uri = output_uri(result.batch_id, result.shard_id)
    r.set(f"batch:object:{uri}", body)
    return {"uri": uri, "checksum": hashlib.sha256(body.encode("utf-8")).hexdigest()}
`,
  'batch/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "batch:outbox"


def insert(event: dict) -> None:
    """Durably keep an event the broker refused."""
    r.rpush(OUTBOX_KEY, json.dumps(event))


def rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]
`,
  'batch/model.py': `"""
The stand-in for the model server. The checks serve it over gRPC (Model.Infer at
batch.config.MODEL_SERVER); the pipeline's code never calls it directly. Deterministic on purpose:
the course grades what the worker does around the model, never the prose.

infer(model, text) -> (output, model_used):
  model_used is the requested version, or LATEST when the request names none
  the output is one line that names the version and quotes the input
is_poison(text): an input starting with "poison:" is one the model cannot parse; the server answers
  INVALID_ARGUMENT for it, every time.
"""
LATEST = "sum-v8"


def is_poison(text: str) -> bool:
    return text.startswith("poison:")


def infer(model: str, text: str) -> tuple[str, str]:
    used = model or LATEST
    return f"summary[{used}]: {text.strip()}", used
`,
};

export const supportModulesTs: Record<string, string> = {
  'batch/config.ts': `/** Addresses, topics, sizes and keys every step of batchd agrees on. */
/** The model server's gRPC address: a stand-in served by the checks (batch/model). */
export const MODEL_SERVER = 'model:9000';
/** One event per finished shard, keyed by batch id, for the coordinator. */
export const TOPIC = 'batch.shard';
/** The coordinator's consumer group. */
export const GROUP = 'batch-coordinator';
/** Records per shard: a batch of n records has ceil(n / SHARD_SIZE) shards, numbered from 0. */
export const SHARD_SIZE = 1_000;
/** The most records one batch may hold. */
export const MAX_RECORDS = 1_000_000;
/** How long a claimed shard stays a worker's without a heartbeat. */
export const LEASE_S = 30;

// A batch's keys in Redis. pending: a list of shard ids waiting for a worker. owners: a hash, shard
// id -> the worker holding its lease. deadlines: a sorted set, shard id scored by the unix second its
// lease runs out. shards: a hash, shard id -> pending | running | done | failed (the live shard set).
// outputs: a hash, shard id -> the folded output entry (JSON: uri, checksum, completed, failed).
// totals: a hash of the folded record counts (completed, failed).
export const pendingKey = (batchId: string): string => \`batch:pending:\${batchId}\`;
export const ownersKey = (batchId: string): string => \`batch:owners:\${batchId}\`;
export const deadlinesKey = (batchId: string): string => \`batch:deadlines:\${batchId}\`;
export const shardsKey = (batchId: string): string => \`batch:shards:\${batchId}\`;
export const outputsKey = (batchId: string): string => \`batch:outputs:\${batchId}\`;
export const totalsKey = (batchId: string): string => \`batch:totals:\${batchId}\`;
`,
  'batch/jobs.ts': `/** The batch store (provided): batches in Redis, keyed by id and by (tenant, Idempotency-Key). */
import Redis from 'ioredis';

export const JOB_TTL_S = 7 * 86_400;

const redis = new Redis({host: 'redis', port: 6379});

export interface Job {
  batch_id: string;
  status: string;
  model: string;
  manifest_uri: string;
  record_count: number;
  shards: number;
}

/** A stored batch: the batch plus the tenant that submitted it. */
export interface JobRow extends Job {
  tenant: string;
}

export const store = {
  /** The batch this tenant submitted under idemKey, if any. */
  async get(tenant: string, idemKey: string): Promise<JobRow | null> {
    const batchId = await redis.get(\`batch:idem:\${tenant}:\${idemKey}\`);
    return batchId === null ? null : store.byId(batchId);
  },

  /** Store the batch under its id and under (tenant, idemKey); the row carries the tenant. */
  async put(tenant: string, idemKey: string, job: Job): Promise<void> {
    const row: JobRow = {...job, tenant};
    await redis.set(\`batch:job:\${job.batch_id}\`, JSON.stringify(row), 'EX', JOB_TTL_S);
    await redis.set(\`batch:idem:\${tenant}:\${idemKey}\`, job.batch_id, 'EX', JOB_TTL_S);
  },

  /** The batch row, null when there is none. */
  async byId(batchId: string): Promise<JobRow | null> {
    const raw = await redis.get(\`batch:job:\${batchId}\`);
    return raw === null ? null : (JSON.parse(raw) as JobRow);
  },
};
`,
  'batch/manifests.ts': `/** The input manifests (provided): the object store's metadata for a manifest, read with a HEAD. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface ManifestHead {
  record_count: number;
  /** An upload in progress is visible with the records so far and sealed false; the uploader seals it when its last part lands. */
  sealed: boolean;
}

export const manifests = {
  /** The manifest's metadata, null when there is no object at uri. */
  async head(uri: string): Promise<ManifestHead | null> {
    const meta = await redis.hgetall(\`batch:manifest:\${uri}\`);
    if (Object.keys(meta).length === 0) return null;
    return {record_count: Number(meta.record_count), sealed: meta.sealed === '1'};
  },

  /** What the uploader writes: the records so far and whether the manifest is sealed. */
  async put(uri: string, recordCount: number, sealed: boolean): Promise<void> {
    await redis.hset(\`batch:manifest:\${uri}\`, {record_count: recordCount, sealed: sealed ? '1' : '0'});
  },
};
`,
  'batch/shards.ts': `/** The shard queue's seed (provided): a new batch's shards, all pending. */
import Redis from 'ioredis';

import {pendingKey, shardsKey} from 'batch/config';

const redis = new Redis({host: 'redis', port: 6379});

export const shards = {
  /** Queue shards 0..shardCount-1 on the pending list and mark each pending in the shard set. */
  async seed(batchId: string, shardCount: number): Promise<void> {
    if (shardCount <= 0) return;
    const ids = Array.from({length: shardCount}, (_, i) => String(i));
    await redis.rpush(pendingKey(batchId), ...ids);
    await redis.hset(shardsKey(batchId), Object.fromEntries(ids.map(id => [id, 'pending'])));
  },
};
`,
  'batch/records.ts': `/** The record and the shard result (provided): what a worker runs and what it hands to publish. */
export interface Record {
  record_id: string;
  input: string;
}

export interface Output {
  record_id: string;
  output: string;
  /** The model version that answered. */
  model: string;
}

export interface RecordError {
  record_id: string;
  /** The gRPC status name in lower case: unavailable, deadline, invalid_argument, ... */
  reason: string;
}

export interface ShardResult {
  batch_id: string;
  shard_id: number;
  /** The model version the batch was submitted with. */
  model: string;
  completed: number;
  failed: number;
  outputs: Output[];
  errors: RecordError[];
}
`,
  'batch/outputs.ts': `/** The output objects (provided): one JSONL object per shard in the object store. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import type {ShardResult} from 'batch/records';

const redis = new Redis({host: 'redis', port: 6379});

export const outputUri = (batchId: string, shardId: number): string =>
  \`s3://batch-outputs/\${batchId}/shard-\${String(shardId).padStart(5, '0')}.jsonl\`;

export const outputs = {
  /** Write the shard's outputs and errors as one JSONL object; {uri, checksum} (SHA-256 hex of the bytes) once it is stored. */
  async write(result: ShardResult): Promise<{uri: string; checksum: string}> {
    const lines = [
      ...result.outputs.map(o => JSON.stringify({record_id: o.record_id, output: o.output, model: o.model})),
      ...result.errors.map(e => JSON.stringify({record_id: e.record_id, error: e.reason})),
    ];
    const body = lines.map(line => line + '\\n').join('');
    const uri = outputUri(result.batch_id, result.shard_id);
    await redis.set(\`batch:object:\${uri}\`, body);
    return {uri, checksum: createHash('sha256').update(body).digest('hex')};
  },
};
`,
  'batch/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'batch:outbox';

export const outbox = {
  /** Durably keep an event the broker refused. */
  async insert(event: object): Promise<void> {
    await redis.rpush(OUTBOX_KEY, JSON.stringify(event));
  },

  async rows(): Promise<Record<string, unknown>[]> {
    return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as Record<string, unknown>);
  },
};
`,
  'batch/model.ts': `/**
 * The stand-in for the model server. The checks serve it over gRPC (Model.Infer at batch/config's
 * MODEL_SERVER); the pipeline's code never calls it directly. Deterministic on purpose: the course
 * grades what the worker does around the model, never the prose.
 *
 * infer(model, text) → {output, model}: the requested version answers, or LATEST when the request
 * names none; the output is one line that names the version and quotes the input.
 * isPoison(text): an input starting with "poison:" is one the model cannot parse; the server answers
 * INVALID_ARGUMENT for it, every time.
 */
export const LATEST = 'sum-v8';

export function isPoison(text: string): boolean {
  return text.startsWith('poison:');
}

export function infer(model: string, text: string): {output: string; model: string} {
  const used = model || LATEST;
  return {output: \`summary[\${used}]: \${text.trim()}\`, model: used};
}
`,
};

/** The Go twins: the same \`batch\` packages, imported as batch/config, batch/jobs, batch/manifests, … */
export const supportModulesGo: Record<string, string> = {
  'batch/config/config.go': `// Package config holds the addresses, topics, sizes and keys every step of batchd agrees on.
package config

const (
	// ModelServer is the model server's gRPC address: a stand-in served by the checks (batch/model).
	ModelServer = "model:9000"
	// Topic carries one event per finished shard, keyed by batch id, for the coordinator.
	Topic = "batch.shard"
	// Group is the coordinator's consumer group.
	Group = "batch-coordinator"
	// ShardSize is the records per shard: a batch of n records has ceil(n / ShardSize) shards, numbered from 0.
	ShardSize = 1_000
	// MaxRecords is the most records one batch may hold.
	MaxRecords = 1_000_000
	// LeaseSeconds is how long a claimed shard stays a worker's without a heartbeat.
	LeaseSeconds = 30
)

// A batch's keys in Redis. pending: a list of shard ids waiting for a worker. owners: a hash, shard
// id -> the worker holding its lease. deadlines: a sorted set, shard id scored by the unix second its
// lease runs out. shards: a hash, shard id -> pending | running | done | failed (the live shard set).
// outputs: a hash, shard id -> the folded output entry (JSON: uri, checksum, completed, failed).
// totals: a hash of the folded record counts (completed, failed).

func PendingKey(batchID string) string   { return "batch:pending:" + batchID }
func OwnersKey(batchID string) string    { return "batch:owners:" + batchID }
func DeadlinesKey(batchID string) string { return "batch:deadlines:" + batchID }
func ShardsKey(batchID string) string    { return "batch:shards:" + batchID }
func OutputsKey(batchID string) string   { return "batch:outputs:" + batchID }
func TotalsKey(batchID string) string    { return "batch:totals:" + batchID }
`,
  'batch/jobs/jobs.go': `// Package jobs is the batch store (provided): batches in Redis, keyed by id and by (tenant, Idempotency-Key).
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const JobTTL = 7 * 86_400 * time.Second

// Job is a batch as the API answers it.
type Job struct {
	BatchID     string \`json:"batch_id"\`
	Status      string \`json:"status"\`
	Model       string \`json:"model"\`
	ManifestURI string \`json:"manifest_uri"\`
	RecordCount int    \`json:"record_count"\`
	Shards      int    \`json:"shards"\`
	// Tenant is set on the stored row: the tenant that submitted the batch.
	Tenant string \`json:"tenant,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the batch tenant submitted under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Job, error) {
	batchID, err := rdb.Get(ctx, "batch:idem:"+tenant+":"+idemKey).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ByID(ctx, batchID)
}

// Put stores the batch under its id and under (tenant, idemKey); the row carries the tenant.
func Put(ctx context.Context, tenant, idemKey string, job Job) error {
	job.Tenant = tenant
	doc, err := json.Marshal(job)
	if err != nil {
		return err
	}
	if err := rdb.Set(ctx, "batch:job:"+job.BatchID, doc, JobTTL).Err(); err != nil {
		return err
	}
	return rdb.Set(ctx, "batch:idem:"+tenant+":"+idemKey, job.BatchID, JobTTL).Err()
}

// ByID is the batch row; nil when there is none.
func ByID(ctx context.Context, batchID string) (*Job, error) {
	raw, err := rdb.Get(ctx, "batch:job:"+batchID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, err
	}
	return &job, nil
}
`,
  'batch/manifests/manifests.go': `// Package manifests reads the input manifests (provided): the object store's metadata for a
// manifest, read with a HEAD.
package manifests

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// Meta is a manifest's metadata. An upload in progress is visible with the records written so far
// and Sealed false; the uploader seals the manifest when its last part lands.
type Meta struct {
	RecordCount int
	Sealed      bool
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Head is the manifest's metadata; nil when there is no object at uri.
func Head(ctx context.Context, uri string) (*Meta, error) {
	meta, err := rdb.HGetAll(ctx, "batch:manifest:"+uri).Result()
	if err != nil {
		return nil, err
	}
	if len(meta) == 0 {
		return nil, nil
	}
	count, _ := strconv.Atoi(meta["record_count"])
	return &Meta{RecordCount: count, Sealed: meta["sealed"] == "1"}, nil
}

// Put is what the uploader writes: the records so far and whether the manifest is sealed.
func Put(ctx context.Context, uri string, recordCount int, sealed bool) error {
	flag := "0"
	if sealed {
		flag = "1"
	}
	return rdb.HSet(ctx, "batch:manifest:"+uri, "record_count", recordCount, "sealed", flag).Err()
}
`,
  'batch/shards/shards.go': `// Package shards seeds a batch's shard queue (provided): a new batch's shards, all pending.
package shards

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"batch/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Seed queues shards 0..shardCount-1 on the pending list and marks each pending in the shard set.
func Seed(ctx context.Context, batchID string, shardCount int) error {
	if shardCount <= 0 {
		return nil
	}
	ids := make([]any, 0, shardCount)
	states := make([]any, 0, 2*shardCount)
	for i := 0; i < shardCount; i++ {
		id := strconv.Itoa(i)
		ids = append(ids, id)
		states = append(states, id, "pending")
	}
	if err := rdb.RPush(ctx, config.PendingKey(batchID), ids...).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, config.ShardsKey(batchID), states...).Err()
}
`,
  'batch/records/records.go': `// Package records holds the record and the shard result (provided): what a worker runs and what it
// hands to publish.
package records

type Record struct {
	RecordID string
	Input    string
}

type Output struct {
	RecordID string
	Output   string
	Model    string // the model version that answered
}

type RecordError struct {
	RecordID string
	Reason   string // the gRPC status name in lower case: unavailable, deadline, invalid_argument, ...
}

type ShardResult struct {
	BatchID   string
	ShardID   int
	Model     string // the model version the batch was submitted with
	Completed int
	Failed    int
	Outputs   []Output
	Errors    []RecordError
}
`,
  'batch/outputs/outputs.go': `// Package outputs writes the output objects (provided): one JSONL object per shard in the object store.
package outputs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"

	"batch/records"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Object is a stored output: where it is and the SHA-256 (hex) of its bytes.
type Object struct {
	URI      string
	Checksum string
}

func URI(batchID string, shardID int) string {
	return fmt.Sprintf("s3://batch-outputs/%s/shard-%05d.jsonl", batchID, shardID)
}

// Write stores the shard's outputs and errors as one JSONL object.
func Write(ctx context.Context, result records.ShardResult) (Object, error) {
	var body strings.Builder
	for _, o := range result.Outputs {
		line, _ := json.Marshal(map[string]string{"record_id": o.RecordID, "output": o.Output, "model": o.Model})
		body.Write(line)
		body.WriteString("\\n")
	}
	for _, e := range result.Errors {
		line, _ := json.Marshal(map[string]string{"record_id": e.RecordID, "error": e.Reason})
		body.Write(line)
		body.WriteString("\\n")
	}
	uri := URI(result.BatchID, result.ShardID)
	if err := rdb.Set(ctx, "batch:object:"+uri, body.String(), 0).Err(); err != nil {
		return Object{}, err
	}
	sum := sha256.Sum256([]byte(body.String()))
	return Object{URI: uri, Checksum: hex.EncodeToString(sum[:])}, nil
}
`,
  'batch/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "batch:outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert durably keeps an event the broker refused (the event's JSON).
func Insert(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, Key, event).Err()
}

// Rows are the kept events, decoded, oldest first.
func Rows(ctx context.Context) ([]map[string]any, error) {
	raw, err := rdb.LRange(ctx, Key, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		var row map[string]any
		if err := json.Unmarshal([]byte(r), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
  'batch/model/model.go': `// Package model is the stand-in for the model server. The checks serve it over gRPC (Model.Infer at
// config.ModelServer); the pipeline's code never calls it directly. Deterministic on purpose: the
// course grades what the worker does around the model, never the prose.
//
// Infer(model, text) → (output, modelUsed): the requested version answers, or Latest when the
// request names none; the output is one line that names the version and quotes the input.
// IsPoison(text): an input starting with "poison:" is one the model cannot parse; the server answers
// INVALID_ARGUMENT for it, every time.
package model

import "strings"

const Latest = "sum-v8"

func IsPoison(text string) bool { return strings.HasPrefix(text, "poison:") }

func Infer(model, text string) (output, used string) {
	used = model
	if used == "" {
		used = Latest
	}
	return "summary[" + used + "]: " + strings.TrimSpace(text), used
}
`,
};

/** The C++ twins as headers (batch/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'batch/config.h': `// Addresses, topics, sizes and keys every step of batchd agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The model server's gRPC address: a stand-in served by the checks (batch/model.h).
inline constexpr const char* kModelServer = "model:9000";
// One event per finished shard, keyed by batch id, for the coordinator.
inline constexpr const char* kTopic = "batch.shard";
// The coordinator's consumer group.
inline constexpr const char* kGroup = "batch-coordinator";
// Records per shard: a batch of n records has ceil(n / kShardSize) shards, numbered from 0.
inline constexpr long long kShardSize = 1000;
// The most records one batch may hold.
inline constexpr long long kMaxRecords = 1000000;
// How long a claimed shard stays a worker's without a heartbeat.
inline constexpr long long kLeaseSeconds = 30;

// A batch's keys in Redis. pending: a list of shard ids waiting for a worker. owners: a hash, shard
// id -> the worker holding its lease. deadlines: a sorted set, shard id scored by the unix second its
// lease runs out. shards: a hash, shard id -> pending | running | done | failed (the live shard set).
// outputs: a hash, shard id -> the folded output entry (JSON: uri, checksum, completed, failed).
// totals: a hash of the folded record counts (completed, failed).
inline std::string pending_key(const std::string& batch_id) { return "batch:pending:" + batch_id; }
inline std::string owners_key(const std::string& batch_id) { return "batch:owners:" + batch_id; }
inline std::string deadlines_key(const std::string& batch_id) { return "batch:deadlines:" + batch_id; }
inline std::string shards_key(const std::string& batch_id) { return "batch:shards:" + batch_id; }
inline std::string outputs_key(const std::string& batch_id) { return "batch:outputs:" + batch_id; }
inline std::string totals_key(const std::string& batch_id) { return "batch:totals:" + batch_id; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'batch/jobs.h': `// The batch store (provided): batches in Redis, keyed by id and by (tenant, Idempotency-Key).
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "batch/config.h"

namespace jobs {

inline constexpr long long kJobTtlSeconds = 7 * 86400;

// The batch row (the batch plus its tenant), if there is one.
inline std::optional<nlohmann::json> by_id(const std::string& batch_id) {
  const auto raw = config::redis().get("batch:job:" + batch_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The batch tenant submitted under idem_key, if any.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto batch_id = config::redis().get("batch:idem:" + tenant + ":" + idem_key);
  if (!batch_id) return std::nullopt;
  return by_id(*batch_id);
}

// Store the batch under its id and under (tenant, idem_key); the row carries the tenant.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& job) {
  nlohmann::json row = job;
  row["tenant"] = tenant;
  const std::string batch_id = job.at("batch_id").get<std::string>();
  config::redis().set("batch:job:" + batch_id, row.dump(), std::chrono::seconds(kJobTtlSeconds));
  config::redis().set("batch:idem:" + tenant + ":" + idem_key, batch_id, std::chrono::seconds(kJobTtlSeconds));
}

}  // namespace jobs
`,
  'batch/manifests.h': `// The input manifests (provided): the object store's metadata for a manifest, read with a HEAD.
#pragma once

#include <optional>
#include <string>
#include <unordered_map>

#include "batch/config.h"

namespace manifests {

// A manifest's metadata. An upload in progress is visible with the records written so far and
// sealed false; the uploader seals the manifest when its last part lands.
struct Head {
  long long record_count = 0;
  bool sealed = false;
};

// The manifest's metadata; nullopt when there is no object at uri.
inline std::optional<Head> head(const std::string& uri) {
  std::unordered_map<std::string, std::string> meta;
  config::redis().hgetall("batch:manifest:" + uri, std::inserter(meta, meta.begin()));
  if (meta.empty()) return std::nullopt;
  return Head{std::stoll(meta["record_count"]), meta["sealed"] == "1"};
}

// What the uploader writes: the records so far and whether the manifest is sealed.
inline void put(const std::string& uri, long long record_count, bool sealed) {
  config::redis().hset("batch:manifest:" + uri, "record_count", std::to_string(record_count));
  config::redis().hset("batch:manifest:" + uri, "sealed", sealed ? "1" : "0");
}

}  // namespace manifests
`,
  'batch/shards.h': `// The shard queue's seed (provided): a new batch's shards, all pending.
#pragma once

#include <string>
#include <vector>

#include "batch/config.h"

namespace shards {

// Queue shards 0..shard_count-1 on the pending list and mark each pending in the shard set.
inline void seed(const std::string& batch_id, long long shard_count) {
  if (shard_count <= 0) return;
  std::vector<std::string> ids;
  std::vector<std::pair<std::string, std::string>> states;
  for (long long i = 0; i < shard_count; i++) {
    ids.push_back(std::to_string(i));
    states.emplace_back(std::to_string(i), "pending");
  }
  config::redis().rpush(config::pending_key(batch_id), ids.begin(), ids.end());
  config::redis().hset(config::shards_key(batch_id), states.begin(), states.end());
}

}  // namespace shards
`,
  'batch/records.h': `// The record and the shard result (provided): what a worker runs and what it hands to publish.
#pragma once

#include <string>
#include <vector>

namespace records {

struct Record {
  std::string record_id;
  std::string input;
};

struct Output {
  std::string record_id;
  std::string output;
  std::string model;  // the model version that answered
};

struct RecordError {
  std::string record_id;
  std::string reason;  // the gRPC status name in lower case: unavailable, deadline, invalid_argument, ...
};

struct ShardResult {
  std::string batch_id;
  int shard_id = 0;
  std::string model;  // the model version the batch was submitted with
  int completed = 0;
  int failed = 0;
  std::vector<Output> outputs;
  std::vector<RecordError> errors;
};

}  // namespace records
`,
  'batch/outputs.h': `// The output objects (provided): one JSONL object per shard in the object store.
#pragma once

#include <cstdio>
#include <string>

#include <nlohmann/json.hpp>

#include "batch/config.h"
#include "batch/records.h"
#include "digest.h"

namespace outputs {

// A stored output: where it is and the SHA-256 (hex) of its bytes.
struct Object {
  std::string uri;
  std::string checksum;
};

inline std::string uri(const std::string& batch_id, int shard_id) {
  char shard[16];
  std::snprintf(shard, sizeof shard, "%05d", shard_id);
  return "s3://batch-outputs/" + batch_id + "/shard-" + shard + ".jsonl";
}

// Write the shard's outputs and errors as one JSONL object.
inline Object write(const records::ShardResult& result) {
  std::string body;
  for (const auto& o : result.outputs)
    body += nlohmann::json{{"record_id", o.record_id}, {"output", o.output}, {"model", o.model}}.dump() + "\\n";
  for (const auto& e : result.errors) body += nlohmann::json{{"record_id", e.record_id}, {"error", e.reason}}.dump() + "\\n";
  const std::string where = uri(result.batch_id, result.shard_id);
  config::redis().set("batch:object:" + where, body);
  return {where, sha256_hex(body)};
}

}  // namespace outputs
`,
  'batch/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "batch/config.h"

namespace outbox {

inline constexpr const char* kKey = "batch:outbox";

// Durably keep an event the broker refused (its JSON).
inline void insert(const std::string& event_json) { config::redis().rpush(kKey, event_json); }

// The kept events, decoded, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<std::string> raw;
  config::redis().lrange(kKey, 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> out;
  for (const auto& row : raw) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'batch/model.h': `// The stand-in for the model server. The checks serve it over gRPC (Model.Infer at
// config::kModelServer); the pipeline's code never calls it directly. Deterministic on purpose: the
// course grades what the worker does around the model, never the prose.
//
// infer(model, text) -> {output, model}: the requested version answers, or kLatest when the request
// names none; the output is one line that names the version and quotes the input.
// is_poison(text): an input starting with "poison:" is one the model cannot parse; the server answers
// INVALID_ARGUMENT for it, every time.
#pragma once

#include <string>

namespace model {

inline constexpr const char* kLatest = "sum-v8";

struct Answer {
  std::string output;
  std::string model;
};

inline std::string trim(const std::string& s) {
  const size_t start = s.find_first_not_of(" \\t\\r\\n");
  if (start == std::string::npos) return "";
  return s.substr(start, s.find_last_not_of(" \\t\\r\\n") - start + 1);
}

inline bool is_poison(const std::string& text) { return text.rfind("poison:", 0) == 0; }

inline Answer infer(const std::string& model, const std::string& text) {
  const std::string used = model.empty() ? kLatest : model;
  return {"summary[" + used + "]: " + trim(text), used};
}

}  // namespace model
`,
};

/** The Scala twins: the same \`batch\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('batch', 'Config')]: `package batch

/** Addresses, topics, sizes and keys every step of batchd agrees on. */
object Config {
  /** The model server's gRPC address: a stand-in served by the checks. */
  val ModelServer = "model:9000"
  /** One event per finished shard, keyed by batch id, for the coordinator. */
  val Topic = "batch.shard"
  /** The coordinator's consumer group. */
  val Group = "batch-coordinator"
  /** Records per shard: a batch of n records has ceil(n / ShardSize) shards, numbered from 0. */
  val ShardSize = 1000L
  /** The most records one batch may hold. */
  val MaxRecords = 1000000L
  /** How long a claimed shard stays a worker's without a heartbeat. */
  val LeaseSeconds = 30L

  // A batch's keys in Redis. pending: a list of shard ids waiting for a worker. owners: a hash, shard
  // id -> the worker holding its lease. deadlines: a sorted set, shard id scored by the unix second its
  // lease runs out. shards: a hash, shard id -> pending | running | done | failed (the live shard set).
  // outputs: a hash, shard id -> the folded output entry (JSON: uri, checksum, completed, failed).
  // totals: a hash of the folded record counts (completed, failed).
  def pendingKey(batchId: String): String = s"batch:pending:$batchId"
  def ownersKey(batchId: String): String = s"batch:owners:$batchId"
  def deadlinesKey(batchId: String): String = s"batch:deadlines:$batchId"
  def shardsKey(batchId: String): String = s"batch:shards:$batchId"
  def outputsKey(batchId: String): String = s"batch:outputs:$batchId"
  def totalsKey(batchId: String): String = s"batch:totals:$batchId"
}
`,
  [scalaPath('batch', 'Jobs')]: `package batch

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** A batch as the API answers it. */
final case class Job(
    batch_id: String,
    status: String,
    model: String,
    manifest_uri: String,
    record_count: Long,
    shards: Long
)

/** A stored batch: the batch plus the tenant that submitted it. */
final case class JobRow(job: Job, tenant: String)

/** The batch store (provided): batches in Redis, keyed by id and by (tenant, Idempotency-Key). */
object Jobs {
  val JobTtlSeconds: Long = 7L * 86400
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(row: JobRow): String = ujson.write(
    ujson.Obj(
      "batch_id" -> row.job.batch_id,
      "status" -> row.job.status,
      "model" -> row.job.model,
      "manifest_uri" -> row.job.manifest_uri,
      "record_count" -> row.job.record_count.toDouble,
      "shards" -> row.job.shards.toDouble,
      "tenant" -> row.tenant
    )
  )

  private def decode(raw: String): JobRow = {
    val j = ujson.read(raw)
    JobRow(
      Job(j("batch_id").str, j("status").str, j("model").str, j("manifest_uri").str, j("record_count").num.toLong, j("shards").num.toLong),
      j("tenant").str
    )
  }

  /** The batch this tenant submitted under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[JobRow] =
    Option(jedis.get(s"batch:idem:$tenant:$idemKey")).flatMap(byId)

  /** Store the batch under its id and under (tenant, idemKey); the row carries the tenant. */
  def put(tenant: String, idemKey: String, job: Job): Unit = {
    jedis.set(s"batch:job:\${job.batch_id}", encode(JobRow(job, tenant)), SetParams.setParams().ex(JobTtlSeconds))
    jedis.set(s"batch:idem:$tenant:$idemKey", job.batch_id, SetParams.setParams().ex(JobTtlSeconds))
  }

  /** The batch row, None when there is none. */
  def byId(batchId: String): Option[JobRow] = Option(jedis.get(s"batch:job:$batchId")).map(decode)
}
`,
  [scalaPath('batch', 'Manifests')]: `package batch

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * A manifest's metadata. An upload in progress is visible with the records written so far and
 * isSealed false (sealed is a Scala keyword); the uploader seals the manifest when its last part lands.
 */
final case class ManifestHead(record_count: Long, isSealed: Boolean)

/** The input manifests (provided): the object store's metadata for a manifest, read with a HEAD. */
object Manifests {
  private val jedis = new JedisPooled("redis", 6379)

  /** The manifest's metadata, None when there is no object at uri. */
  def head(uri: String): Option[ManifestHead] = {
    val meta = jedis.hgetAll(s"batch:manifest:$uri").asScala
    if (meta.isEmpty) None else Some(ManifestHead(meta("record_count").toLong, meta.get("sealed").contains("1")))
  }

  /** What the uploader writes: the records so far and whether the manifest is sealed. */
  def put(uri: String, recordCount: Long, isSealed: Boolean): Unit = {
    jedis.hset(s"batch:manifest:$uri", Map("record_count" -> recordCount.toString, "sealed" -> (if (isSealed) "1" else "0")).asJava)
    ()
  }
}
`,
  [scalaPath('batch', 'Shards')]: `package batch

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The shard queue's seed (provided): a new batch's shards, all pending. */
object Shards {
  private val jedis = new JedisPooled("redis", 6379)

  /** Queue shards 0..shardCount-1 on the pending list and mark each pending in the shard set. */
  def seed(batchId: String, shardCount: Long): Unit = if (shardCount > 0) {
    val ids = (0L until shardCount).map(_.toString)
    jedis.rpush(Config.pendingKey(batchId), ids: _*)
    jedis.hset(Config.shardsKey(batchId), ids.map(_ -> "pending").toMap.asJava)
    ()
  }
}
`,
  [scalaPath('batch', 'Records')]: `package batch

/** The record and the shard result (provided): what a worker runs and what it hands to publish. */
final case class Record(record_id: String, input: String)

/** One answered record; model is the version that answered. */
final case class Output(record_id: String, output: String, model: String)

/** One failed record; reason is the gRPC status name in lower case (unavailable, deadline, invalid_argument, ...). */
final case class RecordError(record_id: String, reason: String)

/** A shard's outcome; model is the version the batch was submitted with. */
final case class ShardResult(
    batch_id: String,
    shard_id: Int,
    model: String,
    completed: Int = 0,
    failed: Int = 0,
    outputs: List[Output] = Nil,
    errors: List[RecordError] = Nil
)
`,
  [scalaPath('batch', 'Outputs')]: `package batch

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled

/** A stored output: where it is and the SHA-256 (hex) of its bytes. */
final case class OutputObject(uri: String, checksum: String)

/** The output objects (provided): one JSONL object per shard in the object store. */
object Outputs {
  private val jedis = new JedisPooled("redis", 6379)

  def uri(batchId: String, shardId: Int): String = f"s3://batch-outputs/$batchId/shard-$shardId%05d.jsonl"

  /** Write the shard's outputs and errors as one JSONL object. */
  def write(result: ShardResult): OutputObject = {
    val lines =
      result.outputs.map(o => ujson.write(ujson.Obj("record_id" -> o.record_id, "output" -> o.output, "model" -> o.model))) ++
        result.errors.map(e => ujson.write(ujson.Obj("record_id" -> e.record_id, "error" -> e.reason)))
    val body = lines.map(_ + "\\n").mkString
    val where = uri(result.batch_id, result.shard_id)
    jedis.set(s"batch:object:$where", body)
    val digest = MessageDigest.getInstance("SHA-256").digest(body.getBytes(UTF_8))
    OutputObject(where, digest.map(b => f"\${b & 0xff}%02x").mkString)
  }
}
`,
  [scalaPath('batch', 'Outbox')]: `package batch

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "batch:outbox"
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused (its JSON). */
  def insert(eventJson: String): Unit = {
    jedis.rpush(Key, eventJson)
    ()
  }

  /** The kept events, decoded, oldest first. */
  def rows(): List[ujson.Value] = jedis.lrange(Key, 0, -1).asScala.toList.map(ujson.read(_))
}
`,
};
