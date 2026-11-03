/**
 * Hand-written support modules the distillation steps import but no step builds: the `distill`
 * package. `config` is the contract every step agrees on (the teacher's address, the topic, the key
 * layout, what a teacher call costs); `jobs` is the job store (Redis); `dedupe` the per-dataset index
 * of published hashes; `outbox` the rows kept for the relay when the broker refuses a produce; and
 * `teacher` the deterministic stand-in the checks serve over gRPC in place of the teacher model.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'distill/__init__.py': '',
  'distill/config.py': `"""Addresses, topics, keys and limits every step of distilld agrees on."""
# The teacher model's gRPC address: a stand-in served by the checks (distill.teacher).
TEACHER = "teacher:9000"
# Accepted samples, keyed by dataset id, for the trainer.
TOPIC = "distill.sample"
# What one teacher call draws from a job's token budget.
TOKENS_PER_CALL = 512
# Every key a job owns expires this long after its last move.
TTL_S = 86_400

# The job's keys in Redis. budget: a string, the tokens left. seen: the set of prompt hashes sampled
# so far. progress: a hash of sampled, accepted, rejected, duplicate and updated_at (unix seconds).
# reasons: a hash of why samples were rejected, by name (refusal, empty, deadline, unavailable, budget).


def budget_key(job_id: str) -> str:
    return f"distill:budget:{job_id}"


def seen_key(job_id: str) -> str:
    return f"distill:seen:{job_id}"


def progress_key(job_id: str) -> str:
    return f"distill:progress:{job_id}"


def reasons_key(job_id: str) -> str:
    return f"distill:reasons:{job_id}"
`,
  'distill/jobs.py': `"""The job store (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key)."""
import json

import redis

from distill.config import TTL_S

JOB_TTL_S = 7 * TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class JobStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The job this tenant started under idem_key, if any."""
        job_id = r.get(f"distill:idem:{tenant}:{idem_key}")
        return self.by_id(job_id) if job_id else None

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the job under its id and under (tenant, idem_key); the row carries the tenant."""
        row = dict(job, tenant=tenant)
        r.set(f"distill:job:{job['job_id']}", json.dumps(row), ex=JOB_TTL_S)
        r.set(f"distill:idem:{tenant}:{idem_key}", job["job_id"], ex=JOB_TTL_S)

    def by_id(self, job_id: str) -> dict | None:
        """The job row (the job plus its tenant), None when there is none."""
        raw = r.get(f"distill:job:{job_id}")
        return json.loads(raw) if raw else None


store = JobStore()
`,
  'distill/dedupe.py': `"""The per-dataset index of published hashes (provided): what the trainer has already been sent."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class DedupeIndex:
    def is_duplicate(self, dataset_id: str, dedupe_hash: str) -> bool:
        """True when this dataset already published a sample with this hash."""
        return bool(r.sismember(f"distill:published:{dataset_id}", dedupe_hash))

    def mark(self, dataset_id: str, dedupe_hash: str) -> None:
        """Remember that the dataset published this hash."""
        r.sadd(f"distill:published:{dataset_id}", dedupe_hash)


dedupe = DedupeIndex()
`,
  'distill/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "distill:outbox"


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'distill/samples.py': `"""The sample record (provided): what the worker hands to publish once a sample is accepted."""
from dataclasses import dataclass


@dataclass
class SampleRecord:
    sample_id: str
    job_id: str
    dataset_id: str
    teacher_version: str
    dedupe_hash: str
    tokens: int
    # The prompt is tenant content: the worker has it, the topic and the logs must not.
    prompt: str
`,
  'distill/teacher.py': `"""
The stand-in for the teacher model. The checks serve it over gRPC (Teacher.Generate at
distill.config.TEACHER); the pipeline's code never calls it directly. Deterministic on purpose: the
course grades what the pipeline does around the teacher, never the prose.

complete(prompt) -> (text, refused):
  a prompt starting with "refuse:" is declined (text "", refused True)
  a prompt starting with "empty:" comes back with an empty completion (text "", refused False)
  anything else is answered with one line that quotes the prompt
"""
TEACHER_VERSION = "teach-70b-v3.2"


def complete(prompt: str) -> tuple[str, bool]:
    if prompt.startswith("refuse:"):
        return "", True
    if prompt.startswith("empty:"):
        return "", False
    return f"Teacher answer: {prompt.strip()}", False
`,
};

export const supportModulesTs: Record<string, string> = {
  'distill/config.ts': `/** Addresses, topics, keys and limits every step of distilld agrees on. */
