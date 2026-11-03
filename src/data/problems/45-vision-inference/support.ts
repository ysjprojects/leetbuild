/**
 * Hand-written support modules the vision steps import but no step builds: the `vision` package.
 * `config` is the contract every step agrees on (the model addresses, the topic, the GPU pool's size
 * and lease, the retention windows, the key layout); `inferences` is the inference store (Redis);
 * `objects` the object store stand-in the API fetches images from; `results` the record a finished
 * inference hands to publish; `outbox` the rows kept for the relay when the broker refuses a produce;
 * and `models` the deterministic stand-in the checks serve over gRPC in place of the two models.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'vision/__init__.py': '',
  'vision/config.py': `"""Addresses, topics, keys and limits every step of visiond agrees on."""
# The two model deployments (Predictor.Predict): stand-ins served by the checks (vision.models).
LARGE_MODEL = "vision-large:9000"
SMALL_MODEL = "vision-small:9000"
# One event per finished inference, keyed by model version, for the quality pipeline.
TOPIC = "vision.inference"
# GPU slots a tenant may hold at once, and how long a slot is leased before it frees itself.
GPU_TOKENS = 10
LEASE_S = 300
# A prediction is served for 30 days; the record that it was made is kept for a year.
RESULT_TTL_S = 30 * 86_400
METADATA_TTL_S = 365 * 86_400


def gpu_key(tenant: str) -> str:
    """The tenant's GPU pool: a sorted set of ticket -> lease expiry (unix seconds)."""
    return f"vision:gpu:{tenant}"
`,
  'vision/inferences.py': `"""
The inference store (provided): rows in Redis, keyed by id and by (tenant, Idempotency-Key).

A row is the inference plus its tenant: inference_id, tenant, status ("pending" until the worker
writes the result, then "complete"), task, image, content_hash, created_at (unix seconds), and once
complete label, confidence, model_version, downgraded. Rows live METADATA_TTL_S.
"""
import json

import redis

from vision.config import METADATA_TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class InferenceStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The inference this tenant started under idem_key, if any."""
        inference_id = r.get(f"vision:idem:{tenant}:{idem_key}")
        return self.by_id(inference_id) if inference_id else None

    def put(self, tenant: str, idem_key: str, inference: dict) -> None:
        """Store the inference under its id and under (tenant, idem_key); the row carries the tenant."""
        row = dict(inference, tenant=tenant)
        r.set(f"vision:inference:{inference['inference_id']}", json.dumps(row), ex=METADATA_TTL_S)
        r.set(f"vision:idem:{tenant}:{idem_key}", inference["inference_id"], ex=METADATA_TTL_S)

    def by_id(self, inference_id: str) -> dict | None:
        """The row (the inference plus its tenant), None when there is none."""
        raw = r.get(f"vision:inference:{inference_id}")
        return json.loads(raw) if raw else None


store = InferenceStore()
`,
  'vision/objects.py': `"""The object store stand-in (provided): image bytes by storage key, as a bucket would answer them."""
import redis

r = redis.Redis(host="redis", port=6379)


def fetch_object(key: str) -> bytes | None:
    """The bytes stored under key, None when there is no such object."""
    return r.get(f"vision:object:{key}")
`,
  'vision/results.py': `"""The finished inference (provided): what the worker hands to publish."""
from dataclasses import dataclass


@dataclass
class InferenceRecord:
    inference_id: str
    tenant: str
    task: str
    model_version: str
    label: str
    confidence: float
    downgraded: bool
    latency_ms: int
    content_hash: str
    # The storage key and a presigned URL to the image: tenant content the worker holds, not the topic.
    image_key: str
    image_url: str
`,
  'vision/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "vision:outbox"


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'vision/models.py': `"""
The stand-in for the two vision models. The checks serve it over gRPC (Predictor.Predict at
vision.config.LARGE_MODEL and SMALL_MODEL); the service's code never calls it directly. Deterministic
on purpose: the course grades what the service does around the models, not the pixels.

answer(task, model_version) -> (label, confidence):
  classify -> "tabby_cat", detect -> "person", embed -> "embedding";
  the large model is 0.92 confident, the small one 0.81
"""
LARGE_VERSION = "vision-large-3.1.0"
SMALL_VERSION = "vision-small-1.7.2"

LABELS = {"classify": "tabby_cat", "detect": "person", "embed": "embedding"}


def answer(task: str, model_version: str) -> tuple[str, float]:
    return LABELS.get(task, "tabby_cat"), 0.92 if model_version == LARGE_VERSION else 0.81
`,
};

export const supportModulesTs: Record<string, string> = {
  'vision/config.ts': `/** Addresses, topics, keys and limits every step of visiond agrees on. */
