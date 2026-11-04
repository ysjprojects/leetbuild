/**
 * Hand-written support modules the log-indexer steps import but no step builds: the `logindex`
 * package. `registry` is the tenant's service registry, `ledger` the hourly indexed counts the
 * completeness read reports on. `buffer` is step 2's Redis buffer and `shard` step 3's shard client
 * as the other steps use them. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

/** The buffer's Lua scripts, shared by the support module and step 2's solution. */
export const APPEND_LUA = `local size = string.len(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[2], 'bytes') or '0')
if used + size > tonumber(ARGV[2]) then return 0 end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[2], 'count', 1)
redis.call('HINCRBY', KEYS[2], 'bytes', size)
return redis.call('HINCRBY', KEYS[2], 'offset', 1)`;

export const DRAIN_LUA = `local batch = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
if #batch == 0 then return batch end
redis.call('LTRIM', KEYS[1], #batch, -1)
local size = 0
for _, record in ipairs(batch) do size = size + string.len(record) end
redis.call('HINCRBY', KEYS[2], 'count', -#batch)
redis.call('HINCRBY', KEYS[2], 'bytes', -size)
return batch`;

/** A script as the body of a Scala stripMargin literal. */
export const scalaLua = (lua: string): string =>
  lua
    .split('\n')
    .map((line, i) => (i === 0 ? line : `      |${line}`))
    .join('\n');

export const supportModules: Record<string, string> = {
  'logindex/__init__.py': '',
  'logindex/registry.py': `"""
The tenant service registry (provided): registry:{tenant} is the Redis set of the service ids the
tenant registered. The ingest route and the completeness read serve only those.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def registry_key(tenant: str) -> str:
    return f"registry:{tenant}"


def is_registered(tenant: str, service: str) -> bool:
    """Whether the tenant registered the service."""
    return bool(r.sismember(registry_key(tenant), service))


def add_service(tenant: str, service: str) -> None:
    """Register a service for a tenant (the onboarding flow calls this)."""
    r.sadd(registry_key(tenant), service)
`,
  'logindex/buffer.py': `"""
The log buffer (provided; step 2 builds the same two functions): buffer:{tenant}:{service} is the
Redis list of one index's records (JSON) waiting for the shard, buffer:{tenant}:{service}:meta the
hash beside it with count (records buffered), bytes (their size) and offset (records ever
appended). append_record admits a record in one Lua script and returns its offset, or sheds it
(returns 0) when it would take the buffer past MAX_BUFFER_BYTES; drain_batch takes at most
BATCH_SIZE records and settles count and bytes in the same script.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_BUFFER_BYTES = 64 << 20
BATCH_SIZE = 1000

APPEND_LUA = """
${APPEND_LUA}
"""

DRAIN_LUA = """
${DRAIN_LUA}
"""

append_script = r.register_script(APPEND_LUA)
drain_script = r.register_script(DRAIN_LUA)


def buffer_key(tenant: str, service: str) -> str:
    return f"buffer:{tenant}:{service}"


def meta_key(tenant: str, service: str) -> str:
    return f"buffer:{tenant}:{service}:meta"


def append_record(tenant: str, service: str, record: dict) -> int:
    """Buffer one record (service, timestamp, level, message); its offset, or 0 when it was shed."""
    keys = [buffer_key(tenant, service), meta_key(tenant, service)]
    return int(append_script(keys=keys, args=[json.dumps(record), MAX_BUFFER_BYTES]))


def drain_batch(tenant: str, service: str) -> list[dict]:
    """Take the oldest BATCH_SIZE records at most, oldest first."""
    keys = [buffer_key(tenant, service), meta_key(tenant, service)]
    return [json.loads(raw) for raw in drain_script(keys=keys, args=[BATCH_SIZE])]
`,
  'logindex/shard.py': `"""
The index shard client (provided; step 3 builds the same bulk_write): one BulkWrite per batch to
shard:9000 with a 3-second deadline per attempt, at most MAX_ATTEMPTS attempts with a backoff for
UNAVAILABLE and DEADLINE_EXCEEDED only, and one batch id for every attempt (the shard indexes a
batch id once). A mapping conflict (FAILED_PRECONDITION, the field as the details) raises
MappingConflict; any other failure raises ShardWriteFailed. The result is a dict: batch_id,
indexed, rejected, index_snapshot.
"""
import time
import uuid

import grpc

import log_indexer_pb2
import log_indexer_pb2_grpc

DEADLINE_S = 3
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

stub = log_indexer_pb2_grpc.IndexShardStub(grpc.insecure_channel("shard:9000"))


class MappingConflict(Exception):
    """The shard's mapping refuses the batch: terminal until the records or the mapping change."""

    def __init__(self, field: str) -> None:
        super().__init__(f"mapping conflict on field {field}")
        self.field = field


class ShardWriteFailed(Exception):
    """The shard did not take the batch: it refused it, or the retryable failures ran out of attempts."""


def bulk_write(index: str, records: list[dict]) -> dict:
    """Write one batch to the index; the shard's reply and the batch id every attempt carried."""
    batch_id = str(uuid.uuid4())
    protos = [log_indexer_pb2.LogRecord(**record) for record in records]
    for attempt in range(1, MAX_ATTEMPTS + 1):
        request = log_indexer_pb2.BulkWriteRequest(index=index, batch_id=batch_id, attempt=attempt, records=protos)
        try:
            reply = stub.BulkWrite(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
                raise MappingConflict(exc.details()) from exc
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise ShardWriteFailed(f"{exc.code().name} after {attempt} attempt(s)") from exc
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))
            continue
        return {"batch_id": batch_id, "indexed": reply.indexed, "rejected": reply.rejected, "index_snapshot": reply.index_snapshot}
    raise ShardWriteFailed("no attempt was made")
`,
  'logindex/ledger.py': `"""
The index ledger (provided): ledger:{tenant}:{service} is a Redis hash from an hour (its start, in
epoch seconds) to the number of the service's records indexed in that hour. The ledger service, a
consumer of log.indexed this course does not build, calls record_indexed.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HOUR_S = 3600
HISTORY_HOURS = 168


def ledger_key(tenant: str, service: str) -> str:
    return f"ledger:{tenant}:{service}"


def record_indexed(tenant: str, service: str, hour: int, count: int) -> None:
    """Add count records indexed in the hour starting at hour (epoch seconds)."""
    r.hincrby(ledger_key(tenant, service), str(hour), count)


def hourly_counts(tenant: str, service: str, hours: list[int]) -> list[int]:
    """The indexed count of each hour (its start in epoch seconds), 0 for an hour with none."""
    if not hours:
        return []
    values = r.hmget(ledger_key(tenant, service), [str(hour) for hour in hours])
    return [int(value) if value else 0 for value in values]


def expected_per_hour(tenant: str, service: str, before: int) -> int:
    """The service's own baseline: its mean count per hour over the HISTORY_HOURS hours before \`before\`, rounded down."""
    hours = [before - HOUR_S * (i + 1) for i in range(HISTORY_HOURS)]
    return sum(hourly_counts(tenant, service, hours)) // HISTORY_HOURS
`,
};

