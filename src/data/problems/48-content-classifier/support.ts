/**
 * Hand-written support modules the content-classifier steps import but no step builds: the
 * `classifier` package. `config` is the contract every step agrees on (the model's address, the
 * topic, the keys); `taxonomies` the taxonomy store (immutable versions per tenant, Redis as the
 * course's stand-in for the taxonomy database); `inference` the model client of step 3 as the
 * endpoint uses it; `counters` the hourly label counters of step 2 as the consumer uses them;
 * `outbox` the rows kept when the broker refuses an event; and `labeler` the deterministic stand-in
 * the checks serve over gRPC in place of the model. The five languages keep the same keys, so a
 * harness reads one layout whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'classifier/__init__.py': '',
  'classifier/config.py': `"""Addresses, topics and keys every step of classifierd agrees on."""
# The classification model's gRPC address: a stand-in served by the checks (classifier.labeler).
MODEL = "model:9000"
# One event per classification, keyed by tenant.
TOPIC = "classify.result"
# The metrics consumer's group.
GROUP = "classifier-metrics"
# The bucket a document goes to when none of its labels can be trusted.
REVIEW_LABEL = "review"
# How many classifications the keyword rules answered instead of the model (a string counter).
FALLBACK_KEY = "metrics:classifier_fallback_total"
# Events the broker refused, kept for the relay (a list of JSON payloads).
OUTBOX_KEY = "classifier:outbox"


def classifications_key(tenant: str) -> str:
    """A tenant's classification records, oldest first (a list of JSON documents)."""
    return f"classifications:{tenant}"
`,
  'classifier/taxonomies.py': `"""
The taxonomy store (provided). A taxonomy belongs to one tenant and is a sequence of immutable
versions: taxdb:{taxonomy_id} is a hash of tenant and latest, taxdb:{taxonomy_id}:v{n} a hash of
labels, added and removed (JSON arrays: the version's label set and what changed against version
n - 1). A taxonomy is {"taxonomy_id", "version", "labels"}; a change {"version", "added", "removed"}.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _head_key(taxonomy_id: str) -> str:
    return f"taxdb:{taxonomy_id}"


def _version_key(taxonomy_id: str, version: int) -> str:
    return f"taxdb:{taxonomy_id}:v{version}"


def _version(taxonomy_id: str, version: int) -> dict | None:
    row = r.hgetall(_version_key(taxonomy_id, version))
    if not row:
        return None
    return {"taxonomy_id": taxonomy_id, "version": version, "labels": json.loads(row["labels"])}


def load(tenant: str, taxonomy_id: str, version: int | None = None) -> dict | None:
    """Version \`version\` (the latest when None) of a taxonomy this tenant owns; None otherwise."""
    head = r.hgetall(_head_key(taxonomy_id))
    if not head or head.get("tenant") != tenant or "latest" not in head:
        return None
    return _version(taxonomy_id, int(head["latest"]) if version is None else version)


def by_id(taxonomy_id: str) -> dict | None:
    """The latest version of a taxonomy, whichever tenant owns it (the lookup from before tenancy)."""
    latest = r.hget(_head_key(taxonomy_id), "latest")
    return None if latest is None else _version(taxonomy_id, int(latest))


def put_version(tenant: str, taxonomy_id: str, labels: list[str]) -> int:
    """Publish the labels as the next immutable version (version 1 creates the taxonomy); returns it."""
    r.hsetnx(_head_key(taxonomy_id), "tenant", tenant)
    previous = by_id(taxonomy_id)
    before = previous["labels"] if previous else []
    version = previous["version"] + 1 if previous else 1
    r.hset(
        _version_key(taxonomy_id, version),
        mapping={
            "labels": json.dumps(list(labels)),
            "added": json.dumps([label for label in labels if label not in before]),
            "removed": json.dumps([label for label in before if label not in labels]),
        },
    )
    r.hset(_head_key(taxonomy_id), "latest", version)
    return version


def update_labels(tenant: str, taxonomy_id: str, labels: list[str]) -> int:
    """The editor from before versioning: rewrites the latest version's labels in place; returns that version."""
    latest = r.hget(_head_key(taxonomy_id), "latest")
    if latest is None:
        return put_version(tenant, taxonomy_id, labels)
    r.hset(_version_key(taxonomy_id, int(latest)), "labels", json.dumps(list(labels)))
    return int(latest)


def changelog(tenant: str, taxonomy_id: str, since: int, until: int) -> list[dict]:
    """The changes of versions since + 1 to until of a taxonomy this tenant owns, oldest first."""
    if load(tenant, taxonomy_id) is None:
        return []
    out = []
    for version in range(since + 1, until + 1):
        row = r.hgetall(_version_key(taxonomy_id, version))
        if row:
            out.append({"version": version, "added": json.loads(row["added"]), "removed": json.loads(row["removed"])})
    return out
`,
  'classifier/inference.py': `"""
The model client (provided; step 3 builds the same function). classify(text, taxonomy_id,
taxonomy_version) calls Model.Classify with a 700 ms deadline and at most three attempts (only
UNAVAILABLE and DEADLINE_EXCEEDED are retried) and answers {"labels", "provenance",
"model_version"}: provenance "model" for the model's labels; "fallback" (model_version "rules",
counted under config.FALLBACK_KEY) for the keyword rules when the model refused or could not
answer. The rules never invent a label: no keyword means config.REVIEW_LABEL.
"""
import time

import grpc
import redis

import content_classifier_pb2
import content_classifier_pb2_grpc
from classifier.config import FALLBACK_KEY, MODEL, REVIEW_LABEL

DEADLINE_S = 0.7
MAX_ATTEMPTS = 3
BACKOFF_S = 0.05
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
KEYWORD_RULES = (
    ("billing", ("invoice", "refund", "charge")),
    ("support", ("broken", "error", "crash")),
    ("security", ("password", "breach", "phishing")),
)

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stub = content_classifier_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL))


def rules_classify(text: str) -> list[str]:
    lowered = text.lower()
    labels = [label for label, words in KEYWORD_RULES if any(word in lowered for word in words)]
    return labels or [REVIEW_LABEL]


def classify(text: str, taxonomy_id: str, taxonomy_version: int) -> dict:
    request = content_classifier_pb2.ClassifyRequest(text=text, taxonomy_id=taxonomy_id, taxonomy_version=taxonomy_version)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Classify(request, timeout=DEADLINE_S)
        except grpc.RpcError as err:
            if err.code() in RETRYABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            break
        if reply.refused:
            break
        return {"labels": list(reply.labels), "provenance": "model", "model_version": reply.model_version}
    r.incr(FALLBACK_KEY)
    return {"labels": rules_classify(text), "provenance": "fallback", "model_version": "rules"}
`,
  'classifier/counters.py': `"""
Per-tenant label counters (provided; step 2 builds the same two functions). counters:{tenant}:{hour}
is a hash of label to count for one clock hour (hour = unix seconds // 3600), and it expires when
its hour ends.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

COUNTER_WINDOW_S = 3600


def counters_key(tenant: str, now: float) -> str:
    return f"counters:{tenant}:{int(now) // COUNTER_WINDOW_S}"


def bump_counter(tenant: str, label: str) -> None:
    now = time.time()
    key = counters_key(tenant, now)
    pipe = r.pipeline(transaction=True)
    pipe.hincrby(key, label, 1)
    pipe.expire(key, COUNTER_WINDOW_S - int(now) % COUNTER_WINDOW_S)
    pipe.execute()
`,
  'classifier/outbox.py': `"""The outbox (provided): classify.result payloads the broker refused, kept for the relay to republish."""
import json

import redis

from classifier.config import OUTBOX_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(payload: dict) -> None:
    """Durably keep an event the broker refused."""
    r.rpush(OUTBOX_KEY, json.dumps(payload))


def rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]
`,
  'classifier/labeler.py': `"""
The stand-in for the classification model. The checks serve it over gRPC (Model.Classify at
classifier.config.MODEL); the service's code never calls it directly. Deterministic on purpose:

classify(text) -> (labels, refused):
  text starting with "refuse:" is declined (no labels, refused True)
  otherwise every label of KEYWORDS whose keyword appears in the lower-cased text, in KEYWORDS
  order, then every "#word" of the text as the label "word": the model does not know the tenant's
  taxonomy, so a hashtag is a label it invented
"""
MODEL_VERSION = "clf-2026-10"

KEYWORDS = (
    ("billing", ("invoice", "refund", "charge")),
    ("support", ("broken", "error", "crash")),
    ("security", ("password", "breach", "phishing")),
)


def classify(text: str) -> tuple[list[str], bool]:
    if text.startswith("refuse:"):
        return [], True
    lowered = text.lower()
    labels = [label for label, words in KEYWORDS if any(word in lowered for word in words)]
    labels += [word[1:].lower() for word in text.split() if word.startswith("#") and len(word) > 1]
    return labels, False
`,
};

export const supportModulesTs: Record<string, string> = {
  'classifier/config.ts': `/** Addresses, topics and keys every step of classifierd agrees on. */
