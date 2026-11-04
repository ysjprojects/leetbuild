/**
 * Hand-written support modules the citation-store steps import but no step builds: the `citations`
 * package. `citations.documents` is the document versions store (every version of a document is an
 * immutable string in Redis, the course's stand-in for the document database the service reads);
 * `citations.store` is the citation store (one hash per citation, the answer index, the
 * Idempotency-Key records and the outbox). The five languages keep the same keys, so a harness reads
 * one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'citations/__init__.py': '',
  'citations/documents.py': `"""
The document versions store (provided): a document is a sequence of immutable versions, each the
string doc:{document_id}:v{n}, and doc:{document_id}:latest holds the newest version number. Offsets
into a text count characters. add_version is the document store's writer; the citation service reads.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def add_version(document_id: str, text: str) -> int:
    """Store text as the next version of the document; returns its number."""
    n = r.incr(f"doc:{document_id}:latest")
    r.set(f"doc:{document_id}:v{n}", text)
    return n


def get_version(document_id: str, version: int) -> str | None:
    """The text of that version, or None when the document has no such version."""
    return r.get(f"doc:{document_id}:v{version}")


def latest(document_id: str) -> str | None:
    """The text of the document's newest version, or None when it has none."""
    n = r.get(f"doc:{document_id}:latest")
    return None if n is None else get_version(document_id, int(n))
`,
  'citations/store.py': `"""
The citation store (provided), in Redis: a citation is the hash citation:{id} with id, tenant,
answer_id, document_id, version, start, end, quote, status and reason; answer:{answer_id} lists the
ids of an answer's citations in order (every tenant's); idem:{tenant}:{key} holds the id a tenant's
Idempotency-Key created; the outbox is the list outbox of JSON rows {"topic", "key", "payload"} a
relay publishes later. A new citation is pending until the verifier sets verified or broken.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FIELDS = ("answer_id", "document_id", "version", "start", "end", "quote")
INTS = ("version", "start", "end")


def _row(raw: dict) -> dict | None:
    if not raw:
        return None
    return {**raw, **{name: int(raw[name]) for name in INTS}}


def create(tenant: str, citation: dict) -> dict:
    """A new pending citation of the tenant from answer_id, document_id, version, start, end, quote; returns the row."""
    citation_id = f"c-{r.incr('citation:seq')}"
    row = {"id": citation_id, "tenant": tenant, **{name: citation[name] for name in FIELDS}, "status": "pending", "reason": ""}
    r.hset(f"citation:{citation_id}", mapping=row)
    r.rpush(f"answer:{citation['answer_id']}", citation_id)
    return get(citation_id)


def get(citation_id: str) -> dict | None:
    """The citation, whatever tenant it belongs to, or None."""
    return _row(r.hgetall(f"citation:{citation_id}"))


def for_answer(answer_id: str) -> list[dict]:
    """Every citation recorded under the answer id, in order, whatever tenant it belongs to."""
    rows = (get(citation_id) for citation_id in r.lrange(f"answer:{answer_id}", 0, -1))
    return [row for row in rows if row is not None]


def set_verification(result: dict) -> None:
    """Record what the verifier found for citation result["id"]: status, reason, version, start, end."""
    r.hset(f"citation:{result['id']}", mapping={name: result[name] for name in ("status", "reason", "version", "start", "end")})


def by_key(tenant: str, key: str) -> dict | None:
    """The citation the tenant's Idempotency-Key created, or None."""
    citation_id = r.get(f"idem:{tenant}:{key}")
    return None if citation_id is None else get(citation_id)


def bind_key(tenant: str, key: str, citation_id: str) -> None:
    """Remember that the tenant's Idempotency-Key created citation_id, for its replays."""
    r.set(f"idem:{tenant}:{key}", citation_id)


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Queue a record for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'citations/documents.ts': `/**
 * The document versions store (provided): a document is a sequence of immutable versions, each the
 * string doc:{document_id}:v{n}, and doc:{document_id}:latest holds the newest version number.
 * Offsets into a text count characters. addVersion is the document store's writer; the citation
 * service reads.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Store text as the next version of the document; resolves to its number. */
