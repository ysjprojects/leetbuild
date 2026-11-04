/**
 * Hand-written support modules the fine-tune steps import but no step builds: the `finetune`
 * package. `config` is the contract every step agrees on (the trainer's address, the topic, the
 * Redis key layout); `registry` the read-only model and dataset registry; `recipe` the config hash;
 * `jobs` the job store (Redis hashes, with an atomic status transition); `evals` the eval service's
 * results; `outbox` the rows kept for the relay when the broker refuses a produce.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'finetune/__init__.py': '',
  'finetune/config.py': `"""Addresses, topics and the Redis key layout every step of finetuned agrees on."""
# The trainer's gRPC address: a stand-in served by the checks (finetuned.proto).
TRAINER = "trainer:9000"
# Job transitions, keyed by job id.
TOPIC = "finetune.job"
# Events the broker refused, for the relay.
OUTBOX_KEY = "ft:outbox"

# job: a hash (job_id, team, status, base_model, dataset_version, dataset_sha256, config_hash,
#   compute_budget, and hyperparameters and checkpoint_ids as JSON).
# pool: a team's GPU-hours not reserved by any job, a string.
# reservation: a job's hash (team, reserved, spent, state: queued, running, completed, cancelled).
# queue: a team's list of job ids waiting to start.
# eval: the eval service's hash for a job (passed 1/0, score).


def job_key(job_id: str) -> str:
    return f"ft:job:{job_id}"


def idem_key(team: str, key: str) -> str:
    return f"ft:idem:{team}:{key}"


def pool_key(team: str) -> str:
    return f"ft:pool:{team}"


def reservation_key(job_id: str) -> str:
    return f"ft:reservation:{job_id}"


def queue_key(team: str) -> str:
    return f"ft:queue:{team}"


def eval_key(job_id: str) -> str:
    return f"ft:eval:{job_id}"
`,
  'finetune/registry.py': `"""The model and dataset registry (provided, read-only here): what a fine-tune may name."""
# Each base model's fine-tune recipe and the hyperparameters it reads.
BASE_MODELS = {
    "llama-3.1-8b": {"id": "llama-3.1-8b", "supported": ["learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"]},
    "mistral-7b-v0.3": {"id": "mistral-7b-v0.3", "supported": ["learning_rate", "epochs", "batch_size"]},
}

# Dataset versions with the SHA-256 of their content. status: registered, or retired
# (support-tickets@v2 held unredacted e-mail addresses).
DATASETS = {
    "support-tickets@v3": {"id": "support-tickets@v3", "sha256": "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031", "status": "registered"},
    "support-tickets@v2": {"id": "support-tickets@v2", "sha256": "f6e096ac4484030db0ef9db46599ba8a0b4c935d2340da369602e3ceea2774e8", "status": "retired"},
    "legal-qa@v1": {"id": "legal-qa@v1", "sha256": "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc", "status": "registered"},
}


def get_base_model(name: str) -> dict | None:
    """{id, supported}, None for a model the registry does not know."""
    return BASE_MODELS.get(name)


def get_dataset(version: str) -> dict | None:
    """{id, sha256, status}, None for a version the registry does not know."""
    return DATASETS.get(version)
`,
  'finetune/recipe.py': `"""The recipe's fingerprint (provided): one hash for a base model, dataset content and hyperparameters."""
import hashlib
import json


def config_hash(base_model: str, dataset_sha256: str, hyperparameters: dict) -> str:
    """SHA-256 hex of the canonical JSON (sorted keys, no spaces): key order does not change it."""
    canonical = json.dumps(
        {"base_model": base_model, "dataset_sha256": dataset_sha256, "hyperparameters": hyperparameters},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
`,
  'finetune/jobs.py': `"""The job store (provided): jobs as Redis hashes, keyed by id and by (team, Idempotency-Key)."""
import json

import redis

from finetune.config import idem_key, job_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TEXT_FIELDS = ("job_id", "team", "status", "base_model", "dataset_version", "dataset_sha256", "config_hash")

TRANSITION = """
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
"""


class JobStore:
    def get(self, team: str, key: str) -> dict | None:
        """The job this team submitted under Idempotency-Key key, if any."""
        job_id = r.get(idem_key(team, key))
        return self.by_id(job_id) if job_id else None

    def put(self, team: str, key: str, job: dict) -> None:
        """Store the job under its id and under (team, key); the row carries the team."""
        row = {field: str(job.get(field, "")) for field in TEXT_FIELDS}
        row["team"] = team
        row["compute_budget"] = int(job.get("compute_budget", 0))
        row["hyperparameters"] = json.dumps(job.get("hyperparameters", {}))
        row["checkpoint_ids"] = json.dumps(job.get("checkpoint_ids", []))
        r.hset(job_key(job["job_id"]), mapping=row)
        r.set(idem_key(team, key), job["job_id"])

    def by_id(self, job_id: str) -> dict | None:
        """The job, None when there is none."""
        raw = r.hgetall(job_key(job_id))
        if not raw:
            return None
        job = {field: raw.get(field, "") for field in TEXT_FIELDS}
        job["compute_budget"] = int(raw.get("compute_budget", "0"))
        job["hyperparameters"] = json.loads(raw.get("hyperparameters", "{}"))
        job["checkpoint_ids"] = json.loads(raw.get("checkpoint_ids", "[]"))
        return job

    def transition(self, job_id: str, from_status: str, to_status: str) -> bool:
        """Move the job from from_status to to_status in one script; False, and nothing written, when it is elsewhere."""
        return r.eval(TRANSITION, 1, job_key(job_id), from_status, to_status) == 1


store = JobStore()
`,
  'finetune/evals.py': `"""Eval results (provided): what the eval service wrote for a job after its golden-set run."""
import redis

from finetune.config import eval_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def result(job_id: str) -> dict | None:
    """{passed, score}, None while the job has not been evaluated."""
    raw = r.hgetall(eval_key(job_id))
    if not raw:
        return None
    return {"passed": raw.get("passed") == "1", "score": float(raw.get("score", "0"))}


def record(job_id: str, passed: bool, score: float) -> None:
    """What the eval service calls when a run finishes its golden set."""
    r.hset(eval_key(job_id), mapping={"passed": 1 if passed else 0, "score": score})
`,
  'finetune/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

from finetune.config import OUTBOX_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
};

export const supportModulesTs: Record<string, string> = {
  'finetune/config.ts': `/** Addresses, topics and the Redis key layout every step of finetuned agrees on. */
