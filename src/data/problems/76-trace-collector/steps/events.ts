import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Trace events keyed by service for latency rollups',
  concept: 'kafka',
  file: 'events',
  focus: ['collector', 'kafka', 'rollup', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the trace finished, so the draft
publishes one event per span with everything the span had, and the consumer updates the rollup. It
passes a demo where one trace is published and read back by hand. It keys the topic by trace id,
pushes span tags (user identifiers live there) into a retained topic, and commits the offset before
its counters are updated.

Implement the completion path in two halves — \`publish_completed(trace)\` and the consumer loop.

- The topic is \`trace.completed\` (\`TRACE_COMPLETED_TOPIC\`). One event is published **per service**
  in the finished trace, **keyed by the service id**, with \`span_count\`, \`p50_ms\` and \`p95_ms\`
  computed from that service's spans and the \`trace_id\`. The key is an ordering contract: with
  \`key = service\`, every event for one service lands in the same partition in order, which is what
  makes a latency stream for that service meaningful. The draft keys by trace id, so the same
  service's events are spread across partitions and the rollup sees an arbitrary order.
- The payload carries **counts and percentiles only**: no span tags, no attributes, no user
  identifiers, no raw payloads. The topic is retained and replicated, so anything written there
  outlives the request, the tenant and the retention policy the span itself was subject to. The
  draft publishes \`tags\` and \`user_id\` verbatim.
- The producer is configured for idempotent delivery with \`acks=all\` (Go: \`RequiredAcks:
  RequireAll\` with a hash balancer; C++/Scala/Python: \`enable.idempotence\` + \`acks=all\`; KafkaJS:
  \`idempotent: true\` and \`acks: -1\`), so a broker retry cannot duplicate an event that the rollup
  will then count twice.
- The consumer updates the Redis rollup counters (\`rollup:{service}\`: \`traces\`, \`spans\`) **before**
  it commits the offset, and runs with auto-commit off. Counters first means a crash between the two
  costs at most one update; the draft commits first, so a crash after the commit loses the update
  permanently — the offset says the event was processed and no counter ever saw it.

**Failure mode the checks target.** Three failures that all look like "the rollup is a bit off":
a key that does not match the thing you order by, a payload that copies identifiers into a topic you
cannot un-publish, and an offset commit that claims work the counters never did. The third one is the
one that never recovers, because the event is gone and the offset has moved past it.`,
  sequence: {
    participants: ['Trace Collector', 'Kafka', 'Latency rollup', 'Redis'],
    messages: [
      {from: 'Trace Collector', to: 'Trace Collector', label: 'group the finished trace by service id', kind: 'sync'},
      {
        from: 'Trace Collector',
        to: 'Kafka',
        label: 'produce trace.completed · key = service · acks=all',
        kind: 'async',
      },
      {from: 'Kafka', to: 'Trace Collector', label: 'ack (idempotent producer: no duplicate on retry)', kind: 'reply'},
      {from: 'Kafka', to: 'Latency rollup', label: 'poll · all events of one service in order', kind: 'async'},
      {from: 'Latency rollup', to: 'Redis', label: 'HINCRBY rollup:{service} traces/spans', kind: 'sync'},
      {from: 'Redis', to: 'Latency rollup', label: 'applied', kind: 'reply'},
      {from: 'Latency rollup', to: 'Kafka', label: 'commit the offset only after the counters', kind: 'sync'},
    ],
  },
  hints: [
    "Pick the key by asking what has to stay in order: the rollup reads the latencies of one service as a stream, so the key is the service id. Keying by trace id scatters a service's events over partitions, and the consumer has no ordering guarantee left.",
    'The topic is not a debugging aid you can clean up later: whatever you publish is retained and replicated. Send the count and the percentiles that the rollup needs (p50/p95) and leave span tags, attributes and user identifiers in the span store, where they have an owner and a retention policy.',
    'Two more habits the checks look for: an idempotent producer with acks=all so a broker retry cannot double-count, and counters updated before the offset commit so a crash can lose an update but never silently skip one.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Publishes to trace.completed',
      detail: 'The completion topic is `trace.completed`, named once and used by the producer and the consumer.',
      match: {
        python: {all: [/TRACE_COMPLETED_TOPIC\s*=\s*"trace\.completed"/]},
        typescript: {all: [/TRACE_COMPLETED_TOPIC\s*=\s*'trace\.completed'/]},
        go: {all: [/TraceCompletedTopic\s*=\s*"trace\.completed"/]},
        scala: {all: [/TraceCompletedTopic\s*=\s*"trace\.completed"/]},
        cpp: {all: [/kTraceCompletedTopic\s*=\s*"trace\.completed"/]},
      },
    },
    {
      id: 'key-by-service',
      title: 'Keys every event by the service id',
      detail:
        'The message key is the service id, so all events of one service stay ordered in one partition. The draft keys by trace id, which spreads one service’s stream across partitions.',
      match: {
        python: {all: [/producer\.produce\(/, /key=service/]},
        typescript: {all: [/topic: TRACE_COMPLETED_TOPIC/, /key: service/]},
        go: {all: [/kafka\.Message\{Key: \[\]byte\(service\)/, /completedWriter|kafka\.Writer/]},
        scala: {all: [/new ProducerRecord\(TraceCompletedTopic, service, payload\)/]},
        cpp: {all: [/kTraceCompletedTopic/, /service\.data\(\)/, /service\.size\(\)/]},
      },
    },
    {
      id: 'no-tags-no-identifiers',
      title: 'Payload carries counts and percentiles, never tags or identifiers',
      detail:
        'The event body is `span_count` + `p50_ms` + `p95_ms` (plus the service and trace id): no `tags`, no `user_id`, no span payloads. The topic retains and replicates whatever is written into it.',
      match: {
        python: {all: [/span_count/, /p95_ms/], none: [/tags/, /user_id/]},
        typescript: {all: [/span_count/, /p95_ms/], none: [/tags/, /user_id/]},
        go: {all: [/span_count/, /p95_ms/], none: [/tags/, /user_id/]},
        scala: {all: [/span_count/, /p95_ms/], none: [/tags/, /user_id/]},
        cpp: {all: [/span_count/, /p95_ms/], none: [/tags/, /user_id/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Producer is idempotent with acks=all',
      detail:
        'The producer is configured for idempotent delivery and full acknowledgement, so a broker retry cannot publish the same event twice. The draft uses the default fire-and-forget producer.',
      match: {
        python: {all: [/"enable\.idempotence": True/, /"acks": "all"/]},
        typescript: {all: [/idempotent: true/, /acks: -1/]},
        go: {all: [/RequiredAcks: kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/"enable\.idempotence", "true"/, /"acks", "all"/]},
        cpp: {all: [/set\("enable\.idempotence", "true"/, /set\("acks", "all"/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Rollup counters are updated before the offset commit',
      detail:
        'The consumer increments `rollup:{service}` before committing the offset, with auto-commit off: a crash between the two loses at most one update instead of skipping an event forever. The draft commits first.',
      match: {
        python: {order: [/hincrby/, /commit\(/]},
        typescript: {order: [/hincrby/, /commitOffsets\(/]},
        go: {order: [/HIncrBy/, /CommitMessages\(/]},
        scala: {order: [/hincrBy/, /commitSync\(/]},
        cpp: {order: [/hincrby/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Consumer, Producer

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TRACE_COMPLETED_TOPIC = "trace.completed"
producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_completed(trace: dict) -> list[dict]:
    """Publish the trace so the rollup can see everything that happened in it."""
    # TODO: key by the service id instead of the trace id, keep span tags and user identifiers out
    # of the event, configure the producer for idempotent delivery with acks=all, and update the
    # rollup counters before committing the offset.
    published = []
    for span in trace["spans"]:
        event = {
            "trace_id": trace["trace_id"],
            "span_id": span["span_id"],
            "tags": span.get("tags", {}),
            "user_id": span.get("user_id"),
            "duration_ms": span["duration_ms"],
        }
        producer.produce(TRACE_COMPLETED_TOPIC, key=trace["trace_id"], value=json.dumps(event))
        published.append(event)
    producer.flush()
    return published


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "latency"})
    consumer.subscribe([TRACE_COMPLETED_TOPIC])
    while True:
        message = consumer.poll(1.0)
        if message is None:
            continue
        consumer.commit(message)
        event = json.loads(message.value())
        r.hincrby(f"rollup:{event.get('service', '')}", "traces", 1)
`,
      solution: `import json
import math

import redis
from confluent_kafka import Consumer, Producer

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TRACE_COMPLETED_TOPIC = "trace.completed"
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


def percentile(sorted_durations: list[int], quantile: float) -> int:
    """Nearest-rank percentile over durations already sorted ascending."""
    if not sorted_durations:
        return 0
    rank = max(1, math.ceil(quantile * len(sorted_durations)))
    return sorted_durations[rank - 1]


def publish_completed(trace: dict) -> list[dict]:
    """One event per service in the finished trace, keyed by the service id."""
    by_service: dict[str, list[int]] = {}
    for span in trace["spans"]:
        by_service.setdefault(span["service"], []).append(span["duration_ms"])
    published = []
    for service, durations in by_service.items():
        durations.sort()
        event = {
            "service": service,
            "trace_id": trace["trace_id"],
            "span_count": len(durations),
            "p50_ms": percentile(durations, 0.50),
            "p95_ms": percentile(durations, 0.95),
        }
        producer.produce(TRACE_COMPLETED_TOPIC, key=service, value=json.dumps(event))
        published.append(event)
    producer.flush(2.0)
    return published


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "latency", "enable.auto.commit": False}
    )
    consumer.subscribe([TRACE_COMPLETED_TOPIC])
    while True:
        message = consumer.poll(1.0)
        if message is None:
            continue
        event = json.loads(message.value())
        service = event["service"]
        # Counters first: a crash between the two loses an update, it never skips an event.
        r.hincrby(f"rollup:{service}", "traces", 1)
        r.hincrby(f"rollup:{service}", "spans", event["span_count"])
        consumer.commit(message)
`,
    },
    typescript: {
      starter: `/** trace.completed: a model-generated draft that keys by trace id and commits too early. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const TRACE_COMPLETED_TOPIC = 'trace.completed';
const kafka = new Kafka({clientId: 'trace-collector', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Span {
  trace_id: string;
  span_id: string;
  service: string;
  duration_ms: number;
}

export async function publishCompleted(traceId: string, spans: Span[]): Promise<void> {
  // TODO: key by the service id instead of the trace id, keep span tags and user identifiers out
  // of the event, configure the producer for idempotent delivery with acks=all, and update the
  // rollup counters before committing the offset.
  for (const span of spans) {
    const event = {
      trace_id: traceId,
      span_id: span.span_id,
      tags: (span as Record<string, unknown>).tags ?? {},
      user_id: (span as Record<string, unknown>).user_id,
      duration_ms: span.duration_ms,
    };
    await producer.send({
      topic: TRACE_COMPLETED_TOPIC,
      messages: [{key: traceId, value: JSON.stringify(event)}],
    });
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'latency'});
  await consumer.connect();
  await consumer.subscribe({topic: TRACE_COMPLETED_TOPIC});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {service: string};
      await r.hincrby(\`rollup:\${event.service}\`, 'traces', 1);
    },
  });
}
`,
      solution: `/** trace.completed: one event per service, no span payloads, counters before the offset. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const TRACE_COMPLETED_TOPIC = 'trace.completed';
const kafka = new Kafka({clientId: 'trace-collector', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface Span {
  trace_id: string;
  span_id: string;
  service: string;
  duration_ms: number;
}

interface CompletedEvent {
  service: string;
  trace_id: string;
  span_count: number;
  p50_ms: number;
  p95_ms: number;
}

function percentile(sortedDurations: number[], quantile: number): number {
  if (sortedDurations.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(quantile * sortedDurations.length));
  return sortedDurations[rank - 1];
}

export async function publishCompleted(traceId: string, spans: Span[]): Promise<CompletedEvent[]> {
  const durationsByService = new Map<string, number[]>();
  for (const span of spans) {
    const durations = durationsByService.get(span.service) ?? [];
    durations.push(span.duration_ms);
    durationsByService.set(span.service, durations);
  }

  const published: CompletedEvent[] = [];
  for (const [service, durations] of durationsByService) {
    durations.sort((left, right) => left - right);
    const event: CompletedEvent = {
      service,
      trace_id: traceId,
      span_count: durations.length,
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
    };
    await producer.send({
      topic: TRACE_COMPLETED_TOPIC,
      acks: -1,
      messages: [{key: service, value: JSON.stringify(event)}],
    });
    published.push(event);
  }
  return published;
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'latency'});
  await consumer.connect();
  await consumer.subscribe({topic: TRACE_COMPLETED_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as CompletedEvent;
      // Counters first: a crash between the two loses an update, it never skips an event.
      await r.hincrby(\`rollup:\${event.service}\`, 'traces', 1);
      await r.hincrby(\`rollup:\${event.service}\`, 'spans', event.span_count);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
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
)

const TraceCompletedTopic = "trace.completed"

var (
	completedWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: TraceCompletedTopic}
	rdb             *redis.Client
)

type Span struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

func publishCompleted(ctx context.Context, traceID string, spans []Span) error {
	// TODO: key by the service id instead of the trace id, keep span tags and user identifiers out
	// of the event, configure the producer for idempotent delivery with acks=all, and update the
	// rollup counters before committing the offset.
	for _, span := range spans {
		event := map[string]any{
			"trace_id":    traceID,
			"span_id":     span.SpanID,
			"duration_ms": span.DurationMS,
		}
		payload, _ := json.Marshal(event)
		if err := completedWriter.WriteMessages(ctx, kafka.Message{Key: []byte(traceID), Value: payload}); err != nil {
			return err
		}
	}
	return nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   TraceCompletedTopic,
		GroupID: "latency",
	})
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, message)
		var event struct {
			Service   string \`json:"service"\`
			SpanCount int64  \`json:"span_count"\`
		}
		_ = json.Unmarshal(message.Value, &event)
		rdb.HIncrBy(ctx, "rollup:"+event.Service, "traces", 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"math"
	"sort"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const TraceCompletedTopic = "trace.completed"

// RequireAll + a hash balancer: the broker acknowledges only once the record is replicated, and
// retries of one key land on one partition instead of duplicating across them.
var completedWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        TraceCompletedTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var rdb *redis.Client

type Span struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

func percentile(sortedDurations []int64, quantile float64) int64 {
	if len(sortedDurations) == 0 {
		return 0
	}
	rank := int(math.Ceil(quantile * float64(len(sortedDurations))))
	if rank < 1 {
		rank = 1
	}
	return sortedDurations[rank-1]
}

func publishCompleted(ctx context.Context, traceID string, spans []Span) ([]map[string]any, error) {
	byService := map[string][]int64{}
	for _, span := range spans {
		byService[span.Service] = append(byService[span.Service], span.DurationMS)
	}

	published := []map[string]any{}
	for service, durations := range byService {
		sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
		event := map[string]any{
			"service":    service,
			"trace_id":   traceID,
			"span_count": len(durations),
			"p50_ms":     percentile(durations, 0.50),
			"p95_ms":     percentile(durations, 0.95),
		}
		payload, _ := json.Marshal(event)
		err := completedWriter.WriteMessages(
			ctx,
			kafka.Message{Key: []byte(service), Value: payload},
		)
		if err != nil {
			return published, err
		}
		published = append(published, event)
	}
	return published, nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   TraceCompletedTopic,
		GroupID: "latency",
	})
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Service   string \`json:"service"\`
			SpanCount int64  \`json:"span_count"\`
		}
		_ = json.Unmarshal(message.Value, &event)
		// Counters first: a crash between the two loses an update, it never skips an event.
		rdb.HIncrBy(ctx, "rollup:"+event.Service, "traces", 1)
		rdb.HIncrBy(ctx, "rollup:"+event.Service, "spans", event.SpanCount)
		_ = reader.CommitMessages(ctx, message)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object TraceEvents {
  val TraceCompletedTopic = "trace.completed"
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  def publishCompleted(traceId: String, spans: Seq[Map[String, Any]]): Unit = {
    // TODO: key by the service id instead of the trace id, keep span tags and user identifiers out
    // of the event, configure the producer for idempotent delivery with acks=all, and update the
    // rollup counters before committing the offset.
    spans.foreach { span =>
      val event = Map(
        "trace_id" -> traceId,
        "span_id" -> span.getOrElse("span_id", ""),
        "duration_ms" -> span.getOrElse("duration_ms", 0)
      )
      producer.send(new ProducerRecord(TraceCompletedTopic, traceId, event.toJson.compactPrint))
    }
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(TraceCompletedTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy(s"rollup:\${event("service").convertTo[String]}", "traces", 1L)
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object TraceEvents {
  val TraceCompletedTopic = "trace.completed"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def percentile(sortedDurations: Seq[Long], quantile: Double): Long = {
    if (sortedDurations.isEmpty) 0L
    else {
      val rank = math.max(1, math.ceil(quantile * sortedDurations.size).toInt)
      sortedDurations(rank - 1)
    }
  }

  def publishCompleted(traceId: String, spans: Seq[Map[String, Any]]): Seq[Map[String, Any]] = {
    val byService = spans.groupBy(_.getOrElse("service", "").toString)
    byService.toSeq.map { case (service, serviceSpans) =>
      val durations = serviceSpans.map(_.getOrElse("duration_ms", 0L).toString.toLong).sorted
      val payload = JsObject(
        "service" -> JsString(service),
        "trace_id" -> JsString(traceId),
        "span_count" -> JsNumber(durations.size),
        "p50_ms" -> JsNumber(percentile(durations, 0.50)),
        "p95_ms" -> JsNumber(percentile(durations, 0.95))
      ).compactPrint
      producer.send(new ProducerRecord(TraceCompletedTopic, service, payload))
      Map(
        "service" -> service,
        "trace_id" -> traceId,
        "span_count" -> durations.size,
        "p50_ms" -> percentile(durations, 0.50),
        "p95_ms" -> percentile(durations, 0.95)
      )
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "latency")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(TraceCompletedTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val service = event("service").convertTo[String]
        val spanCount = event("span_count").convertTo[Int]
        // Counters first: a crash between the two loses an update, it never skips an event.
        jedis.hincrBy(s"rollup:$service", "traces", 1L)
        jedis.hincrBy(s"rollup:$service", "spans", spanCount.toLong)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTraceCompletedTopic = "trace.completed";

std::unique_ptr<RdKafka::Producer> producer;

void publishCompleted(const std::string& traceId, const std::vector<json>& spans) {
  // TODO: key by the service id instead of the trace id, keep span tags and user identifiers out
  // of the event, configure the producer for idempotent delivery with acks=all, and update the
  // rollup counters before committing the offset.
  for (const auto& span : spans) {
    const json event = {
        {"trace_id", traceId},
        {"span_id", span.value("span_id", std::string())},
        {"duration_ms", span.value("duration_ms", 0LL)},
    };
    const auto payload = event.dump();
    producer->produce(
        kTraceCompletedTopic,
        RdKafka::Topic::PARTITION_UA,
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(payload.data()),
        payload.size(),
        traceId.data(),
        traceId.size(),
        0,
        nullptr);
  }
  producer->flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTraceCompletedTopic = "trace.completed";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

long long percentile(const std::vector<long long>& sortedDurations, double quantile) {
  if (sortedDurations.empty()) return 0;
  const auto rank =
      std::max<std::size_t>(1, static_cast<std::size_t>(std::ceil(quantile * sortedDurations.size())));
  return sortedDurations[rank - 1];
}

std::vector<json> publishCompleted(const std::string& traceId, const std::vector<json>& spans) {
  std::map<std::string, std::vector<long long>> byService;
  for (const auto& span : spans) {
    byService[span.value("service", std::string())].push_back(span.value("duration_ms", 0LL));
  }

  std::vector<json> published;
  for (auto& [service, durations] : byService) {
    std::sort(durations.begin(), durations.end());
    const json event = {
        {"service", service},
        {"trace_id", traceId},
        {"span_count", durations.size()},
        {"p50_ms", percentile(durations, 0.50)},
        {"p95_ms", percentile(durations, 0.95)},
    };
    const auto payload = event.dump();
    producer->produce(
        kTraceCompletedTopic,
        RdKafka::Topic::PARTITION_UA,
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(payload.data()),
        payload.size(),
        service.data(),
        service.size(),
        0,
        nullptr);
    published.push_back(event);
  }
  producer->flush(2000);
  return published;
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTraceCompletedTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> message(consumer->consume(200));
    if (message->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(
        static_cast<const char*>(message->payload()),
        static_cast<const char*>(message->payload()) + message->len());
    const auto service = event.value("service", std::string());
    // Counters first: a crash between the two loses an update, it never skips an event.
    redis->hincrby("rollup:" + service, "traces", 1);
    redis->hincrby("rollup:" + service, "spans", event.value("span_count", 0LL));
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is testing the three contracts of a completion topic. The **key** is an ordering contract: a consumer can only rely on order inside a partition, so the key must be the thing whose history you read as a sequence — here the service whose latency stream the rollup maintains. The **payload** is a retention contract: a topic is replicated, retained and read by other teams, so span tags, attributes and user identifiers must not travel through it; counts and percentiles answer the rollup's question without copying anyone's data. The **offset** is a progress contract: state first, then commit, because the commit is a promise that the work is done, and a crash between the two must cost one update rather than silently dropping the event. Real platforms add a schema registry and compatibility checks, per-service partitioning keys that match the consumer's aggregation window, and a dead-letter topic for events their schema cannot read — but every one of those builds on the key, the payload and the order of those two writes.`,
};
