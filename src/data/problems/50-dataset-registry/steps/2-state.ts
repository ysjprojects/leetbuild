import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis latest-version pointer with atomic promotion and pins',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['registry', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the latest-version pointer the later steps share.
\`promote(dataset, version, actor)\` appends \`"{previous}->{version} by {actor}"\` to
\`dataset:{dataset}:audit\`, sets \`dataset:{dataset}:latest\` with a one-hour expiry, moves every pin
in \`dataset:{dataset}:pins\` to the new version and returns the previous one; \`latest(dataset)\` reads
the pointer; \`pin(dataset, consumer, version)\` records a pin; \`purge(dataset, version)\` deletes the
version record. It serves the demo and hides four flaws.

**Failure mode the checks target.** A reader between the audit append and the pointer write sees a
promotion that has not happened; an idle dataset loses its latest after an hour and the read hands
back an empty name; a training run pinned to \`2026-01\` reads \`2026-02\` without asking; a purge
deletes the version a run still reads.

- Promotion is **one Lua script** (\`register_script\`/\`EVAL\`): read the pointer, \`SET\` it,
  \`RPUSH\` the audit entry, return the previous version (\`""\` when none).
- The pointer has **no expiry**.
- \`latest\` raises \`LatestVersionMissing\` when the pointer is absent.
- A promotion leaves the pins alone. \`purge\` raises \`VersionPinned\` for the latest or a pinned
  version and keeps its record; any other version it deletes, in one script with that check.`,
  sequence: {
    participants: ['registryd', 'Redis', 'Training run'],
    messages: [
      {from: 'registryd', to: 'Redis', label: 'EVAL promote · latest, audit · 2026-02 bob', kind: 'sync'},
      {from: 'Redis', to: 'registryd', label: 'previous 2026-01 · pointer and audit moved together', kind: 'reply'},
      {from: 'Training run', to: 'Redis', label: 'HSET pins run-7 2026-01', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'EVAL purge 2026-01', kind: 'sync'},
      {from: 'Redis', to: 'registryd', label: '0 · pinned → VersionPinned', kind: 'reply'},
      {from: 'registryd', to: 'Redis', label: 'GET latest · nil → LatestVersionMissing', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-promotion',
      title: 'The pointer and its audit entry move together',
      detail:
        'One Lua script reads the pointer, sets it and appends the audit entry, so no reader sees a moved pointer without its entry or an entry for a promotion that has not happened. The starter sends `RPUSH` and `SET` as two commands.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /RPUSH/], none: [/\.rpush\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /RPUSH/], none: [/redis\.rpush\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /RPUSH/], none: [/\.RPush\(/]},
        scala: {all: [/jedis\.eval\(/, /RPUSH/], none: [/jedis\.rpush\(/]},
        cpp: {all: [/redis\.eval[<(]/, /RPUSH/], none: [/redis\.rpush\(/]},
      },
    },
    {
      id: 'durable-pointer',
      title: 'The latest pointer does not expire',
      detail:
        '`dataset:{dataset}:latest` is written without a TTL. The starter sets a one-hour expiry, so a dataset nobody promotes for an hour has no latest version.',
      match: {
        python: {all: [/latest_key\(/], none: [/POINTER_TTL|\bex\s*=|expire/i]},
        typescript: {all: [/latestKey\(/], none: [/POINTER_TTL|'EX'|expire/i]},
        go: {all: [/latestKey\(/], none: [/pointerTTL|Expire\(/]},
        scala: {all: [/latestKey\(/], none: [/PointerTtl|setex|expire/i]},
        cpp: {all: [/latestKey\(/], none: [/kPointerTtl|expire/i]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A missing pointer raises instead of answering a name',
      detail:
        '`latest` raises `LatestVersionMissing` when the pointer is absent. The starter returns `""`, which a caller passes on as a version.',
      match: {
        python: {
          all: [/raise LatestVersionMissing/],
          none: [/def latest\([^\n]*\n[^\n]*\n\s*return r\.get\([^\n]*\)\s*or\s*["']{2}/],
        },
        typescript: {all: [/throw new LatestVersionMissing/], none: [/\?\?\s*''/]},
        go: {all: [/redis\.Nil[\s\S]{0,80}ErrLatestVersionMissing/]},
        scala: {all: [/throw new LatestVersionMissing/]},
        cpp: {all: [/throw LatestVersionMissing/]},
      },
    },
    {
      id: 'pins-independent',
      title: 'Pins survive a promotion and block a purge',
      detail:
        'A promotion never writes `dataset:{dataset}:pins`, and `purge` checks the pins (`HVALS`) and the pointer in the script that deletes, refusing with `VersionPinned`. The starter moves every pin to the new version and purges whatever it is asked to.',
      match: {
        python: {all: [/HVALS/, /VersionPinned\(/], none: [/hkeys/i]},
        typescript: {all: [/HVALS/, /new VersionPinned/], none: [/hkeys/i]},
        go: {all: [/HVALS/, /ErrVersionPinned/], none: [/HKeys\(/]},
        scala: {all: [/HVALS/, /new VersionPinned/], none: [/hkeys/i]},
        cpp: {all: [/HVALS/, /throw VersionPinned/], none: [/hkeys/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POINTER_TTL_S = 3600


class LatestVersionMissing(Exception):
    """The dataset has no promoted version."""


class VersionPinned(Exception):
    """The version is the latest or a consumer pins it: it cannot be purged."""


def latest_key(dataset: str) -> str:
    return f"dataset:{dataset}:latest"


def audit_key(dataset: str) -> str:
    return f"dataset:{dataset}:audit"


def pins_key(dataset: str) -> str:
    return f"dataset:{dataset}:pins"


def promote(dataset: str, version: str, actor: str) -> str:
    """Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    previous = r.get(latest_key(dataset)) or ""
    r.rpush(audit_key(dataset), f"{previous}->{version} by {actor}")
    r.set(latest_key(dataset), version, ex=POINTER_TTL_S)
    for consumer in r.hkeys(pins_key(dataset)):
        r.hset(pins_key(dataset), consumer, version)  # pinned runs follow the newest data
    return previous


def latest(dataset: str) -> str:
    """The promoted version."""
    return r.get(latest_key(dataset)) or ""


def pin(dataset: str, consumer: str, version: str) -> None:
    r.hset(pins_key(dataset), consumer, version)


def purge(dataset: str, version: str) -> None:
    """Delete a version record."""
    r.delete(f"dataset:{dataset}:v:{version}")
    r.srem(f"dataset:{dataset}:versions", version)
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Reads the pointer, moves it and appends the audit entry in one step: no reader sees one without the other.
PROMOTE_LUA = """
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
"""
# Refuses the latest and every pinned version, and deletes otherwise, with no gap between check and delete.
PURGE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
"""
promote_script = r.register_script(PROMOTE_LUA)
purge_script = r.register_script(PURGE_LUA)


class LatestVersionMissing(Exception):
    """The dataset has no promoted version."""


class VersionPinned(Exception):
    """The version is the latest or a consumer pins it: it cannot be purged."""


def latest_key(dataset: str) -> str:
    return f"dataset:{dataset}:latest"


def audit_key(dataset: str) -> str:
    return f"dataset:{dataset}:audit"


def pins_key(dataset: str) -> str:
    return f"dataset:{dataset}:pins"


def promote(dataset: str, version: str, actor: str) -> str:
    """Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none)."""
    return promote_script(keys=[latest_key(dataset), audit_key(dataset)], args=[version, actor])


def latest(dataset: str) -> str:
    """The promoted version."""
    version = r.get(latest_key(dataset))
    if version is None:
        raise LatestVersionMissing(dataset)
    return version


def pin(dataset: str, consumer: str, version: str) -> None:
    r.hset(pins_key(dataset), consumer, version)


def purge(dataset: str, version: str) -> None:
    """Delete a version record."""
    keys = [latest_key(dataset), pins_key(dataset), f"dataset:{dataset}:v:{version}", f"dataset:{dataset}:versions"]
    if purge_script(keys=keys, args=[version]) == 0:
        raise VersionPinned(f"{dataset}@{version}")
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const POINTER_TTL_S = 3600;

/** The dataset has no promoted version. */
export class LatestVersionMissing extends Error {}
/** The version is the latest or a consumer pins it: it cannot be purged. */
export class VersionPinned extends Error {}

export const latestKey = (dataset: string): string => \`dataset:\${dataset}:latest\`;
export const auditKey = (dataset: string): string => \`dataset:\${dataset}:audit\`;
export const pinsKey = (dataset: string): string => \`dataset:\${dataset}:pins\`;

/** Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none). */
export async function promote(dataset: string, version: string, actor: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const previous = (await redis.get(latestKey(dataset))) ?? '';
  await redis.rpush(auditKey(dataset), \`\${previous}->\${version} by \${actor}\`);
  await redis.set(latestKey(dataset), version, 'EX', POINTER_TTL_S);
  for (const consumer of await redis.hkeys(pinsKey(dataset))) {
    await redis.hset(pinsKey(dataset), consumer, version); // pinned runs follow the newest data
  }
  return previous;
}

/** The promoted version. */
export async function latest(dataset: string): Promise<string> {
  return (await redis.get(latestKey(dataset))) ?? '';
}

export async function pin(dataset: string, consumer: string, version: string): Promise<void> {
  await redis.hset(pinsKey(dataset), consumer, version);
}

/** Delete a version record. */
export async function purge(dataset: string, version: string): Promise<void> {
  await redis.del(\`dataset:\${dataset}:v:\${version}\`);
  await redis.srem(\`dataset:\${dataset}:versions\`, version);
}
`,
      solution: `import Redis from 'ioredis';

// Reads the pointer, moves it and appends the audit entry in one step: no reader sees one without the other.
export const PROMOTE_LUA = \`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
\`;
// Refuses the latest and every pinned version, and deletes otherwise, with no gap between check and delete.
export const PURGE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
\`;

interface PointerRedis extends Redis {
  promoteVersion(latest: string, audit: string, version: string, actor: string): Promise<string>;
  purgeVersion(latest: string, pins: string, record: string, versions: string, version: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PointerRedis;
redis.defineCommand('promoteVersion', {numberOfKeys: 2, lua: PROMOTE_LUA});
redis.defineCommand('purgeVersion', {numberOfKeys: 4, lua: PURGE_LUA});

/** The dataset has no promoted version. */
export class LatestVersionMissing extends Error {}
/** The version is the latest or a consumer pins it: it cannot be purged. */
export class VersionPinned extends Error {}

export const latestKey = (dataset: string): string => \`dataset:\${dataset}:latest\`;
export const auditKey = (dataset: string): string => \`dataset:\${dataset}:audit\`;
export const pinsKey = (dataset: string): string => \`dataset:\${dataset}:pins\`;

/** Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none). */
export async function promote(dataset: string, version: string, actor: string): Promise<string> {
  return redis.promoteVersion(latestKey(dataset), auditKey(dataset), version, actor);
}

/** The promoted version. */
export async function latest(dataset: string): Promise<string> {
  const version = await redis.get(latestKey(dataset));
  if (version === null) throw new LatestVersionMissing(dataset);
  return version;
}

export async function pin(dataset: string, consumer: string, version: string): Promise<void> {
  await redis.hset(pinsKey(dataset), consumer, version);
}

/** Delete a version record. */
export async function purge(dataset: string, version: string): Promise<void> {
  const purged = await redis.purgeVersion(latestKey(dataset), pinsKey(dataset), \`dataset:\${dataset}:v:\${version}\`, \`dataset:\${dataset}:versions\`, version);
  if (purged === 0) throw new VersionPinned(\`\${dataset}@\${version}\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const pointerTTL = time.Hour

var (
	// ErrLatestVersionMissing: the dataset has no promoted version.
	ErrLatestVersionMissing = errors.New("latest version missing")
	// ErrVersionPinned: the version is the latest or a consumer pins it, it cannot be purged.
	ErrVersionPinned = errors.New("version is pinned")
)

func latestKey(dataset string) string { return "dataset:" + dataset + ":latest" }
func auditKey(dataset string) string  { return "dataset:" + dataset + ":audit" }
func pinsKey(dataset string) string   { return "dataset:" + dataset + ":pins" }

// promote makes version the dataset's latest and appends the audit entry; it returns the previous
// latest ("" when none).
func promote(ctx context.Context, dataset, version, actor string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	previous := rdb.Get(ctx, latestKey(dataset)).Val()
	if err := rdb.RPush(ctx, auditKey(dataset), fmt.Sprintf("%s->%s by %s", previous, version, actor)).Err(); err != nil {
		return "", err
	}
	if err := rdb.Set(ctx, latestKey(dataset), version, pointerTTL).Err(); err != nil {
		return "", err
	}
	for _, consumer := range rdb.HKeys(ctx, pinsKey(dataset)).Val() {
		rdb.HSet(ctx, pinsKey(dataset), consumer, version) // pinned runs follow the newest data
	}
	return previous, nil
}

// latest is the promoted version.
func latest(ctx context.Context, dataset string) (string, error) {
	return rdb.Get(ctx, latestKey(dataset)).Val(), nil
}

func pin(ctx context.Context, dataset, consumer, version string) error {
	return rdb.HSet(ctx, pinsKey(dataset), consumer, version).Err()
}

// purge deletes a version record.
func purge(ctx context.Context, dataset, version string) error {
	if err := rdb.Del(ctx, "dataset:"+dataset+":v:"+version).Err(); err != nil {
		return err
	}
	return rdb.SRem(ctx, "dataset:"+dataset+":versions", version).Err()
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var (
	// ErrLatestVersionMissing: the dataset has no promoted version.
	ErrLatestVersionMissing = errors.New("latest version missing")
	// ErrVersionPinned: the version is the latest or a consumer pins it, it cannot be purged.
	ErrVersionPinned = errors.New("version is pinned")
)

// promoteScript reads the pointer, moves it and appends the audit entry in one step: no reader sees
// one without the other.
var promoteScript = redis.NewScript(\`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
\`)

// purgeScript refuses the latest and every pinned version, and deletes otherwise, with no gap
// between check and delete.
var purgeScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
\`)

func latestKey(dataset string) string { return "dataset:" + dataset + ":latest" }
func auditKey(dataset string) string  { return "dataset:" + dataset + ":audit" }
func pinsKey(dataset string) string   { return "dataset:" + dataset + ":pins" }

// promote makes version the dataset's latest and appends the audit entry; it returns the previous
// latest ("" when none).
func promote(ctx context.Context, dataset, version, actor string) (string, error) {
	return promoteScript.Run(ctx, rdb, []string{latestKey(dataset), auditKey(dataset)}, version, actor).Text()
}

// latest is the promoted version.
func latest(ctx context.Context, dataset string) (string, error) {
	version, err := rdb.Get(ctx, latestKey(dataset)).Result()
	if err == redis.Nil {
		return "", fmt.Errorf("%w: %s", ErrLatestVersionMissing, dataset)
	}
	return version, err
}

func pin(ctx context.Context, dataset, consumer, version string) error {
	return rdb.HSet(ctx, pinsKey(dataset), consumer, version).Err()
}

// purge deletes a version record.
func purge(ctx context.Context, dataset, version string) error {
	keys := []string{latestKey(dataset), pinsKey(dataset), "dataset:" + dataset + ":v:" + version, "dataset:" + dataset + ":versions"}
	purged, err := purgeScript.Run(ctx, rdb, keys, version).Int64()
	if err != nil {
		return err
	}
	if purged == 0 {
		return fmt.Errorf("%w: %s@%s", ErrVersionPinned, dataset, version)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The dataset has no promoted version. */
final class LatestVersionMissing(message: String) extends Exception(message)
/** The version is the latest or a consumer pins it: it cannot be purged. */
final class VersionPinned(message: String) extends Exception(message)

object State {
  val jedis = new JedisPooled("redis", 6379)

  val PointerTtlSeconds = 3600L

  def latestKey(dataset: String): String = s"dataset:$dataset:latest"
  def auditKey(dataset: String): String = s"dataset:$dataset:audit"
  def pinsKey(dataset: String): String = s"dataset:$dataset:pins"

  /** Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none). */
  def promote(dataset: String, version: String, actor: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val previous = Option(jedis.get(latestKey(dataset))).getOrElse("")
    jedis.rpush(auditKey(dataset), s"$previous->$version by $actor")
    jedis.setex(latestKey(dataset), PointerTtlSeconds, version)
    jedis.hkeys(pinsKey(dataset)).asScala.foreach(consumer => jedis.hset(pinsKey(dataset), consumer, version)) // pinned runs follow the newest data
    previous
  }

  /** The promoted version. */
  def latest(dataset: String): String = Option(jedis.get(latestKey(dataset))).getOrElse("")

  def pin(dataset: String, consumer: String, version: String): Unit = jedis.hset(pinsKey(dataset), consumer, version)

  /** Delete a version record. */
  def purge(dataset: String, version: String): Unit = {
    jedis.del(s"dataset:$dataset:v:$version")
    jedis.srem(s"dataset:$dataset:versions", version)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The dataset has no promoted version. */
final class LatestVersionMissing(message: String) extends Exception(message)
/** The version is the latest or a consumer pins it: it cannot be purged. */
final class VersionPinned(message: String) extends Exception(message)

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Reads the pointer, moves it and appends the audit entry in one step: no reader sees one without the other. */
  val PromoteLua: String =
    """local previous = redis.call('GET', KEYS[1]) or ''
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
      |return previous
      |""".stripMargin

  /** Refuses the latest and every pinned version, and deletes otherwise, with no gap between check and delete. */
  val PurgeLua: String =
    """if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
      |for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
      |  if pinned == ARGV[1] then return 0 end
      |end
      |redis.call('DEL', KEYS[3])
      |redis.call('SREM', KEYS[4], ARGV[1])
      |return 1
      |""".stripMargin

  def latestKey(dataset: String): String = s"dataset:$dataset:latest"
  def auditKey(dataset: String): String = s"dataset:$dataset:audit"
  def pinsKey(dataset: String): String = s"dataset:$dataset:pins"

  /** Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none). */
  def promote(dataset: String, version: String, actor: String): String =
    jedis.eval(PromoteLua, List(latestKey(dataset), auditKey(dataset)).asJava, List(version, actor).asJava).asInstanceOf[String]

  /** The promoted version. */
  def latest(dataset: String): String =
    Option(jedis.get(latestKey(dataset))).getOrElse(throw new LatestVersionMissing(dataset))

  def pin(dataset: String, consumer: String, version: String): Unit = jedis.hset(pinsKey(dataset), consumer, version)

  /** Delete a version record. */
  def purge(dataset: String, version: String): Unit = {
    val keys = List(latestKey(dataset), pinsKey(dataset), s"dataset:$dataset:v:$version", s"dataset:$dataset:versions").asJava
    if (jedis.eval(PurgeLua, keys, List(version).asJava).asInstanceOf[java.lang.Long] == 0L) throw new VersionPinned(s"$dataset@$version")
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kPointerTtlSeconds = 3600;

// The dataset has no promoted version.
struct LatestVersionMissing : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The version is the latest or a consumer pins it: it cannot be purged.
struct VersionPinned : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string latestKey(const std::string& dataset) { return "dataset:" + dataset + ":latest"; }
std::string auditKey(const std::string& dataset) { return "dataset:" + dataset + ":audit"; }
std::string pinsKey(const std::string& dataset) { return "dataset:" + dataset + ":pins"; }

// Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none).
std::string promote(const std::string& dataset, const std::string& version, const std::string& actor) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto current = redis.get(latestKey(dataset));
  const std::string previous = current ? std::string(*current) : "";
  redis.rpush(auditKey(dataset), previous + "->" + version + " by " + actor);
  redis.set(latestKey(dataset), version, std::chrono::seconds(kPointerTtlSeconds));
  for (const std::string& consumer : redis.hkeys(pinsKey(dataset))) {
    redis.hset(pinsKey(dataset), consumer, version);  // pinned runs follow the newest data
  }
  return previous;
}

// The promoted version.
std::string latest(const std::string& dataset) {
  const auto version = redis.get(latestKey(dataset));
  return version ? std::string(*version) : "";
}

void pin(const std::string& dataset, const std::string& consumer, const std::string& version) {
  redis.hset(pinsKey(dataset), consumer, version);
}

// Delete a version record.
void purge(const std::string& dataset, const std::string& version) {
  redis.del("dataset:" + dataset + ":v:" + version);
  redis.srem("dataset:" + dataset + ":versions", version);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// Reads the pointer, moves it and appends the audit entry in one step: no reader sees one without the other.
const std::string kPromoteLua = R"lua(
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
)lua";

// Refuses the latest and every pinned version, and deletes otherwise, with no gap between check and delete.
const std::string kPurgeLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
)lua";

// The dataset has no promoted version.
struct LatestVersionMissing : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The version is the latest or a consumer pins it: it cannot be purged.
struct VersionPinned : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string latestKey(const std::string& dataset) { return "dataset:" + dataset + ":latest"; }
std::string auditKey(const std::string& dataset) { return "dataset:" + dataset + ":audit"; }
std::string pinsKey(const std::string& dataset) { return "dataset:" + dataset + ":pins"; }

// Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none).
std::string promote(const std::string& dataset, const std::string& version, const std::string& actor) {
  return redis.eval<std::string>(kPromoteLua, {latestKey(dataset), auditKey(dataset)}, {version, actor});
}

// The promoted version.
std::string latest(const std::string& dataset) {
  const auto version = redis.get(latestKey(dataset));
  if (!version) throw LatestVersionMissing(dataset);
  return std::string(*version);
}

void pin(const std::string& dataset, const std::string& consumer, const std::string& version) {
  redis.hset(pinsKey(dataset), consumer, version);
}

// Delete a version record.
void purge(const std::string& dataset, const std::string& version) {
  const long long purged = redis.eval<long long>(
      kPurgeLua, {latestKey(dataset), pinsKey(dataset), "dataset:" + dataset + ":v:" + version, "dataset:" + dataset + ":versions"},
      {version});
  if (purged == 0) throw VersionPinned(dataset + "@" + version);
}
`,
    },
  },
  harness: {
    python: `from registry import store

DS = "imdb-reviews"
LATEST = f"dataset:{DS}:latest"
AUDIT = f"dataset:{DS}:audit"
PINS = f"dataset:{DS}:pins"


def _state(ctx):
    for version in ("2025-12", "2026-01", "2026-02"):
        store.put_version({"tenant": "t1", "dataset": DS, "version": version, "content_sha256": "0" * 64, "license": "mit", "owner": "team-lm", "size_bytes": 20, "row_count": 2, "status": "validated"})
    return ctx.load("state")


def _refused(m, version, why):
    try:
        m.purge(DS, version)
    except m.VersionPinned:
        return
    raise AssertionError(f"purge({version!r}) went through while {why}: a run reading it loses its data. Raise VersionPinned")


def check_atomic_promotion(ctx):
    m = _state(ctx)
    assert m.promote(DS, "2026-01", "alice") == "", "the first promotion has no previous version: promote must return ''"
    seen = ctx.redis_after(AUDIT, lambda: (ctx.redis.get(LATEST), ctx.redis.llen(AUDIT)))
    previous = m.promote(DS, "2026-02", "bob")
    assert seen.fired, "the promotion of 2026-02 never touched the audit list"
    latest, entries = seen.result
    assert (latest, entries) in (("2026-01", 1), ("2026-02", 2)), f"a reader between the commands saw latest {latest} with {entries} audit entries: the pointer and its audit entry must change together, in one Lua script"
    assert previous == "2026-01", f"promote returned {previous!r}, expected the previous latest 2026-01"
    entries = ctx.redis.lrange(AUDIT, 0, -1)
    assert entries == ["->2026-01 by alice", "2026-01->2026-02 by bob"], f"the audit list holds {entries}"
    assert ctx.redis.get(LATEST) == "2026-02", f"the pointer holds {ctx.redis.get(LATEST)!r} after promoting 2026-02"


def check_durable_pointer(ctx):
    m = _state(ctx)
    m.promote(DS, "2026-01", "alice")
    m.promote(DS, "2026-02", "bob")
    assert ctx.redis.get(LATEST) == "2026-02", f"the pointer holds {ctx.redis.get(LATEST)!r}, expected 2026-02"
    ttl = ctx.redis.ttl(LATEST)
    assert ttl == -1, f"{LATEST} expires in {ttl} s: a dataset nobody promotes for that long loses its latest version. The pointer must not expire"


def check_fail_closed(ctx):
    m = _state(ctx)
    try:
        got = m.latest("wiki-text")
    except m.LatestVersionMissing:
        pass
    else:
        raise AssertionError(f"latest('wiki-text') returned {got!r} for a dataset with no promoted version: a caller passes that on as a version. Raise LatestVersionMissing")
    m.promote(DS, "2026-01", "alice")
    assert m.latest(DS) == "2026-01", f"latest gives {m.latest(DS)!r} after promoting 2026-01"


def check_pins_independent(ctx):
    m = _state(ctx)
    m.promote(DS, "2026-01", "alice")
    m.pin(DS, "run-7", "2026-01")
    m.promote(DS, "2026-02", "bob")
    pinned = ctx.redis.hget(PINS, "run-7")
    assert pinned == "2026-01", f"run-7 pinned 2026-01 and now reads {pinned}: a promotion must leave the pins alone"
    _refused(m, "2026-01", "run-7 pins it")
    assert store.version(DS, "2026-01") is not None, "the pinned version's record is gone"
    _refused(m, "2026-02", "it is the latest")
    assert store.version(DS, "2026-02") is not None, "the latest version's record is gone"
    m.purge(DS, "2025-12")
    assert store.version(DS, "2025-12") is None, "a version nobody pins and that is not the latest must be purged"
    assert "2025-12" not in store.versions(DS), f"the purged version is still listed: {store.versions(DS)}"
`,
    typescript: `const DS = 'imdb-reviews';
const LATEST = \`dataset:\${DS}:latest\`;
const AUDIT = \`dataset:\${DS}:audit\`;
const PINS = \`dataset:\${DS}:pins\`;

async function state(ctx) {
  const store = ctx.load('/support/registry/store.ts');
  for (const version of ['2025-12', '2026-01', '2026-02']) {
    await store.putVersion({tenant: 't1', dataset: DS, version, content_sha256: '0'.repeat(64), license: 'mit', owner: 'team-lm', size_bytes: 20, row_count: 2, status: 'validated', report: null});
  }
  return {m: ctx.load('state'), store};
}

async function refused(m, version: string, why: string): Promise<void> {
  try {
    await m.purge(DS, version);
  } catch (e) {
    if (e instanceof m.VersionPinned) return;
    throw e;
  }
  assert.fail(\`purge('\${version}') went through while \${why}: a run reading it loses its data. Throw VersionPinned\`);
}

export async function check_atomic_promotion(ctx) {
  const {m} = await state(ctx);
  assert.equal(await m.promote(DS, '2026-01', 'alice'), '', 'the first promotion has no previous version: promote must return ""');
  const seen = ctx.redisAfter(AUDIT, () => [ctx.redis.get(LATEST), ctx.redis.llen(AUDIT)]);
  const previous = await m.promote(DS, '2026-02', 'bob');
  assert(seen.fired, 'the promotion of 2026-02 never touched the audit list');
  const [latest, entries] = await seen.result;
  assert((latest === '2026-01' && entries === 1) || (latest === '2026-02' && entries === 2), \`a reader between the commands saw latest \${latest} with \${entries} audit entries: the pointer and its audit entry must change together, in one Lua script\`);
  assert.equal(previous, '2026-01', 'promote must return the previous latest');
  assert.deepStrictEqual(ctx.redis.lrange(AUDIT, 0, -1), ['->2026-01 by alice', '2026-01->2026-02 by bob'], 'the audit list');
  assert.equal(ctx.redis.get(LATEST), '2026-02', 'the pointer after promoting 2026-02');
}

export async function check_durable_pointer(ctx) {
  const {m} = await state(ctx);
  await m.promote(DS, '2026-01', 'alice');
  await m.promote(DS, '2026-02', 'bob');
  assert.equal(ctx.redis.get(LATEST), '2026-02', 'the pointer after two promotions');
  const ttl = ctx.redis.ttl(LATEST);
  assert.equal(ttl, -1, \`\${LATEST} expires in \${ttl} s: a dataset nobody promotes for that long loses its latest version. The pointer must not expire\`);
}

export async function check_fail_closed(ctx) {
  const {m} = await state(ctx);
  let got;
  try {
    got = await m.latest('wiki-text');
  } catch (e) {
    if (!(e instanceof m.LatestVersionMissing)) throw e;
    got = undefined;
  }
  assert.equal(got, undefined, \`latest('wiki-text') returned \${JSON.stringify(got)} for a dataset with no promoted version: a caller passes that on as a version. Throw LatestVersionMissing\`);
  await m.promote(DS, '2026-01', 'alice');
  assert.equal(await m.latest(DS), '2026-01', 'latest after promoting 2026-01');
}

export async function check_pins_independent(ctx) {
  const {m, store} = await state(ctx);
  await m.promote(DS, '2026-01', 'alice');
  await m.pin(DS, 'run-7', '2026-01');
  await m.promote(DS, '2026-02', 'bob');
  const pinned = ctx.redis.hget(PINS, 'run-7');
  assert.equal(pinned, '2026-01', \`run-7 pinned 2026-01 and now reads \${pinned}: a promotion must leave the pins alone\`);
  await refused(m, '2026-01', 'run-7 pins it');
  assert.notEqual(await store.version(DS, '2026-01'), null, 'the pinned version\\'s record is gone');
  await refused(m, '2026-02', 'it is the latest');
  assert.notEqual(await store.version(DS, '2026-02'), null, 'the latest version\\'s record is gone');
  await m.purge(DS, '2025-12');
  assert.equal(await store.version(DS, '2025-12'), null, 'a version nobody pins and that is not the latest must be purged');
  assert(!(await store.versions(DS)).includes('2025-12'), 'the purged version is still listed');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"registry/store"

	"leetbuild/harness"
)

const stateDS = "imdb-reviews"

var (
	stateBg     = context.Background()
	stateLatest = "dataset:" + stateDS + ":latest"
	stateAudit  = "dataset:" + stateDS + ":audit"
	statePins   = "dataset:" + stateDS + ":pins"
)

func stateSetup(ctx *harness.Ctx) {
	for _, v := range []string{"2025-12", "2026-01", "2026-02"} {
		err := store.PutVersion(stateBg, &store.VersionRecord{Tenant: "t1", Dataset: stateDS, Version: v, ContentSHA256: strings.Repeat("0", 64), License: "mit", Owner: "team-lm", SizeBytes: 20, RowCount: 2, Status: "validated"})
		ctx.NoError(err, "seeding %s", v)
	}
}

func mustPromote(ctx *harness.Ctx, version, actor string) string {
	previous, err := promote(stateBg, stateDS, version, actor)
	ctx.NoError(err, "promote(%s) failed", version)
	return previous
}

func stateRefused(ctx *harness.Ctx, version, why string) {
	err := purge(stateBg, stateDS, version)
	ctx.Assert(err != nil, "purge(%q) went through while %s: a run reading it loses its data. Return ErrVersionPinned", version, why)
	ctx.Assert(errors.Is(err, ErrVersionPinned), "purge(%q) failed with %v, expected ErrVersionPinned", version, err)
}

func CheckAtomicPromotion(ctx *harness.Ctx) {
	stateSetup(ctx)
	ctx.Equal(mustPromote(ctx, "2026-01", "alice"), "", "the first promotion has no previous version; promote returned")
	seen := ctx.Redis.After(stateAudit, func() any {
		latest, _ := ctx.Redis.Get(stateLatest)
		return fmt.Sprintf("%s/%d", latest, ctx.Redis.LLen(stateAudit))
	})
	previous := mustPromote(ctx, "2026-02", "bob")
	ctx.Assert(seen.Fired, "the promotion of 2026-02 never touched the audit list")
	state, _ := seen.Result.(string)
	ctx.Assert(state == "2026-01/1" || state == "2026-02/2", "a reader between the commands saw latest/audit entries %s: the pointer and its audit entry must change together, in one Lua script", state)
	ctx.Equal(previous, "2026-01", "promote must return the previous latest")
	ctx.Equal(ctx.Redis.LRange(stateAudit, 0, -1), []string{"->2026-01 by alice", "2026-01->2026-02 by bob"}, "the audit list")
	latest, _ := ctx.Redis.Get(stateLatest)
	ctx.Equal(latest, "2026-02", "the pointer after promoting 2026-02")
}

func CheckDurablePointer(ctx *harness.Ctx) {
	stateSetup(ctx)
	mustPromote(ctx, "2026-01", "alice")
	mustPromote(ctx, "2026-02", "bob")
	latest, _ := ctx.Redis.Get(stateLatest)
	ctx.Equal(latest, "2026-02", "the pointer after two promotions")
	ttl := ctx.Redis.TTL(stateLatest)
	ctx.Equal(ttl, int64(-1), "%s expires in %d s: a dataset nobody promotes for that long loses its latest version. The pointer must not expire; its TTL", stateLatest, ttl)
}

func CheckFailClosed(ctx *harness.Ctx) {
	stateSetup(ctx)
	got, err := latest(stateBg, "wiki-text")
	ctx.Assert(err != nil, "latest(wiki-text) returned %q for a dataset with no promoted version: a caller passes that on as a version. Return ErrLatestVersionMissing", got)
	ctx.Assert(errors.Is(err, ErrLatestVersionMissing), "latest(wiki-text) failed with %v, expected ErrLatestVersionMissing", err)
	mustPromote(ctx, "2026-01", "alice")
	got, err = latest(stateBg, stateDS)
	ctx.NoError(err, "latest after a promotion")
	ctx.Equal(got, "2026-01", "latest after promoting 2026-01")
}

func CheckPinsIndependent(ctx *harness.Ctx) {
	stateSetup(ctx)
	mustPromote(ctx, "2026-01", "alice")
	ctx.NoError(pin(stateBg, stateDS, "run-7", "2026-01"), "pin")
	mustPromote(ctx, "2026-02", "bob")
	pinned, _ := ctx.Redis.HGet(statePins, "run-7")
	ctx.Equal(pinned, "2026-01", "run-7 pinned 2026-01: a promotion must leave the pins alone; run-7 reads")
	stateRefused(ctx, "2026-01", "run-7 pins it")
	ctx.Assert(store.Version(stateBg, stateDS, "2026-01") != nil, "the pinned version's record is gone")
	stateRefused(ctx, "2026-02", "it is the latest")
	ctx.Assert(store.Version(stateBg, stateDS, "2026-02") != nil, "the latest version's record is gone")
	ctx.NoError(purge(stateBg, stateDS, "2025-12"), "purging a version nobody pins")
	ctx.Assert(store.Version(stateBg, stateDS, "2025-12") == nil, "a version nobody pins and that is not the latest must be purged")
	ctx.Equal(store.Versions(stateBg, stateDS), []string{"2026-01", "2026-02"}, "the versions left after the purge")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "registry/store.h"

namespace {

const std::string kDS = "imdb-reviews";
const std::string kLatest = "dataset:" + kDS + ":latest";
const std::string kAudit = "dataset:" + kDS + ":audit";
const std::string kPins = "dataset:" + kDS + ":pins";

void setup() {
  for (const std::string version : {"2025-12", "2026-01", "2026-02"}) {
    store::VersionRecord rec;
    rec.tenant = "t1";
    rec.dataset = kDS;
    rec.version = version;
    rec.content_sha256 = std::string(64, '0');
    rec.license = "mit";
    rec.owner = "team-lm";
    rec.size_bytes = 20;
    rec.row_count = 2;
    rec.status = "validated";
    store::putVersion(rec);
  }
}

void refused(harness::Ctx& ctx, const std::string& version, const std::string& why) {
  try {
    purge(kDS, version);
  } catch (const VersionPinned&) {
    return;
  }
  ctx.Fatalf("purge(%q) went through while %s: a run reading it loses its data. Throw VersionPinned", version, why);
}

}  // namespace

void CheckAtomicPromotion(harness::Ctx& ctx) {
  setup();
  ctx.Equal(promote(kDS, "2026-01", "alice"), "", "the first promotion has no previous version; promote returned");
  std::string seen;
  ctx.Redis.After(kAudit, [&] { seen = ctx.Redis.Get(kLatest).value_or("") + "/" + std::to_string(ctx.Redis.LLen(kAudit)); });
  const std::string previous = promote(kDS, "2026-02", "bob");
  ctx.Assert(!seen.empty(), "the promotion of 2026-02 never touched the audit list");
  ctx.Assert(seen == "2026-01/1" || seen == "2026-02/2",
             "a reader between the commands saw latest/audit entries %s: the pointer and its audit entry must change together, in one Lua script", seen);
  ctx.Equal(previous, "2026-01", "promote must return the previous latest");
  ctx.Equal(ctx.Redis.LRange(kAudit, 0, -1), {"->2026-01 by alice", "2026-01->2026-02 by bob"}, "the audit list");
  ctx.Equal(ctx.Redis.Get(kLatest).value_or(""), "2026-02", "the pointer after promoting 2026-02");
}

void CheckDurablePointer(harness::Ctx& ctx) {
  setup();
  promote(kDS, "2026-01", "alice");
  promote(kDS, "2026-02", "bob");
  ctx.Equal(ctx.Redis.Get(kLatest).value_or(""), "2026-02", "the pointer after two promotions");
  const long long ttl = ctx.Redis.TTL(kLatest);
  ctx.Equal(ttl, -1LL, "%s expires in %d s: a dataset nobody promotes for that long loses its latest version. The pointer must not expire; its TTL", kLatest, ttl);
}

void CheckFailClosed(harness::Ctx& ctx) {
  setup();
  std::string got;
  try {
    got = latest("wiki-text");
    ctx.Fatalf("latest(wiki-text) returned %q for a dataset with no promoted version: a caller passes that on as a version. Throw LatestVersionMissing", got);
  } catch (const LatestVersionMissing&) {
  }
  promote(kDS, "2026-01", "alice");
  ctx.Equal(latest(kDS), "2026-01", "latest after promoting 2026-01");
}

void CheckPinsIndependent(harness::Ctx& ctx) {
  setup();
  promote(kDS, "2026-01", "alice");
  pin(kDS, "run-7", "2026-01");
  promote(kDS, "2026-02", "bob");
  ctx.Equal(ctx.Redis.HGet(kPins, "run-7").value_or(""), "2026-01", "run-7 pinned 2026-01: a promotion must leave the pins alone; run-7 reads");
  refused(ctx, "2026-01", "run-7 pins it");
  ctx.Assert(store::version(kDS, "2026-01").has_value(), "the pinned version's record is gone");
  refused(ctx, "2026-02", "it is the latest");
  ctx.Assert(store::version(kDS, "2026-02").has_value(), "the latest version's record is gone");
  purge(kDS, "2025-12");
  ctx.Assert(!store::version(kDS, "2025-12"), "a version nobody pins and that is not the latest must be purged");
  ctx.Equal(store::versions(kDS), {"2026-01", "2026-02"}, "the versions left after the purge");
}
`,
  },
  hints: [
    'Pin a run to `2026-01`, promote `2026-02`, and read the pin back: it says `2026-02`. Leave a dataset alone for an hour and `latest` answers an empty name.',
    'The audit append and the pointer write are two commands, so a reader can land between them; the pointer is written with an expiry; the promotion loops over the pins; and `purge` deletes without looking at pins or the pointer.',
    'One Lua script: `GET` the pointer, `SET` it without `EX`, `RPUSH` the entry, return the previous. Raise `LatestVersionMissing` on a nil read, drop the pin loop, and purge in a script returning 0 for the latest or any `HVALS` pin.',
  ],
  debrief: `The pointer is the only mutable thing in a registry of immutable versions, which is why everything that changes it lives in one script: the audit entry records exactly the promotion that happened, with the previous version read inside the same step. Pins are owned by their consumers, so a promotion has no business writing them, and a purge has to check them in the same script that deletes or a pin can land in the gap. Failing closed on a missing pointer turns a silent "train on whatever" into an error someone sees. Registries in production also keep the audit list in durable storage with timestamps, expire pins with the runs that hold them, and require a second approver before promoting a dataset many runs consume.`,
};
