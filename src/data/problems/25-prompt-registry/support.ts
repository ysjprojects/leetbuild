/**
 * Hand-written support modules the prompt-registry steps import but no step builds: the `prompts`
 * package. `config` is the contract every step agrees on (the evaluator's address, the topic, the
 * placeholder syntax, the key layout); `versions` is the version store (Redis, written once);
 * `evals` the eval records by content hash; `outbox` the rows kept for the relay when the broker
 * refuses a produce; `lifecycle` the event record a caller hands to step 4; and `judge` the
 * deterministic stand-in the checks serve over gRPC in place of the eval service.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'prompts/__init__.py': '',
  'prompts/config.py': `"""Addresses, topics, keys and limits every step of registryd agrees on."""
import re

# The eval service's gRPC address: a stand-in served by the checks (prompts.judge).
EVALUATOR = "evaluator:9000"
# Lifecycle events (registered, promoted, rolled_back, blocked) for the consumers of a prompt's history.
TOPIC = "prompt.lifecycle"
# A placeholder in a template: {{customer_name}}. Lower case letters, digits and underscores.
PLACEHOLDER = re.compile(r"\\{\\{([a-z_][a-z0-9_]*)\\}\\}")

# The keys in Redis. version: one registered version as JSON (name, version, content_hash, template,
# variables), written once. hash: the first version of a name registered with these bytes. live: the
# version the tenant's readers are served. history: the versions that went live, oldest first, the
# live one last. audit: one entry per move, "action|from|to|actor|at" (at in unix seconds). eval: the
# verdict for one content hash, as JSON. eval_latest: the content hash a name was judged on last.


def version_key(tenant: str, name: str, version: int) -> str:
    return f"prompts:version:{tenant}:{name}:{version}"


def hash_key(tenant: str, name: str, content_hash: str) -> str:
    return f"prompts:hash:{tenant}:{name}:{content_hash}"


def live_key(tenant: str, name: str) -> str:
    return f"prompts:live:{tenant}:{name}"


def history_key(tenant: str, name: str) -> str:
    return f"prompts:history:{tenant}:{name}"


def audit_key(tenant: str, name: str) -> str:
    return f"prompts:audit:{tenant}:{name}"


def eval_key(tenant: str, name: str, content_hash: str) -> str:
    return f"prompts:eval:{tenant}:{name}:{content_hash}"


def eval_latest_key(tenant: str, name: str) -> str:
    return f"prompts:eval_latest:{tenant}:{name}"
`,
  'prompts/versions.py': `"""The version store (provided): registered prompt versions in Redis, each written once."""
import json

import redis

from prompts.config import hash_key, version_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class VersionStore:
    def get(self, tenant: str, name: str, version: int) -> dict | None:
        """The registered version (name, version, content_hash, template, variables), None when there is none."""
        raw = r.get(version_key(tenant, name, version))
        return json.loads(raw) if raw else None

    def by_hash(self, tenant: str, name: str, content_hash: str) -> dict | None:
        """The first version of name registered with these bytes, None when there is none."""
        version = r.get(hash_key(tenant, name, content_hash))
        return self.get(tenant, name, int(version)) if version else None

    def put(self, tenant: str, record: dict) -> bool:
        """Register a new version. False, and nothing written, when (tenant, name, version) exists already."""
        if not r.set(version_key(tenant, record["name"], record["version"]), json.dumps(record), nx=True):
            return False
        r.set(hash_key(tenant, record["name"], record["content_hash"]), record["version"], nx=True)
        return True


versions = VersionStore()
`,
  'prompts/evals.py': `"""The eval records (provided): one verdict per content hash, in Redis."""
import json

import redis

from prompts.config import eval_key, eval_latest_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class EvalStore:
    def put(self, tenant: str, name: str, content_hash: str, record: dict) -> None:
        """Keep the verdict (eval_id, passed, score, content_hash, version) for these bytes."""
        r.set(eval_key(tenant, name, content_hash), json.dumps(record))
        r.set(eval_latest_key(tenant, name), content_hash)

    def get(self, tenant: str, name: str, content_hash: str) -> dict | None:
        """The verdict for exactly these bytes, None when they were never judged."""
        raw = r.get(eval_key(tenant, name, content_hash))
        return json.loads(raw) if raw else None

    def latest(self, tenant: str, name: str) -> dict | None:
        """The verdict a name received last, whichever version it judged (the dashboard's view)."""
        content_hash = r.get(eval_latest_key(tenant, name))
        return self.get(tenant, name, content_hash) if content_hash else None


evals = EvalStore()
`,
  'prompts/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "prompts:outbox"


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'prompts/lifecycle.py': `"""The lifecycle event (provided): what a caller hands to publish when a version moves."""
from dataclasses import dataclass


@dataclass
class LifecycleEvent:
    event_id: str
    tenant: str
    name: str
    version: int
    # registered, promoted, rolled_back or blocked
    action: str
    content_hash: str
    actor: str
    # The eval that gated the move; "" for a registration.
    eval_id: str
    # The template is tenant content: the caller has it, the topic and the logs must not.
    template: str
`,
  'prompts/judge.py': `"""
The stand-in for the eval service. The checks serve it over gRPC (Evaluator.Evaluate at
prompts.config.EVALUATOR); the registry's code never calls it directly. Deterministic on purpose:
the course grades what the gate does around the verdict, not the eval suite.

verdict(content_hash, template) -> (eval_id, passed, score):
  a template containing "unsafe" (any case) fails with score 0.41
  anything else passes with score 0.93
  eval_id is "ev-" and the first 12 hex digits of the content hash: the same bytes, the same id
"""


def verdict(content_hash: str, template: str) -> tuple[str, bool, float]:
    eval_id = "ev-" + content_hash[:12]
    if "unsafe" in template.lower():
        return eval_id, False, 0.41
    return eval_id, True, 0.93
`,
};

export const supportModulesTs: Record<string, string> = {
  'prompts/config.ts': `/** Addresses, topics, keys and limits every step of registryd agrees on. */