/** The trainer's gRPC address: a stand-in served by the checks (finetuned.proto). */
export const TRAINER = 'trainer:9000';
/** Job transitions, keyed by job id. */
export const TOPIC = 'finetune.job';
/** Events the broker refused, for the relay. */
export const OUTBOX_KEY = 'ft:outbox';

// job: a hash (job_id, team, status, base_model, dataset_version, dataset_sha256, config_hash,
//   compute_budget, and hyperparameters and checkpoint_ids as JSON).
// pool: a team's GPU-hours not reserved by any job, a string.
// reservation: a job's hash (team, reserved, spent, state: queued, running, completed, cancelled).
// queue: a team's list of job ids waiting to start.
// eval: the eval service's hash for a job (passed 1/0, score).
export const jobKey = (jobId: string): string => 'ft:job:' + jobId;
export const idemKey = (team: string, key: string): string => 'ft:idem:' + team + ':' + key;
export const poolKey = (team: string): string => 'ft:pool:' + team;
export const reservationKey = (jobId: string): string => 'ft:reservation:' + jobId;
export const queueKey = (team: string): string => 'ft:queue:' + team;
export const evalKey = (jobId: string): string => 'ft:eval:' + jobId;
`,
  'finetune/registry.ts': `/** The model and dataset registry (provided, read-only here): what a fine-tune may name. */
export interface BaseModel {
  id: string;
  /** The hyperparameters this model's fine-tune recipe reads. */
  supported: string[];
}

export interface Dataset {
  id: string;
  /** SHA-256 of the version's content. */
  sha256: string;
  /** registered, or retired (support-tickets@v2 held unredacted e-mail addresses). */
  status: string;
}

const BASE_MODELS: Record<string, BaseModel> = {
  'llama-3.1-8b': {id: 'llama-3.1-8b', supported: ['learning_rate', 'lora_rank', 'lora_alpha', 'epochs', 'batch_size']},
  'mistral-7b-v0.3': {id: 'mistral-7b-v0.3', supported: ['learning_rate', 'epochs', 'batch_size']},
};

const DATASETS: Record<string, Dataset> = {
  'support-tickets@v3': {id: 'support-tickets@v3', sha256: 'b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031', status: 'registered'},
  'support-tickets@v2': {id: 'support-tickets@v2', sha256: 'f6e096ac4484030db0ef9db46599ba8a0b4c935d2340da369602e3ceea2774e8', status: 'retired'},
  'legal-qa@v1': {id: 'legal-qa@v1', sha256: '06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc', status: 'registered'},
};

export const registry = {
  /** The base model, null for one the registry does not know. */
  getBaseModel(name: string): BaseModel | null {
    return Object.hasOwn(BASE_MODELS, name) ? BASE_MODELS[name] : null;
  },

  /** The dataset version, null for one the registry does not know. */
  getDataset(version: string): Dataset | null {
    return Object.hasOwn(DATASETS, version) ? DATASETS[version] : null;
  },
};
`,
  'finetune/recipe.ts': `/** The recipe's fingerprint (provided): one hash for a base model, dataset content and hyperparameters. */
