import type {Step} from '@/lib/types';

export const publishOrdersStep: Step = {
  id: 'publish-orders',
  title: 'Publish orders keyed by symbol, wait for the ack',
  concept: 'kafka',
  file: 'order_publisher',
  focus: ['gateway', 'orders'],
  task: `## Task

Implement \`publish_order(order)\`: one record on the **\`orders\`** topic per accepted order.

- Key the record by the **symbol**, not the order id. Every order for \`ACME\` then lands on one partition, in
  arrival order, and one engine instance owns that partition — the book for \`ACME\` has exactly one writer.
- Configure the producer with **\`acks=all\`** and as an **idempotent producer** (\`enable.idempotence\`): a broker
  retry must never duplicate an order. (kafka-go has no idempotent producer; there, put the \`order_id\` in a
  record header so the engine can deduplicate a retried write.)
- Unlike an analytics event, this call **waits for the broker's acknowledgement**, bounded by
  \`ACK_TIMEOUT_S\`: the gateway's 202 is a promise that the order is durable, so the promise must not go out
  before the ack comes back.
- Any delivery error or a timeout → raise \`PublishFailed\`; the gateway turns it into a **503**.

:::widget kafka-partitions {"partitions": 8}

> The partition key is the ordering contract of the whole system: the book only sees orders in the sequence
> Kafka stored them, and Kafka only guarantees that sequence within one partition.`,
  sequence: {
    participants: ['gateway', 'Producer', 'Kafka'],
    messages: [
      {from: 'gateway', to: 'Producer', label: 'produce(orders, key=ACME, value=json)', kind: 'sync'},
      {from: 'Producer', to: 'Kafka', label: 'partition hash(ACME) % 8 · acks=all', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (all in-sync replicas)', kind: 'reply'},
      {from: 'Producer', to: 'gateway', label: 'delivered (offset 5120)', kind: 'reply'},
      {from: 'gateway', to: 'gateway', label: 'only now: 202 to the client', kind: 'sync'},
    ],
  },
  hints: [
    'Two producer settings and one key: `acks=all`, idempotence on, and `order.symbol` as the record key. The value is just the JSON of the order.',
    'Waiting for the ack means blocking on the delivery result with a timeout: `flush(timeout)` after a delivery callback (librdkafka clients), `send(...).get(timeout)` (Java), or a synchronous `WriteMessages` under a context with a deadline (kafka-go).',
    'Distinguish the three outcomes after the wait: acknowledged → return; error reported → raise with the broker’s reason; nothing reported within the timeout → raise too. The caller cannot tell the last two apart and should not have to.',
  ],
  checks: [
    {
      id: 'keyed-by-symbol',
      title: 'Produces to orders keyed by the symbol',
      detail:
        'The record goes to `orders` with the symbol as key; keying by order id would spread one symbol over every partition and lose the sequence.',
      match: {
        python: {
          all: [/producer\.produce\(\s*(topic\s*=\s*)?TOPIC\s*,[^\n]*key\s*=\s*order\.symbol/],
          none: [/key\s*=\s*order\.order_id/],
        },
        go: {all: [/Key:\s*\[\]byte\(\s*order\.Symbol\s*\)/], none: [/Key:\s*\[\]byte\(\s*order\.OrderID\s*\)/]},
        scala: {
          all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*order\.symbol\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*order\.orderId/],
        },
        cpp: {
          all: [
            /produce\(\s*kTopic\s*,[\s\S]{0,400}?order\.symbol\.(c_str|data)\(\)\s*,\s*order\.symbol\.(size|length)\(\)/,
          ],
          none: [/order\.order_id\.(c_str|data)\(\)/],
        },
      },
    },
    {
      id: 'acks-all',
      title: 'Requires acknowledgement from all in-sync replicas',
      detail:
        'With `acks=1` a leader crash right after the ack loses the order; `acks=all` makes the 202 mean what it says.',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks"\s*,\s*"all"|ACKS_CONFIG\s*,\s*"all"/]},
        cpp: {all: [/"acks"\s*,\s*"all"/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Retries never duplicate an order',
      detail:
        'Enable the idempotent producer so a retried batch is deduplicated by the broker; kafka-go lacks it, so tag the record with the `order_id` header for downstream deduplication.',
      match: {
        python: {all: [/"enable\.idempotence"\s*:\s*True/]},
        go: {all: [/Headers:\s*\[\]kafka\.Header\{[\s\S]{0,200}?"order_id"/]},
        scala: {all: [/"enable\.idempotence"\s*,\s*"true"|ENABLE_IDEMPOTENCE_CONFIG\s*,\s*"true"/]},
        cpp: {all: [/"enable\.idempotence"\s*,\s*"true"/]},
      },
    },
    {
      id: 'waits-for-ack',
      title: 'Waits for the acknowledgement, bounded by a timeout',
      detail:
        'The call blocks until the broker acknowledges the record or `ACK_TIMEOUT_S` passes — never fire-and-forget, never unbounded.',
      match: {
        python: {
          all: [/def publish_order(?:(?!\ndef )[\s\S])*?producer\.flush\(\s*(timeout\s*=\s*)?ACK_TIMEOUT_S\s*\)/],
        },
        go: {
          all: [/context\.WithTimeout\(\s*ctx\s*,\s*ackTimeout\s*\)/, /err\s*:?=\s*writer\.WriteMessages\(/],
          none: [/Async:\s*true/],
        },
        scala: {all: [/producer\.send\([^\n]*\)\s*\.get\(\s*AckTimeoutMillis\s*,\s*(TimeUnit\.)?MILLISECONDS\s*\)/]},
        cpp: {all: [/void publish_order(?:(?!\n\})[\s\S])*?producer->flush\(\s*kAckTimeoutMs\s*\)/]},
      },
    },
    {
      id: 'raises',
      title: 'Raises PublishFailed on error or timeout',
      detail:
        'A record that was not acknowledged must surface as `PublishFailed` so the gateway answers 503 instead of a false 202.',
      match: {
        python: {all: [/raise PublishFailed\(/]},
        go: {order: [/writer\.WriteMessages\(/, /return\s+(fmt\.Errorf\([^\n]*%w|err\b)/]},
        scala: {all: [/throw new PublishFailed\(/]},
        cpp: {all: [/throw PublishFailed\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
from dataclasses import asdict

from confluent_kafka import KafkaError, Producer

from order_gateway import Order, PublishFailed

TOPIC = "orders"
ACK_TIMEOUT_S = 2.0

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "1",
        "linger.ms": 0,
        # TODO: acks=all and an idempotent producer: an accepted order is never lost or duplicated
    }
)


def publish_order(order: Order) -> None:
    value = json.dumps(asdict(order))
    # TODO: produce keyed by order.symbol (not order_id) with an on_delivery callback that records the outcome
    # TODO: flush with ACK_TIMEOUT_S so the delivery report arrives before we return
    # TODO: raise PublishFailed when the report carries a KafkaError or never arrived
    _ = KafkaError
    raise NotImplementedError
`,
      solution: `import json
from dataclasses import asdict

from confluent_kafka import KafkaError, Producer

from order_gateway import Order, PublishFailed

TOPIC = "orders"
ACK_TIMEOUT_S = 2.0

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
        "linger.ms": 0,
    }
)


def publish_order(order: Order) -> None:
    value = json.dumps(asdict(order))
    outcome: list[KafkaError | None] = []
    producer.produce(TOPIC, key=order.symbol, value=value, on_delivery=lambda err, _msg: outcome.append(err))
    producer.flush(timeout=ACK_TIMEOUT_S)  # serves the delivery report; returns early once it arrived
    if not outcome:
        raise PublishFailed(f"order {order.order_id}: no acknowledgement within {ACK_TIMEOUT_S}s")
    if outcome[0] is not None:
        raise PublishFailed(f"order {order.order_id}: {outcome[0]}")
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

// Order is declared in order_gateway.go.

const (
	topic      = "orders"
	ackTimeout = 2 * time.Second
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: time.Millisecond,
	// TODO: RequireAll — an accepted order must be on every in-sync replica before the 202 goes out
}

func publishOrder(ctx context.Context, order Order) error {
	value, _ := json.Marshal(order)
	// TODO: WriteMessages keyed by order.Symbol (not OrderID: one partition per symbol keeps its orders in sequence)
	// TODO: kafka-go has no idempotent producer: put the order id in a record header so a retried write can be deduplicated
	// TODO: bound the wait with ackTimeout; return an error ("… not acknowledged: %w", → 503) when the broker does not confirm
	_ = value
	_ = fmt.Errorf
	return errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// Order is declared in order_gateway.go.

const (
	topic      = "orders"
	ackTimeout = 2 * time.Second
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: time.Millisecond,
	MaxAttempts:  3,
}

func publishOrder(ctx context.Context, order Order) error {
	value, _ := json.Marshal(order)
	ctx, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()
	msg := kafka.Message{
		Key:     []byte(order.Symbol),
		Value:   value,
		Headers: []kafka.Header{{Key: "order_id", Value: []byte(order.OrderID)}},
	}
	// Synchronous write: returns once every in-sync replica has the record, or with the context's error.
	if err := writer.WriteMessages(ctx, msg); err != nil {
		return fmt.Errorf("order %s not acknowledged: %w", order.OrderID, err)
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
import spray.json._
import spray.json.DefaultJsonProtocol._

import OrderGateway.{Order, PublishFailed}

object OrderPublisher {
  val Topic = "orders"
  val AckTimeoutMillis = 2000L

  implicit val orderFormat: RootJsonFormat[Order] = jsonFormat6(Order)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "0")
  // TODO: acks=all and enable.idempotence: an accepted order is never lost or duplicated
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def publishOrder(order: Order): Unit = {
    val value = order.toJson.compactPrint
    // TODO: send a record keyed by order.symbol (not orderId: one partition per symbol keeps its orders in sequence)
    // TODO: block on the future with AckTimeoutMillis; ExecutionException or TimeoutException → throw PublishFailed
    val _ = (value, TimeUnit.MILLISECONDS, classOf[ExecutionException], classOf[TimeoutException])
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.{ExecutionException, TimeUnit, TimeoutException}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._
import spray.json.DefaultJsonProtocol._

import OrderGateway.{Order, PublishFailed}

object OrderPublisher {
  val Topic = "orders"
  val AckTimeoutMillis = 2000L

  implicit val orderFormat: RootJsonFormat[Order] = jsonFormat6(Order)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  props.put("linger.ms", "0")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def publishOrder(order: Order): Unit = {
    val record = new ProducerRecord[String, String](Topic, order.symbol, order.toJson.compactPrint)
    try producer.send(record).get(AckTimeoutMillis, TimeUnit.MILLISECONDS) // blocks until every in-sync replica has it
    catch {
      case e @ (_: ExecutionException | _: TimeoutException) =>
        throw new PublishFailed(s"order \${order.orderId} not acknowledged: \${e.getMessage}")
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>

#include "order_gateway.h"  // Order, PublishFailed, std::string to_json(const Order&)

const std::string kTopic = "orders";
constexpr int kAckTimeoutMs = 2000;

struct Outcome {
  RdKafka::ErrorCode err = RdKafka::ERR__TIMED_OUT;  // stays TIMED_OUT until a delivery report lands
};

// msg_opaque carries a heap copy of the shared_ptr so a late report cannot write into a dead frame.
class RecordOutcome : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* held = static_cast<std::shared_ptr<Outcome>*>(message.msg_opaque());
    (*held)->err = message.err();
    delete held;
  }
};

RecordOutcome outcomes;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "0", err);
  conf->set("dr_cb", &outcomes, err);
  // TODO: acks=all and enable.idempotence: an accepted order is never lost or duplicated
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void publish_order(const Order& order) {
  std::string value = to_json(order);
  auto outcome = std::make_shared<Outcome>();
  // TODO: produce keyed by order.symbol (not order_id) with new std::shared_ptr<Outcome>(outcome) as msg_opaque
  // TODO: flush(kAckTimeoutMs) so the delivery report lands before we return
  // TODO: throw PublishFailed unless outcome->err is ERR_NO_ERROR
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>

#include "order_gateway.h"  // Order, PublishFailed, std::string to_json(const Order&)

const std::string kTopic = "orders";
constexpr int kAckTimeoutMs = 2000;

struct Outcome {
  RdKafka::ErrorCode err = RdKafka::ERR__TIMED_OUT;  // stays TIMED_OUT until a delivery report lands
};

// msg_opaque carries a heap copy of the shared_ptr so a late report cannot write into a dead frame.
class RecordOutcome : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    auto* held = static_cast<std::shared_ptr<Outcome>*>(message.msg_opaque());
    (*held)->err = message.err();
    delete held;
  }
};

RecordOutcome outcomes;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("linger.ms", "0", err);
  conf->set("dr_cb", &outcomes, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void publish_order(const Order& order) {
  std::string value = to_json(order);
  auto outcome = std::make_shared<Outcome>();
  auto* handle = new std::shared_ptr<Outcome>(outcome);
  const auto queued = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                        value.data(), value.size(), order.symbol.c_str(), order.symbol.size(), 0, handle);
  if (queued != RdKafka::ERR_NO_ERROR) {
    delete handle;
    throw PublishFailed("order " + order.order_id + ": " + RdKafka::err2str(queued));
  }
  producer->flush(kAckTimeoutMs);  // serves dr_cb: blocks until the broker acknowledges, at most kAckTimeoutMs
  if (outcome->err != RdKafka::ERR_NO_ERROR)
    throw PublishFailed("order " + order.order_id + " not acknowledged: " + RdKafka::err2str(outcome->err));
}
`,
    },
  },
  debrief: `Same producer API as an analytics event, opposite trade-off: here latency is spent to buy durability, because the 202 already left the building as a promise. \`acks=all\` moves the failure from "lost silently" to "reported", idempotence keeps the broker's own retries from turning one order into two, and the symbol key is what lets the next step keep one book per partition with no locks at all. Real exchanges skip Kafka on the hot path — a sequencer assigns a global sequence number and replicates the input log to standbys synchronously — but the shape is identical: nothing is acknowledged to the client before it is on more than one machine, and everything downstream is a deterministic function of the sequenced log.`,
};
