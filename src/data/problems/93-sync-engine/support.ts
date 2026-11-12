/**
 * Hand-written support modules the sync-engine steps import but no step builds: the `docsync`
 * package. `docsync.store` is the document store (each document's head and kept revisions in Redis
 * hashes, the server-wide revision counter, the change log a pull reads, kept conflicts, the
 * outbox). `docsync.revisions` is step 2's `apply_change` as the later steps use it: one Lua
 * script that applies a change only against the revision the device edited. The five languages
 * keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

const STORE_DOC = `The document store (provided): doc:{doc_id} is a document's head, a hash with doc_id,
revision, content_hash, body and device (the device that wrote it); doc:{doc_id}:r{n} keeps the
content_hash and body of revision n, so a merge can read the base a device edited (revision 0 is the
empty document). rev:seq is the server-wide revision counter, changes a sorted set of doc ids scored
by the revision that last wrote them (the change log a pull reads), conflict:{doc_id} the device's
edit a failed merge kept beside the head, outbox (a list) the events the broker did not take.`;

const REVISIONS_DOC = `apply_change (provided; step 2 builds the same function): one Lua script compares the document's
revision with the base the device edited and, when they match, takes the next revision from
rev:seq, writes the head and the kept revision, and scores the doc in the change log. A body whose
hash equals the head's is "unchanged" (no new revision); a stale base is a "conflict" (nothing is
written). The outcome is the status and a revision: the new one, or the head's when nothing was
written.`;

const APPLY_LUA = `local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if redis.call('HGET', KEYS[1], 'content_hash') == ARGV[3] then return {2, current} end
if current ~= tonumber(ARGV[2]) then return {0, current} end
local revision = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'doc_id', ARGV[1], 'revision', tostring(revision), 'content_hash', ARGV[3], 'body', ARGV[4], 'device', ARGV[5])
redis.call('HSET', KEYS[1] .. ':r' .. revision, 'content_hash', ARGV[3], 'body', ARGV[4])
redis.call('ZADD', KEYS[3], revision, ARGV[1])
return {1, revision}`;

const comment = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');

export const supportModules: Record<string, string> = {
  'docsync/__init__.py': '',
  'docsync/store.py': `"""
${STORE_DOC}
"""
import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

REVISION_KEY = "rev:seq"
CHANGES_KEY = "changes"
OUTBOX_KEY = "outbox"


def doc_key(doc_id: str) -> str:
    return f"doc:{doc_id}"


def history_key(doc_id: str, revision: int) -> str:
    return f"doc:{doc_id}:r{revision}"


def content_hash(body: str) -> str:
    """The SHA-256 of the body's UTF-8 bytes as 64 lowercase hex characters."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def head(doc_id: str) -> dict | None:
    """The document's head (doc_id, revision, content_hash, body, device), or None when it was never written."""
    raw = r.hgetall(doc_key(doc_id))
    if not raw:
        return None
    return {
        "doc_id": raw["doc_id"],
        "revision": int(raw["revision"]),
        "content_hash": raw["content_hash"],
        "body": raw["body"],
        "device": raw.get("device", ""),
    }


def body_at(doc_id: str, revision: int) -> str | None:
    """The body of revision n ("" for revision 0), or None when that revision is not kept."""
    if revision == 0:
        return ""
    return r.hget(history_key(doc_id, revision), "body")


def overwrite(doc_id: str, content_hash: str, body: str, device: str) -> int:
    """The bulk importer's writer: the body becomes the document's next revision, whatever revision the writer last saw."""
    revision = r.incr(REVISION_KEY)
    r.hset(doc_key(doc_id), mapping={"doc_id": doc_id, "revision": revision, "content_hash": content_hash, "body": body, "device": device})
    r.hset(history_key(doc_id, revision), mapping={"content_hash": content_hash, "body": body})
    r.zadd(CHANGES_KEY, {doc_id: revision})
    return revision


def mark_conflicted(doc_id: str, device: str, base_revision: int, body: str) -> None:
    """Keep the device's edit (and the base it edited) beside the head, which stays as it is."""
    r.hset(
        f"conflict:{doc_id}",
        mapping={"doc_id": doc_id, "device": device, "base_revision": base_revision, "body": body, "content_hash": content_hash(body)},
    )


def conflict_of(doc_id: str) -> dict | None:
    """The edit kept for the document by a failed merge, or None."""
    raw = r.hgetall(f"conflict:{doc_id}")
    if not raw:
        return None
    return {**raw, "base_revision": int(raw["base_revision"])}


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Queue an event the broker did not take; a relay publishes the row later."""
    r.rpush(OUTBOX_KEY, json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'docsync/revisions.py': `"""
${REVISIONS_DOC}
"""
from docsync import store

APPLY_LUA = """
${APPLY_LUA}
"""
_apply = store.r.register_script(APPLY_LUA)

STATUSES = ("conflict", "applied", "unchanged")


def apply_change(doc_id: str, base_revision: int, content_hash: str, body: str, device: str) -> dict:
    """{"status": "applied" | "unchanged" | "conflict", "revision": int}."""
    code, revision = _apply(keys=[store.doc_key(doc_id), store.REVISION_KEY, store.CHANGES_KEY], args=[doc_id, base_revision, content_hash, body, device])
    return {"status": STATUSES[int(code)], "revision": int(revision)}
`,
};

export const supportModulesTs: Record<string, string> = {
  'docsync/store.ts': `/**
${comment(STORE_DOC, ' * ')}
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const REVISION_KEY = 'rev:seq';
export const CHANGES_KEY = 'changes';
export const OUTBOX_KEY = 'outbox';

export interface Doc {
  doc_id: string;
  revision: number;
  content_hash: string;
  body: string;
  device: string;
}

/** What an apply or a merge did: the status and the revision it left the document at. */
export interface Outcome {
  status: string;
  revision: number;
}