/** The two model deployments (Predictor.Predict): stand-ins served by the checks (vision/models). */
export const LARGE_MODEL = 'vision-large:9000';
export const SMALL_MODEL = 'vision-small:9000';
/** One event per finished inference, keyed by model version, for the quality pipeline. */
export const TOPIC = 'vision.inference';
/** GPU slots a tenant may hold at once, and how long a slot is leased before it frees itself. */
export const GPU_TOKENS = 10;
export const LEASE_S = 300;
/** A prediction is served for 30 days; the record that it was made is kept for a year. */
export const RESULT_TTL_S = 30 * 86_400;
export const METADATA_TTL_S = 365 * 86_400;

/** The tenant's GPU pool: a sorted set of ticket -> lease expiry (unix seconds). */
export const gpuKey = (tenant: string): string => \`vision:gpu:\${tenant}\`;
`,
  'vision/inferences.ts': `/**
 * The inference store (provided): rows in Redis, keyed by id and by (tenant, Idempotency-Key). Rows
 * live METADATA_TTL_S.
 */
import Redis from 'ioredis';

import {METADATA_TTL_S} from 'vision/config';

const redis = new Redis({host: 'redis', port: 6379});

/** An inference: "pending" until the worker writes the result, then "complete" with the result fields. */
export interface Inference {
  inference_id: string;
  status: string;
  task: string;
  image: string;
  content_hash: string;
  created_at: number;
  label?: string;
  confidence?: number;
  model_version?: string;
  downgraded?: boolean;
}

/** A stored inference: the inference plus the tenant that started it. */
export interface InferenceRow extends Inference {
  tenant: string;
}

export const store = {
  /** The inference this tenant started under idemKey, if any. */
  async get(tenant: string, idemKey: string): Promise<InferenceRow | null> {
    const inferenceId = await redis.get(\`vision:idem:\${tenant}:\${idemKey}\`);
    return inferenceId === null ? null : store.byId(inferenceId);
  },

  /** Store the inference under its id and under (tenant, idemKey); the row carries the tenant. */
  async put(tenant: string, idemKey: string, inference: Inference): Promise<void> {
    const row: InferenceRow = {...inference, tenant};
    await redis.set(\`vision:inference:\${inference.inference_id}\`, JSON.stringify(row), 'EX', METADATA_TTL_S);
    await redis.set(\`vision:idem:\${tenant}:\${idemKey}\`, inference.inference_id, 'EX', METADATA_TTL_S);
  },

  /** The row, null when there is none. */
  async byId(inferenceId: string): Promise<InferenceRow | null> {
    const raw = await redis.get(\`vision:inference:\${inferenceId}\`);
    return raw === null ? null : (JSON.parse(raw) as InferenceRow);
  },
};
`,
  'vision/objects.ts': `/** The object store stand-in (provided): image bytes by storage key, as a bucket would answer them. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** The bytes stored under key, null when there is no such object. */
export async function fetchObject(key: string): Promise<Buffer | null> {
  return redis.getBuffer(\`vision:object:\${key}\`);
}
`,
  'vision/results.ts': `/** The finished inference (provided): what the worker hands to publish. */
export interface InferenceRecord {
  inference_id: string;
  tenant: string;
  task: string;
  model_version: string;
  label: string;
  confidence: number;
  downgraded: boolean;
  latency_ms: number;
  content_hash: string;
  /** The storage key and a presigned URL to the image: tenant content the worker holds, not the topic. */
  image_key: string;
  image_url: string;
}
`,
  'vision/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'vision:outbox';

