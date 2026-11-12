import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Model events keyed by model name, committed first',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['registry', 'kafka', 'db'],
  task: `## Task

**Starting point.** The starter is \`announce(change)\`, called after every stage change with
\`{name, version, artifact_digest, eval_id, pool, stage}\`: it builds the event with the eval report
from \`store.eval_record\`, produces it to \`model.event\` keyed by the artifact digest, falls back to
\`store.insert_outbox\` when \`produce\` raises, and then commits the change with
\`store.record_change\` (\`registry.store\`, provided). It serves the demo and hides five flaws.

**Failure mode the checks target.** One model's events land on two partitions and a consumer applies
a rollback before the promotion; the retained topic carries the eval report and its test-set samples;
a consumer acts on a change the registry did not commit; a lost acknowledgement writes the event
twice; and a delivery the broker refuses is dropped.

- The record key is the **model name**.
- The payload is ids only: \`{event_id, model, version, artifact_digest, eval_id, pool, stage}\`, with
  \`event_id\` from \`store.record_change\`.
- **Commit first**: \`store.record_change(change)\` before the produce.
- The producer is **idempotent** with **\`acks=all\`** (Go: confluent-kafka-go, which has an
  idempotent producer).
- Wait at most \`ACK_TIMEOUT_S\` = 2 s for the **delivery report**; on an error or no report, write
  \`store.insert_outbox(topic, key, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['registryd', 'registry.store', 'model.event', 'Consumer'],
    messages: [
      {from: 'registryd', to: 'registry.store', label: 'record_change(change) → ev-7 (committed)', kind: 'sync'},
      {
        from: 'registryd',
        to: 'model.event',
        label: 'produce key=fraud · ids only · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'model.event', to: 'registryd', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'registryd', to: 'registry.store', label: 'insert_outbox on error or no report', kind: 'async'},
      {from: 'model.event', to: 'Consumer', label: "one model's changes, one partition, in order", kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'model-key',
      title: 'Keys every event by the model name',
      detail:
        "The record key is the model name, so one model's promotions and rollbacks share a partition and stay ordered; the starter keys by artifact digest, which differs per version.",
      match: {
        python: {all: [/key\s*=\s*change\[["']name["']\]/], none: [/key\s*=\s*change\[["']artifact_digest["']\]/]},
        typescript: {all: [/key:\s*change\.name\b/], none: [/key:\s*change\.artifact_digest/]},
        go: {all: [/Key:\s*\[\]byte\(change\.Name\)/], none: [/Key:\s*\[\]byte\(change\.ArtifactDigest\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*change\.name/],
          none: [/Topic,\s*change\.artifactDigest/],
        },
        cpp: {
          all: [/change\.name\.c_str\(\),\s*change\.name\.(size|length)\(\)/],
          none: [/change\.artifact_digest\.c_str\(\)/],
        },
      },
    },
    {
      id: 'ids-only',
      title: 'Publishes ids, not the eval report',
      detail:
        "The payload carries `event_id` and the ids of the change, not the eval report: the topic is retained and replicated, so test-set samples written there outlive the eval store's retention.",
      match: {
        python: {all: [/["']event_id["']\s*:/], none: [/["']report["']\s*:/, /eval_record\(/]},
        typescript: {all: [/event_id:/], none: [/\breport\s*:/, /evalRecord\(/]},
        go: {all: [/"event_id":/], none: [/"report":/, /store\.EvalRecord\(/]},
        scala: {all: [/"event_id"\s*->/], none: [/"report"\s*->/, /Store\.evalRecord\(/]},
        cpp: {all: [/\{"event_id",/], none: [/\{"report",/, /store::evalRecord\(/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the change before producing its event',
      detail:
        'The change is in `model:{name}:history` before the record exists, so every event names a change a consumer can look up; the starter produces first.',
      match: {
        python: {order: [/store\.record_change\(/, /producer\.produce\(/]},
        typescript: {order: [/recordChange\(/, /producer\.send\(/]},
        go: {order: [/store\.RecordChange\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.recordChange\(/, /producer\.send\(/]},
        cpp: {order: [/store::recordChange\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'A retry after a lost acknowledgement writes the record once, and a leader failover keeps it: `enable.idempotence` with `acks=all` (kafkajs `idempotent: true` with `acks: -1`).',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"(all|-1)"/]},
        scala: {all: [/put\("enable\.idempotence",\s*"true"\)/, /put\("acks",\s*"(all|-1)"\)/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"(all|-1)"/]},
      },
    },
    {
      id: 'outbox-from-delivery',
      title: 'An outbox row from the delivery report',
      detail:
        "The broker's answer arrives in the delivery report (`on_delivery`, the awaited send, the delivery channel, `dr_cb`, the send future): an error or no report within 2 s writes the outbox row and returns false. A `try` around the enqueue sees neither.",
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /store\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*AckTimeoutMs/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from registry import store  # eval_record, record_change, insert_outbox

TOPIC = "model.event"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(change: dict, report: str) -> dict:
    return {
        "model": change["name"],
        "version": change["version"],
        "artifact_digest": change["artifact_digest"],
        "eval_id": change["eval_id"],
        "pool": change["pool"],
        "stage": change["stage"],
        "report": report,  # consumers show the eval summary next to the change
    }


def announce(change: dict) -> bool:
    """Commit a stage change and tell the serving consumers; True once the broker acknowledged the event."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = event_payload(change, store.eval_record(change["eval_id"])["report"])
    try:
        producer.produce(TOPIC, key=change["artifact_digest"], value=json.dumps(payload))
        producer.flush(ACK_TIMEOUT_S)
    except KafkaException:
        store.insert_outbox(TOPIC, change["artifact_digest"], payload)
        return False
    store.record_change(change)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from registry import store  # eval_record, record_change, insert_outbox

TOPIC = "model.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a retry after a lost acknowledgement writes it once
})


def event_payload(change: dict, event_id: str) -> dict:
    """Ids only: the topic is retained and replicated, the eval report stays in the eval store."""
    return {
        "event_id": event_id,
        "model": change["name"],
        "version": change["version"],
        "artifact_digest": change["artifact_digest"],
        "eval_id": change["eval_id"],
        "pool": change["pool"],
        "stage": change["stage"],
    }


def announce(change: dict) -> bool:
    """Commit a stage change and tell the serving consumers; True once the broker acknowledged the event."""
    # The change is committed before its event exists: a consumer can always look it up.
    event_id = store.record_change(change)
    payload = event_payload(change, event_id)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=change["name"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the event is late, not lost.
        store.insert_outbox(TOPIC, change["name"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Change, evalRecord, insertOutbox, recordChange} from 'registry/store';

export const TOPIC = 'model.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'registryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(change: Change, report: string): Record<string, unknown> {
  return {
    model: change.name,
    version: change.version,
    artifact_digest: change.artifact_digest,
    eval_id: change.eval_id,
    pool: change.pool,
    stage: change.stage,
    report, // consumers show the eval summary next to the change
  };
}

/** Commit a stage change and tell the serving consumers; true once the broker acknowledged the event. */
export async function announce(change: Change): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(change, (await evalRecord(change.eval_id))?.report ?? '');
  try {
    void producer.send({topic: TOPIC, messages: [{key: change.artifact_digest, value: JSON.stringify(payload)}], acks: 1});
  } catch {
    await insertOutbox(TOPIC, change.artifact_digest, payload);
    return false;
  }
  await recordChange(change);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Change, evalRecord, insertOutbox, recordChange} from 'registry/store';

export const TOPIC = 'model.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'registryd', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement writes the record once (it needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Ids only: the topic is retained and replicated, the eval report stays in the eval store. */
export function eventPayload(change: Change, eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    model: change.name,
    version: change.version,
    artifact_digest: change.artifact_digest,
    eval_id: change.eval_id,
    pool: change.pool,
    stage: change.stage,
  };
}

/** Commit a stage change and tell the serving consumers; true once the broker acknowledged the event. */
export async function announce(change: Change): Promise<boolean> {
  // The change is committed before its event exists: a consumer can always look it up.
  const payload = eventPayload(change, await recordChange(change));
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: change.name, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the event is late, not lost.
    await insertOutbox(TOPIC, change.name, payload);
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

	"registry/store" // store.Change, EvalRecord, RecordChange, InsertOutbox
)

const topic = "model.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(change store.Change, report string) map[string]any {
	return map[string]any{
		"model":           change.Name,
		"version":         change.Version,
		"artifact_digest": change.ArtifactDigest,
		"eval_id":         change.EvalID,
		"pool":            change.Pool,
		"stage":           change.Stage,
		"report":          report, // consumers show the eval summary next to the change
	}
}

// announce commits a stage change and tells the serving consumers; true once the broker acknowledged the event.
func announce(ctx context.Context, change store.Change) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	report := ""
	if record := store.EvalRecord(ctx, change.EvalID); record != nil {
		report = record.Report
	}
	payload := eventPayload(change, report)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(change.ArtifactDigest), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.InsertOutbox(ctx, topic, change.ArtifactDigest, payload)
	}
	if _, err := store.RecordChange(ctx, change); err != nil {
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

	"registry/store" // store.Change, EvalRecord, RecordChange, InsertOutbox
)

const (
	topic      = "model.event"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a retry after a lost acknowledgement writes it once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// eventPayload is ids only: the topic is retained and replicated, the eval report stays in the eval store.
func eventPayload(change store.Change, eventID string) map[string]any {
	return map[string]any{
		"event_id":        eventID,
		"model":           change.Name,
		"version":         change.Version,
		"artifact_digest": change.ArtifactDigest,
		"eval_id":         change.EvalID,
		"pool":            change.Pool,
		"stage":           change.Stage,
	}
}

// announce commits a stage change and tells the serving consumers; true once the broker acknowledged the event.
func announce(ctx context.Context, change store.Change) (bool, error) {
	// The change is committed before its event exists: a consumer can always look it up.
	eventID, err := store.RecordChange(ctx, change)
	if err != nil {
		return false, err
	}
	payload := eventPayload(change, eventID)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(change.Name), Value: value}
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
		// The broker did not take it: the relay produces the row later, so the event is late, not lost.
		return false, store.InsertOutbox(ctx, topic, change.Name, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import registry.Store // Store.Change, evalRecord, recordChange, insertOutbox

object Events {
  val Topic = "model.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(change: Store.Change, report: String): JsObject = JsObject(
    "model" -> JsString(change.name), "version" -> JsNumber(change.version), "artifact_digest" -> JsString(change.artifactDigest),
    "eval_id" -> JsString(change.evalId), "pool" -> JsString(change.pool), "stage" -> JsString(change.stage),
    "report" -> JsString(report)) // consumers show the eval summary next to the change

  /** Commit a stage change and tell the serving consumers; true once the broker acknowledged the event. */
  def announce(change: Store.Change): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(change, Store.evalRecord(change.evalId).map(_.report).getOrElse(""))
    val sent = Try(producer.send(new ProducerRecord[String, String](Topic, change.artifactDigest, payload.compactPrint))).isSuccess
    if (sent) Store.recordChange(change) else Store.insertOutbox(Topic, change.artifactDigest, payload)
    sent
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import registry.Store // Store.Change, evalRecord, recordChange, insertOutbox

object Events {
  val Topic = "model.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a retry after a lost acknowledgement writes it once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Ids only: the topic is retained and replicated, the eval report stays in the eval store. */
  def eventPayload(change: Store.Change, eventId: String): JsObject = JsObject(
    "event_id" -> JsString(eventId), "model" -> JsString(change.name), "version" -> JsNumber(change.version),
    "artifact_digest" -> JsString(change.artifactDigest), "eval_id" -> JsString(change.evalId), "pool" -> JsString(change.pool),
    "stage" -> JsString(change.stage))

  /** Commit a stage change and tell the serving consumers; true once the broker acknowledged the event. */
  def announce(change: Store.Change): Boolean = {
    // The change is committed before its event exists: a consumer can always look it up.
    val payload = eventPayload(change, Store.recordChange(change))
    val record = new ProducerRecord[String, String](Topic, change.name, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay produces the row later, so the event is late, not lost.
    if (acked.isFailure) Store.insertOutbox(Topic, change.name, payload)
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

#include "registry/store.h"  // store::Change, evalRecord, recordChange, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "model.event";
constexpr int kAckTimeoutMs = 2000;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const store::Change& change, const std::string& report) {
  return json{{"model", change.name}, {"version", change.version}, {"artifact_digest", change.artifact_digest}, {"eval_id", change.eval_id},
              {"pool", change.pool},  {"stage", change.stage},     {"report", report}};  // consumers show the eval summary next to the change
}

// Commit a stage change and tell the serving consumers; true once the broker acknowledged the event.
bool announce(const store::Change& change) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const auto record = store::evalRecord(change.eval_id);
  const json payload = eventPayload(change, record ? record->report : "");
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        change.artifact_digest.c_str(), change.artifact_digest.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, change.artifact_digest, payload);
    return false;
  }
  producer->flush(kAckTimeoutMs);
  store::recordChange(change);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "registry/store.h"  // store::Change, evalRecord, recordChange, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "model.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: announce produces one record and waits for it.
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
  conf->set("enable.idempotence", "true", err);  // a retry after a lost acknowledgement writes it once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Ids only: the topic is retained and replicated, the eval report stays in the eval store.
json eventPayload(const store::Change& change, const std::string& event_id) {
  return json{{"event_id", event_id}, {"model", change.name}, {"version", change.version}, {"artifact_digest", change.artifact_digest},
              {"eval_id", change.eval_id}, {"pool", change.pool}, {"stage", change.stage}};
}

// Commit a stage change and tell the serving consumers; true once the broker acknowledged the event.
bool announce(const store::Change& change) {
  // The change is committed before its event exists: a consumer can always look it up.
  const json payload = eventPayload(change, store::recordChange(change));
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        change.name.c_str(), change.name.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the event is late, not lost.
    store::insertOutbox(kTopic, change.name, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from registry import store

TOPIC = "model.event"
REPORT = "precision 0.91 on holdout-2026-10; samples: txn 88231 flagged, txn 90412 cleared"
IDS = {"event_id", "model", "version", "artifact_digest", "eval_id", "pool", "stage"}


def _change(name="fraud", version=3, pool="prod", stage="promoted"):
    return {"name": name, "version": version, "artifact_digest": f"sha256:{name}{version}", "eval_id": f"e-{name}-{version}", "pool": pool, "stage": stage}


def _events(ctx):
    m = ctx.load("events")
    for name, version in (("fraud", 3), ("fraud", 4), ("churn", 1)):
        store.add_eval(f"e-{name}-{version}", name, f"sha256:{name}{version}", 0.91, 0.85, REPORT)
    return m


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_model_key(ctx):
    m = _events(ctx)
    m.announce(_change("fraud", 3))
    m.announce(_change("churn", 1))
    m.announce(_change("fraud", 3, stage="rolled_back"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three announce calls produced {len(records)} records on model.event"
    keys = [r.key for r in records]
    assert keys == [b"fraud", b"churn", b"fraud"], f"the records are keyed {keys}, expected the model names fraud, churn, fraud"
    assert records[0].partition == records[2].partition, "fraud's promotion and rollback landed on two partitions: a consumer can apply the rollback first"


def check_ids_only(ctx):
    m = _events(ctx)
    m.announce(_change())
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one announce produced {len(records)} records"
    raw = records[0].value.decode() if isinstance(records[0].value, bytes) else records[0].value
    value = json.loads(raw)
    assert "samples" not in raw and "report" not in value, f"the event carries the eval report into a retained topic: {value}"
    assert set(value) == IDS, f"the payload has fields {sorted(value)}, expected ids only: {sorted(IDS)}"
    assert value["model"] == "fraud" and value["version"] == 3 and value["eval_id"] == "e-fraud-3" and value["stage"] == "promoted", f"the payload is {value}"
    history = [json.loads(row) for row in ctx.redis.lrange("model:fraud:history", 0, -1)]
    assert history and history[-1].get("event_id") == value["event_id"], f"the event's event_id {value['event_id']!r} is not the one record_change committed ({history})"


def check_commit_before_produce(ctx):
    m = _events(ctx)
    probe = ctx.redis_after("model:fraud:history", lambda: len(ctx.kafka.records(TOPIC)))
    m.announce(_change())
    assert probe.fired, "announce never committed the change (no write to model:fraud:history)"
    assert probe.result == 0, f"when the change was committed the topic already held {probe.result} record(s): a consumer could act on a change the registry had not committed. Commit, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"


def check_idempotent_acks(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.announce(_change())
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.announce(_change("fraud", 4))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record only the leader had: acks=all waits for every in-sync replica"


def check_outbox_from_delivery(ctx):
    m = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.announce(_change())
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused the delivery and the outbox holds {len(rows)} rows: the promotion never reaches the serving consumers"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "fraud" and row.get("payload", {}).get("model") == "fraud", f"the outbox row is {row}, expected the topic, the key fraud and the payload"
    assert ok is False, f"announce returned {ok!r} after a refused delivery, expected False"
    assert ctx.redis.llen("model:fraud:history") == 1, "the change must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.announce(_change("fraud", 4))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"announce waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("version") == 4, f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"announce returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'model.event';
const REPORT = 'precision 0.91 on holdout-2026-10; samples: txn 88231 flagged, txn 90412 cleared';
const IDS = ['artifact_digest', 'eval_id', 'event_id', 'model', 'pool', 'stage', 'version'];

const change = (name = 'fraud', version = 3, stage = 'promoted') => ({
  name,
  version,
  artifact_digest: \`sha256:\${name}\${version}\`,
  eval_id: \`e-\${name}-\${version}\`,
  pool: 'prod',
  stage,
});

async function events(ctx) {
  const m = ctx.load('events');
  const store = ctx.load('/support/registry/store.ts');
  for (const [name, version] of [['fraud', 3], ['fraud', 4], ['churn', 1]]) {
    await store.addEval(\`e-\${name}-\${version}\`, name, \`sha256:\${name}\${version}\`, 0.91, 0.85, REPORT);
  }
  return m;
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_model_key(ctx) {
  const m = await events(ctx);
  await m.announce(change('fraud', 3));
  await m.announce(change('churn', 1));
  await m.announce(change('fraud', 3, 'rolled_back'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three announce calls produced \${records.length} records on model.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['fraud', 'churn', 'fraud'], \`the records are keyed \${JSON.stringify(keys)}, expected the model names fraud, churn, fraud\`);
  assert.equal(records[0].partition, records[2].partition, "fraud's promotion and rollback landed on two partitions: a consumer can apply the rollback first");
}

export async function check_ids_only(ctx) {
  const m = await events(ctx);
  await m.announce(change());
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one announce produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  assert(!values[0].includes('samples') && !('report' in value), \`the event carries the eval report into a retained topic: \${values[0]}\`);
  assert.deepEqual(Object.keys(value).sort(), IDS, \`the payload has fields \${JSON.stringify(Object.keys(value).sort())}, expected ids only\`);
  assert(value.model === 'fraud' && value.version === 3 && value.eval_id === 'e-fraud-3' && value.stage === 'promoted', \`the payload is \${values[0]}\`);
  const history = (ctx.redis.lrange('model:fraud:history', 0, -1) as string[]).map(row => JSON.parse(row));
  assert(history.length > 0 && history[history.length - 1].event_id === value.event_id, \`the event's event_id \${value.event_id} is not the one recordChange committed (\${JSON.stringify(history)})\`);
}

export async function check_commit_before_produce(ctx) {
  const m = await events(ctx);
  const probe = ctx.redisAfter('model:fraud:history', () => ctx.kafka.records(TOPIC).length);
  await m.announce(change());
  await settle();
  assert(probe.fired, 'announce never committed the change (no write to model:fraud:history)');
  assert.equal(probe.result, 0, \`when the change was committed the topic already held \${probe.result} record(s): a consumer could act on a change the registry had not committed. Commit, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
}

export async function check_idempotent_acks(ctx) {
  const m = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.announce(change());
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.announce(change('fraud', 4));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record only the leader had: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_from_delivery(ctx) {
  const m = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.announce(change());
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused the delivery and the outbox holds \${rows.length} rows: the promotion never reaches the serving consumers\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'fraud' && rows[0].payload?.model === 'fraud', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key fraud and the payload\`);
  assert.equal(ok, false, \`announce resolved \${JSON.stringify(ok)} after a refused delivery, expected false\`);
  assert.equal(ctx.redis.llen('model:fraud:history'), 1, 'the change must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.announce(change('fraud', 4));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`announce waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.version === 4, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`announce resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"registry/store"

	"leetbuild/harness"
)

const (
	eventsTopic = "model.event"
	report      = "precision 0.91 on holdout-2026-10; samples: txn 88231 flagged, txn 90412 cleared"
)

var eventsBg = context.Background()

func change(name string, version int, stage string) store.Change {
	return store.Change{Name: name, Version: version, ArtifactDigest: fmt.Sprintf("sha256:%s%d", name, version), EvalID: fmt.Sprintf("e-%s-%d", name, version), Pool: "prod", Stage: stage}
}

func seedEvals() {
	for _, c := range []store.Change{change("fraud", 3, ""), change("fraud", 4, ""), change("churn", 1, "")} {
		store.AddEval(eventsBg, c.EvalID, c.Name, c.ArtifactDigest, 0.91, 0.85, report)
	}
}

func mustAnnounce(ctx *harness.Ctx, c store.Change) bool {
	ok, err := announce(eventsBg, c)
	ctx.NoError(err, "announce(%s %d) failed", c.Name, c.Version)
	return ok
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxRows(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckModelKey(ctx *harness.Ctx) {
	seedEvals()
	mustAnnounce(ctx, change("fraud", 3, "promoted"))
	mustAnnounce(ctx, change("churn", 1, "promoted"))
	mustAnnounce(ctx, change("fraud", 3, "rolled_back"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three announce calls must produce three records on model.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"fraud", "churn", "fraud"}, "the records must be keyed by the model names")
	ctx.Equal(records[0].Partition, records[2].Partition, "fraud's promotion and rollback must share a partition, or a consumer can apply the rollback first; the partitions")
}

func CheckIdsOnly(ctx *harness.Ctx) {
	seedEvals()
	mustAnnounce(ctx, change("fraud", 3, "promoted"))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one announce must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	_, hasReport := value["report"]
	ctx.Assert(!hasReport && !strings.Contains(values[0], "samples"), "the event carries the eval report into a retained topic: %s", values[0])
	fields := make([]string, 0, len(value))
	for k := range value {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"artifact_digest", "eval_id", "event_id", "model", "pool", "stage", "version"}, "the payload must carry ids only; its fields")
	ctx.Assert(value["model"] == "fraud" && value["version"] == float64(3) && value["eval_id"] == "e-fraud-3" && value["stage"] == "promoted", "the payload is %s", values[0])
	history := ctx.Redis.LRange("model:fraud:history", 0, -1)
	ctx.Assert(len(history) > 0, "the change was never committed to model:fraud:history")
	var last map[string]any
	json.Unmarshal([]byte(history[len(history)-1]), &last)
	ctx.Equal(value["event_id"], last["event_id"], "the event's event_id must be the one RecordChange committed")
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	seedEvals()
	probe := ctx.Redis.After("model:fraud:history", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	mustAnnounce(ctx, change("fraud", 3, "promoted"))
	ctx.Settle()
	ctx.Assert(probe.Fired, "announce never committed the change (no write to model:fraud:history)")
	ctx.Equal(probe.Result, 0, "when the change was committed the topic already held records: a consumer could act on a change the registry had not committed. Commit, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the commit; the records")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	seedEvals()
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	mustAnnounce(ctx, change("fraud", 3, "promoted"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	mustAnnounce(ctx, change("fraud", 4, "promoted"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxFromDelivery(ctx *harness.Ctx) {
	seedEvals()
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := mustAnnounce(ctx, change("fraud", 3, "promoted"))
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the broker refused the delivery: without an outbox row the promotion never reaches the serving consumers; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "fraud" && rows[0].Payload["model"] == "fraud", "the outbox row is %+v, expected the topic, the key fraud and the payload", rows[0])
	ctx.Equal(ok, false, "announce's result after a refused delivery")
	ctx.Equal(ctx.Redis.LLen("model:fraud:history"), 1, "the change must stay committed when only the produce failed; the history")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = mustAnnounce(ctx, change("fraud", 4, "promoted"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "announce waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["version"] == float64(4), "no delivery report within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "announce's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "model.event";
const std::string kReport = "precision 0.91 on holdout-2026-10; samples: txn 88231 flagged, txn 90412 cleared";

store::Change change(const std::string& name, long version, const std::string& stage = "promoted") {
  const std::string v = std::to_string(version);
  return store::Change{name, version, "sha256:" + name + v, "e-" + name + "-" + v, "prod", stage};
}

void seedEvals() {
  for (const auto& c : {change("fraud", 3), change("fraud", 4), change("churn", 1)}) store::addEval(c.eval_id, c.name, c.artifact_digest, 0.91, 0.85, kReport);
}

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckModelKey(harness::Ctx& ctx) {
  seedEvals();
  announce(change("fraud", 3));
  announce(change("churn", 1));
  announce(change("fraud", 3, "rolled_back"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three announce calls must produce three records on model.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"fraud", "churn", "fraud"}, "the records must be keyed by the model names");
  ctx.Equal(records[0].Partition, records[2].Partition, "fraud's promotion and rollback must share a partition, or a consumer can apply the rollback first; the partitions");
}

void CheckIdsOnly(harness::Ctx& ctx) {
  seedEvals();
  announce(change("fraud", 3));
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one announce must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(value.is_object(), "the payload must be JSON, got %s", values[0]);
  ctx.Assert(!value.contains("report") && values[0].find("samples") == std::string::npos, "the event carries the eval report into a retained topic: %s", values[0]);
  std::vector<std::string> fields;
  for (const auto& [k, v] : value.items()) fields.push_back(k);
  std::sort(fields.begin(), fields.end());
  ctx.Equal(fields, {"artifact_digest", "eval_id", "event_id", "model", "pool", "stage", "version"}, "the payload must carry ids only; its fields");
  ctx.Assert(text(value, "model") == "fraud" && value.value("version", 0L) == 3 && text(value, "eval_id") == "e-fraud-3" && text(value, "stage") == "promoted",
             "the payload is %s", values[0]);
  const auto history = ctx.Redis.LRange("model:fraud:history", 0, -1);
  ctx.Assert(!history.empty(), "the change was never committed to model:fraud:history");
  ctx.Equal(text(nlohmann::json::parse(history.back()), "event_id"), text(value, "event_id"), "the event's event_id must be the one recordChange committed");
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  seedEvals();
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("model:fraud:history", [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  announce(change("fraud", 3));
  ctx.Settle();
  ctx.Assert(fired, "announce never committed the change (no write to model:fraud:history)");
  ctx.Equal(atCommit, 0,
            "when the change was committed the topic already held records: a consumer could act on a change the registry had not committed. Commit, "
            "then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the commit; the records");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  seedEvals();
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  announce(change("fraud", 3));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  announce(change("fraud", 4));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxFromDelivery(harness::Ctx& ctx) {
  seedEvals();
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = announce(change("fraud", 3));
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused the delivery: without an outbox row the promotion never reaches the serving consumers; the rows");
  ctx.Assert(text(rows[0], "topic") == kEventsTopic && text(rows[0], "key") == "fraud" && rows[0].contains("payload") && text(rows[0]["payload"], "model") == "fraud",
             "the outbox row is %s, expected the topic, the key fraud and the payload", rows[0].dump());
  ctx.Equal(ok, false, "announce's result after a refused delivery");
  ctx.Equal(ctx.Redis.LRange("model:fraud:history", 0, -1).size(), 1, "the change must stay committed when only the produce failed; the history");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = announce(change("fraud", 4));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "announce waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && rows[1]["payload"].value("version", 0L) == 4, "no delivery report within the window and the outbox holds %d rows",
             rows.size());
  ctx.Equal(ok, false, "announce's result without a delivery report");
}
`,
  },
  hints: [
    "A consumer applies fraud's rollback before its promotion, the topic shows test-set samples months after the eval store deleted them, and after a broker hiccup one promotion never reaches serving.",
    "The key is the digest, which changes per version; the payload copies the eval report; the commit runs after the produce; and the `try` around `produce` only sees local enqueue errors, not the broker's answer.",
    "`event_id = store.record_change(change)` first; produce `key=change['name']` with the seven ids, `enable.idempotence` and `acks=all`; an `on_delivery` callback plus `flush(ACK_TIMEOUT_S)`, and on an error or a record still in flight `store.insert_outbox` and return `False`.",
  ],
  debrief: `The key is an ordering contract: Kafka orders per partition, so whatever is the key is what consumers see in order, and serving decisions are per model. Committing first means every event names a change a consumer can look up; the reverse order lets a consumer act on a change the registry then failed to write. The delivery report is where the broker answers, which is why the outbox is written from it and not from a \`try\` around an enqueue. Ids keep the topic free of the eval data whose retention someone else owns. Production registries write the outbox row in the same transaction as the change and let a relay do every produce, so the request path never waits on the broker, and they version the event schema in a registry.`,
};