/** The teacher model's gRPC address: a stand-in served by the checks (distill/teacher). */
export const TEACHER = 'teacher:9000';
/** Accepted samples, keyed by dataset id, for the trainer. */
export const TOPIC = 'distill.sample';
/** What one teacher call draws from a job's token budget. */
export const TOKENS_PER_CALL = 512;
/** Every key a job owns expires this long after its last move. */
export const TTL_S = 86_400;

// The job's keys in Redis. budget: a string, the tokens left. seen: the set of prompt hashes sampled
// so far. progress: a hash of sampled, accepted, rejected, duplicate and updated_at (unix seconds).
// reasons: a hash of why samples were rejected, by name (refusal, empty, deadline, unavailable, budget).
export const budgetKey = (jobId: string): string => \`distill:budget:\${jobId}\`;
export const seenKey = (jobId: string): string => \`distill:seen:\${jobId}\`;
export const progressKey = (jobId: string): string => \`distill:progress:\${jobId}\`;
export const reasonsKey = (jobId: string): string => \`distill:reasons:\${jobId}\`;
`,
  'distill/jobs.ts': `/** The job store (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key). */
import Redis from 'ioredis';

import {TTL_S} from 'distill/config';

export const JOB_TTL_S = 7 * TTL_S;

const redis = new Redis({host: 'redis', port: 6379});

export interface Job {
  job_id: string;
  status: string;
  teacher: string;
  dataset_id: string;
  sample_cap: number;
  sampled: number;
  accepted: number;
  rejected: number;
}

/** A stored job: the job plus the tenant that started it. */
export interface JobRow extends Job {
  tenant: string;
}

export const store = {
  /** The job this tenant started under idemKey, if any. */
  async get(tenant: string, idemKey: string): Promise<JobRow | null> {
    const jobId = await redis.get(\`distill:idem:\${tenant}:\${idemKey}\`);
    return jobId === null ? null : store.byId(jobId);
  },

  /** Store the job under its id and under (tenant, idemKey); the row carries the tenant. */
  async put(tenant: string, idemKey: string, job: Job): Promise<void> {
    const row: JobRow = {...job, tenant};
    await redis.set(\`distill:job:\${job.job_id}\`, JSON.stringify(row), 'EX', JOB_TTL_S);
    await redis.set(\`distill:idem:\${tenant}:\${idemKey}\`, job.job_id, 'EX', JOB_TTL_S);
  },

  /** The job row, null when there is none. */
  async byId(jobId: string): Promise<JobRow | null> {
    const raw = await redis.get(\`distill:job:\${jobId}\`);
    return raw === null ? null : (JSON.parse(raw) as JobRow);
  },
};
`,
  'distill/dedupe.ts': `/** The per-dataset index of published hashes (provided): what the trainer has already been sent. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const dedupe = {
  /** True when this dataset already published a sample with this hash. */
  async isDuplicate(datasetId: string, dedupeHash: string): Promise<boolean> {
    return (await redis.sismember(\`distill:published:\${datasetId}\`, dedupeHash)) === 1;
  },

  /** Remember that the dataset published this hash. */
  async mark(datasetId: string, dedupeHash: string): Promise<void> {
    await redis.sadd(\`distill:published:\${datasetId}\`, dedupeHash);
  },
};
`,
  'distill/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'distill:outbox';

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
  'distill/samples.ts': `/** The sample record (provided): what the worker hands to publish once a sample is accepted. */
export interface SampleRecord {
  sample_id: string;
  job_id: string;
  dataset_id: string;
  teacher_version: string;
  dedupe_hash: string;
  tokens: number;
  /** The prompt is tenant content: the worker has it, the topic and the logs must not. */
  prompt: string;
}
`,
  'distill/teacher.ts': `/**
 * The stand-in for the teacher model. The checks serve it over gRPC (Teacher.Generate at
 * distill/config's TEACHER); the pipeline's code never calls it directly. Deterministic on purpose:
 * the course grades what the pipeline does around the teacher, never the prose.
 *
 * complete(prompt) → {text, refused}:
 *   a prompt starting with "refuse:" is declined (text '', refused true)
 *   a prompt starting with "empty:" comes back with an empty completion (text '', refused false)
 *   anything else is answered with one line that quotes the prompt
 */
export const TEACHER_VERSION = 'teach-70b-v3.2';

export function complete(prompt: string): {text: string; refused: boolean} {
  if (prompt.startsWith('refuse:')) return {text: '', refused: true};
  if (prompt.startsWith('empty:')) return {text: '', refused: false};
  return {text: \`Teacher answer: \${prompt.trim()}\`, refused: false};
}
`,
};

