import type {Step} from '@/lib/types';

export const postEndpointStep: Step = {
  id: 'post-endpoint',
  title: 'POST /posts and GET /feed',
  concept: 'http',
  file: 'post_api',
  focus: ['client', 'api'],
  task: `## Task

Implement the two handlers of the feed API. The authenticated user id arrives in the \`X-User-Id\`
header (the gateway sets it). Three things are provided: \`posts.save(post)\` stores the post (and dedupes
on its idempotency key), \`publish(post)\` hands it to Kafka (the fan-out worker of step 2 consumes it),
and \`timeline.read(user, cursor, limit)\` returns a page of post ids (you build it in step 3).

- \`POST /posts\` takes \`{"text": …, "media_ids": […]}\`. Empty text, text longer than **280** characters,
  or more than **4** media ids → **400**.
- The request must carry an **\`Idempotency-Key\`** header; without one → **400**. A client that retries
  a timed-out POST reuses the key, so a flaky network cannot post twice.
- Save, then publish, then answer **201** with \`{"post_id": …, "created_at": …}\` (milliseconds).
- \`GET /feed?cursor=<ms>&limit=<n>\`: \`limit\` defaults to 20 and must be **1–50** → otherwise **400**.
  Answer \`{"posts": […], "next_cursor": …}\` straight from \`timeline.read\`.
- Both responses are personal: send \`Cache-Control: private, no-store\` so no proxy or browser cache
  ever serves one user's feed to another.

:::widget status-codes {}

:::widget http-lifecycle {}`,
  sequence: {
    participants: ['App', 'feed-api', 'Kafka'],
    messages: [
      {from: 'App', to: 'feed-api', label: 'POST /posts · Idempotency-Key · {text}', kind: 'sync'},
      {from: 'feed-api', to: 'feed-api', label: 'validate · posts.save()', kind: 'sync'},
      {from: 'feed-api', to: 'Kafka', label: 'publish(post) → posts', kind: 'async'},
      {from: 'feed-api', to: 'App', label: '201 {post_id, created_at}', kind: 'reply'},
      {from: 'App', to: 'feed-api', label: 'GET /feed?limit=20', kind: 'sync'},
      {from: 'feed-api', to: 'App', label: '200 {posts, next_cursor} · private, no-store', kind: 'reply'},
    ],
  },
  hints: [
    'Order the checks by cost: body shape, then the header, then the write. A 400 should never reach `posts.save`.',
    'Publish *after* the save succeeded — a post that is in Kafka but not in the store would fan out an id nobody can hydrate.',
    'The cursor is optional and the limit has a default; validate the limit against the constants and pass both through to `timeline.read` unchanged.',
  ],
  checks: [
    {
      id: 'validate',
      title: 'Rejects bad posts with 400',
      detail:
        'Text longer than `MAX_TEXT` (280) or more than `MAX_MEDIA` (4) media ids must answer `400 Bad Request` before anything is saved.',
      match: {
        python: {
          all: [
            /len\([^\n]*\.text[^\n]*\)\s*>\s*(MAX_TEXT|280)/,
            /len\(\s*\w+\.media_ids\s*\)\s*>\s*(MAX_MEDIA|4)/,
            /status_code\s*=\s*400|HTTP_400/,
          ],
        },
        go: {
          all: [
            /\.Text\s*\)+\s*>\s*(maxText|280)/,
            /\.MediaIDs\s*\)\s*>\s*(maxMedia|4)/,
            /http\.StatusBadRequest|\b400\b/,
          ],
        },
        scala: {
          all: [
            /\.text\.(length|size)\s*>\s*(MaxText|280)/,
            /\.mediaIds\.(size|length)\s*>\s*(MaxMedia|4)/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {
          all: [
            /\btext\.(size|length)\(\)\s*>\s*(kMaxText|280)/,
            /media_ids\.size\(\)\s*>\s*(kMaxMedia|4)/,
            /status\s*=\s*400/,
          ],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Requires an Idempotency-Key header',
      detail:
        'Read the `Idempotency-Key` header and answer `400` when it is missing; the store dedupes on it so client retries cannot double-post.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/Idempotency-Key/i, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/Idempotency-Key/i, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/Idempotency-Key/i, /status\s*=\s*400/]},
      },
    },
    {
      id: 'created',
      title: 'Saves, publishes, then answers 201',
      detail: 'Call `posts.save`, then `publish`, then respond `201 Created` with `post_id` and `created_at`.',
      match: {
        python: {
          order: [/posts\.save\(/, /\bpublish\(\s*\w+\s*\)/, /status_code\s*=\s*201|HTTP_201/],
          all: [/post_id/, /created_at/],
        },
        go: {
          order: [/posts\.Save\(/, /events\.Publish\(/, /http\.StatusCreated|\b201\b/],
          all: [/post_id/, /created_at/],
        },
        scala: {
          order: [/Posts\.save\(/, /Events\.publish\(/, /StatusCodes\.Created|\b201\b/],
          all: [/post_id/, /created_at/],
        },
        cpp: {
          order: [/posts::save\(/, /events::publish\(/, /status\s*=\s*201|\b201\b/],
          all: [/post_id/, /created_at/],
        },
      },
    },
    {
      id: 'feed-limit',
      title: 'Rejects limit outside 1–50',
      detail: 'A page size of 0 or 500 is a bug or an abuse; check `limit` against `MAX_LIMIT` and answer `400`.',
      match: {
        python: {
          all: [
            /limit\s*<\s*1|limit\s*<=\s*0|1\s*<=\s*limit|0\s*<\s*limit/,
            /limit\s*>\s*(MAX_LIMIT|50)|limit\s*<=\s*(MAX_LIMIT|50)|(MAX_LIMIT|50)\s*<\s*limit/,
          ],
        },
        go: {
          all: [
            /limit\s*<\s*1|limit\s*<=\s*0|1\s*<=\s*limit|0\s*<\s*limit/,
            /limit\s*>\s*(maxLimit|50)|limit\s*<=\s*(maxLimit|50)|(maxLimit|50)\s*<\s*limit/,
          ],
        },
        scala: {
          all: [
            /limit\s*<\s*1|limit\s*<=\s*0|1\s*<=\s*limit|0\s*<\s*limit/,
            /limit\s*>\s*(MaxLimit|50)|limit\s*<=\s*(MaxLimit|50)|(MaxLimit|50)\s*<\s*limit/,
          ],
        },
        cpp: {
          all: [
            /limit\s*<\s*1|limit\s*<=\s*0|1\s*<=\s*limit|0\s*<\s*limit/,
            /limit\s*>\s*(kMaxLimit|50)|limit\s*<=\s*(kMaxLimit|50)|(kMaxLimit|50)\s*<\s*limit/,
          ],
        },
      },
    },
    {
      id: 'feed-response',
      title: 'Returns the page with next_cursor and no-store',
      detail:
        '`GET /feed` answers `{posts, next_cursor}` from `timeline.read` with `Cache-Control: private, no-store` — a feed is personal and must never be cached by a proxy.',
      match: {
        python: {all: [/timeline\.read\(/, /next_cursor/, /private, no-store/]},
        go: {all: [/timeline\.Read\(/, /next_cursor/, /private, no-store/]},
        scala: {all: [/Timeline\.read\(/, /next_cursor/, /private, no-store/]},
        cpp: {all: [/timeline::read\(/, /next_cursor/, /private, no-store/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from feed.events import publish  # provided: publish(post: dict) -> None (Kafka topic "posts")
from feed.store import posts, timeline  # provided: posts.save(post), timeline.read(user_id, cursor, limit)

app = FastAPI()

MAX_TEXT = 280
MAX_MEDIA = 4
MAX_LIMIT, DEFAULT_LIMIT = 50, 20


class NewPost(BaseModel):
    text: str
    media_ids: list[str] = []


@app.post("/posts")
def create_post(body: NewPost, request: Request, x_user_id: str = Header()) -> Response:
    # TODO: 400 when text is empty or longer than MAX_TEXT, or more than MAX_MEDIA media ids
    # TODO: 400 when the Idempotency-Key header is missing
    # TODO: build the post (post_id, author, text, media_ids, created_at ms, idempotency_key)
    # TODO: posts.save, publish, then 201 {post_id, created_at} with Cache-Control: private, no-store
    raise HTTPException(status_code=501)


@app.get("/feed")
def feed(x_user_id: str = Header(), cursor: int | None = None, limit: int = DEFAULT_LIMIT) -> Response:
    # TODO: 400 when limit is outside 1..MAX_LIMIT
    # TODO: timeline.read → {posts, next_cursor} with Cache-Control: private, no-store
    raise HTTPException(status_code=501)


# uvicorn post_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import time
import uuid

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from feed.events import publish  # provided: publish(post: dict) -> None (Kafka topic "posts")
from feed.store import posts, timeline  # provided: posts.save(post), timeline.read(user_id, cursor, limit)

app = FastAPI()

MAX_TEXT = 280
MAX_MEDIA = 4
MAX_LIMIT, DEFAULT_LIMIT = 50, 20
NO_STORE = {"Cache-Control": "private, no-store"}


class NewPost(BaseModel):
    text: str
    media_ids: list[str] = []


@app.post("/posts")
def create_post(body: NewPost, request: Request, x_user_id: str = Header()) -> Response:
    if not body.text or len(body.text) > MAX_TEXT or len(body.media_ids) > MAX_MEDIA:
        raise HTTPException(status_code=400, detail=f"text 1..{MAX_TEXT} chars, at most {MAX_MEDIA} media")
    key = request.headers.get("idempotency-key")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key header required")
    post = {
        "post_id": uuid.uuid4().hex,
        "author": x_user_id,
        "text": body.text,
        "media_ids": body.media_ids,
        "created_at": int(time.time() * 1000),
        "idempotency_key": key,
    }
    posts.save(post)
    publish(post)
    created = {"post_id": post["post_id"], "created_at": post["created_at"]}
    return JSONResponse(status_code=201, content=created, headers=NO_STORE)


@app.get("/feed")
def feed(x_user_id: str = Header(), cursor: int | None = None, limit: int = DEFAULT_LIMIT) -> Response:
    if limit < 1 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit must be between 1 and {MAX_LIMIT}")
    items, next_cursor = timeline.read(x_user_id, cursor, limit)
    return JSONResponse(content={"posts": items, "next_cursor": next_cursor}, headers=NO_STORE)


# uvicorn post_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"feed/events"   // events.Publish(ctx, post) — provided (Kafka topic "posts")
	"feed/posts"    // posts.Post, posts.Save(ctx, post) error — provided
	"feed/timeline" // timeline.Read(ctx, userID, cursor *int64, limit) ([]string, *int64, error) — provided
)

const (
	maxText      = 280
	maxMedia     = 4
	maxLimit     = 50
	defaultLimit = 20
)

type newPost struct {
	Text     string   \`json:"text"\`
	MediaIDs []string \`json:"media_ids"\`
}

func createPost(w http.ResponseWriter, r *http.Request) {
	var body newPost
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	// TODO: 400 when Text is empty or longer than maxText runes, or more than maxMedia media ids
	// TODO: 400 when the Idempotency-Key header is missing
	// TODO: build posts.Post (ID, Author, Text, MediaIDs, CreatedAt ms, IdempotencyKey)
	// TODO: posts.Save, events.Publish, then 201 {post_id, created_at} with Cache-Control: private, no-store
	_ = utf8.RuneCountInString
	_ = uuid.NewString
	_ = time.Now
	_, _, _ = posts.Save, events.Publish, timeline.Read
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func feed(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-Id")
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, _ = strconv.Atoi(raw)
	}
	var cursor *int64
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		c, _ := strconv.ParseInt(raw, 10, 64)
		cursor = &c
	}
	// TODO: 400 when limit is outside 1..maxLimit
	// TODO: timeline.Read → {posts, next_cursor} with Cache-Control: private, no-store
	_, _, _ = userID, limit, cursor
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /posts", createPost)
	mux.HandleFunc("GET /feed", feed)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"feed/events"   // events.Publish(ctx, post) — provided (Kafka topic "posts")
	"feed/posts"    // posts.Post, posts.Save(ctx, post) error — provided
	"feed/timeline" // timeline.Read(ctx, userID, cursor *int64, limit) ([]string, *int64, error) — provided
)

const (
	maxText      = 280
	maxMedia     = 4
	maxLimit     = 50
	defaultLimit = 20
)

type newPost struct {
	Text     string   \`json:"text"\`
	MediaIDs []string \`json:"media_ids"\`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func createPost(w http.ResponseWriter, r *http.Request) {
	var body newPost
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if body.Text == "" || utf8.RuneCountInString(body.Text) > maxText || len(body.MediaIDs) > maxMedia {
		http.Error(w, "text 1..280 chars, at most 4 media", http.StatusBadRequest)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(w, "Idempotency-Key header required", http.StatusBadRequest)
		return
	}
	post := posts.Post{
		ID:             uuid.NewString(),
		Author:         r.Header.Get("X-User-Id"),
		Text:           body.Text,
		MediaIDs:       body.MediaIDs,
		CreatedAt:      time.Now().UnixMilli(),
		IdempotencyKey: key,
	}
	if err := posts.Save(r.Context(), post); err != nil {
		http.Error(w, "could not save post", http.StatusServiceUnavailable)
		return
	}
	events.Publish(r.Context(), post)
	writeJSON(w, http.StatusCreated, map[string]any{"post_id": post.ID, "created_at": post.CreatedAt})
}

func feed(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-Id")
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, _ = strconv.Atoi(raw)
	}
	var cursor *int64
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		c, _ := strconv.ParseInt(raw, 10, 64)
		cursor = &c
	}
	if limit < 1 || limit > maxLimit {
		http.Error(w, "limit must be between 1 and 50", http.StatusBadRequest)
		return
	}
	items, next, err := timeline.Read(r.Context(), userID, cursor, limit)
	if err != nil {
		http.Error(w, "timeline unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"posts": items, "next_cursor": next})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /posts", createPost)
	mux.HandleFunc("GET /feed", feed)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import feed.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import feed.events.Events // Events.publish(post): Unit — provided (Kafka topic "posts")
import feed.json.{NewPost, newPostUnmarshaller, toJson} // provided: NewPost(text, mediaIds), toJson(Map): String
import feed.store.{Post, Posts, Timeline} // provided: Posts.save(post), Timeline.read(userId, cursor, limit): (Seq[String], Option[Long])

object PostApi {
  val MaxText = 280
  val MaxMedia = 4
  val MaxLimit = 50
  val DefaultLimit = 20

  val route: Route =
    headerValueByName("X-User-Id") { userId =>
      concat(
        path("posts") {
          post {
            (optionalHeaderValueByName("Idempotency-Key") & entity(as[NewPost])) { (key, body) =>
              // TODO: 400 when text is empty or longer than MaxText, or more than MaxMedia media ids
              // TODO: 400 when the Idempotency-Key header is missing
              // TODO: build Post(id, author, text, mediaIds, createdAt ms, idempotencyKey)
              // TODO: Posts.save, Events.publish, then 201 {post_id, created_at} with Cache-Control: private, no-store
              complete(StatusCodes.NotImplemented)
            }
          }
        },
        path("feed") {
          get {
            parameters("cursor".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (cursor, limit) =>
              // TODO: 400 when limit is outside 1..MaxLimit
              // TODO: Timeline.read → {posts, next_cursor} with Cache-Control: private, no-store
              complete(StatusCodes.NotImplemented)
            }
          }
        },
      )
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("feed")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import feed.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import feed.events.Events // Events.publish(post): Unit — provided (Kafka topic "posts")
import feed.json.{NewPost, newPostUnmarshaller, toJson} // provided: NewPost(text, mediaIds), toJson(Map): String
import feed.store.{Post, Posts, Timeline} // provided: Posts.save(post), Timeline.read(userId, cursor, limit): (Seq[String], Option[Long])

object PostApi {
  val MaxText = 280
  val MaxMedia = 4
  val MaxLimit = 50
  val DefaultLimit = 20

  private val noStore = RawHeader("Cache-Control", "private, no-store")

  private def json(status: StatusCode, body: Map[String, Any]): HttpResponse =
    HttpResponse(status, headers = List(noStore), entity = HttpEntity(ContentTypes.\`application/json\`, toJson(body)))

  val route: Route =
    headerValueByName("X-User-Id") { userId =>
      concat(
        path("posts") {
          post {
            (optionalHeaderValueByName("Idempotency-Key") & entity(as[NewPost])) { (key, body) =>
              if (body.text.isEmpty || body.text.length > MaxText || body.mediaIds.size > MaxMedia)
                complete(StatusCodes.BadRequest -> s"text 1..$MaxText chars, at most $MaxMedia media")
              else
                key match {
                  case None => complete(StatusCodes.BadRequest -> "Idempotency-Key header required")
                  case Some(k) =>
                    val post = Post(UUID.randomUUID().toString, userId, body.text, body.mediaIds, System.currentTimeMillis(), k)
                    Posts.save(post)
                    Events.publish(post)
                    complete(json(StatusCodes.Created, Map("post_id" -> post.id, "created_at" -> post.createdAt)))
                }
            }
          }
        },
        path("feed") {
          get {
            parameters("cursor".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (cursor, limit) =>
              if (limit < 1 || limit > MaxLimit) complete(StatusCodes.BadRequest -> s"limit must be between 1 and $MaxLimit")
              else {
                val (items, next) = Timeline.read(userId, cursor, limit)
                complete(json(StatusCodes.OK, Map("posts" -> items, "next_cursor" -> next)))
              }
            }
          }
        },
      )
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("feed")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <chrono>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "feed/events.h"  // events::publish(const Post&) — provided (Kafka topic "posts")
#include "feed/store.h"   // Post, posts::save(const Post&), timeline::read(user, cursor, limit) -> Page{items, next_cursor} — provided
#include "feed/uuid.h"    // std::string uuid4() — provided

using json = nlohmann::json;

constexpr std::size_t kMaxText = 280;
constexpr std::size_t kMaxMedia = 4;
constexpr int kMaxLimit = 50;
constexpr int kDefaultLimit = 20;

static int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/posts", [](const httplib::Request& req, httplib::Response& res) {
    const std::string user = req.get_header_value("X-User-Id");
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded()) {
      res.status = 400;
      return;
    }
    const std::string text = body.value("text", "");
    const std::vector<std::string> media_ids = body.value("media_ids", std::vector<std::string>{});
    // TODO: 400 when text is empty or longer than kMaxText, or more than kMaxMedia media ids
    // TODO: 400 when the Idempotency-Key header is missing
    // TODO: build the Post{id, author, text, media_ids, created_at ms, idempotency_key}
    // TODO: posts::save, events::publish, then 201 {post_id, created_at} with Cache-Control: private, no-store
    res.status = 501;
  });

  svr.Get("/feed", [](const httplib::Request& req, httplib::Response& res) {
    const std::string user = req.get_header_value("X-User-Id");
    int limit = kDefaultLimit;
    if (req.has_param("limit")) limit = std::atoi(req.get_param_value("limit").c_str());
    std::optional<int64_t> cursor;
    if (req.has_param("cursor")) cursor = std::stoll(req.get_param_value("cursor"));
    // TODO: 400 when limit is outside 1..kMaxLimit
    // TODO: timeline::read → {posts, next_cursor} with Cache-Control: private, no-store
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <chrono>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "feed/events.h"  // events::publish(const Post&) — provided (Kafka topic "posts")
#include "feed/store.h"   // Post, posts::save(const Post&), timeline::read(user, cursor, limit) -> Page{items, next_cursor} — provided
#include "feed/uuid.h"    // std::string uuid4() — provided

using json = nlohmann::json;

constexpr std::size_t kMaxText = 280;
constexpr std::size_t kMaxMedia = 4;
constexpr int kMaxLimit = 50;
constexpr int kDefaultLimit = 20;

static int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

static void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body.dump(), "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/posts", [](const httplib::Request& req, httplib::Response& res) {
    const std::string user = req.get_header_value("X-User-Id");
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded()) {
      res.status = 400;
      return;
    }
    const std::string text = body.value("text", "");
    const std::vector<std::string> media_ids = body.value("media_ids", std::vector<std::string>{});
    if (text.empty() || text.size() > kMaxText || media_ids.size() > kMaxMedia) {
      res.status = 400;
      res.set_content("text 1..280 chars, at most 4 media", "text/plain");
      return;
    }
    const std::string key = req.get_header_value("Idempotency-Key");
    if (key.empty()) {
      res.status = 400;
      res.set_content("Idempotency-Key header required", "text/plain");
      return;
    }
    const Post post{uuid4(), user, text, media_ids, now_ms(), key};
    posts::save(post);
    events::publish(post);
    reply_json(res, 201, json{{"post_id", post.id}, {"created_at", post.created_at}});
  });

  svr.Get("/feed", [](const httplib::Request& req, httplib::Response& res) {
    const std::string user = req.get_header_value("X-User-Id");
    int limit = kDefaultLimit;
    if (req.has_param("limit")) limit = std::atoi(req.get_param_value("limit").c_str());
    std::optional<int64_t> cursor;
    if (req.has_param("cursor")) cursor = std::stoll(req.get_param_value("cursor"));
    if (limit < 1 || limit > kMaxLimit) {
      res.status = 400;
      res.set_content("limit must be between 1 and 50", "text/plain");
      return;
    }
    const auto page = timeline::read(user, cursor, limit);
    json out{{"posts", page.items}, {"next_cursor", nullptr}};
    if (page.next_cursor) out["next_cursor"] = *page.next_cursor;
    reply_json(res, 200, out);
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The write path is validate → save → publish → 201, and the order matters: a rejected request costs nothing, and the Kafka record is only produced for a post that exists in the store, so the fan-out worker never pushes an id that cannot be hydrated. The \`Idempotency-Key\` turns a retried POST into the same post instead of two. \`private, no-store\` is the header people forget: a feed is per user, and a shared cache that ignored that would leak one user's timeline to the next. Real APIs add pagination tokens that are opaque (not a raw timestamp), request-size limits, and a 202 path for media that is still processing.`,
};
