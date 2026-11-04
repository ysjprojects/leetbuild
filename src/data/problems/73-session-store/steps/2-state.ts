import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Session state: a sliding expiry under a hard cap, rotated in one script',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the session lifecycle on the store (\`sessions.store\`, provided).
\`rotate_session(old_id)\` reads the old record, writes it under a fresh id with \`created_at\` and
\`last_seen\` set to now and \`rotation\` + 1, sets \`SLIDING_TTL_S\` on it and adds it to the user's
set, then deletes the old hash and removes the old id from the set. \`touch_session(session_id)\`,
called on every request, returns the record and moves \`last_seen\` to now. It serves the demo and
hides four flaws.

**Failure mode the checks target.** A user active all afternoon is signed out fifteen minutes after
logging in. Once the expiry slides, a stolen session used every few minutes never ends. A crash between
the rotation's writes leaves two live ids, and a rotated session starts its eight hours over.

- Each use slides the expiry back to \`SLIDING_TTL_S\` (15 min).
- No session outlives \`created_at + ABSOLUTE_TTL_S\` (8 h): \`touch_session\` and \`rotate_session\`
  retire one past it and answer \`None\`, and no expiry they set reaches past the cap.
- The rotation's writes run in one Lua script (or one \`MULTI\`/\`EXEC\`).
- A rotation keeps \`created_at\`; \`rotation\` counts up.`,
  sequence: {
    participants: ['Session API', 'Redis'],
    messages: [
      {from: 'Session API', to: 'Redis', label: 'HGETALL session:{id}', kind: 'sync'},
      {from: 'Session API', to: 'Session API', label: 'left = created_at + 8 h - now · ≤ 0 → retire', kind: 'sync'},
      {from: 'Session API', to: 'Redis', label: 'HSET last_seen · EXPIRE min(15 min, left)', kind: 'sync'},
      {from: 'Session API', to: 'Redis', label: 'EVAL rotate: copy under new id · DEL old · SREM/SADD', kind: 'sync'},
      {from: 'Redis', to: 'Session API', label: '1 (new id live) / 0 (gone or past the cap)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'sliding-ttl',
      title: 'Each use slides the expiry back to 15 minutes',
      detail:
        'A session used every 10 minutes is alive after half an hour, its key expiring 900 s after the last use; one idle for 15 minutes is gone. The starter never refreshes the expiry `put_session` set at login.',
      match: {
        python: {all: [/SLIDING_TTL_S/], order: [/def touch_session\(/, /\.expire\(/]},
        typescript: {all: [/SLIDING_TTL_S/], order: [/function touchSession\(/, /\.expire\(/]},
        go: {all: [/SlidingTTLSeconds/], order: [/func touchSession\(/, /\.Expire\(/]},
        scala: {all: [/SlidingTtlS/], order: [/def touchSession\(/, /\.expire\(/]},
        cpp: {all: [/kSlidingTtlS/], order: [/touchSession\(const std::string/, /\.expire\(/]},
      },
    },
    {
      id: 'absolute-cap',
      title: 'No session outlives created_at + 8 hours',
      detail:
        'Two minutes short of the cap a use answers the session with at most 120 s left on its key; past the cap it answers none and the session is retired. The starter never reads `created_at`.',
      match: {
        python: {order: [/def touch_session\(/, /ABSOLUTE_TTL_S/]},
        typescript: {order: [/function touchSession\(/, /ABSOLUTE_TTL_S/]},
        go: {order: [/func touchSession\(/, /store\.AbsoluteTTLSeconds/]},
        scala: {order: [/def touchSession\(/, /Store\.AbsoluteTtlS/]},
        cpp: {order: [/touchSession\(const std::string/, /store::kAbsoluteTtlS/]},
      },
    },
    {
      id: 'atomic-rotate',
      title: 'The rotation is one atomic step',
      detail:
        'Rotating sends no write on its own: the new hash, its expiry, the old hash and both set updates go in one `EVAL`/`EVALSHA` (or one `MULTI`/`EXEC`). The starter sends five separate writes.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(|\.evalsha\(|\.pipeline\(/],
          none: [/def rotate_session(?:(?!\ndef )[\s\S])*?\br\.(delete|hset|srem|sadd)\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(|\.evalsha\(|\.multi\(/],
          none: [/function rotateSession(?:(?!\nexport )[\s\S])*?redis\.(del|hset|srem|sadd)\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(|\.TxPipelined\(/],
          none: [/func rotateSession(?:(?!\n\})[\s\S])*?rdb\.(Del|HSet|SRem|SAdd)\(/],
        },
        scala: {
          all: [/jedis\.eval\(|\.multi\(/],
          none: [/def rotateSession(?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?jedis\.(del|hset|srem|sadd)\(/],
        },
        cpp: {
          all: [/\.eval<|\.transaction\(/],
          none: [/rotateSession\(const std::string(?:(?!\n\})[\s\S])*?redis\(\)\.(del|hset|srem|sadd)\(/],
        },
      },
    },
    {
      id: 'carry-created',
      title: 'A rotation keeps created_at',
      detail:
        'A session that logged in seven hours ago rotates to an id with the same `created_at`, `rotation` + 1 and at most an hour on its key; a session past its cap does not rotate. The starter writes `created_at` = now.',
      match: {
        python: {
          all: [/f\[['"]created_at['"]\]|record\[["']created_at["']\]/],
          none: [/["']created_at["']\s*:\s*now\b/],
        },
        typescript: {all: [/f\['created_at'\]|record\.created_at/], none: [/created_at:\s*now\b/]},
        go: {all: [/f\['created_at'\]|record\.CreatedAt/], none: [/"created_at",\s*now\b/]},
        scala: {all: [/f\['created_at'\]|record\.createdAt/], none: [/"created_at"\s*->\s*now\b/]},
        cpp: {all: [/f\['created_at'\]|record->created_at/], none: [/"created_at"\),\s*now\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from sessions import store  # SLIDING_TTL_S, ABSOLUTE_TTL_S, session_key, user_key, new_session_id, read_session, retire_session

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def rotate_session(old_id: str) -> str | None:
    """Move a live session to a fresh id: same user, device and token hash; None when the old one is gone."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = store.read_session(old_id)
    if record is None:
        return None
    new_id = store.new_session_id()
    now = int(time.time())
    new_key = store.session_key(new_id)
    r.hset(
        new_key,
        mapping={
            "user_id": record["user_id"],
            "device_class": record["device_class"],
            "token_hash": record["token_hash"],
            "created_at": now,
            "last_seen": now,
            "rotation": record["rotation"] + 1,
        },
    )
    r.expire(new_key, store.SLIDING_TTL_S)
    r.sadd(store.user_key(record["user_id"]), new_id)
    r.delete(store.session_key(old_id))
    r.srem(store.user_key(record["user_id"]), old_id)
    return new_id


def touch_session(session_id: str) -> dict | None:
    """One use of a session: its record with last_seen now, or None when it is gone."""
    record = store.read_session(session_id)
    if record is None:
        return None
    now = int(time.time())
    r.hset(store.session_key(session_id), "last_seen", now)
    return {**record, "last_seen": now}
`,
      solution: `import time

import redis

from sessions import store  # SLIDING_TTL_S, ABSOLUTE_TTL_S, session_key, user_key, new_session_id, read_session, retire_session

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: old session, new session. ARGV: old id, new id, now, SLIDING_TTL_S, ABSOLUTE_TTL_S.
# Every write of the rotation, or none of them: a crash cannot leave two live ids.
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
    """Move a live session to a fresh id: same user, device, token hash and created_at; None when the old one is gone or past its cap."""
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
    # Slide the idle timeout, never past the cap: Redis deletes the session on time even if nobody calls again.
    r.expire(key, min(store.SLIDING_TTL_S, left))
    return {**record, "last_seen": now}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {SLIDING_TTL_S, type Session, newSessionId, readSession, sessionKey, userKey} from 'sessions/store';

const redis = new Redis({host: 'redis', port: 6379});
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Move a live session to a fresh id: same user, device and token hash; null when the old one is gone. */
export async function rotateSession(oldId: string): Promise<string | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const record = await readSession(oldId);
  if (record === null) return null;
  const newId = newSessionId();
  const now = String(nowSeconds());
  await redis.hset(sessionKey(newId), {
    user_id: record.user_id,
    device_class: record.device_class,
    token_hash: record.token_hash,
    created_at: now,
    last_seen: now,
    rotation: String(record.rotation + 1),
  });
  await redis.expire(sessionKey(newId), SLIDING_TTL_S);
  await redis.sadd(userKey(record.user_id), newId);
  await redis.del(sessionKey(oldId));
  await redis.srem(userKey(record.user_id), oldId);
  return newId;
}

/** One use of a session: its record with last_seen now, or null when it is gone. */
export async function touchSession(sessionId: string): Promise<Session | null> {
  const record = await readSession(sessionId);
  if (record === null) return null;
  const now = nowSeconds();
  await redis.hset(sessionKey(sessionId), 'last_seen', String(now));
  return {...record, last_seen: now};
}
`,
      solution: `import Redis from 'ioredis';

import {ABSOLUTE_TTL_S, SLIDING_TTL_S, type Session, newSessionId, readSession, retireSession, sessionKey} from 'sessions/store';

/** KEYS: old session, new session. ARGV: old id, new id, now, SLIDING_TTL_S, ABSOLUTE_TTL_S. Every write of the rotation, or none of them. */
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

/** Move a live session to a fresh id: same user, device, token hash and created_at; null when the old one is gone or past its cap. */
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
  // Slide the idle timeout, never past the cap: Redis deletes the session on time even if nobody calls again.
  await redis.expire(sessionKey(sessionId), Math.min(SLIDING_TTL_S, left));
  return {...record, last_seen: now};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"sessions/store" // store.Session, SessionKey, UserKey, NewSessionID, ReadSession, RetireSession, SlidingTTLSeconds, AbsoluteTTLSeconds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// rotateSession moves a live session to a fresh id: same user, device and token hash; "" when the old one is gone.
func rotateSession(ctx context.Context, oldID string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	record := store.ReadSession(ctx, oldID)
	if record == nil {
		return "", nil
	}
	newID := store.NewSessionID()
	now := time.Now().Unix()
	newKey := store.SessionKey(newID)
	if err := rdb.HSet(ctx, newKey, "user_id", record.UserID, "device_class", record.DeviceClass, "token_hash", record.TokenHash,
		"created_at", now, "last_seen", now, "rotation", record.Rotation+1).Err(); err != nil {
		return "", err
	}
	rdb.Expire(ctx, newKey, time.Duration(store.SlidingTTLSeconds)*time.Second)
	rdb.SAdd(ctx, store.UserKey(record.UserID), newID)
	rdb.Del(ctx, store.SessionKey(oldID))
	rdb.SRem(ctx, store.UserKey(record.UserID), oldID)
	return newID, nil
}

// touchSession is one use of a session: its record with last_seen now, or nil when it is gone.
func touchSession(ctx context.Context, sessionID string) (*store.Session, error) {
	record := store.ReadSession(ctx, sessionID)
	if record == nil {
		return nil, nil
	}
	now := time.Now().Unix()
	if err := rdb.HSet(ctx, store.SessionKey(sessionID), "last_seen", now).Err(); err != nil {
		return nil, err
	}
	record.LastSeen = now
	return record, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"sessions/store" // store.Session, SessionKey, UserKey, NewSessionID, ReadSession, RetireSession, SlidingTTLSeconds, AbsoluteTTLSeconds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// rotateScript: KEYS old session, new session; ARGV old id, new id, now, sliding, absolute.
// Every write of the rotation, or none of them: a crash cannot leave two live ids.
var rotateScript = redis.NewScript(\`
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

// rotateSession moves a live session to a fresh id: same user, device, token hash and created_at; "" when the old one is gone or past its cap.
func rotateSession(ctx context.Context, oldID string) (string, error) {
	newID := store.NewSessionID()
	moved, err := rotateScript.Run(ctx, rdb, []string{store.SessionKey(oldID), store.SessionKey(newID)},
		oldID, newID, time.Now().Unix(), store.SlidingTTLSeconds, store.AbsoluteTTLSeconds).Int64()
	if err != nil || moved != 1 {
		return "", err
	}
	return newID, nil
}

// touchSession is one use of a session: its record with last_seen now, or nil when it is gone or past its cap.
func touchSession(ctx context.Context, sessionID string) (*store.Session, error) {
	record := store.ReadSession(ctx, sessionID)
	if record == nil {
		return nil, nil
	}
	now := time.Now().Unix()
	left := record.CreatedAt + store.AbsoluteTTLSeconds - now
	if left <= 0 {
		return nil, store.RetireSession(ctx, sessionID)
	}
	if err := rdb.HSet(ctx, store.SessionKey(sessionID), "last_seen", now).Err(); err != nil {
		return nil, err
	}
	// Slide the idle timeout, never past the cap: Redis deletes the session on time even if nobody calls again.
	ttl := min(store.SlidingTTLSeconds, left)
	if err := rdb.Expire(ctx, store.SessionKey(sessionID), time.Duration(ttl)*time.Second).Err(); err != nil {
		return nil, err
	}
	record.LastSeen = now
	return record, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import sessions.Store // Store.Session, sessionKey, userKey, newSessionId, readSession, retireSession, nowSeconds, SlidingTtlS, AbsoluteTtlS

object SessionState {
  private val jedis = new JedisPooled("redis", 6379)

  /** Move a live session to a fresh id: same user, device and token hash; None when the old one is gone. */
  def rotateSession(oldId: String): Option[String] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Store.readSession(oldId).map { record =>
      val newId = Store.newSessionId()
      val now = Store.nowSeconds().toString
      val newKey = Store.sessionKey(newId)
      jedis.hset(newKey, Map("user_id" -> record.userId, "device_class" -> record.deviceClass, "token_hash" -> record.tokenHash,
        "created_at" -> now, "last_seen" -> now, "rotation" -> (record.rotation + 1).toString).asJava)
      jedis.expire(newKey, Store.SlidingTtlS)
      jedis.sadd(Store.userKey(record.userId), newId)
      jedis.del(Store.sessionKey(oldId))
      jedis.srem(Store.userKey(record.userId), oldId)
      newId
    }
  }

  /** One use of a session: its record with last_seen now, or None when it is gone. */
  def touchSession(sessionId: String): Option[Store.Session] =
    Store.readSession(sessionId).map { record =>
      val now = Store.nowSeconds()
      jedis.hset(Store.sessionKey(sessionId), "last_seen", now.toString)
      record.copy(lastSeen = now)
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import sessions.Store // Store.Session, sessionKey, userKey, newSessionId, readSession, retireSession, nowSeconds, SlidingTtlS, AbsoluteTtlS

object SessionState {
  private val jedis = new JedisPooled("redis", 6379)

  /** KEYS: old session, new session. ARGV: old id, new id, now, SlidingTtlS, AbsoluteTtlS. Every write of the rotation, or none of them. */
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

  /** Move a live session to a fresh id: same user, device, token hash and created_at; None when the old one is gone or past its cap. */
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
        // Slide the idle timeout, never past the cap: Redis deletes the session on time even if nobody calls again.
        jedis.expire(Store.sessionKey(sessionId), math.min(Store.SlidingTtlS, left))
        Some(record.copy(lastSeen = now))
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <optional>
#include <string>
#include <utility>

#include "sessions/store.h"  // store::Session, redis, sessionKey, userKey, newSessionId, readSession, retireSession, nowSeconds, kSlidingTtlS, kAbsoluteTtlS

// Move a live session to a fresh id: same user, device and token hash; none when the old one is gone.
std::optional<std::string> rotateSession(const std::string& old_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto record = store::readSession(old_id);
  if (!record) return std::nullopt;
  const std::string new_id = store::newSessionId();
  const std::string now = std::to_string(store::nowSeconds());
  const std::string new_key = store::sessionKey(new_id);
  store::redis().hset(new_key, {std::make_pair(std::string("user_id"), record->user_id),
                                std::make_pair(std::string("device_class"), record->device_class),
                                std::make_pair(std::string("token_hash"), record->token_hash),
                                std::make_pair(std::string("created_at"), now),
                                std::make_pair(std::string("last_seen"), now),
                                std::make_pair(std::string("rotation"), std::to_string(record->rotation + 1))});
  store::redis().expire(new_key, store::kSlidingTtlS);
  store::redis().sadd(store::userKey(record->user_id), new_id);
  store::redis().del(store::sessionKey(old_id));
  store::redis().srem(store::userKey(record->user_id), old_id);
  return new_id;
}

// One use of a session: its record with last_seen now, or none when it is gone.
std::optional<store::Session> touchSession(const std::string& session_id) {
  auto record = store::readSession(session_id);
  if (!record) return std::nullopt;
  const long long now = store::nowSeconds();
  store::redis().hset(store::sessionKey(session_id), "last_seen", std::to_string(now));
  record->last_seen = now;
  return record;
}
`,
      solution: `#include <algorithm>
#include <optional>
#include <string>

#include "sessions/store.h"  // store::Session, redis, sessionKey, userKey, newSessionId, readSession, retireSession, nowSeconds, kSlidingTtlS, kAbsoluteTtlS

// KEYS: old session, new session. ARGV: old id, new id, now, kSlidingTtlS, kAbsoluteTtlS.
// Every write of the rotation, or none of them: a crash cannot leave two live ids.
const std::string kRotateLua = R"lua(
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

// Move a live session to a fresh id: same user, device, token hash and created_at; none when the old one is gone or past its cap.
std::optional<std::string> rotateSession(const std::string& old_id) {
  const std::string new_id = store::newSessionId();
  const long long moved = store::redis().eval<long long>(
      kRotateLua, {store::sessionKey(old_id), store::sessionKey(new_id)},
      {old_id, new_id, std::to_string(store::nowSeconds()), std::to_string(store::kSlidingTtlS), std::to_string(store::kAbsoluteTtlS)});
  if (moved != 1) return std::nullopt;
  return new_id;
}

// One use of a session: its record with last_seen now, or none when it is gone or past its cap.
std::optional<store::Session> touchSession(const std::string& session_id) {
  auto record = store::readSession(session_id);
  if (!record) return std::nullopt;
  const long long now = store::nowSeconds();
  const long long left = record->created_at + store::kAbsoluteTtlS - now;
  if (left <= 0) {
    store::retireSession(session_id);
    return std::nullopt;
  }
  store::redis().hset(store::sessionKey(session_id), "last_seen", std::to_string(now));
  // Slide the idle timeout, never past the cap: Redis deletes the session on time even if nobody calls again.
  store::redis().expire(store::sessionKey(session_id), std::min(store::kSlidingTtlS, left));
  record->last_seen = now;
  return record;
}
`,
    },
  },
  harness: {
    python: `from sessions import store

WRITES = {"HSET", "HMSET", "HSETNX", "DEL", "UNLINK", "SADD", "SREM", "EXPIRE", "PEXPIRE", "SET"}


def _session(session_id="s-1"):
    store.put_session(session_id, "u-1", "mobile", "tok-1")
    return session_id


def _now(ctx):
    return int(ctx.clock.time())


def check_sliding_ttl(ctx):
    m = ctx.load("state")
    sid = _session()
    for minute in (10, 20, 30):
        ctx.clock.advance(600)
        assert m.touch_session(sid) is not None, f"a session used every 10 minutes was gone at minute {minute}: each use must slide the expiry back to SLIDING_TTL_S"
        ttl = ctx.redis.ttl(store.session_key(sid))
        assert 890 <= ttl <= 900, f"right after a use at minute {minute} the session expires in {ttl} s, expected SLIDING_TTL_S = 900: the use did not slide the expiry"
    ctx.clock.advance(901)
    assert m.touch_session(sid) is None, "a session idle for more than 15 minutes still answered"


def check_absolute_cap(ctx):
    m = ctx.load("state")
    sid = _session()
    ctx.redis.hset(store.session_key(sid), "created_at", _now(ctx) - store.ABSOLUTE_TTL_S + 120)  # signed in 7 h 58 min ago
    assert m.touch_session(sid) is not None, "a session two minutes short of its cap must still answer"
    ttl = ctx.redis.ttl(store.session_key(sid))
    assert 0 < ttl <= 120, f"two minutes short of the cap a use left {ttl} s on the session: no expiry may reach past created_at + ABSOLUTE_TTL_S"
    late = _session("s-2")
    ctx.redis.hset(store.session_key(late), "created_at", _now(ctx) - store.ABSOLUTE_TTL_S - 1)  # in active use, past its 8 hours
    record = m.touch_session(late)
    assert record is None, f"a session past created_at + ABSOLUTE_TTL_S answered {record}: the cap holds however often it is used"
    assert store.read_session(late) is None and late not in store.user_sessions("u-1"), "a session past its cap must be retired, hash and set entry"


def check_atomic_rotate(ctx):
    m = ctx.load("state")
    sid = _session()
    commands = []
    original = m.r.execute_command

    def recording(*args, **kwargs):
        commands.append(str(args[0]).upper())
        return original(*args, **kwargs)

    m.r.execute_command = recording
    try:
        new_id = m.rotate_session(sid)
    finally:
        m.r.execute_command = original
    assert new_id and new_id != sid, f"rotate_session({sid!r}) returned {new_id!r}, expected a fresh id"
    loose = [c for c in commands if c in WRITES]
    assert not loose, f"rotate_session sent {commands} to Redis: the writes {loose} go one by one, and a crash between them leaves two live ids or none. Send them in one script (or one MULTI/EXEC)"
    assert store.read_session(sid) is None, "after the rotation the old id still reads"
    record = store.read_session(new_id)
    assert record is not None and record["user_id"] == "u-1", f"the new id holds {record}"
    assert store.user_sessions("u-1") == [new_id], f"u-1's set holds {store.user_sessions('u-1')}, expected only the new id"


def check_carry_created(ctx):
    m = ctx.load("state")
    sid = _session()
    created = _now(ctx) - 7 * 3600  # signed in seven hours ago
    ctx.redis.hset(store.session_key(sid), "created_at", created)
    new_id = m.rotate_session(sid)
    assert new_id is not None, "rotating a live session returned None"
    record = store.read_session(new_id)
    assert record is not None, "the rotated session is not in the store"
    assert record["created_at"] == created, f"the rotated session has created_at {record['created_at']}, expected {created}: a rotation that restarts the clock lets a session rotated every few hours live forever"
    assert record["rotation"] == 1 and record["token_hash"] == store.token_hash("tok-1"), f"the rotated session is {record}, expected rotation 1 and the same token hash"
    ttl = ctx.redis.ttl(store.session_key(new_id))
    assert 0 < ttl <= 3600, f"the rotated session expires in {ttl} s, but only an hour of its eight is left"
    late = _session("s-2")
    ctx.redis.hset(store.session_key(late), "created_at", _now(ctx) - store.ABSOLUTE_TTL_S - 1)
    rotated = m.rotate_session(late)
    assert rotated is None, f"a session past its cap rotated to {rotated}: rotation must not renew it"
    assert store.read_session(late) is None, "a session past its cap must be retired when it tries to rotate"
`,
    typescript: `const WRITES = new Set(['HSET', 'HMSET', 'HSETNX', 'DEL', 'UNLINK', 'SADD', 'SREM', 'EXPIRE', 'PEXPIRE', 'SET']);
const ATOMIC = new Set(['EVAL', 'EVALSHA', 'MULTI', 'EXEC']);

async function setup(ctx, sessionId = 's-1') {
  const store = ctx.load('/support/sessions/store.ts');
  await store.putSession(sessionId, 'u-1', 'mobile', 'tok-1');
  return {m: ctx.load('state'), store};
}

const nowSeconds = ctx => Math.floor(ctx.clock.now() / 1000);

export async function check_sliding_ttl(ctx) {
  const {m, store} = await setup(ctx);
  for (const minute of [10, 20, 30]) {
    ctx.clock.advance(600);
    assert((await m.touchSession('s-1')) !== null, \`a session used every 10 minutes was gone at minute \${minute}: each use must slide the expiry back to SLIDING_TTL_S\`);
    const ttl = ctx.redis.ttl(store.sessionKey('s-1'));
    assert(890 <= ttl && ttl <= 900, \`right after a use at minute \${minute} the session expires in \${ttl} s, expected SLIDING_TTL_S = 900: the use did not slide the expiry\`);
  }
  ctx.clock.advance(901);
  assert.equal(await m.touchSession('s-1'), null, 'a session idle for more than 15 minutes still answered');
}

export async function check_absolute_cap(ctx) {
  const {m, store} = await setup(ctx);
  ctx.redis.hset(store.sessionKey('s-1'), 'created_at', String(nowSeconds(ctx) - store.ABSOLUTE_TTL_S + 120)); // signed in 7 h 58 min ago
  assert((await m.touchSession('s-1')) !== null, 'a session two minutes short of its cap must still answer');
  const ttl = ctx.redis.ttl(store.sessionKey('s-1'));
  assert(0 < ttl && ttl <= 120, \`two minutes short of the cap a use left \${ttl} s on the session: no expiry may reach past created_at + ABSOLUTE_TTL_S\`);
  await store.putSession('s-2', 'u-1', 'mobile', 'tok-1');
  ctx.redis.hset(store.sessionKey('s-2'), 'created_at', String(nowSeconds(ctx) - store.ABSOLUTE_TTL_S - 1)); // in active use, past its 8 hours
  const record = await m.touchSession('s-2');
  assert.equal(record, null, \`a session past created_at + ABSOLUTE_TTL_S answered \${JSON.stringify(record)}: the cap holds however often it is used\`);
  assert((await store.readSession('s-2')) === null && !(await store.userSessions('u-1')).includes('s-2'), 'a session past its cap must be retired, hash and set entry');
}

export async function check_atomic_rotate(ctx) {
  const {m, store} = await setup(ctx);
  const before = ctx.redisRoundTrips().length;
  const newId = await m.rotateSession('s-1');
  const trips = ctx.redisRoundTrips().slice(before);
  assert(newId && newId !== 's-1', \`rotateSession('s-1') returned \${JSON.stringify(newId)}, expected a fresh id\`);
  const loose = trips.filter(trip => !trip.some(c => ATOMIC.has(c)) && trip.some(c => WRITES.has(c)));
  assert.equal(loose.length, 0, \`rotateSession made the round trips \${JSON.stringify(trips)}: the writes \${JSON.stringify(loose)} go on their own, and a crash between them leaves two live ids or none. Send them in one script (or one MULTI/EXEC)\`);
  assert.equal(await store.readSession('s-1'), null, 'after the rotation the old id still reads');
  const record = await store.readSession(newId);
  assert(record !== null && record.user_id === 'u-1', \`the new id holds \${JSON.stringify(record)}\`);
  assert.deepEqual(await store.userSessions('u-1'), [newId], "u-1's set must hold only the new id");
}

export async function check_carry_created(ctx) {
  const {m, store} = await setup(ctx);
  const created = nowSeconds(ctx) - 7 * 3600; // signed in seven hours ago
  ctx.redis.hset(store.sessionKey('s-1'), 'created_at', String(created));
  const newId = await m.rotateSession('s-1');
  assert(newId !== null, 'rotating a live session returned null');
  const record = await store.readSession(newId);
  assert(record !== null, 'the rotated session is not in the store');
  assert.equal(record.created_at, created, \`the rotated session has created_at \${record.created_at}, expected \${created}: a rotation that restarts the clock lets a session rotated every few hours live forever\`);
  assert(record.rotation === 1 && record.token_hash === store.tokenHash('tok-1'), \`the rotated session is \${JSON.stringify(record)}, expected rotation 1 and the same token hash\`);
  const ttl = ctx.redis.ttl(store.sessionKey(newId));
  assert(0 < ttl && ttl <= 3600, \`the rotated session expires in \${ttl} s, but only an hour of its eight is left\`);
  await store.putSession('s-2', 'u-1', 'mobile', 'tok-1');
  ctx.redis.hset(store.sessionKey('s-2'), 'created_at', String(nowSeconds(ctx) - store.ABSOLUTE_TTL_S - 1));
  const rotated = await m.rotateSession('s-2');
  assert.equal(rotated, null, \`a session past its cap rotated to \${rotated}: rotation must not renew it\`);
  assert.equal(await store.readSession('s-2'), null, 'a session past its cap must be retired when it tries to rotate');
}
`,
    go: `package main

import (
	"context"
	"slices"

	"sessions/store"

	"leetbuild/harness"
)

var (
	bg      = context.Background()
	writes  = []string{"HSET", "HMSET", "HSETNX", "DEL", "UNLINK", "SADD", "SREM", "EXPIRE", "PEXPIRE", "SET"}
	atomics = []string{"EVAL", "EVALSHA", "MULTI", "EXEC"}
)

func session(ctx *harness.Ctx, sessionID string) {
	ctx.NoError(store.PutSession(bg, sessionID, "u-1", "mobile", "tok-1"), "PutSession")
}

func nowSeconds(ctx *harness.Ctx) int64 { return ctx.Clock.Now() / 1000 }

func touch(ctx *harness.Ctx, sessionID string) *store.Session {
	record, err := touchSession(bg, sessionID)
	ctx.NoError(err, "touchSession(%s)", sessionID)
	return record
}

func rotate(ctx *harness.Ctx, sessionID string) string {
	newID, err := rotateSession(bg, sessionID)
	ctx.NoError(err, "rotateSession(%s)", sessionID)
	return newID
}

func CheckSlidingTtl(ctx *harness.Ctx) {
	session(ctx, "s-1")
	for _, minute := range []int{10, 20, 30} {
		ctx.Clock.Advance(600)
		ctx.Assert(touch(ctx, "s-1") != nil, "a session used every 10 minutes was gone at minute %d: each use must slide the expiry back to SlidingTTLSeconds", minute)
		ttl := ctx.Redis.TTL(store.SessionKey("s-1"))
		ctx.Assert(890 <= ttl && ttl <= 900, "right after a use at minute %d the session expires in %d s, expected 900: the use did not slide the expiry", minute, ttl)
	}
	ctx.Clock.Advance(901)
	ctx.Assert(touch(ctx, "s-1") == nil, "a session idle for more than 15 minutes still answered")
}

func CheckAbsoluteCap(ctx *harness.Ctx) {
	session(ctx, "s-1")
	ctx.Redis.Do("HSET", store.SessionKey("s-1"), "created_at", nowSeconds(ctx)-store.AbsoluteTTLSeconds+120) // signed in 7 h 58 min ago
	ctx.Assert(touch(ctx, "s-1") != nil, "a session two minutes short of its cap must still answer")
	ttl := ctx.Redis.TTL(store.SessionKey("s-1"))
	ctx.Assert(0 < ttl && ttl <= 120, "two minutes short of the cap a use left %d s on the session: no expiry may reach past created_at + AbsoluteTTLSeconds", ttl)
	session(ctx, "s-2")
	ctx.Redis.Do("HSET", store.SessionKey("s-2"), "created_at", nowSeconds(ctx)-store.AbsoluteTTLSeconds-1) // in active use, past its 8 hours
	record := touch(ctx, "s-2")
	ctx.Assert(record == nil, "a session past created_at + AbsoluteTTLSeconds answered %+v: the cap holds however often it is used", record)
	ctx.Assert(store.ReadSession(bg, "s-2") == nil && !slices.Contains(store.UserSessions(bg, "u-1"), "s-2"), "a session past its cap must be retired, hash and set entry")
}

func CheckAtomicRotate(ctx *harness.Ctx) {
	session(ctx, "s-1")
	before := len(ctx.Redis.RoundTrips())
	newID := rotate(ctx, "s-1")
	trips := ctx.Redis.RoundTrips()[before:]
	ctx.Assert(newID != "" && newID != "s-1", "rotateSession(s-1) returned %q, expected a fresh id", newID)
	var loose [][]string
	for _, trip := range trips {
		atomic, writing := false, false
		for _, c := range trip {
			atomic = atomic || slices.Contains(atomics, c)
			writing = writing || slices.Contains(writes, c)
		}
		if writing && !atomic {
			loose = append(loose, trip)
		}
	}
	ctx.Assert(len(loose) == 0, "rotateSession made the round trips %v: the writes %v go on their own, and a crash between them leaves two live ids or none. Send them in one script (or one MULTI/EXEC)", trips, loose)
	ctx.Assert(store.ReadSession(bg, "s-1") == nil, "after the rotation the old id still reads")
	record := store.ReadSession(bg, newID)
	ctx.Assert(record != nil && record.UserID == "u-1", "the new id holds %+v", record)
	ctx.Equal(store.UserSessions(bg, "u-1"), []string{newID}, "u-1's set must hold only the new id")
}

func CheckCarryCreated(ctx *harness.Ctx) {
	session(ctx, "s-1")
	created := nowSeconds(ctx) - 7*3600 // signed in seven hours ago
	ctx.Redis.Do("HSET", store.SessionKey("s-1"), "created_at", created)
	newID := rotate(ctx, "s-1")
	ctx.Assert(newID != "", "rotating a live session returned no id")
	record := store.ReadSession(bg, newID)
	ctx.Assert(record != nil, "the rotated session is not in the store")
	ctx.Equal(record.CreatedAt, created, "a rotation that restarts the clock lets a session rotated every few hours live forever; the rotated session's created_at")
	ctx.Assert(record.Rotation == 1 && record.TokenHash == store.TokenHash("tok-1"), "the rotated session is %+v, expected rotation 1 and the same token hash", record)
	ttl := ctx.Redis.TTL(store.SessionKey(newID))
	ctx.Assert(0 < ttl && ttl <= 3600, "the rotated session expires in %d s, but only an hour of its eight is left", ttl)
	session(ctx, "s-2")
	ctx.Redis.Do("HSET", store.SessionKey("s-2"), "created_at", nowSeconds(ctx)-store.AbsoluteTTLSeconds-1)
	rotated := rotate(ctx, "s-2")
	ctx.Equal(rotated, "", "a session past its cap must not rotate (rotation must not renew it); the new id")
	ctx.Assert(store.ReadSession(bg, "s-2") == nil, "a session past its cap must be retired when it tries to rotate")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "sessions/store.h"

namespace {

const std::set<std::string> kWrites = {"HSET", "HMSET", "HSETNX", "DEL", "UNLINK", "SADD", "SREM", "EXPIRE", "PEXPIRE", "SET"};
const std::set<std::string> kAtomic = {"EVAL", "EVALSHA", "MULTI", "EXEC"};

void session(const std::string& session_id) { store::putSession(session_id, "u-1", "mobile", "tok-1"); }

long long nowSeconds(harness::Ctx& ctx) { return ctx.Clock.Now() / 1000; }

bool contains(const std::vector<std::string>& ids, const std::string& id) { return std::find(ids.begin(), ids.end(), id) != ids.end(); }

}  // namespace

void CheckSlidingTtl(harness::Ctx& ctx) {
  session("s-1");
  for (const int minute : {10, 20, 30}) {
    ctx.Clock.Advance(600);
    ctx.Assert(touchSession("s-1").has_value(), "a session used every 10 minutes was gone at minute %d: each use must slide the expiry back to kSlidingTtlS", minute);
    const long long ttl = ctx.Redis.TTL(store::sessionKey("s-1"));
    ctx.Assert(890 <= ttl && ttl <= 900, "right after a use at minute %d the session expires in %d s, expected 900: the use did not slide the expiry", minute, ttl);
  }
  ctx.Clock.Advance(901);
  ctx.Assert(!touchSession("s-1").has_value(), "a session idle for more than 15 minutes still answered");
}

void CheckAbsoluteCap(harness::Ctx& ctx) {
  session("s-1");
  ctx.Redis.Do("HSET", store::sessionKey("s-1"), "created_at", nowSeconds(ctx) - store::kAbsoluteTtlS + 120);  // signed in 7 h 58 min ago
  ctx.Assert(touchSession("s-1").has_value(), "a session two minutes short of its cap must still answer");
  const long long ttl = ctx.Redis.TTL(store::sessionKey("s-1"));
  ctx.Assert(0 < ttl && ttl <= 120, "two minutes short of the cap a use left %d s on the session: no expiry may reach past created_at + kAbsoluteTtlS", ttl);
  session("s-2");
  ctx.Redis.Do("HSET", store::sessionKey("s-2"), "created_at", nowSeconds(ctx) - store::kAbsoluteTtlS - 1);  // in active use, past its 8 hours
  ctx.Assert(!touchSession("s-2").has_value(), "a session past created_at + kAbsoluteTtlS answered: the cap holds however often it is used");
  ctx.Assert(!store::readSession("s-2") && !contains(store::userSessions("u-1"), "s-2"), "a session past its cap must be retired, hash and set entry");
}

void CheckAtomicRotate(harness::Ctx& ctx) {
  session("s-1");
  const size_t before = ctx.Redis.RoundTrips().size();
  const std::string new_id = rotateSession("s-1").value_or("");
  const auto all = ctx.Redis.RoundTrips();
  const std::vector<std::vector<std::string>> trips(all.begin() + static_cast<long>(before), all.end());
  ctx.Assert(!new_id.empty() && new_id != "s-1", "rotateSession(s-1) returned %q, expected a fresh id", new_id);
  std::vector<std::vector<std::string>> loose;
  for (const auto& trip : trips) {
    const bool atomic = std::any_of(trip.begin(), trip.end(), [](const std::string& c) { return kAtomic.count(c) > 0; });
    const bool writing = std::any_of(trip.begin(), trip.end(), [](const std::string& c) { return kWrites.count(c) > 0; });
    if (writing && !atomic) loose.push_back(trip);
  }
  ctx.Assert(loose.empty(), "rotateSession made the round trips %v: the writes %v go on their own, and a crash between them leaves two live ids or none. Send them in one script (or one MULTI/EXEC)", trips, loose);
  ctx.Assert(!store::readSession("s-1"), "after the rotation the old id still reads");
  const auto record = store::readSession(new_id);
  ctx.Assert(record && record->user_id == "u-1", "the new id %s must hold u-1's session", new_id);
  ctx.Equal(store::userSessions("u-1"), std::vector<std::string>{new_id}, "u-1's set must hold only the new id");
}

void CheckCarryCreated(harness::Ctx& ctx) {
  session("s-1");
  const long long created = nowSeconds(ctx) - 7 * 3600;  // signed in seven hours ago
  ctx.Redis.Do("HSET", store::sessionKey("s-1"), "created_at", created);
  const auto new_id = rotateSession("s-1");
  ctx.Assert(new_id.has_value(), "rotating a live session returned none");
  const auto record = store::readSession(*new_id);
  ctx.Assert(record.has_value(), "the rotated session is not in the store");
  ctx.Equal(record->created_at, created, "a rotation that restarts the clock lets a session rotated every few hours live forever; the rotated session's created_at");
  ctx.Assert(record->rotation == 1 && record->token_hash == store::tokenHash("tok-1"), "the rotated session has rotation %d, expected 1 and the same token hash", record->rotation);
  const long long ttl = ctx.Redis.TTL(store::sessionKey(*new_id));
  ctx.Assert(0 < ttl && ttl <= 3600, "the rotated session expires in %d s, but only an hour of its eight is left", ttl);
  session("s-2");
  ctx.Redis.Do("HSET", store::sessionKey("s-2"), "created_at", nowSeconds(ctx) - store::kAbsoluteTtlS - 1);
  const auto rotated = rotateSession("s-2");
  ctx.Assert(!rotated.has_value(), "a session past its cap rotated to %s: rotation must not renew it", rotated.value_or(""));
  ctx.Assert(!store::readSession("s-2"), "a session past its cap must be retired when it tries to rotate");
}
`,
  },
  hints: [
    'Use a session every ten minutes: it is gone at minute fifteen. Rotate a session that signed in seven hours ago: the new id says it was created just now.',
    '`touch_session` writes `last_seen` but never the expiry `put_session` set, and never reads `created_at`. The rotation is five separate writes, and it writes now where the old `created_at` belongs.',
    'In `touch_session`: `left = created_at + ABSOLUTE_TTL_S - now`, retire and return `None` when `left <= 0`, else `EXPIRE` to `min(SLIDING_TTL_S, left)`. Move the rotation into one Lua script that copies `created_at` and caps the new expiry the same way.',
  ],
  debrief: `Two clocks bound a session: the idle one slides with every use, the absolute one starts at login and nothing moves it. Folding both into one Redis expiry, \`min(sliding, time left under the cap)\`, lets Redis delete the session on time even if nobody calls \`touch_session\` again, and carrying \`created_at\` across rotations keeps rotation from becoming a renewal. The rotation is one script because its writes are only correct together: the new id, the old one gone, and the user's set agreeing with both. Production stores also throttle \`last_seen\` writes to about one a minute, give the old id a few seconds of grace for requests already in flight when the cookie changed, and log every rotation for the audit trail.`,
};
