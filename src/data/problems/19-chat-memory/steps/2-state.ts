import type {Step} from '@/lib/types';

const KEEPS_NEWEST = /LTRIM['"]\s*,\s*KEYS\[1\]\s*,\s*-|ltrim\((ctx,\s*)?[^,\n]*,\s*-/i;
const KEEPS_OLDEST = /LTRIM['"]\s*,\s*KEYS\[1\]\s*,\s*0\b|ltrim\((ctx,\s*)?[^,\n]*,\s*0\s*,/i;
const EXPIRES = /['"]EXPIRE['"]|\.expire\(/i;

export const stateStep: Step = {
  id: 'state',
  title: 'Redis recent-turn buffer: one capped, expiring list per tenant and session',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the recent-turn buffer every later step reads:
\`append_turn(tenant, session_id, turn)\` pushes the turn as JSON onto \`turns:{session_id}\` with
\`RPUSH\`, trims with \`LTRIM 0 49\` and returns the length; \`recent_turns(tenant, session_id, limit)\`
reads the last \`limit\` turns, oldest first. It serves the demo and hides four flaws.

**Failure mode the checks target.** Two tenants that both name a conversation \`s-1\` read each
other's turns; after 50 turns the newest ones vanish and the oldest stay; a session nobody touches
again keeps its list for good; and a reader that lands between the push and the trim sees 51 turns.

- One list per (tenant, session): \`buffer_key(tenant, session_id)\` is \`turns:{tenant}:{session_id}\`.
- The list keeps the **newest** \`MAX_TURNS\` = 50 turns; it grows at the tail, so the trim keeps
  indexes \`-50\` to \`-1\`.
- The list expires \`TTL_S\` = 24 hours after the **last** append.
- Push, trim and expire run as **one Lua script** (or one \`MULTI\`/\`EXEC\`), so no reader and no
  crash finds the list between them.`,
  sequence: {
    participants: ['Memory API', 'Redis'],
    messages: [
      {from: 'Memory API', to: 'Redis', label: 'EVAL append turns:t1:s-1 {turn} 50 86400', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'RPUSH · LTRIM -50 -1 · EXPIRE 86400, atomically', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'LLEN → 50', kind: 'reply'},
      {from: 'Memory API', to: 'Redis', label: 'LRANGE turns:t1:s-1 -limit -1', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'the newest turns, oldest first', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys the buffer by tenant and session',
      detail:
        'Both functions use `buffer_key(tenant, session_id)` = `turns:{tenant}:{session_id}`; the starter keys by the session id alone, so two tenants that pick the same id share one list.',
      match: {
        python: {
          all: [/def buffer_key\(\s*tenant/, /turns:\{tenant\}:\{session_id\}/],
          none: [/f["']turns:\{session_id\}/],
        },
        typescript: {
          all: [/bufferKey\s*=\s*\(\s*tenant|function bufferKey\(\s*tenant/, /turns:\$\{tenant\}:\$\{sessionId\}/],
          none: [/`turns:\$\{sessionId\}`/],
        },
        go: {
          all: [/func bufferKey\(\s*tenant/, /"turns:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*sessionID/],
          none: [/"turns:"\s*\+\s*sessionID/],
        },
        scala: {all: [/def bufferKey\(\s*tenant/, /s"turns:\$tenant:\$sessionId"/], none: [/s"turns:\$sessionId"/]},
        cpp: {
          all: [
            /std::string bufferKey\(\s*const std::string& tenant/,
            /"turns:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*session_id/,
          ],
          none: [/"turns:"\s*\+\s*session_id/],
        },
      },
    },
    {
      id: 'keeps-newest',
      title: 'Trims to the newest 50 turns',
      detail:
        'The list grows at the tail (`RPUSH`), so the trim keeps `-MAX_TURNS` to `-1`; the starter keeps indexes 0 to 49, the oldest 50, and every turn after the fiftieth is dropped the moment it is pushed.',
      match: {
        python: {all: [KEEPS_NEWEST], none: [KEEPS_OLDEST]},
        typescript: {all: [KEEPS_NEWEST], none: [KEEPS_OLDEST]},
        go: {all: [KEEPS_NEWEST], none: [KEEPS_OLDEST]},
        scala: {all: [KEEPS_NEWEST], none: [KEEPS_OLDEST]},
        cpp: {all: [KEEPS_NEWEST], none: [KEEPS_OLDEST]},
      },
    },
    {
      id: 'idle-expiry',
      title: 'Expires the buffer a day after the last append',
      detail:
        'Every append sets the list to expire after `TTL_S` (86400 s), so an active session keeps renewing and an abandoned one frees its memory; the starter sets no TTL at all.',
      match: {
        python: {all: [EXPIRES, /TTL_S/]},
        typescript: {all: [EXPIRES, /TTL_S/]},
        go: {all: [EXPIRES, /ttlSeconds/]},
        scala: {all: [EXPIRES, /TtlSeconds/]},
        cpp: {all: [EXPIRES, /kTtlSeconds/]},
      },
    },
    {
      id: 'atomic-append',
      title: 'Pushes, trims and expires in one atomic step',
      detail:
        'The append is one Lua script (`register_script`/`eval`, `defineCommand`, `NewScript`) or one `MULTI`/`EXEC`, not separate `RPUSH`, `LTRIM` and `EXPIRE` round trips a reader or a crash can land between.',
      match: {
        python: {all: [/register_script\(|\.eval\(|\.pipeline\(/], none: [/\br\.rpush\(/, /\br\.ltrim\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(|\.multi\(/], none: [/redis\.rpush\(/, /redis\.ltrim\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(|TxPipelined\(/], none: [/rdb\.RPush\(/, /rdb\.LTrim\(/]},
        scala: {all: [/jedis\.eval\(|\.multi\(\)/], none: [/jedis\.rpush\(/, /jedis\.ltrim\(/]},
        cpp: {all: [/\.eval<|\.transaction\(/], none: [/redis\(\)\.rpush\(/, /redis\(\)\.ltrim\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_TURNS = 50
TTL_S = 86400


def append_turn(tenant: str, session_id: str, turn: dict) -> int:
    """Append a turn (turn_id, role, content, tokens); returns how many turns the buffer holds."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"turns:{session_id}"
    r.rpush(key, json.dumps(turn))
    r.ltrim(key, 0, MAX_TURNS - 1)
    return r.llen(key)


def recent_turns(tenant: str, session_id: str, limit: int = MAX_TURNS) -> list[dict]:
    """The session's last limit turns, oldest first."""
    return [json.loads(raw) for raw in r.lrange(f"turns:{session_id}", -limit, -1)]
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_TURNS = 50
TTL_S = 86400

# Push, keep the newest ARGV[2] turns, expire after ARGV[3] seconds: one atomic step.
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
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Turn} from 'memory/sessions';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_TURNS = 50;
export const TTL_S = 86400;

/** Append a turn; resolves how many turns the buffer holds. */
export async function appendTurn(tenant: string, sessionId: string, turn: Turn): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`turns:\${sessionId}\`;
  await redis.rpush(key, JSON.stringify(turn));
  await redis.ltrim(key, 0, MAX_TURNS - 1);
  return redis.llen(key);
}

/** The session's last limit turns, oldest first. */
export async function recentTurns(tenant: string, sessionId: string, limit = MAX_TURNS): Promise<Turn[]> {
  const raw = await redis.lrange(\`turns:\${sessionId}\`, -limit, -1);
  return raw.map(text => JSON.parse(text) as Turn);
}
`,
      solution: `import Redis from 'ioredis';

import type {Turn} from 'memory/sessions';

export const MAX_TURNS = 50;
export const TTL_S = 86400;

/** Push, keep the newest ARGV[2] turns, expire after ARGV[3] seconds: one atomic step. */
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
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"memory/sessions" // sessions.Turn
)

const (
	maxTurns   = 50
	ttlSeconds = 86400
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// appendTurn appends a turn and returns how many turns the buffer holds.
func appendTurn(ctx context.Context, tenant, sessionID string, turn sessions.Turn) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "turns:" + sessionID
	raw, _ := json.Marshal(turn)
	if err := rdb.RPush(ctx, key, string(raw)).Err(); err != nil {
		return 0, err
	}
	if err := rdb.LTrim(ctx, key, 0, maxTurns-1).Err(); err != nil {
		return 0, err
	}
	return rdb.LLen(ctx, key).Result()
}

// recentTurns is the session's last limit turns, oldest first.
func recentTurns(ctx context.Context, tenant, sessionID string, limit int) ([]sessions.Turn, error) {
	raw, err := rdb.LRange(ctx, "turns:"+sessionID, int64(-limit), -1).Result()
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
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"memory/sessions" // sessions.Turn
)

const (
	maxTurns   = 50
	ttlSeconds = 86400
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// appendScript pushes, keeps the newest ARGV[2] turns and expires after ARGV[3] seconds: one atomic step.
var appendScript = redis.NewScript(\`
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('LLEN', KEYS[1])
\`)

func bufferKey(tenant, sessionID string) string {
	return "turns:" + tenant + ":" + sessionID
}

// appendTurn appends a turn and returns how many turns the buffer holds.
func appendTurn(ctx context.Context, tenant, sessionID string, turn sessions.Turn) (int64, error) {
	raw, _ := json.Marshal(turn)
	return appendScript.Run(ctx, rdb, []string{bufferKey(tenant, sessionID)}, string(raw), maxTurns, ttlSeconds).Int64()
}

// recentTurns is the session's last limit turns, oldest first.
func recentTurns(ctx context.Context, tenant, sessionID string, limit int) ([]sessions.Turn, error) {
	raw, err := rdb.LRange(ctx, bufferKey(tenant, sessionID), int64(-limit), -1).Result()
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
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import memory.Sessions // Sessions.Turn

object State {
  val MaxTurns = 50
  val TtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)

  /** Append a turn; returns how many turns the buffer holds. */
  def appendTurn(tenant: String, sessionId: String, turn: Sessions.Turn): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"turns:$sessionId"
    jedis.rpush(key, turn.toJson.compactPrint)
    jedis.ltrim(key, 0, MaxTurns - 1)
    jedis.llen(key)
  }

  /** The session's last limit turns, oldest first. */
  def recentTurns(tenant: String, sessionId: String, limit: Int = MaxTurns): Seq[Sessions.Turn] =
    jedis.lrange(s"turns:$sessionId", -limit.toLong, -1L).asScala.toSeq.map(raw => Sessions.Turn.fromJson(raw.parseJson))
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import memory.Sessions // Sessions.Turn

object State {
  val MaxTurns = 50
  val TtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)

  /** Push, keep the newest ARGV[2] turns, expire after ARGV[3] seconds: one atomic step. */
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
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "memory/sessions.h"  // sessions::Turn

constexpr long kMaxTurns = 50;
constexpr long kTtlSeconds = 86400;

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Append a turn; returns how many turns the buffer holds.
long long appendTurn(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "turns:" + session_id;
  redis().rpush(key, nlohmann::json(turn).dump());
  redis().ltrim(key, 0, kMaxTurns - 1);
  return redis().llen(key);
}

// The session's last limit turns, oldest first.
std::vector<sessions::Turn> recentTurns(const std::string& tenant, const std::string& session_id, long limit = kMaxTurns) {
  std::vector<std::string> raw;
  redis().lrange("turns:" + session_id, -limit, -1, std::back_inserter(raw));
  std::vector<sessions::Turn> turns;
  for (const std::string& text : raw) turns.push_back(nlohmann::json::parse(text).get<sessions::Turn>());
  return turns;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "memory/sessions.h"  // sessions::Turn

constexpr long kMaxTurns = 50;
constexpr long kTtlSeconds = 86400;

// Push, keep the newest ARGV[2] turns, expire after ARGV[3] seconds: one atomic step.
const std::string kAppendLua = R"lua(
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('LLEN', KEYS[1])
)lua";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string bufferKey(const std::string& tenant, const std::string& session_id) { return "turns:" + tenant + ":" + session_id; }

// Append a turn; returns how many turns the buffer holds.
long long appendTurn(const std::string& tenant, const std::string& session_id, const sessions::Turn& turn) {
  return redis().eval<long long>(kAppendLua, {bufferKey(tenant, session_id)},
                                 {nlohmann::json(turn).dump(), std::to_string(kMaxTurns), std::to_string(kTtlSeconds)});
}

// The session's last limit turns, oldest first.
std::vector<sessions::Turn> recentTurns(const std::string& tenant, const std::string& session_id, long limit = kMaxTurns) {
  std::vector<std::string> raw;
  redis().lrange(bufferKey(tenant, session_id), -limit, -1, std::back_inserter(raw));
  std::vector<sessions::Turn> turns;
  for (const std::string& text : raw) turns.push_back(nlohmann::json::parse(text).get<sessions::Turn>());
  return turns;
}
`,
    },
  },
  harness: {
    python: `def _turn(n, content=None):
    return {"turn_id": f"t-{n}", "role": "user" if n % 2 else "assistant", "content": content or f"turn {n}", "tokens": 2}


def _ids(turns):
    return [t["turn_id"] for t in turns]


def _only_key(ctx):
    keys = sorted(ctx.redis.keys("turns:*"))
    assert len(keys) == 1, f"one session's appends must write one list, Redis holds {keys}"
    return keys[0]


def check_tenant_key(ctx):
    m = ctx.load("state")
    m.append_turn("t1", "s-1", _turn(1, "t1: ship on the 14th"))
    m.append_turn("t2", "s-1", _turn(1, "t2: cancel the order"))
    seen = [t["content"] for t in m.recent_turns("t1", "s-1")]
    assert seen == ["t1: ship on the 14th"], f"tenant t1 reads {seen} from its session s-1: two tenants that pick the same session id share one buffer"
    seen = [t["content"] for t in m.recent_turns("t2", "s-1")]
    assert seen == ["t2: cancel the order"], f"tenant t2 reads {seen} from its session s-1"
    keys = sorted(ctx.redis.keys("turns:*"))
    assert keys == ["turns:t1:s-1", "turns:t2:s-1"], f"the buffers must be turns:t1:s-1 and turns:t2:s-1 (buffer_key), Redis holds {keys}"


def check_keeps_newest(ctx):
    m = ctx.load("state")
    length = 0
    for n in range(1, 61):
        length = m.append_turn("t1", "s-1", _turn(n))
    assert length == 50, f"after 60 appends append_turn reports {length} turns, expected the cap of 50"
    ids = _ids(m.recent_turns("t1", "s-1"))
    assert ids and ids[-1] == "t-60", f"the newest turn t-60 is gone: the buffer ends at {ids[-1] if ids else None}. The list grows at the tail; trim the old end"
    assert ids == [f"t-{n}" for n in range(11, 61)], f"the buffer must hold t-11..t-60 oldest first, it holds {ids[:2]}..{ids[-2:]} ({len(ids)} turns)"
    assert _ids(m.recent_turns("t1", "s-1", 5)) == [f"t-{n}" for n in range(56, 61)], f"recent_turns(limit=5) gives {_ids(m.recent_turns('t1', 's-1', 5))}, expected t-56..t-60"


def check_idle_expiry(ctx):
    m = ctx.load("state")
    m.append_turn("t1", "s-1", _turn(1))
    key = _only_key(ctx)
    ttl = ctx.redis.ttl(key)
    assert 86000 < ttl <= 86400, f"the buffer {key} has TTL {ttl} after an append: an idle session's list must expire 24 hours after its last append"
    ctx.clock.advance(80000)
    m.append_turn("t1", "s-1", _turn(2))
    assert ctx.redis.ttl(key) > 86000, f"an append 80000 s later left TTL {ctx.redis.ttl(key)}: every append pushes the expiry out to a day after it"
    ctx.clock.advance(80000)
    assert _ids(m.recent_turns("t1", "s-1")) == ["t-1", "t-2"], f"a session appended to 80000 s ago lost its turns: {_ids(m.recent_turns('t1', 's-1'))}"
    ctx.clock.advance(6500)
    assert m.recent_turns("t1", "s-1") == [], f"a day after the last append the buffer still holds {_ids(m.recent_turns('t1', 's-1'))}"


def check_atomic_append(ctx):
    m = ctx.load("state")
    for n in range(1, 51):
        m.append_turn("t1", "s-1", _turn(n))
    key = _only_key(ctx)
    full = ctx.redis_after(key, lambda: ctx.redis.llen(key))
    m.append_turn("t1", "s-1", _turn(51))
    assert full.fired, f"append_turn never touched {key}"
    assert full.result <= 50, f"right after append_turn's first command {key} held {full.result} turns: a reader between the push and the trim sees more than the cap. Push, trim and expire in one script"
    fresh_key = key.replace("s-1", "s-2")
    fresh = ctx.redis_after(fresh_key, lambda: ctx.redis.ttl(fresh_key))
    m.append_turn("t1", "s-2", _turn(1))
    assert fresh.fired, f"append_turn for session s-2 never touched {fresh_key}"
    if ctx.redis.ttl(fresh_key) > 0:
        assert fresh.result > 0, f"right after append_turn's first command {fresh_key} had no TTL: a crash before the EXPIRE leaves the list for good. Push, trim and expire in one script"
`,
    typescript: `const turn = (n: number, content?: string) => ({turn_id: \`t-\${n}\`, role: n % 2 ? 'user' : 'assistant', content: content ?? \`turn \${n}\`, tokens: 2});

const ids = turns => turns.map(t => t.turn_id);

function onlyKey(ctx): string {
  const keys = (ctx.redis.keys('turns:*') as string[]).sort();
  assert.equal(keys.length, 1, \`one session's appends must write one list, Redis holds \${JSON.stringify(keys)}\`);
  return keys[0];
}

export async function check_tenant_key(ctx) {
  const m = ctx.load('state');
  await m.appendTurn('t1', 's-1', turn(1, 't1: ship on the 14th'));
  await m.appendTurn('t2', 's-1', turn(1, 't2: cancel the order'));
  let seen = (await m.recentTurns('t1', 's-1')).map(t => t.content);
  assert.deepStrictEqual(seen, ['t1: ship on the 14th'], \`tenant t1 reads \${JSON.stringify(seen)} from its session s-1: two tenants that pick the same session id share one buffer\`);
  seen = (await m.recentTurns('t2', 's-1')).map(t => t.content);
  assert.deepStrictEqual(seen, ['t2: cancel the order'], \`tenant t2 reads \${JSON.stringify(seen)} from its session s-1\`);
  const keys = (ctx.redis.keys('turns:*') as string[]).sort();
  assert.deepStrictEqual(keys, ['turns:t1:s-1', 'turns:t2:s-1'], \`the buffers must be turns:t1:s-1 and turns:t2:s-1 (bufferKey), Redis holds \${JSON.stringify(keys)}\`);
}

export async function check_keeps_newest(ctx) {
  const m = ctx.load('state');
  let length = 0;
  for (let n = 1; n <= 60; n++) length = await m.appendTurn('t1', 's-1', turn(n));
  assert.equal(length, 50, \`after 60 appends appendTurn reports \${length} turns, expected the cap of 50\`);
  const held = ids(await m.recentTurns('t1', 's-1'));
  assert.equal(held[held.length - 1], 't-60', \`the newest turn t-60 is gone: the buffer ends at \${held[held.length - 1]}. The list grows at the tail; trim the old end\`);
  const want = Array.from({length: 50}, (_, i) => \`t-\${i + 11}\`);
  assert.deepStrictEqual(held, want, \`the buffer must hold t-11..t-60 oldest first, it holds \${held[0]}..\${held[held.length - 1]} (\${held.length} turns)\`);
  assert.deepStrictEqual(ids(await m.recentTurns('t1', 's-1', 5)), ['t-56', 't-57', 't-58', 't-59', 't-60'], 'recentTurns with limit 5 must give t-56..t-60');
}

export async function check_idle_expiry(ctx) {
  const m = ctx.load('state');
  await m.appendTurn('t1', 's-1', turn(1));
  const key = onlyKey(ctx);
  const ttl = ctx.redis.ttl(key);
  assert(86000 < ttl && ttl <= 86400, \`the buffer \${key} has TTL \${ttl} after an append: an idle session's list must expire 24 hours after its last append\`);
  ctx.clock.advance(80000);
  await m.appendTurn('t1', 's-1', turn(2));
  assert(ctx.redis.ttl(key) > 86000, \`an append 80000 s later left TTL \${ctx.redis.ttl(key)}: every append pushes the expiry out to a day after it\`);
  ctx.clock.advance(80000);
  assert.deepStrictEqual(ids(await m.recentTurns('t1', 's-1')), ['t-1', 't-2'], 'a session appended to 80000 s ago lost its turns');
  ctx.clock.advance(6500);
  const left = ids(await m.recentTurns('t1', 's-1'));
  assert.deepStrictEqual(left, [], \`a day after the last append the buffer still holds \${JSON.stringify(left)}\`);
}

export async function check_atomic_append(ctx) {
  const m = ctx.load('state');
  for (let n = 1; n <= 50; n++) await m.appendTurn('t1', 's-1', turn(n));
  const key = onlyKey(ctx);
  const full = ctx.redisAfter(key, () => ctx.redis.llen(key));
  await m.appendTurn('t1', 's-1', turn(51));
  assert(full.fired, \`appendTurn never touched \${key}\`);
  assert(full.result <= 50, \`right after appendTurn's first command \${key} held \${full.result} turns: a reader between the push and the trim sees more than the cap. Push, trim and expire in one script\`);
  const freshKey = key.replace('s-1', 's-2');
  const fresh = ctx.redisAfter(freshKey, () => ctx.redis.ttl(freshKey));
  await m.appendTurn('t1', 's-2', turn(1));
  assert(fresh.fired, \`appendTurn for session s-2 never touched \${freshKey}\`);
  if (ctx.redis.ttl(freshKey) > 0) {
    assert(fresh.result > 0, \`right after appendTurn's first command \${freshKey} had no TTL: a crash before the EXPIRE leaves the list for good. Push, trim and expire in one script\`);
  }
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"memory/sessions"

	"leetbuild/harness"
)

var stateBg = context.Background()

func turnN(n int, content string) sessions.Turn {
	if content == "" {
		content = fmt.Sprintf("turn %d", n)
	}
	role := "assistant"
	if n%2 == 1 {
		role = "user"
	}
	return sessions.Turn{TurnID: fmt.Sprintf("t-%d", n), Role: role, Content: content, Tokens: 2}
}

func mustAppend(ctx *harness.Ctx, tenant, sessionID string, turn sessions.Turn) int64 {
	n, err := appendTurn(stateBg, tenant, sessionID, turn)
	ctx.NoError(err, "appendTurn(%s, %s, %s) failed", tenant, sessionID, turn.TurnID)
	return n
}

func recentIDs(ctx *harness.Ctx, tenant, sessionID string, limit int) []string {
	turns, err := recentTurns(stateBg, tenant, sessionID, limit)
	ctx.NoError(err, "recentTurns(%s, %s) failed", tenant, sessionID)
	out := []string{}
	for _, t := range turns {
		out = append(out, t.TurnID)
	}
	return out
}

func recentContents(ctx *harness.Ctx, tenant, sessionID string) []string {
	turns, err := recentTurns(stateBg, tenant, sessionID, maxTurns)
	ctx.NoError(err, "recentTurns(%s, %s) failed", tenant, sessionID)
	out := []string{}
	for _, t := range turns {
		out = append(out, t.Content)
	}
	return out
}

func onlyKey(ctx *harness.Ctx) string {
	keys := ctx.Redis.Keys("turns:*")
	ctx.Assert(len(keys) == 1, "one session's appends must write one list, Redis holds %q", keys)
	return keys[0]
}

func CheckTenantKey(ctx *harness.Ctx) {
	mustAppend(ctx, "t1", "s-1", turnN(1, "t1: ship on the 14th"))
	mustAppend(ctx, "t2", "s-1", turnN(1, "t2: cancel the order"))
	seen := recentContents(ctx, "t1", "s-1")
	ctx.Equal(seen, []string{"t1: ship on the 14th"}, "tenant t1 reads from its session s-1 (two tenants that pick the same session id must not share one buffer)")
	ctx.Equal(recentContents(ctx, "t2", "s-1"), []string{"t2: cancel the order"}, "tenant t2 reads from its session s-1")
	ctx.Equal(ctx.Redis.Keys("turns:*"), []string{"turns:t1:s-1", "turns:t2:s-1"}, "the buffers must be turns:t1:s-1 and turns:t2:s-1 (bufferKey); Redis holds")
}

func CheckKeepsNewest(ctx *harness.Ctx) {
	var length int64
	for n := 1; n <= 60; n++ {
		length = mustAppend(ctx, "t1", "s-1", turnN(n, ""))
	}
	ctx.Equal(length, int64(50), "after 60 appends appendTurn must report the cap of 50 turns")
	held := recentIDs(ctx, "t1", "s-1", maxTurns)
	last := ""
	if len(held) > 0 {
		last = held[len(held)-1]
	}
	ctx.Assert(last == "t-60", "the newest turn t-60 is gone: the buffer ends at %q. The list grows at the tail; trim the old end", last)
	want := []string{}
	for n := 11; n <= 60; n++ {
		want = append(want, fmt.Sprintf("t-%d", n))
	}
	ctx.Equal(held, want, "the buffer must hold t-11..t-60 oldest first")
	ctx.Equal(recentIDs(ctx, "t1", "s-1", 5), []string{"t-56", "t-57", "t-58", "t-59", "t-60"}, "recentTurns with limit 5")
}

func CheckIdleExpiry(ctx *harness.Ctx) {
	mustAppend(ctx, "t1", "s-1", turnN(1, ""))
	key := onlyKey(ctx)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(86000 < ttl && ttl <= 86400, "the buffer %s has TTL %d after an append: an idle session's list must expire 24 hours after its last append", key, ttl)
	ctx.Clock.Advance(80000)
	mustAppend(ctx, "t1", "s-1", turnN(2, ""))
	ctx.Assert(ctx.Redis.TTL(key) > 86000, "an append 80000 s later left TTL %d: every append pushes the expiry out to a day after it", ctx.Redis.TTL(key))
	ctx.Clock.Advance(80000)
	ctx.Equal(recentIDs(ctx, "t1", "s-1", maxTurns), []string{"t-1", "t-2"}, "a session appended to 80000 s ago must keep its turns")
	ctx.Clock.Advance(6500)
	left := recentIDs(ctx, "t1", "s-1", maxTurns)
	ctx.Assert(len(left) == 0, "a day after the last append the buffer still holds %q", left)
}

func CheckAtomicAppend(ctx *harness.Ctx) {
	for n := 1; n <= 50; n++ {
		mustAppend(ctx, "t1", "s-1", turnN(n, ""))
	}
	key := onlyKey(ctx)
	full := ctx.Redis.After(key, func() any { return ctx.Redis.LLen(key) })
	mustAppend(ctx, "t1", "s-1", turnN(51, ""))
	ctx.Assert(full.Fired, "appendTurn never touched %s", key)
	held, _ := full.Result.(int64)
	ctx.Assert(held <= 50, "right after appendTurn's first command %s held %d turns: a reader between the push and the trim sees more than the cap. Push, trim and expire in one script", key, held)
	freshKey := strings.Replace(key, "s-1", "s-2", 1)
	fresh := ctx.Redis.After(freshKey, func() any { return ctx.Redis.TTL(freshKey) })
	mustAppend(ctx, "t1", "s-2", turnN(1, ""))
	ctx.Assert(fresh.Fired, "appendTurn for session s-2 never touched %s", freshKey)
	if ctx.Redis.TTL(freshKey) > 0 {
		ttl, _ := fresh.Result.(int64)
		ctx.Assert(ttl > 0, "right after appendTurn's first command %s had no TTL: a crash before the EXPIRE leaves the list for good. Push, trim and expire in one script", freshKey)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

namespace {

sessions::Turn turnN(int n, const std::string& content = "") {
  return sessions::Turn{"t-" + std::to_string(n), n % 2 ? "user" : "assistant", content.empty() ? "turn " + std::to_string(n) : content, 2};
}

std::vector<std::string> recentIds(const std::string& tenant, const std::string& session_id, long limit = kMaxTurns) {
  std::vector<std::string> out;
  for (const auto& t : recentTurns(tenant, session_id, limit)) out.push_back(t.turn_id);
  return out;
}

std::vector<std::string> recentContents(const std::string& tenant, const std::string& session_id) {
  std::vector<std::string> out;
  for (const auto& t : recentTurns(tenant, session_id)) out.push_back(t.content);
  return out;
}

std::string onlyKey(harness::Ctx& ctx) {
  const auto keys = ctx.Redis.Keys("turns:*");
  ctx.Assert(keys.size() == 1, "one session's appends must write one list, Redis holds %q", keys);
  return keys[0];
}

// What a probe saw: whether it fired and the number it read.
struct Seen {
  bool fired = false;
  long long value = 0;
};

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  appendTurn("t1", "s-1", turnN(1, "t1: ship on the 14th"));
  appendTurn("t2", "s-1", turnN(1, "t2: cancel the order"));
  ctx.Equal(recentContents("t1", "s-1"), {"t1: ship on the 14th"}, "tenant t1 reads from its session s-1 (two tenants that pick the same session id must not share one buffer)");
  ctx.Equal(recentContents("t2", "s-1"), {"t2: cancel the order"}, "tenant t2 reads from its session s-1");
  ctx.Equal(ctx.Redis.Keys("turns:*"), {"turns:t1:s-1", "turns:t2:s-1"}, "the buffers must be turns:t1:s-1 and turns:t2:s-1 (bufferKey); Redis holds");
}

void CheckKeepsNewest(harness::Ctx& ctx) {
  long long length = 0;
  for (int n = 1; n <= 60; n++) length = appendTurn("t1", "s-1", turnN(n));
  ctx.Equal(length, 50LL, "after 60 appends appendTurn must report the cap of 50 turns");
  const auto held = recentIds("t1", "s-1");
  const std::string last = held.empty() ? "" : held.back();
  ctx.Assert(last == "t-60", "the newest turn t-60 is gone: the buffer ends at %q. The list grows at the tail; trim the old end", last);
  std::vector<std::string> want;
  for (int n = 11; n <= 60; n++) want.push_back("t-" + std::to_string(n));
  ctx.Equal(held, want, "the buffer must hold t-11..t-60 oldest first");
  ctx.Equal(recentIds("t1", "s-1", 5), {"t-56", "t-57", "t-58", "t-59", "t-60"}, "recentTurns with limit 5");
}

void CheckIdleExpiry(harness::Ctx& ctx) {
  appendTurn("t1", "s-1", turnN(1));
  const std::string key = onlyKey(ctx);
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(86000 < ttl && ttl <= 86400, "the buffer %s has TTL %d after an append: an idle session's list must expire 24 hours after its last append", key, ttl);
  ctx.Clock.Advance(80000);
  appendTurn("t1", "s-1", turnN(2));
  ctx.Assert(ctx.Redis.TTL(key) > 86000, "an append 80000 s later left TTL %d: every append pushes the expiry out to a day after it", ctx.Redis.TTL(key));
  ctx.Clock.Advance(80000);
  ctx.Equal(recentIds("t1", "s-1"), {"t-1", "t-2"}, "a session appended to 80000 s ago must keep its turns");
  ctx.Clock.Advance(6500);
  const auto left = recentIds("t1", "s-1");
  ctx.Assert(left.empty(), "a day after the last append the buffer still holds %q", left);
}

void CheckAtomicAppend(harness::Ctx& ctx) {
  for (int n = 1; n <= 50; n++) appendTurn("t1", "s-1", turnN(n));
  const std::string key = onlyKey(ctx);
  auto full = std::make_shared<Seen>();
  ctx.Redis.After(key, [&ctx, full, key] {
    full->fired = true;
    full->value = ctx.Redis.LLen(key);
  });
  appendTurn("t1", "s-1", turnN(51));
  ctx.Assert(full->fired, "appendTurn never touched %s", key);
  ctx.Assert(full->value <= 50, "right after appendTurn's first command %s held %d turns: a reader between the push and the trim sees more than the cap. Push, trim and expire in one script", key, full->value);
  std::string fresh_key = key;
  fresh_key.replace(fresh_key.find("s-1"), 3, "s-2");
  auto fresh = std::make_shared<Seen>();
  ctx.Redis.After(fresh_key, [&ctx, fresh, fresh_key] {
    fresh->fired = true;
    fresh->value = ctx.Redis.TTL(fresh_key);
  });
  appendTurn("t1", "s-2", turnN(1));
  ctx.Assert(fresh->fired, "appendTurn for session s-2 never touched %s", fresh_key);
  if (ctx.Redis.TTL(fresh_key) > 0) {
    ctx.Assert(fresh->value > 0, "right after appendTurn's first command %s had no TTL: a crash before the EXPIRE leaves the list for good. Push, trim and expire in one script", fresh_key);
  }
}
`,
  },
  hints: [
    "Two tenants that both call a conversation `s-1` read each other's turns; after 60 turns the buffer still starts at `t-1` and the newest ten are gone; a session left alone stays in Redis indefinitely.",
    'The key is built from the session id alone. `LTRIM 0 49` keeps the first 50 entries of a list that grows at the tail, so it drops what was just pushed. Nothing sets a TTL, and the commands are separate round trips.',
    'Key by `turns:{tenant}:{session_id}`, then one Lua script run with `register_script`: `RPUSH KEYS[1] ARGV[1]`, `LTRIM KEYS[1] -ARGV[2] -1`, `EXPIRE KEYS[1] ARGV[3]`, return `LLEN`.',
  ],
  debrief: `A list that grows at the tail keeps its newest entries at negative indexes, which is why the trim is \`-50 -1\`; the starter's \`0 49\` is right only for a list that grows at the head. Putting push, trim and expire in one script closes two windows: a reader cannot see 51 turns, and a crash between the push and the expire cannot leave a list with no TTL. The tenant in the key is the cheapest isolation there is, and it costs nothing at read time. Production buffers also cap bytes, not just turns, since one pasted document can outweigh fifty short ones, and they archive an expired session to cold storage before dropping it.`,
};
