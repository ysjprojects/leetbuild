import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis taxonomy cache and per-tenant counters',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'state',
  focus: ['classifier', 'redis', 'taxonomy'],
  task: `## Task

**Starting point.** The starter caches taxonomy versions and counts labels in Redis:
\`taxonomy_key(tenant, taxonomy_id, version)\` names the entry \`taxonomy:{taxonomy_id}:{version}\`,
\`cache_taxonomy(tenant, taxonomy)\` writes each label into it with \`HSET\`,
\`load_taxonomy(tenant, taxonomy_id, version)\` answers the entry or loads the version with
\`taxonomies.load\` and caches it, and \`bump_counter(tenant, label)\` runs \`HINCRBY metrics:{tenant}\`.
The second load hits the cache and the counters move. It hides 5 flaws.

**Failure mode the checks target.** A key without the tenant serves one tenant's taxonomy to
another for as long as the entry lives, and nothing ever expires it; a write label by label shows a
reader half a label set and keeps labels a re-cache dropped; a counter with no window grows one key
per tenant forever.

- The entry is \`taxonomy:{tenant}:{taxonomy_id}:{version}\`.
- It lives \`TAXONOMY_TTL_S\` = 600 seconds.
- A write is one \`SET\` of the whole taxonomy as JSON with its expiry, replacing what was there.
- Counters live in \`counters:{tenant}:{hour}\` (\`hour = unix seconds // 3600\`), \`HINCRBY\` on the label.
- A counter key expires when its hour ends (\`3600 - now % 3600\` seconds), set in the same
  transaction as the increment.`,
  sequence: {
    participants: ['Content Classifier', 'Redis', 'taxonomy store'],
    messages: [
      {from: 'Content Classifier', to: 'Redis', label: 'GET taxonomy:{tenant}:{id}:{version}', kind: 'sync'},
      {from: 'Redis', to: 'Content Classifier', label: 'miss', kind: 'reply'},
      {from: 'Content Classifier', to: 'taxonomy store', label: 'load(tenant, id, version)', kind: 'sync'},
      {from: 'taxonomy store', to: 'Content Classifier', label: 'version + labels / none', kind: 'reply'},
      {from: 'Content Classifier', to: 'Redis', label: 'SET key json EX 600', kind: 'sync'},
      {
        from: 'Content Classifier',
        to: 'Redis',
        label: 'MULTI · HINCRBY counters:{tenant}:{hour} · EXPIRE to hour end · EXEC',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Caches under (tenant, taxonomy id, version)',
      detail:
        'The entry is `taxonomy:{tenant}:{taxonomy_id}:{version}`, so a tenant that does not own the taxonomy misses and the store answers none. The starter’s key has no tenant: globex reads acme’s cached labels.',
      match: {
        python: {all: [/f["']taxonomy:\{tenant\}:\{taxonomy_id\}:\{version\}["']/]},
        typescript: {all: [/`taxonomy:\$\{tenant\}:\$\{taxonomyId\}:\$\{version\}`/]},
        go: {all: [/"taxonomy:%s:%s:%d",\s*tenant,\s*taxonomyID,\s*version/]},
        scala: {all: [/s"taxonomy:\$tenant:\$taxonomyId:\$version"/]},
        cpp: {all: [/"taxonomy:"\s*\+\s*tenant\s*\+/]},
      },
    },
    {
      id: 'ttl',
      title: 'Cache entries expire after 10 minutes',
      detail:
        'The entry is written with a TTL of `TAXONOMY_TTL_S` = 600 s and is gone ten minutes later. The starter’s entry never expires.',
      match: {
        python: {all: [/TAXONOMY_TTL_S\s*=\s*600\b/, /ex\s*=\s*TAXONOMY_TTL_S/]},
        typescript: {all: [/TAXONOMY_TTL_S\s*=\s*600\b/, /['"]EX['"],\s*TAXONOMY_TTL_S/]},
        go: {all: [/taxonomyTTL\s*=\s*600\s*\*\s*time\.Second/, /\.Set\([^\n]*taxonomyTTL\)/]},
        scala: {all: [/TaxonomyTtlS\s*=\s*600L?\b/, /setex\([^\n]*TaxonomyTtlS/]},
        cpp: {all: [/kTaxonomyTtl\{600\}/, /\.set\([^\n]*kTaxonomyTtl\)/]},
      },
    },
    {
      id: 'atomic-replace',
      title: 'Writes the whole taxonomy in one SET',
      detail:
        'One `SET` of the JSON document replaces the entry, so a reader sees the old version or the new one and a re-cache drops removed labels. The starter writes one `HSET` per label into a hash it never clears.',
      match: {
        python: {all: [/r\.set\(/, /json\.dumps\(/], none: [/\.hset\(/]},
        typescript: {all: [/redis\.set\(/, /JSON\.stringify\(/], none: [/\.hset\(/]},
        go: {all: [/rdb\.Set\(/, /json\.Marshal\(/], none: [/\.HSet\(/]},
        scala: {all: [/jedis\.setex\(/, /\.toJson/], none: [/\.hset\(/]},
        cpp: {all: [/redis\(\)\.set\(/, /toJson\(/], none: [/\.hset\(/]},
      },
    },
    {
      id: 'window-counters',
      title: 'Counts per tenant in hourly keys',
      detail:
        'A label is counted with `HINCRBY` in `counters:{tenant}:{hour}`, `hour` being unix seconds divided by 3600, so each hour has its own key. The starter counts into one `metrics:{tenant}` hash for all time.',
      match: {
        python: {all: [/f["']counters:\{tenant\}:/, /\/\/\s*COUNTER_WINDOW_S/], none: [/metrics:/]},
        typescript: {
          all: [/`counters:\$\{tenant\}:/, /Math\.floor\(\s*nowS\s*\/\s*COUNTER_WINDOW_S\s*\)/],
          none: [/metrics:/],
        },
        go: {all: [/"counters:%s:%d"/, /now\s*\/\s*counterWindowS/], none: [/metrics:/]},
        scala: {all: [/s"counters:\$tenant:/, /nowS\s*\/\s*CounterWindowS/], none: [/metrics:/]},
        cpp: {all: [/"counters:"\s*\+\s*tenant/, /now\s*\/\s*kCounterWindowS/], none: [/metrics:/]},
      },
    },
    {
      id: 'expire-with-window',
      title: 'Counter keys die with their window',
      detail:
        'The increment and an `EXPIRE` of `3600 - now % 3600` seconds go in one transaction, so the key expires at the end of its hour however late in the hour it was first written. The starter’s counter key never expires.',
      match: {
        python: {all: [/pipeline\(/, /\.expire\(/, /COUNTER_WINDOW_S\s*-\s*int\(now\)\s*%\s*COUNTER_WINDOW_S/]},
        typescript: {all: [/\.multi\(\)/, /\.expire\(/, /COUNTER_WINDOW_S\s*-\s*\(?nowS\s*%\s*COUNTER_WINDOW_S/]},
        go: {all: [/TxPipeline\(\)/, /\.Expire\(/, /counterWindowS\s*-\s*now\s*%\s*counterWindowS/]},
        scala: {all: [/\.multi\(\)/, /\.expire\(/, /CounterWindowS\s*-\s*now\s*%\s*CounterWindowS/]},
        cpp: {all: [/transaction\(\)/, /\.expire\(/, /kCounterWindowS\s*-\s*now\s*%\s*kCounterWindowS/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from classifier import taxonomies

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def taxonomy_key(tenant: str, taxonomy_id: str, version: int) -> str:
    return f"taxonomy:{taxonomy_id}:{version}"


def cache_taxonomy(tenant: str, taxonomy: dict) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    key = taxonomy_key(tenant, taxonomy["taxonomy_id"], taxonomy["version"])
    for label in taxonomy["labels"]:
        r.hset(key, label, "1")


def load_taxonomy(tenant: str, taxonomy_id: str, version: int) -> dict | None:
    cached = r.hgetall(taxonomy_key(tenant, taxonomy_id, version))
    if cached:
        return {"taxonomy_id": taxonomy_id, "version": version, "labels": sorted(cached)}
    taxonomy = taxonomies.load(tenant, taxonomy_id, version)
    if taxonomy is not None:
        cache_taxonomy(tenant, taxonomy)
    return taxonomy


def counters_key(tenant: str, now: float) -> str:
    return f"metrics:{tenant}"


def bump_counter(tenant: str, label: str) -> None:
    r.hincrby(counters_key(tenant, time.time()), label, 1)
`,
      solution: `import json
import time

import redis

from classifier import taxonomies

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TAXONOMY_TTL_S = 600
COUNTER_WINDOW_S = 3600


def taxonomy_key(tenant: str, taxonomy_id: str, version: int) -> str:
    """Tenant-scoped: a tenant that does not own the taxonomy misses and asks the store."""
    return f"taxonomy:{tenant}:{taxonomy_id}:{version}"


def cache_taxonomy(tenant: str, taxonomy: dict) -> None:
    # One SET of the whole document with its expiry: a reader sees the old entry or the new one.
    key = taxonomy_key(tenant, taxonomy["taxonomy_id"], taxonomy["version"])
    r.set(key, json.dumps(taxonomy), ex=TAXONOMY_TTL_S)


def load_taxonomy(tenant: str, taxonomy_id: str, version: int) -> dict | None:
    cached = r.get(taxonomy_key(tenant, taxonomy_id, version))
    if cached is not None:
        return json.loads(cached)
    taxonomy = taxonomies.load(tenant, taxonomy_id, version)
    if taxonomy is not None:
        cache_taxonomy(tenant, taxonomy)
    return taxonomy


def counters_key(tenant: str, now: float) -> str:
    return f"counters:{tenant}:{int(now) // COUNTER_WINDOW_S}"


def bump_counter(tenant: str, label: str) -> None:
    """The key dies with the hour it counts, however late in the hour it was first written."""
    now = time.time()
    key = counters_key(tenant, now)
    pipe = r.pipeline(transaction=True)
    pipe.hincrby(key, label, 1)
    pipe.expire(key, COUNTER_WINDOW_S - int(now) % COUNTER_WINDOW_S)
    pipe.execute()
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import * as taxonomies from 'classifier/taxonomies';

const redis = new Redis({host: 'redis', port: 6379});

export function taxonomyKey(tenant: string, taxonomyId: string, version: number): string {
  return \`taxonomy:\${taxonomyId}:\${version}\`;
}

export async function cacheTaxonomy(tenant: string, taxonomy: taxonomies.Taxonomy): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const key = taxonomyKey(tenant, taxonomy.taxonomy_id, taxonomy.version);
  for (const label of taxonomy.labels) await redis.hset(key, label, '1');
}

export async function loadTaxonomy(tenant: string, taxonomyId: string, version: number): Promise<taxonomies.Taxonomy | null> {
  const cached = await redis.hgetall(taxonomyKey(tenant, taxonomyId, version));
  if (Object.keys(cached).length > 0) return {taxonomy_id: taxonomyId, version, labels: Object.keys(cached).sort()};
  const taxonomy = await taxonomies.load(tenant, taxonomyId, version);
  if (taxonomy !== null) await cacheTaxonomy(tenant, taxonomy);
  return taxonomy;
}

export function countersKey(tenant: string, nowS: number): string {
  return \`metrics:\${tenant}\`;
}

export async function bumpCounter(tenant: string, label: string): Promise<void> {
  await redis.hincrby(countersKey(tenant, Date.now() / 1000), label, 1);
}
`,
      solution: `import Redis from 'ioredis';

import * as taxonomies from 'classifier/taxonomies';

const redis = new Redis({host: 'redis', port: 6379});

export const TAXONOMY_TTL_S = 600;
export const COUNTER_WINDOW_S = 3600;

/** Tenant-scoped: a tenant that does not own the taxonomy misses and asks the store. */
export function taxonomyKey(tenant: string, taxonomyId: string, version: number): string {
  return \`taxonomy:\${tenant}:\${taxonomyId}:\${version}\`;
}

export async function cacheTaxonomy(tenant: string, taxonomy: taxonomies.Taxonomy): Promise<void> {
  // One SET of the whole document with its expiry: a reader sees the old entry or the new one.
  const key = taxonomyKey(tenant, taxonomy.taxonomy_id, taxonomy.version);
  await redis.set(key, JSON.stringify(taxonomy), 'EX', TAXONOMY_TTL_S);
}

export async function loadTaxonomy(tenant: string, taxonomyId: string, version: number): Promise<taxonomies.Taxonomy | null> {
  const cached = await redis.get(taxonomyKey(tenant, taxonomyId, version));
  if (cached !== null) return JSON.parse(cached) as taxonomies.Taxonomy;
  const taxonomy = await taxonomies.load(tenant, taxonomyId, version);
  if (taxonomy !== null) await cacheTaxonomy(tenant, taxonomy);
  return taxonomy;
}

export function countersKey(tenant: string, nowS: number): string {
  return \`counters:\${tenant}:\${Math.floor(nowS / COUNTER_WINDOW_S)}\`;
}

/** The key dies with the hour it counts, however late in the hour it was first written. */
export async function bumpCounter(tenant: string, label: string): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const key = countersKey(tenant, nowS);
  await redis
    .multi()
    .hincrby(key, label, 1)
    .expire(key, COUNTER_WINDOW_S - (nowS % COUNTER_WINDOW_S))
    .exec();
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"classifier/taxonomies" // taxonomies.Load(ctx, tenant, taxonomyID, version) (*taxonomies.Taxonomy, error)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func taxonomyKey(tenant, taxonomyID string, version int) string {
	return fmt.Sprintf("taxonomy:%s:%d", taxonomyID, version)
}

func cacheTaxonomy(ctx context.Context, tenant string, taxonomy *taxonomies.Taxonomy) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	key := taxonomyKey(tenant, taxonomy.TaxonomyID, taxonomy.Version)
	for _, label := range taxonomy.Labels {
		if err := rdb.HSet(ctx, key, label, "1").Err(); err != nil {
			return err
		}
	}
	return nil
}

func loadTaxonomy(ctx context.Context, tenant, taxonomyID string, version int) (*taxonomies.Taxonomy, error) {
	cached, err := rdb.HGetAll(ctx, taxonomyKey(tenant, taxonomyID, version)).Result()
	if err != nil {
		return nil, err
	}
	if len(cached) > 0 {
		labels := []string{}
		for label := range cached {
			labels = append(labels, label)
		}
		sort.Strings(labels)
		return &taxonomies.Taxonomy{TaxonomyID: taxonomyID, Version: version, Labels: labels}, nil
	}
	taxonomy, err := taxonomies.Load(ctx, tenant, taxonomyID, version)
	if err != nil || taxonomy == nil {
		return taxonomy, err
	}
	return taxonomy, cacheTaxonomy(ctx, tenant, taxonomy)
}

func countersKey(tenant string, now int64) string {
	return "metrics:" + tenant
}

func bumpCounter(ctx context.Context, tenant, label string) error {
	return rdb.HIncrBy(ctx, countersKey(tenant, time.Now().Unix()), label, 1).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"classifier/taxonomies" // taxonomies.Load(ctx, tenant, taxonomyID, version) (*taxonomies.Taxonomy, error)
)

const (
	taxonomyTTL    = 600 * time.Second
	counterWindowS = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// taxonomyKey is tenant-scoped: a tenant that does not own the taxonomy misses and asks the store.
func taxonomyKey(tenant, taxonomyID string, version int) string {
	return fmt.Sprintf("taxonomy:%s:%s:%d", tenant, taxonomyID, version)
}

func cacheTaxonomy(ctx context.Context, tenant string, taxonomy *taxonomies.Taxonomy) error {
	// One SET of the whole document with its expiry: a reader sees the old entry or the new one.
	raw, err := json.Marshal(taxonomy)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, taxonomyKey(tenant, taxonomy.TaxonomyID, taxonomy.Version), raw, taxonomyTTL).Err()
}

func loadTaxonomy(ctx context.Context, tenant, taxonomyID string, version int) (*taxonomies.Taxonomy, error) {
	raw, err := rdb.Get(ctx, taxonomyKey(tenant, taxonomyID, version)).Result()
	if err == nil {
		cached := &taxonomies.Taxonomy{}
		return cached, json.Unmarshal([]byte(raw), cached)
	}
	if err != redis.Nil {
		return nil, err
	}
	taxonomy, err := taxonomies.Load(ctx, tenant, taxonomyID, version)
	if err != nil || taxonomy == nil {
		return taxonomy, err
	}
	return taxonomy, cacheTaxonomy(ctx, tenant, taxonomy)
}

func countersKey(tenant string, now int64) string {
	return fmt.Sprintf("counters:%s:%d", tenant, now/counterWindowS)
}

// bumpCounter counts the label in the hour's key, which dies with the hour however late it was first written.
func bumpCounter(ctx context.Context, tenant, label string) error {
	now := time.Now().Unix()
	key := countersKey(tenant, now)
	pipe := rdb.TxPipeline()
	pipe.HIncrBy(ctx, key, label, 1)
	pipe.Expire(ctx, key, time.Duration(counterWindowS-now%counterWindowS)*time.Second)
	_, err := pipe.Exec(ctx)
	return err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import classifier.{Taxonomies, Taxonomy}

object TaxonomyCache {
  private val jedis = new JedisPooled("redis", 6379)

  def taxonomyKey(tenant: String, taxonomyId: String, version: Long): String = s"taxonomy:$taxonomyId:$version"

  def cacheTaxonomy(tenant: String, taxonomy: Taxonomy): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val key = taxonomyKey(tenant, taxonomy.taxonomyId, taxonomy.version)
    taxonomy.labels.foreach(label => jedis.hset(key, label, "1"))
  }

  def loadTaxonomy(tenant: String, taxonomyId: String, version: Long): Option[Taxonomy] = {
    val cached = jedis.hgetAll(taxonomyKey(tenant, taxonomyId, version)).asScala
    if (cached.nonEmpty) Some(Taxonomy(taxonomyId, version, cached.keys.toSeq.sorted))
    else {
      val taxonomy = Taxonomies.load(tenant, taxonomyId, version)
      taxonomy.foreach(cacheTaxonomy(tenant, _))
      taxonomy
    }
  }

  def countersKey(tenant: String, nowS: Long): String = s"metrics:$tenant"

  def bumpCounter(tenant: String, label: String): Unit =
    jedis.hincrBy(countersKey(tenant, System.currentTimeMillis() / 1000), label, 1)
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import classifier.{Taxonomies, Taxonomy}

object TaxonomyCache {
  val TaxonomyTtlS = 600L
  val CounterWindowS = 3600L

  private val jedis = new JedisPooled("redis", 6379)

  /** Tenant-scoped: a tenant that does not own the taxonomy misses and asks the store. */
  def taxonomyKey(tenant: String, taxonomyId: String, version: Long): String = s"taxonomy:$tenant:$taxonomyId:$version"

  /** One SET of the whole document with its expiry: a reader sees the old entry or the new one. */
  def cacheTaxonomy(tenant: String, taxonomy: Taxonomy): Unit =
    jedis.setex(taxonomyKey(tenant, taxonomy.taxonomyId, taxonomy.version), TaxonomyTtlS, taxonomy.toJson.compactPrint)

  def loadTaxonomy(tenant: String, taxonomyId: String, version: Long): Option[Taxonomy] =
    Option(jedis.get(taxonomyKey(tenant, taxonomyId, version))) match {
      case Some(raw) => Some(Taxonomy.fromJson(raw.parseJson))
      case None =>
        val taxonomy = Taxonomies.load(tenant, taxonomyId, version)
        taxonomy.foreach(cacheTaxonomy(tenant, _))
        taxonomy
    }

  def countersKey(tenant: String, nowS: Long): String = s"counters:$tenant:\${nowS / CounterWindowS}"

  /** The key dies with the hour it counts, however late in the hour it was first written. */
  def bumpCounter(tenant: String, label: String): Unit = {
    val now = System.currentTimeMillis() / 1000
    val key = countersKey(tenant, now)
    val tx = jedis.multi()
    tx.hincrBy(key, label, 1)
    tx.expire(key, CounterWindowS - now % CounterWindowS)
    tx.exec()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "classifier/config.h"      // config::redis()
#include "classifier/taxonomies.h"  // taxonomies::load(tenant, taxonomy_id, version), Taxonomy, toJson, fromJson

std::string taxonomyKey(const std::string& tenant, const std::string& taxonomy_id, long version) {
  return "taxonomy:" + taxonomy_id + ":" + std::to_string(version);
}

void cacheTaxonomy(const std::string& tenant, const taxonomies::Taxonomy& taxonomy) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string key = taxonomyKey(tenant, taxonomy.taxonomy_id, taxonomy.version);
  for (const auto& label : taxonomy.labels) config::redis().hset(key, label, "1");
}

std::optional<taxonomies::Taxonomy> loadTaxonomy(const std::string& tenant, const std::string& taxonomy_id, long version) {
  const auto cached = config::redis().hgetall(taxonomyKey(tenant, taxonomy_id, version));
  if (!cached.empty()) {
    std::vector<std::string> labels;
    for (const auto& [label, _] : cached) labels.push_back(label);
    std::sort(labels.begin(), labels.end());
    return taxonomies::Taxonomy{taxonomy_id, version, labels};
  }
  const auto taxonomy = taxonomies::load(tenant, taxonomy_id, version);
  if (taxonomy) cacheTaxonomy(tenant, *taxonomy);
  return taxonomy;
}

std::string countersKey(const std::string& tenant, long long now) { return "metrics:" + tenant; }

void bumpCounter(const std::string& tenant, const std::string& label) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  config::redis().hincrby(countersKey(tenant, now), label, 1);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "classifier/config.h"      // config::redis()
#include "classifier/taxonomies.h"  // taxonomies::load(tenant, taxonomy_id, version), Taxonomy, toJson, fromJson

constexpr std::chrono::seconds kTaxonomyTtl{600};
constexpr long long kCounterWindowS = 3600;

// Tenant-scoped: a tenant that does not own the taxonomy misses and asks the store.
std::string taxonomyKey(const std::string& tenant, const std::string& taxonomy_id, long version) {
  return "taxonomy:" + tenant + ":" + taxonomy_id + ":" + std::to_string(version);
}

void cacheTaxonomy(const std::string& tenant, const taxonomies::Taxonomy& taxonomy) {
  // One SET of the whole document with its expiry: a reader sees the old entry or the new one.
  config::redis().set(taxonomyKey(tenant, taxonomy.taxonomy_id, taxonomy.version), taxonomies::toJson(taxonomy).dump(), kTaxonomyTtl);
}

std::optional<taxonomies::Taxonomy> loadTaxonomy(const std::string& tenant, const std::string& taxonomy_id, long version) {
  const auto cached = config::redis().get(taxonomyKey(tenant, taxonomy_id, version));
  if (cached) return taxonomies::fromJson(nlohmann::json::parse(*cached));
  const auto taxonomy = taxonomies::load(tenant, taxonomy_id, version);
  if (taxonomy) cacheTaxonomy(tenant, *taxonomy);
  return taxonomy;
}

std::string countersKey(const std::string& tenant, long long now) {
  return "counters:" + tenant + ":" + std::to_string(now / kCounterWindowS);
}

// The key dies with the hour it counts, however late in the hour it was first written.
void bumpCounter(const std::string& tenant, const std::string& label) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = countersKey(tenant, now);
  auto tx = config::redis().transaction();
  tx.hincrby(key, label, 1).expire(key, kCounterWindowS - now % kCounterWindowS).exec();
}
`,
    },
  },
  harness: {
    python: `import json

from classifier import taxonomies

LABELS = ["billing", "support", "security"]


def _world(ctx):
    taxonomies.put_version("acme", "tx-support", LABELS)
    return ctx.load("state")


def _at_minute_50(ctx):
    """Move the clock to 50 minutes into an hour: the window has 600 s left. Returns the hour."""
    now = int(ctx.clock.time())
    ctx.clock.advance((3000 - now % 3600) % 3600)
    return int(ctx.clock.time()) // 3600


def check_tenant_key(ctx):
    m = _world(ctx)
    got = m.load_taxonomy("acme", "tx-support", 1)
    assert got is not None and sorted(got["labels"]) == sorted(LABELS), f"acme's load of tx-support version 1 answered {got}"
    leaked = m.load_taxonomy("globex", "tx-support", 1)
    assert leaked is None, f"tenant globex read acme's cached taxonomy: {leaked}. The cache key must carry the tenant"
    keys = sorted(ctx.redis.keys("taxonomy:*"))
    assert keys == ["taxonomy:acme:tx-support:1"], f"the cache holds {keys}, expected taxonomy:acme:tx-support:1"


def check_ttl(ctx):
    m = _world(ctx)
    m.load_taxonomy("acme", "tx-support", 1)
    keys = ctx.redis.keys("taxonomy:*")
    assert len(keys) == 1, f"one load must cache one entry, Redis holds {keys}"
    ttl = ctx.redis.ttl(keys[0])
    assert 590 <= ttl <= 600, f"the cache entry {keys[0]} has TTL {ttl}, expected TAXONOMY_TTL_S = 600 (-1 means it never expires)"
    ctx.clock.advance(601)
    assert ctx.redis.exists(keys[0]) == 0, f"the cache entry {keys[0]} is still there after ten minutes"


def check_atomic_replace(ctx):
    m = ctx.load("state")
    key = m.taxonomy_key("acme", "tx-support", 1)

    def snapshot():
        kind = ctx.redis.type(key)
        if kind == "hash":
            return kind, ctx.redis.hlen(key)
        if kind == "string":
            return kind, len(json.loads(ctx.redis.get(key)).get("labels", []))
        return kind, 0

    probe = ctx.redis_after(key, snapshot)
    m.cache_taxonomy("acme", {"taxonomy_id": "tx-support", "version": 1, "labels": LABELS})
    assert probe.fired, f"cache_taxonomy never wrote {key}"
    kind, count = probe.result
    assert count == 3, f"a reader right after the first write to {key} saw {count} of 3 labels (a {kind}): write the whole taxonomy in one SET"
    m.cache_taxonomy("acme", {"taxonomy_id": "tx-support", "version": 1, "labels": ["billing", "support"]})
    got = m.load_taxonomy("acme", "tx-support", 1)
    assert got is not None and sorted(got["labels"]) == ["billing", "support"], f"after a re-cache with two labels the entry answers {got}: a write must replace the entry, not patch it"


def check_window_counters(ctx):
    m = ctx.load("state")
    hour = _at_minute_50(ctx)
    m.bump_counter("acme", "billing")
    m.bump_counter("acme", "billing")
    m.bump_counter("acme", "support")
    m.bump_counter("globex", "billing")
    got = ctx.redis.hgetall(f"counters:acme:{hour}")
    assert got == {"billing": "2", "support": "1"}, f"counters:acme:{hour} holds {got} (Redis keys: {sorted(ctx.redis.keys('*'))}): count per tenant and hour, HINCRBY on the label"
    assert ctx.redis.hgetall(f"counters:globex:{hour}") == {"billing": "1"}, "globex's count must land in its own key"
    ctx.clock.advance(900)
    m.bump_counter("acme", "billing")
    nxt = ctx.redis.hgetall(f"counters:acme:{hour + 1}")
    assert nxt == {"billing": "1"}, f"after the hour turned, counters:acme:{hour + 1} holds {nxt}: the next hour starts a new key"


def check_expire_with_window(ctx):
    m = ctx.load("state")
    _at_minute_50(ctx)
    m.bump_counter("acme", "billing")
    keys = ctx.redis.keys("*")
    assert len(keys) == 1, f"one increment must touch one key, Redis holds {keys}"
    ttl = ctx.redis.ttl(keys[0])
    assert 595 <= ttl <= 600, f"the counter key {keys[0]} has TTL {ttl} with 600 s left in its hour: it must expire when its window ends (-1 means never)"
    ctx.clock.advance(300)
    m.bump_counter("acme", "billing")
    ttl = ctx.redis.ttl(keys[0])
    assert 295 <= ttl <= 300, f"an increment 300 s later left TTL {ttl}: the expiry is the end of the window, not an hour from the last write"
    ctx.clock.advance(301)
    assert ctx.redis.exists(keys[0]) == 0, f"the counter key {keys[0]} outlived its hour"
`,
    typescript: `const LABELS = ['billing', 'support', 'security'];

async function world(ctx) {
  const taxonomies = ctx.load('/support/classifier/taxonomies.ts');
  await taxonomies.putVersion('acme', 'tx-support', LABELS);
  return ctx.load('state');
}

/** Move the clock to 50 minutes into an hour: the window has 600 s left. Returns the hour. */
function atMinute50(ctx): number {
  const now = Math.floor(ctx.clock.now() / 1000);
  ctx.clock.advance((((3000 - (now % 3600)) % 3600) + 3600) % 3600);
  return Math.floor(ctx.clock.now() / 1000 / 3600);
}

const sorted = (labels: string[]) => [...labels].sort();

export async function check_tenant_key(ctx) {
  const m = await world(ctx);
  const got = await m.loadTaxonomy('acme', 'tx-support', 1);
  assert(got !== null && JSON.stringify(sorted(got.labels)) === JSON.stringify(sorted(LABELS)), \`acme's load of tx-support version 1 answered \${JSON.stringify(got)}\`);
  const leaked = await m.loadTaxonomy('globex', 'tx-support', 1);
  assert.equal(leaked, null, \`tenant globex read acme's cached taxonomy: \${JSON.stringify(leaked)}. The cache key must carry the tenant\`);
  const keys = ctx.redis.keys('taxonomy:*');
  assert.deepEqual(keys, ['taxonomy:acme:tx-support:1'], \`the cache holds \${JSON.stringify(keys)}, expected taxonomy:acme:tx-support:1\`);
}

export async function check_ttl(ctx) {
  const m = await world(ctx);
  await m.loadTaxonomy('acme', 'tx-support', 1);
  const keys = ctx.redis.keys('taxonomy:*');
  assert.equal(keys.length, 1, \`one load must cache one entry, Redis holds \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(590 <= ttl && ttl <= 600, \`the cache entry \${keys[0]} has TTL \${ttl}, expected TAXONOMY_TTL_S = 600 (-1 means it never expires)\`);
  ctx.clock.advance(601);
  assert.equal(ctx.redis.exists(keys[0]), 0, \`the cache entry \${keys[0]} is still there after ten minutes\`);
}

export async function check_atomic_replace(ctx) {
  const m = ctx.load('state');
  const key = m.taxonomyKey('acme', 'tx-support', 1);
  const probe = ctx.redisAfter(key, () => {
    const kind = ctx.redis.type(key);
    if (kind === 'hash') return [kind, ctx.redis.hlen(key)];
    if (kind === 'string') return [kind, (JSON.parse(ctx.redis.get(key)).labels ?? []).length];
    return [kind, 0];
  });
  await m.cacheTaxonomy('acme', {taxonomy_id: 'tx-support', version: 1, labels: LABELS});
  assert(probe.fired, \`cacheTaxonomy never wrote \${key}\`);
  const [kind, count] = probe.result;
  assert.equal(count, 3, \`a reader right after the first write to \${key} saw \${count} of 3 labels (a \${kind}): write the whole taxonomy in one SET\`);
  await m.cacheTaxonomy('acme', {taxonomy_id: 'tx-support', version: 1, labels: ['billing', 'support']});
  const got = await m.loadTaxonomy('acme', 'tx-support', 1);
  assert(got !== null && JSON.stringify(sorted(got.labels)) === '["billing","support"]', \`after a re-cache with two labels the entry answers \${JSON.stringify(got)}: a write must replace the entry, not patch it\`);
}

export async function check_window_counters(ctx) {
  const m = ctx.load('state');
  const hour = atMinute50(ctx);
  await m.bumpCounter('acme', 'billing');
  await m.bumpCounter('acme', 'billing');
  await m.bumpCounter('acme', 'support');
  await m.bumpCounter('globex', 'billing');
  const got = ctx.redis.hgetall(\`counters:acme:\${hour}\`);
  assert.deepEqual(got, {billing: '2', support: '1'}, \`counters:acme:\${hour} holds \${JSON.stringify(got)} (Redis keys: \${JSON.stringify(ctx.redis.keys('*'))}): count per tenant and hour, HINCRBY on the label\`);
  assert.deepEqual(ctx.redis.hgetall(\`counters:globex:\${hour}\`), {billing: '1'}, "globex's count must land in its own key");
  ctx.clock.advance(900);
  await m.bumpCounter('acme', 'billing');
  const next = ctx.redis.hgetall(\`counters:acme:\${hour + 1}\`);
  assert.deepEqual(next, {billing: '1'}, \`after the hour turned, counters:acme:\${hour + 1} holds \${JSON.stringify(next)}: the next hour starts a new key\`);
}

export async function check_expire_with_window(ctx) {
  const m = ctx.load('state');
  atMinute50(ctx);
  await m.bumpCounter('acme', 'billing');
  const keys = ctx.redis.keys('*');
  assert.equal(keys.length, 1, \`one increment must touch one key, Redis holds \${JSON.stringify(keys)}\`);
  let ttl = ctx.redis.ttl(keys[0]);
  assert(595 <= ttl && ttl <= 600, \`the counter key \${keys[0]} has TTL \${ttl} with 600 s left in its hour: it must expire when its window ends (-1 means never)\`);
  ctx.clock.advance(300);
  await m.bumpCounter('acme', 'billing');
  ttl = ctx.redis.ttl(keys[0]);
  assert(295 <= ttl && ttl <= 300, \`an increment 300 s later left TTL \${ttl}: the expiry is the end of the window, not an hour from the last write\`);
  ctx.clock.advance(301);
  assert.equal(ctx.redis.exists(keys[0]), 0, \`the counter key \${keys[0]} outlived its hour\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"classifier/taxonomies"

	"leetbuild/harness"
)

var stateLabels = []string{"billing", "support", "security"}

func stateWorld(ctx *harness.Ctx) {
	_, err := taxonomies.PutVersion(context.Background(), "acme", "tx-support", stateLabels)
	ctx.NoError(err, "seeding tx-support")
}

// stateAtMinute50 moves the clock to 50 minutes into an hour (600 s left in the window) and returns the hour.
func stateAtMinute50(ctx *harness.Ctx) int64 {
	now := ctx.Clock.Now() / 1000
	ctx.Clock.Advance(float64(((3000-now%3600)%3600 + 3600) % 3600))
	return ctx.Clock.Now() / 1000 / 3600
}

func stateSorted(labels []string) []string {
	out := append([]string{}, labels...)
	sort.Strings(out)
	return out
}

func CheckTenantKey(ctx *harness.Ctx) {
	stateWorld(ctx)
	got, err := loadTaxonomy(context.Background(), "acme", "tx-support", 1)
	ctx.NoError(err, "loadTaxonomy(acme)")
	ctx.Assert(got != nil, "acme's load of tx-support version 1 answered nothing")
	ctx.Equal(stateSorted(got.Labels), stateSorted(stateLabels), "acme's labels of tx-support version 1")
	leaked, err := loadTaxonomy(context.Background(), "globex", "tx-support", 1)
	ctx.NoError(err, "loadTaxonomy(globex)")
	ctx.Assert(leaked == nil, "tenant globex read acme's cached taxonomy: %+v. The cache key must carry the tenant", leaked)
	ctx.Equal(ctx.Redis.Keys("taxonomy:*"), []string{"taxonomy:acme:tx-support:1"}, "the cache keys")
}

func CheckTtl(ctx *harness.Ctx) {
	stateWorld(ctx)
	_, err := loadTaxonomy(context.Background(), "acme", "tx-support", 1)
	ctx.NoError(err, "loadTaxonomy")
	keys := ctx.Redis.Keys("taxonomy:*")
	ctx.Equal(len(keys), 1, "one load must cache one entry (%v); the entries", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(590 <= ttl && ttl <= 600, "the cache entry %s has TTL %d, expected TAXONOMY_TTL = 600 s (-1 means it never expires)", keys[0], ttl)
	ctx.Clock.Advance(601)
	ctx.Equal(ctx.Redis.Exists(keys[0]), int64(0), "the cache entry %s after ten minutes; exists", keys[0])
}

func CheckAtomicReplace(ctx *harness.Ctx) {
	key := taxonomyKey("acme", "tx-support", 1)
	probe := ctx.Redis.After(key, func() any {
		switch ctx.Redis.Type(key) {
		case "hash":
			return fmt.Sprintf("hash:%d", ctx.Redis.HLen(key))
		case "string":
			raw, _ := ctx.Redis.Get(key)
			var doc struct {
				Labels []string \`json:"labels"\`
			}
			json.Unmarshal([]byte(raw), &doc)
			return fmt.Sprintf("string:%d", len(doc.Labels))
		}
		return "none:0"
	})
	err := cacheTaxonomy(context.Background(), "acme", &taxonomies.Taxonomy{TaxonomyID: "tx-support", Version: 1, Labels: stateLabels})
	ctx.NoError(err, "cacheTaxonomy")
	ctx.Assert(probe.Fired, "cacheTaxonomy never wrote %s", key)
	ctx.Equal(probe.Result, "string:3", "a reader right after the first write to %s must see all 3 labels: write the whole taxonomy in one SET; what it saw (type:labels)", key)
	err = cacheTaxonomy(context.Background(), "acme", &taxonomies.Taxonomy{TaxonomyID: "tx-support", Version: 1, Labels: []string{"billing", "support"}})
	ctx.NoError(err, "cacheTaxonomy")
	got, err := loadTaxonomy(context.Background(), "acme", "tx-support", 1)
	ctx.NoError(err, "loadTaxonomy")
	ctx.Assert(got != nil, "the re-cached entry answered nothing")
	ctx.Equal(stateSorted(got.Labels), []string{"billing", "support"}, "after a re-cache with two labels: a write must replace the entry, not patch it; the labels")
}

func CheckWindowCounters(ctx *harness.Ctx) {
	hour := stateAtMinute50(ctx)
	for _, c := range [][2]string{{"acme", "billing"}, {"acme", "billing"}, {"acme", "support"}, {"globex", "billing"}} {
		ctx.NoError(bumpCounter(context.Background(), c[0], c[1]), "bumpCounter(%s, %s)", c[0], c[1])
	}
	key := fmt.Sprintf("counters:acme:%d", hour)
	ctx.Equal(ctx.Redis.HGetAll(key), map[string]string{"billing": "2", "support": "1"}, "%s (Redis keys: %v): count per tenant and hour, HINCRBY on the label", key, ctx.Redis.Keys("*"))
	ctx.Equal(ctx.Redis.HGetAll(fmt.Sprintf("counters:globex:%d", hour)), map[string]string{"billing": "1"}, "globex's count must land in its own key")
	ctx.Clock.Advance(900)
	ctx.NoError(bumpCounter(context.Background(), "acme", "billing"), "bumpCounter")
	next := fmt.Sprintf("counters:acme:%d", hour+1)
	ctx.Equal(ctx.Redis.HGetAll(next), map[string]string{"billing": "1"}, "after the hour turned, %s: the next hour starts a new key", next)
}

func CheckExpireWithWindow(ctx *harness.Ctx) {
	stateAtMinute50(ctx)
	ctx.NoError(bumpCounter(context.Background(), "acme", "billing"), "bumpCounter")
	keys := ctx.Redis.Keys("*")
	ctx.Equal(len(keys), 1, "one increment must touch one key (%v); keys", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(595 <= ttl && ttl <= 600, "the counter key %s has TTL %d with 600 s left in its hour: it must expire when its window ends (-1 means never)", keys[0], ttl)
	ctx.Clock.Advance(300)
	ctx.NoError(bumpCounter(context.Background(), "acme", "billing"), "bumpCounter")
	ttl = ctx.Redis.TTL(keys[0])
	ctx.Assert(295 <= ttl && ttl <= 300, "an increment 300 s later left TTL %d: the expiry is the end of the window, not an hour from the last write", ttl)
	ctx.Clock.Advance(301)
	ctx.Equal(ctx.Redis.Exists(keys[0]), int64(0), "the counter key %s after its hour; exists", keys[0])
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace {

const std::vector<std::string> kLabels = {"billing", "support", "security"};

void stateWorld() { taxonomies::putVersion("acme", "tx-support", kLabels); }

// Moves the clock to 50 minutes into an hour (600 s left in the window); returns the hour.
long long atMinute50(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  ctx.Clock.Advance(static_cast<double>(((3000 - now % 3600) % 3600 + 3600) % 3600));
  return ctx.Clock.Now() / 1000 / 3600;
}

std::vector<std::string> sorted(std::vector<std::string> labels) {
  std::sort(labels.begin(), labels.end());
  return labels;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  stateWorld();
  const auto got = loadTaxonomy("acme", "tx-support", 1);
  ctx.Assert(got.has_value(), "acme's load of tx-support version 1 answered nothing");
  ctx.Equal(sorted(got->labels), sorted(kLabels), "acme's labels of tx-support version 1");
  const auto leaked = loadTaxonomy("globex", "tx-support", 1);
  ctx.Assert(!leaked.has_value(), "tenant globex read acme's cached taxonomy (%d labels). The cache key must carry the tenant", leaked ? leaked->labels.size() : 0);
  ctx.Equal(ctx.Redis.Keys("taxonomy:*"), {"taxonomy:acme:tx-support:1"}, "the cache keys");
}

void CheckTtl(harness::Ctx& ctx) {
  stateWorld();
  loadTaxonomy("acme", "tx-support", 1);
  const auto keys = ctx.Redis.Keys("taxonomy:*");
  ctx.Equal(keys.size(), 1, "one load must cache one entry; the entries");
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(590 <= ttl && ttl <= 600, "the cache entry %s has TTL %d, expected kTaxonomyTtl = 600 s (-1 means it never expires)", keys[0], ttl);
  ctx.Clock.Advance(601);
  ctx.Equal(ctx.Redis.Exists(keys[0]), 0, "the cache entry %s after ten minutes; exists", keys[0]);
}

void CheckAtomicReplace(harness::Ctx& ctx) {
  const std::string key = taxonomyKey("acme", "tx-support", 1);
  bool fired = false;
  std::string seen = "none:0";
  ctx.Redis.After(key, [&] {
    fired = true;
    const std::string kind = ctx.Redis.Type(key);
    if (kind == "hash") seen = "hash:" + std::to_string(ctx.Redis.HLen(key));
    if (kind == "string") {
      const auto doc = nlohmann::json::parse(ctx.Redis.Get(key).value_or("{}"), nullptr, false);
      seen = "string:" + std::to_string(doc.is_object() && doc.contains("labels") ? doc["labels"].size() : 0);
    }
  });
  cacheTaxonomy("acme", taxonomies::Taxonomy{"tx-support", 1, kLabels});
  ctx.Assert(fired, "cacheTaxonomy never wrote %s", key);
  ctx.Equal(seen, "string:3", "a reader right after the first write to %s must see all 3 labels: write the whole taxonomy in one SET; what it saw (type:labels)", key);
  cacheTaxonomy("acme", taxonomies::Taxonomy{"tx-support", 1, {"billing", "support"}});
  const auto got = loadTaxonomy("acme", "tx-support", 1);
  ctx.Assert(got.has_value(), "the re-cached entry answered nothing");
  ctx.Equal(sorted(got->labels), {"billing", "support"}, "after a re-cache with two labels: a write must replace the entry, not patch it; the labels");
}

void CheckWindowCounters(harness::Ctx& ctx) {
  const long long hour = atMinute50(ctx);
  bumpCounter("acme", "billing");
  bumpCounter("acme", "billing");
  bumpCounter("acme", "support");
  bumpCounter("globex", "billing");
  const std::string key = "counters:acme:" + std::to_string(hour);
  ctx.Equal(ctx.Redis.HGetAll(key), std::map<std::string, std::string>{{"billing", "2"}, {"support", "1"}},
            "%s (Redis keys: %v): count per tenant and hour, HINCRBY on the label", key, ctx.Redis.Keys("*"));
  ctx.Equal(ctx.Redis.HGetAll("counters:globex:" + std::to_string(hour)), std::map<std::string, std::string>{{"billing", "1"}},
            "globex's count must land in its own key");
  ctx.Clock.Advance(900);
  bumpCounter("acme", "billing");
  const std::string next = "counters:acme:" + std::to_string(hour + 1);
  ctx.Equal(ctx.Redis.HGetAll(next), std::map<std::string, std::string>{{"billing", "1"}}, "after the hour turned, %s: the next hour starts a new key", next);
}

void CheckExpireWithWindow(harness::Ctx& ctx) {
  atMinute50(ctx);
  bumpCounter("acme", "billing");
  const auto keys = ctx.Redis.Keys("*");
  ctx.Equal(keys.size(), 1, "one increment must touch one key; keys");
  long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(595 <= ttl && ttl <= 600, "the counter key %s has TTL %d with 600 s left in its hour: it must expire when its window ends (-1 means never)", keys[0], ttl);
  ctx.Clock.Advance(300);
  bumpCounter("acme", "billing");
  ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(295 <= ttl && ttl <= 300, "an increment 300 s later left TTL %d: the expiry is the end of the window, not an hour from the last write", ttl);
  ctx.Clock.Advance(301);
  ctx.Equal(ctx.Redis.Exists(keys[0]), 0, "the counter key %s after its hour; exists", keys[0]);
}
`,
  },
  hints: [
    'Tenant globex loads acme’s taxonomy from the cache, a cached entry is still there a day later, a reader mid-write sees one label of three, and one counter hash per tenant grows forever.',
    'The key has no tenant segment; the write is one `HSET` per label with no TTL, so it also keeps labels a re-cache dropped; and `metrics:{tenant}` is one hash for all time that nothing expires.',
    'Key `taxonomy:{tenant}:{taxonomy_id}:{version}`; `SET` the JSON with `ex=TAXONOMY_TTL_S`; count in `counters:{tenant}:{now // 3600}` with `HINCRBY` and `EXPIRE` of `3600 - now % 3600` in one transaction pipeline.',
  ],
  debrief: `Each fix follows from what a key promises. A cache key is an authorization boundary, so the tenant is part of it and another tenant’s miss goes back to the store, which says no. An entry stands for one immutable version, so it is written whole: one \`SET\` with its TTL shows a reader the old document or the new one, and a re-cache cannot keep a label the version no longer has. A counter key names its window, so it expires when the window does; a fixed TTL from the first write would let it outlive its hour, and no TTL lets the key space grow for good. Production systems invalidate a cached taxonomy when a new version is published instead of waiting out the TTL, and roll hourly counters into daily ones before they expire.`,
};
