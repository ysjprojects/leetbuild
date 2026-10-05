import type {Step} from '@/lib/types';

export const engagementRollupStep: Step = {
  id: 'engagement-rollup',
  title: 'Roll up engagement: dedupe, then count',
  concept: 'kafka',
  file: 'engagement_worker',
  focus: ['engagement', 'rollup', 'redis'],
  task: `## Task

Implement the rollup consumer: a member of consumer group **\`engagement-rollup\`** reading \`engagement\`
and keeping per-post statistics in the hash \`stats:{post}\` (fields \`likes\`, \`comments\`, \`shares\`).
Events look like \`{"event_id": …, "type": "like", "post_id": …, "user_id": …, "ts": …}\`; the \`FIELDS\`
table maps a type to a field and a delta (\`unlike\` is \`likes -1\`).

- Disable auto-commit and commit after processing: at-least-once. The producer in step 5 is
  fire-and-forget with retries, and a crash here replays records — duplicates **will** arrive.
- **Dedupe before counting**: \`SET seen:{event_id} 1 NX EX 604800\`. When the key already existed the
  event was counted before: skip it — but **still commit** its offset, or the consumer re-reads it forever.
- Otherwise \`HINCRBY stats:{post_id} <field> <delta>\`, then commit.
- Unknown types and malformed records are skipped and committed, not crash-looped on.

:::widget delivery-semantics {}

> The dedupe key has a TTL of a week: duplicates come from retries and replays, which happen within
> minutes, not months. A \`SET NX\` that never expired would be a second copy of the whole event stream.`,
  sequence: {
    participants: ['Kafka', 'engagement-rollup', 'Redis'],
    messages: [
      {from: 'Kafka', to: 'engagement-rollup', label: 'poll → {like, p1, event_id e7} (offset 318)', kind: 'reply'},
      {from: 'engagement-rollup', to: 'Redis', label: 'SET seen:e7 1 NX EX 604800 → OK', kind: 'sync'},
      {from: 'engagement-rollup', to: 'Redis', label: 'HINCRBY stats:p1 likes 1 → 42', kind: 'sync'},
      {from: 'engagement-rollup', to: 'Kafka', label: 'commit offset 319', kind: 'sync'},
      {from: 'Kafka', to: 'engagement-rollup', label: 'poll → {like, p1, event_id e7} again (replay)', kind: 'reply'},
      {from: 'engagement-rollup', to: 'Redis', label: 'SET seen:e7 1 NX → (nil): skip', kind: 'sync'},
      {from: 'engagement-rollup', to: 'Kafka', label: 'commit offset 320', kind: 'sync'},
    ],
  },
  hints: [
    'The dedupe is one command: `SET` with `NX` and `EX` returns OK only when the key was created. Treat the other outcome as "already counted" — no error, no retry.',
    'There are three exits from the loop body — malformed, duplicate, counted — and all three commit. Only a Redis failure leaves the offset uncommitted, so the record is redelivered.',
    'Look the field and the delta up in `FIELDS` before touching Redis; `HINCRBY` with a negative delta is how `unlike` undoes a like.',
  ],
  checks: [
    {
      id: 'group',
      title: 'Joins consumer group engagement-rollup on topic engagement',
      detail: 'The consumer must use `group.id` `engagement-rollup` and subscribe to `engagement`.',
      match: {
        python: {all: [/"group\.id"\s*:\s*"engagement-rollup"/, /subscribe\(\s*\[\s*"engagement"\s*\]\s*\)/]},
        go: {all: [/GroupID:\s*"engagement-rollup"/, /Topic:\s*"engagement"/]},
        scala: {
          all: [
            /"group\.id"\s*,\s*"engagement-rollup"|GROUP_ID_CONFIG\s*,\s*"engagement-rollup"/,
            /subscribe\([^\n]*"engagement"/,
          ],
        },
        cpp: {all: [/"group\.id"\s*,\s*"engagement-rollup"/, /subscribe\([^\n]*"engagement"/]},
      },
    },
    {
      id: 'manual-commit',
      title: 'Disables auto-commit',
      detail: 'Offsets are committed explicitly after the event was counted — at-least-once, never at-most-once.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Dedupes on event_id with SET NX EX',
      detail:
        '`SET seen:{event_id} 1 NX EX 604800` claims the event exactly once; a replayed record finds the key and is skipped.',
      match: {
        python: {all: [/\.set\(\s*f"seen:\{/, /\bnx\s*=\s*True/, /\bex\s*=\s*(SEEN_TTL_S|604_?800)/]},
        go: {
          all: [
            /\.SetNX\(\s*ctx\s*,\s*"seen:"\s*\+|\.SetNX\(\s*ctx\s*,\s*fmt\.Sprintf\(\s*"seen:%s"/,
            /seenTTL|604800/,
          ],
        },
        scala: {all: [/\.set\(\s*s"seen:\$/, /\.nx\(\)/, /\.ex\(\s*(SeenTtlSeconds|604800L?)\s*\)/]},
        cpp: {all: [/\.set\(\s*"seen:"\s*\+/, /UpdateType::NOT_EXIST/, /kSeenTtl|604800/]},
      },
    },
    {
      id: 'rollup',
      title: 'Increments the field in stats:{post}',
      detail:
        "`HINCRBY stats:{post_id} <field> <delta>` keeps all of a post's counters in one hash — one key to read for the post page.",
      match: {
        python: {all: [/\.hincrby\(\s*f"stats:\{/]},
        go: {all: [/\.HIncrBy\(\s*ctx\s*,\s*"stats:"\s*\+|\.HIncrBy\(\s*ctx\s*,\s*fmt\.Sprintf\(\s*"stats:%s"/]},
        scala: {all: [/\.hincrBy\(\s*s"stats:\$/]},
        cpp: {all: [/\.hincrby\(\s*"stats:"\s*\+/]},
      },
    },
    {
      id: 'order',
      title: 'Claims, then counts, then commits',
      detail:
        'The dedupe SET happens before the HINCRBY, and the commit after both — a crash in between replays the record into the dedupe, not into the counter.',
      match: {
        python: {order: [/\.set\(\s*f"seen:/, /\.hincrby\(/, /consumer\.commit\(/]},
        go: {order: [/\.SetNX\(/, /\.HIncrBy\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/\.set\(\s*s"seen:/, /\.hincrBy\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/\.set\(\s*"seen:/, /\.hincrby\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer

log = logging.getLogger("engagement-rollup")
r = redis.Redis(host="redis", port=6379)

SEEN_TTL_S = 7 * 24 * 3600
FIELDS = {"like": ("likes", 1), "unlike": ("likes", -1), "comment": ("comments", 1), "share": ("shares", 1)}

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "engagement-rollup",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["engagement"])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse the event; unknown type or malformed → log, commit, continue
        # TODO: SET seen:{event_id} 1 NX EX SEEN_TTL_S; already seen → commit, continue
        # TODO: HINCRBY stats:{post_id} field delta, then commit this message's offset
        raise NotImplementedError
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer

log = logging.getLogger("engagement-rollup")
r = redis.Redis(host="redis", port=6379)

SEEN_TTL_S = 7 * 24 * 3600
FIELDS = {"like": ("likes", 1), "unlike": ("likes", -1), "comment": ("comments", 1), "share": ("shares", 1)}

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "engagement-rollup",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["engagement"])


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
            event_id, post_id = event["event_id"], event["post_id"]
            field, delta = FIELDS[event["type"]]
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        if not r.set(f"seen:{event_id}", 1, nx=True, ex=SEEN_TTL_S):
            consumer.commit(message=msg, asynchronous=False)  # replay: already counted
            continue
        r.hincrby(f"stats:{post_id}", field, delta)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const seenTTL = 7 * 24 * time.Hour

var fields = map[string]struct {
	field string
	delta int64
}{"like": {"likes", 1}, "unlike": {"likes", -1}, "comment": {"comments", 1}, "share": {"shares", 1}}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "engagement-rollup",
	Topic:   "engagement",
})

type engagementEvent struct {
	EventID string \`json:"event_id"\`
	Type    string \`json:"type"\`
	PostID  string \`json:"post_id"\`
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: unmarshal; unknown type or malformed → log, CommitMessages, continue
		// TODO: SetNX seen:{event_id} 1 seenTTL; already seen → CommitMessages, continue
		// TODO: HIncrBy stats:{post_id} field delta, then CommitMessages for this message
		_ = json.Unmarshal
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const seenTTL = 7 * 24 * time.Hour

var fields = map[string]struct {
	field string
	delta int64
}{"like": {"likes", 1}, "unlike": {"likes", -1}, "comment": {"comments", 1}, "share": {"shares", 1}}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "engagement-rollup",
	Topic:   "engagement",
})

type engagementEvent struct {
	EventID string \`json:"event_id"\`
	Type    string \`json:"type"\`
	PostID  string \`json:"post_id"\`
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event engagementEvent
		err = json.Unmarshal(msg.Value, &event)
		kind, known := fields[event.Type]
		if err != nil || !known || event.EventID == "" || event.PostID == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		fresh, err := rdb.SetNX(ctx, "seen:"+event.EventID, 1, seenTTL).Result()
		if err != nil {
			return err // not committed: redelivered after restart
		}
		if fresh {
			if err := rdb.HIncrBy(ctx, "stats:"+event.PostID, kind.field, kind.delta).Err(); err != nil {
				return err
			}
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

import feed.json.EngagementEvent // EngagementEvent.parse(json): Option[EngagementEvent] with eventId, kind, postId — provided

object EngagementWorker {
  val SeenTtlSeconds = 7L * 24 * 3600
  val Fields = Map("like" -> ("likes", 1L), "unlike" -> ("likes", -1L), "comment" -> ("comments", 1L), "share" -> ("shares", 1L))

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "engagement-rollup")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("engagement").asJava)

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the event and look its kind up in Fields (skip unknown / malformed)
        // TODO: set seen:{eventId} "1" with SetParams nx().ex(SeenTtlSeconds); null → already counted, skip
        // TODO: hincrBy stats:{postId} field delta
      }
      // TODO: commit synchronously after the batch is processed
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

import feed.json.EngagementEvent // EngagementEvent.parse(json): Option[EngagementEvent] with eventId, kind, postId — provided

object EngagementWorker {
  val SeenTtlSeconds = 7L * 24 * 3600
  val Fields = Map("like" -> ("likes", 1L), "unlike" -> ("likes", -1L), "comment" -> ("comments", 1L), "share" -> ("shares", 1L))

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "engagement-rollup")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("engagement").asJava)

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        EngagementEvent.parse(record.value()).flatMap(e => Fields.get(e.kind).map(f => (e, f))) match {
          case Some((event, (field, delta))) =>
            val fresh = jedis.set(s"seen:\${event.eventId}", "1", SetParams.setParams().nx().ex(SeenTtlSeconds)) != null
            if (fresh) jedis.hincrBy(s"stats:\${event.postId}", field, delta)
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every event of the batch is claimed and counted
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

#include <nlohmann/json.hpp>

constexpr std::chrono::seconds kSeenTtl{7 * 24 * 3600};
const std::unordered_map<std::string, std::pair<std::string, long long>> kFields = {
    {"like", {"likes", 1}}, {"unlike", {"likes", -1}}, {"comment", {"comments", 1}}, {"share", {"shares", 1}}};

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "engagement-rollup", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"engagement"});
  return consumer;
}

auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    // TODO: unknown type or malformed → log, commitSync, continue
    // TODO: set seen:{event_id} "1" kSeenTtl UpdateType::NOT_EXIST; false → already counted, commit, continue
    // TODO: hincrby stats:{post_id} field delta, then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

#include <nlohmann/json.hpp>

constexpr std::chrono::seconds kSeenTtl{7 * 24 * 3600};
const std::unordered_map<std::string, std::pair<std::string, long long>> kFields = {
    {"like", {"likes", 1}}, {"unlike", {"likes", -1}}, {"comment", {"comments", 1}}, {"share", {"shares", 1}}};

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "engagement-rollup", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"engagement"});
  return consumer;
}

auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    const auto kind = event.is_discarded() ? kFields.end() : kFields.find(event.value("type", ""));
    if (kind == kFields.end() || !event.contains("event_id") || !event.contains("post_id")) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string event_id = event["event_id"], post_id = event["post_id"];
    const bool fresh = redis.set("seen:" + event_id, "1", kSeenTtl, sw::redis::UpdateType::NOT_EXIST);
    if (fresh) redis.hincrby("stats:" + post_id, kind->second.first, kind->second.second);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `At-least-once delivery plus an idempotent consumer is how streams get effectively-once results without transactions: the \`SET NX\` claim is the idempotency key of the stream, and the counter only moves for events that won the claim. The window between the claim and the \`HINCRBY\` is the one real gap — a crash there loses the event's count, because the replay finds the key already set. Real rollups close it by doing both in one Lua script, batch commits per poll for throughput, and compute the counters per minute into a time series so "likes in the last hour" is a range read instead of a scan.`,
};
