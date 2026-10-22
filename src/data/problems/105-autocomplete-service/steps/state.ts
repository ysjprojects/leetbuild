import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis suggestion cache behind GET /v1/autocomplete',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads and writes cached top
suggestions per prefix, and it looks exactly like a cache. It compiles, it improves the demo latency,
and it hides three production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement the Redis suggestion cache behind \`GET /v1/autocomplete\`.

- Top suggestions are cached per **\`(tenant, prefix)\`** under a key that also carries the
  **catalog version**, so a catalog change moves reads to a new key instead of serving stale terms.
- Every cached entry has a **5-minute TTL** (\`TTL_SECONDS = 300\`). A prefix that is never requested
  again expires on its own.
- A tenant may hold at most **\`MAX_PREFIXES_PER_TENANT\` distinct cached prefixes**. When the cap is
  hit the **coldest** prefix — least recently read or written — is evicted first, so a flood of
  prefixes cannot grow memory without bound.
- Reads are tenant-scoped: one tenant can never read another tenant's cached suggestions, even when
  the prefix text is identical.
- The cap and the eviction are per tenant; one tenant's flood must not evict another tenant's hot
  prefixes.

**Failure mode the checks target.** Caching every prefix with no cap turns the cache into the memory
leak: a bot walking the keyspace fills Redis until eviction pressure destroys the hit rate for
everyone. No TTL is the second one — a catalog change leaves the old top suggestions served forever,
so a retracted term stays "popular". The key without the tenant is the subtle one: it compiles and it
is faster, and it silently answers one tenant with another tenant's suggestions the first time two
tenants type the same prefix.`,
  sequence: {
    participants: ['Autocomplete API', 'Suggestion cache', 'Catalog'],
    messages: [
      {from: 'Autocomplete API', to: 'Suggestion cache', label: 'GET autocomplete:{tenant}:{v}:{prefix}', kind: 'sync'},
      {from: 'Suggestion cache', to: 'Autocomplete API', label: 'top suggestions / miss', kind: 'reply'},
      {from: 'Autocomplete API', to: 'Catalog', label: 'matching(tenant, prefix) on miss', kind: 'sync'},
      {from: 'Catalog', to: 'Autocomplete API', label: 'ranked terms', kind: 'reply'},
      {from: 'Autocomplete API', to: 'Suggestion cache', label: 'SETEX 300 · ZADD coldest', kind: 'async'},
      {from: 'Suggestion cache', to: 'Suggestion cache', label: 'ZPOPMIN when over the cap', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'ttl',
      title: 'Cached prefix entries carry the 5-minute TTL',
      detail:
        'Every cached prefix is written with `TTL_SECONDS = 300` so it expires on its own. The draft writes with no expiry, so stale suggestions outlive a catalog change.',
      match: {
        python: {all: [/TTL_SECONDS/, /ex\s*=\s*TTL_SECONDS/]},
        typescript: {all: [/TTL_SECONDS/, /['"]EX['"]\s*,\s*TTL_SECONDS/]},
        go: {all: [/ttlSeconds/, /time\.Second/]},
        scala: {all: [/TtlSeconds/, /setEx\(/]},
        cpp: {all: [/kTtlSeconds/, /setex\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Cache keys are scoped to the tenant and the prefix',
      detail:
        'The key builder takes the tenant and the prefix, so two tenants that type the same prefix never share an entry. The draft keys by prefix text alone.',
      match: {
        python: {all: [/def cache_key\(/, /tenant/]},
        typescript: {all: [/cacheKey\(/, /tenant/]},
        go: {all: [/func cacheKey\(/, /tenant/]},
        scala: {all: [/def cacheKey\(/, /tenant/]},
        cpp: {all: [/cacheKey\(/, /tenant/]},
      },
    },
    {
      id: 'prefix-cap',
      title: 'A per-tenant cap bounds distinct cached prefixes',
      detail:
        'A tenant may hold at most `MAX_PREFIXES_PER_TENANT` distinct cached prefixes; the count is tracked per tenant. The draft has no cap, so a prefix flood grows memory until eviction pressure destroys the hit rate.',
      match: {
        python: {all: [/MAX_PREFIXES_PER_TENANT/, /zcard\(/]},
        typescript: {all: [/MAX_PREFIXES_PER_TENANT/, /zcard\(/]},
        go: {all: [/maxPrefixesPerTenant/, /ZCard\(/]},
        scala: {all: [/MaxPrefixesPerTenant/, /zcard\(/]},
        cpp: {all: [/kMaxPrefixesPerTenant/, /zcard\(/]},
      },
    },
    {
      id: 'evict-coldest',
      title: 'Evicts the coldest prefix when the cap is hit',
      detail:
        'When the per-tenant cap is exceeded, the coldest prefix is evicted first (least recently used), so hot prefixes survive a flood. The draft never evicts anything.',
      match: {
        python: {all: [/evict_coldest/, /zpopmin\(/]},
        typescript: {all: [/evictColdest\(/, /zpopmin\(/]},
        go: {all: [/evictColdest\(/, /ZPopMin\(/]},
        scala: {all: [/evictColdest\(/, /zpopmin\(/]},
        cpp: {all: [/evictColdest\(/, /zpopmin\(/]},
      },
    },
    {
      id: 'catalog-version',
      title: 'A catalog change refreshes cached suggestions',
      detail:
        'The key carries the catalog version, so a catalog change reads a fresh key and refreshes within the TTL. The draft key never changes, so a retracted term stays cached.',
      match: {
        python: {all: [/CATALOG_VERSION/, /def cache_key\(/]},
        typescript: {all: [/CATALOG_VERSION/, /cacheKey\(/]},
        go: {all: [/catalogVersion/, /cacheKey\(/]},
        scala: {all: [/CatalogVersion/, /cacheKey\(/]},
        cpp: {all: [/kCatalogVersion/, /cacheKey\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json


class SuggestionCache:
    def __init__(self, redis):
        self.redis = redis

    def get(self, tenant: str, prefix: str):
        # TODO: this draft caches every prefix under a key with no tenant, no TTL and no cap, so
        # one tenant's flood grows memory, stale suggestions outlive a catalog change, and two
        # tenants that type the same prefix share an entry. Review all three.
        raw = self.redis.get(f"autocomplete:{prefix}")
        if raw is None:
            return None
        return json.loads(raw)

    def remember(self, tenant: str, prefix: str, suggestions) -> None:
        self.redis.set(f"autocomplete:{prefix}", json.dumps(suggestions))
`,
      solution: `import json
import time

TTL_SECONDS = 300
MAX_PREFIXES_PER_TENANT = 1000
CATALOG_VERSION = "2026-10-21"


def cache_key(tenant: str, prefix: str) -> str:
    return f"autocomplete:{tenant}:{CATALOG_VERSION}:{prefix}"


def cold_key(tenant: str) -> str:
    return f"autocomplete:coldest:{tenant}"


class SuggestionCache:
    def __init__(self, redis):
        self.redis = redis

    def get(self, tenant: str, prefix: str):
        raw = self.redis.get(cache_key(tenant, prefix))
        if raw is None:
            return None
        self.redis.zadd(cold_key(tenant), {prefix: time.time()})
        return json.loads(raw)

    def remember(self, tenant: str, prefix: str, suggestions) -> None:
        pipe = self.redis.pipeline()
        pipe.set(cache_key(tenant, prefix), json.dumps(suggestions), ex=TTL_SECONDS)
        pipe.zadd(cold_key(tenant), {prefix: time.time()})
        pipe.expire(cold_key(tenant), TTL_SECONDS)
        pipe.execute()
        if self.redis.zcard(cold_key(tenant)) > MAX_PREFIXES_PER_TENANT:
            self.evict_coldest(tenant)

    def evict_coldest(self, tenant: str) -> None:
        while self.redis.zcard(cold_key(tenant)) > MAX_PREFIXES_PER_TENANT:
            coldest = self.redis.zpopmin(cold_key(tenant), count=1)
            if not coldest:
                return
            prefix = coldest[0][0]
            if isinstance(prefix, bytes):
                prefix = prefix.decode()
            self.redis.delete(cache_key(tenant, prefix))
`,
    },
    typescript: {
      starter: `import type {Redis} from 'ioredis';

export class SuggestionCache {
  constructor(private readonly redis: Redis) {}

  async get(tenant: string, prefix: string): Promise<string[] | null> {
    // TODO: this draft caches every prefix under a key with no tenant, no TTL and no cap, so
    // one tenant's flood grows memory, stale suggestions outlive a catalog change, and two
    // tenants that type the same prefix share an entry. Review all three.
    const raw = await this.redis.get(\`autocomplete:\${prefix}\`);
    if (raw === null) return null;
    return JSON.parse(raw) as string[];
  }

  async remember(tenant: string, prefix: string, suggestions: string[]): Promise<void> {
    await this.redis.set(\`autocomplete:\${prefix}\`, JSON.stringify(suggestions));
  }
}
`,
      solution: `import type {Redis} from 'ioredis';

export const TTL_SECONDS = 300;
export const MAX_PREFIXES_PER_TENANT = 1000;
export const CATALOG_VERSION = '2026-10-21';

export function cacheKey(tenant: string, prefix: string): string {
  return \`autocomplete:\${tenant}:\${CATALOG_VERSION}:\${prefix}\`;
}

export function coldKey(tenant: string): string {
  return \`autocomplete:coldest:\${tenant}\`;
}

export class SuggestionCache {
  constructor(private readonly redis: Redis) {}

  async get(tenant: string, prefix: string): Promise<string[] | null> {
    const raw = await this.redis.get(cacheKey(tenant, prefix));
    if (raw === null) return null;
    await this.redis.zadd(coldKey(tenant), Date.now(), prefix);
    return JSON.parse(raw) as string[];
  }

  async remember(tenant: string, prefix: string, suggestions: string[]): Promise<void> {
    await this.redis
      .multi()
      .set(cacheKey(tenant, prefix), JSON.stringify(suggestions), 'EX', TTL_SECONDS)
      .zadd(coldKey(tenant), Date.now(), prefix)
      .expire(coldKey(tenant), TTL_SECONDS)
      .exec();
    if ((await this.redis.zcard(coldKey(tenant))) > MAX_PREFIXES_PER_TENANT) await this.evictColdest(tenant);
  }

  async evictColdest(tenant: string): Promise<void> {
    while ((await this.redis.zcard(coldKey(tenant))) > MAX_PREFIXES_PER_TENANT) {
      const coldest = await this.redis.zpopmin(coldKey(tenant), 1);
      if (coldest.length === 0) return;
      await this.redis.del(cacheKey(tenant, coldest[0]));
    }
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

type SuggestionCache struct {
	redis *redis.Client
}

func (c *SuggestionCache) Get(ctx context.Context, tenant, prefix string) ([]string, error) {
	// TODO: this draft caches every prefix under a key with no tenant, no TTL and no cap, so
	// one tenant's flood grows memory, stale suggestions outlive a catalog change, and two
	// tenants that type the same prefix share an entry. Review all three.
	raw, err := c.redis.Get(ctx, "autocomplete:"+prefix).Result()
	if err != nil {
		return nil, err
	}
	var suggestions []string
	if err := json.Unmarshal([]byte(raw), &suggestions); err != nil {
		return nil, err
	}
	return suggestions, nil
}

func (c *SuggestionCache) Remember(ctx context.Context, tenant, prefix string, suggestions []string) error {
	payload, _ := json.Marshal(suggestions)
	return c.redis.Set(ctx, "autocomplete:"+prefix, payload, 0).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	ttlSeconds           = 300
	maxPrefixesPerTenant = 1000
	catalogVersion       = "2026-10-21"
)

func cacheKey(tenant, prefix string) string {
	return "autocomplete:" + tenant + ":" + catalogVersion + ":" + prefix
}

func coldKey(tenant string) string {
	return "autocomplete:coldest:" + tenant
}

type SuggestionCache struct {
	redis *redis.Client
}

func (c *SuggestionCache) Remember(ctx context.Context, tenant, prefix string, suggestions []string) error {
	payload, err := json.Marshal(suggestions)
	if err != nil {
		return err
	}
	pipe := c.redis.TxPipeline()
	pipe.Set(ctx, cacheKey(tenant, prefix), payload, ttlSeconds*time.Second)
	pipe.ZAdd(ctx, coldKey(tenant), redis.Z{Score: float64(time.Now().Unix()), Member: prefix})
	pipe.Expire(ctx, coldKey(tenant), ttlSeconds*time.Second)
	if _, err := pipe.Exec(ctx); err != nil {
		return err
	}
	size, err := c.redis.ZCard(ctx, coldKey(tenant)).Result()
	if err != nil {
		return err
	}
	if size > maxPrefixesPerTenant {
		return c.evictColdest(ctx, tenant)
	}
	return nil
}

func (c *SuggestionCache) evictColdest(ctx context.Context, tenant string) error {
	for {
		size, err := c.redis.ZCard(ctx, coldKey(tenant)).Result()
		if err != nil {
			return err
		}
		if size <= maxPrefixesPerTenant {
			return nil
		}
		popped, err := c.redis.ZPopMin(ctx, coldKey(tenant), 1).Result()
		if err != nil {
			return err
		}
		if len(popped) == 0 {
			return nil
		}
		member, _ := popped[0].Member.(string)
		if err := c.redis.Del(ctx, cacheKey(tenant, member)).Err(); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `trait Redis {
  def get(key: String): Option[String]
  def set(key: String, value: String): Unit
}

object State {
  def remember(redis: Redis, tenant: String, prefix: String, suggestions: List[String]): Unit = {
    // TODO: this draft caches every prefix under a key with no tenant, no TTL and no cap, so
    // one tenant's flood grows memory, stale suggestions outlive a catalog change, and two
    // tenants that type the same prefix share an entry. Review all three.
    redis.set(s"autocomplete:$prefix", suggestions.mkString("[", ",", "]"))
  }
}
`,
      solution: `import java.time.Instant

trait Redis {
  def get(key: String): Option[String]
  def set(key: String, value: String): Unit
  def setEx(key: String, seconds: Long, value: String): Unit
  def expire(key: String, seconds: Long): Unit
  def zadd(key: String, score: Double, member: String): Unit
  def zcard(key: String): Long
  def zpopmin(key: String, count: Int): List[String]
  def del(key: String): Unit
}

object State {
  val TtlSeconds: Long = 300
  val MaxPrefixesPerTenant: Long = 1000
  val CatalogVersion = "2026-10-21"

  def cacheKey(tenant: String, prefix: String): String =
    s"autocomplete:$tenant:$CatalogVersion:$prefix"

  def coldKey(tenant: String): String = s"autocomplete:coldest:$tenant"

  def evictColdest(redis: Redis, tenant: String): Unit = {
    while (redis.zcard(coldKey(tenant)) > MaxPrefixesPerTenant) {
      redis.zpopmin(coldKey(tenant), 1).headOption match {
        case Some(member) => redis.del(cacheKey(tenant, member))
        case None => return
      }
    }
  }

  def remember(redis: Redis, tenant: String, prefix: String, suggestions: List[String]): Unit = {
    redis.setEx(cacheKey(tenant, prefix), TtlSeconds, suggestions.mkString("[", ",", "]"))
    redis.zadd(coldKey(tenant), Instant.now().toEpochMilli.toDouble, prefix)
    redis.expire(coldKey(tenant), TtlSeconds)
    if (redis.zcard(coldKey(tenant)) > MaxPrefixesPerTenant) evictColdest(redis, tenant)
  }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <vector>

#include <redis++/redis++.h>

using namespace sw::redis;

std::string join(const std::vector<std::string>& values);

void remember(Redis& redis, const std::string& tenant, const std::string& prefix, const std::vector<std::string>& suggestions) {
  // TODO: this draft caches every prefix under a key with no tenant, no TTL and no cap, so
  // one tenant's flood grows memory, stale suggestions outlive a catalog change, and two
  // tenants that type the same prefix share an entry. Review all three.
  redis.set("autocomplete:" + prefix, join(suggestions));
}
`,
      solution: `#include <ctime>
#include <string>
#include <vector>

#include <redis++/redis++.h>

using namespace sw::redis;

constexpr long kTtlSeconds = 300;
constexpr long kMaxPrefixesPerTenant = 1000;
const std::string kCatalogVersion = "2026-10-21";

std::string join(const std::vector<std::string>& values);

std::string cacheKey(const std::string& tenant, const std::string& prefix) {
  return "autocomplete:" + tenant + ":" + kCatalogVersion + ":" + prefix;
}

std::string coldKey(const std::string& tenant) {
  return "autocomplete:coldest:" + tenant;
}

void evictColdest(Redis& redis, const std::string& tenant) {
  while (redis.zcard(coldKey(tenant)) > kMaxPrefixesPerTenant) {
    const auto coldest = redis.zpopmin(coldKey(tenant), 1);
    if (coldest.empty()) return;
    redis.del(cacheKey(tenant, coldest.front()));
  }
}

void remember(Redis& redis, const std::string& tenant, const std::string& prefix, const std::vector<std::string>& suggestions) {
  redis.setex(cacheKey(tenant, prefix), kTtlSeconds, join(suggestions));
  redis.zadd(coldKey(tenant), static_cast<double>(std::time(nullptr)), prefix);
  redis.expire(coldKey(tenant), kTtlSeconds);
  if (redis.zcard(coldKey(tenant)) > kMaxPrefixesPerTenant) evictColdest(redis, tenant);
}
`,
    },
  },
  hints: [
    'The key is the whole design: `(tenant, prefix, catalog version)`. Tenant first so a read can never cross a tenant boundary, version next so a catalog change moves to a fresh key without a flush.',
    'Bound the cache per tenant, not globally. Keep a per-tenant sorted set of cached prefixes scored by last use, and when its cardinality passes the cap, `ZPOPMIN` the coldest and delete its entry — the flood then costs the flooder, not everyone.',
    'Write the payload and the TTL in one pipeline so a crash cannot leave an entry without its expiry. The TTL is 300 seconds, and the eviction runs after the write, not instead of it.',
  ],
  debrief: `The interviewer is testing whether you can review a generated cache at the multi-tenant boundary. The draft reads fine because one tenant types a handful of prefixes and never retries. Three defects are being checked. No TTL means a catalog change cannot refresh cached suggestions, so a retracted term stays "popular" for as long as the key lives. No per-tenant cap means the cache is the memory leak: a bot walking the keyspace grows the keyspace until eviction pressure destroys the hit rate for every tenant. The subtle one is the key without the tenant: it is faster and it compiles, and it answers one tenant with another tenant's suggestions the first time two tenants type the same prefix. Real caches add a hot-prefix prewarm after a catalog change, a per-tenant cap that scales with plan size, and a metric on evictions so a flood is visible before it hurts.`,
};
