import type {Step} from '@/lib/types';

export const rollupStep: Step = {
  id: 'rollup',
  title: 'Rollup: fold events into per-minute buckets, effectively once',
  concept: 'kafka',
  file: 'rollup',
  focus: ['kafka', 'rollup', 'redis'],
  task: `## Task

Implement the **rollup** worker — a member of consumer group \`rollup\` reading \`counter-events\` —
and the two reads the API needs: \`get_count(ns, name)\` and \`clear_count(ns, name)\`. \`window(ts)\` is
provided: the start of the event's minute bucket (\`WINDOW_S\` = 60).

- Disable auto-commit; the offset is yours to commit once the event has been folded.
- For every record, **first** claim its token: \`SET seen:{token} 1 NX EX 86400\` (\`SEEN_TTL_S\`). A
  refused \`SET\` is a retry of an add the API already accepted: **skip** it but **still commit**.
- Then fold it: \`HINCRBY rollup:{ns}:{name} {window} delta\` — one hash per counter, one field per
  minute bucket. **Then** commit the offset. Claim → fold → commit: a crash between the fold and the
  commit replays the record, and the claim makes the replay a no-op.
- Skip a malformed record (log and commit) rather than crash-looping on it.
- \`get_count\` sums the hash's fields (\`HVALS\`), **0** for a counter without events; \`clear_count\`
  deletes the hash.

:::widget consumer-groups {"partitions": 6}

:::widget delivery-semantics {}

> Per-minute buckets are what make the hash more than a number: a field, once its minute has passed,
> never changes again, which is what lets a real rollup store, replicate and cache closed windows
> without ever re-reading the events behind them.`,
  sequence: {
    participants: ['Kafka', 'rollup', 'Redis'],
    messages: [
      {
        from: 'Kafka',
        to: 'rollup',
        label: 'poll → {plays, stranger-things, +1, t-9f3, ts} (partition 2, offset 88 412)',
        kind: 'reply',
      },
      {from: 'rollup', to: 'Redis', label: 'SET seen:t-9f3 1 NX EX 86400 → OK', kind: 'sync'},
      {from: 'rollup', to: 'Redis', label: 'HINCRBY rollup:plays:stranger-things 1760616000 1', kind: 'sync'},
      {from: 'rollup', to: 'Kafka', label: 'commit offset 88 413 (partition 2)', kind: 'sync'},
      {from: 'Kafka', to: 'rollup', label: 'poll → same token t-9f3 again (the client retried a 503)', kind: 'reply'},
      {from: 'rollup', to: 'Redis', label: 'SET seen:t-9f3 NX → (nil): skip', kind: 'sync'},
      {from: 'rollup', to: 'Kafka', label: 'commit offset 88 414', kind: 'sync'},
    ],
  },
  hints: [
    'Consumer configuration is where auto-commit is disabled (`enable.auto.commit=false`; in kafka-go, `FetchMessage` + `CommitMessages` instead of `ReadMessage`).',
    'Three statements in order inside the loop: the `SET … NX EX` on `seen:{token}` (refused → commit and continue), the `HINCRBY` on `rollup:{ns}:{name}` with `str(window(ts))` as the field, the commit.',
    '`HINCRBY` creates the hash and the field on first use, so there is no setup; `get_count` is `sum(int(v) for v in HVALS)` and an empty hash sums to 0 on its own.',
  ],
  checks: [
    {
      id: 'consumer-group',
      title: 'Joins consumer group rollup on counter-events with auto-commit off',
      detail:
        'The consumer uses `group.id` `rollup`, subscribes to `counter-events`, and commits offsets explicitly after the fold — not on a timer.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"rollup"/,
            /subscribe\(\s*\[\s*"counter-events"\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        go: {
          all: [/GroupID:\s*"rollup"/, /Topic:\s*"counter-events"/, /reader\.FetchMessage\(/],
          none: [/ReadMessage\(/],
        },
        scala: {
          all: [
            /"group\.id"\s*,\s*"rollup"|GROUP_ID_CONFIG\s*,\s*"rollup"/,
            /subscribe\([^\n]*"counter-events"/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*"rollup"/,
            /subscribe\([^\n]*"counter-events"/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
          ],
        },
      },
    },
    {
      id: 'dedupe-first',
      title: 'Claims seen:{token} with SET NX EX before folding',
      detail:
        '`SET seen:{token} 1 NX EX SEEN_TTL_S` runs before the `HINCRBY`; claiming afterwards leaves a window in which a replay is folded twice.',
      match: {
        python: {
          all: [/f["']seen:\{/, /\.set\(\s*[^,\n]+,[^\n]*nx\s*=\s*True/, /\.set\(\s*[^,\n]+,[^\n]*ex\s*=\s*SEEN_TTL_S/],
          order: [/\.set\(\s*[^,\n]+,[^\n]*nx\s*=\s*True/, /\br\.hincrby\(/],
        },
        go: {
          all: [/"seen:"\s*\+/, /rdb\.SetNX\(\s*ctx\s*,\s*[^,\n]+,[^\n]*seenTTL\s*\)/],
          order: [/rdb\.SetNX\(/, /rdb\.HIncrBy\(/],
        },
        scala: {
          all: [/s"seen:\$/, /\.nx\(\)/, /\.ex\(\s*SeenTtlSeconds\s*\)/],
          order: [/jedis\.set\(/, /jedis\.hincrBy\(/],
        },
        cpp: {
          all: [/"seen:"\s*\+/, /redis\.set\(\s*\w+\s*,[^\n]*kSeenTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/],
          order: [/redis\.set\(/, /redis\.hincrby\(/],
        },
      },
    },
    {
      id: 'hincrby-window',
      title: 'Folds the delta into the event’s minute bucket of rollup:{ns}:{name}',
      detail:
        'Each event is `HINCRBY rollup:{ns}:{name} window(ts) delta`: one hash per counter, one field per minute.',
      match: {
        python: {all: [/f["']rollup:\{ns\}:\{name\}["']/, /\br\.hincrby\(/, /(?<!def )window\(/]},
        go: {
          all: [/"rollup:"\s*\+\s*ns\s*\+\s*":"\s*\+\s*name|"rollup:%s:%s"/, /rdb\.HIncrBy\(/, /(?<!func )window\(/],
        },
        scala: {all: [/s"rollup:\$ns:\$name"|s"rollup:\$\{ns\}:\$\{name\}"/, /jedis\.hincrBy\(/, /(?<!def )window\(/]},
        cpp: {all: [/"rollup:"\s*\+\s*ns\s*\+\s*":"\s*\+\s*name/, /redis\.hincrby\(/, /(?<!long )window\(/]},
      },
    },
    {
      id: 'commit-after',
      title: 'Commits after the fold, and commits skipped records too',
      detail:
        'The offset is committed once the `HINCRBY` ran: at-least-once delivery plus the claim is effectively once. A refused claim and a malformed record are committed as well, or they are redelivered forever.',
      match: {
        python: {order: [/\br\.hincrby\(/, /consumer\.commit\(/]},
        go: {order: [/rdb\.HIncrBy\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/jedis\.hincrBy\(/, /commit\(\s*\w+\s*\)/]},
        cpp: {order: [/redis\.hincrby\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'get-clear',
      title: 'get_count sums the buckets and clear_count drops the hash',
      detail:
        '`get_count` reads every field (`HVALS` / `HGETALL`) and sums them — 0 for an unknown counter; `clear_count` is a `DEL` of the hash.',
      match: {
        python: {all: [/\br\.hvals\(|\br\.hgetall\(/, /\bsum\(/, /\br\.delete\(/]},
        go: {all: [/rdb\.HVals\(|rdb\.HGetAll\(/, /rdb\.Del\(/]},
        scala: {all: [/jedis\.hvals\(|jedis\.hgetAll\(/, /\.sum\b/, /jedis\.del\(/]},
        cpp: {all: [/redis\.hvals\(|redis\.hgetall\(/, /redis\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer

log = logging.getLogger("rollup")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
SEEN_TTL_S = 86400  # a day: longer than any client retries, shorter than forever

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "rollup",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["counter-events"])


def window(ts: float) -> int:
    """Start of the minute bucket an event belongs to (provided)."""
    return int(ts) // WINDOW_S * WINDOW_S


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse the JSON event (malformed → log, commit, continue)
        # TODO: SET seen:{token} 1 NX EX SEEN_TTL_S; refused → a retry already folded: commit and continue
        # TODO: HINCRBY rollup:{ns}:{name} window(ts) delta; then commit this message
        raise NotImplementedError


def get_count(ns: str, name: str) -> int:
    # TODO: sum of the hash's fields; 0 when there is no hash
    raise NotImplementedError


def clear_count(ns: str, name: str) -> None:
    # TODO: DEL the hash
    raise NotImplementedError
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer

log = logging.getLogger("rollup")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
SEEN_TTL_S = 86400  # a day: longer than any client retries, shorter than forever

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "rollup",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["counter-events"])


def window(ts: float) -> int:
    """Start of the minute bucket an event belongs to (provided)."""
    return int(ts) // WINDOW_S * WINDOW_S


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
            ns, name, token = str(event["ns"]), str(event["name"]), str(event["token"])
            delta, ts = int(event["delta"]), float(event["ts"])
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        if not r.set(f"seen:{token}", 1, nx=True, ex=SEEN_TTL_S):
            log.info("token %s already folded; skipping", token)
            consumer.commit(message=msg, asynchronous=False)
            continue
        r.hincrby(f"rollup:{ns}:{name}", str(window(ts)), delta)
        consumer.commit(message=msg, asynchronous=False)


def get_count(ns: str, name: str) -> int:
    return sum(int(v) for v in r.hvals(f"rollup:{ns}:{name}"))


def clear_count(ns: str, name: str) -> None:
    r.delete(f"rollup:{ns}:{name}")
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	windowS = 60
	seenTTL = 24 * time.Hour // longer than any client retries, shorter than forever
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "rollup",
	Topic:   "counter-events",
})

type countEvent struct {
	NS    string  \`json:"ns"\`
	Name  string  \`json:"name"\`
	Delta int64   \`json:"delta"\`
	Token string  \`json:"token"\`
	Ts    float64 \`json:"ts"\`
}

// window is the start of the minute bucket an event belongs to (provided).
func window(ts float64) int64 {
	return int64(ts) / windowS * windowS
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse the JSON event (malformed → log, CommitMessages, continue)
		// TODO: SetNX seen:{token} 1 seenTTL; false → a retry already folded: CommitMessages and continue
		// TODO: HIncrBy rollup:{ns}:{name} window(ts) delta; then CommitMessages for this message
		_ = json.Unmarshal
		_ = strconv.FormatInt
		return nil
	}
}

func getCount(ctx context.Context, ns, name string) (int64, error) {
	// TODO: sum of the hash's fields (HVals); 0 when there is no hash
	log.Println("not implemented")
	return 0, nil
}

func clearCount(ctx context.Context, ns, name string) error {
	// TODO: Del the hash
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	windowS = 60
	seenTTL = 24 * time.Hour // longer than any client retries, shorter than forever
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "rollup",
	Topic:   "counter-events",
})

type countEvent struct {
	NS    string  \`json:"ns"\`
	Name  string  \`json:"name"\`
	Delta int64   \`json:"delta"\`
	Token string  \`json:"token"\`
	Ts    float64 \`json:"ts"\`
}

// window is the start of the minute bucket an event belongs to (provided).
func window(ts float64) int64 {
	return int64(ts) / windowS * windowS
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event countEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.Token == "" || event.Name == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		claimed, err := rdb.SetNX(ctx, "seen:"+event.Token, 1, seenTTL).Result()
		if err != nil {
			return err
		}
		if !claimed {
			log.Printf("token %s already folded; skipping", event.Token)
			if err := reader.CommitMessages(ctx, msg); err != nil {
				return err
			}
			continue
		}
		key := "rollup:" + event.NS + ":" + event.Name
		if err := rdb.HIncrBy(ctx, key, strconv.FormatInt(window(event.Ts), 10), event.Delta).Err(); err != nil {
			return err // not committed: the record is redelivered, and the claim makes the replay harmless
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}

func getCount(ctx context.Context, ns, name string) (int64, error) {
	values, err := rdb.HVals(ctx, "rollup:"+ns+":"+name).Result()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, v := range values {
		n, _ := strconv.ParseInt(v, 10, 64)
		total += n
	}
	return total, nil
}

func clearCount(ctx context.Context, ns, name string) error {
	return rdb.Del(ctx, "rollup:"+ns+":"+name).Err()
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

object Rollup {
  val jedis = new JedisPooled("redis", 6379)
  val WindowSeconds = 60L
  val SeenTtlSeconds = 86400L // a day: longer than any client retries, shorter than forever

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "rollup")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("counter-events").asJava)

  /** Start of the minute bucket an event belongs to (provided). */
  def window(ts: Double): Long = ts.toLong / WindowSeconds * WindowSeconds

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        // TODO: parse the JSON event (malformed → log, commit(record), skip)
        // TODO: SET seen:{token} "1" NX EX SeenTtlSeconds; refused → a retry already folded: commit(record) and skip
        // TODO: HINCRBY rollup:{ns}:{name} window(ts) delta; then commit(record)
      }

  def getCount(ns: String, name: String): Long = {
    // TODO: sum of the hash's fields (hvals); 0 when there is no hash
    ???
  }

  def clearCount(ns: String, name: String): Unit = {
    // TODO: del the hash
    ???
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

object Rollup {
  val jedis = new JedisPooled("redis", 6379)
  val WindowSeconds = 60L
  val SeenTtlSeconds = 86400L // a day: longer than any client retries, shorter than forever

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "rollup")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("counter-events").asJava)

  /** Start of the minute bucket an event belongs to (provided). */
  def window(ts: Double): Long = ts.toLong / WindowSeconds * WindowSeconds

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  private def parse(value: String): Option[(String, String, Long, String, Double)] =
    Try(value.parseJson.asJsObject.fields).toOption.flatMap { f =>
      (f.get("ns"), f.get("name"), f.get("delta"), f.get("token"), f.get("ts")) match {
        case (Some(JsString(ns)), Some(JsString(name)), Some(JsNumber(delta)), Some(JsString(token)), Some(JsNumber(ts))) =>
          Some((ns, name, delta.toLong, token, ts.toDouble))
        case _ => None
      }
    }

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        parse(record.value()) match {
          case None =>
            System.err.println(s"skipping malformed record at offset \${record.offset()}")
            commit(record)
          case Some((ns, name, delta, token, ts)) =>
            val claimed = jedis.set(s"seen:$token", "1", SetParams.setParams().nx().ex(SeenTtlSeconds)) != null
            if (!claimed) {
              System.err.println(s"token $token already folded; skipping")
              commit(record)
            } else {
              jedis.hincrBy(s"rollup:$ns:$name", window(ts).toString, delta)
              commit(record)
            }
        }
      }

  def getCount(ns: String, name: String): Long =
    jedis.hvals(s"rollup:$ns:$name").asScala.map(_.toLong).sum

  def clearCount(ns: String, name: String): Unit =
    jedis.del(s"rollup:$ns:$name")
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowS = 60;
constexpr std::chrono::seconds kSeenTtl{86400};  // a day: longer than any client retries, shorter than forever

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "rollup", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"counter-events"});
  return consumer;
}

auto consumer = make_consumer();

// Start of the minute bucket an event belongs to (provided).
long long window(double ts) { return static_cast<long long>(ts) / kWindowS * kWindowS; }

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(static_cast<const char*>(msg->payload()), nullptr, false);
    // TODO: malformed (not an object, no string ns/name/token, no integer delta, no number ts) → log, commitSync, continue
    // TODO: SET seen:{token} 1 NX EX kSeenTtl; refused → a retry already folded: commitSync and continue
    // TODO: HINCRBY rollup:{ns}:{name} window(ts) delta; then commitSync this message
  }
}

long long get_count(const std::string& ns, const std::string& name) {
  // TODO: sum of the hash's fields (hvals); 0 when there is no hash
  return 0;
}

void clear_count(const std::string& ns, const std::string& name) {
  // TODO: del the hash
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowS = 60;
constexpr std::chrono::seconds kSeenTtl{86400};  // a day: longer than any client retries, shorter than forever

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "rollup", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"counter-events"});
  return consumer;
}

auto consumer = make_consumer();

// Start of the minute bucket an event belongs to (provided).
long long window(double ts) { return static_cast<long long>(ts) / kWindowS * kWindowS; }

static bool well_formed(const json& e) {
  return e.is_object() && e.contains("ns") && e["ns"].is_string() && e.contains("name") && e["name"].is_string() &&
         e.contains("token") && e["token"].is_string() && e.contains("delta") && e["delta"].is_number_integer() &&
         e.contains("ts") && e["ts"].is_number();
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
    if (!well_formed(event)) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string ns = event["ns"], name = event["name"], token = event["token"];
    const std::string claim = "seen:" + token;
    if (!redis.set(claim, "1", kSeenTtl, sw::redis::UpdateType::NOT_EXIST)) {
      std::cerr << "token " << token << " already folded; skipping\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string key = "rollup:" + ns + ":" + name;
    redis.hincrby(key, std::to_string(window(event["ts"].get<double>())), event["delta"].get<long long>());
    consumer->commitSync(msg.get());
  }
}

long long get_count(const std::string& ns, const std::string& name) {
  std::vector<std::string> values;
  redis.hvals("rollup:" + ns + ":" + name, std::back_inserter(values));
  long long total = 0;
  for (const auto& v : values) total += std::stoll(v);
  return total;
}

void clear_count(const std::string& ns, const std::string& name) {
  redis.del("rollup:" + ns + ":" + name);
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "counter-events"
KEY = "rollup:plays:stranger-things"
TS = 1760616030.0  # inside the minute bucket starting at 1760616000
NEXT_MINUTE_TS = TS + 60


def _seed(ctx, *events):
    """Events other producers put on the topic — (token, delta) or (token, delta, ts) — all for plays/stranger-things."""
    for e in events:
        token, delta, ts = e if len(e) == 3 else (e[0], e[1], TS)
        value = {"ns": "plays", "name": "stranger-things", "delta": delta, "token": token, "ts": ts}
        ctx.kafka.seed(TOPIC, key="plays:stranger-things", value=json.dumps(value))


def _total(ctx, key=KEY):
    return sum(int(v) for v in ctx.redis.hvals(key))


def _folded_at_commits(ctx):
    """At every commit of group rollup: the committed offsets and the total the hash held at that instant."""
    seen = []
    ctx.kafka.on_commit(lambda group, offsets: seen.append((group, dict(offsets), _total(ctx))) if group == "rollup" else None)
    return seen


def check_consumer_group(ctx):
    _seed(ctx, ("t-1", 1), ("t-2", 2), ("t-3", 4))  # produced before the worker started
    deltas = [json.loads(r.value)["delta"] for r in ctx.kafka.records(TOPIC)]
    partition = ctx.kafka.records(TOPIC)[0].partition
    at_commit = _folded_at_commits(ctx)
    m = ctx.load("rollup")
    ctx.drain(m.run)
    others = sorted({group for (group, _topic, _p) in ctx.kafka.committed if group != "rollup"})
    assert ctx.kafka.committed_offset("rollup", TOPIC, partition) is not None, f"consumer group rollup never committed an offset on {TOPIC} (groups that did: {others}): the worker must join group rollup and subscribe to {TOPIC}"
    assert ctx.kafka.lag("rollup", TOPIC) == 0, f"group rollup left {ctx.kafka.lag('rollup', TOPIC)} event(s) of {TOPIC} uncommitted: events produced before the worker started must be read from the earliest offset, folded and committed"
    assert _total(ctx) == 7, f"the three events (+1, +2, +4) must fold to 7, the hash holds {ctx.redis.hgetall(KEY)}"
    for _group, offsets, total in at_commit:
        upto = offsets.get((TOPIC, partition))
        if upto is not None:
            assert total >= sum(deltas[:upto]), f"group rollup committed offset {upto} (events up to +{deltas[upto - 1]}) while the hash held {total}, less than the {sum(deltas[:upto])} those events add up to: an offset is committed only once its event has been folded, never ahead of the work"
    # The worker stalls 6 s right after claiming an event (longer than auto.commit.interval.ms), then its
    # fold fails for real: rollup:plays:broken is not a hash, so HINCRBY raises and the worker dies.
    ctx.redis.set("rollup:plays:broken", "not a hash")
    ctx.kafka.seed(TOPIC, key="plays:broken", value=json.dumps({"ns": "plays", "name": "broken", "delta": 1, "token": "t-x", "ts": TS}))
    failed = ctx.kafka.records(TOPIC)[-1]
    probe = ctx.redis_after("seen:t-x", lambda: ctx.clock.advance(6))
    try:
        ctx.drain(m.run)
    except Exception:
        pass  # the worker died on the failed fold, as it should: the event is not lost, it is redelivered
    assert probe.fired, "the worker never claimed seen:t-x before folding the event"
    committed = ctx.kafka.committed_offset("rollup", TOPIC, failed.partition) or 0
    assert committed <= failed.offset, f"the fold of t-x failed and the worker died, yet group rollup has committed past it (offset {committed}): the auto-commit timer committed the event while it was still being processed, so it is never redelivered. Turn enable.auto.commit off and commit only after the fold"


def check_dedupe_first(ctx):
    _seed(ctx, ("t-1", 1), ("t-1", 1), ("t-2", 5), ("t-1", 1))
    m = ctx.load("rollup")
    ctx.drain(m.run)
    assert _total(ctx) == 6, f"tokens t-1 (+1, redelivered twice) and t-2 (+5) must fold to 6, the hash holds {ctx.redis.hgetall(KEY)}"
    assert ctx.kafka.lag("rollup", TOPIC) == 0, "a skipped duplicate must still be committed, or it is redelivered forever"
    ttl = ctx.redis.ttl("seen:t-1")
    assert 86400 - 60 <= ttl <= 86400, f"seen:t-1 expires in {ttl} s, expected SEEN_TTL_S (86400): the claim must outlive any client retry, and not live forever"
    # A redelivery 1000 s later is dropped, and does not extend the claim.
    ctx.clock.advance(1000)
    _seed(ctx, ("t-1", 1))
    ctx.drain(m.run)
    assert _total(ctx) == 6, f"a redelivery of t-1 1000 s later must be dropped, the hash holds {ctx.redis.hgetall(KEY)}"
    ttl = ctx.redis.ttl("seen:t-1")
    assert ttl <= 86400 - 1000 + 5, f"a redelivery of t-1 re-armed its claim to {ttl} s: the claim lives SEEN_TTL_S from the first time the token was seen"
    ctx.clock.advance(86400 - 1000)
    assert ctx.redis.exists("seen:t-1") == 0, "seen:t-1 must be gone SEEN_TTL_S after it was claimed"
    # Another rollup replica takes over the partition while this one is mid-event (its session timed out):
    # it redelivers the uncommitted t-9 at the first moment this worker touches seen:t-9.
    _seed(ctx, ("t-9", 10))

    def replica_takes_over():
        replica = ctx.load("rollup")
        ctx.drain(replica.run)

    probe = ctx.redis_after("seen:t-9", replica_takes_over)
    ctx.drain(m.run)
    assert probe.fired, "the worker never touched seen:t-9: every event must be claimed under seen:{token} before it is folded"
    if probe.error is not None:
        raise probe.error
    assert _total(ctx) == 16, f"t-9 (+10) was redelivered to a second replica right after this worker first touched seen:t-9, and the hash now holds {_total(ctx) - 6} for it instead of 10: claim the token atomically (SET NX) before folding, so whoever loses the claim skips the event"


def check_hincrby_window(ctx):
    _seed(ctx, ("t-1", 1), ("t-2", 2), ("t-3", 4, NEXT_MINUTE_TS), ("t-4", -1, NEXT_MINUTE_TS))
    ctx.kafka.seed(TOPIC, key="plays:the-crown", value=json.dumps({"ns": "plays", "name": "the-crown", "delta": 7, "token": "t-5", "ts": TS}))
    m = ctx.load("rollup")
    ctx.drain(m.run)
    assert ctx.redis.type(KEY) == "hash", f"{KEY} is {ctx.redis.type(KEY)!r}, expected a hash (keys: {ctx.redis.keys()})"
    first, second = str(m.window(TS)), str(m.window(NEXT_MINUTE_TS))
    assert ctx.redis.hgetall(KEY) == {first: "3", second: "3"}, f"expected one field per minute bucket {{{first}: 3, {second}: 3}}, got {ctx.redis.hgetall(KEY)}"
    assert ctx.redis.hgetall("rollup:plays:the-crown") == {first: "7"}, f"each counter has its own hash, rollup:plays:the-crown holds {ctx.redis.hgetall('rollup:plays:the-crown')}"


def check_commit_after(ctx):
    _seed(ctx, ("t-1", 1), ("t-2", 2))
    first, second = ctx.kafka.records(TOPIC)
    at_commit = _folded_at_commits(ctx)
    m = ctx.load("rollup")
    ctx.drain(m.run)
    assert at_commit, "no offset was ever committed by group rollup"
    for record, total, label in ((first, 1, "t-1 (+1)"), (second, 3, "t-2 (+2)")):
        covering = [t for _g, offsets, t in at_commit if offsets.get((TOPIC, record.partition), 0) > record.offset]
        assert covering, f"the {label} event was never committed"
        assert covering[0] == total, f"the commit must come after the fold: when {label} was committed the hash held {covering[0]}, expected {total}"
    # Records the worker skips are committed too — even when nothing follows them to commit past them.
    ctx.kafka.seed(TOPIC, key="plays:stranger-things", value="not json")
    ctx.kafka.seed(TOPIC, key="plays:stranger-things", value=json.dumps({"ns": "plays", "name": "stranger-things"}))
    ctx.drain(m.run)
    lag = ctx.kafka.lag("rollup", TOPIC)
    assert lag == 0, f"{lag} malformed record(s) left uncommitted: skip them (log) and commit, or they are redelivered forever"
    _seed(ctx, ("t-1", 1))
    ctx.drain(m.run)
    lag = ctx.kafka.lag("rollup", TOPIC)
    assert lag == 0, f"the redelivered t-1 was skipped but left uncommitted ({lag} record(s) of lag): a duplicate is committed too, or it is redelivered forever"
    assert _total(ctx) == 3, f"malformed records must not be folded and the duplicate t-1 only once: the hash holds {ctx.redis.hgetall(KEY)}, expected a total of 3"


def check_get_clear(ctx):
    m = ctx.load("rollup")
    assert m.get_count("plays", "stranger-things") == 0, "a counter without events reads as 0"
    _seed(ctx, ("t-1", 3), ("t-2", 4, NEXT_MINUTE_TS), ("t-3", -1, NEXT_MINUTE_TS + 60))
    ctx.drain(m.run)
    assert m.get_count("plays", "stranger-things") == 6, f"get_count must sum every minute bucket (3 + 4 - 1 = 6) of {ctx.redis.hgetall(KEY)}, got {m.get_count('plays', 'stranger-things')}"
    assert isinstance(m.get_count("plays", "stranger-things"), int), "get_count must return an int"
    m.clear_count("plays", "stranger-things")
    assert ctx.redis.exists(KEY) == 0, f"clear_count must DEL {KEY}"
    assert m.get_count("plays", "stranger-things") == 0, "a cleared counter reads as 0"
`,
  },
  debrief: `The rollup is where an event log becomes a number, and the two decisions that matter are both about duplicates. The claim comes first because the fold is not idempotent: HINCRBY twice is twice the delta, so the only safe order is claim, fold, commit — at-least-once delivery turned effectively once by a key in Redis. And the hash is bucketed by minute rather than kept as one total because a closed minute is immutable: Netflix's rollup aggregates in time windows for exactly that reason, so it can batch the work of a hot counter, store closed windows durably and cache them, and recompute only the window that is still open. This course keeps every window in one hash; the real pipeline queues counters that changed, aggregates them in a dedicated rollup tier, and persists the result to a rollup store before anyone reads it.`,
};