/** The eval service's gRPC address: a stand-in served by the checks (prompts/judge). */
export const EVALUATOR = 'evaluator:9000';
/** Lifecycle events (registered, promoted, rolled_back, blocked) for the consumers of a prompt's history. */
export const TOPIC = 'prompt.lifecycle';
/** A placeholder in a template: {{customer_name}}. Lower case letters, digits and underscores. */
export const PLACEHOLDER = /\\{\\{([a-z_][a-z0-9_]*)\\}\\}/g;

// The keys in Redis. version: one registered version as JSON (name, version, content_hash, template,
// variables), written once. hash: the first version of a name registered with these bytes. live: the
// version the tenant's readers are served. history: the versions that went live, oldest first, the
// live one last. audit: one entry per move, "action|from|to|actor|at" (at in unix seconds). eval: the
// verdict for one content hash, as JSON. eval_latest: the content hash a name was judged on last.
export const versionKey = (tenant: string, name: string, version: number): string =>
  \`prompts:version:\${tenant}:\${name}:\${version}\`;
export const hashKey = (tenant: string, name: string, contentHash: string): string =>
  \`prompts:hash:\${tenant}:\${name}:\${contentHash}\`;
export const liveKey = (tenant: string, name: string): string => \`prompts:live:\${tenant}:\${name}\`;
export const historyKey = (tenant: string, name: string): string => \`prompts:history:\${tenant}:\${name}\`;
export const auditKey = (tenant: string, name: string): string => \`prompts:audit:\${tenant}:\${name}\`;
export const evalKey = (tenant: string, name: string, contentHash: string): string =>
  \`prompts:eval:\${tenant}:\${name}:\${contentHash}\`;
export const evalLatestKey = (tenant: string, name: string): string => \`prompts:eval_latest:\${tenant}:\${name}\`;
`,
  'prompts/versions.ts': `/** The version store (provided): registered prompt versions in Redis, each written once. */
import Redis from 'ioredis';

import {hashKey, versionKey} from 'prompts/config';

const redis = new Redis({host: 'redis', port: 6379});

export interface PromptVersion {
  name: string;
  version: number;
  content_hash: string;
  template: string;
  variables: string[];
}

export const versions = {
  /** The registered version, null when there is none. */
  async get(tenant: string, name: string, version: number): Promise<PromptVersion | null> {
    const raw = await redis.get(versionKey(tenant, name, version));
    return raw === null ? null : (JSON.parse(raw) as PromptVersion);
  },

  /** The first version of name registered with these bytes, null when there is none. */
  async byHash(tenant: string, name: string, contentHash: string): Promise<PromptVersion | null> {
    const version = await redis.get(hashKey(tenant, name, contentHash));
    return version === null ? null : versions.get(tenant, name, Number(version));
  },

  /** Register a new version. false, and nothing written, when (tenant, name, version) exists already. */
  async put(tenant: string, record: PromptVersion): Promise<boolean> {
    const created = await redis.set(versionKey(tenant, record.name, record.version), JSON.stringify(record), 'NX');
    if (created === null) return false;
    await redis.set(hashKey(tenant, record.name, record.content_hash), String(record.version), 'NX');
    return true;
  },
};
`,
  'prompts/evals.ts': `/** The eval records (provided): one verdict per content hash, in Redis. */
import Redis from 'ioredis';

import {evalKey, evalLatestKey} from 'prompts/config';

const redis = new Redis({host: 'redis', port: 6379});

export interface EvalRecord {
  eval_id: string;
  passed: boolean;
  score: number;
  content_hash: string;
  version: number;
}

export const evals = {
  /** Keep the verdict for these bytes. */
  async put(tenant: string, name: string, contentHash: string, record: EvalRecord): Promise<void> {
    await redis.set(evalKey(tenant, name, contentHash), JSON.stringify(record));
    await redis.set(evalLatestKey(tenant, name), contentHash);
  },

  /** The verdict for exactly these bytes, null when they were never judged. */
  async get(tenant: string, name: string, contentHash: string): Promise<EvalRecord | null> {
    const raw = await redis.get(evalKey(tenant, name, contentHash));
    return raw === null ? null : (JSON.parse(raw) as EvalRecord);
  },

  /** The verdict a name received last, whichever version it judged (the dashboard's view). */
  async latest(tenant: string, name: string): Promise<EvalRecord | null> {
    const contentHash = await redis.get(evalLatestKey(tenant, name));
    return contentHash === null ? null : evals.get(tenant, name, contentHash);
  },
};
`,
  'prompts/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'prompts:outbox';

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
  'prompts/lifecycle.ts': `/** The lifecycle event (provided): what a caller hands to publish when a version moves. */
export interface LifecycleEvent {
  event_id: string;
  tenant: string;
  name: string;
  version: number;
  /** registered, promoted, rolled_back or blocked */
  action: string;
  content_hash: string;
  actor: string;
  /** The eval that gated the move; '' for a registration. */
  eval_id: string;
  /** The template is tenant content: the caller has it, the topic and the logs must not. */
  template: string;
}
`,
  'prompts/judge.ts': `/**
 * The stand-in for the eval service. The checks serve it over gRPC (Evaluator.Evaluate at
 * prompts/config's EVALUATOR); the registry's code never calls it directly. Deterministic on
 * purpose: the course grades what the gate does around the verdict, not the eval suite.
 *
 * verdict(contentHash, template) → {evalId, passed, score}:
 *   a template containing "unsafe" (any case) fails with score 0.41
 *   anything else passes with score 0.93
 *   evalId is "ev-" and the first 12 hex digits of the content hash: the same bytes, the same id
 */
export function verdict(contentHash: string, template: string): {evalId: string; passed: boolean; score: number} {
  const evalId = \`ev-\${contentHash.slice(0, 12)}\`;
  if (template.toLowerCase().includes('unsafe')) return {evalId, passed: false, score: 0.41};
  return {evalId, passed: true, score: 0.93};
}
`,
};

