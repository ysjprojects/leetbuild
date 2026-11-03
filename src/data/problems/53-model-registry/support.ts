/**
 * Hand-written support modules the model-registry steps import but no step builds: the `registry`
 * package. `registry.store` is the registry's records in Redis (the course's stand-in for the
 * registry database, the artifact store, the training-run log and the eval store): models and their
 * versions, the lineage records registration checks, the recorded registrations, the per-model
 * history and the outbox. `registry.pointer` is step 2's stage-and-pointer swap as later steps use
 * it: `promote`, `rollback` and `resolve_active`. The five languages keep the same keys, so a
 * harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

const STORE_DOC = `The registry's records (provided), in Redis:
- artifact:{digest}         hash  digest, uri                      (the artifact store)
- run:{run_id}              hash  run_id, model                    (the training-run log)
- eval:{eval_id}            hash  eval_id, model, artifact_digest, score, threshold, report
- model:{name}              hash  name, owner (a tenant), visibility (private or public), latest
- model:{name}:v{n}         hash  name, version, artifact_digest, training_run_id, eval_id, stage
- idem:{tenant}:{key}       JSON  what a registration answered, for its replays
- model:{name}:history      list  JSON stage changes, each with its event_id (ev-{n})
- outbox                    list  JSON {topic, key, payload} rows a relay produces later
POOLS are the serving pools a version can be promoted into.`;

const POINTER_DOC = `The stage-and-pointer swap (provided; step 2 builds the same three functions): active:{pool}
holds "{name}:{n}", the version the pool serves. promote moves the pointer and sets the version's
stage to promoted in one Lua script, refusing a missing version and a rolled-back one whose eval
record did not change; rollback sets stage rolled_back and clears the pointer if it still holds
that version; resolve_active reads the pointer from Redis.`;

const PROMOTE_LUA = `local stage = redis.call('HGET', KEYS[1], 'stage')
if not stage then return 0 end
if stage == 'rolled_back' then
  if redis.call('HGET', KEYS[1], 'eval_id') == ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], 'eval_id', ARGV[2])
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[1])
return 1`;

const ROLLBACK_LUA = `if not redis.call('HGET', KEYS[1], 'stage') then return 0 end
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1`;

const indent = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map(line => (line ? prefix + line : prefix.trimEnd()))
    .join('\n');

export const supportModules: Record<string, string> = {
  'registry/__init__.py': '',
  'registry/store.py': `"""
${STORE_DOC}
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POOLS = ("prod", "canary")


def add_artifact(digest: str, uri: str) -> None:
    """The artifact store's writer: digest resolves to the bytes at uri."""
    r.hset(f"artifact:{digest}", mapping={"digest": digest, "uri": uri})


def add_training_run(run_id: str, model: str) -> None:
    """The training-run log's writer: run_id trained a version of model."""
    r.hset(f"run:{run_id}", mapping={"run_id": run_id, "model": model})


def add_eval(eval_id: str, model: str, artifact_digest: str, score: float, threshold: float, report: str) -> None:
    """The eval store's writer: eval_id scored artifact_digest of model; report is the full report with its test-set samples."""
    r.hset(f"eval:{eval_id}", mapping={"eval_id": eval_id, "model": model, "artifact_digest": artifact_digest, "score": score, "threshold": threshold, "report": report})


def create_model(name: str, owner: str, visibility: str = "private") -> None:
    """A model owned by a tenant; register_version creates a private one on first use."""
    r.hset(f"model:{name}", mapping={"name": name, "owner": owner, "visibility": visibility})


def artifact(digest: str) -> dict | None:
    """The artifact behind the digest, or None when it does not resolve."""
    return r.hgetall(f"artifact:{digest}") or None


def training_run(run_id: str) -> dict | None:
    """The training run {run_id, model}, or None."""
    return r.hgetall(f"run:{run_id}") or None


def eval_record(eval_id: str) -> dict | None:
    """The eval record {eval_id, model, artifact_digest, score, threshold, report}, or None; score and threshold are floats."""
    raw = r.hgetall(f"eval:{eval_id}")
    if not raw:
        return None
    return {**raw, "score": float(raw["score"]), "threshold": float(raw["threshold"])}


def model(name: str) -> dict | None:
    """The model {name, owner, visibility}, or None."""
    raw = r.hgetall(f"model:{name}")
    return {"name": raw["name"], "owner": raw["owner"], "visibility": raw["visibility"]} if raw else None


def version(name: str, n: int) -> dict | None:
    """Version n of the model {name, version, artifact_digest, training_run_id, eval_id, stage}, or None; version is an int."""
    raw = r.hgetall(f"model:{name}:v{n}")
    return {**raw, "version": int(raw["version"])} if raw else None


def register_version(tenant: str, name: str, artifact_digest: str, training_run_id: str, eval_id: str) -> dict:
    """Mint the model's next version number and write the version, stage staged; returns the row."""
    if not r.exists(f"model:{name}"):
        create_model(name, tenant)
    n = r.hincrby(f"model:{name}", "latest", 1)
    r.hset(
        f"model:{name}:v{n}",
        mapping={"name": name, "version": n, "artifact_digest": artifact_digest, "training_run_id": training_run_id, "eval_id": eval_id, "stage": "staged"},
    )
    return version(name, n)


def registration(tenant: str, key: str) -> dict | None:
    """What the registration (tenant, Idempotency-Key) answered, if it ran."""
    raw = r.get(f"idem:{tenant}:{key}")
    return json.loads(raw) if raw else None


def record_registration(tenant: str, key: str, result: dict) -> None:
    """Record what the registration (tenant, Idempotency-Key) answered, for its replays."""
    r.set(f"idem:{tenant}:{key}", json.dumps(result))


def record_change(change: dict) -> str:
    """Commit a stage change {name, version, artifact_digest, eval_id, pool, stage} to the model's history; returns its event_id."""
    event_id = f"ev-{r.incr('event:seq')}"
    r.rpush(f"model:{change['name']}:history", json.dumps({**change, "event_id": event_id}))
    return event_id


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep a record the broker did not take, for the relay to produce later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'registry/pointer.py': `"""
${POINTER_DOC}
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PROMOTE_LUA = """
${PROMOTE_LUA}
"""
ROLLBACK_LUA = """
${ROLLBACK_LUA}
"""
promote_script = r.register_script(PROMOTE_LUA)
rollback_script = r.register_script(ROLLBACK_LUA)


def version_key(name: str, version: int) -> str:
    return f"model:{name}:v{version}"


def pointer_key(pool: str) -> str:
    return f"active:{pool}"


def promote(name: str, version: int, pool: str, eval_id: str) -> bool:
    """Make version the one pool serves; eval_id is the eval record that opened the gate."""
    return promote_script(keys=[version_key(name, version), pointer_key(pool)], args=[f"{name}:{version}", eval_id]) == 1


def rollback(name: str, version: int, pool: str) -> bool:
    """Take version out of pool; False when the version does not exist."""
    return rollback_script(keys=[version_key(name, version), pointer_key(pool)], args=[f"{name}:{version}"]) == 1


def resolve_active(pool: str) -> str | None:
    """The "name:version" pool serves, or None."""
    return r.get(pointer_key(pool))
`,
};

export const supportModulesTs: Record<string, string> = {
  'registry/store.ts': `/**
${indent(STORE_DOC, ' * ')}
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const POOLS = ['prod', 'canary'] as const;

export interface Artifact {
  digest: string;
  uri: string;
}

export interface TrainingRun {
  run_id: string;
  model: string;
}

export interface EvalRecord {
  eval_id: string;
  model: string;
  artifact_digest: string;
  score: number;
  threshold: number;
  report: string;
}

export interface Model {
  name: string;
  owner: string;
  visibility: string;
}

export interface VersionRow {
  name: string;
  version: number;
  artifact_digest: string;
  training_run_id: string;
  eval_id: string;
  stage: string;
}

/** A stage change the registry commits and announces. */
export interface Change {
  name: string;
  version: number;
  artifact_digest: string;
  eval_id: string;
  pool: string;
  stage: string;
}

