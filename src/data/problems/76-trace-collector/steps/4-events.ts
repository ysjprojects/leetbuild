import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'trace.completed events keyed by service for the latency rollup',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'events',
  focus: ['collector', 'kafka', 'rollup', 'redis'],
  task: `## Task

**Starting point.** The starter publishes finished traces and keeps the latency rollup.
\`publish_completed(trace)\` (a trace as \`assembly.load_trace\` returns it) produces one
\`trace.completed\` record per span, keyed by the trace id and carrying the span, then flushes.
\`run_rollup()\` consumes the topic as group \`latency-rollup\` with auto-commit off, commits each
record, then adds it to \`rollup:{service}\` (\`HINCRBY\` \`traces\` 1, \`spans\` by \`span_count\`). It
passes a one-trace demo and hides four flaws.

**Failure mode the checks target.** A trace of three spans counts as three traces and copies its
spans into a retained topic; one service's events spread over every partition; a lost
acknowledgement writes an event twice and a leader failover loses one; and a crash between the
commit and the increment drops an event from the rollup.

- One event per service in the trace: \`{trace_id, service, span_count, max_ms}\` and nothing
  else.
- The record key is the service.
- The producer is idempotent with \`acks=all\`. kafka-go has no idempotent producer: \`RequireAll\` is
  what it can promise, and the Go check covers only the failover.
- \`run_rollup\` increments before it commits.`,
  sequence: {
    participants: ['Trace Collector', 'trace.completed', 'Latency rollup', 'Redis'],
    messages: [
      {from: 'Trace Collector', to: 'Trace Collector', label: 'group the spans by service', kind: 'sync'},
      {
        from: 'Trace Collector',
        to: 'trace.completed',
        label: 'produce key = service · acks=all · idempotent',
        kind: 'async',
      },
      {from: 'trace.completed', to: 'Trace Collector', label: 'delivery report', kind: 'reply'},
      {from: 'trace.completed', to: 'Latency rollup', label: 'consume · group latency-rollup', kind: 'async'},
      {from: 'Latency rollup', to: 'Redis', label: 'HINCRBY rollup:{service} traces, spans', kind: 'sync'},
      {from: 'Latency rollup', to: 'trace.completed', label: 'commit the offset, after the increment', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'per-service',
      title: 'One event per service, counts only',
      detail:
        'The spans are grouped by service and each group is one event `{trace_id, service, span_count, max_ms}`; the starter produces an event per span, each carrying the span itself into a topic that retains it.',
      match: {
        python: {all: [/span_count/, /max_ms/], none: [/["']span["']\s*:/]},
        typescript: {all: [/span_count/, /max_ms/], none: [/\bspan\s*\}|\bspan:\s*span\b/]},
        go: {all: [/span_count/, /max_ms/], none: [/"span":\s*span/]},
        scala: {all: [/span_count/, /max_ms/], none: [/"span"\s*->/]},
        cpp: {all: [/span_count/, /max_ms/], none: [/\{"span",|\["span"\]/]},
      },
    },
    {
      id: 'service-key',
      title: 'Keyed by service',
      detail:
        "The record key is the service, so one service's events land on one partition, in order; the starter keys by trace id.",
      match: {
        python: {
          all: [/key\s*=\s*(event\[["']service["']\]|service\b)/],
          none: [/key\s*=\s*trace\[["']trace_id["']\]/],
        },
        typescript: {all: [/key:\s*(event\.|e\.)?service\b/], none: [/key:\s*trace\.trace_id/]},
        go: {
          all: [/Key:\s*\[\]byte\(\s*(event\.|e\.)?Service\s*\)/],
          none: [/Key:\s*\[\]byte\(\s*trace\.TraceID\s*\)/],
        },
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Topic,\s*(event\.|e\.)?service\b/],
          none: [/Topic,\s*trace\.traceId/],
        },
        cpp: {all: [/service\.c_str\(\),\s*service\.(size|length)\(\)/], none: [/trace\.trace_id\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for every in-sync replica, so a retried write lands once and a leader failover keeps what was acknowledged. (kafka-go has no idempotent mode: `RequireAll` is what it can promise.)',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*(["']all["']|-1)/]},
        typescript: {all: [/idempotent:\s*true/], none: [/acks:\s*1\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG|"enable\.idempotence"/, /ACKS_CONFIG|"acks"/, /"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'HINCRBY before the offset commit',
      detail:
        'The rollup increments `rollup:{service}` and only then commits the offset: a crash in between redelivers the event instead of losing it.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /\.CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /\.commitSync\(/]},
        cpp: {order: [/\.hincrby\(/, /->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

TOPIC = "trace.completed"
GROUP = "latency-rollup"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("trace.completed not delivered: %s", err)


def publish_completed(trace: dict) -> list[dict]:
    """Tell the rollup a trace is complete (the trace as assembly.load_trace returns it); the events produced."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    events = []
    for span in trace["spans"]:
        event = {"trace_id": trace["trace_id"], "service": span["service"], "span_count": 1, "max_ms": span["duration_ms"], "span": span}
        producer.produce(TOPIC, key=trace["trace_id"], value=json.dumps(event), on_delivery=on_delivery)
        events.append(event)
    producer.flush(5.0)
    return events


def run_rollup() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(msg, asynchronous=False)
        event = json.loads(msg.value())
        r.hincrby(f"rollup:{event['service']}", "traces", 1)
        r.hincrby(f"rollup:{event['service']}", "spans", event["span_count"])
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

TOPIC = "trace.completed"
GROUP = "latency-rollup"
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("trace.completed not delivered: %s", err)


def completed_events(trace: dict) -> list[dict]:
    """One event per service: how many of its spans the trace has and the longest one; no span itself."""
    durations: dict[str, list[int]] = {}
    for span in trace["spans"]:
        durations.setdefault(span["service"], []).append(span["duration_ms"])
    return [
        {"trace_id": trace["trace_id"], "service": service, "span_count": len(values), "max_ms": max(values)}
        for service, values in sorted(durations.items())
    ]


def publish_completed(trace: dict) -> list[dict]:
    """Tell the rollup a trace is complete (the trace as assembly.load_trace returns it); the events produced."""
    events = completed_events(trace)
    for event in events:
        producer.produce(TOPIC, key=event["service"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(5.0)
    return events


def run_rollup() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        r.hincrby(f"rollup:{event['service']}", "traces", 1)
        r.hincrby(f"rollup:{event['service']}", "spans", event["span_count"])
        consumer.commit(msg, asynchronous=False)  # after the increments: a crash before this point redelivers
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import type {Trace} from 'traces/assembly';

export const TOPIC = 'trace.completed';
export const GROUP = 'latency-rollup';

const kafka = new Kafka({clientId: 'traced', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

export interface CompletedEvent {
  trace_id: string;
  service: string;
  span_count: number;
  max_ms: number;
}

/** Tell the rollup a trace is complete; the events produced. */
export async function publishCompleted(trace: Trace): Promise<CompletedEvent[]> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const events = trace.spans.map(span => ({trace_id: trace.trace_id, service: span.service, span_count: 1, max_ms: span.duration_ms, span}));
  await producer.send({topic: TOPIC, acks: 1, messages: events.map(event => ({key: trace.trace_id, value: JSON.stringify(event)}))});
  return events;
}

export async function runRollup(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as CompletedEvent;
      await redis.hincrby(\`rollup:\${event.service}\`, 'traces', 1);
      await redis.hincrby(\`rollup:\${event.service}\`, 'spans', event.span_count);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import type {Trace} from 'traces/assembly';

export const TOPIC = 'trace.completed';
export const GROUP = 'latency-rollup';

const kafka = new Kafka({clientId: 'traced', brokers: ['kafka:9092']});
// Idempotent (which implies acks: -1): a retry after a lost acknowledgement writes the record once, on every replica.
export const producer = kafka.producer({idempotent: true});
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

export interface CompletedEvent {
  trace_id: string;
  service: string;
  span_count: number;
  max_ms: number;
}

/** One event per service: how many of its spans the trace has and the longest one; no span itself. */
export function completedEvents(trace: Trace): CompletedEvent[] {
  const durations = new Map<string, number[]>();
  for (const s of trace.spans) durations.set(s.service, [...(durations.get(s.service) ?? []), s.duration_ms]);
  return [...durations.keys()].sort().map(service => {
    const values = durations.get(service) ?? [];
    return {trace_id: trace.trace_id, service, span_count: values.length, max_ms: Math.max(...values)};
  });
}

/** Tell the rollup a trace is complete; the events produced. */
export async function publishCompleted(trace: Trace): Promise<CompletedEvent[]> {
  const events = completedEvents(trace);
  await producer.send({topic: TOPIC, acks: -1, messages: events.map(event => ({key: event.service, value: JSON.stringify(event)}))});
  return events;
}

export async function runRollup(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as CompletedEvent;
      await redis.hincrby(\`rollup:\${event.service}\`, 'traces', 1);
      await redis.hincrby(\`rollup:\${event.service}\`, 'spans', event.span_count);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]); // after the increments
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"traces/assembly" // assembly.Trace
)

const (
	topic = "trace.completed"
	group = "latency-rollup"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireOne}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type completedEvent struct {
	TraceID   string \`json:"trace_id"\`
	Service   string \`json:"service"\`
	SpanCount int64  \`json:"span_count"\`
	MaxMs     int64  \`json:"max_ms"\`
}

// publishCompleted tells the rollup a trace is complete; it returns the events produced.
func publishCompleted(ctx context.Context, trace *assembly.Trace) ([]completedEvent, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	events := []completedEvent{}
	messages := []kafka.Message{}
	for _, span := range trace.Spans {
		event := completedEvent{TraceID: trace.TraceID, Service: span.Service, SpanCount: 1, MaxMs: span.DurationMs}
		value, _ := json.Marshal(map[string]any{"trace_id": event.TraceID, "service": event.Service, "span_count": event.SpanCount, "max_ms": event.MaxMs, "span": span})
		messages = append(messages, kafka.Message{Key: []byte(trace.TraceID), Value: value})
		events = append(events, event)
	}
	return events, writer.WriteMessages(ctx, messages...)
}

func runRollup(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event completedEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		rdb.HIncrBy(ctx, "rollup:"+event.Service, "traces", 1)
		rdb.HIncrBy(ctx, "rollup:"+event.Service, "spans", event.SpanCount)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"traces/assembly" // assembly.Trace
)

const (
	topic = "trace.completed"
	group = "latency-rollup"
)

// kafka-go has no idempotent mode: RequireAll (every in-sync replica) is what it can promise.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type completedEvent struct {
	TraceID   string \`json:"trace_id"\`
	Service   string \`json:"service"\`
	SpanCount int64  \`json:"span_count"\`
	MaxMs     int64  \`json:"max_ms"\`
}

// completedEvents is one event per service: how many of its spans the trace has and the longest one; no span itself.
func completedEvents(trace *assembly.Trace) []completedEvent {
	byService := map[string]*completedEvent{}
	for _, s := range trace.Spans {
		e, ok := byService[s.Service]
		if !ok {
			e = &completedEvent{TraceID: trace.TraceID, Service: s.Service}
			byService[s.Service] = e
		}
		e.SpanCount++
		if s.DurationMs > e.MaxMs {
			e.MaxMs = s.DurationMs
		}
	}
	events := make([]completedEvent, 0, len(byService))
	for _, e := range byService {
		events = append(events, *e)
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Service < events[j].Service })
	return events
}

// publishCompleted tells the rollup a trace is complete; it returns the events produced.
func publishCompleted(ctx context.Context, trace *assembly.Trace) ([]completedEvent, error) {
	events := completedEvents(trace)
	messages := make([]kafka.Message, 0, len(events))
	for _, event := range events {
		value, _ := json.Marshal(event)
		messages = append(messages, kafka.Message{Key: []byte(event.Service), Value: value})
	}
	return events, writer.WriteMessages(ctx, messages...)
}

func runRollup(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event completedEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		if err := rdb.HIncrBy(ctx, "rollup:"+event.Service, "traces", 1).Err(); err != nil {
			return err // not committed: the record is redelivered
		}
		if err := rdb.HIncrBy(ctx, "rollup:"+event.Service, "spans", event.SpanCount).Err(); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil { // after the increments
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import traces.Assembly // Assembly.Trace

object Events {
  val Topic = "trace.completed"
  val Group = "latency-rollup"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ACKS_CONFIG, "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"trace.completed not delivered: \${exception.getMessage}")
  }

  /** Tell the rollup a trace is complete; the events produced. */
  def publishCompleted(trace: Assembly.Trace): Seq[JsObject] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val events = trace.spans.map { span =>
      JsObject("trace_id" -> JsString(trace.traceId), "service" -> JsString(span.service), "span_count" -> JsNumber(1), "max_ms" -> JsNumber(span.durationMs),
        "span" -> Assembly.spanJson(span))
    }
    events.foreach(event => producer.send(new ProducerRecord[String, String](Topic, trace.traceId, event.compactPrint), onDelivery))
    producer.flush()
    events
  }

  def runRollup(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        val service = event("service").convertTo[String](DefaultJsonProtocol.StringJsonFormat)
        jedis.hincrBy(s"rollup:$service", "traces", 1)
        jedis.hincrBy(s"rollup:$service", "spans", event("span_count").convertTo[Long](DefaultJsonProtocol.LongJsonFormat))
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerConfig, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import traces.Assembly // Assembly.Trace

object Events {
  val Topic = "trace.completed"
  val Group = "latency-rollup"

  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  private val jedis = new JedisPooled("redis", 6379)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"trace.completed not delivered: \${exception.getMessage}")
  }

  /** One event per service: how many of its spans the trace has and the longest one; no span itself. */
  def completedEvents(trace: Assembly.Trace): Seq[JsObject] =
    trace.spans.groupBy(_.service).toSeq.sortBy(_._1).map { case (service, spans) =>
      JsObject("trace_id" -> JsString(trace.traceId), "service" -> JsString(service), "span_count" -> JsNumber(spans.size), "max_ms" -> JsNumber(spans.map(_.durationMs).max))
    }

  /** Tell the rollup a trace is complete; the events produced. */
  def publishCompleted(trace: Assembly.Trace): Seq[JsObject] = {
    val events = completedEvents(trace)
    events.foreach { event =>
      val service = event.fields("service").convertTo[String](DefaultJsonProtocol.StringJsonFormat)
      producer.send(new ProducerRecord[String, String](Topic, service, event.compactPrint), onDelivery)
    }
    producer.flush()
    events
  }

  def runRollup(): Unit = {
    val cprops = new Properties()
    cprops.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    cprops.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    cprops.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    cprops.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](cprops, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val service = event("service").convertTo[String](DefaultJsonProtocol.StringJsonFormat)
        jedis.hincrBy(s"rollup:$service", "traces", 1)
        jedis.hincrBy(s"rollup:$service", "spans", event("span_count").convertTo[Long](DefaultJsonProtocol.LongJsonFormat))
        consumer.commitSync() // after the increments: a crash before this point redelivers
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "traces/assembly.h"  // assembly::Trace

const std::string kTopic = "trace.completed";
const std::string kGroup = "latency-rollup";

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report: a record the broker refused is logged.
class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "trace.completed not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Tell the rollup a trace is complete; the events produced.
std::vector<nlohmann::json> publish_completed(const assembly::Trace& trace) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::vector<nlohmann::json> events;
  for (const assembly::Span& span : trace.spans) {
    nlohmann::json event = {{"trace_id", trace.trace_id}, {"service", span.service}, {"span_count", 1}, {"max_ms", span.duration_ms}};
    event["span"] = assembly::spanJson(span);
    const std::string value = event.dump();
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                      trace.trace_id.c_str(), trace.trace_id.size(), 0, nullptr);
    events.push_back(event);
  }
  producer->flush(5000);
  return events;
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void run_rollup() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    const std::string service = event.value("service", "");
    redis.hincrby("rollup:" + service, "traces", 1);
    redis.hincrby("rollup:" + service, "spans", event.value("span_count", 0LL));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "traces/assembly.h"  // assembly::Trace

const std::string kTopic = "trace.completed";
const std::string kGroup = "latency-rollup";

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report: a record the broker refused is logged.
class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "trace.completed not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_report;

// Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One event per service: how many of its spans the trace has and the longest one; no span itself.
std::vector<nlohmann::json> completed_events(const assembly::Trace& trace) {
  std::map<std::string, std::pair<long long, long long>> by_service;  // service -> (span_count, max_ms)
  for (const assembly::Span& s : trace.spans) {
    auto& [count, longest] = by_service[s.service];
    count++;
    longest = std::max(longest, s.duration_ms);
  }
  std::vector<nlohmann::json> events;
  for (const auto& [service, stats] : by_service) {
    events.push_back({{"trace_id", trace.trace_id}, {"service", service}, {"span_count", stats.first}, {"max_ms", stats.second}});
  }
  return events;
}

// Tell the rollup a trace is complete; the events produced.
std::vector<nlohmann::json> publish_completed(const assembly::Trace& trace) {
  const std::vector<nlohmann::json> events = completed_events(trace);
  for (const nlohmann::json& event : events) {
    const std::string value = event.dump();
    const std::string service = event["service"];
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(), service.c_str(),
                      service.size(), 0, nullptr);
  }
  producer->flush(5000);
  return events;
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

void run_rollup() {
  auto consumer = make_consumer();
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) {
      consumer->commitSync(msg.get());  // malformed: skip it, do not replay it forever
      continue;
    }
    const std::string service = event.value("service", "");
    redis.hincrby("rollup:" + service, "traces", 1);
    redis.hincrby("rollup:" + service, "spans", event.value("span_count", 0LL));
    consumer->commitSync(msg.get());  // after the increments: a crash before this point redelivers
  }
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "trace.completed"
TRACE_A = "4bf92f3577b34da6a3ce929d0e0e4736"
TRACE_B = "5c0a3f4688c45eb7b4df03af1f1f5847"


def _span(trace_id, span_id, parent, service, duration):
    return {"trace_id": trace_id, "span_id": span_id, "parent_span_id": parent, "service": service, "start_ms": 1712345678901, "duration_ms": duration}


def _trace(trace_id, spans):
    return {"trace_id": trace_id, "owner": "acme", "root": spans[0]["span_id"], "count": len(spans), "missing": 0, "extra_roots": 0, "spans": spans}


A = _trace(TRACE_A, [
    _span(TRACE_A, "00f067aa0ba902b7", "", "checkout", 412),
    _span(TRACE_A, "00f067aa0ba902b8", "00f067aa0ba902b7", "payments", 120),
    _span(TRACE_A, "00f067aa0ba902b9", "00f067aa0ba902b7", "payments", 95),
])
B = _trace(TRACE_B, [
    _span(TRACE_B, "10f067aa0ba902b7", "", "checkout", 300),
    _span(TRACE_B, "10f067aa0ba902b8", "10f067aa0ba902b7", "payments", 80),
])


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def check_per_service(ctx):
    m = ctx.load("events")
    m.publish_completed(A)
    events = sorted(_events(ctx), key=lambda e: e.get("service", ""))
    assert len(events) == 2, f"a trace with spans in checkout and payments produced {len(events)} records on {TOPIC}, expected one per service"
    want = [
        {"trace_id": TRACE_A, "service": "checkout", "span_count": 1, "max_ms": 412},
        {"trace_id": TRACE_A, "service": "payments", "span_count": 2, "max_ms": 120},
    ]
    assert events == want, f"the events must be {want}, with no span in them; got {events}"


def check_service_key(ctx):
    m = ctx.load("events")
    m.publish_completed(A)
    m.publish_completed(B)
    records = ctx.kafka.records(TOPIC)
    assert records, f"nothing was produced on {TOPIC}"
    partitions = {}
    for record in records:
        service = json.loads(record.value).get("service", "")
        assert record.key == service.encode(), f"a {service} event is keyed {record.key!r}: key every event by its service"
        partitions.setdefault(service, set()).add(record.partition)
    spread = {s: sorted(p) for s, p in partitions.items() if len(p) > 1}
    assert not spread, f"one service's events landed on several partitions {spread}: they must stay in order on one"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    m.publish_completed(A)
    values = [r.value for r in ctx.kafka.records(TOPIC)]
    assert len(values) == len(set(values)), f"after one produce whose acknowledgement was lost {TOPIC} holds the same event twice: the producer's retry wrote it again. Enable idempotence so the broker recognises the retry"
    before = len(values)
    m.publish_completed(B)
    ctx.kafka.failover(TOPIC)
    after = [json.loads(r.value).get("trace_id") for r in ctx.kafka.records(TOPIC)]
    assert TRACE_B in after and len(after) > before, f"a leader failover right after the acknowledgement lost trace {TRACE_B}'s events: wait for all in-sync replicas (acks=all)"


def check_counters_before_commit(ctx):
    for event in (
        {"trace_id": TRACE_A, "service": "checkout", "span_count": 1, "max_ms": 412},
        {"trace_id": TRACE_A, "service": "payments", "span_count": 2, "max_ms": 120},
        {"trace_id": TRACE_B, "service": "checkout", "span_count": 1, "max_ms": 300},
    ):
        ctx.kafka.seed(TOPIC, key=event["service"], value=json.dumps(event))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(sum(int(ctx.redis.hget(k, "traces") or 0) for k in ctx.redis.keys("rollup:*"))))
    m = ctx.load("events")
    ctx.drain(m.run_rollup)
    assert at_commit, "the rollup never committed an offset"
    assert at_commit[0] >= 1, "at the first commit no event had been counted yet: the increment must come before the commit, or a crash in between loses the event"
    assert ctx.redis.hgetall("rollup:checkout") == {"traces": "2", "spans": "2"}, f"rollup:checkout is {ctx.redis.hgetall('rollup:checkout')}, expected traces 2, spans 2"
    assert ctx.redis.hgetall("rollup:payments") == {"traces": "1", "spans": "2"}, f"rollup:payments is {ctx.redis.hgetall('rollup:payments')}, expected traces 1, spans 2"
    assert ctx.kafka.lag("latency-rollup", TOPIC) == 0, "every counted event must be committed by group latency-rollup"
`,
    typescript: `const TOPIC = 'trace.completed';
const TRACE_A = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACE_B = '5c0a3f4688c45eb7b4df03af1f1f5847';

const span = (trace_id: string, span_id: string, parent_span_id: string, service: string, duration_ms: number) => ({trace_id, span_id, parent_span_id, service, start_ms: 1712345678901, duration_ms});
const trace = (trace_id: string, spans) => ({trace_id, owner: 'acme', root: spans[0].span_id, count: spans.length, missing: 0, extra_roots: 0, spans});

const A = trace(TRACE_A, [
  span(TRACE_A, '00f067aa0ba902b7', '', 'checkout', 412),
  span(TRACE_A, '00f067aa0ba902b8', '00f067aa0ba902b7', 'payments', 120),
  span(TRACE_A, '00f067aa0ba902b9', '00f067aa0ba902b7', 'payments', 95),
]);
const B = trace(TRACE_B, [span(TRACE_B, '10f067aa0ba902b7', '', 'checkout', 300), span(TRACE_B, '10f067aa0ba902b8', '10f067aa0ba902b7', 'payments', 80)]);

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

export async function check_per_service(ctx) {
  const m = ctx.load('events');
  await m.publishCompleted(A);
  const got = events(ctx).sort((a, b) => (a.service < b.service ? -1 : 1));
  assert.equal(got.length, 2, \`a trace with spans in checkout and payments produced \${got.length} records on \${TOPIC}, expected one per service\`);
  const want = [
    {trace_id: TRACE_A, service: 'checkout', span_count: 1, max_ms: 412},
    {trace_id: TRACE_A, service: 'payments', span_count: 2, max_ms: 120},
  ];
  assert.deepStrictEqual(got, want, \`the events must be \${JSON.stringify(want)}, with no span in them; got \${JSON.stringify(got)}\`);
}

export async function check_service_key(ctx) {
  const m = ctx.load('events');
  await m.publishCompleted(A);
  await m.publishCompleted(B);
  const records = ctx.kafka.records(TOPIC);
  assert(records.length > 0, \`nothing was produced on \${TOPIC}\`);
  const partitions = new Map<string, Set<number>>();
  for (const record of records) {
    const service = JSON.parse(record.value.toString()).service ?? '';
    const key = record.key?.toString() ?? null;
    assert.equal(key, service, \`a \${service} event is keyed \${JSON.stringify(key)}: key every event by its service\`);
    partitions.set(service, (partitions.get(service) ?? new Set()).add(record.partition));
  }
  const spread = [...partitions].filter(([, p]) => p.size > 1).map(([s]) => s);
  assert.equal(spread.length, 0, \`the events of \${JSON.stringify(spread)} landed on several partitions: they must stay in order on one\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.publishCompleted(A);
  const values = ctx.kafka.records(TOPIC).map(r => r.value.toString());
  assert.equal(values.length, new Set(values).size, \`after one produce whose acknowledgement was lost \${TOPIC} holds the same event twice: the producer's retry wrote it again. Enable idempotence so the broker recognises the retry\`);
  const before = values.length;
  await m.publishCompleted(B);
  ctx.kafka.failover(TOPIC);
  const after = events(ctx).map(e => e.trace_id);
  assert(after.includes(TRACE_B) && after.length > before, \`a leader failover right after the acknowledgement lost trace \${TRACE_B}'s events: wait for all in-sync replicas (acks: -1)\`);
}

export async function check_counters_before_commit(ctx) {
  for (const event of [
    {trace_id: TRACE_A, service: 'checkout', span_count: 1, max_ms: 412},
    {trace_id: TRACE_A, service: 'payments', span_count: 2, max_ms: 120},
    {trace_id: TRACE_B, service: 'checkout', span_count: 1, max_ms: 300},
  ]) {
    ctx.kafka.seed(TOPIC, {key: event.service, value: JSON.stringify(event)});
  }
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.keys('rollup:*').reduce((n: number, k: string) => n + Number(ctx.redis.hget(k, 'traces') ?? 0), 0)));
  const m = ctx.load('events');
  await ctx.drain(m.runRollup());
  assert(atCommit.length > 0, 'the rollup never committed an offset');
  assert(atCommit[0] >= 1, 'at the first commit no event had been counted yet: the increment must come before the commit, or a crash in between loses the event');
  assert.deepStrictEqual(ctx.redis.hgetall('rollup:checkout'), {traces: '2', spans: '2'}, \`rollup:checkout is \${JSON.stringify(ctx.redis.hgetall('rollup:checkout'))}, expected traces 2, spans 2\`);
  assert.deepStrictEqual(ctx.redis.hgetall('rollup:payments'), {traces: '1', spans: '2'}, \`rollup:payments is \${JSON.stringify(ctx.redis.hgetall('rollup:payments'))}, expected traces 1, spans 2\`);
  assert.equal(ctx.kafka.lag('latency-rollup', TOPIC), 0, 'every counted event must be committed by group latency-rollup');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"

	"traces/assembly"

	"leetbuild/harness"
)

const (
	evTopic  = "trace.completed"
	evTraceA = "4bf92f3577b34da6a3ce929d0e0e4736"
	evTraceB = "5c0a3f4688c45eb7b4df03af1f1f5847"
)

func evTrace(traceID string, spans ...assembly.Span) *assembly.Trace {
	for i := range spans {
		spans[i].TraceID = traceID
		spans[i].StartMs = 1712345678901
	}
	return &assembly.Trace{TraceID: traceID, Owner: "acme", Root: spans[0].SpanID, Count: int64(len(spans)), Spans: spans}
}

func traceA() *assembly.Trace {
	return evTrace(evTraceA,
		assembly.Span{SpanID: "00f067aa0ba902b7", Service: "checkout", DurationMs: 412},
		assembly.Span{SpanID: "00f067aa0ba902b8", ParentSpanID: "00f067aa0ba902b7", Service: "payments", DurationMs: 120},
		assembly.Span{SpanID: "00f067aa0ba902b9", ParentSpanID: "00f067aa0ba902b7", Service: "payments", DurationMs: 95})
}

func traceB() *assembly.Trace {
	return evTrace(evTraceB,
		assembly.Span{SpanID: "10f067aa0ba902b7", Service: "checkout", DurationMs: 300},
		assembly.Span{SpanID: "10f067aa0ba902b8", ParentSpanID: "10f067aa0ba902b7", Service: "payments", DurationMs: 80})
}

func mustPublish(ctx *harness.Ctx, trace *assembly.Trace) {
	_, err := publishCompleted(context.Background(), trace)
	ctx.NoError(err, "publishCompleted(%s)", trace.TraceID)
	ctx.Settle()
}

func evEvents(ctx *harness.Ctx) []map[string]any {
	out := []map[string]any{}
	for _, r := range ctx.Kafka.Records(evTopic) {
		var e map[string]any
		json.Unmarshal(r.Value, &e)
		out = append(out, e)
	}
	return out
}

func CheckPerService(ctx *harness.Ctx) {
	mustPublish(ctx, traceA())
	events := evEvents(ctx)
	ctx.Equal(len(events), 2, "a trace with spans in checkout and payments must produce one record per service on %s; the records", evTopic)
	sort.Slice(events, func(i, j int) bool { return events[i]["service"].(string) < events[j]["service"].(string) })
	want := []map[string]any{
		{"trace_id": evTraceA, "service": "checkout", "span_count": 1, "max_ms": 412},
		{"trace_id": evTraceA, "service": "payments", "span_count": 2, "max_ms": 120},
	}
	ctx.Equal(events, want, "the events, with no span in them")
}

func CheckServiceKey(ctx *harness.Ctx) {
	mustPublish(ctx, traceA())
	mustPublish(ctx, traceB())
	records := ctx.Kafka.Records(evTopic)
	ctx.Assert(len(records) > 0, "nothing was produced on %s", evTopic)
	partitions := map[string]map[int]bool{}
	for _, r := range records {
		var e struct {
			Service string \`json:"service"\`
		}
		json.Unmarshal(r.Value, &e)
		ctx.Equal(string(r.Key), e.Service, "a %s event's key: key every event by its service", e.Service)
		if partitions[e.Service] == nil {
			partitions[e.Service] = map[int]bool{}
		}
		partitions[e.Service][r.Partition] = true
	}
	for service, p := range partitions {
		ctx.Assert(len(p) == 1, "the %s events landed on %d partitions: they must stay in order on one", service, len(p))
	}
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	mustPublish(ctx, traceB())
	ctx.Kafka.Failover(evTopic)
	found := false
	for _, e := range evEvents(ctx) {
		found = found || e["trace_id"] == evTraceB
	}
	ctx.Assert(found, "a leader failover right after the acknowledgement lost trace %s's events: wait for all in-sync replicas (RequireAll)", evTraceB)
}

func CheckCountersBeforeCommit(ctx *harness.Ctx) {
	for _, e := range []completedEvent{
		{TraceID: evTraceA, Service: "checkout", SpanCount: 1, MaxMs: 412},
		{TraceID: evTraceA, Service: "payments", SpanCount: 2, MaxMs: 120},
		{TraceID: evTraceB, Service: "checkout", SpanCount: 1, MaxMs: 300},
	} {
		value, _ := json.Marshal(e)
		ctx.Kafka.Seed(evTopic, e.Service, string(value))
	}
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		total := 0
		for _, k := range ctx.Redis.Keys("rollup:*") {
			v, _ := ctx.Redis.HGet(k, "traces")
			n, _ := strconv.Atoi(v)
			total += n
		}
		atCommit = append(atCommit, total)
	})
	ctx.Drain(func() { runRollup(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the rollup never committed an offset")
	ctx.Assert(atCommit[0] >= 1, "at the first commit no event had been counted yet: the increment must come before the commit, or a crash in between loses the event")
	ctx.Equal(ctx.Redis.HGetAll("rollup:checkout"), map[string]string{"traces": "2", "spans": "2"}, "rollup:checkout")
	ctx.Equal(ctx.Redis.HGetAll("rollup:payments"), map[string]string{"traces": "1", "spans": "2"}, "rollup:payments")
	ctx.Equal(ctx.Kafka.Lag("latency-rollup", evTopic), 0, "every counted event must be committed by group latency-rollup; the lag")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "traces/assembly.h"

namespace {

const std::string kTopic2 = "trace.completed";
const std::string kTraceA = "4bf92f3577b34da6a3ce929d0e0e4736";
const std::string kTraceB = "5c0a3f4688c45eb7b4df03af1f1f5847";

assembly::Trace evTrace(const std::string& trace_id, std::vector<assembly::Span> spans) {
  for (auto& s : spans) {
    s.trace_id = trace_id;
    s.start_ms = 1712345678901LL;
  }
  return assembly::Trace{trace_id, "acme", spans.at(0).span_id, static_cast<long long>(spans.size()), 0, 0, spans};
}

assembly::Trace traceA() {
  return evTrace(kTraceA, {{"", "00f067aa0ba902b7", "", "checkout", 0, 412},
                           {"", "00f067aa0ba902b8", "00f067aa0ba902b7", "payments", 0, 120},
                           {"", "00f067aa0ba902b9", "00f067aa0ba902b7", "payments", 0, 95}});
}

assembly::Trace traceB() {
  return evTrace(kTraceB, {{"", "10f067aa0ba902b7", "", "checkout", 0, 300}, {"", "10f067aa0ba902b8", "10f067aa0ba902b7", "payments", 0, 80}});
}

std::vector<nlohmann::json> evEvents(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& r : ctx.Kafka.Records(kTopic2)) out.push_back(nlohmann::json::parse(r.Value.value_or(""), nullptr, false));
  return out;
}

void publish(harness::Ctx& ctx, const assembly::Trace& trace) {
  publish_completed(trace);
  ctx.Settle();
}

}  // namespace

void CheckPerService(harness::Ctx& ctx) {
  publish(ctx, traceA());
  auto events = evEvents(ctx);
  ctx.Equal(events.size(), 2, "a trace with spans in checkout and payments must produce one record per service on %s; the records", kTopic2);
  std::sort(events.begin(), events.end(), [](const nlohmann::json& a, const nlohmann::json& b) { return a.value("service", "") < b.value("service", ""); });
  const std::vector<nlohmann::json> want = {
      {{"trace_id", kTraceA}, {"service", "checkout"}, {"span_count", 1}, {"max_ms", 412}},
      {{"trace_id", kTraceA}, {"service", "payments"}, {"span_count", 2}, {"max_ms", 120}},
  };
  ctx.Assert(events == want, "the events must be %s, with no span in them; got %s", nlohmann::json(want).dump(), nlohmann::json(events).dump());
}

void CheckServiceKey(harness::Ctx& ctx) {
  publish(ctx, traceA());
  publish(ctx, traceB());
  const auto records = ctx.Kafka.Records(kTopic2);
  ctx.Assert(!records.empty(), "nothing was produced on %s", kTopic2);
  std::map<std::string, std::set<int>> partitions;
  for (const auto& r : records) {
    const auto event = nlohmann::json::parse(r.Value.value_or(""), nullptr, false);
    const std::string service = event.is_object() ? event.value("service", "") : "";
    ctx.Equal(r.Key.value_or(""), service, "a %s event's key: key every event by its service", service);
    partitions[service].insert(r.Partition);
  }
  for (const auto& [service, p] : partitions) ctx.Assert(p.size() == 1, "the %s events landed on %v partitions: they must stay in order on one", service, p.size());
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic2, 1);
  publish(ctx, traceA());
  auto values = ctx.Kafka.Values(kTopic2);
  const size_t before = values.size();
  std::sort(values.begin(), values.end());
  ctx.Assert(std::adjacent_find(values.begin(), values.end()) == values.end(),
             "after one produce whose acknowledgement was lost %s holds the same event twice: the producer's retry wrote it again. Enable idempotence so the broker recognises the retry", kTopic2);
  publish(ctx, traceB());
  ctx.Kafka.Failover(kTopic2);
  bool found = false;
  for (const auto& e : evEvents(ctx)) found = found || (e.is_object() && e.value("trace_id", "") == kTraceB);
  ctx.Assert(found && ctx.Kafka.Records(kTopic2).size() > before, "a leader failover right after the acknowledgement lost trace %s's events: wait for all in-sync replicas (acks=all)", kTraceB);
}

void CheckCountersBeforeCommit(harness::Ctx& ctx) {
  for (const nlohmann::json& e : std::vector<nlohmann::json>{
           {{"trace_id", kTraceA}, {"service", "checkout"}, {"span_count", 1}, {"max_ms", 412}},
           {{"trace_id", kTraceA}, {"service", "payments"}, {"span_count", 2}, {"max_ms", 120}},
           {{"trace_id", kTraceB}, {"service", "checkout"}, {"span_count", 1}, {"max_ms", 300}},
       }) {
    ctx.Kafka.Seed(kTopic2, e["service"].get<std::string>(), e.dump());
  }
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    long long total = 0;
    for (const auto& k : ctx.Redis.Keys("rollup:*")) total += std::stoll(ctx.Redis.HGet(k, "traces").value_or("0"));
    atCommit.push_back(total);
  });
  ctx.Drain([] { run_rollup(); });
  ctx.Assert(!atCommit.empty(), "the rollup never committed an offset");
  ctx.Assert(atCommit[0] >= 1, "at the first commit no event had been counted yet: the increment must come before the commit, or a crash in between loses the event");
  ctx.Equal(ctx.Redis.HGetAll("rollup:checkout"), std::map<std::string, std::string>{{"traces", "2"}, {"spans", "2"}}, "rollup:checkout");
  ctx.Equal(ctx.Redis.HGetAll("rollup:payments"), std::map<std::string, std::string>{{"traces", "1"}, {"spans", "2"}}, "rollup:payments");
  ctx.Equal(ctx.Kafka.Lag("latency-rollup", kTopic2), 0, "every counted event must be committed by group latency-rollup; the lag");
}
`,
  },
  hints: [
    'Publish one trace of three spans and run the rollup: checkout shows three traces, the topic holds the spans themselves, and a trace whose acknowledgement was lost is counted twice.',
    'The publisher loops over spans, not services, and keys by trace id, which spreads a service over the partitions. Without idempotence the retry after a lost ack is a new record; the rollup commits before it counts.',
    'Group spans by service into `{trace_id, service, span_count, max_ms}`; produce with `key=event["service"]`; set `enable.idempotence` and `acks=all`; in `run_rollup`, `hincrby` both fields, then `consumer.commit`.',
  ],
  debrief: `The event is shaped by its consumer: the rollup counts traces per service, so one event per service per trace makes the count a plain increment, and keying by service puts every event a counter needs on one partition, in order. The payload stays counts because the topic is retained and replicated, and whatever goes into it is copied to every consumer for days. Idempotence with \`acks=all\` covers the two broker failures that would skew the counts; increment-then-commit makes a crash cost a double count rather than a lost one. That double count is still there: a rollup that must be exact also records the \`(trace_id, service)\` pairs it has applied, with a TTL, and skips a redelivery.`,
};