export async function addVersion(documentId: string, text: string): Promise<number> {
  const n = await redis.incr(\`doc:\${documentId}:latest\`);
  await redis.set(\`doc:\${documentId}:v\${n}\`, text);
  return n;
}

/** The text of that version, or null when the document has no such version. */
export async function getVersion(documentId: string, version: number): Promise<string | null> {
  return redis.get(\`doc:\${documentId}:v\${version}\`);
}

/** The text of the document's newest version, or null when it has none. */
export async function latest(documentId: string): Promise<string | null> {
  const n = await redis.get(\`doc:\${documentId}:latest\`);
  return n === null ? null : getVersion(documentId, Number(n));
}
`,
  'citations/store.ts': `/**
 * The citation store (provided), in Redis: a citation is the hash citation:{id} with id, tenant,
 * answer_id, document_id, version, start, end, quote, status and reason; answer:{answer_id} lists the
 * ids of an answer's citations in order (every tenant's); idem:{tenant}:{key} holds the id a tenant's
 * Idempotency-Key created; the outbox is the list outbox of JSON rows {"topic", "key", "payload"} a
 * relay publishes later. A new citation is pending until the verifier sets verified or broken.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Citation {
  id: string;
  tenant: string;
  answer_id: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
  reason: string;
}

/** What a request supplies for a new citation. */
export type CitationFields = Pick<Citation, 'answer_id' | 'document_id' | 'version' | 'start' | 'end' | 'quote'>;

function row(raw: Record<string, string>): Citation | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    tenant: raw.tenant,
    answer_id: raw.answer_id,
    document_id: raw.document_id,
    version: Number(raw.version),
    start: Number(raw.start),
    end: Number(raw.end),
    quote: raw.quote,
    status: raw.status,
    reason: raw.reason ?? '',
  };
}

/** The citation, whatever tenant it belongs to, or null. */
export async function get(citationId: string): Promise<Citation | null> {
  return row(await redis.hgetall(\`citation:\${citationId}\`));
}

/** A new pending citation of the tenant; resolves to the row. */
export async function create(tenant: string, fields: CitationFields): Promise<Citation> {
  const id = \`c-\${await redis.incr('citation:seq')}\`;
  const {answer_id, document_id, version, start, end, quote} = fields;
  await redis.hset(\`citation:\${id}\`, {
    id,
    tenant,
    answer_id,
    document_id,
    version: String(version),
    start: String(start),
    end: String(end),
    quote,
    status: 'pending',
    reason: '',
  });
  await redis.rpush(\`answer:\${answer_id}\`, id);
  return (await get(id)) as Citation;
}

/** Every citation recorded under the answer id, in order, whatever tenant it belongs to. */
export async function forAnswer(answerId: string): Promise<Citation[]> {
  const rows = await Promise.all((await redis.lrange(\`answer:\${answerId}\`, 0, -1)).map(get));
  return rows.filter((r): r is Citation => r !== null);
}

/** Record what the verifier found for citation result.id: status, reason, version, start, end. */
export async function setVerification(result: Citation): Promise<void> {
  await redis.hset(\`citation:\${result.id}\`, {
    status: result.status,
    reason: result.reason,
    version: String(result.version),
    start: String(result.start),
    end: String(result.end),
  });
}

/** The citation the tenant's Idempotency-Key created, or null. */
export async function byKey(tenant: string, key: string): Promise<Citation | null> {
  const id = await redis.get(\`idem:\${tenant}:\${key}\`);
  return id === null ? null : get(id);
}

/** Remember that the tenant's Idempotency-Key created citationId, for its replays. */
export async function bindKey(tenant: string, key: string, citationId: string): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, citationId);
}

/** Queue a record for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: unknown): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'citations/documents/documents.go': `// Package documents is the document versions store (provided): a document is a sequence of
// immutable versions, each the string doc:{document_id}:v{n}, and doc:{document_id}:latest holds the
// newest version number. Offsets into a text count characters (the texts are ASCII). AddVersion is
// the document store's writer; the citation service reads.
package documents

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// AddVersion stores text as the next version of the document and returns its number.
func AddVersion(ctx context.Context, documentID, text string) int {
	n := int(rdb.Incr(ctx, "doc:"+documentID+":latest").Val())
	rdb.Set(ctx, fmt.Sprintf("doc:%s:v%d", documentID, n), text, 0)
	return n
}

// GetVersion is the text of that version; false when the document has no such version.
func GetVersion(ctx context.Context, documentID string, version int) (string, bool) {
	text, err := rdb.Get(ctx, fmt.Sprintf("doc:%s:v%d", documentID, version)).Result()
	return text, err == nil
}

// Latest is the text of the document's newest version; false when it has none.
func Latest(ctx context.Context, documentID string) (string, bool) {
	n, err := rdb.Get(ctx, "doc:"+documentID+":latest").Int()
	if err != nil {
		return "", false
	}
	return GetVersion(ctx, documentID, n)
}
`,
  'citations/store/store.go': `// Package store is the citation store (provided), in Redis: a citation is the hash citation:{id}
// with id, tenant, answer_id, document_id, version, start, end, quote, status and reason;
// answer:{answer_id} lists the ids of an answer's citations in order (every tenant's);
// idem:{tenant}:{key} holds the id a tenant's Idempotency-Key created; the outbox is the list outbox
// of JSON rows {"topic", "key", "payload"} a relay publishes later. A new citation is pending until
// the verifier sets verified or broken.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Citation is one stored citation (a request body decodes into one, too).
type Citation struct {
	ID         string \`json:"id"\`
	Tenant     string \`json:"tenant"\`
	AnswerID   string \`json:"answer_id"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int    \`json:"start"\`
	End        int    \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

func row(raw map[string]string) *Citation {
	if len(raw) == 0 {
		return nil
	}
	version, _ := strconv.Atoi(raw["version"])
	start, _ := strconv.Atoi(raw["start"])
	end, _ := strconv.Atoi(raw["end"])
	return &Citation{ID: raw["id"], Tenant: raw["tenant"], AnswerID: raw["answer_id"], DocumentID: raw["document_id"], Version: version, Start: start, End: end, Quote: raw["quote"], Status: raw["status"], Reason: raw["reason"]}
}

// Get is the citation, whatever tenant it belongs to, or nil.
func Get(ctx context.Context, citationID string) *Citation {
	return row(rdb.HGetAll(ctx, "citation:"+citationID).Val())
}

// Create stores a new pending citation of the tenant (answer, document, version, span, quote of c) and returns the row.
func Create(ctx context.Context, tenant string, c Citation) Citation {
	id := fmt.Sprintf("c-%d", rdb.Incr(ctx, "citation:seq").Val())
	rdb.HSet(ctx, "citation:"+id, map[string]any{
		"id": id, "tenant": tenant, "answer_id": c.AnswerID, "document_id": c.DocumentID,
		"version": strconv.Itoa(c.Version), "start": strconv.Itoa(c.Start), "end": strconv.Itoa(c.End),
		"quote": c.Quote, "status": "pending", "reason": "",
	})
	rdb.RPush(ctx, "answer:"+c.AnswerID, id)
	return *Get(ctx, id)
}

// ForAnswer is every citation recorded under the answer id, in order, whatever tenant it belongs to.
func ForAnswer(ctx context.Context, answerID string) []Citation {
	out := []Citation{}
	for _, id := range rdb.LRange(ctx, "answer:"+answerID, 0, -1).Val() {
		if c := Get(ctx, id); c != nil {
			out = append(out, *c)
		}
	}
	return out
}

// SetVerification records what the verifier found for citation result.ID: status, reason, version, start, end.
func SetVerification(ctx context.Context, result Citation) error {
	return rdb.HSet(ctx, "citation:"+result.ID, map[string]any{
		"status": result.Status, "reason": result.Reason,
		"version": strconv.Itoa(result.Version), "start": strconv.Itoa(result.Start), "end": strconv.Itoa(result.End),
	}).Err()
}

// ByKey is the citation the tenant's Idempotency-Key created, or nil.
func ByKey(ctx context.Context, tenant, key string) *Citation {
	id, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, id)
}

// BindKey remembers that the tenant's Idempotency-Key created citationID, for its replays.
func BindKey(ctx context.Context, tenant, key, citationID string) {
	rdb.Set(ctx, "idem:"+tenant+":"+key, citationID, 0)
}

// OutboxRow is one row of the outbox.
type OutboxRow struct {
	Topic   string          \`json:"topic"\`
	Key     string          \`json:"key"\`
	Payload json.RawMessage \`json:"payload"\`
}

// InsertOutbox queues a record for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	row, _ := json.Marshal(OutboxRow{Topic: topic, Key: key, Payload: raw})
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'citations/documents.h': `// The document versions store (provided): a document is a sequence of immutable versions, each the
// string doc:{document_id}:v{n}, and doc:{document_id}:latest holds the newest version number.
// Offsets into a text count characters (the texts are ASCII). addVersion is the document store's
// writer; the citation service reads.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace documents {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store text as the next version of the document; returns its number.
inline long addVersion(const std::string& document_id, const std::string& text) {
  const long n = static_cast<long>(redis().incr("doc:" + document_id + ":latest"));
  redis().set("doc:" + document_id + ":v" + std::to_string(n), text);
  return n;
}

// The text of that version, or none when the document has no such version.
inline std::optional<std::string> getVersion(const std::string& document_id, long version) {
  const auto text = redis().get("doc:" + document_id + ":v" + std::to_string(version));
  if (!text) return std::nullopt;
  return *text;
}

// The text of the document's newest version, or none when it has none.
inline std::optional<std::string> latest(const std::string& document_id) {
  const auto n = redis().get("doc:" + document_id + ":latest");
  if (!n) return std::nullopt;
  return getVersion(document_id, std::stol(*n));
}

}  // namespace documents
`,
  'citations/store.h': `// The citation store (provided), in Redis: a citation is the hash citation:{id} with id, tenant,
// answer_id, document_id, version, start, end, quote, status and reason; answer:{answer_id} lists the
// ids of an answer's citations in order (every tenant's); idem:{tenant}:{key} holds the id a tenant's
// Idempotency-Key created; the outbox is the list outbox of JSON rows {"topic", "key", "payload"} a
// relay publishes later. A new citation is pending until the verifier sets verified or broken.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

struct Citation {
  std::string id;
  std::string tenant;
  std::string answer_id;
  std::string document_id;
  long version = 0;
  long start = 0;
  long end = 0;
  std::string quote;
  std::string status;
  std::string reason;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The citation as the API answers it: every field.
inline nlohmann::json toJson(const Citation& c) {
  return nlohmann::json{{"id", c.id},       {"tenant", c.tenant}, {"answer_id", c.answer_id}, {"document_id", c.document_id},
                        {"version", c.version}, {"start", c.start}, {"end", c.end},             {"quote", c.quote},
                        {"status", c.status}, {"reason", c.reason}};
}

// The citation, whatever tenant it belongs to, or none.
inline std::optional<Citation> get(const std::string& citation_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("citation:" + citation_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  return Citation{text("id"),    text("tenant"),   text("answer_id"), text("document_id"), number("version"),
                  number("start"), number("end"), text("quote"),     text("status"),      text("reason")};
}

// A new pending citation of the tenant (answer, document, version, span, quote of c); returns the row.
inline Citation create(const std::string& tenant, const Citation& c) {
  const std::string id = "c-" + std::to_string(redis().incr("citation:seq"));
  const std::unordered_map<std::string, std::string> fields = {
      {"id", id},       {"tenant", tenant},       {"answer_id", c.answer_id},          {"document_id", c.document_id},
      {"version", std::to_string(c.version)},     {"start", std::to_string(c.start)}, {"end", std::to_string(c.end)},
      {"quote", c.quote}, {"status", "pending"}, {"reason", ""}};
  redis().hset("citation:" + id, fields.begin(), fields.end());
  redis().rpush("answer:" + c.answer_id, id);
  return *get(id);
}

// Every citation recorded under the answer id, in order, whatever tenant it belongs to.
inline std::vector<Citation> forAnswer(const std::string& answer_id) {
  std::vector<std::string> ids;
  redis().lrange("answer:" + answer_id, 0, -1, std::back_inserter(ids));
  std::vector<Citation> out;
  for (const std::string& id : ids) {
    if (auto c = get(id)) out.push_back(*c);
  }
  return out;
}

// Record what the verifier found for citation result.id: status, reason, version, start, end.
inline void setVerification(const Citation& result) {
  const std::unordered_map<std::string, std::string> fields = {
      {"status", result.status},
      {"reason", result.reason},
      {"version", std::to_string(result.version)},
      {"start", std::to_string(result.start)},
      {"end", std::to_string(result.end)}};
  redis().hset("citation:" + result.id, fields.begin(), fields.end());
}

// The citation the tenant's Idempotency-Key created, or none.
inline std::optional<Citation> byKey(const std::string& tenant, const std::string& key) {
  const auto id = redis().get("idem:" + tenant + ":" + key);
  if (!id) return std::nullopt;
  return get(*id);
}

// Remember that the tenant's Idempotency-Key created citation_id, for its replays.
inline void bindKey(const std::string& tenant, const std::string& key, const std::string& citation_id) {
  redis().set("idem:" + tenant + ":" + key, citation_id);
}

// Queue a record for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('citations', 'Documents')]: `package citations

import redis.clients.jedis.JedisPooled

/**
 * The document versions store (provided): a document is a sequence of immutable versions, each the
 * string doc:{document_id}:v{n}, and doc:{document_id}:latest holds the newest version number.
 * Offsets into a text count characters. addVersion is the document store's writer; the citation
 * service reads.
 */
object Documents {
  val jedis = new JedisPooled("redis", 6379)

  /** Store text as the next version of the document; returns its number. */
  def addVersion(documentId: String, text: String): Long = {
    val n = jedis.incr(s"doc:$documentId:latest")
    jedis.set(s"doc:$documentId:v$n", text)
    n
  }

  /** The text of that version, if the document has it. */
  def getVersion(documentId: String, version: Long): Option[String] = Option(jedis.get(s"doc:$documentId:v$version"))

  /** The text of the document's newest version, if it has one. */
  def latest(documentId: String): Option[String] =
    Option(jedis.get(s"doc:$documentId:latest")).flatMap(n => getVersion(documentId, n.toLong))
}
`,
  [scalaPath('citations', 'Store')]: `package citations

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The citation store (provided), in Redis: a citation is the hash citation:{id} with id, tenant,
 * answer_id, document_id, version, start, end, quote, status and reason; answer:{answer_id} lists the
 * ids of an answer's citations in order (every tenant's); idem:{tenant}:{key} holds the id a tenant's
 * Idempotency-Key created; the outbox is the list outbox of JSON rows {"topic", "key", "payload"} a
 * relay publishes later. A new citation is pending until the verifier sets verified or broken.
 */
object Store {
  final case class Citation(
      id: String,
      tenant: String,
      answerId: String,
      documentId: String,
      version: Long,
      start: Long,
      end: Long,
      quote: String,
      status: String,
      reason: String
  ) {

    /** The citation as the API answers it: every field. */
    def toJson: JsObject = JsObject(
      "id" -> JsString(id),
      "tenant" -> JsString(tenant),
      "answer_id" -> JsString(answerId),
      "document_id" -> JsString(documentId),
      "version" -> JsNumber(version),
      "start" -> JsNumber(start),
      "end" -> JsNumber(end),
      "quote" -> JsString(quote),
      "status" -> JsString(status),
      "reason" -> JsString(reason)
    )
  }

  val jedis = new JedisPooled("redis", 6379)

  /** The citation, whatever tenant it belongs to. */
  def get(citationId: String): Option[Citation] = {
    val raw = jedis.hgetAll(s"citation:$citationId").asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      def number(name: String): Long = raw.get(name).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)
      Some(Citation(text("id"), text("tenant"), text("answer_id"), text("document_id"), number("version"), number("start"), number("end"), text("quote"), text("status"), text("reason")))
    }
  }

  /** A new pending citation of the tenant (answer, document, version, span, quote of c); returns the row. */
  def create(tenant: String, c: Citation): Citation = {
    val id = s"c-\${jedis.incr("citation:seq")}"
    val fields = Map(
      "id" -> id, "tenant" -> tenant, "answer_id" -> c.answerId, "document_id" -> c.documentId,
      "version" -> c.version.toString, "start" -> c.start.toString, "end" -> c.end.toString,
      "quote" -> c.quote, "status" -> "pending", "reason" -> ""
    )
    jedis.hset(s"citation:$id", fields.asJava)
    jedis.rpush(s"answer:\${c.answerId}", id)
    get(id).get
  }

  /** Every citation recorded under the answer id, in order, whatever tenant it belongs to. */
  def forAnswer(answerId: String): Seq[Citation] =
    jedis.lrange(s"answer:$answerId", 0, -1).asScala.toSeq.flatMap(get)

  /** Record what the verifier found for citation result.id: status, reason, version, start, end. */
  def setVerification(result: Citation): Unit = {
    val fields = Map(
      "status" -> result.status, "reason" -> result.reason,
      "version" -> result.version.toString, "start" -> result.start.toString, "end" -> result.end.toString
    )
    jedis.hset(s"citation:\${result.id}", fields.asJava)
  }

  /** The citation the tenant's Idempotency-Key created. */
  def byKey(tenant: String, key: String): Option[Citation] = Option(jedis.get(s"idem:$tenant:$key")).flatMap(get)

  /** Remember that the tenant's Idempotency-Key created citationId, for its replays. */
  def bindKey(tenant: String, key: String, citationId: String): Unit = jedis.set(s"idem:$tenant:$key", citationId)

  /** Queue a record for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
