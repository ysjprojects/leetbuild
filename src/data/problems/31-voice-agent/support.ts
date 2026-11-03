/**
 * Hand-written support modules the voice-agent steps import but no step builds: the `voice`
 * package. `voice.sessions` is the session store (step 1 writes it, step 5 scopes reads by it),
 * `voice.turnstate` is the turn state of step 2 as later steps use it (the same three functions,
 * with the same Lua scripts), and `voice.transcripts` is the transcript store: the redaction the
 * turn path runs before anything leaves the gateway (step 4), the consumer's write (step 4) and the
 * page read (step 5). The five languages keep the same keys, so a harness reads one layout whatever
 * the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'voice/__init__.py': '',
  'voice/sessions.py': `"""
The session store (provided): every voice session is a Redis hash voice:session:{id} with
session_id, tenant, codec, sample_rate, max_duration_s and turn_count; voice:idem:{tenant}:{key}
names the session a (tenant, Idempotency-Key) pair created, for a day. A session is returned as a
dict with its numbers as ints.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEMPOTENCY_TTL_S = 86400


def session_key(session_id: str) -> str:
    return f"voice:session:{session_id}"


def _session(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "session_id": raw["session_id"],
        "tenant": raw["tenant"],
        "codec": raw["codec"],
        "sample_rate": int(raw["sample_rate"]),
        "max_duration_s": int(raw["max_duration_s"]),
        "turn_count": int(raw.get("turn_count") or 0),
    }


def get(session_id: str) -> dict | None:
    """The session, or None."""
    return _session(r.hgetall(session_key(session_id)))


def create(tenant: str, codec: str, sample_rate: int, max_duration_s: int) -> dict:
    """A new session with no turns yet; returns it."""
    session_id = f"vs-{r.incr('voice:session:seq')}"
    r.hset(
        session_key(session_id),
        mapping={"session_id": session_id, "tenant": tenant, "codec": codec, "sample_rate": sample_rate, "max_duration_s": max_duration_s, "turn_count": 0},
    )
    return get(session_id)


def find(tenant: str, key: str) -> dict | None:
    """The session (tenant, key) created, or None."""
    session_id = r.get(f"voice:idem:{tenant}:{key}")
    return get(session_id) if session_id else None


def remember(tenant: str, key: str, session_id: str) -> None:
    """Record that (tenant, key) created session_id, so a retry finds it."""
    r.set(f"voice:idem:{tenant}:{key}", session_id, ex=IDEMPOTENCY_TTL_S)
`,
  'voice/turnstate.py': `"""
The turn state (provided; step 2 builds the same three functions): voice:state:{session_id} is a hash
with current_speaker (agent or user), turn_index and tts_offset, the tokens of the agent's answer
the caller has been played. record_frame records the agent's playback only while the session is
still on the turn it belongs to; barge_in hands the floor to the caller and truncates the answer at
what the caller heard; both refresh the 30 s TTL in the same script. read_state is one HMGET.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATE_TTL_S = 30

FRAME_LUA = """
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
"""

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
    """current_speaker, turn_index and tts_offset as one read, or None for a session with no state."""
    speaker, turn, offset = r.hmget(state_key(session_id), "current_speaker", "turn_index", "tts_offset")
    if speaker is None:
        return None
    return {"current_speaker": speaker, "turn_index": int(turn or 0), "tts_offset": int(offset or 0)}
`,
  'voice/transcripts.py': `"""
The transcript store (provided). redact(session_id, turn_index, text) masks every run of seven or more
characters of digits, spaces and dashes that starts and ends with a digit (phone and card numbers)
as [redacted], stores the result as the hash voice:redacted:{session_id}:{turn_index} (text, and
spans: the [start, end) of each mask in the redacted text, as JSON) and returns that key: the
transcript reference. insert_turn(event) is the transcript consumer's write: from a voice.turn event
and the redacted text its transcript_ref names, the hash voice:turn:{session_id}:{turn_index}
(turn_index, started_at, ended_at, text, redaction_spans, audio_path: where the media pipeline keeps
the turn's recording), indexed by turn_index in the sorted set voice:turns:{session_id}. It raises
KeyError when the reference names nothing. list_turns(session_id, after, limit) reads the turns
with turn_index > after, oldest first, at most limit, as dicts.
"""
import json
import re

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

NUMBER = re.compile(r"[0-9][0-9 -]{5,}[0-9]")
MASK = "[redacted]"


def turn_key(session_id: str, turn_index: int) -> str:
    return f"voice:turn:{session_id}:{turn_index}"


def redact(session_id: str, turn_index: int, text: str) -> str:
    """Store the redacted text of one turn; returns its reference."""
    out, spans, last = [], [], 0
    for match in NUMBER.finditer(text):
        out.append(text[last:match.start()])
        start = sum(len(part) for part in out)
        out.append(MASK)
        spans.append([start, start + len(MASK)])
        last = match.end()
    out.append(text[last:])
    ref = f"voice:redacted:{session_id}:{turn_index}"
    r.hset(ref, mapping={"text": "".join(out), "spans": json.dumps(spans)})
    return ref


def insert_turn(event: dict) -> None:
    """Write the turn row a voice.turn event describes."""
    redacted = r.hgetall(event["transcript_ref"])
    if not redacted:
        raise KeyError(f"no redacted transcript at {event['transcript_ref']}")
    session_id, turn_index = event["session_id"], int(event["turn_index"])
    r.hset(
        turn_key(session_id, turn_index),
        mapping={
            "turn_index": turn_index,
            "started_at": int(event["started_at"]),
            "ended_at": int(event["ended_at"]),
            "text": redacted["text"],
            "redaction_spans": redacted["spans"],
            "audio_path": f"s3://voice-recordings/{session_id}/{turn_index}.wav",
        },
    )
    r.zadd(f"voice:turns:{session_id}", {str(turn_index): turn_index})


def list_turns(session_id: str, after: int, limit: int) -> list[dict]:
    """The turns with turn_index > after, oldest first, at most limit."""
    indexes = r.zrangebyscore(f"voice:turns:{session_id}", f"({after}", "+inf", start=0, num=limit)
    turns = []
    for index in indexes:
        raw = r.hgetall(turn_key(session_id, int(index)))
        turns.append({
            "turn_index": int(raw["turn_index"]),
            "started_at": int(raw["started_at"]),
            "ended_at": int(raw["ended_at"]),
            "text": raw["text"],
            "redaction_spans": json.loads(raw["redaction_spans"]),
            "audio_path": raw["audio_path"],
        })
    return turns
`,
};

export const supportModulesTs: Record<string, string> = {
  'voice/sessions.ts': `/**
 * The session store (provided): every voice session is a Redis hash voice:session:{id} with
 * session_id, tenant, codec, sample_rate, max_duration_s and turn_count; voice:idem:{tenant}:{key}
 * names the session a (tenant, Idempotency-Key) pair created, for a day.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const IDEMPOTENCY_TTL_S = 86400;

export interface Session {
  session_id: string;
  tenant: string;
  codec: string;
  sample_rate: number;
  max_duration_s: number;
  turn_count: number;
}

export const sessionKey = (sessionId: string): string => \`voice:session:\${sessionId}\`;

/** The session, or null. */
export async function get(sessionId: string): Promise<Session | null> {
  const raw = await redis.hgetall(sessionKey(sessionId));
  if (Object.keys(raw).length === 0) return null;
  return {
    session_id: raw.session_id,
    tenant: raw.tenant,
    codec: raw.codec,
    sample_rate: Number(raw.sample_rate),
    max_duration_s: Number(raw.max_duration_s),
    turn_count: Number(raw.turn_count ?? 0),
  };
}

