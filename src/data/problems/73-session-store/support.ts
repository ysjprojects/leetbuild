/**
 * Hand-written support modules the session-store steps import but no step builds: the `sessions`
 * package. `sessions.store` is the session store: one Redis hash per session, the set of a user's
 * session ids, the assertions the login flow leaves for a token, and the outbox. `sessions.state` is
 * the session lifecycle of step 2 as later steps use it: `rotate_session` (one Lua script) and
 * `touch_session` (sliding expiry under the absolute cap). The five languages keep the same keys, so
 * a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'sessions/__init__.py': '',
  'sessions/store.py': `"""
The session store (provided). session:{id} is one hash per session: user_id, device_class,
token_hash (the SHA-256 of the auth token the session was opened with), created_at and last_seen
(epoch seconds) and rotation (how often the id changed); it expires SLIDING_TTL_S after its last use.
user:{id}:sessions is the set of a user's session ids. assertion:{token} is what the login flow
(password, MFA) left for a token: user_id, device_class and status, "complete" once every factor
passed. outbox is the list of events the broker did not take, each JSON {topic, key, payload}.
"""
import hashlib
import json
import secrets
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SLIDING_TTL_S = 15 * 60  # idle timeout: a session unused this long is gone
ABSOLUTE_TTL_S = 8 * 60 * 60  # hard cap from created_at, however often the session is used


def session_key(session_id: str) -> str:
    return f"session:{session_id}"


def user_key(user_id: str) -> str:
    return f"user:{user_id}:sessions"


def new_session_id() -> str:
    """A fresh, unguessable session id (32 hex digits)."""
    return secrets.token_hex(16)


def token_hash(token: str) -> str:
    """The SHA-256 of a token, hex: what the store and the events carry instead of the token."""
    return hashlib.sha256(token.encode()).hexdigest()


def assertion(token: str) -> dict | None:
    """What the login flow asserted for the token ({user_id, device_class, status}), or None."""
    raw = r.hgetall(f"assertion:{token}") if token else {}
    return raw or None


def put_session(session_id: str, user_id: str, device_class: str, token: str) -> None:
    """Write a new session (rotation 0, created and last seen now) and add it to the user's set."""
    now = int(time.time())
    key = session_key(session_id)
    r.hset(
        key,
        mapping={
            "user_id": user_id,
            "device_class": device_class,
            "token_hash": token_hash(token),
            "created_at": now,
            "last_seen": now,
            "rotation": 0,
        },
    )
    r.expire(key, SLIDING_TTL_S)
    r.sadd(user_key(user_id), session_id)


def retire_session(session_id: str) -> None:
    """Delete a session and take it out of its user's set."""
    key = session_key(session_id)
    user_id = r.hget(key, "user_id")
    r.delete(key)
    if user_id:
        r.srem(user_key(user_id), session_id)


def read_session(session_id: str) -> dict | None:
    """The session's record, or None when it expired or was retired."""
    raw = r.hgetall(session_key(session_id))
    if "user_id" not in raw:
        return None
    return {
        "session_id": session_id,
        "user_id": raw["user_id"],
        "device_class": raw.get("device_class", ""),
        "token_hash": raw.get("token_hash", ""),
        "created_at": int(raw.get("created_at") or 0),
        "last_seen": int(raw.get("last_seen") or 0),
        "rotation": int(raw.get("rotation") or 0),
    }


def user_sessions(user_id: str) -> list[str]:
    """The ids in the user's set, sorted. An id whose session expired stays here until something removes it."""
    return sorted(r.smembers(user_key(user_id)))


def outbox_add(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take; a relay publishes the outbox later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'sessions/state.py': `"""
The session lifecycle (provided; step 2 builds the same two functions). rotate_session moves a live
session to a fresh id in one Lua script: same user, device, token hash and created_at, rotation + 1,
the old id deleted and the user's set updated; a session past its absolute cap is retired instead and
None returned. touch_session is one use of a session: past created_at + ABSOLUTE_TTL_S it is retired
and None returned; otherwise last_seen moves to now and the expiry slides to SLIDING_TTL_S, never past
the cap.
"""
import time

import redis

from sessions import store

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ROTATE_LUA = """
local rec = redis.call('HGETALL', KEYS[1])
if #rec == 0 then return 0 end
local f = {}
for i = 1, #rec, 2 do f[rec[i]] = rec[i + 1] end
local users = 'user:' .. f['user_id'] .. ':sessions'
local left = tonumber(f['created_at']) + tonumber(ARGV[5]) - tonumber(ARGV[3])
redis.call('DEL', KEYS[1])
redis.call('SREM', users, ARGV[1])
if left <= 0 then return 0 end
redis.call('HSET', KEYS[2], 'user_id', f['user_id'], 'device_class', f['device_class'], 'token_hash', f['token_hash'],
  'created_at', f['created_at'], 'last_seen', ARGV[3], 'rotation', tonumber(f['rotation']) + 1)
redis.call('EXPIRE', KEYS[2], math.min(tonumber(ARGV[4]), left))
redis.call('SADD', users, ARGV[2])
return 1
"""
rotate = r.register_script(ROTATE_LUA)


def rotate_session(old_id: str) -> str | None:
    """Move a live session to a fresh id; None when the old one is gone or past its cap."""
    new_id = store.new_session_id()
    moved = rotate(
        keys=[store.session_key(old_id), store.session_key(new_id)],
        args=[old_id, new_id, int(time.time()), store.SLIDING_TTL_S, store.ABSOLUTE_TTL_S],
    )
    return new_id if moved == 1 else None


def touch_session(session_id: str) -> dict | None:
    """One use of a session: its record with last_seen now, or None when it is gone or past its cap."""
    record = store.read_session(session_id)
    if record is None:
        return None
    now = int(time.time())
    left = record["created_at"] + store.ABSOLUTE_TTL_S - now
    if left <= 0:
        store.retire_session(session_id)
        return None
    key = store.session_key(session_id)
    r.hset(key, "last_seen", now)
    r.expire(key, min(store.SLIDING_TTL_S, left))
    return {**record, "last_seen": now}
`,
};

export const supportModulesTs: Record<string, string> = {
  'sessions/store.ts': `/**
 * The session store (provided). session:{id} is one hash per session: user_id, device_class,
 * token_hash (the SHA-256 of the auth token the session was opened with), created_at and last_seen
 * (epoch seconds) and rotation (how often the id changed); it expires SLIDING_TTL_S after its last
 * use. user:{id}:sessions is the set of a user's session ids. assertion:{token} is what the login
 * flow (password, MFA) left for a token: user_id, device_class and status, "complete" once every
 * factor passed. outbox is the list of events the broker did not take, each JSON {topic, key, payload}.
 */