/** The Go twins: the same \`prompts\` packages, imported as prompts/config, prompts/versions, prompts/evals, prompts/outbox, prompts/lifecycle, prompts/judge. */
export const supportModulesGo: Record<string, string> = {
  'prompts/config/config.go': `// Package config holds the addresses, topics, keys and limits every step of registryd agrees on.
package config

import (
	"regexp"
	"strconv"
)

const (
	// Evaluator is the eval service's gRPC address: a stand-in served by the checks (prompts/judge).
	Evaluator = "evaluator:9000"
	// Topic carries lifecycle events (registered, promoted, rolled_back, blocked) for the consumers of a prompt's history.
	Topic = "prompt.lifecycle"
)

// Placeholder is a placeholder in a template: {{customer_name}}. Lower case letters, digits and underscores.
var Placeholder = regexp.MustCompile(\`\\{\\{([a-z_][a-z0-9_]*)\\}\\}\`)

// The keys in Redis. version: one registered version as JSON (name, version, content_hash, template,
// variables), written once. hash: the first version of a name registered with these bytes. live: the
// version the tenant's readers are served. history: the versions that went live, oldest first, the
// live one last. audit: one entry per move, "action|from|to|actor|at" (at in unix seconds). eval: the
// verdict for one content hash, as JSON. eval_latest: the content hash a name was judged on last.

func VersionKey(tenant, name string, version int) string {
	return "prompts:version:" + tenant + ":" + name + ":" + strconv.Itoa(version)
}
func HashKey(tenant, name, contentHash string) string {
	return "prompts:hash:" + tenant + ":" + name + ":" + contentHash
}
func LiveKey(tenant, name string) string    { return "prompts:live:" + tenant + ":" + name }
func HistoryKey(tenant, name string) string { return "prompts:history:" + tenant + ":" + name }
func AuditKey(tenant, name string) string   { return "prompts:audit:" + tenant + ":" + name }
func EvalKey(tenant, name, contentHash string) string {
	return "prompts:eval:" + tenant + ":" + name + ":" + contentHash
}
func EvalLatestKey(tenant, name string) string { return "prompts:eval_latest:" + tenant + ":" + name }
`,
  'prompts/versions/versions.go': `// Package versions is the version store (provided): registered prompt versions in Redis, each written once.
package versions

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"

	"prompts/config"
)

// Version is one registered prompt version.
type Version struct {
	Name        string   \`json:"name"\`
	Version     int      \`json:"version"\`
	ContentHash string   \`json:"content_hash"\`
	Template    string   \`json:"template"\`
	Variables   []string \`json:"variables"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the registered version; nil when there is none.
func Get(ctx context.Context, tenant, name string, version int) (*Version, error) {
	raw, err := rdb.Get(ctx, config.VersionKey(tenant, name, version)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var v Version
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// ByHash is the first version of name registered with these bytes; nil when there is none.
func ByHash(ctx context.Context, tenant, name, contentHash string) (*Version, error) {
	raw, err := rdb.Get(ctx, config.HashKey(tenant, name, contentHash)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	version, err := strconv.Atoi(raw)
	if err != nil {
		return nil, err
	}
	return Get(ctx, tenant, name, version)
}

// Put registers a new version: false, and nothing written, when (tenant, name, version) exists already.
func Put(ctx context.Context, tenant string, v Version) (bool, error) {
	doc, err := json.Marshal(v)
	if err != nil {
		return false, err
	}
	created, err := rdb.SetNX(ctx, config.VersionKey(tenant, v.Name, v.Version), doc, 0).Result()
	if err != nil || !created {
		return false, err
	}
	return true, rdb.SetNX(ctx, config.HashKey(tenant, v.Name, v.ContentHash), v.Version, 0).Err()
}
`,
  'prompts/evals/evals.go': `// Package evals keeps the eval records (provided): one verdict per content hash, in Redis.
package evals

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/redis/go-redis/v9"

	"prompts/config"
)

// Record is one verdict of the eval service.
type Record struct {
	EvalID      string  \`json:"eval_id"\`
	Passed      bool    \`json:"passed"\`
	Score       float64 \`json:"score"\`
	ContentHash string  \`json:"content_hash"\`
	Version     int     \`json:"version"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Put keeps the verdict for these bytes.
func Put(ctx context.Context, tenant, name, contentHash string, rec Record) error {
	doc, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if err := rdb.Set(ctx, config.EvalKey(tenant, name, contentHash), doc, 0).Err(); err != nil {
		return err
	}
	return rdb.Set(ctx, config.EvalLatestKey(tenant, name), contentHash, 0).Err()
}

// Get is the verdict for exactly these bytes; nil when they were never judged.
func Get(ctx context.Context, tenant, name, contentHash string) (*Record, error) {
	raw, err := rdb.Get(ctx, config.EvalKey(tenant, name, contentHash)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rec Record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// Latest is the verdict a name received last, whichever version it judged (the dashboard's view).
func Latest(ctx context.Context, tenant, name string) (*Record, error) {
	contentHash, err := rdb.Get(ctx, config.EvalLatestKey(tenant, name)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Get(ctx, tenant, name, contentHash)
}
`,
  'prompts/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "prompts:outbox"

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
  'prompts/lifecycle/lifecycle.go': `// Package lifecycle holds the lifecycle event (provided): what a caller hands to publish when a version moves.
package lifecycle

// Event is one move of a prompt version. Action is registered, promoted, rolled_back or blocked;
// EvalID is the eval that gated the move ("" for a registration). Template is tenant content: the
// caller has it, the topic and the logs must not.
type Event struct {
	EventID     string
	Tenant      string
	Name        string
	Version     int
	Action      string
	ContentHash string
	Actor       string
	EvalID      string
	Template    string
}
`,
  'prompts/judge/judge.go': `// Package judge is the stand-in for the eval service. The checks serve it over gRPC
// (Evaluator.Evaluate at config.Evaluator); the registry's code never calls it directly.
// Deterministic on purpose: the course grades what the gate does around the verdict, not the eval suite.
//
// Verdict(contentHash, template) → (evalID, passed, score):
//
//	a template containing "unsafe" (any case) fails with score 0.41
//	anything else passes with score 0.93
//	evalID is "ev-" and the first 12 hex digits of the content hash: the same bytes, the same id
package judge

import "strings"

func Verdict(contentHash, template string) (evalID string, passed bool, score float64) {
	prefix := contentHash
	if len(prefix) > 12 {
		prefix = prefix[:12]
	}
	evalID = "ev-" + prefix
	if strings.Contains(strings.ToLower(template), "unsafe") {
		return evalID, false, 0.41
	}
	return evalID, true, 0.93
}
`,
};

