import type {Step} from '@/lib/types';

export const topLinksStep: Step = {
  id: 'top-links',
  title: 'Top links: a per-day sorted set from the click stream',
  concept: 'redis',
  file: 'top_links',
  focus: ['kafka', 'worker', 'redis'],
  task: `## Task

Implement the **top-links** worker: a member of consumer group \`top-links\` that reads \`clicks\` and
keeps one sorted set per day, plus the endpoint that reads it. \`day_key(ts)\` is provided and returns
\`top:YYYY-MM-DD\` for a click timestamp.

- Disable auto-commit. Auto-commit acknowledges records on a timer, *before* you know they were
  counted; a crash then loses clicks silently.
- For every record: parse the JSON, \`ZINCRBY top:{day} 1 code\`, \`EXPIRE\` the day key to **7 days**
  (re-arming it on every click is fine; \`NX\` if your client supports it), **then** commit the offset.
  Committing after the side effect is **at-least-once**: a crash between the two replays the record
  and over-counts by one instead of losing it — the right trade-off for a leaderboard.
- Skip malformed records (log and commit) rather than crash-looping on a poison message.
- \`GET /top?day=YYYY-MM-DD\` (default: today) answers the **10** most clicked codes with their counts:
  \`ZREVRANGE top:{day} 0 9 WITHSCORES\` → \`[{"code": …, "clicks": …}, …]\`.

:::widget consumer-groups {"partitions": 6}

:::widget delivery-semantics {}`,
  sequence: {
    participants: ['Kafka', 'top-links', 'Redis', 'Client'],
    messages: [
      {from: 'Kafka', to: 'top-links', label: 'poll → record (partition 2, offset 52 019)', kind: 'reply'},
      {from: 'top-links', to: 'Redis', label: 'ZINCRBY top:2026-10-05 1 g9Xc', kind: 'sync'},
      {from: 'Redis', to: 'top-links', label: '"8213"', kind: 'reply'},
      {from: 'top-links', to: 'Redis', label: 'EXPIRE top:2026-10-05 604800', kind: 'sync'},
      {from: 'top-links', to: 'Kafka', label: 'commit offset 52 020 (partition 2)', kind: 'sync'},
      {from: 'Client', to: 'top-links', label: 'GET /top?day=2026-10-05', kind: 'sync'},
      {from: 'top-links', to: 'Redis', label: 'ZREVRANGE top:2026-10-05 0 9 WITHSCORES', kind: 'sync'},
    ],
  },
  hints: [
    'Consumer configuration is where auto-commit is disabled (`enable.auto.commit=false`; in kafka-go, use `FetchMessage` + `CommitMessages` instead of `ReadMessage`).',
    'The order inside the loop is the whole point: ZINCRBY and EXPIRE first, commit second. Never the other way round.',
    'ZINCRBY creates the key and the member when they do not exist, so the worker needs no setup; the endpoint builds `top:{day}` from the query parameter and reads the top 10 as (member, score) pairs — `0 9` is inclusive.',
  ],
  checks: [
    {
      id: 'consumer',
      title: 'Joins consumer group top-links on clicks with auto-commit off',
      detail:
        'The consumer uses `group.id` `top-links`, subscribes to `clicks`, and commits offsets explicitly after processing — not on a timer.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"top-links"/,
            /subscribe\(\s*\[\s*"clicks"\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        go: {all: [/GroupID:\s*"top-links"/, /Topic:\s*"clicks"/, /reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {
          all: [
            /"group\.id"\s*,\s*"top-links"|GROUP_ID_CONFIG\s*,\s*"top-links"/,
            /subscribe\([^\n]*"clicks"/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
          ],
        },
        cpp: {
          all: [/"group\.id"\s*,\s*"top-links"/, /subscribe\([^\n]*"clicks"/, /"enable\.auto\.commit"\s*,\s*"false"/],
        },
      },
    },
    {
      id: 'zincrby',
      title: 'Increments the code in the day’s sorted set',
      detail:
        'Each click is `ZINCRBY top:{day} 1 code` on the key `day_key(ts)` gives you — atomic in Redis, and the set stays sorted by count.',
      match: {
        python: {all: [/\br\.zincrby\(\s*\w+\s*,\s*1(\.0)?\s*,/, /(?<!def )day_key\(/]},
        go: {all: [/rdb\.ZIncrBy\(\s*ctx\s*,\s*\w+\s*,\s*1(\.0)?\s*,/, /(?<!func )dayKey\(/]},
        scala: {all: [/jedis\.zincrby\(\s*\w+\s*,\s*1(\.0|d)?\s*,/, /(?<!def )dayKey\(/]},
        cpp: {all: [/redis\.zincrby\(\s*\w+\s*,\s*1(\.0)?\s*,/, /(?<!string )day_key\(/]},
      },
    },
    {
      id: 'expire',
      title: 'Day keys expire after 7 days',
      detail: 'Set a 7-day expiry (`RETENTION_S`) on the day key so the leaderboards do not accumulate forever.',
      match: {
        python: {all: [/\br\.expire\(\s*\w+\s*,\s*(RETENTION_S|604800|7\s*\*\s*24)/]},
        go: {all: [/rdb\.Expire(NX)?\(\s*ctx\s*,\s*\w+\s*,\s*(retention|7\s*\*\s*24)/]},
        scala: {all: [/jedis\.expire\(\s*\w+\s*,\s*(RetentionSeconds|604800L?|7\s*\*\s*24)/]},
        cpp: {
          all: [
            /redis\.expire\(\s*\w+\s*,\s*(kRetention|std::chrono::seconds\{?\(?\s*604800|std::chrono::hours\{?\(?\s*(168|7\s*\*\s*24))/,
          ],
        },
      },
    },
    {
      id: 'commit-after',
      title: 'Commits after the increment',
      detail: 'Commit the offset only once the sorted set has been updated: at-least-once, never at-most-once.',
      match: {
        python: {order: [/\br\.zincrby\(/, /consumer\.commit\(/]},
        go: {order: [/rdb\.ZIncrBy\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/jedis\.zincrby\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/redis\.zincrby\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'top-endpoint',
      title: 'GET /top reads the 10 highest scores with their counts',
      detail:
        'The endpoint reads `top:{day}` in descending score order with scores (`ZREVRANGE … 0 9 WITHSCORES` or `ZRANGE … REV WITHSCORES`) and answers `[{code, clicks}]`.',
      match: {
        python: {
          all: [
            /\br\.zrevrange\([^\n]*withscores\s*=\s*True|\br\.zrange\([^\n]*desc\s*=\s*True[^\n]*withscores\s*=\s*True/,
            /TOP_N\s*-\s*1|\b9\b/,
          ],
        },
        go: {all: [/ZRevRangeWithScores\(|ZRangeArgsWithScores\(/, /topN\s*-\s*1|\b9\b/]},
        scala: {all: [/zrevrangeWithScores\(|zrangeWithScores\([^\n]*rev/, /TopN\s*-\s*1|\b9\b/]},
        cpp: {all: [/redis\.zrevrange\(/, /pair<std::string,\s*double>/, /kTopN\s*-\s*1|\b9\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import threading
from datetime import date, datetime, timezone

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI

app = FastAPI()
log = logging.getLogger("top-links")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOP_N = 10
RETENTION_S = 7 * 24 * 3600

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "top-links",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["clicks"])


def day_key(ts: float) -> str:
    """top:YYYY-MM-DD for a click timestamp (provided)."""
    return "top:" + datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse JSON (skip + commit malformed records)
        # TODO: ZINCRBY day_key(ts) 1 code; EXPIRE the key to RETENTION_S; then commit this message
        raise NotImplementedError


@app.get("/top")
def top(day: str | None = None) -> list[dict]:
    key = f"top:{day or date.today().isoformat()}"
    # TODO: ZREVRANGE key 0 TOP_N-1 WITHSCORES → [{"code": …, "clicks": …}]
    return []


threading.Thread(target=run, daemon=True).start()
`,
      solution: `import json
import logging
import threading
from datetime import date, datetime, timezone

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI

app = FastAPI()
log = logging.getLogger("top-links")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOP_N = 10
RETENTION_S = 7 * 24 * 3600

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "top-links",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["clicks"])


def day_key(ts: float) -> str:
    """top:YYYY-MM-DD for a click timestamp (provided)."""
    return "top:" + datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        try:
            event = json.loads(msg.value())
            code, ts = str(event["code"]), float(event["ts"])
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        key = day_key(ts)
        r.zincrby(key, 1, code)
        r.expire(key, RETENTION_S)
        consumer.commit(message=msg, asynchronous=False)


@app.get("/top")
def top(day: str | None = None) -> list[dict]:
    key = f"top:{day or date.today().isoformat()}"
    rows = r.zrevrange(key, 0, TOP_N - 1, withscores=True)
    return [{"code": code, "clicks": int(score)} for code, score in rows]


threading.Thread(target=run, daemon=True).start()
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topN      = 10
	retention = 7 * 24 * time.Hour
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "top-links",
	Topic:   "clicks",
})

type clickEvent struct {
	Code string  \`json:"code"\`
	Ts   float64 \`json:"ts"\`
}

type entry struct {
	Code   string \`json:"code"\`
	Clicks int64  \`json:"clicks"\`
}

// dayKey is top:YYYY-MM-DD for a click timestamp (provided).
func dayKey(ts float64) string {
	return "top:" + time.Unix(int64(ts), 0).UTC().Format("2006-01-02")
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse JSON (skip + commit malformed records)
		// TODO: ZIncrBy dayKey(ts) 1 code; Expire the key to retention; then CommitMessages for this message
		_ = json.Unmarshal
		return nil
	}
}

func top(rw http.ResponseWriter, r *http.Request) {
	day := r.URL.Query().Get("day")
	if day == "" {
		day = time.Now().UTC().Format("2006-01-02")
	}
	// TODO: ZRevRangeWithScores top:{day} 0 topN-1 → []entry
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode([]entry{})
}

func main() {
	go func() { log.Fatal(run(context.Background())) }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /top", top)
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topN      = 10
	retention = 7 * 24 * time.Hour
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "top-links",
	Topic:   "clicks",
})

type clickEvent struct {
	Code string  \`json:"code"\`
	Ts   float64 \`json:"ts"\`
}

type entry struct {
	Code   string \`json:"code"\`
	Clicks int64  \`json:"clicks"\`
}

// dayKey is top:YYYY-MM-DD for a click timestamp (provided).
func dayKey(ts float64) string {
	return "top:" + time.Unix(int64(ts), 0).UTC().Format("2006-01-02")
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event clickEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.Code == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		key := dayKey(event.Ts)
		if err := rdb.ZIncrBy(ctx, key, 1, event.Code).Err(); err != nil {
			return err // do not commit: the record will be redelivered
		}
		rdb.Expire(ctx, key, retention)
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}

func top(rw http.ResponseWriter, r *http.Request) {
	day := r.URL.Query().Get("day")
	if day == "" {
		day = time.Now().UTC().Format("2006-01-02")
	}
	rows, err := rdb.ZRevRangeWithScores(r.Context(), "top:"+day, 0, topN-1).Result()
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	out := make([]entry, 0, len(rows))
	for _, z := range rows {
		out = append(out, entry{Code: z.Member.(string), Clicks: int64(z.Score)})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(out)
}

func main() {
	go func() { log.Fatal(run(context.Background())) }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /top", top)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.{Duration, Instant, LocalDate, ZoneOffset}
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import shortener.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import spray.json._

object TopLinks {
  val jedis = new JedisPooled("redis", 6379)
  val TopN = 10
  val RetentionSeconds = 7L * 24 * 3600

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "top-links")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("clicks").asJava)

  /** top:YYYY-MM-DD for a click timestamp (provided). */
  def dayKey(ts: Double): String =
    "top:" + LocalDate.ofInstant(Instant.ofEpochSecond(ts.toLong), ZoneOffset.UTC).toString

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the JSON (skip malformed records)
        // TODO: ZINCRBY dayKey(ts) 1 code; EXPIRE the key to RetentionSeconds
      }
      // TODO: commit synchronously after the batch is processed
    }

  val route: Route =
    path("top") {
      get {
        parameters("day".withDefault(LocalDate.now(ZoneOffset.UTC).toString)) { day =>
          val key = s"top:$day"
          // TODO: ZREVRANGE key 0 TopN-1 WITHSCORES → [{"code": …, "clicks": …}]
          complete(HttpEntity(ContentTypes.\`application/json\`, "[]"))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    new Thread(() => run()).start()
    implicit val system: ActorSystem = ActorSystem("top-links")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.time.{Duration, Instant, LocalDate, ZoneOffset}
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import shortener.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import spray.json._

object TopLinks {
  val jedis = new JedisPooled("redis", 6379)
  val TopN = 10
  val RetentionSeconds = 7L * 24 * 3600

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "top-links")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("clicks").asJava)

  /** top:YYYY-MM-DD for a click timestamp (provided). */
  def dayKey(ts: Double): String =
    "top:" + LocalDate.ofInstant(Instant.ofEpochSecond(ts.toLong), ZoneOffset.UTC).toString

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        Try(record.value().parseJson.asJsObject.fields).toOption.flatMap { fields =>
          (fields.get("code"), fields.get("ts")) match {
            case (Some(JsString(code)), Some(JsNumber(ts))) => Some((code, ts.toDouble))
            case _ => None
          }
        } match {
          case Some((code, ts)) =>
            val key = dayKey(ts)
            jedis.zincrby(key, 1.0, code)
            jedis.expire(key, RetentionSeconds)
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every record of the batch has been counted
    }

  val route: Route =
    path("top") {
      get {
        parameters("day".withDefault(LocalDate.now(ZoneOffset.UTC).toString)) { day =>
          val key = s"top:$day"
          val rows = jedis.zrevrangeWithScores(key, 0, TopN - 1).asScala.map { t =>
            JsObject("code" -> JsString(t.getElement), "clicks" -> JsNumber(t.getScore.toLong))
          }
          complete(HttpEntity(ContentTypes.\`application/json\`, JsArray(rows.toVector).compactPrint))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    new Thread(() => run()).start()
    implicit val system: ActorSystem = ActorSystem("top-links")
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
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kTopN = 10;
constexpr std::chrono::seconds kRetention{7 * 24 * 3600};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "top-links", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"clicks"});
  return consumer;
}

auto consumer = make_consumer();

// top:YYYY-MM-DD for a click timestamp (provided).
std::string day_key(double ts) {
  const std::time_t t = static_cast<std::time_t>(ts);
  char buf[16];
  std::strftime(buf, sizeof buf, "%Y-%m-%d", std::gmtime(&t));
  return std::string("top:") + buf;
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    // TODO: skip + commit malformed records (not an object, no string "code", no number "ts")
    // TODO: zincrby day_key(ts) 1 code; expire the key to kRetention; then commitSync this message
  }
}

int main() {
  std::thread(run).detach();
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/top", [](const httplib::Request& req, httplib::Response& res) {
    const std::string day = req.has_param("day") ? req.get_param_value("day") : day_key(std::time(nullptr)).substr(4);
    const std::string key = "top:" + day;
    // TODO: ZREVRANGE key 0 kTopN-1 WITHSCORES → [{"code": …, "clicks": …}]
    res.set_content("[]", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kTopN = 10;
constexpr std::chrono::seconds kRetention{7 * 24 * 3600};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "top-links", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"clicks"});
  return consumer;
}

auto consumer = make_consumer();

// top:YYYY-MM-DD for a click timestamp (provided).
std::string day_key(double ts) {
  const std::time_t t = static_cast<std::time_t>(ts);
  char buf[16];
  std::strftime(buf, sizeof buf, "%Y-%m-%d", std::gmtime(&t));
  return std::string("top:") + buf;
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    if (!event.is_object() || !event.contains("code") || !event["code"].is_string() || !event["ts"].is_number()) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string key = day_key(event["ts"].get<double>());
    redis.zincrby(key, 1, event["code"].get<std::string>());
    redis.expire(key, kRetention);
    consumer->commitSync(msg.get());
  }
}

int main() {
  std::thread(run).detach();
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/top", [](const httplib::Request& req, httplib::Response& res) {
    const std::string day = req.has_param("day") ? req.get_param_value("day") : day_key(std::time(nullptr)).substr(4);
    const std::string key = "top:" + day;
    std::vector<std::pair<std::string, double>> rows;
    redis.zrevrange(key, 0, kTopN - 1, std::back_inserter(rows));
    json out = json::array();
    for (const auto& [code, score] : rows) out.push_back({{"code", code}, {"clicks", static_cast<long long>(score)}});
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `A sorted set is the leaderboard data structure: ZINCRBY keeps it ordered on every write, and the top 10 is one O(log n + 10) read — no scan, no sort at query time. Keying by day gives a natural partition and a natural expiry; a 7-day TTL bounds memory without any cleanup job. Where the commit sits relative to the increment decides the guarantee: process-then-commit is at-least-once, and a leaderboard can afford a rare duplicate. Real analytics pipelines also keep a hourly set, merge days with ZUNIONSTORE for "this week", and write the raw clicks to a warehouse for the questions a sorted set cannot answer (clicks by country, by referrer).`,
};
