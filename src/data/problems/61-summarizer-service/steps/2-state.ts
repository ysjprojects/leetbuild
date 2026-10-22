import type {Step} from '@/lib/types';

export const summarizerStateStep: Step = {
  id: 'state',
  title: 'Redis source-progress cache for incremental updates',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it keeps a per-source record in
Redis, folds each chunk's summary into it and bumps a counter. It works for one document that is
written once, by one writer, that never fails. Review it like the service owner, fix it, and prove
the fix with the checks below.

A long source is summarized chunk by chunk. Implement the per-source progress record:

- Key it by \`progress_key(tenant, source_hash)\` → \`summary:progress:{tenant}:{source_hash}\`, where
  \`source_hash\` is a **content hash** of the source (a hex digest of its bytes), not the source id.
  The hash *is* the version: editing a source produces a new hash, a new key and a **new summary
  line**, and the old record is left untouched instead of being extended.
- Commit one chunk with \`apply_chunk(tenant, source_hash, chunk_index, chunk_summary)\`. The rolling
  summary, the version it belongs to and the covered-chunk counter (\`chunks_done\`) must move in a
  **single** atomic step — one registered Lua script (\`COMMIT_LUA\`) — never as separate writes. A
  crash between "write the summary" and "bump the counter" is exactly how a summary ends up claiming
  chunks it never read, and a summary that claims coverage it never had invents events that never
  happened.
- Set the TTL inside that same script: \`TTL_S = 3600\`, refreshed when the key has no expiry, so
  progress expires with the source's window instead of living forever.
- Re-applying a chunk must be idempotent: the script compares the incoming \`chunk_index\` with the
  stored counter and returns the record unchanged when that chunk is already covered, so a retried
  chunk cannot push the counter past the chunks that were actually summarized.
- The returned record reports only completed work: \`chunks_done\`, the rolling \`summary\`, the
  \`summary_version\` it covers, and \`line\` — \`NEW_LINE\` when this chunk opened a summary line for
  this hash, the continuation otherwise.

**Failure mode the checks target.** The draft writes the summary with \`HSET\` and bumps the counter
with a second command, so a crash (or a timeout between the two) leaves a summary that claims
chunks it never read — the invented quarter. It keys progress by \`source_id\` with no content hash,
so an edited source resumes the old line and appends new text to a summary of the previous version.
It sets no TTL, so progress for deleted sources never expires. And it increments the counter by one
instead of storing the chunk index it covered, so a redelivered chunk silently double-counts.`,
  sequence: {
    participants: ['Chunk writer', 'Summarizer', 'Redis'],
    messages: [
      {
        from: 'Chunk writer',
        to: 'Summarizer',
        label: 'POST /v1/sources/{id}/chunks · source_hash · chunk',
        kind: 'sync',
      },
      {from: 'Summarizer', to: 'Summarizer', label: 'progress_key(tenant, source_hash)', kind: 'sync'},
      {from: 'Summarizer', to: 'Redis', label: 'EVALSHA commit · summary + chunks_done + TTL', kind: 'sync'},
      {from: 'Redis', to: 'Summarizer', label: '{applied, chunks_done, summary_version, line}', kind: 'reply'},
      {from: 'Summarizer', to: 'Summarizer', label: 'line = NEW_LINE when the hash has no progress', kind: 'sync'},
      {from: 'Summarizer', to: 'Chunk writer', label: '200 {chunks_done, summary_version, line}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'hash-key',
      title: 'Keys progress by tenant and the source content hash',
      detail:
        'The key is `summary:progress:{tenant}:{source_hash}` built by `progress_key`, and the hash identifies the source *content*, so an edited source lands on a new key. The draft keys by `source_id` alone, so an edit resumes the previous summary.',
      match: {
        python: {all: [/progress_key\(/, /source_hash/, /summary:progress:/]},
        typescript: {all: [/progressKey\(/, /source_hash/, /summary:progress:/]},
        go: {all: [/progressKey\(/, /sourceHash/, /summary:progress:/]},
        scala: {all: [/progressKey\(/, /sourceHash/, /summary:progress:/]},
        cpp: {all: [/progress_key\(/, /source_hash/, /summary:progress:/]},
      },
    },
    {
      id: 'atomic-commit',
      title: 'Commits the summary and its chunk counter in one script',
      detail:
        'A single registered `COMMIT_LUA` script `HSET`s the rolling summary and the `chunks_done` counter it covers in one round trip. The draft writes them as two separate commands, so a crash between them leaves a summary claiming chunks it never read.',
      match: {
        python: {all: [/COMMIT_LUA/, /register_script\(/, /HSET/, /chunks_done/]},
        typescript: {all: [/COMMIT_LUA/, /\.eval\(/, /HSET/, /chunks_done/]},
        go: {all: [/commitLua/, /NewScript/, /HSET/, /chunks_done/]},
        scala: {all: [/CommitLua/, /\.eval\(/, /HSET/, /chunks_done/]},
        cpp: {all: [/kCommitLua/, /\.eval</, /HSET/, /chunks_done/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires progress with a TTL set inside the same script',
      detail:
        '`TTL_S = 3600` is applied with `EXPIRE` inside the commit script when the key has no expiry. The draft never sets a TTL, so progress for sources nobody writes again is retained forever.',
      match: {
        python: {all: [/TTL_S/, /EXPIRE/]},
        typescript: {all: [/TTL_S/, /EXPIRE/]},
        go: {all: [/ttlSeconds/, /EXPIRE/]},
        scala: {all: [/TtlSeconds/, /EXPIRE/]},
        cpp: {all: [/kTtlSeconds/, /EXPIRE/]},
      },
    },
    {
      id: 'idempotent-chunk',
      title: 'Re-applying a chunk is idempotent',
      detail:
        'The script compares the incoming `chunk_index` with the stored `chunks_done` (`idx <= done`) and returns the record unchanged when the chunk is already covered, so a redelivery cannot double-count. The draft increments the counter, which counts deliveries rather than chunks.',
      match: {
        python: {all: [/apply_chunk\(/, /idx <= done/, /chunks_done/]},
        typescript: {all: [/applyChunk\(/, /idx <= done/, /chunks_done/]},
        go: {all: [/applyChunk\(/, /idx <= done/, /chunks_done/]},
        scala: {all: [/applyChunk\(/, /idx <= done/, /chunks_done/]},
        cpp: {all: [/apply_chunk\(/, /idx <= done/, /chunks_done/]},
      },
    },
    {
      id: 'new-line-on-edit',
      title: 'An edited source starts a new summary line',
      detail:
        'The commit reports `NEW_LINE` when this chunk opened the line for its hash (the old summary is not appended to) and returns the `summary_version` it covers. The draft has no such status and no version, so a chunk from an edited source extends the previous summary.',
      match: {
        python: {all: [/NEW_LINE/, /summary_version/]},
        typescript: {all: [/NEW_LINE/, /summary_version/]},
        go: {all: [/newLine/, /summary_version/]},
        scala: {all: [/NewLine/, /summaryVersion/]},
        cpp: {all: [/kNewLine/, /summary_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("summarizer")


class ChunkBody(BaseModel):
    chunk_index: int
    chunk_summary: str


def progress_key(tenant: str, source_id: str) -> str:
    return f"summary:progress:{tenant}:{source_id}"


@app.post("/v1/sources/{source_id}/chunks")
def apply_chunk(source_id: str, body: ChunkBody, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft writes the rolling summary and then bumps the counter as two separate
    # commands, keys progress by source id with no content hash, never sets a TTL, and increments
    # the counter instead of storing the chunk it covered. Review all four.
    key = progress_key(tenant, source_id)
    r.hset(key, mapping={"summary": body.chunk_summary, "summary_version": str(body.chunk_index)})
    r.hincrby(key, "chunks_done", 1)
    progress = r.hgetall(key)
    logger.info("chunk tenant=%s source=%s done=%s", tenant, source_id, progress.get("chunks_done"))
    return JSONResponse(
        {"chunks_done": int(progress.get("chunks_done", 0)), "summary": progress.get("summary", "")},
        status_code=200,
    )
`,
      solution: `import hashlib
import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("summarizer")

TTL_S = 3600
NEW_LINE = "new"
CONTINUED = "continued"

# The rolling summary, the version it covers and the covered-chunk counter move together: one
# script, one round trip. A crash can then never leave a summary claiming chunks it never read.
COMMIT_LUA = """
local done = tonumber(redis.call('HGET', KEYS[1], 'chunks_done')) or 0
local idx = tonumber(ARGV[1])
if idx <= done then
  return {0, done, redis.call('HGET', KEYS[1], 'summary') or '', redis.call('HGET', KEYS[1], 'summary_version') or '', 1}
end
local line = redis.call('EXISTS', KEYS[1])
redis.call('HSET', KEYS[1], 'summary', ARGV[2], 'summary_version', ARGV[3], 'chunks_done', idx)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, idx, ARGV[2], ARGV[3], line}
"""
commit = r.register_script(COMMIT_LUA)


class ChunkBody(BaseModel):
    chunk_index: int
    chunk_summary: str
    source_hash: str


def hash_content(content: str) -> str:
    """The content hash that names one version of a source."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def progress_key(tenant: str, source_hash: str) -> str:
    return f"summary:progress:{tenant}:{source_hash[:32]}"


def apply_chunk(tenant: str, source_hash: str, chunk_index: int, chunk_summary: str) -> dict:
    """Fold one chunk into the rolling summary and commit the counter it covers, atomically."""
    applied, count, summary, version, existed = commit(
        keys=[progress_key(tenant, source_hash)],
        args=[chunk_index, chunk_summary, str(chunk_index), TTL_S],
    )
    return {
        "source_hash": source_hash,
        "chunks_done": int(count),
        "summary": summary,
        "summary_version": version,
        "line": CONTINUED if int(existed) == 1 else NEW_LINE,
        "applied": bool(applied),
    }


@app.post("/v1/sources/{source_id}/chunks")
def write_chunk(
    source_id: str,
    body: ChunkBody,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.chunk_index < 0 or body.chunk_summary == "" or len(body.source_hash) < 32:
        raise HTTPException(status_code=400, detail="chunk_index, chunk_summary and source_hash are required")

    progress = apply_chunk(tenant, body.source_hash, body.chunk_index, body.chunk_summary)
    logger.info(
        "chunk tenant=%s source=%s chunk=%d line=%s done=%d",
        tenant,
        source_id,
        body.chunk_index,
        progress["line"],
        progress["chunks_done"],
    )
    return JSONResponse(progress, status_code=200)
`,
    },
    typescript: {
      starter: `/** Per-source summary progress in Redis: a model-generated draft. */
import {Redis} from 'ioredis';

const r = new Redis({host: 'redis', port: 6379});

interface ChunkBody {
  chunk_index: number;
  chunk_summary: string;
}

function progressKey(tenant: string, sourceId: string): string {
  return 'summary:progress:' + tenant + ':' + sourceId;
}

export async function applyChunk(
  tenant: string,
  sourceId: string,
  chunkIndex: number,
  chunkSummary: string,
): Promise<{chunks_done: number; summary: string}> {
  // TODO: this draft writes the rolling summary and then bumps the counter as two separate
  // commands, keys progress by source id with no content hash, never sets a TTL, and increments
  // the counter instead of storing the chunk it covered. Review all four.
  const key = progressKey(tenant, sourceId);
  await r.hset(key, {summary: chunkSummary, summary_version: String(chunkIndex)});
  await r.hincrby(key, 'chunks_done', 1);
  const progress = await r.hgetall(key);
  return {chunks_done: Number(progress.chunks_done ?? 0), summary: progress.summary ?? ''};
}
`,
      solution: `/** Per-source summary progress in Redis: summary and counter move together. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

const r = new Redis({host: 'redis', port: 6379});

const TTL_S = 3600;
const NEW_LINE = 'new';
const CONTINUED = 'continued';

// The rolling summary, the version it covers and the covered-chunk counter move together: one
// script, one round trip. A crash can then never leave a summary claiming chunks it never read.
const COMMIT_LUA = \`
local done = tonumber(redis.call('HGET', KEYS[1], 'chunks_done')) or 0
local idx = tonumber(ARGV[1])
if idx <= done then
  return {0, done, redis.call('HGET', KEYS[1], 'summary') or '', redis.call('HGET', KEYS[1], 'summary_version') or '', 1}
end
local line = redis.call('EXISTS', KEYS[1])
redis.call('HSET', KEYS[1], 'summary', ARGV[2], 'summary_version', ARGV[3], 'chunks_done', idx)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, idx, ARGV[2], ARGV[3], line}
\`;

export interface Progress {
  source_hash: string;
  chunks_done: number;
  summary: string;
  summary_version: string;
  line: string;
  applied: boolean;
}

/** The content hash that names one version of a source. */
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function progressKey(tenant: string, source_hash: string): string {
  return 'summary:progress:' + tenant + ':' + source_hash.slice(0, 32);
}

export async function applyChunk(
  tenant: string,
  source_hash: string,
  chunkIndex: number,
  chunkSummary: string,
): Promise<Progress> {
  const reply = (await r.eval(
    COMMIT_LUA,
    1,
    progressKey(tenant, source_hash),
    String(chunkIndex),
    chunkSummary,
    String(chunkIndex),
    String(TTL_S),
  )) as [number, number, string, string, number];
  const [applied, count, summary, version, existed] = reply;
  return {
    source_hash,
    chunks_done: Number(count),
    summary,
    summary_version: version,
    line: Number(existed) === 1 ? CONTINUED : NEW_LINE,
    applied: Number(applied) === 1,
  };
}

export const newProgressHash = (content: string): string => hashContent(content);
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

type ChunkBody struct {
	ChunkIndex   int    \`json:"chunk_index"\`
	ChunkSummary string \`json:"chunk_summary"\`
}

func progressKey(tenant, sourceID string) string {
	return fmt.Sprintf("summary:progress:%s:%s", tenant, sourceID)
}

// applyChunk folds one chunk into the rolling summary. The model-generated draft does it in two
// steps and keys by source id.
func applyChunk(ctx context.Context, rdb *redis.Client, tenant, sourceID string, body ChunkBody) (map[string]any, error) {
	// TODO: this draft writes the rolling summary and then bumps the counter as two separate
	// commands, keys progress by source id with no content hash, never sets a TTL, and increments
	// the counter instead of storing the chunk it covered. Review all four.
	key := progressKey(tenant, sourceID)
	if err := rdb.HSet(ctx, key, "summary", body.ChunkSummary, "summary_version", body.ChunkIndex).Err(); err != nil {
		return nil, err
	}
	done, err := rdb.HIncrBy(ctx, key, "chunks_done", 1).Result()
	if err != nil {
		return nil, err
	}
	summary, _ := rdb.HGet(ctx, key, "summary").Result()
	return map[string]any{"chunks_done": done, "summary": summary}, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const (
	ttlSeconds = 3600
	newLine    = "new"
	continued  = "continued"
)

// The rolling summary, the version it covers and the covered-chunk counter move together: one
// script, one round trip. A crash can then never leave a summary claiming chunks it never read.
var commitLua = redis.NewScript(\`
local done = tonumber(redis.call('HGET', KEYS[1], 'chunks_done')) or 0
local idx = tonumber(ARGV[1])
if idx <= done then
  return {0, done, redis.call('HGET', KEYS[1], 'summary') or '', redis.call('HGET', KEYS[1], 'summary_version') or '', 1}
end
local line = redis.call('EXISTS', KEYS[1])
redis.call('HSET', KEYS[1], 'summary', ARGV[2], 'summary_version', ARGV[3], 'chunks_done', idx)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, idx, ARGV[2], ARGV[3], line}
\`)

type ChunkBody struct {
	ChunkIndex   int    \`json:"chunk_index"\`
	ChunkSummary string \`json:"chunk_summary"\`
	SourceHash   string \`json:"source_hash"\`
}

type Progress struct {
	SourceHash     string \`json:"source_hash"\`
	ChunksDone     int    \`json:"chunks_done"\`
	Summary        string \`json:"summary"\`
	SummaryVersion string \`json:"summary_version"\`
	Line           string \`json:"line"\`
	Applied        bool   \`json:"applied"\`
}

// hashContent is the content hash that names one version of a source.
func hashContent(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func progressKey(tenant, sourceHash string) string {
	return fmt.Sprintf("summary:progress:%s:%s", tenant, sourceHash[:32])
}

func applyChunk(ctx context.Context, rdb *redis.Client, tenant, sourceHash string, chunkIndex int, chunkSummary string) (Progress, error) {
	raw, err := commitLua.Run(
		ctx,
		rdb,
		[]string{progressKey(tenant, sourceHash)},
		chunkIndex,
		chunkSummary,
		chunkIndex,
		ttlSeconds,
	).Slice()
	if err != nil {
		return Progress{}, err
	}
	applied, _ := raw[0].(int64)
	count, _ := raw[1].(int64)
	summary, _ := raw[2].(string)
	version, _ := raw[3].(string)
	existed, _ := raw[4].(int64)
	line := newLine
	if existed == 1 {
		line = continued
	}
	return Progress{
		SourceHash:     sourceHash,
		ChunksDone:     int(count),
		Summary:        summary,
		SummaryVersion: version,
		Line:           line,
		Applied:        applied == 1,
	}, nil
}
`,
    },
    scala: {
      starter: `import com.redis.RedisClient

object SourceProgress {
  val Redis = new RedisClient("redis", 6379)

  def progressKey(tenant: String, sourceId: String): String = s"summary:progress:$tenant:$sourceId"

  /** Fold one chunk into the rolling summary. The model-generated draft does it in two steps. */
  def applyChunk(tenant: String, sourceId: String, chunkIndex: Int, chunkSummary: String): Map[String, String] = {
    // TODO: this draft writes the rolling summary and then bumps the counter as two separate
    // commands, keys progress by source id with no content hash, never sets a TTL, and increments
    // the counter instead of storing the chunk it covered. Review all four.
    val key = progressKey(tenant, sourceId)
    Redis.hset(key, "summary", chunkSummary)
    Redis.hset(key, "summary_version", chunkIndex.toString)
    Redis.hincrby(key, "chunks_done", 1)
    Map("chunks_done" -> Redis.hget(key, "chunks_done").getOrElse("0"), "summary" -> Redis.hget(key, "summary").getOrElse(""))
  }
}
`,
      solution: `import com.redis.RedisClient

import java.security.MessageDigest

object SourceProgress {
  val Redis = new RedisClient("redis", 6379)

  val TtlSeconds = 3600
  val NewLine = "new"
  val Continued = "continued"

  // The rolling summary, the version it covers and the covered-chunk counter move together: one
  // script, one round trip. A crash can then never leave a summary claiming chunks it never read.
  val CommitLua =
    """
local done = tonumber(redis.call('HGET', KEYS[1], 'chunks_done')) or 0
local idx = tonumber(ARGV[1])
if idx <= done then
  return {0, done, redis.call('HGET', KEYS[1], 'summary') or '', redis.call('HGET', KEYS[1], 'summary_version') or '', 1}
end
local line = redis.call('EXISTS', KEYS[1])
redis.call('HSET', KEYS[1], 'summary', ARGV[2], 'summary_version', ARGV[3], 'chunks_done', idx)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, idx, ARGV[2], ARGV[3], line}
"""

  /** The content hash that names one version of a source. */
  def hashContent(content: String): String =
    MessageDigest.getInstance("SHA-256").digest(content.getBytes("UTF-8")).map("%02x".format(_)).mkString

  def progressKey(tenant: String, sourceHash: String): String =
    s"summary:progress:$tenant:\${sourceHash.take(32)}"

  def applyChunk(tenant: String, sourceHash: String, chunkIndex: Int, chunkSummary: String): Map[String, String] = {
    val reply = Redis.eval(
      CommitLua,
      List(progressKey(tenant, sourceHash)),
      List(chunkIndex.toString, chunkSummary, chunkIndex.toString, TtlSeconds.toString)
    )
    val fields = reply.toList.map {
      case bytes: Array[Byte] => new String(bytes, "UTF-8")
      case other              => other.toString
    }
    val applied = fields.headOption.contains("1")
    val done = fields.lift(1).getOrElse("0")
    val summary = fields.lift(2).getOrElse("")
    val summaryVersion = fields.lift(3).getOrElse("")
    val line = if (fields.lift(4).contains("1")) Continued else NewLine
    Map(
      "source_hash" -> sourceHash,
      "chunks_done" -> done,
      "summary" -> summary,
      "summary_version" -> summaryVersion,
      "line" -> line,
      "applied" -> applied.toString
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

using sw::redis::Redis;

static std::string progress_key(const std::string& tenant, const std::string& source_id) {
  return "summary:progress:" + tenant + ":" + source_id;
}

/** Fold one chunk into the rolling summary. The model-generated draft does it in two steps. */
std::string apply_chunk(Redis& redis, const std::string& tenant, const std::string& source_id, int chunk_index,
                        const std::string& chunk_summary) {
  // TODO: this draft writes the rolling summary and then bumps the counter as two separate
  // commands, keys progress by source id with no content hash, never sets a TTL, and increments
  // the counter instead of storing the chunk it covered. Review all four.
  const auto key = progress_key(tenant, source_id);
  redis.hset(key, "summary", chunk_summary);
  redis.hset(key, "summary_version", std::to_string(chunk_index));
  const auto done = redis.hincrby(key, "chunks_done", 1);
  return "{\\"chunks_done\\":" + std::to_string(done) + "}";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <cstdint>
#include <string>
#include <vector>

using sw::redis::Redis;

constexpr long long kTtlSeconds = 3600;
constexpr const char* kNewLine = "new";
constexpr const char* kContinued = "continued";

// The rolling summary, the version it covers and the covered-chunk counter move together: one
// script, one round trip. A crash can then never leave a summary claiming chunks it never read.
const char* kCommitLua = R"LUA(
local done = tonumber(redis.call('HGET', KEYS[1], 'chunks_done')) or 0
local idx = tonumber(ARGV[1])
if idx <= done then
  return {0, done, redis.call('HGET', KEYS[1], 'summary') or '', redis.call('HGET', KEYS[1], 'summary_version') or '', 1}
end
local line = redis.call('EXISTS', KEYS[1])
redis.call('HSET', KEYS[1], 'summary', ARGV[2], 'summary_version', ARGV[3], 'chunks_done', idx)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, idx, ARGV[2], ARGV[3], line}
)LUA";

/** The content hash that names one version of a source. */
static std::string hash_content(const std::string& content) {
  return std::to_string(std::hash<std::string>{}(content));
}

static std::string progress_key(const std::string& tenant, const std::string& source_hash) {
  return "summary:progress:" + tenant + ":" + source_hash.substr(0, 32);
}

struct Progress {
  std::string source_hash;
  long long chunks_done = 0;
  std::string summary;
  std::string summary_version;
  std::string line;
  bool applied = false;
};

Progress apply_chunk(Redis& redis, const std::string& tenant, const std::string& source_hash, int chunk_index,
                     const std::string& chunk_summary) {
  const auto reply = redis.eval<std::vector<long long>>(
      kCommitLua,
      {progress_key(tenant, source_hash)},
      {std::to_string(chunk_index), chunk_summary, std::to_string(chunk_index), std::to_string(kTtlSeconds)});
  Progress progress;
  progress.source_hash = source_hash;
  progress.applied = reply[0] == 1;
  progress.chunks_done = reply[1];
  progress.summary_version = std::to_string(chunk_index);
  progress.line = reply[4] == 1 ? kContinued : kNewLine;
  progress.summary = redis.hget(progress_key(tenant, source_hash), "summary").value_or("");
  return progress;
}
`,
    },
  },
  hints: [
    'The counter and the summary are one fact, not two: "the summary covers chunks 0..n". Write them with one registered Lua script and commit them together, because the crash you cannot reproduce is the one that leaves a summary claiming chunks it never read.',
    'Bind progress to the source **content** hash, not the source id — the hash is the version. A new hash means a new key, a new summary line, and the old record left alone for whoever is still reading the old version.',
    'Make the commit idempotent: compare the incoming chunk index with `chunks_done` and return the stored record unchanged when the chunk is already covered, so a redelivery counts a chunk once.',
  ],
  debrief: `The interview question behind this step is atomicity of a derived fact: a rolling summary *is* the
claim "I have read these chunks", so the text and the counter have to be written as one thing. Two
writes pass every serial test and fail exactly when a worker dies between them, and the failure is
silent — the summary looks complete and mentions text it never read, which is how a board summary
invents a quarter. Binding progress to the source content hash is the second half: without it an
edited source resumes the previous summary and appends new text onto a summary of a document that no
longer exists, and the fix is to make the version part of the key. A TTL keeps progress from
outliving the source, and index-based idempotence makes retries — which every chunk writer has —
harmless. Real systems add a per-chunk digest so a re-summarized chunk replaces its own contribution,
a compaction pass that folds long lines into a stored version, and a lock so two workers cannot
interleave writes to one source.`,
};