/** The C++ twins as headers (prompts/*.h), plus digest.h (SHA-256). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'prompts/config.h': `// Addresses, topics, keys and limits every step of registryd agrees on.
#pragma once

#include <regex>
#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The eval service's gRPC address: a stand-in served by the checks (prompts/judge.h).
inline constexpr const char* kEvaluator = "evaluator:9000";
// Lifecycle events (registered, promoted, rolled_back, blocked) for the consumers of a prompt's history.
inline constexpr const char* kTopic = "prompt.lifecycle";
// A placeholder in a template: {{customer_name}}. Lower case letters, digits and underscores.
inline const std::regex kPlaceholder(R"(\\{\\{([a-z_][a-z0-9_]*)\\}\\})");

// The keys in Redis. version: one registered version as JSON (name, version, content_hash, template,
// variables), written once. hash: the first version of a name registered with these bytes. live: the
// version the tenant's readers are served. history: the versions that went live, oldest first, the
// live one last. audit: one entry per move, "action|from|to|actor|at" (at in unix seconds). eval: the
// verdict for one content hash, as JSON. eval_latest: the content hash a name was judged on last.
inline std::string version_key(const std::string& tenant, const std::string& name, int version) {
  return "prompts:version:" + tenant + ":" + name + ":" + std::to_string(version);
}
inline std::string hash_key(const std::string& tenant, const std::string& name, const std::string& content_hash) {
  return "prompts:hash:" + tenant + ":" + name + ":" + content_hash;
}
inline std::string live_key(const std::string& tenant, const std::string& name) { return "prompts:live:" + tenant + ":" + name; }
inline std::string history_key(const std::string& tenant, const std::string& name) { return "prompts:history:" + tenant + ":" + name; }
inline std::string audit_key(const std::string& tenant, const std::string& name) { return "prompts:audit:" + tenant + ":" + name; }
inline std::string eval_key(const std::string& tenant, const std::string& name, const std::string& content_hash) {
  return "prompts:eval:" + tenant + ":" + name + ":" + content_hash;
}
inline std::string eval_latest_key(const std::string& tenant, const std::string& name) {
  return "prompts:eval_latest:" + tenant + ":" + name;
}

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'prompts/versions.h': `// The version store (provided): registered prompt versions in Redis, each written once. A version is
// JSON: {name, version, content_hash, template, variables}.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "prompts/config.h"

namespace versions {

// The registered version, nullopt when there is none.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& name, int version) {
  const auto raw = config::redis().get(config::version_key(tenant, name, version));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The first version of name registered with these bytes, nullopt when there is none.
inline std::optional<nlohmann::json> by_hash(const std::string& tenant, const std::string& name, const std::string& content_hash) {
  const auto version = config::redis().get(config::hash_key(tenant, name, content_hash));
  if (!version) return std::nullopt;
  return get(tenant, name, std::stoi(*version));
}

// Register a new version: false, and nothing written, when (tenant, name, version) exists already.
inline bool put(const std::string& tenant, const nlohmann::json& record) {
  const std::string name = record.at("name").get<std::string>();
  const int version = record.at("version").get<int>();
  if (!config::redis().setnx(config::version_key(tenant, name, version), record.dump())) return false;
  config::redis().setnx(config::hash_key(tenant, name, record.at("content_hash").get<std::string>()), std::to_string(version));
  return true;
}

}  // namespace versions
`,
  'prompts/evals.h': `// The eval records (provided): one verdict per content hash, in Redis. A record is JSON:
// {eval_id, passed, score, content_hash, version}.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "prompts/config.h"

namespace evals {

// Keep the verdict for these bytes.
inline void put(const std::string& tenant, const std::string& name, const std::string& content_hash, const nlohmann::json& record) {
  config::redis().set(config::eval_key(tenant, name, content_hash), record.dump());
  config::redis().set(config::eval_latest_key(tenant, name), content_hash);
}

// The verdict for exactly these bytes, nullopt when they were never judged.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& name, const std::string& content_hash) {
  const auto raw = config::redis().get(config::eval_key(tenant, name, content_hash));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// The verdict a name received last, whichever version it judged (the dashboard's view).
inline std::optional<nlohmann::json> latest(const std::string& tenant, const std::string& name) {
  const auto content_hash = config::redis().get(config::eval_latest_key(tenant, name));
  if (!content_hash) return std::nullopt;
  return get(tenant, name, *content_hash);
}

}  // namespace evals
`,
  'prompts/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "prompts/config.h"

namespace outbox {

inline constexpr const char* kKey = "prompts:outbox";

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
  'prompts/lifecycle.h': `// The lifecycle event (provided): what a caller hands to publish when a version moves.
#pragma once

#include <string>

namespace lifecycle {

// One move of a prompt version. action is registered, promoted, rolled_back or blocked; eval_id is the
// eval that gated the move ("" for a registration). template_text is tenant content: the caller has
// it, the topic and the logs must not.
struct Event {
  std::string event_id;
  std::string tenant;
  std::string name;
  int version = 0;
  std::string action;
  std::string content_hash;
  std::string actor;
  std::string eval_id;
  std::string template_text;
};

}  // namespace lifecycle
`,
  'prompts/judge.h': `// The stand-in for the eval service. The checks serve it over gRPC (Evaluator.Evaluate at
// config::kEvaluator); the registry's code never calls it directly. Deterministic on purpose: the
// course grades what the gate does around the verdict, not the eval suite.
//
// verdict(content_hash, template_text) -> {eval_id, passed, score}:
//   a template containing "unsafe" (any case) fails with score 0.41
//   anything else passes with score 0.93
//   eval_id is "ev-" and the first 12 hex digits of the content hash: the same bytes, the same id
#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace judge {

struct Verdict {
  std::string eval_id;
  bool passed = false;
  double score = 0;
};

inline Verdict verdict(const std::string& content_hash, const std::string& template_text) {
  std::string lower = template_text;
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  const std::string eval_id = "ev-" + content_hash.substr(0, 12);
  if (lower.find("unsafe") != std::string::npos) return {eval_id, false, 0.41};
  return {eval_id, true, 0.93};
}

}  // namespace judge
`,
};

/** The Scala twins: the same \`prompts\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('prompts', 'Config')]: `package prompts

import scala.util.matching.Regex

/** Addresses, topics, keys and limits every step of registryd agrees on. */
object Config {
  /** The eval service's gRPC address: a stand-in served by the checks. */
  val Evaluator = "evaluator:9000"
  /** Lifecycle events (registered, promoted, rolled_back, blocked) for the consumers of a prompt's history. */
  val Topic = "prompt.lifecycle"
  /** A placeholder in a template: {{customer_name}}. Lower case letters, digits and underscores. */
  val Placeholder: Regex = """\\{\\{([a-z_][a-z0-9_]*)\\}\\}""".r

