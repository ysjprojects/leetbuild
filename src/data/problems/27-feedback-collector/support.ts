/**
 * Hand-written support modules the feedback-collector steps import but no step builds: the
 * `feedback.store` module, the same Redis keys in every language so a harness reads one layout
 * whatever the stack. It holds the requests the gateway served, the feedback rows, the outbox of
 * events the broker refused, and the per-model quality counters the quality consumer keeps (all
 * time and per hour). `mark_served` is the gateway's write and `record_quality` the consumer's; the
 * checks call them to set up the world.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'feedback/__init__.py': '',
  'feedback/store.py': `"""
The feedback store (provided), in Redis:

  served:{tenant}:{request_id}     string: the unix second the gateway served the request
  feedback:seq                     the counter feedback ids come from (fb-1, fb-2, ...)
  feedback:{feedback_id}           hash: feedback_id, tenant, user_id, request_id, rating, comment,
                                   model_version, prompt_version, route
  outbox:feedback.recorded         list: the JSON events the broker refused, for the relay
  quality:{model_version}          hash: samples, positive since the model shipped
  quality:{model_version}:{hour}   hash: samples, positive in one hour (hour = unix seconds // 3600)

mark_served is the gateway's write and record_quality the quality consumer's.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FIELDS = ("feedback_id", "tenant", "user_id", "request_id", "rating", "comment", "model_version", "prompt_version", "route")
OUTBOX_KEY = "outbox:feedback.recorded"


def mark_served(tenant: str, request_id: str, at: int = 0) -> None:
    """The gateway's write: request_id was served to tenant at unix second at."""
    r.set(f"served:{tenant}:{request_id}", at)


def is_served(tenant: str, request_id: str) -> bool:
    """Whether the gateway served request_id to this tenant."""
    return r.exists(f"served:{tenant}:{request_id}") == 1


def new_feedback_id() -> str:
    return f"fb-{r.incr('feedback:seq')}"


def insert_feedback(row: dict) -> None:
    """Store a feedback row: the FIELDS, a missing one as ""."""
    mapping = {name: "" if row.get(name) is None else str(row[name]) for name in FIELDS}
    r.hset(f"feedback:{row['feedback_id']}", mapping=mapping)


def get_feedback(feedback_id: str) -> dict | None:
    """The stored row (rating as an int), or None."""
    raw = r.hgetall(f"feedback:{feedback_id}")
    if not raw:
        return None
    return {**raw, "rating": int(raw["rating"])}


def insert_outbox(event: dict) -> None:
    """Keep an event the broker refused, for the relay to produce again."""
    r.rpush(OUTBOX_KEY, json.dumps(event))


def record_quality(model_version: str, rating: int, at: int) -> None:
    """The quality consumer's write: one rating of model_version at unix second at."""
    for key in (f"quality:{model_version}", f"quality:{model_version}:{at // 3600}"):
        r.hincrby(key, "samples", 1)
        if rating == 1:
            r.hincrby(key, "positive", 1)


def _pair(raw: dict) -> tuple[int, int]:
    return int(raw.get("samples", 0)), int(raw.get("positive", 0))


def totals(model_version: str) -> tuple[int, int]:
    """(samples, positive) since the model shipped."""
    return _pair(r.hgetall(f"quality:{model_version}"))


def hour_totals(model_version: str, hour: int) -> tuple[int, int]:
    """(samples, positive) in one hour bucket (hour = unix seconds // 3600)."""
    return _pair(r.hgetall(f"quality:{model_version}:{hour}"))
`,
};

export const supportModulesTs: Record<string, string> = {
  'feedback/store.ts': `/**
 * The feedback store (provided), in Redis:
 *
 *   served:{tenant}:{request_id}     string: the unix second the gateway served the request
 *   feedback:seq                     the counter feedback ids come from (fb-1, fb-2, ...)
 *   feedback:{feedback_id}           hash: feedback_id, tenant, user_id, request_id, rating, comment,
 *                                    model_version, prompt_version, route
 *   outbox:feedback.recorded         list: the JSON events the broker refused, for the relay
 *   quality:{model_version}          hash: samples, positive since the model shipped
 *   quality:{model_version}:{hour}   hash: samples, positive in one hour (hour = unix seconds / 3600, floored)
 *
 * markServed is the gateway's write and recordQuality the quality consumer's.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'outbox:feedback.recorded';

export interface Feedback {
  feedback_id: string;
  tenant: string;
  user_id: string;
  request_id: string;
  rating: number;
  comment: string;
  model_version: string;
  prompt_version: string;
  route: string;
}

export const FIELDS = ['feedback_id', 'tenant', 'user_id', 'request_id', 'rating', 'comment', 'model_version', 'prompt_version', 'route'] as const;

/** The gateway's write: requestId was served to tenant at unix second at. */
export async function markServed(tenant: string, requestId: string, at = 0): Promise<void> {
  await redis.set(\`served:\${tenant}:\${requestId}\`, String(at));
}

/** Whether the gateway served requestId to this tenant. */
export async function isServed(tenant: string, requestId: string): Promise<boolean> {
  return (await redis.exists(\`served:\${tenant}:\${requestId}\`)) === 1;
}

export async function newFeedbackId(): Promise<string> {
  return \`fb-\${await redis.incr('feedback:seq')}\`;
}

/** Store a feedback row: the FIELDS, a missing one as "". */
export async function insertFeedback(row: Partial<Feedback> & {feedback_id: string}): Promise<void> {
  const mapping: Record<string, string> = {};
  for (const name of FIELDS) mapping[name] = row[name] === undefined || row[name] === null ? '' : String(row[name]);
  await redis.hset(\`feedback:\${row.feedback_id}\`, mapping);
}

/** The stored row, or null. */
export async function getFeedback(feedbackId: string): Promise<Feedback | null> {
  const raw = await redis.hgetall(\`feedback:\${feedbackId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {...(raw as unknown as Feedback), rating: Number(raw.rating)};
}

/** Keep an event the broker refused, for the relay to produce again. */
export async function insertOutbox(event: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify(event));
}

/** The quality consumer's write: one rating of modelVersion at unix second at. */
export async function recordQuality(modelVersion: string, rating: number, at: number): Promise<void> {
  for (const key of [\`quality:\${modelVersion}\`, \`quality:\${modelVersion}:\${Math.floor(at / 3600)}\`]) {
    await redis.hincrby(key, 'samples', 1);
    if (rating === 1) await redis.hincrby(key, 'positive', 1);
  }
}

async function pair(key: string): Promise<[number, number]> {
  const raw = await redis.hgetall(key);
  return [Number(raw.samples ?? 0), Number(raw.positive ?? 0)];
}

/** [samples, positive] since the model shipped. */
export const totals = (modelVersion: string): Promise<[number, number]> => pair(\`quality:\${modelVersion}\`);

/** [samples, positive] in one hour bucket (hour = unix seconds / 3600, floored). */
export const hourTotals = (modelVersion: string, hour: number): Promise<[number, number]> =>
  pair(\`quality:\${modelVersion}:\${hour}\`);
`,
};

export const supportModulesGo: Record<string, string> = {
  'feedback/store/store.go': `// Package store is the feedback store (provided), in Redis:
//
//	served:{tenant}:{request_id}     string: the unix second the gateway served the request
//	feedback:seq                     the counter feedback ids come from (fb-1, fb-2, ...)
//	feedback:{feedback_id}           hash: feedback_id, tenant, user_id, request_id, rating, comment,
//	                                 model_version, prompt_version, route
//	outbox:feedback.recorded         list: the JSON events the broker refused, for the relay
//	quality:{model_version}          hash: samples, positive since the model shipped
//	quality:{model_version}:{hour}   hash: samples, positive in one hour (hour = unix seconds / 3600)
//
// MarkServed is the gateway's write and RecordQuality the quality consumer's.
package store

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// OutboxKey is the list of events the broker refused.
const OutboxKey = "outbox:feedback.recorded"

// Feedback is one feedback row.
type Feedback struct {
	FeedbackID    string \`json:"feedback_id"\`
	Tenant        string \`json:"tenant"\`
	UserID        string \`json:"user_id"\`
	RequestID     string \`json:"request_id"\`
	Rating        int    \`json:"rating"\`
	Comment       string \`json:"comment"\`
	ModelVersion  string \`json:"model_version"\`
	PromptVersion string \`json:"prompt_version"\`
	Route         string \`json:"route"\`
}

// MarkServed is the gateway's write: requestID was served to tenant at unix second at.
func MarkServed(ctx context.Context, tenant, requestID string, at int64) {
	rdb.Set(ctx, "served:"+tenant+":"+requestID, at, 0)
}

// IsServed reports whether the gateway served requestID to this tenant.
func IsServed(ctx context.Context, tenant, requestID string) (bool, error) {
	n, err := rdb.Exists(ctx, "served:"+tenant+":"+requestID).Result()
	return n == 1, err
}

// NewFeedbackID is the next feedback id.
func NewFeedbackID(ctx context.Context) (string, error) {
	n, err := rdb.Incr(ctx, "feedback:seq").Result()
	return fmt.Sprintf("fb-%d", n), err
}

// InsertFeedback stores a feedback row.
func InsertFeedback(ctx context.Context, row Feedback) error {
	return rdb.HSet(ctx, "feedback:"+row.FeedbackID, map[string]any{
		"feedback_id": row.FeedbackID, "tenant": row.Tenant, "user_id": row.UserID, "request_id": row.RequestID,
		"rating": strconv.Itoa(row.Rating), "comment": row.Comment, "model_version": row.ModelVersion,
		"prompt_version": row.PromptVersion, "route": row.Route,
	}).Err()
}

// GetFeedback is the stored row, or nil.
func GetFeedback(ctx context.Context, feedbackID string) *Feedback {
	raw := rdb.HGetAll(ctx, "feedback:"+feedbackID).Val()
	if len(raw) == 0 {
		return nil
	}
	rating, _ := strconv.Atoi(raw["rating"])
	return &Feedback{FeedbackID: raw["feedback_id"], Tenant: raw["tenant"], UserID: raw["user_id"], RequestID: raw["request_id"],
		Rating: rating, Comment: raw["comment"], ModelVersion: raw["model_version"], PromptVersion: raw["prompt_version"], Route: raw["route"]}
}

// InsertOutbox keeps an event (its JSON) the broker refused, for the relay to produce again.
func InsertOutbox(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, OutboxKey, string(event)).Err()
}

// RecordQuality is the quality consumer's write: one rating of modelVersion at unix second at.
func RecordQuality(ctx context.Context, modelVersion string, rating int, at int64) {
	for _, key := range []string{"quality:" + modelVersion, fmt.Sprintf("quality:%s:%d", modelVersion, at/3600)} {
		rdb.HIncrBy(ctx, key, "samples", 1)
		if rating == 1 {
			rdb.HIncrBy(ctx, key, "positive", 1)
		}
	}
}

func pair(ctx context.Context, key string) (int64, int64, error) {
	raw, err := rdb.HGetAll(ctx, key).Result()
	samples, _ := strconv.ParseInt(raw["samples"], 10, 64)
	positive, _ := strconv.ParseInt(raw["positive"], 10, 64)
	return samples, positive, err
}

// Totals is (samples, positive) since the model shipped.
func Totals(ctx context.Context, modelVersion string) (int64, int64, error) {
	return pair(ctx, "quality:"+modelVersion)
}

// HourTotals is (samples, positive) in one hour bucket (hour = unix seconds / 3600).
func HourTotals(ctx context.Context, modelVersion string, hour int64) (int64, int64, error) {
	return pair(ctx, fmt.Sprintf("quality:%s:%d", modelVersion, hour))
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'feedback/store.h': `// The feedback store (provided), in Redis:
//
//   served:{tenant}:{request_id}     string: the unix second the gateway served the request
//   feedback:seq                     the counter feedback ids come from (fb-1, fb-2, ...)
//   feedback:{feedback_id}           hash: feedback_id, tenant, user_id, request_id, rating, comment,
//                                    model_version, prompt_version, route
//   outbox:feedback.recorded         list: the JSON events the broker refused, for the relay
//   quality:{model_version}          hash: samples, positive since the model shipped
//   quality:{model_version}:{hour}   hash: samples, positive in one hour (hour = unix seconds / 3600)
//
// markServed is the gateway's write and recordQuality the quality consumer's.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

namespace store {

inline const std::string kOutboxKey = "outbox:feedback.recorded";

struct Feedback {
  std::string feedback_id;
  std::string tenant;
  std::string user_id;
  std::string request_id;
  int rating = 0;
  std::string comment;
  std::string model_version;
  std::string prompt_version;
  std::string route;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The gateway's write: request_id was served to tenant at unix second at.
inline void markServed(const std::string& tenant, const std::string& request_id, long long at = 0) {
  redis().set("served:" + tenant + ":" + request_id, std::to_string(at));
}

// Whether the gateway served request_id to this tenant.
inline bool isServed(const std::string& tenant, const std::string& request_id) {
  return redis().exists("served:" + tenant + ":" + request_id) == 1;
}

inline std::string newFeedbackId() { return "fb-" + std::to_string(redis().incr("feedback:seq")); }

// Store a feedback row.
inline void insertFeedback(const Feedback& row) {
  redis().hset("feedback:" + row.feedback_id, {{"feedback_id", row.feedback_id},
                                                {"tenant", row.tenant},
                                                {"user_id", row.user_id},
                                                {"request_id", row.request_id},
                                                {"rating", std::to_string(row.rating)},
                                                {"comment", row.comment},
                                                {"model_version", row.model_version},
                                                {"prompt_version", row.prompt_version},
                                                {"route", row.route}});
}

// The stored row, or none.
inline std::optional<Feedback> getFeedback(const std::string& feedback_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("feedback:" + feedback_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Feedback{text("feedback_id"), text("tenant"), text("user_id"), text("request_id"),
                  text("rating").empty() ? 0 : std::stoi(text("rating")), text("comment"),
                  text("model_version"), text("prompt_version"), text("route")};
}

// Keep an event (its JSON) the broker refused, for the relay to produce again.
inline void insertOutbox(const std::string& event_json) { redis().rpush(kOutboxKey, event_json); }

// The quality consumer's write: one rating of model_version at unix second at.
inline void recordQuality(const std::string& model_version, int rating, long long at) {
  for (const std::string& key : {"quality:" + model_version, "quality:" + model_version + ":" + std::to_string(at / 3600)}) {
    redis().hincrby(key, "samples", 1);
    if (rating == 1) redis().hincrby(key, "positive", 1);
  }
}

inline std::pair<long long, long long> pair(const std::string& key) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(key);
  const auto number = [&raw](const char* name) { return raw.count(name) ? std::stoll(raw.at(name)) : 0LL; };
  return {number("samples"), number("positive")};
}

// (samples, positive) since the model shipped.
inline std::pair<long long, long long> totals(const std::string& model_version) { return pair("quality:" + model_version); }

// (samples, positive) in one hour bucket (hour = unix seconds / 3600).
inline std::pair<long long, long long> hourTotals(const std::string& model_version, long long hour) {
  return pair("quality:" + model_version + ":" + std::to_string(hour));
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('feedback', 'Store')]: `package feedback

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The feedback store (provided), in Redis:
 *
 *   served:{tenant}:{request_id}     string: the unix second the gateway served the request
 *   feedback:seq                     the counter feedback ids come from (fb-1, fb-2, ...)
 *   feedback:{feedback_id}           hash: feedback_id, tenant, user_id, request_id, rating, comment,
 *                                    model_version, prompt_version, route
 *   outbox:feedback.recorded         list: the JSON events the broker refused, for the relay
 *   quality:{model_version}          hash: samples, positive since the model shipped
 *   quality:{model_version}:{hour}   hash: samples, positive in one hour (hour = unix seconds / 3600)
 *
 * markServed is the gateway's write and recordQuality the quality consumer's.
 */
object Store {
  final case class Feedback(
      feedbackId: String,
      tenant: String,
      userId: String,
      requestId: String,
      rating: Int,
      comment: String,
      modelVersion: String = "",
      promptVersion: String = "",
      route: String = "")

  val OutboxKey = "outbox:feedback.recorded"

  val jedis = new JedisPooled("redis", 6379)

  /** The gateway's write: requestId was served to tenant at unix second at. */
  def markServed(tenant: String, requestId: String, at: Long = 0L): Unit = jedis.set(s"served:$tenant:$requestId", at.toString)

  /** Whether the gateway served requestId to this tenant. */
  def isServed(tenant: String, requestId: String): Boolean = jedis.exists(s"served:$tenant:$requestId")

  def newFeedbackId(): String = s"fb-\${jedis.incr("feedback:seq")}"

  /** Store a feedback row. */
  def insertFeedback(row: Feedback): Unit =
    jedis.hset(
      s"feedback:\${row.feedbackId}",
      Map(
        "feedback_id" -> row.feedbackId, "tenant" -> row.tenant, "user_id" -> row.userId, "request_id" -> row.requestId,
        "rating" -> row.rating.toString, "comment" -> row.comment, "model_version" -> row.modelVersion,
        "prompt_version" -> row.promptVersion, "route" -> row.route).asJava)

  /** The stored row, if any. */
  def getFeedback(feedbackId: String): Option[Feedback] = {
    val raw = jedis.hgetAll(s"feedback:$feedbackId").asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      Some(Feedback(text("feedback_id"), text("tenant"), text("user_id"), text("request_id"), text("rating").toInt,
        text("comment"), text("model_version"), text("prompt_version"), text("route")))
    }
  }

  /** Keep an event (its JSON) the broker refused, for the relay to produce again. */
  def insertOutbox(event: String): Unit = jedis.rpush(OutboxKey, event)

  /** The quality consumer's write: one rating of modelVersion at unix second at. */
  def recordQuality(modelVersion: String, rating: Int, at: Long): Unit =
    Seq(s"quality:$modelVersion", s"quality:$modelVersion:\${at / 3600}").foreach { key =>
      jedis.hincrBy(key, "samples", 1)
      if (rating == 1) jedis.hincrBy(key, "positive", 1)
    }

  private def pair(key: String): (Long, Long) = {
    val raw = jedis.hgetAll(key).asScala
    (raw.get("samples").map(_.toLong).getOrElse(0L), raw.get("positive").map(_.toLong).getOrElse(0L))
  }

  /** (samples, positive) since the model shipped. */
  def totals(modelVersion: String): (Long, Long) = pair(s"quality:$modelVersion")

  /** (samples, positive) in one hour bucket (hour = unix seconds / 3600). */
  def hourTotals(modelVersion: String, hour: Long): (Long, Long) = pair(s"quality:$modelVersion:$hour")
}
`,
};