import {createHash, randomUUID} from 'crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Idle timeout: a session unused this long is gone. */
export const SLIDING_TTL_S = 15 * 60;
/** Hard cap from created_at, however often the session is used. */
export const ABSOLUTE_TTL_S = 8 * 60 * 60;

export interface Session {
  session_id: string;
  user_id: string;
  device_class: string;
  token_hash: string;
  created_at: number;
  last_seen: number;
  rotation: number;
}

export interface Assertion {
  user_id: string;
  device_class: string;
  status: string;
}

export const sessionKey = (sessionId: string): string => \`session:\${sessionId}\`;
export const userKey = (userId: string): string => \`user:\${userId}:sessions\`;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A fresh, unguessable session id (32 hex digits). */
export const newSessionId = (): string => randomUUID().replace(/-/g, '');

/** The SHA-256 of a token, hex: what the store and the events carry instead of the token. */
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** What the login flow asserted for the token, or null. */
export async function assertion(token: string): Promise<Assertion | null> {
  if (!token) return null;
  const raw = await redis.hgetall(\`assertion:\${token}\`);
  return Object.keys(raw).length === 0 ? null : {user_id: raw.user_id, device_class: raw.device_class, status: raw.status};
}

/** Write a new session (rotation 0, created and last seen now) and add it to the user's set. */
export async function putSession(sessionId: string, userId: string, deviceClass: string, token: string): Promise<void> {
  const now = String(nowSeconds());
  const key = sessionKey(sessionId);
  await redis.hset(key, {user_id: userId, device_class: deviceClass, token_hash: tokenHash(token), created_at: now, last_seen: now, rotation: '0'});
  await redis.expire(key, SLIDING_TTL_S);
  await redis.sadd(userKey(userId), sessionId);
}

/** Delete a session and take it out of its user's set. */
export async function retireSession(sessionId: string): Promise<void> {
  const key = sessionKey(sessionId);
  const userId = await redis.hget(key, 'user_id');
  await redis.del(key);
  if (userId) await redis.srem(userKey(userId), sessionId);
}

/** The session's record, or null when it expired or was retired. */
export async function readSession(sessionId: string): Promise<Session | null> {
  const raw = await redis.hgetall(sessionKey(sessionId));
  if (raw.user_id === undefined) return null;
  return {
    session_id: sessionId,
    user_id: raw.user_id,
    device_class: raw.device_class ?? '',
    token_hash: raw.token_hash ?? '',
    created_at: Number(raw.created_at ?? 0),
    last_seen: Number(raw.last_seen ?? 0),
    rotation: Number(raw.rotation ?? 0),
  };
}

/** The ids in the user's set, sorted. An id whose session expired stays here until something removes it. */
export async function userSessions(userId: string): Promise<string[]> {
  return (await redis.smembers(userKey(userId))).sort();
}

/** Keep an event the broker did not take; a relay publishes the outbox later. */
export async function outboxAdd(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'sessions/state.ts': `/**
 * The session lifecycle (provided; step 2 builds the same two functions). rotateSession moves a live
 * session to a fresh id in one Lua script: same user, device, token hash and created_at, rotation + 1,
 * the old id deleted and the user's set updated; a session past its absolute cap is retired instead
 * and null returned. touchSession is one use of a session: past created_at + ABSOLUTE_TTL_S it is
 * retired and null returned; otherwise last_seen moves to now and the expiry slides to SLIDING_TTL_S,
 * never past the cap.
 */
