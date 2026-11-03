/**
 * Hand-written support modules the eval-harness steps import but no step builds: the `evals`
 * package. `config` is the contract every step agrees on (the judge's address, the topic, the pass
 * score, the key layout); `runs` is the run store (Redis); `datasets` the registry of golden sets the
 * service owns; `metrics` the deterministic string metric used when the judge cannot answer;
 * `samples` the records a worker passes between steps; `outbox` the rows kept for the relay when the
 * broker refuses a produce; and `judge` the deterministic stand-in the checks serve over gRPC in place
 * of the judge model.
 */
import {CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'evals/__init__.py': '',
  'evals/config.py': `"""Addresses, topics, keys and limits every step of evald agrees on."""
# The judge model's gRPC address: a stand-in served by the checks (evals.judge).
JUDGE = "judge:9000"
# One event per scored sample, keyed by run id, for the results warehouse.
TOPIC = "eval.sample"
# A sample passes when its score is at least this.
PASS_SCORE = 0.5
# Every key a run owns expires this long after its last move (7 days).
TTL_S = 604_800

# The run's keys in Redis. progress: a hash of scored, passed, failed, fallback and updated_at (unix
# seconds). seen: the set of sample ids already counted.


def progress_key(run_id: str) -> str:
    return f"evals:progress:{run_id}"


def seen_key(run_id: str) -> str:
    return f"evals:seen:{run_id}"
`,
  'evals/runs.py': `"""The run store (provided): runs in Redis, keyed by id and by (tenant, Idempotency-Key)."""
import json

import redis

from evals.config import TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run this tenant started under idem_key, if any."""
        run_id = r.get(f"evals:idem:{tenant}:{idem_key}")
        return self.by_id(run_id) if run_id else None

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under its id and under (tenant, idem_key); the row carries the tenant."""
        row = dict(run, tenant=tenant)
        r.set(f"evals:run:{run['run_id']}", json.dumps(row), ex=TTL_S)
        r.set(f"evals:idem:{tenant}:{idem_key}", run["run_id"], ex=TTL_S)

    def by_id(self, run_id: str) -> dict | None:
        """The run row (the run plus its tenant), None when there is none."""
        raw = r.get(f"evals:run:{run_id}")
        return json.loads(raw) if raw else None


store = RunStore()
`,
  'evals/datasets.py': `"""The registry of golden sets this service owns (provided): dataset id to sample count."""
GOLDEN_SETS = {"gs-support-v3": 1200, "gs-billing-v2": 450}


class DatasetRegistry:
    def exists(self, dataset_id: str) -> bool:
        """Whether this service owns, and may score against, the golden set."""
        return dataset_id in GOLDEN_SETS


datasets = DatasetRegistry()
`,
  'evals/metrics.py': `"""The deterministic string metric (provided): what a sample scores when the judge cannot answer."""


def exact_match(expected: str, output: str) -> float:
    """1.0 when the output equals the label (trimmed, case-insensitive), else 0.0."""
    return 1.0 if output.strip().lower() == expected.strip().lower() else 0.0
`,
  'evals/samples.py': `"""The records a worker passes between steps (provided)."""
from dataclasses import dataclass


@dataclass
class GoldenSample:
    """One golden sample with the model's output. expected and output are tenant content."""

    run_id: str
    sample_id: str
    expected: str
    output: str


@dataclass
class ScoredSample:
    """One scored sample, as the worker hands it to publish. judge is "model" or "fallback"."""

    run_id: str
    sample_id: str
    model_version: str
    score: float
    judge: str
    # The model's output is tenant content: the worker has it, the topic and the logs must not.
    output: str
`,
  'evals/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "evals:outbox"


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'evals/judge.py': `"""
The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at evals.config.JUDGE);
the service's code never calls it directly. Deterministic on purpose: the course grades what the
service does around the judge, not the judge.

grade(expected, output) -> score:
  1.0  when the output equals the label (trimmed, case-insensitive)
  0.75 when the output contains the label
  0.0  otherwise
"""
JUDGE_VERSION = "judge-8b-v2"


def grade(expected: str, output: str) -> float:
    want, got = expected.strip().lower(), output.strip().lower()
    if got == want:
        return 1.0
    if want and want in got:
        return 0.75
    return 0.0
`,
};

