/**
 * Hand-written support modules the embedding-service steps import but no step builds: the
 * `embedding` package. `config` is the contract every step agrees on (the model server's address,
 * the two model versions and their dimensions, the topic, the key layout, TTLs, `EmbedError`,
 * `Chunk`); `model` is the deterministic stand-in the checks serve over gRPC in place of the model
 * server; `cache` is the vector cache as later steps use it (step 2 builds the same `store_vector`);
 * `replays` records what POST /v1/embeddings answered under an Idempotency-Key; `outbox` keeps the
 * events the broker refused. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'embedding/__init__.py': '',
  'embedding/config.py': `"""Addresses, models, keys and limits every step of the embedding service agrees on."""
import hashlib
from dataclasses import dataclass

# The model server's gRPC address (Embedder.Embed): a stand-in served by the checks (embedding.model).
MODEL_SERVER = "models:9000"
# The model the service embeds with, and the one before it: vectors of the two live side by side.
MODEL_VERSION = "embed-v2"
PREVIOUS_VERSION = "embed-v1"
# How many values a vector of each model has.
DIMENSIONS = {"embed-v2": 8, "embed-v1": 4}
# One event per document whose every chunk is stored, keyed by document id, for the indexer.
TOPIC = "embed.ready"
# A cached vector lives seven days; a recorded response one day.
VECTOR_TTL_S = 7 * 86_400
REPLAY_TTL_S = 86_400


class EmbedError(Exception):
    """The model server gave no usable vector; reason names why (unavailable, deadline_exceeded, invalid_argument, model_mismatch)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class Chunk:
    """One piece of a document and the vector the model gave it."""

    text: str
    vector: list[float]


def content_hash(text: str) -> str:
    """The SHA-256 of the input's UTF-8 bytes, as 64 hex digits."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def vector_key(tenant: str, model_version: str, digest: str) -> str:
    """Where one tenant's vector of one input under one model lives: a JSON array of floats."""
    return f"emb:{tenant}:{model_version}:{digest}"
`,
  'embedding/model.py': `"""
The stand-in for the model server. The checks serve it over gRPC (Embedder.Embed at
embedding.config.MODEL_SERVER); the service's code never calls it directly. Deterministic: the
vector of a text under a model is the first DIMENSIONS[model] bytes of
SHA-256(model_version + "\\\\n" + text), each byte b as (b - 128) / 128.
"""
import hashlib

from embedding.config import DIMENSIONS


def vector_for(model_version: str, text: str) -> list[float]:
    digest = hashlib.sha256(f"{model_version}\\n{text}".encode("utf-8")).digest()
    return [(b - 128) / 128 for b in digest[: DIMENSIONS.get(model_version, 0)]]
`,
  'embedding/cache.py': `"""
The vector cache (provided; step 2 builds the same store_vector): vector_key(tenant, model, hash)
holds a JSON array of floats for VECTOR_TTL_S. store_vector serves the cached vector, or computes
one and writes it with a single SET NX EX, so the first writer wins and every caller gets its
vector; read_vector is the exact-key read, None on a miss.
"""
import json
from typing import Callable

import redis

from embedding.config import VECTOR_TTL_S, content_hash, vector_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def store_vector(tenant: str, model_version: str, text: str, compute: Callable[[], list[float]]) -> list[float]:
    key = vector_key(tenant, model_version, content_hash(text))
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    vector = compute()
    if r.set(key, json.dumps(vector), nx=True, ex=VECTOR_TTL_S):
        return vector
    winner = r.get(key)
    return json.loads(winner) if winner is not None else vector


def read_vector(tenant: str, model_version: str, digest: str) -> list[float] | None:
    raw = r.get(vector_key(tenant, model_version, digest))
    return json.loads(raw) if raw is not None else None
`,
  'embedding/replays.py': `"""Recorded responses (provided): what POST /v1/embeddings answered under (tenant, Idempotency-Key), for its replays."""
import json

import redis

from embedding.config import REPLAY_TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def replay_key(tenant: str, key: str) -> str:
    return f"replay:{tenant}:{key}"


def get(tenant: str, key: str) -> dict | None:
    """The response recorded under (tenant, key), None when there is none."""
    raw = r.get(replay_key(tenant, key))
    return json.loads(raw) if raw is not None else None


def put(tenant: str, key: str, response: dict) -> None:
    """Record the response under (tenant, key) for REPLAY_TTL_S."""
    r.set(replay_key(tenant, key), json.dumps(response), ex=REPLAY_TTL_S)
`,
  'embedding/outbox.py': `"""The outbox (provided): events the broker refused, kept as {topic, key, value} for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "outbox:embed"


def insert_outbox(topic: str, key: str, value: str) -> None:
    """Durably keep a record the broker refused: its topic, its key and its value (the event's JSON)."""
    r.rpush(OUTBOX_KEY, json.dumps({"topic": topic, "key": key, "value": value}))


def rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'embedding/config.ts': `/** Addresses, models, keys and limits every step of the embedding service agrees on. */
import {createHash} from 'node:crypto';