/** The classification model's gRPC address: a stand-in served by the checks (classifier/labeler). */
export const MODEL = 'model:9000';
/** One event per classification, keyed by tenant. */
export const TOPIC = 'classify.result';
/** The metrics consumer's group. */
export const GROUP = 'classifier-metrics';
/** The bucket a document goes to when none of its labels can be trusted. */
export const REVIEW_LABEL = 'review';
/** How many classifications the keyword rules answered instead of the model (a string counter). */
export const FALLBACK_KEY = 'metrics:classifier_fallback_total';
/** Events the broker refused, kept for the relay (a list of JSON payloads). */
export const OUTBOX_KEY = 'classifier:outbox';

/** A tenant's classification records, oldest first (a list of JSON documents). */
export const classificationsKey = (tenant: string): string => \`classifications:\${tenant}\`;
`,
  'classifier/taxonomies.ts': `/**
 * The taxonomy store (provided). A taxonomy belongs to one tenant and is a sequence of immutable
 * versions: taxdb:{taxonomy_id} is a hash of tenant and latest, taxdb:{taxonomy_id}:v{n} a hash of
 * labels, added and removed (JSON arrays: the version's label set and what changed against version
 * n - 1).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Taxonomy {
  taxonomy_id: string;
  version: number;
  labels: string[];
}

export interface Change {
  version: number;
  added: string[];
  removed: string[];
}

const headKey = (taxonomyId: string): string => \`taxdb:\${taxonomyId}\`;
const versionKey = (taxonomyId: string, version: number): string => \`taxdb:\${taxonomyId}:v\${version}\`;

async function versionOf(taxonomyId: string, version: number): Promise<Taxonomy | null> {
  const row = await redis.hgetall(versionKey(taxonomyId, version));
  if (row.labels === undefined) return null;
  return {taxonomy_id: taxonomyId, version, labels: JSON.parse(row.labels) as string[]};
}

/** Version \`version\` (the latest when null) of a taxonomy this tenant owns; null otherwise. */
export async function load(tenant: string, taxonomyId: string, version: number | null = null): Promise<Taxonomy | null> {
  const head = await redis.hgetall(headKey(taxonomyId));
  if (head.tenant !== tenant || head.latest === undefined) return null;
  return versionOf(taxonomyId, version ?? Number(head.latest));
}

/** The latest version of a taxonomy, whichever tenant owns it (the lookup from before tenancy). */
export async function byId(taxonomyId: string): Promise<Taxonomy | null> {
  const latest = await redis.hget(headKey(taxonomyId), 'latest');
  return latest === null ? null : versionOf(taxonomyId, Number(latest));
}

/** Publish the labels as the next immutable version (version 1 creates the taxonomy); returns it. */
export async function putVersion(tenant: string, taxonomyId: string, labels: string[]): Promise<number> {
  await redis.hsetnx(headKey(taxonomyId), 'tenant', tenant);
  const previous = await byId(taxonomyId);
  const before = previous?.labels ?? [];
  const version = (previous?.version ?? 0) + 1;
  await redis.hset(versionKey(taxonomyId, version), {
    labels: JSON.stringify(labels),
    added: JSON.stringify(labels.filter(label => !before.includes(label))),
    removed: JSON.stringify(before.filter(label => !labels.includes(label))),
  });
  await redis.hset(headKey(taxonomyId), 'latest', String(version));
  return version;
}

/** The editor from before versioning: rewrites the latest version's labels in place; returns that version. */
export async function updateLabels(tenant: string, taxonomyId: string, labels: string[]): Promise<number> {
  const latest = await redis.hget(headKey(taxonomyId), 'latest');
  if (latest === null) return putVersion(tenant, taxonomyId, labels);
  await redis.hset(versionKey(taxonomyId, Number(latest)), 'labels', JSON.stringify(labels));
  return Number(latest);
}

/** The changes of versions since + 1 to until of a taxonomy this tenant owns, oldest first. */
export async function changelog(tenant: string, taxonomyId: string, since: number, until: number): Promise<Change[]> {
  if ((await load(tenant, taxonomyId)) === null) return [];
  const out: Change[] = [];
  for (let version = since + 1; version <= until; version++) {
    const row = await redis.hgetall(versionKey(taxonomyId, version));
    if (row.added !== undefined) out.push({version, added: JSON.parse(row.added) as string[], removed: JSON.parse(row.removed) as string[]});
  }
  return out;
}
`,
  'classifier/inference.ts': `/**
 * The model client (provided; step 3 builds the same function). classify(text, taxonomyId,
 * taxonomyVersion) calls Model.Classify with a 700 ms deadline and at most three attempts (only
 * UNAVAILABLE and DEADLINE_EXCEEDED are retried) and resolves {labels, provenance, model_version}:
 * provenance "model" for the model's labels; "fallback" (model_version "rules", counted under
 * FALLBACK_KEY) for the keyword rules when the model refused or could not answer. The rules never
 * invent a label: no keyword means REVIEW_LABEL.
 */
import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {FALLBACK_KEY, MODEL, REVIEW_LABEL} from 'classifier/config';

export const DEADLINE_MS = 700;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 50;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
const KEYWORD_RULES: [string, string[]][] = [
  ['billing', ['invoice', 'refund', 'charge']],
  ['support', ['broken', 'error', 'crash']],
  ['security', ['password', 'breach', 'phishing']],
];

interface ClassifyRequest {
  text: string;
  taxonomy_id: string;
  taxonomy_version: number;
}
interface ClassifyReply {
  labels: string[];
  refused: boolean;
  model_version: string;
}
interface ModelClient {
  Classify(request: ClassifyRequest, options?: {deadline: number}): Promise<ClassifyReply>;
}

const {contentclassifier} = grpc.loadPackageDefinition(protoLoader.loadSync('content_classifier.proto')) as unknown as {
  contentclassifier: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new contentclassifier.Model(MODEL, grpc.credentials.createInsecure());
const redis = new Redis({host: 'redis', port: 6379});

export interface Result {
  labels: string[];
  provenance: string;
  model_version: string;
}

export function rulesClassify(text: string): string[] {
  const lowered = text.toLowerCase();
  const labels = KEYWORD_RULES.filter(([, words]) => words.some(word => lowered.includes(word))).map(([label]) => label);
  return labels.length > 0 ? labels : [REVIEW_LABEL];
}

export async function classify(text: string, taxonomyId: string, taxonomyVersion: number): Promise<Result> {
  const request = {text, taxonomy_id: taxonomyId, taxonomy_version: taxonomyVersion};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let reply: ClassifyReply;
    try {
      reply = await stub.Classify(request, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      if (RETRYABLE.includes((err as grpc.ServiceError).code) && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      break;
    }
    if (reply.refused) break;
    return {labels: [...(reply.labels ?? [])], provenance: 'model', model_version: reply.model_version};
  }
  await redis.incr(FALLBACK_KEY);
  return {labels: rulesClassify(text), provenance: 'fallback', model_version: 'rules'};
}
`,
  'classifier/counters.ts': `/**
 * Per-tenant label counters (provided; step 2 builds the same two functions). counters:{tenant}:{hour}
 * is a hash of label to count for one clock hour (hour = unix seconds / 3600, rounded down), and it
 * expires when its hour ends.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const COUNTER_WINDOW_S = 3600;

export const countersKey = (tenant: string, nowS: number): string => \`counters:\${tenant}:\${Math.floor(nowS / COUNTER_WINDOW_S)}\`;

export async function bumpCounter(tenant: string, label: string): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const key = countersKey(tenant, nowS);
  await redis
    .multi()
    .hincrby(key, label, 1)
    .expire(key, COUNTER_WINDOW_S - (nowS % COUNTER_WINDOW_S))
    .exec();
}
`,
  'classifier/outbox.ts': `/** The outbox (provided): classify.result payloads the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

import {OUTBOX_KEY} from 'classifier/config';

const redis = new Redis({host: 'redis', port: 6379});

/** Durably keep an event the broker refused. */
export async function insert(payload: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify(payload));
}

export async function rows(): Promise<Record<string, unknown>[]> {
  return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as Record<string, unknown>);
}
`,
  'classifier/labeler.ts': `/**
 * The stand-in for the classification model. The checks serve it over gRPC (Model.Classify at
 * MODEL); the service's code never calls it directly. Deterministic on purpose: text starting with
 * "refuse:" is declined (no labels, refused); otherwise every label of KEYWORDS whose keyword appears
 * in the lower-cased text, in KEYWORDS order, then every "#word" of the text as the label "word"
 * (the model does not know the tenant's taxonomy, so a hashtag is a label it invented).
 */
export const MODEL_VERSION = 'clf-2026-10';

const KEYWORDS: [string, string[]][] = [
  ['billing', ['invoice', 'refund', 'charge']],
  ['support', ['broken', 'error', 'crash']],
  ['security', ['password', 'breach', 'phishing']],
];

export function classify(text: string): {labels: string[]; refused: boolean} {
  if (text.startsWith('refuse:')) return {labels: [], refused: true};
  const lowered = text.toLowerCase();
  const labels = KEYWORDS.filter(([, words]) => words.some(word => lowered.includes(word))).map(([label]) => label);
  for (const word of text.split(/\\s+/)) if (word.startsWith('#') && word.length > 1) labels.push(word.slice(1).toLowerCase());
  return {labels, refused: false};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'classifier/config/config.go': `// Package config holds the addresses, topics and keys every step of classifierd agrees on.
