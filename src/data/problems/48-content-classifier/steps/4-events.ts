import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Classification events keyed by tenant, text hashed',
  concept: 'kafka',
  guides: ['producing-events', 'consuming-events'],
  file: 'events',
  focus: ['classifier', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** \`publish(c)\` produces one \`classify.result\` record for a classification
\`{request_id, tenant, taxonomy_id, taxonomy_version, labels, provenance, text}\`, keyed by its first
label, with the text in the payload, on a producer with \`acks=1\`; it writes the payload to the
outbox (\`outbox.insert\`) when \`produce\` raises. \`run_consumer()\` reads the topic in group
\`classifier-metrics\`, commits each record, then counts its labels with \`bump_counter\` (step 2,
provided as \`classifier.counters\`). It hides 5 flaws.

**Failure mode the checks target.** A label key scatters one tenant's events over partitions; text
in a retained topic leaks for as long as the topic keeps it; a lost acknowledgement duplicates a
record and a leader failover drops one; a broker's refusal never reaches the \`except\`; and a
consumer that crashes between commit and count loses the count.

- The key is the **tenant**.
- The payload carries \`request_id\`, \`tenant\`, \`taxonomy_id\`, \`taxonomy_version\`, \`labels\`,
  \`provenance\` and \`text_hash\` (SHA-256 hex of the text), and no text.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\`; Go uses confluent-kafka-go,
  whose producer can be idempotent).
- A failed delivery report, or none within \`ACK_TIMEOUT_S\` (2 s), writes the payload to the outbox,
  and \`publish\` returns false.
- The consumer counts every label of a record, then commits its offset.`,
  sequence: {
    participants: ['Content Classifier', 'classify.result', 'Metrics consumer', 'Redis'],
    messages: [
      {
        from: 'Content Classifier',
        to: 'classify.result',
        label: 'produce · key = tenant · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'classify.result', to: 'Content Classifier', label: 'delivery report: ack / error', kind: 'reply'},
      {
        from: 'Content Classifier',
        to: 'Redis',
        label: 'RPUSH classifier:outbox on error or no ack in 2 s',
        kind: 'sync',
      },
      {from: 'classify.result', to: 'Metrics consumer', label: 'consume · group classifier-metrics', kind: 'async'},
      {from: 'Metrics consumer', to: 'Redis', label: 'HINCRBY counters:{tenant}:{hour} per label', kind: 'sync'},
      {from: 'Metrics consumer', to: 'classify.result', label: 'commit the offset, after counting', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant on classify.result',
      detail:
        'The record key is the tenant (`key=c["tenant"]`, `key: c.tenant`, `[]byte(c.Tenant)`), so one tenant’s events land on one partition and stay ordered. The starter keys by the first label.',
      match: {
        python: {all: [/key\s*=\s*c\[["']tenant["']\]/, /classify\.result|TOPIC/], none: [/["']labels["']\]\[0\]/]},
        typescript: {all: [/key:\s*c\.tenant\b/], none: [/labels\[0\]/]},
        go: {all: [/Key:\s*\[\]byte\(c\.Tenant\)/], none: [/Labels\[0\]/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Config\.Topic,\s*c\.tenant/], none: [/labels\.headOption/]},
        cpp: {all: [/c\.tenant\.c_str\(\),\s*c\.tenant\.size\(\)/], none: [/labels\.front\(\)/]},
      },
    },
    {
      id: 'text-hash',
      title: 'Carries a text hash, never the text',
      detail:
        'The payload carries `text_hash`, the SHA-256 hex of the text, next to the request id, tenant, taxonomy version, labels and provenance, and no copy of the text. The starter copies the text into a topic that is replicated and kept.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /["']text_hash["']/], none: [/["']text["']\s*:/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /text_hash/], none: [/\btext:\s*c\.text/]},
        go: {all: [/sha256\.Sum256\(/, /"text_hash"/], none: [/"text":\s*c\.Text/]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /"text_hash"/], none: [/"text"\s*->/]},
        cpp: {all: [/sha256_hex\(/, /"text_hash"/], none: [/\{"text",\s*c\.text\}/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent with `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the record once and a leader failover loses nothing. The starter uses `acks=1` without idempotence.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Writes the outbox from the delivery report',
      detail:
        'A delivery that fails, or brings no acknowledgement within 2 s, writes the payload to the outbox and `publish` returns false; the error arrives in the delivery report (`on_delivery`, a rejected `send`, the delivery channel, `dr_cb`, the send future), not as an exception from `produce`. The starter only catches local errors.',
      match: {
        python: {all: [/on_delivery\s*=/, /outbox\.insert\(/], none: [/except KafkaException/]},
        typescript: {all: [/await producer\.send\(/, /outbox\.insert\(/], none: [/void producer\.send\(/]},
        go: {
          all: [/Produce\(msg,\s*deliveries\)/, /TopicPartition\.Error/, /outbox\.Insert\(/],
          none: [/Produce\(msg,\s*nil\)/],
        },
        scala: {all: [/\.send\([\s\S]*?\)\.get\(\s*AckTimeoutMs/, /Outbox\.insert\(/]},
        cpp: {all: [/dr_cb/, /outbox::insert\(/, /flush\(\s*kAckTimeoutMs\s*\)/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates counters before committing the offset',
      detail:
        'The consumer commits manually and only after `bump_counter` ran for every label of the record, so a crash between the two replays the record instead of losing its counts. The starter commits first.',
      match: {
        python: {all: [/["']enable\.auto\.commit["']\s*:\s*False/], order: [/bump_counter\(/, /consumer\.commit\(/]},
        typescript: {all: [/autoCommit:\s*false/], order: [/await bumpCounter\(/, /commitOffsets\(/]},
        go: {all: [/FetchMessage\(/], order: [/counters\.BumpCounter\(/, /CommitMessages\(/]},
        scala: {all: [/"enable\.auto\.commit",\s*"false"/], order: [/Counters\.bumpCounter\(/, /commitSync\(/]},
        cpp: {all: [/"enable\.auto\.commit",\s*"false"/], order: [/counters::bumpCounter\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, KafkaException, Producer

from classifier import outbox
from classifier.config import GROUP, REVIEW_LABEL, TOPIC
from classifier.counters import bump_counter

log = logging.getLogger("classifier.events")

ACK_TIMEOUT_S = 2.0

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(c: dict) -> dict:
    return {
        "request_id": c["request_id"],
        "tenant": c["tenant"],
        "taxonomy_id": c["taxonomy_id"],
        "taxonomy_version": c["taxonomy_version"],
        "labels": c["labels"],
        "provenance": c["provenance"],
        "text": c["text"],
    }


def publish(c: dict) -> bool:
    """One classify.result event per classification; False when it went to the outbox."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = event_payload(c)
    key = c["labels"][0] if c["labels"] else REVIEW_LABEL
    try:
        producer.produce(TOPIC, key=key, value=json.dumps(payload))
        producer.flush(ACK_TIMEOUT_S)
    except KafkaException as err:
        log.warning("classify.result not produced: %s", err)
        outbox.insert(payload)
        return False
    return True


def run_consumer() -> None:
    """Count every classification's labels per tenant and hour."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error() is not None:
            continue
        consumer.commit(message=msg, asynchronous=False)
        event = json.loads(msg.value())
        for label in event["labels"]:
            bump_counter(event["tenant"], label)
`,
      solution: `import hashlib
import json
import logging

from confluent_kafka import Consumer, Producer

from classifier import outbox
from classifier.config import GROUP, TOPIC
from classifier.counters import bump_counter

log = logging.getLogger("classifier.events")

ACK_TIMEOUT_S = 2.0

# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def text_hash(text: str) -> str:
    """A digest matches an event to its document without carrying the document."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def event_payload(c: dict) -> dict:
    return {
        "request_id": c["request_id"],
        "tenant": c["tenant"],
        "taxonomy_id": c["taxonomy_id"],
        "taxonomy_version": c["taxonomy_version"],
        "labels": c["labels"],
        "provenance": c["provenance"],
        "text_hash": text_hash(c["text"]),
    }


def publish(c: dict) -> bool:
    """One classify.result event per classification; False when it went to the outbox."""
    payload = event_payload(c)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=c["tenant"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the counts are late, not wrong.
        log.warning("classify.result not delivered request=%s: %s", c["request_id"], outcome.get("error"))
        outbox.insert(payload)
        return False
    return True


def run_consumer() -> None:
    """Count every classification's labels per tenant and hour."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error() is not None:
            continue
        event = json.loads(msg.value())
        for label in event["labels"]:
            bump_counter(event["tenant"], label)
        # Only now does the offset move: a crash before this line replays the record.
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {GROUP, REVIEW_LABEL, TOPIC} from 'classifier/config';
import {bumpCounter} from 'classifier/counters';
import * as outbox from 'classifier/outbox';

export const ACK_TIMEOUT_MS = 2000;

export interface Classification {
  request_id: string;
  tenant: string;
  taxonomy_id: string;
  taxonomy_version: number;
  labels: string[];
  provenance: string;
  text: string;
}

const kafka = new Kafka({clientId: 'classifierd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

export function eventPayload(c: Classification): Record<string, unknown> {
  return {
    request_id: c.request_id,
    tenant: c.tenant,
    taxonomy_id: c.taxonomy_id,
    taxonomy_version: c.taxonomy_version,
    labels: c.labels,
    provenance: c.provenance,
    text: c.text,
  };
}

/** One classify.result event per classification; false when it went to the outbox. */
export async function publish(c: Classification): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(c);
  const key = c.labels[0] ?? REVIEW_LABEL;
  try {
    void producer.send({topic: TOPIC, messages: [{key, value: JSON.stringify(payload)}], acks: 1});
  } catch (err) {
    console.warn(\`classify.result not produced: \${String(err)}\`);
    await outbox.insert(payload);
    return false;
  }
  return true;
}

/** Count every classification's labels per tenant and hour. */
export async function runConsumer(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; labels: string[]};
      for (const label of event.labels ?? []) await bumpCounter(event.tenant, label);
    },
  });
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {GROUP, TOPIC} from 'classifier/config';
import {bumpCounter} from 'classifier/counters';
import * as outbox from 'classifier/outbox';

export const ACK_TIMEOUT_MS = 2000;

export interface Classification {
  request_id: string;
  tenant: string;
  taxonomy_id: string;
  taxonomy_version: number;
  labels: string[];
  provenance: string;
  text: string;
}

const kafka = new Kafka({clientId: 'classifierd', brokers: ['kafka:9092']});
// Idempotent (which needs acks: -1): a retry after a lost acknowledgement writes the record once.
const producer = kafka.producer({idempotent: true});
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

/** A digest matches an event to its document without carrying the document. */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function eventPayload(c: Classification): Record<string, unknown> {
  return {
    request_id: c.request_id,
    tenant: c.tenant,
    taxonomy_id: c.taxonomy_id,
    taxonomy_version: c.taxonomy_version,
    labels: c.labels,
    provenance: c.provenance,
    text_hash: textHash(c.text),
  };
}

/** One classify.result event per classification; false when it went to the outbox. */
export async function publish(c: Classification): Promise<boolean> {
  const payload = eventPayload(c);
  try {
    await producer.send({topic: TOPIC, messages: [{key: c.tenant, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch (err) {
    // The broker did not take it: the relay publishes the row later, so the counts are late, not wrong.
    console.warn(\`classify.result not delivered request=\${c.request_id}: \${String(err)}\`);
    await outbox.insert(payload);
    return false;
  }
}

/** Count every classification's labels per tenant and hour. */
export async function runConsumer(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {tenant: string; labels: string[]};
      for (const label of event.labels ?? []) await bumpCounter(event.tenant, label);
      // Only now does the offset move: a crash before this line replays the record.
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	kafkago "github.com/segmentio/kafka-go"

	"classifier/config"
	"classifier/counters" // counters.BumpCounter(ctx, tenant, label) error
	"classifier/outbox"   // outbox.Insert(ctx, payload) error
)

const ackTimeout = 2 * time.Second

// Classification is one classification as the endpoint hands it over, text included.
type Classification struct {
	RequestID       string
	Tenant          string
	TaxonomyID      string
	TaxonomyVersion int
	Labels          []string
	Provenance      string
	Text            string
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

var reader = kafkago.NewReader(kafkago.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     config.Group,
	Topic:       config.Topic,
	StartOffset: kafkago.FirstOffset,
})

func eventPayload(c Classification) map[string]any {
	return map[string]any{
		"request_id":       c.RequestID,
		"tenant":           c.Tenant,
		"taxonomy_id":      c.TaxonomyID,
		"taxonomy_version": c.TaxonomyVersion,
		"labels":           c.Labels,
		"provenance":       c.Provenance,
		"text":             c.Text,
	}
}

// publish produces one classify.result event per classification; false when it went to the outbox.
func publish(ctx context.Context, c Classification) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload := eventPayload(c)
	value, _ := json.Marshal(payload)
	key := config.ReviewLabel
	if len(c.Labels) > 0 {
		key = c.Labels[0]
	}
	t := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(key), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		log.Printf("classify.result not produced: %v", err)
		return false, outbox.Insert(ctx, payload)
	}
	producer.Flush(int(ackTimeout / time.Millisecond))
	return true, nil
}

type countedEvent struct {
	Tenant string   \`json:"tenant"\`
	Labels []string \`json:"labels"\`
}

// runConsumer counts every classification's labels per tenant and hour.
func runConsumer(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event countedEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			continue
		}
		for _, label := range event.Labels {
			if err := counters.BumpCounter(ctx, event.Tenant, label); err != nil {
				return err
			}
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	kafkago "github.com/segmentio/kafka-go"

	"classifier/config"
	"classifier/counters" // counters.BumpCounter(ctx, tenant, label) error
	"classifier/outbox"   // outbox.Insert(ctx, payload) error
)

const ackTimeout = 2 * time.Second

// Classification is one classification as the endpoint hands it over, text included.
type Classification struct {
	RequestID       string
	Tenant          string
	TaxonomyID      string
	TaxonomyVersion int
	Labels          []string
	Provenance      string
	Text            string
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

var reader = kafkago.NewReader(kafkago.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     config.Group,
	Topic:       config.Topic,
	StartOffset: kafkago.FirstOffset,
})

// textHash matches an event to its document without carrying the document.
func textHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func eventPayload(c Classification) map[string]any {
	return map[string]any{
		"request_id":       c.RequestID,
		"tenant":           c.Tenant,
		"taxonomy_id":      c.TaxonomyID,
		"taxonomy_version": c.TaxonomyVersion,
		"labels":           c.Labels,
		"provenance":       c.Provenance,
		"text_hash":        textHash(c.Text),
	}
}

// publish produces one classify.result event per classification; false when it went to the outbox.
func publish(ctx context.Context, c Classification) (bool, error) {
	payload := eventPayload(c)
	value, _ := json.Marshal(payload)
	t := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(c.Tenant), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the counts are late, not wrong.
		log.Printf("classify.result not delivered request=%s: %v", c.RequestID, err)
		return false, outbox.Insert(ctx, payload)
	}
	return true, nil
}

type countedEvent struct {
	Tenant string   \`json:"tenant"\`
	Labels []string \`json:"labels"\`
}

// runConsumer counts every classification's labels per tenant and hour.
func runConsumer(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx) // FetchMessage leaves the commit to us
		if err != nil {
			return err
		}
		var event countedEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
		}
		for _, label := range event.Labels {
			if err := counters.BumpCounter(ctx, event.Tenant, label); err != nil {
				return err // uncommitted: the record is redelivered
			}
		}
		// Only now does the offset move: a crash before this line replays the record.
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

import scala.jdk.CollectionConverters._

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._
import spray.json.DefaultJsonProtocol._

import classifier.{Config, Counters, Outbox}

object ClassifyEvents {
  /** One classification as the endpoint hands it over, text included. */
  final case class Classification(
      requestId: String,
      tenant: String,
      taxonomyId: String,
      taxonomyVersion: Long,
      labels: Seq[String],
      provenance: String,
      text: String
  )

  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(c: Classification): JsObject =
    JsObject(
      "request_id" -> JsString(c.requestId),
      "tenant" -> JsString(c.tenant),
      "taxonomy_id" -> JsString(c.taxonomyId),
      "taxonomy_version" -> JsNumber(c.taxonomyVersion),
      "labels" -> c.labels.toJson,
      "provenance" -> JsString(c.provenance),
      "text" -> JsString(c.text)
    )

  /** One classify.result event per classification; false when it went to the outbox. */
  def publish(c: Classification): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(c)
    val key = c.labels.headOption.getOrElse(Config.ReviewLabel)
    try {
      producer.send(new ProducerRecord[String, String](Config.Topic, key, payload.compactPrint))
      true
    } catch {
      case e: Exception =>
        System.err.println(s"classify.result not produced: $e")
        Outbox.insert(payload)
        false
    }
  }

  /** Count every classification's labels per tenant and hour. */
  def runConsumer(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Config.Group)
    props.put("enable.auto.commit", "false")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        val event = record.value.parseJson.asJsObject.fields
        val tenant = event("tenant").convertTo[String]
        event("labels").convertTo[Seq[String]].foreach(label => Counters.bumpCounter(tenant, label))
      }
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.jdk.CollectionConverters._
import scala.util.Try

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._
import spray.json.DefaultJsonProtocol._

import classifier.{Config, Counters, Outbox}

object ClassifyEvents {
  /** One classification as the endpoint hands it over, text included. */
  final case class Classification(
      requestId: String,
      tenant: String,
      taxonomyId: String,
      taxonomyVersion: Long,
      labels: Seq[String],
      provenance: String,
      text: String
  )

  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** A digest matches an event to its document without carrying the document. */
  def textHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map(b => f"$b%02x").mkString

  def eventPayload(c: Classification): JsObject =
    JsObject(
      "request_id" -> JsString(c.requestId),
      "tenant" -> JsString(c.tenant),
      "taxonomy_id" -> JsString(c.taxonomyId),
      "taxonomy_version" -> JsNumber(c.taxonomyVersion),
      "labels" -> c.labels.toJson,
      "provenance" -> JsString(c.provenance),
      "text_hash" -> JsString(textHash(c.text))
    )

  /** One classify.result event per classification; false when it went to the outbox. */
  def publish(c: Classification): Boolean = {
    val payload = eventPayload(c)
    val record = new ProducerRecord[String, String](Config.Topic, c.tenant, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the counts are late, not wrong.
      System.err.println(s"classify.result not delivered request=\${c.requestId}: \${acked.failed.get}")
      Outbox.insert(payload)
    }
    acked.isSuccess
  }

  /** Count every classification's labels per tenant and hour. */
  def runConsumer(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Config.Group)
    props.put("enable.auto.commit", "false")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    while (true) {
      for (record <- consumer.poll(Duration.ofSeconds(1)).asScala) {
        val event = record.value.parseJson.asJsObject.fields
        val tenant = event("tenant").convertTo[String]
        event("labels").convertTo[Seq[String]].foreach(label => Counters.bumpCounter(tenant, label))
        // Only now does the offset move: a crash before this line replays the record.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "classifier/config.h"
#include "classifier/counters.h"  // counters::bumpCounter(tenant, label)
#include "classifier/outbox.h"    // outbox::insert(payload)
#include "digest.h"               // sha256_hex(bytes)

using json = nlohmann::json;

constexpr int kAckTimeoutMs = 2000;

// One classification as the endpoint hands it over, text included.
struct Classification {
  std::string request_id;
  std::string tenant;
  std::string taxonomy_id;
  long taxonomy_version = 0;
  std::vector<std::string> labels;
  std::string provenance;
  std::string text;
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::unique_ptr<RdKafka::KafkaConsumer> makeConsumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

auto consumer = makeConsumer();

json eventPayload(const Classification& c) {
  return json{{"request_id", c.request_id}, {"tenant", c.tenant},         {"taxonomy_id", c.taxonomy_id}, {"taxonomy_version", c.taxonomy_version},
              {"labels", c.labels},         {"provenance", c.provenance}, {"text", c.text}};
}

// One classify.result event per classification; false when it went to the outbox.
bool publish(const Classification& c) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const json payload = eventPayload(c);
  const std::string value = payload.dump();
  const std::string key = c.labels.empty() ? config::kReviewLabel : c.labels.front();
  const RdKafka::ErrorCode err = producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    std::cerr << "classify.result not produced: " << RdKafka::err2str(err) << "\\n";
    outbox::insert(payload);
    return false;
  }
  producer->poll(0);
  return true;
}

// Counts every classification's labels per tenant and hour.
void runConsumer() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    consumer->commitSync(msg.get());
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (!event.is_object()) continue;
    for (const auto& label : event.value("labels", std::vector<std::string>{})) counters::bumpCounter(event.value("tenant", ""), label);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "classifier/config.h"
#include "classifier/counters.h"  // counters::bumpCounter(tenant, label)
#include "classifier/outbox.h"    // outbox::insert(payload)
#include "digest.h"               // sha256_hex(bytes)

using json = nlohmann::json;

constexpr int kAckTimeoutMs = 2000;

// One classification as the endpoint hands it over, text included.
struct Classification {
  std::string request_id;
  std::string tenant;
  std::string taxonomy_id;
  long taxonomy_version = 0;
  std::vector<std::string> labels;
  std::string provenance;
  std::string text;
};

// The delivery report of the record in flight: publish produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::unique_ptr<RdKafka::KafkaConsumer> makeConsumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

auto consumer = makeConsumer();

json eventPayload(const Classification& c) {
  // A digest matches an event to its document without carrying the document.
  return json{{"request_id", c.request_id}, {"tenant", c.tenant},         {"taxonomy_id", c.taxonomy_id},        {"taxonomy_version", c.taxonomy_version},
              {"labels", c.labels},         {"provenance", c.provenance}, {"text_hash", sha256_hex(c.text)}};
}

// One classify.result event per classification; false when it went to the outbox.
bool publish(const Classification& c) {
  const json payload = eventPayload(c);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), c.tenant.c_str(), c.tenant.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the counts are late, not wrong.
    std::cerr << "classify.result not delivered request=" << c.request_id << ": " << RdKafka::err2str(err) << "\\n";
    outbox::insert(payload);
    return false;
  }
  return true;
}

// Counts every classification's labels per tenant and hour.
void runConsumer() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_object())
      for (const auto& label : event.value("labels", std::vector<std::string>{})) counters::bumpCounter(event.value("tenant", ""), label);
    // Only now does the offset move: a crash before this line replays the record.
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from classifier import config, counters

TOPIC = "classify.result"
CARD = "Please refund invoice 4411, my card is 4111 1111 1111 1111"


def _c(n, tenant="acme", labels=("billing",), text=None):
    return {
        "request_id": f"req-{n}",
        "tenant": tenant,
        "taxonomy_id": "tx-support",
        "taxonomy_version": 2,
        "labels": list(labels),
        "provenance": "model",
        "text": text or f"refund request number {n}",
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange(config.OUTBOX_KEY, 0, -1)]


def check_tenant_key(ctx):
    m = ctx.load("events")
    m.publish(_c(1, "acme", ["billing"]))
    m.publish(_c(2, "globex", ["support"]))
    m.publish(_c(3, "acme", ["security"]))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish calls produced {len(records)} records on classify.result"
    keys = [r.key for r in records]
    assert keys == [b"acme", b"globex", b"acme"], f"the records are keyed {keys}, expected the tenants acme, globex, acme"
    assert records[0].partition == records[2].partition, "both acme events must land on one partition, or acme's dashboard sees them out of order"


def check_text_hash(ctx):
    m = ctx.load("events")
    m.publish(_c(1, text=CARD))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish produced {len(records)} records"
    value = json.loads(records[0].value)
    assert "text" not in value and "4111" not in records[0].value.decode(), f"the payload carries the document: {value}. A retained topic must not hold tenant content"
    assert value.get("text_hash") == hashlib.sha256(CARD.encode("utf-8")).hexdigest(), f"text_hash must be the SHA-256 hex of the text, got {value.get('text_hash')!r}"
    expected = {"request_id": "req-1", "tenant": "acme", "taxonomy_id": "tx-support", "taxonomy_version": 2, "labels": ["billing"], "provenance": "model"}
    for field, want in expected.items():
        assert value.get(field) == want, f"the payload's {field} is {value.get(field)!r}, expected {want!r}"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish(_c(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish(_c(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish(_c(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: the event is lost. The failure arrives in the delivery report, not as an exception from produce"
    assert rows[0].get("request_id") == "req-1" and rows[0].get("tenant") == "acme", f"the outbox row must be the event's payload, got {rows[0]}"
    assert ok is False, f"publish returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish(_c(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("request_id") == "req-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish returned {ok!r} without an acknowledgement, expected False"


def check_counters_before_commit(ctx):
    events = [["billing"], ["billing", "review"], ["support"]]
    for n, labels in enumerate(events, start=1):
        payload = {"request_id": f"req-{n}", "tenant": "acme", "taxonomy_id": "tx-support", "taxonomy_version": 2, "labels": labels, "provenance": "model", "text_hash": "0" * 64}
        ctx.kafka.seed(TOPIC, key="acme", value=json.dumps(payload), partition=0)
    totals = [1, 3, 4]
    early = []

    def counted():
        return sum(int(v) for v in ctx.redis.hgetall(counters.counters_key("acme", ctx.clock.time())).values())

    def hook(group, offsets):
        for (topic, partition), offset in offsets.items():
            if topic == TOPIC and 0 < offset <= len(totals) and counted() < totals[offset - 1]:
                early.append(f"offset {offset} was committed while the counters held {counted()} of its {totals[offset - 1]} labels: a crash now loses them")

    ctx.kafka.on_commit(hook)
    m = ctx.load("events")
    ctx.drain(m.run_consumer)
    assert not early, early[0]
    assert ctx.kafka.committed_offset(config.GROUP, TOPIC, 0) == 3, f"every counted record must be committed: the committed offset is {ctx.kafka.committed_offset(config.GROUP, TOPIC, 0)}"
    got = ctx.redis.hgetall(counters.counters_key("acme", ctx.clock.time()))
    assert got == {"billing": "2", "review": "1", "support": "1"}, f"the counters hold {got}, expected billing 2, review 1, support 1"
`,
    typescript: `const TOPIC = 'classify.result';
const GROUP = 'classifier-metrics';
const CARD = 'Please refund invoice 4411, my card is 4111 1111 1111 1111';

const c = (n: number, tenant = 'acme', labels = ['billing'], text = '') => ({
  request_id: \`req-\${n}\`,
  tenant,
  taxonomy_id: 'tx-support',
  taxonomy_version: 2,
  labels,
  provenance: 'model',
  text: text || \`refund request number \${n}\`,
});

const outboxRows = ctx => (ctx.redis.lrange('classifier:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_tenant_key(ctx) {
  const m = ctx.load('events');
  await m.publish(c(1, 'acme', ['billing']));
  await m.publish(c(2, 'globex', ['support']));
  await m.publish(c(3, 'acme', ['security']));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publish calls produced \${records.length} records on classify.result\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['acme', 'globex', 'acme'], \`the records are keyed \${JSON.stringify(keys)}, expected the tenants acme, globex, acme\`);
  assert.equal(records[0].partition, records[2].partition, "both acme events must land on one partition, or acme's dashboard sees them out of order");
}

export async function check_text_hash(ctx) {
  const m = ctx.load('events');
  await m.publish(c(1, 'acme', ['billing'], CARD));
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publish produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  assert(!('text' in value) && !values[0].includes('4111'), \`the payload carries the document: \${values[0]}. A retained topic must not hold tenant content\`);
  const cardHash = '8a083646ad2530b746123a2625a441622ba9ac4720541ffbd9dbec7519a372a2'; // SHA-256 of CARD
  assert.equal(value.text_hash, cardHash, \`text_hash must be the SHA-256 hex of the text, got \${JSON.stringify(value.text_hash)}\`);
  const expected = {request_id: 'req-1', tenant: 'acme', taxonomy_id: 'tx-support', taxonomy_version: 2, labels: ['billing'], provenance: 'model'};
  for (const [field, want] of Object.entries(expected))
    assert.equal(JSON.stringify(value[field]), JSON.stringify(want), \`the payload's \${field} is \${JSON.stringify(value[field])}, expected \${JSON.stringify(want)}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publish(c(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publish(c(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publish(c(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: the event is lost. The failure arrives as a rejected send, not as an exception from calling it\`);
  assert(rows[0].request_id === 'req-1' && rows[0].tenant === 'acme', \`the outbox row must be the event's payload, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ok, false, \`publish resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publish(c(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publish waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the acknowledgement at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].request_id === 'req-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publish resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}

export async function check_counters_before_commit(ctx) {
  const counters = ctx.load('/support/classifier/counters.ts');
  const events = [['billing'], ['billing', 'review'], ['support']];
  events.forEach((labels, i) => {
    const payload = {request_id: \`req-\${i + 1}\`, tenant: 'acme', taxonomy_id: 'tx-support', taxonomy_version: 2, labels, provenance: 'model', text_hash: '0'.repeat(64)};
    ctx.kafka.seed(TOPIC, {key: 'acme', value: JSON.stringify(payload), partition: 0});
  });
  const totals = [1, 3, 4];
  const key = () => counters.countersKey('acme', Math.floor(ctx.clock.now() / 1000));
  const counted = () => Object.values(ctx.redis.hgetall(key()) as Record<string, string>).reduce((sum, v) => sum + Number(v), 0);
  const early: string[] = [];
  ctx.kafka.onCommit((group, offsets: Map<string, number>) => {
    for (const [tp, offset] of offsets) {
      if (!tp.startsWith(TOPIC) || offset < 1 || offset > totals.length) continue;
      if (counted() < totals[offset - 1]) early.push(\`offset \${offset} was committed while the counters held \${counted()} of its \${totals[offset - 1]} labels: a crash now loses them\`);
    }
  });
  const m = ctx.load('events');
  await ctx.drain(m.runConsumer());
  assert(early.length === 0, early[0]);
  assert.equal(ctx.kafka.committedOffset(GROUP, TOPIC, 0), 3, \`every counted record must be committed: the committed offset is \${ctx.kafka.committedOffset(GROUP, TOPIC, 0)}\`);
  assert.deepEqual(ctx.redis.hgetall(key()), {billing: '2', review: '1', support: '1'}, \`the counters hold \${JSON.stringify(ctx.redis.hgetall(key()))}, expected billing 2, review 1, support 1\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"classifier/config"
	"classifier/counters"

	"leetbuild/harness"
)

const eventsCard = "Please refund invoice 4411, my card is 4111 1111 1111 1111"

func eventsC(n int, tenant string, labels []string, text string) Classification {
	if text == "" {
		text = fmt.Sprintf("refund request number %d", n)
	}
	return Classification{RequestID: fmt.Sprintf("req-%d", n), Tenant: tenant, TaxonomyID: "tx-support", TaxonomyVersion: 2, Labels: labels, Provenance: "model", Text: text}
}

func eventsPublish(ctx *harness.Ctx, c Classification) bool {
	ok, err := publish(context.Background(), c)
	ctx.NoError(err, "publish(%s)", c.RequestID)
	return ok
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	rows := []map[string]any{}
	for _, text := range ctx.Redis.LRange(config.OutboxKey, 0, -1) {
		var row map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be the JSON payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckTenantKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsC(1, "acme", []string{"billing"}, ""))
	eventsPublish(ctx, eventsC(2, "globex", []string{"support"}, ""))
	eventsPublish(ctx, eventsC(3, "acme", []string{"security"}, ""))
	ctx.Settle()
	records := ctx.Kafka.Records(config.Topic)
	ctx.Equal(len(records), 3, "three publish calls must produce three records on classify.result; the records")
	ctx.Equal(ctx.Kafka.Keys(config.Topic), []string{"acme", "globex", "acme"}, "the records must be keyed by the tenants")
	ctx.Equal(records[0].Partition, records[2].Partition, "both acme events must land on one partition, or acme's dashboard sees them out of order; the partitions")
}

func CheckTextHash(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsC(1, "acme", []string{"billing"}, eventsCard))
	ctx.Settle()
	values := ctx.Kafka.Values(config.Topic)
	ctx.Equal(len(values), 1, "one publish must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	_, hasText := value["text"]
	ctx.Assert(!hasText && !strings.Contains(values[0], "4111"), "the payload carries the document: %s. A retained topic must not hold tenant content", values[0])
	sum := sha256.Sum256([]byte(eventsCard))
	ctx.Equal(value["text_hash"], hex.EncodeToString(sum[:]), "text_hash must be the SHA-256 hex of the text")
	ctx.Assert(value["request_id"] == "req-1" && value["tenant"] == "acme" && value["taxonomy_id"] == "tx-support" && value["taxonomy_version"] == float64(2) && value["provenance"] == "model",
		"the payload must carry request_id, tenant, taxonomy_id, taxonomy_version and provenance, got %s", values[0])
	ctx.Equal(value["labels"], []any{"billing"}, "the payload's labels")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(config.Topic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsC(1, "acme", []string{"billing"}, ""))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(config.Topic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsC(2, "acme", []string{"billing"}, ""))
	ctx.Settle()
	ctx.Kafka.Failover(config.Topic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(config.Topic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(config.Topic, 1)
	ok := eventsPublish(ctx, eventsC(1, "acme", []string{"billing"}, ""))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the event is lost (the failure arrives in the delivery report, not from Produce); the rows")
	ctx.Assert(rows[0]["request_id"] == "req-1" && rows[0]["tenant"] == "acme", "the outbox row must be the event's payload, got %v", rows[0])
	ctx.Equal(ok, false, "publish's result after a failed delivery")
	ctx.Kafka.Stall(config.Topic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsC(2, "acme", []string{"billing"}, ""))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1]["request_id"] == "req-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publish's result without an acknowledgement")
}

func CheckCountersBeforeCommit(ctx *harness.Ctx) {
	events := [][]string{{"billing"}, {"billing", "review"}, {"support"}}
	for i, labels := range events {
		payload, _ := json.Marshal(map[string]any{"request_id": fmt.Sprintf("req-%d", i+1), "tenant": "acme", "taxonomy_id": "tx-support", "taxonomy_version": 2, "labels": labels, "provenance": "model", "text_hash": strings.Repeat("0", 64)})
		ctx.Kafka.SeedPartition(config.Topic, 0, "acme", string(payload))
	}
	totals := []int{1, 3, 4}
	key := func() string { return counters.CountersKey("acme", ctx.Clock.Now()/1000) }
	counted := func() int {
		n := 0
		for _, v := range ctx.Redis.HGetAll(key()) {
			c, _ := strconv.Atoi(v)
			n += c
		}
		return n
	}
	var early []string
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		for tp, offset := range offsets {
			if tp.Topic != config.Topic || offset < 1 || int(offset) > len(totals) {
				continue
			}
			if counted() < totals[offset-1] {
				early = append(early, fmt.Sprintf("offset %d was committed while the counters held %d of its %d labels: a crash now loses them", offset, counted(), totals[offset-1]))
			}
		}
	})
	loop, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx.Drain(func() { _ = runConsumer(loop) })
	if len(early) > 0 {
		ctx.Fatalf("%s", early[0])
	}
	ctx.Equal(ctx.Kafka.CommittedOffset(config.Group, config.Topic, 0), int64(3), "every counted record must be committed; the committed offset")
	ctx.Equal(ctx.Redis.HGetAll(key()), map[string]string{"billing": "2", "review": "1", "support": "1"}, "the counters")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kCard = "Please refund invoice 4411, my card is 4111 1111 1111 1111";

Classification eventsC(int n, const std::string& tenant, const std::vector<std::string>& labels, const std::string& text = "") {
  return Classification{"req-" + std::to_string(n), tenant, "tx-support", 2, labels, "model", text.empty() ? "refund request number " + std::to_string(n) : text};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange(config::kOutboxKey, 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be the JSON payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckTenantKey(harness::Ctx& ctx) {
  publish(eventsC(1, "acme", {"billing"}));
  publish(eventsC(2, "globex", {"support"}));
  publish(eventsC(3, "acme", {"security"}));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(config::kTopic);
  ctx.Equal(records.size(), 3, "three publish calls must produce three records on classify.result; the records");
  ctx.Equal(ctx.Kafka.Keys(config::kTopic), {"acme", "globex", "acme"}, "the records must be keyed by the tenants");
  ctx.Equal(records[0].Partition, records[2].Partition, "both acme events must land on one partition, or acme's dashboard sees them out of order; the partitions");
}

void CheckTextHash(harness::Ctx& ctx) {
  publish(eventsC(1, "acme", {"billing"}, kCard));
  ctx.Settle();
  const auto values = ctx.Kafka.Values(config::kTopic);
  ctx.Equal(values.size(), 1, "one publish must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(value.is_object() && !value.contains("text") && values[0].find("4111") == std::string::npos,
             "the payload carries the document: %s. A retained topic must not hold tenant content", values[0]);
  ctx.Equal(field(value, "text_hash"), sha256_hex(kCard), "text_hash must be the SHA-256 hex of the text");
  ctx.Assert(field(value, "request_id") == "req-1" && field(value, "tenant") == "acme" && field(value, "taxonomy_id") == "tx-support" &&
                 value.value("taxonomy_version", 0L) == 2 && field(value, "provenance") == "model",
             "the payload must carry request_id, tenant, taxonomy_id, taxonomy_version and provenance, got %s", values[0]);
  ctx.Equal(value.value("labels", std::vector<std::string>{}), {"billing"}, "the payload's labels");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(config::kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish(eventsC(1, "acme", {"billing"}));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(config::kTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publish(eventsC(2, "acme", {"billing"}));
  ctx.Settle();
  ctx.Kafka.Failover(config::kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(config::kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(config::kTopic, 1);
  bool ok = publish(eventsC(1, "acme", {"billing"}));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the event is lost (the failure arrives in dr_cb, not from produce); the rows");
  ctx.Assert(field(rows[0], "request_id") == "req-1" && field(rows[0], "tenant") == "acme", "the outbox row must be the event's payload, got %s", rows[0].dump());
  ctx.Equal(ok, false, "publish's result after a failed delivery");
  ctx.Kafka.Stall(config::kTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publish(eventsC(2, "acme", {"billing"}));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && field(rows[1], "request_id") == "req-2", "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publish's result without an acknowledgement");
}

void CheckCountersBeforeCommit(harness::Ctx& ctx) {
  const std::vector<std::vector<std::string>> events = {{"billing"}, {"billing", "review"}, {"support"}};
  for (size_t i = 0; i < events.size(); i++) {
    const nlohmann::json payload = {{"request_id", "req-" + std::to_string(i + 1)}, {"tenant", "acme"}, {"taxonomy_id", "tx-support"}, {"taxonomy_version", 2},
                                    {"labels", events[i]}, {"provenance", "model"}, {"text_hash", std::string(64, '0')}};
    ctx.Kafka.SeedPartition(config::kTopic, 0, "acme", payload.dump());
  }
  const std::vector<int> totals = {1, 3, 4};
  const auto key = [&] { return counters::countersKey("acme", ctx.Clock.Now() / 1000); };
  const auto counted = [&] {
    int n = 0;
    for (const auto& [label, v] : ctx.Redis.HGetAll(key())) n += std::atoi(v.c_str());
    return n;
  };
  std::vector<std::string> early;
  // The consume loop idles on timeouts once the topic is drained, and the clock moves on with it:
  // the counters are read at each commit, while their hour is the current one.
  std::map<std::string, std::string> atLastCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    for (const auto& [tp, offset] : offsets) {
      if (tp.Topic != config::kTopic || offset < 1 || offset > static_cast<int64_t>(totals.size())) continue;
      if (counted() < totals[offset - 1])
        early.push_back(harness::Sprintf("offset %d was committed while the counters held %d of its %d labels: a crash now loses them", offset, counted(), totals[offset - 1]));
      atLastCommit = ctx.Redis.HGetAll(key());
    }
  });
  ctx.Drain([] { runConsumer(); });
  if (!early.empty()) ctx.Fatalf("%s", early[0]);
  ctx.Equal(ctx.Kafka.CommittedOffset(config::kGroup, config::kTopic, 0), 3, "every counted record must be committed; the committed offset");
  ctx.Equal(atLastCommit, std::map<std::string, std::string>{{"billing", "2"}, {"review", "1"}, {"support", "1"}}, "the counters at the last commit");
}
`,
  },
  hints: [
    'Acme’s dashboard shows its results out of order, a card number from a document sits in a topic kept for days, a broker hiccup duplicates one event and drops another, and a consumer restart loses counts.',
    'The record is keyed by its first label; the payload copies the text; the producer has `acks=1` and no idempotence; a broker’s refusal arrives in the delivery report, which the `except` around `produce` never sees; and the consumer commits before it counts.',
    'Key by `tenant`; replace `text` with `text_hash` (SHA-256 hex); `enable.idempotence` with `acks=all`; record the error in `on_delivery`, `flush(ACK_TIMEOUT_S)`, and `outbox.insert(payload)` on an error or a record still in flight; `bump_counter` every label, then `commit`.',
  ],
  debrief: `The key is an ordering contract: Kafka orders records only within a partition, so whatever is the key is what stays ordered, and the dashboards read per tenant. A digest is enough to match an event to its document and carries none of the content into a topic that is replicated and kept. Idempotence closes the gap a lost acknowledgement opens, and \`acks=all\` the one a leader failover opens. The outbox is fed from the delivery report because that is where a broker’s refusal arrives; a \`try\` around \`produce\` catches only a full local queue. Counting before committing makes the consumer at-least-once: a crash between the two replays the record, so production consumers also make the count idempotent, keyed by request id, and drain the outbox with a relay that uses the same producer settings.`,
};