  // The keys in Redis. version: one registered version as JSON (name, version, content_hash, template,
  // variables), written once. hash: the first version of a name registered with these bytes. live: the
  // version the tenant's readers are served. history: the versions that went live, oldest first, the
  // live one last. audit: one entry per move, "action|from|to|actor|at" (at in unix seconds). eval: the
  // verdict for one content hash, as JSON. eval_latest: the content hash a name was judged on last.
  def versionKey(tenant: String, name: String, version: Int): String = s"prompts:version:$tenant:$name:$version"
  def hashKey(tenant: String, name: String, contentHash: String): String = s"prompts:hash:$tenant:$name:$contentHash"
  def liveKey(tenant: String, name: String): String = s"prompts:live:$tenant:$name"
  def historyKey(tenant: String, name: String): String = s"prompts:history:$tenant:$name"
  def auditKey(tenant: String, name: String): String = s"prompts:audit:$tenant:$name"
  def evalKey(tenant: String, name: String, contentHash: String): String = s"prompts:eval:$tenant:$name:$contentHash"
  def evalLatestKey(tenant: String, name: String): String = s"prompts:eval_latest:$tenant:$name"
}
`,
  [scalaPath('prompts', 'Versions')]: `package prompts

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** One registered prompt version. */
final case class PromptVersion(name: String, version: Int, content_hash: String, template: String, variables: List[String])

