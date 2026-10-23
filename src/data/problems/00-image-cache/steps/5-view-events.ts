import type {Step} from '@/lib/types';

export const viewEventsStep: Step = {
  id: 'view-events',
  title: 'Emit an image-views event per request',
  concept: 'kafka',
  file: 'view_events',
  focus: ['thumbs', 'kafka'],
  task: `## Task

Analytics wants to know which images are viewed at which sizes. Implement \`emit_view(id, width, hit)\`
so every request produces one record on the **\`image-views\`** topic:

- Key the record by the **image id** — all events for one image land on one partition, in order.
- The value is a small JSON document: \`{"id": …, "w": …, "hit": …, "ts": …}\`.
- The request must **not wait for the broker**: hand the record to the producer and return. Failures
  are reported through the delivery callback and logged — a lost analytics event is not worth a slow
  page.
- Provide \`shutdown()\` that flushes what is still buffered, so a clean stop loses nothing.

:::widget kafka-partitions {"partitions": 4}`,
  sequence: {
    participants: ['thumbs', 'Producer', 'Kafka'],
    messages: [
      {from: 'thumbs', to: 'Producer', label: 'produce(image-views, key=cat, value=json)', kind: 'async'},
      {from: 'thumbs', to: 'thumbs', label: 'return 200 to the browser', kind: 'sync'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(cat) % 4', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (offset 1041)', kind: 'reply'},
      {from: 'Producer', to: 'thumbs', label: 'delivery callback', kind: 'async'},
    ],
  },
  hints: [
    'Producers batch in the background: the produce call enqueues and returns. Only `flush()` (or blocking on the future) waits — keep that out of the request path.',
    'The key must be the *image id* bytes, not the JSON: the partitioner hashes the key, so equal ids always map to the same partition.',
    'Delivery callbacks run when the broker acknowledges — on the producer’s I/O thread in the Java client and kafka-go, but inside `poll()` for librdkafka-based clients (confluent-kafka, rdkafkacpp): call `poll(0)` after each produce so they get served.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Produces to image-views',
      detail: 'The record goes to the `image-views` topic.',
      match: {
        python: {all: [/image-views/, /producer\.produce\(/]},
        typescript: {all: [/image-views/, /producer\.send\(/]},
        go: {all: [/image-views/, /WriteMessages\(/]},
        scala: {all: [/image-views/, /producer\.send\(/]},
        cpp: {all: [/image-views/, /producer->produce\(/]},
      },
    },
    {
      id: 'keyed',
      title: 'Keys records by image id',
      detail: 'Setting the key to the image id keeps all events of one image on one partition, in order.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*image_id/]},
        typescript: {all: [/messages:\s*\[\s*\{[^\n]*key:\s*imageId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*id\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*id\s*,/]},
        cpp: {all: [/produce\([\s\S]{0,400}?id\.c_str\(\)\s*,\s*id\.size\(\)/]},
      },
    },
    {
      id: 'non-blocking',
      title: 'Does not wait for the broker on the request path',
      detail:
        'Enqueue and return; serve delivery callbacks with `poll(0)` (or async writes) instead of blocking on an acknowledgement.',
      match: {
        python: {all: [/producer\.poll\(\s*0\s*\)/], none: [/def emit_view(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {
          all: [/producer\.send\(/],
          none: [/function emitView(?:(?!\nexport )[\s\S])*?await\s+producer\.send\(/],
        },
        go: {all: [/Async:\s*true/], none: [/if err := writer\.WriteMessages/]},
        scala: {all: [/producer\.send\(\s*record\s*,/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void emit_view(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'callback',
      title: 'Reports delivery failures through a callback',
      detail: 'A delivery report callback logs failed records; nothing else needs to happen for analytics events.',
      match: {
        python: {all: [/on_delivery\s*=\s*on_delivery|callback\s*=\s*on_delivery/]},
        typescript: {all: [/\bonDelivery\b/, /\.catch\(|\.then\([^\n]*,/]},
        go: {all: [/Completion:\s*func\(/]},
        scala: {all: [/onCompletion\(/]},
        cpp: {all: [/dr_cb\(|DeliveryReportCb/]},
      },
    },
    {
      id: 'flush',
      title: 'Flushes on shutdown',
      detail: 'Buffered records are only sent when the producer flushes; do it once at shutdown.',
      match: {
        python: {all: [/def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {all: [/function shutdown(?:(?!\nexport )[\s\S])*?await Promise\.all\(/]},
        go: {all: [/func shutdown(?:(?!\n\})[\s\S])*?writer\.Close\(\)/]},
        scala: {all: [/def shutdown(?:(?!\n {2}def )[\s\S])*?producer\.(flush|close)\(/]},
        cpp: {all: [/void shutdown(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "image-views"
log = logging.getLogger("views")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    # TODO: log a warning when err is set
    pass


def emit_view(image_id: str, width: int, hit: bool) -> None:
    value = json.dumps({"id": image_id, "w": width, "hit": hit, "ts": time.time()})
    # TODO: produce keyed by image_id with on_delivery; poll(0) to serve callbacks; never block here
    raise NotImplementedError


def shutdown() -> None:
    # TODO: flush with a timeout so buffered events reach the broker
    raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "image-views"
log = logging.getLogger("views")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("view event for %s not delivered: %s", msg.key(), err)


def emit_view(image_id: str, width: int, hit: bool) -> None:
    value = json.dumps({"id": image_id, "w": width, "hit": hit, "ts": time.time()})
    producer.produce(TOPIC, key=image_id, value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately


def shutdown() -> None:
    remaining = producer.flush(timeout=5)
    if remaining:
        log.warning("%d view events were not delivered", remaining)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'image-views';

const kafka = new Kafka({clientId: 'thumbs', brokers: ['kafka:9092']});
const producer = kafka.producer();
const ready = producer.connect();
/** Deliveries handed to the producer and not yet acknowledged. */
const inFlight = new Set<Promise<void>>();

function onDelivery(imageId: string, err: Error): void {
  // TODO: log a warning: the event was not delivered
}

export function emitView(imageId: string, width: number, hit: boolean): void {
  const value = JSON.stringify({id: imageId, w: width, hit, ts: Date.now() / 1000});
  // TODO: once ready, send keyed by imageId; report failures through onDelivery; track the delivery in inFlight
  // TODO: never await the broker here
  throw new Error('not implemented');
}

export async function shutdown(): Promise<void> {
  // TODO: wait for every in-flight delivery, then disconnect
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'image-views';

const kafka = new Kafka({clientId: 'thumbs', brokers: ['kafka:9092']});
const producer = kafka.producer();
const ready = producer.connect();
/** Deliveries handed to the producer and not yet acknowledged. */
const inFlight = new Set<Promise<void>>();

function onDelivery(imageId: string, err: Error): void {
  console.warn(\`view event for \${imageId} not delivered: \${err.message}\`);
}

export function emitView(imageId: string, width: number, hit: boolean): void {
  const value = JSON.stringify({id: imageId, w: width, hit, ts: Date.now() / 1000});
  const delivery: Promise<void> = ready
    .then(() => producer.send({topic: TOPIC, messages: [{key: imageId, value}], acks: 1}))
    .then(
      () => undefined,
      (err: Error) => onDelivery(imageId, err),
    )
    .finally(() => inFlight.delete(delivery));
  inFlight.add(delivery);
}

export async function shutdown(): Promise<void> {
  await Promise.all(inFlight);
  await producer.disconnect();
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

	"github.com/segmentio/kafka-go"
)

const topic = "image-views"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	// TODO: Async writes with a Completion callback that logs failures
}

type viewEvent struct {
	ID  string  \`json:"id"\`
	W   int     \`json:"w"\`
	Hit bool    \`json:"hit"\`
	Ts  float64 \`json:"ts"\`
}

func emitView(ctx context.Context, id string, width int, hit bool) {
	value, _ := json.Marshal(viewEvent{ID: id, W: width, Hit: hit, Ts: float64(time.Now().UnixMilli()) / 1000})
	// TODO: WriteMessages with the image id as Key; never block the request on the broker
	_ = value
	log.Println("not implemented")
}

func shutdown() {
	// TODO: close the writer so buffered events reach the broker
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "image-views"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d view events not delivered: %v", len(messages), err)
		}
	},
}

type viewEvent struct {
	ID  string  \`json:"id"\`
	W   int     \`json:"w"\`
	Hit bool    \`json:"hit"\`
	Ts  float64 \`json:"ts"\`
}

func emitView(ctx context.Context, id string, width int, hit bool) {
	value, _ := json.Marshal(viewEvent{ID: id, W: width, Hit: hit, Ts: float64(time.Now().UnixMilli()) / 1000})
	// Async writer: this enqueues and returns; Completion reports the outcome.
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(id), Value: value})
}

func shutdown() {
	if err := writer.Close(); err != nil {
		log.Printf("closing view writer: %v", err)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

object ViewEvents {
  val Topic = "image-views"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def emitView(id: String, width: Int, hit: Boolean): Unit = {
    val value = s"""{"id":"$id","w":$width,"hit":$hit,"ts":\${System.currentTimeMillis() / 1000.0}}"""
    // TODO: send a record keyed by id with a Callback that logs failures; do not block on the future
  }

  def shutdown(): Unit = {
    // TODO: flush and close so buffered events reach the broker
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer

object ViewEvents {
  val Topic = "image-views"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"view event not delivered: \${exception.getMessage}")
  }

  def emitView(id: String, width: Int, hit: Boolean): Unit = {
    val value = s"""{"id":"$id","w":$width,"hit":$hit,"ts":\${System.currentTimeMillis() / 1000.0}}"""
    val record = new ProducerRecord[String, String](Topic, id, value)
    producer.send(record, onDelivery) // enqueues; the future is not awaited
  }

  def shutdown(): Unit = {
    producer.flush()
    producer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

const std::string kTopic = "image-views";

// TODO: a DeliveryReportCb that logs failed messages

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  // TODO: conf->set("dr_cb", &callback, err)
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void emit_view(const std::string& id, int width, bool hit) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"id\\":\\"" + id + "\\",\\"w\\":" + std::to_string(width) +
                      ",\\"hit\\":" + (hit ? "true" : "false") + ",\\"ts\\":" + std::to_string(ts) + "}";
  // TODO: produce keyed by id (RK_MSG_COPY); poll(0) to serve callbacks; never block here
}

void shutdown() {
  // TODO: flush with a timeout so buffered events reach the broker
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

const std::string kTopic = "image-views";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR)
      std::cerr << "view event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void emit_view(const std::string& id, int width, bool hit) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"id\\":\\"" + id + "\\",\\"w\\":" + std::to_string(width) +
                      ",\\"hit\\":" + (hit ? "true" : "false") + ",\\"ts\\":" + std::to_string(ts) + "}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    value.data(), value.size(), id.c_str(), id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

void shutdown() {
  if (producer->flush(5000) != RdKafka::ERR_NO_ERROR)
    std::cerr << producer->outq_len() << " view events were not delivered\\n";
}
`,
    },
  },
  harness: {
    python: `import json
import logging


def _events(ctx):
    m = ctx.load("view_events")
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger().addHandler(handler)
    return m, records


def check_topic(ctx):
    m, _ = _events(ctx)
    m.emit_view("cat", 256, True)
    produced = ctx.kafka.records("image-views")
    assert len(produced) == 1, f"expected one record on image-views, found {len(produced)}"
    event = json.loads(produced[0].value)
    assert event.get("id") == "cat" and event.get("w") == 256 and event.get("hit") is True, f"the value must be JSON with id, w, hit (and ts): {event}"
    assert "ts" in event, "the event must carry a timestamp"


def check_keyed(ctx):
    m, _ = _events(ctx)
    m.emit_view("cat", 256, True)
    m.emit_view("cat", 64, False)
    produced = ctx.kafka.records("image-views")
    assert [r.key for r in produced] == [b"cat", b"cat"], f"records must be keyed by the image id, got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "the same image id must land on the same partition"


def check_non_blocking(ctx):
    m, _ = _events(ctx)
    m.emit_view("cat", 256, True)
    assert ctx.kafka.flushes == 0, "emit_view must not flush: the request would wait for the broker"
    assert len(ctx.kafka.records("image-views")) == 1


def check_callback(ctx):
    m, records = _events(ctx)
    ctx.kafka.fail_next("image-views")
    m.emit_view("cat", 256, True)  # the failure arrives through the delivery callback, not as an exception
    m.emit_view("cat", 256, True)  # poll() on the next call serves the pending callback at the latest
    m.shutdown()
    warnings = [r for r in records if r.levelno >= logging.WARNING]
    assert warnings, "a failed delivery must be logged by the delivery callback"


def check_flush(ctx):
    m, _ = _events(ctx)
    m.emit_view("cat", 256, True)
    m.shutdown()
    assert ctx.kafka.flushes >= 1, "shutdown() must flush the producer"
`,
    typescript: `import {setTimeout as sleep} from 'node:timers/promises';

/** The learner's module plus everything it warns or errors about (the delivery reports). */
function events(ctx) {
  const m = ctx.load('view_events');
  const warnings: string[] = [];
  const record = (...args: unknown[]) => warnings.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.warn = record;
  console.error = record;
  return {m, warnings};
}

export async function check_topic(ctx) {
  const {m} = events(ctx);
  m.emitView('cat', 256, true);
  await sleep(10); // the producer's background work gets a turn
  const produced = ctx.kafka.records('image-views');
  assert.equal(produced.length, 1, \`expected one record on image-views, found \${produced.length}\`);
  const event = JSON.parse(String(produced[0].value));
  assert(event.id === 'cat' && event.w === 256 && event.hit === true, \`the value must be JSON with id, w, hit (and ts): \${JSON.stringify(event)}\`);
  assert('ts' in event, 'the event must carry a timestamp');
}

export async function check_keyed(ctx) {
  const {m} = events(ctx);
  m.emitView('cat', 256, true);
  m.emitView('cat', 64, false);
  await sleep(10);
  const produced = ctx.kafka.records('image-views');
  const keys = produced.map(r => (r.key === null ? null : String(r.key)));
  assert.deepEqual(keys, ['cat', 'cat'], \`records must be keyed by the image id, got \${JSON.stringify(keys)}\`);
  assert.equal(produced[0].partition, produced[1].partition, 'the same image id must land on the same partition');
}

export async function check_non_blocking(ctx) {
  const {m} = events(ctx);
  ctx.kafka.stall('image-views', 2); // the broker answers 2 s later
  const started = ctx.clock.now();
  await m.emitView('cat', 256, true);
  const waited = ctx.clock.now() - started;
  assert(waited < 1000, \`emitView took \${waited} ms with the broker stalled: hand the record to the producer and return, do not wait for the ack\`);
  assert.equal(ctx.kafka.records('image-views').length, 0, 'emitView returned only after the broker acknowledged the record: hand it to the producer and return, do not wait for the ack');
  await m.shutdown();
  assert.equal(ctx.kafka.records('image-views').length, 1, 'the event handed to the producer must still reach the broker');
}

export async function check_callback(ctx) {
  const {m, warnings} = events(ctx);
  ctx.kafka.failNext('image-views');
  m.emitView('cat', 256, true); // the failure arrives through the delivery report, not as an exception
  m.emitView('cat', 256, true);
  await sleep(10);
  assert(warnings.length > 0, 'a failed delivery must be logged by the delivery report (console.warn)');
  assert.equal(ctx.kafka.records('image-views').length, 1, 'the second event must still be delivered after the first failed');
}

export async function check_flush(ctx) {
  const {m} = events(ctx);
  ctx.kafka.stall('image-views', 2); // the broker answers 2 s later
  m.emitView('cat', 256, true);
  m.emitView('dog', 256, true);
  m.emitView('cat', 64, false);
  await m.shutdown();
  const delivered = ctx.kafka.records('image-views').length;
  assert.equal(delivered, 3, \`shutdown() must flush: \${delivered} of 3 buffered events had reached the broker when it returned\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"leetbuild/harness"
)

var veBg = context.Background()

// veLog records every line the learner logs (the delivery reports).
type veLog struct {
	mu    sync.Mutex
	lines int
}

func (l *veLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines++
	return len(p), nil
}

func (l *veLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lines
}

func CheckTopic(ctx *harness.Ctx) {
	emitView(veBg, "cat", 256, true)
	time.Sleep(10 * time.Millisecond) // the producer's background work gets a turn
	produced := ctx.Kafka.Records("image-views")
	ctx.Equal(len(produced), 1, "records on image-views")
	var event map[string]any
	ctx.NoError(json.Unmarshal(produced[0].Value, &event), "the value must be JSON, got %q", produced[0].Value)
	ctx.Assert(event["id"] == "cat" && event["w"] == float64(256) && event["hit"] == true, "the value must be JSON with id, w, hit (and ts): %s", produced[0].Value)
	_, hasTs := event["ts"]
	ctx.Assert(hasTs, "the event must carry a timestamp")
}

func CheckKeyed(ctx *harness.Ctx) {
	emitView(veBg, "cat", 256, true)
	emitView(veBg, "cat", 64, false)
	time.Sleep(10 * time.Millisecond)
	ctx.Equal(ctx.Kafka.Keys("image-views"), []string{"cat", "cat"}, "records must be keyed by the image id")
	produced := ctx.Kafka.Records("image-views")
	ctx.Equal(produced[0].Partition, produced[1].Partition, "the same image id must land on the same partition")
}

func CheckNonBlocking(ctx *harness.Ctx) {
	ctx.Kafka.StallFor("image-views", 2) // the broker answers 2 s later
	started := ctx.Clock.Now()
	emitView(veBg, "cat", 256, true)
	waited := ctx.Clock.Now() - started
	ctx.Assert(waited < 1000, "emitView took %d ms with the broker stalled: hand the record to the producer and return, do not wait for the ack", waited)
	ctx.Equal(len(ctx.Kafka.Records("image-views")), 0, "emitView returned only after the broker acknowledged the record: hand it to the producer and return, do not wait for the ack")
	shutdown()
	ctx.Equal(len(ctx.Kafka.Records("image-views")), 1, "the event handed to the producer must still reach the broker")
}

func CheckCallback(ctx *harness.Ctx) {
	logged := &veLog{}
	previous := log.Writer()
	log.SetOutput(logged)
	defer log.SetOutput(previous)
	ctx.Kafka.FailNext("image-views", 1)
	emitView(veBg, "cat", 256, true) // the failure arrives through the Completion callback, not as a return value
	emitView(veBg, "cat", 256, true)
	time.Sleep(10 * time.Millisecond)
	ctx.Assert(logged.count() > 0, "a failed delivery must be logged by the Completion callback (log.Printf)")
	ctx.Equal(len(ctx.Kafka.Records("image-views")), 1, "the second event must still be delivered after the first failed")
}

func CheckFlush(ctx *harness.Ctx) {
	ctx.Kafka.StallFor("image-views", 2) // the broker answers 2 s later
	emitView(veBg, "cat", 256, true)
	emitView(veBg, "dog", 256, true)
	emitView(veBg, "cat", 64, false)
	shutdown()
	ctx.Equal(len(ctx.Kafka.Records("image-views")), 3, "shutdown() must flush: buffered events that had reached the broker when it returned")
}
`,
  },
  debrief: `A Kafka producer is a buffer with a background thread: \`produce\`/\`send\` costs microseconds, the network happens later in batches. That is what makes "emit an event per request" free — as long as nobody blocks on the acknowledgement. The key is your ordering contract: same key → same partition → same order for that image. Real systems also set \`acks=all\` for events they cannot afford to lose, enable idempotent producers so retries do not duplicate, and never let the buffer grow unbounded (\`queue.buffering.max.messages\`, back-pressure).`,
};
