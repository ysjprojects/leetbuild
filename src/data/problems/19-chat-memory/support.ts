/**
 * Hand-written support modules the chat-memory steps import but no step builds: the `memory`
 * package. `memory.sessions` holds what every step shares: the API keys that authenticate a tenant,
 * turn ids, the token estimate and the idempotency records of appends. `memory.buffer` is the
 * recent-turn buffer of step 2 as later steps use it, `memory.summaries` reads the span summaries
 * step 3 writes, and `memory.outbox` is the row a produce falls back to in step 4. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'memory/__init__.py': '',
  'memory/sessions.py': `"""
Tenants, turn ids, token counts and idempotency records (provided). apikeys is a hash from API key
to tenant. turnseq:{tenant}:{session_id} numbers a session's turns: t-1, t-2, and so on.
idem:{tenant}:{key} holds the response an append with that Idempotency-Key answered, for 24 hours.
A turn is a dict {turn_id, role, content, tokens}.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 86400


def tenant_for_key(api_key: str) -> str | None:
    """The tenant an API key authenticates, or None for an unknown key."""
    return r.hget("apikeys", api_key) if api_key else None


def next_turn_id(tenant: str, session_id: str) -> str:
    """The id of the session's next turn (t-1, t-2, ...)."""
    key = f"turnseq:{tenant}:{session_id}"
    n = r.incr(key)
    r.expire(key, TTL_S)
    return f"t-{n}"


def latest_turn_id(tenant: str, session_id: str) -> str | None:
    """The id of the session's newest turn, or None before its first."""
    n = r.get(f"turnseq:{tenant}:{session_id}")
    return f"t-{n}" if n else None


def count_tokens(text: str) -> int:
    """The token estimate every step uses: one token per 4 bytes of UTF-8, rounded up."""
    return (len(text.encode("utf-8")) + 3) // 4


def replayed_turn(tenant: str, key: str) -> dict | None:
    """The response recorded for the append (tenant, Idempotency-Key), if any."""
    raw = r.get(f"idem:{tenant}:{key}")
    return json.loads(raw) if raw else None


def record_turn(tenant: str, key: str, response: dict) -> None:
    """Record what the append (tenant, Idempotency-Key) answered, for its replays."""
    r.set(f"idem:{tenant}:{key}", json.dumps(response), ex=TTL_S)
`,
  'memory/buffer.py': `"""
The recent-turn buffer (provided; step 2 builds the same two functions): turns:{tenant}:{session_id}
is a list of JSON turns, oldest first, holding the last MAX_TURNS and expiring TTL_S after the last
append. One Lua script pushes, trims and expires.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_TURNS = 50
TTL_S = 86400

APPEND_LUA = """
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('LLEN', KEYS[1])
"""
append = r.register_script(APPEND_LUA)


def buffer_key(tenant: str, session_id: str) -> str:
    return f"turns:{tenant}:{session_id}"


def append_turn(tenant: str, session_id: str, turn: dict) -> int:
    """Append a turn (turn_id, role, content, tokens); returns how many turns the buffer holds."""
    return int(append(keys=[buffer_key(tenant, session_id)], args=[json.dumps(turn), MAX_TURNS, TTL_S]))


def recent_turns(tenant: str, session_id: str, limit: int = MAX_TURNS) -> list[dict]:
    """The session's last limit turns, oldest first."""
    return [json.loads(raw) for raw in r.lrange(buffer_key(tenant, session_id), -limit, -1)]
`,
  'memory/summaries.py': `"""
Span summaries (provided; step 3 writes them): summaries:{tenant}:{session_id} is a hash from a span
id, "{first_turn_id}:{last_turn_id}", to the summary of those turns. latest_summary picks the span
that ends last.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def summaries_key(tenant: str, session_id: str) -> str:
    return f"summaries:{tenant}:{session_id}"


def _end(span: str) -> int:
    return int(span.rsplit("-", 1)[1])


def latest_summary(tenant: str, session_id: str) -> dict | None:
    """The summary of the span that ends last, as {span, text}, or None."""
    spans = r.hgetall(summaries_key(tenant, session_id))
    if not spans:
        return None
    span = max(spans, key=_end)
    return {"span": span, "text": spans[span]}
`,
  'memory/outbox.py': `"""
The outbox (provided): a Redis list, outbox, of the events the broker did not take, each a JSON row
{topic, key, payload}. A relay produces them later.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'memory/sessions.ts': `/**
 * Tenants, turn ids, token counts and idempotency records (provided). apikeys is a hash from API key
 * to tenant. turnseq:{tenant}:{session_id} numbers a session's turns: t-1, t-2, and so on.
 * idem:{tenant}:{key} holds the response an append with that Idempotency-Key answered, for 24 hours.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 86400;

export interface Turn {
  turn_id: string;
  role: string;
  content: string;
  tokens: number;
}

/** The tenant an API key authenticates, or null for an unknown key. */
export async function tenantForKey(apiKey: string): Promise<string | null> {
  return apiKey === '' ? null : redis.hget('apikeys', apiKey);
}

