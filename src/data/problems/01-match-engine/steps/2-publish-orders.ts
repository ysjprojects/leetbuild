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
        typescript: {
          all: [/producer\.send\(\s*\{[^}]*topic:\s*TOPIC[\s\S]{0,300}?key:\s*order\.symbol/],
          none: [/key:\s*order\.order_id/],
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
        typescript: {all: [/acks:\s*(-1|['"]all['"])/]},
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
        typescript: {all: [/idempotent:\s*true/]},
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
        typescript: {
          all: [/await producer\.send\(/, /timeout:\s*(ACK_TIMEOUT_S\s*\*\s*1000|ACK_TIMEOUT_MS|2000)\b/],
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
        typescript: {all: [/throw new PublishFailed\(/]},
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
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Order, PublishFailed} from './order_gateway';

export const TOPIC = 'orders';
export const ACK_TIMEOUT_S = 2.0;

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
// TODO: an idempotent producer (requires acks all): an accepted order is never lost or duplicated
export const producer = kafka.producer();
let connected: Promise<void> | null = null;

export async function publishOrder(order: Order): Promise<void> {
  connected ??= producer.connect();
  await connected;
  const value = JSON.stringify(order);
  // TODO: send to TOPIC keyed by order.symbol (not order_id) with acks: -1 (all)
  // TODO: await the send, bounded by timeout: ACK_TIMEOUT_S * 1000, so the ack is in before we return
  // TODO: throw PublishFailed when the broker reports an error or never answers in time
  void value;
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Order, PublishFailed} from './order_gateway';

export const TOPIC = 'orders';
export const ACK_TIMEOUT_S = 2.0;

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true});
let connected: Promise<void> | null = null;

export async function publishOrder(order: Order): Promise<void> {
  connected ??= producer.connect();
  await connected;
  const value = JSON.stringify(order);
  try {
    // Resolves only once every in-sync replica acknowledged the record, or rejects at the timeout.
    await producer.send({
      topic: TOPIC,
      acks: -1,
      timeout: ACK_TIMEOUT_S * 1000,
      messages: [{key: order.symbol, value}],
    });
  } catch (e) {
    throw new PublishFailed(\`order \${order.order_id}: \${e instanceof Error ? e.message : String(e)}\`);
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
  harness: {
    python: `import json


def _publisher(ctx):
    m = ctx.load("order_publisher")
    flushes = []  # the timeout each flush() was called with
    real_flush = m.producer.flush

    def flush(*args, **kwargs):
        flushes.append(args[0] if args else kwargs.get("timeout"))
        return real_flush(*args, **kwargs)

    m.producer.flush = flush
    return m, flushes


def _order(m, order_id="o-1", symbol="ACME"):
    return m.Order(order_id, symbol, "BUY", 10.05, 100, "c-1")


def check_keyed_by_symbol(ctx):
    m, _ = _publisher(ctx)
    m.publish_order(_order(m, "o-1", "ACME"))
    m.publish_order(_order(m, "o-2", "ACME"))
    m.publish_order(_order(m, "o-3", "BETA"))
    produced = ctx.kafka.records("orders")
    assert len(produced) == 3, f"expected three records on orders, found {len(produced)}"
    assert [r.key for r in produced] == [b"ACME", b"ACME", b"BETA"], f"records must be keyed by the symbol, got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "two ACME orders must land on the same partition"
    value = json.loads(produced[0].value)
    assert value.get("order_id") == "o-1" and value.get("symbol") == "ACME" and value.get("qty") == 100, f"the value must be the JSON of the order, got {value}"


def check_acks_all(ctx):
    m, _ = _publisher(ctx)
    acks = str(m.producer.conf.get("acks", "")).lower()
    assert acks in ("all", "-1"), f"the producer is configured with acks={m.producer.conf.get('acks')!r}, expected all"


def check_idempotent(ctx):
    m, _ = _publisher(ctx)
    value = m.producer.conf.get("enable.idempotence")
    assert value is True or str(value).lower() == "true", f"enable.idempotence is {value!r}, expected True"


def check_waits_for_ack(ctx):
    m, flushes = _publisher(ctx)
    m.publish_order(_order(m))
    assert ctx.kafka.flushes >= 1, "publish_order returned without waiting for the delivery report (no flush)"
    assert flushes and flushes[0] is not None, "the wait for the acknowledgement must be bounded: flush with a timeout"
    assert 0 < float(flushes[0]) <= m.ACK_TIMEOUT_S, f"the flush timeout must be ACK_TIMEOUT_S ({m.ACK_TIMEOUT_S}s), got {flushes[0]}"


def check_raises(ctx):
    m, _ = _publisher(ctx)
    ctx.kafka.fail_next("orders")
    try:
        m.publish_order(_order(m))
        raise AssertionError("a delivery error must raise PublishFailed, publish_order returned normally")
    except m.PublishFailed:
        pass
    assert ctx.kafka.records("orders") == [], "the failed order must not be on the topic"
    m.publish_order(_order(m, "o-2"))  # the producer is still usable afterwards
    assert len(ctx.kafka.records("orders")) == 1, "the next order must be published normally"
    # The broker never answers: flush() returns at the timeout with the report still pending.
    m.producer.flush = lambda *a, **k: 1
    try:
        m.publish_order(_order(m, "o-3"))
        raise AssertionError("a delivery report that never arrives within ACK_TIMEOUT_S must raise PublishFailed")
    except m.PublishFailed:
        pass
`,
    typescript: `function publisher(ctx) {
  const gateway = ctx.load('order_gateway');
  const m = ctx.load('order_publisher');
  return {m, PublishFailed: gateway.PublishFailed};
}

function order(orderId = 'o-1', symbol = 'ACME') {
  return {order_id: orderId, symbol, side: 'BUY', price: 10.05, qty: 100, client_order_id: 'c-1'};
}

/** publishOrder must reject with PublishFailed; returns its message. */
async function failsToPublish(ctx, m, PublishFailed, o, what: string): Promise<void> {
  let error: unknown = null;
  try {
    await m.publishOrder(o);
  } catch (e) {
    error = e;
  }
  assert(error !== null, \`\${what} must reject with PublishFailed, publishOrder resolved normally\`);
  assert(error instanceof PublishFailed, \`\${what} must reject with PublishFailed, got \${error instanceof Error ? error.constructor.name + ': ' + error.message : String(error)}\`);
}

export async function check_keyed_by_symbol(ctx) {
  const {m} = publisher(ctx);
  await m.publishOrder(order('o-1', 'ACME'));
  await m.publishOrder(order('o-2', 'ACME'));
  await m.publishOrder(order('o-3', 'BETA'));
  const produced = ctx.kafka.records('orders');
  assert.equal(produced.length, 3, \`expected three records on orders, found \${produced.length}\`);
  const keys = ctx.kafka.keys('orders');
  assert.deepEqual(keys, ['ACME', 'ACME', 'BETA'], \`records must be keyed by the symbol, got \${JSON.stringify(keys)}\`);
  assert.equal(produced[0].partition, produced[1].partition, 'two ACME orders must land on the same partition');
  const value = JSON.parse(ctx.kafka.values('orders')[0]);
  assert(value.order_id === 'o-1' && value.symbol === 'ACME' && value.qty === 100, \`the value must be the JSON of the order, got \${JSON.stringify(value)}\`);
}

export async function check_acks_all(ctx) {
  const {m} = publisher(ctx);
  await m.publishOrder(order('o-1'));
  // The partition leader fails right after it answered: a record acknowledged by the leader alone is gone.
  ctx.kafka.failover('orders');
  const held = ctx.kafka.records('orders').length;
  assert.equal(held, 1, \`publishOrder resolved (the gateway would answer 202), then the partition leader failed and orders holds \${held} record(s) instead of the order: it had been acknowledged by the leader alone. The 202 is a durability promise and needs acks=all (-1)\`);
}

export async function check_idempotent(ctx) {
  const {m} = publisher(ctx);
  // The broker writes the order but its acknowledgement is lost on the way back: the producer retries.
  ctx.kafka.loseAcks('orders');
  await m.publishOrder(order('o-1'));
  const ids = ctx.kafka.values('orders').map(v => JSON.parse(v).order_id);
  assert.deepEqual(ids, ['o-1'], \`after a lost acknowledgement the retry must not duplicate the order, but orders holds \${JSON.stringify(ids)}: enable the idempotent producer\`);
}

export async function check_waits_for_ack(ctx) {
  const {m, PublishFailed} = publisher(ctx);
  // The broker is slow but answers within ACK_TIMEOUT_S: the call waits for the ack and resolves.
  ctx.kafka.stall('orders', 0.5);
  let start = ctx.clock.now();
  await m.publishOrder(order('o-1'));
  const waited = ctx.clock.now() - start;
  assert.equal(ctx.kafka.records('orders').length, 1, 'the order must be on the topic once publishOrder resolved');
  assert(waited >= 500, \`publishOrder resolved after \${waited} ms while the broker only answered after 500 ms: it returned without waiting for the acknowledgement\`);
  // The broker never answers: the wait is bounded by ACK_TIMEOUT_S, not kafkajs's 30 s default.
  ctx.kafka.stall('orders');
  start = ctx.clock.now();
  await failsToPublish(ctx, m, PublishFailed, order('o-2'), 'an acknowledgement that never arrives');
  const gaveUp = ctx.clock.now() - start;
  const limit = m.ACK_TIMEOUT_S * 1000;
  assert(gaveUp >= limit - 1 && gaveUp <= limit + 1000, \`publishOrder gave up after \${gaveUp} ms, expected ACK_TIMEOUT_S (\${limit} ms)\`);
}

export async function check_raises(ctx) {
  const {m, PublishFailed} = publisher(ctx);
  ctx.kafka.failNext('orders');
  await failsToPublish(ctx, m, PublishFailed, order('o-1'), 'a delivery error');
  assert.deepEqual(ctx.kafka.records('orders'), [], 'the failed order must not be on the topic');
  await m.publishOrder(order('o-2')); // the producer is still usable afterwards
  assert.equal(ctx.kafka.records('orders').length, 1, 'the next order must be published normally');
  // The broker never answers: the send times out with the record still pending.
  ctx.kafka.stall('orders');
  await failsToPublish(ctx, m, PublishFailed, order('o-3'), 'an acknowledgement that never arrives within ACK_TIMEOUT_S');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"leetbuild/harness"
)

// Order is the gateway's order (order_gateway.go, step 1), which this file uses.
type Order struct {
	OrderID       string  \`json:"order_id"\`
	Symbol        string  \`json:"symbol"\`
	Side          string  \`json:"side"\`
	Price         float64 \`json:"price"\`
	Qty           int64   \`json:"qty"\`
	ClientOrderID string  \`json:"client_order_id"\`
}

func orderFor(orderID, symbol string) Order {
	return Order{OrderID: orderID, Symbol: symbol, Side: "BUY", Price: 10.05, Qty: 100, ClientOrderID: "c-1"}
}

func mustPublish(ctx *harness.Ctx, o Order) {
	ctx.NoError(publishOrder(context.Background(), o), "publishOrder(%s) returned an error", o.OrderID)
}

// failsToPublish: publishOrder must return an error (the gateway's 503).
func failsToPublish(ctx *harness.Ctx, o Order, what string) {
	err := publishOrder(context.Background(), o)
	ctx.Assert(err != nil, "%s must make publishOrder return an error, it returned nil", what)
}

func CheckKeyedBySymbol(ctx *harness.Ctx) {
	mustPublish(ctx, orderFor("o-1", "ACME"))
	mustPublish(ctx, orderFor("o-2", "ACME"))
	mustPublish(ctx, orderFor("o-3", "BETA"))
	produced := ctx.Kafka.Records("orders")
	ctx.Equal(len(produced), 3, "expected three records on orders")
	ctx.Equal(ctx.Kafka.Keys("orders"), []string{"ACME", "ACME", "BETA"}, "records must be keyed by the symbol")
	ctx.Equal(produced[0].Partition, produced[1].Partition, "two ACME orders must land on the same partition")
	var value map[string]any
	err := json.Unmarshal(produced[0].Value, &value)
	ctx.Assert(err == nil && value["order_id"] == "o-1" && value["symbol"] == "ACME" && value["qty"] == 100.0, "the value must be the JSON of the order, got %s", produced[0].Value)
}

func CheckAcksAll(ctx *harness.Ctx) {
	mustPublish(ctx, orderFor("o-1", "ACME"))
	// The partition leader fails right after it answered: a record acknowledged by the leader alone is gone.
	ctx.Kafka.Failover("orders")
	held := len(ctx.Kafka.Records("orders"))
	ctx.Equal(held, 1, "publishOrder returned (the gateway would answer 202), then the partition leader failed and orders lost the order: it had been acknowledged by the leader alone. The 202 is a durability promise and needs RequiredAcks: kafka.RequireAll; records on orders")
}

func CheckIdempotent(ctx *harness.Ctx) {
	// The broker writes the order but its acknowledgement is lost on the way back: the producer retries.
	ctx.Kafka.LoseAcks("orders", 1)
	mustPublish(ctx, orderFor("o-1", "ACME"))
	// kafka-go has no idempotent producer (the step's Go text): at least once, identical copies that
	// carry the order_id header so the engine can deduplicate them.
	records := ctx.Kafka.Records("orders")
	ctx.Assert(len(records) > 0, "after a lost acknowledgement the order must still be on orders, it holds nothing")
	first := records[0]
	for _, r := range records {
		var value map[string]any
		_ = json.Unmarshal(r.Value, &value)
		ctx.Equal(value["order_id"], "o-1", "after a lost acknowledgement orders must hold only the order o-1; order_id of a record")
		ctx.Assert(string(r.Key) == string(first.Key) && string(r.Value) == string(first.Value), "a retried write must be an identical copy of the order (key %q, value %s), got key %q, value %s", first.Key, first.Value, r.Key, r.Value)
		id, _ := r.Header("order_id")
		ctx.Equal(string(id), "o-1", "every copy must carry the order_id header so a retried write can be deduplicated")
	}
}

func CheckWaitsForAck(ctx *harness.Ctx) {
	// The broker is slow but answers within ackTimeout: the call waits for the ack and returns.
	ctx.Kafka.StallFor("orders", 0.5)
	start := ctx.Clock.Now()
	mustPublish(ctx, orderFor("o-1", "ACME"))
	waited := ctx.Clock.Now() - start
	ctx.Equal(len(ctx.Kafka.Records("orders")), 1, "the order must be on the topic once publishOrder returned")
	ctx.Assert(waited >= 500, "publishOrder returned after %d ms while the broker only answered after 500 ms: it returned without waiting for the acknowledgement", waited)
	// The broker never answers: the wait is bounded by ackTimeout, not kafka-go's 10 s default.
	ctx.Kafka.Stall("orders")
	start = ctx.Clock.Now()
	failsToPublish(ctx, orderFor("o-2", "ACME"), "an acknowledgement that never arrives")
	gaveUp := ctx.Clock.Now() - start
	limit := ackTimeout.Milliseconds()
	ctx.Assert(gaveUp >= limit-1 && gaveUp <= limit+1000, "publishOrder gave up after %d ms, expected ackTimeout (%d ms)", gaveUp, limit)
}

func CheckRaises(ctx *harness.Ctx) {
	ctx.Kafka.FailNext("orders", 1)
	failsToPublish(ctx, orderFor("o-1", "ACME"), "a delivery error")
	ctx.Equal(len(ctx.Kafka.Records("orders")), 0, "the failed order must not be on the topic; records on orders")
	mustPublish(ctx, orderFor("o-2", "ACME")) // the producer is still usable afterwards
	ctx.Equal(len(ctx.Kafka.Records("orders")), 1, "the next order must be published normally; records on orders")
	// The broker never answers: the write times out with the record still pending.
	ctx.Kafka.Stall("orders")
	failsToPublish(ctx, orderFor("o-3", "ACME"), "an acknowledgement that never arrives within ackTimeout")
}
`,
  },
  debrief: `Same producer API as an analytics event, opposite trade-off: here latency is spent to buy durability, because the 202 already left the building as a promise. \`acks=all\` moves the failure from "lost silently" to "reported", idempotence keeps the broker's own retries from turning one order into two, and the symbol key is what lets the next step keep one book per partition with no locks at all. Real exchanges skip Kafka on the hot path — a sequencer assigns a global sequence number and replicates the input log to standbys synchronously — but the shape is identical: nothing is acknowledged to the client before it is on more than one machine, and everything downstream is a deterministic function of the sequenced log.`,
};