import {createHash} from 'node:crypto';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** SHA-256 hex of the canonical JSON (sorted keys, no spaces): key order does not change it. */
export function configHash(baseModel: string, datasetSha256: string, hyperparameters: Record<string, number>): string {
  const doc = canonical({base_model: baseModel, dataset_sha256: datasetSha256, hyperparameters});
  return createHash('sha256').update(doc).digest('hex');
}
`,
  'finetune/jobs.ts': `/** The job store (provided): jobs as Redis hashes, keyed by id and by (team, Idempotency-Key). */
import Redis from 'ioredis';

import {idemKey, jobKey} from 'finetune/config';

const redis = new Redis({host: 'redis', port: 6379});

export interface Job {
  job_id: string;
  team: string;
  status: string;
  base_model: string;
  dataset_version: string;
  dataset_sha256: string;
  config_hash: string;
  hyperparameters: Record<string, number>;
  compute_budget: number;
  checkpoint_ids: string[];
}

const TRANSITION = \`
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
\`;

export const store = {
  /** The job this team submitted under Idempotency-Key key, if any. */
  async get(team: string, key: string): Promise<Job | null> {
    const jobId = await redis.get(idemKey(team, key));
    return jobId === null ? null : store.byId(jobId);
  },

  /** Store the job under its id and under (team, key); the row carries the team. */
  async put(team: string, key: string, job: Job): Promise<void> {
    await redis.hset(jobKey(job.job_id), {
      job_id: job.job_id,
      team,
      status: job.status,
      base_model: job.base_model,
      dataset_version: job.dataset_version,
      dataset_sha256: job.dataset_sha256,
      config_hash: job.config_hash,
      compute_budget: String(job.compute_budget),
      hyperparameters: JSON.stringify(job.hyperparameters ?? {}),
      checkpoint_ids: JSON.stringify(job.checkpoint_ids ?? []),
    });
    await redis.set(idemKey(team, key), job.job_id);
  },

  /** The job, null when there is none. */
  async byId(jobId: string): Promise<Job | null> {
    const raw = await redis.hgetall(jobKey(jobId));
    if (Object.keys(raw).length === 0) return null;
    return {
      job_id: raw.job_id ?? '',
      team: raw.team ?? '',
      status: raw.status ?? '',
      base_model: raw.base_model ?? '',
      dataset_version: raw.dataset_version ?? '',
      dataset_sha256: raw.dataset_sha256 ?? '',
      config_hash: raw.config_hash ?? '',
      compute_budget: Number(raw.compute_budget ?? '0'),
      hyperparameters: JSON.parse(raw.hyperparameters ?? '{}') as Record<string, number>,
      checkpoint_ids: JSON.parse(raw.checkpoint_ids ?? '[]') as string[],
    };
  },

  /** Move the job from fromStatus to toStatus in one script; false, and nothing written, when it is elsewhere. */
  async transition(jobId: string, fromStatus: string, toStatus: string): Promise<boolean> {
    return Number(await redis.eval(TRANSITION, 1, jobKey(jobId), fromStatus, toStatus)) === 1;
  },
};
`,
  'finetune/evals.ts': `/** Eval results (provided): what the eval service wrote for a job after its golden-set run. */
import Redis from 'ioredis';

import {evalKey} from 'finetune/config';

const redis = new Redis({host: 'redis', port: 6379});

export interface EvalResult {
  passed: boolean;
  score: number;
}

export const evals = {
  /** {passed, score}, null while the job has not been evaluated. */
  async result(jobId: string): Promise<EvalResult | null> {
    const raw = await redis.hgetall(evalKey(jobId));
    if (Object.keys(raw).length === 0) return null;
    return {passed: raw.passed === '1', score: Number(raw.score ?? '0')};
  },

  /** What the eval service calls when a run finishes its golden set. */
  async record(jobId: string, passed: boolean, score: number): Promise<void> {
    await redis.hset(evalKey(jobId), {passed: passed ? '1' : '0', score: String(score)});
  },
};
`,
  'finetune/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

import {OUTBOX_KEY} from 'finetune/config';

const redis = new Redis({host: 'redis', port: 6379});

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
};

