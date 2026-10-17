import type {Step} from '@/lib/types';

export const messageEventsStep: Step = {
  id: 'message-events',
  title: 'Message events: one record per message, channel state in Redis',
  concept: 'kafka',
  file: 'message_events',
  focus: ['api', 'kafka', 'worker', 'redis'],
  task: `## Task

A stored message is not done: search indexes it, the gateway pushes it to connected clients, unread
counters move. None of that belongs on the request path. Implement both halves of the
**\`message-events\`** topic:

- \`publish(message)\` — called by the API right after \`store_message\` — produces one record
  \`{"type": "message.created", "channel_id", "id", "author_id", "content"}\` (ids as strings), **keyed
  by the channel id**: a channel's events land on one partition, in order. Enqueue and return —
  \`poll(0)\` serves delivery callbacks, failures are logged by \`on_delivery\`, and nothing in
  \`publish\` waits for the broker.
- A consumer in group **\`channel-state\`** with auto-commit **off** reads the topic and keeps a hash
  per channel: \`HSET channel:{id} last_message_id <id>\` then \`HINCRBY channel:{id} messages 1\`,
  **then** commits the record. Commit after the write is at-least-once: a crash in between replays
  the record and over-counts by one instead of losing it.
- Skip records that are not a \`message.created\` event with a channel and an id (log and commit)
  rather than crash-looping on a poison message.

:::widget kafka-partitions {"partitions": 6}

:::widget consumer-groups {"partitions": 6}

> The key is the ordering contract: every event of a channel goes through one partition and one
> consumer, so \`last_message_id\` can only move forward.`,
  sequence: {
    participants: ['messages-api', 'Kafka', 'channel-state', 'Redis'],
    messages: [
      {
        from: 'messages-api',
        to: 'Kafka',
        label: 'produce message-events key=1032… {message.created, id 1561…}',
        kind: 'async',
      },
      {from: 'Kafka', to: 'channel-state', label: 'poll → record (partition 4, offset 88 120)', kind: 'reply'},
      {from: 'channel-state', to: 'Redis', label: 'HSET channel:1032… last_message_id 1561…', kind: 'sync'},
      {from: 'channel-state', to: 'Redis', label: 'HINCRBY channel:1032… messages 1', kind: 'sync'},
      {from: 'Redis', to: 'channel-state', label: '(integer) 48 213', kind: 'reply'},
      {from: 'channel-state', to: 'Kafka', label: 'commit offset 88 121 (partition 4)', kind: 'sync'},
    ],
  },
  hints: [
    'The key is `str(message["channel_id"])` — the channel, not the message id: the partitioner hashes the key, so equal channels always map to the same partition and the consumer sees a channel’s events in order.',
    'Auto-commit is a consumer *configuration* (`enable.auto.commit`: False); inside the loop the order is HSET, HINCRBY, commit — never commit first.',
    'Validate the event before touching Redis: `json.loads` can raise, and a well-formed JSON that is not a `message.created` with `channel_id` and `id` is just as much a poison message. Both paths log, commit and continue.',
  ],
  checks: [
    {
      id: 'keyed-by-channel',
      title: 'Produces one message-events record keyed by the channel id',
      detail:
        'Every stored message is one record on `message-events` whose key is the channel id, so a channel’s events are ordered on one partition.',
      match: {
        python: {all: [/producer\.produce\(\s*TOPIC/, /key\s*=\s*str\(\s*message\[["']channel_id["']\]\s*\)/]},
        go: {all: [/Topic:\s*topic/, /Key:\s*\[\]byte\(\s*msg\.ChannelID\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*message\.channelId\s*,/]},
        cpp: {
          all: [
            /produce\(\s*kTopic[\s\S]{0,400}?message\.channel_id\.(c_str|data)\(\)\s*,\s*message\.channel_id\.(size|length)\(\)/,
          ],
        },
      },
    },
    {
      id: 'non-blocking',
      title: 'Does not wait for the broker on the request path',
      detail:
        'Enqueue and return; serve delivery callbacks with `poll(0)` (or async writes) instead of flushing or blocking on an acknowledgement.',
      match: {
        python: {all: [/producer\.poll\(\s*0\s*\)/], none: [/def publish(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        go: {all: [/Async:\s*true/], none: [/if err := writer\.WriteMessages/]},
        scala: {all: [/producer\.send\(\s*\w+\s*,/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void publish(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'consumer-group',
      title: 'Joins group channel-state on message-events with auto-commit off',
      detail:
        'The consumer uses `group.id` `channel-state`, subscribes to `message-events`, and commits offsets explicitly after processing — not on a timer.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*GROUP|"group\.id"\s*:\s*"channel-state"/,
            /subscribe\(\s*\[\s*TOPIC\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*False/,
          ],
        },
        go: {all: [/GroupID:\s*"channel-state"/, /Topic:\s*topic/, /reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {
          all: [
            /"group\.id"\s*,\s*"channel-state"|GROUP_ID_CONFIG\s*,\s*"channel-state"/,
            /subscribe\([^\n]*Topic/,
            /"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*"channel-state"/,
            /subscribe\(\s*\{\s*kTopic\s*\}\s*\)/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
          ],
        },
      },
    },
    {
      id: 'channel-state',
      title: 'Keeps channel:{id} with last_message_id and a message count',
      detail:
        'Each event is `HSET channel:{id} last_message_id <id>` and `HINCRBY channel:{id} messages 1` on the channel’s hash.',
      match: {
        python: {
          all: [
            /f"channel:\{/,
            /r\.hset\(\s*key\s*,\s*"last_message_id"\s*,/,
            /r\.hincrby\(\s*key\s*,\s*"messages"\s*,\s*1\s*\)/,
          ],
        },
        go: {
          all: [
            /"channel:"\s*\+/,
            /rdb\.HSet\(\s*ctx\s*,\s*key\s*,\s*"last_message_id"\s*,/,
            /rdb\.HIncrBy\(\s*ctx\s*,\s*key\s*,\s*"messages"\s*,\s*1\s*\)/,
          ],
        },
        scala: {
          all: [
            /s"channel:\$/,
            /jedis\.hset\(\s*key\s*,\s*"last_message_id"\s*,/,
            /jedis\.hincrBy\(\s*key\s*,\s*"messages"\s*,\s*1L?\s*\)/,
          ],
        },
        cpp: {
          all: [
            /"channel:"\s*\+/,
            /redis\.hset\(\s*key\s*,\s*"last_message_id"\s*,/,
            /redis\.hincrby\(\s*key\s*,\s*"messages"\s*,\s*1\s*\)/,
          ],
        },
      },
    },
    {
      id: 'commit-after',
      title: 'Commits after the Redis write',
      detail: 'The offset is committed only once the hash has been updated: at-least-once, never at-most-once.',
      match: {
        python: {order: [/r\.hincrby\(/, /consumer\.commit\(/]},
        go: {order: [/rdb\.HIncrBy\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/jedis\.hincrBy\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/redis\.hincrby\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

TOPIC = "message-events"
GROUP = "channel-state"
log = logging.getLogger("message-events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True, "linger.ms": 5})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe([TOPIC])
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def on_delivery(err, msg) -> None:
    if err is not None:
        log.error("message event %s not delivered: %s", msg.key(), err)


def publish(message: dict) -> None:
    """One message.created event per stored message (the dict store_message returns), keyed by the channel."""
    event = {
        "type": "message.created",
        "channel_id": message["channel_id"],
        "id": message["id"],
        "author_id": message["author_id"],
        "content": message["content"],
    }
    # TODO: produce to TOPIC keyed by str(message["channel_id"]) with on_delivery; poll(0); never block here
    raise NotImplementedError


def apply(event: dict) -> None:
    """Moves the channel's state in Redis for one message.created event."""
    # TODO: key = f"channel:{channel_id}"; HSET key last_message_id <id>; HINCRBY key messages 1
    raise NotImplementedError


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse JSON; skip + commit anything that is not a message.created with channel_id and id
        # TODO: apply(event), then commit this message
        raise NotImplementedError
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

TOPIC = "message-events"
GROUP = "channel-state"
log = logging.getLogger("message-events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True, "linger.ms": 5})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def on_delivery(err, msg) -> None:
    if err is not None:
        log.error("message event %s not delivered: %s", msg.key(), err)


def publish(message: dict) -> None:
    """One message.created event per stored message (the dict store_message returns), keyed by the channel."""
    event = {
        "type": "message.created",
        "channel_id": message["channel_id"],
        "id": message["id"],
        "author_id": message["author_id"],
        "content": message["content"],
    }
    producer.produce(TOPIC, key=str(message["channel_id"]), value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately


def apply(event: dict) -> None:
    """Moves the channel's state in Redis for one message.created event."""
    key = f"channel:{event['channel_id']}"
    r.hset(key, "last_message_id", event["id"])
    r.hincrby(key, "messages", 1)


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
            if event.get("type") != "message.created" or "channel_id" not in event or "id" not in event:
                raise ValueError("not a message.created event")
        except (ValueError, TypeError, AttributeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        apply(event)
        consumer.commit(message=msg, asynchronous=False)  # after the write: at-least-once
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

const topic = "message-events"

// message is what step 1's storeMessage returns.
type message struct {
	ID        string \`json:"id"\`
	ChannelID string \`json:"channel_id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
}

type event struct {
	Type      string \`json:"type"\`
	ChannelID string \`json:"channel_id"\`
	ID        string \`json:"id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 5 * time.Millisecond,
	// TODO: Async writes with a Completion callback that logs failures
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "channel-state",
	Topic:   topic,
})

// publish emits one message.created event per stored message, keyed by the channel.
func publish(ctx context.Context, msg message) {
	value, _ := json.Marshal(event{Type: "message.created", ChannelID: msg.ChannelID, ID: msg.ID, AuthorID: msg.AuthorID, Content: msg.Content})
	// TODO: WriteMessages with the channel id as Key; never block the request on the broker
	_ = value
	log.Println("not implemented")
}

// apply moves the channel's state in Redis for one message.created event.
func apply(ctx context.Context, ev event) error {
	// TODO: key := "channel:" + ev.ChannelID; HSet key last_message_id ev.ID; HIncrBy key messages 1
	return nil
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse JSON; skip + commit anything that is not a message.created with channel_id and id
		// TODO: apply(ev), then CommitMessages for this message
		return nil
	}
}

func main() {
	log.Fatal(run(context.Background()))
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

const topic = "message-events"

// message is what step 1's storeMessage returns.
type message struct {
	ID        string \`json:"id"\`
	ChannelID string \`json:"channel_id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
}

type event struct {
	Type      string \`json:"type"\`
	ChannelID string \`json:"channel_id"\`
	ID        string \`json:"id"\`
	AuthorID  string \`json:"author_id"\`
	Content   string \`json:"content"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 5 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d message events not delivered: %v", len(messages), err)
		}
	},
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "channel-state",
	Topic:   topic,
})

// publish emits one message.created event per stored message, keyed by the channel.
func publish(ctx context.Context, msg message) {
	value, _ := json.Marshal(event{Type: "message.created", ChannelID: msg.ChannelID, ID: msg.ID, AuthorID: msg.AuthorID, Content: msg.Content})
	// Async writer: this enqueues and returns; Completion reports the outcome.
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(msg.ChannelID), Value: value})
}

// apply moves the channel's state in Redis for one message.created event.
func apply(ctx context.Context, ev event) error {
	key := "channel:" + ev.ChannelID
	if err := rdb.HSet(ctx, key, "last_message_id", ev.ID).Err(); err != nil {
		return err
	}
	return rdb.HIncrBy(ctx, key, "messages", 1).Err()
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var ev event
		if err := json.Unmarshal(msg.Value, &ev); err != nil || ev.Type != "message.created" || ev.ChannelID == "" || ev.ID == "" {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		if err := apply(ctx, ev); err != nil {
			return err // do not commit: the record will be redelivered
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}

func main() {
	log.Fatal(run(context.Background()))
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

/** What step 1's storeMessage returns. */
final case class StoredMessage(id: String, channelId: String, authorId: String, content: String, bucket: Int)

object MessageEvents {
  val Topic = "message-events"
  val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "channel-state")
  consumerProps.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"message event not delivered: \${exception.getMessage}")
  }

  /** One message.created event per stored message, keyed by the channel. */
  def publish(message: StoredMessage): Unit = {
    val value = JsObject(
      "type" -> JsString("message.created"),
      "channel_id" -> JsString(message.channelId),
      "id" -> JsString(message.id),
      "author_id" -> JsString(message.authorId),
      "content" -> JsString(message.content),
    ).compactPrint
    // TODO: send a record keyed by message.channelId with onDelivery; do not block on the future
  }

  /** Moves the channel's state in Redis for one message.created event. */
  def apply(channelId: String, id: String): Unit = {
    // TODO: val key = s"channel:$channelId"; HSET key last_message_id id; HINCRBY key messages 1
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        // TODO: parse the JSON; skip anything that is not a message.created with channel_id and id
        // TODO: apply(channelId, id)
      }
      // TODO: commit synchronously after the batch is processed
    }

  def main(args: Array[String]): Unit = run()
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scala.util.Try
import spray.json._

/** What step 1's storeMessage returns. */
final case class StoredMessage(id: String, channelId: String, authorId: String, content: String, bucket: Int)

object MessageEvents {
  val Topic = "message-events"
  val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "channel-state")
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"message event not delivered: \${exception.getMessage}")
  }

  /** One message.created event per stored message, keyed by the channel. */
  def publish(message: StoredMessage): Unit = {
    val value = JsObject(
      "type" -> JsString("message.created"),
      "channel_id" -> JsString(message.channelId),
      "id" -> JsString(message.id),
      "author_id" -> JsString(message.authorId),
      "content" -> JsString(message.content),
    ).compactPrint
    val record = new ProducerRecord[String, String](Topic, message.channelId, value)
    producer.send(record, onDelivery) // enqueues; the future is not awaited
  }

  /** Moves the channel's state in Redis for one message.created event. */
  def apply(channelId: String, id: String): Unit = {
    val key = s"channel:$channelId"
    jedis.hset(key, "last_message_id", id)
    jedis.hincrBy(key, "messages", 1L)
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        Try(record.value().parseJson.asJsObject.fields).toOption.flatMap { fields =>
          (fields.get("type"), fields.get("channel_id"), fields.get("id")) match {
            case (Some(JsString("message.created")), Some(JsString(channelId)), Some(JsString(id))) => Some((channelId, id))
            case _ => None
          }
        } match {
          case Some((channelId, id)) => apply(channelId, id)
          case None => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // after every record of the batch has been applied: at-least-once
    }

  def main(args: Array[String]): Unit = run()
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "message-events";
sw::redis::Redis redis("tcp://redis:6379");

// What step 1's store_message returns.
struct StoredMessage {
  std::string id;
  std::string channel_id;
  std::string author_id;
  std::string content;
  int32_t bucket;
};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "message event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "channel-state", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// One message.created event per stored message, keyed by the channel.
void publish(const StoredMessage& message) {
  const std::string value = json{{"type", "message.created"},
                                 {"channel_id", message.channel_id},
                                 {"id", message.id},
                                 {"author_id", message.author_id},
                                 {"content", message.content}}
                                .dump();
  // TODO: produce to kTopic keyed by message.channel_id (RK_MSG_COPY); poll(0) to serve callbacks; never block here
}

// Moves the channel's state in Redis for one message.created event.
void apply(const std::string& channel_id, const std::string& id) {
  // TODO: const std::string key = "channel:" + channel_id; HSET key last_message_id id; HINCRBY key messages 1
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
    // TODO: skip + commit anything that is not a message.created object with string channel_id and id
    // TODO: apply(channel_id, id); then commitSync this message
  }
}

int main() { run(); }
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "message-events";
sw::redis::Redis redis("tcp://redis:6379");

// What step 1's store_message returns.
struct StoredMessage {
  std::string id;
  std::string channel_id;
  std::string author_id;
  std::string content;
  int32_t bucket;
};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "message event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "channel-state", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// One message.created event per stored message, keyed by the channel.
void publish(const StoredMessage& message) {
  const std::string value = json{{"type", "message.created"},
                                 {"channel_id", message.channel_id},
                                 {"id", message.id},
                                 {"author_id", message.author_id},
                                 {"content", message.content}}
                                .dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), message.channel_id.c_str(), message.channel_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

// Moves the channel's state in Redis for one message.created event.
void apply(const std::string& channel_id, const std::string& id) {
  const std::string key = "channel:" + channel_id;
  redis.hset(key, "last_message_id", id);
  redis.hincrby(key, "messages", 1);
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
    if (!event.is_object() || event.value("type", "") != "message.created" || !event.contains("channel_id") ||
        !event["channel_id"].is_string() || !event.contains("id") || !event["id"].is_string()) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    apply(event["channel_id"].get<std::string>(), event["id"].get<std::string>());
    consumer->commitSync(msg.get());  // after the write: at-least-once
  }
}

int main() { run(); }
`,
    },
  },
  harness: {
    python: `import json
import logging

CHANNEL = "1032000000000000001"
OTHER = "1032000000000000002"


def _event(channel, mid, content="hi"):
    return json.dumps({"type": "message.created", "channel_id": channel, "id": str(mid), "author_id": "7", "content": content})


def _seed(ctx, *events):
    """events: (channel, message id) pairs, produced in order."""
    for channel, mid in events:
        ctx.kafka.seed("message-events", key=channel, value=_event(channel, mid))


def _stored(channel, mid, content="hi"):
    """What store_message (step 1) returns."""
    return {"id": str(mid), "channel_id": channel, "author_id": "7", "content": content, "bucket": 430}


def _module(ctx):
    m = ctx.load("message_events")
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger().addHandler(handler)
    return m, records


def check_keyed_by_channel(ctx):
    m, _ = _module(ctx)
    m.publish(_stored(CHANNEL, 1561000000000000001))
    m.publish(_stored(CHANNEL, 1561000000000000002, "second"))
    m.publish(_stored(OTHER, 1561000000000000003))
    produced = ctx.kafka.records("message-events")
    assert len(produced) == 3, f"three stored messages must be three records on message-events, found {len(produced)} (topics: {list(ctx.kafka.topics)})"
    assert [r.key for r in produced] == [CHANNEL.encode(), CHANNEL.encode(), OTHER.encode()], f"records must be keyed by the channel id, got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "two events of one channel must land on the same partition"
    event = json.loads(produced[1].value)
    expected = {"type": "message.created", "channel_id": CHANNEL, "id": "1561000000000000002", "author_id": "7", "content": "second"}
    for field, value in expected.items():
        assert event.get(field) == value, f"event.{field} is {event.get(field)!r}, expected {value!r}: {event}"


def check_non_blocking(ctx):
    m, logged = _module(ctx)
    m.publish(_stored(CHANNEL, 1561000000000000001))
    assert len(ctx.kafka.records("message-events")) == 1, "the event must be handed to the producer"
    ctx.kafka.stall()  # the brokers stop acknowledging, as a partitioned or overloaded cluster does
    started = ctx.clock.time()
    m.publish(_stored(CHANNEL, 1561000000000000002))
    m.publish(_stored(CHANNEL, 1561000000000000003))
    waited = ctx.clock.time() - started
    assert waited < 0.1, f"with the broker not acknowledging, two publish calls took {waited:.1f} s: publish waits for the broker (a flush on the request path), so every POST would hang with it"
    ctx.kafka.resume()
    ctx.kafka.fail_next("message-events")
    m.publish(_stored(CHANNEL, 1561000000000000004))
    m.publish(_stored(CHANNEL, 1561000000000000005))
    failures = [r for r in logged if r.levelno >= logging.WARNING]
    assert failures, "the broker failed to deliver a record and nothing was logged: publish must serve delivery callbacks (poll(0)) so on_delivery reports failures"


def check_consumer_group(ctx):
    _seed(ctx, (CHANNEL, 1561000000000000001), (OTHER, 1561000000000000002), (CHANNEL, 1561000000000000003))
    records = ctx.kafka.records("message-events")
    commits = []
    ctx.kafka.on_commit(lambda group, offsets: commits.append((group, dict(offsets), {c: ctx.redis.hget(f"channel:{c}", "messages") for c in (CHANNEL, OTHER)})))
    m, _ = _module(ctx)
    ctx.drain(m.run)
    assert commits, "no offset was ever committed: the consumer must commit what it processed"
    groups = sorted({group for group, _offsets, _state in commits})
    assert groups == ["channel-state"], f"offsets were committed for group(s) {groups}, expected channel-state"
    seen = {}
    for record in records:
        channel = record.key.decode()
        seen[channel] = seen.get(channel, 0) + 1
        state = next((s for _g, offsets, s in commits if offsets.get(("message-events", record.partition), -1) > record.offset), None)
        assert state is not None, f"the record at partition {record.partition} offset {record.offset} was processed but never committed by channel-state"
        counted = int(state[channel] or 0)
        assert counted >= seen[channel], f"the record at partition {record.partition} offset {record.offset} was committed while channel:{channel} counted {counted} message(s), before its own event was written: commit after processing"
    # A write that is slow and then fails: the record must stay uncommitted, to be redelivered.
    broken = "1032000000000000009"
    ctx.redis.set(f"channel:{broken}", "not a hash")  # a corrupted key: HSET/HINCRBY fail with WRONGTYPE
    ctx.redis_after(f"channel:{broken}", lambda: ctx.clock.advance(6))
    _seed(ctx, (broken, 1561000000000000009))
    record = ctx.kafka.records("message-events")[-1]
    try:
        ctx.drain(m.run)
    except Exception:
        pass  # the worker crashed on the failed write; a restart would redeliver the record
    committed = ctx.kafka.committed_offset("channel-state", "message-events", record.partition)
    assert committed is None or committed <= record.offset, f"the write for channel:{broken} took 6 s and then failed, yet its record (partition {record.partition} offset {record.offset}) was committed: offsets were committed while the record was still being processed (auto-commit on a timer), so the event is lost"


def check_channel_state(ctx):
    _seed(ctx, (CHANNEL, 1561000000000000001), (OTHER, 1561000000000000002), (CHANNEL, 1561000000000000003), (CHANNEL, 1561000000000000005))
    m, _ = _module(ctx)
    ctx.drain(m.run)
    key = f"channel:{CHANNEL}"
    assert ctx.redis.type(key) == "hash", f"{key} is {ctx.redis.type(key)!r}, expected a hash (keys: {ctx.redis.keys()})"
    state = ctx.redis.hgetall(key)
    assert state.get("last_message_id") == "1561000000000000005", f"{key}.last_message_id is {state.get('last_message_id')!r}, expected the newest id 1561000000000000005"
    assert state.get("messages") == "3", f"{key}.messages is {state.get('messages')!r}, expected 3 after three events"
    other = ctx.redis.hgetall(f"channel:{OTHER}")
    assert other.get("last_message_id") == "1561000000000000002" and other.get("messages") == "1", f"channel:{OTHER} must track its own single event, got {other}"


def check_commit_after(ctx):
    _seed(ctx, (CHANNEL, 1561000000000000001))
    ctx.kafka.seed("message-events", key="bad", value="not json")
    ctx.kafka.seed("message-events", key="bad", value=json.dumps({"type": "channel.renamed", "channel_id": OTHER}))
    ctx.kafka.seed("message-events", key="bad", value=json.dumps({"type": "message.created", "content": "no ids"}))
    record = ctx.kafka.records("message-events")[0]
    key = f"channel:{CHANNEL}"
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append((dict(offsets), ctx.redis.hget(key, "messages"))))
    m, _ = _module(ctx)
    ctx.drain(m.run)
    assert at_commit, "no offset was ever committed"
    covering = [count for offsets, count in at_commit if offsets.get(("message-events", record.partition), 0) > record.offset]
    assert covering, "the message.created record was never committed"
    assert covering[0] == "1", f"the commit must come after HINCRBY: when the record was committed the channel counted {covering[0]!r} message(s)"
    assert ctx.kafka.lag("channel-state", "message-events") == 0, "malformed records must be skipped and committed, not left to replay forever"
    assert ctx.redis.keys("channel:*") == [key], f"malformed records must not touch Redis, found {ctx.redis.keys('channel:*')}"
    assert ctx.redis.hget(key, "messages") == "1", f"only the well-formed event counts, {key}.messages is {ctx.redis.hget(key, 'messages')!r}"
`,
  },
  debrief: `The topic decouples storing a message from everything that reacts to it: the API's job ends when the row is in and the record is in the producer's buffer, and search, push and counters each become a consumer group that can fall behind, catch up or be rebuilt without touching the write path. The key is a design decision disguised as a parameter: keyed by channel, a channel's events share a partition and arrive in order, which is exactly what makes "last message id" a safe thing to overwrite. Commit-after-write is the honest guarantee for a counter in Redis: a crash between the two replays one record and over-counts by one, which the hash can tolerate and a lost event could not. Real pipelines make the counter idempotent too, by remembering the last applied id per channel and skipping anything not newer, and they size the partition count for the hottest channel rather than the average, because one World Cup final channel is one partition's worth of writes.`,
};