export const supportModulesTs: Record<string, string> = {
  'logindex/registry.ts': `/**
 * The tenant service registry (provided): registry:{tenant} is the Redis set of the service ids the
 * tenant registered. The ingest route and the completeness read serve only those.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const registryKey = (tenant: string): string => \`registry:\${tenant}\`;

/** Whether the tenant registered the service. */
export async function isRegistered(tenant: string, service: string): Promise<boolean> {
  return (await redis.sismember(registryKey(tenant), service)) === 1;
}

/** Register a service for a tenant (the onboarding flow calls this). */
export async function addService(tenant: string, service: string): Promise<void> {
  await redis.sadd(registryKey(tenant), service);
}
`,
  'logindex/buffer.ts': `/**
 * The log buffer (provided; step 2 builds the same two functions): buffer:{tenant}:{service} is the
 * Redis list of one index's records (JSON) waiting for the shard, buffer:{tenant}:{service}:meta
 * the hash beside it with count (records buffered), bytes (their size) and offset (records ever
 * appended). appendRecord admits a record in one Lua script and returns its offset, or sheds it
 * (returns 0) when it would take the buffer past MAX_BUFFER_BYTES; drainBatch takes at most
 * BATCH_SIZE records and settles count and bytes in the same script.
 */
import Redis from 'ioredis';

export const MAX_BUFFER_BYTES = 64 << 20;
export const BATCH_SIZE = 1000;

/** One log record as the buffer and the shard carry it. */
export interface LogRecord {
  service: string;
  timestamp: string;
  level: string;
  message: string;
}

export const APPEND_LUA = \`
${APPEND_LUA}
\`;

export const DRAIN_LUA = \`
${DRAIN_LUA}
\`;

interface BufferRedis extends Redis {
  appendScript(key: string, meta: string, record: string, cap: number): Promise<number>;
  drainScript(key: string, meta: string, size: number): Promise<string[]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as BufferRedis;
redis.defineCommand('appendScript', {numberOfKeys: 2, lua: APPEND_LUA});
redis.defineCommand('drainScript', {numberOfKeys: 2, lua: DRAIN_LUA});

export const bufferKey = (tenant: string, service: string): string => \`buffer:\${tenant}:\${service}\`;
export const metaKey = (tenant: string, service: string): string => \`buffer:\${tenant}:\${service}:meta\`;

/** Buffer one record; its offset, or 0 when it was shed. */
export async function appendRecord(tenant: string, service: string, record: LogRecord): Promise<number> {
  return Number(await redis.appendScript(bufferKey(tenant, service), metaKey(tenant, service), JSON.stringify(record), MAX_BUFFER_BYTES));
}

/** Take the oldest BATCH_SIZE records at most, oldest first. */
export async function drainBatch(tenant: string, service: string): Promise<LogRecord[]> {
  const batch = await redis.drainScript(bufferKey(tenant, service), metaKey(tenant, service), BATCH_SIZE);
  return batch.map(raw => JSON.parse(raw) as LogRecord);
}
`,
  'logindex/shard.ts': `/**
 * The index shard client (provided; step 3 builds the same bulkWrite): one BulkWrite per batch to
 * shard:9000 with a 3-second deadline per attempt, at most MAX_ATTEMPTS attempts with a backoff for
 * UNAVAILABLE and DEADLINE_EXCEEDED only, and one batch id for every attempt (the shard indexes a
 * batch id once). A mapping conflict (FAILED_PRECONDITION, the field as the details) throws
 * MappingConflict; any other failure throws ShardWriteFailed.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

import type {LogRecord} from 'logindex/buffer';

export const DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 200;

export interface BulkWriteRequest {
  index: string;
  batch_id: string;
  attempt: number;
  records: LogRecord[];
}

export interface BulkWriteReply {
  indexed: number;
  rejected: number;
  index_snapshot: string;
}

/** What one batch write did: the batch id every attempt carried and the shard's reply. */
export interface WriteResult {
  batch_id: string;
  indexed: number;
  rejected: number;
  index_snapshot: string;
}

/** The shard's mapping refuses the batch: terminal until the records or the mapping change. */
export class MappingConflict extends Error {
  constructor(readonly field: string) {
    super(\`mapping conflict on field \${field}\`);
  }
}

/** The shard did not take the batch: it refused it, or the retryable failures ran out of attempts. */
export class ShardWriteFailed extends Error {}

export type ShardClient = grpc.Client & {
  BulkWrite(request: BulkWriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<BulkWriteReply>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('log_indexer.proto')) as unknown as {
  logshard: {IndexShard: grpc.ServiceClientConstructor};
};
const shard = new pkg.logshard.IndexShard('shard:9000', grpc.credentials.createInsecure()) as ShardClient;

const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Write one batch to the index. */
export async function bulkWrite(index: string, records: LogRecord[]): Promise<WriteResult> {
  const batchId = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await shard.BulkWrite({index, batch_id: batchId, attempt, records}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {batch_id: batchId, indexed: reply.indexed, rejected: reply.rejected, index_snapshot: reply.index_snapshot};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.FAILED_PRECONDITION) throw new MappingConflict(details);
      if (!RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw new ShardWriteFailed(\`\${grpc.status[code]} after \${attempt} attempt(s)\`);
      await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}
`,
  'logindex/ledger.ts': `/**
 * The index ledger (provided): ledger:{tenant}:{service} is a Redis hash from an hour (its start, in
 * epoch seconds) to the number of the service's records indexed in that hour. The ledger service, a
 * consumer of log.indexed this course does not build, calls recordIndexed.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const HOUR_S = 3600;
export const HISTORY_HOURS = 168;

export const ledgerKey = (tenant: string, service: string): string => \`ledger:\${tenant}:\${service}\`;

/** Add count records indexed in the hour starting at hour (epoch seconds). */
export async function recordIndexed(tenant: string, service: string, hour: number, count: number): Promise<void> {
  await redis.hincrby(ledgerKey(tenant, service), String(hour), count);
}

/** The indexed count of each hour (its start in epoch seconds), 0 for an hour with none. */
export async function hourlyCounts(tenant: string, service: string, hours: number[]): Promise<number[]> {
  if (hours.length === 0) return [];
  const values = await redis.hmget(ledgerKey(tenant, service), ...hours.map(String));
  return values.map(value => (value ? Number(value) : 0));
}

/** The service's own baseline: its mean count per hour over the HISTORY_HOURS hours before \`before\`, rounded down. */
export async function expectedPerHour(tenant: string, service: string, before: number): Promise<number> {
  const hours = Array.from({length: HISTORY_HOURS}, (_, i) => before - HOUR_S * (i + 1));
  const counts = await hourlyCounts(tenant, service, hours);
  return Math.floor(counts.reduce((sum, n) => sum + n, 0) / HISTORY_HOURS);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'logindex/registry/registry.go': `// Package registry is the tenant service registry (provided): registry:{tenant} is the Redis set
// of the service ids the tenant registered. The ingest route and the completeness read serve only
// those.
package registry

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// RegistryKey is the set of a tenant's services.
func RegistryKey(tenant string) string { return "registry:" + tenant }

// IsRegistered reports whether the tenant registered the service.
func IsRegistered(ctx context.Context, tenant, service string) (bool, error) {
	return rdb.SIsMember(ctx, RegistryKey(tenant), service).Result()
}

// AddService registers a service for a tenant (the onboarding flow calls this).
func AddService(ctx context.Context, tenant, service string) error {
	return rdb.SAdd(ctx, RegistryKey(tenant), service).Err()
}
`,
  'logindex/buffer/buffer.go': `// Package buffer is the log buffer (provided; step 2 builds the same two functions):
// buffer:{tenant}:{service} is the Redis list of one index's records (JSON) waiting for the shard,
// buffer:{tenant}:{service}:meta the hash beside it with count (records buffered), bytes (their
// size) and offset (records ever appended). AppendRecord admits a record in one Lua script and
// returns its offset, or sheds it (returns 0) when it would take the buffer past MaxBufferBytes;
// DrainBatch takes at most BatchSize records and settles count and bytes in the same script.
package buffer

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const (
	MaxBufferBytes = 64 << 20
	BatchSize      = 1000
)

// Record is one log record as the buffer and the shard carry it.
type Record struct {
	Service   string \`json:"service"\`
	Timestamp string \`json:"timestamp"\`
	Level     string \`json:"level"\`
	Message   string \`json:"message"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var appendScript = redis.NewScript(\`
${APPEND_LUA}
\`)

var drainScript = redis.NewScript(\`
${DRAIN_LUA}
\`)

// BufferKey is the list of one index's records.
func BufferKey(tenant, service string) string { return "buffer:" + tenant + ":" + service }

// MetaKey is the hash of count, bytes and offset beside the list.
func MetaKey(tenant, service string) string { return "buffer:" + tenant + ":" + service + ":meta" }

// AppendRecord buffers one record: its offset, or 0 when it was shed.
func AppendRecord(ctx context.Context, tenant, service string, record Record) (int64, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return 0, err
	}
	return appendScript.Run(ctx, rdb, []string{BufferKey(tenant, service), MetaKey(tenant, service)}, string(raw), MaxBufferBytes).Int64()
}

// DrainBatch takes the oldest BatchSize records at most, oldest first.
func DrainBatch(ctx context.Context, tenant, service string) ([]Record, error) {
	raw, err := drainScript.Run(ctx, rdb, []string{BufferKey(tenant, service), MetaKey(tenant, service)}, BatchSize).StringSlice()
	if err != nil {
		return nil, err
	}
	batch := make([]Record, 0, len(raw))
	for _, item := range raw {
		var record Record
		if err := json.Unmarshal([]byte(item), &record); err != nil {
			return nil, err
		}
		batch = append(batch, record)
	}
	return batch, nil
}
`,
  'logindex/shard/shard.go': `// Package shard is the index shard client (provided; step 3 builds the same BulkWrite): one
// BulkWrite per batch to shard:9000 with a 3-second deadline per attempt, at most MaxAttempts
// attempts with a backoff for Unavailable and DeadlineExceeded only, and one batch id for every
// attempt (the shard indexes a batch id once). A mapping conflict (FailedPrecondition, the field as
// the details) returns a *MappingConflict; any other failure an error wrapping ErrShardWriteFailed.
package shard

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"logindex/buffer"
	pb "logindex/gen/log_indexer"
)

const (
	Deadline    = 3 * time.Second
	MaxAttempts = 3
	Backoff     = 200 * time.Millisecond
)

// WriteResult is what one batch write did: the batch id every attempt carried and the shard's reply.
type WriteResult struct {
	BatchID       string
	Indexed       int
	Rejected      int
	IndexSnapshot string
}

// MappingConflict: the shard's mapping refuses the batch, terminal until the records or the mapping change.
type MappingConflict struct {
	Field string
}

func (e *MappingConflict) Error() string { return "mapping conflict on field " + e.Field }

// ErrShardWriteFailed: the shard did not take the batch; it refused it, or the retryable failures ran out of attempts.
var ErrShardWriteFailed = errors.New("shard write failed")

var (
	conn, _ = grpc.NewClient("shard:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client  = pb.NewIndexShardClient(conn)
)

// Protos converts records to the shard's LogRecord messages.
func Protos(records []buffer.Record) []*pb.LogRecord {
	out := make([]*pb.LogRecord, 0, len(records))
	for _, r := range records {
		out = append(out, &pb.LogRecord{Service: r.Service, Timestamp: r.Timestamp, Level: r.Level, Message: r.Message})
	}
	return out
}

// BulkWrite writes one batch to the index.
func BulkWrite(ctx context.Context, index string, records []buffer.Record) (WriteResult, error) {
	batchID := uuid.NewString()
	protos := Protos(records)
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		reply, err := client.BulkWrite(callCtx, &pb.BulkWriteRequest{Index: index, BatchId: batchID, Attempt: int32(attempt), Records: protos})
		cancel()
		if err == nil {
			return WriteResult{BatchID: batchID, Indexed: int(reply.GetIndexed()), Rejected: int(reply.GetRejected()), IndexSnapshot: reply.GetIndexSnapshot()}, nil
		}
		code := status.Code(err)
		if code == codes.FailedPrecondition {
			return WriteResult{}, &MappingConflict{Field: status.Convert(err).Message()}
		}
		if (code != codes.Unavailable && code != codes.DeadlineExceeded) || attempt >= MaxAttempts {
			return WriteResult{}, fmt.Errorf("%w: %v after %d attempt(s)", ErrShardWriteFailed, code, attempt)
		}
		time.Sleep(Backoff << (attempt - 1))
	}
}
`,
  'logindex/ledger/ledger.go': `// Package ledger is the index ledger (provided): ledger:{tenant}:{service} is a Redis hash from an
// hour (its start, in epoch seconds) to the number of the service's records indexed in that hour.
// The ledger service, a consumer of log.indexed this course does not build, calls RecordIndexed.
package ledger

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	HourS        = 3600
	HistoryHours = 168
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// LedgerKey is the hash of one service's hourly counts.
func LedgerKey(tenant, service string) string { return "ledger:" + tenant + ":" + service }

// RecordIndexed adds count records indexed in the hour starting at hour (epoch seconds).
func RecordIndexed(ctx context.Context, tenant, service string, hour, count int64) error {
	return rdb.HIncrBy(ctx, LedgerKey(tenant, service), strconv.FormatInt(hour, 10), count).Err()
}

// HourlyCounts is the indexed count of each hour (its start in epoch seconds), 0 for an hour with none.
func HourlyCounts(ctx context.Context, tenant, service string, hours []int64) ([]int64, error) {
	counts := make([]int64, len(hours))
	if len(hours) == 0 {
		return counts, nil
	}
	fields := make([]string, len(hours))
	for i, hour := range hours {
		fields[i] = strconv.FormatInt(hour, 10)
	}
	values, err := rdb.HMGet(ctx, LedgerKey(tenant, service), fields...).Result()
	if err != nil {
		return nil, err
	}
	for i, value := range values {
		if text, ok := value.(string); ok {
			counts[i], _ = strconv.ParseInt(text, 10, 64)
		}
	}
	return counts, nil
}

// ExpectedPerHour is the service's own baseline: its mean count per hour over the HistoryHours
// hours before \`before\`, rounded down.
func ExpectedPerHour(ctx context.Context, tenant, service string, before int64) (int64, error) {
	hours := make([]int64, HistoryHours)
	for i := range hours {
		hours[i] = before - HourS*int64(i+1)
	}
	counts, err := HourlyCounts(ctx, tenant, service, hours)
	if err != nil {
		return 0, err
	}
	var sum int64
	for _, n := range counts {
		sum += n
	}
	return sum / HistoryHours, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'logindex/registry.h': `// The tenant service registry (provided): registry:{tenant} is the Redis set of the service ids the
// tenant registered. The ingest route and the completeness read serve only those.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace registry {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string registryKey(const std::string& tenant) { return "registry:" + tenant; }

// Whether the tenant registered the service.
inline bool isRegistered(const std::string& tenant, const std::string& service) { return redis().sismember(registryKey(tenant), service); }

// Register a service for a tenant (the onboarding flow calls this).
inline void addService(const std::string& tenant, const std::string& service) { redis().sadd(registryKey(tenant), service); }

}  // namespace registry
`,
  'logindex/buffer.h': `// The log buffer (provided; step 2 builds the same two functions): buffer:{tenant}:{service} is the
// Redis list of one index's records (JSON) waiting for the shard, buffer:{tenant}:{service}:meta the
// hash beside it with count (records buffered), bytes (their size) and offset (records ever
// appended). appendRecord admits a record in one Lua script and returns its offset, or sheds it
// (returns 0) when it would take the buffer past kMaxBufferBytes; drainBatch takes at most
// kBatchSize records and settles count and bytes in the same script.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

namespace buffer {

constexpr long long kMaxBufferBytes = 64LL << 20;
constexpr long long kBatchSize = 1000;

// One log record as the buffer and the shard carry it.
struct Record {
  std::string service;
  std::string timestamp;
  std::string level;
  std::string message;
};

inline nlohmann::json toJson(const Record& r) {
  return {{"service", r.service}, {"timestamp", r.timestamp}, {"level", r.level}, {"message", r.message}};
}

inline Record fromJson(const nlohmann::json& j) {
  return {j.value("service", ""), j.value("timestamp", ""), j.value("level", ""), j.value("message", "")};
}

inline const std::string kAppendLua = R"lua(
${APPEND_LUA}
)lua";

inline const std::string kDrainLua = R"lua(
${DRAIN_LUA}
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string bufferKey(const std::string& tenant, const std::string& service) { return "buffer:" + tenant + ":" + service; }
inline std::string metaKey(const std::string& tenant, const std::string& service) { return "buffer:" + tenant + ":" + service + ":meta"; }

// Buffer one record: its offset, or 0 when it was shed.
inline long long appendRecord(const std::string& tenant, const std::string& service, const Record& record) {
  return redis().eval<long long>(kAppendLua, {bufferKey(tenant, service), metaKey(tenant, service)}, {toJson(record).dump(), std::to_string(kMaxBufferBytes)});
}

// Take the oldest kBatchSize records at most, oldest first.
inline std::vector<Record> drainBatch(const std::string& tenant, const std::string& service) {
  std::vector<std::string> raw;
  redis().eval(kDrainLua, {bufferKey(tenant, service), metaKey(tenant, service)}, {std::to_string(kBatchSize)}, std::back_inserter(raw));
  std::vector<Record> batch;
  for (const std::string& item : raw) batch.push_back(fromJson(nlohmann::json::parse(item)));
  return batch;
}

}  // namespace buffer
`,
  'logindex/shard.h': `// The index shard client (provided; step 3 builds the same bulkWrite): one BulkWrite per batch to
