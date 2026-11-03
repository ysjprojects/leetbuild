/**
 * Hand-written support modules the tool-registry steps import but no step builds: the `toolsd`
 * package. `toolsd.store` is the tool store (every registered tool version is a Redis hash, the
 * course's stand-in for the registry database), the tenants' allowlists and the lifecycle outbox.
 * `toolsd.catalog` is the catalog of step 2 as later steps use it (promote, rollback, pin_run,
 * resolve) plus the sandbox verdicts step 3 records and step 4 reads. The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'toolsd/__init__.py': '',
  'toolsd/store.py': `"""
The tool store (provided): every registered tool version is a Redis hash tool:{name}:{version}
with name, version, side_effect, owner, schema (a JSON document), endpoint and credential_ref.
tenant:{tenant}:tools is the set of tool names a tenant's agents may resolve; tools:outbox holds
the lifecycle records ({topic, key, value}) a relay republishes after the broker refused them.
A row is a dict with schema decoded.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FIELDS = ("name", "version", "side_effect", "owner", "schema", "endpoint", "credential_ref")
OUTBOX_KEY = "tools:outbox"


def tool_key(name: str, version: str) -> str:
    return f"tool:{name}:{version}"


def _encode(name: str, version: str, row: dict) -> dict:
    fields = {**row, "name": name, "version": version}
    return {f: json.dumps(fields.get(f, {}), sort_keys=True) if f == "schema" else str(fields.get(f, "")) for f in FIELDS}


def get(name: str, version: str) -> dict | None:
    """The tool version stored under (name, version), or None."""
    raw = r.hgetall(tool_key(name, version))
    if not raw:
        return None
    return {**raw, "schema": json.loads(raw.get("schema") or "{}")}


def put(name: str, version: str, row: dict) -> None:
    """The bulk importer's writer: stores row under (name, version), replacing whatever is there."""
    r.hset(tool_key(name, version), mapping=_encode(name, version, row))


def insert(name: str, version: str, row: dict) -> bool:
    """Stores row under (name, version) only if that version is new; False when it already exists."""
    if not r.hsetnx(tool_key(name, version), "name", name):
        return False
    r.hset(tool_key(name, version), mapping=_encode(name, version, row))
    return True


def allowlist(tenant: str) -> set[str]:
    """The tool names the tenant's agents may resolve."""
    return set(r.smembers(f"tenant:{tenant}:tools"))


def grant(tenant: str, *names: str) -> None:
    """Add tools to the tenant's allowlist."""
    r.sadd(f"tenant:{tenant}:tools", *names)


def to_outbox(topic: str, key: str, value: str) -> None:
    """Park a record the broker refused; the relay republishes it."""
    r.rpush(OUTBOX_KEY, json.dumps({"topic": topic, "key": key, "value": value}))
`,
  'toolsd/catalog.py': `"""
The catalog (provided; step 2 builds promote, rollback, pin_run and resolve the same way):
catalog:version:{cv} is one hash per catalog version, one field per tool holding its entry (the
stored tool row) as JSON. catalog:active names the version agents resolve, catalog:previous the one
the last promotion replaced, catalog:pin:{run_id} the version a run started on (6-hour TTL).
catalog:validation:{cv} is the sandbox's verdict on a candidate version: outcome (passed, rejected
or unavailable) and reason. promote refuses a version whose outcome is not passed.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_KEY = "catalog:active"
PREVIOUS_KEY = "catalog:previous"
PIN_TTL_S = 6 * 3600


class NotValidated(Exception):
    """The candidate has no passing validation: nothing was written."""


def version_key(cv: str) -> str:
    return f"catalog:version:{cv}"


def pin_key(run_id: str) -> str:
    return f"catalog:pin:{run_id}"


def validation_key(cv: str) -> str:
    return f"catalog:validation:{cv}"


def promote(cv: str, entries: dict[str, dict]) -> None:
    """Make catalog version cv (tool name -> entry) the one agents resolve."""
    if r.hget(validation_key(cv), "outcome") != "passed":
        raise NotValidated(f"catalog version {cv} has no passing validation")
    r.hset(version_key(cv), mapping={name: json.dumps(entry, sort_keys=True) for name, entry in entries.items()})
    current = r.get(ACTIVE_KEY)
    if current is not None and current != cv:
        r.set(PREVIOUS_KEY, current)
    r.set(ACTIVE_KEY, cv)


def rollback() -> str | None:
    """Point the catalog back at the version the last promotion replaced; that version, or None."""
    previous = r.get(PREVIOUS_KEY)
    if previous is None:
        return None
    r.set(ACTIVE_KEY, previous)
    return previous


def pin_run(run_id: str, cv: str) -> None:
    """Keep the run on catalog version cv for the rest of its plan."""
    r.set(pin_key(run_id), cv, ex=PIN_TTL_S)


def resolve(name: str, run_id: str | None = None) -> dict | None:
    """The entry of tool name in the run's pinned version, else in the active one; None if absent."""
    cv = r.get(pin_key(run_id)) if run_id else None
    if cv is None:
        cv = r.get(ACTIVE_KEY)
    if cv is None:
        return None
    raw = r.hget(version_key(cv), name)
    return json.loads(raw) if raw else None


def record_validation(cv: str, outcome: str, reason: str) -> None:
    """Record the sandbox's verdict on candidate cv."""
    r.hset(validation_key(cv), mapping={"outcome": outcome, "reason": reason})


def validation(cv: str) -> dict | None:
    """The recorded verdict on cv ({outcome, reason}), or None."""
    return r.hgetall(validation_key(cv)) or None
`,
};

export const supportModulesTs: Record<string, string> = {
  'toolsd/store.ts': `/**
 * The tool store (provided): every registered tool version is a Redis hash tool:{name}:{version}
 * with name, version, side_effect, owner, schema (a JSON document), endpoint and credential_ref.
 * tenant:{tenant}:tools is the set of tool names a tenant's agents may resolve; tools:outbox holds
 * the lifecycle records ({topic, key, value}) a relay republishes after the broker refused them.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'tools:outbox';

export interface Row {
  name: string;
  version: string;
  side_effect: string;
  owner: string;
  schema: Record<string, unknown>;
  endpoint: string;
  credential_ref: string;
}

export const toolKey = (name: string, version: string): string => \`tool:\${name}:\${version}\`;

function encode(name: string, version: string, row: Row): Record<string, string> {
  return {
    name,
    version,
    side_effect: row.side_effect,
    owner: row.owner,
    schema: JSON.stringify(row.schema ?? {}),
    endpoint: row.endpoint ?? '',
    credential_ref: row.credential_ref ?? '',
  };
}

/** The tool version stored under (name, version), or null. */
export async function get(name: string, version: string): Promise<Row | null> {
  const raw = await redis.hgetall(toolKey(name, version));
  if (Object.keys(raw).length === 0) return null;
  return {...raw, schema: JSON.parse(raw.schema || '{}')} as Row;
}