/** The Go twins: the same \`finetune\` packages, imported as finetune/config, finetune/registry, … */
export const supportModulesGo: Record<string, string> = {
  'finetune/config/config.go': `// Package config holds the addresses, topics and Redis key layout every step of finetuned agrees on.
package config

const (
	// Trainer is the trainer's gRPC address: a stand-in served by the checks (finetuned.proto).
	Trainer = "trainer:9000"
	// Topic carries job transitions, keyed by job id.
	Topic = "finetune.job"
	// OutboxKey keeps events the broker refused, for the relay.
	OutboxKey = "ft:outbox"
)

// job: a hash (job_id, team, status, base_model, dataset_version, dataset_sha256, config_hash,
//   compute_budget, and hyperparameters and checkpoint_ids as JSON).
// pool: a team's GPU-hours not reserved by any job, a string.
// reservation: a job's hash (team, reserved, spent, state: queued, running, completed, cancelled).
// queue: a team's list of job ids waiting to start.
// eval: the eval service's hash for a job (passed 1/0, score).

func JobKey(jobID string) string          { return "ft:job:" + jobID }
func IdemKey(team, key string) string      { return "ft:idem:" + team + ":" + key }
func PoolKey(team string) string           { return "ft:pool:" + team }
func ReservationKey(jobID string) string  { return "ft:reservation:" + jobID }
func QueueKey(team string) string          { return "ft:queue:" + team }
func EvalKey(jobID string) string          { return "ft:eval:" + jobID }
`,
  'finetune/registry/registry.go': `// Package registry is the model and dataset registry (provided, read-only here): what a fine-tune may name.
package registry

// BaseModel is a base model and the hyperparameters its fine-tune recipe reads.
type BaseModel struct {
	ID        string
	Supported []string
}

// Dataset is a dataset version: the SHA-256 of its content and its status (registered, or retired:
// support-tickets@v2 held unredacted e-mail addresses).
type Dataset struct {
	ID     string
	SHA256 string
	Status string
}

var baseModels = map[string]BaseModel{
	"llama-3.1-8b":    {ID: "llama-3.1-8b", Supported: []string{"learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"}},
	"mistral-7b-v0.3": {ID: "mistral-7b-v0.3", Supported: []string{"learning_rate", "epochs", "batch_size"}},
}

var datasets = map[string]Dataset{
	"support-tickets@v3": {ID: "support-tickets@v3", SHA256: "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031", Status: "registered"},
	"support-tickets@v2": {ID: "support-tickets@v2", SHA256: "f6e096ac4484030db0ef9db46599ba8a0b4c935d2340da369602e3ceea2774e8", Status: "retired"},
	"legal-qa@v1":        {ID: "legal-qa@v1", SHA256: "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc", Status: "registered"},
}

// GetBaseModel is the base model; false for one the registry does not know.
func GetBaseModel(name string) (BaseModel, bool) {
	m, ok := baseModels[name]
	return m, ok
}

// GetDataset is the dataset version; false for one the registry does not know.
func GetDataset(version string) (Dataset, bool) {
	d, ok := datasets[version]
	return d, ok
}
`,
  'finetune/recipe/recipe.go': `// Package recipe is the recipe's fingerprint (provided): one hash for a base model, dataset content
// and hyperparameters.
package recipe

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// ConfigHash is the SHA-256 hex of the canonical JSON (sorted keys, no spaces): key order does not change it.
func ConfigHash(baseModel, datasetSHA256 string, hyperparameters map[string]float64) string {
	doc, _ := json.Marshal(map[string]any{"base_model": baseModel, "dataset_sha256": datasetSHA256, "hyperparameters": hyperparameters})
	sum := sha256.Sum256(doc)
	return hex.EncodeToString(sum[:])
}
`,
  'finetune/jobs/jobs.go': `// Package jobs is the job store (provided): jobs as Redis hashes, keyed by id and by (team, Idempotency-Key).
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"

	"finetune/config"
)

// Job is a fine-tune job as the API answers it.
type Job struct {
	JobID           string             \`json:"job_id"\`
	Team            string             \`json:"team"\`
	Status          string             \`json:"status"\`
	BaseModel       string             \`json:"base_model"\`
	DatasetVersion  string             \`json:"dataset_version"\`
	DatasetSHA256   string             \`json:"dataset_sha256"\`
	ConfigHash      string             \`json:"config_hash"\`
	Hyperparameters map[string]float64 \`json:"hyperparameters"\`
	ComputeBudget   int                \`json:"compute_budget"\`
	CheckpointIDs   []string           \`json:"checkpoint_ids"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var transition = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
\`)

// Get is the job team submitted under Idempotency-Key key; nil when there is none.
func Get(ctx context.Context, team, key string) (*Job, error) {
	jobID, err := rdb.Get(ctx, config.IdemKey(team, key)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ByID(ctx, jobID)
}

// Put stores the job under its id and under (team, key); the row carries the team.
func Put(ctx context.Context, team, key string, job Job) error {
	hyper := job.Hyperparameters
	if hyper == nil {
		hyper = map[string]float64{}
	}
	checkpoints := job.CheckpointIDs
	if checkpoints == nil {
		checkpoints = []string{}
	}
	hyperJSON, _ := json.Marshal(hyper)
	checkpointJSON, _ := json.Marshal(checkpoints)
	err := rdb.HSet(ctx, config.JobKey(job.JobID),
		"job_id", job.JobID, "team", team, "status", job.Status, "base_model", job.BaseModel,
		"dataset_version", job.DatasetVersion, "dataset_sha256", job.DatasetSHA256, "config_hash", job.ConfigHash,
		"compute_budget", job.ComputeBudget, "hyperparameters", string(hyperJSON), "checkpoint_ids", string(checkpointJSON)).Err()
	if err != nil {
		return err
	}
	return rdb.Set(ctx, config.IdemKey(team, key), job.JobID, 0).Err()
}

// ByID is the job; nil when there is none.
func ByID(ctx context.Context, jobID string) (*Job, error) {
	raw, err := rdb.HGetAll(ctx, config.JobKey(jobID)).Result()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	budget, _ := strconv.Atoi(raw["compute_budget"])
	job := &Job{
		JobID: raw["job_id"], Team: raw["team"], Status: raw["status"], BaseModel: raw["base_model"],
		DatasetVersion: raw["dataset_version"], DatasetSHA256: raw["dataset_sha256"], ConfigHash: raw["config_hash"],
		ComputeBudget: budget, Hyperparameters: map[string]float64{}, CheckpointIDs: []string{},
	}
	if err := json.Unmarshal([]byte(raw["hyperparameters"]), &job.Hyperparameters); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(raw["checkpoint_ids"]), &job.CheckpointIDs); err != nil {
		return nil, err
	}
	return job, nil
}

// Transition moves the job from fromStatus to toStatus in one script; false, and nothing written,
// when it is elsewhere.
func Transition(ctx context.Context, jobID, fromStatus, toStatus string) (bool, error) {
	n, err := transition.Run(ctx, rdb, []string{config.JobKey(jobID)}, fromStatus, toStatus).Int64()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}
`,
  'finetune/evals/evals.go': `// Package evals holds the eval results (provided): what the eval service wrote for a job after its
// golden-set run.
package evals

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"finetune/config"
)

// Result is a job's eval on the golden set.
type Result struct {
	Passed bool    \`json:"passed"\`
	Score  float64 \`json:"score"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the job's eval; false while the job has not been evaluated.
func Get(ctx context.Context, jobID string) (Result, bool, error) {
	raw, err := rdb.HGetAll(ctx, config.EvalKey(jobID)).Result()
	if err != nil {
		return Result{}, false, err
	}
	if len(raw) == 0 {
		return Result{}, false, nil
	}
	score, _ := strconv.ParseFloat(raw["score"], 64)
	return Result{Passed: raw["passed"] == "1", Score: score}, true, nil
}

// Record is what the eval service calls when a run finishes its golden set.
func Record(ctx context.Context, jobID string, passed bool, score float64) error {
	flag := "0"
	if passed {
		flag = "1"
	}
	return rdb.HSet(ctx, config.EvalKey(jobID), "passed", flag, "score", strconv.FormatFloat(score, 'f', -1, 64)).Err()
}
`,
  'finetune/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"

	"github.com/redis/go-redis/v9"

	"finetune/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert durably keeps an event the broker refused (the event's JSON).
func Insert(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, config.OutboxKey, event).Err()
}
`,
};

/** The C++ twins as headers (finetune/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'finetune/config.h': `// Addresses, topics and the Redis key layout every step of finetuned agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The trainer's gRPC address: a stand-in served by the checks (finetuned.proto).
inline constexpr const char* kTrainer = "trainer:9000";
// Job transitions, keyed by job id.
inline constexpr const char* kTopic = "finetune.job";
// Events the broker refused, for the relay.
inline constexpr const char* kOutboxKey = "ft:outbox";

