/**
 * Hand-written support modules the form-service steps import but no step builds: the form store
 * (`forms.store`). It is Redis, the course's stand-in for formd's database: forms with an owner and
 * a published and a draft schema version, submissions ordered per form, the submission an
 * Idempotency-Key created, the outbox a rejected produce falls back to, and the export audit log.
 * The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'forms/__init__.py': '',
  'forms/store.py': `"""
The form store (provided), in Redis. form:{id} holds the form's owner and the numbers of its
published and draft schema versions; form:{id}:schema:v{n} maps every field of version n to its
max_bytes. submission:{id} is one submission (submission_id, form_id, seq, values as JSON);
form:{id}:submissions orders a form's submission ids by seq; form:{id}:key:{key} is the submission
an Idempotency-Key created. outbox and audit are lists of JSON rows. A submission comes back as a
dict with submission_id, form_id, seq and values (field name to text).
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def define_form(form_id: str, owner: str, published: dict, draft: dict) -> None:
    """A form owned by owner: version 1 (published, field to max_bytes) is live, version 2 (draft) is being edited."""
    r.hset(f"form:{form_id}:schema:v1", mapping=published)
    r.hset(f"form:{form_id}:schema:v2", mapping=draft)
    r.hset(f"form:{form_id}", mapping={"owner": owner, "published": 1, "draft": 2})


def _schema(form_id: str, which: str) -> dict | None:
    version = r.hget(f"form:{form_id}", which)
    if version is None:
        return None
    return {name: int(limit) for name, limit in r.hgetall(f"form:{form_id}:schema:v{version}").items()}


def published_schema(form_id: str) -> dict | None:
    """The live version's fields and their max_bytes, or None for an unknown form."""
    return _schema(form_id, "published")


def draft_schema(form_id: str) -> dict | None:
    """The version the author is still editing: its fields and their max_bytes, or None for an unknown form."""
    return _schema(form_id, "draft")


def owner_of(form_id: str) -> str | None:
    """The user who owns the form, or None for an unknown form."""
    return r.hget(f"form:{form_id}", "owner")


def insert_submission(form_id: str, values: dict) -> str:
    """Store values (field name to text, as given) as the form's newest submission; returns its id."""
    seq = r.incr("submission:seq")
    submission_id = f"sub-{seq}"
    r.hset(
        f"submission:{submission_id}",
        mapping={"submission_id": submission_id, "form_id": form_id, "seq": seq, "values": json.dumps(values)},
    )
    r.zadd(f"form:{form_id}:submissions", {submission_id: seq})
    return submission_id


def load_submission(submission_id: str) -> dict | None:
    """The submission, or None."""
    raw = r.hgetall(f"submission:{submission_id}")
    if not raw:
        return None
    return {"submission_id": raw["submission_id"], "form_id": raw["form_id"], "seq": int(raw["seq"]), "values": json.loads(raw["values"])}


def submission_for_key(form_id: str, key: str) -> str | None:
    """The submission the (form, Idempotency-Key) pair created, if any."""
    return r.get(f"form:{form_id}:key:{key}")


def record_key(form_id: str, key: str, submission_id: str) -> None:
    """Remember that the (form, Idempotency-Key) pair created submission_id."""
    r.set(f"form:{form_id}:key:{key}", submission_id)


def page_by_offset(form_id: str, offset: int, limit: int) -> list[dict]:
    """Newest first: the submissions at positions offset to offset + limit - 1."""
    ids = r.zrevrange(f"form:{form_id}:submissions", offset, offset + limit - 1)
    return [load_submission(i) for i in ids]


def page_before(form_id: str, cursor: int, limit: int) -> list[dict]:
    """Newest first: up to limit submissions whose seq is below cursor (0: from the newest)."""
    top = f"({cursor}" if cursor else "+inf"
    ids = r.zrevrangebyscore(f"form:{form_id}:submissions", top, "-inf", start=0, num=limit)
    return [load_submission(i) for i in ids]


def outbox_insert(topic: str, key: str, payload: dict) -> None:
    """A record the relay publishes once the broker takes it again."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def record_audit(actor: str, form_id: str, file: str) -> None:
    """Who exported which form's submissions into which file."""
    r.rpush("audit", json.dumps({"actor": actor, "form_id": form_id, "file": file}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'forms/store.ts': `/**
 * The form store (provided), in Redis. form:{id} holds the form's owner and the numbers of its
 * published and draft schema versions; form:{id}:schema:v{n} maps every field of version n to its
 * max_bytes. submission:{id} is one submission (submission_id, form_id, seq, values as JSON);
 * form:{id}:submissions orders a form's submission ids by seq; form:{id}:key:{key} is the
 * submission an Idempotency-Key created. outbox and audit are lists of JSON rows.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Field name to max_bytes. */