/** The version store (provided): registered prompt versions in Redis, each written once. */
object Versions {
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(v: PromptVersion): String = ujson.write(
    ujson.Obj(
      "name" -> v.name,
      "version" -> v.version,
      "content_hash" -> v.content_hash,
      "template" -> v.template,
      "variables" -> ujson.Arr(v.variables.map(ujson.Str(_)): _*)
    )
  )

  private def decode(raw: String): PromptVersion = {
    val j = ujson.read(raw)
    PromptVersion(j("name").str, j("version").num.toInt, j("content_hash").str, j("template").str, j("variables").arr.map(_.str).toList)
  }

  /** The registered version, None when there is none. */
  def get(tenant: String, name: String, version: Int): Option[PromptVersion] =
    Option(jedis.get(Config.versionKey(tenant, name, version))).map(decode)

  /** The first version of name registered with these bytes, None when there is none. */
  def byHash(tenant: String, name: String, contentHash: String): Option[PromptVersion] =
    Option(jedis.get(Config.hashKey(tenant, name, contentHash))).flatMap(v => get(tenant, name, v.toInt))

  /** Register a new version: false, and nothing written, when (tenant, name, version) exists already. */
  def put(tenant: String, record: PromptVersion): Boolean = {
    val created = jedis.set(Config.versionKey(tenant, record.name, record.version), encode(record), SetParams.setParams().nx()) != null
    if (created) jedis.set(Config.hashKey(tenant, record.name, record.content_hash), record.version.toString, SetParams.setParams().nx())
    created
  }
}
`,
  [scalaPath('prompts', 'Evals')]: `package prompts