/** The Go twins: the same \`distill\` packages, imported as distill/config, distill/jobs, distill/dedupe, distill/outbox, distill/teacher. */
export const supportModulesGo: Record<string, string> = {
  'distill/config/config.go': `// Package config holds the addresses, topics, keys and limits every step of distilld agrees on.
package config

const (
	// Teacher is the teacher model's gRPC address: a stand-in served by the checks (distill/teacher).
	Teacher = "teacher:9000"
	// Topic carries accepted samples, keyed by dataset id, for the trainer.
	Topic = "distill.sample"
	// TokensPerCall is what one teacher call draws from a job's token budget.
	TokensPerCall = 512
	// TTLSeconds: every key a job owns expires this long after its last move.
	TTLSeconds = 86_400
)

// The job's keys in Redis. budget: a string, the tokens left. seen: the set of prompt hashes sampled
// so far. progress: a hash of sampled, accepted, rejected, duplicate and updated_at (unix seconds).
// reasons: a hash of why samples were rejected, by name (refusal, empty, deadline, unavailable, budget).

func BudgetKey(jobID string) string   { return "distill:budget:" + jobID }
func SeenKey(jobID string) string     { return "distill:seen:" + jobID }
func ProgressKey(jobID string) string { return "distill:progress:" + jobID }
func ReasonsKey(jobID string) string  { return "distill:reasons:" + jobID }
`,
  'distill/jobs/jobs.go': `// Package jobs is the job store (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key).
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"distill/config"
)

const JobTTL = 7 * config.TTLSeconds * time.Second

// Job is a distillation job as the API answers it.
type Job struct {
	JobID     string \`json:"job_id"\`
	Status    string \`json:"status"\`
	Teacher   string \`json:"teacher"\`
	DatasetID string \`json:"dataset_id"\`
	SampleCap int    \`json:"sample_cap"\`
	Sampled   int    \`json:"sampled"\`
	Accepted  int    \`json:"accepted"\`
	Rejected  int    \`json:"rejected"\`
	// Tenant is set on the stored row: the tenant that started the job.
	Tenant string \`json:"tenant,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the job tenant started under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Job, error) {
	jobID, err := rdb.Get(ctx, "distill:idem:"+tenant+":"+idemKey).Result()
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
	if err := rdb.Set(ctx, "distill:job:"+job.JobID, doc, JobTTL).Err(); err != nil {
		return err
	}
	return rdb.Set(ctx, "distill:idem:"+tenant+":"+idemKey, job.JobID, JobTTL).Err()
}

// ByID is the job row; nil when there is none.
func ByID(ctx context.Context, jobID string) (*Job, error) {
	raw, err := rdb.Get(ctx, "distill:job:"+jobID).Bytes()
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
`,
  'distill/dedupe/dedupe.go': `// Package dedupe is the per-dataset index of published hashes (provided): what the trainer has
// already been sent.
package dedupe

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// IsDuplicate reports whether the dataset already published a sample with this hash.
func IsDuplicate(ctx context.Context, datasetID, dedupeHash string) (bool, error) {
	return rdb.SIsMember(ctx, "distill:published:"+datasetID, dedupeHash).Result()
}

// Mark remembers that the dataset published this hash.
func Mark(ctx context.Context, datasetID, dedupeHash string) error {
	return rdb.SAdd(ctx, "distill:published:"+datasetID, dedupeHash).Err()
}
`,
  'distill/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "distill:outbox"

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
  'distill/samples/samples.go': `// Package samples holds the sample record (provided): what the worker hands to publish once a
// sample is accepted.
package samples

// SampleRecord is one accepted sample. Prompt is tenant content: the worker has it, the topic and
// the logs must not.
type SampleRecord struct {
	SampleID       string
	JobID          string
	DatasetID      string
	TeacherVersion string
	DedupeHash     string
	Tokens         int
	Prompt         string
}
`,
  'distill/teacher/teacher.go': `// Package teacher is the stand-in for the teacher model. The checks serve it over gRPC
// (Teacher.Generate at config.Teacher); the pipeline's code never calls it directly. Deterministic
// on purpose: the course grades what the pipeline does around the teacher, never the prose.
//
// Complete(prompt) → (text, refused):
//
//	a prompt starting with "refuse:" is declined ("", true)
//	a prompt starting with "empty:" comes back with an empty completion ("", false)
//	anything else is answered with one line that quotes the prompt
package teacher

import "strings"

const Version = "teach-70b-v3.2"

func Complete(prompt string) (text string, refused bool) {
	if strings.HasPrefix(prompt, "refuse:") {
		return "", true
	}
	if strings.HasPrefix(prompt, "empty:") {
		return "", false
	}
	return "Teacher answer: " + strings.TrimSpace(prompt), false
}
`,
};