package config

const (
	// Model is the classification model's gRPC address: a stand-in served by the checks (classifier/labeler).
	Model = "model:9000"
	// Topic carries one event per classification, keyed by tenant.
	Topic = "classify.result"
	// Group is the metrics consumer's group.
	Group = "classifier-metrics"
	// ReviewLabel is the bucket a document goes to when none of its labels can be trusted.
	ReviewLabel = "review"
	// FallbackKey counts the classifications the keyword rules answered instead of the model.
	FallbackKey = "metrics:classifier_fallback_total"
	// OutboxKey holds the events the broker refused, for the relay (a list of JSON payloads).
	OutboxKey = "classifier:outbox"
)

// ClassificationsKey holds a tenant's classification records, oldest first (a list of JSON documents).
func ClassificationsKey(tenant string) string { return "classifications:" + tenant }
`,
  'classifier/taxonomies/taxonomies.go': `// Package taxonomies is the taxonomy store (provided). A taxonomy belongs to one tenant and is a
// sequence of immutable versions: taxdb:{taxonomy_id} is a hash of tenant and latest,
// taxdb:{taxonomy_id}:v{n} a hash of labels, added and removed (JSON arrays: the version's label set
// and what changed against version n - 1). A version argument of 0 means the latest.
package taxonomies

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Taxonomy is one version of a taxonomy.
type Taxonomy struct {
	TaxonomyID string   \`json:"taxonomy_id"\`
	Version    int      \`json:"version"\`
	Labels     []string \`json:"labels"\`
}

// Change is what one version changed against the one before it.
type Change struct {
	Version int      \`json:"version"\`
	Added   []string \`json:"added"\`
	Removed []string \`json:"removed"\`
}

func headKey(taxonomyID string) string { return "taxdb:" + taxonomyID }

func versionKey(taxonomyID string, version int) string {
	return fmt.Sprintf("taxdb:%s:v%d", taxonomyID, version)
}

func versionOf(ctx context.Context, taxonomyID string, version int) (*Taxonomy, error) {
	row, err := rdb.HGetAll(ctx, versionKey(taxonomyID, version)).Result()
	if err != nil {
		return nil, err
	}
	if row["labels"] == "" {
		return nil, nil
	}
	t := &Taxonomy{TaxonomyID: taxonomyID, Version: version, Labels: []string{}}
	return t, json.Unmarshal([]byte(row["labels"]), &t.Labels)
}

// Load is version (the latest when 0) of a taxonomy this tenant owns; nil otherwise.
func Load(ctx context.Context, tenant, taxonomyID string, version int) (*Taxonomy, error) {
	head, err := rdb.HGetAll(ctx, headKey(taxonomyID)).Result()
	if err != nil {
		return nil, err
	}
	if head["tenant"] != tenant || head["latest"] == "" {
		return nil, nil
	}
	if version == 0 {
		version, _ = strconv.Atoi(head["latest"])
	}
	return versionOf(ctx, taxonomyID, version)
}

// ByID is the latest version of a taxonomy, whichever tenant owns it (the lookup from before tenancy).
func ByID(ctx context.Context, taxonomyID string) (*Taxonomy, error) {
	latest, err := rdb.HGet(ctx, headKey(taxonomyID), "latest").Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	version, _ := strconv.Atoi(latest)
	return versionOf(ctx, taxonomyID, version)
}

func minus(a, b []string) []string {
	out := []string{}
	for _, x := range a {
		found := false
		for _, y := range b {
			found = found || x == y
		}
		if !found {
			out = append(out, x)
		}
	}
	return out
}

// PutVersion publishes the labels as the next immutable version (version 1 creates the taxonomy); it returns the version.
func PutVersion(ctx context.Context, tenant, taxonomyID string, labels []string) (int, error) {
	if err := rdb.HSetNX(ctx, headKey(taxonomyID), "tenant", tenant).Err(); err != nil {
		return 0, err
	}
	previous, err := ByID(ctx, taxonomyID)
	if err != nil {
		return 0, err
	}
	before := []string{}
	version := 1
	if previous != nil {
		before = previous.Labels
		version = previous.Version + 1
	}
	all, _ := json.Marshal(append([]string{}, labels...))
	added, _ := json.Marshal(minus(labels, before))
	removed, _ := json.Marshal(minus(before, labels))
	if err := rdb.HSet(ctx, versionKey(taxonomyID, version), "labels", string(all), "added", string(added), "removed", string(removed)).Err(); err != nil {
		return 0, err
	}
	return version, rdb.HSet(ctx, headKey(taxonomyID), "latest", version).Err()
}

// UpdateLabels is the editor from before versioning: it rewrites the latest version's labels in place and returns that version.
func UpdateLabels(ctx context.Context, tenant, taxonomyID string, labels []string) (int, error) {
	latest, err := rdb.HGet(ctx, headKey(taxonomyID), "latest").Result()
	if err == redis.Nil {
		return PutVersion(ctx, tenant, taxonomyID, labels)
	}
	if err != nil {
		return 0, err
	}
	version, _ := strconv.Atoi(latest)
	all, _ := json.Marshal(append([]string{}, labels...))
	return version, rdb.HSet(ctx, versionKey(taxonomyID, version), "labels", string(all)).Err()
}

// Changelog is the changes of versions since + 1 to until of a taxonomy this tenant owns, oldest first.
func Changelog(ctx context.Context, tenant, taxonomyID string, since, until int) ([]Change, error) {
	out := []Change{}
	owned, err := Load(ctx, tenant, taxonomyID, 0)
	if err != nil || owned == nil {
		return out, err
	}
	for version := since + 1; version <= until; version++ {
		row, err := rdb.HGetAll(ctx, versionKey(taxonomyID, version)).Result()
		if err != nil {
			return nil, err
		}
		if row["added"] == "" {
			continue
		}
		change := Change{Version: version, Added: []string{}, Removed: []string{}}
		json.Unmarshal([]byte(row["added"]), &change.Added)
		json.Unmarshal([]byte(row["removed"]), &change.Removed)
		out = append(out, change)
	}
	return out, nil
}
`,
  'classifier/inference/inference.go': `// Package inference is the model client (provided; step 3 builds the same function). Classify calls
// Model.Classify with a 700 ms deadline and at most three attempts (only UNAVAILABLE and
// DEADLINE_EXCEEDED are retried): provenance "model" for the model's labels; "fallback"
// (ModelVersion "rules", counted under config.FallbackKey) for the keyword rules when the model
// refused or could not answer. The rules never invent a label: no keyword means config.ReviewLabel.
package inference

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"classifier/config"
	pb "classifier/gen/content_classifier"
)

const (
	deadline    = 700 * time.Millisecond
	maxAttempts = 3
	backoff     = 50 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Result is one classification: the labels, where they came from, and the model that produced them.
type Result struct {
	Labels       []string \`json:"labels"\`
	Provenance   string   \`json:"provenance"\`
	ModelVersion string   \`json:"model_version"\`
}

type rule struct {
	label string
	words []string
}

var keywordRules = []rule{
	{"billing", []string{"invoice", "refund", "charge"}},
	{"support", []string{"broken", "error", "crash"}},
	{"security", []string{"password", "breach", "phishing"}},
}

// RulesClassify is the deterministic keyword fallback.
func RulesClassify(text string) []string {
	lowered := strings.ToLower(text)
	labels := []string{}
	for _, r := range keywordRules {
		for _, word := range r.words {
			if strings.Contains(lowered, word) {
				labels = append(labels, r.label)
				break
			}
		}
	}
	if len(labels) == 0 {
		return []string{config.ReviewLabel}
	}
	return labels
}

// Classify labels the text with the model, or with the keyword rules when the model cannot answer.
func Classify(ctx context.Context, text, taxonomyID string, taxonomyVersion int) (Result, error) {
	request := &pb.ClassifyRequest{Text: text, TaxonomyId: taxonomyID, TaxonomyVersion: int64(taxonomyVersion)}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Classify(callCtx, request)
		cancel()
		if err != nil {
			code := status.Code(err)
			if (code == codes.Unavailable || code == codes.DeadlineExceeded) && attempt < maxAttempts {
				time.Sleep(backoff * time.Duration(attempt))
				continue
			}
			break
		}
		if reply.GetRefused() {
			break
		}
		return Result{Labels: append([]string{}, reply.GetLabels()...), Provenance: "model", ModelVersion: reply.GetModelVersion()}, nil
	}
	if err := rdb.Incr(ctx, config.FallbackKey).Err(); err != nil {
		return Result{}, err
	}
	return Result{Labels: RulesClassify(text), Provenance: "fallback", ModelVersion: "rules"}, nil
}
`,
  'classifier/counters/counters.go': `// Package counters holds the per-tenant label counters (provided; step 2 builds the same two
// functions). counters:{tenant}:{hour} is a hash of label to count for one clock hour (hour = unix
// seconds / 3600, rounded down), and it expires when its hour ends.
package counters

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// CounterWindowS is the length of one counter window, in seconds.
const CounterWindowS = 3600

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// CountersKey is the tenant's counters for the hour that holds unix (seconds).
func CountersKey(tenant string, unix int64) string {
	return fmt.Sprintf("counters:%s:%d", tenant, unix/CounterWindowS)
}

// BumpCounter counts one label for the tenant in the current hour's key, which expires with the hour.
func BumpCounter(ctx context.Context, tenant, label string) error {
	now := time.Now().Unix()
	key := CountersKey(tenant, now)
	pipe := rdb.TxPipeline()
	pipe.HIncrBy(ctx, key, label, 1)
	pipe.Expire(ctx, key, time.Duration(CounterWindowS-now%CounterWindowS)*time.Second)
	_, err := pipe.Exec(ctx)
	return err
}
`,
  'classifier/outbox/outbox.go': `// Package outbox keeps the classify.result payloads the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"classifier/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert durably keeps an event the broker refused.
func Insert(ctx context.Context, payload map[string]any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, config.OutboxKey, string(raw)).Err()
}
`,
  'classifier/labeler/labeler.go': `// Package labeler is the stand-in for the classification model. The checks serve it over gRPC
// (Model.Classify at config.Model); the service's code never calls it directly. Deterministic on
// purpose: text starting with "refuse:" is declined (no labels, refused); otherwise every label of
// keywords whose keyword appears in the lower-cased text, in order, then every "#word" of the text
// as the label "word" (the model does not know the tenant's taxonomy, so a hashtag is a label it
// invented).
package labeler

import "strings"

// Version is the model version the stand-in reports.
const Version = "clf-2026-10"

type keyword struct {
	label string
	words []string
}

var keywords = []keyword{
	{"billing", []string{"invoice", "refund", "charge"}},
	{"support", []string{"broken", "error", "crash"}},
	{"security", []string{"password", "breach", "phishing"}},
}

// Classify is what the model answers for text: its labels, or a refusal.
func Classify(text string) ([]string, bool) {
	if strings.HasPrefix(text, "refuse:") {
		return []string{}, true
	}
	lowered := strings.ToLower(text)
	labels := []string{}
	for _, k := range keywords {
		for _, word := range k.words {
			if strings.Contains(lowered, word) {
				labels = append(labels, k.label)
				break
			}
		}
	}
	for _, word := range strings.Fields(text) {
		if strings.HasPrefix(word, "#") && len(word) > 1 {
			labels = append(labels, strings.ToLower(word[1:]))
		}
	}
	return labels, false
}
`,
};

