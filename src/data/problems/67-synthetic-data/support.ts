/**
 * Hand-written support modules the synthetic-data steps import but no step builds: the `synth`
 * package. `config` is the contract every step agrees on (the judge's address, the topic, the window
 * and the key layout); `seeds` the seed registry with each seed's license; `jobs` the job store and the
 * generation queue (Redis); `records` the generated record a worker holds and the seed digest; `outbox`
 * the rows kept for the relay when the broker refuses an event; and `judge` the deterministic stand-in
 * the checks serve over gRPC in place of the judge model.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'synth/__init__.py': '',
  'synth/config.py': `"""Addresses, topics, windows and keys every step of synthd agrees on."""
# The judge model's gRPC address: a stand-in served by the checks (synth.judge).
JUDGE = "judge:9000"
# One event per admitted record, keyed by recipe id, for the curation consumers.
TOPIC = "synthetic.record"
# The diversity window: at most ENTITY_LIMIT records per seed entity per WINDOW_S seconds.
WINDOW_S = 60
ENTITY_LIMIT = 5
# Every key a job owns expires this long after its last move.
TTL_S = 86_400

# The job's keys in Redis. progress: a hash of generated, admitted, parked, rejected, throttled and
# updated_at (unix seconds). window: a counter per entity per window, window = int(time.time()) // WINDOW_S.
# coverage: a hash of entity id -> admitted records. records: a hash of record id -> seed digest.


def progress_key(job_id: str) -> str:
    return f"synth:progress:{job_id}"


def window_key(job_id: str, entity_id: str, window: int) -> str:
    return f"synth:window:{job_id}:{entity_id}:{window}"


def coverage_key(job_id: str) -> str:
    return f"synth:coverage:{job_id}"


def records_key(job_id: str) -> str:
    return f"synth:records:{job_id}"
`,
  'synth/seeds.py': `"""The seed registry (provided): every seed dataset a job may expand, by (dataset, version), with its license."""
SEED_REGISTRY: dict[tuple[str, str], dict] = {
    ("wiki-qa", "2026-04-01"): {"license": "CC-BY-SA-4.0", "derivative_ok": True},
    ("news-crawl", "2026-02-15"): {"license": "publisher-no-derivatives", "derivative_ok": False},
}


def lookup(dataset: str, version: str) -> dict | None:
    """The registered seed {dataset, version, license, derivative_ok}, None when (dataset, version) is not registered."""
    row = SEED_REGISTRY.get((dataset, version))
    return None if row is None else dict(row, dataset=dataset, version=version)
`,
  'synth/jobs.py': `"""The job store and the generation queue (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key)."""
import json

import redis

from synth.config import TTL_S

JOB_TTL_S = 7 * TTL_S
QUEUE_KEY = "synth:queue"

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class JobStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The job this tenant submitted under idem_key, if any."""
        job_id = r.get(f"synth:idem:{tenant}:{idem_key}")
        return self.by_id(job_id) if job_id else None

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the job under its id and under (tenant, idem_key); the row carries the tenant."""
        row = dict(job, tenant=tenant)
        r.set(f"synth:job:{job['job_id']}", json.dumps(row), ex=JOB_TTL_S)
        r.set(f"synth:idem:{tenant}:{idem_key}", job["job_id"], ex=JOB_TTL_S)

    def by_id(self, job_id: str) -> dict | None:
        """The job row (the job plus its tenant), None when there is none."""
        raw = r.get(f"synth:job:{job_id}")
        return json.loads(raw) if raw else None


store = JobStore()


def enqueue(job: dict) -> None:
    """Hand the job to the generator workers: from here on, records get generated."""
    r.rpush(QUEUE_KEY, job["job_id"])
`,
  'synth/records.py': `"""The generated record (provided): what a worker holds between generation and admission."""
import hashlib
from dataclasses import dataclass


@dataclass
class SyntheticRecord:
    record_id: str
    job_id: str
    recipe_id: str
    entity_id: str
    # The record's position in its job (0, 1, 2, ...).
    seq: int
    # The seed record it was expanded from, and the generated text: both are content the worker has
    # and the topic and the logs must not.
    seed_text: str
    text: str


def seed_digest(seed_text: str) -> str:
    """The provenance digest: the hex SHA-256 of a seed record's text."""
    return hashlib.sha256(seed_text.encode("utf-8")).hexdigest()
`,
  'synth/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "synth:outbox"


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'synth/judge.py': `"""
The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at synth.config.JUDGE);
the pipeline's code never calls it directly. Deterministic on purpose: the course grades what the
pipeline does around the judge, not the judging.

score(text) -> (score, refused):
  a text starting with "refuse:" is declined (0.0, True)
  anything else scores SCORE (0.87, False)
"""
JUDGE_VERSION = "judge-rm-2026.10"
SCORE = 0.87


def score(text: str) -> tuple[float, bool]:
    if text.startswith("refuse:"):
        return 0.0, True
    return SCORE, False
`,
};

export const supportModulesTs: Record<string, string> = {
  'synth/config.ts': `/** Addresses, topics, windows and keys every step of synthd agrees on. */