/** The C++ twins as headers (distill/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'distill/config.h': `// Addresses, topics, keys and limits every step of distilld agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The teacher model's gRPC address: a stand-in served by the checks (distill/teacher.h).
inline constexpr const char* kTeacher = "teacher:9000";
// Accepted samples, keyed by dataset id, for the trainer.
inline constexpr const char* kTopic = "distill.sample";
// What one teacher call draws from a job's token budget.
inline constexpr long long kTokensPerCall = 512;
// Every key a job owns expires this long after its last move.
inline constexpr long long kTtlSeconds = 86400;

// The job's keys in Redis. budget: a string, the tokens left. seen: the set of prompt hashes sampled
// so far. progress: a hash of sampled, accepted, rejected, duplicate and updated_at (unix seconds).
// reasons: a hash of why samples were rejected, by name (refusal, empty, deadline, unavailable, budget).
inline std::string budget_key(const std::string& job_id) { return "distill:budget:" + job_id; }
inline std::string seen_key(const std::string& job_id) { return "distill:seen:" + job_id; }
inline std::string progress_key(const std::string& job_id) { return "distill:progress:" + job_id; }
inline std::string reasons_key(const std::string& job_id) { return "distill:reasons:" + job_id; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'distill/jobs.h': `// The job store (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key).
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "distill/config.h"

namespace jobs {

inline constexpr long long kJobTtlSeconds = 7 * config::kTtlSeconds;

// The job tenant started under idem_key, if any (the row: the job plus its tenant).
inline std::optional<nlohmann::json> by_id(const std::string& job_id) {
  const auto raw = config::redis().get("distill:job:" + job_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto job_id = config::redis().get("distill:idem:" + tenant + ":" + idem_key);
  if (!job_id) return std::nullopt;
  return by_id(*job_id);
}

// Store the job under its id and under (tenant, idem_key); the row carries the tenant.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& job) {
  nlohmann::json row = job;
  row["tenant"] = tenant;
  const std::string job_id = job.at("job_id").get<std::string>();
  config::redis().set("distill:job:" + job_id, row.dump(), kJobTtlSeconds);
  config::redis().set("distill:idem:" + tenant + ":" + idem_key, job_id, kJobTtlSeconds);
}

}  // namespace jobs
`,
  'distill/dedupe.h': `// The per-dataset index of published hashes (provided): what the trainer has already been sent.
#pragma once

#include <string>

#include "distill/config.h"

namespace dedupe {

// True when this dataset already published a sample with this hash.
inline bool is_duplicate(const std::string& dataset_id, const std::string& dedupe_hash) {
  return config::redis().sismember("distill:published:" + dataset_id, dedupe_hash);
}

// Remember that the dataset published this hash.
inline void mark(const std::string& dataset_id, const std::string& dedupe_hash) {
  config::redis().sadd("distill:published:" + dataset_id, dedupe_hash);
}

}  // namespace dedupe
`,
  'distill/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "distill/config.h"

namespace outbox {

inline constexpr const char* kKey = "distill:outbox";

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
  'distill/samples.h': `// The sample record (provided): what the worker hands to publish once a sample is accepted.
#pragma once

#include <string>

namespace samples {

// One accepted sample. prompt is tenant content: the worker has it, the topic and the logs must not.
struct SampleRecord {
  std::string sample_id;
  std::string job_id;
  std::string dataset_id;
  std::string teacher_version;
  std::string dedupe_hash;
  int tokens = 0;
  std::string prompt;
};

}  // namespace samples
`,
  'distill/teacher.h': `// The stand-in for the teacher model. The checks serve it over gRPC (Teacher.Generate at
// config::kTeacher); the pipeline's code never calls it directly. Deterministic on purpose: the
// course grades what the pipeline does around the teacher, never the prose.
//
// complete(prompt) -> {text, refused}:
//   a prompt starting with "refuse:" is declined ("", true)
//   a prompt starting with "empty:" comes back with an empty completion ("", false)
//   anything else is answered with one line that quotes the prompt
#pragma once

#include <string>

namespace teacher {

inline constexpr const char* kVersion = "teach-70b-v3.2";

struct Completion {
  std::string text;
  bool refused = false;
};

inline std::string trim(const std::string& s) {
  const size_t start = s.find_first_not_of(" \\t\\r\\n");
  if (start == std::string::npos) return "";
  return s.substr(start, s.find_last_not_of(" \\t\\r\\n") - start + 1);
}

inline Completion complete(const std::string& prompt) {
  if (prompt.rfind("refuse:", 0) == 0) return {"", true};
  if (prompt.rfind("empty:", 0) == 0) return {"", false};
  return {"Teacher answer: " + trim(prompt), false};
}

}  // namespace teacher
`,
};

/** The Scala twins: the same \`distill\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('distill', 'Config')]: `package distill

/** Addresses, topics, keys and limits every step of distilld agrees on. */
object Config {
  /** The teacher model's gRPC address: a stand-in served by the checks. */
  val Teacher = "teacher:9000"
  /** Accepted samples, keyed by dataset id, for the trainer. */
  val Topic = "distill.sample"
  /** What one teacher call draws from a job's token budget. */
  val TokensPerCall = 512L
  /** Every key a job owns expires this long after its last move. */
  val TtlSeconds = 86400L