/** The C++ twins as headers (classifier/*.h), plus digest.h (SHA-256). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'classifier/config.h': `// Addresses, topics and keys every step of classifierd agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The classification model's gRPC address: a stand-in served by the checks (classifier/labeler.h).
inline constexpr const char* kModel = "model:9000";
// One event per classification, keyed by tenant.
inline constexpr const char* kTopic = "classify.result";
// The metrics consumer's group.
inline constexpr const char* kGroup = "classifier-metrics";
// The bucket a document goes to when none of its labels can be trusted.
inline constexpr const char* kReviewLabel = "review";
// How many classifications the keyword rules answered instead of the model (a string counter).
inline constexpr const char* kFallbackKey = "metrics:classifier_fallback_total";
// Events the broker refused, kept for the relay (a list of JSON payloads).
inline constexpr const char* kOutboxKey = "classifier:outbox";

// A tenant's classification records, oldest first (a list of JSON documents).
inline std::string classificationsKey(const std::string& tenant) { return "classifications:" + tenant; }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'classifier/taxonomies.h': `// The taxonomy store (provided). A taxonomy belongs to one tenant and is a sequence of immutable
// versions: taxdb:{taxonomy_id} is a hash of tenant and latest, taxdb:{taxonomy_id}:v{n} a hash of
// labels, added and removed (JSON arrays: the version's label set and what changed against version
// n - 1). A version argument of 0 means the latest.
#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

#include "classifier/config.h"

namespace taxonomies {

// One version of a taxonomy.
struct Taxonomy {
  std::string taxonomy_id;
  long version = 0;
  std::vector<std::string> labels;
};

// What one version changed against the one before it.
struct Change {
  long version = 0;
  std::vector<std::string> added;
  std::vector<std::string> removed;
};

inline nlohmann::json toJson(const Taxonomy& t) {
  return nlohmann::json{{"taxonomy_id", t.taxonomy_id}, {"version", t.version}, {"labels", t.labels}};
}

inline Taxonomy fromJson(const nlohmann::json& j) {
  return Taxonomy{j.value("taxonomy_id", ""), j.value("version", 0L), j.value("labels", std::vector<std::string>{})};
}

inline std::string headKey(const std::string& taxonomy_id) { return "taxdb:" + taxonomy_id; }

inline std::string versionKey(const std::string& taxonomy_id, long version) {
  return "taxdb:" + taxonomy_id + ":v" + std::to_string(version);
}

inline std::optional<Taxonomy> versionOf(const std::string& taxonomy_id, long version) {
  const auto labels = config::redis().hget(versionKey(taxonomy_id, version), "labels");
  if (!labels) return std::nullopt;
  return Taxonomy{taxonomy_id, version, nlohmann::json::parse(*labels).get<std::vector<std::string>>()};
}

// Version \`version\` (the latest when 0) of a taxonomy this tenant owns; nullopt otherwise.
inline std::optional<Taxonomy> load(const std::string& tenant, const std::string& taxonomy_id, long version = 0) {
  const auto head = config::redis().hgetall(headKey(taxonomy_id));
  const auto owner = head.find("tenant");
  const auto latest = head.find("latest");
  if (owner == head.end() || owner->second != tenant || latest == head.end()) return std::nullopt;
  return versionOf(taxonomy_id, version == 0 ? std::stol(latest->second) : version);
}

// The latest version of a taxonomy, whichever tenant owns it (the lookup from before tenancy).
inline std::optional<Taxonomy> byId(const std::string& taxonomy_id) {
  const auto latest = config::redis().hget(headKey(taxonomy_id), "latest");
  if (!latest) return std::nullopt;
  return versionOf(taxonomy_id, std::stol(*latest));
}

inline std::vector<std::string> minus(const std::vector<std::string>& a, const std::vector<std::string>& b) {
  std::vector<std::string> out;
  for (const auto& x : a)
    if (std::find(b.begin(), b.end(), x) == b.end()) out.push_back(x);
  return out;
}

// Publish the labels as the next immutable version (version 1 creates the taxonomy); returns it.
inline long putVersion(const std::string& tenant, const std::string& taxonomy_id, const std::vector<std::string>& labels) {
  config::redis().hsetnx(headKey(taxonomy_id), "tenant", tenant);
  const auto previous = byId(taxonomy_id);
  const std::vector<std::string> before = previous ? previous->labels : std::vector<std::string>{};
  const long version = previous ? previous->version + 1 : 1;
  config::redis().hset(versionKey(taxonomy_id, version), {std::make_pair(std::string("labels"), nlohmann::json(labels).dump()),
                                                          std::make_pair(std::string("added"), nlohmann::json(minus(labels, before)).dump()),
                                                          std::make_pair(std::string("removed"), nlohmann::json(minus(before, labels)).dump())});
  config::redis().hset(headKey(taxonomy_id), "latest", std::to_string(version));
  return version;
}

// The editor from before versioning: rewrites the latest version's labels in place; returns that version.
inline long updateLabels(const std::string& tenant, const std::string& taxonomy_id, const std::vector<std::string>& labels) {
  const auto latest = config::redis().hget(headKey(taxonomy_id), "latest");
  if (!latest) return putVersion(tenant, taxonomy_id, labels);
  const long version = std::stol(*latest);
  config::redis().hset(versionKey(taxonomy_id, version), "labels", nlohmann::json(labels).dump());
  return version;
}

// The changes of versions since + 1 to until of a taxonomy this tenant owns, oldest first.
inline std::vector<Change> changelog(const std::string& tenant, const std::string& taxonomy_id, long since, long until) {
  std::vector<Change> out;
  if (!load(tenant, taxonomy_id)) return out;
  for (long version = since + 1; version <= until; version++) {
    const auto row = config::redis().hgetall(versionKey(taxonomy_id, version));
    const auto added = row.find("added");
    const auto removed = row.find("removed");
    if (added == row.end() || removed == row.end()) continue;
    out.push_back(Change{version, nlohmann::json::parse(added->second).get<std::vector<std::string>>(),
                         nlohmann::json::parse(removed->second).get<std::vector<std::string>>()});
  }
  return out;
}

}  // namespace taxonomies
`,
  'classifier/inference.h': `// The model client (provided; step 3 builds the same function). classify calls Model.Classify with
// a 700 ms deadline and at most three attempts (only UNAVAILABLE and DEADLINE_EXCEEDED are retried):
// provenance "model" for the model's labels; "fallback" (model_version "rules", counted under
// config::kFallbackKey) for the keyword rules when the model refused or could not answer. The rules
// never invent a label: no keyword means config::kReviewLabel.
#pragma once

#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "classifier/config.h"
#include "content_classifier.grpc.pb.h"

namespace inference {

inline constexpr std::chrono::milliseconds kDeadline{700};
inline constexpr int kMaxAttempts = 3;
inline constexpr std::chrono::milliseconds kBackoff{50};

// One classification: the labels, where they came from, and the model that produced them.
struct Result {
  std::vector<std::string> labels;
  std::string provenance;
  std::string model_version;
};

inline contentclassifier::Model::Stub& stub() {
  static auto s = contentclassifier::Model::NewStub(grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials()));
  return *s;
}

// The deterministic keyword fallback.
inline std::vector<std::string> rulesClassify(const std::string& text) {
  static const std::vector<std::pair<std::string, std::vector<std::string>>> rules = {
      {"billing", {"invoice", "refund", "charge"}},
      {"support", {"broken", "error", "crash"}},
      {"security", {"password", "breach", "phishing"}},
  };
  std::string lowered = text;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) { return std::tolower(c); });
  std::vector<std::string> labels;
  for (const auto& [label, words] : rules)
    for (const auto& word : words)
      if (lowered.find(word) != std::string::npos) {
        labels.push_back(label);
        break;
      }
  if (labels.empty()) labels.push_back(config::kReviewLabel);
  return labels;
}

// Labels the text with the model, or with the keyword rules when the model cannot answer.
inline Result classify(const std::string& text, const std::string& taxonomy_id, long taxonomy_version) {
  contentclassifier::ClassifyRequest request;
  request.set_text(text);
  request.set_taxonomy_id(taxonomy_id);
  request.set_taxonomy_version(taxonomy_version);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    contentclassifier::ClassifyReply reply;
    const grpc::Status status = stub().Classify(&ctx, request, &reply);
    if (!status.ok()) {
      const auto code = status.error_code();
      if ((code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED) && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(kBackoff * attempt);
        continue;
      }
      break;
    }
    if (reply.refused()) break;
    return Result{std::vector<std::string>(reply.labels().begin(), reply.labels().end()), "model", reply.model_version()};
  }
  config::redis().incr(config::kFallbackKey);
  return Result{rulesClassify(text), "fallback", "rules"};
}

}  // namespace inference
`,
  'classifier/counters.h': `// Per-tenant label counters (provided; step 2 builds the same two functions).
// counters:{tenant}:{hour} is a hash of label to count for one clock hour (hour = unix seconds /
// 3600, rounded down), and it expires when its hour ends.
#pragma once

#include <chrono>
#include <string>

#include "classifier/config.h"

namespace counters {

inline constexpr long long kCounterWindowS = 3600;

inline std::string countersKey(const std::string& tenant, long long unix_s) {
  return "counters:" + tenant + ":" + std::to_string(unix_s / kCounterWindowS);
}

inline void bumpCounter(const std::string& tenant, const std::string& label) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = countersKey(tenant, now);
  auto tx = config::redis().transaction();
  tx.hincrby(key, label, 1).expire(key, kCounterWindowS - now % kCounterWindowS).exec();
}

}  // namespace counters
`,
  'classifier/outbox.h': `// The outbox (provided): classify.result payloads the broker refused, kept for the relay to republish.
#pragma once

#include <nlohmann/json.hpp>

#include "classifier/config.h"

namespace outbox {

// Durably keep an event the broker refused.
inline void insert(const nlohmann::json& payload) { config::redis().rpush(config::kOutboxKey, payload.dump()); }

}  // namespace outbox
`,
  'classifier/labeler.h': `// The stand-in for the classification model. The checks serve it over gRPC (Model.Classify at
// config::kModel); the service's code never calls it directly. Deterministic on purpose: text
// starting with "refuse:" is declined (no labels, refused); otherwise every label of the keywords
// whose keyword appears in the lower-cased text, in order, then every "#word" of the text as the
// label "word" (the model does not know the tenant's taxonomy, so a hashtag is a label it invented).
#pragma once

#include <algorithm>
#include <cctype>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace labeler {

inline const std::string kVersion = "clf-2026-10";

struct Verdict {
  std::vector<std::string> labels;
  bool refused = false;
};

inline Verdict classify(const std::string& text) {
  if (text.rfind("refuse:", 0) == 0) return {{}, true};
  static const std::vector<std::pair<std::string, std::vector<std::string>>> keywords = {
      {"billing", {"invoice", "refund", "charge"}},
      {"support", {"broken", "error", "crash"}},
      {"security", {"password", "breach", "phishing"}},
  };
  const auto lower = [](std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
  };
  const std::string lowered = lower(text);
  Verdict verdict;
  for (const auto& [label, words] : keywords)
    for (const auto& word : words)
      if (lowered.find(word) != std::string::npos) {
        verdict.labels.push_back(label);
        break;
      }
  std::istringstream words(text);
  std::string word;
  while (words >> word)
    if (word.size() > 1 && word[0] == '#') verdict.labels.push_back(lower(word.substr(1)));
  return verdict;
}

}  // namespace labeler
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('classifier', 'Config')]: `package classifier

/** Addresses, topics and keys every step of classifierd agrees on. */
object Config {
  /** The classification model's gRPC address: a stand-in served by the checks. */
  val Model = "model:9000"
  /** One event per classification, keyed by tenant. */
  val Topic = "classify.result"
  /** The metrics consumer's group. */
  val Group = "classifier-metrics"
  /** The bucket a document goes to when none of its labels can be trusted. */
  val ReviewLabel = "review"
  /** How many classifications the keyword rules answered instead of the model (a string counter). */
  val FallbackKey = "metrics:classifier_fallback_total"
  /** Events the broker refused, kept for the relay (a list of JSON payloads). */
  val OutboxKey = "classifier:outbox"