/** The judge model's gRPC address: a stand-in served by the checks (synth/judge). */
export const JUDGE = 'judge:9000';
/** One event per admitted record, keyed by recipe id, for the curation consumers. */
export const TOPIC = 'synthetic.record';
/** The diversity window: at most ENTITY_LIMIT records per seed entity per WINDOW_S seconds. */
export const WINDOW_S = 60;
export const ENTITY_LIMIT = 5;
/** Every key a job owns expires this long after its last move. */
export const TTL_S = 86_400;

// The job's keys in Redis. progress: a hash of generated, admitted, parked, rejected, throttled and
// updated_at (unix seconds). window: a counter per entity per window, window = Math.floor(Date.now() / 1000 / WINDOW_S).
// coverage: a hash of entity id -> admitted records. records: a hash of record id -> seed digest.
export const progressKey = (jobId: string): string => \`synth:progress:\${jobId}\`;
export const windowKey = (jobId: string, entityId: string, window: number): string =>
  \`synth:window:\${jobId}:\${entityId}:\${window}\`;
export const coverageKey = (jobId: string): string => \`synth:coverage:\${jobId}\`;
export const recordsKey = (jobId: string): string => \`synth:records:\${jobId}\`;
`,
  'synth/seeds.ts': `/** The seed registry (provided): every seed dataset a job may expand, by (dataset, version), with its license. */
export interface Seed {
  dataset: string;
  version: string;
  license: string;
  derivative_ok: boolean;
}

const SEED_REGISTRY: Record<string, {license: string; derivative_ok: boolean}> = {
  'wiki-qa@2026-04-01': {license: 'CC-BY-SA-4.0', derivative_ok: true},
  'news-crawl@2026-02-15': {license: 'publisher-no-derivatives', derivative_ok: false},
};

/** The registered seed, null when (dataset, version) is not registered. */
export function lookup(dataset: string, version: string): Seed | null {
  const row = SEED_REGISTRY[\`\${dataset}@\${version}\`];
  return row === undefined ? null : {dataset, version, ...row};
}
`,
  'synth/jobs.ts': `/** The job store and the generation queue (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key). */
import Redis from 'ioredis';

import {TTL_S} from 'synth/config';

export const JOB_TTL_S = 7 * TTL_S;
export const QUEUE_KEY = 'synth:queue';

const redis = new Redis({host: 'redis', port: 6379});

export interface Job {
  job_id: string;
  status: string;
  seed_dataset: string;
  seed_version: string;
  recipe: string;
  max_records: number;
}

/** A stored job: the job plus the tenant that submitted it. */
export interface JobRow extends Job {
  tenant: string;
}

export const store = {
  /** The job this tenant submitted under idemKey, if any. */
  async get(tenant: string, idemKey: string): Promise<JobRow | null> {
    const jobId = await redis.get(\`synth:idem:\${tenant}:\${idemKey}\`);
    return jobId === null ? null : store.byId(jobId);
  },

  /** Store the job under its id and under (tenant, idemKey); the row carries the tenant. */
  async put(tenant: string, idemKey: string, job: Job): Promise<void> {
    const row: JobRow = {...job, tenant};
    await redis.set(\`synth:job:\${job.job_id}\`, JSON.stringify(row), 'EX', JOB_TTL_S);
    await redis.set(\`synth:idem:\${tenant}:\${idemKey}\`, job.job_id, 'EX', JOB_TTL_S);
  },

  /** The job row, null when there is none. */
  async byId(jobId: string): Promise<JobRow | null> {
    const raw = await redis.get(\`synth:job:\${jobId}\`);
    return raw === null ? null : (JSON.parse(raw) as JobRow);
  },
};

/** Hand the job to the generator workers: from here on, records get generated. */
export async function enqueue(job: Job): Promise<void> {
  await redis.rpush(QUEUE_KEY, job.job_id);
}
`,
  'synth/records.ts': `/** The generated record (provided): what a worker holds between generation and admission. */
import {createHash} from 'node:crypto';

export interface SyntheticRecord {
  record_id: string;
  job_id: string;
  recipe_id: string;
  entity_id: string;
  /** The record's position in its job (0, 1, 2, ...). */
  seq: number;
  /** The seed record it was expanded from, and the generated text: content the topic and the logs must not carry. */
  seed_text: string;
  text: string;
}

/** The provenance digest: the hex SHA-256 of a seed record's text. */
export function seedDigest(seedText: string): string {
  return createHash('sha256').update(seedText).digest('hex');
}
`,
  'synth/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'synth:outbox';

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
  'synth/judge.ts': `/**
 * The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at synth/config's
 * JUDGE); the pipeline's code never calls it directly. Deterministic on purpose: the course grades
 * what the pipeline does around the judge, not the judging.
 *
 * score(text) → {score, refused}:
 *   a text starting with "refuse:" is declined (0, true)
 *   anything else scores SCORE (0.87, false)
 */
export const JUDGE_VERSION = 'judge-rm-2026.10';
export const SCORE = 0.87;

export function score(text: string): {score: number; refused: boolean} {
  if (text.startsWith('refuse:')) return {score: 0, refused: true};
  return {score: SCORE, refused: false};
}
`,
};

