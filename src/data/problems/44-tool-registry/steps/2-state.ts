import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis catalog cache with atomic promotion',
  concept: 'redis',
  file: 'state',
  focus: ['registry', 'redis', 'client', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it writes every tool of the
catalog into Redis as its own key, field by field, and flips a pointer called \`catalog:active\` to
the string \`"latest"\` when it is done. It serves the demo. It hides three production flaws. Review
it like the platform owner, fix it, and prove the fix with the checks below.

Implement the catalog module that the registry and the resolve endpoint both use.

- One catalog **version** is one Redis hash: key \`catalog:version:{version}\`, one field per tool,
  the stored tool record as the field value. \`promote(version, catalog)\` writes that whole hash with
  **one** \`HSET\` (one command, every tool of the version) and then publishes it with a **single**
  \`SET\` of \`catalog:active\`. A reader sees the old pointer or the new one, and never a hash still
  being filled in. The draft's per-tool \`HSET\` loop is the flaw: an agent that resolves while a
  promotion is running reads a catalog assembled from two versions — the new side-effect class with
  the old schema.
- Promotion requires a **passing validation**: read \`catalog:validation:{version}\` — the marker the
  registry sets once the candidate catalog's tool versions have passed sandbox validation (step 3) —
  and refuse anything that is not \`passed\` *before* writing anything, so a rejected candidate cannot
  leave a hash behind.
- Record the version being replaced at \`catalog:previous\` before the swap, and give the module a
  \`rollback()\` that points \`catalog:active\` back at it in one write; the next resolution then serves
  the previous catalog. The draft has no rollback at all, so a bad promotion is only fixable by hand.
- \`pin_run(run_id, version)\` writes \`catalog:pin:{run_id}\` with a TTL (6 hours) — a pin belongs to a
  run, not forever. \`resolve(name, run_id)\` reads the pin first, falls back to \`catalog:active\`, then
  reads the tool with **one** \`HGET\` against \`catalog:version:{version}\`: never a per-tool scan, and
  never a pinned run silently moved onto a newer catalog. The draft pins nothing, so a promotion
  flips running agents mid-plan.
- A resolution whose version or tool is missing raises a distinguishable error rather than returning
  a partial catalog.

**Failure mode the checks target.** All three flaws are the same mistake in different clothes:
treating a multi-key structure as if it were atomic, and treating a run as if it had no identity.
The unit that must be atomic is one hash per version plus the pointer; a run is a thing that pinned a
version when it started.`,
  sequence: {
    participants: ['Registry', 'Redis', 'Agent runtime'],
    messages: [
      {from: 'Registry', to: 'Redis', label: 'HSET catalog:version:{v} · every tool, one command', kind: 'sync'},
      {from: 'Redis', to: 'Registry', label: 'OK', kind: 'reply'},
      {from: 'Registry', to: 'Redis', label: 'SET catalog:active {v} — the one atomic swap', kind: 'sync'},
      {from: 'Agent runtime', to: 'Redis', label: 'GET catalog:pin:{run_id}', kind: 'sync'},
      {from: 'Redis', to: 'Agent runtime', label: 'pinned version / nil', kind: 'reply'},
      {from: 'Agent runtime', to: 'Redis', label: 'HGET catalog:version:{version} {tool}', kind: 'sync'},
      {from: 'Redis', to: 'Agent runtime', label: 'the pinned version’s record', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-promotion',
      title: 'Promotes the catalog in one command plus one pointer swap',
      detail:
        'The whole version is written with a single `HSET` on `catalog:version:{version}` and published with one `SET` of `catalog:active`. The draft writes one tool per command and then flips a pointer, so a resolution that runs mid-promotion answers from half a catalog.',
      match: {
        python: {all: [/SNAPSHOT_PREFIX/, /mapping=/, /\.set\(\s*ACTIVE_KEY/]},
        typescript: {all: [/SNAPSHOT_PREFIX/, /hset\(\s*SNAPSHOT_PREFIX/, /set\(\s*ACTIVE_KEY/]},
        go: {all: [/snapshotPrefix/, /HSet\(ctx,\s*snapshotPrefix/, /Set\(ctx,\s*activeKey/]},
        scala: {all: [/SnapshotPrefix/, /\.hset\(\s*SnapshotPrefix/, /\.set\(\s*ActiveKey/]},
        cpp: {all: [/kSnapshotPrefix/, /hset\(/, /\.set\(\s*kActiveKey/]},
      },
    },
    {
      id: 'resolve',
      title: 'Resolves a run through pin, pointer and one lookup',
      detail:
        'One resolution reads `catalog:pin:{run_id}`, falls back to `catalog:active`, then reads the tool with a single `HGET` on the version’s hash — in that order. The draft reads a per-tool key that promotion happens to be rewriting, and has no pin path at all.',
      match: {
        python: {order: [/\.get\(\s*PIN_PREFIX/, /\.get\(\s*ACTIVE_KEY/, /\.hget\(\s*SNAPSHOT_PREFIX/]},
        typescript: {order: [/\.get\(\s*PIN_PREFIX/, /\.get\(\s*ACTIVE_KEY/, /\.hget\(\s*SNAPSHOT_PREFIX/]},
        go: {order: [/\.Get\(ctx,\s*pinPrefix/, /\.Get\(ctx,\s*activeKey/, /\.HGet\(ctx,\s*snapshotPrefix/]},
        scala: {order: [/\.get\(\s*PinPrefix/, /\.get\(\s*ActiveKey/, /\.hget\(\s*SnapshotPrefix/]},
        cpp: {order: [/\.get\(\s*kPinPrefix/, /\.get\(\s*kActiveKey/, /\.hget\(\s*kSnapshotPrefix/]},
      },
    },
    {
      id: 'pin',
      title: 'A pinned run keeps its version for the run',
      detail:
        'The pin is written under `catalog:pin:{run_id}` with a TTL, so a promotion cannot move a run that already started. The draft pins nothing, so a new catalog flips agents mid-plan.',
      match: {
        python: {all: [/PIN_PREFIX/, /pin_key/, /PIN_TTL_S/]},
        typescript: {all: [/PIN_PREFIX/, /pinKey/, /PIN_TTL_S/]},
        go: {all: [/pinPrefix/, /pinKey/, /pinTTL/]},
        scala: {all: [/PinPrefix/, /pinKey/, /PinTtlS/]},
        cpp: {all: [/kPinPrefix/, /pinKey/, /kPinTtlS/]},
      },
    },
    {
      id: 'rollback',
      title: 'A rollback lands the next resolution on the previous catalog',
      detail:
        'The replaced version is recorded at `catalog:previous`, and a rollback points `catalog:active` back at it in one write. The draft has no rollback, so a bad promotion can only be undone by hand.',
      match: {
        python: {all: [/PREVIOUS_KEY/, /def rollback\(/, /\.set\(\s*ACTIVE_KEY/]},
        typescript: {all: [/PREVIOUS_KEY/, /function rollback\(/, /set\(\s*ACTIVE_KEY/]},
        go: {all: [/previousKey/, /func rollback\(/, /Set\(ctx,\s*activeKey/]},
        scala: {all: [/PreviousKey/, /def rollback\(/, /\.set\(\s*ActiveKey/]},
        cpp: {all: [/kPreviousKey/, /rollback\(/, /\.set\(\s*kActiveKey/]},
      },
    },
    {
      id: 'guard',
      title: 'Promotion requires a passing validation',
      detail:
        'The validation marker at `catalog:validation:{version}` must read `passed` before anything is written; otherwise the promotion is refused with a reason and no hash is published. The draft promotes whatever it is handed.',
      match: {
        python: {all: [/VALIDATION_PREFIX/, /no passing validation/]},
        typescript: {all: [/VALIDATION_PREFIX/, /no passing validation/]},
        go: {all: [/validationPrefix/, /no passing validation/]},
        scala: {all: [/ValidationPrefix/, /no passing validation/]},
        cpp: {all: [/kValidationPrefix/, /no passing validation/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def load_catalog(entries: dict) -> None:
    """Write every tool of the catalog into Redis."""
    for name, tool in entries.items():
        r.hset(f"catalog:{name}", mapping={"definition": json.dumps(tool)})


def promote(entries: dict) -> None:
    # TODO: this draft writes the catalog one tool per command, so an agent resolving mid-promotion
    # sees half a catalog; it pins nothing, so a promotion flips running agents mid-plan; and it
    # never checks that the candidate version was validated. Review all three.
    load_catalog(entries)
    r.set("catalog:active", "latest")


def resolve(name: str) -> dict:
    """Resolve one tool from the catalog."""
    raw = r.hget(f"catalog:{name}", "definition")
    if raw is None:
        raise KeyError(f"tool {name} is not in the catalog")
    return json.loads(raw)
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_KEY = "catalog:active"
PREVIOUS_KEY = "catalog:previous"
SNAPSHOT_PREFIX = "catalog:version:"
PIN_PREFIX = "catalog:pin:"
VALIDATION_PREFIX = "catalog:validation:"
PIN_TTL_S = 6 * 60 * 60


def record_validation(version: str, outcome: str) -> None:
    """The catalog-version marker the registry sets once the candidate passed validation."""
    r.set(VALIDATION_PREFIX + version, outcome, ex=PIN_TTL_S)


def promote(version: str, catalog: dict) -> str:
    """Publish a validated catalog: every tool in one HSET, then one atomic pointer swap."""
    if r.get(VALIDATION_PREFIX + version) != "passed":
        raise PermissionError(f"catalog {version} has no passing validation")
    previous = r.get(ACTIVE_KEY)
    r.hset(SNAPSHOT_PREFIX + version, mapping={name: json.dumps(tool) for name, tool in catalog.items()})
    if previous is not None:
        r.set(PREVIOUS_KEY, previous)
    r.set(ACTIVE_KEY, version)
    return version


def rollback() -> str:
    """Point the active catalog back at the version the promotion replaced."""
    previous = r.get(PREVIOUS_KEY)
    if previous is None:
        raise KeyError("no previous catalog to roll back to")
    r.set(ACTIVE_KEY, previous)
    r.delete(PREVIOUS_KEY)
    return previous


def pin_run(run_id: str, version: str) -> None:
    """Pin a run to the catalog it started on, for the life of the run."""
    pin_key = f"{PIN_PREFIX}{run_id}"
    r.set(pin_key, version, ex=PIN_TTL_S)


def resolve(name: str, run_id: str) -> dict:
    """Resolve one tool for a run: the pin it started with, else the active catalog."""
    version = r.get(PIN_PREFIX + run_id) or r.get(ACTIVE_KEY)
    raw = r.hget(SNAPSHOT_PREFIX + version, name)
    if raw is None:
        raise KeyError(f"tool {name} is not in catalog {version}")
    return json.loads(raw)
`,
    },
    typescript: {
      starter: `/** The catalog cache: a model-generated draft that writes one tool per command. */
import {Redis} from 'ioredis';

export const redis = new Redis('redis://redis:6379');

export async function loadCatalog(entries: Record<string, unknown>): Promise<void> {
  for (const [name, tool] of Object.entries(entries))
    await redis.hset('catalog:' + name, 'definition', JSON.stringify(tool));
}

export async function promote(entries: Record<string, unknown>): Promise<void> {
  // TODO: this draft writes the catalog one tool per command, so an agent resolving mid-promotion
  // sees half a catalog; it pins nothing, so a promotion flips running agents mid-plan; and it
  // never checks that the candidate version was validated. Review all three.
  await loadCatalog(entries);
  await redis.set('catalog:active', 'latest');
}

export async function resolve(name: string): Promise<unknown> {
  const raw = await redis.hget('catalog:' + name, 'definition');
  if (raw === null) throw new Error('tool ' + name + ' is not in the catalog');
  return JSON.parse(raw);
}
`,
      solution: `/** The catalog cache: one hash per version behind one atomic pointer, with per-run pins. */
import {Redis} from 'ioredis';

export const redis = new Redis('redis://redis:6379');

const ACTIVE_KEY = 'catalog:active';
const PREVIOUS_KEY = 'catalog:previous';
const SNAPSHOT_PREFIX = 'catalog:version:';
const PIN_PREFIX = 'catalog:pin:';
const VALIDATION_PREFIX = 'catalog:validation:';
const PIN_TTL_S = 6 * 60 * 60;

export interface ToolRecord {
  name: string;
  side_effect: string;
  schema: Record<string, unknown>;
}

export type Catalog = Record<string, ToolRecord>;

export async function recordValidation(version: string, outcome: string): Promise<void> {
  await redis.set(VALIDATION_PREFIX + version, outcome, 'EX', PIN_TTL_S);
}

export async function promote(version: string, catalog: Catalog): Promise<string> {
  const outcome = await redis.get(VALIDATION_PREFIX + version);
  if (outcome !== 'passed') throw new Error('catalog ' + version + ' has no passing validation');
  const previous = await redis.get(ACTIVE_KEY);
  const fields: Record<string, string> = {};
  for (const [name, tool] of Object.entries(catalog)) fields[name] = JSON.stringify(tool);
  await redis.hset(SNAPSHOT_PREFIX + version, fields);
  if (previous !== null) await redis.set(PREVIOUS_KEY, previous);
  await redis.set(ACTIVE_KEY, version);
  return version;
}

export async function rollback(): Promise<string> {
  const previous = await redis.get(PREVIOUS_KEY);
  if (previous === null) throw new Error('no previous catalog to roll back to');
  await redis.set(ACTIVE_KEY, previous);
  await redis.del(PREVIOUS_KEY);
  return previous;
}

export async function pinRun(runId: string, version: string): Promise<void> {
  const pinKey = PIN_PREFIX + runId;
  await redis.set(pinKey, version, 'EX', PIN_TTL_S);
}

export async function resolve(name: string, runId: string): Promise<ToolRecord | undefined> {
  const version = (await redis.get(PIN_PREFIX + runId)) ?? (await redis.get(ACTIVE_KEY));
  const raw = await redis.hget(SNAPSHOT_PREFIX + version, name);
  if (raw === null) throw new Error('tool ' + name + ' is not in catalog ' + version);
  return JSON.parse(raw) as ToolRecord;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func loadCatalog(ctx context.Context, entries map[string]any) error {
	for name, tool := range entries {
		raw, err := json.Marshal(tool)
		if err != nil {
			return err
		}
		if err := rdb.HSet(ctx, "catalog:"+name, "definition", raw).Err(); err != nil {
			return err
		}
	}
	return nil
}

func promote(ctx context.Context, entries map[string]any) error {
	// TODO: this draft writes the catalog one tool per command, so an agent resolving mid-promotion
	// sees half a catalog; it pins nothing, so a promotion flips running agents mid-plan; and it
	// never checks that the candidate version was validated. Review all three.
	if err := loadCatalog(ctx, entries); err != nil {
		return err
	}
	return rdb.Set(ctx, "catalog:active", "latest", 0).Err()
}

func resolve(ctx context.Context, name string) (map[string]any, error) {
	raw, err := rdb.HGet(ctx, "catalog:"+name, "definition").Result()
	if err != nil {
		return nil, fmt.Errorf("tool %s is not in the catalog", name)
	}
	var tool map[string]any
	if err := json.Unmarshal([]byte(raw), &tool); err != nil {
		return nil, err
	}
	log.Printf("resolved tool=%s", name)
	return tool, nil
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	activeKey        = "catalog:active"
	previousKey      = "catalog:previous"
	snapshotPrefix   = "catalog:version:"
	pinPrefix        = "catalog:pin:"
	validationPrefix = "catalog:validation:"
	pinTTL           = 6 * time.Hour
)

type Tool struct {
	Name       string         \`json:"name"\`
	Version    string         \`json:"version"\`
	SideEffect string         \`json:"side_effect"\`
	Schema     map[string]any \`json:"schema"\`
}

type Catalog map[string]Tool

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func recordValidation(ctx context.Context, version, outcome string) error {
	return rdb.Set(ctx, validationPrefix+version, outcome, pinTTL).Err()
}

func promote(ctx context.Context, version string, catalog Catalog) (string, error) {
	outcome, err := rdb.Get(ctx, validationPrefix+version).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return "", err
	}
	if outcome != "passed" {
		return "", fmt.Errorf("catalog %s has no passing validation", version)
	}
	previous, err := rdb.Get(ctx, activeKey).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return "", err
	}
	fields := make(map[string]any, len(catalog))
	for name, tool := range catalog {
		raw, err := json.Marshal(tool)
		if err != nil {
			return "", err
		}
		fields[name] = raw
	}
	if err := rdb.HSet(ctx, snapshotPrefix+version, fields).Err(); err != nil {
		return "", err
	}
	if previous != "" {
		if err := rdb.Set(ctx, previousKey, previous, 0).Err(); err != nil {
			return "", err
		}
	}
	if err := rdb.Set(ctx, activeKey, version, 0).Err(); err != nil {
		return "", err
	}
	return version, nil
}

func rollback(ctx context.Context) (string, error) {
	previous, err := rdb.Get(ctx, previousKey).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return "", err
	}
	if previous == "" {
		return "", errors.New("no previous catalog to roll back to")
	}
	if err := rdb.Set(ctx, activeKey, previous, 0).Err(); err != nil {
		return "", err
	}
	rdb.Del(ctx, previousKey)
	return previous, nil
}

func pinRun(ctx context.Context, runID, version string) error {
	pinKey := pinPrefix + runID
	return rdb.Set(ctx, pinKey, version, pinTTL).Err()
}

func resolve(ctx context.Context, name, runID string) (Tool, error) {
	version, err := rdb.Get(ctx, pinPrefix+runID).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return Tool{}, err
	}
	if version == "" {
		version, err = rdb.Get(ctx, activeKey).Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			return Tool{}, err
		}
	}
	raw, err := rdb.HGet(ctx, snapshotPrefix+version, name).Result()
	if err != nil {
		return Tool{}, fmt.Errorf("tool %s is not in catalog %s", name, version)
	}
	var tool Tool
	if err := json.Unmarshal([]byte(raw), &tool); err != nil {
		return Tool{}, err
	}
	return tool, nil
}

func main() {}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json._

import scala.jdk.CollectionConverters._

object Catalog {
  val jedis = new Jedis("redis", 6379)

  def loadCatalog(entries: Map[String, JsObject]): Unit =
    entries.foreach { case (name, tool) =>
      jedis.hset(s"catalog:$name", Map("definition" -> tool.compactPrint).asJava)
    }

  def promote(entries: Map[String, JsObject]): Unit = {
    // TODO: this draft writes the catalog one tool per command, so an agent resolving mid-promotion
    // sees half a catalog; it pins nothing, so a promotion flips running agents mid-plan; and it
    // never checks that the candidate version was validated. Review all three.
    loadCatalog(entries)
    jedis.set("catalog:active", "latest")
  }

  def resolve(name: String): JsObject = {
    val raw = jedis.hget(s"catalog:$name", "definition")
    if (raw == null) throw new IllegalStateException(s"tool $name is not in the catalog")
    raw.parseJson.asJsObject
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import spray.json._

import scala.jdk.CollectionConverters._

object Catalog {
  val ActiveKey = "catalog:active"
  val PreviousKey = "catalog:previous"
  val SnapshotPrefix = "catalog:version:"
  val PinPrefix = "catalog:pin:"
  val ValidationPrefix = "catalog:validation:"
  val PinTtlS = 6 * 60 * 60

  val jedis = new Jedis("redis", 6379)

  def recordValidation(version: String, outcome: String): Unit =
    jedis.setex(ValidationPrefix + version, PinTtlS, outcome)

  def promote(version: String, catalog: Map[String, JsObject]): String = {
    if (Option(jedis.get(ValidationPrefix + version)).getOrElse("") != "passed")
      throw new IllegalStateException(s"catalog $version has no passing validation")
    val previous = Option(jedis.get(ActiveKey))
    jedis.hset(SnapshotPrefix + version, catalog.view.mapValues(_.compactPrint).toMap.asJava)
    previous.foreach(previousVersion => jedis.set(PreviousKey, previousVersion))
    jedis.set(ActiveKey, version)
    version
  }

  def rollback(): String = {
    val previous = Option(jedis.get(PreviousKey)).getOrElse("")
    if (previous.isEmpty) throw new IllegalStateException("no previous catalog to roll back to")
    jedis.set(ActiveKey, previous)
    jedis.del(PreviousKey)
    previous
  }

  def pinRun(runId: String, version: String): Unit = {
    val pinKey = PinPrefix + runId
    jedis.setex(pinKey, PinTtlS, version)
  }

  def resolve(name: String, runId: String): JsObject = {
    val version = Option(jedis.get(PinPrefix + runId)).orElse(Option(jedis.get(ActiveKey))).getOrElse("")
    val raw = jedis.hget(SnapshotPrefix + version, name)
    if (raw == null) throw new IllegalStateException(s"tool $name is not in catalog $version")
    raw.parseJson.asJsObject
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <redis++/redis++.h>

#include <iostream>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

void loadCatalog(sw::redis::Redis& redis, const json& entries) {
  for (auto it = entries.begin(); it != entries.end(); ++it) {
    redis.hset("catalog:" + it.key(), "definition", it.value().dump());
  }
}

void promote(sw::redis::Redis& redis, const json& entries) {
  // TODO: this draft writes the catalog one tool per command, so an agent resolving mid-promotion
  // sees half a catalog; it pins nothing, so a promotion flips running agents mid-plan; and it
  // never checks that the candidate version was validated. Review all three.
  loadCatalog(redis, entries);
  redis.set("catalog:active", "latest");
}

json resolve(sw::redis::Redis& redis, const std::string& name) {
  const auto raw = redis.hget("catalog:" + name, "definition");
  if (!raw) throw std::runtime_error("tool " + name + " is not in the catalog");
  std::cerr << "resolved tool=" << name << "\\n";
  return json::parse(*raw);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <redis++/redis++.h>

#include <map>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

const std::string kActiveKey = "catalog:active";
const std::string kPreviousKey = "catalog:previous";
const std::string kSnapshotPrefix = "catalog:version:";
const std::string kPinPrefix = "catalog:pin:";
const std::string kValidationPrefix = "catalog:validation:";
constexpr long long kPinTtlS = 6 * 60 * 60;

void recordValidation(sw::redis::Redis& redis, const std::string& version, const std::string& outcome) {
  redis.setex(kValidationPrefix + version, kPinTtlS, outcome);
}

std::string promote(sw::redis::Redis& redis, const std::string& version, const json& catalog) {
  const auto outcome = redis.get(kValidationPrefix + version);
  if (!outcome || *outcome != "passed")
    throw std::runtime_error("catalog " + version + " has no passing validation");
  const auto previous = redis.get(kActiveKey);
  std::map<std::string, std::string> fields;
  for (auto it = catalog.begin(); it != catalog.end(); ++it) fields[it.key()] = it.value().dump();
  redis.hset(kSnapshotPrefix + version, fields.begin(), fields.end());
  if (previous) redis.set(kPreviousKey, *previous);
  redis.set(kActiveKey, version);
  return version;
}

std::string rollback(sw::redis::Redis& redis) {
  const auto previous = redis.get(kPreviousKey);
  if (!previous) throw std::runtime_error("no previous catalog to roll back to");
  redis.set(kActiveKey, *previous);
  redis.del(kPreviousKey);
  return *previous;
}

void pinRun(sw::redis::Redis& redis, const std::string& runId, const std::string& version) {
  const std::string pinKey = kPinPrefix + runId;
  redis.setex(pinKey, kPinTtlS, version);
}

json resolve(sw::redis::Redis& redis, const std::string& name, const std::string& runId) {
  std::string version;
  if (const auto pinned = redis.get(kPinPrefix + runId)) {
    version = *pinned;
  } else if (const auto active = redis.get(kActiveKey)) {
    version = *active;
  }
  const auto raw = redis.hget(kSnapshotPrefix + version, name);
  if (!raw) throw std::runtime_error("tool " + name + " is not in catalog " + version);
  return json::parse(*raw);
}
`,
    },
  },
  hints: [
    'Atomicity here is not a transaction across many keys — it is writing one version with one command and having exactly one pointer to swap. Put every tool of the version into `catalog:version:{version}` with a single `HSET`, and publish it by setting `catalog:active` once.',
    'A pin is a read-path decision: look up `catalog:pin:{run_id}` first, fall through to `catalog:active`, then answer with one `HGET` on that version’s hash. Give the pin a TTL, or every abandoned run pins a catalog until someone remembers to clean it up.',
    'Record the outgoing version at `catalog:previous` *before* the pointer swap — that one key is what makes a rollback a single write instead of a rewrite of the catalog. And refuse a candidate whose `catalog:validation:{version}` is not `passed` before writing anything.',
  ],
  debrief: `The reviewer is looking for the difference between "the data is in Redis" and "a reader can trust what it reads". The draft’s per-tool HSET loop is the classic form: every individual command succeeds, so nothing looks broken, while one resolution can read a catalog assembled from two versions — a tool that exists with the new side-effect class and the old schema. The fix is structural: one hash per version written in one command, one pointer for the active version, which makes promotion atomic without a transaction and makes rollback one write. The pin is the second half of the story: a run is a unit with a catalog pinned at start, so a promotion only affects runs that have not started yet. Real registries add a monotonic revision for optimistic reads, a warm-up check that the hash parses before the swap, and pin eviction driven by run completion rather than only by TTL.`,
};