  /** A tenant's classification records, oldest first (a list of JSON documents). */
  def classificationsKey(tenant: String): String = s"classifications:$tenant"
}
`,
  [scalaPath('classifier', 'Taxonomies')]: `package classifier

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/** One version of a taxonomy. */
final case class Taxonomy(taxonomyId: String, version: Long, labels: Seq[String]) {
  def toJson: JsObject =
    JsObject("taxonomy_id" -> JsString(taxonomyId), "version" -> JsNumber(version), "labels" -> JsArray(labels.map(JsString(_)).toVector))
}

object Taxonomy {
  def fromJson(j: JsValue): Taxonomy = {
    val fields = j.asJsObject.fields
    Taxonomy(fields("taxonomy_id").convertTo[String], fields("version").convertTo[Long], fields("labels").convertTo[Seq[String]])
  }
}

/** What one version changed against the one before it. */
final case class Change(version: Long, added: Seq[String], removed: Seq[String])

/**
 * The taxonomy store (provided). A taxonomy belongs to one tenant and is a sequence of immutable
 * versions: taxdb:{taxonomy_id} is a hash of tenant and latest, taxdb:{taxonomy_id}:v{n} a hash of
 * labels, added and removed (JSON arrays: the version's label set and what changed against version
 * n - 1). A version argument of 0 means the latest.
 */
