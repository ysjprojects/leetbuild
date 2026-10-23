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
        typescript: {all: [/groupId:\s*['"]view-counter['"]/, /subscribe\(\s*\{[^\n]*['"]image-views['"]/]},
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
        typescript: {all: [/autoCommit:\s*false/]},
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
        typescript: {all: [/\bredis\.incr\(\s*`views:\$\{[^}]+\}`\s*\)/]},
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
        typescript: {order: [/\bredis\.incr\(/, /consumer\.commitOffsets\(/]},
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
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'view-counter', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'view-counter'});

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'image-views', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit (autoCommit: false)
    eachMessage: async ({topic, partition, message}) => {
      // TODO: parse JSON (skip + commit malformed records)
      // TODO: INCR views:{id}, then commitOffsets for this message (offset + 1)
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'view-counter', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'view-counter'});

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'image-views', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const next = [{topic, partition, offset: String(Number(message.offset) + 1)}];
      let imageId: string;
      try {
        const event = JSON.parse(message.value?.toString() ?? '') as {id?: unknown};
        if (event.id === undefined || event.id === null) throw new TypeError('event without id');
        imageId = String(event.id);
      } catch {
        console.warn(\`skipping malformed record at offset \${message.offset}\`);
        await consumer.commitOffsets(next);
        return;
      }
      await redis.incr(\`views:\${imageId}\`);
      await consumer.commitOffsets(next);
    },
  });
}
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
  harness: {
    python: `import json


def _seed(ctx, *ids):
    for image_id in ids:
        ctx.kafka.seed("image-views", key=image_id, value=json.dumps({"id": image_id, "w": 256, "hit": True}))


def check_group(ctx):
    _seed(ctx, "cat")
    m = ctx.load("view_counter")
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "view-counter", f"group.id must be view-counter, got {group!r}"
    assert "image-views" in topics, f"the consumer must subscribe to image-views, got {topics}"
    ctx.drain(m.run)


def check_manual_commit(ctx):
    _seed(ctx, "cat", "dog")
    m = ctx.load("view_counter")
    ctx.drain(m.run)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before processing"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.lag("view-counter", "image-views") == 0, "every processed record must be committed"


def check_incr(ctx):
    _seed(ctx, "cat", "cat", "dog", "cat")
    m = ctx.load("view_counter")
    ctx.drain(m.run)
    assert ctx.redis.get("views:cat") == "3", f"views:cat is {ctx.redis.get('views:cat')!r}, expected 3"
    assert ctx.redis.get("views:dog") == "1", f"views:dog is {ctx.redis.get('views:dog')!r}, expected 1"


def check_commit_after(ctx):
    _seed(ctx, "cat")
    ctx.kafka.seed("image-views", key="bad", value="not json")
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.get("views:cat")))
    m = ctx.load("view_counter")
    ctx.drain(m.run)
    assert at_commit, "the offset was never committed"
    assert at_commit[0] == "1", "the commit must come after INCR: at commit time views:cat was still unset"
    assert ctx.kafka.lag("view-counter", "image-views") == 0, "a malformed record must be skipped and committed, not left to replay forever"
`,
    typescript: `/** View events on one partition, so they are delivered in this order. */
function seed(ctx, ...ids: string[]) {
  for (const imageId of ids)
    ctx.kafka.seed('image-views', {key: imageId, value: JSON.stringify({id: imageId, w: 256, hit: true}), partition: 0});
}

export async function check_group(ctx) {
  seed(ctx, 'cat');
  const m = ctx.load('view_counter');
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'view-counter', \`groupId must be view-counter, got \${JSON.stringify(group)}\`);
  assert(topics.includes('image-views'), \`the consumer must subscribe to image-views, got \${JSON.stringify(topics)}\`);
}

export async function check_manual_commit(ctx) {
  seed(ctx, 'cat', 'dog');
  const m = ctx.load('view_counter');
  await ctx.drain(m.run());
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before processing');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.equal(ctx.kafka.lag('view-counter', 'image-views'), 0, 'every processed record must be committed');
}

export async function check_incr(ctx) {
  seed(ctx, 'cat', 'cat', 'dog', 'cat');
  const m = ctx.load('view_counter');
  await ctx.drain(m.run());
  assert.equal(ctx.redis.get('views:cat'), '3', \`views:cat is \${JSON.stringify(ctx.redis.get('views:cat'))}, expected 3\`);
  assert.equal(ctx.redis.get('views:dog'), '1', \`views:dog is \${JSON.stringify(ctx.redis.get('views:dog'))}, expected 1\`);
}

export async function check_commit_after(ctx) {
  seed(ctx, 'cat');
  ctx.kafka.seed('image-views', {key: 'bad', value: 'not json', partition: 0});
  const atCommit: (string | null)[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.get('views:cat')));
  const m = ctx.load('view_counter');
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'the offset was never committed');
  assert.equal(atCommit[0], '1', 'the commit must come after INCR: at commit time views:cat was still unset');
  assert.equal(ctx.kafka.lag('view-counter', 'image-views'), 0, 'a malformed record must be skipped and committed, not left to replay forever');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"leetbuild/harness"
)

// cvSeed puts view events on partition 0 of image-views, so they are delivered in this order.
func cvSeed(ctx *harness.Ctx, ids ...string) {
	for _, id := range ids {
		value, _ := json.Marshal(map[string]any{"id": id, "w": 256, "hit": true})
		ctx.Kafka.SeedPartition("image-views", 0, id, string(value))
	}
}

// cvRun runs the learner's consumer until it waits for records that will not come.
func cvRun(ctx *harness.Ctx) {
	ctx.Drain(func() { _ = run(context.Background()) })
}

// cvViews is the counter at key, nil when it does not exist.
func cvViews(ctx *harness.Ctx, key string) any {
	if v, ok := ctx.Redis.Get(key); ok {
		return v
	}
	return nil
}

func CheckGroup(ctx *harness.Ctx) {
	cvSeed(ctx, "cat")
	cvRun(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to a topic")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "view-counter", "GroupID must be view-counter")
	subscribed := false
	for _, topic := range last.Topics {
		subscribed = subscribed || topic == "image-views"
	}
	ctx.Assert(subscribed, "the consumer must subscribe to image-views, got %s", harness.Show(last.Topics))
}

func CheckManualCommit(ctx *harness.Ctx) {
	cvSeed(ctx, "cat", "dog")
	cvRun(ctx)
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, before processing")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	ctx.Equal(ctx.Kafka.Lag("view-counter", "image-views"), 0, "every processed record must be committed: the group's lag")
}

func CheckIncr(ctx *harness.Ctx) {
	cvSeed(ctx, "cat", "cat", "dog", "cat")
	cvRun(ctx)
	ctx.Equal(cvViews(ctx, "views:cat"), "3", "views:cat")
	ctx.Equal(cvViews(ctx, "views:dog"), "1", "views:dog")
}

func CheckCommitAfter(ctx *harness.Ctx) {
	cvSeed(ctx, "cat")
	ctx.Kafka.SeedPartition("image-views", 0, "bad", "not json")
	var atCommit []any
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, cvViews(ctx, "views:cat")) })
	cvRun(ctx)
	ctx.Assert(len(atCommit) > 0, "the offset was never committed")
	ctx.Equal(atCommit[0], "1", "the commit must come after INCR: views:cat at commit time")
	ctx.Equal(ctx.Kafka.Lag("view-counter", "image-views"), 0, "a malformed record must be skipped and committed, not left to replay forever: the group's lag")
}
`,
  },
  debrief: `Where the commit sits relative to the side effect decides the delivery guarantee: commit-then-process is at-most-once (crash → lost), process-then-commit is at-least-once (crash → replayed). A counter tolerates a rare duplicate; a payment does not, which is why the merchant problem stores the record id to make its writes idempotent. Real consumers commit in batches for throughput, handle rebalances (\`on_revoke\` → commit what you have), and send poison records to a dead-letter topic instead of just logging them.`,
};
