import type {Step} from '@/lib/types';

export const notifyEndpointStep: Step = {
  id: 'notify-endpoint',
  title: 'POST /notifications with an Idempotency-Key',
  concept: 'http',
  file: 'notify_api',
  focus: ['app', 'api', 'redis'],
  task: `## Task

Product services call \`POST /notifications\` with \`{user_id, channel, title, body, priority}\` and
retry whenever a response goes missing. A user must never get the same ping twice, so every request
carries an **\`Idempotency-Key\`** header. \`enqueue(notification)\` is provided (you build it in the
next step): it hands the notification to Kafka and raises when the broker did not acknowledge it.

- \`channel\` must be one of \`push | sms | email\` and \`priority\` one of \`high | normal\`;
  \`user_id\` and \`title\` must be present. Anything else → **400**.
- No \`Idempotency-Key\` header → **400**.
- Mint a notification id and claim the key with one atomic command:
  \`SET idem:{key} <id> NX EX 86400\`.
- If the SET is refused, the request is a replay: answer **200** with the id stored under the key.
- Otherwise \`enqueue\` the notification and answer **202** \`{"id": …}\` — accepted, not yet delivered.
  When \`enqueue\` raises, delete the key and answer **503** so the client's retry can enqueue again.

:::widget idempotency {}

> A 202 is a promise, not a receipt: the API only vouches that the notification is safely in Kafka.
> That is why the key is released when the enqueue fails — a stored id nobody enqueued would turn
> every retry into a confident 200 for a notification that never existed.

:::widget status-codes {}`,
  sequence: {
    participants: ['Product service', 'notify API', 'Redis'],
    messages: [
      {from: 'Product service', to: 'notify API', label: 'POST /notifications · Idempotency-Key: k1', kind: 'sync'},
      {from: 'notify API', to: 'Redis', label: 'SET idem:k1 n-7f3 NX EX 86400 → OK', kind: 'sync'},
      {from: 'notify API', to: 'notify API', label: 'enqueue(notification)', kind: 'sync'},
      {from: 'notify API', to: 'Product service', label: '202 {"id": "n-7f3"}', kind: 'reply'},
      {
        from: 'Product service',
        to: 'notify API',
        label: 'POST /notifications · Idempotency-Key: k1 (retry)',
        kind: 'sync',
      },
      {from: 'notify API', to: 'Redis', label: 'SET … NX → (nil) · GET idem:k1 → n-7f3', kind: 'sync'},
      {from: 'notify API', to: 'Product service', label: '200 {"id": "n-7f3"} (replayed)', kind: 'reply'},
    ],
  },
  hints: [
    'Validate the body and the header before touching Redis: a request you are going to reject with a 400 must not claim an idempotency key.',
    'Mint the id *before* the SET so the value you store is the id you are about to answer with; a refused SET means someone already stored one — GET it and send that.',
    'Wrap only the `enqueue` call in the error handler: on failure DEL the key, then answer 503. The retry will find no key, claim it again and enqueue again.',
  ],
  checks: [
    {
      id: 'validate',
      title: 'Rejects an unknown channel or priority with 400',
      detail:
        'Check `channel` against the known channels and `priority` against the known priorities and answer `400 Bad Request` before any other work.',
      match: {
        python: {
          all: [/not in CHANNELS|in CHANNELS/, /not in PRIORITIES|in PRIORITIES/, /status_code\s*=\s*400|HTTP_400/],
        },
        go: {all: [/channels\[/, /priorities\[/, /http\.StatusBadRequest|\b400\b/]},
        scala: {
          all: [
            /Channels\.contains\(|Channels\(/,
            /Priorities\.contains\(|Priorities\(/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {all: [/kChannels\.(count|find|contains)\(/, /kPriorities\.(count|find|contains)\(/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'header-required',
      title: 'Rejects requests without an Idempotency-Key with 400',
      detail:
        'Read the `Idempotency-Key` header and answer `400 Bad Request` when it is missing; without it the API cannot promise to dedupe anything.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/Idempotency-Key/i, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/Idempotency-Key/i, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/Idempotency-Key/i, /status\s*=\s*400/]},
      },
    },
    {
      id: 'reserve-nx',
      title: 'Claims idem:{key} atomically with SET NX EX',
      detail:
        'One `SET idem:{key} <id> NX EX 86400` both checks for a previous request and claims the key; a GET followed by a SET leaves a window in which two retries both enqueue.',
      match: {
        python: {
          all: [
            /f["']idem:\{/,
            /\.set\(\s*\w+\s*,\s*[^,\n]+,[^\n]*nx\s*=\s*True/,
            /\.set\(\s*\w+\s*,\s*[^,\n]+,[^\n]*ex\s*=\s*(IDEM_TTL_S|86400)/,
          ],
        },
        go: {
          all: [
            /"idem:"\s*\+|"idem:%s"/,
            /rdb\.SetNX\(\s*[\w.()]+\s*,\s*\w+\s*,\s*[^,\n]+,\s*(idemTTL|24\s*\*\s*time\.Hour)\s*\)/,
          ],
        },
        scala: {
          all: [
            /s"idem:\$/,
            /jedis\.set\(\s*\w+\s*,\s*[^,\n]+,[^\n]*\.nx\(\)/,
            /\.ex\(\s*(IdemTtlSeconds|86400L?)\s*\)/,
          ],
        },
        cpp: {
          all: [
            /"idem:"\s*\+/,
            /redis\.set\(\s*\w+\s*,\s*[^,\n]+,\s*kIdemTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/,
          ],
        },
      },
    },
    {
      id: 'replay',
      title: 'Replays the stored id with 200',
      detail:
        'When the SET is refused, GET the id stored under the key and answer `200` with it; the notification is not enqueued a second time.',
      match: {
        python: {all: [/\br\.get\(/, /status_code\s*=\s*200/]},
        go: {all: [/rdb\.Get\(/, /http\.StatusOK|\b200\b/]},
        scala: {all: [/jedis\.get\(/, /StatusCodes\.OK|\b200\b/]},
        cpp: {all: [/redis\.get\(/, /status\s*=\s*200/]},
      },
    },
    {
      id: 'accepted',
      title: 'Enqueues after the claim and answers 202',
      detail:
        'Only after the key is claimed does the notification go to `enqueue`, and the answer is `202 Accepted` — it is queued, not delivered.',
      match: {
        python: {order: [/\.set\([^\n]*nx\s*=\s*True/, /(?<!def )enqueue\(/, /status_code\s*=\s*202/]},
        go: {order: [/rdb\.SetNX\(/, /(?<!func )enqueue\(/, /http\.StatusAccepted|\b202\b/]},
        scala: {order: [/\.nx\(\)/, /(?<!def )enqueue\(/, /StatusCodes\.Accepted|\b202\b/]},
        cpp: {order: [/UpdateType::NOT_EXIST/, /(?<!void )enqueue\(/, /status\s*=\s*202/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

CHANNELS = {"push", "sms", "email"}
PRIORITIES = {"high", "normal"}
IDEM_TTL_S = 86400


class Notification(BaseModel):
    id: str = ""
    user_id: str = ""
    channel: str = ""
    title: str = ""
    body: str = ""
    priority: str = "normal"


def enqueue(notification: dict) -> None:
    """Produce the notification to Kafka keyed by user (built in step 2); raises when the broker did not ack."""
    raise NotImplementedError


@app.post("/notifications")
def notify(notification: Notification, request: Request) -> JSONResponse:
    # TODO: 400 unless channel in CHANNELS, priority in PRIORITIES, user_id and title present
    # TODO: 400 when the Idempotency-Key header is missing
    # TODO: mint an id; SET idem:{key} id NX EX IDEM_TTL_S; refused → 200 with the stored id
    # TODO: enqueue(notification.model_dump()) (DEL the key and answer 503 when it raises), then 202 {id}
    raise HTTPException(status_code=501)


# uvicorn notify_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import uuid

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

CHANNELS = {"push", "sms", "email"}
PRIORITIES = {"high", "normal"}
IDEM_TTL_S = 86400


class Notification(BaseModel):
    id: str = ""
    user_id: str = ""
    channel: str = ""
    title: str = ""
    body: str = ""
    priority: str = "normal"


def enqueue(notification: dict) -> None:
    """Produce the notification to Kafka keyed by user (built in step 2); raises when the broker did not ack."""
    raise NotImplementedError


@app.post("/notifications")
def notify(notification: Notification, request: Request) -> JSONResponse:
    if notification.channel not in CHANNELS or notification.priority not in PRIORITIES:
        raise HTTPException(status_code=400, detail="unknown channel or priority")
    if not notification.user_id or not notification.title:
        raise HTTPException(status_code=400, detail="user_id and title are required")
    idem_key = request.headers.get("idempotency-key")
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    key = f"idem:{idem_key}"
    notification.id = str(uuid.uuid4())
    if not r.set(key, notification.id, nx=True, ex=IDEM_TTL_S):
        stored = r.get(key)
        return JSONResponse(status_code=200, content={"id": stored.decode() if stored else None})
    try:
        enqueue(notification.model_dump())
    except Exception:
        r.delete(key)  # the retry must be allowed to enqueue again
        raise HTTPException(status_code=503, detail="notification bus unavailable")
    return JSONResponse(status_code=202, content={"id": notification.id})


# uvicorn notify_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = 24 * time.Hour

var channels = map[string]bool{"push": true, "sms": true, "email": true}
var priorities = map[string]bool{"high": true, "normal": true}

type Notification struct {
	ID       string \`json:"id"\`
	UserID   string \`json:"user_id"\`
	Channel  string \`json:"channel"\`
	Title    string \`json:"title"\`
	Body     string \`json:"body"\`
	Priority string \`json:"priority"\`
}

// enqueue produces the notification to Kafka keyed by user (built in step 2); returns an error when the broker did not ack.
func enqueue(ctx context.Context, n Notification) error {
	panic("not implemented")
}

func writeID(rw http.ResponseWriter, status int, id string) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(map[string]string{"id": id})
}

func notify(rw http.ResponseWriter, r *http.Request) {
	var n Notification
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	// TODO: 400 unless channels[n.Channel], priorities[n.Priority], UserID and Title present
	// TODO: 400 when the Idempotency-Key header is missing
	// TODO: mint an id; SetNX idem:{key} id idemTTL; refused → writeID 200 with the stored id
	// TODO: enqueue(ctx, n) (Del the key and answer 503 on error), then writeID 202
	_ = uuid.NewString
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /notifications", notify)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = 24 * time.Hour

var channels = map[string]bool{"push": true, "sms": true, "email": true}
var priorities = map[string]bool{"high": true, "normal": true}

type Notification struct {
	ID       string \`json:"id"\`
	UserID   string \`json:"user_id"\`
	Channel  string \`json:"channel"\`
	Title    string \`json:"title"\`
	Body     string \`json:"body"\`
	Priority string \`json:"priority"\`
}

// enqueue produces the notification to Kafka keyed by user (built in step 2); returns an error when the broker did not ack.
func enqueue(ctx context.Context, n Notification) error {
	panic("not implemented")
}

func writeID(rw http.ResponseWriter, status int, id string) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(map[string]string{"id": id})
}

func notify(rw http.ResponseWriter, r *http.Request) {
	var n Notification
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	if !channels[n.Channel] || !priorities[n.Priority] || n.UserID == "" || n.Title == "" {
		http.Error(rw, "unknown channel or priority, or missing user_id/title", http.StatusBadRequest)
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		http.Error(rw, "Idempotency-Key header is required", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	key := "idem:" + idemKey
	n.ID = uuid.NewString()
	won, err := rdb.SetNX(ctx, key, n.ID, idemTTL).Result()
	if err != nil {
		http.Error(rw, "idempotency store unavailable", http.StatusServiceUnavailable)
		return
	}
	if !won {
		stored, _ := rdb.Get(ctx, key).Result()
		writeID(rw, http.StatusOK, stored)
		return
	}
	if err := enqueue(ctx, n); err != nil {
		rdb.Del(ctx, key) // the retry must be allowed to enqueue again
		http.Error(rw, "notification bus unavailable", http.StatusServiceUnavailable)
		return
	}
	writeID(rw, http.StatusAccepted, n.ID)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /notifications", notify)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import notify.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

object NotifyApi {
  val jedis = new JedisPooled("redis", 6379)
  val Channels = Set("push", "sms", "email")
  val Priorities = Set("high", "normal")
  val IdemTtlSeconds = 86400L

  case class NotifyRequest(userId: String, channel: String, title: String, body: String, priority: String)
  implicit val requestFormat: RootJsonFormat[NotifyRequest] =
    jsonFormat(NotifyRequest, "user_id", "channel", "title", "body", "priority")

  /** Produce the notification to Kafka keyed by user (built in step 2); throws when the broker did not ack. */
  def enqueue(id: String, n: NotifyRequest): Unit = ???

  val route: Route =
    path("notifications") {
      post {
        entity(as[NotifyRequest]) { n =>
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            // TODO: 400 unless Channels contains n.channel, Priorities contains n.priority, userId and title non-empty
            // TODO: 400 when idemKey is None
            // TODO: mint an id; SET idem:{key} id NX EX IdemTtlSeconds; refused → 200 with the stored id
            // TODO: enqueue(id, n) (DEL the key and answer 503 when it throws), then 202 {id}
            complete(StatusCodes.NotImplemented)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("notify")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import notify.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

object NotifyApi {
  val jedis = new JedisPooled("redis", 6379)
  val Channels = Set("push", "sms", "email")
  val Priorities = Set("high", "normal")
  val IdemTtlSeconds = 86400L

  case class NotifyRequest(userId: String, channel: String, title: String, body: String, priority: String)
  implicit val requestFormat: RootJsonFormat[NotifyRequest] =
    jsonFormat(NotifyRequest, "user_id", "channel", "title", "body", "priority")

  /** Produce the notification to Kafka keyed by user (built in step 2); throws when the broker did not ack. */
  def enqueue(id: String, n: NotifyRequest): Unit = ???

  val route: Route =
    path("notifications") {
      post {
        entity(as[NotifyRequest]) { n =>
          optionalHeaderValueByName("Idempotency-Key") {
            case _ if !Channels.contains(n.channel) || !Priorities.contains(n.priority) || n.userId.isEmpty || n.title.isEmpty =>
              complete(StatusCodes.BadRequest -> "unknown channel or priority, or missing user_id/title")
            case None => complete(StatusCodes.BadRequest -> "Idempotency-Key header is required")
            case Some(idemKey) =>
              val key = s"idem:$idemKey"
              val id = UUID.randomUUID().toString
              val won = jedis.set(key, id, SetParams.setParams().nx().ex(IdemTtlSeconds)) != null
              if (!won) complete(StatusCodes.OK -> Map("id" -> jedis.get(key)))
              else
                try {
                  enqueue(id, n)
                  complete(StatusCodes.Accepted -> Map("id" -> id))
                } catch {
                  case _: Exception =>
                    jedis.del(key) // the retry must be allowed to enqueue again
                    complete(StatusCodes.ServiceUnavailable -> "notification bus unavailable")
                }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("notify")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <nlohmann/json.hpp>
#include <set>
#include <string>

#include "ids.h"  // std::string new_id() — a fresh UUID, provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIdemTtl{86400};
const std::set<std::string> kChannels = {"push", "sms", "email"};
const std::set<std::string> kPriorities = {"high", "normal"};

struct Notification {
  std::string id, user_id, channel, title, body, priority;
};

// Produce the notification to Kafka keyed by user (built in step 2); throws when the broker did not ack.
void enqueue(const Notification& n);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/notifications", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded()) {
      res.status = 400;
      res.set_content("invalid JSON", "text/plain");
      return;
    }
    Notification n{"", body.value("user_id", ""), body.value("channel", ""), body.value("title", ""),
                   body.value("body", ""), body.value("priority", "normal")};
    // TODO: 400 unless kChannels / kPriorities contain n.channel / n.priority and user_id, title are non-empty
    // TODO: 400 when the Idempotency-Key header is missing
    // TODO: n.id = new_id(); SET idem:{key} n.id NX EX kIdemTtl; refused → 200 with the stored id
    // TODO: enqueue(n) (DEL the key and answer 503 when it throws), then 202 {"id": …}
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <nlohmann/json.hpp>
#include <set>
#include <string>

#include "ids.h"  // std::string new_id() — a fresh UUID, provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIdemTtl{86400};
const std::set<std::string> kChannels = {"push", "sms", "email"};
const std::set<std::string> kPriorities = {"high", "normal"};

struct Notification {
  std::string id, user_id, channel, title, body, priority;
};

// Produce the notification to Kafka keyed by user (built in step 2); throws when the broker did not ack.
void enqueue(const Notification& n);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/notifications", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded()) {
      res.status = 400;
      res.set_content("invalid JSON", "text/plain");
      return;
    }
    Notification n{"", body.value("user_id", ""), body.value("channel", ""), body.value("title", ""),
                   body.value("body", ""), body.value("priority", "normal")};
    if (!kChannels.count(n.channel) || !kPriorities.count(n.priority) || n.user_id.empty() || n.title.empty()) {
      res.status = 400;
      res.set_content("unknown channel or priority, or missing user_id/title", "text/plain");
      return;
    }
    if (!req.has_header("Idempotency-Key")) {
      res.status = 400;
      res.set_content("Idempotency-Key header is required", "text/plain");
      return;
    }
    const std::string key = "idem:" + req.get_header_value("Idempotency-Key");
    n.id = new_id();
    if (!redis.set(key, n.id, kIdemTtl, sw::redis::UpdateType::NOT_EXIST)) {
      res.status = 200;
      res.set_content(json{{"id", redis.get(key).value_or("")}}.dump(), "application/json");
      return;
    }
    try {
      enqueue(n);
    } catch (const std::exception&) {
      redis.del(key);  // the retry must be allowed to enqueue again
      res.status = 503;
      res.set_content("notification bus unavailable", "text/plain");
      return;
    }
    res.status = 202;
    res.set_content(json{{"id", n.id}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The intake endpoint is where "at least once" from the network becomes "at most once" into the system: the atomic \`SET NX EX\` is both the check and the claim, the stored id makes the replay identical, and releasing the key on a failed enqueue keeps the promise honest. The 202 matters too — the API answers as soon as Kafka has the record, so a slow push provider never slows the services calling it. Real intake APIs also fingerprint the body (same key, different payload → 422) and scope keys per caller so two teams cannot collide on \`order-123\`.`,
};