export interface Conflict {
  doc_id: string;
  device: string;
  base_revision: number;
  body: string;
  content_hash: string;
}

export const docKey = (docId: string): string => \`doc:\${docId}\`;
export const historyKey = (docId: string, revision: number): string => \`doc:\${docId}:r\${revision}\`;

/** The SHA-256 of the body's UTF-8 bytes as 64 lowercase hex characters. */
export const contentHash = (body: string): string => createHash('sha256').update(body).digest('hex');

/** The document's head, or null when it was never written. */
export async function head(docId: string): Promise<Doc | null> {
  const raw = await redis.hgetall(docKey(docId));
  if (Object.keys(raw).length === 0) return null;
  return {doc_id: raw.doc_id, revision: Number(raw.revision), content_hash: raw.content_hash, body: raw.body, device: raw.device ?? ''};
}

/** The body of revision n ('' for revision 0), or null when that revision is not kept. */
export async function bodyAt(docId: string, revision: number): Promise<string | null> {
  if (revision === 0) return '';
  return redis.hget(historyKey(docId, revision), 'body');
}

/** The bulk importer's writer: the body becomes the document's next revision, whatever revision the writer last saw. */
export async function overwrite(docId: string, hash: string, body: string, device: string): Promise<number> {
  const revision = await redis.incr(REVISION_KEY);
  await redis.hset(docKey(docId), {doc_id: docId, revision, content_hash: hash, body, device});
  await redis.hset(historyKey(docId, revision), {content_hash: hash, body});
  await redis.zadd(CHANGES_KEY, revision, docId);
  return revision;
}

/** Keep the device's edit (and the base it edited) beside the head, which stays as it is. */
export async function markConflicted(docId: string, device: string, baseRevision: number, body: string): Promise<void> {
  await redis.hset(\`conflict:\${docId}\`, {doc_id: docId, device, base_revision: baseRevision, body, content_hash: contentHash(body)});
}

/** The edit kept for the document by a failed merge, or null. */
export async function conflictOf(docId: string): Promise<Conflict | null> {
  const raw = await redis.hgetall(\`conflict:\${docId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {doc_id: raw.doc_id, device: raw.device, base_revision: Number(raw.base_revision), body: raw.body, content_hash: raw.content_hash};
}

/** Queue an event the broker did not take; a relay publishes the row later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({topic, key, payload}));
}
`,
  'docsync/revisions.ts': `/**
${comment(REVISIONS_DOC, ' * ')}
 */
import Redis from 'ioredis';

import {CHANGES_KEY, type Outcome, REVISION_KEY, docKey} from 'docsync/store';

export const APPLY_LUA = \`
${APPLY_LUA}
\`;

interface ApplyRedis extends Redis {
  applyChange(docKey: string, revisionKey: string, changesKey: string, ...args: (string | number)[]): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ApplyRedis;
redis.defineCommand('applyChange', {numberOfKeys: 3, lua: APPLY_LUA});

const STATUSES = ['conflict', 'applied', 'unchanged'];

export async function applyChange(docId: string, baseRevision: number, contentHash: string, body: string, device: string): Promise<Outcome> {
  const [code, revision] = await redis.applyChange(docKey(docId), REVISION_KEY, CHANGES_KEY, docId, baseRevision, contentHash, body, device);
  return {status: STATUSES[Number(code)], revision: Number(revision)};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'docsync/store/store.go': `// Package store is the document store.
