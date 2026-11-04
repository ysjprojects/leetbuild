/**
 * Hand-written support modules the feature-flags steps import but no step builds: the `flags`
 * package. `flags.registry` is the schema registry (the user attributes a rule may target and the
 * operators each type allows, with the rule matcher); `flags.hashing` is FNV-1a, the hash bucketing
 * is defined on; `flags.store` is the flag definitions store (every save a new version, plus the
 * recorded answers of create actions); `flags.engine` is the snapshot and evaluation of step 2 as
 * the later steps use it. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'flags/__init__.py': '',
  'flags/registry.py': `"""
The schema registry (provided): ATTRIBUTES are the user attributes a rule may target, each with its
type; OPERATORS the operators each type allows. rule_error names what is wrong with a rule (None
when the registry accepts it). rule_matches evaluates an accepted rule against a user's attributes
(name -> text): eq/neq compare text, in looks the text up in a list, gt/lt compare numbers; an
attribute the user does not carry matches nothing.
"""
ATTRIBUTES = {"user_id": "string", "country": "string", "email_domain": "string", "app_version": "number"}
OPERATORS = {"string": ("eq", "neq", "in"), "number": ("eq", "gt", "lt")}


def rule_error(rule: dict) -> str | None:
    """Why the registry refuses the rule {attribute, operator, value}, or None when it accepts it."""
    kind = ATTRIBUTES.get(rule.get("attribute"))
    if kind is None:
        return f"unknown attribute {rule.get('attribute')!r}"
    if rule.get("operator") not in OPERATORS[kind]:
        return f"operator {rule.get('operator')!r} is not defined for the {kind} attribute {rule['attribute']!r}"
    return None


def rule_matches(rule: dict, attrs: dict) -> bool:
    """Whether the user with these attributes satisfies the rule."""
    actual = attrs.get(rule["attribute"])
    if actual is None:
        return False
    operator, expected = rule["operator"], rule["value"]
    if operator == "in":
        return isinstance(expected, list) and actual in [str(v) for v in expected]
    if ATTRIBUTES.get(rule["attribute"]) == "number":
        try:
            a, e = float(actual), float(expected)
        except (TypeError, ValueError):
            return False
        return (operator == "eq" and a == e) or (operator == "gt" and a > e) or (operator == "lt" and a < e)
    if operator == "eq":
        return actual == str(expected)
    if operator == "neq":
        return actual != str(expected)
    return False
`,
  'flags/hashing.py': `"""FNV-1a, 32 bits, over the UTF-8 bytes of a text (provided): the hash bucketing is defined on."""


def fnv1a32(text: str) -> int:
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h
`,
  'flags/store.py': `"""
The flag definitions store (provided): every save of a flag is a new version. flag:{key}:v{n} holds
version n as one JSON document (key, version, default, rules, rollout, salt; the salt is the key
unless the definition names one) and flag:{key}:version the latest n. flag:{key}:create:{idempotency
key} holds what a create answered, for its replays.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def save(definition: dict) -> dict:
    """Store definition (key, default, rules, rollout) as the flag's next version; returns the stored document."""
    key = definition["key"]
    n = r.incr(f"flag:{key}:version")
    doc = {
        "key": key,
        "version": n,
        "default": definition["default"],
        "rules": list(definition.get("rules") or []),
        "rollout": int(definition.get("rollout") or 0),
        "salt": definition.get("salt") or key,
    }
    r.set(f"flag:{key}:v{n}", json.dumps(doc))
    return doc


def load(key: str) -> dict | None:
    """The latest version of the flag, or None."""
    n = r.get(f"flag:{key}:version")
    if n is None:
        return None
    raw = r.get(f"flag:{key}:v{n}")
    return json.loads(raw) if raw else None


def create_result(key: str, idempotency_key: str) -> dict | None:
    """What the create (key, idempotency_key) answered, if it ran."""
    raw = r.get(f"flag:{key}:create:{idempotency_key}")
    return json.loads(raw) if raw else None


def record_create(key: str, idempotency_key: str, result: dict) -> None:
    """Record what the create (key, idempotency_key) answered, for its replays."""
    r.set(f"flag:{key}:create:{idempotency_key}", json.dumps(result))
`,
  'flags/engine.py': `"""
The snapshot and evaluation (provided; step 2 builds the same four functions). flags:snapshot holds
the whole rule set as one JSON document {"version": n, "flags": {key: {default, rules, rollout, salt,
killed}}}; flags:snapshot:version its version. publish_snapshot replaces both in one Lua script only
when the new version is newer, and reports whether it did. read_snapshot is one GET. bucket(flag_key,
user_id, salt) is fnv1a32(f"{salt}.{flag_key}.{user_id}") % 100. evaluate reads the snapshot once and
answers {flag_key, value, reason, bucket, version}: killed -> default; a rule the user does not match
-> default (no-match); bucket < rollout -> True (in-rollout); else default (out-of-rollout).
"""
import json

import redis

from flags.hashing import fnv1a32
from flags.registry import rule_matches

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SNAPSHOT_KEY = "flags:snapshot"
VERSION_KEY = "flags:snapshot:version"
SWAP_LUA = """
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
"""
swap = r.register_script(SWAP_LUA)


def publish_snapshot(snapshot: dict) -> bool:
    """Make snapshot the one evaluations read, unless a snapshot at least as new is already there."""
    return swap(keys=[SNAPSHOT_KEY, VERSION_KEY], args=[json.dumps(snapshot), snapshot["version"]]) == 1


def read_snapshot() -> dict | None:
    """The whole rule set, read with one GET."""
    raw = r.get(SNAPSHOT_KEY)
    return json.loads(raw) if raw else None


def bucket(flag_key: str, user_id: str, salt: str) -> int:
    return fnv1a32(f"{salt}.{flag_key}.{user_id}") % 100


def evaluate(flag_key: str, attrs: dict) -> dict | None:
    """The decision for the user with these attributes (user_id among them), or None for an unknown flag."""
    snapshot = read_snapshot()
    flag = None if snapshot is None else snapshot["flags"].get(flag_key)
    if flag is None:
        return None
    b = bucket(flag_key, attrs.get("user_id", ""), flag["salt"])
    if flag.get("killed"):
        value, reason = flag["default"], "killed"
    elif not all(rule_matches(rule, attrs) for rule in flag["rules"]):
        value, reason = flag["default"], "no-match"
    elif b < flag["rollout"]:
        value, reason = True, "in-rollout"
    else:
        value, reason = flag["default"], "out-of-rollout"
    return {"flag_key": flag_key, "value": value, "reason": reason, "bucket": b, "version": snapshot["version"]}
`,
};

export const supportModulesTs: Record<string, string> = {
  'flags/registry.ts': `/**
 * The schema registry (provided): ATTRIBUTES are the user attributes a rule may target, each with its
 * type; OPERATORS the operators each type allows. ruleError names what is wrong with a rule (null
 * when the registry accepts it). ruleMatches evaluates an accepted rule against a user's attributes
 * (name -> text): eq/neq compare text, in looks the text up in a list, gt/lt compare numbers; an
 * attribute the user does not carry matches nothing.
 */