/** The Go twins: the same \`synth\` packages, imported as synth/config, synth/seeds, synth/jobs, synth/records, synth/outbox, synth/judge. */
export const supportModulesGo: Record<string, string> = {
  'synth/config/config.go': `// Package config holds the addresses, topics, windows and keys every step of synthd agrees on.
package config

import "strconv"

const (
	// Judge is the judge model's gRPC address: a stand-in served by the checks (synth/judge).
	Judge = "judge:9000"
	// Topic carries one event per admitted record, keyed by recipe id, for the curation consumers.
	Topic = "synthetic.record"
	// WindowSeconds and EntityLimit: at most EntityLimit records per seed entity per window.
	WindowSeconds = 60
	EntityLimit   = 5
	// TTLSeconds: every key a job owns expires this long after its last move.
	TTLSeconds = 86_400
)

// The job's keys in Redis. progress: a hash of generated, admitted, parked, rejected, throttled and
// updated_at (unix seconds). window: a counter per entity per window, window = time.Now().Unix() / WindowSeconds.
// coverage: a hash of entity id -> admitted records. records: a hash of record id -> seed digest.

func ProgressKey(jobID string) string { return "synth:progress:" + jobID }
func WindowKey(jobID, entityID string, window int64) string {
	return "synth:window:" + jobID + ":" + entityID + ":" + strconv.FormatInt(window, 10)
}
func CoverageKey(jobID string) string { return "synth:coverage:" + jobID }
func RecordsKey(jobID string) string  { return "synth:records:" + jobID }
`,
  'synth/seeds/seeds.go': `// Package seeds is the seed registry (provided): every seed dataset a job may expand, by (dataset,
// version), with its license.
package seeds

// Seed is one registered seed dataset version.
type Seed struct {
	Dataset      string
	Version      string
	License      string
	DerivativeOK bool
}

var registry = map[string]Seed{
	"wiki-qa@2026-04-01":    {Dataset: "wiki-qa", Version: "2026-04-01", License: "CC-BY-SA-4.0", DerivativeOK: true},
	"news-crawl@2026-02-15": {Dataset: "news-crawl", Version: "2026-02-15", License: "publisher-no-derivatives", DerivativeOK: false},
}

// Lookup is the registered seed; ok is false when (dataset, version) is not registered.
func Lookup(dataset, version string) (Seed, bool) {
	seed, ok := registry[dataset+"@"+version]
	return seed, ok
}
`,
  'synth/jobs/jobs.go': `// Package jobs is the job store and the generation queue (provided): jobs in Redis, keyed by id and
// by (tenant, Idempotency-Key).
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"synth/config"
)

const (
	JobTTL   = 7 * config.TTLSeconds * time.Second
	QueueKey = "synth:queue"
)

// Job is a generation job as the API answers it.
type Job struct {
	JobID       string \`json:"job_id"\`
	Status      string \`json:"status"\`
	SeedDataset string \`json:"seed_dataset"\`
	SeedVersion string \`json:"seed_version"\`
	Recipe      string \`json:"recipe"\`
	MaxRecords  int    \`json:"max_records"\`
	// Tenant is set on the stored row: the tenant that submitted the job.
	Tenant string \`json:"tenant,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the job tenant submitted under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Job, error) {
	jobID, err := rdb.Get(ctx, "synth:idem:"+tenant+":"+idemKey).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ByID(ctx, jobID)
}

// Put stores the job under its id and under (tenant, idemKey); the row carries the tenant.
func Put(ctx context.Context, tenant, idemKey string, job Job) error {
	job.Tenant = tenant
	doc, err := json.Marshal(job)
	if err != nil {
		return err
	}
	if err := rdb.Set(ctx, "synth:job:"+job.JobID, doc, JobTTL).Err(); err != nil {
		return err
	}
	return rdb.Set(ctx, "synth:idem:"+tenant+":"+idemKey, job.JobID, JobTTL).Err()
}

// ByID is the job row; nil when there is none.
func ByID(ctx context.Context, jobID string) (*Job, error) {
	raw, err := rdb.Get(ctx, "synth:job:"+jobID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, err
	}
	return &job, nil
}

// Enqueue hands the job to the generator workers: from here on, records get generated.
func Enqueue(ctx context.Context, job Job) error {
	return rdb.RPush(ctx, QueueKey, job.JobID).Err()
}
`,
  'synth/records/records.go': `// Package records holds the generated record (provided): what a worker holds between generation and
// admission.
package records

import (
	"crypto/sha256"
	"encoding/hex"
)

// SyntheticRecord is one generated record. Seq is its position in the job (0, 1, 2, ...). SeedText
// (the seed record it was expanded from) and Text (the generated text) are content: the worker has
// them, the topic and the logs must not.
type SyntheticRecord struct {
	RecordID string
	JobID    string
	RecipeID string
	EntityID string
	Seq      int
	SeedText string
	Text     string
}

// SeedDigest is the provenance digest: the hex SHA-256 of a seed record's text.
func SeedDigest(seedText string) string {
	sum := sha256.Sum256([]byte(seedText))
	return hex.EncodeToString(sum[:])
}
`,
  'synth/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "synth:outbox"

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
  'synth/judge/judge.go': `// Package judge is the stand-in for the judge model. The checks serve it over gRPC (Judge.Score at
// config.Judge); the pipeline's code never calls it directly. Deterministic on purpose: the course
// grades what the pipeline does around the judge, not the judging.
//
// Score(text) → (score, refused):
//
//	a text starting with "refuse:" is declined (0, true)
//	anything else scores Fixed (0.87, false)
package judge

import "strings"

const (
	Version = "judge-rm-2026.10"
	Fixed   = 0.87
)

func Score(text string) (score float64, refused bool) {
	if strings.HasPrefix(text, "refuse:") {
		return 0, true
	}
	return Fixed, false
}
`,
};

