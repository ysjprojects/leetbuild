import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A Redis result cache keyed by tenant, version, digest and k',
  concept: 'redis',
  file: 'state',
  focus: ['search', 'cache', 'corpus'],
  task: `## Task

**Starting point.** The starter is the result cache in front of the corpus: \`cached_search(tenant,
query, k)\` reads \`search:{query_digest(query)}\`, answers a hit as \`{hits, k, index_version,
cached: true}\`, and on a miss resolves the active version, searches with \`corpus.nearest\` and writes
the result back with \`SET\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** globex runs the query acme ran a minute ago and receives acme's
documents; after the reindex to idx-43 the service keeps answering from idx-42; a search for 3
results after a search for 2 answers 2; and an entry written last week still answers.

- The key is \`search:{tenant}:{version}:{digest}:{k}\`, with \`digest = query_digest(query)\`
  (\`search.fingerprint\`, provided).
- The active version is resolved **before** the lookup, because the key names it.
- Every entry is written with a TTL of \`CACHE_TTL_S\` (60 seconds) in the same \`SET\`.`,
  sequence: {
    participants: ['searchd', 'Corpus', 'Result cache'],
    messages: [
      {from: 'searchd', to: 'Corpus', label: 'active_index() → idx-42', kind: 'sync'},
      {from: 'searchd', to: 'Result cache', label: 'GET search:acme:idx-42:{digest}:10', kind: 'sync'},
      {from: 'Result cache', to: 'searchd', label: 'hit → {hits, cached: true}', kind: 'reply'},
      {from: 'searchd', to: 'Corpus', label: 'miss → nearest(acme, idx-42, query, 10)', kind: 'sync'},
      {from: 'searchd', to: 'Result cache', label: 'SET search:acme:idx-42:{digest}:10 … EX 60', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'The key carries the tenant',
      detail:
        "The key starts `search:{tenant}:`, so one tenant's entry is never another's hit. The starter keys by the digest alone, and the first tenant to run a query fills the entry every tenant reads.",
      match: {
        python: {all: [/search:\{tenant\}:|["']search["']\s*,\s*tenant\b/]},
        typescript: {all: [/search:\$\{tenant\}:/]},
        go: {all: [/"search:%s:%s:%s:%d"|"search:"\s*\+\s*tenant\b/]},
        scala: {all: [/search:\$tenant:|search:\$\{tenant\}:/]},
        cpp: {all: [/"search:"\s*\+\s*tenant\b/]},
      },
    },
    {
      id: 'version-key',
      title: 'The key carries the active version, resolved first',
      detail:
        'The active version is resolved before the lookup and is part of the key, so a reindex is a miss. The starter reads the version only on a miss, so entries written for idx-42 keep answering after idx-43 goes live.',
      match: {
        python: {all: [/\{version\}:/], order: [/corpus\.active_index\(/, /\br\.get\(/]},
        typescript: {all: [/\$\{version\}:/], order: [/activeIndex\(/, /redis\.get\(/]},
        go: {all: [/"search:%s:%s:%s:%d"|\+\s*version\s*\+/], order: [/corpus\.ActiveIndex\(/, /rdb\.Get\(/]},
        scala: {all: [/\$version:|\$\{version\}:/], order: [/Corpus\.activeIndex\(/, /jedis\.get\(/]},
        cpp: {all: [/\+\s*version\s*\+/], order: [/corpus::activeIndex\(/, /redis\.get\(/]},
      },
    },
    {
      id: 'k-key',
      title: 'The key carries k',
      detail:
        'The key ends with `:{k}`, so a search for 3 never answers from the entry a search for 2 wrote. The starter answers both from one entry.',
      match: {
        python: {all: [/:\{k\}["']/]},
        typescript: {all: [/:\$\{k\}`/]},
        go: {all: [/%s:%d"|\+\s*strconv\.Itoa\(k\)/]},
        scala: {all: [/:\$k"|:\$\{k\}"/]},
        cpp: {all: [/\+\s*std::to_string\(k\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire after 60 seconds',
      detail:
        'Every entry is written with the TTL in the same command (`ex=CACHE_TTL_S`, `EX`, `setex`, a duration); the TTL bounds how long an answer can outlive a document change inside one version. The starter writes with no expiry.',
      match: {
        python: {all: [/\bex\s*=\s*CACHE_TTL_S|\.setex\(/]},
        typescript: {all: [/['"]EX['"]\s*,\s*CACHE_TTL_S|\.setex\(/]},
        go: {all: [/rdb\.Set\([^\n]*cacheTTL\)|\.SetEx\(/]},
        scala: {all: [/\.setex\(|SetParams\(\)\.ex\(/]},
        cpp: {all: [/std::chrono::seconds\(kCacheTtlSeconds\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from search import corpus  # active_index, nearest
from search.fingerprint import query_digest

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 60


def cached_search(tenant: str, query: list[float], k: int) -> dict:
    """The tenant's k nearest documents to query through the result cache: {hits, k, index_version, cached}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"search:{query_digest(query)}"
    raw = r.get(key)
    if raw is not None:
        return {**json.loads(raw), "cached": True}
    version = corpus.active_index()["version"]
    result = {"hits": corpus.nearest(tenant, version, query, k), "k": k, "index_version": version}
    r.set(key, json.dumps(result))
    return {**result, "cached": False}
`,
      solution: `import json

import redis

from search import corpus  # active_index, nearest
from search.fingerprint import query_digest

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 60


def cached_search(tenant: str, query: list[float], k: int) -> dict:
    """The tenant's k nearest documents to query through the result cache: {hits, k, index_version, cached}."""
    # Every input that changes the answer is in the key; the version is resolved first because the key names it.
    version = corpus.active_index()["version"]
    key = f"search:{tenant}:{version}:{query_digest(query)}:{k}"
    raw = r.get(key)
    if raw is not None:
        return {**json.loads(raw), "cached": True}
    result = {"hits": corpus.nearest(tenant, version, query, k), "k": k, "index_version": version}
    r.set(key, json.dumps(result), ex=CACHE_TTL_S)
    return {**result, "cached": False}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Hit, activeIndex, nearest} from 'search/corpus';
import {queryDigest} from 'search/fingerprint';

const redis = new Redis({host: 'redis', port: 6379});

export const CACHE_TTL_S = 60;

export interface Result {
  hits: Hit[];
  k: number;
  index_version: string;
  cached: boolean;
}

/** The tenant's k nearest documents to query through the result cache. */
export async function cachedSearch(tenant: string, query: number[], k: number): Promise<Result> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`search:\${queryDigest(query)}\`;
  const raw = await redis.get(key);
  if (raw !== null) return {...(JSON.parse(raw) as Result), cached: true};
  const version = (await activeIndex()).version;
  const result = {hits: await nearest(tenant, version, query, k), k, index_version: version};
  await redis.set(key, JSON.stringify(result));
  return {...result, cached: false};
}
`,
      solution: `import Redis from 'ioredis';

import {type Hit, activeIndex, nearest} from 'search/corpus';
import {queryDigest} from 'search/fingerprint';

const redis = new Redis({host: 'redis', port: 6379});

export const CACHE_TTL_S = 60;

export interface Result {
  hits: Hit[];
  k: number;
  index_version: string;
  cached: boolean;
}

/** The tenant's k nearest documents to query through the result cache. */
export async function cachedSearch(tenant: string, query: number[], k: number): Promise<Result> {
  // Every input that changes the answer is in the key; the version is resolved first because the key names it.
  const version = (await activeIndex()).version;
  const key = \`search:\${tenant}:\${version}:\${queryDigest(query)}:\${k}\`;
  const raw = await redis.get(key);
  if (raw !== null) return {...(JSON.parse(raw) as Result), cached: true};
  const result = {hits: await nearest(tenant, version, query, k), k, index_version: version};
  await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_S);
  return {...result, cached: false};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"search/corpus"      // corpus.ActiveIndex, Nearest
	"search/fingerprint" // fingerprint.QueryDigest
)

const cacheTTL = 60 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Result is a search answer as the cache stores it; Cached says whether this one came from the cache.
type Result struct {
	Hits         []corpus.Hit \`json:"hits"\`
	K            int          \`json:"k"\`
	IndexVersion string       \`json:"index_version"\`
	Cached       bool         \`json:"-"\`
}

// cachedSearch is the tenant's k nearest documents to query through the result cache.
func cachedSearch(ctx context.Context, tenant string, query []float64, k int) (Result, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "search:" + fingerprint.QueryDigest(query)
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var cached Result
		if json.Unmarshal([]byte(raw), &cached) == nil {
			cached.Cached = true
			return cached, nil
		}
	} else if err != redis.Nil {
		return Result{}, err
	}
	version := corpus.ActiveIndex(ctx).Version
	result := Result{Hits: corpus.Nearest(ctx, tenant, version, query, k), K: k, IndexVersion: version}
	encoded, _ := json.Marshal(result)
	if err := rdb.Set(ctx, key, encoded, 0).Err(); err != nil {
		return Result{}, err
	}
	return result, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"search/corpus"      // corpus.ActiveIndex, Nearest
	"search/fingerprint" // fingerprint.QueryDigest
)

const cacheTTL = 60 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Result is a search answer as the cache stores it; Cached says whether this one came from the cache.
type Result struct {
	Hits         []corpus.Hit \`json:"hits"\`
	K            int          \`json:"k"\`
	IndexVersion string       \`json:"index_version"\`
	Cached       bool         \`json:"-"\`
}

// cachedSearch is the tenant's k nearest documents to query through the result cache.
func cachedSearch(ctx context.Context, tenant string, query []float64, k int) (Result, error) {
	// Every input that changes the answer is in the key; the version is resolved first because the key names it.
	version := corpus.ActiveIndex(ctx).Version
	key := fmt.Sprintf("search:%s:%s:%s:%d", tenant, version, fingerprint.QueryDigest(query), k)
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var cached Result
		if json.Unmarshal([]byte(raw), &cached) == nil {
			cached.Cached = true
			return cached, nil
		}
	} else if err != redis.Nil {
		return Result{}, err
	}
	result := Result{Hits: corpus.Nearest(ctx, tenant, version, query, k), K: k, IndexVersion: version}
	encoded, _ := json.Marshal(result)
	if err := rdb.Set(ctx, key, encoded, cacheTTL).Err(); err != nil {
		return Result{}, err
	}
	return result, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import search.{Corpus, Fingerprint} // Corpus.activeIndex, nearest; Fingerprint.queryDigest

object State {
  val CacheTtlSeconds = 60L

  val jedis = new JedisPooled("redis", 6379)

  /** A search answer as the cache stores it; cached says whether this one came from the cache. */
  final case class Result(hits: Vector[Corpus.Hit], k: Int, indexVersion: String, cached: Boolean)

  private def encode(result: Result): String = JsObject(
    "hits" -> JsArray(result.hits.map(h => JsObject("id" -> JsString(h.id), "score" -> JsNumber(h.score)))),
    "k" -> JsNumber(result.k),
    "index_version" -> JsString(result.indexVersion),
  ).compactPrint

  private def decode(raw: String): Result = {
    val fields = raw.parseJson.asJsObject.fields
    val hits = fields("hits") match {
      case JsArray(items) =>
        items.map { item =>
          val hit = item.asJsObject.fields
          Corpus.Hit(hit("id").asInstanceOf[JsString].value, hit("score").asInstanceOf[JsNumber].value.toDouble)
        }
      case _ => Vector.empty
    }
    Result(hits, fields("k").asInstanceOf[JsNumber].value.toInt, fields("index_version").asInstanceOf[JsString].value, cached = true)
  }

  /** The tenant's k nearest documents to query through the result cache. */
  def cachedSearch(tenant: String, query: Seq[Double], k: Int): Result = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"search:\${Fingerprint.queryDigest(query)}"
    Option(jedis.get(key)) match {
      case Some(raw) => decode(raw)
      case None =>
        val version = Corpus.activeIndex().version
        val result = Result(Corpus.nearest(tenant, version, query, k), k, version, cached = false)
        jedis.set(key, encode(result))
        result
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import search.{Corpus, Fingerprint} // Corpus.activeIndex, nearest; Fingerprint.queryDigest

object State {
  val CacheTtlSeconds = 60L

  val jedis = new JedisPooled("redis", 6379)

  /** A search answer as the cache stores it; cached says whether this one came from the cache. */
  final case class Result(hits: Vector[Corpus.Hit], k: Int, indexVersion: String, cached: Boolean)

  private def encode(result: Result): String = JsObject(
    "hits" -> JsArray(result.hits.map(h => JsObject("id" -> JsString(h.id), "score" -> JsNumber(h.score)))),
    "k" -> JsNumber(result.k),
    "index_version" -> JsString(result.indexVersion),
  ).compactPrint

  private def decode(raw: String): Result = {
    val fields = raw.parseJson.asJsObject.fields
    val hits = fields("hits") match {
      case JsArray(items) =>
        items.map { item =>
          val hit = item.asJsObject.fields
          Corpus.Hit(hit("id").asInstanceOf[JsString].value, hit("score").asInstanceOf[JsNumber].value.toDouble)
        }
      case _ => Vector.empty
    }
    Result(hits, fields("k").asInstanceOf[JsNumber].value.toInt, fields("index_version").asInstanceOf[JsString].value, cached = true)
  }

  /** The tenant's k nearest documents to query through the result cache. */
  def cachedSearch(tenant: String, query: Seq[Double], k: Int): Result = {
    // Every input that changes the answer is in the key; the version is resolved first because the key names it.
    val version = Corpus.activeIndex().version
    val key = s"search:$tenant:$version:\${Fingerprint.queryDigest(query)}:$k"
    Option(jedis.get(key)) match {
      case Some(raw) => decode(raw)
      case None =>
        val result = Result(Corpus.nearest(tenant, version, query, k), k, version, cached = false)
        jedis.setex(key, CacheTtlSeconds, encode(result))
        result
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "search/corpus.h"       // corpus::activeIndex, nearest
#include "search/fingerprint.h"  // fingerprint::queryDigest

using json = nlohmann::json;

constexpr long kCacheTtlSeconds = 60;

sw::redis::Redis redis("tcp://redis:6379");

// The tenant's k nearest documents to query through the result cache: {hits, k, index_version, cached}.
json cachedSearch(const std::string& tenant, const std::vector<double>& query, long k) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "search:" + fingerprint::queryDigest(query);
  if (const auto raw = redis.get(key)) {
    json cached = json::parse(*raw);
    cached["cached"] = true;
    return cached;
  }
  const std::string version = corpus::activeIndex().version;
  json result = {{"hits", corpus::nearest(tenant, version, query, k)}, {"k", k}, {"index_version", version}};
  redis.set(key, result.dump());
  result["cached"] = false;
  return result;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "search/corpus.h"       // corpus::activeIndex, nearest
#include "search/fingerprint.h"  // fingerprint::queryDigest

using json = nlohmann::json;

constexpr long kCacheTtlSeconds = 60;

sw::redis::Redis redis("tcp://redis:6379");

// The tenant's k nearest documents to query through the result cache: {hits, k, index_version, cached}.
json cachedSearch(const std::string& tenant, const std::vector<double>& query, long k) {
  // Every input that changes the answer is in the key; the version is resolved first because the key names it.
  const std::string version = corpus::activeIndex().version;
  const std::string key = "search:" + tenant + ":" + version + ":" + fingerprint::queryDigest(query) + ":" + std::to_string(k);
  if (const auto raw = redis.get(key)) {
    json cached = json::parse(*raw);
    cached["cached"] = true;
    return cached;
  }
  json result = {{"hits", corpus::nearest(tenant, version, query, k)}, {"k", k}, {"index_version", version}};
  redis.set(key, result.dump(), std::chrono::seconds(kCacheTtlSeconds));
  result["cached"] = false;
  return result;
}
`,
    },
  },
  harness: {
    python: `from search import corpus
from search.fingerprint import query_digest

QUERY = [1.0, 0.0, 0.0, 0.0]
DIGEST = query_digest(QUERY)


def _state(ctx):
    """acme and globex in the active idx-42; acme's b1 in idx-43, built but not live."""
    corpus.activate("idx-42", 4)
    corpus.put_document("acme", "idx-42", "a1", [0.9, 0.1, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "a2", [0.5, 0.5, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "a3", [0.1, 0.9, 0.0, 0.0])
    corpus.put_document("globex", "idx-42", "g1", [1.0, 0.0, 0.0, 0.0])
    corpus.put_document("acme", "idx-43", "b1", [1.0, 0.0, 0.0, 0.0])
    return ctx.load("state")


def _ids(result):
    return [h["id"] for h in result["hits"]]


def check_tenant_key(ctx):
    m = _state(ctx)
    first = m.cached_search("acme", QUERY, 2)
    assert _ids(first) == ["a1", "a2"] and first["cached"] is False, f"acme's first search must miss and answer a1, a2, got {first}"
    again = m.cached_search("acme", QUERY, 2)
    assert again["cached"] is True and _ids(again) == ["a1", "a2"], f"the same search repeated must be served from the cache, got {again}"
    globex = m.cached_search("globex", QUERY, 2)
    assert "a1" not in _ids(globex), f"globex ran the query acme ran and received acme's documents {globex}: the key must carry the tenant"
    assert _ids(globex) == ["g1"] and globex["cached"] is False, f"globex's search must miss and answer g1, got {globex}"
    key = f"search:globex:idx-42:{DIGEST}:2"
    assert ctx.redis.exists(key), f"globex's entry must be {key}; Redis holds {sorted(ctx.redis.keys('search:*'))}"


def check_version_key(ctx):
    m = _state(ctx)
    before = m.cached_search("acme", QUERY, 2)
    assert before["index_version"] == "idx-42", f"the first search must answer from idx-42, got {before}"
    corpus.activate("idx-43", 4)
    after = m.cached_search("acme", QUERY, 2)
    assert after["index_version"] == "idx-43" and _ids(after) == ["b1"], f"after the switch to idx-43 the search answered {after}: an entry written for idx-42 was served. Resolve the active version before the lookup and put it in the key"
    key = f"search:acme:idx-43:{DIGEST}:2"
    assert ctx.redis.exists(key), f"the idx-43 entry must be {key}; Redis holds {sorted(ctx.redis.keys('search:*'))}"


def check_k_key(ctx):
    m = _state(ctx)
    two = m.cached_search("acme", QUERY, 2)
    assert _ids(two) == ["a1", "a2"], f"a search for 2 answered {two}"
    three = m.cached_search("acme", QUERY, 3)
    assert three["k"] == 3 and _ids(three) == ["a1", "a2", "a3"], f"a search for 3 after a search for 2 answered {three}: the entry for k 2 was served. The key must carry k"


def check_ttl(ctx):
    m = _state(ctx)
    m.cached_search("acme", QUERY, 2)
    keys = ctx.redis.keys("search:*")
    assert len(keys) == 1, f"one search must write one entry, Redis holds {sorted(keys)}"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 60, f"{keys[0]} has TTL {ttl}: write every entry with CACHE_TTL_S (60 s) in the same SET, or it answers until someone deletes it"
    corpus.put_document("acme", "idx-42", "a0", [1.0, 0.0, 0.0, 0.0])
    ctx.clock.advance(61)
    later = m.cached_search("acme", QUERY, 2)
    assert later["cached"] is False and _ids(later) == ["a0", "a1"], f"61 seconds later, after a0 was added, the search answered {later}: the entry must have expired"
`,
    typescript: `const QUERY = [1, 0, 0, 0];

/** acme and globex in the active idx-42; acme's b1 in idx-43, built but not live. */
async function state(ctx) {
  const corpus = ctx.load('/support/search/corpus.ts');
  const {queryDigest} = ctx.load('/support/search/fingerprint.ts');
  await corpus.activate('idx-42', 4);
  await corpus.putDocument('acme', 'idx-42', 'a1', [0.9, 0.1, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'a2', [0.5, 0.5, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'a3', [0.1, 0.9, 0, 0]);
  await corpus.putDocument('globex', 'idx-42', 'g1', [1, 0, 0, 0]);
  await corpus.putDocument('acme', 'idx-43', 'b1', [1, 0, 0, 0]);
  return {m: ctx.load('state'), corpus, digest: queryDigest(QUERY)};
}

const ids = result => result.hits.map(h => h.id).join(',');

export async function check_tenant_key(ctx) {
  const {m, digest} = await state(ctx);
  const first = await m.cachedSearch('acme', QUERY, 2);
  assert(ids(first) === 'a1,a2' && first.cached === false, \`acme's first search must miss and answer a1, a2, got \${JSON.stringify(first)}\`);
  const again = await m.cachedSearch('acme', QUERY, 2);
  assert(again.cached === true && ids(again) === 'a1,a2', \`the same search repeated must be served from the cache, got \${JSON.stringify(again)}\`);
  const globex = await m.cachedSearch('globex', QUERY, 2);
  assert(!ids(globex).includes('a1'), \`globex ran the query acme ran and received acme's documents \${JSON.stringify(globex)}: the key must carry the tenant\`);
  assert(ids(globex) === 'g1' && globex.cached === false, \`globex's search must miss and answer g1, got \${JSON.stringify(globex)}\`);
  const key = \`search:globex:idx-42:\${digest}:2\`;
  assert.equal(ctx.redis.exists(key), 1, \`globex's entry must be \${key}; Redis holds \${JSON.stringify(ctx.redis.keys('search:*'))}\`);
}

export async function check_version_key(ctx) {
  const {m, corpus, digest} = await state(ctx);
  const before = await m.cachedSearch('acme', QUERY, 2);
  assert.equal(before.index_version, 'idx-42', \`the first search must answer from idx-42, got \${JSON.stringify(before)}\`);
  await corpus.activate('idx-43', 4);
  const after = await m.cachedSearch('acme', QUERY, 2);
  assert(after.index_version === 'idx-43' && ids(after) === 'b1', \`after the switch to idx-43 the search answered \${JSON.stringify(after)}: an entry written for idx-42 was served. Resolve the active version before the lookup and put it in the key\`);
  const key = \`search:acme:idx-43:\${digest}:2\`;
  assert.equal(ctx.redis.exists(key), 1, \`the idx-43 entry must be \${key}; Redis holds \${JSON.stringify(ctx.redis.keys('search:*'))}\`);
}

export async function check_k_key(ctx) {
  const {m} = await state(ctx);
  const two = await m.cachedSearch('acme', QUERY, 2);
  assert.equal(ids(two), 'a1,a2', \`a search for 2 answered \${JSON.stringify(two)}\`);
  const three = await m.cachedSearch('acme', QUERY, 3);
  assert(three.k === 3 && ids(three) === 'a1,a2,a3', \`a search for 3 after a search for 2 answered \${JSON.stringify(three)}: the entry for k 2 was served. The key must carry k\`);
}

export async function check_ttl(ctx) {
  const {m, corpus} = await state(ctx);
  await m.cachedSearch('acme', QUERY, 2);
  const keys = ctx.redis.keys('search:*');
  assert.equal(keys.length, 1, \`one search must write one entry, Redis holds \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 0 && ttl <= 60, \`\${keys[0]} has TTL \${ttl}: write every entry with CACHE_TTL_S (60 s) in the same SET, or it answers until someone deletes it\`);
  await corpus.putDocument('acme', 'idx-42', 'a0', [1, 0, 0, 0]);
  ctx.clock.advance(61);
  const later = await m.cachedSearch('acme', QUERY, 2);
  assert(later.cached === false && ids(later) === 'a0,a1', \`61 seconds later, after a0 was added, the search answered \${JSON.stringify(later)}: the entry must have expired\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"search/corpus"
	"search/fingerprint"

	"leetbuild/harness"
)

var (
	stateBg     = context.Background()
	stateQuery  = []float64{1, 0, 0, 0}
	stateDigest = fingerprint.QueryDigest(stateQuery)
)

// seedState puts acme and globex in the active idx-42 and acme's b1 in idx-43, built but not live.
func seedState() {
	corpus.Activate(stateBg, "idx-42", 4)
	corpus.PutDocument(stateBg, "acme", "idx-42", "a1", []float64{0.9, 0.1, 0, 0})
	corpus.PutDocument(stateBg, "acme", "idx-42", "a2", []float64{0.5, 0.5, 0, 0})
	corpus.PutDocument(stateBg, "acme", "idx-42", "a3", []float64{0.1, 0.9, 0, 0})
	corpus.PutDocument(stateBg, "globex", "idx-42", "g1", []float64{1, 0, 0, 0})
	corpus.PutDocument(stateBg, "acme", "idx-43", "b1", []float64{1, 0, 0, 0})
}

func mustSearch(ctx *harness.Ctx, tenant string, k int) Result {
	result, err := cachedSearch(stateBg, tenant, stateQuery, k)
	ctx.NoError(err, "cachedSearch(%s, …, %d) failed", tenant, k)
	return result
}

func resultIDs(result Result) string {
	ids := []string{}
	for _, h := range result.Hits {
		ids = append(ids, h.ID)
	}
	return strings.Join(ids, ",")
}

func CheckTenantKey(ctx *harness.Ctx) {
	seedState()
	first := mustSearch(ctx, "acme", 2)
	ctx.Assert(resultIDs(first) == "a1,a2" && !first.Cached, "acme's first search must miss and answer a1, a2, got %+v", first)
	again := mustSearch(ctx, "acme", 2)
	ctx.Assert(again.Cached && resultIDs(again) == "a1,a2", "the same search repeated must be served from the cache, got %+v", again)
	globex := mustSearch(ctx, "globex", 2)
	ctx.Assert(!strings.Contains(resultIDs(globex), "a1"), "globex ran the query acme ran and received acme's documents %+v: the key must carry the tenant", globex)
	ctx.Assert(resultIDs(globex) == "g1" && !globex.Cached, "globex's search must miss and answer g1, got %+v", globex)
	key := fmt.Sprintf("search:globex:idx-42:%s:2", stateDigest)
	ctx.Equal(ctx.Redis.Exists(key), int64(1), "globex's entry must be %s; Redis holds %q; exists", key, ctx.Redis.Keys("search:*"))
}

func CheckVersionKey(ctx *harness.Ctx) {
	seedState()
	before := mustSearch(ctx, "acme", 2)
	ctx.Equal(before.IndexVersion, "idx-42", "the first search's index version")
	corpus.Activate(stateBg, "idx-43", 4)
	after := mustSearch(ctx, "acme", 2)
	ctx.Assert(after.IndexVersion == "idx-43" && resultIDs(after) == "b1", "after the switch to idx-43 the search answered %+v: an entry written for idx-42 was served. Resolve the active version before the lookup and put it in the key", after)
	key := fmt.Sprintf("search:acme:idx-43:%s:2", stateDigest)
	ctx.Equal(ctx.Redis.Exists(key), int64(1), "the idx-43 entry must be %s; Redis holds %q; exists", key, ctx.Redis.Keys("search:*"))
}

func CheckKKey(ctx *harness.Ctx) {
	seedState()
	two := mustSearch(ctx, "acme", 2)
	ctx.Equal(resultIDs(two), "a1,a2", "a search for 2")
	three := mustSearch(ctx, "acme", 3)
	ctx.Assert(three.K == 3 && resultIDs(three) == "a1,a2,a3", "a search for 3 after a search for 2 answered %+v: the entry for k 2 was served. The key must carry k", three)
}

func CheckTtl(ctx *harness.Ctx) {
	seedState()
	mustSearch(ctx, "acme", 2)
	keys := ctx.Redis.Keys("search:*")
	ctx.Equal(len(keys), 1, "one search must write one entry; Redis holds %q; entries", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: write every entry with the 60 s TTL in the same SET, or it answers until someone deletes it", keys[0], ttl)
	corpus.PutDocument(stateBg, "acme", "idx-42", "a0", []float64{1, 0, 0, 0})
	ctx.Clock.Advance(61)
	later := mustSearch(ctx, "acme", 2)
	ctx.Assert(!later.Cached && resultIDs(later) == "a0,a1", "61 seconds later, after a0 was added, the search answered %+v: the entry must have expired", later)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::vector<double> kQuery = {1, 0, 0, 0};

// acme and globex in the active idx-42; acme's b1 in idx-43, built but not live.
void seedState() {
  corpus::activate("idx-42", 4);
  corpus::putDocument("acme", "idx-42", "a1", {0.9, 0.1, 0, 0});
  corpus::putDocument("acme", "idx-42", "a2", {0.5, 0.5, 0, 0});
  corpus::putDocument("acme", "idx-42", "a3", {0.1, 0.9, 0, 0});
  corpus::putDocument("globex", "idx-42", "g1", {1, 0, 0, 0});
  corpus::putDocument("acme", "idx-43", "b1", {1, 0, 0, 0});
}

std::string ids(const nlohmann::json& result) {
  std::string out;
  for (const auto& h : result.value("hits", nlohmann::json::array())) out += (out.empty() ? "" : ",") + h.value("id", std::string());
  return out;
}

bool cached(const nlohmann::json& result) { return result.value("cached", false); }

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  seedState();
  const auto first = cachedSearch("acme", kQuery, 2);
  ctx.Assert(ids(first) == "a1,a2" && !cached(first), "acme's first search must miss and answer a1, a2, got %s", first.dump());
  const auto again = cachedSearch("acme", kQuery, 2);
  ctx.Assert(cached(again) && ids(again) == "a1,a2", "the same search repeated must be served from the cache, got %s", again.dump());
  const auto globex = cachedSearch("globex", kQuery, 2);
  ctx.Assert(ids(globex).find("a1") == std::string::npos, "globex ran the query acme ran and received acme's documents %s: the key must carry the tenant", globex.dump());
  ctx.Assert(ids(globex) == "g1" && !cached(globex), "globex's search must miss and answer g1, got %s", globex.dump());
  const std::string key = "search:globex:idx-42:" + fingerprint::queryDigest(kQuery) + ":2";
  ctx.Equal(ctx.Redis.Exists(key), 1, "globex's entry must be %s; Redis holds %q; exists", key, ctx.Redis.Keys("search:*"));
}

void CheckVersionKey(harness::Ctx& ctx) {
  seedState();
  const auto before = cachedSearch("acme", kQuery, 2);
  ctx.Equal(before.value("index_version", std::string()), "idx-42", "the first search's index version");
  corpus::activate("idx-43", 4);
  const auto after = cachedSearch("acme", kQuery, 2);
  ctx.Assert(after.value("index_version", std::string()) == "idx-43" && ids(after) == "b1",
             "after the switch to idx-43 the search answered %s: an entry written for idx-42 was served. Resolve the active version before the lookup and put it in the key", after.dump());
  const std::string key = "search:acme:idx-43:" + fingerprint::queryDigest(kQuery) + ":2";
  ctx.Equal(ctx.Redis.Exists(key), 1, "the idx-43 entry must be %s; Redis holds %q; exists", key, ctx.Redis.Keys("search:*"));
}

void CheckKKey(harness::Ctx& ctx) {
  seedState();
  const auto two = cachedSearch("acme", kQuery, 2);
  ctx.Equal(ids(two), "a1,a2", "a search for 2");
  const auto three = cachedSearch("acme", kQuery, 3);
  ctx.Assert(three.value("k", 0L) == 3 && ids(three) == "a1,a2,a3", "a search for 3 after a search for 2 answered %s: the entry for k 2 was served. The key must carry k", three.dump());
}

void CheckTtl(harness::Ctx& ctx) {
  seedState();
  cachedSearch("acme", kQuery, 2);
  const auto keys = ctx.Redis.Keys("search:*");
  ctx.Equal(keys.size(), 1, "one search must write one entry; Redis holds %q; entries", keys);
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: write every entry with the 60 s TTL in the same SET, or it answers until someone deletes it", keys[0], ttl);
  corpus::putDocument("acme", "idx-42", "a0", {1, 0, 0, 0});
  ctx.Clock.Advance(61);
  const auto later = cachedSearch("acme", kQuery, 2);
  ctx.Assert(!cached(later) && ids(later) == "a0,a1", "61 seconds later, after a0 was added, the search answered %s: the entry must have expired", later.dump());
}
`,
  },
  hints: [
    "globex runs the query acme ran a minute ago and gets acme's documents; after the switch to idx-43 searches still answer idx-42; asking for 3 after asking for 2 returns 2; old entries never go away.",
    'The key is `search:{digest}` alone, so every tenant, version and k share one entry, and the active version is read only on a miss. A `SET` without an expiry keeps the entry until something deletes it.',
    'Resolve `active_index()` first, key by `search:{tenant}:{version}:{query_digest(query)}:{k}`, and write with `ex=CACHE_TTL_S` (`EX`, `setex`, a duration) in the same `SET`.',
  ],
  debrief: `A cache key claims that every request mapping to it deserves the same answer, so it must carry every input that changes the answer: the tenant for isolation, the index version for correctness across a reindex, the digest and k for the query itself. Resolving the version before the lookup is what turns a reindex into a miss instead of a stale hit. The TTL covers what no key can express: a document added or deleted inside the same version. Production caches add a memory budget per tenant, coalesce concurrent misses on one hot key so the shards see one query, and skip caching answers a degraded shard set produced.`,
};