import redis.clients.jedis.JedisPooled

/** One verdict of the eval service. */
final case class EvalRecord(eval_id: String, passed: Boolean, score: Double, content_hash: String, version: Int)

/** The eval records (provided): one verdict per content hash, in Redis. */
object Evals {
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(r: EvalRecord): String = ujson.write(
    ujson.Obj("eval_id" -> r.eval_id, "passed" -> r.passed, "score" -> r.score, "content_hash" -> r.content_hash, "version" -> r.version)
  )

  private def decode(raw: String): EvalRecord = {
    val j = ujson.read(raw)
    EvalRecord(j("eval_id").str, j("passed").bool, j("score").num, j("content_hash").str, j("version").num.toInt)
  }

  /** Keep the verdict for these bytes. */
  def put(tenant: String, name: String, contentHash: String, record: EvalRecord): Unit = {
    jedis.set(Config.evalKey(tenant, name, contentHash), encode(record))
    jedis.set(Config.evalLatestKey(tenant, name), contentHash)
    ()
  }

  /** The verdict for exactly these bytes, None when they were never judged. */
  def get(tenant: String, name: String, contentHash: String): Option[EvalRecord] =
    Option(jedis.get(Config.evalKey(tenant, name, contentHash))).map(decode)

  /** The verdict a name received last, whichever version it judged (the dashboard's view). */
  def latest(tenant: String, name: String): Option[EvalRecord] =
    Option(jedis.get(Config.evalLatestKey(tenant, name))).flatMap(get(tenant, name, _))
}
`,
  [scalaPath('prompts', 'Outbox')]: `package prompts

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "prompts:outbox"
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
  [scalaPath('prompts', 'LifecycleEvent')]: `package prompts

/**
 * The lifecycle event (provided): what a caller hands to publish when a version moves. action is
 * registered, promoted, rolled_back or blocked; eval_id is the eval that gated the move ("" for a
 * registration). The template is tenant content: the caller has it, the topic and the logs must not.
 */
final case class LifecycleEvent(
    event_id: String,
    tenant: String,
    name: String,
    version: Int,
    action: String,
    content_hash: String,
    actor: String,
    eval_id: String,
    template: String
)
`,
  [scalaPath('prompts', 'Judge')]: `package prompts

/**
 * The stand-in for the eval service. The checks serve it over gRPC (Evaluator.Evaluate at
 * Config.Evaluator); the registry's code never calls it directly. A template containing "unsafe"
 * (any case) fails with score 0.41, anything else passes with 0.93; the eval id is "ev-" and the first
 * 12 hex digits of the content hash.
 */
object Judge {
  def verdict(contentHash: String, template: String): (String, Boolean, Double) = {
    val evalId = "ev-" + contentHash.take(12)
    if (template.toLowerCase.contains("unsafe")) (evalId, false, 0.41) else (evalId, true, 0.93)
  }
}
`,
};