export const supportModulesTs: Record<string, string> = {
  'evals/config.ts': `/** Addresses, topics, keys and limits every step of evald agrees on. */
/** The judge model's gRPC address: a stand-in served by the checks (evals/judge). */
export const JUDGE = 'judge:9000';
/** One event per scored sample, keyed by run id, for the results warehouse. */
export const TOPIC = 'eval.sample';
/** A sample passes when its score is at least this. */
export const PASS_SCORE = 0.5;
/** Every key a run owns expires this long after its last move (7 days). */
export const TTL_S = 604_800;

// The run's keys in Redis. progress: a hash of scored, passed, failed, fallback and updated_at (unix
// seconds). seen: the set of sample ids already counted.
export const progressKey = (runId: string): string => \`evals:progress:\${runId}\`;
export const seenKey = (runId: string): string => \`evals:seen:\${runId}\`;
`,
  'evals/runs.ts': `/** The run store (provided): runs in Redis, keyed by id and by (tenant, Idempotency-Key). */
import Redis from 'ioredis';

import {TTL_S} from 'evals/config';

const redis = new Redis({host: 'redis', port: 6379});

export interface Run {
  run_id: string;
  status: string;
  dataset_id: string;
  model_version: string;
  sample_budget: number;
}

/** A stored run: the run plus the tenant that started it. */
export interface RunRow extends Run {
  tenant: string;
}

export const store = {
  /** The run this tenant started under idemKey, if any. */
  async get(tenant: string, idemKey: string): Promise<RunRow | null> {
    const runId = await redis.get(\`evals:idem:\${tenant}:\${idemKey}\`);
    return runId === null ? null : store.byId(runId);
  },

  /** Store the run under its id and under (tenant, idemKey); the row carries the tenant. */
  async put(tenant: string, idemKey: string, run: Run): Promise<void> {
    const row: RunRow = {...run, tenant};
    await redis.set(\`evals:run:\${run.run_id}\`, JSON.stringify(row), 'EX', TTL_S);
    await redis.set(\`evals:idem:\${tenant}:\${idemKey}\`, run.run_id, 'EX', TTL_S);
  },

  /** The run row, null when there is none. */
  async byId(runId: string): Promise<RunRow | null> {
    const raw = await redis.get(\`evals:run:\${runId}\`);
    return raw === null ? null : (JSON.parse(raw) as RunRow);
  },
};
`,
  'evals/datasets.ts': `/** The registry of golden sets this service owns (provided): dataset id to sample count. */
export const GOLDEN_SETS: Record<string, number> = {'gs-support-v3': 1200, 'gs-billing-v2': 450};

export const datasets = {
  /** Whether this service owns, and may score against, the golden set. */
  exists(datasetId: string): boolean {
    return Object.hasOwn(GOLDEN_SETS, datasetId);
  },
};
`,
  'evals/metrics.ts': `/** The deterministic string metric (provided): what a sample scores when the judge cannot answer. */

/** 1 when the output equals the label (trimmed, case-insensitive), else 0. */
export function exactMatch(expected: string, output: string): number {
  return output.trim().toLowerCase() === expected.trim().toLowerCase() ? 1 : 0;
}
`,
  'evals/samples.ts': `/** The records a worker passes between steps (provided). */

/** One golden sample with the model's output. expected and output are tenant content. */
export interface GoldenSample {
  run_id: string;
  sample_id: string;
  expected: string;
  output: string;
}

/** One scored sample, as the worker hands it to publish. judge is "model" or "fallback". */
export interface ScoredSample {
  run_id: string;
  sample_id: string;
  model_version: string;
  score: number;
  judge: string;
  /** The model's output is tenant content: the worker has it, the topic and the logs must not. */
  output: string;
}
`,
  'evals/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'evals:outbox';

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
  'evals/judge.ts': `/**
 * The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at evals/config's
 * JUDGE); the service's code never calls it directly. Deterministic on purpose: the course grades what
 * the service does around the judge, not the judge.
 *
 * grade(expected, output) → score:
 *   1    when the output equals the label (trimmed, case-insensitive)
 *   0.75 when the output contains the label
 *   0    otherwise
 */
export const JUDGE_VERSION = 'judge-8b-v2';

export function grade(expected: string, output: string): number {
  const want = expected.trim().toLowerCase();
  const got = output.trim().toLowerCase();
  if (got === want) return 1;
  if (want !== '' && got.includes(want)) return 0.75;
  return 0;
}
`,
};