export const outbox = {
  /** Durably keep an event the broker refused. */
  async insertOutbox(event: Record<string, unknown>): Promise<void> {
    await redis.rpush(OUTBOX_KEY, JSON.stringify(event));
  },

  async rows(): Promise<Record<string, unknown>[]> {
    return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as Record<string, unknown>);
  },
};
`,
  'vision/models.ts': `/**
 * The stand-in for the two vision models. The checks serve it over gRPC (Predictor.Predict at
 * vision/config's LARGE_MODEL and SMALL_MODEL); the service's code never calls it directly.
 * Deterministic on purpose: the course grades what the service does around the models, not the pixels.
 *
 * answer(task, modelVersion) → {label, confidence}:
 *   classify → "tabby_cat", detect → "person", embed → "embedding";
 *   the large model is 0.92 confident, the small one 0.81
 */
export const LARGE_VERSION = 'vision-large-3.1.0';
export const SMALL_VERSION = 'vision-small-1.7.2';

const LABELS: Record<string, string> = {classify: 'tabby_cat', detect: 'person', embed: 'embedding'};

export function answer(task: string, modelVersion: string): {label: string; confidence: number} {
  return {label: LABELS[task] ?? 'tabby_cat', confidence: modelVersion === LARGE_VERSION ? 0.92 : 0.81};
}
`,
};

/** The Go twins: the same \`vision\` packages, imported as vision/config, vision/inferences, vision/objects, vision/results, vision/outbox, vision/models. */
export const supportModulesGo: Record<string, string> = {
  'vision/config/config.go': `// Package config holds the addresses, topics, keys and limits every step of visiond agrees on.
package config

const (
	// LargeModel and SmallModel are the two model deployments (Predictor.Predict): stand-ins
	// served by the checks (vision/models).
	LargeModel = "vision-large:9000"
	SmallModel = "vision-small:9000"
	// Topic carries one event per finished inference, keyed by model version, for the quality pipeline.
	Topic = "vision.inference"
	// GPUTokens is how many GPU slots a tenant may hold at once; LeaseSeconds how long a slot is
	// leased before it frees itself.
	GPUTokens    = 10
	LeaseSeconds = 300
	// A prediction is served for 30 days; the record that it was made is kept for a year.
	ResultTTLSeconds   = 30 * 86_400
	MetadataTTLSeconds = 365 * 86_400
)

// GPUKey is the tenant's GPU pool: a sorted set of ticket -> lease expiry (unix seconds).
func GPUKey(tenant string) string { return "vision:gpu:" + tenant }
`,
  'vision/inferences/inferences.go': `// Package inferences is the inference store (provided): rows in Redis, keyed by id and by
// (tenant, Idempotency-Key). Rows live config.MetadataTTLSeconds.
package inferences

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"vision/config"
)

const rowTTL = config.MetadataTTLSeconds * time.Second

