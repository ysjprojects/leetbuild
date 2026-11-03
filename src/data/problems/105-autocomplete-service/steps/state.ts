import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis suggestion cache behind GET /v1/autocomplete',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter reads and writes cached top suggestions under
\`autocomplete:{prefix}\` with a plain \`SET\`, and the lookup behind \`GET /v1/autocomplete\` goes
through it. It compiles, it improves the demo latency, and it hides 5 flaws.

**Failure mode the checks target.** With no cap, a bot walking the keyspace fills Redis until
eviction destroys everyone's hit rate. No TTL and no catalog version keep a retracted term
"popular". A key without the tenant answers one tenant with another's suggestions the first time
two tenants type the same prefix.

- Top suggestions are cached per **\`(tenant, prefix)\`** under a key that also carries the
  **catalog version**, so a catalog change moves reads to a new key instead of serving stale terms.
- Every cached entry has a **5-minute TTL** (\`TTL_SECONDS = 300\`). A prefix that is never requested
  again expires on its own.
- A tenant may hold at most **\`MAX_PREFIXES_PER_TENANT\` distinct cached prefixes**. When the cap is
  hit the **coldest** prefix (least recently read or written) is evicted first, so a flood of
  prefixes cannot grow memory without bound.
- Reads are tenant-scoped: one tenant can never read another tenant's cached suggestions, even when
  the prefix text is identical.
- The cap and the eviction are per tenant; one tenant's flood must not evict another tenant's hot
  prefixes.`,
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
        'Every cached prefix is written with `TTL_SECONDS = 300` so it expires on its own. The starter writes with no expiry, so stale suggestions outlive a catalog change.',
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
        'The key builder takes the tenant and the prefix, so two tenants that type the same prefix never share an entry. The starter keys by prefix text alone.',
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
        'A tenant may hold at most `MAX_PREFIXES_PER_TENANT` distinct cached prefixes; the count is tracked per tenant. The starter has no cap, so a prefix flood grows memory until eviction pressure destroys the hit rate.',
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
        'When the per-tenant cap is exceeded, the coldest prefix is evicted first (least recently used), so hot prefixes survive a flood. The starter never evicts anything.',
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
        'The key carries the catalog version, so a catalog change reads a fresh key and refreshes within the TTL. The starter key never changes, so a retracted term stays cached.',
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
        # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    'Two tenants type "caf" and the second one sees the first one\'s suggestions; a retracted term keeps showing up days after the catalog changed.',
    'The key is the prefix text alone, written with a bare SET: nothing scopes it to a tenant or a catalog version, nothing expires it, and nothing counts how many prefixes a tenant holds.',
    'Key by (tenant, catalog version, prefix), SETEX with TTL_SECONDS, ZADD the prefix into a per-tenant sorted set scored by time, and ZPOPMIN plus DEL when ZCARD passes MAX_PREFIXES_PER_TENANT.',
  ],
  debrief: `The key carries the tenant first so a read can never cross a tenant boundary by construction, and the catalog version next so a catalog change moves reads to a fresh key instead of needing a flush. The TTL goes in the same pipeline as the payload so a crash between the two cannot leave an entry without its expiry. The cap is per tenant, tracked in a sorted set scored by last use, because a global cap lets one tenant's flood evict everyone's hot prefixes; evicting the coldest first is what keeps the hit rate for real users intact during the flood. Production caches go further: a hot-prefix prewarm after a catalog change, a cap that scales with plan size, and an eviction counter per tenant so a flood is visible before the hit rate drops.`,
};
