import type {Step} from '@/lib/types';

export const postMessageStep: Step = {
  id: 'post-message',
  title: 'POST a message: a snowflake id and a time bucket',
  concept: 'http',
  file: 'post_message',
  focus: ['client', 'api', 'db'],
  task: `## Task

Implement \`POST /channels/{channel_id}/messages\` with body \`{"author_id": …, "content": "…"}\`. The
\`messages\` table is provided as \`db\` (\`await db.execute(sql, params)\`), with the primary key
\`(channel_id, bucket, message_id)\` — one channel's messages for one 10-day window sit together.

- \`content\` must be **1–2000** characters once whitespace is trimmed; anything else is a **400**.
- Mint the id in \`next_id(now_ms)\` as a **snowflake**: \`(now_ms - DISCORD_EPOCH_MS) << 22 |
  WORKER_ID << 17 | PROCESS_ID << 12 | seq\`, where \`seq\` counts the ids minted within one
  millisecond (12 bits, masked with \`0xFFF\`). Ids must never go backwards: a repeated or earlier
  \`now_ms\` keeps the last millisecond and bumps \`seq\`; when \`seq\` wraps to 0, move on to the next
  millisecond.
- \`bucket_of(id)\` is the id's 10-day window counted from the Discord epoch:
  \`(id >> 22) // BUCKET_MS\`.
- \`store_message(channel_id, author_id, content)\` mints the id, computes the bucket, inserts the row
  and returns the message; the handler answers **201** with it. The id goes out as a **string**: a
  snowflake has 64 bits, a JSON number is safe up to 2⁵³.

:::widget status-codes {}

> The timestamp sits in the high bits, so sorting ids sorts by time, and the bucket falls out of the id
> with one shift and one division — no second column, no clock lookup, no index on \`created_at\`.`,
  sequence: {
    participants: ['Client', 'messages-api', 'messages'],
    messages: [
      {from: 'Client', to: 'messages-api', label: 'POST /channels/1032…/messages {author_id, content}', kind: 'sync'},
      {
        from: 'messages-api',
        to: 'messages-api',
        label: 'validate · next_id(now_ms) · bucket_of(id) = 430',
        kind: 'sync',
      },
      {from: 'messages-api', to: 'messages', label: 'INSERT (channel_id, 430, id, author_id, content)', kind: 'sync'},
      {from: 'messages', to: 'messages-api', label: 'ok', kind: 'reply'},
      {from: 'messages-api', to: 'Client', label: '201 {id: "1561…", bucket: 430, …}', kind: 'reply'},
    ],
  },
  hints: [
    'Keep two module-level values, the last millisecond used and the sequence within it. Compare the incoming `now_ms` with the last one first: equal or earlier means "same millisecond, next sequence"; later means "new millisecond, sequence 0".',
    'Assemble the id with shifts and ORs only: the timestamp field is `now_ms - DISCORD_EPOCH_MS`, not the raw Unix time. Masking the sequence with `0xFFF` is what makes it wrap; when it wraps to 0 add one to the millisecond before building the id.',
    'The bucket is a function of the id alone: shift the timestamp back out (`>> 22`) and integer-divide by `BUCKET_MS`. Store the bucket as its own column — it is part of the primary key, so the read side can ask for exactly one partition.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /channels/{channel_id}/messages',
      detail: 'A handler must be registered for `POST` on `/channels/{channel_id}/messages`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/channels\/\{channel_id\}\/messages["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/channels\/:channel_id\/messages['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/channels\/\{channel_id\}\/messages"/]},
        scala: {all: [/path\(\s*"channels"\s*\/\s*LongNumber\s*\/\s*"messages"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/channels\/\(\\d\+\)\/messages\)"/]},
      },
    },
    {
      id: 'validate-content',
      title: 'Rejects empty or over-long content with 400',
      detail:
        'Trim the content and require 1–`MAX_CONTENT` (2000) characters; answer `400 Bad Request` before minting an id or touching the table.',
      match: {
        python: {all: [/MAX_CONTENT|\b2000\b/, /\.strip\(\)/, /status_code\s*=\s*400|HTTP_400/]},
        typescript: {
          all: [/MAX_CONTENT|\b2000\b/, /\.trim\(\)/, /code\(\s*400\s*\)|status\(\s*400\s*\)|statusCode:\s*400/],
        },
        go: {all: [/maxContent|\b2000\b/, /strings\.TrimSpace\(/, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/MaxContent|\b2000\b/, /\.trim\b/, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/kMaxContent|\b2000\b/, /find_first_not_of\(/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'snowflake',
      title: 'Mints snowflakes: timestamp << 22, worker << 17, a 12-bit sequence',
      detail:
        'The id packs milliseconds since `DISCORD_EPOCH_MS` above bit 22, the worker id at bit 17 and a per-millisecond sequence masked to 12 bits; it never decreases.',
      match: {
        python: {all: [/DISCORD_EPOCH_MS\s*\)\s*<<\s*22/, /WORKER_ID\s*<<\s*17/, /&\s*0x[fF]{3}\b/]},
        typescript: {all: [/DISCORD_EPOCH_MS\s*\)\s*<<\s*22n?/, /WORKER_ID\s*<<\s*17n?/, /&\s*0x[fF]{3}n?\b/]},
        go: {all: [/discordEpochMs\s*\)\s*<<\s*22/, /workerID\s*<<\s*17/, /&\s*0x[fF]{3}\b/]},
        scala: {all: [/DiscordEpochMs\s*\)\s*<<\s*22/, /WorkerId\s*<<\s*17/, /&\s*0x[fF]{3}\b/]},
        cpp: {all: [/kDiscordEpochMs\s*\)\s*<<\s*22/, /kWorkerId\s*<<\s*17/, /&\s*0x[fF]{3}\b/]},
      },
    },
    {
      id: 'bucket',
      title: 'Derives the 10-day bucket from the id',
      detail:
        'The bucket is `(id >> 22) // BUCKET_MS`: the snowflake timestamp divided into 10-day windows from the Discord epoch, so every message of a channel in one window shares a partition.',
      match: {
        python: {all: [/\(\s*\w+\s*>>\s*22\s*\)\s*\/\/\s*BUCKET_MS/]},
        typescript: {all: [/\(\s*\w+\s*>>\s*22n?\s*\)\s*\/\s*(BigInt\(\s*BUCKET_MS\s*\)|BUCKET_MS)/]},
        go: {all: [/\(\s*\w+\s*>>\s*22\s*\)\s*\/\s*bucketMs/]},
        scala: {all: [/\(\s*\w+\s*>>\s*22\s*\)\s*\/\s*BucketMs/]},
        cpp: {all: [/\(\s*\w+\s*>>\s*22\s*\)\s*\/\s*kBucketMs/]},
      },
    },
    {
      id: 'insert-created',
      title: 'Inserts the row and answers 201 with the id as a string',
      detail:
        'Insert `(channel_id, bucket, message_id, author_id, content)`, then answer `201 Created` with the message; the id is serialised as a string because it does not fit a JSON number.',
      match: {
        python: {
          all: [
            /INSERT INTO messages \(channel_id, bucket, message_id, author_id, content\)/,
            /str\(\s*message_id\s*\)/,
          ],
          order: [/db\.execute\(/, /status_code\s*=\s*201/],
        },
        typescript: {
          all: [
            /INSERT INTO messages \(channel_id, bucket, message_id, author_id, content\)/,
            /String\(\s*messageId\s*\)|messageId\.toString\(\)/,
          ],
          order: [/db\.execute\(/, /code\(\s*201\s*\)/],
        },
        go: {
          all: [
            /INSERT INTO messages \(channel_id, bucket, message_id, author_id, content\)/,
            /strconv\.FormatInt\(\s*messageID\s*,\s*10\s*\)/,
          ],
          order: [/db\.Exec\(/, /http\.StatusCreated|\b201\b/],
        },
        scala: {
          all: [/INSERT INTO messages \(channel_id, bucket, message_id, author_id, content\)/, /messageId\.toString/],
          order: [/executeUpdate\(\)/, /StatusCodes\.Created/],
        },
        cpp: {
          all: [
            /INSERT INTO messages \(channel_id, bucket, message_id, author_id, content\)/,
            /std::to_string\(\s*message_id\s*\)/,
          ],
          order: [/db::exec\(/, /status\s*=\s*201/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from messages.db import db  # await db.execute(sql, params) -> dict rows; ids travel as text

app = FastAPI()

DISCORD_EPOCH_MS = 1_420_070_400_000  # 2015-01-01T00:00:00Z: the first instant a Discord id can name
WORKER_ID = 1
PROCESS_ID = 0
BUCKET_MS = 10 * 24 * 3600 * 1000  # one partition per channel per 10 days
MAX_CONTENT = 2000

_last_ms = 0
_seq = 0


def next_id(now_ms: int) -> int:
    """A snowflake: 42 bits of milliseconds since DISCORD_EPOCH_MS, 5 worker, 5 process, 12 sequence."""
    global _last_ms, _seq
    # TODO: now_ms <= _last_ms → reuse _last_ms and bump _seq (& 0xFFF); seq wrapped to 0 → next millisecond
    # TODO: a later now_ms → _seq = 0; remember _last_ms
    # TODO: (now_ms - DISCORD_EPOCH_MS) << 22 | WORKER_ID << 17 | PROCESS_ID << 12 | _seq
    raise NotImplementedError


def bucket_of(snowflake: int) -> int:
    """The 10-day window the id's timestamp falls in, counted from the Discord epoch."""
    # TODO: (snowflake >> 22) // BUCKET_MS
    raise NotImplementedError


def valid_content(content: str) -> bool:
    # TODO: 1..MAX_CONTENT characters once stripped
    return True


class NewMessage(BaseModel):
    author_id: int
    content: str = ""


async def store_message(channel_id: int, author_id: int, content: str) -> dict:
    """Mints the id, computes the bucket, inserts the row; returns the message as the API answers it."""
    # TODO: message_id = next_id(int(time.time() * 1000)); bucket = bucket_of(message_id)
    # TODO: INSERT INTO messages (channel_id, bucket, message_id, author_id, content)
    # TODO: {"id": str(message_id), "channel_id": str(channel_id), "author_id": str(author_id), "content": content, "bucket": bucket}
    raise NotImplementedError


@app.post("/channels/{channel_id}/messages")
async def post_message(channel_id: int, body: NewMessage) -> JSONResponse:
    # TODO: 400 unless valid_content(body.content)
    # TODO: store_message(...) → 201 with the message
    raise HTTPException(status_code=501)


# uvicorn post_message:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from messages.db import db  # await db.execute(sql, params) -> dict rows; ids travel as text

app = FastAPI()

DISCORD_EPOCH_MS = 1_420_070_400_000  # 2015-01-01T00:00:00Z: the first instant a Discord id can name
WORKER_ID = 1
PROCESS_ID = 0
BUCKET_MS = 10 * 24 * 3600 * 1000  # one partition per channel per 10 days
MAX_CONTENT = 2000

_last_ms = 0
_seq = 0


def next_id(now_ms: int) -> int:
    """A snowflake: 42 bits of milliseconds since DISCORD_EPOCH_MS, 5 worker, 5 process, 12 sequence."""
    global _last_ms, _seq
    if now_ms <= _last_ms:  # same millisecond, or a clock that stepped back: never issue a lower id
        now_ms = _last_ms
        _seq = (_seq + 1) & 0xFFF
        if _seq == 0:  # 4096 ids in one millisecond: borrow the next one
            now_ms += 1
    else:
        _seq = 0
    _last_ms = now_ms
    return (now_ms - DISCORD_EPOCH_MS) << 22 | WORKER_ID << 17 | PROCESS_ID << 12 | _seq


def bucket_of(snowflake: int) -> int:
    """The 10-day window the id's timestamp falls in, counted from the Discord epoch."""
    return (snowflake >> 22) // BUCKET_MS


def valid_content(content: str) -> bool:
    return 1 <= len(content.strip()) and len(content) <= MAX_CONTENT


class NewMessage(BaseModel):
    author_id: int
    content: str = ""


async def store_message(channel_id: int, author_id: int, content: str) -> dict:
    """Mints the id, computes the bucket, inserts the row; returns the message as the API answers it."""
    message_id = next_id(int(time.time() * 1000))
    bucket = bucket_of(message_id)
    await db.execute(
        "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES (%s, %s, %s, %s, %s)",
        (channel_id, bucket, message_id, author_id, content),
    )
    return {
        "id": str(message_id),  # 64 bits: a JSON number would lose the low bits past 2**53
        "channel_id": str(channel_id),
        "author_id": str(author_id),
        "content": content,
        "bucket": bucket,
    }


@app.post("/channels/{channel_id}/messages")
async def post_message(channel_id: int, body: NewMessage) -> JSONResponse:
    if not valid_content(body.content):
        raise HTTPException(status_code=400, detail="content must be 1 to 2000 characters")
    message = await store_message(channel_id, body.author_id, body.content)
    return JSONResponse(message, status_code=201)


# uvicorn post_message:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {db} from 'messages/db'; // await db.execute(sql, params) -> rows; ids travel as text

export const app = Fastify();

export const DISCORD_EPOCH_MS = 1_420_070_400_000; // 2015-01-01T00:00:00Z: the first instant a Discord id can name
export const WORKER_ID = 1;
export const PROCESS_ID = 0;
export const BUCKET_MS = 10 * 24 * 3600 * 1000; // one partition per channel per 10 days
export const MAX_CONTENT = 2000;

let lastMs = 0;
let seq = 0;

export interface NewMessage {
  author_id: number;
  content?: string;
}

export interface StoredMessage {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  bucket: number;
}

/** A snowflake: 42 bits of milliseconds since DISCORD_EPOCH_MS, 5 worker, 5 process, 12 sequence. */
export function next_id(nowMs: number): bigint {
  // TODO: nowMs <= lastMs → reuse lastMs and bump seq (& 0xFFF); seq wrapped to 0 → next millisecond
  // TODO: a later nowMs → seq = 0; remember lastMs
  // TODO: BigInt(nowMs - DISCORD_EPOCH_MS) << 22n | BigInt(WORKER_ID << 17 | PROCESS_ID << 12 | seq)
  throw new Error('not implemented');
}

/** The 10-day window the id's timestamp falls in, counted from the Discord epoch. */
export function bucket_of(snowflake: bigint): number {
  // TODO: Number((snowflake >> 22n) / BigInt(BUCKET_MS))
  throw new Error('not implemented');
}

export function valid_content(content: string): boolean {
  // TODO: 1..MAX_CONTENT characters once trimmed
  return true;
}

/** Mints the id, computes the bucket, inserts the row; returns the message as the API answers it. */
export async function store_message(channelId: bigint, authorId: bigint, content: string): Promise<StoredMessage> {
  // TODO: messageId = next_id(Date.now()); bucket = bucket_of(messageId)
  // TODO: INSERT INTO messages (channel_id, bucket, message_id, author_id, content)
  // TODO: {id: String(messageId), channel_id: String(channelId), author_id: String(authorId), content, bucket}
  throw new Error('not implemented');
}

app.post('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const body = request.body as NewMessage;
  // TODO: 400 unless valid_content(body.content ?? '')
  // TODO: store_message(...) → 201 with the message
  return reply.code(501).send();
});
`,
      solution: `import Fastify from 'fastify';

import {db} from 'messages/db'; // await db.execute(sql, params) -> rows; ids travel as text

export const app = Fastify();

export const DISCORD_EPOCH_MS = 1_420_070_400_000; // 2015-01-01T00:00:00Z: the first instant a Discord id can name
export const WORKER_ID = 1;
export const PROCESS_ID = 0;
export const BUCKET_MS = 10 * 24 * 3600 * 1000; // one partition per channel per 10 days
export const MAX_CONTENT = 2000;

let lastMs = 0;
let seq = 0;

export interface NewMessage {
  author_id: number;
  content?: string;
}

export interface StoredMessage {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  bucket: number;
}

/** A snowflake: 42 bits of milliseconds since DISCORD_EPOCH_MS, 5 worker, 5 process, 12 sequence. */
export function next_id(nowMs: number): bigint {
  if (nowMs <= lastMs) {
    // same millisecond, or a clock that stepped back: never issue a lower id
    nowMs = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) nowMs += 1; // 4096 ids in one millisecond: borrow the next one
  } else {
    seq = 0;
  }
  lastMs = nowMs;
  return (BigInt(nowMs - DISCORD_EPOCH_MS) << 22n) | BigInt((WORKER_ID << 17) | (PROCESS_ID << 12) | seq);
}

/** The 10-day window the id's timestamp falls in, counted from the Discord epoch. */
export function bucket_of(snowflake: bigint): number {
  return Number((snowflake >> 22n) / BigInt(BUCKET_MS));
}

export function valid_content(content: string): boolean {
  return content.trim().length >= 1 && content.length <= MAX_CONTENT;
}

/** Mints the id, computes the bucket, inserts the row; returns the message as the API answers it. */
export async function store_message(channelId: bigint, authorId: bigint, content: string): Promise<StoredMessage> {
  const messageId = next_id(Date.now());
  const bucket = bucket_of(messageId);
  await db.execute(
    'INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)',
    [channelId, bucket, messageId, authorId, content],
  );
  return {
    id: String(messageId), // 64 bits: a JSON number would lose the low bits past 2**53
    channel_id: String(channelId),
    author_id: String(authorId),
    content,
    bucket,
  };
}

app.post('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const body = request.body as NewMessage;
  if (!valid_content(body.content ?? '')) {
    return reply.code(400).send({error: 'content must be 1 to 2000 characters'});
  }
  const message = await store_message(channelId, BigInt(body.author_id), body.content ?? '');
  return reply.code(201).send(message);
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"discord/db" // db.Exec(ctx, sql, args...) error · db.Query(ctx, sql, args...) (*sql.Rows, error) — provided
)

const (
	discordEpochMs int64 = 1420070400000 // 2015-01-01T00:00:00Z: the first instant a Discord id can name
	workerID       int64 = 1
	processID      int64 = 0
	bucketMs       int64 = 10 * 24 * 3600 * 1000 // one partition per channel per 10 days
	maxContent           = 2000
)

var (
	idMu   sync.Mutex
	lastMs int64
	seq    int64
)

// nextID mints a snowflake: 42 bits of milliseconds since discordEpochMs, 5 worker, 5 process, 12 sequence.
func nextID(nowMs int64) int64 {
	idMu.Lock()
	defer idMu.Unlock()
	// TODO: nowMs <= lastMs → reuse lastMs and bump seq (& 0xFFF); seq wrapped to 0 → next millisecond
	// TODO: a later nowMs → seq = 0; remember lastMs
	// TODO: (nowMs - discordEpochMs) << 22 | workerID << 17 | processID << 12 | seq
	return 0
}

// bucketOf is the 10-day window the id's timestamp falls in, counted from the Discord epoch.
func bucketOf(snowflake int64) int32 {
	// TODO: (snowflake >> 22) / bucketMs
	return 0
}

func validContent(content string) bool {
	// TODO: 1..maxContent characters once trimmed
	_ = strings.TrimSpace
	return true
}

type message struct {
	ID        string \`json:"id"\`
	ChannelID string \`json:"channel_id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
	Bucket    int32  \`json:"bucket"\`
}

// storeMessage mints the id, computes the bucket, inserts the row; returns the message as the API answers it.
func storeMessage(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	// TODO: messageID := nextID(time.Now().UnixMilli()); bucket := bucketOf(messageID)
	// TODO: INSERT INTO messages (channel_id, bucket, message_id, author_id, content)
	// TODO: message{ID: strconv.FormatInt(messageID, 10), ...}
	_ = time.Now
	return message{}, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	channelID, err := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	var req struct {
		AuthorID int64  \`json:"author_id"\`
		Content  string \`json:"content"\`
	}
	// TODO: 400 unless the path id and the body parse and validContent(req.Content)
	// TODO: storeMessage(...) → 201 with the message
	_ = err
	_ = channelID
	_ = req
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /channels/{channel_id}/messages", postMessage)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"discord/db" // db.Exec(ctx, sql, args...) error · db.Query(ctx, sql, args...) (*sql.Rows, error) — provided
)

const (
	discordEpochMs int64 = 1420070400000 // 2015-01-01T00:00:00Z: the first instant a Discord id can name
	workerID       int64 = 1
	processID      int64 = 0
	bucketMs       int64 = 10 * 24 * 3600 * 1000 // one partition per channel per 10 days
	maxContent           = 2000
)

var (
	idMu   sync.Mutex
	lastMs int64
	seq    int64
)

// nextID mints a snowflake: 42 bits of milliseconds since discordEpochMs, 5 worker, 5 process, 12 sequence.
func nextID(nowMs int64) int64 {
	idMu.Lock()
	defer idMu.Unlock()
	if nowMs <= lastMs { // same millisecond, or a clock that stepped back: never issue a lower id
		nowMs = lastMs
		seq = (seq + 1) & 0xFFF
		if seq == 0 { // 4096 ids in one millisecond: borrow the next one
			nowMs++
		}
	} else {
		seq = 0
	}
	lastMs = nowMs
	return (nowMs-discordEpochMs)<<22 | workerID<<17 | processID<<12 | seq
}

// bucketOf is the 10-day window the id's timestamp falls in, counted from the Discord epoch.
func bucketOf(snowflake int64) int32 {
	return int32((snowflake >> 22) / bucketMs)
}

func validContent(content string) bool {
	return strings.TrimSpace(content) != "" && len([]rune(content)) <= maxContent
}

type message struct {
	ID        string \`json:"id"\`
	ChannelID string \`json:"channel_id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
	Bucket    int32  \`json:"bucket"\`
}

// storeMessage mints the id, computes the bucket, inserts the row; returns the message as the API answers it.
func storeMessage(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	messageID := nextID(time.Now().UnixMilli())
	bucket := bucketOf(messageID)
	err := db.Exec(ctx, "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)",
		channelID, bucket, messageID, authorID, content)
	if err != nil {
		return message{}, err
	}
	// 64 bits: a JSON number would lose the low bits past 2**53, so ids are strings on the wire.
	return message{ID: strconv.FormatInt(messageID, 10), ChannelID: strconv.FormatInt(channelID, 10),
		AuthorID: strconv.FormatInt(authorID, 10), Content: content, Bucket: bucket}, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	channelID, err := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	var req struct {
		AuthorID int64  \`json:"author_id"\`
		Content  string \`json:"content"\`
	}
	if err != nil || json.NewDecoder(r.Body).Decode(&req) != nil || !validContent(req.Content) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "content must be 1 to 2000 characters"})
		return
	}
	msg, err := storeMessage(r.Context(), channelID, req.AuthorID, req.Content)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, msg)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /channels/{channel_id}/messages", postMessage)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import discord.{Db, Tls} // Db.withConnection { conn => ... }: T · Tls.serverContext — provided
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class NewMessage(authorId: Long, content: String)
final case class StoredMessage(id: String, channelId: String, authorId: String, content: String, bucket: Int)

object PostMessage {
  val DiscordEpochMs = 1420070400000L // 2015-01-01T00:00:00Z: the first instant a Discord id can name
  val WorkerId = 1L
  val ProcessId = 0L
  val BucketMs = 10L * 24 * 3600 * 1000 // one partition per channel per 10 days
  val MaxContent = 2000

  implicit val newMessageFormat: RootJsonFormat[NewMessage] = jsonFormat(NewMessage, "author_id", "content")
  implicit val storedFormat: RootJsonFormat[StoredMessage] =
    jsonFormat(StoredMessage, "id", "channel_id", "author_id", "content", "bucket")

  private val lock = new Object
  private var lastMs = 0L
  private var seq = 0L

  /** A snowflake: 42 bits of milliseconds since DiscordEpochMs, 5 worker, 5 process, 12 sequence. */
  def nextId(nowMs: Long): Long = lock.synchronized {
    // TODO: nowMs <= lastMs → reuse lastMs and bump seq (& 0xFFF); seq wrapped to 0 → next millisecond
    // TODO: a later nowMs → seq = 0; remember lastMs
    // TODO: (nowMs - DiscordEpochMs) << 22 | WorkerId << 17 | ProcessId << 12 | seq
    ???
  }

  /** The 10-day window the id's timestamp falls in, counted from the Discord epoch. */
  def bucketOf(snowflake: Long): Int = {
    // TODO: (snowflake >> 22) / BucketMs
    ???
  }

  def validContent(content: String): Boolean = {
    // TODO: 1..MaxContent characters once trimmed
    true
  }

  /** Mints the id, computes the bucket, inserts the row; returns the message as the API answers it. */
  def storeMessage(channelId: Long, authorId: Long, content: String): StoredMessage = {
    // TODO: val messageId = nextId(System.currentTimeMillis()); val bucket = bucketOf(messageId)
    // TODO: INSERT INTO messages (channel_id, bucket, message_id, author_id, content)
    // TODO: StoredMessage(messageId.toString, channelId.toString, authorId.toString, content, bucket)
    ???
  }

  val route: Route =
    path("channels" / LongNumber / "messages") { channelId =>
      post {
        entity(as[NewMessage]) { req =>
          // TODO: 400 unless validContent(req.content)
          // TODO: storeMessage(...) → 201 with the message
          complete(HttpResponse(StatusCodes.NotImplemented))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("messages")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import discord.{Db, Tls} // Db.withConnection { conn => ... }: T · Tls.serverContext — provided
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class NewMessage(authorId: Long, content: String)
final case class StoredMessage(id: String, channelId: String, authorId: String, content: String, bucket: Int)

object PostMessage {
  val DiscordEpochMs = 1420070400000L // 2015-01-01T00:00:00Z: the first instant a Discord id can name
  val WorkerId = 1L
  val ProcessId = 0L
  val BucketMs = 10L * 24 * 3600 * 1000 // one partition per channel per 10 days
  val MaxContent = 2000

  implicit val newMessageFormat: RootJsonFormat[NewMessage] = jsonFormat(NewMessage, "author_id", "content")
  implicit val storedFormat: RootJsonFormat[StoredMessage] =
    jsonFormat(StoredMessage, "id", "channel_id", "author_id", "content", "bucket")

  private val lock = new Object
  private var lastMs = 0L
  private var seq = 0L

  /** A snowflake: 42 bits of milliseconds since DiscordEpochMs, 5 worker, 5 process, 12 sequence. */
  def nextId(now: Long): Long = lock.synchronized {
    var nowMs = now
    if (nowMs <= lastMs) { // same millisecond, or a clock that stepped back: never issue a lower id
      nowMs = lastMs
      seq = (seq + 1) & 0xFFF
      if (seq == 0) nowMs += 1 // 4096 ids in one millisecond: borrow the next one
    } else seq = 0
    lastMs = nowMs
    (nowMs - DiscordEpochMs) << 22 | WorkerId << 17 | ProcessId << 12 | seq
  }

  /** The 10-day window the id's timestamp falls in, counted from the Discord epoch. */
  def bucketOf(snowflake: Long): Int = ((snowflake >> 22) / BucketMs).toInt

  def validContent(content: String): Boolean = content.trim.nonEmpty && content.length <= MaxContent

  /** Mints the id, computes the bucket, inserts the row; returns the message as the API answers it. */
  def storeMessage(channelId: Long, authorId: Long, content: String): StoredMessage = {
    val messageId = nextId(System.currentTimeMillis())
    val bucket = bucketOf(messageId)
    Db.withConnection { conn =>
      val st = conn.prepareStatement(
        "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES (?, ?, ?, ?, ?)")
      st.setLong(1, channelId); st.setInt(2, bucket); st.setLong(3, messageId)
      st.setLong(4, authorId); st.setString(5, content)
      st.executeUpdate()
    }
    // 64 bits: a JSON number would lose the low bits past 2**53, so ids are strings on the wire.
    StoredMessage(messageId.toString, channelId.toString, authorId.toString, content, bucket)
  }

  val route: Route =
    path("channels" / LongNumber / "messages") { channelId =>
      post {
        entity(as[NewMessage]) { req =>
          if (!validContent(req.content))
            complete(StatusCodes.BadRequest -> Map("error" -> "content must be 1 to 2000 characters"))
          else complete(StatusCodes.Created -> storeMessage(channelId, req.authorId, req.content))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("messages")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>

#include "db.h"  // db::exec(sql, params...) runs one statement and returns a pqxx::result — provided

using json = nlohmann::json;

constexpr int64_t kDiscordEpochMs = 1420070400000LL;  // 2015-01-01T00:00:00Z: the first instant a Discord id can name
constexpr int64_t kWorkerId = 1;
constexpr int64_t kProcessId = 0;
constexpr int64_t kBucketMs = 10LL * 24 * 3600 * 1000;  // one partition per channel per 10 days
constexpr std::size_t kMaxContent = 2000;

std::mutex id_mu;
int64_t last_ms = 0;
int64_t seq = 0;

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// A snowflake: 42 bits of milliseconds since kDiscordEpochMs, 5 worker, 5 process, 12 sequence.
int64_t next_id(int64_t now) {
  std::lock_guard<std::mutex> guard(id_mu);
  // TODO: now <= last_ms → reuse last_ms and bump seq (& 0xFFF); seq wrapped to 0 → next millisecond
  // TODO: a later now → seq = 0; remember last_ms
  // TODO: (now - kDiscordEpochMs) << 22 | kWorkerId << 17 | kProcessId << 12 | seq
  return 0;
}

// The 10-day window the id's timestamp falls in, counted from the Discord epoch.
int32_t bucket_of(int64_t snowflake) {
  // TODO: (snowflake >> 22) / kBucketMs
  return 0;
}

bool valid_content(const std::string& content) {
  // TODO: 1..kMaxContent characters once trimmed (find_first_not_of whitespace)
  return true;
}

// Mints the id, computes the bucket, inserts the row; returns the message as the API answers it.
json store_message(int64_t channel_id, int64_t author_id, const std::string& content) {
  // TODO: const int64_t message_id = next_id(now_ms()); const int32_t bucket = bucket_of(message_id)
  // TODO: INSERT INTO messages (channel_id, bucket, message_id, author_id, content)
  // TODO: {"id": std::to_string(message_id), "channel_id": …, "author_id": …, "content": …, "bucket": bucket}
  return json::object();
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const int64_t author_id = body.value("author_id", 0LL);
    const std::string content = body.value("content", "");
    // TODO: 400 unless valid_content(content)
    // TODO: store_message(...) → 201 with the message
    (void)channel_id;
    (void)author_id;
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>

#include "db.h"  // db::exec(sql, params...) runs one statement and returns a pqxx::result — provided

using json = nlohmann::json;

constexpr int64_t kDiscordEpochMs = 1420070400000LL;  // 2015-01-01T00:00:00Z: the first instant a Discord id can name
constexpr int64_t kWorkerId = 1;
constexpr int64_t kProcessId = 0;
constexpr int64_t kBucketMs = 10LL * 24 * 3600 * 1000;  // one partition per channel per 10 days
constexpr std::size_t kMaxContent = 2000;

std::mutex id_mu;
int64_t last_ms = 0;
int64_t seq = 0;

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// A snowflake: 42 bits of milliseconds since kDiscordEpochMs, 5 worker, 5 process, 12 sequence.
int64_t next_id(int64_t now) {
  std::lock_guard<std::mutex> guard(id_mu);
  if (now <= last_ms) {  // same millisecond, or a clock that stepped back: never issue a lower id
    now = last_ms;
    seq = (seq + 1) & 0xFFF;
    if (seq == 0) ++now;  // 4096 ids in one millisecond: borrow the next one
  } else {
    seq = 0;
  }
  last_ms = now;
  return (now - kDiscordEpochMs) << 22 | kWorkerId << 17 | kProcessId << 12 | seq;
}

// The 10-day window the id's timestamp falls in, counted from the Discord epoch.
int32_t bucket_of(int64_t snowflake) { return static_cast<int32_t>((snowflake >> 22) / kBucketMs); }

bool valid_content(const std::string& content) {
  return content.find_first_not_of(" \\t\\r\\n") != std::string::npos && content.size() <= kMaxContent;
}

// Mints the id, computes the bucket, inserts the row; returns the message as the API answers it.
json store_message(int64_t channel_id, int64_t author_id, const std::string& content) {
  const int64_t message_id = next_id(now_ms());
  const int32_t bucket = bucket_of(message_id);
  db::exec("INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)",
           channel_id, bucket, message_id, author_id, content);
  // 64 bits: a JSON number would lose the low bits past 2**53, so ids are strings on the wire.
  return json{{"id", std::to_string(message_id)},
              {"channel_id", std::to_string(channel_id)},
              {"author_id", std::to_string(author_id)},
              {"content", content},
              {"bucket", bucket}};
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const int64_t author_id = body.value("author_id", 0LL);
    const std::string content = body.value("content", "");
    if (!valid_content(content)) {
      res.status = 400;
      res.set_content(R"({"error":"content must be 1 to 2000 characters"})", "application/json");
      return;
    }
    const json message = store_message(channel_id, author_id, content);
    res.status = 201;
    res.set_content(message.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import time

from messages.db import SCHEMA

EPOCH = 1420070400000
BUCKET_MS = 10 * 24 * 3600 * 1000
CHANNEL = ((400 * BUCKET_MS + 123456) << 22) | (1 << 17)  # a channel created in bucket 400


async def _api(ctx):
    await ctx.db.reset(SCHEMA)
    return ctx.load("post_message")


async def _rows(ctx):
    return await ctx.db.execute("SELECT channel_id, bucket, message_id, author_id, content FROM messages ORDER BY message_id")


async def check_route(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 42, "content": "hello"})
    assert r.status_code not in (404, 405), f"POST /channels/{{id}}/messages answered {r.status_code}: no handler is registered for it"
    assert r.status_code == 201, f"a valid message answered {r.status_code}, expected 201"


async def check_validate_content(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        for bad in ("", "   ", "\\n\\t", "a" * 2001):
            r = await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 42, "content": bad})
            assert r.status_code == 400, f"content {bad[:12]!r} ({len(bad)} chars) is not 1..2000 characters: expected 400, got {r.status_code}"
        assert await _rows(ctx) == [], "a rejected message must not reach the table"
        r = await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 42, "content": "a" * 2000})
        assert r.status_code == 201, f"exactly 2000 characters is allowed: expected 201, got {r.status_code}"
        r = await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 42, "content": "x"})
        assert r.status_code == 201, f"one character is allowed: expected 201, got {r.status_code}"


async def check_snowflake(ctx):
    m = await _api(ctx)
    ms = EPOCH + 430 * BUCKET_MS + 5000
    first = m.next_id(ms)
    assert (first >> 22) + EPOCH == ms, f"the high bits must be now_ms - DISCORD_EPOCH_MS: {first} decodes to {(first >> 22) + EPOCH}, expected {ms}"
    assert (first >> 17) & 0x1F == m.WORKER_ID, f"bits 17..21 must carry WORKER_ID ({m.WORKER_ID}), got {(first >> 17) & 0x1F}"
    assert first & 0xFFF == 0, f"the first id of a millisecond has sequence 0, got {first & 0xFFF}"
    second = m.next_id(ms)
    assert second >> 22 == first >> 22 and second & 0xFFF == 1, f"a second id in the same millisecond keeps the timestamp and takes sequence 1: {first} then {second}"
    later = m.next_id(ms + 7)
    assert (later >> 22) + EPOCH == ms + 7 and later & 0xFFF == 0, "a later millisecond restarts the sequence at 0"
    stepped_back = m.next_id(ms + 3)
    assert stepped_back > later, f"the clock stepped back (ms + 3 after ms + 7) and next_id issued a lower id: {stepped_back} <= {later}"
    burst_ms = ms + 1000
    ids = [m.next_id(burst_ms) for _ in range(4097)]
    assert all(b > a for a, b in zip(ids, ids[1:])), "ids minted within one millisecond must strictly increase"
    assert (ids[4095] >> 22) + EPOCH == burst_ms and ids[4095] & 0xFFF == 4095, "the 4096th id of a millisecond has sequence 4095"
    assert (ids[4096] >> 22) + EPOCH == burst_ms + 1 and ids[4096] & 0xFFF == 0, f"the 4097th id in one millisecond must move to the next millisecond with sequence 0, got ms {(ids[4096] >> 22) + EPOCH - burst_ms:+} seq {ids[4096] & 0xFFF}"


async def check_bucket(ctx):
    m = await _api(ctx)
    for offset_ms, expected in ((426 * BUCKET_MS, 426), (426 * BUCKET_MS + 9 * 24 * 3600 * 1000, 426), (427 * BUCKET_MS, 427), (0, 0)):
        snowflake = (offset_ms << 22) | (1 << 17) | 7
        got = m.bucket_of(snowflake)
        assert got == expected, f"bucket_of({snowflake}) is {got}, expected {expected}: (id >> 22) // BUCKET_MS counts 10-day windows from the Discord epoch"
    assert m.bucket_of(CHANNEL) == 400, "a channel id is a snowflake too: bucket_of(channel_id) is the window the channel was created in"
    assert m.BUCKET_MS == 864000000, f"BUCKET_MS must be 10 days in milliseconds, got {m.BUCKET_MS}"


async def check_insert_created(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 42, "content": "hello"})
        assert r.status_code == 201, f"expected 201 Created, got {r.status_code}"
        body = r.json()
        assert isinstance(body.get("id"), str) and body["id"].isdigit(), f"the id must be a string of digits (64 bits do not fit a JSON number), got {body.get('id')!r}"
        message_id = int(body["id"])
        assert message_id > 2**53, f"the id {message_id} is too small for a snowflake minted now: the timestamp must sit above bit 22"
        assert abs((message_id >> 22) + EPOCH - int(time.time() * 1000)) < 60000, "the id's timestamp must be the current time in milliseconds"
        assert body.get("bucket") == m.bucket_of(message_id), f"the body must carry the bucket of the id ({m.bucket_of(message_id)}), got {body.get('bucket')!r}"
        assert body.get("content") == "hello" and str(body.get("author_id")) == "42", f"the body must echo author_id and content: {body}"
        rows = await _rows(ctx)
        assert len(rows) == 1, f"expected one row in messages, found {len(rows)}"
        row = rows[0]
        assert int(row["channel_id"]) == CHANNEL, f"channel_id must be the path parameter, got {row['channel_id']!r}"
        assert int(row["message_id"]) == message_id, f"message_id must be the minted id {message_id}, got {row['message_id']!r}"
        assert row["bucket"] == m.bucket_of(message_id), f"bucket must be bucket_of(message_id) = {m.bucket_of(message_id)}, got {row['bucket']!r}"
        assert int(row["author_id"]) == 42 and row["content"] == "hello", f"author_id and content must be stored as sent, got {row}"
        r2 = await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 7, "content": "second"})
        assert int(r2.json()["id"]) > message_id, "ids must increase from one message to the next"
        assert len(await _rows(ctx)) == 2, "every accepted message is one row"
`,
    typescript: `import {SCHEMA} from 'messages/db';

const EPOCH = 1420070400000n;
const BUCKET_MS = 10n * 24n * 3600n * 1000n;
const CHANNEL = ((400n * BUCKET_MS + 123456n) << 22n) | (1n << 17n); // a channel created in bucket 400

async function api(ctx) {
  await ctx.db.reset(SCHEMA);
  return ctx.load('post_message');
}

async function rows(ctx) {
  return ctx.db.execute('SELECT channel_id, bucket, message_id, author_id, content FROM messages ORDER BY message_id');
}

export async function check_route(ctx) {
  const m = await api(ctx);
  const r = await ctx.client(m.app).post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 42, content: 'hello'}});
  assert(![404, 405].includes(r.status), \`POST /channels/{id}/messages answered \${r.status}: no handler is registered for it\`);
  assert.equal(r.status, 201, \`a valid message answered \${r.status}, expected 201\`);
}

export async function check_validate_content(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  for (const bad of ['', '   ', '\\n\\t', 'a'.repeat(2001)]) {
    const r = await c.post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 42, content: bad}});
    assert.equal(r.status, 400, \`content \${JSON.stringify(bad.slice(0, 12))} (\${bad.length} chars) is not 1..2000 characters: expected 400, got \${r.status}\`);
  }
  assert.deepEqual(await rows(ctx), [], 'a rejected message must not reach the table');
  let r = await c.post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 42, content: 'a'.repeat(2000)}});
  assert.equal(r.status, 201, \`exactly 2000 characters is allowed: expected 201, got \${r.status}\`);
  r = await c.post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 42, content: 'x'}});
  assert.equal(r.status, 201, \`one character is allowed: expected 201, got \${r.status}\`);
}

export async function check_snowflake(ctx) {
  const m = await api(ctx);
  const ms = Number(EPOCH + 430n * BUCKET_MS) + 5000;
  const first: bigint = m.next_id(ms);
  assert.equal((first >> 22n) + EPOCH, BigInt(ms), \`the high bits must be now_ms - DISCORD_EPOCH_MS: \${first} decodes to \${(first >> 22n) + EPOCH}, expected \${ms}\`);
  assert.equal(Number((first >> 17n) & 0x1fn), m.WORKER_ID, \`bits 17..21 must carry WORKER_ID (\${m.WORKER_ID}), got \${(first >> 17n) & 0x1fn}\`);
  assert.equal(first & 0xfffn, 0n, \`the first id of a millisecond has sequence 0, got \${first & 0xfffn}\`);
  const second: bigint = m.next_id(ms);
  assert(second >> 22n === first >> 22n && (second & 0xfffn) === 1n, \`a second id in the same millisecond keeps the timestamp and takes sequence 1: \${first} then \${second}\`);
  const later: bigint = m.next_id(ms + 7);
  assert((later >> 22n) + EPOCH === BigInt(ms + 7) && (later & 0xfffn) === 0n, 'a later millisecond restarts the sequence at 0');
  const steppedBack: bigint = m.next_id(ms + 3);
  assert(steppedBack > later, \`the clock stepped back (ms + 3 after ms + 7) and next_id issued a lower id: \${steppedBack} <= \${later}\`);
  const burstMs = ms + 1000;
  const ids: bigint[] = Array.from({length: 4097}, () => m.next_id(burstMs));
  assert(ids.every((id, i) => i === 0 || id > ids[i - 1]), 'ids minted within one millisecond must strictly increase');
  assert((ids[4095] >> 22n) + EPOCH === BigInt(burstMs) && (ids[4095] & 0xfffn) === 4095n, 'the 4096th id of a millisecond has sequence 4095');
  assert((ids[4096] >> 22n) + EPOCH === BigInt(burstMs + 1) && (ids[4096] & 0xfffn) === 0n, \`the 4097th id in one millisecond must move to the next millisecond with sequence 0, got ms \${(ids[4096] >> 22n) + EPOCH - BigInt(burstMs)} seq \${ids[4096] & 0xfffn}\`);
}

export async function check_bucket(ctx) {
  const m = await api(ctx);
  const cases: [bigint, number][] = [
    [426n * BUCKET_MS, 426],
    [426n * BUCKET_MS + 9n * 24n * 3600n * 1000n, 426],
    [427n * BUCKET_MS, 427],
    [0n, 0],
  ];
  for (const [offsetMs, expected] of cases) {
    const snowflake = (offsetMs << 22n) | (1n << 17n) | 7n;
    const got = m.bucket_of(snowflake);
    assert.equal(got, expected, \`bucket_of(\${snowflake}) is \${got}, expected \${expected}: (id >> 22) / BUCKET_MS counts 10-day windows from the Discord epoch\`);
  }
  assert.equal(m.bucket_of(CHANNEL), 400, 'a channel id is a snowflake too: bucket_of(channel_id) is the window the channel was created in');
  assert.equal(m.BUCKET_MS, 864000000, \`BUCKET_MS must be 10 days in milliseconds, got \${m.BUCKET_MS}\`);
}

export async function check_insert_created(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const r = await c.post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 42, content: 'hello'}});
  assert.equal(r.status, 201, \`expected 201 Created, got \${r.status}\`);
  const body = r.json() as Record<string, unknown>;
  assert(typeof body.id === 'string' && /^\\d+$/.test(body.id), \`the id must be a string of digits (64 bits do not fit a JSON number), got \${JSON.stringify(body.id)}\`);
  const messageId = BigInt(body.id as string);
  assert(messageId > 2n ** 53n, \`the id \${messageId} is too small for a snowflake minted now: the timestamp must sit above bit 22\`);
  assert(Math.abs(Number((messageId >> 22n) + EPOCH) - Date.now()) < 60000, "the id's timestamp must be the current time in milliseconds");
  assert.equal(body.bucket, m.bucket_of(messageId), \`the body must carry the bucket of the id (\${m.bucket_of(messageId)}), got \${JSON.stringify(body.bucket)}\`);
  assert(body.content === 'hello' && String(body.author_id) === '42', \`the body must echo author_id and content: \${JSON.stringify(body)}\`);
  const stored = await rows(ctx);
  assert.equal(stored.length, 1, \`expected one row in messages, found \${stored.length}\`);
  const row = stored[0];
  assert.equal(BigInt(row.channel_id), CHANNEL, \`channel_id must be the path parameter, got \${JSON.stringify(row.channel_id)}\`);
  assert.equal(BigInt(row.message_id), messageId, \`message_id must be the minted id \${messageId}, got \${JSON.stringify(row.message_id)}\`);
  assert.equal(row.bucket, m.bucket_of(messageId), \`bucket must be bucket_of(message_id) = \${m.bucket_of(messageId)}, got \${JSON.stringify(row.bucket)}\`);
  assert(String(row.author_id) === '42' && row.content === 'hello', \`author_id and content must be stored as sent, got \${JSON.stringify(row)}\`);
  const r2 = await c.post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 7, content: 'second'}});
  assert(BigInt((r2.json() as {id: string}).id) > messageId, 'ids must increase from one message to the next');
  assert.equal((await rows(ctx)).length, 2, 'every accepted message is one row');
}
`,
  },
  debrief: `A snowflake is an id and a clock in one 64-bit word: the timestamp in the high bits makes ids sort by time, the worker and sequence bits make them unique without a central counter, and the 12-bit sequence lets one process mint 4,096 ids per millisecond before it has to borrow the next one. Discord's 2017 schema leaned on exactly that: the primary key became (channel_id, bucket, message_id), with the bucket derived from the id, so every message of a channel from one 10-day window lands in one partition and a page of recent history is one contiguous range scan. The epoch is chosen so the timestamp fits in 42 bits for 139 years, and ids go out as strings because the languages reading the JSON cannot hold 64 bits in a number. Real services allocate worker ids from a registry so two instances can never agree on one, and refuse to mint when the clock steps back by more than a few milliseconds instead of silently reusing the last one.`,
};
