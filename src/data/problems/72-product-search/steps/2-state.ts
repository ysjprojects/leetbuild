import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis query cache keyed by the whole query',
  concept: 'redis',
  file: 'state',
  focus: ['search', 'redis', 'catalog'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it hashes nothing, builds a
cache key out of the query string, stores the result set, and serves it back. It compiles, it speeds
up the demo, and it hides three production flaws. Review it like the service owner, fix it, and prove
the fix with the checks below.

Implement the Redis query cache used by \`GET /v1/search\`.

- The key covers **every input that changes the results**: the tenant, the **normalized** query, the
  **filter hash**, the page, and the **catalog index version**. A filter-less key serves a cached
  unfiltered result set to a filtered request; a tenant-less key serves one tenant's products to
  another; a version-less key keeps serving an old price.
- Normalize the query before keying (\`strip\` / \`trim\` + lowercase + collapse whitespace), so the
  same search typed with different spacing hits one entry.
- Hash the filters deterministically — canonical JSON with sorted keys, then a digest
  (\`sha256\` / \`createHash\` / \`MessageDigest\` / FNV-1a) — so filter order cannot create two entries
  that mean the same thing.
- Entries expire after **60 seconds** (\`CACHE_TTL_S = 60\` with \`setex\` / \`SET … EX\` / \`SetEx\`).
  The draft expires nothing, so a price change never appears.
- The current index version is read per request from Redis, and a catalog update **bumps** it
  (\`INCR catalog:index_version\`). The next request then misses without waiting for the TTL — that is
  the difference between a cache key and an eviction signal.

**Failure mode the checks target.** A cache key is a contract: it must name everything the cached
value depends on. The draft's key names one of five inputs, so a hit can be wrong — wrong filters,
wrong tenant, wrong catalog version — and because nothing expires, the wrong answer is permanent.
The fix is to derive the key from a normalized query and a canonical filter hash, include the tenant
and the page, and let the index version rotate the key namespace on every catalog publish.`,
  sequence: {
    participants: ['Search API', 'Redis', 'Query engine', 'Catalog publisher'],
    messages: [
      {
        from: 'Search API',
        to: 'Search API',
        label: 'normalize q · canonical filter hash · read index version',
        kind: 'sync',
      },
      {
        from: 'Search API',
        to: 'Redis',
        label: 'GET search:{tenant}:{version}:{page}:{filterHash}:{queryHash}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Search API', label: 'cached page / nil', kind: 'reply'},
      {from: 'Search API', to: 'Query engine', label: 'run the query (on miss)', kind: 'sync'},
      {from: 'Query engine', to: 'Search API', label: 'page of products', kind: 'reply'},
      {from: 'Search API', to: 'Redis', label: 'SETEX key 60 payload', kind: 'async'},
      {from: 'Catalog publisher', to: 'Redis', label: 'INCR catalog:index_version', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'cache-key',
      title: 'The key covers tenant, query, filters, page and index version',
      detail:
        "The cache key is derived from `(tenant, normalized q, filter hash, page, index version)`. The draft keys by the raw query alone, so a cached unfiltered result set answers a filtered request and one tenant reads another tenant's results.",
      match: {
        python: {all: [/def cache_key\(/, /tenant/, /filter_hash/, /index_version/, /page/]},
        typescript: {all: [/function cacheKey\(/, /tenant/, /filterHash/, /indexVersion/, /page/]},
        go: {all: [/func cacheKey\(/, /tenant/, /filterHash/, /indexVersion/, /page/]},
        scala: {all: [/def cacheKey\(/, /tenant/, /filterHash/, /indexVersion/, /page/]},
        cpp: {all: [/cache_key\(/, /tenant/, /filter_hash/, /index_version/, /page/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire after 60 seconds',
      detail:
        'The cache writes with a 60-second TTL (`setex` / `SET … EX` / `SetEx`). The draft writes with no expiry, so the first answer is served until a deploy or a restart.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*60/, /\.setex\(/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*60/, /\.set\([^;\n]*'EX'/]},
        go: {all: [/cacheTTLSeconds\s*=\s*60/, /\.SetEx\(/]},
        scala: {all: [/CacheTtlSeconds\s*=\s*60/, /\.setex\(/]},
        cpp: {all: [/kCacheTtlSeconds\s*=\s*60/, /\.set\([^;]*kCacheTtlSeconds/]},
      },
    },
    {
      id: 'normalized-query',
      title: 'Normalizes the query before keying',
      detail:
        'The query is trimmed, lowercased and whitespace-collapsed before it enters the key, so `" Red  Shoes "` and `"red shoes"` share one entry. The draft keys the raw string.',
      match: {
        python: {all: [/def normalize_query\(/, /strip\(\)\.lower\(\)/]},
        typescript: {all: [/function normalizeQuery\(/, /trim\(\)\.toLowerCase\(\)/]},
        go: {all: [/func normalizeQuery\(/, /strings\.ToLower\(strings\.TrimSpace\(/]},
        scala: {all: [/def normalizeQuery\(/, /trim\.toLowerCase/]},
        cpp: {all: [/normalize_query\(/, /tolower/]},
      },
    },
    {
      id: 'filter-hash',
      title: 'Hashes filters canonically',
      detail:
        'Filters enter the key as a deterministic digest over canonical (sorted-key) JSON, so `{a,b}` and `{b,a}` are one entry. The draft ignores filters entirely, which is the leak that serves unfiltered results to a filtered query.',
      match: {
        python: {all: [/def filter_hash\(/, /hashlib/]},
        typescript: {all: [/function filterHash\(/, /createHash\(/]},
        go: {all: [/func filterHash\(/, /sha256\./]},
        scala: {all: [/def filterHash\(/, /MessageDigest/]},
        cpp: {all: [/filter_hash\(/, /fnv1a/]},
      },
    },
    {
      id: 'version-bump',
      title: 'Bumps the index version on a catalog update',
      detail:
        'The index version is read per request and incremented when the catalog is republished (`INCR catalog:index_version`), so a price change appears within one TTL instead of being masked by an old key. The draft has no version at all.',
      match: {
        python: {all: [/index_version/, /\.incr\(/]},
        typescript: {all: [/indexVersion/, /\.incr\(/]},
        go: {all: [/indexVersion/, /\.Incr\(/]},
        scala: {all: [/indexVersion/, /\.incr\(/]},
        cpp: {all: [/index_version/, /\.incr\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis

logger = logging.getLogger("search-cache")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def search_cached(tenant: str, q: str, filters: dict, page: int, run_search):
    # TODO: this draft keys by the raw query string alone and expires nothing, so a cached
    # unfiltered result set is served to a filtered request and one tenant's results to another,
    # and a catalog update is never reflected. Review all three.
    key = f"search:{q}"
    hit = r.get(key)
    if hit is not None:
        logger.info("cache hit tenant=%s q=%r", tenant, q)
        return json.loads(hit)
    results = run_search(q, filters, page)
    r.set(key, json.dumps(results))
    return results
`,
      solution: `import hashlib
import json
import logging

import redis

logger = logging.getLogger("search-cache")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 60


def normalize_query(q: str) -> str:
    return " ".join(q.strip().lower().split())


def filter_hash(filters: dict) -> str:
    canonical = json.dumps(filters, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def current_index_version() -> str:
    return r.get("catalog:index_version") or "0"


def cache_key(tenant: str, q: str, filters: dict, page: int, index_version: str) -> str:
    query_hash = hashlib.sha256(normalize_query(q).encode("utf-8")).hexdigest()[:16]
    return f"search:{tenant}:{index_version}:{page}:{filter_hash(filters)}:{query_hash}"


def bump_index_version() -> None:
    """A catalog publish rotates the key namespace, so no request waits out the TTL."""
    r.incr("catalog:index_version")


def search_cached(tenant: str, q: str, filters: dict, page: int, run_search):
    key = cache_key(tenant, q, filters, page, current_index_version())
    hit = r.get(key)
    if hit is not None:
        logger.info("cache hit tenant=%s page=%d", tenant, page)
        return json.loads(hit)
    results = run_search(q, filters, page)
    r.setex(key, CACHE_TTL_S, json.dumps(results))
    return results
`,
    },
    typescript: {
      starter: `/** Query cache: a model-generated draft keyed by the raw query string. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

export async function searchCached(
  tenant: string,
  q: string,
  filters: Record<string, unknown>,
  page: number,
  runSearch: (q: string, filters: Record<string, unknown>, page: number) => Promise<unknown[]>,
): Promise<unknown[]> {
  // TODO: this draft keys by the raw query string alone and expires nothing, so a cached
  // unfiltered result set is served to a filtered request and one tenant's results to another,
  // and a catalog update is never reflected. Review all three.
  void createHash;
  const key = \`search:\${q}\`;
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as unknown[];
  const results = await runSearch(q, filters, page);
  await redis.set(key, JSON.stringify(results));
  return results;
}
`,
      solution: `/** Query cache: keyed by the whole query, expiring, and rotated by the index version. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

const CACHE_TTL_S = 60;

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().split(/\\s+/).join(' ');
}

function filterHash(filters: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(filters)
      .sort()
      .map(field => [field, filters[field]]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

async function currentIndexVersion(): Promise<string> {
  return (await redis.get('catalog:index_version')) ?? '0';
}

export function cacheKey(
  tenant: string,
  q: string,
  filters: Record<string, unknown>,
  page: number,
  indexVersion: string,
): string {
  const queryHash = createHash('sha256').update(normalizeQuery(q)).digest('hex').slice(0, 16);
  return \`search:\${tenant}:\${indexVersion}:\${page}:\${filterHash(filters)}:\${queryHash}\`;
}

export async function bumpIndexVersion(): Promise<void> {
  await redis.incr('catalog:index_version');
}

export async function searchCached(
  tenant: string,
  q: string,
  filters: Record<string, unknown>,
  page: number,
  runSearch: (q: string, filters: Record<string, unknown>, page: number) => Promise<unknown[]>,
): Promise<unknown[]> {
  const key = cacheKey(tenant, q, filters, page, await currentIndexVersion());
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as unknown[];
  const results = await runSearch(q, filters, page);
  await redis.set(key, JSON.stringify(results), 'EX', CACHE_TTL_S);
  return results;
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

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func searchCached(ctx context.Context, tenant, q string, filters map[string]any, page int, runSearch func() any) (any, error) {
	// TODO: this draft keys by the raw query string alone and expires nothing, so a cached
	// unfiltered result set is served to a filtered request and one tenant's results to another,
	// and a catalog update is never reflected. Review all three.
	key := fmt.Sprintf("search:%s", q)
	hit, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var results any
		json.Unmarshal([]byte(hit), &results)
		return results, nil
	}
	results := runSearch()
	payload, _ := json.Marshal(results)
	rdb.Set(ctx, key, payload, 0)
	return results, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTTLSeconds = 60

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func normalizeQuery(q string) string {
	return strings.ToLower(strings.TrimSpace(q))
}

func filterHash(filters map[string]any) string {
	fields := make([]string, 0, len(filters))
	for field := range filters {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	canonical, _ := json.Marshal(fields)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])[:16]
}

func currentIndexVersion(ctx context.Context) string {
	version, err := rdb.Get(ctx, "catalog:index_version").Result()
	if err != nil {
		return "0"
	}
	return version
}

func cacheKey(tenant, q string, filters map[string]any, page int, indexVersion string) string {
	sum := sha256.Sum256([]byte(normalizeQuery(q)))
	return fmt.Sprintf("search:%s:%s:%d:%s:%s", tenant, indexVersion, page, filterHash(filters), hex.EncodeToString(sum[:])[:16])
}

func bumpIndexVersion(ctx context.Context) error {
	return rdb.Incr(ctx, "catalog:index_version").Err()
}

func searchCached(ctx context.Context, tenant, q string, filters map[string]any, page int, runSearch func() any) (any, error) {
	key := cacheKey(tenant, q, filters, page, currentIndexVersion(ctx))
	hit, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var results any
		json.Unmarshal([]byte(hit), &results)
		return results, nil
	}
	results := runSearch()
	payload, _ := json.Marshal(results)
	rdb.SetEx(ctx, key, payload, time.Duration(cacheTTLSeconds)*time.Second)
	return results, nil
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

object QueryCache {
  val jedis = new Jedis("redis", 6379)

  def searchCached(tenant: String, q: String, filters: Map[String, String], page: Int)(runSearch: () => String): String = {
    // TODO: this draft keys by the raw query string alone and expires nothing, so a cached
    // unfiltered result set is served to a filtered request and one tenant's results to another,
    // and a catalog update is never reflected. Review all three.
    val key = s"search:$q"
    Option(jedis.get(key)) match {
      case Some(hit) => hit
      case None =>
        val results = runSearch()
        jedis.set(key, results)
        results
    }
  }
}
`,
      solution: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

object QueryCache {
  val CacheTtlSeconds = 60
  val jedis = new Jedis("redis", 6379)

  def normalizeQuery(q: String): String = q.trim.toLowerCase

  def filterHash(filters: Map[String, String]): String = {
    val canonical = filters.toList.sortBy(_._1).map { case (field, value) => s"$field=$value" }.mkString("&")
    val digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes("UTF-8"))
    digest.take(8).map("%02x".format(_)).mkString
  }

  def currentIndexVersion: String = Option(jedis.get("catalog:index_version")).getOrElse("0")

  def cacheKey(tenant: String, q: String, filters: Map[String, String], page: Int, indexVersion: String): String = {
    val queryHash = MessageDigest.getInstance("SHA-256").digest(normalizeQuery(q).getBytes("UTF-8"))
    val queryHex = queryHash.take(8).map("%02x".format(_)).mkString
    s"search:$tenant:$indexVersion:$page:\${filterHash(filters)}:$queryHex"
  }

  def bumpIndexVersion(): Unit = jedis.incr("catalog:index_version")

  def searchCached(tenant: String, q: String, filters: Map[String, String], page: Int)(runSearch: () => String): String = {
    val key = cacheKey(tenant, q, filters, page, currentIndexVersion)
    Option(jedis.get(key)) match {
      case Some(hit) => hit
      case None =>
        val results = runSearch()
        jedis.setex(key, CacheTtlSeconds, results)
        results
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

using sw::redis::Redis;

Redis redis("tcp://redis:6379");

std::string searchCached(const std::string& tenant, const std::string& q, const std::string& filters, int page) {
  // TODO: this draft keys by the raw query string alone and expires nothing, so a cached
  // unfiltered result set is served to a filtered request and one tenant's results to another,
  // and a catalog update is never reflected. Review all three.
  const std::string key = "search:" + q;
  if (const auto hit = redis.get(key)) return *hit;
  const std::string results = "[]";
  redis.set(key, results);
  return results;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

using json = nlohmann::json;
using sw::redis::Redis;

constexpr int kCacheTtlSeconds = 60;
Redis redis("tcp://redis:6379");

std::string normalize_query(const std::string& q) {
  std::string out;
  bool pending = false;
  for (unsigned char c : q) {
    if (std::isspace(c)) {
      pending = !out.empty();
      continue;
    }
    if (pending) out += ' ';
    pending = false;
    out += static_cast<char>(std::tolower(c));
  }
  return out;
}

std::string filter_hash(const json& filters) {
  json canonical = json::object();
  for (const auto& [field, value] : filters.items()) canonical[field] = value;
  const std::string text = canonical.dump();
  std::uint64_t fnv1a = 1469598103934665603ull;
  for (unsigned char c : text) {
    fnv1a ^= c;
    fnv1a *= 1099511628211ull;
  }
  return std::to_string(fnv1a);
}

std::string index_version() {
  if (const auto version = redis.get("catalog:index_version")) return *version;
  return "0";
}

std::string cache_key(const std::string& tenant, const std::string& q, const json& filters, int page,
                      const std::string& version) {
  return "search:" + tenant + ":" + version + ":" + std::to_string(page) + ":" + filter_hash(filters) + ":" +
         normalize_query(q);
}

void bump_index_version() { redis.incr("catalog:index_version"); }

std::string search_cached(const std::string& tenant, const std::string& q, const json& filters, int page) {
  const std::string key = cache_key(tenant, q, filters, page, index_version());
  if (const auto hit = redis.get(key)) return *hit;
  const std::string results = "[]";
  redis.set(key, results, std::chrono::seconds(kCacheTtlSeconds));
  return results;
}
`,
    },
  },
  hints: [
    'Write the key function first and list its inputs out loud: tenant, normalized query, filter hash, page, index version. Every one of them is something a hit must be conditioned on; anything omitted from the key is a wrong answer waiting for the second caller.',
    'Normalization and a canonical filter hash are the same idea twice: reduce inputs that mean the same thing to one string. `json.dumps(filters, sort_keys=True)` / sorted entries before the digest is what stops `{brand,category}` and `{category,brand}` from being two entries.',
    'The index version is the eviction signal you control: read `catalog:index_version` on every request and `INCR` it from the catalog publisher. The TTL is the backstop for everything else — without it, the first value lives until a deploy.',
  ],
  debrief: `The interviewer is asking whether you know what a cache key is for. The draft looks like a cache and behaves like a sticky note: one entry per query string, shared across tenants, blind to filters, and immortal. Each omission is a distinct bug — a filtered request served an unfiltered page, a cross-tenant read, and a price that never updates. The fix names every input, reduces equivalent inputs to one canonical form, and sets a TTL as the backstop. The index version is the interesting part: it lets a catalog publish invalidate the whole namespace atomically (\`INCR\`) without scanning keys or waiting out 60 seconds, which is why real systems keep a version in the key rather than deleting entries one by one.`,
};