/** The model server's gRPC address (Embedder.Embed): a stand-in served by the checks (embedding/model). */
export const MODEL_SERVER = 'models:9000';
/** The model the service embeds with, and the one before it: vectors of the two live side by side. */
export const MODEL_VERSION = 'embed-v2';
export const PREVIOUS_VERSION = 'embed-v1';
/** How many values a vector of each model has. */
export const DIMENSIONS: Record<string, number> = {'embed-v2': 8, 'embed-v1': 4};
/** One event per document whose every chunk is stored, keyed by document id, for the indexer. */
export const TOPIC = 'embed.ready';
/** A cached vector lives seven days; a recorded response one day. */
export const VECTOR_TTL_S = 7 * 86_400;
export const REPLAY_TTL_S = 86_400;

/** The model server gave no usable vector; reason names why (unavailable, deadline_exceeded, invalid_argument, model_mismatch). */
export class EmbedError extends Error {
  reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'EmbedError';
    this.reason = reason;
  }
}

/** One piece of a document and the vector the model gave it. */
export interface Chunk {
  text: string;
  vector: number[];
}

/** The SHA-256 of the input's UTF-8 bytes, as 64 hex digits. */
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex') as string;

/** Where one tenant's vector of one input under one model lives: a JSON array of floats. */
export const vectorKey = (tenant: string, modelVersion: string, digest: string): string =>
  \`emb:\${tenant}:\${modelVersion}:\${digest}\`;
`,
  'embedding/model.ts': `/**
 * The stand-in for the model server. The checks serve it over gRPC (Embedder.Embed at
 * MODEL_SERVER); the service's code never calls it directly. Deterministic: the vector of a text
 * under a model is the first DIMENSIONS[model] bytes of SHA-256(modelVersion + "\\\\n" + text), each
 * byte b as (b - 128) / 128.
 */
import {createHash} from 'node:crypto';

import {DIMENSIONS} from 'embedding/config';

export function vectorFor(modelVersion: string, text: string): number[] {
  const digest = createHash('sha256').update(\`\${modelVersion}\\n\${text}\`).digest() as Uint8Array;
  return Array.from(digest.slice(0, DIMENSIONS[modelVersion] ?? 0), b => (b - 128) / 128);
}
`,
  'embedding/cache.ts': `/**
 * The vector cache (provided; step 2 builds the same storeVector): vectorKey(tenant, model, hash)
 * holds a JSON array of floats for VECTOR_TTL_S. storeVector serves the cached vector, or computes
 * one and writes it with a single SET NX EX, so the first writer wins and every caller gets its
 * vector; readVector is the exact-key read, null on a miss.
 */
import Redis from 'ioredis';

import {VECTOR_TTL_S, contentHash, vectorKey} from 'embedding/config';

const redis = new Redis({host: 'redis', port: 6379});

export const cache = {
  async storeVector(tenant: string, modelVersion: string, text: string, compute: () => Promise<number[]>): Promise<number[]> {
    const key = vectorKey(tenant, modelVersion, contentHash(text));
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached) as number[];
    const vector = await compute();
    if ((await redis.set(key, JSON.stringify(vector), 'EX', VECTOR_TTL_S, 'NX')) === 'OK') return vector;
    const winner = await redis.get(key);
    return winner === null ? vector : (JSON.parse(winner) as number[]);
  },

  async readVector(tenant: string, modelVersion: string, digest: string): Promise<number[] | null> {
    const raw = await redis.get(vectorKey(tenant, modelVersion, digest));
    return raw === null ? null : (JSON.parse(raw) as number[]);
  },
};
`,
  'embedding/replays.ts': `/** Recorded responses (provided): what POST /v1/embeddings answered under (tenant, Idempotency-Key), for its replays. */
import Redis from 'ioredis';

import {REPLAY_TTL_S} from 'embedding/config';

const redis = new Redis({host: 'redis', port: 6379});

export const replayKey = (tenant: string, key: string): string => \`replay:\${tenant}:\${key}\`;

export const replays = {
  /** The response recorded under (tenant, key), null when there is none. */
  async get(tenant: string, key: string): Promise<Record<string, unknown> | null> {
    const raw = await redis.get(replayKey(tenant, key));
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  },

  /** Record the response under (tenant, key) for REPLAY_TTL_S. */
  async put(tenant: string, key: string, response: Record<string, unknown>): Promise<void> {
    await redis.set(replayKey(tenant, key), JSON.stringify(response), 'EX', REPLAY_TTL_S);
  },
};
`,
  'embedding/outbox.ts': `/** The outbox (provided): events the broker refused, kept as {topic, key, value} for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'outbox:embed';

export const outbox = {
  /** Durably keep a record the broker refused: its topic, its key and its value (the event's JSON). */
  async insertOutbox(topic: string, key: string, value: string): Promise<void> {
    await redis.rpush(OUTBOX_KEY, JSON.stringify({topic, key, value}));
  },

  async rows(): Promise<{topic: string; key: string; value: string}[]> {
    return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as {topic: string; key: string; value: string});
  },
};
`,
};