/** The Go twins: the same \`evals\` packages, imported as evals/config, evals/runs, evals/datasets, evals/metrics, evals/samples, evals/outbox, evals/judge. */
export const supportModulesGo: Record<string, string> = {
  'evals/config/config.go': `// Package config holds the addresses, topics, keys and limits every step of evald agrees on.
package config

const (
	// Judge is the judge model's gRPC address: a stand-in served by the checks (evals/judge).
	Judge = "judge:9000"
	// Topic carries one event per scored sample, keyed by run id, for the results warehouse.
	Topic = "eval.sample"
	// PassScore: a sample passes when its score is at least this.
	PassScore = 0.5
	// TTLSeconds: every key a run owns expires this long after its last move (7 days).
	TTLSeconds = 604_800
)

// The run's keys in Redis. progress: a hash of scored, passed, failed, fallback and updated_at (unix
// seconds). seen: the set of sample ids already counted.

func ProgressKey(runID string) string { return "evals:progress:" + runID }
func SeenKey(runID string) string     { return "evals:seen:" + runID }
`,
  'evals/runs/runs.go': `// Package runs is the run store (provided): runs in Redis, keyed by id and by (tenant, Idempotency-Key).
package runs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"evals/config"
)

// Run is an eval run as the API answers it.
type Run struct {
	RunID        string \`json:"run_id"\`
	Status       string \`json:"status"\`
	DatasetID    string \`json:"dataset_id"\`
	ModelVersion string \`json:"model_version"\`
	SampleBudget int    \`json:"sample_budget"\`
	// Tenant is set on the stored row: the tenant that started the run.
	Tenant string \`json:"tenant,omitempty"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttl = config.TTLSeconds * time.Second

// Get is the run tenant started under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Run, error) {
	runID, err := rdb.Get(ctx, "evals:idem:"+tenant+":"+idemKey).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ByID(ctx, runID)
}

// Put stores the run under its id and under (tenant, idemKey); the row carries the tenant.
func Put(ctx context.Context, tenant, idemKey string, run Run) error {
	run.Tenant = tenant
	doc, err := json.Marshal(run)
	if err != nil {
		return err
	}
	if err := rdb.Set(ctx, "evals:run:"+run.RunID, doc, ttl).Err(); err != nil {
		return err
	}
	return rdb.Set(ctx, "evals:idem:"+tenant+":"+idemKey, run.RunID, ttl).Err()
}

// ByID is the run row; nil when there is none.
func ByID(ctx context.Context, runID string) (*Run, error) {
	raw, err := rdb.Get(ctx, "evals:run:"+runID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var run Run
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, err
	}
	return &run, nil
}
`,
  'evals/datasets/datasets.go': `// Package datasets is the registry of golden sets this service owns (provided): dataset id to sample count.
package datasets

var GoldenSets = map[string]int{"gs-support-v3": 1200, "gs-billing-v2": 450}

// Exists reports whether this service owns, and may score against, the golden set.
func Exists(datasetID string) bool {
	_, ok := GoldenSets[datasetID]
	return ok
}
`,
  'evals/metrics/metrics.go': `// Package metrics is the deterministic string metric (provided): what a sample scores when the judge
// cannot answer.
package metrics

import "strings"

// ExactMatch is 1 when the output equals the label (trimmed, case-insensitive), else 0.
func ExactMatch(expected, output string) float64 {
	if strings.EqualFold(strings.TrimSpace(output), strings.TrimSpace(expected)) {
		return 1
	}
	return 0
}
`,
  'evals/samples/samples.go': `// Package samples holds the records a worker passes between steps (provided).
package samples

// GoldenSample is one golden sample with the model's output. Expected and Output are tenant content.
type GoldenSample struct {
	RunID    string
	SampleID string
	Expected string
	Output   string
}

// ScoredSample is one scored sample, as the worker hands it to publish. Judge is "model" or
// "fallback". Output is tenant content: the worker has it, the topic and the logs must not.
type ScoredSample struct {
	RunID        string
	SampleID     string
	ModelVersion string
	Score        float64
	Judge        string
	Output       string
}
`,
  'evals/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "evals:outbox"

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
  'evals/judge/judge.go': `// Package judge is the stand-in for the judge model. The checks serve it over gRPC (Judge.Score at
// config.Judge); the service's code never calls it directly. Deterministic on purpose: the course
// grades what the service does around the judge, not the judge.
//
// Grade(expected, output) → score:
//
//	1    when the output equals the label (trimmed, case-insensitive)
//	0.75 when the output contains the label
//	0    otherwise
package judge

import "strings"

const Version = "judge-8b-v2"

func Grade(expected, output string) float64 {
	want := strings.ToLower(strings.TrimSpace(expected))
	got := strings.ToLower(strings.TrimSpace(output))
	if got == want {
		return 1
	}
	if want != "" && strings.Contains(got, want) {
		return 0.75
	}
	return 0
}
`,
};