/** The id of the session's next turn (t-1, t-2, ...). */
export async function nextTurnId(tenant: string, sessionId: string): Promise<string> {
  const key = \`turnseq:\${tenant}:\${sessionId}\`;
  const n = await redis.incr(key);
  await redis.expire(key, TTL_S);
  return \`t-\${n}\`;
}

/** The id of the session's newest turn, or null before its first. */
export async function latestTurnId(tenant: string, sessionId: string): Promise<string | null> {
  const n = await redis.get(\`turnseq:\${tenant}:\${sessionId}\`);
  return n === null ? null : \`t-\${n}\`;
}

/** The token estimate every step uses: one token per 4 bytes of UTF-8, rounded up. */
export const countTokens = (text: string): number => Math.ceil(new TextEncoder().encode(text).length / 4);

/** The response recorded for the append (tenant, Idempotency-Key), if any. */
export async function replayedTurn(tenant: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`idem:\${tenant}:\${key}\`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Record what the append (tenant, Idempotency-Key) answered, for its replays. */
export async function recordTurn(tenant: string, key: string, response: Record<string, unknown>): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, JSON.stringify(response), 'EX', TTL_S);
}
`,
  'memory/buffer.ts': `/**
 * The recent-turn buffer (provided; step 2 builds the same two functions): turns:{tenant}:{session_id}
 * is a list of JSON turns, oldest first, holding the last MAX_TURNS and expiring TTL_S after the last
 * append. One Lua script pushes, trims and expires.
 */
import Redis from 'ioredis';

import type {Turn} from 'memory/sessions';

export const MAX_TURNS = 50;
export const TTL_S = 86400;

export const APPEND_LUA = \`
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('LLEN', KEYS[1])
\`;

interface BufferRedis extends Redis {
  appendTurn(key: string, turn: string, maxTurns: number, ttl: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as BufferRedis;
redis.defineCommand('appendTurn', {numberOfKeys: 1, lua: APPEND_LUA});

export const bufferKey = (tenant: string, sessionId: string): string => \`turns:\${tenant}:\${sessionId}\`;

/** Append a turn; resolves how many turns the buffer holds. */
export async function appendTurn(tenant: string, sessionId: string, turn: Turn): Promise<number> {
  return Number(await redis.appendTurn(bufferKey(tenant, sessionId), JSON.stringify(turn), MAX_TURNS, TTL_S));
}

/** The session's last limit turns, oldest first. */
export async function recentTurns(tenant: string, sessionId: string, limit = MAX_TURNS): Promise<Turn[]> {
  const raw = await redis.lrange(bufferKey(tenant, sessionId), -limit, -1);
  return raw.map(text => JSON.parse(text) as Turn);
}
`,
  'memory/summaries.ts': `/**
 * Span summaries (provided; step 3 writes them): summaries:{tenant}:{session_id} is a hash from a
 * span id, "{first_turn_id}:{last_turn_id}", to the summary of those turns. latestSummary picks the
 * span that ends last.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Summary {
  span: string;
  text: string;
}

export const summariesKey = (tenant: string, sessionId: string): string => \`summaries:\${tenant}:\${sessionId}\`;

const end = (span: string): number => Number(span.slice(span.lastIndexOf('-') + 1));

/** The summary of the span that ends last, or null. */
export async function latestSummary(tenant: string, sessionId: string): Promise<Summary | null> {
  const spans = await redis.hgetall(summariesKey(tenant, sessionId));
  let best: Summary | null = null;
  for (const [span, text] of Object.entries(spans)) {
    if (best === null || end(span) > end(best.span)) best = {span, text};
  }
  return best;
}
`,
  'memory/outbox.ts': `/**
 * The outbox (provided): a Redis list, outbox, of the events the broker did not take, each a JSON row
 * {topic, key, payload}. A relay produces them later.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'memory/sessions/sessions.go': `// Package sessions holds tenants, turn ids, token counts and idempotency records (provided).
// apikeys is a hash from API key to tenant. turnseq:{tenant}:{session_id} numbers a session's turns:
// t-1, t-2, and so on. idem:{tenant}:{key} holds the response an append with that Idempotency-Key
// answered, for 24 hours.
package sessions

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TTL is how long a session's keys outlive its last write.
const TTL = 24 * time.Hour

// Turn is one turn of a conversation.
type Turn struct {
	TurnID  string \`json:"turn_id"\`
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
	Tokens  int    \`json:"tokens"\`
}

// TenantForKey is the tenant an API key authenticates; false for an unknown key.
func TenantForKey(ctx context.Context, apiKey string) (string, bool) {
	if apiKey == "" {
		return "", false
	}
	tenant, err := rdb.HGet(ctx, "apikeys", apiKey).Result()
	return tenant, err == nil
}

// NextTurnID is the id of the session's next turn (t-1, t-2, ...).
func NextTurnID(ctx context.Context, tenant, sessionID string) string {
	key := "turnseq:" + tenant + ":" + sessionID
	n := rdb.Incr(ctx, key).Val()
	rdb.Expire(ctx, key, TTL)
	return fmt.Sprintf("t-%d", n)
}

// LatestTurnID is the id of the session's newest turn, or "" before its first.
func LatestTurnID(ctx context.Context, tenant, sessionID string) string {
	n, err := rdb.Get(ctx, "turnseq:"+tenant+":"+sessionID).Result()
	if err != nil {
		return ""
	}
	return "t-" + n
}

// CountTokens is the token estimate every step uses: one token per 4 bytes of UTF-8, rounded up.
func CountTokens(text string) int {
	return (len(text) + 3) / 4
}

// ReplayedTurn is the response recorded for the append (tenant, Idempotency-Key) as JSON, or nil.
func ReplayedTurn(ctx context.Context, tenant, key string) []byte {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Bytes()
	if err != nil {
		return nil
	}
	return raw
}

// RecordTurn records what the append (tenant, Idempotency-Key) answered, for its replays.
func RecordTurn(ctx context.Context, tenant, key string, response any) {
	raw, _ := json.Marshal(response)
	rdb.Set(ctx, "idem:"+tenant+":"+key, raw, TTL)
}
`,
  'memory/buffer/buffer.go': `// Package buffer is the recent-turn buffer (provided; step 2 builds the same two functions):
// turns:{tenant}:{session_id} is a list of JSON turns, oldest first, holding the last MaxTurns and
// expiring TTLSeconds after the last append. One Lua script pushes, trims and expires.
package buffer

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"memory/sessions"
)

const (
	MaxTurns   = 50
	TTLSeconds = 86400
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Append pushes ARGV[1], keeps the last ARGV[2] turns and expires the list after ARGV[3] seconds.
var Append = redis.NewScript(\`
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('LLEN', KEYS[1])
\`)

// Key is the buffer of one (tenant, session).
func Key(tenant, sessionID string) string {
	return "turns:" + tenant + ":" + sessionID
}

// AppendTurn appends a turn and returns how many turns the buffer holds.
func AppendTurn(ctx context.Context, tenant, sessionID string, turn sessions.Turn) (int64, error) {
	raw, _ := json.Marshal(turn)
	return Append.Run(ctx, rdb, []string{Key(tenant, sessionID)}, string(raw), MaxTurns, TTLSeconds).Int64()
}

// RecentTurns is the session's last limit turns, oldest first.
func RecentTurns(ctx context.Context, tenant, sessionID string, limit int) ([]sessions.Turn, error) {
	raw, err := rdb.LRange(ctx, Key(tenant, sessionID), int64(-limit), -1).Result()
	if err != nil {
		return nil, err
	}
	turns := make([]sessions.Turn, 0, len(raw))
	for _, text := range raw {
		var turn sessions.Turn
		if err := json.Unmarshal([]byte(text), &turn); err != nil {
			return nil, err
		}
		turns = append(turns, turn)
	}
	return turns, nil
}
`,
  'memory/summaries/summaries.go': `// Package summaries reads the span summaries step 3 writes (provided): summaries:{tenant}:{session_id}
// is a hash from a span id, "{first_turn_id}:{last_turn_id}", to the summary of those turns.
// LatestSummary picks the span that ends last.
package summaries

import (
	"context"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Summary is the summary of one span of turns.
type Summary struct {
	Span string
	Text string
}

// Key is the hash of a session's span summaries.
func Key(tenant, sessionID string) string {
	return "summaries:" + tenant + ":" + sessionID
}

func end(span string) int {
	n, _ := strconv.Atoi(span[strings.LastIndex(span, "-")+1:])
	return n
}

// LatestSummary is the summary of the span that ends last, or nil.
func LatestSummary(ctx context.Context, tenant, sessionID string) (*Summary, error) {
	spans, err := rdb.HGetAll(ctx, Key(tenant, sessionID)).Result()
	if err != nil {
		return nil, err
	}
	var best *Summary
	for span, text := range spans {
		if best == nil || end(span) > end(best.Span) {
			best = &Summary{Span: span, Text: text}
		}
	}
	return best, nil
}
`,
  'memory/outbox/outbox.go': `// Package outbox is the outbox (provided): a Redis list, outbox, of the events the broker did not
// take, each a JSON row {topic, key, payload}. A relay produces them later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert adds a row for an event the broker did not take.
func Insert(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", string(raw)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'memory/sessions.h': `// Tenants, turn ids, token counts and idempotency records (provided). apikeys is a hash from API key
// to tenant. turnseq:{tenant}:{session_id} numbers a session's turns: t-1, t-2, and so on.
// idem:{tenant}:{key} holds the response an append with that Idempotency-Key answered, for 24 hours.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

namespace sessions {

constexpr std::chrono::seconds kTtl{86400};

// One turn of a conversation.
struct Turn {
  std::string turn_id;
  std::string role;
  std::string content;
  long tokens = 0;
};

inline void to_json(nlohmann::json& j, const Turn& t) {
  j = nlohmann::json{{"turn_id", t.turn_id}, {"role", t.role}, {"content", t.content}, {"tokens", t.tokens}};
}

inline void from_json(const nlohmann::json& j, Turn& t) {
  t.turn_id = j.value("turn_id", "");
  t.role = j.value("role", "");
  t.content = j.value("content", "");
  t.tokens = j.value("tokens", 0L);
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The tenant an API key authenticates, or none for an unknown key.
inline std::optional<std::string> tenantForKey(const std::string& api_key) {
  if (api_key.empty()) return std::nullopt;
  const auto tenant = redis().hget("apikeys", api_key);
  if (!tenant) return std::nullopt;
  return *tenant;
}

// The id of the session's next turn (t-1, t-2, ...).
inline std::string nextTurnId(const std::string& tenant, const std::string& session_id) {
  const std::string key = "turnseq:" + tenant + ":" + session_id;
  const long long n = redis().incr(key);
  redis().expire(key, kTtl);
  return "t-" + std::to_string(n);
}

// The id of the session's newest turn, or "" before its first.
inline std::string latestTurnId(const std::string& tenant, const std::string& session_id) {
  const auto n = redis().get("turnseq:" + tenant + ":" + session_id);
  return n ? "t-" + *n : "";
}

// The token estimate every step uses: one token per 4 bytes of UTF-8, rounded up.
inline long countTokens(const std::string& text) { return static_cast<long>((text.size() + 3) / 4); }

// The response recorded for the append (tenant, Idempotency-Key), if any.
inline std::optional<nlohmann::json> replayedTurn(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("idem:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the append (tenant, Idempotency-Key) answered, for its replays.
inline void recordTurn(const std::string& tenant, const std::string& key, const nlohmann::json& response) {
  redis().set("idem:" + tenant + ":" + key, response.dump(), kTtl);
}

}  // namespace sessions
`,
  'memory/buffer.h': `// The recent-turn buffer (provided; step 2 builds the same two functions): turns:{tenant}:{session_id}
// is a list of JSON turns, oldest first, holding the last kMaxTurns and expiring kTtlSeconds after
// the last append. One Lua script pushes, trims and expires.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "memory/sessions.h"

namespace buffer {

constexpr long kMaxTurns = 50;
constexpr long kTtlSeconds = 86400;

inline const std::string kAppendLua = R"lua(
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('LLEN', KEYS[1])
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string key(const std::string& tenant, const std::string& session_id) {
  return "turns:" + tenant + ":" + session_id;
}

// Append a turn; returns how many turns the buffer holds.
inline long long appendTurn(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  return redis().eval<long long>(kAppendLua, {key(tenant, session_id)},
                                 {nlohmann::json(turn).dump(), std::to_string(kMaxTurns), std::to_string(kTtlSeconds)});
}

// The session's last limit turns, oldest first.
inline std::vector<sessions::Turn> recentTurns(const std::string& tenant, const std::string& session_id, long limit = kMaxTurns) {
  std::vector<std::string> raw;
  redis().lrange(key(tenant, session_id), -limit, -1, std::back_inserter(raw));
  std::vector<sessions::Turn> turns;
  for (const std::string& text : raw) turns.push_back(nlohmann::json::parse(text).get<sessions::Turn>());
  return turns;
}

}  // namespace buffer
`,
  'memory/summaries.h': `// Span summaries (provided; step 3 writes them): summaries:{tenant}:{session_id} is a hash from a span
// id, "{first_turn_id}:{last_turn_id}", to the summary of those turns. latestSummary picks the span
// that ends last.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

namespace summaries {

// The summary of one span of turns.
struct Summary {
  std::string span;
  std::string text;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string key(const std::string& tenant, const std::string& session_id) {
  return "summaries:" + tenant + ":" + session_id;
}

// The number of a span's last turn: "t-41:t-50" → 50.
inline long spanEnd(const std::string& span) { return std::stol(span.substr(span.rfind('-') + 1)); }

// The summary of the span that ends last, or none.
inline std::optional<Summary> latestSummary(const std::string& tenant, const std::string& session_id) {
  std::unordered_map<std::string, std::string> spans;
  redis().hgetall(key(tenant, session_id), std::inserter(spans, spans.begin()));
  std::optional<Summary> best;
  for (const auto& [span, text] : spans) {
    if (!best || spanEnd(span) > spanEnd(best->span)) best = Summary{span, text};
  }
  return best;
}

}  // namespace summaries
`,
  'memory/outbox.h': `// The outbox (provided): a Redis list, outbox, of the events the broker did not take, each a JSON row
// {topic, key, payload}. A relay produces them later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Add a row for an event the broker did not take.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('memory', 'Sessions')]: `package memory

import java.nio.charset.StandardCharsets.UTF_8

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

/**
 * Tenants, turn ids, token counts and idempotency records (provided). apikeys is a hash from API key
 * to tenant. turnseq:{tenant}:{session_id} numbers a session's turns: t-1, t-2, and so on.
 * idem:{tenant}:{key} holds the response an append with that Idempotency-Key answered, for 24 hours.
 */
object Sessions {
  /** One turn of a conversation. */
  final case class Turn(turnId: String, role: String, content: String, tokens: Long) {
    def toJson: JsObject =
      JsObject("turn_id" -> JsString(turnId), "role" -> JsString(role), "content" -> JsString(content), "tokens" -> JsNumber(tokens))
  }

  object Turn {
    def fromJson(json: JsValue): Turn = {
      val fields = json.asJsObject.fields
      def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
      Turn(text("turn_id"), text("role"), text("content"), fields.get("tokens").collect { case JsNumber(n) => n.toLong }.getOrElse(0L))
    }
  }

  val TtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)

  /** The tenant an API key authenticates, or None for an unknown key. */
  def tenantForKey(apiKey: String): Option[String] =
    if (apiKey.isEmpty) None else Option(jedis.hget("apikeys", apiKey))

  /** The id of the session's next turn (t-1, t-2, ...). */
  def nextTurnId(tenant: String, sessionId: String): String = {
    val key = s"turnseq:$tenant:$sessionId"
    val n = jedis.incr(key)
    jedis.expire(key, TtlSeconds)
    s"t-$n"
  }

  /** The id of the session's newest turn, or None before its first. */
  def latestTurnId(tenant: String, sessionId: String): Option[String] =
    Option(jedis.get(s"turnseq:$tenant:$sessionId")).map(n => s"t-$n")

  /** The token estimate every step uses: one token per 4 bytes of UTF-8, rounded up. */
  def countTokens(text: String): Long = (text.getBytes(UTF_8).length + 3L) / 4

  /** The response recorded for the append (tenant, Idempotency-Key), if any. */
  def replayedTurn(tenant: String, key: String): Option[JsObject] =
    Option(jedis.get(s"idem:$tenant:$key")).map(_.parseJson.asJsObject)

  /** Record what the append (tenant, Idempotency-Key) answered, for its replays. */
  def recordTurn(tenant: String, key: String, response: JsObject): Unit =
    jedis.set(s"idem:$tenant:$key", response.compactPrint, SetParams.setParams().ex(TtlSeconds))
}
`,
  [scalaPath('memory', 'Buffer')]: `package memory

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The recent-turn buffer (provided; step 2 builds the same two functions): turns:{tenant}:{session_id}
 * is a list of JSON turns, oldest first, holding the last MaxTurns and expiring TtlSeconds after the
 * last append. One Lua script pushes, trims and expires.
 */
object Buffer {
  val MaxTurns = 50
  val TtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)

  val AppendLua: String =
    """redis.call('RPUSH', KEYS[1], ARGV[1])
      |redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |return redis.call('LLEN', KEYS[1])
      |""".stripMargin

  def bufferKey(tenant: String, sessionId: String): String = s"turns:$tenant:$sessionId"

  /** Append a turn; returns how many turns the buffer holds. */
  def appendTurn(tenant: String, sessionId: String, turn: Sessions.Turn): Long = {
    val args = List(turn.toJson.compactPrint, MaxTurns.toString, TtlSeconds.toString).asJava
    jedis.eval(AppendLua, List(bufferKey(tenant, sessionId)).asJava, args).asInstanceOf[java.lang.Long]
  }

  /** The session's last limit turns, oldest first. */
  def recentTurns(tenant: String, sessionId: String, limit: Int = MaxTurns): Seq[Sessions.Turn] =
    jedis.lrange(bufferKey(tenant, sessionId), -limit.toLong, -1L).asScala.toSeq.map(raw => Sessions.Turn.fromJson(raw.parseJson))
}
`,
  [scalaPath('memory', 'Summaries')]: `package memory

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Span summaries (provided; step 3 writes them): summaries:{tenant}:{session_id} is a hash from a
 * span id, "{first_turn_id}:{last_turn_id}", to the summary of those turns. latestSummary picks the
 * span that ends last.
 */
object Summaries {
  /** The summary of one span of turns. */
  final case class Summary(span: String, text: String)

  val jedis = new JedisPooled("redis", 6379)

  def summariesKey(tenant: String, sessionId: String): String = s"summaries:$tenant:$sessionId"

  private def end(span: String): Long = span.substring(span.lastIndexOf('-') + 1).toLong

  /** The summary of the span that ends last, if any. */
  def latestSummary(tenant: String, sessionId: String): Option[Summary] = {
    val spans = jedis.hgetAll(summariesKey(tenant, sessionId)).asScala
    if (spans.isEmpty) None
    else {
      val (span, text) = spans.maxBy { case (span, _) => end(span) }
      Some(Summary(span, text))
    }
  }
}
`,
  [scalaPath('memory', 'Outbox')]: `package memory

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): a Redis list, outbox, of the events the broker did not take, each a JSON
 * row {topic, key, payload}. A relay produces them later.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Add a row for an event the broker did not take. */
  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
