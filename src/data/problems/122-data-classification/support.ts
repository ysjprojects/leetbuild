/**
 * Hand-written support modules the data-classification steps import but no step builds: the
 * `metasense` package. `taxonomy` is the closed tag library (steps 2 and 4); `jobs` the classification
 * job queue and the schema hash (steps 1 and 3); `store` the verification store and the outbox (steps
 * 4 and 5). Everything lives in Redis under one key layout, so a harness reads the same keys whatever
 * the stack:
 *
 *   jobs:queue                       list of JSON jobs {entity, owner, schema_hash, columns}
 *   jobs:seen                        set of "{entity}:{schema_hash}" already queued
 *   classify:{entity}:{schema_hash}  the tags as a JSON object column → tag (step 3, 7 days)
 *   verify:{entity}                  hash owner, schema_hash, state (step 3 opens it, 7 days)
 *   entity:{entity}                  hash tier, tags (JSON), verified_by, version
 *   audit:{entity}                   list of JSON {user, action, at}
 *   outbox                           list of JSON {topic, key, payload}
 *   catalog:{entity}                 hash tier, tags (JSON), version: the metadata store's copy
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'metasense/__init__.py': '',
  'metasense/taxonomy.py': `"""
The tag library (provided): the only tags a column may carry. "None" is a tag too: nothing
sensitive in the column. known(tag) says whether a value is one of them.
"""
TAXONOMY = ("Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None")


def known(tag) -> bool:
    return isinstance(tag, str) and tag in TAXONOMY
`,
  'metasense/jobs.py': `"""
The job queue (provided): a classification job waits as a JSON document {entity, owner,
schema_hash, columns} on the Redis list jobs:queue for the classifier worker; jobs:seen is the set
of "{entity}:{schema_hash}" already queued. schema_hash(columns) is the hex SHA-256 of the column
names joined by a newline.
"""
import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "jobs:queue"
SEEN_KEY = "jobs:seen"


def schema_hash(columns: list[str]) -> str:
    return hashlib.sha256("\\n".join(columns).encode("utf-8")).hexdigest()


def seen(entity: str, digest: str) -> bool:
    """Whether a job for this exact schema of the entity was already queued."""
    return bool(r.sismember(SEEN_KEY, f"{entity}:{digest}"))


def mark_seen(entity: str, digest: str) -> None:
    r.sadd(SEEN_KEY, f"{entity}:{digest}")


def enqueue(job: dict) -> None:
    """Append one job for the classifier worker."""
    r.rpush(QUEUE_KEY, json.dumps(job))
`,
  'metasense/store.py': `"""
The verification store (provided). verify:{entity} is the verification step 3 opens (a hash: owner,
schema_hash, state) and classify:{entity}:{schema_hash} the tags it cached (a JSON object column →
tag); entity:{entity} holds the verified classification (tier, tags as JSON, verified_by, version),
audit:{entity} one JSON entry {user, action, at} per verification, and outbox the JSON rows {topic,
key, payload} a relay republishes when the broker refused them. catalog:{entity} is the metadata
store's copy of the published classification (tier, tags as JSON, version), what access control reads.
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def pending(entity: str) -> dict | None:
    """The open verification {owner, schema_hash, tags}, or None when nothing waits for the owner."""
    row = r.hgetall(f"verify:{entity}")
    if not row:
        return None
    raw = r.get(f"classify:{entity}:{row['schema_hash']}")
    return {"owner": row["owner"], "schema_hash": row["schema_hash"], "tags": json.loads(raw) if raw else {}}


def record_verification(entity: str, tags: dict, tier: int, verified_by: str) -> int:
    """Store the verified classification and close the verification; returns the new version."""
    version = r.hincrby(f"entity:{entity}", "version", 1)
    r.hset(f"entity:{entity}", mapping={"tier": tier, "tags": json.dumps(tags, sort_keys=True), "verified_by": verified_by})
    r.hset(f"verify:{entity}", "state", "verified")
    return version


def audit(entity: str, user: str, action: str) -> None:
    r.rpush(f"audit:{entity}", json.dumps({"user": user, "action": action, "at": int(time.time())}))


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def catalog_version(entity: str) -> int:
    """The version of the entity's classification the metadata store holds; 0 before the first."""
    return int(r.hget(f"catalog:{entity}", "version") or 0)


def upsert_catalog(entity: str, tier: int, tags: dict, version: int) -> None:
    r.hset(f"catalog:{entity}", mapping={"tier": tier, "tags": json.dumps(tags, sort_keys=True), "version": version})
`,
};

export const supportModulesTs: Record<string, string> = {
  'metasense/taxonomy.ts': `/**
 * The tag library (provided): the only tags a column may carry. "None" is a tag too: nothing
 * sensitive in the column. known(tag) says whether a value is one of them.
 */
