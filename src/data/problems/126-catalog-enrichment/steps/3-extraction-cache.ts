import type {Step} from '@/lib/types';

export const extractionCacheStep: Step = {
  id: 'extraction-cache',
  title: 'Redis: cache by content and taxonomy, atomic merchant budget, review leases',
  concept: 'redis',
  file: 'extraction_cache',
  focus: ['catalogd', 'redis', 'llm'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it caches extraction results,
counts a merchant's extractions against a daily budget, and lets a reviewer claim a SKU. In a demo
with one worker and one reviewer it all works. It hides five production flaws. Review it like the
engineer paying the model bill, fix it, and prove the fix with the checks below.

Implement the Redis layer in front of \`extract_attributes\` from the previous step:

- **Cache key** \`extract:{taxonomy_version}:{content_hash}\` — the hash from the intake job, and
  the taxonomy version the result is valid under. Two merchants selling the same product share the
  entry; a taxonomy release invalidates every entry at once; an updated title never hits a stale
  one. The draft keys by SKU id, so the second merchant pays again and a changed title is served
  the old attributes.
- **Cache TTL** of **7 days** (\`CACHE_TTL_S = 604800\`), set with the write.
- **Daily budget**: at most **50 000** extractions per merchant per UTC day
  (\`DAILY_BUDGET = 50_000\`), keyed \`budget:{merchant}:{day}\`, reserved by **one atomic Lua
  \`EVAL\`** that reads, checks, increments and sets the key's expiry on first write
  (\`BUDGET_TTL_S = 172800\`). A client-side read followed by an increment lets concurrent workers
  overspend.
- **Reserve before the model call** — a cache miss reserves budget, then extracts, then caches. The
  draft calls the model and counts afterwards, so an over-budget merchant is still billed.
- **Review leases**: \`claim_review(sku_id, reviewer)\` takes \`review:lease:{sku_id}\` with
  \`SET NX EX 900\` (\`LEASE_TTL_S = 900\`) and reports whether the claim won;
  \`release_review\` deletes the lease only when this reviewer still holds it. The draft's plain
  \`SET\` lets two reviewers edit the same SKU and never expires.

**Failure mode the checks target.** A cache keyed by id costs money on every duplicate product and
serves stale attributes after a title change; a key without a TTL grows until Redis evicts something
you wanted; a read-then-increment budget passes every serial test and overspends exactly under
load; counting after the call pays for refused work; and an unexpiring, non-exclusive lease is a
lock in name only.`,
  sequence: {
    participants: ['catalogd', 'Redis', 'Extractor'],
    messages: [
      {from: 'catalogd', to: 'Redis', label: 'GET extract:{taxonomy_version}:{content_hash}', kind: 'sync'},
      {from: 'Redis', to: 'catalogd', label: 'cached result / nil', kind: 'reply'},
      {from: 'catalogd', to: 'Redis', label: 'EVAL budget · KEYS[budget:safeway:2026-10-22]', kind: 'sync'},
      {from: 'Redis', to: 'catalogd', label: '{1, 49 211}', kind: 'reply'},
      {from: 'catalogd', to: 'Extractor', label: 'Extract(...) only after the reservation', kind: 'sync'},
      {from: 'Extractor', to: 'catalogd', label: 'result', kind: 'reply'},
      {from: 'catalogd', to: 'Redis', label: 'SET extract:… result EX 604800', kind: 'sync'},
      {from: 'catalogd', to: 'Redis', label: 'SET review:lease:{sku_id} reviewer NX EX 900', kind: 'sync'},
    ],
  },
  hints: [
    'The cache key has two parts and neither is the SKU id: `taxonomy.version()` and `sku["content_hash"]` from the intake job. Write it with `ex=CACHE_TTL_S` (or `EX`, a `time.Duration`, `setex`, `std::chrono::seconds`), and look it up before anything that costs money.',
    'Move the budget into Redis: a Lua script that does `GET`, compares with the limit, `INCRBY`s and calls `EXPIRE` when the key is new, returning `{ok, remaining}`. Call it from `reserve_budget` and call `reserve_budget` before `extract_attributes` — on a cache miss only.',
    'A lease is `SET key reviewer NX EX 900`: `NX` makes it exclusive, `EX` makes it expire when the reviewer walks away. Releasing it is a compare-and-delete script (`GET == ARGV[1]` then `DEL`), so a reviewer whose lease expired cannot delete the next reviewer’s.',
  ],
  checks: [
    {
      id: 'cache-key',
      title: 'Caches by taxonomy version and content hash',
      detail:
        'The cache key is `extract:{taxonomy_version}:{content_hash}`; the SKU id appears nowhere in it. The draft keys by id, so identical products are extracted once per merchant and a changed title hits a stale entry.',
      match: {
        python: {all: [/extract:\{taxonomy_version\}:\{content_hash\}/], none: [/extract:\{sku/]},
        typescript: {all: [/extract:\$\{taxonomyVersion\}:\$\{contentHash\}/], none: [/extract:\$\{sku/]},
        go: {all: [/"extract:%s:%s",\s*taxonomyVersion,\s*contentHash/], none: [/"extract:"\s*\+\s*sku/]},
        scala: {all: [/extract:\$taxonomyVersion:\$contentHash/], none: [/extract:\$\{?sku/]},
        cpp: {
          all: [/"extract:"\s*\+\s*taxonomyVersion\s*\+\s*":"\s*\+\s*contentHash/],
          none: [/"extract:"\s*\+\s*sku/],
        },
      },
    },
    {
      id: 'cache-ttl',
      title: 'Cache entries expire after 7 days',
      detail:
        'The result is written with a 7-day expiry (`CACHE_TTL_S = 604800`) in the same `SET`. The draft writes without a TTL and the cache grows until eviction.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*604_?800/, /ex=CACHE_TTL_S/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*604_?800/, /['"]EX['"],\s*CACHE_TTL_S/]},
        go: {all: [/cacheTTL\s*=\s*7\s*\*\s*24\s*\*\s*time\.Hour/, /\.Set\(ctx,\s*key,\s*[^,]+,\s*cacheTTL\)/]},
        scala: {all: [/CacheTtlS\s*=\s*604800L?/, /\.setex\(\s*key,\s*CacheTtlS/]},
        cpp: {all: [/kCacheTtlS\s*=\s*604800/, /std::chrono::seconds\(kCacheTtlS\)/]},
      },
    },
    {
      id: 'budget-atomic',
      title: 'Reserves the merchant’s daily budget with one atomic Lua script',
      detail:
        'A Lua script keyed `budget:{merchant}:{day}` reads, checks against `DAILY_BUDGET = 50_000`, increments and sets `EXPIRE` on first write, in one `EVAL`. The draft reads, compares and increments from the client, which races.',
      match: {
        python: {
          all: [
            /BUDGET_LUA/,
            /\.eval\(\s*BUDGET_LUA/,
            /DAILY_BUDGET\s*=\s*50_?000/,
            /INCRBY/,
            /EXPIRE/,
            /budget:\{merchant\}:\{day\}/,
          ],
        },
        typescript: {
          all: [
            /BUDGET_LUA/,
            /\.eval\(\s*BUDGET_LUA/,
            /DAILY_BUDGET\s*=\s*50_?000/,
            /INCRBY/,
            /EXPIRE/,
            /budget:\$\{merchant\}:\$\{day\}/,
          ],
        },
        go: {
          all: [
            /budgetScript\s*=\s*redis\.NewScript\(/,
            /budgetScript\.Run\(/,
            /dailyBudget\s*=\s*50000/,
            /INCRBY/,
            /EXPIRE/,
            /"budget:%s:%s"/,
          ],
        },
        scala: {
          all: [
            /BudgetLua/,
            /\.eval\(\s*BudgetLua/,
            /DailyBudget\s*=\s*50000L?/,
            /INCRBY/,
            /EXPIRE/,
            /budget:\$merchant:\$day/,
          ],
        },
        cpp: {
          all: [
            /kBudgetLua/,
            /\.eval<[^(]*\(\s*kBudgetLua/,
            /kDailyBudget\s*=\s*50000/,
            /INCRBY/,
            /EXPIRE/,
            /"budget:"\s*\+\s*merchant\s*\+\s*":"\s*\+\s*day/,
          ],
        },
      },
    },
    {
      id: 'reserve-first',
      title: 'Reserves budget before the model call, on a cache miss only',
      detail:
        'On a cache miss, `reserve_budget` runs before `extract_attributes` and a refused reservation never reaches the model. The draft extracts first and counts afterwards.',
      match: {
        python: {order: [/= reserve_budget\(/, /= extract_attributes\(/]},
        typescript: {order: [/= await reserveBudget\(/, /= await extractAttributes\(/]},
        go: {order: [/:= reserveBudget\(/, /:= extractAttributes\(/]},
        scala: {order: [/= reserveBudget\(/, /= ExtractAttributes\.extractAttributes\(/]},
        cpp: {order: [/= reserveBudget\(/, /= extractAttributes\(/]},
      },
    },
    {
      id: 'lease-nx',
      title: 'Claims a review lease with SET NX EX 900',
      detail:
        '`claim_review` sets `review:lease:{sku_id}` only if absent (`NX`) with a 15-minute expiry (`LEASE_TTL_S = 900`) and returns whether it won; `release_review` deletes only when the caller still holds it. The draft’s plain `SET` is neither exclusive nor expiring.',
      match: {
        python: {all: [/LEASE_TTL_S\s*=\s*900/, /nx=True/, /ex=LEASE_TTL_S/, /RELEASE_LUA/]},
        typescript: {all: [/LEASE_TTL_S\s*=\s*900/, /['"]EX['"],\s*LEASE_TTL_S,\s*['"]NX['"]/, /RELEASE_LUA/]},
        go: {all: [/leaseTTL\s*=\s*15\s*\*\s*time\.Minute/, /\.SetNX\(/, /releaseScript/]},
        scala: {all: [/LeaseTtlS\s*=\s*900L?/, /\.nx\(\)\.ex\(\s*LeaseTtlS\s*\)/, /ReleaseLua/]},
        cpp: {
          all: [/kLeaseTtlS\s*=\s*900/, /UpdateType::NOT_EXIST/, /std::chrono::seconds\(kLeaseTtlS\)/, /kReleaseLua/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import redis

from extract_attributes import extract_attributes

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_BUDGET = 50_000


class BudgetExhausted(Exception):
    """The merchant has used its extractions for today."""


def enrich(sku: dict) -> dict:
    # TODO: this draft caches by SKU id with no TTL, counts the budget from the client after the
    # model call, and takes a review lease with a plain SET. Review all five.
    key = f"extract:{sku['sku_id']}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    result = extract_attributes(sku)
    day = time.strftime("%Y-%m-%d", time.gmtime())
    used = int(r.get(f"budget:{sku['merchant']}:{day}") or 0)
    if used >= DAILY_BUDGET:
        raise BudgetExhausted(sku["merchant"])
    r.incr(f"budget:{sku['merchant']}:{day}")
    r.set(key, json.dumps(result))
    return result


def claim_review(sku_id: str, reviewer: str) -> bool:
    r.set(f"review:lease:{sku_id}", reviewer)
    return True


def release_review(sku_id: str, reviewer: str) -> bool:
    r.delete(f"review:lease:{sku_id}")
    return True
`,
      solution: `import json
import time

import redis

from extract_attributes import extract_attributes, taxonomy

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 604_800
DAILY_BUDGET = 50_000
BUDGET_TTL_S = 172_800
LEASE_TTL_S = 900

BUDGET_LUA = """
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local limit = tonumber(ARGV[1])
if used + 1 > limit then
  return {0, limit - used}
end
local now = redis.call('INCRBY', KEYS[1], 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, limit - now}
"""

RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


class BudgetExhausted(Exception):
    """The merchant has used its extractions for today."""


def cache_key(taxonomy_version: str, content_hash: str) -> str:
    return f"extract:{taxonomy_version}:{content_hash}"


def budget_key(merchant: str, day: str) -> str:
    return f"budget:{merchant}:{day}"


def lease_key(sku_id: str) -> str:
    return f"review:lease:{sku_id}"


def reserve_budget(merchant: str) -> tuple[bool, int]:
    """Reserve one extraction of the merchant's daily budget; (granted, remaining)."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    ok, remaining = r.eval(BUDGET_LUA, 1, budget_key(merchant, day), DAILY_BUDGET, BUDGET_TTL_S)
    return bool(ok), int(remaining)


def enrich(sku: dict) -> dict:
    taxonomy_version = taxonomy.version()
    key = cache_key(taxonomy_version, sku["content_hash"])
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    granted, remaining = reserve_budget(sku["merchant"])
    if not granted:
        raise BudgetExhausted(f"{sku['merchant']} has no extractions left today ({remaining})")
    result = extract_attributes(sku)
    r.set(key, json.dumps(result), ex=CACHE_TTL_S)
    return result


def claim_review(sku_id: str, reviewer: str) -> bool:
    """True when this reviewer now holds the SKU's lease for LEASE_TTL_S."""
    return bool(r.set(lease_key(sku_id), reviewer, nx=True, ex=LEASE_TTL_S))


def release_review(sku_id: str, reviewer: str) -> bool:
    """Delete the lease only if this reviewer still holds it."""
    return int(r.eval(RELEASE_LUA, 1, lease_key(sku_id), reviewer)) == 1
`,
    },
    typescript: {
      starter: `/** Extraction cache and budget: a model-generated draft that keys by id and counts after the call. */
import {Redis} from 'ioredis';

import {extractAttributes, type ExtractionResult, type SkuJob} from './extract_attributes';

const r = new Redis('redis://redis:6379');

const DAILY_BUDGET = 50_000;

export class BudgetExhausted extends Error {}

export async function enrich(sku: SkuJob): Promise<ExtractionResult> {
  // TODO: this draft caches by SKU id with no TTL, counts the budget from the client after the
  // model call, and takes a review lease with a plain SET. Review all five.
  const key = \`extract:\${sku.sku_id}\`;
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as ExtractionResult;
  const result = await extractAttributes(sku);
  const day = new Date().toISOString().slice(0, 10);
  const used = Number((await r.get(\`budget:\${sku.merchant}:\${day}\`)) ?? 0);
  if (used >= DAILY_BUDGET) throw new BudgetExhausted(sku.merchant);
  await r.incr(\`budget:\${sku.merchant}:\${day}\`);
  await r.set(key, JSON.stringify(result));
  return result;
}

export async function claimReview(skuId: string, reviewer: string): Promise<boolean> {
  await r.set(\`review:lease:\${skuId}\`, reviewer);
  return true;
}

export async function releaseReview(skuId: string, reviewer: string): Promise<boolean> {
  await r.del(\`review:lease:\${skuId}\`);
  return true;
}
`,
      solution: `/** Extraction cache by taxonomy and content, an atomic daily budget per merchant, review leases. */
import {Redis} from 'ioredis';

import {extractAttributes, type ExtractionResult, type SkuJob} from './extract_attributes';
import {taxonomy} from './taxonomy';

const r = new Redis('redis://redis:6379');

const CACHE_TTL_S = 604_800;
const DAILY_BUDGET = 50_000;
const BUDGET_TTL_S = 172_800;
const LEASE_TTL_S = 900;

const BUDGET_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local limit = tonumber(ARGV[1])
if used + 1 > limit then
  return {0, limit - used}
end
local now = redis.call('INCRBY', KEYS[1], 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, limit - now}
\`;

const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
\`;

export class BudgetExhausted extends Error {}

/** Reserve one extraction of the merchant's daily budget: [granted, remaining]. */
async function reserveBudget(merchant: string): Promise<[boolean, number]> {
  const day = new Date().toISOString().slice(0, 10);
  const reply = (await r.eval(BUDGET_LUA, 1, \`budget:\${merchant}:\${day}\`, String(DAILY_BUDGET), String(BUDGET_TTL_S))) as [
    number,
    number,
  ];
  return [reply[0] === 1, reply[1]];
}

export async function enrich(sku: SkuJob): Promise<ExtractionResult> {
  const taxonomyVersion = await taxonomy.version();
  const contentHash = sku.content_hash;
  const key = \`extract:\${taxonomyVersion}:\${contentHash}\`;
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as ExtractionResult;
  const [granted, remaining] = await reserveBudget(sku.merchant);
  if (!granted) throw new BudgetExhausted(\`\${sku.merchant} has no extractions left today (\${remaining})\`);
  const result = await extractAttributes(sku);
  await r.set(key, JSON.stringify(result), 'EX', CACHE_TTL_S);
  return result;
}

/** True when this reviewer now holds the SKU's lease for LEASE_TTL_S. */
export async function claimReview(skuId: string, reviewer: string): Promise<boolean> {
  const reply = await r.set(\`review:lease:\${skuId}\`, reviewer, 'EX', LEASE_TTL_S, 'NX');
  return reply === 'OK';
}

/** Delete the lease only if this reviewer still holds it. */
export async function releaseReview(skuId: string, reviewer: string): Promise<boolean> {
  const deleted = (await r.eval(RELEASE_LUA, 1, \`review:lease:\${skuId}\`, reviewer)) as number;
  return deleted === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const dailyBudget = 50000

var rdb *redis.Client

var ErrBudgetExhausted = errors.New("merchant has no extractions left today")

// TODO: this draft caches by SKU id with no TTL, counts the budget from the client after the
// model call, and takes a review lease with a plain SET. Review all five.
func enrich(ctx context.Context, sku SkuJob) (Result, error) {
	key := "extract:" + sku.SkuID
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var result Result
		if err := json.Unmarshal([]byte(cached), &result); err == nil {
			return result, nil
		}
	}
	result, err := extractAttributes(ctx, sku)
	if err != nil {
		return Result{}, err
	}
	day := time.Now().UTC().Format("2006-01-02")
	used, _ := rdb.Get(ctx, "budget:"+sku.Merchant+":"+day).Int()
	if used >= dailyBudget {
		return Result{}, ErrBudgetExhausted
	}
	rdb.Incr(ctx, "budget:"+sku.Merchant+":"+day)
	payload, _ := json.Marshal(result)
	rdb.Set(ctx, key, payload, 0)
	return result, nil
}

func claimReview(ctx context.Context, skuID, reviewer string) (bool, error) {
	return true, rdb.Set(ctx, "review:lease:"+skuID, reviewer, 0).Err()
}

func releaseReview(ctx context.Context, skuID, reviewer string) (bool, error) {
	return true, rdb.Del(ctx, "review:lease:"+skuID).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	cacheTTL    = 7 * 24 * time.Hour
	dailyBudget = 50000
	budgetTTL   = 48 * time.Hour
	leaseTTL    = 15 * time.Minute
)

var (
	rdb      *redis.Client
	taxonomy Taxonomy
)

var ErrBudgetExhausted = errors.New("merchant has no extractions left today")

var budgetScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local limit = tonumber(ARGV[1])
if used + 1 > limit then
  return {0, limit - used}
end
local now = redis.call('INCRBY', KEYS[1], 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, limit - now}
\`)

var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
\`)

func cacheKey(taxonomyVersion, contentHash string) string {
	return fmt.Sprintf("extract:%s:%s", taxonomyVersion, contentHash)
}

func budgetKey(merchant, day string) string {
	return fmt.Sprintf("budget:%s:%s", merchant, day)
}

func leaseKey(skuID string) string {
	return "review:lease:" + skuID
}

// reserveBudget reserves one extraction of the merchant's daily budget: granted, remaining.
func reserveBudget(ctx context.Context, merchant string) (bool, int64, error) {
	day := time.Now().UTC().Format("2006-01-02")
	values, err := budgetScript.Run(ctx, rdb, []string{budgetKey(merchant, day)}, dailyBudget, int64(budgetTTL.Seconds())).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return values[0] == 1, values[1], nil
}

func enrich(ctx context.Context, sku SkuJob) (Result, error) {
	taxonomyVersion, err := taxonomy.Version(ctx)
	if err != nil {
		return Result{}, err
	}
	key := cacheKey(taxonomyVersion, sku.ContentHash)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var result Result
		if err := json.Unmarshal([]byte(cached), &result); err == nil {
			return result, nil
		}
	}
	granted, remaining, err := reserveBudget(ctx, sku.Merchant)
	if err != nil {
		return Result{}, err
	}
	if !granted {
		return Result{}, fmt.Errorf("%w: %s (%d)", ErrBudgetExhausted, sku.Merchant, remaining)
	}
	result, err := extractAttributes(ctx, sku)
	if err != nil {
		return Result{}, err
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return Result{}, err
	}
	if err := rdb.Set(ctx, key, payload, cacheTTL).Err(); err != nil {
		return Result{}, err
	}
	return result, nil
}

// claimReview reports whether this reviewer now holds the SKU's lease for leaseTTL.
func claimReview(ctx context.Context, skuID, reviewer string) (bool, error) {
	return rdb.SetNX(ctx, leaseKey(skuID), reviewer, leaseTTL).Result()
}

// releaseReview deletes the lease only if this reviewer still holds it.
func releaseReview(ctx context.Context, skuID, reviewer string) (bool, error) {
	deleted, err := releaseScript.Run(ctx, rdb, []string{leaseKey(skuID)}, reviewer).Int64()
	if err != nil {
		return false, err
	}
	return deleted == 1, nil
}
`,
    },
    scala: {
      starter: `import java.time.{LocalDate, ZoneOffset}

import redis.clients.jedis.Jedis
import spray.json._

object ExtractionCache {
  val jedis = new Jedis("redis", 6379)

  val DailyBudget = 50000L

  final class BudgetExhausted(merchant: String) extends RuntimeException(s"$merchant has no extractions left today")

  // TODO: this draft caches by SKU id with no TTL, counts the budget from the client after the
  // model call, and takes a review lease with a plain SET. Review all five.
  def enrich(sku: SkuJob): JsObject = {
    val key = s"extract:\${sku.sku_id}"
    Option(jedis.get(key)) match {
      case Some(cached) => cached.parseJson.asJsObject
      case None =>
        val result = ExtractAttributes.extractAttributes(sku)
        val day = LocalDate.now(ZoneOffset.UTC).toString
        val used = Option(jedis.get(s"budget:\${sku.merchant}:$day")).map(_.toLong).getOrElse(0L)
        if (used >= DailyBudget) throw new BudgetExhausted(sku.merchant)
        jedis.incr(s"budget:\${sku.merchant}:$day")
        jedis.set(key, result.compactPrint)
        result
    }
  }

  def claimReview(skuId: String, reviewer: String): Boolean = {
    jedis.set(s"review:lease:$skuId", reviewer)
    true
  }

  def releaseReview(skuId: String, reviewer: String): Boolean = {
    jedis.del(s"review:lease:$skuId")
    true
  }
}
`,
      solution: `import java.time.{LocalDate, ZoneOffset}

import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json._

object ExtractionCache {
  val jedis = new Jedis("redis", 6379)
  val taxonomy = ExtractAttributes.taxonomy

  val CacheTtlS = 604800L
  val DailyBudget = 50000L
  val BudgetTtlS = 172800L
  val LeaseTtlS = 900L

  val BudgetLua =
    """
      |local used = tonumber(redis.call('GET', KEYS[1])) or 0
      |local limit = tonumber(ARGV[1])
      |if used + 1 > limit then
      |  return {0, limit - used}
      |end
      |local now = redis.call('INCRBY', KEYS[1], 1)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |return {1, limit - now}
      |""".stripMargin

  val ReleaseLua =
    """
      |if redis.call('GET', KEYS[1]) == ARGV[1] then
      |  return redis.call('DEL', KEYS[1])
      |end
      |return 0
      |""".stripMargin

  final class BudgetExhausted(merchant: String, remaining: Long)
      extends RuntimeException(s"$merchant has no extractions left today ($remaining)")

  def cacheKey(taxonomyVersion: String, contentHash: String): String = s"extract:$taxonomyVersion:$contentHash"

  def budgetKey(merchant: String, day: String): String = s"budget:$merchant:$day"

  def leaseKey(skuId: String): String = s"review:lease:$skuId"

  /** Reserve one extraction of the merchant's daily budget: (granted, remaining). */
  def reserveBudget(merchant: String): (Boolean, Long) = {
    val day = LocalDate.now(ZoneOffset.UTC).toString
    val result = jedis
      .eval(BudgetLua, 1, budgetKey(merchant, day), DailyBudget.toString, BudgetTtlS.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1))
  }

  def enrich(sku: SkuJob): JsObject = {
    val taxonomyVersion = taxonomy.version()
    val contentHash = sku.content_hash
    val key = cacheKey(taxonomyVersion, contentHash)
    Option(jedis.get(key)) match {
      case Some(cached) => cached.parseJson.asJsObject
      case None =>
        val (granted, remaining) = reserveBudget(sku.merchant)
        if (!granted) throw new BudgetExhausted(sku.merchant, remaining)
        val result = ExtractAttributes.extractAttributes(sku)
        jedis.setex(key, CacheTtlS, result.compactPrint)
        result
    }
  }

  /** True when this reviewer now holds the SKU's lease for LeaseTtlS. */
  def claimReview(skuId: String, reviewer: String): Boolean =
    jedis.set(leaseKey(skuId), reviewer, SetParams.setParams().nx().ex(LeaseTtlS)) == "OK"

  /** Delete the lease only if this reviewer still holds it. */
  def releaseReview(skuId: String, reviewer: String): Boolean =
    jedis.eval(ReleaseLua, 1, leaseKey(skuId), reviewer).asInstanceOf[Long] == 1L
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

json extractAttributes(const json& sku);

constexpr long long kDailyBudget = 50000;

sw::redis::Redis redis("tcp://redis:6379");

struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string today() {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char buf[11];
  std::strftime(buf, sizeof buf, "%Y-%m-%d", std::gmtime(&now));
  return buf;
}

// TODO: this draft caches by SKU id with no TTL, counts the budget from the client after the
// model call, and takes a review lease with a plain SET. Review all five.
json enrich(const json& sku) {
  const auto skuId = sku["sku_id"].get<std::string>();
  const auto merchant = sku["merchant"].get<std::string>();
  const auto key = "extract:" + skuId;
  if (const auto cached = redis.get(key)) return json::parse(*cached);
  const json result = extractAttributes(sku);
  const auto budgetKey = "budget:" + merchant + ":" + today();
  const auto raw = redis.get(budgetKey);
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used >= kDailyBudget) throw BudgetExhausted(merchant);
  redis.incr(budgetKey);
  redis.set(key, result.dump());
  return result;
}

bool claimReview(const std::string& skuId, const std::string& reviewer) {
  redis.set("review:lease:" + skuId, reviewer);
  return true;
}

bool releaseReview(const std::string& skuId, const std::string& reviewer) {
  redis.del("review:lease:" + skuId);
  return true;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

json extractAttributes(const json& sku);

struct Taxonomy {
  std::string version();
};

extern Taxonomy taxonomy;

constexpr long long kCacheTtlS = 604800;
constexpr long long kDailyBudget = 50000;
constexpr long long kBudgetTtlS = 172800;
constexpr long long kLeaseTtlS = 900;

const char* kBudgetLua = R"LUA(
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local limit = tonumber(ARGV[1])
if used + 1 > limit then
  return {0, limit - used}
end
local now = redis.call('INCRBY', KEYS[1], 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, limit - now}
)LUA";

const char* kReleaseLua = R"LUA(
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
)LUA";

sw::redis::Redis redis("tcp://redis:6379");

struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string today() {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char buf[11];
  std::strftime(buf, sizeof buf, "%Y-%m-%d", std::gmtime(&now));
  return buf;
}

std::string cacheKey(const std::string& taxonomyVersion, const std::string& contentHash) {
  return "extract:" + taxonomyVersion + ":" + contentHash;
}

std::string budgetKey(const std::string& merchant, const std::string& day) {
  return "budget:" + merchant + ":" + day;
}

std::string leaseKey(const std::string& skuId) { return "review:lease:" + skuId; }

// Reserve one extraction of the merchant's daily budget: {granted, remaining}.
std::pair<bool, long long> reserveBudget(const std::string& merchant) {
  const auto reply = redis.eval<std::vector<long long>>(
      kBudgetLua, {budgetKey(merchant, today())}, {std::to_string(kDailyBudget), std::to_string(kBudgetTtlS)});
  return {reply[0] == 1, reply[1]};
}

json enrich(const json& sku) {
  const auto merchant = sku["merchant"].get<std::string>();
  const auto contentHash = sku["content_hash"].get<std::string>();
  const auto taxonomyVersion = taxonomy.version();
  const auto key = cacheKey(taxonomyVersion, contentHash);
  if (const auto cached = redis.get(key)) return json::parse(*cached);
  const auto [granted, remaining] = reserveBudget(merchant);
  if (!granted) throw BudgetExhausted(merchant + " has no extractions left today (" + std::to_string(remaining) + ")");
  const json result = extractAttributes(sku);
  redis.set(key, result.dump(), std::chrono::seconds(kCacheTtlS));
  return result;
}

// True when this reviewer now holds the SKU's lease for kLeaseTtlS.
bool claimReview(const std::string& skuId, const std::string& reviewer) {
  return redis.set(leaseKey(skuId), reviewer, std::chrono::seconds(kLeaseTtlS), sw::redis::UpdateType::NOT_EXIST);
}

// Delete the lease only if this reviewer still holds it.
bool releaseReview(const std::string& skuId, const std::string& reviewer) {
  return redis.eval<long long>(kReleaseLua, {leaseKey(skuId)}, {reviewer}) == 1;
}
`,
    },
  },
  debrief: `The interview question behind this step is "what does the model call cost, and who pays when the code is wrong?" The cache key is the content-specific answer: keyed by content hash the cache dedupes the same product across merchants and never serves a stale title; keyed by taxonomy version it empties itself the moment the brand list changes, which the source post says happens continuously as new brands are ingested. The TTL bounds the memory the cache can take. The budget is the atomicity answer: one Lua script makes read, check, increment and expiry a single step, so concurrent workers cannot both see room for one more, and reserving before the call means a refused merchant is never billed. The lease is the human-review answer: \`NX\` makes a claim exclusive, \`EX\` makes an abandoned claim expire, and compare-and-delete stops a reviewer whose lease lapsed from releasing someone else's. Real systems add a negative cache for SKUs the model could not parse, per-merchant budgets configured rather than constant, and a budget refund when the call fails before the model ran.`,
};
