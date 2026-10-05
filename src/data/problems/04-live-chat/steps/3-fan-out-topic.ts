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


threading.Thread(target=run_consumer, name="room-bus", daemon=True).start()
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
  debrief: `Kafka's consumer group is a *work-sharing* primitive: partitions are divided among the members. Fan-out wants the opposite, so each instance becomes a group of one and reads the whole topic — the same topic serves both patterns depending on how you name your groups. Keying by room keeps each room's messages ordered without ordering the whole world, and \`latest\` plus auto-commit is the honest choice for live delivery: what matters is now, and history has its own store. Real systems put a sequence number in each message so clients can detect gaps, use Redis Pub/Sub or a dedicated pub/sub layer when Kafka's per-partition latency is too high, and cap fan-out with room sharding for very large rooms.`,
};
