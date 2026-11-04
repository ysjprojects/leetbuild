import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis online store: versioned keys, newer-wins writes, expiry at the SLO',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the online store every later step writes through:
\`write_value(name, version, entity, value, event_ts)\` writes \`value\` and \`event_ts\` (epoch seconds)
into the hash \`feature:{name}:{entity}\` and gives it a 24-hour TTL; \`read_value(name, version,
entity)\` answers \`{value, event_ts, age_s}\` from that hash, or \`None\`. It serves the demo and hides
three flaws.

**Failure mode the checks target.** Version 3 of a feature overwrites version 2's values while
models still read version 2; a backfill row computed yesterday lands after the streaming path wrote
today's value and replaces it; a value whose freshness SLO passed hours ago is still served.

- One hash per **(name, version, entity)**: \`feature:{name}:{version}:{entity}\`.
- A write stores a value only when it is **newer** than the stored one (an equal \`event_ts\` is a
  replay): compare and write in **one Lua script**, and return whether it stored.
- The key **expires when the value goes stale**: \`EXPIREAT\` at \`event_ts\` plus the definition's
  \`freshness_slo\` (\`registry.get_definition(name, version)\`, provided).`,
  sequence: {
    participants: ['Backfill / stream', 'Online store', 'Redis', 'Registry'],
    messages: [
      {from: 'Backfill / stream', to: 'Online store', label: 'write_value(amount_7d, 2, e-1, 12.5, ts)', kind: 'sync'},
      {from: 'Online store', to: 'Registry', label: 'get_definition(amount_7d, 2) → freshness_slo 300', kind: 'sync'},
      {
        from: 'Online store',
        to: 'Redis',
        label: 'EVAL: stored event_ts ≥ ts → 0 · else HSET + EXPIREAT ts + 300',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Online store', label: '1 stored · 0 an older or equal value', kind: 'reply'},
      {from: 'Online store', to: 'Redis', label: 'HGETALL feature:amount_7d:2:e-1', kind: 'sync'},
      {from: 'Redis', to: 'Online store', label: '{value, event_ts} · or gone once stale', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'versioned-key',
      title: 'Keys every value by feature version',
      detail:
        'Values live under `feature:{name}:{version}:{entity}`, so writing version 3 leaves the values version 2 serves untouched. The starter drops the version from the key.',
      match: {
        python: {
          all: [/f["']feature:\{name\}:\{version\}:\{entity\}["']/],
          none: [/f["']feature:\{name\}:\{entity\}["']/],
        },
        typescript: {
          all: [/`feature:\$\{name\}:\$\{version\}:\$\{entity\}`/],
          none: [/`feature:\$\{name\}:\$\{entity\}`/],
        },
        go: {all: [/"feature:%s:%d:%s"/], none: [/"feature:%s:%s"/]},
        scala: {all: [/s"feature:\$name:\$version:\$entity"/], none: [/s"feature:\$name:\$entity"/]},
        cpp: {
          all: [/std::to_string\(version\)\s*\+\s*":"\s*\+\s*entity/],
          none: [/"feature:"\s*\+\s*name\s*\+\s*":"\s*\+\s*entity/],
        },
      },
    },
    {
      id: 'newer-wins',
      title: 'Stores a value only when it is newer, in one script',
      detail:
        'The write compares the stored `event_ts` and writes inside one Lua script (`register_script`/`eval`, `defineCommand`, `NewScript`), returning whether it stored; an older or equal `event_ts` is refused, also when a newer value lands between a read and a write. The starter writes with a plain `HSET`.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /tonumber\(/],
          none: [/\br\.hset\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /tonumber\(/],
          none: [/redis\.hset\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/, /tonumber\(/], none: [/rdb\.HSet\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HGET['"]/, /tonumber\(/], none: [/jedis\.hset\(/]},
        cpp: {all: [/\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HGET['"]/, /tonumber\(/], none: [/redis\(\)\.hset\(/]},
      },
    },
    {
      id: 'expire-at-slo',
      title: 'Expires a value when its freshness SLO passes',
      detail:
        "The key expires at `event_ts + freshness_slo` (`EXPIREAT`), the SLO read from the version's definition, so a value computed 200 s ago with a 300 s SLO is gone 100 s later. The starter gives every key the same 24-hour TTL counted from the write.",
      match: {
        python: {all: [/EXPIREAT/, /registry\.get_definition\(/, /freshness_slo/], none: [/TTL_S/, /\.expire\(/]},
        typescript: {all: [/EXPIREAT/, /getDefinition\(/, /freshness_slo/], none: [/TTL_S/, /\.expire\(/]},
        go: {all: [/EXPIREAT/, /registry\.GetDefinition\(/, /FreshnessSLO/], none: [/\bttl\b/, /\.Expire\(/]},
        scala: {all: [/EXPIREAT/, /Registry\.getDefinition\(/, /freshnessSlo/], none: [/TtlSeconds/, /\.expire\(/]},
        cpp: {all: [/EXPIREAT/, /registry::getDefinition\(/, /freshness_slo/], none: [/kTtl/, /\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 24 * 3600


def write_value(name: str, version: int, entity: str, value: float, event_ts: int) -> bool:
    """Store the entity's value of the feature version; whether it stored."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    key = f"feature:{name}:{entity}"
    r.hset(key, mapping={"value": value, "event_ts": event_ts})
    r.expire(key, TTL_S)
    return True


def read_value(name: str, version: int, entity: str) -> dict | None:
    """The entity's value with its event_ts and age_s, or None."""
    raw = r.hgetall(f"feature:{name}:{entity}")
    if not raw:
        return None
    event_ts = int(raw["event_ts"])
    return {"value": float(raw["value"]), "event_ts": event_ts, "age_s": int(time.time()) - event_ts}
`,
      solution: `import time

import redis

from features import registry  # get_definition(name, version) -> dict | None

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Newer wins: an older or equal event_ts is refused; a stored value expires when it goes stale.
WRITE_LUA = """
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
"""
write = r.register_script(WRITE_LUA)


def value_key(name: str, version: int, entity: str) -> str:
    return f"feature:{name}:{version}:{entity}"


def write_value(name: str, version: int, entity: str, value: float, event_ts: int) -> bool:
    """Store the entity's value of the feature version; whether it stored."""
    definition = registry.get_definition(name, version)
    if definition is None:
        raise KeyError(f"no definition {name} v{version}")
    expire_at = event_ts + definition["freshness_slo"]
    return write(keys=[value_key(name, version, entity)], args=[value, event_ts, expire_at]) == 1


def read_value(name: str, version: int, entity: str) -> dict | None:
    """The entity's value with its event_ts and age_s, or None."""
    raw = r.hgetall(value_key(name, version, entity))
    if not raw:
        return None
    event_ts = int(raw["event_ts"])
    return {"value": float(raw["value"]), "event_ts": event_ts, "age_s": int(time.time()) - event_ts}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 24 * 3600;

export interface Value {
  value: number;
  event_ts: number;
  age_s: number;
}

/** Store the entity's value of the feature version; whether it stored. */
export async function writeValue(name: string, version: number, entity: string, value: number, eventTs: number): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const key = \`feature:\${name}:\${entity}\`;
  await redis.hset(key, {value: String(value), event_ts: String(eventTs)});
  await redis.expire(key, TTL_S);
  return true;
}

/** The entity's value with its event_ts and age_s, or null. */
export async function readValue(name: string, version: number, entity: string): Promise<Value | null> {
  const raw = await redis.hgetall(\`feature:\${name}:\${entity}\`);
  if (raw.event_ts === undefined) return null;
  const eventTs = Number(raw.event_ts);
  return {value: Number(raw.value), event_ts: eventTs, age_s: Math.floor(Date.now() / 1000) - eventTs};
}
`,
      solution: `import Redis from 'ioredis';

import {getDefinition} from 'features/registry';

/** Newer wins: an older or equal event_ts is refused; a stored value expires when it goes stale. */
export const WRITE_LUA = \`
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
\`;

export interface Value {
  value: number;
  event_ts: number;
  age_s: number;
}

interface StateRedis extends Redis {
  writeFeatureValue(key: string, value: string, eventTs: string, expireAt: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('writeFeatureValue', {numberOfKeys: 1, lua: WRITE_LUA});

export const valueKey = (name: string, version: number, entity: string): string => \`feature:\${name}:\${version}:\${entity}\`;

/** Store the entity's value of the feature version; whether it stored. */
export async function writeValue(name: string, version: number, entity: string, value: number, eventTs: number): Promise<boolean> {
  const definition = await getDefinition(name, version);
  if (definition === null) throw new Error(\`no definition \${name} v\${version}\`);
  const expireAt = eventTs + definition.freshness_slo;
  return (await redis.writeFeatureValue(valueKey(name, version, entity), String(value), String(eventTs), String(expireAt))) === 1;
}

/** The entity's value with its event_ts and age_s, or null. */
export async function readValue(name: string, version: number, entity: string): Promise<Value | null> {
  const raw = await redis.hgetall(valueKey(name, version, entity));
  if (raw.event_ts === undefined) return null;
  const eventTs = Number(raw.event_ts);
  return {value: Number(raw.value), event_ts: eventTs, age_s: Math.floor(Date.now() / 1000) - eventTs};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttl = 24 * time.Hour

// Value is an entity's stored value with its event time and age.
type Value struct {
	Value   float64 \`json:"value"\`
	EventTs int64   \`json:"event_ts"\`
	AgeS    int64   \`json:"age_s"\`
}

// writeValue stores the entity's value of the feature version; it reports whether it stored.
func writeValue(ctx context.Context, name string, version int, entity string, value float64, eventTs int64) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	key := fmt.Sprintf("feature:%s:%s", name, entity)
	if err := rdb.HSet(ctx, key, "value", strconv.FormatFloat(value, 'g', -1, 64), "event_ts", eventTs).Err(); err != nil {
		return false, err
	}
	return true, rdb.Expire(ctx, key, ttl).Err()
}

// readValue is the entity's value with its event_ts and age_s, or nil.
func readValue(ctx context.Context, name string, version int, entity string) (*Value, error) {
	raw, err := rdb.HGetAll(ctx, fmt.Sprintf("feature:%s:%s", name, entity)).Result()
	if err != nil || raw["event_ts"] == "" {
		return nil, err
	}
	value, _ := strconv.ParseFloat(raw["value"], 64)
	eventTs, _ := strconv.ParseInt(raw["event_ts"], 10, 64)
	return &Value{Value: value, EventTs: eventTs, AgeS: time.Now().Unix() - eventTs}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"features/registry" // registry.GetDefinition(ctx, name, version) (*registry.Definition, error)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// write is newer-wins: an older or equal event_ts is refused; a stored value expires when it goes stale.
var write = redis.NewScript(\`
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
\`)

// Value is an entity's stored value with its event time and age.
type Value struct {
	Value   float64 \`json:"value"\`
	EventTs int64   \`json:"event_ts"\`
	AgeS    int64   \`json:"age_s"\`
}

func valueKey(name string, version int, entity string) string {
	return fmt.Sprintf("feature:%s:%d:%s", name, version, entity)
}

// writeValue stores the entity's value of the feature version; it reports whether it stored.
func writeValue(ctx context.Context, name string, version int, entity string, value float64, eventTs int64) (bool, error) {
	definition, err := registry.GetDefinition(ctx, name, version)
	if err != nil {
		return false, err
	}
	if definition == nil {
		return false, fmt.Errorf("no definition %s v%d", name, version)
	}
	expireAt := eventTs + definition.FreshnessSLO
	stored, err := write.Run(ctx, rdb, []string{valueKey(name, version, entity)}, strconv.FormatFloat(value, 'g', -1, 64), eventTs, expireAt).Int64()
	return stored == 1, err
}

// readValue is the entity's value with its event_ts and age_s, or nil.
func readValue(ctx context.Context, name string, version int, entity string) (*Value, error) {
	raw, err := rdb.HGetAll(ctx, valueKey(name, version, entity)).Result()
	if err != nil || raw["event_ts"] == "" {
		return nil, err
	}
	value, _ := strconv.ParseFloat(raw["value"], 64)
	eventTs, _ := strconv.ParseInt(raw["event_ts"], 10, 64)
	return &Value{Value: value, EventTs: eventTs, AgeS: time.Now().Unix() - eventTs}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class Value(value: Double, eventTs: Long, ageS: Long)

  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds: Long = 24L * 3600

  /** Store the entity's value of the feature version; whether it stored. */
  def writeValue(name: String, version: Long, entity: String, value: Double, eventTs: Long): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val key = s"feature:$name:$entity"
    jedis.hset(key, Map("value" -> value.toString, "event_ts" -> eventTs.toString).asJava)
    jedis.expire(key, TtlSeconds)
    true
  }

  /** The entity's value with its event_ts and age_s, if any. */
  def readValue(name: String, version: Long, entity: String): Option[Value] = {
    val raw = jedis.hgetAll(s"feature:$name:$entity").asScala
    raw.get("event_ts").map(ts => Value(raw("value").toDouble, ts.toLong, System.currentTimeMillis() / 1000 - ts.toLong))
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import features.Registry // Registry.getDefinition(name, version): Option[Registry.Definition]

object State {
  final case class Value(value: Double, eventTs: Long, ageS: Long)

  val jedis = new JedisPooled("redis", 6379)

  /** Newer wins: an older or equal event_ts is refused; a stored value expires when it goes stale. */
  val WriteLua: String =
    """local stored = redis.call('HGET', KEYS[1], 'event_ts')
      |if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
      |redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
      |redis.call('EXPIREAT', KEYS[1], ARGV[3])
      |return 1
      |""".stripMargin

  def valueKey(name: String, version: Long, entity: String): String = s"feature:$name:$version:$entity"

  /** Store the entity's value of the feature version; whether it stored. */
  def writeValue(name: String, version: Long, entity: String, value: Double, eventTs: Long): Boolean = {
    val definition = Registry.getDefinition(name, version).getOrElse(throw new NoSuchElementException(s"no definition $name v$version"))
    val args = List(value.toString, eventTs.toString, (eventTs + definition.freshnessSlo).toString).asJava
    jedis.eval(WriteLua, List(valueKey(name, version, entity)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The entity's value with its event_ts and age_s, if any. */
  def readValue(name: String, version: Long, entity: String): Option[Value] = {
    val raw = jedis.hgetAll(valueKey(name, version, entity)).asScala
    raw.get("event_ts").map(ts => Value(raw("value").toDouble, ts.toLong, System.currentTimeMillis() / 1000 - ts.toLong))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>

// An entity's stored value with its event time and age.
struct Value {
  double value = 0;
  long long event_ts = 0;
  long long age_s = 0;
};

constexpr long long kTtlSeconds = 24 * 3600;

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Store the entity's value of the feature version; whether it stored.
bool writeValue(const std::string& name, long version, const std::string& entity, double value, long long event_ts) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string key = "feature:" + name + ":" + entity;
  std::ostringstream text;
  text << value;
  redis().hset(key, {{"value", text.str()}, {"event_ts", std::to_string(event_ts)}});
  redis().expire(key, kTtlSeconds);
  return true;
}

// The entity's value with its event_ts and age_s, or none.
std::optional<Value> readValue(const std::string& name, long version, const std::string& entity) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("feature:" + name + ":" + entity);
  if (!raw.count("event_ts")) return std::nullopt;
  const long long event_ts = std::stoll(raw.at("event_ts"));
  return Value{std::stod(raw.at("value")), event_ts, now_seconds() - event_ts};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include "features/registry.h"  // registry::getDefinition(name, version) -> std::optional<registry::Definition>

// An entity's stored value with its event time and age.
struct Value {
  double value = 0;
  long long event_ts = 0;
  long long age_s = 0;
};

// Newer wins: an older or equal event_ts is refused; a stored value expires when it goes stale.
const std::string kWriteLua = R"lua(
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
)lua";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string valueKey(const std::string& name, long version, const std::string& entity) {
  return "feature:" + name + ":" + std::to_string(version) + ":" + entity;
}

// Store the entity's value of the feature version; whether it stored.
bool writeValue(const std::string& name, long version, const std::string& entity, double value, long long event_ts) {
  const auto definition = registry::getDefinition(name, version);
  if (!definition) throw std::out_of_range("no definition " + name + " v" + std::to_string(version));
  std::ostringstream text;
  text << value;
  const long long expire_at = event_ts + definition->freshness_slo;
  return redis().eval<long long>(kWriteLua, {valueKey(name, version, entity)}, {text.str(), std::to_string(event_ts), std::to_string(expire_at)}) == 1;
}

// The entity's value with its event_ts and age_s, or none.
std::optional<Value> readValue(const std::string& name, long version, const std::string& entity) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(valueKey(name, version, entity));
  if (!raw.count("event_ts")) return std::nullopt;
  const long long event_ts = std::stoll(raw.at("event_ts"));
  return Value{std::stod(raw.at("value")), event_ts, now_seconds() - event_ts};
}
`,
    },
  },
  harness: {
    python: `import time

from features import registry


def _state(ctx):
    for version, slo in ((2, 300), (3, 300), (4, 3600)):
        registry.create_definition({"name": "amount_7d", "version": version, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": slo, "created_at": int(time.time())})
    return ctx.load("state")


def check_versioned_key(ctx):
    m = _state(ctx)
    now = int(time.time())
    assert m.write_value("amount_7d", 2, "e-1", 12.5, now - 10) is True, "the first write of e-1 for version 2 must store"
    assert m.write_value("amount_7d", 3, "e-1", 40.0, now - 5) is True, "the first write of e-1 for version 3 must store"
    v2 = m.read_value("amount_7d", 2, "e-1")
    v3 = m.read_value("amount_7d", 3, "e-1")
    assert v2 is not None and v2["value"] == 12.5, f"version 2 of e-1 reads {v2}: the write of version 3 replaced it. Key the value by (name, version, entity)"
    assert v3 is not None and v3["value"] == 40.0, f"version 3 of e-1 reads {v3}, expected 40.0"
    assert v2["event_ts"] == now - 10 and v2["age_s"] == 10, f"version 2 of e-1 reads {v2}, expected event_ts {now - 10} and age_s 10"
    keys = sorted(ctx.redis.keys("feature:*"))
    assert keys == ["feature:amount_7d:2:e-1", "feature:amount_7d:3:e-1"], f"the online store holds {keys}, expected one hash per version: feature:amount_7d:2:e-1 and feature:amount_7d:3:e-1"


def check_newer_wins(ctx):
    m = _state(ctx)
    now = int(time.time())
    assert m.write_value("amount_7d", 2, "e-1", 5.0, now - 10) is True, "the first write of e-1 must store"
    late = m.write_value("amount_7d", 2, "e-1", 3.0, now - 100)
    seen = m.read_value("amount_7d", 2, "e-1")
    assert seen is not None and seen["value"] == 5.0 and seen["event_ts"] == now - 10, f"a backfill row from 100 s ago replaced the value from 10 s ago: e-1 reads {seen}"
    assert late is False, f"write_value returned {late!r} for a value older than the stored one, expected False"
    replay = m.write_value("amount_7d", 2, "e-1", 5.0, now - 10)
    assert replay is False, f"a replay of the stored event_ts returned {replay!r}, expected False"
    # The streaming path writes e-2 from 5 s ago right after this write from 50 s ago first touches the key.
    key = "feature:amount_7d:2:e-2"
    probe = ctx.redis_after(key, lambda: ctx.redis.hset(key, mapping={"value": 7.0, "event_ts": now - 5}))
    m.write_value("amount_7d", 2, "e-2", 4.0, now - 50)
    assert probe.fired, f"the write of e-2 never touched {key}"
    seen = m.read_value("amount_7d", 2, "e-2")
    assert seen is not None and seen["value"] == 7.0, f"a value from 5 s ago landed between this write's read and its write and was replaced by one from 50 s ago: e-2 reads {seen}. Compare and write in one Lua script"


def check_expire_at_slo(ctx):
    m = _state(ctx)
    now = int(time.time())
    m.write_value("amount_7d", 2, "e-1", 5.0, now - 200)
    ttl = ctx.redis.ttl("feature:amount_7d:2:e-1")
    assert 95 <= ttl <= 101, f"feature:amount_7d:2:e-1 has a TTL of {ttl} s; computed 200 s ago under a 300 s freshness SLO it goes stale in 100 s: EXPIREAT event_ts + freshness_slo"
    m.write_value("amount_7d", 4, "e-1", 5.0, now)
    ttl = ctx.redis.ttl("feature:amount_7d:4:e-1")
    assert 3595 <= ttl <= 3601, f"feature:amount_7d:4:e-1 has a TTL of {ttl} s, expected its definition's freshness_slo of 3600 s"
    ctx.clock.advance(101)
    seen = m.read_value("amount_7d", 2, "e-1")
    assert seen is None, f"101 s later the value is past its freshness SLO and still served: {seen}"
    assert m.read_value("amount_7d", 4, "e-1") is not None, "the value of version 4 is within its SLO and must still be served"
`,
    typescript: `async function state(ctx) {
  const registry = ctx.load('/support/features/registry.ts');
  const now = Math.floor(ctx.clock.now() / 1000);
  for (const [version, slo] of [[2, 300], [3, 300], [4, 3600]]) {
    await registry.createDefinition({name: 'amount_7d', version, dtype: 'float64', computation_ref: 'window_avg_7d', freshness_slo: slo, created_at: now});
  }
  return {m: ctx.load('state'), now};
}

export async function check_versioned_key(ctx) {
  const {m, now} = await state(ctx);
  assert.equal(await m.writeValue('amount_7d', 2, 'e-1', 12.5, now - 10), true, 'the first write of e-1 for version 2 must store');
  assert.equal(await m.writeValue('amount_7d', 3, 'e-1', 40.0, now - 5), true, 'the first write of e-1 for version 3 must store');
  const v2 = await m.readValue('amount_7d', 2, 'e-1');
  const v3 = await m.readValue('amount_7d', 3, 'e-1');
  assert(v2 !== null && v2.value === 12.5, \`version 2 of e-1 reads \${JSON.stringify(v2)}: the write of version 3 replaced it. Key the value by (name, version, entity)\`);
  assert(v3 !== null && v3.value === 40.0, \`version 3 of e-1 reads \${JSON.stringify(v3)}, expected 40\`);
  assert(v2.event_ts === now - 10 && v2.age_s === 10, \`version 2 of e-1 reads \${JSON.stringify(v2)}, expected event_ts \${now - 10} and age_s 10\`);
  const keys = (ctx.redis.keys('feature:*') as string[]).sort();
  assert.deepStrictEqual(keys, ['feature:amount_7d:2:e-1', 'feature:amount_7d:3:e-1'], \`the online store holds \${JSON.stringify(keys)}, expected one hash per version\`);
}

export async function check_newer_wins(ctx) {
  const {m, now} = await state(ctx);
  assert.equal(await m.writeValue('amount_7d', 2, 'e-1', 5.0, now - 10), true, 'the first write of e-1 must store');
  const late = await m.writeValue('amount_7d', 2, 'e-1', 3.0, now - 100);
  let seen = await m.readValue('amount_7d', 2, 'e-1');
  assert(seen !== null && seen.value === 5.0 && seen.event_ts === now - 10, \`a backfill row from 100 s ago replaced the value from 10 s ago: e-1 reads \${JSON.stringify(seen)}\`);
  assert.equal(late, false, \`writeValue returned \${late} for a value older than the stored one, expected false\`);
  const replay = await m.writeValue('amount_7d', 2, 'e-1', 5.0, now - 10);
  assert.equal(replay, false, \`a replay of the stored event_ts returned \${replay}, expected false\`);
  // The streaming path writes e-2 from 5 s ago right after this write from 50 s ago first touches the key.
  const key = 'feature:amount_7d:2:e-2';
  const probe = ctx.redisAfter(key, () => ctx.redis.hset(key, 'value', '7', 'event_ts', String(now - 5)));
  await m.writeValue('amount_7d', 2, 'e-2', 4.0, now - 50);
  assert(probe.fired, \`the write of e-2 never touched \${key}\`);
  seen = await m.readValue('amount_7d', 2, 'e-2');
  assert(seen !== null && seen.value === 7, \`a value from 5 s ago landed between this write's read and its write and was replaced by one from 50 s ago: e-2 reads \${JSON.stringify(seen)}. Compare and write in one Lua script\`);
}

export async function check_expire_at_slo(ctx) {
  const {m, now} = await state(ctx);
  await m.writeValue('amount_7d', 2, 'e-1', 5.0, now - 200);
  let ttl = ctx.redis.ttl('feature:amount_7d:2:e-1') as number;
  assert(95 <= ttl && ttl <= 101, \`feature:amount_7d:2:e-1 has a TTL of \${ttl} s; computed 200 s ago under a 300 s freshness SLO it goes stale in 100 s: EXPIREAT event_ts + freshness_slo\`);
  await m.writeValue('amount_7d', 4, 'e-1', 5.0, now);
  ttl = ctx.redis.ttl('feature:amount_7d:4:e-1') as number;
  assert(3595 <= ttl && ttl <= 3601, \`feature:amount_7d:4:e-1 has a TTL of \${ttl} s, expected its definition's freshness_slo of 3600 s\`);
  ctx.clock.advance(101);
  const seen = await m.readValue('amount_7d', 2, 'e-1');
  assert.equal(seen, null, \`101 s later the value is past its freshness SLO and still served: \${JSON.stringify(seen)}\`);
  assert.notEqual(await m.readValue('amount_7d', 4, 'e-1'), null, 'the value of version 4 is within its SLO and must still be served');
}
`,
    go: `package main

import (
	"context"
	"time"

	"features/registry"

	"leetbuild/harness"
)

var stateBg = context.Background()

func state(ctx *harness.Ctx) int64 {
	now := time.Now().Unix()
	for version, slo := range map[int]int64{2: 300, 3: 300, 4: 3600} {
		_, err := registry.CreateDefinition(stateBg, registry.Definition{Name: "amount_7d", Version: version, Dtype: "float64", ComputationRef: "window_avg_7d", FreshnessSLO: slo, CreatedAt: now})
		ctx.NoError(err, "CreateDefinition")
	}
	return now
}

func mustWrite(ctx *harness.Ctx, version int, entity string, value float64, eventTs int64) bool {
	stored, err := writeValue(stateBg, "amount_7d", version, entity, value, eventTs)
	ctx.NoError(err, "writeValue(amount_7d, %d, %s) failed", version, entity)
	return stored
}

func mustRead(ctx *harness.Ctx, version int, entity string) *Value {
	v, err := readValue(stateBg, "amount_7d", version, entity)
	ctx.NoError(err, "readValue(amount_7d, %d, %s) failed", version, entity)
	return v
}

func CheckVersionedKey(ctx *harness.Ctx) {
	now := state(ctx)
	ctx.Equal(mustWrite(ctx, 2, "e-1", 12.5, now-10), true, "the first write of e-1 for version 2 must store; stored")
	ctx.Equal(mustWrite(ctx, 3, "e-1", 40.0, now-5), true, "the first write of e-1 for version 3 must store; stored")
	v2 := mustRead(ctx, 2, "e-1")
	v3 := mustRead(ctx, 3, "e-1")
	ctx.Assert(v2 != nil && v2.Value == 12.5, "version 2 of e-1 reads %+v: the write of version 3 replaced it. Key the value by (name, version, entity)", v2)
	ctx.Assert(v3 != nil && v3.Value == 40.0, "version 3 of e-1 reads %+v, expected 40", v3)
	ctx.Assert(v2.EventTs == now-10 && v2.AgeS == 10, "version 2 of e-1 reads %+v, expected event_ts %d and age_s 10", *v2, now-10)
	ctx.Equal(ctx.Redis.Keys("feature:*"), []string{"feature:amount_7d:2:e-1", "feature:amount_7d:3:e-1"}, "the online store must hold one hash per version; it holds")
}

func CheckNewerWins(ctx *harness.Ctx) {
	now := state(ctx)
	ctx.Equal(mustWrite(ctx, 2, "e-1", 5.0, now-10), true, "the first write of e-1 must store; stored")
	late := mustWrite(ctx, 2, "e-1", 3.0, now-100)
	seen := mustRead(ctx, 2, "e-1")
	ctx.Assert(seen != nil && seen.Value == 5.0 && seen.EventTs == now-10, "a backfill row from 100 s ago replaced the value from 10 s ago: e-1 reads %+v", seen)
	ctx.Equal(late, false, "writeValue for a value older than the stored one; stored")
	ctx.Equal(mustWrite(ctx, 2, "e-1", 5.0, now-10), false, "a replay of the stored event_ts; stored")
	// The streaming path writes e-2 from 5 s ago right after this write from 50 s ago first touches the key.
	key := "feature:amount_7d:2:e-2"
	probe := ctx.Redis.After(key, func() any { return ctx.Redis.Do("HSET", key, "value", "7", "event_ts", now-5) })
	mustWrite(ctx, 2, "e-2", 4.0, now-50)
	ctx.Assert(probe.Fired, "the write of e-2 never touched %s", key)
	seen = mustRead(ctx, 2, "e-2")
	ctx.Assert(seen != nil && seen.Value == 7, "a value from 5 s ago landed between this write's read and its write and was replaced by one from 50 s ago: e-2 reads %+v. Compare and write in one Lua script", seen)
}

func CheckExpireAtSlo(ctx *harness.Ctx) {
	now := state(ctx)
	mustWrite(ctx, 2, "e-1", 5.0, now-200)
	ttl := ctx.Redis.TTL("feature:amount_7d:2:e-1")
	ctx.Assert(95 <= ttl && ttl <= 101, "feature:amount_7d:2:e-1 has a TTL of %d s; computed 200 s ago under a 300 s freshness SLO it goes stale in 100 s: EXPIREAT event_ts + freshness_slo", ttl)
	mustWrite(ctx, 4, "e-1", 5.0, now)
	ttl = ctx.Redis.TTL("feature:amount_7d:4:e-1")
	ctx.Assert(3595 <= ttl && ttl <= 3601, "feature:amount_7d:4:e-1 has a TTL of %d s, expected its definition's freshness_slo of 3600 s", ttl)
	ctx.Clock.Advance(101)
	seen := mustRead(ctx, 2, "e-1")
	ctx.Assert(seen == nil, "101 s later the value is past its freshness SLO and still served: %+v", seen)
	ctx.Assert(mustRead(ctx, 4, "e-1") != nil, "the value of version 4 is within its SLO and must still be served")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <memory>
#include <string>

#include "features/registry.h"

namespace {

long long state() {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  for (const auto& [version, slo] : {std::pair<long, long long>{2, 300}, {3, 300}, {4, 3600}}) {
    registry::createDefinition(registry::Definition{"amount_7d", version, "float64", "window_avg_7d", slo, now});
  }
  return now;
}

std::string show(const std::optional<Value>& v) {
  if (!v) return "none";
  return "{value " + std::to_string(v->value) + ", event_ts " + std::to_string(v->event_ts) + ", age_s " + std::to_string(v->age_s) + "}";
}

}  // namespace

void CheckVersionedKey(harness::Ctx& ctx) {
  const long long now = state();
  ctx.Equal(writeValue("amount_7d", 2, "e-1", 12.5, now - 10), true, "the first write of e-1 for version 2 must store; stored");
  ctx.Equal(writeValue("amount_7d", 3, "e-1", 40.0, now - 5), true, "the first write of e-1 for version 3 must store; stored");
  const auto v2 = readValue("amount_7d", 2, "e-1");
  const auto v3 = readValue("amount_7d", 3, "e-1");
  ctx.Assert(v2 && v2->value == 12.5, "version 2 of e-1 reads %s: the write of version 3 replaced it. Key the value by (name, version, entity)", show(v2));
  ctx.Assert(v3 && v3->value == 40.0, "version 3 of e-1 reads %s, expected 40", show(v3));
  ctx.Assert(v2->event_ts == now - 10 && v2->age_s == 10, "version 2 of e-1 reads %s, expected event_ts %d and age_s 10", show(v2), now - 10);
  ctx.Equal(ctx.Redis.Keys("feature:*"), {"feature:amount_7d:2:e-1", "feature:amount_7d:3:e-1"}, "the online store must hold one hash per version; it holds");
}

void CheckNewerWins(harness::Ctx& ctx) {
  const long long now = state();
  ctx.Equal(writeValue("amount_7d", 2, "e-1", 5.0, now - 10), true, "the first write of e-1 must store; stored");
  const bool late = writeValue("amount_7d", 2, "e-1", 3.0, now - 100);
  auto seen = readValue("amount_7d", 2, "e-1");
  ctx.Assert(seen && seen->value == 5.0 && seen->event_ts == now - 10, "a backfill row from 100 s ago replaced the value from 10 s ago: e-1 reads %s", show(seen));
  ctx.Equal(late, false, "writeValue for a value older than the stored one; stored");
  ctx.Equal(writeValue("amount_7d", 2, "e-1", 5.0, now - 10), false, "a replay of the stored event_ts; stored");
  // The streaming path writes e-2 from 5 s ago right after this write from 50 s ago first touches the key.
  const std::string key = "feature:amount_7d:2:e-2";
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After(key, [&ctx, fired, key, now] {
    *fired = true;
    ctx.Redis.Do("HSET", key, "value", "7", "event_ts", std::to_string(now - 5));
  });
  writeValue("amount_7d", 2, "e-2", 4.0, now - 50);
  ctx.Assert(*fired, "the write of e-2 never touched %s", key);
  seen = readValue("amount_7d", 2, "e-2");
  ctx.Assert(seen && seen->value == 7, "a value from 5 s ago landed between this write's read and its write and was replaced by one from 50 s ago: e-2 reads %s. Compare and write in one Lua script", show(seen));
}

void CheckExpireAtSlo(harness::Ctx& ctx) {
  const long long now = state();
  writeValue("amount_7d", 2, "e-1", 5.0, now - 200);
  long long ttl = ctx.Redis.TTL("feature:amount_7d:2:e-1");
  ctx.Assert(95 <= ttl && ttl <= 101, "feature:amount_7d:2:e-1 has a TTL of %d s; computed 200 s ago under a 300 s freshness SLO it goes stale in 100 s: EXPIREAT event_ts + freshness_slo", ttl);
  writeValue("amount_7d", 4, "e-1", 5.0, now);
  ttl = ctx.Redis.TTL("feature:amount_7d:4:e-1");
  ctx.Assert(3595 <= ttl && ttl <= 3601, "feature:amount_7d:4:e-1 has a TTL of %d s, expected its definition's freshness_slo of 3600 s", ttl);
  ctx.Clock.Advance(101);
  const auto seen = readValue("amount_7d", 2, "e-1");
  ctx.Assert(!seen, "101 s later the value is past its freshness SLO and still served: %s", show(seen));
  ctx.Assert(readValue("amount_7d", 4, "e-1").has_value(), "the value of version 4 is within its SLO and must still be served");
}
`,
  },
  hints: [
    'Write version 3 of a feature, then read version 2: it answers version 3’s value. Write yesterday’s backfill row after today’s value: today’s is gone. A value past its SLO still reads back.',
    'The key has no version, so every version shares one hash. HSET writes whatever arrives last, and a read-then-write still loses to a writer landing between the two. The TTL counts 24 hours from the write.',
    'Key by `feature:{name}:{version}:{entity}`; one Lua script that refuses a stored `event_ts` ≥ the new one, else HSETs and `EXPIREAT`s at `event_ts + freshness_slo` from `registry.get_definition`; return whether it stored.',
  ],
  debrief: `The script is the fix because the comparison and the write have to be one step: the streaming path and a backfill write the same entity, and only the event time decides which value is the truth, not which writer arrived last. Keying by version is what makes a version bump a new set of keys instead of an overwrite, so the models still pinned to version 2 keep reading version 2. Expiring at \`event_ts + freshness_slo\` ties the key's life to the value's age rather than to the write, so a backfilled value that is already old leaves early and a stale one is a miss, not a quiet wrong answer. Production online stores also keep a few versions of history per entity for debugging and serve a default when a value is missing.`,
};
