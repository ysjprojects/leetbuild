import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Session state: sliding TTL under a hard absolute cap',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter's \`rotate_session\` writes a session record to Redis under
\`session:{id}\` with a one-hour TTL set at write time, then deletes the old key in a second command.
The record holds the raw token and no creation time. It compiles and hides 5 flaws.

**Failure mode the checks target.** Two separate commands are not a rotation: \`SET new\` then \`DEL old\` is a
window in which both ids authenticate, and a crash inside it leaves a session nobody can revoke. A TTL set
once at login is not a sliding timeout, and with no \`created_at\` there is no hard cap, so a stolen token lives
until someone remembers to delete it. Storing the raw token turns a Redis dump into a credential leak.

Requirements:

- **Sliding idle timeout.** Every successful use refreshes the key's TTL to \`SLIDING_TTL_S\` (15 minutes),
  so an active session is not logged out.
- **Hard absolute cap.** The record carries \`created_at\`; a session older than \`ABSOLUTE_TTL_S\`
  (30 days) is dead no matter how often it is used. The sliding refresh must not extend past the cap.
- **Atomic rotation.** Rotating to a new id writes the replacement and retires the old id in **one atomic
  step** (one Lua \`EVAL\` or one \`MULTI\`/\`EXEC\`), so a crash between the two writes cannot leave two live
  ids for one user.
- **No raw token in Redis.** The record stores \`token_hash\` (a SHA-256 of the token), never the token
  itself; the token stays only in the client's cookie.
- The record is JSON with \`user_id\`, \`device_class\`, \`token_hash\`, \`created_at\` and \`rotation\`.`,
  sequence: {
    participants: ['Client', 'Session API', 'Session Store'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'request with session:{old_id}', kind: 'sync'},
      {from: 'Session API', to: 'Session Store', label: 'EVAL rotate · SET new · DEL old', kind: 'sync'},
      {from: 'Session Store', to: 'Session API', label: 'new id · sliding TTL', kind: 'reply'},
      {from: 'Session API', to: 'Session Store', label: 'EXPIRE session:{new_id} SLIDING_TTL_S', kind: 'sync'},
      {from: 'Session Store', to: 'Session API', label: 'record · created_at within cap', kind: 'reply'},
      {from: 'Session API', to: 'Client', label: '200 {session_id}', kind: 'reply'},
    ],
  },
  hints: [
    'A user who logged in a month ago and clicks once an hour is still signed in; after a crash mid-rotation, two of their ids both authenticate; a Redis dump exposes live tokens.',
    'The starter sets one TTL at write time and nothing refreshes it, keeps no `created_at` to cap against, runs `SET` and `DEL` as two round trips, and stores `token` verbatim.',
    'Add `SLIDING_TTL_S` and `ABSOLUTE_TTL_S`, store `created_at` and a `sha256` `token_hash`, run `SET new_key` plus `DEL old_key` in one Lua `EVAL`, and `expire` on each touch after the age check.',
  ],
  checks: [
    {
      id: 'sliding-ttl',
      title: 'Refreshes the sliding idle timeout on use',
      detail:
        'Every touch resets the key TTL to `SLIDING_TTL_S` with `EXPIRE`, so an active session is not logged out while an idle one is. The starter sets one long TTL at write time and never refreshes it.',
      match: {
        python: {all: [/SLIDING_TTL_S/, /expire\(/]},
        typescript: {all: [/SLIDING_TTL_S/, /expire\(/]},
        go: {all: [/slidingTTLS/, /Expire\(/]},
        scala: {all: [/SlidingTtlS/, /expire\(/]},
        cpp: {all: [/kSlidingTtlS/, /expire\(/]},
      },
    },
    {
      id: 'absolute-cap',
      title: 'Keeps a hard absolute cap the refresh cannot extend',
      detail:
        'The record carries `created_at` and the touch compares the age against `ABSOLUTE_TTL_S`, so a session past the cap is dead even if it is used every minute. The starter has neither the constant nor the creation time.',
      match: {
        python: {all: [/ABSOLUTE_TTL_S/, /created_at/]},
        typescript: {all: [/ABSOLUTE_TTL_S/, /created_at/]},
        go: {all: [/absoluteTTLS/, /CreatedAt/]},
        scala: {all: [/AbsoluteTtlS/, /createdAt/]},
        cpp: {all: [/kAbsoluteTtlS/, /created_at/]},
      },
    },
    {
      id: 'atomic-rotate',
      title: 'Rotates the id in one atomic step',
      detail:
        'The replacement write and the retirement of the old id run as one `EVAL` (or one `MULTI`/`EXEC`), so a crash cannot leave two live ids. The starter writes and deletes in separate commands.',
      match: {
        python: {all: [/\.eval\(/]},
        typescript: {all: [/\.eval\(/]},
        go: {all: [/\.Eval\(/]},
        scala: {all: [/\.eval\(/]},
        cpp: {all: [/\.eval\(/]},
      },
    },
    {
      id: 'hash-token',
      title: 'Stores a token hash, never the raw token',
      detail:
        'The record keeps `token_hash` derived from the token; the raw token is never written to Redis. The starter stores the token field verbatim.',
      match: {
        python: {all: [/sha256\(/, /token_hash/]},
        typescript: {all: [/createHash\(/, /token_hash/]},
        go: {all: [/sha256\.Sum256/, /TokenHash/]},
        scala: {all: [/SHA-256/, /tokenHash/]},
        cpp: {all: [/sha256/, /token_hash/]},
      },
    },
    {
      id: 'retire-old',
      title: 'Retires the old id as part of the rotation',
      detail:
        'The old key is deleted inside the atomic step (`DEL old_key` in the Lua script), so the retired id stops authenticating the moment the new one exists.',
      match: {
        python: {all: [/DEL/, /old_key/]},
        typescript: {all: [/DEL/, /old_key/]},
        go: {all: [/DEL/, /old_key/]},
        scala: {all: [/DEL/, /old_key/]},
        cpp: {all: [/DEL/, /old_key/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import redis.asyncio as redis

r = redis.Redis()

TTL_S = 60 * 60


async def rotate_session(old_id: str | None, user_id: str, device_class: str, token: str) -> str:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    new_id = f"{user_id}-{int(time.time())}"
    record = json.dumps(
        {
            "user_id": user_id,
            "device_class": device_class,
            "token": token,
            "rotation": 0,
        }
    )
    await r.set(f"session:{new_id}", record, ex=TTL_S)
    if old_id:
        await r.delete(f"session:{old_id}")
    return new_id
`,
      solution: `import hashlib
import json
import time
from uuid import uuid4

import redis.asyncio as redis

r = redis.Redis()

SLIDING_TTL_S = 15 * 60
ABSOLUTE_TTL_S = 30 * 24 * 60 * 60

# One atomic step: the replacement is written and the retired id removed together, so a crash can
# never leave two live ids for one user.
ROTATE_LUA = """
local new_key = KEYS[1]
local old_key = KEYS[2]
redis.call("SET", new_key, ARGV[1], "EX", tonumber(ARGV[2]))
if old_key ~= "" then
  redis.call("DEL", old_key)
end
return 1
"""


async def rotate_session(old_id: str | None, user_id: str, device_class: str, token: str) -> str:
    new_id = str(uuid4())
    record = json.dumps(
        {
            "user_id": user_id,
            "device_class": device_class,
            "token_hash": hashlib.sha256(token.encode()).hexdigest(),
            "created_at": int(time.time()),
            "rotation": 0,
        }
    )
    await r.eval(ROTATE_LUA, 2, f"session:{new_id}", f"session:{old_id}" if old_id else "", record, SLIDING_TTL_S)
    return new_id


async def touch_session(session_id: str) -> dict | None:
    raw = await r.get(f"session:{session_id}")
    if raw is None:
        return None
    record = json.loads(raw)
    if int(time.time()) - record["created_at"] > ABSOLUTE_TTL_S:
        await r.delete(f"session:{session_id}")
        return None
    await r.expire(f"session:{session_id}", SLIDING_TTL_S)
    return record
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'crypto';
import Redis from 'ioredis';

const redis = new Redis();
const TTL_S = 60 * 60;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
export async function rotateSession(
  oldId: string | null,
  userId: string,
  deviceClass: string,
  token: string,
): Promise<string> {
  const newId = \`\${userId}-\${Date.now()}\`;
  const record = JSON.stringify({
    user_id: userId,
    device_class: deviceClass,
    token: token,
    rotation: 0,
  });
  await redis.set(\`session:\${newId}\`, record, 'EX', TTL_S);
  if (oldId) {
    await redis.del(\`session:\${oldId}\`);
  }
  return newId;
}
`,
      solution: `import {createHash, randomUUID} from 'crypto';
import Redis from 'ioredis';

const redis = new Redis();

const SLIDING_TTL_S = 15 * 60;
const ABSOLUTE_TTL_S = 30 * 24 * 60 * 60;

// One atomic step: the replacement is written and the retired id removed together, so a crash can
// never leave two live ids for one user.
const ROTATE_LUA = \`
local new_key = KEYS[1]
local old_key = KEYS[2]
redis.call("SET", new_key, ARGV[1], "EX", tonumber(ARGV[2]))
if old_key ~= "" then
  redis.call("DEL", old_key)
end
return 1
\`;

interface SessionRecord {
  user_id: string;
  device_class: string;
  token_hash: string;
  created_at: number;
  rotation: number;
}

export async function rotateSession(
  oldId: string | null,
  userId: string,
  deviceClass: string,
  token: string,
): Promise<string> {
  const newId = randomUUID();
  const record: SessionRecord = {
    user_id: userId,
    device_class: deviceClass,
    token_hash: createHash('sha256').update(token).digest('hex'),
    created_at: Math.floor(Date.now() / 1000),
    rotation: 0,
  };
  const oldKey = oldId ? \`session:\${oldId}\` : '';
  await redis.eval(ROTATE_LUA, 2, \`session:\${newId}\`, oldKey, JSON.stringify(record), String(SLIDING_TTL_S));
  return newId;
}

export async function touchSession(sessionId: string): Promise<SessionRecord | null> {
  const raw = await redis.get(\`session:\${sessionId}\`);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) return null;
  // JSON.parse returns unknown; the session writer owns this payload's shape.
  const record = parsed as SessionRecord;
  if (Math.floor(Date.now() / 1000) - record.created_at > ABSOLUTE_TTL_S) {
    await redis.del(\`session:\${sessionId}\`);
    return null;
  }
  await redis.expire(\`session:\${sessionId}\`, SLIDING_TTL_S);
  return record;
}
`,
    },
    go: {
      starter: `package session

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

const ttlS = 60 * 60

type SessionRecord struct {
	UserID      string \`json:"user_id"\`
	DeviceClass string \`json:"device_class"\`
	Token       string \`json:"token"\`
	Rotation    int    \`json:"rotation"\`
}

func RotateSession(ctx context.Context, rdb *redis.Client, oldID, userID, deviceClass, token string) (string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	newID := userID + "-" + time.Now().Format("20060102150405")
	rec := SessionRecord{UserID: userID, DeviceClass: deviceClass, Token: token}
	payload, err := json.Marshal(rec)
	if err != nil {
		return "", err
	}
	if err := rdb.Set(ctx, "session:"+newID, string(payload), ttlS*time.Second).Err(); err != nil {
		return "", err
	}
	if oldID != "" {
		rdb.Del(ctx, "session:"+oldID)
	}
	return newID, nil
}
`,
      solution: `package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	slidingTTLS  = 15 * 60
	absoluteTTLS = 30 * 24 * 60 * 60
)

// rotateLua writes the replacement and retires the old id in one atomic step, so a crash cannot
// leave two live ids for one user.
const rotateLua = \`
local new_key = KEYS[1]
local old_key = KEYS[2]
redis.call("SET", new_key, ARGV[1], "EX", tonumber(ARGV[2]))
if old_key ~= "" then
  redis.call("DEL", old_key)
end
return 1
\`

type SessionRecord struct {
	UserID      string \`json:"user_id"\`
	DeviceClass string \`json:"device_class"\`
	TokenHash   string \`json:"token_hash"\`
	CreatedAt   int64  \`json:"created_at"\`
	Rotation    int    \`json:"rotation"\`
}

func RotateSession(ctx context.Context, rdb *redis.Client, oldID, userID, deviceClass, token string) (string, error) {
	newID := uuid.New().String()
	sum := sha256.Sum256([]byte(token))
	rec := SessionRecord{
		UserID:      userID,
		DeviceClass: deviceClass,
		TokenHash:   hex.EncodeToString(sum[:]),
		CreatedAt:   time.Now().Unix(),
	}
	payload, err := json.Marshal(rec)
	if err != nil {
		return "", err
	}
	oldKey := ""
	if oldID != "" {
		oldKey = "session:" + oldID
	}
	if err := rdb.Eval(ctx, rotateLua, []string{"session:" + newID, oldKey}, string(payload), slidingTTLS).Err(); err != nil {
		return "", err
	}
	return newID, nil
}

func TouchSession(ctx context.Context, rdb *redis.Client, sessionID string) (*SessionRecord, error) {
	raw, err := rdb.Get(ctx, "session:"+sessionID).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rec SessionRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	if time.Now().Unix()-rec.CreatedAt > absoluteTTLS {
		rdb.Del(ctx, "session:"+sessionID)
		return nil, nil
	}
	rdb.Expire(ctx, "session:"+sessionID, slidingTTLS*time.Second)
	return &rec, nil
}
`,
    },
    scala: {
      starter: `package session

import java.time.Instant

import redis.clients.jedis.Jedis
import io.circe.syntax._
import io.circe.generic.auto._

object SessionState {
  val TtlS: Long = 60 * 60

  case class SessionRecord(userId: String, deviceClass: String, token: String, rotation: Int)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def rotateSession(redis: Jedis, oldId: Option[String], userId: String, deviceClass: String, token: String): String = {
    val newId = s"$userId-\${Instant.now().getEpochSecond}"
    val record = SessionRecord(userId, deviceClass, token, 0)
    redis.set(s"session:$newId", record.asJson.noSpaces)
    redis.expire(s"session:$newId", TtlS)
    oldId.foreach(id => redis.del(s"session:$id"))
    newId
  }
}
`,
      solution: `package session

import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

import redis.clients.jedis.Jedis
import io.circe.syntax._
import io.circe.generic.auto._

object SessionState {
  val SlidingTtlS: Long = 15 * 60
  val AbsoluteTtlS: Long = 30L * 24 * 60 * 60

  // One atomic step: the replacement is written and the retired id removed together, so a crash can
  // never leave two live ids for one user.
  private val rotateLua: String =
    """local new_key = KEYS[1]
      |local old_key = KEYS[2]
      |redis.call("SET", new_key, ARGV[1], "EX", tonumber(ARGV[2]))
      |if old_key ~= "" then
      |  redis.call("DEL", old_key)
      |end
      |return 1""".stripMargin

  case class SessionRecord(
      userId: String,
      deviceClass: String,
      tokenHash: String,
      createdAt: Long,
      rotation: Int,
  )

  def rotateSession(redis: Jedis, oldId: Option[String], userId: String, deviceClass: String, token: String): String = {
    val newId = UUID.randomUUID().toString
    val digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes("UTF-8"))
    val hash = digest.map("%02x".format(_)).mkString
    val record = SessionRecord(userId, deviceClass, hash, Instant.now().getEpochSecond, 0)
    val oldKey = oldId.map(id => s"session:$id").getOrElse("")
    redis.eval(rotateLua, 2, s"session:$newId", oldKey, record.asJson.noSpaces, SlidingTtlS.toString)
    newId
  }

  def touchSession(redis: Jedis, sessionId: String): Option[SessionRecord] = {
    Option(redis.get(s"session:$sessionId")).flatMap { raw =>
      val record = io.circe.parser.decode[SessionRecord](raw).fold(throw _, identity)
      if (Instant.now().getEpochSecond - record.createdAt > AbsoluteTtlS) {
        redis.del(s"session:$sessionId")
        None
      } else {
        redis.expire(s"session:$sessionId", SlidingTtlS)
        Some(record)
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <ctime>
#include <string>

#include <nlohmann/json.hpp>

#include "redis_client.h"

using json = nlohmann::json;

namespace session {

constexpr long kTtlS = 60 * 60;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
std::string rotate_session(RedisClient& redis, const std::string& old_id, const std::string& user_id,
                           const std::string& device_class, const std::string& token) {
  const std::string new_id = user_id + "-" + std::to_string(std::time(nullptr));
  const json record = {
      {"user_id", user_id},
      {"device_class", device_class},
      {"token", token},
      {"rotation", 0},
  };
  redis.set("session:" + new_id, record.dump(), kTtlS);
  if (!old_id.empty()) {
    redis.del("session:" + old_id);
  }
  return new_id;
}

}  // namespace session
`,
      solution: `#include <ctime>
#include <string>

#include <nlohmann/json.hpp>

#include "redis_client.h"

using json = nlohmann::json;

namespace session {

constexpr long kSlidingTtlS = 15 * 60;
constexpr long kAbsoluteTtlS = 30L * 24 * 60 * 60;

// One atomic step: the replacement is written and the retired id removed together, so a crash can
// never leave two live ids for one user.
const std::string kRotateLua = R"LUA(
local new_key = KEYS[1]
local old_key = KEYS[2]
redis.call("SET", new_key, ARGV[1], "EX", tonumber(ARGV[2]))
if old_key ~= "" then
  redis.call("DEL", old_key)
end
return 1
)LUA";

std::string sha256_hex(const std::string& input);
std::string generate_uuid();

std::string rotate_session(RedisClient& redis, const std::string& old_id, const std::string& user_id,
                           const std::string& device_class, const std::string& token) {
  const std::string new_id = generate_uuid();
  const json record = {
      {"user_id", user_id},
      {"device_class", device_class},
      {"token_hash", sha256_hex(token)},
      {"created_at", static_cast<long>(std::time(nullptr))},
      {"rotation", 0},
  };
  const std::string old_key = old_id.empty() ? "" : "session:" + old_id;
  redis.eval(kRotateLua, {"session:" + new_id, old_key}, {record.dump(), std::to_string(kSlidingTtlS)});
  return new_id;
}

bool touch_session(RedisClient& redis, const std::string& session_id, json& out) {
  const auto raw = redis.get("session:" + session_id);
  if (!raw.has_value()) return false;
  out = json::parse(*raw);
  if (std::time(nullptr) - out["created_at"].get<long>() > kAbsoluteTtlS) {
    redis.del("session:" + session_id);
    return false;
  }
  redis.expire("session:" + session_id, kSlidingTtlS);
  return true;
}

}  // namespace session
`,
    },
  },
  debrief: `The fix has this shape because every failure in this step lives in a gap: the gap between two Redis commands, the gap between a TTL set once and the use that should refresh it, and the gap between a record and the credential it stores. A Lua script closes the first by making write-and-retire one server-side step. A \`created_at\` in the value closes the second, because the key's TTL can only express one bound and the cap has to come from the record itself. A SHA-256 closes the third, since a hash is enough to match a cookie and useless to replay. Production session stores also sweep expired records in the background so they do not linger until touched, and keep the retired id as a short tombstone so a request already in flight on it fails with a clear reason.`,
};
