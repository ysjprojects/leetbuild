import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Dedupe events keyed by dataset, carrying digests, with an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is \`publish_outcome(record, outcome)\`, called after every claim with
\`"winner"\` or \`"existing"\`: it builds \`{"outcome", "tenant", "dataset_id", "record_id", "name",
"email", "key_hashes"}\`, produces it to \`dedupe.event\` keyed by the record id, flushes for up to
\`ACK_TIMEOUT_S\` = 2 s inside \`try\`/\`except KafkaException\`, and writes an outbox row
(\`outbox.insert\`, provided) when that raises. With a healthy broker the event arrives, and it hides
four flaws.

**Failure mode the checks target.** One dataset's events land on several partitions and its
consumer replays them out of order; a retained topic fills with customer names and emails; a lost
acknowledgement writes the event twice and a leader failover loses it; a broker that rejects or
does not acknowledge the event drops it with the call reporting success.

- The record key is the **dataset id**.
- The payload is \`{"outcome", "tenant", "dataset_id", "record_id", "key_hashes"}\`: digests and
  outcomes, no field of the record's contents.
- The producer is **idempotent** with **\`acks=all\`** (Go: confluent-kafka-go, whose producer has
  both; kafka-go has no idempotent producer).
- The delivery report decides: a failed delivery, or none within 2 s, inserts an outbox row with
  the topic, the key and the payload and returns \`False\`. \`except KafkaException\` around
  \`produce\` sees only local enqueue errors.`,
  sequence: {
    participants: ['Dedupe API', 'dedupe.event', 'Outbox', 'Event consumer'],
    messages: [
      {from: 'Dedupe API', to: 'dedupe.event', label: 'produce key = dataset_id · idempotent · acks=all', kind: 'sync'},
      {from: 'dedupe.event', to: 'Dedupe API', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'dedupe.event', to: 'Dedupe API', label: 'delivery failed · no report', kind: 'reply'},
      {from: 'Dedupe API', to: 'Outbox', label: 'insert(topic, key, payload) → False', kind: 'async'},
      {from: 'dedupe.event', to: 'Event consumer', label: 'one partition per dataset, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes the outcome to dedupe.event',
      detail: 'One call produces one record on `dedupe.event` with the outcome, the record id and the key digests.',
      match: {
        python: {all: [/dedupe\.event/, /producer\.produce\(/]},
        typescript: {all: [/dedupe\.event/, /producer\.send\(/]},
        go: {all: [/dedupe\.event/, /producer\.Produce\(/]},
        scala: {all: [/dedupe\.event/, /producer\.send\(/]},
        cpp: {all: [/dedupe\.event/, /producer->produce\(/]},
      },
    },
    {
      id: 'dataset-key',
      title: 'Keys the event by dataset id',
      detail:
        "Events for one dataset share a key and so a partition, which is the only place Kafka keeps order. The starter keys by record id and scatters a dataset's events.",
      match: {
        python: {all: [/key\s*=\s*record\[["']dataset_id["']\]/], none: [/key\s*=\s*record\[["']record_id["']\]/]},
        typescript: {all: [/key:\s*record\.dataset_id/], none: [/key:\s*record\.record_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*row\.DatasetID\s*\)/], none: [/Key:\s*\[\]byte\(\s*row\.RecordID/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(\s*Topic,\s*record\.datasetId/],
          none: [/Topic,\s*record\.recordId/],
        },
        cpp: {
          all: [/row\.dataset_id\.c_str\(\),\s*row\.dataset_id\.(size|length)\(\)/],
          none: [/row\.record_id\.c_str\(\)/],
        },
      },
    },
    {
      id: 'hashed',
      title: "Carries digests and outcomes, not the record's contents",
      detail:
        'The payload is the outcome, the ids and `key_hashes`; the topic is retained and replicated, so a name or an email written there outlives every erasure request. The starter copies `name` and `email` in.',
      match: {
        python: {all: [/key_hashes/], none: [/record\[["'](name|email)["']\]/]},
        typescript: {all: [/key_hashes/], none: [/record\.(name|email)\b/]},
        go: {all: [/key_hashes/], none: [/row\.(Name|Email)\b/]},
        scala: {all: [/key_hashes/], none: [/record\.(name|email)\b/]},
        cpp: {all: [/key_hashes/], none: [/row\.(name|email)\b/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets neither `acks=all` nor idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the delivery fails',
      detail:
        'The delivery report decides: a failed delivery, or none within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter catches only local enqueue errors and reports success.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=/], none: [/except KafkaException/]},
        typescript: {all: [/\binsert\(/, /await producer\.send\(/, /catch/], none: [/void producer\.send\(/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from dedupe import outbox  # outbox.insert(topic, key, payload)

TOPIC = "dedupe.event"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092"})


def event_payload(record: dict, outcome: str) -> dict:
    return {
        "outcome": outcome,
        "tenant": record["tenant"],
        "dataset_id": record["dataset_id"],
        "record_id": record["record_id"],
        "name": record["name"],
        "email": record["email"],
        "key_hashes": dict(sorted(record["keys"].items())),
    }


def publish_outcome(record: dict, outcome: str) -> bool:
    """Tell the dataset's consumers what a check decided about the record; True once the broker took the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = event_payload(record, outcome)
    try:
        producer.produce(TOPIC, key=record["record_id"], value=json.dumps(payload))
        producer.flush(ACK_TIMEOUT_S)
    except KafkaException:
        outbox.insert(TOPIC, record["record_id"], payload)
        return False
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from dedupe import outbox  # outbox.insert(topic, key, payload)

TOPIC = "dedupe.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(record: dict, outcome: str) -> dict:
    """What a consumer of the dataset needs: the outcome and the key digests, none of the record's contents."""
    return {
        "outcome": outcome,
        "tenant": record["tenant"],
        "dataset_id": record["dataset_id"],
        "record_id": record["record_id"],
        "key_hashes": dict(sorted(record["keys"].items())),
    }


def publish_outcome(record: dict, outcome: str) -> bool:
    """Tell the dataset's consumers what a check decided about the record; True once the broker took the event."""
    payload = event_payload(record, outcome)
    report = {}

    def on_delivery(err, msg):
        report["error"] = err

    producer.produce(TOPIC, key=record["dataset_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or report.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the event is late, not lost.
        outbox.insert(TOPIC, record["dataset_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {insert} from 'dedupe/outbox';
import type {Row} from 'dedupe/records';

export const TOPIC = 'dedupe.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'dedupd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(record: Row, outcome: string) {
  return {
    outcome,
    tenant: record.tenant,
    dataset_id: record.dataset_id,
    record_id: record.record_id,
    name: record.name,
    email: record.email,
    key_hashes: record.keys,
  };
}

/** Tell the dataset's consumers what a check decided about the record; true once the broker took the event. */
export async function publishOutcome(record: Row, outcome: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(record, outcome);
  try {
    void producer.send({topic: TOPIC, messages: [{key: record.record_id, value: JSON.stringify(payload)}], acks: 1, timeout: ACK_TIMEOUT_MS});
  } catch {
    await insert(TOPIC, record.record_id, payload);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {insert} from 'dedupe/outbox';
import type {Row} from 'dedupe/records';

export const TOPIC = 'dedupe.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'dedupd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What a consumer of the dataset needs: the outcome and the key digests, none of the record's contents. */
export function eventPayload(record: Row, outcome: string) {
  return {
    outcome,
    tenant: record.tenant,
    dataset_id: record.dataset_id,
    record_id: record.record_id,
    key_hashes: record.keys,
  };
}

/** Tell the dataset's consumers what a check decided about the record; true once the broker took the event. */
export async function publishOutcome(record: Row, outcome: string): Promise<boolean> {
  const payload = eventPayload(record, outcome);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: record.dataset_id, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the event is late, not lost.
    await insert(TOPIC, record.dataset_id, payload);
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
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"dedupe/outbox"  // outbox.Insert(ctx, topic, key, payload)
	"dedupe/records" // records.Row
)

const (
	topic      = "dedupe.event"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(row *records.Row, outcome string) map[string]any {
	return map[string]any{
		"outcome":    outcome,
		"tenant":     row.Tenant,
		"dataset_id": row.DatasetID,
		"record_id":  row.RecordID,
		"name":       row.Name,
		"email":      row.Email,
		"key_hashes": row.Keys,
	}
}

// publishOutcome tells the dataset's consumers what a check decided about the record; true once the broker took the event.
func publishOutcome(ctx context.Context, row *records.Row, outcome string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := eventPayload(row, outcome)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(row.RecordID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, outbox.Insert(ctx, topic, row.RecordID, payload)
	}
	producer.Flush(int(ackTimeout.Milliseconds()))
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"dedupe/outbox"  // outbox.Insert(ctx, topic, key, payload)
	"dedupe/records" // records.Row
)

const (
	topic      = "dedupe.event"
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

// eventPayload is what a consumer of the dataset needs: the outcome and the key digests, none of the record's contents.
func eventPayload(row *records.Row, outcome string) map[string]any {
	return map[string]any{
		"outcome":    outcome,
		"tenant":     row.Tenant,
		"dataset_id": row.DatasetID,
		"record_id":  row.RecordID,
		"key_hashes": row.Keys,
	}
}

// publishOutcome tells the dataset's consumers what a check decided about the record; true once the broker took the event.
func publishOutcome(ctx context.Context, row *records.Row, outcome string) (bool, error) {
	payload := eventPayload(row, outcome)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(row.DatasetID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the event is late, not lost.
		return false, outbox.Insert(ctx, topic, row.DatasetID, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import dedupe.{Outbox, Records} // Outbox.insert(topic, key, payload), Records.Row

object Events {
  val Topic = "dedupe.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(record: Records.Row, outcome: String): JsObject =
    JsObject(
      "outcome" -> JsString(outcome),
      "tenant" -> JsString(record.tenant),
      "dataset_id" -> JsString(record.datasetId),
      "record_id" -> JsString(record.recordId),
      "name" -> JsString(record.name),
      "email" -> JsString(record.email),
      "key_hashes" -> JsObject(record.keys.toSeq.sortBy(_._1).map { case (k, v) => k -> JsString(v) }: _*)
    )

  /** Tell the dataset's consumers what a check decided about the record; true once the broker took the event. */
  def publishOutcome(record: Records.Row, outcome: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(record, outcome)
    try {
      producer.send(new ProducerRecord[String, String](Topic, record.recordId, payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Outbox.insert(Topic, record.recordId, payload)
        false
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import dedupe.{Outbox, Records} // Outbox.insert(topic, key, payload), Records.Row

object Events {
  val Topic = "dedupe.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What a consumer of the dataset needs: the outcome and the key digests, none of the record's contents. */
  def eventPayload(record: Records.Row, outcome: String): JsObject =
    JsObject(
      "outcome" -> JsString(outcome),
      "tenant" -> JsString(record.tenant),
      "dataset_id" -> JsString(record.datasetId),
      "record_id" -> JsString(record.recordId),
      "key_hashes" -> JsObject(record.keys.toSeq.sortBy(_._1).map { case (k, v) => k -> JsString(v) }: _*)
    )

  /** Tell the dataset's consumers what a check decided about the record; true once the broker took the event. */
  def publishOutcome(record: Records.Row, outcome: String): Boolean = {
    val payload = eventPayload(record, outcome)
    val sent = new ProducerRecord[String, String](Topic, record.datasetId, payload.compactPrint)
    val acked = Try(producer.send(sent).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay publishes the row later, so the event is late, not lost.
    if (acked.isFailure) Outbox.insert(Topic, record.datasetId, payload)
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

#include "dedupe/outbox.h"   // outbox::insert(topic, key, payload)
#include "dedupe/records.h"  // records::Row

using json = nlohmann::json;

const std::string kTopic = "dedupe.event";
constexpr int kAckTimeoutMs = 2000;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const records::Row& row, const std::string& outcome) {
  return json{{"outcome", outcome},       {"tenant", row.tenant}, {"dataset_id", row.dataset_id}, {"record_id", row.record_id},
              {"name", row.name},         {"email", row.email},   {"key_hashes", row.keys}};
}

// Tell the dataset's consumers what a check decided about the record; true once the broker took the event.
bool publishOutcome(const records::Row& row, const std::string& outcome) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = eventPayload(row, outcome);
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), row.record_id.c_str(), row.record_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox::insert(kTopic, row.record_id, payload);
    return false;
  }
  producer->flush(kAckTimeoutMs);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "dedupe/outbox.h"   // outbox::insert(topic, key, payload)
#include "dedupe/records.h"  // records::Row

using json = nlohmann::json;

const std::string kTopic = "dedupe.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishOutcome produces one record and waits for it.
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

// What a consumer of the dataset needs: the outcome and the key digests, none of the record's contents.
json eventPayload(const records::Row& row, const std::string& outcome) {
  return json{{"outcome", outcome}, {"tenant", row.tenant}, {"dataset_id", row.dataset_id}, {"record_id", row.record_id}, {"key_hashes", row.keys}};
}

// Tell the dataset's consumers what a check decided about the record; true once the broker took the event.
bool publishOutcome(const records::Row& row, const std::string& outcome) {
  const json payload = eventPayload(row, outcome);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), row.dataset_id.c_str(), row.dataset_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the event is late, not lost.
    outbox::insert(kTopic, row.dataset_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "dedupe.event"
EMAIL = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d"
PHONE = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00"
FIELDS = ["dataset_id", "key_hashes", "outcome", "record_id", "tenant"]


def _record(n, dataset="ds-1"):
    return {
        "record_id": f"r-{n}",
        "tenant": "acme",
        "dataset_id": dataset,
        "name": "Jane Doe",
        "email": "jane@example.com",
        "keys": {"email_hash": EMAIL, "phone_hash": PHONE},
    }


def _text(raw):
    return raw.decode() if isinstance(raw, bytes) else raw


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_topic(ctx):
    m = ctx.load("events")
    ok = m.publish_outcome(_record(1), "winner")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_outcome produced {len(records)} records on dedupe.event (topics: {sorted(ctx.kafka.topics)})"
    value = json.loads(records[0].value)
    assert value.get("outcome") == "winner" and value.get("record_id") == "r-1", f"the event is {value}, expected outcome winner for r-1"
    assert value.get("key_hashes") == {"email_hash": EMAIL, "phone_hash": PHONE}, f"the event's key_hashes are {value.get('key_hashes')}, expected the record's key digests"
    assert ok is True, f"publish_outcome returned {ok!r} for a delivered event, expected True"


def check_dataset_key(ctx):
    m = ctx.load("events")
    m.publish_outcome(_record(1, "ds-1"), "winner")
    m.publish_outcome(_record(2, "ds-2"), "winner")
    m.publish_outcome(_record(3, "ds-1"), "existing")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_outcome calls produced {len(records)} records"
    keys = [_text(r.key) for r in records]
    assert keys == ["ds-1", "ds-2", "ds-1"], f"the records are keyed {keys}, expected the dataset ids ds-1, ds-2, ds-1"
    assert records[0].partition == records[2].partition, "both ds-1 events must land on one partition, or the dataset's consumer replays its outcomes out of order"


def check_hashed(ctx):
    m = ctx.load("events")
    m.publish_outcome(_record(1), "existing")
    raw = _text(ctx.kafka.records(TOPIC)[0].value)
    assert "Jane Doe" not in raw and "jane@example.com" not in raw, f"the event carries the record's contents: {raw}. A retained topic keeps them past every erasure request; publish digests and outcomes"
    assert sorted(json.loads(raw)) == FIELDS, f"the event's fields are {sorted(json.loads(raw))}, expected {FIELDS}"


def check_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_outcome(_record(1), "winner")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_outcome(_record(2), "winner")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_outcome(_record(1), "winner")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: the event is lost and publish_outcome returned {ok!r}"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "ds-1" and rows[0].get("payload", {}).get("record_id") == "r-1", f"the outbox row is {rows[0]}, expected the topic, the key ds-1 and the payload"
    assert ok is False, f"publish_outcome returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_outcome(_record(2), "winner")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_outcome waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("record_id") == "r-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_outcome returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'dedupe.event';
const EMAIL = '8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d';
const PHONE = '602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00';
const FIELDS = ['dataset_id', 'key_hashes', 'outcome', 'record_id', 'tenant'];

const record = (n: number, dataset = 'ds-1') => ({
  record_id: \`r-\${n}\`,
  tenant: 'acme',
  dataset_id: dataset,
  name: 'Jane Doe',
  email: 'jane@example.com',
  keys: {email_hash: EMAIL, phone_hash: PHONE},
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_topic(ctx) {
  const m = ctx.load('events');
  const ok = await m.publishOutcome(record(1), 'winner');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishOutcome produced \${values.length} records on dedupe.event\`);
  const value = JSON.parse(values[0]);
  assert(value.outcome === 'winner' && value.record_id === 'r-1', \`the event is \${values[0]}, expected outcome winner for r-1\`);
  assert.deepEqual(value.key_hashes, {email_hash: EMAIL, phone_hash: PHONE}, \`the event's key_hashes are \${JSON.stringify(value.key_hashes)}, expected the record's key digests\`);
  assert.equal(ok, true, \`publishOutcome resolved \${JSON.stringify(ok)} for a delivered event, expected true\`);
}

export async function check_dataset_key(ctx) {
  const m = ctx.load('events');
  await m.publishOutcome(record(1, 'ds-1'), 'winner');
  await m.publishOutcome(record(2, 'ds-2'), 'winner');
  await m.publishOutcome(record(3, 'ds-1'), 'existing');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishOutcome calls produced \${records.length} records\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['ds-1', 'ds-2', 'ds-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the dataset ids ds-1, ds-2, ds-1\`);
  assert.equal(records[0].partition, records[2].partition, "both ds-1 events must land on one partition, or the dataset's consumer replays its outcomes out of order");
}

export async function check_hashed(ctx) {
  const m = ctx.load('events');
  await m.publishOutcome(record(1), 'existing');
  await settle();
  const raw = ctx.kafka.values(TOPIC)[0];
  assert(!raw.includes('Jane Doe') && !raw.includes('jane@example.com'), \`the event carries the record's contents: \${raw}. A retained topic keeps them past every erasure request; publish digests and outcomes\`);
  const fields = Object.keys(JSON.parse(raw)).sort();
  assert.deepEqual(fields, FIELDS, \`the event's fields are \${JSON.stringify(fields)}, expected \${JSON.stringify(FIELDS)}\`);
}

export async function check_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishOutcome(record(1), 'winner');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishOutcome(record(2), 'winner');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishOutcome(record(1), 'winner');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: the event is lost and publishOutcome resolved \${JSON.stringify(ok)}\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'ds-1' && rows[0].payload?.record_id === 'r-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key ds-1 and the payload\`);
  assert.equal(ok, false, \`publishOutcome resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishOutcome(record(2), 'winner');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishOutcome waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.record_id === 'r-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishOutcome resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"dedupe/records"

	"leetbuild/harness"
)

const (
	eventsEmail = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d"
	eventsPhone = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00"
)

func eventsRecord(n int, dataset string) *records.Row {
	return &records.Row{
		RecordID: fmt.Sprintf("r-%d", n), Tenant: "acme", DatasetID: dataset, Name: "Jane Doe", Email: "jane@example.com",
		Keys: map[string]string{"email_hash": eventsEmail, "phone_hash": eventsPhone},
	}
}

func eventsPublish(ctx *harness.Ctx, row *records.Row, outcome string) bool {
	ok, err := publishOutcome(context.Background(), row, outcome)
	ctx.NoError(err, "publishOutcome")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
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

func CheckTopic(ctx *harness.Ctx) {
	ok := eventsPublish(ctx, eventsRecord(1, "ds-1"), "winner")
	ctx.Settle()
	values := ctx.Kafka.Values(topic)
	ctx.Equal(len(values), 1, "one publishOutcome must produce one record on dedupe.event; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the event must be JSON")
	ctx.Assert(value["outcome"] == "winner" && value["record_id"] == "r-1", "the event is %s, expected outcome winner for r-1", values[0])
	ctx.Equal(value["key_hashes"], map[string]any{"email_hash": eventsEmail, "phone_hash": eventsPhone}, "the event's key_hashes")
	ctx.Equal(ok, true, "publishOutcome's result for a delivered event")
}

func CheckDatasetKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRecord(1, "ds-1"), "winner")
	eventsPublish(ctx, eventsRecord(2, "ds-2"), "winner")
	eventsPublish(ctx, eventsRecord(3, "ds-1"), "existing")
	ctx.Settle()
	got := ctx.Kafka.Records(topic)
	ctx.Equal(len(got), 3, "three publishOutcome calls must produce three records; the records")
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"ds-1", "ds-2", "ds-1"}, "the records must be keyed by the dataset ids")
	ctx.Equal(got[0].Partition, got[2].Partition, "both ds-1 events must land on one partition, or the dataset's consumer replays its outcomes out of order; the partitions")
}

func CheckHashed(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsRecord(1, "ds-1"), "existing")
	ctx.Settle()
	raw := ctx.Kafka.Values(topic)[0]
	ctx.Assert(!strings.Contains(raw, "Jane Doe") && !strings.Contains(raw, "jane@example.com"), "the event carries the record's contents: %s. A retained topic keeps them past every erasure request; publish digests and outcomes", raw)
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(raw), &value), "the event must be JSON")
	fields := make([]string, 0, len(value))
	for k := range value {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"dataset_id", "key_hashes", "outcome", "record_id", "tenant"}, "the event's fields")
}

func CheckIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(topic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsRecord(1, "ds-1"), "winner")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsRecord(2, "ds-1"), "winner")
	ctx.Settle()
	ctx.Kafka.Failover(topic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	ok := eventsPublish(ctx, eventsRecord(1, "ds-1"), "winner")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Assert(len(rows) == 1, "the delivery failed and the outbox holds %d rows: the event is lost and publishOutcome returned %v", len(rows), ok)
	ctx.Assert(rows[0].Topic == topic && rows[0].Key == "ds-1" && rows[0].Payload["record_id"] == "r-1", "the outbox row is %v, expected the topic, the key ds-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishOutcome's result after a failed delivery")
	ctx.Kafka.Stall(topic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsRecord(2, "ds-1"), "winner")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishOutcome waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["record_id"] == "r-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishOutcome's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "dedupe/records.h"

namespace {

const std::string kEmail = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d";
const std::string kPhone = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00";

records::Row eventsRecord(int n, const std::string& dataset = "ds-1") {
  return records::Row{"r-" + std::to_string(n), "acme", dataset, "Jane Doe", "jane@example.com", {{"email_hash", kEmail}, {"phone_hash", kPhone}}};
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

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckTopic(harness::Ctx& ctx) {
  const bool ok = publishOutcome(eventsRecord(1), "winner");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one publishOutcome must produce one record on dedupe.event; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(field(value, "outcome") == "winner" && field(value, "record_id") == "r-1", "the event is %s, expected outcome winner for r-1", values[0]);
  ctx.Equal(value.is_object() && value.contains("key_hashes") ? value["key_hashes"] : nlohmann::json(),
            nlohmann::json{{"email_hash", kEmail}, {"phone_hash", kPhone}}, "the event's key_hashes");
  ctx.Equal(ok, true, "publishOutcome's result for a delivered event");
}

void CheckDatasetKey(harness::Ctx& ctx) {
  publishOutcome(eventsRecord(1, "ds-1"), "winner");
  publishOutcome(eventsRecord(2, "ds-2"), "winner");
  publishOutcome(eventsRecord(3, "ds-1"), "existing");
  ctx.Settle();
  const auto got = ctx.Kafka.Records(kTopic);
  ctx.Equal(got.size(), 3, "three publishOutcome calls must produce three records; the records");
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"ds-1", "ds-2", "ds-1"}, "the records must be keyed by the dataset ids");
  ctx.Equal(got[0].Partition, got[2].Partition, "both ds-1 events must land on one partition, or the dataset's consumer replays its outcomes out of order; the partitions");
}

void CheckHashed(harness::Ctx& ctx) {
  publishOutcome(eventsRecord(1), "existing");
  ctx.Settle();
  const std::string raw = ctx.Kafka.Values(kTopic).at(0);
  ctx.Assert(raw.find("Jane Doe") == std::string::npos && raw.find("jane@example.com") == std::string::npos,
             "the event carries the record's contents: %s. A retained topic keeps them past every erasure request; publish digests and outcomes", raw);
  const auto value = nlohmann::json::parse(raw, nullptr, false);
  std::vector<std::string> fields;
  if (value.is_object()) {
    for (const auto& [k, v] : value.items()) fields.push_back(k);
  }
  std::sort(fields.begin(), fields.end());
  ctx.Equal(fields, {"dataset_id", "key_hashes", "outcome", "record_id", "tenant"}, "the event's fields");
}

void CheckIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishOutcome(eventsRecord(1), "winner");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishOutcome(eventsRecord(2), "winner");
  ctx.Settle();
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  bool ok = publishOutcome(eventsRecord(1), "winner");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 1, "the delivery failed and the outbox holds %d rows: the event is lost and publishOutcome returned %t", rows.size(), ok);
  ctx.Assert(field(rows[0], "topic") == kTopic && field(rows[0], "key") == "ds-1" && rows[0].contains("payload") && field(rows[0]["payload"], "record_id") == "r-1",
             "the outbox row is %s, expected the topic, the key ds-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishOutcome's result after a failed delivery");
  ctx.Kafka.Stall(kTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishOutcome(eventsRecord(2), "winner");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishOutcome waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && field(rows[1]["payload"], "record_id") == "r-2",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishOutcome's result without a delivery report");
}
`,
  },
  hints: [
    'A consumer replaying one dataset sees a record\'s "existing" before its "winner"; the topic holds customer emails in clear text; and after a broker outage some outcomes did not arrive although every call returned true.',
    'Kafka orders per partition, and the key picks the partition, so a record-id key spreads a dataset over all of them. `except KafkaException` around `produce` sees only local enqueue errors: a delivery failure arrives later, in the delivery report nobody reads.',
    'Key by `record["dataset_id"]`; drop `name` and `email`; configure `acks=all` and `enable.idempotence`; pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and when the report carries an error or did not come, `outbox.insert(...)` and return `False`.',
  ],
  debrief: `The key is the ordering contract: whatever is the key is what stays in order, so a dataset id key is what lets a consumer apply one dataset's outcomes as they happened. The payload follows from retention: a topic is replicated and kept for days, so only digests and outcomes go there. The delivery report is the only place a broker says whether it took the event, so the outbox decision has to be made there; a \`try\` around \`produce\` catches a full local queue and nothing else. Idempotence closes the gap that waiting opens, a retry after a lost acknowledgement. Production services write the outbox row in the same transaction as the record and let a relay publish it, so the request does not wait on the broker.`,
};