/** The Go twins: the same packages, imported as embedding/config, embedding/model, embedding/cache, embedding/replays, embedding/outbox. */
export const supportModulesGo: Record<string, string> = {
  'embedding/config/config.go': `// Package config holds the addresses, models, keys and limits every step of the embedding service agrees on.
package config

import (
	"crypto/sha256"
	"encoding/hex"
)

const (
	// ModelServer is the model server's gRPC address (Embedder.Embed): a stand-in served by the checks (embedding/model).
	ModelServer = "models:9000"
	// ModelVersion is the model the service embeds with, PreviousVersion the one before it: vectors of the two live side by side.
	ModelVersion    = "embed-v2"
	PreviousVersion = "embed-v1"
	// Topic carries one event per document whose every chunk is stored, keyed by document id, for the indexer.
	Topic = "embed.ready"
	// VectorTTLSeconds: a cached vector lives seven days. ReplayTTLSeconds: a recorded response one day.
	VectorTTLSeconds = 7 * 86_400
	ReplayTTLSeconds = 86_400
)

// Dimensions is how many values a vector of each model has.
var Dimensions = map[string]int{ModelVersion: 8, PreviousVersion: 4}

// EmbedError is returned when the model server gave no usable vector; Reason names why
// (unavailable, deadline_exceeded, invalid_argument, model_mismatch).
type EmbedError struct{ Reason string }

func (e *EmbedError) Error() string { return "embed: " + e.Reason }

// Chunk is one piece of a document and the vector the model gave it.
type Chunk struct {
	Text   string
	Vector []float32
}

// ContentHash is the SHA-256 of the input's UTF-8 bytes, as 64 hex digits.
func ContentHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// VectorKey is where one tenant's vector of one input under one model lives: a JSON array of floats.
func VectorKey(tenant, modelVersion, digest string) string {
	return "emb:" + tenant + ":" + modelVersion + ":" + digest
}
`,
  'embedding/model/model.go': `// Package model is the stand-in for the model server. The checks serve it over gRPC
// (Embedder.Embed at config.ModelServer); the service's code never calls it directly.
// Deterministic: the vector of a text under a model is the first Dimensions[model] bytes of
// SHA-256(modelVersion + "\\n" + text), each byte b as (b - 128) / 128.
package model

import (
	"crypto/sha256"

	"embedding/config"
)

// VectorFor is the model's vector of text.
func VectorFor(modelVersion, text string) []float32 {
	sum := sha256.Sum256([]byte(modelVersion + "\\n" + text))
	out := make([]float32, config.Dimensions[modelVersion])
	for i := range out {
		out[i] = (float32(sum[i]) - 128) / 128
	}
	return out
}
`,
  'embedding/cache/cache.go': `// Package cache is the vector cache (provided; step 2 builds the same storeVector):
// config.VectorKey(tenant, model, hash) holds a JSON array of floats for VectorTTLSeconds.
// StoreVector serves the cached vector, or computes one and writes it with a single SET NX EX, so
// the first writer wins and every caller gets its vector; ReadVector is the exact-key read, nil on
// a miss.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"embedding/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func read(ctx context.Context, key string) ([]float32, error) {
	raw, err := rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var vector []float32
	return vector, json.Unmarshal([]byte(raw), &vector)
}

// StoreVector serves the cached vector, or computes one and writes it with SET NX EX.
func StoreVector(ctx context.Context, tenant, modelVersion, text string, compute func() ([]float32, error)) ([]float32, error) {
	key := config.VectorKey(tenant, modelVersion, config.ContentHash(text))
	if cached, err := read(ctx, key); err != nil || cached != nil {
		return cached, err
	}
	vector, err := compute()
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(vector)
	won, err := rdb.SetNX(ctx, key, raw, config.VectorTTLSeconds*time.Second).Result()
	if err != nil || won {
		return vector, err
	}
	if winner, err := read(ctx, key); err != nil || winner != nil {
		return winner, err
	}
	return vector, nil
}

// ReadVector is the exact-key read: the tenant's vector of the hash under the model, nil on a miss.
func ReadVector(ctx context.Context, tenant, modelVersion, digest string) ([]float32, error) {
	return read(ctx, config.VectorKey(tenant, modelVersion, digest))
}
`,
  'embedding/replays/replays.go': `// Package replays records what POST /v1/embeddings answered under (tenant, Idempotency-Key), for its replays (provided).
package replays

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"embedding/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Key is where the response recorded under (tenant, key) lives.
func Key(tenant, key string) string { return "replay:" + tenant + ":" + key }

// Get is the response (its JSON) recorded under (tenant, key); nil when there is none.
func Get(ctx context.Context, tenant, key string) ([]byte, error) {
	raw, err := rdb.Get(ctx, Key(tenant, key)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return raw, err
}

// Put records the response (its JSON) under (tenant, key) for ReplayTTLSeconds.
func Put(ctx context.Context, tenant, key string, response []byte) error {
	return rdb.Set(ctx, Key(tenant, key), response, config.ReplayTTLSeconds*time.Second).Err()
}
`,
  'embedding/outbox/outbox.go': `// Package outbox keeps the events the broker refused, as {topic, key, value}, for the relay to republish (provided).
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

// Key is the list the rows are kept in, oldest first.
const Key = "outbox:embed"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// InsertOutbox durably keeps a record the broker refused: its topic, its key and its value (the event's JSON).
func InsertOutbox(ctx context.Context, topic, key string, value []byte) error {
	row, _ := json.Marshal(map[string]string{"topic": topic, "key": key, "value": string(value)})
	return rdb.RPush(ctx, Key, row).Err()
}
`,
};

