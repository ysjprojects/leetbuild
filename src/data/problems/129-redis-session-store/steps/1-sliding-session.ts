import type {Step} from '@/lib/types';

export const slidingSessionStep: Step = {
  id: 'sliding-session',
  title: 'One hash per session, one EXPIRE that slides on every read',
  concept: 'redis',
  file: 'sessions',
  focus: ['app', 'redis'],
  task: `## Task

Implement a server-side session store in Redis. A session is the hash \`sess:{sid}\` and lives
\`SESSION_TTL_S = 1800\` seconds after the last time it was read or touched.

- \`create(user_id, data)\` → \`sid\`: a **32 hex char** id from a cryptographic random source (16 random
  bytes). Write the hash \`sess:{sid}\` with the fields \`user_id\`, \`created_at\` (unix seconds) and
  **every entry of \`data\`** (string fields; \`user_id\`/\`created_at\` are reserved), and set its TTL to
  \`SESSION_TTL_S\`. Write and \`EXPIRE\` in one \`MULTI\`, so no session ever exists without a TTL.
- \`get(sid)\` → the hash's fields as a map, or \`None\`/\`null\` when the session is unknown or has expired.
  A hit **slides** the TTL: \`EXPIRE sess:{sid} 1800\` after the read, every time. A miss writes nothing —
  no key may appear for an id that was never created.
- \`touch(sid)\` → \`True\` when the session exists and its TTL was slid, \`False\` otherwise. No read.
- \`destroy(sid)\`: \`DEL sess:{sid}\`; destroying an unknown session is not an error.
- Nothing else manages lifetime: no sweeper, no \`PERSIST\`, no \`last_seen\` comparison in code. A session
  nobody reads for 1800 s is gone, and \`get\` on it answers \`None\`.

> One idea: the TTL is *idle time*, not age. \`EXPIRE\` after every read is the whole "you stay logged
> in while you keep using it" feature.`,
  sequence: {
    participants: ['browser', 'app server', 'Redis'],
    messages: [
      {from: 'browser', to: 'app server', label: 'POST /login', kind: 'sync'},
      {
        from: 'app server',
        to: 'Redis',
        label: 'MULTI · HSET sess:{sid} user_id … · EXPIRE sess:{sid} 1800 · EXEC',
        kind: 'sync',
      },
      {from: 'app server', to: 'browser', label: 'Set-Cookie: sid=… (32 hex)', kind: 'reply'},
      {from: 'browser', to: 'app server', label: 'GET /me (1000 s later)', kind: 'sync'},
      {from: 'app server', to: 'Redis', label: 'HGETALL sess:{sid}', kind: 'sync'},
      {from: 'Redis', to: 'app server', label: '{user_id, created_at, …}  TTL 800', kind: 'reply'},
      {from: 'app server', to: 'Redis', label: 'EXPIRE sess:{sid} 1800 — slid', kind: 'sync'},
      {from: 'app server', to: 'browser', label: '200', kind: 'reply'},
      {from: 'browser', to: 'app server', label: 'GET /me (1801 s idle)', kind: 'sync'},
      {from: 'app server', to: 'Redis', label: 'HGETALL sess:{sid}', kind: 'sync'},
      {from: 'Redis', to: 'app server', label: '{} — evicted', kind: 'reply'},
      {from: 'app server', to: 'browser', label: '401', kind: 'reply'},
    ],
  },
  hints: [
    'The id is 16 random bytes as hex: `secrets.token_hex(16)` / `randomBytes(16)` / `crypto/rand` / `SecureRandom` / `std::random_device` — never `uuid4` trimmed, never a counter.',
    '`create` is `HSET` plus `EXPIRE` on the same key inside one `MULTI … EXEC`; build the field map from `data` first, then set `user_id` and `created_at` on top.',
    '`get` is `HGETALL`; an empty map means no session (Redis answers `{}` for a missing key, never an error). Only when it is non-empty, `EXPIRE` the key again and return the map. `touch` is just that `EXPIRE`, whose reply (1/0) is your boolean.',
  ],
  checks: [
    {
      id: 'session-id',
      title: 'Ids are 32 random hex chars; the hash holds user_id, created_at and the data',
      detail:
        '`create` returns a distinct 32-character lower-case hex id per call, and writes exactly the hash `sess:{sid}` with `user_id`, `created_at` as unix seconds and every entry of `data`, which `get` returns unchanged.',
      match: {
        python: {all: [/secrets\.token_hex\(16\)/, /"created_at":/]},
        typescript: {all: [/randomBytes\(16\)/, /created_at:/]},
        go: {all: [/rand\.Read\(/, /hex\.EncodeToString\(/, /"created_at"/]},
        scala: {all: [/SecureRandom/, /nextBytes\(/, /"created_at"/]},
        cpp: {all: [/std::random_device/, /"created_at"/]},
      },
    },
    {
      id: 'ttl-on-create',
      title: 'A new session has a TTL of 1800 s',
      detail:
        'Right after `create` the key `sess:{sid}` has `TTL` 1800 and it counts down from there; the `HSET` and the `EXPIRE` go in one `MULTI` so the key never exists without a TTL.',
      match: {
        python: {all: [/pipe\.hset\(k,/, /pipe\.expire\(k, SESSION_TTL_S\)/]},
        typescript: {all: [/\.hset\(k,/, /\.expire\(k, SESSION_TTL_S\)/]},
        go: {all: [/pipe\.HSet\(ctx, k,/, /pipe\.Expire\(ctx, k, sessionTTL\)/]},
        scala: {all: [/tx\.hset\(k,/, /tx\.expire\(k, SessionTtlSeconds\)/]},
        cpp: {all: [/tx\.hset\(k,/, /tx\.expire\(k, kSessionTtl\)/]},
      },
    },
    {
      id: 'slides-on-get',
      title: 'A read slides the TTL back to 1800 s',
      detail:
        'After 1000 s the TTL is 800; `get` returns the fields and leaves the TTL at 1800 again, so a session read every so often never expires — and the fields are not rewritten.',
      match: {
        python: {order: [/def get\(/, /r\.hgetall\(key\(sid\)\)/, /r\.expire\(key\(sid\), SESSION_TTL_S\)/]},
        typescript: {
          order: [/function get\(/, /redis\.hgetall\(key\(sid\)\)/, /redis\.expire\(key\(sid\), SESSION_TTL_S\)/],
        },
        go: {order: [/func get\(/, /rdb\.HGetAll\(ctx, key\(sid\)\)/, /rdb\.Expire\(ctx, key\(sid\), sessionTTL\)/]},
        scala: {order: [/def get\(/, /jedis\.hgetAll\(key\(sid\)\)/, /jedis\.expire\(key\(sid\), SessionTtlSeconds\)/]},
        cpp: {
          order: [
            /get\(const std::string& sid\)/,
            /redis\.hgetall\(key\(sid\)/,
            /redis\.expire\(key\(sid\), kSessionTtl\)/,
          ],
        },
      },
    },
    {
      id: 'touch',
      title: 'touch slides without reading and reports whether the session exists',
      detail:
        '`touch` on a live session returns true and sets the TTL to 1800 while leaving the fields alone; on an unknown id it returns false and creates no key.',
      match: {
        python: {all: [/return r\.expire\(key\(sid\), SESSION_TTL_S\)/]},
        typescript: {all: [/return \(await redis\.expire\(key\(sid\), SESSION_TTL_S\)\) === 1/]},
        go: {all: [/return rdb\.Expire\(ctx, key\(sid\), sessionTTL\)\.Result\(\)/]},
        scala: {all: [/jedis\.expire\(key\(sid\), SessionTtlSeconds\) == 1/]},
        cpp: {all: [/return redis\.expire\(key\(sid\), kSessionTtl\)/]},
      },
    },
    {
      id: 'expires',
      title: 'A session nobody reads for 1800 s is gone',
      detail:
        'Without reads the key survives 1799 s and is absent at 1801; `get` then answers nothing and writes nothing. A read at 1000 s buys another full 1800 s, not more. Redis evicts — no sweeper, no `PERSIST`.',
      match: {
        python: {all: [/SESSION_TTL_S = 1800/, /\.expire\(/], none: [/\.persist\(/, /threading\.Thread\(/]},
        typescript: {all: [/SESSION_TTL_S = 1800/, /\.expire\(/], none: [/\.persist\(/, /setInterval\(/]},
        go: {all: [/sessionTTL = 1800 \* time\.Second/, /\.Expire\(/], none: [/\.Persist\(/, /time\.NewTicker\(/]},
        scala: {all: [/SessionTtlSeconds = 1800L/, /\.expire\(/], none: [/\.persist\(/, /new Thread\(/]},
        cpp: {all: [/kSessionTtl\{1800\}/, /\.expire\(/], none: [/\.persist\(/, /std::thread\(/]},
      },
    },
    {
      id: 'destroy-and-unknown',
      title: 'destroy deletes the hash; an unknown id reads as nothing and leaves no key',
      detail:
        'After `destroy` the key is gone and `get` answers nothing, other sessions are untouched, and destroying again is harmless; `get`/`touch` on an id that was never created answer nothing/false and create no key.',
      match: {
        python: {all: [/r\.delete\(key\(sid\)\)/, /if not fields:\s*\n\s*return None/]},
        typescript: {all: [/redis\.del\(key\(sid\)\)/, /return null/]},
        go: {all: [/rdb\.Del\(ctx, key\(sid\)\)/, /return nil, nil/]},
        scala: {all: [/jedis\.del\(key\(sid\)\)/, /if \(fields\.isEmpty\) None/]},
        cpp: {all: [/redis\.del\(key\(sid\)\)/, /return std::nullopt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Server-side sessions in Redis: one hash per session, alive for SESSION_TTL_S after the last read or touch."""
import secrets
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SESSION_TTL_S = 1800


def key(sid: str) -> str:
    return f"sess:{sid}"


def create(user_id: str, data: dict[str, str]) -> str:
    """A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI."""
    # TODO: sid = secrets.token_hex(16); fields = {**data, "user_id": ..., "created_at": int(time.time())}
    # TODO: pipe = r.pipeline(); pipe.hset(k, mapping=fields); pipe.expire(k, SESSION_TTL_S); pipe.execute()
    raise NotImplementedError


def get(sid: str) -> dict[str, str] | None:
    """HGETALL; None when empty. A hit slides the TTL back to SESSION_TTL_S."""
    # TODO
    raise NotImplementedError


def touch(sid: str) -> bool:
    """Slide the TTL without reading; False when there is no such session."""
    # TODO
    raise NotImplementedError


def destroy(sid: str) -> None:
    """Log out: DEL the hash."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""Server-side sessions in Redis: one hash per session, alive for SESSION_TTL_S after the last read or touch."""
import secrets
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SESSION_TTL_S = 1800


def key(sid: str) -> str:
    return f"sess:{sid}"


def create(user_id: str, data: dict[str, str]) -> str:
    """A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI."""
    sid = secrets.token_hex(16)
    k = key(sid)
    fields = {**data, "user_id": user_id, "created_at": int(time.time())}
    pipe = r.pipeline()
    pipe.hset(k, mapping=fields)
    pipe.expire(k, SESSION_TTL_S)
    pipe.execute()
    return sid


def get(sid: str) -> dict[str, str] | None:
    """HGETALL; None when empty. A hit slides the TTL back to SESSION_TTL_S."""
    fields = r.hgetall(key(sid))
    if not fields:
        return None
    r.expire(key(sid), SESSION_TTL_S)
    return fields


def touch(sid: str) -> bool:
    """Slide the TTL without reading; False when there is no such session."""
    return r.expire(key(sid), SESSION_TTL_S)


def destroy(sid: str) -> None:
    """Log out: DEL the hash."""
    r.delete(key(sid))
`,
    },
    typescript: {
      starter: `/** Server-side sessions in Redis: one hash per session, alive for SESSION_TTL_S after the last read or touch. */
import {randomBytes} from 'node:crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SESSION_TTL_S = 1800;

export type Session = Record<string, string>;

const key = (sid: string): string => \`sess:\${sid}\`;

/** A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI. */
export async function create(userId: string, data: Record<string, string>): Promise<string> {
  // TODO: sid = Buffer.from(randomBytes(16)).toString('hex'); fields = {...data, user_id, created_at: unix seconds}
  // TODO: redis.multi().hset(k, fields).expire(k, SESSION_TTL_S).exec()
  void randomBytes;
  throw new Error('not implemented');
}

/** HGETALL; null when empty. A hit slides the TTL back to SESSION_TTL_S. */
export async function get(sid: string): Promise<Session | null> {
  // TODO
  void key;
  throw new Error('not implemented');
}

/** Slide the TTL without reading; false when there is no such session. */
export async function touch(sid: string): Promise<boolean> {
  // TODO
  throw new Error('not implemented');
}

/** Log out: DEL the hash. */
export async function destroy(sid: string): Promise<void> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** Server-side sessions in Redis: one hash per session, alive for SESSION_TTL_S after the last read or touch. */
import {randomBytes} from 'node:crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SESSION_TTL_S = 1800;

export type Session = Record<string, string>;

const key = (sid: string): string => \`sess:\${sid}\`;

/** A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI. */
export async function create(userId: string, data: Record<string, string>): Promise<string> {
  const sid = Buffer.from(randomBytes(16)).toString('hex');
  const k = key(sid);
  const fields = {...data, user_id: userId, created_at: Math.floor(Date.now() / 1000)};
  await redis.multi().hset(k, fields).expire(k, SESSION_TTL_S).exec();
  return sid;
}

/** HGETALL; null when empty. A hit slides the TTL back to SESSION_TTL_S. */
export async function get(sid: string): Promise<Session | null> {
  const fields = await redis.hgetall(key(sid));
  if (Object.keys(fields).length === 0) return null;
  await redis.expire(key(sid), SESSION_TTL_S);
  return fields;
}

/** Slide the TTL without reading; false when there is no such session. */
export async function touch(sid: string): Promise<boolean> {
  return (await redis.expire(key(sid), SESSION_TTL_S)) === 1;
}

/** Log out: DEL the hash. */
export async function destroy(sid: string): Promise<void> {
  await redis.del(key(sid));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// sessionTTL is how long a session lives after its last read or touch.
const sessionTTL = 1800 * time.Second

func key(sid string) string { return "sess:" + sid }

// create returns a 32-hex-char id after writing sess:{sid} with user_id, created_at and data, with the TTL set — in one MULTI.
func create(ctx context.Context, userID string, data map[string]string) (string, error) {
	// TODO: 16 bytes from rand.Read as hex; fields = data + user_id + created_at (unix seconds)
	// TODO: rdb.TxPipelined: pipe.HSet(ctx, k, fields); pipe.Expire(ctx, k, sessionTTL)
	panic("not implemented")
}

// get reads the session and slides its TTL back to sessionTTL; nil when it is unknown or expired.
func get(ctx context.Context, sid string) (map[string]string, error) {
	// TODO
	panic("not implemented")
}

// touch slides the TTL without reading; false when there is no such session.
func touch(ctx context.Context, sid string) (bool, error) {
	// TODO
	panic("not implemented")
}

// destroy logs the session out: DEL the hash.
func destroy(ctx context.Context, sid string) error {
	// TODO
	panic("not implemented")
}

func main() {
	ctx := context.Background()
	_ = rand.Read
	_ = hex.EncodeToString
	sid, err := create(ctx, "u1", map[string]string{"theme": "dark"})
	if err != nil {
		panic(err)
	}
	session, _ := get(ctx, sid)
	fmt.Println(sid, session)
	_ = touch
	_ = destroy
}
`,
      solution: `package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// sessionTTL is how long a session lives after its last read or touch.
const sessionTTL = 1800 * time.Second

func key(sid string) string { return "sess:" + sid }

// newID is 16 bytes from crypto/rand as 32 hex chars.
func newID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// create returns a 32-hex-char id after writing sess:{sid} with user_id, created_at and data, with the TTL set — in one MULTI.
func create(ctx context.Context, userID string, data map[string]string) (string, error) {
	sid, err := newID()
	if err != nil {
		return "", err
	}
	k := key(sid)
	fields := make(map[string]interface{}, len(data)+2)
	for f, v := range data {
		fields[f] = v
	}
	fields["user_id"] = userID
	fields["created_at"] = time.Now().Unix()
	_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, k, fields)
		pipe.Expire(ctx, k, sessionTTL)
		return nil
	})
	if err != nil {
		return "", err
	}
	return sid, nil
}

// get reads the session and slides its TTL back to sessionTTL; nil when it is unknown or expired.
func get(ctx context.Context, sid string) (map[string]string, error) {
	fields, err := rdb.HGetAll(ctx, key(sid)).Result()
	if err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, nil
	}
	if err := rdb.Expire(ctx, key(sid), sessionTTL).Err(); err != nil {
		return nil, err
	}
	return fields, nil
}

// touch slides the TTL without reading; false when there is no such session.
func touch(ctx context.Context, sid string) (bool, error) {
	return rdb.Expire(ctx, key(sid), sessionTTL).Result()
}

// destroy logs the session out: DEL the hash.
func destroy(ctx context.Context, sid string) error {
	return rdb.Del(ctx, key(sid)).Err()
}

func main() {
	ctx := context.Background()
	sid, err := create(ctx, "u1", map[string]string{"theme": "dark"})
	if err != nil {
		panic(err)
	}
	session, _ := get(ctx, sid)
	fmt.Println(sid, session)
	alive, _ := touch(ctx, sid)
	fmt.Println("touched:", alive)
	_ = destroy(ctx, sid)
}
`,
    },
    scala: {
      starter: `import java.security.SecureRandom

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** Server-side sessions in Redis: one hash per session, alive for SessionTtlSeconds after the last read or touch. */
object Sessions {
  val jedis = new JedisPooled("redis", 6379)
  val SessionTtlSeconds = 1800L
  private val random = new SecureRandom()

  def key(sid: String): String = s"sess:$sid"

  /** A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI. */
  def create(userId: String, data: Map[String, String]): String = {
    // TODO: 16 bytes from random.nextBytes as hex; fields = data ++ user_id + created_at (unix seconds)
    // TODO: val tx = jedis.multi(); tx.hset(k, fields.asJava); tx.expire(k, SessionTtlSeconds); tx.exec()
    ???
  }

  /** HGETALL; None when empty. A hit slides the TTL back to SessionTtlSeconds. */
  def get(sid: String): Option[Map[String, String]] = {
    ??? // TODO
  }

  /** Slide the TTL without reading; false when there is no such session. */
  def touch(sid: String): Boolean = {
    ??? // TODO
  }

  /** Log out: DEL the hash. */
  def destroy(sid: String): Unit = {
    ??? // TODO
  }

  def main(args: Array[String]): Unit = {
    val sid = create("u1", Map("theme" -> "dark"))
    println(s"$sid -> \${get(sid)}")
  }
}
`,
      solution: `import java.security.SecureRandom

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** Server-side sessions in Redis: one hash per session, alive for SessionTtlSeconds after the last read or touch. */
object Sessions {
  val jedis = new JedisPooled("redis", 6379)
  val SessionTtlSeconds = 1800L
  private val random = new SecureRandom()

  def key(sid: String): String = s"sess:$sid"

  /** 16 random bytes as 32 hex chars. */
  def newId(): String = {
    val bytes = new Array[Byte](16)
    random.nextBytes(bytes)
    bytes.map("%02x".format(_)).mkString
  }

  /** A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI. */
  def create(userId: String, data: Map[String, String]): String = {
    val sid = newId()
    val k = key(sid)
    val fields = data ++ Map("user_id" -> userId, "created_at" -> (System.currentTimeMillis() / 1000).toString)
    val tx = jedis.multi()
    tx.hset(k, fields.asJava)
    tx.expire(k, SessionTtlSeconds)
    tx.exec()
    sid
  }

  /** HGETALL; None when empty. A hit slides the TTL back to SessionTtlSeconds. */
  def get(sid: String): Option[Map[String, String]] = {
    val fields = jedis.hgetAll(key(sid)).asScala.toMap
    if (fields.isEmpty) None
    else {
      jedis.expire(key(sid), SessionTtlSeconds)
      Some(fields)
    }
  }

  /** Slide the TTL without reading; false when there is no such session. */
  def touch(sid: String): Boolean = jedis.expire(key(sid), SessionTtlSeconds) == 1

  /** Log out: DEL the hash. */
  def destroy(sid: String): Unit = jedis.del(key(sid))

  def main(args: Array[String]): Unit = {
    val sid = create("u1", Map("theme" -> "dark"))
    println(s"$sid -> \${get(sid)}")
  }
}
`,
    },
    cpp: {
      starter: `// Server-side sessions in Redis: one hash per session, alive for kSessionTtl after the last read or touch.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdio>
#include <ctime>
#include <iterator>
#include <map>
#include <optional>
#include <random>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kSessionTtl{1800};

std::string key(const std::string& sid) { return "sess:" + sid; }

// A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI.
std::string create(const std::string& user_id, const std::map<std::string, std::string>& data) {
  // TODO: 16 bytes from std::random_device as hex; fields = data + user_id + created_at (unix seconds)
  // TODO: auto tx = redis.transaction(); tx.hset(k, fields.begin(), fields.end()); tx.expire(k, kSessionTtl); tx.exec()
  throw std::logic_error("not implemented");
}

// HGETALL; nullopt when empty. A hit slides the TTL back to kSessionTtl.
std::optional<std::map<std::string, std::string>> get(const std::string& sid) {
  // TODO
  throw std::logic_error("not implemented");
}

// Slide the TTL without reading; false when there is no such session.
bool touch(const std::string& sid) {
  // TODO
  throw std::logic_error("not implemented");
}

// Log out: DEL the hash.
void destroy(const std::string& sid) {
  // TODO
  throw std::logic_error("not implemented");
}

int main() {
  const std::string sid = create("u1", {{"theme", "dark"}});
  const auto session = get(sid);
  std::printf("%s -> %s\\n", sid.c_str(), session ? session->at("theme").c_str() : "none");
}
`,
      solution: `// Server-side sessions in Redis: one hash per session, alive for kSessionTtl after the last read or touch.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdio>
#include <ctime>
#include <iterator>
#include <map>
#include <optional>
#include <random>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kSessionTtl{1800};

std::string key(const std::string& sid) { return "sess:" + sid; }

// 16 bytes from the OS entropy source as 32 hex chars.
std::string new_id() {
  std::random_device entropy;
  std::uniform_int_distribution<int> byte(0, 255);
  std::string hex;
  char pair[3];
  for (int i = 0; i < 16; ++i) {
    std::snprintf(pair, sizeof pair, "%02x", byte(entropy));
    hex += pair;
  }
  return hex;
}

// A 32-hex-char id; HSET sess:{sid} with user_id, created_at and data, and EXPIRE it — in one MULTI.
std::string create(const std::string& user_id, const std::map<std::string, std::string>& data) {
  const std::string sid = new_id();
  const std::string k = key(sid);
  std::map<std::string, std::string> fields = data;
  fields["user_id"] = user_id;
  fields["created_at"] = std::to_string(std::time(nullptr));
  auto tx = redis.transaction();
  tx.hset(k, fields.begin(), fields.end());
  tx.expire(k, kSessionTtl);
  tx.exec();
  return sid;
}

// HGETALL; nullopt when empty. A hit slides the TTL back to kSessionTtl.
std::optional<std::map<std::string, std::string>> get(const std::string& sid) {
  std::map<std::string, std::string> fields;
  redis.hgetall(key(sid), std::inserter(fields, fields.begin()));
  if (fields.empty()) return std::nullopt;
  redis.expire(key(sid), kSessionTtl);
  return fields;
}

// Slide the TTL without reading; false when there is no such session.
bool touch(const std::string& sid) { return redis.expire(key(sid), kSessionTtl); }

// Log out: DEL the hash.
void destroy(const std::string& sid) { redis.del(key(sid)); }

int main() {
  const std::string sid = create("u1", {{"theme", "dark"}});
  const auto session = get(sid);
  std::printf("%s -> %s\\n", sid.c_str(), session ? session->at("theme").c_str() : "none");
  std::printf("touched: %d\\n", touch(sid));
  destroy(sid);
}
`,
    },
  },
  harness: {
    python: `import re
import time

HEX32 = re.compile(r"^[0-9a-f]{32}$")
TTL = 1800
NOBODY = "0" * 32


def check_session_id(ctx):
    m = ctx.load("sessions")
    sids = [m.create(f"u{i}", {"theme": "dark", "locale": "de"}) for i in range(50)]
    for sid in sids:
        assert isinstance(sid, str) and HEX32.match(sid), f"a session id must be 32 lower-case hex chars (16 random bytes), got {sid!r}"
    assert len(set(sids)) == 50, "fifty sessions must get fifty distinct ids — a secure random source, never a counter or a timestamp"
    sid = sids[0]
    assert ctx.redis.type(f"sess:{sid}") == "hash", f"the session must be the hash sess:{{sid}}; sess:{sid} is {ctx.redis.type(f'sess:{sid}')!r}"
    fields = ctx.redis.hgetall(f"sess:{sid}")
    assert fields.get("user_id") == "u0", f"the hash must carry user_id = 'u0', it holds {fields}"
    assert fields.get("created_at") is not None and abs(int(fields["created_at"]) - int(time.time())) <= 1, f"created_at must be the unix seconds at create, it is {fields.get('created_at')!r}"
    assert fields.get("theme") == "dark" and fields.get("locale") == "de", f"every entry of data must be a field of the hash; the hash holds {fields}"
    assert set(fields) == {"user_id", "created_at", "theme", "locale"}, f"the hash must hold exactly user_id, created_at and the data entries, not {sorted(fields)}"
    assert m.get(sid) == fields, f"get must return the hash's fields as stored, got {m.get(sid)!r} for {fields}"
    bare = m.create("u99", {})
    assert set(ctx.redis.hgetall(f"sess:{bare}")) == {"user_id", "created_at"}, "with empty data the hash holds only user_id and created_at"
    assert sorted(ctx.redis.keys("*")) == sorted(f"sess:{s}" for s in sids + [bare]), f"the only keys written are sess:{{sid}}, found {sorted(ctx.redis.keys('*'))[:5]}"


def check_ttl_on_create(ctx):
    m = ctx.load("sessions")
    sid = m.create("ana", {"theme": "dark"})
    ttl = ctx.redis.ttl(f"sess:{sid}")
    assert ttl == TTL, f"right after create the TTL of sess:{{sid}} must be {TTL} s (SESSION_TTL_S), it is {ttl}"
    ctx.clock.advance(100)
    ttl = ctx.redis.ttl(f"sess:{sid}")
    assert ttl == TTL - 100, f"the TTL counts down while nobody reads: 100 s later it must be {TTL - 100}, it is {ttl}"
    assert ctx.redis.hgetall(f"sess:{sid}")["theme"] == "dark", "the fields must survive the EXPIRE (EXPIRE sets a TTL, it does not rewrite the hash)"


def check_slides_on_get(ctx):
    m = ctx.load("sessions")
    sid = m.create("ana", {"theme": "dark"})
    stored = ctx.redis.hgetall(f"sess:{sid}")
    ctx.clock.advance(1000)
    assert ctx.redis.ttl(f"sess:{sid}") == TTL - 1000
    got = m.get(sid)
    assert got is not None and got["user_id"] == "ana" and got["theme"] == "dark", f"get on a live session must return its fields, got {got!r}"
    ttl = ctx.redis.ttl(f"sess:{sid}")
    assert ttl == TTL, f"a read must slide the TTL back to {TTL} (EXPIRE after HGETALL), it is {ttl}"
    assert ctx.redis.hgetall(f"sess:{sid}") == stored, "a read must not rewrite the hash — created_at and the data stay as they were"
    ctx.clock.advance(1500)
    assert ctx.redis.exists(f"sess:{sid}") == 1, "2500 s after create but only 1500 s after the last read the session must still be there"
    assert m.get(sid) is not None, "a session read every 1500 s must never expire"
    assert ctx.redis.ttl(f"sess:{sid}") == TTL, "every read slides the TTL, not just the first"


def check_touch(ctx):
    m = ctx.load("sessions")
    sid = m.create("ana", {"theme": "dark"})
    stored = ctx.redis.hgetall(f"sess:{sid}")
    ctx.clock.advance(1000)
    assert m.touch(sid) is True, "touch on a live session must return True"
    ttl = ctx.redis.ttl(f"sess:{sid}")
    assert ttl == TTL, f"touch must slide the TTL back to {TTL}, it is {ttl}"
    assert ctx.redis.hgetall(f"sess:{sid}") == stored, "touch must leave the fields alone"
    assert m.touch(NOBODY) is False, "touch on an unknown id must return False (EXPIRE answers 0 for a missing key)"
    assert ctx.redis.exists(f"sess:{NOBODY}") == 0, "touch on an unknown id must not create a key"
    assert ctx.redis.keys("*") == [f"sess:{sid}"], f"touch must write no other key, found {ctx.redis.keys('*')}"


def check_expires(ctx):
    m = ctx.load("sessions")
    sid = m.create("ana", {"theme": "dark"})
    ctx.clock.advance(1799)
    assert ctx.redis.exists(f"sess:{sid}") == 1, "1799 s without a read is still inside the idle window: the session must be there"
    ctx.clock.advance(2)
    assert ctx.redis.exists(f"sess:{sid}") == 0, "1801 s without a read: Redis must have evicted sess:{sid} — the TTL set at create is the only thing keeping it alive"
    assert m.get(sid) is None, "get on an expired session must return None"
    assert m.touch(sid) is False, "touch on an expired session must return False"
    assert ctx.redis.keys("*") == [], f"get/touch on an expired session must not recreate anything, found {ctx.redis.keys('*')}"
    other = m.create("bo", {})
    ctx.clock.advance(1000)
    assert m.get(other) is not None
    ctx.clock.advance(1799)
    assert ctx.redis.exists(f"sess:{other}") == 1, "a read at 1000 s buys a fresh 1800 s: 1799 s after it the session must still be there"
    ctx.clock.advance(2)
    assert m.get(other) is None, "a read buys 1800 s and no more: 1801 s after the last read the session must be gone"


def check_destroy_and_unknown(ctx):
    m = ctx.load("sessions")
    a = m.create("ana", {"theme": "dark"})
    b = m.create("bo", {"theme": "light"})
    m.destroy(a)
    assert ctx.redis.exists(f"sess:{a}") == 0, "destroy must DEL sess:{sid}"
    assert m.get(a) is None, "get after destroy must return None"
    assert m.touch(a) is False, "touch after destroy must return False"
    got = m.get(b)
    assert got is not None and got["theme"] == "light", "destroying one session must not touch another"
    m.destroy(a)  # idempotent
    assert m.get(NOBODY) is None, "get on an id that was never created must return None"
    assert m.touch(NOBODY) is False, "touch on an id that was never created must return False"
    assert ctx.redis.keys("*") == [f"sess:{b}"], f"a miss must create no key — only sess:{{b}} may exist, found {ctx.redis.keys('*')}"
`,
    typescript: `const HEX32 = /^[0-9a-f]{32}$/;
const TTL = 1800;
const NOBODY = '0'.repeat(32);

export async function check_session_id(ctx) {
  const m = ctx.load('sessions');
  const sids: string[] = [];
  for (let i = 0; i < 50; i++) sids.push(await m.create(\`u\${i}\`, {theme: 'dark', locale: 'de'}));
  for (const sid of sids)
    assert(typeof sid === 'string' && HEX32.test(sid), \`a session id must be 32 lower-case hex chars (16 random bytes), got \${JSON.stringify(sid)}\`);
  assert.equal(new Set(sids).size, 50, 'fifty sessions must get fifty distinct ids — a secure random source, never a counter or a timestamp');
  const sid = sids[0];
  assert.equal(ctx.redis.type(\`sess:\${sid}\`), 'hash', \`the session must be the hash sess:{sid}; sess:\${sid} is \${ctx.redis.type(\`sess:\${sid}\`)}\`);
  const fields = ctx.redis.hgetall(\`sess:\${sid}\`) as Record<string, string>;
  assert.equal(fields.user_id, 'u0', \`the hash must carry user_id = 'u0', it holds \${JSON.stringify(fields)}\`);
  assert(fields.created_at !== undefined && Math.abs(Number(fields.created_at) - Math.floor(Date.now() / 1000)) <= 1, \`created_at must be the unix seconds at create, it is \${JSON.stringify(fields.created_at)}\`);
  assert(fields.theme === 'dark' && fields.locale === 'de', \`every entry of data must be a field of the hash; the hash holds \${JSON.stringify(fields)}\`);
  assert.deepEqual(Object.keys(fields).sort(), ['created_at', 'locale', 'theme', 'user_id'], \`the hash must hold exactly user_id, created_at and the data entries, not \${JSON.stringify(Object.keys(fields).sort())}\`);
  assert.deepEqual(await m.get(sid), fields, \`get must return the hash's fields as stored, got \${JSON.stringify(await m.get(sid))} for \${JSON.stringify(fields)}\`);
  const bare = await m.create('u99', {});
  assert.deepEqual(Object.keys(ctx.redis.hgetall(\`sess:\${bare}\`)).sort(), ['created_at', 'user_id'], 'with empty data the hash holds only user_id and created_at');
  const keys = (ctx.redis.keys('*') as string[]).sort();
  assert.deepEqual(keys, [...sids, bare].map(s => \`sess:\${s}\`).sort(), \`the only keys written are sess:{sid}, found \${JSON.stringify(keys.slice(0, 5))}\`);
}

export async function check_ttl_on_create(ctx) {
  const m = ctx.load('sessions');
  const sid = await m.create('ana', {theme: 'dark'});
  let ttl = ctx.redis.ttl(\`sess:\${sid}\`);
  assert.equal(ttl, TTL, \`right after create the TTL of sess:{sid} must be \${TTL} s (SESSION_TTL_S), it is \${ttl}\`);
  ctx.clock.advance(100);
  ttl = ctx.redis.ttl(\`sess:\${sid}\`);
  assert.equal(ttl, TTL - 100, \`the TTL counts down while nobody reads: 100 s later it must be \${TTL - 100}, it is \${ttl}\`);
  assert.equal((ctx.redis.hgetall(\`sess:\${sid}\`) as Record<string, string>).theme, 'dark', 'the fields must survive the EXPIRE (EXPIRE sets a TTL, it does not rewrite the hash)');
}

export async function check_slides_on_get(ctx) {
  const m = ctx.load('sessions');
  const sid = await m.create('ana', {theme: 'dark'});
  const stored = ctx.redis.hgetall(\`sess:\${sid}\`);
  ctx.clock.advance(1000);
  assert.equal(ctx.redis.ttl(\`sess:\${sid}\`), TTL - 1000);
  const got = await m.get(sid);
  assert(got !== null && got.user_id === 'ana' && got.theme === 'dark', \`get on a live session must return its fields, got \${JSON.stringify(got)}\`);
  const ttl = ctx.redis.ttl(\`sess:\${sid}\`);
  assert.equal(ttl, TTL, \`a read must slide the TTL back to \${TTL} (EXPIRE after HGETALL), it is \${ttl}\`);
  assert.deepEqual(ctx.redis.hgetall(\`sess:\${sid}\`), stored, 'a read must not rewrite the hash — created_at and the data stay as they were');
  ctx.clock.advance(1500);
  assert.equal(ctx.redis.exists(\`sess:\${sid}\`), 1, '2500 s after create but only 1500 s after the last read the session must still be there');
  assert.notEqual(await m.get(sid), null, 'a session read every 1500 s must never expire');
  assert.equal(ctx.redis.ttl(\`sess:\${sid}\`), TTL, 'every read slides the TTL, not just the first');
}

export async function check_touch(ctx) {
  const m = ctx.load('sessions');
  const sid = await m.create('ana', {theme: 'dark'});
  const stored = ctx.redis.hgetall(\`sess:\${sid}\`);
  ctx.clock.advance(1000);
  assert.equal(await m.touch(sid), true, 'touch on a live session must return true');
  const ttl = ctx.redis.ttl(\`sess:\${sid}\`);
  assert.equal(ttl, TTL, \`touch must slide the TTL back to \${TTL}, it is \${ttl}\`);
  assert.deepEqual(ctx.redis.hgetall(\`sess:\${sid}\`), stored, 'touch must leave the fields alone');
  assert.equal(await m.touch(NOBODY), false, 'touch on an unknown id must return false (EXPIRE answers 0 for a missing key)');
  assert.equal(ctx.redis.exists(\`sess:\${NOBODY}\`), 0, 'touch on an unknown id must not create a key');
  assert.deepEqual(ctx.redis.keys('*'), [\`sess:\${sid}\`], \`touch must write no other key, found \${JSON.stringify(ctx.redis.keys('*'))}\`);
}

export async function check_expires(ctx) {
  const m = ctx.load('sessions');
  const sid = await m.create('ana', {theme: 'dark'});
  ctx.clock.advance(1799);
  assert.equal(ctx.redis.exists(\`sess:\${sid}\`), 1, '1799 s without a read is still inside the idle window: the session must be there');
  ctx.clock.advance(2);
  assert.equal(ctx.redis.exists(\`sess:\${sid}\`), 0, '1801 s without a read: Redis must have evicted sess:{sid} — the TTL set at create is the only thing keeping it alive');
  assert.equal(await m.get(sid), null, 'get on an expired session must return null');
  assert.equal(await m.touch(sid), false, 'touch on an expired session must return false');
  assert.deepEqual(ctx.redis.keys('*'), [], \`get/touch on an expired session must not recreate anything, found \${JSON.stringify(ctx.redis.keys('*'))}\`);
  const other = await m.create('bo', {});
  ctx.clock.advance(1000);
  assert.notEqual(await m.get(other), null);
  ctx.clock.advance(1799);
  assert.equal(ctx.redis.exists(\`sess:\${other}\`), 1, 'a read at 1000 s buys a fresh 1800 s: 1799 s after it the session must still be there');
  ctx.clock.advance(2);
  assert.equal(await m.get(other), null, 'a read buys 1800 s and no more: 1801 s after the last read the session must be gone');
}

export async function check_destroy_and_unknown(ctx) {
  const m = ctx.load('sessions');
  const a = await m.create('ana', {theme: 'dark'});
  const b = await m.create('bo', {theme: 'light'});
  await m.destroy(a);
  assert.equal(ctx.redis.exists(\`sess:\${a}\`), 0, 'destroy must DEL sess:{sid}');
  assert.equal(await m.get(a), null, 'get after destroy must return null');
  assert.equal(await m.touch(a), false, 'touch after destroy must return false');
  const got = await m.get(b);
  assert(got !== null && got.theme === 'light', 'destroying one session must not touch another');
  await m.destroy(a); // idempotent
  assert.equal(await m.get(NOBODY), null, 'get on an id that was never created must return null');
  assert.equal(await m.touch(NOBODY), false, 'touch on an id that was never created must return false');
  assert.deepEqual(ctx.redis.keys('*'), [\`sess:\${b}\`], \`a miss must create no key — only sess:{b} may exist, found \${JSON.stringify(ctx.redis.keys('*'))}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const ssTTL = 1800

var (
	ssHex32  = regexp.MustCompile("^[0-9a-f]{32}$")
	ssNobody = strings.Repeat("0", 32)
	ssBg     = context.Background()
)

func ssCreate(ctx *harness.Ctx, userID string, data map[string]string) string {
	sid, err := create(ssBg, userID, data)
	ctx.NoError(err, "create(ctx, %q, %s) returned an error", userID, harness.Show(data))
	return sid
}

func ssGet(ctx *harness.Ctx, sid string) map[string]string {
	got, err := get(ssBg, sid)
	ctx.NoError(err, "get(ctx, %q) returned an error", sid)
	return got
}

func ssTouch(ctx *harness.Ctx, sid string) bool {
	ok, err := touch(ssBg, sid)
	ctx.NoError(err, "touch(ctx, %q) returned an error", sid)
	return ok
}

func ssDestroy(ctx *harness.Ctx, sid string) {
	ctx.NoError(destroy(ssBg, sid), "destroy(ctx, %q) returned an error", sid)
}

// ssFieldNames is the hash's field names, sorted.
func ssFieldNames(fields map[string]string) []string {
	names := make([]string, 0, len(fields))
	for f := range fields {
		names = append(names, f)
	}
	sort.Strings(names)
	return names
}

func CheckSessionId(ctx *harness.Ctx) {
	sids := make([]string, 0, 50)
	for i := range 50 {
		sids = append(sids, ssCreate(ctx, fmt.Sprintf("u%d", i), map[string]string{"theme": "dark", "locale": "de"}))
	}
	for _, sid := range sids {
		ctx.Assert(ssHex32.MatchString(sid), "a session id must be 32 lower-case hex chars (16 random bytes), got %q", sid)
	}
	distinct := map[string]bool{}
	for _, sid := range sids {
		distinct[sid] = true
	}
	ctx.Equal(len(distinct), 50, "fifty sessions must get fifty distinct ids (a secure random source, never a counter or a timestamp)")
	sid := sids[0]
	k := "sess:" + sid
	ctx.Equal(ctx.Redis.Type(k), "hash", "the session must be the hash sess:{sid}; the type of %s", k)
	fields := ctx.Redis.HGetAll(k)
	ctx.Equal(fields["user_id"], "u0", "the hash must carry user_id = u0 (it holds %s)", harness.Show(fields))
	createdAt, ok := fields["created_at"]
	at, err := strconv.ParseInt(createdAt, 10, 64)
	now := ctx.Clock.Now() / 1000
	ctx.Assert(ok && err == nil && at-now <= 1 && now-at <= 1, "created_at must be the unix seconds at create, it is %q", createdAt)
	ctx.Assert(fields["theme"] == "dark" && fields["locale"] == "de", "every entry of data must be a field of the hash; the hash holds %s", harness.Show(fields))
	ctx.Equal(ssFieldNames(fields), []string{"created_at", "locale", "theme", "user_id"}, "the hash must hold exactly user_id, created_at and the data entries")
	ctx.Equal(ssGet(ctx, sid), fields, "get must return the hash's fields as stored")
	bare := ssCreate(ctx, "u99", map[string]string{})
	ctx.Equal(ssFieldNames(ctx.Redis.HGetAll("sess:"+bare)), []string{"created_at", "user_id"}, "with empty data the hash holds only user_id and created_at")
	keys := ctx.Redis.Keys("*")
	want := make([]string, 0, len(sids)+1)
	for _, s := range append(sids, bare) {
		want = append(want, "sess:"+s)
	}
	sort.Strings(want)
	shown := keys
	if len(shown) > 5 {
		shown = shown[:5]
	}
	ctx.Assert(reflect.DeepEqual(keys, want), "the only keys written are sess:{sid}, found %s", harness.Show(shown))
}

func CheckTtlOnCreate(ctx *harness.Ctx) {
	sid := ssCreate(ctx, "ana", map[string]string{"theme": "dark"})
	ctx.Equal(ctx.Redis.TTL("sess:"+sid), ssTTL, "right after create the TTL of sess:{sid} must be %d s (sessionTTL)", ssTTL)
	ctx.Clock.Advance(100)
	ctx.Equal(ctx.Redis.TTL("sess:"+sid), ssTTL-100, "the TTL counts down while nobody reads: 100 s later")
	theme, _ := ctx.Redis.HGet("sess:"+sid, "theme")
	ctx.Equal(theme, "dark", "the fields must survive the EXPIRE (EXPIRE sets a TTL, it does not rewrite the hash)")
}

func CheckSlidesOnGet(ctx *harness.Ctx) {
	sid := ssCreate(ctx, "ana", map[string]string{"theme": "dark"})
	k := "sess:" + sid
	stored := ctx.Redis.HGetAll(k)
	ctx.Clock.Advance(1000)
	ctx.Equal(ctx.Redis.TTL(k), ssTTL-1000, "the TTL 1000 s after create")
	got := ssGet(ctx, sid)
	ctx.Assert(got != nil && got["user_id"] == "ana" && got["theme"] == "dark", "get on a live session must return its fields, got %s", harness.Show(got))
	ctx.Equal(ctx.Redis.TTL(k), ssTTL, "a read must slide the TTL back to %d (EXPIRE after HGETALL)", ssTTL)
	ctx.Equal(ctx.Redis.HGetAll(k), stored, "a read must not rewrite the hash (created_at and the data stay as they were)")
	ctx.Clock.Advance(1500)
	ctx.Equal(ctx.Redis.Exists(k), 1, "2500 s after create but only 1500 s after the last read the session must still be there")
	ctx.Assert(ssGet(ctx, sid) != nil, "a session read every 1500 s must never expire")
	ctx.Equal(ctx.Redis.TTL(k), ssTTL, "every read slides the TTL, not just the first")
}

func CheckTouch(ctx *harness.Ctx) {
	sid := ssCreate(ctx, "ana", map[string]string{"theme": "dark"})
	k := "sess:" + sid
	stored := ctx.Redis.HGetAll(k)
	ctx.Clock.Advance(1000)
	ctx.Equal(ssTouch(ctx, sid), true, "touch on a live session must return true")
	ctx.Equal(ctx.Redis.TTL(k), ssTTL, "touch must slide the TTL back to %d", ssTTL)
	ctx.Equal(ctx.Redis.HGetAll(k), stored, "touch must leave the fields alone")
	ctx.Equal(ssTouch(ctx, ssNobody), false, "touch on an unknown id must return false (EXPIRE answers 0 for a missing key)")
	ctx.Equal(ctx.Redis.Exists("sess:"+ssNobody), 0, "touch on an unknown id must not create a key")
	ctx.Equal(ctx.Redis.Keys("*"), []string{k}, "touch must write no other key")
}

func CheckExpires(ctx *harness.Ctx) {
	sid := ssCreate(ctx, "ana", map[string]string{"theme": "dark"})
	k := "sess:" + sid
	ctx.Clock.Advance(1799)
	ctx.Equal(ctx.Redis.Exists(k), 1, "1799 s without a read is still inside the idle window: the session must be there")
	ctx.Clock.Advance(2)
	ctx.Equal(ctx.Redis.Exists(k), 0, "1801 s without a read: Redis must have evicted sess:{sid} (the TTL set at create is the only thing keeping it alive)")
	ctx.Assert(ssGet(ctx, sid) == nil, "get on an expired session must return nil")
	ctx.Equal(ssTouch(ctx, sid), false, "touch on an expired session must return false")
	keys := ctx.Redis.Keys("*")
	ctx.Assert(len(keys) == 0, "get/touch on an expired session must not recreate anything, found %s", harness.Show(keys))
	other := ssCreate(ctx, "bo", map[string]string{})
	ctx.Clock.Advance(1000)
	ctx.Assert(ssGet(ctx, other) != nil, "get on a live session must return its fields")
	ctx.Clock.Advance(1799)
	ctx.Equal(ctx.Redis.Exists("sess:"+other), 1, "a read at 1000 s buys a fresh 1800 s: 1799 s after it the session must still be there")
	ctx.Clock.Advance(2)
	ctx.Assert(ssGet(ctx, other) == nil, "a read buys 1800 s and no more: 1801 s after the last read the session must be gone")
}

func CheckDestroyAndUnknown(ctx *harness.Ctx) {
	a := ssCreate(ctx, "ana", map[string]string{"theme": "dark"})
	b := ssCreate(ctx, "bo", map[string]string{"theme": "light"})
	ssDestroy(ctx, a)
	ctx.Equal(ctx.Redis.Exists("sess:"+a), 0, "destroy must DEL sess:{sid}")
	ctx.Assert(ssGet(ctx, a) == nil, "get after destroy must return nil")
	ctx.Equal(ssTouch(ctx, a), false, "touch after destroy must return false")
	got := ssGet(ctx, b)
	ctx.Assert(got != nil && got["theme"] == "light", "destroying one session must not touch another")
	ssDestroy(ctx, a) // idempotent
	ctx.Assert(ssGet(ctx, ssNobody) == nil, "get on an id that was never created must return nil")
	ctx.Equal(ssTouch(ctx, ssNobody), false, "touch on an id that was never created must return false")
	ctx.Equal(ctx.Redis.Keys("*"), []string{"sess:" + b}, "a miss must create no key: only sess:{b} may exist")
}
`,
  },
  debrief: `The store is two commands and an ordering. \`HSET\` plus \`EXPIRE\` inside one \`MULTI\` means a crash between the write and the TTL can never leave an immortal session — the hash and its lifetime land together or not at all. \`HGETALL\` followed by \`EXPIRE\` is the slide: the TTL measures *idle time*, so an active user is never logged out mid-session and an abandoned tab is gone 30 minutes after its last request, with Redis doing the eviction and nobody running a sweeper. \`touch\` is that same \`EXPIRE\` alone, and its 0/1 reply doubles as "does this session exist" — the reason an unknown or expired id never creates a key is that neither \`HGETALL\` nor \`EXPIRE\` writes anything for a missing key. The id is 128 bits from a cryptographic source, which is what makes a cookie unguessable; a counter or a timestamp would let anyone enumerate live sessions. Real systems add an absolute lifetime next to the idle one (a second field compared at read time, or a shorter \`EXPIRE\` ceiling), rotate the id at login against session fixation, keep a per-user set of ids so "log out everywhere" is one \`SMEMBERS\` and a few \`DEL\`s, and sign the cookie so a tampered id is rejected before Redis is asked.`,
};
