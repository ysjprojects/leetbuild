/**
 * Hand-written support modules the ticket-triage steps import but no step builds: the `triage`
 * package. `triage.rules` is the versioned keyword ruleset (step 1's decision, step 3's fallback);
 * `triage.store` is the routing store in Redis: ticket ids, the answers recorded per
 * Idempotency-Key, the routing records the consumer writes and the summary reads, the queue
 * registry and the outbox. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

const STORE_DOC = `The routing store (provided), in Redis. ticket:seq numbers tickets (t-1, t-2, ...);
idem:{tenant}:{key} holds the routing a POST answered for an Idempotency-Key (kept a day);
routing:{tenant}:{ticket_id} is a routed ticket's record (ticket_id, tenant, queue, priority,
confidence, fallback_reason, received_at in Unix seconds, status open or closed), indexed per queue
in the set routing:{tenant}:queue:{queue}; queue:{queue_id} names a tenant's queue (queue_id,
tenant, name); outbox:triage.decided lists, as JSON, the events the broker refused, for the relay
to republish.`;

const RULES_DOC = `The keyword ruleset (provided), version v3: step 1's decision, and the triage service's when the
classifier cannot give one. The first queue whose keywords occur in the lowercased text wins
(billing, then delivery, then account), else general; a text naming an outage, a breach or data
loss is urgent, any other normal. A rule decision has confidence 0.5 and no fallback_reason ("").`;

const block = (doc: string, lead: string): string =>
  doc
    .split('\n')
    .map(line => `${lead}${line}`)
    .join('\n');

export const supportModules: Record<string, string> = {
  'triage/__init__.py': '',
  'triage/rules.py': `"""
${RULES_DOC}
"""
RULESET_VERSION = "v3"
QUEUES = ("billing", "delivery", "account", "general")
KEYWORDS = (
    ("billing", ("invoice", "refund", "charge", "payment")),
    ("delivery", ("shipment", "delivery", "tracking", "parcel")),
    ("account", ("password", "login", "locked", "sign-in")),
)
URGENT = ("outage", "breach", "data loss")
RULE_CONFIDENCE = 0.5


def rule_decision(text: str) -> dict:
    """The ruleset's decision: queue, priority, confidence, fallback_reason ("": none), ruleset_version."""
    lowered = text.lower()
    queue = next((name for name, words in KEYWORDS if any(word in lowered for word in words)), "general")
    priority = "urgent" if any(word in lowered for word in URGENT) else "normal"
    return {"queue": queue, "priority": priority, "confidence": RULE_CONFIDENCE, "fallback_reason": "", "ruleset_version": RULESET_VERSION}
`,
  'triage/store.py': `"""
${STORE_DOC}
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX = "outbox:triage.decided"
FIELDS = ("ticket_id", "tenant", "queue", "priority", "confidence", "fallback_reason", "received_at")


def new_ticket_id() -> str:
    """A fresh ticket id: t-1, t-2, ..."""
    return f"t-{r.incr('ticket:seq')}"


def decision_for_key(tenant: str, key: str) -> dict | None:
    """The routing a POST answered for (tenant, Idempotency-Key), if any."""
    raw = r.get(f"idem:{tenant}:{key}")
    return json.loads(raw) if raw else None


def save_decision(tenant: str, key: str, routing: dict) -> None:
    """Record what a POST answered for (tenant, Idempotency-Key), for its replays."""
    r.set(f"idem:{tenant}:{key}", json.dumps(routing), ex=86400)


def record_routing(event: dict) -> None:
    """Record a routed ticket (a triage.decided event) in its queue; a redelivery rewrites the same record and leaves its status alone."""
    key = f"routing:{event['tenant']}:{event['ticket_id']}"
    r.hset(key, mapping={name: str(event[name]) for name in FIELDS})
    r.hsetnx(key, "status", "open")
    r.sadd(f"routing:{event['tenant']}:queue:{event['queue']}", event["ticket_id"])


def _record(raw: dict) -> dict:
    return {
        "ticket_id": raw["ticket_id"],
        "tenant": raw["tenant"],
        "queue": raw["queue"],
        "priority": raw["priority"],
        "confidence": float(raw["confidence"]),
        "fallback_reason": raw.get("fallback_reason", ""),
        "received_at": int(float(raw["received_at"])),
        "status": raw.get("status", "open"),
    }


def routing_records(tenant: str, queue: str) -> list[dict]:
    """Every routing record of the tenant's queue, open and closed, oldest first."""
    ids = r.smembers(f"routing:{tenant}:queue:{queue}")
    records = [_record(r.hgetall(f"routing:{tenant}:{ticket_id}")) for ticket_id in ids]
    return sorted(records, key=lambda record: (record["received_at"], record["ticket_id"]))


def close_ticket(tenant: str, ticket_id: str) -> None:
    """An agent resolved the ticket: its record stays, closed."""
    r.hset(f"routing:{tenant}:{ticket_id}", "status", "closed")


def create_queue(tenant: str, name: str) -> str:
    """Register the tenant's queue name; returns its id (q-1, q-2, ...)."""
    queue_id = f"q-{r.incr('queue:seq')}"
    r.hset(f"queue:{queue_id}", mapping={"queue_id": queue_id, "tenant": tenant, "name": name})
    return queue_id


def queue(queue_id: str) -> dict | None:
    """The queue (queue_id, tenant, name), or None for an unknown id."""
    return r.hgetall(f"queue:{queue_id}") or None


def insert_outbox(event: dict) -> None:
    """Keep an event the broker refused, for the relay to republish."""
    r.rpush(OUTBOX, json.dumps(event))
`,
};

export const supportModulesTs: Record<string, string> = {
  'triage/rules.ts': `/**
${block(RULES_DOC, ' * ')}
 */