/** A new session with no turns yet; returns it. */
export async function create(tenant: string, codec: string, sampleRate: number, maxDurationS: number): Promise<Session> {
  const sessionId = \`vs-\${await redis.incr('voice:session:seq')}\`;
  await redis.hset(sessionKey(sessionId), {
    session_id: sessionId,
    tenant,
    codec,
    sample_rate: String(sampleRate),
    max_duration_s: String(maxDurationS),
    turn_count: '0',
  });
  return (await get(sessionId)) as Session;
}

/** The session (tenant, key) created, or null. */
export async function find(tenant: string, key: string): Promise<Session | null> {
  const sessionId = await redis.get(\`voice:idem:\${tenant}:\${key}\`);
  return sessionId === null ? null : get(sessionId);
}

/** Record that (tenant, key) created sessionId, so a retry finds it. */
export async function remember(tenant: string, key: string, sessionId: string): Promise<void> {
  await redis.set(\`voice:idem:\${tenant}:\${key}\`, sessionId, 'EX', IDEMPOTENCY_TTL_S);
}
`,
  'voice/turnstate.ts': `/**
 * The turn state (provided; step 2 builds the same three functions): voice:state:{sessionId} is a
 * hash with current_speaker (agent or user), turn_index and tts_offset, the tokens of the agent's
 * answer the caller has been played. recordFrame records the agent's playback only while the
 * session is still on the turn it belongs to; bargeIn hands the floor to the caller and truncates
 * the answer at what the caller heard; both refresh the 30 s TTL in the same script. readState is
 * one HMGET.
 */
import Redis from 'ioredis';

export const STATE_TTL_S = 30;

export const FRAME_LUA = \`
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
\`;

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

/** current_speaker, turn_index and tts_offset as one read, or null for a session with no state. */
export async function readState(sessionId: string): Promise<TurnState | null> {
  const [speaker, turn, offset] = await redis.hmget(stateKey(sessionId), 'current_speaker', 'turn_index', 'tts_offset');
  if (speaker === null) return null;
  return {current_speaker: speaker, turn_index: Number(turn ?? 0), tts_offset: Number(offset ?? 0)};
}
`,
  'voice/transcripts.ts': `/**
 * The transcript store (provided). redact(sessionId, turnIndex, text) masks every run of seven or
 * more characters of digits, spaces and dashes that starts and ends with a digit (phone and card
 * numbers) as [redacted], stores the result as the hash voice:redacted:{sessionId}:{turnIndex}
 * (text, and spans: the [start, end) of each mask in the redacted text, as JSON) and returns that
 * key: the transcript reference. insertTurn(event) is the transcript consumer's write: from a
 * voice.turn event and the redacted text its transcript_ref names, the hash
 * voice:turn:{sessionId}:{turnIndex} (turn_index, started_at, ended_at, text, redaction_spans,
 * audio_path: where the media pipeline keeps the turn's recording), indexed by turn_index in the
 * sorted set voice:turns:{sessionId}. It throws when the reference names nothing. listTurns(sessionId,
 * after, limit) reads the turns with turn_index > after, oldest first, at most limit.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const NUMBER = /[0-9][0-9 -]{5,}[0-9]/g;
const MASK = '[redacted]';

export interface TurnEvent {
  session_id: string;
  tenant: string;
  turn_index: number;
  started_at: number;
  ended_at: number;
  transcript_ref: string;
}

export interface Turn {
  turn_index: number;
  started_at: number;
  ended_at: number;
  text: string;
  redaction_spans: [number, number][];
  audio_path: string;
}

export const turnKey = (sessionId: string, turnIndex: number): string => \`voice:turn:\${sessionId}:\${turnIndex}\`;

/** Store the redacted text of one turn; returns its reference. */
export async function redact(sessionId: string, turnIndex: number, text: string): Promise<string> {
  let out = '';
  let last = 0;
  const spans: [number, number][] = [];
  for (const match of text.matchAll(NUMBER)) {
    out += text.slice(last, match.index);
    spans.push([out.length, out.length + MASK.length]);
    out += MASK;
    last = (match.index ?? 0) + match[0].length;
  }
  out += text.slice(last);
  const ref = \`voice:redacted:\${sessionId}:\${turnIndex}\`;
  await redis.hset(ref, {text: out, spans: JSON.stringify(spans)});
  return ref;
}

/** Write the turn row a voice.turn event describes. */
export async function insertTurn(event: TurnEvent): Promise<void> {
  const redacted = await redis.hgetall(event.transcript_ref);
  if (Object.keys(redacted).length === 0) throw new Error(\`no redacted transcript at \${event.transcript_ref}\`);
  const turnIndex = Number(event.turn_index);
  await redis.hset(turnKey(event.session_id, turnIndex), {
    turn_index: String(turnIndex),
    started_at: String(event.started_at),
    ended_at: String(event.ended_at),
    text: redacted.text,
    redaction_spans: redacted.spans,
    audio_path: \`s3://voice-recordings/\${event.session_id}/\${turnIndex}.wav\`,
  });
  await redis.zadd(\`voice:turns:\${event.session_id}\`, turnIndex, String(turnIndex));
}

/** The turns with turn_index > after, oldest first, at most limit. */
export async function listTurns(sessionId: string, after: number, limit: number): Promise<Turn[]> {
  const indexes = await redis.zrangebyscore(\`voice:turns:\${sessionId}\`, \`(\${after}\`, '+inf', 'LIMIT', 0, limit);
  const turns: Turn[] = [];
  for (const index of indexes) {
    const raw = await redis.hgetall(turnKey(sessionId, Number(index)));
    turns.push({
      turn_index: Number(raw.turn_index),
      started_at: Number(raw.started_at),
      ended_at: Number(raw.ended_at),
      text: raw.text,
      redaction_spans: JSON.parse(raw.redaction_spans) as [number, number][],
      audio_path: raw.audio_path,
    });
  }
  return turns;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'voice/sessions/sessions.go': `// Package sessions is the session store (provided): every voice session is a Redis hash
// voice:session:{id} with session_id, tenant, codec, sample_rate, max_duration_s and turn_count;
// voice:idem:{tenant}:{key} names the session a (tenant, Idempotency-Key) pair created, for a day.
package sessions

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idempotencyTTL = 24 * time.Hour

// Session is one voice session, as the API answers it.
type Session struct {
	SessionID    string \`json:"session_id"\`
	Tenant       string \`json:"tenant"\`
	Codec        string \`json:"codec"\`
	SampleRate   int    \`json:"sample_rate"\`
	MaxDurationS int    \`json:"max_duration_s"\`
	TurnCount    int    \`json:"turn_count"\`
}

// Key is the session's hash.
func Key(sessionID string) string { return "voice:session:" + sessionID }

// Get is the session, or nil.
func Get(ctx context.Context, sessionID string) *Session {
	raw, _ := rdb.HGetAll(ctx, Key(sessionID)).Result()
	if len(raw) == 0 {
		return nil
	}
	number := func(name string) int {
		n, _ := strconv.Atoi(raw[name])
		return n
	}
	return &Session{SessionID: raw["session_id"], Tenant: raw["tenant"], Codec: raw["codec"], SampleRate: number("sample_rate"), MaxDurationS: number("max_duration_s"), TurnCount: number("turn_count")}
}

// Create is a new session with no turns yet.
func Create(ctx context.Context, tenant, codec string, sampleRate, maxDurationS int) *Session {
	seq, _ := rdb.Incr(ctx, "voice:session:seq").Result()
	sessionID := fmt.Sprintf("vs-%d", seq)
	rdb.HSet(ctx, Key(sessionID), "session_id", sessionID, "tenant", tenant, "codec", codec, "sample_rate", sampleRate, "max_duration_s", maxDurationS, "turn_count", 0)
	return Get(ctx, sessionID)
}

// Find is the session (tenant, key) created, or nil.
func Find(ctx context.Context, tenant, key string) *Session {
	sessionID, err := rdb.Get(ctx, "voice:idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, sessionID)
}

// Remember records that (tenant, key) created sessionID, so a retry finds it.
func Remember(ctx context.Context, tenant, key, sessionID string) {
	rdb.Set(ctx, "voice:idem:"+tenant+":"+key, sessionID, idempotencyTTL)
}
`,
  'voice/turnstate/turnstate.go': `// Package turnstate is the turn state (provided; step 2 builds the same three functions):
// voice:state:{sessionID} is a hash with current_speaker (agent or user), turn_index and
// tts_offset, the tokens of the agent's answer the caller has been played. RecordFrame records the
// agent's playback only while the session is still on the turn it belongs to; BargeIn hands the
// floor to the caller and truncates the answer at what the caller heard; both refresh the 30 s TTL
// in the same script. ReadState is one HMGET.
package turnstate

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const StateTTLS = 30

var frame = redis.NewScript(\`
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
\`)

var interrupt = redis.NewScript(\`
local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
local heard = math.min(sent, tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return heard
\`)

// State is who holds the floor, which turn the session is on and how much of the answer was played.
type State struct {
	CurrentSpeaker string
	TurnIndex      int
	TTSOffset      int
}

// Key is the session's turn state hash.
func Key(sessionID string) string { return "voice:state:" + sessionID }

// RecordFrame: the agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on.
func RecordFrame(ctx context.Context, sessionID string, turnIndex, ttsOffset int) (bool, error) {
	applied, err := frame.Run(ctx, rdb, []string{Key(sessionID)}, turnIndex, ttsOffset, StateTTLS).Int()
	return applied == 1, err
}

// BargeIn: the caller took the floor after hearing heardTokens; returns the offset the answer stops at.
func BargeIn(ctx context.Context, sessionID string, heardTokens int) (int, error) {
	return interrupt.Run(ctx, rdb, []string{Key(sessionID)}, heardTokens, StateTTLS).Int()
}

// ReadState is current_speaker, turn_index and tts_offset as one read, or nil for a session with no state.
func ReadState(ctx context.Context, sessionID string) (*State, error) {
	values, err := rdb.HMGet(ctx, Key(sessionID), "current_speaker", "turn_index", "tts_offset").Result()
	if err != nil || values[0] == nil {
		return nil, err
	}
	number := func(v any) int {
		s, _ := v.(string)
		n, _ := strconv.Atoi(s)
		return n
	}
	return &State{CurrentSpeaker: values[0].(string), TurnIndex: number(values[1]), TTSOffset: number(values[2])}, nil
}
`,
  'voice/transcripts/transcripts.go': `// Package transcripts is the transcript store (provided). Redact masks every run of seven or more
// characters of digits, spaces and dashes that starts and ends with a digit (phone and card
// numbers) as [redacted], stores the result as the hash voice:redacted:{sessionID}:{turnIndex}
// (text, and spans: the [start, end) of each mask in the redacted text, as JSON) and returns that
// key: the transcript reference. InsertTurn is the transcript consumer's write: from a voice.turn
// event and the redacted text its transcript_ref names, the hash voice:turn:{sessionID}:{turnIndex}
// (turn_index, started_at, ended_at, text, redaction_spans, audio_path: where the media pipeline
// keeps the turn's recording), indexed by turn_index in the sorted set voice:turns:{sessionID}; an
// error when the reference names nothing. ListTurns reads the turns with turn_index > after, oldest
// first, at most limit.
package transcripts

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var number = regexp.MustCompile(\`[0-9][0-9 -]{5,}[0-9]\`)

const mask = "[redacted]"

// Event is the payload of one voice.turn record.
type Event struct {
	SessionID     string \`json:"session_id"\`
	Tenant        string \`json:"tenant"\`
	TurnIndex     int    \`json:"turn_index"\`
	StartedAt     int64  \`json:"started_at"\`
	EndedAt       int64  \`json:"ended_at"\`
	TranscriptRef string \`json:"transcript_ref"\`
}

// Turn is one stored turn.
type Turn struct {
	TurnIndex      int     \`json:"turn_index"\`
	StartedAt      int64   \`json:"started_at"\`
	EndedAt        int64   \`json:"ended_at"\`
	Text           string  \`json:"text"\`
	RedactionSpans [][]int \`json:"redaction_spans"\`
	AudioPath      string  \`json:"audio_path"\`
}

// TurnKey is the hash of one turn.
func TurnKey(sessionID string, turnIndex int) string {
	return fmt.Sprintf("voice:turn:%s:%d", sessionID, turnIndex)
}

// Redact stores the redacted text of one turn and returns its reference.
func Redact(ctx context.Context, sessionID string, turnIndex int, text string) string {
	out := ""
	last := 0
	spans := [][]int{}
	for _, m := range number.FindAllStringIndex(text, -1) {
		out += text[last:m[0]]
		spans = append(spans, []int{len(out), len(out) + len(mask)})
		out += mask
		last = m[1]
	}
	out += text[last:]
	raw, _ := json.Marshal(spans)
	ref := fmt.Sprintf("voice:redacted:%s:%d", sessionID, turnIndex)
	rdb.HSet(ctx, ref, "text", out, "spans", string(raw))
	return ref
}

// InsertTurn writes the turn row a voice.turn event describes.
func InsertTurn(ctx context.Context, ev Event) error {
	redacted, err := rdb.HGetAll(ctx, ev.TranscriptRef).Result()
	if err != nil {
		return err
	}
	if len(redacted) == 0 {
		return fmt.Errorf("no redacted transcript at %s", ev.TranscriptRef)
	}
	rdb.HSet(ctx, TurnKey(ev.SessionID, ev.TurnIndex),
		"turn_index", ev.TurnIndex, "started_at", ev.StartedAt, "ended_at", ev.EndedAt, "text", redacted["text"],
		"redaction_spans", redacted["spans"], "audio_path", fmt.Sprintf("s3://voice-recordings/%s/%d.wav", ev.SessionID, ev.TurnIndex))
	return rdb.ZAdd(ctx, "voice:turns:"+ev.SessionID, redis.Z{Score: float64(ev.TurnIndex), Member: strconv.Itoa(ev.TurnIndex)}).Err()
}

// ListTurns is the turns with turn_index > after, oldest first, at most limit.
func ListTurns(ctx context.Context, sessionID string, after, limit int) []Turn {
	indexes, _ := rdb.ZRangeByScore(ctx, "voice:turns:"+sessionID, &redis.ZRangeBy{Min: "(" + strconv.Itoa(after), Max: "+inf", Offset: 0, Count: int64(limit)}).Result()
	turns := []Turn{}
	for _, index := range indexes {
		n, _ := strconv.Atoi(index)
		raw, _ := rdb.HGetAll(ctx, TurnKey(sessionID, n)).Result()
		turnIndex, _ := strconv.Atoi(raw["turn_index"])
		startedAt, _ := strconv.ParseInt(raw["started_at"], 10, 64)
		endedAt, _ := strconv.ParseInt(raw["ended_at"], 10, 64)
		spans := [][]int{}
		json.Unmarshal([]byte(raw["redaction_spans"]), &spans)
		turns = append(turns, Turn{TurnIndex: turnIndex, StartedAt: startedAt, EndedAt: endedAt, Text: raw["text"], RedactionSpans: spans, AudioPath: raw["audio_path"]})
	}
	return turns
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'voice/sessions.h': `// The session store (provided): every voice session is a Redis hash voice:session:{id} with
// session_id, tenant, codec, sample_rate, max_duration_s and turn_count; voice:idem:{tenant}:{key}
// names the session a (tenant, Idempotency-Key) pair created, for a day.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

namespace sessions {

struct Session {
  std::string session_id;
  std::string tenant;
  std::string codec;
  long sample_rate = 0;
  long max_duration_s = 0;
  long turn_count = 0;
};

// The session as the API answers it.
inline nlohmann::json toJson(const Session& s) {
  return {{"session_id", s.session_id}, {"tenant", s.tenant}, {"codec", s.codec},
          {"sample_rate", s.sample_rate}, {"max_duration_s", s.max_duration_s}, {"turn_count", s.turn_count}};
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string key(const std::string& session_id) { return "voice:session:" + session_id; }

// The session, or none.
inline std::optional<Session> get(const std::string& session_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(key(session_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  return Session{text("session_id"), text("tenant"), text("codec"), number("sample_rate"), number("max_duration_s"), number("turn_count")};
}

// A new session with no turns yet.
inline Session create(const std::string& tenant, const std::string& codec, long sample_rate, long max_duration_s) {
  const std::string session_id = "vs-" + std::to_string(redis().incr("voice:session:seq"));
  redis().hset(key(session_id), {{"session_id", session_id}, {"tenant", tenant}, {"codec", codec},
                                 {"sample_rate", std::to_string(sample_rate)}, {"max_duration_s", std::to_string(max_duration_s)}, {"turn_count", "0"}});
  return *get(session_id);
}

// The session (tenant, key) created, or none.
inline std::optional<Session> find(const std::string& tenant, const std::string& idem_key) {
  const auto session_id = redis().get("voice:idem:" + tenant + ":" + idem_key);
  if (!session_id) return std::nullopt;
  return get(*session_id);
}

// Record that (tenant, key) created session_id, so a retry finds it.
inline void remember(const std::string& tenant, const std::string& idem_key, const std::string& session_id) {
  redis().set("voice:idem:" + tenant + ":" + idem_key, session_id, std::chrono::seconds(86400));
}

}  // namespace sessions
`,
  'voice/turnstate.h': `// The turn state (provided; step 2 builds the same three functions): voice:state:{session_id} is a
// hash with current_speaker (agent or user), turn_index and tts_offset, the tokens of the agent's
// answer the caller has been played. recordFrame records the agent's playback only while the
// session is still on the turn it belongs to; bargeIn hands the floor to the caller and truncates
// the answer at what the caller heard; both refresh the 30 s TTL in the same script. readState is
// one HMGET.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

namespace turnstate {

constexpr long kStateTtlS = 30;

inline const std::string kFrameLua = R"lua(
local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
if turn ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
)lua";

inline const std::string kBargeInLua = R"lua(
local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
local heard = math.min(sent, tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return heard
)lua";

struct State {
  std::string current_speaker;
  long turn_index = 0;
  long tts_offset = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string key(const std::string& session_id) { return "voice:state:" + session_id; }

// The agent's answer for turn_index has been played up to tts_offset; false when the turn moved on.
inline bool recordFrame(const std::string& session_id, long turn_index, long tts_offset) {
  return redis().eval<long long>(kFrameLua, {key(session_id)}, {std::to_string(turn_index), std::to_string(tts_offset), std::to_string(kStateTtlS)}) == 1;
}

// The caller took the floor after hearing heard_tokens; returns the offset the answer stops at.
inline long bargeIn(const std::string& session_id, long heard_tokens) {
  return static_cast<long>(redis().eval<long long>(kBargeInLua, {key(session_id)}, {std::to_string(heard_tokens), std::to_string(kStateTtlS)}));
}

// current_speaker, turn_index and tts_offset as one read, or none for a session with no state.
inline std::optional<State> readState(const std::string& session_id) {
  const std::vector<sw::redis::OptionalString> values = redis().hmget(key(session_id), {"current_speaker", "turn_index", "tts_offset"});
  if (!values[0]) return std::nullopt;
  const auto number = [](const sw::redis::OptionalString& v) { return v && !v->empty() ? std::stol(*v) : 0L; };
  return State{*values[0], number(values[1]), number(values[2])};
}

}  // namespace turnstate
`,
  'voice/transcripts.h': `// The transcript store (provided). redact masks every run of seven or more characters of digits,
// spaces and dashes that starts and ends with a digit (phone and card numbers) as [redacted],
// stores the result as the hash voice:redacted:{session_id}:{turn_index} (text, and spans: the
// [start, end) of each mask in the redacted text, as JSON) and returns that key: the transcript
// reference. insertTurn is the transcript consumer's write: from a voice.turn event (JSON) and the
// redacted text its transcript_ref names, the hash voice:turn:{session_id}:{turn_index}
// (turn_index, started_at, ended_at, text, redaction_spans, audio_path: where the media pipeline
// keeps the turn's recording), indexed by turn_index in the sorted set voice:turns:{session_id};
// it throws std::out_of_range when the reference names nothing. listTurns reads the turns with
// turn_index > after, oldest first, at most limit.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <regex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace transcripts {

struct Turn {
  long turn_index = 0;
  long long started_at = 0;
  long long ended_at = 0;
  std::string text;
  nlohmann::json redaction_spans = nlohmann::json::array();
  std::string audio_path;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string turnKey(const std::string& session_id, long turn_index) {
  return "voice:turn:" + session_id + ":" + std::to_string(turn_index);
}

// Store the redacted text of one turn; returns its reference.
inline std::string redact(const std::string& session_id, long turn_index, const std::string& text) {
  static const std::regex number("[0-9][0-9 -]{5,}[0-9]");
  const std::string mask = "[redacted]";
  std::string out;
  nlohmann::json spans = nlohmann::json::array();
  size_t last = 0;
  for (auto it = std::sregex_iterator(text.begin(), text.end(), number); it != std::sregex_iterator(); ++it) {
    out += text.substr(last, it->position() - last);
    spans.push_back({out.size(), out.size() + mask.size()});
    out += mask;
    last = it->position() + it->length();
  }
  out += text.substr(last);
  const std::string ref = "voice:redacted:" + session_id + ":" + std::to_string(turn_index);
  redis().hset(ref, {{"text", out}, {"spans", spans.dump()}});
  return ref;
}

// Write the turn row a voice.turn event describes.
inline void insertTurn(const nlohmann::json& event) {
  const std::string ref = event.value("transcript_ref", "");
  const std::unordered_map<std::string, std::string> redacted = redis().hgetall(ref);
  if (redacted.empty()) throw std::out_of_range("no redacted transcript at " + ref);
  const std::string session_id = event.value("session_id", "");
  const long turn_index = event.value("turn_index", 0L);
  redis().hset(turnKey(session_id, turn_index),
               {{"turn_index", std::to_string(turn_index)},
                {"started_at", std::to_string(event.value("started_at", 0LL))},
                {"ended_at", std::to_string(event.value("ended_at", 0LL))},
                {"text", redacted.at("text")},
                {"redaction_spans", redacted.at("spans")},
                {"audio_path", "s3://voice-recordings/" + session_id + "/" + std::to_string(turn_index) + ".wav"}});
  redis().zadd("voice:turns:" + session_id, std::to_string(turn_index), static_cast<double>(turn_index));
}

// The turns with turn_index > after, oldest first, at most limit.
inline std::vector<Turn> listTurns(const std::string& session_id, long after, long limit) {
  std::vector<std::string> indexes;
  redis().zrangebyscore("voice:turns:" + session_id,
                        sw::redis::LeftBoundedInterval<double>(static_cast<double>(after), sw::redis::BoundType::LEFT_OPEN),
                        sw::redis::LimitOptions{0, limit}, std::back_inserter(indexes));
  std::vector<Turn> turns;
  for (const std::string& index : indexes) {
    const std::unordered_map<std::string, std::string> raw = redis().hgetall(turnKey(session_id, std::stol(index)));
    turns.push_back(Turn{std::stol(raw.at("turn_index")), std::stoll(raw.at("started_at")), std::stoll(raw.at("ended_at")),
                         raw.at("text"), nlohmann::json::parse(raw.at("redaction_spans")), raw.at("audio_path")});
  }
  return turns;
}

}  // namespace transcripts
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('voice', 'Sessions')]: `package voice

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The session store (provided): every voice session is a Redis hash voice:session:{id} with
 * session_id, tenant, codec, sample_rate, max_duration_s and turn_count; voice:idem:{tenant}:{key}
 * names the session a (tenant, Idempotency-Key) pair created, for a day.
 */
object Sessions {
  final case class Session(sessionId: String, tenant: String, codec: String, sampleRate: Int, maxDurationS: Int, turnCount: Int) {
    /** The session as the API answers it. */
    def toJson: JsObject = JsObject(
      "session_id" -> JsString(sessionId), "tenant" -> JsString(tenant), "codec" -> JsString(codec),
      "sample_rate" -> JsNumber(sampleRate), "max_duration_s" -> JsNumber(maxDurationS), "turn_count" -> JsNumber(turnCount))
  }

  val IdempotencyTtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)

  def key(sessionId: String): String = s"voice:session:$sessionId"

  /** The session, if it exists. */
  def get(sessionId: String): Option[Session] = {
    val raw = jedis.hgetAll(key(sessionId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Session(raw("session_id"), raw("tenant"), raw("codec"), raw("sample_rate").toInt, raw("max_duration_s").toInt, raw.getOrElse("turn_count", "0").toInt))
  }

  /** A new session with no turns yet. */
  def create(tenant: String, codec: String, sampleRate: Int, maxDurationS: Int): Session = {
    val sessionId = s"vs-\${jedis.incr("voice:session:seq")}"
    jedis.hset(key(sessionId), Map("session_id" -> sessionId, "tenant" -> tenant, "codec" -> codec, "sample_rate" -> sampleRate.toString, "max_duration_s" -> maxDurationS.toString, "turn_count" -> "0").asJava)
    get(sessionId).get
  }

  /** The session (tenant, key) created, if any. */
  def find(tenant: String, idemKey: String): Option[Session] = Option(jedis.get(s"voice:idem:$tenant:$idemKey")).flatMap(get)

  /** Record that (tenant, key) created sessionId, so a retry finds it. */
  def remember(tenant: String, idemKey: String, sessionId: String): Unit =
    jedis.set(s"voice:idem:$tenant:$idemKey", sessionId, SetParams.setParams().ex(IdempotencyTtlSeconds))
}
`,
  [scalaPath('voice', 'TurnState')]: `package voice

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The turn state (provided; step 2 builds the same three functions): voice:state:{sessionId} is a
 * hash with current_speaker (agent or user), turn_index and tts_offset, the tokens of the agent's
 * answer the caller has been played. recordFrame records the agent's playback only while the
 * session is still on the turn it belongs to; bargeIn hands the floor to the caller and truncates
 * the answer at what the caller heard; both refresh the 30 s TTL in the same script. readState is
 * one HMGET.
 */
object TurnState {
  final case class State(currentSpeaker: String, turnIndex: Int, ttsOffset: Int)

  val StateTtlSeconds = 30

  val FrameLua: String =
    """local turn = tonumber(redis.call('HGET', KEYS[1], 'turn_index') or '0')
      |if turn ~= tonumber(ARGV[1]) then return 0 end
      |redis.call('HSET', KEYS[1], 'current_speaker', 'agent', 'turn_index', turn, 'tts_offset', ARGV[2])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |return 1
      |""".stripMargin

  val BargeInLua: String =
    """local sent = tonumber(redis.call('HGET', KEYS[1], 'tts_offset') or '0')
      |local heard = math.min(sent, tonumber(ARGV[1]))
      |redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', heard)
      |redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |return heard
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def key(sessionId: String): String = s"voice:state:$sessionId"

  /** The agent's answer for turnIndex has been played up to ttsOffset; false when the turn moved on. */
  def recordFrame(sessionId: String, turnIndex: Int, ttsOffset: Int): Boolean = {
    val args = List(turnIndex.toString, ttsOffset.toString, StateTtlSeconds.toString).asJava
    jedis.eval(FrameLua, List(key(sessionId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The caller took the floor after hearing heardTokens; returns the offset the answer stops at. */
  def bargeIn(sessionId: String, heardTokens: Int): Int = {
    val args = List(heardTokens.toString, StateTtlSeconds.toString).asJava
    jedis.eval(BargeInLua, List(key(sessionId)).asJava, args).asInstanceOf[java.lang.Long].toInt
  }

  /** current_speaker, turn_index and tts_offset as one read, or None for a session with no state. */
  def readState(sessionId: String): Option[State] = {
    val values = jedis.hmget(key(sessionId), "current_speaker", "turn_index", "tts_offset").asScala.toList
    Option(values.head).map(speaker => State(speaker, Option(values(1)).getOrElse("0").toInt, Option(values(2)).getOrElse("0").toInt))
  }
}
`,
  [scalaPath('voice', 'Transcripts')]: `package voice

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The transcript store (provided). redact masks every run of seven or more characters of digits,
 * spaces and dashes that starts and ends with a digit (phone and card numbers) as [redacted],
 * stores the result as the hash voice:redacted:{sessionId}:{turnIndex} (text, and spans: the
 * [start, end) of each mask in the redacted text, as JSON) and returns that key: the transcript
 * reference. insertTurn is the transcript consumer's write: from a voice.turn event and the
 * redacted text its transcript_ref names, the hash voice:turn:{sessionId}:{turnIndex} (turn_index,
 * started_at, ended_at, text, redaction_spans, audio_path: where the media pipeline keeps the
 * turn's recording), indexed by turn_index in the sorted set voice:turns:{sessionId}; it throws
 * NoSuchElementException when the reference names nothing. listTurns reads the turns with
 * turn_index > after, oldest first, at most limit.
 */
object Transcripts {
  final case class Turn(turnIndex: Int, startedAt: Long, endedAt: Long, text: String, redactionSpans: Seq[Seq[Int]], audioPath: String)

  private val Number = "[0-9][0-9 -]{5,}[0-9]".r
  private val Mask = "[redacted]"

  val jedis = new JedisPooled("redis", 6379)

  def turnKey(sessionId: String, turnIndex: Int): String = s"voice:turn:$sessionId:$turnIndex"

  /** Store the redacted text of one turn; returns its reference. */
  def redact(sessionId: String, turnIndex: Int, text: String): String = {
    val out = new StringBuilder
    val spans = Seq.newBuilder[Seq[Int]]
    var last = 0
    Number.findAllMatchIn(text).foreach { m =>
      out ++= text.substring(last, m.start)
      spans += Seq(out.length, out.length + Mask.length)
      out ++= Mask
      last = m.end
    }
    out ++= text.substring(last)
    val ref = s"voice:redacted:$sessionId:$turnIndex"
    jedis.hset(ref, Map("text" -> out.toString, "spans" -> spans.result().toJson.compactPrint).asJava)
    ref
  }

  /** Write the turn row a voice.turn event describes. */
  def insertTurn(event: JsObject): Unit = {
    val fields = event.fields
    val ref = fields("transcript_ref").convertTo[String]
    val redacted = jedis.hgetAll(ref).asScala.toMap
    if (redacted.isEmpty) throw new NoSuchElementException(s"no redacted transcript at $ref")
    val sessionId = fields("session_id").convertTo[String]
    val turnIndex = fields("turn_index").convertTo[Int]
    jedis.hset(turnKey(sessionId, turnIndex), Map(
      "turn_index" -> turnIndex.toString,
      "started_at" -> fields("started_at").convertTo[Long].toString,
      "ended_at" -> fields("ended_at").convertTo[Long].toString,
      "text" -> redacted("text"),
      "redaction_spans" -> redacted("spans"),
      "audio_path" -> s"s3://voice-recordings/$sessionId/$turnIndex.wav").asJava)
    jedis.zadd(s"voice:turns:$sessionId", turnIndex.toDouble, turnIndex.toString)
  }

  /** The turns with turn_index > after, oldest first, at most limit. */
  def listTurns(sessionId: String, after: Int, limit: Int): Seq[Turn] =
    jedis.zrangeByScore(s"voice:turns:$sessionId", s"($after", "+inf", 0, limit).asScala.toSeq.map { index =>
      val raw = jedis.hgetAll(turnKey(sessionId, index.toInt)).asScala.toMap
      Turn(raw("turn_index").toInt, raw("started_at").toLong, raw("ended_at").toLong, raw("text"), raw("redaction_spans").parseJson.convertTo[Seq[Seq[Int]]], raw("audio_path"))
    }
}
`,
};
