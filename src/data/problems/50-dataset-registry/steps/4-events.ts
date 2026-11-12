import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Promotion events keyed by dataset, with an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['registry', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is \`publish_promotion(dataset, version, actor)\`: it reads the record,
builds a \`dataset.promoted\` payload (\`dataset\`, \`version\`, \`content_sha256\`, \`license\`,
\`row_count\`, \`actor\`, plus the first rows as \`sample\`), produces it to \`dataset.event\` keyed by
the owner team, writes an outbox row (\`store.add_outbox\`) if the produce call raises, then calls
\`pointer.promote\` (step 2, provided) and returns \`True\`. Consumers hear about promotions; it hides
four flaws.

**Failure mode the checks target.** A dataset that changes owner splits its history across two
partitions, so consumers see its promotions out of order; dataset rows leak into a retained topic;
a consumer pins a version the pointer has not reached yet; and a delivery the broker refuses is
reported as sent and lost.

- The record key is the **dataset name**.
- The payload carries identity and outcome only: no \`sample\`, no row of the object.
- **Commit first**: \`pointer.promote\`, then produce.
- Wait for the delivery report (\`on_delivery\` with \`flush\`, at most \`DELIVERY_TIMEOUT_S\` = 5 s;
  kafkajs: the awaited \`send\`; kafka-go: the error \`WriteMessages\` returns). A failed or missing
  report writes the outbox row with the topic, the key and the payload, and returns \`False\`.`,
  sequence: {
    participants: ['registryd', 'Redis pointer', 'dataset.event', 'Outbox'],
    messages: [
      {from: 'registryd', to: 'Redis pointer', label: 'promote(dataset, version, actor)', kind: 'sync'},
      {from: 'registryd', to: 'dataset.event', label: 'produce dataset.promoted · key = dataset', kind: 'sync'},
      {from: 'dataset.event', to: 'registryd', label: 'delivery report · within 5 s → True', kind: 'reply'},
      {from: 'dataset.event', to: 'registryd', label: 'delivery failed / no report', kind: 'reply'},
      {from: 'registryd', to: 'Outbox', label: 'add_outbox(topic, dataset, payload) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-by-dataset',
      title: 'Events are keyed by the dataset name',
      detail:
        "Each record is keyed by the dataset, so one dataset's promotions share a partition and arrive in order. The starter keys by the owner team.",
      match: {
        python: {all: [/key\s*=\s*dataset\b/], none: [/key\s*=\s*record\[["']owner/]},
        typescript: {all: [/key:\s*dataset\b/], none: [/key:\s*record\.owner/]},
        go: {all: [/Key:\s*\[\]byte\(dataset\)/], none: [/\[\]byte\(record\.Owner\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*dataset\b/],
          none: [/EventTopic,\s*record\.owner/],
        },
        cpp: {all: [/dataset\.c_str\(\),\s*dataset\.size\(\)/], none: [/owner\.c_str\(\)/]},
      },
    },
    {
      id: 'no-content-sample',
      title: 'The payload carries identity, not rows',
      detail:
        'The `dataset.promoted` payload has the dataset, version, hash, license, row count and actor, and nothing read from the object. The starter ships the first rows into a retained, replicated topic.',
      match: {
        python: {all: [/dataset\.promoted/], none: [/\bsample\b/, /read_object\(/]},
        typescript: {all: [/dataset\.promoted/], none: [/\bsample\b/, /readObject\(/]},
        go: {all: [/dataset\.promoted/], none: [/\bsample\b/, /ReadObject\(/]},
        scala: {all: [/dataset\.promoted/], none: [/\bsample\b/, /readObject\(/]},
        cpp: {all: [/dataset\.promoted/], none: [/\bsample\b/, /readObject\(/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'The pointer moves before the event is produced',
      detail:
        '`pointer.promote` runs before the produce, so when a consumer reads the event the pointer already names that version. The starter produces first.',
      match: {
        python: {order: [/def publish_promotion/, /pointer\.promote\(/, /producer\.produce\(/]},
        typescript: {order: [/function publishPromotion/, /\bpromote\(/, /producer\.send\(/]},
        go: {order: [/func publishPromotion/, /pointer\.Promote\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/def publishPromotion/, /Pointer\.promote\(/, /producer\.send\(/]},
        cpp: {order: [/bool publishPromotion/, /pointer::promote\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A failed delivery lands in the outbox',
      detail:
        'The delivery report (or the awaited send, or the returned write error) decides: a failure or no report in time writes the outbox row and returns false. The starter only catches errors from enqueueing, which a broker failure never raises.',
      match: {
        python: {
          all: [/on_delivery\s*=|callback\s*=/, /producer\.flush\(/, /store\.add_outbox\(/],
          none: [/except KafkaException/],
        },
        typescript: {all: [/await producer\.send\(/, /addOutbox\(/], none: [/void producer\.send\(/]},
        go: {all: [/store\.AddOutbox\(/], none: [/log\.Printf/]},
        scala: {all: [/\.get\(\s*[^\n]*TimeUnit/, /Store\.addOutbox\(/]},
        cpp: {all: [/dr_cb/, /->flush\(/, /store::addOutbox\(/], none: [/producer->poll\(\s*0\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from registry import pointer, store

EVENT_TOPIC = "dataset.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def event_payload(record: dict, actor: str) -> dict:
    content = store.read_object(record["content_sha256"]) or ""
    return {
        "type": "dataset.promoted",
        "dataset": record["dataset"],
        "version": record["version"],
        "content_sha256": record["content_sha256"],
        "license": record["license"],
        "row_count": record["row_count"],
        "actor": actor,
        "sample": content.split("\\n")[:3],  # consumers preview the rows without a download
    }


def publish_promotion(dataset: str, version: str, actor: str) -> bool:
    """Promote a version and tell the consumers; True once the broker has the event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = store.version(dataset, version)
    if record is None:
        raise KeyError(f"{dataset}@{version} is not registered")
    payload = event_payload(record, actor)
    try:
        producer.produce(EVENT_TOPIC, key=record["owner"], value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.add_outbox(EVENT_TOPIC, record["owner"], payload)
        return False
    pointer.promote(dataset, version, actor)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from registry import pointer, store

EVENT_TOPIC = "dataset.event"
DELIVERY_TIMEOUT_S = 5

producer = Producer({"bootstrap.servers": "kafka:9092"})


def event_payload(record: dict, actor: str) -> dict:
    """Identity and outcome only: the rows stay behind the registry's access rules."""
    return {
        "type": "dataset.promoted",
        "dataset": record["dataset"],
        "version": record["version"],
        "content_sha256": record["content_sha256"],
        "license": record["license"],
        "row_count": record["row_count"],
        "actor": actor,
    }


def publish_promotion(dataset: str, version: str, actor: str) -> bool:
    """Promote a version and tell the consumers; True once the broker has the event."""
    record = store.version(dataset, version)
    if record is None:
        raise KeyError(f"{dataset}@{version} is not registered")
    # Commit first: an event may lag the pointer, it never leads it.
    pointer.promote(dataset, version, actor)
    payload = event_payload(record, actor)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(EVENT_TOPIC, key=dataset, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(DELIVERY_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: a relay produces the row later, so consumers are late, not wrong.
        store.add_outbox(EVENT_TOPIC, dataset, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {promote} from 'registry/pointer';
import {type VersionRecord, addOutbox, readObject, version as versionOf} from 'registry/store';

export const EVENT_TOPIC = 'dataset.event';

const kafka = new Kafka({clientId: 'registryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export async function eventPayload(record: VersionRecord, actor: string): Promise<Record<string, unknown>> {
  const content = (await readObject(record.content_sha256)) ?? '';
  return {
    type: 'dataset.promoted',
    dataset: record.dataset,
    version: record.version,
    content_sha256: record.content_sha256,
    license: record.license,
    row_count: record.row_count,
    actor,
    sample: content.split('\\n').slice(0, 3), // consumers preview the rows without a download
  };
}

/** Promote a version and tell the consumers; true once the broker has the event. */
export async function publishPromotion(dataset: string, version: string, actor: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const record = await versionOf(dataset, version);
  if (record === null) throw new Error(\`\${dataset}@\${version} is not registered\`);
  const payload = await eventPayload(record, actor);
  try {
    void producer.send({topic: EVENT_TOPIC, messages: [{key: record.owner, value: JSON.stringify(payload)}]});
  } catch {
    await addOutbox(EVENT_TOPIC, record.owner, payload);
    return false;
  }
  await promote(dataset, version, actor);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {promote} from 'registry/pointer';
import {type VersionRecord, addOutbox, version as versionOf} from 'registry/store';

export const EVENT_TOPIC = 'dataset.event';
export const DELIVERY_TIMEOUT_MS = 5000;

const kafka = new Kafka({clientId: 'registryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Identity and outcome only: the rows stay behind the registry's access rules. */
export function eventPayload(record: VersionRecord, actor: string): Record<string, unknown> {
  return {
    type: 'dataset.promoted',
    dataset: record.dataset,
    version: record.version,
    content_sha256: record.content_sha256,
    license: record.license,
    row_count: record.row_count,
    actor,
  };
}

/** Promote a version and tell the consumers; true once the broker has the event. */
export async function publishPromotion(dataset: string, version: string, actor: string): Promise<boolean> {
  const record = await versionOf(dataset, version);
  if (record === null) throw new Error(\`\${dataset}@\${version} is not registered\`);
  // Commit first: an event may lag the pointer, it never leads it.
  await promote(dataset, version, actor);
  const payload = eventPayload(record, actor);
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: dataset, value: JSON.stringify(payload)}], timeout: DELIVERY_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: a relay produces the row later, so consumers are late, not wrong.
    await addOutbox(EVENT_TOPIC, dataset, payload);
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
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"

	"registry/pointer" // pointer.Promote(ctx, dataset, version, actor) (string, error)
	"registry/store"   // store.Version, ReadObject, AddOutbox, VersionRecord
)

const eventTopic = "dataset.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: eventTopic, Balancer: &kafka.Hash{}, BatchTimeout: 20 * time.Millisecond}

func eventPayload(ctx context.Context, record *store.VersionRecord, actor string) map[string]any {
	content, _ := store.ReadObject(ctx, record.ContentSHA256)
	rows := strings.Split(content, "\\n")
	if len(rows) > 3 {
		rows = rows[:3]
	}
	return map[string]any{
		"type": "dataset.promoted", "dataset": record.Dataset, "version": record.Version, "content_sha256": record.ContentSHA256,
		"license": record.License, "row_count": record.RowCount, "actor": actor,
		"sample": rows, // consumers preview the rows without a download
	}
}

// publishPromotion promotes a version and tells the consumers; true once the broker has the event.
func publishPromotion(ctx context.Context, dataset, version, actor string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	record := store.Version(ctx, dataset, version)
	if record == nil {
		return false, fmt.Errorf("%s@%s is not registered", dataset, version)
	}
	value, _ := json.Marshal(eventPayload(ctx, record, actor))
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(record.Owner), Value: value}); err != nil {
		log.Printf("dataset event not delivered: %v", err) // consumers catch up on their next poll
	}
	if _, err := pointer.Promote(ctx, dataset, version, actor); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"

	"registry/pointer" // pointer.Promote(ctx, dataset, version, actor) (string, error)
	"registry/store"   // store.Version, ReadObject, AddOutbox, VersionRecord
)

const eventTopic = "dataset.event"

// WriteMessages returns once the broker answered: its error is the delivery report.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: eventTopic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll, BatchTimeout: 20 * time.Millisecond}

// eventPayload is identity and outcome only: the rows stay behind the registry's access rules.
func eventPayload(record *store.VersionRecord, actor string) map[string]any {
	return map[string]any{
		"type": "dataset.promoted", "dataset": record.Dataset, "version": record.Version, "content_sha256": record.ContentSHA256,
		"license": record.License, "row_count": record.RowCount, "actor": actor,
	}
}

// publishPromotion promotes a version and tells the consumers; true once the broker has the event.
func publishPromotion(ctx context.Context, dataset, version, actor string) (bool, error) {
	record := store.Version(ctx, dataset, version)
	if record == nil {
		return false, fmt.Errorf("%s@%s is not registered", dataset, version)
	}
	// Commit first: an event may lag the pointer, it never leads it.
	if _, err := pointer.Promote(ctx, dataset, version, actor); err != nil {
		return false, err
	}
	payload := eventPayload(record, actor)
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(dataset), Value: value}); err != nil {
		// The broker did not take it: a relay produces the row later, so consumers are late, not wrong.
		if err := store.AddOutbox(ctx, eventTopic, dataset, payload); err != nil {
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
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import registry.{Pointer, Store} // Pointer.promote, Store.version, Store.readObject, Store.addOutbox

object Events {
  val EventTopic = "dataset.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(record: Store.VersionRecord, actor: String): JsObject = {
    val rows = Store.readObject(record.contentSha256).getOrElse("").split("\\n").take(3)
    JsObject(
      "type" -> JsString("dataset.promoted"), "dataset" -> JsString(record.dataset), "version" -> JsString(record.version),
      "content_sha256" -> JsString(record.contentSha256), "license" -> JsString(record.license),
      "row_count" -> JsNumber(record.rowCount), "actor" -> JsString(actor),
      "sample" -> JsArray(rows.map(JsString(_)).toVector)) // consumers preview the rows without a download
  }

  /** Promote a version and tell the consumers; true once the broker has the event. */
  def publishPromotion(dataset: String, version: String, actor: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val record = Store.version(dataset, version).getOrElse(throw new IllegalArgumentException(s"$dataset@$version is not registered"))
    val payload = eventPayload(record, actor)
    try producer.send(new ProducerRecord[String, String](EventTopic, record.owner, payload.compactPrint))
    catch {
      case _: KafkaException =>
        Store.addOutbox(EventTopic, record.owner, payload)
        return false
    }
    Pointer.promote(dataset, version, actor)
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

import registry.{Pointer, Store} // Pointer.promote, Store.version, Store.readObject, Store.addOutbox

object Events {
  val EventTopic = "dataset.event"
  val DeliveryTimeoutMs = 5000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Identity and outcome only: the rows stay behind the registry's access rules. */
  def eventPayload(record: Store.VersionRecord, actor: String): JsObject = JsObject(
    "type" -> JsString("dataset.promoted"), "dataset" -> JsString(record.dataset), "version" -> JsString(record.version),
    "content_sha256" -> JsString(record.contentSha256), "license" -> JsString(record.license),
    "row_count" -> JsNumber(record.rowCount), "actor" -> JsString(actor))

  /** Promote a version and tell the consumers; true once the broker has the event. */
  def publishPromotion(dataset: String, version: String, actor: String): Boolean = {
    val record = Store.version(dataset, version).getOrElse(throw new IllegalArgumentException(s"$dataset@$version is not registered"))
    // Commit first: an event may lag the pointer, it never leads it.
    Pointer.promote(dataset, version, actor)
    val payload = eventPayload(record, actor)
    val acked = Try(producer.send(new ProducerRecord[String, String](EventTopic, dataset, payload.compactPrint)).get(DeliveryTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: a relay produces the row later, so consumers are late, not wrong.
    if (acked.isFailure) Store.addOutbox(EventTopic, dataset, payload)
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "registry/pointer.h"  // pointer::promote(dataset, version, actor) -> previous
#include "registry/store.h"    // store::version, readObject, addOutbox

using json = nlohmann::json;

const std::string kEventTopic = "dataset.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const store::VersionRecord& record, const std::string& actor) {
  std::istringstream content(store::readObject(record.content_sha256).value_or(""));
  std::vector<std::string> rows;
  for (std::string line; rows.size() < 3 && std::getline(content, line);) rows.push_back(line);
  return json{{"type", "dataset.promoted"}, {"dataset", record.dataset}, {"version", record.version},
              {"content_sha256", record.content_sha256}, {"license", record.license}, {"row_count", record.row_count},
              {"actor", actor}, {"sample", rows}};  // consumers preview the rows without a download
}

// Promote a version and tell the consumers; true once the broker has the event.
bool publishPromotion(const std::string& dataset, const std::string& version, const std::string& actor) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto record = store::version(dataset, version);
  if (!record) throw std::invalid_argument(dataset + "@" + version + " is not registered");
  const json payload = eventPayload(*record, actor);
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), record->owner.c_str(), record->owner.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::addOutbox(kEventTopic, record->owner, payload);
    return false;
  }
  pointer::promote(dataset, version, actor);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <stdexcept>
#include <string>

#include "registry/pointer.h"  // pointer::promote(dataset, version, actor) -> previous
#include "registry/store.h"    // store::version, readObject, addOutbox

using json = nlohmann::json;

const std::string kEventTopic = "dataset.event";
constexpr int kDeliveryTimeoutMs = 5000;

// The delivery report of the record in flight: publishPromotion produces one record and waits for it.
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
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Identity and outcome only: the rows stay behind the registry's access rules.
json eventPayload(const store::VersionRecord& record, const std::string& actor) {
  return json{{"type", "dataset.promoted"}, {"dataset", record.dataset}, {"version", record.version},
              {"content_sha256", record.content_sha256}, {"license", record.license}, {"row_count", record.row_count},
              {"actor", actor}};
}

// Promote a version and tell the consumers; true once the broker has the event.
bool publishPromotion(const std::string& dataset, const std::string& version, const std::string& actor) {
  const auto record = store::version(dataset, version);
  if (!record) throw std::invalid_argument(dataset + "@" + version + " is not registered");
  // Commit first: an event may lag the pointer, it never leads it.
  pointer::promote(dataset, version, actor);
  const json payload = eventPayload(*record, actor);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), dataset.c_str(), dataset.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kDeliveryTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: a relay produces the row later, so consumers are late, not wrong.
    store::addOutbox(kEventTopic, dataset, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from registry import pointer, store

TOPIC = "dataset.event"
ROWS = "1,review 1,pos\\n2,review 2,neg\\n3,review 3,pos\\n"


def _events(ctx):
    sha = store.put_object(ROWS)
    for dataset in ("imdb-reviews", "wiki-text"):
        for version in ("2026-01", "2026-02"):
            store.put_version({"tenant": "t1", "dataset": dataset, "version": version, "content_sha256": sha, "license": "mit", "owner": "team-lm", "size_bytes": len(ROWS), "row_count": 3, "status": "validated"})
    return ctx.load("events")


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_key_by_dataset(ctx):
    m = _events(ctx)
    for dataset, version in (("imdb-reviews", "2026-01"), ("wiki-text", "2026-01"), ("imdb-reviews", "2026-02")):
        assert m.publish_promotion(dataset, version, "alice") is True, f"promoting {dataset}@{version} with a healthy broker must return True"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three promotions produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"imdb-reviews", b"wiki-text", b"imdb-reviews"], f"the records are keyed {keys}, expected the dataset names: one dataset's promotions must share a partition to stay in order"
    assert records[0].partition == records[2].partition, "both imdb-reviews events must land on one partition"


def check_no_content_sample(ctx):
    m = _events(ctx)
    m.publish_promotion("imdb-reviews", "2026-01", "alice")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one promotion produced {len(records)} records"
    raw = records[0].value.decode()
    assert "review 1" not in raw and "sample" not in json.loads(raw), f"the event carries rows of the dataset: {raw}. The topic is retained and replicated past the dataset's access rules; carry identity, not content"
    payload = json.loads(raw)
    expected = {"type": "dataset.promoted", "dataset": "imdb-reviews", "version": "2026-01", "actor": "alice", "row_count": 3}
    for name, value in expected.items():
        assert payload.get(name) == value, f"the event's {name} is {payload.get(name)!r}, expected {value!r}"
    assert payload.get("content_sha256") == store.version("imdb-reviews", "2026-01")["content_sha256"], "the event must carry the content hash"


def check_publish_after_commit(ctx):
    m = _events(ctx)
    at_commit = ctx.redis_after("dataset:imdb-reviews:latest", lambda: len(ctx.kafka.records(TOPIC)))
    assert m.publish_promotion("imdb-reviews", "2026-01", "alice") is True, "a promotion with a healthy broker must return True"
    assert at_commit.fired, "publish_promotion never moved dataset:imdb-reviews:latest"
    assert at_commit.result == 0, f"when the pointer moved the topic already held {at_commit.result} event(s): a consumer could read the event and find latest still on the old version. Promote, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the promotion"
    assert pointer.latest("imdb-reviews") == "2026-01", f"latest is {pointer.latest('imdb-reviews')!r}"


def check_outbox(ctx):
    m = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_promotion("imdb-reviews", "2026-01", "alice")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the consumers never hear of the promotion"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "imdb-reviews" and row.get("payload", {}).get("version") == "2026-01", f"the outbox row is {row}, expected the topic, the key imdb-reviews and the payload"
    assert ok is False, f"publish_promotion returned {ok!r} after a failed delivery, expected False"
    assert pointer.latest("imdb-reviews") == "2026-01", "the promotion itself must stand when only the event failed"
    assert m.publish_promotion("imdb-reviews", "2026-02", "alice") is True, "with the broker healthy again the promotion must return True"
    assert len(_outbox(ctx)) == 1, "a delivered event must not add an outbox row"
`,
    typescript: `const TOPIC = 'dataset.event';
const ROWS = '1,review 1,pos\\n2,review 2,neg\\n3,review 3,pos\\n';

async function events(ctx) {
  const store = ctx.load('/support/registry/store.ts');
  const pointer = ctx.load('/support/registry/pointer.ts');
  const sha = await store.putObject(ROWS);
  for (const dataset of ['imdb-reviews', 'wiki-text']) {
    for (const version of ['2026-01', '2026-02']) {
      await store.putVersion({tenant: 't1', dataset, version, content_sha256: sha, license: 'mit', owner: 'team-lm', size_bytes: ROWS.length, row_count: 3, status: 'validated', report: null});
    }
  }
  return {m: ctx.load('events'), store, pointer};
}

const outbox = ctx => ctx.redis.lrange('outbox', 0, -1).map(row => JSON.parse(row));

export async function check_key_by_dataset(ctx) {
  const {m} = await events(ctx);
  for (const [dataset, version] of [['imdb-reviews', '2026-01'], ['wiki-text', '2026-01'], ['imdb-reviews', '2026-02']]) {
    assert.equal(await m.publishPromotion(dataset, version, 'alice'), true, \`promoting \${dataset}@\${version} with a healthy broker must return true\`);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three promotions produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['imdb-reviews', 'wiki-text', 'imdb-reviews'], \`the records are keyed \${JSON.stringify(keys)}, expected the dataset names: one dataset's promotions must share a partition to stay in order\`);
  assert.equal(records[0].partition, records[2].partition, 'both imdb-reviews events must land on one partition');
}

export async function check_no_content_sample(ctx) {
  const {m, store} = await events(ctx);
  await m.publishPromotion('imdb-reviews', '2026-01', 'alice');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one promotion produced \${records.length} records\`);
  const raw = records[0].value.toString();
  const payload = JSON.parse(raw);
  assert(!raw.includes('review 1') && !('sample' in payload), \`the event carries rows of the dataset: \${raw}. The topic is retained and replicated past the dataset's access rules; carry identity, not content\`);
  const expected = {type: 'dataset.promoted', dataset: 'imdb-reviews', version: '2026-01', actor: 'alice', row_count: 3};
  for (const [name, value] of Object.entries(expected)) assert.equal(payload[name], value, \`the event's \${name}\`);
  assert.equal(payload.content_sha256, (await store.version('imdb-reviews', '2026-01')).content_sha256, 'the event must carry the content hash');
}

export async function check_publish_after_commit(ctx) {
  const {m, pointer} = await events(ctx);
  const atCommit = ctx.redisAfter('dataset:imdb-reviews:latest', () => ctx.kafka.records(TOPIC).length);
  assert.equal(await m.publishPromotion('imdb-reviews', '2026-01', 'alice'), true, 'a promotion with a healthy broker must return true');
  assert(atCommit.fired, 'publishPromotion never moved dataset:imdb-reviews:latest');
  assert.equal(await atCommit.result, 0, \`when the pointer moved the topic already held \${await atCommit.result} event(s): a consumer could read the event and find latest still on the old version. Promote, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the promotion');
  assert.equal(await pointer.latest('imdb-reviews'), '2026-01', 'the latest version');
}

export async function check_outbox(ctx) {
  const {m, pointer} = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const ok = await m.publishPromotion('imdb-reviews', '2026-01', 'alice');
  const rows = outbox(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the consumers never hear of the promotion\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'imdb-reviews' && rows[0].payload?.version === '2026-01', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key imdb-reviews and the payload\`);
  assert.equal(ok, false, 'publishPromotion must return false after a failed delivery');
  assert.equal(await pointer.latest('imdb-reviews'), '2026-01', 'the promotion itself must stand when only the event failed');
  assert.equal(await m.publishPromotion('imdb-reviews', '2026-02', 'alice'), true, 'with the broker healthy again the promotion must return true');
  assert.equal(outbox(ctx).length, 1, 'a delivered event must not add an outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"registry/pointer"
	"registry/store"

	"leetbuild/harness"
)

const eventsTopic = "dataset.event"

var eventsBg = context.Background()

func eventsSetup(ctx *harness.Ctx) {
	rows := "1,review 1,pos\\n2,review 2,neg\\n3,review 3,pos\\n"
	sha := store.PutObject(eventsBg, rows)
	for _, dataset := range []string{"imdb-reviews", "wiki-text"} {
		for _, version := range []string{"2026-01", "2026-02"} {
			err := store.PutVersion(eventsBg, &store.VersionRecord{Tenant: "t1", Dataset: dataset, Version: version, ContentSHA256: sha, License: "mit", Owner: "team-lm", SizeBytes: int64(len(rows)), RowCount: 3, Status: "validated"})
			ctx.NoError(err, "seeding %s@%s", dataset, version)
		}
	}
}

func eventsPublish(ctx *harness.Ctx, dataset, version string) bool {
	ok, err := publishPromotion(eventsBg, dataset, version, "alice")
	ctx.NoError(err, "publishPromotion(%s, %s)", dataset, version)
	return ok
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, raw := range ctx.Redis.LRange("outbox", 0, -1) {
		var row map[string]any
		json.Unmarshal([]byte(raw), &row)
		rows = append(rows, row)
	}
	return rows
}

func eventsLatest(ctx *harness.Ctx) string {
	latest, err := pointer.Latest(eventsBg, "imdb-reviews")
	ctx.NoError(err, "reading the latest version")
	return latest
}

func CheckKeyByDataset(ctx *harness.Ctx) {
	eventsSetup(ctx)
	for _, pair := range [][2]string{{"imdb-reviews", "2026-01"}, {"wiki-text", "2026-01"}, {"imdb-reviews", "2026-02"}} {
		ctx.Assert(eventsPublish(ctx, pair[0], pair[1]), "promoting %s@%s with a healthy broker must return true", pair[0], pair[1])
	}
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three promotions; the records on %s", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"imdb-reviews", "wiki-text", "imdb-reviews"}, "the records must be keyed by the dataset names (one dataset's promotions must share a partition to stay in order); the keys")
	ctx.Equal(records[0].Partition, records[2].Partition, "both imdb-reviews events must land on one partition")
}

func CheckNoContentSample(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsPublish(ctx, "imdb-reviews", "2026-01")
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one promotion; the records")
	raw := string(records[0].Value)
	var payload map[string]any
	ctx.Assert(json.Unmarshal(records[0].Value, &payload) == nil, "the record's value is not JSON: %s", raw)
	_, sampled := payload["sample"]
	ctx.Assert(!strings.Contains(raw, "review 1") && !sampled, "the event carries rows of the dataset: %s. The topic is retained and replicated past the dataset's access rules; carry identity, not content", raw)
	ctx.Equal(payload["type"], "dataset.promoted", "the event's type")
	ctx.Equal(payload["dataset"], "imdb-reviews", "the event's dataset")
	ctx.Equal(payload["version"], "2026-01", "the event's version")
	ctx.Equal(payload["actor"], "alice", "the event's actor")
	ctx.Equal(payload["content_sha256"], store.Version(eventsBg, "imdb-reviews", "2026-01").ContentSHA256, "the event's content hash")
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	eventsSetup(ctx)
	atCommit := ctx.Redis.After("dataset:imdb-reviews:latest", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	ctx.Assert(eventsPublish(ctx, "imdb-reviews", "2026-01"), "a promotion with a healthy broker must return true")
	ctx.Assert(atCommit.Fired, "publishPromotion never moved dataset:imdb-reviews:latest")
	ctx.Equal(atCommit.Result, 0, "when the pointer moved the topic already held events: a consumer could read the event and find latest still on the old version. Promote, then produce; events at the commit")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the promotion; the records")
	ctx.Equal(eventsLatest(ctx), "2026-01", "the latest version")
}

func CheckOutbox(ctx *harness.Ctx) {
	eventsSetup(ctx)
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, "imdb-reviews", "2026-01")
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without a row the consumers never hear of the promotion; the outbox rows")
	payload, _ := rows[0]["payload"].(map[string]any)
	ctx.Assert(rows[0]["topic"] == eventsTopic && rows[0]["key"] == "imdb-reviews" && payload != nil && payload["version"] == "2026-01", "the outbox row is %v, expected the topic, the key imdb-reviews and the payload", rows[0])
	ctx.Equal(ok, false, "publishPromotion after a failed delivery returned")
	ctx.Equal(eventsLatest(ctx), "2026-01", "the promotion itself must stand when only the event failed; the latest")
	ctx.Assert(eventsPublish(ctx, "imdb-reviews", "2026-02"), "with the broker healthy again the promotion must return true")
	ctx.Equal(len(eventsOutbox(ctx)), 1, "a delivered event must not add an outbox row; the outbox rows")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kTopic = "dataset.event";

void setup() {
  const std::string rows = "1,review 1,pos\\n2,review 2,neg\\n3,review 3,pos\\n";
  const std::string sha = store::putObject(rows);
  for (const std::string dataset : {"imdb-reviews", "wiki-text"}) {
    for (const std::string version : {"2026-01", "2026-02"}) {
      store::VersionRecord rec;
      rec.tenant = "t1";
      rec.dataset = dataset;
      rec.version = version;
      rec.content_sha256 = sha;
      rec.license = "mit";
      rec.owner = "team-lm";
      rec.size_bytes = static_cast<long long>(rows.size());
      rec.row_count = 3;
      rec.status = "validated";
      store::putVersion(rec);
    }
  }
}

std::vector<json> outbox(harness::Ctx& ctx) {
  std::vector<json> rows;
  for (const auto& raw : ctx.Redis.LRange("outbox", 0, -1)) rows.push_back(json::parse(raw));
  return rows;
}

}  // namespace

void CheckKeyByDataset(harness::Ctx& ctx) {
  setup();
  for (const auto& [dataset, version] : std::vector<std::pair<std::string, std::string>>{{"imdb-reviews", "2026-01"}, {"wiki-text", "2026-01"}, {"imdb-reviews", "2026-02"}}) {
    ctx.Assert(publishPromotion(dataset, version, "alice"), "promoting %s@%s with a healthy broker must return true", dataset, version);
  }
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three promotions; the records on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"imdb-reviews", "wiki-text", "imdb-reviews"}, "the records must be keyed by the dataset names (one dataset's promotions must share a partition to stay in order); the keys");
  ctx.Equal(records[0].Partition, records[2].Partition, "both imdb-reviews events must land on one partition");
}

void CheckNoContentSample(harness::Ctx& ctx) {
  setup();
  publishPromotion("imdb-reviews", "2026-01", "alice");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one promotion; the records");
  const std::string raw = records[0].Value.value_or("");
  const json payload = json::parse(raw, nullptr, false);
  ctx.Assert(payload.is_object(), "the record's value is not JSON: %s", raw);
  ctx.Assert(raw.find("review 1") == std::string::npos && !payload.contains("sample"),
             "the event carries rows of the dataset: %s. The topic is retained and replicated past the dataset's access rules; carry identity, not content", raw);
  ctx.Equal(payload.value("type", ""), "dataset.promoted", "the event's type");
  ctx.Equal(payload.value("dataset", ""), "imdb-reviews", "the event's dataset");
  ctx.Equal(payload.value("version", ""), "2026-01", "the event's version");
  ctx.Equal(payload.value("actor", ""), "alice", "the event's actor");
  ctx.Equal(payload.value("content_sha256", ""), store::version("imdb-reviews", "2026-01")->content_sha256, "the event's content hash");
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  setup();
  int atCommit = -1;
  ctx.Redis.After("dataset:imdb-reviews:latest", [&] { atCommit = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  ctx.Assert(publishPromotion("imdb-reviews", "2026-01", "alice"), "a promotion with a healthy broker must return true");
  ctx.Assert(atCommit >= 0, "publishPromotion never moved dataset:imdb-reviews:latest");
  ctx.Equal(atCommit, 0, "when the pointer moved the topic already held events: a consumer could read the event and find latest still on the old version. Promote, then produce; events at the commit");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "the event must still be produced after the promotion; the records");
  ctx.Equal(pointer::latest("imdb-reviews"), "2026-01", "the latest version");
}

void CheckOutbox(harness::Ctx& ctx) {
  setup();
  ctx.Kafka.FailNext(kTopic, 1);
  const bool ok = publishPromotion("imdb-reviews", "2026-01", "alice");
  const auto rows = outbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without a row the consumers never hear of the promotion; the outbox rows");
  ctx.Assert(rows[0].value("topic", "") == kTopic && rows[0].value("key", "") == "imdb-reviews" && rows[0]["payload"].value("version", "") == "2026-01",
             "the outbox row is %s, expected the topic, the key imdb-reviews and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishPromotion after a failed delivery returned");
  ctx.Equal(pointer::latest("imdb-reviews"), "2026-01", "the promotion itself must stand when only the event failed; the latest");
  ctx.Assert(publishPromotion("imdb-reviews", "2026-02", "alice"), "with the broker healthy again the promotion must return true");
  ctx.Equal(outbox(ctx).size(), 1, "a delivered event must not add an outbox row; the outbox rows");
}
`,
  },
  hints: [
    'Make the broker refuse one delivery: the promotion returns True and nothing is kept to send again. Read the event: it carries the first rows of the file, and it arrived before `latest` moved.',
    'The key is the owner team, not the dataset; the payload reads the object for a preview; the produce runs before `promote`; and `except KafkaException` only sees enqueue errors, while a refused delivery arrives later through the delivery report.',
    'Call `pointer.promote` first, drop `sample`, produce with `key=dataset` and an `on_delivery` callback, `flush(DELIVERY_TIMEOUT_S)`, and when records are still in flight or the callback saw an error, `store.add_outbox(EVENT_TOPIC, dataset, payload)` and return False.',
  ],
  debrief: `The event follows the commit because it describes the commit: a consumer that pins on hearing \`dataset.promoted\` must find the pointer already there. Keying by dataset is what gives each dataset an order on the topic, and the payload stays at identity (hash, license, row count) because a topic is retained, replicated and read by more services than the dataset's own access list allows. The outbox exists for the case the delivery report reports: the promotion stands, and the event is late rather than lost. Production systems write the outbox row in the same transaction as the state change and let a relay produce it, use an idempotent producer so the relay can retry without duplicates, and have consumers deduplicate on (dataset, version).`,
};
