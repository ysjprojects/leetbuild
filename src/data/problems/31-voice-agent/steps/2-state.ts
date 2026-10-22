import type {Step} from '@/lib/types';

export const sessionStateStep: Step = {
  id: 'state',
  title: 'Redis session state that survives barge-in races',
  concept: 'redis',
  file: 'state',
  focus: ['gateway', 'redis', 'tts'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: on the happy path it records
the speaker and the playback offset and the call sounds right. It hides a race and a TTL bug. Find
them, fix them, and prove the fix.

Implement the Redis turn state for one session, key \`voice:state:{session_id}\`.

- The hash holds \`current_speaker\` (\`agent\` or \`user\`), \`turn_index\`, and \`tts_offset\` — the token
  the speech stream has already delivered.
- The key expires **30 seconds** after the last audio frame and **every audio frame refreshes it**
  (the \`EXPIRE\` happens in the same write that updates the state). A pause longer than the TTL must
  end a dead session, but a long answer must never expire mid-playback.
- **Barge-in is one atomic transition**: a single Lua script run with \`EVAL\` that flips
  \`current_speaker\` to \`user\`, advances \`turn_index\`, and leaves \`tts_offset\` at the token already
  delivered, so the agent's stream is truncated exactly there. Two separate commands leave a window
  where the barge-in lands between them and the agent keeps talking over the user.
- \`barge_in(session_id, delivered_tokens)\` returns the \`truncated_offset\` the gateway must stop the
  stream at.
- Read the whole state in one round trip (\`HMGET\`): never act on a half-updated view.

**Failure mode the checks target.** Writing the speaker change and the offset as two commands makes
barge-in non-atomic: an audio frame can land between them and the agent speaks over the user. A
state with no TTL leaks sessions forever, and a state whose TTL is set once dies mid-playback during
a long answer, so both halves of the TTL contract matter.`,
  sequence: {
    participants: ['Voice Gateway', 'Redis', 'TTS'],
    messages: [
      {
        from: 'Voice Gateway',
        to: 'Redis',
        label: 'EVAL barge_in · KEYS[voice:state:{session_id}] ARGV[delivered_tokens]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Voice Gateway', label: 'truncated_offset', kind: 'reply'},
      {from: 'Voice Gateway', to: 'TTS', label: 'stop stream at truncated_offset', kind: 'sync'},
      {from: 'Voice Gateway', to: 'Redis', label: 'EVAL refresh · HSET speaker · offset · EXPIRE 30', kind: 'async'},
      {from: 'Voice Gateway', to: 'Redis', label: 'HMGET current_speaker turn_index tts_offset', kind: 'sync'},
      {from: 'Redis', to: 'Voice Gateway', label: '[user, 4, 812]', kind: 'reply'},
    ],
  },
  hints: [
    'one Lua script does the whole transition server-side: set `current_speaker`, bump `turn_index`, keep `tts_offset`; `EVAL` is one round trip and cannot interleave.',
    'the TTL belongs in the same script that writes the state, checked with `TTL` and set with `EXPIRE` when the key was just created — that is what makes an idle session end and a long answer survive.',
    'the truncated offset is the return value of the script, not a second read: the caller must learn where to stop the stream from the same atomic transition that changed the speaker.',
  ],
  checks: [
    {
      id: 'atomic-barge-in',
      title: 'Barge-in is one atomic transition',
      detail:
        'The speaker change, the turn index and the truncation of `tts_offset` happen inside one Lua script executed with `EVAL`. The draft issues two separate writes, so a frame can land between them and the agent speaks over the user.',
      match: {
        python: {all: [/BARGE_IN_LUA/, /\.eval\(/]},
        typescript: {all: [/BARGE_IN_LUA/, /\.eval\(/]},
        go: {all: [/(bargeInScript|NewScript)/, /\.Run\(/]},
        scala: {all: [/BargeInLua/, /\.eval\(/]},
        cpp: {all: [/kBargeInLua/, /\.eval</]},
      },
    },
    {
      id: 'ttl-refresh',
      title: 'Turn state expires after 30 idle seconds and is refreshed',
      detail:
        'The state key gets a 30-second TTL and every frame refreshes it: `EXPIRE` runs inside the write. The draft never expires the key, so a dead session keeps a Redis hash forever.',
      match: {
        python: {all: [/STATE_TTL_S/, /EXPIRE/]},
        typescript: {all: [/STATE_TTL_S/, /EXPIRE/]},
        go: {all: [/stateTtlSeconds/, /EXPIRE/]},
        scala: {all: [/StateTtlSeconds/, /EXPIRE/]},
        cpp: {all: [/kStateTtlSeconds/, /EXPIRE/]},
      },
    },
    {
      id: 'fields',
      title: 'Keeps speaker, turn index and TTS offset together',
      detail:
        'The hash carries `current_speaker`, `turn_index` and `tts_offset`, so a reader can tell who is speaking and where playback stopped. The draft stores only the speaker and an offset, so the turn index is re-derived and the two fields drift apart.',
      match: {
        python: {all: [/current_speaker/, /turn_index/, /tts_offset/]},
        typescript: {all: [/current_speaker/, /turn_index/, /tts_offset/]},
        go: {all: [/current_speaker/, /turn_index/, /tts_offset/]},
        scala: {all: [/current_speaker/, /turn_index/, /tts_offset/]},
        cpp: {all: [/current_speaker/, /turn_index/, /tts_offset/]},
      },
    },
    {
      id: 'truncate',
      title: 'Truncates the TTS stream at the delivered token',
      detail:
        '`barge_in(session_id, delivered_tokens)` returns the `truncated_offset` (python `truncated_offset`, other languages `truncatedOffset`) that the gateway stops the stream at. The draft keeps playing the sentence the user just interrupted.',
      match: {
        python: {all: [/barge_in\(/, /truncated_offset/]},
        typescript: {all: [/bargeIn\(/, /truncatedOffset/]},
        go: {all: [/bargeIn\(/, /truncatedOffset/]},
        scala: {all: [/bargeIn\(/, /truncatedOffset/]},
        cpp: {all: [/bargeIn\(/, /truncatedOffset/]},
      },
    },
    {
      id: 'read-atomic',
      title: 'Reads the whole turn state in one round trip',
      detail:
        'Speaker, turn index and offset are read with one `HMGET`, so the gateway never renders a state that is half updated. The draft reads the fields one at a time with `HGET`.',
      match: {
        python: {all: [/[Hh][Mm][Gg][Ee][Tt]\(/]},
        typescript: {all: [/[Hh][Mm][Gg][Ee][Tt]\(/]},
        go: {all: [/[Hh][Mm][Gg][Ee][Tt]\(/]},
        scala: {all: [/[Hh][Mm][Gg][Ee][Tt]\(/]},
        cpp: {all: [/[Hh][Mm][Gg][Ee][Tt]\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Frame(BaseModel):
    session_id: str
    speaker: str
    offset: int


class Interrupt(BaseModel):
    session_id: str
    delivered_tokens: int


def save_turn(session_id: str, speaker: str, offset: int) -> None:
    # TODO: the speaker and the offset go out as two separate HSETs, so an audio frame can land
    # between them and the agent keeps talking over the user; nothing expires the key either, so a
    # dead session keeps its hash in Redis forever.
    key = f"voice:state:{session_id}"
    r.hset(key, "speaker", speaker)
    r.hset(key, "offset", offset)


def interrupt(session_id: str, delivered_tokens: int) -> int:
    save_turn(session_id, "user", delivered_tokens)
    return delivered_tokens


@app.post("/v1/voice/frames")
def frame(body: Frame) -> dict:
    save_turn(body.session_id, body.speaker, body.offset)
    return {"ok": True}


@app.post("/v1/voice/interrupt")
def interrupt_route(body: Interrupt) -> dict:
    return {"offset": interrupt(body.session_id, body.delivered_tokens)}


@app.get("/v1/voice/sessions/{session_id}/state")
def session_state(session_id: str) -> dict:
    key = f"voice:state:{session_id}"
    return {"speaker": r.hget(key, "speaker"), "offset": r.hget(key, "offset")}
`,
      solution: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The state key dies 30 s after the last audio frame; every frame restarts the clock.
STATE_TTL_S = 30

# One script is one transition: the speaker flips, the turn advances and tts_offset stays at the
# token the stream has already delivered, so the gateway truncates exactly where the user cut in.
BARGE_IN_LUA = """
local turn = redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', ARGV[1], 'turn_index', turn)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return tonumber(ARGV[1])
"""

# Every audio frame rewrites the state and refreshes the TTL in the same script: a pause longer
# than the TTL ends a dead session, a long answer keeps its own key alive.
REFRESH_LUA = """
redis.call('HSET', KEYS[1], 'current_speaker', ARGV[1], 'turn_index', ARGV[2], 'tts_offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return redis.call('TTL', KEYS[1])
"""


def state_key(session_id: str) -> str:
    return f"voice:state:{session_id}"


def refresh_state(session_id: str, current_speaker: str, turn_index: int, tts_offset: int) -> int:
    """Called for every audio frame; returns the TTL the key was given."""
    return int(
        r.eval(REFRESH_LUA, 1, state_key(session_id), current_speaker, turn_index, tts_offset, STATE_TTL_S)
    )


def barge_in(session_id: str, delivered_tokens: int) -> int:
    """The truncated offset is the script's return value, not a second read."""
    truncated_offset = int(r.eval(BARGE_IN_LUA, 1, state_key(session_id), delivered_tokens, STATE_TTL_S))
    return truncated_offset


def read_state(session_id: str) -> dict:
    """One HMGET: the gateway never renders a half-updated view."""
    current_speaker, turn_index, tts_offset = r.hmget(
        state_key(session_id), "current_speaker", "turn_index", "tts_offset"
    )
    return {
        "current_speaker": current_speaker or "user",
        "turn_index": int(turn_index or 0),
        "tts_offset": int(tts_offset or 0),
    }


class Frame(BaseModel):
    session_id: str
    current_speaker: str
    turn_index: int
    tts_offset: int


class Interrupt(BaseModel):
    session_id: str
    delivered_tokens: int


@app.post("/v1/voice/frames")
def frame(body: Frame) -> dict:
    refresh_state(body.session_id, body.current_speaker, body.turn_index, body.tts_offset)
    return {"ok": True}


@app.post("/v1/voice/interrupt")
def interrupt(body: Interrupt) -> dict:
    truncated_offset = barge_in(body.session_id, body.delivered_tokens)
    return {"truncated_offset": truncated_offset}


@app.get("/v1/voice/sessions/{session_id}/state")
def session_state(session_id: str) -> dict:
    return read_state(session_id)
`,
    },
    typescript: {
      starter: `/** Turn state for one voice session: a model-generated draft that writes both fields by hand. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
export const redis = new Redis('redis://redis:6379');

interface FrameBody {
  session_id: string;
  speaker: string;
  offset: number;
}

interface InterruptBody {
  session_id: string;
  delivered_tokens: number;
}

export function stateKey(sessionId: string): string {
  return \`voice:state:\${sessionId}\`;
}

export async function saveTurn(sessionId: string, speaker: string, offset: number): Promise<void> {
  // TODO: the speaker and the offset go out as two separate HSETs, so an audio frame can land
  // between them and the agent keeps talking over the user; nothing expires the key either, so a
  // dead session keeps its hash in Redis forever.
  await redis.hset(stateKey(sessionId), 'speaker', speaker);
  await redis.hset(stateKey(sessionId), 'offset', String(offset));
}

export async function interrupt(sessionId: string, deliveredTokens: number): Promise<number> {
  await saveTurn(sessionId, 'user', deliveredTokens);
  return deliveredTokens;
}

app.post('/v1/voice/frames', async (request, reply) => {
  const body = request.body as FrameBody;
  await saveTurn(body.session_id, body.speaker, body.offset);
  return reply.code(200).send({ok: true});
});

app.post('/v1/voice/interrupt', async (request, reply) => {
  const body = request.body as InterruptBody;
  return reply.code(200).send({offset: await interrupt(body.session_id, body.delivered_tokens)});
});

app.get('/v1/voice/sessions/:id/state', async (request, reply) => {
  const {id} = request.params as {id: string};
  return reply.code(200).send({
    speaker: await redis.hget(stateKey(id), 'speaker'),
    offset: await redis.hget(stateKey(id), 'offset'),
  });
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
      solution: `/** Turn state for one voice session: one atomic barge-in, one HMGET read, a 30 s idle TTL. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
export const redis = new Redis('redis://redis:6379');

// The state key dies 30 s after the last audio frame; every frame restarts the clock.
const STATE_TTL_S = 30;

// One script is one transition: the speaker flips, the turn advances and tts_offset stays at the
// token the stream has already delivered, so the gateway truncates exactly where the user cut in.
const BARGE_IN_LUA = \`
local turn = redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', ARGV[1], 'turn_index', turn)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return tonumber(ARGV[1])
\`;

// Every audio frame rewrites the state and refreshes the TTL in the same script: a pause longer
// than the TTL ends a dead session, a long answer keeps its own key alive.
const REFRESH_LUA = \`
redis.call('HSET', KEYS[1], 'current_speaker', ARGV[1], 'turn_index', ARGV[2], 'tts_offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return redis.call('TTL', KEYS[1])
\`;

interface FrameBody {
  session_id: string;
  current_speaker: string;
  turn_index: number;
  tts_offset: number;
}

interface InterruptBody {
  session_id: string;
  delivered_tokens: number;
}

export function stateKey(sessionId: string): string {
  return \`voice:state:\${sessionId}\`;
}

/** Called for every audio frame; returns the TTL the key was given. */
export async function refreshState(
  sessionId: string,
  currentSpeaker: string,
  turnIndex: number,
  ttsOffset: number,
): Promise<number> {
  const ttl = await redis.eval(
    REFRESH_LUA,
    1,
    stateKey(sessionId),
    currentSpeaker,
    String(turnIndex),
    String(ttsOffset),
    String(STATE_TTL_S),
  );
  return Number(ttl);
}

/** The truncated offset is the script's return value, not a second read. */
export async function bargeIn(sessionId: string, deliveredTokens: number): Promise<number> {
  const truncatedOffset = Number(
    await redis.eval(BARGE_IN_LUA, 1, stateKey(sessionId), String(deliveredTokens), String(STATE_TTL_S)),
  );
  return truncatedOffset;
}

/** One HMGET: the gateway never renders a half-updated view. */
export async function readState(sessionId: string): Promise<Record<string, string | number>> {
  const [currentSpeaker, turnIndex, ttsOffset] = await redis.hmget(
    stateKey(sessionId),
    'current_speaker',
    'turn_index',
    'tts_offset',
  );
  return {
    current_speaker: currentSpeaker ?? 'user',
    turn_index: Number(turnIndex ?? 0),
    tts_offset: Number(ttsOffset ?? 0),
  };
}

app.post('/v1/voice/frames', async (request, reply) => {
  const body = request.body as FrameBody;
  await refreshState(body.session_id, body.current_speaker, body.turn_index, body.tts_offset);
  return reply.code(200).send({ok: true});
});

app.post('/v1/voice/interrupt', async (request, reply) => {
  const body = request.body as InterruptBody;
  const truncatedOffset = await bargeIn(body.session_id, body.delivered_tokens);
  return reply.code(200).send({truncated_offset: truncatedOffset});
});

app.get('/v1/voice/sessions/:id/state', async (request, reply) => {
  const {id} = request.params as {id: string};
  return reply.code(200).send(await readState(id));
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type frameBody struct {
	SessionID string \`json:"session_id"\`
	Speaker   string \`json:"speaker"\`
	Offset    int64  \`json:"offset"\`
}

type interruptBody struct {
	SessionID       string \`json:"session_id"\`
	DeliveredTokens int64  \`json:"delivered_tokens"\`
}

func stateKey(sessionID string) string {
	return fmt.Sprintf("voice:state:%s", sessionID)
}

func saveTurn(ctx context.Context, sessionID, speaker string, offset int64) error {
	// TODO: the speaker and the offset go out as two separate HSETs, so an audio frame can land
	// between them and the agent keeps talking over the user; nothing expires the key either, so
	// a dead session keeps its hash in Redis forever.
	if err := rdb.HSet(ctx, stateKey(sessionID), "speaker", speaker).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, stateKey(sessionID), "offset", offset).Err()
}

func interrupt(ctx context.Context, sessionID string, deliveredTokens int64) (int64, error) {
	if err := saveTurn(ctx, sessionID, "user", deliveredTokens); err != nil {
		return 0, err
	}
	return deliveredTokens, nil
}

func frames(rw http.ResponseWriter, r *http.Request) {
	body := frameBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := saveTurn(r.Context(), body.SessionID, body.Speaker, body.Offset); err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.WriteHeader(http.StatusNoContent)
}

func interruptHandler(rw http.ResponseWriter, r *http.Request) {
	body := interruptBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	offset, err := interrupt(r.Context(), body.SessionID, body.DeliveredTokens)
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf("{\\"offset\\":%d}", offset)))
}

func sessionState(rw http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	speaker, err := rdb.HGet(r.Context(), stateKey(sessionID), "speaker").Result()
	if err != nil && err != redis.Nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	offset, err := rdb.HGet(r.Context(), stateKey(sessionID), "offset").Result()
	if err != nil && err != redis.Nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf("{\\"speaker\\":%q,\\"offset\\":%q}", speaker, offset)))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/voice/frames", frames)
	mux.HandleFunc("POST /v1/voice/interrupt", interruptHandler)
	mux.HandleFunc("GET /v1/voice/sessions/{id}/state", sessionState)
	_ = http.ListenAndServe(":8444", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// The state key dies 30 s after the last audio frame; every frame restarts the clock.
const stateTtlSeconds = 30

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// One script is one transition: the speaker flips, the turn advances and tts_offset stays at the
// token the stream has already delivered, so the gateway truncates exactly where the user cut in.
var bargeInScript = redis.NewScript(\`
local turn = redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', ARGV[1], 'turn_index', turn)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return tonumber(ARGV[1])
\`)

// Every audio frame rewrites the state and refreshes the TTL in the same script: a pause longer
// than the TTL ends a dead session, a long answer keeps its own key alive.
var refreshScript = redis.NewScript(\`
redis.call('HSET', KEYS[1], 'current_speaker', ARGV[1], 'turn_index', ARGV[2], 'tts_offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return redis.call('TTL', KEYS[1])
\`)

type frameBody struct {
	SessionID      string \`json:"session_id"\`
	CurrentSpeaker string \`json:"current_speaker"\`
	TurnIndex      int64  \`json:"turn_index"\`
	TtsOffset      int64  \`json:"tts_offset"\`
}

type interruptBody struct {
	SessionID       string \`json:"session_id"\`
	DeliveredTokens int    \`json:"delivered_tokens"\`
}

func stateKey(sessionID string) string {
	return fmt.Sprintf("voice:state:%s", sessionID)
}

// refreshState is called for every audio frame and returns the TTL the key was given.
func refreshState(ctx context.Context, sessionID, currentSpeaker string, turnIndex, ttsOffset int64) error {
	_, err := refreshScript.Run(
		ctx,
		rdb,
		[]string{stateKey(sessionID)},
		currentSpeaker,
		turnIndex,
		ttsOffset,
		stateTtlSeconds,
	).Result()
	return err
}

// bargeIn returns the truncated offset: it is the script's return value, not a second read.
func bargeIn(ctx context.Context, sessionID string, deliveredTokens int) (int64, error) {
	truncatedOffset, err := bargeInScript.Run(
		ctx,
		rdb,
		[]string{stateKey(sessionID)},
		deliveredTokens,
		stateTtlSeconds,
	).Int64()
	if err != nil {
		return 0, err
	}
	return truncatedOffset, nil
}

// readState is one HMGET: the gateway never renders a half-updated view.
func readState(ctx context.Context, sessionID string) (string, int64, int64, error) {
	values, err := rdb.HmGet(ctx, stateKey(sessionID), "current_speaker", "turn_index", "tts_offset").Result()
	if err != nil {
		return "", 0, 0, err
	}
	currentSpeaker, _ := values[0].(string)
	turnIndex := int64(0)
	if raw, ok := values[1].(string); ok {
		turnIndex, _ = strconv.ParseInt(raw, 10, 64)
	}
	ttsOffset := int64(0)
	if raw, ok := values[2].(string); ok {
		ttsOffset, _ = strconv.ParseInt(raw, 10, 64)
	}
	return currentSpeaker, turnIndex, ttsOffset, nil
}

func frames(rw http.ResponseWriter, r *http.Request) {
	body := frameBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := refreshState(r.Context(), body.SessionID, body.CurrentSpeaker, body.TurnIndex, body.TtsOffset); err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.WriteHeader(http.StatusNoContent)
}

func interruptHandler(rw http.ResponseWriter, r *http.Request) {
	body := interruptBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	truncatedOffset, err := bargeIn(r.Context(), body.SessionID, body.DeliveredTokens)
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf("{\\"truncated_offset\\":%d}", truncatedOffset)))
}

func sessionState(rw http.ResponseWriter, r *http.Request) {
	currentSpeaker, turnIndex, ttsOffset, err := readState(r.Context(), r.PathValue("id"))
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(
		"{\\"current_speaker\\":%q,\\"turn_index\\":%d,\\"tts_offset\\":%d}", currentSpeaker, turnIndex, ttsOffset)))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/voice/frames", frames)
	mux.HandleFunc("POST /v1/voice/interrupt", interruptHandler)
	mux.HandleFunc("GET /v1/voice/sessions/{id}/state", sessionState)
	_ = http.ListenAndServe(":8444", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class FrameRequest(session_id: String, speaker: String, offset: Long)
final case class InterruptRequest(session_id: String, delivered_tokens: Long)

object SessionState {
  implicit val system: ActorSystem = ActorSystem("voice-gateway")
  implicit val frameFormat: RootJsonFormat[FrameRequest] = jsonFormat3(FrameRequest)
  implicit val interruptFormat: RootJsonFormat[InterruptRequest] = jsonFormat2(InterruptRequest)

  val jedis = new Jedis("redis", 6379)

  def stateKey(sessionId: String): String = s"voice:state:$sessionId"

  def saveTurn(sessionId: String, speaker: String, offset: Long): Unit = {
    // TODO: the speaker and the offset go out as two separate HSETs, so an audio frame can land
    // between them and the agent keeps talking over the user; nothing expires the key either, so
    // a dead session keeps its hash in Redis forever.
    jedis.hset(stateKey(sessionId), "speaker", speaker)
    jedis.hset(stateKey(sessionId), "offset", offset.toString)
  }

  def interrupt(sessionId: String, deliveredTokens: Long): Long = {
    saveTurn(sessionId, "user", deliveredTokens)
    deliveredTokens
  }

  val route: Route =
    pathPrefix("v1" / "voice") {
      concat(
        path("frames") {
          post {
            entity(as[FrameRequest]) { body =>
              saveTurn(body.session_id, body.speaker, body.offset)
              complete(StatusCodes.NoContent)
            }
          }
        },
        path("interrupt") {
          post {
            entity(as[InterruptRequest]) { body =>
              val offset = interrupt(body.session_id, body.delivered_tokens)
              complete(StatusCodes.OK, s"""{"offset":$offset}""")
            }
          }
        },
        path("sessions" / Segment / "state") { sessionId =>
          get {
            val speaker = jedis.hget(stateKey(sessionId), "speaker")
            val offset = jedis.hget(stateKey(sessionId), "offset")
            complete(StatusCodes.OK, s"""{"speaker":"$speaker","offset":$offset}""")
          }
        }
      )
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

final case class FrameRequest(
    session_id: String,
    current_speaker: String,
    turn_index: Long,
    tts_offset: Long
)
final case class InterruptRequest(session_id: String, delivered_tokens: Long)

object SessionState {
  implicit val system: ActorSystem = ActorSystem("voice-gateway")
  implicit val frameFormat: RootJsonFormat[FrameRequest] = jsonFormat4(FrameRequest)
  implicit val interruptFormat: RootJsonFormat[InterruptRequest] = jsonFormat2(InterruptRequest)

  // The state key dies 30 s after the last audio frame; every frame restarts the clock.
  val StateTtlSeconds = 30L
  val jedis = new Jedis("redis", 6379)

  // One script is one transition: the speaker flips, the turn advances and tts_offset stays at the
  // token the stream has already delivered, so the gateway truncates exactly where the user cut in.
  val BargeInLua =
    """
      |local turn = redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
      |redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', ARGV[1], 'turn_index', turn)
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |return tonumber(ARGV[1])
      |""".stripMargin

  // Every audio frame rewrites the state and refreshes the TTL in the same script: a pause longer
  // than the TTL ends a dead session, a long answer keeps its own key alive.
  val RefreshLua =
    """
      |redis.call('HSET', KEYS[1], 'current_speaker', ARGV[1], 'turn_index', ARGV[2], 'tts_offset', ARGV[3])
      |redis.call('EXPIRE', KEYS[1], ARGV[4])
      |return redis.call('TTL', KEYS[1])
      |""".stripMargin

  def stateKey(sessionId: String): String = s"voice:state:$sessionId"

  /** Called for every audio frame; returns the TTL the key was given. */
  def refreshState(sessionId: String, currentSpeaker: String, turnIndex: Long, ttsOffset: Long): Long = {
    val ttl = jedis
      .eval(
        RefreshLua,
        1,
        stateKey(sessionId),
        currentSpeaker,
        turnIndex.toString,
        ttsOffset.toString,
        StateTtlSeconds.toString
      )
      .asInstanceOf[java.lang.Long]
    ttl.longValue()
  }

  /** The truncated offset is the script's return value, not a second read. */
  def bargeIn(sessionId: String, deliveredTokens: Long): Long = {
    val truncatedOffset = jedis
      .eval(BargeInLua, 1, stateKey(sessionId), deliveredTokens.toString, StateTtlSeconds.toString)
      .asInstanceOf[java.lang.Long]
    truncatedOffset.longValue()
  }

  /** One HMGET: the gateway never renders a half-updated view. */
  def readState(sessionId: String): (String, Long, Long) = {
    val values = jedis.hmget(stateKey(sessionId), "current_speaker", "turn_index", "tts_offset").asScala
    (
      Option(values.head).getOrElse("user"),
      Option(values(1)).map(_.toLong).getOrElse(0L),
      Option(values(2)).map(_.toLong).getOrElse(0L)
    )
  }

  val route: Route =
    pathPrefix("v1" / "voice") {
      concat(
        path("frames") {
          post {
            entity(as[FrameRequest]) { body =>
              refreshState(body.session_id, body.current_speaker, body.turn_index, body.tts_offset)
              complete(StatusCodes.NoContent)
            }
          }
        },
        path("interrupt") {
          post {
            entity(as[InterruptRequest]) { body =>
              val truncatedOffset = bargeIn(body.session_id, body.delivered_tokens)
              complete(StatusCodes.OK, s"""{"truncated_offset":$truncatedOffset}""")
            }
          }
        },
        path("sessions" / Segment / "state") { sessionId =>
          get {
            val (currentSpeaker, turnIndex, ttsOffset) = readState(sessionId)
            complete(
              StatusCodes.OK,
              s"""{"current_speaker":"$currentSpeaker","turn_index":$turnIndex,"tts_offset":$ttsOffset}"""
            )
          }
        }
      )
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::string state_key(const std::string& session_id) {
  return "voice:state:" + session_id;
}

// TODO: the speaker and the offset go out as two separate HSETs, so an audio frame can land
// between them and the agent keeps talking over the user; nothing expires the key either, so a
// dead session keeps its hash in Redis forever.
void save_turn(const std::string& session_id, const std::string& speaker, long long offset) {
  redis.hset(state_key(session_id), "speaker", speaker);
  redis.hset(state_key(session_id), "offset", std::to_string(offset));
}

long long interrupt(const std::string& session_id, long long delivered_tokens) {
  save_turn(session_id, "user", delivered_tokens);
  return delivered_tokens;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/voice/frames", [](const httplib::Request& req, httplib::Response& res) {
    const auto body = json::parse(req.body, nullptr, false);
    save_turn(body.value("session_id", std::string()), body.value("speaker", std::string()),
              body.value("offset", 0LL));
    res.status = 204;
  });

  svr.Post("/v1/voice/interrupt", [](const httplib::Request& req, httplib::Response& res) {
    const auto body = json::parse(req.body, nullptr, false);
    const auto offset =
        interrupt(body.value("session_id", std::string()), body.value("delivered_tokens", 0LL));
    res.status = 200;
    res.set_content(json{{"offset", offset}}.dump(), "application/json");
  });

  svr.Get(R"(/v1/voice/sessions/([^/]+)/state)", [](const httplib::Request& req, httplib::Response& res) {
    const auto session_id = req.matches[1].str();
    const auto speaker = redis.hget(state_key(session_id), "speaker");
    const auto offset = redis.hget(state_key(session_id), "offset");
    res.status = 200;
    res.set_content(json{{"speaker", speaker ? *speaker : ""}, {"offset", offset ? *offset : ""}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The state key dies 30 s after the last audio frame; every frame restarts the clock.
constexpr long long kStateTtlSeconds = 30;

// One script is one transition: the speaker flips, the turn advances and tts_offset stays at the
// token the stream has already delivered, so the gateway truncates exactly where the user cut in.
const char* kBargeInLua = R"LUA(
local turn = redis.call('HINCRBY', KEYS[1], 'turn_index', 1)
redis.call('HSET', KEYS[1], 'current_speaker', 'user', 'tts_offset', ARGV[1], 'turn_index', turn)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return tonumber(ARGV[1])
)LUA";

// Every audio frame rewrites the state and refreshes the TTL in the same script: a pause longer
// than the TTL ends a dead session, a long answer keeps its own key alive.
const char* kRefreshLua = R"LUA(
redis.call('HSET', KEYS[1], 'current_speaker', ARGV[1], 'turn_index', ARGV[2], 'tts_offset', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return redis.call('TTL', KEYS[1])
)LUA";

std::string stateKey(const std::string& sessionId) {
  return "voice:state:" + sessionId;
}

// Called for every audio frame; returns the TTL the key was given.
long long refreshState(
    const std::string& sessionId,
    const std::string& currentSpeaker,
    long long turnIndex,
    long long ttsOffset) {
  return redis.eval<long long>(
      kRefreshLua,
      {stateKey(sessionId)},
      {currentSpeaker, std::to_string(turnIndex), std::to_string(ttsOffset),
       std::to_string(kStateTtlSeconds)});
}

// The truncated offset is the script's return value, not a second read.
long long bargeIn(const std::string& sessionId, long long deliveredTokens) {
  const auto truncatedOffset = redis.eval<long long>(
      kBargeInLua,
      {stateKey(sessionId)},
      {std::to_string(deliveredTokens), std::to_string(kStateTtlSeconds)});
  return truncatedOffset;
}

// One HMGET: the gateway never renders a half-updated view.
std::tuple<std::string, long long, long long> readState(const std::string& sessionId) {
  std::vector<std::optional<std::string>> values;
  redis.hmget(stateKey(sessionId), {"current_speaker", "turn_index", "tts_offset"},
              std::back_inserter(values));
  return {values[0] ? *values[0] : "user",
          values[1] ? std::stoll(*values[1]) : 0LL,
          values[2] ? std::stoll(*values[2]) : 0LL};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/voice/frames", [](const httplib::Request& req, httplib::Response& res) {
    const auto body = json::parse(req.body, nullptr, false);
    refreshState(body.value("session_id", std::string()), body.value("current_speaker", std::string()),
                 body.value("turn_index", 0LL), body.value("tts_offset", 0LL));
    res.status = 204;
  });

  svr.Post("/v1/voice/interrupt", [](const httplib::Request& req, httplib::Response& res) {
    const auto body = json::parse(req.body, nullptr, false);
    const auto truncatedOffset =
        bargeIn(body.value("session_id", std::string()), body.value("delivered_tokens", 0LL));
    res.status = 200;
    res.set_content(json{{"truncated_offset", truncatedOffset}}.dump(), "application/json");
  });

  svr.Get(R"(/v1/voice/sessions/([^/]+)/state)", [](const httplib::Request& req, httplib::Response& res) {
    const auto [currentSpeaker, turnIndex, ttsOffset] = readState(req.matches[1].str());
    res.status = 200;
    res.set_content(json{{"current_speaker", currentSpeaker},
                         {"turn_index", turnIndex},
                         {"tts_offset", ttsOffset}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
    },
  },
  debrief: `Barge-in is a state machine, not two writes, because the interruption and the truncation are the same fact: the speaker may never change without the offset moving with it, and an audio frame must never land between the two — that is why the whole transition lives in one Lua script and the caller learns where to stop the stream from that script's return value rather than a second read. The TTL is refreshed by every audio frame because the key's existence is the session's liveness: a caller who stops sending audio lets the state die within 30 seconds, while a caller in the middle of a two-minute answer keeps renewing the lease and is never cut off mid-playback. Both halves matter — a state with no TTL leaks sessions forever, and a state whose TTL is set once expires under a long answer. A real voice platform adds per-session sharding so one hot call cannot share a Redis slot with everyone else's, a monotonic sequence number so a replayed or reordered frame is rejected instead of rewinding the state, and a small replay buffer for the frames a reconnecting client missed while the gateway held its state.`,
};
