import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Search events keyed by tenant, with a digest instead of the vector',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'events',
  focus: ['search', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is the search event stream: \`publish_search_event(tenant,
request_id, query, k, index_version, latency_ms)\` produces one \`search.query\` record per search,
keyed by the request id with the query vector in the payload, logs a delivery failure and returns
\`True\`; \`consume_search_events\` (group \`search-analytics\`) commits each record, then adds it to
\`searchstats:{tenant}:{index_version}\` (\`searches\`, \`latency_ms_total\`). It serves the demo and
hides five flaws.

**Failure mode the checks target.** One tenant's events spread over every partition; a topic retained
for a week holds every query vector, and embeddings can be inverted back toward their text; a lost
acknowledgement doubles an event and a leader failover drops one; a broker outage drops events
without a trace; and a consumer that crashes between its commit and its counters loses the event.

- The record key is the tenant.
- The payload is \`{request_id, tenant, index_version, k, latency_ms, query_digest}\`, with
  \`query_digest(query)\` in place of the vector.
- The producer is idempotent with \`acks=all\` (kafka-go has no idempotent producer: \`RequireAll\`
  and a synchronous write).
- A produce the delivery report rejects appends \`{"key", "payload"}\` to \`outbox:search.query\` and
  returns \`False\`.
- The consumer updates the counters, then commits.`,
  sequence: {
    participants: ['searchd', 'search.query', 'Redis', 'Analytics consumer'],
    messages: [
      {from: 'searchd', to: 'search.query', label: 'produce key=tenant · {…, query_digest} · acks=all', kind: 'sync'},
      {from: 'search.query', to: 'searchd', label: 'delivery report: delivered / rejected', kind: 'reply'},
      {from: 'searchd', to: 'Redis', label: 'rejected → RPUSH outbox:search.query {key, payload}', kind: 'sync'},
      {from: 'search.query', to: 'Analytics consumer', label: 'consume · group search-analytics', kind: 'async'},
      {from: 'Analytics consumer', to: 'Redis', label: 'HINCRBY searchstats:{tenant}:{version}', kind: 'sync'},
      {from: 'Analytics consumer', to: 'search.query', label: 'commit the offset', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant',
      detail:
        "The record key is the tenant (`key=tenant`, `key: tenant`, `[]byte(tenant)`, `ProducerRecord(Topic, tenant, …)`), so one tenant's events share a partition and stay in order. The starter keys by request id.",
      match: {
        python: {all: [/key\s*=\s*tenant\b/], none: [/key\s*=\s*request_id\b/]},
        typescript: {all: [/key:\s*tenant\b/], none: [/key:\s*requestId\b/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/], none: [/Key:\s*\[\]byte\(requestID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*tenant\b/]},
        cpp: {all: [/tenant\.c_str\(\)\s*,\s*tenant\.(size|length)\(\)/]},
      },
    },
    {
      id: 'no-vector',
      title: 'The event carries the query digest, never the vector',
      detail:
        'The payload carries `query_digest(query)` and no element of the vector: the topic is retained and copied to every consumer. The starter ships the vector itself.',
      match: {
        python: {all: [/query_digest\(/], none: [/["']query["']\s*:\s*query\b/]},
        typescript: {all: [/queryDigest\(/], none: [/,\s*query\s*\}/, /\bquery:\s*query\b/]},
        go: {all: [/fingerprint\.QueryDigest\(/], none: [/json:"query"/]},
        scala: {all: [/Fingerprint\.queryDigest\(/], none: [/"query"\s*->/]},
        cpp: {all: [/fingerprint::queryDigest\(/], none: [/\{"query",\s*query\}/]},
      },
    },
    {
      id: 'delivery',
      title: 'Idempotent producer with acks=all',
      detail:
        'A retry after a lost acknowledgement must not duplicate the record (`enable.idempotence`, kafkajs `idempotent: true`) and a leader failover must not lose it (`acks=all`; kafka-go: `RequiredAcks: kafka.RequireAll` on a synchronous writer). The starter uses one ack and no idempotence.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/], none: [/acks:\s*1\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/], none: [/Async:\s*true/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce leaves an outbox row',
      detail:
        'When the delivery report says the broker rejected the record, `{"key", "payload"}` is appended to `outbox:search.query` and the call returns false, so a relay can republish it. The starter logs the error and reports success.',
      match: {
        python: {all: [/\.rpush\(\s*OUTBOX_KEY/], none: [/except\s+KafkaException/]},
        typescript: {all: [/\.rpush\(\s*OUTBOX_KEY/]},
        go: {all: [/\.RPush\([^\n]*outboxKey/]},
        scala: {all: [/\.rpush\(\s*OutboxKey/]},
        cpp: {all: [/\.rpush\(\s*kOutboxKey/]},
      },
    },
    {
      id: 'commit-after-apply',
      title: 'Counts the event before committing its offset',
      detail:
        'The consumer applies the event to `searchstats:{tenant}:{index_version}`, then commits; committed first, a crash between the two skips the event for good. The starter commits first.',
      match: {
        python: {order: [/apply_event\(json/, /consumer\.commit\(/]},
        typescript: {order: [/applyEvent\(JSON/, /commitOffsets\(/]},
        go: {order: [/applyEvent\(ctx,\s*event\)/, /CommitMessages\(/]},
        scala: {order: [/applyEvent\(record/, /consumer\.commitSync\(/]},
        cpp: {order: [/applyEvent\(json::parse/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaError, Message, Producer

TOPIC = "search.query"
GROUP = "search-analytics"
OUTBOX_KEY = "outbox:search.query"
PRODUCE_TIMEOUT_S = 2.0

logger = logging.getLogger("search.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def stats_key(tenant: str, index_version: str) -> str:
    return f"searchstats:{tenant}:{index_version}"


def on_delivery(err: KafkaError | None, msg: Message) -> None:
    if err is not None:
        logger.warning("search event not delivered: %s", err)


def publish_search_event(tenant: str, request_id: str, query: list[float], k: int, index_version: str, latency_ms: int) -> bool:
    """One search.query event per search; False when the broker rejected it and the event is in the outbox."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {"request_id": request_id, "tenant": tenant, "index_version": index_version, "k": k, "latency_ms": latency_ms, "query": query}
    producer.produce(TOPIC, key=request_id, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)
    return True


def apply_event(event: dict) -> None:
    """Fold one event into the tenant's counters for its index version."""
    key = stats_key(event["tenant"], event["index_version"])
    r.hincrby(key, "searches", 1)
    r.hincrby(key, "latency_ms_total", int(event["latency_ms"]))


def consume_search_events() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            logger.error("consumer error: %s", msg.error())
            continue
        consumer.commit(message=msg, asynchronous=False)
        apply_event(json.loads(msg.value()))
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaError, Message, Producer

from search.fingerprint import query_digest

TOPIC = "search.query"
GROUP = "search-analytics"
OUTBOX_KEY = "outbox:search.query"
PRODUCE_TIMEOUT_S = 2.0

logger = logging.getLogger("search.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def stats_key(tenant: str, index_version: str) -> str:
    return f"searchstats:{tenant}:{index_version}"


def publish_search_event(tenant: str, request_id: str, query: list[float], k: int, index_version: str, latency_ms: int) -> bool:
    """One search.query event per search; False when the broker rejected it and the event is in the outbox."""
    # The digest groups repeated queries; the vector stays in the request.
    payload = json.dumps({"request_id": request_id, "tenant": tenant, "index_version": index_version, "k": k, "latency_ms": latency_ms, "query_digest": query_digest(query)})
    rejected: list[KafkaError] = []

    def on_delivery(err: KafkaError | None, msg: Message) -> None:
        if err is not None:
            rejected.append(err)

    producer.produce(TOPIC, key=tenant, value=payload, on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)  # the delivery report fires here, delivered or rejected
    if rejected:
        r.rpush(OUTBOX_KEY, json.dumps({"key": tenant, "payload": payload}))
        logger.warning("search event %s rejected: %s", request_id, rejected[0])
        return False
    return True


def apply_event(event: dict) -> None:
    """Fold one event into the tenant's counters for its index version."""
    key = stats_key(event["tenant"], event["index_version"])
    r.hincrby(key, "searches", 1)
    r.hincrby(key, "latency_ms_total", int(event["latency_ms"]))


def consume_search_events() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            logger.error("consumer error: %s", msg.error())
            continue
        apply_event(json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)  # only once the event is counted
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const TOPIC = 'search.query';
export const GROUP = 'search-analytics';
export const OUTBOX_KEY = 'outbox:search.query';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'searchd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One search.query event as it crosses the topic. */
export interface SearchEvent {
  request_id: string;
  tenant: string;
  index_version: string;
  k: number;
  latency_ms: number;
}

export function statsKey(tenant: string, indexVersion: string): string {
  return \`searchstats:\${tenant}:\${indexVersion}\`;
}

/** One search.query event per search; false when the broker rejected it and the event is in the outbox. */
export async function publishSearchEvent(
  tenant: string,
  requestId: string,
  query: number[],
  k: number,
  indexVersion: string,
  latencyMs: number,
): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {request_id: requestId, tenant, index_version: indexVersion, k, latency_ms: latencyMs, query};
  try {
    await producer.send({topic: TOPIC, messages: [{key: requestId, value: JSON.stringify(payload)}], acks: 1});
  } catch (e) {
    console.warn(\`search event not delivered: \${e instanceof Error ? e.message : String(e)}\`);
  }
  return true;
}

/** Fold one event into the tenant's counters for its index version. */
export async function applyEvent(event: SearchEvent): Promise<void> {
  const key = statsKey(event.tenant, event.index_version);
  await redis.hincrby(key, 'searches', 1);
  await redis.hincrby(key, 'latency_ms_total', event.latency_ms);
}

export async function consumeSearchEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await applyEvent(JSON.parse(String(message.value)) as SearchEvent);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {queryDigest} from 'search/fingerprint';

export const TOPIC = 'search.query';
export const GROUP = 'search-analytics';
export const OUTBOX_KEY = 'outbox:search.query';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'searchd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One search.query event as it crosses the topic. */
export interface SearchEvent {
  request_id: string;
  tenant: string;
  index_version: string;
  k: number;
  latency_ms: number;
}

export function statsKey(tenant: string, indexVersion: string): string {
  return \`searchstats:\${tenant}:\${indexVersion}\`;
}

/** One search.query event per search; false when the broker rejected it and the event is in the outbox. */
export async function publishSearchEvent(
  tenant: string,
  requestId: string,
  query: number[],
  k: number,
  indexVersion: string,
  latencyMs: number,
): Promise<boolean> {
  // The digest groups repeated queries; the vector stays in the request.
  const payload = JSON.stringify({request_id: requestId, tenant, index_version: indexVersion, k, latency_ms: latencyMs, query_digest: queryDigest(query)});
  try {
    await producer.send({topic: TOPIC, messages: [{key: tenant, value: payload}], acks: -1});
    return true;
  } catch (e) {
    // A rejected send is the broker's delivery report: keep the event for the relay.
    await redis.rpush(OUTBOX_KEY, JSON.stringify({key: tenant, payload}));
    console.warn(\`search event \${requestId} rejected: \${e instanceof Error ? e.message : String(e)}\`);
    return false;
  }
}

/** Fold one event into the tenant's counters for its index version. */
export async function applyEvent(event: SearchEvent): Promise<void> {
  const key = statsKey(event.tenant, event.index_version);
  await redis.hincrby(key, 'searches', 1);
  await redis.hincrby(key, 'latency_ms_total', event.latency_ms);
}

export async function consumeSearchEvents(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await applyEvent(JSON.parse(String(message.value)) as SearchEvent);
      // Only once the event is counted.
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
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic     = "search.query"
	group     = "search-analytics"
	outboxKey = "outbox:search.query"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// SearchEvent is one search.query event as it crosses the topic.
type SearchEvent struct {
	RequestID    string    \`json:"request_id"\`
	Tenant       string    \`json:"tenant"\`
	IndexVersion string    \`json:"index_version"\`
	K            int       \`json:"k"\`
	LatencyMs    int64     \`json:"latency_ms"\`
	Query        []float64 \`json:"query"\`
}

func statsKey(tenant, indexVersion string) string {
	return "searchstats:" + tenant + ":" + indexVersion
}

// publishSearchEvent produces one search.query event per search; false when the broker rejected it and the event is in the outbox.
func publishSearchEvent(ctx context.Context, tenant, requestID string, query []float64, k int, indexVersion string, latencyMs int64) bool {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(SearchEvent{RequestID: requestID, Tenant: tenant, IndexVersion: indexVersion, K: k, LatencyMs: latencyMs, Query: query})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(requestID), Value: payload}); err != nil {
		log.Printf("search event not delivered: %v", err)
	}
	return true
}

// applyEvent folds one event into the tenant's counters for its index version.
func applyEvent(ctx context.Context, event SearchEvent) error {
	key := statsKey(event.Tenant, event.IndexVersion)
	if err := rdb.HIncrBy(ctx, key, "searches", 1).Err(); err != nil {
		return err
	}
	return rdb.HIncrBy(ctx, key, "latency_ms_total", event.LatencyMs).Err()
}

func consumeSearchEvents(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event SearchEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := applyEvent(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"search/fingerprint" // fingerprint.QueryDigest
)

const (
	topic     = "search.query"
	group     = "search-analytics"
	outboxKey = "outbox:search.query"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// SearchEvent is one search.query event as it crosses the topic.
type SearchEvent struct {
	RequestID    string \`json:"request_id"\`
	Tenant       string \`json:"tenant"\`
	IndexVersion string \`json:"index_version"\`
	K            int    \`json:"k"\`
	LatencyMs    int64  \`json:"latency_ms"\`
	QueryDigest  string \`json:"query_digest"\`
}

func statsKey(tenant, indexVersion string) string {
	return "searchstats:" + tenant + ":" + indexVersion
}

// publishSearchEvent produces one search.query event per search; false when the broker rejected it and the event is in the outbox.
func publishSearchEvent(ctx context.Context, tenant, requestID string, query []float64, k int, indexVersion string, latencyMs int64) bool {
	// The digest groups repeated queries; the vector stays in the request.
	payload, _ := json.Marshal(SearchEvent{RequestID: requestID, Tenant: tenant, IndexVersion: indexVersion, K: k, LatencyMs: latencyMs, QueryDigest: fingerprint.QueryDigest(query)})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload}); err != nil {
		// The returned error is the broker's answer: keep the event for the relay.
		row, _ := json.Marshal(map[string]string{"key": tenant, "payload": string(payload)})
		rdb.RPush(ctx, outboxKey, string(row))
		log.Printf("search event %s rejected: %v", requestID, err)
		return false
	}
	return true
}

// applyEvent folds one event into the tenant's counters for its index version.
func applyEvent(ctx context.Context, event SearchEvent) error {
	key := statsKey(event.Tenant, event.IndexVersion)
	if err := rdb.HIncrBy(ctx, key, "searches", 1).Err(); err != nil {
		return err
	}
	return rdb.HIncrBy(ctx, key, "latency_ms_total", event.LatencyMs).Err()
}

func consumeSearchEvents(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event SearchEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := applyEvent(ctx, event); err != nil {
			return err
		}
		// Only once the event is counted.
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

object Events {
  val Topic = "search.query"
  val Group = "search-analytics"
  val OutboxKey = "outbox:search.query"

  val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "1")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  def statsKey(tenant: String, indexVersion: String): String = s"searchstats:$tenant:$indexVersion"

  /** One search.query event per search; false when the broker rejected it and the event is in the outbox. */
  def publishSearchEvent(tenant: String, requestId: String, query: Seq[Double], k: Int, indexVersion: String, latencyMs: Long): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "request_id" -> JsString(requestId),
      "tenant" -> JsString(tenant),
      "index_version" -> JsString(indexVersion),
      "k" -> JsNumber(k),
      "latency_ms" -> JsNumber(latencyMs),
      "query" -> JsArray(query.map(JsNumber(_)).toVector),
    ).compactPrint
    producer.send(
      new ProducerRecord[String, String](Topic, requestId, payload),
      new Callback {
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) System.err.println(s"search event not delivered: \${exception.getMessage}")
      },
    )
    producer.flush()
    true
  }

  /** Fold one event into the tenant's counters for its index version. */
  def applyEvent(event: JsObject): Unit = {
    val fields = event.fields
    val key = statsKey(fields("tenant").asInstanceOf[JsString].value, fields("index_version").asInstanceOf[JsString].value)
    jedis.hincrBy(key, "searches", 1L)
    jedis.hincrBy(key, "latency_ms_total", fields("latency_ms").asInstanceOf[JsNumber].value.toLong)
  }

  def consumeSearchEvents(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { (record: ConsumerRecord[String, String]) =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        applyEvent(record.value().parseJson.asJsObject)
      }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import search.Fingerprint // Fingerprint.queryDigest

object Events {
  val Topic = "search.query"
  val Group = "search-analytics"
  val OutboxKey = "outbox:search.query"

  val jedis = new JedisPooled("redis", 6379)

  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  def statsKey(tenant: String, indexVersion: String): String = s"searchstats:$tenant:$indexVersion"

  /** One search.query event per search; false when the broker rejected it and the event is in the outbox. */
  def publishSearchEvent(tenant: String, requestId: String, query: Seq[Double], k: Int, indexVersion: String, latencyMs: Long): Boolean = {
    // The digest groups repeated queries; the vector stays in the request.
    val payload = JsObject(
      "request_id" -> JsString(requestId),
      "tenant" -> JsString(tenant),
      "index_version" -> JsString(indexVersion),
      "k" -> JsNumber(k),
      "latency_ms" -> JsNumber(latencyMs),
      "query_digest" -> JsString(Fingerprint.queryDigest(query)),
    ).compactPrint
    val rejected = new AtomicBoolean(false)
    producer.send(
      new ProducerRecord[String, String](Topic, tenant, payload),
      new Callback {
        // The delivery report is the broker's answer: keep a rejected event for the relay.
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) {
            rejected.set(true)
            jedis.rpush(OutboxKey, JsObject("key" -> JsString(tenant), "payload" -> JsString(payload)).compactPrint)
          }
      },
    )
    producer.flush() // the callback has run once flush returns, delivered or rejected
    !rejected.get
  }

  /** Fold one event into the tenant's counters for its index version. */
  def applyEvent(event: JsObject): Unit = {
    val fields = event.fields
    val key = statsKey(fields("tenant").asInstanceOf[JsString].value, fields("index_version").asInstanceOf[JsString].value)
    jedis.hincrBy(key, "searches", 1L)
    jedis.hincrBy(key, "latency_ms_total", fields("latency_ms").asInstanceOf[JsNumber].value.toLong)
  }

  def consumeSearchEvents(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { (record: ConsumerRecord[String, String]) =>
        applyEvent(record.value().parseJson.asJsObject)
        // Only once the event is counted.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "search.query";
const std::string kGroup = "search-analytics";
const std::string kOutboxKey = "outbox:search.query";
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "search event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string statsKey(const std::string& tenant, const std::string& index_version) { return "searchstats:" + tenant + ":" + index_version; }

// One search.query event per search; false when the broker rejected it and the event is in the outbox.
bool publishSearchEvent(const std::string& tenant, const std::string& request_id, const std::vector<double>& query, long k,
                        const std::string& index_version, long latency_ms) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string payload =
      json{{"request_id", request_id}, {"tenant", tenant}, {"index_version", index_version}, {"k", k}, {"latency_ms", latency_ms}, {"query", query}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(),
                    request_id.c_str(), request_id.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);
  return true;
}

// Fold one event into the tenant's counters for its index version.
void applyEvent(const json& event) {
  const std::string key = statsKey(event.value("tenant", ""), event.value("index_version", ""));
  redis.hincrby(key, "searches", 1);
  redis.hincrby(key, "latency_ms_total", event.value("latency_ms", 0L));
}

void consumeSearchEvents() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    consumer->commitSync(msg.get());
    applyEvent(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "search/fingerprint.h"  // fingerprint::queryDigest

using json = nlohmann::json;

const std::string kTopic = "search.query";
const std::string kGroup = "search-analytics";
const std::string kOutboxKey = "outbox:search.query";
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report of the last produce: what the broker said once flush() served it.
class LastReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;
  std::string errstr;
  void dr_cb(RdKafka::Message& message) override {
    err = message.err();
    errstr = message.errstr();
  }
};

LastReport report;

// Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string statsKey(const std::string& tenant, const std::string& index_version) { return "searchstats:" + tenant + ":" + index_version; }

// One search.query event per search; false when the broker rejected it and the event is in the outbox.
bool publishSearchEvent(const std::string& tenant, const std::string& request_id, const std::vector<double>& query, long k,
                        const std::string& index_version, long latency_ms) {
  // The digest groups repeated queries; the vector stays in the request.
  const std::string payload = json{{"request_id", request_id}, {"tenant", tenant}, {"index_version", index_version}, {"k", k},
                                   {"latency_ms", latency_ms}, {"query_digest", fingerprint::queryDigest(query)}}
                                  .dump();
  report.err = RdKafka::ERR_NO_ERROR;
  const RdKafka::ErrorCode queued = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                                     payload.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);  // the delivery report fires here, delivered or rejected
  if (queued != RdKafka::ERR_NO_ERROR || report.err != RdKafka::ERR_NO_ERROR) {
    redis.rpush(kOutboxKey, json{{"key", tenant}, {"payload", payload}}.dump());
    std::cerr << "search event " << request_id << " rejected: " << (queued != RdKafka::ERR_NO_ERROR ? RdKafka::err2str(queued) : report.errstr) << "\\n";
    return false;
  }
  return true;
}

// Fold one event into the tenant's counters for its index version.
void applyEvent(const json& event) {
  const std::string key = statsKey(event.value("tenant", ""), event.value("index_version", ""));
  redis.hincrby(key, "searches", 1);
  redis.hincrby(key, "latency_ms_total", event.value("latency_ms", 0L));
}

void consumeSearchEvents() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    applyEvent(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
    consumer->commitSync(msg.get());  // only once the event is counted
  }
}
`,
    },
  },
  harness: {
    python: `import json

from search.fingerprint import query_digest

TOPIC = "search.query"
GROUP = "search-analytics"
OUTBOX = "outbox:search.query"
QUERY = [0.125, -0.5, 0.75, 0.0625]
WIRE = {"request_id", "tenant", "index_version", "k", "latency_ms", "query_digest"}


def _publish(m, tenant="acme", request_id="r-1", latency_ms=12):
    return m.publish_search_event(tenant, request_id, QUERY, 10, "idx-42", latency_ms)


def _event(request_id, latency_ms):
    return json.dumps({"request_id": request_id, "tenant": "acme", "index_version": "idx-42", "k": 10, "latency_ms": latency_ms, "query_digest": query_digest(QUERY)})


def check_tenant_key(ctx):
    m = ctx.load("events")
    for tenant, request_id in (("acme", "r-1"), ("globex", "r-2"), ("acme", "r-3")):
        delivered = _publish(m, tenant, request_id)
        assert delivered is True, f"publish_search_event returned {delivered!r} on a healthy broker, expected True"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three searches produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"globex", b"acme"], f"records must be keyed by the tenant, got {keys}"
    assert records[0].partition == records[2].partition, "acme's two events must land on one partition so they are read in order"


def check_no_vector(ctx):
    m = ctx.load("events")
    _publish(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one search produced {len(records)} records"
    text = records[0].value.decode()
    event = json.loads(text)
    assert "query" not in event and "0.125" not in text and "0.0625" not in text, f"the event carries the query vector: {text}. The topic is retained and copied to every consumer; the digest is enough to group repeated queries"
    missing = WIRE - set(event)
    assert not missing, f"the event {text} lacks {sorted(missing)}"
    assert event["query_digest"] == query_digest(QUERY), f"query_digest must be query_digest(query), got {event['query_digest']!r}"
    assert event["request_id"] == "r-1" and event["tenant"] == "acme" and event["k"] == 10 and event["index_version"] == "idx-42" and event["latency_ms"] == 12, f"the event's fields must be the search's: {text}"


def check_delivery(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    delivered = _publish(m)
    assert delivered is True, f"publish_search_event returned {delivered!r}: a lost acknowledgement is retried by the client, not reported"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"after one lost acknowledgement the topic holds {len(records)} records, expected 1: the retry duplicated the event (enable.idempotence)"
    _publish(m, request_id="r-2")
    ctx.kafka.failover(TOPIC)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"after a leader failover the topic holds {len(records)} records, expected 2: a record acknowledged by the leader alone is lost (acks=all)"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    delivered = _publish(m)
    rows = ctx.redis.lrange(OUTBOX, 0, -1)
    assert len(rows) == 1, f"after the broker rejected the produce {OUTBOX} holds {rows}, expected one row with the event"
    row = json.loads(rows[0])
    assert row.get("key") == "acme", f"the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition: {row}"
    payload = json.loads(row["payload"]) if isinstance(row.get("payload"), str) else row.get("payload")
    assert isinstance(payload, dict) and payload.get("request_id") == "r-1", f"the outbox row must carry the event payload: {row}"
    assert delivered is False, f"publish_search_event returned {delivered!r} for a rejected event, expected False"
    assert ctx.kafka.records(TOPIC) == [], "a rejected produce cannot be on the topic"
    assert _publish(m, "globex", "r-2") is True, "once the broker answers again the event is delivered"
    assert len(ctx.redis.lrange(OUTBOX, 0, -1)) == 1, "a delivered event leaves no outbox row"


def check_commit_after_apply(ctx):
    m = ctx.load("events")
    ctx.kafka.seed(TOPIC, key="acme", value=_event("r-1", 10))
    ctx.kafka.seed(TOPIC, key="acme", value=_event("r-2", 30))
    seen = []
    ctx.kafka.on_commit(lambda group, offsets: seen.append(ctx.redis.hget("searchstats:acme:idx-42", "searches")))
    ctx.drain(m.consume_search_events)
    stats = ctx.redis.hgetall("searchstats:acme:idx-42")
    assert stats.get("searches") == "2" and stats.get("latency_ms_total") == "40", f"searchstats:acme:idx-42 holds {stats}, expected searches 2 and latency_ms_total 40"
    assert seen == ["1", "2"], f"at each commit the counter read {seen}, expected ['1', '2']: an offset was committed before its event was counted, so a crash between the two skips the event"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"the consumer left {ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted"
`,
    typescript: `const TOPIC = 'search.query';
const GROUP = 'search-analytics';
const OUTBOX = 'outbox:search.query';
const QUERY = [0.125, -0.5, 0.75, 0.0625];
const WIRE = ['request_id', 'tenant', 'index_version', 'k', 'latency_ms', 'query_digest'];

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

async function publish(m, tenant = 'acme', requestId = 'r-1', latencyMs = 12): Promise<unknown> {
  const delivered = await m.publishSearchEvent(tenant, requestId, QUERY, 10, 'idx-42', latencyMs);
  await settle();
  return delivered;
}

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  for (const [tenant, requestId] of [['acme', 'r-1'], ['globex', 'r-2'], ['acme', 'r-3']]) {
    const delivered = await publish(m, tenant, requestId);
    assert.equal(delivered, true, \`publishSearchEvent returned \${delivered} on a healthy broker, expected true\`);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three searches produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['acme', 'globex', 'acme'], \`records must be keyed by the tenant, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[2].partition, "acme's two events must land on one partition so they are read in order");
}

export async function check_no_vector(ctx) {
  const m = ctx.load('events');
  const {queryDigest} = ctx.load('/support/search/fingerprint.ts');
  await publish(m);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one search produced \${records.length} records\`);
  const text = records[0].value.toString();
  const event = JSON.parse(text);
  assert(!('query' in event) && !text.includes('0.125') && !text.includes('0.0625'), \`the event carries the query vector: \${text}. The topic is retained and copied to every consumer; the digest is enough to group repeated queries\`);
  const missing = WIRE.filter(f => !(f in event));
  assert.equal(missing.length, 0, \`the event \${text} lacks \${JSON.stringify(missing)}\`);
  assert.equal(event.query_digest, queryDigest(QUERY), \`query_digest must be queryDigest(query), got \${JSON.stringify(event.query_digest)}\`);
  assert(event.request_id === 'r-1' && event.tenant === 'acme' && event.k === 10 && event.index_version === 'idx-42' && event.latency_ms === 12, \`the event's fields must be the search's: \${text}\`);
}

export async function check_delivery(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  const delivered = await publish(m);
  assert.equal(delivered, true, \`publishSearchEvent returned \${delivered}: a lost acknowledgement is retried by the client, not reported\`);
  let records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`after one lost acknowledgement the topic holds \${records.length} records, expected 1: the retry duplicated the event (idempotent: true)\`);
  await publish(m, 'acme', 'r-2');
  ctx.kafka.failover(TOPIC);
  records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 2, \`after a leader failover the topic holds \${records.length} records, expected 2: a record acknowledged by the leader alone is lost (acks: -1)\`);
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  const delivered = await publish(m);
  const rows = ctx.redis.lrange(OUTBOX, 0, -1);
  assert.equal(rows.length, 1, \`after the broker rejected the produce \${OUTBOX} holds \${JSON.stringify(rows)}, expected one row with the event\`);
  const row = JSON.parse(rows[0]);
  assert.equal(row.key, 'acme', \`the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition: \${rows[0]}\`);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  assert(payload !== null && typeof payload === 'object' && payload.request_id === 'r-1', \`the outbox row must carry the event payload: \${rows[0]}\`);
  assert.equal(delivered, false, \`publishSearchEvent returned \${delivered} for a rejected event, expected false\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a rejected produce cannot be on the topic');
  assert.equal(await publish(m, 'globex', 'r-2'), true, 'once the broker answers again the event is delivered');
  assert.equal(ctx.redis.lrange(OUTBOX, 0, -1).length, 1, 'a delivered event leaves no outbox row');
}

export async function check_commit_after_apply(ctx) {
  const m = ctx.load('events');
  const {queryDigest} = ctx.load('/support/search/fingerprint.ts');
  const event = (requestId: string, latencyMs: number) =>
    JSON.stringify({request_id: requestId, tenant: 'acme', index_version: 'idx-42', k: 10, latency_ms: latencyMs, query_digest: queryDigest(QUERY)});
  ctx.kafka.seed(TOPIC, {key: 'acme', value: event('r-1', 10)});
  ctx.kafka.seed(TOPIC, {key: 'acme', value: event('r-2', 30)});
  const seen: (string | null)[] = [];
  ctx.kafka.onCommit(() => seen.push(ctx.redis.hget('searchstats:acme:idx-42', 'searches')));
  await ctx.drain(m.consumeSearchEvents());
  const stats = ctx.redis.hgetall('searchstats:acme:idx-42');
  assert(stats.searches === '2' && stats.latency_ms_total === '40', \`searchstats:acme:idx-42 holds \${JSON.stringify(stats)}, expected searches 2 and latency_ms_total 40\`);
  assert.deepStrictEqual(seen, ['1', '2'], \`at each commit the counter read \${JSON.stringify(seen)}, expected ["1","2"]: an offset was committed before its event was counted, so a crash between the two skips the event\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`the consumer left \${ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"search/fingerprint"

	"leetbuild/harness"
)

const (
	eventsTopic  = "search.query"
	eventsGroup  = "search-analytics"
	eventsOutbox = "outbox:search.query"
)

var (
	eventsBg    = context.Background()
	eventsQuery = []float64{0.125, -0.5, 0.75, 0.0625}
	eventsWire  = []string{"request_id", "tenant", "index_version", "k", "latency_ms", "query_digest"}
)

func eventsPublish(tenant, requestID string) bool {
	return publishSearchEvent(eventsBg, tenant, requestID, eventsQuery, 10, "idx-42", 12)
}

func seededEvent(requestID string, latencyMs int) string {
	raw, _ := json.Marshal(map[string]any{"request_id": requestID, "tenant": "acme", "index_version": "idx-42", "k": 10, "latency_ms": latencyMs, "query_digest": fingerprint.QueryDigest(eventsQuery)})
	return string(raw)
}

func CheckTenantKey(ctx *harness.Ctx) {
	for _, in := range [][2]string{{"acme", "r-1"}, {"globex", "r-2"}, {"acme", "r-3"}} {
		ctx.Equal(eventsPublish(in[0], in[1]), true, "publishSearchEvent on a healthy broker must report the event delivered")
	}
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three searches must produce three records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"acme", "globex", "acme"}, "records must be keyed by the tenant")
	ctx.Equal(records[0].Partition, records[2].Partition, "acme's two events must land on one partition so they are read in order; acme's partitions")
}

func CheckNoVector(ctx *harness.Ctx) {
	eventsPublish("acme", "r-1")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one search must produce one record; the records")
	text := string(records[0].Value)
	var event map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &event), "the event must be JSON (%s)", text)
	_, hasQuery := event["query"]
	ctx.Assert(!hasQuery && !strings.Contains(text, "0.125") && !strings.Contains(text, "0.0625"), "the event carries the query vector: %s. The topic is retained and copied to every consumer; the digest is enough to group repeated queries", text)
	for _, field := range eventsWire {
		_, ok := event[field]
		ctx.Assert(ok, "the event %s lacks %s", text, field)
	}
	ctx.Equal(event["query_digest"], fingerprint.QueryDigest(eventsQuery), "query_digest must be fingerprint.QueryDigest(query)")
	ctx.Assert(event["request_id"] == "r-1" && event["tenant"] == "acme" && event["k"] == float64(10) && event["index_version"] == "idx-42" && event["latency_ms"] == float64(12), "the event's fields must be the search's: %s", text)
}

func CheckDelivery(ctx *harness.Ctx) {
	ctx.Equal(eventsPublish("acme", "r-1"), true, "publishSearchEvent on a healthy broker must report the event delivered")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one search must produce one record; the records")
	lost := ctx.Kafka.Failover(eventsTopic)
	ctx.Equal(lost, 0, "a leader failover right after the write lost the record: it was acknowledged by the leader alone (RequiredAcks: kafka.RequireAll, a synchronous write); records lost")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after a leader failover the record must still be on the topic; the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	delivered := eventsPublish("acme", "r-1")
	ctx.Settle()
	rows := ctx.Redis.LRange(eventsOutbox, 0, -1)
	ctx.Equal(len(rows), 1, "after the broker rejected the produce %s must hold one row with the event; it holds %v; rows", eventsOutbox, rows)
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "the outbox row must be JSON (%s)", rows[0])
	ctx.Equal(row["key"], "acme", "the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition (%s)", rows[0])
	var payload map[string]any
	switch p := row["payload"].(type) {
	case string:
		json.Unmarshal([]byte(p), &payload)
	case map[string]any:
		payload = p
	}
	ctx.Assert(payload != nil && payload["request_id"] == "r-1", "the outbox row must carry the event payload: %s", rows[0])
	ctx.Equal(delivered, false, "publishSearchEvent must report a rejected event as not delivered")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "a rejected produce cannot be on the topic; the records")
	ctx.Equal(eventsPublish("globex", "r-2"), true, "once the broker answers again the event is delivered")
	ctx.Settle()
	ctx.Equal(len(ctx.Redis.LRange(eventsOutbox, 0, -1)), 1, "a delivered event leaves no outbox row; the rows")
}

func CheckCommitAfterApply(ctx *harness.Ctx) {
	ctx.Kafka.Seed(eventsTopic, "acme", seededEvent("r-1", 10))
	ctx.Kafka.Seed(eventsTopic, "acme", seededEvent("r-2", 30))
	seen := []string{}
	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) {
		searches, _ := ctx.Redis.HGet("searchstats:acme:idx-42", "searches")
		seen = append(seen, searches)
	})
	ctx.Drain(func() { consumeSearchEvents(eventsBg) })
	stats := ctx.Redis.HGetAll("searchstats:acme:idx-42")
	ctx.Assert(stats["searches"] == "2" && stats["latency_ms_total"] == "40", "searchstats:acme:idx-42 holds %v, expected searches 2 and latency_ms_total 40", stats)
	ctx.Equal(seen, []string{"1", "2"}, "at each commit the counter must already count the committed event; a commit before the count means a crash between the two skips the event; the counter at each commit")
	ctx.Equal(ctx.Kafka.Lag(eventsGroup, eventsTopic), 0, "records the consumer left uncommitted")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "search/fingerprint.h"

namespace {

const std::string kEventsTopic = "search.query";
const std::string kEventsGroup = "search-analytics";
const std::string kEventsOutbox = "outbox:search.query";
const std::vector<double> kEventsQuery = {0.125, -0.5, 0.75, 0.0625};
const std::vector<std::string> kWire = {"request_id", "tenant", "index_version", "k", "latency_ms", "query_digest"};

bool eventsPublish(const std::string& tenant, const std::string& request_id) {
  return publishSearchEvent(tenant, request_id, kEventsQuery, 10, "idx-42", 12);
}

std::string seededEvent(const std::string& request_id, long latency_ms) {
  return nlohmann::json{{"request_id", request_id}, {"tenant", "acme"}, {"index_version", "idx-42"}, {"k", 10}, {"latency_ms", latency_ms},
                        {"query_digest", fingerprint::queryDigest(kEventsQuery)}}
      .dump();
}

nlohmann::json parsed(const std::string& text) {
  const auto j = nlohmann::json::parse(text, nullptr, false);
  return j.is_discarded() ? nlohmann::json() : j;
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  ctx.Equal(eventsPublish("acme", "r-1"), true, "publishSearchEvent on a healthy broker must report the event delivered");
  ctx.Equal(eventsPublish("globex", "r-2"), true, "publishSearchEvent on a healthy broker must report the event delivered");
  ctx.Equal(eventsPublish("acme", "r-3"), true, "publishSearchEvent on a healthy broker must report the event delivered");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three searches must produce three records on %s; the records", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"acme", "globex", "acme"}, "records must be keyed by the tenant");
  ctx.Equal(records[0].Partition, records[2].Partition, "acme's two events must land on one partition so they are read in order; acme's partitions");
}

void CheckNoVector(harness::Ctx& ctx) {
  eventsPublish("acme", "r-1");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one search must produce one record; the records");
  const std::string text = records[0].Value.value_or("");
  const auto event = parsed(text);
  ctx.Assert(event.is_object(), "the event must be JSON: %s", text);
  ctx.Assert(!event.contains("query") && text.find("0.125") == std::string::npos && text.find("0.0625") == std::string::npos,
             "the event carries the query vector: %s. The topic is retained and copied to every consumer; the digest is enough to group repeated queries", text);
  for (const auto& f : kWire) ctx.Assert(event.contains(f), "the event %s lacks %s", text, f);
  ctx.Equal(event.value("query_digest", std::string()), fingerprint::queryDigest(kEventsQuery), "query_digest must be fingerprint::queryDigest(query)");
  ctx.Assert(event["request_id"] == "r-1" && event["tenant"] == "acme" && event["k"] == 10 && event["index_version"] == "idx-42" && event["latency_ms"] == 12,
             "the event's fields must be the search's: %s", text);
}

void CheckDelivery(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);
  ctx.Equal(eventsPublish("acme", "r-1"), true, "publishSearchEvent must report the event delivered: a lost acknowledgement is retried by the client, not reported");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the topic must hold one record: the retry duplicated the event (enable.idempotence); the records");
  eventsPublish("acme", "r-2");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "after a leader failover the topic must hold both records: a record acknowledged by the leader alone is lost (acks=all); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const bool delivered = eventsPublish("acme", "r-1");
  ctx.Settle();
  const auto rows = ctx.Redis.LRange(kEventsOutbox, 0, -1);
  ctx.Equal(rows.size(), 1, "after the broker rejected the produce %s must hold one row with the event; it holds %v; rows", kEventsOutbox, rows);
  const auto row = parsed(rows[0]);
  ctx.Assert(row.is_object() && row.value("key", std::string()) == "acme", "the outbox row must carry the message key (the tenant) so the relay publishes it to the same partition (%s)", rows[0]);
  nlohmann::json payload;
  if (row.contains("payload")) payload = row["payload"].is_string() ? parsed(row["payload"].get<std::string>()) : row["payload"];
  ctx.Assert(payload.is_object() && payload.value("request_id", std::string()) == "r-1", "the outbox row must carry the event payload: %s", rows[0]);
  ctx.Equal(delivered, false, "publishSearchEvent must report a rejected event as not delivered");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "a rejected produce cannot be on the topic; the records");
  ctx.Equal(eventsPublish("globex", "r-2"), true, "once the broker answers again the event is delivered");
  ctx.Settle();
  ctx.Equal(ctx.Redis.LRange(kEventsOutbox, 0, -1).size(), 1, "a delivered event leaves no outbox row; the rows");
}

void CheckCommitAfterApply(harness::Ctx& ctx) {
  ctx.Kafka.Seed(kEventsTopic, std::string("acme"), seededEvent("r-1", 10));
  ctx.Kafka.Seed(kEventsTopic, std::string("acme"), seededEvent("r-2", 30));
  auto seen = std::make_shared<std::vector<std::string>>();
  ctx.Kafka.OnCommit([&ctx, seen](const std::string&, const harness::KafkaOffsets&) {
    seen->push_back(ctx.Redis.HGet("searchstats:acme:idx-42", "searches").value_or(""));
  });
  ctx.Drain([] { consumeSearchEvents(); });
  const auto stats = ctx.Redis.HGetAll("searchstats:acme:idx-42");
  const auto field = [&stats](const std::string& f) { return stats.count(f) ? stats.at(f) : std::string(); };
  ctx.Assert(field("searches") == "2" && field("latency_ms_total") == "40", "searchstats:acme:idx-42 holds %v, expected searches 2 and latency_ms_total 40", stats);
  ctx.Equal(*seen, std::vector<std::string>{"1", "2"}, "at each commit the counter must already count the committed event; a commit before the count means a crash between the two skips the event; the counter at each commit");
  ctx.Equal(ctx.Kafka.Lag(kEventsGroup, kEventsTopic), 0, "records the consumer left uncommitted");
}
`,
  },
  hints: [
    "One tenant's events land on three partitions; the topic holds every query vector; after a lost acknowledgement the dashboard counts a search twice; during a broker outage events vanish; a consumer restart skips a search.",
    'The key is the request id, the payload copies `query`, the producer runs with `acks=1` and no idempotence, the delivery report only logs, and the consumer commits before `apply_event`.',
    'Produce with `key=tenant`, put `query_digest(query)` where `query` was, set `enable.idempotence` and `acks=all`, collect the error in `on_delivery`, after `flush` RPUSH `{"key", "payload"}` to `OUTBOX_KEY` and return `False`, and commit after `apply_event`.',
  ],
  debrief: `The key is the tenant because the key picks the partition, and a partition is the only unit Kafka keeps in order. The digest gives analytics what it needs, how often one query repeats per tenant and version, without putting the vector in a topic that every consumer copies and that outlives the request by days. The outbox row is written from the delivery report because the report is the broker's answer; an exception around \`produce\` sees only a full local queue. Committing after the counters makes delivery at least once, so a replay after a crash can count an event twice; production consumers record the \`request_id\` with the counter update to make it idempotent, and a relay drains the outbox back onto the topic.`,
};
