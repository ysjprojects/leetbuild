import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A vector cache keyed by model version, written once',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter's \`store_vector(tenant, model_version, text, compute)\` is the
cache-aside write the document path uses: it builds \`emb:{tenant}:{content_hash}\`, answers a hit
from \`GET\`, and on a miss calls \`compute\`, \`SET\`s the JSON vector and then \`EXPIRE\`s the key.
It serves the demo and hides 3 flaws.

**Failure mode the checks target.** A model upgrade that keeps serving the previous model's
vectors, a crash between two commands that leaves a vector with no expiry, and two workers that
both miss and leave each caller holding a different vector.

- The key is \`vector_key(tenant, model_version, content_hash(text))\` from \`embedding.config\`:
  \`embed-v1\` and \`embed-v2\` vectors of one text live side by side.
- The write is one \`SET … NX EX VECTOR_TTL_S\` (seven days): the TTL travels with the value.
- When \`NX\` loses, another worker stored first: read its vector back and return that one, so
  every caller of one input converges on the cached vector.
- A hit returns the stored vector without calling \`compute\`.`,
  sequence: {
    participants: ['Worker', 'Vector cache', 'Model'],
    messages: [
      {from: 'Worker', to: 'Vector cache', label: 'GET emb:{tenant}:{model}:{hash}', kind: 'sync'},
      {from: 'Vector cache', to: 'Worker', label: 'hit → vector', kind: 'reply'},
      {from: 'Worker', to: 'Model', label: 'miss → compute()', kind: 'sync'},
      {from: 'Worker', to: 'Vector cache', label: 'SET key vector NX EX 604800', kind: 'sync'},
      {from: 'Vector cache', to: 'Worker', label: 'nil → GET key → the winner’s vector', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'cache-hit',
      title: 'A hit is served without computing',
      detail: 'The key is read before `compute` runs, and a hit returns the stored vector.',
      match: {
        python: {order: [/r\.get\(/, /compute\(\)/]},
        typescript: {order: [/redis\.get\(/, /compute\(\)/]},
        go: {order: [/rdb\.Get\(/, /compute\(\)/]},
        cpp: {order: [/redis\(\)\.get\(/, /compute\(\)/]},
      },
    },
    {
      id: 'version-key',
      title: 'Keys the vector by tenant, model version and content hash',
      detail:
        'The key comes from `vector_key(tenant, model_version, …)`; a key built from the tenant and the hash alone serves `embed-v1` vectors to `embed-v2` requests.',
      match: {
        python: {all: [/vector_key\(\s*tenant\s*,\s*model_version\s*,/]},
        typescript: {all: [/vectorKey\(\s*tenant\s*,\s*modelVersion\s*,/]},
        go: {all: [/config\.VectorKey\(\s*tenant\s*,\s*modelVersion\s*,/]},
        cpp: {all: [/config::vectorKey\(\s*tenant\s*,\s*model_version\s*,/]},
      },
    },
    {
      id: 'ttl-in-write',
      title: 'The TTL travels in the write',
      detail: 'The `SET` carries `EX VECTOR_TTL_S`; no separate `EXPIRE` follows it.',
      match: {
        python: {all: [/ex\s*=\s*VECTOR_TTL_S/], none: [/\.expire\(/]},
        typescript: {all: [/['"]EX['"]\s*,\s*VECTOR_TTL_S/], none: [/\.expire\(/]},
        go: {all: [/SetNX\([^\n]*VectorTTLSeconds|TTL:\s*config\.VectorTTLSeconds/], none: [/\.Expire\(/]},
        cpp: {all: [/\.set\([^;]*kVectorTtlSeconds/], none: [/\.expire\(/]},
      },
    },
    {
      id: 'first-writer-wins',
      title: 'A lost NX returns the winner’s vector',
      detail:
        'The write is `SET NX`; when it stores nothing, the key is read again and the stored vector is what the caller gets. A worker that stores between this one’s last read of the key and its write keeps its vector.',
      match: {
        python: {all: [/nx\s*=\s*True/], order: [/nx\s*=\s*True/, /r\.get\(/]},
        typescript: {all: [/['"]NX['"]/], order: [/['"]NX['"]/, /redis\.get\(/]},
        go: {all: [/SetNX\(|Mode:\s*"NX"/], order: [/SetNX\(|Mode:\s*"NX"/, /rdb\.Get\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], order: [/UpdateType::NOT_EXIST/, /redis\(\)\.get\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
from typing import Callable

import redis

from embedding.config import VECTOR_TTL_S, content_hash, vector_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def store_vector(tenant: str, model_version: str, text: str, compute: Callable[[], list[float]]) -> list[float]:
    """The cached vector of text for the tenant under the model; compute runs on a miss."""
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    key = f"emb:{tenant}:{content_hash(text)}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    vector = compute()
    r.set(key, json.dumps(vector))
    r.expire(key, VECTOR_TTL_S)
    return vector
`,
      solution: `import json
from typing import Callable

import redis

from embedding.config import VECTOR_TTL_S, content_hash, vector_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def store_vector(tenant: str, model_version: str, text: str, compute: Callable[[], list[float]]) -> list[float]:
    """The cached vector of text for the tenant under the model; compute runs on a miss."""
    key = vector_key(tenant, model_version, content_hash(text))
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    vector = compute()
    if r.set(key, json.dumps(vector), nx=True, ex=VECTOR_TTL_S):
        return vector
    winner = r.get(key)  # another worker stored first: its vector is the cached one
    return json.loads(winner) if winner is not None else vector
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {VECTOR_TTL_S, contentHash, vectorKey} from 'embedding/config';

const redis = new Redis({host: 'redis', port: 6379});

/** The cached vector of text for the tenant under the model; compute runs on a miss. */
export async function storeVector(
  tenant: string,
  modelVersion: string,
  text: string,
  compute: () => Promise<number[]>,
): Promise<number[]> {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const key = \`emb:\${tenant}:\${contentHash(text)}\`;
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as number[];
  const vector = await compute();
  await redis.set(key, JSON.stringify(vector));
  await redis.expire(key, VECTOR_TTL_S);
  return vector;
}
`,
      solution: `import Redis from 'ioredis';

import {VECTOR_TTL_S, contentHash, vectorKey} from 'embedding/config';

const redis = new Redis({host: 'redis', port: 6379});

/** The cached vector of text for the tenant under the model; compute runs on a miss. */
export async function storeVector(
  tenant: string,
  modelVersion: string,
  text: string,
  compute: () => Promise<number[]>,
): Promise<number[]> {
  const key = vectorKey(tenant, modelVersion, contentHash(text));
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as number[];
  const vector = await compute();
  if ((await redis.set(key, JSON.stringify(vector), 'EX', VECTOR_TTL_S, 'NX')) === 'OK') return vector;
  const winner = await redis.get(key); // another worker stored first: its vector is the cached one
  return winner === null ? vector : (JSON.parse(winner) as number[]);
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

	"embedding/config" // config.VectorKey, ContentHash, VectorTTLSeconds — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// storeVector is the cached vector of text for the tenant under the model; compute runs on a miss.
func storeVector(ctx context.Context, tenant, modelVersion, text string, compute func() ([]float32, error)) ([]float32, error) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	key := "emb:" + tenant + ":" + config.ContentHash(text)
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var cached []float32
		return cached, json.Unmarshal([]byte(raw), &cached)
	}
	if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	vector, err := compute()
	if err != nil {
		return nil, err
	}
	doc, _ := json.Marshal(vector)
	if err := rdb.Set(ctx, key, doc, 0).Err(); err != nil {
		return nil, err
	}
	rdb.Expire(ctx, key, config.VectorTTLSeconds*time.Second)
	return vector, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"embedding/config" // config.VectorKey, ContentHash, VectorTTLSeconds — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// storeVector is the cached vector of text for the tenant under the model; compute runs on a miss.
func storeVector(ctx context.Context, tenant, modelVersion, text string, compute func() ([]float32, error)) ([]float32, error) {
	key := config.VectorKey(tenant, modelVersion, config.ContentHash(text))
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var cached []float32
		return cached, json.Unmarshal([]byte(raw), &cached)
	}
	if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	vector, err := compute()
	if err != nil {
		return nil, err
	}
	doc, _ := json.Marshal(vector)
	won, err := rdb.SetNX(ctx, key, doc, config.VectorTTLSeconds*time.Second).Result()
	if err != nil || won {
		return vector, err
	}
	// Another worker stored first: its vector is the cached one.
	winner, err := rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return vector, nil
	}
	if err != nil {
		return nil, err
	}
	var stored []float32
	return stored, json.Unmarshal([]byte(winner), &stored)
}
`,
    },
    cpp: {
      starter: `#include <functional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "embedding/config.h"  // config::redis, vectorKey, contentHash, kVectorTtlSeconds — provided

// The cached vector of text for the tenant under the model; compute runs on a miss.
std::vector<float> storeVector(const std::string& tenant, const std::string& model_version, const std::string& text,
                               const std::function<std::vector<float>()>& compute) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const std::string key = "emb:" + tenant + ":" + config::contentHash(text);
  if (const auto cached = config::redis().get(key)) return nlohmann::json::parse(*cached).get<std::vector<float>>();
  const std::vector<float> vector = compute();
  config::redis().set(key, nlohmann::json(vector).dump());
  config::redis().expire(key, config::kVectorTtlSeconds);
  return vector;
}
`,
      solution: `#include <chrono>
#include <functional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "embedding/config.h"  // config::redis, vectorKey, contentHash, kVectorTtlSeconds — provided

// The cached vector of text for the tenant under the model; compute runs on a miss.
std::vector<float> storeVector(const std::string& tenant, const std::string& model_version, const std::string& text,
                               const std::function<std::vector<float>()>& compute) {
  const std::string key = config::vectorKey(tenant, model_version, config::contentHash(text));
  if (const auto cached = config::redis().get(key)) return nlohmann::json::parse(*cached).get<std::vector<float>>();
  const std::vector<float> vector = compute();
  if (config::redis().set(key, nlohmann::json(vector).dump(), std::chrono::seconds(config::kVectorTtlSeconds),
                          sw::redis::UpdateType::NOT_EXIST))
    return vector;
  // Another worker stored first: its vector is the cached one.
  if (const auto winner = config::redis().get(key)) return nlohmann::json::parse(*winner).get<std::vector<float>>();
  return vector;
}
`,
    },
  },
  harness: {
    python: `import json

from embedding import model
from embedding.config import MODEL_VERSION, PREVIOUS_VERSION, VECTOR_TTL_S, content_hash, vector_key

TENANT = "acme"
TEXT = "How do I rotate an API key?"


class Compute:
    """The model call the worker hands in: counts its calls, may run a side effect first."""

    def __init__(self, vector, before=None):
        self.vector = vector
        self.before = before
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.before is not None:
            self.before()
        return list(self.vector)


def _key(version):
    return vector_key(TENANT, version, content_hash(TEXT))


def _stored(ctx, version):
    raw = ctx.redis.get(_key(version))
    return json.loads(raw) if raw is not None else None


def check_cache_hit(ctx):
    m = ctx.load("state")
    v2 = model.vector_for(MODEL_VERSION, TEXT)
    first = Compute(v2)
    assert m.store_vector(TENANT, MODEL_VERSION, TEXT, first) == v2, "a miss must return the computed vector"
    second = Compute(model.vector_for(MODEL_VERSION, "something else"))
    got = m.store_vector(TENANT, MODEL_VERSION, TEXT, second)
    assert second.calls == 0, "the second call for the same input computed again: a hit must be served from the cache"
    assert got == v2, f"a hit must return the stored vector {v2}, got {got}"


def check_version_key(ctx):
    m = ctx.load("state")
    v1, v2 = model.vector_for(PREVIOUS_VERSION, TEXT), model.vector_for(MODEL_VERSION, TEXT)
    m.store_vector(TENANT, PREVIOUS_VERSION, TEXT, Compute(v1))
    upgraded = Compute(v2)
    got = m.store_vector(TENANT, MODEL_VERSION, TEXT, upgraded)
    assert upgraded.calls == 1 and got == v2, f"after the upgrade an embed-v2 request was answered with {got}: the {PREVIOUS_VERSION} vector, because the key leaves out the model version"
    assert _stored(ctx, MODEL_VERSION) == v2, f"the embed-v2 vector must be stored under {_key(MODEL_VERSION)}; keys: {sorted(ctx.redis.keys('emb:*'))}"
    assert _stored(ctx, PREVIOUS_VERSION) == v1, f"the embed-v1 vector must stay under {_key(PREVIOUS_VERSION)} for explicit embed-v1 reads"
    again = Compute(v1)
    assert m.store_vector(TENANT, PREVIOUS_VERSION, TEXT, again) == v1 and again.calls == 0, "an embed-v1 request is still a hit on the embed-v1 vector"


def check_ttl_in_write(ctx):
    m = ctx.load("state")
    key = _key(MODEL_VERSION)
    probes = []

    def watch():
        # A read of the still-missing key leaves nothing behind: keep watching until the command that wrote it.
        ttl = ctx.redis.ttl(key)
        if ttl == -2:
            probes.append(ctx.redis_after(key, watch))
        return ttl

    def arm():
        # The next command on the key that leaves it stored is the write: what a crash right after it leaves.
        probes.append(ctx.redis_after(key, watch))

    m.store_vector(TENANT, MODEL_VERSION, TEXT, Compute(model.vector_for(MODEL_VERSION, TEXT), before=arm))
    written = [p for p in probes if p.fired and p.result != -2]
    assert written, f"store_vector never wrote {key}; keys: {sorted(ctx.redis.keys('emb:*'))}"
    ttl = written[0].result
    assert ttl is not None and ttl > 0, f"right after the command that wrote the vector its TTL was {ttl}: a crash before the EXPIRE leaves a vector that never expires. The TTL belongs in the SET"
    assert VECTOR_TTL_S - 5 <= ctx.redis.ttl(key) <= VECTOR_TTL_S, f"the vector must live VECTOR_TTL_S = {VECTOR_TTL_S} s, its TTL is {ctx.redis.ttl(key)}"


def check_first_writer_wins(ctx):
    m = ctx.load("state")
    key = _key(MODEL_VERSION)
    winner = [0.5, 0.25, -0.25, -0.5, 0.125, -0.125, 0.75, -0.75]

    def other_worker():
        # Another worker missed too, computed first and stored its vector.
        ctx.redis.set(key, json.dumps(winner), ex=VECTOR_TTL_S)

    got = m.store_vector(TENANT, MODEL_VERSION, TEXT, Compute(model.vector_for(MODEL_VERSION, TEXT), before=other_worker))
    assert _stored(ctx, MODEL_VERSION) == winner, f"another worker stored its vector while this one computed, and the cache now holds {_stored(ctx, MODEL_VERSION)}: the write overwrote the first writer"
    assert got == winner, f"store_vector returned its own vector {got} while the cache holds {winner}: two callers of one input now hold different vectors"

    # A second worker lands right after this one's next command on the key, once it has computed: a
    # check followed by a plain SET leaves a window between the two, and the racer stores first in it.
    raced_text = "How do I revoke a leaked key?"
    raced_key = vector_key(TENANT, MODEL_VERSION, content_hash(raced_text))
    racer = [-0.5, 0.5, 0.25, -0.25, 0.75, -0.75, 0.125, -0.125]
    probes = []

    def arm():
        probes.append(ctx.redis_after(raced_key, lambda: bool(ctx.redis.set(raced_key, json.dumps(racer), nx=True, ex=VECTOR_TTL_S))))

    got = m.store_vector(TENANT, MODEL_VERSION, raced_text, Compute(model.vector_for(MODEL_VERSION, raced_text), before=arm))
    raw = ctx.redis.get(raced_key)
    held = json.loads(raw) if raw is not None else None
    if probes and probes[0].result:
        assert held == racer, f"another worker stored its vector between this one's check of the key and its write, and the cache now holds {held}: the write overwrote the first writer. Only SET NX decides who wins"
    assert got == held, f"store_vector returned {got} while the cache holds {held}: two callers of one input now hold different vectors"
`,
    typescript: `const TENANT = 'acme';
const TEXT = 'How do I rotate an API key?';

function world(ctx) {
  return {
    m: ctx.load('state'),
    config: ctx.load('/support/embedding/config.ts'),
    model: ctx.load('/support/embedding/model.ts'),
  };
}

/** The model call the worker hands in: counts its calls, may run a side effect first. */
function computing(vector: number[], before?: () => void) {
  const compute = async () => {
    compute.calls += 1;
    if (before) before();
    return [...vector];
  };
  compute.calls = 0;
  return compute;
}

const stored = (ctx, key: string) => {
  const raw = ctx.redis.get(key);
  return raw === null ? null : JSON.parse(raw);
};

export async function check_cache_hit(ctx) {
  const {m, config, model} = world(ctx);
  const v2 = model.vectorFor(config.MODEL_VERSION, TEXT);
  assert.deepEqual(await m.storeVector(TENANT, config.MODEL_VERSION, TEXT, computing(v2)), v2, 'a miss must return the computed vector');
  const second = computing(model.vectorFor(config.MODEL_VERSION, 'something else'));
  const got = await m.storeVector(TENANT, config.MODEL_VERSION, TEXT, second);
  assert.equal(second.calls, 0, 'the second call for the same input computed again: a hit must be served from the cache');
  assert.deepEqual(got, v2, \`a hit must return the stored vector \${JSON.stringify(v2)}, got \${JSON.stringify(got)}\`);
}

export async function check_version_key(ctx) {
  const {m, config, model} = world(ctx);
  const v1 = model.vectorFor(config.PREVIOUS_VERSION, TEXT);
  const v2 = model.vectorFor(config.MODEL_VERSION, TEXT);
  const key = v => config.vectorKey(TENANT, v, config.contentHash(TEXT));
  await m.storeVector(TENANT, config.PREVIOUS_VERSION, TEXT, computing(v1));
  const upgraded = computing(v2);
  const got = await m.storeVector(TENANT, config.MODEL_VERSION, TEXT, upgraded);
  assert(upgraded.calls === 1 && JSON.stringify(got) === JSON.stringify(v2), \`after the upgrade an embed-v2 request was answered with \${JSON.stringify(got)}: the embed-v1 vector, because the key leaves out the model version\`);
  assert.deepEqual(stored(ctx, key(config.MODEL_VERSION)), v2, \`the embed-v2 vector must be stored under \${key(config.MODEL_VERSION)}; keys: \${JSON.stringify(ctx.redis.keys('emb:*'))}\`);
  assert.deepEqual(stored(ctx, key(config.PREVIOUS_VERSION)), v1, \`the embed-v1 vector must stay under \${key(config.PREVIOUS_VERSION)} for explicit embed-v1 reads\`);
  const again = computing(v1);
  assert.deepEqual(await m.storeVector(TENANT, config.PREVIOUS_VERSION, TEXT, again), v1, 'an embed-v1 request is still a hit on the embed-v1 vector');
  assert.equal(again.calls, 0, 'an embed-v1 request is still a hit on the embed-v1 vector');
}

export async function check_ttl_in_write(ctx) {
  const {m, config, model} = world(ctx);
  const key = config.vectorKey(TENANT, config.MODEL_VERSION, config.contentHash(TEXT));
  const probes = [];
  // A read of the still-missing key leaves nothing behind: keep watching until the command that wrote it.
  const watch = () => {
    const ttl = ctx.redis.ttl(key);
    if (ttl === -2) probes.push(ctx.redisAfter(key, watch));
    return ttl;
  };
  // The next command on the key that leaves it stored is the write: what a crash right after it leaves.
  const arm = () => probes.push(ctx.redisAfter(key, watch));
  await m.storeVector(TENANT, config.MODEL_VERSION, TEXT, computing(model.vectorFor(config.MODEL_VERSION, TEXT), arm));
  const written = probes.filter(p => p.fired && p.result !== -2);
  assert(written.length > 0, \`storeVector never wrote \${key}; keys: \${JSON.stringify(ctx.redis.keys('emb:*'))}\`);
  const ttl = written[0].result;
  assert(typeof ttl === 'number' && ttl > 0, \`right after the command that wrote the vector its TTL was \${ttl}: a crash before the EXPIRE leaves a vector that never expires. The TTL belongs in the SET\`);
  const now = ctx.redis.ttl(key);
  assert(now >= config.VECTOR_TTL_S - 5 && now <= config.VECTOR_TTL_S, \`the vector must live VECTOR_TTL_S = \${config.VECTOR_TTL_S} s, its TTL is \${now}\`);
}

export async function check_first_writer_wins(ctx) {
  const {m, config, model} = world(ctx);
  const key = config.vectorKey(TENANT, config.MODEL_VERSION, config.contentHash(TEXT));
  const winner = [0.5, 0.25, -0.25, -0.5, 0.125, -0.125, 0.75, -0.75];
  // Another worker missed too, computed first and stored its vector.
  const otherWorker = () => ctx.redis.set(key, JSON.stringify(winner), 'EX', config.VECTOR_TTL_S);
  const got = await m.storeVector(TENANT, config.MODEL_VERSION, TEXT, computing(model.vectorFor(config.MODEL_VERSION, TEXT), otherWorker));
  assert.deepEqual(stored(ctx, key), winner, \`another worker stored its vector while this one computed, and the cache now holds \${JSON.stringify(stored(ctx, key))}: the write overwrote the first writer\`);
  assert.deepEqual(got, winner, \`storeVector returned its own vector \${JSON.stringify(got)} while the cache holds \${JSON.stringify(winner)}: two callers of one input now hold different vectors\`);

  // A second worker lands right after this one's next command on the key, once it has computed: a
  // check followed by a plain SET leaves a window between the two, and the racer stores first in it.
  const racedText = 'How do I revoke a leaked key?';
  const racedKey = config.vectorKey(TENANT, config.MODEL_VERSION, config.contentHash(racedText));
  const racer = [-0.5, 0.5, 0.25, -0.25, 0.75, -0.75, 0.125, -0.125];
  const raced = [];
  const arm = () => raced.push(ctx.redisAfter(racedKey, () => ctx.redis.set(racedKey, JSON.stringify(racer), 'EX', config.VECTOR_TTL_S, 'NX') !== null));
  const second = await m.storeVector(TENANT, config.MODEL_VERSION, racedText, computing(model.vectorFor(config.MODEL_VERSION, racedText), arm));
  const held = stored(ctx, racedKey);
  if (raced.length > 0 && raced[0].result === true) {
    assert.deepEqual(held, racer, \`another worker stored its vector between this one's check of the key and its write, and the cache now holds \${JSON.stringify(held)}: the write overwrote the first writer. Only SET NX decides who wins\`);
  }
  assert.deepEqual(second, held, \`storeVector returned \${JSON.stringify(second)} while the cache holds \${JSON.stringify(held)}: two callers of one input now hold different vectors\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"embedding/config"
	"embedding/model"

	"leetbuild/harness"
)

const (
	kHStateTenant = "acme"
	kHStateText   = "How do I rotate an API key?"
)

// HStateCompute is the model call the worker hands in: it counts its calls and may run a side effect first.
type HStateCompute struct {
	vector []float32
	before func()
	calls  int
}

func (c *HStateCompute) fn() func() ([]float32, error) {
	return func() ([]float32, error) {
		c.calls++
		if c.before != nil {
			c.before()
		}
		return append([]float32(nil), c.vector...), nil
	}
}

func hStateKey(version string) string {
	return config.VectorKey(kHStateTenant, version, config.ContentHash(kHStateText))
}

func hStateStored(ctx *harness.Ctx, version string) []float32 {
	raw, ok := ctx.Redis.Get(hStateKey(version))
	if !ok {
		return nil
	}
	var v []float32
	json.Unmarshal([]byte(raw), &v)
	return v
}

func hStateStore(ctx *harness.Ctx, version string, c *HStateCompute) []float32 {
	got, err := storeVector(context.Background(), kHStateTenant, version, kHStateText, c.fn())
	ctx.NoError(err, "storeVector(%s)", version)
	return got
}

func CheckCacheHit(ctx *harness.Ctx) {
	v2 := model.VectorFor(config.ModelVersion, kHStateText)
	ctx.Equal(hStateStore(ctx, config.ModelVersion, &HStateCompute{vector: v2}), v2, "a miss must return the computed vector")
	second := &HStateCompute{vector: model.VectorFor(config.ModelVersion, "something else")}
	got := hStateStore(ctx, config.ModelVersion, second)
	ctx.Equal(second.calls, 0, "the second call for the same input computed again: a hit must be served from the cache; compute calls")
	ctx.Equal(got, v2, "a hit must return the stored vector")
}

func CheckVersionKey(ctx *harness.Ctx) {
	v1, v2 := model.VectorFor(config.PreviousVersion, kHStateText), model.VectorFor(config.ModelVersion, kHStateText)
	hStateStore(ctx, config.PreviousVersion, &HStateCompute{vector: v1})
	upgraded := &HStateCompute{vector: v2}
	got := hStateStore(ctx, config.ModelVersion, upgraded)
	ctx.Assert(upgraded.calls == 1 && len(got) == len(v2), "after the upgrade an embed-v2 request was answered with %v: the embed-v1 vector, because the key leaves out the model version", got)
	ctx.Equal(got, v2, "the embed-v2 request's vector")
	ctx.Equal(hStateStored(ctx, config.ModelVersion), v2, "the embed-v2 vector must be stored under %s (keys %v)", hStateKey(config.ModelVersion), ctx.Redis.Keys("emb:*"))
	ctx.Equal(hStateStored(ctx, config.PreviousVersion), v1, "the embed-v1 vector must stay under %s for explicit embed-v1 reads", hStateKey(config.PreviousVersion))
	again := &HStateCompute{vector: v1}
	ctx.Equal(hStateStore(ctx, config.PreviousVersion, again), v1, "an embed-v1 request is still a hit on the embed-v1 vector")
	ctx.Equal(again.calls, 0, "an embed-v1 request is still a hit; compute calls")
}

func CheckTtlInWrite(ctx *harness.Ctx) {
	key := hStateKey(config.ModelVersion)
	var ttl int64
	written := false
	// A read of the still-missing key leaves nothing behind: keep watching until the command that wrote it.
	var watch func() any
	watch = func() any {
		n := ctx.Redis.TTL(key)
		if n == -2 {
			ctx.Redis.After(key, watch)
		} else if !written {
			written, ttl = true, n
		}
		return n
	}
	// The next command on the key that leaves it stored is the write: what a crash right after it leaves.
	arm := func() { ctx.Redis.After(key, watch) }
	hStateStore(ctx, config.ModelVersion, &HStateCompute{vector: model.VectorFor(config.ModelVersion, kHStateText), before: arm})
	ctx.Assert(written, "storeVector never wrote %s; keys: %v", key, ctx.Redis.Keys("emb:*"))
	ctx.Assert(ttl > 0, "right after the command that wrote the vector its TTL was %d: a crash before the EXPIRE leaves a vector that never expires. The TTL belongs in the SET", ttl)
	now := ctx.Redis.TTL(key)
	ctx.Assert(now >= config.VectorTTLSeconds-5 && now <= config.VectorTTLSeconds, "the vector must live VectorTTLSeconds = %d s, its TTL is %d", config.VectorTTLSeconds, now)
}

func CheckFirstWriterWins(ctx *harness.Ctx) {
	key := hStateKey(config.ModelVersion)
	winner := []float32{0.5, 0.25, -0.25, -0.5, 0.125, -0.125, 0.75, -0.75}
	doc, _ := json.Marshal(winner)
	// Another worker missed too, computed first and stored its vector.
	otherWorker := func() { ctx.Redis.Set(key, string(doc), "EX", config.VectorTTLSeconds) }
	got := hStateStore(ctx, config.ModelVersion, &HStateCompute{vector: model.VectorFor(config.ModelVersion, kHStateText), before: otherWorker})
	ctx.Equal(hStateStored(ctx, config.ModelVersion), winner, "another worker stored its vector while this one computed: the write must not overwrite the first writer; the cache holds")
	ctx.Equal(got, winner, "storeVector must return the cached vector, not its own, or two callers of one input hold different vectors; it returned")

	// A second worker lands right after this one's next command on the key, once it has computed: a
	// check followed by a plain SET leaves a window between the two, and the racer stores first in it.
	racedText := "How do I revoke a leaked key?"
	racedKey := config.VectorKey(kHStateTenant, config.ModelVersion, config.ContentHash(racedText))
	racer := []float32{-0.5, 0.5, 0.25, -0.25, 0.75, -0.75, 0.125, -0.125}
	racerDoc, _ := json.Marshal(racer)
	racerStored := false
	arm := func() {
		ctx.Redis.After(racedKey, func() any {
			racerStored = ctx.Redis.Set(racedKey, string(racerDoc), "EX", config.VectorTTLSeconds, "NX")
			return racerStored
		})
	}
	compute := &HStateCompute{vector: model.VectorFor(config.ModelVersion, racedText), before: arm}
	second, err := storeVector(context.Background(), kHStateTenant, config.ModelVersion, racedText, compute.fn())
	ctx.NoError(err, "storeVector(%s)", racedText)
	var held []float32
	if raw, ok := ctx.Redis.Get(racedKey); ok {
		json.Unmarshal([]byte(raw), &held)
	}
	if racerStored {
		ctx.Equal(held, racer, "another worker stored its vector between this one's check of the key and its write: the write overwrote the first writer. Only SET NX decides who wins; the cache holds")
	}
	ctx.Equal(second, held, "storeVector must return the vector the cache holds, or two callers of one input hold different vectors; it returned")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "embedding/config.h"
#include "embedding/model.h"

namespace {

const std::string kHTenant = "acme";
const std::string kHText = "How do I rotate an API key?";

// The model call the worker hands in: counts its calls, may run a side effect first.
struct HCompute {
  std::vector<float> vector;
  std::function<void()> before;
  int calls = 0;
  std::function<std::vector<float>()> fn() {
    return [this] {
      calls++;
      if (before) before();
      return vector;
    };
  }
};

std::string hStateKey(const std::string& version) { return config::vectorKey(kHTenant, version, config::contentHash(kHText)); }

std::optional<std::vector<float>> hStored(harness::Ctx& ctx, const std::string& version) {
  const auto raw = ctx.Redis.Get(hStateKey(version));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<std::vector<float>>();
}

}  // namespace

void CheckCacheHit(harness::Ctx& ctx) {
  const auto v2 = model::vectorFor(config::kModelVersion, kHText);
  HCompute first{v2};
  ctx.Equal(storeVector(kHTenant, config::kModelVersion, kHText, first.fn()), v2, "a miss must return the computed vector");
  HCompute second{model::vectorFor(config::kModelVersion, "something else")};
  const auto got = storeVector(kHTenant, config::kModelVersion, kHText, second.fn());
  ctx.Equal(second.calls, 0, "the second call for the same input computed again: a hit must be served from the cache; compute calls");
  ctx.Equal(got, v2, "a hit must return the stored vector");
}

void CheckVersionKey(harness::Ctx& ctx) {
  const auto v1 = model::vectorFor(config::kPreviousVersion, kHText);
  const auto v2 = model::vectorFor(config::kModelVersion, kHText);
  HCompute old{v1};
  storeVector(kHTenant, config::kPreviousVersion, kHText, old.fn());
  HCompute upgraded{v2};
  const auto got = storeVector(kHTenant, config::kModelVersion, kHText, upgraded.fn());
  ctx.Assert(upgraded.calls == 1 && got.size() == v2.size(), "after the upgrade an embed-v2 request was answered with %v: the embed-v1 vector, because the key leaves out the model version", got);
  ctx.Equal(got, v2, "the embed-v2 request's vector");
  ctx.Equal(hStored(ctx, config::kModelVersion), std::optional<std::vector<float>>(v2), "the embed-v2 vector must be stored under %s (keys %v)", hStateKey(config::kModelVersion), ctx.Redis.Keys("emb:*"));
  ctx.Equal(hStored(ctx, config::kPreviousVersion), std::optional<std::vector<float>>(v1), "the embed-v1 vector must stay under %s for explicit embed-v1 reads", hStateKey(config::kPreviousVersion));
  HCompute again{v1};
  ctx.Equal(storeVector(kHTenant, config::kPreviousVersion, kHText, again.fn()), v1, "an embed-v1 request is still a hit on the embed-v1 vector");
  ctx.Equal(again.calls, 0, "an embed-v1 request is still a hit; compute calls");
}

void CheckTtlInWrite(harness::Ctx& ctx) {
  const std::string key = hStateKey(config::kModelVersion);
  bool written = false;
  long long ttl = 0;
  // A read of the still-missing key leaves nothing behind: keep watching until the command that wrote it.
  std::function<void()> watch = [&] {
    const long long n = ctx.Redis.TTL(key);
    if (n == -2) {
      ctx.Redis.After(key, watch);
    } else if (!written) {
      written = true;
      ttl = n;
    }
  };
  HCompute compute{model::vectorFor(config::kModelVersion, kHText)};
  // The next command on the key that leaves it stored is the write: what a crash right after it leaves.
  compute.before = [&] { ctx.Redis.After(key, watch); };
  storeVector(kHTenant, config::kModelVersion, kHText, compute.fn());
  ctx.Assert(written, "storeVector never wrote %s; keys: %v", key, ctx.Redis.Keys("emb:*"));
  ctx.Assert(ttl > 0, "right after the command that wrote the vector its TTL was %d: a crash before the EXPIRE leaves a vector that never expires. The TTL belongs in the SET", ttl);
  const long long now = ctx.Redis.TTL(key);
  ctx.Assert(now >= config::kVectorTtlSeconds - 5 && now <= config::kVectorTtlSeconds, "the vector must live kVectorTtlSeconds = %d s, its TTL is %d", config::kVectorTtlSeconds, now);
}

void CheckFirstWriterWins(harness::Ctx& ctx) {
  const std::string key = hStateKey(config::kModelVersion);
  const std::vector<float> winner = {0.5f, 0.25f, -0.25f, -0.5f, 0.125f, -0.125f, 0.75f, -0.75f};
  HCompute compute{model::vectorFor(config::kModelVersion, kHText)};
  // Another worker missed too, computed first and stored its vector.
  compute.before = [&] { ctx.Redis.Set(key, nlohmann::json(winner).dump(), "EX", config::kVectorTtlSeconds); };
  const auto got = storeVector(kHTenant, config::kModelVersion, kHText, compute.fn());
  ctx.Equal(hStored(ctx, config::kModelVersion), std::optional<std::vector<float>>(winner), "another worker stored its vector while this one computed: the write must not overwrite the first writer; the cache holds");
  ctx.Equal(got, winner, "storeVector must return the cached vector, not its own, or two callers of one input hold different vectors; it returned");

  // A second worker lands right after this one's next command on the key, once it has computed: a
  // check followed by a plain SET leaves a window between the two, and the racer stores first in it.
  const std::string raced_text = "How do I revoke a leaked key?";
  const std::string raced_key = config::vectorKey(kHTenant, config::kModelVersion, config::contentHash(raced_text));
  const std::vector<float> racer = {-0.5f, 0.5f, 0.25f, -0.25f, 0.75f, -0.75f, 0.125f, -0.125f};
  bool racer_stored = false;
  HCompute raced{model::vectorFor(config::kModelVersion, raced_text)};
  raced.before = [&] {
    ctx.Redis.After(raced_key, [&] { racer_stored = ctx.Redis.Set(raced_key, nlohmann::json(racer).dump(), "EX", config::kVectorTtlSeconds, "NX"); });
  };
  const auto second = storeVector(kHTenant, config::kModelVersion, raced_text, raced.fn());
  const auto raw = ctx.Redis.Get(raced_key);
  const std::vector<float> held = raw ? nlohmann::json::parse(*raw).get<std::vector<float>>() : std::vector<float>{};
  if (racer_stored) {
    ctx.Equal(held, racer, "another worker stored its vector between this one's check of the key and its write: the write overwrote the first writer. Only SET NX decides who wins; the cache holds");
  }
  ctx.Equal(second, held, "storeVector must return the vector the cache holds, or two callers of one input hold different vectors; it returned");
}
`,
  },
  hints: [
    'Upgrade to `embed-v2` and the first request for a cached text comes back with four values, the old model’s vector. Two workers that embed one input at once leave callers holding different vectors.',
    'The key holds the tenant and the hash but not the model, so every version shares one entry. The plain `SET` overwrites whatever another worker stored, and the `EXPIRE` is a second command a crash can skip.',
    'Build the key with `vector_key(tenant, model_version, content_hash(text))`, write with `r.set(key, value, nx=True, ex=VECTOR_TTL_S)`, and when that returns nothing, `GET` the key and return the stored vector.',
  ],
  debrief: `The model version belongs in the key because a vector only means something next to vectors from the same model: two versions of one text are different data, not a stale and a fresh copy. \`SET NX EX\` makes the write one command, so the first writer wins and the expiry cannot be lost between two round trips. Reading back after a lost \`NX\` is what makes the cache a single source of truth instead of a write-only log: every caller of one input returns the same vector, the one the retriever will later read. Production caches add a backfill job that re-embeds hot inputs ahead of a model switch, and a size bound per tenant.`,
};
