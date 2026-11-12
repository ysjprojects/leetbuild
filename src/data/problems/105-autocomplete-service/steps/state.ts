import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis suggestion cache: per tenant, per catalog version, with a TTL and a cap',
  concept: 'redis',
  file: 'cache',
  focus: ['api', 'redis', 'terms'],
  task: `## Task

**Starting point.** The starter is the suggestion cache step 3 reads before it calls the suggester:
\`put_suggestions(tenant, prefix, suggestions)\` writes the list as JSON with
\`SET suggest:cache:{prefix}\`, and \`get_suggestions(tenant, prefix)\` reads it back (\`None\` on a
miss). It serves the demo and hides four flaws.

**Failure mode the checks target.** Two tenants typing \`ke\` share one tenant's completions; a
catalog change leaves retired terms in the dropdown; an entry written once is served forever; and a
bot walking prefixes grows one tenant's cache until Redis evicts everyone's.

- Key an entry \`suggest:cache:{tenant}:v{version}:{prefix}\`, the version from
  \`terms.catalog_version(tenant)\`, so a catalog change moves reads to a fresh key.
- Write it with a \`TTL_SECONDS\` = 300 expiry.
- Keep at most \`MAX_PREFIXES_PER_TENANT\` = 100 prefixes per tenant: score each prefix in
  \`suggest:recent:{tenant}\` by its last read or write (\`ZADD\`), and past the cap pop the coldest
  (\`ZPOPMIN\`) and delete its entry.`,
  sequence: {
    participants: ['suggestd', 'Redis'],
    messages: [
      {from: 'suggestd', to: 'Redis', label: 'GET suggest:cache:acme:v7:ke', kind: 'sync'},
      {from: 'Redis', to: 'suggestd', label: '["kettle", …] · ZADD suggest:recent:acme now ke', kind: 'reply'},
      {from: 'suggestd', to: 'Redis', label: 'SET suggest:cache:acme:v7:kett … EX 300', kind: 'sync'},
      {from: 'suggestd', to: 'Redis', label: 'ZADD suggest:recent:acme now kett · ZCARD', kind: 'sync'},
      {from: 'suggestd', to: 'Redis', label: '> 100: ZPOPMIN → DEL the coldest entry', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys every entry by tenant',
      detail:
        "The cache key starts `suggest:cache:{tenant}:`, so two tenants typing the same prefix read their own completions; a key of the prefix alone answers one tenant with another's terms.",
      match: {
        python: {all: [/suggest:cache:\{tenant\}/]},
        typescript: {all: [/suggest:cache:\$\{tenant\}/]},
        go: {all: [/"suggest:cache:%s[^"]*",\s*tenant\b|"suggest:cache:"\s*\+\s*tenant\b/]},
        scala: {all: [/s"suggest:cache:\$\{?tenant\b/]},
        cpp: {all: [/"suggest:cache:"\s*\+\s*tenant\b/]},
      },
    },
    {
      id: 'catalog-version',
      title: 'Puts the catalog version in the key',
      detail:
        'The key carries `v{terms.catalog_version(tenant)}`, so after a catalog change reads miss and refill instead of serving retired terms until they expire.',
      match: {
        python: {all: [/terms\.catalog_version\(\s*tenant/]},
        typescript: {all: [/catalogVersion\(\s*tenant/]},
        go: {all: [/terms\.CatalogVersion\(\s*ctx,\s*tenant/]},
        scala: {all: [/Terms\.catalogVersion\(\s*tenant/]},
        cpp: {all: [/terms::catalogVersion\(\s*tenant/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires every entry after 300 seconds',
      detail:
        'The entry is written with a `TTL_SECONDS` (300 s) expiry in the same `SET`; a plain `SET` keeps it forever.',
      match: {
        python: {all: [/TTL_SECONDS\s*=\s*300\b/, /ex\s*=\s*TTL_SECONDS|setex\(|\.expire\(/]},
        typescript: {all: [/TTL_SECONDS\s*=\s*300\b/, /['"]EX['"],\s*TTL_SECONDS|setex\(|\.expire\(/]},
        go: {all: [/ttl\s*=\s*300\s*\*\s*time\.Second/, /\.Set\([^\n]*,\s*ttl\)|\.SetEx\(|\.Expire\(/]},
        scala: {all: [/TtlSeconds\s*=\s*300L?\b/, /setex\(|\.expire\(|SetParams/]},
        cpp: {all: [/kTtlSeconds\s*=\s*300\b/, /\.set\([^\n]*kTtlSeconds|\.setex\(|\.expire\(/]},
      },
    },
    {
      id: 'coldest-cap',
      title: 'Caps each tenant at 100 prefixes, coldest out first',
      detail:
        'A read or a write scores the prefix in `suggest:recent:{tenant}`; past `MAX_PREFIXES_PER_TENANT` (100) the lowest score is popped and its entry deleted, so a flood of prefixes from one tenant stays bounded and evicts its own coldest prefix, not the one just read.',
      match: {
        python: {
          all: [
            /MAX_PREFIXES_PER_TENANT\s*=\s*100\b/,
            /zpopmin\(|zremrangebyrank\(/,
            /def get_suggestions(?:(?!\ndef )[\s\S])*?zadd\(/,
          ],
        },
        typescript: {
          all: [
            /MAX_PREFIXES_PER_TENANT\s*=\s*100\b/,
            /zpopmin\(|zremrangebyrank\(|['"]ZPOPMIN['"]/i,
            /function getSuggestions(?:(?!\nexport )[\s\S])*?zadd\(/,
          ],
        },
        go: {
          all: [
            /maxPrefixesPerTenant\s*=\s*100\b/,
            /ZPopMin\(|ZRemRangeByRank\(/,
            /func getSuggestions(?:(?!\n\})[\s\S])*?ZAdd\(/,
          ],
        },
        scala: {
          all: [
            /MaxPrefixesPerTenant\s*=\s*100L?\b/,
            /zpopmin\(|zremrangeByRank\(/,
            /def getSuggestions(?:(?!\n {2}def )[\s\S])*?zadd\(/,
          ],
        },
        cpp: {
          all: [
            /kMaxPrefixesPerTenant\s*=\s*100\b/,
            /zpopmin\(|zremrangebyrank\(/,
            /getSuggestions\((?:(?!\n\})[\s\S])*?zadd\(/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from suggest import terms  # catalog_version

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def cache_key(tenant: str, prefix: str) -> str:
    return f"suggest:cache:{prefix}"


def get_suggestions(tenant: str, prefix: str) -> list[str] | None:
    """The cached completions of the tenant's folded prefix, or None on a miss."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    raw = r.get(cache_key(tenant, prefix))
    return None if raw is None else json.loads(raw)


def put_suggestions(tenant: str, prefix: str, suggestions: list[str]) -> None:
    """Cache the completions of the tenant's folded prefix."""
    r.set(cache_key(tenant, prefix), json.dumps(suggestions))
`,
      solution: `import json
import time

import redis

from suggest import terms  # catalog_version

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_SECONDS = 300
MAX_PREFIXES_PER_TENANT = 100


def cache_key(tenant: str, prefix: str) -> str:
    # Tenant first, then the catalog version: a catalog change moves every read to a fresh key.
    return f"suggest:cache:{tenant}:v{terms.catalog_version(tenant)}:{prefix}"


def recent_key(tenant: str) -> str:
    return f"suggest:recent:{tenant}"


def get_suggestions(tenant: str, prefix: str) -> list[str] | None:
    """The cached completions of the tenant's folded prefix, or None on a miss."""
    raw = r.get(cache_key(tenant, prefix))
    if raw is None:
        return None
    r.zadd(recent_key(tenant), {prefix: time.time()})  # a hit warms the prefix
    return json.loads(raw)


def put_suggestions(tenant: str, prefix: str, suggestions: list[str]) -> None:
    """Cache the completions of the tenant's folded prefix."""
    r.set(cache_key(tenant, prefix), json.dumps(suggestions), ex=TTL_SECONDS)
    r.zadd(recent_key(tenant), {prefix: time.time()})
    # Over the cap, this tenant's coldest prefixes go first; other tenants are untouched.
    while r.zcard(recent_key(tenant)) > MAX_PREFIXES_PER_TENANT:
        for coldest, _ in r.zpopmin(recent_key(tenant)):
            r.delete(cache_key(tenant, coldest))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {catalogVersion} from 'suggest/terms';

const redis = new Redis({host: 'redis', port: 6379});

export const cacheKey = async (tenant: string, prefix: string): Promise<string> => \`suggest:cache:\${prefix}\`;

/** The cached completions of the tenant's folded prefix, or null on a miss. */
export async function getSuggestions(tenant: string, prefix: string): Promise<string[] | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const raw = await redis.get(await cacheKey(tenant, prefix));
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

/** Cache the completions of the tenant's folded prefix. */
export async function putSuggestions(tenant: string, prefix: string, suggestions: string[]): Promise<void> {
  await redis.set(await cacheKey(tenant, prefix), JSON.stringify(suggestions));
}
`,
      solution: `import Redis from 'ioredis';

import {catalogVersion} from 'suggest/terms';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_SECONDS = 300;
export const MAX_PREFIXES_PER_TENANT = 100;

// Tenant first, then the catalog version: a catalog change moves every read to a fresh key.
export const cacheKey = async (tenant: string, prefix: string): Promise<string> =>
  \`suggest:cache:\${tenant}:v\${await catalogVersion(tenant)}:\${prefix}\`;
export const recentKey = (tenant: string): string => \`suggest:recent:\${tenant}\`;

/** The cached completions of the tenant's folded prefix, or null on a miss. */
export async function getSuggestions(tenant: string, prefix: string): Promise<string[] | null> {
  const raw = await redis.get(await cacheKey(tenant, prefix));
  if (raw === null) return null;
  await redis.zadd(recentKey(tenant), Date.now(), prefix); // a hit warms the prefix
  return JSON.parse(raw) as string[];
}

/** Cache the completions of the tenant's folded prefix. */
export async function putSuggestions(tenant: string, prefix: string, suggestions: string[]): Promise<void> {
  await redis.set(await cacheKey(tenant, prefix), JSON.stringify(suggestions), 'EX', TTL_SECONDS);
  await redis.zadd(recentKey(tenant), Date.now(), prefix);
  // Over the cap, this tenant's coldest prefixes go first; other tenants are untouched.
  while ((await redis.zcard(recentKey(tenant))) > MAX_PREFIXES_PER_TENANT) {
    const [coldest] = (await redis.call('ZPOPMIN', recentKey(tenant))) as string[];
    await redis.del(await cacheKey(tenant, coldest));
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func cacheKey(ctx context.Context, tenant, prefix string) string {
	return "suggest:cache:" + prefix
}

// getSuggestions is the cached completions of the tenant's folded prefix, and whether there were any.
func getSuggestions(ctx context.Context, tenant, prefix string) ([]string, bool) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	raw, err := rdb.Get(ctx, cacheKey(ctx, tenant, prefix)).Result()
	if err != nil {
		return nil, false
	}
	var suggestions []string
	json.Unmarshal([]byte(raw), &suggestions)
	return suggestions, true
}

// putSuggestions caches the completions of the tenant's folded prefix.
func putSuggestions(ctx context.Context, tenant, prefix string, suggestions []string) {
	raw, _ := json.Marshal(suggestions)
	rdb.Set(ctx, cacheKey(ctx, tenant, prefix), raw, 0)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"suggest/terms" // terms.CatalogVersion
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl                  = 300 * time.Second
	maxPrefixesPerTenant = 100
)

// cacheKey puts the tenant first, then the catalog version: a catalog change moves every read to a fresh key.
func cacheKey(ctx context.Context, tenant, prefix string) string {
	return fmt.Sprintf("suggest:cache:%s:v%d:%s", tenant, terms.CatalogVersion(ctx, tenant), prefix)
}

func recentKey(tenant string) string { return "suggest:recent:" + tenant }

// getSuggestions is the cached completions of the tenant's folded prefix, and whether there were any.
func getSuggestions(ctx context.Context, tenant, prefix string) ([]string, bool) {
	raw, err := rdb.Get(ctx, cacheKey(ctx, tenant, prefix)).Result()
	if err != nil {
		return nil, false
	}
	rdb.ZAdd(ctx, recentKey(tenant), redis.Z{Score: float64(time.Now().UnixMilli()), Member: prefix}) // a hit warms the prefix
	var suggestions []string
	json.Unmarshal([]byte(raw), &suggestions)
	return suggestions, true
}

// putSuggestions caches the completions of the tenant's folded prefix.
func putSuggestions(ctx context.Context, tenant, prefix string, suggestions []string) {
	raw, _ := json.Marshal(suggestions)
	rdb.Set(ctx, cacheKey(ctx, tenant, prefix), raw, ttl)
	rdb.ZAdd(ctx, recentKey(tenant), redis.Z{Score: float64(time.Now().UnixMilli()), Member: prefix})
	// Over the cap, this tenant's coldest prefixes go first; other tenants are untouched.
	for rdb.ZCard(ctx, recentKey(tenant)).Val() > maxPrefixesPerTenant {
		for _, coldest := range rdb.ZPopMin(ctx, recentKey(tenant)).Val() {
			rdb.Del(ctx, cacheKey(ctx, tenant, coldest.Member.(string)))
		}
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import suggest.Terms // Terms.catalogVersion

object SuggestionCache {
  val jedis = new JedisPooled("redis", 6379)

  def cacheKey(tenant: String, prefix: String): String = s"suggest:cache:$prefix"

  /** The cached completions of the tenant's folded prefix, or None on a miss. */
  def getSuggestions(tenant: String, prefix: String): Option[Seq[String]] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Option(jedis.get(cacheKey(tenant, prefix))).map(_.parseJson.convertTo[Seq[String]])
  }

  /** Cache the completions of the tenant's folded prefix. */
  def putSuggestions(tenant: String, prefix: String, suggestions: Seq[String]): Unit =
    jedis.set(cacheKey(tenant, prefix), suggestions.toJson.compactPrint)
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import suggest.Terms // Terms.catalogVersion

object SuggestionCache {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 300L
  val MaxPrefixesPerTenant = 100L

  // Tenant first, then the catalog version: a catalog change moves every read to a fresh key.
  def cacheKey(tenant: String, prefix: String): String = s"suggest:cache:$tenant:v\${Terms.catalogVersion(tenant)}:$prefix"
  def recentKey(tenant: String): String = s"suggest:recent:$tenant"

  /** The cached completions of the tenant's folded prefix, or None on a miss. */
  def getSuggestions(tenant: String, prefix: String): Option[Seq[String]] =
    Option(jedis.get(cacheKey(tenant, prefix))).map { raw =>
      jedis.zadd(recentKey(tenant), System.currentTimeMillis().toDouble, prefix) // a hit warms the prefix
      raw.parseJson.convertTo[Seq[String]]
    }

  /** Cache the completions of the tenant's folded prefix. */
  def putSuggestions(tenant: String, prefix: String, suggestions: Seq[String]): Unit = {
    jedis.setex(cacheKey(tenant, prefix), TtlSeconds, suggestions.toJson.compactPrint)
    jedis.zadd(recentKey(tenant), System.currentTimeMillis().toDouble, prefix)
    // Over the cap, this tenant's coldest prefixes go first; other tenants are untouched.
    while (jedis.zcard(recentKey(tenant)) > MaxPrefixesPerTenant) {
      val coldest = jedis.zpopmin(recentKey(tenant))
      if (coldest != null) jedis.del(cacheKey(tenant, coldest.getElement))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

#include "suggest/terms.h"  // terms::catalogVersion

sw::redis::Redis redis("tcp://redis:6379");

std::string cacheKey(const std::string& tenant, const std::string& prefix) { return "suggest:cache:" + prefix; }

// The cached completions of the tenant's folded prefix, or none on a miss.
std::optional<std::vector<std::string>> getSuggestions(const std::string& tenant, const std::string& prefix) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto raw = redis.get(cacheKey(tenant, prefix));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<std::vector<std::string>>();
}

// Cache the completions of the tenant's folded prefix.
void putSuggestions(const std::string& tenant, const std::string& prefix, const std::vector<std::string>& suggestions) {
  redis.set(cacheKey(tenant, prefix), nlohmann::json(suggestions).dump());
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "suggest/terms.h"  // terms::catalogVersion

constexpr long long kTtlSeconds = 300;
constexpr long long kMaxPrefixesPerTenant = 100;

sw::redis::Redis redis("tcp://redis:6379");

// Tenant first, then the catalog version: a catalog change moves every read to a fresh key.
std::string cacheKey(const std::string& tenant, const std::string& prefix) {
  return "suggest:cache:" + tenant + ":v" + std::to_string(terms::catalogVersion(tenant)) + ":" + prefix;
}

std::string recentKey(const std::string& tenant) { return "suggest:recent:" + tenant; }

double lastUse() {
  return static_cast<double>(
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

// The cached completions of the tenant's folded prefix, or none on a miss.
std::optional<std::vector<std::string>> getSuggestions(const std::string& tenant, const std::string& prefix) {
  const auto raw = redis.get(cacheKey(tenant, prefix));
  if (!raw) return std::nullopt;
  redis.zadd(recentKey(tenant), prefix, lastUse());  // a hit warms the prefix
  return nlohmann::json::parse(*raw).get<std::vector<std::string>>();
}

// Cache the completions of the tenant's folded prefix.
void putSuggestions(const std::string& tenant, const std::string& prefix, const std::vector<std::string>& suggestions) {
  redis.set(cacheKey(tenant, prefix), nlohmann::json(suggestions).dump(), std::chrono::seconds(kTtlSeconds));
  redis.zadd(recentKey(tenant), prefix, lastUse());
  // Over the cap, this tenant's coldest prefixes go first; other tenants are untouched.
  while (redis.zcard(recentKey(tenant)) > kMaxPrefixesPerTenant) {
    const auto coldest = redis.zpopmin(recentKey(tenant));
    if (!coldest) break;
    redis.del(cacheKey(tenant, coldest->first));
  }
}
`,
    },
  },
  harness: {
    python: `def check_tenant_key(ctx):
    m = ctx.load("cache")
    m.put_suggestions("acme", "ke", ["kettle", "kettlebell"])
    seen = m.get_suggestions("globex", "ke")
    assert seen is None, f"globex read {seen} for ke: acme's completions, cached under a key without the tenant"
    m.put_suggestions("globex", "ke", ["kebab"])
    assert m.get_suggestions("acme", "ke") == ["kettle", "kettlebell"], f"acme reads {m.get_suggestions('acme', 'ke')} for ke after globex cached its own"
    assert m.get_suggestions("globex", "ke") == ["kebab"], f"globex reads {m.get_suggestions('globex', 'ke')} for ke"
    keys = sorted(ctx.redis.keys("suggest:cache:*"))
    assert len(keys) == 2 and keys[0].startswith("suggest:cache:acme:") and keys[1].startswith("suggest:cache:globex:"), f"the cache holds {keys}: every key must start suggest:cache:{{tenant}}:"


def check_catalog_version(ctx):
    m = ctx.load("cache")
    m.put_suggestions("acme", "ke", ["kettle"])
    assert m.get_suggestions("acme", "ke") == ["kettle"], f"a fresh entry reads back as {m.get_suggestions('acme', 'ke')}"
    ctx.redis.incr("suggest:catalog:acme")  # a catalog change: version 0 → 1
    got = m.get_suggestions("acme", "ke")
    assert got is None, f"after acme's catalog moved to version 1 the cache still answered {got}: the version belongs in the key, so the old entry is not read"
    m.put_suggestions("acme", "ke", ["kettle pro"])
    assert m.get_suggestions("acme", "ke") == ["kettle pro"], f"the refill under version 1 reads back as {m.get_suggestions('acme', 'ke')}"
    assert ctx.redis.exists("suggest:cache:acme:v1:ke") == 1, f"no suggest:cache:acme:v1:ke; the cache holds {sorted(ctx.redis.keys('suggest:cache:*'))}"


def check_ttl(ctx):
    m = ctx.load("cache")
    m.put_suggestions("acme", "ke", ["kettle"])
    ctx.clock.advance(299)
    assert m.get_suggestions("acme", "ke") == ["kettle"], "an entry must still be served 299 s after it was written"
    ctx.clock.advance(2)
    got = m.get_suggestions("acme", "ke")
    assert got is None, f"301 s after it was written the entry is still served ({got}): write it with a 300 s expiry (TTL_SECONDS)"


def check_coldest_cap(ctx):
    m = ctx.load("cache")
    m.put_suggestions("acme", "kettle", ["kettle"])
    for n in range(100):
        m.put_suggestions("globex", f"p{n:03d}", [f"t{n}"])
        ctx.clock.advance(1)
    assert m.get_suggestions("globex", "p000") == ["t0"], "at the cap of 100 prefixes every entry must still be cached"
    ctx.clock.advance(1)
    m.put_suggestions("globex", "p100", ["t100"])
    cached = ctx.redis.keys("suggest:cache:*")
    assert len(cached) == 101, f"Redis holds {len(cached)} cache entries after acme's one and globex's 101 writes, expected 101: globex capped at 100"
    assert m.get_suggestions("globex", "p001") is None, "p001 was the coldest prefix when the 101st arrived and must have been evicted"
    assert m.get_suggestions("globex", "p000") == ["t0"], "p000 was read just before the cap was crossed and was evicted: the coldest prefix is the least recently read or written, not the oldest written"
    assert m.get_suggestions("globex", "p100") == ["t100"], "the newest prefix must be cached"
    assert m.get_suggestions("acme", "kettle") == ["kettle"], "globex's flood evicted acme's entry: the cap is per tenant"
`,
    typescript: `export async function check_tenant_key(ctx) {
  const m = ctx.load('cache');
  await m.putSuggestions('acme', 'ke', ['kettle', 'kettlebell']);
  const seen = await m.getSuggestions('globex', 'ke');
  assert.equal(seen, null, \`globex read \${JSON.stringify(seen)} for ke: acme's completions, cached under a key without the tenant\`);
  await m.putSuggestions('globex', 'ke', ['kebab']);
  assert.deepStrictEqual(await m.getSuggestions('acme', 'ke'), ['kettle', 'kettlebell'], "acme must read its own completions for ke after globex cached its own");
  assert.deepStrictEqual(await m.getSuggestions('globex', 'ke'), ['kebab'], 'globex must read its own completions for ke');
  const keys = (ctx.redis.keys('suggest:cache:*') as string[]).sort();
  assert(keys.length === 2 && keys[0].startsWith('suggest:cache:acme:') && keys[1].startsWith('suggest:cache:globex:'), \`the cache holds \${JSON.stringify(keys)}: every key must start suggest:cache:{tenant}:\`);
}

export async function check_catalog_version(ctx) {
  const m = ctx.load('cache');
  await m.putSuggestions('acme', 'ke', ['kettle']);
  assert.deepStrictEqual(await m.getSuggestions('acme', 'ke'), ['kettle'], 'a fresh entry must read back');
  ctx.redis.incr('suggest:catalog:acme'); // a catalog change: version 0 → 1
  const got = await m.getSuggestions('acme', 'ke');
  assert.equal(got, null, \`after acme's catalog moved to version 1 the cache still answered \${JSON.stringify(got)}: the version belongs in the key, so the old entry is not read\`);
  await m.putSuggestions('acme', 'ke', ['kettle pro']);
  assert.deepStrictEqual(await m.getSuggestions('acme', 'ke'), ['kettle pro'], 'the refill under version 1 must read back');
  assert.equal(ctx.redis.exists('suggest:cache:acme:v1:ke'), 1, \`no suggest:cache:acme:v1:ke; the cache holds \${JSON.stringify(ctx.redis.keys('suggest:cache:*'))}\`);
}

export async function check_ttl(ctx) {
  const m = ctx.load('cache');
  await m.putSuggestions('acme', 'ke', ['kettle']);
  ctx.clock.advance(299);
  assert.deepStrictEqual(await m.getSuggestions('acme', 'ke'), ['kettle'], 'an entry must still be served 299 s after it was written');
  ctx.clock.advance(2);
  const got = await m.getSuggestions('acme', 'ke');
  assert.equal(got, null, \`301 s after it was written the entry is still served (\${JSON.stringify(got)}): write it with a 300 s expiry (TTL_SECONDS)\`);
}

export async function check_coldest_cap(ctx) {
  const m = ctx.load('cache');
  await m.putSuggestions('acme', 'kettle', ['kettle']);
  const name = (n: number) => \`p\${String(n).padStart(3, '0')}\`;
  for (let n = 0; n < 100; n++) {
    await m.putSuggestions('globex', name(n), [\`t\${n}\`]);
    ctx.clock.advance(1);
  }
  assert.deepStrictEqual(await m.getSuggestions('globex', 'p000'), ['t0'], 'at the cap of 100 prefixes every entry must still be cached');
  ctx.clock.advance(1);
  await m.putSuggestions('globex', 'p100', ['t100']);
  const cached = ctx.redis.keys('suggest:cache:*') as string[];
  assert.equal(cached.length, 101, \`Redis holds \${cached.length} cache entries after acme's one and globex's 101 writes, expected 101: globex capped at 100\`);
  assert.equal(await m.getSuggestions('globex', 'p001'), null, 'p001 was the coldest prefix when the 101st arrived and must have been evicted');
  assert.deepStrictEqual(await m.getSuggestions('globex', 'p000'), ['t0'], 'p000 was read just before the cap was crossed and was evicted: the coldest prefix is the least recently read or written, not the oldest written');
  assert.deepStrictEqual(await m.getSuggestions('globex', 'p100'), ['t100'], 'the newest prefix must be cached');
  assert.deepStrictEqual(await m.getSuggestions('acme', 'kettle'), ['kettle'], "globex's flood evicted acme's entry: the cap is per tenant");
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"leetbuild/harness"
)

var cacheBg = context.Background()

func cacheRead(ctx *harness.Ctx, tenant, prefix string) []string {
	got, hit := getSuggestions(cacheBg, tenant, prefix)
	if !hit {
		return nil
	}
	if got == nil {
		got = []string{}
	}
	return got
}

func CheckTenantKey(ctx *harness.Ctx) {
	putSuggestions(cacheBg, "acme", "ke", []string{"kettle", "kettlebell"})
	seen := cacheRead(ctx, "globex", "ke")
	ctx.Assert(seen == nil, "globex read %q for ke: acme's completions, cached under a key without the tenant", seen)
	putSuggestions(cacheBg, "globex", "ke", []string{"kebab"})
	ctx.Equal(cacheRead(ctx, "acme", "ke"), []string{"kettle", "kettlebell"}, "acme's completions for ke after globex cached its own")
	ctx.Equal(cacheRead(ctx, "globex", "ke"), []string{"kebab"}, "globex's completions for ke")
	keys := ctx.Redis.Keys("suggest:cache:*")
	ctx.Assert(len(keys) == 2 && strings.HasPrefix(keys[0], "suggest:cache:acme:") && strings.HasPrefix(keys[1], "suggest:cache:globex:"), "the cache holds %q: every key must start suggest:cache:{tenant}:", keys)
}

func CheckCatalogVersion(ctx *harness.Ctx) {
	putSuggestions(cacheBg, "acme", "ke", []string{"kettle"})
	ctx.Equal(cacheRead(ctx, "acme", "ke"), []string{"kettle"}, "a fresh entry must read back")
	ctx.Redis.Do("INCR", "suggest:catalog:acme") // a catalog change: version 0 → 1
	got := cacheRead(ctx, "acme", "ke")
	ctx.Assert(got == nil, "after acme's catalog moved to version 1 the cache still answered %q: the version belongs in the key, so the old entry is not read", got)
	putSuggestions(cacheBg, "acme", "ke", []string{"kettle pro"})
	ctx.Equal(cacheRead(ctx, "acme", "ke"), []string{"kettle pro"}, "the refill under version 1 must read back")
	ctx.Equal(ctx.Redis.Exists("suggest:cache:acme:v1:ke"), 1, "suggest:cache:acme:v1:ke must exist (the cache holds %q)", ctx.Redis.Keys("suggest:cache:*"))
}

func CheckTtl(ctx *harness.Ctx) {
	putSuggestions(cacheBg, "acme", "ke", []string{"kettle"})
	ctx.Clock.Advance(299)
	ctx.Equal(cacheRead(ctx, "acme", "ke"), []string{"kettle"}, "an entry must still be served 299 s after it was written")
	ctx.Clock.Advance(2)
	got := cacheRead(ctx, "acme", "ke")
	ctx.Assert(got == nil, "301 s after it was written the entry is still served (%q): write it with a 300 s expiry (ttl)", got)
}

func CheckColdestCap(ctx *harness.Ctx) {
	putSuggestions(cacheBg, "acme", "kettle", []string{"kettle"})
	for n := 0; n < 100; n++ {
		putSuggestions(cacheBg, "globex", fmt.Sprintf("p%03d", n), []string{fmt.Sprintf("t%d", n)})
		ctx.Clock.Advance(1)
	}
	ctx.Equal(cacheRead(ctx, "globex", "p000"), []string{"t0"}, "at the cap of 100 prefixes every entry must still be cached")
	ctx.Clock.Advance(1)
	putSuggestions(cacheBg, "globex", "p100", []string{"t100"})
	ctx.Equal(len(ctx.Redis.Keys("suggest:cache:*")), 101, "the cache entries after acme's one and globex's 101 writes (globex capped at 100)")
	ctx.Assert(cacheRead(ctx, "globex", "p001") == nil, "p001 was the coldest prefix when the 101st arrived and must have been evicted")
	ctx.Equal(cacheRead(ctx, "globex", "p000"), []string{"t0"}, "p000 was read just before the cap was crossed: the coldest prefix is the least recently read or written, not the oldest written; p000")
	ctx.Equal(cacheRead(ctx, "globex", "p100"), []string{"t100"}, "the newest prefix must be cached")
	ctx.Equal(cacheRead(ctx, "acme", "kettle"), []string{"kettle"}, "globex's flood must not evict acme's entry (the cap is per tenant)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdio>
#include <optional>
#include <string>
#include <vector>

namespace {

using Strings = std::vector<std::string>;

std::string cacheName(const char* format, int n) {
  char out[16];
  std::snprintf(out, sizeof out, format, n);
  return out;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  putSuggestions("acme", "ke", {"kettle", "kettlebell"});
  const auto seen = getSuggestions("globex", "ke");
  ctx.Assert(!seen, "globex read %q for ke: acme's completions, cached under a key without the tenant", seen.value_or(Strings{}));
  putSuggestions("globex", "ke", {"kebab"});
  ctx.Equal(getSuggestions("acme", "ke"), Strings{"kettle", "kettlebell"}, "acme's completions for ke after globex cached its own");
  ctx.Equal(getSuggestions("globex", "ke"), Strings{"kebab"}, "globex's completions for ke");
  const auto keys = ctx.Redis.Keys("suggest:cache:*");
  ctx.Assert(keys.size() == 2 && keys[0].rfind("suggest:cache:acme:", 0) == 0 && keys[1].rfind("suggest:cache:globex:", 0) == 0,
             "the cache holds %q: every key must start suggest:cache:{tenant}:", keys);
}

void CheckCatalogVersion(harness::Ctx& ctx) {
  putSuggestions("acme", "ke", {"kettle"});
  ctx.Equal(getSuggestions("acme", "ke"), Strings{"kettle"}, "a fresh entry must read back");
  ctx.Redis.Must({"INCR", "suggest:catalog:acme"});  // a catalog change: version 0 → 1
  const auto got = getSuggestions("acme", "ke");
  ctx.Assert(!got, "after acme's catalog moved to version 1 the cache still answered %q: the version belongs in the key, so the old entry is not read", got.value_or(Strings{}));
  putSuggestions("acme", "ke", {"kettle pro"});
  ctx.Equal(getSuggestions("acme", "ke"), Strings{"kettle pro"}, "the refill under version 1 must read back");
  ctx.Equal(ctx.Redis.Exists("suggest:cache:acme:v1:ke"), 1, "suggest:cache:acme:v1:ke must exist (the cache holds %q)", ctx.Redis.Keys("suggest:cache:*"));
}

void CheckTtl(harness::Ctx& ctx) {
  putSuggestions("acme", "ke", {"kettle"});
  ctx.Clock.Advance(299);
  ctx.Equal(getSuggestions("acme", "ke"), Strings{"kettle"}, "an entry must still be served 299 s after it was written");
  ctx.Clock.Advance(2);
  const auto got = getSuggestions("acme", "ke");
  ctx.Assert(!got, "301 s after it was written the entry is still served (%q): write it with a 300 s expiry (kTtlSeconds)", got.value_or(Strings{}));
}

void CheckColdestCap(harness::Ctx& ctx) {
  putSuggestions("acme", "kettle", {"kettle"});
  for (int n = 0; n < 100; ++n) {
    putSuggestions("globex", cacheName("p%03d", n), {cacheName("t%d", n)});
    ctx.Clock.Advance(1);
  }
  ctx.Equal(getSuggestions("globex", "p000"), Strings{"t0"}, "at the cap of 100 prefixes every entry must still be cached");
  ctx.Clock.Advance(1);
  putSuggestions("globex", "p100", {"t100"});
  ctx.Equal(ctx.Redis.Keys("suggest:cache:*").size(), 101, "the cache entries after acme's one and globex's 101 writes (globex capped at 100)");
  ctx.Assert(!getSuggestions("globex", "p001"), "p001 was the coldest prefix when the 101st arrived and must have been evicted");
  ctx.Equal(getSuggestions("globex", "p000"), Strings{"t0"}, "p000 was read just before the cap was crossed: the coldest prefix is the least recently read or written, not the oldest written; p000");
  ctx.Equal(getSuggestions("globex", "p100"), Strings{"t100"}, "the newest prefix must be cached");
  ctx.Equal(getSuggestions("acme", "kettle"), Strings{"kettle"}, "globex's flood must not evict acme's entry (the cap is per tenant)");
}
`,
  },
  hints: [
    "Cache `ke` for one tenant and read it as another: the second tenant sees the first one's terms. Bump the catalog version: the old terms stay. Write a prefix and wait ten minutes: it is still there.",
    'The key is the prefix alone, so tenants and catalog versions share entries; the `SET` has no expiry; and nothing counts how many prefixes a tenant holds, so a walk over the keyspace only grows it.',
    "Key `suggest:cache:{tenant}:v{terms.catalog_version(tenant)}:{prefix}`, `SET … EX 300`; `ZADD suggest:recent:{tenant} now prefix` on every hit and write; while `ZCARD` > 100, `ZPOPMIN` and `DEL` that prefix's entry.",
  ],
  debrief: `The key is the isolation boundary and the invalidation rule at once: with the tenant in it nobody reads another tenant's terms, and with the catalog version in it a catalog change is a new namespace, so nothing has to find and delete stale entries. The TTL bounds how long any mistake is served. The per-tenant cap bounds memory per tenant rather than per cluster, so one tenant's bot evicts its own coldest prefixes and not another tenant's hot ones; scoring reads as well as writes is what makes the eviction "coldest" instead of "oldest". Production caches also expire the recency set, sample eviction instead of walking it, and run the cap check in a Lua script so two writers cannot each evict.`,
};
