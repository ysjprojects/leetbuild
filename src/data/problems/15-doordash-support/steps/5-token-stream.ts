import type {Step} from '@/lib/types';

// ---- 5. Streaming to the Dasher app: tokens as they come, guarded as they go ---------------------
export const tokenStreamStep: Step = {
  id: 'token-stream',
  title: 'Stream the answer: tokens as they come, guarded as they go',
  concept: 'grpc',
  file: 'stream',
  focus: ['chat', 'llm'],
  task: `## Task

A Dasher at a closed restaurant reads the first words of an answer while the rest is still being
written. The app opens \`Chat.Stream\` (\`support.proto\`) and the server relays the model's own
stream, \`Llm.Stream\`, token by token:

\`\`\`proto
service Chat { rpc Stream(ChatRequest) returns (stream ChatEvent); }
message ChatRequest { string session_id = 1; string dasher_id = 2; string message = 3; }
message ChatEvent  { string token = 1; bool done = 2; repeated string sources = 3; bool escalated = 4; string model = 5; }
service Llm  { rpc Stream(GenerateRequest) returns (stream Token); }   // Token { string text = 1; int32 index = 2; }
\`\`\`

Implement the \`Chat\` server on \`[::]:9000\` (\`serve()\` exported; the checks dial \`chat:9000\`). Per request:

- The conversation so far is the Redis list \`conv:<session_id>\` (JSON turns \`{role, text}\`, as step 1
  left it), the context is \`kb_search.search(message)\`, the prompt is \`prompt.build_prompt\` /
  \`buildPrompt(message, chunks, history)\` — the one format.
- \`Llm.Stream(model="large", prompt, max_tokens=MAX_TOKENS)\` on \`LLM_LARGE\` with a **deadline of
  \`DEADLINE_S\`** on the call. Relay every \`Token\` as a \`ChatEvent{token}\` **as it arrives** — never
  collect the whole answer first. The deadline is the budget for the **first** token: a large model that
  answers \`UNAVAILABLE\` before its first token gets the same prompt sent to \`LLM_SMALL\` with
  \`model="small"\`; a model that is silent past the deadline ends the chat stream with
  \`DEADLINE_EXCEEDED\` — two seconds are gone, a second model would start the budget over, and the app
  owns the retry.
- Every **8 tokens**, run tier 1 of the guardrail (\`guardrail.tier1\`, no RPC) on the text so far —
  **complete sentences only**: cut at the last \`.\`, \`!\` or \`?\`; an unfinished sentence looks unlike
  every chunk and would fail on its own. If it fails, **cancel** the model stream (the rest of the
  answer is never generated), send \`ChatEvent{done: true, escalated: true, sources: [], model}\` and end.
- When the model's stream ends, run the full \`guardrail.check(message, answer, chunks)\`. Pass →
  \`ChatEvent{done: true, sources: <the ids the answer cites>, escalated: false, model}\`; fail → the
  escalated done event.
- Before the done event, append both turns to \`conv:<session_id>\` (RPUSH, EXPIRE \`HISTORY_TTL_S\`): the
  assistant's turn is the full answer when it passed, \`HANDOFF_TEXT\` when it was escalated. A stream
  that failed with a status appends nothing.

:::widget grpc-streams {"mode": "server"}

> The guard that step 4 ran once on a finished answer now runs on a moving one. It cannot see a
> sentence before its full stop, so the invented sentence of a hallucinating model reaches the app
> before the handoff does — streaming trades that for a first token the Dasher sees in a tenth of the
> time. What it *can* do is stop paying for tokens nobody will read.`,
  sequence: {
    participants: ['Dasher app', 'Chat', 'Redis · Postgres', 'llm-large', 'judge'],
    messages: [
      {
        from: 'Dasher app',
        to: 'Chat',
        label: 'Chat.Stream(session s-7, "My red card was declined at the restaurant…")',
        kind: 'sync',
      },
      {
        from: 'Chat',
        to: 'Redis · Postgres',
        label: 'LRANGE conv:s-7 · nearest 4 chunks for the question',
        kind: 'sync',
      },
      {from: 'Chat', to: 'llm-large', label: 'Llm.Stream(large, prompt, max_tokens 120) · deadline 2 s', kind: 'sync'},
      {from: 'llm-large', to: 'Chat', label: 'Token "Based " · Token "on " · … (one every ~100 ms)', kind: 'reply'},
      {
        from: 'Chat',
        to: 'Dasher app',
        label: 'ChatEvent{token} as each arrives · tier 1 every 8 tokens',
        kind: 'reply',
      },
      {from: 'llm-large', to: 'Chat', label: 'end of stream (32 tokens)', kind: 'reply'},
      {from: 'Chat', to: 'judge', label: 'Evaluate(question, answer, context_ids)', kind: 'sync'},
      {from: 'Chat', to: 'Redis · Postgres', label: 'RPUSH conv:s-7 {dasher} {assistant} · EXPIRE 86400', kind: 'sync'},
      {
        from: 'Chat',
        to: 'Dasher app',
        label: 'ChatEvent{done, sources [red-card-0, red-card-1], model large}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Read the model stream one message at a time (`await call.read()` until `grpc.aio.EOF`; `call.on("data", …)` in TypeScript) and write a `ChatEvent{token}` inside that loop. Keep the text so far in a string and a token counter next to it: `count % 8 == 0` is where tier 1 runs.',
    'Tier 1 on a moving answer: `tier1(text[:text.rfind(terminator) + 1], chunks)` with the last of `.`, `!`, `?` — nothing to judge before the first full stop. A non-empty reasons list means `call.cancel()` on the model stream, `ok = False`, and out of the loop; the full `check` runs only when the stream ended by itself.',
    'The fallback is a condition on the error and the text: `UNAVAILABLE` *and* nothing relayed yet → open the same request on the small stub with `model="small"` and keep reading; any other status, or an error after tokens have gone out, becomes the chat stream\'s status (`await context.abort(code, details)` / `call.emit("error", {code, details})`). History and the done event share the outcome: `answer if ok else HANDOFF_TEXT`, `cited_ids(answer) if ok else []`.',
  ],
  checks: [
    {
      id: 'tokens-stream',
      title: 'Relays every token as it arrives, then a done event with the sources',
      detail:
        'The first `ChatEvent{token}` reaches the app while the model has produced only a few of its 32 tokens (the stand-in pauses 0.1 s of virtual time between tokens); the tokens joined equal the model\'s text; the done event says `sources: [red-card-0, red-card-1]`, `escalated: false`, `model: "large"`; the judge was asked once; both turns are on `conv:<session_id>` with a TTL.',
      match: {
        python: {
          all: [/ChatEvent\(token=/, /await \w+\.read\(\)|async for \w+ in /, /done=True/, /cited_ids\(/],
          order: [/ChatEvent\(token=/, /done=True/],
        },
        typescript: {
          all: [/call\.write\(\{token: /, /on\('data'|for await/, /done: true/, /citedIds\(/],
          order: [/call\.write\(\{token: /, /done: true/],
        },
        go: {
          all: [/srv\.Send\(&pb\.ChatEvent\{Token: /, /\.Recv\(\)/, /Done:\s*true/, /prompt\.CitedIds\(/],
          order: [/\{Token: /, /Done:\s*true/],
        },
        scala: {
          all: [/observer\.onNext\(ChatEvent\(token = /, /\.hasNext/, /done = true/, /Prompt\.citedIds\(/],
          order: [/ChatEvent\(token = /, /done = true/],
        },
        cpp: {
          all: [/writer->Write\(/, /reader->Read\(&token\)/, /set_done\(true\)/, /assistant::cited_ids\(/],
          order: [/set_token\(/, /set_done\(true\)/],
        },
      },
    },
    {
      id: 'prompt',
      title: 'The prompt carries the history and the retrieved chunks',
      detail:
        'The request to `LLM_LARGE` says `model: "large"`, `max_tokens: MAX_TOKENS`, and its prompt is exactly `build_prompt(message, search(message), history)`: a `[kb:<id>] <text>` line per chunk the knowledge base ranks nearest, the turns of `conv:<session_id>` in order, the question.',
      match: {
        python: {
          all: [
            /lrange\(f"conv:/,
            /kb_search\.search\(/,
            /build_prompt\(/,
            /"large"/,
            /max_tokens\s*=\s*(config\.)?MAX_TOKENS/,
          ],
        },
        typescript: {all: [/lrange\(`conv:/, /\bsearch\(/, /buildPrompt\(/, /'large'/, /max_tokens: MAX_TOKENS/]},
        go: {all: [/LRange\(/, /(?<!func )search\(/, /prompt\.Build\(/, /"large"/, /MaxTokens:\s*config\.MaxTokens/]},
        scala: {
          all: [/jedis\.lrange\(/, /KbSearch\.search\(/, /Prompt\.build\(/, /"large"/, /maxTokens = Config\.MaxTokens/],
        },
        cpp: {
          all: [
            /lrange\(/,
            /= search\(/,
            /assistant::build_prompt\(/,
            /"large"/,
            /set_max_tokens\(config::kMaxTokens\)/,
          ],
        },
      },
    },
    {
      id: 'guard-mid-stream',
      title: 'Tier 1 every 8 tokens on complete sentences; a failure cancels the model',
      detail:
        "A verbose model follows the grounded sentence (32 tokens) with filler unlike any chunk. The filler's first sentence completes at token 44, so the guard fires at token 48 — not at 40, when that sentence was still unfinished: the app sees 41–48 tokens, then an escalated done event; the model stream was cancelled (the stand-in produced far fewer than its 120 tokens), the judge was never asked, the history holds `HANDOFF_TEXT`.",
      match: {
        python: {all: [/% GUARD_EVERY|% 8\b/, /tier1\(/, /\.cancel\(\)/, /complete_sentences\(/]},
        typescript: {all: [/% GUARD_EVERY|% 8\b/, /tier1\(/, /\.cancel\(\)/, /completeSentences\(/]},
        go: {all: [/%\s*guardEvery|% 8\b/, /(?<!func )tier1\(/, /cancel\(\)/, /completeSentences\(/]},
        scala: {all: [/% GuardEvery|% 8\b/, /Guardrail\.tier1\(/, /\.cancel\(/, /completeSentences\(/]},
        cpp: {all: [/% kGuardEvery|% 8\b/, /(?<!\w)tier1\(/, /TryCancel\(\)/, /complete_sentences\(/]},
      },
    },
    {
      id: 'guard-at-end',
      title: 'The full check when the stream ends; a failure escalates and is remembered as the handoff',
      detail:
        "A hallucinating model's 10 tokens cite `[kb:policy-404]` in a sentence that completes only at the end: all 10 are relayed, then the full check fails tier 1 — no judge call — and the done event is `escalated: true, sources: []`; `conv:<session_id>` ends with the dasher's question and `HANDOFF_TEXT`, with a TTL of `HISTORY_TTL_S`.",
      match: {
        python: {all: [/await check\(/, /HANDOFF_TEXT/, /escalated=/, /rpush\(/, /expire\(/]},
        typescript: {all: [/await check\(/, /HANDOFF_TEXT/, /escalated: /, /rpush\(/, /expire\(/]},
        go: {all: [/(?<!func )check\(/, /config\.HandoffText/, /Escalated:\s*/, /RPush\(/, /Expire\(/]},
        scala: {all: [/Guardrail\.check\(/, /Config\.HandoffText/, /escalated = /, /rpush\(/, /expire\(/]},
        cpp: {all: [/(?<!\w)check\(/, /config::kHandoffText/, /set_escalated\(/, /rpush\(/, /expire\(/]},
      },
    },
    {
      id: 'fallback-deadline',
      title: 'UNAVAILABLE before the first token streams from the small model; a silent model is DEADLINE_EXCEEDED',
      detail:
        'The large model answering `UNAVAILABLE` means one `Llm.Stream` to `LLM_SMALL` with `model: "small"` and the same prompt — no retry on the large one — and a done event saying `model: "small"`. A large model silent for 3 s ends the chat stream with `DEADLINE_EXCEEDED` after `DEADLINE_S` (2 s of virtual time, not 3), without a call to the small model and without touching the history.',
      match: {
        python: {all: [/timeout\s*=\s*(config\.)?DEADLINE_S/, /StatusCode\.UNAVAILABLE/, /"small"/, /LLM_SMALL/]},
        typescript: {
          all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_S/, /status\.UNAVAILABLE/, /'small'/, /LLM_SMALL/],
        },
        go: {all: [/context\.WithTimeout\(/, /DeadlineS/, /codes\.Unavailable/, /"small"/, /LLMSmall/]},
        scala: {all: [/withDeadlineAfter\(/, /DeadlineS/, /Code\.UNAVAILABLE/, /"small"/, /LlmSmall/]},
        cpp: {all: [/set_deadline\(/, /kDeadline\b/, /StatusCode::UNAVAILABLE/, /"small"/, /kLlmSmall/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go."""
import asyncio
import json

import grpc
import redis

import kb_search
import support_pb2
import support_pb2_grpc
from assistant import config
from assistant.prompt import build_prompt, cited_ids
from guardrail import check, tier1

GUARD_EVERY = 8  # tokens between two runs of tier 1 on the text so far

r = redis.Redis(host="redis", port=6379, decode_responses=True)
large = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_LARGE))
small = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_SMALL))


def history(session_id: str) -> list[dict]:
    """The conversation so far: the JSON turns of conv:<session_id>, oldest first."""
    return [json.loads(t) for t in r.lrange(f"conv:{session_id}", 0, -1)]


def remember(session_id: str, question: str, answer: str) -> None:
    """Both turns onto conv:<session_id>, with the history's TTL."""
    # TODO: RPUSH {"role": "dasher", "text": question} and {"role": "assistant", "text": answer}; EXPIRE config.HISTORY_TTL_S
    raise NotImplementedError


def complete_sentences(text: str) -> str:
    """The text up to its last . ! or ? — what tier 1 may judge mid-stream."""
    end = max(text.rfind(c) for c in ".!?")
    return text[: end + 1] if end >= 0 else ""


def open_stream(stub, model: str, prompt: str):
    """One Llm.Stream call: the request with max_tokens from config, the deadline on the call."""
    # TODO: stub.Stream(GenerateRequest(model, prompt, max_tokens), timeout=config.DEADLINE_S)
    raise NotImplementedError


class ChatService(support_pb2_grpc.ChatServicer):
    async def Stream(self, request, context: grpc.aio.ServicerContext):
        # TODO: history(session_id), kb_search.search(message), build_prompt → open_stream(large, "large", prompt)
        # TODO: read token by token: text += token.text, yield ChatEvent(token=…) at once
        # TODO:   UNAVAILABLE before any token → open_stream(small, "small", prompt); any other status → context.abort(code, details)
        # TODO:   every GUARD_EVERY tokens: tier1(complete_sentences(text), chunks) → reasons mean cancel() the stream, ok = False
        # TODO: ended by itself → ok = (await check(message, text, chunks))["ok"]
        # TODO: remember(session_id, message, text if ok else HANDOFF_TEXT); yield ChatEvent(done=True, sources, escalated, model)
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")
        yield support_pb2.ChatEvent()


async def serve() -> None:
    server = grpc.aio.server()
    support_pb2_grpc.add_ChatServicer_to_server(ChatService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `"""Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go."""
import asyncio
import json

import grpc
import redis

import kb_search
import support_pb2
import support_pb2_grpc
from assistant import config
from assistant.prompt import build_prompt, cited_ids
from guardrail import check, tier1

GUARD_EVERY = 8  # tokens between two runs of tier 1 on the text so far

r = redis.Redis(host="redis", port=6379, decode_responses=True)
large = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_LARGE))
small = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_SMALL))


def history(session_id: str) -> list[dict]:
    """The conversation so far: the JSON turns of conv:<session_id>, oldest first."""
    return [json.loads(t) for t in r.lrange(f"conv:{session_id}", 0, -1)]


def remember(session_id: str, question: str, answer: str) -> None:
    """Both turns onto conv:<session_id>, with the history's TTL."""
    key = f"conv:{session_id}"
    r.rpush(key, json.dumps({"role": "dasher", "text": question}), json.dumps({"role": "assistant", "text": answer}))
    r.expire(key, config.HISTORY_TTL_S)


def complete_sentences(text: str) -> str:
    """The text up to its last . ! or ? — what tier 1 may judge mid-stream."""
    end = max(text.rfind(c) for c in ".!?")
    return text[: end + 1] if end >= 0 else ""


def open_stream(stub, model: str, prompt: str):
    """One Llm.Stream call: the request with max_tokens from config, the deadline on the call."""
    request = support_pb2.GenerateRequest(model=model, prompt=prompt, max_tokens=config.MAX_TOKENS)
    return stub.Stream(request, timeout=config.DEADLINE_S)


class ChatService(support_pb2_grpc.ChatServicer):
    async def Stream(self, request, context: grpc.aio.ServicerContext):
        question = request.message
        chunks = await kb_search.search(question)
        prompt = build_prompt(question, chunks, history(request.session_id))
        model = "large"
        call = open_stream(large, model, prompt)
        text = ""
        count = 0
        ok = True
        while True:
            try:
                token = await call.read()
            except grpc.RpcError as e:
                # UNAVAILABLE before the first token: the same prompt to the small model. Once tokens
                # have gone out there is nothing to retry, and a deadline is the app's to spend again.
                if e.code() == grpc.StatusCode.UNAVAILABLE and not text:
                    model = "small"
                    call = open_stream(small, model, prompt)
                    continue
                await context.abort(e.code(), e.details())
            if token is grpc.aio.EOF:
                break
            text += token.text
            count += 1
            yield support_pb2.ChatEvent(token=token.text)
            if count % GUARD_EVERY == 0 and tier1(complete_sentences(text), chunks):
                call.cancel()  # the rest of the answer is never generated
                ok = False
                break
        if ok:
            ok = (await check(question, text, chunks))["ok"]
        remember(request.session_id, question, text if ok else config.HANDOFF_TEXT)
        yield support_pb2.ChatEvent(done=True, sources=cited_ids(text) if ok else [], escalated=not ok, model=model)


async def serve() -> None:
    server = grpc.aio.server()
    support_pb2_grpc.add_ChatServicer_to_server(ChatService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
    },
    typescript: {
      starter: `/** Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {DEADLINE_S, HANDOFF_TEXT, HISTORY_TTL_S, LLM_LARGE, LLM_SMALL, MAX_TOKENS} from 'assistant/config';
import {buildPrompt, citedIds} from 'assistant/prompt';
import type {Chunk, Turn} from 'assistant/prompt';
import {check, tier1} from './guardrail';
import {search} from './kb_search';

export const GUARD_EVERY = 8; // tokens between two runs of tier 1 on the text so far

const redis = new Redis({host: 'redis', port: 6379});

export interface ChatRequest {
  session_id: string;
  dasher_id: string;
  message: string;
}
export interface ChatEvent {
  token?: string;
  done?: boolean;
  sources?: string[];
  escalated?: boolean;
  model?: string;
}
interface Token {
  text: string;
  index: number;
}
interface LlmClient {
  Stream(request: {model: string; prompt: string; max_tokens: number}, options: {deadline: number}): grpc.ClientReadableStream<Token>;
}

const {support} = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Chat: grpc.ServiceClientConstructor; Llm: new (target: string, credentials: grpc.ChannelCredentials) => LlmClient};
};
const large = new support.Llm(LLM_LARGE, grpc.credentials.createInsecure());
const small = new support.Llm(LLM_SMALL, grpc.credentials.createInsecure());

/** The conversation so far: the JSON turns of conv:<session_id>, oldest first. */
export async function history(sessionId: string): Promise<Turn[]> {
  return (await redis.lrange(\`conv:\${sessionId}\`, 0, -1)).map(t => JSON.parse(t) as Turn);
}

/** Both turns onto conv:<session_id>, with the history's TTL. */
export async function remember(sessionId: string, question: string, answer: string): Promise<void> {
  // TODO: RPUSH {role: 'dasher', text: question} and {role: 'assistant', text: answer}; EXPIRE HISTORY_TTL_S
  throw new Error('not implemented');
}

/** The text up to its last . ! or ? — what tier 1 may judge mid-stream. */
export function completeSentences(text: string): string {
  const end = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
  return end >= 0 ? text.slice(0, end + 1) : '';
}

/**
 * One Llm.Stream call relayed token by token: \`onToken\` returning false cancels it. Resolves when the
 * stream ends or was cancelled; rejects with the stream's status otherwise.
 */
function relay(client: LlmClient, model: string, prompt: string, onToken: (token: Token) => boolean): Promise<void> {
  // TODO: client.Stream({model, prompt, max_tokens}, {deadline: DEADLINE_S from now})
  // TODO: on('data') → onToken; false → call.cancel(); on('end') resolve; on('error') reject unless cancelled
  throw new Error('not implemented');
}

export async function stream(call: grpc.ServerWritableStream<ChatRequest, ChatEvent>): Promise<void> {
  // TODO: history(session_id), search(message), buildPrompt → relay(large, 'large', prompt, onToken)
  // TODO: onToken: text += token.text, call.write({token}) at once; every GUARD_EVERY tokens tier1(completeSentences(text), chunks) → reasons mean ok = false and stop
  // TODO: UNAVAILABLE before any token → relay(small, 'small', prompt, onToken); any other error → throw
  // TODO: ended by itself → ok = (await check(message, text, chunks)).ok
  // TODO: remember(session_id, message, ok ? text : HANDOFF_TEXT); call.write({done: true, sources, escalated, model}); call.end()
  throw new Error('not implemented');
}

export const chatService = {
  Stream(call: grpc.ServerWritableStream<ChatRequest, ChatEvent>): void {
    stream(call).catch((e: Partial<grpc.ServiceError>) =>
      call.emit('error', {code: e.code ?? grpc.status.INTERNAL, details: e.details ?? e.message ?? ''}),
    );
  },
};

export function serve(): grpc.Server {
  const server = new grpc.Server();
  server.addService(support.Chat.service, chatService);
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => undefined);
  return server;
}
`,
      solution: `/** Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {DEADLINE_S, HANDOFF_TEXT, HISTORY_TTL_S, LLM_LARGE, LLM_SMALL, MAX_TOKENS} from 'assistant/config';
import {buildPrompt, citedIds} from 'assistant/prompt';
import type {Chunk, Turn} from 'assistant/prompt';
import {check, tier1} from './guardrail';
import {search} from './kb_search';

export const GUARD_EVERY = 8; // tokens between two runs of tier 1 on the text so far

const redis = new Redis({host: 'redis', port: 6379});

export interface ChatRequest {
  session_id: string;
  dasher_id: string;
  message: string;
}
export interface ChatEvent {
  token?: string;
  done?: boolean;
  sources?: string[];
  escalated?: boolean;
  model?: string;
}
interface Token {
  text: string;
  index: number;
}
interface LlmClient {
  Stream(request: {model: string; prompt: string; max_tokens: number}, options: {deadline: number}): grpc.ClientReadableStream<Token>;
}

const {support} = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Chat: grpc.ServiceClientConstructor; Llm: new (target: string, credentials: grpc.ChannelCredentials) => LlmClient};
};
const large = new support.Llm(LLM_LARGE, grpc.credentials.createInsecure());
const small = new support.Llm(LLM_SMALL, grpc.credentials.createInsecure());

/** The conversation so far: the JSON turns of conv:<session_id>, oldest first. */
export async function history(sessionId: string): Promise<Turn[]> {
  return (await redis.lrange(\`conv:\${sessionId}\`, 0, -1)).map(t => JSON.parse(t) as Turn);
}

/** Both turns onto conv:<session_id>, with the history's TTL. */
export async function remember(sessionId: string, question: string, answer: string): Promise<void> {
  const key = \`conv:\${sessionId}\`;
  await redis.rpush(key, JSON.stringify({role: 'dasher', text: question}), JSON.stringify({role: 'assistant', text: answer}));
  await redis.expire(key, HISTORY_TTL_S);
}

/** The text up to its last . ! or ? — what tier 1 may judge mid-stream. */
export function completeSentences(text: string): string {
  const end = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
  return end >= 0 ? text.slice(0, end + 1) : '';
}

/**
 * One Llm.Stream call relayed token by token: \`onToken\` returning false cancels it. Resolves when the
 * stream ends or was cancelled; rejects with the stream's status otherwise.
 */
function relay(client: LlmClient, model: string, prompt: string, onToken: (token: Token) => boolean): Promise<void> {
  const call = client.Stream({model, prompt, max_tokens: MAX_TOKENS}, {deadline: Date.now() + DEADLINE_S * 1000});
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  let cancelled = false;
  call.on('data', (token: Token) => {
    if (cancelled || onToken(token)) return;
    cancelled = true;
    call.cancel(); // the rest of the answer is never generated
  });
  call.on('error', (e: grpc.ServiceError) => (cancelled ? resolve() : reject(e)));
  call.on('end', resolve);
  return promise;
}

export async function stream(call: grpc.ServerWritableStream<ChatRequest, ChatEvent>): Promise<void> {
  const {session_id, message} = call.request;
  const past = await history(session_id);
  const chunks: Chunk[] = await search(message);
  const prompt = buildPrompt(message, chunks, past);
  let model = 'large';
  let text = '';
  let count = 0;
  let ok = true;
  const onToken = (token: Token): boolean => {
    text += token.text;
    count += 1;
    call.write({token: token.text});
    if (count % GUARD_EVERY === 0 && tier1(completeSentences(text), chunks).length > 0) ok = false;
    return ok;
  };
  try {
    await relay(large, model, prompt, onToken);
  } catch (e) {
    // UNAVAILABLE before the first token: the same prompt to the small model. Once tokens have gone
    // out there is nothing to retry, and a deadline is the app's to spend again.
    if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE || text !== '') throw e;
    model = 'small';
    await relay(small, model, prompt, onToken);
  }
  if (ok) ok = (await check(message, text, chunks)).ok;
  await remember(session_id, message, ok ? text : HANDOFF_TEXT);
  call.write({done: true, sources: ok ? citedIds(text) : [], escalated: !ok, model});
  call.end();
}

export const chatService = {
  Stream(call: grpc.ServerWritableStream<ChatRequest, ChatEvent>): void {
    stream(call).catch((e: Partial<grpc.ServiceError>) =>
      call.emit('error', {code: e.code ?? grpc.status.INTERNAL, details: e.details ?? e.message ?? ''}),
    );
  },
};

export function serve(): grpc.Server {
  const server = new grpc.Server();
  server.addService(support.Chat.service, chatService);
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => undefined);
  return server;
}
`,
    },
    go: {
      starter: `// Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config" // config.LLMLarge, LLMSmall, MaxTokens, DeadlineS, HistoryTTL (seconds), HandoffText, TopK — provided
	"assistant/prompt" // prompt.Build(question, chunks, history), prompt.CitedIds(answer), prompt.Chunk, prompt.Turn — provided
	pb "assistant/gen/support"
)

// guardEvery is how many tokens pass between two runs of tier 1 on the text so far.
const guardEvery = 8

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func dial(target string) pb.LlmClient {
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	return pb.NewLlmClient(conn)
}

var large = dial(config.LLMLarge)
var small = dial(config.LLMSmall)

// history is the conversation so far: the JSON turns of conv:<session>, oldest first.
func history(ctx context.Context, sessionID string) ([]prompt.Turn, error) {
	raw, err := rdb.LRange(ctx, "conv:"+sessionID, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	turns := make([]prompt.Turn, 0, len(raw))
	for _, r := range raw {
		var t prompt.Turn
		if err := json.Unmarshal([]byte(r), &t); err != nil {
			return nil, err
		}
		turns = append(turns, t)
	}
	return turns, nil
}

// remember appends both turns to conv:<session> and sets the history's TTL.
func remember(ctx context.Context, sessionID, question, answer string) error {
	// TODO: RPUSH {"role": "dasher", "text": question} and {"role": "assistant", "text": answer}; EXPIRE config.HistoryTTL seconds
	return errors.New("not implemented")
}

// completeSentences is the text up to its last . ! or ? — what tier 1 may judge mid-stream.
func completeSentences(text string) string {
	end := strings.LastIndexAny(text, ".!?")
	if end < 0 {
		return ""
	}
	return text[:end+1]
}

// open starts one Llm.Stream with the deadline on the call; the CancelFunc stops it.
func open(ctx context.Context, client pb.LlmClient, model, text string) (pb.Llm_StreamClient, context.CancelFunc, error) {
	// TODO: GenerateRequest{model, text, config.MaxTokens} on a context that expires after config.DeadlineS
	_ = client
	return nil, nil, errors.New("not implemented")
}

type chatServer struct {
	pb.UnimplementedChatServer
}

func (s *chatServer) Stream(req *pb.ChatRequest, srv pb.Chat_StreamServer) error {
	// TODO: history(session_id), search(message, config.TopK) as prompt.Chunks, prompt.Build → open(large, "large", text)
	// TODO: Recv token by token: answer += token, srv.Send(&pb.ChatEvent{Token: …}) at once
	// TODO:   codes.Unavailable before any token → open(small, "small", text); any other error → return it
	// TODO:   every guardEvery tokens: tier1(completeSentences(answer), chunks) → reasons mean cancel(), ok = false
	// TODO: io.EOF → ok = check(ctx, message, answer, chunks).OK
	// TODO: remember(session_id, message, answer or config.HandoffText); Send(&pb.ChatEvent{Done: true, Sources, Escalated, Model})
	return status.Error(codes.Unimplemented, "not implemented")
}

func serve() error {
	lis, err := net.Listen("tcp", "[::]:9000")
	if err != nil {
		return err
	}
	s := grpc.NewServer()
	pb.RegisterChatServer(s, &chatServer{})
	return s.Serve(lis)
}

func main() {
	log.Fatal(serve())
}
`,
      solution: `// Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config" // config.LLMLarge, LLMSmall, MaxTokens, DeadlineS, HistoryTTL (seconds), HandoffText, TopK — provided
	"assistant/prompt" // prompt.Build(question, chunks, history), prompt.CitedIds(answer), prompt.Chunk, prompt.Turn — provided
	pb "assistant/gen/support"
)

// guardEvery is how many tokens pass between two runs of tier 1 on the text so far.
const guardEvery = 8

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func dial(target string) pb.LlmClient {
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	return pb.NewLlmClient(conn)
}

var large = dial(config.LLMLarge)
var small = dial(config.LLMSmall)

// history is the conversation so far: the JSON turns of conv:<session>, oldest first.
func history(ctx context.Context, sessionID string) ([]prompt.Turn, error) {
	raw, err := rdb.LRange(ctx, "conv:"+sessionID, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	turns := make([]prompt.Turn, 0, len(raw))
	for _, r := range raw {
		var t prompt.Turn
		if err := json.Unmarshal([]byte(r), &t); err != nil {
			return nil, err
		}
		turns = append(turns, t)
	}
	return turns, nil
}

// remember appends both turns to conv:<session> and sets the history's TTL.
func remember(ctx context.Context, sessionID, question, answer string) error {
	key := "conv:" + sessionID
	dasher, _ := json.Marshal(prompt.Turn{Role: "dasher", Text: question})
	assistant, _ := json.Marshal(prompt.Turn{Role: "assistant", Text: answer})
	if err := rdb.RPush(ctx, key, dasher, assistant).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, time.Duration(config.HistoryTTL)*time.Second).Err()
}

// completeSentences is the text up to its last . ! or ? — what tier 1 may judge mid-stream.
func completeSentences(text string) string {
	end := strings.LastIndexAny(text, ".!?")
	if end < 0 {
		return ""
	}
	return text[:end+1]
}

// open starts one Llm.Stream with the deadline on the call; the CancelFunc stops it.
func open(ctx context.Context, client pb.LlmClient, model, text string) (pb.Llm_StreamClient, context.CancelFunc, error) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(config.DeadlineS*float64(time.Second)))
	stream, err := client.Stream(callCtx, &pb.GenerateRequest{Model: model, Prompt: text, MaxTokens: config.MaxTokens})
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return stream, cancel, nil
}

type chatServer struct {
	pb.UnimplementedChatServer
}

func (s *chatServer) Stream(req *pb.ChatRequest, srv pb.Chat_StreamServer) error {
	ctx := srv.Context()
	past, err := history(ctx, req.GetSessionId())
	if err != nil {
		return err
	}
	hits, err := search(ctx, req.GetMessage(), config.TopK)
	if err != nil {
		return err
	}
	chunks := make([]prompt.Chunk, len(hits))
	for i, h := range hits {
		chunks[i] = prompt.Chunk{ID: h.ID, Text: h.Text}
	}
	text := prompt.Build(req.GetMessage(), chunks, past)
	model := "large"
	stream, cancel, err := open(ctx, large, model, text)
	if err != nil {
		return err
	}
	defer func() { cancel() }()
	var answer strings.Builder
	count := 0
	ok := true
	for {
		token, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// UNAVAILABLE before the first token: the same prompt to the small model. Once tokens
			// have gone out there is nothing to retry, and a deadline is the app's to spend again.
			if status.Code(err) == codes.Unavailable && answer.Len() == 0 {
				cancel()
				model = "small"
				if stream, cancel, err = open(ctx, small, model, text); err != nil {
					return err
				}
				continue
			}
			return err
		}
		answer.WriteString(token.GetText())
		count++
		if err := srv.Send(&pb.ChatEvent{Token: token.GetText()}); err != nil {
			return err
		}
		if count%guardEvery == 0 && len(tier1(completeSentences(answer.String()), chunks)) > 0 {
			cancel() // the rest of the answer is never generated
			ok = false
			break
		}
	}
	if ok {
		ok = check(ctx, req.GetMessage(), answer.String(), chunks).OK
	}
	final, sources := config.HandoffText, []string{}
	if ok {
		final, sources = answer.String(), prompt.CitedIds(answer.String())
	}
	if err := remember(ctx, req.GetSessionId(), req.GetMessage(), final); err != nil {
		return err
	}
	return srv.Send(&pb.ChatEvent{Done: true, Sources: sources, Escalated: !ok, Model: model})
}

func serve() error {
	lis, err := net.Listen("tcp", "[::]:9000")
	if err != nil {
		return err
	}
	s := grpc.NewServer()
	pb.RegisterChatServer(s, &chatServer{})
	return s.Serve(lis)
}

func main() {
	log.Fatal(serve())
}
`,
    },
    scala: {
      starter: `/** Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go. */
import java.util.concurrent.TimeUnit
import scala.concurrent.ExecutionContext
import scala.jdk.CollectionConverters._

import io.grpc.{Context, ManagedChannelBuilder, ServerBuilder, Status, StatusRuntimeException}
import io.grpc.stub.StreamObserver
import play.api.libs.json.Json
import redis.clients.jedis.JedisPooled

import assistant.{Config, Prompt} // Config.LlmLarge, LlmSmall, MaxTokens, DeadlineS, HistoryTtlS, HandoffText, TopK · Prompt.build, Prompt.citedIds, Prompt.Chunk, Prompt.Turn
import support.support.{ChatEvent, ChatGrpc, ChatRequest, GenerateRequest, LlmGrpc, Token}

object Stream {
  /** How many tokens pass between two runs of tier 1 on the text so far. */
  val GuardEvery = 8
  val jedis = new JedisPooled("redis", 6379)

  private def stub(target: String): LlmGrpc.LlmBlockingStub = {
    val Array(host, port) = target.split(":")
    LlmGrpc.blockingStub(ManagedChannelBuilder.forAddress(host, port.toInt).usePlaintext().build())
  }
  private val large = stub(Config.LlmLarge)
  private val small = stub(Config.LlmSmall)

  /** The conversation so far: the JSON turns of conv:<session>, oldest first. */
  def history(sessionId: String): Seq[Prompt.Turn] =
    jedis.lrange(s"conv:$sessionId", 0, -1).asScala.toSeq.map { raw =>
      val js = Json.parse(raw)
      Prompt.Turn((js \\ "role").as[String], (js \\ "text").as[String])
    }

  /** Both turns onto conv:<session>, with the history's TTL. */
  def remember(sessionId: String, question: String, answer: String): Unit = {
    // TODO: RPUSH {"role": "dasher", "text": question} and {"role": "assistant", "text": answer}; EXPIRE Config.HistoryTtlS
    ???
  }

  /** The text up to its last . ! or ? — what tier 1 may judge mid-stream. */
  def completeSentences(text: String): String = {
    val end = text.lastIndexWhere(c => c == '.' || c == '!' || c == '?')
    if (end < 0) "" else text.substring(0, end + 1)
  }

  /** One Llm.Stream inside a cancellable context, the deadline on the call: cancelling the context stops the model. */
  private def open(stub: LlmGrpc.LlmBlockingStub, model: String, prompt: String): (Context.CancellableContext, java.util.Iterator[Token]) = {
    // TODO: Context.current().withCancellation(); inside it, GenerateRequest(model, prompt, Config.MaxTokens) with withDeadlineAfter(Config.DeadlineS)
    ???
  }

  class ChatService extends ChatGrpc.Chat {
    override def stream(request: ChatRequest, observer: StreamObserver[ChatEvent]): Unit = {
      // TODO: history(sessionId), KbSearch.search(message, Config.TopK) as Prompt.Chunks, Prompt.build → open(large, "large", prompt)
      // TODO: read token by token: answer += token.text, observer.onNext(ChatEvent(token = …)) at once
      // TODO:   UNAVAILABLE before any token → open(small, "small", prompt); any other status → observer.onError
      // TODO:   every GuardEvery tokens: Guardrail.tier1(completeSentences(answer), chunks) → reasons mean cancel the context, ok = false
      // TODO: ended by itself → ok = Guardrail.check(message, answer, chunks).ok
      // TODO: remember(sessionId, message, answer or Config.HandoffText); onNext(ChatEvent(done = true, sources, escalated, model)); onCompleted
      observer.onError(Status.UNIMPLEMENTED.withDescription("not implemented").asRuntimeException())
    }
  }

  def serve(): Unit =
    ServerBuilder.forPort(9000).addService(ChatGrpc.bindService(new ChatService, ExecutionContext.global)).build().start().awaitTermination()

  def main(args: Array[String]): Unit = serve()
}
`,
      solution: `/** Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go. */
import java.util.concurrent.TimeUnit
import scala.concurrent.ExecutionContext
import scala.jdk.CollectionConverters._

import io.grpc.{Context, ManagedChannelBuilder, ServerBuilder, Status, StatusRuntimeException}
import io.grpc.stub.StreamObserver
import play.api.libs.json.Json
import redis.clients.jedis.JedisPooled

import assistant.{Config, Prompt} // Config.LlmLarge, LlmSmall, MaxTokens, DeadlineS, HistoryTtlS, HandoffText, TopK · Prompt.build, Prompt.citedIds, Prompt.Chunk, Prompt.Turn
import support.support.{ChatEvent, ChatGrpc, ChatRequest, GenerateRequest, LlmGrpc, Token}

object Stream {
  /** How many tokens pass between two runs of tier 1 on the text so far. */
  val GuardEvery = 8
  val jedis = new JedisPooled("redis", 6379)

  private def stub(target: String): LlmGrpc.LlmBlockingStub = {
    val Array(host, port) = target.split(":")
    LlmGrpc.blockingStub(ManagedChannelBuilder.forAddress(host, port.toInt).usePlaintext().build())
  }
  private val large = stub(Config.LlmLarge)
  private val small = stub(Config.LlmSmall)

  /** The conversation so far: the JSON turns of conv:<session>, oldest first. */
  def history(sessionId: String): Seq[Prompt.Turn] =
    jedis.lrange(s"conv:$sessionId", 0, -1).asScala.toSeq.map { raw =>
      val js = Json.parse(raw)
      Prompt.Turn((js \\ "role").as[String], (js \\ "text").as[String])
    }

  /** Both turns onto conv:<session>, with the history's TTL. */
  def remember(sessionId: String, question: String, answer: String): Unit = {
    val key = s"conv:$sessionId"
    jedis.rpush(key, Json.obj("role" -> "dasher", "text" -> question).toString, Json.obj("role" -> "assistant", "text" -> answer).toString)
    jedis.expire(key, Config.HistoryTtlS)
  }

  /** The text up to its last . ! or ? — what tier 1 may judge mid-stream. */
  def completeSentences(text: String): String = {
    val end = text.lastIndexWhere(c => c == '.' || c == '!' || c == '?')
    if (end < 0) "" else text.substring(0, end + 1)
  }

  /** One Llm.Stream inside a cancellable context, the deadline on the call: cancelling the context stops the model. */
  private def open(stub: LlmGrpc.LlmBlockingStub, model: String, prompt: String): (Context.CancellableContext, java.util.Iterator[Token]) = {
    val cancellable = Context.current().withCancellation()
    val tokens = cancellable.call { () =>
      stub
        .withDeadlineAfter((Config.DeadlineS * 1000).toLong, TimeUnit.MILLISECONDS)
        .stream(GenerateRequest(model = model, prompt = prompt, maxTokens = Config.MaxTokens))
    }
    (cancellable, tokens)
  }

  class ChatService extends ChatGrpc.Chat {
    override def stream(request: ChatRequest, observer: StreamObserver[ChatEvent]): Unit = {
      val past = history(request.sessionId)
      val chunks = KbSearch.search(request.message, Config.TopK).map(h => Prompt.Chunk(h.id, h.text))
      val prompt = Prompt.build(request.message, chunks, past)
      var model = "large"
      var (cancellable, tokens) = open(large, model, prompt)
      val answer = new StringBuilder
      var count = 0
      var ok = true
      try {
        var streaming = true
        while (streaming) {
          val next =
            try if (tokens.hasNext) Some(tokens.next()) else None
            catch {
              // UNAVAILABLE before the first token: the same prompt to the small model. Once tokens
              // have gone out there is nothing to retry, and a deadline is the app's to spend again.
              case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE && answer.isEmpty =>
                model = "small"
                val opened = open(small, model, prompt)
                cancellable = opened._1
                tokens = opened._2
                if (tokens.hasNext) Some(tokens.next()) else None
            }
          next match {
            case None => streaming = false
            case Some(token) =>
              answer.append(token.text)
              count += 1
              observer.onNext(ChatEvent(token = token.text))
              if (count % GuardEvery == 0 && Guardrail.tier1(completeSentences(answer.toString), chunks).nonEmpty) {
                cancellable.cancel(null) // the rest of the answer is never generated
                ok = false
                streaming = false
              }
          }
        }
        if (ok) ok = Guardrail.check(request.message, answer.toString, chunks).ok
        val (text, sources) = if (ok) (answer.toString, Prompt.citedIds(answer.toString)) else (Config.HandoffText, Seq.empty[String])
        remember(request.sessionId, request.message, text)
        observer.onNext(ChatEvent(done = true, sources = sources, escalated = !ok, model = model))
        observer.onCompleted()
      } catch {
        case e: StatusRuntimeException => observer.onError(e.getStatus.asRuntimeException())
      }
    }
  }

  def serve(): Unit =
    ServerBuilder.forPort(9000).addService(ChatGrpc.bindService(new ChatService, ExecutionContext.global)).build().start().awaitTermination()

  def main(args: Array[String]): Unit = serve()
}
`,
    },
    cpp: {
      starter: `// Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go.
#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "assistant/config.h"  // config::kLlmLarge, kLlmSmall, kMaxTokens, kDeadline, kHistoryTtlS, kHandoffText, kTopK
#include "assistant/prompt.h"  // assistant::build_prompt(question, chunks, history), assistant::cited_ids(answer), Chunk, Turn
#include "guardrail.h"         // std::vector<std::string> tier1(answer, chunks); Verdict check(question, answer, chunks) — step 4
#include "kb_search.h"         // std::vector<Hit> search(question, k) — step 2
#include "support.grpc.pb.h"

using json = nlohmann::json;

// How many tokens pass between two runs of tier 1 on the text so far.
constexpr int kGuardEvery = 8;

sw::redis::Redis redis("tcp://redis:6379");
auto large = support::Llm::NewStub(grpc::CreateChannel(config::kLlmLarge, grpc::InsecureChannelCredentials()));
auto small = support::Llm::NewStub(grpc::CreateChannel(config::kLlmSmall, grpc::InsecureChannelCredentials()));

// The conversation so far: the JSON turns of conv:<session>, oldest first.
std::vector<assistant::Turn> history(const std::string& session_id) {
  std::vector<std::string> raw;
  redis.lrange("conv:" + session_id, 0, -1, std::back_inserter(raw));
  std::vector<assistant::Turn> turns;
  for (const auto& r : raw) {
    const json t = json::parse(r);
    turns.push_back({t["role"].get<std::string>(), t["text"].get<std::string>()});
  }
  return turns;
}

// Both turns onto conv:<session>, with the history's TTL.
void remember(const std::string& session_id, const std::string& question, const std::string& answer) {
  // TODO: RPUSH {"role": "dasher", "text": question} and {"role": "assistant", "text": answer}; EXPIRE config::kHistoryTtlS
}

// The text up to its last . ! or ? — what tier 1 may judge mid-stream.
std::string complete_sentences(const std::string& text) {
  const auto end = text.find_last_of(".!?");
  return end == std::string::npos ? "" : text.substr(0, end + 1);
}

// One Llm.Stream with its ClientContext: the deadline sits on the context, TryCancel stops the model.
struct ModelStream {
  grpc::ClientContext ctx;
  std::unique_ptr<grpc::ClientReader<support::Token>> reader;
};

std::unique_ptr<ModelStream> open(support::Llm::Stub& stub, const std::string& model, const std::string& prompt) {
  // TODO: GenerateRequest{model, prompt, config::kMaxTokens}; ctx deadline now + config::kDeadline; reader = stub.Stream(&ctx, request)
  return nullptr;
}

class ChatService final : public support::Chat::Service {
 public:
  grpc::Status Stream(grpc::ServerContext*, const support::ChatRequest* request,
                      grpc::ServerWriter<support::ChatEvent>* writer) override {
    // TODO: history(session_id), search(message, config::kTopK) as assistant::Chunks, assistant::build_prompt → open(*large, "large", prompt)
    // TODO: Read token by token: answer += token.text(), writer->Write(ChatEvent{token}) at once
    // TODO:   Finish() UNAVAILABLE before any token → open(*small, "small", prompt); any other status → return it
    // TODO:   every kGuardEvery tokens: tier1(complete_sentences(answer), chunks) → reasons mean ctx.TryCancel(), ok = false
    // TODO: ended by itself → ok = check(message, answer, chunks).ok
    // TODO: remember(session_id, message, answer or config::kHandoffText); Write(ChatEvent{done, sources, escalated, model})
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

void serve() {
  ChatService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("[::]:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}

int main() { serve(); }
`,
      solution: `// Chat.Stream: the answer as it is generated — tokens relayed to the Dasher app, guarded as they go.
#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "assistant/config.h"  // config::kLlmLarge, kLlmSmall, kMaxTokens, kDeadline, kHistoryTtlS, kHandoffText, kTopK
#include "assistant/prompt.h"  // assistant::build_prompt(question, chunks, history), assistant::cited_ids(answer), Chunk, Turn
#include "guardrail.h"         // std::vector<std::string> tier1(answer, chunks); Verdict check(question, answer, chunks) — step 4
#include "kb_search.h"         // std::vector<Hit> search(question, k) — step 2
#include "support.grpc.pb.h"

using json = nlohmann::json;

// How many tokens pass between two runs of tier 1 on the text so far.
constexpr int kGuardEvery = 8;

sw::redis::Redis redis("tcp://redis:6379");
auto large = support::Llm::NewStub(grpc::CreateChannel(config::kLlmLarge, grpc::InsecureChannelCredentials()));
auto small = support::Llm::NewStub(grpc::CreateChannel(config::kLlmSmall, grpc::InsecureChannelCredentials()));

// The conversation so far: the JSON turns of conv:<session>, oldest first.
std::vector<assistant::Turn> history(const std::string& session_id) {
  std::vector<std::string> raw;
  redis.lrange("conv:" + session_id, 0, -1, std::back_inserter(raw));
  std::vector<assistant::Turn> turns;
  for (const auto& r : raw) {
    const json t = json::parse(r);
    turns.push_back({t["role"].get<std::string>(), t["text"].get<std::string>()});
  }
  return turns;
}

// Both turns onto conv:<session>, with the history's TTL.
void remember(const std::string& session_id, const std::string& question, const std::string& answer) {
  const std::string key = "conv:" + session_id;
  redis.rpush(key, {json{{"role", "dasher"}, {"text", question}}.dump(), json{{"role", "assistant"}, {"text", answer}}.dump()});
  redis.expire(key, std::chrono::seconds(config::kHistoryTtlS));
}

// The text up to its last . ! or ? — what tier 1 may judge mid-stream.
std::string complete_sentences(const std::string& text) {
  const auto end = text.find_last_of(".!?");
  return end == std::string::npos ? "" : text.substr(0, end + 1);
}

// One Llm.Stream with its ClientContext: the deadline sits on the context, TryCancel stops the model.
struct ModelStream {
  grpc::ClientContext ctx;
  std::unique_ptr<grpc::ClientReader<support::Token>> reader;
};

std::unique_ptr<ModelStream> open(support::Llm::Stub& stub, const std::string& model, const std::string& prompt) {
  auto stream = std::make_unique<ModelStream>();
  stream->ctx.set_deadline(std::chrono::system_clock::now() + config::kDeadline);
  support::GenerateRequest request;
  request.set_model(model);
  request.set_prompt(prompt);
  request.set_max_tokens(config::kMaxTokens);
  stream->reader = stub.Stream(&stream->ctx, request);
  return stream;
}

class ChatService final : public support::Chat::Service {
 public:
  grpc::Status Stream(grpc::ServerContext*, const support::ChatRequest* request,
                      grpc::ServerWriter<support::ChatEvent>* writer) override {
    const auto past = history(request->session_id());
    std::vector<assistant::Chunk> chunks;
    const auto hits = search(request->message(), config::kTopK);
    for (const auto& h : hits) chunks.push_back({h.id, h.text});
    const std::string prompt = assistant::build_prompt(request->message(), chunks, past);
    std::string model = "large";
    auto stream = open(*large, model, prompt);
    std::string answer;
    int count = 0;
    bool ok = true;
    support::Token token;
    for (;;) {
      if (!stream->reader->Read(&token)) {
        const grpc::Status status = stream->reader->Finish();
        if (status.ok()) break;
        // UNAVAILABLE before the first token: the same prompt to the small model. Once tokens have
        // gone out there is nothing to retry, and a deadline is the app's to spend again.
        if (status.error_code() == grpc::StatusCode::UNAVAILABLE && answer.empty()) {
          model = "small";
          stream = open(*small, model, prompt);
          continue;
        }
        return status;
      }
      answer += token.text();
      ++count;
      support::ChatEvent event;
      event.set_token(token.text());
      writer->Write(event);
      if (count % kGuardEvery == 0 && !tier1(complete_sentences(answer), chunks).empty()) {
        stream->ctx.TryCancel();  // the rest of the answer is never generated
        stream->reader->Finish();
        ok = false;
        break;
      }
    }
    if (ok) ok = check(request->message(), answer, chunks).ok;
    remember(request->session_id(), request->message(), ok ? answer : config::kHandoffText);
    support::ChatEvent done;
    done.set_done(true);
    done.set_escalated(!ok);
    done.set_model(model);
    if (ok)
      for (const auto& id : assistant::cited_ids(answer)) done.add_sources(id);
    writer->Write(done);
    return grpc::Status::OK;
  }
};

void serve() {
  ChatService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("[::]:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}

int main() { serve(); }
`,
    },
  },
  harness: {
    python: `import asyncio
import json
from collections import namedtuple

import grpc

import support_pb2
import support_pb2_grpc
from assistant import config, kb, model
from assistant.db import SCHEMA

GAP_S = 0.1  # virtual seconds between two tokens of the stand-in model
STREAM = "/support.Llm/Stream"  # the full path: the learner's Chat.Stream shares the short name
JUDGE = "/support.Judge/Evaluate"
SESSION = "s-7"
QUESTION = "My red card was declined at the restaurant, what do I do?"
PAST = [
    {"role": "dasher", "text": "Hi, I am at the restaurant for order 4471."},
    {"role": "assistant", "text": "Hello! What is happening with the order?"},
]

Seen = namedtuple("Seen", "event produced at")
World = namedtuple("World", "m stub large small")


class LlmServicer(support_pb2_grpc.LlmServicer):
    """The stand-in model server, streaming: one Token per word, GAP_S of virtual time between two."""

    def __init__(self, mode="faithful"):
        self.mode = mode
        self.produced = 0  # tokens handed to the client by the latest stream
        self.total = 0
        self.cancelled = False

    def Generate(self, request, context):
        text = model.complete(request.prompt, request.max_tokens, self.mode)
        return support_pb2.GenerateReply(text=text, tokens=len(text.split()), model=request.model)

    async def Stream(self, request, context):
        tokens = model.tokens(model.complete(request.prompt, request.max_tokens, self.mode))
        self.produced, self.total, self.cancelled = 0, len(tokens), False
        try:
            for i, t in enumerate(tokens):
                if context.cancelled():
                    break
                self.produced += 1
                yield support_pb2.Token(text=t, index=i)
                await asyncio.sleep(GAP_S)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        finally:
            if context.cancelled():
                self.cancelled = True


class JudgeServicer(support_pb2_grpc.JudgeServicer):
    def Evaluate(self, request, context):
        return support_pb2.Scores(**model.evaluate(request.question, request.answer, list(request.context_ids)))


async def _start(ctx, mode="faithful"):
    """The KB indexed, the model (in \`mode\`) and the judge served, a history seeded, the learner's server up."""
    await ctx.db.reset(SCHEMA)
    await ctx.load("kb_search").index_articles(kb.ARTICLES)
    for turn in PAST:
        ctx.redis.rpush(f"conv:{SESSION}", json.dumps(turn))
    large, small = LlmServicer(mode), LlmServicer(mode)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, large, config.LLM_LARGE)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, small, config.LLM_SMALL)
    ctx.grpc.serve(support_pb2_grpc.add_JudgeServicer_to_server, JudgeServicer(), config.JUDGE)
    m = ctx.load("stream")
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/support.Chat/Stream") is not None, "serve() registered no Chat.Stream handler"
    return World(m, support_pb2_grpc.ChatStub(grpc.aio.insecure_channel("chat:9000")), large, small)


async def _chat(ctx, w, message=QUESTION, session=SESSION):
    """Every ChatEvent of one Chat.Stream call, each with the model's token count and the virtual time when it arrived."""
    call = w.stub.Stream(support_pb2.ChatRequest(session_id=session, dasher_id="d-9", message=message))
    seen = []

    async def collect():
        async for ev in call:
            seen.append(Seen(ev, w.large.produced + w.small.produced, ctx.clock.offset))

    try:
        await asyncio.wait_for(collect(), 5.0)
    except asyncio.TimeoutError:
        raise AssertionError(f"Chat.Stream did not end within 5 s of real time after {len(seen)} event(s): send the done event and return")
    return seen


def _split(seen):
    """Token events and the done event, checked for shape."""
    assert seen, "Chat.Stream ended without a single event"
    done = seen[-1].event
    assert done.done, f"the last event must be the done event, got {done}"
    tokens = [s.event for s in seen[:-1]]
    assert all(not t.done and t.token for t in tokens), "every event before the last one carries a token and done=False"
    return tokens, done


def _history(ctx):
    return [json.loads(t) for t in ctx.redis.lrange(f"conv:{SESSION}", 0, -1)]


def _assert_history(ctx, answer):
    turns = _history(ctx)
    want = PAST + [{"role": "dasher", "text": QUESTION}, {"role": "assistant", "text": answer}]
    assert turns == want, f"conv:{SESSION} must hold the two seeded turns, then the dasher's question and the assistant's turn {answer[:40]!r}…; found {turns}"
    ttl = ctx.redis.ttl(f"conv:{SESSION}")
    assert 0 < ttl <= config.HISTORY_TTL_S, f"conv:{SESSION} must expire in HISTORY_TTL_S ({config.HISTORY_TTL_S}) seconds, its TTL is {ttl}"


def _llm(ctx, target):
    return ctx.grpc.calls_to(STREAM, target)


async def check_tokens_stream(ctx):
    w = await _start(ctx)
    started = ctx.clock.offset
    seen = await _chat(ctx, w)
    tokens, done = _split(seen)
    calls = _llm(ctx, config.LLM_LARGE)
    assert len(calls) == 1, f"a healthy large model is streamed from exactly once, saw {len(calls)} Llm.Stream call(s) to {config.LLM_LARGE}"
    expected = model.complete(calls[0].request.prompt, config.MAX_TOKENS)
    assert "".join(t.token for t in tokens) == expected, f"the tokens joined must be the model's text {expected!r}, got {''.join(t.token for t in tokens)!r}"
    assert len(tokens) == w.large.total, f"one ChatEvent per Token: the model produced {w.large.total}, the app saw {len(tokens)}"
    first = seen[0]
    assert first.produced < w.large.total, f"the first token reached the app only after the model had produced all {w.large.total} tokens: relay each Token as it arrives, do not collect the answer first"
    assert first.at - started <= 3 * GAP_S, f"the first token arrived {first.at - started:.1f} s (virtual) after the request; the model pauses {GAP_S} s per token, so a relayed first token is there within a few tenths"
    assert list(done.sources) == ["red-card-0", "red-card-1"], f"the done event's sources are the chunk ids the answer cites, in order: expected ['red-card-0', 'red-card-1'], got {list(done.sources)}"
    assert done.escalated is False and done.model == "large", f"a grounded answer from the large model ends with escalated=False, model='large', got {done}"
    assert len(ctx.grpc.calls_to(JUDGE, config.JUDGE)) == 1, f"the full guardrail.check runs once when the stream ends: expected one Evaluate call, saw {len(ctx.grpc.calls_to(JUDGE, config.JUDGE))}"
    _assert_history(ctx, expected)


async def check_prompt(ctx):
    from assistant import embed, prompt

    w = await _start(ctx)
    await _chat(ctx, w)
    calls = _llm(ctx, config.LLM_LARGE)
    assert len(calls) == 1, f"expected one Llm.Stream call to {config.LLM_LARGE}, saw {len(calls)}"
    request = calls[0].request
    assert request.model == "large", f"the request to {config.LLM_LARGE} must say model='large', got {request.model!r}"
    assert request.max_tokens == config.MAX_TOKENS, f"the request must carry max_tokens = MAX_TOKENS ({config.MAX_TOKENS}), got {request.max_tokens}"
    # The nearest chunks straight from the database, as kb_search.search would rank them.
    q = embed.to_pgvector(embed.embed(QUESTION))
    ranked = await ctx.db.execute("SELECT id, text FROM kb_chunks ORDER BY embedding <=> %s::vector LIMIT %s", (q, config.TOP_K))
    for row in ranked:
        assert f"[kb:{row['id']}] {row['text']}" in request.prompt, f"the prompt has no '[kb:{row['id']}] <text>' line, one of the {config.TOP_K} nearest chunks: the context is kb_search.search(message) through build_prompt"
    for turn in PAST:
        assert f"{turn['role']}: {turn['text']}" in request.prompt, f"the prompt is missing the history turn {turn['role']}: {turn['text']!r} from conv:{SESSION}"
    want = prompt.build_prompt(QUESTION, [{"id": row["id"], "text": row["text"]} for row in ranked], PAST)
    assert request.prompt == want, "the prompt must be exactly build_prompt(message, chunks, history): the model parses that format"


async def check_guard_mid_stream(ctx):
    w = await _start(ctx, "verbose")
    seen = await _chat(ctx, w)
    tokens, done = _split(seen)
    n = len(tokens)
    assert n > 40, f"the app saw {n} tokens: tier 1 fired on an unfinished sentence ('Additionally, please note that this may vary by' alone looks unlike every chunk) — judge complete sentences only"
    assert n <= 48, f"the app saw {n} tokens: the filler sentence completes at token 44, so the guard at token 48 must stop the stream"
    assert done.escalated is True and list(done.sources) == [], f"a failed tier 1 ends with escalated=True and no sources, got {done}"
    assert done.model == "large", f"the done event names the model that was streaming ('large'), got {done.model!r}"
    for _ in range(5):
        await asyncio.sleep(0)
    assert w.large.cancelled, "the guard fired but the model stream was not cancelled: the model kept generating tokens nobody will read"
    assert w.large.produced < w.large.total, f"after the cancel the model must stop: it produced {w.large.produced} of {w.large.total} tokens"
    assert not ctx.grpc.calls_to(JUDGE, config.JUDGE), "tier 1 failed mid-stream: the judge is not consulted"
    _assert_history(ctx, config.HANDOFF_TEXT)


async def check_guard_at_end(ctx):
    w = await _start(ctx, "hallucinate")
    seen = await _chat(ctx, w)
    tokens, done = _split(seen)
    invented = model.complete(_llm(ctx, config.LLM_LARGE)[0].request.prompt, config.MAX_TOKENS, "hallucinate")
    assert "".join(t.token for t in tokens) == invented, f"the invented sentence completes only at its last token, so all {w.large.total} tokens are relayed before the guard can see it; the app saw {len(tokens)}"
    assert not w.large.cancelled and w.large.produced == w.large.total, "the model's stream ended by itself: nothing to cancel"
    assert done.escalated is True and list(done.sources) == [], f"the full check fails on [kb:policy-404]: the done event must say escalated=True with no sources, got {done}"
    assert done.model == "large", f"the done event names the model that was streaming ('large'), got {done.model!r}"
    assert not ctx.grpc.calls_to(JUDGE, config.JUDGE), "a tier-1 failure (a citation that was never retrieved) never reaches the judge"
    _assert_history(ctx, config.HANDOFF_TEXT)


async def check_fallback_deadline(ctx):
    w = await _start(ctx)
    ctx.grpc.fail(STREAM, grpc.StatusCode.UNAVAILABLE, "", 1, config.LLM_LARGE)
    seen = await _chat(ctx, w)
    tokens, done = _split(seen)
    assert len(_llm(ctx, config.LLM_LARGE)) == 1, f"UNAVAILABLE on a stream is a fallback, not a retry: expected one Llm.Stream call to {config.LLM_LARGE}, saw {len(_llm(ctx, config.LLM_LARGE))}"
    small = _llm(ctx, config.LLM_SMALL)
    assert len(small) == 1, f"the large model UNAVAILABLE must mean one Llm.Stream call to {config.LLM_SMALL}, saw {len(small)}"
    assert small[0].request.model == "small" and small[0].request.prompt == _llm(ctx, config.LLM_LARGE)[0].request.prompt, "the fallback sends the same prompt with model='small'"
    expected = model.complete(small[0].request.prompt, config.MAX_TOKENS)
    assert "".join(t.token for t in tokens) == expected, f"the small model's tokens must reach the app, got {''.join(t.token for t in tokens)!r}"
    assert done.model == "small" and done.escalated is False, f"the done event must say model='small', escalated=False, got {done}"
    assert seen[0].produced < w.small.total, "the small model's tokens must be relayed as they arrive too"
    _assert_history(ctx, expected)
    # A large model that is silent for 3 s: the deadline on the call ends the wait at DEADLINE_S.
    ctx.grpc.set_latency(STREAM, 3.0, config.LLM_LARGE)
    before = len(_history(ctx))
    started = ctx.clock.offset
    try:
        seen = await _chat(ctx, w, session="s-8")
    except grpc.RpcError as e:
        code = e.code()
    else:
        raise AssertionError(f"a large model silent past DEADLINE_S must end the chat stream with DEADLINE_EXCEEDED; it answered {len(seen)} event(s) instead")
    elapsed = round(ctx.clock.offset - started, 3)
    assert code == grpc.StatusCode.DEADLINE_EXCEEDED, f"the chat stream must end with DEADLINE_EXCEEDED, got {code}"
    call = _llm(ctx, config.LLM_LARGE)[-1]
    assert call.timeout is not None and 1.5 <= call.timeout <= 2.0, f"the Llm.Stream call must carry a deadline of DEADLINE_S ({config.DEADLINE_S} s), got {call.timeout}"
    assert elapsed <= 2.5, f"the deadline must end the wait at {config.DEADLINE_S} s of virtual time, the stream waited {elapsed} s (3 s means the model's stall was waited out)"
    assert len(_llm(ctx, config.LLM_SMALL)) == 1, "a deadline is not a fallback: the budget is spent, the small model must not be called"
    assert len(_history(ctx)) == before, "a stream that failed with a status answered nothing: conv:<session_id> must not change"
`,
    typescript: `import {credentials} from '@grpc/grpc-js';

const GAP_MS = 100; // virtual milliseconds between two tokens of the stand-in model
const STREAM = '/support.Llm/Stream'; // the full path: the learner's Chat.Stream shares the short name
const JUDGE = '/support.Judge/Evaluate';
const SESSION = 's-7';
const QUESTION = 'My red card was declined at the restaurant, what do I do?';
const PAST = [
  {role: 'dasher', text: 'Hi, I am at the restaurant for order 4471.'},
  {role: 'assistant', text: 'Hello! What is happening with the order?'},
];

interface ChatEvent {
  token: string;
  done: boolean;
  sources: string[];
  escalated: boolean;
  model: string;
}
interface Seen {
  event: ChatEvent;
  produced: number;
  at: number;
}
interface Peer {
  produced: number; // tokens handed to the client by the latest stream
  total: number;
  cancelled: boolean;
}

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function assistant(ctx) {
  return {
    config: ctx.load('/support/assistant/config.ts'),
    model: ctx.load('/support/assistant/model.ts'),
    prompt: ctx.load('/support/assistant/prompt.ts'),
    embed: ctx.load('/support/assistant/embed.ts'),
    chunk: ctx.load('/support/assistant/chunk.ts'),
    kb: ctx.load('/support/assistant/kb.ts'),
    SCHEMA: ctx.load('/support/assistant/db.ts').SCHEMA,
    support: ctx.proto('support.proto').support,
  };
}

/** The stand-in model server, streaming: one Token per word, GAP_MS of virtual time between two. */
function llm(a, mode: string): {peer: Peer; impl} {
  const peer: Peer = {produced: 0, total: 0, cancelled: false};
  const impl = {
    Generate: (call, callback) => {
      const text = a.model.complete(call.request.prompt, call.request.max_tokens, mode);
      callback(null, {text, tokens: text.split(/\\s+/).filter(w => w !== '').length, model: call.request.model});
    },
    Stream: async call => {
      const tokens: string[] = a.model.tokens(a.model.complete(call.request.prompt, call.request.max_tokens, mode));
      peer.produced = 0;
      peer.total = tokens.length;
      peer.cancelled = false;
      call.on('cancelled', () => {
        peer.cancelled = true;
      });
      for (const [i, t] of tokens.entries()) {
        if (call.cancelled) return;
        peer.produced += 1;
        call.write({text: t, index: i});
        await sleep(GAP_MS);
      }
      call.end();
    },
  };
  return {peer, impl};
}

/** The KB indexed, the model (in \`mode\`) and the judge served, a history seeded, the learner's server up. */
async function start(ctx, mode = 'faithful') {
  const a = assistant(ctx);
  await ctx.db.reset(a.SCHEMA);
  await ctx.load('kb_search').indexArticles(a.kb.ARTICLES);
  for (const turn of PAST) ctx.redis.rpush(\`conv:\${SESSION}\`, JSON.stringify(turn));
  const large = llm(a, mode);
  const small = llm(a, mode);
  ctx.grpc.serve(a.support.Llm.service, large.impl, a.config.LLM_LARGE);
  ctx.grpc.serve(a.support.Llm.service, small.impl, a.config.LLM_SMALL);
  ctx.grpc.serve(
    a.support.Judge.service,
    {Evaluate: (call, callback) => callback(null, a.model.evaluate(call.request.question, call.request.answer, call.request.context_ids))},
    a.config.JUDGE,
  );
  const m = ctx.load('stream');
  m.serve();
  const stub = new a.support.Chat('chat:9000', credentials.createInsecure());
  return {...a, ctx, m, stub, large: large.peer, small: small.peer};
}

/** Every ChatEvent of one Chat.Stream call, each with the model's token count and the virtual time when it arrived; the status it failed with, if any. */
function chat(w, message = QUESTION, session = SESSION): Promise<{seen: Seen[]; error: {code: number; details: string} | null}> {
  const call = w.stub.Stream({session_id: session, dasher_id: 'd-9', message});
  const seen: Seen[] = [];
  let error: {code: number; details: string} | null = null;
  const {promise, resolve} = Promise.withResolvers<{seen: Seen[]; error: {code: number; details: string} | null}>();
  call.on('data', (event: ChatEvent) => seen.push({event, produced: w.large.produced + w.small.produced, at: w.ctx.clock.now()}));
  call.on('error', (e: {code: number; details: string}) => {
    error = e;
  });
  call.on('end', () => resolve({seen, error}));
  return promise;
}

const statusName = (w, code: number) => Object.keys(w.ctx.grpc.status).find(k => w.ctx.grpc.status[k] === code) ?? String(code);

/** Token events and the done event, checked for shape. */
function split(w, {seen, error}: {seen: Seen[]; error: {code: number; details: string} | null}) {
  assert(error === null, \`Chat.Stream failed with \${error === null ? '' : statusName(w, error.code)} (\${error?.details}) after \${seen.length} event(s)\`);
  assert(seen.length > 0, 'Chat.Stream ended without a single event');
  const done = seen[seen.length - 1].event;
  assert(done.done === true, \`the last event must be the done event, got \${JSON.stringify(done)}\`);
  const tokens = seen.slice(0, -1).map(s => s.event);
  assert(tokens.every(t => !t.done && t.token !== ''), 'every event before the last one carries a token and done: false');
  return {tokens, done, joined: tokens.map(t => t.token).join('')};
}

const history = (ctx) => (ctx.redis.lrange(\`conv:\${SESSION}\`, 0, -1) as string[]).map(t => JSON.parse(t));

function assertHistory(w, answer: string) {
  const turns = history(w.ctx);
  const want = [...PAST, {role: 'dasher', text: QUESTION}, {role: 'assistant', text: answer}];
  assert.deepEqual(turns, want, \`conv:\${SESSION} must hold the two seeded turns, then the dasher's question and the assistant's turn \${JSON.stringify(answer.slice(0, 40))}…; found \${JSON.stringify(turns)}\`);
  const ttl = Number(w.ctx.redis.ttl(\`conv:\${SESSION}\`));
  assert(0 < ttl && ttl <= w.config.HISTORY_TTL_S, \`conv:\${SESSION} must expire in HISTORY_TTL_S (\${w.config.HISTORY_TTL_S}) seconds, its TTL is \${ttl}\`);
}

const calls = (w, target: string) => w.ctx.grpc.callsTo(STREAM, target);
const evaluations = w => w.ctx.grpc.callsTo(JUDGE, w.config.JUDGE);

export async function check_tokens_stream(ctx) {
  const w = await start(ctx);
  const started = ctx.clock.now();
  const outcome = await chat(w);
  const {tokens, done, joined} = split(w, outcome);
  const large = calls(w, w.config.LLM_LARGE);
  assert.equal(large.length, 1, \`a healthy large model is streamed from exactly once, saw \${large.length} Llm.Stream call(s) to \${w.config.LLM_LARGE}\`);
  const expected = w.model.complete(large[0].request.prompt, w.config.MAX_TOKENS);
  assert.equal(joined, expected, \`the tokens joined must be the model's text \${JSON.stringify(expected)}, got \${JSON.stringify(joined)}\`);
  assert.equal(tokens.length, w.large.total, \`one ChatEvent per Token: the model produced \${w.large.total}, the app saw \${tokens.length}\`);
  const first = outcome.seen[0];
  assert(first.produced < w.large.total, \`the first token reached the app only after the model had produced all \${w.large.total} tokens: relay each Token as it arrives, do not collect the answer first\`);
  assert(first.at - started <= 3 * GAP_MS, \`the first token arrived \${Math.round(first.at - started)} ms (virtual) after the request; the model pauses \${GAP_MS} ms per token, so a relayed first token is there within a few hundred\`);
  assert.deepEqual(done.sources, ['red-card-0', 'red-card-1'], \`the done event's sources are the chunk ids the answer cites, in order: expected ["red-card-0","red-card-1"], got \${JSON.stringify(done.sources)}\`);
  assert(done.escalated === false && done.model === 'large', \`a grounded answer from the large model ends with escalated: false, model: 'large', got \${JSON.stringify(done)}\`);
  assert.equal(evaluations(w).length, 1, \`the full guardrail check runs once when the stream ends: expected one Evaluate call, saw \${evaluations(w).length}\`);
  assertHistory(w, expected);
}

export async function check_prompt(ctx) {
  const w = await start(ctx);
  split(w, await chat(w));
  const large = calls(w, w.config.LLM_LARGE);
  assert.equal(large.length, 1, \`expected one Llm.Stream call to \${w.config.LLM_LARGE}, saw \${large.length}\`);
  const request = large[0].request;
  assert.equal(request.model, 'large', \`the request to \${w.config.LLM_LARGE} must say model: 'large', got \${JSON.stringify(request.model)}\`);
  assert.equal(request.max_tokens, w.config.MAX_TOKENS, \`the request must carry max_tokens: MAX_TOKENS (\${w.config.MAX_TOKENS}), got \${request.max_tokens}\`);
  // The nearest chunks straight from the database, as search would rank them.
  const q = w.embed.toPgvector(w.embed.embed(QUESTION));
  const ranked: {id: string; text: string}[] = await ctx.db.execute('SELECT id, text FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT $2', [q, w.config.TOP_K]);
  for (const {id, text} of ranked)
    assert(request.prompt.includes(\`[kb:\${id}] \${text}\`), \`the prompt has no '[kb:\${id}] <text>' line, one of the \${w.config.TOP_K} nearest chunks: the context is search(message) through buildPrompt\`);
  for (const turn of PAST)
    assert(request.prompt.includes(\`\${turn.role}: \${turn.text}\`), \`the prompt is missing the history turn \${turn.role}: \${JSON.stringify(turn.text)} from conv:\${SESSION}\`);
  const want = w.prompt.buildPrompt(QUESTION, ranked.map(({id, text}) => ({id, text})), PAST);
  assert.equal(request.prompt, want, 'the prompt must be exactly buildPrompt(message, chunks, history): the model parses that format');
}

export async function check_guard_mid_stream(ctx) {
  const w = await start(ctx, 'verbose');
  const {tokens, done} = split(w, await chat(w));
  const n = tokens.length;
  assert(n > 40, \`the app saw \${n} tokens: tier 1 fired on an unfinished sentence ('Additionally, please note that this may vary by' alone looks unlike every chunk) — judge complete sentences only\`);
  assert(n <= 48, \`the app saw \${n} tokens: the filler sentence completes at token 44, so the guard at token 48 must stop the stream\`);
  assert(done.escalated === true && done.sources.length === 0, \`a failed tier 1 ends with escalated: true and no sources, got \${JSON.stringify(done)}\`);
  assert.equal(done.model, 'large', \`the done event names the model that was streaming ('large'), got \${JSON.stringify(done.model)}\`);
  await sleep(5 * GAP_MS);
  assert(w.large.cancelled, 'the guard fired but the model stream was not cancelled: the model kept generating tokens nobody will read');
  assert(w.large.produced < w.large.total, \`after the cancel the model must stop: it produced \${w.large.produced} of \${w.large.total} tokens\`);
  assert.equal(evaluations(w).length, 0, 'tier 1 failed mid-stream: the judge is not consulted');
  assertHistory(w, w.config.HANDOFF_TEXT);
}

export async function check_guard_at_end(ctx) {
  const w = await start(ctx, 'hallucinate');
  const {tokens, done, joined} = split(w, await chat(w));
  const invented = w.model.complete(calls(w, w.config.LLM_LARGE)[0].request.prompt, w.config.MAX_TOKENS, 'hallucinate');
  assert.equal(joined, invented, \`the invented sentence completes only at its last token, so all \${w.large.total} tokens are relayed before the guard can see it; the app saw \${tokens.length}\`);
  assert(!w.large.cancelled && w.large.produced === w.large.total, "the model's stream ended by itself: nothing to cancel");
  assert(done.escalated === true && done.sources.length === 0, \`the full check fails on [kb:policy-404]: the done event must say escalated: true with no sources, got \${JSON.stringify(done)}\`);
  assert.equal(done.model, 'large', \`the done event names the model that was streaming ('large'), got \${JSON.stringify(done.model)}\`);
  assert.equal(evaluations(w).length, 0, 'a tier-1 failure (a citation that was never retrieved) never reaches the judge');
  assertHistory(w, w.config.HANDOFF_TEXT);
}

export async function check_fallback_deadline(ctx) {
  const w = await start(ctx);
  ctx.grpc.fail(STREAM, ctx.grpc.status.UNAVAILABLE, '', 1, w.config.LLM_LARGE);
  const outcome = await chat(w);
  const {done, joined} = split(w, outcome);
  assert.equal(calls(w, w.config.LLM_LARGE).length, 1, \`UNAVAILABLE on a stream is a fallback, not a retry: expected one Llm.Stream call to \${w.config.LLM_LARGE}, saw \${calls(w, w.config.LLM_LARGE).length}\`);
  const small = calls(w, w.config.LLM_SMALL);
  assert.equal(small.length, 1, \`the large model UNAVAILABLE must mean one Llm.Stream call to \${w.config.LLM_SMALL}, saw \${small.length}\`);
  assert(small[0].request.model === 'small' && small[0].request.prompt === calls(w, w.config.LLM_LARGE)[0].request.prompt, "the fallback sends the same prompt with model: 'small'");
  const expected = w.model.complete(small[0].request.prompt, w.config.MAX_TOKENS);
  assert.equal(joined, expected, \`the small model's tokens must reach the app, got \${JSON.stringify(joined)}\`);
  assert(done.model === 'small' && done.escalated === false, \`the done event must say model: 'small', escalated: false, got \${JSON.stringify(done)}\`);
  assert(outcome.seen[0].produced < w.small.total, "the small model's tokens must be relayed as they arrive too");
  assertHistory(w, expected);
  // A large model that is silent for 3 s: the deadline on the call ends the wait at DEADLINE_S.
  ctx.grpc.setLatency(STREAM, 3.0, w.config.LLM_LARGE);
  const before = history(ctx).length;
  const started = ctx.clock.now();
  const stalled = await chat(w, QUESTION, 's-8');
  const elapsed = Math.round(ctx.clock.now() - started);
  assert(stalled.error !== null, \`a large model silent past DEADLINE_S must end the chat stream with DEADLINE_EXCEEDED; it answered \${stalled.seen.length} event(s) instead\`);
  assert.equal(stalled.error.code, ctx.grpc.status.DEADLINE_EXCEEDED, \`the chat stream must end with DEADLINE_EXCEEDED, got \${statusName(w, stalled.error.code)}\`);
  const call = calls(w, w.config.LLM_LARGE).at(-1);
  assert(call.timeout !== null && 1.5 <= call.timeout && call.timeout <= 2.0, \`the Llm.Stream call must carry a deadline of DEADLINE_S (\${w.config.DEADLINE_S} s), got \${call.timeout}\`);
  assert(elapsed <= 2500, \`the deadline must end the wait at \${w.config.DEADLINE_S} s of virtual time, the stream waited \${elapsed} ms (3000 means the model's stall was waited out)\`);
  assert.equal(calls(w, w.config.LLM_SMALL).length, 1, 'a deadline is not a fallback: the budget is spent, the small model must not be called');
  assert.equal(history(ctx).length, before, 'a stream that failed with a status answered nothing: conv:<session_id> must not change');
}
`,
  },
  debrief: `Streaming changes what "fast" means. A unary answer is judged by one number — time to the reply — while a stream is judged by two: time to the first token, which is what the Dasher feels as responsiveness, and time between tokens, which is what they feel as the answer being typed. LinkedIn's platform post makes those the metrics the serving layer is held to, and they are why a relay that collects the whole answer before writing anything is wrong even though it sends the same bytes: it turns the stream back into a unary call with extra steps. The deadline moves with the metric — it is the budget for the first token, not for the answer — and so does the fallback: \`UNAVAILABLE\` before the first token is cheap to redirect to a smaller model, while a model that dies mid-answer has already shown the Dasher half a sentence, and the honest outcome is a status the app can act on. The guard moves too, and loses something on the way. Tier 1 needs a complete sentence to compare against the chunks, so it runs on a trailing window and sees an invented sentence only at its full stop: the hallucinating model's one sentence reaches the app before the handoff does, which a unary guardrail would never have allowed. What the incremental guard buys is the cancel. A model that has gone off the rails will happily produce a hundred more tokens, each one a slice of GPU time that nobody will read; cancelling the upstream stream the moment tier 1 fails is how the server stops paying for them, and in production the cancellation has to propagate all the way to the inference engine, which is why serving stacks treat client disconnects and cancellations as first-class events rather than letting the request run to completion. Production adds what this step leaves out: an idle timeout between tokens next to the first-token deadline, a client that reconnects with the tokens it already has, and the offline judge of the next step scoring every streamed turn — including the ones the Dasher saw half of.`,
};
