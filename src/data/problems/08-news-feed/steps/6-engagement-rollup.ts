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
        typescript: {
          all: [
            /groupId:\s*['"]engagement-rollup['"]/,
            /subscribe\(\s*\{[^\n]*(topic:\s*['"]engagement['"]|topics:\s*\[[^\n]*['"]engagement['"])/,
          ],
        },
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
        typescript: {all: [/autoCommit:\s*false/]},
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
        typescript: {all: [/\.set\(\s*`seen:\$\{/, /['"]NX['"]/, /['"]EX['"]\s*,\s*(SEEN_TTL_S|604_?800)/]},
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
        typescript: {all: [/\.hincrby\(\s*`stats:\$\{/]},
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
        typescript: {order: [/\.set\(\s*`seen:/, /\.hincrby\(/, /\bcommit\(|commitOffsets\(/]},
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
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

const redis = new Redis({host: 'redis', port: 6379});

export const SEEN_TTL_S = 7 * 24 * 3600;
export const FIELDS: Record<string, [field: string, delta: number]> = {
  like: ['likes', 1],
  unlike: ['likes', -1],
  comment: ['comments', 1],
  share: ['shares', 1],
};

const kafka = new Kafka({clientId: 'engagement-rollup', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'engagement-rollup'});

interface Counted {
  eventId: string;
  postId: string;
  field: string;
  delta: number;
}

/** The event's id, post and counter, or null for a malformed record or an unknown type. */
function parse(value: Buffer | null): Counted | null {
  try {
    const event = JSON.parse(value?.toString() ?? '') as {event_id?: unknown; type?: unknown; post_id?: unknown} | null;
    if (!event || typeof event.event_id !== 'string' || typeof event.post_id !== 'string' || typeof event.type !== 'string') return null;
    const counter = FIELDS[event.type];
    return counter === undefined ? null : {eventId: event.event_id, postId: event.post_id, field: counter[0], delta: counter[1]};
  } catch {
    return null;
  }
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'engagement', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      // TODO: parse the event; unknown type or malformed → log, commit, return
      // TODO: SET seen:{eventId} 1 NX EX SEEN_TTL_S; already seen → commit, return
      // TODO: HINCRBY stats:{postId} field delta, then commit this message's offset
      throw new Error('not implemented');
    },
  });
}

async function commit(topic: string, partition: number, offset: string): Promise<void> {
  await consumer.commitOffsets([{topic, partition, offset: String(Number(offset) + 1)}]);
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

const redis = new Redis({host: 'redis', port: 6379});

export const SEEN_TTL_S = 7 * 24 * 3600;
export const FIELDS: Record<string, [field: string, delta: number]> = {
  like: ['likes', 1],
  unlike: ['likes', -1],
  comment: ['comments', 1],
  share: ['shares', 1],
};

const kafka = new Kafka({clientId: 'engagement-rollup', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'engagement-rollup'});

interface Counted {
  eventId: string;
  postId: string;
  field: string;
  delta: number;
}

/** The event's id, post and counter, or null for a malformed record or an unknown type. */
function parse(value: Buffer | null): Counted | null {
  try {
    const event = JSON.parse(value?.toString() ?? '') as {event_id?: unknown; type?: unknown; post_id?: unknown} | null;
    if (!event || typeof event.event_id !== 'string' || typeof event.post_id !== 'string' || typeof event.type !== 'string') return null;
    const counter = FIELDS[event.type];
    return counter === undefined ? null : {eventId: event.event_id, postId: event.post_id, field: counter[0], delta: counter[1]};
  } catch {
    return null;
  }
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'engagement', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = parse(message.value);
      if (event === null) {
        console.warn(\`skipping malformed record at offset \${message.offset}\`);
        await commit(topic, partition, message.offset);
        return;
      }
      if ((await redis.set(\`seen:\${event.eventId}\`, 1, 'EX', SEEN_TTL_S, 'NX')) === null) {
        await commit(topic, partition, message.offset); // replay: already counted
        return;
      }
      await redis.hincrby(\`stats:\${event.postId}\`, event.field, event.delta);
      await commit(topic, partition, message.offset);
    },
  });
}

async function commit(topic: string, partition: number, offset: string): Promise<void> {
  await consumer.commitOffsets([{topic, partition, offset: String(Number(offset) + 1)}]);
}
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
  harness: {
    python: `import json


def _event(ctx, kind, post_id, event_id, user="alice"):
    value = {"event_id": event_id, "type": kind, "post_id": post_id, "user_id": user, "ts": 1700000000000}
    ctx.kafka.seed("engagement", key=post_id, value=json.dumps(value))


def check_group(ctx):
    _event(ctx, "like", "p1", "e1")
    m = ctx.load("engagement_worker")
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "engagement-rollup", f"group.id must be engagement-rollup, got {group!r}"
    assert "engagement" in topics, f"the consumer must subscribe to engagement, got {topics}"
    ctx.drain(m.run)
    assert ctx.redis.hget("stats:p1", "likes") == "1", f"after one like event stats:p1 likes is {ctx.redis.hget('stats:p1', 'likes')!r}, expected 1"


def check_manual_commit(ctx):
    _event(ctx, "like", "p1", "e1")
    _event(ctx, "like", "p1", "e2", "bob")
    m = ctx.load("engagement_worker")
    ctx.drain(m.run)
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit must be False: offsets would be committed on a timer, before the event was counted"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets were committed on a timer, before processing"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.lag("engagement-rollup", "engagement") == 0, "every processed record must be committed"


def check_dedupe(ctx):
    _event(ctx, "like", "p1", "e1")
    _event(ctx, "like", "p1", "e1")  # the replay
    _event(ctx, "like", "p1", "e2", "bob")
    m = ctx.load("engagement_worker")
    ctx.drain(m.run)
    assert ctx.redis.hget("stats:p1", "likes") == "2", f"e1 arrived twice: stats:p1 likes must be 2, got {ctx.redis.hget('stats:p1', 'likes')!r}"
    assert ctx.redis.exists("seen:e1"), "seen:{event_id} must be claimed with SET NX so a replay finds it"
    ttl = ctx.redis.ttl("seen:e1")
    assert 604000 < ttl <= 604800, f"seen:e1 must expire after a week (EX 604800), its TTL is {ttl}"
    assert ctx.kafka.lag("engagement-rollup", "engagement") == 0, "a duplicate must be skipped but still committed, or it is re-read forever"


def check_rollup(ctx):
    _event(ctx, "like", "p1", "e1")
    _event(ctx, "like", "p1", "e2", "bob")
    _event(ctx, "unlike", "p1", "e3")
    _event(ctx, "comment", "p1", "e4")
    _event(ctx, "share", "p1", "e5")
    _event(ctx, "like", "p2", "e6")
    _event(ctx, "view", "p1", "e7")  # unknown type
    ctx.kafka.seed("engagement", key="p1", value="not json")
    ctx.kafka.seed("engagement", key="p1", value=json.dumps({"type": "like"}))  # no event_id, no post_id
    m = ctx.load("engagement_worker")
    ctx.drain(m.run)
    stats = ctx.redis.hgetall("stats:p1")
    assert stats == {"likes": "1", "comments": "1", "shares": "1"}, f"stats:p1 must be likes 1 (2 likes, 1 unlike), comments 1, shares 1, got {stats}"
    assert ctx.redis.hget("stats:p2", "likes") == "1", f"stats:p2 likes must be 1, got {ctx.redis.hget('stats:p2', 'likes')!r}"
    assert ctx.kafka.lag("engagement-rollup", "engagement") == 0, "unknown types and malformed records must be skipped and committed, not crash-looped on"


def check_order(ctx):
    _event(ctx, "like", "p1", "e1")
    m = ctx.load("engagement_worker")
    real_hincrby = m.r.hincrby
    at_hincrby = []

    def hincrby(*args, **kwargs):
        at_hincrby.append(bool(ctx.redis.exists("seen:e1")))
        return real_hincrby(*args, **kwargs)

    m.r.hincrby = hincrby
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((ctx.redis.hget("stats:p1", "likes"), bool(ctx.redis.exists("seen:e1")))))
    ctx.drain(m.run)
    assert at_hincrby, "HINCRBY stats:p1 never happened"
    assert at_hincrby[0] is True, "seen:e1 must be claimed (SET NX) before the HINCRBY, not after"
    assert at_commit, "the offset was never committed"
    assert at_commit[0] == ("1", True), f"the commit must come after the claim and the HINCRBY: at commit time stats:p1 likes was {at_commit[0][0]!r} and seen:e1 existed: {at_commit[0][1]}"
`,
    typescript: `function event(ctx, kind: string, postId: string, eventId: string, user = 'alice') {
  const value = {event_id: eventId, type: kind, post_id: postId, user_id: user, ts: 1700000000000};
  ctx.kafka.seed('engagement', {key: postId, value: JSON.stringify(value)});
}

export async function check_group(ctx) {
  event(ctx, 'like', 'p1', 'e1');
  const m = ctx.load('engagement_worker');
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'engagement-rollup', \`groupId must be engagement-rollup, got \${JSON.stringify(group)}\`);
  assert(topics.includes('engagement'), \`the consumer must subscribe to engagement, got \${JSON.stringify(topics)}\`);
  assert.equal(ctx.redis.hget('stats:p1', 'likes'), '1', \`after one like event stats:p1 likes is \${JSON.stringify(ctx.redis.hget('stats:p1', 'likes'))}, expected 1\`);
}

export async function check_manual_commit(ctx) {
  event(ctx, 'like', 'p1', 'e1');
  event(ctx, 'like', 'p1', 'e2', 'bob');
  const m = ctx.load('engagement_worker');
  await ctx.drain(m.run());
  const consumer = ctx.kafka.consumers[ctx.kafka.consumers.length - 1];
  assert(consumer !== undefined && consumer.autoCommit === false, 'autoCommit must be false: offsets would be committed on a timer, before the event was counted');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets were committed on a timer, before processing');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.equal(ctx.kafka.lag('engagement-rollup', 'engagement'), 0, 'every processed record must be committed');
}

export async function check_dedupe(ctx) {
  event(ctx, 'like', 'p1', 'e1');
  event(ctx, 'like', 'p1', 'e2', 'bob');
  event(ctx, 'like', 'p1', 'e1'); // the replay, last on its partition: skipping it without a commit leaves lag
  const m = ctx.load('engagement_worker');
  await ctx.drain(m.run());
  assert.equal(ctx.redis.hget('stats:p1', 'likes'), '2', \`e1 arrived twice: stats:p1 likes must be 2, got \${JSON.stringify(ctx.redis.hget('stats:p1', 'likes'))}\`);
  assert.equal(ctx.redis.exists('seen:e1'), 1, 'seen:{event_id} must be claimed with SET NX so a replay finds it');
  const ttl = ctx.redis.ttl('seen:e1');
  assert(604000 < ttl && ttl <= 604800, \`seen:e1 must expire after a week (EX 604800), its TTL is \${ttl}\`);
  assert.equal(ctx.kafka.lag('engagement-rollup', 'engagement'), 0, 'a duplicate must be skipped but still committed, or it is re-read forever');
}

export async function check_rollup(ctx) {
  event(ctx, 'like', 'p1', 'e1');
  event(ctx, 'like', 'p1', 'e2', 'bob');
  event(ctx, 'unlike', 'p1', 'e3');
  event(ctx, 'comment', 'p1', 'e4');
  event(ctx, 'share', 'p1', 'e5');
  event(ctx, 'like', 'p2', 'e6');
  event(ctx, 'view', 'p1', 'e7'); // unknown type
  ctx.kafka.seed('engagement', {key: 'p1', value: 'not json'});
  ctx.kafka.seed('engagement', {key: 'p1', value: JSON.stringify({type: 'like'})}); // no event_id, no post_id
  const m = ctx.load('engagement_worker');
  await ctx.drain(m.run());
  const stats = ctx.redis.hgetall('stats:p1');
  assert.deepStrictEqual(stats, {likes: '1', comments: '1', shares: '1'}, \`stats:p1 must be likes 1 (2 likes, 1 unlike), comments 1, shares 1, got \${JSON.stringify(stats)}\`);
  assert.equal(ctx.redis.hget('stats:p2', 'likes'), '1', \`stats:p2 likes must be 1, got \${JSON.stringify(ctx.redis.hget('stats:p2', 'likes'))}\`);
  assert.equal(ctx.kafka.lag('engagement-rollup', 'engagement'), 0, 'unknown types and malformed records must be skipped and committed, not crash-looped on');
}

export async function check_order(ctx) {
  event(ctx, 'like', 'p1', 'e1');
  const m = ctx.load('engagement_worker');
  let seenAtCount: boolean | null = null;
  ctx.redisAfter('stats:p1', () => {
    seenAtCount = ctx.redis.exists('seen:e1') === 1;
  });
  const atCommit: [string | null, boolean][] = [];
  ctx.kafka.onCommit(() => atCommit.push([ctx.redis.hget('stats:p1', 'likes'), ctx.redis.exists('seen:e1') === 1]));
  await ctx.drain(m.run());
  assert(seenAtCount !== null, 'HINCRBY stats:p1 never happened');
  assert(seenAtCount === true, 'seen:e1 must be claimed (SET NX) before the HINCRBY, not after');
  assert(atCommit.length > 0, 'the offset was never committed');
  assert.deepStrictEqual(atCommit[0], ['1', true], \`the commit must come after the claim and the HINCRBY: at commit time stats:p1 likes was \${JSON.stringify(atCommit[0][0])} and seen:e1 existed: \${atCommit[0][1]}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"leetbuild/harness"
)

func seedEngagement(ctx *harness.Ctx, kind, postID, eventID, user string) {
	value, _ := json.Marshal(map[string]any{"event_id": eventID, "type": kind, "post_id": postID, "user_id": user, "ts": 1700000000000})
	ctx.Kafka.Seed("engagement", postID, value)
}

// hashField is a hash field, nil when it does not exist.
func hashField(ctx *harness.Ctx, key, field string) any {
	if v, ok := ctx.Redis.HGet(key, field); ok {
		return v
	}
	return nil
}

func drainRollup(ctx *harness.Ctx) { ctx.Drain(func() { run(context.Background()) }) }

func CheckGroup(ctx *harness.Ctx) {
	seedEngagement(ctx, "like", "p1", "e1", "alice")
	drainRollup(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to a topic")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "engagement-rollup", "GroupID must be engagement-rollup")
	subscribed := false
	for _, topic := range last.Topics {
		subscribed = subscribed || topic == "engagement"
	}
	ctx.Assert(subscribed, "the consumer must subscribe to engagement, got %q", last.Topics)
	ctx.Equal(hashField(ctx, "stats:p1", "likes"), "1", "after one like event stats:p1 likes")
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedEngagement(ctx, "like", "p1", "e1", "alice")
	seedEngagement(ctx, "like", "p1", "e2", "bob")
	drainRollup(ctx)
	consumers := ctx.Kafka.Consumers()
	ctx.Assert(len(consumers) > 0 && !consumers[len(consumers)-1].AutoCommit, "the reader must not commit by itself (no CommitInterval, no ReadMessage): offsets would be committed on a timer, before the event was counted")
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets were committed on a timer, before processing")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	ctx.Equal(ctx.Kafka.Lag("engagement-rollup", "engagement"), 0, "every processed record must be committed")
}

func CheckDedupe(ctx *harness.Ctx) {
	seedEngagement(ctx, "like", "p1", "e1", "alice")
	seedEngagement(ctx, "like", "p1", "e2", "bob")
	seedEngagement(ctx, "like", "p1", "e1", "alice") // the replay, last on its partition: skipping it without a commit leaves lag
	drainRollup(ctx)
	ctx.Equal(hashField(ctx, "stats:p1", "likes"), "2", "e1 arrived twice: stats:p1 likes")
	ctx.Equal(ctx.Redis.Exists("seen:e1"), 1, "seen:{event_id} must be claimed with SetNX so a replay finds it: seen:e1 exists")
	ttl := ctx.Redis.TTL("seen:e1")
	ctx.Assert(604000 < ttl && ttl <= 604800, "seen:e1 must expire after a week (EX 604800), its TTL is %d", ttl)
	ctx.Equal(ctx.Kafka.Lag("engagement-rollup", "engagement"), 0, "a duplicate must be skipped but still committed, or it is re-read forever")
}

func CheckRollup(ctx *harness.Ctx) {
	seedEngagement(ctx, "like", "p1", "e1", "alice")
	seedEngagement(ctx, "like", "p1", "e2", "bob")
	seedEngagement(ctx, "unlike", "p1", "e3", "alice")
	seedEngagement(ctx, "comment", "p1", "e4", "alice")
	seedEngagement(ctx, "share", "p1", "e5", "alice")
	seedEngagement(ctx, "like", "p2", "e6", "alice")
	seedEngagement(ctx, "view", "p1", "e7", "alice") // unknown type
	ctx.Kafka.Seed("engagement", "p1", "not json")
	ctx.Kafka.Seed("engagement", "p1", \`{"type":"like"}\`) // no event_id, no post_id
	drainRollup(ctx)
	ctx.Equal(ctx.Redis.HGetAll("stats:p1"), map[string]string{"likes": "1", "comments": "1", "shares": "1"}, "stats:p1 must be likes 1 (2 likes, 1 unlike), comments 1, shares 1")
	ctx.Equal(hashField(ctx, "stats:p2", "likes"), "1", "stats:p2 likes")
	ctx.Equal(ctx.Kafka.Lag("engagement-rollup", "engagement"), 0, "unknown types and malformed records must be skipped and committed, not crash-looped on")
}

func CheckOrder(ctx *harness.Ctx) {
	seedEngagement(ctx, "like", "p1", "e1", "alice")
	seenAtCount := ctx.Redis.After("stats:p1", func() any {
		claimed := ctx.Redis.Exists("seen:e1") == 1
		return claimed
	})
	type commitSnapshot struct {
		likes any
		seen  bool
	}
	var atCommit []commitSnapshot
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		atCommit = append(atCommit, commitSnapshot{hashField(ctx, "stats:p1", "likes"), ctx.Redis.Exists("seen:e1") == 1})
	})
	drainRollup(ctx)
	ctx.Assert(seenAtCount.Fired, "HINCRBY stats:p1 never happened")
	ctx.Equal(seenAtCount.Result, true, "seen:e1 must be claimed (SetNX) before the HIncrBy, not after: seen:e1 existed at the HIncrBy")
	ctx.Assert(len(atCommit) > 0, "the offset was never committed")
	ctx.Assert(atCommit[0].likes == "1" && atCommit[0].seen, "the commit must come after the claim and the HIncrBy: at commit time stats:p1 likes was %v and seen:e1 existed: %v", atCommit[0].likes, atCommit[0].seen)
}
`,
  },
  debrief: `At-least-once delivery plus an idempotent consumer is how streams get effectively-once results without transactions: the \`SET NX\` claim is the idempotency key of the stream, and the counter only moves for events that won the claim. The window between the claim and the \`HINCRBY\` is the one real gap — a crash there loses the event's count, because the replay finds the key already set. Real rollups close it by doing both in one Lua script, batch commits per poll for throughput, and compute the counters per minute into a time series so "likes in the last hour" is a range read instead of a scan.`,
};