  // The job's keys in Redis. budget: a string, the tokens left. seen: the set of prompt hashes sampled
  // so far. progress: a hash of sampled, accepted, rejected, duplicate and updated_at (unix seconds).
  // reasons: a hash of why samples were rejected, by name (refusal, empty, deadline, unavailable, budget).
  def budgetKey(jobId: String): String = s"distill:budget:$jobId"
  def seenKey(jobId: String): String = s"distill:seen:$jobId"
  def progressKey(jobId: String): String = s"distill:progress:$jobId"
  def reasonsKey(jobId: String): String = s"distill:reasons:$jobId"
}
`,
  [scalaPath('distill', 'Jobs')]: `package distill

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** A distillation job as the API answers it. */
final case class Job(
    job_id: String,
    status: String,
    teacher: String,
    dataset_id: String,
    sample_cap: Int,
    sampled: Int,
    accepted: Int,
    rejected: Int
)

/** A stored job: the job plus the tenant that started it. */
final case class JobRow(job: Job, tenant: String)

/** The job store (provided): jobs in Redis, keyed by id and by (tenant, Idempotency-Key). */
object Jobs {
  val JobTtlSeconds: Long = 7 * Config.TtlSeconds
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(row: JobRow): String = ujson.write(
    ujson.Obj(
      "job_id" -> row.job.job_id,
      "status" -> row.job.status,
      "teacher" -> row.job.teacher,
      "dataset_id" -> row.job.dataset_id,
      "sample_cap" -> row.job.sample_cap,
      "sampled" -> row.job.sampled,
      "accepted" -> row.job.accepted,
      "rejected" -> row.job.rejected,
      "tenant" -> row.tenant
    )
  )

