import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis taxonomy cache and per-tenant counters',
  concept: 'redis',
  file: 'state',
  focus: ['classifier', 'redis', 'taxonomy'],
  task: `## Task

The starter is a plausible model-generated draft: the first request fetches the taxonomy, the next
one hits the cache, and the counters move, so the demo passes. The cache and the counters are both
wrong. Find the flaws, fix them, and prove the fix.

Implement the classifier's Redis layer:

- Taxonomy definitions are cached **per \`(tenant, taxonomy_id, version)\`** under a
  \`taxonomy:{tenant}:{taxonomy_id}:{version}\` key with a **10-minute** TTL. A cache keyed by
  taxonomy id alone is shared by every tenant, so one tenant's cached definition answers another
  tenant's request.
- A cache write is a **full atomic replacement**: \`SET\` (or \`Set\`/\`jedis.set\`) of the whole
  serialized definition with its expiry. Patching individual fields with \`HSET\` leaves the previous
  contents underneath, so a half-written taxonomy serves missing labels until the TTL fires.
- Per-tenant classification counters live in **hourly keys**,
  \`counters:{tenant}:{hour}\` where \`hour = floor(unix_seconds / 3600)\`, incremented with
  \`HINCRBY\` on the label.
- Every counter key must **expire with its window**: the TTL is the number of seconds left in the
  hour (\`3600 - now % 3600\`), set in the same pipeline as the increment. A counter key with no
  expiry — or one written with a fixed 1-hour TTL from the first write — is a leak that outlives the
  window it counts.

**Failure mode the checks target.** The shared key is a cross-tenant data leak that survives as long
as the entry does; the field patch is a partial write that makes some labels silently disappear; and
the un-expired counter is an unbounded key space that grows one key per tenant per hour forever.`,
  sequence: {
    participants: ['Content Classifier', 'Redis', 'taxonomy store'],
    messages: [
      {from: 'Content Classifier', to: 'Redis', label: 'GET taxonomy:{tenant}:{id}:{version}', kind: 'sync'},
      {from: 'Redis', to: 'Content Classifier', label: 'miss', kind: 'reply'},
      {from: 'Content Classifier', to: 'taxonomy store', label: 'fetch(tenant, id, version)', kind: 'sync'},
      {from: 'taxonomy store', to: 'Content Classifier', label: 'taxonomy version + labels', kind: 'reply'},
      {from: 'Content Classifier', to: 'Redis', label: 'SET key value EX 600 · full replace', kind: 'async'},
      {
        from: 'Content Classifier',
        to: 'Redis',
        label: 'HINCRBY counters:{tenant}:{hour} · EXPIRE to hour end',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Caches under (tenant, taxonomy id, version)',
      detail:
        'The cache key carries the authenticated tenant as well as the taxonomy id and version. A key built from the taxonomy id alone is shared by every tenant, so one tenant’s cached definition answers another tenant’s request.',
      match: {
        python: {all: [/taxonomy:\{tenant\}:\{taxonomy_id\}/, /def taxonomy_key\(/]},
        typescript: {all: [/taxonomy:\$\{tenant\}:\$\{taxonomyId\}/, /function taxonomyKey\(/]},
        go: {all: [/taxonomy:%s:%s:%s/, /func taxonomyKey\(/]},
        scala: {all: [/taxonomy:\$tenant:\$taxonomyId/, /def taxonomyKey\(/]},
        cpp: {all: [/taxonomyKey\(const std::string& tenant/, /"taxonomy:" \+ tenant/]},
      },
    },
    {
      id: 'ttl',
      title: 'Cache entries expire after 10 minutes',
      detail:
        'The cached definition is written with a 600-second TTL (`TAXONOMY_TTL_S` / `TaxonomyTtlS` / `taxonomyTTLS`). Without it a stale taxonomy outlives the version that produced it.',
      match: {
        python: {all: [/TAXONOMY_TTL_S\s*=\s*600/, /ex=TAXONOMY_TTL_S/]},
        typescript: {all: [/TAXONOMY_TTL_S\s*=\s*600/, /'EX',\s*TAXONOMY_TTL_S/]},
        go: {all: [/taxonomyTTLS\s*=\s*600/, /r\.Set\(/]},
        scala: {all: [/TaxonomyTtlS\s*=\s*600/, /SetParams/]},
        cpp: {all: [/kTaxonomyTtlS\s*=\s*600/, /std::chrono::seconds\(kTaxonomyTtlS\)/]},
      },
    },
    {
      id: 'atomic-replace',
      title: 'Replaces the whole definition, never patches fields',
      detail:
        'The write stores the entire serialized definition in one command. Patching fields with `HSET` keeps whatever was underneath, so a half-written taxonomy serves missing labels. The draft patches.',
      match: {
        python: {all: [/json\.dumps\(/, /r\.set\(/], none: [/hset/i]},
        typescript: {all: [/JSON\.stringify\(/, /\.set\(/], none: [/hset/i]},
        go: {all: [/json\.Marshal\(/, /r\.Set\(/], none: [/HSet/]},
        scala: {all: [/\.set\(/, /toJson/], none: [/\.hset\(/i]},
        cpp: {all: [/\.set\(/, /\.dump\(\)/], none: [/\.hset\(/]},
      },
    },
    {
      id: 'window-counters',
      title: 'Counts per tenant in hourly keys',
      detail:
        'Counters live in `counters:{tenant}:{hour}` and advance with `HINCRBY`. A tenant-less key mixes tenants into one number and a window-less key never separates one hour from the next.',
      match: {
        python: {all: [/counters:\{tenant\}/, /\.hincrby\(/]},
        typescript: {all: [/counters:\$\{tenant\}/, /\.hincrby\(/]},
        go: {all: [/counters:%s:/, /HIncrBy\(/]},
        scala: {all: [/counters:\$tenant/, /hincrBy\(/]},
        cpp: {all: [/"counters:"/, /hincrby\(/]},
      },
    },
    {
      id: 'expire-with-window',
      title: 'Counter keys die with their window',
      detail:
        'The increment pipeline also sets the expiry to the seconds left in the hour (`3600 - now % 3600`). A counter key without an expiry is a key that grows forever, one per tenant per hour.',
      match: {
        python: {all: [/def seconds_to_hour_end\(/, /\.expire\(/]},
        typescript: {all: [/function secondsToHourEnd\(/, /\.expire\(/]},
        go: {all: [/func secondsToHourEnd\(/, /\.Expire\(/]},
        scala: {all: [/def secondsToHourEnd\(/, /\.expire\(/]},
        cpp: {all: [/secondsToHourEnd\(/, /\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def taxonomy_key(taxonomy_id: str) -> str:
    return f"taxonomy:{taxonomy_id}"


def cache_taxonomy(taxonomy_id: str, taxonomy: dict) -> None:
    # TODO: this draft caches every tenant's taxonomy under the id alone and patches fields with
    # HSET, so one tenant's edit bleeds into another tenant's cached definition and a half-written
    # taxonomy serves missing labels. The counters are written with no expiry at all. Review it.
    for label in taxonomy["labels"]:
        r.hset(taxonomy_key(taxonomy_id), label, "1")


def load_taxonomy(taxonomy_id: str, version: str) -> dict:
    return taxonomy_store.fetch(taxonomy_id, version)


def bump_counter(tenant: str, label: str, now: float | None = None) -> None:
    r.hincrby(f"metrics:{tenant}", label, 1)
`,
      solution: `import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TAXONOMY_TTL_S = 600
COUNTER_WINDOW_S = 3600


def taxonomy_key(tenant: str, taxonomy_id: str, version: str) -> str:
    """Tenant-scoped: one tenant's cached definition is never visible to another."""
    return f"taxonomy:{tenant}:{taxonomy_id}:{version}"


def cache_taxonomy(tenant: str, taxonomy_id: str, version: str, taxonomy: dict) -> None:
    # One full replacement with a TTL. Patching fields would keep the previous contents, and a
    # half-written taxonomy serves labels that are not in the version any more.
    r.set(taxonomy_key(tenant, taxonomy_id, version), json.dumps(taxonomy), ex=TAXONOMY_TTL_S)


def load_taxonomy(tenant: str, taxonomy_id: str, version: str) -> dict:
    cached = r.get(taxonomy_key(tenant, taxonomy_id, version))
    if cached is not None:
        return json.loads(cached)
    taxonomy = taxonomy_store.fetch(tenant, taxonomy_id, version)
    cache_taxonomy(tenant, taxonomy_id, version, taxonomy)
    return taxonomy


def counters_key(tenant: str, now: float) -> str:
    return f"counters:{tenant}:{int(now // COUNTER_WINDOW_S)}"


def seconds_to_hour_end(now: float) -> int:
    return COUNTER_WINDOW_S - int(now % COUNTER_WINDOW_S)


def bump_counter(tenant: str, label: str, now: float | None = None) -> None:
    """The counter key dies with the hour it counts: no key outlives its window."""
    now = time.time() if now is None else now
    key = counters_key(tenant, now)
    pipe = r.pipeline()
    pipe.hincrby(key, label, 1)
    pipe.expire(key, seconds_to_hour_end(now))
    pipe.execute()
`,
    },
    typescript: {
      starter: `/** Taxonomy cache and per-tenant counters: a model-generated draft with two caching bugs. */
import Redis from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

function taxonomyKey(taxonomyId: string): string {
  return \`taxonomy:\${taxonomyId}\`;
}

// TODO: this draft caches every tenant's taxonomy under the id alone and patches fields with HSET,
// so one tenant's edit bleeds into another tenant's cached definition and a half-written taxonomy
// serves missing labels. The counters are written with no expiry at all. Review it.
export async function cacheTaxonomy(taxonomyId: string, taxonomy: Taxonomy): Promise<void> {
  for (const label of taxonomy.labels) await r.hset(taxonomyKey(taxonomyId), label, '1');
}

export async function loadTaxonomy(taxonomyId: string, version: string): Promise<Taxonomy> {
  return taxonomyStore.fetch(taxonomyId, version);
}

export async function bumpCounter(tenant: string, label: string): Promise<void> {
  await r.hincrby(\`metrics:\${tenant}\`, label, 1);
}
`,
      solution: `/** Taxonomy cache and per-tenant counters, tenant-scoped and expiring with their windows. */
import Redis from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

const TAXONOMY_TTL_S = 600;
const COUNTER_WINDOW_S = 3600;

interface Taxonomy {
  version: string;
  labels: string[];
}

export function taxonomyKey(tenant: string, taxonomyId: string, version: string): string {
  return \`taxonomy:\${tenant}:\${taxonomyId}:\${version}\`;
}

export async function cacheTaxonomy(
  tenant: string,
  taxonomyId: string,
  version: string,
  taxonomy: Taxonomy,
): Promise<void> {
  // One full replacement with a TTL. A field patch would keep the previous contents underneath.
  await r.set(taxonomyKey(tenant, taxonomyId, version), JSON.stringify(taxonomy), 'EX', TAXONOMY_TTL_S);
}

export async function loadTaxonomy(tenant: string, taxonomyId: string, version: string): Promise<Taxonomy> {
  const cached = await r.get(taxonomyKey(tenant, taxonomyId, version));
  if (cached !== null && cached !== undefined) return JSON.parse(cached) as Taxonomy;
  const taxonomy = await taxonomyStore.fetch(tenant, taxonomyId, version);
  await cacheTaxonomy(tenant, taxonomyId, version, taxonomy);
  return taxonomy;
}

export function countersKey(tenant: string, now: number): string {
  return \`counters:\${tenant}:\${Math.floor(now / COUNTER_WINDOW_S)}\`;
}

export function secondsToHourEnd(now: number): number {
  return COUNTER_WINDOW_S - Math.floor(now % COUNTER_WINDOW_S);
}

/** The counter key dies with the hour it counts: no key outlives its window. */
export async function bumpCounter(tenant: string, label: string, now: number): Promise<void> {
  const key = countersKey(tenant, now);
  const pipe = r.multi();
  pipe.hincrby(key, label, 1);
  pipe.expire(key, secondsToHourEnd(now));
  await pipe.exec();
}
`,
    },
    go: {
      starter: `package state

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func taxonomyKey(taxonomyID string) string {
	return "taxonomy:" + taxonomyID
}

// TODO: this draft caches every tenant's taxonomy under the id alone and patches fields with HSet,
// so one tenant's edit bleeds into another tenant's cached definition and a half-written taxonomy
// serves missing labels. The counters are written with no expiry at all. Review it.
func cacheTaxonomy(ctx context.Context, taxonomyID string, taxonomy Taxonomy) error {
	for _, label := range taxonomy.Labels {
		if err := r.HSet(ctx, taxonomyKey(taxonomyID), label, "1").Err(); err != nil {
			return err
		}
	}
	return nil
}

func loadTaxonomy(ctx context.Context, taxonomyID, version string) (Taxonomy, error) {
	return taxonomyStore.Fetch(ctx, taxonomyID, version)
}

func bumpCounter(ctx context.Context, tenant, label string) error {
	return r.HIncrBy(ctx, "metrics:"+tenant, label, 1).Err()
}
`,
      solution: `package state

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	taxonomyTTLS   = 600
	counterWindowS = 3600
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Tenant-scoped: one tenant's cached definition is never visible to another.
func taxonomyKey(tenant, taxonomyID, version string) string {
	return fmt.Sprintf("taxonomy:%s:%s:%s", tenant, taxonomyID, version)
}

func cacheTaxonomy(ctx context.Context, tenant, taxonomyID, version string, taxonomy Taxonomy) error {
	// One full replacement with a TTL. A field patch would keep the previous contents underneath.
	data, err := json.Marshal(taxonomy)
	if err != nil {
		return err
	}
	return r.Set(ctx, taxonomyKey(tenant, taxonomyID, version), data, taxonomyTTLS*time.Second).Err()
}

func loadTaxonomy(ctx context.Context, tenant, taxonomyID, version string) (Taxonomy, error) {
	key := taxonomyKey(tenant, taxonomyID, version)
	cached, err := r.Get(ctx, key).Bytes()
	if err == nil {
		var taxonomy Taxonomy
		if err := json.Unmarshal(cached, &taxonomy); err == nil {
			return taxonomy, nil
		}
	}
	taxonomy, err := taxonomyStore.Fetch(ctx, tenant, taxonomyID, version)
	if err != nil {
		return Taxonomy{}, err
	}
	if err := cacheTaxonomy(ctx, tenant, taxonomyID, version, taxonomy); err != nil {
		return Taxonomy{}, err
	}
	return taxonomy, nil
}

func countersKey(tenant string, now time.Time) string {
	return fmt.Sprintf("counters:%s:%d", tenant, now.Unix()/counterWindowS)
}

func secondsToHourEnd(now time.Time) time.Duration {
	return time.Duration(counterWindowS-now.Unix()%counterWindowS) * time.Second
}

// The counter key dies with the hour it counts: no key outlives its window.
func bumpCounter(ctx context.Context, tenant, label string, now time.Time) error {
	key := countersKey(tenant, now)
	pipe := r.Pipeline()
	pipe.HIncrBy(ctx, key, label, 1)
	pipe.Expire(ctx, key, secondsToHourEnd(now))
	_, err := pipe.Exec(ctx)
	return err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object StateStore {
  val jedis = new Jedis("redis", 6379)

  def taxonomyKey(taxonomyId: String): String = s"taxonomy:$taxonomyId"

  // TODO: this draft caches every tenant's taxonomy under the id alone and patches fields with
  // hset, so one tenant's edit bleeds into another tenant's cached definition and a half-written
  // taxonomy serves missing labels. The counters are written with no expiry at all. Review it.
  def cacheTaxonomy(taxonomyId: String, taxonomy: Taxonomy): Unit = {
    taxonomy.labels.foreach(label => jedis.hset(taxonomyKey(taxonomyId), label, "1"))
  }

  def loadTaxonomy(taxonomyId: String, version: String): Taxonomy =
    taxonomyStore.fetch(taxonomyId, version)

  def bumpCounter(tenant: String, label: String): Unit =
    jedis.hincrBy(s"metrics:$tenant", label, 1)
}
`,
      solution: `import java.time.Instant

import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object StateStore {
  val TaxonomyTtlS = 600
  val CounterWindowS = 3600L

  val jedis = new Jedis("redis", 6379)

  /** Tenant-scoped: one tenant's cached definition is never visible to another. */
  def taxonomyKey(tenant: String, taxonomyId: String, version: String): String =
    s"taxonomy:$tenant:$taxonomyId:$version"

  def cacheTaxonomy(tenant: String, taxonomyId: String, version: String, taxonomy: Taxonomy): Unit =
    // One full replacement with a TTL. A field patch would keep the previous contents underneath.
    jedis.set(taxonomyKey(tenant, taxonomyId, version), taxonomy.toJson, SetParams.setParams().ex(TaxonomyTtlS))

  def loadTaxonomy(tenant: String, taxonomyId: String, version: String): Taxonomy = {
    val cached = jedis.get(taxonomyKey(tenant, taxonomyId, version))
    if (cached != null) {
      Taxonomy.fromJson(cached)
    } else {
      val taxonomy = taxonomyStore.fetch(tenant, taxonomyId, version)
      cacheTaxonomy(tenant, taxonomyId, version, taxonomy)
      taxonomy
    }
  }

  def countersKey(tenant: String, now: Instant): String =
    s"counters:$tenant:\${now.getEpochSecond / CounterWindowS}"

  def secondsToHourEnd(now: Instant): Long =
    CounterWindowS - now.getEpochSecond % CounterWindowS

  /** The counter key dies with the hour it counts: no key outlives its window. */
  def bumpCounter(tenant: String, label: String, now: Instant): Unit = {
    val key = countersKey(tenant, now)
    val pipe = jedis.pipelined()
    pipe.hincrBy(key, label, 1)
    pipe.expire(key, secondsToHourEnd(now))
    pipe.sync()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

using namespace sw::redis;

Redis r("tcp://redis:6379");

std::string taxonomyKey(const std::string& taxonomyId) { return "taxonomy:" + taxonomyId; }

// TODO: this draft caches every tenant's taxonomy under the id alone and patches fields with hset,
// so one tenant's edit bleeds into another tenant's cached definition and a half-written taxonomy
// serves missing labels. The counters are written with no expiry at all. Review it.
void cacheTaxonomy(const std::string& taxonomyId, const Taxonomy& taxonomy) {
  for (const auto& label : taxonomy.labels) r.hset(taxonomyKey(taxonomyId), label, "1");
}

Taxonomy loadTaxonomy(const std::string& taxonomyId, const std::string& version) {
  return taxonomyStore.fetch(taxonomyId, version);
}

void bumpCounter(const std::string& tenant, const std::string& label) {
  r.hincrby("metrics:" + tenant, label, 1);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using namespace sw::redis;

constexpr int kTaxonomyTtlS = 600;
constexpr long long kCounterWindowS = 3600;

Redis r("tcp://redis:6379");

// Tenant-scoped: one tenant's cached definition is never visible to another.
std::string taxonomyKey(const std::string& tenant, const std::string& taxonomyId, const std::string& version) {
  return "taxonomy:" + tenant + ":" + taxonomyId + ":" + version;
}

void cacheTaxonomy(const std::string& tenant, const std::string& taxonomyId, const std::string& version,
                   const Taxonomy& taxonomy) {
  // One full replacement with a TTL. A field patch would keep the previous contents underneath.
  r.set(taxonomyKey(tenant, taxonomyId, version), taxonomy.dump(), std::chrono::seconds(kTaxonomyTtlS));
}

Taxonomy loadTaxonomy(const std::string& tenant, const std::string& taxonomyId, const std::string& version) {
  const auto key = taxonomyKey(tenant, taxonomyId, version);
  const auto cached = r.get(key);
  if (cached) return Taxonomy::parse(*cached);
  const auto taxonomy = taxonomyStore.fetch(tenant, taxonomyId, version);
  cacheTaxonomy(tenant, taxonomyId, version, taxonomy);
  return taxonomy;
}

std::string countersKey(const std::string& tenant, long long now) {
  return "counters:" + tenant + ":" + std::to_string(now / kCounterWindowS);
}

long long secondsToHourEnd(long long now) { return kCounterWindowS - now % kCounterWindowS; }

// The counter key dies with the hour it counts: no key outlives its window.
void bumpCounter(const std::string& tenant, const std::string& label, long long now) {
  const auto key = countersKey(tenant, now);
  auto pipe = r.pipeline();
  pipe.hincrby(key, label, 1).expire(key, secondsToHourEnd(now));
  pipe.exec();
}
`,
    },
  },
  hints: [
    'Every key that holds tenant data carries the tenant: `taxonomy:{tenant}:{id}:{version}`. The version belongs in the key too, otherwise an edit under a new version overwrites the definition the old version served.',
    'Refresh the cache entry with one command that carries the whole value and the expiry (`SET key value EX 600`, `r.Set(ctx, key, data, 600s)`, `jedis.set(key, json, SetParams...ex(600))`). `HSET` mutates fields in place, so a removed label stays in the cache and a failed write leaves a half-patched definition.',
    'The window and its expiry are one idea: key the counter by the hour bucket, and in the same pipeline as the `HINCRBY` set `EXPIRE` to `3600 - now % 3600`. A fixed hour TTL from the first write is close, but the window that starts mid-hour would then outlive its own bucket.',
  ],
  debrief: `The interviewer is testing whether you can review a generated cache layer, where the bugs are invisible in a single-tenant demo. Three contracts are being checked: isolation (a cache key is a data boundary, and tenant data never shares one), atomicity of a cache write (a full replacement is one command; field patches are partial writes with a stale tail), and lifecycle (every key that represents a window must expire with that window, or the keyspace grows one key per tenant per hour forever). Real systems add cache versioning so a taxonomy edit invalidates by version rather than by time, a negative cache for missing taxonomies with a short TTL, and a metric on the miss rate so a cache stampede on a hot taxonomy is visible before it becomes a Redis outage.`,
};
