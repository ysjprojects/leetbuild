import type {Step} from '@/lib/types';

// ---- 4. Audit stream to Kafka ----------------------------------------------------------------------
export const auditStreamStep: Step = {
  id: 'audit-stream',
  title: 'An audit record per request that never blocks',
  concept: 'kafka',
  file: 'audit_log',
  focus: ['gateway', 'kafka', 'audit'],
  task: `## Task

Security wants every request on record. Implement \`audit(api_key, path, status, latency_ms)\`, called
**after** the response has been written:

- Produce \`{"api_key", "path", "status", "latency_ms", "ts"}\` to topic **\`gateway-audit\`**, keyed by
  the **API key** so one caller's history is ordered on one partition.
- Hand the record to the producer and **return**: the request thread never waits for a broker.
- The producer's local queue is **bounded**. When it is full (the broker is slow or down), **drop** the
  record and increment a \`dropped\` counter — do not block, do not fail the request.

:::widget kafka-partitions {"partitions": 6}

> Every client library has a "queue full" signal: confluent-kafka raises \`BufferError\`, kafka-go lets you
> put a bounded channel in front of the writer, the Java producer throws \`BufferExhaustedException\` when
> \`max.block.ms=0\`, librdkafka returns \`ERR__QUEUE_FULL\`. The gateway's job is to *handle* it, not to wait.`,
  sequence: {
    participants: ['gateway', 'Producer', 'Kafka'],
    messages: [
      {from: 'gateway', to: 'gateway', label: 'response written · latency 12 ms', kind: 'sync'},
      {from: 'gateway', to: 'Producer', label: 'produce(gateway-audit, key=k1, {…})', kind: 'async'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(k1) % 6', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack', kind: 'reply'},
      {from: 'gateway', to: 'Producer', label: 'produce(…) while the queue is full', kind: 'async'},
      {from: 'Producer', to: 'gateway', label: 'queue full → dropped += 1', kind: 'reply'},
    ],
  },
  hints: [
    'Two things are bounded here: how long `audit` may take (zero network) and how much memory the producer may hold (the queue). Configure the second, then handle what happens when it is hit.',
    'Bound the queue in the producer config (`queue.buffering.max.messages`, `buffer.memory` + `max.block.ms=0`) or with a buffered channel of fixed size in front of the writer; the full-queue outcome then becomes an exception, an error code, or a `select` `default` branch.',
    'The drop path is one line: catch/inspect the full-queue signal, `dropped += 1`, move on. Keep serving delivery callbacks with `poll(0)` (or a background goroutine draining the channel) so acknowledged records leave the queue.',
  ],
  checks: [
    {
      id: 'topic-key',
      title: 'Produces to gateway-audit keyed by API key',
      detail:
        'Records go to `gateway-audit` with the API key as the record key, so one caller’s audit trail is ordered on one partition.',
      match: {
        python: {
          all: [/gateway-audit/, /producer\.produce\(\s*(TOPIC|"gateway-audit")\s*,[\s\S]{0,200}?key\s*=\s*api_key/],
        },
        typescript: {all: [/gateway-audit/, /\.send\(\s*\{[\s\S]{0,200}?key:\s*apiKey/]},
        go: {all: [/gateway-audit/, /Key:\s*\[\]byte\(\s*apiKey\s*\)/]},
        scala: {all: [/gateway-audit/, /new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"gateway-audit")\s*,\s*apiKey\s*,/]},
        cpp: {
          all: [
            /gateway-audit/,
            /producer->produce\(\s*(kTopic|"gateway-audit")\s*,[\s\S]{0,400}?api_key\.c_str\(\)\s*,\s*api_key\.(size|length)\(\)/,
          ],
        },
      },
    },
    {
      id: 'bounded-queue',
      title: 'The local queue is bounded',
      detail:
        'A producer buffer without a bound turns a slow broker into an out-of-memory gateway; set `queue.buffering.max.messages`, `max.block.ms=0`, or a fixed-size channel.',
      match: {
        python: {all: [/["']queue\.buffering\.max\.messages["']\s*:/]},
        typescript: {all: [/QUEUE_MAX/, /inflight\s*>=\s*QUEUE_MAX|QUEUE_MAX\s*<=\s*inflight/]},
        go: {all: [/make\(\s*chan kafka\.Message\s*,\s*(queueSize|\d+)\s*\)/]},
        scala: {all: [/"max\.block\.ms"\s*,\s*"0"/]},
        cpp: {all: [/"queue\.buffering\.max\.messages"/]},
      },
    },
    {
      id: 'drop-on-full',
      title: 'Drops and counts when the queue is full',
      detail:
        'The full-queue signal must be handled by incrementing `dropped` — not by retrying, sleeping or raising into the request.',
      match: {
        python: {all: [/except BufferError/, /dropped\s*\+=\s*1/]},
        typescript: {all: [/dropped\s*(\+=\s*1|\+\+)/, /inflight\s*-=\s*1|inflight--/]},
        go: {all: [/select\s*\{[\s\S]{0,300}?default:/, /dropped\.Add\(\s*1\s*\)/]},
        scala: {all: [/case _: (BufferExhaustedException|TimeoutException)/, /dropped\.incrementAndGet\(\)/]},
        cpp: {all: [/ERR__QUEUE_FULL/, /\+\+dropped|dropped\+\+|dropped\.fetch_add\(/]},
      },
    },
    {
      id: 'non-blocking',
      title: 'Never waits for the broker in audit()',
      detail:
        '`audit` enqueues and returns; no `flush`, no blocking `get()` on the send future, no synchronous `WriteMessages` on the request path.',
      match: {
        python: {all: [/producer\.poll\(\s*0\s*\)/], none: [/def audit(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        typescript: {all: [/producer\s*\.send\(/], none: [/await\s+producer\s*\.send\(/]},
        go: {all: [/case queue <- /], none: [/func audit(?:(?!\n\})[\s\S])*?WriteMessages\(/]},
        scala: {all: [/producer\.send\([\s\S]{0,200}?onDelivery\s*\)/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void audit(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "gateway-audit"
log = logging.getLogger("audit")

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "1",
    "linger.ms": 20,
    # TODO: bound the local queue (queue.buffering.max.messages) so produce() raises BufferError when full
})
dropped = 0  # exported as gateway_audit_dropped_total


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("audit record not delivered: %s", err)


def audit(api_key: str, path: str, status: int, latency_ms: float) -> None:
    """Called after the response is written; must never slow down or fail the request."""
    value = json.dumps({"api_key": api_key, "path": path, "status": status, "latency_ms": round(latency_ms, 1), "ts": time.time()})
    # TODO: produce keyed by api_key with on_delivery; BufferError → dropped += 1; poll(0); never block
    raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "gateway-audit"
log = logging.getLogger("audit")

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "1",
    "linger.ms": 20,
    "queue.buffering.max.messages": 10000,  # past this, produce() raises BufferError instead of growing
})
dropped = 0  # exported as gateway_audit_dropped_total


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("audit record not delivered: %s", err)


def audit(api_key: str, path: str, status: int, latency_ms: float) -> None:
    """Called after the response is written; must never slow down or fail the request."""
    global dropped
    value = json.dumps({"api_key": api_key, "path": path, "status": status, "latency_ms": round(latency_ms, 1), "ts": time.time()})
    try:
        producer.produce(TOPIC, key=api_key, value=value, on_delivery=on_delivery)
    except BufferError:
        dropped += 1  # the broker is behind: lose one audit line, not the request
    producer.poll(0)  # serve delivery callbacks; returns immediately
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'gateway-audit';
/** Records handed to the producer and not yet acknowledged: past this, audit() drops. */
export const QUEUE_MAX = 1000;

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export let dropped = 0; // exported as gateway_audit_dropped_total
let inflight = 0;

/** Called after the response is written; must never slow down or fail the request. */
export function audit(apiKey: string, path: string, status: number, latencyMs: number): void {
  const value = JSON.stringify({api_key: apiKey, path, status, latency_ms: Math.round(latencyMs * 10) / 10, ts: Date.now() / 1000});
  // TODO: inflight >= QUEUE_MAX → dropped += 1 and return; the broker is behind, the request is not
  // TODO: otherwise inflight += 1 and producer.send to TOPIC keyed by apiKey with acks: 1 — never awaited:
  //       log a failed delivery, and release the slot (inflight -= 1) when the send settles
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

export const TOPIC = 'gateway-audit';
/** Records handed to the producer and not yet acknowledged: past this, audit() drops. */
export const QUEUE_MAX = 1000;

const kafka = new Kafka({clientId: 'gateway', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export let dropped = 0; // exported as gateway_audit_dropped_total
let inflight = 0;

/** Called after the response is written; must never slow down or fail the request. */
export function audit(apiKey: string, path: string, status: number, latencyMs: number): void {
  const value = JSON.stringify({api_key: apiKey, path, status, latency_ms: Math.round(latencyMs * 10) / 10, ts: Date.now() / 1000});
  if (inflight >= QUEUE_MAX) {
    dropped += 1; // the broker is behind: lose one audit line, not the request
    return;
  }
  inflight += 1;
  producer
    .send({topic: TOPIC, messages: [{key: apiKey, value}], acks: 1})
    .catch((err: Error) => console.warn(\`audit record not delivered: \${err.message}\`))
    .finally(() => {
      inflight -= 1;
    });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic     = "gateway-audit"
	queueSize = 1000
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var (
	queue   chan kafka.Message // TODO: buffered with queueSize — a slow broker fills it, it never grows
	dropped atomic.Int64       // exported as gateway_audit_dropped_total
)

type auditRecord struct {
	APIKey    string  \`json:"api_key"\`
	Path      string  \`json:"path"\`
	Status    int     \`json:"status"\`
	LatencyMs float64 \`json:"latency_ms"\`
	Ts        float64 \`json:"ts"\`
}

// audit is called after the response is written; it must never block the request.
func audit(apiKey, path string, status int, latency time.Duration) {
	value, _ := json.Marshal(auditRecord{APIKey: apiKey, Path: path, Status: status, LatencyMs: math.Round(float64(latency.Microseconds())/100) / 10, Ts: float64(time.Now().UnixMilli()) / 1000})
	// TODO: non-blocking send into queue keyed by apiKey; when full, dropped.Add(1) instead of waiting
	_ = value
}

// pump drains the queue in batches on its own goroutine; started once at boot.
func pump(ctx context.Context) {
	batch := make([]kafka.Message, 0, 100)
	for m := range queue {
		batch = append(batch[:0], m)
	drain:
		for len(batch) < cap(batch) {
			select {
			case m := <-queue:
				batch = append(batch, m)
			default:
				break drain
			}
		}
		if err := writer.WriteMessages(ctx, batch...); err != nil {
			log.Printf("%d audit records not delivered: %v", len(batch), err)
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic     = "gateway-audit"
	queueSize = 1000
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var (
	queue   = make(chan kafka.Message, queueSize) // bounded: a slow broker fills it, it never grows
	dropped atomic.Int64                          // exported as gateway_audit_dropped_total
)

type auditRecord struct {
	APIKey    string  \`json:"api_key"\`
	Path      string  \`json:"path"\`
	Status    int     \`json:"status"\`
	LatencyMs float64 \`json:"latency_ms"\`
	Ts        float64 \`json:"ts"\`
}

// audit is called after the response is written; it must never block the request.
func audit(apiKey, path string, status int, latency time.Duration) {
	value, _ := json.Marshal(auditRecord{APIKey: apiKey, Path: path, Status: status, LatencyMs: math.Round(float64(latency.Microseconds())/100) / 10, Ts: float64(time.Now().UnixMilli()) / 1000})
	select {
	case queue <- kafka.Message{Key: []byte(apiKey), Value: value}:
	default:
		dropped.Add(1) // the queue is full: lose one audit line, not the request
	}
}

// pump drains the queue in batches on its own goroutine; started once at boot.
func pump(ctx context.Context) {
	batch := make([]kafka.Message, 0, 100)
	for m := range queue {
		batch = append(batch[:0], m)
	drain:
		for len(batch) < cap(batch) {
			select {
			case m := <-queue:
				batch = append(batch, m)
			default:
				break drain
			}
		}
		if err := writer.WriteMessages(ctx, batch...); err != nil {
			log.Printf("%d audit records not delivered: %v", len(batch), err)
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.atomic.AtomicLong

import org.apache.kafka.clients.producer.{BufferExhaustedException, Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.errors.TimeoutException
import org.apache.kafka.common.serialization.StringSerializer

object AuditLog {
  val Topic = "gateway-audit"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "20")
  props.put("buffer.memory", "8388608")
  // TODO: max.block.ms = 0 so a full buffer throws instead of parking the request thread
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val dropped = new AtomicLong() // exported as gateway_audit_dropped_total

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"audit record not delivered: \${exception.getMessage}")
  }

  /** Called after the response is written; must never slow down or fail the request. */
  def audit(apiKey: String, path: String, status: Int, latencyMs: Double): Unit = {
    val value = s"""{"api_key":"$apiKey","path":"$path","status":$status,"latency_ms":$latencyMs,"ts":\${System.currentTimeMillis() / 1000.0}}"""
    // TODO: send a record keyed by apiKey with onDelivery; BufferExhausted/Timeout → dropped.incrementAndGet(); never block
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.atomic.AtomicLong

import org.apache.kafka.clients.producer.{BufferExhaustedException, Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.errors.TimeoutException
import org.apache.kafka.common.serialization.StringSerializer

object AuditLog {
  val Topic = "gateway-audit"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "20")
  props.put("buffer.memory", "8388608")
  props.put("max.block.ms", "0") // a full buffer throws instead of parking the request thread
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val dropped = new AtomicLong() // exported as gateway_audit_dropped_total

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"audit record not delivered: \${exception.getMessage}")
  }

  /** Called after the response is written; must never slow down or fail the request. */
  def audit(apiKey: String, path: String, status: Int, latencyMs: Double): Unit = {
    val value = s"""{"api_key":"$apiKey","path":"$path","status":$status,"latency_ms":$latencyMs,"ts":\${System.currentTimeMillis() / 1000.0}}"""
    val record = new ProducerRecord[String, String](Topic, apiKey, value)
    try producer.send(record, onDelivery) // enqueues; the future is not awaited
    catch {
      // BufferExhaustedException extends TimeoutException: the buffer is full (or metadata is not
      // there yet within max.block.ms = 0). Lose one audit line, not the request.
      case _: BufferExhaustedException | _: TimeoutException => dropped.incrementAndGet()
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <atomic>
#include <cmath>
#include <chrono>
#include <iostream>
#include <memory>
#include <string>

const std::string kTopic = "gateway-audit";
std::atomic<long> dropped{0};  // exported as gateway_audit_dropped_total

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "audit record not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "20", err);
  // TODO: bound the local queue (queue.buffering.max.messages) so produce() returns ERR__QUEUE_FULL
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Called after the response is written; must never slow down or fail the request.
void audit(const std::string& api_key, const std::string& path, int status, double latency_ms) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"api_key\\":\\"" + api_key + "\\",\\"path\\":\\"" + path + "\\",\\"status\\":" + std::to_string(status) +
                      ",\\"latency_ms\\":" + std::to_string(std::round(latency_ms * 10) / 10) + ",\\"ts\\":" + std::to_string(ts) + "}";
  // TODO: poll(0) first (serve delivery callbacks); produce keyed by api_key (RK_MSG_COPY); ERR__QUEUE_FULL → ++dropped; never block
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <atomic>
#include <cmath>
#include <chrono>
#include <iostream>
#include <memory>
#include <string>

const std::string kTopic = "gateway-audit";
std::atomic<long> dropped{0};  // exported as gateway_audit_dropped_total

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "audit record not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "20", err);
  conf->set("queue.buffering.max.messages", "10000", err);  // past this, produce() returns ERR__QUEUE_FULL
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Called after the response is written; must never slow down or fail the request.
void audit(const std::string& api_key, const std::string& path, int status, double latency_ms) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string value = "{\\"api_key\\":\\"" + api_key + "\\",\\"path\\":\\"" + path + "\\",\\"status\\":" + std::to_string(status) +
                      ",\\"latency_ms\\":" + std::to_string(std::round(latency_ms * 10) / 10) + ",\\"ts\\":" + std::to_string(ts) + "}";
  producer->poll(0);  // serve delivery callbacks first, so acknowledged records leave the queue; returns immediately
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   value.data(), value.size(), api_key.c_str(), api_key.size(), 0, nullptr);
  if (err == RdKafka::ERR__QUEUE_FULL) {
    ++dropped;  // the broker is behind: lose one audit line, not the request
  } else if (err != RdKafka::ERR_NO_ERROR) {
    std::cerr << "audit produce failed: " << RdKafka::err2str(err) << "\\n";
  }
}
`,
    },
  },
  harness: {
    python: `import json


def check_topic_key(ctx):
    m = ctx.load("audit_log")
    m.audit("k1", "/items/42", 200, 12.34)
    m.audit("k2", "/items/7", 404, 3.0)
    m.audit("k1", "/items/9", 200, 1.0)
    records = ctx.kafka.records("gateway-audit")
    assert len(records) == 3, f"three audit() calls produced {len(records)} records on gateway-audit (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"k1", b"k2", b"k1"], f"records must be keyed by the API key, got {keys}"
    assert records[0].partition == records[2].partition, "the same API key must land on the same partition so one caller's trail stays ordered"
    first = json.loads(records[0].value)
    assert first.get("api_key") == "k1" and first.get("path") == "/items/42" and first.get("status") == 200, f"the value must be JSON with api_key, path, status, latency_ms, ts: {first}"
    assert first.get("latency_ms") == 12.3, f"latency_ms is {first.get('latency_ms')!r}, expected 12.3"
    assert "ts" in first, f"the record carries no ts: {first}"


def check_bounded_queue(ctx):
    m = ctx.load("audit_log")
    # the in-memory producer never fills up, so the bound is read from the producer's configuration
    bound = m.producer.conf.get("queue.buffering.max.messages")
    assert bound is not None, f"the producer is configured with {sorted(m.producer.conf)}: without queue.buffering.max.messages a slow broker grows the queue until the gateway runs out of memory"
    assert int(bound) > 0, f"queue.buffering.max.messages is {bound!r}, expected a positive bound"


def check_drop_on_full(ctx):
    m = ctx.load("audit_log")
    real_produce = m.producer.produce

    def queue_full(*args, **kwargs):
        raise BufferError("Local: Queue full")

    m.producer.produce = queue_full
    for _ in range(3):
        m.audit("k1", "/items/42", 200, 1.0)  # must neither raise nor wait
    assert ctx.kafka.records("gateway-audit") == [], "nothing can be produced while the queue is full"
    assert m.dropped == 3, f"dropped is {m.dropped!r} after three refused records, expected 3"
    assert ctx.clock.sleeps == 0, "a full queue must be handled by dropping, not by sleeping and retrying"
    m.producer.produce = real_produce
    m.audit("k1", "/items/42", 200, 1.0)
    assert len(ctx.kafka.records("gateway-audit")) == 1, "once the queue has room, audit records flow again"
    assert m.dropped == 3, f"dropped is {m.dropped!r} after a successful produce, expected to stay at 3"


def check_non_blocking(ctx):
    m = ctx.load("audit_log")
    for i in range(3):
        m.audit("k1", f"/items/{i}", 200, 1.0)
    assert len(ctx.kafka.records("gateway-audit")) == 3, f"three audit() calls produced {len(ctx.kafka.records('gateway-audit'))} records"
    assert ctx.kafka.flushes == 0, "audit() must not flush: the request would wait for the broker's acknowledgement"
    assert ctx.clock.sleeps == 0, "audit() must not sleep or wait"
    pending = len(m.producer)
    assert pending <= 1, f"after three audit() calls the producer still holds {pending} unserved delivery callbacks: call producer.poll(0) so acknowledged records leave the queue"
`,
    typescript: `const TOPIC = 'gateway-audit';

/** A real macrotask: every pending promise continuation has run (no learner timer is pending here). */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** The producer's bound, as the module declares it. */
function bound(m): number {
  const max = m.QUEUE_MAX;
  assert(Number.isInteger(max) && max > 0, \`QUEUE_MAX is \${JSON.stringify(max)}, expected a positive bound on the records in flight\`);
  assert(max <= 5000, \`QUEUE_MAX is \${max}: a bound that large is no bound for a gateway, keep it at 1000 or below\`);
  return max;
}

export async function check_topic_key(ctx) {
  const m = ctx.load('audit_log');
  m.audit('k1', '/items/42', 200, 12.34);
  m.audit('k2', '/items/7', 404, 3.0);
  m.audit('k1', '/items/9', 200, 1.0);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three audit() calls produced \${records.length} records on gateway-audit\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['k1', 'k2', 'k1'], \`records must be keyed by the API key, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[2].partition, "the same API key must land on the same partition so one caller's trail stays ordered");
  const first = JSON.parse(records[0].value.toString());
  assert(first.api_key === 'k1' && first.path === '/items/42' && first.status === 200, \`the value must be JSON with api_key, path, status, latency_ms, ts: \${records[0].value.toString()}\`);
  assert.strictEqual(first.latency_ms, 12.3, \`latency_ms is \${JSON.stringify(first.latency_ms)}, expected 12.3\`);
  assert('ts' in first, \`the record carries no ts: \${records[0].value.toString()}\`);
}

export async function check_bounded_queue(ctx) {
  const m = ctx.load('audit_log');
  const max = bound(m);
  ctx.kafka.stall(TOPIC); // the broker stops acknowledging: nothing handed to the producer leaves the queue
  for (let i = 0; i < max; i += 1) m.audit('k1', \`/items/\${i}\`, 200, 1.0);
  assert.equal(m.dropped, 0, \`\${m.dropped} record(s) were dropped before the queue reached its bound of \${max}\`);
  for (let i = 0; i < 3; i += 1) m.audit('k1', '/items/42', 200, 1.0);
  assert(m.dropped > 0, \`\${max + 3} audit() calls on a stalled broker and nothing was dropped: the queue is unbounded, a slow broker grows it until the gateway runs out of memory\`);
  assert.equal(m.dropped, 3, \`dropped is \${m.dropped} after \${max + 3} records on a stalled broker with a bound of \${max}, expected 3\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing can reach the topic while the broker is stalled');
}

export async function check_drop_on_full(ctx) {
  const m = ctx.load('audit_log');
  const max = bound(m);
  ctx.kafka.stall(TOPIC);
  for (let i = 0; i < max; i += 1) m.audit('k1', \`/items/\${i}\`, 200, 1.0); // the queue is now full
  for (let i = 0; i < 3; i += 1) {
    try {
      await m.audit('k1', '/items/42', 200, 1.0); // must neither throw nor wait
    } catch (e) {
      assert.fail(\`audit() failed the request when the queue was full: \${e}. Drop the record and count it instead\`);
    }
  }
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing can be produced while the queue is full');
  assert.equal(m.dropped, 3, \`dropped is \${m.dropped} after three refused records, expected 3\`);
  assert.equal(ctx.clock.sleeps, 0, 'a full queue must be handled by dropping, not by sleeping and retrying');
  ctx.kafka.resume(TOPIC);
  ctx.clock.advance(31); // the broker is back: the queued records are acknowledged
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, max, \`once the broker answers again the \${max} queued records must be delivered, the topic holds \${ctx.kafka.records(TOPIC).length}\`);
  m.audit('k1', '/items/after', 200, 1.0);
  await settle();
  const last = ctx.kafka.values(TOPIC).at(-1) ?? '';
  assert(last.includes('/items/after'), 'once the queue has room, audit records flow again');
  assert.equal(m.dropped, 3, \`dropped is \${m.dropped} after a successful produce, expected to stay at 3\`);
}

export async function check_non_blocking(ctx) {
  const m = ctx.load('audit_log');
  for (let i = 0; i < 3; i += 1) m.audit('k1', \`/items/\${i}\`, 200, 1.0);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 3, \`three audit() calls produced \${ctx.kafka.records(TOPIC).length} records\`);
  assert.equal(ctx.clock.sleeps, 0, 'audit() must not sleep or wait');
  ctx.kafka.stall(TOPIC); // the broker stops answering: the request must not notice
  const before = ctx.clock.now();
  try {
    await m.audit('k1', '/items/slow', 200, 1.0);
  } catch (e) {
    assert.fail(\`audit() failed the request because the broker was slow: \${e}. Hand the record to the producer and return\`);
  }
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited < 1 && ctx.clock.sleeps === 0, \`audit() waited \${waited.toFixed(1)} s for a stalled broker's acknowledgement: the request thread never waits for a broker, hand the record to the producer and return\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"leetbuild/harness"
)

const auditTopic = "gateway-audit"

// auditBoot starts the pump as the gateway does at boot, and lets it reach its first wait.
func auditBoot(ctx *harness.Ctx) {
	go pump(context.Background())
	ctx.Settle()
}

// auditBound is the producer's bound: the queue's capacity.
func auditBound(ctx *harness.Ctx) int {
	max := cap(queue)
	ctx.Assert(max > 0, "cap(queue) is %d, expected a positive bound on the records in flight", max)
	ctx.Assert(max <= 5000, "cap(queue) is %d: a bound that large is no bound for a gateway, keep it at 1000 or below", max)
	return max
}

// auditMustReturn calls audit and fails the check with why when it panics.
func auditMustReturn(ctx *harness.Ctx, why, path string) {
	defer func() {
		if e := recover(); e != nil {
			ctx.Fatalf("audit() failed the request %s: %v", why, e)
		}
	}()
	audit("k1", path, 200, time.Millisecond)
}

func CheckTopicKey(ctx *harness.Ctx) {
	auditBoot(ctx)
	audit("k1", "/items/42", 200, 12340*time.Microsecond)
	audit("k2", "/items/7", 404, 3*time.Millisecond)
	audit("k1", "/items/9", 200, time.Millisecond)
	ctx.Settle()
	records := ctx.Kafka.Records(auditTopic)
	ctx.Equal(len(records), 3, "three audit() calls must produce three records on gateway-audit; the records")
	ctx.Equal(ctx.Kafka.Keys(auditTopic), []string{"k1", "k2", "k1"}, "records must be keyed by the API key")
	ctx.Equal(records[0].Partition, records[2].Partition, "the same API key must land on the same partition so one caller's trail stays ordered; k1's partitions")
	var first map[string]any
	err := json.Unmarshal(records[0].Value, &first)
	ctx.Assert(err == nil && first["api_key"] == "k1" && first["path"] == "/items/42" && fmt.Sprint(first["status"]) == "200", "the value must be JSON with api_key, path, status, latency_ms, ts: %s", records[0].Value)
	ctx.Equal(first["latency_ms"], 12.3, "latency_ms")
	_, hasTS := first["ts"]
	ctx.Assert(hasTS, "the record carries no ts: %s", records[0].Value)
}

func CheckBoundedQueue(ctx *harness.Ctx) {
	max := auditBound(ctx)
	// the broker stops acknowledging and the pump is not running: nothing handed over leaves the queue
	ctx.Kafka.Stall(auditTopic)
	for i := range max {
		audit("k1", fmt.Sprintf("/items/%d", i), 200, time.Millisecond)
	}
	ctx.Equal(dropped.Load(), 0, "records dropped before the queue reached its bound of %d", max)
	for range 3 {
		audit("k1", "/items/42", 200, time.Millisecond)
	}
	ctx.Assert(dropped.Load() > 0, "%d audit() calls on a stalled broker and nothing was dropped: the queue is unbounded, a slow broker grows it until the gateway runs out of memory", max+3)
	ctx.Equal(dropped.Load(), 3, "dropped after %d records on a stalled broker with a bound of %d", max+3, max)
	ctx.Equal(len(ctx.Kafka.Records(auditTopic)), 0, "nothing can reach the topic while the broker is stalled; the records")
}

func CheckDropOnFull(ctx *harness.Ctx) {
	max := auditBound(ctx)
	// the broker stops acknowledging and the pump is not running: nothing handed over leaves the queue
	ctx.Kafka.Stall(auditTopic)
	for i := range max {
		audit("k1", fmt.Sprintf("/items/%d", i), 200, time.Millisecond) // the queue is now full
	}
	for range 3 {
		auditMustReturn(ctx, "when the queue was full (drop the record and count it instead)", "/items/42") // must neither panic nor wait
	}
	ctx.Equal(len(ctx.Kafka.Records(auditTopic)), 0, "nothing can be produced while the queue is full; the records")
	ctx.Equal(dropped.Load(), 3, "dropped after three refused records")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a full queue must be handled by dropping, not by sleeping and retrying; the sleeps")
	ctx.Kafka.Resume(auditTopic)
	auditBoot(ctx)
	ctx.Clock.Advance(31) // the broker is back: the queued records are acknowledged
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(auditTopic)), max, "once the broker answers again the %d queued records must be delivered; the records on the topic", max)
	audit("k1", "/items/after", 200, time.Millisecond)
	ctx.Settle()
	values := ctx.Kafka.Values(auditTopic)
	ctx.Assert(len(values) > 0 && strings.Contains(values[len(values)-1], "/items/after"), "once the queue has room, audit records flow again")
	ctx.Equal(dropped.Load(), 3, "dropped after a successful produce must stay at 3")
}

func CheckNonBlocking(ctx *harness.Ctx) {
	auditBoot(ctx)
	for i := range 3 {
		audit("k1", fmt.Sprintf("/items/%d", i), 200, time.Millisecond)
	}
	// the pump's writer may wait out its BatchTimeout once audit() returned: only audit()'s own sleeps count
	sleeps := ctx.Clock.Sleeps()
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(auditTopic)), 3, "three audit() calls must produce three records; the records")
	ctx.Equal(sleeps, 0, "audit() must not sleep or wait; the sleeps")
	ctx.Kafka.Stall(auditTopic) // the broker stops answering: the request must not notice
	before, sleeps := ctx.Clock.Now(), ctx.Clock.Sleeps()
	auditMustReturn(ctx, "because the broker was slow (hand the record to the producer and return)", "/items/slow")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited < 1 && ctx.Clock.Sleeps() == sleeps, "audit() waited %.1f s for a stalled broker's acknowledgement: the request thread never waits for a broker, hand the record to the producer and return", waited)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <string>

namespace {

const std::string kAuditTopic = "gateway-audit";

// Go reads its queue's bound as cap(queue); librdkafka keeps queue.buffering.max.messages to itself,
// so the bound is found as the broker stalls: audit until produce() first refuses a record (that
// record is the first drop). The default bound (100000) counts as no bound.
int auditFill(harness::Ctx& ctx) {
  constexpr int kLimit = 20000;
  int accepted = 0;
  while (dropped.load() == 0 && accepted < kLimit) {
    audit("k1", "/items/" + std::to_string(accepted), 200, 1.0);
    if (dropped.load() == 0) accepted++;
  }
  ctx.Assert(dropped.load() > 0,
             "%d audit() calls on a stalled broker and nothing was dropped: the queue is unbounded, a slow broker grows "
             "it until the gateway runs out of memory",
             accepted);
  ctx.Assert(accepted > 0, "the first record on a stalled broker was dropped: expected a positive bound on the records in flight");
  return accepted;
}

// audit, failing the check with why when it throws.
void auditMustReturn(harness::Ctx& ctx, const std::string& why, const std::string& path) {
  try {
    audit("k1", path, 200, 1.0);
  } catch (const std::exception& e) {
    ctx.Fatalf("audit() failed the request %s: %s", why, e.what());
  }
}

}  // namespace

void CheckTopicKey(harness::Ctx& ctx) {
  audit("k1", "/items/42", 200, 12.34);
  audit("k2", "/items/7", 404, 3.0);
  audit("k1", "/items/9", 200, 1.0);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kAuditTopic);
  ctx.Equal(records.size(), 3, "three audit() calls must produce three records on gateway-audit; the records");
  ctx.Equal(ctx.Kafka.Keys(kAuditTopic), {"k1", "k2", "k1"}, "records must be keyed by the API key");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "the same API key must land on the same partition so one caller's trail stays ordered; k1's partitions");
  nlohmann::json first;
  try {
    first = nlohmann::json::parse(records[0].Value.value_or(""));
  } catch (const std::exception&) {
  }
  ctx.Assert(first.is_object() && first.value("api_key", "") == "k1" && first.value("path", "") == "/items/42" &&
                 first.contains("status") && first["status"] == 200,
             "the value must be JSON with api_key, path, status, latency_ms, ts: %s", records[0].Value.value_or(""));
  ctx.Assert(first.contains("latency_ms") && first["latency_ms"].is_number() && first["latency_ms"].get<double>() == 12.3,
             "latency_ms is %s, expected 12.3", first.value("latency_ms", nlohmann::json()).dump());
  ctx.Assert(first.contains("ts"), "the record carries no ts: %s", records[0].Value.value_or(""));
}

void CheckBoundedQueue(harness::Ctx& ctx) {
  // the broker stops acknowledging: nothing handed to the producer leaves its queue
  ctx.Kafka.Stall(kAuditTopic);
  const int max = auditFill(ctx);
  for (int i = 0; i < 2; i++) audit("k1", "/items/42", 200, 1.0);
  ctx.Equal(dropped.load(), 3, "dropped after %d records on a stalled broker with a bound of %d", max + 3, max);
  ctx.Equal(ctx.Kafka.Records(kAuditTopic).size(), 0, "nothing can reach the topic while the broker is stalled; the records");
}

void CheckDropOnFull(harness::Ctx& ctx) {
  ctx.Kafka.Stall(kAuditTopic);
  const int max = auditFill(ctx);  // the queue is now full, one record refused
  for (int i = 0; i < 2; i++) {
    auditMustReturn(ctx, "when the queue was full (drop the record and count it instead)", "/items/42");
  }
  ctx.Equal(ctx.Kafka.Records(kAuditTopic).size(), 0, "nothing can be produced while the queue is full; the records");
  ctx.Equal(dropped.load(), 3, "dropped after three refused records");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a full queue must be handled by dropping, not by sleeping and retrying; the sleeps");
  ctx.Kafka.Resume(kAuditTopic);
  ctx.Clock.Advance(31);  // the broker is back: the queued records are acknowledged
  ctx.Settle();
  ctx.Equal(static_cast<int>(ctx.Kafka.Records(kAuditTopic).size()), max,
            "once the broker answers again the %d queued records must be delivered; the records on the topic", max);
  audit("k1", "/items/after", 200, 1.0);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kAuditTopic);
  ctx.Assert(!values.empty() && values.back().find("/items/after") != std::string::npos,
             "once the queue has room, audit records flow again");
  ctx.Equal(dropped.load(), 3, "dropped after a successful produce must stay at 3");
}

void CheckNonBlocking(harness::Ctx& ctx) {
  for (int i = 0; i < 3; i++) audit("k1", "/items/" + std::to_string(i), 200, 1.0);
  const int sleeps = ctx.Clock.Sleeps();
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kAuditTopic).size(), 3, "three audit() calls must produce three records; the records");
  ctx.Equal(sleeps, 0, "audit() must not sleep or wait; the sleeps");
  ctx.Kafka.Stall(kAuditTopic);  // the broker stops answering: the request must not notice
  const int64_t before = ctx.Clock.Now();
  const int sleepsBefore = ctx.Clock.Sleeps();
  auditMustReturn(ctx, "because the broker was slow (hand the record to the producer and return)", "/items/slow");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited < 1 && ctx.Clock.Sleeps() == sleepsBefore,
             "audit() waited %.1f s for a stalled broker's acknowledgement: the request thread never waits for a "
             "broker, hand the record to the producer and return",
             waited);
}
`,
  },
  debrief: `Audit is a side channel: valuable, but never worth a slow or failed request. That priority decides everything here — an async hand-off, a bounded buffer, and an explicit drop with a counter you can alarm on. Blocking "just a little" when the queue is full is how a Kafka outage becomes an API outage. Real gateways ship audit through a local agent (Vector, Fluent Bit) so the process only ever writes to a socket on the same host, key by tenant rather than raw API key, and treat a rising \`dropped\` counter as a paging alert.`,
};