export const TAXONOMY: readonly string[] = ['Personal.ID', 'Personal.Name', 'Personal.Contact_Info', 'Geo.Geohash', 'None'];

export const known = (tag: unknown): boolean => typeof tag === 'string' && TAXONOMY.includes(tag);
`,
  'metasense/jobs.ts': `/**
 * The job queue (provided): a classification job waits as a JSON document {entity, owner,
 * schema_hash, columns} on the Redis list jobs:queue for the classifier worker; jobs:seen is the set
 * of "{entity}:{schema_hash}" already queued. schemaHash(columns) is the hex SHA-256 of the column
 * names joined by a newline.
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const QUEUE_KEY = 'jobs:queue';
export const SEEN_KEY = 'jobs:seen';

export interface Job {
  entity: string;
  owner: string;
  schema_hash?: string;
  columns: string[];
}

export const schemaHash = (columns: string[]): string => createHash('sha256').update(columns.join('\\n')).digest('hex');

/** Whether a job for this exact schema of the entity was already queued. */
export async function seen(entity: string, digest: string): Promise<boolean> {
  return (await redis.sismember(SEEN_KEY, \`\${entity}:\${digest}\`)) === 1;
}

export async function markSeen(entity: string, digest: string): Promise<void> {
  await redis.sadd(SEEN_KEY, \`\${entity}:\${digest}\`);
}

/** Append one job for the classifier worker. */
export async function enqueue(job: Job): Promise<void> {
  await redis.rpush(QUEUE_KEY, JSON.stringify(job));
}
`,
  'metasense/store.ts': `/**
 * The verification store (provided). verify:{entity} is the verification step 3 opens (a hash:
 * owner, schema_hash, state) and classify:{entity}:{schema_hash} the tags it cached (a JSON object
 * column → tag); entity:{entity} holds the verified classification (tier, tags as JSON, verified_by,
 * version), audit:{entity} one JSON entry {user, action, at} per verification, and outbox the JSON
 * rows {topic, key, payload} a relay republishes when the broker refused them. catalog:{entity} is
 * the metadata store's copy of the published classification (tier, tags as JSON, version), what
 * access control reads.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Verification {
  owner: string;
  schema_hash: string;
  tags: Record<string, string>;
}

/** The open verification, or null when nothing waits for the owner. */
export async function pending(entity: string): Promise<Verification | null> {
  const row = await redis.hgetall(\`verify:\${entity}\`);
  if (Object.keys(row).length === 0) return null;
  const raw = await redis.get(\`classify:\${entity}:\${row.schema_hash}\`);
  return {owner: row.owner, schema_hash: row.schema_hash, tags: raw === null ? {} : (JSON.parse(raw) as Record<string, string>)};
}

/** Store the verified classification and close the verification; resolves the new version. */
export async function recordVerification(entity: string, tags: Record<string, string>, tier: number, verifiedBy: string): Promise<number> {
  const version = await redis.hincrby(\`entity:\${entity}\`, 'version', 1);
  const sorted = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await redis.hset(\`entity:\${entity}\`, {tier: String(tier), tags: JSON.stringify(sorted), verified_by: verifiedBy});
  await redis.hset(\`verify:\${entity}\`, 'state', 'verified');
  return version;
}

export async function audit(entity: string, user: string, action: string): Promise<void> {
  await redis.rpush(\`audit:\${entity}\`, JSON.stringify({user, action, at: Math.floor(Date.now() / 1000)}));
}

export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

/** The version of the entity's classification the metadata store holds; 0 before the first. */
export async function catalogVersion(entity: string): Promise<number> {
  return Number((await redis.hget(\`catalog:\${entity}\`, 'version')) ?? 0);
}

export async function upsertCatalog(entity: string, tier: number, tags: Record<string, string>, version: number): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await redis.hset(\`catalog:\${entity}\`, {tier: String(tier), tags: JSON.stringify(sorted), version: String(version)});
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'metasense/taxonomy/taxonomy.go': `// Package taxonomy is the tag library (provided): the only tags a column may carry. "None" is a
// tag too: nothing sensitive in the column. Known says whether a value is one of them.
package taxonomy

// Tags is the library, in the order the prompt lists it.
var Tags = []string{"Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None"}

// Known reports whether tag is in the library.
func Known(tag string) bool {
	for _, t := range Tags {
		if t == tag {
			return true
		}
	}
	return false
}
`,
  'metasense/jobs/jobs.go': `// Package jobs is the job queue (provided): a classification job waits as a JSON document
// {entity, owner, schema_hash, columns} on the Redis list jobs:queue for the classifier worker;
// jobs:seen is the set of "{entity}:{schema_hash}" already queued. SchemaHash is the hex SHA-256 of
// the column names joined by a newline.
package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	QueueKey = "jobs:queue"
	SeenKey  = "jobs:seen"
)

// Job is one entity to classify.
type Job struct {
	Entity     string   \`json:"entity"\`
	Owner      string   \`json:"owner"\`
	SchemaHash string   \`json:"schema_hash,omitempty"\`
	Columns    []string \`json:"columns"\`
}

// SchemaHash is the hex SHA-256 of the column names joined by a newline.
func SchemaHash(columns []string) string {
	sum := sha256.Sum256([]byte(strings.Join(columns, "\\n")))
	return hex.EncodeToString(sum[:])
}

// Seen reports whether a job for this exact schema of the entity was already queued.
func Seen(ctx context.Context, entity, digest string) (bool, error) {
	return rdb.SIsMember(ctx, SeenKey, entity+":"+digest).Result()
}

// MarkSeen records that a job for this schema of the entity is queued.
func MarkSeen(ctx context.Context, entity, digest string) error {
	return rdb.SAdd(ctx, SeenKey, entity+":"+digest).Err()
}

// Enqueue appends one job for the classifier worker.
func Enqueue(ctx context.Context, job Job) error {
	raw, err := json.Marshal(job)
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, QueueKey, raw).Err()
}
`,
  'metasense/store/store.go': `// Package store is the verification store (provided). verify:{entity} is the verification step 3
// opens (a hash: owner, schema_hash, state) and classify:{entity}:{schema_hash} the tags it cached (a
// JSON object column → tag); entity:{entity} holds the verified classification (tier, tags as JSON,
// verified_by, version), audit:{entity} one JSON entry {user, action, at} per verification, and
// outbox the JSON rows {topic, key, payload} a relay republishes when the broker refused them.
// catalog:{entity} is the metadata store's copy of the published classification (tier, tags as JSON,
// version), what access control reads.
package store

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Verification is what waits for the owner: who owns the entity, which schema was classified, the tags.
type Verification struct {
	Owner      string
	SchemaHash string
	Tags       map[string]string
}

// Pending is the open verification, or nil when nothing waits for the owner.
func Pending(ctx context.Context, entity string) (*Verification, error) {
	row, err := rdb.HGetAll(ctx, "verify:"+entity).Result()
	if err != nil || len(row) == 0 {
		return nil, err
	}
	v := &Verification{Owner: row["owner"], SchemaHash: row["schema_hash"], Tags: map[string]string{}}
	raw, err := rdb.Get(ctx, "classify:"+entity+":"+row["schema_hash"]).Result()
	if err == redis.Nil {
		return v, nil
	}
	if err != nil {
		return nil, err
	}
	return v, json.Unmarshal([]byte(raw), &v.Tags)
}

// RecordVerification stores the verified classification and closes the verification; it returns the new version.
func RecordVerification(ctx context.Context, entity string, tags map[string]string, tier int, verifiedBy string) (int64, error) {
	version, err := rdb.HIncrBy(ctx, "entity:"+entity, "version", 1).Result()
	if err != nil {
		return 0, err
	}
	raw, _ := json.Marshal(tags)
	if err := rdb.HSet(ctx, "entity:"+entity, map[string]any{"tier": strconv.Itoa(tier), "tags": string(raw), "verified_by": verifiedBy}).Err(); err != nil {
		return 0, err
	}
	return version, rdb.HSet(ctx, "verify:"+entity, "state", "verified").Err()
}

// Audit appends who verified the entity, how, and when.
func Audit(ctx context.Context, entity, user, action string) error {
	raw, _ := json.Marshal(map[string]any{"user": user, "action": action, "at": time.Now().Unix()})
	return rdb.RPush(ctx, "audit:"+entity, raw).Err()
}

// InsertOutbox keeps a record the broker refused, for the relay.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", raw).Err()
}

// CatalogVersion is the version of the entity's classification the metadata store holds; 0 before the first.
func CatalogVersion(ctx context.Context, entity string) (int64, error) {
	version, err := rdb.HGet(ctx, "catalog:"+entity, "version").Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return version, err
}

// UpsertCatalog writes the metadata store's copy of the entity's classification.
func UpsertCatalog(ctx context.Context, entity string, tier int, tags map[string]string, version int64) error {
	raw, _ := json.Marshal(tags)
	return rdb.HSet(ctx, "catalog:"+entity, map[string]any{"tier": strconv.Itoa(tier), "tags": string(raw), "version": strconv.FormatInt(version, 10)}).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'metasense/taxonomy.h': `// The tag library (provided): the only tags a column may carry. "None" is a tag too: nothing
// sensitive in the column. known(tag) says whether a value is one of them.
#pragma once

#include <algorithm>
#include <string>
#include <vector>

namespace taxonomy {

inline const std::vector<std::string> kTags = {"Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None"};

inline bool known(const std::string& tag) { return std::find(kTags.begin(), kTags.end(), tag) != kTags.end(); }

}  // namespace taxonomy
`,
  'metasense/jobs.h': `// The job queue (provided): a classification job waits as a JSON document {entity, owner,
// schema_hash, columns} on the Redis list jobs:queue for the classifier worker; jobs:seen is the set
// of "{entity}:{schema_hash}" already queued. schemaHash(columns) is the hex SHA-256 of the column
// names joined by a newline.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "digest.h"

namespace jobs {

inline const std::string kQueueKey = "jobs:queue";
inline const std::string kSeenKey = "jobs:seen";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string schemaHash(const std::vector<std::string>& columns) {
  std::string joined;
  for (size_t i = 0; i < columns.size(); i++) joined += (i == 0 ? "" : "\\n") + columns[i];
  return sha256_hex(joined);
}

// Whether a job for this exact schema of the entity was already queued.
inline bool seen(const std::string& entity, const std::string& digest) { return redis().sismember(kSeenKey, entity + ":" + digest); }

inline void markSeen(const std::string& entity, const std::string& digest) { redis().sadd(kSeenKey, entity + ":" + digest); }

// Append one job ({entity, owner, schema_hash, columns}) for the classifier worker.
inline void enqueue(const nlohmann::json& job) { redis().rpush(kQueueKey, job.dump()); }

}  // namespace jobs
`,
  'metasense/store.h': `// The verification store (provided). verify:{entity} is the verification step 3 opens (a hash:
// owner, schema_hash, state) and classify:{entity}:{schema_hash} the tags it cached (a JSON object
// column → tag); entity:{entity} holds the verified classification (tier, tags as JSON, verified_by,
// version), audit:{entity} one JSON entry {user, action, at} per verification, and outbox the JSON
// rows {topic, key, payload} a relay republishes when the broker refused them. catalog:{entity} is
// the metadata store's copy of the published classification (tier, tags as JSON, version), what
// access control reads.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>

namespace store {

// What waits for the owner: who owns the entity, which schema was classified, the tags.
struct Verification {
  std::string owner;
  std::string schema_hash;
  std::map<std::string, std::string> tags;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The open verification, or none when nothing waits for the owner.
inline std::optional<Verification> pending(const std::string& entity) {
  const std::unordered_map<std::string, std::string> row = redis().hgetall("verify:" + entity);
  if (row.empty()) return std::nullopt;
  Verification v;
  v.owner = row.count("owner") ? row.at("owner") : "";
  v.schema_hash = row.count("schema_hash") ? row.at("schema_hash") : "";
  const auto raw = redis().get("classify:" + entity + ":" + v.schema_hash);
  if (raw) {
    const nlohmann::json cached = nlohmann::json::parse(*raw);  // named: items() would outlive a temporary
    for (const auto& [column, tag] : cached.items()) {
      if (tag.is_string()) v.tags[column] = tag.get<std::string>();
    }
  }
  return v;
}

// Store the verified classification and close the verification; returns the new version.
inline long long recordVerification(const std::string& entity, const std::map<std::string, std::string>& tags, int tier,
                                    const std::string& verified_by) {
  const long long version = redis().hincrby("entity:" + entity, "version", 1);
  redis().hset("entity:" + entity, {{"tier", std::to_string(tier)}, {"tags", nlohmann::json(tags).dump()}, {"verified_by", verified_by}});
  redis().hset("verify:" + entity, "state", "verified");
  return version;
}

inline void audit(const std::string& entity, const std::string& user, const std::string& action) {
  const auto at = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  redis().rpush("audit:" + entity, nlohmann::json{{"user", user}, {"action", action}, {"at", at}}.dump());
}

inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The version of the entity's classification the metadata store holds; 0 before the first.
inline long long catalogVersion(const std::string& entity) {
  const auto version = redis().hget("catalog:" + entity, "version");
  return version ? std::stoll(*version) : 0;
}

inline void upsertCatalog(const std::string& entity, int tier, const std::map<std::string, std::string>& tags, long long version) {
  redis().hset("catalog:" + entity, {{"tier", std::to_string(tier)}, {"tags", nlohmann::json(tags).dump()}, {"version", std::to_string(version)}});
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('metasense', 'Taxonomy')]: `package metasense

/**
 * The tag library (provided): the only tags a column may carry. "None" is a tag too: nothing
 * sensitive in the column. known(tag) says whether a value is one of them.
 */
object Taxonomy {
  val Tags: Seq[String] = Seq("Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None")

  def known(tag: String): Boolean = Tags.contains(tag)
}
`,
  [scalaPath('metasense', 'Jobs')]: `package metasense

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The job queue (provided): a classification job waits as a JSON document {entity, owner,
 * schema_hash, columns} on the Redis list jobs:queue for the classifier worker; jobs:seen is the set
 * of "{entity}:{schema_hash}" already queued. schemaHash(columns) is the hex SHA-256 of the column
 * names joined by a newline.
 */
object Jobs {
  final case class Job(entity: String, owner: String, schemaHash: String, columns: Seq[String]) {
    def toJson: JsObject =
      JsObject(
        "entity" -> JsString(entity),
        "owner" -> JsString(owner),
        "schema_hash" -> JsString(schemaHash),
        "columns" -> JsArray(columns.map(JsString(_)).toVector)
      )
  }

  val QueueKey = "jobs:queue"
  val SeenKey = "jobs:seen"

  val jedis = new JedisPooled("redis", 6379)

  def schemaHash(columns: Seq[String]): String =
    MessageDigest.getInstance("SHA-256").digest(columns.mkString("\\n").getBytes(UTF_8)).map("%02x".format(_)).mkString

  /** Whether a job for this exact schema of the entity was already queued. */
  def seen(entity: String, digest: String): Boolean = jedis.sismember(SeenKey, s"$entity:$digest")

  def markSeen(entity: String, digest: String): Unit = jedis.sadd(SeenKey, s"$entity:$digest")

  /** Append one job for the classifier worker. */
  def enqueue(job: Job): Unit = jedis.rpush(QueueKey, job.toJson.compactPrint)
}
`,
  [scalaPath('metasense', 'Store')]: `package metasense

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The verification store (provided). verify:{entity} is the verification step 3 opens (a hash:
 * owner, schema_hash, state) and classify:{entity}:{schema_hash} the tags it cached (a JSON object
 * column → tag); entity:{entity} holds the verified classification (tier, tags as JSON, verified_by,
 * version), audit:{entity} one JSON entry {user, action, at} per verification, and outbox the JSON
 * rows {topic, key, payload} a relay republishes when the broker refused them. catalog:{entity} is
 * the metadata store's copy of the published classification (tier, tags as JSON, version), what
 * access control reads.
 */
object Store {
  final case class Verification(owner: String, schemaHash: String, tags: Map[String, String])

  val jedis = new JedisPooled("redis", 6379)

  private def tagsOf(raw: String): Map[String, String] =
    raw.parseJson.asJsObject.fields.collect { case (column, JsString(tag)) => column -> tag }

  /** The open verification, or None when nothing waits for the owner. */
  def pending(entity: String): Option[Verification] = {
    val row = jedis.hgetAll(s"verify:$entity").asScala.toMap
    if (row.isEmpty) None
    else {
      val schemaHash = row.getOrElse("schema_hash", "")
      val tags = Option(jedis.get(s"classify:$entity:$schemaHash")).map(tagsOf).getOrElse(Map.empty)
      Some(Verification(row.getOrElse("owner", ""), schemaHash, tags))
    }
  }

  /** Store the verified classification and close the verification; returns the new version. */
  def recordVerification(entity: String, tags: Map[String, String], tier: Int, verifiedBy: String): Long = {
    val version = jedis.hincrBy(s"entity:$entity", "version", 1)
    val json = JsObject(tags.toSeq.sortBy(_._1).map { case (c, t) => c -> JsString(t) }: _*).compactPrint
    jedis.hset(s"entity:$entity", Map("tier" -> tier.toString, "tags" -> json, "verified_by" -> verifiedBy).asJava)
    jedis.hset(s"verify:$entity", "state", "verified")
    version
  }

  def audit(entity: String, user: String, action: String): Unit =
    jedis.rpush(
      s"audit:$entity",
      JsObject("user" -> JsString(user), "action" -> JsString(action), "at" -> JsNumber(System.currentTimeMillis / 1000)).compactPrint
    )

  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** The version of the entity's classification the metadata store holds; 0 before the first. */
  def catalogVersion(entity: String): Long = Option(jedis.hget(s"catalog:$entity", "version")).map(_.toLong).getOrElse(0L)

  def upsertCatalog(entity: String, tier: Int, tags: Map[String, String], version: Long): Unit = {
    val json = JsObject(tags.toSeq.sortBy(_._1).map { case (c, t) => c -> JsString(t) }: _*).compactPrint
    jedis.hset(s"catalog:$entity", Map("tier" -> tier.toString, "tags" -> json, "version" -> version.toString).asJava)
  }
}
`,
};