// shard:9000 with a 3-second deadline per attempt, at most kMaxAttempts attempts with a backoff for
// UNAVAILABLE and DEADLINE_EXCEEDED only, and one batch id for every attempt (the shard indexes a
// batch id once). A mapping conflict (FAILED_PRECONDITION, the field as the details) throws
// MappingConflict; any other failure throws ShardWriteFailed.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdio>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "log_indexer.grpc.pb.h"
#include "logindex/buffer.h"

namespace shard {

constexpr std::chrono::seconds kDeadline{3};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{200};

// What one batch write did: the batch id every attempt carried and the shard's reply.
struct WriteResult {
  std::string batch_id;
  int indexed = 0;
  int rejected = 0;
  std::string index_snapshot;
};

// The shard's mapping refuses the batch: terminal until the records or the mapping change.
struct MappingConflict : std::runtime_error {
  std::string field;
  explicit MappingConflict(const std::string& f) : std::runtime_error("mapping conflict on field " + f), field(f) {}
};

// The shard did not take the batch: it refused it, or the retryable failures ran out of attempts.
struct ShardWriteFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A random batch id (128 bits, hex).
inline std::string newBatchId() {
  static std::mt19937_64 rng{std::random_device{}()};
  char out[33];
  std::snprintf(out, sizeof out, "%016llx%016llx", static_cast<unsigned long long>(rng()), static_cast<unsigned long long>(rng()));
  return out;
}

inline logshard::IndexShard::Stub& stub() {
  static auto s = logshard::IndexShard::NewStub(grpc::CreateChannel("shard:9000", grpc::InsecureChannelCredentials()));
  return *s;
}

// The request for one attempt.
inline logshard::BulkWriteRequest request(const std::string& index, const std::string& batch_id, int attempt, const std::vector<buffer::Record>& records) {
  logshard::BulkWriteRequest req;
  req.set_index(index);
  req.set_batch_id(batch_id);
  req.set_attempt(attempt);
  for (const buffer::Record& r : records) {
    logshard::LogRecord* out = req.add_records();
    out->set_service(r.service);
    out->set_timestamp(r.timestamp);
    out->set_level(r.level);
    out->set_message(r.message);
  }
  return req;
}

// Write one batch to the index.
inline WriteResult bulkWrite(const std::string& index, const std::vector<buffer::Record>& records) {
  const std::string batch_id = newBatchId();
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    logshard::BulkWriteReply reply;
    const grpc::Status status = stub().BulkWrite(&ctx, request(index, batch_id, attempt, records), &reply);
    if (status.ok()) return {batch_id, reply.indexed(), reply.rejected(), reply.index_snapshot()};
    const grpc::StatusCode code = status.error_code();
    if (code == grpc::StatusCode::FAILED_PRECONDITION) throw MappingConflict(status.error_message());
    const bool retryable = code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt >= kMaxAttempts) {
      throw ShardWriteFailed("status " + std::to_string(static_cast<int>(code)) + " after " + std::to_string(attempt) + " attempt(s)");
    }
    std::this_thread::sleep_for(kBackoff * (1 << (attempt - 1)));
  }
}

}  // namespace shard
`,
  'logindex/ledger.h': `// The index ledger (provided): ledger:{tenant}:{service} is a Redis hash from an hour (its start, in
