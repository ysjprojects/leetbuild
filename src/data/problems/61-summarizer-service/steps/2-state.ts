import type {Step} from '@/lib/types';

const LUA = `local done = tonumber(redis.call('HGET', KEYS[1], 'chunks_done') or '0')
local summary = redis.call('HGET', KEYS[1], 'summary') or ''
if tonumber(ARGV[1]) ~= done then
  return {'0', tostring(done), summary}
end
if summary ~= '' then summary = summary .. ' ' end
summary = summary .. ARGV[2]
redis.call('HSET', KEYS[1], 'summary', summary, 'chunks_done', done + 1, 'source_ref', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {'1', tostring(done + 1), summary}`;

const LUA_COMMENT = 'Applies chunk ARGV[1] only when it is the next one, appends ARGV[2], refreshes the TTL (ARGV[3]).';

export const summarizerStateStep: Step = {
  id: 'state',
  title: 'Redis progress for a chunked source, bound to its content hash',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the progress record the chunked write path keeps while a long
source is summarized chunk by chunk: \`apply_chunk(tenant, source_ref, source_hash, chunk_index,
chunk_summary)\` reads the rolling summary from \`summary:progress:{tenant}:{source_ref}\`, writes it
back with the chunk's summary appended (\`HSET\`), bumps \`chunks_done\` (\`HINCRBY\`) and returns
\`{applied, chunks_done, summary}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** An edited source resumes the previous version's summary; two
workers handed the same chunk both append it; a redelivered or out-of-order chunk is counted; and
progress for a source nobody finishes stays in Redis forever.

- Key the record by \`progress_key(tenant, source_hash)\` (\`summary:progress:{tenant}:{source_hash}\`),
  so an edited source starts a summary of its own; keep \`source_ref\` as a field.
- One Lua script (\`COMMIT_LUA\`) reads \`chunks_done\`, applies the chunk only when \`chunk_index\`
  equals it (anything else answers the record unchanged with \`applied\` false), appends the
  summary, increments the counter and sets \`EXPIRE\` to \`TTL_S\` = 3600.
- The script answers \`{applied, chunks_done, summary}\` as strings (\`'1'\` or \`'0'\` first).`,
  sequence: {
    participants: ['Chunk worker', 'Summarizer', 'Redis'],
    messages: [
      {from: 'Chunk worker', to: 'Summarizer', label: 'apply_chunk(tenant, ref, source_hash, 3, "…")', kind: 'sync'},
      {from: 'Summarizer', to: 'Redis', label: 'EVALSHA commit summary:progress:{tenant}:{source_hash}', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'chunks_done == 3? append · HSET · EXPIRE 3600', kind: 'sync'},
      {from: 'Redis', to: 'Summarizer', label: "{'1', '4', summary} · or {'0', '4', summary}", kind: 'reply'},
      {from: 'Summarizer', to: 'Chunk worker', label: '{applied, chunks_done, summary}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'hash-key',
      title: 'Keys progress by tenant and the source content hash',
      detail:
        'The record lives under `summary:progress:{tenant}:{source_hash}`, so the first chunk of an edited source starts a new summary and the old version keeps its own; the starter keys by `source_ref`.',
      match: {
        python: {
          all: [/progress_key\(\s*tenant\s*,\s*source_hash\s*\)/, /summary:progress:/],
          none: [/progress_key\(\s*tenant\s*,\s*source_ref\s*\)/],
        },
        typescript: {
          all: [/progressKey\(\s*tenant\s*,\s*sourceHash\s*\)/, /summary:progress:/],
          none: [/progressKey\(\s*tenant\s*,\s*sourceRef\s*\)/],
        },
        go: {
          all: [/progressKey\(\s*tenant\s*,\s*sourceHash\s*\)/, /summary:progress:/],
          none: [/progressKey\(\s*tenant\s*,\s*sourceRef\s*\)/],
        },
        scala: {
          all: [/progressKey\(\s*tenant\s*,\s*sourceHash\s*\)/, /summary:progress:/],
          none: [/progressKey\(\s*tenant\s*,\s*sourceRef\s*\)/],
        },
        cpp: {
          all: [/progressKey\(\s*tenant\s*,\s*source_hash\s*\)/, /summary:progress:/],
          none: [/progressKey\(\s*tenant\s*,\s*source_ref\s*\)/],
        },
      },
    },
    {
      id: 'atomic-commit',
      title: 'Reads, appends and counts in one script',
      detail:
        'The read of `chunks_done`, the appended summary and the new count move in one Lua script; client-side `HGET`/`HSET`/`HINCRBY` let a second worker land between them, so one chunk is appended twice.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HSET['"]/, /chunks_done/],
          none: [/\.hincrby\(/i, /\br\.hset\(/, /\br\.hget\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HSET['"]/, /chunks_done/],
          none: [/redis\.hincrby\(/i, /redis\.hset\(/, /redis\.hget\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HSET['"]/, /chunks_done/],
          none: [/\.HIncrBy\(/, /rdb\.HSet\(/, /rdb\.HGet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HSET['"]/, /chunks_done/],
          none: [/jedis\.hincrBy\(/, /jedis\.hset\(/, /jedis\.hget\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HSET['"]/, /chunks_done/],
          none: [/redis\.hincrby\(/, /redis\.hset\(/, /redis\.hget\(/],
        },
      },
    },
    {
      id: 'ttl',
      title: 'Expires progress inside the same script',
      detail: '`TTL_S` = 3600 is set with `EXPIRE` by the commit script on every applied chunk; the starter sets none.',
      match: {
        python: {all: [/TTL_S\s*=\s*3600/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        typescript: {all: [/TTL_S\s*=\s*3600/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        go: {all: [/ttlSeconds\s*=\s*3600/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        scala: {all: [/TtlSeconds\s*=\s*3600/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        cpp: {all: [/kTtlSeconds\s*=\s*3600/, /redis\.call\(\s*['"]EXPIRE['"]/]},
      },
    },
    {
      id: 'idempotent-chunk',
      title: 'Applies a chunk only when it is the next one',
      detail:
        'The script compares `chunk_index` (`ARGV[1]`) with the stored `chunks_done` and answers the record unchanged with `applied` false for a redelivered or early chunk; the starter counts deliveries, not chunks.',
      match: {
        python: {all: [/HGET['"]\s*,\s*KEYS\[1\]\s*,\s*['"]chunks_done/, /tonumber\(\s*ARGV\[1\]\s*\)/]},
        typescript: {all: [/HGET['"]\s*,\s*KEYS\[1\]\s*,\s*['"]chunks_done/, /tonumber\(\s*ARGV\[1\]\s*\)/]},
        go: {all: [/HGET['"]\s*,\s*KEYS\[1\]\s*,\s*['"]chunks_done/, /tonumber\(\s*ARGV\[1\]\s*\)/]},
        scala: {all: [/HGET['"]\s*,\s*KEYS\[1\]\s*,\s*['"]chunks_done/, /tonumber\(\s*ARGV\[1\]\s*\)/]},
        cpp: {all: [/HGET['"]\s*,\s*KEYS\[1\]\s*,\s*['"]chunks_done/, /tonumber\(\s*ARGV\[1\]\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def progress_key(tenant: str, source_ref: str) -> str:
    return f"summary:progress:{tenant}:{source_ref}"


def apply_chunk(tenant: str, source_ref: str, source_hash: str, chunk_index: int, chunk_summary: str) -> dict:
    """Fold one chunk's summary into the rolling summary of the source; returns applied, chunks_done, summary."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = progress_key(tenant, source_ref)
    current = r.hget(key, "summary") or ""
    summary = f"{current} {chunk_summary}".strip()
    r.hset(key, mapping={"summary": summary, "source_hash": source_hash})
    done = r.hincrby(key, "chunks_done", 1)
    return {"applied": True, "chunks_done": done, "summary": summary}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600

# ${LUA_COMMENT}
COMMIT_LUA = """
${LUA}
"""
commit = r.register_script(COMMIT_LUA)


def progress_key(tenant: str, source_hash: str) -> str:
    return f"summary:progress:{tenant}:{source_hash}"


def apply_chunk(tenant: str, source_ref: str, source_hash: str, chunk_index: int, chunk_summary: str) -> dict:
    """Fold one chunk's summary into the rolling summary of the source; returns applied, chunks_done, summary."""
    # An edited source has another hash, so it starts a summary of its own.
    applied, done, summary = commit(keys=[progress_key(tenant, source_hash)], args=[chunk_index, chunk_summary, TTL_S, source_ref])
    return {"applied": applied == "1", "chunks_done": int(done), "summary": summary}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Progress {
  applied: boolean;
  chunks_done: number;
  summary: string;
}

export const progressKey = (tenant: string, sourceRef: string): string => \`summary:progress:\${tenant}:\${sourceRef}\`;

/** Fold one chunk's summary into the rolling summary of the source. */
export async function applyChunk(tenant: string, sourceRef: string, sourceHash: string, chunkIndex: number, chunkSummary: string): Promise<Progress> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = progressKey(tenant, sourceRef);
  const current = (await redis.hget(key, 'summary')) ?? '';
  const summary = \`\${current} \${chunkSummary}\`.trim();
  await redis.hset(key, {summary, source_hash: sourceHash});
  const done = await redis.hincrby(key, 'chunks_done', 1);
  return {applied: true, chunks_done: done, summary};
}
`,
      solution: `import Redis from 'ioredis';

export const TTL_S = 3600;

// ${LUA_COMMENT}
export const COMMIT_LUA = \`
${LUA}
\`;

interface CommitRedis extends Redis {
  commitChunk(key: string, chunkIndex: number, chunkSummary: string, ttl: number, sourceRef: string): Promise<[string, string, string]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CommitRedis;
redis.defineCommand('commitChunk', {numberOfKeys: 1, lua: COMMIT_LUA});

export interface Progress {
  applied: boolean;
  chunks_done: number;
  summary: string;
}

export const progressKey = (tenant: string, sourceHash: string): string => \`summary:progress:\${tenant}:\${sourceHash}\`;

/** Fold one chunk's summary into the rolling summary of the source. */
export async function applyChunk(tenant: string, sourceRef: string, sourceHash: string, chunkIndex: number, chunkSummary: string): Promise<Progress> {
  // An edited source has another hash, so it starts a summary of its own.
  const [applied, done, summary] = await redis.commitChunk(progressKey(tenant, sourceHash), chunkIndex, chunkSummary, TTL_S, sourceRef);
  return {applied: applied === '1', chunks_done: Number(done), summary};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Progress is what apply_chunk answers.
type Progress struct {
	Applied    bool   \`json:"applied"\`
	ChunksDone int    \`json:"chunks_done"\`
	Summary    string \`json:"summary"\`
}

func progressKey(tenant, sourceRef string) string { return "summary:progress:" + tenant + ":" + sourceRef }

// applyChunk folds one chunk's summary into the rolling summary of the source.
func applyChunk(ctx context.Context, tenant, sourceRef, sourceHash string, chunkIndex int, chunkSummary string) (Progress, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := progressKey(tenant, sourceRef)
	current, _ := rdb.HGet(ctx, key, "summary").Result()
	summary := strings.TrimSpace(current + " " + chunkSummary)
	if err := rdb.HSet(ctx, key, "summary", summary, "source_hash", sourceHash).Err(); err != nil {
		return Progress{}, err
	}
	done, err := rdb.HIncrBy(ctx, key, "chunks_done", 1).Result()
	if err != nil {
		return Progress{}, err
	}
	return Progress{Applied: true, ChunksDone: int(done), Summary: summary}, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttlSeconds = 3600

// commit ${LUA_COMMENT.charAt(0).toLowerCase()}${LUA_COMMENT.slice(1)}
var commit = redis.NewScript(\`
${LUA}
\`)

// Progress is what apply_chunk answers.
type Progress struct {
	Applied    bool   \`json:"applied"\`
	ChunksDone int    \`json:"chunks_done"\`
	Summary    string \`json:"summary"\`
}

func progressKey(tenant, sourceHash string) string { return "summary:progress:" + tenant + ":" + sourceHash }

// applyChunk folds one chunk's summary into the rolling summary of the source.
func applyChunk(ctx context.Context, tenant, sourceRef, sourceHash string, chunkIndex int, chunkSummary string) (Progress, error) {
	// An edited source has another hash, so it starts a summary of its own.
	reply, err := commit.Run(ctx, rdb, []string{progressKey(tenant, sourceHash)}, chunkIndex, chunkSummary, ttlSeconds, sourceRef).StringSlice()
	if err != nil {
		return Progress{}, err
	}
	done, _ := strconv.Atoi(reply[1])
	return Progress{Applied: reply[0] == "1", ChunksDone: done, Summary: reply[2]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

final case class Progress(applied: Boolean, chunksDone: Int, summary: String)

object State {
  val jedis = new JedisPooled("redis", 6379)

  def progressKey(tenant: String, sourceRef: String): String = s"summary:progress:$tenant:$sourceRef"

  /** Fold one chunk's summary into the rolling summary of the source. */
  def applyChunk(tenant: String, sourceRef: String, sourceHash: String, chunkIndex: Int, chunkSummary: String): Progress = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = progressKey(tenant, sourceRef)
    val current = Option(jedis.hget(key, "summary")).getOrElse("")
    val summary = s"$current $chunkSummary".trim
    jedis.hset(key, "summary", summary)
    jedis.hset(key, "source_hash", sourceHash)
    val done = jedis.hincrBy(key, "chunks_done", 1)
    Progress(applied = true, done.toInt, summary)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

final case class Progress(applied: Boolean, chunksDone: Int, summary: String)

object State {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 3600

  /** ${LUA_COMMENT} */
  val CommitLua: String =
    """${LUA.split('\n').join('\n      |')}
      |""".stripMargin

  def progressKey(tenant: String, sourceHash: String): String = s"summary:progress:$tenant:$sourceHash"

  /** Fold one chunk's summary into the rolling summary of the source. */
  def applyChunk(tenant: String, sourceRef: String, sourceHash: String, chunkIndex: Int, chunkSummary: String): Progress = {
    // An edited source has another hash, so it starts a summary of its own.
    val args = List(chunkIndex.toString, chunkSummary, TtlSeconds.toString, sourceRef).asJava
    val reply = jedis.eval(CommitLua, List(progressKey(tenant, sourceHash)).asJava, args).asInstanceOf[java.util.List[String]].asScala
    Progress(reply(0) == "1", reply(1).toInt, reply(2))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// What applyChunk answers.
struct Progress {
  bool applied = false;
  long chunks_done = 0;
  std::string summary;
};

std::string progressKey(const std::string& tenant, const std::string& source_ref) { return "summary:progress:" + tenant + ":" + source_ref; }

// Fold one chunk's summary into the rolling summary of the source.
Progress applyChunk(const std::string& tenant, const std::string& source_ref, const std::string& source_hash, long chunk_index,
                    const std::string& chunk_summary) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = progressKey(tenant, source_ref);
  const std::string current = redis.hget(key, "summary").value_or("");
  const std::string summary = current.empty() ? chunk_summary : current + " " + chunk_summary;
  redis.hset(key, {{"summary", summary}, {"source_hash", source_hash}});
  const long long done = redis.hincrby(key, "chunks_done", 1);
  return Progress{true, static_cast<long>(done), summary};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

const long kTtlSeconds = 3600;

// ${LUA_COMMENT}
const std::string kCommitLua = R"lua(
${LUA}
)lua";

// What applyChunk answers.
struct Progress {
  bool applied = false;
  long chunks_done = 0;
  std::string summary;
};

std::string progressKey(const std::string& tenant, const std::string& source_hash) { return "summary:progress:" + tenant + ":" + source_hash; }

// Fold one chunk's summary into the rolling summary of the source.
Progress applyChunk(const std::string& tenant, const std::string& source_ref, const std::string& source_hash, long chunk_index,
                    const std::string& chunk_summary) {
  // An edited source has another hash, so it starts a summary of its own.
  const auto reply = redis.eval<std::vector<std::string>>(kCommitLua, {progressKey(tenant, source_hash)},
                                                          {std::to_string(chunk_index), chunk_summary, std::to_string(kTtlSeconds), source_ref});
  return Progress{reply[0] == "1", std::stol(reply[1]), reply[2]};
}
`,
    },
  },
  harness: {
    python: `HASH_A = "a" * 64
HASH_B = "b" * 64
KEY_A = f"summary:progress:t1:{HASH_A}"


def _apply(m, source_hash, index, summary):
    return m.apply_chunk("t1", "doc-1", source_hash, index, summary)


def check_hash_key(ctx):
    m = ctx.load("state")
    _apply(m, HASH_A, 0, "Revenue rose.")
    _apply(m, HASH_A, 1, "Costs fell.")
    edited = _apply(m, HASH_B, 0, "Revenue fell.")
    assert edited["summary"] == "Revenue fell." and edited["chunks_done"] == 1, f"the first chunk of the edited source (hash bbbb...) answered {edited}: it extended the previous version's summary. Key progress by the source hash"
    keys = sorted(ctx.redis.keys("summary:progress:*"))
    assert ctx.redis.hget(f"summary:progress:t1:{HASH_B}", "summary") == "Revenue fell.", f"no summary:progress:t1:<source_hash> holds the edited source's summary; Redis holds {keys}"
    assert ctx.redis.hget(KEY_A, "chunks_done") == "2" and ctx.redis.hget(KEY_A, "source_ref") == "doc-1", f"the previous version must keep its own record with source_ref, got {ctx.redis.hgetall(KEY_A)}"


def check_atomic_commit(ctx):
    m = ctx.load("state")
    # A second worker delivers chunk 0 right after the first command on the record.
    rival = ctx.redis_after(KEY_A, lambda: _apply(m, HASH_A, 0, "Revenue rose."))
    _apply(m, HASH_A, 0, "Revenue rose.")
    assert rival.fired, f"apply_chunk never touched {KEY_A}: progress belongs under the source hash"
    if rival.error is not None:
        raise rival.error
    stored = ctx.redis.hgetall(KEY_A)
    assert stored.get("summary") == "Revenue rose." and stored.get("chunks_done") == "1", f"two deliveries of chunk 0 racing each other left {stored}: the read, the append and the count must run in one script, so the second sees the first"


def check_ttl(ctx):
    m = ctx.load("state")
    _apply(m, HASH_A, 0, "Revenue rose.")
    ttl = ctx.redis.ttl(KEY_A)
    assert 0 < ttl <= 3600, f"{KEY_A} has TTL {ttl}: progress for a source nobody finishes must expire (TTL_S = 3600)"
    _apply(m, HASH_A, 1, "Costs fell.")
    ttl = ctx.redis.ttl(KEY_A)
    assert 3500 < ttl <= 3600, f"after the second chunk {KEY_A} has TTL {ttl}, expected about 3600"


def check_idempotent_chunk(ctx):
    m = ctx.load("state")
    _apply(m, HASH_A, 0, "Revenue rose.")
    _apply(m, HASH_A, 1, "Costs fell.")
    again = _apply(m, HASH_A, 1, "Costs fell.")
    assert again["applied"] is False and again["chunks_done"] == 2, f"a redelivered chunk 1 answered {again}: a chunk already applied must leave the record alone and answer applied False"
    early = _apply(m, HASH_A, 3, "Margins widened.")
    assert early["applied"] is False and early["chunks_done"] == 2, f"chunk 3 before chunk 2 answered {early}: only the next chunk may be applied"
    stored = ctx.redis.hgetall(KEY_A)
    assert stored.get("summary") == "Revenue rose. Costs fell." and stored.get("chunks_done") == "2", f"after a redelivery and an early chunk the record is {stored}, expected the two chunks once each"
`,
    typescript: `const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const KEY_A = \`summary:progress:t1:\${HASH_A}\`;

const apply = (m, sourceHash: string, index: number, summary: string) => m.applyChunk('t1', 'doc-1', sourceHash, index, summary);

export async function check_hash_key(ctx) {
  const m = ctx.load('state');
  await apply(m, HASH_A, 0, 'Revenue rose.');
  await apply(m, HASH_A, 1, 'Costs fell.');
  const edited = await apply(m, HASH_B, 0, 'Revenue fell.');
  assert(edited.summary === 'Revenue fell.' && edited.chunks_done === 1, \`the first chunk of the edited source (hash bbbb...) answered \${JSON.stringify(edited)}: it extended the previous version's summary. Key progress by the source hash\`);
  assert.equal(ctx.redis.hget(\`summary:progress:t1:\${HASH_B}\`, 'summary'), 'Revenue fell.', \`no summary:progress:t1:<source_hash> holds the edited source's summary; Redis holds \${JSON.stringify(ctx.redis.keys('summary:progress:*'))}\`);
  assert(ctx.redis.hget(KEY_A, 'chunks_done') === '2' && ctx.redis.hget(KEY_A, 'source_ref') === 'doc-1', \`the previous version must keep its own record with source_ref, got \${JSON.stringify(ctx.redis.hgetall(KEY_A))}\`);
}

export async function check_atomic_commit(ctx) {
  const m = ctx.load('state');
  // A second worker delivers chunk 0 right after the first command on the record.
  const rival = ctx.redisAfter(KEY_A, () => apply(m, HASH_A, 0, 'Revenue rose.'));
  await apply(m, HASH_A, 0, 'Revenue rose.');
  assert(rival.fired, \`applyChunk never touched \${KEY_A}: progress belongs under the source hash\`);
  if (rival.error !== undefined) throw rival.error;
  await rival.result;
  const stored = ctx.redis.hgetall(KEY_A);
  assert(stored.summary === 'Revenue rose.' && stored.chunks_done === '1', \`two deliveries of chunk 0 racing each other left \${JSON.stringify(stored)}: the read, the append and the count must run in one script, so the second sees the first\`);
}

export async function check_ttl(ctx) {
  const m = ctx.load('state');
  await apply(m, HASH_A, 0, 'Revenue rose.');
  let ttl = ctx.redis.ttl(KEY_A);
  assert(ttl > 0 && ttl <= 3600, \`\${KEY_A} has TTL \${ttl}: progress for a source nobody finishes must expire (TTL_S = 3600)\`);
  await apply(m, HASH_A, 1, 'Costs fell.');
  ttl = ctx.redis.ttl(KEY_A);
  assert(ttl > 3500 && ttl <= 3600, \`after the second chunk \${KEY_A} has TTL \${ttl}, expected about 3600\`);
}

export async function check_idempotent_chunk(ctx) {
  const m = ctx.load('state');
  await apply(m, HASH_A, 0, 'Revenue rose.');
  await apply(m, HASH_A, 1, 'Costs fell.');
  const again = await apply(m, HASH_A, 1, 'Costs fell.');
  assert(again.applied === false && again.chunks_done === 2, \`a redelivered chunk 1 answered \${JSON.stringify(again)}: a chunk already applied must leave the record alone and answer applied false\`);
  const early = await apply(m, HASH_A, 3, 'Margins widened.');
  assert(early.applied === false && early.chunks_done === 2, \`chunk 3 before chunk 2 answered \${JSON.stringify(early)}: only the next chunk may be applied\`);
  const stored = ctx.redis.hgetall(KEY_A);
  assert(stored.summary === 'Revenue rose. Costs fell.' && stored.chunks_done === '2', \`after a redelivery and an early chunk the record is \${JSON.stringify(stored)}, expected the two chunks once each\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"leetbuild/harness"
)

var (
	stateHashA = strings.Repeat("a", 64)
	stateHashB = strings.Repeat("b", 64)
	stateKeyA  = "summary:progress:t1:" + stateHashA
)

func stateApply(ctx *harness.Ctx, sourceHash string, index int, summary string) Progress {
	p, err := applyChunk(context.Background(), "t1", "doc-1", sourceHash, index, summary)
	ctx.NoError(err, "applyChunk(chunk %d) failed", index)
	return p
}

func CheckHashKey(ctx *harness.Ctx) {
	stateApply(ctx, stateHashA, 0, "Revenue rose.")
	stateApply(ctx, stateHashA, 1, "Costs fell.")
	edited := stateApply(ctx, stateHashB, 0, "Revenue fell.")
	ctx.Assert(edited.Summary == "Revenue fell." && edited.ChunksDone == 1, "the first chunk of the edited source (hash bbbb...) answered %+v: it extended the previous version's summary. Key progress by the source hash", edited)
	got, _ := ctx.Redis.HGet("summary:progress:t1:"+stateHashB, "summary")
	ctx.Equal(got, "Revenue fell.", "summary:progress:t1:<source_hash> must hold the edited source's summary (Redis holds %q)", ctx.Redis.Keys("summary:progress:*"))
	old := ctx.Redis.HGetAll(stateKeyA)
	ctx.Assert(old["chunks_done"] == "2" && old["source_ref"] == "doc-1", "the previous version must keep its own record with source_ref, got %v", old)
}

func CheckAtomicCommit(ctx *harness.Ctx) {
	// A second worker delivers chunk 0 right after the first command on the record.
	rival := ctx.Redis.After(stateKeyA, func() any {
		p, err := applyChunk(context.Background(), "t1", "doc-1", stateHashA, 0, "Revenue rose.")
		if err != nil {
			return err.Error()
		}
		return p
	})
	stateApply(ctx, stateHashA, 0, "Revenue rose.")
	ctx.Assert(rival.Fired, "applyChunk never touched %s: progress belongs under the source hash", stateKeyA)
	stored := ctx.Redis.HGetAll(stateKeyA)
	ctx.Assert(stored["summary"] == "Revenue rose." && stored["chunks_done"] == "1", "two deliveries of chunk 0 racing each other left %v: the read, the append and the count must run in one script, so the second sees the first", stored)
}

func CheckTtl(ctx *harness.Ctx) {
	stateApply(ctx, stateHashA, 0, "Revenue rose.")
	ttl := ctx.Redis.TTL(stateKeyA)
	ctx.Assert(ttl > 0 && ttl <= 3600, "%s has TTL %d: progress for a source nobody finishes must expire (TTL_S = 3600)", stateKeyA, ttl)
	stateApply(ctx, stateHashA, 1, "Costs fell.")
	ttl = ctx.Redis.TTL(stateKeyA)
	ctx.Assert(ttl > 3500 && ttl <= 3600, "after the second chunk %s has TTL %d, expected about 3600", stateKeyA, ttl)
}

func CheckIdempotentChunk(ctx *harness.Ctx) {
	stateApply(ctx, stateHashA, 0, "Revenue rose.")
	stateApply(ctx, stateHashA, 1, "Costs fell.")
	again := stateApply(ctx, stateHashA, 1, "Costs fell.")
	ctx.Assert(!again.Applied && again.ChunksDone == 2, "a redelivered chunk 1 answered %+v: a chunk already applied must leave the record alone and answer applied false", again)
	early := stateApply(ctx, stateHashA, 3, "Margins widened.")
	ctx.Assert(!early.Applied && early.ChunksDone == 2, "chunk 3 before chunk 2 answered %+v: only the next chunk may be applied", early)
	stored := ctx.Redis.HGetAll(stateKeyA)
	ctx.Assert(stored["summary"] == "Revenue rose. Costs fell." && stored["chunks_done"] == "2", "after a redelivery and an early chunk the record is %v, expected the two chunks once each", stored)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

namespace {

const std::string kHashA(64, 'a');
const std::string kHashB(64, 'b');
const std::string kKeyA = "summary:progress:t1:" + kHashA;

Progress stateApply(const std::string& source_hash, long index, const std::string& summary) {
  return applyChunk("t1", "doc-1", source_hash, index, summary);
}

std::string field(harness::Ctx& ctx, const std::string& key, const std::string& name) { return ctx.Redis.HGet(key, name).value_or(""); }

}  // namespace

void CheckHashKey(harness::Ctx& ctx) {
  stateApply(kHashA, 0, "Revenue rose.");
  stateApply(kHashA, 1, "Costs fell.");
  const Progress edited = stateApply(kHashB, 0, "Revenue fell.");
  ctx.Assert(edited.summary == "Revenue fell." && edited.chunks_done == 1,
             "the first chunk of the edited source (hash bbbb...) answered %d chunks, %q: it extended the previous version's summary. Key progress by the source hash", edited.chunks_done, edited.summary);
  ctx.Equal(field(ctx, "summary:progress:t1:" + kHashB, "summary"), "Revenue fell.", "summary:progress:t1:<source_hash> must hold the edited source's summary (Redis holds %q)", ctx.Redis.Keys("summary:progress:*"));
  ctx.Assert(field(ctx, kKeyA, "chunks_done") == "2" && field(ctx, kKeyA, "source_ref") == "doc-1", "the previous version must keep its own record with source_ref, got %v", ctx.Redis.HGetAll(kKeyA));
}

void CheckAtomicCommit(harness::Ctx& ctx) {
  // A second worker delivers chunk 0 right after the first command on the record.
  bool fired = false;
  ctx.Redis.After(kKeyA, [&fired] {
    fired = true;
    stateApply(kHashA, 0, "Revenue rose.");
  });
  stateApply(kHashA, 0, "Revenue rose.");
  ctx.Assert(fired, "applyChunk never touched %s: progress belongs under the source hash", kKeyA);
  const auto stored = ctx.Redis.HGetAll(kKeyA);
  ctx.Assert(field(ctx, kKeyA, "summary") == "Revenue rose." && field(ctx, kKeyA, "chunks_done") == "1",
             "two deliveries of chunk 0 racing each other left %v: the read, the append and the count must run in one script, so the second sees the first", stored);
}

void CheckTtl(harness::Ctx& ctx) {
  stateApply(kHashA, 0, "Revenue rose.");
  long long ttl = ctx.Redis.TTL(kKeyA);
  ctx.Assert(ttl > 0 && ttl <= 3600, "%s has TTL %d: progress for a source nobody finishes must expire (TTL_S = 3600)", kKeyA, ttl);
  stateApply(kHashA, 1, "Costs fell.");
  ttl = ctx.Redis.TTL(kKeyA);
  ctx.Assert(ttl > 3500 && ttl <= 3600, "after the second chunk %s has TTL %d, expected about 3600", kKeyA, ttl);
}

void CheckIdempotentChunk(harness::Ctx& ctx) {
  stateApply(kHashA, 0, "Revenue rose.");
  stateApply(kHashA, 1, "Costs fell.");
  const Progress again = stateApply(kHashA, 1, "Costs fell.");
  ctx.Assert(!again.applied && again.chunks_done == 2, "a redelivered chunk 1 answered applied %t with %d chunks: a chunk already applied must leave the record alone and answer applied false", again.applied, again.chunks_done);
  const Progress early = stateApply(kHashA, 3, "Margins widened.");
  ctx.Assert(!early.applied && early.chunks_done == 2, "chunk 3 before chunk 2 answered applied %t with %d chunks: only the next chunk may be applied", early.applied, early.chunks_done);
  ctx.Assert(field(ctx, kKeyA, "summary") == "Revenue rose. Costs fell." && field(ctx, kKeyA, "chunks_done") == "2",
             "after a redelivery and an early chunk the record is %v, expected the two chunks once each", ctx.Redis.HGetAll(kKeyA));
}
`,
  },
  hints: [
    'Summarize a source, edit it, and send the first chunk of the new version: the summary still opens with the old text. Deliver one chunk twice and it appears twice; the record never expires.',
    'The key is built from `source_ref`, which an edit does not change. The append is a client-side read then write, and `HINCRBY` counts every call, so nothing compares the incoming chunk with the count.',
    'Build the key from `source_hash`; move it all into one script: `HGET chunks_done`, return `{"0", done, summary}` unless `ARGV[1]` equals it, else append, `HSET` summary, count and `source_ref`, `EXPIRE` `TTL_S`.',
  ],
  debrief: `Binding the record to the content hash turns "which version is this summary of" into a property of the key, so an edit cannot resume work done on text that no longer exists. Comparing the chunk index with the count inside the script makes the counter mean "chunks applied in order", which is what lets a redelivery, a second worker and an early chunk all be harmless. The TTL is refreshed on every applied chunk because a long source that is still moving should stay alive. A production pipeline also stores each chunk's summary separately so one bad chunk can be redone, and records the source hash and model version on the finished summary.`,
};
