import type {Step} from '@/lib/types';

export const localeEventsStep: Step = {
  id: 'events',
  title: 'translation.done events keyed by locale pair, counted before the commit',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is the quality path. \`publish_done(segment)\` produces one record on
\`translation.done\` per translated segment (\`tenant\`, \`source\`, \`target\`, \`glossary_version\`,
\`latency_ms\`, \`quality_score\`, plus \`source_text\` and \`target_text\` for spot checks), keyed by
tenant, on a producer with \`acks=1\`, and writes an outbox row (\`translate.outbox\`) when
\`produce\` raises. \`run()\` is the quality consumer (group \`quality\`): it commits each record, then
adds it to the hash \`quality:{source}->{target}\` (\`segments\` +1, \`score_milli\` +
\`round(quality_score * 1000)\`). Events flow and it hides five flaws.

**Failure mode the checks target.** One locale pair's events spread over every partition; customer
text sits in a retained, replicated topic; a broker that refuses a record loses the event; a lost
acknowledgement doubles a record and a failover drops one; and a consumer that dies after a commit
leaves the counters short.

- The key is the locale pair \`{source}->{target}\`.
- The payload carries \`source_sha256\` and \`target_sha256\` (\`sha256_hex\`), never the text.
- A refused produce reaches the outbox from the delivery report (callback, rejected send, returned
  write error); \`publish_done\` does not raise.
- The producer is idempotent with \`acks=all\` (kafka-go has no idempotent producer: its writer uses
  \`RequireAll\`).
- The consumer updates both counters in one \`MULTI\`, then commits.`,
  sequence: {
    participants: ['translationd', 'translation.done', 'outbox', 'Quality consumer', 'Redis'],
    messages: [
      {
        from: 'translationd',
        to: 'translation.done',
        label: 'produce · key en->fr · hashes · idempotent, acks=all',
        kind: 'sync',
      },
      {from: 'translation.done', to: 'translationd', label: 'delivery report: error', kind: 'reply'},
      {from: 'translationd', to: 'outbox', label: 'insert(event)', kind: 'async'},
      {from: 'translation.done', to: 'Quality consumer', label: 'consume · group quality', kind: 'async'},
      {
        from: 'Quality consumer',
        to: 'Redis',
        label: 'MULTI · HINCRBY quality:en->fr segments, score_milli · EXEC',
        kind: 'sync',
      },
      {from: 'Quality consumer', to: 'translation.done', label: 'commit offset', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'locale-key',
      title: 'Keys translation.done by the locale pair',
      detail:
        "Every record is keyed `{source}->{target}`, so one pair's events share a partition and the per-locale consumer sees them in order. The starter keys by tenant.",
      match: {
        python: {all: [/key\s*=\s*locale_pair\(/], none: [/key\s*=\s*segment\[\s*["']tenant["']\s*\]/]},
        typescript: {all: [/key:\s*localePair\(/], none: [/key:\s*segment\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(localePair\(/], none: [/Key:\s*\[\]byte\(seg\.Tenant\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*localePair\(/],
          none: [/ProducerRecord\[String, String\]\(Topic,\s*segment\.tenant/],
        },
        cpp: {all: [/key\s*=\s*localePair\(/], none: [/key\s*=\s*seg\.tenant/]},
      },
    },
    {
      id: 'no-text',
      title: 'Carries text hashes, not the text',
      detail:
        'The payload carries `source_sha256` and `target_sha256` and no field holds the source or the translated text: the topic is retained and replicated, so customer text there outlives every deletion request. The starter copies both texts in.',
      match: {
        python: {all: [/source_sha256/, /target_sha256/], none: [/["']source_text["']|["']target_text["']/]},
        typescript: {all: [/source_sha256/, /target_sha256/], none: [/source_text|target_text/]},
        go: {all: [/source_sha256/, /target_sha256/], none: [/"source_text"|"target_text"/]},
        scala: {all: [/source_sha256/, /target_sha256/], none: [/"source_text"|"target_text"/]},
        cpp: {all: [/source_sha256/, /target_sha256/], none: [/"source_text"|"target_text"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes the outbox row from the delivery report',
      detail:
        "A produce the broker refuses lands in the outbox where the broker's answer arrives (the delivery callback, the rejected `send`, the returned write error), and `publish_done` does not raise. The starter wraps `produce` in `except KafkaException`, which only sees a full local queue.",
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /WriteMessages\(/]},
        scala: {all: [/Outbox\.insert\(/, /exception != null/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent with `acks=all` (`enable.idempotence` and `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes once and a leader failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll`. The starter uses `acks=1`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Counts the record before committing its offset',
      detail:
        'The consumer applies both `HINCRBY`s in one transaction and commits the offset after it, so a crash in between replays the record instead of losing it. The starter commits first.',
      match: {
        python: {order: [/def run\(/, /\.hincrby\(/, /consumer\.commit\(/]},
        typescript: {order: [/function run\(/, /\.hincrby\(/, /commitOffsets\(/]},
        go: {order: [/func run\(/, /HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/def run\(/, /hincrBy\(/, /commitSync\(/]},
        cpp: {order: [/void run\(/, /hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer

from translate import outbox  # outbox.insert(value)
from translate.text import sha256_hex

TOPIC = "translation.done"
GROUP = "quality"
log = logging.getLogger("events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
consumer.subscribe([TOPIC])


def locale_pair(source: str, target: str) -> str:
    return f"{source}->{target}"


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("translation.done not delivered: %s", err)


def publish_done(segment: dict) -> None:
    """One translation.done event for a translated segment: tenant, source, target, glossary_version, text, translation, latency_ms, quality_score."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {
        "tenant": segment["tenant"],
        "source": segment["source"],
        "target": segment["target"],
        "glossary_version": segment["glossary_version"],
        "latency_ms": segment["latency_ms"],
        "quality_score": segment["quality_score"],
        "source_text": segment["text"],
        "target_text": segment["translation"],
    }
    value = json.dumps(event)
    try:
        producer.produce(TOPIC, key=segment["tenant"], value=value, on_delivery=on_delivery)
    except KafkaException:
        outbox.insert(value)
    producer.poll(0)


def run() -> None:
    """The quality consumer: per-locale counters in quality:{source}->{target}."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        try:
            event = json.loads(msg.value())
            key = f"quality:{locale_pair(event['source'], event['target'])}"
            score = round(float(event["quality_score"]) * 1000)
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        consumer.commit(message=msg, asynchronous=False)
        with r.pipeline() as pipe:
            pipe.hincrby(key, "segments", 1)
            pipe.hincrby(key, "score_milli", score)
            pipe.execute()
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from translate import outbox  # outbox.insert(value)
from translate.text import sha256_hex

TOPIC = "translation.done"
GROUP = "quality"
log = logging.getLogger("events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Idempotent with acks=all: a retry after a lost acknowledgement writes once, and every replica has it.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
consumer.subscribe([TOPIC])


def locale_pair(source: str, target: str) -> str:
    return f"{source}->{target}"


def publish_done(segment: dict) -> None:
    """One translation.done event for a translated segment: tenant, source, target, glossary_version, text, translation, latency_ms, quality_score."""
    event = {
        "tenant": segment["tenant"],
        "source": segment["source"],
        "target": segment["target"],
        "glossary_version": segment["glossary_version"],
        "latency_ms": segment["latency_ms"],
        "quality_score": segment["quality_score"],
        # Hashes let a reviewer match an event to a segment; the text stays out of a retained topic.
        "source_sha256": sha256_hex(segment["text"]),
        "target_sha256": sha256_hex(segment["translation"]),
    }
    value = json.dumps(event)

    def on_delivery(err, msg) -> None:
        if err is not None:
            log.warning("translation.done not delivered: %s", err)
            outbox.insert(value)  # the broker said no: the relay replays the row later

    # One locale pair, one partition: the quality consumer sees a pair's events in order.
    producer.produce(TOPIC, key=locale_pair(segment["source"], segment["target"]), value=value, on_delivery=on_delivery)
    producer.poll(0)


def run() -> None:
    """The quality consumer: per-locale counters in quality:{source}->{target}."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        try:
            event = json.loads(msg.value())
            key = f"quality:{locale_pair(event['source'], event['target'])}"
            score = round(float(event["quality_score"]) * 1000)
        except (ValueError, KeyError, TypeError):
            log.warning("skipping malformed record at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        with r.pipeline() as pipe:  # MULTI/EXEC: both counters or neither
            pipe.hincrby(key, "segments", 1)
            pipe.hincrby(key, "score_milli", score)
            pipe.execute()
        consumer.commit(message=msg, asynchronous=False)  # counted: a crash before this replays the record
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import * as outbox from 'translate/outbox'; // outbox.insert(value)
import {sha256Hex} from 'translate/text';

export const TOPIC = 'translation.done';
export const GROUP = 'quality';

export interface Segment {
  tenant: string;
  source: string;
  target: string;
  glossary_version: number;
  text: string;
  translation: string;
  latency_ms: number;
  quality_score: number;
}

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'translationd', brokers: ['kafka:9092']});
export const producer = kafka.producer();
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

export const localePair = (source: string, target: string): string => \`\${source}->\${target}\`;

/** One translation.done event for a translated segment. */
export async function publishDone(segment: Segment): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {
    tenant: segment.tenant,
    source: segment.source,
    target: segment.target,
    glossary_version: segment.glossary_version,
    latency_ms: segment.latency_ms,
    quality_score: segment.quality_score,
    source_text: segment.text,
    target_text: segment.translation,
  };
  await producer.send({topic: TOPIC, messages: [{key: segment.tenant, value: JSON.stringify(event)}], acks: 1});
}

/** The quality consumer: per-locale counters in quality:{source}->{target}. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const next = String(Number(message.offset) + 1);
      let key: string;
      let score: number;
      try {
        const event = JSON.parse(message.value?.toString() ?? '');
        if (typeof event.source !== 'string' || typeof event.target !== 'string' || typeof event.quality_score !== 'number') throw new Error('malformed');
        key = \`quality:\${localePair(event.source, event.target)}\`;
        score = Math.round(event.quality_score * 1000);
      } catch {
        console.warn(\`skipping malformed record at offset \${message.offset}\`);
        await consumer.commitOffsets([{topic, partition, offset: next}]);
        return;
      }
      await consumer.commitOffsets([{topic, partition, offset: next}]);
      await redis.multi().hincrby(key, 'segments', 1).hincrby(key, 'score_milli', score).exec();
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import * as outbox from 'translate/outbox'; // outbox.insert(value)
import {sha256Hex} from 'translate/text';

export const TOPIC = 'translation.done';
export const GROUP = 'quality';

export interface Segment {
  tenant: string;
  source: string;
  target: string;
  glossary_version: number;
  text: string;
  translation: string;
  latency_ms: number;
  quality_score: number;
}

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'translationd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes once, and every replica has it.
export const producer = kafka.producer({idempotent: true});
void producer.connect();
const consumer = kafka.consumer({groupId: GROUP});

export const localePair = (source: string, target: string): string => \`\${source}->\${target}\`;

/** One translation.done event for a translated segment. */
export async function publishDone(segment: Segment): Promise<void> {
  const event = {
    tenant: segment.tenant,
    source: segment.source,
    target: segment.target,
    glossary_version: segment.glossary_version,
    latency_ms: segment.latency_ms,
    quality_score: segment.quality_score,
    // Hashes let a reviewer match an event to a segment; the text stays out of a retained topic.
    source_sha256: sha256Hex(segment.text),
    target_sha256: sha256Hex(segment.translation),
  };
  const value = JSON.stringify(event);
  try {
    // One locale pair, one partition: the quality consumer sees a pair's events in order.
    await producer.send({topic: TOPIC, messages: [{key: localePair(segment.source, segment.target), value}], acks: -1});
  } catch (e) {
    console.warn(\`translation.done not delivered: \${(e as Error).message}\`);
    await outbox.insert(value); // the broker said no: the relay replays the row later
  }
}

/** The quality consumer: per-locale counters in quality:{source}->{target}. */
export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const next = String(Number(message.offset) + 1);
      let key: string;
      let score: number;
      try {
        const event = JSON.parse(message.value?.toString() ?? '');
        if (typeof event.source !== 'string' || typeof event.target !== 'string' || typeof event.quality_score !== 'number') throw new Error('malformed');
        key = \`quality:\${localePair(event.source, event.target)}\`;
        score = Math.round(event.quality_score * 1000);
      } catch {
        console.warn(\`skipping malformed record at offset \${message.offset}\`);
        await consumer.commitOffsets([{topic, partition, offset: next}]);
        return;
      }
      await redis.multi().hincrby(key, 'segments', 1).hincrby(key, 'score_milli', score).exec(); // both counters or neither
      await consumer.commitOffsets([{topic, partition, offset: next}]); // counted: a crash before this replays the record
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
	"math"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	topic = "translation.done"
	group = "quality"
)

// Segment is one translated segment.
type Segment struct {
	Tenant          string
	Source          string
	Target          string
	GlossaryVersion int64
	Text            string
	Translation     string
	LatencyMs       int64
	QualityScore    float64
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

var reader = kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})

func localePair(source, target string) string { return source + "->" + target }

// publishDone produces one translation.done event for a translated segment.
func publishDone(ctx context.Context, seg Segment) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(map[string]any{
		"tenant":           seg.Tenant,
		"source":           seg.Source,
		"target":           seg.Target,
		"glossary_version": seg.GlossaryVersion,
		"latency_ms":       seg.LatencyMs,
		"quality_score":    seg.QualityScore,
		"source_text":      seg.Text,
		"target_text":      seg.Translation,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(seg.Tenant), Value: value}); err != nil {
		log.Printf("translation.done not delivered: %v", err)
	}
	return nil
}

type doneEvent struct {
	Source       string   \`json:"source"\`
	Target       string   \`json:"target"\`
	QualityScore *float64 \`json:"quality_score"\`
}

// run is the quality consumer: per-locale counters in quality:{source}->{target}.
func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event doneEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.Source == "" || event.Target == "" || event.QualityScore == nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		key := "quality:" + localePair(event.Source, event.Target)
		score := int64(math.Round(*event.QualityScore * 1000))
		if _, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.HIncrBy(ctx, key, "segments", 1)
			pipe.HIncrBy(ctx, key, "score_milli", score)
			return nil
		}); err != nil {
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
	"math"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"translate/outbox" // outbox.Insert(ctx, value)
	"translate/text"   // text.SHA256Hex
)

const (
	topic = "translation.done"
	group = "quality"
)

// Segment is one translated segment.
type Segment struct {
	Tenant          string
	Source          string
	Target          string
	GlossaryVersion int64
	Text            string
	Translation     string
	LatencyMs       int64
	QualityScore    float64
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// RequireAll: every replica has the record before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate a record.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

var reader = kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})

func localePair(source, target string) string { return source + "->" + target }

// publishDone produces one translation.done event for a translated segment.
func publishDone(ctx context.Context, seg Segment) error {
	value, _ := json.Marshal(map[string]any{
		"tenant":           seg.Tenant,
		"source":           seg.Source,
		"target":           seg.Target,
		"glossary_version": seg.GlossaryVersion,
		"latency_ms":       seg.LatencyMs,
		"quality_score":    seg.QualityScore,
		// Hashes let a reviewer match an event to a segment; the text stays out of a retained topic.
		"source_sha256": text.SHA256Hex(seg.Text),
		"target_sha256": text.SHA256Hex(seg.Translation),
	})
	// One locale pair, one partition: the quality consumer sees a pair's events in order.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(localePair(seg.Source, seg.Target)), Value: value}); err != nil {
		log.Printf("translation.done not delivered: %v", err)
		return outbox.Insert(ctx, value) // the broker said no: the relay replays the row later
	}
	return nil
}

type doneEvent struct {
	Source       string   \`json:"source"\`
	Target       string   \`json:"target"\`
	QualityScore *float64 \`json:"quality_score"\`
}

// run is the quality consumer: per-locale counters in quality:{source}->{target}.
func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event doneEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil || event.Source == "" || event.Target == "" || event.QualityScore == nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		key := "quality:" + localePair(event.Source, event.Target)
		score := int64(math.Round(*event.QualityScore * 1000))
		// MULTI/EXEC: both counters or neither.
		if _, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.HIncrBy(ctx, key, "segments", 1)
			pipe.HIncrBy(ctx, key, "score_milli", score)
			return nil
		}); err != nil {
			return err // not committed: redelivered after a restart
		}
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

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import translate.{Outbox, Text} // Outbox.insert(value), Text.sha256Hex

/** One translated segment. */
final case class Segment(tenant: String, source: String, target: String, glossaryVersion: Long, text: String, translation: String, latencyMs: Long, qualityScore: Double)

object Events {
  val Topic = "translation.done"
  val Group = "quality"

  val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "1")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  def localePair(source: String, target: String): String = s"$source->$target"

  /** One translation.done event for a translated segment. */
  def publishDone(segment: Segment): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val value = JsObject(
      "tenant" -> JsString(segment.tenant),
      "source" -> JsString(segment.source),
      "target" -> JsString(segment.target),
      "glossary_version" -> JsNumber(segment.glossaryVersion),
      "latency_ms" -> JsNumber(segment.latencyMs),
      "quality_score" -> JsNumber(segment.qualityScore),
      "source_text" -> JsString(segment.text),
      "target_text" -> JsString(segment.translation),
    ).compactPrint
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) System.err.println(s"translation.done not delivered: \${exception.getMessage}")
    }
    producer.send(new ProducerRecord[String, String](Topic, segment.tenant, value), onDelivery)
  }

  /** The quality consumer: per-locale counters in quality:{source}->{target}. */
  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      consumer.commitSync()
      records.asScala.foreach { record =>
        scala.util.Try(record.value().parseJson.asJsObject.fields) match {
          case scala.util.Success(fields) if Seq("source", "target", "quality_score").forall(fields.contains) =>
            val key = s"quality:\${localePair(fields("source").convertTo[String](DefaultJsonProtocol.StringJsonFormat), fields("target").convertTo[String](DefaultJsonProtocol.StringJsonFormat))}"
            val score = math.round(fields("quality_score").convertTo[Double](DefaultJsonProtocol.DoubleJsonFormat) * 1000)
            val tx = jedis.multi()
            tx.hincrBy(key, "segments", 1)
            tx.hincrBy(key, "score_milli", score)
            tx.exec()
          case _ => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import translate.{Outbox, Text} // Outbox.insert(value), Text.sha256Hex

/** One translated segment. */
final case class Segment(tenant: String, source: String, target: String, glossaryVersion: Long, text: String, translation: String, latencyMs: Long, qualityScore: Double)

object Events {
  val Topic = "translation.done"
  val Group = "quality"

  val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, and every replica has it.
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", Group)
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  def localePair(source: String, target: String): String = s"$source->$target"

  /** One translation.done event for a translated segment. */
  def publishDone(segment: Segment): Unit = {
    val value = JsObject(
      "tenant" -> JsString(segment.tenant),
      "source" -> JsString(segment.source),
      "target" -> JsString(segment.target),
      "glossary_version" -> JsNumber(segment.glossaryVersion),
      "latency_ms" -> JsNumber(segment.latencyMs),
      "quality_score" -> JsNumber(segment.qualityScore),
      // Hashes let a reviewer match an event to a segment; the text stays out of a retained topic.
      "source_sha256" -> JsString(Text.sha256Hex(segment.text)),
      "target_sha256" -> JsString(Text.sha256Hex(segment.translation)),
    ).compactPrint
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          System.err.println(s"translation.done not delivered: \${exception.getMessage}")
          Outbox.insert(value) // the broker said no: the relay replays the row later
        }
    }
    // One locale pair, one partition: the quality consumer sees a pair's events in order.
    producer.send(new ProducerRecord[String, String](Topic, localePair(segment.source, segment.target), value), onDelivery)
  }

  /** The quality consumer: per-locale counters in quality:{source}->{target}. */
  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        scala.util.Try(record.value().parseJson.asJsObject.fields) match {
          case scala.util.Success(fields) if Seq("source", "target", "quality_score").forall(fields.contains) =>
            val key = s"quality:\${localePair(fields("source").convertTo[String](DefaultJsonProtocol.StringJsonFormat), fields("target").convertTo[String](DefaultJsonProtocol.StringJsonFormat))}"
            val score = math.round(fields("quality_score").convertTo[Double](DefaultJsonProtocol.DoubleJsonFormat) * 1000)
            val tx = jedis.multi() // both counters or neither
            tx.hincrBy(key, "segments", 1)
            tx.hincrBy(key, "score_milli", score)
            tx.exec()
          case _ => System.err.println(s"skipping malformed record at offset \${record.offset()}")
        }
      }
      consumer.commitSync() // every record of the batch is counted: a crash before this replays them
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cmath>
#include <iostream>
#include <memory>
#include <string>

#include "translate/outbox.h"  // outbox::insert(value)
#include "translate/text.h"    // text::sha256Hex

using json = nlohmann::json;

const std::string kTopic = "translation.done";
const std::string kGroup = "quality";

// One translated segment.
struct Segment {
  std::string tenant, source, target;
  long glossary_version = 0;
  std::string text, translation;
  long latency_ms = 0;
  double quality_score = 0;
};

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "translation.done not delivered: " << message.errstr() << "\\n";
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

auto producer = make_producer();
auto consumer = make_consumer();

std::string localePair(const std::string& source, const std::string& target) { return source + "->" + target; }

// One translation.done event for a translated segment.
void publishDone(const Segment& seg) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string value = json{{"tenant", seg.tenant},
                                 {"source", seg.source},
                                 {"target", seg.target},
                                 {"glossary_version", seg.glossary_version},
                                 {"latency_ms", seg.latency_ms},
                                 {"quality_score", seg.quality_score},
                                 {"source_text", seg.text},
                                 {"target_text", seg.translation}}
                                .dump();
  const std::string key = seg.tenant;
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(), key.c_str(),
                    key.size(), 0, nullptr);
  producer->poll(0);
}

// The quality consumer: per-locale counters in quality:{source}->{target}.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_discarded() || !event.is_object() || !event.contains("source") || !event.contains("target") || !event["quality_score"].is_number()) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    consumer->commitSync(msg.get());
    const std::string key = "quality:" + localePair(event["source"].get<std::string>(), event["target"].get<std::string>());
    const long long score = std::llround(event["quality_score"].get<double>() * 1000);
    auto tx = redis.transaction();
    tx.hincrby(key, "segments", 1).hincrby(key, "score_milli", score).exec();
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cmath>
#include <iostream>
#include <memory>
#include <string>

#include "translate/outbox.h"  // outbox::insert(value)
#include "translate/text.h"    // text::sha256Hex

using json = nlohmann::json;

const std::string kTopic = "translation.done";
const std::string kGroup = "quality";

// One translated segment.
struct Segment {
  std::string tenant, source, target;
  long glossary_version = 0;
  std::string text, translation;
  long latency_ms = 0;
  double quality_score = 0;
};

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report is where the broker's refusal arrives: the event goes to the outbox from here.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    std::cerr << "translation.done not delivered: " << message.errstr() << "\\n";
    outbox::insert(std::string(static_cast<const char*>(message.payload()), message.len()));  // the relay replays the row later
  }
};

ToOutbox delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, and every replica has it.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
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

auto producer = make_producer();
auto consumer = make_consumer();

std::string localePair(const std::string& source, const std::string& target) { return source + "->" + target; }

// One translation.done event for a translated segment.
void publishDone(const Segment& seg) {
  // Hashes let a reviewer match an event to a segment; the text stays out of a retained topic.
  const std::string value = json{{"tenant", seg.tenant},
                                 {"source", seg.source},
                                 {"target", seg.target},
                                 {"glossary_version", seg.glossary_version},
                                 {"latency_ms", seg.latency_ms},
                                 {"quality_score", seg.quality_score},
                                 {"source_sha256", text::sha256Hex(seg.text)},
                                 {"target_sha256", text::sha256Hex(seg.translation)}}
                                .dump();
  // One locale pair, one partition: the quality consumer sees a pair's events in order.
  const std::string key = localePair(seg.source, seg.target);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(), key.c_str(),
                    key.size(), 0, nullptr);
  producer->poll(0);
}

// The quality consumer: per-locale counters in quality:{source}->{target}.
void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()), nullptr, false);
    if (event.is_discarded() || !event.is_object() || !event.contains("source") || !event.contains("target") || !event["quality_score"].is_number()) {
      std::cerr << "skipping malformed record at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const std::string key = "quality:" + localePair(event["source"].get<std::string>(), event["target"].get<std::string>());
    const long long score = std::llround(event["quality_score"].get<double>() * 1000);
    auto tx = redis.transaction();  // MULTI/EXEC: both counters or neither
    tx.hincrby(key, "segments", 1).hincrby(key, "score_milli", score).exec();
    consumer->commitSync(msg.get());  // counted: a crash before this replays the record
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

TOPIC = "translation.done"
SEGMENT = {
    "tenant": "acme",
    "source": "en",
    "target": "fr",
    "glossary_version": 2,
    "text": "Open the Dashboard",
    "translation": "[fr] Open the Tableau de bord",
    "latency_ms": 180,
    "quality_score": 0.92,
}


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _settle(m):
    """Serve the producer's delivery reports, as the service's poll loop would."""
    m.producer.flush(5.0)


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _publish(m, **changes):
    try:
        m.publish_done({**SEGMENT, **changes})
    except Exception as exc:
        raise AssertionError(f"publish_done raised {type(exc).__name__}: {exc}; a refused event goes to the outbox, the request goes on")


def check_locale_key(ctx):
    m = ctx.load("events")
    _publish(m)
    _publish(m, tenant="globex")
    _publish(m, target="de")
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"en->fr", b"en->fr", b"en->de"], f"records must be keyed by the locale pair, got {keys}: keyed by tenant, one pair's events spread over every partition"
    assert records[0].partition == records[1].partition, "acme's and globex's en->fr events must share a partition so the quality consumer reads the pair in order"


def check_no_text(ctx):
    m = ctx.load("events")
    _publish(m)
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one segment produced {len(records)} records"
    payload = _payload(records[0])
    for name, value in payload.items():
        assert value not in (SEGMENT["text"], SEGMENT["translation"]), f"the event carries customer text in {name}: {payload}. The topic is retained and replicated; carry hashes"
    assert payload.get("source_sha256") == _sha(SEGMENT["text"]) and payload.get("target_sha256") == _sha(SEGMENT["translation"]), f"the event must carry source_sha256 and target_sha256 of the two texts, got {payload}"
    assert payload.get("glossary_version") == 2 and payload.get("quality_score") == 0.92 and payload.get("tenant") == "acme", f"the event lost its fields: {payload}"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    _publish(m)
    _settle(m)
    rows = ctx.redis.lrange("outbox:translation.done", 0, -1)
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: the delivery report is where the refusal arrives, and nothing there kept the event"
    row = json.loads(rows[0])
    assert row.get("source") == "en" and row.get("glossary_version") == 2, f"the outbox row must be the event itself, got {row}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    _publish(m, text="Close the Dashboard")
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(ctx.redis.lrange("outbox:translation.done", 0, -1)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    _publish(m)
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one segment whose acknowledgement was lost left {len(records)} records: the producer's retry wrote it twice and the quality numbers count it twice. Enable idempotence (with acks=all)"
    _publish(m, text="Close the Dashboard")
    _settle(m)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone had the second event. Use acks=all"


def _seed(ctx, source, target, score):
    event = {"tenant": "acme", "source": source, "target": target, "glossary_version": 2, "latency_ms": 180, "quality_score": score}
    ctx.kafka.seed(TOPIC, key=f"{source}->{target}", value=json.dumps(event))


def check_counters_before_commit(ctx):
    _seed(ctx, "en", "fr", 0.9)
    _seed(ctx, "en", "fr", 0.8)
    _seed(ctx, "en", "de", 0.5)
    m = ctx.load("events")
    counted = []  # records counted in Redis at the moment of each commit

    def at_commit(group, offsets):
        counted.append(sum(int(ctx.redis.hget(k, "segments") or 0) for k in ("quality:en->fr", "quality:en->de")))

    ctx.kafka.on_commit(at_commit)
    ctx.drain(m.run)
    fr, de = ctx.redis.hgetall("quality:en->fr"), ctx.redis.hgetall("quality:en->de")
    assert fr == {"segments": "2", "score_milli": "1700"} and de == {"segments": "1", "score_milli": "500"}, f"the counters are en->fr {fr}, en->de {de}; expected en->fr 2 segments / 1700, en->de 1 / 500"
    assert ctx.kafka.lag("quality", TOPIC) == 0, "every record must be committed"
    short = [n for i, n in enumerate(counted) if n < i + 1]
    assert not short, f"at the commits the counters held {counted} records: a commit ran before its record was counted, so a crash between them loses the record. Count, then commit"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'translation.done';
const SEGMENT = {
  tenant: 'acme',
  source: 'en',
  target: 'fr',
  glossary_version: 2,
  text: 'Open the Dashboard',
  translation: '[fr] Open the Tableau de bord',
  latency_ms: 180,
  quality_score: 0.92,
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

async function publish(m, changes = {}) {
  try {
    await m.publishDone({...SEGMENT, ...changes});
  } catch (e) {
    assert.fail(\`publishDone threw \${(e as Error).message}: a refused event goes to the outbox, the request goes on\`);
  }
}

const outboxRows = ctx => ctx.redis.lrange('outbox:translation.done', 0, -1);

export async function check_locale_key(ctx) {
  const m = ctx.load('events');
  await publish(m);
  await publish(m, {tenant: 'globex'});
  await publish(m, {target: 'de'});
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['en->fr', 'en->fr', 'en->de'], \`records must be keyed by the locale pair, got \${JSON.stringify(keys)}: keyed by tenant, one pair's events spread over every partition\`);
  assert.equal(records[0].partition, records[1].partition, "acme's and globex's en->fr events must share a partition so the quality consumer reads the pair in order");
}

export async function check_no_text(ctx) {
  const m = ctx.load('events');
  await publish(m);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one segment produced \${records.length} records\`);
  const p = payload(records[0]);
  for (const [name, value] of Object.entries(p)) {
    assert(value !== SEGMENT.text && value !== SEGMENT.translation, \`the event carries customer text in \${name}: \${JSON.stringify(p)}. The topic is retained and replicated; carry hashes\`);
  }
  assert(p.source_sha256 === sha(SEGMENT.text) && p.target_sha256 === sha(SEGMENT.translation), \`the event must carry source_sha256 and target_sha256 of the two texts, got \${JSON.stringify(p)}\`);
  assert(p.glossary_version === 2 && p.quality_score === 0.92 && p.tenant === 'acme', \`the event lost its fields: \${JSON.stringify(p)}\`);
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await publish(m);
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: the rejected send is where the refusal arrives, and nothing there kept the event\`);
  const row = JSON.parse(rows[0]);
  assert(row.source === 'en' && row.glossary_version === 2, \`the outbox row must be the event itself, got \${rows[0]}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  await publish(m, {text: 'Close the Dashboard'});
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the failure reaches the topic and adds no outbox row');
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await publish(m);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one segment whose acknowledgement was lost left \${records.length} records: the producer's retry wrote it twice and the quality numbers count it twice. Make the producer idempotent (acks all)\`);
  await publish(m, {text: 'Close the Dashboard'});
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone had the second event. Use acks -1 (all)\`);
}

function seed(ctx, source: string, target: string, score: number) {
  const event = {tenant: 'acme', source, target, glossary_version: 2, latency_ms: 180, quality_score: score};
  ctx.kafka.seed(TOPIC, {key: \`\${source}->\${target}\`, value: JSON.stringify(event)});
}

export async function check_counters_before_commit(ctx) {
  seed(ctx, 'en', 'fr', 0.9);
  seed(ctx, 'en', 'fr', 0.8);
  seed(ctx, 'en', 'de', 0.5);
  const m = ctx.load('events');
  const counted: number[] = []; // records counted in Redis at the moment of each commit
  ctx.kafka.onCommit(() => counted.push(['quality:en->fr', 'quality:en->de'].reduce((n, k) => n + Number(ctx.redis.hget(k, 'segments') ?? 0), 0)));
  await ctx.drain(m.run());
  const fr = ctx.redis.hgetall('quality:en->fr');
  const de = ctx.redis.hgetall('quality:en->de');
  assert(fr.segments === '2' && fr.score_milli === '1700' && de.segments === '1' && de.score_milli === '500', \`the counters are en->fr \${JSON.stringify(fr)}, en->de \${JSON.stringify(de)}; expected en->fr 2 segments / 1700, en->de 1 / 500\`);
  assert.equal(ctx.kafka.lag('quality', TOPIC), 0, 'every record must be committed');
  const short = counted.filter((n, i) => n < i + 1);
  assert.equal(short.length, 0, \`at the commits the counters held \${JSON.stringify(counted)} records: a commit ran before its record was counted, so a crash between them loses the record. Count, then commit\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"leetbuild/harness"
)

var (
	eventsBg = context.Background()
	segment  = Segment{Tenant: "acme", Source: "en", Target: "fr", GlossaryVersion: 2, Text: "Open the Dashboard", Translation: "[fr] Open the Tableau de bord", LatencyMs: 180, QualityScore: 0.92}
)

func eventsSha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func mustPublish(ctx *harness.Ctx, seg Segment) {
	ctx.NoError(publishDone(eventsBg, seg), "publishDone failed: a refused event goes to the outbox, the request goes on")
	ctx.Settle()
}

func CheckLocaleKey(ctx *harness.Ctx) {
	mustPublish(ctx, segment)
	globex := segment
	globex.Tenant = "globex"
	mustPublish(ctx, globex)
	german := segment
	german.Target = "de"
	mustPublish(ctx, german)
	records := ctx.Kafka.Records(topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"en->fr", "en->fr", "en->de"}, "records must be keyed by the locale pair (keyed by tenant, one pair's events spread over every partition)")
	ctx.Assert(records[0].Partition == records[1].Partition, "acme's and globex's en->fr events landed on partitions %d and %d: one pair must share a partition so the quality consumer reads it in order", records[0].Partition, records[1].Partition)
}

func CheckNoText(ctx *harness.Ctx) {
	mustPublish(ctx, segment)
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 1, "one segment; the records")
	p := payloadOf(ctx, records[0].Value)
	for name, value := range p {
		ctx.Assert(value != segment.Text && value != segment.Translation, "the event carries customer text in %s: %v. The topic is retained and replicated; carry hashes", name, p)
	}
	ctx.Assert(p["source_sha256"] == eventsSha(segment.Text) && p["target_sha256"] == eventsSha(segment.Translation), "the event must carry source_sha256 and target_sha256 of the two texts, got %v", p)
	ctx.Assert(p["glossary_version"] == float64(2) && p["quality_score"] == 0.92 && p["tenant"] == "acme", "the event lost its fields: %v", p)
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	mustPublish(ctx, segment)
	rows := ctx.Redis.LRange("outbox:translation.done", 0, -1)
	ctx.Equal(len(rows), 1, "the broker refused one produce: the returned write error is where the refusal arrives, and the event must be kept; outbox rows")
	row := payloadOf(ctx, []byte(rows[0]))
	ctx.Assert(row["source"] == "en" && row["glossary_version"] == float64(2), "the outbox row must be the event itself, got %v", row)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "nothing reached the topic for the refused produce; the records")
	next := segment
	next.Text = "Close the Dashboard"
	mustPublish(ctx, next)
	ctx.Assert(len(ctx.Kafka.Records(topic)) == 1 && len(ctx.Redis.LRange("outbox:translation.done", 0, -1)) == 1, "a healthy produce after the failure reaches the topic and adds no outbox row")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	mustPublish(ctx, segment)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one segment, the records on the topic")
	next := segment
	next.Text = "Close the Dashboard"
	mustPublish(ctx, next)
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone had the event. Use RequireAll; the records on the topic", lost)
}

func seedDone(ctx *harness.Ctx, source, target string, score float64) {
	value, _ := json.Marshal(map[string]any{"tenant": "acme", "source": source, "target": target, "glossary_version": 2, "latency_ms": 180, "quality_score": score})
	ctx.Kafka.Seed(topic, source+"->"+target, value)
}

func CheckCountersBeforeCommit(ctx *harness.Ctx) {
	seedDone(ctx, "en", "fr", 0.9)
	seedDone(ctx, "en", "fr", 0.8)
	seedDone(ctx, "en", "de", 0.5)
	var counted []int // records counted in Redis at the moment of each commit
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		total := 0
		for _, key := range []string{"quality:en->fr", "quality:en->de"} {
			if n, ok := ctx.Redis.HGet(key, "segments"); ok {
				v := 0
				for _, c := range n {
					v = v*10 + int(c-'0')
				}
				total += v
			}
		}
		counted = append(counted, total)
	})
	ctx.Drain(func() { run(context.Background()) })
	ctx.Equal(ctx.Redis.HGetAll("quality:en->fr"), map[string]string{"segments": "2", "score_milli": "1700"}, "en->fr's counters")
	ctx.Equal(ctx.Redis.HGetAll("quality:en->de"), map[string]string{"segments": "1", "score_milli": "500"}, "en->de's counters")
	ctx.Equal(ctx.Kafka.Lag("quality", topic), int64(0), "every record must be committed; the lag")
	for i, n := range counted {
		ctx.Assert(n >= i+1, "at the commits the counters held %v records: a commit ran before its record was counted, so a crash between them loses the record. Count, then commit", counted)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <string>
#include <vector>

namespace {

const Segment kSegment{"acme", "en", "fr", 2, "Open the Dashboard", "[fr] Open the Tableau de bord", 180, 0.92};

std::string sha(const std::string& s) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(s.data()), s.size(), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char b : digest) {
    out += hex[b >> 4];
    out += hex[b & 0x0f];
  }
  return out;
}

json payloadOf(harness::Ctx& ctx, const std::string& value) {
  const json p = json::parse(value, nullptr, false);
  ctx.Assert(p.is_object(), "the record's value is not JSON: %s", value);
  return p;
}

void mustPublish(harness::Ctx& ctx, const Segment& seg) {
  try {
    publishDone(seg);
  } catch (const std::exception& e) {
    ctx.Fatalf("publishDone threw %s: %s; a refused event goes to the outbox, the request goes on", harness::CurrentExceptionType(), e.what());
  }
  ctx.Settle();
  producer->flush(5000);  // the service's poll loop serves the delivery reports
}

void seedDone(harness::Ctx& ctx, const std::string& source, const std::string& target, double score) {
  const json event = {{"tenant", "acme"}, {"source", source}, {"target", target}, {"glossary_version", 2}, {"latency_ms", 180}, {"quality_score", score}};
  ctx.Kafka.Seed(kTopic, source + "->" + target, event.dump());
}

}  // namespace

void CheckLocaleKey(harness::Ctx& ctx) {
  mustPublish(ctx, kSegment);
  Segment globex = kSegment;
  globex.tenant = "globex";
  mustPublish(ctx, globex);
  Segment german = kSegment;
  german.target = "de";
  mustPublish(ctx, german);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"en->fr", "en->fr", "en->de"}, "records must be keyed by the locale pair (keyed by tenant, one pair's events spread over every partition)");
  ctx.Assert(records.size() >= 2 && records[0].Partition == records[1].Partition, "acme's and globex's en->fr events must share a partition so the quality consumer reads the pair in order");
}

void CheckNoText(harness::Ctx& ctx) {
  mustPublish(ctx, kSegment);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one segment; the records");
  const json p = payloadOf(ctx, records[0].Value.value_or(""));
  for (const auto& [name, value] : p.items()) {
    ctx.Assert(value != kSegment.text && value != kSegment.translation, "the event carries customer text in %s: %s. The topic is retained and replicated; carry hashes", name, p.dump());
  }
  ctx.Assert(p.value("source_sha256", "") == sha(kSegment.text) && p.value("target_sha256", "") == sha(kSegment.translation), "the event must carry source_sha256 and target_sha256 of the two texts, got %s", p.dump());
  ctx.Assert(p.value("glossary_version", 0L) == 2 && p.value("tenant", "") == "acme", "the event lost its fields: %s", p.dump());
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  mustPublish(ctx, kSegment);
  const auto rows = ctx.Redis.LRange("outbox:translation.done", 0, -1);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: the delivery report is where the refusal arrives, and the event must be kept; outbox rows");
  const json row = payloadOf(ctx, rows.empty() ? "{}" : rows[0]);
  ctx.Assert(row.value("source", "") == "en" && row.value("glossary_version", 0L) == 2, "the outbox row must be the event itself, got %s", row.dump());
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "nothing reached the topic for the refused produce; the records");
  Segment next = kSegment;
  next.text = "Close the Dashboard";
  mustPublish(ctx, next);
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && ctx.Redis.LRange("outbox:translation.done", 0, -1).size() == 1, "a healthy produce after the failure reaches the topic and adds no outbox row");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  mustPublish(ctx, kSegment);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one segment whose acknowledgement was lost: the producer's retry wrote it twice. Set enable.idempotence (with acks=all); the records on the topic");
  Segment next = kSegment;
  next.text = "Close the Dashboard";
  mustPublish(ctx, next);
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone had the event. Use acks=all; the records on the topic", lost);
}

void CheckCountersBeforeCommit(harness::Ctx& ctx) {
  seedDone(ctx, "en", "fr", 0.9);
  seedDone(ctx, "en", "fr", 0.8);
  seedDone(ctx, "en", "de", 0.5);
  std::vector<long> counted;  // records counted in Redis at the moment of each commit
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    long total = 0;
    for (const std::string key : {"quality:en->fr", "quality:en->de"}) total += std::stol(ctx.Redis.HGet(key, "segments").value_or("0"));
    counted.push_back(total);
  });
  ctx.Drain([] { run(); });
  ctx.Equal(ctx.Redis.HGetAll("quality:en->fr"), std::map<std::string, std::string>{{"segments", "2"}, {"score_milli", "1700"}}, "en->fr's counters");
  ctx.Equal(ctx.Redis.HGetAll("quality:en->de"), std::map<std::string, std::string>{{"segments", "1"}, {"score_milli", "500"}}, "en->de's counters");
  ctx.Equal(ctx.Kafka.Lag("quality", kTopic), 0, "every record must be committed; the lag");
  for (size_t i = 0; i < counted.size(); i++) {
    ctx.Assert(counted[i] >= static_cast<long>(i + 1), "at the commits the counters held %v records: a commit ran before its record was counted, so a crash between them loses the record. Count, then commit", counted);
  }
}
`,
  },
  hints: [
    "Produce three segments, two of them en->fr from different tenants: they land on different partitions. Read a record: the customer's sentence is in it. Refuse one produce: the outbox stays empty. Kill the consumer after a commit: the counters come up short.",
    'The key is the tenant and the payload copies both texts; the outbox write sits in `except KafkaException`, which sees only local errors, while the refusal arrives in `on_delivery`; the producer has `acks=1`; `run` commits before the `MULTI`.',
    'Key with `locale_pair(source, target)`; carry `source_sha256`/`target_sha256`; call `outbox.insert(value)` in the delivery callback; configure `enable.idempotence` and `acks=all`; move `consumer.commit` after `pipe.execute()`.',
  ],
  debrief: `The key decides what "in order" means: per-locale quality is computed per pair, so the pair is the key and one consumer reads one pair's history in sequence. Hashes keep the event useful for joining back to a segment while the text stays in the system that has a deletion policy. The outbox write lives in the delivery report because that is the only place a broker's refusal arrives. On the consumer side, counting before committing makes delivery at-least-once, so a crash replays a record instead of losing it; the honest cost is that a replay counts twice. Production pipelines close that with an event id and a dedupe set in the same transaction, and run a relay that drains the outbox through the same idempotent producer.`,
};