object Taxonomies {
  val jedis = new JedisPooled("redis", 6379)

  private def headKey(taxonomyId: String): String = s"taxdb:$taxonomyId"
  private def versionKey(taxonomyId: String, version: Long): String = s"taxdb:$taxonomyId:v$version"

  private def versionOf(taxonomyId: String, version: Long): Option[Taxonomy] =
    Option(jedis.hget(versionKey(taxonomyId, version), "labels")).map(raw => Taxonomy(taxonomyId, version, raw.parseJson.convertTo[Seq[String]]))

  /** Version \`version\` (the latest when 0) of a taxonomy this tenant owns. */
  def load(tenant: String, taxonomyId: String, version: Long = 0): Option[Taxonomy] = {
    val head = jedis.hgetAll(headKey(taxonomyId)).asScala
    if (!head.get("tenant").contains(tenant) || !head.contains("latest")) None
    else versionOf(taxonomyId, if (version == 0) head("latest").toLong else version)
  }

  /** The latest version of a taxonomy, whichever tenant owns it (the lookup from before tenancy). */
  def byId(taxonomyId: String): Option[Taxonomy] =
    Option(jedis.hget(headKey(taxonomyId), "latest")).flatMap(latest => versionOf(taxonomyId, latest.toLong))

  /** Publish the labels as the next immutable version (version 1 creates the taxonomy); returns it. */
  def putVersion(tenant: String, taxonomyId: String, labels: Seq[String]): Long = {
    jedis.hsetnx(headKey(taxonomyId), "tenant", tenant)
    val previous = byId(taxonomyId)
    val before = previous.map(_.labels).getOrElse(Seq.empty)
    val version = previous.map(_.version + 1).getOrElse(1L)
    jedis.hset(
      versionKey(taxonomyId, version),
      Map(
        "labels" -> labels.toJson.compactPrint,
        "added" -> labels.filterNot(before.contains).toJson.compactPrint,
        "removed" -> before.filterNot(labels.contains).toJson.compactPrint
      ).asJava
    )
    jedis.hset(headKey(taxonomyId), "latest", version.toString)
    version
  }

