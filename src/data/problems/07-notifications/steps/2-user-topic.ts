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
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
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
        typescript: {all: [/producer\.send\(/, /key:\s*notification\.user_id/]},
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
        typescript: {all: [/headers:\s*\{[^\n]*priority/]},
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
        typescript: {all: [/timeout:\s*(ACK_TIMEOUT_MS|2000)\b/]},
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
        typescript: {all: [/throw new BusUnavailable\(/]},
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
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'notifications';
export const ACK_TIMEOUT_MS = 2000;

export interface Notification {
  id: string;
  user_id: string;
  channel: string;
  title: string;
  body: string;
  priority: string;
}

const kafka = new Kafka({clientId: 'notify-api', brokers: ['kafka:9092']});
// TODO: the idempotent producer (acks all is then mandatory)
export const producer = kafka.producer();

/** The broker did not acknowledge in time; the API turns this into a 503. */
export class BusUnavailable extends Error {}

export async function enqueue(notification: Notification): Promise<void> {
  await producer.connect();
  const value = JSON.stringify(notification);
  // TODO: send to TOPIC keyed by user_id, with a priority header, acks all and a timeout of ACK_TIMEOUT_MS
  // TODO: the send rejects (timeout or delivery error) → throw BusUnavailable
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'notifications';
export const ACK_TIMEOUT_MS = 2000;

export interface Notification {
  id: string;
  user_id: string;
  channel: string;
  title: string;
  body: string;
  priority: string;
}

const kafka = new Kafka({clientId: 'notify-api', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true});

/** The broker did not acknowledge in time; the API turns this into a 503. */
export class BusUnavailable extends Error {}

export async function enqueue(notification: Notification): Promise<void> {
  await producer.connect();
  const value = JSON.stringify(notification);
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
      messages: [{key: notification.user_id, value, headers: {priority: notification.priority}}],
    });
  } catch (e) {
    throw new BusUnavailable(\`no ack for \${notification.id} within \${ACK_TIMEOUT_MS} ms: \${(e as Error).message}\`);
  }
}
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
  harness: {
    python: `import json

from confluent_kafka import Producer


def _notification(nid, user_id, priority="normal"):
    return {"id": nid, "user_id": user_id, "channel": "push", "title": "Shipped", "body": "On its way", "priority": priority}


def _bus(ctx):
    m = ctx.load("notification_bus")
    m.producers = [p for p in vars(m).values() if isinstance(p, Producer)]
    assert m.producers, "the module must create a confluent_kafka Producer"
    m.flush_timeouts = []
    for p in m.producers:
        original = p.flush

        def flush(*args, _original=original, **kwargs):
            m.flush_timeouts.append(args[0] if args else kwargs.get("timeout"))
            return _original(*args, **kwargs)

        p.flush = flush
    return m


def _header(record, name):
    headers = record.headers or []
    for key, value in headers.items() if isinstance(headers, dict) else headers:
        if key == name:
            return value.decode() if isinstance(value, bytes) else str(value)
    return None


def check_durable_producer(ctx):
    m = _bus(ctx)
    conf = m.producers[0].conf
    acks = conf.get("acks")
    assert acks in ("all", -1, "-1"), f"the producer must be configured with acks=all, got acks={acks!r}"
    idempotent = conf.get("enable.idempotence")
    assert idempotent is True or str(idempotent).lower() == "true", f"the producer must enable enable.idempotence, got {idempotent!r}"


def check_keyed(ctx):
    m = _bus(ctx)
    m.enqueue(_notification("n1", "u42"))
    m.enqueue(_notification("n2", "u42"))
    m.enqueue(_notification("n3", "u7"))
    produced = ctx.kafka.records("notifications")
    assert len(produced) == 3, f"expected 3 records on notifications, found {len(produced)}"
    assert [r.key for r in produced] == [b"u42", b"u42", b"u7"], f"records must be keyed by the user id, got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "one user's notifications must share a partition"
    assert json.loads(produced[0].value).get("id") == "n1", f"the value must be the notification as JSON, got {produced[0].value!r}"


def check_priority_header(ctx):
    m = _bus(ctx)
    m.enqueue(_notification("n1", "u42", "high"))
    m.enqueue(_notification("n2", "u42", "normal"))
    produced = ctx.kafka.records("notifications")
    assert len(produced) == 2, f"expected 2 records on notifications, found {len(produced)}"
    assert _header(produced[0], "priority") == "high", f"the first record must carry a priority=high header, headers were {produced[0].headers!r}"
    assert _header(produced[1], "priority") == "normal", f"the second record must carry a priority=normal header, headers were {produced[1].headers!r}"


def check_wait_ack(ctx):
    m = _bus(ctx)
    m.enqueue(_notification("n1", "u42"))
    assert len(ctx.kafka.records("notifications")) == 1, "the record must be in Kafka when enqueue returns"
    assert m.flush_timeouts, "enqueue returned without flushing: the 202 was promised before the broker acknowledged"
    timeout = m.flush_timeouts[-1]
    assert timeout is not None, "flush() without a timeout can block the request forever"
    assert 1.0 <= float(timeout) <= 2.5, f"the acknowledgement wait must be bounded by about 2 s, flush was given {timeout!r}"


def check_fail_loud(ctx):
    m = _bus(ctx)
    ctx.kafka.fail_next("notifications")
    try:
        m.enqueue(_notification("n1", "u42"))
        raise AssertionError("a delivery error must raise BusUnavailable, enqueue returned normally")
    except m.BusUnavailable:
        pass
    assert ctx.kafka.records("notifications") == [], "the failed record must not be in the topic"
    m.enqueue(_notification("n2", "u42"))
    assert len(ctx.kafka.records("notifications")) == 1, "after the failure a new enqueue must work"
    for p in m.producers:
        p.flush = lambda *args, **kwargs: 1  # still queued when the timeout expires: no delivery report arrives
    try:
        m.enqueue(_notification("n3", "u42"))
        raise AssertionError("no acknowledgement within the timeout must raise BusUnavailable, enqueue returned normally")
    except m.BusUnavailable:
        pass
`,
    typescript: `function notification(id: string, userId: string, priority = 'normal') {
  return {id, user_id: userId, channel: 'push', title: 'Shipped', body: 'On its way', priority};
}

function bus(ctx) {
  return ctx.load('notification_bus');
}

function header(record, name: string): string | null {
  const value = record.headers?.[name];
  return value === undefined ? null : Buffer.from(value).toString();
}

function ids(ctx): string[] {
  return ctx.kafka.values('notifications').map((v: string) => JSON.parse(v).id);
}

/** The error a promise rejected with, or null when it resolved. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

export async function check_durable_producer(ctx) {
  const m = bus(ctx);
  await m.enqueue(notification('n1', 'u42'));
  ctx.kafka.failover('notifications');
  assert.equal(ctx.kafka.records('notifications').length, 1, 'enqueue returned (the API answered 202), then the partition leader failed and notifications is empty: the record had been acknowledged by the leader alone. The producer must wait for every in-sync replica (acks all)');
  ctx.kafka.loseAcks('notifications');
  await m.enqueue(notification('n2', 'u42'));
  assert.deepEqual(ids(ctx), ['n1', 'n2'], \`the acknowledgement of n2 was lost and the producer retried: notifications holds \${JSON.stringify(ids(ctx))}, expected n1 and n2 once each — enable the idempotent producer\`);
}

export async function check_keyed(ctx) {
  const m = bus(ctx);
  await m.enqueue(notification('n1', 'u42'));
  await m.enqueue(notification('n2', 'u42'));
  await m.enqueue(notification('n3', 'u7'));
  const produced = ctx.kafka.records('notifications');
  assert.equal(produced.length, 3, \`expected 3 records on notifications, found \${produced.length}\`);
  assert.deepEqual(ctx.kafka.keys('notifications'), ['u42', 'u42', 'u7'], \`records must be keyed by the user id, got \${JSON.stringify(ctx.kafka.keys('notifications'))}\`);
  assert.equal(produced[0].partition, produced[1].partition, "one user's notifications must share a partition");
  assert.equal(JSON.parse(Buffer.from(produced[0].value).toString()).id, 'n1', \`the value must be the notification as JSON, got \${JSON.stringify(Buffer.from(produced[0].value).toString())}\`);
}

export async function check_priority_header(ctx) {
  const m = bus(ctx);
  await m.enqueue(notification('n1', 'u42', 'high'));
  await m.enqueue(notification('n2', 'u42', 'normal'));
  const produced = ctx.kafka.records('notifications');
  assert.equal(produced.length, 2, \`expected 2 records on notifications, found \${produced.length}\`);
  assert.equal(header(produced[0], 'priority'), 'high', \`the first record must carry a priority=high header, headers were \${JSON.stringify(Object.keys(produced[0].headers))}\`);
  assert.equal(header(produced[1], 'priority'), 'normal', \`the second record must carry a priority=normal header, headers were \${JSON.stringify(Object.keys(produced[1].headers))}\`);
}

export async function check_wait_ack(ctx) {
  const m = bus(ctx);
  await m.enqueue(notification('n1', 'u42'));
  assert.equal(ctx.kafka.records('notifications').length, 1, 'the record must be in Kafka when enqueue returns');
  ctx.kafka.stall('notifications', 1); // the broker is slow but answers within the timeout
  const slow = await thrown(m.enqueue(notification('n2', 'u42')));
  assert.equal(slow, null, \`the broker acknowledged after 1 s, within the 2 s wait, yet enqueue threw: \${slow}\`);
  assert.equal(ctx.kafka.records('notifications').length, 2, 'the record must be in Kafka when enqueue returns');
  ctx.kafka.stall('notifications'); // the broker is down for good
  const started = ctx.clock.now();
  const down = await thrown(m.enqueue(notification('n3', 'u42')));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(down !== null, 'the broker never acknowledged, yet enqueue returned normally: the 202 was promised before the record was in Kafka');
  assert(1 <= waited && waited <= 2.5, \`the acknowledgement wait must be bounded by about 2 s, enqueue gave up after \${waited} s\`);
}

export async function check_fail_loud(ctx) {
  const m = bus(ctx);
  ctx.kafka.failNext('notifications');
  const failed = await thrown(m.enqueue(notification('n1', 'u42')));
  assert(failed !== null, 'a delivery error must throw BusUnavailable, enqueue returned normally');
  assert(failed instanceof m.BusUnavailable, \`a delivery error must throw BusUnavailable, got \${failed}\`);
  assert.deepEqual(ctx.kafka.records('notifications'), [], 'the failed record must not be in the topic');
  await m.enqueue(notification('n2', 'u42'));
  assert.equal(ctx.kafka.records('notifications').length, 1, 'after the failure a new enqueue must work');
  ctx.kafka.stall('notifications'); // no acknowledgement arrives before the timeout
  const timedOut = await thrown(m.enqueue(notification('n3', 'u42')));
  assert(timedOut !== null, 'no acknowledgement within the timeout must throw BusUnavailable, enqueue returned normally');
  assert(timedOut instanceof m.BusUnavailable, \`no acknowledgement within the timeout must throw BusUnavailable, got \${timedOut}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"leetbuild/harness"
)

// busEnqueue enqueues a notification the way the API does.
func busEnqueue(id, userID, priority string) error {
	return enqueue(context.Background(), Notification{ID: id, UserID: userID, Channel: "push", Title: "Shipped", Body: "On its way", Priority: priority})
}

func busHeader(r harness.KafkaRecord, name string) any {
	if v, ok := r.Header(name); ok {
		return string(v)
	}
	return nil
}

func busHeaderKeys(r harness.KafkaRecord) []string {
	var keys []string
	for _, h := range r.Headers {
		keys = append(keys, h.Key)
	}
	return keys
}

// busIDs are the ids of the records on notifications; copies of one record (same key and value) count once.
func busIDs(ctx *harness.Ctx) []string {
	seen := map[[2]string]bool{}
	var ids []string
	for _, r := range ctx.Kafka.Records("notifications") {
		copyOf := [2]string{string(r.Key), string(r.Value)}
		if seen[copyOf] {
			continue
		}
		seen[copyOf] = true
		var n struct{ ID string }
		ctx.NoError(json.Unmarshal(r.Value, &n), "a record on notifications is not a notification as JSON: %q", r.Value)
		ids = append(ids, n.ID)
	}
	return ids
}

func CheckDurableProducer(ctx *harness.Ctx) {
	ctx.NoError(busEnqueue("n1", "u42", "normal"), "enqueue(n1) returned an error")
	ctx.Kafka.Failover("notifications")
	ctx.Equal(len(busIDs(ctx)), 1, "enqueue returned (the API answered 202), then the partition leader failed and notifications lost the record: it had been acknowledged by the leader alone. The writer must wait for every in-sync replica (RequiredAcks: kafka.RequireAll)")
	ctx.Kafka.LoseAcks("notifications", 1)
	ctx.NoError(busEnqueue("n2", "u42", "normal"), "enqueue(n2) returned an error")
	// kafka-go has no idempotent producer (the step's Go detail): at least once, identical copies.
	ctx.Equal(busIDs(ctx), []string{"n1", "n2"}, "the acknowledgement of n2 was lost and the writer retried: notifications must hold n1 and n2, every copy identical to the original")
}

func CheckKeyed(ctx *harness.Ctx) {
	ctx.NoError(busEnqueue("n1", "u42", "normal"), "enqueue(n1) returned an error")
	ctx.NoError(busEnqueue("n2", "u42", "normal"), "enqueue(n2) returned an error")
	ctx.NoError(busEnqueue("n3", "u7", "normal"), "enqueue(n3) returned an error")
	produced := ctx.Kafka.Records("notifications")
	ctx.Equal(len(produced), 3, "records on notifications")
	ctx.Equal(ctx.Kafka.Keys("notifications"), []string{"u42", "u42", "u7"}, "records must be keyed by the user id")
	ctx.Equal(produced[0].Partition, produced[1].Partition, "one user's notifications must share a partition")
	var first struct{ ID string }
	ctx.NoError(json.Unmarshal(produced[0].Value, &first), "the value must be the notification as JSON, got %q", produced[0].Value)
	ctx.Equal(first.ID, "n1", "the value must be the notification as JSON (%s): its id", produced[0].Value)
}

func CheckPriorityHeader(ctx *harness.Ctx) {
	ctx.NoError(busEnqueue("n1", "u42", "high"), "enqueue(n1) returned an error")
	ctx.NoError(busEnqueue("n2", "u42", "normal"), "enqueue(n2) returned an error")
	produced := ctx.Kafka.Records("notifications")
	ctx.Equal(len(produced), 2, "records on notifications")
	ctx.Equal(busHeader(produced[0], "priority"), "high", "the first record must carry a priority=high header, headers were %v", busHeaderKeys(produced[0]))
	ctx.Equal(busHeader(produced[1], "priority"), "normal", "the second record must carry a priority=normal header, headers were %v", busHeaderKeys(produced[1]))
}

func CheckWaitAck(ctx *harness.Ctx) {
	ctx.NoError(busEnqueue("n1", "u42", "normal"), "enqueue(n1) returned an error")
	ctx.Equal(len(ctx.Kafka.Records("notifications")), 1, "the record must be in Kafka when enqueue returns: records on notifications")
	ctx.Kafka.StallFor("notifications", 1) // the broker is slow but answers within the timeout
	ctx.NoError(busEnqueue("n2", "u42", "normal"), "the broker acknowledged after 1 s, within the 2 s wait, yet enqueue returned an error")
	ctx.Equal(len(ctx.Kafka.Records("notifications")), 2, "the record must be in Kafka when enqueue returns: records on notifications")
	ctx.Kafka.Stall("notifications") // the broker is down for good
	started := ctx.Clock.Now()
	down := busEnqueue("n3", "u42", "normal")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(down != nil, "the broker never acknowledged, yet enqueue returned nil: the 202 was promised before the record was in Kafka")
	ctx.Assert(1 <= waited && waited <= 2.5, "the acknowledgement wait must be bounded by about 2 s, enqueue gave up after %v s", waited)
}

func CheckFailLoud(ctx *harness.Ctx) {
	ctx.Kafka.FailNext("notifications", 1)
	failed := busEnqueue("n1", "u42", "normal")
	ctx.Assert(failed != nil, "a delivery error must return an error wrapping ErrBusUnavailable, enqueue returned nil")
	ctx.ErrorIs(failed, ErrBusUnavailable, "a delivery error must return an error wrapping ErrBusUnavailable")
	ctx.Equal(len(ctx.Kafka.Records("notifications")), 0, "the failed record must not be in the topic: records on notifications")
	ctx.NoError(busEnqueue("n2", "u42", "normal"), "after the failure a new enqueue must work")
	ctx.Equal(len(ctx.Kafka.Records("notifications")), 1, "after the failure a new enqueue must work: records on notifications")
	ctx.Kafka.Stall("notifications") // no acknowledgement arrives before the timeout
	timedOut := busEnqueue("n3", "u42", "normal")
	ctx.Assert(timedOut != nil, "no acknowledgement within the timeout must return an error wrapping ErrBusUnavailable, enqueue returned nil")
	ctx.ErrorIs(timedOut, ErrBusUnavailable, "no acknowledgement within the timeout must return an error wrapping ErrBusUnavailable")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <string>
#include <vector>

namespace {

// How enqueue ended: "" when it returned, else what it threw.
struct BusResult {
  bool bus_unavailable = false;
  std::string error;
  bool failed() const { return !error.empty(); }
};

// Enqueues a notification the way the API does.
BusResult busEnqueue(const std::string& id, const std::string& user_id, const std::string& priority) {
  try {
    enqueue(Notification{id, user_id, "push", "Shipped", "On its way", priority});
    return {};
  } catch (const BusUnavailable& e) {
    return {true, std::string("BusUnavailable: ") + e.what()};
  } catch (const std::exception& e) {
    return {false, harness::CurrentExceptionType() + ": " + e.what()};
  }
}

void mustEnqueue(harness::Ctx& ctx, const std::string& id, const std::string& user_id, const std::string& priority,
                 const std::string& what) {
  const BusResult r = busEnqueue(id, user_id, priority);
  ctx.Assert(!r.failed(), "%s: enqueue threw %s", what, r.error);
}

std::vector<std::string> busHeaderKeys(const harness::KafkaRecord& r) {
  std::vector<std::string> keys;
  for (const auto& h : r.Headers) keys.push_back(h.Key);
  return keys;
}

// The ids of the records on notifications, every copy.
std::vector<std::string> busIDs(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& v : ctx.Kafka.Values("notifications")) {
    const auto n = harness::ParseJSON(v);
    ctx.Assert(n && n->IsObject(), "a record on notifications is not a notification as JSON: %q", v);
    ids.push_back((*n)["id"].String());
  }
  return ids;
}

}  // namespace

void CheckDurableProducer(harness::Ctx& ctx) {
  mustEnqueue(ctx, "n1", "u42", "normal", "enqueue(n1)");
  ctx.Kafka.Failover("notifications");
  ctx.Equal(busIDs(ctx).size(), 1,
            "enqueue returned (the API answered 202), then the partition leader failed and notifications lost the "
            "record: it had been acknowledged by the leader alone. The producer must wait for every in-sync replica "
            "(acks=all)");
  ctx.Kafka.LoseAcks("notifications", 1);
  mustEnqueue(ctx, "n2", "u42", "normal", "enqueue(n2)");
  // librdkafka has an idempotent producer (kafka-go, the Go harness's client, does not): the retry
  // after a lost acknowledgement must not write a second copy, as the TypeScript check demands.
  ctx.Equal(busIDs(ctx), {"n1", "n2"},
            "the acknowledgement of n2 was lost and the producer retried: notifications must hold n1 and n2 once "
            "each — enable the idempotent producer (enable.idempotence=true)");
}

void CheckKeyed(harness::Ctx& ctx) {
  mustEnqueue(ctx, "n1", "u42", "normal", "enqueue(n1)");
  mustEnqueue(ctx, "n2", "u42", "normal", "enqueue(n2)");
  mustEnqueue(ctx, "n3", "u7", "normal", "enqueue(n3)");
  const auto produced = ctx.Kafka.Records("notifications");
  ctx.Equal(produced.size(), 3, "records on notifications");
  ctx.Equal(ctx.Kafka.Keys("notifications"), {"u42", "u42", "u7"}, "records must be keyed by the user id");
  ctx.Equal(produced[0].Partition, produced[1].Partition, "one user's notifications must share a partition");
  const auto first = harness::ParseJSON(produced[0].Value.value_or(""));
  ctx.Assert(first && first->IsObject(), "the value must be the notification as JSON, got %q", produced[0].Value);
  ctx.Equal((*first)["id"], "n1", "the value must be the notification as JSON (%s): its id", produced[0].Value);
}

void CheckPriorityHeader(harness::Ctx& ctx) {
  mustEnqueue(ctx, "n1", "u42", "high", "enqueue(n1)");
  mustEnqueue(ctx, "n2", "u42", "normal", "enqueue(n2)");
  const auto produced = ctx.Kafka.Records("notifications");
  ctx.Equal(produced.size(), 2, "records on notifications");
  ctx.Equal(produced[0].Header("priority"), "high", "the first record must carry a priority=high header, headers were %v",
            busHeaderKeys(produced[0]));
  ctx.Equal(produced[1].Header("priority"), "normal",
            "the second record must carry a priority=normal header, headers were %v", busHeaderKeys(produced[1]));
}

void CheckWaitAck(harness::Ctx& ctx) {
  mustEnqueue(ctx, "n1", "u42", "normal", "enqueue(n1)");
  ctx.Equal(ctx.Kafka.Records("notifications").size(), 1,
            "the record must be in Kafka when enqueue returns: records on notifications");
  ctx.Kafka.StallFor("notifications", 1);  // the broker is slow but answers within the timeout
  mustEnqueue(ctx, "n2", "u42", "normal", "the broker acknowledged after 1 s, within the 2 s wait, yet enqueue(n2) failed");
  ctx.Equal(ctx.Kafka.Records("notifications").size(), 2,
            "the record must be in Kafka when enqueue returns: records on notifications");
  ctx.Kafka.Stall("notifications");  // the broker is down for good
  const int64_t started = ctx.Clock.Now();
  const BusResult down = busEnqueue("n3", "u42", "normal");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(down.failed(),
             "the broker never acknowledged, yet enqueue returned normally: the 202 was promised before the record was "
             "in Kafka");
  ctx.Assert(1 <= waited && waited <= 2.5, "the acknowledgement wait must be bounded by about 2 s, enqueue gave up after %v s",
             waited);
}

void CheckFailLoud(harness::Ctx& ctx) {
  ctx.Kafka.FailNext("notifications", 1);
  const BusResult failed = busEnqueue("n1", "u42", "normal");
  ctx.Assert(failed.failed(), "a delivery error must throw BusUnavailable, enqueue returned normally");
  ctx.Assert(failed.bus_unavailable, "a delivery error must throw BusUnavailable, enqueue threw %s", failed.error);
  ctx.Equal(ctx.Kafka.Records("notifications").size(), 0,
            "the failed record must not be in the topic: records on notifications");
  mustEnqueue(ctx, "n2", "u42", "normal", "after the failure a new enqueue must work");
  ctx.Equal(ctx.Kafka.Records("notifications").size(), 1,
            "after the failure a new enqueue must work: records on notifications");
  ctx.Kafka.Stall("notifications");  // no acknowledgement arrives before the timeout
  const BusResult timedOut = busEnqueue("n3", "u42", "normal");
  ctx.Assert(timedOut.failed(),
             "no acknowledgement within the timeout must throw BusUnavailable, enqueue returned normally");
  ctx.Assert(timedOut.bus_unavailable, "no acknowledgement within the timeout must throw BusUnavailable, enqueue threw %s",
             timedOut.error);
}
`,
  },
  debrief: `Same key → same partition → same order is the only ordering Kafka gives you, and keying by user is exactly the order a user notices. \`acks=all\` plus the idempotent producer make the acknowledged record durable *and* unique across the client's own retries; waiting for that ack is what gives the 202 its meaning. Real producers keep one future per record instead of flushing the whole buffer (so one slow partition does not stall unrelated requests), and set \`delivery.timeout.ms\` so the client's retries and the caller's deadline agree.`,
};
