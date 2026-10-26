import type {Step} from '@/lib/types';

export const hotChannelsStep: Step = {
  id: 'hot-channels',
  title: 'Hot channels: the newest page, write-through in a Redis list',
  concept: 'redis',
  file: 'hot_channels',
  focus: ['api', 'redis', 'data'],
  task: `## Task

For a hot channel the same request dominates: "the newest 50, no cursor". Coalescing turned a thousand
of those into one database read per instant; a small cache turns them into none. Put the API's two
routes together with a **write-through list** per channel: \`store_message\`, \`valid_content\`,
\`NewMessage\` (step 1), \`latest_snowflake\` (step 2), \`fetch_messages\` (step 4) and \`publish\` (step 5)
are imported.

- \`POST /channels/{channel_id}/messages\`: validate (**400**), \`store_message\`, \`publish\`, then
  push the message into \`recent:{channel_id}\` — \`LPUSH\` the JSON \`{"id", "author_id", "content"}\`,
  \`LTRIM 0 99\` (\`RECENT_N\`), \`EXPIRE 300\` (\`RECENT_TTL_S\`) — and answer **201**. Every write goes
  through the list, so what the list holds is never stale.
- \`GET /channels/{channel_id}/messages\`: \`limit\` 1–100 (default 50, else **400**). Without
  \`before\`, try \`LRANGE recent:{channel_id} 0 limit-1\` and answer from it **only when it holds the
  whole page** (\`len(cached) >= limit\`): a shorter list only proves the channel has been quiet
  since it last filled. Otherwise — a short list, or any \`before\` — fall back to \`fetch_messages\`
  (the data service) with \`before or latest_snowflake()\`, and answer its rows in the same shape.
  Reads never write the list.

:::widget cache-aside {"stampede": false}

> The list is not cache-aside: nothing is filled on a miss and nothing can be stale, because the only
> writer is the request that just stored the message. The TTL is there to let cold channels leave
> memory, not to bound staleness.`,
  sequence: {
    participants: ['Client', 'messages-api', 'Redis', 'data-service'],
    messages: [
      {from: 'Client', to: 'messages-api', label: 'POST /channels/1032…/messages', kind: 'sync'},
      {from: 'messages-api', to: 'messages-api', label: 'store_message · publish', kind: 'sync'},
      {from: 'messages-api', to: 'Redis', label: 'LPUSH recent:1032… {…} · LTRIM 0 99 · EXPIRE 300', kind: 'sync'},
      {from: 'messages-api', to: 'Client', label: '201', kind: 'reply'},
      {from: 'Client', to: 'messages-api', label: 'GET /channels/1032…/messages?limit=50', kind: 'sync'},
      {from: 'messages-api', to: 'Redis', label: 'LRANGE recent:1032… 0 49', kind: 'sync'},
      {from: 'Redis', to: 'messages-api', label: '50 items → 200 from the list', kind: 'reply'},
      {from: 'Client', to: 'messages-api', label: 'GET …?before=1561…&limit=50', kind: 'sync'},
      {from: 'messages-api', to: 'data-service', label: 'GetMessages(1032…, 1561…, 50)', kind: 'sync'},
    ],
  },
  hints: [
    'Two conditions gate the cached answer: no `before` *and* `len(cached) >= limit`. Everything else — including a list with 49 items for a page of 50 — goes to `fetch_messages`.',
    'On the write path the three Redis commands belong together: push, trim to `RECENT_N - 1`, re-arm the TTL. A pipeline sends them in one round trip; the order inside it is push first.',
    'Both branches of `GET` must answer the same shape, `[{"id", "author_id", "content"}]` with string ids: the cached entries are stored that way, and `Message` protos convert with `str(m.id)`.',
  ],
  checks: [
    {
      id: 'cache-read',
      title: 'GET tries LRANGE recent:{channel} 0 limit-1 first',
      detail:
        'Without a cursor the newest page is read from the channel’s list, `LRANGE recent:{channel_id} 0 limit-1`, before any data-service call.',
      match: {
        python: {all: [/f"recent:\{/, /r\.lrange\(\s*\w+\s*,\s*0\s*,\s*limit\s*-\s*1\s*\)/]},
        typescript: {all: [/`recent:\$\{/, /redis\.lrange\(\s*\w+\s*,\s*0\s*,\s*limit\s*-\s*1\s*\)/]},
        go: {all: [/"recent:"\s*\+/, /rdb\.LRange\(\s*ctx\s*,\s*\w+\s*,\s*0\s*,\s*int64\(\s*limit\s*\)\s*-\s*1\s*\)/]},
        scala: {all: [/s"recent:\$/, /jedis\.lrange\(\s*\w+\s*,\s*0L?\s*,\s*limit\s*-\s*1L?\s*\)/]},
        cpp: {all: [/"recent:"\s*\+/, /redis\.lrange\(\s*\w+\s*,\s*0\s*,\s*limit\s*-\s*1\s*,/]},
      },
    },
    {
      id: 'full-page-only',
      title: 'Answers from the list only for a cursorless request it can fill',
      detail:
        'The cached page is used only when there is no `before` and the list holds at least `limit` items; anything less is not a page.',
      match: {
        python: {all: [/before is None/, /len\(\s*cached\s*\)\s*>=\s*limit/]},
        typescript: {all: [/before\s*===?\s*undefined|before\s*==\s*null/, /cached\.length\s*>=\s*limit/]},
        go: {all: [/before\s*==\s*""/, /len\(\s*cached\s*\)\s*>=\s*limit/]},
        scala: {all: [/before\.isEmpty/, /cached\.size\s*>=\s*limit/]},
        cpp: {
          all: [/!req\.has_param\(\s*"before"\s*\)/, /cached\.size\(\)\s*>=\s*static_cast<std::size_t>\(\s*limit\s*\)/],
        },
      },
    },
    {
      id: 'fallback',
      title: 'Falls back to the data service and never fills the list from a read',
      detail:
        'A miss, a short list or any `before` goes to `fetch_messages(channel_id, before or latest_snowflake(), limit)`; the read path does not write Redis.',
      match: {
        python: {
          all: [/await fetch_messages\(\s*channel_id\s*,/, /latest_snowflake\(\)/],
          none: [/def get_messages(?:(?!\n@app)[\s\S])*?\.(lpush|rpush|set)\(/],
        },
        typescript: {
          all: [/await fetch_messages\(\s*channelId\s*,/, /latest_snowflake\(\)/],
          none: [/app\.get\((?:(?!\napp\.)[\s\S])*?\.(lpush|rpush|set)\(/],
        },
        go: {
          all: [/fetchMessages\(\s*ctx\s*,\s*channelID\s*,/, /latestSnowflake\(\)/],
          none: [/func getMessages(?:(?!\n\})[\s\S])*?\.(LPush|RPush|Set)\(/],
        },
        scala: {
          all: [/fetchMessages\(\s*channelId\s*,/, /latestSnowflake\(\)/],
          none: [/\bget\s*\{(?:(?!\n {6}\})[\s\S])*?\.(lpush|rpush|set)\(/],
        },
        cpp: {
          all: [/fetch_messages\(\s*channel_id\s*,/, /latest_snowflake\(\)/],
          none: [/svr\.Get\((?:(?!\n {2}\}\);)[\s\S])*?\.(lpush|rpush|set)\(/],
        },
      },
    },
    {
      id: 'write-through',
      title: 'POST stores, publishes, then LPUSH + LTRIM 0 99',
      detail:
        'After `store_message` and `publish`, the message is pushed to the head of `recent:{channel_id}` and the list is trimmed to `RECENT_N` (100) items.',
      match: {
        python: {
          order: [
            /await store_message\(/,
            /publish\(\s*message\s*\)/,
            /\.lpush\(/,
            /\.ltrim\(\s*\w+\s*,\s*0\s*,\s*RECENT_N\s*-\s*1\s*\)/,
          ],
        },
        typescript: {
          order: [
            /await store_message\(/,
            /publish\(\s*message\s*\)/,
            /\.lpush\(/,
            /\.ltrim\(\s*\w+\s*,\s*0\s*,\s*RECENT_N\s*-\s*1\s*\)/,
          ],
        },
        go: {
          order: [
            /storeMessage\(/,
            /publish\(\s*ctx\s*,\s*msg\s*\)/,
            /\.LPush\(/,
            /\.LTrim\(\s*ctx\s*,\s*\w+\s*,\s*0\s*,\s*recentN\s*-\s*1\s*\)/,
          ],
        },
        scala: {
          order: [
            /storeMessage\(/,
            /publish\(\s*message\s*\)/,
            /\.lpush\(/,
            /\.ltrim\(\s*\w+\s*,\s*0L?\s*,\s*RecentN\s*-\s*1L?\s*\)/,
          ],
        },
        cpp: {
          order: [
            /store_message\(/,
            /publish\(\s*message\s*\)/,
            /\.lpush\(/,
            /\.ltrim\(\s*\w+\s*,\s*0\s*,\s*kRecentN\s*-\s*1\s*\)/,
          ],
        },
      },
    },
    {
      id: 'ttl',
      title: 'Re-arms a 300 s expiry on every write',
      detail:
        'Each POST sets `EXPIRE recent:{channel_id} 300` (`RECENT_TTL_S`), so a channel that goes quiet leaves memory on its own.',
      match: {
        python: {all: [/\.expire\(\s*\w+\s*,\s*RECENT_TTL_S\s*\)/]},
        typescript: {all: [/\.expire\(\s*\w+\s*,\s*RECENT_TTL_S\s*\)/]},
        go: {all: [/\.Expire\(\s*ctx\s*,\s*\w+\s*,\s*recentTTL\s*\)/]},
        scala: {all: [/\.expire\(\s*\w+\s*,\s*RecentTtlSeconds\s*\)/]},
        cpp: {all: [/\.expire\(\s*\w+\s*,\s*kRecentTtl\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from channel_routing import fetch_messages  # built in step 4: the ring and the 300 ms deadline
from message_events import publish  # built in step 5: one message-events record per stored message
from post_message import NewMessage, store_message, valid_content  # built in step 1
from read_messages import DEFAULT_LIMIT, MAX_LIMIT, latest_snowflake  # built in step 2

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECENT_N = 100
RECENT_TTL_S = 300


@app.get("/channels/{channel_id}/messages")
async def get_messages(channel_id: int, before: int | None = None, limit: int = DEFAULT_LIMIT) -> JSONResponse:
    # TODO: 400 unless 1 <= limit <= MAX_LIMIT
    # TODO: no before → cached = LRANGE recent:{channel_id} 0 limit-1; a full page (len >= limit) → answer it
    # TODO: otherwise fetch_messages(channel_id, before or latest_snowflake(), limit) → [{"id", "author_id", "content"}]
    raise HTTPException(status_code=501)


@app.post("/channels/{channel_id}/messages")
async def post_message(channel_id: int, body: NewMessage) -> JSONResponse:
    # TODO: 400 unless valid_content; message = await store_message(...); publish(message)
    # TODO: LPUSH recent:{channel_id} json of {"id", "author_id", "content"}; LTRIM 0 RECENT_N-1; EXPIRE RECENT_TTL_S
    # TODO: 201 with the message
    raise HTTPException(status_code=501)
`,
      solution: `import json

import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from channel_routing import fetch_messages  # built in step 4: the ring and the 300 ms deadline
from message_events import publish  # built in step 5: one message-events record per stored message
from post_message import NewMessage, store_message, valid_content  # built in step 1
from read_messages import DEFAULT_LIMIT, MAX_LIMIT, latest_snowflake  # built in step 2

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECENT_N = 100
RECENT_TTL_S = 300


@app.get("/channels/{channel_id}/messages")
async def get_messages(channel_id: int, before: int | None = None, limit: int = DEFAULT_LIMIT) -> JSONResponse:
    if limit < 1 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 100")
    if before is None:  # the newest page is the only one the list can answer
        key = f"recent:{channel_id}"
        cached = r.lrange(key, 0, limit - 1)
        if len(cached) >= limit:  # a shorter list is not a page: fall through
            return JSONResponse([json.loads(item) for item in cached])
    rows = await fetch_messages(channel_id, before if before is not None else latest_snowflake(), limit)
    return JSONResponse([{"id": str(m.id), "author_id": str(m.author_id), "content": m.content} for m in rows])


@app.post("/channels/{channel_id}/messages")
async def post_message(channel_id: int, body: NewMessage) -> JSONResponse:
    if not valid_content(body.content):
        raise HTTPException(status_code=400, detail="content must be 1 to 2000 characters")
    message = await store_message(channel_id, body.author_id, body.content)
    publish(message)
    key = f"recent:{channel_id}"
    pipe = r.pipeline()
    pipe.lpush(key, json.dumps({"id": message["id"], "author_id": message["author_id"], "content": message["content"]}))
    pipe.ltrim(key, 0, RECENT_N - 1)
    pipe.expire(key, RECENT_TTL_S)
    pipe.execute()
    return JSONResponse(message, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {fetch_messages} from './channel_routing'; // built in step 4: the ring and the 300 ms deadline
import {publish} from './message_events'; // built in step 5: one message-events record per stored message
import {type NewMessage, store_message, valid_content} from './post_message'; // built in step 1
import {DEFAULT_LIMIT, latest_snowflake, MAX_LIMIT, type PageMessage} from './read_messages'; // built in step 2

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const RECENT_N = 100;
export const RECENT_TTL_S = 300;

app.get('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const {before, limit: rawLimit} = request.query as {before?: string; limit?: string};
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  // TODO: 400 unless 1 <= limit <= MAX_LIMIT
  // TODO: no before → cached = LRANGE recent:{channelId} 0 limit-1; a full page (cached.length >= limit) → answer it
  // TODO: otherwise fetch_messages(channelId, before ?? latest_snowflake(), limit) → [{id, author_id, content}] as PageMessage[]
  return reply.code(501).send();
});

app.post('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const body = request.body as NewMessage;
  // TODO: 400 unless valid_content; message = await store_message(...); await publish(message)
  // TODO: LPUSH recent:{channelId} json of {id, author_id, content}; LTRIM 0 RECENT_N-1; EXPIRE RECENT_TTL_S
  // TODO: 201 with the message
  return reply.code(501).send();
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {fetch_messages} from './channel_routing'; // built in step 4: the ring and the 300 ms deadline
import {publish} from './message_events'; // built in step 5: one message-events record per stored message
import {type NewMessage, store_message, valid_content} from './post_message'; // built in step 1
import {DEFAULT_LIMIT, latest_snowflake, MAX_LIMIT, type PageMessage} from './read_messages'; // built in step 2

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const RECENT_N = 100;
export const RECENT_TTL_S = 300;

app.get('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const {before, limit: rawLimit} = request.query as {before?: string; limit?: string};
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return reply.code(400).send({error: 'limit must be between 1 and 100'});
  }
  if (before === undefined) {
    // the newest page is the only one the list can answer
    const key = \`recent:\${channelId}\`;
    const cached = await redis.lrange(key, 0, limit - 1);
    if (cached.length >= limit) return cached.map(item => JSON.parse(item) as PageMessage); // a shorter list is not a page: fall through
  }
  const rows = await fetch_messages(channelId, before !== undefined ? BigInt(before) : latest_snowflake(), limit);
  const page: PageMessage[] = rows.map(m => ({id: String(m.id), author_id: String(m.author_id), content: m.content}));
  return page;
});

app.post('/channels/:channel_id/messages', async (request, reply) => {
  const channelId = BigInt((request.params as {channel_id: string}).channel_id);
  const body = request.body as NewMessage;
  if (!valid_content(body.content ?? '')) {
    return reply.code(400).send({error: 'content must be 1 to 2000 characters'});
  }
  const message = await store_message(channelId, BigInt(body.author_id), body.content ?? '');
  await publish(message);
  const key = \`recent:\${channelId}\`;
  await redis
    .pipeline()
    .lpush(key, JSON.stringify({id: message.id, author_id: message.author_id, content: message.content}))
    .ltrim(key, 0, RECENT_N - 1)
    .expire(key, RECENT_TTL_S)
    .exec();
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
	"time"

	"github.com/redis/go-redis/v9"

	pb "discord/gen/messages"
)

const (
	defaultLimit = 50
	maxLimit     = 100
	recentN      = 100
	recentTTL    = 300 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Built in steps 1, 2, 4 and 5.
type message struct {
	ID        string \`json:"id"\`
	ChannelID string \`json:"channel_id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
	Bucket    int32  \`json:"bucket"\`
}

var validContent = func(content string) bool { panic("not implemented") }
var storeMessage = func(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	panic("not implemented")
}
var latestSnowflake = func() int64 { panic("not implemented") }
var fetchMessages = func(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	panic("not implemented")
}
var publish = func(ctx context.Context, msg message) { panic("not implemented") }

type entry struct {
	ID       string \`json:"id"\`
	AuthorID string \`json:"author_id"\`
	Content  string \`json:"content"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getMessages(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	channelID, _ := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	q := r.URL.Query()
	limit := defaultLimit
	if q.Get("limit") != "" {
		limit, _ = strconv.Atoi(q.Get("limit"))
	}
	before := q.Get("before")
	// TODO: 400 unless 1 <= limit <= maxLimit
	// TODO: before == "" → cached := LRange "recent:"+channel 0 limit-1; a full page (len >= limit) → answer it
	// TODO: otherwise fetchMessages(ctx, channelID, before or latestSnowflake(), limit) → []entry
	_ = ctx
	_ = channelID
	_ = before
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	channelID, err := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	var req struct {
		AuthorID int64  \`json:"author_id"\`
		Content  string \`json:"content"\`
	}
	// TODO: 400 unless the path and body parse and validContent; msg, err := storeMessage(...); publish(ctx, msg)
	// TODO: pipeline: LPush "recent:"+channel json of entry{…}; LTrim 0 recentN-1; Expire recentTTL
	// TODO: 201 with msg
	_ = ctx
	_ = err
	_ = channelID
	_ = req
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /channels/{channel_id}/messages", getMessages)
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
	"time"

	"github.com/redis/go-redis/v9"

	pb "discord/gen/messages"
)

const (
	defaultLimit = 50
	maxLimit     = 100
	recentN      = 100
	recentTTL    = 300 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Built in steps 1, 2, 4 and 5.
type message struct {
	ID        string \`json:"id"\`
	ChannelID string \`json:"channel_id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
	Bucket    int32  \`json:"bucket"\`
}

var validContent = func(content string) bool { panic("not implemented") }
var storeMessage = func(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	panic("not implemented")
}
var latestSnowflake = func() int64 { panic("not implemented") }
var fetchMessages = func(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	panic("not implemented")
}
var publish = func(ctx context.Context, msg message) { panic("not implemented") }

type entry struct {
	ID       string \`json:"id"\`
	AuthorID string \`json:"author_id"\`
	Content  string \`json:"content"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getMessages(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	channelID, _ := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	q := r.URL.Query()
	limit := defaultLimit
	if q.Get("limit") != "" {
		limit, _ = strconv.Atoi(q.Get("limit"))
	}
	before := q.Get("before")
	if limit < 1 || limit > maxLimit {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be between 1 and 100"})
		return
	}
	key := "recent:" + strconv.FormatInt(channelID, 10)
	if before == "" { // the newest page is the only one the list can answer
		cached, err := rdb.LRange(ctx, key, 0, int64(limit)-1).Result()
		if err == nil && len(cached) >= limit { // a shorter list is not a page: fall through
			page := make([]json.RawMessage, 0, len(cached))
			for _, item := range cached {
				page = append(page, json.RawMessage(item))
			}
			writeJSON(rw, http.StatusOK, page)
			return
		}
	}
	cursor := latestSnowflake()
	if before != "" {
		cursor, _ = strconv.ParseInt(before, 10, 64)
	}
	rows, err := fetchMessages(ctx, channelID, cursor, limit)
	if err != nil {
		writeJSON(rw, http.StatusGatewayTimeout, map[string]string{"error": "data service did not answer"})
		return
	}
	page := make([]entry, 0, len(rows))
	for _, m := range rows {
		page = append(page, entry{ID: strconv.FormatUint(m.GetId(), 10), AuthorID: strconv.FormatUint(m.GetAuthorId(), 10), Content: m.GetContent()})
	}
	writeJSON(rw, http.StatusOK, page)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	channelID, err := strconv.ParseInt(r.PathValue("channel_id"), 10, 64)
	var req struct {
		AuthorID int64  \`json:"author_id"\`
		Content  string \`json:"content"\`
	}
	if err != nil || json.NewDecoder(r.Body).Decode(&req) != nil || !validContent(req.Content) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "content must be 1 to 2000 characters"})
		return
	}
	msg, err := storeMessage(ctx, channelID, req.AuthorID, req.Content)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	publish(ctx, msg)
	key := "recent:" + msg.ChannelID
	value, _ := json.Marshal(entry{ID: msg.ID, AuthorID: msg.AuthorID, Content: msg.Content})
	pipe := rdb.TxPipeline()
	pipe.LPush(ctx, key, value)
	pipe.LTrim(ctx, key, 0, recentN-1)
	pipe.Expire(ctx, key, recentTTL)
	pipe.Exec(ctx)
	writeJSON(rw, http.StatusCreated, msg)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /channels/{channel_id}/messages", getMessages)
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
import discord.Tls // Tls.serverContext — provided
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import spray.json._

// Built in step 1 (PostMessage: NewMessage, StoredMessage, validContent, storeMessage), step 2 (ReadMessages.latestSnowflake),
// step 4 (ChannelRouting.fetchMessages) and step 5 (MessageEvents.publish).
import ChannelRouting.fetchMessages
import MessageEvents.publish
import PostMessage.{newMessageFormat, storeMessage, storedFormat, validContent}
import ReadMessages.latestSnowflake

object HotChannels {
  val DefaultLimit = 50
  val MaxLimit = 100
  val RecentN = 100
  val RecentTtlSeconds = 300L
  val jedis = new JedisPooled("redis", 6379)

  private def entry(id: String, authorId: String, content: String): JsObject =
    JsObject("id" -> JsString(id), "author_id" -> JsString(authorId), "content" -> JsString(content))

  val route: Route =
    path("channels" / LongNumber / "messages") { channelId =>
      get {
        parameters("before".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (before, limit) =>
          // TODO: 400 unless 1 <= limit <= MaxLimit
          // TODO: before.isEmpty → cached = LRANGE s"recent:$channelId" 0 limit-1; a full page (size >= limit) → answer it
          // TODO: otherwise fetchMessages(channelId, before.getOrElse(latestSnowflake()), limit) → entries
          complete(HttpResponse(StatusCodes.NotImplemented))
        }
      } ~
        post {
          entity(as[NewMessage]) { req =>
            // TODO: 400 unless validContent; val message = storeMessage(...); publish(message)
            // TODO: pipeline: LPUSH s"recent:$channelId" entry json; LTRIM 0 RecentN-1; EXPIRE RecentTtlSeconds
            // TODO: 201 with the message
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
import discord.Tls // Tls.serverContext — provided
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import spray.json._

// Built in step 1 (PostMessage: NewMessage, StoredMessage, validContent, storeMessage), step 2 (ReadMessages.latestSnowflake),
// step 4 (ChannelRouting.fetchMessages) and step 5 (MessageEvents.publish).
import ChannelRouting.fetchMessages
import MessageEvents.publish
import PostMessage.{newMessageFormat, storeMessage, storedFormat, validContent}
import ReadMessages.latestSnowflake

object HotChannels {
  val DefaultLimit = 50
  val MaxLimit = 100
  val RecentN = 100
  val RecentTtlSeconds = 300L
  val jedis = new JedisPooled("redis", 6379)

  private def entry(id: String, authorId: String, content: String): JsObject =
    JsObject("id" -> JsString(id), "author_id" -> JsString(authorId), "content" -> JsString(content))

  private def jsonArray(items: Seq[String]): HttpEntity.Strict =
    HttpEntity(ContentTypes.\`application/json\`, items.mkString("[", ",", "]"))

  val route: Route =
    path("channels" / LongNumber / "messages") { channelId =>
      get {
        parameters("before".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (before, limit) =>
          if (limit < 1 || limit > MaxLimit)
            complete(StatusCodes.BadRequest -> Map("error" -> "limit must be between 1 and 100"))
          else {
            val key = s"recent:$channelId"
            val cached = if (before.isEmpty) jedis.lrange(key, 0, limit - 1).asScala.toVector else Vector.empty
            if (before.isEmpty && cached.size >= limit) complete(jsonArray(cached)) // a shorter list is not a page
            else {
              val rows = fetchMessages(channelId, before.getOrElse(latestSnowflake()), limit)
              complete(jsonArray(rows.map(m => entry(m.id.toString, m.authorId.toString, m.content).compactPrint)))
            }
          }
        }
      } ~
        post {
          entity(as[NewMessage]) { req =>
            if (!validContent(req.content))
              complete(StatusCodes.BadRequest -> Map("error" -> "content must be 1 to 2000 characters"))
            else {
              val message = storeMessage(channelId, req.authorId, req.content)
              publish(message)
              val key = s"recent:$channelId"
              val pipe = jedis.pipelined()
              pipe.lpush(key, entry(message.id, message.authorId, message.content).compactPrint)
              pipe.ltrim(key, 0, RecentN - 1)
              pipe.expire(key, RecentTtlSeconds)
              pipe.sync()
              complete(StatusCodes.Created -> message)
            }
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
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iterator>
#include <string>
#include <vector>

#include "messages.grpc.pb.h"

using json = nlohmann::json;

constexpr int kDefaultLimit = 50;
constexpr int kMaxLimit = 100;
constexpr int kRecentN = 100;
constexpr std::chrono::seconds kRecentTtl{300};

sw::redis::Redis redis("tcp://redis:6379");

// Built in steps 1, 2, 4 and 5.
bool valid_content(const std::string& content);
json store_message(int64_t channel_id, int64_t author_id, const std::string& content);
int64_t latest_snowflake();
std::vector<discord::Message> fetch_messages(int64_t channel_id, int64_t before, int limit);
void publish(const json& message);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : kDefaultLimit;
    // TODO: 400 unless 1 <= limit <= kMaxLimit
    // TODO: no "before" → cached = LRANGE "recent:" + channel 0 limit-1; a full page (size >= limit) → answer it
    // TODO: otherwise fetch_messages(channel_id, before or latest_snowflake(), limit) → [{"id", "author_id", "content"}]
    (void)channel_id;
    (void)limit;
    res.status = 501;
  });

  svr.Post(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const int64_t author_id = body.value("author_id", 0LL);
    const std::string content = body.value("content", "");
    // TODO: 400 unless valid_content; const json message = store_message(...); publish(message)
    // TODO: pipeline: lpush "recent:" + channel json of {"id", "author_id", "content"}; ltrim 0 kRecentN-1; expire kRecentTtl
    // TODO: 201 with the message
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
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iterator>
#include <string>
#include <vector>

#include "messages.grpc.pb.h"

using json = nlohmann::json;

constexpr int kDefaultLimit = 50;
constexpr int kMaxLimit = 100;
constexpr int kRecentN = 100;
constexpr std::chrono::seconds kRecentTtl{300};

sw::redis::Redis redis("tcp://redis:6379");

// Built in steps 1, 2, 4 and 5.
bool valid_content(const std::string& content);
json store_message(int64_t channel_id, int64_t author_id, const std::string& content);
int64_t latest_snowflake();
std::vector<discord::Message> fetch_messages(int64_t channel_id, int64_t before, int limit);
void publish(const json& message);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/channels/(\\d+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const int64_t channel_id = std::stoll(req.matches[1]);
    const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : kDefaultLimit;
    if (limit < 1 || limit > kMaxLimit) {
      res.status = 400;
      res.set_content(R"({"error":"limit must be between 1 and 100"})", "application/json");
      return;
    }
    const std::string key = "recent:" + std::to_string(channel_id);
    if (!req.has_param("before")) {  // the newest page is the only one the list can answer
      std::vector<std::string> cached;
      redis.lrange(key, 0, limit - 1, std::back_inserter(cached));
      if (cached.size() >= static_cast<std::size_t>(limit)) {  // a shorter list is not a page: fall through
        json page = json::array();
        for (const auto& item : cached) page.push_back(json::parse(item));
        res.set_content(page.dump(), "application/json");
        return;
      }
    }
    const int64_t before = req.has_param("before") ? std::stoll(req.get_param_value("before")) : latest_snowflake();
    json page = json::array();
    for (const auto& m : fetch_messages(channel_id, before, limit))
      page.push_back({{"id", std::to_string(m.id())}, {"author_id", std::to_string(m.author_id())}, {"content", m.content()}});
    res.set_content(page.dump(), "application/json");
  });

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
    publish(message);
    const std::string key = "recent:" + std::to_string(channel_id);
    const std::string item = json{{"id", message["id"]}, {"author_id", message["author_id"]}, {"content", message["content"]}}.dump();
    auto pipe = redis.pipeline();
    pipe.lpush(key, item).ltrim(key, 0, kRecentN - 1).expire(key, kRecentTtl);
    pipe.exec();
    res.status = 201;
    res.set_content(message.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import importlib
import json
import time

from messages.db import SCHEMA

EPOCH = 1420070400000
BUCKET_MS = 10 * 24 * 3600 * 1000
INSERT = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES (%s, %s, %s, %s, %s)"
NOW_B = (int(time.time() * 1000) - EPOCH) // BUCKET_MS


def sf(bucket, offset_ms=0):
    return ((bucket * BUCKET_MS + offset_ms) << 22) | (1 << 17)


CHANNEL = sf(NOW_B - 1, 5000)  # created last bucket
KEY = f"recent:{CHANNEL}"


async def _api(ctx, stored=0, cached=0):
    """
    The API over the real stack: Postgres holds \`stored\` messages of CHANNEL (db0 the oldest), the newest
    \`cached\` of them sit in recent:{CHANNEL} as POST left them, and step 3's data service serves at every
    instance step 4's ring routes to. Returns the app module and the stored messages, newest first.
    """
    await ctx.db.reset(SCHEMA)
    entries = []
    for i in range(stored):
        mid = sf(NOW_B - 1, 10000 + 1000 * i)
        await ctx.db.execute(INSERT, (str(CHANNEL), NOW_B - 1, str(mid), "7", f"db{i}"))
        entries.insert(0, {"id": str(mid), "author_id": "7", "content": f"db{i}"})
    if cached:
        ctx.redis.rpush(KEY, *[json.dumps(e) for e in entries[:cached]])
    m = ctx.load("hot_channels")
    routing = importlib.import_module("channel_routing")
    data_service = importlib.import_module("data_service")
    pb2_grpc = importlib.import_module("messages_pb2_grpc")
    base = pb2_grpc.MessageDataServicer
    servicers = [v for v in vars(data_service).values() if isinstance(v, type) and issubclass(v, base) and v is not base]
    assert servicers, "data_service (step 3) defines no MessageDataServicer to read through"
    for node in routing.INSTANCES:
        ctx.grpc.serve(pb2_grpc.add_MessageDataServicer_to_server, servicers[0](), target=node)
    return m, entries


class _Reads:
    """What reached the data path since it was made: GetMessages calls (to any instance) and the reads Postgres ran."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.calls_from = len(ctx.grpc.calls_to("GetMessages"))
        self.queries_from = len(ctx.db.queries)

    def calls(self):
        return self.ctx.grpc.calls_to("GetMessages")[self.calls_from :]

    def selects(self):
        return [sql for sql, _params in self.ctx.db.queries[self.queries_from :] if " ".join(sql.split()).lower().startswith("select")]

    def none(self):
        return not self.calls() and not self.selects()

    def __str__(self):
        return f"{len(self.calls())} GetMessages call(s) and {len(self.selects())} SELECT(s) on Postgres"


async def _get(m, ctx, **params):
    reads = _Reads(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get(f"/channels/{CHANNEL}/messages", params=params)
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text[:120]}"
    return r.json(), reads


async def _post(m, ctx, content):
    async with ctx.client(m.app) as c:
        return await c.post(f"/channels/{CHANNEL}/messages", json={"author_id": 7, "content": content})


async def check_cache_read(ctx):
    m, entries = await _api(ctx, stored=60, cached=60)
    page, reads = await _get(m, ctx, limit=50)
    assert page == entries[:50], f"with 60 cached entries limit=50 must be the first 50 of the list, newest first; got {len(page)} entries starting {page[:2]}"
    assert reads.none(), f"the page was in the list, yet the read cost {reads}: a cache hit touches neither the data service nor the database"
    page, reads = await _get(m, ctx)
    assert len(page) == 50 and reads.none(), f"without ?limit the default page of 50 comes from the list too; got {len(page)} entries for {reads}"
    page, reads = await _get(m, ctx, limit=60)
    assert page == entries and reads.none(), f"limit=60 is covered by 60 entries: the whole list, no data path; got {len(page)} entries for {reads}"
    async with ctx.client(m.app) as c:
        for bad in (0, 101):
            r = await c.get(f"/channels/{CHANNEL}/messages", params={"limit": bad})
            assert r.status_code == 400, f"limit={bad} is outside 1..100: expected 400, got {r.status_code}"


async def check_full_page_only(ctx):
    m, entries = await _api(ctx, stored=12, cached=10)
    page, reads = await _get(m, ctx, limit=50)
    calls = reads.calls()
    assert len(calls) == 1, f"10 cached entries cannot answer a page of 50: the data service must be asked once, it was asked {len(calls)} time(s)"
    assert calls[0].request.channel_id == CHANNEL and calls[0].request.limit == 50, f"the fallback must ask for this channel and limit, asked {calls[0].request}"
    assert page == entries, f"the list holds only 10 of the channel's 12 messages: the page must be all 12 from the data service, got {len(page)}: {[x.get('content') for x in page]}"
    assert ctx.redis.lrange(KEY, 0, -1) == [json.dumps(e) for e in entries[:10]], "reads never write the list: after the fallback it must hold exactly the 10 entries POST left there"
    page, reads = await _get(m, ctx, limit=10)
    assert reads.none(), f"10 cached entries do answer a page of 10, yet the read cost {reads}"
    assert page == entries[:10], f"limit=10 must be served from the list, got {page}"
    page, reads = await _get(m, ctx, limit=5, before=entries[7]["id"])
    calls = reads.calls()
    assert len(calls) == 1, "a request with ?before is never the newest page: it must go to the data service even though the list holds enough entries"
    assert calls[0].request.before == int(entries[7]["id"]), f"the before cursor must be passed through, the data service saw {calls[0].request.before}"
    assert page == entries[8:], f"the page older than db4 is db3..db0 from the data service, got {[x.get('content') for x in page]}"


async def check_fallback(ctx):
    m, entries = await _api(ctx, stored=3)
    page, reads = await _get(m, ctx, limit=50)
    calls = reads.calls()
    assert len(calls) == 1, f"an empty list must fall back to the data service once, it was called {len(calls)} time(s)"
    assert calls[0].request.before > int(entries[0]["id"]), f"without ?before the fallback must pass latest_snowflake(), an id newer than anything stored; it passed {calls[0].request.before}"
    assert reads.selects(), "the fallback page must come from Postgres through the data service, no query reached it"
    assert page == entries, f"the data service's messages must be answered as {{id, author_id, content}} with string ids, newest first: expected {entries}, got {page}"
    assert ctx.redis.exists(KEY) == 0, "reads never fill the list: it is written only by POST, otherwise an old page could shadow a newer message"
    page, reads = await _get(m, ctx, limit=50)
    assert len(reads.calls()) == 1, f"a second miss is a second data-service call (nothing was cached by the read), it made {len(reads.calls())}"
    assert page == entries and ctx.redis.exists(KEY) == 0, "the second miss answers the same page and still leaves the list alone"


async def check_write_through(ctx):
    m, entries = await _api(ctx, stored=99, cached=99)
    r = await _post(m, ctx, "")
    assert r.status_code == 400, f"empty content must be a 400, got {r.status_code}"
    assert ctx.redis.llen(KEY) == 99, "a rejected message must not touch the list"
    ids = []
    for content in ("first", "second", "third"):
        r = await _post(m, ctx, content)
        assert r.status_code == 201, f"POST answered {r.status_code}, expected 201"
        ids.append(r.json()["id"])
    rows = await ctx.db.execute("SELECT message_id, content FROM messages ORDER BY message_id DESC LIMIT 3")
    assert [row["message_id"] for row in rows] == ids[::-1], f"every message must be stored (store_message), the newest rows are {[row['content'] for row in rows]}"
    produced = ctx.kafka.records("message-events")
    assert len(produced) == 3 and all(rec.key == str(CHANNEL).encode() for rec in produced), f"every stored message must be published once, keyed by the channel; produced {[(rec.key, rec.offset) for rec in produced]}"
    assert ctx.redis.llen(KEY) == 100, f"99 cached + 3 pushed must be trimmed to 100 (LTRIM 0 99), the list holds {ctx.redis.llen(KEY)}"
    head = [json.loads(x) for x in ctx.redis.lrange(KEY, 0, 2)]
    assert head == [{"id": ids[2], "author_id": "7", "content": "third"}, {"id": ids[1], "author_id": "7", "content": "second"}, {"id": ids[0], "author_id": "7", "content": "first"}], f"the three posts must sit at the head of the list, newest first, as {{id, author_id, content}}: {head}"
    assert [json.loads(x) for x in ctx.redis.lrange(KEY, -1, -1)] == [entries[96]], "the two oldest cached entries must have been trimmed away"
    page, reads = await _get(m, ctx, limit=50)
    assert reads.none(), f"the newest page is in the list now, yet the read cost {reads}"
    assert page[:3] == head and page[3:] == entries[:47], "the newest page comes from the list and starts with the messages just posted"


async def check_ttl(ctx):
    m, entries = await _api(ctx)
    r = await _post(m, ctx, "hello")
    assert r.status_code == 201, f"POST answered {r.status_code}"
    ttl = ctx.redis.ttl(KEY)
    assert ttl > 0, f"{KEY} has no expiry (TTL {ttl}): quiet channels would stay in memory forever"
    assert 290 <= ttl <= 300, f"{KEY} expires in {ttl} s, expected 300"
    ctx.clock.advance(200)
    await _post(m, ctx, "again")
    assert ctx.redis.ttl(KEY) > 250, f"a new message must re-arm the expiry, 200 s later the TTL is {ctx.redis.ttl(KEY)} s"
    ctx.clock.advance(301)
    assert ctx.redis.exists(KEY) == 0, f"{KEY} must be gone 300 s after the last message"
    page, reads = await _get(m, ctx, limit=50)
    assert len(reads.calls()) == 1, f"once the list expired the newest page comes from the data service again, it was called {len(reads.calls())} time(s)"
    assert [x["content"] for x in page] == ["again", "hello"], f"the page after expiry is read from Postgres: again, hello — got {[x.get('content') for x in page]}"
`,
    typescript: `import {SCHEMA} from 'messages/db';

const EPOCH = 1420070400000;
const BUCKET_MS = 10 * 24 * 3600 * 1000;
const INSERT = 'INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)';
const NOW_B = Math.floor((Date.now() - EPOCH) / BUCKET_MS);

function sf(bucket: number, offsetMs = 0): bigint {
  return (BigInt(bucket * BUCKET_MS + offsetMs) << 22n) | (1n << 17n);
}

const CHANNEL = sf(NOW_B - 1, 5000); // created last bucket
const KEY = \`recent:\${CHANNEL}\`;

interface Entry {
  id: string;
  author_id: string;
  content: string;
}

/**
 * The API over the real stack: Postgres holds \`stored\` messages of CHANNEL (db0 the oldest), the newest
 * \`cached\` of them sit in recent:{CHANNEL} as POST left them, and step 3's data service serves at every
 * instance step 4's ring routes to. Returns the app module and the stored messages, newest first.
 */
async function api(ctx, stored = 0, cached = 0) {
  await ctx.db.reset(SCHEMA);
  const entries: Entry[] = [];
  for (let i = 0; i < stored; i++) {
    const mid = sf(NOW_B - 1, 10000 + 1000 * i);
    await ctx.db.execute(INSERT, [String(CHANNEL), NOW_B - 1, String(mid), '7', \`db\${i}\`]);
    entries.unshift({id: String(mid), author_id: '7', content: \`db\${i}\`});
  }
  if (cached > 0) ctx.redis.rpush(KEY, ...entries.slice(0, cached).map(e => JSON.stringify(e)));
  const m = ctx.load('hot_channels');
  const routing = ctx.load('channel_routing');
  const data = ctx.load('data_service');
  assert(data.messageData !== undefined && typeof data.messageData.GetMessages === 'function', 'data_service (step 3) exports no messageData handlers to read through');
  const service = ctx.proto('messages.proto').discord.MessageData.service;
  for (const node of routing.INSTANCES) ctx.grpc.serve(service, data.messageData, node);
  return {m, entries};
}

/** What reached the data path since it was made: GetMessages calls (to any instance) and the reads Postgres ran. */
class Reads {
  private readonly callsFrom: number;
  private readonly queriesFrom: number;
  constructor(private readonly ctx) {
    this.callsFrom = ctx.grpc.callsTo('GetMessages').length;
    this.queriesFrom = ctx.db.queries.length;
  }
  calls() {
    return this.ctx.grpc.callsTo('GetMessages').slice(this.callsFrom);
  }
  selects(): string[] {
    return this.ctx.db.queries
      .slice(this.queriesFrom)
      .map(([sql]) => sql as string)
      .filter(sql => sql.split(/\\s+/).join(' ').toLowerCase().startsWith('select'));
  }
  none(): boolean {
    return this.calls().length === 0 && this.selects().length === 0;
  }
  toString(): string {
    return \`\${this.calls().length} GetMessages call(s) and \${this.selects().length} SELECT(s) on Postgres\`;
  }
}

async function get(m, ctx, params: Record<string, string | number> = {}) {
  const reads = new Reads(ctx);
  const r = await ctx.client(m.app).get(\`/channels/\${CHANNEL}/messages\`, {query: params});
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text.slice(0, 120)}\`);
  return {page: r.json() as Entry[], reads};
}

async function post(m, ctx, content: string) {
  return ctx.client(m.app).post(\`/channels/\${CHANNEL}/messages\`, {json: {author_id: 7, content}});
}

export async function check_cache_read(ctx) {
  const {m, entries} = await api(ctx, 60, 60);
  let {page, reads} = await get(m, ctx, {limit: 50});
  assert.deepEqual(page, entries.slice(0, 50), \`with 60 cached entries limit=50 must be the first 50 of the list, newest first; got \${page.length} entries starting \${JSON.stringify(page.slice(0, 2))}\`);
  assert(reads.none(), \`the page was in the list, yet the read cost \${reads}: a cache hit touches neither the data service nor the database\`);
  ({page, reads} = await get(m, ctx));
  assert(page.length === 50 && reads.none(), \`without ?limit the default page of 50 comes from the list too; got \${page.length} entries for \${reads}\`);
  ({page, reads} = await get(m, ctx, {limit: 60}));
  assert(JSON.stringify(page) === JSON.stringify(entries) && reads.none(), \`limit=60 is covered by 60 entries: the whole list, no data path; got \${page.length} entries for \${reads}\`);
  for (const bad of [0, 101]) {
    const r = await ctx.client(m.app).get(\`/channels/\${CHANNEL}/messages\`, {query: {limit: bad}});
    assert.equal(r.status, 400, \`limit=\${bad} is outside 1..100: expected 400, got \${r.status}\`);
  }
}

export async function check_full_page_only(ctx) {
  const {m, entries} = await api(ctx, 12, 10);
  let {page, reads} = await get(m, ctx, {limit: 50});
  let calls = reads.calls();
  assert.equal(calls.length, 1, \`10 cached entries cannot answer a page of 50: the data service must be asked once, it was asked \${calls.length} time(s)\`);
  assert(String(calls[0].request.channel_id) === String(CHANNEL) && Number(calls[0].request.limit) === 50, \`the fallback must ask for this channel and limit, asked \${JSON.stringify(calls[0].request)}\`);
  assert.deepEqual(page, entries, \`the list holds only 10 of the channel's 12 messages: the page must be all 12 from the data service, got \${page.length}: \${JSON.stringify(page.map(x => x.content))}\`);
  assert.deepEqual(ctx.redis.lrange(KEY, 0, -1), entries.slice(0, 10).map(e => JSON.stringify(e)), 'reads never write the list: after the fallback it must hold exactly the 10 entries POST left there');
  ({page, reads} = await get(m, ctx, {limit: 10}));
  assert(reads.none(), \`10 cached entries do answer a page of 10, yet the read cost \${reads}\`);
  assert.deepEqual(page, entries.slice(0, 10), \`limit=10 must be served from the list, got \${JSON.stringify(page)}\`);
  ({page, reads} = await get(m, ctx, {limit: 5, before: entries[7].id}));
  calls = reads.calls();
  assert.equal(calls.length, 1, 'a request with ?before is never the newest page: it must go to the data service even though the list holds enough entries');
  assert.equal(String(calls[0].request.before), entries[7].id, \`the before cursor must be passed through, the data service saw \${calls[0].request.before}\`);
  assert.deepEqual(page, entries.slice(8), \`the page older than db4 is db3..db0 from the data service, got \${JSON.stringify(page.map(x => x.content))}\`);
}

export async function check_fallback(ctx) {
  const {m, entries} = await api(ctx, 3);
  let {page, reads} = await get(m, ctx, {limit: 50});
  const calls = reads.calls();
  assert.equal(calls.length, 1, \`an empty list must fall back to the data service once, it was called \${calls.length} time(s)\`);
  assert(BigInt(calls[0].request.before) > BigInt(entries[0].id), \`without ?before the fallback must pass latest_snowflake(), an id newer than anything stored; it passed \${calls[0].request.before}\`);
  assert(reads.selects().length > 0, 'the fallback page must come from Postgres through the data service, no query reached it');
  assert.deepEqual(page, entries, \`the data service's messages must be answered as {id, author_id, content} with string ids, newest first: expected \${JSON.stringify(entries)}, got \${JSON.stringify(page)}\`);
  assert.equal(ctx.redis.exists(KEY), 0, 'reads never fill the list: it is written only by POST, otherwise an old page could shadow a newer message');
  ({page, reads} = await get(m, ctx, {limit: 50}));
  assert.equal(reads.calls().length, 1, \`a second miss is a second data-service call (nothing was cached by the read), it made \${reads.calls().length}\`);
  assert(JSON.stringify(page) === JSON.stringify(entries) && ctx.redis.exists(KEY) === 0, 'the second miss answers the same page and still leaves the list alone');
}

export async function check_write_through(ctx) {
  const {m, entries} = await api(ctx, 99, 99);
  let r = await post(m, ctx, '');
  assert.equal(r.status, 400, \`empty content must be a 400, got \${r.status}\`);
  assert.equal(ctx.redis.llen(KEY), 99, 'a rejected message must not touch the list');
  const ids: string[] = [];
  for (const content of ['first', 'second', 'third']) {
    r = await post(m, ctx, content);
    assert.equal(r.status, 201, \`POST answered \${r.status}, expected 201\`);
    ids.push((r.json() as {id: string}).id);
  }
  const rows = await ctx.db.execute('SELECT message_id, content FROM messages ORDER BY message_id DESC LIMIT 3');
  assert.deepEqual(rows.map(row => row.message_id), [...ids].reverse(), \`every message must be stored (store_message), the newest rows are \${JSON.stringify(rows.map(row => row.content))}\`);
  const produced = ctx.kafka.records('message-events');
  assert(produced.length === 3 && produced.every(rec => rec.key?.toString() === String(CHANNEL)), \`every stored message must be published once, keyed by the channel; produced \${JSON.stringify(produced.map(rec => [rec.key?.toString() ?? null, rec.offset]))}\`);
  assert.equal(ctx.redis.llen(KEY), 100, \`99 cached + 3 pushed must be trimmed to 100 (LTRIM 0 99), the list holds \${ctx.redis.llen(KEY)}\`);
  const head = ctx.redis.lrange(KEY, 0, 2).map(x => JSON.parse(x));
  assert.deepEqual(head, [{id: ids[2], author_id: '7', content: 'third'}, {id: ids[1], author_id: '7', content: 'second'}, {id: ids[0], author_id: '7', content: 'first'}], \`the three posts must sit at the head of the list, newest first, as {id, author_id, content}: \${JSON.stringify(head)}\`);
  assert.deepEqual(ctx.redis.lrange(KEY, -1, -1).map(x => JSON.parse(x)), [entries[96]], 'the two oldest cached entries must have been trimmed away');
  const {page, reads} = await get(m, ctx, {limit: 50});
  assert(reads.none(), \`the newest page is in the list now, yet the read cost \${reads}\`);
  assert(JSON.stringify(page.slice(0, 3)) === JSON.stringify(head) && JSON.stringify(page.slice(3)) === JSON.stringify(entries.slice(0, 47)), 'the newest page comes from the list and starts with the messages just posted');
}

export async function check_ttl(ctx) {
  const {m} = await api(ctx);
  const r = await post(m, ctx, 'hello');
  assert.equal(r.status, 201, \`POST answered \${r.status}\`);
  const ttl = ctx.redis.ttl(KEY);
  assert(ttl > 0, \`\${KEY} has no expiry (TTL \${ttl}): quiet channels would stay in memory forever\`);
  assert(290 <= ttl && ttl <= 300, \`\${KEY} expires in \${ttl} s, expected 300\`);
  ctx.clock.advance(200);
  await post(m, ctx, 'again');
  assert(ctx.redis.ttl(KEY) > 250, \`a new message must re-arm the expiry, 200 s later the TTL is \${ctx.redis.ttl(KEY)} s\`);
  ctx.clock.advance(301);
  assert.equal(ctx.redis.exists(KEY), 0, \`\${KEY} must be gone 300 s after the last message\`);
  const {page, reads} = await get(m, ctx, {limit: 50});
  assert.equal(reads.calls().length, 1, \`once the list expired the newest page comes from the data service again, it was called \${reads.calls().length} time(s)\`);
  assert.deepEqual(page.map(x => x.content), ['again', 'hello'], \`the page after expiry is read from Postgres: again, hello — got \${JSON.stringify(page.map(x => x.content))}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"discord/db"
	pb "discord/gen/messages"
	"leetbuild/harness"
)

const (
	hcEpoch    int64 = 1420070400000
	hcBucketMs int64 = 10 * 24 * 3600 * 1000
	hcInsert         = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)"
)

var hcInstances = []string{"data-1:9000", "data-2:9000", "data-3:9000"}

func hcSnowflake(bucket, offsetMs int64) int64 {
	return ((bucket*hcBucketMs + offsetMs) << 22) | (1 << 17)
}

// hcPeer is step 3's data service: the page walk over Postgres behind MessageData.GetMessages.
type hcPeer struct {
	pb.UnimplementedMessageDataServer
}

func (p *hcPeer) GetMessages(ctx context.Context, req *pb.GetMessagesRequest) (*pb.GetMessagesReply, error) {
	channel, before, limit := int64(req.GetChannelId()), int64(req.GetBefore()), int(req.GetLimit())
	reply := &pb.GetMessagesReply{}
	for bucket := (before >> 22) / hcBucketMs; len(reply.Messages) < limit && bucket >= (channel>>22)/hcBucketMs; bucket-- {
		rows, err := db.Query(ctx, "SELECT message_id, author_id, content FROM messages"+
			" WHERE channel_id = $1 AND bucket = $2 AND message_id < $3 ORDER BY message_id DESC LIMIT $4",
			channel, bucket, before, limit-len(reply.Messages))
		if err != nil {
			return nil, status.Error(codes.Unavailable, "messages store: "+err.Error())
		}
		for rows.Next() {
			var id, author int64
			var content string
			rows.Scan(&id, &author, &content)
			reply.Messages = append(reply.Messages, &pb.Message{Id: uint64(id), AuthorId: uint64(author), Content: content})
		}
		rows.Close()
	}
	return reply, nil
}

// hcWorld is the API over the real stack: Postgres, step 3's data service at every instance, the
// neighbours of steps 1, 2, 4 and 5 as they were built there.
type hcWorld struct {
	ctx     *harness.Ctx
	nowB    int64
	channel int64 // created last bucket
	key     string
	entries []entry // the stored messages, newest first
	http    *harness.HTTP
	stub    pb.MessageDataClient
	lastMs  int64
	seq     int64
}

// newHotWorld stores stored messages of the channel (db0 the oldest), leaves the newest cached of
// them in recent:{channel} as POST would have, and starts the API.
func newHotWorld(ctx *harness.Ctx, stored, cached int) *hcWorld {
	nowB := (time.Now().UnixMilli() - hcEpoch) / hcBucketMs
	w := &hcWorld{ctx: ctx, nowB: nowB, channel: hcSnowflake(nowB-1, 5000)}
	w.key = "recent:" + strconv.FormatInt(w.channel, 10)
	ctx.DB.Reset(db.Schema)
	for i := range stored {
		mid := hcSnowflake(nowB-1, int64(10000+1000*i))
		content := fmt.Sprintf("db%d", i)
		ctx.DB.Exec(hcInsert, w.channel, nowB-1, mid, 7, content)
		w.entries = append([]entry{{ID: strconv.FormatInt(mid, 10), AuthorID: "7", Content: content}}, w.entries...)
	}
	if cached > 0 {
		args := []any{"RPUSH", w.key}
		for _, e := range w.entries[:cached] {
			args = append(args, hcJSON(e))
		}
		ctx.Redis.Do(args...)
	}
	for _, node := range hcInstances {
		pb.RegisterMessageDataServer(ctx.GRPC.Server(node), &hcPeer{})
	}
	conn, err := grpc.NewClient(hcInstances[0], grpc.WithTransportCredentials(insecure.NewCredentials()))
	ctx.NoError(err, "dialing the data service")
	w.stub = pb.NewMessageDataClient(conn)
	validContent = func(content string) bool {
		return strings.TrimSpace(content) != "" && utf8.RuneCountInString(content) <= 2000
	}
	storeMessage = w.store
	latestSnowflake = func() int64 { return (time.Now().UnixMilli() + 1 - hcEpoch) << 22 }
	fetchMessages = w.fetch
	publish = w.publish
	w.http = ctx.Main(main).HTTP()
	return w
}

func hcJSON(e entry) string {
	b, _ := json.Marshal(e)
	return string(b)
}

// store is step 1's storeMessage: a snowflake minted now, its bucket, one row.
func (w *hcWorld) store(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	nowMs := time.Now().UnixMilli()
	if nowMs <= w.lastMs {
		nowMs = w.lastMs
		w.seq = (w.seq + 1) & 0xFFF
		if w.seq == 0 {
			nowMs++
		}
	} else {
		w.seq = 0
	}
	w.lastMs = nowMs
	id := (nowMs-hcEpoch)<<22 | 1<<17 | w.seq
	bucket := int32((id >> 22) / hcBucketMs)
	if err := db.Exec(ctx, hcInsert, channelID, bucket, id, authorID, content); err != nil {
		return message{}, err
	}
	return message{ID: strconv.FormatInt(id, 10), ChannelID: strconv.FormatInt(channelID, 10), AuthorID: strconv.FormatInt(authorID, 10),
		Content: content, Bucket: bucket}, nil
}

// fetch is step 4's fetchMessages: GetMessages on the data service under a 300 ms deadline.
func (w *hcWorld) fetch(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	callCtx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	reply, err := w.stub.GetMessages(callCtx, &pb.GetMessagesRequest{ChannelId: uint64(channelID), Before: uint64(before), Limit: uint32(limit)})
	if err != nil {
		return nil, err
	}
	return reply.GetMessages(), nil
}

// publish is step 5's: one message.created record keyed by the channel.
func (w *hcWorld) publish(_ context.Context, msg message) {
	value, _ := json.Marshal(map[string]string{"type": "message.created", "channel_id": msg.ChannelID, "id": msg.ID,
		"author_id": msg.AuthorID, "content": msg.Content})
	w.ctx.Kafka.Seed("message-events", msg.ChannelID, string(value))
}

// maps is entries as the JSON the API answers.
func hcMaps(entries []entry) []map[string]any {
	out := []map[string]any{}
	for _, e := range entries {
		out = append(out, map[string]any{"id": e.ID, "author_id": e.AuthorID, "content": e.Content})
	}
	return out
}

// hcReads is what reached the data path since it was made: GetMessages calls and Postgres SELECTs.
type hcReads struct {
	ctx         *harness.Ctx
	callsFrom   int
	queriesFrom int
}

func (rd *hcReads) calls() []harness.Call { return rd.ctx.GRPC.CallsTo("GetMessages", "")[rd.callsFrom:] }

func (rd *hcReads) selects() int {
	n := 0
	for _, q := range rd.ctx.DB.Queries()[rd.queriesFrom:] {
		if strings.HasPrefix(strings.ToLower(strings.Join(strings.Fields(q.SQL), " ")), "select") {
			n++
		}
	}
	return n
}

func (rd *hcReads) none() bool { return len(rd.calls()) == 0 && rd.selects() == 0 }

func (rd *hcReads) String() string {
	return fmt.Sprintf("%d GetMessages call(s) and %d SELECT(s) on Postgres", len(rd.calls()), rd.selects())
}

func hcRequest(call harness.Call) *pb.GetMessagesRequest {
	req, _ := call.Request.(*pb.GetMessagesRequest)
	if req == nil {
		req = &pb.GetMessagesRequest{}
	}
	return req
}

func (w *hcWorld) path(params url.Values) string {
	path := "/channels/" + strconv.FormatInt(w.channel, 10) + "/messages"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}
	return path
}

// get is one GET that must answer 200: its page and what it cost the data path.
func (w *hcWorld) get(params url.Values) ([]map[string]any, *hcReads) {
	reads := &hcReads{ctx: w.ctx, callsFrom: len(w.ctx.GRPC.CallsTo("GetMessages", "")), queriesFrom: len(w.ctx.DB.Queries())}
	r := w.http.Get(w.path(params))
	text := strings.TrimSpace(r.Text())
	if len(text) > 120 {
		text = text[:120]
	}
	w.ctx.Equal(r.Status, 200, "GET answered %s", text)
	var page []map[string]any
	r.Decode(&page)
	return page, reads
}

func (w *hcWorld) post(content string) *harness.Response {
	return w.http.Post(w.path(nil), map[string]any{"author_id": 7, "content": content})
}

func hcLimit(limit int, pairs ...string) url.Values {
	q := url.Values{"limit": {strconv.Itoa(limit)}}
	for i := 0; i+1 < len(pairs); i += 2 {
		q.Set(pairs[i], pairs[i+1])
	}
	return q
}

func hcContents(page []map[string]any) []any {
	out := []any{}
	for _, m := range page {
		out = append(out, m["content"])
	}
	return out
}

func CheckCacheRead(ctx *harness.Ctx) {
	w := newHotWorld(ctx, 60, 60)
	page, reads := w.get(hcLimit(50))
	ctx.Equal(page, hcMaps(w.entries[:50]), "with 60 cached entries limit=50 must be the first 50 of the list, newest first")
	ctx.Assert(reads.none(), "the page was in the list, yet the read cost %s: a cache hit touches neither the data service nor the database", reads.String())
	page, reads = w.get(nil)
	ctx.Assert(len(page) == 50 && reads.none(), "without ?limit the default page of 50 comes from the list too; got %d entries for %s", len(page), reads.String())
	page, reads = w.get(hcLimit(60))
	ctx.Assert(fmt.Sprint(page) == fmt.Sprint(hcMaps(w.entries)) && reads.none(), "limit=60 is covered by 60 entries: the whole list, no data path; got %d entries for %s", len(page), reads.String())
	for _, bad := range []int{0, 101} {
		r := w.http.Get(w.path(hcLimit(bad)))
		ctx.Equal(r.Status, 400, "limit=%d is outside 1..100", bad)
	}
}

func CheckFullPageOnly(ctx *harness.Ctx) {
	w := newHotWorld(ctx, 12, 10)
	page, reads := w.get(hcLimit(50))
	calls := reads.calls()
	ctx.Equal(len(calls), 1, "10 cached entries cannot answer a page of 50: the data service must be asked once; times asked")
	req := hcRequest(calls[0])
	ctx.Assert(req.GetChannelId() == uint64(w.channel) && req.GetLimit() == 50, "the fallback must ask for this channel and limit, asked %v", calls[0].Request)
	ctx.Equal(page, hcMaps(w.entries), "the list holds only 10 of the channel's 12 messages: the page must be all 12 from the data service")
	cachedJSON := []string{}
	for _, e := range w.entries[:10] {
		cachedJSON = append(cachedJSON, hcJSON(e))
	}
	ctx.Equal(ctx.Redis.LRange(w.key, 0, -1), cachedJSON, "reads never write the list: after the fallback it must hold exactly the 10 entries POST left there")
	page, reads = w.get(hcLimit(10))
	ctx.Assert(reads.none(), "10 cached entries do answer a page of 10, yet the read cost %s", reads.String())
	ctx.Equal(page, hcMaps(w.entries[:10]), "limit=10 must be served from the list")
	page, reads = w.get(hcLimit(5, "before", w.entries[7].ID))
	calls = reads.calls()
	ctx.Equal(len(calls), 1, "a request with ?before is never the newest page: it must go to the data service even though the list holds enough entries; calls")
	ctx.Equal(strconv.FormatUint(hcRequest(calls[0]).GetBefore(), 10), w.entries[7].ID, "the before cursor must be passed through to the data service")
	ctx.Equal(page, hcMaps(w.entries[8:]), "the page older than db4 is db3..db0 from the data service")
}

func CheckFallback(ctx *harness.Ctx) {
	w := newHotWorld(ctx, 3, 0)
	page, reads := w.get(hcLimit(50))
	calls := reads.calls()
	ctx.Equal(len(calls), 1, "an empty list must fall back to the data service once; calls")
	newest, _ := strconv.ParseUint(w.entries[0].ID, 10, 64)
	ctx.Assert(hcRequest(calls[0]).GetBefore() > newest, "without ?before the fallback must pass latestSnowflake(), an id newer than anything stored; it passed %d", hcRequest(calls[0]).GetBefore())
	ctx.Assert(reads.selects() > 0, "the fallback page must come from Postgres through the data service, no query reached it")
	ctx.Equal(page, hcMaps(w.entries), "the data service's messages must be answered as {id, author_id, content} with string ids, newest first")
	ctx.Equal(ctx.Redis.Exists(w.key), 0, "reads never fill the list: it is written only by POST, otherwise an old page could shadow a newer message")
	page, reads = w.get(hcLimit(50))
	ctx.Equal(len(reads.calls()), 1, "a second miss is a second data-service call (nothing was cached by the read); calls")
	ctx.Assert(fmt.Sprint(page) == fmt.Sprint(hcMaps(w.entries)) && ctx.Redis.Exists(w.key) == 0, "the second miss answers the same page and still leaves the list alone")
}

func CheckWriteThrough(ctx *harness.Ctx) {
	w := newHotWorld(ctx, 99, 99)
	r := w.post("")
	ctx.Equal(r.Status, 400, "empty content must be a 400")
	ctx.Equal(ctx.Redis.LLen(w.key), 99, "a rejected message must not touch the list")
	ids := []string{}
	for _, content := range []string{"first", "second", "third"} {
		r = w.post(content)
		ctx.Equal(r.Status, 201, "POST %q", content)
		var created struct {
			ID string \`json:"id"\`
		}
		r.Decode(&created)
		ids = append(ids, created.ID)
	}
	rows := ctx.DB.Query("SELECT message_id, content FROM messages ORDER BY message_id DESC LIMIT 3")
	newest := []any{}
	contents := []any{}
	for _, row := range rows {
		newest = append(newest, fmt.Sprint(row["message_id"]))
		contents = append(contents, row["content"])
	}
	ctx.Equal(newest, []any{ids[2], ids[1], ids[0]}, "every message must be stored (storeMessage), the newest rows are %v", contents)
	produced := ctx.Kafka.Records("message-events")
	keyed := len(produced) == 3
	for _, rec := range produced {
		keyed = keyed && string(rec.Key) == strconv.FormatInt(w.channel, 10)
	}
	ctx.Assert(keyed, "every stored message must be published once, keyed by the channel; produced keys %v", ctx.Kafka.Keys("message-events"))
	ctx.Equal(ctx.Redis.LLen(w.key), 100, "99 cached + 3 pushed must be trimmed to 100 (LTRIM 0 99): list length")
	head := []map[string]any{}
	for _, item := range ctx.Redis.LRange(w.key, 0, 2) {
		var m map[string]any
		json.Unmarshal([]byte(item), &m)
		head = append(head, m)
	}
	want := hcMaps([]entry{{ids[2], "7", "third"}, {ids[1], "7", "second"}, {ids[0], "7", "first"}})
	ctx.Equal(head, want, "the three posts must sit at the head of the list, newest first, as {id, author_id, content}")
	tail := []map[string]any{}
	for _, item := range ctx.Redis.LRange(w.key, -1, -1) {
		var m map[string]any
		json.Unmarshal([]byte(item), &m)
		tail = append(tail, m)
	}
	ctx.Equal(tail, hcMaps(w.entries[96:97]), "the two oldest cached entries must have been trimmed away")
	page, reads := w.get(hcLimit(50))
	ctx.Assert(reads.none(), "the newest page is in the list now, yet the read cost %s", reads.String())
	ctx.Assert(len(page) == 50 && fmt.Sprint(page[:3]) == fmt.Sprint(head) && fmt.Sprint(page[3:]) == fmt.Sprint(hcMaps(w.entries[:47])), "the newest page comes from the list and starts with the messages just posted")
}

func CheckTtl(ctx *harness.Ctx) {
	w := newHotWorld(ctx, 0, 0)
	r := w.post("hello")
	ctx.Equal(r.Status, 201, "POST")
	ttl := ctx.Redis.TTL(w.key)
	ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): quiet channels would stay in memory forever", w.key, ttl)
	ctx.Assert(290 <= ttl && ttl <= 300, "%s expires in %d s, expected 300", w.key, ttl)
	ctx.Clock.Advance(200)
	w.post("again")
	ctx.Assert(ctx.Redis.TTL(w.key) > 250, "a new message must re-arm the expiry, 200 s later the TTL is %d s", ctx.Redis.TTL(w.key))
	ctx.Clock.Advance(301)
	ctx.Equal(ctx.Redis.Exists(w.key), 0, "%s must be gone 300 s after the last message", w.key)
	page, reads := w.get(hcLimit(50))
	ctx.Equal(len(reads.calls()), 1, "once the list expired the newest page comes from the data service again; calls")
	ctx.Equal(hcContents(page), []any{"again", "hello"}, "the page after expiry is read from Postgres: again, hello")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "db.h"
#include "messages.grpc.pb.h"

namespace {

constexpr int64_t hcEpoch = 1420070400000LL;
constexpr int64_t hcBucketMs = 10LL * 24 * 3600 * 1000;
const std::string hcInsert = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)";

const std::vector<std::string> hcInstances = {"data-1:9000", "data-2:9000", "data-3:9000"};

int64_t hcSnowflake(int64_t bucket, int64_t offsetMs) { return ((bucket * hcBucketMs + offsetMs) << 22) | (1 << 17); }

int64_t hcNowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// hcPeer is step 3's data service: the page walk over Postgres behind MessageData.GetMessages.
class hcPeer final : public discord::MessageData::Service {
 public:
  grpc::Status GetMessages(grpc::ServerContext*, const discord::GetMessagesRequest* req, discord::GetMessagesReply* reply) override {
    const int64_t channel = static_cast<int64_t>(req->channel_id()), before = static_cast<int64_t>(req->before());
    const int limit = static_cast<int>(req->limit());
    try {
      for (int64_t bucket = (before >> 22) / hcBucketMs; reply->messages_size() < limit && bucket >= (channel >> 22) / hcBucketMs; bucket--) {
        const auto rows = db::exec("SELECT message_id, author_id, content FROM messages"
                                   " WHERE channel_id = $1 AND bucket = $2 AND message_id < $3 ORDER BY message_id DESC LIMIT $4",
                                   channel, bucket, before, limit - reply->messages_size());
        for (const auto& row : rows) {
          auto* m = reply->add_messages();
          m->set_id(static_cast<uint64_t>(row[0].as<int64_t>()));
          m->set_author_id(static_cast<uint64_t>(row[1].as<int64_t>()));
          m->set_content(row[2].as<std::string>());
        }
      }
    } catch (const std::exception& e) {
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, std::string("messages store: ") + e.what());
    }
    return grpc::Status::OK;
  }
};

// entry is one message as the API answers it (and as the list holds it).
struct entry {
  std::string id, author_id, content;
};

// hcJSON is the entry as Go's json.Marshal of the struct writes it: fields in declaration order
// (nlohmann would sort the keys), so the list holds exactly what POST would have pushed.
std::string hcJSON(const entry& e) {
  return "{\\"id\\":" + nlohmann::json(e.id).dump() + ",\\"author_id\\":" + nlohmann::json(e.author_id).dump() +
         ",\\"content\\":" + nlohmann::json(e.content).dump() + "}";
}

// hcMaps is entries as the JSON the API answers.
std::vector<std::map<std::string, std::string>> hcMaps(const std::vector<entry>& entries) {
  std::vector<std::map<std::string, std::string>> out;
  for (const auto& e : entries) out.push_back({{"id", e.id}, {"author_id", e.author_id}, {"content", e.content}});
  return out;
}

std::vector<entry> hcSlice(const std::vector<entry>& v, size_t from, size_t to) {
  return std::vector<entry>(v.begin() + static_cast<long>(from), v.begin() + static_cast<long>(std::min(to, v.size())));
}

// hcReads is what reached the data path since it was made: GetMessages calls and Postgres SELECTs.
struct hcReads {
  harness::Ctx* ctx;
  size_t callsFrom;
  size_t queriesFrom;

  std::vector<harness::Call> calls() const {
    auto all = ctx->GRPC.CallsTo("GetMessages", "");
    return std::vector<harness::Call>(all.begin() + static_cast<long>(std::min(callsFrom, all.size())), all.end());
  }

  int selects() const {
    int n = 0;
    const auto queries = ctx->DB.Queries();
    for (size_t i = queriesFrom; i < queries.size(); i++) {
      std::istringstream words(queries[i].SQL);
      std::string text, word;
      while (words >> word) text += (text.empty() ? "" : " ") + word;
      for (char& ch : text) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
      if (text.rfind("select", 0) == 0) n++;
    }
    return n;
  }

  bool none() const { return calls().empty() && selects() == 0; }

  std::string String() const { return harness::Sprintf("%d GetMessages call(s) and %d SELECT(s) on Postgres", calls().size(), selects()); }
};

discord::GetMessagesRequest hcRequest(const harness::Call& call) { return call.Request<discord::GetMessagesRequest>(); }

// Query parameters, encoded sorted by key as Go's url.Values.Encode does.
using Params = std::map<std::string, std::string>;

Params hcLimit(int limit, const std::vector<std::string>& pairs = {}) {
  Params q{{"limit", std::to_string(limit)}};
  for (size_t i = 0; i + 1 < pairs.size(); i += 2) q[pairs[i]] = pairs[i + 1];
  return q;
}

std::vector<harness::Any> hcContents(const harness::Any& page) {
  std::vector<harness::Any> out;
  for (const auto& m : page.Items()) out.push_back(m["content"]);
  return out;
}

// hcWorld is the API over the real stack: Postgres, step 3's data service at every instance, the
// neighbours of steps 1, 2, 4 and 5 as they were built there.
struct hcWorld {
  harness::Ctx* ctx;
  int64_t nowB;
  int64_t channel;  // created last bucket
  std::string key;
  std::vector<entry> entries;  // the stored messages, newest first
  std::optional<harness::HTTP> http;
  std::unique_ptr<discord::MessageData::Stub> stub;
  int64_t lastMs = 0;
  int64_t seq = 0;

  // store is step 1's store_message: a snowflake minted now, its bucket, one row.
  nlohmann::json store(int64_t channelID, int64_t authorID, const std::string& content) {
    int64_t nowMs = hcNowMs();
    if (nowMs <= lastMs) {
      nowMs = lastMs;
      seq = (seq + 1) & 0xFFF;
      if (seq == 0) nowMs++;
    } else {
      seq = 0;
    }
    lastMs = nowMs;
    const int64_t id = ((nowMs - hcEpoch) << 22) | (1 << 17) | seq;
    const int32_t bucket = static_cast<int32_t>((id >> 22) / hcBucketMs);
    db::exec(hcInsert, channelID, bucket, id, authorID, content);
    return nlohmann::json{{"id", std::to_string(id)},
                          {"channel_id", std::to_string(channelID)},
                          {"author_id", std::to_string(authorID)},
                          {"content", content},
                          {"bucket", bucket}};
  }

  // fetch is step 4's fetch_messages: GetMessages on the data service under a 300 ms deadline.
  // Go returns the error; step 4's C++ fetch_messages throws it.
  std::vector<discord::Message> fetch(int64_t channelID, int64_t before, int limit) {
    grpc::ClientContext callCtx;
    callCtx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(300));
    discord::GetMessagesRequest req;
    req.set_channel_id(static_cast<uint64_t>(channelID));
    req.set_before(static_cast<uint64_t>(before));
    req.set_limit(static_cast<uint32_t>(limit));
    discord::GetMessagesReply reply;
    const grpc::Status status = stub->GetMessages(&callCtx, req, &reply);
    if (!status.ok()) throw std::runtime_error("data service: " + status.error_message());
    return std::vector<discord::Message>(reply.messages().begin(), reply.messages().end());
  }

  // publish is step 5's: one message.created record keyed by the channel.
  void publish(const nlohmann::json& msg) {
    const nlohmann::json value{{"type", "message.created"}, {"channel_id", msg["channel_id"]}, {"id", msg["id"]},
                               {"author_id", msg["author_id"]}, {"content", msg["content"]}};
    ctx->Kafka.Seed("message-events", msg["channel_id"].get<std::string>(), value.dump());
  }

  std::string path(const Params& params = {}) const {
    std::string p = "/channels/" + std::to_string(channel) + "/messages";
    bool first = true;
    for (const auto& [k, v] : params) {
      p += (first ? "?" : "&") + k + "=" + v;
      first = false;
    }
    return p;
  }

  // get is one GET that must answer 200: its page and what it cost the data path.
  std::pair<harness::Any, hcReads> get(const Params& params = {}) {
    hcReads reads{ctx, ctx->GRPC.CallsTo("GetMessages", "").size(), ctx->DB.Queries().size()};
    const auto r = http->Get(path(params));
    std::string text = r.Text();
    const auto start = text.find_first_not_of(" \\t\\r\\n");
    text.erase(0, start == std::string::npos ? text.size() : start);
    text.erase(text.find_last_not_of(" \\t\\r\\n") + 1);
    if (text.size() > 120) text = text.substr(0, 120);
    ctx->Equal(r.Status, 200, "GET answered %s", text);
    const auto page = harness::ParseJSON(r.Text());
    if (!page || !(page->IsArray() || page->IsNil())) ctx->Fatalf("the response body does not decode into []map[string]interface {}: %q", r.Text().substr(0, 200));
    return {*page, reads};
  }

  harness::Response post(const std::string& content) {
    return http->Post(path(), nlohmann::json{{"author_id", 7}, {"content", content}}.dump(), "Content-Type", "application/json");
  }
};

hcWorld* hcCurrent = nullptr;

// newHotWorld stores stored messages of the channel (db0 the oldest), leaves the newest cached of
// them in recent:{channel} as POST would have, and starts the API.
std::unique_ptr<hcWorld> newHotWorld(harness::Ctx& ctx, int stored, int cached) {
  const int64_t nowB = (ctx.Clock.Now() - hcEpoch) / hcBucketMs;
  auto w = std::make_unique<hcWorld>();
  w->ctx = &ctx;
  w->nowB = nowB;
  w->channel = hcSnowflake(nowB - 1, 5000);
  w->key = "recent:" + std::to_string(w->channel);
  ctx.DB.Reset(db::kSchema);
  for (int i = 0; i < stored; i++) {
    const int64_t mid = hcSnowflake(nowB - 1, 10000 + 1000LL * i);
    const std::string content = "db" + std::to_string(i);
    ctx.DB.Exec(hcInsert, w->channel, nowB - 1, mid, 7, content);
    w->entries.insert(w->entries.begin(), entry{std::to_string(mid), "7", content});
  }
  if (cached > 0) {
    std::vector<std::string> args = {"RPUSH", w->key};
    for (int i = 0; i < cached; i++) args.push_back(hcJSON(w->entries[i]));
    ctx.Redis.Must(args);
  }
  for (const auto& node : hcInstances) ctx.GRPC.Server(node)->RegisterService(new hcPeer());
  // The API's own client (Go's grpc.NewClient): its calls are the learner's, not the harness's.
  w->stub = discord::MessageData::NewStub(grpc::CreateChannel(hcInstances[0], grpc::InsecureChannelCredentials()));
  hcCurrent = w.get();
  w->http = ctx.Main().HTTP();
  return w;
}

}  // namespace

// The neighbours the step's file declares, as steps 1, 2, 4 and 5 built them.
bool valid_content(const std::string& content) {
  const bool blank = std::all_of(content.begin(), content.end(), [](char c) { return std::isspace(static_cast<unsigned char>(c)) != 0; });
  // utf8.RuneCountInString: every byte that does not continue a sequence starts a rune.
  const auto runes = std::count_if(content.begin(), content.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; });
  return !blank && runes <= 2000;
}

nlohmann::json store_message(int64_t channel_id, int64_t author_id, const std::string& content) {
  return hcCurrent->store(channel_id, author_id, content);
}

int64_t latest_snowflake() { return (hcNowMs() + 1 - hcEpoch) << 22; }

std::vector<discord::Message> fetch_messages(int64_t channel_id, int64_t before, int limit) {
  return hcCurrent->fetch(channel_id, before, limit);
}

void publish(const nlohmann::json& message) { hcCurrent->publish(message); }

void CheckCacheRead(harness::Ctx& ctx) {
  auto w = newHotWorld(ctx, 60, 60);
  auto [page, reads] = w->get(hcLimit(50));
  ctx.Equal(page, hcMaps(hcSlice(w->entries, 0, 50)), "with 60 cached entries limit=50 must be the first 50 of the list, newest first");
  ctx.Assert(reads.none(), "the page was in the list, yet the read cost %s: a cache hit touches neither the data service nor the database", reads.String());
  std::tie(page, reads) = w->get();
  ctx.Assert(page.Len() == 50 && reads.none(), "without ?limit the default page of 50 comes from the list too; got %d entries for %s", page.Len(), reads.String());
  std::tie(page, reads) = w->get(hcLimit(60));
  ctx.Assert(harness::Same(page, hcMaps(w->entries)) && reads.none(), "limit=60 is covered by 60 entries: the whole list, no data path; got %d entries for %s", page.Len(), reads.String());
  for (const int bad : {0, 101}) {
    const auto r = w->http->Get(w->path(hcLimit(bad)));
    ctx.Equal(r.Status, 400, "limit=%d is outside 1..100", bad);
  }
}

void CheckFullPageOnly(harness::Ctx& ctx) {
  auto w = newHotWorld(ctx, 12, 10);
  auto [page, reads] = w->get(hcLimit(50));
  auto calls = reads.calls();
  ctx.Equal(calls.size(), 1, "10 cached entries cannot answer a page of 50: the data service must be asked once; times asked");
  const auto req = hcRequest(calls[0]);
  ctx.Assert(req.channel_id() == static_cast<uint64_t>(w->channel) && req.limit() == 50, "the fallback must ask for this channel and limit, asked %v", req.ShortDebugString());
  ctx.Equal(page, hcMaps(w->entries), "the list holds only 10 of the channel's 12 messages: the page must be all 12 from the data service");
  std::vector<std::string> cachedJSON;
  for (const auto& e : hcSlice(w->entries, 0, 10)) cachedJSON.push_back(hcJSON(e));
  ctx.Equal(ctx.Redis.LRange(w->key, 0, -1), cachedJSON, "reads never write the list: after the fallback it must hold exactly the 10 entries POST left there");
  std::tie(page, reads) = w->get(hcLimit(10));
  ctx.Assert(reads.none(), "10 cached entries do answer a page of 10, yet the read cost %s", reads.String());
  ctx.Equal(page, hcMaps(hcSlice(w->entries, 0, 10)), "limit=10 must be served from the list");
  std::tie(page, reads) = w->get(hcLimit(5, {"before", w->entries[7].id}));
  calls = reads.calls();
  ctx.Equal(calls.size(), 1, "a request with ?before is never the newest page: it must go to the data service even though the list holds enough entries; calls");
  ctx.Equal(std::to_string(hcRequest(calls[0]).before()), w->entries[7].id, "the before cursor must be passed through to the data service");
  ctx.Equal(page, hcMaps(hcSlice(w->entries, 8, w->entries.size())), "the page older than db4 is db3..db0 from the data service");
}

void CheckFallback(harness::Ctx& ctx) {
  auto w = newHotWorld(ctx, 3, 0);
  auto [page, reads] = w->get(hcLimit(50));
  auto calls = reads.calls();
  ctx.Equal(calls.size(), 1, "an empty list must fall back to the data service once; calls");
  const uint64_t newest = std::stoull(w->entries[0].id);
  ctx.Assert(hcRequest(calls[0]).before() > newest, "without ?before the fallback must pass latestSnowflake(), an id newer than anything stored; it passed %d", hcRequest(calls[0]).before());
  ctx.Assert(reads.selects() > 0, "the fallback page must come from Postgres through the data service, no query reached it");
  ctx.Equal(page, hcMaps(w->entries), "the data service's messages must be answered as {id, author_id, content} with string ids, newest first");
  ctx.Equal(ctx.Redis.Exists(w->key), 0, "reads never fill the list: it is written only by POST, otherwise an old page could shadow a newer message");
  std::tie(page, reads) = w->get(hcLimit(50));
  ctx.Equal(reads.calls().size(), 1, "a second miss is a second data-service call (nothing was cached by the read); calls");
  ctx.Assert(harness::Same(page, hcMaps(w->entries)) && ctx.Redis.Exists(w->key) == 0, "the second miss answers the same page and still leaves the list alone");
}

void CheckWriteThrough(harness::Ctx& ctx) {
  auto w = newHotWorld(ctx, 99, 99);
  auto r = w->post("");
  ctx.Equal(r.Status, 400, "empty content must be a 400");
  ctx.Equal(ctx.Redis.LLen(w->key), 99, "a rejected message must not touch the list");
  std::vector<std::string> ids;
  for (const std::string content : {"first", "second", "third"}) {
    r = w->post(content);
    ctx.Equal(r.Status, 201, "POST %q", content);
    const auto created = harness::ParseJSON(r.Text());
    ids.push_back(created ? (*created)["id"].String() : "");
  }
  const auto rows = ctx.DB.Query("SELECT message_id, content FROM messages ORDER BY message_id DESC LIMIT 3");
  std::vector<std::string> newest;
  std::vector<harness::Any> contents;
  for (const auto& row : rows) {
    newest.push_back(harness::Sprintf("%v", row.at("message_id")));
    contents.push_back(row.at("content"));
  }
  ctx.Equal(newest, std::vector<std::string>{ids[2], ids[1], ids[0]}, "every message must be stored (storeMessage), the newest rows are %v", contents);
  const auto produced = ctx.Kafka.Records("message-events");
  bool keyed = produced.size() == 3;
  for (const auto& rec : produced) keyed = keyed && rec.Key.value_or("") == std::to_string(w->channel);
  ctx.Assert(keyed, "every stored message must be published once, keyed by the channel; produced keys %v", ctx.Kafka.Keys("message-events"));
  ctx.Equal(ctx.Redis.LLen(w->key), 100, "99 cached + 3 pushed must be trimmed to 100 (LTRIM 0 99): list length");
  std::vector<harness::Any> head;
  for (const auto& item : ctx.Redis.LRange(w->key, 0, 2)) head.push_back(harness::ParseJSON(item).value_or(harness::Any()));
  const auto want = hcMaps({{ids[2], "7", "third"}, {ids[1], "7", "second"}, {ids[0], "7", "first"}});
  ctx.Equal(head, want, "the three posts must sit at the head of the list, newest first, as {id, author_id, content}");
  std::vector<harness::Any> tail;
  for (const auto& item : ctx.Redis.LRange(w->key, -1, -1)) tail.push_back(harness::ParseJSON(item).value_or(harness::Any()));
  ctx.Equal(tail, hcMaps(hcSlice(w->entries, 96, 97)), "the two oldest cached entries must have been trimmed away");
  auto [page, reads] = w->get(hcLimit(50));
  ctx.Assert(reads.none(), "the newest page is in the list now, yet the read cost %s", reads.String());
  const auto& items = page.Items();
  ctx.Assert(items.size() == 50 && harness::Same(std::vector<harness::Any>(items.begin(), items.begin() + 3), head) &&
                 harness::Same(std::vector<harness::Any>(items.begin() + 3, items.end()), hcMaps(hcSlice(w->entries, 0, 47))),
             "the newest page comes from the list and starts with the messages just posted");
}

void CheckTtl(harness::Ctx& ctx) {
  auto w = newHotWorld(ctx, 0, 0);
  auto r = w->post("hello");
  ctx.Equal(r.Status, 201, "POST");
  const long long ttl = ctx.Redis.TTL(w->key);
  ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): quiet channels would stay in memory forever", w->key, ttl);
  ctx.Assert(290 <= ttl && ttl <= 300, "%s expires in %d s, expected 300", w->key, ttl);
  ctx.Clock.Advance(200);
  w->post("again");
  ctx.Assert(ctx.Redis.TTL(w->key) > 250, "a new message must re-arm the expiry, 200 s later the TTL is %d s", ctx.Redis.TTL(w->key));
  ctx.Clock.Advance(301);
  ctx.Equal(ctx.Redis.Exists(w->key), 0, "%s must be gone 300 s after the last message", w->key);
  auto [page, reads] = w->get(hcLimit(50));
  ctx.Equal(reads.calls().size(), 1, "once the list expired the newest page comes from the data service again; calls");
  ctx.Equal(hcContents(page), {"again", "hello"}, "the page after expiry is read from Postgres: again, hello");
}
`,
  },
  debrief: `The list is the cheapest cache in the system because it has exactly one writer and one shape: the request that stored the message pushes it, so the head of the list is the newest message by construction, and a read that finds a full page can trust it without a version or a timestamp. Refusing to answer from a short list is what keeps that trust — a list that holds 30 items says nothing about item 31, which may well exist in the database. Not filling on a miss is the same discipline from the other side: a read-populated list would race the write that happened between the database read and the push, and could shadow a newer message until the TTL rescued it. Write-through costs one pipeline per post, which is nothing next to the write itself, and the TTL only decides when a cold channel stops paying rent. Discord's note that they "do not want to have to cache messages in Redis" is about the database being fast enough for the long tail; the hot head of a popular channel is a different workload, and a bounded list per channel is the usual answer to it. Real systems invalidate the list on edits and deletes, store a compact encoding instead of JSON, and keep the per-channel hash from the previous step beside it so "is there anything new since id X" is one HGET.`,
};