// job: a hash (job_id, team, status, base_model, dataset_version, dataset_sha256, config_hash,
//   compute_budget, and hyperparameters and checkpoint_ids as JSON).
// pool: a team's GPU-hours not reserved by any job, a string.
// reservation: a job's hash (team, reserved, spent, state: queued, running, completed, cancelled).
// queue: a team's list of job ids waiting to start.
// eval: the eval service's hash for a job (passed 1/0, score).
inline std::string job_key(const std::string& job_id) { return "ft:job:" + job_id; }
inline std::string idem_key(const std::string& team, const std::string& key) { return "ft:idem:" + team + ":" + key; }
inline std::string pool_key(const std::string& team) { return "ft:pool:" + team; }
inline std::string reservation_key(const std::string& job_id) { return "ft:reservation:" + job_id; }
inline std::string queue_key(const std::string& team) { return "ft:queue:" + team; }
inline std::string eval_key(const std::string& job_id) { return "ft:eval:" + job_id; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'finetune/registry.h': `// The model and dataset registry (provided, read-only here): what a fine-tune may name.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace registry {

// A base model and the hyperparameters its fine-tune recipe reads.
struct BaseModel {
  std::string id;
  std::vector<std::string> supported;
};

// A dataset version: the SHA-256 of its content and its status (registered, or retired:
// support-tickets@v2 held unredacted e-mail addresses).
struct Dataset {
  std::string id;
  std::string sha256;
  std::string status;
};

inline const std::map<std::string, BaseModel>& base_models() {
  static const std::map<std::string, BaseModel> models = {
      {"llama-3.1-8b", {"llama-3.1-8b", {"learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"}}},
      {"mistral-7b-v0.3", {"mistral-7b-v0.3", {"learning_rate", "epochs", "batch_size"}}},
  };
  return models;
}

inline const std::map<std::string, Dataset>& datasets() {
  static const std::map<std::string, Dataset> versions = {
      {"support-tickets@v3", {"support-tickets@v3", "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031", "registered"}},
      {"support-tickets@v2", {"support-tickets@v2", "f6e096ac4484030db0ef9db46599ba8a0b4c935d2340da369602e3ceea2774e8", "retired"}},
      {"legal-qa@v1", {"legal-qa@v1", "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc", "registered"}},
  };
  return versions;
}

// The base model; nullopt for one the registry does not know.
inline std::optional<BaseModel> get_base_model(const std::string& name) {
  const auto it = base_models().find(name);
  if (it == base_models().end()) return std::nullopt;
  return it->second;
}

// The dataset version; nullopt for one the registry does not know.
inline std::optional<Dataset> get_dataset(const std::string& version) {
  const auto it = datasets().find(version);
  if (it == datasets().end()) return std::nullopt;
  return it->second;
}

}  // namespace registry
`,
  'finetune/recipe.h': `// The recipe's fingerprint (provided): one hash for a base model, dataset content and hyperparameters.
#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "digest.h"

namespace recipe {

// SHA-256 hex of the canonical JSON (sorted keys, no spaces): key order does not change it.
inline std::string config_hash(const std::string& base_model, const std::string& dataset_sha256, const nlohmann::json& hyperparameters) {
  const nlohmann::json doc = {{"base_model", base_model}, {"dataset_sha256", dataset_sha256}, {"hyperparameters", hyperparameters}};
  return sha256_hex(doc.dump());
}

}  // namespace recipe
`,
  'finetune/jobs.h': `// The job store (provided): jobs as Redis hashes, keyed by id and by (team, Idempotency-Key).
// A job is JSON: job_id, team, status, base_model, dataset_version, dataset_sha256, config_hash,
// hyperparameters (object), compute_budget (integer), checkpoint_ids (array).
#pragma once

#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "finetune/config.h"

namespace jobs {

inline const std::vector<std::string>& text_fields() {
  static const std::vector<std::string> fields = {"job_id", "team", "status", "base_model", "dataset_version", "dataset_sha256", "config_hash"};
  return fields;
}

// The job, nullopt when there is none.
inline std::optional<nlohmann::json> by_id(const std::string& job_id) {
  std::unordered_map<std::string, std::string> raw;
  for (const auto& [field, value] : config::redis().hgetall(config::job_key(job_id))) raw[field] = value;
  if (raw.empty()) return std::nullopt;
  nlohmann::json job = nlohmann::json::object();
  for (const auto& field : text_fields()) job[field] = raw.count(field) ? raw[field] : "";
  job["compute_budget"] = raw.count("compute_budget") ? std::stoll(raw["compute_budget"]) : 0;
  job["hyperparameters"] = nlohmann::json::parse(raw.count("hyperparameters") ? raw["hyperparameters"] : "{}");
  job["checkpoint_ids"] = nlohmann::json::parse(raw.count("checkpoint_ids") ? raw["checkpoint_ids"] : "[]");
  return job;
}

// The job team submitted under Idempotency-Key key, if any.
inline std::optional<nlohmann::json> get(const std::string& team, const std::string& key) {
  const auto job_id = config::redis().get(config::idem_key(team, key));
  if (!job_id) return std::nullopt;
  return by_id(*job_id);
}

// Store the job under its id and under (team, key); the row carries the team.
inline void put(const std::string& team, const std::string& key, const nlohmann::json& job) {
  const std::string job_id = job.at("job_id").get<std::string>();
  std::vector<std::pair<std::string, std::string>> row;
  for (const auto& field : text_fields()) {
    row.emplace_back(field, field == "team" ? team : (job.contains(field) && job[field].is_string() ? job[field].get<std::string>() : ""));
  }
  row.emplace_back("compute_budget", std::to_string(job.value("compute_budget", 0LL)));
  row.emplace_back("hyperparameters", job.value("hyperparameters", nlohmann::json::object()).dump());
  row.emplace_back("checkpoint_ids", job.value("checkpoint_ids", nlohmann::json::array()).dump());
  config::redis().hset(config::job_key(job_id), row.begin(), row.end());
  config::redis().set(config::idem_key(team, key), job_id);
}

// Move the job from from_status to to_status in one script; false, and nothing written, when it is elsewhere.
inline bool transition(const std::string& job_id, const std::string& from_status, const std::string& to_status) {
  static const std::string kTransition = R"lua(
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
)lua";
  return config::redis().eval<long long>(kTransition, {config::job_key(job_id)}, {from_status, to_status}) == 1;
}

}  // namespace jobs
`,
  'finetune/evals.h': `// Eval results (provided): what the eval service wrote for a job after its golden-set run.
#pragma once

#include <optional>
#include <string>
#include <unordered_map>

#include "finetune/config.h"

namespace evals {

struct Result {
  bool passed = false;
  double score = 0;
};

// The job's eval, nullopt while the job has not been evaluated.
inline std::optional<Result> result(const std::string& job_id) {
  std::unordered_map<std::string, std::string> raw;
  for (const auto& [field, value] : config::redis().hgetall(config::eval_key(job_id))) raw[field] = value;
  if (raw.empty()) return std::nullopt;
  return Result{raw["passed"] == "1", raw.count("score") ? std::stod(raw["score"]) : 0.0};
}

// What the eval service calls when a run finishes its golden set.
inline void record(const std::string& job_id, bool passed, double score) {
  config::redis().hset(config::eval_key(job_id), {{"passed", passed ? "1" : "0"}, {"score", std::to_string(score)}});
}

}  // namespace evals
`,
  'finetune/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>

#include "finetune/config.h"

namespace outbox {

// Durably keep an event the broker refused (its JSON).
inline void insert_outbox(const std::string& event_json) { config::redis().rpush(config::kOutboxKey, event_json); }

}  // namespace outbox
`,
};

/** The Scala twins: the same \`finetune\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('finetune', 'Config')]: `package finetune

/** Addresses, topics and the Redis key layout every step of finetuned agrees on. */
object Config {
  /** The trainer's gRPC address: a stand-in served by the checks (finetuned.proto). */
  val Trainer = "trainer:9000"
  /** Job transitions, keyed by job id. */
  val Topic = "finetune.job"
  /** Events the broker refused, for the relay. */
  val OutboxKey = "ft:outbox"

  // job: a hash (job_id, team, status, base_model, dataset_version, dataset_sha256, config_hash,
  //   compute_budget, and hyperparameters and checkpoint_ids as JSON).
  // pool: a team's GPU-hours not reserved by any job, a string.
  // reservation: a job's hash (team, reserved, spent, state: queued, running, completed, cancelled).
  // queue: a team's list of job ids waiting to start.
  // eval: the eval service's hash for a job (passed 1/0, score).
  def jobKey(jobId: String): String = s"ft:job:$jobId"
  def idemKey(team: String, key: String): String = s"ft:idem:$team:$key"
  def poolKey(team: String): String = s"ft:pool:$team"
  def reservationKey(jobId: String): String = s"ft:reservation:$jobId"
  def queueKey(team: String): String = s"ft:queue:$team"
  def evalKey(jobId: String): String = s"ft:eval:$jobId"
}
`,
  [scalaPath('finetune', 'Registry')]: `package finetune

/** A base model and the hyperparameters its fine-tune recipe reads. */
final case class BaseModel(id: String, supported: Set[String])

/** A dataset version: the SHA-256 of its content and its status (registered, or retired). */
final case class Dataset(id: String, sha256: String, status: String)

/** The model and dataset registry (provided, read-only here): what a fine-tune may name. */
object Registry {
  private val baseModels = Map(
    "llama-3.1-8b" -> BaseModel("llama-3.1-8b", Set("learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size")),
    "mistral-7b-v0.3" -> BaseModel("mistral-7b-v0.3", Set("learning_rate", "epochs", "batch_size"))
  )

  // support-tickets@v2 is retired: it held unredacted e-mail addresses.
  private val datasets = Map(
    "support-tickets@v3" -> Dataset("support-tickets@v3", "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031", "registered"),
    "support-tickets@v2" -> Dataset("support-tickets@v2", "f6e096ac4484030db0ef9db46599ba8a0b4c935d2340da369602e3ceea2774e8", "retired"),
    "legal-qa@v1" -> Dataset("legal-qa@v1", "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc", "registered")
  )

  /** The base model, None for one the registry does not know. */
  def getBaseModel(name: String): Option[BaseModel] = baseModels.get(name)

  /** The dataset version, None for one the registry does not know. */
  def getDataset(version: String): Option[Dataset] = datasets.get(version)
}
`,
  [scalaPath('finetune', 'Recipe')]: `package finetune

import java.security.MessageDigest

/** The recipe's fingerprint (provided): one hash for a base model, dataset content and hyperparameters. */
object Recipe {
  /** SHA-256 hex of the canonical JSON (sorted keys, no spaces): key order does not change it. */
  def configHash(baseModel: String, datasetSha256: String, hyperparameters: Map[String, Double]): String = {
    val hyper = ujson.Obj.from(hyperparameters.toSeq.sortBy(_._1).map { case (k, v) => k -> ujson.Num(v) })
    val doc = ujson.write(ujson.Obj("base_model" -> baseModel, "dataset_sha256" -> datasetSha256, "hyperparameters" -> hyper))
    MessageDigest.getInstance("SHA-256").digest(doc.getBytes("UTF-8")).map("%02x".format(_)).mkString
  }
}
`,
  [scalaPath('finetune', 'Jobs')]: `package finetune

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** A fine-tune job as the API answers it. */
final case class Job(
    job_id: String,
    team: String,
    status: String,
    base_model: String,
    dataset_version: String,
    dataset_sha256: String,
    config_hash: String,
    hyperparameters: Map[String, Double],
    compute_budget: Int,
    checkpoint_ids: List[String]
)

/** The job store (provided): jobs as Redis hashes, keyed by id and by (team, Idempotency-Key). */
object Jobs {
  private val jedis = new JedisPooled("redis", 6379)

  private val Transition =
    """if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
      |redis.call('HSET', KEYS[1], 'status', ARGV[2])
      |return 1
      |""".stripMargin

  /** The job this team submitted under Idempotency-Key key, if any. */
  def get(team: String, key: String): Option[Job] = Option(jedis.get(Config.idemKey(team, key))).flatMap(byId)

  /** Store the job under its id and under (team, key); the row carries the team. */
  def put(team: String, key: String, job: Job): Unit = {
    val hyper = ujson.Obj.from(job.hyperparameters.toSeq.map { case (k, v) => k -> ujson.Num(v) })
    val row = Map(
      "job_id" -> job.job_id,
      "team" -> team,
      "status" -> job.status,
      "base_model" -> job.base_model,
      "dataset_version" -> job.dataset_version,
      "dataset_sha256" -> job.dataset_sha256,
      "config_hash" -> job.config_hash,
      "compute_budget" -> job.compute_budget.toString,
      "hyperparameters" -> ujson.write(hyper),
      "checkpoint_ids" -> ujson.write(ujson.Arr.from(job.checkpoint_ids.map(ujson.Str(_))))
    )
    jedis.hset(Config.jobKey(job.job_id), row.asJava)
    jedis.set(Config.idemKey(team, key), job.job_id)
    ()
  }

  /** The job, None when there is none. */
  def byId(jobId: String): Option[Job] = {
    val raw = jedis.hgetAll(Config.jobKey(jobId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      val text = (field: String) => raw.getOrElse(field, "")
      val hyperJson: String = raw.getOrElse("hyperparameters", "{}")
      val checkpointJson: String = raw.getOrElse("checkpoint_ids", "[]")
      val hyper = ujson.read(hyperJson).obj
      Some(
        Job(
          text("job_id"),
          text("team"),
          text("status"),
          text("base_model"),
          text("dataset_version"),
          text("dataset_sha256"),
          text("config_hash"),
          hyper.keys.map(k => k -> hyper(k).num).toMap,
          raw.getOrElse("compute_budget", "0").toInt,
          ujson.read(checkpointJson).arr.toList.map(_.str)
        )
      )
    }
  }

  /** Move the job from fromStatus to toStatus in one script; false, and nothing written, when it is elsewhere. */
  def transition(jobId: String, fromStatus: String, toStatus: String): Boolean =
    jedis.eval(Transition, List(Config.jobKey(jobId)).asJava, List(fromStatus, toStatus).asJava) == 1L
}
`,
  [scalaPath('finetune', 'Evals')]: `package finetune

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** A job's eval on the golden set. */
final case class EvalResult(passed: Boolean, score: Double)

/** Eval results (provided): what the eval service wrote for a job after its golden-set run. */
object Evals {
  private val jedis = new JedisPooled("redis", 6379)

  /** The job's eval, None while the job has not been evaluated. */
  def result(jobId: String): Option[EvalResult] = {
    val raw = jedis.hgetAll(Config.evalKey(jobId)).asScala.toMap
    if (raw.isEmpty) None else Some(EvalResult(raw.get("passed").contains("1"), raw.getOrElse("score", "0").toDouble))
  }

  /** What the eval service calls when a run finishes its golden set. */
  def record(jobId: String, passed: Boolean, score: Double): Unit = {
    jedis.hset(Config.evalKey(jobId), Map("passed" -> (if (passed) "1" else "0"), "score" -> score.toString).asJava)
    ()
  }
}
`,
  [scalaPath('finetune', 'Outbox')]: `package finetune

import redis.clients.jedis.JedisPooled

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused (its JSON). */
  def insertOutbox(eventJson: String): Unit = {
    jedis.rpush(Config.OutboxKey, eventJson)
    ()
  }
}
`,
};
