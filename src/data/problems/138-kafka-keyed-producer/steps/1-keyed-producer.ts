import type {Step} from '@/lib/types';

export const keyedProducerStep: Step = {
  id: 'keyed-producer',
  title: 'Produce keyed events, flush on shutdown',
  concept: 'kafka',
  file: 'order_events',
  focus: ['orders', 'kafka'],
  task: `## Task

Implement a module that publishes order events to the **\`order-events\`** topic and shuts down cleanly:

- \`emit(order_id, event)\` — hands one record to the producer and **returns at once**. Key = the order id
  (as bytes); value = JSON \`{"order_id": …, "type": …, "ts": …}\`: the order id, the event's \`type\`,
  and \`ts\`, the current time in seconds. Produce with **\`acks=all\`**. Never wait for the broker here, never
  raise because of it: the outcome arrives later, through the delivery callback.
- The **delivery callback** counts: \`delivered\` for an acknowledged record, \`failed\` for a rejected one.
  \`stats()\` returns both (\`{"delivered": n, "failed": n}\`). Serve the callbacks with \`poll(0)\` right after
  every produce (librdkafka only runs them inside \`poll\`/\`flush\`).
- \`shutdown() -> int\` — flushes with a **5-second** bound and returns how many records were **still
  undelivered** when it gave up: \`0\` after a clean stop. A dead broker must not hold the process for ever.

:::widget kafka-partitions {"partitions": 3}

> A producer is a buffer with a background thread: \`produce\` enqueues, the network happens later. The
> key is the ordering contract, the callback is where results come back, \`flush(timeout)\` is the one place
> a clean stop is allowed to wait — and only for so long.`,
  sequence: {
    participants: ['orders', 'Producer', 'Kafka'],
    messages: [
      {from: 'orders', to: 'Producer', label: 'produce(order-events, key=o-1, value=json)', kind: 'async'},
      {from: 'orders', to: 'orders', label: 'poll(0) · return', kind: 'sync'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(o-1) % 3, acks=all', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (offset 17)', kind: 'reply'},
      {from: 'Producer', to: 'orders', label: 'delivery callback → delivered += 1', kind: 'async'},
      {from: 'orders', to: 'Producer', label: 'shutdown: flush(5 s) → pending', kind: 'sync'},
    ],
  },
  hints: [
    'The key must be the *order id* bytes, not the JSON: the partitioner hashes the key, so equal ids always map to the same partition.',
    'The delivery callback receives an error or a message. Count in the callback, nowhere else — `produce` returning says nothing about delivery.',
    '`flush(5)` waits at most five seconds of broker time and returns the number of records still in the queue; that number is your return value.',
  ],
  checks: [
    {
      id: 'keyed',
      title: 'Keys records by order id: one partition per order',
      detail:
        'Every record of `order-events` carries the order id as its key, so all events of one order land on the partition the broker hashes that key to.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*order_id/]},
        typescript: {all: [/messages:\s*\[\s*\{[^\n]*key:\s*orderId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*orderID\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*orderId\s*,/]},
        cpp: {all: [/produce\([\s\S]{0,400}?order_id\.c_str\(\)\s*,\s*order_id\.size\(\)/]},
      },
    },
    {
      id: 'value',
      title: 'Values are the JSON contract',
      detail: 'The value parses as JSON with `order_id`, the event `type` and `ts` (seconds on the clock).',
      match: {
        python: {all: [/json\.dumps\(\s*\{[^\n]*"order_id"/, /produce\([^\n]*value\s*=\s*value/]},
        typescript: {all: [/JSON\.stringify\(\s*\{[^\n]*order_id/, /messages:\s*\[\s*\{[^\n]*\bvalue\b/]},
        go: {all: [/json\.Marshal\(/, /Value:\s*value/]},
        scala: {all: [/"order_id"/, /new ProducerRecord\[[^\]]*\]\([^\n]*,\s*value\s*\)/]},
        cpp: {all: [/order_id\\"/, /produce\([\s\S]{0,400}?value\.data\(\)\s*,\s*value\.size\(\)/]},
      },
    },
    {
      id: 'delivered',
      title: 'A clean shutdown delivers everything and returns 0',
      detail:
        'With `acks=all` and a flush in `shutdown()`, every emitted record is on the topic, `delivered` counts them all and `shutdown()` returns 0.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["']all["']/, /def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {all: [/acks:\s*-1/, /function shutdown(?:(?!\nexport )[\s\S])*?Promise\.all\(/]},
        go: {all: [/"acks":\s*"all"/, /func shutdown(?:(?!\n\})[\s\S])*?producer\.Flush\(/]},
        scala: {all: [/props\.put\(\s*"acks"\s*,\s*"all"\s*\)/, /def shutdown(?:(?!\n {2}def )[\s\S])*?inFlight\.get/]},
        cpp: {all: [/conf->set\(\s*"acks"\s*,\s*"all"/, /int shutdown(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'callback',
      title: 'A failed delivery is a count, not an exception',
      detail:
        'When the broker rejects a record, `emit` still returns normally; the delivery callback adds one to `failed`, and the next record is delivered as usual.',
      match: {
        python: {
          all: [
            /on_delivery\s*=\s*on_delivery|callback\s*=\s*on_delivery/,
            /def on_delivery(?:(?!\ndef )[\s\S])*?failed\s*\+=\s*1/,
          ],
        },
        typescript: {
          all: [
            /\.then\(\s*onDelivered\s*,\s*onFailed\s*\)/,
            /function onFailed(?:(?!\n(?:export )?function )[\s\S])*?failed\s*\+=\s*1/,
          ],
        },
        go: {all: [/\.Events\(\)/, /TopicPartition\.Error\s*!=\s*nil/, /failed\.Add\(1\)/]},
        scala: {all: [/onCompletion\(/, /if \(exception != null\)\s*failed\.incrementAndGet\(\)/]},
        cpp: {
          all: [/dr_cb\(/, /message\.err\(\)\s*!=\s*RdKafka::ERR_NO_ERROR[\s\S]{0,80}?failed\s*\+=\s*1|failed\+\+/],
        },
      },
    },
    {
      id: 'bounded',
      title: 'shutdown() gives up after 5 s and reports what is pending',
      detail:
        'With the broker stalled, `shutdown()` returns within 5 s of clock time with the number of records still undelivered; they count neither as delivered nor as failed.',
      match: {
        python: {all: [/producer\.flush\(\s*(?:timeout\s*=\s*)?5(?:\.0)?\s*\)/], none: [/producer\.flush\(\s*\)/]},
        typescript: {all: [/FLUSH_MS\s*=\s*5000/, /function shutdown(?:(?!\nexport )[\s\S])*?Promise\.race\(/]},
        go: {all: [/producer\.Flush\(\s*5000\s*\)/]},
        scala: {all: [/FlushMillis\s*=\s*5000/, /def shutdown(?:(?!\n {2}def )[\s\S])*?FlushMillis/]},
        cpp: {all: [/producer->flush\(\s*5000\s*\)/, /outq_len\(\)/]},
      },
    },
    {
      id: 'non-blocking',
      title: 'emit() returns without waiting for the broker',
      detail:
        'Under a stall, `emit` returns immediately with no clock time spent and no flush; the record is still in the producer’s queue and reaches the topic once the broker answers.',
      match: {
        python: {all: [/producer\.poll\(\s*0\s*\)/], none: [/def emit(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {
          all: [/producer\.send\(/],
          none: [/function emit(?:(?!\nexport )[\s\S])*?await\s+producer\.send\(/],
        },
        go: {all: [/producer\.Produce\(/], none: [/func emit(?:(?!\n\})[\s\S])*?producer\.Flush\(/]},
        scala: {all: [/producer\.send\(\s*record\s*,/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void emit(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

from confluent_kafka import Producer

TOPIC = "order-events"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "linger.ms": 5})

delivered = 0
failed = 0


def stats() -> dict:
    return {"delivered": delivered, "failed": failed}


def on_delivery(err, msg) -> None:
    # TODO: count failed when err is set, delivered otherwise
    pass


def emit(order_id: str, event: dict) -> None:
    value = json.dumps({"order_id": order_id, "type": event["type"], "ts": time.time()})
    # TODO: produce keyed by order_id with on_delivery; poll(0) to serve callbacks; never wait here
    raise NotImplementedError


def shutdown() -> int:
    # TODO: flush with a 5 s bound; return how many records are still undelivered
    raise NotImplementedError
`,
      solution: `import json
import time

from confluent_kafka import Producer

TOPIC = "order-events"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "linger.ms": 5})

delivered = 0
failed = 0


def stats() -> dict:
    return {"delivered": delivered, "failed": failed}


def on_delivery(err, msg) -> None:
    global delivered, failed
    if err is not None:
        failed += 1
    else:
        delivered += 1


def emit(order_id: str, event: dict) -> None:
    value = json.dumps({"order_id": order_id, "type": event["type"], "ts": time.time()})
    producer.produce(TOPIC, key=order_id, value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately


def shutdown() -> int:
    return producer.flush(5)  # records still in the queue after 5 s
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'order-events';
/** How long shutdown() waits for the broker. */
const FLUSH_MS = 5000;

const kafka = new Kafka({clientId: 'orders', brokers: ['kafka:9092']});
const producer = kafka.producer();
const ready = producer.connect();
/** Records handed to the producer and not yet acknowledged. */
const inFlight = new Set<Promise<void>>();

let delivered = 0;
let failed = 0;

export function stats(): {delivered: number; failed: number} {
  return {delivered, failed};
}

function onDelivered(): void {
  // TODO: count the delivery
}

function onFailed(err: Error): void {
  // TODO: count the failure
}

export function emit(orderId: string, event: {type: string}): void {
  const value = JSON.stringify({order_id: orderId, type: event.type, ts: Date.now() / 1000});
  // TODO: once ready, send keyed by orderId with acks all; route the outcome to onDelivered/onFailed; track it in inFlight
  // TODO: never await the broker here
  throw new Error('not implemented');
}

export async function shutdown(): Promise<number> {
  // TODO: wait for every in-flight delivery, at most FLUSH_MS; return how many are still in flight
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'order-events';
/** How long shutdown() waits for the broker. */
const FLUSH_MS = 5000;

const kafka = new Kafka({clientId: 'orders', brokers: ['kafka:9092']});
const producer = kafka.producer();
const ready = producer.connect();
/** Records handed to the producer and not yet acknowledged. */
const inFlight = new Set<Promise<void>>();

let delivered = 0;
let failed = 0;

export function stats(): {delivered: number; failed: number} {
  return {delivered, failed};
}

function onDelivered(): void {
  delivered += 1;
}

function onFailed(err: Error): void {
  failed += 1;
  console.warn(\`order event not delivered: \${err.message}\`);
}

export function emit(orderId: string, event: {type: string}): void {
  const value = JSON.stringify({order_id: orderId, type: event.type, ts: Date.now() / 1000});
  const delivery: Promise<void> = ready
    .then(() => producer.send({topic: TOPIC, messages: [{key: orderId, value}], acks: -1}))
    .then(onDelivered, onFailed)
    .finally(() => inFlight.delete(delivery));
  inFlight.add(delivery);
}

export async function shutdown(): Promise<number> {
  const deadline = new Promise<void>(resolve => setTimeout(resolve, FLUSH_MS));
  await Promise.race([Promise.all(inFlight), deadline]);
  return inFlight.size;
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const topic = "order-events"

var (
	producer  = newProducer()
	delivered atomic.Int64
	failed    atomic.Int64
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "all", "linger.ms": 5})
	if err != nil {
		panic(err)
	}
	// TODO: a goroutine over p.Events() that counts delivered and failed delivery reports
	return p
}

type orderEvent struct {
	OrderID string  \`json:"order_id"\`
	Type    string  \`json:"type"\`
	Ts      float64 \`json:"ts"\`
}

func stats() (int64, int64) {
	return delivered.Load(), failed.Load()
}

func emit(orderID string, eventType string) {
	value, _ := json.Marshal(orderEvent{OrderID: orderID, Type: eventType, Ts: float64(time.Now().UnixMilli()) / 1000})
	// TODO: Produce keyed by orderID; never wait for the broker here
	_ = value
}

func shutdown() int {
	// TODO: Flush with a 5 s bound; return how many records are still undelivered
	return -1
}
`,
      solution: `package main

import (
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

const topic = "order-events"

var (
	producer  = newProducer()
	delivered atomic.Int64
	failed    atomic.Int64
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "all", "linger.ms": 5})
	if err != nil {
		panic(err)
	}
	// Delivery reports arrive on the events channel; counting them never touches the request path.
	go func() {
		for e := range p.Events() {
			if m, ok := e.(*kafka.Message); ok {
				if m.TopicPartition.Error != nil {
					failed.Add(1)
				} else {
					delivered.Add(1)
				}
			}
		}
	}()
	return p
}

type orderEvent struct {
	OrderID string  \`json:"order_id"\`
	Type    string  \`json:"type"\`
	Ts      float64 \`json:"ts"\`
}

func stats() (int64, int64) {
	return delivered.Load(), failed.Load()
}

func emit(orderID string, eventType string) {
	value, _ := json.Marshal(orderEvent{OrderID: orderID, Type: eventType, Ts: float64(time.Now().UnixMilli()) / 1000})
	t := topic
	// Produce enqueues and returns; a full queue is the only error it can report here.
	if err := producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny},
		Key:            []byte(orderID),
		Value:          value,
	}, nil); err != nil {
		failed.Add(1)
	}
}

func shutdown() int {
	return producer.Flush(5000) // records still in the queue after 5 s
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.atomic.AtomicInteger

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

object OrderEvents {
  val Topic = "order-events"
  /** How long shutdown() waits for the broker. */
  val FlushMillis = 5000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val delivered = new AtomicInteger(0)
  private val failed = new AtomicInteger(0)
  private val inFlight = new AtomicInteger(0)

  def stats(): (Int, Int) = (delivered.get, failed.get)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
      // TODO: count failed when exception is set, delivered otherwise; the record is no longer in flight
    }
  }

  def emit(orderId: String, eventType: String): Unit = {
    val value = s"""{"order_id":"$orderId","type":"$eventType","ts":\${System.currentTimeMillis() / 1000.0}}"""
    // TODO: send a record keyed by orderId with onDelivery; count it in flight; do not block on the future
  }

  def shutdown(): Int = {
    // TODO: wait for in-flight records, at most FlushMillis; return how many are still in flight
    -1
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.atomic.AtomicInteger

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

object OrderEvents {
  val Topic = "order-events"
  /** How long shutdown() waits for the broker. */
  val FlushMillis = 5000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val delivered = new AtomicInteger(0)
  private val failed = new AtomicInteger(0)
  private val inFlight = new AtomicInteger(0)

  def stats(): (Int, Int) = (delivered.get, failed.get)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = {
      if (exception != null) failed.incrementAndGet() else delivered.incrementAndGet()
      inFlight.decrementAndGet()
    }
  }

  def emit(orderId: String, eventType: String): Unit = {
    val value = s"""{"order_id":"$orderId","type":"$eventType","ts":\${System.currentTimeMillis() / 1000.0}}"""
    val record = new ProducerRecord[String, String](Topic, orderId, value)
    inFlight.incrementAndGet()
    producer.send(record, onDelivery) // enqueues; the future is not awaited
  }

  def shutdown(): Int = {
    // flush() has no bound: wait for the callbacks ourselves, at most FlushMillis.
    val deadline = System.currentTimeMillis() + FlushMillis
    while (inFlight.get > 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
    inFlight.get
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <memory>
#include <string>

const std::string kTopic = "order-events";

int delivered = 0;
int failed = 0;

struct Stats {
  int delivered;
  int failed;
};

Stats stats() { return {delivered, failed}; }

class CountDeliveries : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    // TODO: count failed when message.err() is set, delivered otherwise
  }
};

CountDeliveries delivery_counter;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_counter, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void emit(const std::string& order_id, const std::string& type) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"order_id\\":\\"" + order_id + "\\",\\"type\\":\\"" + type + "\\",\\"ts\\":" + std::to_string(ts) + "}";
  // TODO: produce keyed by order_id (RK_MSG_COPY); poll(0) to serve callbacks; never wait here
}

int shutdown() {
  // TODO: flush with a 5 s bound; return how many records are still in the queue
  return -1;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <memory>
#include <string>

const std::string kTopic = "order-events";

int delivered = 0;
int failed = 0;

struct Stats {
  int delivered;
  int failed;
};

Stats stats() { return {delivered, failed}; }

class CountDeliveries : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR)
      failed += 1;
    else
      delivered += 1;
  }
};

CountDeliveries delivery_counter;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_counter, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void emit(const std::string& order_id, const std::string& type) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"order_id\\":\\"" + order_id + "\\",\\"type\\":\\"" + type + "\\",\\"ts\\":" + std::to_string(ts) + "}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    value.data(), value.size(), order_id.c_str(), order_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

int shutdown() {
  producer->flush(5000);        // waits at most 5 s for the queue to drain
  return producer->outq_len();  // what is still undelivered
}
`,
    },
  },
  harness: {
    python: `import json
import time

TOPIC = "order-events"


def check_keyed(ctx):
    m = ctx.load("order_events")
    for t in ("placed", "paid", "shipped"):
        m.emit("o-1", {"type": t})
    m.emit("o-2", {"type": "placed"})
    m.shutdown()
    produced = ctx.kafka.records(TOPIC)
    assert [r.key for r in produced] == [b"o-1", b"o-1", b"o-1", b"o-2"], f"records must be keyed by the order id, got {[r.key for r in produced]}"
    expected = ctx.kafka.partition_for(TOPIC, b"o-1")
    assert all(r.partition == expected for r in produced[:3]), "every event of order o-1 must land on the partition its key hashes to"
    assert [json.loads(r.value)["type"] for r in produced[:3]] == ["placed", "paid", "shipped"], "events of one order must keep their order"


def check_value(ctx):
    m = ctx.load("order_events")
    ctx.clock.advance(1000)
    before = time.time()
    m.emit("o-7", {"type": "paid"})
    m.shutdown()
    produced = ctx.kafka.records(TOPIC)
    assert len(produced) == 1, f"expected one record on {TOPIC}, found {len(produced)}"
    try:
        event = json.loads(produced[0].value)
    except Exception as exc:
        raise AssertionError(f"the value must be JSON: {produced[0].value!r} ({exc})")
    assert event.get("order_id") == "o-7" and event.get("type") == "paid", f"the value must carry order_id and type: {event}"
    ts = event.get("ts")
    assert isinstance(ts, (int, float)) and before - 1 <= ts <= time.time() + 1, f"ts must be the current time in seconds (clock at {before:.0f}), got {ts!r}"


def check_delivered(ctx):
    m = ctx.load("order_events")
    ctx.kafka.stall(TOPIC, 2)  # the broker answers 2 s later
    for i in range(4):
        m.emit(f"o-{i}", {"type": "placed"})
    assert m.stats() == {"delivered": 0, "failed": 0}, f"nothing is delivered before the broker acknowledges: {m.stats()}"
    pending = m.shutdown()
    assert pending == 0, f"shutdown() must return 0 once everything is delivered, got {pending!r}"
    assert len(ctx.kafka.records(TOPIC)) == 4, f"shutdown() must flush: {len(ctx.kafka.records(TOPIC))} of 4 records reached the broker"
    assert m.stats() == {"delivered": 4, "failed": 0}, f"the delivery callback must count 4 delivered, 0 failed: {m.stats()}"


def check_callback(ctx):
    m = ctx.load("order_events")
    ctx.kafka.fail_next(TOPIC)
    try:
        m.emit("o-1", {"type": "placed"})
    except Exception as exc:
        raise AssertionError(f"emit() must not raise on a failed delivery; the callback reports it: {exc!r}")
    m.emit("o-1", {"type": "paid"})
    pending = m.shutdown()
    assert pending == 0, f"a failed record is not pending: shutdown() returned {pending!r}"
    assert m.stats() == {"delivered": 1, "failed": 1}, f"expected 1 delivered and 1 failed, got {m.stats()}"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the second event must still be delivered after the first failed"


def check_bounded(ctx):
    m = ctx.load("order_events")
    ctx.kafka.stall(TOPIC)  # dead until resumed
    for i in range(3):
        m.emit("o-9", {"type": f"event-{i}"})
    started = time.time()
    pending = m.shutdown()
    waited = time.time() - started
    assert waited <= 5.5, f"shutdown() waited {waited:.1f} s on a dead broker: flush with a 5 s bound"
    assert pending == 3, f"shutdown() must return the 3 records still undelivered, got {pending!r}"
    assert m.stats() == {"delivered": 0, "failed": 0}, f"records still in the queue are neither delivered nor failed: {m.stats()}"
    assert ctx.kafka.flushes >= 1, "shutdown() must flush the producer"


def check_non_blocking(ctx):
    m = ctx.load("order_events")
    ctx.kafka.stall(TOPIC, 2)  # the broker answers 2 s later
    started = time.time()
    m.emit("o-3", {"type": "placed"})
    waited = time.time() - started
    assert waited < 1, f"emit() took {waited:.1f} s with the broker stalled: hand the record to the producer and return"
    assert ctx.kafka.flushes == 0, "emit() must not flush: the caller would wait for the broker"
    assert len(ctx.kafka.records(TOPIC)) == 0, "the record is in the producer's queue until the broker answers"
    assert m.shutdown() == 0
    assert len(ctx.kafka.records(TOPIC)) == 1, "the queued record must reach the broker once it answers"
    assert m.stats() == {"delivered": 1, "failed": 0}, f"the delivery callback must count it: {m.stats()}"
`,
    typescript: `const TOPIC = 'order-events';

export async function check_keyed(ctx) {
  const m = ctx.load('order_events');
  for (const type of ['placed', 'paid', 'shipped']) m.emit('o-1', {type});
  m.emit('o-2', {type: 'placed'});
  await m.shutdown();
  const produced = ctx.kafka.records(TOPIC);
  const keys = produced.map(r => (r.key === null ? null : String(r.key)));
  assert.deepEqual(keys, ['o-1', 'o-1', 'o-1', 'o-2'], \`records must be keyed by the order id, got \${JSON.stringify(keys)}\`);
  const expected = ctx.kafka.partitionFor(TOPIC, Buffer.from('o-1'));
  assert(produced.slice(0, 3).every(r => r.partition === expected), 'every event of order o-1 must land on the partition its key hashes to');
  assert.deepEqual(
    produced.slice(0, 3).map(r => JSON.parse(String(r.value)).type),
    ['placed', 'paid', 'shipped'],
    'events of one order must keep their order',
  );
}

export async function check_value(ctx) {
  const m = ctx.load('order_events');
  ctx.clock.advance(1000);
  const before = Date.now() / 1000;
  m.emit('o-7', {type: 'paid'});
  await m.shutdown();
  const produced = ctx.kafka.records(TOPIC);
  assert.equal(produced.length, 1, \`expected one record on \${TOPIC}, found \${produced.length}\`);
  let event;
  try {
    event = JSON.parse(String(produced[0].value));
  } catch (err) {
    throw new Error(\`the value must be JSON: \${String(produced[0].value)} (\${err.message})\`);
  }
  assert(event.order_id === 'o-7' && event.type === 'paid', \`the value must carry order_id and type: \${JSON.stringify(event)}\`);
  assert(typeof event.ts === 'number' && event.ts >= before - 1 && event.ts <= Date.now() / 1000 + 1, \`ts must be the current time in seconds (clock at \${before.toFixed(0)}), got \${JSON.stringify(event.ts)}\`);
}

export async function check_delivered(ctx) {
  const m = ctx.load('order_events');
  ctx.kafka.stall(TOPIC, 2); // the broker answers 2 s later
  for (let i = 0; i < 4; i++) m.emit(\`o-\${i}\`, {type: 'placed'});
  const pending = await m.shutdown();
  assert.equal(pending, 0, \`shutdown() must return 0 once everything is delivered, got \${JSON.stringify(pending)}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 4, \`shutdown() must flush: \${ctx.kafka.records(TOPIC).length} of 4 records reached the broker\`);
  assert.deepEqual(m.stats(), {delivered: 4, failed: 0}, \`the delivery handlers must count 4 delivered, 0 failed: \${JSON.stringify(m.stats())}\`);
}

export async function check_callback(ctx) {
  const m = ctx.load('order_events');
  ctx.kafka.failNext(TOPIC);
  try {
    m.emit('o-1', {type: 'placed'});
  } catch (err) {
    throw new Error(\`emit() must not throw on a failed delivery; the handler reports it: \${err.message}\`);
  }
  m.emit('o-1', {type: 'paid'});
  const pending = await m.shutdown();
  assert.equal(pending, 0, \`a failed record is not pending: shutdown() returned \${JSON.stringify(pending)}\`);
  assert.deepEqual(m.stats(), {delivered: 1, failed: 1}, \`expected 1 delivered and 1 failed, got \${JSON.stringify(m.stats())}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the second event must still be delivered after the first failed');
}

export async function check_bounded(ctx) {
  const m = ctx.load('order_events');
  ctx.kafka.stall(TOPIC); // dead until resumed
  for (let i = 0; i < 3; i++) m.emit('o-9', {type: \`event-\${i}\`});
  const started = ctx.clock.now();
  const pending = await m.shutdown();
  const waited = ctx.clock.now() - started;
  assert(waited <= 5500, \`shutdown() waited \${(waited / 1000).toFixed(1)} s on a dead broker: give up after 5 s\`);
  assert.equal(pending, 3, \`shutdown() must return the 3 records still undelivered, got \${JSON.stringify(pending)}\`);
  assert.deepEqual(m.stats(), {delivered: 0, failed: 0}, \`records still in flight are neither delivered nor failed: \${JSON.stringify(m.stats())}\`);
}

export async function check_non_blocking(ctx) {
  const m = ctx.load('order_events');
  ctx.kafka.stall(TOPIC, 2); // the broker answers 2 s later
  const started = ctx.clock.now();
  await m.emit('o-3', {type: 'placed'});
  const waited = ctx.clock.now() - started;
  assert(waited < 1000, \`emit() took \${waited} ms with the broker stalled: hand the record to the producer and return\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'the record is in flight until the broker answers');
  assert.equal(await m.shutdown(), 0);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the in-flight record must reach the broker once it answers');
  assert.deepEqual(m.stats(), {delivered: 1, failed: 0}, \`the delivery handlers must count it: \${JSON.stringify(m.stats())}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"fmt"

	"leetbuild/harness"
)

const keyedTopic = "order-events"

// keyedStats is stats() as the TypeScript harness compares it, once the delivery-report goroutine
// has counted what was reported.
func keyedStats(ctx *harness.Ctx) map[string]int64 {
	ctx.Settle()
	d, f := stats()
	return map[string]int64{"delivered": d, "failed": f}
}

func CheckKeyed(ctx *harness.Ctx) {
	for _, t := range []string{"placed", "paid", "shipped"} {
		emit("o-1", t)
	}
	emit("o-2", "placed")
	shutdown()
	produced := ctx.Kafka.Records(keyedTopic)
	ctx.Equal(ctx.Kafka.Keys(keyedTopic), []string{"o-1", "o-1", "o-1", "o-2"}, "records must be keyed by the order id")
	expected := ctx.Kafka.PartitionFor(keyedTopic, []byte("o-1"))
	var types []string
	for _, r := range produced[:3] {
		ctx.Assert(r.Partition == expected, "every event of order o-1 must land on the partition its key hashes to")
		var event map[string]any
		_ = json.Unmarshal(r.Value, &event)
		t, _ := event["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"placed", "paid", "shipped"}, "events of one order must keep their order")
}

func CheckValue(ctx *harness.Ctx) {
	ctx.Clock.Advance(1000)
	before := float64(ctx.Clock.Now()) / 1000
	emit("o-7", "paid")
	shutdown()
	produced := ctx.Kafka.Records(keyedTopic)
	ctx.Equal(len(produced), 1, "expected one record on %s", keyedTopic)
	var event map[string]any
	if err := json.Unmarshal(produced[0].Value, &event); err != nil {
		ctx.Fatalf("the value must be JSON: %s (%v)", produced[0].Value, err)
	}
	ctx.Assert(event["order_id"] == "o-7" && event["type"] == "paid", "the value must carry order_id and type: %s", produced[0].Value)
	ts, ok := event["ts"].(float64)
	ctx.Assert(ok && ts >= before-1 && ts <= float64(ctx.Clock.Now())/1000+1, "ts must be the current time in seconds (clock at %.0f), got %v", before, event["ts"])
}

func CheckDelivered(ctx *harness.Ctx) {
	ctx.Kafka.StallFor(keyedTopic, 2) // the broker answers 2 s later
	for i := range 4 {
		emit(fmt.Sprintf("o-%d", i), "placed")
	}
	pending := shutdown()
	ctx.Equal(pending, 0, "shutdown() must return 0 once everything is delivered")
	n := len(ctx.Kafka.Records(keyedTopic))
	ctx.Assert(n == 4, "shutdown() must flush: %d of 4 records reached the broker", n)
	ctx.Equal(keyedStats(ctx), map[string]int64{"delivered": 4, "failed": 0}, "the delivery reports must count 4 delivered, 0 failed")
}

func CheckCallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(keyedTopic, 1)
	func() {
		defer func() {
			if r := recover(); r != nil {
				ctx.Fatalf("emit() must not panic on a failed delivery; the delivery report carries it: %v", r)
			}
		}()
		emit("o-1", "placed")
	}()
	emit("o-1", "paid")
	pending := shutdown()
	ctx.Equal(pending, 0, "a failed record is not pending: shutdown()")
	ctx.Equal(keyedStats(ctx), map[string]int64{"delivered": 1, "failed": 1}, "expected 1 delivered and 1 failed")
	ctx.Equal(len(ctx.Kafka.Records(keyedTopic)), 1, "the second event must still be delivered after the first failed")
}

func CheckBounded(ctx *harness.Ctx) {
	ctx.Kafka.Stall(keyedTopic) // dead until resumed
	for i := range 3 {
		emit("o-9", fmt.Sprintf("event-%d", i))
	}
	started := ctx.Clock.Now()
	pending := shutdown()
	waited := ctx.Clock.Now() - started
	ctx.Assert(waited <= 5500, "shutdown() waited %.1f s on a dead broker: give up after 5 s", float64(waited)/1000)
	ctx.Equal(pending, 3, "shutdown() must return the 3 records still undelivered")
	d, f := stats()
	ctx.Equal(map[string]int64{"delivered": d, "failed": f}, map[string]int64{"delivered": 0, "failed": 0}, "records still in flight are neither delivered nor failed")
}

func CheckNonBlocking(ctx *harness.Ctx) {
	ctx.Kafka.StallFor(keyedTopic, 2) // the broker answers 2 s later
	started := ctx.Clock.Now()
	emit("o-3", "placed")
	waited := ctx.Clock.Now() - started
	ctx.Assert(waited < 1000, "emit() took %d ms with the broker stalled: hand the record to the producer and return", waited)
	ctx.Equal(len(ctx.Kafka.Records(keyedTopic)), 0, "the record is in flight until the broker answers")
	ctx.Equal(shutdown(), 0, "shutdown()")
	ctx.Equal(len(ctx.Kafka.Records(keyedTopic)), 1, "the in-flight record must reach the broker once it answers")
	ctx.Equal(keyedStats(ctx), map[string]int64{"delivered": 1, "failed": 0}, "the delivery reports must count it")
}
`,
  },
  debrief: `The producer is a queue with a background thread; \`produce\` costs microseconds and \`emit\` must stay that cheap, so the only honest place to learn what happened is the delivery callback — which librdkafka runs inside \`poll\`/\`flush\`, hence the \`poll(0)\` after every produce. The key is the ordering contract: same order id → same partition → same order, whatever the partition count. \`acks=all\` means an acknowledged record survives a leader failover. \`flush(5)\` is the one wait a clean stop is allowed: it drains the queue if the broker is alive and returns the count it could not deliver if not, so the process exits either way and the number is logged instead of lost. Real systems add \`enable.idempotence\` so retries after a lost ack do not duplicate, a bounded queue (\`queue.buffering.max.messages\`) with a policy for when it is full, and a \`message.timeout.ms\` short enough that a dead broker fails records through the callback instead of holding them for five minutes.`,
};
