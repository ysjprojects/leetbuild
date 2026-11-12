import type {Step} from '@/lib/types';

import {APPEND_LUA, DRAIN_LUA, scalaLua} from '../support';

export const stateStep: Step = {
  id: 'state',
  title: 'A Redis buffer per index, capped and drained by scripts',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['api', 'redis', 'writer'],
  task: `## Task

**Starting point.** The starter is the buffer the ingest route and the writer share:
\`append_record(tenant, service, record)\` RPUSHes the record's JSON to \`buffer:{tenant}:{service}\`
and bumps \`count\`, \`bytes\` and \`offset\` in \`buffer:{tenant}:{service}:meta\` with three HINCRBYs,
returning the offset; \`drain_batch(tenant, service)\` reads the whole list, deletes it and zeroes
\`count\` and \`bytes\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A shard outage grows the buffer until the ingest pod is killed;
two appends racing for the last bytes under a cap both get in; one drain hands the writer every
record at once; and a record appended while a drain runs is deleted unread.

- \`MAX_BUFFER_BYTES\` is \`64 << 20\`: a record that would take \`bytes\` past it is shed, nothing
  written, and \`append_record\` returns **0**.
- The cap check and the writes are **one Lua script** (\`register_script\` or \`EVAL\`), so two
  appends cannot both pass the check.
- \`drain_batch\` takes at most \`BATCH_SIZE\` (1000) records, oldest first, and leaves the rest.
- The drain reads, trims and settles \`count\` and \`bytes\` in **one script**: an append that lands
  meanwhile stays in the buffer.`,
  sequence: {
    participants: ['Ingest API', 'Redis buffer', 'Buffered writer'],
    messages: [
      {
        from: 'Ingest API',
        to: 'Redis buffer',
        label: 'EVAL append: HGET bytes · cap · RPUSH · HINCRBY ×3',
        kind: 'sync',
      },
      {from: 'Redis buffer', to: 'Ingest API', label: 'offset · 0 when shed', kind: 'reply'},
      {
        from: 'Buffered writer',
        to: 'Redis buffer',
        label: 'EVAL drain: LRANGE 0 999 · LTRIM · HINCRBY −n',
        kind: 'sync',
      },
      {from: 'Redis buffer', to: 'Buffered writer', label: 'at most 1000 records', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'byte-cap',
      title: 'Sheds a record that would take the buffer past 64 MiB',
      detail:
        '`MAX_BUFFER_BYTES = 64 << 20`; a record that does not fit returns **0** and writes nothing (list, count, bytes and offset unchanged); the starter has no cap, so a stalled shard grows the buffer without bound.',
      match: {
        python: {all: [/MAX_BUFFER_BYTES\s*=\s*64\s*<<\s*20/, /return 0/]},
        typescript: {all: [/MAX_BUFFER_BYTES\s*=\s*64\s*<<\s*20/, /return 0/]},
        go: {all: [/maxBufferBytes\s*=\s*64\s*<<\s*20/, /return 0/]},
        scala: {all: [/MaxBufferBytes\s*:\s*Long\s*=\s*64L\s*<<\s*20/, /return 0/]},
        cpp: {all: [/kMaxBufferBytes\s*=\s*64LL\s*<<\s*20/, /return 0/]},
      },
    },
    {
      id: 'atomic-append',
      title: 'Checks the cap and appends in one Lua script',
      detail:
        'The append is one script that reads `bytes`, compares it with the cap and writes the list and the three counters; with separate commands, two appends racing for the last bytes under the cap both get in.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /HGET/], none: [/\br\.rpush\(/, /\br\.hincrby\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /HGET/], none: [/redis\.rpush\(/, /redis\.hincrby\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /HGET/], none: [/\.RPush\(/, /\.HIncrBy\(/]},
        scala: {all: [/jedis\.eval\(/, /HGET/], none: [/jedis\.rpush\(/, /jedis\.hincrBy\(/]},
        cpp: {all: [/redis\.eval</, /HGET/], none: [/redis\.rpush\(/, /redis\.hincrby\(/]},
      },
    },
    {
      id: 'drain-batch',
      title: 'Drains at most 1000 records, oldest first',
      detail:
        '`BATCH_SIZE = 1000`: a drain returns the oldest 1000 records and leaves the rest with `count` and `bytes` describing them; the starter returns the whole list, however long an outage made it.',
      match: {
        python: {all: [/BATCH_SIZE\s*=\s*1000/, /LTRIM/], none: [/\.lrange\(/]},
        typescript: {all: [/BATCH_SIZE\s*=\s*1000/, /LTRIM/], none: [/\.lrange\(/]},
        go: {all: [/batchSize\s*=\s*1000/, /LTRIM/], none: [/\.LRange\(/]},
        scala: {all: [/BatchSize\s*=\s*1000/, /LTRIM/], none: [/\.lrange\(/]},
        cpp: {all: [/kBatchSize\s*=\s*1000/, /LTRIM/], none: [/\.lrange\(/]},
      },
    },
    {
      id: 'drain-atomic',
      title: 'Loses nothing appended while a drain runs',
      detail:
        'The drain reads, trims and settles the counters in one script, so a record appended between its read and its delete is not deleted unread; the starter reads, then DELs the whole list.',
      match: {
        python: {all: [/LTRIM/, /register_script\(|\.eval\(/], none: [/\.delete\(/]},
        typescript: {all: [/LTRIM/, /defineCommand\(|\.eval\(/], none: [/\.del\(/]},
        go: {all: [/LTRIM/, /redis\.NewScript\(|\.Eval\(/], none: [/\.Del\(/]},
        scala: {all: [/LTRIM/, /jedis\.eval\(/], none: [/\.del\(/]},
        cpp: {all: [/LTRIM/, /redis\.eval/], none: [/\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def buffer_key(tenant: str, service: str) -> str:
    return f"buffer:{tenant}:{service}"


def meta_key(tenant: str, service: str) -> str:
    return f"buffer:{tenant}:{service}:meta"


def append_record(tenant: str, service: str, record: dict) -> int:
    """Buffer one record (service, timestamp, level, message); its offset, or 0 when it was shed."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    raw = json.dumps(record)
    r.rpush(buffer_key(tenant, service), raw)
    r.hincrby(meta_key(tenant, service), "count", 1)
    r.hincrby(meta_key(tenant, service), "bytes", len(raw.encode("utf-8")))
    return r.hincrby(meta_key(tenant, service), "offset", 1)


def drain_batch(tenant: str, service: str) -> list[dict]:
    """Take the buffered records, oldest first."""
    batch = r.lrange(buffer_key(tenant, service), 0, -1)
    r.delete(buffer_key(tenant, service))
    r.hset(meta_key(tenant, service), mapping={"count": 0, "bytes": 0})
    return [json.loads(raw) for raw in batch]
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_BUFFER_BYTES = 64 << 20
BATCH_SIZE = 1000

# The cap check and the writes are one script: no other client runs between them.
APPEND_LUA = """
${APPEND_LUA}
"""

# Read, trim and settle in one script: an append that lands meanwhile stays in the list.
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
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {LogRecord} from 'logindex/buffer';

const redis = new Redis({host: 'redis', port: 6379});

export const bufferKey = (tenant: string, service: string): string => \`buffer:\${tenant}:\${service}\`;
export const metaKey = (tenant: string, service: string): string => \`buffer:\${tenant}:\${service}:meta\`;

/** Buffer one record; its offset, or 0 when it was shed. */
export async function appendRecord(tenant: string, service: string, record: LogRecord): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const raw = JSON.stringify(record);
  await redis.rpush(bufferKey(tenant, service), raw);
  await redis.hincrby(metaKey(tenant, service), 'count', 1);
  await redis.hincrby(metaKey(tenant, service), 'bytes', Buffer.byteLength(raw));
  return redis.hincrby(metaKey(tenant, service), 'offset', 1);
}

/** Take the buffered records, oldest first. */
export async function drainBatch(tenant: string, service: string): Promise<LogRecord[]> {
  const batch = await redis.lrange(bufferKey(tenant, service), 0, -1);
  await redis.del(bufferKey(tenant, service));
  await redis.hset(metaKey(tenant, service), {count: 0, bytes: 0});
  return batch.map(raw => JSON.parse(raw) as LogRecord);
}
`,
      solution: `import Redis from 'ioredis';

import type {LogRecord} from 'logindex/buffer';

export const MAX_BUFFER_BYTES = 64 << 20;
export const BATCH_SIZE = 1000;

// The cap check and the writes are one script: no other client runs between them.
const APPEND_LUA = \`
${APPEND_LUA}
\`;

// Read, trim and settle in one script: an append that lands meanwhile stays in the list.
const DRAIN_LUA = \`
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
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"logindex/buffer" // buffer.Record
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func bufferKey(tenant, service string) string { return "buffer:" + tenant + ":" + service }
func metaKey(tenant, service string) string   { return "buffer:" + tenant + ":" + service + ":meta" }

// appendRecord buffers one record: its offset, or 0 when it was shed.
func appendRecord(ctx context.Context, tenant, service string, record buffer.Record) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	raw, err := json.Marshal(record)
	if err != nil {
		return 0, err
	}
	if err := rdb.RPush(ctx, bufferKey(tenant, service), string(raw)).Err(); err != nil {
		return 0, err
	}
	rdb.HIncrBy(ctx, metaKey(tenant, service), "count", 1)
	rdb.HIncrBy(ctx, metaKey(tenant, service), "bytes", int64(len(raw)))
	return rdb.HIncrBy(ctx, metaKey(tenant, service), "offset", 1).Result()
}

// drainBatch takes the buffered records, oldest first.
func drainBatch(ctx context.Context, tenant, service string) ([]buffer.Record, error) {
	raw, err := rdb.LRange(ctx, bufferKey(tenant, service), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rdb.Del(ctx, bufferKey(tenant, service))
	rdb.HSet(ctx, metaKey(tenant, service), "count", 0, "bytes", 0)
	batch := make([]buffer.Record, 0, len(raw))
	for _, item := range raw {
		var record buffer.Record
		if err := json.Unmarshal([]byte(item), &record); err != nil {
			return nil, err
		}
		batch = append(batch, record)
	}
	return batch, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"logindex/buffer" // buffer.Record
)

const (
	maxBufferBytes = 64 << 20
	batchSize      = 1000
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The cap check and the writes are one script: no other client runs between them.
var appendScript = redis.NewScript(\`
${APPEND_LUA}
\`)

// Read, trim and settle in one script: an append that lands meanwhile stays in the list.
var drainScript = redis.NewScript(\`
${DRAIN_LUA}
\`)

func bufferKey(tenant, service string) string { return "buffer:" + tenant + ":" + service }
func metaKey(tenant, service string) string   { return "buffer:" + tenant + ":" + service + ":meta" }

// appendRecord buffers one record: its offset, or 0 when it was shed.
func appendRecord(ctx context.Context, tenant, service string, record buffer.Record) (int64, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return 0, err
	}
	return appendScript.Run(ctx, rdb, []string{bufferKey(tenant, service), metaKey(tenant, service)}, string(raw), maxBufferBytes).Int64()
}

// drainBatch takes the oldest batchSize records at most, oldest first.
func drainBatch(ctx context.Context, tenant, service string) ([]buffer.Record, error) {
	raw, err := drainScript.Run(ctx, rdb, []string{bufferKey(tenant, service), metaKey(tenant, service)}, batchSize).StringSlice()
	if err != nil {
		return nil, err
	}
	batch := make([]buffer.Record, 0, len(raw))
	for _, item := range raw {
		var record buffer.Record
		if err := json.Unmarshal([]byte(item), &record); err != nil {
			return nil, err
		}
		batch = append(batch, record)
	}
	return batch, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import logindex.Buffer // Buffer.Record and its JSON format

object State {
  import Buffer.recordFormat

  val jedis = new JedisPooled("redis", 6379)

  def bufferKey(tenant: String, service: String): String = s"buffer:$tenant:$service"
  def metaKey(tenant: String, service: String): String = s"buffer:$tenant:$service:meta"

  /** Buffer one record: its offset, or 0 when it was shed. */
  def appendRecord(tenant: String, service: String, record: Buffer.Record): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val raw = record.toJson.compactPrint
    jedis.rpush(bufferKey(tenant, service), raw)
    jedis.hincrBy(metaKey(tenant, service), "count", 1L)
    jedis.hincrBy(metaKey(tenant, service), "bytes", raw.getBytes("UTF-8").length.toLong)
    jedis.hincrBy(metaKey(tenant, service), "offset", 1L)
  }

  /** Take the buffered records, oldest first. */
  def drainBatch(tenant: String, service: String): Seq[Buffer.Record] = {
    val batch = jedis.lrange(bufferKey(tenant, service), 0, -1).asScala.toSeq
    jedis.del(bufferKey(tenant, service))
    jedis.hset(metaKey(tenant, service), Map("count" -> "0", "bytes" -> "0").asJava)
    batch.map(_.parseJson.convertTo[Buffer.Record])
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import logindex.Buffer // Buffer.Record and its JSON format

object State {
  import Buffer.recordFormat

  val MaxBufferBytes: Long = 64L << 20
  val BatchSize = 1000

  val jedis = new JedisPooled("redis", 6379)

  /** The cap check and the writes are one script: no other client runs between them. */
  val AppendLua: String =
    """${scalaLua(APPEND_LUA)}
      |""".stripMargin

  /** Read, trim and settle in one script: an append that lands meanwhile stays in the list. */
  val DrainLua: String =
    """${scalaLua(DRAIN_LUA)}
      |""".stripMargin

  def bufferKey(tenant: String, service: String): String = s"buffer:$tenant:$service"
  def metaKey(tenant: String, service: String): String = s"buffer:$tenant:$service:meta"

  /** Buffer one record: its offset, or 0 when it was shed. */
  def appendRecord(tenant: String, service: String, record: Buffer.Record): Long = {
    val keys = List(bufferKey(tenant, service), metaKey(tenant, service)).asJava
    jedis.eval(AppendLua, keys, List(record.toJson.compactPrint, MaxBufferBytes.toString).asJava).asInstanceOf[java.lang.Long]
  }

  /** Take the oldest BatchSize records at most, oldest first. */
  def drainBatch(tenant: String, service: String): Seq[Buffer.Record] = {
    val keys = List(bufferKey(tenant, service), metaKey(tenant, service)).asJava
    val raw = jedis.eval(DrainLua, keys, List(BatchSize.toString).asJava).asInstanceOf[java.util.List[String]]
    raw.asScala.toSeq.map(_.parseJson.convertTo[Buffer.Record])
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "logindex/buffer.h"  // buffer::Record, buffer::toJson, buffer::fromJson

sw::redis::Redis redis("tcp://redis:6379");

std::string bufferKey(const std::string& tenant, const std::string& service) { return "buffer:" + tenant + ":" + service; }
std::string metaKey(const std::string& tenant, const std::string& service) { return "buffer:" + tenant + ":" + service + ":meta"; }

// Buffer one record: its offset, or 0 when it was shed.
long long appendRecord(const std::string& tenant, const std::string& service, const buffer::Record& record) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string raw = buffer::toJson(record).dump();
  redis.rpush(bufferKey(tenant, service), raw);
  redis.hincrby(metaKey(tenant, service), "count", 1);
  redis.hincrby(metaKey(tenant, service), "bytes", static_cast<long long>(raw.size()));
  return redis.hincrby(metaKey(tenant, service), "offset", 1);
}

// Take the buffered records, oldest first.
std::vector<buffer::Record> drainBatch(const std::string& tenant, const std::string& service) {
  std::vector<std::string> raw;
  redis.lrange(bufferKey(tenant, service), 0, -1, std::back_inserter(raw));
  redis.del(bufferKey(tenant, service));
  redis.hset(metaKey(tenant, service), {{"count", "0"}, {"bytes", "0"}});
  std::vector<buffer::Record> batch;
  for (const std::string& item : raw) batch.push_back(buffer::fromJson(nlohmann::json::parse(item)));
  return batch;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "logindex/buffer.h"  // buffer::Record, buffer::toJson, buffer::fromJson

constexpr long long kMaxBufferBytes = 64LL << 20;
constexpr long long kBatchSize = 1000;

// The cap check and the writes are one script: no other client runs between them.
const std::string kAppendLua = R"lua(
${APPEND_LUA}
)lua";

// Read, trim and settle in one script: an append that lands meanwhile stays in the list.
const std::string kDrainLua = R"lua(
${DRAIN_LUA}
)lua";

sw::redis::Redis redis("tcp://redis:6379");

std::string bufferKey(const std::string& tenant, const std::string& service) { return "buffer:" + tenant + ":" + service; }
std::string metaKey(const std::string& tenant, const std::string& service) { return "buffer:" + tenant + ":" + service + ":meta"; }

// Buffer one record: its offset, or 0 when it was shed.
long long appendRecord(const std::string& tenant, const std::string& service, const buffer::Record& record) {
  return redis.eval<long long>(kAppendLua, {bufferKey(tenant, service), metaKey(tenant, service)}, {buffer::toJson(record).dump(), std::to_string(kMaxBufferBytes)});
}

// Take the oldest kBatchSize records at most, oldest first.
std::vector<buffer::Record> drainBatch(const std::string& tenant, const std::string& service) {
  std::vector<std::string> raw;
  redis.eval(kDrainLua, {bufferKey(tenant, service), metaKey(tenant, service)}, {std::to_string(kBatchSize)}, std::back_inserter(raw));
  std::vector<buffer::Record> batch;
  for (const std::string& item : raw) batch.push_back(buffer::fromJson(nlohmann::json::parse(item)));
  return batch;
}
`,
    },
  },
  harness: {
    python: `import json

KEY = "buffer:acme:checkout"
META = "buffer:acme:checkout:meta"
MAX = 64 << 20


def _rec(message):
    return {"service": "checkout", "timestamp": "2026-11-03T10:00:00Z", "level": "error", "message": message}


def _size(raw):
    return len(raw.encode("utf-8"))


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def _consistent(ctx, when):
    rows = ctx.redis.lrange(KEY, 0, -1)
    meta = ctx.redis.hgetall(META)
    count, used = int(meta.get("count", 0)), int(meta.get("bytes", 0))
    assert count == len(rows), f"{when}: {META} says count {count} while {KEY} holds {len(rows)} records"
    assert used == sum(_size(x) for x in rows), f"{when}: {META} says bytes {used} while the records in {KEY} take {sum(_size(x) for x in rows)}"
    return rows


def check_byte_cap(ctx):
    m = ctx.load("state")
    assert m.append_record("acme", "checkout", _rec("m-0")) == 1, "the first append into an empty buffer must return offset 1"
    first = ctx.redis.lrange(KEY, 0, -1)
    ctx.redis.hincrby(META, "bytes", MAX - 100 - _size(first[0]))
    meta_before = ctx.redis.hgetall(META)
    shed = m.append_record("acme", "checkout", _rec("m-1 " + "x" * 200))
    assert shed == 0, f"with 100 bytes left under the 64 MiB cap a 300-byte record was appended (returned {shed}): it must be shed and return 0"
    assert ctx.redis.lrange(KEY, 0, -1) == first, f"a shed record must not reach {KEY}, which now holds {ctx.redis.llen(KEY)} records"
    assert ctx.redis.hgetall(META) == meta_before, f"a shed record must leave {META} as it was: {meta_before} became {ctx.redis.hgetall(META)}"
    assert m.append_record("acme", "billing", _rec("m-2")) == 1, "another index's buffer has its own cap: its first append must return offset 1"


def check_atomic_append(ctx):
    m = ctx.load("state")
    ctx.redis.hset(META, mapping={"count": 0, "bytes": MAX - 350, "offset": 0})
    record = _rec("x" * 150)
    # A second append lands right after this one's first command on the meta hash.
    rival = ctx.redis_after(META, lambda: m.append_record("acme", "checkout", record))
    first = m.append_record("acme", "checkout", record)
    second = _settled(rival, META)
    offsets = sorted([first, second])
    assert offsets[0] == 0 and offsets[1] > 0, f"two appends raced for the last 350 bytes under the cap, where one record fits, and returned {first} and {second}: exactly one must be shed (0). Check the cap and write in one script"
    used = int(ctx.redis.hget(META, "bytes"))
    assert used <= MAX, f"{META} says bytes {used}, past the 64 MiB cap by {used - MAX}"
    assert ctx.redis.llen(KEY) == 1, f"{KEY} holds {ctx.redis.llen(KEY)} records after the race, expected the one that fit"


def check_drain_batch(ctx):
    m = ctx.load("state")
    rows = [json.dumps(_rec(f"m-{i}")) for i in range(1005)]
    ctx.redis.rpush(KEY, *rows)
    ctx.redis.hset(META, mapping={"count": 1005, "bytes": sum(_size(x) for x in rows), "offset": 1005})
    batch = m.drain_batch("acme", "checkout")
    assert len(batch) == 1000, f"a drain of 1005 buffered records returned {len(batch)}, expected BATCH_SIZE = 1000"
    assert batch[0].get("message") == "m-0" and batch[-1].get("message") == "m-999", f"a drain must take the oldest records in order, it returned {batch[0].get('message')} … {batch[-1].get('message')}"
    left = _consistent(ctx, "after the first drain")
    assert [json.loads(x)["message"] for x in left] == [f"m-{i}" for i in range(1000, 1005)], f"{KEY} must keep the 5 newest records, it holds {len(left)}"
    rest = m.drain_batch("acme", "checkout")
    assert [r.get("message") for r in rest] == [f"m-{i}" for i in range(1000, 1005)], f"the second drain returned {len(rest)} records, expected the 5 left"
    assert _consistent(ctx, "after the second drain") == []
    assert m.drain_batch("acme", "checkout") == [], "a drain of an empty buffer must return no records"


def check_drain_atomic(ctx):
    m = ctx.load("state")
    for i in range(3):
        m.append_record("acme", "checkout", _rec(f"m-{i}"))
    # An ingest lands while the drain is between its commands.
    late = ctx.redis_after(KEY, lambda: m.append_record("acme", "checkout", _rec("late")))
    batch = m.drain_batch("acme", "checkout")
    _settled(late, KEY)
    left = _consistent(ctx, "after a drain raced an append")
    seen = sorted([r.get("message") for r in batch] + [json.loads(x)["message"] for x in left])
    assert seen == ["late", "m-0", "m-1", "m-2"], f"a record appended while the drain ran was lost: the drain returned {[r.get('message') for r in batch]} and {KEY} holds {[json.loads(x)['message'] for x in left]}"
`,
    typescript: `const KEY = 'buffer:acme:checkout';
const META = 'buffer:acme:checkout:meta';
const MAX = 64 * 1024 * 1024;

const rec = (message: string) => ({service: 'checkout', timestamp: '2026-11-03T10:00:00Z', level: 'error', message});
const size = (raw: string): number => new TextEncoder().encode(raw).length;

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

function consistent(ctx, when: string): string[] {
  const rows: string[] = ctx.redis.lrange(KEY, 0, -1);
  const meta = ctx.redis.hgetall(META);
  const count = Number(meta.count ?? 0);
  const used = Number(meta.bytes ?? 0);
  const total = rows.reduce((sum, x) => sum + size(x), 0);
  assert.equal(count, rows.length, \`\${when}: \${META} says count \${count} while \${KEY} holds \${rows.length} records\`);
  assert.equal(used, total, \`\${when}: \${META} says bytes \${used} while the records in \${KEY} take \${total}\`);
  return rows;
}

export async function check_byte_cap(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.appendRecord('acme', 'checkout', rec('m-0')), 1, 'the first append into an empty buffer must return offset 1');
  const first = ctx.redis.lrange(KEY, 0, -1);
  ctx.redis.hincrby(META, 'bytes', MAX - 100 - size(first[0]));
  const before = JSON.stringify(ctx.redis.hgetall(META));
  const shed = await m.appendRecord('acme', 'checkout', rec('m-1 ' + 'x'.repeat(200)));
  assert.equal(shed, 0, \`with 100 bytes left under the 64 MiB cap a 300-byte record was appended (returned \${shed}): it must be shed and return 0\`);
  assert.deepStrictEqual(ctx.redis.lrange(KEY, 0, -1), first, \`a shed record must not reach \${KEY}, which now holds \${ctx.redis.llen(KEY)} records\`);
  assert.equal(JSON.stringify(ctx.redis.hgetall(META)), before, \`a shed record must leave \${META} as it was: \${before} became \${JSON.stringify(ctx.redis.hgetall(META))}\`);
  assert.equal(await m.appendRecord('acme', 'billing', rec('m-2')), 1, "another index's buffer has its own cap: its first append must return offset 1");
}

export async function check_atomic_append(ctx) {
  const m = ctx.load('state');
  ctx.redis.hset(META, 'count', 0, 'bytes', MAX - 350, 'offset', 0);
  const record = rec('x'.repeat(150));
  // A second append lands right after this one's first command on the meta hash.
  const rival = ctx.redisAfter(META, () => m.appendRecord('acme', 'checkout', record));
  const first = await m.appendRecord('acme', 'checkout', record);
  const second = await settled(rival, META);
  const offsets = [Number(first), Number(second)].sort((a, b) => a - b);
  assert(offsets[0] === 0 && offsets[1] > 0, \`two appends raced for the last 350 bytes under the cap, where one record fits, and returned \${first} and \${second}: exactly one must be shed (0). Check the cap and write in one script\`);
  const used = Number(ctx.redis.hget(META, 'bytes'));
  assert(used <= MAX, \`\${META} says bytes \${used}, past the 64 MiB cap by \${used - MAX}\`);
  assert.equal(ctx.redis.llen(KEY), 1, \`\${KEY} holds \${ctx.redis.llen(KEY)} records after the race, expected the one that fit\`);
}

export async function check_drain_batch(ctx) {
  const m = ctx.load('state');
  const rows = Array.from({length: 1005}, (_, i) => JSON.stringify(rec(\`m-\${i}\`)));
  ctx.redis.rpush(KEY, ...rows);
  ctx.redis.hset(META, 'count', 1005, 'bytes', rows.reduce((sum, x) => sum + size(x), 0), 'offset', 1005);
  const batch = await m.drainBatch('acme', 'checkout');
  assert.equal(batch.length, 1000, \`a drain of 1005 buffered records returned \${batch.length}, expected BATCH_SIZE = 1000\`);
  assert(batch[0].message === 'm-0' && batch[999].message === 'm-999', \`a drain must take the oldest records in order, it returned \${batch[0]?.message} … \${batch[batch.length - 1]?.message}\`);
  const left = consistent(ctx, 'after the first drain');
  const want = Array.from({length: 5}, (_, i) => \`m-\${1000 + i}\`);
  assert.deepStrictEqual(left.map(x => JSON.parse(x).message), want, \`\${KEY} must keep the 5 newest records, it holds \${left.length}\`);
  const rest = await m.drainBatch('acme', 'checkout');
  assert.deepStrictEqual(rest.map(r => r.message), want, \`the second drain returned \${rest.length} records, expected the 5 left\`);
  assert.deepStrictEqual(consistent(ctx, 'after the second drain'), []);
  assert.deepStrictEqual(await m.drainBatch('acme', 'checkout'), [], 'a drain of an empty buffer must return no records');
}

export async function check_drain_atomic(ctx) {
  const m = ctx.load('state');
  for (let i = 0; i < 3; i += 1) await m.appendRecord('acme', 'checkout', rec(\`m-\${i}\`));
  // An ingest lands while the drain is between its commands.
  const late = ctx.redisAfter(KEY, () => m.appendRecord('acme', 'checkout', rec('late')));
  const batch = await m.drainBatch('acme', 'checkout');
  await settled(late, KEY);
  const left = consistent(ctx, 'after a drain raced an append');
  const seen = [...batch.map(r => r.message), ...left.map(x => JSON.parse(x).message)].sort();
  assert.deepStrictEqual(seen, ['late', 'm-0', 'm-1', 'm-2'], \`a record appended while the drain ran was lost: the drain returned \${JSON.stringify(batch.map(r => r.message))} and \${KEY} holds \${JSON.stringify(left.map(x => JSON.parse(x).message))}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"logindex/buffer"

	"leetbuild/harness"
)

const (
	stateKey  = "buffer:acme:checkout"
	stateMeta = "buffer:acme:checkout:meta"
	stateMax  = 64 << 20
)

var stateBg = context.Background()

func rec(message string) buffer.Record {
	return buffer.Record{Service: "checkout", Timestamp: "2026-11-03T10:00:00Z", Level: "error", Message: message}
}

func mustAppend(ctx *harness.Ctx, service string, r buffer.Record) int64 {
	offset, err := appendRecord(stateBg, "acme", service, r)
	ctx.NoError(err, "appendRecord(acme, %s) failed", service)
	return offset
}

func mustDrain(ctx *harness.Ctx) []buffer.Record {
	batch, err := drainBatch(stateBg, "acme", "checkout")
	ctx.NoError(err, "drainBatch(acme, checkout) failed")
	return batch
}

func messageOf(raw string) string {
	var r buffer.Record
	json.Unmarshal([]byte(raw), &r)
	return r.Message
}

func consistent(ctx *harness.Ctx, when string) []string {
	rows := ctx.Redis.LRange(stateKey, 0, -1)
	meta := ctx.Redis.HGetAll(stateMeta)
	count, _ := strconv.Atoi(meta["count"])
	used, _ := strconv.Atoi(meta["bytes"])
	total := 0
	for _, x := range rows {
		total += len(x)
	}
	ctx.Equal(count, len(rows), "%s: the count in %s against the records in %s", when, stateMeta, stateKey)
	ctx.Equal(used, total, "%s: the bytes in %s against the size of the records in %s", when, stateMeta, stateKey)
	return rows
}

func CheckByteCap(ctx *harness.Ctx) {
	ctx.Equal(mustAppend(ctx, "checkout", rec("m-0")), int64(1), "the first append into an empty buffer must return offset 1")
	first := ctx.Redis.LRange(stateKey, 0, -1)
	ctx.Redis.Do("HINCRBY", stateMeta, "bytes", stateMax-100-len(first[0]))
	before := ctx.Redis.HGetAll(stateMeta)
	shed := mustAppend(ctx, "checkout", rec("m-1 "+strings.Repeat("x", 200)))
	ctx.Equal(shed, int64(0), "with 100 bytes left under the 64 MiB cap a 300-byte record must be shed; appendRecord's return")
	ctx.Equal(ctx.Redis.LRange(stateKey, 0, -1), first, "a shed record must not reach %s; its records", stateKey)
	ctx.Equal(ctx.Redis.HGetAll(stateMeta), before, "a shed record must leave %s as it was", stateMeta)
	ctx.Equal(mustAppend(ctx, "billing", rec("m-2")), int64(1), "another index's buffer has its own cap: its first append must return offset 1")
}

func CheckAtomicAppend(ctx *harness.Ctx) {
	ctx.Redis.Do("HSET", stateMeta, "count", 0, "bytes", stateMax-350, "offset", 0)
	r := rec(strings.Repeat("x", 150))
	// A second append lands right after this one's first command on the meta hash.
	rival := ctx.Redis.After(stateMeta, func() any {
		offset, err := appendRecord(stateBg, "acme", "checkout", r)
		ctx.NoError(err, "the rival append failed")
		return offset
	})
	first := mustAppend(ctx, "checkout", r)
	ctx.Assert(rival.Fired, "nothing touched %s", stateMeta)
	ctx.Assert(rival.Err == nil, "the rival append failed: %v", rival.Err)
	second, _ := rival.Result.(int64)
	offsets := []int64{first, second}
	sort.Slice(offsets, func(i, j int) bool { return offsets[i] < offsets[j] })
	ctx.Assert(offsets[0] == 0 && offsets[1] > 0, "two appends raced for the last 350 bytes under the cap, where one record fits, and returned %d and %d: exactly one must be shed (0). Check the cap and write in one script", first, second)
	used, _ := ctx.Redis.HGet(stateMeta, "bytes")
	n, _ := strconv.Atoi(used)
	ctx.Assert(n <= stateMax, "%s says bytes %d, past the 64 MiB cap by %d", stateMeta, n, n-stateMax)
	ctx.Equal(ctx.Redis.LLen(stateKey), int64(1), "after the race %s must hold the one record that fit; its records", stateKey)
}

func CheckDrainBatch(ctx *harness.Ctx) {
	args := []any{"RPUSH", stateKey}
	total := 0
	for i := 0; i < 1005; i++ {
		raw, _ := json.Marshal(rec(fmt.Sprintf("m-%d", i)))
		args = append(args, string(raw))
		total += len(raw)
	}
	ctx.Redis.Do(args...)
	ctx.Redis.Do("HSET", stateMeta, "count", 1005, "bytes", total, "offset", 1005)
	batch := mustDrain(ctx)
	ctx.Equal(len(batch), 1000, "a drain of 1005 buffered records must return batchSize = 1000; the records drained")
	ctx.Assert(batch[0].Message == "m-0" && batch[len(batch)-1].Message == "m-999", "a drain must take the oldest records in order, it returned %s … %s", batch[0].Message, batch[len(batch)-1].Message)
	left := consistent(ctx, "after the first drain")
	want := []string{"m-1000", "m-1001", "m-1002", "m-1003", "m-1004"}
	var kept []string
	for _, x := range left {
		kept = append(kept, messageOf(x))
	}
	ctx.Equal(kept, want, "%s must keep the 5 newest records", stateKey)
	rest := mustDrain(ctx)
	var got []string
	for _, r := range rest {
		got = append(got, r.Message)
	}
	ctx.Equal(got, want, "the second drain must return the 5 records left")
	ctx.Equal(len(consistent(ctx, "after the second drain")), 0, "the records left after the second drain")
	ctx.Equal(len(mustDrain(ctx)), 0, "a drain of an empty buffer; the records it returned")
}

func CheckDrainAtomic(ctx *harness.Ctx) {
	for i := 0; i < 3; i++ {
		mustAppend(ctx, "checkout", rec(fmt.Sprintf("m-%d", i)))
	}
	// An ingest lands while the drain is between its commands.
	late := ctx.Redis.After(stateKey, func() any {
		offset, err := appendRecord(stateBg, "acme", "checkout", rec("late"))
		ctx.NoError(err, "the late append failed")
		return offset
	})
	batch := mustDrain(ctx)
	ctx.Assert(late.Fired, "nothing touched %s", stateKey)
	ctx.Assert(late.Err == nil, "the late append failed: %v", late.Err)
	left := consistent(ctx, "after a drain raced an append")
	var drained, kept []string
	for _, r := range batch {
		drained = append(drained, r.Message)
	}
	for _, x := range left {
		kept = append(kept, messageOf(x))
	}
	seen := append(append([]string{}, drained...), kept...)
	sort.Strings(seen)
	ctx.Equal(seen, []string{"late", "m-0", "m-1", "m-2"}, "a record appended while the drain ran was lost (the drain returned %v, %s holds %v); every record", drained, stateKey, kept)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "logindex/buffer.h"

namespace {

const std::string kKey = "buffer:acme:checkout";
const std::string kMeta = "buffer:acme:checkout:meta";
constexpr long long kMax = 64LL << 20;

buffer::Record rec(const std::string& message) { return {"checkout", "2026-11-03T10:00:00Z", "error", message}; }

std::string messageOf(const std::string& raw) { return nlohmann::json::parse(raw, nullptr, false).value("message", ""); }

long long field(const std::map<std::string, std::string>& meta, const std::string& name) {
  return meta.count(name) && !meta.at(name).empty() ? std::stoll(meta.at(name)) : 0;
}

std::vector<std::string> consistent(harness::Ctx& ctx, const std::string& when) {
  const auto rows = ctx.Redis.LRange(kKey, 0, -1);
  const auto meta = ctx.Redis.HGetAll(kMeta);
  long long total = 0;
  for (const auto& x : rows) total += static_cast<long long>(x.size());
  ctx.Equal(field(meta, "count"), static_cast<long long>(rows.size()), "%s: the count in %s against the records in %s", when, kMeta, kKey);
  ctx.Equal(field(meta, "bytes"), total, "%s: the bytes in %s against the size of the records in %s", when, kMeta, kKey);
  return rows;
}

// A probe's outcome: whether it fired, what the append returned, what it threw.
struct Rival {
  bool fired = false;
  long long offset = -1;
  std::optional<std::string> err;
};

std::shared_ptr<Rival> rivalAppend(harness::Ctx& ctx, const std::string& key, const buffer::Record& r) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out, r] {
    out->fired = true;
    try {
      out->offset = ::appendRecord("acme", "checkout", r);
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

void settled(harness::Ctx& ctx, const Rival& r, const std::string& what) {
  ctx.Assert(r.fired, "nothing touched %s", what);
  ctx.Assert(!r.err, "the parallel append failed: %s", r.err.value_or(""));
}

}  // namespace

void CheckByteCap(harness::Ctx& ctx) {
  ctx.Equal(::appendRecord("acme", "checkout", rec("m-0")), 1LL, "the first append into an empty buffer must return offset 1");
  const auto first = ctx.Redis.LRange(kKey, 0, -1);
  ctx.Redis.Do("HINCRBY", kMeta, "bytes", kMax - 100 - static_cast<long long>(first[0].size()));
  const auto before = ctx.Redis.HGetAll(kMeta);
  const long long shed = ::appendRecord("acme", "checkout", rec("m-1 " + std::string(200, 'x')));
  ctx.Equal(shed, 0LL, "with 100 bytes left under the 64 MiB cap a 300-byte record must be shed; appendRecord's return");
  ctx.Equal(ctx.Redis.LRange(kKey, 0, -1), first, "a shed record must not reach %s; its records", kKey);
  ctx.Equal(ctx.Redis.HGetAll(kMeta), before, "a shed record must leave %s as it was", kMeta);
  ctx.Equal(::appendRecord("acme", "billing", rec("m-2")), 1LL, "another index's buffer has its own cap: its first append must return offset 1");
}

void CheckAtomicAppend(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", kMeta, "count", "0", "bytes", std::to_string(kMax - 350), "offset", "0");
  const buffer::Record r = rec(std::string(150, 'x'));
  // A second append lands right after this one's first command on the meta hash.
  const auto rival = rivalAppend(ctx, kMeta, r);
  const long long first = ::appendRecord("acme", "checkout", r);
  settled(ctx, *rival, kMeta);
  const long long low = std::min(first, rival->offset);
  const long long high = std::max(first, rival->offset);
  ctx.Assert(low == 0 && high > 0, "two appends raced for the last 350 bytes under the cap, where one record fits, and returned %d and %d: exactly one must be shed (0). Check the cap and write in one script", first, rival->offset);
  const long long used = field(ctx.Redis.HGetAll(kMeta), "bytes");
  ctx.Assert(used <= kMax, "%s says bytes %d, past the 64 MiB cap by %d", kMeta, used, used - kMax);
  ctx.Equal(ctx.Redis.LLen(kKey), 1LL, "after the race %s must hold the one record that fit; its records", kKey);
}

void CheckDrainBatch(harness::Ctx& ctx) {
  std::vector<std::string> args = {"RPUSH", kKey};
  long long total = 0;
  for (int i = 0; i < 1005; i++) {
    args.push_back(buffer::toJson(rec("m-" + std::to_string(i))).dump());
    total += static_cast<long long>(args.back().size());
  }
  ctx.Redis.Must(args);
  ctx.Redis.Do("HSET", kMeta, "count", "1005", "bytes", std::to_string(total), "offset", "1005");
  const auto batch = ::drainBatch("acme", "checkout");
  ctx.Equal(batch.size(), 1000, "a drain of 1005 buffered records must return kBatchSize = 1000; the records drained");
  ctx.Assert(batch.front().message == "m-0" && batch.back().message == "m-999", "a drain must take the oldest records in order, it returned %s … %s", batch.front().message, batch.back().message);
  const auto left = consistent(ctx, "after the first drain");
  const std::vector<std::string> want = {"m-1000", "m-1001", "m-1002", "m-1003", "m-1004"};
  std::vector<std::string> kept;
  for (const auto& x : left) kept.push_back(messageOf(x));
  ctx.Equal(kept, want, "%s must keep the 5 newest records", kKey);
  std::vector<std::string> got;
  for (const auto& r : ::drainBatch("acme", "checkout")) got.push_back(r.message);
  ctx.Equal(got, want, "the second drain must return the 5 records left");
  ctx.Equal(consistent(ctx, "after the second drain").size(), 0, "the records left after the second drain");
  ctx.Equal(::drainBatch("acme", "checkout").size(), 0, "a drain of an empty buffer; the records it returned");
}

void CheckDrainAtomic(harness::Ctx& ctx) {
  for (int i = 0; i < 3; i++) ::appendRecord("acme", "checkout", rec("m-" + std::to_string(i)));
  // An ingest lands while the drain is between its commands.
  const auto late = rivalAppend(ctx, kKey, rec("late"));
  const auto batch = ::drainBatch("acme", "checkout");
  settled(ctx, *late, kKey);
  const auto left = consistent(ctx, "after a drain raced an append");
  std::vector<std::string> drained, kept;
  for (const auto& r : batch) drained.push_back(r.message);
  for (const auto& x : left) kept.push_back(messageOf(x));
  std::vector<std::string> seen = drained;
  seen.insert(seen.end(), kept.begin(), kept.end());
  std::sort(seen.begin(), seen.end());
  ctx.Equal(seen, {"late", "m-0", "m-1", "m-2"}, "a record appended while the drain ran was lost (the drain returned %v, %s holds %v); every record", drained, kKey, kept);
}
`,
  },
  hints: [
    'Stall the writer and keep posting: the buffer passes 64 MiB and keeps growing. Then drain while an agent is still sending: the record that arrived mid-drain is in neither the batch nor the buffer.',
    'Every append is four commands with no cap in them, so two clients near a cap would both pass any check made first. The drain reads the list, then deletes all of it, then zeroes the counters: three moments another client can land between.',
    'Move the append into one Lua script: HGET bytes, return 0 past `MAX_BUFFER_BYTES`, else RPUSH and HINCRBY count, bytes and offset. Drain with another: LRANGE 0 `BATCH_SIZE`−1, LTRIM the same count, HINCRBY count and bytes down.',
  ],
  debrief: `A buffer's list and its counters describe one fact, so they change in one script: Redis runs a script with no other command between its lines, which is what lets the cap check and the write agree, and what lets a drain trim exactly what it read. LTRIM by the number of records taken, rather than DEL, leaves an append that landed meanwhile where the next drain finds it. The cap answers 0 instead of raising so the ingest route can turn it into a 429 with \`Retry-After\` and the agent keeps the record. A production pipeline would cap a tenant across all its buffers too, and export the buffered bytes per index as a gauge, so a shard that stopped draining shows up before the first shed.`,
};