  /** The editor from before versioning: rewrites the latest version's labels in place; returns that version. */
  def updateLabels(tenant: String, taxonomyId: String, labels: Seq[String]): Long =
    Option(jedis.hget(headKey(taxonomyId), "latest")) match {
      case None => putVersion(tenant, taxonomyId, labels)
      case Some(latest) =>
        jedis.hset(versionKey(taxonomyId, latest.toLong), "labels", labels.toJson.compactPrint)
        latest.toLong
    }

  /** The changes of versions since + 1 to until of a taxonomy this tenant owns, oldest first. */
  def changelog(tenant: String, taxonomyId: String, since: Long, until: Long): Seq[Change] =
    if (load(tenant, taxonomyId).isEmpty) Seq.empty
    else
      ((since + 1) to until).flatMap { version =>
        val row = jedis.hgetAll(versionKey(taxonomyId, version)).asScala
        for (added <- row.get("added"); removed <- row.get("removed"))
          yield Change(version, added.parseJson.convertTo[Seq[String]], removed.parseJson.convertTo[Seq[String]])
      }
}
`,
  [scalaPath('classifier', 'Inference')]: `package classifier

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import contentclassifier.content_classifier.{ClassifyRequest, ModelGrpc}

/** One classification: the labels, where they came from, and the model that produced them. */
final case class Result(labels: Seq[String], provenance: String, modelVersion: String)