/** The C++ twins as headers (synth/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'synth/config.h': `// Addresses, topics, windows and keys every step of synthd agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The judge model's gRPC address: a stand-in served by the checks (synth/judge.h).
inline constexpr const char* kJudge = "judge:9000";
// One event per admitted record, keyed by recipe id, for the curation consumers.
inline constexpr const char* kTopic = "synthetic.record";
// The diversity window: at most kEntityLimit records per seed entity per kWindowSeconds.
inline constexpr long long kWindowSeconds = 60;
inline constexpr long long kEntityLimit = 5;
// Every key a job owns expires this long after its last move.
inline constexpr long long kTtlSeconds = 86400;

// The job's keys in Redis. progress: a hash of generated, admitted, parked, rejected, throttled and
// updated_at (unix seconds). window: a counter per entity per window, window = unix seconds / kWindowSeconds.
// coverage: a hash of entity id -> admitted records. records: a hash of record id -> seed digest.
inline std::string progress_key(const std::string& job_id) { return "synth:progress:" + job_id; }
inline std::string window_key(const std::string& job_id, const std::string& entity_id, long long window) {
  return "synth:window:" + job_id + ":" + entity_id + ":" + std::to_string(window);
}
inline std::string coverage_key(const std::string& job_id) { return "synth:coverage:" + job_id; }
inline std::string records_key(const std::string& job_id) { return "synth:records:" + job_id; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'synth/seeds.h': `// The seed registry (provided): every seed dataset a job may expand, by (dataset, version), with its license.
#pragma once

#include <map>
#include <optional>
#include <string>

namespace seeds {

struct Seed {
  std::string dataset;
  std::string version;
  std::string license;
  bool derivative_ok = false;
};

// The registered seed; nullopt when (dataset, version) is not registered.
inline std::optional<Seed> lookup(const std::string& dataset, const std::string& version) {
  static const std::map<std::string, Seed> registry = {
      {"wiki-qa@2026-04-01", {"wiki-qa", "2026-04-01", "CC-BY-SA-4.0", true}},
      {"news-crawl@2026-02-15", {"news-crawl", "2026-02-15", "publisher-no-derivatives", false}},
  };
  const auto it = registry.find(dataset + "@" + version);
  if (it == registry.end()) return std::nullopt;
  return it->second;
}

}  // namespace seeds
`,
  'synth/jobs.h': `// The job store and the generation queue (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key).
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "synth/config.h"

namespace jobs {

inline constexpr long long kJobTtlSeconds = 7 * config::kTtlSeconds;
inline constexpr const char* kQueueKey = "synth:queue";

// The job row (the job plus its tenant), nullopt when there is none.
inline std::optional<nlohmann::json> by_id(const std::string& job_id) {
  const auto raw = config::redis().get("synth:job:" + job_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The job tenant submitted under idem_key, if any.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto job_id = config::redis().get("synth:idem:" + tenant + ":" + idem_key);
  if (!job_id) return std::nullopt;
  return by_id(*job_id);
}

// Store the job under its id and under (tenant, idem_key); the row carries the tenant.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& job) {
  nlohmann::json row = job;
  row["tenant"] = tenant;
  const std::string job_id = job.at("job_id").get<std::string>();
  config::redis().set("synth:job:" + job_id, row.dump(), std::chrono::seconds(kJobTtlSeconds));
  config::redis().set("synth:idem:" + tenant + ":" + idem_key, job_id, std::chrono::seconds(kJobTtlSeconds));
}

// Hand the job to the generator workers: from here on, records get generated.
inline void enqueue(const nlohmann::json& job) { config::redis().rpush(kQueueKey, job.at("job_id").get<std::string>()); }

}  // namespace jobs
`,
  'synth/records.h': `// The generated record (provided): what a worker holds between generation and admission.
#pragma once

#include <string>

#include "digest.h"

namespace records {

// One generated record. seq is its position in the job (0, 1, 2, ...). seed_text (the seed record it
// was expanded from) and text (the generated text) are content: the worker has them, the topic and the
// logs must not.
struct SyntheticRecord {
  std::string record_id;
  std::string job_id;
  std::string recipe_id;
  std::string entity_id;
  int seq = 0;
  std::string seed_text;
  std::string text;
};

// The provenance digest: the hex SHA-256 of a seed record's text.
inline std::string seed_digest(const std::string& seed_text) { return sha256_hex(seed_text); }

}  // namespace records
`,
  'synth/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "synth/config.h"

namespace outbox {

inline constexpr const char* kKey = "synth:outbox";

// Durably keep an event the broker refused (its JSON).
inline void insert_outbox(const std::string& event_json) { config::redis().rpush(kKey, event_json); }

// The kept events, decoded, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<nlohmann::json> out;
  std::vector<std::string> raw;
  config::redis().lrange(kKey, 0, -1, std::back_inserter(raw));
  for (const auto& row : raw) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'synth/judge.h': `// The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at config::kJudge);
// the pipeline's code never calls it directly. Deterministic on purpose: the course grades what the
// pipeline does around the judge, not the judging.
//
// grade(text) -> {score, refused}:
//   a text starting with "refuse:" is declined (0, true)
//   anything else scores kFixed (0.87, false)
#pragma once

#include <string>

namespace judge {

inline constexpr const char* kVersion = "judge-rm-2026.10";
inline constexpr double kFixed = 0.87;

struct Grade {
  double score = 0;
  bool refused = false;
};

inline Grade grade(const std::string& text) {
  if (text.rfind("refuse:", 0) == 0) return {0, true};
  return {kFixed, false};
}

}  // namespace judge
`,
};

/** The Scala twins: the same \`synth\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('synth', 'Config')]: `package synth

/** Addresses, topics, windows and keys every step of synthd agrees on. */
object Config {
  /** The judge model's gRPC address: a stand-in served by the checks. */
  val Judge = "judge:9000"
  /** One event per admitted record, keyed by recipe id, for the curation consumers. */
  val Topic = "synthetic.record"
  /** The diversity window: at most EntityLimit records per seed entity per WindowSeconds. */
  val WindowSeconds = 60L
  val EntityLimit = 5L
  /** Every key a job owns expires this long after its last move. */
  val TtlSeconds = 86400L

