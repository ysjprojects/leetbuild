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
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic     = "gateway-audit"
	queueSize = 10000
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
	value, _ := json.Marshal(auditRecord{APIKey: apiKey, Path: path, Status: status, LatencyMs: float64(latency.Microseconds()) / 1000, Ts: float64(time.Now().UnixMilli()) / 1000})
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
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	topic     = "gateway-audit"
	queueSize = 10000
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
	value, _ := json.Marshal(auditRecord{APIKey: apiKey, Path: path, Status: status, LatencyMs: float64(latency.Microseconds()) / 1000, Ts: float64(time.Now().UnixMilli()) / 1000})
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
                      ",\\"latency_ms\\":" + std::to_string(latency_ms) + ",\\"ts\\":" + std::to_string(ts) + "}";
  // TODO: produce keyed by api_key (RK_MSG_COPY); ERR__QUEUE_FULL → ++dropped; poll(0); never block
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <atomic>
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
                      ",\\"latency_ms\\":" + std::to_string(latency_ms) + ",\\"ts\\":" + std::to_string(ts) + "}";
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   value.data(), value.size(), api_key.c_str(), api_key.size(), 0, nullptr);
  if (err == RdKafka::ERR__QUEUE_FULL) {
    ++dropped;  // the broker is behind: lose one audit line, not the request
  } else if (err != RdKafka::ERR_NO_ERROR) {
    std::cerr << "audit produce failed: " << RdKafka::err2str(err) << "\\n";
  }
  producer->poll(0);  // serve delivery callbacks; returns immediately
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
  },
  debrief: `Audit is a side channel: valuable, but never worth a slow or failed request. That priority decides everything here — an async hand-off, a bounded buffer, and an explicit drop with a counter you can alarm on. Blocking "just a little" when the queue is full is how a Kafka outage becomes an API outage. Real gateways ship audit through a local agent (Vector, Fluent Bit) so the process only ever writes to a socket on the same host, key by tenant rather than raw API key, and treat a rising \`dropped\` counter as a paging alert.`,
};