/** The C++ twins as headers (embedding/*.h), plus digest.h (SHA-256). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'embedding/config.h': `// Addresses, models, keys and limits every step of the embedding service agrees on.
#pragma once

#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include <sw/redis++/redis++.h>

#include "digest.h"

namespace config {

// The model server's gRPC address (Embedder.Embed): a stand-in served by the checks (embedding/model.h).
inline constexpr const char* kModelServer = "models:9000";
// The model the service embeds with, and the one before it: vectors of the two live side by side.
inline constexpr const char* kModelVersion = "embed-v2";
inline constexpr const char* kPreviousVersion = "embed-v1";
// How many values a vector of each model has.
inline const std::map<std::string, int> kDimensions = {{"embed-v2", 8}, {"embed-v1", 4}};
// One event per document whose every chunk is stored, keyed by document id, for the indexer.
inline constexpr const char* kTopic = "embed.ready";
// A cached vector lives seven days; a recorded response one day.
inline constexpr long long kVectorTtlSeconds = 7 * 86400;
inline constexpr long long kReplayTtlSeconds = 86400;

// The model server gave no usable vector; reason names why (unavailable, deadline_exceeded,
// invalid_argument, model_mismatch).
struct EmbedError : std::runtime_error {
  std::string reason;
  explicit EmbedError(const std::string& why) : std::runtime_error("embed: " + why), reason(why) {}
};

// One piece of a document and the vector the model gave it.
struct Chunk {
  std::string text;
  std::vector<float> vector;
};

// The SHA-256 of the input's UTF-8 bytes, as 64 hex digits.
inline std::string contentHash(const std::string& text) { return sha256_hex(text); }

// Where one tenant's vector of one input under one model lives: a JSON array of floats.
inline std::string vectorKey(const std::string& tenant, const std::string& model_version, const std::string& digest) {
  return "emb:" + tenant + ":" + model_version + ":" + digest;
}

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'embedding/model.h': `// The stand-in for the model server. The checks serve it over gRPC (Embedder.Embed at
// config::kModelServer); the service's code never calls it directly. Deterministic: the vector of
// a text under a model is the first kDimensions[model] bytes of SHA-256(model_version + "\\n" +
// text), each byte b as (b - 128) / 128.
#pragma once

#include <string>
#include <vector>

#include "digest.h"
#include "embedding/config.h"

namespace model {

inline std::vector<float> vectorFor(const std::string& model_version, const std::string& text) {
  const std::string hex = sha256_hex(model_version + "\\n" + text);
  const auto it = config::kDimensions.find(model_version);
  const int n = it == config::kDimensions.end() ? 0 : it->second;
  std::vector<float> out;
  for (int i = 0; i < n; i++) {
    const int b = std::stoi(hex.substr(static_cast<size_t>(i) * 2, 2), nullptr, 16);
    out.push_back(static_cast<float>(b - 128) / 128.0f);
  }
  return out;
}

}  // namespace model
`,
  'embedding/cache.h': `// The vector cache (provided; step 2 builds the same storeVector): config::vectorKey(tenant, model,
// hash) holds a JSON array of floats for kVectorTtlSeconds. storeVector serves the cached vector, or
// computes one and writes it with a single SET NX EX, so the first writer wins and every caller gets
// its vector; readVector is the exact-key read, nothing on a miss.
#pragma once

#include <chrono>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "embedding/config.h"

namespace cache {

inline std::optional<std::vector<float>> readKey(const std::string& key) {
  const auto raw = config::redis().get(key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<std::vector<float>>();
}

inline std::vector<float> storeVector(const std::string& tenant, const std::string& model_version, const std::string& text,
                                      const std::function<std::vector<float>()>& compute) {
  const std::string key = config::vectorKey(tenant, model_version, config::contentHash(text));
  if (const auto cached = readKey(key)) return *cached;
  const std::vector<float> vector = compute();
  if (config::redis().set(key, nlohmann::json(vector).dump(), std::chrono::seconds(config::kVectorTtlSeconds),
                          sw::redis::UpdateType::NOT_EXIST))
    return vector;
  if (const auto winner = readKey(key)) return *winner;
  return vector;
}

inline std::optional<std::vector<float>> readVector(const std::string& tenant, const std::string& model_version,
                                                    const std::string& digest) {
  return readKey(config::vectorKey(tenant, model_version, digest));
}

}  // namespace cache
`,
  'embedding/replays.h': `// Recorded responses (provided): what POST /v1/embeddings answered under (tenant, Idempotency-Key),
// for its replays.
#pragma once

#include <chrono>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "embedding/config.h"

namespace replays {

inline std::string key(const std::string& tenant, const std::string& idem_key) { return "replay:" + tenant + ":" + idem_key; }

// The response recorded under (tenant, key), nothing when there is none.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto raw = config::redis().get(key(tenant, idem_key));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record the response under (tenant, key) for kReplayTtlSeconds.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& response) {
  config::redis().set(key(tenant, idem_key), response.dump(), std::chrono::seconds(config::kReplayTtlSeconds));
}

}  // namespace replays
`,
  'embedding/outbox.h': `// The outbox (provided): events the broker refused, kept as {topic, key, value} for the relay to
// republish.
#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "embedding/config.h"

namespace outbox {

inline constexpr const char* kKey = "outbox:embed";

// Durably keep a record the broker refused: its topic, its key and its value (the event's JSON).
inline void insertOutbox(const std::string& topic, const std::string& key, const std::string& value) {
  config::redis().rpush(kKey, nlohmann::json{{"topic", topic}, {"key", key}, {"value", value}}.dump());
}

}  // namespace outbox
`,
};

/** The Scala twins: the same \`embedding\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('embedding', 'Config')]: `package embedding

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/** The model server gave no usable vector; reason names why (unavailable, deadline_exceeded, invalid_argument, model_mismatch). */
final case class EmbedError(reason: String) extends RuntimeException(s"embed: $reason")

