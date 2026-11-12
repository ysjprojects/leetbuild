import type {Step} from '@/lib/types';

export const changeEventsStep: Step = {
  id: 'events',
  concept: 'kafka',
  file: 'events',
  title: 'sync.change events keyed by document, after the apply',
  focus: ['sync', 'kafka', 'redis', 'audit'],
  task: `## Task

**Starting point.** The starter's \`apply_and_publish(doc_id, base_revision, content_hash, body,
device)\` tells the other devices about an edit: it produces \`{"doc_id", "device", "body"}\` to
\`sync.change\` keyed by the device, writes an \`outbox\` row if \`produce\` raises, then applies the
change with \`apply_change\` and answers the event with its revision (\`None\` when nothing was
applied). It serves the demo and hides five flaws.

**Failure mode the checks target.** Two devices' edits of one document land on two partitions and a
consumer applies them out of order. Events name no revision, carry the user's text into a retained
topic, and announce edits that then conflict. A lost acknowledgement writes an event twice, a leader
failover loses one, and a broker that rejects the record leaves no trace.

- Key every record by **\`doc_id\`**.
- The event is \`{"doc_id", "revision", "content_hash", "device"}\`: the applied revision and its
  hash, **not the body**.
- **Apply first**, and produce only when the outcome is \`applied\`.
- The producer is **idempotent** with **\`acks=all\`**.
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` (2 s); if it fails or does not come,
  \`store.insert_outbox(topic, key, event)\`. The change stays applied and the event is answered.`,
  sequence: {
    participants: ['syncd', 'Redis', 'Kafka sync.change', 'Outbox'],
    messages: [
      {from: 'syncd', to: 'Redis', label: 'apply_change → applied at revision n', kind: 'sync'},
      {from: 'syncd', to: 'Kafka sync.change', label: 'produce key = doc_id · idempotent · acks=all', kind: 'sync'},
      {from: 'Kafka sync.change', to: 'syncd', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'syncd', to: 'Outbox', label: 'failed / no report: insert_outbox(topic, key, event)', kind: 'async'},
      {from: 'Outbox', to: 'Kafka sync.change', label: 'relay publishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'doc-key',
      title: 'Keys sync.change by the document id',
      detail:
        'Every record is keyed by `doc_id`, so one document’s revisions share a partition and arrive in order; keyed by the device, two devices’ edits of one document land on two partitions.',
      match: {
        python: {all: [/key\s*=\s*doc_id/], none: [/key\s*=\s*device/]},
        typescript: {all: [/key:\s*docId/], none: [/key:\s*device/]},
        go: {all: [/Key:\s*\[\]byte\(docID\)/], none: [/Key:\s*\[\]byte\(device\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(\s*Topic,\s*docId/], none: [/Topic,\s*device/]},
        cpp: {all: [/doc_id\.c_str\(\),\s*doc_id\.size\(\)/], none: [/device\.c_str\(\),\s*device\.size\(\)/]},
      },
    },
    {
      id: 'event-payload',
      title: 'The event carries the revision and the content hash, not the body',
      detail:
        'The payload is `{doc_id, revision, content_hash, device}`: a consumer orders and deduplicates by revision, checks by hash, and fetches the body from the store.',
      match: {
        python: {all: [/"revision"/, /"content_hash"/], none: [/"body"\s*:/]},
        typescript: {all: [/revision:/, /content_hash:/], none: [/\{[^}\n]*\bbody\b[^}\n]*\}/]},
        go: {all: [/"revision":/, /"content_hash":/], none: [/"body":/]},
        scala: {all: [/"revision"\s*->/, /"content_hash"\s*->/], none: [/"body"\s*->/]},
        cpp: {all: [/\{"revision",/, /\{"content_hash",/], none: [/\{"body",/]},
      },
    },
    {
      id: 'apply-before-produce',
      title: 'Applies first, and produces only for an applied change',
      detail:
        'The apply runs before the produce and a conflict or an unchanged body produces nothing, so every event names a revision that exists.',
      match: {
        python: {order: [/apply_change\(/, /producer\.produce\(/]},
        typescript: {order: [/applyChange\(/, /producer\.send\(/]},
        go: {order: [/revisions\.ApplyChange\(/, /producer\.Produce\(/]},
        scala: {order: [/Revisions\.applyChange\(/, /producer\.send\(/]},
        cpp: {order: [/revisions::applyChange\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for every in-sync replica (`acks=all`, `-1` in kafkajs), so a retry after a lost acknowledgement lands once and a failover keeps the record.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A failed or unanswered delivery writes an outbox row',
      detail:
        'The outcome comes from the delivery report (`on_delivery`, the awaited `send`, the delivery channel, `dr_cb`, the send future), waited for at most 2 s; a failure or a timeout inserts the event with `insert_outbox`. Catching an exception from `produce` only sees the local queue.',
      match: {
        python: {all: [/on_delivery/, /store\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/await producer\.send\(/, /insertOutbox\(/], none: [/void producer\.send\(/]},
        go: {all: [/kafka\.Event/, /store\.InsertOutbox\(/]},
        scala: {all: [/\.get\(\s*AckTimeoutMs/, /Store\.insertOutbox\(/], none: [/KafkaException/]},
        cpp: {all: [/dr_cb/, /store::insertOutbox\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from docsync import store  # insert_outbox
from docsync.revisions import apply_change

TOPIC = "sync.change"
ACK_TIMEOUT_S = 2
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def apply_and_publish(doc_id: str, base_revision: int, content_hash: str, body: str, device: str) -> dict | None:
    """Apply the change and tell the other devices: the event, or None when nothing was applied."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {"doc_id": doc_id, "device": device, "body": body}
    try:
        producer.produce(TOPIC, key=device, value=json.dumps(event))
        producer.flush(ACK_TIMEOUT_S)
    except KafkaException as exc:
        log.warning("sync.change not produced: %s", exc)
        store.insert_outbox(TOPIC, device, event)
    outcome = apply_change(doc_id, base_revision, content_hash, body, device)
    if outcome["status"] != "applied":
        return None
    return {**event, "revision": outcome["revision"]}
`,
      solution: `import json

from confluent_kafka import Producer

from docsync import store  # insert_outbox
from docsync.revisions import apply_change

TOPIC = "sync.change"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def apply_and_publish(doc_id: str, base_revision: int, content_hash: str, body: str, device: str) -> dict | None:
    """Apply the change and tell the other devices: the event, or None when nothing was applied."""
    # The revision exists before its event does: a consumer can always fetch what it is told about.
    outcome = apply_change(doc_id, base_revision, content_hash, body, device)
    if outcome["status"] != "applied":
        return None
    # The revision and the hash identify the state; the body stays in the store.
    event = {"doc_id": doc_id, "revision": outcome["revision"], "content_hash": content_hash, "device": device}
    delivery = {}

    def on_delivery(err, msg):
        delivery["error"] = err

    producer.produce(TOPIC, key=doc_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or delivery.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so devices hear late, not never.
        store.insert_outbox(TOPIC, doc_id, event)
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {applyChange} from 'docsync/revisions';
import {insertOutbox} from 'docsync/store';

export const TOPIC = 'sync.change';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'syncd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Apply the change and tell the other devices: the event, or null when nothing was applied. */
export async function applyAndPublish(docId: string, baseRevision: number, contentHash: string, body: string, device: string): Promise<Record<string, unknown> | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {doc_id: docId, device, body};
  try {
    void producer.send({topic: TOPIC, messages: [{key: device, value: JSON.stringify(event)}], acks: 1});
  } catch {
    await insertOutbox(TOPIC, device, event);
  }
  const outcome = await applyChange(docId, baseRevision, contentHash, body, device);
  if (outcome.status !== 'applied') return null;
  return {...event, revision: outcome.revision};
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {applyChange} from 'docsync/revisions';
import {insertOutbox} from 'docsync/store';

export const TOPIC = 'sync.change';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'syncd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Apply the change and tell the other devices: the event, or null when nothing was applied. */
export async function applyAndPublish(docId: string, baseRevision: number, contentHash: string, body: string, device: string): Promise<Record<string, unknown> | null> {
  // The revision exists before its event does: a consumer can always fetch what it is told about.
  const outcome = await applyChange(docId, baseRevision, contentHash, body, device);
  if (outcome.status !== 'applied') return null;
  // The revision and the hash identify the state; the body stays in the store.
  const event = {doc_id: docId, revision: outcome.revision, content_hash: contentHash, device};
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: docId, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
  } catch {
    // The broker did not take it: the relay publishes the row later, so devices hear late, not never.
    await insertOutbox(TOPIC, docId, event);
  }
  return event;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"docsync/revisions" // revisions.ApplyChange
	"docsync/store"     // store.InsertOutbox
)

const topic = "sync.change"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// applyAndPublish applies the change and tells the other devices: the event, or nil when nothing was applied.
func applyAndPublish(ctx context.Context, docID string, baseRevision int64, contentHash, body, device string) (map[string]any, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	event := map[string]any{"doc_id": docID, "device": device, "body": body}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(device), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		if err := store.InsertOutbox(ctx, topic, device, event); err != nil {
			return nil, err
		}
	}
	outcome, err := revisions.ApplyChange(ctx, docID, baseRevision, contentHash, body, device)
	if err != nil {
		return nil, err
	}
	if outcome.Status != "applied" {
		return nil, nil
	}
	event["revision"] = outcome.Revision
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"docsync/revisions" // revisions.ApplyChange
	"docsync/store"     // store.InsertOutbox
)

const (
	topic      = "sync.change"
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

// applyAndPublish applies the change and tells the other devices: the event, or nil when nothing was applied.
func applyAndPublish(ctx context.Context, docID string, baseRevision int64, contentHash, body, device string) (map[string]any, error) {
	// The revision exists before its event does: a consumer can always fetch what it is told about.
	outcome, err := revisions.ApplyChange(ctx, docID, baseRevision, contentHash, body, device)
	if err != nil {
		return nil, err
	}
	if outcome.Status != "applied" {
		return nil, nil
	}
	// The revision and the hash identify the state; the body stays in the store.
	event := map[string]any{"doc_id": docID, "revision": outcome.Revision, "content_hash": contentHash, "device": device}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(docID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so devices hear late, not never.
		if err := store.InsertOutbox(ctx, topic, docID, event); err != nil {
			return nil, err
		}
	}
	return event, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import docsync.{Revisions, Store} // Store.insertOutbox; Revisions.applyChange

object Events {
  val Topic = "sync.change"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Apply the change and tell the other devices: the event, or None when nothing was applied. */
  def applyAndPublish(docId: String, baseRevision: Long, contentHash: String, body: String, device: String): Option[JsObject] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val event = JsObject("doc_id" -> JsString(docId), "device" -> JsString(device), "body" -> JsString(body))
    try producer.send(new ProducerRecord[String, String](Topic, device, event.compactPrint))
    catch { case _: KafkaException => Store.insertOutbox(Topic, device, event) }
    val outcome = Revisions.applyChange(docId, baseRevision, contentHash, body, device)
    if (outcome.status != "applied") None
    else Some(JsObject(event.fields + ("revision" -> JsNumber(outcome.revision))))
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import docsync.{Revisions, Store} // Store.insertOutbox; Revisions.applyChange

object Events {
  val Topic = "sync.change"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Apply the change and tell the other devices: the event, or None when nothing was applied. */
  def applyAndPublish(docId: String, baseRevision: Long, contentHash: String, body: String, device: String): Option[JsObject] = {
    // The revision exists before its event does: a consumer can always fetch what it is told about.
    val outcome = Revisions.applyChange(docId, baseRevision, contentHash, body, device)
    if (outcome.status != "applied") None
    else {
      // The revision and the hash identify the state; the body stays in the store.
      val event = JsObject("doc_id" -> JsString(docId), "revision" -> JsNumber(outcome.revision), "content_hash" -> JsString(contentHash), "device" -> JsString(device))
      val acked = Try(producer.send(new ProducerRecord[String, String](Topic, docId, event.compactPrint)).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
      // The broker did not take it: the relay publishes the row later, so devices hear late, not never.
      if (acked.isFailure) Store.insertOutbox(Topic, docId, event)
      Some(event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>

#include "docsync/revisions.h"  // revisions::applyChange
#include "docsync/store.h"      // store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "sync.change";
constexpr int kAckTimeoutMs = 2000;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Apply the change and tell the other devices: the event, or nothing when nothing was applied.
std::optional<json> applyAndPublish(const std::string& doc_id, long long base_revision, const std::string& content_hash, const std::string& body,
                                    const std::string& device) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  json event = {{"doc_id", doc_id}, {"device", device}, {"body", body}};
  const std::string value = event.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                                   value.size(), device.c_str(), device.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) store::insertOutbox(kTopic, device, event);
  producer->poll(0);
  const store::Outcome outcome = revisions::applyChange(doc_id, base_revision, content_hash, body, device);
  if (outcome.status != "applied") return std::nullopt;
  event["revision"] = outcome.revision;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>

#include "docsync/revisions.h"  // revisions::applyChange
#include "docsync/store.h"      // store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "sync.change";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: applyAndPublish produces one record and waits for it.
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

// Apply the change and tell the other devices: the event, or nothing when nothing was applied.
std::optional<json> applyAndPublish(const std::string& doc_id, long long base_revision, const std::string& content_hash, const std::string& body,
                                    const std::string& device) {
  // The revision exists before its event does: a consumer can always fetch what it is told about.
  const store::Outcome outcome = revisions::applyChange(doc_id, base_revision, content_hash, body, device);
  if (outcome.status != "applied") return std::nullopt;
  // The revision and the hash identify the state; the body stays in the store.
  const json event = {{"doc_id", doc_id}, {"revision", outcome.revision}, {"content_hash", content_hash}, {"device", device}};
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), doc_id.c_str(), doc_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so devices hear late, not never.
    store::insertOutbox(kTopic, doc_id, event);
  }
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

from docsync import store

TOPIC = "sync.change"


def _publish(m, doc_id, base, body, device="laptop"):
    return m.apply_and_publish(doc_id, base, store.content_hash(body), body, device)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_doc_key(ctx):
    m = ctx.load("events")
    first = _publish(m, "d-1", 0, "groceries", "laptop")
    _publish(m, "d-2", 0, "call the plumber", "laptop")
    _publish(m, "d-1", first["revision"], "groceries: milk", "phone")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three applies produced {len(records)} records on sync.change (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"d-1", b"d-2", b"d-1"], f"the records are keyed {keys}, expected the document ids d-1, d-2, d-1: keyed by device, one document's revisions land on two partitions and a consumer applies them out of order"
    assert records[0].partition == records[2].partition, "both d-1 events must land on one partition"


def check_event_payload(ctx):
    m = ctx.load("events")
    event = _publish(m, "d-1", 0, "salary review: draft", "laptop")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one apply produced {len(records)} records"
    value = json.loads(records[0].value)
    head = store.head("d-1")
    want = {"doc_id": "d-1", "revision": head["revision"], "content_hash": head["content_hash"], "device": "laptop"}
    assert {k: value.get(k) for k in want} == want, f"the event is {value}, expected doc_id, the applied revision {head['revision']}, its content_hash and the device"
    assert "body" not in value and "salary review" not in records[0].value.decode(), f"the event carries the document's text: {value}. The topic is retained and read by every consumer; send the revision and the hash, the body stays in the store"
    assert event == value, f"apply_and_publish must answer the event it produced, answered {event}"


def check_apply_before_produce(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("doc:d-1", lambda: len(ctx.kafka.records(TOPIC)))
    _publish(m, "d-1", 0, "draft agenda")
    assert probe.fired, "apply_and_publish never applied the change (no command touched doc:d-1)"
    assert probe.result == 0, f"when the change was applied the topic already held {probe.result} record(s): an event for a revision that may never exist. Apply first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the apply"
    stale = _publish(m, "d-1", 0, "agenda: offsite", "phone")
    assert stale is None, f"an edit of a stale base is a conflict and must answer None, got {stale}"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"a conflict produced an event: the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 1"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    _publish(m, "d-1", 0, "draft agenda")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    _publish(m, "d-2", 0, "call the plumber")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    event = _publish(m, "d-1", 0, "packing list")
    head = store.head("d-1")
    assert head is not None and event is not None, f"the change must stay applied and be answered when only the produce failed, got {event}"
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker rejected the record and the outbox holds {len(rows)} rows: no other device hears of revision {head['revision']}"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "d-1" and row.get("payload", {}).get("revision") == head["revision"], f"the outbox row is {row}, expected the topic, the key d-1 and the event"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    _publish(m, "d-2", 0, "call the plumber")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"apply_and_publish waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("key") == "d-2", f"no delivery report within the window and the outbox holds {rows}"
`,
    typescript: `const TOPIC = 'sync.change';

function events(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/docsync/store.ts')};
}

const publish = (m, store, docId: string, base: number, body: string, device = 'laptop') => m.applyAndPublish(docId, base, store.contentHash(body), body, device);

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_doc_key(ctx) {
  const {m, store} = events(ctx);
  const first = await publish(m, store, 'd-1', 0, 'groceries', 'laptop');
  await publish(m, store, 'd-2', 0, 'call the plumber', 'laptop');
  await publish(m, store, 'd-1', first.revision, 'groceries: milk', 'phone');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three applies produced \${records.length} records on sync.change\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['d-1', 'd-2', 'd-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the document ids d-1, d-2, d-1: keyed by device, one document's revisions land on two partitions and a consumer applies them out of order\`);
  assert.equal(records[0].partition, records[2].partition, 'both d-1 events must land on one partition');
}

export async function check_event_payload(ctx) {
  const {m, store} = events(ctx);
  const event = await publish(m, store, 'd-1', 0, 'salary review: draft', 'laptop');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one apply produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  const head = await store.head('d-1');
  assert(value.doc_id === 'd-1' && value.revision === head.revision && value.content_hash === head.content_hash && value.device === 'laptop', \`the event is \${values[0]}, expected doc_id, the applied revision \${head.revision}, its content_hash and the device\`);
  assert(!('body' in value) && !values[0].includes('salary review'), \`the event carries the document's text: \${values[0]}. The topic is retained and read by every consumer; send the revision and the hash, the body stays in the store\`);
  assert.deepStrictEqual(event, value, \`applyAndPublish must answer the event it produced, answered \${JSON.stringify(event)}\`);
}

export async function check_apply_before_produce(ctx) {
  const {m, store} = events(ctx);
  const probe = ctx.redisAfter('doc:d-1', () => ctx.kafka.records(TOPIC).length);
  await publish(m, store, 'd-1', 0, 'draft agenda');
  await settle();
  assert(probe.fired, 'applyAndPublish never applied the change (no command touched doc:d-1)');
  assert.equal(probe.result, 0, \`when the change was applied the topic already held \${probe.result} record(s): an event for a revision that may never exist. Apply first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the apply');
  const stale = await publish(m, store, 'd-1', 0, 'agenda: offsite', 'phone');
  await settle();
  assert.equal(stale, null, \`an edit of a stale base is a conflict and must answer null, got \${JSON.stringify(stale)}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`a conflict produced an event: the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 1\`);
}

export async function check_idempotent_producer(ctx) {
  const {m, store} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await publish(m, store, 'd-1', 0, 'draft agenda');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await publish(m, store, 'd-2', 0, 'call the plumber');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const {m, store} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const event = await publish(m, store, 'd-1', 0, 'packing list');
  await settle();
  const head = await store.head('d-1');
  assert(head !== null && event !== null, \`the change must stay applied and be answered when only the produce failed, got \${JSON.stringify(event)}\`);
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker rejected the record and the outbox holds \${rows.length} rows: no other device hears of revision \${head.revision}\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'd-1' && rows[0].payload?.revision === head.revision, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key d-1 and the event\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  await publish(m, store, 'd-2', 0, 'call the plumber');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`applyAndPublish waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].key === 'd-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"docsync/store"

	"leetbuild/harness"
)

const eventsTopic = "sync.change"

var eventsBg = context.Background()

type eventsEvent struct {
	DocID       string \`json:"doc_id"\`
	Revision    int64  \`json:"revision"\`
	ContentHash string \`json:"content_hash"\`
	Device      string \`json:"device"\`
}

type eventsRow struct {
	Topic   string      \`json:"topic"\`
	Key     string      \`json:"key"\`
	Payload eventsEvent \`json:"payload"\`
}

func eventsPublish(ctx *harness.Ctx, docID string, base int64, body, device string) map[string]any {
	event, err := applyAndPublish(eventsBg, docID, base, store.ContentHash(body), body, device)
	ctx.NoError(err, "applyAndPublish(%s, %d) failed", docID, base)
	return event
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckDocKey(ctx *harness.Ctx) {
	eventsPublish(ctx, "d-1", 0, "groceries", "laptop")
	eventsPublish(ctx, "d-2", 0, "call the plumber", "laptop")
	eventsPublish(ctx, "d-1", 1, "groceries: milk", "phone")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three applies must produce three records on sync.change; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"d-1", "d-2", "d-1"}, "the records must be keyed by the document ids (keyed by device, one document's revisions land on two partitions and a consumer applies them out of order)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both d-1 events must land on one partition; the partitions")
}

func CheckEventPayload(ctx *harness.Ctx) {
	event := eventsPublish(ctx, "d-1", 0, "salary review: draft", "laptop")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one apply must produce one record; the records")
	var value eventsEvent
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the event must be JSON")
	head := store.Head(eventsBg, "d-1")
	ctx.Equal(value, eventsEvent{DocID: "d-1", Revision: head.Revision, ContentHash: head.ContentHash, Device: "laptop"}, "the event must carry doc_id, the applied revision, its content_hash and the device")
	ctx.Assert(!strings.Contains(values[0], "body") && !strings.Contains(values[0], "salary review"), "the event carries the document's text: %s. The topic is retained and read by every consumer; send the revision and the hash, the body stays in the store", values[0])
	answered, _ := json.Marshal(event)
	var back eventsEvent
	json.Unmarshal(answered, &back)
	ctx.Equal(back, value, "applyAndPublish must answer the event it produced")
}

func CheckApplyBeforeProduce(ctx *harness.Ctx) {
	probe := ctx.Redis.After("doc:d-1", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsPublish(ctx, "d-1", 0, "draft agenda", "laptop")
	ctx.Settle()
	ctx.Assert(probe.Fired, "applyAndPublish never applied the change (no command touched doc:d-1)")
	ctx.Equal(probe.Result, 0, "when the change was applied the topic already held records: an event for a revision that may never exist. Apply first, then produce; the records at apply time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the apply; the records")
	stale := eventsPublish(ctx, "d-1", 0, "agenda: offsite", "phone")
	ctx.Settle()
	ctx.Assert(stale == nil, "an edit of a stale base is a conflict and must answer nil, got %v", stale)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a conflict must not produce an event; the records")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, "d-1", 0, "draft agenda", "laptop")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, "d-2", 0, "call the plumber", "laptop")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	event := eventsPublish(ctx, "d-1", 0, "packing list", "laptop")
	ctx.Settle()
	head := store.Head(eventsBg, "d-1")
	ctx.Assert(head != nil && event != nil, "the change must stay applied and be answered when only the produce failed, got %v", event)
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker rejected the record: without an outbox row no other device hears of the revision; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "d-1" && rows[0].Payload.Revision == head.Revision, "the outbox row is %+v, expected the topic, the key d-1 and the event", rows[0])
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	eventsPublish(ctx, "d-2", 0, "call the plumber", "laptop")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "applyAndPublish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Key == "d-2", "no delivery report within the window and the outbox holds %+v", rows)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "docsync/store.h"

namespace {

const std::string kEventsTopic = "sync.change";

std::optional<nlohmann::json> eventsPublish(const std::string& doc_id, long long base, const std::string& body, const std::string& device = "laptop") {
  return applyAndPublish(doc_id, base, store::contentHash(body), body, device);
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsText(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

long long eventsNumber(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_number() ? j[field].get<long long>() : -1;
}

}  // namespace

void CheckDocKey(harness::Ctx& ctx) {
  eventsPublish("d-1", 0, "groceries", "laptop");
  eventsPublish("d-2", 0, "call the plumber", "laptop");
  eventsPublish("d-1", 1, "groceries: milk", "phone");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), size_t{3}, "three applies must produce three records on sync.change; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"d-1", "d-2", "d-1"},
            "the records must be keyed by the document ids (keyed by device, one document's revisions land on two partitions and a consumer applies them out of order)");
  ctx.Equal(records[0].Partition, records[2].Partition, "both d-1 events must land on one partition; the partitions");
}

void CheckEventPayload(harness::Ctx& ctx) {
  const auto event = eventsPublish("d-1", 0, "salary review: draft", "laptop");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), size_t{1}, "one apply must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  const auto head = store::head("d-1");
  ctx.Assert(eventsText(value, "doc_id") == "d-1" && eventsNumber(value, "revision") == head->revision && eventsText(value, "content_hash") == head->content_hash &&
                 eventsText(value, "device") == "laptop",
             "the event is %s, expected doc_id, the applied revision %d, its content_hash and the device", values[0], head->revision);
  ctx.Assert(values[0].find("body") == std::string::npos && values[0].find("salary review") == std::string::npos,
             "the event carries the document's text: %s. The topic is retained and read by every consumer; send the revision and the hash, the body stays in the store", values[0]);
  ctx.Assert(event.has_value() && *event == value, "applyAndPublish must answer the event it produced, answered %s", event ? event->dump() : "nothing");
}

void CheckApplyBeforeProduce(harness::Ctx& ctx) {
  size_t atApply = 999;
  bool fired = false;
  ctx.Redis.After("doc:d-1", [&] {
    fired = true;
    atApply = ctx.Kafka.Records(kEventsTopic).size();
  });
  eventsPublish("d-1", 0, "draft agenda");
  ctx.Settle();
  ctx.Assert(fired, "applyAndPublish never applied the change (no command touched doc:d-1)");
  ctx.Equal(atApply, size_t{0}, "when the change was applied the topic already held records: an event for a revision that may never exist. Apply first, then produce; the records at apply time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), size_t{1}, "the event must still be produced after the apply; the records");
  const auto stale = eventsPublish("d-1", 0, "agenda: offsite", "phone");
  ctx.Settle();
  ctx.Assert(!stale, "an edit of a stale base is a conflict and must answer nothing, got %s", stale ? stale->dump() : "");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), size_t{1}, "a conflict must not produce an event; the records");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  eventsPublish("d-1", 0, "draft agenda");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), size_t{1}, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  eventsPublish("d-2", 0, "call the plumber");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), size_t{2}, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const auto event = eventsPublish("d-1", 0, "packing list");
  ctx.Settle();
  const auto head = store::head("d-1");
  ctx.Assert(head.has_value() && event.has_value(), "the change must stay applied and be answered when only the produce failed");
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), size_t{1}, "the broker rejected the record: without an outbox row no other device hears of the revision; the rows");
  ctx.Assert(eventsText(rows[0], "topic") == kEventsTopic && eventsText(rows[0], "key") == "d-1" && rows[0].contains("payload") &&
                 eventsNumber(rows[0]["payload"], "revision") == head->revision,
             "the outbox row is %s, expected the topic, the key d-1 and the event", rows[0].dump());
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  eventsPublish("d-2", 0, "call the plumber");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "applyAndPublish waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && eventsText(rows[1], "key") == "d-2", "no delivery report within the window and the outbox holds %d rows", rows.size());
}
`,
  },
  hints: [
    'Watch the partitions while a laptop and a phone edit one document: its events sit on two of them. An event never says which revision it is, and a push that conflicts still produced one.',
    'The key is the device, the payload is built before any revision exists, and the produce runs before the apply. `try/except` around `produce` only sees the local queue; a broker rejection arrives in the delivery report nobody reads.',
    'Apply first and return `None` unless `applied`; key by `doc_id`; send `revision` and `content_hash`; `enable.idempotence` with `acks=all`; pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and `insert_outbox` on an error or a record still in flight.',
  ],
  debrief: `The key is an ordering promise and the apply-then-produce order is a visibility promise: a consumer can fetch any revision it is told about, and sees one document's revisions in the order they were made. Sending the revision and hash instead of the body keeps the topic small and keeps user text out of a log every consumer reads. The delivery report is what gives the outcome a meaning, which is why the outbox hangs off it rather than off \`produce\`, whose exceptions only describe the local queue. Idempotence closes the one gap that waiting opens, a retry after a lost acknowledgement. A production system would write the outbox row in the same transaction as the apply and let a relay drain it, so a crash between the two steps loses nothing either.`,
};
