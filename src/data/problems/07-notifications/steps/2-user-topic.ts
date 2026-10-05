import type {Step} from '@/lib/types';

export const userTopicStep: Step = {
  id: 'user-topic',
  title: 'Enqueue on a per-user ordered topic',
  concept: 'kafka',
  file: 'notification_bus',
  focus: ['api', 'bus'],
  task: `## Task

Implement \`enqueue(notification)\`: one record on the **\`notifications\`** topic per accepted request.
The API answered **202** on the strength of this call, so the record must actually be in Kafka when it
returns.

- Key the record by the **user id**: everything for one user lands on one partition, in order, so
  "your order shipped" cannot overtake "your order was placed".
- Put the \`priority\` in a **record header** so the consumer can read it without parsing the value.
- Configure the producer with **\`acks=all\`** and the **idempotent producer** enabled: a leader
  failover must not lose an acknowledged notification, and the producer's own retries must not
  duplicate one.
- **Wait for the acknowledgement** with a **2 s** timeout. No ack, or a delivery error → raise, so the
  API releases the idempotency key and answers 503.

:::widget kafka-partitions {"partitions": 8}

> The thumbnail service fired its analytics events and forgot about them. A notification is the
> opposite case: the request path pays the round trip because the 202 is a promise the service has to
> keep.`,
  sequence: {
    participants: ['notify API', 'Producer', 'Kafka'],
    messages: [
      {from: 'notify API', to: 'Producer', label: 'produce(notifications, key=u42, headers={priority})', kind: 'sync'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(u42) % 8', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (all in-sync replicas)', kind: 'reply'},
      {from: 'Producer', to: 'notify API', label: 'delivered (offset 90213) within 2 s', kind: 'reply'},
      {from: 'notify API', to: 'notify API', label: '202 to the caller', kind: 'sync'},
    ],
  },
  hints: [
    'The producer configuration carries the durability: `acks=all` plus `enable.idempotence=true` (kafka-go has no idempotent mode: `RequireAll` is what it can promise).',
    'Waiting means blocking on the future / flushing with a timeout / running the write under a context that expires — the delivery callback alone does not block anything.',
    'A timeout and a delivery error are the same outcome for the caller: raise. The API deletes the idempotency key and answers 503, and the retry comes back with the same key.',
  ],
  checks: [
    {
      id: 'durable-producer',
      title: 'Producer waits for all in-sync replicas and is idempotent',
      detail:
        '`acks=all` means a leader failover cannot lose an acknowledged record; the idempotent producer means client-side retries cannot duplicate one. (kafka-go: `RequiredAcks: kafka.RequireAll`.)',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/, /"enable\.idempotence"\s*:\s*True/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
      },
    },
    {
      id: 'keyed',
      title: 'Keys records by user id',
      detail:
        'The record key is the user id so all of one user’s notifications share a partition and keep their order.',
      match: {
        python: {all: [/producer\.produce\(/, /key\s*=\s*notification\[["']user_id["']\]/]},
        go: {all: [/writer\.WriteMessages\(/, /Key:\s*\[\]byte\(\s*\w+\.UserID\s*\)/]},
        scala: {all: [/producer\.send\(/, /new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*\w+\.userId\s*,/]},
        cpp: {all: [/producer->produce\(/, /(\w+)\.user_id\.(c_str|data)\(\)\s*,\s*\1\.user_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'priority-header',
      title: 'Carries the priority in a record header',
      detail:
        'A `priority` header lets the consumer route high-priority notifications without deserialising the value.',
      match: {
        python: {all: [/headers\s*=\s*[^\n]*["']priority["']/]},
        go: {all: [/kafka\.Header\{\{?\s*Key:\s*"priority"/]},
        scala: {all: [/headers\(\)\.add\(\s*"priority"|new RecordHeader\(\s*"priority"/]},
        cpp: {all: [/->add\(\s*"priority"/]},
      },
    },
    {
      id: 'wait-ack',
      title: 'Waits up to 2 s for the acknowledgement',
      detail:
        'The request path blocks until the broker acknowledged the record, bounded by a 2 s timeout — the 202 is only true once the record is in Kafka.',
      match: {
        python: {all: [/producer\.flush\(\s*(timeout\s*=\s*)?(ACK_TIMEOUT_S|2(\.0)?)\s*\)/]},
        go: {all: [/context\.WithTimeout\(\s*\w+\s*,\s*(ackTimeout|2\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/\.get\(\s*(AckTimeoutMillis|2000L?)\s*,\s*TimeUnit\.MILLISECONDS\s*\)/]},
        cpp: {all: [/producer->flush\(\s*(kAckTimeoutMs|2000)\s*\)/]},
      },
    },
    {
      id: 'fail-loud',
      title: 'Raises when the record was not delivered',
      detail:
        'A timeout or a delivery error must surface as an exception/error from `enqueue`; swallowing it would let the API promise a notification nobody will send.',
      match: {
        python: {all: [/raise BusUnavailable\(/]},
        go: {all: [/(?<!var )ErrBusUnavailable\b/]},
        scala: {all: [/throw new BusUnavailable\(/]},
        cpp: {all: [/throw BusUnavailable\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

TOPIC = "notifications"
ACK_TIMEOUT_S = 2.0

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        # TODO: acks=all and the idempotent producer
    }
)


class BusUnavailable(Exception):
    """The broker did not acknowledge in time; the API turns this into a 503."""


def enqueue(notification: dict) -> None:
    value = json.dumps(notification)
    # TODO: produce to TOPIC keyed by user_id, with a priority header and a delivery callback recording the outcome
    # TODO: flush with ACK_TIMEOUT_S; still queued or a delivery error → raise BusUnavailable
    raise NotImplementedError
`,
      solution: `import json

from confluent_kafka import Producer

TOPIC = "notifications"
ACK_TIMEOUT_S = 2.0

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


class BusUnavailable(Exception):
    """The broker did not acknowledge in time; the API turns this into a 503."""


def enqueue(notification: dict) -> None:
    value = json.dumps(notification)
    outcome: list = []  # [err] once the delivery report arrives
    producer.produce(
        TOPIC,
        key=notification["user_id"],
        value=value,
        headers={"priority": notification["priority"]},
        on_delivery=lambda err, msg: outcome.append(err),
    )
    remaining = producer.flush(ACK_TIMEOUT_S)
    if remaining or not outcome or outcome[0] is not None:
        raise BusUnavailable(f"no ack for {notification['id']} within {ACK_TIMEOUT_S}s: {outcome[:1]}")
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic      = "notifications"
	ackTimeout = 2 * time.Second
)

// ErrBusUnavailable: the broker did not acknowledge in time; the API turns this into a 503.
var ErrBusUnavailable = errors.New("notification bus unavailable")

var writer = &kafka.Writer{
	Addr:     kafka.TCP("kafka:9092"),
	Topic:    topic,
	Balancer: &kafka.Hash{},
	// TODO: wait for every in-sync replica (kafka-go has no idempotent mode; RequireAll is what it can promise)
}

type Notification struct {
	ID       string \`json:"id"\`
	UserID   string \`json:"user_id"\`
	Channel  string \`json:"channel"\`
	Title    string \`json:"title"\`
	Body     string \`json:"body"\`
	Priority string \`json:"priority"\`
}

func enqueue(ctx context.Context, n Notification) error {
	value, _ := json.Marshal(n)
	// TODO: WriteMessages keyed by n.UserID with a priority header, under a context that expires after ackTimeout
	// TODO: any error → wrap ErrBusUnavailable (the API answers 503)
	_ = value
	return errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic      = "notifications"
	ackTimeout = 2 * time.Second
)

// ErrBusUnavailable: the broker did not acknowledge in time; the API turns this into a 503.
var ErrBusUnavailable = errors.New("notification bus unavailable")

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type Notification struct {
	ID       string \`json:"id"\`
	UserID   string \`json:"user_id"\`
	Channel  string \`json:"channel"\`
	Title    string \`json:"title"\`
	Body     string \`json:"body"\`
	Priority string \`json:"priority"\`
}

func enqueue(ctx context.Context, n Notification) error {
	value, _ := json.Marshal(n)
	ctx, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()
	err := writer.WriteMessages(ctx, kafka.Message{
		Key:     []byte(n.UserID),
		Value:   value,
		Headers: []kafka.Header{{Key: "priority", Value: []byte(n.Priority)}},
	})
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrBusUnavailable, n.ID, err)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.{ExecutionException, TimeUnit, TimeoutException}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object NotificationBus {
  val Topic = "notifications"
  val AckTimeoutMillis = 2000L

  case class NotifyRequest(userId: String, channel: String, title: String, body: String, priority: String)

  /** The broker did not acknowledge in time; the API turns this into a 503. */
  class BusUnavailable(msg: String, cause: Throwable = null) extends RuntimeException(msg, cause)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // TODO: acks=all and the idempotent producer
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def toJson(id: String, n: NotifyRequest): String =
    s"""{"id":"$id","user_id":"\${n.userId}","channel":"\${n.channel}","title":"\${n.title}","body":"\${n.body}","priority":"\${n.priority}"}"""

  def enqueue(id: String, n: NotifyRequest): Unit = {
    val value = toJson(id, n)
    // TODO: a ProducerRecord keyed by n.userId with a priority header
    // TODO: send and get(AckTimeoutMillis) — a timeout or a failure → throw BusUnavailable
    ???
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.{ExecutionException, TimeUnit, TimeoutException}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object NotificationBus {
  val Topic = "notifications"
  val AckTimeoutMillis = 2000L

  case class NotifyRequest(userId: String, channel: String, title: String, body: String, priority: String)

  /** The broker did not acknowledge in time; the API turns this into a 503. */
  class BusUnavailable(msg: String, cause: Throwable = null) extends RuntimeException(msg, cause)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def toJson(id: String, n: NotifyRequest): String =
    s"""{"id":"$id","user_id":"\${n.userId}","channel":"\${n.channel}","title":"\${n.title}","body":"\${n.body}","priority":"\${n.priority}"}"""

  def enqueue(id: String, n: NotifyRequest): Unit = {
    val value = toJson(id, n)
    val record = new ProducerRecord[String, String](Topic, n.userId, value)
    record.headers().add("priority", n.priority.getBytes)
    try producer.send(record).get(AckTimeoutMillis, TimeUnit.MILLISECONDS)
    catch {
      case e: TimeoutException => throw new BusUnavailable(s"no ack for $id within 2 s", e)
      case e: ExecutionException => throw new BusUnavailable(s"broker refused $id", e.getCause)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <stdexcept>
#include <string>

#include "notification.h"  // struct Notification {id, user_id, channel, title, body, priority}; std::string to_json(const Notification&) — provided

const std::string kTopic = "notifications";
constexpr int kAckTimeoutMs = 2000;

// The broker did not acknowledge in time; the API turns this into a 503.
struct BusUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Delivery report: msg_opaque points at the RdKafka::ErrorCode slot the producing thread waits on.
class RecordOutcome : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    *static_cast<RdKafka::ErrorCode*>(message.msg_opaque()) = message.err();
  }
};
RecordOutcome outcomes;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &outcomes, err);
  // TODO: acks=all and the idempotent producer
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void enqueue(const Notification& n) {
  const std::string value = to_json(n);
  RdKafka::ErrorCode outcome = RdKafka::ERR__IN_PROGRESS;
  // TODO: headers with the priority; produce keyed by n.user_id (RK_MSG_COPY) with &outcome as msg_opaque
  // TODO: flush(kAckTimeoutMs); still queued or outcome != ERR_NO_ERROR → throw BusUnavailable
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <stdexcept>
#include <string>

#include "notification.h"  // struct Notification {id, user_id, channel, title, body, priority}; std::string to_json(const Notification&) — provided

const std::string kTopic = "notifications";
constexpr int kAckTimeoutMs = 2000;

// The broker did not acknowledge in time; the API turns this into a 503.
struct BusUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Delivery report: msg_opaque points at the RdKafka::ErrorCode slot the producing thread waits on.
class RecordOutcome : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    *static_cast<RdKafka::ErrorCode*>(message.msg_opaque()) = message.err();
  }
};
RecordOutcome outcomes;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &outcomes, err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void enqueue(const Notification& n) {
  const std::string value = to_json(n);
  RdKafka::ErrorCode outcome = RdKafka::ERR__IN_PROGRESS;
  auto headers = std::unique_ptr<RdKafka::Headers>(RdKafka::Headers::create());
  headers->add("priority", n.priority);
  const RdKafka::ErrorCode queued = producer->produce(
      kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
      value.size(), n.user_id.c_str(), n.user_id.size(), 0, headers.get(), &outcome);
  if (queued != RdKafka::ERR_NO_ERROR) throw BusUnavailable("enqueue " + n.id + ": " + RdKafka::err2str(queued));
  headers.release();  // owned by the producer once produce() accepted the message
  if (producer->flush(kAckTimeoutMs) != RdKafka::ERR_NO_ERROR || outcome != RdKafka::ERR_NO_ERROR)
    throw BusUnavailable("no ack for " + n.id + " within 2 s: " + RdKafka::err2str(outcome));
}
`,
    },
  },
  debrief: `Same key → same partition → same order is the only ordering Kafka gives you, and keying by user is exactly the order a user notices. \`acks=all\` plus the idempotent producer make the acknowledged record durable *and* unique across the client's own retries; waiting for that ack is what gives the 202 its meaning. Real producers keep one future per record instead of flushing the whole buffer (so one slow partition does not stall unrelated requests), and set \`delivery.timeout.ms\` so the client's retries and the caller's deadline agree.`,
};