export interface Rule {
  attribute: string;
  operator: string;
  value: unknown;
}

export const ATTRIBUTES: Record<string, string> = {user_id: 'string', country: 'string', email_domain: 'string', app_version: 'number'};
export const OPERATORS: Record<string, string[]> = {string: ['eq', 'neq', 'in'], number: ['eq', 'gt', 'lt']};

/** Why the registry refuses the rule, or null when it accepts it. */
export function ruleError(rule: Rule): string | null {
  const kind = Object.hasOwn(ATTRIBUTES, rule.attribute) ? ATTRIBUTES[rule.attribute] : undefined;
  if (kind === undefined) return \`unknown attribute \${JSON.stringify(rule.attribute)}\`;
  if (!OPERATORS[kind].includes(rule.operator)) return \`operator \${JSON.stringify(rule.operator)} is not defined for the \${kind} attribute \${JSON.stringify(rule.attribute)}\`;
  return null;
}

/** Whether the user with these attributes satisfies the rule. */
export function ruleMatches(rule: Rule, attrs: Record<string, string>): boolean {
  const actual = attrs[rule.attribute];
  if (actual === undefined) return false;
  if (rule.operator === 'in') return Array.isArray(rule.value) && rule.value.map(String).includes(actual);
  if (ATTRIBUTES[rule.attribute] === 'number') {
    const a = Number(actual);
    const e = Number(rule.value);
    if (Number.isNaN(a) || Number.isNaN(e)) return false;
    return (rule.operator === 'eq' && a === e) || (rule.operator === 'gt' && a > e) || (rule.operator === 'lt' && a < e);
  }
  if (rule.operator === 'eq') return actual === String(rule.value);
  if (rule.operator === 'neq') return actual !== String(rule.value);
  return false;
}
`,
  'flags/hashing.ts': `/** FNV-1a, 32 bits, over the UTF-8 bytes of a text (provided): the hash bucketing is defined on. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
`,
  'flags/store.ts': `/**
 * The flag definitions store (provided): every save of a flag is a new version. flag:{key}:v{n}
 * holds version n as one JSON document (key, version, default, rules, rollout, salt; the salt is the
 * key unless the definition names one) and flag:{key}:version the latest n.
 * flag:{key}:create:{idempotency key} holds what a create answered, for its replays.
 */
import Redis from 'ioredis';

import type {Rule} from 'flags/registry';

const redis = new Redis({host: 'redis', port: 6379});

export interface Definition {
  key: string;
  version: number;
  default: boolean;
  rules: Rule[];
  rollout: number;
  salt: string;
}

export type NewDefinition = Pick<Definition, 'key' | 'default'> & Partial<Pick<Definition, 'rules' | 'rollout' | 'salt'>>;

/** Store the definition as the flag's next version; returns the stored document. */
export async function save(definition: NewDefinition): Promise<Definition> {
  const n = await redis.incr(\`flag:\${definition.key}:version\`);
  const doc: Definition = {
    key: definition.key,
    version: n,
    default: definition.default,
    rules: [...(definition.rules ?? [])],
    rollout: Number(definition.rollout ?? 0),
    salt: definition.salt || definition.key,
  };
  await redis.set(\`flag:\${definition.key}:v\${n}\`, JSON.stringify(doc));
  return doc;
}

/** The latest version of the flag, or null. */
export async function load(key: string): Promise<Definition | null> {
  const n = await redis.get(\`flag:\${key}:version\`);
  if (n === null) return null;
  const raw = await redis.get(\`flag:\${key}:v\${n}\`);
  return raw === null ? null : (JSON.parse(raw) as Definition);
}

/** What the create (key, idempotencyKey) answered, if it ran. */
export async function createResult(key: string, idempotencyKey: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`flag:\${key}:create:\${idempotencyKey}\`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Record what the create (key, idempotencyKey) answered, for its replays. */
export async function recordCreate(key: string, idempotencyKey: string, result: Record<string, unknown>): Promise<void> {
  await redis.set(\`flag:\${key}:create:\${idempotencyKey}\`, JSON.stringify(result));
}
`,
  'flags/engine.ts': `/**
 * The snapshot and evaluation (provided; step 2 builds the same four functions). flags:snapshot
 * holds the whole rule set as one JSON document {version, flags: {key: {default, rules, rollout,
 * salt, killed}}}; flags:snapshot:version its version. publishSnapshot replaces both in one Lua
 * script only when the new version is newer, and reports whether it did. readSnapshot is one GET.
 * bucket(flagKey, userId, salt) is fnv1a32(\`\${salt}.\${flagKey}.\${userId}\`) % 100. evaluate reads
 * the snapshot once and answers {flag_key, value, reason, bucket, version}: killed -> default; a rule
 * the user does not match -> default (no-match); bucket < rollout -> true (in-rollout); else default
 * (out-of-rollout).
 */
import Redis from 'ioredis';

import {fnv1a32} from 'flags/hashing';
import {type Rule, ruleMatches} from 'flags/registry';

export interface Flag {
  default: boolean;
  rules: Rule[];
  rollout: number;
  salt: string;
  killed: boolean;
}

export interface Snapshot {
  version: number;
  flags: Record<string, Flag>;
}

export interface Decision {
  flag_key: string;
  value: boolean;
  reason: string;
  bucket: number;
  version: number;
}

export const SNAPSHOT_KEY = 'flags:snapshot';
export const VERSION_KEY = 'flags:snapshot:version';
export const SWAP_LUA = \`
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
\`;

interface SwapRedis extends Redis {
  swapSnapshot(snapshotKey: string, versionKey: string, doc: string, version: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SwapRedis;
redis.defineCommand('swapSnapshot', {numberOfKeys: 2, lua: SWAP_LUA});

/** Make snapshot the one evaluations read, unless a snapshot at least as new is already there. */
export async function publishSnapshot(snapshot: Snapshot): Promise<boolean> {
  return (await redis.swapSnapshot(SNAPSHOT_KEY, VERSION_KEY, JSON.stringify(snapshot), snapshot.version)) === 1;
}

/** The whole rule set, read with one GET. */
export async function readSnapshot(): Promise<Snapshot | null> {
  const raw = await redis.get(SNAPSHOT_KEY);
  return raw === null ? null : (JSON.parse(raw) as Snapshot);
}

export function bucket(flagKey: string, userId: string, salt: string): number {
  return fnv1a32(\`\${salt}.\${flagKey}.\${userId}\`) % 100;
}

/** The decision for the user with these attributes (user_id among them), or null for an unknown flag. */
export async function evaluate(flagKey: string, attrs: Record<string, string>): Promise<Decision | null> {
  const snapshot = await readSnapshot();
  const flag = snapshot === null || !Object.hasOwn(snapshot.flags, flagKey) ? undefined : snapshot.flags[flagKey];
  if (snapshot === null || flag === undefined) return null;
  const b = bucket(flagKey, attrs.user_id ?? '', flag.salt);
  let value = flag.default;
  let reason = 'out-of-rollout';
  if (flag.killed) reason = 'killed';
  else if (!flag.rules.every(rule => ruleMatches(rule, attrs))) reason = 'no-match';
  else if (b < flag.rollout) [value, reason] = [true, 'in-rollout'];
  return {flag_key: flagKey, value, reason, bucket: b, version: snapshot.version};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'flags/registry/registry.go': `// Package registry is the schema registry (provided): Attributes are the user attributes a rule
// may target, each with its type; Operators the operators each type allows. RuleError names what is
// wrong with a rule ("" when the registry accepts it). RuleMatches evaluates an accepted rule
// against a user's attributes (name -> text): eq/neq compare text, in looks the text up in a list,
// gt/lt compare numbers; an attribute the user does not carry matches nothing.
package registry

import (
	"fmt"
	"strconv"
)

// Rule is one targeting condition of a flag; Value is a string, a number or a list (as JSON decodes it).
type Rule struct {
	Attribute string \`json:"attribute"\`
	Operator  string \`json:"operator"\`
	Value     any    \`json:"value"\`
}

var Attributes = map[string]string{"user_id": "string", "country": "string", "email_domain": "string", "app_version": "number"}

var Operators = map[string][]string{"string": {"eq", "neq", "in"}, "number": {"eq", "gt", "lt"}}

func text(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

// RuleError is why the registry refuses the rule, or "" when it accepts it.
func RuleError(rule Rule) string {
	kind, known := Attributes[rule.Attribute]
	if !known {
		return fmt.Sprintf("unknown attribute %q", rule.Attribute)
	}
	for _, op := range Operators[kind] {
		if op == rule.Operator {
			return ""
		}
	}
	return fmt.Sprintf("operator %q is not defined for the %s attribute %q", rule.Operator, kind, rule.Attribute)
}

// RuleMatches reports whether the user with these attributes satisfies the rule.
func RuleMatches(rule Rule, attrs map[string]string) bool {
	actual, ok := attrs[rule.Attribute]
	if !ok {
		return false
	}
	if rule.Operator == "in" {
		list, isList := rule.Value.([]any)
		if !isList {
			return false
		}
		for _, v := range list {
			if text(v) == actual {
				return true
			}
		}
		return false
	}
	if Attributes[rule.Attribute] == "number" {
		a, errA := strconv.ParseFloat(actual, 64)
		e, errE := strconv.ParseFloat(text(rule.Value), 64)
		if errA != nil || errE != nil {
			return false
		}
		return (rule.Operator == "eq" && a == e) || (rule.Operator == "gt" && a > e) || (rule.Operator == "lt" && a < e)
	}
	switch rule.Operator {
	case "eq":
		return actual == text(rule.Value)
	case "neq":
		return actual != text(rule.Value)
	}
	return false
}
`,
  'flags/hashing/hashing.go': `// Package hashing is FNV-1a, 32 bits, over the UTF-8 bytes of a text (provided): the hash
// bucketing is defined on.
package hashing

// Fnv1a32 hashes text.
func Fnv1a32(text string) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range []byte(text) {
		h ^= uint32(b)
		h *= 0x01000193
	}
	return h
}
`,
  'flags/store/store.go': `// Package store is the flag definitions store (provided): every save of a flag is a new version.
// flag:{key}:v{n} holds version n as one JSON document (key, version, default, rules, rollout,
// salt; the salt is the key unless the definition names one) and flag:{key}:version the latest n.
// flag:{key}:create:{idempotency key} holds what a create answered, for its replays.
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"

	"flags/registry"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Definition is one version of a flag.
type Definition struct {
	Key     string          \`json:"key"\`
	Version int64           \`json:"version"\`
	Default bool            \`json:"default"\`
	Rules   []registry.Rule \`json:"rules"\`
	Rollout int             \`json:"rollout"\`
	Salt    string          \`json:"salt"\`
}

// Save stores the definition (Key, Default, Rules, Rollout) as the flag's next version and returns
// the stored document.
func Save(ctx context.Context, d Definition) (Definition, error) {
	n, err := rdb.Incr(ctx, "flag:"+d.Key+":version").Result()
	if err != nil {
		return Definition{}, err
	}
	d.Version = n
	if d.Salt == "" {
		d.Salt = d.Key
	}
	if d.Rules == nil {
		d.Rules = []registry.Rule{}
	}
	raw, _ := json.Marshal(d)
	return d, rdb.Set(ctx, fmt.Sprintf("flag:%s:v%d", d.Key, n), raw, 0).Err()
}

// Load is the latest version of the flag, or nil.
func Load(ctx context.Context, key string) *Definition {
	n, err := rdb.Get(ctx, "flag:"+key+":version").Result()
	if err != nil {
		return nil
	}
	raw, err := rdb.Get(ctx, "flag:"+key+":v"+n).Result()
	if err != nil {
		return nil
	}
	var d Definition
	if json.Unmarshal([]byte(raw), &d) != nil {
		return nil
	}
	return &d
}

// CreateResult is what the create (key, idempotencyKey) answered, or nil if it never ran.
func CreateResult(ctx context.Context, key, idempotencyKey string) map[string]any {
	raw, err := rdb.Get(ctx, "flag:"+key+":create:"+idempotencyKey).Result()
	if err != nil {
		return nil
	}
	var result map[string]any
	json.Unmarshal([]byte(raw), &result)
	return result
}

// RecordCreate records what the create (key, idempotencyKey) answered, for its replays.
func RecordCreate(ctx context.Context, key, idempotencyKey string, result map[string]any) {
	raw, _ := json.Marshal(result)
	rdb.Set(ctx, "flag:"+key+":create:"+idempotencyKey, raw, 0)
}
`,
  'flags/engine/engine.go': `// Package engine is the snapshot and evaluation (provided; step 2 builds the same four functions).
// flags:snapshot holds the whole rule set as one JSON document {version, flags: {key: {default,
// rules, rollout, salt, killed}}}; flags:snapshot:version its version. PublishSnapshot replaces both
// in one Lua script only when the new version is newer, and reports whether it did. ReadSnapshot is
// one GET. Bucket(flagKey, userID, salt) is Fnv1a32(salt + "." + flagKey + "." + userID) % 100.
// Evaluate reads the snapshot once: killed -> Default; a rule the user does not match -> Default
// (no-match); bucket < Rollout -> true (in-rollout); else Default (out-of-rollout).
package engine

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"flags/hashing"
	"flags/registry"
)

const (
	SnapshotKey = "flags:snapshot"
	VersionKey  = "flags:snapshot:version"
)

// Flag is one flag as evaluations see it.
type Flag struct {
	Default bool            \`json:"default"\`
	Rules   []registry.Rule \`json:"rules"\`
	Rollout int             \`json:"rollout"\`
	Salt    string          \`json:"salt"\`
	Killed  bool            \`json:"killed"\`
}

// Snapshot is the whole rule set at one version.
type Snapshot struct {
	Version int64           \`json:"version"\`
	Flags   map[string]Flag \`json:"flags"\`
}

// Decision is what one evaluation served.
type Decision struct {
	FlagKey string \`json:"flag_key"\`
	Value   bool   \`json:"value"\`
	Reason  string \`json:"reason"\`
	Bucket  int    \`json:"bucket"\`
	Version int64  \`json:"version"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Swap replaces the snapshot (ARGV[1]) and its version (ARGV[2]) only when that version is newer.
var Swap = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
\`)

// PublishSnapshot makes s the snapshot evaluations read, unless one at least as new is already there.
func PublishSnapshot(ctx context.Context, s Snapshot) (bool, error) {
	raw, _ := json.Marshal(s)
	moved, err := Swap.Run(ctx, rdb, []string{SnapshotKey, VersionKey}, string(raw), s.Version).Int64()
	return moved == 1, err
}

// ReadSnapshot is the whole rule set, read with one GET (nil when none was published).
func ReadSnapshot(ctx context.Context) (*Snapshot, error) {
	raw, err := rdb.Get(ctx, SnapshotKey).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s Snapshot
	return &s, json.Unmarshal([]byte(raw), &s)
}

// Bucket places a user in 0..99 for one flag.
func Bucket(flagKey, userID, salt string) int {
	return int(hashing.Fnv1a32(salt+"."+flagKey+"."+userID) % 100)
}

// Evaluate is the decision for the user with these attributes (user_id among them); nil for an unknown flag.
func Evaluate(ctx context.Context, flagKey string, attrs map[string]string) (*Decision, error) {
	s, err := ReadSnapshot(ctx)
	if err != nil || s == nil {
		return nil, err
	}
	flag, known := s.Flags[flagKey]
	if !known {
		return nil, nil
	}
	d := &Decision{FlagKey: flagKey, Value: flag.Default, Reason: "out-of-rollout", Bucket: Bucket(flagKey, attrs["user_id"], flag.Salt), Version: s.Version}
	matched := true
	for _, rule := range flag.Rules {
		if !registry.RuleMatches(rule, attrs) {
			matched = false
		}
	}
	switch {
	case flag.Killed:
		d.Reason = "killed"
	case !matched:
		d.Reason = "no-match"
	case d.Bucket < flag.Rollout:
		d.Value, d.Reason = true, "in-rollout"
	}
	return d, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'flags/registry.h': `// The schema registry (provided): kAttributes are the user attributes a rule may target, each with
// its type; kOperators the operators each type allows. ruleError names what is wrong with a rule
// ("" when the registry accepts it). ruleMatches evaluates an accepted rule against a user's
// attributes (name -> text): eq/neq compare text, in looks the text up in a list, gt/lt compare
// numbers; an attribute the user does not carry matches nothing.
#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace registry {

inline const std::map<std::string, std::string> kAttributes = {
    {"user_id", "string"}, {"country", "string"}, {"email_domain", "string"}, {"app_version", "number"}};
inline const std::map<std::string, std::vector<std::string>> kOperators = {{"string", {"eq", "neq", "in"}},
                                                                           {"number", {"eq", "gt", "lt"}}};

inline std::string text(const nlohmann::json& v) { return v.is_string() ? v.get<std::string>() : v.dump(); }

// Why the registry refuses the rule {attribute, operator, value}, or "" when it accepts it.
inline std::string ruleError(const nlohmann::json& rule) {
  const std::string attribute = rule.value("attribute", "");
  const std::string op = rule.value("operator", "");
  const auto kind = kAttributes.find(attribute);
  if (kind == kAttributes.end()) return "unknown attribute \\"" + attribute + "\\"";
  const auto& allowed = kOperators.at(kind->second);
  if (std::find(allowed.begin(), allowed.end(), op) == allowed.end()) {
    return "operator \\"" + op + "\\" is not defined for the " + kind->second + " attribute \\"" + attribute + "\\"";
  }
  return "";
}

// Whether the user with these attributes satisfies the rule.
inline bool ruleMatches(const nlohmann::json& rule, const std::map<std::string, std::string>& attrs) {
  const std::string attribute = rule.value("attribute", "");
  const std::string op = rule.value("operator", "");
  const auto found = attrs.find(attribute);
  if (found == attrs.end()) return false;
  const std::string& actual = found->second;
  const nlohmann::json expected = rule.contains("value") ? rule.at("value") : nlohmann::json();
  if (op == "in") {
    if (!expected.is_array()) return false;
    for (const auto& v : expected) {
      if (text(v) == actual) return true;
    }
    return false;
  }
  const auto kind = kAttributes.find(attribute);
  if (kind != kAttributes.end() && kind->second == "number") {
    double a = 0;
    double e = 0;
    try {
      a = std::stod(actual);
      e = std::stod(text(expected));
    } catch (const std::exception&) {
      return false;
    }
    return (op == "eq" && a == e) || (op == "gt" && a > e) || (op == "lt" && a < e);
  }
  if (op == "eq") return actual == text(expected);
  if (op == "neq") return actual != text(expected);
  return false;
}

}  // namespace registry
`,
  'flags/hashing.h': `// FNV-1a, 32 bits, over the UTF-8 bytes of a text (provided): the hash bucketing is defined on.
#pragma once

#include <cstdint>
#include <string>

namespace hashing {

inline uint32_t fnv1a32(const std::string& text) {
  uint32_t h = 0x811c9dc5u;
  for (const unsigned char byte : text) {
    h ^= byte;
    h *= 0x01000193u;
  }
  return h;
}

}  // namespace hashing
`,
  'flags/store.h': `// The flag definitions store (provided): every save of a flag is a new version. flag:{key}:v{n}
// holds version n as one JSON document (key, version, default, rules, rollout, salt; the salt is the
// key unless the definition names one) and flag:{key}:version the latest n.
// flag:{key}:create:{idempotency key} holds what a create answered, for its replays.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace store {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store the definition (key, default, rules, rollout) as the flag's next version; returns the stored document.
inline nlohmann::json save(const nlohmann::json& definition) {
  const std::string key = definition.at("key").get<std::string>();
  const long long n = redis().incr("flag:" + key + ":version");
  const std::string salt = definition.value("salt", "");
  nlohmann::json doc = {{"key", key},
                        {"version", n},
                        {"default", definition.at("default")},
                        {"rules", definition.value("rules", nlohmann::json::array())},
                        {"rollout", definition.value("rollout", 0)},
                        {"salt", salt.empty() ? key : salt}};
  redis().set("flag:" + key + ":v" + std::to_string(n), doc.dump());
  return doc;
}

// The latest version of the flag, or none.
inline std::optional<nlohmann::json> load(const std::string& key) {
  const auto n = redis().get("flag:" + key + ":version");
  if (!n) return std::nullopt;
  const auto raw = redis().get("flag:" + key + ":v" + *n);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// What the create (key, idempotency_key) answered, if it ran.
inline std::optional<nlohmann::json> createResult(const std::string& key, const std::string& idempotency_key) {
  const auto raw = redis().get("flag:" + key + ":create:" + idempotency_key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the create (key, idempotency_key) answered, for its replays.
inline void recordCreate(const std::string& key, const std::string& idempotency_key, const nlohmann::json& result) {
  redis().set("flag:" + key + ":create:" + idempotency_key, result.dump());
}

}  // namespace store
`,
  'flags/engine.h': `// The snapshot and evaluation (provided; step 2 builds the same four functions). flags:snapshot
// holds the whole rule set as one JSON document {version, flags: {key: {default, rules, rollout,
// salt, killed}}}; flags:snapshot:version its version. publishSnapshot replaces both in one Lua
// script only when the new version is newer, and reports whether it did. readSnapshot is one GET.
// bucket(flag_key, user_id, salt) is fnv1a32(salt + "." + flag_key + "." + user_id) % 100. evaluate
// reads the snapshot once and answers {flag_key, value, reason, bucket, version}: killed -> default;
// a rule the user does not match -> default (no-match); bucket < rollout -> true (in-rollout); else
// default (out-of-rollout).
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>

#include "flags/hashing.h"
#include "flags/registry.h"

namespace engine {

inline const std::string kSnapshotKey = "flags:snapshot";
inline const std::string kVersionKey = "flags:snapshot:version";
inline const std::string kSwapLua = R"lua(
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Make snapshot the one evaluations read, unless a snapshot at least as new is already there.
inline bool publishSnapshot(const nlohmann::json& snapshot) {
  const std::string version = std::to_string(snapshot.at("version").get<long long>());
  return redis().eval<long long>(kSwapLua, {kSnapshotKey, kVersionKey}, {snapshot.dump(), version}) == 1;
}

// The whole rule set, read with one GET.
inline std::optional<nlohmann::json> readSnapshot() {
  const auto raw = redis().get(kSnapshotKey);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

inline int bucket(const std::string& flag_key, const std::string& user_id, const std::string& salt) {
  return static_cast<int>(hashing::fnv1a32(salt + "." + flag_key + "." + user_id) % 100);
}

// The decision for the user with these attributes (user_id among them), or none for an unknown flag.
inline std::optional<nlohmann::json> evaluate(const std::string& flag_key, const std::map<std::string, std::string>& attrs) {
  const auto snapshot = readSnapshot();
  if (!snapshot || !snapshot->at("flags").contains(flag_key)) return std::nullopt;
  const nlohmann::json& flag = snapshot->at("flags").at(flag_key);
  const auto user = attrs.find("user_id");
  const int b = bucket(flag_key, user == attrs.end() ? "" : user->second, flag.value("salt", flag_key));
  bool matched = true;
  for (const auto& rule : flag.value("rules", nlohmann::json::array())) matched = matched && registry::ruleMatches(rule, attrs);
  bool value = flag.value("default", false);
  std::string reason = "out-of-rollout";
  if (flag.value("killed", false)) {
    reason = "killed";
  } else if (!matched) {
    reason = "no-match";
  } else if (b < flag.value("rollout", 0)) {
    value = true;
    reason = "in-rollout";
  }
  return nlohmann::json{{"flag_key", flag_key}, {"value", value}, {"reason", reason}, {"bucket", b}, {"version", snapshot->at("version")}};
}

}  // namespace engine
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('flags', 'Registry')]: `package flags

import spray.json._

/**
 * The schema registry (provided): Attributes are the user attributes a rule may target, each with its
 * type; Operators the operators each type allows. ruleError names what is wrong with a rule (None
 * when the registry accepts it). ruleMatches evaluates an accepted rule against a user's attributes
 * (name -> text): eq/neq compare text, in looks the text up in a list, gt/lt compare numbers; an
 * attribute the user does not carry matches nothing.
 */
object Registry {
  val Attributes: Map[String, String] = Map("user_id" -> "string", "country" -> "string", "email_domain" -> "string", "app_version" -> "number")
  val Operators: Map[String, Seq[String]] = Map("string" -> Seq("eq", "neq", "in"), "number" -> Seq("eq", "gt", "lt"))

  private def text(v: JsValue): String = v match {
    case JsString(s) => s
    case JsNumber(n) => n.bigDecimal.stripTrailingZeros.toPlainString
    case other => other.compactPrint
  }

  private def field(rule: JsObject, name: String): String = rule.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Why the registry refuses the rule {attribute, operator, value}, or None when it accepts it. */
  def ruleError(rule: JsObject): Option[String] = {
    val attribute = field(rule, "attribute")
    val operator = field(rule, "operator")
    Attributes.get(attribute) match {
      case None => Some(s"unknown attribute \\"$attribute\\"")
      case Some(kind) if !Operators(kind).contains(operator) => Some(s"operator \\"$operator\\" is not defined for the $kind attribute \\"$attribute\\"")
      case Some(_) => None
    }
  }

  /** Whether the user with these attributes satisfies the rule. */
  def ruleMatches(rule: JsObject, attrs: Map[String, String]): Boolean = {
    val attribute = field(rule, "attribute")
    val operator = field(rule, "operator")
    val expected = rule.fields.getOrElse("value", JsNull)
    attrs.get(attribute) match {
      case None => false
      case Some(actual) if operator == "in" =>
        expected match {
          case JsArray(values) => values.map(text).contains(actual)
          case _ => false
        }
      case Some(actual) if Attributes.get(attribute).contains("number") =>
        (actual.toDoubleOption, text(expected).toDoubleOption) match {
          case (Some(a), Some(e)) => (operator == "eq" && a == e) || (operator == "gt" && a > e) || (operator == "lt" && a < e)
          case _ => false
        }
      case Some(actual) if operator == "eq" => actual == text(expected)
      case Some(actual) if operator == "neq" => actual != text(expected)
      case _ => false
    }
  }
}
`,
  [scalaPath('flags', 'Hashing')]: `package flags

import java.nio.charset.StandardCharsets

/** FNV-1a, 32 bits, over the UTF-8 bytes of a text (provided): the hash bucketing is defined on. */
object Hashing {
  def fnv1a32(text: String): Long = {
    var h = 0x811c9dc5L
    text.getBytes(StandardCharsets.UTF_8).foreach { byte =>
      h ^= (byte & 0xff).toLong
      h = (h * 0x01000193L) & 0xffffffffL
    }
    h
  }
}
`,
  [scalaPath('flags', 'Store')]: `package flags

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The flag definitions store (provided): every save of a flag is a new version. flag:{key}:v{n} holds
 * version n as one JSON document (key, version, default, rules, rollout, salt; the salt is the key
 * unless the definition names one) and flag:{key}:version the latest n. flag:{key}:create:{idempotency
 * key} holds what a create answered, for its replays.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  /** Store the definition (key, default, rules, rollout) as the flag's next version; returns the stored document. */
  def save(definition: JsObject): JsObject = {
    val fields = definition.fields
    val key = fields("key").asInstanceOf[JsString].value
    val n = jedis.incr(s"flag:$key:version")
    val salt = fields.get("salt").collect { case JsString(s) if s.nonEmpty => s }.getOrElse(key)
    val doc = JsObject(
      "key" -> JsString(key),
      "version" -> JsNumber(n),
      "default" -> fields("default"),
      "rules" -> fields.getOrElse("rules", JsArray()),
      "rollout" -> fields.getOrElse("rollout", JsNumber(0)),
      "salt" -> JsString(salt))
    jedis.set(s"flag:$key:v$n", doc.compactPrint)
    doc
  }

  /** The latest version of the flag, if any. */
  def load(key: String): Option[JsObject] =
    Option(jedis.get(s"flag:$key:version")).flatMap(n => Option(jedis.get(s"flag:$key:v$n"))).map(_.parseJson.asJsObject)

  /** What the create (key, idempotencyKey) answered, if it ran. */
  def createResult(key: String, idempotencyKey: String): Option[JsObject] =
    Option(jedis.get(s"flag:$key:create:$idempotencyKey")).map(_.parseJson.asJsObject)

  /** Record what the create (key, idempotencyKey) answered, for its replays. */
  def recordCreate(key: String, idempotencyKey: String, result: JsObject): Unit =
    jedis.set(s"flag:$key:create:$idempotencyKey", result.compactPrint)
}
`,
  [scalaPath('flags', 'Engine')]: `package flags

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The snapshot and evaluation (provided; step 2 builds the same four functions). flags:snapshot holds
 * the whole rule set as one JSON document {version, flags: {key: {default, rules, rollout, salt,
 * killed}}}; flags:snapshot:version its version. publishSnapshot replaces both in one Lua script only
 * when the new version is newer, and reports whether it did. readSnapshot is one GET. bucket(flagKey,
 * userId, salt) is fnv1a32(s"$salt.$flagKey.$userId") % 100. evaluate reads the snapshot once and
 * answers {flag_key, value, reason, bucket, version}: killed -> default; a rule the user does not
 * match -> default (no-match); bucket < rollout -> true (in-rollout); else default (out-of-rollout).
 */
object Engine {
  val jedis = new JedisPooled("redis", 6379)

  val SnapshotKey = "flags:snapshot"
  val VersionKey = "flags:snapshot:version"
  val SwapLua: String =
    """local current = tonumber(redis.call('GET', KEYS[2]) or '0')
      |if current >= tonumber(ARGV[2]) then return 0 end
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('SET', KEYS[2], ARGV[2])
      |return 1
      |""".stripMargin

  /** Make snapshot the one evaluations read, unless a snapshot at least as new is already there. */
  def publishSnapshot(snapshot: JsObject): Boolean = {
    val version = snapshot.fields("version").asInstanceOf[JsNumber].value.toLong
    jedis.eval(SwapLua, List(SnapshotKey, VersionKey).asJava, List(snapshot.compactPrint, version.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** The whole rule set, read with one GET. */
  def readSnapshot(): Option[JsObject] = Option(jedis.get(SnapshotKey)).map(_.parseJson.asJsObject)

  def bucket(flagKey: String, userId: String, salt: String): Int = (Hashing.fnv1a32(s"$salt.$flagKey.$userId") % 100).toInt

  /** The decision for the user with these attributes (user_id among them), or None for an unknown flag. */
  def evaluate(flagKey: String, attrs: Map[String, String]): Option[JsObject] =
    readSnapshot().flatMap { snapshot =>
      snapshot.fields("flags").asJsObject.fields.get(flagKey).map { entry =>
        val flag = entry.asJsObject.fields
        val default = flag.get("default").contains(JsTrue)
        val salt = flag.get("salt").collect { case JsString(s) => s }.getOrElse(flagKey)
        val rollout = flag.get("rollout").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
        val rules = flag.get("rules").collect { case JsArray(rs) => rs.map(_.asJsObject) }.getOrElse(Vector.empty)
        val b = bucket(flagKey, attrs.getOrElse("user_id", ""), salt)
        val (value, reason) =
          if (flag.get("killed").contains(JsTrue)) (default, "killed")
          else if (!rules.forall(Registry.ruleMatches(_, attrs))) (default, "no-match")
          else if (b < rollout) (true, "in-rollout")
          else (default, "out-of-rollout")
        JsObject("flag_key" -> JsString(flagKey), "value" -> JsBoolean(value), "reason" -> JsString(reason), "bucket" -> JsNumber(b), "version" -> snapshot.fields("version"))
      }
    }
}
`,
};
