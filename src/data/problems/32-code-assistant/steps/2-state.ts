import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis index cache with checksum invalidation',
  concept: 'redis',
  file: 'state',
  focus: ['assistant', 'redis', 'indexer'],
  task: `## Task

The starter is a plausible model-generated draft: the first completion for a repository stores a
summary and the next ones read it back, so the demo is fast. It is keyed by repository name, it never
expires, and it writes the entry field by field. Find the flaws, fix them, and prove the fix.

Implement \`get_index_summary(tenant, repo, commit_sha)\`, the cache the completion path reads before
it calls the symbol index.

- One summary per **(tenant, repo, commit sha)**: the key is
  \`index:{tenant}:{repo}:{commit_sha}\`, built by \`cache_key(...)\`. A **commit change is a cache
  miss** — history is rewritten all the time, and a cache keyed by repository name keeps serving
  symbols from a commit nobody can check out any more.
- The entry expires after **10 minutes** (\`INDEX_TTL_S = 600\`) and the TTL is applied by the write
  itself. A summary with no expiry outlives the commit it describes and is indistinguishable from a
  current one.
- The refresh is **one atomic set** of the whole payload with its TTL (\`SET key payload EX 600\`),
  never a read-modify-write and never a sequence of field writes: two requests that miss together
  must not leave a half-written entry behind, and a partial write must never be readable.
- A cached entry that describes a **different commit** than the one requested is a miss, never a
  hit. The key carries the commit, and the entry is checked against it too, so an entry that was
  written under a colliding or truncated key cannot be served as current.
- The entry carries a **checksum** of its symbol payload (\`checksum_of\`); an entry whose checksum
  does not match its own payload is treated as a miss, so a truncated value cannot be served as if
  it were complete.
- On a miss the summary comes from the symbol index and is written back under the same key, so the
  next request for that commit is a hit.

**Failure mode the checks target.** The subtle one is the key: caching by repository name looks
natural and passes every demo, then a force-push lands and the assistant completes from symbols the
repository no longer contains. The loud one is the partial write — two requests race, each writes
part of the entry, and the next reader gets a summary that is neither the old one nor the new one.
And a cache with no TTL turns into a second, wrong index that nobody can invalidate.`,
  sequence: {
    participants: ['Completion path', 'Redis', 'Symbol index'],
    messages: [
      {from: 'Completion path', to: 'Redis', label: 'GET index:acme:api:{commit_sha}', kind: 'sync'},
      {from: 'Redis', to: 'Completion path', label: 'summary / nil · sha or checksum mismatch', kind: 'reply'},
      {from: 'Completion path', to: 'Symbol index', label: 'summarize(tenant, repo, commit_sha)', kind: 'sync'},
      {from: 'Symbol index', to: 'Completion path', label: 'symbols for that commit', kind: 'reply'},
      {
        from: 'Completion path',
        to: 'Redis',
        label: 'SET index:acme:api:{commit_sha} payload EX 600 · one atomic write',
        kind: 'async',
      },
      {from: 'Completion path', to: 'Completion path', label: 'return the summary it just wrote', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'per-commit-key',
      title: 'Caches one summary per (tenant, repo, commit sha)',
      detail:
        'The cache key is built by `cacheKey(tenant, repo, commitSha)` from all three parts, so a new commit is a different key. The draft keys by repository name alone, so a force-push keeps serving symbols that no longer exist.',
      match: {
        python: {all: [/index:/, /cache_key\(\s*tenant,\s*repo,\s*commit_sha\s*\)/]},
        typescript: {all: [/index:/, /cacheKey\(\s*tenant,\s*repo,\s*commitSha\s*\)/]},
        go: {all: [/index:/, /cacheKey\(\s*tenant,\s*repo,\s*commitSHA\s*\)/]},
        scala: {all: [/index:/, /cacheKey\(\s*tenant,\s*repo,\s*commitSha\s*\)/]},
        cpp: {all: [/index:/, /cache_key\(\s*tenant,\s*repo,\s*commitSha\s*\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires the summary after ten minutes',
      detail:
        "The entry carries `INDEX_TTL_S = 600` and the expiry is part of the write (`ex=INDEX_TTL_S`, `'EX'`, `indexTTLS*time.Second`, `setex`, `std::chrono::seconds`). The draft sets no expiry at all, so every commit ever indexed stays in Redis.",
      match: {
        python: {all: [/INDEX_TTL_S\s*=\s*600/, /ex=INDEX_TTL_S/]},
        typescript: {all: [/INDEX_TTL_S\s*=\s*600/, /'EX',\s*INDEX_TTL_S/]},
        go: {all: [/indexTTLS\s*=\s*600/, /indexTTLS\s*\*\s*time\.Second/]},
        scala: {all: [/IndexTTLS\s*=\s*600/, /setex\(key,\s*IndexTTLS/]},
        cpp: {all: [/kIndexTTLS\s*=\s*600/, /std::chrono::seconds\(kIndexTTLS\)/]},
      },
    },
    {
      id: 'atomic-set',
      title: 'Refreshes the entry with a single atomic set',
      detail:
        'One call writes the whole payload and its TTL together, and there is no field-by-field `HSET` that another request can interleave with. The draft writes three fields in three calls, so two racing refreshes leave a mixture of two commits.',
      match: {
        python: {all: [/\.set\(key, payload, ex=INDEX_TTL_S\)/], none: [/hset\(/]},
        typescript: {all: [/\.set\(key, payload, 'EX', INDEX_TTL_S\)/], none: [/hset\(/]},
        go: {all: [/\.Set\(ctx, key, payload, indexTTLS\s*\*\s*time\.Second\)/], none: [/\.HSet\(/]},
        scala: {all: [/\.setex\(key, IndexTTLS, payload\)/], none: [/\.hset\(/]},
        cpp: {all: [/\.set\(key, payload, std::chrono::seconds\(kIndexTTLS\)\)/], none: [/\.hset\(/]},
      },
    },
    {
      id: 'commit-guard',
      title: 'Never serves an entry from another commit',
      detail:
        'A cached entry is only used when the commit it describes is the commit that was asked for, so an entry that survived a force-push cannot be served as current. The draft returns whatever the key held.',
      match: {
        python: {all: [/entry\["commit_sha"\] == commit_sha/]},
        typescript: {all: [/entry\.commit_sha === commitSha/]},
        go: {all: [/entry\.CommitSHA == commitSHA/]},
        scala: {all: [/entry\.commit_sha == commitSha/]},
        cpp: {all: [/entry\.commit_sha == commitSha/]},
      },
    },
    {
      id: 'checksum',
      title: 'Rejects an entry whose checksum does not match its payload',
      detail:
        'The stored summary carries `checksumOf(symbols)` and the read recomputes it, treating a mismatch as a miss. The draft stores no checksum, so a truncated or partially written value is served as a complete index.',
      match: {
        python: {all: [/checksum_of\(/, /sha256/]},
        typescript: {all: [/checksumOf\(/, /sha256/]},
        go: {all: [/checksumOf\(/, /sha256/]},
        scala: {all: [/checksumOf\(/, /SHA-256/]},
        cpp: {all: [/checksum_of\(/, /fnv1a/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class SymbolIndex:
    def summarize(self, tenant: str, repo: str, commit_sha: str) -> dict:
        """The symbol index service: the symbols defined by one commit of one repository."""
        raise NotImplementedError


index = SymbolIndex()


def get_index_summary(tenant: str, repo: str, commit_sha: str) -> dict:
    # TODO: this draft caches by repository name alone, so a force-pushed history keeps serving
    # symbols that no longer exist, and it refreshes the entry with partial HSET writes when two
    # requests miss together.
    key = f"index:{repo}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    summary = index.summarize(tenant, repo, commit_sha)
    r.hset(key, mapping={"commit_sha": commit_sha})
    r.hset(key, mapping={"symbols": json.dumps(summary["symbols"])})
    r.hset(key, mapping={"count": summary["count"]})
    return {"commit_sha": commit_sha, "symbols": summary["symbols"], "count": summary["count"]}
`,
      solution: `import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

INDEX_TTL_S = 600


class SymbolIndex:
    def summarize(self, tenant: str, repo: str, commit_sha: str) -> dict:
        """The symbol index service: the symbols defined by one commit of one repository."""
        raise NotImplementedError


index = SymbolIndex()


def cache_key(tenant: str, repo: str, commit_sha: str) -> str:
    """One summary per commit: a rewritten history must not inherit the symbols of the old one."""
    return f"index:{tenant}:{repo}:{commit_sha}"


def checksum_of(symbols: list) -> str:
    """Checksum of the symbol payload; an entry that fails it is treated as a miss."""
    raw = json.dumps(symbols, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def get_index_summary(tenant: str, repo: str, commit_sha: str) -> dict:
    key = cache_key(tenant, repo, commit_sha)
    cached = r.get(key)
    if cached is not None:
        entry = json.loads(cached)
        if entry["commit_sha"] == commit_sha and entry["checksum"] == checksum_of(entry["symbols"]):
            return entry
    summary = index.summarize(tenant, repo, commit_sha)
    payload = json.dumps(
        {
            "commit_sha": commit_sha,
            "symbols": summary["symbols"],
            "count": summary["count"],
            "checksum": checksum_of(summary["symbols"]),
        }
    )
    # one atomic SET carries the whole summary and its TTL: no partial field writes, no second EXPIRE
    r.set(key, payload, ex=INDEX_TTL_S)
    return json.loads(payload)
`,
    },
    typescript: {
      starter: `/** getIndexSummary: a model-generated draft that caches the index by repository name. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface IndexSummary {
  commit_sha: string;
  symbols: string[];
  count: number;
}

class SymbolIndex {
  async summarize(tenant: string, repo: string, commitSha: string): Promise<{symbols: string[]; count: number}> {
    throw new Error('symbol index not wired');
  }
}

const index = new SymbolIndex();

export async function getIndexSummary(tenant: string, repo: string, commitSha: string): Promise<IndexSummary> {
  // TODO: this draft caches by repository name alone, so a force-pushed history keeps serving
  // symbols that no longer exist, and it refreshes the entry with partial HSET writes when two
  // requests miss together.
  const key = 'index:' + repo;
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as IndexSummary;
  const summary = await index.summarize(tenant, repo, commitSha);
  await r.hset(key, 'commit_sha', commitSha);
  await r.hset(key, 'symbols', JSON.stringify(summary.symbols));
  await r.hset(key, 'count', String(summary.count));
  return {commit_sha: commitSha, symbols: summary.symbols, count: summary.count};
}
`,
      solution: `/** getIndexSummary: one summary per (tenant, repo, commit) written by a single atomic SET. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const INDEX_TTL_S = 600;

interface IndexSummary {
  commit_sha: string;
  symbols: string[];
  count: number;
  checksum: string;
}

class SymbolIndex {
  async summarize(tenant: string, repo: string, commitSha: string): Promise<{symbols: string[]; count: number}> {
    throw new Error('symbol index not wired');
  }
}

const index = new SymbolIndex();

function cacheKey(tenant: string, repo: string, commitSha: string): string {
  return 'index:' + tenant + ':' + repo + ':' + commitSha;
}

function checksumOf(symbols: string[]): string {
  return createHash('sha256').update(JSON.stringify(symbols)).digest('hex');
}

export async function getIndexSummary(tenant: string, repo: string, commitSha: string): Promise<IndexSummary> {
  const key = cacheKey(tenant, repo, commitSha);
  const cached = await r.get(key);
  if (cached !== null) {
    const entry = JSON.parse(cached) as IndexSummary;
    if (entry.commit_sha === commitSha && entry.checksum === checksumOf(entry.symbols)) return entry;
  }
  const summary = await index.summarize(tenant, repo, commitSha);
  const payload = JSON.stringify({
    commit_sha: commitSha,
    symbols: summary.symbols,
    count: summary.count,
    checksum: checksumOf(summary.symbols),
  });
  // one atomic SET with EX carries the whole summary and its TTL
  await r.set(key, payload, 'EX', INDEX_TTL_S);
  return JSON.parse(payload) as IndexSummary;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type IndexSummary struct {
	CommitSHA string   \`json:"commit_sha"\`
	Symbols   []string \`json:"symbols"\`
	Count     int      \`json:"count"\`
	Checksum  string   \`json:"checksum"\`
}

type SymbolIndex struct{}

func (s *SymbolIndex) Summarize(ctx context.Context, tenant, repo, commitSHA string) ([]string, error) {
	return nil, nil
}

var index = &SymbolIndex{}

func getIndexSummary(ctx context.Context, tenant, repo, commitSHA string) (IndexSummary, error) {
	// TODO: this draft caches by repository name alone, so a force-pushed history keeps serving
	// symbols that no longer exist, and it refreshes the entry with partial HSET writes when two
	// requests miss together.
	key := fmt.Sprintf("index:%s", repo)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var entry IndexSummary
		if json.Unmarshal([]byte(cached), &entry) == nil {
			return entry, nil
		}
	}
	symbols, err := index.Summarize(ctx, tenant, repo, commitSHA)
	if err != nil {
		return IndexSummary{}, err
	}
	rdb.HSet(ctx, key, "commit_sha", commitSHA)
	rdb.HSet(ctx, key, "symbols", symbols)
	rdb.HSet(ctx, key, "count", len(symbols))
	return IndexSummary{CommitSHA: commitSHA, Symbols: symbols, Count: len(symbols)}, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const indexTTLS = 600

var rdb *redis.Client

type IndexSummary struct {
	CommitSHA string   \`json:"commit_sha"\`
	Symbols   []string \`json:"symbols"\`
	Count     int      \`json:"count"\`
	Checksum  string   \`json:"checksum"\`
}

type SymbolIndex struct{}

func (s *SymbolIndex) Summarize(ctx context.Context, tenant, repo, commitSHA string) ([]string, error) {
	return nil, nil
}

var index = &SymbolIndex{}

func cacheKey(tenant, repo, commitSHA string) string {
	return fmt.Sprintf("index:%s:%s:%s", tenant, repo, commitSHA)
}

func checksumOf(symbols []string) (string, error) {
	raw, err := json.Marshal(symbols)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func getIndexSummary(ctx context.Context, tenant, repo, commitSHA string) (IndexSummary, error) {
	key := cacheKey(tenant, repo, commitSHA)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var entry IndexSummary
		if json.Unmarshal([]byte(cached), &entry) == nil && entry.CommitSHA == commitSHA {
			if want, err := checksumOf(entry.Symbols); err == nil && want == entry.Checksum {
				return entry, nil
			}
		}
	}
	symbols, err := index.Summarize(ctx, tenant, repo, commitSHA)
	if err != nil {
		return IndexSummary{}, err
	}
	checksum, err := checksumOf(symbols)
	if err != nil {
		return IndexSummary{}, err
	}
	entry := IndexSummary{CommitSHA: commitSHA, Symbols: symbols, Count: len(symbols), Checksum: checksum}
	payload, err := json.Marshal(entry)
	if err != nil {
		return IndexSummary{}, err
	}
	// one atomic SET carries the whole summary and its TTL: no partial field writes, no second EXPIRE
	if err := rdb.Set(ctx, key, payload, indexTTLS*time.Second).Err(); err != nil {
		return IndexSummary{}, err
	}
	return entry, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class IndexSummary(commit_sha: String, symbols: List[String], count: Int)

object SymbolIndex {
  def summarize(tenant: String, repo: String, commitSha: String): List[String] = ???
}

object IndexSummaryStore {
  val r = new Jedis("redis", 6379)
  val index = SymbolIndex

  implicit val summaryFormat: RootJsonFormat[IndexSummary] = jsonFormat3(IndexSummary)

  def getIndexSummary(tenant: String, repo: String, commitSha: String): IndexSummary = {
    // TODO: this draft caches by repository name alone, so a force-pushed history keeps serving
    // symbols that no longer exist, and it refreshes the entry with partial HSET writes when two
    // requests miss together.
    val key = s"index:$repo"
    Option(r.get(key)) match {
      case Some(cached) => return cached.parseJson.convertTo[IndexSummary]
      case None         => ()
    }
    val symbols = index.summarize(tenant, repo, commitSha)
    r.hset(key, "commit_sha", commitSha)
    r.hset(key, "symbols", symbols.mkString(","))
    r.hset(key, "count", symbols.length.toString)
    IndexSummary(commitSha, symbols, symbols.length)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class IndexSummary(commit_sha: String, symbols: List[String], count: Int, checksum: String)

object SymbolIndex {
  def summarize(tenant: String, repo: String, commitSha: String): List[String] = ???
}

object IndexSummaryStore {
  val IndexTTLS = 600L
  val r = new Jedis("redis", 6379)
  val index = SymbolIndex

  implicit val summaryFormat: RootJsonFormat[IndexSummary] = jsonFormat4(IndexSummary)

  def cacheKey(tenant: String, repo: String, commitSha: String): String =
    s"index:$tenant:$repo:$commitSha"

  def checksumOf(symbols: List[String]): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(symbols.mkString(",").getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  def getIndexSummary(tenant: String, repo: String, commitSha: String): IndexSummary = {
    val key = cacheKey(tenant, repo, commitSha)
    Option(r.get(key)) match {
      case Some(cached) =>
        val entry = cached.parseJson.convertTo[IndexSummary]
        if (entry.commit_sha == commitSha && entry.checksum == checksumOf(entry.symbols)) return entry
      case None => ()
    }
    val symbols = index.summarize(tenant, repo, commitSha)
    val entry = IndexSummary(commitSha, symbols, symbols.length, checksumOf(symbols))
    val payload = entry.toJson.compactPrint
    // one atomic SETEX carries the whole summary and its TTL
    r.setex(key, IndexTTLS, payload)
    entry
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

struct IndexSummary {
  std::string commit_sha;
  std::vector<std::string> symbols;
  int count;
};

void to_json(json& out, const IndexSummary& entry) {
  out = json{{"commit_sha", entry.commit_sha}, {"symbols", entry.symbols}, {"count", entry.count}};
}

void from_json(const json& in, IndexSummary& entry) {
  entry.commit_sha = in.value("commit_sha", std::string());
  entry.symbols = in.value("symbols", std::vector<std::string>());
  entry.count = in.value("count", 0);
}

std::vector<std::string> summarize(const std::string& tenant, const std::string& repo,
                                   const std::string& commitSha);

IndexSummary get_index_summary(sw::redis::Redis& redis, const std::string& tenant, const std::string& repo,
                               const std::string& commitSha) {
  // TODO: this draft caches by repository name alone, so a force-pushed history keeps serving
  // symbols that no longer exist, and it refreshes the entry with partial HSET writes when two
  // requests miss together.
  const auto key = "index:" + repo;
  if (auto cached = redis.get(key)) {
    const auto raw = json::parse(*cached, nullptr, false);
    if (raw.is_object()) return raw.get<IndexSummary>();
  }
  const auto symbols = summarize(tenant, repo, commitSha);
  redis.hset(key, "commit_sha", commitSha);
  redis.hset(key, "symbols", json(symbols).dump());
  redis.hset(key, "count", std::to_string(symbols.size()));
  return IndexSummary{commitSha, symbols, static_cast<int>(symbols.size())};
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kIndexTTLS = 600;

struct IndexSummary {
  std::string commit_sha;
  std::vector<std::string> symbols;
  int count;
  std::string checksum;
};

void to_json(json& out, const IndexSummary& entry) {
  out = json{{"commit_sha", entry.commit_sha},
             {"symbols", entry.symbols},
             {"count", entry.count},
             {"checksum", entry.checksum}};
}

void from_json(const json& in, IndexSummary& entry) {
  entry.commit_sha = in.value("commit_sha", std::string());
  entry.symbols = in.value("symbols", std::vector<std::string>());
  entry.count = in.value("count", 0);
  entry.checksum = in.value("checksum", std::string());
}

std::vector<std::string> summarize(const std::string& tenant, const std::string& repo,
                                   const std::string& commitSha);

std::string cache_key(const std::string& tenant, const std::string& repo, const std::string& commitSha) {
  return "index:" + tenant + ":" + repo + ":" + commitSha;
}

/** FNV-1a over the symbol payload: an entry whose checksum does not match it is a miss. */
std::string fnv1a(const std::string& payload) {
  std::uint64_t hash = 14695981039346656037ULL;
  for (const unsigned char byte : payload) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return std::to_string(hash);
}

std::string checksum_of(const std::vector<std::string>& symbols) {
  return fnv1a(json(symbols).dump());
}

IndexSummary get_index_summary(sw::redis::Redis& redis, const std::string& tenant, const std::string& repo,
                               const std::string& commitSha) {
  const auto key = cache_key(tenant, repo, commitSha);
  if (auto cached = redis.get(key)) {
    const auto raw = json::parse(*cached, nullptr, false);
    if (raw.is_object()) {
      const auto entry = raw.get<IndexSummary>();
      if (entry.commit_sha == commitSha && entry.checksum == checksum_of(entry.symbols)) return entry;
    }
  }
  const auto symbols = summarize(tenant, repo, commitSha);
  const IndexSummary entry{commitSha, symbols, static_cast<int>(symbols.size()), checksum_of(symbols)};
  const auto payload = json(entry).dump();
  // one atomic set carries the whole summary and its TTL: no field writes, no second expire
  redis.set(key, payload, std::chrono::seconds(kIndexTTLS));
  return entry;
}
`,
    },
  },
  hints: [
    'The key is the whole fix for the force-push case: `cache_key(tenant, repo, commit_sha)` puts the commit in the key, so the request that follows a push looks in a different slot and misses. Never let a caller or a helper drop the sha — a key you cannot vary by commit is a key that cannot be invalidated.',
    'One write, one payload: `SET key payload EX 600` replaces the entry wholesale and applies the TTL in the same call. `HSET` per field is the draft’s race: a second request that misses at the same moment can replace `symbols` while the first is still writing `commit_sha`, and the next reader gets a mixture.',
    'Checksum the payload you store and recompute it on read: an entry whose checksum does not match its symbols is a miss, not a hit. Together with the commit guard (`entry["commit_sha"] == commit_sha`) that makes the cache self-checking — a wrong entry can only cost a miss, never a wrong completion.',
  ],
  debrief: `The interview question is cache correctness under a mutable key space. Three separate invariants are being tested. First, the key must contain everything the value depends on: the summary is a function of the commit, so the commit belongs in the key, and "the repository" does not. Second, the value must be written atomically, because two executions of the same miss will race by construction — they happen exactly when the entry is absent. Third, the value must be self-describing: a commit field and a payload checksum turn any corruption, truncation or key collision into a miss instead of a wrong suggestion. Real assistants add the same treatment one level up (index version, tokenizer version, embedding model version in the key), evict through a short TTL rather than explicit invalidation, and keep a small "indexed at" sample so an operator can see how often completions are served from a stale commit.`,
};
