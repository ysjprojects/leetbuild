import type {Step} from '@/lib/types';

export const sessionStateStep: Step = {
  id: 'state',
  title: 'Redis turn state where barge-in and late frames cannot race',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['gateway', 'redis'],
  task: `## Task

**Starting point.** The starter is the turn state the speech loop shares, one hash
\`voice:state:{session_id}\` with \`current_speaker\`, \`turn_index\` and \`tts_offset\`:
\`record_frame(session_id, turn_index, tts_offset)\` writes the three fields for every frame of the
agent's answer, \`barge_in(session_id, heard_tokens)\` sets the speaker to \`user\`, increments the turn
and returns the stored offset, and \`read_state(session_id)\` reads the fields one \`HGET\` at a time.
It serves the demo call and hides five flaws.

**Failure mode the checks target.** A read that lands mid-barge-in sees the caller holding the floor
on the agent's turn; a late frame of the interrupted answer hands the floor back to the agent; the
answer is truncated at what the stream sent, not at what the caller heard; and a call that went
silent stays in Redis.

- \`barge_in\` is **one Lua script**: speaker \`user\`, \`turn_index\` + 1, and \`tts_offset\` set to
  \`math.min(sent, heard_tokens)\`, which it returns.
- \`record_frame\` is one Lua script too: it applies only while \`turn_index\` is still the frame's
  turn (an absent key is turn 0) and returns whether it did.
- Both scripts \`EXPIRE\` the key for \`STATE_TTL_S\` (30): every frame keeps a long answer alive.
- \`read_state\` is one \`HMGET\`.`,
  sequence: {
    participants: ['Playback', 'Voice Gateway', 'Redis'],
    messages: [
      {from: 'Playback', to: 'Voice Gateway', label: 'frame of turn 0 played up to token 40', kind: 'async'},
      {from: 'Voice Gateway', to: 'Redis', label: 'EVAL frame · turn_index still 0? · EXPIRE 30', kind: 'sync'},
      {from: 'Voice Gateway', to: 'Redis', label: 'EVAL barge_in · heard 25 → user, turn 1, offset 25', kind: 'sync'},
      {from: 'Redis', to: 'Voice Gateway', label: '25: stop the answer there', kind: 'reply'},
      {from: 'Playback', to: 'Voice Gateway', label: 'late frame of turn 0 (token 41)', kind: 'async'},
      {from: 'Voice Gateway', to: 'Redis', label: 'EVAL frame · turn is 1 → 0, dropped', kind: 'sync'},
      {from: 'Voice Gateway', to: 'Redis', label: 'HMGET current_speaker turn_index tts_offset', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-barge-in',
      title: 'Barge-in is one atomic transition',
      detail:
        'The speaker change, the turn increment and the truncation run inside one Lua script (`register_script`/`EVAL`), so a read can only see the state before or after it; the starter sends three commands.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.HIncrBy\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrBy\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
      },
    },
    {
      id: 'read-atomic',
      title: 'Reads the whole turn state in one round trip',
      detail:
        '`read_state` reads speaker, turn and offset with one `HMGET`; field-at-a-time `HGET`s let a barge-in land between them and return a state that never existed.',
      match: {
        python: {all: [/\.hmget\(|\.hgetall\(/], none: [/\.hget\(/]},
        typescript: {all: [/\.hmget\(|\.hgetall\(/], none: [/\.hget\(/]},
        go: {all: [/\.HMGet\(|\.HGetAll\(/], none: [/\.HGet\(/]},
        scala: {all: [/\.hmget\(|\.hgetAll\(/], none: [/\.hget\(/]},
        cpp: {all: [/\.hmget\(|\.hgetall\(/], none: [/\.hget\(/]},
      },
    },
    {
      id: 'stale-frame',
      title: 'A late frame of an interrupted answer is dropped',
      detail:
        "`record_frame`'s script compares the stored `turn_index` with the frame's turn and returns 0 without writing once barge-in moved the session on; the starter writes every frame.",
      match: {
        python: {all: [/redis\.call\(\s*['"]HGET['"],\s*KEYS\[1\],\s*['"]turn_index['"]\s*\)/, /return 0/]},
        typescript: {all: [/redis\.call\(\s*['"]HGET['"],\s*KEYS\[1\],\s*['"]turn_index['"]\s*\)/, /return 0/]},
        go: {all: [/redis\.call\(\s*['"]HGET['"],\s*KEYS\[1\],\s*['"]turn_index['"]\s*\)/, /return 0/]},
        scala: {all: [/redis\.call\(\s*['"]HGET['"],\s*KEYS\[1\],\s*['"]turn_index['"]\s*\)/, /return 0/]},
        cpp: {all: [/redis\.call\(\s*['"]HGET['"],\s*KEYS\[1\],\s*['"]turn_index['"]\s*\)/, /return 0/]},
      },
    },
    {
      id: 'truncate',
      title: 'Truncates the answer at what the caller heard',
      detail:
        '`barge_in` stores and returns `math.min(sent, heard_tokens)`: the stream runs ahead of playback, so the offset it sent is not what the caller heard.',
      match: {
        python: {all: [/math\.min\(/]},
        typescript: {all: [/math\.min\(/]},
        go: {all: [/math\.min\(/]},
        scala: {all: [/math\.min\(/]},
        cpp: {all: [/math\.min\(/]},
      },
    },
    {
      id: 'ttl-refresh',
      title: 'Turn state expires 30 s after the last frame',
      detail:
        'Both scripts `EXPIRE` the key for `STATE_TTL_S` (30), so every frame and every barge-in refresh it and a silent call ends; the starter never sets an expiry.',
      match: {
        python: {all: [/STATE_TTL_S\s*=\s*30/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        typescript: {all: [/STATE_TTL_S\s*=\s*30/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        go: {all: [/stateTTLS\s*=\s*30/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        scala: {all: [/StateTtlSeconds\s*=\s*30/, /redis\.call\(\s*['"]EXPIRE['"]/]},
        cpp: {all: [/kStateTtlS\s*=\s*30/, /redis\.call\(\s*['"]EXPIRE['"]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def state_key(session_id: str) -> str:
    return f"voice:state:{session_id}"


def record_frame(session_id: str, turn_index: int, tts_offset: int) -> bool:
    """The agent's answer for turn_index has been played up to tts_offset; False when the turn moved on."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    r.hset(state_key(session_id), mapping={"current_speaker": "agent", "turn_index": turn_index, "tts_offset": tts_offset})
    return True


def barge_in(session_id: str, heard_tokens: int) -> int:
    """The caller took the floor after hearing heard_tokens; returns the offset the answer stops at."""
    key = state_key(session_id)
    r.hset(key, "current_speaker", "user")
    r.hincrby(key, "turn_index", 1)
    return int(r.hget(key, "tts_offset") or 0)


def read_state(session_id: str) -> dict | None:
    """current_speaker, turn_index and tts_offset, or None for a session with no state."""
    key = state_key(session_id)
    speaker = r.hget(key, "current_speaker")
    if speaker is None:
        return None
    return {"current_speaker": speaker, "turn_index": int(r.hget(key, "turn_index") or 0), "tts_offset": int(r.hget(key, "tts_offset") or 0)}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATE_TTL_S = 30

# A frame counts only for the turn it belongs to: once barge-in moved the session on, it is dropped.
FRAME_LUA = """
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
"""

# The floor, the turn and the truncation change together; the answer stops at what the caller heard.
BARGE_IN_LUA = """
local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
local heard = math.min(sent, tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return heard
"""

frame = r.register_script(FRAME_LUA)
interrupt = r.register_script(BARGE_IN_LUA)


def state_key(session_id: str) -> str:
    return f"voice:state:{session_id}"


def record_frame(session_id: str, turn_index: int, tts_offset: int) -> bool:
    """The agent's answer for turn_index has been played up to tts_offset; False when the turn moved on."""
    return frame(keys=[state_key(session_id)], args=[turn_index, tts_offset, STATE_TTL_S]) == 1


def barge_in(session_id: str, heard_tokens: int) -> int:
    """The caller took the floor after hearing heard_tokens; returns the offset the answer stops at."""
    return int(interrupt(keys=[state_key(session_id)], args=[heard_tokens, STATE_TTL_S]))


def read_state(session_id: str) -> dict | None:
    """current_speaker, turn_index and tts_offset, or None for a session with no state."""
    speaker, turn, offset = r.hmget(state_key(session_id), "current_speaker", "turn_index", "tts_offset")
    if speaker is None:
        return None
    return {"current_speaker": speaker, "turn_index": int(turn or 0), "tts_offset": int(offset or 0)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface TurnState {
  current_speaker: string;
  turn_index: number;
  tts_offset: number;
}

export const stateKey = (sessionId: string): string => \`voice:state:\${sessionId}\`;

/** The agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on. */
export async function recordFrame(sessionId: string, turnIndex: number, ttsOffset: number): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  await redis.hset(stateKey(sessionId), {current_speaker: 'agent', turn_index: String(turnIndex), tts_offset: String(ttsOffset)});
  return true;
}

/** The caller took the floor after hearing heardTokens; returns the offset the answer stops at. */
export async function bargeIn(sessionId: string, heardTokens: number): Promise<number> {
  const key = stateKey(sessionId);
  await redis.hset(key, 'current_speaker', 'user');
  await redis.hincrby(key, 'turn_index', 1);
  return Number((await redis.hget(key, 'tts_offset')) ?? 0);
}

/** current_speaker, turn_index and tts_offset, or null for a session with no state. */
export async function readState(sessionId: string): Promise<TurnState | null> {
  const key = stateKey(sessionId);
  const speaker = await redis.hget(key, 'current_speaker');
  if (speaker === null) return null;
  const turn = await redis.hget(key, 'turn_index');
  const offset = await redis.hget(key, 'tts_offset');
  return {current_speaker: speaker, turn_index: Number(turn ?? 0), tts_offset: Number(offset ?? 0)};
}
`,
      solution: `import Redis from 'ioredis';

export const STATE_TTL_S = 30;

// A frame counts only for the turn it belongs to: once barge-in moved the session on, it is dropped.
export const FRAME_LUA = \`
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
\`;

// The floor, the turn and the truncation change together; the answer stops at what the caller heard.
export const BARGE_IN_LUA = \`
local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
local heard = math.min(sent, tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return heard
\`;

export interface TurnState {
  current_speaker: string;
  turn_index: number;
  tts_offset: number;
}

interface StateRedis extends Redis {
  frame(key: string, turnIndex: number, ttsOffset: number, ttl: number): Promise<number>;
  interrupt(key: string, heardTokens: number, ttl: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('frame', {numberOfKeys: 1, lua: FRAME_LUA});
redis.defineCommand('interrupt', {numberOfKeys: 1, lua: BARGE_IN_LUA});

export const stateKey = (sessionId: string): string => \`voice:state:\${sessionId}\`;

/** The agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on. */
export async function recordFrame(sessionId: string, turnIndex: number, ttsOffset: number): Promise<boolean> {
  return (await redis.frame(stateKey(sessionId), turnIndex, ttsOffset, STATE_TTL_S)) === 1;
}

/** The caller took the floor after hearing heardTokens; returns the offset the answer stops at. */
export async function bargeIn(sessionId: string, heardTokens: number): Promise<number> {
  return Number(await redis.interrupt(stateKey(sessionId), heardTokens, STATE_TTL_S));
}

/** current_speaker, turn_index and tts_offset, or null for a session with no state. */
export async function readState(sessionId: string): Promise<TurnState | null> {
  const [speaker, turn, offset] = await redis.hmget(stateKey(sessionId), 'current_speaker', 'turn_index', 'tts_offset');
  if (speaker === null) return null;
  return {current_speaker: speaker, turn_index: Number(turn ?? 0), tts_offset: Number(offset ?? 0)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TurnState is who holds the floor, which turn the session is on and how much of the answer was played.
type TurnState struct {
	CurrentSpeaker string
	TurnIndex      int
	TTSOffset      int
}

func stateKey(sessionID string) string { return "voice:state:" + sessionID }

// recordFrame: the agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on.
func recordFrame(ctx context.Context, sessionID string, turnIndex, ttsOffset int) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	err := rdb.HSet(ctx, stateKey(sessionID), "current_speaker", "agent", "turn_index", turnIndex, "tts_offset", ttsOffset).Err()
	return err == nil, err
}

// bargeIn: the caller took the floor after hearing heardTokens; returns the offset the answer stops at.
func bargeIn(ctx context.Context, sessionID string, heardTokens int) (int, error) {
	key := stateKey(sessionID)
	if err := rdb.HSet(ctx, key, "current_speaker", "user").Err(); err != nil {
		return 0, err
	}
	if err := rdb.HIncrBy(ctx, key, "turn_index", 1).Err(); err != nil {
		return 0, err
	}
	offset, err := rdb.HGet(ctx, key, "tts_offset").Int()
	if err == redis.Nil {
		return 0, nil
	}
	return offset, err
}

// readState is current_speaker, turn_index and tts_offset, or nil for a session with no state.
func readState(ctx context.Context, sessionID string) (*TurnState, error) {
	key := stateKey(sessionID)
	speaker, err := rdb.HGet(ctx, key, "current_speaker").Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	turn, _ := rdb.HGet(ctx, key, "turn_index").Int()
	offset, _ := rdb.HGet(ctx, key, "tts_offset").Int()
	return &TurnState{CurrentSpeaker: speaker, TurnIndex: turn, TTSOffset: offset}, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const stateTTLS = 30

// frame counts only for the turn it belongs to: once barge-in moved the session on, it is dropped.
var frame = redis.NewScript(\`
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
\`)

// interrupt changes the floor, the turn and the truncation together; the answer stops at what the caller heard.
var interrupt = redis.NewScript(\`
local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
local heard = math.min(sent, tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return heard
\`)

// TurnState is who holds the floor, which turn the session is on and how much of the answer was played.
type TurnState struct {
	CurrentSpeaker string
	TurnIndex      int
	TTSOffset      int
}

func stateKey(sessionID string) string { return "voice:state:" + sessionID }

// recordFrame: the agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on.
func recordFrame(ctx context.Context, sessionID string, turnIndex, ttsOffset int) (bool, error) {
	applied, err := frame.Run(ctx, rdb, []string{stateKey(sessionID)}, turnIndex, ttsOffset, stateTTLS).Int()
	return applied == 1, err
}

// bargeIn: the caller took the floor after hearing heardTokens; returns the offset the answer stops at.
func bargeIn(ctx context.Context, sessionID string, heardTokens int) (int, error) {
	return interrupt.Run(ctx, rdb, []string{stateKey(sessionID)}, heardTokens, stateTTLS).Int()
}

// readState is current_speaker, turn_index and tts_offset, or nil for a session with no state.
func readState(ctx context.Context, sessionID string) (*TurnState, error) {
	values, err := rdb.HMGet(ctx, stateKey(sessionID), "current_speaker", "turn_index", "tts_offset").Result()
	if err != nil || values[0] == nil {
		return nil, err
	}
	number := func(v any) int {
		s, _ := v.(string)
		n, _ := strconv.Atoi(s)
		return n
	}
	return &TurnState{CurrentSpeaker: values[0].(string), TurnIndex: number(values[1]), TTSOffset: number(values[2])}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class TurnState(currentSpeaker: String, turnIndex: Int, ttsOffset: Int)

  val jedis = new JedisPooled("redis", 6379)

  def stateKey(sessionId: String): String = s"voice:state:$sessionId"

  /** The agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on. */
  def recordFrame(sessionId: String, turnIndex: Int, ttsOffset: Int): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    jedis.hset(stateKey(sessionId), Map("current_speaker" -> "agent", "turn_index" -> turnIndex.toString, "tts_offset" -> ttsOffset.toString).asJava)
    true
  }

  /** The caller took the floor after hearing heardTokens; returns the offset the answer stops at. */
  def bargeIn(sessionId: String, heardTokens: Int): Int = {
    val key = stateKey(sessionId)
    jedis.hset(key, "current_speaker", "user")
    jedis.hincrBy(key, "turn_index", 1)
    Option(jedis.hget(key, "tts_offset")).map(_.toInt).getOrElse(0)
  }

  /** current_speaker, turn_index and tts_offset, or None for a session with no state. */
  def readState(sessionId: String): Option[TurnState] = {
    val key = stateKey(sessionId)
    Option(jedis.hget(key, "current_speaker")).map { speaker =>
      TurnState(speaker, Option(jedis.hget(key, "turn_index")).getOrElse("0").toInt, Option(jedis.hget(key, "tts_offset")).getOrElse("0").toInt)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class TurnState(currentSpeaker: String, turnIndex: Int, ttsOffset: Int)

  val StateTtlSeconds = 30

  /** A frame counts only for the turn it belongs to: once barge-in moved the session on, it is dropped. */
  val FrameLua: String =
    """local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
      |if turn ~= tonumber(ARGV[1]) then return 0 end
      |redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |return 1
      |""".stripMargin

  /** The floor, the turn and the truncation change together; the answer stops at what the caller heard. */
  val BargeInLua: String =
    """local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
      |local heard = math.min(sent, tonumber(ARGV[1]))
      |redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
      |redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |return heard
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def stateKey(sessionId: String): String = s"voice:state:$sessionId"

  /** The agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on. */
  def recordFrame(sessionId: String, turnIndex: Int, ttsOffset: Int): Boolean = {
    val args = List(turnIndex.toString, ttsOffset.toString, StateTtlSeconds.toString).asJava
    jedis.eval(FrameLua, List(stateKey(sessionId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The caller took the floor after hearing heardTokens; returns the offset the answer stops at. */
  def bargeIn(sessionId: String, heardTokens: Int): Int = {
    val args = List(heardTokens.toString, StateTtlSeconds.toString).asJava
    jedis.eval(BargeInLua, List(stateKey(sessionId)).asJava, args).asInstanceOf[java.lang.Long].toInt
  }

  /** current_speaker, turn_index and tts_offset, or None for a session with no state. */
  def readState(sessionId: String): Option[TurnState] = {
    val values = jedis.hmget(stateKey(sessionId), "current_speaker", "turn_index", "tts_offset").asScala.toList
    Option(values.head).map(speaker => TurnState(speaker, Option(values(1)).getOrElse("0").toInt, Option(values(2)).getOrElse("0").toInt))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// Who holds the floor, which turn the session is on and how much of the answer was played.
struct TurnState {
  std::string current_speaker;
  long turn_index = 0;
  long tts_offset = 0;
};

std::string stateKey(const std::string& session_id) { return "voice:state:" + session_id; }

// The agent's answer for turn_index has been played up to tts_offset; false when the turn moved on.
bool recordFrame(const std::string& session_id, long turn_index, long tts_offset) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  redis.hset(stateKey(session_id), {{"current_speaker", "agent"}, {"turn_index", std::to_string(turn_index)}, {"tts_offset", std::to_string(tts_offset)}});
  return true;
}

// The caller took the floor after hearing heard_tokens; returns the offset the answer stops at.
long bargeIn(const std::string& session_id, long heard_tokens) {
  const std::string key = stateKey(session_id);
  redis.hset(key, "current_speaker", "user");
  redis.hincrby(key, "turn_index", 1);
  const auto offset = redis.hget(key, "tts_offset");
  return offset ? std::stol(*offset) : 0;
}

// current_speaker, turn_index and tts_offset, or none for a session with no state.
std::optional<TurnState> readState(const std::string& session_id) {
  const std::string key = stateKey(session_id);
  const auto speaker = redis.hget(key, "current_speaker");
  if (!speaker) return std::nullopt;
  const auto turn = redis.hget(key, "turn_index");
  const auto offset = redis.hget(key, "tts_offset");
  return TurnState{*speaker, turn ? std::stol(*turn) : 0, offset ? std::stol(*offset) : 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kStateTtlS = 30;

// A frame counts only for the turn it belongs to: once barge-in moved the session on, it is dropped.
const std::string kFrameLua = R"lua(
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
)lua";

// The floor, the turn and the truncation change together; the answer stops at what the caller heard.
const std::string kBargeInLua = R"lua(
local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
local heard = math.min(sent, tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return heard
)lua";

// Who holds the floor, which turn the session is on and how much of the answer was played.
struct TurnState {
  std::string current_speaker;
  long turn_index = 0;
  long tts_offset = 0;
};

std::string stateKey(const std::string& session_id) { return "voice:state:" + session_id; }

// The agent's answer for turn_index has been played up to tts_offset; false when the turn moved on.
bool recordFrame(const std::string& session_id, long turn_index, long tts_offset) {
  return redis.eval<long long>(kFrameLua, {stateKey(session_id)}, {std::to_string(turn_index), std::to_string(tts_offset), std::to_string(kStateTtlS)}) == 1;
}

// The caller took the floor after hearing heard_tokens; returns the offset the answer stops at.
long bargeIn(const std::string& session_id, long heard_tokens) {
  return static_cast<long>(redis.eval<long long>(kBargeInLua, {stateKey(session_id)}, {std::to_string(heard_tokens), std::to_string(kStateTtlS)}));
}

// current_speaker, turn_index and tts_offset, or none for a session with no state.
std::optional<TurnState> readState(const std::string& session_id) {
  const std::vector<sw::redis::OptionalString> values = redis.hmget(stateKey(session_id), {"current_speaker", "turn_index", "tts_offset"});
  if (!values[0]) return std::nullopt;
  const auto number = [](const sw::redis::OptionalString& v) { return v && !v->empty() ? std::stol(*v) : 0L; };
  return TurnState{*values[0], number(values[1]), number(values[2])};
}
`,
    },
  },
  harness: {
    python: `KEY = "voice:state:vs-1"
BEFORE = {"current_speaker": "agent", "turn_index": 0, "tts_offset": 40}


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_atomic_barge_in(ctx):
    m = ctx.load("state")
    assert m.record_frame("vs-1", 0, 40) is True, "the first frame of turn 0 must be recorded"
    # Another worker reads the state the instant the barge-in's first command has run.
    seen = ctx.redis_after(KEY, lambda: m.read_state("vs-1"))
    m.barge_in("vs-1", 25)
    after = m.read_state("vs-1")
    during = _settled(seen, KEY)
    assert after is not None and after["current_speaker"] == "user" and after["turn_index"] == 1, f"after a barge-in the state is {after}, expected the caller on turn 1"
    assert during in (BEFORE, after), f"a read that landed during the barge-in saw {during}: neither the state before ({BEFORE}) nor after ({after}). The speaker, the turn and the offset must change in one script"


def check_read_atomic(ctx):
    m = ctx.load("state")
    m.record_frame("vs-1", 0, 40)
    # A barge-in lands right after the read's first command.
    rival = ctx.redis_after(KEY, lambda: m.barge_in("vs-1", 25))
    seen = m.read_state("vs-1")
    _settled(rival, KEY)
    after = m.read_state("vs-1")
    assert seen in (BEFORE, after), f"read_state racing a barge-in returned {seen}: neither the state before ({BEFORE}) nor after ({after}). Read the three fields in one HMGET"


def check_stale_frame(ctx):
    m = ctx.load("state")
    m.record_frame("vs-1", 0, 40)
    m.barge_in("vs-1", 25)
    late = m.record_frame("vs-1", 0, 41)
    state = m.read_state("vs-1")
    assert late is False, "a frame of the interrupted answer (turn 0) arrived after the barge-in and record_frame reported it applied: it must return False"
    assert state is not None and state["current_speaker"] == "user" and state["turn_index"] == 1, f"a late frame of turn 0 changed the state to {state}: the agent took the floor back from the caller"
    assert m.record_frame("vs-1", 1, 3) is True, "a frame of the current turn (1) must be recorded"
    assert m.read_state("vs-1") == {"current_speaker": "agent", "turn_index": 1, "tts_offset": 3}, f"after a frame of turn 1 the state is {m.read_state('vs-1')}"


def check_truncate(ctx):
    m = ctx.load("state")
    m.record_frame("vs-1", 0, 40)
    stop = m.barge_in("vs-1", 25)
    assert stop == 25, f"barge_in returned {stop}: the stream sent 40 tokens but the caller heard 25, and the answer stops at what was heard"
    state = m.read_state("vs-1")
    assert state == {"current_speaker": "user", "turn_index": 1, "tts_offset": 25}, f"after the barge-in the state is {state}, expected the caller on turn 1 at offset 25"
    m.record_frame("vs-2", 0, 12)
    stop = m.barge_in("vs-2", 30)
    assert stop == 12, f"barge_in claimed {stop} tokens heard when the stream had sent 12: the caller cannot have heard more than was sent"


def check_ttl_refresh(ctx):
    m = ctx.load("state")
    m.record_frame("vs-1", 0, 5)
    ttl = ctx.redis.ttl(KEY)
    assert 0 < ttl <= 30, f"after a frame {KEY} has TTL {ttl}: the state must expire 30 s after the last frame"
    ctx.clock.advance(20)
    m.record_frame("vs-1", 0, 10)
    assert ctx.redis.ttl(KEY) > 25, f"a frame 20 s later left TTL {ctx.redis.ttl(KEY)}: every frame must refresh the expiry"
    ctx.clock.advance(20)
    assert ctx.redis.exists(KEY), "the state expired 20 s after a frame: a long answer must keep its session alive"
    m.barge_in("vs-1", 10)
    assert ctx.redis.ttl(KEY) > 25, f"a barge-in left TTL {ctx.redis.ttl(KEY)}: it must refresh the expiry too"
    ctx.clock.advance(31)
    assert not ctx.redis.exists(KEY), "31 s after the last write the state is still there: a silent call must end"
    assert m.read_state("vs-1") is None, "an expired state must read as None"
`,
    typescript: `const KEY = 'voice:state:vs-1';
const BEFORE = {current_speaker: 'agent', turn_index: 0, tts_offset: 40};

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

const same = (a, b): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function check_atomic_barge_in(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.recordFrame('vs-1', 0, 40), true, 'the first frame of turn 0 must be recorded');
  // Another worker reads the state the instant the barge-in's first command has run.
  const seen = ctx.redisAfter(KEY, () => m.readState('vs-1'));
  await m.bargeIn('vs-1', 25);
  const after = await m.readState('vs-1');
  const during = await settled(seen, KEY);
  assert(after !== null && after.current_speaker === 'user' && after.turn_index === 1, \`after a barge-in the state is \${JSON.stringify(after)}, expected the caller on turn 1\`);
  assert(same(during, BEFORE) || same(during, after), \`a read that landed during the barge-in saw \${JSON.stringify(during)}: neither the state before (\${JSON.stringify(BEFORE)}) nor after (\${JSON.stringify(after)}). The speaker, the turn and the offset must change in one script\`);
}

export async function check_read_atomic(ctx) {
  const m = ctx.load('state');
  await m.recordFrame('vs-1', 0, 40);
  // A barge-in lands right after the read's first command.
  const rival = ctx.redisAfter(KEY, () => m.bargeIn('vs-1', 25));
  const seen = await m.readState('vs-1');
  await settled(rival, KEY);
  const after = await m.readState('vs-1');
  assert(same(seen, BEFORE) || same(seen, after), \`readState racing a barge-in returned \${JSON.stringify(seen)}: neither the state before (\${JSON.stringify(BEFORE)}) nor after (\${JSON.stringify(after)}). Read the three fields in one HMGET\`);
}

export async function check_stale_frame(ctx) {
  const m = ctx.load('state');
  await m.recordFrame('vs-1', 0, 40);
  await m.bargeIn('vs-1', 25);
  const late = await m.recordFrame('vs-1', 0, 41);
  const state = await m.readState('vs-1');
  assert.equal(late, false, 'a frame of the interrupted answer (turn 0) arrived after the barge-in and recordFrame reported it applied: it must return false');
  assert(state !== null && state.current_speaker === 'user' && state.turn_index === 1, \`a late frame of turn 0 changed the state to \${JSON.stringify(state)}: the agent took the floor back from the caller\`);
  assert.equal(await m.recordFrame('vs-1', 1, 3), true, 'a frame of the current turn (1) must be recorded');
  const now = await m.readState('vs-1');
  assert(same(now, {current_speaker: 'agent', turn_index: 1, tts_offset: 3}), \`after a frame of turn 1 the state is \${JSON.stringify(now)}\`);
}

export async function check_truncate(ctx) {
  const m = ctx.load('state');
  await m.recordFrame('vs-1', 0, 40);
  let stop = await m.bargeIn('vs-1', 25);
  assert.equal(stop, 25, \`bargeIn returned \${stop}: the stream sent 40 tokens but the caller heard 25, and the answer stops at what was heard\`);
  const state = await m.readState('vs-1');
  assert(same(state, {current_speaker: 'user', turn_index: 1, tts_offset: 25}), \`after the barge-in the state is \${JSON.stringify(state)}, expected the caller on turn 1 at offset 25\`);
  await m.recordFrame('vs-2', 0, 12);
  stop = await m.bargeIn('vs-2', 30);
  assert.equal(stop, 12, \`bargeIn claimed \${stop} tokens heard when the stream had sent 12: the caller cannot have heard more than was sent\`);
}

export async function check_ttl_refresh(ctx) {
  const m = ctx.load('state');
  await m.recordFrame('vs-1', 0, 5);
  const ttl = Number(ctx.redis.ttl(KEY));
  assert(0 < ttl && ttl <= 30, \`after a frame \${KEY} has TTL \${ttl}: the state must expire 30 s after the last frame\`);
  ctx.clock.advance(20);
  await m.recordFrame('vs-1', 0, 10);
  assert(Number(ctx.redis.ttl(KEY)) > 25, \`a frame 20 s later left TTL \${ctx.redis.ttl(KEY)}: every frame must refresh the expiry\`);
  ctx.clock.advance(20);
  assert.equal(ctx.redis.exists(KEY), 1, 'the state expired 20 s after a frame: a long answer must keep its session alive');
  await m.bargeIn('vs-1', 10);
  assert(Number(ctx.redis.ttl(KEY)) > 25, \`a barge-in left TTL \${ctx.redis.ttl(KEY)}: it must refresh the expiry too\`);
  ctx.clock.advance(31);
  assert.equal(ctx.redis.exists(KEY), 0, '31 s after the last write the state is still there: a silent call must end');
  assert.equal(await m.readState('vs-1'), null, 'an expired state must read as null');
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

const stateHashKey = "voice:state:vs-1"

var (
	stateBg     = context.Background()
	stateBefore = TurnState{CurrentSpeaker: "agent", TurnIndex: 0, TTSOffset: 40}
)

func mustFrame(ctx *harness.Ctx, sessionID string, turn, offset int) bool {
	applied, err := recordFrame(stateBg, sessionID, turn, offset)
	ctx.NoError(err, "recordFrame(%s, %d, %d) failed", sessionID, turn, offset)
	return applied
}

func mustBargeIn(ctx *harness.Ctx, sessionID string, heard int) int {
	stop, err := bargeIn(stateBg, sessionID, heard)
	ctx.NoError(err, "bargeIn(%s, %d) failed", sessionID, heard)
	return stop
}

func mustState(ctx *harness.Ctx, sessionID string) TurnState {
	s, err := readState(stateBg, sessionID)
	ctx.NoError(err, "readState(%s) failed", sessionID)
	ctx.Assert(s != nil, "readState(%s) found no state", sessionID)
	return *s
}

func CheckAtomicBargeIn(ctx *harness.Ctx) {
	ctx.Equal(mustFrame(ctx, "vs-1", 0, 40), true, "the first frame of turn 0 must be recorded; applied")
	// Another worker reads the state the instant the barge-in's first command has run.
	var during *TurnState
	probe := ctx.Redis.After(stateHashKey, func() any {
		during, _ = readState(stateBg, "vs-1")
		return nil
	})
	mustBargeIn(ctx, "vs-1", 25)
	after := mustState(ctx, "vs-1")
	ctx.Assert(probe.Fired, "nothing touched %s", stateHashKey)
	ctx.Assert(after.CurrentSpeaker == "user" && after.TurnIndex == 1, "after a barge-in the state is %+v, expected the caller on turn 1", after)
	ctx.Assert(during != nil && (*during == stateBefore || *during == after), "a read that landed during the barge-in saw %+v: neither the state before (%+v) nor after (%+v). The speaker, the turn and the offset must change in one script", during, stateBefore, after)
}

func CheckReadAtomic(ctx *harness.Ctx) {
	mustFrame(ctx, "vs-1", 0, 40)
	// A barge-in lands right after the read's first command.
	rival := ctx.Redis.After(stateHashKey, func() any {
		_, err := bargeIn(stateBg, "vs-1", 25)
		return err
	})
	seen := mustState(ctx, "vs-1")
	ctx.Assert(rival.Fired, "nothing touched %s", stateHashKey)
	after := mustState(ctx, "vs-1")
	ctx.Assert(seen == stateBefore || seen == after, "readState racing a barge-in returned %+v: neither the state before (%+v) nor after (%+v). Read the three fields in one HMGET", seen, stateBefore, after)
}

func CheckStaleFrame(ctx *harness.Ctx) {
	mustFrame(ctx, "vs-1", 0, 40)
	mustBargeIn(ctx, "vs-1", 25)
	late := mustFrame(ctx, "vs-1", 0, 41)
	state := mustState(ctx, "vs-1")
	ctx.Equal(late, false, "a frame of the interrupted answer (turn 0) arrived after the barge-in; recordFrame must report it dropped; applied")
	ctx.Assert(state.CurrentSpeaker == "user" && state.TurnIndex == 1, "a late frame of turn 0 changed the state to %+v: the agent took the floor back from the caller", state)
	ctx.Equal(mustFrame(ctx, "vs-1", 1, 3), true, "a frame of the current turn (1) must be recorded; applied")
	ctx.Equal(mustState(ctx, "vs-1"), TurnState{CurrentSpeaker: "agent", TurnIndex: 1, TTSOffset: 3}, "after a frame of turn 1, the state")
}

func CheckTruncate(ctx *harness.Ctx) {
	mustFrame(ctx, "vs-1", 0, 40)
	ctx.Equal(mustBargeIn(ctx, "vs-1", 25), 25, "the stream sent 40 tokens but the caller heard 25, and the answer stops at what was heard; bargeIn returned")
	ctx.Equal(mustState(ctx, "vs-1"), TurnState{CurrentSpeaker: "user", TurnIndex: 1, TTSOffset: 25}, "after the barge-in, the state")
	mustFrame(ctx, "vs-2", 0, 12)
	ctx.Equal(mustBargeIn(ctx, "vs-2", 30), 12, "the stream had sent 12 tokens and the caller cannot have heard more; bargeIn returned")
}

func CheckTtlRefresh(ctx *harness.Ctx) {
	mustFrame(ctx, "vs-1", 0, 5)
	ttl := ctx.Redis.TTL(stateHashKey)
	ctx.Assert(0 < ttl && ttl <= 30, "after a frame %s has TTL %d: the state must expire 30 s after the last frame", stateHashKey, ttl)
	ctx.Clock.Advance(20)
	mustFrame(ctx, "vs-1", 0, 10)
	ctx.Assert(ctx.Redis.TTL(stateHashKey) > 25, "a frame 20 s later left TTL %d: every frame must refresh the expiry", ctx.Redis.TTL(stateHashKey))
	ctx.Clock.Advance(20)
	ctx.Equal(ctx.Redis.Exists(stateHashKey), int64(1), "the state must survive 20 s after a frame (a long answer keeps its session alive); exists")
	mustBargeIn(ctx, "vs-1", 10)
	ctx.Assert(ctx.Redis.TTL(stateHashKey) > 25, "a barge-in left TTL %d: it must refresh the expiry too", ctx.Redis.TTL(stateHashKey))
	ctx.Clock.Advance(31)
	ctx.Equal(ctx.Redis.Exists(stateHashKey), int64(0), "31 s after the last write the state must be gone (a silent call ends); exists")
	s, err := readState(stateBg, "vs-1")
	ctx.NoError(err, "readState of an expired state failed")
	ctx.Assert(s == nil, "an expired state must read as nil, got %+v", s)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

namespace {

const std::string kKey = "voice:state:vs-1";

bool same(const TurnState& a, const TurnState& b) {
  return a.current_speaker == b.current_speaker && a.turn_index == b.turn_index && a.tts_offset == b.tts_offset;
}

std::string show(const std::optional<TurnState>& s) {
  if (!s) return "none";
  return "{" + s->current_speaker + ", turn " + std::to_string(s->turn_index) + ", offset " + std::to_string(s->tts_offset) + "}";
}

const TurnState kBefore{"agent", 0, 40};

TurnState mustState(harness::Ctx& ctx, const std::string& session_id) {
  const auto s = readState(session_id);
  ctx.Assert(s.has_value(), "readState(%s) found no state", session_id);
  return *s;
}

}  // namespace

void CheckAtomicBargeIn(harness::Ctx& ctx) {
  ctx.Equal(recordFrame("vs-1", 0, 40), true, "the first frame of turn 0 must be recorded; applied");
  // Another worker reads the state the instant the barge-in's first command has run.
  auto during = std::make_shared<std::optional<TurnState>>();
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After(kKey, [during, fired] {
    *fired = true;
    *during = readState("vs-1");
  });
  bargeIn("vs-1", 25);
  const TurnState after = mustState(ctx, "vs-1");
  ctx.Assert(*fired, "nothing touched %s", kKey);
  ctx.Assert(after.current_speaker == "user" && after.turn_index == 1, "after a barge-in the state is %s, expected the caller on turn 1", show(after));
  ctx.Assert(during->has_value() && (same(**during, kBefore) || same(**during, after)),
             "a read that landed during the barge-in saw %s: neither the state before (%s) nor after (%s). The speaker, the turn and the offset must change in one script",
             show(*during), show(kBefore), show(after));
}

void CheckReadAtomic(harness::Ctx& ctx) {
  recordFrame("vs-1", 0, 40);
  // A barge-in lands right after the read's first command.
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After(kKey, [fired] {
    *fired = true;
    bargeIn("vs-1", 25);
  });
  const TurnState seen = mustState(ctx, "vs-1");
  ctx.Assert(*fired, "nothing touched %s", kKey);
  const TurnState after = mustState(ctx, "vs-1");
  ctx.Assert(same(seen, kBefore) || same(seen, after),
             "readState racing a barge-in returned %s: neither the state before (%s) nor after (%s). Read the three fields in one HMGET",
             show(seen), show(kBefore), show(after));
}

void CheckStaleFrame(harness::Ctx& ctx) {
  recordFrame("vs-1", 0, 40);
  bargeIn("vs-1", 25);
  const bool late = recordFrame("vs-1", 0, 41);
  const TurnState state = mustState(ctx, "vs-1");
  ctx.Equal(late, false, "a frame of the interrupted answer (turn 0) arrived after the barge-in; recordFrame must report it dropped; applied");
  ctx.Assert(state.current_speaker == "user" && state.turn_index == 1, "a late frame of turn 0 changed the state to %s: the agent took the floor back from the caller", show(state));
  ctx.Equal(recordFrame("vs-1", 1, 3), true, "a frame of the current turn (1) must be recorded; applied");
  const TurnState now = mustState(ctx, "vs-1");
  ctx.Assert(same(now, TurnState{"agent", 1, 3}), "after a frame of turn 1 the state is %s", show(now));
}

void CheckTruncate(harness::Ctx& ctx) {
  recordFrame("vs-1", 0, 40);
  ctx.Equal(bargeIn("vs-1", 25), 25, "the stream sent 40 tokens but the caller heard 25, and the answer stops at what was heard; bargeIn returned");
  const TurnState state = mustState(ctx, "vs-1");
  ctx.Assert(same(state, TurnState{"user", 1, 25}), "after the barge-in the state is %s, expected the caller on turn 1 at offset 25", show(state));
  recordFrame("vs-2", 0, 12);
  ctx.Equal(bargeIn("vs-2", 30), 12, "the stream had sent 12 tokens and the caller cannot have heard more; bargeIn returned");
}

void CheckTtlRefresh(harness::Ctx& ctx) {
  recordFrame("vs-1", 0, 5);
  const long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(0 < ttl && ttl <= 30, "after a frame %s has TTL %d: the state must expire 30 s after the last frame", kKey, ttl);
  ctx.Clock.Advance(20);
  recordFrame("vs-1", 0, 10);
  ctx.Assert(ctx.Redis.TTL(kKey) > 25, "a frame 20 s later left TTL %d: every frame must refresh the expiry", ctx.Redis.TTL(kKey));
  ctx.Clock.Advance(20);
  ctx.Equal(ctx.Redis.Exists(kKey), 1, "the state must survive 20 s after a frame (a long answer keeps its session alive); exists");
  bargeIn("vs-1", 10);
  ctx.Assert(ctx.Redis.TTL(kKey) > 25, "a barge-in left TTL %d: it must refresh the expiry too", ctx.Redis.TTL(kKey));
  ctx.Clock.Advance(31);
  ctx.Equal(ctx.Redis.Exists(kKey), 0, "31 s after the last write the state must be gone (a silent call ends); exists");
  ctx.Assert(!readState("vs-1").has_value(), "an expired state must read as none");
}
`,
  },
  hints: [
    'The caller says "stop" and the agent finishes its sentence anyway; the transcript then claims the caller heard words they talked over, and Redis still holds turn state for calls that ended yesterday.',
    'Three commands make up the barge-in and three HGETs the read, so another client lands between them; the frame write never compares the turn it belongs to with the stored one; nothing sets an expiry.',
    'Write both in Lua: the frame script returns 0 unless `HGET turn_index` equals `ARGV[1]`; the barge-in script sets `user` and `math.min(sent, heard)` and HINCRBYs the turn; both EXPIRE `STATE_TTL_S`. Read with HMGET.',
  ],
  debrief: `The floor is one fact stored in three fields, so it changes in one script or a reader sees the caller speaking on the agent's turn. The turn index is what makes a late frame harmless: each frame carries the turn it was synthesised for, and the script drops it once barge-in moved the session on, which no lock around the old HSET would do. The offset is what the caller heard rather than what the stream sent because TTS runs ahead of playback; the gap is the words the transcript must not claim. The TTL rides in the same scripts, so the key never exists without one. Production systems also keep the interrupted text for the model's next prompt and publish the barge-in to the playback side as an event.`,
};