/** The bulk importer's writer: stores row under (name, version), replacing whatever is there. */
export async function put(name: string, version: string, row: Row): Promise<void> {
  await redis.hset(toolKey(name, version), encode(name, version, row));
}

/** Stores row under (name, version) only if that version is new; false when it already exists. */
export async function insert(name: string, version: string, row: Row): Promise<boolean> {
  if ((await redis.hsetnx(toolKey(name, version), 'name', name)) === 0) return false;
  await redis.hset(toolKey(name, version), encode(name, version, row));
  return true;
}

/** The tool names the tenant's agents may resolve. */
export async function allowlist(tenant: string): Promise<Set<string>> {
  return new Set(await redis.smembers(\`tenant:\${tenant}:tools\`));
}

/** Add tools to the tenant's allowlist. */
export async function grant(tenant: string, ...names: string[]): Promise<void> {
  await redis.sadd(\`tenant:\${tenant}:tools\`, ...names);
}

/** Park a record the broker refused; the relay republishes it. */
export async function toOutbox(topic: string, key: string, value: string): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({topic, key, value}));
}
`,
  'toolsd/catalog.ts': `/**
 * The catalog (provided; step 2 builds promote, rollback, pinRun and resolve the same way):
 * catalog:version:{cv} is one hash per catalog version, one field per tool holding its entry (the
 * stored tool row) as JSON. catalog:active names the version agents resolve, catalog:previous the
 * one the last promotion replaced, catalog:pin:{run_id} the version a run started on (6-hour TTL).
 * catalog:validation:{cv} is the sandbox's verdict on a candidate version: outcome (passed,
 * rejected or unavailable) and reason. promote refuses a version whose outcome is not passed.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export type Entry = Record<string, unknown>;

export interface Verdict {
  outcome: string;
  reason: string;
}

export const ACTIVE_KEY = 'catalog:active';
export const PREVIOUS_KEY = 'catalog:previous';
export const PIN_TTL_S = 6 * 3600;

/** The candidate has no passing validation: nothing was written. */
export class NotValidated extends Error {}

export const versionKey = (cv: string): string => \`catalog:version:\${cv}\`;
export const pinKey = (runId: string): string => \`catalog:pin:\${runId}\`;
export const validationKey = (cv: string): string => \`catalog:validation:\${cv}\`;

/** Make catalog version cv (tool name -> entry) the one agents resolve. */
export async function promote(cv: string, entries: Record<string, Entry>): Promise<void> {
  if ((await redis.hget(validationKey(cv), 'outcome')) !== 'passed') throw new NotValidated(\`catalog version \${cv} has no passing validation\`);
  const fields: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) fields[name] = JSON.stringify(entry);
  await redis.hset(versionKey(cv), fields);
  const current = await redis.get(ACTIVE_KEY);
  if (current !== null && current !== cv) await redis.set(PREVIOUS_KEY, current);
  await redis.set(ACTIVE_KEY, cv);
}

/** Point the catalog back at the version the last promotion replaced; that version, or null. */
export async function rollback(): Promise<string | null> {
  const previous = await redis.get(PREVIOUS_KEY);
  if (previous === null) return null;
  await redis.set(ACTIVE_KEY, previous);
  return previous;
}

/** Keep the run on catalog version cv for the rest of its plan. */
export async function pinRun(runId: string, cv: string): Promise<void> {
  await redis.set(pinKey(runId), cv, 'EX', PIN_TTL_S);
}

/** The entry of tool name in the run's pinned version, else in the active one; null if absent. */
export async function resolve(name: string, runId: string | null = null): Promise<Entry | null> {
  let cv = runId ? await redis.get(pinKey(runId)) : null;
  if (cv === null) cv = await redis.get(ACTIVE_KEY);
  if (cv === null) return null;
  const raw = await redis.hget(versionKey(cv), name);
  return raw === null ? null : (JSON.parse(raw) as Entry);
}

/** Record the sandbox's verdict on candidate cv. */
export async function recordValidation(cv: string, outcome: string, reason: string): Promise<void> {
  await redis.hset(validationKey(cv), {outcome, reason});
}

/** The recorded verdict on cv, or null. */
export async function validation(cv: string): Promise<Verdict | null> {
  const raw = await redis.hgetall(validationKey(cv));
  return Object.keys(raw).length === 0 ? null : {outcome: raw.outcome ?? '', reason: raw.reason ?? ''};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'toolsd/store/store.go': `// Package store is the tool store (provided): every registered tool version is a Redis hash
// tool:{name}:{version} with name, version, side_effect, owner, schema (a JSON document), endpoint
// and credential_ref. tenant:{tenant}:tools is the set of tool names a tenant's agents may
// resolve; tools:outbox holds the lifecycle records ({topic, key, value}) a relay republishes after
// the broker refused them. A Row is a JSON object: schema decoded, the other fields strings.
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// OutboxKey is the list the relay republishes from.
const OutboxKey = "tools:outbox"

// Row is one stored tool version.
type Row = map[string]any

var fields = []string{"name", "version", "side_effect", "owner", "schema", "endpoint", "credential_ref"}

// ToolKey is the hash of one tool version.
func ToolKey(name, version string) string {
	return "tool:" + name + ":" + version
}

func encode(name, version string, row Row) map[string]any {
	out := map[string]any{}
	for _, f := range fields {
		switch f {
		case "name":
			out[f] = name
		case "version":
			out[f] = version
		case "schema":
			schema := row["schema"]
			if schema == nil {
				schema = map[string]any{}
			}
			raw, _ := json.Marshal(schema)
			out[f] = string(raw)
		default:
			if v, ok := row[f]; ok && v != nil {
				out[f] = fmt.Sprint(v)
			} else {
				out[f] = ""
			}
		}
	}
	return out
}

// Get is the tool version stored under (name, version), or nil.
func Get(ctx context.Context, name, version string) (Row, error) {
	raw, err := rdb.HGetAll(ctx, ToolKey(name, version)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	row := Row{}
	for k, v := range raw {
		row[k] = v
	}
	var schema map[string]any
	json.Unmarshal([]byte(raw["schema"]), &schema)
	row["schema"] = schema
	return row, nil
}

// Put is the bulk importer's writer: it stores row under (name, version), replacing whatever is there.
func Put(ctx context.Context, name, version string, row Row) error {
	return rdb.HSet(ctx, ToolKey(name, version), encode(name, version, row)).Err()
}

// Insert stores row under (name, version) only if that version is new; false when it already exists.
func Insert(ctx context.Context, name, version string, row Row) (bool, error) {
	created, err := rdb.HSetNX(ctx, ToolKey(name, version), "name", name).Result()
	if err != nil || !created {
		return false, err
	}
	return true, rdb.HSet(ctx, ToolKey(name, version), encode(name, version, row)).Err()
}

// Allowlist is the set of tool names the tenant's agents may resolve.
func Allowlist(ctx context.Context, tenant string) (map[string]bool, error) {
	names, err := rdb.SMembers(ctx, "tenant:"+tenant+":tools").Result()
	out := map[string]bool{}
	for _, n := range names {
		out[n] = true
	}
	return out, err
}

// Grant adds tools to the tenant's allowlist.
func Grant(ctx context.Context, tenant string, names ...string) error {
	members := make([]any, len(names))
	for i, n := range names {
		members[i] = n
	}
	return rdb.SAdd(ctx, "tenant:"+tenant+":tools", members...).Err()
}

// ToOutbox parks a record the broker refused; the relay republishes it.
func ToOutbox(ctx context.Context, topic, key, value string) error {
	raw, _ := json.Marshal(map[string]string{"topic": topic, "key": key, "value": value})
	return rdb.RPush(ctx, OutboxKey, string(raw)).Err()
}
`,
  'toolsd/catalog/catalog.go': `// Package catalog is the catalog (provided; step 2 builds promote, rollback, pinRun and resolve
// the same way): catalog:version:{cv} is one hash per catalog version, one field per tool holding
// its entry (the stored tool row) as JSON. catalog:active names the version agents resolve,
// catalog:previous the one the last promotion replaced, catalog:pin:{run_id} the version a run
// started on (6-hour TTL). catalog:validation:{cv} is the sandbox's verdict on a candidate version:
// outcome (passed, rejected or unavailable) and reason. Promote refuses a version whose outcome is
// not passed.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ActiveKey   = "catalog:active"
	PreviousKey = "catalog:previous"
	PinTTL      = 6 * time.Hour
)

// ErrNotValidated: the candidate has no passing validation, nothing was written.
var ErrNotValidated = errors.New("catalog version has no passing validation")

// Entry is one tool of a catalog version.
type Entry = map[string]any

func VersionKey(cv string) string    { return "catalog:version:" + cv }
func PinKey(runID string) string     { return "catalog:pin:" + runID }
func ValidationKey(cv string) string { return "catalog:validation:" + cv }

// Promote makes catalog version cv (tool name -> entry) the one agents resolve.
func Promote(ctx context.Context, cv string, entries map[string]Entry) error {
	if rdb.HGet(ctx, ValidationKey(cv), "outcome").Val() != "passed" {
		return ErrNotValidated
	}
	fields := map[string]any{}
	for name, entry := range entries {
		raw, _ := json.Marshal(entry)
		fields[name] = string(raw)
	}
	if err := rdb.HSet(ctx, VersionKey(cv), fields).Err(); err != nil {
		return err
	}
	current, err := rdb.Get(ctx, ActiveKey).Result()
	if err == nil && current != cv {
		if err := rdb.Set(ctx, PreviousKey, current, 0).Err(); err != nil {
			return err
		}
	}
	return rdb.Set(ctx, ActiveKey, cv, 0).Err()
}

// Rollback points the catalog back at the version the last promotion replaced; that version, or "".
func Rollback(ctx context.Context) (string, error) {
	previous, err := rdb.Get(ctx, PreviousKey).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return previous, rdb.Set(ctx, ActiveKey, previous, 0).Err()
}

// PinRun keeps the run on catalog version cv for the rest of its plan.
func PinRun(ctx context.Context, runID, cv string) error {
	return rdb.Set(ctx, PinKey(runID), cv, PinTTL).Err()
}

// Resolve is the entry of tool name in the run's pinned version ("" : none), else in the active one; nil if absent.
func Resolve(ctx context.Context, name, runID string) (Entry, error) {
	cv := ""
	if runID != "" {
		cv = rdb.Get(ctx, PinKey(runID)).Val()
	}
	if cv == "" {
		cv = rdb.Get(ctx, ActiveKey).Val()
	}
	if cv == "" {
		return nil, nil
	}
	raw, err := rdb.HGet(ctx, VersionKey(cv), name).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entry Entry
	return entry, json.Unmarshal([]byte(raw), &entry)
}

// RecordValidation records the sandbox's verdict on candidate cv.
func RecordValidation(ctx context.Context, cv, outcome, reason string) error {
	return rdb.HSet(ctx, ValidationKey(cv), "outcome", outcome, "reason", reason).Err()
}

// Validation is the recorded verdict on cv (outcome, reason), or nil.
func Validation(ctx context.Context, cv string) (map[string]string, error) {
	raw, err := rdb.HGetAll(ctx, ValidationKey(cv)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	return raw, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'toolsd/store.h': `// The tool store (provided): every registered tool version is a Redis hash tool:{name}:{version}
// with name, version, side_effect, owner, schema (a JSON document), endpoint and credential_ref.
// tenant:{tenant}:tools is the set of tool names a tenant's agents may resolve; tools:outbox holds
// the lifecycle records ({topic, key, value}) a relay republishes after the broker refused them. A
// row is a JSON object: schema decoded, the other fields strings.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::string kOutboxKey = "tools:outbox";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string toolKey(const std::string& name, const std::string& version) { return "tool:" + name + ":" + version; }

inline std::unordered_map<std::string, std::string> encode(const std::string& name, const std::string& version,
                                                           const nlohmann::json& row) {
  const auto text = [&row](const char* f) { return row.contains(f) && row[f].is_string() ? row[f].get<std::string>() : std::string(); };
  return {{"name", name},
          {"version", version},
          {"side_effect", text("side_effect")},
          {"owner", text("owner")},
          {"schema", row.contains("schema") ? row["schema"].dump() : "{}"},
          {"endpoint", text("endpoint")},
          {"credential_ref", text("credential_ref")}};
}

// The tool version stored under (name, version), or none.
inline std::optional<nlohmann::json> get(const std::string& name, const std::string& version) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(toolKey(name, version), std::inserter(raw, raw.end()));
  if (raw.empty()) return std::nullopt;
  nlohmann::json row = nlohmann::json::object();
  for (const auto& [k, v] : raw) row[k] = v;
  row["schema"] = nlohmann::json::parse(raw.count("schema") && !raw["schema"].empty() ? raw["schema"] : "{}");
  return row;
}

// The bulk importer's writer: stores row under (name, version), replacing whatever is there.
inline void put(const std::string& name, const std::string& version, const nlohmann::json& row) {
  const auto fields = encode(name, version, row);
  redis().hset(toolKey(name, version), fields.begin(), fields.end());
}

// Stores row under (name, version) only if that version is new; false when it already exists.
inline bool insert(const std::string& name, const std::string& version, const nlohmann::json& row) {
  if (!redis().hsetnx(toolKey(name, version), "name", name)) return false;
  const auto fields = encode(name, version, row);
  redis().hset(toolKey(name, version), fields.begin(), fields.end());
  return true;
}

// The tool names the tenant's agents may resolve.
inline std::set<std::string> allowlist(const std::string& tenant) {
  std::set<std::string> names;
  redis().smembers("tenant:" + tenant + ":tools", std::inserter(names, names.end()));
  return names;
}

// Add tools to the tenant's allowlist.
inline void grant(const std::string& tenant, const std::vector<std::string>& names) {
  redis().sadd("tenant:" + tenant + ":tools", names.begin(), names.end());
}

// Park a record the broker refused; the relay republishes it.
inline void toOutbox(const std::string& topic, const std::string& key, const std::string& value) {
  redis().rpush(kOutboxKey, nlohmann::json{{"topic", topic}, {"key", key}, {"value", value}}.dump());
}

}  // namespace store
`,
  'toolsd/catalog.h': `// The catalog (provided; step 2 builds promote, rollback, pinRun and resolve the same way):
// catalog:version:{cv} is one hash per catalog version, one field per tool holding its entry (the
// stored tool row) as JSON. catalog:active names the version agents resolve, catalog:previous the
// one the last promotion replaced, catalog:pin:{run_id} the version a run started on (6-hour TTL).
// catalog:validation:{cv} is the sandbox's verdict on a candidate version: outcome (passed,
// rejected or unavailable) and reason. promote refuses a version whose outcome is not passed.
// Entries are a JSON object: tool name -> entry.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace catalog {

inline const std::string kActiveKey = "catalog:active";
inline const std::string kPreviousKey = "catalog:previous";
inline constexpr std::chrono::hours kPinTtl{6};

// The candidate has no passing validation: nothing was written.
struct NotValidated : std::runtime_error {
  using std::runtime_error::runtime_error;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string versionKey(const std::string& cv) { return "catalog:version:" + cv; }
inline std::string pinKey(const std::string& run_id) { return "catalog:pin:" + run_id; }
inline std::string validationKey(const std::string& cv) { return "catalog:validation:" + cv; }

// Make catalog version cv (tool name -> entry) the one agents resolve.
inline void promote(const std::string& cv, const nlohmann::json& entries) {
  if (redis().hget(validationKey(cv), "outcome").value_or("") != "passed") {
    throw NotValidated("catalog version " + cv + " has no passing validation");
  }
  std::unordered_map<std::string, std::string> fields;
  for (const auto& [name, entry] : entries.items()) fields[name] = entry.dump();
  redis().hset(versionKey(cv), fields.begin(), fields.end());
  const auto current = redis().get(kActiveKey);
  if (current && *current != cv) redis().set(kPreviousKey, *current);
  redis().set(kActiveKey, cv);
}

// Point the catalog back at the version the last promotion replaced; that version, or none.
inline std::optional<std::string> rollback() {
  const auto previous = redis().get(kPreviousKey);
  if (!previous) return std::nullopt;
  redis().set(kActiveKey, *previous);
  return *previous;
}

// Keep the run on catalog version cv for the rest of its plan.
inline void pinRun(const std::string& run_id, const std::string& cv) { redis().set(pinKey(run_id), cv, kPinTtl); }

// The entry of tool name in the run's pinned version ("": none), else in the active one; none if absent.
inline std::optional<nlohmann::json> resolve(const std::string& name, const std::string& run_id = "") {
  std::optional<std::string> cv;
  if (!run_id.empty()) cv = redis().get(pinKey(run_id));
  if (!cv) cv = redis().get(kActiveKey);
  if (!cv) return std::nullopt;
  const auto raw = redis().hget(versionKey(*cv), name);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record the sandbox's verdict on candidate cv.
inline void recordValidation(const std::string& cv, const std::string& outcome, const std::string& reason) {
  redis().hset(validationKey(cv), {{"outcome", outcome}, {"reason", reason}});
}

// The recorded verdict on cv (outcome, reason), or none.
inline std::optional<std::map<std::string, std::string>> validation(const std::string& cv) {
  std::map<std::string, std::string> raw;
  redis().hgetall(validationKey(cv), std::inserter(raw, raw.end()));
  if (raw.empty()) return std::nullopt;
  return raw;
}

}  // namespace catalog
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('toolsd', 'Store')]: `package toolsd

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The tool store (provided): every registered tool version is a Redis hash tool:{name}:{version}
 * with name, version, side_effect, owner, schema (a JSON document), endpoint and credential_ref.
 * tenant:{tenant}:tools is the set of tool names a tenant's agents may resolve; tools:outbox holds
 * the lifecycle records ({topic, key, value}) a relay republishes after the broker refused them. A
 * row is a JSON object: schema decoded, the other fields strings.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  val OutboxKey = "tools:outbox"
  val Fields: Seq[String] = Seq("name", "version", "side_effect", "owner", "schema", "endpoint", "credential_ref")

  def toolKey(name: String, version: String): String = s"tool:$name:$version"

  private def encode(name: String, version: String, row: JsObject): Map[String, String] =
    Fields.map {
      case "name"    => "name" -> name
      case "version" => "version" -> version
      case "schema"  => "schema" -> row.fields.getOrElse("schema", JsObject.empty).compactPrint
      case f         => f -> (row.fields.get(f) match { case Some(JsString(s)) => s; case _ => "" })
    }.toMap

  /** The tool version stored under (name, version), if any. */
  def get(name: String, version: String): Option[JsObject] = {
    val raw = jedis.hgetAll(toolKey(name, version)).asScala.toMap
    if (raw.isEmpty) None
    else Some(JsObject(raw.map { case (k, v) => k -> (if (k == "schema") v.parseJson else JsString(v)) }))
  }

  /** The bulk importer's writer: stores row under (name, version), replacing whatever is there. */
  def put(name: String, version: String, row: JsObject): Unit = jedis.hset(toolKey(name, version), encode(name, version, row).asJava)

  /** Stores row under (name, version) only if that version is new; false when it already exists. */
  def insert(name: String, version: String, row: JsObject): Boolean =
    if (jedis.hsetnx(toolKey(name, version), "name", name) == 0L) false
    else {
      jedis.hset(toolKey(name, version), encode(name, version, row).asJava)
      true
    }

  /** The tool names the tenant's agents may resolve. */
  def allowlist(tenant: String): Set[String] = jedis.smembers(s"tenant:$tenant:tools").asScala.toSet

  /** Add tools to the tenant's allowlist. */
  def grant(tenant: String, names: String*): Unit = jedis.sadd(s"tenant:$tenant:tools", names: _*)

  /** Park a record the broker refused; the relay republishes it. */
  def toOutbox(topic: String, key: String, value: String): Unit =
    jedis.rpush(OutboxKey, JsObject("topic" -> JsString(topic), "key" -> JsString(key), "value" -> JsString(value)).compactPrint)
}
`,
  [scalaPath('toolsd', 'Catalog')]: `package toolsd

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The catalog (provided; step 2 builds promote, rollback, pinRun and resolve the same way):
 * catalog:version:{cv} is one hash per catalog version, one field per tool holding its entry (the
 * stored tool row) as JSON. catalog:active names the version agents resolve, catalog:previous the
 * one the last promotion replaced, catalog:pin:{run_id} the version a run started on (6-hour TTL).
 * catalog:validation:{cv} is the sandbox's verdict on a candidate version: outcome (passed,
 * rejected or unavailable) and reason. promote refuses a version whose outcome is not passed.
 */
object Catalog {
  val jedis = new JedisPooled("redis", 6379)

  val ActiveKey = "catalog:active"
  val PreviousKey = "catalog:previous"
  val PinTtlSeconds: Long = 6L * 3600

  /** The candidate has no passing validation: nothing was written. */
  final class NotValidated(message: String) extends Exception(message)

  def versionKey(cv: String): String = s"catalog:version:$cv"
  def pinKey(runId: String): String = s"catalog:pin:$runId"
  def validationKey(cv: String): String = s"catalog:validation:$cv"

  /** Make catalog version cv (tool name -> entry) the one agents resolve. */
  def promote(cv: String, entries: Map[String, JsObject]): Unit = {
    if (!Option(jedis.hget(validationKey(cv), "outcome")).contains("passed"))
      throw new NotValidated(s"catalog version $cv has no passing validation")
    jedis.hset(versionKey(cv), entries.map { case (name, entry) => name -> entry.compactPrint }.asJava)
    Option(jedis.get(ActiveKey)).filter(_ != cv).foreach(current => jedis.set(PreviousKey, current))
    jedis.set(ActiveKey, cv)
  }

  /** Point the catalog back at the version the last promotion replaced; that version, if any. */
  def rollback(): Option[String] =
    Option(jedis.get(PreviousKey)).map { previous =>
      jedis.set(ActiveKey, previous)
      previous
    }

  /** Keep the run on catalog version cv for the rest of its plan. */
  def pinRun(runId: String, cv: String): Unit = jedis.setex(pinKey(runId), PinTtlSeconds, cv)

  /** The entry of tool name in the run's pinned version, else in the active one. */
  def resolve(name: String, runId: Option[String] = None): Option[JsObject] =
    runId
      .flatMap(id => Option(jedis.get(pinKey(id))))
      .orElse(Option(jedis.get(ActiveKey)))
      .flatMap(cv => Option(jedis.hget(versionKey(cv), name)))
      .map(_.parseJson.asJsObject)

  /** Record the sandbox's verdict on candidate cv. */
  def recordValidation(cv: String, outcome: String, reason: String): Unit =
    jedis.hset(validationKey(cv), Map("outcome" -> outcome, "reason" -> reason).asJava)

  /** The recorded verdict on cv (outcome, reason), if any. */
  def validation(cv: String): Option[Map[String, String]] = {
    val raw = jedis.hgetAll(validationKey(cv)).asScala.toMap
    if (raw.isEmpty) None else Some(raw)
  }
}
`,
};