const hash = async (key: string): Promise<Record<string, string> | null> => {
  const raw = await redis.hgetall(key);
  return Object.keys(raw).length === 0 ? null : raw;
};

/** The artifact store's writer: digest resolves to the bytes at uri. */
export async function addArtifact(digest: string, uri: string): Promise<void> {
  await redis.hset(\`artifact:\${digest}\`, {digest, uri});
}

/** The training-run log's writer: runId trained a version of model. */
export async function addTrainingRun(runId: string, model: string): Promise<void> {
  await redis.hset(\`run:\${runId}\`, {run_id: runId, model});
}

/** The eval store's writer: evalId scored artifactDigest of model; report is the full report with its test-set samples. */
export async function addEval(evalId: string, model: string, artifactDigest: string, score: number, threshold: number, report: string): Promise<void> {
  await redis.hset(\`eval:\${evalId}\`, {eval_id: evalId, model, artifact_digest: artifactDigest, score: String(score), threshold: String(threshold), report});
}

/** A model owned by a tenant; registerVersion creates a private one on first use. */
export async function createModel(name: string, owner: string, visibility = 'private'): Promise<void> {
  await redis.hset(\`model:\${name}\`, {name, owner, visibility});
}

/** The artifact behind the digest, or null when it does not resolve. */
export async function artifact(digest: string): Promise<Artifact | null> {
  return (await hash(\`artifact:\${digest}\`)) as Artifact | null;
}

/** The training run, or null. */
export async function trainingRun(runId: string): Promise<TrainingRun | null> {
  return (await hash(\`run:\${runId}\`)) as TrainingRun | null;
}

/** The eval record, or null. */
export async function evalRecord(evalId: string): Promise<EvalRecord | null> {
  const raw = await hash(\`eval:\${evalId}\`);
  if (raw === null) return null;
  return {eval_id: raw.eval_id, model: raw.model, artifact_digest: raw.artifact_digest, score: Number(raw.score), threshold: Number(raw.threshold), report: raw.report};
}

/** The model, or null. */
export async function model(name: string): Promise<Model | null> {
  const raw = await hash(\`model:\${name}\`);
  return raw === null ? null : {name: raw.name, owner: raw.owner, visibility: raw.visibility};
}

/** Version n of the model, or null. */
export async function version(name: string, n: number): Promise<VersionRow | null> {
  const raw = await hash(\`model:\${name}:v\${n}\`);
  if (raw === null) return null;
  return {name: raw.name, version: Number(raw.version), artifact_digest: raw.artifact_digest, training_run_id: raw.training_run_id, eval_id: raw.eval_id, stage: raw.stage};
}

/** Mint the model's next version number and write the version, stage staged; returns the row. */
export async function registerVersion(tenant: string, name: string, artifactDigest: string, trainingRunId: string, evalId: string): Promise<VersionRow> {
  if ((await redis.exists(\`model:\${name}\`)) === 0) await createModel(name, tenant);
  const n = await redis.hincrby(\`model:\${name}\`, 'latest', 1);
  await redis.hset(\`model:\${name}:v\${n}\`, {
    name,
    version: String(n),
    artifact_digest: artifactDigest,
    training_run_id: trainingRunId,
    eval_id: evalId,
    stage: 'staged',
  });
  return (await version(name, n)) as VersionRow;
}

/** What the registration (tenant, Idempotency-Key) answered, if it ran. */
export async function registration(tenant: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`idem:\${tenant}:\${key}\`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Record what the registration (tenant, Idempotency-Key) answered, for its replays. */
export async function recordRegistration(tenant: string, key: string, result: Record<string, unknown>): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, JSON.stringify(result));
}

/** Commit a stage change to the model's history; returns its event_id. */
export async function recordChange(change: Change): Promise<string> {
  const eventId = \`ev-\${await redis.incr('event:seq')}\`;
  await redis.rpush(\`model:\${change.name}:history\`, JSON.stringify({...change, event_id: eventId}));
  return eventId;
}

/** Keep a record the broker did not take, for the relay to produce later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'registry/pointer.ts': `/**
${indent(POINTER_DOC, ' * ')}
 */
import Redis from 'ioredis';

export const PROMOTE_LUA = \`
${PROMOTE_LUA}
\`;
export const ROLLBACK_LUA = \`
${ROLLBACK_LUA}
\`;

interface PointerRedis extends Redis {
  promoteVersion(versionKey: string, pointerKey: string, ref: string, evalId: string): Promise<number>;
  rollbackVersion(versionKey: string, pointerKey: string, ref: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PointerRedis;
redis.defineCommand('promoteVersion', {numberOfKeys: 2, lua: PROMOTE_LUA});
redis.defineCommand('rollbackVersion', {numberOfKeys: 2, lua: ROLLBACK_LUA});

export const versionKey = (name: string, version: number): string => \`model:\${name}:v\${version}\`;
export const pointerKey = (pool: string): string => \`active:\${pool}\`;

/** Make version the one pool serves; evalId is the eval record that opened the gate. */
export async function promote(name: string, version: number, pool: string, evalId: string): Promise<boolean> {
  return (await redis.promoteVersion(versionKey(name, version), pointerKey(pool), \`\${name}:\${version}\`, evalId)) === 1;
}

/** Take version out of pool; false when the version does not exist. */
export async function rollback(name: string, version: number, pool: string): Promise<boolean> {
  return (await redis.rollbackVersion(versionKey(name, version), pointerKey(pool), \`\${name}:\${version}\`)) === 1;
}

/** The "name:version" pool serves, or null. */
export async function resolveActive(pool: string): Promise<string | null> {
  return redis.get(pointerKey(pool));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'registry/store/store.go': `// Package store holds the registry's records.
${indent(STORE_DOC, '// ')}
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Pools are the serving pools a version can be promoted into.
var Pools = []string{"prod", "canary"}

// ArtifactRow is what a digest resolves to.
type ArtifactRow struct {
	Digest string \`json:"digest"\`
	URI    string \`json:"uri"\`
}

// RunRow is one run of the training-run log.
type RunRow struct {
	RunID string \`json:"run_id"\`
	Model string \`json:"model"\`
}

// EvalRow is one record of the eval store; Report is the full report with its test-set samples.
type EvalRow struct {
	EvalID         string  \`json:"eval_id"\`
	Model          string  \`json:"model"\`
	ArtifactDigest string  \`json:"artifact_digest"\`
	Score          float64 \`json:"score"\`
	Threshold      float64 \`json:"threshold"\`
	Report         string  \`json:"report"\`
}

// ModelRow is a model and the tenant that owns it.
type ModelRow struct {
	Name       string \`json:"name"\`
	Owner      string \`json:"owner"\`
	Visibility string \`json:"visibility"\`
}

// Row is one version of a model.
type Row struct {
	Name           string \`json:"name"\`
	Version        int    \`json:"version"\`
	ArtifactDigest string \`json:"artifact_digest"\`
	TrainingRunID  string \`json:"training_run_id"\`
	EvalID         string \`json:"eval_id"\`
	Stage          string \`json:"stage"\`
}

// Change is a stage change the registry commits and announces.
type Change struct {
	Name           string \`json:"name"\`
	Version        int    \`json:"version"\`
	ArtifactDigest string \`json:"artifact_digest"\`
	EvalID         string \`json:"eval_id"\`
	Pool           string \`json:"pool"\`
	Stage          string \`json:"stage"\`
}

func hash(ctx context.Context, key string) map[string]string {
	raw := rdb.HGetAll(ctx, key).Val()
	if len(raw) == 0 {
		return nil
	}
	return raw
}

// AddArtifact is the artifact store's writer: digest resolves to the bytes at uri.
func AddArtifact(ctx context.Context, digest, uri string) {
	rdb.HSet(ctx, "artifact:"+digest, map[string]any{"digest": digest, "uri": uri})
}

// AddTrainingRun is the training-run log's writer: runID trained a version of model.
func AddTrainingRun(ctx context.Context, runID, model string) {
	rdb.HSet(ctx, "run:"+runID, map[string]any{"run_id": runID, "model": model})
}

// AddEval is the eval store's writer: evalID scored artifactDigest of model.
func AddEval(ctx context.Context, evalID, model, artifactDigest string, score, threshold float64, report string) {
	rdb.HSet(ctx, "eval:"+evalID, map[string]any{
		"eval_id": evalID, "model": model, "artifact_digest": artifactDigest,
		"score": strconv.FormatFloat(score, 'f', -1, 64), "threshold": strconv.FormatFloat(threshold, 'f', -1, 64), "report": report,
	})
}

// CreateModel makes a model owned by a tenant; RegisterVersion creates a private one on first use.
func CreateModel(ctx context.Context, name, owner, visibility string) {
	rdb.HSet(ctx, "model:"+name, map[string]any{"name": name, "owner": owner, "visibility": visibility})
}

// Artifact is the artifact behind the digest, or nil when it does not resolve.
func Artifact(ctx context.Context, digest string) *ArtifactRow {
	raw := hash(ctx, "artifact:"+digest)
	if raw == nil {
		return nil
	}
	return &ArtifactRow{Digest: raw["digest"], URI: raw["uri"]}
}

// TrainingRun is the training run, or nil.
func TrainingRun(ctx context.Context, runID string) *RunRow {
	raw := hash(ctx, "run:"+runID)
	if raw == nil {
		return nil
	}
	return &RunRow{RunID: raw["run_id"], Model: raw["model"]}
}

// EvalRecord is the eval record, or nil.
func EvalRecord(ctx context.Context, evalID string) *EvalRow {
	raw := hash(ctx, "eval:"+evalID)
	if raw == nil {
		return nil
	}
	score, _ := strconv.ParseFloat(raw["score"], 64)
	threshold, _ := strconv.ParseFloat(raw["threshold"], 64)
	return &EvalRow{EvalID: raw["eval_id"], Model: raw["model"], ArtifactDigest: raw["artifact_digest"], Score: score, Threshold: threshold, Report: raw["report"]}
}

// Model is the model, or nil.
func Model(ctx context.Context, name string) *ModelRow {
	raw := hash(ctx, "model:"+name)
	if raw == nil {
		return nil
	}
	return &ModelRow{Name: raw["name"], Owner: raw["owner"], Visibility: raw["visibility"]}
}

// Version is version n of the model, or nil.
func Version(ctx context.Context, name string, n int) *Row {
	raw := hash(ctx, fmt.Sprintf("model:%s:v%d", name, n))
	if raw == nil {
		return nil
	}
	version, _ := strconv.Atoi(raw["version"])
	return &Row{Name: raw["name"], Version: version, ArtifactDigest: raw["artifact_digest"], TrainingRunID: raw["training_run_id"], EvalID: raw["eval_id"], Stage: raw["stage"]}
}

// RegisterVersion mints the model's next version number and writes the version, stage staged.
func RegisterVersion(ctx context.Context, tenant, name, artifactDigest, trainingRunID, evalID string) *Row {
	if rdb.Exists(ctx, "model:"+name).Val() == 0 {
		CreateModel(ctx, name, tenant, "private")
	}
	n := int(rdb.HIncrBy(ctx, "model:"+name, "latest", 1).Val())
	rdb.HSet(ctx, fmt.Sprintf("model:%s:v%d", name, n), map[string]any{
		"name": name, "version": strconv.Itoa(n), "artifact_digest": artifactDigest,
		"training_run_id": trainingRunID, "eval_id": evalID, "stage": "staged",
	})
	return Version(ctx, name, n)
}

// Registration is what the registration (tenant, Idempotency-Key) answered, or nil.
func Registration(ctx context.Context, tenant, key string) map[string]any {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	var result map[string]any
	json.Unmarshal([]byte(raw), &result)
	return result
}

// RecordRegistration records what the registration (tenant, Idempotency-Key) answered, for its replays.
func RecordRegistration(ctx context.Context, tenant, key string, result any) {
	raw, _ := json.Marshal(result)
	rdb.Set(ctx, "idem:"+tenant+":"+key, raw, 0)
}

// RecordChange commits a stage change to the model's history and returns its event_id.
func RecordChange(ctx context.Context, change Change) (string, error) {
	n, err := rdb.Incr(ctx, "event:seq").Result()
	if err != nil {
		return "", err
	}
	eventID := fmt.Sprintf("ev-%d", n)
	raw, _ := json.Marshal(map[string]any{
		"name": change.Name, "version": change.Version, "artifact_digest": change.ArtifactDigest,
		"eval_id": change.EvalID, "pool": change.Pool, "stage": change.Stage, "event_id": eventID,
	})
	return eventID, rdb.RPush(ctx, "model:"+change.Name+":history", raw).Err()
}

// InsertOutbox keeps a record the broker did not take, for the relay to produce later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", raw).Err()
}
`,
  'registry/pointer/pointer.go': `// Package pointer is the registry's serving pointers.
${indent(POINTER_DOC, '// ')}
package pointer

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var promoteScript = redis.NewScript(\`
${PROMOTE_LUA}
\`)

var rollbackScript = redis.NewScript(\`
${ROLLBACK_LUA}
\`)

// VersionKey is the hash of version n of a model.
func VersionKey(name string, version int) string { return fmt.Sprintf("model:%s:v%d", name, version) }

// PointerKey holds the "name:version" a pool serves.
func PointerKey(pool string) string { return "active:" + pool }

// Promote makes version the one pool serves; evalID is the eval record that opened the gate.
func Promote(ctx context.Context, name string, version int, pool, evalID string) (bool, error) {
	ref := fmt.Sprintf("%s:%d", name, version)
	moved, err := promoteScript.Run(ctx, rdb, []string{VersionKey(name, version), PointerKey(pool)}, ref, evalID).Int64()
	return moved == 1, err
}

// Rollback takes version out of pool; false when the version does not exist.
func Rollback(ctx context.Context, name string, version int, pool string) (bool, error) {
	ref := fmt.Sprintf("%s:%d", name, version)
	done, err := rollbackScript.Run(ctx, rdb, []string{VersionKey(name, version), PointerKey(pool)}, ref).Int64()
	return done == 1, err
}

// ResolveActive is the "name:version" pool serves, or "".
func ResolveActive(ctx context.Context, pool string) (string, error) {
	ref, err := rdb.Get(ctx, PointerKey(pool)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return ref, err
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'registry/store.h': `${indent(STORE_DOC, '// ')}
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::vector<std::string> kPools = {"prod", "canary"};

struct Artifact {
  std::string digest;
  std::string uri;
};

struct TrainingRun {
  std::string run_id;
  std::string model;
};

// One record of the eval store; report is the full report with its test-set samples.
struct EvalRecord {
  std::string eval_id;
  std::string model;
  std::string artifact_digest;
  double score = 0;
  double threshold = 0;
  std::string report;
};

struct Model {
  std::string name;
  std::string owner;
  std::string visibility;
};

struct Row {
  std::string name;
  long version = 0;
  std::string artifact_digest;
  std::string training_run_id;
  std::string eval_id;
  std::string stage;
};

// A stage change the registry commits and announces.
struct Change {
  std::string name;
  long version = 0;
  std::string artifact_digest;
  std::string eval_id;
  std::string pool;
  std::string stage;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

using Hash = std::unordered_map<std::string, std::string>;

inline Hash hash(const std::string& key) { return redis().hgetall(key); }

inline std::string field(const Hash& raw, const std::string& name) { return raw.count(name) ? raw.at(name) : std::string(); }

// The artifact store's writer: digest resolves to the bytes at uri.
inline void addArtifact(const std::string& digest, const std::string& uri) {
  redis().hset("artifact:" + digest, {{"digest", digest}, {"uri", uri}});
}

// The training-run log's writer: run_id trained a version of model.
inline void addTrainingRun(const std::string& run_id, const std::string& model) {
  redis().hset("run:" + run_id, {{"run_id", run_id}, {"model", model}});
}

// The eval store's writer: eval_id scored artifact_digest of model.
inline void addEval(const std::string& eval_id, const std::string& model, const std::string& artifact_digest, double score,
                    double threshold, const std::string& report) {
  redis().hset("eval:" + eval_id, {{"eval_id", eval_id}, {"model", model}, {"artifact_digest", artifact_digest},
                                   {"score", nlohmann::json(score).dump()}, {"threshold", nlohmann::json(threshold).dump()}, {"report", report}});
}

// A model owned by a tenant; registerVersion creates a private one on first use.
inline void createModel(const std::string& name, const std::string& owner, const std::string& visibility = "private") {
  redis().hset("model:" + name, {{"name", name}, {"owner", owner}, {"visibility", visibility}});
}

// The artifact behind the digest, or none when it does not resolve.
inline std::optional<Artifact> artifact(const std::string& digest) {
  const Hash raw = hash("artifact:" + digest);
  if (raw.empty()) return std::nullopt;
  return Artifact{field(raw, "digest"), field(raw, "uri")};
}

// The training run, or none.
inline std::optional<TrainingRun> trainingRun(const std::string& run_id) {
  const Hash raw = hash("run:" + run_id);
  if (raw.empty()) return std::nullopt;
  return TrainingRun{field(raw, "run_id"), field(raw, "model")};
}

// The eval record, or none.
inline std::optional<EvalRecord> evalRecord(const std::string& eval_id) {
  const Hash raw = hash("eval:" + eval_id);
  if (raw.empty()) return std::nullopt;
  return EvalRecord{field(raw, "eval_id"), field(raw, "model"), field(raw, "artifact_digest"),
                    std::stod(field(raw, "score")), std::stod(field(raw, "threshold")), field(raw, "report")};
}

// The model, or none.
inline std::optional<Model> model(const std::string& name) {
  const Hash raw = hash("model:" + name);
  if (raw.empty()) return std::nullopt;
  return Model{field(raw, "name"), field(raw, "owner"), field(raw, "visibility")};
}

// Version n of the model, or none.
inline std::optional<Row> version(const std::string& name, long n) {
  const Hash raw = hash("model:" + name + ":v" + std::to_string(n));
  if (raw.empty()) return std::nullopt;
  return Row{field(raw, "name"), std::stol(field(raw, "version")), field(raw, "artifact_digest"),
             field(raw, "training_run_id"), field(raw, "eval_id"), field(raw, "stage")};
}

// A version as the API answers it: {name, version, artifact_digest, training_run_id, eval_id, stage}.
inline nlohmann::json rowJson(const Row& row) {
  return {{"name", row.name},           {"version", row.version}, {"artifact_digest", row.artifact_digest},
          {"training_run_id", row.training_run_id}, {"eval_id", row.eval_id}, {"stage", row.stage}};
}

// Mint the model's next version number and write the version, stage staged; returns the row.
inline Row registerVersion(const std::string& tenant, const std::string& name, const std::string& artifact_digest,
                           const std::string& training_run_id, const std::string& eval_id) {
  if (!redis().exists("model:" + name)) createModel(name, tenant);
  const long n = redis().hincrby("model:" + name, "latest", 1);
  redis().hset("model:" + name + ":v" + std::to_string(n), {{"name", name}, {"version", std::to_string(n)}, {"artifact_digest", artifact_digest},
                                                           {"training_run_id", training_run_id}, {"eval_id", eval_id}, {"stage", "staged"}});
  return *version(name, n);
}

// What the registration (tenant, Idempotency-Key) answered, if it ran.
inline std::optional<nlohmann::json> registration(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("idem:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the registration (tenant, Idempotency-Key) answered, for its replays.
inline void recordRegistration(const std::string& tenant, const std::string& key, const nlohmann::json& result) {
  redis().set("idem:" + tenant + ":" + key, result.dump());
}

// Commit a stage change to the model's history; returns its event_id.
inline std::string recordChange(const Change& change) {
  const std::string event_id = "ev-" + std::to_string(redis().incr("event:seq"));
  const nlohmann::json row = {{"name", change.name}, {"version", change.version}, {"artifact_digest", change.artifact_digest},
                              {"eval_id", change.eval_id}, {"pool", change.pool}, {"stage", change.stage}, {"event_id", event_id}};
  redis().rpush("model:" + change.name + ":history", row.dump());
  return event_id;
}

// Keep a record the broker did not take, for the relay to produce later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'registry/pointer.h': `${indent(POINTER_DOC, '// ')}
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace pointer {

inline const std::string kPromoteLua = R"lua(
${PROMOTE_LUA}
)lua";

inline const std::string kRollbackLua = R"lua(
${ROLLBACK_LUA}
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string versionKey(const std::string& name, long version) { return "model:" + name + ":v" + std::to_string(version); }
inline std::string pointerKey(const std::string& pool) { return "active:" + pool; }

// Make version the one pool serves; eval_id is the eval record that opened the gate.
inline bool promote(const std::string& name, long version, const std::string& pool, const std::string& eval_id) {
  const std::string ref = name + ":" + std::to_string(version);
  return redis().eval<long long>(kPromoteLua, {versionKey(name, version), pointerKey(pool)}, {ref, eval_id}) == 1;
}

// Take version out of pool; false when the version does not exist.
inline bool rollback(const std::string& name, long version, const std::string& pool) {
  const std::string ref = name + ":" + std::to_string(version);
  return redis().eval<long long>(kRollbackLua, {versionKey(name, version), pointerKey(pool)}, {ref}) == 1;
}

// The "name:version" pool serves, or none.
inline std::optional<std::string> resolveActive(const std::string& pool) {
  const auto ref = redis().get(pointerKey(pool));
  if (!ref) return std::nullopt;
  return *ref;
}

}  // namespace pointer
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('registry', 'Store')]: `package registry

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
${indent(STORE_DOC, ' * ')}
 */
object Store {
  final case class Artifact(digest: String, uri: String)
  final case class TrainingRun(runId: String, model: String)
  final case class EvalRecord(evalId: String, model: String, artifactDigest: String, score: Double, threshold: Double, report: String)
  final case class Model(name: String, owner: String, visibility: String)
  final case class Row(name: String, version: Long, artifactDigest: String, trainingRunId: String, evalId: String, stage: String)
  /** A stage change the registry commits and announces. */
  final case class Change(name: String, version: Long, artifactDigest: String, evalId: String, pool: String, stage: String)

  val Pools: Seq[String] = Seq("prod", "canary")

  val jedis = new JedisPooled("redis", 6379)

  private def hash(key: String): Option[Map[String, String]] = {
    val raw = jedis.hgetAll(key).asScala.toMap
    if (raw.isEmpty) None else Some(raw)
  }

  /** The artifact store's writer: digest resolves to the bytes at uri. */
  def addArtifact(digest: String, uri: String): Unit = jedis.hset(s"artifact:$digest", Map("digest" -> digest, "uri" -> uri).asJava)

  /** The training-run log's writer: runId trained a version of model. */
  def addTrainingRun(runId: String, model: String): Unit = jedis.hset(s"run:$runId", Map("run_id" -> runId, "model" -> model).asJava)

  /** The eval store's writer: evalId scored artifactDigest of model. */
  def addEval(evalId: String, model: String, artifactDigest: String, score: Double, threshold: Double, report: String): Unit =
    jedis.hset(s"eval:$evalId", Map("eval_id" -> evalId, "model" -> model, "artifact_digest" -> artifactDigest, "score" -> score.toString, "threshold" -> threshold.toString, "report" -> report).asJava)

  /** A model owned by a tenant; registerVersion creates a private one on first use. */
  def createModel(name: String, owner: String, visibility: String = "private"): Unit =
    jedis.hset(s"model:$name", Map("name" -> name, "owner" -> owner, "visibility" -> visibility).asJava)

  /** The artifact behind the digest, or None when it does not resolve. */
  def artifact(digest: String): Option[Artifact] = hash(s"artifact:$digest").map(raw => Artifact(raw("digest"), raw("uri")))

  /** The training run, or None. */
  def trainingRun(runId: String): Option[TrainingRun] = hash(s"run:$runId").map(raw => TrainingRun(raw("run_id"), raw("model")))

  /** The eval record, or None. */
  def evalRecord(evalId: String): Option[EvalRecord] =
    hash(s"eval:$evalId").map(raw => EvalRecord(raw("eval_id"), raw("model"), raw("artifact_digest"), raw("score").toDouble, raw("threshold").toDouble, raw("report")))

  /** The model, or None. */
  def model(name: String): Option[Model] = hash(s"model:$name").map(raw => Model(raw("name"), raw("owner"), raw("visibility")))

  /** Version n of the model, or None. */
  def version(name: String, n: Long): Option[Row] =
    hash(s"model:$name:v$n").map(raw => Row(raw("name"), raw("version").toLong, raw("artifact_digest"), raw("training_run_id"), raw("eval_id"), raw("stage")))

  /** A version as the API answers it: {name, version, artifact_digest, training_run_id, eval_id, stage}. */
  def rowJson(row: Row): JsObject = JsObject(
    "name" -> JsString(row.name), "version" -> JsNumber(row.version), "artifact_digest" -> JsString(row.artifactDigest),
    "training_run_id" -> JsString(row.trainingRunId), "eval_id" -> JsString(row.evalId), "stage" -> JsString(row.stage))

  /** Mint the model's next version number and write the version, stage staged; returns the row. */
  def registerVersion(tenant: String, name: String, artifactDigest: String, trainingRunId: String, evalId: String): Row = {
    if (!jedis.exists(s"model:$name")) createModel(name, tenant)
    val n = jedis.hincrBy(s"model:$name", "latest", 1L)
    jedis.hset(s"model:$name:v$n", Map("name" -> name, "version" -> n.toString, "artifact_digest" -> artifactDigest, "training_run_id" -> trainingRunId, "eval_id" -> evalId, "stage" -> "staged").asJava)
    version(name, n).get
  }

  /** What the registration (tenant, Idempotency-Key) answered, if it ran. */
  def registration(tenant: String, key: String): Option[JsObject] = Option(jedis.get(s"idem:$tenant:$key")).map(_.parseJson.asJsObject)

  /** Record what the registration (tenant, Idempotency-Key) answered, for its replays. */
  def recordRegistration(tenant: String, key: String, result: JsObject): Unit = jedis.set(s"idem:$tenant:$key", result.compactPrint)

  /** Commit a stage change to the model's history; returns its event_id. */
  def recordChange(change: Change): String = {
    val eventId = s"ev-\${jedis.incr("event:seq")}"
    val row = JsObject(
      "name" -> JsString(change.name), "version" -> JsNumber(change.version), "artifact_digest" -> JsString(change.artifactDigest),
      "eval_id" -> JsString(change.evalId), "pool" -> JsString(change.pool), "stage" -> JsString(change.stage), "event_id" -> JsString(eventId))
    jedis.rpush(s"model:\${change.name}:history", row.compactPrint)
    eventId
  }

  /** Keep a record the broker did not take, for the relay to produce later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('registry', 'Pointer')]: `package registry

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
${indent(POINTER_DOC, ' * ')}
 */
object Pointer {
  val jedis = new JedisPooled("redis", 6379)

  val PromoteLua: String =
    """${PROMOTE_LUA}
      |""".stripMargin

  val RollbackLua: String =
    """${ROLLBACK_LUA}
      |""".stripMargin

  def versionKey(name: String, version: Long): String = s"model:$name:v$version"
  def pointerKey(pool: String): String = s"active:$pool"

  /** Make version the one pool serves; evalId is the eval record that opened the gate. */
  def promote(name: String, version: Long, pool: String, evalId: String): Boolean =
    jedis.eval(PromoteLua, List(versionKey(name, version), pointerKey(pool)).asJava, List(s"$name:$version", evalId).asJava).asInstanceOf[java.lang.Long] == 1L

  /** Take version out of pool; false when the version does not exist. */
  def rollback(name: String, version: Long, pool: String): Boolean =
    jedis.eval(RollbackLua, List(versionKey(name, version), pointerKey(pool)).asJava, List(s"$name:$version").asJava).asInstanceOf[java.lang.Long] == 1L

  /** The "name:version" pool serves, or None. */
  def resolveActive(pool: String): Option[String] = Option(jedis.get(pointerKey(pool)))
}
`,
};
