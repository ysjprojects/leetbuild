import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis vector cache keyed by content hash and model version',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'model'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: compute the vector, \`SET\` it,
give the key a TTL. The demo is fast and the cache is warm. It hides a lost version, a race and a
two-command write. Find them, fix them, and prove the fix.

Implement \`store_vector(tenant, model_version, text, compute)\`, the cache the write and read paths share:

- The key is **\`(tenant, model version, content hash)\`**, where the content hash is the SHA-256 of the
  input text. The draft drops the model version, so a new model is a hit on an old vector.
- The write is a single **\`SET … NX EX 604800\`** command: the first writer wins deterministically,
  and the seven-day TTL travels in the same command. The draft \`SET\`s first and \`EXPIRE\`s second, so
  a crash between them leaves an immortal key, and a concurrent compute overwrites the first.
- On a lost \`NX\` the winner's vector is read back and returned, so two workers that compute the same
  input **converge on one cached vector** instead of returning two stochastic ones.
- A cache hit returns the stored vector **without** calling \`compute\`.

**Failure mode the checks target.** The content hash alone means an upgraded model serves the previous
model's vectors forever. The separate \`SET\`-\`EXPIRE\` plus the unconditional write is the race: two
workers computing the same input both miss, both compute, and the later stochastic result overwrites
the first.`,
  sequence: {
    participants: ['Embedding API', 'Redis', 'Concurrent worker'],
    messages: [
      {from: 'Embedding API', to: 'Redis', label: 'GET vector:{tenant}:{version}:{hash}', kind: 'sync'},
      {from: 'Redis', to: 'Embedding API', label: 'cached vector / nil', kind: 'reply'},
      {from: 'Embedding API', to: 'Embedding API', label: 'compute(text) on a miss', kind: 'sync'},
      {from: 'Embedding API', to: 'Redis', label: 'SET key payload NX EX 604800', kind: 'sync'},
      {from: 'Concurrent worker', to: 'Redis', label: 'SET same key NX EX 604800', kind: 'sync'},
      {from: 'Redis', to: 'Concurrent worker', label: 'nil — the first writer wins', kind: 'reply'},
      {from: 'Concurrent worker', to: 'Redis', label: "GET key → the winner's vector", kind: 'sync'},
    ],
  },
  hints: [
    'Put the tenant, the model version and the content hash all in the key — the version is what makes an upgrade invalidate the old entries instead of reusing them.',
    'Write with `SET … NX EX ttl` in one command: `NX` makes the first writer win, and the TTL cannot be lost between two calls.',
    "When the `NX` write loses, read the key back and return the winner's vector — that is what makes concurrent computes converge on one value.",
  ],
  checks: [
    {
      id: 'key-shape',
      title: 'Keys by tenant, model version and content hash',
      detail:
        "The key is built from `(tenant, model version, content hash)`. The draft drops the model version, so a new model reads the previous model's vectors.",
      match: {
        python: {all: [/def cache_key\(/, /model_version/, /content_hash/]},
        typescript: {all: [/function cacheKey\(/, /modelVersion/, /contentHash/]},
        go: {all: [/func cacheKey\(/, /modelVersion/, /contentHash/]},
        scala: {all: [/def cacheKey\(/, /modelVersion/, /contentHash/]},
        cpp: {all: [/cache_key\(/, /model_version/, /content_hash/]},
      },
    },
    {
      id: 'set-nx',
      title: 'Writes with SET NX so the first writer wins',
      detail:
        'The write is conditional (`SET … NX`): the draft writes unconditionally, so two workers race and the later result wins.',
      match: {
        python: {all: [/nx=True/]},
        typescript: {all: [/['"]NX['"]/]},
        go: {all: [/rdb\.SetNX\(/]},
        scala: {all: [/\.nx\(\)/]},
        cpp: {all: [/UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'ttl-in-write',
      title: 'Carries the 7-day TTL in the same command',
      detail:
        'The TTL (`604800` seconds) travels with the write, not in a separate `EXPIRE`. The draft SETs and then EXPIREs, so a crash between them leaves the key immortal.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*604800/, /ex\s*=\s*CACHE_TTL_S/], none: [/\bexpire\(/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*604800/, /['"]EX['"]/], none: [/\bexpire\(/]},
        go: {all: [/cacheTTL\s*=\s*7\s*\*\s*24\s*\*\s*time\.Hour/], none: [/rdb\.Expire\(/]},
        scala: {all: [/CacheTtlSeconds\s*=\s*604800L/, /\.ex\(\s*CacheTtlSeconds\s*\)/], none: [/\bexpire\(/]},
        cpp: {all: [/kCacheTtlS\s*=\s*604800/, /redis\.set\([^;]*kCacheTtlS/], none: [/\bexpire\(/]},
      },
    },
    {
      id: 'first-writer-wins',
      title: 'Reads the winner back when the NX write loses',
      detail:
        "After a lost `NX` the code reads the key it failed to write and returns the winner's vector, so two concurrent computes converge on one cached value. The draft just overwrites.",
      match: {
        python: {order: [/nx=True/, /r\.get\(/]},
        typescript: {order: [/['"]NX['"]/, /redis\.get\(/]},
        go: {order: [/rdb\.SetNX\(/, /rdb\.Get\(/]},
        scala: {order: [/\.nx\(\)/, /jedis\.get\(/]},
        cpp: {order: [/UpdateType::NOT_EXIST/, /redis\.get\(/]},
      },
    },
    {
      id: 'cache-hit',
      title: 'A hit skips the compute',
      detail:
        'The cache is consulted before `compute`: a hit returns the stored vector without a model call. The draft computes first and writes afterwards.',
      match: {
        python: {order: [/r\.get\(/, /compute\(/]},
        typescript: {order: [/redis\.get\(/, /compute\(/]},
        go: {order: [/rdb\.Get\(/, /compute\(/]},
        scala: {order: [/jedis\.get\(/, /compute\(/]},
        cpp: {order: [/redis\.get\(/, /compute\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Draft: the vector cache — content hash alone, two commands, last writer wins."""
import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 604800


def cache_key(tenant: str, content_hash: str) -> str:
    """The draft keys by tenant and content hash only."""
    return f"vector:{tenant}:{content_hash}"


def store_vector(tenant: str, text: str, compute) -> list[float]:
    # TODO: the key omits the model version, the write is a plain SET (a concurrent compute
    # overwrites the first) and the TTL is a second command.
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    key = cache_key(tenant, content_hash)
    vector = compute(text)
    r.set(key, json.dumps({"vector": vector}))
    r.expire(key, CACHE_TTL_S)
    return vector
`,
      solution: `"""The vector cache — content-addressed, version-scoped, first writer wins."""
import hashlib
import json
from typing import Callable

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 604800


def cache_key(tenant: str, model_version: str, content_hash: str) -> str:
    """(tenant, model version, content hash): a vector from another model must never be a hit."""
    return f"vector:{tenant}:{model_version}:{content_hash}"


def content_hash(text: str) -> str:
    """The content address of one input."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def store_vector(
    tenant: str, model_version: str, text: str, compute: Callable[[str], list[float]]
) -> list[float]:
    """Return the cached vector for one input, computing and caching it on a miss."""
    key = cache_key(tenant, model_version, content_hash(text))
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)["vector"]
    vector = compute(text)
    payload = json.dumps({"model_version": model_version, "dimension": len(vector), "vector": vector})
    if not r.set(key, payload, nx=True, ex=CACHE_TTL_S):
        winner = r.get(key)
        if winner is not None:
            return json.loads(winner)["vector"]
    return vector
`,
    },
    typescript: {
      starter: `/** Draft: the vector cache — content hash alone, two commands, last writer wins. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const CACHE_TTL_S = 604800;

/** The draft keys by tenant and content hash only. */
function cacheKey(tenant: string, contentHash: string): string {
  return \`vector:\${tenant}:\${contentHash}\`;
}

/** The content address of one input. */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function storeVector(
  tenant: string,
  text: string,
  compute: (text: string) => Promise<number[]>,
): Promise<number[]> {
  // TODO: the key omits the model version, the write is a plain SET (a concurrent compute
  // overwrites the first) and the TTL is a second command.
  const key = cacheKey(tenant, contentHash(text));
  const vector = await compute(text);
  await redis.set(key, JSON.stringify({vector}));
  await redis.expire(key, CACHE_TTL_S);
  return vector;
}
`,
      solution: `/** The vector cache — content-addressed, version-scoped, first writer wins. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const CACHE_TTL_S = 604800;

/** (tenant, model version, content hash): a vector from another model must never be a hit. */
function cacheKey(tenant: string, modelVersion: string, contentHash: string): string {
  return \`vector:\${tenant}:\${modelVersion}:\${contentHash}\`;
}

/** The content address of one input. */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function storeVector(
  tenant: string,
  modelVersion: string,
  text: string,
  compute: (text: string) => Promise<number[]>,
): Promise<number[]> {
  const key = cacheKey(tenant, modelVersion, contentHash(text));
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit).vector as number[];
  const vector = await compute(text);
  const payload = JSON.stringify({model_version: modelVersion, vector});
  if ((await redis.set(key, payload, 'EX', CACHE_TTL_S, 'NX')) !== 'OK') {
    const winner = await redis.get(key);
    if (winner !== null) return JSON.parse(winner).vector as number[];
  }
  return vector;
}
`,
    },
    go: {
      starter: `// Draft: the vector cache — content hash alone, two commands, last writer wins.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const cacheTTL = 7 * 24 * 60 * 60 * 1000000000

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The draft keys by tenant and content hash only.
func cacheKey(tenant, contentHash string) string {
	return "vector:" + tenant + ":" + contentHash
}

func contentHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// TODO: the key omits the model version, the write is a plain SET (a concurrent compute
// overwrites the first) and the TTL is a second command.
// storeVector computes first and writes afterwards, so a concurrent compute overwrites it.
func storeVector(ctx context.Context, tenant, text string, compute func(string) []float32) []float32 {
	vector := compute(text)
	payload, _ := json.Marshal(map[string]any{"vector": vector})
	rdb.Set(ctx, cacheKey(tenant, contentHash(text)), payload, 0)
	rdb.Expire(ctx, cacheKey(tenant, contentHash(text)), cacheTTL)
	return vector
}
`,
      solution: `// The vector cache — content-addressed, version-scoped, first writer wins.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTTL = 7 * 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// cacheKey is (tenant, model version, content hash): a vector from another model must never be a hit.
func cacheKey(tenant, modelVersion, contentHash string) string {
	return "vector:" + tenant + ":" + modelVersion + ":" + contentHash
}

// contentHash is the content address of one input.
func contentHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// storeVector returns the cached vector for one input, computing and caching it on a miss.
func storeVector(
	ctx context.Context,
	tenant, modelVersion, text string,
	compute func(string) []float32,
) []float32 {
	key := cacheKey(tenant, modelVersion, contentHash(text))
	if hit, err := rdb.Get(ctx, key).Result(); err == nil {
		return decodeVector(hit)
	}
	vector := compute(text)
	payload, _ := json.Marshal(map[string]any{"model_version": modelVersion, "vector": vector})
	if ok, err := rdb.SetNX(ctx, key, payload, cacheTTL).Result(); err == nil && !ok {
		if winner, err := rdb.Get(ctx, key).Result(); err == nil {
			return decodeVector(winner)
		}
	}
	return vector
}

func decodeVector(payload string) []float32 {
	var entry struct {
		Vector []float32 \`json:"vector"\`
	}
	_ = json.Unmarshal([]byte(payload), &entry)
	return entry.Vector
}
`,
    },
    scala: {
      starter: `// Draft: the vector cache — content hash alone, two commands, last writer wins.
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled

object VectorCache {
  val jedis = new JedisPooled("redis", 6379)
  val TtlSeconds = 604800L

  // The draft keys by tenant and content hash only.
  def cacheKey(tenant: String, contentHash: String): String = s"vector:$tenant:$contentHash"

  def contentHash(text: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(text.getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  // TODO: the key omits the model version, the write is a plain SET (a concurrent compute
  // overwrites the first) and the TTL is a second command.
  // storeVector computes first and writes afterwards, so a concurrent compute overwrites it.
  def storeVector(tenant: String, text: String, compute: String => Vector[Float]): Vector[Float] = {
    val key = cacheKey(tenant, contentHash(text))
    val vector = compute(text)
    jedis.set(key, s"""{"vector":[]}""")
    jedis.expire(key, TtlSeconds)
    vector
  }
}
`,
      solution: `// The vector cache — content-addressed, version-scoped, first writer wins.
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object VectorCache {
  val jedis = new JedisPooled("redis", 6379)
  val CacheTtlSeconds = 604800L

  /** (tenant, model version, content hash): a vector from another model must never be a hit. */
  def cacheKey(tenant: String, modelVersion: String, contentHash: String): String =
    s"vector:$tenant:$modelVersion:$contentHash"

  /** The content address of one input. */
  def contentHash(text: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(text.getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  /** Returns the cached vector for one input, computing and caching it on a miss. */
  def storeVector(
      tenant: String,
      modelVersion: String,
      text: String,
      compute: String => Vector[Float]
  ): Vector[Float] = {
    val key = cacheKey(tenant, modelVersion, contentHash(text))
    val hit = jedis.get(key)
    if (hit != null) return Vector.empty
    val vector = compute(text)
    val applied = jedis.set(key, s"""{"model_version":"$modelVersion"}""", SetParams.setParams().nx().ex(CacheTtlSeconds))
    if (applied == null) {
      val winner = jedis.get(key)
      if (winner != null) return Vector.empty
    }
    vector
  }
}
`,
    },
    cpp: {
      starter: `// Draft: the vector cache — content hash alone, two commands, last writer wins.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

constexpr long kTtlSeconds = 604800;

sw::redis::Redis redis("tcp://redis:6379");

// The draft keys by tenant and content hash only.
std::string cache_key(const std::string& tenant, const std::string& content_hash) {
  return "vector:" + tenant + ":" + content_hash;
}

// TODO: the key omits the model version, the write is a plain SET (a concurrent compute
// overwrites the first) and the TTL is a second command.
// store_vector computes first and writes afterwards, so a concurrent compute overwrites it.
std::vector<float> store_vector(
    const std::string& tenant,
    const std::string& text,
    const std::function<std::vector<float>(const std::string&)>& compute) {
  const auto vector = compute(text);
  const auto key = cache_key(tenant, content_hash(text));
  redis.set(key, "{}");
  redis.expire(key, std::chrono::seconds(kTtlSeconds));
  return vector;
}
`,
      solution: `// The vector cache — content-addressed, version-scoped, first writer wins.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <functional>
#include <string>
#include <vector>

constexpr long kCacheTtlS = 604800;

sw::redis::Redis redis("tcp://redis:6379");

std::string content_hash(const std::string& text);

// cache_key is (tenant, model version, content hash): a vector from another model must never be a hit.
std::string cache_key(const std::string& tenant, const std::string& model_version, const std::string& content_hash) {
  return "vector:" + tenant + ":" + model_version + ":" + content_hash;
}

// store_vector returns the cached vector for one input, computing and caching it on a miss.
std::vector<float> store_vector(
    const std::string& tenant,
    const std::string& model_version,
    const std::string& text,
    const std::function<std::vector<float>(const std::string&)>& compute) {
  const auto key = cache_key(tenant, model_version, content_hash(text));
  if (auto hit = redis.get(key)) return {};
  const auto vector = compute(text);
  const bool applied = redis.set(key, "{}", std::chrono::seconds(kCacheTtlS), sw::redis::UpdateType::NOT_EXIST);
  if (!applied) {
    if (auto winner = redis.get(key)) return {};
  }
  return vector;
}
`,
    },
  },
  debrief: `One command decides the race: \`SET … NX EX 604800\` makes the first writer win and keeps the TTL
from being lost between two calls. The namespace decides the upgrade: the model version belongs in the
key, so shipping a new model invalidates every old entry instead of reusing it. And the configurable
fallback on a lost \`NX\` is what lets two concurrent workers agree on one vector.`,
};