import Redis from 'ioredis';

import {ABSOLUTE_TTL_S, SLIDING_TTL_S, type Session, newSessionId, readSession, retireSession, sessionKey} from './store';

export const ROTATE_LUA = \`
local rec = redis.call('HGETALL', KEYS[1])
if #rec == 0 then return 0 end
local f = {}
for i = 1, #rec, 2 do f[rec[i]] = rec[i + 1] end
local users = 'user:' .. f['user_id'] .. ':sessions'
local left = tonumber(f['created_at']) + tonumber(ARGV[5]) - tonumber(ARGV[3])
redis.call('DEL', KEYS[1])
redis.call('SREM', users, ARGV[1])
if left <= 0 then return 0 end
redis.call('HSET', KEYS[2], 'user_id', f['user_id'], 'device_class', f['device_class'], 'token_hash', f['token_hash'],
  'created_at', f['created_at'], 'last_seen', ARGV[3], 'rotation', tonumber(f['rotation']) + 1)
redis.call('EXPIRE', KEYS[2], math.min(tonumber(ARGV[4]), left))
redis.call('SADD', users, ARGV[2])
return 1
\`;

interface RotateRedis extends Redis {
  rotate(oldKey: string, newKey: string, oldId: string, newId: string, now: number, sliding: number, absolute: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as RotateRedis;
redis.defineCommand('rotate', {numberOfKeys: 2, lua: ROTATE_LUA});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Move a live session to a fresh id; null when the old one is gone or past its cap. */
export async function rotateSession(oldId: string): Promise<string | null> {
  const newId = newSessionId();
  const moved = await redis.rotate(sessionKey(oldId), sessionKey(newId), oldId, newId, nowSeconds(), SLIDING_TTL_S, ABSOLUTE_TTL_S);
  return moved === 1 ? newId : null;
}

/** One use of a session: its record with last_seen now, or null when it is gone or past its cap. */
export async function touchSession(sessionId: string): Promise<Session | null> {
  const record = await readSession(sessionId);
  if (record === null) return null;
  const now = nowSeconds();
  const left = record.created_at + ABSOLUTE_TTL_S - now;
  if (left <= 0) {
    await retireSession(sessionId);
    return null;
  }
  await redis.hset(sessionKey(sessionId), 'last_seen', String(now));
  await redis.expire(sessionKey(sessionId), Math.min(SLIDING_TTL_S, left));
  return {...record, last_seen: now};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'sessions/store/store.go': `// Package store is the session store (provided). session:{id} is one hash per session: user_id,