  private def decode(raw: String): JobRow = {
    val j = ujson.read(raw)
    JobRow(
      Job(
        j("job_id").str,
        j("status").str,
        j("teacher").str,
        j("dataset_id").str,
        j("sample_cap").num.toInt,
        j("sampled").num.toInt,
        j("accepted").num.toInt,
        j("rejected").num.toInt
      ),
      j("tenant").str
    )
  }

  /** The job this tenant started under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[JobRow] =
    Option(jedis.get(s"distill:idem:$tenant:$idemKey")).flatMap(byId)

  /** Store the job under its id and under (tenant, idemKey); the row carries the tenant. */
  def put(tenant: String, idemKey: String, job: Job): Unit = {
    jedis.set(s"distill:job:\${job.job_id}", encode(JobRow(job, tenant)), SetParams.setParams().ex(JobTtlSeconds))
    jedis.set(s"distill:idem:$tenant:$idemKey", job.job_id, SetParams.setParams().ex(JobTtlSeconds))
  }

  /** The job row, None when there is none. */
  def byId(jobId: String): Option[JobRow] = Option(jedis.get(s"distill:job:$jobId")).map(decode)
}
`,
  [scalaPath('distill', 'Dedupe')]: `package distill

import redis.clients.jedis.JedisPooled

/** The per-dataset index of published hashes (provided): what the trainer has already been sent. */
object Dedupe {
  private val jedis = new JedisPooled("redis", 6379)

  /** True when this dataset already published a sample with this hash. */
  def isDuplicate(datasetId: String, dedupeHash: String): Boolean =
    jedis.sismember(s"distill:published:$datasetId", dedupeHash)

  /** Remember that the dataset published this hash. */
  def mark(datasetId: String, dedupeHash: String): Unit = {
    jedis.sadd(s"distill:published:$datasetId", dedupeHash)
    ()
  }
}
`,
  [scalaPath('distill', 'SampleRecord')]: `package distill

/**
 * The sample record (provided): what the worker hands to publish once a sample is accepted. The
 * prompt is tenant content: the worker has it, the topic and the logs must not.
 */
final case class SampleRecord(
    sample_id: String,
    job_id: String,
    dataset_id: String,
    teacher_version: String,
    dedupe_hash: String,
    tokens: Int,
    prompt: String
)
`,
  [scalaPath('distill', 'Outbox')]: `package distill

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "distill:outbox"
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