  // The job's keys in Redis. progress: a hash of generated, admitted, parked, rejected, throttled and
  // updated_at (unix seconds). window: a counter per entity per window, window = epoch seconds / WindowSeconds.
  // coverage: a hash of entity id -> admitted records. records: a hash of record id -> seed digest.
  def progressKey(jobId: String): String = s"synth:progress:$jobId"
  def windowKey(jobId: String, entityId: String, window: Long): String = s"synth:window:$jobId:$entityId:$window"
  def coverageKey(jobId: String): String = s"synth:coverage:$jobId"
  def recordsKey(jobId: String): String = s"synth:records:$jobId"
}
`,
  [scalaPath('synth', 'Seeds')]: `package synth

/** One registered seed dataset version. */
final case class Seed(dataset: String, version: String, license: String, derivativeOk: Boolean)

/** The seed registry (provided): every seed dataset a job may expand, by (dataset, version), with its license. */
object Seeds {
  private val registry = Map(
    ("wiki-qa", "2026-04-01") -> Seed("wiki-qa", "2026-04-01", "CC-BY-SA-4.0", derivativeOk = true),
    ("news-crawl", "2026-02-15") -> Seed("news-crawl", "2026-02-15", "publisher-no-derivatives", derivativeOk = false)
  )

  /** The registered seed, None when (dataset, version) is not registered. */
  def lookup(dataset: String, version: String): Option[Seed] = registry.get((dataset, version))
}
`,
  [scalaPath('synth', 'Jobs')]: `package synth

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** A generation job as the API answers it. */
final case class Job(
    job_id: String,
    status: String,
    seed_dataset: String,
    seed_version: String,
    recipe: String,
    max_records: Int
)

