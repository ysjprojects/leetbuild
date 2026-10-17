import type {Step} from '@/lib/types';

export const boardEndpointStep: Step = {
  id: 'board-endpoint',
  title: 'GET /board as one blob, POST /place with validation',
  concept: 'http',
  file: 'board_api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

The board is one Redis string, \`board\`: **one byte per pixel**, row-major, \`offset = y * SIZE + x\`,
values **0–15** (the colour index). \`SIZE\` is 100 here; the real one was 1000. Implement the two
endpoints of **place-api**. \`place_tile(user, x, y, color)\` (step 2) returns the seconds a user still
has to wait, 0 when the tile was painted; \`record_placement(user, x, y, color)\` (step 3) emits the
event.

- \`GET /board\` answers the **whole board** as \`application/octet-stream\`, exactly \`SIZE * SIZE\` bytes.
  Read the string with one \`GET\`; a missing or short key is padded with zeros — an untouched board is
  all colour 0.
- Send \`Cache-Control: public, max-age=1, stale-while-revalidate=5\` and an \`ETag\` derived from the
  bytes; a request whose \`If-None-Match\` equals it gets **304** with an empty body. One second of CDN
  caching is what turned 100 000 clients into ~33 origin requests per second.
- \`POST /place\` with \`{"x", "y", "color", "user"}\`: \`x\`/\`y\` outside \`[0, SIZE)\`, \`color\` outside
  \`[0, 16)\` or an empty \`user\` is a **400** — before anything touches Redis.
- Then \`place_tile(...)\`: a positive result is **429** with \`Retry-After: <seconds>\`; zero means
  painted — call \`record_placement(...)\` and answer **200** with the tile \`{"x", "y", "color", "user"}\`.

:::widget status-codes {}

> The board endpoint is read by everyone and written by no one; the place endpoint is the opposite.
> Shape the first for the cache (small, stable headers, 304s) and the second for the funnel (cheap
> rejections first).

:::widget http-lifecycle {}`,
  sequence: {
    participants: ['Client', 'CDN', 'place-api', 'Redis'],
    messages: [
      {from: 'Client', to: 'CDN', label: 'GET /board', kind: 'sync'},
      {from: 'CDN', to: 'place-api', label: 'GET /board (miss)', kind: 'sync'},
      {from: 'place-api', to: 'Redis', label: 'GET board', kind: 'sync'},
      {from: 'Redis', to: 'place-api', label: '10 000 bytes', kind: 'reply'},
      {from: 'place-api', to: 'CDN', label: '200 octet-stream · max-age=1 · ETag', kind: 'reply'},
      {from: 'CDN', to: 'Client', label: '200 (served from cache for 1 s)', kind: 'reply'},
      {from: 'Client', to: 'place-api', label: 'POST /place {x: 3, y: 7, color: 12, user: ana}', kind: 'sync'},
      {from: 'place-api', to: 'place-api', label: 'validate → place_tile → record_placement', kind: 'sync'},
      {from: 'place-api', to: 'Client', label: '200 {x, y, color, user}', kind: 'reply'},
    ],
  },
  hints: [
    'Read the key as bytes (no `decode_responses`), then pad: `raw.ljust(SIZE * SIZE, b"\\x00")`. The ETag is any stable digest of the padded body wrapped in double quotes; compare it with the `If-None-Match` header verbatim.',
    'The 304 carries the same `ETag` and `Cache-Control` headers and no body — the cache needs them to extend the entry it already has.',
    'Validation is three comparisons and happens before `place_tile`; the 429 maps the returned seconds straight to `Retry-After`, and `record_placement` runs only on the 0 path — a rejected tile is not an event.',
  ],
  checks: [
    {
      id: 'board-blob',
      title: 'GET /board serves the whole board as bytes',
      detail:
        'A handler on `GET /board` answers `application/octet-stream` with exactly `SIZE * SIZE` bytes read from the `board` key, zero-padded when the key is short or missing.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/board["']/, /application\/octet-stream/, /SIZE\s*\*\s*SIZE/]},
        go: {all: [/HandleFunc\(\s*"GET \/board"/, /application\/octet-stream/, /size\s*\*\s*size/]},
        scala: {all: [/path\(\s*"board"\s*\)/, /application\/octet-stream/, /Size\s*\*\s*Size/]},
        cpp: {all: [/svr\.Get\(\s*"\/board"/, /application\/octet-stream/, /kSize\s*\*\s*kSize/]},
      },
    },
    {
      id: 'cache-headers',
      title: 'Caches for one second and answers 304 to a matching ETag',
      detail:
        'The board response carries `Cache-Control: public, max-age=1, stale-while-revalidate=5` and an `ETag`; a request with a matching `If-None-Match` is answered `304 Not Modified` without a body.',
      match: {
        python: {all: [/max-age=1\b/, /stale-while-revalidate/, /ETag/, /if-none-match/i, /status_code\s*=\s*304/]},
        go: {
          all: [/max-age=1\b/, /stale-while-revalidate/, /ETag/, /If-None-Match/, /http\.StatusNotModified|\b304\b/],
        },
        scala: {
          all: [
            /max-age/,
            /stale-while-revalidate/,
            /EntityTag|ETag/,
            /conditional\(|If-None-Match|StatusCodes\.NotModified/,
          ],
        },
        cpp: {all: [/max-age=1\b/, /stale-while-revalidate/, /ETag/, /If-None-Match/, /status\s*=\s*304/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects out-of-range coordinates, colours and a missing user with 400',
      detail:
        '`x` and `y` must be in `[0, SIZE)`, `color` in `[0, COLORS)` and `user` non-empty; anything else is `400 Bad Request` before Redis is touched.',
      match: {
        python: {
          all: [/[<>]=?\s*SIZE|SIZE\s*[<>]=?/, /[<>]=?\s*COLORS|COLORS\s*[<>]=?/, /\.user\b/, /status_code\s*=\s*400/],
        },
        go: {
          all: [
            /[<>]=?\s*size\b|\bsize\s*[<>]=?/,
            /[<>]=?\s*colors\b|\bcolors\s*[<>]=?/,
            /\.User\s*==\s*""/,
            /http\.StatusBadRequest|\b400\b/,
          ],
        },
        scala: {
          all: [
            /[<>]=?\s*Size\b|\bSize\s*[<>]=?/,
            /[<>]=?\s*Colors\b|\bColors\s*[<>]=?/,
            /\.user\.isEmpty/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {
          all: [
            /[<>]=?\s*kSize\b|\bkSize\s*[<>]=?/,
            /[<>]=?\s*kColors\b|\bkColors\s*[<>]=?/,
            /user\.empty\(\)/,
            /status\s*=\s*400/,
          ],
        },
      },
    },
    {
      id: 'cooldown-429',
      title: 'Maps a cooldown to 429 with Retry-After',
      detail:
        'When `place_tile` returns a positive number of seconds the answer is `429 Too Many Requests` with that number in `Retry-After`; nothing is recorded.',
      match: {
        python: {all: [/(?<!def )place_tile\(/, /status_code\s*=\s*429/, /Retry-After/]},
        go: {all: [/(?<!func )placeTile\(/, /http\.StatusTooManyRequests|\b429\b/, /Retry-After/]},
        scala: {all: [/(?<!def )placeTile\(/, /StatusCodes\.TooManyRequests|\b429\b/, /Retry-After/]},
        cpp: {all: [/(?<!int )place_tile\(/, /status\s*=\s*429/, /Retry-After/]},
      },
    },
    {
      id: 'placed',
      title: 'Records the placement and answers 200 with the tile',
      detail:
        'On a zero from `place_tile` the handler calls `record_placement(user, x, y, color)` and answers `200` with `{"x", "y", "color", "user"}` — in that order: validate, place, record.',
      match: {
        python: {all: [/"color"/], order: [/(?<!def )place_tile\(/, /(?<!def )record_placement\(/]},
        go: {all: [/"color"/], order: [/(?<!func )placeTile\(/, /(?<!func )recordPlacement\(/]},
        scala: {all: [/"color"/], order: [/(?<!def )placeTile\(/, /(?<!def )recordPlacement\(/]},
        cpp: {all: [/"color"/], order: [/(?<!int )place_tile\(/, /(?<!void )record_placement\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import redis
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from cooldown import place_tile  # built in step 2: seconds left on the user's cooldown, 0 = painted
from placement_events import record_placement  # built in step 3: one event per painted tile

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

SIZE = 100  # the real board was 1000 × 1000; the shape is the same
COLORS = 16
BOARD_KEY = "board"
CACHE_CONTROL = "public, max-age=1, stale-while-revalidate=5"


class Placement(BaseModel):
    x: int = -1
    y: int = -1
    color: int = -1
    user: str = ""


@app.get("/board")
def board(request: Request) -> Response:
    # TODO: GET BOARD_KEY as bytes, pad with zeros to SIZE * SIZE
    # TODO: ETag from the bytes; If-None-Match equal → 304 with the same headers and no body
    # TODO: 200 application/octet-stream with Cache-Control: CACHE_CONTROL and the ETag
    return Response(status_code=501)


@app.post("/place")
def place(body: Placement) -> JSONResponse:
    # TODO: 400 unless 0 <= x, y < SIZE, 0 <= color < COLORS and user is non-empty
    # TODO: wait = place_tile(user, x, y, color); wait > 0 → 429 with Retry-After: wait
    # TODO: record_placement(user, x, y, color); 200 {x, y, color, user}
    raise HTTPException(status_code=501)


# uvicorn board_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import hashlib

import redis
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from cooldown import place_tile  # built in step 2: seconds left on the user's cooldown, 0 = painted
from placement_events import record_placement  # built in step 3: one event per painted tile

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

SIZE = 100  # the real board was 1000 × 1000; the shape is the same
COLORS = 16
BOARD_KEY = "board"
CACHE_CONTROL = "public, max-age=1, stale-while-revalidate=5"


class Placement(BaseModel):
    x: int = -1
    y: int = -1
    color: int = -1
    user: str = ""


@app.get("/board")
def board(request: Request) -> Response:
    raw = r.get(BOARD_KEY) or b""
    body = raw.ljust(SIZE * SIZE, b"\\x00")[: SIZE * SIZE]
    etag = '"' + hashlib.sha1(body).hexdigest()[:16] + '"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/octet-stream", headers=headers)


@app.post("/place")
def place(body: Placement) -> JSONResponse:
    if not (0 <= body.x < SIZE and 0 <= body.y < SIZE):
        raise HTTPException(status_code=400, detail=f"x and y must be in [0, {SIZE})")
    if not 0 <= body.color < COLORS:
        raise HTTPException(status_code=400, detail=f"color must be in [0, {COLORS})")
    if not body.user:
        raise HTTPException(status_code=400, detail="user is required")
    wait = place_tile(body.user, body.x, body.y, body.color)
    if wait > 0:
        return JSONResponse({"error": "cooldown", "retry_after": wait}, status_code=429, headers={"Retry-After": str(wait)})
    record_placement(body.user, body.x, body.y, body.color)
    return JSONResponse({"x": body.x, "y": body.y, "color": body.color, "user": body.user})


# uvicorn board_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	size         = 100 // the real board was 1000 × 1000; the shape is the same
	colors       = 16
	boardKey     = "board"
	cacheControl = "public, max-age=1, stale-while-revalidate=5"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// placeTile (cooldown.go, step 2) returns the seconds left on the user's cooldown; 0 means painted.
func placeTile(ctx context.Context, user string, x, y, color int) (int, error) { panic("not implemented") }

// recordPlacement (placement_events.go, step 3) emits one event per painted tile.
func recordPlacement(ctx context.Context, user string, x, y, color int) { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func board(rw http.ResponseWriter, r *http.Request) {
	// TODO: Get boardKey as bytes (redis.Nil → empty), pad with zeros to size * size
	// TODO: ETag from the bytes; If-None-Match equal → 304 with the same headers and no body
	// TODO: 200 application/octet-stream with Cache-Control: cacheControl and the ETag
	_ = sha1.Sum
	_ = fmt.Sprintf
	rw.WriteHeader(http.StatusNotImplemented)
}

func place(rw http.ResponseWriter, r *http.Request) {
	var req struct {
		X     int    \`json:"x"\`
		Y     int    \`json:"y"\`
		Color int    \`json:"color"\`
		User  string \`json:"user"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: 400 unless 0 <= X, Y < size, 0 <= Color < colors and User != ""
	// TODO: wait, err := placeTile(...); wait > 0 → 429 with Retry-After: wait
	// TODO: recordPlacement(...); 200 {x, y, color, user}
	_ = strconv.Itoa
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /board", board)
	mux.HandleFunc("POST /place", place)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	size         = 100 // the real board was 1000 × 1000; the shape is the same
	colors       = 16
	boardKey     = "board"
	cacheControl = "public, max-age=1, stale-while-revalidate=5"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// placeTile (cooldown.go, step 2) returns the seconds left on the user's cooldown; 0 means painted.
func placeTile(ctx context.Context, user string, x, y, color int) (int, error) { panic("not implemented") }

// recordPlacement (placement_events.go, step 3) emits one event per painted tile.
func recordPlacement(ctx context.Context, user string, x, y, color int) { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func board(rw http.ResponseWriter, r *http.Request) {
	raw, err := rdb.Get(r.Context(), boardKey).Bytes()
	if err != nil && err != redis.Nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	body := make([]byte, size*size)
	copy(body, raw) // a short or missing key is colour 0 everywhere else
	etag := fmt.Sprintf("%q", fmt.Sprintf("%x", sha1.Sum(body))[:16])
	rw.Header().Set("ETag", etag)
	rw.Header().Set("Cache-Control", cacheControl)
	if r.Header.Get("If-None-Match") == etag {
		rw.WriteHeader(http.StatusNotModified)
		return
	}
	rw.Header().Set("Content-Type", "application/octet-stream")
	rw.Write(body)
}

func place(rw http.ResponseWriter, r *http.Request) {
	var req struct {
		X     int    \`json:"x"\`
		Y     int    \`json:"y"\`
		Color int    \`json:"color"\`
		User  string \`json:"user"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if req.X < 0 || req.X >= size || req.Y < 0 || req.Y >= size {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "x and y must be in [0, size)"})
		return
	}
	if req.Color < 0 || req.Color >= colors {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "color must be in [0, 16)"})
		return
	}
	if req.User == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "user is required"})
		return
	}
	ctx := r.Context()
	wait, err := placeTile(ctx, req.User, req.X, req.Y, req.Color)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if wait > 0 {
		rw.Header().Set("Retry-After", strconv.Itoa(wait))
		writeJSON(rw, http.StatusTooManyRequests, map[string]any{"error": "cooldown", "retry_after": wait})
		return
	}
	recordPlacement(ctx, req.User, req.X, req.Y, req.Color)
	writeJSON(rw, http.StatusOK, map[string]any{"x": req.X, "y": req.Y, "color": req.Color, "user": req.User})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /board", board)
	mux.HandleFunc("POST /place", place)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import java.util.Arrays

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{\`Retry-After\`, EntityTag, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import place.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Placement(x: Int, y: Int, color: Int, user: String)

object BoardApi {
  val Size = 100 // the real board was 1000 × 1000; the shape is the same
  val Colors = 16
  val BoardKey = "board"
  val jedis = new JedisPooled("redis", 6379)

  implicit val placementFormat: RootJsonFormat[Placement] = jsonFormat4(Placement)

  /** Cooldown (step 2): seconds left on the user's cooldown, 0 = painted. */
  def placeTile(user: String, x: Int, y: Int, color: Int): Int = ???

  /** PlacementEvents (step 3): one event per painted tile. */
  def recordPlacement(user: String, x: Int, y: Int, color: Int): Unit = ???

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    concat(
      path("board") {
        get {
          // TODO: jedis.get(BoardKey.getBytes) padded with zeros to Size * Size
          // TODO: Cache-Control public, max-age=1, stale-while-revalidate=5; conditional(EntityTag) → 304
          // TODO: 200 application/octet-stream with the body
          complete(StatusCodes.NotImplemented)
        }
      },
      path("place") {
        post {
          entity(as[Placement]) { p =>
            // TODO: 400 unless 0 <= x, y < Size, 0 <= color < Colors and user is non-empty
            // TODO: wait = placeTile(...); wait > 0 → 429 with Retry-After: wait
            // TODO: recordPlacement(...); 200 {x, y, color, user}
            json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
          }
        }
      },
    )

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("place")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Arrays

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{\`Retry-After\`, EntityTag, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import place.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Placement(x: Int, y: Int, color: Int, user: String)

object BoardApi {
  val Size = 100 // the real board was 1000 × 1000; the shape is the same
  val Colors = 16
  val BoardKey = "board"
  val jedis = new JedisPooled("redis", 6379)

  implicit val placementFormat: RootJsonFormat[Placement] = jsonFormat4(Placement)

  /** Cooldown (step 2): seconds left on the user's cooldown, 0 = painted. */
  def placeTile(user: String, x: Int, y: Int, color: Int): Int = ???

  /** PlacementEvents (step 3): one event per painted tile. */
  def recordPlacement(user: String, x: Int, y: Int, color: Int): Unit = ???

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private val cacheControl = RawHeader("Cache-Control", "public, max-age=1, stale-while-revalidate=5")

  private def etagOf(body: Array[Byte]): EntityTag =
    EntityTag(MessageDigest.getInstance("SHA-1").digest(body).take(8).map("%02x".format(_)).mkString)

  val route: Route =
    concat(
      path("board") {
        get {
          val raw = Option(jedis.get(BoardKey.getBytes)).getOrElse(Array.empty[Byte])
          val body = Arrays.copyOf(raw, Size * Size) // a short or missing key is colour 0 everywhere else
          respondWithHeader(cacheControl) {
            conditional(etagOf(body)) { // adds the ETag; If-None-Match equal → 304 Not Modified
              complete(HttpEntity(ContentTypes.\`application/octet-stream\`, body))
            }
          }
        }
      },
      path("place") {
        post {
          entity(as[Placement]) { p =>
            if (p.x < 0 || p.x >= Size || p.y < 0 || p.y >= Size)
              json(StatusCodes.BadRequest, """{"error":"x and y must be in [0, Size)"}""")
            else if (p.color < 0 || p.color >= Colors)
              json(StatusCodes.BadRequest, """{"error":"color must be in [0, 16)"}""")
            else if (p.user.isEmpty)
              json(StatusCodes.BadRequest, """{"error":"user is required"}""")
            else {
              val wait = placeTile(p.user, p.x, p.y, p.color)
              if (wait > 0)
                json(StatusCodes.TooManyRequests, s"""{"error":"cooldown","retry_after":$wait}""", List(\`Retry-After\`(wait.toLong)))
              else {
                recordPlacement(p.user, p.x, p.y, p.color)
                json(StatusCodes.OK, s"""{"x":\${p.x},"y":\${p.y},"color":\${p.color},"user":"\${p.user}"}""")
              }
            }
          }
        }
      },
    )

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("place")
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
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <string>

using json = nlohmann::json;

constexpr int kSize = 100;  // the real board was 1000 × 1000; the shape is the same
constexpr int kColors = 16;
const std::string kBoardKey = "board";
const std::string kCacheControl = "public, max-age=1, stale-while-revalidate=5";

sw::redis::Redis redis("tcp://redis:6379");

// cooldown.cpp (step 2): seconds left on the user's cooldown, 0 = painted.
int place_tile(const std::string& user, int x, int y, int color);
// placement_events.cpp (step 3): one event per painted tile.
void record_placement(const std::string& user, int x, int y, int color);

std::string etag_of(const std::string& body) {
  unsigned char digest[SHA_DIGEST_LENGTH];
  SHA1(reinterpret_cast<const unsigned char*>(body.data()), body.size(), digest);
  char hex[17];
  for (int i = 0; i < 8; ++i) std::snprintf(hex + 2 * i, 3, "%02x", digest[i]);
  return std::string("\\"") + hex + "\\"";
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/board", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: redis.get(kBoardKey) padded with zeros to kSize * kSize
    // TODO: ETag via etag_of; If-None-Match equal → 304 with the same headers and no body
    // TODO: 200 application/octet-stream with Cache-Control: kCacheControl and the ETag
    res.status = 501;
  });

  svr.Post("/place", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const int x = body.value("x", -1), y = body.value("y", -1), color = body.value("color", -1);
    const std::string user = body.value("user", "");
    // TODO: 400 unless 0 <= x, y < kSize, 0 <= color < kColors and !user.empty()
    // TODO: wait = place_tile(...); wait > 0 → 429 with Retry-After: wait
    // TODO: record_placement(...); 200 {x, y, color, user}
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <string>

using json = nlohmann::json;

constexpr int kSize = 100;  // the real board was 1000 × 1000; the shape is the same
constexpr int kColors = 16;
const std::string kBoardKey = "board";
const std::string kCacheControl = "public, max-age=1, stale-while-revalidate=5";

sw::redis::Redis redis("tcp://redis:6379");

// cooldown.cpp (step 2): seconds left on the user's cooldown, 0 = painted.
int place_tile(const std::string& user, int x, int y, int color);
// placement_events.cpp (step 3): one event per painted tile.
void record_placement(const std::string& user, int x, int y, int color);

std::string etag_of(const std::string& body) {
  unsigned char digest[SHA_DIGEST_LENGTH];
  SHA1(reinterpret_cast<const unsigned char*>(body.data()), body.size(), digest);
  char hex[17];
  for (int i = 0; i < 8; ++i) std::snprintf(hex + 2 * i, 3, "%02x", digest[i]);
  return std::string("\\"") + hex + "\\"";
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/board", [](const httplib::Request& req, httplib::Response& res) {
    std::string body = redis.get(kBoardKey).value_or("");
    body.resize(kSize * kSize, '\\0');  // a short or missing key is colour 0 everywhere else
    const std::string etag = etag_of(body);
    res.set_header("ETag", etag);
    res.set_header("Cache-Control", kCacheControl);
    if (req.get_header_value("If-None-Match") == etag) {
      res.status = 304;
      return;
    }
    res.set_content(body, "application/octet-stream");
  });

  svr.Post("/place", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const int x = body.value("x", -1), y = body.value("y", -1), color = body.value("color", -1);
    const std::string user = body.value("user", "");
    if (x < 0 || x >= kSize || y < 0 || y >= kSize) {
      res.status = 400;
      res.set_content(R"({"error":"x and y must be in [0, kSize)"})", "application/json");
      return;
    }
    if (color < 0 || color >= kColors) {
      res.status = 400;
      res.set_content(R"({"error":"color must be in [0, 16)"})", "application/json");
      return;
    }
    if (user.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"user is required"})", "application/json");
      return;
    }
    const int wait = place_tile(user, x, y, color);
    if (wait > 0) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(wait));
      res.set_content(json{{"error", "cooldown"}, {"retry_after", wait}}.dump(), "application/json");
      return;
    }
    record_placement(user, x, y, color);
    res.set_content(json{{"x", x}, {"y", y}, {"color", color}, {"user", user}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `def _api(ctx, wait=0):
    """board_api with steps 2 and 3 replaced by recorders: what was placed, what was recorded."""
    m = ctx.load("board_api")
    m.placed = []
    m.recorded = []

    def place_tile(user, x, y, color):
        m.placed.append((user, x, y, color))
        return wait

    m.place_tile = place_tile
    m.record_placement = lambda user, x, y, color: m.recorded.append((user, x, y, color))
    return m


TILE = {"x": 3, "y": 7, "color": 12, "user": "ana"}


async def check_board_blob(ctx):
    m = _api(ctx)
    n = m.SIZE * m.SIZE
    async with ctx.client(m.app) as c:
        r = await c.get("/board")
        assert r.status_code not in (404, 405), f"GET /board answered {r.status_code}: no handler is registered for it"
        assert r.status_code == 200, f"GET /board answered {r.status_code}, expected 200"
        assert r.headers.get("content-type", "").startswith("application/octet-stream"), f"Content-Type is {r.headers.get('content-type')!r}, expected application/octet-stream"
        assert len(r.content) == n, f"an untouched board is {len(r.content)} bytes, expected SIZE * SIZE = {n} zero bytes"
        assert r.content == bytes(n), "an untouched board must be all colour 0"
        ctx.redis_bytes.setrange("board", 7 * m.SIZE + 3, b"\\x0c")
        r = await c.get("/board")
        assert len(r.content) == n, f"after one SETRANGE the board is {len(r.content)} bytes, expected {n}: pad a short key with zeros"
        assert r.content[7 * m.SIZE + 3] == 12, f"byte y * SIZE + x of the body is {r.content[7 * m.SIZE + 3]}, expected the colour 12 written to Redis"
        assert r.content.count(0) == n - 1, "every other pixel must still be colour 0"


async def check_cache_headers(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get("/board")
        cache = r.headers.get("cache-control", "")
        assert "max-age=1" in cache.replace(" ", "").split(",") or "max-age=1" in cache, f"Cache-Control is {cache!r}, expected public, max-age=1, stale-while-revalidate=5"
        assert "public" in cache and "stale-while-revalidate" in cache, f"Cache-Control is {cache!r}, expected public, max-age=1, stale-while-revalidate=5"
        etag = r.headers.get("etag")
        assert etag, "GET /board must carry an ETag so caches can revalidate instead of re-downloading the board"
        again = await c.get("/board")
        assert again.headers.get("etag") == etag, "the same bytes must give the same ETag"
        r = await c.get("/board", headers={"If-None-Match": etag})
        assert r.status_code == 304, f"If-None-Match with the current ETag answered {r.status_code}, expected 304"
        assert r.content == b"", "a 304 has no body"
        assert r.headers.get("etag") == etag, "the 304 must repeat the ETag"
        assert "max-age=1" in r.headers.get("cache-control", ""), "the 304 must repeat Cache-Control so the cache extends its entry"
        ctx.redis_bytes.setrange("board", 0, b"\\x05")
        r = await c.get("/board", headers={"If-None-Match": etag})
        assert r.status_code == 200, f"after a tile changed the old ETag no longer matches: expected 200, got {r.status_code}"
        assert r.headers.get("etag") != etag, "a changed board must change the ETag"


async def check_validate(ctx):
    m = _api(ctx)
    size = m.SIZE
    async with ctx.client(m.app) as c:
        for bad in ({"x": -1}, {"x": size}, {"y": -1}, {"y": size}, {"color": -1}, {"color": 16}, {"user": ""}):
            r = await c.post("/place", json={**TILE, **bad})
            assert r.status_code == 400, f"POST /place with {bad} answered {r.status_code}, expected 400"
        assert m.placed == [], f"a rejected placement must never reach place_tile, but it saw {m.placed}"
        assert m.recorded == [], "a rejected placement must not be recorded"
        for ok in ({"x": size - 1, "y": size - 1}, {"x": 0, "y": 0}, {"color": 15}, {"color": 0}):
            r = await c.post("/place", json={**TILE, **ok})
            assert r.status_code == 200, f"POST /place with {ok} is within range: expected 200, got {r.status_code}"


async def check_cooldown_429(ctx):
    m = _api(ctx, wait=187)
    async with ctx.client(m.app) as c:
        r = await c.post("/place", json=TILE)
    assert r.status_code == 429, f"place_tile said 187 seconds left: expected 429, got {r.status_code}"
    assert r.headers.get("retry-after") == "187", f"Retry-After is {r.headers.get('retry-after')!r}, expected the 187 seconds place_tile returned"
    assert m.placed == [("ana", 3, 7, 12)], f"place_tile must be called with (user, x, y, color), got {m.placed}"
    assert m.recorded == [], "a tile refused by the cooldown is not a placement: nothing to record"


async def check_placed(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/place", json=TILE)
    assert r.status_code == 200, f"a painted tile answers 200, got {r.status_code}"
    assert m.placed == [("ana", 3, 7, 12)], f"place_tile must be called once with (user, x, y, color), got {m.placed}"
    assert m.recorded == [("ana", 3, 7, 12)], f"record_placement must be called once with (user, x, y, color), got {m.recorded}"
    body = r.json()
    assert {k: body.get(k) for k in TILE} == TILE, f"the body must carry the tile {TILE}, got {body}"
`,
  },
  debrief: `Two endpoints with opposite shapes. \`GET /board\` is the hot read: one Redis \`GET\`, a fixed-size body and headers written for the cache in front — \`max-age=1\` means the origin sees one request per edge node per second no matter how many clients refresh, \`stale-while-revalidate\` keeps that true at the moment the second rolls over, and the \`ETag\` turns a revalidation into a 304 instead of 10 000 bytes. \`POST /place\` is a funnel: three comparisons reject most bad input for free, the cooldown decides the rest, and only a painted tile becomes an event. Reddit's board was 1000 × 1000 with two 4-bit pixels per byte (500 KB per read, under 100 ms from Redis) and was served through Fastly with exactly this cache policy; the single-tile detail endpoint, which was not cached, was the one scrapers hammered.`,
};
