import type {Step} from '@/lib/types';

export const summarizerEventsStep: Step = {
  id: 'events',
  title: 'summary.done: keyed by source hash, numbers only, after the record is saved',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'store', 'consumer'],
  task: `## Task

**Starting point.** The starter announces a finished summary: \`publish_done(record)\` produces
\`event_payload(record)\` (ids, \`band\`, \`kind\`, \`source_bytes\` and the summary text) to
\`summary.done\` keyed by the tenant, then writes the record with \`store.save_summary\`
(\`summarizer.store\`, provided) and returns \`True\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** A summary and its re-summary land on two partitions and are
applied out of order; the retained topic becomes a copy of every summary written; a consumer reads
an event for a summary the store does not have yet; a lost acknowledgement writes the event twice
and a failover loses it; a broker that does not answer loses it for good.

- Key by \`source_hash\`.
- \`event_payload\` carries \`summary_id\`, \`tenant\`, \`source_hash\`, \`band\`, \`kind\`, \`model_version\`,
  \`source_bytes\`, \`summary_chars\`, \`compression_ratio\` (\`summary_chars / source_bytes\`) and
  \`chunks_done\`, and no text.
- \`store.save_summary(record)\` comes before the produce.
- The producer is idempotent with \`acks=all\` (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` = 2 s; on a failure or no answer,
  \`store.outbox_put(TOPIC, source_hash, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Summarizer', 'Summary store', 'summary.done', 'Outbox'],
    messages: [
      {from: 'Summarizer', to: 'Summary store', label: 'save_summary(record)', kind: 'sync'},
      {
        from: 'Summarizer',
        to: 'summary.done',
        label: 'produce key = source_hash · numbers only · acks=all',
        kind: 'sync',
      },
      {from: 'summary.done', to: 'Summarizer', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Summarizer', to: 'Outbox', label: 'outbox_put(topic, source_hash, payload) → False', kind: 'async'},
      {from: 'Outbox', to: 'summary.done', label: 'relay produces it later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'source-key',
      title: 'Keys summary.done by the source hash',
      detail:
        'Three events for sources D, E, D carry those keys and the two D events share a partition, so a summary and its re-summary are read in order; the starter keys by tenant, which orders every source of a tenant against each other and none by source.',
      match: {
        python: {all: [/key\s*=\s*record\[["']source_hash["']\]/], none: [/key\s*=\s*record\[["']tenant["']\]/]},
        typescript: {all: [/key:\s*record\.source_hash/], none: [/key:\s*record\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(\s*record\.SourceHash\s*\)/], none: [/Key:\s*\[\]byte\(\s*record\.Tenant/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Topic\s*,\s*record\.sourceHash/],
          none: [/Topic\s*,\s*record\.tenant/],
        },
        cpp: {all: [/key = record\.at\("source_hash"\)/], none: [/key = record\.at\("tenant"\)/]},
      },
    },
    {
      id: 'numbers-only',
      title: 'Carries the numbers a consumer checks, never the text',
      detail:
        'The payload has `model_version`, `summary_chars`, `compression_ratio` and `chunks_done` and no summary text: the topic is retained and replicated, so text written there outlives every rule the summary store has.',
      match: {
        python: {all: [/compression_ratio/, /model_version/, /chunks_done/], none: [/["']summary["']\s*:\s*record/]},
        typescript: {all: [/compression_ratio/, /model_version/, /chunks_done/], none: [/summary:\s*record\.summary/]},
        go: {all: [/compression_ratio/, /model_version/, /chunks_done/], none: [/"summary":\s*record\.Summary/]},
        scala: {
          all: [/compression_ratio/, /model_version/, /chunks_done/],
          none: [/"summary"\s*->\s*JsString\(record\.summary\)/],
        },
        cpp: {
          all: [/compression_ratio/, /model_version/, /chunks_done/],
          none: [/\{"summary",\s*record\.at\("summary"\)\}/],
        },
      },
    },
    {
      id: 'save-before-produce',
      title: 'Saves the record before producing its event',
      detail:
        'When the summary record is written the topic is still empty: the event follows the save. The starter produces first.',
      match: {
        python: {order: [/store\.save_summary\(/, /producer\.produce\(/]},
        typescript: {order: [/saveSummary\(/, /producer\.send\(/]},
        go: {order: [/store\.SaveSummary\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.saveSummary\(/, /producer\.send\(/]},
        cpp: {order: [/store::saveSummary\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/store\.outbox_put\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outboxPut\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.OutboxPut\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.outboxPut\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/store::outboxPut\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from summarizer import store  # save_summary, outbox_put

TOPIC = "summary.done"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(record: dict) -> dict:
    """What a consumer gets for a finished summary; the text rides along for quality review."""
    return {
        "summary_id": record["summary_id"],
        "tenant": record["tenant"],
        "source_hash": record["source_hash"],
        "band": record["band"],
        "kind": record["kind"],
        "source_bytes": record["source_bytes"],
        "summary": record["summary"],
    }


def publish_done(record: dict) -> bool:
    """Record the finished summary and announce it on summary.done; True when the event is on its way."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    producer.produce(TOPIC, key=record["tenant"], value=json.dumps(event_payload(record)))
    producer.poll(0)
    store.save_summary(record)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from summarizer import store  # save_summary, outbox_put

TOPIC = "summary.done"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(record: dict) -> dict:
    """What a consumer checks a summary by: ids and numbers. The text stays in the summary store."""
    return {
        "summary_id": record["summary_id"],
        "tenant": record["tenant"],
        "source_hash": record["source_hash"],
        "band": record["band"],
        "kind": record["kind"],
        "model_version": record["model_version"],
        "source_bytes": record["source_bytes"],
        "summary_chars": record["summary_chars"],
        "compression_ratio": record["summary_chars"] / record["source_bytes"],
        "chunks_done": record["chunks_done"],
    }


def publish_done(record: dict) -> bool:
    """Record the finished summary, then announce it on summary.done; True once the broker acknowledged."""
    # The record exists before its event does: a consumer can always read what it was told about.
    store.save_summary(record)
    payload = event_payload(record)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=record["source_hash"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the event is late, not lost.
        store.outbox_put(TOPIC, record["source_hash"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Summary, outboxPut, saveSummary} from 'summarizer/store';

export const TOPIC = 'summary.done';

const kafka = new Kafka({clientId: 'summarizerd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What a consumer gets for a finished summary; the text rides along for quality review. */
export function eventPayload(record: Summary): Record<string, unknown> {
  return {
    summary_id: record.summary_id,
    tenant: record.tenant,
    source_hash: record.source_hash,
    band: record.band,
    kind: record.kind,
    source_bytes: record.source_bytes,
    summary: record.summary,
  };
}

/** Record the finished summary and announce it on summary.done; true when the event is on its way. */
export async function publishDone(record: Summary): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  void producer.send({topic: TOPIC, messages: [{key: record.tenant, value: JSON.stringify(eventPayload(record))}], acks: 1});
  await saveSummary(record);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Summary, outboxPut, saveSummary} from 'summarizer/store';

export const TOPIC = 'summary.done';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'summarizerd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What a consumer checks a summary by: ids and numbers. The text stays in the summary store. */
export function eventPayload(record: Summary): Record<string, unknown> {
  return {
    summary_id: record.summary_id,
    tenant: record.tenant,
    source_hash: record.source_hash,
    band: record.band,
    kind: record.kind,
    model_version: record.model_version,
    source_bytes: record.source_bytes,
    summary_chars: record.summary_chars,
    compression_ratio: record.summary_chars / record.source_bytes,
    chunks_done: record.chunks_done,
  };
}

/** Record the finished summary, then announce it on summary.done; true once the broker acknowledged. */
export async function publishDone(record: Summary): Promise<boolean> {
  // The record exists before its event does: a consumer can always read what it was told about.
  await saveSummary(record);
  const payload = eventPayload(record);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: record.source_hash, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the event is late, not lost.
    await outboxPut(TOPIC, record.source_hash, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"summarizer/store" // store.Summary, SaveSummary, OutboxPut
)

const topic = "summary.done"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is what a consumer gets for a finished summary; the text rides along for quality review.
func eventPayload(record store.Summary) map[string]any {
	return map[string]any{
		"summary_id":   record.SummaryID,
		"tenant":       record.Tenant,
		"source_hash":  record.SourceHash,
		"band":         record.Band,
		"kind":         record.Kind,
		"source_bytes": record.SourceBytes,
		"summary":      record.Summary,
	}
}

// publishDone records the finished summary and announces it on summary.done; true when the event is on its way.
func publishDone(ctx context.Context, record store.Summary) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(eventPayload(record))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(record.Tenant), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if err := store.SaveSummary(ctx, record); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"summarizer/store" // store.Summary, SaveSummary, OutboxPut
)

const (
	topic      = "summary.done"
	ackTimeout = 2 * time.Second
)

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

// eventPayload is what a consumer checks a summary by: ids and numbers. The text stays in the summary store.
func eventPayload(record store.Summary) map[string]any {
	return map[string]any{
		"summary_id":        record.SummaryID,
		"tenant":            record.Tenant,
		"source_hash":       record.SourceHash,
		"band":              record.Band,
		"kind":              record.Kind,
		"model_version":     record.ModelVersion,
		"source_bytes":      record.SourceBytes,
		"summary_chars":     record.SummaryChars,
		"compression_ratio": float64(record.SummaryChars) / float64(record.SourceBytes),
		"chunks_done":       record.ChunksDone,
	}
}

// publishDone records the finished summary, then announces it on summary.done; true once the broker acknowledged.
func publishDone(ctx context.Context, record store.Summary) (bool, error) {
	// The record exists before its event does: a consumer can always read what it was told about.
	if err := store.SaveSummary(ctx, record); err != nil {
		return false, err
	}
	payload := eventPayload(record)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(record.SourceHash), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so the event is late, not lost.
		if err := store.OutboxPut(ctx, topic, record.SourceHash, payload); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import summarizer.Store // Store.Summary, saveSummary, outboxPut

object Events {
  val Topic = "summary.done"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What a consumer gets for a finished summary; the text rides along for quality review. */
  def eventPayload(record: Store.Summary): JsObject = JsObject(
    "summary_id" -> JsString(record.summaryId),
    "tenant" -> JsString(record.tenant),
    "source_hash" -> JsString(record.sourceHash),
    "band" -> JsString(record.band),
    "kind" -> JsString(record.kind),
    "source_bytes" -> JsNumber(record.sourceBytes),
    "summary" -> JsString(record.summary))

  /** Record the finished summary and announce it on summary.done; true when the event is on its way. */
  def publishDone(record: Store.Summary): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    producer.send(new ProducerRecord[String, String](Topic, record.tenant, eventPayload(record).compactPrint))
    Store.saveSummary(record)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import summarizer.Store // Store.Summary, saveSummary, outboxPut

object Events {
  val Topic = "summary.done"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What a consumer checks a summary by: ids and numbers. The text stays in the summary store. */
  def eventPayload(record: Store.Summary): JsObject = JsObject(
    "summary_id" -> JsString(record.summaryId),
    "tenant" -> JsString(record.tenant),
    "source_hash" -> JsString(record.sourceHash),
    "band" -> JsString(record.band),
    "kind" -> JsString(record.kind),
    "model_version" -> JsString(record.modelVersion),
    "source_bytes" -> JsNumber(record.sourceBytes),
    "summary_chars" -> JsNumber(record.summaryChars),
    "compression_ratio" -> JsNumber(record.summaryChars.toDouble / record.sourceBytes),
    "chunks_done" -> JsNumber(record.chunksDone))

  /** Record the finished summary, then announce it on summary.done; true once the broker acknowledged. */
  def publishDone(record: Store.Summary): Boolean = {
    // The record exists before its event does: a consumer can always read what it was told about.
    Store.saveSummary(record)
    val payload = eventPayload(record)
    val acked = Try(producer.send(new ProducerRecord[String, String](Topic, record.sourceHash, payload.compactPrint)).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay produces the row later, so the event is late, not lost.
    if (acked.isFailure) Store.outboxPut(Topic, record.sourceHash, payload)
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "summarizer/store.h"  // summarizer::store::saveSummary, outboxPut

using json = nlohmann::json;
namespace store = summarizer::store;

const std::string kTopic = "summary.done";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What a consumer gets for a finished summary; the text rides along for quality review.
json eventPayload(const json& record) {
  json payload = json::object();
  for (const char* name : {"summary_id", "tenant", "source_hash", "band", "kind", "source_bytes"}) payload[name] = record.at(name);
  payload.update({{"summary", record.at("summary")}});
  return payload;
}

// Record the finished summary and announce it on summary.done; true when the event is on its way.
bool publishDone(const json& record) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string value = eventPayload(record).dump();
  const std::string key = record.at("tenant").get<std::string>();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    key.c_str(), key.size(), 0, nullptr);
  producer->poll(0);
  store::saveSummary(record);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "summarizer/store.h"  // summarizer::store::saveSummary, outboxPut

using json = nlohmann::json;
namespace store = summarizer::store;

const std::string kTopic = "summary.done";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishDone produces one record and waits for it.
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

// What a consumer checks a summary by: ids and numbers. The text stays in the summary store.
json eventPayload(const json& record) {
  json payload = json::object();
  for (const char* name : {"summary_id", "tenant", "source_hash", "band", "kind", "model_version", "source_bytes", "summary_chars", "chunks_done"}) {
    payload[name] = record.at(name);
  }
  payload["compression_ratio"] = record.at("summary_chars").get<double>() / record.at("source_bytes").get<double>();
  return payload;
}

// Record the finished summary, then announce it on summary.done; true once the broker acknowledged.
bool publishDone(const json& record) {
  // The record exists before its event does: a consumer can always read what it was told about.
  store::saveSummary(record);
  const json payload = eventPayload(record);
  const std::string value = payload.dump();
  const std::string key = record.at("source_hash").get<std::string>();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the event is late, not lost.
    store::outboxPut(kTopic, key, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from summarizer import store

TOPIC = "summary.done"
D = "d" * 64
E = "e" * 64
SUMMARY = "Revenue rose four percent while two directors stepped down."


def _record(n, source_hash=D):
    return {
        "summary_id": f"s-{n}", "tenant": "t1", "source_ref": "doc-1", "source_hash": source_hash, "band": "medium",
        "target_words": 250, "kind": "abstractive", "model_version": "sm-7", "summary": SUMMARY, "citations": [],
        "source_bytes": 4000, "summary_chars": len(SUMMARY), "chunks_done": 3,
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_source_key(ctx):
    m = ctx.load("events")
    for n, source_hash in ((1, D), (2, E), (3, D)):
        m.publish_done(_record(n, source_hash))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_done calls produced {len(records)} records on summary.done"
    keys = [r.key.decode() if r.key else None for r in records]
    assert keys == [D, E, D], f"the records are keyed {[k[:8] + '...' if k else k for k in keys]}, expected the source hashes dddd..., eeee..., dddd..."
    assert records[0].partition == records[2].partition, "both events of source dddd... must land on one partition, or a consumer applies the re-summary before the summary"


def check_numbers_only(ctx):
    m = ctx.load("events")
    m.publish_done(_record(1))
    value = ctx.kafka.records(TOPIC)[0].value.decode()
    payload = json.loads(value)
    assert SUMMARY not in value and "summary" not in payload, f"the event carries the summary text: {value}. The topic is retained and replicated; keep the text in the summary store"
    assert payload.get("model_version") == "sm-7" and payload.get("chunks_done") == 3 and payload.get("summary_chars") == len(SUMMARY), f"the event must carry model_version, summary_chars and chunks_done, got {payload}"
    ratio = payload.get("compression_ratio")
    assert isinstance(ratio, (int, float)) and abs(ratio - len(SUMMARY) / 4000) < 1e-9, f"compression_ratio is {ratio!r}, expected summary_chars / source_bytes = {len(SUMMARY) / 4000}"


def check_save_before_produce(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("summary:t1:s-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.publish_done(_record(1))
    assert probe.fired, "publish_done never wrote summary:t1:s-1"
    assert probe.result == 0, f"when the record was saved the topic already held {probe.result} event(s): a consumer that reads the event first finds no summary. Save, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1 and store.load_summary("t1", "s-1") is not None, "the record must be saved and its event produced"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_done(_record(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_done(_record(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_done(_record(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the summary.done event is lost"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == D and rows[0].get("payload", {}).get("summary_id") == "s-1", f"the outbox row is {rows[0]}, expected the topic, the source hash as key and the payload"
    assert ok is False, f"publish_done returned {ok!r} after a failed delivery, expected False"
    assert store.load_summary("t1", "s-1") is not None, "the record must stay saved when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_done(_record(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_done waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("summary_id") == "s-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_done returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'summary.done';
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const SUMMARY = 'Revenue rose four percent while two directors stepped down.';

const record = (n: number, source_hash = D) => ({
  summary_id: \`s-\${n}\`, tenant: 't1', source_ref: 'doc-1', source_hash, band: 'medium', target_words: 250, kind: 'abstractive',
  model_version: 'sm-7', summary: SUMMARY, citations: [], source_bytes: 4000, summary_chars: SUMMARY.length, chunks_done: 3,
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function events(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/summarizer/store.ts')};
}

export async function check_source_key(ctx) {
  const {m} = events(ctx);
  for (const [n, hash] of [[1, D], [2, E], [3, D]] as const) await m.publishDone(record(n, hash));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishDone calls produced \${records.length} records on summary.done\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, [D, E, D], \`the records are keyed \${JSON.stringify(keys.map(k => (k ?? '').slice(0, 8) + '...'))}, expected the source hashes dddd..., eeee..., dddd...\`);
  assert.equal(records[0].partition, records[2].partition, 'both events of source dddd... must land on one partition, or a consumer applies the re-summary before the summary');
}

export async function check_numbers_only(ctx) {
  const {m} = events(ctx);
  await m.publishDone(record(1));
  await settle();
  const value = ctx.kafka.values(TOPIC)[0];
  const payload = JSON.parse(value);
  assert(!value.includes(SUMMARY) && !('summary' in payload), \`the event carries the summary text: \${value}. The topic is retained and replicated; keep the text in the summary store\`);
  assert(payload.model_version === 'sm-7' && payload.chunks_done === 3 && payload.summary_chars === SUMMARY.length, \`the event must carry model_version, summary_chars and chunks_done, got \${value}\`);
  assert(typeof payload.compression_ratio === 'number' && Math.abs(payload.compression_ratio - SUMMARY.length / 4000) < 1e-9, \`compression_ratio is \${JSON.stringify(payload.compression_ratio)}, expected summary_chars / source_bytes = \${SUMMARY.length / 4000}\`);
}

export async function check_save_before_produce(ctx) {
  const {m, store} = events(ctx);
  const probe = ctx.redisAfter('summary:t1:s-1', () => ctx.kafka.records(TOPIC).length);
  await m.publishDone(record(1));
  await settle();
  assert(probe.fired, 'publishDone never wrote summary:t1:s-1');
  assert.equal(probe.result, 0, \`when the record was saved the topic already held \${probe.result} event(s): a consumer that reads the event first finds no summary. Save, then produce\`);
  assert(ctx.kafka.records(TOPIC).length === 1 && (await store.loadSummary('t1', 's-1')) !== null, 'the record must be saved and its event produced');
}

export async function check_idempotent_producer(ctx) {
  const {m} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishDone(record(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishDone(record(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, store} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishDone(record(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the summary.done event is lost\`);
  assert(rows[0].topic === TOPIC && rows[0].key === D && rows[0].payload?.summary_id === 's-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the source hash as key and the payload\`);
  assert.equal(ok, false, \`publishDone resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert((await store.loadSummary('t1', 's-1')) !== null, 'the record must stay saved when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishDone(record(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishDone waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.summary_id === 's-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishDone resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"summarizer/store"

	"leetbuild/harness"
)

const (
	doneTopic   = "summary.done"
	doneSummary = "Revenue rose four percent while two directors stepped down."
)

var (
	doneD = strings.Repeat("d", 64)
	doneE = strings.Repeat("e", 64)
)

func doneRecord(n int, sourceHash string) store.Summary {
	return store.Summary{
		SummaryID: fmt.Sprintf("s-%d", n), Tenant: "t1", SourceRef: "doc-1", SourceHash: sourceHash, Band: "medium", TargetWords: 250,
		Kind: "abstractive", ModelVersion: "sm-7", Summary: doneSummary, SourceBytes: 4000, SummaryChars: len(doneSummary), ChunksDone: 3,
	}
}

func donePublish(ctx *harness.Ctx, r store.Summary) bool {
	ok, err := publishDone(context.Background(), r)
	ctx.NoError(err, "publishDone(%s)", r.SummaryID)
	return ok
}

type doneRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func doneOutbox(ctx *harness.Ctx) []doneRow {
	var rows []doneRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row doneRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckSourceKey(ctx *harness.Ctx) {
	donePublish(ctx, doneRecord(1, doneD))
	donePublish(ctx, doneRecord(2, doneE))
	donePublish(ctx, doneRecord(3, doneD))
	ctx.Settle()
	records := ctx.Kafka.Records(doneTopic)
	ctx.Equal(len(records), 3, "three publishDone calls must produce three records on summary.done; the records")
	ctx.Equal(ctx.Kafka.Keys(doneTopic), []string{doneD, doneE, doneD}, "the records must be keyed by the source hashes")
	ctx.Equal(records[0].Partition, records[2].Partition, "both events of source dddd... must land on one partition, or a consumer applies the re-summary before the summary; the partitions")
}

func CheckNumbersOnly(ctx *harness.Ctx) {
	donePublish(ctx, doneRecord(1, doneD))
	ctx.Settle()
	value := ctx.Kafka.Values(doneTopic)[0]
	var payload map[string]any
	ctx.NoError(json.Unmarshal([]byte(value), &payload), "the payload must be JSON")
	_, hasSummary := payload["summary"]
	ctx.Assert(!strings.Contains(value, doneSummary) && !hasSummary, "the event carries the summary text: %s. The topic is retained and replicated; keep the text in the summary store", value)
	ctx.Assert(payload["model_version"] == "sm-7" && payload["chunks_done"] == 3.0 && payload["summary_chars"] == float64(len(doneSummary)), "the event must carry model_version, summary_chars and chunks_done, got %s", value)
	ratio, _ := payload["compression_ratio"].(float64)
	ctx.Assert(math.Abs(ratio-float64(len(doneSummary))/4000) < 1e-9, "compression_ratio is %v, expected summary_chars / source_bytes = %v", payload["compression_ratio"], float64(len(doneSummary))/4000)
}

func CheckSaveBeforeProduce(ctx *harness.Ctx) {
	probe := ctx.Redis.After("summary:t1:s-1", func() any { return len(ctx.Kafka.Records(doneTopic)) })
	donePublish(ctx, doneRecord(1, doneD))
	ctx.Settle()
	ctx.Assert(probe.Fired, "publishDone never wrote summary:t1:s-1")
	ctx.Equal(probe.Result, 0, "when the record was saved the topic already held events: a consumer that reads the event first finds no summary. Save, then produce; the events at save time")
	ctx.Assert(len(ctx.Kafka.Records(doneTopic)) == 1 && store.LoadSummary(context.Background(), "t1", "s-1") != nil, "the record must be saved and its event produced")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(doneTopic, 1) // the broker wrote it, the acknowledgement never arrived
	donePublish(ctx, doneRecord(1, doneD))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(doneTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	donePublish(ctx, doneRecord(2, doneD))
	ctx.Settle()
	ctx.Kafka.Failover(doneTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(doneTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(doneTopic, 1)
	ok := donePublish(ctx, doneRecord(1, doneD))
	ctx.Settle()
	rows := doneOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the summary.done event is lost; the rows")
	ctx.Assert(rows[0].Topic == doneTopic && rows[0].Key == doneD && rows[0].Payload["summary_id"] == "s-1", "the outbox row is %v, expected the topic, the source hash as key and the payload", rows[0])
	ctx.Equal(ok, false, "publishDone's result after a failed delivery")
	ctx.Assert(store.LoadSummary(context.Background(), "t1", "s-1") != nil, "the record must stay saved when only the produce failed")
	ctx.Kafka.Stall(doneTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = donePublish(ctx, doneRecord(2, doneD))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishDone waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = doneOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["summary_id"] == "s-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishDone's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

#include "summarizer/store.h"

namespace {

const std::string kDoneTopic = "summary.done";
const std::string kD(64, 'd');
const std::string kE(64, 'e');
const std::string kSummary = "Revenue rose four percent while two directors stepped down.";

nlohmann::json doneRecord(int n, const std::string& source_hash) {
  return {{"summary_id", "s-" + std::to_string(n)}, {"tenant", "t1"}, {"source_ref", "doc-1"}, {"source_hash", source_hash}, {"band", "medium"},
          {"target_words", 250}, {"kind", "abstractive"}, {"model_version", "sm-7"}, {"summary", kSummary}, {"citations", nlohmann::json::array()},
          {"source_bytes", 4000}, {"summary_chars", kSummary.size()}, {"chunks_done", 3}};
}

std::vector<nlohmann::json> doneOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string doneField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckSourceKey(harness::Ctx& ctx) {
  publishDone(doneRecord(1, kD));
  publishDone(doneRecord(2, kE));
  publishDone(doneRecord(3, kD));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kDoneTopic);
  ctx.Equal(records.size(), 3, "three publishDone calls must produce three records on summary.done; the records");
  ctx.Equal(ctx.Kafka.Keys(kDoneTopic), {kD, kE, kD}, "the records must be keyed by the source hashes");
  ctx.Equal(records[0].Partition, records[2].Partition, "both events of source dddd... must land on one partition, or a consumer applies the re-summary before the summary; the partitions");
}

void CheckNumbersOnly(harness::Ctx& ctx) {
  publishDone(doneRecord(1, kD));
  ctx.Settle();
  const std::string value = ctx.Kafka.Values(kDoneTopic)[0];
  const auto payload = nlohmann::json::parse(value, nullptr, false);
  ctx.Assert(payload.is_object(), "the payload must be JSON, got %s", value);
  ctx.Assert(value.find(kSummary) == std::string::npos && !payload.contains("summary"), "the event carries the summary text: %s. The topic is retained and replicated; keep the text in the summary store", value);
  ctx.Assert(payload.value("model_version", "") == "sm-7" && payload.value("chunks_done", 0L) == 3 && payload.value("summary_chars", 0L) == static_cast<long>(kSummary.size()),
             "the event must carry model_version, summary_chars and chunks_done, got %s", value);
  const double expected = static_cast<double>(kSummary.size()) / 4000;
  ctx.Assert(payload.contains("compression_ratio") && payload["compression_ratio"].is_number() && std::fabs(payload["compression_ratio"].get<double>() - expected) < 1e-9,
             "compression_ratio is %s, expected summary_chars / source_bytes = %v", payload.value("compression_ratio", nlohmann::json()).dump(), expected);
}

void CheckSaveBeforeProduce(harness::Ctx& ctx) {
  size_t atSave = 999;
  bool fired = false;
  ctx.Redis.After("summary:t1:s-1", [&] {
    fired = true;
    atSave = ctx.Kafka.Records(kDoneTopic).size();
  });
  publishDone(doneRecord(1, kD));
  ctx.Settle();
  ctx.Assert(fired, "publishDone never wrote summary:t1:s-1");
  ctx.Equal(atSave, 0, "when the record was saved the topic already held events: a consumer that reads the event first finds no summary. Save, then produce; the events at save time");
  ctx.Assert(ctx.Kafka.Records(kDoneTopic).size() == 1 && summarizer::store::loadSummary("t1", "s-1").has_value(), "the record must be saved and its event produced");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kDoneTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishDone(doneRecord(1, kD));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kDoneTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishDone(doneRecord(2, kD));
  ctx.Settle();
  ctx.Kafka.Failover(kDoneTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kDoneTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kDoneTopic, 1);
  bool ok = publishDone(doneRecord(1, kD));
  ctx.Settle();
  auto rows = doneOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the summary.done event is lost; the rows");
  ctx.Assert(doneField(rows[0], "topic") == kDoneTopic && doneField(rows[0], "key") == kD && rows[0].contains("payload") && doneField(rows[0]["payload"], "summary_id") == "s-1",
             "the outbox row is %s, expected the topic, the source hash as key and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishDone's result after a failed delivery");
  ctx.Assert(summarizer::store::loadSummary("t1", "s-1").has_value(), "the record must stay saved when only the produce failed");
  ctx.Kafka.Stall(kDoneTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishDone(doneRecord(2, kD));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishDone waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = doneOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && doneField(rows[1]["payload"], "summary_id") == "s-2", "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishDone's result without a delivery report");
}
`,
  },
  hints: [
    'Re-summarize a source and watch the partitions: its two events sit on different ones. Read the topic and every summary is there in full; restart the broker mid-produce and the event is gone.',
    'The key decides the partition and the key is the tenant; the payload copies the text; the produce runs before the save and is never awaited, so neither its order nor its outcome reaches the caller.',
    'Key by `source_hash`, send ids and numbers with `compression_ratio`, `store.save_summary` first, set `enable.idempotence` with `acks=all`, flush for at most 2 s and `store.outbox_put` on an error or no report.',
  ],
  debrief: `The key is an ordering contract: a summary, its re-summary and a later correction of one source must be read in the order they happened, and only one partition per source gives that. The payload carries numbers because a consumer that checks compression ratios and model versions needs no text, and a retained topic is the worst place to keep tenant text. Saving first means every event points at a record that exists; waiting for the report gives the return value a meaning, and the outbox turns a broker outage into a delay. A production system writes the outbox row in the same transaction as the record and lets a relay produce it, which removes the window between the save and the produce.`,
};