//
${comment(STORE_DOC, '// ')}
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	RevisionKey = "rev:seq"
	ChangesKey  = "changes"
	OutboxKey   = "outbox"
)

// Doc is a document's head.
type Doc struct {
	DocID       string \`json:"doc_id"\`
	Revision    int64  \`json:"revision"\`
	ContentHash string \`json:"content_hash"\`
	Body        string \`json:"body"\`
	Device      string \`json:"device"\`
}

// Outcome is what an apply or a merge did: the status and the revision it left the document at.
type Outcome struct {
	Status   string \`json:"status"\`
	Revision int64  \`json:"revision"\`
}

// Conflict is the edit a failed merge kept beside the head.
type Conflict struct {
	DocID        string \`json:"doc_id"\`
	Device       string \`json:"device"\`
	BaseRevision int64  \`json:"base_revision"\`
	Body         string \`json:"body"\`
	ContentHash  string \`json:"content_hash"\`
}

func DocKey(docID string) string { return "doc:" + docID }

func HistoryKey(docID string, revision int64) string { return fmt.Sprintf("doc:%s:r%d", docID, revision) }

// ContentHash is the SHA-256 of the body's UTF-8 bytes as 64 lowercase hex characters.
func ContentHash(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// Head is the document's head, or nil when it was never written.
func Head(ctx context.Context, docID string) *Doc {
	raw := rdb.HGetAll(ctx, DocKey(docID)).Val()
	if len(raw) == 0 {
		return nil
	}
	revision, _ := strconv.ParseInt(raw["revision"], 10, 64)
	return &Doc{DocID: raw["doc_id"], Revision: revision, ContentHash: raw["content_hash"], Body: raw["body"], Device: raw["device"]}
}

// BodyAt is the body of revision n ("" for revision 0); ok is false when that revision is not kept.
func BodyAt(ctx context.Context, docID string, revision int64) (body string, ok bool) {
	if revision == 0 {
		return "", true
	}
	body, err := rdb.HGet(ctx, HistoryKey(docID, revision), "body").Result()
	return body, err == nil
}

// Overwrite is the bulk importer's writer: the body becomes the document's next revision, whatever
// revision the writer last saw.
func Overwrite(ctx context.Context, docID, contentHash, body, device string) (int64, error) {
	revision, err := rdb.Incr(ctx, RevisionKey).Result()
	if err != nil {
		return 0, err
	}
	rdb.HSet(ctx, DocKey(docID), map[string]any{"doc_id": docID, "revision": revision, "content_hash": contentHash, "body": body, "device": device})
	rdb.HSet(ctx, HistoryKey(docID, revision), map[string]any{"content_hash": contentHash, "body": body})
	rdb.ZAdd(ctx, ChangesKey, redis.Z{Score: float64(revision), Member: docID})
	return revision, nil
}

// MarkConflicted keeps the device's edit (and the base it edited) beside the head, which stays as it is.
func MarkConflicted(ctx context.Context, docID, device string, baseRevision int64, body string) {
	rdb.HSet(ctx, "conflict:"+docID, map[string]any{"doc_id": docID, "device": device, "base_revision": baseRevision, "body": body, "content_hash": ContentHash(body)})
}

// ConflictOf is the edit kept for the document by a failed merge, or nil.
func ConflictOf(ctx context.Context, docID string) *Conflict {
	raw := rdb.HGetAll(ctx, "conflict:"+docID).Val()
	if len(raw) == 0 {
		return nil
	}
	base, _ := strconv.ParseInt(raw["base_revision"], 10, 64)
	return &Conflict{DocID: raw["doc_id"], Device: raw["device"], BaseRevision: base, Body: raw["body"], ContentHash: raw["content_hash"]}
}

// InsertOutbox queues an event the broker did not take; a relay publishes the row later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, OutboxKey, row).Err()
}
`,
  'docsync/revisions/revisions.go': `// Package revisions is the atomic apply.
//
${comment(REVISIONS_DOC, '// ')}
package revisions

import (
	"context"

	"github.com/redis/go-redis/v9"

	"docsync/store"
)

const ApplyLua = \`
${APPLY_LUA}
\`

var (
	rdb         = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	applyScript = redis.NewScript(ApplyLua)
	statuses    = []string{"conflict", "applied", "unchanged"}
)

// ApplyChange applies the change only against the revision the device edited.
func ApplyChange(ctx context.Context, docID string, baseRevision int64, contentHash, body, device string) (store.Outcome, error) {
	keys := []string{store.DocKey(docID), store.RevisionKey, store.ChangesKey}
	reply, err := applyScript.Run(ctx, rdb, keys, docID, baseRevision, contentHash, body, device).Int64Slice()
	if err != nil {
		return store.Outcome{}, err
	}
	return store.Outcome{Status: statuses[reply[0]], Revision: reply[1]}, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'docsync/store.h': `${comment(STORE_DOC, '// ')}
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

namespace store {

// A document's head.
struct Doc {
  std::string doc_id;
  long long revision = 0;
  std::string content_hash;
  std::string body;
  std::string device;
};

// What an apply or a merge did: the status and the revision it left the document at.
struct Outcome {
  std::string status;
  long long revision = 0;
};

// The edit a failed merge kept beside the head.
struct Conflict {
  std::string doc_id;
  std::string device;
  long long base_revision = 0;
  std::string body;
  std::string content_hash;
};

inline const std::string kRevisionKey = "rev:seq";
inline const std::string kChangesKey = "changes";
inline const std::string kOutboxKey = "outbox";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string docKey(const std::string& doc_id) { return "doc:" + doc_id; }

inline std::string historyKey(const std::string& doc_id, long long revision) {
  return "doc:" + doc_id + ":r" + std::to_string(revision);
}

// The SHA-256 of the body's UTF-8 bytes as 64 lowercase hex characters.
inline std::string contentHash(const std::string& body) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(body.data()), body.size(), digest);
  static const char* kHex = "0123456789abcdef";
  std::string out;
  for (unsigned char b : digest) {
    out += kHex[b >> 4];
    out += kHex[b & 15];
  }
  return out;
}

