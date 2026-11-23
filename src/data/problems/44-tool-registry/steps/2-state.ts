import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'The catalog: immutable versions behind one pointer',
  concept: 'redis',
  guides: ['model-output', 'atomic-state'],
  file: 'state',
  focus: ['registry', 'redis', 'client'],
  task: `## Task

**Starting point.** The starter is the catalog the registry and the resolve endpoint share:
\`promote(cv, entries)\` writes each tool's entry into the live hash \`catalog:tools\` with one
\`HSET\` per tool and sets \`catalog:active\` to \`cv\`; \`resolve(name, run_id)\` reads
\`catalog:tools\`; \`pin_run(run_id, cv)\` writes \`catalog:pin:{run_id}\`; \`rollback()\` decrements
\`catalog:active\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** An agent resolving during a promotion gets one tool from the old
catalog and another from the new one; a candidate the sandbox rejected goes live; a promotion moves
every running agent onto new definitions mid-plan; and a rollback lands on whatever number sits
below the active one.

- Each catalog version is one hash, \`version_key(cv)\` (\`catalog:version:{cv}\`), written with
  **one** \`HSET\`; only then does \`ACTIVE_KEY\` move. Older versions stay untouched.
- \`promote\` raises \`NotValidated\`, writing nothing, unless \`validation_key(cv)\`
  (\`catalog:validation:{cv}\`) has \`outcome\` \`passed\`.
- \`pin_run\` writes \`pin_key(run_id)\` with a \`PIN_TTL_S\` (6 h) TTL in the same write; \`resolve\` reads
  the pin, falls back to \`ACTIVE_KEY\`, then does one \`HGET\` on that version (a pinned run sees only
  its pinned version).
- \`promote\` records the replaced version at \`PREVIOUS_KEY\` (\`catalog:previous\`), when it replaces
  one; \`rollback()\` sets \`ACTIVE_KEY\` back to it in one write and returns it (\`None\` when there is
  none).`,
  sequence: {
    participants: ['Registry', 'Redis', 'Agent run'],
    messages: [
      {from: 'Registry', to: 'Redis', label: 'HGET catalog:validation:9 outcome → passed', kind: 'sync'},
      {from: 'Registry', to: 'Redis', label: 'HSET catalog:version:9 {every tool}', kind: 'sync'},
      {from: 'Registry', to: 'Redis', label: 'SET catalog:previous 7 · SET catalog:active 9', kind: 'sync'},
      {from: 'Agent run', to: 'Redis', label: 'GET catalog:pin:run-1 → 7', kind: 'sync'},
      {from: 'Agent run', to: 'Redis', label: 'HGET catalog:version:7 refund', kind: 'sync'},
      {from: 'Redis', to: 'Agent run', label: 'the entry the run started with', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'version-swap',
      title: 'Writes a whole version, then moves the pointer',
      detail:
        'A version is written whole under `version_key(cv)` with one `HSET`, before `catalog:active` moves, so an agent resolving at any moment of a promotion sees one version whole; the starter edits one live hash field by field, so a reader can see two catalogs at once.',
      match: {
        python: {
          all: [/\.hset\(\s*version_key\(cv\)\s*,\s*mapping=/],
          none: [/catalog:tools|LIVE_KEY/],
          order: [/\.hset\(\s*version_key\(/, /\.set\(\s*ACTIVE_KEY/],
        },
        typescript: {
          all: [/\.hset\(\s*versionKey\(cv\)\s*,\s*\w+\)/],
          none: [/catalog:tools|LIVE_KEY/],
          order: [/\.hset\(\s*versionKey\(/, /\.set\(\s*ACTIVE_KEY/],
        },
        go: {
          all: [/HSet\(ctx,\s*versionKey\(cv\),\s*\w+\)/],
          none: [/catalog:tools|liveKey/],
          order: [/HSet\(ctx,\s*versionKey\(/, /Set\(ctx,\s*activeKey/],
        },
        cpp: {
          all: [/redis\.hset\(\s*versionKey\(cv\),\s*\w+\.begin\(\)/],
          none: [/catalog:tools|kLiveKey/],
          order: [/redis\.hset\(\s*versionKey\(/, /redis\.set\(\s*kActiveKey/],
        },
      },
    },
    {
      id: 'validation-guard',
      title: 'Refuses a candidate without a passing validation',
      detail:
        '`promote` reads `validation_key(cv)` before writing anything and raises `NotValidated` unless the outcome is `passed`; the starter promotes whatever it is handed.',
      match: {
        python: {
          all: [/raise NotValidated/, /["']passed["']/],
          order: [/\.hget\(\s*validation_key\(cv\)/, /\.hset\(/],
        },
        typescript: {
          all: [/throw new NotValidated/, /['"]passed['"]/],
          order: [/\.hget\(\s*validationKey\(cv\)/, /\.hset\(/],
        },
        go: {all: [/ErrNotValidated/, /"passed"/], order: [/HGet\(ctx,\s*validationKey\(cv\)/, /HSet\(/]},
        cpp: {all: [/throw NotValidated/, /"passed"/], order: [/redis\.hget\(\s*validationKey\(cv\)/, /redis\.hset\(/]},
      },
    },
    {
      id: 'run-pin',
      title: 'Keeps a run on the version it pinned',
      detail:
        '`pin_run` writes `pin_key(run_id)` with the 6-hour `PIN_TTL_S` in the same write, and `resolve` reads the pin before falling back to the active version, resolving a pinned run in its pinned version only; the starter writes the pin without a TTL and never reads it.',
      match: {
        python: {all: [/\.set\(\s*pin_key\(run_id\)[^\n]*ex\s*=\s*PIN_TTL_S/, /\.get\(\s*pin_key\(run_id\)/]},
        typescript: {all: [/\.set\(\s*pinKey\(runId\)[^\n]*['"]EX['"],\s*PIN_TTL_S/, /\.get\(\s*pinKey\(runId\)/]},
        go: {all: [/Set\(ctx,\s*pinKey\(runID\),\s*cv,\s*pinTTL\)/, /Get\(ctx,\s*pinKey\(runID\)\)/]},
        cpp: {all: [/redis\.set\(\s*pinKey\(run_id\),\s*cv,\s*kPinTtl\)/, /redis\.get\(\s*pinKey\(run_id\)\)/]},
      },
    },
    {
      id: 'rollback',
      title: 'Rolls back to the version the promotion replaced',
      detail:
        '`promote` records the version it replaced at `PREVIOUS_KEY` (nothing when it replaced none, the first promotion or a repeat of the active version) and `rollback` sets the pointer back to it in one write; the starter decrements the pointer, which lands on a rejected candidate when versions are not consecutive.',
      match: {
        python: {all: [/\.set\(\s*PREVIOUS_KEY/, /\.get\(\s*PREVIOUS_KEY\)/], none: [/\.decr\(/]},
        typescript: {all: [/\.set\(\s*PREVIOUS_KEY/, /\.get\(\s*PREVIOUS_KEY\)/], none: [/\.decr\(/]},
        go: {all: [/Set\(ctx,\s*previousKey/, /Get\(ctx,\s*previousKey\)/], none: [/\.Decr\(/]},
        cpp: {all: [/redis\.set\(\s*kPreviousKey/, /redis\.get\(\s*kPreviousKey\)/], none: [/\.decr\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIVE_KEY = "catalog:tools"
ACTIVE_KEY = "catalog:active"


class NotValidated(Exception):
    """The candidate has no passing validation: nothing was written."""


def promote(cv: str, entries: dict[str, dict]) -> None:
    """Make catalog version cv (tool name -> entry) the one agents resolve."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for name, entry in entries.items():
        r.hset(LIVE_KEY, name, json.dumps(entry, sort_keys=True))
    r.set(ACTIVE_KEY, cv)


def rollback() -> str | None:
    """Point the catalog back at the version the last promotion replaced; that version, or None."""
    if r.get(ACTIVE_KEY) is None:
        return None
    return str(r.decr(ACTIVE_KEY))


def pin_run(run_id: str, cv: str) -> None:
    """Keep the run on catalog version cv for the rest of its plan."""
    r.set(f"catalog:pin:{run_id}", cv)


def resolve(name: str, run_id: str | None = None) -> dict | None:
    """The entry of tool name in the run's pinned version, else in the active one; None if absent."""
    raw = r.hget(LIVE_KEY, name)
    return json.loads(raw) if raw else None
`,
      solution: `import json

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
    # The whole version in one write, under its own key; readers still follow the old pointer.
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
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export type Entry = Record<string, unknown>;

export const LIVE_KEY = 'catalog:tools';
export const ACTIVE_KEY = 'catalog:active';

/** The candidate has no passing validation: nothing was written. */
export class NotValidated extends Error {}

/** Make catalog version cv (tool name -> entry) the one agents resolve. */
export async function promote(cv: string, entries: Record<string, Entry>): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const [name, entry] of Object.entries(entries)) await redis.hset(LIVE_KEY, name, JSON.stringify(entry));
  await redis.set(ACTIVE_KEY, cv);
}

/** Point the catalog back at the version the last promotion replaced; that version, or null. */
export async function rollback(): Promise<string | null> {
  if ((await redis.get(ACTIVE_KEY)) === null) return null;
  return String(await redis.decr(ACTIVE_KEY));
}

/** Keep the run on catalog version cv for the rest of its plan. */
export async function pinRun(runId: string, cv: string): Promise<void> {
  await redis.set(\`catalog:pin:\${runId}\`, cv);
}

/** The entry of tool name in the run's pinned version, else in the active one; null if absent. */
export async function resolve(name: string, runId: string | null = null): Promise<Entry | null> {
  const raw = await redis.hget(LIVE_KEY, name);
  return raw === null ? null : (JSON.parse(raw) as Entry);
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export type Entry = Record<string, unknown>;

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
  // The whole version in one write, under its own key; readers still follow the old pointer.
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
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	liveKey   = "catalog:tools"
	activeKey = "catalog:active"
)

// ErrNotValidated: the candidate has no passing validation, nothing was written.
var ErrNotValidated = errors.New("catalog version has no passing validation")

// promote makes catalog version cv (tool name -> entry) the one agents resolve.
func promote(ctx context.Context, cv string, entries map[string]map[string]any) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for name, entry := range entries {
		raw, _ := json.Marshal(entry)
		if err := rdb.HSet(ctx, liveKey, name, string(raw)).Err(); err != nil {
			return err
		}
	}
	return rdb.Set(ctx, activeKey, cv, 0).Err()
}

// rollback points the catalog back at the version the last promotion replaced; that version, or "".
func rollback(ctx context.Context) (string, error) {
	if rdb.Exists(ctx, activeKey).Val() == 0 {
		return "", nil
	}
	n, err := rdb.Decr(ctx, activeKey).Result()
	return strconv.FormatInt(n, 10), err
}

// pinRun keeps the run on catalog version cv for the rest of its plan.
func pinRun(ctx context.Context, runID, cv string) error {
	return rdb.Set(ctx, "catalog:pin:"+runID, cv, 0).Err()
}

// resolve is the entry of tool name in the run's pinned version ("": none), else in the active one; nil if absent.
func resolve(ctx context.Context, name, runID string) (map[string]any, error) {
	raw, err := rdb.HGet(ctx, liveKey, name).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entry map[string]any
	return entry, json.Unmarshal([]byte(raw), &entry)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	activeKey   = "catalog:active"
	previousKey = "catalog:previous"
	pinTTL      = 6 * time.Hour
)

// ErrNotValidated: the candidate has no passing validation, nothing was written.
var ErrNotValidated = errors.New("catalog version has no passing validation")

func versionKey(cv string) string    { return "catalog:version:" + cv }
func pinKey(runID string) string     { return "catalog:pin:" + runID }
func validationKey(cv string) string { return "catalog:validation:" + cv }

// promote makes catalog version cv (tool name -> entry) the one agents resolve.
func promote(ctx context.Context, cv string, entries map[string]map[string]any) error {
	if rdb.HGet(ctx, validationKey(cv), "outcome").Val() != "passed" {
		return ErrNotValidated
	}
	// The whole version in one write, under its own key; readers still follow the old pointer.
	fields := map[string]any{}
	for name, entry := range entries {
		raw, _ := json.Marshal(entry)
		fields[name] = string(raw)
	}
	if err := rdb.HSet(ctx, versionKey(cv), fields).Err(); err != nil {
		return err
	}
	current, err := rdb.Get(ctx, activeKey).Result()
	if err == nil && current != cv {
		if err := rdb.Set(ctx, previousKey, current, 0).Err(); err != nil {
			return err
		}
	}
	return rdb.Set(ctx, activeKey, cv, 0).Err()
}

// rollback points the catalog back at the version the last promotion replaced; that version, or "".
func rollback(ctx context.Context) (string, error) {
	previous, err := rdb.Get(ctx, previousKey).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return previous, rdb.Set(ctx, activeKey, previous, 0).Err()
}

// pinRun keeps the run on catalog version cv for the rest of its plan.
func pinRun(ctx context.Context, runID, cv string) error {
	return rdb.Set(ctx, pinKey(runID), cv, pinTTL).Err()
}

// resolve is the entry of tool name in the run's pinned version ("": none), else in the active one; nil if absent.
func resolve(ctx context.Context, name, runID string) (map[string]any, error) {
	cv := ""
	if runID != "" {
		cv = rdb.Get(ctx, pinKey(runID)).Val()
	}
	if cv == "" {
		cv = rdb.Get(ctx, activeKey).Val()
	}
	if cv == "" {
		return nil, nil
	}
	raw, err := rdb.HGet(ctx, versionKey(cv), name).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entry map[string]any
	return entry, json.Unmarshal([]byte(raw), &entry)
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kLiveKey = "catalog:tools";
const std::string kActiveKey = "catalog:active";

// The candidate has no passing validation: nothing was written.
struct NotValidated : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Make catalog version cv (tool name -> entry) the one agents resolve.
void promote(const std::string& cv, const json& entries) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const auto& [name, entry] : entries.items()) redis.hset(kLiveKey, name, entry.dump());
  redis.set(kActiveKey, cv);
}

// Point the catalog back at the version the last promotion replaced; that version, or none.
std::optional<std::string> rollback() {
  if (!redis.get(kActiveKey)) return std::nullopt;
  return std::to_string(redis.decr(kActiveKey));
}

// Keep the run on catalog version cv for the rest of its plan.
void pinRun(const std::string& run_id, const std::string& cv) { redis.set("catalog:pin:" + run_id, cv); }

// The entry of tool name in the run's pinned version ("": none), else in the active one; none if absent.
std::optional<json> resolve(const std::string& name, const std::string& run_id = "") {
  const auto raw = redis.hget(kLiveKey, name);
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kActiveKey = "catalog:active";
const std::string kPreviousKey = "catalog:previous";
constexpr std::chrono::hours kPinTtl{6};

// The candidate has no passing validation: nothing was written.
struct NotValidated : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string versionKey(const std::string& cv) { return "catalog:version:" + cv; }
std::string pinKey(const std::string& run_id) { return "catalog:pin:" + run_id; }
std::string validationKey(const std::string& cv) { return "catalog:validation:" + cv; }

// Make catalog version cv (tool name -> entry) the one agents resolve.
void promote(const std::string& cv, const json& entries) {
  if (redis.hget(validationKey(cv), "outcome").value_or("") != "passed") {
    throw NotValidated("catalog version " + cv + " has no passing validation");
  }
  // The whole version in one write, under its own key; readers still follow the old pointer.
  std::unordered_map<std::string, std::string> fields;
  for (const auto& [name, entry] : entries.items()) fields[name] = entry.dump();
  redis.hset(versionKey(cv), fields.begin(), fields.end());
  const auto current = redis.get(kActiveKey);
  if (current && *current != cv) redis.set(kPreviousKey, *current);
  redis.set(kActiveKey, cv);
}

// Point the catalog back at the version the last promotion replaced; that version, or none.
std::optional<std::string> rollback() {
  const auto previous = redis.get(kPreviousKey);
  if (!previous) return std::nullopt;
  redis.set(kActiveKey, *previous);
  return *previous;
}

// Keep the run on catalog version cv for the rest of its plan.
void pinRun(const std::string& run_id, const std::string& cv) { redis.set(pinKey(run_id), cv, kPinTtl); }

// The entry of tool name in the run's pinned version ("": none), else in the active one; none if absent.
std::optional<json> resolve(const std::string& name, const std::string& run_id = "") {
  std::optional<std::string> cv;
  if (!run_id.empty()) cv = redis.get(pinKey(run_id));
  if (!cv) cv = redis.get(kActiveKey);
  if (!cv) return std::nullopt;
  const auto raw = redis.hget(versionKey(*cv), name);
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}
`,
    },
  },
  harness: {
    python: `import json

S1 = {"name": "search", "version": "a1", "side_effect": "read", "owner": "search", "schema": {"type": "object"}, "endpoint": "https://search.internal", "credential_ref": "vault://search"}
S2 = {**S1, "version": "a2"}
R1 = {"name": "refund", "version": "b1", "side_effect": "irreversible", "owner": "payments", "schema": {"type": "object"}, "endpoint": "https://payments.internal", "credential_ref": "vault://payments"}
R2 = {**R1, "version": "b2"}
V7 = {"search": S1, "refund": R1}
V9 = {"search": S2, "refund": R2}
X1 = {"name": "export", "version": "e1", "side_effect": "read", "owner": "data", "schema": {"type": "object"}, "endpoint": "https://data.internal", "credential_ref": "vault://data"}


def _verdict(ctx, cv, outcome):
    ctx.redis.hset(f"catalog:validation:{cv}", mapping={"outcome": outcome, "reason": ""})


def _pair(m, run_id=None):
    return (m.resolve("search", run_id), m.resolve("refund", run_id))


def _versions(pair):
    return tuple(None if e is None else e.get("version") for e in pair)


def _watch(ctx, m, key, seen, left=4):
    """An agent resolves both tools right after each of the next few commands touching key."""

    def fire():
        try:
            seen.append(_pair(m))
        except Exception as exc:
            seen.append(exc)
        if left > 1:
            _watch(ctx, m, key, seen, left - 1)

    ctx.redis_after(key, fire)


def check_version_swap(ctx):
    m = ctx.load("state")
    _verdict(ctx, "7", "passed")
    _verdict(ctx, "9", "passed")
    m.promote("7", V7)
    assert _pair(m) == (S1, R1), f"after promoting catalog 7 agents resolve versions {_versions(_pair(m))}, expected ('a1', 'b1')"
    # An agent resolves both tools while catalog 9 is being written and the pointer moves.
    seen = []
    for key in ("catalog:tools", "catalog:version:9", "catalog:active"):
        _watch(ctx, m, key, seen)
    m.promote("9", V9)
    for result in list(seen):
        if isinstance(result, Exception):
            raise result
        assert result in ((S1, R1), (S2, R2)), f"an agent resolving during the promotion of catalog 9 got versions {_versions(result)}: it must see catalog 7 whole or catalog 9 whole. Write catalog:version:9 whole, then move catalog:active"
    assert _pair(m) == (S2, R2), f"after promoting catalog 9 agents resolve versions {_versions(_pair(m))}, expected ('a2', 'b2')"
    assert ctx.redis.get("catalog:active") == "9", f"catalog:active is {ctx.redis.get('catalog:active')!r}, expected '9'"
    kept = {name: json.loads(raw) for name, raw in ctx.redis.hgetall("catalog:version:7").items()}
    assert kept == V7, f"catalog:version:7 holds {sorted(kept)}: a promotion must leave the version it replaced whole, one hash per version"


def check_validation_guard(ctx):
    m = ctx.load("state")
    _verdict(ctx, "7", "passed")
    m.promote("7", V7)
    _verdict(ctx, "8", "rejected")
    _verdict(ctx, "10", "unavailable")
    for cv, why in (("8", "the sandbox rejected"), ("10", "the sandbox never answered on"), ("11", "nobody validated")):
        try:
            m.promote(cv, V9)
        except m.NotValidated:
            pass
        else:
            raise AssertionError(f"promote({cv!r}) went through for a candidate {why}: raise NotValidated unless catalog:validation:{cv} says passed")
        assert not ctx.redis.exists(f"catalog:version:{cv}"), f"a refused promotion of {cv} still wrote catalog:version:{cv}"
    assert ctx.redis.get("catalog:active") == "7", f"catalog:active is {ctx.redis.get('catalog:active')!r} after refused promotions, expected '7'"
    assert _pair(m) == (S1, R1), f"agents resolve versions {_versions(_pair(m))} after refused promotions, expected catalog 7"
    _verdict(ctx, "9", "passed")
    m.promote("9", V9)
    assert _pair(m) == (S2, R2), "a validated candidate must promote"


def check_run_pin(ctx):
    m = ctx.load("state")
    _verdict(ctx, "7", "passed")
    _verdict(ctx, "9", "passed")
    m.promote("7", V7)
    ttl_at_write = []
    ctx.redis_after("catalog:pin:run-1", lambda: ttl_at_write.append(ctx.redis.ttl("catalog:pin:run-1")))
    m.pin_run("run-1", "7")
    m.promote("9", {**V9, "export": X1})
    pinned = m.resolve("search", "run-1")
    assert pinned == S1, f"run-1 pinned catalog 7 and now resolves search version {None if pinned is None else pinned.get('version')}: a promotion moved a running agent onto new definitions mid-plan"
    added = m.resolve("export", "run-1")
    assert added is None, f"run-1 pinned catalog 7, which has no export tool, and resolves export version {added.get('version') if isinstance(added, dict) else added}: a pinned run resolves in its pinned version only"
    assert m.resolve("export") == X1, "a caller without a run resolves export in the active catalog 9"
    assert m.resolve("search") == S2, "a caller without a run resolves the active catalog 9"
    assert m.resolve("search", "run-2") == S2, "a run that pinned nothing resolves the active catalog 9"
    ttl = ctx.redis.ttl("catalog:pin:run-1")
    assert 6 * 3600 - 60 <= ttl <= 6 * 3600, f"catalog:pin:run-1 has TTL {ttl}, expected PIN_TTL_S (6 hours): a pin without a TTL keeps every old catalog alive"
    assert ttl_at_write and 6 * 3600 - 60 <= ttl_at_write[0] <= 6 * 3600, f"right after the command that wrote catalog:pin:run-1 its TTL was {ttl_at_write[0] if ttl_at_write else None}: a pin written without its TTL lives forever if the next command never runs. Set it in the same command"


def check_rollback(ctx):
    m = ctx.load("state")
    assert m.rollback() is None, "with nothing promoted, rollback must answer None"
    _verdict(ctx, "7", "passed")
    _verdict(ctx, "8", "rejected")
    _verdict(ctx, "9", "passed")
    m.promote("7", V7)
    first = m.rollback()
    assert first is None, f"with only catalog 7 ever promoted, rollback answered {first!r}: there is no replaced version to go back to, answer None"
    assert ctx.redis.get("catalog:active") == "7", f"catalog:active is {ctx.redis.get('catalog:active')!r} after a rollback with nothing to go back to, expected '7'"
    m.promote("9", V9)  # 8 was a candidate the sandbox rejected: it never went live
    m.promote("9", V9)  # a retried promotion of the active version replaces nothing
    back = m.rollback()
    assert back == "7", f"rollback answered {back!r}: the version catalog 9 replaced is 7 (8 was a rejected candidate, and promoting 9 again replaced nothing). Record it at promotion"
    assert ctx.redis.get("catalog:active") == "7", f"catalog:active is {ctx.redis.get('catalog:active')!r} after the rollback, expected '7'"
    assert _pair(m) == (S1, R1), f"after the rollback agents resolve versions {_versions(_pair(m))}, expected catalog 7"
`,
    typescript: `const S1 = {name: 'search', version: 'a1', side_effect: 'read', owner: 'search', schema: {type: 'object'}, endpoint: 'https://search.internal', credential_ref: 'vault://search'};
const S2 = {...S1, version: 'a2'};
const R1 = {name: 'refund', version: 'b1', side_effect: 'irreversible', owner: 'payments', schema: {type: 'object'}, endpoint: 'https://payments.internal', credential_ref: 'vault://payments'};
const R2 = {...R1, version: 'b2'};
const V7 = {search: S1, refund: R1};
const V9 = {search: S2, refund: R2};
const X1 = {name: 'export', version: 'e1', side_effect: 'read', owner: 'data', schema: {type: 'object'}, endpoint: 'https://data.internal', credential_ref: 'vault://data'};

const verdict = (ctx, cv: string, outcome: string) => ctx.redis.hset(\`catalog:validation:\${cv}\`, 'outcome', outcome, 'reason', '');
const versions = pair => JSON.stringify(pair.map(e => (e === null ? null : e.version)));

async function pair(m, runId: string | null = null) {
  return [await m.resolve('search', runId), await m.resolve('refund', runId)];
}

function same(a, b): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The versions an agent sees at this instant, read synchronously inside a probe: catalog:active, then that
 * version's hash (or, for a catalog kept in the one live hash catalog:tools, that hash).
 */
function snapshot(ctx, key: string): (string | null)[] {
  const cv = ctx.redis.get('catalog:active');
  return ['search', 'refund'].map(name => {
    const hash = key === 'catalog:tools' ? key : cv === null ? null : \`catalog:version:\${cv}\`;
    const raw = hash === null ? null : ctx.redis.hget(hash, name);
    return raw === null || raw === undefined ? null : JSON.parse(raw).version;
  });
}

/** The snapshot right after each of the next few commands touching key. */
function watch(ctx, key: string, seen: (string | null)[][], left = 4): void {
  ctx.redisAfter(key, () => {
    seen.push(snapshot(ctx, key));
    if (left > 1) watch(ctx, key, seen, left - 1);
  });
}

export async function check_version_swap(ctx) {
  const m = ctx.load('state');
  verdict(ctx, '7', 'passed');
  verdict(ctx, '9', 'passed');
  await m.promote('7', V7);
  assert(same(await pair(m), [S1, R1]), \`after promoting catalog 7 agents resolve versions \${versions(await pair(m))}, expected a1, b1\`);
  // An agent resolves both tools while catalog 9 is being written and the pointer moves.
  const seen: (string | null)[][] = [];
  for (const key of ['catalog:tools', 'catalog:version:9', 'catalog:active']) watch(ctx, key, seen);
  await m.promote('9', V9);
  for (const versions of [...seen]) {
    assert(same(versions, ['a1', 'b1']) || same(versions, ['a2', 'b2']), \`an agent resolving during the promotion of catalog 9 got versions \${JSON.stringify(versions)}: it must see catalog 7 whole or catalog 9 whole. Write catalog:version:9 whole, then move catalog:active\`);
  }
  assert(same(await pair(m), [S2, R2]), \`after promoting catalog 9 agents resolve versions \${versions(await pair(m))}, expected a2, b2\`);
  assert.equal(ctx.redis.get('catalog:active'), '9', 'catalog:active after promoting 9');
  const kept = Object.fromEntries(Object.entries(ctx.redis.hgetall('catalog:version:7')).map(([name, raw]) => [name, JSON.parse(raw as string)]));
  assert(same(kept.search, S1) && same(kept.refund, R1), \`catalog:version:7 holds \${JSON.stringify(Object.keys(kept))}: a promotion must leave the version it replaced whole, one hash per version\`);
}

export async function check_validation_guard(ctx) {
  const m = ctx.load('state');
  verdict(ctx, '7', 'passed');
  await m.promote('7', V7);
  verdict(ctx, '8', 'rejected');
  verdict(ctx, '10', 'unavailable');
  for (const [cv, why] of [['8', 'the sandbox rejected'], ['10', 'the sandbox never answered on'], ['11', 'nobody validated']]) {
    let refused = false;
    try {
      await m.promote(cv, V9);
    } catch (e) {
      assert(e instanceof m.NotValidated, \`promote(\${cv}) threw \${e}, expected NotValidated\`);
      refused = true;
    }
    assert(refused, \`promote(\${cv}) went through for a candidate \${why}: throw NotValidated unless catalog:validation:\${cv} says passed\`);
    assert.equal(ctx.redis.exists(\`catalog:version:\${cv}\`), 0, \`a refused promotion of \${cv} still wrote catalog:version:\${cv}\`);
  }
  assert.equal(ctx.redis.get('catalog:active'), '7', 'catalog:active after refused promotions');
  assert(same(await pair(m), [S1, R1]), \`agents resolve versions \${versions(await pair(m))} after refused promotions, expected catalog 7\`);
  verdict(ctx, '9', 'passed');
  await m.promote('9', V9);
  assert(same(await pair(m), [S2, R2]), 'a validated candidate must promote');
}

export async function check_run_pin(ctx) {
  const m = ctx.load('state');
  verdict(ctx, '7', 'passed');
  verdict(ctx, '9', 'passed');
  await m.promote('7', V7);
  const ttlAtWrite: number[] = [];
  ctx.redisAfter('catalog:pin:run-1', () => ttlAtWrite.push(ctx.redis.ttl('catalog:pin:run-1')));
  await m.pinRun('run-1', '7');
  await m.promote('9', {...V9, export: X1});
  const pinned = await m.resolve('search', 'run-1');
  assert(same(pinned, S1), \`run-1 pinned catalog 7 and now resolves search version \${pinned?.version}: a promotion moved a running agent onto new definitions mid-plan\`);
  const added = await m.resolve('export', 'run-1');
  assert.equal(added, null, \`run-1 pinned catalog 7, which has no export tool, and resolves export version \${added?.version}: a pinned run resolves in its pinned version only\`);
  assert.equal((await m.resolve('export'))?.version, 'e1', 'a caller without a run resolves export in the active catalog 9');
  assert(same(await m.resolve('search'), S2), 'a caller without a run resolves the active catalog 9');
  assert(same(await m.resolve('search', 'run-2'), S2), 'a run that pinned nothing resolves the active catalog 9');
  const ttl = ctx.redis.ttl('catalog:pin:run-1');
  assert(6 * 3600 - 60 <= ttl && ttl <= 6 * 3600, \`catalog:pin:run-1 has TTL \${ttl}, expected PIN_TTL_S (6 hours): a pin without a TTL keeps every old catalog alive\`);
  const first = ttlAtWrite[0];
  assert(first !== undefined && 6 * 3600 - 60 <= first && first <= 6 * 3600, \`right after the command that wrote catalog:pin:run-1 its TTL was \${first}: a pin written without its TTL lives forever if the next command never runs. Set it in the same command\`);
}

export async function check_rollback(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.rollback(), null, 'with nothing promoted, rollback must answer null');
  verdict(ctx, '7', 'passed');
  verdict(ctx, '8', 'rejected');
  verdict(ctx, '9', 'passed');
  await m.promote('7', V7);
  const first = await m.rollback();
  assert.equal(first, null, \`with only catalog 7 ever promoted, rollback answered \${JSON.stringify(first)}: there is no replaced version to go back to, answer null\`);
  assert.equal(ctx.redis.get('catalog:active'), '7', 'catalog:active after a rollback with nothing to go back to');
  await m.promote('9', V9); // 8 was a candidate the sandbox rejected: it never went live
  await m.promote('9', V9); // a retried promotion of the active version replaces nothing
  const back = await m.rollback();
  assert.equal(back, '7', \`rollback answered \${JSON.stringify(back)}: the version catalog 9 replaced is 7 (8 was a rejected candidate, and promoting 9 again replaced nothing). Record it at promotion\`);
  assert.equal(ctx.redis.get('catalog:active'), '7', 'catalog:active after the rollback');
  assert(same(await pair(m), [S1, R1]), \`after the rollback agents resolve versions \${versions(await pair(m))}, expected catalog 7\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"

	"leetbuild/harness"
)

var hStateBg = context.Background()

func hEntry(name, version, sideEffect, owner string) map[string]any {
	return map[string]any{"name": name, "version": version, "side_effect": sideEffect, "owner": owner, "schema": map[string]any{"type": "object"}, "endpoint": "https://" + owner + ".internal", "credential_ref": "vault://" + owner}
}

var (
	hS1 = hEntry("search", "a1", "read", "search")
	hS2 = hEntry("search", "a2", "read", "search")
	hR1 = hEntry("refund", "b1", "irreversible", "payments")
	hR2 = hEntry("refund", "b2", "irreversible", "payments")
	hV7 = map[string]map[string]any{"search": hS1, "refund": hR1}
	hV9 = map[string]map[string]any{"search": hS2, "refund": hR2}
	hX1 = hEntry("export", "e1", "read", "data")
)

func hVerdict(ctx *harness.Ctx, cv, outcome string) {
	ctx.Redis.Do("HSET", "catalog:validation:"+cv, "outcome", outcome, "reason", "")
}

func hSameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// pair is what an agent resolves for both tools, as versions ("" when absent).
func hPair(runID string) [2]string {
	var out [2]string
	for i, name := range []string{"search", "refund"} {
		e, _ := resolve(hStateBg, name, runID)
		if v, ok := e["version"].(string); ok {
			out[i] = v
		}
	}
	return out
}

// watch records what an agent resolves right after each of the next left commands touching key.
func hWatch(ctx *harness.Ctx, key string, seen *[][2]string, left int) {
	ctx.Redis.After(key, func() any {
		*seen = append(*seen, hPair(""))
		if left > 1 {
			hWatch(ctx, key, seen, left-1)
		}
		return nil
	})
}

func hMustPromote(ctx *harness.Ctx, cv string, entries map[string]map[string]any) {
	ctx.NoError(promote(hStateBg, cv, entries), "promote(%s) of a validated candidate failed", cv)
}

func CheckVersionSwap(ctx *harness.Ctx) {
	hVerdict(ctx, "7", "passed")
	hVerdict(ctx, "9", "passed")
	hMustPromote(ctx, "7", hV7)
	ctx.Equal(hPair(""), [2]string{"a1", "b1"}, "after promoting catalog 7, the versions agents resolve")
	// An agent resolves both tools while catalog 9 is being written and the pointer moves.
	var seen [][2]string
	for _, key := range []string{"catalog:tools", "catalog:version:9", "catalog:active"} {
		hWatch(ctx, key, &seen, 4)
	}
	hMustPromote(ctx, "9", hV9)
	for _, s := range append([][2]string(nil), seen...) {
		ctx.Assert(s == [2]string{"a1", "b1"} || s == [2]string{"a2", "b2"}, "an agent resolving during the promotion of catalog 9 got versions %v: it must see catalog 7 whole or catalog 9 whole. Write catalog:version:9 whole, then move catalog:active", s)
	}
	ctx.Equal(hPair(""), [2]string{"a2", "b2"}, "after promoting catalog 9, the versions agents resolve")
	active, _ := ctx.Redis.Get("catalog:active")
	ctx.Equal(active, "9", "catalog:active after promoting 9")
	kept := map[string]any{}
	for name, raw := range ctx.Redis.HGetAll("catalog:version:7") {
		var e any
		json.Unmarshal([]byte(raw), &e)
		kept[name] = e
	}
	ctx.Assert(hSameJSON(kept, hV7), "catalog:version:7 holds %v: a promotion must leave the version it replaced whole, one hash per version", kept)
}

func CheckValidationGuard(ctx *harness.Ctx) {
	hVerdict(ctx, "7", "passed")
	hMustPromote(ctx, "7", hV7)
	hVerdict(ctx, "8", "rejected")
	hVerdict(ctx, "10", "unavailable")
	for _, c := range []struct{ cv, why string }{{"8", "the sandbox rejected"}, {"10", "the sandbox never answered on"}, {"11", "nobody validated"}} {
		err := promote(hStateBg, c.cv, hV9)
		ctx.Assert(errors.Is(err, ErrNotValidated), "promote(%s) for a candidate %s returned %v: return ErrNotValidated unless catalog:validation:%s says passed", c.cv, c.why, err, c.cv)
		ctx.Equal(ctx.Redis.Exists("catalog:version:"+c.cv), int64(0), "a refused promotion of %s must write nothing; catalog:version:%s exists", c.cv, c.cv)
	}
	active, _ := ctx.Redis.Get("catalog:active")
	ctx.Equal(active, "7", "catalog:active after refused promotions")
	ctx.Equal(hPair(""), [2]string{"a1", "b1"}, "after refused promotions, the versions agents resolve")
	hVerdict(ctx, "9", "passed")
	hMustPromote(ctx, "9", hV9)
	ctx.Equal(hPair(""), [2]string{"a2", "b2"}, "a validated candidate must promote; the versions agents resolve")
}

func CheckRunPin(ctx *harness.Ctx) {
	hVerdict(ctx, "7", "passed")
	hVerdict(ctx, "9", "passed")
	hMustPromote(ctx, "7", hV7)
	var ttlAtWrite []int64
	ctx.Redis.After("catalog:pin:run-1", func() any {
		ttlAtWrite = append(ttlAtWrite, ctx.Redis.TTL("catalog:pin:run-1"))
		return nil
	})
	ctx.NoError(pinRun(hStateBg, "run-1", "7"), "pinRun failed")
	hMustPromote(ctx, "9", map[string]map[string]any{"search": hS2, "refund": hR2, "export": hX1})
	ctx.Equal(hPair("run-1"), [2]string{"a1", "b1"}, "run-1 pinned catalog 7: a promotion must not move a running agent onto new definitions mid-plan; the versions run-1 resolves")
	added, _ := resolve(hStateBg, "export", "run-1")
	ctx.Assert(added == nil, "run-1 pinned catalog 7, which has no export tool, and resolves export %v: a pinned run resolves in its pinned version only", added)
	active, _ := resolve(hStateBg, "export", "")
	ctx.Assert(active != nil && active["version"] == "e1", "a caller without a run resolves export in the active catalog 9, got %v", active)
	ctx.Equal(hPair(""), [2]string{"a2", "b2"}, "a caller without a run resolves the active catalog 9")
	ctx.Equal(hPair("run-2"), [2]string{"a2", "b2"}, "a run that pinned nothing resolves the active catalog 9")
	ttl := ctx.Redis.TTL("catalog:pin:run-1")
	ctx.Assert(6*3600-60 <= ttl && ttl <= 6*3600, "catalog:pin:run-1 has TTL %d, expected pinTTL (6 hours): a pin without a TTL keeps every old catalog alive", ttl)
	ctx.Assert(len(ttlAtWrite) > 0 && 6*3600-60 <= ttlAtWrite[0] && ttlAtWrite[0] <= 6*3600, "right after the command that wrote catalog:pin:run-1 its TTL was %v: a pin written without its TTL lives forever if the next command never runs. Set it in the same command", ttlAtWrite)
}

func CheckRollback(ctx *harness.Ctx) {
	back, err := rollback(hStateBg)
	ctx.NoError(err, "rollback failed")
	ctx.Equal(back, "", "with nothing promoted, rollback must answer \\"\\"")
	hVerdict(ctx, "7", "passed")
	hVerdict(ctx, "8", "rejected")
	hVerdict(ctx, "9", "passed")
	hMustPromote(ctx, "7", hV7)
	back, err = rollback(hStateBg)
	ctx.NoError(err, "rollback failed")
	ctx.Equal(back, "", "with only catalog 7 ever promoted there is no replaced version to go back to; rollback must answer \\"\\"")
	active, _ := ctx.Redis.Get("catalog:active")
	ctx.Equal(active, "7", "catalog:active after a rollback with nothing to go back to")
	hMustPromote(ctx, "9", hV9) // 8 was a candidate the sandbox rejected: it never went live
	hMustPromote(ctx, "9", hV9) // a retried promotion of the active version replaces nothing
	back, err = rollback(hStateBg)
	ctx.NoError(err, "rollback failed")
	ctx.Equal(back, "7", "the version catalog 9 replaced is 7 (8 was a rejected candidate, and promoting 9 again replaced nothing); record it at promotion. rollback answered")
	active, _ = ctx.Redis.Get("catalog:active")
	ctx.Equal(active, "7", "catalog:active after the rollback")
	ctx.Equal(hPair(""), [2]string{"a1", "b1"}, "after the rollback, the versions agents resolve")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

json hEntry(const std::string& name, const std::string& version, const std::string& side_effect, const std::string& owner) {
  return json{{"name", name},   {"version", version},  {"side_effect", side_effect}, {"owner", owner}, {"schema", {{"type", "object"}}},
              {"endpoint", "https://" + owner + ".internal"}, {"credential_ref", "vault://" + owner}};
}

const json kHV7 = {{"search", hEntry("search", "a1", "read", "search")}, {"refund", hEntry("refund", "b1", "irreversible", "payments")}};
const json kHV9 = {{"search", hEntry("search", "a2", "read", "search")}, {"refund", hEntry("refund", "b2", "irreversible", "payments")}};
const json kHX1 = hEntry("export", "e1", "read", "data");

void hVerdict(harness::Ctx& ctx, const std::string& cv, const std::string& outcome) {
  ctx.Redis.Do("HSET", "catalog:validation:" + cv, "outcome", outcome, "reason", "");
}

// What an agent resolves for both tools, as versions ("" when absent).
std::vector<std::string> hPair(const std::string& run_id = "") {
  std::vector<std::string> out;
  for (const std::string name : {"search", "refund"}) {
    const auto e = resolve(name, run_id);
    out.push_back(e ? e->value("version", "") : "");
  }
  return out;
}

const std::vector<std::string> kH7 = {"a1", "b1"};
const std::vector<std::string> kH9 = {"a2", "b2"};

struct HSeen {
  std::mutex mu;
  std::vector<std::vector<std::string>> versions;
  std::vector<std::string> errs;
};

// What an agent resolves right after each of the next \`left\` commands touching key.
void hWatch(harness::Ctx& ctx, const std::string& key, const std::shared_ptr<HSeen>& out, int left = 4) {
  ctx.Redis.After(key, [&ctx, key, out, left] {
    try {
      auto versions = hPair();
      std::lock_guard<std::mutex> lock(out->mu);
      out->versions.push_back(std::move(versions));
    } catch (const std::exception& e) {
      std::lock_guard<std::mutex> lock(out->mu);
      out->errs.push_back(e.what());
    }
    if (left > 1) hWatch(ctx, key, out, left - 1);
  });
}

}  // namespace

void CheckVersionSwap(harness::Ctx& ctx) {
  hVerdict(ctx, "7", "passed");
  hVerdict(ctx, "9", "passed");
  promote("7", kHV7);
  ctx.Equal(hPair(), kH7, "after promoting catalog 7, the versions agents resolve");
  // An agent resolves both tools while catalog 9 is being written and the pointer moves.
  const auto seen = std::make_shared<HSeen>();
  for (const std::string key : {"catalog:tools", "catalog:version:9", "catalog:active"}) hWatch(ctx, key, seen);
  promote("9", kHV9);
  std::vector<std::vector<std::string>> during;
  std::vector<std::string> errs;
  {
    std::lock_guard<std::mutex> lock(seen->mu);
    during = seen->versions;
    errs = seen->errs;
  }
  ctx.Assert(errs.empty(), "a resolve during the promotion failed: %s", errs.empty() ? "" : errs.front());
  for (const auto& versions : during) {
    ctx.Assert(versions == kH7 || versions == kH9, "an agent resolving during the promotion of catalog 9 got versions %q: it must see catalog 7 whole or catalog 9 whole. Write catalog:version:9 whole, then move catalog:active", versions);
  }
  ctx.Equal(hPair(), kH9, "after promoting catalog 9, the versions agents resolve");
  ctx.Equal(ctx.Redis.Get("catalog:active"), std::optional<std::string>("9"), "catalog:active after promoting 9");
  json kept = json::object();
  for (const auto& [name, raw] : ctx.Redis.HGetAll("catalog:version:7")) kept[name] = json::parse(raw);
  ctx.Assert(kept == kHV7, "catalog:version:7 holds %s: a promotion must leave the version it replaced whole, one hash per version", kept.dump());
}

void CheckValidationGuard(harness::Ctx& ctx) {
  hVerdict(ctx, "7", "passed");
  promote("7", kHV7);
  hVerdict(ctx, "8", "rejected");
  hVerdict(ctx, "10", "unavailable");
  const std::vector<std::pair<std::string, std::string>> cases = {{"8", "the sandbox rejected"}, {"10", "the sandbox never answered on"}, {"11", "nobody validated"}};
  for (const auto& [cv, why] : cases) {
    bool refused = false;
    try {
      promote(cv, kHV9);
    } catch (const NotValidated&) {
      refused = true;
    }
    ctx.Assert(refused, "promote(%s) went through for a candidate %s: throw NotValidated unless catalog:validation:%s says passed", cv, why, cv);
    ctx.Equal(ctx.Redis.Exists("catalog:version:" + cv), 0, "a refused promotion of %s must write nothing; catalog:version:%s exists", cv, cv);
  }
  ctx.Equal(ctx.Redis.Get("catalog:active"), std::optional<std::string>("7"), "catalog:active after refused promotions");
  ctx.Equal(hPair(), kH7, "after refused promotions, the versions agents resolve");
  hVerdict(ctx, "9", "passed");
  promote("9", kHV9);
  ctx.Equal(hPair(), kH9, "a validated candidate must promote; the versions agents resolve");
}

void CheckRunPin(harness::Ctx& ctx) {
  hVerdict(ctx, "7", "passed");
  hVerdict(ctx, "9", "passed");
  promote("7", kHV7);
  auto ttl_at_write = std::make_shared<std::atomic<long long>>(-3);
  ctx.Redis.After("catalog:pin:run-1", [&ctx, ttl_at_write] { *ttl_at_write = ctx.Redis.TTL("catalog:pin:run-1"); });
  pinRun("run-1", "7");
  json v9x = kHV9;
  v9x["export"] = kHX1;
  promote("9", v9x);
  ctx.Equal(hPair("run-1"), kH7, "run-1 pinned catalog 7: a promotion must not move a running agent onto new definitions mid-plan; the versions run-1 resolves");
  const auto added = resolve("export", "run-1");
  ctx.Assert(!added, "run-1 pinned catalog 7, which has no export tool, and resolves export %s: a pinned run resolves in its pinned version only", added ? added->dump() : "");
  const auto active = resolve("export", "");
  ctx.Assert(active && active->value("version", "") == "e1", "a caller without a run resolves export in the active catalog 9, got %s", active ? active->dump() : "nothing");
  ctx.Equal(hPair(), kH9, "a caller without a run resolves the active catalog 9");
  ctx.Equal(hPair("run-2"), kH9, "a run that pinned nothing resolves the active catalog 9");
  const long long ttl = ctx.Redis.TTL("catalog:pin:run-1");
  ctx.Assert(6 * 3600 - 60 <= ttl && ttl <= 6 * 3600, "catalog:pin:run-1 has TTL %d, expected kPinTtl (6 hours): a pin without a TTL keeps every old catalog alive", ttl);
  const long long first = *ttl_at_write;
  ctx.Assert(6 * 3600 - 60 <= first && first <= 6 * 3600, "right after the command that wrote catalog:pin:run-1 its TTL was %d: a pin written without its TTL lives forever if the next command never runs. Set it in the same command", first);
}

void CheckRollback(harness::Ctx& ctx) {
  ctx.Assert(!rollback(), "with nothing promoted, rollback must answer nothing");
  hVerdict(ctx, "7", "passed");
  hVerdict(ctx, "8", "rejected");
  hVerdict(ctx, "9", "passed");
  promote("7", kHV7);
  const auto first = rollback();
  ctx.Assert(!first, "with only catalog 7 ever promoted there is no replaced version to go back to, and rollback answered %s: answer nothing", first.value_or(""));
  ctx.Equal(ctx.Redis.Get("catalog:active"), std::optional<std::string>("7"), "catalog:active after a rollback with nothing to go back to");
  promote("9", kHV9);  // 8 was a candidate the sandbox rejected: it never went live
  promote("9", kHV9);  // a retried promotion of the active version replaces nothing
  const auto back = rollback();
  ctx.Equal(back, std::optional<std::string>("7"), "the version catalog 9 replaced is 7 (8 was a rejected candidate, and promoting 9 again replaced nothing); record it at promotion. rollback answered");
  ctx.Equal(ctx.Redis.Get("catalog:active"), std::optional<std::string>("7"), "catalog:active after the rollback");
  ctx.Equal(hPair(), kH7, "after the rollback, the versions agents resolve");
}
`,
  },
  hints: [
    'Resolve two tools while catalog 9 is being promoted: one answer comes from catalog 7, the other from 9. Promote 9 after the sandbox rejected 8, roll back, and agents land on 8.',
    'Every promotion edits one shared hash field by field, so no old version is left to pin or roll back to. The pin is written but never read, and the rollback assumes versions are consecutive.',
    'Check `validation_key(cv)` first; one `HSET version_key(cv)` with every entry; `SET PREVIOUS_KEY` to the old active, then `SET ACTIVE_KEY`. `resolve`: pin, else active, then `HGET`. `pin_run` with `ex=PIN_TTL_S`; `rollback`: `GET PREVIOUS_KEY`, `SET ACTIVE_KEY`.',
  ],
  debrief: `Immutable versions behind one pointer turn every catalog question into two reads: which version, then what is in it. A promotion becomes one write a reader either saw or did not, a pin is a reader holding an older pointer, and a rollback is the same write in reverse, which is why it needs the replaced version recorded instead of computed. The validation guard lives in the catalog itself, so no caller, including a script someone runs by hand, can promote around the sandbox. Production registries collect versions no pin or rollback can reach, keep a history of pointer moves rather than one previous slot, and make the pointer move conditional so two promotions cannot interleave.`,
};
