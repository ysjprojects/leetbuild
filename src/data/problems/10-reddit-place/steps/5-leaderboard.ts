import type {Step} from '@/lib/types';

export const leaderboardStep: Step = {
  id: 'leaderboard',
  title: 'Leaderboard and per-pixel history from the placements stream',
  concept: 'redis',
  file: 'leaderboard',
  focus: ['kafka', 'worker', 'redis'],
  task: `## Task

Implement the **leaderboard** worker — a member of consumer group \`leaderboard\` reading \`placements\` —
and the two endpoints that read what it keeps. \`history_key(x, y)\` is provided and returns
\`history:{x}:{y}\`.

- Disable auto-commit. Auto-commit acknowledges records on a timer, *before* you know they were
  counted; a crash then loses tiles silently.
- For every record: parse the JSON, then
  \`ZINCRBY place:leaders 1 {user}\` (one more tile for the user) and
  \`LPUSH history:{x}:{y} {"user", "color", "ts"}\` + \`LTRIM history:{x}:{y} 0 9\` (the last
  **\`HISTORY_LEN\`** = 10 placements on that pixel, newest first), **then** commit the offset.
  Committing after the writes is at-least-once: a crash between the two replays the record and
  over-counts by one instead of losing it — the right trade-off for a scoreboard.
- Skip malformed records (log and commit) rather than crash-looping on a poison message.
- \`GET /top\` answers the **10** users with the most tiles: \`ZREVRANGE place:leaders 0 9 WITHSCORES\` →
  \`[{"user": …, "tiles": …}, …]\`.
- \`GET /history?x=&y=\` answers the pixel's recent placements newest first (**400** when \`x\`/\`y\` are
  outside \`[0, SIZE)\`): \`LRANGE history:{x}:{y} 0 9\` → \`[{"user", "color", "ts"}, …]\`.

:::widget consumer-groups {"partitions": 8}

:::widget delivery-semantics {}

> "Who placed this pixel?" was the most popular request of the original and the only one the CDN
> could not cache. Answering it from a 10-element list is one O(1) Redis read instead of a
> wide-table lookup per hover.`,
  sequence: {
    participants: ['Kafka', 'leaderboard', 'Redis', 'Client'],
    messages: [
      {
        from: 'Kafka',
        to: 'leaderboard',
        label: 'poll → {ana, 3, 7, 12, ts} (partition 2, offset 41 207)',
        kind: 'reply',
      },
      {from: 'leaderboard', to: 'Redis', label: 'ZINCRBY place:leaders 1 ana', kind: 'sync'},
      {
        from: 'leaderboard',
        to: 'Redis',
        label: 'LPUSH history:3:7 {ana, 12, ts} · LTRIM history:3:7 0 9',
        kind: 'sync',
      },
      {from: 'leaderboard', to: 'Kafka', label: 'commit offset 41 208 (partition 2)', kind: 'sync'},
      {from: 'Client', to: 'leaderboard', label: 'GET /top', kind: 'sync'},
      {from: 'leaderboard', to: 'Redis', label: 'ZREVRANGE place:leaders 0 9 WITHSCORES', kind: 'sync'},
      {from: 'Client', to: 'leaderboard', label: 'GET /history?x=3&y=7', kind: 'sync'},
      {from: 'leaderboard', to: 'Redis', label: 'LRANGE history:3:7 0 9', kind: 'sync'},
    ],
  },
  hints: [
    'Consumer configuration is where auto-commit is disabled (`enable.auto.commit=false`; in kafka-go, use `FetchMessage` + `CommitMessages` instead of `ReadMessage`).',
    'The order inside the loop is the whole point: ZINCRBY, LPUSH, LTRIM first, commit second. LPUSH + LTRIM 0 HISTORY_LEN-1 is the idiom for "a capped list, newest first" — the trim bound is inclusive.',
    'ZINCRBY creates the key and the member when they do not exist, so the worker needs no setup; `/top` reads (member, score) pairs in descending order — `0 9` is inclusive — and `/history` validates the coordinates before building the key.',
  ],
  checks: [
    {
      id: 'consumer',
      title: 'Joins consumer group leaderboard on placements with auto-commit off',
      detail:
        'The consumer uses `group.id` `leaderboard`, subscribes to `placements`, and commits offsets explicitly after processing — not on a timer.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"leaderboard"/,
            /subscribe\(\s*\[\s*"placements"\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        go: {
          all: [/GroupID:\s*"leaderboard"/, /Topic:\s*"placements"/, /reader\.FetchMessage\(/],
          none: [/ReadMessage\(/],
        },
        scala: {
          all: [
            /"group\.id"\s*,\s*"leaderboard"|GROUP_ID_CONFIG\s*,\s*"leaderboard"/,
            /subscribe\([^\n]*"placements"/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*"leaderboard"/,
            /subscribe\([^\n]*"placements"/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
          ],
        },
      },
    },
    {
      id: 'zincrby',
      title: 'Counts one tile per placement in the leaders sorted set',
      detail: 'Each record is `ZINCRBY place:leaders 1 user` — atomic in Redis, and the set stays sorted by count.',
      match: {
        python: {all: [/\br\.zincrby\(\s*LEADERS_KEY\s*,\s*1(\.0)?\s*,/]},
        go: {all: [/rdb\.ZIncrBy\(\s*ctx\s*,\s*leadersKey\s*,\s*1(\.0)?\s*,/]},
        scala: {all: [/jedis\.zincrby\(\s*LeadersKey\s*,\s*1(\.0|d)?\s*,/]},
        cpp: {all: [/redis\.zincrby\(\s*kLeadersKey\s*,\s*1(\.0)?\s*,/]},
      },
    },
    {
      id: 'history-capped',
      title: 'Keeps the last 10 placements per pixel, newest first',
      detail:
        'Each record is `LPUSH history:{x}:{y} …` followed by `LTRIM history:{x}:{y} 0 HISTORY_LEN-1` so no pixel’s list grows past 10.',
      match: {
        python: {
          all: [
            /\br\.lpush\(/,
            /\br\.ltrim\(\s*\w+\s*,\s*0\s*,\s*(HISTORY_LEN\s*-\s*1|9)\s*\)/,
            /(?<!def )history_key\(/,
          ],
        },
        go: {
          all: [
            /rdb\.LPush\(/,
            /rdb\.LTrim\(\s*ctx\s*,\s*\w+\s*,\s*0\s*,\s*(historyLen\s*-\s*1|9)\s*\)/,
            /(?<!func )historyKey\(/,
          ],
        },
        scala: {
          all: [
            /jedis\.lpush\(/,
            /jedis\.ltrim\(\s*\w+\s*,\s*0L?\s*,\s*(HistoryLen\s*-\s*1|9L?)\s*\)/,
            /(?<!def )historyKey\(/,
          ],
        },
        cpp: {
          all: [
            /redis\.lpush\(/,
            /redis\.ltrim\(\s*\w+\s*,\s*0\s*,\s*(kHistoryLen\s*-\s*1|9)\s*\)/,
            /(?<!string )history_key\(/,
          ],
        },
      },
    },
    {
      id: 'commit-after',
      title: 'Commits after the writes',
      detail:
        'Commit the offset only once the sorted set and the history list have been updated: at-least-once, never at-most-once.',
      match: {
        python: {order: [/\br\.zincrby\(/, /\br\.ltrim\(/, /consumer\.commit\(/]},
        go: {order: [/rdb\.ZIncrBy\(/, /rdb\.LTrim\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/jedis\.zincrby\(/, /jedis\.ltrim\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/redis\.zincrby\(/, /redis\.ltrim\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'endpoints',
      title: 'GET /top reads the 10 highest counts; GET /history reads a pixel’s list',
      detail:
        '`/top` reads `place:leaders` in descending score order with scores (`ZREVRANGE … 0 9 WITHSCORES`) into `[{user, tiles}]`; `/history` validates `x`/`y` (400) and reads `LRANGE history:{x}:{y} 0 9`.',
      match: {
        python: {
          all: [
            /\br\.zrevrange\([^\n]*withscores\s*=\s*True|\br\.zrange\([^\n]*desc\s*=\s*True[^\n]*withscores\s*=\s*True/,
            /\br\.lrange\(/,
            /"tiles"/,
            /status_code\s*=\s*400/,
          ],
        },
        go: {
          all: [
            /ZRevRangeWithScores\(|ZRangeArgsWithScores\(/,
            /rdb\.LRange\(/,
            /"tiles"/,
            /http\.StatusBadRequest|\b400\b/,
          ],
        },
        scala: {
          all: [
            /zrevrangeWithScores\(|zrangeWithScores\([^\n]*rev/,
            /jedis\.lrange\(/,
            /"tiles"/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {all: [/redis\.zrevrange\(/, /redis\.lrange\(/, /"tiles"/, /status\s*=\s*400/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import threading
from contextlib import asynccontextmanager

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI, HTTPException


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=run, daemon=True).start()  # the worker lives beside the API
    yield


app = FastAPI(lifespan=lifespan)
log = logging.getLogger("leaderboard")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIZE = 100
TOP_N = 10
HISTORY_LEN = 10
LEADERS_KEY = "place:leaders"

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "leaderboard",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["placements"])


def history_key(x: int, y: int) -> str:
    """history:{x}:{y} (provided)."""
    return f"history:{x}:{y}"


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse JSON (skip + commit malformed records)
        # TODO: ZINCRBY LEADERS_KEY 1 user; LPUSH history_key(x, y) {"user", "color", "ts"}; LTRIM 0 HISTORY_LEN-1
        # TODO: then commit this message
        raise NotImplementedError


@app.get("/top")
def top() -> list[dict]:
    # TODO: ZREVRANGE LEADERS_KEY 0 TOP_N-1 WITHSCORES → [{"user": …, "tiles": …}]
    return []


@app.get("/history")
def history(x: int = -1, y: int = -1) -> list[dict]:
    # TODO: 400 unless 0 <= x, y < SIZE; LRANGE history_key(x, y) 0 HISTORY_LEN-1 → [{"user", "color", "ts"}]
    return []
`,
      solution: `import json
import logging
import threading
from contextlib import asynccontextmanager

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI, HTTPException


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=run, daemon=True).start()  # the worker lives beside the API
    yield


app = FastAPI(lifespan=lifespan)
log = logging.getLogger("leaderboard")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIZE = 100
TOP_N = 10
HISTORY_LEN = 10
LEADERS_KEY = "place:leaders"

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "leaderboard",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["placements"])


def history_key(x: int, y: int) -> str:
    """history:{x}:{y} (provided)."""
    return f"history:{x}:{y}"


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
            user, x, y = str(event["user"]), int(event["x"]), int(event["y"])
            entry = json.dumps({"user": user, "color": int(event["color"]), "ts": int(event["ts"])})
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        key = history_key(x, y)
        r.zincrby(LEADERS_KEY, 1, user)
        r.lpush(key, entry)
        r.ltrim(key, 0, HISTORY_LEN - 1)  # newest first, never more than 10
        consumer.commit(message=msg, asynchronous=False)


@app.get("/top")
def top() -> list[dict]:
    rows = r.zrevrange(LEADERS_KEY, 0, TOP_N - 1, withscores=True)
    return [{"user": user, "tiles": int(score)} for user, score in rows]


@app.get("/history")
def history(x: int = -1, y: int = -1) -> list[dict]:
    if not (0 <= x < SIZE and 0 <= y < SIZE):
        raise HTTPException(status_code=400, detail=f"x and y must be in [0, {SIZE})")
    return [json.loads(item) for item in r.lrange(history_key(x, y), 0, HISTORY_LEN - 1)]
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	size       = 100
	topN       = 10
	historyLen = 10
	leadersKey = "place:leaders"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "leaderboard",
	Topic:   "placements",
})

type placementEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type historyEntry struct {
	User  string \`json:"user"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type leader struct {
	User  string \`json:"user"\`
	Tiles int64  \`json:"tiles"\`
}

// historyKey is history:{x}:{y} (provided).
func historyKey(x, y int) string { return fmt.Sprintf("history:%d:%d", x, y) }

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse JSON (skip + commit malformed records)
		// TODO: ZIncrBy leadersKey 1 user; LPush historyKey(x, y) entry; LTrim 0 historyLen-1; then CommitMessages
		_ = json.Unmarshal
		return nil
	}
}

func top(rw http.ResponseWriter, r *http.Request) {
	// TODO: ZRevRangeWithScores leadersKey 0 topN-1 → []leader
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode([]leader{})
}

func history(rw http.ResponseWriter, r *http.Request) {
	x, errX := strconv.Atoi(r.URL.Query().Get("x"))
	y, errY := strconv.Atoi(r.URL.Query().Get("y"))
	// TODO: 400 unless both parse and 0 <= x, y < size; LRange historyKey(x, y) 0 historyLen-1 → []historyEntry
	_, _, _, _ = x, y, errX, errY
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode([]historyEntry{})
}

func main() {
	go func() { log.Fatal(run(context.Background())) }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /top", top)
	mux.HandleFunc("GET /history", history)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	size       = 100
	topN       = 10
	historyLen = 10
	leadersKey = "place:leaders"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "leaderboard",
	Topic:   "placements",
})

type placementEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type historyEntry struct {
	User  string \`json:"user"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

type leader struct {
	User  string \`json:"user"\`
	Tiles int64  \`json:"tiles"\`
}

// historyKey is history:{x}:{y} (provided).
func historyKey(x, y int) string { return fmt.Sprintf("history:%d:%d", x, y) }

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event placementEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.User == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		entry, _ := json.Marshal(historyEntry{User: event.User, Color: event.Color, Ts: event.Ts})
		key := historyKey(event.X, event.Y)
		if err := rdb.ZIncrBy(ctx, leadersKey, 1, event.User).Err(); err != nil {
			return err // do not commit: the record will be redelivered
		}
		rdb.LPush(ctx, key, entry)
		rdb.LTrim(ctx, key, 0, historyLen-1) // newest first, never more than 10
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}

func top(rw http.ResponseWriter, r *http.Request) {
	rows, err := rdb.ZRevRangeWithScores(r.Context(), leadersKey, 0, topN-1).Result()
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	out := make([]leader, 0, len(rows))
	for _, z := range rows {
		out = append(out, leader{User: z.Member.(string), Tiles: int64(z.Score)})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(out)
}

func history(rw http.ResponseWriter, r *http.Request) {
	x, errX := strconv.Atoi(r.URL.Query().Get("x"))
	y, errY := strconv.Atoi(r.URL.Query().Get("y"))
	if errX != nil || errY != nil || x < 0 || x >= size || y < 0 || y >= size {
		http.Error(rw, "x and y must be in [0, size)", http.StatusBadRequest)
		return
	}
	items, err := rdb.LRange(r.Context(), historyKey(x, y), 0, historyLen-1).Result()
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	out := make([]historyEntry, 0, len(items))
	for _, item := range items {
		var e historyEntry
		if json.Unmarshal([]byte(item), &e) == nil {
			out = append(out, e)
		}
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(out)
}

func main() {
	go func() { log.Fatal(run(context.Background())) }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /top", top)
	mux.HandleFunc("GET /history", history)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import place.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

object Leaderboard {
  val jedis = new JedisPooled("redis", 6379)
  val Size = 100
  val TopN = 10
  val HistoryLen = 10
  val LeadersKey = "place:leaders"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "leaderboard")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("placements").asJava)

  /** history:{x}:{y} (provided). */
  def historyKey(x: Int, y: Int): String = s"history:$x:$y"

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the JSON (skip malformed records)
        // TODO: ZINCRBY LeadersKey 1 user; LPUSH historyKey(x, y) {"user", "color", "ts"}; LTRIM 0 HistoryLen-1
      }
      // TODO: commit synchronously after the batch is processed
    }

  val route: Route =
    concat(
      path("top") {
        get {
          // TODO: ZREVRANGE LeadersKey 0 TopN-1 WITHSCORES → [{"user": …, "tiles": …}]
          complete(HttpEntity(ContentTypes.\`application/json\`, "[]"))
        }
      },
      path("history") {
        get {
          parameters("x".as[Int], "y".as[Int]) { (x, y) =>
            // TODO: 400 unless 0 <= x, y < Size; LRANGE historyKey(x, y) 0 HistoryLen-1 → [{"user", "color", "ts"}]
            complete(HttpEntity(ContentTypes.\`application/json\`, "[]"))
          }
        }
      },
    )

  def main(args: Array[String]): Unit = {
    new Thread(() => run()).start()
    implicit val system: ActorSystem = ActorSystem("leaderboard")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import place.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

object Leaderboard {
  val jedis = new JedisPooled("redis", 6379)
  val Size = 100
  val TopN = 10
  val HistoryLen = 10
  val LeadersKey = "place:leaders"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "leaderboard")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("placements").asJava)

  /** history:{x}:{y} (provided). */
  def historyKey(x: Int, y: Int): String = s"history:$x:$y"

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        Try(record.value().parseJson.asJsObject.fields).toOption.flatMap { f =>
          (f.get("user"), f.get("x"), f.get("y"), f.get("color"), f.get("ts")) match {
            case (Some(JsString(user)), Some(JsNumber(x)), Some(JsNumber(y)), Some(JsNumber(color)), Some(JsNumber(ts))) =>
              Some((user, x.toInt, y.toInt, color.toInt, ts.toLong))
            case _ => None
          }
        } match {
          case Some((user, x, y, color, ts)) =>
            val key = historyKey(x, y)
            val entry = JsObject("user" -> JsString(user), "color" -> JsNumber(color), "ts" -> JsNumber(ts)).compactPrint
            jedis.zincrby(LeadersKey, 1.0, user)
            jedis.lpush(key, entry)
            jedis.ltrim(key, 0, HistoryLen - 1) // newest first, never more than 10
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every record of the batch has been counted
    }

  val route: Route =
    concat(
      path("top") {
        get {
          val rows = jedis.zrevrangeWithScores(LeadersKey, 0, TopN - 1).asScala.map { t =>
            JsObject("user" -> JsString(t.getElement), "tiles" -> JsNumber(t.getScore.toLong))
          }
          complete(HttpEntity(ContentTypes.\`application/json\`, JsArray(rows.toVector).compactPrint))
        }
      },
      path("history") {
        get {
          parameters("x".as[Int], "y".as[Int]) { (x, y) =>
            if (x < 0 || x >= Size || y < 0 || y >= Size)
              complete(HttpResponse(StatusCodes.BadRequest, entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"x and y must be in [0, Size)"}""")))
            else {
              val items = jedis.lrange(historyKey(x, y), 0, HistoryLen - 1).asScala.map(_.parseJson)
              complete(HttpEntity(ContentTypes.\`application/json\`, JsArray(items.toVector).compactPrint))
            }
          }
        }
      },
    )

  def main(args: Array[String]): Unit = {
    new Thread(() => run()).start()
    implicit val system: ActorSystem = ActorSystem("leaderboard")
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

#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kSize = 100;
constexpr int kTopN = 10;
constexpr int kHistoryLen = 10;
const std::string kLeadersKey = "place:leaders";

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "leaderboard", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"placements"});
  return consumer;
}

auto consumer = make_consumer();

// history:{x}:{y} (provided).
std::string history_key(int x, int y) { return "history:" + std::to_string(x) + ":" + std::to_string(y); }

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    // TODO: skip + commit malformed records (not an object, no string "user", no number "x"/"y"/"color"/"ts")
    // TODO: zincrby kLeadersKey 1 user; lpush history_key(x, y) {"user", "color", "ts"}; ltrim 0 kHistoryLen-1
    // TODO: then commitSync this message
  }
}

int main() {
  std::thread(run).detach();
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/top", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: ZREVRANGE kLeadersKey 0 kTopN-1 WITHSCORES → [{"user": …, "tiles": …}]
    res.set_content("[]", "application/json");
  });

  svr.Get("/history", [](const httplib::Request& req, httplib::Response& res) {
    const int x = req.has_param("x") ? std::stoi(req.get_param_value("x")) : -1;
    const int y = req.has_param("y") ? std::stoi(req.get_param_value("y")) : -1;
    // TODO: 400 unless 0 <= x, y < kSize; LRANGE history_key(x, y) 0 kHistoryLen-1 → [{"user", "color", "ts"}]
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

#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kSize = 100;
constexpr int kTopN = 10;
constexpr int kHistoryLen = 10;
const std::string kLeadersKey = "place:leaders";

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "leaderboard", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"placements"});
  return consumer;
}

auto consumer = make_consumer();

// history:{x}:{y} (provided).
std::string history_key(int x, int y) { return "history:" + std::to_string(x) + ":" + std::to_string(y); }

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    if (!event.is_object() || !event.contains("user") || !event["user"].is_string() || !event.contains("x") ||
        !event["x"].is_number() || !event["y"].is_number() || !event["color"].is_number() || !event["ts"].is_number()) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string user = event["user"].get<std::string>();
    const std::string key = history_key(event["x"].get<int>(), event["y"].get<int>());
    const std::string entry = json{{"user", user}, {"color", event["color"]}, {"ts", event["ts"]}}.dump();
    redis.zincrby(kLeadersKey, 1, user);
    redis.lpush(key, entry);
    redis.ltrim(key, 0, kHistoryLen - 1);  // newest first, never more than 10
    consumer->commitSync(msg.get());
  }
}

int main() {
  std::thread(run).detach();
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/top", [](const httplib::Request& req, httplib::Response& res) {
    std::vector<std::pair<std::string, double>> rows;
    redis.zrevrange(kLeadersKey, 0, kTopN - 1, std::back_inserter(rows));
    json out = json::array();
    for (const auto& [user, score] : rows) out.push_back({{"user", user}, {"tiles", static_cast<long long>(score)}});
    res.set_content(out.dump(), "application/json");
  });

  svr.Get("/history", [](const httplib::Request& req, httplib::Response& res) {
    const int x = req.has_param("x") ? std::stoi(req.get_param_value("x")) : -1;
    const int y = req.has_param("y") ? std::stoi(req.get_param_value("y")) : -1;
    if (x < 0 || x >= kSize || y < 0 || y >= kSize) {
      res.status = 400;
      res.set_content(R"({"error":"x and y must be in [0, kSize)"})", "application/json");
      return;
    }
    std::vector<std::string> items;
    redis.lrange(history_key(x, y), 0, kHistoryLen - 1, std::back_inserter(items));
    json out = json::array();
    for (const auto& item : items) out.push_back(json::parse(item, nullptr, false));
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

TS = 1700000000000
LEADERS = "place:leaders"


def _seed(ctx, *placements):
    """placements: (user, x, y, color) tuples, or just user names (one tile each on (3, 7))."""
    for i, p in enumerate(placements):
        user, x, y, color = p if isinstance(p, tuple) else (p, 3, 7, 12)
        ctx.kafka.seed("placements", key=f"{x}:{y}", value=json.dumps({"user": user, "x": x, "y": y, "color": color, "ts": TS + i}))


def check_consumer(ctx):
    _seed(ctx, "ana", ("bo", 4, 7, 5))
    bo = ctx.kafka.records("placements")[1]
    ctx.redis.set("history:4:7", "corrupt")  # bo's pixel: the worker's write fails while it handles her tile
    m = ctx.load("leaderboard")
    try:
        ctx.drain(m.run)
    except Exception:
        pass  # the worker died on bo's placement
    m.consumer.close()  # the process is stopped (deploy, SIGTERM): its consumer leaves the group
    committed = ctx.kafka.committed_offset("leaderboard", "placements", bo.partition)
    assert committed is None or committed <= bo.offset, f"bo's placement never reached her pixel's history, yet group leaderboard committed past it (offset {committed}) by the time the worker stopped: offsets were acknowledged for what was delivered, not for what was processed. Turn auto-commit off and commit after the writes"
    ctx.redis.delete("history:4:7")  # the fault is repaired and the worker restarts
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    history = ctx.redis.lrange("history:4:7", 0, -1)
    assert history and json.loads(history[0]).get("user") == "bo", f"after the restart bo's placement must be replayed into history:4:7, which holds {history}: it was lost"
    lag = ctx.kafka.lag("leaderboard", "placements")
    assert lag == 0, f"group leaderboard on placements has {lag} uncommitted record(s) after the worker processed everything: commit each record once it is counted"


def check_zincrby(ctx):
    _seed(ctx, "ana", "bo", ("ana", 4, 7, 1), ("ana", 5, 7, 2), ("cy", 0, 0, 15))
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    assert ctx.redis.type(LEADERS) == "zset", f"{LEADERS} is {ctx.redis.type(LEADERS)!r}, expected a sorted set (keys: {ctx.redis.keys()})"
    assert ctx.redis.zscore(LEADERS, "ana") == 3, f"ana in {LEADERS} scores {ctx.redis.zscore(LEADERS, 'ana')!r}, expected 3"
    assert ctx.redis.zscore(LEADERS, "bo") == 1, f"bo in {LEADERS} scores {ctx.redis.zscore(LEADERS, 'bo')!r}, expected 1"
    assert ctx.redis.zscore(LEADERS, "cy") == 1, f"cy in {LEADERS} scores {ctx.redis.zscore(LEADERS, 'cy')!r}, expected 1"


def check_history_capped(ctx):
    _seed(ctx, *[(f"u{i:02d}", 3, 7, i % 16) for i in range(12)], ("zed", 4, 7, 5))
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    key = m.history_key(3, 7)
    assert key == "history:3:7", f"history_key(3, 7) is {key!r}, expected history:3:7"
    assert ctx.redis.type(key) == "list", f"{key} is {ctx.redis.type(key)!r}, expected a list (keys: {ctx.redis.keys()})"
    items = ctx.redis.lrange(key, 0, -1)
    assert len(items) == 10, f"{key} holds {len(items)} entries after 12 placements, expected HISTORY_LEN = 10 (LPUSH + LTRIM 0 9)"
    entries = [json.loads(i) for i in items]
    assert [e.get("user") for e in entries] == [f"u{i:02d}" for i in range(11, 1, -1)], f"the list must be newest first and keep the last 10: {[e.get('user') for e in entries]}"
    assert entries[0].get("color") == 11 and entries[0].get("ts") == TS + 11, f"each entry carries user, color and ts: {entries[0]}"
    assert ctx.redis.lrange("history:4:7", 0, -1) and json.loads(ctx.redis.lrange("history:4:7", 0, -1)[0]).get("user") == "zed", "every pixel has its own list"


def check_commit_after(ctx):
    _seed(ctx, "ana")
    ctx.kafka.seed("placements", key="bad", value="not json")
    ctx.kafka.seed("placements", key="bad", value=json.dumps({"user": "ghost"}))
    placement = ctx.kafka.records("placements")[0]
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), ctx.redis.zscore(LEADERS, "ana"), ctx.redis.llen("history:3:7"))))
    m = ctx.load("leaderboard")
    ctx.drain(m.run)
    assert at_commit, "no offset was ever committed"
    covering = [(score, hist) for offsets, score, hist in at_commit if offsets.get(("placements", placement.partition), 0) > placement.offset]
    assert covering, "ana's placement was never committed"
    assert covering[0] == (1, 1), f"the commit must come after ZINCRBY and LPUSH: when ana's placement was committed the score was {covering[0][0]!r} and the history held {covering[0][1]} entries"
    assert ctx.kafka.lag("leaderboard", "placements") == 0, "malformed records must be skipped and committed, not left to replay forever"
    assert ctx.redis.zcard(LEADERS) == 1, f"malformed records must not be counted: {ctx.redis.zrange(LEADERS, 0, -1)}"


async def check_endpoints(ctx):
    m = ctx.load("leaderboard")
    ctx.redis.zadd(LEADERS, {f"user{i:02d}": 100 - i for i in range(12)})
    for i in range(3):
        ctx.redis.lpush("history:3:7", json.dumps({"user": f"u{i}", "color": i, "ts": TS + i}))
    async with ctx.client(m.app) as c:
        r = await c.get("/top")
        assert r.status_code == 200, f"GET /top answered {r.status_code}"
        rows = r.json()
        assert isinstance(rows, list) and len(rows) == 10, f"expected the 10 top users, got {rows}"
        assert [row.get("user") for row in rows] == [f"user{i:02d}" for i in range(10)], f"rows must be in descending score order: {[row.get('user') for row in rows]}"
        assert [row.get("tiles") for row in rows] == [100 - i for i in range(10)], f"each row carries the tile count as 'tiles': {rows}"
        r = await c.get("/history", params={"x": 3, "y": 7})
        assert r.status_code == 200, f"GET /history?x=3&y=7 answered {r.status_code}"
        assert [e.get("user") for e in r.json()] == ["u2", "u1", "u0"], f"history must be newest first with user, color and ts: {r.json()}"
        assert r.json()[0] == {"user": "u2", "color": 2, "ts": TS + 2}, f"each entry is the stored document: {r.json()[0]}"
        r = await c.get("/history", params={"x": 0, "y": 0})
        assert r.status_code == 200 and r.json() == [], f"a pixel nobody painted has an empty history, got {r.status_code} {r.text}"
        for bad in ({"x": -1, "y": 0}, {"x": 0, "y": m.SIZE}, {"x": m.SIZE, "y": 0}):
            r = await c.get("/history", params=bad)
            assert r.status_code == 400, f"GET /history with {bad} answered {r.status_code}, expected 400"
`,
  },
  debrief: `Two read models from one stream. The sorted set is the leaderboard structure — \`ZINCRBY\` keeps it ordered on every write and the top 10 is one O(log n + 10) read, no scan, no sort at query time. The capped list is the history structure — \`LPUSH\` then \`LTRIM 0 9\` is the Redis idiom for "the last N, newest first", bounded memory with no cleanup job, and the per-pixel key is exactly the lookup the hover makes. Both are rebuilt by replaying the topic, so a lost Redis is an inconvenience, not a data loss. Where the commit sits decides the guarantee: process-then-commit is at-least-once, and a scoreboard that is occasionally one too high beats one that is quietly short. Reddit kept the full per-tile details in a wide Cassandra table for the same query and the same reason — the single-tile endpoint was the busiest uncached call they had; a tiny capped list in front of it is what they would have added with a week more.`,
};
