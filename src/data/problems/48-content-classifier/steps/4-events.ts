import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Classification events keyed by tenant, text hashed',
  concept: 'kafka',
  file: 'events',
  focus: ['classifier', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** \`publish(event)\` produces one \`classify.result\` record keyed by the first
label, with the request id, tenant, taxonomy version, labels and the full text in the payload, on a
producer with default settings. \`run_consumer\` polls the topic, commits the offset, then increments
a per-tenant counter. The demo shows numbers going up. It hides 5 flaws.

**Failure mode the checks target.** The label key is a silent ordering bug that only shows up in
per-tenant dashboards; the text in the payload is a data leak with a retention tail measured in days;
and commit-before-process trades correctness for code that only *looks* exactly-once.

Requirements:

- Publish **exactly one** \`classify.result\` event per classification with the **tenant** as the
  message key, so each tenant's events stay ordered on one partition.
- The payload carries the **request id, tenant, taxonomy version, labels and provenance** plus a
  **SHA-256 text hash** and no copy of the text. A digest is enough to match a result to a document.
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence\` + \`acks\`, KafkaJS's
  \`idempotent: true\`, or required acks \`all\` with a hash balancer), so a retried produce cannot
  duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the caller.
- The consumer updates the counter (\`HINCRBY counters:{tenant}:{label}\`) and **only then** commits
  the offset. Commit first and a crash between the two loses the increment, because the offset has
  already moved past the unprocessed record.`,
  sequence: {
    participants: ['Content Classifier', 'classify.result', 'Metrics consumer', 'Redis'],
    messages: [
      {from: 'Content Classifier', to: 'classify.result', label: 'produce · key = tenant · acks = all', kind: 'sync'},
      {from: 'classify.result', to: 'Content Classifier', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: 'insertOutbox(tenant, event) on failure',
        kind: 'sync',
      },
      {from: 'classify.result', to: 'Metrics consumer', label: 'consume · group classifier-metrics', kind: 'async'},
      {from: 'Metrics consumer', to: 'Redis', label: 'HINCRBY counters:{tenant}:{label}', kind: 'sync'},
      {from: 'Redis', to: 'Metrics consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Metrics consumer', to: 'classify.result', label: 'commit offset after processing', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant on classify.result',
      detail:
        'The message key is the tenant (partition by tenant), so one tenant’s events stay ordered on one partition. The starter keys by label, scattering a tenant across partitions.',
      match: {
        python: {all: [/key=event\.tenant/, /"classify\.result"/]},
        typescript: {all: [/key:\s*event\.tenant\b/, /'classify\.result'/]},
        go: {all: [/Key:\s*\[\]byte\(event\.Tenant\)/, /"classify\.result"/]},
        scala: {all: [/ProducerRecord\[String, String\]\("classify\.result",\s*event\.tenant/]},
        cpp: {all: [/produce\("classify\.result",\s*event\.tenant/]},
      },
    },
    {
      id: 'text-hash',
      title: 'Carries a text hash, never the text',
      detail:
        'The payload carries a SHA-256 digest of the text and no copy of the text itself. The starter embeds the body for spot audits — a leak that is retained and replicated with the topic.',
      match: {
        python: {all: [/text_hash/, /sha256/], none: [/"text"\s*:/]},
        typescript: {all: [/textHash/, /createHash\(['"]sha256['"]\)/], none: [/text:\s*event\.text\b/]},
        go: {all: [/TextHash/, /sha256\.Sum256/], none: [/"text":\s*event\.Text\b/]},
        scala: {all: [/textHash/, /SHA-256/], none: [/text = event\.text\b/]},
        cpp: {all: [/textHash/, /SHA256/], none: [/payload\["text"\]/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Event carries id, version, labels and provenance',
      detail:
        'The payload carries the request id, the taxonomy version, the labels and the provenance of the result, so a consumer can reconstruct what happened without the text. The starter sends a single label and no provenance.',
      match: {
        python: {all: [/"request_id": event\.request_id/, /"provenance": event\.provenance/]},
        typescript: {all: [/requestId: event\.requestId/, /provenance: event\.provenance/]},
        go: {all: [/eventPayload\{/, /Provenance:\s*event\.Provenance/]},
        scala: {all: [/provenance = event\.provenance/, /textHash = event\.textHash/]},
        cpp: {all: [/payload\["provenance"\]\s*=\s*event\.provenance/, /payload\["text_hash"\]\s*=\s*event\.textHash/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` + `acks`, KafkaJS`idempotent: true`, or required acks `all` with a hash balancer). A retried produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence=true/, /acks=all/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates counters before committing the offset',
      detail:
        'The consumer runs `HINCRBY` on the counter before committing the offset; committing first makes a crash lose the increment forever. The starter commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/\.hincrby\(/, /commitSync\(/]},
        cpp: {order: [/\.hincrby\(|->hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from pydantic import BaseModel

logger = logging.getLogger("classify-events")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092"})


class ClassifyEvent(BaseModel):
    request_id: str
    tenant: str
    taxonomy_version: str
    labels: list[str]
    provenance: str
    text: str


def publish(event: ClassifyEvent) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = {
        "request_id": event.request_id,
        "tenant": event.tenant,
        "taxonomy_version": event.taxonomy_version,
        "labels": event.labels,
        "text": event.text,
    }
    producer.produce("classify.result", key=event.labels[0], value=json.dumps(payload))
    producer.flush()
    logger.info("published classify.result tenant=%s text=%r", event.tenant, event.text)


def run_consumer() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "classifier-metrics", "enable.auto.commit": False}
    )
    consumer.subscribe(["classify.result"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        r.hincrby(f"metrics:{event['tenant']}", "classified", 1)
`,
      solution: `import hashlib
import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from pydantic import BaseModel

logger = logging.getLogger("classify-events")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class ClassifyEvent(BaseModel):
    request_id: str
    tenant: str
    taxonomy_version: str
    labels: list[str]
    provenance: str
    text_hash: str


def text_hash(text: str) -> str:
    """The topic carries a digest, never the content it was derived from."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def publish(event: ClassifyEvent) -> None:
    payload = {
        "request_id": event.request_id,
        "tenant": event.tenant,
        "taxonomy_version": event.taxonomy_version,
        "labels": event.labels,
        "provenance": event.provenance,
        "text_hash": event.text_hash,
    }
    try:
        producer.produce("classify.result", key=event.tenant, value=json.dumps(payload))
        producer.flush()
    except KafkaException:
        insert_outbox(event.tenant, payload)
    logger.info(
        "published classify.result tenant=%s labels=%s provenance=%s hash=%s",
        event.tenant,
        event.labels,
        event.provenance,
        event.text_hash,
    )


def run_consumer() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "classifier-metrics", "enable.auto.commit": False}
    )
    consumer.subscribe(["classify.result"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        label = event["labels"][0] if event["labels"] else "review"
        r.hincrby(f"counters:{event['tenant']}", label, 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** classify.result publisher and metrics consumer. */
import {Kafka} from 'kafkajs';

import Redis from 'ioredis';

const kafka = new Kafka({clientId: 'content-classifier', brokers: ['kafka:9092']});
const producer = kafka.producer();
const consumer = kafka.consumer({groupId: 'classifier-metrics'});
export const r = new Redis({host: 'redis', port: 6379});

interface ClassifyEvent {
  requestId: string;
  tenant: string;
  taxonomyVersion: string;
  labels: string[];
  provenance: string;
  text: string;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
export async function publish(event: ClassifyEvent): Promise<void> {
  const payload = {
    requestId: event.requestId,
    tenant: event.tenant,
    taxonomyVersion: event.taxonomyVersion,
    labels: event.labels,
    text: event.text,
  };
  await producer.send({topic: 'classify.result', messages: [{key: event.labels[0], value: JSON.stringify(payload)}]});
}

export async function runConsumer(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'classify.result'});
  await consumer.run({
    eachMessage: async ({message}) => {
      await consumer.commitOffsets([
        {topic: 'classify.result', partition: 0, offset: String(Number(message.offset) + 1)},
      ]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as ClassifyEvent;
      await r.hincrby(\`metrics:\${event.tenant}\`, 'classified', 1);
    },
  });
}
`,
      solution: `/** classify.result: tenant-keyed, hashed, idempotent, counters before the offset commit. */
import {Kafka} from 'kafkajs';
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const kafka = new Kafka({clientId: 'content-classifier', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1, acks: -1});
const consumer = kafka.consumer({groupId: 'classifier-metrics'});
export const r = new Redis({host: 'redis', port: 6379});

interface ClassifyEvent {
  requestId: string;
  tenant: string;
  taxonomyVersion: string;
  labels: string[];
  provenance: string;
  textHash: string;
}

/** The topic carries a digest, never the content it was derived from. */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function publish(event: ClassifyEvent): Promise<void> {
  const payload = {
    requestId: event.requestId,
    tenant: event.tenant,
    taxonomyVersion: event.taxonomyVersion,
    labels: event.labels,
    provenance: event.provenance,
    textHash: event.textHash,
  };
  try {
    await producer.send({topic: 'classify.result', messages: [{key: event.tenant, value: JSON.stringify(payload)}]});
  } catch (err) {
    await insertOutbox(event.tenant, payload);
  }
}

export async function runConsumer(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'classify.result'});
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as ClassifyEvent;
      const label = event.labels[0] ?? 'review';
      await r.hincrby(\`counters:\${event.tenant}\`, label, 1);
      await consumer.commitOffsets([
        {topic: 'classify.result', partition: 0, offset: String(Number(message.offset) + 1)},
      ]);
    },
  });
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type ClassifyEvent struct {
	RequestID       string
	Tenant          string
	TaxonomyVersion string
	Labels          []string
	Provenance      string
	Text            string
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func Publish(ctx context.Context, event ClassifyEvent) error {
	payload := map[string]any{
		"request_id":       event.RequestID,
		"tenant":           event.Tenant,
		"taxonomy_version": event.TaxonomyVersion,
		"labels":           event.Labels,
		"text":             event.Text,
	}
	value, _ := json.Marshal(payload)
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: "classify.result",
		Key:   []byte(event.Labels[0]),
		Value: value,
	})
}

func RunConsumer(ctx context.Context) error {
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var payload map[string]any
		if err := json.Unmarshal(msg.Value, &payload); err != nil {
			return err
		}
		r.HIncrBy(ctx, "metrics:"+payload["tenant"].(string), "classified", 1)
	}
}
`,
      solution: `package events

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Idempotent producer with required acks and a hash balancer: a retried produce cannot duplicate a
// record, and a tenant always lands on the same partition.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "classify.result",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

type ClassifyEvent struct {
	RequestID       string
	Tenant          string
	TaxonomyVersion string
	Labels          []string
	Provenance      string
	TextHash        string
}

type eventPayload struct {
	RequestID       string   \`json:"request_id"\`
	Tenant          string   \`json:"tenant"\`
	TaxonomyVersion string   \`json:"taxonomy_version"\`
	Labels          []string \`json:"labels"\`
	Provenance      string   \`json:"provenance"\`
	TextHash        string   \`json:"text_hash"\`
}

// TextHash is what the topic may carry: a digest, never the content it came from.
func TextHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func Publish(ctx context.Context, event ClassifyEvent) error {
	payload := eventPayload{
		RequestID:       event.RequestID,
		Tenant:          event.Tenant,
		TaxonomyVersion: event.TaxonomyVersion,
		Labels:          event.Labels,
		Provenance:      event.Provenance,
		TextHash:        event.TextHash,
	}
	value, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	err = writer.WriteMessages(ctx, kafka.Message{
		Topic: "classify.result",
		Key:   []byte(event.Tenant),
		Value: value,
	})
	if err != nil {
		return InsertOutbox(ctx, event.Tenant, payload)
	}
	return nil
}

func RunConsumer(ctx context.Context) error {
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			return err
		}
		var payload eventPayload
		if err := json.Unmarshal(msg.Value, &payload); err != nil {
			return err
		}
		label := reviewLabel
		if len(payload.Labels) > 0 {
			label = payload.Labels[0]
		}
		if err := r.HIncrBy(ctx, "counters:"+payload.Tenant, label, 1).Err(); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis

final case class ClassifyEvent(
    requestId: String,
    tenant: String,
    taxonomyVersion: String,
    labels: Seq[String],
    provenance: String,
    text: String
)

object ClassifyEvents {
  val r = new Jedis("redis", 6379)

  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")

  val producer = new KafkaProducer[String, String](producerProps)

  final case class ClassifyPayload(
      requestId: String,
      tenant: String,
      taxonomyVersion: String,
      labels: Seq[String],
      text: String
  )

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def publish(event: ClassifyEvent): Unit = {
    val payload = ClassifyPayload(
      requestId = event.requestId,
      tenant = event.tenant,
      taxonomyVersion = event.taxonomyVersion,
      labels = event.labels,
      text = event.text
    )
    producer.send(new ProducerRecord[String, String]("classify.result", event.labels.head, payload.toString))
  }

  def runConsumer(): Unit = {
    val consumer = ConsumerFactory.open("classifier-metrics")
    consumer.subscribe(java.util.List.of("classify.result"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      val it = records.iterator()
      while (it.hasNext) {
        val record = it.next()
        consumer.commitSync()
        val payload = parsePayload(record.value())
        r.hincrby(s"metrics:\${payload.tenant}", "classified", 1)
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis

final case class ClassifyEvent(
    requestId: String,
    tenant: String,
    taxonomyVersion: String,
    labels: Seq[String],
    provenance: String,
    textHash: String
)

object ClassifyEvents {
  val r = new Jedis("redis", 6379)

  val producerProps = new Properties()
  producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")

  val producer = new KafkaProducer[String, String](producerProps)

  /** The topic carries a digest, never the content it was derived from. */
  def textHash(text: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))
    digest.map("%02x".format(_)).mkString
  }

  final case class ClassifyPayload(
      requestId: String,
      tenant: String,
      taxonomyVersion: String,
      labels: Seq[String],
      provenance: String,
      textHash: String
  )

  def publish(event: ClassifyEvent): Unit = {
    val payload = ClassifyPayload(
      requestId = event.requestId,
      tenant = event.tenant,
      taxonomyVersion = event.taxonomyVersion,
      labels = event.labels,
      provenance = event.provenance,
      textHash = event.textHash
    )
    try {
      // Partition by tenant: one tenant's events stay ordered on one partition.
      producer.send(new ProducerRecord[String, String]("classify.result", event.tenant, payload.toString))
    } catch {
      case _: Exception => insertOutbox(event.tenant, payload)
    }
  }

  def runConsumer(): Unit = {
    val consumer = ConsumerFactory.open("classifier-metrics")
    consumer.subscribe(java.util.List.of("classify.result"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      val it = records.iterator()
      while (it.hasNext) {
        val record = it.next()
        val payload = parsePayload(record.value())
        val label = payload.labels.headOption.getOrElse("review")
        r.hincrby(s"counters:\${payload.tenant}", label, 1)
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
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;
using namespace sw::redis;

Redis r("tcp://redis:6379");

struct ClassifyEvent {
  std::string requestId;
  std::string tenant;
  std::string taxonomyVersion;
  std::vector<std::string> labels;
  std::string provenance;
  std::string text;
};

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void publish(const ClassifyEvent& event) {
  json payload;
  payload["request_id"] = event.requestId;
  payload["tenant"] = event.tenant;
  payload["taxonomy_version"] = event.taxonomyVersion;
  payload["labels"] = event.labels;
  payload["text"] = event.text;
  produce("classify.result", event.labels.front(), payload.dump());
}

void runConsumer() {
  while (true) {
    auto* message = consume("classify.result");
    message->consumer()->commitSync();
    const auto payload = json::parse(message->payload()->toString());
    r.hincrby("metrics:" + payload["tenant"].get<std::string>(), "classified", 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <array>
#include <cstdio>
#include <string>
#include <vector>

using json = nlohmann::json;
using namespace sw::redis;

Redis r("tcp://redis:6379");

// A retried produce cannot duplicate a record once the producer is idempotent with acks=all.
const std::string kProducerConfig = "bootstrap.servers=kafka:9092,enable.idempotence=true,acks=all";

struct ClassifyEvent {
  std::string requestId;
  std::string tenant;
  std::string taxonomyVersion;
  std::vector<std::string> labels;
  std::string provenance;
  std::string textHash;
};

// The topic carries a digest, never the content it was derived from.
std::string textHash(const std::string& text) {
  std::array<unsigned char, SHA256_DIGEST_LENGTH> digest{};
  SHA256(reinterpret_cast<const unsigned char*>(text.data()), text.size(), digest.data());
  std::string hex;
  for (const auto byte : digest) {
    char buffer[3];
    std::snprintf(buffer, sizeof(buffer), "%02x", byte);
    hex += buffer;
  }
  return hex;
}

std::string payloadFor(const ClassifyEvent& event) {
  json payload;
  payload["request_id"] = event.requestId;
  payload["tenant"] = event.tenant;
  payload["taxonomy_version"] = event.taxonomyVersion;
  payload["labels"] = event.labels;
  payload["provenance"] = event.provenance;
  payload["text_hash"] = event.textHash;
  return payload.dump();
}

void publish(const ClassifyEvent& event) {
  try {
    // Partition by tenant: one tenant's events stay ordered on one partition.
    produce("classify.result", event.tenant, payloadFor(event));
  } catch (const std::exception&) {
    insertOutbox(event.tenant, payloadFor(event));
  }
}

void runConsumer() {
  while (true) {
    auto* message = consume("classify.result");
    const auto payload = json::parse(message->payload()->toString());
    const auto label = payload["labels"].empty() ? std::string("review") : payload["labels"][0].get<std::string>();
    r.hincrby("counters:" + payload["tenant"].get<std::string>(), label, 1);
    message->consumer()->commitSync();
  }
}
`,
    },
  },
  hints: [
    'A tenant’s dashboard shows events out of order, a compliance scan finds customer documents sitting in a Kafka topic, and counters come up short after a consumer restart.',
    'The key is `event.labels[0]`, so one tenant spreads across partitions; the payload copies `event.text`; the producer has no idempotence; and the consumer commits before it increments.',
    'Produce with `key=event.tenant`, replace `"text"` with `text_hash = sha256(text)`, add provenance, configure `enable.idempotence` and `acks: all`, and in the consumer call `hincrby` before `consumer.commit`.',
  ],
  debrief: `The key is the tenant because the key decides the partition and the partition decides order; a per-tenant consumer can only count on order it was given. The payload carries a digest because the retained, replicated topic is the longest-lived copy of anything written to it, and a hash still links a result to its document. Idempotence with \`acks=all\` is what makes a retried produce safe rather than a duplicate. The consumer increments before it commits because the offset is the durable marker of work done: commit first and a crash loses the increment; commit second and the same crash becomes a replay the counter can absorb. Production pipelines go further: a schema registry enforces the payload shape, and a dead-letter topic holds records the consumer cannot parse.`,
};