/** One piece of a document and the vector the model gave it. */
final case class Chunk(text: String, vector: Seq[Float])

/** Addresses, models, keys and limits every step of the embedding service agrees on. */
object Config {
  /** The model server's gRPC address (Embedder.Embed): a stand-in served by the checks (embedding.Model). */
  val ModelServer = "models:9000"
  /** The model the service embeds with, and the one before it: vectors of the two live side by side. */
  val ModelVersion = "embed-v2"
  val PreviousVersion = "embed-v1"
  /** How many values a vector of each model has. */
  val Dimensions: Map[String, Int] = Map("embed-v2" -> 8, "embed-v1" -> 4)
  /** One event per document whose every chunk is stored, keyed by document id, for the indexer. */
  val Topic = "embed.ready"
  /** A cached vector lives seven days; a recorded response one day. */
  val VectorTtlSeconds: Long = 7L * 86400
  val ReplayTtlSeconds: Long = 86400L

  /** The SHA-256 of the input's UTF-8 bytes, as 64 hex digits. */
  def contentHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(UTF_8)).map(b => f"\${b & 0xff}%02x").mkString

  /** Where one tenant's vector of one input under one model lives: a JSON array of floats. */
  def vectorKey(tenant: String, modelVersion: String, digest: String): String = s"emb:$tenant:$modelVersion:$digest"
}
`,
  [scalaPath('embedding', 'Model')]: `package embedding

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/**
 * The stand-in for the model server. The checks serve it over gRPC (Embedder.Embed at
 * Config.ModelServer); the service's code never calls it directly. Deterministic: the vector of a
 * text under a model is the first Dimensions(model) bytes of SHA-256(modelVersion + "\\\\n" + text),
 * each byte b as (b - 128) / 128.
 */