export type Schema = Record<string, number>;

export interface Submission {
  submission_id: string;
  form_id: string;
  seq: number;
  values: Record<string, string>;
}

/** A form owned by owner: version 1 (published) is live, version 2 (draft) is being edited. */
export async function defineForm(formId: string, owner: string, published: Schema, draft: Schema): Promise<void> {
  await redis.hset(\`form:\${formId}:schema:v1\`, published);
  await redis.hset(\`form:\${formId}:schema:v2\`, draft);
  await redis.hset(\`form:\${formId}\`, {owner, published: '1', draft: '2'});
}

async function schema(formId: string, which: string): Promise<Schema | null> {
  const version = await redis.hget(\`form:\${formId}\`, which);
  if (version === null) return null;
  const raw = await redis.hgetall(\`form:\${formId}:schema:v\${version}\`);
  return Object.fromEntries(Object.entries(raw).map(([name, limit]) => [name, Number(limit)]));
}

/** The live version's fields and their max_bytes, or null for an unknown form. */
export const publishedSchema = (formId: string): Promise<Schema | null> => schema(formId, 'published');

/** The version the author is still editing: its fields and their max_bytes, or null for an unknown form. */
export const draftSchema = (formId: string): Promise<Schema | null> => schema(formId, 'draft');

/** The user who owns the form, or null for an unknown form. */
export const ownerOf = (formId: string): Promise<string | null> => redis.hget(\`form:\${formId}\`, 'owner');

/** Store values (field name to text, as given) as the form's newest submission; returns its id. */
export async function insertSubmission(formId: string, values: Record<string, string>): Promise<string> {
  const seq = await redis.incr('submission:seq');
  const submissionId = \`sub-\${seq}\`;
  await redis.hset(\`submission:\${submissionId}\`, {submission_id: submissionId, form_id: formId, seq: String(seq), values: JSON.stringify(values)});
  await redis.zadd(\`form:\${formId}:submissions\`, seq, submissionId);
  return submissionId;
}

/** The submission, or null. */
export async function loadSubmission(submissionId: string): Promise<Submission | null> {
  const raw = await redis.hgetall(\`submission:\${submissionId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {submission_id: raw.submission_id, form_id: raw.form_id, seq: Number(raw.seq), values: JSON.parse(raw.values) as Record<string, string>};
}

/** The submission the (form, Idempotency-Key) pair created, if any. */
export const submissionForKey = (formId: string, key: string): Promise<string | null> => redis.get(\`form:\${formId}:key:\${key}\`);

/** Remember that the (form, Idempotency-Key) pair created submissionId. */
export async function recordKey(formId: string, key: string, submissionId: string): Promise<void> {
  await redis.set(\`form:\${formId}:key:\${key}\`, submissionId);
}

async function loadAll(ids: string[]): Promise<Submission[]> {
  const rows: Submission[] = [];
  for (const id of ids) {
    const row = await loadSubmission(id);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Newest first: the submissions at positions offset to offset + limit - 1. */
export async function pageByOffset(formId: string, offset: number, limit: number): Promise<Submission[]> {
  return loadAll(await redis.zrevrange(\`form:\${formId}:submissions\`, offset, offset + limit - 1));
}

/** Newest first: up to limit submissions whose seq is below cursor (0: from the newest). */
export async function pageBefore(formId: string, cursor: number, limit: number): Promise<Submission[]> {
  const top = cursor ? \`(\${cursor}\` : '+inf';
  return loadAll(await redis.zrevrangebyscore(\`form:\${formId}:submissions\`, top, '-inf', 'LIMIT', 0, limit));
}

/** A record the relay publishes once the broker takes it again. */
export async function outboxInsert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

/** Who exported which form's submissions into which file. */
export async function recordAudit(actor: string, formId: string, file: string): Promise<void> {
  await redis.rpush('audit', JSON.stringify({actor, form_id: formId, file}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'forms/store/store.go': `// Package store is the form store (provided), in Redis. form:{id} holds the form's owner and the
// numbers of its published and draft schema versions; form:{id}:schema:v{n} maps every field of
// version n to its max_bytes. submission:{id} is one submission (submission_id, form_id, seq,
// values as JSON); form:{id}:submissions orders a form's submission ids by seq;
// form:{id}:key:{key} is the submission an Idempotency-Key created. outbox and audit are lists of
// JSON rows.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Schema maps a field name to its max_bytes.
type Schema = map[string]int

// Submission is one stored submission.
type Submission struct {
	SubmissionID string            \`json:"submission_id"\`
	FormID       string            \`json:"form_id"\`
	Seq          int64             \`json:"seq"\`
	Values       map[string]string \`json:"values"\`
}

func fieldsOf(s Schema) map[string]any {
	out := map[string]any{}
	for name, limit := range s {
		out[name] = limit
	}
	return out
}

// DefineForm makes a form owned by owner: version 1 (published) is live, version 2 (draft) is being edited.
func DefineForm(ctx context.Context, formID, owner string, published, draft Schema) error {
	if err := rdb.HSet(ctx, "form:"+formID+":schema:v1", fieldsOf(published)).Err(); err != nil {
		return err
	}
	if err := rdb.HSet(ctx, "form:"+formID+":schema:v2", fieldsOf(draft)).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, "form:"+formID, map[string]any{"owner": owner, "published": "1", "draft": "2"}).Err()
}

func schema(ctx context.Context, formID, which string) Schema {
	version, err := rdb.HGet(ctx, "form:"+formID, which).Result()
	if err != nil {
		return nil
	}
	out := Schema{}
	for name, limit := range rdb.HGetAll(ctx, "form:"+formID+":schema:v"+version).Val() {
		out[name], _ = strconv.Atoi(limit)
	}
	return out
}

// PublishedSchema is the live version's fields and their max_bytes, or nil for an unknown form.
func PublishedSchema(ctx context.Context, formID string) Schema { return schema(ctx, formID, "published") }

// DraftSchema is the version the author is still editing, or nil for an unknown form.
func DraftSchema(ctx context.Context, formID string) Schema { return schema(ctx, formID, "draft") }

// OwnerOf is the user who owns the form, or "" for an unknown form.
func OwnerOf(ctx context.Context, formID string) string {
	return rdb.HGet(ctx, "form:"+formID, "owner").Val()
}

// InsertSubmission stores values (field name to text, as given) as the form's newest submission and returns its id.
func InsertSubmission(ctx context.Context, formID string, values map[string]string) (string, error) {
	seq, err := rdb.Incr(ctx, "submission:seq").Result()
	if err != nil {
		return "", err
	}
	id := fmt.Sprintf("sub-%d", seq)
	raw, _ := json.Marshal(values)
	if err := rdb.HSet(ctx, "submission:"+id, map[string]any{"submission_id": id, "form_id": formID, "seq": seq, "values": string(raw)}).Err(); err != nil {
		return "", err
	}
	return id, rdb.ZAdd(ctx, "form:"+formID+":submissions", redis.Z{Score: float64(seq), Member: id}).Err()
}

// LoadSubmission is the submission, or nil.
func LoadSubmission(ctx context.Context, submissionID string) *Submission {
	raw := rdb.HGetAll(ctx, "submission:"+submissionID).Val()
	if len(raw) == 0 {
		return nil
	}
	seq, _ := strconv.ParseInt(raw["seq"], 10, 64)
	s := &Submission{SubmissionID: raw["submission_id"], FormID: raw["form_id"], Seq: seq, Values: map[string]string{}}
	json.Unmarshal([]byte(raw["values"]), &s.Values)
	return s
}

// SubmissionForKey is the submission the (form, Idempotency-Key) pair created, or "".
func SubmissionForKey(ctx context.Context, formID, key string) string {
	return rdb.Get(ctx, "form:"+formID+":key:"+key).Val()
}

// RecordKey remembers that the (form, Idempotency-Key) pair created submissionID.
func RecordKey(ctx context.Context, formID, key, submissionID string) error {
	return rdb.Set(ctx, "form:"+formID+":key:"+key, submissionID, 0).Err()
}

func loadAll(ctx context.Context, ids []string) []Submission {
	rows := []Submission{}
	for _, id := range ids {
		if s := LoadSubmission(ctx, id); s != nil {
			rows = append(rows, *s)
		}
	}
	return rows
}

// PageByOffset is, newest first, the submissions at positions offset to offset+limit-1.
func PageByOffset(ctx context.Context, formID string, offset, limit int) []Submission {
	ids := rdb.ZRevRange(ctx, "form:"+formID+":submissions", int64(offset), int64(offset+limit-1)).Val()
	return loadAll(ctx, ids)
}

// PageBefore is, newest first, up to limit submissions whose seq is below cursor (0: from the newest).
func PageBefore(ctx context.Context, formID string, cursor int64, limit int) []Submission {
	top := "+inf"
	if cursor > 0 {
		top = fmt.Sprintf("(%d", cursor)
	}
	ids := rdb.ZRevRangeByScore(ctx, "form:"+formID+":submissions", &redis.ZRangeBy{Max: top, Min: "-inf", Count: int64(limit)}).Val()
	return loadAll(ctx, ids)
}

// OutboxInsert queues a record the relay publishes once the broker takes it again.
func OutboxInsert(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", string(raw)).Err()
}

// RecordAudit records who exported which form's submissions into which file.
func RecordAudit(ctx context.Context, actor, formID, file string) error {
	raw, _ := json.Marshal(map[string]string{"actor": actor, "form_id": formID, "file": file})
	return rdb.RPush(ctx, "audit", string(raw)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'forms/store.h': `// The form store (provided), in Redis. form:{id} holds the form's owner and the numbers of its
// published and draft schema versions; form:{id}:schema:v{n} maps every field of version n to its
// max_bytes. submission:{id} is one submission (submission_id, form_id, seq, values as JSON);
// form:{id}:submissions orders a form's submission ids by seq; form:{id}:key:{key} is the
// submission an Idempotency-Key created. outbox and audit are lists of JSON rows.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

// Field name to max_bytes.
using Schema = std::map<std::string, long>;

struct Submission {
  std::string submission_id;
  std::string form_id;
  long long seq = 0;
  std::map<std::string, std::string> values;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// A form owned by owner: version 1 (published) is live, version 2 (draft) is being edited.
inline void defineForm(const std::string& form_id, const std::string& owner, const Schema& published, const Schema& draft) {
  for (const auto& [version, fields] : {std::pair<std::string, Schema>{"1", published}, {"2", draft}}) {
    std::map<std::string, std::string> mapping;
    for (const auto& [name, limit] : fields) mapping[name] = std::to_string(limit);
    redis().hset("form:" + form_id + ":schema:v" + version, mapping.begin(), mapping.end());
  }
  redis().hset("form:" + form_id, {std::make_pair("owner", owner), std::make_pair("published", std::string("1")), std::make_pair("draft", std::string("2"))});
}

inline std::optional<Schema> schemaOf(const std::string& form_id, const std::string& which) {
  const auto version = redis().hget("form:" + form_id, which);
  if (!version) return std::nullopt;
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("form:" + form_id + ":schema:v" + *version, std::inserter(raw, raw.begin()));
  Schema out;
  for (const auto& [name, limit] : raw) out[name] = std::stol(limit);
  return out;
}

// The live version's fields and their max_bytes, or none for an unknown form.
inline std::optional<Schema> publishedSchema(const std::string& form_id) { return schemaOf(form_id, "published"); }

// The version the author is still editing, or none for an unknown form.
inline std::optional<Schema> draftSchema(const std::string& form_id) { return schemaOf(form_id, "draft"); }

// The user who owns the form, or none for an unknown form.
inline std::optional<std::string> ownerOf(const std::string& form_id) {
  const auto owner = redis().hget("form:" + form_id, "owner");
  if (!owner) return std::nullopt;
  return std::string(*owner);
}

// Store values (field name to text, as given) as the form's newest submission; returns its id.
inline std::string insertSubmission(const std::string& form_id, const std::map<std::string, std::string>& values) {
  const long long seq = redis().incr("submission:seq");
  const std::string id = "sub-" + std::to_string(seq);
  redis().hset("submission:" + id, {std::make_pair("submission_id", id), std::make_pair("form_id", form_id),
                                    std::make_pair("seq", std::to_string(seq)), std::make_pair("values", nlohmann::json(values).dump())});
  redis().zadd("form:" + form_id + ":submissions", id, static_cast<double>(seq));
  return id;
}

// The submission, or none.
inline std::optional<Submission> loadSubmission(const std::string& submission_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("submission:" + submission_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Submission s;
  s.submission_id = raw["submission_id"];
  s.form_id = raw["form_id"];
  s.seq = std::stoll(raw["seq"]);
  s.values = nlohmann::json::parse(raw["values"]).get<std::map<std::string, std::string>>();
  return s;
}

// The submission the (form, Idempotency-Key) pair created, if any.
inline std::optional<std::string> submissionForKey(const std::string& form_id, const std::string& key) {
  const auto id = redis().get("form:" + form_id + ":key:" + key);
  if (!id) return std::nullopt;
  return std::string(*id);
}

// Remember that the (form, Idempotency-Key) pair created submission_id.
inline void recordKey(const std::string& form_id, const std::string& key, const std::string& submission_id) {
  redis().set("form:" + form_id + ":key:" + key, submission_id);
}

inline std::vector<Submission> loadAll(const std::vector<std::string>& ids) {
  std::vector<Submission> rows;
  for (const auto& id : ids) {
    if (auto s = loadSubmission(id)) rows.push_back(*s);
  }
  return rows;
}

// Newest first: the submissions at positions offset to offset + limit - 1.
inline std::vector<Submission> pageByOffset(const std::string& form_id, long long offset, long long limit) {
  std::vector<std::string> ids;
  redis().zrevrange("form:" + form_id + ":submissions", offset, offset + limit - 1, std::back_inserter(ids));
  return loadAll(ids);
}

// Newest first: up to limit submissions whose seq is below cursor (0: from the newest).
inline std::vector<Submission> pageBefore(const std::string& form_id, long long cursor, long long limit) {
  std::vector<std::string> ids;
  const sw::redis::LimitOptions page{0, limit};
  if (cursor > 0) {
    redis().zrevrangebyscore("form:" + form_id + ":submissions",
                             sw::redis::RightBoundedInterval<double>(static_cast<double>(cursor), sw::redis::BoundType::RIGHT_OPEN), page,
                             std::back_inserter(ids));
  } else {
    redis().zrevrangebyscore("form:" + form_id + ":submissions", sw::redis::UnboundedInterval<double>{}, page, std::back_inserter(ids));
  }
  return loadAll(ids);
}

// A record the relay publishes once the broker takes it again.
inline void outboxInsert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Who exported which form's submissions into which file.
inline void recordAudit(const std::string& actor, const std::string& form_id, const std::string& file) {
  redis().rpush("audit", nlohmann::json{{"actor", actor}, {"form_id", form_id}, {"file", file}}.dump());
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('forms', 'Store')]: `package forms

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The form store (provided), in Redis. form:{id} holds the form's owner and the numbers of its
 * published and draft schema versions; form:{id}:schema:v{n} maps every field of version n to its
 * max_bytes. submission:{id} is one submission (submission_id, form_id, seq, values as JSON);
 * form:{id}:submissions orders a form's submission ids by seq; form:{id}:key:{key} is the
 * submission an Idempotency-Key created. outbox and audit are lists of JSON rows.
 */
object Store {
  /** Field name to max_bytes. */
  type Schema = Map[String, Int]

  final case class Submission(submissionId: String, formId: String, seq: Long, values: Map[String, String])

  val jedis = new JedisPooled("redis", 6379)

  /** A form owned by owner: version 1 (published) is live, version 2 (draft) is being edited. */
  def defineForm(formId: String, owner: String, published: Schema, draft: Schema): Unit = {
    jedis.hset(s"form:$formId:schema:v1", published.map { case (k, v) => k -> v.toString }.asJava)
    jedis.hset(s"form:$formId:schema:v2", draft.map { case (k, v) => k -> v.toString }.asJava)
    jedis.hset(s"form:$formId", Map("owner" -> owner, "published" -> "1", "draft" -> "2").asJava)
  }

  private def schemaOf(formId: String, which: String): Option[Schema] =
    Option(jedis.hget(s"form:$formId", which)).map { version =>
      jedis.hgetAll(s"form:$formId:schema:v$version").asScala.toMap.map { case (k, v) => k -> v.toInt }
    }

  /** The live version's fields and their max_bytes, or None for an unknown form. */
  def publishedSchema(formId: String): Option[Schema] = schemaOf(formId, "published")

  /** The version the author is still editing, or None for an unknown form. */
  def draftSchema(formId: String): Option[Schema] = schemaOf(formId, "draft")

  /** The user who owns the form, or None for an unknown form. */
  def ownerOf(formId: String): Option[String] = Option(jedis.hget(s"form:$formId", "owner"))

  /** Store values (field name to text, as given) as the form's newest submission; returns its id. */
  def insertSubmission(formId: String, values: Map[String, String]): String = {
    val seq = jedis.incr("submission:seq")
    val id = s"sub-$seq"
    jedis.hset(s"submission:$id", Map("submission_id" -> id, "form_id" -> formId, "seq" -> seq.toString, "values" -> values.toJson.compactPrint).asJava)
    jedis.zadd(s"form:$formId:submissions", seq.toDouble, id)
    id
  }

  /** The submission, if it exists. */
  def loadSubmission(submissionId: String): Option[Submission] = {
    val raw = jedis.hgetAll(s"submission:$submissionId").asScala.toMap
    if (raw.isEmpty) None
    else Some(Submission(raw("submission_id"), raw("form_id"), raw("seq").toLong, raw("values").parseJson.convertTo[Map[String, String]]))
  }

  /** The submission the (form, Idempotency-Key) pair created, if any. */
  def submissionForKey(formId: String, key: String): Option[String] = Option(jedis.get(s"form:$formId:key:$key"))

  /** Remember that the (form, Idempotency-Key) pair created submissionId. */
  def recordKey(formId: String, key: String, submissionId: String): Unit = jedis.set(s"form:$formId:key:$key", submissionId)

  /** Newest first: the submissions at positions offset to offset + limit - 1. */
  def pageByOffset(formId: String, offset: Int, limit: Int): Seq[Submission] =
    jedis.zrevrange(s"form:$formId:submissions", offset.toLong, (offset + limit - 1).toLong).asScala.toSeq.flatMap(loadSubmission)

  /** Newest first: up to limit submissions whose seq is below cursor (0: from the newest). */
  def pageBefore(formId: String, cursor: Long, limit: Int): Seq[Submission] = {
    val top = if (cursor > 0) s"($cursor" else "+inf"
    jedis.zrevrangeByScore(s"form:$formId:submissions", top, "-inf", 0, limit).asScala.toSeq.flatMap(loadSubmission)
  }

  /** A record the relay publishes once the broker takes it again. */
  def outboxInsert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Who exported which form's submissions into which file. */
  def recordAudit(actor: String, formId: String, file: String): Unit =
    jedis.rpush("audit", JsObject("actor" -> JsString(actor), "form_id" -> JsString(formId), "file" -> JsString(file)).compactPrint)
}
`,
};