/**
 * The model client (provided; step 3 builds the same function). classify calls Model.Classify with
 * a 700 ms deadline and at most three attempts (only UNAVAILABLE and DEADLINE_EXCEEDED are
 * retried): provenance "model" for the model's labels; "fallback" (model version "rules", counted
 * under Config.FallbackKey) for the keyword rules when the model refused or could not answer. The
 * rules never invent a label: no keyword means Config.ReviewLabel.
 */
object Inference {
  val DeadlineMs = 700L
  val MaxAttempts = 3
  val BackoffMs = 50L
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  private val KeywordRules = Seq(
    "billing" -> Seq("invoice", "refund", "charge"),
    "support" -> Seq("broken", "error", "crash"),
    "security" -> Seq("password", "breach", "phishing")
  )

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.Model).usePlaintext().build())
  private val jedis = new JedisPooled("redis", 6379)

  def rulesClassify(text: String): Seq[String] = {
    val lowered = text.toLowerCase
    val labels = KeywordRules.collect { case (label, words) if words.exists(lowered.contains) => label }
    if (labels.isEmpty) Seq(Config.ReviewLabel) else labels
  }

  def classify(text: String, taxonomyId: String, taxonomyVersion: Long): Result = {
    val request = ClassifyRequest(text = text, taxonomyId = taxonomyId, taxonomyVersion = taxonomyVersion)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).classify(request)
        if (!reply.refused) return Result(reply.labels, "model", reply.modelVersion)
        attempt = MaxAttempts + 1
      } catch {
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) && attempt < MaxAttempts =>
          Thread.sleep(BackoffMs * attempt)
          attempt += 1
        case _: StatusRuntimeException => attempt = MaxAttempts + 1
      }
    }
    jedis.incr(Config.FallbackKey)
    Result(rulesClassify(text), "fallback", "rules")
  }
}
`,
  [scalaPath('classifier', 'Counters')]: `package classifier

import redis.clients.jedis.JedisPooled

/**
 * Per-tenant label counters (provided; step 2 builds the same two functions).
 * counters:{tenant}:{hour} is a hash of label to count for one clock hour (hour = unix seconds /
 * 3600, rounded down), and it expires when its hour ends.
 */
object Counters {
  val CounterWindowS = 3600L
  private val jedis = new JedisPooled("redis", 6379)

  def countersKey(tenant: String, unixS: Long): String = s"counters:$tenant:\${unixS / CounterWindowS}"

  def bumpCounter(tenant: String, label: String): Unit = {
    val now = System.currentTimeMillis() / 1000
    val key = countersKey(tenant, now)
    val tx = jedis.multi()
    tx.hincrBy(key, label, 1)
    tx.expire(key, CounterWindowS - now % CounterWindowS)
    tx.exec()
  }
}
`,
  [scalaPath('classifier', 'Outbox')]: `package classifier

import redis.clients.jedis.JedisPooled
import spray.json.JsObject

/** The outbox (provided): classify.result payloads the broker refused, kept for the relay to republish. */
object Outbox {
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused. */
  def insert(payload: JsObject): Unit = jedis.rpush(Config.OutboxKey, payload.compactPrint)
}
`,
};
