import type {Step} from '@/lib/types';

export const clickEventsStep: Step = {
  id: 'click-events',
  title: 'Emit a clicks event per redirect',
  concept: 'kafka',
  file: 'click_events',
  focus: ['api', 'kafka'],
  task: `## Task

Every redirect is a click somebody wants to count. Implement \`record_click(code, referrer, ua)\` —
the redirect handler calls it right after answering — so each click produces one record on the
**\`clicks\`** topic:

- Key the record by the **code**: all clicks of one link land on one partition, in order, and the
  consumer of the next step can count them without cross-partition merges.
- The value is a small JSON document: \`{"code": …, "ts": …, "referrer": …, "ua": …}\`.
- The redirect must **not wait for the broker**: hand the record to the producer and return. Failures
  are reported through the delivery callback and logged — a lost click is not worth a slow redirect.
- Provide \`shutdown()\` that flushes what is still buffered, so a clean stop loses nothing.

:::widget kafka-partitions {"partitions": 6}`,
  sequence: {
    participants: ['sho.rt', 'Producer', 'Kafka'],
    messages: [
      {from: 'sho.rt', to: 'sho.rt', label: '302 sent to the browser', kind: 'sync'},
      {from: 'sho.rt', to: 'Producer', label: 'produce(clicks, key=g9Xc, value=json)', kind: 'async'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(g9Xc) % 6', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (offset 52 019)', kind: 'reply'},
      {from: 'Producer', to: 'sho.rt', label: 'delivery callback', kind: 'async'},
    ],
  },
  hints: [
    'Producers batch in the background: the produce call enqueues and returns. Only `flush()` (or blocking on the future) waits — keep that out of `record_click`.',
    'The key is the *code* bytes, not the JSON: the partitioner hashes the key, so equal codes always map to the same partition.',
    'Delivery callbacks run when the broker acknowledges — on the producer’s I/O thread in the Java client and kafka-go, but inside `poll()` for librdkafka-based clients (confluent-kafka, rdkafkacpp): call `poll(0)` after each produce so they get served.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Produces to clicks',
      detail: 'The record goes to the `clicks` topic.',
      match: {
        python: {all: [/"clicks"/, /producer\.produce\(/]},
        typescript: {all: [/['"]clicks['"]/, /producer\.send\(/]},
        go: {all: [/"clicks"/, /WriteMessages\(/]},
        scala: {all: [/"clicks"/, /producer\.send\(/]},
        cpp: {all: [/"clicks"/, /producer->produce\(/]},
      },
    },
    {
      id: 'keyed',
      title: 'Keys records by code',
      detail: 'Setting the key to the code keeps all clicks of one link on one partition, in order.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*code/]},
        typescript: {all: [/key:\s*code\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*code\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*code\s*,/]},
        cpp: {all: [/produce\([\s\S]{0,400}?code\.(c_str|data)\(\)\s*,\s*code\.(size|length)\(\)/]},
      },
    },
    {
      id: 'non-blocking',
      title: 'Does not wait for the broker on the redirect path',
      detail:
        'Enqueue and return; serve delivery callbacks with `poll(0)` (or async writes) instead of blocking on an acknowledgement.',
      match: {
        python: {all: [/producer\.poll\(\s*0\s*\)/], none: [/def record_click(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {
          all: [/producer\.send\(/],
          none: [/async function recordClick\b/, /function recordClick(?:(?!\n\})[\s\S])*?(await\s|producer\.send\()/],
        },
        go: {all: [/Async:\s*true/], none: [/if err := writer\.WriteMessages/]},
        scala: {all: [/producer\.send\(\s*\w+\s*,/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void record_click(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'callback',
      title: 'Reports delivery failures through a callback',
      detail: 'A delivery report callback logs failed records; nothing else needs to happen for a click.',
      match: {
        python: {all: [/on_delivery\s*=\s*on_delivery|callback\s*=\s*on_delivery/]},
        typescript: {all: [/\.(catch|then)\([^\n]*onDelivery/]},
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
        typescript: {all: [/async function shutdown(?:(?!\n\})[\s\S])*?await [^\n]*(sendBatch\(\)|Promise\.all)/]},
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

TOPIC = "clicks"
log = logging.getLogger("clicks")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    # TODO: log a warning when err is set
    pass


def record_click(code: str, referrer: str | None, ua: str | None) -> None:
    value = json.dumps({"code": code, "ts": time.time(), "referrer": referrer, "ua": ua})
    # TODO: produce keyed by code with on_delivery; poll(0) to serve callbacks; never block here
    raise NotImplementedError


def shutdown() -> None:
    # TODO: flush with a timeout so buffered clicks reach the broker
    raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "clicks"
log = logging.getLogger("clicks")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("click on %s not delivered: %s", msg.key(), err)


def record_click(code: str, referrer: str | None, ua: str | None) -> None:
    value = json.dumps({"code": code, "ts": time.time(), "referrer": referrer, "ua": ua})
    producer.produce(TOPIC, key=code, value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately


def shutdown() -> None:
    remaining = producer.flush(timeout=5)
    if remaining:
        log.warning("%d clicks were not delivered", remaining)
`,
    },
    typescript: {
      starter: `import {Kafka, type Message} from 'kafkajs';

export const TOPIC = 'clicks';
const LINGER_MS = 5;

const kafka = new Kafka({clientId: 'shortener', brokers: ['kafka:9092']});
const producer = kafka.producer();
const ready = producer.connect();

/** Logger (provided). */
export const log = {
  warn(message: string): void {
    console.warn(message);
  },
};

const buffered: Message[] = [];
let linger: NodeJS.Timeout | null = null;
const inflight = new Set<Promise<void>>();

function onDelivery(err: Error, batch: Message[]): void {
  // TODO: log a warning naming the clicks that were not delivered
}

/** Hands the buffered batch to the producer; failures are reported through onDelivery. */
function sendBatch(): Promise<void> {
  linger = null;
  const batch = buffered.splice(0);
  if (batch.length === 0) return Promise.resolve();
  // TODO: producer.send the batch to TOPIC (acks: 1), .catch → onDelivery; track it in inflight
  throw new Error('not implemented');
}

export function recordClick(code: string, referrer: string | null, ua: string | null): void {
  const value = JSON.stringify({code, ts: Date.now() / 1000, referrer, ua});
  // TODO: buffer {key: code, value}; start the linger timer (sendBatch) if none runs; never wait here
  throw new Error('not implemented');
}

export async function shutdown(): Promise<void> {
  // TODO: cancel the linger, send what is buffered and await every in-flight delivery, then disconnect
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka, type Message} from 'kafkajs';

export const TOPIC = 'clicks';
const LINGER_MS = 5;

const kafka = new Kafka({clientId: 'shortener', brokers: ['kafka:9092']});
const producer = kafka.producer();
const ready = producer.connect();

/** Logger (provided). */
export const log = {
  warn(message: string): void {
    console.warn(message);
  },
};

const buffered: Message[] = [];
let linger: NodeJS.Timeout | null = null;
const inflight = new Set<Promise<void>>();

function onDelivery(err: Error, batch: Message[]): void {
  log.warn(\`\${batch.length} click(s) not delivered (\${batch.map(m => m.key).join(', ')}): \${err.message}\`);
}

/** Hands the buffered batch to the producer; failures are reported through onDelivery. */
function sendBatch(): Promise<void> {
  linger = null;
  const batch = buffered.splice(0);
  if (batch.length === 0) return Promise.resolve();
  const delivery = ready
    .then(() => producer.send({topic: TOPIC, messages: batch, acks: 1}))
    .then(() => undefined)
    .catch((err: Error) => onDelivery(err, batch))
    .finally(() => inflight.delete(delivery));
  inflight.add(delivery);
  return delivery;
}

export function recordClick(code: string, referrer: string | null, ua: string | null): void {
  const value = JSON.stringify({code, ts: Date.now() / 1000, referrer, ua});
  buffered.push({key: code, value});
  if (linger === null) linger = setTimeout(sendBatch, LINGER_MS); // the batch goes out in the background
}

export async function shutdown(): Promise<void> {
  if (linger !== null) clearTimeout(linger);
  await Promise.all([...inflight, sendBatch()]);
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

const topic = "clicks"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	// TODO: Async writes with a Completion callback that logs failures
}

type clickEvent struct {
	Code     string  \`json:"code"\`
	Ts       float64 \`json:"ts"\`
	Referrer string  \`json:"referrer"\`
	UA       string  \`json:"ua"\`
}

func recordClick(ctx context.Context, code, referrer, ua string) {
	value, _ := json.Marshal(clickEvent{Code: code, Ts: float64(time.Now().UnixMilli()) / 1000, Referrer: referrer, UA: ua})
	// TODO: WriteMessages with the code as Key; never block the redirect on the broker
	_ = value
	log.Println("not implemented")
}

func shutdown() {
	// TODO: close the writer so buffered clicks reach the broker
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

const topic = "clicks"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d clicks not delivered: %v", len(messages), err)
		}
	},
}

type clickEvent struct {
	Code     string  \`json:"code"\`
	Ts       float64 \`json:"ts"\`
	Referrer string  \`json:"referrer"\`
	UA       string  \`json:"ua"\`
}

func recordClick(ctx context.Context, code, referrer, ua string) {
	value, _ := json.Marshal(clickEvent{Code: code, Ts: float64(time.Now().UnixMilli()) / 1000, Referrer: referrer, UA: ua})
	// Async writer: this enqueues and returns; Completion reports the outcome.
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(code), Value: value})
}

func shutdown() {
	if err := writer.Close(); err != nil {
		log.Printf("closing clicks writer: %v", err)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

object ClickEvents {
  val Topic = "clicks"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def recordClick(code: String, referrer: String, ua: String): Unit = {
    val value = JsObject(
      "code" -> JsString(code),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0),
      "referrer" -> JsString(referrer),
      "ua" -> JsString(ua),
    ).compactPrint
    // TODO: send a record keyed by code with a Callback that logs failures; do not block on the future
  }

  def shutdown(): Unit = {
    // TODO: flush and close so buffered clicks reach the broker
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

object ClickEvents {
  val Topic = "clicks"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"click not delivered: \${exception.getMessage}")
  }

  def recordClick(code: String, referrer: String, ua: String): Unit = {
    val value = JsObject(
      "code" -> JsString(code),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0),
      "referrer" -> JsString(referrer),
      "ua" -> JsString(ua),
    ).compactPrint
    val record = new ProducerRecord[String, String](Topic, code, value)
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
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "clicks";

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

void record_click(const std::string& code, const std::string& referrer, const std::string& ua) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"code", code}, {"ts", ts}, {"referrer", referrer}, {"ua", ua}}.dump();
  // TODO: produce keyed by code (RK_MSG_COPY); poll(0) to serve callbacks; never block here
}

void shutdown() {
  // TODO: flush with a timeout so buffered clicks reach the broker
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "clicks";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR)
      std::cerr << "click not delivered: " << message.errstr() << "\\n";
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

void record_click(const std::string& code, const std::string& referrer, const std::string& ua) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"code", code}, {"ts", ts}, {"referrer", referrer}, {"ua", ua}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(value.data()), value.size(), code.c_str(), code.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

void shutdown() {
  if (producer->flush(5000) != RdKafka::ERR_NO_ERROR)
    std::cerr << producer->outq_len() << " clicks were not delivered\\n";
}
`,
    },
  },
  harness: {
    python: `import json
import logging


def _events(ctx):
    m = ctx.load("click_events")
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger().addHandler(handler)
    return m, records


def check_topic(ctx):
    m, _ = _events(ctx)
    m.record_click("g9Xc", "https://news.example/", "Mozilla/5.0")
    produced = ctx.kafka.records("clicks")
    assert len(produced) == 1, f"expected one record on clicks, found {len(produced)} (topics: {list(ctx.kafka.topics)})"
    event = json.loads(produced[0].value)
    assert event.get("code") == "g9Xc", f"the value must be JSON carrying the code: {event}"
    assert event.get("referrer") == "https://news.example/" and event.get("ua") == "Mozilla/5.0", f"the value must carry referrer and ua: {event}"
    assert "ts" in event, "the event must carry a timestamp"


def check_keyed(ctx):
    m, _ = _events(ctx)
    m.record_click("g9Xc", None, None)
    m.record_click("g9Xc", "https://other.example/", None)
    m.record_click("zz12", None, None)
    produced = ctx.kafka.records("clicks")
    assert [r.key for r in produced] == [b"g9Xc", b"g9Xc", b"zz12"], f"records must be keyed by the code, got {[r.key for r in produced]}"
    assert produced[0].partition == produced[1].partition, "the same code must land on the same partition"


def check_non_blocking(ctx):
    m, _ = _events(ctx)
    m.record_click("g9Xc", None, None)
    assert ctx.kafka.flushes == 0, "record_click must not flush: the redirect would wait for the broker"
    assert len(ctx.kafka.records("clicks")) == 1, "the click must still be handed to the producer"
    m.record_click("g9Xc", None, None)
    assert ctx.kafka.flushes == 0, "record_click must not flush: the redirect would wait for the broker"
    assert len(ctx.kafka.records("clicks")) == 2


def check_callback(ctx):
    m, records = _events(ctx)
    ctx.kafka.fail_next("clicks")
    m.record_click("g9Xc", None, None)  # the failure arrives through the delivery callback, not as an exception
    m.record_click("g9Xc", None, None)  # poll() on the next call serves the pending callback at the latest
    m.shutdown()
    warnings = [r for r in records if r.levelno >= logging.WARNING]
    assert warnings, "a failed delivery must be logged by the delivery callback"
    assert len(ctx.kafka.records("clicks")) == 1, "the second click must still be produced after the first one failed"


def check_flush(ctx):
    m, _ = _events(ctx)
    m.record_click("g9Xc", None, None)
    m.shutdown()
    assert ctx.kafka.flushes >= 1, "shutdown() must flush the producer"
`,
    typescript: `import {setTimeout as sleep} from 'node:timers/promises';

function events(ctx) {
  const m = ctx.load('click_events');
  const warnings: string[] = [];
  m.log.warn = (message: string) => {
    warnings.push(message);
  };
  return {m, warnings};
}

/** Let the producer's linger pass and its deliveries settle. */
async function settle(ctx) {
  ctx.clock.advance(1);
  await sleep(0);
}

export async function check_topic(ctx) {
  const {m} = events(ctx);
  m.recordClick('g9Xc', 'https://news.example/', 'Mozilla/5.0');
  await settle(ctx);
  const produced = ctx.kafka.records('clicks');
  assert.equal(produced.length, 1, \`expected one record on clicks, found \${produced.length} (topics: \${JSON.stringify([...ctx.kafka.topics.keys()])})\`);
  const event = JSON.parse(ctx.kafka.values('clicks')[0]);
  assert.equal(event.code, 'g9Xc', \`the value must be JSON carrying the code: \${JSON.stringify(event)}\`);
  assert(event.referrer === 'https://news.example/' && event.ua === 'Mozilla/5.0', \`the value must carry referrer and ua: \${JSON.stringify(event)}\`);
  assert('ts' in event, 'the event must carry a timestamp');
}

export async function check_keyed(ctx) {
  const {m} = events(ctx);
  m.recordClick('g9Xc', null, null);
  m.recordClick('g9Xc', 'https://other.example/', null);
  m.recordClick('zz12', null, null);
  await settle(ctx);
  const produced = ctx.kafka.records('clicks');
  assert.deepEqual(ctx.kafka.keys('clicks'), ['g9Xc', 'g9Xc', 'zz12'], \`records must be keyed by the code, got \${JSON.stringify(ctx.kafka.keys('clicks'))}\`);
  assert.equal(produced[0].partition, produced[1].partition, 'the same code must land on the same partition');
}

/** recordClick while the broker sits on its acknowledgements for 2 s: whatever it returns must not sit with it. */
async function clickWhileStalled(ctx, m) {
  ctx.kafka.stall('clicks', 2);
  const before = ctx.clock.now();
  const returned = m.recordClick('g9Xc', null, null);
  if (typeof returned?.then === 'function') await returned;
  const waited = ctx.clock.now() - before;
  assert(waited < 1000, \`recordClick took \${waited} ms while the broker was not acknowledging: the redirect would wait for the broker\`);
}

export async function check_non_blocking(ctx) {
  const {m} = events(ctx);
  await clickWhileStalled(ctx, m);
  await settle(ctx);
  assert.equal(ctx.kafka.records('clicks').length, 1, 'the click must still be handed to the producer');
  await clickWhileStalled(ctx, m);
  await settle(ctx);
  assert.equal(ctx.kafka.records('clicks').length, 2);
}

export async function check_callback(ctx) {
  const {m, warnings} = events(ctx);
  ctx.kafka.failNext('clicks');
  m.recordClick('g9Xc', null, null); // the failure arrives through the delivery callback, not as an exception
  await settle(ctx);
  m.recordClick('g9Xc', null, null);
  await m.shutdown();
  assert(warnings.length > 0, 'a failed delivery must be logged by the delivery callback');
  assert.equal(ctx.kafka.records('clicks').length, 1, 'the second click must still be produced after the first one failed');
}

export async function check_flush(ctx) {
  const {m} = events(ctx);
  m.recordClick('g9Xc', null, null);
  await m.shutdown();
  assert.equal(ctx.kafka.records('clicks').length, 1, 'shutdown() must flush the buffered clicks to the broker');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"sync"

	"leetbuild/harness"
)

// clickWarnings collects what the learner logs, still passing it on to the original output.
type clickWarnings struct {
	guard sync.Mutex
	lines []string
}

func (w *clickWarnings) Write(p []byte) (int, error) {
	w.guard.Lock()
	defer w.guard.Unlock()
	w.lines = append(w.lines, string(p))
	return len(p), nil
}

func (w *clickWarnings) count() int {
	w.guard.Lock()
	defer w.guard.Unlock()
	return len(w.lines)
}

func watchClickLog() *clickWarnings {
	w := &clickWarnings{}
	log.SetOutput(io.MultiWriter(log.Writer(), w))
	return w
}

// settleClicks lets the producer's linger pass and its deliveries settle.
func settleClicks(ctx *harness.Ctx) {
	ctx.Clock.Advance(1)
	ctx.Settle()
}

func CheckTopic(ctx *harness.Ctx) {
	recordClick(context.Background(), "g9Xc", "https://news.example/", "Mozilla/5.0")
	settleClicks(ctx)
	produced := ctx.Kafka.Records("clicks")
	ctx.Assert(len(produced) == 1, "expected one record on clicks, found %d (topics: %q)", len(produced), ctx.Kafka.Topics())
	var event map[string]any
	ctx.NoError(json.Unmarshal(produced[0].Value, &event), "the value must be JSON: %q", produced[0].Value)
	ctx.Equal(event["code"], "g9Xc", "the value must be JSON carrying the code (%s)", produced[0].Value)
	ctx.Assert(event["referrer"] == "https://news.example/" && event["ua"] == "Mozilla/5.0", "the value must carry referrer and ua: %s", produced[0].Value)
	_, hasTs := event["ts"]
	ctx.Assert(hasTs, "the event must carry a timestamp")
}

func CheckKeyed(ctx *harness.Ctx) {
	recordClick(context.Background(), "g9Xc", "", "")
	recordClick(context.Background(), "g9Xc", "https://other.example/", "")
	recordClick(context.Background(), "zz12", "", "")
	settleClicks(ctx)
	ctx.Equal(ctx.Kafka.Keys("clicks"), []string{"g9Xc", "g9Xc", "zz12"}, "records must be keyed by the code")
	produced := ctx.Kafka.Records("clicks")
	ctx.Equal(produced[0].Partition, produced[1].Partition, "the same code must land on the same partition")
}

// clickWhileStalled is recordClick while the broker sits on its acknowledgements for 2 s: it must not sit with it.
func clickWhileStalled(ctx *harness.Ctx) {
	ctx.Kafka.StallFor("clicks", 2)
	before := ctx.Clock.Now()
	recordClick(context.Background(), "g9Xc", "", "")
	waited := ctx.Clock.Now() - before
	ctx.Assert(waited < 1000, "recordClick took %d ms while the broker was not acknowledging: the redirect would wait for the broker", waited)
}

func CheckNonBlocking(ctx *harness.Ctx) {
	clickWhileStalled(ctx)
	settleClicks(ctx)
	ctx.Equal(len(ctx.Kafka.Records("clicks")), 1, "the click must still be handed to the producer")
	clickWhileStalled(ctx)
	settleClicks(ctx)
	ctx.Equal(len(ctx.Kafka.Records("clicks")), 2, "records on clicks after the second click")
}

func CheckCallback(ctx *harness.Ctx) {
	warnings := watchClickLog()
	ctx.Kafka.FailNext("clicks", 1)
	recordClick(context.Background(), "g9Xc", "", "") // the failure arrives through the Completion callback, not as an error
	settleClicks(ctx)
	recordClick(context.Background(), "g9Xc", "", "")
	shutdown()
	ctx.Assert(warnings.count() > 0, "a failed delivery must be logged by the Completion callback")
	ctx.Equal(len(ctx.Kafka.Records("clicks")), 1, "the second click must still be produced after the first one failed")
}

func CheckFlush(ctx *harness.Ctx) {
	recordClick(context.Background(), "g9Xc", "", "")
	shutdown()
	ctx.Equal(len(ctx.Kafka.Records("clicks")), 1, "shutdown() must flush the buffered clicks to the broker")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <mutex>
#include <streambuf>
#include <string>
#include <vector>

namespace {

// clickWarnings collects what the learner writes to std::cerr (Go: the log package's output), still
// passing it on to the original output, until it is destroyed.
class clickWarnings : public std::streambuf {
 public:
  clickWarnings() : previous_(std::cerr.rdbuf(this)) {}
  ~clickWarnings() override { std::cerr.rdbuf(previous_); }

  // How many bytes were written so far.
  int written() {
    std::lock_guard<std::mutex> lock(mu_);
    return static_cast<int>(text_.size());
  }

 protected:
  int overflow(int c) override {
    if (c == traits_type::eof()) return traits_type::not_eof(c);
    {
      std::lock_guard<std::mutex> lock(mu_);
      text_ += static_cast<char>(c);
    }
    return previous_->sputc(static_cast<char>(c));
  }
  std::streamsize xsputn(const char* s, std::streamsize n) override {
    {
      std::lock_guard<std::mutex> lock(mu_);
      text_.append(s, static_cast<size_t>(n));
    }
    return previous_->sputn(s, n);
  }
  int sync() override { return previous_->pubsync(); }

 private:
  std::streambuf* previous_;
  std::mutex mu_;
  std::string text_;
};

// settleClicks lets the producer's linger pass and its deliveries settle. librdkafka writes a record
// the broker sat on from its own threads once the broker answers; the model writes it at the
// producer's next call, so the harness makes one (poll(0)) once a 2 s stall is over (Go's Settle
// jumps the clock to the stall's end, where its producer goroutine waits).
void settleClicks(harness::Ctx& ctx) {
  ctx.Clock.Advance(2);
  ctx.Settle();
  producer->poll(0);
}

// clickWhileStalled is record_click while the broker sits on its acknowledgements for 2 s: it must not sit with it.
void clickWhileStalled(harness::Ctx& ctx) {
  ctx.Kafka.StallFor("clicks", 2);
  const int64_t before = ctx.Clock.Now();
  record_click("g9Xc", "", "");
  const int64_t waited = ctx.Clock.Now() - before;
  ctx.Assert(waited < 1000, "record_click took %d ms while the broker was not acknowledging: the redirect would wait for the broker", waited);
}

}  // namespace

void CheckTopic(harness::Ctx& ctx) {
  record_click("g9Xc", "https://news.example/", "Mozilla/5.0");
  settleClicks(ctx);
  const auto produced = ctx.Kafka.Records("clicks");
  ctx.Assert(produced.size() == 1, "expected one record on clicks, found %d (topics: %q)", produced.size(), ctx.Kafka.Topics());
  const std::string value = produced[0].Value.value_or("");
  const auto event = nlohmann::json::parse(value, nullptr, false);
  ctx.Assert(event.is_object(), "the value must be JSON: %q", value);
  const auto text = [&event](const char* key) {
    return event.contains(key) && event[key].is_string() ? event[key].get<std::string>() : std::string("<nil>");
  };
  ctx.Equal(text("code"), "g9Xc", "the value must be JSON carrying the code (%s)", value);
  ctx.Assert(text("referrer") == "https://news.example/" && text("ua") == "Mozilla/5.0", "the value must carry referrer and ua: %s", value);
  ctx.Assert(event.contains("ts"), "the event must carry a timestamp");
}

void CheckKeyed(harness::Ctx& ctx) {
  record_click("g9Xc", "", "");
  record_click("g9Xc", "https://other.example/", "");
  record_click("zz12", "", "");
  settleClicks(ctx);
  ctx.Equal(ctx.Kafka.Keys("clicks"), std::vector<std::string>{"g9Xc", "g9Xc", "zz12"}, "records must be keyed by the code");
  const auto produced = ctx.Kafka.Records("clicks");
  ctx.Equal(produced[0].Partition, produced[1].Partition, "the same code must land on the same partition");
}

void CheckNonBlocking(harness::Ctx& ctx) {
  clickWhileStalled(ctx);
  settleClicks(ctx);
  ctx.Equal(ctx.Kafka.Records("clicks").size(), 1, "the click must still be handed to the producer");
  clickWhileStalled(ctx);
  settleClicks(ctx);
  ctx.Equal(ctx.Kafka.Records("clicks").size(), 2, "records on clicks after the second click");
}

void CheckCallback(harness::Ctx& ctx) {
  clickWarnings warnings;
  ctx.Kafka.FailNext("clicks", 1);
  record_click("g9Xc", "", "");  // the failure arrives through the delivery report callback, not as an error
  settleClicks(ctx);
  record_click("g9Xc", "", "");
  shutdown();
  ctx.Assert(warnings.written() > 0, "a failed delivery must be logged by the delivery report callback");
  ctx.Equal(ctx.Kafka.Records("clicks").size(), 1, "the second click must still be produced after the first one failed");
}

void CheckFlush(harness::Ctx& ctx) {
  record_click("g9Xc", "", "");
  shutdown();
  ctx.Equal(ctx.Kafka.Records("clicks").size(), 1, "shutdown() must flush the buffered clicks to the broker");
}
`,
  },
  debrief: `A Kafka producer is a buffer with a background thread: \`produce\`/\`send\` costs microseconds, the network happens later in batches. That is what makes "one event per redirect" free — as long as nobody blocks on the acknowledgement. The key is the ordering and the partitioning contract at once: same code → same partition → the next step's consumer sees every click of a link in order, on one consumer. Real pipelines put the referrer through a domain allow-list before it reaches analytics, enrich the event with a geo lookup, and enable idempotent producers so their own retries cannot double-count a click.`,
};
