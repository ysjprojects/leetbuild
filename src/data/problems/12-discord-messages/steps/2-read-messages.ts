import type {Step} from '@/lib/types';

export const readMessagesStep: Step = {
  id: 'read-messages',
  title: 'GET a page: walk the buckets backwards',
  concept: 'http',
  file: 'read_messages',
  focus: ['api', 'db'],
  task: `## Task

Implement \`GET /channels/{channel_id}/messages?before=&limit=\`: the newest messages first, older than
the snowflake \`before\`. \`bucket_of\` comes from step 1; \`latest_snowflake()\` (an id newer than
anything minted so far, the cursor when the client sends none) is provided.

- \`limit\` defaults to **50** and must be **1–100**; anything else is a **400**.
- \`fetch_bucket(channel_id, bucket, before, limit)\` reads **one partition**:
  \`WHERE channel_id = … AND bucket = … AND message_id < … ORDER BY message_id DESC LIMIT …\`.
- \`read_page\` starts at \`bucket_of(before)\` and walks **one bucket back at a time** until the page
  holds \`limit\` messages, asking each bucket only for what is still missing. It stops at
  \`bucket_of(channel_id)\`: a channel id is a snowflake too, and nothing was sent before the channel
  existed.
- A quiet channel makes that walk a chain of empty reads. Remember, per channel, the buckets that
  came back empty in \`known_empty\` and skip them next time — but only a bucket **older than the
  starting one** can be trusted: in the starting bucket, "nothing older than \`before\`" says nothing
  about the bucket itself.

:::widget status-codes {}

> Each bucket is one partition on one node. Walking them in order from newest to oldest turns "the
> last 50 messages" into one range scan for a busy channel, and the empty-bucket memo keeps a quiet
> channel from paying for every window it slept through.`,
  sequence: {
    participants: ['Client', 'messages-api', 'messages'],
    messages: [
      {from: 'Client', to: 'messages-api', label: 'GET /channels/1032…/messages?limit=50', kind: 'sync'},
      {
        from: 'messages-api',
        to: 'messages',
        label: 'SELECT … bucket = 430 AND message_id < before LIMIT 50',
        kind: 'sync',
      },
      {from: 'messages', to: 'messages-api', label: '38 rows', kind: 'reply'},
      {from: 'messages-api', to: 'messages', label: 'SELECT … bucket = 429 … LIMIT 12', kind: 'sync'},
      {from: 'messages', to: 'messages-api', label: '0 rows → known_empty[channel] += 429', kind: 'reply'},
      {from: 'messages-api', to: 'messages', label: 'SELECT … bucket = 428 … LIMIT 12', kind: 'sync'},
      {from: 'messages', to: 'messages-api', label: '12 rows', kind: 'reply'},
      {from: 'messages-api', to: 'Client', label: '200 [50 messages, newest first]', kind: 'reply'},
    ],
  },
  hints: [
    'The loop has two exits and one skip: stop when the page is full, stop when the bucket drops below `bucket_of(channel_id)`, skip buckets already known to be empty. Decrement the bucket on every iteration, skipped or not.',
    'Pass `limit - len(page)` to each bucket query: the first bucket may fill most of the page and the next one should only top it up; `ORDER BY message_id DESC` inside each bucket plus walking buckets downwards gives a globally newest-first page.',
    'Mark a bucket empty only when it returned nothing *and* it is strictly older than the bucket you started in. The starting bucket is filtered by the cursor, so an empty result there proves nothing about the bucket.',
  ],
  checks: [
    {
      id: 'limit-bounds',
      title: 'Defaults limit to 50 and rejects anything outside 1–100 with 400',
      detail:
        'A missing `limit` means 50; `limit < 1` or `limit > MAX_LIMIT` (100) is a `400 Bad Request`, not a silent clamp.',
      match: {
        python: {all: [/limit\s*<\s*1|limit\s*>\s*MAX_LIMIT/, /status_code\s*=\s*400|HTTP_400/]},
        typescript: {
          all: [/limit\s*<\s*1|limit\s*>\s*MAX_LIMIT/, /code\(\s*400\s*\)|status\(\s*400\s*\)|statusCode:\s*400/],
        },
        go: {all: [/limit\s*<\s*1|limit\s*>\s*maxLimit/, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/limit\s*<\s*1|limit\s*>\s*MaxLimit/, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/limit\s*<\s*1|limit\s*>\s*kMaxLimit/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'newest-first',
      title: 'Reads one bucket newest-first under the cursor',
      detail:
        'The bucket query is `WHERE channel_id = … AND bucket = … AND message_id < before ORDER BY message_id DESC LIMIT n`: one partition, in id order, bounded.',
      match: {
        python: {
          all: [/WHERE channel_id = %s AND bucket = %s AND message_id < %s/, /ORDER BY message_id DESC/, /LIMIT %s/],
        },
        typescript: {
          all: [
            /WHERE channel_id = \$1 AND bucket = \$2 AND message_id < \$3/,
            /ORDER BY message_id DESC/,
            /LIMIT \$4/,
          ],
        },
        go: {
          all: [
            /WHERE channel_id = \$1 AND bucket = \$2 AND message_id < \$3/,
            /ORDER BY message_id DESC/,
            /LIMIT \$4/,
          ],
        },
        scala: {
          all: [/WHERE channel_id = \? AND bucket = \? AND message_id < \?/, /ORDER BY message_id DESC/, /LIMIT \?/],
        },
        cpp: {
          all: [
            /WHERE channel_id = \$1 AND bucket = \$2 AND message_id < \$3/,
            /ORDER BY message_id DESC/,
            /LIMIT \$4/,
          ],
        },
      },
    },
    {
      id: 'walk-back',
      title: 'Walks buckets backwards until the page is full',
      detail:
        'Starting at `bucket_of(before)`, the bucket decreases by one per iteration while the page holds fewer than `limit` messages; each query asks only for what is still missing.',
      match: {
        python: {all: [/bucket\s*-=\s*1/, /len\(\s*page\s*\)\s*<\s*limit/, /limit\s*-\s*len\(\s*page\s*\)/]},
        typescript: {all: [/bucket--|bucket\s*-=\s*1/, /page\.length\s*<\s*limit/, /limit\s*-\s*page\.length/]},
        go: {all: [/bucket--|bucket\s*-=\s*1/, /len\(\s*page\s*\)\s*<\s*limit/, /limit\s*-\s*len\(\s*page\s*\)/]},
        scala: {all: [/bucket\s*-=\s*1/, /page\.(size|length)\s*<\s*limit/, /limit\s*-\s*page\.(size|length)/]},
        cpp: {
          all: [
            /--bucket|bucket--|bucket\s*-=\s*1/,
            /page\.size\(\)\s*<\s*static_cast<std::size_t>\(\s*limit\s*\)/,
            /limit\s*-\s*static_cast<int>\(\s*page\.size\(\)\s*\)/,
          ],
        },
      },
    },
    {
      id: 'channel-floor',
      title: 'Stops at the bucket the channel was created in',
      detail:
        'The channel id is a snowflake: `bucket_of(channel_id)` is the oldest bucket that can hold a message, and the walk never goes below it.',
      match: {
        python: {all: [/bucket_of\(\s*channel_id\s*\)/, /bucket\s*>=\s*first_bucket/]},
        typescript: {all: [/bucket_of\(\s*channelId\s*\)/, /bucket\s*>=\s*firstBucket/]},
        go: {all: [/bucketOf\(\s*channelID\s*\)/, /bucket\s*>=\s*firstBucket/]},
        scala: {all: [/bucketOf\(\s*channelId\s*\)/, /bucket\s*>=\s*firstBucket/]},
        cpp: {all: [/bucket_of\(\s*channel_id\s*\)/, /bucket\s*>=\s*first_bucket/]},
      },
    },
    {
      id: 'empty-memo',
      title: 'Remembers empty buckets per channel and skips them',
      detail:
        'A bucket older than the starting one that returns no rows is recorded in `known_empty` for the channel and never queried again; the starting bucket is never recorded.',
      match: {
        python: {all: [/empty\.add\(\s*bucket\s*\)/, /bucket not in empty|bucket in empty/, /bucket\s*<\s*start/]},
        typescript: {all: [/empty\.add\(\s*bucket\s*\)/, /empty\.has\(\s*bucket\s*\)/, /bucket\s*<\s*start/]},
        go: {
          all: [
            /markEmpty\(\s*channelID\s*,\s*bucket\s*\)/,
            /isEmpty\(\s*channelID\s*,\s*bucket\s*\)/,
            /bucket\s*<\s*start/,
          ],
        },
        scala: {
          all: [
            /markEmpty\(\s*channelId\s*,\s*bucket\s*\)/,
            /isEmpty\(\s*channelId\s*,\s*bucket\s*\)/,
            /bucket\s*<\s*start/,
          ],
        },
        cpp: {
          all: [
            /mark_empty\(\s*channel_id\s*,\s*bucket\s*\)/,
            /is_empty\(\s*channel_id\s*,\s*bucket\s*\)/,
            /bucket\s*<\s*start/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from messages.db import db  # await db.execute(sql, params) -> dict rows; ids travel as text
from post_message import DISCORD_EPOCH_MS, bucket_of  # built in step 1

app = FastAPI()

DEFAULT_LIMIT = 50
MAX_LIMIT = 100

known_empty: dict[int, set[int]] = {}  # channel id → buckets that came back empty, skipped on later reads


def latest_snowflake() -> int:
    """An id newer than any message minted so far: the cursor when the client sends no \`before\` (provided)."""
    return (int(time.time() * 1000) + 1 - DISCORD_EPOCH_MS) << 22


async def fetch_bucket(channel_id: int, bucket: int, before: int, limit: int) -> list[dict]:
    """The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`."""
    # TODO: SELECT message_id, author_id, content … WHERE channel_id, bucket, message_id < before ORDER BY message_id DESC LIMIT
    # TODO: [{"id": …, "author_id": …, "content": …}] (the id columns already come back as strings)
    raise NotImplementedError


async def read_page(channel_id: int, before: int, limit: int) -> list[dict]:
    """Walks from bucket_of(before) down to bucket_of(channel_id) until \`limit\` messages are collected."""
    # TODO: first_bucket = bucket_of(channel_id); start = bucket_of(before); empty = known_empty for this channel
    # TODO: while the page is short and bucket >= first_bucket: skip known-empty buckets, fetch limit - len(page)
    # TODO: an empty result in a bucket older than start → remember it; bucket -= 1
    raise NotImplementedError


@app.get("/channels/{channel_id}/messages")
async def get_messages(channel_id: int, before: int | None = None, limit: int = DEFAULT_LIMIT) -> JSONResponse:
    # TODO: 400 unless 1 <= limit <= MAX_LIMIT
    # TODO: read_page(channel_id, before or latest_snowflake(), limit)
    raise HTTPException(status_code=501)
`,
      solution: `import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from messages.db import db  # await db.execute(sql, params) -> dict rows; ids travel as text
from post_message import DISCORD_EPOCH_MS, bucket_of  # built in step 1

app = FastAPI()

DEFAULT_LIMIT = 50
MAX_LIMIT = 100

known_empty: dict[int, set[int]] = {}  # channel id → buckets that came back empty, skipped on later reads


def latest_snowflake() -> int:
    """An id newer than any message minted so far: the cursor when the client sends no \`before\` (provided)."""
    return (int(time.time() * 1000) + 1 - DISCORD_EPOCH_MS) << 22


async def fetch_bucket(channel_id: int, bucket: int, before: int, limit: int) -> list[dict]:
    """The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`."""
    rows = await db.execute(
        "SELECT message_id, author_id, content FROM messages"
        " WHERE channel_id = %s AND bucket = %s AND message_id < %s ORDER BY message_id DESC LIMIT %s",
        (channel_id, bucket, before, limit),
    )
    return [{"id": row["message_id"], "author_id": row["author_id"], "content": row["content"]} for row in rows]


async def read_page(channel_id: int, before: int, limit: int) -> list[dict]:
    """Walks from bucket_of(before) down to bucket_of(channel_id) until \`limit\` messages are collected."""
    first_bucket = bucket_of(channel_id)  # a channel id is a snowflake: nothing was sent before the channel existed
    start = bucket_of(before)
    empty = known_empty.setdefault(channel_id, set())
    page: list[dict] = []
    bucket = start
    while len(page) < limit and bucket >= first_bucket:
        if bucket not in empty:
            rows = await fetch_bucket(channel_id, bucket, before, limit - len(page))
            page.extend(rows)
            if not rows and bucket < start:  # the cursor hid nothing here: the bucket really is empty
                empty.add(bucket)
        bucket -= 1
    return page


@app.get("/channels/{channel_id}/messages")
async def get_messages(channel_id: int, before: int | None = None, limit: int = DEFAULT_LIMIT) -> JSONResponse:
    if limit < 1 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 100")
    cursor = before if before is not None else latest_snowflake()
    return JSONResponse(await read_page(channel_id, cursor, limit))
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {db} from 'messages/db'; // await db.execute(sql, params) -> rows; ids travel as text
import {bucket_of, DISCORD_EPOCH_MS} from './post_message'; // built in step 1

export const app = Fastify();

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface PageMessage {
  id: string;
  author_id: string;
  content: string;
}

export const known_empty = new Map<bigint, Set<number>>(); // channel id → buckets that came back empty, skipped on later reads

/** An id newer than any message minted so far: the cursor when the client sends no \`before\` (provided). */
export function latest_snowflake(): bigint {
  return BigInt(Date.now() + 1 - DISCORD_EPOCH_MS) << 22n;
}

/** The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`. */
export async function fetch_bucket(channelId: bigint, bucket: number, before: bigint, limit: number): Promise<PageMessage[]> {
  // TODO: SELECT message_id, author_id, content … WHERE channel_id, bucket, message_id < before ORDER BY message_id DESC LIMIT
  // TODO: [{id, author_id, content}] (the id columns already come back as strings)
  throw new Error('not implemented');
}

/** Walks from bucket_of(before) down to bucket_of(channel_id) until \`limit\` messages are collected. */
export async function read_page(channelId: bigint, before: bigint, limit: number): Promise<PageMessage[]> {
  // TODO: firstBucket = bucket_of(channelId); start = bucket_of(before); empty = known_empty for this channel
  // TODO: while the page is short and bucket >= firstBucket: skip known-empty buckets, fetch limit - page.length
  // TODO: an empty result in a bucket older than start → remember it; bucket -= 1
  throw new Error('not implemented');
}

app.get('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const query = request.query as {before?: string; limit?: string};
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  // TODO: 400 unless 1 <= limit <= MAX_LIMIT
  // TODO: read_page(channelId, before ?? latest_snowflake(), limit)
  return reply.code(501).send();
});
`,
      solution: `import Fastify from 'fastify';

import {db} from 'messages/db'; // await db.execute(sql, params) -> rows; ids travel as text
import {bucket_of, DISCORD_EPOCH_MS} from './post_message'; // built in step 1

export const app = Fastify();

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface PageMessage {
  id: string;
  author_id: string;
  content: string;
}

export const known_empty = new Map<bigint, Set<number>>(); // channel id → buckets that came back empty, skipped on later reads

/** An id newer than any message minted so far: the cursor when the client sends no \`before\` (provided). */
export function latest_snowflake(): bigint {
  return BigInt(Date.now() + 1 - DISCORD_EPOCH_MS) << 22n;
}

/** The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`. */
export async function fetch_bucket(channelId: bigint, bucket: number, before: bigint, limit: number): Promise<PageMessage[]> {
  const rows = await db.execute<{message_id: string; author_id: string; content: string}>(
    'SELECT message_id, author_id, content FROM messages' +
      ' WHERE channel_id = $1 AND bucket = $2 AND message_id < $3 ORDER BY message_id DESC LIMIT $4',
    [channelId, bucket, before, limit],
  );
  return rows.map(row => ({id: row.message_id, author_id: row.author_id, content: row.content}));
}

/** Walks from bucket_of(before) down to bucket_of(channel_id) until \`limit\` messages are collected. */
export async function read_page(channelId: bigint, before: bigint, limit: number): Promise<PageMessage[]> {
  const firstBucket = bucket_of(channelId); // a channel id is a snowflake: nothing was sent before the channel existed
  const start = bucket_of(before);
  let empty = known_empty.get(channelId);
  if (empty === undefined) {
    empty = new Set();
    known_empty.set(channelId, empty);
  }
  const page: PageMessage[] = [];
  let bucket = start;
  while (page.length < limit && bucket >= firstBucket) {
    if (!empty.has(bucket)) {
      const rows = await fetch_bucket(channelId, bucket, before, limit - page.length);
      page.push(...rows);
      if (rows.length === 0 && bucket < start) empty.add(bucket); // the cursor hid nothing here: the bucket really is empty
    }
    bucket -= 1;
  }
  return page;
}

app.get('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const query = request.query as {before?: string; limit?: string};
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return reply.code(400).send({error: 'limit must be between 1 and 100'});
  }
  const cursor = query.before !== undefined ? BigInt(query.before) : latest_snowflake();
  return read_page(channelId, cursor, limit);
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
	"sync"
	"time"

	"discord/db" // db.Exec(ctx, sql, args...) error · db.Query(ctx, sql, args...) (*sql.Rows, error) — provided
)

const (
	defaultLimit         = 50
	maxLimit             = 100
	discordEpochMs int64 = 1420070400000
)

// Built in step 1 (post_message.go).
var bucketOf = func(snowflake int64) int32 { panic("not implemented") }

type storedMessage struct {
	ID       string \`json:"id"\`
	AuthorID string \`json:"author_id"\`
	Content  string \`json:"content"\`
}

// knownEmpty remembers, per channel, the buckets that came back empty; skipped on later reads (provided).
var (
	emptyMu    sync.Mutex
	knownEmpty = map[int64]map[int32]bool{}
)

func isEmpty(channelID int64, bucket int32) bool {
	emptyMu.Lock()
	defer emptyMu.Unlock()
	return knownEmpty[channelID][bucket]
}

func markEmpty(channelID int64, bucket int32) {
	emptyMu.Lock()
	defer emptyMu.Unlock()
	if knownEmpty[channelID] == nil {
		knownEmpty[channelID] = map[int32]bool{}
	}
	knownEmpty[channelID][bucket] = true
}

// latestSnowflake is an id newer than any message minted so far: the cursor when the client sends no before (provided).
func latestSnowflake() int64 { return (time.Now().UnixMilli() + 1 - discordEpochMs) << 22 }

// fetchBucket reads the newest limit messages of one (channel, bucket) partition older than before.
func fetchBucket(ctx context.Context, channelID int64, bucket int32, before int64, limit int) ([]storedMessage, error) {
	// TODO: SELECT message_id, author_id, content … WHERE channel_id, bucket, message_id < before ORDER BY message_id DESC LIMIT
	// TODO: scan rows into storedMessage{ID: strconv.FormatInt(id, 10), ...}
	_ = db.Query
	_ = strconv.FormatInt
	return nil, nil
}

// readPage walks from bucketOf(before) down to bucketOf(channelID) until limit messages are collected.
func readPage(ctx context.Context, channelID, before int64, limit int) ([]storedMessage, error) {
	// TODO: firstBucket := bucketOf(channelID); start := bucketOf(before)
	// TODO: for bucket := start; the page is short && bucket >= firstBucket; bucket--: skip isEmpty buckets, fetch limit - len(page)
	// TODO: an empty result in a bucket older than start → markEmpty
	return nil, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getMessages(rw http.ResponseWriter, r *http.Request) {
	channelID, _ := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	q := r.URL.Query()
	limit := defaultLimit
	if q.Get("limit") != "" {
		limit, _ = strconv.Atoi(q.Get("limit"))
	}
	before := latestSnowflake()
	if q.Get("before") != "" {
		before, _ = strconv.ParseInt(q.Get("before"), 10, 64)
	}
	// TODO: 400 unless 1 <= limit <= maxLimit
	// TODO: readPage(ctx, channelID, before, limit) → 200 with the page
	_ = channelID
	_ = before
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /channels/{channel_id}/messages", getMessages)
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
	"sync"
	"time"

	"discord/db" // db.Exec(ctx, sql, args...) error · db.Query(ctx, sql, args...) (*sql.Rows, error) — provided
)

const (
	defaultLimit         = 50
	maxLimit             = 100
	discordEpochMs int64 = 1420070400000
)

// Built in step 1 (post_message.go).
var bucketOf = func(snowflake int64) int32 { panic("not implemented") }

type storedMessage struct {
	ID       string \`json:"id"\`
	AuthorID string \`json:"author_id"\`
	Content  string \`json:"content"\`
}

// knownEmpty remembers, per channel, the buckets that came back empty; skipped on later reads (provided).
var (
	emptyMu    sync.Mutex
	knownEmpty = map[int64]map[int32]bool{}
)

func isEmpty(channelID int64, bucket int32) bool {
	emptyMu.Lock()
	defer emptyMu.Unlock()
	return knownEmpty[channelID][bucket]
}

func markEmpty(channelID int64, bucket int32) {
	emptyMu.Lock()
	defer emptyMu.Unlock()
	if knownEmpty[channelID] == nil {
		knownEmpty[channelID] = map[int32]bool{}
	}
	knownEmpty[channelID][bucket] = true
}

// latestSnowflake is an id newer than any message minted so far: the cursor when the client sends no before (provided).
func latestSnowflake() int64 { return (time.Now().UnixMilli() + 1 - discordEpochMs) << 22 }

// fetchBucket reads the newest limit messages of one (channel, bucket) partition older than before.
func fetchBucket(ctx context.Context, channelID int64, bucket int32, before int64, limit int) ([]storedMessage, error) {
	rows, err := db.Query(ctx, "SELECT message_id, author_id, content FROM messages"+
		" WHERE channel_id = $1 AND bucket = $2 AND message_id < $3 ORDER BY message_id DESC LIMIT $4",
		channelID, bucket, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []storedMessage{}
	for rows.Next() {
		var id, author int64
		var content string
		if err := rows.Scan(&id, &author, &content); err != nil {
			return nil, err
		}
		out = append(out, storedMessage{ID: strconv.FormatInt(id, 10), AuthorID: strconv.FormatInt(author, 10), Content: content})
	}
	return out, rows.Err()
}

// readPage walks from bucketOf(before) down to bucketOf(channelID) until limit messages are collected.
func readPage(ctx context.Context, channelID, before int64, limit int) ([]storedMessage, error) {
	firstBucket := bucketOf(channelID) // a channel id is a snowflake: nothing was sent before the channel existed
	start := bucketOf(before)
	page := []storedMessage{}
	for bucket := start; len(page) < limit && bucket >= firstBucket; bucket-- {
		if isEmpty(channelID, bucket) {
			continue
		}
		rows, err := fetchBucket(ctx, channelID, bucket, before, limit-len(page))
		if err != nil {
			return nil, err
		}
		page = append(page, rows...)
		if len(rows) == 0 && bucket < start { // the cursor hid nothing here: the bucket really is empty
			markEmpty(channelID, bucket)
		}
	}
	return page, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getMessages(rw http.ResponseWriter, r *http.Request) {
	channelID, _ := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	q := r.URL.Query()
	limit := defaultLimit
	if q.Get("limit") != "" {
		limit, _ = strconv.Atoi(q.Get("limit"))
	}
	before := latestSnowflake()
	if q.Get("before") != "" {
		before, _ = strconv.ParseInt(q.Get("before"), 10, 64)
	}
	if limit < 1 || limit > maxLimit {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be between 1 and 100"})
		return
	}
	page, err := readPage(r.Context(), channelID, before, limit)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, page)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /channels/{channel_id}/messages", getMessages)
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
import scala.collection.mutable
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class StoredMessage(id: String, authorId: String, content: String)

object ReadMessages {
  val DefaultLimit = 50
  val MaxLimit = 100
  val DiscordEpochMs = 1420070400000L

  /** Built in step 1 (PostMessage). */
  def bucketOf(snowflake: Long): Int = ???

  implicit val storedFormat: RootJsonFormat[StoredMessage] = jsonFormat(StoredMessage, "id", "author_id", "content")

  /** Per channel, the buckets that came back empty; skipped on later reads (provided). */
  private val knownEmpty = mutable.Map.empty[Long, mutable.Set[Int]]
  def isEmpty(channelId: Long, bucket: Int): Boolean =
    knownEmpty.synchronized(knownEmpty.get(channelId).exists(_.contains(bucket)))
  def markEmpty(channelId: Long, bucket: Int): Unit =
    knownEmpty.synchronized(knownEmpty.getOrElseUpdate(channelId, mutable.Set.empty) += bucket)

  /** An id newer than any message minted so far: the cursor when the client sends no before (provided). */
  def latestSnowflake(): Long = (System.currentTimeMillis() + 1 - DiscordEpochMs) << 22

  /** The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`. */
  def fetchBucket(channelId: Long, bucket: Int, before: Long, limit: Int): Vector[StoredMessage] = {
    // TODO: SELECT message_id, author_id, content … WHERE channel_id, bucket, message_id < before ORDER BY message_id DESC LIMIT
    // TODO: StoredMessage(rs.getLong(1).toString, rs.getLong(2).toString, rs.getString(3)) per row
    ???
  }

  /** Walks from bucketOf(before) down to bucketOf(channelId) until \`limit\` messages are collected. */
  def readPage(channelId: Long, before: Long, limit: Int): Vector[StoredMessage] = {
    // TODO: val firstBucket = bucketOf(channelId); val start = bucketOf(before)
    // TODO: while the page is short && bucket >= firstBucket: skip isEmpty buckets, fetch limit - page.size
    // TODO: an empty result in a bucket older than start → markEmpty; bucket -= 1
    ???
  }

  val route: Route =
    path("channels" / LongNumber / "messages") { channelId =>
      get {
        parameters("before".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (before, limit) =>
          // TODO: 400 unless 1 <= limit <= MaxLimit
          // TODO: readPage(channelId, before.getOrElse(latestSnowflake()), limit) → 200 with the page
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
import scala.collection.mutable
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class StoredMessage(id: String, authorId: String, content: String)

object ReadMessages {
  val DefaultLimit = 50
  val MaxLimit = 100
  val DiscordEpochMs = 1420070400000L

  /** Built in step 1 (PostMessage). */
  def bucketOf(snowflake: Long): Int = ???

  implicit val storedFormat: RootJsonFormat[StoredMessage] = jsonFormat(StoredMessage, "id", "author_id", "content")

  /** Per channel, the buckets that came back empty; skipped on later reads (provided). */
  private val knownEmpty = mutable.Map.empty[Long, mutable.Set[Int]]
  def isEmpty(channelId: Long, bucket: Int): Boolean =
    knownEmpty.synchronized(knownEmpty.get(channelId).exists(_.contains(bucket)))
  def markEmpty(channelId: Long, bucket: Int): Unit =
    knownEmpty.synchronized(knownEmpty.getOrElseUpdate(channelId, mutable.Set.empty) += bucket)

  /** An id newer than any message minted so far: the cursor when the client sends no before (provided). */
  def latestSnowflake(): Long = (System.currentTimeMillis() + 1 - DiscordEpochMs) << 22

  /** The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`. */
  def fetchBucket(channelId: Long, bucket: Int, before: Long, limit: Int): Vector[StoredMessage] =
    Db.withConnection { conn =>
      val st = conn.prepareStatement(
        "SELECT message_id, author_id, content FROM messages" +
          " WHERE channel_id = ? AND bucket = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?")
      st.setLong(1, channelId); st.setInt(2, bucket); st.setLong(3, before); st.setInt(4, limit)
      val rs = st.executeQuery()
      val out = Vector.newBuilder[StoredMessage]
      while (rs.next()) out += StoredMessage(rs.getLong(1).toString, rs.getLong(2).toString, rs.getString(3))
      out.result()
    }

  /** Walks from bucketOf(before) down to bucketOf(channelId) until \`limit\` messages are collected. */
  def readPage(channelId: Long, before: Long, limit: Int): Vector[StoredMessage] = {
    val firstBucket = bucketOf(channelId) // a channel id is a snowflake: nothing was sent before the channel existed
    val start = bucketOf(before)
    var page = Vector.empty[StoredMessage]
    var bucket = start
    while (page.size < limit && bucket >= firstBucket) {
      if (!isEmpty(channelId, bucket)) {
        val rows = fetchBucket(channelId, bucket, before, limit - page.size)
        page ++= rows
        if (rows.isEmpty && bucket < start) markEmpty(channelId, bucket) // the cursor hid nothing here
      }
      bucket -= 1
    }
    page
  }

  val route: Route =
    path("channels" / LongNumber / "messages") { channelId =>
      get {
        parameters("before".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (before, limit) =>
          if (limit < 1 || limit > MaxLimit)
            complete(StatusCodes.BadRequest -> Map("error" -> "limit must be between 1 and 100"))
          else complete(readPage(channelId, before.getOrElse(latestSnowflake()), limit))
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
#include <pqxx/pqxx>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "db.h"  // db::exec(sql, params...) runs one statement and returns a pqxx::result — provided

using json = nlohmann::json;

constexpr int kDefaultLimit = 50;
constexpr int kMaxLimit = 100;
constexpr int64_t kDiscordEpochMs = 1420070400000LL;

// Built in step 1 (post_message.cpp).
int32_t bucket_of(int64_t snowflake);

// Per channel, the buckets that came back empty; skipped on later reads (provided).
std::mutex empty_mu;
std::unordered_map<int64_t, std::unordered_set<int32_t>> known_empty;

bool is_empty(int64_t channel_id, int32_t bucket) {
  std::lock_guard<std::mutex> guard(empty_mu);
  const auto it = known_empty.find(channel_id);
  return it != known_empty.end() && it->second.count(bucket) > 0;
}

void mark_empty(int64_t channel_id, int32_t bucket) {
  std::lock_guard<std::mutex> guard(empty_mu);
  known_empty[channel_id].insert(bucket);
}

// An id newer than any message minted so far: the cursor when the client sends no before (provided).
int64_t latest_snowflake() {
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch());
  return (now.count() + 1 - kDiscordEpochMs) << 22;
}

// The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`.
json fetch_bucket(int64_t channel_id, int32_t bucket, int64_t before, int limit) {
  // TODO: SELECT message_id, author_id, content … WHERE channel_id, bucket, message_id < before ORDER BY message_id DESC LIMIT
  // TODO: {"id": std::to_string(...), "author_id": std::to_string(...), "content": ...} per row
  return json::array();
}

// Walks from bucket_of(before) down to bucket_of(channel_id) until \`limit\` messages are collected.
json read_page(int64_t channel_id, int64_t before, int limit) {
  // TODO: const int32_t first_bucket = bucket_of(channel_id); const int32_t start = bucket_of(before)
  // TODO: for bucket = start; the page is short && bucket >= first_bucket; --bucket: skip is_empty buckets, fetch limit - page.size()
  // TODO: an empty result in a bucket older than start → mark_empty
  return json::array();
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : kDefaultLimit;
    const int64_t before = req.has_param("before") ? std::stoll(req.get_param_value("before")) : latest_snowflake();
    // TODO: 400 unless 1 <= limit <= kMaxLimit
    // TODO: read_page(channel_id, before, limit) → 200 with the page
    (void)channel_id;
    (void)before;
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <pqxx/pqxx>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "db.h"  // db::exec(sql, params...) runs one statement and returns a pqxx::result — provided

using json = nlohmann::json;

constexpr int kDefaultLimit = 50;
constexpr int kMaxLimit = 100;
constexpr int64_t kDiscordEpochMs = 1420070400000LL;

// Built in step 1 (post_message.cpp).
int32_t bucket_of(int64_t snowflake);

// Per channel, the buckets that came back empty; skipped on later reads (provided).
std::mutex empty_mu;
std::unordered_map<int64_t, std::unordered_set<int32_t>> known_empty;

bool is_empty(int64_t channel_id, int32_t bucket) {
  std::lock_guard<std::mutex> guard(empty_mu);
  const auto it = known_empty.find(channel_id);
  return it != known_empty.end() && it->second.count(bucket) > 0;
}

void mark_empty(int64_t channel_id, int32_t bucket) {
  std::lock_guard<std::mutex> guard(empty_mu);
  known_empty[channel_id].insert(bucket);
}

// An id newer than any message minted so far: the cursor when the client sends no before (provided).
int64_t latest_snowflake() {
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch());
  return (now.count() + 1 - kDiscordEpochMs) << 22;
}

// The newest \`limit\` messages of one (channel, bucket) partition older than \`before\`.
json fetch_bucket(int64_t channel_id, int32_t bucket, int64_t before, int limit) {
  const pqxx::result rows = db::exec(
      "SELECT message_id, author_id, content FROM messages"
      " WHERE channel_id = $1 AND bucket = $2 AND message_id < $3 ORDER BY message_id DESC LIMIT $4",
      channel_id, bucket, before, limit);
  json out = json::array();
  for (const auto& row : rows)
    out.push_back({{"id", std::to_string(row[0].as<int64_t>())},
                   {"author_id", std::to_string(row[1].as<int64_t>())},
                   {"content", row[2].as<std::string>()}});
  return out;
}

// Walks from bucket_of(before) down to bucket_of(channel_id) until \`limit\` messages are collected.
json read_page(int64_t channel_id, int64_t before, int limit) {
  const int32_t first_bucket = bucket_of(channel_id);  // a channel id is a snowflake: nothing predates the channel
  const int32_t start = bucket_of(before);
  json page = json::array();
  for (int32_t bucket = start; page.size() < static_cast<std::size_t>(limit) && bucket >= first_bucket; --bucket) {
    if (is_empty(channel_id, bucket)) continue;
    const json rows = fetch_bucket(channel_id, bucket, before, limit - static_cast<int>(page.size()));
    page.insert(page.end(), rows.begin(), rows.end());
    if (rows.empty() && bucket < start) mark_empty(channel_id, bucket);  // the cursor hid nothing here
  }
  return page;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : kDefaultLimit;
    const int64_t before = req.has_param("before") ? std::stoll(req.get_param_value("before")) : latest_snowflake();
    if (limit < 1 || limit > kMaxLimit) {
      res.status = 400;
      res.set_content(R"({"error":"limit must be between 1 and 100"})", "application/json");
      return;
    }
    res.set_content(read_page(channel_id, before, limit).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import re
import time

from messages.db import SCHEMA

EPOCH = 1420070400000
BUCKET_MS = 10 * 24 * 3600 * 1000
INSERT = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES (%s, %s, %s, %s, %s)"
NOW_B = (int(time.time() * 1000) - EPOCH) // BUCKET_MS  # the bucket a message sent now lands in


def sf(bucket, offset_ms=0):
    """A snowflake minted offset_ms into \`bucket\`."""
    return ((bucket * BUCKET_MS + offset_ms) << 22) | (1 << 17)


CHANNEL = sf(NOW_B - 10, 5000)  # a channel created ten buckets ago
END = sf(NOW_B, BUCKET_MS - 1)  # a cursor at the very end of the current bucket


async def _api(ctx, *messages, channel=CHANNEL):
    """messages: (bucket, offset_ms, content) rows of \`channel\`, inserted before the module loads."""
    await ctx.db.reset(SCHEMA)
    for bucket, offset_ms, content in messages:
        await ctx.db.execute(INSERT, (str(channel), bucket, str(sf(bucket, offset_ms)), "7", content))
    return ctx.load("read_messages")


def _compared(sql, params, pattern):
    """The value Postgres compared with in \`pattern\`: a %s / $n parameter or an inline number."""
    found = re.search(pattern + " ?(%s|[$][0-9]+|[0-9]+)", sql)
    if found is None:
        return None
    slot = found.group(1)
    if slot == "%s":
        return int(params[sql[: found.start(1)].count("%s")])
    if slot.startswith("$"):
        return int(params[int(slot[1:]) - 1])
    return int(slot)


class _Reads:
    """The page walk as Postgres saw it: (bucket, limit) of every SELECT on messages since the request began."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.since = len(ctx.db.queries)

    def all(self):
        out = []
        for sql, params in self.ctx.db.queries[self.since :]:
            text = " ".join(sql.split()).lower()
            if not text.startswith("select") or "messages" not in text:
                continue
            bucket = _compared(text, params, "(?<![a-z_])bucket ?=")
            assert bucket is not None, f"Postgres ran a read of messages that is not confined to one bucket: {sql!r} — each query must name one (channel_id, bucket) partition"
            out.append((bucket, _compared(text, params, "limit")))
        return out

    def buckets(self):
        return [bucket for bucket, _limit in self.all()]


def _contents(r):
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text[:120]}"
    return [x["content"] for x in r.json()]


async def _get(m, ctx, channel=CHANNEL, **params):
    """One GET; returns the response and the bucket reads Postgres ran for it."""
    reads = _Reads(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get(f"/channels/{channel}/messages", params=params)
    return r, reads


async def check_limit_bounds(ctx):
    m = await _api(ctx, *((NOW_B, 1000 * (i + 1), f"m{i}") for i in range(60)))
    for bad in (0, 101, -5):
        r, _ = await _get(m, ctx, limit=bad)
        assert r.status_code == 400, f"limit={bad} is outside 1..100: expected 400, got {r.status_code}"
    r, _ = await _get(m, ctx)
    assert r.status_code == 200, f"GET without limit answered {r.status_code}, expected 200"
    assert len(r.json()) == 50, f"without ?limit the page holds DEFAULT_LIMIT (50) messages, got {len(r.json())}"
    r, _ = await _get(m, ctx, limit=100)
    assert len(r.json()) == 60, f"limit=100 on a channel with 60 messages returns all 60, got {len(r.json())}"
    r, _ = await _get(m, ctx, limit=1)
    assert len(r.json()) == 1, f"limit=1 returns one message, got {len(r.json())}"


async def check_newest_first(ctx):
    m = await _api(ctx, *((NOW_B, 1000 * i, f"m{i}") for i in range(1, 6)))
    ids = [sf(NOW_B, 1000 * i) for i in range(1, 6)]
    r, reads = await _get(m, ctx, limit=3)
    assert r.status_code == 200, f"GET answered {r.status_code}"
    page = r.json()
    assert [x.get("id") for x in page] == [str(i) for i in ids[4:1:-1]], f"limit=3 must return the three newest ids as strings, newest first: got {[x.get('id') for x in page]}"
    assert [x.get("content") for x in page] == ["m5", "m4", "m3"], f"each message carries its content: {page}"
    assert all(x.get("author_id") == "7" for x in page), f"each message carries author_id (as a string): {page}"
    assert reads.all()[:1] == [(NOW_B, 3)], f"the first query must read the current bucket {NOW_B} bounded by the page size (LIMIT 3), Postgres ran {reads.all()[:1]} as (bucket, limit)"
    r, _ = await _get(m, ctx, before=ids[3], limit=10)
    assert [x["id"] for x in r.json()] == [str(i) for i in ids[2::-1]], f"before=<id of m4> must return m3, m2, m1 (strictly older), got {[x['id'] for x in r.json()]}"
    r, _ = await _get(m, ctx, before=ids[0], limit=10)
    assert r.json() == [], f"nothing is older than the first message, got {r.json()}"


async def check_walk_back(ctx):
    rows = ((NOW_B, 1000, "a"), (NOW_B, 2000, "b"), (NOW_B - 2, 1000, "c"), (NOW_B - 2, 2000, "d"), (NOW_B - 5, 1000, "e"))
    m = await _api(ctx, *rows)
    r, reads = await _get(m, ctx, before=END, limit=3)
    assert _contents(r) == ["b", "a", "d"], f"a page of 3 spans buckets {NOW_B} and {NOW_B - 2}: expected b, a, d — got {_contents(r)}"
    assert reads.buckets() == [NOW_B, NOW_B - 1, NOW_B - 2], f"the walk must query buckets {NOW_B}, {NOW_B - 1}, {NOW_B - 2} in that order and stop once the page is full; Postgres was asked for buckets {reads.buckets()}"
    limits = [limit for _bucket, limit in reads.all()]
    assert limits == [3, 1, 1], f"each bucket is asked only for what is still missing (LIMIT 3, then 1, then 1), Postgres ran LIMIT {limits}"
    m = await _api(ctx, *rows)
    r, reads = await _get(m, ctx, before=END, limit=10)
    assert _contents(r) == ["b", "a", "d", "c", "e"], f"a page larger than the channel returns everything newest first, got {_contents(r)}"
    assert reads.buckets() == list(range(NOW_B, NOW_B - 11, -1)), f"with the page still short the walk continues down to the channel's bucket ({NOW_B - 10}); Postgres was asked for buckets {reads.buckets()}"


async def check_channel_floor(ctx):
    m = await _api(ctx, (NOW_B - 9, 1000, "old"))
    r, reads = await _get(m, ctx, before=END, limit=50)
    assert _contents(r) == ["old"], f"the only message sits nine buckets back and must be found, got {r.json()}"
    buckets = reads.buckets()
    assert buckets and min(buckets) == NOW_B - 10, f"the walk must reach bucket_of(channel_id) = {NOW_B - 10} and stop there; Postgres was asked for buckets down to {min(buckets) if buckets else None}"
    assert len(buckets) == 11, f"from {NOW_B} down to {NOW_B - 10} is 11 bucket queries, Postgres ran {len(buckets)}"
    young = sf(NOW_B - 1, 0)
    r, reads = await _get(m, ctx, channel=young, before=END, limit=50)
    assert r.json() == [], "a channel with no messages answers an empty page"
    assert reads.buckets() == [NOW_B, NOW_B - 1], f"a channel created in bucket {NOW_B - 1} needs exactly two queries ({NOW_B}, {NOW_B - 1}), Postgres ran {reads.buckets()}"


async def check_empty_memo(ctx):
    m = await _api(ctx, (NOW_B, 1000, "new"), (NOW_B - 9, 1000, "old"))
    r, reads = await _get(m, ctx, before=END, limit=5)
    assert _contents(r) == ["new", "old"], f"expected new then old, got {_contents(r)}"
    assert len(reads.buckets()) == 11, f"the first read of a quiet channel walks every bucket (11 queries), Postgres ran {len(reads.buckets())}"
    r, reads = await _get(m, ctx, before=END, limit=5)
    assert _contents(r) == ["new", "old"], "the second read must return the same page"
    second = reads.buckets()
    assert len(second) <= 3, f"the second read must skip the buckets known to be empty: at most 3 queries ({NOW_B}, {NOW_B - 9}, {NOW_B - 10}), Postgres ran {len(second)}: {second}"
    assert NOW_B - 5 not in second, f"bucket {NOW_B - 5} came back empty on the first read and must not be queried again"
    r, _ = await _get(m, ctx, before=sf(NOW_B, 1000), limit=5)
    assert _contents(r) == ["old"], f"before=<id of new> hides new, got {_contents(r)}"
    r, reads = await _get(m, ctx, before=END, limit=5)
    assert NOW_B in reads.buckets(), f"the starting bucket {NOW_B} returned nothing only because of the before cursor: it is not empty, yet the next read skipped it (Postgres was asked for {reads.buckets()})"
    assert _contents(r) == ["new", "old"], f"the starting bucket must not be remembered as empty: the newest page is new, old — got {_contents(r)}"
`,
    typescript: `import {SCHEMA} from 'messages/db';

const EPOCH = 1420070400000;
const BUCKET_MS = 10 * 24 * 3600 * 1000;
const INSERT = 'INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)';
const NOW_B = Math.floor((Date.now() - EPOCH) / BUCKET_MS); // the bucket a message sent now lands in

/** A snowflake minted offsetMs into \`bucket\`. */
function sf(bucket: number, offsetMs = 0): bigint {
  return (BigInt(bucket * BUCKET_MS + offsetMs) << 22n) | (1n << 17n);
}

const CHANNEL = sf(NOW_B - 10, 5000); // a channel created ten buckets ago
const END = sf(NOW_B, BUCKET_MS - 1); // a cursor at the very end of the current bucket
const SIBLING = sf(NOW_B - 10, 6000); // another channel created ten buckets ago, with no memo yet

type Row = [bucket: number, offsetMs: number, content: string];

/** messages: (bucket, offsetMs, content) rows of \`channel\`, inserted before the module loads. */
async function api(ctx, messages: Row[], channel = CHANNEL) {
  await ctx.db.reset(SCHEMA);
  for (const [bucket, offsetMs, content] of messages) {
    await ctx.db.execute(INSERT, [String(channel), bucket, String(sf(bucket, offsetMs)), '7', content]);
  }
  return ctx.load('read_messages');
}

/** The value Postgres compared with in \`pattern\`: a $n parameter or an inline number. */
function compared(sql: string, params: unknown[], pattern: string): number | null {
  const found = new RegExp(pattern + ' ?(\\\\$[0-9]+|[0-9]+)').exec(sql);
  if (found === null) return null;
  const slot = found[1];
  return Number(slot.startsWith('$') ? params[Number(slot.slice(1)) - 1] : slot);
}

/** The page walk as Postgres saw it: [bucket, limit] of every SELECT on messages since the request began. */
class Reads {
  private readonly since: number;
  constructor(private readonly ctx) {
    this.since = ctx.db.queries.length;
  }
  all(): [number, number | null][] {
    const out: [number, number | null][] = [];
    for (const [sql, params] of this.ctx.db.queries.slice(this.since)) {
      const text = sql.split(/\\s+/).join(' ').toLowerCase();
      if (!text.startsWith('select') || !text.includes('messages')) continue;
      const bucket = compared(text, params, '(?<![a-z_])bucket ?=');
      assert(bucket !== null, \`Postgres ran a read of messages that is not confined to one bucket: \${JSON.stringify(sql)} — each query must name one (channel_id, bucket) partition\`);
      out.push([bucket, compared(text, params, 'limit')]);
    }
    return out;
  }
  buckets(): number[] {
    return this.all().map(([bucket]) => bucket);
  }
}

function contents(r): string[] {
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text.slice(0, 120)}\`);
  return (r.json() as {content: string}[]).map(x => x.content);
}

/** One GET; returns the response and the bucket reads Postgres ran for it. */
async function get(m, ctx, params: Record<string, string | number> = {}, channel = CHANNEL) {
  const reads = new Reads(ctx);
  const r = await ctx.client(m.app).get(\`/channels/\${channel}/messages\`, {query: params});
  return {r, reads};
}

export async function check_limit_bounds(ctx) {
  const m = await api(ctx, Array.from({length: 60}, (_, i): Row => [NOW_B, 1000 * (i + 1), \`m\${i}\`]));
  for (const bad of [0, 101, -5]) {
    const {r} = await get(m, ctx, {limit: bad});
    assert.equal(r.status, 400, \`limit=\${bad} is outside 1..100: expected 400, got \${r.status}\`);
  }
  let {r} = await get(m, ctx);
  assert.equal(r.status, 200, \`GET without limit answered \${r.status}, expected 200\`);
  assert.equal(r.json().length, 50, \`without ?limit the page holds DEFAULT_LIMIT (50) messages, got \${r.json().length}\`);
  ({r} = await get(m, ctx, {limit: 100}));
  assert.equal(r.json().length, 60, \`limit=100 on a channel with 60 messages returns all 60, got \${r.json().length}\`);
  ({r} = await get(m, ctx, {limit: 1}));
  assert.equal(r.json().length, 1, \`limit=1 returns one message, got \${r.json().length}\`);
}

export async function check_newest_first(ctx) {
  const m = await api(ctx, [1, 2, 3, 4, 5].map((i): Row => [NOW_B, 1000 * i, \`m\${i}\`]));
  const ids = [1, 2, 3, 4, 5].map(i => sf(NOW_B, 1000 * i));
  const {r, reads} = await get(m, ctx, {limit: 3});
  assert.equal(r.status, 200, \`GET answered \${r.status}\`);
  const page = r.json() as Record<string, unknown>[];
  assert.deepEqual(page.map(x => x.id), [ids[4], ids[3], ids[2]].map(String), \`limit=3 must return the three newest ids as strings, newest first: got \${JSON.stringify(page.map(x => x.id))}\`);
  assert.deepEqual(page.map(x => x.content), ['m5', 'm4', 'm3'], \`each message carries its content: \${JSON.stringify(page)}\`);
  assert(page.every(x => x.author_id === '7'), \`each message carries author_id (as a string): \${JSON.stringify(page)}\`);
  assert.deepEqual(reads.all().slice(0, 1), [[NOW_B, 3]], \`the first query must read the current bucket \${NOW_B} bounded by the page size (LIMIT 3), Postgres ran \${JSON.stringify(reads.all().slice(0, 1))} as [bucket, limit]\`);
  let got = (await get(m, ctx, {before: String(ids[3]), limit: 10})).r.json() as {id: string}[];
  assert.deepEqual(got.map(x => x.id), [ids[2], ids[1], ids[0]].map(String), \`before=<id of m4> must return m3, m2, m1 (strictly older), got \${JSON.stringify(got.map(x => x.id))}\`);
  got = (await get(m, ctx, {before: String(ids[0]), limit: 10})).r.json() as {id: string}[];
  assert.deepEqual(got, [], \`nothing is older than the first message, got \${JSON.stringify(got)}\`);
}

export async function check_walk_back(ctx) {
  const rows: Row[] = [[NOW_B, 1000, 'a'], [NOW_B, 2000, 'b'], [NOW_B - 2, 1000, 'c'], [NOW_B - 2, 2000, 'd'], [NOW_B - 5, 1000, 'e']];
  const m = await api(ctx, rows);
  let {r, reads} = await get(m, ctx, {before: String(END), limit: 3});
  assert.deepEqual(contents(r), ['b', 'a', 'd'], \`a page of 3 spans buckets \${NOW_B} and \${NOW_B - 2}: expected b, a, d — got \${JSON.stringify(contents(r))}\`);
  assert.deepEqual(reads.buckets(), [NOW_B, NOW_B - 1, NOW_B - 2], \`the walk must query buckets \${NOW_B}, \${NOW_B - 1}, \${NOW_B - 2} in that order and stop once the page is full; Postgres was asked for buckets \${JSON.stringify(reads.buckets())}\`);
  const limits = reads.all().map(([, limit]) => limit);
  assert.deepEqual(limits, [3, 1, 1], \`each bucket is asked only for what is still missing (LIMIT 3, then 1, then 1), Postgres ran LIMIT \${JSON.stringify(limits)}\`);
  for (const [bucket, offsetMs, content] of rows) {
    await ctx.db.execute(INSERT, [String(SIBLING), bucket, String(sf(bucket, offsetMs)), '7', content]);
  }
  ({r, reads} = await get(m, ctx, {before: String(END), limit: 10}, SIBLING));
  assert.deepEqual(contents(r), ['b', 'a', 'd', 'c', 'e'], \`a page larger than the channel returns everything newest first, got \${JSON.stringify(contents(r))}\`);
  assert.deepEqual(reads.buckets(), Array.from({length: 11}, (_, i) => NOW_B - i), \`with the page still short the walk continues down to the channel's bucket (\${NOW_B - 10}); Postgres was asked for buckets \${JSON.stringify(reads.buckets())}\`);
}

export async function check_channel_floor(ctx) {
  const m = await api(ctx, [[NOW_B - 9, 1000, 'old']]);
  let {r, reads} = await get(m, ctx, {before: String(END), limit: 50});
  assert.deepEqual(contents(r), ['old'], \`the only message sits nine buckets back and must be found, got \${r.text}\`);
  const buckets = reads.buckets();
  assert(buckets.length > 0 && Math.min(...buckets) === NOW_B - 10, \`the walk must reach bucket_of(channel_id) = \${NOW_B - 10} and stop there; Postgres was asked for buckets down to \${buckets.length ? Math.min(...buckets) : null}\`);
  assert.equal(buckets.length, 11, \`from \${NOW_B} down to \${NOW_B - 10} is 11 bucket queries, Postgres ran \${buckets.length}\`);
  const young = sf(NOW_B - 1, 0);
  ({r, reads} = await get(m, ctx, {before: String(END), limit: 50}, young));
  assert.deepEqual(r.json(), [], 'a channel with no messages answers an empty page');
  assert.deepEqual(reads.buckets(), [NOW_B, NOW_B - 1], \`a channel created in bucket \${NOW_B - 1} needs exactly two queries (\${NOW_B}, \${NOW_B - 1}), Postgres ran \${JSON.stringify(reads.buckets())}\`);
}

export async function check_empty_memo(ctx) {
  const m = await api(ctx, [[NOW_B, 1000, 'new'], [NOW_B - 9, 1000, 'old']]);
  let {r, reads} = await get(m, ctx, {before: String(END), limit: 5});
  assert.deepEqual(contents(r), ['new', 'old'], \`expected new then old, got \${JSON.stringify(contents(r))}\`);
  assert.equal(reads.buckets().length, 11, \`the first read of a quiet channel walks every bucket (11 queries), Postgres ran \${reads.buckets().length}\`);
  ({r, reads} = await get(m, ctx, {before: String(END), limit: 5}));
  assert.deepEqual(contents(r), ['new', 'old'], 'the second read must return the same page');
  const second = reads.buckets();
  assert(second.length <= 3, \`the second read must skip the buckets known to be empty: at most 3 queries (\${NOW_B}, \${NOW_B - 9}, \${NOW_B - 10}), Postgres ran \${second.length}: \${JSON.stringify(second)}\`);
  assert(!second.includes(NOW_B - 5), \`bucket \${NOW_B - 5} came back empty on the first read and must not be queried again\`);
  ({r} = await get(m, ctx, {before: String(sf(NOW_B, 1000)), limit: 5}));
  assert.deepEqual(contents(r), ['old'], \`before=<id of new> hides new, got \${JSON.stringify(contents(r))}\`);
  ({r, reads} = await get(m, ctx, {before: String(END), limit: 5}));
  assert(reads.buckets().includes(NOW_B), \`the starting bucket \${NOW_B} returned nothing only because of the before cursor: it is not empty, yet the next read skipped it (Postgres was asked for \${JSON.stringify(reads.buckets())})\`);
  assert.deepEqual(contents(r), ['new', 'old'], \`the starting bucket must not be remembered as empty: the newest page is new, old — got \${JSON.stringify(contents(r))}\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"discord/db"
	"leetbuild/harness"
)

const (
	walkEpoch    int64 = 1420070400000
	walkBucketMs int64 = 10 * 24 * 3600 * 1000
	walkInsert         = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)"
)

var (
	walkBucketRe = regexp.MustCompile("(?:^|[^a-z_])bucket ?= ?([$][0-9]+|[0-9]+)")
	walkLimitRe  = regexp.MustCompile("limit ?([$][0-9]+|[0-9]+)")
)

// walkSnowflake is a snowflake minted offsetMs into bucket.
func walkSnowflake(bucket, offsetMs int64) int64 {
	return ((bucket*walkBucketMs + offsetMs) << 22) | (1 << 17)
}

// walkRow is a stored message: its bucket, its offset in it, its content.
type walkRow struct {
	bucket, offsetMs int64
	content          string
}

// walkWorld is the learner's server over Postgres, around a channel created ten buckets ago.
type walkWorld struct {
	ctx     *harness.Ctx
	nowB    int64 // the bucket a message sent now lands in
	channel int64 // a channel created ten buckets ago
	end     int64 // a cursor at the very end of the current bucket
	sibling int64 // another channel created ten buckets ago, with no memo yet
	http    *harness.HTTP
}

// newWalkWorld stores messages of the channel, then starts the server.
func newWalkWorld(ctx *harness.Ctx, messages ...walkRow) *walkWorld {
	nowB := (time.Now().UnixMilli() - walkEpoch) / walkBucketMs
	w := &walkWorld{ctx: ctx, nowB: nowB, channel: walkSnowflake(nowB-10, 5000), end: walkSnowflake(nowB, walkBucketMs-1),
		sibling: walkSnowflake(nowB-10, 6000)}
	ctx.DB.Reset(db.Schema)
	w.insert(w.channel, messages)
	bucketOf = func(snowflake int64) int32 { return int32((snowflake >> 22) / walkBucketMs) } // step 1's
	w.http = ctx.Main(main).HTTP()
	return w
}

func (w *walkWorld) insert(channel int64, messages []walkRow) {
	for _, m := range messages {
		w.ctx.DB.Exec(walkInsert, channel, m.bucket, walkSnowflake(m.bucket, m.offsetMs), 7, m.content)
	}
}

// walkReads is the page walk as Postgres saw it since it was made.
type walkReads struct {
	ctx   *harness.Ctx
	since int
}

// compared is the value Postgres compared with in re: a $n parameter or an inline number (-1: none).
func (rd *walkReads) compared(re *regexp.Regexp, text string, args []any) int64 {
	found := re.FindStringSubmatch(text)
	if found == nil {
		return -1
	}
	slot := found[1]
	if strings.HasPrefix(slot, "$") {
		n, _ := strconv.Atoi(slot[1:])
		if n < 1 || n > len(args) {
			return -1
		}
		slot = fmt.Sprint(args[n-1])
	}
	v, _ := strconv.ParseInt(slot, 10, 64)
	return v
}

// all is [bucket, limit] of every SELECT on messages (limit -1 when there is none).
func (rd *walkReads) all() [][2]int64 {
	out := [][2]int64{}
	for _, q := range rd.ctx.DB.Queries()[rd.since:] {
		text := strings.ToLower(strings.Join(strings.Fields(q.SQL), " "))
		if !strings.HasPrefix(text, "select") || !strings.Contains(text, "messages") {
			continue
		}
		bucket := rd.compared(walkBucketRe, text, q.Args)
		rd.ctx.Assert(bucket != -1, "Postgres ran a read of messages that is not confined to one bucket: %q — each query must name one (channel_id, bucket) partition", q.SQL)
		out = append(out, [2]int64{bucket, rd.compared(walkLimitRe, text, q.Args)})
	}
	return out
}

func (rd *walkReads) buckets() []int64 {
	out := []int64{}
	for _, read := range rd.all() {
		out = append(out, read[0])
	}
	return out
}

// get is one GET on channel; it returns the response and the bucket reads Postgres ran for it.
func (w *walkWorld) get(channel int64, params url.Values) (*harness.Response, *walkReads) {
	reads := &walkReads{ctx: w.ctx, since: len(w.ctx.DB.Queries())}
	path := "/channels/" + strconv.FormatInt(channel, 10) + "/messages"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}
	return w.http.Get(path), reads
}

// page decodes a 200 answer as its list of messages.
func (w *walkWorld) page(r *harness.Response) []map[string]any {
	text := strings.TrimSpace(r.Text())
	if len(text) > 120 {
		text = text[:120]
	}
	w.ctx.Equal(r.Status, 200, "GET answered %s", text)
	var page []map[string]any
	r.Decode(&page)
	return page
}

// field lists one field of every message of a page.
func walkField(page []map[string]any, name string) []any {
	out := []any{}
	for _, m := range page {
		out = append(out, m[name])
	}
	return out
}

func (w *walkWorld) contents(r *harness.Response) []any { return walkField(w.page(r), "content") }

func walkQuery(pairs ...string) url.Values {
	q := url.Values{}
	for i := 0; i+1 < len(pairs); i += 2 {
		q.Set(pairs[i], pairs[i+1])
	}
	return q
}

func walkID(id int64) string { return strconv.FormatInt(id, 10) }

func CheckLimitBounds(ctx *harness.Ctx) {
	nowB := (time.Now().UnixMilli() - walkEpoch) / walkBucketMs
	rows := []walkRow{}
	for i := range 60 {
		rows = append(rows, walkRow{nowB, int64(1000 * (i + 1)), "m" + strconv.Itoa(i)})
	}
	w := newWalkWorld(ctx, rows...)
	for _, bad := range []string{"0", "101", "-5"} {
		r, _ := w.get(w.channel, walkQuery("limit", bad))
		ctx.Equal(r.Status, 400, "limit=%s is outside 1..100", bad)
	}
	r, _ := w.get(w.channel, nil)
	ctx.Equal(r.Status, 200, "GET without limit")
	ctx.Equal(len(w.page(r)), 50, "without ?limit the page holds defaultLimit (50) messages")
	r, _ = w.get(w.channel, walkQuery("limit", "100"))
	ctx.Equal(len(w.page(r)), 60, "limit=100 on a channel with 60 messages returns all 60")
	r, _ = w.get(w.channel, walkQuery("limit", "1"))
	ctx.Equal(len(w.page(r)), 1, "limit=1 returns one message")
}

func CheckNewestFirst(ctx *harness.Ctx) {
	nowB := (time.Now().UnixMilli() - walkEpoch) / walkBucketMs
	rows := []walkRow{}
	ids := []int64{}
	for i := int64(1); i <= 5; i++ {
		rows = append(rows, walkRow{nowB, 1000 * i, "m" + strconv.FormatInt(i, 10)})
		ids = append(ids, walkSnowflake(nowB, 1000*i))
	}
	w := newWalkWorld(ctx, rows...)
	r, reads := w.get(w.channel, walkQuery("limit", "3"))
	ctx.Equal(r.Status, 200, "GET with limit=3")
	page := w.page(r)
	ctx.Equal(walkField(page, "id"), []any{walkID(ids[4]), walkID(ids[3]), walkID(ids[2])}, "limit=3 must return the three newest ids as strings, newest first")
	ctx.Equal(walkField(page, "content"), []any{"m5", "m4", "m3"}, "each message carries its content: %s", r.Text())
	for _, author := range walkField(page, "author_id") {
		ctx.Assert(author == "7", "each message carries author_id (as a string): %s", r.Text())
	}
	first := reads.all()
	if len(first) > 1 {
		first = first[:1]
	}
	ctx.Equal(first, [][2]int64{{w.nowB, 3}}, "the first query must read the current bucket %d bounded by the page size (LIMIT 3), as [bucket, limit]", w.nowB)
	r, _ = w.get(w.channel, walkQuery("before", walkID(ids[3]), "limit", "10"))
	ctx.Equal(walkField(w.page(r), "id"), []any{walkID(ids[2]), walkID(ids[1]), walkID(ids[0])}, "before=<id of m4> must return m3, m2, m1 (strictly older)")
	r, _ = w.get(w.channel, walkQuery("before", walkID(ids[0]), "limit", "10"))
	got := w.page(r)
	ctx.Assert(got != nil && len(got) == 0, "nothing is older than the first message: expected [], got %s", r.Text())
}

func CheckWalkBack(ctx *harness.Ctx) {
	nowB := (time.Now().UnixMilli() - walkEpoch) / walkBucketMs
	rows := []walkRow{{nowB, 1000, "a"}, {nowB, 2000, "b"}, {nowB - 2, 1000, "c"}, {nowB - 2, 2000, "d"}, {nowB - 5, 1000, "e"}}
	w := newWalkWorld(ctx, rows...)
	r, reads := w.get(w.channel, walkQuery("before", walkID(w.end), "limit", "3"))
	ctx.Equal(w.contents(r), []any{"b", "a", "d"}, "a page of 3 spans buckets %d and %d: expected b, a, d", nowB, nowB-2)
	ctx.Equal(reads.buckets(), []int64{nowB, nowB - 1, nowB - 2}, "the walk must query buckets %d, %d, %d in that order and stop once the page is full; buckets Postgres was asked for", nowB, nowB-1, nowB-2)
	limits := []int64{}
	for _, read := range reads.all() {
		limits = append(limits, read[1])
	}
	ctx.Equal(limits, []int64{3, 1, 1}, "each bucket is asked only for what is still missing (LIMIT 3, then 1, then 1); LIMITs Postgres ran")
	w.insert(w.sibling, rows)
	r, reads = w.get(w.sibling, walkQuery("before", walkID(w.end), "limit", "10"))
	ctx.Equal(w.contents(r), []any{"b", "a", "d", "c", "e"}, "a page larger than the channel returns everything newest first")
	want := []int64{}
	for i := range 11 {
		want = append(want, nowB-int64(i))
	}
	ctx.Equal(reads.buckets(), want, "with the page still short the walk continues down to the channel's bucket (%d); buckets Postgres was asked for", nowB-10)
}

func CheckChannelFloor(ctx *harness.Ctx) {
	nowB := (time.Now().UnixMilli() - walkEpoch) / walkBucketMs
	w := newWalkWorld(ctx, walkRow{nowB - 9, 1000, "old"})
	r, reads := w.get(w.channel, walkQuery("before", walkID(w.end), "limit", "50"))
	ctx.Equal(w.contents(r), []any{"old"}, "the only message sits nine buckets back and must be found")
	buckets := reads.buckets()
	lowest := int64(-1)
	for i, b := range buckets {
		if i == 0 || b < lowest {
			lowest = b
		}
	}
	ctx.Assert(len(buckets) > 0 && lowest == nowB-10, "the walk must reach bucketOf(channelID) = %d and stop there; Postgres was asked for buckets down to %d", nowB-10, lowest)
	ctx.Equal(len(buckets), 11, "from %d down to %d is 11 bucket queries", nowB, nowB-10)
	young := walkSnowflake(nowB-1, 0)
	r, reads = w.get(young, walkQuery("before", walkID(w.end), "limit", "50"))
	var empty []map[string]any
	r.Decode(&empty)
	ctx.Assert(empty != nil && len(empty) == 0, "a channel with no messages answers an empty page, got %s", r.Text())
	ctx.Equal(reads.buckets(), []int64{nowB, nowB - 1}, "a channel created in bucket %d needs exactly two queries (%d, %d)", nowB-1, nowB, nowB-1)
}

func CheckEmptyMemo(ctx *harness.Ctx) {
	nowB := (time.Now().UnixMilli() - walkEpoch) / walkBucketMs
	w := newWalkWorld(ctx, walkRow{nowB, 1000, "new"}, walkRow{nowB - 9, 1000, "old"})
	r, reads := w.get(w.channel, walkQuery("before", walkID(w.end), "limit", "5"))
	ctx.Equal(w.contents(r), []any{"new", "old"}, "expected new then old")
	ctx.Equal(len(reads.buckets()), 11, "the first read of a quiet channel walks every bucket (11 queries)")
	r, reads = w.get(w.channel, walkQuery("before", walkID(w.end), "limit", "5"))
	ctx.Equal(w.contents(r), []any{"new", "old"}, "the second read must return the same page")
	second := reads.buckets()
	ctx.Assert(len(second) <= 3, "the second read must skip the buckets known to be empty: at most 3 queries (%d, %d, %d), Postgres ran %d: %v", nowB, nowB-9, nowB-10, len(second), second)
	for _, b := range second {
		ctx.Assert(b != nowB-5, "bucket %d came back empty on the first read and must not be queried again", nowB-5)
	}
	r, _ = w.get(w.channel, walkQuery("before", walkID(walkSnowflake(nowB, 1000)), "limit", "5"))
	ctx.Equal(w.contents(r), []any{"old"}, "before=<id of new> hides new")
	r, reads = w.get(w.channel, walkQuery("before", walkID(w.end), "limit", "5"))
	sawStart := false
	for _, b := range reads.buckets() {
		sawStart = sawStart || b == nowB
	}
	ctx.Assert(sawStart, "the starting bucket %d returned nothing only because of the before cursor: it is not empty, yet the next read skipped it (Postgres was asked for %v)", nowB, reads.buckets())
	ctx.Equal(w.contents(r), []any{"new", "old"}, "the starting bucket must not be remembered as empty: the newest page is new, old")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <array>
#include <map>
#include <regex>
#include <sstream>

// Step 1's bucket_of (post_message.cpp).
int32_t bucket_of(int64_t snowflake) { return static_cast<int32_t>((snowflake >> 22) / (10LL * 24 * 3600 * 1000)); }

namespace {

constexpr int64_t walkEpoch = 1420070400000LL;
constexpr int64_t walkBucketMs = 10LL * 24 * 3600 * 1000;
const std::string walkInsert = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)";

const std::regex walkBucketRe("(?:^|[^a-z_])bucket ?= ?([$][0-9]+|[0-9]+)");
const std::regex walkLimitRe("limit ?([$][0-9]+|[0-9]+)");

using Read = std::array<int64_t, 2>;

// walkSnowflake is a snowflake minted offsetMs into bucket.
int64_t walkSnowflake(int64_t bucket, int64_t offsetMs) { return ((bucket * walkBucketMs + offsetMs) << 22) | (1 << 17); }

// walkRow is a stored message: its bucket, its offset in it, its content.
struct walkRow {
  int64_t bucket, offsetMs;
  std::string content;
};

std::string walkID(int64_t id) { return std::to_string(id); }

int64_t nowBucket(harness::Ctx& ctx) { return (ctx.Clock.Now() - walkEpoch) / walkBucketMs; }

// walkReads is the page walk as Postgres saw it since it was made.
struct walkReads {
  harness::Ctx* ctx;
  size_t since;

  // compared is the value Postgres compared with in re: a $n parameter or an inline number (-1: none).
  int64_t compared(const std::regex& re, const std::string& text, const std::vector<harness::Any>& args) const {
    std::smatch found;
    if (!std::regex_search(text, found, re)) return -1;
    std::string slot = found[1];
    if (slot[0] == '$') {
      const int n = std::atoi(slot.c_str() + 1);
      if (n < 1 || n > static_cast<int>(args.size())) return -1;
      slot = harness::Sprintf("%v", args[n - 1]);
    }
    return std::strtoll(slot.c_str(), nullptr, 10);
  }

  // all is [bucket, limit] of every SELECT on messages (limit -1 when there is none).
  std::vector<Read> all() const {
    std::vector<Read> out;
    const auto queries = ctx->DB.Queries();
    for (size_t i = since; i < queries.size(); i++) {
      const auto& q = queries[i];
      std::istringstream words(q.SQL);
      std::string text, word;
      while (words >> word) text += (text.empty() ? "" : " ") + word;
      for (char& ch : text) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
      if (text.rfind("select", 0) != 0 || text.find("messages") == std::string::npos) continue;
      const int64_t bucket = compared(walkBucketRe, text, q.Args);
      ctx->Assert(bucket != -1, "Postgres ran a read of messages that is not confined to one bucket: %q — each query must name one (channel_id, bucket) partition", q.SQL);
      out.push_back({bucket, compared(walkLimitRe, text, q.Args)});
    }
    return out;
  }

  std::vector<int64_t> buckets() const {
    std::vector<int64_t> out;
    for (const auto& read : all()) out.push_back(read[0]);
    return out;
  }
};

using Params = std::vector<std::pair<std::string, std::string>>;

// walkWorld is the learner's server over Postgres, around a channel created ten buckets ago.
struct walkWorld {
  harness::Ctx* ctx;
  int64_t nowB;     // the bucket a message sent now lands in
  int64_t channel;  // a channel created ten buckets ago
  int64_t end;      // a cursor at the very end of the current bucket
  int64_t sibling;  // another channel created ten buckets ago, with no memo yet
  std::optional<harness::HTTP> http;

  void insert(int64_t ch, const std::vector<walkRow>& messages) {
    for (const auto& m : messages) ctx->DB.Exec(walkInsert, ch, m.bucket, walkSnowflake(m.bucket, m.offsetMs), 7, m.content);
  }

  // get is one GET on channel; it returns the response and the bucket reads Postgres ran for it.
  std::pair<harness::Response, walkReads> get(int64_t ch, const Params& params = {}) {
    walkReads reads{ctx, ctx->DB.Queries().size()};
    std::string path = "/channels/" + std::to_string(ch) + "/messages";
    for (size_t i = 0; i < params.size(); i++) path += (i == 0 ? "?" : "&") + params[i].first + "=" + params[i].second;
    return {http->Get(path), reads};
  }

  // page decodes a 200 answer as its list of messages.
  harness::Any page(const harness::Response& r) {
    std::string text = r.Text();
    text.erase(0, text.find_first_not_of(" \\t\\r\\n") == std::string::npos ? text.size() : text.find_first_not_of(" \\t\\r\\n"));
    text.erase(text.find_last_not_of(" \\t\\r\\n") + 1);
    if (text.size() > 120) text = text.substr(0, 120);
    ctx->Equal(r.Status, 200, "GET answered %s", text);
    return decode(r);
  }

  harness::Any decode(const harness::Response& r) {
    const auto page = harness::ParseJSON(r.Text());
    if (!page || !(page->IsArray() || page->IsNil())) ctx->Fatalf("the response body does not decode into []map[string]interface {}: %q", r.Text().substr(0, 200));
    return *page;
  }

  std::vector<harness::Any> contents(const harness::Response& r);
};

// walkField lists one field of every message of a page.
std::vector<harness::Any> walkField(const harness::Any& page, const std::string& name) {
  std::vector<harness::Any> out;
  for (const auto& m : page.Items()) out.push_back(m[name]);
  return out;
}

std::vector<harness::Any> walkWorld::contents(const harness::Response& r) { return walkField(page(r), "content"); }

// newWalkWorld stores messages of the channel, then starts the server.
walkWorld newWalkWorld(harness::Ctx& ctx, const std::vector<walkRow>& messages) {
  const int64_t nowB = nowBucket(ctx);
  walkWorld w{&ctx, nowB, walkSnowflake(nowB - 10, 5000), walkSnowflake(nowB, walkBucketMs - 1), walkSnowflake(nowB - 10, 6000), std::nullopt};
  ctx.DB.Reset(db::kSchema);
  w.insert(w.channel, messages);
  w.http = ctx.Main().HTTP();
  return w;
}

}  // namespace

void CheckLimitBounds(harness::Ctx& ctx) {
  const int64_t nowB = nowBucket(ctx);
  std::vector<walkRow> rows;
  for (int i = 0; i < 60; i++) rows.push_back({nowB, 1000LL * (i + 1), "m" + std::to_string(i)});
  auto w = newWalkWorld(ctx, rows);
  for (const std::string bad : {"0", "101", "-5"}) {
    const auto [r, reads] = w.get(w.channel, {{"limit", bad}});
    ctx.Equal(r.Status, 400, "limit=%s is outside 1..100", bad);
  }
  auto r = w.get(w.channel).first;
  ctx.Equal(r.Status, 200, "GET without limit");
  ctx.Equal(w.page(r).Len(), 50, "without ?limit the page holds defaultLimit (50) messages");
  r = w.get(w.channel, {{"limit", "100"}}).first;
  ctx.Equal(w.page(r).Len(), 60, "limit=100 on a channel with 60 messages returns all 60");
  r = w.get(w.channel, {{"limit", "1"}}).first;
  ctx.Equal(w.page(r).Len(), 1, "limit=1 returns one message");
}

void CheckNewestFirst(harness::Ctx& ctx) {
  const int64_t nowB = nowBucket(ctx);
  std::vector<walkRow> rows;
  std::vector<int64_t> ids;
  for (int64_t i = 1; i <= 5; i++) {
    rows.push_back({nowB, 1000 * i, "m" + std::to_string(i)});
    ids.push_back(walkSnowflake(nowB, 1000 * i));
  }
  auto w = newWalkWorld(ctx, rows);
  auto [r, reads] = w.get(w.channel, {{"limit", "3"}});
  ctx.Equal(r.Status, 200, "GET with limit=3");
  const auto page = w.page(r);
  ctx.Equal(walkField(page, "id"), {walkID(ids[4]), walkID(ids[3]), walkID(ids[2])}, "limit=3 must return the three newest ids as strings, newest first");
  ctx.Equal(walkField(page, "content"), {"m5", "m4", "m3"}, "each message carries its content: %s", r.Text());
  for (const auto& author : walkField(page, "author_id")) {
    ctx.Assert(author == "7", "each message carries author_id (as a string): %s", r.Text());
  }
  auto first = reads.all();
  if (first.size() > 1) first.resize(1);
  ctx.Equal(first, std::vector<Read>{Read{w.nowB, 3}}, "the first query must read the current bucket %d bounded by the page size (LIMIT 3), as [bucket, limit]", w.nowB);
  r = w.get(w.channel, {{"before", walkID(ids[3])}, {"limit", "10"}}).first;
  ctx.Equal(walkField(w.page(r), "id"), {walkID(ids[2]), walkID(ids[1]), walkID(ids[0])}, "before=<id of m4> must return m3, m2, m1 (strictly older)");
  r = w.get(w.channel, {{"before", walkID(ids[0])}, {"limit", "10"}}).first;
  const auto got = w.page(r);
  ctx.Assert(got.IsArray() && got.Len() == 0, "nothing is older than the first message: expected [], got %s", r.Text());
}

void CheckWalkBack(harness::Ctx& ctx) {
  const int64_t nowB = nowBucket(ctx);
  const std::vector<walkRow> rows = {{nowB, 1000, "a"}, {nowB, 2000, "b"}, {nowB - 2, 1000, "c"}, {nowB - 2, 2000, "d"}, {nowB - 5, 1000, "e"}};
  auto w = newWalkWorld(ctx, rows);
  auto [r, reads] = w.get(w.channel, {{"before", walkID(w.end)}, {"limit", "3"}});
  ctx.Equal(w.contents(r), {"b", "a", "d"}, "a page of 3 spans buckets %d and %d: expected b, a, d", nowB, nowB - 2);
  ctx.Equal(reads.buckets(), {nowB, nowB - 1, nowB - 2}, "the walk must query buckets %d, %d, %d in that order and stop once the page is full; buckets Postgres was asked for", nowB, nowB - 1, nowB - 2);
  std::vector<int64_t> limits;
  for (const auto& read : reads.all()) limits.push_back(read[1]);
  ctx.Equal(limits, {3, 1, 1}, "each bucket is asked only for what is still missing (LIMIT 3, then 1, then 1); LIMITs Postgres ran");
  w.insert(w.sibling, rows);
  std::tie(r, reads) = w.get(w.sibling, {{"before", walkID(w.end)}, {"limit", "10"}});
  ctx.Equal(w.contents(r), {"b", "a", "d", "c", "e"}, "a page larger than the channel returns everything newest first");
  std::vector<int64_t> want;
  for (int i = 0; i < 11; i++) want.push_back(nowB - i);
  ctx.Equal(reads.buckets(), want, "with the page still short the walk continues down to the channel's bucket (%d); buckets Postgres was asked for", nowB - 10);
}

void CheckChannelFloor(harness::Ctx& ctx) {
  const int64_t nowB = nowBucket(ctx);
  auto w = newWalkWorld(ctx, {{nowB - 9, 1000, "old"}});
  auto [r, reads] = w.get(w.channel, {{"before", walkID(w.end)}, {"limit", "50"}});
  ctx.Equal(w.contents(r), {"old"}, "the only message sits nine buckets back and must be found");
  const auto buckets = reads.buckets();
  int64_t lowest = -1;
  for (size_t i = 0; i < buckets.size(); i++) {
    if (i == 0 || buckets[i] < lowest) lowest = buckets[i];
  }
  ctx.Assert(!buckets.empty() && lowest == nowB - 10, "the walk must reach bucketOf(channelID) = %d and stop there; Postgres was asked for buckets down to %d", nowB - 10, lowest);
  ctx.Equal(buckets.size(), 11, "from %d down to %d is 11 bucket queries", nowB, nowB - 10);
  const int64_t young = walkSnowflake(nowB - 1, 0);
  std::tie(r, reads) = w.get(young, {{"before", walkID(w.end)}, {"limit", "50"}});
  const auto empty = w.decode(r);
  ctx.Assert(empty.IsArray() && empty.Len() == 0, "a channel with no messages answers an empty page, got %s", r.Text());
  ctx.Equal(reads.buckets(), {nowB, nowB - 1}, "a channel created in bucket %d needs exactly two queries (%d, %d)", nowB - 1, nowB, nowB - 1);
}

void CheckEmptyMemo(harness::Ctx& ctx) {
  const int64_t nowB = nowBucket(ctx);
  auto w = newWalkWorld(ctx, {{nowB, 1000, "new"}, {nowB - 9, 1000, "old"}});
  auto [r, reads] = w.get(w.channel, {{"before", walkID(w.end)}, {"limit", "5"}});
  ctx.Equal(w.contents(r), {"new", "old"}, "expected new then old");
  ctx.Equal(reads.buckets().size(), 11, "the first read of a quiet channel walks every bucket (11 queries)");
  std::tie(r, reads) = w.get(w.channel, {{"before", walkID(w.end)}, {"limit", "5"}});
  ctx.Equal(w.contents(r), {"new", "old"}, "the second read must return the same page");
  const auto second = reads.buckets();
  ctx.Assert(second.size() <= 3, "the second read must skip the buckets known to be empty: at most 3 queries (%d, %d, %d), Postgres ran %d: %v", nowB, nowB - 9, nowB - 10, second.size(), second);
  for (const int64_t b : second) {
    ctx.Assert(b != nowB - 5, "bucket %d came back empty on the first read and must not be queried again", nowB - 5);
  }
  r = w.get(w.channel, {{"before", walkID(walkSnowflake(nowB, 1000))}, {"limit", "5"}}).first;
  ctx.Equal(w.contents(r), {"old"}, "before=<id of new> hides new");
  std::tie(r, reads) = w.get(w.channel, {{"before", walkID(w.end)}, {"limit", "5"}});
  bool sawStart = false;
  for (const int64_t b : reads.buckets()) sawStart = sawStart || b == nowB;
  ctx.Assert(sawStart, "the starting bucket %d returned nothing only because of the before cursor: it is not empty, yet the next read skipped it (Postgres was asked for %v)", nowB, reads.buckets());
  ctx.Equal(w.contents(r), {"new", "old"}, "the starting bucket must not be remembered as empty: the newest page is new, old");
}
`,
  },
  debrief: `The read side is where the schema pays off and where it bites. Because the bucket is part of the partition key, each query touches exactly one partition and the walk from newest to oldest is a handful of sequential range scans — cheap for the busy channels that generate most reads, since their page fills from the first bucket. Quiet channels are the price: a server that talks twice a month spreads fifty messages over dozens of windows, and without a memo every page load re-reads every empty one. Discord's 2017 fix was that memo, after a channel with millions of deleted messages (and so millions of tombstones in otherwise empty buckets) took twenty seconds to load. The channel id as a floor is the other half: it is free, exact, and turns "walk back forever" into "walk back to creation". Real systems persist the memo rather than keeping it per process, invalidate it when old messages are imported, and cap the number of buckets one request may scan so a pathological channel cannot hold a connection for seconds.`,
};