// device_class, token_hash (the SHA-256 of the auth token the session was opened with), created_at
// and last_seen (epoch seconds) and rotation (how often the id changed); it expires SlidingTTLSeconds
// after its last use. user:{id}:sessions is the set of a user's session ids. assertion:{token} is
// what the login flow (password, MFA) left for a token: user_id, device_class and status, "complete"
// once every factor passed. outbox is the list of events the broker did not take, each JSON
// {topic, key, payload}.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	// SlidingTTLSeconds is the idle timeout: a session unused this long is gone.
	SlidingTTLSeconds int64 = 15 * 60
	// AbsoluteTTLSeconds is the hard cap from created_at, however often the session is used.
	AbsoluteTTLSeconds int64 = 8 * 60 * 60
)

// Session is one session's record.
type Session struct {
	SessionID   string \`json:"session_id"\`
	UserID      string \`json:"user_id"\`
	DeviceClass string \`json:"device_class"\`
	TokenHash   string \`json:"token_hash"\`
	CreatedAt   int64  \`json:"created_at"\`
	LastSeen    int64  \`json:"last_seen"\`
	Rotation    int64  \`json:"rotation"\`
}

// Assertion is what the login flow asserted for a token.
type Assertion struct {
	UserID      string
	DeviceClass string
	Status      string
}

// SessionKey is the hash of one session.
func SessionKey(sessionID string) string { return "session:" + sessionID }

// UserKey is the set of a user's session ids.
func UserKey(userID string) string { return "user:" + userID + ":sessions" }

// NewSessionID is a fresh, unguessable session id (32 hex digits).
func NewSessionID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// TokenHash is the SHA-256 of a token, hex: what the store and the events carry instead of the token.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// AssertionFor is what the login flow asserted for the token, or nil.
func AssertionFor(ctx context.Context, token string) *Assertion {
	if token == "" {
		return nil
	}
	raw := rdb.HGetAll(ctx, "assertion:"+token).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Assertion{UserID: raw["user_id"], DeviceClass: raw["device_class"], Status: raw["status"]}
}

// PutSession writes a new session (rotation 0, created and last seen now) and adds it to the user's set.
func PutSession(ctx context.Context, sessionID, userID, deviceClass, token string) error {
	now := time.Now().Unix()
	key := SessionKey(sessionID)
	if err := rdb.HSet(ctx, key, "user_id", userID, "device_class", deviceClass, "token_hash", TokenHash(token),
		"created_at", now, "last_seen", now, "rotation", 0).Err(); err != nil {
		return err
	}
	if err := rdb.Expire(ctx, key, time.Duration(SlidingTTLSeconds)*time.Second).Err(); err != nil {
		return err
	}
	return rdb.SAdd(ctx, UserKey(userID), sessionID).Err()
}

// RetireSession deletes a session and takes it out of its user's set.
func RetireSession(ctx context.Context, sessionID string) error {
	key := SessionKey(sessionID)
	userID := rdb.HGet(ctx, key, "user_id").Val()
	if err := rdb.Del(ctx, key).Err(); err != nil {
		return err
	}
	if userID != "" {
		return rdb.SRem(ctx, UserKey(userID), sessionID).Err()
	}
	return nil
}

// ReadSession is the session's record, or nil when it expired or was retired.
func ReadSession(ctx context.Context, sessionID string) *Session {
	raw := rdb.HGetAll(ctx, SessionKey(sessionID)).Val()
	userID, ok := raw["user_id"]
	if !ok {
		return nil
	}
	number := func(name string) int64 {
		n, _ := strconv.ParseInt(raw[name], 10, 64)
		return n
	}
	return &Session{SessionID: sessionID, UserID: userID, DeviceClass: raw["device_class"], TokenHash: raw["token_hash"],
		CreatedAt: number("created_at"), LastSeen: number("last_seen"), Rotation: number("rotation")}
}

// UserSessions is the ids in the user's set, sorted. An id whose session expired stays here until something removes it.
func UserSessions(ctx context.Context, userID string) []string {
	ids := rdb.SMembers(ctx, UserKey(userID)).Val()
	sort.Strings(ids)
	return ids
}

// OutboxAdd keeps an event the broker did not take; a relay publishes the outbox later.
func OutboxAdd(ctx context.Context, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}
`,
  'sessions/state/state.go': `// Package state is the session lifecycle (provided; step 2 builds the same two functions).
// RotateSession moves a live session to a fresh id in one Lua script: same user, device, token hash
// and created_at, rotation + 1, the old id deleted and the user's set updated; a session past its
// absolute cap is retired instead and "" returned. TouchSession is one use of a session: past
// created_at + AbsoluteTTLSeconds it is retired and nil returned; otherwise last_seen moves to now
// and the expiry slides to SlidingTTLSeconds, never past the cap.
package state

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"sessions/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Rotate is the rotation script: KEYS old and new session, ARGV old id, new id, now, sliding, absolute.
var Rotate = redis.NewScript(\`
local rec = redis.call('HGETALL', KEYS[1])
if #rec == 0 then return 0 end
local f = {}
for i = 1, #rec, 2 do f[rec[i]] = rec[i + 1] end
local users = 'user:' .. f['user_id'] .. ':sessions'
local left = tonumber(f['created_at']) + tonumber(ARGV[5]) - tonumber(ARGV[3])
redis.call('DEL', KEYS[1])
redis.call('SREM', users, ARGV[1])
if left <= 0 then return 0 end
redis.call('HSET', KEYS[2], 'user_id', f['user_id'], 'device_class', f['device_class'], 'token_hash', f['token_hash'],
  'created_at', f['created_at'], 'last_seen', ARGV[3], 'rotation', tonumber(f['rotation']) + 1)
redis.call('EXPIRE', KEYS[2], math.min(tonumber(ARGV[4]), left))
redis.call('SADD', users, ARGV[2])
return 1
\`)

// RotateSession moves a live session to a fresh id; "" when the old one is gone or past its cap.
func RotateSession(ctx context.Context, oldID string) (string, error) {
	newID := store.NewSessionID()
	moved, err := Rotate.Run(ctx, rdb, []string{store.SessionKey(oldID), store.SessionKey(newID)},
		oldID, newID, time.Now().Unix(), store.SlidingTTLSeconds, store.AbsoluteTTLSeconds).Int64()
	if err != nil || moved != 1 {
		return "", err
	}
	return newID, nil
}

// TouchSession is one use of a session: its record with last_seen now, or nil when it is gone or past its cap.
func TouchSession(ctx context.Context, sessionID string) (*store.Session, error) {
	record := store.ReadSession(ctx, sessionID)
	if record == nil {
		return nil, nil
	}
	now := time.Now().Unix()
	left := record.CreatedAt + store.AbsoluteTTLSeconds - now
	if left <= 0 {
		return nil, store.RetireSession(ctx, sessionID)
	}
	ttl := store.SlidingTTLSeconds
	if left < ttl {
		ttl = left
	}
	if err := rdb.HSet(ctx, store.SessionKey(sessionID), "last_seen", now).Err(); err != nil {
		return nil, err
	}
	if err := rdb.Expire(ctx, store.SessionKey(sessionID), time.Duration(ttl)*time.Second).Err(); err != nil {
		return nil, err
	}
	record.LastSeen = now
	return record, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'sessions/store.h': `// The session store (provided). session:{id} is one hash per session: user_id, device_class,
// token_hash (the SHA-256 of the auth token the session was opened with), created_at and last_seen
// (epoch seconds) and rotation (how often the id changed); it expires kSlidingTtlS after its last use.
// user:{id}:sessions is the set of a user's session ids. assertion:{token} is what the login flow
// (password, MFA) left for a token: user_id, device_class and status, "complete" once every factor
// passed. outbox is the list of events the broker did not take, each JSON {topic, key, payload}.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <optional>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

constexpr long long kSlidingTtlS = 15 * 60;      // idle timeout: a session unused this long is gone
constexpr long long kAbsoluteTtlS = 8 * 60 * 60;  // hard cap from created_at, however often the session is used

struct Session {
  std::string session_id;
  std::string user_id;
  std::string device_class;
  std::string token_hash;
  long long created_at = 0;
  long long last_seen = 0;
  long long rotation = 0;
};

struct Assertion {
  std::string user_id;
  std::string device_class;
  std::string status;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

inline std::string sessionKey(const std::string& session_id) { return "session:" + session_id; }
inline std::string userKey(const std::string& user_id) { return "user:" + user_id + ":sessions"; }

inline std::string hexOf(const unsigned char* bytes, size_t n) {
  std::string out;
  char buf[3];
  for (size_t i = 0; i < n; i++) {
    std::snprintf(buf, sizeof buf, "%02x", bytes[i]);
    out += buf;
  }
  return out;
}

// A fresh, unguessable session id (32 hex digits).
inline std::string newSessionId() {
  static std::mt19937_64 gen{std::random_device{}()};
  unsigned char bytes[16];
  for (unsigned char& b : bytes) b = static_cast<unsigned char>(gen() & 0xff);
  return hexOf(bytes, sizeof bytes);
}

// The SHA-256 of a token, hex: what the store and the events carry instead of the token.
inline std::string tokenHash(const std::string& token) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(token.data()), token.size(), digest);
  return hexOf(digest, sizeof digest);
}