/** The C++ twins as headers (evals/*.h), plus ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'evals/config.h': `// Addresses, topics, keys and limits every step of evald agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The judge model's gRPC address: a stand-in served by the checks (evals/judge.h).
inline constexpr const char* kJudge = "judge:9000";
// One event per scored sample, keyed by run id, for the results warehouse.
inline constexpr const char* kTopic = "eval.sample";
// A sample passes when its score is at least this.
inline constexpr double kPassScore = 0.5;
// Every key a run owns expires this long after its last move (7 days).
inline constexpr long long kTtlSeconds = 604800;

// The run's keys in Redis. progress: a hash of scored, passed, failed, fallback and updated_at (unix
// seconds). seen: the set of sample ids already counted.
inline std::string progress_key(const std::string& run_id) { return "evals:progress:" + run_id; }
inline std::string seen_key(const std::string& run_id) { return "evals:seen:" + run_id; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'evals/runs.h': `// The run store (provided): runs in Redis, keyed by id and by (tenant, Idempotency-Key).
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "evals/config.h"

namespace runs {

// The run row (the run plus its tenant), if there is one.
inline std::optional<nlohmann::json> by_id(const std::string& run_id) {
  const auto raw = config::redis().get("evals:run:" + run_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The run tenant started under idem_key, if any.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto run_id = config::redis().get("evals:idem:" + tenant + ":" + idem_key);
  if (!run_id) return std::nullopt;
  return by_id(*run_id);
}

// Store the run under its id and under (tenant, idem_key); the row carries the tenant.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& run) {
  nlohmann::json row = run;
  row["tenant"] = tenant;
  const std::string run_id = run.at("run_id").get<std::string>();
  config::redis().set("evals:run:" + run_id, row.dump(), config::kTtlSeconds);
  config::redis().set("evals:idem:" + tenant + ":" + idem_key, run_id, config::kTtlSeconds);
}

}  // namespace runs
`,
  'evals/datasets.h': `// The registry of golden sets this service owns (provided): dataset id to sample count.
#pragma once

#include <map>
#include <string>

namespace datasets {

inline const std::map<std::string, int> kGoldenSets = {{"gs-support-v3", 1200}, {"gs-billing-v2", 450}};

// Whether this service owns, and may score against, the golden set.
inline bool exists(const std::string& dataset_id) { return kGoldenSets.count(dataset_id) > 0; }

}  // namespace datasets
`,
  'evals/metrics.h': `// The deterministic string metric (provided): what a sample scores when the judge cannot answer.
#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace metrics {

inline std::string normalized(const std::string& s) {
  const size_t start = s.find_first_not_of(" \\t\\r\\n");
  if (start == std::string::npos) return "";
  std::string out = s.substr(start, s.find_last_not_of(" \\t\\r\\n") - start + 1);
  std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

// 1 when the output equals the label (trimmed, case-insensitive), else 0.
inline double exact_match(const std::string& expected, const std::string& output) {
  return normalized(output) == normalized(expected) ? 1.0 : 0.0;
}

}  // namespace metrics
`,
  'evals/samples.h': `// The records a worker passes between steps (provided).
#pragma once

#include <string>

namespace samples {

// One golden sample with the model's output. expected and output are tenant content.
struct GoldenSample {
  std::string run_id;
  std::string sample_id;
  std::string expected;
  std::string output;
};

// One scored sample, as the worker hands it to publish. judge is "model" or "fallback". output is
// tenant content: the worker has it, the topic and the logs must not.
struct ScoredSample {
  std::string run_id;
  std::string sample_id;
  std::string model_version;
  double score = 0;
  std::string judge;
  std::string output;
};

}  // namespace samples
`,
  'evals/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "evals/config.h"

namespace outbox {

inline constexpr const char* kKey = "evals:outbox";

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
  'evals/judge.h': `// The stand-in for the judge model. The checks serve it over gRPC (Judge.Score at config::kJudge);
// the service's code never calls it directly. Deterministic on purpose: the course grades what the
// service does around the judge, not the judge.
//
// grade(expected, output) -> score:
//   1    when the output equals the label (trimmed, case-insensitive)
//   0.75 when the output contains the label
//   0    otherwise
#pragma once

#include <string>

#include "evals/metrics.h"

namespace judge {

inline constexpr const char* kVersion = "judge-8b-v2";

inline double grade(const std::string& expected, const std::string& output) {
  const std::string want = metrics::normalized(expected);
  const std::string got = metrics::normalized(output);
  if (got == want) return 1.0;
  if (!want.empty() && got.find(want) != std::string::npos) return 0.75;
  return 0.0;
}

}  // namespace judge
`,
};

/** The Scala twins: the same \`evals\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('evals', 'Config')]: `package evals

/** Addresses, topics, keys and limits every step of evald agrees on. */
object Config {
  /** The judge model's gRPC address: a stand-in served by the checks. */
  val Judge = "judge:9000"
  /** One event per scored sample, keyed by run id, for the results warehouse. */
  val Topic = "eval.sample"
  /** A sample passes when its score is at least this. */
  val PassScore = 0.5
  /** Every key a run owns expires this long after its last move (7 days). */
  val TtlSeconds = 604800L