/** A stored job: the job plus the tenant that submitted it. */
final case class JobRow(job: Job, tenant: String)

/** The job store and the generation queue (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key). */
object Jobs {
  val JobTtlSeconds: Long = 7 * Config.TtlSeconds
  val QueueKey = "synth:queue"
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(row: JobRow): String = ujson.write(
    ujson.Obj(
      "job_id" -> row.job.job_id,
      "status" -> row.job.status,
      "seed_dataset" -> row.job.seed_dataset,
      "seed_version" -> row.job.seed_version,
      "recipe" -> row.job.recipe,
      "max_records" -> row.job.max_records,
      "tenant" -> row.tenant
    )
  )

  private def decode(raw: String): JobRow = {
    val j = ujson.read(raw)
    JobRow(
      Job(
        j("job_id").str,
        j("status").str,
        j("seed_dataset").str,
        j("seed_version").str,
        j("recipe").str,
        j("max_records").num.toInt
      ),
      j("tenant").str
    )
  }

  /** The job this tenant submitted under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[JobRow] =
    Option(jedis.get(s"synth:idem:$tenant:$idemKey")).flatMap(byId)

  /** Store the job under its id and under (tenant, idemKey); the row carries the tenant. */
  def put(tenant: String, idemKey: String, job: Job): Unit = {
    jedis.set(s"synth:job:\${job.job_id}", encode(JobRow(job, tenant)), SetParams.setParams().ex(JobTtlSeconds))
    jedis.set(s"synth:idem:$tenant:$idemKey", job.job_id, SetParams.setParams().ex(JobTtlSeconds))
  }