// What the login flow asserted for the token, or none.
inline std::optional<Assertion> assertion(const std::string& token) {
  if (token.empty()) return std::nullopt;
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("assertion:" + token);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Assertion{text("user_id"), text("device_class"), text("status")};
}

// Write a new session (rotation 0, created and last seen now) and add it to the user's set.
inline void putSession(const std::string& session_id, const std::string& user_id, const std::string& device_class, const std::string& token) {
  const std::string now = std::to_string(nowSeconds());
  const std::string key = sessionKey(session_id);
  redis().hset(key, {std::make_pair(std::string("user_id"), user_id), std::make_pair(std::string("device_class"), device_class),
                     std::make_pair(std::string("token_hash"), tokenHash(token)), std::make_pair(std::string("created_at"), now),
                     std::make_pair(std::string("last_seen"), now), std::make_pair(std::string("rotation"), std::string("0"))});
  redis().expire(key, kSlidingTtlS);
  redis().sadd(userKey(user_id), session_id);
}

// Delete a session and take it out of its user's set.
inline void retireSession(const std::string& session_id) {
  const std::string key = sessionKey(session_id);
  const auto user_id = redis().hget(key, "user_id");
  redis().del(key);
  if (user_id && !user_id->empty()) redis().srem(userKey(*user_id), session_id);
}

