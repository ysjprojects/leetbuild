import type {Step} from '@/lib/types';

export const userLimitsStep: Step = {
  id: 'user-limits',
  title: 'Per-user limits, a block-list with a TTL, sessions that expire',
  concept: 'redis',
  file: 'limits',
  focus: ['api', 'redis', 'model'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a user with questions left
gets through, a question that made the model misbehave is remembered, and the session grows with
each turn — so the demo passes. The Redis layer hides a wrong key, a race, and three keys that never
die. Review it, fix it, and prove the fix.

Implement the Redis state used by every \`POST /v1/ask\`:

- Each **user** gets **30 questions** per **60-second window**. The key is
  \`limits:{user}:{window}\` where \`window\` is \`floor(unix_seconds / 60)\`. The draft keys the
  limit by document, so one shared document's budget is spent by whoever asks first, and one user
  can ask without limit across documents.
- One atomic Lua \`EVAL\` reads the counter, rejects when the window is full, increments with
  \`INCR\`, and sets \`EXPIRE\` on the first write so the counter dies with its window. A client-side
  read followed by a separate increment lets concurrent requests all pass the same check.
- A full window answers **429** with \`Retry-After\` (the key's \`TTL\`) and
  \`X-RateLimit-Remaining\`, **before** the model is called.
- A question that made the model leak (the model layer raises \`Rejected\`) is remembered by its
  SHA-256 under \`flagged:{hash}\` with a **24-hour** TTL (\`FLAG_TTL_S = 86400\`), and the same
  question is answered **422** without a model call while the key lives. The draft sets the key
  without a TTL, so a block-list of attacks grows forever and a false positive is permanent.
- The session \`session:{user}:{document_id}\` keeps the hashes of the last 20 questions and is
  refreshed to a **30-minute** TTL (\`SESSION_TTL_S = 1800\`) on every write. The draft's sessions
  never expire.

**Failure mode the checks target.** Keyed by document, the limit is neither a user limit nor a
fair one; read-then-increment lets a burst of concurrent asks overspend; and three keys without a
TTL — the window, the block-list, the session — turn Redis into a slow leak that keeps a user
locked out, keeps an attack signature forever, and keeps every conversation ever started.`,
  sequence: {
    participants: ['promptguard', 'Redis', 'Model'],
    messages: [
      {from: 'promptguard', to: 'Redis', label: 'EVAL reserve · KEYS[limits:u42:29162240]', kind: 'sync'},
      {from: 'Redis', to: 'promptguard', label: '{1, 29, 47}', kind: 'reply'},
      {from: 'promptguard', to: 'Redis', label: 'EXISTS flagged:{sha256(question)}', kind: 'sync'},
      {from: 'Redis', to: 'promptguard', label: '0 → continue · 1 → 422 without a model call', kind: 'reply'},
      {from: 'promptguard', to: 'Model', label: 'answer(document, question)', kind: 'sync'},
      {from: 'Model', to: 'promptguard', label: 'answer / Rejected', kind: 'reply'},
      {from: 'promptguard', to: 'Redis', label: 'SETEX flagged:{hash} 86400 on Rejected', kind: 'async'},
      {from: 'promptguard', to: 'Redis', label: 'RPUSH session:{user}:{doc} · EXPIRE 1800', kind: 'async'},
    ],
  },
  hints: [
    'The limit is a property of the user, not of the document: build the key from the authenticated `X-User-Id` and the minute bucket. Everything that reads and changes the counter has to happen inside one script: `GET`, compare, `INCR`, and `EXPIRE` when the counter was just created.',
    'The script returns `{ok, remaining, ttl}`; the 429 is built from that reply (`Retry-After` = ttl, `X-RateLimit-Remaining` = remaining), and the handler returns before any model stub is touched.',
    'Every key written in the request path needs a lifetime: `SETEX flagged:{hash} 86400` for the block-list, and `EXPIRE session:{user}:{doc} 1800` after every `RPUSH` so an active conversation stays alive and an abandoned one disappears.',
  ],
  checks: [
    {
      id: 'user-window-key',
      title: 'Keys the limit by user and window',
      detail:
        'The key is `limits:{user}:{window}` built from the authenticated user and the 60-second bucket (`WINDOW_S = 60`). The draft keys by document, so one document’s budget is shared by everyone and a user is unlimited across documents.',
      match: {
        python: {all: [/limits:\{user\}:\{window\}/, /WINDOW_S\s*=\s*60/], none: [/limits:\{document/]},
        typescript: {all: [/limits:\$\{user\}:\$\{window\}/, /WINDOW_S\s*=\s*60/], none: [/limits:\$\{document/]},
        go: {all: [/limits:%s:%d/, /windowSeconds\s*=\s*60/], none: [/"limits:"\s*\+\s*document/]},
        scala: {all: [/limits:\$user:\$window/, /WindowSeconds\s*=\s*60/], none: [/limits:\$document/]},
        cpp: {all: [/"limits:"\s*\+\s*user/, /kWindowSeconds\s*=\s*60/], none: [/"limits:"\s*\+\s*document/]},
      },
    },
    {
      id: 'atomic',
      title: 'Reserves with one atomic Lua script',
      detail:
        'The counter is read, compared and incremented (`INCR`) inside one `EVAL`/`NewScript` call. A client-side read followed by a separate increment lets concurrent requests all pass the same check.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /INCR/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /INCR/]},
        go: {all: [/(reserveScript|NewScript)/, /\.Run\(/, /INCR/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /INCR/]},
        cpp: {all: [/kReserveLua/, /\.eval</, /INCR/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Window expires on first write; 429 carries Retry-After',
      detail:
        'The script sets `EXPIRE` when it creates the key and returns the remaining `TTL`; a full window answers **429** with `Retry-After` built from that TTL. The draft’s counter never resets, so one busy minute locks the user out for good.',
      match: {
        python: {all: [/EXPIRE/, /TTL/, /Retry-After/, /status_code\s*=\s*429/]},
        typescript: {all: [/EXPIRE/, /TTL/, /Retry-After/, /\.code\(\s*429\s*\)/]},
        go: {all: [/EXPIRE/, /TTL/, /Retry-After/, /StatusTooManyRequests/]},
        scala: {all: [/EXPIRE/, /TTL/, /Retry-After/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/EXPIRE/, /TTL/, /Retry-After/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'flag-ttl',
      title: 'Block-list entries live 24 hours',
      detail:
        'A question that made the model leak is stored under `flagged:{sha256}` with `FLAG_TTL_S = 86400` (`SETEX` / `SET … EX`). The draft writes the key without an expiry, so the block-list grows forever and a false positive never clears.',
      match: {
        python: {all: [/FLAG_TTL_S\s*=\s*86400/, /\.setex\(/]},
        typescript: {all: [/FLAG_TTL_S\s*=\s*86400/, /['"]EX['"],\s*FLAG_TTL_S/]},
        go: {all: [/flagTTLS\s*=\s*86400/, /\.Set\([^;\n]*flagTTLS/]},
        scala: {all: [/FlagTtlS\s*=\s*86400/, /\.setex\(/]},
        cpp: {all: [/kFlagTtlS\s*=\s*86400/, /\.set\([^;\n]*kFlagTtlS/]},
      },
    },
    {
      id: 'session-ttl',
      title: 'Sessions expire after 30 minutes of silence',
      detail:
        'Every write to `session:{user}:{document_id}` is followed by `EXPIRE` with `SESSION_TTL_S = 1800`, so an active conversation stays alive and an abandoned one disappears. The draft’s sessions live forever.',
      match: {
        python: {all: [/SESSION_TTL_S\s*=\s*1800/, /\.expire\(/]},
        typescript: {all: [/SESSION_TTL_S\s*=\s*1800/, /\.expire\(/]},
        go: {all: [/sessionTTLS\s*=\s*1800/, /\.Expire\(/]},
        scala: {all: [/SessionTtlS\s*=\s*1800/, /\.expire\(/]},
        cpp: {all: [/kSessionTtlS\s*=\s*1800/, /\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from model_call import Rejected, answer

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT_QUESTIONS = 30


class AskRequest(BaseModel):
    document_id: str
    question: str


class DocumentStore:
    def get(self, document_id: str) -> str | None:
        raise NotImplementedError


docs = DocumentStore()


def charge(document_id: str) -> tuple[bool, int]:
    # TODO: key the limit by user and window, make the read-check-increment one atomic EVAL with
    # an EXPIRE on first write, give the block-list and the session a TTL, and reserve before the
    # model call instead of after it.
    key = f"limits:{document_id}"
    used = int(r.get(key) or 0)
    if used >= LIMIT_QUESTIONS:
        return False, 0
    r.incr(key)
    return True, LIMIT_QUESTIONS - used - 1


@app.post("/v1/ask")
def ask(body: AskRequest, user: str = Header(alias="X-User-Id")) -> dict:
    document = docs.get(body.document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="unknown document")
    q_hash = hashlib.sha256(body.question.encode("utf-8")).hexdigest()
    if r.get(f"flagged:{q_hash}"):
        raise HTTPException(status_code=422, detail="question is blocked")
    try:
        result = answer(document, body.question)
    except Rejected:
        r.set(f"flagged:{q_hash}", "1")
        raise HTTPException(status_code=422, detail="refused")
    ok, left = charge(body.document_id)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="too many questions",
            headers={"Retry-After": "60", "X-RateLimit-Remaining": "0"},
        )
    r.rpush(f"session:{user}:{body.document_id}", q_hash)
    return {"answer": result.answer, "remaining": left}
`,
      solution: `import hashlib
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from model_call import Rejected, answer

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
LIMIT_QUESTIONS = 30
FLAG_TTL_S = 86400
SESSION_TTL_S = 1800
SESSION_TURNS = 20

RESERVE_LUA = """
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, tonumber(ARGV[1]) - used, redis.call('TTL', KEYS[1])}
"""


class AskRequest(BaseModel):
    document_id: str
    question: str


class DocumentStore:
    def get(self, document_id: str) -> str | None:
        raise NotImplementedError


docs = DocumentStore()


def limits_key(user: str, window: int) -> str:
    return f"limits:{user}:{window}"


def flagged_key(q_hash: str) -> str:
    return f"flagged:{q_hash}"


def session_key(user: str, document_id: str) -> str:
    return f"session:{user}:{document_id}"


def reserve(user: str) -> tuple[bool, int, int]:
    window = int(time.time()) // WINDOW_S
    ok, left, ttl = r.eval(RESERVE_LUA, 1, limits_key(user, window), LIMIT_QUESTIONS, WINDOW_S)
    return bool(ok), int(left), int(ttl)


@app.post("/v1/ask")
def ask(body: AskRequest, user: str = Header(alias="X-User-Id")) -> dict:
    ok, left, ttl = reserve(user)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="too many questions",
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(left)},
        )
    q_hash = hashlib.sha256(body.question.encode("utf-8")).hexdigest()
    if r.exists(flagged_key(q_hash)):
        raise HTTPException(status_code=422, detail="question is blocked")
    document = docs.get(body.document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="unknown document")
    try:
        result = answer(document, body.question)
    except Rejected:
        r.setex(flagged_key(q_hash), FLAG_TTL_S, "1")
        raise HTTPException(status_code=422, detail="refused")
    session = session_key(user, body.document_id)
    pipe = r.pipeline()
    pipe.rpush(session, q_hash)
    pipe.ltrim(session, -SESSION_TURNS, -1)
    pipe.expire(session, SESSION_TTL_S)
    pipe.execute()
    return {"answer": result.answer, "remaining": left}
`,
    },
    typescript: {
      starter: `/** POST /v1/ask: a model-generated draft that limits per document and never expires a key. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {docs} from './docs';
import {answer, type ModelAnswer, Rejected} from './model_call';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const LIMIT_QUESTIONS = 30;

interface AskBody {
  document_id: string;
  question: string;
}

async function charge(documentId: string): Promise<[boolean, number]> {
  // TODO: key the limit by user and window, make the read-check-increment one atomic EVAL with
  // an EXPIRE on first write, give the block-list and the session a TTL, and reserve before the
  // model call instead of after it.
  const key = \`limits:\${documentId}\`;
  const used = Number((await r.get(key)) ?? 0);
  if (used >= LIMIT_QUESTIONS) return [false, 0];
  await r.incr(key);
  return [true, LIMIT_QUESTIONS - used - 1];
}

app.post('/v1/ask', async (request, reply) => {
  const user = request.headers['x-user-id'] as string;
  const body = request.body as AskBody;
  const document = await docs.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  const qHash = createHash('sha256').update(body.question).digest('hex');
  if ((await r.get(\`flagged:\${qHash}\`)) !== null) return reply.code(422).send({error: 'question is blocked'});
  let result: ModelAnswer;
  try {
    result = await answer(document, body.question);
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    await r.set(\`flagged:\${qHash}\`, '1');
    return reply.code(422).send({error: 'refused'});
  }
  const [ok, left] = await charge(body.document_id);
  if (!ok) {
    return reply
      .code(429)
      .header('Retry-After', '60')
      .header('X-RateLimit-Remaining', '0')
      .send({error: 'too many questions'});
  }
  await r.rpush(\`session:\${user}:\${body.document_id}\`, qHash);
  return reply.code(200).send({answer: result.answer, remaining: left});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/ask: an atomic per-user window, a block-list that forgets, sessions that expire. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {docs} from './docs';
import {answer, type ModelAnswer, Rejected} from './model_call';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const LIMIT_QUESTIONS = 30;
const FLAG_TTL_S = 86400;
const SESSION_TTL_S = 1800;
const SESSION_TURNS = 20;

const RESERVE_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, tonumber(ARGV[1]) - used, redis.call('TTL', KEYS[1])}
\`;

interface AskBody {
  document_id: string;
  question: string;
}

function limitsKey(user: string, window: number): string {
  return \`limits:\${user}:\${window}\`;
}

function flaggedKey(qHash: string): string {
  return \`flagged:\${qHash}\`;
}

function sessionKey(user: string, documentId: string): string {
  return \`session:\${user}:\${documentId}\`;
}

async function reserve(user: string): Promise<[boolean, number, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const result = (await r.eval(RESERVE_LUA, 1, limitsKey(user, window), String(LIMIT_QUESTIONS), String(WINDOW_S))) as [
    number,
    number,
    number,
  ];
  return [result[0] === 1, result[1], result[2]];
}

app.post('/v1/ask', async (request, reply) => {
  const user = request.headers['x-user-id'] as string;
  const body = request.body as AskBody;
  const [ok, left, ttl] = await reserve(user);
  if (!ok) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .header('X-RateLimit-Remaining', String(left))
      .send({error: 'too many questions'});
  }
  const qHash = createHash('sha256').update(body.question).digest('hex');
  if ((await r.exists(flaggedKey(qHash))) === 1) return reply.code(422).send({error: 'question is blocked'});
  const document = await docs.get(body.document_id);
  if (document === null) return reply.code(404).send({error: 'unknown document'});
  let result: ModelAnswer;
  try {
    result = await answer(document, body.question);
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    await r.set(flaggedKey(qHash), '1', 'EX', FLAG_TTL_S);
    return reply.code(422).send({error: 'refused'});
  }
  const session = sessionKey(user, body.document_id);
  await r.multi().rpush(session, qHash).ltrim(session, -SESSION_TURNS, -1).expire(session, SESSION_TTL_S).exec();
  return reply.code(200).send({answer: result.answer, remaining: left});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const limitQuestions = 30

var (
	rdb  *redis.Client
	docs *DocumentStore
)

type DocumentStore struct{}

func (s *DocumentStore) Get(id string) (string, bool) {
	return "", false
}

func charge(ctx context.Context, documentID string) (bool, int) {
	// TODO: key the limit by user and window, make the read-check-increment one atomic EVAL with
	// an EXPIRE on first write, give the block-list and the session a TTL, and reserve before the
	// model call instead of after it.
	key := "limits:" + documentID
	used, _ := rdb.Get(ctx, key).Int()
	if used >= limitQuestions {
		return false, 0
	}
	rdb.Incr(ctx, key)
	return true, limitQuestions - used - 1
}

func ask(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	body := struct {
		DocumentID string \`json:"document_id"\`
		Question   string \`json:"question"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	document, ok := docs.Get(body.DocumentID)
	if !ok {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	sum := sha256.Sum256([]byte(body.Question))
	qHash := hex.EncodeToString(sum[:])
	if flagged, _ := rdb.Get(r.Context(), "flagged:"+qHash).Result(); flagged != "" {
		rw.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	result, err := answer(r.Context(), document, body.Question)
	if errors.Is(err, errRejected) {
		rdb.Set(r.Context(), "flagged:"+qHash, "1", 0)
		rw.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	ok, left := charge(r.Context(), body.DocumentID)
	if !ok {
		rw.Header().Set("Retry-After", "60")
		rw.Header().Set("X-RateLimit-Remaining", "0")
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	rdb.RPush(r.Context(), "session:"+user+":"+body.DocumentID, qHash)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"answer":%q,"remaining":%d}\`, result.Answer, left)))
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds  = 60
	limitQuestions = 30
	flagTTLS       = 86400
	sessionTTLS    = 1800
	sessionTurns   = 20
)

var (
	rdb  *redis.Client
	docs *DocumentStore
)

type DocumentStore struct{}

func (s *DocumentStore) Get(id string) (string, bool) {
	return "", false
}

var reserveScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, tonumber(ARGV[1]) - used, redis.call('TTL', KEYS[1])}
\`)

func limitsKey(user string, window int64) string {
	return fmt.Sprintf("limits:%s:%d", user, window)
}

func flaggedKey(qHash string) string {
	return "flagged:" + qHash
}

func sessionKey(user, documentID string) string {
	return "session:" + user + ":" + documentID
}

func reserve(ctx context.Context, user string) (bool, int64, int64, error) {
	window := time.Now().Unix() / windowSeconds
	values, err := reserveScript.Run(ctx, rdb, []string{limitsKey(user, window)}, limitQuestions, windowSeconds).Int64Slice()
	if err != nil {
		return false, 0, 0, err
	}
	return values[0] == 1, values[1], values[2], nil
}

func ask(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	body := struct {
		DocumentID string \`json:"document_id"\`
		Question   string \`json:"question"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ok, left, ttl, err := reserve(r.Context(), user)
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if !ok {
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", max(ttl, 1)))
		rw.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", left))
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	sum := sha256.Sum256([]byte(body.Question))
	qHash := hex.EncodeToString(sum[:])
	if flagged, _ := rdb.Exists(r.Context(), flaggedKey(qHash)).Result(); flagged == 1 {
		rw.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	document, found := docs.Get(body.DocumentID)
	if !found {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	result, err := answer(r.Context(), document, body.Question)
	if errors.Is(err, errRejected) {
		rdb.Set(r.Context(), flaggedKey(qHash), "1", flagTTLS*time.Second)
		rw.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	session := sessionKey(user, body.DocumentID)
	pipe := rdb.TxPipeline()
	pipe.RPush(r.Context(), session, qHash)
	pipe.LTrim(r.Context(), session, -sessionTurns, -1)
	pipe.Expire(r.Context(), session, sessionTTLS*time.Second)
	_, _ = pipe.Exec(r.Context())
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"answer":%q,"remaining":%d}\`, result.Answer, left)))
}

func main() {}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AskRequest(document_id: String, question: String)

object LimitsApi {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val askFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)

  val LimitQuestions = 30L
  val jedis = new Jedis("redis", 6379)
  val docs = DocumentStore.open()

  def sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  // TODO: key the limit by user and window, make the read-check-increment one atomic EVAL with
  // an EXPIRE on first write, give the block-list and the session a TTL, and reserve before the
  // model call instead of after it.
  def charge(document: String): (Boolean, Long) = {
    val key = s"limits:$document"
    val used = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (used >= LimitQuestions) (false, 0L)
    else {
      jedis.incr(key)
      (true, LimitQuestions - used - 1)
    }
  }

  val route: Route =
    path("v1" / "ask") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[AskRequest]) { body =>
            docs.get(body.document_id) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown document"}""")
              case Some(document) =>
                val qHash = sha256(body.question)
                if (jedis.get(s"flagged:$qHash") != null) {
                  complete(StatusCodes.UnprocessableEntity, """{"error":"question is blocked"}""")
                } else {
                  try {
                    val result = ModelCall.answer(document, body.question)
                    val (ok, left) = charge(body.document_id)
                    if (!ok) {
                      complete(
                        HttpResponse(
                          StatusCodes.TooManyRequests,
                          headers = List(RawHeader("Retry-After", "60"), RawHeader("X-RateLimit-Remaining", "0")),
                          entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"too many questions"}""")
                        )
                      )
                    } else {
                      jedis.rpush(s"session:$user:\${body.document_id}", qHash)
                      complete(StatusCodes.OK, s"""{"answer":"\${result.answer}","remaining":$left}""")
                    }
                  } catch {
                    case _: ModelCall.Rejected =>
                      jedis.set(s"flagged:$qHash", "1")
                      complete(StatusCodes.UnprocessableEntity, """{"error":"refused"}""")
                  }
                }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AskRequest(document_id: String, question: String)

object LimitsApi {
  implicit val system: ActorSystem = ActorSystem("promptguard")
  implicit val askFormat: RootJsonFormat[AskRequest] = jsonFormat2(AskRequest)

  val WindowSeconds = 60L
  val LimitQuestions = 30L
  val FlagTtlS = 86400L
  val SessionTtlS = 1800L
  val SessionTurns = 20L
  val jedis = new Jedis("redis", 6379)
  val docs = DocumentStore.open()

  val ReserveLua =
    """
      |local used = tonumber(redis.call('GET', KEYS[1])) or 0
      |if used >= tonumber(ARGV[1]) then
      |  return {0, 0, redis.call('TTL', KEYS[1])}
      |end
      |used = redis.call('INCR', KEYS[1])
      |if used == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |return {1, tonumber(ARGV[1]) - used, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  def limitsKey(user: String, window: Long): String = s"limits:$user:$window"
  def flaggedKey(qHash: String): String = s"flagged:$qHash"
  def sessionKey(user: String, document: String): String = s"session:$user:$document"

  def reserve(user: String): (Boolean, Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val result = jedis
      .eval(ReserveLua, 1, limitsKey(user, window), LimitQuestions.toString, WindowSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2))
  }

  val route: Route =
    path("v1" / "ask") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[AskRequest]) { body =>
            val (ok, left, ttl) = reserve(user)
            if (!ok) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(
                    RawHeader("Retry-After", math.max(ttl, 1L).toString),
                    RawHeader("X-RateLimit-Remaining", left.toString)
                  ),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"too many questions"}""")
                )
              )
            } else {
              val qHash = sha256(body.question)
              if (jedis.exists(flaggedKey(qHash))) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"question is blocked"}""")
              } else {
                docs.get(body.document_id) match {
                  case None => complete(StatusCodes.NotFound, """{"error":"unknown document"}""")
                  case Some(document) =>
                    try {
                      val result = ModelCall.answer(document, body.question)
                      val session = sessionKey(user, body.document_id)
                      val tx = jedis.multi()
                      tx.rpush(session, qHash)
                      tx.ltrim(session, -SessionTurns, -1)
                      tx.expire(session, SessionTtlS)
                      tx.exec()
                      complete(StatusCodes.OK, s"""{"answer":"\${result.answer}","remaining":$left}""")
                    } catch {
                      case _: ModelCall.Rejected =>
                        jedis.setex(flaggedKey(qHash), FlagTtlS, "1")
                        complete(StatusCodes.UnprocessableEntity, """{"error":"refused"}""")
                    }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>
#include <tuple>

using json = nlohmann::json;

constexpr long long kLimitQuestions = 30;

struct DocumentStore {
  std::optional<std::string> get(const std::string& documentId);
};

struct Rejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

DocumentStore docs;

struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

ModelAnswer answer(const std::string& document, const std::string& question);
std::string sha256Hex(const std::string& text);

std::tuple<bool, long long> charge(sw::redis::Redis& redis, const std::string& documentId) {
  // TODO: key the limit by user and window, make the read-check-increment one atomic EVAL with
  // an EXPIRE on first write, give the block-list and the session a TTL, and reserve before the
  // model call instead of after it.
  const auto key = "limits:" + documentId;
  const auto raw = redis.get(key);
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used >= kLimitQuestions) return {false, 0};
  redis.incr(key);
  return {true, kLimitQuestions - used - 1};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/ask", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto documentId = body.value("document_id", std::string());
    const auto question = body.value("question", std::string());
    const auto document = docs.get(documentId);
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document"})", "application/json");
      return;
    }
    const auto qHash = sha256Hex(question);
    if (redis.get("flagged:" + qHash)) {
      res.status = 422;
      res.set_content(R"({"error":"question is blocked"})", "application/json");
      return;
    }
    ModelAnswer result;
    try {
      result = answer(*document, question);
    } catch (const Rejected&) {
      redis.set("flagged:" + qHash, "1");
      res.status = 422;
      res.set_content(R"({"error":"refused"})", "application/json");
      return;
    }
    const auto [ok, left] = charge(redis, documentId);
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", "60");
      res.set_header("X-RateLimit-Remaining", "0");
      res.set_content(R"({"error":"too many questions"})", "application/json");
      return;
    }
    redis.rpush("session:" + user + ":" + documentId, qHash);
    res.status = 200;
    res.set_content(json{{"answer", result.answer}, {"remaining", left}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kLimitQuestions = 30;
constexpr long long kFlagTtlS = 86400;
constexpr long long kSessionTtlS = 1800;
constexpr long long kSessionTurns = 20;

const char* kReserveLua = R"LUA(
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, tonumber(ARGV[1]) - used, redis.call('TTL', KEYS[1])}
)LUA";

struct DocumentStore {
  std::optional<std::string> get(const std::string& documentId);
};

struct Rejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

DocumentStore docs;

struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

ModelAnswer answer(const std::string& document, const std::string& question);
std::string sha256Hex(const std::string& text);

std::string limitsKey(const std::string& user, long long window) {
  return "limits:" + user + ":" + std::to_string(window);
}

std::string flaggedKey(const std::string& qHash) {
  return "flagged:" + qHash;
}

std::string sessionKey(const std::string& user, const std::string& documentId) {
  return "session:" + user + ":" + documentId;
}

std::tuple<bool, long long, long long> reserve(sw::redis::Redis& redis, const std::string& user) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const auto result = redis.eval<std::vector<long long>>(
      kReserveLua, {limitsKey(user, window)}, {kLimitQuestions, kWindowSeconds});
  return {result[0] == 1, result[1], result[2]};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/ask", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto documentId = body.value("document_id", std::string());
    const auto question = body.value("question", std::string());

    const auto [ok, left, ttl] = reserve(redis, user);
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max(ttl, 1LL)));
      res.set_header("X-RateLimit-Remaining", std::to_string(left));
      res.set_content(R"({"error":"too many questions"})", "application/json");
      return;
    }
    const auto qHash = sha256Hex(question);
    if (redis.exists(flaggedKey(qHash)) == 1) {
      res.status = 422;
      res.set_content(R"({"error":"question is blocked"})", "application/json");
      return;
    }
    const auto document = docs.get(documentId);
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document"})", "application/json");
      return;
    }
    ModelAnswer result;
    try {
      result = answer(*document, question);
    } catch (const Rejected&) {
      redis.set(flaggedKey(qHash), "1", std::chrono::seconds(kFlagTtlS));
      res.status = 422;
      res.set_content(R"({"error":"refused"})", "application/json");
      return;
    }
    const auto session = sessionKey(user, documentId);
    auto tx = redis.transaction();
    tx.rpush(session, qHash).ltrim(session, -kSessionTurns, -1).expire(session, std::chrono::seconds(kSessionTtlS)).exec();
    res.status = 200;
    res.set_content(json{{"answer", result.answer}, {"remaining", left}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is "what is the key, and when does it die?" A limit keyed by the wrong principal is not a limit: the source frames the attacks as coming from user-controlled input, so the user is the unit of accounting. Read-then-increment passes every serial test and fails exactly under the burst that a scripted attack produces; one Lua script makes read, compare, increment and the first-write expiry a single step, and the 429 is built from what the script returned. The three TTLs are the second half: the window must reset, the block-list must forget (a hash of a question is an attack signature today and a false positive tomorrow), and a session must end. Real services add a sliding window, a per-document budget on top of the per-user one, and a block-list keyed by a normalised hash so a trailing space does not make a new attack.`,
};
