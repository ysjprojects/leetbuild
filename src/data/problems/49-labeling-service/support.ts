/**
 * Hand-written support modules the labeling-service steps import but no step builds: the `labeling`
 * package's task store. Redis holds every record labeld keeps: the task hash, its items, the pool
 * step 2 claims from, the content hashes step 1 deduplicates against, the recorded answer of a
 * create, the submitted labels step 4 writes and step 5 reads, the outbox and the annotators
 * quality review flagged. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'labeling/__init__.py': '',
  'labeling/store.py': `"""
The task store (provided). task:{id} is a task's hash (task_id, tenant, spec_version, overlap,
total_items); items:{id} maps its item ids (i-1, i-2, ...) to their text; pool:{id} is the sorted set
of items waiting for an annotator (score: queue order), the pool step 2 claims from.
spec:{version}:hashes holds the content hashes queued under a spec version, task:create:{tenant}:{key}
the recorded answer of a create. labels:{id} lists the submitted labels as JSON, oldest first; outbox
lists the events the broker did not take; flagged:{id} is the set of annotators quality review
excluded from a task.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def get_task(task_id: str) -> dict | None:
    """The task (task_id, tenant, spec_version, overlap, total_items), or None."""
    raw = r.hgetall(f"task:{task_id}")
    if not raw:
        return None
    return {
        "task_id": raw["task_id"],
        "tenant": raw["tenant"],
        "spec_version": raw["spec_version"],
        "overlap": int(raw["overlap"]),
        "total_items": int(raw["total_items"]),
    }


def create_task(tenant: str, spec_version: str, overlap: int, items: list[str]) -> dict:
    """A new task over items (ids i-1, i-2, ... in order), every item queued in the pool; returns the task."""
    task_id = f"t-{r.incr('task:seq')}"
    r.hset(
        f"task:{task_id}",
        mapping={"task_id": task_id, "tenant": tenant, "spec_version": spec_version, "overlap": overlap, "total_items": len(items)},
    )
    for n, text in enumerate(items, start=1):
        r.hset(f"items:{task_id}", f"i-{n}", text)
        r.zadd(f"pool:{task_id}", {f"i-{n}": n})
    return get_task(task_id)


def seen_hashes(spec_version: str) -> set[str]:
    """The content hashes already queued under spec_version."""
    return set(r.smembers(f"spec:{spec_version}:hashes"))


def add_hashes(spec_version: str, hashes: list[str]) -> None:
    """Register content hashes as queued under spec_version."""
    if hashes:
        r.sadd(f"spec:{spec_version}:hashes", *hashes)


def create_result(tenant: str, key: str) -> dict | None:
    """The answer recorded for the create (tenant, Idempotency-Key), if any."""
    raw = r.get(f"task:create:{tenant}:{key}")
    return json.loads(raw) if raw else None


def record_create(tenant: str, key: str, result: dict) -> None:
    """Record what the create (tenant, Idempotency-Key) answered, for its replays."""
    r.set(f"task:create:{tenant}:{key}", json.dumps(result))


def save_label(label: dict) -> None:
    """Persist a submitted label (label_id, task_id, item_id, annotator, spec_version, value)."""
    r.rpush(f"labels:{label['task_id']}", json.dumps(label))


def labels_of(task_id: str) -> list[dict]:
    """The task's submitted labels, oldest first."""
    return [json.loads(raw) for raw in r.lrange(f"labels:{task_id}", 0, -1)]


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take; the relay produces it later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def flagged(task_id: str) -> set[str]:
    """The annotators quality review excluded from the task."""
    return set(r.smembers(f"flagged:{task_id}"))
`,
};

export const supportModulesTs: Record<string, string> = {
  'labeling/store.ts': `/**
 * The task store (provided). task:{id} is a task's hash (task_id, tenant, spec_version, overlap,
 * total_items); items:{id} maps its item ids (i-1, i-2, ...) to their text; pool:{id} is the sorted
 * set of items waiting for an annotator (score: queue order), the pool step 2 claims from.
 * spec:{version}:hashes holds the content hashes queued under a spec version,
 * task:create:{tenant}:{key} the recorded answer of a create. labels:{id} lists the submitted labels
 * as JSON, oldest first; outbox lists the events the broker did not take; flagged:{id} is the set of
 * annotators quality review excluded from a task.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Task {
  task_id: string;
  tenant: string;
  spec_version: string;
  overlap: number;
  total_items: number;
}

export interface Label {
  label_id: string;
  task_id: string;
  item_id: string;
  annotator: string;
  spec_version: string;
  value: string;
}

/** The task, or null. */
export async function getTask(taskId: string): Promise<Task | null> {
  const raw = await redis.hgetall(\`task:\${taskId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    task_id: raw.task_id,
    tenant: raw.tenant,
    spec_version: raw.spec_version,
    overlap: Number(raw.overlap),
    total_items: Number(raw.total_items),
  };
}

/** A new task over items (ids i-1, i-2, ... in order), every item queued in the pool; returns the task. */
export async function createTask(tenant: string, specVersion: string, overlap: number, items: string[]): Promise<Task> {
  const taskId = \`t-\${await redis.incr('task:seq')}\`;
  await redis.hset(\`task:\${taskId}\`, {
    task_id: taskId,
    tenant,
    spec_version: specVersion,
    overlap: String(overlap),
    total_items: String(items.length),
  });
  for (const [n, text] of items.entries()) {
    await redis.hset(\`items:\${taskId}\`, \`i-\${n + 1}\`, text);
    await redis.zadd(\`pool:\${taskId}\`, n + 1, \`i-\${n + 1}\`);
  }
  return (await getTask(taskId)) as Task;
}

/** The content hashes already queued under specVersion. */
export async function seenHashes(specVersion: string): Promise<Set<string>> {
  return new Set(await redis.smembers(\`spec:\${specVersion}:hashes\`));
}

/** Register content hashes as queued under specVersion. */
export async function addHashes(specVersion: string, hashes: string[]): Promise<void> {
  if (hashes.length > 0) await redis.sadd(\`spec:\${specVersion}:hashes\`, ...hashes);
}

/** The answer recorded for the create (tenant, Idempotency-Key), if any. */
export async function createResult(tenant: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`task:create:\${tenant}:\${key}\`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** Record what the create (tenant, Idempotency-Key) answered, for its replays. */
export async function recordCreate(tenant: string, key: string, result: Record<string, unknown>): Promise<void> {
  await redis.set(\`task:create:\${tenant}:\${key}\`, JSON.stringify(result));
}

/** Persist a submitted label. */
export async function saveLabel(label: Label): Promise<void> {
  await redis.rpush(\`labels:\${label.task_id}\`, JSON.stringify(label));
}

/** The task's submitted labels, oldest first. */
export async function labelsOf(taskId: string): Promise<Label[]> {
  return (await redis.lrange(\`labels:\${taskId}\`, 0, -1)).map(raw => JSON.parse(raw) as Label);
}

/** Keep an event the broker did not take; the relay produces it later. */
export async function insertOutbox(topic: string, key: string, payload: unknown): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

/** The annotators quality review excluded from the task. */
export async function flagged(taskId: string): Promise<Set<string>> {
  return new Set(await redis.smembers(\`flagged:\${taskId}\`));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'labeling/store/store.go': `// Package store is the task store (provided). task:{id} is a task's hash (task_id, tenant,
// spec_version, overlap, total_items); items:{id} maps its item ids (i-1, i-2, ...) to their text;
// pool:{id} is the sorted set of items waiting for an annotator (score: queue order), the pool step 2
// claims from. spec:{version}:hashes holds the content hashes queued under a spec version,
// task:create:{tenant}:{key} the recorded answer of a create. labels:{id} lists the submitted labels
// as JSON, oldest first; outbox lists the events the broker did not take; flagged:{id} is the set of
// annotators quality review excluded from a task.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Task is a labeling task.
type Task struct {
	TaskID      string \`json:"task_id"\`
	Tenant      string \`json:"tenant"\`
	SpecVersion string \`json:"spec_version"\`
	Overlap     int    \`json:"overlap"\`
	TotalItems  int    \`json:"total_items"\`
}

// Label is one annotator's answer for one item.
type Label struct {
	LabelID     string \`json:"label_id"\`
	TaskID      string \`json:"task_id"\`
	ItemID      string \`json:"item_id"\`
	Annotator   string \`json:"annotator"\`
	SpecVersion string \`json:"spec_version"\`
	Value       string \`json:"value"\`
}

// GetTask is the task, or nil.
func GetTask(ctx context.Context, taskID string) *Task {
	raw := rdb.HGetAll(ctx, "task:"+taskID).Val()
	if len(raw) == 0 {
		return nil
	}
	overlap, _ := strconv.Atoi(raw["overlap"])
	total, _ := strconv.Atoi(raw["total_items"])
	return &Task{TaskID: raw["task_id"], Tenant: raw["tenant"], SpecVersion: raw["spec_version"], Overlap: overlap, TotalItems: total}
}

// CreateTask makes a new task over items (ids i-1, i-2, ... in order), every item queued in the pool.
func CreateTask(ctx context.Context, tenant, specVersion string, overlap int, items []string) *Task {
	taskID := fmt.Sprintf("t-%d", rdb.Incr(ctx, "task:seq").Val())
	rdb.HSet(ctx, "task:"+taskID, map[string]any{"task_id": taskID, "tenant": tenant, "spec_version": specVersion, "overlap": strconv.Itoa(overlap), "total_items": strconv.Itoa(len(items))})
	for n, text := range items {
		itemID := fmt.Sprintf("i-%d", n+1)
		rdb.HSet(ctx, "items:"+taskID, itemID, text)
		rdb.ZAdd(ctx, "pool:"+taskID, redis.Z{Score: float64(n + 1), Member: itemID})
	}
	return GetTask(ctx, taskID)
}

// SeenHashes are the content hashes already queued under specVersion.
func SeenHashes(ctx context.Context, specVersion string) map[string]bool {
	seen := map[string]bool{}
	for _, h := range rdb.SMembers(ctx, "spec:"+specVersion+":hashes").Val() {
		seen[h] = true
	}
	return seen
}

// AddHashes registers content hashes as queued under specVersion.
func AddHashes(ctx context.Context, specVersion string, hashes []string) {
	members := make([]any, 0, len(hashes))
	for _, h := range hashes {
		members = append(members, h)
	}
	if len(members) > 0 {
		rdb.SAdd(ctx, "spec:"+specVersion+":hashes", members...)
	}
}

// CreateResult is the answer recorded for the create (tenant, Idempotency-Key), or nil.
func CreateResult(ctx context.Context, tenant, key string) map[string]any {
	raw, err := rdb.Get(ctx, "task:create:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	var result map[string]any
	json.Unmarshal([]byte(raw), &result)
	return result
}

// RecordCreate records what the create (tenant, Idempotency-Key) answered, for its replays.
func RecordCreate(ctx context.Context, tenant, key string, result map[string]any) {
	raw, _ := json.Marshal(result)
	rdb.Set(ctx, "task:create:"+tenant+":"+key, raw, 0)
}

// SaveLabel persists a submitted label.
func SaveLabel(ctx context.Context, label Label) error {
	raw, _ := json.Marshal(label)
	return rdb.RPush(ctx, "labels:"+label.TaskID, raw).Err()
}

// LabelsOf are the task's submitted labels, oldest first.
func LabelsOf(ctx context.Context, taskID string) []Label {
	var out []Label
	for _, raw := range rdb.LRange(ctx, "labels:"+taskID, 0, -1).Val() {
		var label Label
		if json.Unmarshal([]byte(raw), &label) == nil {
			out = append(out, label)
		}
	}
	return out
}

// InsertOutbox keeps an event the broker did not take; the relay produces it later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", raw).Err()
}

// Flagged are the annotators quality review excluded from the task.
func Flagged(ctx context.Context, taskID string) map[string]bool {
	out := map[string]bool{}
	for _, a := range rdb.SMembers(ctx, "flagged:"+taskID).Val() {
		out[a] = true
	}
	return out
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'labeling/store.h': `// The task store (provided). task:{id} is a task's hash (task_id, tenant, spec_version, overlap,
// total_items); items:{id} maps its item ids (i-1, i-2, ...) to their text; pool:{id} is the sorted
// set of items waiting for an annotator (score: queue order), the pool step 2 claims from.
// spec:{version}:hashes holds the content hashes queued under a spec version,
// task:create:{tenant}:{key} the recorded answer of a create. labels:{id} lists the submitted labels
// as JSON, oldest first; outbox lists the events the broker did not take; flagged:{id} is the set of
// annotators quality review excluded from a task.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

struct Task {
  std::string task_id;
  std::string tenant;
  std::string spec_version;
  long overlap = 0;
  long total_items = 0;
};

// One annotator's answer for one item.
struct Label {
  std::string label_id;
  std::string task_id;
  std::string item_id;
  std::string annotator;
  std::string spec_version;
  std::string value;
};

inline nlohmann::json toJson(const Label& l) {
  return nlohmann::json{{"label_id", l.label_id},   {"task_id", l.task_id},           {"item_id", l.item_id},
                        {"annotator", l.annotator}, {"spec_version", l.spec_version}, {"value", l.value}};
}

inline Label labelFrom(const nlohmann::json& j) {
  return Label{j.value("label_id", ""),  j.value("task_id", ""),      j.value("item_id", ""),
               j.value("annotator", ""), j.value("spec_version", ""), j.value("value", "")};
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The task, or none.
inline std::optional<Task> getTask(const std::string& task_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("task:" + task_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Task{text("task_id"), text("tenant"), text("spec_version"), std::stol(text("overlap")), std::stol(text("total_items"))};
}

// A new task over items (ids i-1, i-2, ... in order), every item queued in the pool; returns the task.
inline Task createTask(const std::string& tenant, const std::string& spec_version, long overlap, const std::vector<std::string>& items) {
  const std::string task_id = "t-" + std::to_string(redis().incr("task:seq"));
  redis().hset("task:" + task_id, {{"task_id", task_id},
                                   {"tenant", tenant},
                                   {"spec_version", spec_version},
                                   {"overlap", std::to_string(overlap)},
                                   {"total_items", std::to_string(items.size())}});
  for (size_t n = 0; n < items.size(); n++) {
    const std::string item_id = "i-" + std::to_string(n + 1);
    redis().hset("items:" + task_id, item_id, items[n]);
    redis().zadd("pool:" + task_id, item_id, static_cast<double>(n + 1));
  }
  return *getTask(task_id);
}

// The content hashes already queued under spec_version.
inline std::set<std::string> seenHashes(const std::string& spec_version) {
  const std::vector<std::string> members = redis().smembers("spec:" + spec_version + ":hashes");
  return std::set<std::string>(members.begin(), members.end());
}

// Register content hashes as queued under spec_version.
inline void addHashes(const std::string& spec_version, const std::vector<std::string>& hashes) {
  if (!hashes.empty()) redis().sadd("spec:" + spec_version + ":hashes", hashes.begin(), hashes.end());
}

// The answer recorded for the create (tenant, Idempotency-Key), if any.
inline std::optional<nlohmann::json> createResult(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("task:create:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the create (tenant, Idempotency-Key) answered, for its replays.
inline void recordCreate(const std::string& tenant, const std::string& key, const nlohmann::json& result) {
  redis().set("task:create:" + tenant + ":" + key, result.dump());
}

// Persist a submitted label.
inline void saveLabel(const Label& label) { redis().rpush("labels:" + label.task_id, toJson(label).dump()); }

// The task's submitted labels, oldest first.
inline std::vector<Label> labelsOf(const std::string& task_id) {
  std::vector<Label> out;
  for (const std::string& raw : redis().lrange("labels:" + task_id, 0, -1)) out.push_back(labelFrom(nlohmann::json::parse(raw)));
  return out;
}

// Keep an event the broker did not take; the relay produces it later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The annotators quality review excluded from the task.
inline std::set<std::string> flagged(const std::string& task_id) {
  const std::vector<std::string> members = redis().smembers("flagged:" + task_id);
  return std::set<std::string>(members.begin(), members.end());
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('labeling', 'Store')]: `package labeling

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The task store (provided). task:{id} is a task's hash (task_id, tenant, spec_version, overlap,
 * total_items); items:{id} maps its item ids (i-1, i-2, ...) to their text; pool:{id} is the sorted
 * set of items waiting for an annotator (score: queue order), the pool step 2 claims from.
 * spec:{version}:hashes holds the content hashes queued under a spec version,
 * task:create:{tenant}:{key} the recorded answer of a create. labels:{id} lists the submitted labels
 * as JSON, oldest first; outbox lists the events the broker did not take; flagged:{id} is the set of
 * annotators quality review excluded from a task.
 */
object Store {
  final case class Task(taskId: String, tenant: String, specVersion: String, overlap: Int, totalItems: Int)

  /** One annotator's answer for one item. */
  final case class Label(labelId: String, taskId: String, itemId: String, annotator: String, specVersion: String, value: String) {
    def toJson: JsObject = JsObject(
      "label_id" -> JsString(labelId),
      "task_id" -> JsString(taskId),
      "item_id" -> JsString(itemId),
      "annotator" -> JsString(annotator),
      "spec_version" -> JsString(specVersion),
      "value" -> JsString(value)
    )
  }

  val jedis = new JedisPooled("redis", 6379)

  private def labelFrom(raw: String): Label = {
    val f = raw.parseJson.asJsObject.fields
    def text(name: String): String = f.get(name).collect { case JsString(s) => s }.getOrElse("")
    Label(text("label_id"), text("task_id"), text("item_id"), text("annotator"), text("spec_version"), text("value"))
  }

  /** The task, if it exists. */
  def getTask(taskId: String): Option[Task] = {
    val raw = jedis.hgetAll(s"task:$taskId").asScala.toMap
    if (raw.isEmpty) None
    else Some(Task(raw("task_id"), raw("tenant"), raw("spec_version"), raw("overlap").toInt, raw("total_items").toInt))
  }

  /** A new task over items (ids i-1, i-2, ... in order), every item queued in the pool; returns the task. */
  def createTask(tenant: String, specVersion: String, overlap: Int, items: Seq[String]): Task = {
    val taskId = s"t-\${jedis.incr("task:seq")}"
    jedis.hset(
      s"task:$taskId",
      Map("task_id" -> taskId, "tenant" -> tenant, "spec_version" -> specVersion, "overlap" -> overlap.toString, "total_items" -> items.size.toString).asJava
    )
    items.zipWithIndex.foreach { case (text, n) =>
      jedis.hset(s"items:$taskId", s"i-\${n + 1}", text)
      jedis.zadd(s"pool:$taskId", (n + 1).toDouble, s"i-\${n + 1}")
    }
    getTask(taskId).get
  }

  /** The content hashes already queued under specVersion. */
  def seenHashes(specVersion: String): Set[String] = jedis.smembers(s"spec:$specVersion:hashes").asScala.toSet

  /** Register content hashes as queued under specVersion. */
  def addHashes(specVersion: String, hashes: Seq[String]): Unit =
    if (hashes.nonEmpty) jedis.sadd(s"spec:$specVersion:hashes", hashes: _*)

  /** The answer recorded for the create (tenant, Idempotency-Key), if any. */
  def createResult(tenant: String, key: String): Option[JsObject] =
    Option(jedis.get(s"task:create:$tenant:$key")).map(_.parseJson.asJsObject)

  /** Record what the create (tenant, Idempotency-Key) answered, for its replays. */
  def recordCreate(tenant: String, key: String, result: JsObject): Unit =
    jedis.set(s"task:create:$tenant:$key", result.compactPrint)

  /** Persist a submitted label. */
  def saveLabel(label: Label): Unit = jedis.rpush(s"labels:\${label.taskId}", label.toJson.compactPrint)

  /** The task's submitted labels, oldest first. */
  def labelsOf(taskId: String): Seq[Label] = jedis.lrange(s"labels:$taskId", 0, -1).asScala.toSeq.map(labelFrom)

  /** Keep an event the broker did not take; the relay produces it later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** The annotators quality review excluded from the task. */
  def flagged(taskId: String): Set[String] = jedis.smembers(s"flagged:$taskId").asScala.toSet
}
`,
};