export const RULESET_VERSION = 'v3';
export const QUEUES = ['billing', 'delivery', 'account', 'general'] as const;
const KEYWORDS: [string, string[]][] = [
  ['billing', ['invoice', 'refund', 'charge', 'payment']],
  ['delivery', ['shipment', 'delivery', 'tracking', 'parcel']],
  ['account', ['password', 'login', 'locked', 'sign-in']],
];
const URGENT = ['outage', 'breach', 'data loss'];
export const RULE_CONFIDENCE = 0.5;

export interface Decision {
  queue: string;
  priority: string;
  confidence: number;
  /** Why the rules decided instead of the classifier; "" when they did not. */
  fallback_reason: string;
  /** The ruleset that decided; "" when the classifier did. */
  ruleset_version: string;
}

/** The ruleset's decision for a ticket. */
export function ruleDecision(text: string): Decision {
  const lowered = text.toLowerCase();
  const match = KEYWORDS.find(([, words]) => words.some(word => lowered.includes(word)));
  const priority = URGENT.some(word => lowered.includes(word)) ? 'urgent' : 'normal';
  return {queue: match ? match[0] : 'general', priority, confidence: RULE_CONFIDENCE, fallback_reason: '', ruleset_version: RULESET_VERSION};
}
`,
  'triage/store.ts': `/**
${block(STORE_DOC, ' * ')}
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX = 'outbox:triage.decided';
const FIELDS = ['ticket_id', 'tenant', 'queue', 'priority', 'confidence', 'fallback_reason', 'received_at'] as const;

/** A routed ticket: a triage.decided event, and (with status) its record. */
export interface Routing {
  ticket_id: string;
  tenant: string;
  queue: string;
  priority: string;
  confidence: number;
  fallback_reason: string;
  received_at: number;
  status?: string;
}

export interface Queue {
  queue_id: string;
  tenant: string;
  name: string;
}