// The session's record, or none when it expired or was retired.
inline std::optional<Session> readSession(const std::string& session_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(sessionKey(session_id));
  if (!raw.count("user_id")) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0LL : std::stoll(text(name)); };
  return Session{session_id, text("user_id"), text("device_class"), text("token_hash"), number("created_at"), number("last_seen"), number("rotation")};
}

// The ids in the user's set, sorted. An id whose session expired stays here until something removes it.
inline std::vector<std::string> userSessions(const std::string& user_id) {
  std::vector<std::string> ids = redis().smembers(userKey(user_id));
  std::sort(ids.begin(), ids.end());
  return ids;
}

// Keep an event the broker did not take; a relay publishes the outbox later.
inline void outboxAdd(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'sessions/state.h': `// The session lifecycle (provided; step 2 builds the same two functions). rotateSession moves a live
// session to a fresh id in one Lua script: same user, device, token hash and created_at, rotation + 1,
// the old id deleted and the user's set updated; a session past its absolute cap is retired instead
// and none returned. touchSession is one use of a session: past created_at + kAbsoluteTtlS it is
// retired and none returned; otherwise last_seen moves to now and the expiry slides to kSlidingTtlS,
// never past the cap.
#pragma once

#include <algorithm>
#include <optional>
#include <string>

#include "sessions/store.h"

namespace state {

inline const std::string kRotateLua = R"lua(
local rec = redis.call('HGETALL', KEYS[1])
if #rec == 0 then return 0 end
local f = {}
for i = 1, #rec, 2 do f[rec[i]] = rec[i + 1] end
local users = 'user:' .. f['user_id'] .. ':sessions'
local left = tonumber(f['created_at']) + tonumber(ARGV[5]) - tonumber(ARGV[3])
redis.call('DEL', KEYS[1])
redis.call('SREM', users, ARGV[1])
if left <= 0 then return 0 end
redis.call('HSET', KEYS[2], 'user_id', f['user_id'], 'device_class', f['device_class'], 'token_hash', f['token_hash'],
  'created_at', f['created_at'], 'last_seen', ARGV[3], 'rotation', tonumber(f['rotation']) + 1)
redis.call('EXPIRE', KEYS[2], math.min(tonumber(ARGV[4]), left))
redis.call('SADD', users, ARGV[2])
return 1
)lua";

// Move a live session to a fresh id; none when the old one is gone or past its cap.
inline std::optional<std::string> rotateSession(const std::string& old_id) {
  const std::string new_id = store::newSessionId();
  const long long moved = store::redis().eval<long long>(
      kRotateLua, {store::sessionKey(old_id), store::sessionKey(new_id)},
      {old_id, new_id, std::to_string(store::nowSeconds()), std::to_string(store::kSlidingTtlS), std::to_string(store::kAbsoluteTtlS)});
  if (moved != 1) return std::nullopt;
  return new_id;
}

// One use of a session: its record with last_seen now, or none when it is gone or past its cap.
inline std::optional<store::Session> touchSession(const std::string& session_id) {
  auto record = store::readSession(session_id);
  if (!record) return std::nullopt;
  const long long now = store::nowSeconds();
  const long long left = record->created_at + store::kAbsoluteTtlS - now;
  if (left <= 0) {
    store::retireSession(session_id);
    return std::nullopt;
  }
  store::redis().hset(store::sessionKey(session_id), "last_seen", std::to_string(now));
  store::redis().expire(store::sessionKey(session_id), std::min(store::kSlidingTtlS, left));
  record->last_seen = now;
  return record;
}

}  // namespace state
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('sessions', 'Store')]: `package sessions

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The session store (provided). session:{id} is one hash per session: user_id, device_class,
 * token_hash (the SHA-256 of the auth token the session was opened with), created_at and last_seen
 * (epoch seconds) and rotation (how often the id changed); it expires SlidingTtlS after its last use.
 * user:{id}:sessions is the set of a user's session ids. assertion:{token} is what the login flow
 * (password, MFA) left for a token: user_id, device_class and status, "complete" once every factor
 * passed. outbox is the list of events the broker did not take, each JSON {topic, key, payload}.
 */
object Store {
  final case class Session(sessionId: String, userId: String, deviceClass: String, tokenHash: String, createdAt: Long, lastSeen: Long, rotation: Long)
  final case class Assertion(userId: String, deviceClass: String, status: String)

  /** Idle timeout: a session unused this long is gone. */
  val SlidingTtlS: Long = 15 * 60
  /** Hard cap from created_at, however often the session is used. */
  val AbsoluteTtlS: Long = 8 * 60 * 60

  val jedis = new JedisPooled("redis", 6379)

  def nowSeconds(): Long = System.currentTimeMillis() / 1000

  def sessionKey(sessionId: String): String = s"session:$sessionId"
  def userKey(userId: String): String = s"user:$userId:sessions"

  /** A fresh, unguessable session id (32 hex digits). */
  def newSessionId(): String = UUID.randomUUID().toString.replace("-", "")

  /** The SHA-256 of a token, hex: what the store and the events carry instead of the token. */
  def tokenHash(token: String): String =
    MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)).map(b => f"\${b & 0xff}%02x").mkString

  /** What the login flow asserted for the token, if anything. */
  def assertion(token: String): Option[Assertion] =
    if (token.isEmpty) None
    else {
      val raw = jedis.hgetAll(s"assertion:$token").asScala
      if (raw.isEmpty) None else Some(Assertion(raw.getOrElse("user_id", ""), raw.getOrElse("device_class", ""), raw.getOrElse("status", "")))
    }

  /** Write a new session (rotation 0, created and last seen now) and add it to the user's set. */
  def putSession(sessionId: String, userId: String, deviceClass: String, token: String): Unit = {
    val now = nowSeconds().toString
    val key = sessionKey(sessionId)
    jedis.hset(key, Map("user_id" -> userId, "device_class" -> deviceClass, "token_hash" -> tokenHash(token), "created_at" -> now, "last_seen" -> now, "rotation" -> "0").asJava)
    jedis.expire(key, SlidingTtlS)
    jedis.sadd(userKey(userId), sessionId)
  }

  /** Delete a session and take it out of its user's set. */
  def retireSession(sessionId: String): Unit = {
    val key = sessionKey(sessionId)
    val userId = Option(jedis.hget(key, "user_id"))
    jedis.del(key)
    userId.filter(_.nonEmpty).foreach(id => jedis.srem(userKey(id), sessionId))
  }

  /** The session's record, if it has not expired or been retired. */
  def readSession(sessionId: String): Option[Session] = {
    val raw = jedis.hgetAll(sessionKey(sessionId)).asScala
    raw.get("user_id").map { userId =>
      def number(name: String): Long = raw.get(name).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)
      Session(sessionId, userId, raw.getOrElse("device_class", ""), raw.getOrElse("token_hash", ""), number("created_at"), number("last_seen"), number("rotation"))
    }
  }

  /** The ids in the user's set, sorted. An id whose session expired stays here until something removes it. */
  def userSessions(userId: String): Seq[String] = jedis.smembers(userKey(userId)).asScala.toSeq.sorted

  /** Keep an event the broker did not take; a relay publishes the outbox later. */
  def outboxAdd(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('sessions', 'State')]: `package sessions

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The session lifecycle (provided; step 2 builds the same two functions). rotateSession moves a live
 * session to a fresh id in one Lua script: same user, device, token hash and created_at, rotation + 1,
 * the old id deleted and the user's set updated; a session past its absolute cap is retired instead
 * and None returned. touchSession is one use of a session: past createdAt + AbsoluteTtlS it is retired
 * and None returned; otherwise last_seen moves to now and the expiry slides to SlidingTtlS, never past
 * the cap.
 */
object State {
  val jedis = new JedisPooled("redis", 6379)

  val RotateLua: String =
    """local rec = redis.call('HGETALL', KEYS[1])
      |if #rec == 0 then return 0 end
      |local f = {}
      |for i = 1, #rec, 2 do f[rec[i]] = rec[i + 1] end
      |local users = 'user:' .. f['user_id'] .. ':sessions'
      |local left = tonumber(f['created_at']) + tonumber(ARGV[5]) - tonumber(ARGV[3])
      |redis.call('DEL', KEYS[1])
      |redis.call('SREM', users, ARGV[1])
      |if left <= 0 then return 0 end
      |redis.call('HSET', KEYS[2], 'user_id', f['user_id'], 'device_class', f['device_class'], 'token_hash', f['token_hash'],
      |  'created_at', f['created_at'], 'last_seen', ARGV[3], 'rotation', tonumber(f['rotation']) + 1)
      |redis.call('EXPIRE', KEYS[2], math.min(tonumber(ARGV[4]), left))
      |redis.call('SADD', users, ARGV[2])
      |return 1
      |""".stripMargin

  /** Move a live session to a fresh id; None when the old one is gone or past its cap. */
  def rotateSession(oldId: String): Option[String] = {
    val newId = Store.newSessionId()
    val keys = List(Store.sessionKey(oldId), Store.sessionKey(newId)).asJava
    val args = List(oldId, newId, Store.nowSeconds().toString, Store.SlidingTtlS.toString, Store.AbsoluteTtlS.toString).asJava
    val moved = jedis.eval(RotateLua, keys, args).asInstanceOf[java.lang.Long]
    if (moved == 1L) Some(newId) else None
  }

  /** One use of a session: its record with last_seen now, or None when it is gone or past its cap. */
  def touchSession(sessionId: String): Option[Store.Session] =
    Store.readSession(sessionId).flatMap { record =>
      val now = Store.nowSeconds()
      val left = record.createdAt + Store.AbsoluteTtlS - now
      if (left <= 0) {
        Store.retireSession(sessionId)
        None
      } else {
        jedis.hset(Store.sessionKey(sessionId), "last_seen", now.toString)
        jedis.expire(Store.sessionKey(sessionId), math.min(Store.SlidingTtlS, left))
        Some(record.copy(lastSeen = now))
      }
    }
}
`,
};
