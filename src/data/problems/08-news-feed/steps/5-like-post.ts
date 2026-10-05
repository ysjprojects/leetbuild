import type {Step} from '@/lib/types';

export const likePostStep: Step = {
  id: 'like-post',
  title: 'Idempotent likes with a counter and an event',
  concept: 'redis',
  file: 'likes',
  focus: ['api', 'redis', 'engagement'],
  task: `## Task

Implement the like endpoints. A double-tap, a retry after a timeout, or a replayed request must never
count twice — so the **membership set is the source of truth** and the counter only follows it.

- \`POST /posts/{id}/like\`: \`SADD liked:{post} <user>\`. When it returns **0** the user already liked the
  post → **409**, nothing else happens. Otherwise \`INCR likes:{post}\` and answer \`{"likes": n}\`.
- After a successful like, produce a \`like\` event to the **\`engagement\`** topic, **keyed by the post id**
  (so one post's events stay ordered on one partition). Fire-and-forget: the request never waits for the
  broker. The event carries an \`event_id\` — step 6 dedupes on it.
- \`DELETE /posts/{id}/like\`: the mirror image — \`SREM\` returns 0 → **409**, else \`DECR\` and an \`unlike\`
  event.
- \`GET /posts/{id}/likes\` returns \`{"likes": n}\`; a post nobody liked yet has **0**, not an error.

:::widget idempotency {}

:::widget kafka-partitions {"partitions": 8}`,
  sequence: {
    participants: ['App', 'feed-api', 'Redis', 'Kafka'],
    messages: [
      {from: 'App', to: 'feed-api', label: 'POST /posts/p1/like (X-User-Id: alice)', kind: 'sync'},
      {from: 'feed-api', to: 'Redis', label: 'SADD liked:p1 alice → 1', kind: 'sync'},
      {from: 'feed-api', to: 'Redis', label: 'INCR likes:p1 → 42', kind: 'sync'},
      {from: 'feed-api', to: 'Kafka', label: 'engagement ← {like, p1, alice, event_id}', kind: 'async'},
      {from: 'feed-api', to: 'App', label: '200 {"likes": 42}', kind: 'reply'},
      {from: 'App', to: 'feed-api', label: 'POST /posts/p1/like (retry)', kind: 'sync'},
      {from: 'feed-api', to: 'App', label: '409 already liked (SADD → 0)', kind: 'reply'},
    ],
  },
  hints: [
    'SADD and SREM return how many members were actually added or removed: that integer *is* the idempotency check. Branch on it before touching the counter.',
    'Build the event once in a small helper that takes the kind (`like` / `unlike`), the post id and the user id, generates the `event_id`, and produces with the post id as key — then both handlers call it.',
    'A counter that does not exist yet reads back as nothing; map that to 0 in the GET handler rather than letting it surface as a 500.',
  ],
  checks: [
    {
      id: 'idempotent-like',
      title: 'Second like by the same user answers 409',
      detail:
        '`SADD liked:{post} user` returning 0 means the like already exists: respond `409 Conflict` and do not touch the counter.',
      match: {
        python: {all: [/\.sadd\(\s*f"liked:\{/, /status_code\s*=\s*409|HTTP_409/]},
        go: {all: [/\.SAdd\(\s*[^\n]*"liked:"\s*\+|\.SAdd\(\s*[^\n]*"liked:%s"/, /http\.StatusConflict|\b409\b/]},
        scala: {all: [/\.sadd\(\s*s"liked:\$/, /StatusCodes\.Conflict|\b409\b/]},
        cpp: {all: [/\.sadd\(\s*"liked:"\s*\+/, /status\s*=\s*409/]},
      },
    },
    {
      id: 'count-after-membership',
      title: 'Increments likes:{post} only after SADD added',
      detail: 'The counter moves after the set confirmed a new member — never before, never on a duplicate.',
      match: {
        python: {all: [/\.incr\(\s*f"likes:\{/], order: [/\.sadd\(/, /\.incr\(/]},
        go: {all: [/\.Incr\(\s*[^\n]*"likes:"\s*\+|\.Incr\(\s*[^\n]*"likes:%s"/], order: [/\.SAdd\(/, /\.Incr\(/]},
        scala: {all: [/\.incr\(\s*s"likes:\$/], order: [/\.sadd\(/, /\.incr\(/]},
        cpp: {all: [/\.incr\(\s*"likes:"\s*\+/], order: [/\.sadd\(/, /\.incr\(/]},
      },
    },
    {
      id: 'unlike',
      title: 'Unlike is guarded by SREM and decrements',
      detail:
        '`SREM liked:{post} user` returning 0 → `409`; otherwise `DECR likes:{post}` so the counter stays equal to the set size.',
      match: {
        python: {order: [/\.srem\(\s*f"liked:\{/, /\.decr\(\s*f"likes:\{/]},
        go: {order: [/\.SRem\(\s*[^\n]*"liked:/, /\.Decr\(\s*[^\n]*"likes:/]},
        scala: {order: [/\.srem\(\s*s"liked:\$/, /\.decr\(\s*s"likes:\$/]},
        cpp: {order: [/\.srem\(\s*"liked:"\s*\+/, /\.decr\(\s*"likes:"\s*\+/]},
      },
    },
    {
      id: 'event',
      title: 'Produces an engagement event keyed by post id, without waiting',
      detail:
        'The record goes to `engagement` with the post id as key; the request enqueues and returns instead of blocking on the broker.',
      match: {
        python: {
          all: [/produce\(\s*(TOPIC|"engagement")\s*,[^\n]*key\s*=\s*post_id/, /producer\.poll\(\s*0\s*\)/],
          none: [/producer\.flush\(/],
        },
        go: {all: [/Key:\s*\[\]byte\(\s*postID\s*\)/, /Async:\s*true/]},
        scala: {
          all: [/new ProducerRecord\[[^\]]*\]\(\s*(Topic|"engagement")\s*,\s*postId\s*,/, /producer\.send\(/],
          none: [/\.get\(\)/],
        },
        cpp: {
          all: [
            /produce\(\s*(kTopic|"engagement")[\s\S]{0,400}?post_id\.(c_str|data)\(\)\s*,\s*post_id\.(size|length)\(\)/,
            /producer->poll\(\s*0\s*\)/,
          ],
        },
      },
    },
    {
      id: 'count-read',
      title: 'GET returns 0 for a post nobody liked',
      detail:
        'Read `likes:{post}` and turn an absent key into `0` — a missing counter is the normal state of a fresh post.',
      match: {
        python: {all: [/\.get\(\s*f"likes:\{[^\n]*\)\s*or\s*0/]},
        go: {all: [/\.Get\(\s*[^\n]*"likes:"\s*\+/, /redis\.Nil/]},
        scala: {all: [/jedis\.get\(\s*s"likes:\$/, /getOrElse\(\s*0L?\s*\)|\.fold\(\s*0L?\s*\)/]},
        cpp: {all: [/redis\.get\(\s*"likes:"\s*\+/, /value_or\(\s*"0"\s*\)|\?\s*std::stoll\([^\n]*:\s*0/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time
import uuid

import redis
from confluent_kafka import Producer
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "linger.ms": 5})

TOPIC = "engagement"


def emit(kind: str, post_id: str, user_id: str) -> None:
    event = {"event_id": uuid.uuid4().hex, "type": kind, "post_id": post_id, "user_id": user_id, "ts": int(time.time() * 1000)}
    # TODO: produce to TOPIC keyed by post_id; poll(0) to serve callbacks; never block here
    raise NotImplementedError


@app.post("/posts/{post_id}/like")
def like(post_id: str, x_user_id: str = Header()) -> dict:
    # TODO: SADD liked:{post_id} user → 0 means already liked → 409
    # TODO: INCR likes:{post_id}, emit("like", ...), return {"likes": n}
    raise HTTPException(status_code=501)


@app.delete("/posts/{post_id}/like")
def unlike(post_id: str, x_user_id: str = Header()) -> dict:
    # TODO: SREM liked:{post_id} user → 0 means not liked → 409
    # TODO: DECR likes:{post_id}, emit("unlike", ...), return {"likes": n}
    raise HTTPException(status_code=501)


@app.get("/posts/{post_id}/likes")
def likes(post_id: str) -> dict:
    # TODO: GET likes:{post_id}; 0 when the key does not exist
    raise HTTPException(status_code=501)
`,
      solution: `import json
import time
import uuid

import redis
from confluent_kafka import Producer
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "linger.ms": 5})

TOPIC = "engagement"


def emit(kind: str, post_id: str, user_id: str) -> None:
    event = {"event_id": uuid.uuid4().hex, "type": kind, "post_id": post_id, "user_id": user_id, "ts": int(time.time() * 1000)}
    producer.produce(TOPIC, key=post_id, value=json.dumps(event))
    producer.poll(0)  # serve delivery callbacks; returns immediately


@app.post("/posts/{post_id}/like")
def like(post_id: str, x_user_id: str = Header()) -> dict:
    if r.sadd(f"liked:{post_id}", x_user_id) == 0:
        raise HTTPException(status_code=409, detail="already liked")
    count = r.incr(f"likes:{post_id}")
    emit("like", post_id, x_user_id)
    return {"likes": count}


@app.delete("/posts/{post_id}/like")
def unlike(post_id: str, x_user_id: str = Header()) -> dict:
    if r.srem(f"liked:{post_id}", x_user_id) == 0:
        raise HTTPException(status_code=409, detail="not liked")
    count = r.decr(f"likes:{post_id}")
    emit("unlike", post_id, x_user_id)
    return {"likes": count}


@app.get("/posts/{post_id}/likes")
def likes(post_id: str) -> dict:
    return {"likes": int(r.get(f"likes:{post_id}") or 0)}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "engagement",
	Balancer:     &kafka.Hash{},
	BatchTimeout: 5 * time.Millisecond,
	// TODO: Async writes with a Completion callback that logs failures
}

func emit(ctx context.Context, kind, postID, userID string) {
	value, _ := json.Marshal(map[string]any{"event_id": uuid.NewString(), "type": kind, "post_id": postID, "user_id": userID, "ts": time.Now().UnixMilli()})
	// TODO: WriteMessages with the post id as Key; never block the request on the broker
	_ = value
}

func writeJSON(w http.ResponseWriter, status int, likes int64) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]int64{"likes": likes})
}

func like(w http.ResponseWriter, r *http.Request) {
	postID, userID := r.PathValue("id"), r.Header.Get("X-User-Id")
	// TODO: SAdd liked:{postID} userID → 0 means already liked → 409
	// TODO: Incr likes:{postID}, emit("like", ...), writeJSON 200
	_, _ = postID, userID
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func unlike(w http.ResponseWriter, r *http.Request) {
	postID, userID := r.PathValue("id"), r.Header.Get("X-User-Id")
	// TODO: SRem liked:{postID} userID → 0 means not liked → 409
	// TODO: Decr likes:{postID}, emit("unlike", ...), writeJSON 200
	_, _ = postID, userID
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func likeCount(w http.ResponseWriter, r *http.Request) {
	// TODO: Get likes:{id}; redis.Nil → 0
	_ = errors.Is
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /posts/{id}/like", like)
	mux.HandleFunc("DELETE /posts/{id}/like", unlike)
	mux.HandleFunc("GET /posts/{id}/likes", likeCount)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "engagement",
	Balancer:     &kafka.Hash{},
	BatchTimeout: 5 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d engagement events not delivered: %v", len(messages), err)
		}
	},
}

func emit(ctx context.Context, kind, postID, userID string) {
	value, _ := json.Marshal(map[string]any{"event_id": uuid.NewString(), "type": kind, "post_id": postID, "user_id": userID, "ts": time.Now().UnixMilli()})
	// Async writer: this enqueues and returns; Completion reports the outcome.
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(postID), Value: value})
}

func writeJSON(w http.ResponseWriter, status int, likes int64) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]int64{"likes": likes})
}

func like(w http.ResponseWriter, r *http.Request) {
	postID, userID := r.PathValue("id"), r.Header.Get("X-User-Id")
	added, err := rdb.SAdd(r.Context(), "liked:"+postID, userID).Result()
	if err != nil {
		http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
		return
	}
	if added == 0 {
		http.Error(w, "already liked", http.StatusConflict)
		return
	}
	likes, _ := rdb.Incr(r.Context(), "likes:"+postID).Result()
	emit(r.Context(), "like", postID, userID)
	writeJSON(w, http.StatusOK, likes)
}

func unlike(w http.ResponseWriter, r *http.Request) {
	postID, userID := r.PathValue("id"), r.Header.Get("X-User-Id")
	removed, err := rdb.SRem(r.Context(), "liked:"+postID, userID).Result()
	if err != nil {
		http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
		return
	}
	if removed == 0 {
		http.Error(w, "not liked", http.StatusConflict)
		return
	}
	likes, _ := rdb.Decr(r.Context(), "likes:"+postID).Result()
	emit(r.Context(), "unlike", postID, userID)
	writeJSON(w, http.StatusOK, likes)
}

func likeCount(w http.ResponseWriter, r *http.Request) {
	likes, err := rdb.Get(r.Context(), "likes:"+r.PathValue("id")).Int64()
	if errors.Is(err, redis.Nil) {
		likes = 0
	} else if err != nil {
		http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, likes)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /posts/{id}/like", like)
	mux.HandleFunc("DELETE /posts/{id}/like", unlike)
	mux.HandleFunc("GET /posts/{id}/likes", likeCount)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.{Properties, UUID}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import feed.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

object Likes {
  val Topic = "engagement"
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def emit(kind: String, postId: String, userId: String): Unit = {
    val value = s"""{"event_id":"\${UUID.randomUUID()}","type":"$kind","post_id":"$postId","user_id":"$userId","ts":\${System.currentTimeMillis()}}"""
    // TODO: send a record keyed by postId; do not block on the future
  }

  private def countJson(n: Long) = HttpEntity(ContentTypes.\`application/json\`, s"""{"likes":$n}""")

  val route: Route =
    headerValueByName("X-User-Id") { userId =>
      concat(
        path("posts" / Segment / "like") { postId =>
          concat(
            post {
              // TODO: sadd liked:{postId} userId → 0 means already liked → 409
              // TODO: incr likes:{postId}, emit("like", ...), complete(countJson(n))
              complete(StatusCodes.NotImplemented)
            },
            delete {
              // TODO: srem liked:{postId} userId → 0 means not liked → 409
              // TODO: decr likes:{postId}, emit("unlike", ...), complete(countJson(n))
              complete(StatusCodes.NotImplemented)
            },
          )
        },
        path("posts" / Segment / "likes") { postId =>
          get {
            // TODO: get likes:{postId}; 0 when the key does not exist
            complete(StatusCodes.NotImplemented)
          }
        },
      )
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("likes")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.util.{Properties, UUID}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import feed.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

object Likes {
  val Topic = "engagement"
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def emit(kind: String, postId: String, userId: String): Unit = {
    val value = s"""{"event_id":"\${UUID.randomUUID()}","type":"$kind","post_id":"$postId","user_id":"$userId","ts":\${System.currentTimeMillis()}}"""
    producer.send(new ProducerRecord[String, String](Topic, postId, value)) // enqueues; the future is not awaited
  }

  private def countJson(n: Long) = HttpEntity(ContentTypes.\`application/json\`, s"""{"likes":$n}""")

  val route: Route =
    headerValueByName("X-User-Id") { userId =>
      concat(
        path("posts" / Segment / "like") { postId =>
          concat(
            post {
              if (jedis.sadd(s"liked:$postId", userId) == 0) complete(StatusCodes.Conflict -> "already liked")
              else {
                val likes = jedis.incr(s"likes:$postId")
                emit("like", postId, userId)
                complete(countJson(likes))
              }
            },
            delete {
              if (jedis.srem(s"liked:$postId", userId) == 0) complete(StatusCodes.Conflict -> "not liked")
              else {
                val likes = jedis.decr(s"likes:$postId")
                emit("unlike", postId, userId)
                complete(countJson(likes))
              }
            },
          )
        },
        path("posts" / Segment / "likes") { postId =>
          get {
            complete(countJson(Option(jedis.get(s"likes:$postId")).map(_.toLong).getOrElse(0L)))
          }
        },
      )
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("likes")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <memory>
#include <string>

#include "feed/uuid.h"  // std::string uuid4() — provided

const std::string kTopic = "engagement";
sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("linger.ms", "5", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void emit(const std::string& kind, const std::string& post_id, const std::string& user_id) {
  const auto ts = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"event_id\\":\\"" + uuid4() + "\\",\\"type\\":\\"" + kind + "\\",\\"post_id\\":\\"" + post_id +
                      "\\",\\"user_id\\":\\"" + user_id + "\\",\\"ts\\":" + std::to_string(ts) + "}";
  // TODO: produce to kTopic keyed by post_id (RK_MSG_COPY); poll(0) to serve callbacks; never block here
}

static void count_json(httplib::Response& res, long long n) {
  res.set_content("{\\"likes\\":" + std::to_string(n) + "}", "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/posts/([\\w-]+)/like)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string post_id = req.matches[1];
    const std::string user_id = req.get_header_value("X-User-Id");
    // TODO: sadd liked:{post_id} user_id → 0 means already liked → 409
    // TODO: incr likes:{post_id}, emit("like", ...), count_json
    res.status = 501;
  });

  svr.Delete(R"(/posts/([\\w-]+)/like)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string post_id = req.matches[1];
    const std::string user_id = req.get_header_value("X-User-Id");
    // TODO: srem liked:{post_id} user_id → 0 means not liked → 409
    // TODO: decr likes:{post_id}, emit("unlike", ...), count_json
    res.status = 501;
  });

  svr.Get(R"(/posts/([\\w-]+)/likes)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string post_id = req.matches[1];
    // TODO: get likes:{post_id}; 0 when the key does not exist
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <memory>
#include <string>

#include "feed/uuid.h"  // std::string uuid4() — provided

const std::string kTopic = "engagement";
sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("linger.ms", "5", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void emit(const std::string& kind, const std::string& post_id, const std::string& user_id) {
  const auto ts = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"event_id\\":\\"" + uuid4() + "\\",\\"type\\":\\"" + kind + "\\",\\"post_id\\":\\"" + post_id +
                      "\\",\\"user_id\\":\\"" + user_id + "\\",\\"ts\\":" + std::to_string(ts) + "}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    value.data(), value.size(), post_id.c_str(), post_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

static void count_json(httplib::Response& res, long long n) {
  res.set_content("{\\"likes\\":" + std::to_string(n) + "}", "application/json");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/posts/([\\w-]+)/like)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string post_id = req.matches[1];
    const std::string user_id = req.get_header_value("X-User-Id");
    if (redis.sadd("liked:" + post_id, user_id) == 0) {
      res.status = 409;
      res.set_content("already liked", "text/plain");
      return;
    }
    const long long likes = redis.incr("likes:" + post_id);
    emit("like", post_id, user_id);
    count_json(res, likes);
  });

  svr.Delete(R"(/posts/([\\w-]+)/like)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string post_id = req.matches[1];
    const std::string user_id = req.get_header_value("X-User-Id");
    if (redis.srem("liked:" + post_id, user_id) == 0) {
      res.status = 409;
      res.set_content("not liked", "text/plain");
      return;
    }
    const long long likes = redis.decr("likes:" + post_id);
    emit("unlike", post_id, user_id);
    count_json(res, likes);
  });

  svr.Get(R"(/posts/([\\w-]+)/likes)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string post_id = req.matches[1];
    count_json(res, std::stoll(redis.get("likes:" + post_id).value_or("0")));
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The set is the fact ("alice likes p1") and the counter is a derived number; letting \`SADD\`'s return value gate the \`INCR\` is what makes a retried request harmless. Keying the engagement event by post id keeps a post's likes and unlikes in order on one partition, and the fire-and-forget produce keeps the broker off the request path. Real systems make the two Redis commands atomic (a Lua script or \`MULTI\`), keep the sets in a sharded cluster because \`liked:{post}\` of a viral post has millions of members, and eventually move the counter to the rollup stream of step 6 so the request path only writes the fact.`,
};
