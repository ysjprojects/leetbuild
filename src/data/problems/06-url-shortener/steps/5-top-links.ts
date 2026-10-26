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
        typescript: {
          all: [/groupId:\s*['"]top-links['"]/, /subscribe\(\s*\{[^\n]*topic:\s*['"]clicks['"]/, /autoCommit:\s*false/],
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
        typescript: {all: [/\bredis\.zincrby\(\s*\w+\s*,\s*1\s*,/, /(?<!function )dayKey\(/]},
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
        typescript: {all: [/\bredis\.expire\(\s*\w+\s*,\s*(RETENTION_S|604800|7\s*\*\s*24)/]},
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
        typescript: {order: [/\bredis\.zincrby\(/, /consumer\.commitOffsets\(/]},
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
        typescript: {
          all: [
            /\bredis\.zrevrange\([^\n]*['"]WITHSCORES['"]|\bredis\.zrange\([^\n]*['"]REV['"][^\n]*['"]WITHSCORES['"]/,
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
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=run, daemon=True).start()  # the worker lives beside the API
    yield


app = FastAPI(lifespan=lifespan)
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
`,
      solution: `import json
import logging
import threading
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=run, daemon=True).start()  # the worker lives beside the API
    yield


app = FastAPI(lifespan=lifespan)
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
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const TOP_N = 10;
export const RETENTION_S = 7 * 24 * 3600;

const kafka = new Kafka({clientId: 'top-links', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'top-links'});

/** top:YYYY-MM-DD for a click timestamp in seconds (provided). */
export function dayKey(ts: number): string {
  return 'top:' + new Date(ts * 1000).toISOString().slice(0, 10);
}

/** The worker: lives beside the API and runs until the consumer stops. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'clicks', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      // TODO: parse JSON (skip + commit malformed records)
      // TODO: ZINCRBY dayKey(ts) 1 code; EXPIRE the key to RETENTION_S; then commit offset + 1 for this message
      throw new Error('not implemented');
    },
  });
}

app.get('/top', async request => {
  const {day} = request.query as {day?: string};
  const key = \`top:\${day ?? new Date().toISOString().slice(0, 10)}\`;
  // TODO: ZREVRANGE key 0 TOP_N-1 WITHSCORES → [{code, clicks}]
  return [];
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const TOP_N = 10;
export const RETENTION_S = 7 * 24 * 3600;

const kafka = new Kafka({clientId: 'top-links', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'top-links'});

/** top:YYYY-MM-DD for a click timestamp in seconds (provided). */
export function dayKey(ts: number): string {
  return 'top:' + new Date(ts * 1000).toISOString().slice(0, 10);
}

/** The click's code and timestamp, or null when the record is not a click event. */
function parseClick(value: Buffer | null): {code: string; ts: number} | null {
  try {
    const event = JSON.parse(value?.toString() ?? '') as {code?: unknown; ts?: unknown};
    if (typeof event.code !== 'string' || typeof event.ts !== 'number') return null;
    return {code: event.code, ts: event.ts};
  } catch {
    return null;
  }
}

/** The worker: lives beside the API and runs until the consumer stops. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'clicks', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const next = [{topic, partition, offset: String(Number(message.offset) + 1)}];
      const click = parseClick(message.value);
      if (click === null) {
        console.warn(\`skipping malformed record at offset \${message.offset}\`);
        await consumer.commitOffsets(next);
        return;
      }
      const key = dayKey(click.ts);
      await redis.zincrby(key, 1, click.code);
      await redis.expire(key, RETENTION_S);
      await consumer.commitOffsets(next);
    },
  });
}

app.get('/top', async request => {
  const {day} = request.query as {day?: string};
  const key = \`top:\${day ?? new Date().toISOString().slice(0, 10)}\`;
  const rows = await redis.zrevrange(key, 0, TOP_N - 1, 'WITHSCORES');
  const top: {code: string; clicks: number}[] = [];
  for (let i = 0; i < rows.length; i += 2) top.push({code: rows[i], clicks: Number(rows[i + 1])});
  return top;
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
  harness: {
    python: `import json
from datetime import date, datetime, timezone

DAY = "2026-10-05"
TS = datetime(2026, 10, 5, 12, tzinfo=timezone.utc).timestamp()
NEXT_DAY_TS = TS + 86400
KEY = "top:" + DAY


def _seed(ctx, *clicks):
    """clicks: (code, ts) pairs, or just codes (clicked on DAY)."""
    for click in clicks:
        code, ts = click if isinstance(click, tuple) else (click, TS)
        ctx.kafka.seed("clicks", key=code, value=json.dumps({"code": code, "ts": ts, "referrer": None, "ua": None}))


def check_consumer(ctx):
    _seed(ctx, "g9Xc")
    m = ctx.load("top_links")
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "top-links", f"group.id must be top-links, got {group!r}"
    assert "clicks" in topics, f"the consumer must subscribe to clicks, got {topics}"
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit is on: offsets would be acknowledged on a timer, before the click is counted"
    ctx.drain(m.run)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened after processing"
    assert ctx.kafka.lag("top-links", "clicks") == 0, "every processed record must be committed"


def check_zincrby(ctx):
    _seed(ctx, "g9Xc", "zz12", "g9Xc", ("g9Xc", NEXT_DAY_TS), "g9Xc")
    m = ctx.load("top_links")
    ctx.drain(m.run)
    assert ctx.redis.type(KEY) == "zset", f"{KEY} is {ctx.redis.type(KEY)!r}, expected a sorted set (keys: {ctx.redis.keys()})"
    assert ctx.redis.zscore(KEY, "g9Xc") == 3, f"g9Xc in {KEY} scores {ctx.redis.zscore(KEY, 'g9Xc')!r}, expected 3"
    assert ctx.redis.zscore(KEY, "zz12") == 1, f"zz12 in {KEY} scores {ctx.redis.zscore(KEY, 'zz12')!r}, expected 1"
    next_key = m.day_key(NEXT_DAY_TS)
    assert ctx.redis.zscore(next_key, "g9Xc") == 1, f"a click on the next day counts in {next_key}: g9Xc scores {ctx.redis.zscore(next_key, 'g9Xc')!r}, expected 1"


def check_expire(ctx):
    _seed(ctx, "g9Xc")
    m = ctx.load("top_links")
    ctx.drain(m.run)
    ttl = ctx.redis.ttl(KEY)
    assert ttl > 0, f"{KEY} has no expiry (TTL {ttl}): day leaderboards would accumulate forever"
    assert 604800 - 60 <= ttl <= 604800, f"{KEY} expires in {ttl} s, expected 7 days (604800)"
    ctx.clock.advance(604801)
    assert ctx.redis.exists(KEY) == 0, f"{KEY} must be gone after 7 days"


def check_commit_after(ctx):
    _seed(ctx, "g9Xc")
    ctx.kafka.seed("clicks", key="bad", value="not json")
    ctx.kafka.seed("clicks", key="bad", value=json.dumps({"referrer": None}))
    click = ctx.kafka.records("clicks")[0]
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), ctx.redis.zscore(KEY, "g9Xc"))))
    m = ctx.load("top_links")
    ctx.drain(m.run)
    assert at_commit, "no offset was ever committed"
    covering = [score for offsets, score in at_commit if offsets.get(("clicks", click.partition), 0) > click.offset]
    assert covering, "the g9Xc click was never committed"
    assert covering[0] == 1, f"the commit must come after ZINCRBY: when the g9Xc click was committed it scored {covering[0]!r}"
    assert ctx.kafka.lag("top-links", "clicks") == 0, "malformed records must be skipped and committed, not left to replay forever"
    assert ctx.redis.zcard(KEY) == 1, f"malformed records must not be counted: {ctx.redis.zrange(KEY, 0, -1)}"


async def check_top_endpoint(ctx):
    m = ctx.load("top_links")
    scores = {f"code{i:02d}": 100 - i for i in range(12)}
    ctx.redis.zadd(KEY, scores)
    async with ctx.client(m.app) as c:
        r = await c.get("/top", params={"day": DAY})
    assert r.status_code == 200, f"GET /top?day={DAY} answered {r.status_code}"
    rows = r.json()
    assert isinstance(rows, list) and len(rows) == 10, f"expected the 10 top codes, got {rows}"
    assert [row.get("code") for row in rows] == [f"code{i:02d}" for i in range(10)], f"rows must be in descending score order: {[row.get('code') for row in rows]}"
    assert [row.get("clicks") for row in rows] == [100 - i for i in range(10)], f"each row carries the click count: {rows}"
    today = "top:" + date.today().isoformat()
    ctx.redis.zadd(today, {"today1": 2, "today2": 5})
    async with ctx.client(m.app) as c:
        r = await c.get("/top")
    assert [row.get("code") for row in r.json()] == ["today2", "today1"], f"without ?day the endpoint reads today's set ({today}), got {r.json()}"
`,
    typescript: `const DAY = '2026-10-05';
const TS = Date.UTC(2026, 9, 5, 12) / 1000;
const NEXT_DAY_TS = TS + 86400;
const KEY = 'top:' + DAY;

/** clicks: [code, ts] pairs, or just codes (clicked on DAY). */
function seed(ctx, ...clicks: (string | [string, number])[]) {
  for (const click of clicks) {
    const [code, ts] = typeof click === 'string' ? [click, TS] : click;
    ctx.kafka.seed('clicks', {key: code, value: JSON.stringify({code, ts, referrer: null, ua: null})});
  }
}

export async function check_consumer(ctx) {
  seed(ctx, 'g9Xc');
  const m = ctx.load('top_links');
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions.at(-1);
  assert.equal(group, 'top-links', \`groupId must be top-links, got \${JSON.stringify(group)}\`);
  assert(topics.includes('clicks'), \`the consumer must subscribe to clicks, got \${JSON.stringify(topics)}\`);
  assert.equal(ctx.kafka.consumers.at(-1).autoCommit, false, 'autoCommit is on: offsets would be acknowledged on a timer, before the click is counted');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened after processing');
  assert.equal(ctx.kafka.lag('top-links', 'clicks'), 0, 'every processed record must be committed');
}

export async function check_zincrby(ctx) {
  seed(ctx, 'g9Xc', 'zz12', 'g9Xc', ['g9Xc', NEXT_DAY_TS], 'g9Xc');
  const m = ctx.load('top_links');
  await ctx.drain(m.run());
  assert.equal(ctx.redis.type(KEY), 'zset', \`\${KEY} is \${JSON.stringify(ctx.redis.type(KEY))}, expected a sorted set (keys: \${JSON.stringify(ctx.redis.keys('*'))})\`);
  assert.equal(Number(ctx.redis.zscore(KEY, 'g9Xc')), 3, \`g9Xc in \${KEY} scores \${JSON.stringify(ctx.redis.zscore(KEY, 'g9Xc'))}, expected 3\`);
  assert.equal(Number(ctx.redis.zscore(KEY, 'zz12')), 1, \`zz12 in \${KEY} scores \${JSON.stringify(ctx.redis.zscore(KEY, 'zz12'))}, expected 1\`);
  const nextKey = m.dayKey(NEXT_DAY_TS);
  assert.equal(Number(ctx.redis.zscore(nextKey, 'g9Xc')), 1, \`a click on the next day counts in \${nextKey}: g9Xc scores \${JSON.stringify(ctx.redis.zscore(nextKey, 'g9Xc'))}, expected 1\`);
}

export async function check_expire(ctx) {
  seed(ctx, 'g9Xc');
  const m = ctx.load('top_links');
  await ctx.drain(m.run());
  const ttl = ctx.redis.ttl(KEY);
  assert(ttl > 0, \`\${KEY} has no expiry (TTL \${ttl}): day leaderboards would accumulate forever\`);
  assert(604800 - 60 <= ttl && ttl <= 604800, \`\${KEY} expires in \${ttl} s, expected 7 days (604800)\`);
  ctx.clock.advance(604801);
  assert.equal(ctx.redis.exists(KEY), 0, \`\${KEY} must be gone after 7 days\`);
}

export async function check_commit_after(ctx) {
  seed(ctx, 'g9Xc');
  ctx.kafka.seed('clicks', {key: 'bad', value: 'not json'});
  ctx.kafka.seed('clicks', {key: 'bad', value: JSON.stringify({referrer: null})});
  const click = ctx.kafka.records('clicks')[0];
  const atCommit: [Map<string, number>, number | null][] = [];
  ctx.kafka.onCommit((group, offsets) => atCommit.push([new Map(offsets), ctx.redis.zscore(KEY, 'g9Xc')]));
  const m = ctx.load('top_links');
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'no offset was ever committed');
  const covering = atCommit.filter(([offsets]) => (offsets.get(\`clicks|\${click.partition}\`) ?? 0) > click.offset).map(([, score]) => score);
  assert(covering.length > 0, 'the g9Xc click was never committed');
  assert.equal(Number(covering[0]), 1, \`the commit must come after ZINCRBY: when the g9Xc click was committed it scored \${JSON.stringify(covering[0])}\`);
  assert.equal(ctx.kafka.lag('top-links', 'clicks'), 0, 'malformed records must be skipped and committed, not left to replay forever');
  assert.equal(ctx.redis.zcard(KEY), 1, \`malformed records must not be counted: \${JSON.stringify(ctx.redis.zrange(KEY, 0, -1))}\`);
}

export async function check_top_endpoint(ctx) {
  const m = ctx.load('top_links');
  const codes = Array.from({length: 12}, (_, i) => \`code\${String(i).padStart(2, '0')}\`);
  ctx.redis.zadd(KEY, ...codes.flatMap((code, i) => [100 - i, code]));
  const c = ctx.client(m.app);
  let r = await c.get('/top', {query: {day: DAY}});
  assert.equal(r.status, 200, \`GET /top?day=\${DAY} answered \${r.status}\`);
  const rows = r.json();
  assert(Array.isArray(rows) && rows.length === 10, \`expected the 10 top codes, got \${r.text}\`);
  assert.deepEqual(rows.map(row => row.code), codes.slice(0, 10), \`rows must be in descending score order: \${JSON.stringify(rows.map(row => row.code))}\`);
  assert.deepEqual(rows.map(row => row.clicks), codes.slice(0, 10).map((_, i) => 100 - i), \`each row carries the click count: \${r.text}\`);
  const today = 'top:' + new Date().toISOString().slice(0, 10);
  ctx.redis.zadd(today, 2, 'today1', 5, 'today2');
  r = await c.get('/top');
  assert.deepEqual(r.json().map(row => row.code), ['today2', 'today1'], \`without ?day the endpoint reads today's set (\${today}), got \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"leetbuild/harness"
)

const clickDay = "2026-10-05"

var (
	clickTs     = float64(time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC).Unix())
	nextClickTs = clickTs + 86400
	dayZKey     = "top:" + clickDay
)

// seedClicks puts one click per code on clicks, on clickDay; seedClickAt picks the timestamp.
func seedClicks(ctx *harness.Ctx, codes ...string) {
	for _, code := range codes {
		seedClickAt(ctx, code, clickTs)
	}
}

func seedClickAt(ctx *harness.Ctx, code string, ts float64) {
	ctx.Kafka.Seed("clicks", code, map[string]any{"code": code, "ts": ts, "referrer": nil, "ua": nil})
}

func drainWorker(ctx *harness.Ctx) {
	ctx.Drain(func() { run(context.Background()) })
}

func CheckConsumer(ctx *harness.Ctx) {
	seedClicks(ctx, "g9Xc")
	drainWorker(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to a topic")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "top-links", "GroupID must be top-links")
	subscribed := false
	for _, t := range last.Topics {
		subscribed = subscribed || t == "clicks"
	}
	ctx.Assert(subscribed, "the consumer must subscribe to clicks, got %q", last.Topics)
	consumers := ctx.Kafka.Consumers()
	ctx.Equal(consumers[len(consumers)-1].AutoCommit, false, "auto-commit is on: offsets would be acknowledged on a timer, before the click is counted")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "offsets were auto-committed")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened after processing")
	ctx.Equal(ctx.Kafka.Lag("top-links", "clicks"), 0, "every processed record must be committed; lag")
}

func CheckZincrby(ctx *harness.Ctx) {
	seedClicks(ctx, "g9Xc", "zz12", "g9Xc")
	seedClickAt(ctx, "g9Xc", nextClickTs)
	seedClicks(ctx, "g9Xc")
	drainWorker(ctx)
	ctx.Equal(ctx.Redis.Type(dayZKey), "zset", "the type of %s (keys: %q)", dayZKey, ctx.Redis.Keys("*"))
	score, _ := ctx.Redis.ZScore(dayZKey, "g9Xc")
	ctx.Equal(score, 3, "the score of g9Xc in %s", dayZKey)
	score, _ = ctx.Redis.ZScore(dayZKey, "zz12")
	ctx.Equal(score, 1, "the score of zz12 in %s", dayZKey)
	nextKey := dayKey(nextClickTs)
	score, _ = ctx.Redis.ZScore(nextKey, "g9Xc")
	ctx.Equal(score, 1, "a click on the next day counts in %s: the score of g9Xc", nextKey)
}

func CheckExpire(ctx *harness.Ctx) {
	seedClicks(ctx, "g9Xc")
	drainWorker(ctx)
	ttl := ctx.Redis.TTL(dayZKey)
	ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): day leaderboards would accumulate forever", dayZKey, ttl)
	ctx.Assert(604800-60 <= ttl && ttl <= 604800, "%s expires in %d s, expected 7 days (604800)", dayZKey, ttl)
	ctx.Clock.Advance(604801)
	ctx.Equal(ctx.Redis.Exists(dayZKey), 0, "%s must be gone after 7 days", dayZKey)
}

func CheckCommitAfter(ctx *harness.Ctx) {
	seedClicks(ctx, "g9Xc")
	ctx.Kafka.Seed("clicks", "bad", "not json")
	ctx.Kafka.Seed("clicks", "bad", \`{"referrer":null}\`)
	click := ctx.Kafka.Records("clicks")[0]
	type commitSnapshot struct {
		offsets harness.KafkaOffsets
		score   float64 // 0 while g9Xc is not in the set
	}
	var atCommit []commitSnapshot
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		snap := commitSnapshot{offsets: harness.KafkaOffsets{}}
		for tp, offset := range offsets {
			snap.offsets[tp] = offset
		}
		snap.score, _ = ctx.Redis.ZScore(dayZKey, "g9Xc")
		atCommit = append(atCommit, snap)
	})
	drainWorker(ctx)
	ctx.Assert(len(atCommit) > 0, "no offset was ever committed")
	var covering []float64
	for _, snap := range atCommit {
		if snap.offsets[harness.KafkaTopicPartition{Topic: "clicks", Partition: click.Partition}] > click.Offset {
			covering = append(covering, snap.score)
		}
	}
	ctx.Assert(len(covering) > 0, "the g9Xc click was never committed")
	ctx.Equal(covering[0], 1, "the commit must come after ZINCRBY: the score of g9Xc when its click was committed")
	ctx.Equal(ctx.Kafka.Lag("top-links", "clicks"), 0, "malformed records must be skipped and committed, not left to replay forever; lag")
	ctx.Equal(ctx.Redis.ZCard(dayZKey), 1, "malformed records must not be counted (%v); members of %s", ctx.Redis.ZRangeWithScores(dayZKey, 0, -1), dayZKey)
}

func CheckTopEndpoint(ctx *harness.Ctx) {
	var codes []string
	for i := range 12 {
		code := fmt.Sprintf("code%02d", i)
		codes = append(codes, code)
		ctx.Redis.Do("ZADD", dayZKey, 100-i, code)
	}
	c := ctx.Main(main).HTTP()
	r := c.Get("/top?day=" + clickDay)
	ctx.Equal(r.Status, 200, "GET /top?day=%s", clickDay)
	var rows []struct {
		Code   string  \`json:"code"\`
		Clicks float64 \`json:"clicks"\`
	}
	r.Decode(&rows)
	ctx.Assert(len(rows) == 10, "expected the 10 top codes, got %s", r.Text())
	var gotCodes []string
	var gotClicks, wantClicks []float64
	for i, row := range rows {
		gotCodes = append(gotCodes, row.Code)
		gotClicks = append(gotClicks, row.Clicks)
		wantClicks = append(wantClicks, float64(100-i))
	}
	ctx.Equal(gotCodes, codes[:10], "rows must be in descending score order")
	ctx.Equal(gotClicks, wantClicks, "each row carries the click count (%s)", r.Text())
	today := "top:" + ctx.Clock.Time().UTC().Format("2006-01-02")
	ctx.Redis.Do("ZADD", today, 2, "today1", 5, "today2")
	r = c.Get("/top")
	var todayRows []struct {
		Code string \`json:"code"\`
	}
	r.Decode(&todayRows)
	var todayCodes []string
	for _, row := range todayRows {
		todayCodes = append(todayCodes, row.Code)
	}
	ctx.Equal(todayCodes, []string{"today2", "today1"}, "without ?day the endpoint reads today's set (%s)", today)
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <ctime>
#include <initializer_list>
#include <string>
#include <vector>

namespace {

const std::string clickDay = "2026-10-05";
constexpr double clickTs = 1791201600;  // 2026-10-05 12:00:00 UTC
constexpr double nextClickTs = clickTs + 86400;
const std::string dayZKey = "top:" + clickDay;

void seedClickAt(harness::Ctx& ctx, const std::string& code, double ts) {
  ctx.Kafka.Seed("clicks", code, nlohmann::json{{"code", code}, {"ts", ts}, {"referrer", nullptr}, {"ua", nullptr}});
}

// seedClicks puts one click per code on clicks, on clickDay; seedClickAt picks the timestamp.
void seedClicks(harness::Ctx& ctx, std::initializer_list<std::string> codes) {
  for (const auto& code : codes) seedClickAt(ctx, code, clickTs);
}

// drainWorker runs the consume loop until it waits for clicks. Its consume(1000) idles in 1 s polls
// of virtual time (Go's ReadMessage blocks instead), so a few of them end the drain and the clock
// stays where the clicks were counted.
void drainWorker(harness::Ctx& ctx) {
  ctx.Clock.SetSleepLimit(ctx.Clock.Sleeps() + 5);
  ctx.Drain([] { run(); });
}

// The JSON array a response carries (an empty one when it is not an array).
nlohmann::json rowsOf(const harness::Response& r) {
  const auto rows = nlohmann::json::parse(r.Text(), nullptr, false);
  return rows.is_array() ? rows : nlohmann::json::array();
}

std::string codeOf(const nlohmann::json& row) {
  return row.is_object() && row.contains("code") && row["code"].is_string() ? row["code"].get<std::string>() : "";
}

}  // namespace

void CheckConsumer(harness::Ctx& ctx) {
  seedClicks(ctx, {"g9Xc"});
  drainWorker(ctx);
  const auto subscriptions = ctx.Kafka.EventsOf("subscribe");
  ctx.Assert(!subscriptions.empty(), "the consumer must subscribe to a topic");
  const auto& last = subscriptions.back();
  ctx.Equal(last.Group, "top-links", "group.id must be top-links");
  bool subscribed = false;
  for (const auto& t : last.Topics) subscribed = subscribed || t == "clicks";
  ctx.Assert(subscribed, "the consumer must subscribe to clicks, got %q", last.Topics);
  const auto consumers = ctx.Kafka.Consumers();
  ctx.Assert(!consumers.empty(), "the consumer must subscribe to a topic");
  ctx.Equal(consumers.back().AutoCommit, false, "auto-commit is on: offsets would be acknowledged on a timer, before the click is counted");
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "offsets were auto-committed");
  ctx.Assert(!ctx.Kafka.EventsOf("manual-commit").empty(), "no explicit commit happened after processing");
  ctx.Equal(ctx.Kafka.Lag("top-links", "clicks"), 0, "every processed record must be committed; lag");
}

void CheckZincrby(harness::Ctx& ctx) {
  seedClicks(ctx, {"g9Xc", "zz12", "g9Xc"});
  seedClickAt(ctx, "g9Xc", nextClickTs);
  seedClicks(ctx, {"g9Xc"});
  drainWorker(ctx);
  ctx.Equal(ctx.Redis.Type(dayZKey), "zset", "the type of %s (keys: %q)", dayZKey, ctx.Redis.Keys("*"));
  ctx.Equal(ctx.Redis.ZScore(dayZKey, "g9Xc").value_or(0), 3, "the score of g9Xc in %s", dayZKey);
  ctx.Equal(ctx.Redis.ZScore(dayZKey, "zz12").value_or(0), 1, "the score of zz12 in %s", dayZKey);
  const std::string nextKey = day_key(nextClickTs);
  ctx.Equal(ctx.Redis.ZScore(nextKey, "g9Xc").value_or(0), 1, "a click on the next day counts in %s: the score of g9Xc", nextKey);
}

void CheckExpire(harness::Ctx& ctx) {
  seedClicks(ctx, {"g9Xc"});
  drainWorker(ctx);
  const long long ttl = ctx.Redis.TTL(dayZKey);
  ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): day leaderboards would accumulate forever", dayZKey, ttl);
  ctx.Assert(604800 - 60 <= ttl && ttl <= 604800, "%s expires in %d s, expected 7 days (604800)", dayZKey, ttl);
  ctx.Clock.Advance(604801);
  ctx.Equal(ctx.Redis.Exists(dayZKey), 0, "%s must be gone after 7 days", dayZKey);
}

void CheckCommitAfter(harness::Ctx& ctx) {
  seedClicks(ctx, {"g9Xc"});
  ctx.Kafka.Seed("clicks", "bad", "not json");
  ctx.Kafka.Seed("clicks", "bad", R"({"referrer":null})");
  const auto click = ctx.Kafka.Records("clicks")[0];
  struct commitSnapshot {
    harness::KafkaOffsets offsets;
    double score;  // 0 while g9Xc is not in the set
  };
  std::vector<commitSnapshot> atCommit;
  ctx.Kafka.OnCommit([&ctx, &atCommit](const std::string&, const harness::KafkaOffsets& offsets) {
    atCommit.push_back({offsets, ctx.Redis.ZScore(dayZKey, "g9Xc").value_or(0)});
  });
  drainWorker(ctx);
  ctx.Assert(!atCommit.empty(), "no offset was ever committed");
  std::vector<double> covering;
  for (const auto& snap : atCommit) {
    const auto at = snap.offsets.find(harness::KafkaTopicPartition{"clicks", click.Partition});
    if (at != snap.offsets.end() && at->second > click.Offset) covering.push_back(snap.score);
  }
  ctx.Assert(!covering.empty(), "the g9Xc click was never committed");
  ctx.Equal(covering[0], 1, "the commit must come after ZINCRBY: the score of g9Xc when its click was committed");
  ctx.Equal(ctx.Kafka.Lag("top-links", "clicks"), 0, "malformed records must be skipped and committed, not left to replay forever; lag");
  ctx.Equal(ctx.Redis.ZCard(dayZKey), 1, "malformed records must not be counted (%v); members of %s", ctx.Redis.ZRangeWithScores(dayZKey, 0, -1), dayZKey);
}

void CheckTopEndpoint(harness::Ctx& ctx) {
  std::vector<std::string> codes;
  for (int i = 0; i < 12; i++) {
    char code[8];
    std::snprintf(code, sizeof code, "code%02d", i);
    codes.push_back(code);
    ctx.Redis.Do("ZADD", dayZKey, 100 - i, code);
  }
  auto c = ctx.Main().HTTP();
  auto r = c.Get("/top?day=" + clickDay);
  ctx.Equal(r.Status, 200, "GET /top?day=%s", clickDay);
  const auto rows = rowsOf(r);
  ctx.Assert(rows.size() == 10, "expected the 10 top codes, got %s", r.Text());
  std::vector<std::string> gotCodes;
  std::vector<double> gotClicks, wantClicks;
  for (size_t i = 0; i < rows.size(); i++) {
    gotCodes.push_back(codeOf(rows[i]));
    gotClicks.push_back(rows[i].is_object() && rows[i].contains("clicks") && rows[i]["clicks"].is_number() ? rows[i]["clicks"].get<double>() : 0);
    wantClicks.push_back(100 - static_cast<double>(i));
  }
  ctx.Equal(gotCodes, std::vector<std::string>(codes.begin(), codes.begin() + 10), "rows must be in descending score order");
  ctx.Equal(gotClicks, wantClicks, "each row carries the click count (%s)", r.Text());
  const std::time_t now = static_cast<std::time_t>(ctx.Clock.Now() / 1000);
  char date[16];
  std::strftime(date, sizeof date, "%Y-%m-%d", std::gmtime(&now));
  const std::string today = std::string("top:") + date;
  ctx.Redis.Do("ZADD", today, 2, "today1", 5, "today2");
  r = c.Get("/top");
  std::vector<std::string> todayCodes;
  for (const auto& row : rowsOf(r)) todayCodes.push_back(codeOf(row));
  ctx.Equal(todayCodes, std::vector<std::string>{"today2", "today1"}, "without ?day the endpoint reads today's set (%s)", today);
}
`,
  },
  debrief: `A sorted set is the leaderboard data structure: ZINCRBY keeps it ordered on every write, and the top 10 is one O(log n + 10) read — no scan, no sort at query time. Keying by day gives a natural partition and a natural expiry; a 7-day TTL bounds memory without any cleanup job. Where the commit sits relative to the increment decides the guarantee: process-then-commit is at-least-once, and a leaderboard can afford a rare duplicate. Real analytics pipelines also keep a hourly set, merge days with ZUNIONSTORE for "this week", and write the raw clicks to a warehouse for the questions a sorted set cannot answer (clicks by country, by referrer).`,
};
