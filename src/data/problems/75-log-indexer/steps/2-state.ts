import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis buffered-writer state with back-pressure',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'writer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it keeps one buffer per index,
appends a record, and drains a batch of 1000. It compiles, it buffers the happy path, and it hides
three production flaws — one of them turns a search outage into an out-of-memory kill of the ingest
tier. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement the Redis buffer state the writer and the ingest path share:

- One buffer per index, keyed by \`(tenant, service)\`; a shared or tenant-less key lets one service
  consume another's back-pressure.
- Appends move the record \`count\`, the \`bytes\` total and the \`offset\` in **one atomic operation**
  (a single Lua \`EVAL\`, a script object, or one multi-field write). Three separate commands let a
  crash land between them, and a buffer whose count and offset disagree cannot be drained safely.
- A per-index byte cap of **64 MiB** (\`64 << 20\`). When a buffer is at or over the cap, the ingest
  path **sheds**: it answers **429** with a \`Retry-After\` header in seconds and does not append the
  record. An overflow must never be buffered.
- The cap is checked **before** the append, so a shed record costs one read and no write.
- Draining takes at most **1000** records (\`BUFFER_BATCH\`) and settles count and bytes in the same
  atomic step that advances the offset.
- Give an idle buffer a TTL so a service that stops shipping does not hold memory forever.

**Failure mode the checks target.** The draft increments count and bytes and sets the offset as three
independent commands, so a crash between them leaves a buffer that reports one number more record
than it holds; it never compares the total against a cap, so a shard that stops accepting batches
grows the buffer until the ingest pod dies; and its \`offer\` returns 202 for every record, so the
agent keeps shipping into a pipeline that can no longer accept anything.`,
  sequence: {
    participants: ['Ingest API', 'Redis buffer', 'Buffered writer'],
    messages: [
      {from: 'Ingest API', to: 'Redis buffer', label: 'bytes_used(index)', kind: 'sync'},
      {from: 'Redis buffer', to: 'Ingest API', label: 'used bytes / count', kind: 'reply'},
      {from: 'Ingest API', to: 'Ingest API', label: 'over cap → 429 + Retry-After', kind: 'sync'},
      {from: 'Ingest API', to: 'Redis buffer', label: 'EVAL append{count, bytes, offset}', kind: 'sync'},
      {from: 'Buffered writer', to: 'Redis buffer', label: 'EVAL drain(BATCH_SIZE)', kind: 'sync'},
      {from: 'Redis buffer', to: 'Buffered writer', label: 'batch · settled count and bytes', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'batch-size',
      title: 'One buffer per index, drained in batches of 1000',
      detail:
        'The buffer key is built from the tenant and the service, and a drain takes at most `BUFFER_BATCH = 1000` records. A shared key mixes tenants, and an unbounded drain turns one crash into a rewrite of everything the buffer holds.',
      match: {
        python: {all: [/BUFFER_BATCH\s*=\s*1000/, /def buffer_key\(/]},
        typescript: {all: [/BUFFER_BATCH\s*=\s*1000/, /bufferKey\(/]},
        go: {all: [/bufferBatch\s*=\s*1000/, /bufferKey\(/]},
        scala: {all: [/BufferBatch\s*=\s*1000/, /bufferKey\(/]},
        cpp: {all: [/kBufferBatch\s*=\s*1000/, /bufferKey\(/]},
      },
    },
    {
      id: 'byte-cap',
      title: 'Tracks a per-index byte cap',
      detail:
        'The buffer keeps a `bytes` total next to the count and compares it with `64 << 20`. The draft counts records but never bytes, so nothing can stop the buffer from growing.',
      match: {
        python: {all: [/MAX_BUFFER_BYTES\s*=\s*/, /['"]bytes['"]/]},
        typescript: {all: [/MAX_BUFFER_BYTES\s*=\s*/, /['"]bytes['"]/]},
        go: {all: [/maxBufferBytes\s*=\s*/, /['"]bytes['"]/]},
        scala: {all: [/MaxBufferBytes\s*=\s*/, /['"]bytes['"]/]},
        cpp: {all: [/kMaxBufferBytes\s*=\s*/, /['"]bytes['"]/]},
      },
    },
    {
      id: 'atomic-fields',
      title: 'Moves count, bytes and offset in one atomic step',
      detail:
        'The append is one atomic `EVAL` of a Lua script (or one script object round trip) that bumps the count, the byte total and the offset together. The draft runs three separate commands, so a crash in the middle leaves the offset and the count disagreeing.',
      match: {
        python: {all: [/APPEND_LUA/, /\.eval\(/, /['"]offset['"]/, /['"]count['"]/]},
        typescript: {all: [/APPEND_LUA/, /\.eval\(/, /['"]offset['"]/, /['"]count['"]/]},
        go: {all: [/(?:appendScript|APPEND_LUA)/, /\.Run\(/, /['"]offset['"]/, /['"]count['"]/]},
        scala: {all: [/(?:AppendLua|APPEND_LUA)/, /\.eval\(/, /['"]offset['"]/, /['"]count['"]/]},
        cpp: {all: [/(?:kAppendLua|APPEND_LUA)/, /\.eval</, /['"]offset['"]/, /['"]count['"]/]},
      },
    },
    {
      id: 'shed-429',
      title: 'Sheds over the cap with 429 and Retry-After',
      detail:
        'A buffer at or over `MAX_BUFFER_BYTES` answers **429** with a `Retry-After` in seconds instead of accepting the record. The draft returns 202 for everything, so the shard outage becomes ingest memory growth.',
      match: {
        python: {all: [/MAX_BUFFER_BYTES/, /\b429\b/, /Retry-After/]},
        typescript: {all: [/MAX_BUFFER_BYTES/, /\b429\b/, /Retry-After/]},
        go: {all: [/maxBufferBytes/, /StatusTooManyRequests/, /Retry-After/]},
        scala: {all: [/MaxBufferBytes/, /\b429\b/, /Retry-After/]},
        cpp: {all: [/kMaxBufferBytes/, /\b429\b/, /Retry-After/]},
      },
    },
    {
      id: 'shed-before-append',
      title: 'Checks the cap before it appends',
      detail:
        '`over_cap` (or its equivalent) is evaluated before the append, so an overflowing buffer sheds instead of buffering. The draft appends first and asks questions never.',
      match: {
        python: {all: [/over_cap\(/], order: [/over_cap\(tenant, service\)/, /append\(tenant, service/]},
        typescript: {all: [/overCap\(/], order: [/overCap\(tenant, service\)/, /append\(tenant, service/]},
        go: {all: [/overCap\(/], order: [/overCap\(ctx, tenant, service\)/, /Append\(ctx, tenant, service/]},
        scala: {all: [/overCap\(/], order: [/overCap\(tenant, service\)/, /append\(tenant, service/]},
        cpp: {all: [/overCap\(/], order: [/overCap\(redis, tenant, service\)/, /append\(redis, tenant, service/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Redis buffer state for the index writer."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUFFER_BATCH = 1000
BUFFER_TTL_S = 60 * 60


def buffer_key(tenant: str, service: str) -> str:
    return f"buffer:{tenant}:{service}"


def bytes_used(tenant: str, service: str) -> int:
    return int(r.hget(buffer_key(tenant, service), "bytes") or 0)


def append(tenant: str, service: str, record_bytes: int, offset: str) -> None:
    # TODO: there is no byte cap and no back-pressure, the offset and the count move in separate
    # commands, and an overflowing buffer keeps growing instead of shedding. Review all three.
    key = buffer_key(tenant, service)
    r.hincrby(key, "count", 1)
    r.hincrby(key, "bytes", record_bytes)
    r.hset(key, "offset", offset)
    r.expire(key, BUFFER_TTL_S)


def offer(tenant: str, service: str, record_bytes: int, offset: str) -> dict:
    append(tenant, service, record_bytes, offset)
    return {"status": 202, "body": {"buffered": bytes_used(tenant, service)}}


def drain(tenant: str, service: str) -> list[str]:
    key = buffer_key(tenant, service)
    return [r.lpop(key) for _ in range(BUFFER_BATCH)]
`,
      solution: `"""Redis buffer state for the index writer: atomic appends, a byte cap, real back-pressure."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUFFER_BATCH = 1000  # records the writer drains per batch
MAX_BUFFER_BYTES = 64 << 20  # per-index cap; over it the ingest path sheds
BUFFER_TTL_S = 60 * 60
RETRY_AFTER_S = 1

# count, bytes and offset move inside one script: a crash can never leave them disagreeing, and
# the cap is enforced on the same round trip, so an over-cap append is a no-op instead of a write.
APPEND_LUA = """
local used = tonumber(redis.call('HGET', KEYS[1], 'bytes')) or 0
local want = tonumber(ARGV[2])
if used + want > tonumber(ARGV[1]) then
  return {0, used, tonumber(redis.call('HGET', KEYS[1], 'count')) or 0}
end
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HINCRBY', KEYS[1], 'bytes', want)
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, used + want, count}
"""


class BufferFull(Exception):
    """The index buffer is at or over its byte cap: the record must be shed, not buffered."""

    def __init__(self, used_bytes: int) -> None:
        super().__init__("buffer is over its byte cap")
        self.used_bytes = used_bytes


def buffer_key(tenant: str, service: str) -> str:
    return f"buffer:{tenant}:{service}"


def bytes_used(tenant: str, service: str) -> int:
    return int(r.hget(buffer_key(tenant, service), "bytes") or 0)


def over_cap(tenant: str, service: str) -> bool:
    return bytes_used(tenant, service) >= MAX_BUFFER_BYTES


def append(tenant: str, service: str, record_bytes: int, offset: str) -> int:
    allowed, used, count = r.eval(
        APPEND_LUA,
        1,
        buffer_key(tenant, service),
        MAX_BUFFER_BYTES,
        record_bytes,
        offset,
        BUFFER_TTL_S,
    )
    if int(allowed) == 0:
        raise BufferFull(int(used))
    return int(count)


def offer(tenant: str, service: str, record_bytes: int, offset: str) -> dict:
    """The ingest path: shed at the cap, otherwise append — never both."""
    if over_cap(tenant, service):
        return {
            "status": 429,
            "headers": {"Retry-After": str(RETRY_AFTER_S)},
            "body": {"error": "index buffer is over its byte cap", "retry_after": RETRY_AFTER_S},
        }
    count = append(tenant, service, record_bytes, offset)
    return {"status": 202, "body": {"buffered": count, "used_bytes": bytes_used(tenant, service)}}


def drain(tenant: str, service: str) -> list[str]:
    """One batch: the same script settles the count, the bytes and the offset."""
    key = buffer_key(tenant, service)
    count = min(BUFFER_BATCH, int(r.hget(key, "count") or 0))
    if count == 0:
        return []
    records = r.lrange(f"{key}:records", 0, count - 1)
    offset = r.hget(key, "offset")
    r.eval(
        """
local take = tonumber(ARGV[1])
redis.call('HINCRBY', KEYS[1], 'count', -take)
redis.call('HINCRBY', KEYS[1], 'bytes', -tonumber(ARGV[2]))
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
return redis.call('HGET', KEYS[1], 'count')
""",
        1,
        key,
        count,
        sum(len(record) for record in records),
        offset,
    )
    return records
`,
    },
    typescript: {
      starter: `/** Redis buffer state: a model-generated draft with no back-pressure. */
import {Redis} from 'ioredis';

export const redis = new Redis();

export const BUFFER_BATCH = 1000;
export const BUFFER_TTL_S = 60 * 60;

export const bufferKey = (tenant: string, service: string): string => \`buffer:\${tenant}:\${service}\`;

export async function bytesUsed(tenant: string, service: string): Promise<number> {
  return Number((await redis.hget(bufferKey(tenant, service), 'bytes')) ?? 0);
}

export async function append(
  tenant: string,
  service: string,
  recordBytes: number,
  offset: string,
): Promise<void> {
  // TODO: there is no byte cap and no back-pressure, the offset and the count move in separate
  // commands, and an overflowing buffer keeps growing instead of shedding. Review all three.
  const key = bufferKey(tenant, service);
  await redis.hincrby(key, 'count', 1);
  await redis.hincrby(key, 'bytes', recordBytes);
  await redis.hset(key, 'offset', offset);
  await redis.expire(key, BUFFER_TTL_S);
}

export async function offer(
  tenant: string,
  service: string,
  recordBytes: number,
  offset: string,
): Promise<{status: number; body: Record<string, unknown>}> {
  await append(tenant, service, recordBytes, offset);
  return {status: 202, body: {buffered: await bytesUsed(tenant, service)}};
}
`,
      solution: `/** Redis buffer state: atomic appends, a byte cap, and back-pressure the ingest path honours. */
import {Redis} from 'ioredis';

export const redis = new Redis();

export const BUFFER_BATCH = 1000; // records the writer drains per batch
export const MAX_BUFFER_BYTES = 64 << 20; // per-index cap; over it the ingest path sheds
export const BUFFER_TTL_S = 60 * 60;
export const RETRY_AFTER_S = 1;

// count, bytes and offset move inside one script: a crash can never leave them disagreeing, and
// the cap is enforced on the same round trip, so an over-cap append is a no-op instead of a write.
export const APPEND_LUA = \`
local used = tonumber(redis.call('HGET', KEYS[1], 'bytes')) or 0
local want = tonumber(ARGV[2])
if used + want > tonumber(ARGV[1]) then
  return {0, used, tonumber(redis.call('HGET', KEYS[1], 'count')) or 0}
end
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HINCRBY', KEYS[1], 'bytes', want)
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, used + want, count}
\`;

export interface Shed {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export class BufferFull extends Error {
  constructor(readonly usedBytes: number) {
    super('buffer is over its byte cap');
  }
}

export const bufferKey = (tenant: string, service: string): string => \`buffer:\${tenant}:\${service}\`;

export async function bytesUsed(tenant: string, service: string): Promise<number> {
  return Number((await redis.hget(bufferKey(tenant, service), 'bytes')) ?? 0);
}

export async function overCap(tenant: string, service: string): Promise<boolean> {
  return (await bytesUsed(tenant, service)) >= MAX_BUFFER_BYTES;
}

export async function append(
  tenant: string,
  service: string,
  recordBytes: number,
  offset: string,
): Promise<number> {
  const reply = (await redis.eval(
    APPEND_LUA,
    1,
    bufferKey(tenant, service),
    String(MAX_BUFFER_BYTES),
    String(recordBytes),
    offset,
    String(BUFFER_TTL_S),
  )) as number[];
  const [allowed, used, count] = reply;
  if (allowed === 0) throw new BufferFull(used);
  return count;
}

/** The ingest path: shed at the cap, otherwise append — never both. */
export async function offer(
  tenant: string,
  service: string,
  recordBytes: number,
  offset: string,
): Promise<Shed> {
  if (await overCap(tenant, service)) {
    return {
      status: 429,
      headers: {'Retry-After': String(RETRY_AFTER_S)},
      body: {error: 'index buffer is over its byte cap', retry_after: RETRY_AFTER_S},
    };
  }
  const count = await append(tenant, service, recordBytes, offset);
  return {status: 202, headers: {}, body: {buffered: count}};
}

export async function drain(tenant: string, service: string): Promise<string[]> {
  const key = bufferKey(tenant, service);
  const raw = await redis.hget(key, 'count');
  const count = Math.min(BUFFER_BATCH, Number(raw ?? 0));
  if (count === 0) return [];
  const records = await redis.lrange(key + ':records', 0, count - 1);
  const used = records.reduce((sum, record) => sum + Buffer.byteLength(record, 'utf8'), 0);
  await redis.eval(
    \`
local take = tonumber(ARGV[1])
redis.call('HINCRBY', KEYS[1], 'count', -take)
redis.call('HINCRBY', KEYS[1], 'bytes', -tonumber(ARGV[2]))
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
return redis.call('HGET', KEYS[1], 'count')
\`,
    1,
    key,
    String(count),
    String(used),
    (await redis.hget(key, 'offset')) ?? '',
  );
  return records;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	bufferBatch = 1000
	bufferTTLS  = 60 * 60
)

var rdb *redis.Client

func bufferKey(tenant, service string) string {
	return fmt.Sprintf("buffer:%s:%s", tenant, service)
}

func bytesUsed(ctx context.Context, tenant, service string) (int64, error) {
	used, err := rdb.HGet(ctx, bufferKey(tenant, service), "bytes").Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return used, err
}

// Append buffers one record for its index.
func Append(ctx context.Context, tenant, service string, recordBytes int64, offset string) error {
	// TODO: there is no byte cap and no back-pressure, the offset and the count move in separate
	// commands, and an overflowing buffer keeps growing instead of shedding. Review all three.
	key := bufferKey(tenant, service)
	if err := rdb.HIncrBy(ctx, key, "count", 1).Err(); err != nil {
		return err
	}
	if err := rdb.HIncrBy(ctx, key, "bytes", recordBytes).Err(); err != nil {
		return err
	}
	if err := rdb.HSet(ctx, key, "offset", offset).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, bufferTTLS*time.Second).Err()
}

// Offer is the ingest path's answer: 202 with the buffer total.
func Offer(ctx context.Context, tenant, service string, recordBytes int64, offset string) (map[string]any, error) {
	if err := Append(ctx, tenant, service, recordBytes, offset); err != nil {
		return nil, err
	}
	used, err := bytesUsed(ctx, tenant, service)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": 202, "body": map[string]any{"buffered": used}}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	bufferBatch    = 1000
	maxBufferBytes = 64 << 20
	bufferTTLS     = 60 * 60
	retryAfterS    = 1
)

var rdb *redis.Client

// count, bytes and offset move inside one script: a crash can never leave them disagreeing, and
// the cap is enforced on the same round trip, so an over-cap append is a no-op instead of a write.
var appendScript = redis.NewScript(\`
local used = tonumber(redis.call('HGET', KEYS[1], 'bytes')) or 0
local want = tonumber(ARGV[2])
if used + want > tonumber(ARGV[1]) then
  return {0, used, tonumber(redis.call('HGET', KEYS[1], 'count')) or 0}
end
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HINCRBY', KEYS[1], 'bytes', want)
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, used + want, count}
\`)

var drainScript = redis.NewScript(\`
local take = tonumber(ARGV[1])
redis.call('HINCRBY', KEYS[1], 'count', -take)
redis.call('HINCRBY', KEYS[1], 'bytes', -tonumber(ARGV[2]))
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
return redis.call('HGET', KEYS[1], 'count')
\`)

type BufferFull struct {
	UsedBytes int64
}

func (e *BufferFull) Error() string { return "buffer is over its byte cap" }

func bufferKey(tenant, service string) string {
	return fmt.Sprintf("buffer:%s:%s", tenant, service)
}

func bytesUsed(ctx context.Context, tenant, service string) (int64, error) {
	used, err := rdb.HGet(ctx, bufferKey(tenant, service), "bytes").Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return used, err
}

func overCap(ctx context.Context, tenant, service string) (bool, error) {
	used, err := bytesUsed(ctx, tenant, service)
	if err != nil {
		return false, err
	}
	return used >= maxBufferBytes, nil
}

// Append atomically bumps the count, the byte total and the offset of one index buffer.
func Append(ctx context.Context, tenant, service string, recordBytes int64, offset string) (int64, error) {
	values, err := appendScript.Run(
		ctx,
		rdb,
		[]string{bufferKey(tenant, service)},
		maxBufferBytes,
		recordBytes,
		offset,
		bufferTTLS,
	).Int64Slice()
	if err != nil {
		return 0, err
	}
	if values[0] == 0 {
		return 0, &BufferFull{UsedBytes: values[1]}
	}
	return values[2], nil
}

// Offer is the ingest path: shed at the cap, otherwise append — never both.
func Offer(ctx context.Context, tenant, service string, recordBytes int64, offset string) (map[string]any, error) {
	full, err := overCap(ctx, tenant, service)
	if err != nil {
		return nil, err
	}
	if full {
		used, _ := bytesUsed(ctx, tenant, service)
		return map[string]any{
			"status":  http.StatusTooManyRequests,
			"headers": map[string]string{"Retry-After": strconv.Itoa(retryAfterS)},
			"body":    map[string]any{"error": "index buffer is over its byte cap", "used_bytes": used},
		}, nil
	}
	count, err := Append(ctx, tenant, service, recordBytes, offset)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": 202, "body": map[string]any{"buffered": count}}, nil
}

// Drain takes one batch and settles count, bytes and offset in one script.
func Drain(ctx context.Context, tenant, service string) ([]string, error) {
	key := bufferKey(tenant, service)
	current, err := rdb.HGet(ctx, key, "count").Int64()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	count := int64(bufferBatch)
	if current < count {
		count = current
	}
	if count == 0 {
		return nil, nil
	}
	records, err := rdb.LRange(ctx, key+":records", 0, count-1).Result()
	if err != nil {
		return nil, err
	}
	offset, _ := rdb.HGet(ctx, key, "offset").Result()
	var used int64
	for _, record := range records {
		used += int64(len(record))
	}
	if err := drainScript.Run(ctx, rdb, []string{key}, count, used, offset).Err(); err != nil {
		return nil, err
	}
	return records, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object State {
  val BufferBatch = 1000
  val BufferTtlS = 60 * 60

  val jedis = new Jedis("redis", 6379)

  def bufferKey(tenant: String, service: String): String = s"buffer:$tenant:$service"

  def bytesUsed(tenant: String, service: String): Long =
    Option(jedis.hget(bufferKey(tenant, service), "bytes")).map(_.toLong).getOrElse(0L)

  // TODO: there is no byte cap and no back-pressure, the offset and the count move in separate
  // commands, and an overflowing buffer keeps growing instead of shedding. Review all three.
  def append(tenant: String, service: String, recordBytes: Long, offset: String): Unit = {
    val key = bufferKey(tenant, service)
    jedis.hincrBy(key, "count", 1L)
    jedis.hincrBy(key, "bytes", recordBytes)
    jedis.hset(key, "offset", offset)
    jedis.expire(key, BufferTtlS)
  }

  def offer(tenant: String, service: String, recordBytes: Long, offset: String): Map[String, Any] = {
    append(tenant, service, recordBytes, offset)
    Map("status" -> 202, "body" -> Map("buffered" -> bytesUsed(tenant, service)))
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

class BufferFull(val usedBytes: Long) extends RuntimeException("buffer is over its byte cap")

object State {
  val BufferBatch = 1000
  val MaxBufferBytes = 64L << 20
  val BufferTtlS = 60 * 60
  val RetryAfterS = 1

  val jedis = new Jedis("redis", 6379)

  // count, bytes and offset move inside one script: a crash can never leave them disagreeing, and
  // the cap is enforced on the same round trip, so an over-cap append is a no-op instead of a write.
  val AppendLua =
    """
      |local used = tonumber(redis.call('HGET', KEYS[1], 'bytes')) or 0
      |local want = tonumber(ARGV[2])
      |if used + want > tonumber(ARGV[1]) then
      |  return {0, used, tonumber(redis.call('HGET', KEYS[1], 'count')) or 0}
      |end
      |local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
      |redis.call('HINCRBY', KEYS[1], 'bytes', want)
      |redis.call('HSET', KEYS[1], 'offset', ARGV[3])
      |redis.call('EXPIRE', KEYS[1], ARGV[4])
      |return {1, used + want, count}
      |""".stripMargin

  def bufferKey(tenant: String, service: String): String = s"buffer:$tenant:$service"

  def bytesUsed(tenant: String, service: String): Long =
    Option(jedis.hget(bufferKey(tenant, service), "bytes")).map(_.toLong).getOrElse(0L)

  def overCap(tenant: String, service: String): Boolean = bytesUsed(tenant, service) >= MaxBufferBytes

  /** One atomic append: the count, the byte total and the offset move together. */
  def append(tenant: String, service: String, recordBytes: Long, offset: String): Long = {
    val result = jedis
      .eval(
        AppendLua,
        1,
        bufferKey(tenant, service),
        MaxBufferBytes.toString,
        recordBytes.toString,
        offset,
        BufferTtlS.toString
      )
      .asInstanceOf[java.util.List[Long]]
    if (result.get(0) == 0L) throw new BufferFull(result.get(1))
    result.get(2)
  }

  /** The ingest path: shed at the cap, otherwise append — never both. */
  def offer(tenant: String, service: String, recordBytes: Long, offset: String): Map[String, Any] = {
    if (overCap(tenant, service)) {
      Map(
        "status" -> 429,
        "headers" -> Map("Retry-After" -> RetryAfterS.toString),
        "body" -> Map("error" -> "index buffer is over its byte cap")
      )
    } else {
      Map("status" -> 202, "body" -> Map("buffered" -> append(tenant, service, recordBytes, offset)))
    }
  }

  /** One batch: the same script settles the count, the bytes and the offset. */
  def drain(tenant: String, service: String): List[String] = {
    val key = bufferKey(tenant, service)
    val current = Option(jedis.hget(key, "count")).map(_.toLong).getOrElse(0L)
    val take = math.min(BufferBatch.toLong, current)
    if (take == 0L) return Nil
    val records = jedis.lrange(key + ":records", 0, take - 1).toArray.toList.map(_.toString)
    val used = records.map(_.getBytes("UTF-8").length.toLong).sum
    jedis.eval(
      """
        |local take = tonumber(ARGV[1])
        |redis.call('HINCRBY', KEYS[1], 'count', -take)
        |redis.call('HINCRBY', KEYS[1], 'bytes', -tonumber(ARGV[2]))
        |redis.call('HSET', KEYS[1], 'offset', ARGV[3])
        |return redis.call('HGET', KEYS[1], 'count')
        |""".stripMargin,
      1,
      key,
      take.toString,
      used.toString,
      Option(jedis.hget(key, "offset")).getOrElse("")
    )
    records
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

constexpr long long kBufferBatch = 1000;
constexpr long long kBufferTtlS = 60 * 60;

std::string bufferKey(const std::string& tenant, const std::string& service) {
  return "buffer:" + tenant + ":" + service;
}

long long bytesUsed(sw::redis::Redis& redis, const std::string& tenant, const std::string& service) {
  auto raw = redis.hget(bufferKey(tenant, service), "bytes");
  return raw ? std::stoll(*raw) : 0;
}

// TODO: there is no byte cap and no back-pressure, the offset and the count move in separate
// commands, and an overflowing buffer keeps growing instead of shedding. Review all three.
void append(sw::redis::Redis& redis, const std::string& tenant, const std::string& service, long long recordBytes, const std::string& offset) {
  const auto key = bufferKey(tenant, service);
  redis.hincrby(key, "count", 1);
  redis.hincrby(key, "bytes", recordBytes);
  redis.hset(key, "offset", offset);
  redis.expire(key, kBufferTtlS);
}

json offer(sw::redis::Redis& redis, const std::string& tenant, const std::string& service, long long recordBytes, const std::string& offset) {
  append(redis, tenant, service, recordBytes, offset);
  return json{{"status", 202}, {"body", {{"buffered", bytesUsed(redis, tenant, service)}}}};
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kBufferBatch = 1000;
constexpr long long kMaxBufferBytes = 64LL << 20;
constexpr long long kBufferTtlS = 60 * 60;
constexpr int kRetryAfterS = 1;

// count, bytes and offset move inside one script: a crash can never leave them disagreeing, and
// the cap is enforced on the same round trip, so an over-cap append is a no-op instead of a write.
const char* kAppendLua = R"LUA(
local used = tonumber(redis.call('HGET', KEYS[1], 'bytes')) or 0
local want = tonumber(ARGV[2])
if used + want > tonumber(ARGV[1]) then
  return {0, used, tonumber(redis.call('HGET', KEYS[1], 'count')) or 0}
end
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HINCRBY', KEYS[1], 'bytes', want)
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, used + want, count}
)LUA";

const char* kDrainLua = R"LUA(
local take = tonumber(ARGV[1])
redis.call('HINCRBY', KEYS[1], 'count', -take)
redis.call('HINCRBY', KEYS[1], 'bytes', -tonumber(ARGV[2]))
redis.call('HSET', KEYS[1], 'offset', ARGV[3])
return redis.call('HGET', KEYS[1], 'count')
)LUA";

class BufferFull : public std::runtime_error {
 public:
  explicit BufferFull(long long used) : std::runtime_error("buffer is over its byte cap"), used_bytes(used) {}
  long long used_bytes;
};

std::string bufferKey(const std::string& tenant, const std::string& service) {
  return "buffer:" + tenant + ":" + service;
}

long long bytesUsed(sw::redis::Redis& redis, const std::string& tenant, const std::string& service) {
  auto raw = redis.hget(bufferKey(tenant, service), "bytes");
  return raw ? std::stoll(*raw) : 0;
}

bool overCap(sw::redis::Redis& redis, const std::string& tenant, const std::string& service) {
  return bytesUsed(redis, tenant, service) >= kMaxBufferBytes;
}

/** One atomic append: the count, the byte total and the offset move together. */
long long append(sw::redis::Redis& redis, const std::string& tenant, const std::string& service, long long recordBytes, const std::string& offset) {
  const auto result = redis.eval<std::vector<long long>>(
      kAppendLua,
      {bufferKey(tenant, service)},
      {kMaxBufferBytes, recordBytes, offset, kBufferTtlS});
  if (result[0] == 0) throw BufferFull{result[1]};
  return result[2];
}

/** The ingest path: shed at the cap, otherwise append — never both. */
json offer(sw::redis::Redis& redis, const std::string& tenant, const std::string& service, long long recordBytes, const std::string& offset) {
  if (overCap(redis, tenant, service)) {
    return json{
        {"status", 429},
        {"headers", {{"Retry-After", std::to_string(kRetryAfterS)}}},
        {"body", {{"error", "index buffer is over its byte cap"}}}};
  }
  return json{{"status", 202}, {"body", {{"buffered", append(redis, tenant, service, recordBytes, offset)}}}};
}

/** One batch: the same script settles the count, the bytes and the offset. */
std::vector<std::string> drain(sw::redis::Redis& redis, const std::string& tenant, const std::string& service) {
  const auto key = bufferKey(tenant, service);
  auto raw = redis.hget(key, "count");
  const long long current = raw ? std::stoll(*raw) : 0;
  const long long take = std::min(kBufferBatch, current);
  if (take == 0) return {};
  std::vector<std::string> records;
  redis.lrange(key + ":records", 0, take - 1, std::back_inserter(records));
  long long used = 0;
  for (const auto& record : records) used += static_cast<long long>(record.size());
  auto offset = redis.hget(key, "offset");
  redis.eval<std::string>(kDrainLua, {key}, {take, used, offset ? *offset : std::string()});
  return records;
}
`,
    },
  },
  hints: [
    "Back-pressure belongs to the buffer, not to the writer's hope. Compare the buffer's byte total with the `64 << 20` cap on the ingest path and answer **429** with `Retry-After` in seconds; the record is dropped by the caller instead of living in the ingest pod's heap.",
    'Three commands are three chances to crash: `HINCRBY count`, then `HINCRBY bytes`, then `HSET offset` can stop in the middle, and the buffer then reports a record it does not hold. One Lua `EVAL` (or one script object) does all three — and can enforce the cap on the same round trip, which makes an over-cap append a no-op write.',
    'The cap check has to happen before the append, not inside a retry afterwards. Keep the read cheap (`HGET bytes`) and let the script be the authority, so a race between two ingest requests cannot both pass an empty buffer and both write.',
  ],
  debrief: `The interviewer is testing whether you can make a buffer fail in a way that protects the tier in front of it. Three things are being checked. Atomicity: a record count, a byte total and an offset are one fact, so they move in one script — the draft's three commands are individually correct and collectively wrong after any crash. Back-pressure: a buffer with no cap is a shard outage that becomes an out-of-memory kill, so the ingest path must shed with 429 and Retry-After the moment the cap is reached, which is the only place the load can be refused cheaply. And direction: an overflow sheds instead of buffering, so the check runs before the write. Real pipelines add a per-tenant buffer quota, an older-than-the-search-outage retention policy that samples or drops low-severity records first, and a shed counter that is exported and alerted on.`,
};
