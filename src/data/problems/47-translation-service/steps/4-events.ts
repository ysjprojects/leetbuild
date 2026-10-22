import type {Step} from '@/lib/types';

export const localeEventsStep: Step = {
  id: 'events',
  title: 'Translation events keyed by locale pair',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated analytics path: it publishes one event
per translated segment and updates quality counters from the consumer. It compiles, the dashboard
fills, and it hides three production flaws. Review it, fix it, and prove the fix with the checks
below.

Implement the \`translation.done\` quality path.

- Publish one \`translation.done\` event per translated segment, **keyed by the locale pair**
  (\`source->target\`). Per-locale quality requires per-locale ordering, and the key is the only thing
  that gives it: a tenant key scatters one locale pair across partitions.
- The payload carries \`latency_ms\`, \`glossary_version\`, \`quality_score\` and **hashes** of the source
  and target text (\`source_sha256\`, \`target_sha256\`). It never carries the text itself: the topic is
  retained and replicated, so a source or target string in a payload is customer content in a log.
- The producer is **idempotent with \`acks=all\`**, so a retried produce cannot duplicate a record.
- A produce the broker rejects writes an **outbox** row instead of dropping the event.
- The consumer increments its Redis quality counters (\`HINCRBY quality:{target} …\`) **before** it
  commits the offset, so a crash between the two replays the counter update rather than losing it.

**Failure mode the checks target.** Keying by tenant makes per-locale quality unanswerable, publishing
the source text for "spot checks" puts customer content into a retained topic, and committing before
the counter update means a crash silently drops the metric. The last one is the quiet defect: the
dashboard looks fine until the day a consumer restarts.`,
  sequence: {
    participants: ['Translation API', 'translation.done', 'Quality consumer', 'Redis'],
    messages: [
      {from: 'Translation API', to: 'translation.done', label: 'produce · key = en->fr · acks=all', kind: 'sync'},
      {from: 'translation.done', to: 'Translation API', label: 'offset acked', kind: 'reply'},
      {from: 'translation.done', to: 'Quality consumer', label: 'poll · partition by locale pair', kind: 'async'},
      {from: 'Quality consumer', to: 'Redis', label: 'HINCRBY quality:fr segments 1', kind: 'sync'},
      {from: 'Redis', to: 'Quality consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Quality consumer', to: 'translation.done', label: 'commit offset', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'locale-key',
      title: 'Keys translation.done by the locale pair',
      detail:
        'Every record goes to `translation.done` with the partition key `source->target`. The draft keys by tenant, so one locale pair is spread across partitions and per-locale ordering is lost.',
      match: {
        python: {all: [/translation\.done/, /locale_pair_key/]},
        typescript: {all: [/translation\.done/, /localePairKey/]},
        go: {all: [/translation\.done/, /localePairKey/]},
        scala: {all: [/translation\.done/, /localePairKey/]},
        cpp: {all: [/translation\.done/, /localePairKey/]},
      },
    },
    {
      id: 'no-text',
      title: 'Publishes text hashes, never the source or target text',
      detail:
        'The payload carries `source_sha256` and `target_sha256` and no `source_text`/`target_text` field. The draft publishes the source text verbatim for spot checks.',
      match: {
        python: {all: [/source_sha256/, /target_sha256/], none: [/source_text/, /target_text/]},
        typescript: {all: [/sourceSha256/, /targetSha256/], none: [/source_text/, /target_text/]},
        go: {all: [/sourceSha256/, /targetSha256/], none: [/source_text/, /target_text/]},
        scala: {all: [/source_sha256/, /target_sha256/], none: [/source_text/, /target_text/]},
        cpp: {all: [/source_sha256/, /target_sha256/], none: [/source_text/, /target_text/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A failed produce is caught and the event is inserted into the outbox for a later replay. The draft lets the exception escape and loses the segment.',
      match: {
        python: {all: [/insert_outbox/, /KafkaException/]},
        typescript: {all: [/insertOutbox/, /catch\s*\(/]},
        go: {all: [/insertOutbox/, /if err != nil/]},
        scala: {all: [/insertOutbox/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates the counters before committing the offset',
      detail:
        'The `HINCRBY` that records the segment happens **before** the offset commit, so a crash replays the update instead of dropping it. The draft commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /\.commit\(/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages/]},
        scala: {order: [/\.hincrBy\(/, /commitSync/]},
        cpp: {order: [/hincrby\(/, /commitOffset/]},
      },
    },
    {
      id: 'acks',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'Idempotence plus required acks `all` is producer configuration, not application logic: it is what makes a produce retry free of duplicates. The draft sends with the default acks and no idempotence.',
      match: {
        python: {all: [/ACKS_ALL/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*ACKS_ALL/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks", "all"/]},
        cpp: {all: [/"acks", "all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

logger = logging.getLogger("quality")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092"})

TOPIC = "translation.done"


def publish(tenant: str, segment: dict, text: str) -> None:
    # TODO: this draft keys by tenant so per-locale quality is unavailable, publishes the source
    # text verbatim for spot checks, and updates its counters after committing the offset. Review
    # all three.
    payload = {**segment, "source_text": text}
    producer.produce(TOPIC, key=tenant, value=json.dumps(payload))
    producer.poll(0)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "quality", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        payload = json.loads(msg.value())
        consumer.commit(msg)
        r.hincrby("quality:" + payload["target"], "segments", 1)
`,
      solution: `import hashlib
import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer

logger = logging.getLogger("quality")

ACKS_ALL = "all"

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer(
    {"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": ACKS_ALL}
)

TOPIC = "translation.done"


def locale_pair_key(source: str, target: str) -> str:
    """The partition key: every event for one locale pair stays in order."""
    return source + "->" + target


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def insert_outbox(topic: str, payload: dict) -> None:
    """Persist the event for a later replay when the broker rejects the produce."""
    raise NotImplementedError


def publish(source: str, target: str, text: str, translation: str, segment: dict) -> None:
    payload = {
        "source": source,
        "target": target,
        "latency_ms": segment["latency_ms"],
        "glossary_version": segment["glossary_version"],
        "quality_score": segment["quality_score"],
        "source_sha256": text_hash(text),
        "target_sha256": text_hash(translation),
    }
    try:
        producer.produce(TOPIC, key=locale_pair_key(source, target), value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        logger.warning("produce rejected; writing outbox row")
        insert_outbox(TOPIC, payload)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "quality", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        payload = json.loads(msg.value())
        r.hincrby("quality:" + payload["target"], "segments", 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** The model-generated quality path: tenant-keyed, text in the payload, commit too early. */
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'translation-service', brokers: ['kafka:9092']});
const producer = kafka.producer();
const r = new Redis('redis://redis:6379');

const TOPIC = 'translation.done';

interface Segment {
  target: string;
  latencyMs: number;
  glossaryVersion: string;
  qualityScore: number;
}

export async function publish(tenant: string, segment: Segment, text: string): Promise<void> {
  // TODO: this draft keys by tenant so per-locale quality is unavailable, publishes the source text
  // verbatim for spot checks, and updates its counters after committing the offset. Review all three.
  const value = JSON.stringify({...segment, tenant, source_text: text});
  await producer.send({topic: TOPIC, messages: [{key: tenant, value}]});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'quality'});
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({message}) => {
      const payload = JSON.parse(message.value?.toString() ?? '{}') as Segment;
      await consumer.commitOffsets([{topic: TOPIC, partition: 0, offset: String(Number(message.offset) + 1)}]);
      await r.hincrby('quality:' + payload.target, 'segments', 1);
    },
  });
}
`,
      solution: `/** The translation.done quality path: locale-keyed, hash-only payloads, counters before commit. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

import {store} from './store';

const ACKS_ALL = -1;

const kafka = new Kafka({clientId: 'translation-service', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
const r = new Redis('redis://redis:6379');

const TOPIC = 'translation.done';

interface Segment {
  target: string;
  latencyMs: number;
  glossaryVersion: string;
  qualityScore: number;
}

export function localePairKey(source: string, target: string): string {
  return source + '->' + target;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function insertOutbox(topic: string, payload: unknown): Promise<void> {
  await store.insertOutbox(topic, payload);
}

export async function publish(source: string, target: string, segment: Segment, text: string, translation: string) {
  const sourceSha256 = sha256(text);
  const targetSha256 = sha256(translation);
  const payload = {
    source,
    target,
    latency_ms: segment.latencyMs,
    glossary_version: segment.glossaryVersion,
    quality_score: segment.qualityScore,
    source_sha256: sourceSha256,
    target_sha256: targetSha256,
  };
  try {
    await producer.send({
      acks: ACKS_ALL,
      topic: TOPIC,
      messages: [{key: localePairKey(source, target), value: JSON.stringify(payload)}],
    });
  } catch (error) {
    await insertOutbox(TOPIC, payload);
    throw error;
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'quality'});
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({message, partition}) => {
      const payload = JSON.parse(message.value?.toString() ?? '{}') as {target: string};
      await r.hincrby('quality:' + payload.target, 'segments', 1);
      await consumer.commitOffsets([
        {topic: TOPIC, partition, offset: String(Number(message.offset) + 1)},
      ]);
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

type SegmentEvent struct {
	Target          string \`json:"target"\`
	LatencyMs       int    \`json:"latency_ms"\`
	GlossaryVersion string \`json:"glossary_version"\`
	QualityScore    float64 \`json:"quality_score"\`
	SourceText      string \`json:"source_text"\`
}

var (
	eventsWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "translation.done"}
	rdb          = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func publish(ctx context.Context, tenant string, event SegmentEvent, text string) error {
	// TODO: this draft keys by tenant so per-locale quality is unavailable, publishes the source text
	// verbatim for spot checks, and updates its counters after committing the offset. Review all three.
	event.SourceText = text
	payload, _ := json.Marshal(event)
	return eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: payload})
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "quality",
		Topic:   "translation.done",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			log.Printf("poll failed: %v", err)
			return
		}
		var event SegmentEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Printf("commit failed: %v", err)
		}
		rdb.HIncrBy(ctx, "quality:"+event.Target, "segments", 1)
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

type SegmentEvent struct {
	Source          string  \`json:"source"\`
	Target          string  \`json:"target"\`
	LatencyMs       int     \`json:"latency_ms"\`
	GlossaryVersion string  \`json:"glossary_version"\`
	QualityScore    float64 \`json:"quality_score"\`
	SourceSha256    string  \`json:"source_sha256"\`
	TargetSha256    string  \`json:"target_sha256"\`
}

var (
	eventsWriter = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        "translation.done",
		RequiredAcks: kafka.RequireAll,
		Balancer:     &kafka.Hash{},
	}
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func localePairKey(source, target string) string {
	return source + "->" + target
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func insertOutbox(ctx context.Context, event SegmentEvent) error {
	return nil
}

func publish(ctx context.Context, event SegmentEvent, text, translation string) error {
	sourceSha256 := sha256Hex(text)
	targetSha256 := sha256Hex(translation)
	event.SourceSha256 = sourceSha256
	event.TargetSha256 = targetSha256
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	err = eventsWriter.WriteMessages(ctx, kafka.Message{
		Key:   []byte(localePairKey(event.Source, event.Target)),
		Value: payload,
	})
	if err != nil {
		log.Printf("produce rejected; writing outbox row: %v", err)
		return insertOutbox(ctx, event)
	}
	return nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		GroupID: "quality",
		Topic:   "translation.done",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			log.Printf("poll failed: %v", err)
			return
		}
		var event SegmentEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		rdb.HIncrBy(ctx, "quality:"+event.Target, "segments", 1)
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Printf("commit failed: %v", err)
		}
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

object QualityEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def publish(tenant: String, segment: Map[String, String], text: String): Unit = {
    // TODO: this draft keys by tenant so per-locale quality is unavailable, publishes the source
    // text verbatim for spot checks, and updates its counters after committing the offset. Review
    // all three.
    val payload = (segment + ("source_text" -> text)).toJson.compactPrint
    producer.send(new ProducerRecord("translation.done", tenant, payload))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "quality")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("translation.done"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        consumer.commitSync()
        jedis.hincrBy("quality:" + event("target").convertTo[String], "segments", 1L)
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object QualityEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def localePairKey(source: String, target: String): String = source + "->" + target

  def sha256Hex(text: String): String = {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    digest.digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString
  }

  def insertOutbox(payload: String): Unit = ()

  def publish(source: String, target: String, segment: Map[String, String], text: String, translation: String): Unit = {
    val payload = (segment ++ Map(
      "source" -> source,
      "target" -> target,
      "source_sha256" -> sha256Hex(text),
      "target_sha256" -> sha256Hex(translation),
    )).toJson.compactPrint
    try {
      producer.send(new ProducerRecord("translation.done", localePairKey(source, target), payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        insertOutbox(payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "quality")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("translation.done"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy("quality:" + event("target").convertTo[String], "segments", 1L)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kDoneTopic = "translation.done";

std::unique_ptr<RdKafka::Producer> producer;

void publish(const std::string& tenant, const json& segment, const std::string& text) {
  // TODO: this draft keys by tenant so per-locale quality is unavailable, publishes the source text
  // verbatim for spot checks, and updates its counters after committing the offset. Review all three.
  json event = segment;
  event["source_text"] = text;
  const auto payload = event.dump();
  std::cerr << "publish tenant=" << tenant << " text=" << text << "\\n";
  producer->produce(kDoneTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), tenant.data(), tenant.size(), 0, nullptr);
  producer->flush(2000);
}

void consume(const std::string& topic) {
  // TODO: counters after commit — see the review note above.
  consumeLoop(topic);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kDoneTopic = "translation.done";

struct OutboxStore {
  void insertOutbox(const std::string& topic, const json& event);
};

OutboxStore store;

std::string sha256Hex(const std::string& text);

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

std::string localePairKey(const std::string& source, const std::string& target) {
  return source + "->" + target;
}

void publish(const std::string& source, const std::string& target, const json& segment,
             const std::string& text, const std::string& translation) {
  const json event = {{"source", source},
                      {"target", target},
                      {"latency_ms", segment["latency_ms"]},
                      {"glossary_version", segment["glossary_version"]},
                      {"quality_score", segment["quality_score"]},
                      {"source_sha256", sha256Hex(text)},
                      {"target_sha256", sha256Hex(translation)}};
  const auto payload = event.dump();
  const auto key = localePairKey(source, target);
  const auto err = producer->produce(kDoneTopic, RdKafka::Topic::PARTITION_UA,
                                    RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                    payload.size(), key.data(), key.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(kDoneTopic, event);
  }
  producer->flush(2000);
}

void consume(const std::string& group) {
  const auto records = pollRecords(group);
  for (const auto& record : records) {
    const auto event = json::parse(record.payload);
    redis->hincrby("quality:" + event["target"].get<std::string>(), "segments", 1);
    commitOffset(record);
  }
}
`,
    },
  },
  hints: [
    'The partition key is the unit of ordering, so pick the unit your metric needs: quality is asked per locale pair, so the key is `source->target`. A tenant key makes one pair land on many partitions and the dashboard averages across them.',
    'Hash before you publish: `sha256(source)` and `sha256(target)` let reviewers correlate a segment without putting customer text into a retained, replicated topic. Keep the text in the request scope where it belongs.',
    'Order in the consumer is a durability decision: `HINCRBY` first, then commit. A crash between the two replays an idempotent counter increment; a crash after committing loses the metric with no trace. Configure `enable.idempotence` with `acks=all` so the produce side has the same property.',
  ],
  debrief: `The interviewer is checking whether you treat a metric pipeline as production code. Three defects are checked: the partition key (per-locale ordering requires a locale-pair key), the payload (hashes, not text, because the topic is retained and replicated), and the consumer order (counters before commit, so a replay is safe and a crash is not silent). The producer configuration is the fourth, quieter point: idempotence plus \`acks=all\` is what makes a retried produce duplicate-free. Real systems add an outbox drainer with dedupe keys, a schema registry that rejects a payload field carrying text, and per-locale dashboards for fallback rate and quality drift.`,
};