// Inference is "pending" until the worker writes the result, then "complete" with the result fields.
type Inference struct {
	InferenceID  string  \`json:"inference_id"\`
	Status       string  \`json:"status"\`
	Task         string  \`json:"task"\`
	Image        string  \`json:"image"\`
	ContentHash  string  \`json:"content_hash"\`
	CreatedAt    int64   \`json:"created_at"\`
	Label        string  \`json:"label,omitempty"\`
	Confidence   float64 \`json:"confidence,omitempty"\`
	ModelVersion string  \`json:"model_version,omitempty"\`
	Downgraded   bool    \`json:"downgraded,omitempty"\`
	// Tenant is set on the stored row: the tenant that started the inference.
	Tenant string \`json:"tenant,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the inference tenant started under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Inference, error) {
	id, err := rdb.Get(ctx, "vision:idem:"+tenant+":"+idemKey).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ByID(ctx, id)
}

// Put stores the inference under its id and under (tenant, idemKey); the row carries the tenant.
func Put(ctx context.Context, tenant, idemKey string, inf Inference) error {
	inf.Tenant = tenant
	doc, err := json.Marshal(inf)
	if err != nil {
		return err
	}
	if err := rdb.Set(ctx, "vision:inference:"+inf.InferenceID, doc, rowTTL).Err(); err != nil {
		return err
	}
	return rdb.Set(ctx, "vision:idem:"+tenant+":"+idemKey, inf.InferenceID, rowTTL).Err()
}

// ByID is the row; nil when there is none.
func ByID(ctx context.Context, id string) (*Inference, error) {
	raw, err := rdb.Get(ctx, "vision:inference:"+id).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var inf Inference
	if err := json.Unmarshal(raw, &inf); err != nil {
		return nil, err
	}
	return &inf, nil
}
`,
  'vision/objects/objects.go': `// Package objects is the object store stand-in (provided): image bytes by storage key, as a bucket
// would answer them.
package objects

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Fetch is the bytes stored under key; nil when there is no such object.
func Fetch(ctx context.Context, key string) ([]byte, error) {
	raw, err := rdb.Get(ctx, "vision:object:"+key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return raw, err
}
`,
  'vision/results/results.go': `// Package results holds the finished inference (provided): what the worker hands to publish.
package results

// InferenceRecord is one finished inference. ImageKey and ImageURL (a presigned URL to the image)
// are tenant content the worker holds, not the topic.
type InferenceRecord struct {
	InferenceID  string
	Tenant       string
	Task         string
	ModelVersion string
	Label        string
	Confidence   float64
	Downgraded   bool
	LatencyMs    int
	ContentHash  string
	ImageKey     string
	ImageURL     string
}
`,
  'vision/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "vision:outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert durably keeps an event the broker refused (the event's JSON).
func Insert(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, Key, event).Err()
}

