import type {Step} from '@/lib/types';

export const countViewsStep: Step = {
  id: 'count-views',
  title: 'Count views: consumer group with manual commits',
  concept: 'kafka',
  file: 'view_counter',
  focus: ['kafka', 'analytics', 'redis'],
  task: `## Task

Implement the analytics consumer: a member of consumer group **\`view-counter\`** that reads
\`image-views\` and increments \`views:{id}\` in Redis for every event.

- Disable auto-commit. Auto-commit acknowledges records on a timer, *before* you know they were
  processed; a crash then loses counts silently.
- For every record: parse the JSON, \`INCR views:{id}\`, **then** commit the offset (per record, or once
  per poll batch after every record in it is counted). Committing after the side effect gives
  **at-least-once** delivery: a crash between the two replays the record, which over-counts by one
  instead of losing it — the right trade-off for a counter.
- Skip malformed records (log and commit) rather than crash-looping on a poison message.

:::widget consumer-groups {"partitions": 4}

:::widget delivery-semantics {}`,
  sequence: {
    participants: ['Kafka', 'view-counter', 'Redis'],
    messages: [
      {from: 'Kafka', to: 'view-counter', label: 'poll → record (partition 2, offset 1041)', kind: 'reply'},
      {from: 'view-counter', to: 'Redis', label: 'INCR views:cat', kind: 'sync'},
      {from: 'Redis', to: 'view-counter', label: '(integer) 8213', kind: 'reply'},
      {from: 'view-counter', to: 'Kafka', label: 'commit offset 1042 (partition 2)', kind: 'sync'},
    ],
  },
  hints: [
    'Consumer configuration is where auto-commit is disabled (`enable.auto.commit=false`; in kafka-go, use `FetchMessage` + `CommitMessages` instead of `ReadMessage`).',
    'The order inside the loop is the whole point: side effect (INCR) first, commit second. Never the other way round.',
    'The record key is already the image id — you can INCR by key without even parsing the JSON, but parse it anyway to validate the record.',
  ],
  checks: [
    {
      id: 'group',
      title: 'Joins consumer group view-counter',
      detail: 'The consumer must use `group.id` `view-counter` and subscribe to `image-views`.',
      match: {
        python: {all: [/"group\.id"\s*:\s*"view-counter"/, /subscribe\(\s*\[\s*"image-views"\s*\]\s*\)/]},
        go: {all: [/GroupID:\s*"view-counter"/, /Topic:\s*"image-views"/]},
        scala: {
          all: [
            /"group\.id"\s*,\s*"view-counter"|GROUP_ID_CONFIG\s*,\s*"view-counter"/,
            /subscribe\([^\n]*"image-views"/,
          ],
        },
        cpp: {all: [/"group\.id"\s*,\s*"view-counter"/, /subscribe\([^\n]*"image-views"/]},
      },
    },
    {
      id: 'manual-commit',
      title: 'Disables auto-commit',
      detail: 'Offsets must be committed explicitly, after processing — not on a timer.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'incr',
      title: 'Increments views:{id}',
      detail:
        'Each event increments the per-image counter with `INCR views:{id}` — atomic in Redis, no read-modify-write.',
      match: {
        python: {all: [/\br\.incr\(\s*f"views:\{[^}]+\}"\s*\)/]},
        go: {all: [/rdb\.Incr\(\s*ctx\s*,\s*"views:"\s*\+/]},
        scala: {all: [/jedis\.incr\(\s*s"views:\$/]},
        cpp: {all: [/redis\.incr\(\s*"views:"\s*\+/]},
      },
    },
    {
      id: 'commit-after',
      title: 'Commits after the increment',
      detail: 'Commit the offset only once the counter has been updated: at-least-once, never at-most-once.',
      match: {
        python: {order: [/\br\.incr\(/, /consumer\.commit\(/]},
        go: {order: [/rdb\.Incr\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/jedis\.incr\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/redis\.incr\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer

log = logging.getLogger("view-counter")
r = redis.Redis(host="redis", port=6379)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "view-counter",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["image-views"])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse JSON (skip + commit malformed records)
        # TODO: INCR views:{id}, then commit this message's offset
        raise NotImplementedError
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer

log = logging.getLogger("view-counter")
r = redis.Redis(host="redis", port=6379)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "view-counter",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["image-views"])


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
            image_id = str(event["id"])
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        r.incr(f"views:{image_id}")
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "view-counter",
	Topic:   "image-views",
})

type viewEvent struct {
	ID string \`json:"id"\`
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse JSON (skip + commit malformed records)
		// TODO: INCR views:{id}, then CommitMessages for this message
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "view-counter",
	Topic:   "image-views",
})

type viewEvent struct {
	ID string \`json:"id"\`
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event viewEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.ID == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		if err := rdb.Incr(ctx, "views:"+event.ID).Err(); err != nil {
			return err // do not commit: the record will be redelivered
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
import scala.jdk.CollectionConverters._

object ViewCounter {
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "view-counter")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("image-views").asJava)

  private val IdField = """"id"\\s*:\\s*"([^"]+)"""".r

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: extract the id (skip malformed records)
        // TODO: INCR views:{id}
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
import scala.jdk.CollectionConverters._

object ViewCounter {
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "view-counter")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("image-views").asJava)

  private val IdField = """"id"\\s*:\\s*"([^"]+)"""".r

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        IdField.findFirstMatchIn(record.value()) match {
          case Some(m) => jedis.incr(s"views:\${m.group(1)}")
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every record of the batch has been counted
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <regex>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "view-counter", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"image-views"});
  return consumer;
}

auto consumer = make_consumer();
const std::regex kIdField(R"("id"\\s*:\\s*"([^"]+)")");

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    // TODO: extract the id with kIdField (skip + commit malformed records)
    // TODO: INCR views:{id}, then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <regex>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "view-counter", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"image-views"});
  return consumer;
}

auto consumer = make_consumer();
const std::regex kIdField(R"("id"\\s*:\\s*"([^"]+)")");

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    std::smatch m;
    if (!std::regex_search(value, m, kIdField)) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    redis.incr("views:" + m[1].str());
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `Where the commit sits relative to the side effect decides the delivery guarantee: commit-then-process is at-most-once (crash → lost), process-then-commit is at-least-once (crash → replayed). A counter tolerates a rare duplicate; a payment does not, which is why the merchant problem stores the record id to make its writes idempotent. Real consumers commit in batches for throughput, handle rebalances (\`on_revoke\` → commit what you have), and send poison records to a dead-letter topic instead of just logging them.`,
};