// epoch seconds) to the number of the service's records indexed in that hour. The ledger service, a
// consumer of log.indexed this course does not build, calls recordIndexed.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

namespace ledger {

constexpr long long kHourS = 3600;
constexpr long long kHistoryHours = 168;

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string ledgerKey(const std::string& tenant, const std::string& service) { return "ledger:" + tenant + ":" + service; }

// Add count records indexed in the hour starting at hour (epoch seconds).
inline void recordIndexed(const std::string& tenant, const std::string& service, long long hour, long long count) {
  redis().hincrby(ledgerKey(tenant, service), std::to_string(hour), count);
}

// The indexed count of each hour (its start in epoch seconds), 0 for an hour with none.
inline std::vector<long long> hourlyCounts(const std::string& tenant, const std::string& service, const std::vector<long long>& hours) {
  std::vector<long long> counts;
  if (hours.empty()) return counts;
  std::vector<std::string> fields;
  for (long long hour : hours) fields.push_back(std::to_string(hour));
  std::vector<sw::redis::OptionalString> values;
  redis().hmget(ledgerKey(tenant, service), fields.begin(), fields.end(), std::back_inserter(values));
  for (const auto& value : values) counts.push_back(value && !value->empty() ? std::stoll(*value) : 0);
  return counts;
}

// The service's own baseline: its mean count per hour over the kHistoryHours hours before
// \`before\`, rounded down.
inline long long expectedPerHour(const std::string& tenant, const std::string& service, long long before) {
  std::vector<long long> hours;
  for (long long i = 0; i < kHistoryHours; i++) hours.push_back(before - kHourS * (i + 1));
  long long sum = 0;
  for (long long n : hourlyCounts(tenant, service, hours)) sum += n;
  return sum / kHistoryHours;
}

}  // namespace ledger
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('logindex', 'Registry')]: `package logindex

import redis.clients.jedis.JedisPooled

/**
 * The tenant service registry (provided): registry:{tenant} is the Redis set of the service ids the
 * tenant registered. The ingest route and the completeness read serve only those.
 */
object Registry {
  val jedis = new JedisPooled("redis", 6379)

  def registryKey(tenant: String): String = s"registry:$tenant"

  /** Whether the tenant registered the service. */
  def isRegistered(tenant: String, service: String): Boolean = jedis.sismember(registryKey(tenant), service)

  /** Register a service for a tenant (the onboarding flow calls this). */
  def addService(tenant: String, service: String): Unit = jedis.sadd(registryKey(tenant), service)
}
`,
  [scalaPath('logindex', 'Buffer')]: `package logindex

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The log buffer (provided; step 2 builds the same two functions): buffer:{tenant}:{service} is the
 * Redis list of one index's records (JSON) waiting for the shard, buffer:{tenant}:{service}:meta the
 * hash beside it with count (records buffered), bytes (their size) and offset (records ever
 * appended). appendRecord admits a record in one Lua script and returns its offset, or sheds it
 * (returns 0) when it would take the buffer past MaxBufferBytes; drainBatch takes at most BatchSize
 * records and settles count and bytes in the same script.
 */
object Buffer {
  /** One log record as the buffer and the shard carry it. */
  final case class Record(service: String, timestamp: String, level: String, message: String)

  implicit val recordFormat: RootJsonFormat[Record] = jsonFormat4(Record.apply)

  val MaxBufferBytes: Long = 64L << 20
  val BatchSize = 1000

  val jedis = new JedisPooled("redis", 6379)

  val AppendLua: String =
    """${scalaLua(APPEND_LUA)}
      |""".stripMargin

  val DrainLua: String =
    """${scalaLua(DRAIN_LUA)}
      |""".stripMargin

  def bufferKey(tenant: String, service: String): String = s"buffer:$tenant:$service"
  def metaKey(tenant: String, service: String): String = s"buffer:$tenant:$service:meta"

  /** Buffer one record: its offset, or 0 when it was shed. */
  def appendRecord(tenant: String, service: String, record: Record): Long = {
    val keys = List(bufferKey(tenant, service), metaKey(tenant, service)).asJava
    jedis.eval(AppendLua, keys, List(record.toJson.compactPrint, MaxBufferBytes.toString).asJava).asInstanceOf[java.lang.Long]
  }

  /** Take the oldest BatchSize records at most, oldest first. */
  def drainBatch(tenant: String, service: String): Seq[Record] = {
    val keys = List(bufferKey(tenant, service), metaKey(tenant, service)).asJava
    val raw = jedis.eval(DrainLua, keys, List(BatchSize.toString).asJava).asInstanceOf[java.util.List[String]]
    raw.asScala.toSeq.map(_.parseJson.convertTo[Record])
  }
}
`,
  [scalaPath('logindex', 'Shard')]: `package logindex

import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import logshard.log_indexer.{BulkWriteRequest, IndexShardGrpc, LogRecord}

/** The shard's mapping refuses the batch: terminal until the records or the mapping change. */
final class MappingConflict(val field: String) extends Exception(s"mapping conflict on field $field")

/** The shard did not take the batch: it refused it, or the retryable failures ran out of attempts. */
final class ShardWriteFailed(message: String) extends Exception(message)

/**
 * The index shard client (provided; step 3 builds the same bulkWrite): one BulkWrite per batch to
 * shard:9000 with a 3-second deadline per attempt, at most MaxAttempts attempts with a backoff for
 * UNAVAILABLE and DEADLINE_EXCEEDED only, and one batch id for every attempt (the shard indexes a
 * batch id once). A mapping conflict (FAILED_PRECONDITION, the field as the details) throws
 * MappingConflict; any other failure throws ShardWriteFailed.
 */
object Shard {
  /** What one batch write did: the batch id every attempt carried and the shard's reply. */
  final case class WriteResult(batchId: String, indexed: Int, rejected: Int, indexSnapshot: String)

  val DeadlineS = 3L
  val MaxAttempts = 3
  val BackoffMs = 200L

  private val stub = IndexShardGrpc.blockingStub(ManagedChannelBuilder.forAddress("shard", 9000).usePlaintext().build())

  def protos(records: Seq[Buffer.Record]): Seq[LogRecord] = records.map(r => LogRecord(r.service, r.timestamp, r.level, r.message))

  /** Write one batch to the index. */
  def bulkWrite(index: String, records: Seq[Buffer.Record]): WriteResult = {
    val batchId = UUID.randomUUID().toString
    var attempt = 1
    var result: Option[WriteResult] = None
    while (result.isEmpty) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).bulkWrite(BulkWriteRequest(index, batchId, attempt, protos(records)))
        result = Some(WriteResult(batchId, reply.indexed, reply.rejected, reply.indexSnapshot))
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.FAILED_PRECONDITION =>
          throw new MappingConflict(Option(e.getStatus.getDescription).getOrElse(""))
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          val retryable = code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED
          if (!retryable || attempt >= MaxAttempts) throw new ShardWriteFailed(s"$code after $attempt attempt(s)")
          Thread.sleep(BackoffMs << (attempt - 1))
          attempt += 1
      }
    }
    result.get
  }
}
`,
  [scalaPath('logindex', 'Ledger')]: `package logindex

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The index ledger (provided): ledger:{tenant}:{service} is a Redis hash from an hour (its start, in
 * epoch seconds) to the number of the service's records indexed in that hour. The ledger service, a
 * consumer of log.indexed this course does not build, calls recordIndexed.
 */
object Ledger {
  val HourS = 3600L
  val HistoryHours = 168

  val jedis = new JedisPooled("redis", 6379)

  def ledgerKey(tenant: String, service: String): String = s"ledger:$tenant:$service"

  /** Add count records indexed in the hour starting at hour (epoch seconds). */
  def recordIndexed(tenant: String, service: String, hour: Long, count: Long): Unit =
    jedis.hincrBy(ledgerKey(tenant, service), hour.toString, count)

  /** The indexed count of each hour (its start in epoch seconds), 0 for an hour with none. */
  def hourlyCounts(tenant: String, service: String, hours: Seq[Long]): Seq[Long] =
    if (hours.isEmpty) Seq.empty
    else jedis.hmget(ledgerKey(tenant, service), hours.map(_.toString): _*).asScala.toSeq.map(v => Option(v).filter(_.nonEmpty).fold(0L)(_.toLong))

  /** The service's own baseline: its mean count per hour over the HistoryHours hours before \`before\`, rounded down. */
  def expectedPerHour(tenant: String, service: String, before: Long): Long =
    hourlyCounts(tenant, service, (1 to HistoryHours).map(i => before - HourS * i)).sum / HistoryHours
}
`,
};
