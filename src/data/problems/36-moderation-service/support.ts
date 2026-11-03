/**
 * Hand-written support modules the moderation steps import but no step builds: the `moderation`
 * package. `moderation.store` is the case store in Redis (the content catalogue, report cases, the
 * persisted moderation actions, the outbox); `moderation.queue` is the review queue's intake
 * (`enqueue`), on the keys step 2 claims from. The five languages keep the same keys, so a harness
 * reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

const STORE_DOC = `The case store (provided), in Redis. content:{content_id} is the content catalogue (tenant, text);
case:{case_id} a report case (case_id, tenant, content_id, reporter_id, reason, detail, status,
reports); case:reporter:{tenant}:{content_id}:{reporter_id} names the reporter's case on that item;
actions:{content_id} lists the persisted moderation actions, one JSON document each, in order, and
actions:{content_id}:ids the action ids already persisted (a replayed action is stored once);
outbox lists the produces the broker refused, as JSON rows {topic, key, payload} a relay publishes
later.`;

const QUEUE_DOC = `The review queue's intake (provided). moderation:pending is a sorted set of the case ids waiting for
a moderator, in arrival order (scored by moderation:seq); moderation:counters is a hash whose
pending and in_review fields count the queue. enqueue adds a case unless it is already pending or
claimed (moderation:owners holds the claimed ones), in one script. Step 2 claims from these keys.`;

const ENQUEUE_LUA = `if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
if redis.call('HEXISTS', KEYS[4], ARGV[1]) == 1 then return 0 end
local seq = redis.call('INCR', KEYS[2])
redis.call('ZADD', KEYS[1], seq, ARGV[1])
redis.call('HINCRBY', KEYS[3], 'pending', 1)
return 1`;

const comment = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');

export const supportModules: Record<string, string> = {
  'moderation/__init__.py': '',
  'moderation/store.py': `"""
${STORE_DOC}
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def add_content(content_id: str, tenant: str, text: str = "") -> None:
    """Register a piece of content and the tenant that owns it."""
    r.hset(f"content:{content_id}", mapping={"tenant": tenant, "text": text})


def content_tenant(content_id: str) -> str | None:
    """The tenant that owns the content, or None for an unknown id."""
    return r.hget(f"content:{content_id}", "tenant")


def get_case(case_id: str) -> dict | None:
    """The case as a dict (reports as an int), or None."""
    raw = r.hgetall(f"case:{case_id}")
    if not raw:
        return None
    return {**raw, "reports": int(raw.get("reports", "0"))}


def find_case(tenant: str, content_id: str, reporter_id: str) -> dict | None:
    """The reporter's case on this item, or None."""
    case_id = r.get(f"case:reporter:{tenant}:{content_id}:{reporter_id}")
    return get_case(case_id) if case_id else None


def insert_case(tenant: str, content_id: str, reporter_id: str, reason: str, detail: str) -> dict:
    """A new open case with one report; returns it."""
    case_id = f"case-{r.incr('case:seq')}"
    r.hset(
        f"case:{case_id}",
        mapping={
            "case_id": case_id,
            "tenant": tenant,
            "content_id": content_id,
            "reporter_id": reporter_id,
            "reason": reason,
            "detail": detail,
            "status": "open",
            "reports": 1,
        },
    )
    r.set(f"case:reporter:{tenant}:{content_id}:{reporter_id}", case_id)
    return get_case(case_id)


def update_case(case_id: str, reason: str, detail: str) -> dict:
    """Another report on the same case: the latest reason and detail, one more report; returns it."""
    r.hset(f"case:{case_id}", mapping={"reason": reason, "detail": detail})
    r.hincrby(f"case:{case_id}", "reports", 1)
    return get_case(case_id)


def put_action(event: dict) -> bool:
    """Persist one moderation action (an event with action_id and content_id); a replay is a no-op. Whether it was new."""
    if r.sadd(f"actions:{event['content_id']}:ids", event["action_id"]) == 0:
        return False
    r.rpush(f"actions:{event['content_id']}", json.dumps(event))
    return True


def actions_of(content_id: str) -> list[dict]:
    """The persisted actions on the content, oldest first."""
    return [json.loads(raw) for raw in r.lrange(f"actions:{content_id}", 0, -1)]


def insert_outbox(topic: str, key: str, payload: str) -> None:
    """Keep a refused produce for the relay: the topic, the record key and the serialized event."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'moderation/queue.py': `"""
${QUEUE_DOC}
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PENDING = "moderation:pending"
SEQ = "moderation:seq"
COUNTERS = "moderation:counters"
OWNERS = "moderation:owners"

ENQUEUE_LUA = """
${ENQUEUE_LUA}
"""
_enqueue = r.register_script(ENQUEUE_LUA)


def enqueue(case_id: str) -> bool:
    """Put the case in the review queue; False when it is already pending or claimed."""
    return _enqueue(keys=[PENDING, SEQ, COUNTERS, OWNERS], args=[case_id]) == 1
`,
};

export const supportModulesTs: Record<string, string> = {
  'moderation/store.ts': `/**
${comment(STORE_DOC, ' * ')}
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Case {
  case_id: string;
  tenant: string;
  content_id: string;
  reporter_id: string;
  reason: string;
  detail: string;
  status: string;
  reports: number;
}

/** Register a piece of content and the tenant that owns it. */
export async function addContent(contentId: string, tenant: string, text = ''): Promise<void> {
  await redis.hset(\`content:\${contentId}\`, {tenant, text});
}

/** The tenant that owns the content, or null for an unknown id. */
export async function contentTenant(contentId: string): Promise<string | null> {
  return redis.hget(\`content:\${contentId}\`, 'tenant');
}

/** The case, or null. */
export async function getCase(caseId: string): Promise<Case | null> {
  const raw = await redis.hgetall(\`case:\${caseId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    case_id: raw.case_id,
    tenant: raw.tenant,
    content_id: raw.content_id,
    reporter_id: raw.reporter_id,
    reason: raw.reason,
    detail: raw.detail ?? '',
    status: raw.status,
    reports: Number(raw.reports ?? 0),
  };
}

/** The reporter's case on this item, or null. */
export async function findCase(tenant: string, contentId: string, reporterId: string): Promise<Case | null> {
  const caseId = await redis.get(\`case:reporter:\${tenant}:\${contentId}:\${reporterId}\`);
  return caseId === null ? null : getCase(caseId);
}

/** A new open case with one report; returns it. */
export async function insertCase(tenant: string, contentId: string, reporterId: string, reason: string, detail: string): Promise<Case> {
  const caseId = \`case-\${await redis.incr('case:seq')}\`;
  await redis.hset(\`case:\${caseId}\`, {
    case_id: caseId,
    tenant,
    content_id: contentId,
    reporter_id: reporterId,
    reason,
    detail,
    status: 'open',
    reports: '1',
  });
  await redis.set(\`case:reporter:\${tenant}:\${contentId}:\${reporterId}\`, caseId);
  return (await getCase(caseId)) as Case;
}

/** Another report on the same case: the latest reason and detail, one more report; returns it. */
export async function updateCase(caseId: string, reason: string, detail: string): Promise<Case> {
  await redis.hset(\`case:\${caseId}\`, {reason, detail});
  await redis.hincrby(\`case:\${caseId}\`, 'reports', 1);
  return (await getCase(caseId)) as Case;
}

/** Persist one moderation action (an event with action_id and content_id); a replay is a no-op. Whether it was new. */
export async function putAction(event: Record<string, unknown>): Promise<boolean> {
  const contentId = String(event.content_id);
  if ((await redis.sadd(\`actions:\${contentId}:ids\`, String(event.action_id))) === 0) return false;
  await redis.rpush(\`actions:\${contentId}\`, JSON.stringify(event));
  return true;
}

/** The persisted actions on the content, oldest first. */
export async function actionsOf(contentId: string): Promise<Record<string, unknown>[]> {
  return (await redis.lrange(\`actions:\${contentId}\`, 0, -1)).map(raw => JSON.parse(raw) as Record<string, unknown>);
}

/** Keep a refused produce for the relay: the topic, the record key and the serialized event. */
export async function insertOutbox(topic: string, key: string, payload: string): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'moderation/queue.ts': `/**
${comment(QUEUE_DOC, ' * ')}
 */
import Redis from 'ioredis';

export const PENDING = 'moderation:pending';
export const SEQ = 'moderation:seq';
export const COUNTERS = 'moderation:counters';
export const OWNERS = 'moderation:owners';

export const ENQUEUE_LUA = \`
${ENQUEUE_LUA}
\`;

interface QueueRedis extends Redis {
  enqueueCase(pending: string, seq: string, counters: string, owners: string, caseId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as QueueRedis;
redis.defineCommand('enqueueCase', {numberOfKeys: 4, lua: ENQUEUE_LUA});

/** Put the case in the review queue; false when it is already pending or claimed. */
export async function enqueue(caseId: string): Promise<boolean> {
  return (await redis.enqueueCase(PENDING, SEQ, COUNTERS, OWNERS, caseId)) === 1;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'moderation/store/store.go': `${comment(
    STORE_DOC.replace(/^The case store/, 'Package store is the case store'),
    '// ',
  )}
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Case is one report case.
type Case struct {
	CaseID     string \`json:"case_id"\`
	Tenant     string \`json:"tenant"\`
	ContentID  string \`json:"content_id"\`
	ReporterID string \`json:"reporter_id"\`
	Reason     string \`json:"reason"\`
	Detail     string \`json:"detail"\`
	Status     string \`json:"status"\`
	Reports    int    \`json:"reports"\`
}

// AddContent registers a piece of content and the tenant that owns it.
func AddContent(ctx context.Context, contentID, tenant, text string) {
	rdb.HSet(ctx, "content:"+contentID, map[string]any{"tenant": tenant, "text": text})
}

// ContentTenant is the tenant that owns the content, and false for an unknown id.
func ContentTenant(ctx context.Context, contentID string) (string, bool) {
	tenant, err := rdb.HGet(ctx, "content:"+contentID, "tenant").Result()
	return tenant, err == nil
}

// GetCase is the case, or nil.
func GetCase(ctx context.Context, caseID string) *Case {
	raw := rdb.HGetAll(ctx, "case:"+caseID).Val()
	if len(raw) == 0 {
		return nil
	}
	reports, _ := strconv.Atoi(raw["reports"])
	return &Case{CaseID: raw["case_id"], Tenant: raw["tenant"], ContentID: raw["content_id"], ReporterID: raw["reporter_id"], Reason: raw["reason"], Detail: raw["detail"], Status: raw["status"], Reports: reports}
}

// FindCase is the reporter's case on this item, or nil.
func FindCase(ctx context.Context, tenant, contentID, reporterID string) *Case {
	caseID, err := rdb.Get(ctx, fmt.Sprintf("case:reporter:%s:%s:%s", tenant, contentID, reporterID)).Result()
	if err != nil {
		return nil
	}
	return GetCase(ctx, caseID)
}

// InsertCase opens a new case with one report and returns it.
func InsertCase(ctx context.Context, tenant, contentID, reporterID, reason, detail string) *Case {
	caseID := fmt.Sprintf("case-%d", rdb.Incr(ctx, "case:seq").Val())
	rdb.HSet(ctx, "case:"+caseID, map[string]any{
		"case_id": caseID, "tenant": tenant, "content_id": contentID, "reporter_id": reporterID,
		"reason": reason, "detail": detail, "status": "open", "reports": "1",
	})
	rdb.Set(ctx, fmt.Sprintf("case:reporter:%s:%s:%s", tenant, contentID, reporterID), caseID, 0)
	return GetCase(ctx, caseID)
}

// UpdateCase records another report on the same case (the latest reason and detail, one more
// report) and returns it.
func UpdateCase(ctx context.Context, caseID, reason, detail string) *Case {
	rdb.HSet(ctx, "case:"+caseID, map[string]any{"reason": reason, "detail": detail})
	rdb.HIncrBy(ctx, "case:"+caseID, "reports", 1)
	return GetCase(ctx, caseID)
}

// PutAction persists one moderation action (an event with action_id and content_id); a replay is
// a no-op. It reports whether the action was new.
func PutAction(ctx context.Context, event map[string]any) bool {
	contentID := fmt.Sprint(event["content_id"])
	if rdb.SAdd(ctx, "actions:"+contentID+":ids", fmt.Sprint(event["action_id"])).Val() == 0 {
		return false
	}
	raw, _ := json.Marshal(event)
	rdb.RPush(ctx, "actions:"+contentID, string(raw))
	return true
}

// ActionsOf lists the persisted actions on the content, oldest first.
func ActionsOf(ctx context.Context, contentID string) []map[string]any {
	out := []map[string]any{}
	for _, raw := range rdb.LRange(ctx, "actions:"+contentID, 0, -1).Val() {
		var event map[string]any
		json.Unmarshal([]byte(raw), &event)
		out = append(out, event)
	}
	return out
}

// InsertOutbox keeps a refused produce for the relay: the topic, the record key and the serialized event.
func InsertOutbox(ctx context.Context, topic, key, payload string) {
	row, _ := json.Marshal(map[string]string{"topic": topic, "key": key, "payload": payload})
	rdb.RPush(ctx, "outbox", string(row))
}
`,
  'moderation/queue/queue.go': `${comment(
    QUEUE_DOC.replace(/^The review queue's intake/, "Package queue is the review queue's intake"),
    '// ',
  )}
package queue

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const (
	Pending  = "moderation:pending"
	Seq      = "moderation:seq"
	Counters = "moderation:counters"
	Owners   = "moderation:owners"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var enqueueScript = redis.NewScript(\`
${ENQUEUE_LUA}
\`)

// Enqueue puts the case in the review queue; false when it is already pending or claimed.
func Enqueue(ctx context.Context, caseID string) bool {
	added, _ := enqueueScript.Run(ctx, rdb, []string{Pending, Seq, Counters, Owners}, caseID).Int64()
	return added == 1
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'moderation/store.h': `${comment(STORE_DOC, '// ')}
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <iterator>
#include <unordered_map>
#include <vector>

namespace store {

struct Case {
  std::string case_id;
  std::string tenant;
  std::string content_id;
  std::string reporter_id;
  std::string reason;
  std::string detail;
  std::string status;
  long reports = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Register a piece of content and the tenant that owns it.
inline void addContent(const std::string& content_id, const std::string& tenant, const std::string& text = "") {
  redis().hset("content:" + content_id, {{"tenant", tenant}, {"text", text}});
}

// The tenant that owns the content, or none for an unknown id.
inline std::optional<std::string> contentTenant(const std::string& content_id) {
  const auto tenant = redis().hget("content:" + content_id, "tenant");
  if (!tenant) return std::nullopt;
  return *tenant;
}

// The case, or none.
inline std::optional<Case> getCase(const std::string& case_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("case:" + case_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Case c;
  c.case_id = text("case_id");
  c.tenant = text("tenant");
  c.content_id = text("content_id");
  c.reporter_id = text("reporter_id");
  c.reason = text("reason");
  c.detail = text("detail");
  c.status = text("status");
  c.reports = text("reports").empty() ? 0 : std::stol(text("reports"));
  return c;
}

// The reporter's case on this item, or none.
inline std::optional<Case> findCase(const std::string& tenant, const std::string& content_id, const std::string& reporter_id) {
  const auto case_id = redis().get("case:reporter:" + tenant + ":" + content_id + ":" + reporter_id);
  if (!case_id) return std::nullopt;
  return getCase(*case_id);
}

// A new open case with one report; returns it.
inline Case insertCase(const std::string& tenant, const std::string& content_id, const std::string& reporter_id,
                       const std::string& reason, const std::string& detail) {
  const std::string case_id = "case-" + std::to_string(redis().incr("case:seq"));
  const std::unordered_map<std::string, std::string> fields = {
      {"case_id", case_id}, {"tenant", tenant}, {"content_id", content_id}, {"reporter_id", reporter_id},
      {"reason", reason},   {"detail", detail}, {"status", "open"},         {"reports", "1"}};
  redis().hset("case:" + case_id, fields.begin(), fields.end());
  redis().set("case:reporter:" + tenant + ":" + content_id + ":" + reporter_id, case_id);
  return *getCase(case_id);
}

// Another report on the same case: the latest reason and detail, one more report; returns it.
inline Case updateCase(const std::string& case_id, const std::string& reason, const std::string& detail) {
  redis().hset("case:" + case_id, {{"reason", reason}, {"detail", detail}});
  redis().hincrby("case:" + case_id, "reports", 1);
  return *getCase(case_id);
}

// Persist one moderation action (an event with action_id and content_id); a replay is a no-op.
// Whether it was new.
inline bool putAction(const nlohmann::json& event) {
  const std::string content_id = event.value("content_id", "");
  if (redis().sadd("actions:" + content_id + ":ids", event.value("action_id", "")) == 0) return false;
  redis().rpush("actions:" + content_id, event.dump());
  return true;
}

// The persisted actions on the content, oldest first.
inline std::vector<nlohmann::json> actionsOf(const std::string& content_id) {
  std::vector<std::string> raw;
  redis().lrange("actions:" + content_id, 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> out;
  for (const auto& r : raw) out.push_back(nlohmann::json::parse(r));
  return out;
}

// Keep a refused produce for the relay: the topic, the record key and the serialized event.
inline void insertOutbox(const std::string& topic, const std::string& key, const std::string& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'moderation/queue.h': `${comment(QUEUE_DOC, '// ')}
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace queue {

inline const std::string kPending = "moderation:pending";
inline const std::string kSeq = "moderation:seq";
inline const std::string kCounters = "moderation:counters";
inline const std::string kOwners = "moderation:owners";

inline const std::string kEnqueueLua = R"lua(
${ENQUEUE_LUA}
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Put the case in the review queue; false when it is already pending or claimed.
inline bool enqueue(const std::string& case_id) {
  return redis().eval<long long>(kEnqueueLua, {kPending, kSeq, kCounters, kOwners}, {case_id}) == 1;
}

}  // namespace queue
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('moderation', 'Store')]: `package moderation

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
${comment(STORE_DOC, ' * ')}
 */
object Store {
  final case class Case(caseId: String, tenant: String, contentId: String, reporterId: String, reason: String, detail: String, status: String, reports: Long)

  val jedis = new JedisPooled("redis", 6379)

  /** Register a piece of content and the tenant that owns it. */
  def addContent(contentId: String, tenant: String, text: String = ""): Unit =
    jedis.hset(s"content:$contentId", Map("tenant" -> tenant, "text" -> text).asJava)

  /** The tenant that owns the content, or None for an unknown id. */
  def contentTenant(contentId: String): Option[String] = Option(jedis.hget(s"content:$contentId", "tenant"))

  /** The case, if it exists. */
  def getCase(caseId: String): Option[Case] = {
    val raw = jedis.hgetAll(s"case:$caseId").asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      Some(Case(text("case_id"), text("tenant"), text("content_id"), text("reporter_id"), text("reason"), text("detail"), text("status"), text("reports").toLongOption.getOrElse(0L)))
    }
  }

  /** The reporter's case on this item, if any. */
  def findCase(tenant: String, contentId: String, reporterId: String): Option[Case] =
    Option(jedis.get(s"case:reporter:$tenant:$contentId:$reporterId")).flatMap(getCase)

  /** A new open case with one report; returns it. */
  def insertCase(tenant: String, contentId: String, reporterId: String, reason: String, detail: String): Case = {
    val caseId = s"case-\${jedis.incr("case:seq")}"
    jedis.hset(
      s"case:$caseId",
      Map("case_id" -> caseId, "tenant" -> tenant, "content_id" -> contentId, "reporter_id" -> reporterId, "reason" -> reason, "detail" -> detail, "status" -> "open", "reports" -> "1").asJava)
    jedis.set(s"case:reporter:$tenant:$contentId:$reporterId", caseId)
    getCase(caseId).get
  }

  /** Another report on the same case: the latest reason and detail, one more report; returns it. */
  def updateCase(caseId: String, reason: String, detail: String): Case = {
    jedis.hset(s"case:$caseId", Map("reason" -> reason, "detail" -> detail).asJava)
    jedis.hincrBy(s"case:$caseId", "reports", 1L)
    getCase(caseId).get
  }

  private def text(event: JsObject, name: String): String = event.fields.get(name) match {
    case Some(JsString(s)) => s
    case Some(other) => other.compactPrint
    case None => ""
  }

  /** Persist one moderation action (an event with action_id and content_id); a replay is a no-op. Whether it was new. */
  def putAction(event: JsObject): Boolean = {
    val contentId = text(event, "content_id")
    if (jedis.sadd(s"actions:$contentId:ids", text(event, "action_id")) == 0L) false
    else {
      jedis.rpush(s"actions:$contentId", event.compactPrint)
      true
    }
  }

  /** The persisted actions on the content, oldest first. */
  def actionsOf(contentId: String): Seq[JsObject] =
    jedis.lrange(s"actions:$contentId", 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)

  /** Keep a refused produce for the relay: the topic, the record key and the serialized event. */
  def insertOutbox(topic: String, key: String, payload: String): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> JsString(payload)).compactPrint)
}
`,
  [scalaPath('moderation', 'Queue')]: `package moderation

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
${comment(QUEUE_DOC, ' * ')}
 */
object Queue {
  val Pending = "moderation:pending"
  val SeqKey = "moderation:seq"
  val Counters = "moderation:counters"
  val Owners = "moderation:owners"

  val jedis = new JedisPooled("redis", 6379)

  val EnqueueLua: String =
    """${ENQUEUE_LUA.split('\n').join('\n      |')}
      |""".stripMargin

  /** Put the case in the review queue; false when it is already pending or claimed. */
  def enqueue(caseId: String): Boolean =
    jedis.eval(EnqueueLua, List(Pending, SeqKey, Counters, Owners).asJava, List(caseId).asJava).asInstanceOf[java.lang.Long] == 1L
}
`,
};
