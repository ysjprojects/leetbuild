import type {Step} from '@/lib/types';

export const orderIntakeStep: Step = {
  id: 'order-intake',
  title: 'Durable order intake: the 202 is a promise',
  concept: 'kafka',
  file: 'order_intake',
  focus: ['checkout', 'kafka'],
  task: `## Task

The 202 from \`/checkout\` is a promise: the order *will* be fulfilled or explicitly failed. Implement
\`enqueue_order(order)\` so that promise is backed by a durable record on the **\`orders\`** topic before
the API answers:

- Key the record by **sku**: every order for one product lands on one partition, in arrival order,
  which is what lets a single consumer allocate a SKU without racing itself.
- Producer config: \`acks=all\` (the leader *and* every in-sync replica have the record) and the
  **idempotent producer** where the client supports it, so a retried send cannot duplicate the order
  (kafka-go has no idempotent mode; its record carries the order id so downstream can dedupe).
- Unlike the analytics event of the image cache, this send **blocks until acknowledged**, with a
  **2 s** timeout — and bounds the delivery timeout to the same 2 s so a record cannot arrive *after*
  the API already gave up on it.
- Timeout or error → raise/return \`OrderNotAcknowledged\` so the API releases the hold and answers
  503. Never swallow it: a silently dropped order is a customer who paid attention for nothing.

:::widget kafka-partitions {"partitions": 8}

> Waiting for the ack costs a few milliseconds per checkout. That is the price of "202 means we have
> it"; the request path already did the expensive part (the reservation), and eight partitions keep
> the broker side parallel.`,
  sequence: {
    participants: ['checkout', 'Producer', 'Kafka'],
    messages: [
      {from: 'checkout', to: 'Producer', label: 'produce(orders, key=shoe-42, order json)', kind: 'sync'},
      {from: 'Producer', to: 'Kafka', label: 'partition hash(shoe-42) % 8 · acks=all', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (every in-sync replica)', kind: 'reply'},
      {from: 'Producer', to: 'checkout', label: 'delivered · offset 88231', kind: 'reply'},
      {from: 'checkout', to: 'checkout', label: '202 reserved', kind: 'sync'},
      {from: 'checkout', to: 'Producer', label: 'produce(orders, key=shoe-42, o2) · broker slow', kind: 'sync'},
      {from: 'Producer', to: 'checkout', label: 'OrderNotAcknowledged after 2 s → release, 503', kind: 'reply'},
    ],
  },
  hints: [
    'The producer config is half the work: `acks=all`, idempotence on, and a delivery timeout equal to your wait. Then the send itself must block: flush with a timeout, `.get(timeout)` on the future, or a context with a deadline.',
    'The key is the SKU string, the value the JSON of the whole order. Do not derive the key from the order id — that would spread one product over every partition and reintroduce the race the consumer relies on you to avoid.',
    'A blocking send has three outcomes: acknowledged, failed, timed out. Only the first returns normally; turn the other two into `OrderNotAcknowledged` with the order id in the message.',
  ],
  checks: [
    {
      id: 'topic-keyed',
      title: 'Produces to orders keyed by SKU',
      detail:
        'The record goes to the `orders` topic with the SKU as its key so all orders for one product share a partition and an order.',
      match: {
        python: {all: [/producer\.produce\(\s*(topic\s*=\s*)?TOPIC\s*,[\s\S]{0,300}?key\s*=\s*order\[["']sku["']\]/]},
        go: {all: [/Balancer:\s*&kafka\.Hash\{\}/, /Key:\s*\[\]byte\(\s*order\.SKU\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*order\.sku\s*,/]},
        cpp: {
          all: [/produce\(\s*kTopic[\s\S]{0,400}?order\.sku\.(c_str|data)\(\)\s*,\s*order\.sku\.(size|length)\(\)/],
        },
      },
    },
    {
      id: 'durable-producer',
      title: 'acks=all and an idempotent producer',
      detail:
        'The record must be replicated before it counts as sent, and a producer retry must not duplicate it (kafka-go: `RequireAll` and bounded `MaxAttempts`; the consumer dedupes by order id).',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/, /"enable\.idempotence"\s*:\s*(True|"true")/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /MaxAttempts:\s*\d+/]},
        scala: {
          all: [
            /"acks"\s*,\s*"all"|ACKS_CONFIG\s*,\s*"all"/,
            /"enable\.idempotence"\s*,\s*"true"|ENABLE_IDEMPOTENCE_CONFIG\s*,\s*"true"/,
          ],
        },
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
      },
    },
    {
      id: 'awaits-ack',
      title: 'Blocks until the broker acknowledges, at most 2 s',
      detail:
        'The request path waits for the acknowledgement with a bounded timeout — fire-and-forget would turn the 202 into a guess.',
      match: {
        python: {
          all: [/producer\.flush\(\s*(?:timeout\s*=\s*)?ACK_TIMEOUT_S\s*\)/],
          order: [/producer\.produce\(/, /producer\.flush\(/],
        },
        go: {
          all: [/context\.WithTimeout\(\s*ctx\s*,\s*ackTimeout\s*\)/, /writer\.WriteMessages\(/],
          none: [/Async:\s*true/],
        },
        scala: {
          all: [/producer\.send\([\s\S]{0,200}?\)\.get\(\s*AckTimeoutMillis\s*,\s*TimeUnit\.MILLISECONDS\s*\)/],
        },
        cpp: {
          all: [/producer->flush\(\s*kAckTimeoutMs\s*\)/, /delivery\.err\s*!=\s*RdKafka::ERR_NO_ERROR/],
          order: [/producer->produce\(/, /producer->flush\(/],
        },
      },
    },
    {
      id: 'fails-loud',
      title: 'Surfaces a missing acknowledgement as OrderNotAcknowledged',
      detail:
        'A timeout or a delivery error must reach the API as `OrderNotAcknowledged` so it can release the hold and answer 503; logging it is not enough.',
      match: {
        python: {all: [/def enqueue_order(?:(?!\ndef )[\s\S])*?raise OrderNotAcknowledged\(/]},
        go: {all: [/func enqueueOrder(?:(?!\n\})[\s\S])*?errNotAcknowledged/]},
        scala: {all: [/def enqueueOrder(?:(?!\n {2}def )[\s\S])*?throw new OrderNotAcknowledged\(/]},
        cpp: {all: [/void enqueue_order(?:(?!\n\})[\s\S])*?throw OrderNotAcknowledged\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaError, Producer

TOPIC = "orders"
ACK_TIMEOUT_S = 2.0


class OrderNotAcknowledged(RuntimeError):
    """The broker did not confirm the order in time; the caller must release the hold."""


producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        # TODO: acks=all, enable.idempotence, delivery.timeout.ms = 2000
    }
)


def enqueue_order(order: dict) -> None:
    """Blocks until the order record is acknowledged; raises OrderNotAcknowledged otherwise."""
    value = json.dumps(order)
    # TODO: produce to TOPIC keyed by order["sku"] with a delivery callback that records the error
    # TODO: flush with ACK_TIMEOUT_S; anything still queued or a delivery error → OrderNotAcknowledged
    _ = value, KafkaError
`,
      solution: `import json

from confluent_kafka import KafkaError, Producer

TOPIC = "orders"
ACK_TIMEOUT_S = 2.0


class OrderNotAcknowledged(RuntimeError):
    """The broker did not confirm the order in time; the caller must release the hold."""


producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
        "delivery.timeout.ms": int(ACK_TIMEOUT_S * 1000),
    }
)


def enqueue_order(order: dict) -> None:
    """Blocks until the order record is acknowledged; raises OrderNotAcknowledged otherwise."""
    value = json.dumps(order)
    failures: list[KafkaError] = []

    def on_delivery(err: KafkaError | None, _msg) -> None:
        if err is not None:
            failures.append(err)

    producer.produce(TOPIC, key=order["sku"], value=value, on_delivery=on_delivery)
    remaining = producer.flush(timeout=ACK_TIMEOUT_S)
    if remaining or failures:
        reason = str(failures[0]) if failures else f"no ack within {ACK_TIMEOUT_S}s"
        raise OrderNotAcknowledged(f"order {order['order_id']}: {reason}")
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic      = "orders"
	ackTimeout = 2 * time.Second
)

var errNotAcknowledged = errors.New("order not acknowledged")

type Order struct {
	OrderID string \`json:"order_id"\`
	SKU     string \`json:"sku"\`
	Qty     int    \`json:"qty"\`
	User    string \`json:"user"\`
}

var writer = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: topic,
	// TODO: Hash balancer (key → partition), RequireAll, bounded MaxAttempts, WriteTimeout = ackTimeout,
	// a short BatchTimeout (a sync write waits for its batch; the default lingers 1 s)
}

// enqueueOrder blocks until the order record is acknowledged; it wraps errNotAcknowledged otherwise.
func enqueueOrder(ctx context.Context, order Order) error {
	value, err := json.Marshal(order)
	if err != nil {
		return err
	}
	// TODO: WriteMessages keyed by order.SKU under a context that expires after ackTimeout
	// TODO: any error → fmt.Errorf("%w: …", errNotAcknowledged, …)
	_ = value
	return nil
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
	topic      = "orders"
	ackTimeout = 2 * time.Second
)

var errNotAcknowledged = errors.New("order not acknowledged")

type Order struct {
	OrderID string \`json:"order_id"\`
	SKU     string \`json:"sku"\`
	Qty     int    \`json:"qty"\`
	User    string \`json:"user"\`
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	MaxAttempts:  3,
	WriteTimeout: ackTimeout,
	BatchTimeout: 10 * time.Millisecond, // a sync write waits for its batch; the default lingers 1 s
}

// enqueueOrder blocks until the order record is acknowledged; it wraps errNotAcknowledged otherwise.
func enqueueOrder(ctx context.Context, order Order) error {
	value, err := json.Marshal(order)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(order.SKU), Value: value}); err != nil {
		return fmt.Errorf("%w: %s: %v", errNotAcknowledged, order.OrderID, err)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class Order(orderId: String, sku: String, qty: Int, user: String)

/** The broker did not confirm the order in time; the caller must release the hold. */
final class OrderNotAcknowledged(orderId: String, cause: Throwable)
    extends RuntimeException(s"order $orderId not acknowledged", cause)

object OrderIntake {
  val Topic = "orders"
  val AckTimeoutMillis = 2000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // TODO: acks=all, enable.idempotence, request.timeout.ms 1500 and delivery.timeout.ms = AckTimeoutMillis
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def toJson(o: Order): String =
    s"""{"order_id":"\${o.orderId}","sku":"\${o.sku}","qty":\${o.qty},"user":"\${o.user}"}"""

  /** Blocks until the order record is acknowledged; throws OrderNotAcknowledged otherwise. */
  def enqueueOrder(order: Order): Unit = {
    // TODO: send a record keyed by order.sku and block on the future for AckTimeoutMillis
    // TODO: timeout or failure → throw new OrderNotAcknowledged(order.orderId, e)
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class Order(orderId: String, sku: String, qty: Int, user: String)

/** The broker did not confirm the order in time; the caller must release the hold. */
final class OrderNotAcknowledged(orderId: String, cause: Throwable)
    extends RuntimeException(s"order $orderId not acknowledged", cause)

object OrderIntake {
  val Topic = "orders"
  val AckTimeoutMillis = 2000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  props.put("request.timeout.ms", "1500")
  props.put("delivery.timeout.ms", AckTimeoutMillis.toString)
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def toJson(o: Order): String =
    s"""{"order_id":"\${o.orderId}","sku":"\${o.sku}","qty":\${o.qty},"user":"\${o.user}"}"""

  /** Blocks until the order record is acknowledged; throws OrderNotAcknowledged otherwise. */
  def enqueueOrder(order: Order): Unit = {
    val record = new ProducerRecord[String, String](Topic, order.sku, toJson(order))
    try producer.send(record).get(AckTimeoutMillis, TimeUnit.MILLISECONDS)
    catch {
      case e: Exception => throw new OrderNotAcknowledged(order.orderId, e)
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

const std::string kTopic = "orders";
constexpr int kAckTimeoutMs = 2000;

struct Order {
  std::string order_id, sku, user;
  int qty;
};

// The broker did not confirm the order in time; the caller must release the hold.
struct OrderNotAcknowledged : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Per-record outcome, handed to produce() as the opaque pointer and filled by the delivery report.
struct Delivery {
  RdKafka::ErrorCode err = RdKafka::ERR__TIMED_OUT;
};

class RecordDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    static_cast<Delivery*>(message.msg_opaque())->err = message.err();
  }
};

RecordDelivery delivery_cb;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &delivery_cb, err);
  // TODO: acks=all, enable.idempotence, delivery.timeout.ms = kAckTimeoutMs
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string to_json(const Order& o) {
  return "{\\"order_id\\":\\"" + o.order_id + "\\",\\"sku\\":\\"" + o.sku + "\\",\\"qty\\":" + std::to_string(o.qty) +
         ",\\"user\\":\\"" + o.user + "\\"}";
}

// Blocks until the order record is acknowledged; throws OrderNotAcknowledged otherwise.
void enqueue_order(const Order& order) {
  std::string value = to_json(order);
  Delivery delivery;
  // TODO: produce to kTopic keyed by order.sku (RK_MSG_COPY) with &delivery as the opaque
  // TODO: flush for kAckTimeoutMs; if delivery.err is still set, purge the record and throw
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <stdexcept>
#include <string>

const std::string kTopic = "orders";
constexpr int kAckTimeoutMs = 2000;

struct Order {
  std::string order_id, sku, user;
  int qty;
};

// The broker did not confirm the order in time; the caller must release the hold.
struct OrderNotAcknowledged : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Per-record outcome, handed to produce() as the opaque pointer and filled by the delivery report.
struct Delivery {
  RdKafka::ErrorCode err = RdKafka::ERR__TIMED_OUT;
};

class RecordDelivery : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    static_cast<Delivery*>(message.msg_opaque())->err = message.err();
  }
};

RecordDelivery delivery_cb;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &delivery_cb, err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("delivery.timeout.ms", std::to_string(kAckTimeoutMs), err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string to_json(const Order& o) {
  return "{\\"order_id\\":\\"" + o.order_id + "\\",\\"sku\\":\\"" + o.sku + "\\",\\"qty\\":" + std::to_string(o.qty) +
         ",\\"user\\":\\"" + o.user + "\\"}";
}

// Blocks until the order record is acknowledged; throws OrderNotAcknowledged otherwise.
void enqueue_order(const Order& order) {
  std::string value = to_json(order);
  Delivery delivery;
  const RdKafka::ErrorCode queued =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, value.data(),
                        value.size(), order.sku.c_str(), order.sku.size(), 0, &delivery);
  if (queued != RdKafka::ERR_NO_ERROR)
    throw OrderNotAcknowledged("order " + order.order_id + ": " + RdKafka::err2str(queued));
  producer->flush(kAckTimeoutMs);
  if (delivery.err != RdKafka::ERR_NO_ERROR) {
    // Still in flight: drop it so it cannot be delivered after the API has given up, then serve the report.
    producer->purge(RdKafka::Producer::PURGE_QUEUE | RdKafka::Producer::PURGE_INFLIGHT);
    producer->poll(0);
    throw OrderNotAcknowledged("order " + order.order_id + ": " + RdKafka::err2str(delivery.err));
  }
}
`,
    },
  },
  harness: {
    python: `import json

ORDER = {"order_id": "o1", "sku": "shoe-42", "qty": 2, "user": "ada"}


def _intake(ctx):
    m = ctx.load("order_intake")
    flushes = []
    original = m.producer.flush

    def flush(*args, **kwargs):
        timeout = kwargs.get("timeout", args[0] if args else None)
        flushes.append(timeout)
        return original(*args, **kwargs)

    m.producer.flush = flush
    return m, flushes


def check_topic_keyed(ctx):
    m, _ = _intake(ctx)
    m.enqueue_order(ORDER)
    produced = ctx.kafka.records("orders")
    assert len(produced) == 1, f"expected one record on the orders topic, found {len(produced)}"
    assert produced[0].key == b"shoe-42", f"the record key is {produced[0].key!r}, expected the sku b'shoe-42'"
    assert json.loads(produced[0].value) == ORDER, f"the record value is {produced[0].value!r}, expected the JSON of the order"
    m.enqueue_order(dict(ORDER, order_id="o2", user="grace"))
    m.enqueue_order(dict(ORDER, order_id="o3", sku="hat-7"))
    produced = ctx.kafka.records("orders")
    assert [r.key for r in produced] == [b"shoe-42", b"shoe-42", b"hat-7"], f"records must be keyed by sku, got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "two orders for one sku must land on the same partition"


def check_durable_producer(ctx):
    m, _ = _intake(ctx)
    conf = m.producer.conf
    acks = str(conf.get("acks", "")).lower()
    assert acks in ("all", "-1"), f"acks is {conf.get('acks')!r}, expected all: the record must be replicated before it counts as sent"
    idempotent = conf.get("enable.idempotence")
    assert idempotent is True or str(idempotent).lower() == "true", f"enable.idempotence is {idempotent!r}, expected True so a retried send cannot duplicate the order"
    m.enqueue_order(ORDER)
    assert len(ctx.kafka.records("orders")) == 1, "the order must reach the orders topic"


def check_awaits_ack(ctx):
    m, flushes = _intake(ctx)
    m.enqueue_order(ORDER)
    assert ctx.kafka.flushes >= 1, "enqueue_order returned without flushing: the 202 would be a guess, not a fact"
    assert flushes, "enqueue_order must flush the producer and wait for the acknowledgement"
    timeout = flushes[0]
    assert timeout is not None, "flush() was called without a timeout: a slow broker would block the request forever"
    assert 0 < float(timeout) <= 2.0, f"the ack wait is {timeout} s, expected at most 2 s"
    delivery = m.producer.conf.get("delivery.timeout.ms")
    assert delivery is not None, "delivery.timeout.ms is unset: a record could still arrive after the API gave up on it"
    assert 0 < int(delivery) <= 2000, f"delivery.timeout.ms is {delivery}, expected at most 2000 (the same 2 s as the ack wait)"


def check_fails_loud(ctx):
    m, _ = _intake(ctx)
    assert issubclass(m.OrderNotAcknowledged, RuntimeError), "OrderNotAcknowledged must stay a RuntimeError so the API's except clause catches it"
    ctx.kafka.fail_next("orders")
    try:
        m.enqueue_order(ORDER)
        raise AssertionError("the broker reported a delivery error but enqueue_order returned normally; it must raise OrderNotAcknowledged")
    except m.OrderNotAcknowledged as e:
        assert "o1" in str(e), f"the error should name the order: {e!r}"
    assert ctx.kafka.records("orders") == [], "a failed delivery must not leave a record on the topic"
    m.enqueue_order(dict(ORDER, order_id="o2"))
    assert len(ctx.kafka.records("orders")) == 1, "after the failure the next order must be acknowledged normally"
`,
  },
  debrief: `Two knobs decide what an acknowledged write means: \`acks=all\` makes it "replicated", idempotence makes it "exactly one copy per send". Blocking on that ack is what turns the API's 202 from a hope into a fact, and bounding both the wait and the delivery timeout keeps the two sides of the promise consistent — a record can never sneak in after the hold was released. Real intakes go one step further with the transactional outbox: the order and its event are written in one database transaction and a relay publishes them, so even a crash between "reserved" and "produced" cannot lose an order.`,
};