object Model {
  def vectorFor(modelVersion: String, text: String): Seq[Float] = {
    val digest = MessageDigest.getInstance("SHA-256").digest(s"$modelVersion\\n$text".getBytes(UTF_8))
    digest.take(Config.Dimensions.getOrElse(modelVersion, 0)).toSeq.map(b => ((b & 0xff) - 128) / 128f)
  }
}
`,
  [scalaPath('embedding', 'Cache')]: `package embedding

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/**
 * The vector cache (provided; step 2 builds the same storeVector): Config.vectorKey(tenant, model,
 * hash) holds a JSON array of floats for VectorTtlSeconds. storeVector serves the cached vector, or
 * computes one and writes it with a single SET NX EX, so the first writer wins and every caller gets
 * its vector; readVector is the exact-key read, None on a miss.
 */
object Cache {
  private val jedis = new JedisPooled("redis", 6379)

  private def decode(raw: String): Seq[Float] = ujson.read(raw).arr.map(_.num.toFloat).toSeq
  private def encode(vector: Seq[Float]): String = ujson.write(ujson.Arr.from(vector.map(v => ujson.Num(v.toDouble))))

  def storeVector(tenant: String, modelVersion: String, text: String, compute: () => Seq[Float]): Seq[Float] = {
    val key = Config.vectorKey(tenant, modelVersion, Config.contentHash(text))
    Option(jedis.get(key)) match {
      case Some(cached) => decode(cached)
      case None =>
        val vector = compute()
        if (jedis.set(key, encode(vector), SetParams.setParams().nx().ex(Config.VectorTtlSeconds)) != null) vector
        else Option(jedis.get(key)).map(decode).getOrElse(vector)
    }
  }

  def readVector(tenant: String, modelVersion: String, digest: String): Option[Seq[Float]] =
    Option(jedis.get(Config.vectorKey(tenant, modelVersion, digest))).map(decode)
}
`,
  [scalaPath('embedding', 'Replays')]: `package embedding

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** Recorded responses (provided): what POST /v1/embeddings answered under (tenant, Idempotency-Key), for its replays. */
object Replays {
  private val jedis = new JedisPooled("redis", 6379)

  def key(tenant: String, idemKey: String): String = s"replay:$tenant:$idemKey"

  /** The response (its JSON) recorded under (tenant, key), None when there is none. */
  def get(tenant: String, idemKey: String): Option[String] = Option(jedis.get(key(tenant, idemKey)))

  /** Record the response (its JSON) under (tenant, key) for ReplayTtlSeconds. */
  def put(tenant: String, idemKey: String, response: String): Unit = {
    jedis.set(key(tenant, idemKey), response, SetParams.setParams().ex(Config.ReplayTtlSeconds))
    ()
  }
}
`,
  [scalaPath('embedding', 'Outbox')]: `package embedding

import redis.clients.jedis.JedisPooled

/** The outbox (provided): events the broker refused, kept as {topic, key, value} for the relay to republish. */
object Outbox {
  val Key = "outbox:embed"
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep a record the broker refused: its topic, its key and its value (the event's JSON). */
  def insertOutbox(topic: String, key: String, value: String): Unit = {
    jedis.rpush(Key, ujson.write(ujson.Obj("topic" -> topic, "key" -> key, "value" -> value)))
    ()
  }
}
`,
};
