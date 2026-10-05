import type {Step} from '@/lib/types';

// ---- 4. Paginated history over HTTPS ----------------------------------------------------------
export const historyEndpointStep: Step = {
  id: 'history-endpoint',
  title: 'Paginated history: GET /rooms/{room}/messages',
  concept: 'http',
  file: 'history_api',
  focus: ['client-a', 'history', 'store'],
  task: `## Task

Scrolling up in a room loads older messages over plain HTTPS, not the stream. Implement
\`GET /rooms/{room}/messages?before=<ts>&limit=<n>\` on top of the provided store:
\`store.exists(room)\` and \`store.list(room, before, limit)\`, which returns messages with
\`ts < before\`, **newest first**.

- \`limit\` defaults to 50 and must be within **1–100**; anything else is a **400**. Validate before
  touching the store.
- Unknown room (\`store.exists\` is false) → **404**.
- \`before\` is a millisecond timestamp and defaults to *now*.
- Respond with JSON \`{"messages": […], "next_before": <ts>}\` where \`next_before\` is the \`ts\` of the
  **last** message returned — the client passes it back to get the next page. When fewer than
  \`limit\` messages came back there is no next page: \`next_before\` is \`null\`.
- Send \`Cache-Control: private, max-age=5\`: a user who flicks back and forth reuses their own copy for a
  few seconds, but a shared cache must never serve one user's room to another.

:::widget status-codes {}

> Cursor pagination (\`before=<ts>\`) instead of \`page=3\`: new messages keep arriving at the top, so
> page numbers would shift under the reader. A cursor anchored on the last message you saw does not.`,
  sequence: {
    participants: ['Client', 'history API', 'store'],
    messages: [
      {from: 'Client', to: 'history API', label: 'GET /rooms/room-7/messages?limit=50', kind: 'sync'},
      {from: 'history API', to: 'store', label: 'exists(room-7)', kind: 'sync'},
      {from: 'store', to: 'history API', label: 'true', kind: 'reply'},
      {from: 'history API', to: 'store', label: 'list(room-7, now, 50)', kind: 'sync'},
      {from: 'store', to: 'history API', label: '50 messages, newest first', kind: 'reply'},
      {from: 'history API', to: 'Client', label: '200 {messages, next_before: 1719…} · Cache-Control', kind: 'reply'},
      {from: 'Client', to: 'history API', label: 'GET …?before=1719…&limit=50', kind: 'sync'},
    ],
  },
  hints: [
    'Order of checks: bad limit (400) → unknown room (404) → fetch. The cheap rejections come first so a bad request never costs a store round trip.',
    'The store already returns newest-first, so the last element of the list is the oldest one on this page; its `ts` is the cursor for the next page.',
    '`next_before` is null exactly when the page was not full: fewer than `limit` messages means the store ran out. A full page might still be the last one, and the client will find out with an empty next page.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Serves a JSON page on GET /rooms/{room}/messages',
      detail:
        'The `GET /rooms/{room}/messages` handler must answer with the JSON page `{"messages": […], "next_before": …}` (encode a page object, not the 501 placeholder).',
      match: {
        python: {
          all: [/@app\.get\(\s*["']\/rooms\/\{room\}\/messages["']/, /"messages"\s*:/],
          none: [/status_code\s*=\s*501/],
        },
        go: {
          all: [
            /Handle(Func)?\(\s*"GET \/rooms\/\{room\}\/messages"/,
            /json\.NewEncoder\(\s*rw\s*\)\.Encode\(|json\.Marshal\(/,
          ],
          none: [/StatusNotImplemented/],
        },
        scala: {
          all: [/path\(\s*"rooms"\s*\/\s*Segment\s*\/\s*"messages"\s*\)/, /\bget\s*\{/, /complete\(\s*Page\(/],
          none: [/StatusCodes\.NotImplemented/],
        },
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/rooms\//, /"application\/json"/], none: [/status\s*=\s*501/]},
      },
    },
    {
      id: 'limit-bounds',
      title: 'Rejects limit outside 1–100 with 400',
      detail:
        'Check `limit` against the bounds and answer `400 Bad Request` before `store.exists`/`store.list` is ever called: a bad request must not cost a store round trip.',
      match: {
        python: {
          all: [/MIN_LIMIT/, /MAX_LIMIT/],
          order: [/status_code\s*=\s*400|HTTP_400/, /store\.(?:exists|list)\(/],
        },
        go: {all: [/minLimit/, /maxLimit/], order: [/http\.StatusBadRequest|\b400\b/, /store\.(?:Exists|List)\(/]},
        scala: {all: [/MinLimit/, /MaxLimit/], order: [/StatusCodes\.BadRequest|\b400\b/, /store\.(?:exists|list)\(/]},
        cpp: {all: [/kMinLimit/, /kMaxLimit/], order: [/status\s*=\s*400/, /store\.(?:exists|list)\(/]},
      },
    },
    {
      id: 'unknown-room',
      title: 'Answers 404 for an unknown room before listing',
      detail: 'Ask `store.exists(room)` and respond `404 Not Found`; only then call `store.list`.',
      match: {
        python: {order: [/store\.exists\(\s*room\s*\)/, /status_code\s*=\s*404|HTTP_404/, /store\.list\(/]},
        go: {order: [/store\.Exists\(\s*room\s*\)/, /http\.StatusNotFound|\b404\b/, /store\.List\(/]},
        scala: {order: [/store\.exists\(\s*room\s*\)/, /StatusCodes\.NotFound|\b404\b/, /store\.list\(/]},
        cpp: {order: [/store\.exists\(\s*room\s*\)/, /status\s*=\s*404/, /store\.list\(/]},
      },
    },
    {
      id: 'next-before',
      title: 'Pages with a next_before cursor',
      detail:
        'List `(room, before, limit)` with `before` defaulting to now (ms), and return `next_before` = ts of the last message, null when fewer than `limit` came back.',
      match: {
        python: {
          all: [
            /store\.list\(\s*room\s*,/,
            /(?<!def )now_ms\(\)/,
            /len\(\s*messages\s*\)\s*(?:<|==|>=|!=)\s*limit/,
            /"next_before"/,
          ],
        },
        go: {
          all: [
            /store\.List\(\s*room\s*,/,
            /time\.Now\(\)\.Unix(?:Milli|Nano)\(\)/,
            /len\(\s*messages\s*\)\s*(?:<|==|>=|!=)\s*limit/,
            /NextBefore:/,
          ],
        },
        scala: {
          all: [
            /store\.list\(\s*room\s*,/,
            /System\.currentTimeMillis\(\)/,
            /messages\.(?:size|length)\s*(?:<|==|>=|!=)\s*limit/,
            /Page\(\s*messages\s*,/,
          ],
        },
        cpp: {
          all: [
            /store\.list\(\s*room\s*,/,
            /(?<!long )now_ms\(\)/,
            /messages\.size\(\)\)?\s*(?:<|==|>=|!=)\s*(?:static_cast<\w+>\(\s*)?limit/,
            /next_before/,
          ],
        },
      },
    },
    {
      id: 'cache-control',
      title: 'Sends Cache-Control: private, max-age=5',
      detail:
        '`private` keeps shared caches out of a per-user room; `max-age=5` lets the browser reuse its own copy briefly.',
      match: {
        python: {all: [/Cache-Control/i, /private,\s*max-age=5\b|max-age=5,\s*private/]},
        go: {all: [/Cache-Control/i, /private,\s*max-age=5\b|max-age=5,\s*private/]},
        scala: {
          all: [
            /Cache-Control/i,
            /private,\s*max-age=5\b|max-age=5,\s*private|`private`\(\)[\s\S]{0,80}`max-age`\(\s*5\s*\)|`max-age`\(\s*5\s*\)[\s\S]{0,80}`private`\(\)/,
          ],
        },
        cpp: {all: [/Cache-Control/i, /private,\s*max-age=5\b|max-age=5,\s*private/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Response

app = FastAPI()

MIN_LIMIT, MAX_LIMIT, DEFAULT_LIMIT = 1, 100, 50


class MessageStore:
    """Provided: list() returns messages with ts < before_ms, newest first, as dicts {user, text, ts}."""

    def exists(self, room: str) -> bool:
        raise NotImplementedError

    def list(self, room: str, before_ms: int, limit: int) -> list[dict]:
        raise NotImplementedError


store = MessageStore()


def now_ms() -> int:
    return int(time.time() * 1000)


@app.get("/rooms/{room}/messages")
def history(room: str, response: Response, before: int | None = None, limit: int = DEFAULT_LIMIT) -> dict:
    # TODO: 400 when limit is outside MIN_LIMIT..MAX_LIMIT
    # TODO: 404 when store.exists(room) is false
    # TODO: before defaults to now_ms(); store.list newest-first
    # TODO: next_before = ts of the last message, None when fewer than limit
    # TODO: Cache-Control: private, max-age=5
    raise HTTPException(status_code=501)


# uvicorn history_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Response

app = FastAPI()

MIN_LIMIT, MAX_LIMIT, DEFAULT_LIMIT = 1, 100, 50


class MessageStore:
    """Provided: list() returns messages with ts < before_ms, newest first, as dicts {user, text, ts}."""

    def exists(self, room: str) -> bool:
        raise NotImplementedError

    def list(self, room: str, before_ms: int, limit: int) -> list[dict]:
        raise NotImplementedError


store = MessageStore()


def now_ms() -> int:
    return int(time.time() * 1000)


@app.get("/rooms/{room}/messages")
def history(room: str, response: Response, before: int | None = None, limit: int = DEFAULT_LIMIT) -> dict:
    if limit < MIN_LIMIT or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit must be between {MIN_LIMIT} and {MAX_LIMIT}")
    if not store.exists(room):
        raise HTTPException(status_code=404, detail="no such room")
    messages = store.list(room, before if before is not None else now_ms(), limit)
    next_before = None if len(messages) < limit else messages[-1]["ts"]
    response.headers["Cache-Control"] = "private, max-age=5"
    return {"messages": messages, "next_before": next_before}


# uvicorn history_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
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
)

const (
	minLimit     = 1
	maxLimit     = 100
	defaultLimit = 50
)

type Message struct {
	User string \`json:"user"\`
	Text string \`json:"text"\`
	Ts   int64  \`json:"ts"\`
}

// MessageStore is provided: List returns messages with Ts < before, newest first.
type MessageStore interface {
	Exists(room string) bool
	List(room string, before int64, limit int) []Message
}

var store MessageStore

type page struct {
	Messages   []Message \`json:"messages"\`
	NextBefore *int64    \`json:"next_before"\`
}

func history(rw http.ResponseWriter, r *http.Request) {
	room := r.PathValue("room")
	q := r.URL.Query()
	limit := defaultLimit
	if raw := q.Get("limit"); raw != "" {
		limit, _ = strconv.Atoi(raw)
	}
	// TODO: 400 when limit is outside minLimit..maxLimit
	// TODO: 404 when store.Exists(room) is false
	// TODO: before from the query, defaulting to now (ms); store.List newest-first
	// TODO: NextBefore = Ts of the last message, nil when fewer than limit
	// TODO: Cache-Control: private, max-age=5; encode a page as JSON
	_ = room
	_ = time.Now
	_ = json.NewEncoder
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /rooms/{room}/messages", history)
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
)

const (
	minLimit     = 1
	maxLimit     = 100
	defaultLimit = 50
)

type Message struct {
	User string \`json:"user"\`
	Text string \`json:"text"\`
	Ts   int64  \`json:"ts"\`
}

// MessageStore is provided: List returns messages with Ts < before, newest first.
type MessageStore interface {
	Exists(room string) bool
	List(room string, before int64, limit int) []Message
}

var store MessageStore

type page struct {
	Messages   []Message \`json:"messages"\`
	NextBefore *int64    \`json:"next_before"\`
}

func history(rw http.ResponseWriter, r *http.Request) {
	room := r.PathValue("room")
	q := r.URL.Query()
	limit := defaultLimit
	if raw := q.Get("limit"); raw != "" {
		limit, _ = strconv.Atoi(raw)
	}
	if limit < minLimit || limit > maxLimit {
		http.Error(rw, "limit must be between 1 and 100", http.StatusBadRequest)
		return
	}
	if !store.Exists(room) {
		http.Error(rw, "no such room", http.StatusNotFound)
		return
	}
	before := time.Now().UnixMilli()
	if raw := q.Get("before"); raw != "" {
		before, _ = strconv.ParseInt(raw, 10, 64)
	}
	messages := store.List(room, before, limit)
	if messages == nil {
		messages = []Message{} // "messages": [] rather than null
	}
	var next *int64
	if len(messages) == limit {
		next = &messages[len(messages)-1].Ts
	}
	rw.Header().Set("Cache-Control", "private, max-age=5")
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(page{Messages: messages, NextBefore: next})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /rooms/{room}/messages", history)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Message(user: String, text: String, ts: Long)
final case class Page(messages: Seq[Message], next_before: Option[Long])

/** Provided: list returns messages with ts < before, newest first. */
trait MessageStore {
  def exists(room: String): Boolean
  def list(room: String, before: Long, limit: Int): Seq[Message]
}

object HistoryApi {
  val MinLimit = 1
  val MaxLimit = 100
  val DefaultLimit = 50

  implicit val messageFormat: RootJsonFormat[Message] = jsonFormat3(Message)
  implicit val pageFormat: RootJsonFormat[Page] = jsonFormat2(Page)

  val store: MessageStore = ???

  val route: Route =
    path("rooms" / Segment / "messages") { room =>
      get {
        parameters("before".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (before, limit) =>
          // TODO: 400 when limit is outside MinLimit..MaxLimit
          // TODO: 404 when store.exists(room) is false
          // TODO: before defaults to System.currentTimeMillis(); store.list newest-first
          // TODO: Page(messages, next) where next = ts of the last message, None when fewer than limit
          // TODO: Cache-Control: private, max-age=5
          complete(StatusCodes.NotImplemented)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("chat")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Message(user: String, text: String, ts: Long)
final case class Page(messages: Seq[Message], next_before: Option[Long])

/** Provided: list returns messages with ts < before, newest first. */
trait MessageStore {
  def exists(room: String): Boolean
  def list(room: String, before: Long, limit: Int): Seq[Message]
}

object HistoryApi {
  val MinLimit = 1
  val MaxLimit = 100
  val DefaultLimit = 50

  implicit val messageFormat: RootJsonFormat[Message] = jsonFormat3(Message)
  implicit val pageFormat: RootJsonFormat[Page] = jsonFormat2(Page)

  val store: MessageStore = ???

  val route: Route =
    path("rooms" / Segment / "messages") { room =>
      get {
        parameters("before".as[Long].optional, "limit".as[Int].withDefault(DefaultLimit)) { (before, limit) =>
          if (limit < MinLimit || limit > MaxLimit) complete(StatusCodes.BadRequest -> s"limit must be between $MinLimit and $MaxLimit")
          else if (!store.exists(room)) complete(StatusCodes.NotFound -> "no such room")
          else {
            val messages = store.list(room, before.getOrElse(System.currentTimeMillis()), limit)
            val next = if (messages.size < limit) None else Some(messages.last.ts)
            respondWithHeader(RawHeader("Cache-Control", "private, max-age=5")) {
              complete(Page(messages, next))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("chat")
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
#include <string>
#include <vector>

constexpr int kMinLimit = 1;
constexpr int kMaxLimit = 100;
constexpr int kDefaultLimit = 50;

struct Message {
  std::string user, text;
  long long ts;
};

// Provided: list returns messages with ts < before, newest first.
struct MessageStore {
  bool exists(const std::string& room);
  std::vector<Message> list(const std::string& room, long long before, int limit);
};

MessageStore store;

// Provided: [{"user":"ana","text":"hi","ts":1719000000000}, …]
std::string json_array(const std::vector<Message>& messages);

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/rooms/([\\w-]+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string room = req.matches[1];
    int limit = kDefaultLimit;
    if (req.has_param("limit")) limit = std::atoi(req.get_param_value("limit").c_str());
    // TODO: 400 when limit is outside kMinLimit..kMaxLimit
    // TODO: 404 when store.exists(room) is false
    // TODO: before from the query, defaulting to now_ms(); store.list newest-first
    // TODO: {"messages": json_array(...), "next_before": ts of the last message or null when fewer than limit}
    // TODO: Cache-Control: private, max-age=5
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <chrono>
#include <string>
#include <vector>

constexpr int kMinLimit = 1;
constexpr int kMaxLimit = 100;
constexpr int kDefaultLimit = 50;

struct Message {
  std::string user, text;
  long long ts;
};

// Provided: list returns messages with ts < before, newest first.
struct MessageStore {
  bool exists(const std::string& room);
  std::vector<Message> list(const std::string& room, long long before, int limit);
};

MessageStore store;

// Provided: [{"user":"ana","text":"hi","ts":1719000000000}, …]
std::string json_array(const std::vector<Message>& messages);

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/rooms/([\\w-]+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string room = req.matches[1];
    int limit = kDefaultLimit;
    if (req.has_param("limit")) limit = std::atoi(req.get_param_value("limit").c_str());
    if (limit < kMinLimit || limit > kMaxLimit) {
      res.status = 400;
      res.set_content("limit must be between 1 and 100", "text/plain");
      return;
    }
    if (!store.exists(room)) {
      res.status = 404;
      res.set_content("no such room", "text/plain");
      return;
    }
    long long before = now_ms();
    if (req.has_param("before")) before = std::stoll(req.get_param_value("before"));
    const auto messages = store.list(room, before, limit);
    const std::string next =
        messages.size() < static_cast<size_t>(limit) ? "null" : std::to_string(messages.back().ts);
    res.set_header("Cache-Control", "private, max-age=5");
    res.set_content("{\\"messages\\":" + json_array(messages) + ",\\"next_before\\":" + next + "}", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The endpoint is a cursor-paginated read: validate, authorise the resource (404), fetch one page, hand back the cursor for the next. \`next_before\` being derived from the data rather than from arithmetic is what makes it stable while new messages arrive. \`Cache-Control: private\` is the header people forget: without it a CDN or corporate proxy could happily serve one person's private room to the next. Real APIs sign or opaque-encode the cursor, cap the total scroll depth, and add \`ETag\`s so a repeated page costs a 304.`,
};