  // The run's keys in Redis. progress: a hash of scored, passed, failed, fallback and updated_at (unix
  // seconds). seen: the set of sample ids already counted.
  def progressKey(runId: String): String = s"evals:progress:$runId"
  def seenKey(runId: String): String = s"evals:seen:$runId"
}
`,
  [scalaPath('evals', 'Runs')]: `package evals

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** An eval run as the API answers it. */
final case class Run(run_id: String, status: String, dataset_id: String, model_version: String, sample_budget: Int)

/** A stored run: the run plus the tenant that started it. */
final case class RunRow(run: Run, tenant: String)

/** The run store (provided): runs in Redis, keyed by id and by (tenant, Idempotency-Key). */
object Runs {
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(row: RunRow): String = ujson.write(
    ujson.Obj(
      "run_id" -> row.run.run_id,
      "status" -> row.run.status,
      "dataset_id" -> row.run.dataset_id,
      "model_version" -> row.run.model_version,
      "sample_budget" -> row.run.sample_budget,
      "tenant" -> row.tenant
    )
  )

  private def decode(raw: String): RunRow = {
    val j = ujson.read(raw)
    RunRow(
      Run(j("run_id").str, j("status").str, j("dataset_id").str, j("model_version").str, j("sample_budget").num.toInt),
      j("tenant").str
    )
  }

  /** The run this tenant started under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[RunRow] =
    Option(jedis.get(s"evals:idem:$tenant:$idemKey")).flatMap(byId)

  /** Store the run under its id and under (tenant, idemKey); the row carries the tenant. */
  def put(tenant: String, idemKey: String, run: Run): Unit = {
    jedis.set(s"evals:run:\${run.run_id}", encode(RunRow(run, tenant)), SetParams.setParams().ex(Config.TtlSeconds))
    jedis.set(s"evals:idem:$tenant:$idemKey", run.run_id, SetParams.setParams().ex(Config.TtlSeconds))
    ()
  }

  /** The run row, None when there is none. */
  def byId(runId: String): Option[RunRow] = Option(jedis.get(s"evals:run:$runId")).map(decode)
}
`,
  [scalaPath('evals', 'Datasets')]: `package evals

/** The registry of golden sets this service owns (provided): dataset id to sample count. */
object Datasets {
  val GoldenSets: Map[String, Int] = Map("gs-support-v3" -> 1200, "gs-billing-v2" -> 450)

  /** Whether this service owns, and may score against, the golden set. */
  def exists(datasetId: String): Boolean = GoldenSets.contains(datasetId)
}
`,
  [scalaPath('evals', 'Metrics')]: `package evals

/** The deterministic string metric (provided): what a sample scores when the judge cannot answer. */
object Metrics {
  /** 1 when the output equals the label (trimmed, case-insensitive), else 0. */
  def exactMatch(expected: String, output: String): Double =
    if (output.trim.equalsIgnoreCase(expected.trim)) 1.0 else 0.0
}
`,
  [scalaPath('evals', 'Samples')]: `package evals

/** One golden sample with the model's output. expected and output are tenant content. */
final case class GoldenSample(run_id: String, sample_id: String, expected: String, output: String)

/**
 * One scored sample, as the worker hands it to publish. judge is "model" or "fallback". The output is
 * tenant content: the worker has it, the topic and the logs must not.
 */
final case class ScoredSample(
    run_id: String,
    sample_id: String,
    model_version: String,
    score: Double,
    judge: String,
    output: String
)
`,
  [scalaPath('evals', 'Outbox')]: `package evals

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "evals:outbox"
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
