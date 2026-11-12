import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A query cache whose key names every input',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'cache',
  focus: ['api', 'cache', 'catalog'],
  task: `## Task

**Starting point.** The starter is the query cache \`GET /v1/search\` calls instead of the engine:
\`cached_search(tenant, q, filters, page_size)\` has \`run_query\`'s signature, looks the page up
under \`search:{q}\`, and on a miss runs \`run_query\` and stores the page as JSON with a plain
\`SET\`. Repeated searches come back fast, and it hides four flaws.

**Failure mode the checks target.** Two tenants, two filter sets or two page sizes with the same
\`q\` share one entry; \`Kettle\` and \` kettle \` fill two entries; nothing expires; and a product
indexed after the first search stays invisible to that query.

- The key is \`search:{tenant}:{index version}:{digest}\`. The \`digest\` covers the normalized
  query (\`normalize_query\`), the filters as \`field=value\` pairs sorted by field and joined by
  \`&\`, and the page size, joined by newlines.
- The index version is read on every call (\`index_version(tenant)\`): \`put_product\` bumps it, so
  the next search misses instead of serving the old page for a minute.
- An entry lives \`CACHE_TTL_S\` = 60 seconds (\`SET … EX\`).`,
  sequence: {
    participants: ['searchd', 'Redis', 'Catalog index'],
    messages: [
      {from: 'searchd', to: 'Catalog index', label: 'index_version(tenant) → 7', kind: 'sync'},
      {from: 'searchd', to: 'Redis', label: 'GET search:t-1:7:{digest(q, filters, page_size)}', kind: 'sync'},
      {from: 'Redis', to: 'searchd', label: 'hit → page · miss → nil', kind: 'reply'},
      {from: 'searchd', to: 'Catalog index', label: 'run_query(tenant, q, filters, page_size) on a miss', kind: 'sync'},
      {from: 'searchd', to: 'Redis', label: 'SET key page EX 60', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'key-inputs',
      title: 'The key names the tenant, the filters and the page size',
      detail:
        'The key starts `search:{tenant}:` and its digest covers the filters, sorted by field, and the page size; the starter keys by `q` alone, so another tenant or another filter set gets the first caller’s page.',
      match: {
        python: {all: [/search:\{tenant\}:/, /sorted\(\s*filters/], none: [/f["']search:\{q\}["']/]},
        typescript: {
          all: [/search:\$\{tenant\}:/, /Object\.(keys|entries)\(\s*filters\s*\)\s*\.sort\(/],
          none: [/`search:\$\{q\}`/],
        },
        go: {all: [/"search:"\s*\+\s*tenant|"search:%s:/, /sort\.Strings\(/], none: [/"search:"\s*\+\s*q\b/]},
        scala: {all: [/s"search:\$tenant:/, /\.toSeq\.sorted|\.sortBy\(|SortedMap/], none: [/s"search:\$q"/]},
        cpp: {
          all: [/"search:"\s*\+\s*tenant/, /for \(const auto& \[\w+, \w+\] : filters\)/],
          none: [/"search:"\s*\+\s*q\b/],
        },
      },
    },
    {
      id: 'normalized-key',
      title: 'Two spellings of one search share one entry',
      detail:
        'The digest is taken over `normalize_query(q)` (lowercase, trimmed, single spaces), so `Steel Kettle` and ` steel  KETTLE ` with the same filters in another order are one entry.',
      match: {
        python: {all: [/normalize_query\(/, /digest\(/]},
        typescript: {all: [/normalizeQuery\(/, /digest\(/]},
        go: {all: [/catalog\.NormalizeQuery\(/, /catalog\.Digest\(/]},
        scala: {all: [/Catalog\.normalizeQuery\(/, /Catalog\.digest\(/]},
        cpp: {all: [/catalog::normalizeQuery\(/, /catalog::digest\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire after 60 seconds',
      detail:
        'Every entry is written with `CACHE_TTL_S` = 60 (`SET … EX`, `setex`); the starter’s plain `SET` keeps a page forever.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*60\b/, /ex\s*=\s*CACHE_TTL_S|setex\([^\n]*CACHE_TTL_S/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*60\b/, /'EX',\s*CACHE_TTL_S|setex\([^\n]*CACHE_TTL_S/]},
        go: {all: [/cacheTTL\s*=\s*60\s*\*\s*time\.Second/, /\.Set\([^\n]*cacheTTL\)|\.SetEx\([^\n]*cacheTTL/]},
        scala: {all: [/CacheTtlSeconds\s*=\s*60\b/, /setex\([^\n]*CacheTtlSeconds/]},
        cpp: {all: [/kCacheTtlSeconds\s*=\s*60\b/, /setex\([^\n]*kCacheTtlSeconds/]},
      },
    },
    {
      id: 'index-version',
      title: 'A catalog write makes the next search miss',
      detail:
        'The key carries `index_version(tenant)`, read on every call; `put_product` bumps it, so a newly indexed product shows up on the next search rather than after the TTL.',
      match: {
        python: {all: [/catalog\.index_version\(\s*tenant\s*\)/]},
        typescript: {all: [/indexVersion\(\s*tenant\s*\)/]},
        go: {all: [/catalog\.IndexVersion\(\s*ctx,\s*tenant\s*\)/]},
        scala: {all: [/Catalog\.indexVersion\(\s*tenant\s*\)/]},
        cpp: {all: [/catalog::indexVersion\(\s*tenant\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from search import catalog  # run_query, index_version, normalize_query, digest

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def cached_search(tenant: str, q: str, filters: dict[str, str], page_size: int) -> list[dict]:
    """run_query through the query cache: a hit answers from Redis, a miss runs the engine and stores the page."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"search:{q}"
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)
    results = catalog.run_query(tenant, q, filters, page_size)
    r.set(key, json.dumps(results))
    return results
`,
      solution: `import json

import redis

from search import catalog  # run_query, index_version, normalize_query, digest

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 60


def cache_key(tenant: str, q: str, filters: dict[str, str], page_size: int) -> str:
    """Every input that changes the page: tenant, index version, normalized query, filters in field order, page size."""
    pairs = "&".join(f"{field}={filters[field]}" for field in sorted(filters))
    canonical = "\\n".join([catalog.normalize_query(q), pairs, str(page_size)])
    return f"search:{tenant}:{catalog.index_version(tenant)}:{catalog.digest(canonical)}"


def cached_search(tenant: str, q: str, filters: dict[str, str], page_size: int) -> list[dict]:
    """run_query through the query cache: a hit answers from Redis, a miss runs the engine and stores the page."""
    key = cache_key(tenant, q, filters, page_size)
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)
    results = catalog.run_query(tenant, q, filters, page_size)
    r.set(key, json.dumps(results), ex=CACHE_TTL_S)
    return results
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Hit, digest, indexVersion, normalizeQuery, runQuery} from 'search/catalog';

const redis = new Redis({host: 'redis', port: 6379});

/** runQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page. */
export async function cachedSearch(tenant: string, q: string, filters: Record<string, string>, pageSize: number): Promise<Hit[]> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`search:\${q}\`;
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as Hit[];
  const results = await runQuery(tenant, q, filters, pageSize);
  await redis.set(key, JSON.stringify(results));
  return results;
}
`,
      solution: `import Redis from 'ioredis';

import {type Hit, digest, indexVersion, normalizeQuery, runQuery} from 'search/catalog';

const redis = new Redis({host: 'redis', port: 6379});

const CACHE_TTL_S = 60;

/** Every input that changes the page: tenant, index version, normalized query, filters in field order, page size. */
async function cacheKey(tenant: string, q: string, filters: Record<string, string>, pageSize: number): Promise<string> {
  const pairs = Object.keys(filters)
    .sort()
    .map(field => \`\${field}=\${filters[field]}\`)
    .join('&');
  const canonical = [normalizeQuery(q), pairs, String(pageSize)].join('\\n');
  return \`search:\${tenant}:\${await indexVersion(tenant)}:\${digest(canonical)}\`;
}

/** runQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page. */
export async function cachedSearch(tenant: string, q: string, filters: Record<string, string>, pageSize: number): Promise<Hit[]> {
  const key = await cacheKey(tenant, q, filters, pageSize);
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as Hit[];
  const results = await runQuery(tenant, q, filters, pageSize);
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

	"github.com/redis/go-redis/v9"

	"search/catalog" // RunQuery, IndexVersion, NormalizeQuery, Digest, Hit
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// cachedSearch is RunQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page.
func cachedSearch(ctx context.Context, tenant, q string, filters map[string]string, pageSize int) ([]catalog.Hit, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "search:" + q
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var hits []catalog.Hit
		if json.Unmarshal([]byte(raw), &hits) == nil {
			return hits, nil
		}
	} else if err != redis.Nil {
		return nil, err
	}
	hits := catalog.RunQuery(ctx, tenant, q, filters, pageSize)
	page, _ := json.Marshal(hits)
	if err := rdb.Set(ctx, key, page, 0).Err(); err != nil {
		return nil, err
	}
	return hits, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"search/catalog" // RunQuery, IndexVersion, NormalizeQuery, Digest, Hit
)

const cacheTTL = 60 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// cacheKey names every input that changes the page: tenant, index version, normalized query, filters in field order, page size.
func cacheKey(ctx context.Context, tenant, q string, filters map[string]string, pageSize int) string {
	fields := make([]string, 0, len(filters))
	for field := range filters {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	pairs := make([]string, 0, len(fields))
	for _, field := range fields {
		pairs = append(pairs, field+"="+filters[field])
	}
	canonical := strings.Join([]string{catalog.NormalizeQuery(q), strings.Join(pairs, "&"), fmt.Sprint(pageSize)}, "\\n")
	return fmt.Sprintf("search:%s:%d:%s", tenant, catalog.IndexVersion(ctx, tenant), catalog.Digest(canonical))
}

// cachedSearch is RunQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page.
func cachedSearch(ctx context.Context, tenant, q string, filters map[string]string, pageSize int) ([]catalog.Hit, error) {
	key := cacheKey(ctx, tenant, q, filters, pageSize)
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var hits []catalog.Hit
		if json.Unmarshal([]byte(raw), &hits) == nil {
			return hits, nil
		}
	} else if err != redis.Nil {
		return nil, err
	}
	hits := catalog.RunQuery(ctx, tenant, q, filters, pageSize)
	page, _ := json.Marshal(hits)
	if err := rdb.Set(ctx, key, page, cacheTTL).Err(); err != nil {
		return nil, err
	}
	return hits, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import search.Catalog // runQuery, indexVersion, normalizeQuery, digest

object QueryCache {
  val jedis = new JedisPooled("redis", 6379)

  /** runQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page. */
  def cachedSearch(tenant: String, q: String, filters: Map[String, String], pageSize: Int): Seq[JsObject] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"search:$q"
    Option(jedis.get(key)) match {
      case Some(hit) => hit.parseJson.asInstanceOf[JsArray].elements.map(_.asJsObject)
      case None =>
        val results = Catalog.runQuery(tenant, q, filters, pageSize)
        jedis.set(key, JsArray(results.toVector).compactPrint)
        results
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import search.Catalog // runQuery, indexVersion, normalizeQuery, digest

object QueryCache {
  val jedis = new JedisPooled("redis", 6379)

  val CacheTtlSeconds = 60

  /** Every input that changes the page: tenant, index version, normalized query, filters in field order, page size. */
  def cacheKey(tenant: String, q: String, filters: Map[String, String], pageSize: Int): String = {
    val pairs = filters.toSeq.sorted.map { case (field, value) => s"$field=$value" }.mkString("&")
    val canonical = Seq(Catalog.normalizeQuery(q), pairs, pageSize.toString).mkString("\\n")
    s"search:$tenant:\${Catalog.indexVersion(tenant)}:\${Catalog.digest(canonical)}"
  }

  /** runQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page. */
  def cachedSearch(tenant: String, q: String, filters: Map[String, String], pageSize: Int): Seq[JsObject] = {
    val key = cacheKey(tenant, q, filters, pageSize)
    Option(jedis.get(key)) match {
      case Some(hit) => hit.parseJson.asInstanceOf[JsArray].elements.map(_.asJsObject)
      case None =>
        val results = Catalog.runQuery(tenant, q, filters, pageSize)
        jedis.setex(key, CacheTtlSeconds.toLong, JsArray(results.toVector).compactPrint)
        results
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "search/catalog.h"  // catalog::runQuery, indexVersion, normalizeQuery, digest

using json = nlohmann::json;

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// runQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page.
json cachedSearch(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters, int page_size) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "search:" + q;
  if (const auto hit = redis().get(key)) return json::parse(*hit);
  const json results = catalog::runQuery(tenant, q, filters, page_size);
  redis().set(key, results.dump());
  return results;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "search/catalog.h"  // catalog::runQuery, indexVersion, normalizeQuery, digest

using json = nlohmann::json;

const long kCacheTtlSeconds = 60;

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Every input that changes the page: tenant, index version, normalized query, filters in field order
// (a std::map iterates sorted), page size.
std::string cacheKey(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters, int page_size) {
  std::string pairs;
  for (const auto& [field, value] : filters) pairs += (pairs.empty() ? "" : "&") + field + "=" + value;
  const std::string canonical = catalog::normalizeQuery(q) + "\\n" + pairs + "\\n" + std::to_string(page_size);
  return "search:" + tenant + ":" + std::to_string(catalog::indexVersion(tenant)) + ":" + catalog::digest(canonical);
}

// runQuery through the query cache: a hit answers from Redis, a miss runs the engine and stores the page.
json cachedSearch(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters, int page_size) {
  const std::string key = cacheKey(tenant, q, filters, page_size);
  if (const auto hit = redis().get(key)) return json::parse(*hit);
  const json results = catalog::runQuery(tenant, q, filters, page_size);
  redis().setex(key, kCacheTtlSeconds, results.dump());
  return results;
}
`,
    },
  },
  harness: {
    python: `from search import catalog

KETTLES = [
    {"id": "p-1", "title": "Steel Kettle", "brand": "acme", "category": "kitchen", "price_cents": 3499, "in_stock": True, "cost_cents": 1200},
    {"id": "p-2", "title": "Glass Kettle", "brand": "brew", "category": "kitchen", "price_cents": 2999, "in_stock": True, "cost_cents": 900},
]
COPPER = {"id": "p-9", "title": "Copper Kettle", "brand": "acme", "category": "kitchen", "price_cents": 5999, "in_stock": True, "cost_cents": 3000}
TRAVEL = {"id": "p-4", "title": "Travel Kettle", "brand": "acme", "category": "kitchen", "price_cents": 1999, "in_stock": True, "cost_cents": 700}


def _cache(ctx):
    for product in KETTLES:
        catalog.put_product("t-1", product)
    catalog.put_product("t-2", COPPER)
    return ctx.load("cache")


def _ids(page):
    return [hit["id"] for hit in page]


def check_key_inputs(ctx):
    m = _cache(ctx)
    assert _ids(m.cached_search("t-1", "kettle", {}, 10)) == ["p-2", "p-1"], "t-1's search for kettle must answer its two kettles"
    other = _ids(m.cached_search("t-2", "kettle", {}, 10))
    assert other == ["p-9"], f"tenant t-2 searching kettle got {other}, expected its own [p-9]: the cache served t-1's page to another tenant"
    acme = _ids(m.cached_search("t-1", "kettle", {"brand": "acme"}, 10))
    assert acme == ["p-1"], f"t-1 searching kettle with brand=acme got {acme}, expected [p-1]: the cache answered the unfiltered page"
    one = _ids(m.cached_search("t-1", "kettle", {}, 1))
    assert one == ["p-2"], f"t-1 searching kettle with page_size 1 got {one}, expected [p-2]: the cache answered a page of another size"
    keys = sorted(ctx.redis.keys("search:*"))
    assert all(k.startswith("search:t-1:") or k.startswith("search:t-2:") for k in keys), f"the cache keys are {keys}: each must start search:{{tenant}}:"


def check_normalized_key(ctx):
    m = _cache(ctx)
    first = m.cached_search("t-1", "Steel Kettle", {"brand": "acme", "in_stock": "true"}, 10)
    second = m.cached_search("t-1", "  steel   KETTLE ", {"in_stock": "true", "brand": "acme"}, 10)
    assert _ids(first) == _ids(second) == ["p-1"], f"the two spellings answered {_ids(first)} and {_ids(second)}, expected [p-1] for both"
    keys = ctx.redis.keys("search:*")
    assert len(keys) == 1, f"one search spelled two ways, filters in two orders, left {len(keys)} cache entries {sorted(keys)}: digest the normalized query and the filters sorted by field"


def check_ttl(ctx):
    m = _cache(ctx)
    m.cached_search("t-1", "kettle", {}, 10)
    keys = ctx.redis.keys("search:*")
    assert len(keys) == 1, f"one search left {len(keys)} cache entries {sorted(keys)}, expected 1"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 60, f"the cache entry {keys[0]} has TTL {ttl}: {'it never expires' if ttl == -1 else 'expected at most 60 s'}. Write it with CACHE_TTL_S = 60"


def check_index_version(ctx):
    m = _cache(ctx)
    assert _ids(m.cached_search("t-1", "kettle", {}, 10)) == ["p-2", "p-1"], "t-1's first search for kettle must answer its two kettles"
    assert _ids(m.cached_search("t-1", "kettle", {}, 10)) == ["p-2", "p-1"], "the repeated search must answer the same page"
    catalog.put_product("t-1", TRAVEL)
    after = _ids(m.cached_search("t-1", "kettle", {}, 10))
    assert after == ["p-4", "p-2", "p-1"], f"after put_product indexed p-4 the search answered {after}, expected [p-4, p-2, p-1]: the key must carry index_version(tenant), read on every call"
`,
    typescript: `const KETTLES = [
  {id: 'p-1', title: 'Steel Kettle', brand: 'acme', category: 'kitchen', price_cents: 3499, in_stock: true, cost_cents: 1200},
  {id: 'p-2', title: 'Glass Kettle', brand: 'brew', category: 'kitchen', price_cents: 2999, in_stock: true, cost_cents: 900},
];
const COPPER = {id: 'p-9', title: 'Copper Kettle', brand: 'acme', category: 'kitchen', price_cents: 5999, in_stock: true, cost_cents: 3000};
const TRAVEL = {id: 'p-4', title: 'Travel Kettle', brand: 'acme', category: 'kitchen', price_cents: 1999, in_stock: true, cost_cents: 700};

async function cache(ctx) {
  const catalog = ctx.load('/support/search/catalog.ts');
  for (const product of KETTLES) await catalog.putProduct('t-1', product);
  await catalog.putProduct('t-2', COPPER);
  return {m: ctx.load('cache'), catalog};
}

const ids = (page): string => JSON.stringify(page.map(hit => hit.id));

export async function check_key_inputs(ctx) {
  const {m} = await cache(ctx);
  assert.equal(ids(await m.cachedSearch('t-1', 'kettle', {}, 10)), '["p-2","p-1"]', "t-1's search for kettle must answer its two kettles");
  const other = ids(await m.cachedSearch('t-2', 'kettle', {}, 10));
  assert.equal(other, '["p-9"]', \`tenant t-2 searching kettle got \${other}, expected its own [p-9]: the cache served t-1's page to another tenant\`);
  const acme = ids(await m.cachedSearch('t-1', 'kettle', {brand: 'acme'}, 10));
  assert.equal(acme, '["p-1"]', \`t-1 searching kettle with brand=acme got \${acme}, expected [p-1]: the cache answered the unfiltered page\`);
  const one = ids(await m.cachedSearch('t-1', 'kettle', {}, 1));
  assert.equal(one, '["p-2"]', \`t-1 searching kettle with page_size 1 got \${one}, expected [p-2]: the cache answered a page of another size\`);
  const keys = ctx.redis.keys('search:*').sort();
  assert(keys.every(k => k.startsWith('search:t-1:') || k.startsWith('search:t-2:')), \`the cache keys are \${JSON.stringify(keys)}: each must start search:{tenant}:\`);
}

export async function check_normalized_key(ctx) {
  const {m} = await cache(ctx);
  const first = ids(await m.cachedSearch('t-1', 'Steel Kettle', {brand: 'acme', in_stock: 'true'}, 10));
  const second = ids(await m.cachedSearch('t-1', '  steel   KETTLE ', {in_stock: 'true', brand: 'acme'}, 10));
  assert(first === '["p-1"]' && second === '["p-1"]', \`the two spellings answered \${first} and \${second}, expected [p-1] for both\`);
  const keys = ctx.redis.keys('search:*');
  assert.equal(keys.length, 1, \`one search spelled two ways, filters in two orders, left \${keys.length} cache entries \${JSON.stringify(keys)}: digest the normalized query and the filters sorted by field\`);
}

export async function check_ttl(ctx) {
  const {m} = await cache(ctx);
  await m.cachedSearch('t-1', 'kettle', {}, 10);
  const keys = ctx.redis.keys('search:*');
  assert.equal(keys.length, 1, \`one search left \${keys.length} cache entries \${JSON.stringify(keys)}, expected 1\`);
  const ttl = Number(ctx.redis.ttl(keys[0]));
  assert(ttl > 0 && ttl <= 60, \`the cache entry \${keys[0]} has TTL \${ttl}: \${ttl === -1 ? 'it never expires' : 'expected at most 60 s'}. Write it with CACHE_TTL_S = 60\`);
}

export async function check_index_version(ctx) {
  const {m, catalog} = await cache(ctx);
  assert.equal(ids(await m.cachedSearch('t-1', 'kettle', {}, 10)), '["p-2","p-1"]', "t-1's first search for kettle must answer its two kettles");
  assert.equal(ids(await m.cachedSearch('t-1', 'kettle', {}, 10)), '["p-2","p-1"]', 'the repeated search must answer the same page');
  await catalog.putProduct('t-1', TRAVEL);
  const after = ids(await m.cachedSearch('t-1', 'kettle', {}, 10));
  assert.equal(after, '["p-4","p-2","p-1"]', \`after putProduct indexed p-4 the search answered \${after}, expected [p-4, p-2, p-1]: the key must carry indexVersion(tenant), read on every call\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"search/catalog"

	"leetbuild/harness"
)

var (
	cacheBg      = context.Background()
	cacheKettles = []catalog.Product{
		{ID: "p-1", Title: "Steel Kettle", Brand: "acme", Category: "kitchen", PriceCents: 3499, InStock: true, CostCents: 1200},
		{ID: "p-2", Title: "Glass Kettle", Brand: "brew", Category: "kitchen", PriceCents: 2999, InStock: true, CostCents: 900},
	}
	cacheCopper = catalog.Product{ID: "p-9", Title: "Copper Kettle", Brand: "acme", Category: "kitchen", PriceCents: 5999, InStock: true, CostCents: 3000}
	cacheTravel = catalog.Product{ID: "p-4", Title: "Travel Kettle", Brand: "acme", Category: "kitchen", PriceCents: 1999, InStock: true, CostCents: 700}
)

func seedCache() {
	for _, p := range cacheKettles {
		catalog.PutProduct(cacheBg, "t-1", p)
	}
	catalog.PutProduct(cacheBg, "t-2", cacheCopper)
}

func page(ctx *harness.Ctx, tenant, q string, filters map[string]string, pageSize int) string {
	hits, err := cachedSearch(cacheBg, tenant, q, filters, pageSize)
	ctx.NoError(err, "cachedSearch(%s, %q) failed", tenant, q)
	ids := []string{}
	for _, h := range hits {
		ids = append(ids, h.ID)
	}
	return strings.Join(ids, ",")
}

func CheckKeyInputs(ctx *harness.Ctx) {
	seedCache()
	ctx.Equal(page(ctx, "t-1", "kettle", nil, 10), "p-2,p-1", "t-1's search for kettle")
	ctx.Equal(page(ctx, "t-2", "kettle", nil, 10), "p-9", "tenant t-2 searching kettle must get its own page, not t-1's")
	ctx.Equal(page(ctx, "t-1", "kettle", map[string]string{"brand": "acme"}, 10), "p-1", "t-1 searching kettle with brand=acme must not get the unfiltered page")
	ctx.Equal(page(ctx, "t-1", "kettle", nil, 1), "p-2", "t-1 searching kettle with page size 1 must not get a page of another size")
	for _, k := range ctx.Redis.Keys("search:*") {
		ctx.Assert(strings.HasPrefix(k, "search:t-1:") || strings.HasPrefix(k, "search:t-2:"), "the cache key %q must start search:{tenant}:", k)
	}
}

func CheckNormalizedKey(ctx *harness.Ctx) {
	seedCache()
	first := page(ctx, "t-1", "Steel Kettle", map[string]string{"brand": "acme", "in_stock": "true"}, 10)
	second := page(ctx, "t-1", "  steel   KETTLE ", map[string]string{"in_stock": "true", "brand": "acme"}, 10)
	ctx.Assert(first == "p-1" && second == "p-1", "the two spellings answered [%s] and [%s], expected [p-1] for both", first, second)
	keys := ctx.Redis.Keys("search:*")
	ctx.Equal(len(keys), 1, "one search spelled two ways must share one cache entry (digest the normalized query and the filters sorted by field); the entries %q", keys)
}

func CheckTtl(ctx *harness.Ctx) {
	seedCache()
	page(ctx, "t-1", "kettle", nil, 10)
	keys := ctx.Redis.Keys("search:*")
	ctx.Equal(len(keys), 1, "one search must leave one cache entry; the entries %q", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0 && ttl <= 60, "the cache entry %s has TTL %d (-1: it never expires): write it with cacheTTL = 60 s", keys[0], ttl)
}

func CheckIndexVersion(ctx *harness.Ctx) {
	seedCache()
	ctx.Equal(page(ctx, "t-1", "kettle", nil, 10), "p-2,p-1", "t-1's first search for kettle")
	ctx.Equal(page(ctx, "t-1", "kettle", nil, 10), "p-2,p-1", "the repeated search")
	catalog.PutProduct(cacheBg, "t-1", cacheTravel)
	ctx.Equal(page(ctx, "t-1", "kettle", nil, 10), "p-4,p-2,p-1", "after PutProduct indexed p-4 the next search must miss (the key carries catalog.IndexVersion, read on every call); the page")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "search/catalog.h"

namespace {

void seedCache() {
  catalog::putProduct("t-1", {"p-1", "Steel Kettle", "acme", "kitchen", 3499, true, 1200, 0});
  catalog::putProduct("t-1", {"p-2", "Glass Kettle", "brew", "kitchen", 2999, true, 900, 0});
  catalog::putProduct("t-2", {"p-9", "Copper Kettle", "acme", "kitchen", 5999, true, 3000, 0});
}

std::string page(const std::string& tenant, const std::string& q, const std::map<std::string, std::string>& filters, int page_size) {
  std::string ids;
  for (const auto& hit : cachedSearch(tenant, q, filters, page_size)) ids += (ids.empty() ? "" : ",") + hit.value("id", "");
  return ids;
}

}  // namespace

void CheckKeyInputs(harness::Ctx& ctx) {
  seedCache();
  ctx.Equal(page("t-1", "kettle", {}, 10), "p-2,p-1", "t-1's search for kettle");
  ctx.Equal(page("t-2", "kettle", {}, 10), "p-9", "tenant t-2 searching kettle must get its own page, not t-1's");
  ctx.Equal(page("t-1", "kettle", {{"brand", "acme"}}, 10), "p-1", "t-1 searching kettle with brand=acme must not get the unfiltered page");
  ctx.Equal(page("t-1", "kettle", {}, 1), "p-2", "t-1 searching kettle with page size 1 must not get a page of another size");
  for (const auto& k : ctx.Redis.Keys("search:*")) {
    ctx.Assert(k.rfind("search:t-1:", 0) == 0 || k.rfind("search:t-2:", 0) == 0, "the cache key %q must start search:{tenant}:", k);
  }
}

void CheckNormalizedKey(harness::Ctx& ctx) {
  seedCache();
  const std::string first = page("t-1", "Steel Kettle", {{"brand", "acme"}, {"in_stock", "true"}}, 10);
  const std::string second = page("t-1", "  steel   KETTLE ", {{"in_stock", "true"}, {"brand", "acme"}}, 10);
  ctx.Assert(first == "p-1" && second == "p-1", "the two spellings answered [%s] and [%s], expected [p-1] for both", first, second);
  const auto keys = ctx.Redis.Keys("search:*");
  ctx.Equal(keys.size(), 1, "one search spelled two ways must share one cache entry (digest the normalized query and the filters sorted by field); the entries %q", keys);
}

void CheckTtl(harness::Ctx& ctx) {
  seedCache();
  page("t-1", "kettle", {}, 10);
  const auto keys = ctx.Redis.Keys("search:*");
  ctx.Equal(keys.size(), 1, "one search must leave one cache entry; the entries %q", keys);
  const long long ttl = ctx.Redis.TTL(keys.front());
  ctx.Assert(ttl > 0 && ttl <= 60, "the cache entry %s has TTL %d (-1: it never expires): write it with kCacheTtlSeconds = 60", keys.front(), ttl);
}

void CheckIndexVersion(harness::Ctx& ctx) {
  seedCache();
  ctx.Equal(page("t-1", "kettle", {}, 10), "p-2,p-1", "t-1's first search for kettle");
  ctx.Equal(page("t-1", "kettle", {}, 10), "p-2,p-1", "the repeated search");
  catalog::putProduct("t-1", {"p-4", "Travel Kettle", "acme", "kitchen", 1999, true, 700, 0});
  ctx.Equal(page("t-1", "kettle", {}, 10), "p-4,p-2,p-1", "after putProduct indexed p-4 the next search must miss (the key carries catalog::indexVersion, read on every call); the page");
}
`,
  },
  hints: [
    'Search `kettle` as one tenant, then as another: the second tenant gets the first one’s products. Index a new kettle and search again: it stays missing, and the entry has no TTL.',
    'The key is `search:{q}`: it names the raw query and nothing else, so every other input and every spelling of the query picks its own or someone else’s entry, and a plain `SET` keeps it forever.',
    'Key `search:{tenant}:{index_version(tenant)}:{digest(normalize_query(q) \\n sorted field=value&… \\n page_size)}`, and write it with `SET key page EX 60`.',
  ],
  debrief: `A cache key is a claim that two requests have the same answer, so it has to name every input that changes the answer: the tenant, the normalized query, the filters in a canonical order, the page size, and the version of the data underneath. The index version turns invalidation into a lookup: a write bumps one counter, the next key differs, and the old entries are left to expire instead of being hunted down. The TTL bounds what the version cannot see, like an entry written by a request that read the version just before a write. Larger systems add request coalescing so a burst of identical misses runs the engine once, and cap the size of a cached page.`,
};
