/**
 * Hand-written support modules the human-review-queue steps import but no step builds: the review
 * store (`review.store`). Every escalation is an item, a Redis hash the course's stand-in for the
 * queue's database; the store creates items, claims sources, records outcomes and decisions, hands
 * out reviewer pseudonyms and parks the events Kafka did not acknowledge. The five languages keep
 * the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'review/__init__.py': '',
  'review/store.py': `"""
The review store (provided). An item is a Redis hash review:item:{id} with item_id, tenant,
source_type, source_id, priority, payload_ref, state (queued, assigned, resolved, escalated or
decided), enqueued_at and sla_deadline (epoch seconds; the SLA clock starts at the enqueue),
breached ("1" once the item went past its SLA) and what later steps write (reviewer, outcome,
grant_id, reason, decision). Items are dicts of strings.

review:queue:{tenant}:{priority}   list of queued item ids, the next one first
review:lease:{id}                  the reviewer holding an assigned item
review:assigned:{tenant}           set of the tenant's assigned item ids
review:source:{tenant}:{type}:{id} the item a source was enqueued as
review:enqueued:{tenant}           enqueues per priority since the tenant started (billing)
review:outbox                      events Kafka did not acknowledge, as JSON, for the relay
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SLA_SECONDS = {"p1": 300, "p2": 1800, "p3": 14400}


def item_key(item_id: str) -> str:
    return f"review:item:{item_id}"


def queue_key(tenant: str, priority: str) -> str:
    return f"review:queue:{tenant}:{priority}"


def lease_key(item_id: str) -> str:
    return f"review:lease:{item_id}"


def assigned_key(tenant: str) -> str:
    return f"review:assigned:{tenant}"


def new_item_id() -> str:
    """A fresh item id."""
    return f"r-{r.incr('review:seq')}"


def claim_source(tenant: str, source_type: str, source_id: str, item_id: str) -> str | None:
    """Claim the source (tenant, source_type, source_id) for item_id in one SET NX: None when the claim is new, else the item already enqueued for it."""
    key = f"review:source:{tenant}:{source_type}:{source_id}"
    if r.set(key, item_id, nx=True):
        return None
    return r.get(key)


def create_item(item: dict) -> dict:
    """Store a new item (item_id, tenant, priority and whatever else it carries) as queued, start its SLA clock now and append it to its priority's queue."""
    now = int(time.time())
    fields = {name: str(value) for name, value in item.items()}
    sla = SLA_SECONDS.get(fields["priority"], SLA_SECONDS["p3"])
    fields.update(state="queued", enqueued_at=str(now), sla_deadline=str(now + sla), breached="0")
    r.hset(item_key(fields["item_id"]), mapping=fields)
    r.rpush(queue_key(fields["tenant"], fields["priority"]), fields["item_id"])
    r.hincrby(f"review:enqueued:{fields['tenant']}", fields["priority"], 1)
    return get_item(fields["item_id"])


def get_item(item_id: str) -> dict | None:
    """The item, or None."""
    return r.hgetall(item_key(item_id)) or None


def queued(tenant: str, priority: str) -> list[dict]:
    """The items in the tenant's queue for priority, in queue order."""
    items = (get_item(item_id) for item_id in r.lrange(queue_key(tenant, priority), 0, -1))
    return [item for item in items if item is not None]


def enqueued_total(tenant: str, priority: str) -> int:
    """How many items the tenant ever enqueued at priority (the billing counter)."""
    return int(r.hget(f"review:enqueued:{tenant}", priority) or 0)


def _release(item_id: str) -> None:
    tenant = r.hget(item_key(item_id), "tenant")
    if tenant is not None:
        r.srem(assigned_key(tenant), item_id)
    r.delete(lease_key(item_id))


def resolve(item_id: str, outcome: str, grant_id: str) -> None:
    """Close the item with outcome and the enforcement grant that allowed it."""
    r.hset(item_key(item_id), mapping={"state": "resolved", "outcome": outcome, "grant_id": grant_id})
    _release(item_id)


def escalate(item_id: str, reason: str) -> None:
    """Hand the item to a person, saying why."""
    r.hset(item_key(item_id), mapping={"state": "escalated", "reason": reason})


def decide(item_id: str, reviewer: str, decision: str) -> dict | None:
    """Record a reviewer's decision once (HSETNX): the item, or None when it does not exist or was already decided."""
    if not r.exists(item_key(item_id)):
        return None
    if not r.hsetnx(item_key(item_id), "decision", decision):
        return None
    r.hset(item_key(item_id), mapping={"state": "decided", "reviewer": reviewer})
    _release(item_id)
    return get_item(item_id)


def reviewer_ref(reviewer: str) -> str:
    """The reviewer's stable pseudonym (rv-{n}), from the pseudonym table only the review store reads."""
    key = f"review:reviewer:{reviewer}"
    ref = r.get(key)
    if ref is None:
        r.set(key, f"rv-{r.incr('review:reviewer:seq')}", nx=True)
        ref = r.get(key)
    return ref


def park_event(event: dict) -> None:
    """Keep an event Kafka did not acknowledge for the relay, which produces it again."""
    r.rpush("review:outbox", json.dumps(event, sort_keys=True))
`,
};

export const supportModulesTs: Record<string, string> = {
  'review/store.ts': `/**
 * The review store (provided). An item is a Redis hash review:item:{id} with item_id, tenant,
 * source_type, source_id, priority, payload_ref, state (queued, assigned, resolved, escalated or
 * decided), enqueued_at and sla_deadline (epoch seconds; the SLA clock starts at the enqueue),
 * breached ("1" once the item went past its SLA) and what later steps write (reviewer, outcome,
 * grant_id, reason, decision). Items are records of strings.
 *
 * review:queue:{tenant}:{priority}   list of queued item ids, the next one first
 * review:lease:{id}                  the reviewer holding an assigned item
 * review:assigned:{tenant}           set of the tenant's assigned item ids
 * review:source:{tenant}:{type}:{id} the item a source was enqueued as
 * review:enqueued:{tenant}           enqueues per priority since the tenant started (billing)
 * review:outbox                      events Kafka did not acknowledge, as JSON, for the relay
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export type Item = Record<string, string>;

export const SLA_SECONDS: Record<string, number> = {p1: 300, p2: 1800, p3: 14400};

export const itemKey = (itemId: string): string => \`review:item:\${itemId}\`;
export const queueKey = (tenant: string, priority: string): string => \`review:queue:\${tenant}:\${priority}\`;
export const leaseKey = (itemId: string): string => \`review:lease:\${itemId}\`;
export const assignedKey = (tenant: string): string => \`review:assigned:\${tenant}\`;

/** A fresh item id. */
export async function newItemId(): Promise<string> {
  return \`r-\${await redis.incr('review:seq')}\`;
}

/** Claim the source (tenant, sourceType, sourceId) for itemId in one SET NX: null when the claim is new, else the item already enqueued for it. */
export async function claimSource(tenant: string, sourceType: string, sourceId: string, itemId: string): Promise<string | null> {
  const key = \`review:source:\${tenant}:\${sourceType}:\${sourceId}\`;
  if ((await redis.set(key, itemId, 'NX')) === 'OK') return null;
  return redis.get(key);
}

/** The item, or null. */
export async function getItem(itemId: string): Promise<Item | null> {
  const raw = await redis.hgetall(itemKey(itemId));
  return Object.keys(raw).length === 0 ? null : raw;
}

/** Store a new item (item_id, tenant, priority and whatever else it carries) as queued, start its SLA clock now and append it to its priority's queue. */
export async function createItem(item: Record<string, unknown>): Promise<Item> {
  const now = Math.floor(Date.now() / 1000);
  const fields: Item = Object.fromEntries(Object.entries(item).map(([name, value]) => [name, String(value)]));
  const sla = SLA_SECONDS[fields.priority] ?? SLA_SECONDS.p3;
  Object.assign(fields, {state: 'queued', enqueued_at: String(now), sla_deadline: String(now + sla), breached: '0'});
  await redis.hset(itemKey(fields.item_id), fields);
  await redis.rpush(queueKey(fields.tenant, fields.priority), fields.item_id);
  await redis.hincrby(\`review:enqueued:\${fields.tenant}\`, fields.priority, 1);
  return (await getItem(fields.item_id)) as Item;
}

/** The items in the tenant's queue for priority, in queue order. */
export async function queued(tenant: string, priority: string): Promise<Item[]> {
  const items: Item[] = [];
  for (const itemId of await redis.lrange(queueKey(tenant, priority), 0, -1)) {
    const item = await getItem(itemId);
    if (item !== null) items.push(item);
  }
  return items;
}

/** How many items the tenant ever enqueued at priority (the billing counter). */
export async function enqueuedTotal(tenant: string, priority: string): Promise<number> {
  return Number((await redis.hget(\`review:enqueued:\${tenant}\`, priority)) ?? 0);
}

async function release(itemId: string): Promise<void> {
  const tenant = await redis.hget(itemKey(itemId), 'tenant');
  if (tenant !== null) await redis.srem(assignedKey(tenant), itemId);
  await redis.del(leaseKey(itemId));
}

/** Close the item with outcome and the enforcement grant that allowed it. */
export async function resolve(itemId: string, outcome: string, grantId: string): Promise<void> {
  await redis.hset(itemKey(itemId), {state: 'resolved', outcome, grant_id: grantId});
  await release(itemId);
}

/** Hand the item to a person, saying why. */
export async function escalate(itemId: string, reason: string): Promise<void> {
  await redis.hset(itemKey(itemId), {state: 'escalated', reason});
}

/** Record a reviewer's decision once (HSETNX): the item, or null when it does not exist or was already decided. */
export async function decide(itemId: string, reviewer: string, decision: string): Promise<Item | null> {
  if ((await redis.exists(itemKey(itemId))) === 0) return null;
  if ((await redis.hsetnx(itemKey(itemId), 'decision', decision)) === 0) return null;
  await redis.hset(itemKey(itemId), {state: 'decided', reviewer});
  await release(itemId);
  return getItem(itemId);
}

/** The reviewer's stable pseudonym (rv-{n}), from the pseudonym table only the review store reads. */
export async function reviewerRef(reviewer: string): Promise<string> {
  const key = \`review:reviewer:\${reviewer}\`;
  const ref = await redis.get(key);
  if (ref !== null) return ref;
  await redis.set(key, \`rv-\${await redis.incr('review:reviewer:seq')}\`, 'NX');
  return (await redis.get(key)) as string;
}

/** Keep an event Kafka did not acknowledge for the relay, which produces it again. */
export async function parkEvent(event: Record<string, string>): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(event).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await redis.rpush('review:outbox', JSON.stringify(sorted));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'review/store/store.go': `// Package store is the review store (provided). An item is a Redis hash review:item:{id} with
// item_id, tenant, source_type, source_id, priority, payload_ref, state (queued, assigned,
// resolved, escalated or decided), enqueued_at and sla_deadline (epoch seconds; the SLA clock
// starts at the enqueue), breached ("1" once the item went past its SLA) and what later steps write
// (reviewer, outcome, grant_id, reason, decision). Items are maps of strings; nil when absent.
//
//	review:queue:{tenant}:{priority}   list of queued item ids, the next one first
//	review:lease:{id}                  the reviewer holding an assigned item
//	review:assigned:{tenant}           set of the tenant's assigned item ids
//	review:source:{tenant}:{type}:{id} the item a source was enqueued as
//	review:enqueued:{tenant}           enqueues per priority since the tenant started (billing)
//	review:outbox                      events Kafka did not acknowledge, as JSON, for the relay
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// SLASeconds is each priority's SLA, counted from the enqueue.
var SLASeconds = map[string]int64{"p1": 300, "p2": 1800, "p3": 14400}

// ItemKey is the item's hash.
func ItemKey(itemID string) string { return "review:item:" + itemID }

// QueueKey is the tenant's queue for a priority.
func QueueKey(tenant, priority string) string { return "review:queue:" + tenant + ":" + priority }

// LeaseKey names the reviewer holding an assigned item.
func LeaseKey(itemID string) string { return "review:lease:" + itemID }

// AssignedKey is the set of the tenant's assigned item ids.
func AssignedKey(tenant string) string { return "review:assigned:" + tenant }

// NewItemID is a fresh item id.
func NewItemID(ctx context.Context) string {
	return fmt.Sprintf("r-%d", rdb.Incr(ctx, "review:seq").Val())
}

// ClaimSource claims the source (tenant, sourceType, sourceID) for itemID in one SET NX: "" when
// the claim is new, else the item already enqueued for it.
func ClaimSource(ctx context.Context, tenant, sourceType, sourceID, itemID string) string {
	key := "review:source:" + tenant + ":" + sourceType + ":" + sourceID
	if rdb.SetNX(ctx, key, itemID, 0).Val() {
		return ""
	}
	return rdb.Get(ctx, key).Val()
}

// GetItem is the item, or nil.
func GetItem(ctx context.Context, itemID string) map[string]string {
	raw := rdb.HGetAll(ctx, ItemKey(itemID)).Val()
	if len(raw) == 0 {
		return nil
	}
	return raw
}

// CreateItem stores a new item (item_id, tenant, priority and whatever else it carries) as queued,
// starts its SLA clock now and appends it to its priority's queue.
func CreateItem(ctx context.Context, item map[string]string) map[string]string {
	now := time.Now().Unix()
	sla, known := SLASeconds[item["priority"]]
	if !known {
		sla = SLASeconds["p3"]
	}
	fields := map[string]any{}
	for name, value := range item {
		fields[name] = value
	}
	fields["state"] = "queued"
	fields["enqueued_at"] = strconv.FormatInt(now, 10)
	fields["sla_deadline"] = strconv.FormatInt(now+sla, 10)
	fields["breached"] = "0"
	rdb.HSet(ctx, ItemKey(item["item_id"]), fields)
	rdb.RPush(ctx, QueueKey(item["tenant"], item["priority"]), item["item_id"])
	rdb.HIncrBy(ctx, "review:enqueued:"+item["tenant"], item["priority"], 1)
	return GetItem(ctx, item["item_id"])
}

// Queued is the items in the tenant's queue for priority, in queue order.
func Queued(ctx context.Context, tenant, priority string) []map[string]string {
	items := []map[string]string{}
	for _, itemID := range rdb.LRange(ctx, QueueKey(tenant, priority), 0, -1).Val() {
		if item := GetItem(ctx, itemID); item != nil {
			items = append(items, item)
		}
	}
	return items
}

// EnqueuedTotal is how many items the tenant ever enqueued at priority (the billing counter).
func EnqueuedTotal(ctx context.Context, tenant, priority string) int64 {
	n, _ := strconv.ParseInt(rdb.HGet(ctx, "review:enqueued:"+tenant, priority).Val(), 10, 64)
	return n
}

func release(ctx context.Context, itemID string) {
	if tenant := rdb.HGet(ctx, ItemKey(itemID), "tenant").Val(); tenant != "" {
		rdb.SRem(ctx, AssignedKey(tenant), itemID)
	}
	rdb.Del(ctx, LeaseKey(itemID))
}

// Resolve closes the item with outcome and the enforcement grant that allowed it.
func Resolve(ctx context.Context, itemID, outcome, grantID string) {
	rdb.HSet(ctx, ItemKey(itemID), map[string]any{"state": "resolved", "outcome": outcome, "grant_id": grantID})
	release(ctx, itemID)
}

// Escalate hands the item to a person, saying why.
func Escalate(ctx context.Context, itemID, reason string) {
	rdb.HSet(ctx, ItemKey(itemID), map[string]any{"state": "escalated", "reason": reason})
}

// Decide records a reviewer's decision once (HSETNX): the item, or nil when it does not exist or
// was already decided.
func Decide(ctx context.Context, itemID, reviewer, decision string) map[string]string {
	if rdb.Exists(ctx, ItemKey(itemID)).Val() == 0 {
		return nil
	}
	if !rdb.HSetNX(ctx, ItemKey(itemID), "decision", decision).Val() {
		return nil
	}
	rdb.HSet(ctx, ItemKey(itemID), map[string]any{"state": "decided", "reviewer": reviewer})
	release(ctx, itemID)
	return GetItem(ctx, itemID)
}

// ReviewerRef is the reviewer's stable pseudonym (rv-{n}), from the pseudonym table only the
// review store reads.
func ReviewerRef(ctx context.Context, reviewer string) string {
	key := "review:reviewer:" + reviewer
	if ref, err := rdb.Get(ctx, key).Result(); err == nil {
		return ref
	}
	rdb.SetNX(ctx, key, fmt.Sprintf("rv-%d", rdb.Incr(ctx, "review:reviewer:seq").Val()), 0)
	return rdb.Get(ctx, key).Val()
}

// ParkEvent keeps an event Kafka did not acknowledge for the relay, which produces it again.
func ParkEvent(ctx context.Context, event map[string]string) {
	raw, _ := json.Marshal(event)
	rdb.RPush(ctx, "review:outbox", string(raw))
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'review/store.h': `// The review store (provided). An item is a Redis hash review:item:{id} with item_id, tenant,
// source_type, source_id, priority, payload_ref, state (queued, assigned, resolved, escalated or
// decided), enqueued_at and sla_deadline (epoch seconds; the SLA clock starts at the enqueue),
// breached ("1" once the item went past its SLA) and what later steps write (reviewer, outcome,
// grant_id, reason, decision). Items are maps of strings.
//
//   review:queue:{tenant}:{priority}   list of queued item ids, the next one first
//   review:lease:{id}                  the reviewer holding an assigned item
//   review:assigned:{tenant}           set of the tenant's assigned item ids
//   review:source:{tenant}:{type}:{id} the item a source was enqueued as
//   review:enqueued:{tenant}           enqueues per priority since the tenant started (billing)
//   review:outbox                      events Kafka did not acknowledge, as JSON, for the relay
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

using Item = std::map<std::string, std::string>;

inline const std::map<std::string, long long> kSlaSeconds = {{"p1", 300}, {"p2", 1800}, {"p3", 14400}};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string itemKey(const std::string& item_id) { return "review:item:" + item_id; }
inline std::string queueKey(const std::string& tenant, const std::string& priority) { return "review:queue:" + tenant + ":" + priority; }
inline std::string leaseKey(const std::string& item_id) { return "review:lease:" + item_id; }
inline std::string assignedKey(const std::string& tenant) { return "review:assigned:" + tenant; }

inline long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// A fresh item id.
inline std::string newItemId() { return "r-" + std::to_string(redis().incr("review:seq")); }

// Claim the source (tenant, source_type, source_id) for item_id in one SET NX: none when the claim
// is new, else the item already enqueued for it.
inline std::optional<std::string> claimSource(const std::string& tenant, const std::string& source_type, const std::string& source_id,
                                              const std::string& item_id) {
  const std::string key = "review:source:" + tenant + ":" + source_type + ":" + source_id;
  if (redis().set(key, item_id, std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST)) return std::nullopt;
  return redis().get(key);
}

// The item, or none.
inline std::optional<Item> getItem(const std::string& item_id) {
  Item raw;
  redis().hgetall(itemKey(item_id), std::inserter(raw, raw.end()));
  if (raw.empty()) return std::nullopt;
  return raw;
}

// Store a new item (item_id, tenant, priority and whatever else it carries) as queued, start its
// SLA clock now and append it to its priority's queue.
inline Item createItem(Item item) {
  const long long now = nowSeconds();
  const auto sla = kSlaSeconds.count(item["priority"]) ? kSlaSeconds.at(item["priority"]) : kSlaSeconds.at("p3");
  item["state"] = "queued";
  item["enqueued_at"] = std::to_string(now);
  item["sla_deadline"] = std::to_string(now + sla);
  item["breached"] = "0";
  redis().hset(itemKey(item["item_id"]), item.begin(), item.end());
  redis().rpush(queueKey(item["tenant"], item["priority"]), item["item_id"]);
  redis().hincrby("review:enqueued:" + item["tenant"], item["priority"], 1);
  return *getItem(item["item_id"]);
}

// The items in the tenant's queue for priority, in queue order.
inline std::vector<Item> queued(const std::string& tenant, const std::string& priority) {
  std::vector<std::string> ids;
  redis().lrange(queueKey(tenant, priority), 0, -1, std::back_inserter(ids));
  std::vector<Item> items;
  for (const auto& item_id : ids) {
    if (auto item = getItem(item_id)) items.push_back(*item);
  }
  return items;
}

// How many items the tenant ever enqueued at priority (the billing counter).
inline long long enqueuedTotal(const std::string& tenant, const std::string& priority) {
  const auto n = redis().hget("review:enqueued:" + tenant, priority);
  return n ? std::stoll(*n) : 0;
}

inline void releaseItem(const std::string& item_id) {
  if (const auto tenant = redis().hget(itemKey(item_id), "tenant")) redis().srem(assignedKey(*tenant), item_id);
  redis().del(leaseKey(item_id));
}

// Close the item with outcome and the enforcement grant that allowed it.
inline void resolve(const std::string& item_id, const std::string& outcome, const std::string& grant_id) {
  redis().hset(itemKey(item_id), {std::make_pair(std::string("state"), std::string("resolved")), std::make_pair(std::string("outcome"), outcome),
                                  std::make_pair(std::string("grant_id"), grant_id)});
  releaseItem(item_id);
}

// Hand the item to a person, saying why.
inline void escalate(const std::string& item_id, const std::string& reason) {
  redis().hset(itemKey(item_id), {std::make_pair(std::string("state"), std::string("escalated")), std::make_pair(std::string("reason"), reason)});
}

// Record a reviewer's decision once (HSETNX): the item, or none when it does not exist or was
// already decided.
inline std::optional<Item> decide(const std::string& item_id, const std::string& reviewer, const std::string& decision) {
  if (redis().exists(itemKey(item_id)) == 0) return std::nullopt;
  if (!redis().hsetnx(itemKey(item_id), "decision", decision)) return std::nullopt;
  redis().hset(itemKey(item_id), {std::make_pair(std::string("state"), std::string("decided")), std::make_pair(std::string("reviewer"), reviewer)});
  releaseItem(item_id);
  return getItem(item_id);
}

// The reviewer's stable pseudonym (rv-{n}), from the pseudonym table only the review store reads.
inline std::string reviewerRef(const std::string& reviewer) {
  const std::string key = "review:reviewer:" + reviewer;
  if (const auto ref = redis().get(key)) return *ref;
  redis().set(key, "rv-" + std::to_string(redis().incr("review:reviewer:seq")), std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST);
  return redis().get(key).value_or("");
}

// Keep an event Kafka did not acknowledge for the relay, which produces it again.
inline void parkEvent(const nlohmann::json& event) { redis().rpush("review:outbox", event.dump()); }

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('review', 'Store')]: `package review

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The review store (provided). An item is a Redis hash review:item:{id} with item_id, tenant,
 * source_type, source_id, priority, payload_ref, state (queued, assigned, resolved, escalated or
 * decided), enqueued_at and sla_deadline (epoch seconds; the SLA clock starts at the enqueue),
 * breached ("1" once the item went past its SLA) and what later steps write (reviewer, outcome,
 * grant_id, reason, decision). Items are maps of strings.
 *
 * review:queue:{tenant}:{priority}   list of queued item ids, the next one first
 * review:lease:{id}                  the reviewer holding an assigned item
 * review:assigned:{tenant}           set of the tenant's assigned item ids
 * review:source:{tenant}:{type}:{id} the item a source was enqueued as
 * review:enqueued:{tenant}           enqueues per priority since the tenant started (billing)
 * review:outbox                      events Kafka did not acknowledge, as JSON, for the relay
 */
object Store {
  type Item = Map[String, String]

  val SlaSeconds: Map[String, Long] = Map("p1" -> 300L, "p2" -> 1800L, "p3" -> 14400L)

  val jedis = new JedisPooled("redis", 6379)

  def itemKey(itemId: String): String = s"review:item:$itemId"
  def queueKey(tenant: String, priority: String): String = s"review:queue:$tenant:$priority"
  def leaseKey(itemId: String): String = s"review:lease:$itemId"
  def assignedKey(tenant: String): String = s"review:assigned:$tenant"

  /** A fresh item id. */
  def newItemId(): String = s"r-\${jedis.incr("review:seq")}"

  /** Claim the source (tenant, sourceType, sourceId) for itemId in one SET NX: None when the claim is new, else the item already enqueued for it. */
  def claimSource(tenant: String, sourceType: String, sourceId: String, itemId: String): Option[String] = {
    val key = s"review:source:$tenant:$sourceType:$sourceId"
    if (jedis.set(key, itemId, SetParams.setParams().nx()) == "OK") None else Option(jedis.get(key))
  }

  /** The item, if it exists. */
  def getItem(itemId: String): Option[Item] = {
    val raw = jedis.hgetAll(itemKey(itemId)).asScala.toMap
    if (raw.isEmpty) None else Some(raw)
  }

  /** Store a new item (item_id, tenant, priority and whatever else it carries) as queued, start its SLA clock now and append it to its priority's queue. */
  def createItem(item: Item): Item = {
    val now = java.time.Instant.now.getEpochSecond
    val sla = SlaSeconds.getOrElse(item("priority"), SlaSeconds("p3"))
    val fields = item ++ Map("state" -> "queued", "enqueued_at" -> now.toString, "sla_deadline" -> (now + sla).toString, "breached" -> "0")
    jedis.hset(itemKey(item("item_id")), fields.asJava)
    jedis.rpush(queueKey(item("tenant"), item("priority")), item("item_id"))
    jedis.hincrBy(s"review:enqueued:\${item("tenant")}", item("priority"), 1L)
    getItem(item("item_id")).get
  }

  /** The items in the tenant's queue for priority, in queue order. */
  def queued(tenant: String, priority: String): Seq[Item] =
    jedis.lrange(queueKey(tenant, priority), 0, -1).asScala.toSeq.flatMap(getItem)

  /** How many items the tenant ever enqueued at priority (the billing counter). */
  def enqueuedTotal(tenant: String, priority: String): Long =
    Option(jedis.hget(s"review:enqueued:$tenant", priority)).map(_.toLong).getOrElse(0L)

  private def release(itemId: String): Unit = {
    Option(jedis.hget(itemKey(itemId), "tenant")).foreach(tenant => jedis.srem(assignedKey(tenant), itemId))
    jedis.del(leaseKey(itemId))
  }

  /** Close the item with outcome and the enforcement grant that allowed it. */
  def resolve(itemId: String, outcome: String, grantId: String): Unit = {
    jedis.hset(itemKey(itemId), Map("state" -> "resolved", "outcome" -> outcome, "grant_id" -> grantId).asJava)
    release(itemId)
  }

  /** Hand the item to a person, saying why. */
  def escalate(itemId: String, reason: String): Unit =
    jedis.hset(itemKey(itemId), Map("state" -> "escalated", "reason" -> reason).asJava)

  /** Record a reviewer's decision once (HSETNX): the item, or None when it does not exist or was already decided. */
  def decide(itemId: String, reviewer: String, decision: String): Option[Item] =
    if (!jedis.exists(itemKey(itemId)) || jedis.hsetnx(itemKey(itemId), "decision", decision) == 0L) None
    else {
      jedis.hset(itemKey(itemId), Map("state" -> "decided", "reviewer" -> reviewer).asJava)
      release(itemId)
      getItem(itemId)
    }

  /** The reviewer's stable pseudonym (rv-{n}), from the pseudonym table only the review store reads. */
  def reviewerRef(reviewer: String): String = {
    val key = s"review:reviewer:$reviewer"
    Option(jedis.get(key)).getOrElse {
      jedis.set(key, s"rv-\${jedis.incr("review:reviewer:seq")}", SetParams.setParams().nx())
      jedis.get(key)
    }
  }

  /** Keep an event Kafka did not acknowledge for the relay, which produces it again. */
  def parkEvent(event: JsObject): Unit = jedis.rpush("review:outbox", event.compactPrint)
}
`,
};
