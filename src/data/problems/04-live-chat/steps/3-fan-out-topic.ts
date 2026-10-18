import type {Step} from '@/lib/types';

// ---- 3. Kafka fan-out across instances --------------------------------------------------------
export const fanOutTopicStep: Step = {
  id: 'fan-out-topic',
  title: 'Fan out across instances: one consumer group per server',
  concept: 'kafka',
  file: 'room_bus',
  focus: ['server-a', 'kafka', 'server-b'],
  task: `## Task

Ana's stream is on instance A, Bo's on instance B. A message said on A has to reach B. Implement the
room bus on top of the **\`chat-messages\`** topic. \`local_deliver(room, msg)\` is provided: it hands a
message to every stream on *this* instance subscribed to the room.

- \`publish(room, msg)\` produces the serialized \`ServerMsg\` to \`chat-messages\` **keyed by the room id**,
  so one room's messages stay in order on one partition. Do not block the stream on the broker.
- Every instance runs a consumer whose **group id is unique to the instance**:
  \`chat-server-{hostname}-{uuid or pid}\`. A unique group means every instance receives *every*
  message — a broadcast — which is what fan-out needs.
- \`auto.offset.reset=latest\`: a freshly started instance must not replay yesterday's chat into live
  streams. Auto-commit is fine: losing a live message on a crash (at-most-once) is acceptable here;
  history comes from the message store, not from Kafka.
- For every consumed record, decode the \`ServerMsg\` and call \`local_deliver(room, msg)\`.

:::widget consumer-groups {"partitions": 6}

> Look at what the widget does when two consumers share one group: the six partitions are *split*
> between them. With a shared \`chat-server\` group, instance A would only see the rooms hashed to its
> partitions and Bo would never hear Ana. One group per instance is the difference between a work
> queue and a broadcast.`,
  sequence: {
    participants: ['chat-server A', 'Kafka', 'chat-server B'],
    messages: [
      {from: 'chat-server A', to: 'Kafka', label: 'produce(chat-messages, key=room-7, ServerMsg)', kind: 'async'},
      {from: 'Kafka', to: 'chat-server A', label: 'poll (group chat-server-a-…) → record', kind: 'reply'},
      {from: 'Kafka', to: 'chat-server B', label: 'poll (group chat-server-b-…) → same record', kind: 'reply'},
      {from: 'chat-server A', to: 'chat-server A', label: 'local_deliver(room-7) → ana', kind: 'async'},
      {from: 'chat-server B', to: 'chat-server B', label: 'local_deliver(room-7) → bo', kind: 'async'},
    ],
  },
  hints: [
    'The group id is computed once at start-up from something that differs per process: the hostname plus a UUID or the pid. Two instances on the same host must still differ.',
    'The producer side is the same as any event producer: produce keyed by the room, poll/serve callbacks, return. The message comes back to this instance through its own consumer, which is exactly how the sender sees its own message.',
    'The consumer loop is: poll → decode the bytes back into a ServerMsg → local_deliver(key, msg). The record key *is* the room id, so you do not have to look inside the message to route it.',
  ],
  checks: [
    {
      id: 'topic-keyed',
      title: 'Produces to chat-messages keyed by room',
      detail:
        'Records go to the `chat-messages` topic with the room id as key so a room keeps its order on one partition. `publish` must not wait on the broker (no `flush()`, no `.get()` on the send future): the stream handler calls it inline.',
      match: {
        python: {
          all: [/"chat-messages"/, /producer\.produce\(\s*TOPIC\s*,[^\n]*key\s*=\s*room/],
          none: [/producer\.flush\(/],
        },
        typescript: {
          all: [/'chat-messages'|"chat-messages"/, /producer\.send\(\s*\{[^}]*topic:\s*TOPIC[\s\S]{0,200}?key:\s*room/],
        },
        go: {all: [/"chat-messages"/, /WriteMessages\(/, /Key:\s*\[\]byte\(\s*room\s*\)/], none: [/Async:\s*false/]},
        scala: {
          all: [/"chat-messages"/, /new ProducerRecord\[[^(]*\]\(\s*Topic\s*,\s*room\s*,/],
          none: [/producer\.send\([^\n]*\)\s*\.get\(/, /producer\.flush\(/],
        },
        cpp: {
          all: [
            /"chat-messages"/,
            /producer->produce\(\s*kTopic[\s\S]{0,400}?room\.(?:c_str|data)\(\)\s*,\s*room\.(?:size|length)\(\)/,
          ],
          none: [/producer->flush\(/],
        },
      },
    },
    {
      id: 'unique-group',
      title: 'Each instance is its own consumer group',
      detail:
        'The `group.id` must contain something unique per process (`chat-server-{hostname}-{uuid|pid}`); a shared group would split the topic between instances instead of broadcasting.',
      match: {
        python: {all: [/"group\.id"\s*:\s*GROUP_ID/, /GROUP_ID\s*=\s*f"chat-server-\{[^\n]*(gethostname|uuid)/]},
        typescript: {
          all: [
            /groupId:\s*GROUP_ID/,
            /GROUP_ID\s*=\s*`chat-server-\$\{[^\n]*hostname\(\)[^\n]*(randomUUID|randomBytes|pid)/,
          ],
        },
        go: {
          all: [
            /GroupID:\s*groupID/,
            /groupID\s*=\s*(?:"chat-server-"\s*\+|fmt\.Sprintf\(\s*"chat-server-)[^\n]*(hostname|Hostname|uuid)/,
          ],
        },
        scala: {all: [/"group\.id"\s*,\s*GroupId/, /GroupId\s*=\s*s"chat-server-\$\{[^\n]*(getHostName|randomUUID)/]},
        cpp: {all: [/"group\.id"\s*,\s*kGroupId/, /kGroupId\s*=\s*"chat-server-"\s*\+\s*[^\n]*(hostname|uuid)/]},
      },
    },
    {
      id: 'latest',
      title: 'Starts from the latest offset',
      detail:
        'A new group has no committed offset; `auto.offset.reset=latest` (kafka-go: `StartOffset: kafka.LastOffset`) keeps a restarted instance from replaying history into live streams.',
      match: {
        python: {all: [/"auto\.offset\.reset"\s*:\s*"latest"/]},
        typescript: {all: [/fromBeginning:\s*false/]},
        go: {all: [/StartOffset:\s*kafka\.LastOffset/]},
        scala: {all: [/"auto\.offset\.reset"\s*,\s*"latest"|AUTO_OFFSET_RESET_CONFIG\s*,\s*"latest"/]},
        cpp: {all: [/"auto\.offset\.reset"\s*,\s*"latest"/]},
      },
    },
    {
      id: 'deliver',
      title: 'Delivers every consumed record locally',
      detail:
        'The consumer subscribes to the topic and calls `local_deliver(room, msg)` with the decoded message for every record.',
      match: {
        python: {all: [/consumer\.subscribe\(\s*\[\s*TOPIC\s*\]\s*\)/, /local_deliver\(\s*[^\n]*,\s*msg\s*\)/]},
        typescript: {all: [/consumer\.subscribe\(\s*\{[^}]*topic:\s*TOPIC/, /localDeliver\(\s*[^\n]*,\s*msg\s*\)/]},
        go: {all: [/reader\.(Read|Fetch)Message\(/, /localDeliver\(\s*[^\n]*,\s*msg\s*\)/]},
        scala: {all: [/consumer\.subscribe\([^\n]*Topic/, /localDeliver\(\s*[^\n]*,\s*msg\s*\)/]},
        cpp: {all: [/consumer->subscribe\([^\n]*kTopic/, /local_deliver\(\s*[^\n]*,\s*msg\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import socket
import threading
import uuid

from confluent_kafka import Consumer, Producer

import chat_pb2
from subscriptions import local_deliver  # provided: hands msg to every local stream in the room

TOPIC = "chat-messages"
GROUP_ID = "chat-server"  # TODO: unique per instance: chat-server-{hostname}-{uuid}

producer = Producer({"bootstrap.servers": "kafka:9092", "linger.ms": 5})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP_ID,
        # TODO: auto.offset.reset latest — a restarted instance must not replay history to live clients
        "enable.auto.commit": True,
    }
)


def publish(room: str, msg: chat_pb2.ServerMsg) -> None:
    # TODO: produce msg.SerializeToString() to TOPIC keyed by room; poll(0); never block the stream
    raise NotImplementedError


def run_consumer() -> None:
    # TODO: subscribe to [TOPIC]; for every record decode a ServerMsg and local_deliver(room, msg)
    raise NotImplementedError


if __name__ == "__main__":
    threading.Thread(target=run_consumer, name="room-bus", daemon=True).start()
`,
      solution: `import socket
import threading
import uuid

from confluent_kafka import Consumer, Producer

import chat_pb2
from subscriptions import local_deliver  # provided: hands msg to every local stream in the room

TOPIC = "chat-messages"
GROUP_ID = f"chat-server-{socket.gethostname()}-{uuid.uuid4().hex[:8]}"  # every instance is its own group

producer = Producer({"bootstrap.servers": "kafka:9092", "linger.ms": 5})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": GROUP_ID,
        "auto.offset.reset": "latest",
        "enable.auto.commit": True,
    }
)


def publish(room: str, msg: chat_pb2.ServerMsg) -> None:
    producer.produce(TOPIC, key=room, value=msg.SerializeToString())
    producer.poll(0)  # serve delivery callbacks; returns immediately


def run_consumer() -> None:
    consumer.subscribe([TOPIC])
    while True:
        record = consumer.poll(0.2)
        if record is None or record.error():
            continue
        msg = chat_pb2.ServerMsg.FromString(record.value())
        local_deliver(record.key().decode(), msg)


if __name__ == "__main__":
    threading.Thread(target=run_consumer, name="room-bus", daemon=True).start()
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

import {Kafka} from 'kafkajs';
import {type ServerMsg, localDeliver} from 'subscriptions'; // provided: hands msg to every local stream in the room

export const TOPIC = 'chat-messages';
export const GROUP_ID = 'chat-server'; // TODO: unique per instance: chat-server-{hostname}-{uuid}

const kafka = new Kafka({clientId: 'chat-server', brokers: ['kafka:9092']});
const producer = kafka.producer();
const producerReady = producer.connect();
const consumer = kafka.consumer({groupId: GROUP_ID});

export async function publish(room: string, msg: ServerMsg): Promise<void> {
  // TODO: send JSON.stringify(msg) to TOPIC keyed by room; the stream handler must not wait on the broker
  throw new Error('not implemented');
}

export async function runConsumer(): Promise<void> {
  // TODO: subscribe to TOPIC from the latest offset (fromBeginning: false — a restarted instance must not
  // replay history to live clients); for every record decode a ServerMsg and localDeliver(room, msg)
  throw new Error('not implemented');
}
`,
      solution: `import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

import {Kafka} from 'kafkajs';
import {type ServerMsg, localDeliver} from 'subscriptions'; // provided: hands msg to every local stream in the room

export const TOPIC = 'chat-messages';
export const GROUP_ID = \`chat-server-\${hostname()}-\${randomUUID().slice(0, 8)}\`; // every instance is its own group

const kafka = new Kafka({clientId: 'chat-server', brokers: ['kafka:9092']});
const producer = kafka.producer();
const producerReady = producer.connect();
const consumer = kafka.consumer({groupId: GROUP_ID});

export async function publish(room: string, msg: ServerMsg): Promise<void> {
  await producerReady;
  await producer.send({topic: TOPIC, messages: [{key: room, value: JSON.stringify(msg)}]});
}

export async function runConsumer(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: false}); // latest: no replay into live streams
  await consumer.run({
    eachMessage: async ({message}) => {
      if (message.key === null || message.value === null) return;
      const msg = JSON.parse(message.value.toString()) as ServerMsg;
      localDeliver(message.key.toString(), msg);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	pb "chat/gen/chat"
)

const topic = "chat-messages"

var groupID = "chat-server" // TODO: unique per instance: chat-server-{hostname}-{pid}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	Async:        true,
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: groupID,
	Topic:   topic,
	// TODO: StartOffset LastOffset — a restarted instance must not replay history to live clients
})

// localDeliver hands the message to every stream on this instance subscribed to the room (subscriptions.go).
func localDeliver(room string, msg *pb.ServerMsg) {
	panic("not implemented")
}

func publish(ctx context.Context, room string, msg *pb.ServerMsg) error {
	// TODO: proto.Marshal the message; WriteMessages keyed by room (the writer is Async: no blocking)
	_ = strconv.Itoa
	_ = proto.Marshal
	return nil
}

func runConsumer(ctx context.Context) {
	// TODO: ReadMessage in a loop; proto.Unmarshal into a ServerMsg; localDeliver(room, msg)
	log.Println("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	pb "chat/gen/chat"
)

const topic = "chat-messages"

// Every instance is its own consumer group, so every instance sees every message.
var groupID = "chat-server-" + hostname() + "-" + strconv.Itoa(os.Getpid())

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	Async:        true,
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     groupID,
	Topic:       topic,
	StartOffset: kafka.LastOffset,
})

// localDeliver hands the message to every stream on this instance subscribed to the room (subscriptions.go).
func localDeliver(room string, msg *pb.ServerMsg) {
	panic("not implemented")
}

func publish(ctx context.Context, room string, msg *pb.ServerMsg) error {
	value, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(room), Value: value}) // Async: enqueues and returns
}

func runConsumer(ctx context.Context) {
	for {
		record, err := reader.ReadMessage(ctx) // commits as it goes: at-most-once is fine for live delivery
		if err != nil {
			log.Printf("room bus: %v", err)
			return
		}
		msg := &pb.ServerMsg{}
		if err := proto.Unmarshal(record.Value, msg); err != nil {
			continue
		}
		localDeliver(string(record.Key), msg)
	}
}
`,
    },
    scala: {
      starter: `import java.net.InetAddress
import java.time.Duration
import java.util.{Properties, UUID}

import chat.chat.ServerMsg
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{ByteArrayDeserializer, ByteArraySerializer, StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._

object RoomBus {
  val Topic = "chat-messages"
  val GroupId = "chat-server" // TODO: unique per instance: chat-server-{hostname}-{uuid}

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, Array[Byte]](producerProps, new StringSerializer, new ByteArraySerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", GroupId)
  // TODO: auto.offset.reset latest — a restarted instance must not replay history to live clients
  consumerProps.put("enable.auto.commit", "true")
  private val consumer = new KafkaConsumer[String, Array[Byte]](consumerProps, new StringDeserializer, new ByteArrayDeserializer)

  /** Provided (Subscriptions): hands the message to every stream on this instance subscribed to the room. */
  def localDeliver(room: String, msg: ServerMsg): Unit = ???

  def publish(room: String, msg: ServerMsg): Unit = {
    // TODO: send a record keyed by room with msg.toByteArray; do not wait for the future
  }

  def runConsumer(): Unit = {
    // TODO: subscribe to Topic; for every record ServerMsg.parseFrom the value and localDeliver(room, msg)
  }

  def start(): Unit = new Thread(() => runConsumer(), "room-bus").start()
}
`,
      solution: `import java.net.InetAddress
import java.time.Duration
import java.util.{Properties, UUID}

import chat.chat.ServerMsg
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{ByteArrayDeserializer, ByteArraySerializer, StringDeserializer, StringSerializer}
import scala.jdk.CollectionConverters._

object RoomBus {
  val Topic = "chat-messages"

  /** Every instance is its own consumer group, so every instance sees every message. */
  val GroupId = s"chat-server-\${InetAddress.getLocalHost.getHostName}-\${UUID.randomUUID()}"

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, Array[Byte]](producerProps, new StringSerializer, new ByteArraySerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", GroupId)
  consumerProps.put("auto.offset.reset", "latest")
  consumerProps.put("enable.auto.commit", "true")
  private val consumer = new KafkaConsumer[String, Array[Byte]](consumerProps, new StringDeserializer, new ByteArrayDeserializer)

  /** Provided (Subscriptions): hands the message to every stream on this instance subscribed to the room. */
  def localDeliver(room: String, msg: ServerMsg): Unit = ???

  def publish(room: String, msg: ServerMsg): Unit =
    producer.send(new ProducerRecord[String, Array[Byte]](Topic, room, msg.toByteArray)) // enqueues; the future is not awaited

  def runConsumer(): Unit = {
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      val records = consumer.poll(Duration.ofMillis(200))
      records.asScala.foreach { record =>
        val msg = ServerMsg.parseFrom(record.value())
        localDeliver(record.key(), msg)
      }
    }
  }

  def start(): Unit = new Thread(() => runConsumer(), "room-bus").start()
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <unistd.h>

#include <memory>
#include <string>

#include "chat.pb.h"

using chat::ServerMsg;

const std::string kTopic = "chat-messages";

std::string hostname() {
  char buf[256];
  return gethostname(buf, sizeof buf) == 0 ? std::string(buf) : "unknown";
}

const std::string kGroupId = "chat-server";  // TODO: unique per instance: chat-server-{hostname}-{pid}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("linger.ms", "5", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroupId, err);
  // TODO: auto.offset.reset latest — a restarted instance must not replay history to live clients
  conf->set("enable.auto.commit", "true", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// Provided (subscriptions.cpp): hands the message to every stream on this instance subscribed to the room.
void local_deliver(const std::string& room, const ServerMsg& msg);

void publish(const std::string& room, const ServerMsg& msg) {
  // TODO: produce msg.SerializeAsString() keyed by room (RK_MSG_COPY); poll(0); never block the stream
}

void run_consumer() {
  // TODO: consume in a loop; ParseFromArray into a ServerMsg; local_deliver(*record->key(), msg)
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <unistd.h>

#include <memory>
#include <string>

#include "chat.pb.h"

using chat::ServerMsg;

const std::string kTopic = "chat-messages";

std::string hostname() {
  char buf[256];
  return gethostname(buf, sizeof buf) == 0 ? std::string(buf) : "unknown";
}

// Every instance is its own consumer group, so every instance sees every message.
const std::string kGroupId = "chat-server-" + hostname() + "-" + std::to_string(getpid());

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("linger.ms", "5", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroupId, err);
  conf->set("auto.offset.reset", "latest", err);
  conf->set("enable.auto.commit", "true", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

// Provided (subscriptions.cpp): hands the message to every stream on this instance subscribed to the room.
void local_deliver(const std::string& room, const ServerMsg& msg);

void publish(const std::string& room, const ServerMsg& msg) {
  std::string value = msg.SerializeAsString();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    value.data(), value.size(), room.c_str(), room.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

void run_consumer() {
  while (true) {
    std::unique_ptr<RdKafka::Message> record(consumer->consume(200));
    if (record->err() != RdKafka::ERR_NO_ERROR) continue;  // timeouts included
    ServerMsg msg;
    if (!msg.ParseFromArray(record->payload(), static_cast<int>(record->len()))) continue;
    local_deliver(*record->key(), msg);
  }
}
`,
    },
  },
  harness: {
    python: `import socket

import chat_pb2

TOPIC = "chat-messages"


def _msg(room, user, text, ts=1700000000000):
    return chat_pb2.ServerMsg(room=room, user=user, text=text, ts=ts)


def _recording(m):
    """Replace the provided local_deliver with a recorder of (room, msg)."""
    delivered = []
    m.local_deliver = lambda room, msg: delivered.append((room, msg))
    return delivered


def check_topic_keyed(ctx):
    m = ctx.load("room_bus")
    hi = _msg("room-7", "ana", "hi")
    m.publish("room-7", hi)
    m.publish("room-8", _msg("room-8", "bo", "yo"))
    m.publish("room-7", _msg("room-7", "cy", "hey"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish calls produced {len(records)} record(s) to {TOPIC!r}; topics seen: {sorted(ctx.kafka.topics)}"
    keys = [r.key for r in records]
    assert keys == [b"room-7", b"room-8", b"room-7"], f"record keys are {keys}, expected the room ids [b'room-7', b'room-8', b'room-7']"
    assert chat_pb2.ServerMsg.FromString(records[0].value) == hi, f"the record value must be the serialized ServerMsg; parsed back: {chat_pb2.ServerMsg.FromString(records[0].value)!r}"
    parts = {r.partition for r in records if r.key == b"room-7"}
    assert len(parts) == 1, f"room-7's messages landed on partitions {sorted(parts)}: keyed by room they stay on one partition"
    assert ctx.kafka.flushes == 0, "publish must not flush(): the stream handler calls it inline and must not wait on the broker"


def check_unique_group(ctx):
    a = ctx.load("room_bus")
    b = ctx.load("room_bus")
    ga, gb = a.GROUP_ID, b.GROUP_ID
    host = socket.gethostname()
    assert isinstance(ga, str) and ga.startswith("chat-server-"), f"GROUP_ID is {ga!r}, expected chat-server-{{hostname}}-{{uuid or pid}}"
    assert host in ga, f"GROUP_ID {ga!r} does not contain the hostname {host!r}"
    assert len(ga) > len("chat-server-") + len(host) + 1, f"GROUP_ID {ga!r} needs a per-process part (uuid or pid) after the hostname"
    assert ga != gb, f"two instances on this host computed the same group id {ga!r}: with a shared group the topic is split between them instead of broadcast"
    groups = {c.group for c in ctx.kafka.consumers}
    assert ga in groups and gb in groups, f"the broker saw consumer groups {sorted(groups)}, expected the consumers to use group.id = GROUP_ID ({ga!r}, {gb!r})"
    da, db = _recording(a), _recording(b)
    seeded = set()

    def on_subscribe(group, topics):  # each instance's first subscription is answered by one new message
        if group in seeded:
            return
        seeded.add(group)
        a.publish("room-7", _msg("room-7", "ana", "hello from " + ("A" if group == ga else "B")))

    ctx.kafka.on_subscribe(on_subscribe)
    ctx.drain(a.run_consumer)  # A joins and sees 'hello from A'
    ctx.drain(b.run_consumer)  # B joins; 'hello from B' is produced while both groups exist
    ctx.drain(a.run_consumer)  # A resumes from its committed offset
    texts_a = [msg.text for _, msg in da]
    texts_b = [msg.text for _, msg in db]
    assert texts_b == ["hello from B"], f"instance B delivered {texts_b}, expected ['hello from B']"
    assert texts_a == ["hello from A", "hello from B"], f"instance A delivered {texts_a}, expected ['hello from A', 'hello from B']: with one group per instance every instance receives every message"


def check_latest(ctx):
    m = ctx.load("room_bus")
    delivered = _recording(m)
    ctx.kafka.seed(TOPIC, key="room-7", value=_msg("room-7", "ana", "yesterday").SerializeToString())
    ctx.kafka.on_subscribe(lambda group, topics: m.publish("room-7", _msg("room-7", "bo", "now")))
    ctx.drain(m.run_consumer)
    texts = [msg.text for _, msg in delivered]
    assert texts == ["now"], f"a freshly started instance delivered {texts}, expected ['now']: a new group must start at the latest offset, not replay 'yesterday'"
    conf = ctx.kafka.consumers[-1].conf
    assert str(conf.get("auto.offset.reset", "")).lower() == "latest", f"auto.offset.reset is {conf.get('auto.offset.reset')!r}: set it to 'latest' explicitly"


def check_deliver(ctx):
    m = ctx.load("room_bus")
    delivered = _recording(m)
    expected = [("room-7", _msg("room-7", "ana", "hi", 1)), ("room-8", _msg("room-8", "bo", "yo", 2)), ("room-7", _msg("room-7", "cy", "hey", 3))]

    def seed(group, topics):
        for room, msg in expected:
            m.publish(room, msg)

    ctx.kafka.on_subscribe(seed)
    ctx.drain(m.run_consumer)
    subscribed = [e for e in ctx.kafka.events if e[0] == "subscribe" and TOPIC in e[2]]
    assert subscribed, f"the consumer never subscribed to {TOPIC!r} (subscribe events: {[e for e in ctx.kafka.events if e[0] == 'subscribe']})"
    assert len(delivered) == 3, f"three records were produced but local_deliver was called {len(delivered)} time(s)"
    for room, msg in delivered:
        assert isinstance(msg, chat_pb2.ServerMsg), f"local_deliver must receive a decoded ServerMsg, got {type(msg).__name__}"
    got = sorted((room, msg.user, msg.text, msg.ts) for room, msg in delivered)
    want = sorted((room, msg.user, msg.text, msg.ts) for room, msg in expected)
    assert got == want, f"local_deliver received {got}, expected {want} (room = the record key, msg = the decoded value)"
    room7 = [msg.text for room, msg in delivered if room == "room-7"]
    assert room7 == ["hi", "hey"], f"room-7's messages were delivered as {room7}, expected ['hi', 'hey'] in production order"
`,
    typescript: `const TOPIC = 'chat-messages';

const msg = (room, user, text, ts = 1700000000000) => ({room, user, text, ts});

/** Everything localDeliver hands to \`room\` on this instance: a real subscription on the shared table. */
function recording(ctx, room = 'room-7', into = []) {
  const subs = ctx.load('/support/subscriptions.ts');
  const inbox = subs.subscribe(room);
  void (async () => {
    for await (const m of inbox) into.push([room, m]);
  })();
  return into;
}

/**
 * Run \`fn(group)\` the moment a consumer subscribes to the topic — before its run loop polls — the way
 * another instance's message lands between a subscription and its first poll. A record seeded there
 * is what the learner's own publish produces: the JSON ServerMsg keyed by the room.
 */
function onSubscribe(ctx, fn) {
  ctx.kafka.onSubscribe((group, topics) => {
    if (topics.includes(TOPIC)) fn(group);
  });
}

const seed = (ctx, room, m) => ctx.kafka.seed(TOPIC, {key: room, value: JSON.stringify(m)});
const subscribeEvents = ctx => ctx.kafka.events.filter(e => e[0] === 'subscribe');

export async function check_topic_keyed(ctx) {
  const m = ctx.load('room_bus');
  const hi = msg('room-7', 'ana', 'hi');
  await m.publish('room-7', hi);
  await m.publish('room-8', msg('room-8', 'bo', 'yo'));
  await m.publish('room-7', msg('room-7', 'cy', 'hey'));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publish calls produced \${records.length} record(s) to '\${TOPIC}'; topics seen: \${JSON.stringify([...ctx.kafka.topics.keys()])}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['room-7', 'room-8', 'room-7'], \`record keys are \${JSON.stringify(keys)}, expected the room ids ['room-7', 'room-8', 'room-7']\`);
  const parsed = JSON.parse(records[0].value.toString());
  assert.deepEqual(parsed, hi, \`the record value must be the JSON-serialized ServerMsg; parsed back: \${JSON.stringify(parsed)}\`);
  const parts = new Set(records.filter(r => r.key.toString() === 'room-7').map(r => r.partition));
  assert.equal(parts.size, 1, \`room-7's messages landed on partitions \${JSON.stringify([...parts].sort())}: keyed by room they stay on one partition\`);
}

export async function check_unique_group(ctx) {
  const a = ctx.load('room_bus');
  const da = recording(ctx);
  ctx.modules.purge(); // a second process: fresh module instances, its own subscription table
  const b = ctx.load('room_bus');
  const db = recording(ctx);
  const [ga, gb] = [a.GROUP_ID, b.GROUP_ID];
  const host = 'app-7f3c9d';
  assert(typeof ga === 'string' && ga.startsWith('chat-server-'), \`GROUP_ID is \${JSON.stringify(ga)}, expected chat-server-{hostname}-{uuid or pid}\`);
  assert(ga.includes(host), \`GROUP_ID \${JSON.stringify(ga)} does not contain the hostname \${JSON.stringify(host)}\`);
  assert(ga.length > 'chat-server-'.length + host.length + 1, \`GROUP_ID \${JSON.stringify(ga)} needs a per-process part (uuid or pid) after the hostname\`);
  assert.notEqual(ga, gb, \`two instances on this host computed the same group id \${JSON.stringify(ga)}: with a shared group the topic is split between them instead of broadcast\`);
  const seeded = new Set();
  onSubscribe(ctx, group => {
    // each instance's first subscription is answered by one new message
    if (seeded.has(group)) return;
    seeded.add(group);
    seed(ctx, 'room-7', msg('room-7', 'ana', 'hello from ' + (group === ga ? 'A' : 'B')));
  });
  await ctx.drain(a.runConsumer()); // A joins and sees 'hello from A'
  await ctx.drain(b.runConsumer()); // B joins; 'hello from B' is produced while both groups exist
  await ctx.drain(a.runConsumer()); // A resumes from its committed offset
  const groups = ctx.kafka.consumers.map(c => c.groupId);
  assert(groups.includes(ga) && groups.includes(gb), \`the broker saw consumer groups \${JSON.stringify([...new Set(groups)].sort())}, expected the consumers to use groupId: GROUP_ID (\${JSON.stringify(ga)}, \${JSON.stringify(gb)})\`);
  const textsA = da.map(([, x]) => x.text);
  const textsB = db.map(([, x]) => x.text);
  assert.deepEqual(textsB, ['hello from B'], \`instance B delivered \${JSON.stringify(textsB)}, expected ['hello from B']\`);
  assert.deepEqual(textsA, ['hello from A', 'hello from B'], \`instance A delivered \${JSON.stringify(textsA)}, expected ['hello from A', 'hello from B']: with one group per instance every instance receives every message\`);
}

export async function check_latest(ctx) {
  const m = ctx.load('room_bus');
  const delivered = recording(ctx);
  seed(ctx, 'room-7', msg('room-7', 'ana', 'yesterday'));
  onSubscribe(ctx, () => seed(ctx, 'room-7', msg('room-7', 'bo', 'now')));
  await ctx.drain(m.runConsumer());
  assert(subscribeEvents(ctx).length > 0, \`the consumer never subscribed to '\${TOPIC}'\`);
  const texts = delivered.map(([, x]) => x.text);
  assert.deepEqual(texts, ['now'], \`a freshly started instance delivered \${JSON.stringify(texts)}, expected ['now']: a new group must start at the latest offset (fromBeginning: false), not replay 'yesterday'\`);
}

export async function check_deliver(ctx) {
  const m = ctx.load('room_bus');
  const delivered = recording(ctx);
  recording(ctx, 'room-8', delivered);
  const expected = [['room-7', msg('room-7', 'ana', 'hi', 1)], ['room-8', msg('room-8', 'bo', 'yo', 2)], ['room-7', msg('room-7', 'cy', 'hey', 3)]];
  onSubscribe(ctx, () => expected.forEach(([room, x]) => seed(ctx, room, x)));
  await ctx.drain(m.runConsumer());
  assert(subscribeEvents(ctx).some(e => e[2].includes(TOPIC)), \`the consumer never subscribed to '\${TOPIC}' (subscribe events: \${JSON.stringify(subscribeEvents(ctx))})\`);
  assert.equal(delivered.length, 3, \`three records were produced but localDeliver was called \${delivered.length} time(s)\`);
  const shape = ([room, x]) => [room, x.user, x.text, x.ts];
  const got = delivered.map(shape).sort();
  const want = expected.map(shape).sort();
  assert.deepEqual(got, want, \`localDeliver received \${JSON.stringify(got)}, expected \${JSON.stringify(want)} (room = the record key, msg = the decoded value)\`);
  const room7 = delivered.filter(([room]) => room === 'room-7').map(([, x]) => x.text);
  assert.deepEqual(room7, ['hi', 'hey'], \`room-7's messages were delivered as \${JSON.stringify(room7)}, expected ['hi', 'hey'] in production order\`);
}
`,
  },
  debrief: `Kafka's consumer group is a *work-sharing* primitive: partitions are divided among the members. Fan-out wants the opposite, so each instance becomes a group of one and reads the whole topic — the same topic serves both patterns depending on how you name your groups. Keying by room keeps each room's messages ordered without ordering the whole world, and \`latest\` plus auto-commit is the honest choice for live delivery: what matters is now, and history has its own store. Real systems put a sequence number in each message so clients can detect gaps, use Redis Pub/Sub or a dedicated pub/sub layer when Kafka's per-partition latency is too high, and cap fan-out with room sharding for very large rooms.`,
};