  /** The job row, None when there is none. */
  def byId(jobId: String): Option[JobRow] = Option(jedis.get(s"synth:job:$jobId")).map(decode)

  /** Hand the job to the generator workers: from here on, records get generated. */
  def enqueue(job: Job): Unit = {
    jedis.rpush(QueueKey, job.job_id)
    ()
  }
}
`,
  [scalaPath('synth', 'Records')]: `package synth

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * The generated record (provided): what a worker holds between generation and admission. seq is its
 * position in the job (0, 1, 2, ...). seed_text (the seed record it was expanded from) and text (the
 * generated text) are content: the worker has them, the topic and the logs must not.
 */
final case class SyntheticRecord(
    record_id: String,
    job_id: String,
    recipe_id: String,
    entity_id: String,
    seq: Int,
    seed_text: String,
    text: String
)

object Records {

  /** The provenance digest: the hex SHA-256 of a seed record's text. */
  def seedDigest(seedText: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(seedText.getBytes(StandardCharsets.UTF_8))
      .map(b => f"\${b & 0xff}%02x")
      .mkString
}
`,
  [scalaPath('synth', 'Outbox')]: `package synth

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "synth:outbox"
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
  [scalaPath('synth', 'JudgeStandIn')]: `package synth

/**
 * The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at Config.Judge); the
 * pipeline's code never calls it directly. A text starting with "refuse:" is declined; anything else
 * scores Fixed (0.87).
 */
object JudgeStandIn {
  val Version = "judge-rm-2026.10"
  val Fixed = 0.87

  def score(text: String): (Double, Boolean) = if (text.startsWith("refuse:")) (0.0, true) else (Fixed, false)
}
`,
};