/** A fresh ticket id: t-1, t-2, ... */
export async function newTicketId(): Promise<string> {
  return \`t-\${await redis.incr('ticket:seq')}\`;
}

/** The routing a POST answered for (tenant, Idempotency-Key), if any. */
export async function decisionForKey(tenant: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`idem:\${tenant}:\${key}\`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** Record what a POST answered for (tenant, Idempotency-Key), for its replays. */
export async function saveDecision(tenant: string, key: string, routing: Record<string, unknown>): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, JSON.stringify(routing), 'EX', 86400);
}

/** Record a routed ticket (a triage.decided event) in its queue; a redelivery rewrites the same record and leaves its status alone. */
export async function recordRouting(event: Routing): Promise<void> {
  const key = \`routing:\${event.tenant}:\${event.ticket_id}\`;
  await redis.hset(key, Object.fromEntries(FIELDS.map(name => [name, String(event[name])])));
  await redis.hsetnx(key, 'status', 'open');
  await redis.sadd(\`routing:\${event.tenant}:queue:\${event.queue}\`, event.ticket_id);
}

/** Every routing record of the tenant's queue, open and closed, oldest first. */
export async function routingRecords(tenant: string, queue: string): Promise<Routing[]> {
  const ids = await redis.smembers(\`routing:\${tenant}:queue:\${queue}\`);
  const records: Routing[] = [];
  for (const id of ids) {
    const raw = await redis.hgetall(\`routing:\${tenant}:\${id}\`);
    records.push({
      ticket_id: raw.ticket_id,
      tenant: raw.tenant,
      queue: raw.queue,
      priority: raw.priority,
      confidence: Number(raw.confidence),
      fallback_reason: raw.fallback_reason ?? '',
      received_at: Math.trunc(Number(raw.received_at)),
      status: raw.status ?? 'open',
    });
  }
  return records.sort((a, b) => a.received_at - b.received_at || a.ticket_id.localeCompare(b.ticket_id));
}

/** An agent resolved the ticket: its record stays, closed. */
export async function closeTicket(tenant: string, ticketId: string): Promise<void> {
  await redis.hset(\`routing:\${tenant}:\${ticketId}\`, 'status', 'closed');
}

/** Register the tenant's queue name; returns its id (q-1, q-2, ...). */
export async function createQueue(tenant: string, name: string): Promise<string> {
  const queueId = \`q-\${await redis.incr('queue:seq')}\`;
  await redis.hset(\`queue:\${queueId}\`, {queue_id: queueId, tenant, name});
  return queueId;
}

/** The queue (queue_id, tenant, name), or null for an unknown id. */
export async function queue(queueId: string): Promise<Queue | null> {
  const raw = await redis.hgetall(\`queue:\${queueId}\`);
  return Object.keys(raw).length === 0 ? null : {queue_id: raw.queue_id, tenant: raw.tenant, name: raw.name};
}

/** Keep an event the broker refused, for the relay to republish. */
export async function insertOutbox(event: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX, JSON.stringify(event));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'triage/rules/rules.go': `${block(
    RULES_DOC.replace('The keyword ruleset', 'Package rules is the keyword ruleset'),
    '// ',
  )}
package rules

import "strings"

// RulesetVersion names the ruleset that decided.
const RulesetVersion = "v3"

// RuleConfidence is the confidence of every rule decision.
const RuleConfidence = 0.5

// Queues are the queues a decision can name.
var Queues = []string{"billing", "delivery", "account", "general"}

var keywords = []struct {
	queue string
	words []string
}{
	{"billing", []string{"invoice", "refund", "charge", "payment"}},
	{"delivery", []string{"shipment", "delivery", "tracking", "parcel"}},
	{"account", []string{"password", "login", "locked", "sign-in"}},
}

var urgent = []string{"outage", "breach", "data loss"}

// Decision is where a ticket goes and why. FallbackReason is "" unless the rules stood in for the
// classifier; RulesetVersion is "" when the classifier decided.
type Decision struct {
	Queue          string  \`json:"queue"\`
	Priority       string  \`json:"priority"\`
	Confidence     float64 \`json:"confidence"\`
	FallbackReason string  \`json:"fallback_reason"\`
	RulesetVersion string  \`json:"ruleset_version"\`
}

// RuleDecision is the ruleset's decision for a ticket.
func RuleDecision(text string) Decision {
	lowered := strings.ToLower(text)
	d := Decision{Queue: "general", Priority: "normal", Confidence: RuleConfidence, RulesetVersion: RulesetVersion}
	for _, k := range keywords {
		if containsAny(lowered, k.words) {
			d.Queue = k.queue
			break
		}
	}
	if containsAny(lowered, urgent) {
		d.Priority = "urgent"
	}
	return d
}

func containsAny(text string, words []string) bool {
	for _, w := range words {
		if strings.Contains(text, w) {
			return true
		}
	}
	return false
}
`,
  'triage/store/store.go': `${block(
    STORE_DOC.replace('The routing store', 'Package store is the routing store'),
    '// ',
  )}
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Outbox lists the events the broker refused.
const Outbox = "outbox:triage.decided"

// Routing is a routed ticket: a triage.decided event, and (with Status) its record.
type Routing struct {
	TicketID       string  \`json:"ticket_id"\`
	Tenant         string  \`json:"tenant"\`
	Queue          string  \`json:"queue"\`
	Priority       string  \`json:"priority"\`
	Confidence     float64 \`json:"confidence"\`
	FallbackReason string  \`json:"fallback_reason"\`
	ReceivedAt     int64   \`json:"received_at"\`
	Status         string  \`json:"status,omitempty"\`
}

// QueueInfo names a tenant's queue.
type QueueInfo struct {
	QueueID string
	Tenant  string
	Name    string
}

// NewTicketID is a fresh ticket id: t-1, t-2, ...
func NewTicketID(ctx context.Context) string {
	return fmt.Sprintf("t-%d", rdb.Incr(ctx, "ticket:seq").Val())
}

// DecisionForKey is the routing a POST answered for (tenant, Idempotency-Key), or nil.
func DecisionForKey(ctx context.Context, tenant, key string) map[string]any {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	var routing map[string]any
	if json.Unmarshal([]byte(raw), &routing) != nil {
		return nil
	}
	return routing
}

// SaveDecision records what a POST answered for (tenant, Idempotency-Key), for its replays.
func SaveDecision(ctx context.Context, tenant, key string, routing map[string]any) {
	raw, _ := json.Marshal(routing)
	rdb.Set(ctx, "idem:"+tenant+":"+key, raw, 24*time.Hour)
}

// RecordRouting records a routed ticket (a triage.decided event) in its queue; a redelivery
// rewrites the same record and leaves its status alone.
func RecordRouting(ctx context.Context, r Routing) error {
	key := "routing:" + r.Tenant + ":" + r.TicketID
	fields := map[string]any{
		"ticket_id": r.TicketID, "tenant": r.Tenant, "queue": r.Queue, "priority": r.Priority,
		"confidence": strconv.FormatFloat(r.Confidence, 'f', -1, 64), "fallback_reason": r.FallbackReason,
		"received_at": strconv.FormatInt(r.ReceivedAt, 10),
	}
	if err := rdb.HSet(ctx, key, fields).Err(); err != nil {
		return err
	}
	if err := rdb.HSetNX(ctx, key, "status", "open").Err(); err != nil {
		return err
	}
	return rdb.SAdd(ctx, "routing:"+r.Tenant+":queue:"+r.Queue, r.TicketID).Err()
}

// RoutingRecords is every routing record of the tenant's queue, open and closed, oldest first.
func RoutingRecords(ctx context.Context, tenant, queue string) []Routing {
	var out []Routing
	for _, id := range rdb.SMembers(ctx, "routing:"+tenant+":queue:"+queue).Val() {
		raw := rdb.HGetAll(ctx, "routing:"+tenant+":"+id).Val()
		confidence, _ := strconv.ParseFloat(raw["confidence"], 64)
		receivedAt, _ := strconv.ParseFloat(raw["received_at"], 64)
		status := raw["status"]
		if status == "" {
			status = "open"
		}
		out = append(out, Routing{TicketID: raw["ticket_id"], Tenant: raw["tenant"], Queue: raw["queue"], Priority: raw["priority"],
			Confidence: confidence, FallbackReason: raw["fallback_reason"], ReceivedAt: int64(receivedAt), Status: status})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ReceivedAt != out[j].ReceivedAt {
			return out[i].ReceivedAt < out[j].ReceivedAt
		}
		return out[i].TicketID < out[j].TicketID
	})
	return out
}

// CloseTicket marks the ticket resolved: its record stays, closed.
func CloseTicket(ctx context.Context, tenant, ticketID string) {
	rdb.HSet(ctx, "routing:"+tenant+":"+ticketID, "status", "closed")
}

// CreateQueue registers the tenant's queue name and returns its id (q-1, q-2, ...).
func CreateQueue(ctx context.Context, tenant, name string) string {
	queueID := fmt.Sprintf("q-%d", rdb.Incr(ctx, "queue:seq").Val())
	rdb.HSet(ctx, "queue:"+queueID, map[string]any{"queue_id": queueID, "tenant": tenant, "name": name})
	return queueID
}

// Queue is the queue with that id, or nil.
func Queue(ctx context.Context, queueID string) *QueueInfo {
	raw := rdb.HGetAll(ctx, "queue:"+queueID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &QueueInfo{QueueID: raw["queue_id"], Tenant: raw["tenant"], Name: raw["name"]}
}

// InsertOutbox keeps an event the broker refused (its JSON), for the relay to republish.
func InsertOutbox(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, Outbox, string(event)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'triage/rules.h': `${block(RULES_DOC, '// ')}
#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <utility>
#include <vector>

namespace rules {

inline const std::string kRulesetVersion = "v3";
constexpr double kRuleConfidence = 0.5;

// Where a ticket goes and why. fallback_reason is "" unless the rules stood in for the classifier;
// ruleset_version is "" when the classifier decided.
struct Decision {
  std::string queue;
  std::string priority;
  double confidence = 0;
  std::string fallback_reason;
  std::string ruleset_version;
};

inline bool containsAny(const std::string& text, const std::vector<std::string>& words) {
  return std::any_of(words.begin(), words.end(), [&](const std::string& w) { return text.find(w) != std::string::npos; });
}

// The ruleset's decision for a ticket.
inline Decision ruleDecision(const std::string& text) {
  static const std::vector<std::pair<std::string, std::vector<std::string>>> keywords = {
      {"billing", {"invoice", "refund", "charge", "payment"}},
      {"delivery", {"shipment", "delivery", "tracking", "parcel"}},
      {"account", {"password", "login", "locked", "sign-in"}},
  };
  static const std::vector<std::string> urgent = {"outage", "breach", "data loss"};
  std::string lowered = text;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) { return std::tolower(c); });
  Decision d{"general", "normal", kRuleConfidence, "", kRulesetVersion};
  for (const auto& [queue, words] : keywords) {
    if (containsAny(lowered, words)) {
      d.queue = queue;
      break;
    }
  }
  if (containsAny(lowered, urgent)) d.priority = "urgent";
  return d;
}

}  // namespace rules
`,
  'triage/store.h': `${block(STORE_DOC, '// ')}
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::string kOutbox = "outbox:triage.decided";