inline std::string field(const std::unordered_map<std::string, std::string>& raw, const std::string& name) {
  const auto it = raw.find(name);
  return it == raw.end() ? std::string() : it->second;
}

// The document's head, or none when it was never written.
inline std::optional<Doc> head(const std::string& doc_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(docKey(doc_id));
  if (raw.empty()) return std::nullopt;
  return Doc{field(raw, "doc_id"), std::stoll(field(raw, "revision")), field(raw, "content_hash"), field(raw, "body"), field(raw, "device")};
}

// The body of revision n ("" for revision 0), or none when that revision is not kept.
inline std::optional<std::string> bodyAt(const std::string& doc_id, long long revision) {
  if (revision == 0) return std::string();
  const auto body = redis().hget(historyKey(doc_id, revision), "body");
  if (!body) return std::nullopt;
  return std::string(*body);
}

// The bulk importer's writer: the body becomes the document's next revision, whatever revision the
// writer last saw.
inline long long overwrite(const std::string& doc_id, const std::string& hash, const std::string& body, const std::string& device) {
  const long long revision = redis().incr(kRevisionKey);
  redis().hset(docKey(doc_id), {{"doc_id", doc_id}, {"revision", std::to_string(revision)}, {"content_hash", hash}, {"body", body}, {"device", device}});
  redis().hset(historyKey(doc_id, revision), {{"content_hash", hash}, {"body", body}});
  redis().zadd(kChangesKey, doc_id, static_cast<double>(revision));
  return revision;
}

// Keep the device's edit (and the base it edited) beside the head, which stays as it is.
inline void markConflicted(const std::string& doc_id, const std::string& device, long long base_revision, const std::string& body) {
  redis().hset("conflict:" + doc_id, {{"doc_id", doc_id}, {"device", device}, {"base_revision", std::to_string(base_revision)}, {"body", body}, {"content_hash", contentHash(body)}});
}

// The edit kept for the document by a failed merge, or none.
inline std::optional<Conflict> conflictOf(const std::string& doc_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("conflict:" + doc_id);
  if (raw.empty()) return std::nullopt;
  return Conflict{field(raw, "doc_id"), field(raw, "device"), std::stoll(field(raw, "base_revision")), field(raw, "body"), field(raw, "content_hash")};
}

// Queue an event the broker did not take; a relay publishes the row later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush(kOutboxKey, nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'docsync/revisions.h': `${comment(REVISIONS_DOC, '// ')}
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "docsync/store.h"

namespace revisions {

inline const std::string kApplyLua = R"(
${APPLY_LUA}
)";

