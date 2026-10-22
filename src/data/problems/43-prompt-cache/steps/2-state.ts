import type {Step} from '@/lib/types';

export const cacheStateStep: Step = {
  id: 'state',
  title: 'Redis cache with atomic fill and honest TTLs',
  concept: 'redis',
  file: 'state',
  focus: ['cache', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it writes the completion, reads
it back, counts hits, and the demo is a cache that works. What it does under concurrency is overwrite
a newer value with an older one, and what it does to a hot entry is keep it alive forever. Review the
draft as the owner of the cache, fix it, and prove both properties.

Implement the Redis side of the cache — the fill used by the miss path and the read used by every hit.

- **Fill with \`SET … NX\` and a TTL in one command.** The fill writes
  \`SET {key} {payload} NX EX {ttl}\`: the first writer wins and a concurrent fill cannot replace a
  value that is already there. The draft plain-\`SET\`s, so a slow fill that started before a newer
  result can overwrite that newer result when it finishes.
- **A fill that lost the race returns the winner.** When \`NX\` reports that the write did not happen,
  the fill must \`GET\` the entry that won and return *its* completion. Returning the loser's own
  completion would hand the caller a value the cache does not agree with.
- **The TTL is the prompt version's lifetime.** Entries expire after \`VERSION_TTL_S = 6 * 3600\`
  seconds — the same horizon as the version they were produced for — and that number comes from one
  constant, never from the caller. The draft takes a \`ttl\` argument (and defaults it), so a caller can
  pin a stale completion, and two call sites disagree about how long "hot" lasts.
- **The value key's TTL is never refreshed on a hit.** A hit must not run \`EXPIRE\`/\`PEXPIRE\`/\`PERSIST\`
  against the value key. A hot entry must still die when its version does; refreshing it on read is how
  a deprecated prompt version keeps serving output forever.
- **Hits are counted in a separate, tenant- and version-scoped counter.** The access counter key is
  \`pc:access:{tenant}:{version}\`; a hit does \`HINCRBY counter hits 1\` and then sets **the counter's**
  TTL (it may outlive the entry, it must not outlive the version). The draft counts into
  \`access:{version}\`, which merges every tenant's traffic into one number and cannot answer "how many
  hits did this tenant get on version 7".

**Failure mode the checks target.** The draft is a read-modify-write where a single conditional write
is needed, and a TTL policy where the *wrong key* is being extended. Both bugs are invisible in a demo
with one writer and one reader, and both are permanent in production: the clobber loses the newer
answer, and the refresh makes a dead prompt version immortal.`,
  sequence: {
    participants: ['Prompt Cache', 'Redis', 'Slow filler'],
    messages: [
      {
        from: 'Prompt Cache',
        to: 'Redis',
        label: 'SET pc:{tenant}:{version}:{digest} payload NX EX 21600',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Prompt Cache', label: 'nil — the entry already exists', kind: 'reply'},
      {from: 'Prompt Cache', to: 'Redis', label: 'GET key → the value that won', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Cache', label: 'payload{tenant, version, completion}', kind: 'reply'},
      {from: 'Slow filler', to: 'Redis', label: 'SET … NX — refuses to overwrite the newer value', kind: 'sync'},
      {from: 'Redis', to: 'Slow filler', label: 'nil', kind: 'reply'},
      {
        from: 'Prompt Cache',
        to: 'Redis',
        label: 'HINCRBY pc:access:{tenant}:{version} hits 1 · EXPIRE counter',
        kind: 'async',
      },
    ],
  },
  hints: [
    'One command decides the race: `SET key payload NX EX ttl`. `NX` means "only if absent", so the writer that arrived first keeps its value no matter how long its own call takes — and `EX` in the same call means an entry can never exist without a deadline.',
    'The TTL belongs to the prompt version, not to the request. Derive it from one constant (`VERSION_TTL_S = 6 * 3600`) so the cache horizon moves when the version policy moves, and never accept it as an argument: a caller that can extend an entry can extend it past its template.',
    'Count the hit somewhere else. `HINCRBY pc:access:{tenant}:{version} hits 1` keeps the statistic, and putting the `EXPIRE` on that counter — not on the value key — gives you the only two properties you need: the value dies with its version, the metric survives long enough to be read.',
  ],
  checks: [
    {
      id: 'atomic-fill',
      title: 'Fill is one conditional write that cannot overwrite',
      detail:
        'The fill is a single `SET … NX EX` (or the client’s equivalent: `SetArgs{Mode: "NX"}`, `SetParams.nx()`, `UpdateType::NOT_EXIST`), so a writer that loses the race cannot clobber the value that won. The draft plain-writes and replaces whatever is there.',
      match: {
        python: {all: [/\.set\(key, payload/, /nx=True/]},
        typescript: {all: [/store\.set\(key, payload/, /'NX'/]},
        go: {all: [/SetArgs\(ctx, key, payload/, /Mode:\s*"NX"/]},
        scala: {all: [/jedis\.set\(key, payload/, /\.nx\(\)/]},
        cpp: {all: [/\.set\(key, payload/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'first-writer-wins',
      title: 'A fill that lost the race returns the stored value',
      detail:
        'When `NX` refuses the write, the fill re-reads the entry and returns the completion that actually won, instead of its own. The draft overwrites unconditionally, so an older slow fill can replace a newer result.',
      match: {
        python: {all: [/def fill_if_absent\(/, /await store\.get\(key\)/]},
        typescript: {all: [/function fillIfAbsent\(/, /await store\.get\(key\)/]},
        go: {all: [/func fillIfAbsent\(/, /store\.Get\(ctx, key\)/]},
        scala: {all: [/def fillIfAbsent\(/, /jedis\.get\(key\)/]},
        cpp: {all: [/std::string fill_if_absent\(/, /cache\.get\(key\)/]},
      },
    },
    {
      id: 'version-ttl',
      title: 'TTL is the prompt version’s lifetime, not a caller argument',
      detail:
        'The entry expires with `VERSION_TTL_S = 6 * 3600`, a single constant applied in the fill; the draft takes `ttl` from its caller, so an entry can be pinned past its version and two call sites can disagree about the horizon.',
      match: {
        python: {all: [/VERSION_TTL_S = 6 \* 3600/, /ex=VERSION_TTL_S/], none: [/ex=ttl\b/]},
        typescript: {all: [/VERSION_TTL_S = 6 \* 3600/, /'EX', VERSION_TTL_S/], none: [/'EX', ttl\b/]},
        go: {all: [/versionTTL = 6 \* time\.Hour/, /TTL: versionTTL/], none: [/TTL: ttl\b/]},
        scala: {all: [/VersionTtlS = 6 \* 3600/, /\.ex\(VersionTtlS\)/], none: [/\.ex\(ttl\)/]},
        cpp: {
          all: [/kVersionTtlS = 6 \* 3600/, /std::chrono::seconds\(kVersionTtlS\)/],
          none: [/std::chrono::seconds\(ttl\)/],
        },
      },
    },
    {
      id: 'counter-scope',
      title: 'Access counter is keyed by tenant and version',
      detail:
        'Hits are counted under `pc:access:{tenant}:{version}`. The draft counts under `access:{version}`, which folds every tenant into one number and cannot produce a per-tenant hit ratio.',
      match: {
        python: {all: [/pc:access:\{tenant\}:\{version\}/]},
        typescript: {all: [/pc:access:\$\{tenant\}:\$\{version\}/]},
        go: {all: [/pc:access:%s:%d/]},
        scala: {all: [/s"pc:access:\$tenant:\$version"/]},
        cpp: {all: [/"pc:access:" \+ tenant/]},
      },
    },
    {
      id: 'hit-touches-counter',
      title: 'A hit refreshes the counter, never the value’s TTL',
      detail:
        'On a hit the code increments the access counter and expires **that** key; nothing ever re-expires the value key, so a hot entry still dies with its version. The draft runs `EXPIRE` on the value key and a deprecated prompt version never expires.',
      match: {
        python: {all: [/hincrby\(counter/, /expire\(counter/], none: [/expire\(key\b/, /persist\(key\b/]},
        typescript: {all: [/hincrby\(counter/, /expire\(counter/], none: [/expire\(key\b/, /persist\(key\b/]},
        go: {all: [/HIncrBy\(ctx, counter/, /Expire\(ctx, counter/], none: [/Expire\(ctx, key\b/]},
        scala: {all: [/\.hincrBy\(counter/, /\.expire\(counter/], none: [/\.expire\(key\b/]},
        cpp: {all: [/\.hincrby\(counter/, /\.expire\(counter/], none: [/\.expire\(key\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from redis.asyncio import Redis

store = Redis.from_url("redis://cache:6379/0")

VERSION_TTL_S = 3600


async def fill(key: str, tenant: str, version: int, completion: str, ttl: int = VERSION_TTL_S) -> str:
    # TODO: the draft overwrites on every fill with a caller-supplied TTL, so a slow fill clobbers a
    # newer result with an older one; it refreshes the value's TTL on every hit so a hot entry never
    # expires; and it counts hits under a key that has no tenant in it.
    payload = json.dumps({"tenant": tenant, "version": version, "completion": completion})
    await store.set(key, payload, ex=ttl)
    return completion


async def lookup(key: str, tenant: str, version: int) -> dict | None:
    raw = await store.get(key)
    if raw is None:
        return None
    await store.expire(key, VERSION_TTL_S)
    await store.hincrby(f"access:{version}", "hits", 1)
    return json.loads(raw)
`,
      solution: `import json
import logging

from redis.asyncio import Redis

log = logging.getLogger("prompt-cache")
store = Redis.from_url("redis://cache:6379/0")

# No tenant's entry may outlive its prompt version.
VERSION_TTL_S = 6 * 3600
# The counter may outlive the entry; it must not outlive the version.
ACCESS_TTL_S = 24 * 3600


async def fill_if_absent(key: str, tenant: str, version: int, completion: str) -> str:
    """SET NX EX: the first writer wins and the entry dies with its prompt version."""
    payload = json.dumps({"tenant": tenant, "version": version, "completion": completion})
    if await store.set(key, payload, nx=True, ex=VERSION_TTL_S):
        return completion
    winner = await store.get(key)  # a concurrent fill got there first: return its value, not ours
    return json.loads(winner)["completion"] if winner else completion


async def lookup(key: str, tenant: str, version: int) -> dict | None:
    """A hit counts itself in a separate counter and never extends the value's life."""
    raw = await store.get(key)
    if raw is None:
        return None
    counter = f"pc:access:{tenant}:{version}"
    await store.hincrby(counter, "hits", 1)
    await store.expire(counter, ACCESS_TTL_S)
    log.info("cache hit key=%s", key)
    return json.loads(raw)
`,
    },
    typescript: {
      starter: `/** Redis fill and read paths: the draft writes unconditionally and refreshes on read. */
import {Redis} from 'ioredis';

const store = new Redis('redis://cache:6379');

const VERSION_TTL_S = 3600;

interface CacheRecord {
  tenant: string;
  version: number;
  completion: string;
}

export async function fill(
  key: string,
  tenant: string,
  version: number,
  completion: string,
  ttl: number = VERSION_TTL_S,
): Promise<string> {
  // TODO: the draft overwrites on every fill with a caller-supplied TTL, so a slow fill clobbers a
  // newer result with an older one; it refreshes the value's TTL on every hit so a hot entry never
  // expires; and it counts hits under a key that has no tenant in it.
  await store.set(key, JSON.stringify({tenant, version, completion}), 'EX', ttl);
  return completion;
}

export async function lookup(key: string, tenant: string, version: number): Promise<CacheRecord | null> {
  const raw = await store.get(key);
  if (raw === null) return null;
  await store.expire(key, VERSION_TTL_S);
  await store.hincrby(\`access:\${version}\`, 'hits', 1);
  return JSON.parse(raw) as CacheRecord;
}
`,
      solution: `/** Redis fill and read paths: one conditional write, and the counter — never the value — on hit. */
import {Redis} from 'ioredis';

const store = new Redis('redis://cache:6379');

// No tenant's entry may outlive its prompt version.
const VERSION_TTL_S = 6 * 3600;
// The counter may outlive the entry; it must not outlive the version.
const ACCESS_TTL_S = 24 * 3600;

interface CacheRecord {
  tenant: string;
  version: number;
  completion: string;
}

/** SET NX EX: the first writer wins and the entry dies with its prompt version. */
export async function fillIfAbsent(
  key: string,
  tenant: string,
  version: number,
  completion: string,
): Promise<string> {
  const payload = JSON.stringify({tenant, version, completion});
  const written = await store.set(key, payload, 'NX', 'EX', VERSION_TTL_S);
  if (written === 'OK') return completion;
  const winner = await store.get(key); // a concurrent fill got there first: return its value
  return winner === null ? completion : (JSON.parse(winner) as CacheRecord).completion;
}

/** A hit counts itself in a separate counter and never extends the value's life. */
export async function lookup(key: string, tenant: string, version: number): Promise<CacheRecord | null> {
  const raw = await store.get(key);
  if (raw === null) return null;
  const counter = \`pc:access:\${tenant}:\${version}\`;
  await store.hincrby(counter, 'hits', 1);
  await store.expire(counter, ACCESS_TTL_S);
  return JSON.parse(raw) as CacheRecord;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const VERSION_TTL_S = 3600

// TODO: the draft overwrites on every fill with a caller-supplied TTL, so a slow fill clobbers a
// newer result with an older one; it refreshes the value's TTL on every hit so a hot entry never
// expires; and it counts hits under a key that has no tenant in it.
func fill(ctx context.Context, key, tenant string, version int, completion string, ttl time.Duration) (string, error) {
	payload, err := json.Marshal(cacheRecord{Tenant: tenant, Version: version, Completion: completion})
	if err != nil {
		return "", err
	}
	if err := store.SetArgs(ctx, key, payload, redis.SetArgs{TTL: ttl}).Err(); err != nil {
		return "", err
	}
	return completion, nil
}

func lookup(ctx context.Context, key, tenant string, version int) (*cacheRecord, error) {
	raw, err := store.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	store.Expire(ctx, key, time.Duration(VERSION_TTL_S)*time.Second)
	counter := fmt.Sprintf("access:%d", version)
	store.HIncrBy(ctx, counter, "hits", 1)
	var record cacheRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, err
	}
	return &record, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// No tenant's entry may outlive its prompt version.
const (
	versionTTL = 6 * time.Hour
	accessTTL  = 24 * time.Hour
)

// fillIfAbsent is SET NX EX: the first writer wins and the entry dies with its prompt version.
func fillIfAbsent(ctx context.Context, key, tenant string, version int, completion string) (string, error) {
	payload, err := json.Marshal(cacheRecord{Tenant: tenant, Version: version, Completion: completion})
	if err != nil {
		return "", err
	}
	written, err := store.SetArgs(ctx, key, payload, redis.SetArgs{Mode: "NX", TTL: versionTTL}).Result()
	if err == redis.Nil || written == "" {
		// A concurrent fill got there first: return the value that won, not the one we produced.
		winner, getErr := store.Get(ctx, key).Bytes()
		if getErr == nil {
			var record cacheRecord
			if json.Unmarshal(winner, &record) == nil {
				return record.Completion, nil
			}
		}
		return completion, nil
	}
	return completion, err
}

// lookup counts a hit in a separate counter and never extends the value's life.
func lookup(ctx context.Context, key, tenant string, version int) (*cacheRecord, error) {
	raw, err := store.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	counter := fmt.Sprintf("pc:access:%s:%d", tenant, version)
	store.HIncrBy(ctx, counter, "hits", 1)
	store.Expire(ctx, counter, accessTTL)
	var record cacheRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, err
	}
	return &record, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object CacheStore {
  // TODO: the draft overwrites on every fill with a caller-supplied TTL, so a slow fill clobbers a
  // newer result with an older one; it refreshes the value's TTL on every hit so a hot entry never
  // expires; and it counts hits under a key that has no tenant in it.
  final case class CacheRecord(tenant: String, version: Int, completion: String)

  val VersionTtlS = 3600

  def fill(jedis: Jedis, key: String, tenant: String, version: Int, completion: String, ttl: Int): String = {
    val payload = s"""{"tenant":"$tenant","version":$version,"completion":"$completion"}"""
    jedis.set(key, payload, SetParams.setParams().ex(ttl))
    completion
  }

  def lookup(jedis: Jedis, key: String, tenant: String, version: Int): Option[CacheRecord] =
    Option(jedis.get(key)).map { raw =>
      jedis.expire(key, VersionTtlS.toLong)
      jedis.hincrBy(s"access:$version", "hits", 1L)
      decode(raw)
    }
}
`,
      solution: `import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object CacheStore {
  final case class CacheRecord(tenant: String, version: Int, completion: String)

  // No tenant's entry may outlive its prompt version.
  val VersionTtlS = 6 * 3600
  // The counter may outlive the entry; it must not outlive the version.
  val AccessTtlS = 24 * 3600

  /** SET NX EX: the first writer wins and the entry dies with its prompt version. */
  def fillIfAbsent(jedis: Jedis, key: String, tenant: String, version: Int, completion: String): String = {
    val payload = s"""{"tenant":"$tenant","version":$version,"completion":"$completion"}"""
    val written = jedis.set(key, payload, SetParams.setParams().nx().ex(VersionTtlS))
    if (written == "OK") completion
    else Option(jedis.get(key)).map(decode).getOrElse(completion)
  }

  /** A hit counts itself in a separate counter and never extends the value's life. */
  def lookup(jedis: Jedis, key: String, tenant: String, version: Int): Option[CacheRecord] =
    Option(jedis.get(key)).map { raw =>
      val counter = s"pc:access:$tenant:$version"
      jedis.hincrBy(counter, "hits", 1L)
      jedis.expire(counter, AccessTtlS.toLong)
      decode(raw)
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

// TODO: the draft overwrites on every fill with a caller-supplied TTL, so a slow fill clobbers a
// newer result with an older one; it refreshes the value's TTL on every hit so a hot entry never
// expires; and it counts hits under a key that has no tenant in it.
constexpr int kVersionTtlS = 3600;

std::string fill(sw::redis::Redis& cache, const std::string& key, const std::string& tenant, int version,
                 const std::string& completion, int ttl) {
  const std::string payload = encode_record(tenant, version, completion);
  cache.set(key, payload, std::chrono::seconds(ttl));
  return completion;
}

std::optional<CacheRecord> lookup(sw::redis::Redis& cache, const std::string& key, const std::string& tenant, int version) {
  auto raw = cache.get(key);
  if (!raw) {
    return std::nullopt;
  }
  cache.expire(key, kVersionTtlS);
  cache.hincrby("access:" + std::to_string(version), "hits", 1);
  return decode_record(*raw);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

namespace {

// No tenant's entry may outlive its prompt version.
constexpr int kVersionTtlS = 6 * 3600;
// The counter may outlive the entry; it must not outlive the version.
constexpr int kAccessTtlS = 24 * 3600;

}  // namespace

// SET NX EX: the first writer wins and the entry dies with its prompt version.
std::string fill_if_absent(sw::redis::Redis& cache, const std::string& key, const std::string& tenant, int version,
                           const std::string& completion) {
  const std::string payload = encode_record(tenant, version, completion);
  const bool written = cache.set(key, payload, std::chrono::seconds(kVersionTtlS), sw::redis::UpdateType::NOT_EXIST);
  if (written) {
    return completion;
  }
  // A concurrent fill got there first: return the value that won, not the one we produced.
  auto winner = cache.get(key);
  return winner ? decode_record(*winner).completion : completion;
}

// A hit counts itself in a separate counter and never extends the value's life.
std::optional<CacheRecord> lookup(sw::redis::Redis& cache, const std::string& key, const std::string& tenant, int version) {
  auto raw = cache.get(key);
  if (!raw) {
    return std::nullopt;
  }
  const std::string counter = "pc:access:" + tenant + ":" + std::to_string(version);
  cache.hincrby(counter, "hits", 1);
  cache.expire(counter, kAccessTtlS);
  return decode_record(*raw);
}
`,
    },
  },
  debrief: `The interviewer is testing two instincts that separate a cache from a dictionary: a fill is a decision, not an assignment, and a TTL belongs to the data, not to the request that happens to touch it. The draft's plain \`SET\` assumes the writer that finishes last has the best answer — an assumption that only holds in a demo with one writer. \`NX\` makes the first writer win, and re-reading on a lost race keeps the caller's view and the cache's view identical. The TTL half is subtler: refreshing a value on read feels like keeping the cache warm, but it silently converts "entries expire with their prompt version" into "popular entries never expire", so a deprecated template keeps serving its output forever. Moving the refresh to a per-tenant, per-version counter keeps the hot-path statistic and gives the stats endpoint the one number it actually needs — and it is the same counter the consumer in step 4 updates.`,
};