// Rows are the kept events, decoded, oldest first.
func Rows(ctx context.Context) ([]map[string]any, error) {
	raw, err := rdb.LRange(ctx, Key, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		var row map[string]any
		if err := json.Unmarshal([]byte(r), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
  'vision/models/models.go': `// Package models is the stand-in for the two vision models. The checks serve it over gRPC
// (Predictor.Predict at config.LargeModel and config.SmallModel); the service's code never calls it
// directly. Deterministic on purpose: the course grades what the service does around the models,
// not the pixels.
//
// Answer(task, modelVersion) → (label, confidence):
//
//	classify → "tabby_cat", detect → "person", embed → "embedding";
//	the large model is 0.92 confident, the small one 0.81
package models

const (
	LargeVersion = "vision-large-3.1.0"
	SmallVersion = "vision-small-1.7.2"
)

var labels = map[string]string{"classify": "tabby_cat", "detect": "person", "embed": "embedding"}

func Answer(task, modelVersion string) (string, float64) {
	label, ok := labels[task]
	if !ok {
		label = "tabby_cat"
	}
	if modelVersion == LargeVersion {
		return label, 0.92
	}
	return label, 0.81
}
`,
};

/** The C++ twins as headers (vision/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'vision/config.h': `// Addresses, topics, keys and limits every step of visiond agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The two model deployments (Predictor.Predict): stand-ins served by the checks (vision/models.h).
inline constexpr const char* kLargeModel = "vision-large:9000";
inline constexpr const char* kSmallModel = "vision-small:9000";
// One event per finished inference, keyed by model version, for the quality pipeline.
inline constexpr const char* kTopic = "vision.inference";
// GPU slots a tenant may hold at once, and how long a slot is leased before it frees itself.
inline constexpr long long kGpuTokens = 10;
inline constexpr long long kLeaseSeconds = 300;
// A prediction is served for 30 days; the record that it was made is kept for a year.
inline constexpr long long kResultTtlSeconds = 30LL * 86400;
inline constexpr long long kMetadataTtlSeconds = 365LL * 86400;

// The tenant's GPU pool: a sorted set of ticket -> lease expiry (unix seconds).
inline std::string gpu_key(const std::string& tenant) { return "vision:gpu:" + tenant; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'vision/inferences.h': `// The inference store (provided): rows in Redis, keyed by id and by (tenant, Idempotency-Key).
// A row is the inference plus its tenant: inference_id, tenant, status ("pending" until the worker
// writes the result, then "complete"), task, image, content_hash, created_at (unix seconds), and once
// complete label, confidence, model_version, downgraded. Rows live kMetadataTtlSeconds.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "vision/config.h"

namespace inferences {

// The row, if any.
inline std::optional<nlohmann::json> by_id(const std::string& inference_id) {
  const auto raw = config::redis().get("vision:inference:" + inference_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The inference this tenant started under idem_key, if any.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto inference_id = config::redis().get("vision:idem:" + tenant + ":" + idem_key);
  if (!inference_id) return std::nullopt;
  return by_id(*inference_id);
}

// Store the inference under its id and under (tenant, idem_key); the row carries the tenant.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& inference) {
  nlohmann::json row = inference;
  row["tenant"] = tenant;
  const std::string inference_id = inference.at("inference_id").get<std::string>();
  config::redis().set("vision:inference:" + inference_id, row.dump(), config::kMetadataTtlSeconds);
  config::redis().set("vision:idem:" + tenant + ":" + idem_key, inference_id, config::kMetadataTtlSeconds);
}

}  // namespace inferences
`,
  'vision/objects.h': `// The object store stand-in (provided): image bytes by storage key, as a bucket would answer them.
#pragma once

#include <optional>
#include <string>

#include "vision/config.h"

namespace objects {

// The bytes stored under key, nullopt when there is no such object.
inline std::optional<std::string> fetch_object(const std::string& key) { return config::redis().get("vision:object:" + key); }

}  // namespace objects
`,
  'vision/results.h': `// The finished inference (provided): what the worker hands to publish.
#pragma once

#include <string>

namespace results {

// One finished inference. image_key and image_url (a presigned URL to the image) are tenant content
// the worker holds, not the topic.
struct InferenceRecord {
  std::string inference_id;
  std::string tenant;
  std::string task;
  std::string model_version;
  std::string label;
  double confidence = 0;
  bool downgraded = false;
  int latency_ms = 0;
  std::string content_hash;
  std::string image_key;
  std::string image_url;
};

}  // namespace results
`,
  'vision/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vision/config.h"

namespace outbox {

inline constexpr const char* kKey = "vision:outbox";

// Durably keep an event the broker refused (its JSON).
inline void insert_outbox(const std::string& event_json) { config::redis().rpush(kKey, event_json); }

// The kept events, decoded, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<nlohmann::json> out;
  for (const auto& row : config::redis().lrange(kKey, 0, -1)) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'vision/models.h': `// The stand-in for the two vision models. The checks serve it over gRPC (Predictor.Predict at
// config::kLargeModel and config::kSmallModel); the service's code never calls it directly.
// Deterministic on purpose: the course grades what the service does around the models, not the pixels.
//
// answer(task, model_version) -> {label, confidence}:
//   classify -> "tabby_cat", detect -> "person", embed -> "embedding";
//   the large model is 0.92 confident, the small one 0.81
#pragma once

#include <string>

namespace models {

inline constexpr const char* kLargeVersion = "vision-large-3.1.0";
inline constexpr const char* kSmallVersion = "vision-small-1.7.2";

struct Answer {
  std::string label;
  double confidence = 0;
};

inline Answer answer(const std::string& task, const std::string& model_version) {
  std::string label = "tabby_cat";
  if (task == "detect") label = "person";
  if (task == "embed") label = "embedding";
  return {label, model_version == kLargeVersion ? 0.92 : 0.81};
}

}  // namespace models
`,
};

/** The Scala twins: the same \`vision\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('vision', 'Config')]: `package vision

/** Addresses, topics, keys and limits every step of visiond agrees on. */
object Config {
  /** The two model deployments (Predictor.Predict): stand-ins served by the checks. */
  val LargeModel = "vision-large:9000"
  val SmallModel = "vision-small:9000"
  /** One event per finished inference, keyed by model version, for the quality pipeline. */
  val Topic = "vision.inference"
  /** GPU slots a tenant may hold at once, and how long a slot is leased before it frees itself. */
  val GpuTokens = 10L
  val LeaseSeconds = 300L
  /** A prediction is served for 30 days; the record that it was made is kept for a year. */
  val ResultTtlSeconds: Long = 30L * 86400
  val MetadataTtlSeconds: Long = 365L * 86400

  /** The tenant's GPU pool: a sorted set of ticket -> lease expiry (unix seconds). */
  def gpuKey(tenant: String): String = s"vision:gpu:$tenant"
}
`,
  [scalaPath('vision', 'Inferences')]: `package vision

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/**
 * The inference store (provided): rows in Redis, keyed by id and by (tenant, Idempotency-Key). A row
 * is the inference's JSON plus its tenant: inference_id, tenant, status ("pending" until the worker
 * writes the result, then "complete"), task, image, content_hash, created_at (unix seconds), and once
 * complete label, confidence, model_version, downgraded. Rows live MetadataTtlSeconds.
 */
object Inferences {
  private val jedis = new JedisPooled("redis", 6379)

  /** The inference this tenant started under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[ujson.Obj] =
    Option(jedis.get(s"vision:idem:$tenant:$idemKey")).flatMap(byId)

  /** Store the inference under its id and under (tenant, idemKey); the row carries the tenant. */
  def put(tenant: String, idemKey: String, inference: ujson.Obj): Unit = {
    val row = ujson.Obj.from(inference.value)
    row("tenant") = tenant
    val id = inference("inference_id").str
    jedis.set(s"vision:inference:$id", ujson.write(row), SetParams.setParams().ex(Config.MetadataTtlSeconds))
    jedis.set(s"vision:idem:$tenant:$idemKey", id, SetParams.setParams().ex(Config.MetadataTtlSeconds))
    ()
  }

  /** The row, None when there is none. */
  def byId(inferenceId: String): Option[ujson.Obj] =
    Option(jedis.get(s"vision:inference:$inferenceId")).map(raw => ujson.read(raw).obj).map(ujson.Obj.from(_))
}
`,
  [scalaPath('vision', 'Objects')]: `package vision

import redis.clients.jedis.JedisPooled

/** The object store stand-in (provided): image bytes by storage key, as a bucket would answer them. */
object Objects {
  private val jedis = new JedisPooled("redis", 6379)

  /** The bytes stored under key, None when there is no such object. */
  def fetchObject(key: String): Option[Array[Byte]] = Option(jedis.get(s"vision:object:$key".getBytes("UTF-8")))
}
`,
  [scalaPath('vision', 'InferenceRecord')]: `package vision

/**
 * The finished inference (provided): what the worker hands to publish. image_key and image_url (a
 * presigned URL to the image) are tenant content the worker holds, not the topic.
 */
final case class InferenceRecord(
    inference_id: String,
    tenant: String,
    task: String,
    model_version: String,
    label: String,
    confidence: Double,
    downgraded: Boolean,
    latency_ms: Int,
    content_hash: String,
    image_key: String,
    image_url: String
)
`,
  [scalaPath('vision', 'Outbox')]: `package vision

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "vision:outbox"
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused (its JSON). */
  def insertOutbox(eventJson: String): Unit = {
    jedis.rpush(Key, eventJson)
    ()
  }

  /** The kept events, decoded, oldest first. */
  def rows(): List[ujson.Value] = jedis.lrange(Key, 0, -1).asScala.toList.map(ujson.read(_))
}
`,
};
