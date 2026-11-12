import type {Step} from '@/lib/types';

export const extractionCacheStep: Step = {
  id: 'extraction-cache',
  title: 'Redis: cache by content and taxonomy, atomic merchant budget, review leases',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry', 'leases'],
  file: 'extraction_cache',
  focus: ['catalogd', 'redis', 'llm'],
  task: `## Task

**Starting point.** The starter is the Redis layer in front of \`extract_attributes\` (step 2).
\`enrich(job)\` looks up \`extract:{sku_id}\`, calls the model on a miss, then reads
\`budget:{merchant}:{yyyymmdd}\` (UTC), raises \`BudgetExhausted\` at \`DAILY_BUDGET\` (50 000) or writes
the count plus one back, and caches an accepted result with no expiry. \`claim_review(sku_id,
reviewer)\` writes \`review:lease:{sku_id}\` with a plain \`SET\`. With one worker and one reviewer it
works, and it hides 5 flaws.

**Failure mode the checks target.** The same product listed twice pays twice and a corrected title
is served its old attributes; cache entries pile up forever; a merchant over budget still pays for
the call it is refused; two workers both read 49 999 and both spend; a second reviewer silently
takes a lease another holds.

- The cache key is \`extract:{taxonomy.VERSION}:{content_hash}\`, written with \`CACHE_TTL_S\`
  (7 days).
- On a miss the budget is reserved before the model is called; a hit costs nothing.
- One Lua script reads the counter, refuses at \`DAILY_BUDGET\`, increments, and sets \`BUDGET_TTL_S\`
  (2 days) on the first increment.
- \`claim_review\` is \`SET NX EX LEASE_TTL_S\` (900 s) and answers whether this reviewer got the lease.`,
  sequence: {
    participants: ['Worker', 'Redis', 'Extractor'],
    messages: [
      {from: 'Worker', to: 'Redis', label: 'GET extract:tx-2026.11:{content_hash}', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: 'nil (miss)', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'EVALSHA reserve budget:m-1:20261112 50000 172800', kind: 'sync'},
      {from: 'Worker', to: 'Extractor', label: 'extract_attributes(job)', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'SET extract:… result EX 604800', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'SET review:lease:sku-1 ana NX EX 900', kind: 'sync'},
    ],
  },
  hints: [
    'A merchant listing one product under two SKU ids pays twice, a fixed title keeps its old attributes, the budget is exceeded under load and charged for refused jobs, and two reviewers both hold one SKU.',
    'The key is the SKU id, so it cannot see content; the counter is read, compared and written in three commands after the model call; the cache write has no expiry; the lease `SET` overwrites whoever held it.',
    'Key the cache on `taxonomy.VERSION` and `content_hash` with `ex=CACHE_TTL_S`; reserve with one `register_script`/`eval` (GET, compare, INCR, EXPIRE on 1) before `extract_attributes`; lease with `nx=True, ex=LEASE_TTL_S`.',
  ],
  checks: [
    {
      id: 'cache-key',
      title: 'Caches by taxonomy version and content hash',
      detail:
        'The cache key is `extract:{taxonomy.VERSION}:{content_hash}`: the same content under another SKU id is a hit, a changed title is a miss, and a taxonomy release starts a fresh cache. The starter keys by SKU id.',
      match: {
        python: {
          all: [/extract:\{taxonomy\.VERSION\}:\{job\[["']content_hash["']\]\}/],
          none: [/extract:\{job\[["']sku_id/],
        },
        typescript: {all: [/extract:\$\{VERSION\}:\$\{job\.content_hash\}/], none: [/extract:\$\{job\.sku_id/]},
        go: {
          all: [/"extract:"\s*\+\s*taxonomy\.Version\s*\+\s*":"\s*\+\s*job\.ContentHash/],
          none: [/"extract:"\s*\+\s*job\.SkuID/],
        },
        scala: {
          all: [/extract:\$\{Taxonomy\.Version\}:\$\{job\("content_hash"\)\.str\}/],
          none: [/extract:\$\{job\("sku_id"\)/],
        },
        cpp: {
          all: [/"extract:"\s*\+\s*taxonomy::kVersion\s*\+\s*":"\s*\+\s*job\["content_hash"\]/],
          none: [/"extract:"\s*\+\s*job\["sku_id"\]/],
        },
      },
    },
    {
      id: 'cache-ttl',
      title: 'Cache entries expire after 7 days',
      detail:
        'The cache write carries `CACHE_TTL_S` (7 days) in the same command, so entries for SKUs nobody re-sends leave Redis on their own. The starter writes them with no expiry.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*(604800|7\s*\*\s*24\s*\*\s*3600)\b/, /ex\s*=\s*CACHE_TTL_S/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*(604800|7\s*\*\s*24\s*\*\s*3600)\b/, /'EX',\s*CACHE_TTL_S/]},
        go: {all: [/cacheTTL\s*=\s*7\s*\*\s*24\s*\*\s*time\.Hour/, /\.Set\([^\n]*cacheTTL\)/]},
        scala: {all: [/CacheTtlSeconds\s*=\s*(604800|7L?\s*\*\s*24\s*\*\s*3600)L?\b/, /\.ex\(CacheTtlSeconds\)/]},
        cpp: {all: [/kCacheTtl\{(604800|7\s*\*\s*24\s*\*\s*3600)\}/, /redis\.set\([^\n]*kCacheTtl\)/]},
      },
    },
    {
      id: 'budget-before-call',
      title: 'Reserves the budget before the model call',
      detail:
        'On a miss the budget is reserved first and an exhausted merchant raises `BudgetExhausted` without a call; a cache hit costs nothing. The starter calls the model first and refuses afterwards, so a refused job is paid for.',
      match: {
        python: {order: [/raise BudgetExhausted/, /extract_attributes\(job\)/]},
        typescript: {order: [/throw new BudgetExhausted/, /extractAttributes\(job\)/]},
        go: {order: [/fmt\.Errorf\([^\n]*ErrBudgetExhausted/, /extractAttributes\(ctx,\s*job\)/]},
        scala: {order: [/throw new BudgetExhausted/, /extractAttributes\(job\)/]},
        cpp: {order: [/throw BudgetExhausted/, /extractAttributes\(job\)/]},
      },
    },
    {
      id: 'atomic-budget',
      title: 'One Lua script reads, refuses, increments and expires the budget',
      detail:
        'The read, the comparison with `DAILY_BUDGET`, the `INCR` and the first-write `EXPIRE` run in one script, so two workers cannot both take the last unit and the counter leaves Redis after two days. The starter reads and writes the counter in separate commands.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/r\.(get|set|incr)\(\s*budget/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/redis\.(get|set|incr)\(\s*budget/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/rdb\.(Get|Set|Incr)\(\s*ctx,\s*budget/],
        },
        scala: {
          all: [/jedis\.eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/jedis\.(get|set|incr)\(\s*budget/],
        },
        cpp: {
          all: [/redis\.eval</, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/redis\.(get|set|incr)\(\s*budget/],
        },
      },
    },
    {
      id: 'review-lease',
      title: 'A review lease is exclusive and expires after 15 minutes',
      detail:
        "`claim_review` takes `review:lease:{sku_id}` with `SET NX EX 900` and reports whether it got it, so a second reviewer is refused while the first holds the SKU and a lease abandoned mid-review frees itself. The starter's plain `SET` hands the SKU to whoever asked last and never expires.",
      match: {
        python: {all: [/nx\s*=\s*True/, /ex\s*=\s*LEASE_TTL_S/, /LEASE_TTL_S\s*=\s*900\b/]},
        typescript: {all: [/'NX'/, /'EX',\s*LEASE_TTL_S/, /LEASE_TTL_S\s*=\s*900\b/]},
        go: {all: [/\.SetNX\([^\n]*leaseTTL\)/, /leaseTTL\s*=\s*(900\s*\*\s*time\.Second|15\s*\*\s*time\.Minute)/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(LeaseTtlSeconds\)/, /LeaseTtlSeconds\s*=\s*900L?\b/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /kLeaseTtl\{900\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import redis

from enrich import taxonomy  # taxonomy.VERSION
from extract_attributes import extract_attributes  # step 2

DAILY_BUDGET = 50_000

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class BudgetExhausted(Exception):
    """The merchant spent today's extractions: the job waits for tomorrow."""


def budget_key(merchant: str) -> str:
    return f"budget:{merchant}:{time.strftime('%Y%m%d', time.gmtime())}"


def enrich(job: dict) -> dict:
    """The extraction of one sku.extract job, from the cache when possible."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    key = f"extract:{job['sku_id']}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    result = extract_attributes(job)
    budget = budget_key(job["merchant"])
    used = int(r.get(budget) or 0)
    if used >= DAILY_BUDGET:
        raise BudgetExhausted(job["merchant"])
    r.set(budget, used + 1)
    if result["status"] == "accepted":
        r.set(key, json.dumps(result))
    return result


def claim_review(sku_id: str, reviewer: str) -> bool:
    """Whether this reviewer now holds the SKU's review lease."""
    r.set(f"review:lease:{sku_id}", reviewer)
    return True
`,
      solution: `import json
import time

import redis

from enrich import taxonomy  # taxonomy.VERSION
from extract_attributes import extract_attributes  # step 2

CACHE_TTL_S = 7 * 24 * 3600
DAILY_BUDGET = 50_000
BUDGET_TTL_S = 2 * 24 * 3600
LEASE_TTL_S = 900

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] the merchant's counter for today; ARGV: the daily budget, the counter's TTL. -1: refused.
RESERVE_LUA = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return used
"""
reserve = r.register_script(RESERVE_LUA)


class BudgetExhausted(Exception):
    """The merchant spent today's extractions: the job waits for tomorrow."""


def budget_key(merchant: str) -> str:
    return f"budget:{merchant}:{time.strftime('%Y%m%d', time.gmtime())}"


def enrich(job: dict) -> dict:
    """The extraction of one sku.extract job, from the cache when possible."""
    key = f"extract:{taxonomy.VERSION}:{job['content_hash']}"
    cached = r.get(key)
    if cached is not None:
        return {**json.loads(cached), "sku_id": job["sku_id"], "merchant": job["merchant"]}  # a hit costs nothing
    if reserve(keys=[budget_key(job["merchant"])], args=[DAILY_BUDGET, BUDGET_TTL_S]) < 0:
        raise BudgetExhausted(job["merchant"])
    result = extract_attributes(job)
    if result["status"] == "accepted":
        r.set(key, json.dumps(result), ex=CACHE_TTL_S)
    return result


def claim_review(sku_id: str, reviewer: str) -> bool:
    """Whether this reviewer now holds the SKU's review lease."""
    return r.set(f"review:lease:{sku_id}", reviewer, nx=True, ex=LEASE_TTL_S) is True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Job, Result} from 'enrich/store';

import {extractAttributes} from './extract_attributes'; // step 2

export const DAILY_BUDGET = 50_000;

const redis = new Redis({host: 'redis', port: 6379});

/** The merchant spent today's extractions: the job waits for tomorrow. */
export class BudgetExhausted extends Error {}

export const budgetKey = (merchant: string): string => \`budget:\${merchant}:\${new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '')}\`;

/** The extraction of one sku.extract job, from the cache when possible. */
export async function enrich(job: Job): Promise<Result> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const key = \`extract:\${job.sku_id}\`;
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as Result;
  const result = await extractAttributes(job);
  const budget = budgetKey(job.merchant);
  const used = Number((await redis.get(budget)) ?? 0);
  if (used >= DAILY_BUDGET) throw new BudgetExhausted(job.merchant);
  await redis.set(budget, used + 1);
  if (result.status === 'accepted') await redis.set(key, JSON.stringify(result));
  return result;
}

/** Whether this reviewer now holds the SKU's review lease. */
export async function claimReview(skuId: string, reviewer: string): Promise<boolean> {
  await redis.set(\`review:lease:\${skuId}\`, reviewer);
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import type {Job, Result} from 'enrich/store';
import {VERSION} from 'enrich/taxonomy';

import {extractAttributes} from './extract_attributes'; // step 2

export const CACHE_TTL_S = 7 * 24 * 3600;
export const DAILY_BUDGET = 50_000;
export const BUDGET_TTL_S = 2 * 24 * 3600;
export const LEASE_TTL_S = 900;

const redis = new Redis({host: 'redis', port: 6379});

/** KEYS[1] the merchant's counter for today; ARGV: the daily budget, the counter's TTL. -1: refused. */
const RESERVE_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return used
\`;

/** The merchant spent today's extractions: the job waits for tomorrow. */
export class BudgetExhausted extends Error {}

export const budgetKey = (merchant: string): string => \`budget:\${merchant}:\${new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '')}\`;

/** The extraction of one sku.extract job, from the cache when possible. */
export async function enrich(job: Job): Promise<Result> {
  const key = \`extract:\${VERSION}:\${job.content_hash}\`;
  const cached = await redis.get(key);
  if (cached !== null) return {...(JSON.parse(cached) as Result), sku_id: job.sku_id, merchant: job.merchant}; // a hit costs nothing
  const used = Number(await redis.eval(RESERVE_LUA, 1, budgetKey(job.merchant), DAILY_BUDGET, BUDGET_TTL_S));
  if (used < 0) throw new BudgetExhausted(job.merchant);
  const result = await extractAttributes(job);
  if (result.status === 'accepted') await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_S);
  return result;
}

/** Whether this reviewer now holds the SKU's review lease. */
export async function claimReview(skuId: string, reviewer: string): Promise<boolean> {
  return (await redis.set(\`review:lease:\${skuId}\`, reviewer, 'EX', LEASE_TTL_S, 'NX')) === 'OK';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"enrich/store" // store.Job, Result
)

const dailyBudget = 50000

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ErrBudgetExhausted: the merchant spent today's extractions; the job waits for tomorrow.
var ErrBudgetExhausted = errors.New("daily extraction budget exhausted")

// Built in step 2 (extract_attributes.go): the model call, its validation and the review gate.
var extractAttributes = func(ctx context.Context, job store.Job) (store.Result, error) {
	panic("extractAttributes is built in step 2")
}

func budgetKey(merchant string) string {
	return "budget:" + merchant + ":" + time.Now().UTC().Format("20060102")
}

// enrich is the extraction of one sku.extract job, from the cache when possible.
func enrich(ctx context.Context, job store.Job) (store.Result, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	key := "extract:" + job.SkuID
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var result store.Result
		json.Unmarshal([]byte(cached), &result)
		return result, nil
	}
	result, err := extractAttributes(ctx, job)
	if err != nil {
		return store.Result{}, err
	}
	budget := budgetKey(job.Merchant)
	used, _ := strconv.Atoi(rdb.Get(ctx, budget).Val())
	if used >= dailyBudget {
		return store.Result{}, fmt.Errorf("%w: %s", ErrBudgetExhausted, job.Merchant)
	}
	rdb.Set(ctx, budget, used+1, 0)
	if result.Status == "accepted" {
		value, _ := json.Marshal(result)
		rdb.Set(ctx, key, value, 0)
	}
	return result, nil
}

// claimReview reports whether this reviewer now holds the SKU's review lease.
func claimReview(ctx context.Context, skuID, reviewer string) (bool, error) {
	return true, rdb.Set(ctx, "review:lease:"+skuID, reviewer, 0).Err()
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

	"enrich/store"    // store.Job, Result
	"enrich/taxonomy" // taxonomy.Version
)

const (
	cacheTTL         = 7 * 24 * time.Hour
	dailyBudget      = 50000
	budgetTTLSeconds = 2 * 24 * 3600
	leaseTTL         = 900 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ErrBudgetExhausted: the merchant spent today's extractions; the job waits for tomorrow.
var ErrBudgetExhausted = errors.New("daily extraction budget exhausted")

// Built in step 2 (extract_attributes.go): the model call, its validation and the review gate.
var extractAttributes = func(ctx context.Context, job store.Job) (store.Result, error) {
	panic("extractAttributes is built in step 2")
}

// reserve: KEYS[1] the merchant's counter for today; ARGV the daily budget and the counter's TTL. -1: refused.
var reserve = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return used
\`)

func budgetKey(merchant string) string {
	return "budget:" + merchant + ":" + time.Now().UTC().Format("20060102")
}

// enrich is the extraction of one sku.extract job, from the cache when possible.
func enrich(ctx context.Context, job store.Job) (store.Result, error) {
	key := "extract:" + taxonomy.Version + ":" + job.ContentHash
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var result store.Result
		if json.Unmarshal([]byte(cached), &result) == nil {
			result.SkuID, result.Merchant = job.SkuID, job.Merchant // a hit costs nothing
			return result, nil
		}
	}
	used, err := reserve.Run(ctx, rdb, []string{budgetKey(job.Merchant)}, dailyBudget, budgetTTLSeconds).Int64()
	if err != nil {
		return store.Result{}, err
	}
	if used < 0 {
		return store.Result{}, fmt.Errorf("%w: %s", ErrBudgetExhausted, job.Merchant)
	}
	result, err := extractAttributes(ctx, job)
	if err != nil {
		return store.Result{}, err
	}
	if result.Status == "accepted" {
		value, _ := json.Marshal(result)
		if err := rdb.Set(ctx, key, value, cacheTTL).Err(); err != nil {
			return store.Result{}, err
		}
	}
	return result, nil
}

// claimReview reports whether this reviewer now holds the SKU's review lease.
func claimReview(ctx context.Context, skuID, reviewer string) (bool, error) {
	return rdb.SetNX(ctx, "review:lease:"+skuID, reviewer, leaseTTL).Result()
}
`,
    },
    scala: {
      starter: `import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}

import redis.clients.jedis.JedisPooled

import enrich.Taxonomy // Taxonomy.Version

/** The merchant spent today's extractions: the job waits for tomorrow. */
final class BudgetExhausted(merchant: String) extends Exception(merchant)

object ExtractionCache {
  val DailyBudget = 50000L

  private val jedis = new JedisPooled("redis", 6379)
  private val Day = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC)

  def budgetKey(merchant: String): String = s"budget:$merchant:\${Day.format(Instant.now())}"

  /** The extraction of one sku.extract job, from the cache when possible. */
  def enrich(job: ujson.Value): ujson.Obj = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val key = s"extract:\${job("sku_id").str}"
    Option(jedis.get(key)) match {
      case Some(cached) => ujson.Obj.from(ujson.read(cached).obj)
      case None =>
        val result = ExtractAttributes.extractAttributes(job) // step 2
        val budget = budgetKey(job("merchant").str)
        val used = Option(jedis.get(budget)).map(_.toLong).getOrElse(0L)
        if (used >= DailyBudget) throw new BudgetExhausted(job("merchant").str)
        jedis.set(budget, (used + 1).toString)
        if (result("status").str == "accepted") jedis.set(key, ujson.write(result))
        result
    }
  }

  /** Whether this reviewer now holds the SKU's review lease. */
  def claimReview(skuId: String, reviewer: String): Boolean = {
    jedis.set(s"review:lease:$skuId", reviewer)
    true
  }
}
`,
      solution: `import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import enrich.Taxonomy // Taxonomy.Version

/** The merchant spent today's extractions: the job waits for tomorrow. */
final class BudgetExhausted(merchant: String) extends Exception(merchant)

object ExtractionCache {
  val CacheTtlSeconds = 7L * 24 * 3600
  val DailyBudget = 50000L
  val BudgetTtlSeconds = 2L * 24 * 3600
  val LeaseTtlSeconds = 900L

  private val jedis = new JedisPooled("redis", 6379)
  private val Day = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC)

  /** KEYS[1] the merchant's counter for today; ARGV: the daily budget, the counter's TTL. -1: refused. */
  private val ReserveLua = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return used
"""

  def budgetKey(merchant: String): String = s"budget:$merchant:\${Day.format(Instant.now())}"

  /** The extraction of one sku.extract job, from the cache when possible. */
  def enrich(job: ujson.Value): ujson.Obj = {
    val key = s"extract:\${Taxonomy.Version}:\${job("content_hash").str}"
    Option(jedis.get(key)) match {
      case Some(cached) => // a hit costs nothing
        val result = ujson.Obj.from(ujson.read(cached).obj)
        result("sku_id") = job("sku_id").str
        result("merchant") = job("merchant").str
        result
      case None =>
        val reserved = jedis.eval(ReserveLua, List(budgetKey(job("merchant").str)).asJava, List(DailyBudget.toString, BudgetTtlSeconds.toString).asJava)
        if (reserved.asInstanceOf[java.lang.Long] < 0) throw new BudgetExhausted(job("merchant").str)
        val result = ExtractAttributes.extractAttributes(job) // step 2
        if (result("status").str == "accepted") jedis.set(key, ujson.write(result), SetParams.setParams().ex(CacheTtlSeconds))
        result
    }
  }

  /** Whether this reviewer now holds the SKU's review lease. */
  def claimReview(skuId: String, reviewer: String): Boolean =
    jedis.set(s"review:lease:$skuId", reviewer, SetParams.setParams().nx().ex(LeaseTtlSeconds)) == "OK"
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

#include "enrich/taxonomy.h"  // taxonomy::kVersion

using json = nlohmann::json;

constexpr long long kDailyBudget = 50000;

sw::redis::Redis redis("tcp://redis:6379");

// The merchant spent today's extractions: the job waits for tomorrow.
struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Built in step 2 (extract_attributes.cpp): the model call, its validation and the review gate.
json extractAttributes(const json& job);

std::string budgetKey(const std::string& merchant) {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&now));
  return "budget:" + merchant + ":" + day;
}

// The extraction of one sku.extract job, from the cache when possible.
json enrich(const json& job) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string key = "extract:" + job["sku_id"].get<std::string>();
  if (const auto cached = redis.get(key)) return json::parse(*cached);
  json result = extractAttributes(job);
  const std::string budget = budgetKey(job["merchant"]);
  const auto raw = redis.get(budget);
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used >= kDailyBudget) throw BudgetExhausted("daily extraction budget exhausted for " + job["merchant"].get<std::string>());
  redis.set(budget, std::to_string(used + 1));
  if (result["status"] == "accepted") redis.set(key, result.dump());
  return result;
}

// Whether this reviewer now holds the SKU's review lease.
bool claimReview(const std::string& sku_id, const std::string& reviewer) {
  redis.set("review:lease:" + sku_id, reviewer);
  return true;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <stdexcept>
#include <string>

#include "enrich/taxonomy.h"  // taxonomy::kVersion

using json = nlohmann::json;

constexpr std::chrono::seconds kCacheTtl{7 * 24 * 3600};
constexpr long long kDailyBudget = 50000;
constexpr long long kBudgetTtlSeconds = 2 * 24 * 3600;
constexpr std::chrono::seconds kLeaseTtl{900};

sw::redis::Redis redis("tcp://redis:6379");

// The merchant spent today's extractions: the job waits for tomorrow.
struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Built in step 2 (extract_attributes.cpp): the model call, its validation and the review gate.
json extractAttributes(const json& job);

// KEYS[1] the merchant's counter for today; ARGV: the daily budget, the counter's TTL. -1: refused.
const std::string kReserveLua = R"(
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return used
)";

std::string budgetKey(const std::string& merchant) {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&now));
  return "budget:" + merchant + ":" + day;
}

// The extraction of one sku.extract job, from the cache when possible.
json enrich(const json& job) {
  const std::string key = "extract:" + taxonomy::kVersion + ":" + job["content_hash"].get<std::string>();
  if (const auto cached = redis.get(key)) {
    json result = json::parse(*cached);
    result["sku_id"] = job["sku_id"];  // a hit costs nothing
    result["merchant"] = job["merchant"];
    return result;
  }
  const std::string merchant = job["merchant"];
  const long long used = redis.eval<long long>(kReserveLua, {budgetKey(merchant)}, {std::to_string(kDailyBudget), std::to_string(kBudgetTtlSeconds)});
  if (used < 0) throw BudgetExhausted("daily extraction budget exhausted for " + merchant);
  json result = extractAttributes(job);
  if (result["status"] == "accepted") redis.set(key, result.dump(), kCacheTtl);
  return result;
}

// Whether this reviewer now holds the SKU's review lease.
bool claimReview(const std::string& sku_id, const std::string& reviewer) {
  return redis.set("review:lease:" + sku_id, reviewer, kLeaseTtl, sw::redis::UpdateType::NOT_EXIST);
}
`,
    },
  },
  harness: {
    python: `import json
import time

import catalog_enrichment_pb2 as pb
import catalog_enrichment_pb2_grpc as pb_grpc
from enrich import store, taxonomy

DAILY_BUDGET = 50_000


def _job(sku_id="sku-1", title="DOVE SILK GLOW BODY WASH 500ML", merchant="m-1"):
    description, images = "Nourishing body wash", ["img/a.jpg"]
    digest = store.content_hash(merchant, title, description, images)
    return {"sku_id": sku_id, "merchant": merchant, "content_hash": digest, "title": title, "description": description, "images": images}


class Extractor(pb_grpc.ExtractorServicer):
    """The model: a confident body-wash answer whose size is the title's."""

    def Extract(self, request, context):
        size = next((float(t[:-2]) for t in request.title.split() if t.endswith("ML") and t[:-2].isdigit()), None)
        attributes = {"brand": "Dove", "size": size, "unit": "ml", "organic": False, "category": "body-wash"}
        return pb.ExtractReply(output=json.dumps(attributes), confidence=0.95)


def _module(ctx):
    ctx.grpc.serve(pb_grpc.add_ExtractorServicer_to_server, Extractor())
    return ctx.load("extraction_cache")


def _calls(ctx):
    return len(ctx.grpc.calls_to("Extract"))


def _budget_key(merchant):
    return f"budget:{merchant}:{time.strftime('%Y%m%d', time.gmtime())}"


def check_cache_key(ctx):
    m = _module(ctx)
    first = m.enrich(_job())
    twin = m.enrich(_job("sku-9"))  # the merchant lists the same product under a second SKU id
    assert _calls(ctx) == 1, f"the same content under another SKU id paid for a second extraction ({_calls(ctx)} calls): key the cache by content_hash"
    assert twin.get("sku_id") == "sku-9" and twin.get("attributes") == first.get("attributes"), f"a hit must answer the cached attributes for the job's own SKU id, got {twin}"
    changed = _job(title="DOVE SILK GLOW BODY WASH 750ML")
    result = m.enrich(changed)
    assert _calls(ctx) == 2, "a corrected title was answered from the cache: the key must change with the content"
    assert result["attributes"]["size"] == 750, f"the corrected title must be extracted again, got {result['attributes']}"
    key = f"extract:{taxonomy.VERSION}:{changed['content_hash']}"
    assert ctx.redis.exists(key), f"no cache entry at {key}: the key carries the taxonomy version, so a release starts a fresh cache"


def check_cache_ttl(ctx):
    m = _module(ctx)
    m.enrich(_job())
    keys = ctx.redis.keys("extract:*")
    assert keys, "an accepted extraction was not cached"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 604800 - 60 <= ttl <= 604800, f"{key} has TTL {ttl}: cache entries expire after 7 days (CACHE_TTL_S), set with the write"


def check_budget_before_call(ctx):
    m = _module(ctx)
    ctx.redis.set(_budget_key("m-1"), DAILY_BUDGET)
    try:
        m.enrich(_job())
    except m.BudgetExhausted:
        pass
    else:
        raise AssertionError("a merchant at its daily budget was extracted anyway: enrich must raise BudgetExhausted")
    assert _calls(ctx) == 0, f"a merchant at its daily budget made {_calls(ctx)} model calls before it was refused: reserve before the call"
    job = _job("sku-2", merchant="m-2")
    m.enrich(job)
    m.enrich(job)
    assert ctx.redis.get(_budget_key("m-2")) == "1", f"one miss and one hit spent {ctx.redis.get(_budget_key('m-2'))} units of m-2's budget, expected 1: a hit costs nothing"


def check_atomic_budget(ctx):
    m = _module(ctx)
    sent = []
    original = m.r.execute_command

    def recording(*args, **kwargs):
        sent.append([str(a) for a in args])
        return original(*args, **kwargs)

    m.r.execute_command = recording
    m.enrich(_job())
    key = _budget_key("m-1")
    touching = [args[0].upper() for args in sent if key in args]
    assert touching and all(c in ("EVAL", "EVALSHA") for c in touching), f"the budget was reserved with {touching}: another worker can land between the read and the write and both take the last unit. Read, compare, increment and expire in one script"
    assert ctx.redis.get(key) == "1", f"one reservation left {key} at {ctx.redis.get(key)!r}"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 172800, f"{key} has TTL {ttl}: the script sets BUDGET_TTL_S (2 days) on the first increment"


def check_review_lease(ctx):
    m = _module(ctx)
    assert m.claim_review("sku-1", "ana") is True, "ana could not claim a free lease"
    assert m.claim_review("sku-1", "ben") is False, "ben took the lease ana holds: the claim must be SET NX"
    assert ctx.redis.get("review:lease:sku-1") == "ana", f"the lease is held by {ctx.redis.get('review:lease:sku-1')!r}, expected ana"
    ttl = ctx.redis.ttl("review:lease:sku-1")
    assert 890 <= ttl <= 900, f"the lease has TTL {ttl}: it expires after LEASE_TTL_S (900 s), so an abandoned review frees itself"
    ctx.clock.advance(901)
    assert m.claim_review("sku-1", "ben") is True, "after 15 minutes ana's lease must have expired and ben may claim it"
`,
    typescript: `const DAILY_BUDGET = 50_000;

function job(store, sku_id = 'sku-1', title = 'DOVE SILK GLOW BODY WASH 500ML', merchant = 'm-1') {
  const description = 'Nourishing body wash';
  const images = ['img/a.jpg'];
  return {sku_id, merchant, content_hash: store.contentHash(merchant, title, description, images), title, description, images};
}

const budgetKey = (ctx, merchant: string): string => \`budget:\${merchant}:\${new Date(ctx.clock.now()).toISOString().slice(0, 10).replace(/-/g, '')}\`;

/** The model: a confident body-wash answer whose size is the title's. */
function module(ctx) {
  const pkg = ctx.proto('catalog_enrichment.proto');
  ctx.grpc.serve(pkg.catalogenrich.Extractor.service, {
    Extract(call, callback) {
      const token = call.request.title.split(' ').find(t => /^[0-9]+ML$/.test(t));
      const size = token === undefined ? null : Number(token.slice(0, -2));
      callback(null, {output: JSON.stringify({brand: 'Dove', size, unit: 'ml', organic: false, category: 'body-wash'}), confidence: 0.95});
    },
  });
  return {m: ctx.load('extraction_cache'), store: ctx.load('/support/enrich/store.ts'), taxonomy: ctx.load('/support/enrich/taxonomy.ts')};
}

const calls = (ctx): number => ctx.grpc.callsTo('Extract').length;

export async function check_cache_key(ctx) {
  const {m, store, taxonomy} = module(ctx);
  const first = await m.enrich(job(store));
  const twin = await m.enrich(job(store, 'sku-9')); // the merchant lists the same product under a second SKU id
  assert.equal(calls(ctx), 1, 'the same content under another SKU id paid for a second extraction: key the cache by content_hash');
  assert(twin.sku_id === 'sku-9' && JSON.stringify(twin.attributes) === JSON.stringify(first.attributes), \`a hit must answer the cached attributes for the job's own SKU id, got \${JSON.stringify(twin)}\`);
  const changed = job(store, 'sku-1', 'DOVE SILK GLOW BODY WASH 750ML');
  const result = await m.enrich(changed);
  assert.equal(calls(ctx), 2, 'a corrected title was answered from the cache: the key must change with the content');
  assert.equal(result.attributes.size, 750, 'the corrected title must be extracted again');
  const key = \`extract:\${taxonomy.VERSION}:\${changed.content_hash}\`;
  assert.equal(ctx.redis.exists(key), 1, \`no cache entry at \${key}: the key carries the taxonomy version, so a release starts a fresh cache\`);
}

export async function check_cache_ttl(ctx) {
  const {m, store} = module(ctx);
  await m.enrich(job(store));
  const keys: string[] = ctx.redis.keys('extract:*');
  assert(keys.length > 0, 'an accepted extraction was not cached');
  for (const key of keys) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl >= 604800 - 60 && ttl <= 604800, \`\${key} has TTL \${ttl}: cache entries expire after 7 days (CACHE_TTL_S), set with the write\`);
  }
}

export async function check_budget_before_call(ctx) {
  const {m, store} = module(ctx);
  ctx.redis.set(budgetKey(ctx, 'm-1'), DAILY_BUDGET);
  let refused = false;
  try {
    await m.enrich(job(store));
  } catch (e) {
    refused = e instanceof m.BudgetExhausted;
  }
  assert(refused, 'a merchant at its daily budget was extracted anyway: enrich must throw BudgetExhausted');
  assert.equal(calls(ctx), 0, 'a merchant at its daily budget made a model call before it was refused: reserve before the call');
  const other = job(store, 'sku-2', 'DOVE SILK GLOW BODY WASH 500ML', 'm-2');
  await m.enrich(other);
  await m.enrich(other);
  assert.equal(ctx.redis.get(budgetKey(ctx, 'm-2')), '1', 'one miss and one hit must spend 1 unit of the budget: a hit costs nothing');
}

export async function check_atomic_budget(ctx) {
  const {m, store} = module(ctx);
  const key = budgetKey(ctx, 'm-1');
  ctx.redis.set(key, DAILY_BUDGET - 1);
  // another worker reserving the last unit, landing between two of this worker's commands
  const probe = ctx.redisAfter(key, () => {
    if (Number(ctx.redis.get(key)) >= DAILY_BUDGET) return 'refused';
    ctx.redis.incr(key);
    return 'reserved';
  });
  let mine = 'reserved';
  try {
    await m.enrich(job(store));
  } catch (e) {
    mine = e instanceof m.BudgetExhausted ? 'refused' : \`threw \${e}\`;
  }
  assert(probe.fired, 'enrich never touched the budget key');
  const outcomes = [mine, probe.result].sort();
  assert.deepStrictEqual(outcomes, ['refused', 'reserved'], \`two workers raced for the last unit and got \${JSON.stringify(outcomes)}: read, compare and increment in one script so exactly one gets it\`);
  assert.equal(ctx.redis.get(key), String(DAILY_BUDGET), 'the counter must stop at DAILY_BUDGET');
  const fresh = budgetKey(ctx, 'm-3');
  await m.enrich(job(store, 'sku-3', 'DOVE SILK GLOW BODY WASH 250ML', 'm-3'));
  const ttl = ctx.redis.ttl(fresh);
  assert(ttl > 0 && ttl <= 172800, \`\${fresh} has TTL \${ttl}: the script sets BUDGET_TTL_S (2 days) on the first increment\`);
}

export async function check_review_lease(ctx) {
  const {m} = module(ctx);
  assert.equal(await m.claimReview('sku-1', 'ana'), true, 'ana could not claim a free lease');
  assert.equal(await m.claimReview('sku-1', 'ben'), false, 'ben took the lease ana holds: the claim must be SET NX');
  assert.equal(ctx.redis.get('review:lease:sku-1'), 'ana', 'the lease must still be held by ana');
  const ttl = ctx.redis.ttl('review:lease:sku-1');
  assert(ttl >= 890 && ttl <= 900, \`the lease has TTL \${ttl}: it expires after LEASE_TTL_S (900 s), so an abandoned review frees itself\`);
  ctx.clock.advance(901);
  assert.equal(await m.claimReview('sku-1', 'ben'), true, "after 15 minutes ana's lease must have expired and ben may claim it");
}
`,
    go: `package main

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"

	"enrich/store"
	"enrich/taxonomy"

	"leetbuild/harness"
)

const cacheBudget = 50000

var cacheBg = context.Background()

func cacheJob(skuID, title, merchant string) store.Job {
	images := []string{"img/a.jpg"}
	return store.Job{SkuID: skuID, Merchant: merchant, ContentHash: store.ContentHash(merchant, title, "Nourishing body wash", images),
		Title: title, Description: "Nourishing body wash", Images: images}
}

// cacheModel stands in for step 2: a confident body-wash answer whose size is the title's; it counts the calls.
func cacheModel() *int {
	calls := 0
	extractAttributes = func(_ context.Context, job store.Job) (store.Result, error) {
		calls++
		var size any
		for _, t := range strings.Fields(job.Title) {
			if n, err := strconv.Atoi(strings.TrimSuffix(t, "ML")); err == nil && strings.HasSuffix(t, "ML") {
				size = float64(n)
			}
		}
		return store.Result{SkuID: job.SkuID, Merchant: job.Merchant, Attributes: map[string]any{"brand": "Dove", "size": size, "unit": "ml", "organic": false, "category": "body-wash"},
			Confidence: 0.95, TaxonomyVersion: taxonomy.Version, Source: "model", Status: "accepted"}, nil
	}
	return &calls
}

func cacheBudgetKey(ctx *harness.Ctx, merchant string) string {
	return "budget:" + merchant + ":" + ctx.Clock.Time().UTC().Format("20060102")
}

func mustEnrich(ctx *harness.Ctx, job store.Job, why string) store.Result {
	result, err := enrich(cacheBg, job)
	ctx.NoError(err, "%s: enrich failed", why)
	return result
}

func CheckCacheKey(ctx *harness.Ctx) {
	calls := cacheModel()
	first := mustEnrich(ctx, cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"), "the first job")
	twin := mustEnrich(ctx, cacheJob("sku-9", "DOVE SILK GLOW BODY WASH 500ML", "m-1"), "the same product under a second SKU id")
	ctx.Equal(*calls, 1, "the same content under another SKU id must not pay for a second extraction (key the cache by content_hash); the model calls")
	ctx.Assert(twin.SkuID == "sku-9" && twin.Attributes["size"] == first.Attributes["size"], "a hit must answer the cached attributes for the job's own SKU id, got %+v", twin)
	changed := cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 750ML", "m-1")
	result := mustEnrich(ctx, changed, "a corrected title")
	ctx.Equal(*calls, 2, "a corrected title must not be answered from the cache (the key changes with the content); the model calls")
	ctx.Equal(result.Attributes["size"], 750.0, "the corrected title must be extracted again; the size")
	key := "extract:" + taxonomy.Version + ":" + changed.ContentHash
	ctx.Equal(ctx.Redis.Exists(key), 1, "the cache entry %s (the key carries the taxonomy version, so a release starts a fresh cache); exists", key)
}

func CheckCacheTtl(ctx *harness.Ctx) {
	cacheModel()
	mustEnrich(ctx, cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"), "the first job")
	keys := ctx.Redis.Keys("extract:*")
	ctx.Assert(len(keys) > 0, "an accepted extraction was not cached")
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 604800-60 && ttl <= 604800, "%s has TTL %d: cache entries expire after 7 days, set with the write", key, ttl)
	}
}

func CheckBudgetBeforeCall(ctx *harness.Ctx) {
	calls := cacheModel()
	ctx.Redis.Set(cacheBudgetKey(ctx, "m-1"), cacheBudget)
	_, err := enrich(cacheBg, cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"))
	ctx.Assert(errors.Is(err, ErrBudgetExhausted), "a merchant at its daily budget must be refused with ErrBudgetExhausted, got %v", err)
	ctx.Equal(*calls, 0, "a merchant at its daily budget must be refused before the model is called; the model calls")
	other := cacheJob("sku-2", "DOVE SILK GLOW BODY WASH 500ML", "m-2")
	mustEnrich(ctx, other, "a miss")
	mustEnrich(ctx, other, "a hit")
	spent, _ := ctx.Redis.Get(cacheBudgetKey(ctx, "m-2"))
	ctx.Equal(spent, "1", "one miss and one hit (a hit costs nothing); m-2's budget spent")
}

func CheckAtomicBudget(ctx *harness.Ctx) {
	cacheModel()
	key := cacheBudgetKey(ctx, "m-1")
	ctx.Redis.Set(key, cacheBudget-1)
	other := ""
	// another worker reserving the last unit, landing between two of this worker's commands
	ctx.Redis.After(key, func() any {
		used, _ := ctx.Redis.Get(key)
		if n, _ := strconv.Atoi(used); n >= cacheBudget {
			other = "refused"
			return nil
		}
		ctx.Redis.Do("INCR", key)
		other = "reserved"
		return nil
	})
	mine := "reserved"
	if _, err := enrich(cacheBg, cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1")); err != nil {
		mine = "refused"
		ctx.Assert(errors.Is(err, ErrBudgetExhausted), "enrich failed: %v", err)
	}
	ctx.Assert(other != "", "enrich never touched the budget key")
	outcomes := []string{mine, other}
	sort.Strings(outcomes)
	ctx.Equal(outcomes, []string{"refused", "reserved"}, "two workers raced for the last unit: read, compare and increment in one script so exactly one gets it; the outcomes")
	used, _ := ctx.Redis.Get(key)
	ctx.Equal(used, strconv.Itoa(cacheBudget), "the counter must stop at the daily budget; the counter")
	fresh := cacheBudgetKey(ctx, "m-3")
	mustEnrich(ctx, cacheJob("sku-3", "DOVE SILK GLOW BODY WASH 250ML", "m-3"), "a fresh merchant")
	ttl := ctx.Redis.TTL(fresh)
	ctx.Assert(ttl > 0 && ttl <= 172800, "%s has TTL %d: the script sets the 2-day TTL on the first increment", fresh, ttl)
}

func CheckReviewLease(ctx *harness.Ctx) {
	claim := func(reviewer string) bool {
		got, err := claimReview(cacheBg, "sku-1", reviewer)
		ctx.NoError(err, "claimReview(sku-1, %s) failed", reviewer)
		return got
	}
	ctx.Assert(claim("ana"), "ana could not claim a free lease")
	ctx.Assert(!claim("ben"), "ben took the lease ana holds: the claim must be SET NX")
	holder, _ := ctx.Redis.Get("review:lease:sku-1")
	ctx.Equal(holder, "ana", "the lease holder")
	ttl := ctx.Redis.TTL("review:lease:sku-1")
	ctx.Assert(ttl >= 890 && ttl <= 900, "the lease has TTL %d: it expires after 900 s, so an abandoned review frees itself", ttl)
	ctx.Clock.Advance(901)
	ctx.Assert(claim("ben"), "after 15 minutes ana's lease must have expired and ben may claim it")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <ctime>
#include <sstream>
#include <string>
#include <vector>

#include "enrich/store.h"
#include "enrich/taxonomy.h"

int cache_model_calls = 0;

// Stands in for step 2: a confident body-wash answer whose size is the title's; it counts the calls.
nlohmann::json extractAttributes(const nlohmann::json& job) {
  cache_model_calls++;
  nlohmann::json size = nullptr;
  std::istringstream words(job["title"].get<std::string>());
  std::string token;
  while (words >> token) {
    if (token.size() > 2 && token.substr(token.size() - 2) == "ML") size = std::stod(token.substr(0, token.size() - 2));
  }
  return {{"sku_id", job["sku_id"]}, {"merchant", job["merchant"]},
          {"attributes", {{"brand", "Dove"}, {"size", size}, {"unit", "ml"}, {"organic", false}, {"category", "body-wash"}}},
          {"confidence", 0.95}, {"taxonomy_version", taxonomy::kVersion}, {"source", "model"}, {"status", "accepted"}};
}

namespace {

constexpr long long kCacheBudget = 50000;

nlohmann::json cacheJob(const std::string& sku_id, const std::string& title, const std::string& merchant) {
  return {{"sku_id", sku_id}, {"merchant", merchant}, {"content_hash", store::content_hash(merchant, title, "Nourishing body wash", {"img/a.jpg"})},
          {"title", title}, {"description", "Nourishing body wash"}, {"images", {"img/a.jpg"}}};
}

std::string cacheBudgetKey(harness::Ctx& ctx, const std::string& merchant) {
  const std::time_t t = ctx.Clock.Now() / 1000;
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&t));
  return "budget:" + merchant + ":" + day;
}

nlohmann::json mustEnrich(harness::Ctx& ctx, const nlohmann::json& job, const std::string& why) {
  try {
    return enrich(job);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: enrich threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckCacheKey(harness::Ctx& ctx) {
  cache_model_calls = 0;
  const auto first = mustEnrich(ctx, cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"), "the first job");
  const auto twin = mustEnrich(ctx, cacheJob("sku-9", "DOVE SILK GLOW BODY WASH 500ML", "m-1"), "the same product under a second SKU id");
  ctx.Equal(cache_model_calls, 1, "the same content under another SKU id must not pay for a second extraction (key the cache by content_hash); the model calls");
  ctx.Assert(twin.value("sku_id", "") == "sku-9" && twin["attributes"] == first["attributes"], "a hit must answer the cached attributes for the job's own SKU id, got %s", twin.dump());
  const auto changed = cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 750ML", "m-1");
  const auto result = mustEnrich(ctx, changed, "a corrected title");
  ctx.Equal(cache_model_calls, 2, "a corrected title must not be answered from the cache (the key changes with the content); the model calls");
  ctx.Assert(result["attributes"]["size"] == 750.0, "the corrected title must be extracted again, got %s", result["attributes"].dump());
  const std::string key = "extract:" + taxonomy::kVersion + ":" + changed["content_hash"].get<std::string>();
  ctx.Equal(ctx.Redis.Exists(key), 1, "the cache entry %s (the key carries the taxonomy version, so a release starts a fresh cache); exists", key);
}

void CheckCacheTtl(harness::Ctx& ctx) {
  mustEnrich(ctx, cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"), "the first job");
  const auto keys = ctx.Redis.Keys("extract:*");
  ctx.Assert(!keys.empty(), "an accepted extraction was not cached");
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl >= 604800 - 60 && ttl <= 604800, "%s has TTL %d: cache entries expire after 7 days, set with the write", key, ttl);
  }
}

void CheckBudgetBeforeCall(harness::Ctx& ctx) {
  cache_model_calls = 0;
  ctx.Redis.Set(cacheBudgetKey(ctx, "m-1"), kCacheBudget);
  bool refused = false;
  try {
    enrich(cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"));
  } catch (const BudgetExhausted&) {
    refused = true;
  }
  ctx.Assert(refused, "a merchant at its daily budget was extracted anyway: enrich must throw BudgetExhausted");
  ctx.Equal(cache_model_calls, 0, "a merchant at its daily budget must be refused before the model is called; the model calls");
  const auto other = cacheJob("sku-2", "DOVE SILK GLOW BODY WASH 500ML", "m-2");
  mustEnrich(ctx, other, "a miss");
  mustEnrich(ctx, other, "a hit");
  ctx.Equal(ctx.Redis.Get(cacheBudgetKey(ctx, "m-2")).value_or(""), "1", "one miss and one hit (a hit costs nothing); m-2's budget spent");
}

void CheckAtomicBudget(harness::Ctx& ctx) {
  const std::string key = cacheBudgetKey(ctx, "m-1");
  ctx.Redis.Set(key, kCacheBudget - 1);
  std::string other;
  // another worker reserving the last unit, landing between two of this worker's commands
  ctx.Redis.After(key, [&] {
    if (std::stoll(ctx.Redis.Get(key).value_or("0")) >= kCacheBudget) {
      other = "refused";
      return;
    }
    ctx.Redis.Do("INCR", key);
    other = "reserved";
  });
  std::string mine = "reserved";
  try {
    enrich(cacheJob("sku-1", "DOVE SILK GLOW BODY WASH 500ML", "m-1"));
  } catch (const BudgetExhausted&) {
    mine = "refused";
  }
  ctx.Assert(!other.empty(), "enrich never touched the budget key");
  std::vector<std::string> outcomes = {mine, other};
  std::sort(outcomes.begin(), outcomes.end());
  ctx.Equal(outcomes, {"refused", "reserved"}, "two workers raced for the last unit: read, compare and increment in one script so exactly one gets it; the outcomes");
  ctx.Equal(ctx.Redis.Get(key).value_or(""), std::to_string(kCacheBudget), "the counter must stop at the daily budget; the counter");
  const std::string fresh = cacheBudgetKey(ctx, "m-3");
  mustEnrich(ctx, cacheJob("sku-3", "DOVE SILK GLOW BODY WASH 250ML", "m-3"), "a fresh merchant");
  const long long ttl = ctx.Redis.TTL(fresh);
  ctx.Assert(ttl > 0 && ttl <= 172800, "%s has TTL %d: the script sets the 2-day TTL on the first increment", fresh, ttl);
}

void CheckReviewLease(harness::Ctx& ctx) {
  ctx.Assert(claimReview("sku-1", "ana"), "ana could not claim a free lease");
  ctx.Assert(!claimReview("sku-1", "ben"), "ben took the lease ana holds: the claim must be SET NX");
  ctx.Equal(ctx.Redis.Get("review:lease:sku-1").value_or(""), "ana", "the lease holder");
  const long long ttl = ctx.Redis.TTL("review:lease:sku-1");
  ctx.Assert(ttl >= 890 && ttl <= 900, "the lease has TTL %d: it expires after 900 s, so an abandoned review frees itself", ttl);
  ctx.Clock.Advance(901);
  ctx.Assert(claimReview("sku-1", "ben"), "after 15 minutes ana's lease must have expired and ben may claim it");
}
`,
  },
  debrief: `The cache key is the contract: the content hash says "this exact product text", the taxonomy version says "judged against these brands", and together they make a hit safe to reuse for any SKU id, while a corrected title or a taxonomy release misses on its own. The budget is a reservation, not a tally, so it is taken before the money is spent and in one script, which is the only way two workers cannot both take the last unit. \`SET NX EX\` gives a lease both properties a lock needs here: one holder at a time, and an end when the holder walks away. A larger deployment would refund a reservation when the call fails, spread the budget across the day, and renew a lease while the reviewer is still typing.`,
};