// Apply the change only against the revision the device edited.
inline store::Outcome applyChange(const std::string& doc_id, long long base_revision, const std::string& content_hash, const std::string& body,
                                  const std::string& device) {
  const std::vector<std::string> keys = {store::docKey(doc_id), store::kRevisionKey, store::kChangesKey};
  const std::vector<std::string> args = {doc_id, std::to_string(base_revision), content_hash, body, device};
  std::vector<long long> reply;
  store::redis().eval(kApplyLua, keys.begin(), keys.end(), args.begin(), args.end(), std::back_inserter(reply));
  static const char* kStatuses[] = {"conflict", "applied", "unchanged"};
  return store::Outcome{kStatuses[reply.at(0)], reply.at(1)};
}

}  // namespace revisions
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('docsync', 'Store')]: `package docsync

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
${comment(STORE_DOC, ' * ')}
 */
object Store {
  final case class Doc(docId: String, revision: Long, contentHash: String, body: String, device: String)

  /** What an apply or a merge did: the status and the revision it left the document at. */
  final case class Outcome(status: String, revision: Long)

  final case class Conflict(docId: String, device: String, baseRevision: Long, body: String, contentHash: String)

  val RevisionKey = "rev:seq"
  val ChangesKey = "changes"
  val OutboxKey = "outbox"

  val jedis = new JedisPooled("redis", 6379)

  def docKey(docId: String): String = s"doc:$docId"
  def historyKey(docId: String, revision: Long): String = s"doc:$docId:r$revision"

  /** The SHA-256 of the body's UTF-8 bytes as 64 lowercase hex characters. */
  def contentHash(body: String): String =
    MessageDigest.getInstance("SHA-256").digest(body.getBytes(UTF_8)).map(b => f"\${b & 0xff}%02x").mkString

  /** The document's head, or None when it was never written. */
  def head(docId: String): Option[Doc] = {
    val raw = jedis.hgetAll(docKey(docId)).asScala
    if (raw.isEmpty) None
    else Some(Doc(raw("doc_id"), raw("revision").toLong, raw("content_hash"), raw("body"), raw.getOrElse("device", "")))
  }

  /** The body of revision n ("" for revision 0), or None when that revision is not kept. */
  def bodyAt(docId: String, revision: Long): Option[String] =
    if (revision == 0) Some("") else Option(jedis.hget(historyKey(docId, revision), "body"))

  /** The bulk importer's writer: the body becomes the document's next revision, whatever revision the writer last saw. */
  def overwrite(docId: String, hash: String, body: String, device: String): Long = {
    val revision = jedis.incr(RevisionKey)
    jedis.hset(docKey(docId), Map("doc_id" -> docId, "revision" -> revision.toString, "content_hash" -> hash, "body" -> body, "device" -> device).asJava)
    jedis.hset(historyKey(docId, revision), Map("content_hash" -> hash, "body" -> body).asJava)
    jedis.zadd(ChangesKey, revision.toDouble, docId)
    revision
  }

  /** Keep the device's edit (and the base it edited) beside the head, which stays as it is. */
  def markConflicted(docId: String, device: String, baseRevision: Long, body: String): Unit =
    jedis.hset(s"conflict:$docId", Map("doc_id" -> docId, "device" -> device, "base_revision" -> baseRevision.toString, "body" -> body, "content_hash" -> contentHash(body)).asJava)

  /** The edit kept for the document by a failed merge, or None. */
  def conflictOf(docId: String): Option[Conflict] = {
    val raw = jedis.hgetAll(s"conflict:$docId").asScala
    if (raw.isEmpty) None else Some(Conflict(raw("doc_id"), raw("device"), raw("base_revision").toLong, raw("body"), raw("content_hash")))
  }

  /** Queue an event the broker did not take; a relay publishes the row later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush(OutboxKey, JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('docsync', 'Revisions')]: `package docsync

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
${comment(REVISIONS_DOC, ' * ')}
 */
object Revisions {
  val jedis = new JedisPooled("redis", 6379)

  val ApplyLua: String = """
${APPLY_LUA}
"""

  private val Statuses = Vector("conflict", "applied", "unchanged")

  /** Apply the change only against the revision the device edited. */
  def applyChange(docId: String, baseRevision: Long, contentHash: String, body: String, device: String): Store.Outcome = {
    val keys = List(Store.docKey(docId), Store.RevisionKey, Store.ChangesKey).asJava
    val args = List(docId, baseRevision.toString, contentHash, body, device).asJava
    val reply = jedis.eval(ApplyLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]]
    Store.Outcome(Statuses(reply.get(0).toInt), reply.get(1).longValue)
  }
}
`,
};
