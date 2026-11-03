import {scalaPath} from '../scala-support';

/**
 * routerd's provided modules, the same in every language: `routerd/auth` turns the
 * `Authorization: Bearer <tenant>` header into the tenant (steps 1, 2 and 5), `routerd/tokens`
 * is the one token estimate the route and the limiter share (steps 1 and 2), and
 * `routerd/outbox` is where a feedback event goes when the broker will not take it (step 4): the
 * Redis list `outbox:feedback`, one JSON row per event, which a relay drains later.
 */
export const supportModules: Record<string, string> = {
  'routerd/__init__.py': '',
  'routerd/auth.py': `"""Tenant authentication (provided): the bearer token is the tenant id."""
from fastapi import HTTPException


def authenticate(authorization: str | None) -> str:
    """The tenant named by \`Authorization: Bearer <tenant>\`; 401 when the header is missing or malformed."""
    if not authorization or not authorization.startswith("Bearer ") or not authorization[7:].strip():
        raise HTTPException(status_code=401, detail="missing bearer token")
    return authorization[7:].strip()
`,
  'routerd/tokens.py': `"""The token estimate (provided): what a request may cost before any model has seen it."""
import math


def estimate_tokens(prompt: str, max_tokens: int) -> int:
    """ceil(UTF-8 bytes of the prompt / 4) for the input, plus everything the model may generate."""
    return math.ceil(len(prompt.encode()) / 4) + max_tokens
`,
  'routerd/outbox.py': `"""
The feedback outbox (provided): \`insert(event, reason)\` appends the event to the Redis list
\`outbox:feedback\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
KEY = "outbox:feedback"


def insert(event: dict, reason: str) -> None:
    r.rpush(KEY, json.dumps({"event": event, "reason": reason}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'routerd/auth.ts': `/** Tenant authentication (provided): the bearer token is the tenant id. */

/** The tenant named by \`Authorization: Bearer <tenant>\`; throws a 401 error when the header is missing or malformed. */
export function authenticate(authorization: string | undefined): string {
  const tenant = authorization !== undefined && authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (tenant === '') throw Object.assign(new Error('missing bearer token'), {statusCode: 401});
  return tenant;
}
`,
  'routerd/tokens.ts': `/** The token estimate (provided): what a request may cost before any model has seen it. */

/** ceil(UTF-8 bytes of the prompt / 4) for the input, plus everything the model may generate. */
export function estimateTokens(prompt: string, maxTokens: number): number {
  return Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4) + maxTokens;
}
`,
  'routerd/outbox.ts': `/**
 * The feedback outbox (provided): \`insert(event, reason)\` appends the event to the Redis list
 * \`outbox:feedback\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});
export const KEY = 'outbox:feedback';

export async function insert(event: Record<string, unknown>, reason: string): Promise<void> {
  await redis.rpush(KEY, JSON.stringify({event, reason}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'routerd/auth/auth.go': `// Package auth is tenant authentication (provided): the bearer token is the tenant id.
package auth

import (
	"net/http"
	"strings"
)

// Tenant is the tenant named by "Authorization: Bearer <tenant>"; ok is false when the header is
// missing or malformed (answer 401).
func Tenant(r *http.Request) (tenant string, ok bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", false
	}
	tenant = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	return tenant, tenant != ""
}
`,
  'routerd/tokens/tokens.go': `// Package tokens is the token estimate (provided): what a request may cost before any model has seen it.
package tokens

// Estimate is ceil(UTF-8 bytes of the prompt / 4) for the input, plus everything the model may generate.
func Estimate(prompt string, maxTokens int) int {
	return (len(prompt)+3)/4 + maxTokens
}
`,
  'routerd/outbox/outbox.go': `// Package outbox is the feedback outbox (provided): Insert appends the event to the Redis list
// outbox:feedback as JSON ({"event": …, "reason": …}); a relay produces the rows later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const Key = "outbox:feedback"

// Insert appends event (a JSON document) with the reason it could not be produced.
func Insert(ctx context.Context, event json.RawMessage, reason string) error {
	row, _ := json.Marshal(map[string]any{"event": event, "reason": reason})
	return rdb.RPush(ctx, Key, row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'routerd/auth.h': `// Tenant authentication (provided): the bearer token is the tenant id.
#pragma once

#include <httplib.h>

#include <optional>
#include <string>

namespace routerd {

// The tenant named by "Authorization: Bearer <tenant>"; nullopt when the header is missing or
// malformed (answer 401).
inline std::optional<std::string> tenant(const httplib::Request& req) {
  const std::string auth = req.get_header_value("Authorization");
  if (auth.rfind("Bearer ", 0) != 0) return std::nullopt;
  std::string t = auth.substr(7);
  while (!t.empty() && t.back() == ' ') t.pop_back();
  while (!t.empty() && t.front() == ' ') t.erase(t.begin());
  if (t.empty()) return std::nullopt;
  return t;
}

}  // namespace routerd
`,
  'routerd/tokens.h': `// The token estimate (provided): what a request may cost before any model has seen it.
#pragma once

#include <string>

namespace routerd {

// ceil(UTF-8 bytes of the prompt / 4) for the input, plus everything the model may generate.
inline long long estimate_tokens(const std::string& prompt, long long max_tokens) {
  return static_cast<long long>((prompt.size() + 3) / 4) + max_tokens;
}

}  // namespace routerd
`,
  'routerd/outbox.h': `// The feedback outbox (provided): insert(event_json, reason) appends the event to the Redis list
// outbox:feedback as JSON ({"event": …, "reason": …}); a relay produces the rows later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace routerd::outbox {

inline const std::string kKey = "outbox:feedback";

inline void insert(const std::string& event_json, const std::string& reason) {
  static sw::redis::Redis redis("tcp://redis:6379");
  nlohmann::json row;
  row["event"] = nlohmann::json::parse(event_json);
  row["reason"] = reason;
  redis.rpush(kKey, row.dump());
}

}  // namespace routerd::outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('routerd', 'Auth')]: `package routerd

/** Tenant authentication (provided): the bearer token is the tenant id. */
object Auth {
  /** The tenant named by \`Authorization: Bearer <tenant>\`; None when the header is missing or malformed (answer 401). */
  def tenant(authorization: Option[String]): Option[String] =
    authorization.filter(_.startsWith("Bearer ")).map(_.drop(7).trim).filter(_.nonEmpty)
}
`,
  [scalaPath('routerd', 'Tokens')]: `package routerd

/** The token estimate (provided): what a request may cost before any model has seen it. */
object Tokens {
  /** ceil(UTF-8 bytes of the prompt / 4) for the input, plus everything the model may generate. */
  def estimate(prompt: String, maxTokens: Int): Int = (prompt.getBytes("UTF-8").length + 3) / 4 + maxTokens
}
`,
  [scalaPath('routerd', 'Outbox')]: `package routerd

import redis.clients.jedis.JedisPooled

/**
 * The feedback outbox (provided): \`insert(eventJson, reason)\` appends the event to the Redis list
 * \`outbox:feedback\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
 */
object Outbox {
  val Key = "outbox:feedback"
  private val jedis = new JedisPooled("redis", 6379)

  def insert(eventJson: String, reason: String): Unit =
    jedis.rpush(Key, s"""{"event":$eventJson,"reason":"\${reason.replace("\\"", "'")}"}""")
}
`,
};
