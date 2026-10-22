import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis evaluation cache with a single versioned snapshot',
  concept: 'redis',
  file: 'state',
  focus: ['redis', 'engine'],
  task: `## Task

Every service evaluates flags on every request, so the rule set lives in Redis as a **cache of the flag
store**. The starter is the model-generated draft: it caches each flag under its own key and computes a
bucket from the user id and a salt. It serves the demo and hides two flaws.

Cache the **whole rule set as one versioned snapshot object** under \`flags:snapshot\`, and evaluate a
flag for a user from that snapshot.

- The snapshot is a single JSON object \`{"version": N, "flags": {"checkout-redesign": {"salt": …,
  "rollout": 25, "enabled": true, "default": false}}}\`, read with **one** \`GET flags:snapshot\`. A
  reader must never observe a rule set stitched from two versions — an update is a **single atomic
  write of that one key**, so a reader sees either the old object or the new one.
- Bucketing is deterministic: \`bucket(flag key, user id, salt)\` hashes all three and returns \`0–99\`.
  The **flag key must be an input**, so each flag splits users independently — with a keyless hash a
  canary flag and a payment flag put the same users in the same tail.
- For an unchanged snapshot version the same \`(flag key, user id)\` must land in the same bucket on
  every instance and every call — no per-call randomness, no clock.
- \`evaluate\` returns \`{"key", "value", "bucket", "version"}\`, where \`value\` is the flag's \`enabled\`
  value when \`bucket < rollout\` and its \`default\` otherwise, and \`version\` is the snapshot version
  that produced the decision.

**The subtle flaw.** The draft writes \`flag:{key}:rules\` per flag, so ten flag changes apply
gradually and a reader can read flag A from the new version and flag B from the old one — a torn rule
set. Its bucket hash omits the flag key, so every flag applies the identical split.`,
  sequence: {
    participants: ['Client', 'Evaluation Engine', 'Redis', 'Flag Service'],
    messages: [
      {from: 'Client', to: 'Evaluation Engine', label: 'GET /v1/flags/{key}/evaluate · user id', kind: 'sync'},
      {from: 'Evaluation Engine', to: 'Redis', label: 'GET flags:snapshot', kind: 'sync'},
      {from: 'Redis', to: 'Evaluation Engine', label: '{version, flags} · one object', kind: 'reply'},
      {from: 'Evaluation Engine', to: 'Evaluation Engine', label: 'bucket(flag key, user id, salt)', kind: 'sync'},
      {from: 'Flag Service', to: 'Redis', label: 'SET flags:snapshot · next version', kind: 'async'},
      {from: 'Evaluation Engine', to: 'Client', label: '{value, bucket, version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'snapshot',
      title: 'Reads one versioned snapshot object, not per-flag entries',
      detail:
        'The rule set is cached as one object under `flags:snapshot`. The draft caches each flag under `flag:{key}:rules`, so a reader can combine two versions.',
      match: {
        python: {all: [/flags:snapshot/]},
        typescript: {all: [/flags:snapshot/]},
        go: {all: [/flags:snapshot/]},
        scala: {all: [/flags:snapshot/]},
        cpp: {all: [/flags:snapshot/]},
      },
    },
    {
      id: 'atomic',
      title: 'Swaps the snapshot atomically in one write',
      detail:
        'The update publishes the whole object to `flags:snapshot` in a single atomic write. The draft updates each flag separately, so a rule change applies gradually.',
      match: {
        python: {all: [/def swap_snapshot\(/, /\.set\(\s*SNAPSHOT_KEY/]},
        typescript: {all: [/swapSnapshot\s*\(/, /\.set\(\s*SNAPSHOT_KEY/]},
        go: {all: [/func SwapSnapshot\(/, /\.Set\(\s*ctx\s*,\s*SnapshotKey/]},
        scala: {all: [/def swapSnapshot\(/, /\.set\(\s*Snapshot\.key/]},
        cpp: {all: [/swap_snapshot\(/, /\.set\(\s*snapshotKey/]},
      },
    },
    {
      id: 'bucket-key',
      title: 'Buckets with the flag key in the hash',
      detail:
        'Bucketing hashes the flag key together with the user id and the salt, so each flag splits users independently. The draft hashes only the user id and salt, so every flag buckets a user identically.',
      match: {
        python: {all: [/def bucket\(\s*flag_key/]},
        typescript: {all: [/bucket\s*=\s*\(\s*flagKey|function bucket\(\s*flagKey/]},
        go: {all: [/func Bucket\(\s*flagKey/]},
        scala: {all: [/def bucket\(\s*flagKey/]},
        cpp: {all: [/bucket\(\s*const std::string&\s*flag_key/]},
      },
    },
    {
      id: 'deterministic',
      title: 'Bucketing is deterministic — no randomness, no clock',
      detail:
        'The same `(flag key, user id)` lands in the same bucket for an unchanged version: the salt is stable and nothing in the bucket path reads a random source or the clock.',
      match: {
        python: {all: [/salt/], none: [/random|urandom/]},
        typescript: {all: [/salt/], none: [/Math\.random|randomUUID/]},
        go: {all: [/salt/], none: [/math\/rand|rand\./]},
        scala: {all: [/salt/], none: [/Random|nextInt/]},
        cpp: {all: [/salt/], none: [/\brand\(\)|std::rand/]},
      },
    },
    {
      id: 'version',
      title: 'The decision names the snapshot version it read',
      detail:
        'An evaluation returns the snapshot version that produced it, so an unchanged version can be shown to never re-bucket a user.',
      match: {
        python: {all: [/snapshot\["version"\]/]},
        typescript: {all: [/snapshot\.version/]},
        go: {all: [/snapshot\.Version/]},
        scala: {all: [/snapshot\.version/]},
        cpp: {all: [/snapshot\["version"\]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json

import redis as redis_client


def bucket(user_id: str, salt: str) -> int:
    digest = hashlib.sha256(f"{user_id}:{salt}".encode()).hexdigest()
    return int(digest[:8], 16) % 100


def cache_flag(redis: redis_client.Redis, flag: dict) -> None:
    # TODO: this draft updates one cache entry per flag, so a rule change across ten flags applies
    # gradually and a reader can see a torn rule set; its bucket hash also omits the flag key, so
    # every flag buckets a user identically.
    redis.set(f"flag:{flag['key']}:rules", json.dumps(flag))


def evaluate(redis: redis_client.Redis, flag_key: str, user_id: str) -> dict:
    flag = json.loads(redis.get(f"flag:{flag_key}:rules"))
    position = bucket(user_id, flag["salt"])
    value = flag["enabled"] if position < flag["rollout"] else flag["default"]
    return {"key": flag_key, "value": value, "bucket": position}
`,
      solution: `import hashlib
import json

SNAPSHOT_KEY = "flags:snapshot"


def bucket(flag_key: str, user_id: str, salt: str) -> int:
    digest = hashlib.sha256(f"{flag_key}:{user_id}:{salt}".encode()).hexdigest()
    return int(digest[:8], 16) % 100


def swap_snapshot(redis, snapshot: dict) -> None:
    # One key, one write: readers see either the old object or the new one, never a mix.
    redis.set(SNAPSHOT_KEY, json.dumps(snapshot))


def evaluate(redis, flag_key: str, user_id: str) -> dict:
    snapshot = json.loads(redis.get(SNAPSHOT_KEY))
    flag = snapshot["flags"][flag_key]
    position = bucket(flag_key, user_id, flag["salt"])
    value = flag["enabled"] if position < flag["rollout"] else flag["default"]
    return {
        "key": flag_key,
        "value": value,
        "bucket": position,
        "version": snapshot["version"],
    }
`,
    },
    typescript: {
      starter: `import type {Redis} from 'ioredis';
import {createHash} from 'node:crypto';

function bucket(userId: string, salt: string): number {
  const digest = createHash('sha256').update(\`\${userId}:\${salt}\`).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

interface CachedFlag {
  key: string;
  salt: string;
  rollout: number;
  enabled: boolean;
  default: boolean;
}

async function cacheFlag(redis: Redis, flag: CachedFlag): Promise<void> {
  // TODO: this draft updates one cache entry per flag, so a rule change across ten flags applies
  // gradually and a reader can see a torn rule set; its bucket hash also omits the flag key, so
  // every flag buckets a user identically.
  await redis.set(\`flag:\${flag.key}:rules\`, JSON.stringify(flag));
}

async function evaluate(redis: Redis, flagKey: string, userId: string): Promise<unknown> {
  const flag = JSON.parse((await redis.get(\`flag:\${flagKey}:rules\`)) ?? '{}') as CachedFlag;
  const position = bucket(userId, flag.salt);
  const value = position < flag.rollout ? flag.enabled : flag.default;
  return {key: flagKey, value, bucket: position};
}
`,
      solution: `import type {Redis} from 'ioredis';
import {createHash} from 'node:crypto';

const SNAPSHOT_KEY = 'flags:snapshot';

interface Snapshot {
  version: number;
  flags: Record<string, {salt: string; rollout: number; enabled: boolean; default: boolean}>;
}

function bucket(flagKey: string, userId: string, salt: string): number {
  const digest = createHash('sha256').update(\`\${flagKey}:\${userId}:\${salt}\`).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

async function swapSnapshot(redis: Redis, snapshot: Snapshot): Promise<void> {
  // One key, one write: readers see either the old object or the new one, never a mix.
  await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

async function evaluate(redis: Redis, flagKey: string, userId: string): Promise<unknown> {
  const snapshot = JSON.parse((await redis.get(SNAPSHOT_KEY)) ?? '{}') as Snapshot;
  const flag = snapshot.flags[flagKey];
  const position = bucket(flagKey, userId, flag.salt);
  const value = position < flag.rollout ? flag.enabled : flag.default;
  return {key: flagKey, value, bucket: position, version: snapshot.version};
}
`,
    },
    go: {
      starter: `package flags

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
	"context"
)

func Bucket(userID, salt string) int {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s", userID, salt)))
	return (int(sum[0])<<8 | int(sum[1])) % 100
}

func CacheFlag(ctx context.Context, rdb *redis.Client, flag map[string]interface{}) error {
	// TODO: this draft updates one cache entry per flag, so a rule change across ten flags applies
	// gradually and a reader can see a torn rule set; its bucket hash also omits the flag key, so
	// every flag buckets a user identically.
	payload, _ := json.Marshal(flag)
	return rdb.Set(ctx, "flag:"+flag["key"].(string)+":rules", payload, 0).Err()
}
`,
      solution: `package flags

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const SnapshotKey = "flags:snapshot"

type Flag struct {
	Salt    string \`json:"salt"\`
	Rollout int    \`json:"rollout"\`
	Enabled bool   \`json:"enabled"\`
	Default bool   \`json:"default"\`
}

type Snapshot struct {
	Version int             \`json:"version"\`
	Flags   map[string]Flag \`json:"flags"\`
}

func Bucket(flagKey, userID, salt string) int {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%s", flagKey, userID, salt)))
	return (int(sum[0])<<8 | int(sum[1])) % 100
}

func SwapSnapshot(ctx context.Context, rdb *redis.Client, snap Snapshot) error {
	payload, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, SnapshotKey, payload, 0).Err()
}

func Evaluate(ctx context.Context, rdb *redis.Client, flagKey, userID string) (map[string]interface{}, error) {
	raw, err := rdb.Get(ctx, SnapshotKey).Result()
	if err != nil {
		return nil, err
	}
	var snapshot Snapshot
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		return nil, err
	}
	flag := snapshot.Flags[flagKey]
	position := Bucket(flagKey, userID, flag.Salt)
	value := flag.Default
	if position < flag.Rollout {
		value = flag.Enabled
	}
	return map[string]interface{}{
		"key":     flagKey,
		"value":   value,
		"bucket":  position,
		"version": snapshot.Version,
	}, nil
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import com.redis.RedisClient

def bucket(userId: String, salt: String): Int = {
  val digest = MessageDigest.getInstance("SHA-256").digest(s"$userId:$salt".getBytes("UTF-8"))
  ((digest(0) & 0xff) << 8 | (digest(1) & 0xff)) % 100
}

def cacheFlag(redis: RedisClient, flag: Map[String, Any]): Unit = {
  // TODO: this draft updates one cache entry per flag, so a rule change across ten flags applies
  // gradually and a reader can see a torn rule set; its bucket hash also omits the flag key, so
  // every flag buckets a user identically.
  redis.set(s"flag:\${flag("key")}:rules", flag.toString)
}

def evaluate(redis: RedisClient, flagKey: String, userId: String): Map[String, Any] = {
  val flag = Map("salt" -> "v1", "rollout" -> 25, "enabled" -> true, "default" -> false)
  val position = bucket(userId, flag("salt").toString)
  Map("key" -> flagKey, "bucket" -> position)
}
`,
      solution: `import java.security.MessageDigest
import com.redis.RedisClient
import spray.json._
import DefaultJsonProtocol._

object Snapshot {
  val key = "flags:snapshot"
}

def bucket(flagKey: String, userId: String, salt: String): Int = {
  val digest = MessageDigest.getInstance("SHA-256").digest(s"$flagKey:$userId:$salt".getBytes("UTF-8"))
  ((digest(0) & 0xff) << 8 | (digest(1) & 0xff)) % 100
}

def swapSnapshot(redis: RedisClient, payload: String): Unit = {
  // One key, one write: readers see either the old object or the new one, never a mix.
  redis.set(Snapshot.key, payload)
}

case class Flag(salt: String, rollout: Int, enabled: Boolean, default: Boolean)
case class SnapshotDoc(version: Int, flags: Map[String, Flag])

object SnapshotJson extends DefaultJsonProtocol {
  implicit val flagFormat: JsonFormat[Flag] = jsonFormat4(Flag)
  implicit val docFormat: JsonFormat[SnapshotDoc] = jsonFormat2(SnapshotDoc)
}

def evaluate(redis: RedisClient, flagKey: String, userId: String): Map[String, Any] = {
  import SnapshotJson._
  val snapshot = redis.get(Snapshot.key).get.parseJson.convertTo[SnapshotDoc]
  val flag = snapshot.flags(flagKey)
  val position = bucket(flagKey, userId, flag.salt)
  val value = if (position < flag.rollout) flag.enabled else flag.default
  Map(
    "key" -> flagKey,
    "value" -> value,
    "bucket" -> position,
    "version" -> snapshot.version,
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

static unsigned long long fnv1a(const std::string& s) {
  unsigned long long h = 1469598103934665603ULL;
  for (char c : s) {
    h ^= static_cast<unsigned char>(c);
    h *= 1099511628211ULL;
  }
  return h;
}

int bucket(const std::string& user_id, const std::string& salt) {
  return static_cast<int>(fnv1a(user_id + ":" + salt) % 100);
}

// TODO: this draft updates one cache entry per flag, so a rule change across ten flags applies
// gradually and a reader can see a torn rule set; its bucket hash also omits the flag key, so
// every flag buckets a user identically.
void cache_flag(httplib::Client& redis, const json& flag) {
  redis.set("flag:" + flag["key"].get<std::string>() + ":rules", flag.dump());
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

static const std::string snapshotKey = "flags:snapshot";

static unsigned long long fnv1a(const std::string& s) {
  unsigned long long h = 1469598103934665603ULL;
  for (char c : s) {
    h ^= static_cast<unsigned char>(c);
    h *= 1099511628211ULL;
  }
  return h;
}

int bucket(const std::string& flag_key, const std::string& user_id, const std::string& salt) {
  return static_cast<int>(fnv1a(flag_key + ":" + user_id + ":" + salt) % 100);
}

void swap_snapshot(httplib::Client& redis, const json& snapshot) {
  // One key, one write: readers see either the old object or the new one, never a mix.
  redis.set(snapshotKey, snapshot.dump());
}

json evaluate(httplib::Client& redis, const std::string& flag_key, const std::string& user_id) {
  json snapshot = json::parse(redis.get(snapshotKey)->body);
  json flag = snapshot["flags"][flag_key];
  int position = bucket(flag_key, user_id, flag["salt"].get<std::string>());
  bool value = position < flag["rollout"].get<int>() ? flag["enabled"].get<bool>() : flag["default"].get<bool>();
  return json{
      {"key", flag_key},
      {"value", value},
      {"bucket", position},
      {"version", snapshot["version"]},
  };
}
`,
    },
  },
  hints: [
    'Cache the rule set as **one** object under one key and swap that key in a single write. If you update flag-by-flag, a reader can pair flag A from the new version with flag B from the old one.',
    'The bucket hash must take the **flag key** as an input alongside the user id and the salt, or every flag applies the identical split and the same users sit in the same tail everywhere.',
    'Keep the salt stable per flag version. A per-call random salt re-buckets a user between evaluations even when nothing about the flag changed.',
  ],
  debrief: `The interviewer is testing whether you understand what "cache" means for a rule set read on every request. Two defects are checked: the snapshot must be one object swapped atomically — per-flag entries let a reader observe a torn rule set mid-update — and the bucket hash must include the flag key, or every flag applies the same split and a canary and a payment flag move the same users together. Deterministic bucketing means the same \`(flag key, user id)\` lands in the same bucket for an unchanged version; the follow-up question is how to keep that true across a flag rename, which needs a stable flag id or a per-flag salt rather than the key itself.`,
};
