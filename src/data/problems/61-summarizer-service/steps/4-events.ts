import type {Step} from '@/lib/types';

export const summarizerEventsStep: Step = {
  id: 'events',
  title: 'Summary events keyed by source with no content',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'store', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`publish_summary(summary, tenant)\` builds a payload of
\`summary_id\`, \`source_id\` and \`summary_text\` and produces it to \`summary.done\` keyed by the
tenant; \`consume_summary\` commits the offset and then stores the record. It compiles, it serves the
demo, and it hides five flaws.

**Failure mode the checks target.** Keyed by tenant, one source's updates can be consumed out of
order. The payload carries the summary text, so a retained topic becomes a copy of every document the
platform has summarized, and none of the numbers a consumer could check. The producer is
fire-and-forget with no acks, no idempotence and no outbox, so a broker blip loses the completion.
And the consumer commits before it stores, so a crash between the two loses the summary.

Requirements:

- Key the record by the source hash (\`event_key\`), so a summary, a re-summary and a stale marking
  for one source are read in the order they happened.
- \`event_payload\` carries numbers only: \`source_bytes\`, \`summary_chars\`, \`compression_ratio\`
  (\`summary_chars / source_bytes\`), \`model_version\`, \`band\` and \`chunks_done\`. No
  \`summary_text\`, no \`source_text\`.
- The producer runs with \`acks=all\` and idempotence enabled; a produce the broker rejects writes an
  outbox row (\`outbox.put\`).
- The consumer calls \`store.put\` before \`commit\`.`,
  sequence: {
    participants: ['Summarizer', 'summary.done', 'Summary store', 'Relay'],
    messages: [
      {from: 'Summarizer', to: 'summary.done', label: 'produce · key = source hash · numbers only', kind: 'async'},
      {from: 'Summarizer', to: 'Summary store', label: 'outbox row when the produce is rejected', kind: 'sync'},
      {from: 'Summarizer', to: 'summary.done', label: 'acks=all · idempotent producer', kind: 'sync'},
      {from: 'summary.done', to: 'Relay', label: 'consume · group citations', kind: 'async'},
      {from: 'Relay', to: 'Summary store', label: 'store.put(record)', kind: 'sync'},
      {from: 'Relay', to: 'summary.done', label: 'commit the offset after the write', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-source-hash',
      title: 'Keys every event by the source hash',
      detail:
        'The record published to `summary.done` is keyed by the source hash, so one source’s events share a partition and stay ordered. The starter keys by tenant, which orders unrelated sources against each other.',
      match: {
        python: {all: [/summary\.done/, /event_key\(/, /source_hash/]},
        typescript: {all: [/summary\.done/, /eventKey\(/, /source_hash/]},
        go: {all: [/summary\.done/, /eventKey\(/, /SourceHash/]},
        scala: {all: [/summary\.done/, /eventKey\(/, /sourceHash/]},
        cpp: {all: [/summary\.done/, /event_key\(/, /source_hash/]},
      },
    },
    {
      id: 'payload-numbers',
      title: 'The payload carries lengths, model version and compression ratio',
      detail:
        '`event_payload` assembles `source_bytes`, `summary_chars`, `compression_ratio`, `model_version`, `band` and `chunks_done` — the numbers that let a consumer check how much a summary compressed its source and which model version produced it. The starter stores counters as text fields.',
      match: {
        python: {all: [/event_payload\(/, /compression_ratio/, /model_version/, /source_bytes/, /summary_chars/]},
        typescript: {all: [/eventPayload\(/, /compression_ratio/, /model_version/, /source_bytes/, /summary_chars/]},
        go: {all: [/eventPayload\(/, /compression_ratio/, /model_version/, /source_bytes/, /summary_chars/]},
        scala: {all: [/eventPayload\(/, /compressionRatio/, /modelVersion/, /sourceBytes/, /summaryChars/]},
        cpp: {all: [/event_payload\(/, /compression_ratio/, /model_version/, /source_bytes/, /summary_chars/]},
      },
    },
    {
      id: 'no-text-in-event',
      title: 'Neither the summary nor the source text reaches the topic',
      detail:
        'The payload builder takes text fields out of the record: no `summary_text`, no `source_text`. The starter publishes the summary "for quality review", which copies tenant content into a retained, replicated topic.',
      match: {
        python: {all: [/event_payload\(/], none: [/summary_text/, /source_text/]},
        typescript: {all: [/eventPayload\(/], none: [/summary_text/, /source_text/]},
        go: {all: [/eventPayload\(/], none: [/summary_text/, /source_text/]},
        scala: {all: [/eventPayload\(/], none: [/summary_text/, /source_text/]},
        cpp: {all: [/event_payload\(/], none: [/summary_text/, /source_text/]},
      },
    },
    {
      id: 'persist-before-commit',
      title: 'The summary record is persisted before the offset commits',
      detail:
        'The consumer stores the record with `store.put` and only then commits the offset, so a crash between the two re-delivers instead of losing the summary. The starter commits first and writes afterwards.',
      match: {
        python: {order: [/store\.put\(/, /\.commit\(/]},
        typescript: {order: [/store\.put\(/, /commitOffsets\(/]},
        go: {order: [/store\.Put\(/, /CommitMessages\(/]},
        scala: {order: [/store\.put\(/, /commitSync\(/]},
        cpp: {order: [/store\.put\(/, /commitSync\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'The producer is durable and idempotent, with an outbox on failure',
      detail:
        '`acks=all` and idempotence are configured, and a rejected produce lands in the outbox (`outbox.put`) instead of being dropped. The starter produces fire-and-forget and has no outbox at all.',
      match: {
        python: {all: [/acks/, /enable\.idempotence/, /outbox\.put\(/]},
        typescript: {all: [/acks/, /idempotent/, /outbox\.put\(/]},
        go: {all: [/RequireAll/, /Idempotent/, /outbox\.Put\(/]},
        scala: {all: [/acks/, /enable\.idempotence/, /outbox\.put\(/]},
        cpp: {all: [/acks/, /enable\.idempotence/, /outbox\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("summarizer")

SUMMARY_DONE = "summary.done"
producer = Producer({"bootstrap.servers": "kafka:9092"})


class SummaryStore:
    def put(self, record: dict) -> None:
        """Persist the summary record."""
        raise NotImplementedError


store = SummaryStore()


def publish_summary(summary: dict, tenant: str) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = {
        "summary_id": summary["summary_id"],
        "source_id": summary["source_ref"],
        "summary_text": summary["summary"],
    }
    producer.produce(SUMMARY_DONE, key=tenant, value=json.dumps(payload))


def consume_summary(value: bytes, offset_committer: object) -> None:
    """Commit the offset, then store the summary."""
    offset_committer.commit()
    store.put(json.loads(value))
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("summarizer")

SUMMARY_DONE = "summary.done"

# acks=all plus idempotence: a retried produce must not duplicate an event.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


class SummaryStore:
    def put(self, record: dict) -> None:
        """Persist the summary record."""
        raise NotImplementedError


class Outbox:
    def put(self, record: dict) -> None:
        """Queue a record for the relay when the broker will not take it."""
        raise NotImplementedError


store = SummaryStore()
outbox = Outbox()


def event_key(summary: dict) -> str:
    """Every event for one source shares a partition: order is per key, so the key is the hash."""
    return summary["source_hash"]


def event_payload(summary: dict) -> dict:
    """Numbers about the summary — never the summary or the source text."""
    source_bytes = max(summary["source_bytes"], 1)
    summary_chars = len(summary["summary"])
    return {
        "summary_id": summary["summary_id"],
        "source_ref": summary["source_ref"],
        "band": summary["band"],
        "chunks_done": summary["chunks_done"],
        "source_bytes": source_bytes,
        "summary_chars": summary_chars,
        "compression_ratio": round(summary_chars / source_bytes, 4),
        "model_version": summary["model_version"],
    }


def publish_summary(summary: dict) -> None:
    """One event per summary, keyed by source hash, with an outbox row when the broker refuses."""
    value = json.dumps(event_payload(summary)).encode("utf-8")
    try:
        producer.produce(SUMMARY_DONE, key=event_key(summary), value=value)
        producer.flush(5)
    except KafkaException as err:
        logger.warning("summary.done produce failed: %s", err)
        outbox.put({"topic": SUMMARY_DONE, "key": event_key(summary), "value": value.decode("utf-8")})


def consume_summary(value: bytes, offset_committer: object) -> None:
    """Persist the summary record first: the offset may only commit after that write."""
    store.put(json.loads(value))
    offset_committer.commit()
`,
    },
    typescript: {
      starter: `/** Publish summary.done: the starter publishes the summary text. */
import {Kafka} from 'kafkajs';

const SUMMARY_DONE = 'summary.done';
const kafka = new Kafka({clientId: 'summarizer', brokers: ['kafka:9092']});
const producer = kafka.producer();

interface SummaryRecord {
  summary_id: string;
  source_ref: string;
  source_hash: string;
  band: string;
  chunks_done: number;
  source_bytes: number;
  summary: string;
  model_version: string;
}

export async function publishSummary(summary: SummaryRecord, tenant: string): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await producer.send({
    topic: SUMMARY_DONE,
    messages: [
      {key: tenant, value: JSON.stringify({summary_id: summary.summary_id, summary_text: summary.summary})},
    ],
  });
}
`,
      solution: `/** Publish summary.done: source-hash keys, numbers-only payloads, an outbox for failures. */
import {Kafka, type Consumer, type KafkaMessage} from 'kafkajs';

const SUMMARY_DONE = 'summary.done';
const kafka = new Kafka({clientId: 'summarizer', brokers: ['kafka:9092']});

// acks=-1 (all) plus idempotence: a retried produce must not duplicate an event.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1, acks: -1});

interface SummaryRecord {
  summary_id: string;
  source_ref: string;
  source_hash: string;
  band: string;
  chunks_done: number;
  source_bytes: number;
  summary: string;
  model_version: string;
}

const store = {
  async put(_record: SummaryRecord): Promise<void> {
    throw new Error('summary store not wired');
  },
};

const outbox = {
  async put(_record: {topic: string; key: string; value: string}): Promise<void> {
    throw new Error('outbox not wired');
  },
};

/** Every event for one source shares a partition: the key is the source hash. */
function eventKey(summary: SummaryRecord): string {
  return summary.source_hash;
}

/** Numbers about the summary — never the summary or the source text. */
function eventPayload(summary: SummaryRecord): Record<string, unknown> {
  const summaryChars = summary.summary.length;
  const sourceBytes = Math.max(summary.source_bytes, 1);
  return {
    summary_id: summary.summary_id,
    source_ref: summary.source_ref,
    band: summary.band,
    chunks_done: summary.chunks_done,
    source_bytes: sourceBytes,
    summary_chars: summaryChars,
    compression_ratio: Number((summaryChars / sourceBytes).toFixed(4)),
    model_version: summary.model_version,
  };
}

export async function publishSummary(summary: SummaryRecord): Promise<void> {
  const value = JSON.stringify(eventPayload(summary));
  try {
    await producer.send({
      topic: SUMMARY_DONE,
      acks: -1,
      messages: [{key: eventKey(summary), value}],
    });
  } catch {
    await outbox.put({topic: SUMMARY_DONE, key: eventKey(summary), value});
  }
}

export async function consumeSummary(
  consumer: Consumer,
  payload: {topic: string; partition: number; message: KafkaMessage},
): Promise<void> {
  const record = JSON.parse(payload.message.value?.toString() ?? '{}') as SummaryRecord;
  // Persist the record first: the offset may only commit after that write.
  await store.put(record);
  await consumer.commitOffsets([
    {topic: payload.topic, partition: payload.partition, offset: String(Number(payload.message.offset) + 1)},
  ]);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/segmentio/kafka-go"
)

const summaryDone = "summary.done"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: summaryDone}

type SummaryRecord struct {
	SummaryID   string \`json:"summary_id"\`
	SourceRef   string \`json:"source_ref"\`
	SourceHash  string \`json:"source_hash"\`
	Band        string \`json:"band"\`
	ChunksDone  int    \`json:"chunks_done"\`
	SourceBytes int    \`json:"source_bytes"\`
	Summary     string \`json:"summary"\`
	ModelVersion string \`json:"model_version"\`
}

// publishSummary publishes one summary.done event.
func publishSummary(ctx context.Context, tenant string, summary SummaryRecord) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	value, err := json.Marshal(map[string]any{"summary_id": summary.SummaryID, "summary_text": summary.Summary})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: value})
}

// consumeSummary commits the offset, then stores the record.
func consumeSummary(ctx context.Context, reader *kafka.Reader, msg kafka.Message) error {
	if err := reader.CommitMessages(ctx, msg); err != nil {
		return err
	}
	var record SummaryRecord
	if err := json.Unmarshal(msg.Value, &record); err != nil {
		return err
	}
	fmt.Println(record.SummaryID)
	return nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"
)

const summaryDone = "summary.done"

// Writer with acks=all and idempotence: a retried produce must not duplicate an event.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        summaryDone,
	RequiredAcks: kafka.RequireAll,
	Idempotent:   true,
	BatchTimeout: 5 * time.Millisecond,
}

type SummaryRecord struct {
	SummaryID    string \`json:"summary_id"\`
	SourceRef    string \`json:"source_ref"\`
	SourceHash   string \`json:"source_hash"\`
	Band         string \`json:"band"\`
	ChunksDone   int    \`json:"chunks_done"\`
	SourceBytes  int    \`json:"source_bytes"\`
	Summary      string \`json:"summary"\`
	ModelVersion string \`json:"model_version"\`
}

type SummaryStore interface {
	Put(ctx context.Context, record SummaryRecord) error
}

type Outbox interface {
	Put(ctx context.Context, topic, key string, value []byte) error
}

// eventKey: every event for one source shares a partition, so one source's history stays ordered.
func eventKey(summary SummaryRecord) []byte {
	return []byte(summary.SourceHash)
}

// eventPayload carries numbers about the summary, never the summary or the source text.
func eventPayload(summary SummaryRecord) map[string]any {
	summaryChars := len(summary.Summary)
	sourceBytes := max(summary.SourceBytes, 1)
	return map[string]any{
		"summary_id":        summary.SummaryID,
		"source_ref":        summary.SourceRef,
		"band":              summary.Band,
		"chunks_done":       summary.ChunksDone,
		"source_bytes":      sourceBytes,
		"summary_chars":     summaryChars,
		"compression_ratio": float64(summaryChars) / float64(sourceBytes),
		"model_version":     summary.ModelVersion,
	}
}

func publishSummary(ctx context.Context, outbox Outbox, summary SummaryRecord) error {
	value, err := json.Marshal(eventPayload(summary))
	if err != nil {
		return err
	}
	message := kafka.Message{Key: eventKey(summary), Value: value}
	if err := writer.WriteMessages(ctx, message); err != nil {
		return outbox.Put(ctx, summaryDone, string(eventKey(summary)), value)
	}
	return nil
}

// consumeSummary persists the record first: the offset commits only after that write.
func consumeSummary(ctx context.Context, reader *kafka.Reader, store SummaryStore, msg kafka.Message) error {
	var record SummaryRecord
	if err := json.Unmarshal(msg.Value, &record); err != nil {
		return err
	}
	if err := store.Put(ctx, record); err != nil {
		return err
	}
	return reader.CommitMessages(ctx, msg)
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

import java.util.Properties

case class SummaryRecord(summaryId: String, sourceRef: String, sourceHash: String, summary: String)

object SummaryEvents extends DefaultJsonProtocol {
  val SummaryDone = "summary.done"

  val producer = new KafkaProducer[String, String](new Properties())

  /** Publish one summary.done event. */
  def publishSummary(summary: SummaryRecord, tenant: String): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = JsObject("summary_id" -> JsString(summary.summaryId), "summary_text" -> JsString(summary.summary))
    producer.send(new ProducerRecord[String, String](SummaryDone, tenant, payload.compactPrint))
  }
}
`,
      solution: `import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

import java.util.Properties
import scala.math.BigDecimal.RoundingMode

case class SummaryRecord(
    summaryId: String,
    sourceRef: String,
    sourceHash: String,
    band: String,
    chunksDone: Int,
    sourceBytes: Int,
    summary: String,
    modelVersion: String
)

trait SummaryStore {
  def put(record: SummaryRecord): Unit
}

trait Outbox {
  def put(topic: String, key: String, value: String): Unit
}

object SummaryEvents extends DefaultJsonProtocol {
  val SummaryDone = "summary.done"

  // acks=all plus idempotence: a retried produce must not duplicate an event.
  private val props = {
    val p = new Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p.put("acks", "all")
    p.put("enable.idempotence", "true")
    p
  }
  val producer = new KafkaProducer[String, String](props)

  /** Every event for one source shares a partition: the key is the source hash. */
  def eventKey(summary: SummaryRecord): String = summary.sourceHash

  /** Numbers about the summary — never the summary or the source text. */
  def eventPayload(summary: SummaryRecord): JsObject = {
    val sourceBytes = math.max(summary.sourceBytes, 1)
    val summaryChars = summary.summary.length
    val compressionRatio = BigDecimal(summaryChars.toDouble / sourceBytes).setScale(4, RoundingMode.HALF_UP)
    JsObject(
      "summary_id" -> JsString(summary.summaryId),
      "source_ref" -> JsString(summary.sourceRef),
      "band" -> JsString(summary.band),
      "chunks_done" -> JsNumber(summary.chunksDone),
      "source_bytes" -> JsNumber(sourceBytes),
      "summary_chars" -> JsNumber(summaryChars),
      "compression_ratio" -> JsNumber(compressionRatio),
      "model_version" -> JsString(summary.modelVersion)
    )
  }

  def publishSummary(outbox: Outbox, summary: SummaryRecord): Unit = {
    val value = eventPayload(summary).compactPrint
    val record = new ProducerRecord[String, String](SummaryDone, eventKey(summary), value)
    try {
      producer.send(record).get()
    } catch {
      case _: Exception =>
        outbox.put(SummaryDone, eventKey(summary), value)
    }
  }

  /** Persist the record first: the offset commits only after that write. */
  def consumeSummary(consumer: KafkaConsumer[String, String], record: ConsumerRecord[String, String], store: SummaryStore): Unit = {
    val summary = record.value().parseJson.convertTo[SummaryRecord]
    store.put(summary)
    consumer.commitSync()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

const char* kSummaryDone = "summary.done";

// publish_summary publishes one summary.done event.
void publish_summary(RdKafka::Producer& producer, const std::string& tenant, const std::string& summary_id,
                     const std::string& summary_text) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto payload = json{{"summary_id", summary_id}, {"summary_text", summary_text}}.dump();
  producer.produce(kSummaryDone, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                   const_cast<char*>(payload.data()), payload.size(), tenant.data(), tenant.size(), 0, nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <string>

using json = nlohmann::json;

const char* kSummaryDone = "summary.done";

struct SummaryRecord {
  std::string summary_id;
  std::string source_ref;
  std::string source_hash;
  std::string band;
  int chunks_done = 0;
  long source_bytes = 0;
  std::string summary;
  std::string model_version;
};

struct SummaryStore {
  virtual void put(const json& record) = 0;
};

struct Outbox {
  virtual void put(const std::string& topic, const std::string& key, const std::string& value) = 0;
};

/// acks=all plus idempotence: a retried produce must not duplicate an event.
static RdKafka::Producer* make_producer() {
  std::string error;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", error);
  conf->set("acks", "all", error);
  conf->set("enable.idempotence", "true", error);
  return RdKafka::Producer::create(conf.get(), error);
}

/// Every event for one source shares a partition: the key is the source hash.
static std::string event_key(const SummaryRecord& summary) { return summary.source_hash; }

/// Numbers about the summary — never the summary or the source text.
static json event_payload(const SummaryRecord& summary) {
  const long source_bytes = std::max<long>(summary.source_bytes, 1);
  const long summary_chars = static_cast<long>(summary.summary.size());
  return json{{"summary_id", summary.summary_id},
              {"source_ref", summary.source_ref},
              {"band", summary.band},
              {"chunks_done", summary.chunks_done},
              {"source_bytes", source_bytes},
              {"summary_chars", summary_chars},
              {"compression_ratio", static_cast<double>(summary_chars) / static_cast<double>(source_bytes)},
              {"model_version", summary.model_version}};
}

void publish_summary(RdKafka::Producer& producer, Outbox& outbox, const SummaryRecord& summary) {
  const auto value = event_payload(summary).dump();
  const auto key = event_key(summary);
  const auto error = producer.produce(kSummaryDone, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                      const_cast<char*>(value.data()), value.size(), key.data(), key.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) outbox.put(kSummaryDone, key, value);
}

/// Persist the record first: the offset commits only after that write.
void consume_summary(RdKafka::KafkaConsumer& consumer, RdKafka::Message& message, SummaryStore& store) {
  const auto record = json::parse(std::string(static_cast<const char*>(message.payload()), message.len()));
  store.put(record);
  consumer.commitSync(&message);
}
`,
    },
  },
  hints: [
    'A broker restart and a handful of summaries are missing from the citation index. A data-retention audit finds full summary paragraphs sitting in a topic with 30-day retention.',
    '`producer.produce` runs with default config and no delivery callback, so a rejected write vanishes. The key is `tenant`, so partition order is per tenant. `consume_summary` commits before `store.put`.',
    'Configure `acks=all` and `enable.idempotence`; on `KafkaException` call `outbox.put`. Key with `event_key(source_hash)`, build `event_payload` from counts and `model_version`, and move `commit()` after `store.put`.',
  ],
  debrief: `Each part of the fix answers a different question. The key is a partitioning decision: keyed by
source hash, one source's summaries stay in order, which is what a citation index needs. The payload
is a retention decision: a topic with the summary text in it is a second copy of tenant content with
its own lifecycle, so the event carries numbers and identifiers and the reader fetches content from
the system that owns it. The producer settings and the outbox are a durability decision, because a
dropped completion is a summary the index will not learn about. The consumer persists before it
commits because the offset is a promise that the work is done. Production pipelines add a schema
registry so text fields cannot come back.`,
};
