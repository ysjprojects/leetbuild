import type {Step} from '@/lib/types';

// ---- 1. The chat endpoint: validate, limit, remember, cache, answer, record ----------------------
export const chatEndpointStep: Step = {
  id: 'chat-endpoint',
  title: 'POST /chat: limit, remember, cache, answer, record',
  concept: 'http',
  file: 'support_api',
  focus: ['dasher', 'api', 'redis', 'kafka'],
  task: `## Task

The Dasher app talks to one endpoint. Everything the rest of the course builds — retrieval
(\`kb_search\`), the model call and the guardrail (\`guardrail.answer_or_escalate\`) — sits behind it, and
the endpoint owns what a chat needs around a model: a memory of the conversation, a limit per
Dasher, a cache for questions already answered, and a record of every turn for the offline judge.

Implement \`support_api\` — a FastAPI / Fastify \`app\` with \`POST /chat\`, JSON
\`{"session_id", "dasher_id", "message"}\`:

- **Validate**: any of the three missing or empty → **400** \`{"error": "invalid_request"}\`, nothing
  touched.
- **Rate limit** per Dasher per minute: \`INCR rl:<dasher_id>:<unix-minute>\` then \`EXPIRE 60\`; past
  \`RATE_LIMIT_PER_MINUTE\` (20) in the current minute → **429** \`{"error": "rate_limited"}\`. A limited
  request answers nothing from the cache and writes nothing.
- **Memory**: the conversation is the Redis list \`conv:<session_id>\` of JSON turns
  \`{"role": "dasher" | "assistant", "text"}\`. Read it before answering — it is the \`history\` the
  guardrail passes to the model — and after answering \`RPUSH\` the Dasher's turn and the assistant's,
  then \`EXPIRE HISTORY_TTL_S\` (a day). \`turn\` is the 1-based count of Dasher turns in the session,
  this one included.
- **Cache**: \`kb_search.cached_answer(message)\` first. A hit answers
  \`{answer, sources, escalated: false, model: "cache", cached: true, turn}\` with **no search and no
  model call**; the exchange is still appended to the memory and recorded.
- **Answer**: \`chunks = kb_search.search(message)\` → \`guardrail.answer_or_escalate(message, chunks,
  history)\` → \`{answer, sources, escalated, model, tokens}\`; remember it with
  \`kb_search.remember_answer\` **unless it escalated** — a hand-off is never an answer to replay.
- **Record**: one record on \`TOPIC\` (\`support-conversations\`), key \`session_id\`, value JSON
  \`{session_id, turn, dasher_id, question, answer, sources, escalated, model, tokens}\` (\`tokens\` from
  the generate result; 0 for a cached or escalated turn). Hand it to the producer and answer — the
  request path never waits for the broker.
- Answer **200** \`{answer, sources, escalated, model, cached: false, turn}\`.

:::widget token-bucket {}

> The order matters: the cheap refusals (shape, limit) come before any read; the cache comes before
> retrieval and the model; the record is the last thing and the only one nobody waits for.`,
  sequence: {
    participants: ['Dasher app', 'assistant API', 'Redis', 'kb_search', 'guardrail', 'Kafka'],
    messages: [
      {
        from: 'Dasher app',
        to: 'assistant API',
        label: 'POST /chat {session_id: s1, dasher_id: d1, message: "forgot my password"}',
        kind: 'sync',
      },
      {from: 'assistant API', to: 'Redis', label: 'INCR rl:d1:29514210 · EXPIRE 60', kind: 'sync'},
      {from: 'Redis', to: 'assistant API', label: '3 (≤ 20)', kind: 'reply'},
      {from: 'assistant API', to: 'Redis', label: 'LRANGE conv:s1 0 -1 · GET answer:9c1e…', kind: 'sync'},
      {from: 'Redis', to: 'assistant API', label: '[dasher, assistant] · (nil)', kind: 'reply'},
      {from: 'assistant API', to: 'kb_search', label: 'search("forgot my password")', kind: 'sync'},
      {from: 'kb_search', to: 'assistant API', label: '[login-0, login-1, …]', kind: 'reply'},
      {from: 'assistant API', to: 'guardrail', label: 'answer_or_escalate(message, chunks, history)', kind: 'sync'},
      {
        from: 'guardrail',
        to: 'assistant API',
        label: '{answer, sources: [login-0, login-1], escalated: false, model: large, tokens: 31}',
        kind: 'reply',
      },
      {
        from: 'assistant API',
        to: 'Redis',
        label: 'RPUSH conv:s1 {dasher} {assistant} · EXPIRE 86400 · SET answer:9c1e… EX 3600',
        kind: 'sync',
      },
      {
        from: 'assistant API',
        to: 'Kafka',
        label: 'produce support-conversations key=s1 {turn: 2, …} (not awaited)',
        kind: 'async',
      },
      {
        from: 'assistant API',
        to: 'Dasher app',
        label: '200 {answer, sources, escalated: false, model: large, cached: false, turn: 2}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Write the handler as a straight line: validate → `allowed(dasher_id)` → load the history → `cached_answer` → (search → `answer_or_escalate` → `remember_answer` unless escalated) → append both turns → record → answer. Each step is a small helper; the handler only orders them.',
    'The limiter is one key per Dasher per minute: `f"rl:{dasher_id}:{int(time.time() // 60)}"`, `INCR` it, `EXPIRE` it 60 s, and refuse when the count is above `RATE_LIMIT_PER_MINUTE`. The history is `LRANGE conv:<session> 0 -1` parsed as JSON; `turn` is the number of entries whose role is `dasher`, plus one.',
    'Record with `producer.produce(TOPIC, key=session_id, value=json.dumps(record))` followed by `producer.poll(0)` — never `flush` on the request path; in TypeScript `producer.send({...})` without `await`, with a `.catch` that logs. A cached turn records `model: "cache"` and `tokens: 0`; an escalated one `escalated: true` and the hand-off text.',
  ],
  checks: [
    {
      id: 'validate',
      title: 'Rejects a malformed request with 400 and touches nothing',
      detail:
        'A body missing `session_id`, `dasher_id` or `message`, or with any of them empty, answers `400 {"error": "invalid_request"}`; Redis stays empty, the model is not called and nothing is recorded.',
      match: {
        python: {all: [/"invalid_request"/, /status_code=400/]},
        typescript: {all: [/'invalid_request'/, /code\(\s*400\s*\)/]},
        go: {all: [/"invalid_request"/, /http\.StatusBadRequest/]},
        scala: {all: [/"invalid_request"/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/"invalid_request"/, /\b400\b/]},
      },
    },
    {
      id: 'answer-and-history',
      title: 'Answers from the pipeline and remembers both turns',
      detail:
        'A question answers `200` with the guardrail’s answer, the chunk ids it cites as `sources`, `escalated: false`, `model: "large"`, `cached: false` and `turn: 1`; `conv:<session_id>` then holds the Dasher turn and the assistant turn as JSON with a TTL of `HISTORY_TTL_S`, and the next question in the session reaches the model with that exchange in its prompt and answers `turn: 2`.',
      match: {
        python: {all: [/\.lrange\(/, /\.rpush\(/, /\.expire\(\s*[^\n]*HISTORY_TTL_S/, /answer_or_escalate\(/]},
        typescript: {all: [/\.lrange\(/, /\.rpush\(/, /\.expire\(\s*[^\n]*HISTORY_TTL_S/, /answerOrEscalate\(/]},
        go: {all: [/\.LRange\(/, /\.RPush\(/, /\.Expire\(\s*[^\n]*config\.HistoryTTL/, /answerOrEscalate\(/]},
        scala: {
          all: [/\.lrange\(/, /\.rpush\(/, /\.expire\(\s*[^\n]*Config\.HistoryTtlS/, /Guardrail\.answerOrEscalate\(/],
        },
        cpp: {all: [/\.lrange\(/, /\.rpush\(/, /\.expire\(\s*[^\n]*config::kHistoryTtlS/, /answer_or_escalate\(/]},
      },
    },
    {
      id: 'answer-cache',
      title: 'Replays a remembered answer, never an escalation',
      detail:
        'The same question asked again — in different casing and spacing — answers `cached: true`, `model: "cache"`, the same answer and sources, with no new model call and no new search on `kb_chunks`, and still counts as a turn. A turn the guardrail escalated answers `200` with the hand-off text, `escalated: true`, `sources: []`, is not remembered (asking again calls the model again) and is still recorded.',
      match: {
        python: {all: [/cached_answer\(/, /remember_answer\(/, /"model": "cache"/, /if not \w+\["escalated"\]/]},
        typescript: {all: [/cachedAnswer\(/, /rememberAnswer\(/, /model: 'cache'/, /if \(!\w+\.escalated\)/]},
        go: {all: [/cachedAnswer\(/, /rememberAnswer\(/, /"cache"/, /if !\w+\.Escalated/]},
        scala: {all: [/KbSearch\.cachedAnswer\(/, /KbSearch\.rememberAnswer\(/, /"cache"/, /if \(!\w+\.escalated\)/]},
        cpp: {all: [/cached_answer\(/, /remember_answer\(/, /"cache"/, /if \(!escalated\)/]},
      },
    },
    {
      id: 'rate-limit',
      title: 'Limits each Dasher to RATE_LIMIT_PER_MINUTE a minute',
      detail:
        'The 21st request of a Dasher within one minute answers `429 {"error": "rate_limited"}` and leaves no trace; another Dasher is still answered; the first request of the next minute is answered again. The counter is `rl:<dasher_id>:<unix-minute>` with a TTL of at most 60 s.',
      match: {
        python: {
          all: [
            /f"rl:\{dasher_id\}:\{minute\}"/,
            /\.incr\(/,
            /\.expire\(\s*[^\n]*\b60\b/,
            /RATE_LIMIT_PER_MINUTE/,
            /"rate_limited"/,
          ],
        },
        typescript: {
          all: [
            /`rl:\$\{dasher_id\}:\$\{minute\}`/,
            /\.incr\(/,
            /\.expire\(\s*[^\n]*\b60\b/,
            /RATE_LIMIT_PER_MINUTE/,
            /'rate_limited'/,
          ],
        },
        go: {
          all: [
            /"rl:%s:%d"/,
            /\.Incr\(/,
            /\.Expire\(\s*[^\n]*60\s*\*\s*time\.Second/,
            /config\.RateLimitPerMinute/,
            /"rate_limited"/,
          ],
        },
        scala: {
          all: [
            /s"rl:\$dasherId:\$minute"/,
            /\.incr\(/,
            /\.expire\(\s*[^\n]*\b60\b/,
            /Config\.RateLimitPerMinute/,
            /"rate_limited"/,
          ],
        },
        cpp: {
          all: [
            /"rl:" \+ dasher_id \+ ":"/,
            /\.incr\(/,
            /\.expire\(\s*[^\n]*\b60\b/,
            /config::kRateLimitPerMinute/,
            /"rate_limited"/,
          ],
        },
      },
    },
    {
      id: 'recorded',
      title: 'Records every turn on the topic without waiting for the broker',
      detail:
        'Each answered turn — cached and escalated ones included — is one record on `support-conversations`, keyed by the session id, whose JSON value carries `session_id, turn, dasher_id, question, answer, sources, escalated, model, tokens`; `turn` counts up within a session. With the broker stalled the reply still arrives with no virtual time spent, and the record lands once the broker answers again.',
      match: {
        python: {
          all: [/producer\.produce\(\s*TOPIC\s*,[\s\S]{0,200}?key\s*=\s*session_id/, /producer\.poll\(\s*0\s*\)/],
          none: [/producer\.flush\(/],
        },
        typescript: {
          all: [/producer\s*\.send\(\s*\{[\s\S]{0,200}?topic:\s*TOPIC/, /key:\s*session_id/],
          none: [/await\s+producer\s*\.send\(/],
        },
        go: {all: [/go func\(\)[\s\S]{0,300}?writer\.WriteMessages\(/, /Key:\s*\[\]byte\(\s*sessionID\s*\)/]},
        scala: {
          all: [
            /producer\.send\(\s*new ProducerRecord(\[[^\]]*\])?\(\s*(Config\.Topic|"support-conversations")\s*,\s*sessionId\s*,/,
          ],
          none: [/\.send\([^\n]*\)\.get\(/],
        },
        cpp: {
          all: [
            /producer->produce\(\s*(config::kTopic|"support-conversations")\s*,[\s\S]{0,400}?session_id\.c_str\(\)/,
            /producer->poll\(\s*0\s*\)/,
          ],
          none: [/producer->flush\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn."""
import json
import logging
import time

import redis
from confluent_kafka import Producer
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import guardrail
import kb_search
from assistant.config import HISTORY_TTL_S, RATE_LIMIT_PER_MINUTE, TOPIC

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 20})
log = logging.getLogger("support_api")

FIELDS = ("session_id", "dasher_id", "message")


def validate(body) -> dict | None:
    """The request's three strings, or None when any is missing or empty."""
    # TODO: body is a dict and each of FIELDS is a non-empty string
    raise NotImplementedError


def allowed(dasher_id: str) -> bool:
    """One INCR on this minute's counter for the Dasher; the key expires on its own."""
    # TODO: rl:<dasher_id>:<unix-minute> → INCR, EXPIRE 60, count <= RATE_LIMIT_PER_MINUTE
    raise NotImplementedError


def load_history(session_id: str) -> list[dict]:
    """The session's turns, oldest first: [{role, text}]."""
    # TODO: LRANGE conv:<session_id> 0 -1, each entry JSON
    raise NotImplementedError


def remember_turns(session_id: str, question: str, answer: str) -> None:
    """Append the Dasher's turn and the assistant's; the conversation lives HISTORY_TTL_S."""
    # TODO: RPUSH both JSON turns, EXPIRE HISTORY_TTL_S
    raise NotImplementedError


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("turn not recorded: %s", err)


def record_turn(record: dict) -> None:
    """One record on TOPIC keyed by the session; the caller never waits for the broker."""
    # TODO: produce (key = session_id, value = the JSON record), poll(0) to serve delivery reports
    raise NotImplementedError


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    # TODO: validate → 400 invalid_request; allowed → 429 rate_limited
    # TODO: history and turn; cached_answer → model "cache", tokens 0, cached True
    # TODO: else search → answer_or_escalate → remember_answer unless escalated
    # TODO: remember_turns, record_turn, 200 {answer, sources, escalated, model, cached, turn}
    return JSONResponse(status_code=501, content={"error": "not_implemented"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8443)
`,
      solution: `"""POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn."""
import json
import logging
import time

import redis
from confluent_kafka import Producer
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import guardrail
import kb_search
from assistant.config import HISTORY_TTL_S, RATE_LIMIT_PER_MINUTE, TOPIC

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 20})
log = logging.getLogger("support_api")

FIELDS = ("session_id", "dasher_id", "message")


def validate(body) -> dict | None:
    """The request's three strings, or None when any is missing or empty."""
    if not isinstance(body, dict):
        return None
    if any(not isinstance(body.get(f), str) or not body[f].strip() for f in FIELDS):
        return None
    return {f: body[f] for f in FIELDS}


def allowed(dasher_id: str) -> bool:
    """One INCR on this minute's counter for the Dasher; the key expires on its own."""
    minute = int(time.time() // 60)
    key = f"rl:{dasher_id}:{minute}"
    count = r.incr(key)
    r.expire(key, 60)
    return count <= RATE_LIMIT_PER_MINUTE


def load_history(session_id: str) -> list[dict]:
    """The session's turns, oldest first: [{role, text}]."""
    return [json.loads(raw) for raw in r.lrange(f"conv:{session_id}", 0, -1)]


def remember_turns(session_id: str, question: str, answer: str) -> None:
    """Append the Dasher's turn and the assistant's; the conversation lives HISTORY_TTL_S."""
    key = f"conv:{session_id}"
    pipe = r.pipeline()
    pipe.rpush(key, json.dumps({"role": "dasher", "text": question}), json.dumps({"role": "assistant", "text": answer}))
    pipe.expire(key, HISTORY_TTL_S)
    pipe.execute()


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("turn not recorded: %s", err)


def record_turn(record: dict) -> None:
    """One record on TOPIC keyed by the session; the caller never waits for the broker."""
    session_id = record["session_id"]
    producer.produce(TOPIC, key=session_id, value=json.dumps(record), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports; a flush here would make every reply wait for the broker


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = None
    req = validate(body)
    if req is None:
        return JSONResponse(status_code=400, content={"error": "invalid_request"})
    session_id, dasher_id, message = req["session_id"], req["dasher_id"], req["message"]
    if not allowed(dasher_id):
        return JSONResponse(status_code=429, content={"error": "rate_limited"})
    history = load_history(session_id)
    turn = sum(1 for t in history if t.get("role") == "dasher") + 1
    hit = await kb_search.cached_answer(message)
    if hit is not None:
        outcome = {"answer": hit["answer"], "sources": hit["sources"], "escalated": False, "model": "cache", "tokens": 0}
        cached = True
    else:
        chunks = await kb_search.search(message)
        outcome = await guardrail.answer_or_escalate(message, chunks, history)
        cached = False
        if not outcome["escalated"]:
            await kb_search.remember_answer(message, outcome["answer"], outcome["sources"])
    remember_turns(session_id, message, outcome["answer"])
    record_turn({
        "session_id": session_id,
        "turn": turn,
        "dasher_id": dasher_id,
        "question": message,
        "answer": outcome["answer"],
        "sources": outcome["sources"],
        "escalated": outcome["escalated"],
        "model": outcome["model"],
        "tokens": outcome.get("tokens", 0),
    })
    return JSONResponse(content={
        "answer": outcome["answer"],
        "sources": outcome["sources"],
        "escalated": outcome["escalated"],
        "model": outcome["model"],
        "cached": cached,
        "turn": turn,
    })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8443)
`,
    },
    typescript: {
      starter: `/** POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn. */
import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {HISTORY_TTL_S, RATE_LIMIT_PER_MINUTE, TOPIC} from 'assistant/config';
import type {Turn} from 'assistant/prompt';

import {answerOrEscalate} from './guardrail';
import {cachedAnswer, rememberAnswer, search} from './kb_search';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'support-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export interface ChatRequest {
  session_id: string;
  dasher_id: string;
  message: string;
}

/** One record of support-conversations: an answered (cached, escalated) turn of a session. */
export interface TurnRecord {
  session_id: string;
  turn: number;
  dasher_id: string;
  question: string;
  answer: string;
  sources: string[];
  escalated: boolean;
  model: string;
  tokens: number;
}

const FIELDS = ['session_id', 'dasher_id', 'message'] as const;

/** The request's three strings, or null when any is missing or empty. */
export function validate(body: unknown): ChatRequest | null {
  // TODO: body is an object and each of FIELDS is a non-empty string
  throw new Error('not implemented');
}

/** One INCR on this minute's counter for the Dasher; the key expires on its own. */
export async function allowed(dasher_id: string): Promise<boolean> {
  // TODO: rl:<dasher_id>:<unix-minute> → INCR, EXPIRE 60, count <= RATE_LIMIT_PER_MINUTE
  throw new Error('not implemented');
}

/** The session's turns, oldest first. */
export async function loadHistory(session_id: string): Promise<Turn[]> {
  // TODO: LRANGE conv:<session_id> 0 -1, each entry JSON
  throw new Error('not implemented');
}

/** Append the Dasher's turn and the assistant's; the conversation lives HISTORY_TTL_S. */
export async function rememberTurns(session_id: string, question: string, answer: string): Promise<void> {
  // TODO: RPUSH both JSON turns, EXPIRE HISTORY_TTL_S
  throw new Error('not implemented');
}

/** One record on TOPIC keyed by the session; the caller never waits for the broker. */
export function recordTurn(record: TurnRecord): void {
  // TODO: send (key = session_id, value = the JSON record) without awaiting; log a failed delivery
  throw new Error('not implemented');
}

app.post('/chat', async (request, reply) => {
  // TODO: validate → 400 invalid_request; allowed → 429 rate_limited
  // TODO: history and turn; cachedAnswer → model 'cache', tokens 0, cached true
  // TODO: else search → answerOrEscalate → rememberAnswer unless escalated
  // TODO: rememberTurns, recordTurn, 200 {answer, sources, escalated, model, cached, turn}
  return reply.code(501).send({error: 'not_implemented'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn. */
import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {HISTORY_TTL_S, RATE_LIMIT_PER_MINUTE, TOPIC} from 'assistant/config';
import type {Turn} from 'assistant/prompt';

import {answerOrEscalate} from './guardrail';
import {cachedAnswer, rememberAnswer, search} from './kb_search';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'support-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export interface ChatRequest {
  session_id: string;
  dasher_id: string;
  message: string;
}

/** One record of support-conversations: an answered (cached, escalated) turn of a session. */
export interface TurnRecord {
  session_id: string;
  turn: number;
  dasher_id: string;
  question: string;
  answer: string;
  sources: string[];
  escalated: boolean;
  model: string;
  tokens: number;
}

const FIELDS = ['session_id', 'dasher_id', 'message'] as const;

/** The request's three strings, or null when any is missing or empty. */
export function validate(body: unknown): ChatRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  for (const f of FIELDS) {
    const value = fields[f];
    if (typeof value !== 'string' || value.trim() === '') return null;
  }
  const {session_id, dasher_id, message} = fields as Record<(typeof FIELDS)[number], string>;
  return {session_id, dasher_id, message};
}

/** One INCR on this minute's counter for the Dasher; the key expires on its own. */
export async function allowed(dasher_id: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = \`rl:\${dasher_id}:\${minute}\`;
  const count = await redis.incr(key);
  await redis.expire(key, 60);
  return count <= RATE_LIMIT_PER_MINUTE;
}

/** The session's turns, oldest first. */
export async function loadHistory(session_id: string): Promise<Turn[]> {
  const raw = await redis.lrange(\`conv:\${session_id}\`, 0, -1);
  return raw.map(entry => JSON.parse(entry) as Turn);
}

/** Append the Dasher's turn and the assistant's; the conversation lives HISTORY_TTL_S. */
export async function rememberTurns(session_id: string, question: string, answer: string): Promise<void> {
  const key = \`conv:\${session_id}\`;
  await redis
    .multi()
    .rpush(key, JSON.stringify({role: 'dasher', text: question}), JSON.stringify({role: 'assistant', text: answer}))
    .expire(key, HISTORY_TTL_S)
    .exec();
}

/** One record on TOPIC keyed by the session; the caller never waits for the broker. */
export function recordTurn(record: TurnRecord): void {
  const {session_id} = record;
  producer
    .send({topic: TOPIC, messages: [{key: session_id, value: JSON.stringify(record)}], acks: 1})
    .catch((err: Error) => console.warn(\`turn not recorded: \${err.message}\`));
}

app.post('/chat', async (request, reply) => {
  const req = validate(request.body);
  if (req === null) return reply.code(400).send({error: 'invalid_request'});
  const {session_id, dasher_id, message} = req;
  if (!(await allowed(dasher_id))) return reply.code(429).send({error: 'rate_limited'});
  const history = await loadHistory(session_id);
  const turn = history.filter(t => t.role === 'dasher').length + 1;
  const hit = await cachedAnswer(message);
  let outcome: {answer: string; sources: string[]; escalated: boolean; model: string; tokens: number};
  let cached: boolean;
  if (hit !== null) {
    outcome = {answer: hit.answer, sources: hit.sources, escalated: false, model: 'cache', tokens: 0};
    cached = true;
  } else {
    const chunks = await search(message);
    const result = await answerOrEscalate(message, chunks, history);
    outcome = {...result, tokens: result.tokens ?? 0};
    cached = false;
    if (!outcome.escalated) await rememberAnswer(message, outcome.answer, outcome.sources);
  }
  await rememberTurns(session_id, message, outcome.answer);
  recordTurn({
    session_id,
    turn,
    dasher_id,
    question: message,
    answer: outcome.answer,
    sources: outcome.sources,
    escalated: outcome.escalated,
    model: outcome.model,
    tokens: outcome.tokens,
  });
  return {answer: outcome.answer, sources: outcome.sources, escalated: outcome.escalated, model: outcome.model, cached, turn};
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"assistant/config" // config.Topic, config.HistoryTTL (seconds), config.RateLimitPerMinute
	"assistant/prompt" // prompt.Turn{Role, Text}, prompt.Chunk{ID, Text, Score}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: config.Topic, RequiredAcks: kafka.RequireOne}

// Built in the later steps of the course; provided here.
var (
	// cachedAnswer is the {answer, sources} remembered for this question, or nil (kb_search, step 2).
	cachedAnswer = func(ctx context.Context, question string) (*CachedAnswer, error) { panic("not implemented") }
	// rememberAnswer caches an answer for the question (kb_search, step 2).
	rememberAnswer = func(ctx context.Context, question, answer string, sources []string) error { panic("not implemented") }
	// search returns the k chunks nearest to the question, best first (kb_search, step 2).
	search = func(ctx context.Context, question string, k int) ([]prompt.Chunk, error) { panic("not implemented") }
	// answerOrEscalate is the model's answer once the guardrail passed it, or the handoff (guardrail, step 4).
	answerOrEscalate = func(ctx context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (Outcome, error) {
		panic("not implemented")
	}
)

// CachedAnswer is what kb_search remembers for a question.
type CachedAnswer struct {
	Answer  string   \`json:"answer"\`
	Sources []string \`json:"sources"\`
}

// Outcome is what the guardrail lets the Dasher see: the answer or the handoff.
type Outcome struct {
	Answer    string
	Sources   []string
	Escalated bool
	Model     string
	Tokens    int32
}

type ChatRequest struct {
	SessionID string \`json:"session_id"\`
	DasherID  string \`json:"dasher_id"\`
	Message   string \`json:"message"\`
}

type ChatReply struct {
	Answer    string   \`json:"answer"\`
	Sources   []string \`json:"sources"\`
	Escalated bool     \`json:"escalated"\`
	Model     string   \`json:"model"\`
	Cached    bool     \`json:"cached"\`
	Turn      int      \`json:"turn"\`
}

// TurnRecord is one record of support-conversations: an answered (cached, escalated) turn of a session.
type TurnRecord struct {
	SessionID string   \`json:"session_id"\`
	Turn      int      \`json:"turn"\`
	DasherID  string   \`json:"dasher_id"\`
	Question  string   \`json:"question"\`
	Answer    string   \`json:"answer"\`
	Sources   []string \`json:"sources"\`
	Escalated bool     \`json:"escalated"\`
	Model     string   \`json:"model"\`
	Tokens    int      \`json:"tokens"\`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// validate reports whether each of the three strings is present and non-empty.
func validate(req ChatRequest) bool {
	// TODO: session_id, dasher_id, message non-empty after trimming
	return false
}

// allowed does one INCR on this minute's counter for the Dasher; the key expires on its own.
func allowed(ctx context.Context, dasherID string) (bool, error) {
	// TODO: rl:<dasher_id>:<unix-minute> → INCR, EXPIRE 60 s, count <= config.RateLimitPerMinute
	return false, nil
}

// loadHistory is the session's turns, oldest first.
func loadHistory(ctx context.Context, sessionID string) ([]prompt.Turn, error) {
	// TODO: LRANGE conv:<session_id> 0 -1, each entry JSON
	return nil, nil
}

// rememberTurns appends the Dasher's turn and the assistant's; the conversation lives config.HistoryTTL.
func rememberTurns(ctx context.Context, sessionID, question, answer string) error {
	// TODO: RPUSH both JSON turns, EXPIRE config.HistoryTTL
	return nil
}

// recordTurn hands one record keyed by the session to the writer; the caller never waits for the broker.
func recordTurn(record TurnRecord) {
	// TODO: WriteMessages in a goroutine with Key = session id, Value = the JSON record; log a failed write
}

func chat(w http.ResponseWriter, r *http.Request) {
	// TODO: decode → validate → 400 invalid_request; allowed → 429 rate_limited
	// TODO: history and turn; cachedAnswer → model "cache", tokens 0, Cached true
	// TODO: else search → answerOrEscalate → rememberAnswer unless escalated
	// TODO: rememberTurns, recordTurn, 200 ChatReply
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "not_implemented"})
}

func main() {
	http.HandleFunc("POST /chat", chat)
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
      solution: `// POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"assistant/config" // config.Topic, config.HistoryTTL (seconds), config.RateLimitPerMinute
	"assistant/prompt" // prompt.Turn{Role, Text}, prompt.Chunk{ID, Text, Score}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: config.Topic, RequiredAcks: kafka.RequireOne}

// Built in the later steps of the course; provided here.
var (
	// cachedAnswer is the {answer, sources} remembered for this question, or nil (kb_search, step 2).
	cachedAnswer = func(ctx context.Context, question string) (*CachedAnswer, error) { panic("not implemented") }
	// rememberAnswer caches an answer for the question (kb_search, step 2).
	rememberAnswer = func(ctx context.Context, question, answer string, sources []string) error { panic("not implemented") }
	// search returns the k chunks nearest to the question, best first (kb_search, step 2).
	search = func(ctx context.Context, question string, k int) ([]prompt.Chunk, error) { panic("not implemented") }
	// answerOrEscalate is the model's answer once the guardrail passed it, or the handoff (guardrail, step 4).
	answerOrEscalate = func(ctx context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (Outcome, error) {
		panic("not implemented")
	}
)

// CachedAnswer is what kb_search remembers for a question.
type CachedAnswer struct {
	Answer  string   \`json:"answer"\`
	Sources []string \`json:"sources"\`
}

// Outcome is what the guardrail lets the Dasher see: the answer or the handoff.
type Outcome struct {
	Answer    string
	Sources   []string
	Escalated bool
	Model     string
	Tokens    int32
}

type ChatRequest struct {
	SessionID string \`json:"session_id"\`
	DasherID  string \`json:"dasher_id"\`
	Message   string \`json:"message"\`
}

type ChatReply struct {
	Answer    string   \`json:"answer"\`
	Sources   []string \`json:"sources"\`
	Escalated bool     \`json:"escalated"\`
	Model     string   \`json:"model"\`
	Cached    bool     \`json:"cached"\`
	Turn      int      \`json:"turn"\`
}

// TurnRecord is one record of support-conversations: an answered (cached, escalated) turn of a session.
type TurnRecord struct {
	SessionID string   \`json:"session_id"\`
	Turn      int      \`json:"turn"\`
	DasherID  string   \`json:"dasher_id"\`
	Question  string   \`json:"question"\`
	Answer    string   \`json:"answer"\`
	Sources   []string \`json:"sources"\`
	Escalated bool     \`json:"escalated"\`
	Model     string   \`json:"model"\`
	Tokens    int      \`json:"tokens"\`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// validate reports whether each of the three strings is present and non-empty.
func validate(req ChatRequest) bool {
	return strings.TrimSpace(req.SessionID) != "" && strings.TrimSpace(req.DasherID) != "" && strings.TrimSpace(req.Message) != ""
}

// allowed does one INCR on this minute's counter for the Dasher; the key expires on its own.
func allowed(ctx context.Context, dasherID string) (bool, error) {
	minute := time.Now().Unix() / 60
	key := fmt.Sprintf("rl:%s:%d", dasherID, minute)
	count, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return false, err
	}
	if err := rdb.Expire(ctx, key, 60*time.Second).Err(); err != nil {
		return false, err
	}
	return count <= int64(config.RateLimitPerMinute), nil
}

// loadHistory is the session's turns, oldest first.
func loadHistory(ctx context.Context, sessionID string) ([]prompt.Turn, error) {
	raw, err := rdb.LRange(ctx, "conv:"+sessionID, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	turns := make([]prompt.Turn, 0, len(raw))
	for _, entry := range raw {
		var t prompt.Turn
		if err := json.Unmarshal([]byte(entry), &t); err != nil {
			return nil, err
		}
		turns = append(turns, t)
	}
	return turns, nil
}

// rememberTurns appends the Dasher's turn and the assistant's; the conversation lives config.HistoryTTL.
func rememberTurns(ctx context.Context, sessionID, question, answer string) error {
	key := "conv:" + sessionID
	dasher, _ := json.Marshal(prompt.Turn{Role: "dasher", Text: question})
	assistant, _ := json.Marshal(prompt.Turn{Role: "assistant", Text: answer})
	pipe := rdb.TxPipeline()
	pipe.RPush(ctx, key, dasher, assistant)
	pipe.Expire(ctx, key, time.Duration(config.HistoryTTL)*time.Second)
	_, err := pipe.Exec(ctx)
	return err
}

// recordTurn hands one record keyed by the session to the writer; the caller never waits for the broker.
func recordTurn(record TurnRecord) {
	sessionID := record.SessionID
	value, _ := json.Marshal(record)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(sessionID), Value: value}); err != nil {
			log.Printf("turn not recorded: %v", err)
		}
	}()
}

func chat(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validate(req) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	ok, err := allowed(ctx, req.DasherID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "redis"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"})
		return
	}
	history, err := loadHistory(ctx, req.SessionID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "redis"})
		return
	}
	turn := 1
	for _, t := range history {
		if t.Role == "dasher" {
			turn++
		}
	}
	reply := ChatReply{Turn: turn}
	tokens := 0
	hit, err := cachedAnswer(ctx, req.Message)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "redis"})
		return
	}
	if hit != nil {
		reply.Answer, reply.Sources, reply.Model, reply.Cached = hit.Answer, hit.Sources, "cache", true
	} else {
		chunks, err := search(ctx, req.Message, config.TopK)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "search"})
			return
		}
		outcome, err := answerOrEscalate(ctx, req.Message, chunks, history)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "model_unavailable"})
			return
		}
		reply.Answer, reply.Sources, reply.Escalated, reply.Model = outcome.Answer, outcome.Sources, outcome.Escalated, outcome.Model
		tokens = int(outcome.Tokens)
		if !outcome.Escalated {
			if err := rememberAnswer(ctx, req.Message, outcome.Answer, outcome.Sources); err != nil {
				log.Printf("answer not cached: %v", err)
			}
		}
	}
	if err := rememberTurns(ctx, req.SessionID, req.Message, reply.Answer); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "redis"})
		return
	}
	recordTurn(TurnRecord{
		SessionID: req.SessionID, Turn: turn, DasherID: req.DasherID, Question: req.Message,
		Answer: reply.Answer, Sources: reply.Sources, Escalated: reply.Escalated, Model: reply.Model, Tokens: tokens,
	})
	writeJSON(w, http.StatusOK, reply)
}

func main() {
	http.HandleFunc("POST /chat", chat)
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
    },
    scala: {
      starter: `/** POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn. */
import java.util.Properties

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import assistant.Config // Config.Topic, Config.HistoryTtlS, Config.RateLimitPerMinute
import assistant.Prompt.Turn // Turn(role, text)

final case class ChatRequest(sessionId: String, dasherId: String, message: String)
/** One record of support-conversations: an answered (cached, escalated) turn of a session. */
final case class TurnRecord(sessionId: String, turn: Int, dasherId: String, question: String, answer: String,
                            sources: Seq[String], escalated: Boolean, model: String, tokens: Int)

object SupportApi {
  implicit val system: ActorSystem = ActorSystem("support-api")
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def json(status: StatusCodes.ClientError, error: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject("error" -> JsString(error)).compactPrint))

  /** The request's three strings, or None when any is missing or empty. */
  def validate(body: JsValue): Option[ChatRequest] =
    // TODO: an object whose session_id, dasher_id and message are non-empty strings
    ???

  /** One INCR on this minute's counter for the Dasher; the key expires on its own. */
  def allowed(dasherId: String): Boolean =
    // TODO: rl:<dasher_id>:<unix-minute> → INCR, EXPIRE 60, count <= Config.RateLimitPerMinute
    ???

  /** The session's turns, oldest first. */
  def loadHistory(sessionId: String): Seq[Turn] =
    // TODO: LRANGE conv:<session_id> 0 -1, each entry JSON
    ???

  /** Append the Dasher's turn and the assistant's; the conversation lives Config.HistoryTtlS. */
  def rememberTurns(sessionId: String, question: String, answer: String): Unit =
    // TODO: RPUSH both JSON turns, EXPIRE Config.HistoryTtlS
    ???

  private val onDelivery: Callback = new Callback {
    def onCompletion(meta: RecordMetadata, err: Exception): Unit =
      if (err != null) system.log.warning(s"turn not recorded: \${err.getMessage}")
  }

  /** One record on Config.Topic keyed by the session; the caller never waits for the broker. */
  def recordTurn(record: TurnRecord): Unit =
    // TODO: producer.send(new ProducerRecord(Config.Topic, sessionId, json), onDelivery) — the future is not awaited
    ???

  val route = path("chat") {
    post {
      entity(as[String]) { raw =>
        // TODO: validate → 400 invalid_request; allowed → 429 rate_limited
        // TODO: history and turn; KbSearch.cachedAnswer → model "cache", tokens 0, cached = true
        // TODO: else KbSearch.search → Guardrail.answerOrEscalate → KbSearch.rememberAnswer unless escalated
        // TODO: rememberTurns, recordTurn, 200 {answer, sources, escalated, model, cached, turn}
        complete(HttpResponse(StatusCodes.NotImplemented))
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
      solution: `/** POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn. */
import java.util.Properties

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import assistant.Config // Config.Topic, Config.HistoryTtlS, Config.RateLimitPerMinute
import assistant.Prompt.Turn // Turn(role, text)

final case class ChatRequest(sessionId: String, dasherId: String, message: String)
/** One record of support-conversations: an answered (cached, escalated) turn of a session. */
final case class TurnRecord(sessionId: String, turn: Int, dasherId: String, question: String, answer: String,
                            sources: Seq[String], escalated: Boolean, model: String, tokens: Int)

object SupportApi {
  implicit val system: ActorSystem = ActorSystem("support-api")
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def json(status: StatusCodes.ClientError, error: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject("error" -> JsString(error)).compactPrint))

  /** The request's three strings, or None when any is missing or empty. */
  def validate(body: JsValue): Option[ChatRequest] = body match {
    case JsObject(f) =>
      def str(name: String): Option[String] = f.get(name).collect { case JsString(s) if s.trim.nonEmpty => s }
      for (s <- str("session_id"); d <- str("dasher_id"); m <- str("message")) yield ChatRequest(s, d, m)
    case _ => None
  }

  /** One INCR on this minute's counter for the Dasher; the key expires on its own. */
  def allowed(dasherId: String): Boolean = {
    val minute = System.currentTimeMillis() / 60000L
    val key = s"rl:$dasherId:$minute"
    val count = jedis.incr(key)
    jedis.expire(key, 60)
    count <= Config.RateLimitPerMinute
  }

  private def turnJson(t: Turn): String = JsObject("role" -> JsString(t.role), "text" -> JsString(t.text)).compactPrint

  /** The session's turns, oldest first. */
  def loadHistory(sessionId: String): Seq[Turn] = {
    import scala.jdk.CollectionConverters._
    jedis.lrange(s"conv:$sessionId", 0, -1).asScala.toSeq.map { raw =>
      val f = raw.parseJson.asJsObject.fields
      Turn(f("role").convertTo[String], f("text").convertTo[String])
    }
  }

  /** Append the Dasher's turn and the assistant's; the conversation lives Config.HistoryTtlS. */
  def rememberTurns(sessionId: String, question: String, answer: String): Unit = {
    val key = s"conv:$sessionId"
    val tx = jedis.multi()
    tx.rpush(key, turnJson(Turn("dasher", question)), turnJson(Turn("assistant", answer)))
    tx.expire(key, Config.HistoryTtlS)
    tx.exec()
  }

  private val onDelivery: Callback = new Callback {
    def onCompletion(meta: RecordMetadata, err: Exception): Unit =
      if (err != null) system.log.warning(s"turn not recorded: \${err.getMessage}")
  }

  private def recordJson(r: TurnRecord): String = JsObject(
    "session_id" -> JsString(r.sessionId), "turn" -> JsNumber(r.turn), "dasher_id" -> JsString(r.dasherId),
    "question" -> JsString(r.question), "answer" -> JsString(r.answer), "sources" -> JsArray(r.sources.map(JsString(_)).toVector),
    "escalated" -> JsBoolean(r.escalated), "model" -> JsString(r.model), "tokens" -> JsNumber(r.tokens)).compactPrint

  /** One record on Config.Topic keyed by the session; the caller never waits for the broker. */
  def recordTurn(record: TurnRecord): Unit = {
    val sessionId = record.sessionId
    producer.send(new ProducerRecord[String, String](Config.Topic, sessionId, recordJson(record)), onDelivery) // not awaited
  }

  val route = path("chat") {
    post {
      entity(as[String]) { raw =>
        val parsed = try validate(raw.parseJson) catch { case _: Exception => None }
        parsed match {
          case None => complete(json(StatusCodes.BadRequest, "invalid_request"))
          case Some(req) if !allowed(req.dasherId) => complete(json(StatusCodes.TooManyRequests, "rate_limited"))
          case Some(req) =>
            val history = loadHistory(req.sessionId)
            val turn = history.count(_.role == "dasher") + 1
            val (answer, sources, escalated, model, tokens, cached) = KbSearch.cachedAnswer(req.message) match {
              case Some(hit) => (hit.answer, hit.sources, false, "cache", 0, true)
              case None =>
                val chunks = KbSearch.search(req.message)
                val out = Guardrail.answerOrEscalate(req.message, chunks, history)
                if (!out.escalated) KbSearch.rememberAnswer(req.message, out.answer, out.sources)
                (out.answer, out.sources, out.escalated, out.model, out.tokens, false)
            }
            rememberTurns(req.sessionId, req.message, answer)
            recordTurn(TurnRecord(req.sessionId, turn, req.dasherId, req.message, answer, sources, escalated, model, tokens))
            val body = JsObject(
              "answer" -> JsString(answer), "sources" -> JsArray(sources.map(JsString(_)).toVector), "escalated" -> JsBoolean(escalated),
              "model" -> JsString(model), "cached" -> JsBoolean(cached), "turn" -> JsNumber(turn)).compactPrint
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body)))
        }
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
    },
    cpp: {
      starter: `// POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn.
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "assistant/config.h"  // config::kTopic, config::kHistoryTtlS, config::kRateLimitPerMinute
#include "assistant/prompt.h"  // prompt::Turn{role, text}
#include "guardrail.h"         // Outcome answer_or_escalate(question, chunks, history): {answer, sources, escalated, model, tokens}
#include "kb_search.h"         // std::vector<Hit> search(question); std::optional<CachedAnswer> cached_answer(q); remember_answer(q, a, sources)

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

struct ChatRequest {
  std::string session_id, dasher_id, message;
};

// One record of support-conversations: an answered (cached, escalated) turn of a session.
struct TurnRecord {
  std::string session_id;
  int turn;
  std::string dasher_id, question, answer;
  std::vector<std::string> sources;
  bool escalated;
  std::string model;
  int tokens;
};

class OnDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& msg) override {
    if (msg.err() != RdKafka::ERR_NO_ERROR) std::cerr << "turn not recorded: " << msg.errstr() << "\\n";
  }
};
OnDelivery delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}
auto producer = make_producer();

void answer_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The request's three strings, or nullopt when any is missing or empty.
std::optional<ChatRequest> validate(const json& body) {
  // TODO: an object whose session_id, dasher_id and message are non-empty strings
  return std::nullopt;
}

// One INCR on this minute's counter for the Dasher; the key expires on its own.
bool allowed(const std::string& dasher_id) {
  // TODO: rl:<dasher_id>:<unix-minute> → INCR, EXPIRE 60, count <= config::kRateLimitPerMinute
  return false;
}

// The session's turns, oldest first.
std::vector<prompt::Turn> load_history(const std::string& session_id) {
  // TODO: LRANGE conv:<session_id> 0 -1, each entry JSON
  return {};
}

// Append the Dasher's turn and the assistant's; the conversation lives config::kHistoryTtlS.
void remember_turns(const std::string& session_id, const std::string& question, const std::string& answer) {
  // TODO: RPUSH both JSON turns, EXPIRE config::kHistoryTtlS
}

// One record on config::kTopic keyed by the session; the caller never waits for the broker.
void record_turn(const TurnRecord& record) {
  // TODO: produce (key = session_id, value = the JSON record), poll(0) to serve delivery reports
}

int main() {
  httplib::Server app;
  app.Post("/chat", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: parse → validate → 400 invalid_request; allowed → 429 rate_limited
    // TODO: history and turn; cached_answer → model "cache", tokens 0, cached true
    // TODO: else search → answer_or_escalate → remember_answer unless escalated
    // TODO: remember_turns, record_turn, 200 {answer, sources, escalated, model, cached, turn}
    answer_json(res, 501, {{"error", "not_implemented"}});
  });
  app.listen("0.0.0.0", 8443);
}
`,
      solution: `// POST /chat: the Dasher's question in, a grounded answer out — limited per Dasher, remembered per session, cached per question, recorded per turn.
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "assistant/config.h"  // config::kTopic, config::kHistoryTtlS, config::kRateLimitPerMinute
#include "assistant/prompt.h"  // prompt::Turn{role, text}
#include "guardrail.h"         // Outcome answer_or_escalate(question, chunks, history): {answer, sources, escalated, model, tokens}
#include "kb_search.h"         // std::vector<Hit> search(question); std::optional<CachedAnswer> cached_answer(q); remember_answer(q, a, sources)

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

struct ChatRequest {
  std::string session_id, dasher_id, message;
};

// One record of support-conversations: an answered (cached, escalated) turn of a session.
struct TurnRecord {
  std::string session_id;
  int turn;
  std::string dasher_id, question, answer;
  std::vector<std::string> sources;
  bool escalated;
  std::string model;
  int tokens;
};

class OnDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& msg) override {
    if (msg.err() != RdKafka::ERR_NO_ERROR) std::cerr << "turn not recorded: " << msg.errstr() << "\\n";
  }
};
OnDelivery delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}
auto producer = make_producer();

void answer_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

static bool non_empty_string(const json& body, const char* field) {
  return body.contains(field) && body[field].is_string() && !body[field].get<std::string>().empty();
}

// The request's three strings, or nullopt when any is missing or empty.
std::optional<ChatRequest> validate(const json& body) {
  if (!body.is_object()) return std::nullopt;
  for (const char* f : {"session_id", "dasher_id", "message"})
    if (!non_empty_string(body, f)) return std::nullopt;
  return ChatRequest{body["session_id"], body["dasher_id"], body["message"]};
}

// One INCR on this minute's counter for the Dasher; the key expires on its own.
bool allowed(const std::string& dasher_id) {
  const long long minute = std::chrono::duration_cast<std::chrono::minutes>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = "rl:" + dasher_id + ":" + std::to_string(minute);
  const long long count = redis.incr(key);
  redis.expire(key, 60);
  return count <= config::kRateLimitPerMinute;
}

// The session's turns, oldest first.
std::vector<prompt::Turn> load_history(const std::string& session_id) {
  std::vector<std::string> raw;
  redis.lrange("conv:" + session_id, 0, -1, std::back_inserter(raw));
  std::vector<prompt::Turn> turns;
  for (const auto& entry : raw) {
    const json j = json::parse(entry);
    turns.push_back(prompt::Turn{j["role"].get<std::string>(), j["text"].get<std::string>()});
  }
  return turns;
}

// Append the Dasher's turn and the assistant's; the conversation lives config::kHistoryTtlS.
void remember_turns(const std::string& session_id, const std::string& question, const std::string& answer) {
  const std::string key = "conv:" + session_id;
  const std::vector<std::string> turns = {json{{"role", "dasher"}, {"text", question}}.dump(),
                                          json{{"role", "assistant"}, {"text", answer}}.dump()};
  auto tx = redis.transaction();
  tx.rpush(key, turns.begin(), turns.end()).expire(key, config::kHistoryTtlS).exec();
}

// One record on config::kTopic keyed by the session; the caller never waits for the broker.
void record_turn(const TurnRecord& record) {
  const std::string session_id = record.session_id;
  const std::string value = json{{"session_id", record.session_id}, {"turn", record.turn}, {"dasher_id", record.dasher_id},
                                 {"question", record.question}, {"answer", record.answer}, {"sources", record.sources},
                                 {"escalated", record.escalated}, {"model", record.model}, {"tokens", record.tokens}}
                                .dump();
  const RdKafka::ErrorCode err = producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), session_id.c_str(), session_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "turn not recorded: " << RdKafka::err2str(err) << "\\n";
  producer->poll(0);  // serve delivery reports; a flush here would make every reply wait for the broker
}

int main() {
  httplib::Server app;
  app.Post("/chat", [](const httplib::Request& req, httplib::Response& res) {
    json body;
    try {
      body = json::parse(req.body);
    } catch (const json::exception&) {
      body = nullptr;
    }
    const auto parsed = validate(body);
    if (!parsed) return answer_json(res, 400, {{"error", "invalid_request"}});
    const ChatRequest& chat = *parsed;
    if (!allowed(chat.dasher_id)) return answer_json(res, 429, {{"error", "rate_limited"}});
    const auto history = load_history(chat.session_id);
    int turn = 1;
    for (const auto& t : history)
      if (t.role == "dasher") ++turn;
    std::string answer, model;
    std::vector<std::string> sources;
    bool escalated = false, cached = false;
    int tokens = 0;
    if (const auto hit = cached_answer(chat.message)) {
      answer = hit->answer;
      sources = hit->sources;
      model = "cache";
      cached = true;
    } else {
      const auto chunks = search(chat.message);
      const auto out = answer_or_escalate(chat.message, chunks, history);
      answer = out.answer;
      sources = out.sources;
      escalated = out.escalated;
      model = out.model;
      tokens = out.tokens;
      if (!escalated) remember_answer(chat.message, answer, sources);
    }
    remember_turns(chat.session_id, chat.message, answer);
    record_turn(TurnRecord{chat.session_id, turn, chat.dasher_id, chat.message, answer, sources, escalated, model, tokens});
    json reply;
    reply["answer"] = answer;
    reply["sources"] = sources;
    reply["escalated"] = escalated;
    reply["model"] = model;
    reply["cached"] = cached;
    reply["turn"] = turn;
    answer_json(res, 200, reply);
  });
  app.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import importlib
import json

import support_pb2
import support_pb2_grpc
from assistant import config, model
from assistant.db import SCHEMA
from assistant.prompt import cited_ids

TOPIC = config.TOPIC
LOGIN_Q = "I forgot my password and cannot sign in"
RED_CARD_Q = "My red card was declined at checkout"
REFERRAL_Q = "Can I get a referral bonus for a friend"


class LlmServicer(support_pb2_grpc.LlmServicer):
    """The stand-in model at both addresses: faithful unless the check flips \`mode\`; every reply it gave."""

    def __init__(self, mode="faithful"):
        self.mode = mode
        self.replies = []

    def Generate(self, request, context):
        text = model.complete(request.prompt, request.max_tokens, self.mode)
        self.replies.append(text)
        return support_pb2.GenerateReply(text=text, tokens=len(text.split()), model=request.model)


class JudgeServicer(support_pb2_grpc.JudgeServicer):
    def Evaluate(self, request, context):
        return support_pb2.Scores(**model.evaluate(request.question, request.answer, list(request.context_ids)))


async def _serve(ctx, mode="faithful"):
    """The learner's app over an indexed knowledge base, the model and the judge served; the model stand-in."""
    await ctx.db.reset(SCHEMA)
    llm = LlmServicer(mode)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, llm, config.LLM_LARGE)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, llm, config.LLM_SMALL)
    ctx.grpc.serve(support_pb2_grpc.add_JudgeServicer_to_server, JudgeServicer(), config.JUDGE)
    m = ctx.load("support_api")
    await importlib.import_module("kb_search").index_articles()
    return m, llm


def _generates(ctx):
    return ctx.grpc.calls_to("Generate")


def _history(ctx, session_id):
    return [json.loads(raw) for raw in ctx.redis.lrange(f"conv:{session_id}", 0, -1)]


def _records(ctx):
    return [(r.key.decode(), json.loads(r.value)) for r in ctx.kafka.records(TOPIC)]


async def _chat(c, session_id, dasher_id, message, expect=200):
    r = await c.post("/chat", json={"session_id": session_id, "dasher_id": dasher_id, "message": message})
    assert r.status_code == expect, f"POST /chat ({message!r} from {dasher_id} in {session_id}) answered {r.status_code} {r.text}, expected {expect}"
    return r.json()


async def check_validate(ctx):
    m, _ = await _serve(ctx)
    bad = [
        ("no session_id", {"dasher_id": "d1", "message": "hi"}),
        ("an empty session_id", {"session_id": "", "dasher_id": "d1", "message": "hi"}),
        ("no dasher_id", {"session_id": "s1", "message": "hi"}),
        ("an empty dasher_id", {"session_id": "s1", "dasher_id": "   ", "message": "hi"}),
        ("no message", {"session_id": "s1", "dasher_id": "d1"}),
        ("an empty message", {"session_id": "s1", "dasher_id": "d1", "message": ""}),
        ("a message that is not a string", {"session_id": "s1", "dasher_id": "d1", "message": 7}),
        ("a body that is not an object", ["s1", "d1", "hi"]),
    ]
    async with ctx.client(m.app) as c:
        for what, body in bad:
            r = await c.post("/chat", json=body)
            assert r.status_code == 400, f"POST /chat with {what} answered {r.status_code} {r.text}, expected 400"
            assert r.json() == {"error": "invalid_request"}, f"the 400 for {what} must be {{\\"error\\": \\"invalid_request\\"}}, got {r.text}"
        assert ctx.redis.keys("*") == [], f"a rejected request must touch nothing, Redis holds {ctx.redis.keys('*')}"
        assert not _generates(ctx), "a rejected request must not reach the model"
        assert ctx.kafka.records(TOPIC) == [], "a rejected request must not be recorded"
        data = await _chat(c, "s1", "d1", LOGIN_Q)
        assert data.get("answer"), f"a valid request must be answered, got {data}"


async def check_answer_and_history(ctx):
    m, llm = await _serve(ctx)
    async with ctx.client(m.app) as c:
        data = await _chat(c, "s1", "d1", LOGIN_Q)
        assert len(llm.replies) >= 1, "the first question of a session must reach the model (no cache, no history)"
        answer = llm.replies[-1]
        assert data.get("answer") == answer, f"answer must be what the guardrail passed on — the model's reply {answer!r} — got {data.get('answer')!r}"
        assert answer.startswith("Based on [kb:login-"), f"the question about signing in must be answered from the login article's chunks (kb_search.search → the prompt), the model answered {answer!r}"
        assert data.get("sources") == cited_ids(answer), f"sources must be the chunk ids the answer cites, in order: {cited_ids(answer)}, got {data.get('sources')!r}"
        assert data.get("escalated") is False and data.get("model") == "large" and data.get("cached") is False, f"a grounded first answer is escalated: false, model: 'large', cached: false; got {data}"
        assert data.get("turn") == 1, f"the first Dasher turn of a session is turn 1, got {data.get('turn')!r}"
        turns = _history(ctx, "s1")
        assert turns == [{"role": "dasher", "text": LOGIN_Q}, {"role": "assistant", "text": answer}], f"conv:s1 must hold the Dasher's turn then the assistant's as JSON {{role, text}}, it holds {turns}"
        ttl = ctx.redis.ttl("conv:s1")
        assert config.HISTORY_TTL_S - 5 <= ttl <= config.HISTORY_TTL_S, f"conv:s1 must expire after HISTORY_TTL_S = {config.HISTORY_TTL_S} s, its TTL is {ttl}"
        calls_before = len(_generates(ctx))
        data = await _chat(c, "s1", "d1", RED_CARD_Q)
        assert len(_generates(ctx)) > calls_before, "a new question in the session must reach the model"
        prompt = _generates(ctx)[calls_before].request.prompt
        assert f"dasher: {LOGIN_Q}" in prompt and f"assistant: {answer}" in prompt, "the second question's prompt must carry the first exchange as history (load conv:<session_id> and pass it to answer_or_escalate); the prompt has no such lines"
        assert data.get("turn") == 2, f"the second Dasher turn of the session is turn 2, got {data.get('turn')!r}"
        turns = _history(ctx, "s1")
        assert len(turns) == 4 and [t["role"] for t in turns] == ["dasher", "assistant", "dasher", "assistant"], f"after two exchanges conv:s1 holds four turns, dasher and assistant alternating; it holds {turns}"
        assert turns[2]["text"] == RED_CARD_Q and turns[3]["text"] == data["answer"], "the second exchange must be appended after the first (RPUSH)"
        other = await _chat(c, "s2", "d1", REFERRAL_Q)
        assert other.get("turn") == 1 and len(_history(ctx, "s2")) == 2, "another session starts at turn 1 with its own conv:<session_id>"


async def check_answer_cache(ctx):
    m, llm = await _serve(ctx)
    async with ctx.client(m.app) as c:
        first = await _chat(c, "s1", "d1", LOGIN_Q)
        calls = len(_generates(ctx))
        queries = len(ctx.db.queries)
        again = await _chat(c, "s2", "d2", "  i FORGOT my   password and cannot SIGN in ")
        assert again.get("cached") is True, f"the same question in different casing and spacing must be answered from the cache (cached: true), got {again}"
        assert again.get("model") == "cache", f"a cached answer reports model 'cache', got {again.get('model')!r}"
        assert again.get("answer") == first["answer"] and again.get("sources") == first["sources"], f"the cached answer must be the remembered answer and sources, got {again}"
        assert again.get("escalated") is False and again.get("turn") == 1, f"a cached answer is escalated: false and still counts as a turn (turn 1 of s2), got {again}"
        assert len(_generates(ctx)) == calls, f"a cache hit must not call the model, yet {len(_generates(ctx)) - calls} Generate call(s) were made"
        searched = [sql for sql, _ in ctx.db.queries[queries:] if "kb_chunks" in sql.lower()]
        assert searched == [], f"a cache hit must not search kb_chunks, yet the request ran {searched}"
        assert len(_history(ctx, "s2")) == 2, "a cached exchange is still appended to the session's history"
        llm.mode = "hallucinate"
        calls = len(_generates(ctx))
        bad = await _chat(c, "s3", "d3", RED_CARD_Q)
        assert len(_generates(ctx)) > calls, "a new question must reach the model"
        assert bad.get("escalated") is True, f"a hallucinated answer ([kb:policy-404] was never retrieved) must be escalated by the guardrail: escalated true, got {bad}"
        assert bad.get("answer") == config.HANDOFF_TEXT and bad.get("sources") == [], f"an escalated turn answers HANDOFF_TEXT with no sources, got {bad}"
        assert bad.get("cached") is False and bad.get("model") in ("large", "small"), f"an escalated turn is not cached and reports the model that answered, got {bad}"
        assert all(not k.startswith("answer:") or ctx.redis.get(k) and "policy-404" not in ctx.redis.get(k) for k in ctx.redis.keys("*")), "the hallucinated answer must never be remembered"
        turns = _history(ctx, "s3")
        assert turns and turns[-1] == {"role": "assistant", "text": config.HANDOFF_TEXT}, f"the hand-off is what the Dasher saw, so it is the assistant turn in conv:s3; the history holds {turns}"
        calls = len(_generates(ctx))
        twice = await _chat(c, "s4", "d4", RED_CARD_Q)
        assert len(_generates(ctx)) > calls, "an escalation is never cached: the same question from another session must call the model again, it was answered without a call"
        assert twice.get("escalated") is True and twice.get("cached") is False, f"still hallucinating, still escalated and uncached; got {twice}"
        recorded = [v for _, v in _records(ctx) if v.get("session_id") == "s3"]
        assert len(recorded) == 1 and recorded[0].get("escalated") is True and recorded[0].get("answer") == config.HANDOFF_TEXT, f"an escalated turn is still recorded on {TOPIC} with escalated true; found {recorded}"


async def check_rate_limit(ctx):
    m, _ = await _serve(ctx)
    limit = config.RATE_LIMIT_PER_MINUTE
    async with ctx.client(m.app) as c:
        for i in range(limit):
            data = await _chat(c, "s1", "d1", LOGIN_Q)
            assert data.get("turn") == i + 1
        minute = int(ctx.clock.time() // 60)
        key = f"rl:d1:{minute}"
        assert ctx.redis.get(key) == str(limit), f"the counter {key} must be INCRed once per request ({limit}), Redis holds {ctx.redis.get(key)!r} under {ctx.redis.keys('rl:*')}"
        assert 0 < ctx.redis.ttl(key) <= 60, f"{key} must EXPIRE within 60 s, its TTL is {ctx.redis.ttl(key)}"
        r = await c.post("/chat", json={"session_id": "s1", "dasher_id": "d1", "message": LOGIN_Q})
        assert r.status_code == 429, f"request {limit + 1} of d1 within the minute answered {r.status_code} {r.text}, expected 429"
        assert r.json() == {"error": "rate_limited"}, f"the 429 body must be {{\\"error\\": \\"rate_limited\\"}}, got {r.text}"
        assert len(_history(ctx, "s1")) == 2 * limit, "a limited request must not be appended to the history"
        assert len(ctx.kafka.records(TOPIC)) == limit, "a limited request must not be recorded"
        other = await _chat(c, "s2", "d2", LOGIN_Q)
        assert other.get("answer"), "the limit is per Dasher: d2 must still be answered"
        ctx.clock.advance(60)
        data = await _chat(c, "s1", "d1", LOGIN_Q)
        assert data.get("turn") == limit + 1, f"the first request of the next minute must be answered (turn {limit + 1}), got {data}"
        assert ctx.redis.get(key) is None, f"the previous minute's counter {key} must have expired, it is {ctx.redis.get(key)!r}"


async def check_recorded(ctx):
    m, llm = await _serve(ctx)
    async with ctx.client(m.app) as c:
        a = await _chat(c, "s1", "d1", LOGIN_Q)
        b = await _chat(c, "s1", "d1", RED_CARD_Q)
        c2 = await _chat(c, "s2", "d2", LOGIN_Q)
        records = _records(ctx)
        assert len(records) == 3, f"three answered turns must leave three records on {TOPIC} (topics: {sorted(ctx.kafka.topics)}), found {len(records)}"
        assert [k for k, _ in records] == ["s1", "s1", "s2"], f"records must be keyed by the session id, keys were {[k for k, _ in records]}"
        fields = {"session_id", "turn", "dasher_id", "question", "answer", "sources", "escalated", "model", "tokens"}
        for _, v in records:
            assert fields <= set(v), f"a record must carry {sorted(fields)}, this one has {sorted(v)}"
        first, second, third = (v for _, v in records)
        assert (first["session_id"], first["turn"], first["dasher_id"], first["question"]) == ("s1", 1, "d1", LOGIN_Q), f"the first record is s1 turn 1 by d1 asking {LOGIN_Q!r}, got {first}"
        assert first["answer"] == a["answer"] and first["sources"] == a["sources"] and first["escalated"] is False and first["model"] == "large", f"the record carries what the Dasher was answered: {a}; got {first}"
        assert first["tokens"] == len(a["answer"].split()), f"tokens is the generate result's token count ({len(a['answer'].split())}), got {first['tokens']!r}"
        assert (second["turn"], second["question"], second["answer"]) == (2, RED_CARD_Q, b["answer"]), f"the second record of s1 is turn 2, got {second}"
        assert (third["session_id"], third["turn"], third["model"], third["tokens"]) == ("s2", 1, "cache", 0), f"s2's first turn was a cache hit: turn 1, model 'cache', tokens 0; got {third}"
        assert third["answer"] == c2["answer"] and third["escalated"] is False
        ctx.kafka.stall(TOPIC)  # the broker stops acknowledging
        before = ctx.clock.offset
        d = await _chat(c, "s2", "d2", REFERRAL_Q)
        waited = ctx.clock.offset - before
        assert waited < 0.5, f"with the broker stalled the reply took {waited:.1f} s of virtual time: hand the record to the producer and answer, never flush on the request path"
        assert d.get("turn") == 2 and d.get("answer"), f"the reply must not depend on the broker, got {d}"
        assert len(_records(ctx)) == 3, "nothing can reach the topic while the broker is stalled"
        ctx.kafka.resume(TOPIC)
        e = await _chat(c, "s1", "d1", REFERRAL_Q)  # the next request serves the producer's delivery reports
        assert e.get("turn") == 3
        records = _records(ctx)
        assert len(records) == 5, f"once the broker answers, the record handed to the producer during the stall must arrive: {TOPIC} holds {len(records)} records, expected 5"
        turns = sorted((v["session_id"], v["turn"]) for _, v in records)
        assert turns == [("s1", 1), ("s1", 2), ("s1", 3), ("s2", 1), ("s2", 2)], f"every turn once, numbered within its session: {turns}"
`,
    typescript: `const LOGIN_Q = 'I forgot my password and cannot sign in';
const RED_CARD_Q = 'My red card was declined at checkout';
const REFERRAL_Q = 'Can I get a referral bonus for a friend';

const words = (text: string) => text.split(/\\s+/).filter(w => w !== '').length;

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function assistant(ctx) {
  return {
    config: ctx.load('/support/assistant/config.ts'),
    model: ctx.load('/support/assistant/model.ts'),
    prompt: ctx.load('/support/assistant/prompt.ts'),
    SCHEMA: ctx.load('/support/assistant/db.ts').SCHEMA,
  };
}

/** The learner's app over an indexed knowledge base, the model and the judge served; the model stand-in (\`llm.mode\`, \`llm.replies\`). */
async function serve(ctx, mode = 'faithful') {
  const {config, model, SCHEMA} = assistant(ctx);
  await ctx.db.reset(SCHEMA);
  const {support} = ctx.proto('support.proto');
  const llm = {mode, replies: [] as string[]};
  const impl = {
    Generate: (call, callback) => {
      const text = model.complete(call.request.prompt, call.request.max_tokens, llm.mode);
      llm.replies.push(text);
      callback(null, {text, tokens: words(text), model: call.request.model});
    },
  };
  ctx.grpc.serve(support.Llm.service, impl, config.LLM_LARGE);
  ctx.grpc.serve(support.Llm.service, impl, config.LLM_SMALL);
  ctx.grpc.serve(
    support.Judge.service,
    {Evaluate: (call, callback) => callback(null, model.evaluate(call.request.question, call.request.answer, [...call.request.context_ids]))},
    config.JUDGE,
  );
  const m = ctx.load('support_api');
  await ctx.load('kb_search').indexArticles();
  return {m, llm, config, c: ctx.client(m.app), TOPIC: config.TOPIC as string};
}

const generates = ctx => ctx.grpc.callsTo('Generate');
const history = (ctx, sessionId: string) => ctx.redis.lrange(\`conv:\${sessionId}\`, 0, -1).map((raw: string) => JSON.parse(raw));
const records = (ctx, topic: string): [string, Record<string, unknown>][] =>
  ctx.kafka.records(topic).map(r => [r.key.toString(), JSON.parse(r.value.toString())]);

async function chat(c, session_id: string, dasher_id: string, message: string, expect = 200) {
  const r = await c.post('/chat', {json: {session_id, dasher_id, message}});
  assert.equal(r.status, expect, \`POST /chat (\${JSON.stringify(message)} from \${dasher_id} in \${session_id}) answered \${r.status} \${r.text}, expected \${expect}\`);
  return r.json();
}

export async function check_validate(ctx) {
  const {c, TOPIC} = await serve(ctx);
  const bad: [string, unknown][] = [
    ['no session_id', {dasher_id: 'd1', message: 'hi'}],
    ['an empty session_id', {session_id: '', dasher_id: 'd1', message: 'hi'}],
    ['no dasher_id', {session_id: 's1', message: 'hi'}],
    ['an empty dasher_id', {session_id: 's1', dasher_id: '   ', message: 'hi'}],
    ['no message', {session_id: 's1', dasher_id: 'd1'}],
    ['an empty message', {session_id: 's1', dasher_id: 'd1', message: ''}],
    ['a message that is not a string', {session_id: 's1', dasher_id: 'd1', message: 7}],
    ['a body that is not an object', ['s1', 'd1', 'hi']],
  ];
  for (const [what, body] of bad) {
    const r = await c.post('/chat', {json: body});
    assert.equal(r.status, 400, \`POST /chat with \${what} answered \${r.status} \${r.text}, expected 400\`);
    assert.deepEqual(r.json(), {error: 'invalid_request'}, \`the 400 for \${what} must be {"error": "invalid_request"}, got \${r.text}\`);
  }
  assert.deepEqual(ctx.redis.keys('*'), [], \`a rejected request must touch nothing, Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
  assert.equal(generates(ctx).length, 0, 'a rejected request must not reach the model');
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a rejected request must not be recorded');
  const data = await chat(c, 's1', 'd1', LOGIN_Q);
  assert(data.answer, \`a valid request must be answered, got \${JSON.stringify(data)}\`);
}

export async function check_answer_and_history(ctx) {
  const {c, llm, config} = await serve(ctx);
  const {prompt} = assistant(ctx);
  let data = await chat(c, 's1', 'd1', LOGIN_Q);
  assert(llm.replies.length >= 1, 'the first question of a session must reach the model (no cache, no history)');
  const answer = llm.replies.at(-1);
  assert.equal(data.answer, answer, \`answer must be what the guardrail passed on — the model's reply \${JSON.stringify(answer)} — got \${JSON.stringify(data.answer)}\`);
  assert(answer.startsWith('Based on [kb:login-'), \`the question about signing in must be answered from the login article's chunks (search → the prompt), the model answered \${JSON.stringify(answer)}\`);
  assert.deepEqual(data.sources, prompt.citedIds(answer), \`sources must be the chunk ids the answer cites, in order: \${JSON.stringify(prompt.citedIds(answer))}, got \${JSON.stringify(data.sources)}\`);
  assert(data.escalated === false && data.model === 'large' && data.cached === false, \`a grounded first answer is escalated: false, model: 'large', cached: false; got \${JSON.stringify(data)}\`);
  assert.equal(data.turn, 1, \`the first Dasher turn of a session is turn 1, got \${JSON.stringify(data.turn)}\`);
  let turns = history(ctx, 's1');
  assert.deepEqual(turns, [{role: 'dasher', text: LOGIN_Q}, {role: 'assistant', text: answer}], \`conv:s1 must hold the Dasher's turn then the assistant's as JSON {role, text}, it holds \${JSON.stringify(turns)}\`);
  const ttl = ctx.redis.ttl('conv:s1');
  assert(config.HISTORY_TTL_S - 5 <= ttl && ttl <= config.HISTORY_TTL_S, \`conv:s1 must expire after HISTORY_TTL_S = \${config.HISTORY_TTL_S} s, its TTL is \${ttl}\`);
  const callsBefore = generates(ctx).length;
  data = await chat(c, 's1', 'd1', RED_CARD_Q);
  assert(generates(ctx).length > callsBefore, 'a new question in the session must reach the model');
  const text = generates(ctx)[callsBefore].request.prompt;
  assert(text.includes(\`dasher: \${LOGIN_Q}\`) && text.includes(\`assistant: \${answer}\`), "the second question's prompt must carry the first exchange as history (load conv:<session_id> and pass it to answerOrEscalate); the prompt has no such lines");
  assert.equal(data.turn, 2, \`the second Dasher turn of the session is turn 2, got \${JSON.stringify(data.turn)}\`);
  turns = history(ctx, 's1');
  assert(turns.length === 4 && turns.map(t => t.role).join() === 'dasher,assistant,dasher,assistant', \`after two exchanges conv:s1 holds four turns, dasher and assistant alternating; it holds \${JSON.stringify(turns)}\`);
  assert(turns[2].text === RED_CARD_Q && turns[3].text === data.answer, 'the second exchange must be appended after the first (RPUSH)');
  const other = await chat(c, 's2', 'd1', REFERRAL_Q);
  assert(other.turn === 1 && history(ctx, 's2').length === 2, 'another session starts at turn 1 with its own conv:<session_id>');
}

export async function check_answer_cache(ctx) {
  const {c, llm, config, TOPIC} = await serve(ctx);
  const first = await chat(c, 's1', 'd1', LOGIN_Q);
  let calls = generates(ctx).length;
  const queries = ctx.db.queries.length;
  const again = await chat(c, 's2', 'd2', '  i FORGOT my   password and cannot SIGN in ');
  assert.equal(again.cached, true, \`the same question in different casing and spacing must be answered from the cache (cached: true), got \${JSON.stringify(again)}\`);
  assert.equal(again.model, 'cache', \`a cached answer reports model 'cache', got \${JSON.stringify(again.model)}\`);
  assert(again.answer === first.answer && JSON.stringify(again.sources) === JSON.stringify(first.sources), \`the cached answer must be the remembered answer and sources, got \${JSON.stringify(again)}\`);
  assert(again.escalated === false && again.turn === 1, \`a cached answer is escalated: false and still counts as a turn (turn 1 of s2), got \${JSON.stringify(again)}\`);
  assert.equal(generates(ctx).length, calls, \`a cache hit must not call the model, yet \${generates(ctx).length - calls} Generate call(s) were made\`);
  const searched = ctx.db.queries.slice(queries).map(([sql]) => sql).filter((sql: string) => sql.toLowerCase().includes('kb_chunks'));
  assert.deepEqual(searched, [], \`a cache hit must not search kb_chunks, yet the request ran \${JSON.stringify(searched)}\`);
  assert.equal(history(ctx, 's2').length, 2, "a cached exchange is still appended to the session's history");
  llm.mode = 'hallucinate';
  calls = generates(ctx).length;
  const bad = await chat(c, 's3', 'd3', RED_CARD_Q);
  assert(generates(ctx).length > calls, 'a new question must reach the model');
  assert.equal(bad.escalated, true, \`a hallucinated answer ([kb:policy-404] was never retrieved) must be escalated by the guardrail: escalated true, got \${JSON.stringify(bad)}\`);
  assert(bad.answer === config.HANDOFF_TEXT && Array.isArray(bad.sources) && bad.sources.length === 0, \`an escalated turn answers HANDOFF_TEXT with no sources, got \${JSON.stringify(bad)}\`);
  assert(bad.cached === false && ['large', 'small'].includes(bad.model), \`an escalated turn is not cached and reports the model that answered, got \${JSON.stringify(bad)}\`);
  for (const key of ctx.redis.keys('answer:*')) assert(!String(ctx.redis.get(key)).includes('policy-404'), 'the hallucinated answer must never be remembered');
  const turns = history(ctx, 's3');
  assert.deepEqual(turns.at(-1), {role: 'assistant', text: config.HANDOFF_TEXT}, \`the hand-off is what the Dasher saw, so it is the assistant turn in conv:s3; the history holds \${JSON.stringify(turns)}\`);
  calls = generates(ctx).length;
  const twice = await chat(c, 's4', 'd4', RED_CARD_Q);
  assert(generates(ctx).length > calls, 'an escalation is never cached: the same question from another session must call the model again, it was answered without a call');
  assert(twice.escalated === true && twice.cached === false, \`still hallucinating, still escalated and uncached; got \${JSON.stringify(twice)}\`);
  await settle();
  const recorded = records(ctx, TOPIC).map(([, v]) => v).filter(v => v.session_id === 's3');
  assert(recorded.length === 1 && recorded[0].escalated === true && recorded[0].answer === config.HANDOFF_TEXT, \`an escalated turn is still recorded on \${TOPIC} with escalated true; found \${JSON.stringify(recorded)}\`);
}

export async function check_rate_limit(ctx) {
  const {c, config, TOPIC} = await serve(ctx);
  const limit = config.RATE_LIMIT_PER_MINUTE as number;
  for (let i = 0; i < limit; i++) {
    const data = await chat(c, 's1', 'd1', LOGIN_Q);
    assert.equal(data.turn, i + 1);
  }
  const minute = Math.floor(ctx.clock.now() / 60_000);
  const key = \`rl:d1:\${minute}\`;
  assert.equal(ctx.redis.get(key), String(limit), \`the counter \${key} must be INCRed once per request (\${limit}), Redis holds \${JSON.stringify(ctx.redis.get(key))} under \${JSON.stringify(ctx.redis.keys('rl:*'))}\`);
  assert(0 < ctx.redis.ttl(key) && ctx.redis.ttl(key) <= 60, \`\${key} must EXPIRE within 60 s, its TTL is \${ctx.redis.ttl(key)}\`);
  const r = await c.post('/chat', {json: {session_id: 's1', dasher_id: 'd1', message: LOGIN_Q}});
  assert.equal(r.status, 429, \`request \${limit + 1} of d1 within the minute answered \${r.status} \${r.text}, expected 429\`);
  assert.deepEqual(r.json(), {error: 'rate_limited'}, \`the 429 body must be {"error": "rate_limited"}, got \${r.text}\`);
  assert.equal(history(ctx, 's1').length, 2 * limit, 'a limited request must not be appended to the history');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, limit, 'a limited request must not be recorded');
  const other = await chat(c, 's2', 'd2', LOGIN_Q);
  assert(other.answer, 'the limit is per Dasher: d2 must still be answered');
  ctx.clock.advance(60);
  const data = await chat(c, 's1', 'd1', LOGIN_Q);
  assert.equal(data.turn, limit + 1, \`the first request of the next minute must be answered (turn \${limit + 1}), got \${JSON.stringify(data)}\`);
  assert.equal(ctx.redis.get(key), null, \`the previous minute's counter \${key} must have expired, it is \${JSON.stringify(ctx.redis.get(key))}\`);
}

export async function check_recorded(ctx) {
  const {c, TOPIC} = await serve(ctx);
  const a = await chat(c, 's1', 'd1', LOGIN_Q);
  const b = await chat(c, 's1', 'd1', RED_CARD_Q);
  const c2 = await chat(c, 's2', 'd2', LOGIN_Q);
  await settle();
  let recs = records(ctx, TOPIC);
  assert.equal(recs.length, 3, \`three answered turns must leave three records on \${TOPIC}, found \${recs.length}\`);
  assert.deepEqual(recs.map(([k]) => k), ['s1', 's1', 's2'], \`records must be keyed by the session id, keys were \${JSON.stringify(recs.map(([k]) => k))}\`);
  const fields = ['session_id', 'turn', 'dasher_id', 'question', 'answer', 'sources', 'escalated', 'model', 'tokens'];
  for (const [, v] of recs) {
    const missing = fields.filter(f => !(f in v));
    assert.equal(missing.length, 0, \`a record must carry \${JSON.stringify(fields)}, this one lacks \${JSON.stringify(missing)}\`);
  }
  const [[, first], [, second], [, third]] = recs;
  assert(first.session_id === 's1' && first.turn === 1 && first.dasher_id === 'd1' && first.question === LOGIN_Q, \`the first record is s1 turn 1 by d1 asking \${JSON.stringify(LOGIN_Q)}, got \${JSON.stringify(first)}\`);
  assert(first.answer === a.answer && JSON.stringify(first.sources) === JSON.stringify(a.sources) && first.escalated === false && first.model === 'large', \`the record carries what the Dasher was answered: \${JSON.stringify(a)}; got \${JSON.stringify(first)}\`);
  assert.equal(first.tokens, words(a.answer), \`tokens is the generate result's token count (\${words(a.answer)}), got \${JSON.stringify(first.tokens)}\`);
  assert(second.turn === 2 && second.question === RED_CARD_Q && second.answer === b.answer, \`the second record of s1 is turn 2, got \${JSON.stringify(second)}\`);
  assert(third.session_id === 's2' && third.turn === 1 && third.model === 'cache' && third.tokens === 0, \`s2's first turn was a cache hit: turn 1, model 'cache', tokens 0; got \${JSON.stringify(third)}\`);
  assert(third.answer === c2.answer && third.escalated === false);
  ctx.kafka.stall(TOPIC); // the broker stops acknowledging
  const before = ctx.clock.now();
  const d = await chat(c, 's2', 'd2', REFERRAL_Q);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited < 0.5, \`with the broker stalled the reply took \${waited.toFixed(1)} s of virtual time: hand the record to the producer and answer, never await the send on the request path\`);
  assert(d.turn === 2 && d.answer, \`the reply must not depend on the broker, got \${JSON.stringify(d)}\`);
  assert.equal(records(ctx, TOPIC).length, 3, 'nothing can reach the topic while the broker is stalled');
  ctx.kafka.resume(TOPIC);
  ctx.clock.advance(30); // the producer's next attempt finds the broker back
  await settle();
  const e = await chat(c, 's1', 'd1', REFERRAL_Q);
  assert.equal(e.turn, 3);
  await settle();
  recs = records(ctx, TOPIC);
  assert.equal(recs.length, 5, \`once the broker answers, the record handed to the producer during the stall must arrive: \${TOPIC} holds \${recs.length} records, expected 5\`);
  const turns = recs.map(([, v]) => \`\${v.session_id}:\${v.turn}\`).sort();
  assert.deepEqual(turns, ['s1:1', 's1:2', 's1:3', 's2:1', 's2:2'], \`every turn once, numbered within its session: \${JSON.stringify(turns)}\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"assistant/chunk"
	"assistant/config"
	"assistant/db"
	"assistant/embed"
	"assistant/kb"
	"assistant/model"
	"assistant/prompt"
	pb "assistant/gen/support"

	"leetbuild/harness"
)

const (
	apiLoginQ    = "I forgot my password and cannot sign in"
	apiRedCardQ  = "My red card was declined at checkout"
	apiReferralQ = "Can I get a referral bonus for a friend"
)

// apiLLM is the stand-in model at both addresses: faithful unless the check flips mode; every reply it gave.
type apiLLM struct {
	pb.UnimplementedLlmServer
	mu      sync.Mutex
	mode    string
	replies []string
}

func (p *apiLLM) Generate(_ context.Context, req *pb.GenerateRequest) (*pb.GenerateReply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	text := model.Complete(req.GetPrompt(), int(req.GetMaxTokens()), p.mode)
	p.replies = append(p.replies, text)
	return &pb.GenerateReply{Text: text, Tokens: int32(len(strings.Fields(text))), Model: req.GetModel()}, nil
}

func (p *apiLLM) setMode(mode string) {
	p.mu.Lock()
	p.mode = mode
	p.mu.Unlock()
}

func (p *apiLLM) lastReply() (string, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.replies) == 0 {
		return "", 0
	}
	n := len(p.replies)
	return p.replies[n-1], n
}

type apiJudge struct {
	pb.UnimplementedJudgeServer
}

func (apiJudge) Evaluate(_ context.Context, req *pb.EvaluateRequest) (*pb.Scores, error) {
	s := model.Evaluate(req.GetQuestion(), req.GetAnswer(), req.GetContextIds())
	return &pb.Scores{Groundedness: float32(s.Groundedness), Coherence: float32(s.Coherence), Compliance: float32(s.Compliance), Pass: s.Pass}, nil
}

func apiSentences(text string) []string {
	var out []string
	for _, s := range strings.FieldsFunc(text, func(r rune) bool { return r == '.' || r == '!' || r == '?' }) {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// apiPasses is step 4's check: every citation retrieved, every sentence like some chunk, then the judge's pass.
func apiPasses(ctx context.Context, judge pb.JudgeClient, question, answer string, chunks []prompt.Chunk) bool {
	ids := map[string]bool{}
	var vectors [][]float64
	var idList []string
	for _, c := range chunks {
		ids[c.ID] = true
		idList = append(idList, c.ID)
		vectors = append(vectors, embed.Embed(c.Text))
	}
	for _, id := range prompt.CitedIds(answer) {
		if !ids[id] {
			return false
		}
	}
	for _, s := range apiSentences(answer) {
		v := embed.Embed(s)
		best := 0.0
		for _, w := range vectors {
			if c := embed.Cosine(v, w); c > best {
				best = c
			}
		}
		if best < config.MinSimilarity {
			return false
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	scores, err := judge.Evaluate(callCtx, &pb.EvaluateRequest{Question: question, Answer: answer, ContextIds: idList})
	return err == nil && scores.GetPass()
}

// apiNeighbours stands in for the later steps as the course builds them: kb_search (step 2: pgvector
// over kb_chunks, the answer cache in Redis) and the guardrail (step 4) over the model call (step 3).
func apiNeighbours(ctx *harness.Ctx) {
	key := func(question string) string {
		sum := sha256.Sum256([]byte(strings.Join(strings.Fields(strings.ToLower(question)), " ")))
		return "answer:" + hex.EncodeToString(sum[:])
	}
	cachedAnswer = func(_ context.Context, question string) (*CachedAnswer, error) {
		raw, ok := ctx.Redis.Get(key(question))
		if !ok {
			return nil, nil
		}
		var out CachedAnswer
		if err := json.Unmarshal([]byte(raw), &out); err != nil {
			return nil, err
		}
		return &out, nil
	}
	rememberAnswer = func(_ context.Context, question, answer string, sources []string) error {
		value, _ := json.Marshal(CachedAnswer{Answer: answer, Sources: sources})
		ctx.Redis.Set(key(question), string(value), "EX", config.CacheTTL)
		return nil
	}
	search = func(c context.Context, question string, k int) ([]prompt.Chunk, error) {
		rows, err := db.Pool.QueryContext(c,
			"SELECT id, text, embedding <=> $1::vector AS distance FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT $2",
			embed.ToPgvector(embed.Embed(question)), k)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []prompt.Chunk
		for rows.Next() {
			var ch prompt.Chunk
			var distance float64
			if err := rows.Scan(&ch.ID, &ch.Text, &distance); err != nil {
				return nil, err
			}
			ch.Score = 1 - distance
			out = append(out, ch)
		}
		return out, rows.Err()
	}
	llmConn, _ := grpc.NewClient(config.LLMLarge, grpc.WithTransportCredentials(insecure.NewCredentials()))
	llm := pb.NewLlmClient(llmConn)
	judgeConn, _ := grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
	judge := pb.NewJudgeClient(judgeConn)
	answerOrEscalate = func(c context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (Outcome, error) {
		modelName := ""
		for range 2 {
			callCtx, cancel := context.WithTimeout(c, 2*time.Second)
			reply, err := llm.Generate(callCtx, &pb.GenerateRequest{Model: "large", Prompt: prompt.Build(question, chunks, history), MaxTokens: config.MaxTokens})
			cancel()
			if err != nil {
				return Outcome{}, err
			}
			modelName = reply.GetModel()
			if apiPasses(c, judge, question, reply.GetText(), chunks) {
				return Outcome{Answer: reply.GetText(), Sources: prompt.CitedIds(reply.GetText()), Model: modelName, Tokens: reply.GetTokens()}, nil
			}
		}
		return Outcome{Answer: config.HandoffText, Sources: []string{}, Escalated: true, Model: modelName}, nil
	}
}

// apiWorld is the learner's app over an indexed knowledge base, with the model and the judge served.
type apiWorld struct {
	llm  *apiLLM
	http *harness.HTTP
}

func apiServe(ctx *harness.Ctx) *apiWorld {
	ctx.DB.Reset(db.Schema)
	for _, a := range kb.Articles {
		for position, text := range chunk.Chunk(a.Body) {
			ctx.DB.Exec("INSERT INTO kb_chunks (id, article, position, text, embedding) VALUES ($1, $2, $3, $4, $5::vector)",
				fmt.Sprintf("%s-%d", a.ID, position), a.ID, position, text, embed.ToPgvector(embed.Embed(text)))
		}
	}
	w := &apiWorld{llm: &apiLLM{mode: "faithful"}}
	pb.RegisterLlmServer(ctx.GRPC.Server(config.LLMLarge), w.llm)
	pb.RegisterLlmServer(ctx.GRPC.Server(config.LLMSmall), w.llm)
	pb.RegisterJudgeServer(ctx.GRPC.Server(config.Judge), apiJudge{})
	apiNeighbours(ctx)
	w.http = ctx.Main(main).HTTP()
	return w
}

func apiGenerates(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Generate", "") }

func apiHistory(ctx *harness.Ctx, sessionID string) []prompt.Turn {
	var turns []prompt.Turn
	for _, raw := range ctx.Redis.LRange("conv:"+sessionID, 0, -1) {
		var t prompt.Turn
		_ = json.Unmarshal([]byte(raw), &t)
		turns = append(turns, t)
	}
	return turns
}

// apiRecord is one record of the topic: its key and its JSON value.
type apiRecord struct {
	key   string
	value map[string]any
}

func apiRecords(ctx *harness.Ctx) []apiRecord {
	var out []apiRecord
	for _, r := range ctx.Kafka.Records(config.Topic) {
		var v map[string]any
		_ = json.Unmarshal(r.Value, &v)
		out = append(out, apiRecord{string(r.Key), v})
	}
	return out
}

func apiStrings(v any) []string {
	list, _ := v.([]any)
	out := []string{}
	for _, x := range list {
		out = append(out, fmt.Sprint(x))
	}
	return out
}

func apiShow(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

func (w *apiWorld) chat(ctx *harness.Ctx, sessionID, dasherID, message string, expect int) map[string]any {
	r := w.http.Post("/chat", map[string]any{"session_id": sessionID, "dasher_id": dasherID, "message": message})
	ctx.Assert(r.Status == expect, "POST /chat (%q from %s in %s) answered %d %s, expected %d", message, dasherID, sessionID, r.Status, r.Text(), expect)
	data, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "POST /chat must answer a JSON object, got %s", r.Text())
	return data
}

func CheckValidate(ctx *harness.Ctx) {
	w := apiServe(ctx)
	bad := []struct {
		what string
		body any
	}{
		{"no session_id", map[string]any{"dasher_id": "d1", "message": "hi"}},
		{"an empty session_id", map[string]any{"session_id": "", "dasher_id": "d1", "message": "hi"}},
		{"no dasher_id", map[string]any{"session_id": "s1", "message": "hi"}},
		{"an empty dasher_id", map[string]any{"session_id": "s1", "dasher_id": "   ", "message": "hi"}},
		{"no message", map[string]any{"session_id": "s1", "dasher_id": "d1"}},
		{"an empty message", map[string]any{"session_id": "s1", "dasher_id": "d1", "message": ""}},
		{"a message that is not a string", map[string]any{"session_id": "s1", "dasher_id": "d1", "message": 7}},
		{"a body that is not an object", []any{"s1", "d1", "hi"}},
	}
	for _, b := range bad {
		r := w.http.Post("/chat", b.body)
		ctx.Assert(r.Status == 400, "POST /chat with %s answered %d %s, expected 400", b.what, r.Status, r.Text())
		ctx.Equal(r.JSON(), map[string]any{"error": "invalid_request"}, "the 400 for %s must be {\\"error\\": \\"invalid_request\\"}", b.what)
	}
	ctx.Assert(len(ctx.Redis.Keys("*")) == 0, "a rejected request must touch nothing, Redis holds %q", ctx.Redis.Keys("*"))
	ctx.Equal(len(apiGenerates(ctx)), 0, "a rejected request must not reach the model")
	ctx.Equal(len(ctx.Kafka.Records(config.Topic)), 0, "a rejected request must not be recorded")
	data := w.chat(ctx, "s1", "d1", apiLoginQ, 200)
	ctx.Assert(data["answer"] != nil && data["answer"] != "", "a valid request must be answered, got %s", apiShow(data))
}

func CheckAnswerAndHistory(ctx *harness.Ctx) {
	w := apiServe(ctx)
	data := w.chat(ctx, "s1", "d1", apiLoginQ, 200)
	answer, replies := w.llm.lastReply()
	ctx.Assert(replies >= 1, "the first question of a session must reach the model (no cache, no history)")
	ctx.Equal(data["answer"], answer, "answer must be what the guardrail passed on — the model's reply")
	ctx.Assert(strings.HasPrefix(answer, "Based on [kb:login-"), "the question about signing in must be answered from the login article's chunks (search → the prompt), the model answered %q", answer)
	ctx.Equal(apiStrings(data["sources"]), prompt.CitedIds(answer), "sources must be the chunk ids the answer cites, in order")
	ctx.Assert(data["escalated"] == false && data["model"] == "large" && data["cached"] == false, "a grounded first answer is escalated: false, model: \\"large\\", cached: false; got %s", apiShow(data))
	ctx.Equal(data["turn"], 1, "the first Dasher turn of a session is turn 1")
	turns := apiHistory(ctx, "s1")
	ctx.Equal(turns, []prompt.Turn{{Role: "dasher", Text: apiLoginQ}, {Role: "assistant", Text: answer}}, "conv:s1 must hold the Dasher's turn then the assistant's as JSON {role, text}")
	ttl := ctx.Redis.TTL("conv:s1")
	ctx.Assert(config.HistoryTTL-5 <= ttl && ttl <= config.HistoryTTL, "conv:s1 must expire after config.HistoryTTL = %d s, its TTL is %d", config.HistoryTTL, ttl)
	callsBefore := len(apiGenerates(ctx))
	data = w.chat(ctx, "s1", "d1", apiRedCardQ, 200)
	ctx.Assert(len(apiGenerates(ctx)) > callsBefore, "a new question in the session must reach the model")
	request, _ := apiGenerates(ctx)[callsBefore].Request.(*pb.GenerateRequest)
	text := request.GetPrompt()
	ctx.Assert(strings.Contains(text, "dasher: "+apiLoginQ) && strings.Contains(text, "assistant: "+answer), "the second question's prompt must carry the first exchange as history (load conv:<session_id> and pass it to answerOrEscalate); the prompt has no such lines")
	ctx.Equal(data["turn"], 2, "the second Dasher turn of the session is turn 2")
	turns = apiHistory(ctx, "s1")
	var roles []string
	for _, t := range turns {
		roles = append(roles, t.Role)
	}
	ctx.Assert(len(turns) == 4 && strings.Join(roles, ",") == "dasher,assistant,dasher,assistant", "after two exchanges conv:s1 holds four turns, dasher and assistant alternating; it holds %+v", turns)
	ctx.Assert(turns[2].Text == apiRedCardQ && turns[3].Text == data["answer"], "the second exchange must be appended after the first (RPUSH)")
	other := w.chat(ctx, "s2", "d1", apiReferralQ, 200)
	ctx.Assert(fmt.Sprint(other["turn"]) == "1" && len(apiHistory(ctx, "s2")) == 2, "another session starts at turn 1 with its own conv:<session_id>")
}

func CheckAnswerCache(ctx *harness.Ctx) {
	w := apiServe(ctx)
	first := w.chat(ctx, "s1", "d1", apiLoginQ, 200)
	calls := len(apiGenerates(ctx))
	queries := len(ctx.DB.Queries())
	again := w.chat(ctx, "s2", "d2", "  i FORGOT my   password and cannot SIGN in ", 200)
	ctx.Assert(again["cached"] == true, "the same question in different casing and spacing must be answered from the cache (cached: true), got %s", apiShow(again))
	ctx.Equal(again["model"], "cache", "a cached answer reports model \\"cache\\"")
	ctx.Assert(again["answer"] == first["answer"] && apiShow(again["sources"]) == apiShow(first["sources"]), "the cached answer must be the remembered answer and sources, got %s", apiShow(again))
	ctx.Assert(again["escalated"] == false && fmt.Sprint(again["turn"]) == "1", "a cached answer is escalated: false and still counts as a turn (turn 1 of s2), got %s", apiShow(again))
	ctx.Assert(len(apiGenerates(ctx)) == calls, "a cache hit must not call the model, yet %d Generate call(s) were made", len(apiGenerates(ctx))-calls)
	var searched []string
	for _, q := range ctx.DB.Queries()[queries:] {
		if strings.Contains(strings.ToLower(q.SQL), "kb_chunks") {
			searched = append(searched, q.SQL)
		}
	}
	ctx.Assert(len(searched) == 0, "a cache hit must not search kb_chunks, yet the request ran %q", searched)
	ctx.Equal(len(apiHistory(ctx, "s2")), 2, "a cached exchange is still appended to the session's history")
	w.llm.setMode("hallucinate")
	calls = len(apiGenerates(ctx))
	bad := w.chat(ctx, "s3", "d3", apiRedCardQ, 200)
	ctx.Assert(len(apiGenerates(ctx)) > calls, "a new question must reach the model")
	ctx.Assert(bad["escalated"] == true, "a hallucinated answer ([kb:policy-404] was never retrieved) must be escalated by the guardrail: escalated true, got %s", apiShow(bad))
	sources, isList := bad["sources"].([]any)
	ctx.Assert(bad["answer"] == config.HandoffText && isList && len(sources) == 0, "an escalated turn answers config.HandoffText with no sources, got %s", apiShow(bad))
	ctx.Assert(bad["cached"] == false && (bad["model"] == "large" || bad["model"] == "small"), "an escalated turn is not cached and reports the model that answered, got %s", apiShow(bad))
	for _, k := range ctx.Redis.Keys("answer:*") {
		v, _ := ctx.Redis.Get(k)
		ctx.Assert(!strings.Contains(v, "policy-404"), "the hallucinated answer must never be remembered")
	}
	turns := apiHistory(ctx, "s3")
	ctx.Assert(len(turns) > 0 && turns[len(turns)-1] == prompt.Turn{Role: "assistant", Text: config.HandoffText}, "the hand-off is what the Dasher saw, so it is the assistant turn in conv:s3; the history holds %+v", turns)
	calls = len(apiGenerates(ctx))
	twice := w.chat(ctx, "s4", "d4", apiRedCardQ, 200)
	ctx.Assert(len(apiGenerates(ctx)) > calls, "an escalation is never cached: the same question from another session must call the model again, it was answered without a call")
	ctx.Assert(twice["escalated"] == true && twice["cached"] == false, "still hallucinating, still escalated and uncached; got %s", apiShow(twice))
	ctx.Settle()
	var recorded []map[string]any
	for _, r := range apiRecords(ctx) {
		if r.value["session_id"] == "s3" {
			recorded = append(recorded, r.value)
		}
	}
	ctx.Assert(len(recorded) == 1 && recorded[0]["escalated"] == true && recorded[0]["answer"] == config.HandoffText, "an escalated turn is still recorded on %s with escalated true; found %s", config.Topic, apiShow(recorded))
}

func CheckRateLimit(ctx *harness.Ctx) {
	w := apiServe(ctx)
	limit := config.RateLimitPerMinute
	for i := range limit {
		data := w.chat(ctx, "s1", "d1", apiLoginQ, 200)
		ctx.Equal(data["turn"], i+1, "turn")
	}
	minute := ctx.Clock.Now() / 60000
	key := fmt.Sprintf("rl:d1:%d", minute)
	count, _ := ctx.Redis.Get(key)
	ctx.Assert(count == fmt.Sprint(limit), "the counter %s must be INCRed once per request (%d), Redis holds %q under %q", key, limit, count, ctx.Redis.Keys("rl:*"))
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(0 < ttl && ttl <= 60, "%s must EXPIRE within 60 s, its TTL is %d", key, ttl)
	r := w.http.Post("/chat", map[string]any{"session_id": "s1", "dasher_id": "d1", "message": apiLoginQ})
	ctx.Assert(r.Status == 429, "request %d of d1 within the minute answered %d %s, expected 429", limit+1, r.Status, r.Text())
	ctx.Equal(r.JSON(), map[string]any{"error": "rate_limited"}, "the 429 body must be {\\"error\\": \\"rate_limited\\"}")
	ctx.Equal(len(apiHistory(ctx, "s1")), 2*limit, "a limited request must not be appended to the history")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(config.Topic)), limit, "a limited request must not be recorded")
	other := w.chat(ctx, "s2", "d2", apiLoginQ, 200)
	ctx.Assert(other["answer"] != nil && other["answer"] != "", "the limit is per Dasher: d2 must still be answered")
	ctx.Clock.Advance(60)
	data := w.chat(ctx, "s1", "d1", apiLoginQ, 200)
	ctx.Assert(fmt.Sprint(data["turn"]) == fmt.Sprint(limit+1), "the first request of the next minute must be answered (turn %d), got %s", limit+1, apiShow(data))
	_, exists := ctx.Redis.Get(key)
	ctx.Assert(!exists, "the previous minute's counter %s must have expired", key)
}

func CheckRecorded(ctx *harness.Ctx) {
	w := apiServe(ctx)
	a := w.chat(ctx, "s1", "d1", apiLoginQ, 200)
	b := w.chat(ctx, "s1", "d1", apiRedCardQ, 200)
	c2 := w.chat(ctx, "s2", "d2", apiLoginQ, 200)
	ctx.Settle()
	recs := apiRecords(ctx)
	ctx.Assert(len(recs) == 3, "three answered turns must leave three records on %s, found %d", config.Topic, len(recs))
	var keys []string
	for _, r := range recs {
		keys = append(keys, r.key)
	}
	ctx.Equal(keys, []string{"s1", "s1", "s2"}, "records must be keyed by the session id")
	fields := []string{"session_id", "turn", "dasher_id", "question", "answer", "sources", "escalated", "model", "tokens"}
	for _, r := range recs {
		var missing []string
		for _, f := range fields {
			if _, ok := r.value[f]; !ok {
				missing = append(missing, f)
			}
		}
		ctx.Assert(len(missing) == 0, "a record must carry %q, this one lacks %q", fields, missing)
	}
	first, second, third := recs[0].value, recs[1].value, recs[2].value
	ctx.Assert(first["session_id"] == "s1" && fmt.Sprint(first["turn"]) == "1" && first["dasher_id"] == "d1" && first["question"] == apiLoginQ, "the first record is s1 turn 1 by d1 asking %q, got %s", apiLoginQ, apiShow(first))
	ctx.Assert(first["answer"] == a["answer"] && apiShow(first["sources"]) == apiShow(a["sources"]) && first["escalated"] == false && first["model"] == "large", "the record carries what the Dasher was answered: %s; got %s", apiShow(a), apiShow(first))
	answerText, _ := a["answer"].(string)
	ctx.Equal(first["tokens"], len(strings.Fields(answerText)), "tokens is the generate result's token count")
	ctx.Assert(fmt.Sprint(second["turn"]) == "2" && second["question"] == apiRedCardQ && second["answer"] == b["answer"], "the second record of s1 is turn 2, got %s", apiShow(second))
	ctx.Assert(third["session_id"] == "s2" && fmt.Sprint(third["turn"]) == "1" && third["model"] == "cache" && fmt.Sprint(third["tokens"]) == "0", "s2's first turn was a cache hit: turn 1, model \\"cache\\", tokens 0; got %s", apiShow(third))
	ctx.Assert(third["answer"] == c2["answer"] && third["escalated"] == false, "s2's cached turn carries the cached answer, escalated false; got %s", apiShow(third))
	ctx.Kafka.Stall(config.Topic) // the broker stops acknowledging
	before := ctx.Clock.Now()
	d := w.chat(ctx, "s2", "d2", apiReferralQ, 200)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited < 0.5, "with the broker stalled the reply took %.1f s of virtual time: hand the record to the writer in a goroutine and answer, never wait for the write on the request path", waited)
	ctx.Assert(fmt.Sprint(d["turn"]) == "2" && d["answer"] != nil && d["answer"] != "", "the reply must not depend on the broker, got %s", apiShow(d))
	ctx.Equal(len(apiRecords(ctx)), 3, "nothing can reach the topic while the broker is stalled: records")
	ctx.Kafka.Resume(config.Topic)
	ctx.Clock.Advance(30) // the producer's next attempt finds the broker back
	ctx.Settle()
	e := w.chat(ctx, "s1", "d1", apiReferralQ, 200)
	ctx.Equal(e["turn"], 3, "turn")
	ctx.Settle()
	recs = apiRecords(ctx)
	ctx.Assert(len(recs) == 5, "once the broker answers, the record handed to the writer during the stall must arrive: %s holds %d records, expected 5", config.Topic, len(recs))
	var turns []string
	for _, r := range recs {
		turns = append(turns, fmt.Sprintf("%v:%v", r.value["session_id"], r.value["turn"]))
	}
	sort.Strings(turns)
	ctx.Equal(turns, []string{"s1:1", "s1:2", "s1:3", "s2:1", "s2:2"}, "every turn once, numbered within its session")
}
`,
  },
  debrief: `The endpoint is thin on purpose: every decision that needs a model lives behind \`guardrail\`, and what the endpoint owns is the state a chat needs *around* a model. Memory lives in Redis rather than in the process because the next message of the same session will land on another replica, and it carries a TTL because a conversation is not a record — a day later the Dasher is talking about something else, and a list that grows forever is both a cost and a liability. The answer cache is keyed by the normalised question so that spelling and spacing do not defeat it, and it is written only for answers the guardrail let through: a hand-off is a statement about the model's failure, not about the question, and replaying it would turn one bad generation into a policy. The audit record is fire-and-forget for the same reason the exposure log was: the Kafka write is for the judge, not the Dasher, and a broker that is slow must cost the request path nothing. Grab's AI gateway makes the same split — per-caller limits in front of expensive calls, and every request and response flowing to the data platform as a side effect; LinkedIn's platform puts quotas and the record of each turn in the one service that fronts the models. What production adds: the limiter becomes a token bucket with a burst, the history is summarised when it grows past the model's context, the cache is invalidated when the knowledge base changes, and the record carries the retrieved chunk ids and the guardrail's scores so the offline judge sees exactly what the online one saw.`,
};
