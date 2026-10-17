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

func validContent(content string) bool                                      { panic("not implemented") }
func storeMessage(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	panic("not implemented")
}
func latestSnowflake() int64                                                 { panic("not implemented") }
func fetchMessages(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	panic("not implemented")
}
func publish(ctx context.Context, msg message) { panic("not implemented") }

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

func validContent(content string) bool                                      { panic("not implemented") }
func storeMessage(ctx context.Context, channelID, authorID int64, content string) (message, error) {
	panic("not implemented")
}
func latestSnowflake() int64                                                 { panic("not implemented") }
func fetchMessages(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	panic("not implemented")
}
func publish(ctx context.Context, msg message) { panic("not implemented") }

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
  },
  debrief: `The list is the cheapest cache in the system because it has exactly one writer and one shape: the request that stored the message pushes it, so the head of the list is the newest message by construction, and a read that finds a full page can trust it without a version or a timestamp. Refusing to answer from a short list is what keeps that trust — a list that holds 30 items says nothing about item 31, which may well exist in the database. Not filling on a miss is the same discipline from the other side: a read-populated list would race the write that happened between the database read and the push, and could shadow a newer message until the TTL rescued it. Write-through costs one pipeline per post, which is nothing next to the write itself, and the TTL only decides when a cold channel stops paying rent. Discord's note that they "do not want to have to cache messages in Redis" is about the database being fast enough for the long tail; the hot head of a popular channel is a different workload, and a bounded list per channel is the usual answer to it. Real systems invalidate the list on edits and deletes, store a compact encoding instead of JSON, and keep the per-channel hash from the previous step beside it so "is there anything new since id X" is one HGET.`,
};