// A routed ticket's record.
struct Routing {
  std::string ticket_id;
  std::string tenant;
  std::string queue;
  std::string priority;
  double confidence = 0;
  std::string fallback_reason;
  long long received_at = 0;
  std::string status;
};

// A tenant's queue.
struct Queue {
  std::string queue_id;
  std::string tenant;
  std::string name;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// A fresh ticket id: t-1, t-2, ...
inline std::string newTicketId() { return "t-" + std::to_string(redis().incr("ticket:seq")); }

// The routing a POST answered for (tenant, Idempotency-Key), if any.
inline std::optional<nlohmann::json> decisionForKey(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("idem:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what a POST answered for (tenant, Idempotency-Key), for its replays.
inline void saveDecision(const std::string& tenant, const std::string& key, const nlohmann::json& routing) {
  redis().set("idem:" + tenant + ":" + key, routing.dump(), std::chrono::seconds(86400));
}

inline std::string text(const nlohmann::json& v) { return v.is_string() ? v.get<std::string>() : v.dump(); }

// Record a routed ticket (a triage.decided event: ticket_id, tenant, queue, priority, confidence,
// fallback_reason, received_at) in its queue; a redelivery rewrites the same record and leaves its
// status alone.
inline void recordRouting(const nlohmann::json& event) {
  const std::string tenant = event.at("tenant").get<std::string>();
  const std::string ticket_id = event.at("ticket_id").get<std::string>();
  const std::string key = "routing:" + tenant + ":" + ticket_id;
  redis().hset(key, {{"ticket_id", ticket_id},
                     {"tenant", tenant},
                     {"queue", text(event.at("queue"))},
                     {"priority", text(event.at("priority"))},
                     {"confidence", text(event.at("confidence"))},
                     {"fallback_reason", text(event.at("fallback_reason"))},
                     {"received_at", text(event.at("received_at"))}});
  redis().hsetnx(key, "status", "open");
  redis().sadd("routing:" + tenant + ":queue:" + text(event.at("queue")), ticket_id);
}

// Every routing record of the tenant's queue, open and closed, oldest first.
inline std::vector<Routing> routingRecords(const std::string& tenant, const std::string& queue) {
  std::vector<Routing> out;
  for (const std::string& id : redis().smembers("routing:" + tenant + ":queue:" + queue)) {
    const std::unordered_map<std::string, std::string> raw = redis().hgetall("routing:" + tenant + ":" + id);
    const auto field = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
    Routing r;
    r.ticket_id = field("ticket_id");
    r.tenant = field("tenant");
    r.queue = field("queue");
    r.priority = field("priority");
    r.confidence = field("confidence").empty() ? 0 : std::stod(field("confidence"));
    r.fallback_reason = field("fallback_reason");
    r.received_at = field("received_at").empty() ? 0 : static_cast<long long>(std::stod(field("received_at")));
    r.status = field("status").empty() ? "open" : field("status");
    out.push_back(r);
  }
  std::sort(out.begin(), out.end(), [](const Routing& a, const Routing& b) {
    return a.received_at != b.received_at ? a.received_at < b.received_at : a.ticket_id < b.ticket_id;
  });
  return out;
}

// An agent resolved the ticket: its record stays, closed.
inline void closeTicket(const std::string& tenant, const std::string& ticket_id) {
  redis().hset("routing:" + tenant + ":" + ticket_id, "status", "closed");
}

// Register the tenant's queue name; returns its id (q-1, q-2, ...).
inline std::string createQueue(const std::string& tenant, const std::string& name) {
  const std::string queue_id = "q-" + std::to_string(redis().incr("queue:seq"));
  redis().hset("queue:" + queue_id, {{"queue_id", queue_id}, {"tenant", tenant}, {"name", name}});
  return queue_id;
}

// The queue with that id, if any.
inline std::optional<Queue> queue(const std::string& queue_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("queue:" + queue_id);
  if (raw.empty()) return std::nullopt;
  return Queue{raw.at("queue_id"), raw.at("tenant"), raw.at("name")};
}

// Keep an event the broker refused (its JSON), for the relay to republish.
inline void insertOutbox(const std::string& event) { redis().rpush(kOutbox, event); }

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('triage', 'Rules')]: `package triage

/**
${block(RULES_DOC, ' * ')}
 */
object Rules {
  /** Where a ticket goes and why: fallbackReason is "" unless the rules stood in for the classifier, rulesetVersion "" when the classifier decided. */
  final case class Decision(queue: String, priority: String, confidence: Double, fallbackReason: String, rulesetVersion: String)

  val RulesetVersion = "v3"
  val RuleConfidence = 0.5
  val Queues: Seq[String] = Seq("billing", "delivery", "account", "general")

  private val Keywords: Seq[(String, Seq[String])] = Seq(
    "billing" -> Seq("invoice", "refund", "charge", "payment"),
    "delivery" -> Seq("shipment", "delivery", "tracking", "parcel"),
    "account" -> Seq("password", "login", "locked", "sign-in"),
  )
  private val Urgent = Seq("outage", "breach", "data loss")

  /** The ruleset's decision for a ticket. */
  def ruleDecision(text: String): Decision = {
    val lowered = text.toLowerCase
    val queue = Keywords.collectFirst { case (name, words) if words.exists(lowered.contains) => name }.getOrElse("general")
    val priority = if (Urgent.exists(lowered.contains)) "urgent" else "normal"
    Decision(queue, priority, RuleConfidence, "", RulesetVersion)
  }
}
`,
  [scalaPath('triage', 'Store')]: `package triage

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
${block(STORE_DOC, ' * ')}
 */
object Store {
  /** A routed ticket's record. */
  final case class Routing(ticketId: String, tenant: String, queue: String, priority: String, confidence: Double, fallbackReason: String, receivedAt: Long, status: String)
  /** A tenant's queue. */
  final case class Queue(queueId: String, tenant: String, name: String)

  val Outbox = "outbox:triage.decided"
  val jedis = new JedisPooled("redis", 6379)

  /** A fresh ticket id: t-1, t-2, ... */
  def newTicketId(): String = s"t-\${jedis.incr("ticket:seq")}"

  /** The routing a POST answered for (tenant, Idempotency-Key), if any. */
  def decisionForKey(tenant: String, key: String): Option[JsObject] =
    Option(jedis.get(s"idem:$tenant:$key")).map(_.parseJson.asJsObject)

  /** Record what a POST answered for (tenant, Idempotency-Key), for its replays. */
  def saveDecision(tenant: String, key: String, routing: JsObject): Unit =
    jedis.set(s"idem:$tenant:$key", routing.compactPrint, SetParams.setParams().ex(86400L))

  private def text(v: JsValue): String = v match {
    case JsString(s) => s
    case other => other.compactPrint
  }

  /** Record a routed ticket (a triage.decided event) in its queue; a redelivery rewrites the same record and leaves its status alone. */
  def recordRouting(event: JsObject): Unit = {
    val f = event.fields
    val tenant = text(f("tenant"))
    val ticketId = text(f("ticket_id"))
    val key = s"routing:$tenant:$ticketId"
    val names = Seq("ticket_id", "tenant", "queue", "priority", "confidence", "fallback_reason", "received_at")
    jedis.hset(key, names.map(name => name -> text(f(name))).toMap.asJava)
    jedis.hsetnx(key, "status", "open")
    jedis.sadd(s"routing:$tenant:queue:\${text(f("queue"))}", ticketId)
  }

  /** Every routing record of the tenant's queue, open and closed, oldest first. */
  def routingRecords(tenant: String, queue: String): Seq[Routing] =
    jedis.smembers(s"routing:$tenant:queue:$queue").asScala.toSeq.map { id =>
      val raw = jedis.hgetAll(s"routing:$tenant:$id").asScala
      Routing(raw("ticket_id"), raw("tenant"), raw("queue"), raw("priority"), raw("confidence").toDouble,
        raw.getOrElse("fallback_reason", ""), raw("received_at").toDouble.toLong, raw.getOrElse("status", "open"))
    }.sortBy(r => (r.receivedAt, r.ticketId))

  /** An agent resolved the ticket: its record stays, closed. */
  def closeTicket(tenant: String, ticketId: String): Unit = jedis.hset(s"routing:$tenant:$ticketId", "status", "closed")

  /** Register the tenant's queue name; returns its id (q-1, q-2, ...). */
  def createQueue(tenant: String, name: String): String = {
    val queueId = s"q-\${jedis.incr("queue:seq")}"
    jedis.hset(s"queue:$queueId", Map("queue_id" -> queueId, "tenant" -> tenant, "name" -> name).asJava)
    queueId
  }

  /** The queue with that id, if any. */
  def queue(queueId: String): Option[Queue] = {
    val raw = jedis.hgetAll(s"queue:$queueId").asScala
    if (raw.isEmpty) None else Some(Queue(raw("queue_id"), raw("tenant"), raw("name")))
  }

  /** Keep an event the broker refused (its JSON), for the relay to republish. */
  def insertOutbox(event: String): Unit = jedis.rpush(Outbox, event)
}
`,
};
