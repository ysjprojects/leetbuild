import {scalaPath} from '../scala-support';

/**
 * The gateway's provided modules, the same in every language: `gateway/auth` turns the
 * `Authorization: Bearer <tenant>` header into the tenant (steps 1 to 3), and `gateway/outbox`
 * is where a usage event goes when the broker will not take it (step 5): the Redis list
 * `outbox:usage`, one JSON row per event, which a relay drains later.
 */
export const supportModules: Record<string, string> = {
  'gateway/__init__.py': '',
  'gateway/auth.py': `"""Tenant authentication (provided): the bearer token is the tenant id."""
from fastapi import HTTPException


def authenticate(authorization: str | None) -> str:
    """The tenant named by \`Authorization: Bearer <tenant>\`; 401 when the header is missing or malformed."""
    if not authorization or not authorization.startswith("Bearer ") or not authorization[7:].strip():
        raise HTTPException(status_code=401, detail="missing bearer token")
    return authorization[7:].strip()
`,
  'gateway/outbox.py': `"""
The usage outbox (provided): \`insert(event, reason)\` appends the event to the Redis list
\`outbox:usage\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
KEY = "outbox:usage"


def insert(event: dict, reason: str) -> None:
    r.rpush(KEY, json.dumps({"event": event, "reason": reason}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'gateway/auth.ts': `/** Tenant authentication (provided): the bearer token is the tenant id. */

/** The tenant named by \`Authorization: Bearer <tenant>\`; throws a 401 error when the header is missing or malformed. */
export function authenticate(authorization: string | undefined): string {
  const tenant = authorization !== undefined && authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (tenant === '') throw Object.assign(new Error('missing bearer token'), {statusCode: 401});
  return tenant;
}
`,
  'gateway/outbox.ts': `/**
 * The usage outbox (provided): \`insert(event, reason)\` appends the event to the Redis list
 * \`outbox:usage\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});
export const KEY = 'outbox:usage';

export async function insert(event: Record<string, unknown>, reason: string): Promise<void> {
  await redis.rpush(KEY, JSON.stringify({event, reason}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'gateway/auth/auth.go': `// Package auth is tenant authentication (provided): the bearer token is the tenant id.
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
  'gateway/outbox/outbox.go': `// Package outbox is the usage outbox (provided): Insert appends the event to the Redis list
// outbox:usage as JSON ({"event": …, "reason": …}); a relay produces the rows later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const Key = "outbox:usage"

// Insert appends event (a JSON document) with the reason it could not be produced.
func Insert(ctx context.Context, event json.RawMessage, reason string) error {
	row, _ := json.Marshal(map[string]any{"event": event, "reason": reason})
	return rdb.RPush(ctx, Key, row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'gateway/auth.h': `// Tenant authentication (provided): the bearer token is the tenant id.
#pragma once

#include <httplib.h>

#include <optional>
#include <string>

namespace gateway {

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

}  // namespace gateway
`,
  'gateway/outbox.h': `// The usage outbox (provided): insert(event_json, reason) appends the event to the Redis list
// outbox:usage as JSON ({"event": …, "reason": …}); a relay produces the rows later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace gateway::outbox {

inline const std::string kKey = "outbox:usage";

inline void insert(const std::string& event_json, const std::string& reason) {
  static sw::redis::Redis redis("tcp://redis:6379");
  nlohmann::json row;
  row["event"] = nlohmann::json::parse(event_json);
  row["reason"] = reason;
  redis.rpush(kKey, row.dump());
}

}  // namespace gateway::outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('gateway', 'Auth')]: `package gateway

/** Tenant authentication (provided): the bearer token is the tenant id. */
object Auth {
  /** The tenant named by \`Authorization: Bearer <tenant>\`; None when the header is missing or malformed (answer 401). */
  def tenant(authorization: Option[String]): Option[String] =
    authorization.filter(_.startsWith("Bearer ")).map(_.drop(7).trim).filter(_.nonEmpty)
}
`,
  [scalaPath('gateway', 'Outbox')]: `package gateway

import redis.clients.jedis.JedisPooled

/**
 * The usage outbox (provided): \`insert(eventJson, reason)\` appends the event to the Redis list
 * \`outbox:usage\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
 */
object Outbox {
  val Key = "outbox:usage"
  private val jedis = new JedisPooled("redis", 6379)

  def insert(eventJson: String, reason: String): Unit =
    jedis.rpush(Key, s"""{"event":$eventJson,"reason":"\${reason.replace("\\"", "'")}"}""")
}
`,
};
