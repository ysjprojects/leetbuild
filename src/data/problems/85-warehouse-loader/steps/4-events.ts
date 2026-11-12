import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Load events keyed by table, completed once',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'outbox'],
  task: `## Task

**Starting point.** The starter's \`publish_partition(load, partition_id, rows_written)\` runs after
the warehouse wrote a partition: it commits it with \`progress.commit_partition\` (step 2, provided as
\`loader.progress\`), produces \`partition_committed\` to \`load.event\` keyed by the load id and, when
\`partition_id\` is the last by number, \`load_completed\`; it answers \`progress.is_complete\`. A
produce that raises goes to \`outbox.put\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A table's events scatter over partitions and a dashboard applies
them out of order; a load whose last-numbered partition commits first is announced complete with
partitions missing; a produce the broker refuses is lost, because the refusal arrives in the delivery
report; and a retry after a lost acknowledgement writes the event twice.

- The key is the **target table**.
- \`load_completed\` (\`load_id\`, \`target\`, \`partitions\`) is produced only when \`commit_partition\`
  answers True, and \`publish_partition\` answers that value.
- A refused produce goes to \`outbox.put(topic, key, value)\` from the **delivery report**
  (\`on_delivery\`, the rejected \`send\`, the returned \`WriteMessages\` error, \`dr_cb\`, a \`Callback\`).
- The producer is idempotent with \`acks=all\`. kafka-go has no idempotent producer: its writer uses
  \`RequireAll\` and consumers deduplicate by \`(load_id, partition_id)\`.`,
  sequence: {
    participants: ['Load worker', 'Redis progress', 'load.event', 'outbox'],
    messages: [
      {from: 'Load worker', to: 'Redis progress', label: 'commit_partition(ld-1, p-1, 3)', kind: 'sync'},
      {from: 'Redis progress', to: 'Load worker', label: 'True · this commit completed the load', kind: 'reply'},
      {
        from: 'Load worker',
        to: 'load.event',
        label: 'partition_committed · key wh_acme.orders · acks=all',
        kind: 'sync',
      },
      {from: 'Load worker', to: 'load.event', label: 'load_completed · key wh_acme.orders', kind: 'sync'},
      {from: 'load.event', to: 'Load worker', label: 'delivery report: refused', kind: 'reply'},
      {from: 'Load worker', to: 'outbox', label: 'outbox.put(topic, key, value)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'table-key',
      title: 'Keys load.event by the target table',
      detail:
        'Every record is keyed by the load’s target table, so one table’s events share a partition and keep their order; the starter keys by load id, and two loads of one table interleave.',
      match: {
        python: {all: [/produce\(\s*(table|load\[["']target["']\])/], none: [/produce\(\s*load\[["']load_id["']\]/]},
        typescript: {all: [/produce\(\s*(table|load\.target)\b/], none: [/produce\(\s*load\.load_id/]},
        go: {all: [/produce\(ctx,\s*(table|load\.Target)\b/], none: [/produce\(ctx,\s*load\.LoadID/]},
        scala: {all: [/produce\(\s*(table|load\.target)\b/], none: [/produce\(\s*load\.loadId/]},
        cpp: {all: [/produce\(\s*(table|load\.target)\b/], none: [/produce\(\s*load\.load_id/]},
      },
    },
    {
      id: 'complete-after-final',
      title: 'Announces completion from the commit that completed the load',
      detail:
        '`load_completed` is produced only when `commit_partition` answers true, and that answer is returned; the starter decides by the partition’s number and answers `is_complete`, so an out-of-order load is announced early and a redelivery announces it again.',
      match: {
        python: {all: [/progress\.commit_partition\(/], none: [/f["']p-\{/, /progress\.is_complete\(/]},
        typescript: {all: [/commitPartition\(/], none: [/`p-\$\{/, /isComplete\(/]},
        go: {all: [/progress\.CommitPartition\(/], none: [/"p-%d"/, /progress\.IsComplete\(/]},
        scala: {all: [/Progress\.commitPartition\(/], none: [/s"p-\$\{/, /Progress\.isComplete\(/]},
        cpp: {all: [/progress::commitPartition\(/], none: [/"p-"\s*\+/, /progress::isComplete\(/]},
      },
    },
    {
      id: 'outbox-from-delivery',
      title: 'Keeps a refused event in the outbox',
      detail:
        'A produce the broker refuses is put in the outbox where the broker answers (the delivery callback, the rejected send, the returned write error), and `publish_partition` goes on; the starter’s `try` around the enqueue never sees the refusal.',
      match: {
        python: {all: [/on_delivery\s*=/, /outbox\.put\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/\bput\(TOPIC,/]},
        go: {all: [/outbox\.Put\(/]},
        scala: {all: [/Outbox\.put\(/, /onCompletion/]},
        cpp: {all: [/dr_cb/, /outbox::put\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent with `acks=all` (`enable.idempotence` and `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes once and a leader failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from loader import outbox, progress

TOPIC = "load.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def produce(key: str, event: dict) -> None:
    value = json.dumps(event)
    try:
        producer.produce(TOPIC, key=key, value=value)
        producer.poll(0)
    except KafkaException:
        outbox.put(TOPIC, key, value)


def publish_partition(load: dict, partition_id: str, rows_written: int) -> bool:
    """Commit one written partition and announce it on load.event; True when it completed the load."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    progress.commit_partition(load["load_id"], partition_id, load["partitions"])
    produce(
        load["load_id"],
        {"type": "partition_committed", "load_id": load["load_id"], "target": load["target"], "partition_id": partition_id, "rows_written": rows_written},
    )
    if partition_id == f"p-{load['partitions'] - 1}":
        produce(load["load_id"], {"type": "load_completed", "load_id": load["load_id"], "target": load["target"], "partitions": load["partitions"]})
    return progress.is_complete(load["load_id"])
`,
      solution: `import json

from confluent_kafka import Producer

from loader import outbox, progress

TOPIC = "load.event"

# Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def produce(key: str, event: dict) -> None:
    value = json.dumps(event)

    def on_delivery(err, msg) -> None:
        if err is not None:
            outbox.put(TOPIC, key, value)  # the broker said no: the relay republishes it

    producer.produce(TOPIC, key=key, value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve the delivery reports already in


def publish_partition(load: dict, partition_id: str, rows_written: int) -> bool:
    """Commit one written partition and announce it on load.event; True when it completed the load."""
    # The commit that filled the set is the one that may announce the completion.
    completed = progress.commit_partition(load["load_id"], partition_id, load["partitions"])
    table = load["target"]  # one table, one partition, one order
    produce(table, {"type": "partition_committed", "load_id": load["load_id"], "target": table, "partition_id": partition_id, "rows_written": rows_written})
    if completed:
        produce(table, {"type": "load_completed", "load_id": load["load_id"], "target": table, "partitions": load["partitions"]})
    return completed
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {put} from 'loader/outbox';
import {commitPartition, isComplete} from 'loader/progress';
import type {Load} from 'loader/store';

export const TOPIC = 'load.event';

const kafka = new Kafka({clientId: 'loaderd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

async function produce(key: string, event: Record<string, unknown>): Promise<void> {
  await producer
    .send({topic: TOPIC, messages: [{key, value: JSON.stringify(event)}], acks: 1})
    .catch(err => console.warn(\`load.event produce failed: \${(err as Error).message}\`));
}

/** Commit one written partition and announce it on load.event; true when it completed the load. */
export async function publishPartition(load: Load, partitionId: string, rowsWritten: number): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await commitPartition(load.load_id, partitionId, load.partitions);
  await produce(load.load_id, {type: 'partition_committed', load_id: load.load_id, target: load.target, partition_id: partitionId, rows_written: rowsWritten});
  if (partitionId === \`p-\${load.partitions - 1}\`) {
    await produce(load.load_id, {type: 'load_completed', load_id: load.load_id, target: load.target, partitions: load.partitions});
  }
  return isComplete(load.load_id);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {put} from 'loader/outbox';
import {commitPartition} from 'loader/progress';
import type {Load} from 'loader/store';

export const TOPIC = 'load.event';

const kafka = new Kafka({clientId: 'loaderd', brokers: ['kafka:9092']});
// Idempotent with acks -1 (all): a retry after a lost acknowledgement writes once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

async function produce(key: string, event: Record<string, unknown>): Promise<void> {
  const value = JSON.stringify(event);
  try {
    await producer.send({topic: TOPIC, messages: [{key, value}], acks: -1});
  } catch {
    await put(TOPIC, key, value); // the broker said no: the relay republishes it
  }
}

/** Commit one written partition and announce it on load.event; true when it completed the load. */
export async function publishPartition(load: Load, partitionId: string, rowsWritten: number): Promise<boolean> {
  // The commit that filled the set is the one that may announce the completion.
  const completed = await commitPartition(load.load_id, partitionId, load.partitions);
  const table = load.target; // one table, one partition, one order
  await produce(table, {type: 'partition_committed', load_id: load.load_id, target: table, partition_id: partitionId, rows_written: rowsWritten});
  if (completed) await produce(table, {type: 'load_completed', load_id: load.load_id, target: table, partitions: load.partitions});
  return completed;
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

	"github.com/segmentio/kafka-go"

	"loader/progress" // progress.CommitPartition, progress.IsComplete
	"loader/store"    // store.Load
)

const topic = "load.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
}

func produce(ctx context.Context, key string, event map[string]any) {
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: value}); err != nil {
		log.Printf("load.event produce failed: %v", err)
	}
}

// publishPartition commits one written partition and announces it on load.event; true when it completed the load.
func publishPartition(ctx context.Context, load store.Load, partitionID string, rowsWritten int64) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if _, err := progress.CommitPartition(ctx, load.LoadID, partitionID, load.Partitions); err != nil {
		return false, err
	}
	produce(ctx, load.LoadID, map[string]any{"type": "partition_committed", "load_id": load.LoadID, "target": load.Target, "partition_id": partitionID, "rows_written": rowsWritten})
	if partitionID == fmt.Sprintf("p-%d", load.Partitions-1) {
		produce(ctx, load.LoadID, map[string]any{"type": "load_completed", "load_id": load.LoadID, "target": load.Target, "partitions": load.Partitions})
	}
	return progress.IsComplete(ctx, load.LoadID)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	"loader/outbox"   // outbox.Put(ctx, topic, key, value)
	"loader/progress" // progress.CommitPartition
	"loader/store"    // store.Load
)

const topic = "load.event"

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; consumers deduplicate by
// (load_id, partition_id).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

func produce(ctx context.Context, key string, event map[string]any) error {
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: value}); err != nil {
		return outbox.Put(ctx, topic, key, string(value)) // the broker said no: the relay republishes it
	}
	return nil
}

// publishPartition commits one written partition and announces it on load.event; true when it completed the load.
func publishPartition(ctx context.Context, load store.Load, partitionID string, rowsWritten int64) (bool, error) {
	// The commit that filled the set is the one that may announce the completion.
	completed, err := progress.CommitPartition(ctx, load.LoadID, partitionID, load.Partitions)
	if err != nil {
		return false, err
	}
	table := load.Target // one table, one partition, one order
	if err := produce(ctx, table, map[string]any{"type": "partition_committed", "load_id": load.LoadID, "target": table, "partition_id": partitionID, "rows_written": rowsWritten}); err != nil {
		return completed, err
	}
	if completed {
		return completed, produce(ctx, table, map[string]any{"type": "load_completed", "load_id": load.LoadID, "target": table, "partitions": load.Partitions})
	}
	return completed, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import loader.{Outbox, Progress, Store}

object LoadEvents {
  val Topic = "load.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def produce(key: String, event: JsObject): Unit = {
    val value = event.compactPrint
    try {
      producer.send(new ProducerRecord[String, String](Topic, key, value))
      ()
    } catch { case _: KafkaException => Outbox.put(Topic, key, value) }
  }

  /** Commit one written partition and announce it on load.event; true when it completed the load. */
  def publishPartition(load: Store.Load, partitionId: String, rowsWritten: Long): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Progress.commitPartition(load.loadId, partitionId, load.partitions)
    produce(load.loadId, JsObject("type" -> JsString("partition_committed"), "load_id" -> JsString(load.loadId), "target" -> JsString(load.target),
      "partition_id" -> JsString(partitionId), "rows_written" -> JsNumber(rowsWritten)))
    if (partitionId == s"p-\${load.partitions - 1}")
      produce(load.loadId, JsObject("type" -> JsString("load_completed"), "load_id" -> JsString(load.loadId), "target" -> JsString(load.target),
        "partitions" -> JsNumber(load.partitions)))
    Progress.isComplete(load.loadId)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import loader.{Outbox, Progress, Store}

object LoadEvents {
  val Topic = "load.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private def produce(key: String, event: JsObject): Unit = {
    val value = event.compactPrint
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) Outbox.put(Topic, key, value) // the broker said no: the relay republishes it
    }
    producer.send(new ProducerRecord[String, String](Topic, key, value), onDelivery)
    ()
  }

  /** Commit one written partition and announce it on load.event; true when it completed the load. */
  def publishPartition(load: Store.Load, partitionId: String, rowsWritten: Long): Boolean = {
    // The commit that filled the set is the one that may announce the completion.
    val completed = Progress.commitPartition(load.loadId, partitionId, load.partitions)
    val table = load.target // one table, one partition, one order
    produce(table, JsObject("type" -> JsString("partition_committed"), "load_id" -> JsString(load.loadId), "target" -> JsString(table),
      "partition_id" -> JsString(partitionId), "rows_written" -> JsNumber(rowsWritten)))
    if (completed)
      produce(table, JsObject("type" -> JsString("load_completed"), "load_id" -> JsString(load.loadId), "target" -> JsString(table),
        "partitions" -> JsNumber(load.partitions)))
    completed
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "loader/outbox.h"    // outbox::put(topic, key, value)
#include "loader/progress.h"  // progress::commitPartition, progress::isComplete
#include "loader/store.h"     // store::Load

using json = nlohmann::json;

const std::string kTopic = "load.event";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void produce(const std::string& key, const json& event) {
  const std::string value = event.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) outbox::put(kTopic, key, value);
  producer->poll(0);
}

// Commit one written partition and announce it on load.event; true when it completed the load.
bool publishPartition(const store::Load& load, const std::string& partition_id, long rows_written) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  progress::commitPartition(load.load_id, partition_id, load.partitions);
  produce(load.load_id, json{{"type", "partition_committed"}, {"load_id", load.load_id}, {"target", load.target}, {"partition_id", partition_id}, {"rows_written", rows_written}});
  if (partition_id == "p-" + std::to_string(load.partitions - 1)) {
    produce(load.load_id, json{{"type", "load_completed"}, {"load_id", load.load_id}, {"target", load.target}, {"partitions", load.partitions}});
  }
  return progress::isComplete(load.load_id);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "loader/outbox.h"    // outbox::put(topic, key, value)
#include "loader/progress.h"  // progress::commitPartition
#include "loader/store.h"     // store::Load

using json = nlohmann::json;

const std::string kTopic = "load.event";

// The delivery report: a refused record goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::put(kTopic, message.key() ? *message.key() : "", std::string(static_cast<const char*>(message.payload()), message.len()));
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void produce(const std::string& key, const json& event) {
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    key.c_str(), key.size(), 0, nullptr);
  producer->poll(0);  // serve the delivery reports already in
}

// Commit one written partition and announce it on load.event; true when it completed the load.
bool publishPartition(const store::Load& load, const std::string& partition_id, long rows_written) {
  // The commit that filled the set is the one that may announce the completion.
  const bool completed = progress::commitPartition(load.load_id, partition_id, load.partitions);
  const std::string& table = load.target;  // one table, one partition, one order
  produce(table, json{{"type", "partition_committed"}, {"load_id", load.load_id}, {"target", table}, {"partition_id", partition_id}, {"rows_written", rows_written}});
  if (completed) produce(table, json{{"type", "load_completed"}, {"load_id", load.load_id}, {"target", table}, {"partitions", load.partitions}});
  return completed;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "load.event"
LOAD = {
    "load_id": "ld-1", "tenant": "acme", "dataset": "orders", "version": "2026-10-20", "target": "wh_acme.orders", "mode": "merge",
    "transform": "dedupe", "sql": "SELECT DISTINCT * FROM source", "partitions": 3, "rows_planned": 750, "rows_read": 750, "status": "loading",
}
NEXT = {**LOAD, "load_id": "ld-2", "version": "2026-10-21", "partitions": 2}
REFUNDS = {**LOAD, "load_id": "ld-3", "dataset": "refunds", "target": "wh_acme.refunds", "partitions": 1}


def _publish(m, load, partition_id, rows=250):
    try:
        done = m.publish_partition(load, partition_id, rows)
    except Exception as exc:
        raise AssertionError(f"publish_partition({load['load_id']}, {partition_id}) raised {type(exc).__name__}: {exc}; a refused produce goes to the outbox, the worker goes on") from exc
    m.producer.poll(0)  # the worker's loop serves delivery reports between partitions
    return done


def _key(record):
    return record.key.decode() if isinstance(record.key, (bytes, bytearray)) else record.key


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _completed(ctx):
    return [e for e in _events(ctx) if e.get("type") == "load_completed"]


def check_table_key(ctx):
    m = ctx.load("events")
    _publish(m, LOAD, "p-0")
    _publish(m, NEXT, "p-0")
    _publish(m, REFUNDS, "p-0")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"three partition commits (one completing ld-3) produced {len(records)} records on {TOPIC}, expected 4"
    for record in records:
        target = json.loads(record.value).get("target")
        assert _key(record) == target, f"a record of {target} is keyed {_key(record)!r}: load.event is keyed by the target table, so one table's events stay in one partition and in order"
    orders = {r.partition for r in records if _key(r) == "wh_acme.orders"}
    assert len(orders) == 1, f"wh_acme.orders's events landed on partitions {sorted(orders)}: two loads of one table must share its partition"


def check_complete_after_final(ctx):
    m = ctx.load("events")
    assert _publish(m, LOAD, "p-2", 260) is False, "p-2 committed first: ld-1 still misses p-0 and p-1, publish_partition must answer False"
    assert _completed(ctx) == [], f"load_completed was produced when p-2, the last partition by number, committed first; p-0 and p-1 were still missing: {_completed(ctx)}"
    assert _publish(m, LOAD, "p-0", 250) is False, "with p-1 missing publish_partition must answer False"
    assert _publish(m, LOAD, "p-1", 240) is True, "the commit of p-1 completed ld-1: publish_partition must answer True"
    completed = _completed(ctx)
    assert len(completed) == 1, f"ld-1 completed once and {len(completed)} load_completed events were produced"
    want = {"type": "load_completed", "load_id": "ld-1", "target": "wh_acme.orders", "partitions": 3}
    assert all(completed[0].get(k) == v for k, v in want.items()), f"load_completed must carry {want}, got {completed[0]}"
    last = _events(ctx)[-1]
    assert last.get("type") == "load_completed", f"load_completed must follow the final partition_committed, the last event is {last}"
    committed = {e["partition_id"]: e.get("rows_written") for e in _events(ctx) if e.get("type") == "partition_committed"}
    assert committed == {"p-0": 250, "p-1": 240, "p-2": 260}, f"partition_committed must carry each partition with the rows the warehouse wrote, got {committed}"
    assert _publish(m, LOAD, "p-1", 240) is False, "a redelivered p-1 did not complete the load again: publish_partition must answer False"
    assert len(_completed(ctx)) == 1, "a redelivered final partition produced a second load_completed"


def check_outbox_from_delivery(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    _publish(m, LOAD, "p-0")
    rows = [json.loads(row) for row in ctx.redis.lrange("loader:outbox", 0, -1)]
    assert len(rows) == 1, f"the broker refused one produce and the outbox holds {len(rows)} rows: a refused event must be kept for the relay, from the delivery report"
    event = json.loads(rows[0].get("value", "null") or "null")
    assert rows[0].get("topic") == TOPIC and isinstance(event, dict) and event.get("partition_id") == "p-0", f"the outbox row must be the refused event on {TOPIC}, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    _publish(m, LOAD, "p-1")
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(ctx.redis.lrange("loader:outbox", 0, -1)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)
    _publish(m, LOAD, "p-0")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one partition_committed whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote it twice. Enable idempotence (with acks=all)"
    _publish(m, LOAD, "p-1")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'load.event';
const LOAD = {
  load_id: 'ld-1', tenant: 'acme', dataset: 'orders', version: '2026-10-20', target: 'wh_acme.orders', mode: 'merge',
  transform: 'dedupe', sql: 'SELECT DISTINCT * FROM source', partitions: 3, rows_planned: 750, rows_read: 750, status: 'loading',
};
const NEXT = {...LOAD, load_id: 'ld-2', version: '2026-10-21', partitions: 2};
const REFUNDS = {...LOAD, load_id: 'ld-3', dataset: 'refunds', target: 'wh_acme.refunds', partitions: 1};

async function publish(m, load, partitionId: string, rows = 250): Promise<boolean> {
  let done;
  try {
    done = await m.publishPartition(load, partitionId, rows);
  } catch (e) {
    assert.fail(\`publishPartition(\${load.load_id}, \${partitionId}) threw \${(e as Error).message}; a refused produce goes to the outbox, the worker goes on\`);
  }
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0); // a real macrotask: pending continuations have run
  await promise;
  return done;
}

const events = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));
const completed = ctx => events(ctx).filter(e => e.type === 'load_completed');
const outboxRows = ctx => ctx.redis.lrange('loader:outbox', 0, -1).map(row => JSON.parse(row));

export async function check_table_key(ctx) {
  const m = ctx.load('events');
  await publish(m, LOAD, 'p-0');
  await publish(m, NEXT, 'p-0');
  await publish(m, REFUNDS, 'p-0');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`three partition commits (one completing ld-3) produced \${records.length} records on \${TOPIC}, expected 4\`);
  for (const record of records) {
    const {target} = JSON.parse(record.value.toString());
    const key = record.key?.toString() ?? null;
    assert.equal(key, target, \`a record of \${target} is keyed \${JSON.stringify(key)}: load.event is keyed by the target table, so one table's events stay in one partition and in order\`);
  }
  const orders = new Set(records.filter(r => r.key?.toString() === 'wh_acme.orders').map(r => r.partition));
  assert.equal(orders.size, 1, "wh_acme.orders's events landed on more than one partition: two loads of one table must share its partition");
}

export async function check_complete_after_final(ctx) {
  const m = ctx.load('events');
  assert.equal(await publish(m, LOAD, 'p-2', 260), false, 'p-2 committed first: ld-1 still misses p-0 and p-1, publishPartition must resolve false');
  assert.deepEqual(completed(ctx), [], 'load_completed was produced when p-2, the last partition by number, committed first; p-0 and p-1 were still missing');
  assert.equal(await publish(m, LOAD, 'p-0', 250), false, 'with p-1 missing publishPartition must resolve false');
  assert.equal(await publish(m, LOAD, 'p-1', 240), true, 'the commit of p-1 completed ld-1: publishPartition must resolve true');
  const done = completed(ctx);
  assert.equal(done.length, 1, \`ld-1 completed once and \${done.length} load_completed events were produced\`);
  const want = {type: 'load_completed', load_id: 'ld-1', target: 'wh_acme.orders', partitions: 3};
  for (const [k, v] of Object.entries(want)) assert.equal(done[0][k], v, \`load_completed must carry \${JSON.stringify(want)}, got \${JSON.stringify(done[0])}\`);
  const all = events(ctx);
  assert.equal(all[all.length - 1].type, 'load_completed', 'load_completed must follow the final partition_committed');
  const committed = Object.fromEntries(all.filter(e => e.type === 'partition_committed').map(e => [e.partition_id, e.rows_written]));
  assert.deepEqual(committed, {'p-0': 250, 'p-1': 240, 'p-2': 260}, \`partition_committed must carry each partition with the rows the warehouse wrote, got \${JSON.stringify(committed)}\`);
  assert.equal(await publish(m, LOAD, 'p-1', 240), false, 'a redelivered p-1 did not complete the load again: publishPartition must resolve false');
  assert.equal(completed(ctx).length, 1, 'a redelivered final partition produced a second load_completed');
}

export async function check_outbox_from_delivery(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await publish(m, LOAD, 'p-0');
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and the outbox holds \${rows.length} rows: a refused event must be kept for the relay, from the delivery report\`);
  const event = JSON.parse(rows[0].value ?? 'null');
  assert(rows[0].topic === TOPIC && event !== null && event.partition_id === 'p-0', \`the outbox row must be the refused event on \${TOPIC}, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  await publish(m, LOAD, 'p-1');
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the refusal reaches the topic and adds no outbox row');
}

export async function check_idempotent_producer(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1);
  await publish(m, LOAD, 'p-0');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one partition_committed whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote it twice. Make the producer idempotent\`);
  await publish(m, LOAD, 'p-1');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"loader/store"

	"leetbuild/harness"
)

const eventsTopic = "load.event"

var (
	eventsBg   = context.Background()
	eventsLoad = store.Load{LoadID: "ld-1", Tenant: "acme", Dataset: "orders", Version: "2026-10-20", Target: "wh_acme.orders", Mode: "merge",
		Transform: "dedupe", SQL: "SELECT DISTINCT * FROM source", Partitions: 3, RowsPlanned: 750, RowsRead: 750, Status: "loading"}
)

func eventsVariant(loadID, target string, partitions int) store.Load {
	load := eventsLoad
	load.LoadID = loadID
	load.Target = target
	load.Partitions = partitions
	return load
}

func eventsPublish(ctx *harness.Ctx, load store.Load, partitionID string, rows int64) bool {
	done, err := publishPartition(eventsBg, load, partitionID, rows)
	ctx.NoError(err, "publishPartition(%s, %s): a refused produce goes to the outbox, the worker goes on", load.LoadID, partitionID)
	ctx.Settle()
	return done
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &e), "the event is JSON: %s", r.Value)
		out = append(out, e)
	}
	return out
}

func eventsCompleted(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, e := range eventsAll(ctx) {
		if e["type"] == "load_completed" {
			out = append(out, e)
		}
	}
	return out
}

func CheckTableKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsLoad, "p-0", 250)
	eventsPublish(ctx, eventsVariant("ld-2", "wh_acme.orders", 2), "p-0", 250)
	eventsPublish(ctx, eventsVariant("ld-3", "wh_acme.refunds", 1), "p-0", 250)
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 4, "three partition commits, one completing ld-3; the records on %s", eventsTopic)
	partitions := map[int]bool{}
	for _, r := range records {
		var e map[string]any
		json.Unmarshal(r.Value, &e)
		ctx.Equal(string(r.Key), e["target"], "load.event is keyed by the target table, so one table's events stay in one partition and in order; the key of a record of %v", e["target"])
		if string(r.Key) == "wh_acme.orders" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "two loads of wh_acme.orders must share its partition; the partitions its events landed on")
}

func CheckCompleteAfterFinal(ctx *harness.Ctx) {
	ctx.Equal(eventsPublish(ctx, eventsLoad, "p-2", 260), false, "p-2 committed first: ld-1 still misses p-0 and p-1; completed")
	ctx.Equal(len(eventsCompleted(ctx)), 0, "load_completed must not be produced when p-2, the last partition by number, commits first; load_completed events")
	ctx.Equal(eventsPublish(ctx, eventsLoad, "p-0", 250), false, "with p-1 missing; completed")
	ctx.Equal(eventsPublish(ctx, eventsLoad, "p-1", 240), true, "the commit of p-1 completed ld-1; completed")
	done := eventsCompleted(ctx)
	ctx.Equal(len(done), 1, "ld-1 completed once; load_completed events")
	ctx.Equal(done[0], map[string]any{"type": "load_completed", "load_id": "ld-1", "target": "wh_acme.orders", "partitions": 3}, "the load_completed event")
	all := eventsAll(ctx)
	ctx.Equal(all[len(all)-1]["type"], "load_completed", "load_completed must follow the final partition_committed; the last event's type")
	committed := map[string]any{}
	for _, e := range all {
		if e["type"] == "partition_committed" {
			committed[e["partition_id"].(string)] = e["rows_written"]
		}
	}
	ctx.Equal(committed, map[string]any{"p-0": 250, "p-1": 240, "p-2": 260}, "partition_committed must carry each partition with the rows the warehouse wrote")
	ctx.Equal(eventsPublish(ctx, eventsLoad, "p-1", 240), false, "a redelivered p-1 did not complete the load again; completed")
	ctx.Equal(len(eventsCompleted(ctx)), 1, "a redelivered final partition must not produce a second load_completed; load_completed events")
}

func CheckOutboxFromDelivery(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsLoad, "p-0", 250)
	rows := ctx.Redis.LRange("loader:outbox", 0, -1)
	ctx.Equal(len(rows), 1, "the broker refused one produce: a refused event must be kept for the relay; outbox rows")
	var row map[string]string
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "the outbox row is JSON: %s", rows[0])
	var event map[string]any
	json.Unmarshal([]byte(row["value"]), &event)
	ctx.Assert(row["topic"] == eventsTopic && event["partition_id"] == "p-0", "the outbox row must be the refused event on %s, got %s", eventsTopic, rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing reached the topic for the refused produce; records")
	eventsPublish(ctx, eventsLoad, "p-1", 240)
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(ctx.Redis.LRange("loader:outbox", 0, -1)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsLoad, "p-0", 250)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one partition commit; the records on the topic")
	eventsPublish(ctx, eventsLoad, "p-1", 240)
	lost := ctx.Kafka.Failover(eventsTopic)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "loader/store.h"

namespace {

const std::string kEventsTopic = "load.event";
const store::Load kLoad{"ld-1", "acme", "orders", "2026-10-20", "wh_acme.orders", "merge", "dedupe", "SELECT DISTINCT * FROM source", 3, 750, 750, "loading"};

store::Load variant(const std::string& load_id, const std::string& target, long partitions) {
  store::Load load = kLoad;
  load.load_id = load_id;
  load.target = target;
  load.partitions = partitions;
  return load;
}

bool publish(harness::Ctx& ctx, const store::Load& load, const std::string& partition_id, long rows) {
  bool done = false;
  try {
    done = publishPartition(load, partition_id, rows);
  } catch (const std::exception& e) {
    ctx.Fatalf("publishPartition(%s, %s) threw %s: a refused produce goes to the outbox, the worker goes on", load.load_id, partition_id, e.what());
  }
  ctx.Settle();
  producer->poll(0);  // the worker's loop serves delivery reports between partitions
  return done;
}

std::vector<nlohmann::json> events(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& r : ctx.Kafka.Records(kEventsTopic)) out.push_back(nlohmann::json::parse(r.Value.value_or("null"), nullptr, false));
  return out;
}

size_t completedCount(harness::Ctx& ctx) {
  size_t n = 0;
  for (const auto& e : events(ctx)) {
    if (e.is_object() && e.value("type", "") == "load_completed") n++;
  }
  return n;
}

}  // namespace

void CheckTableKey(harness::Ctx& ctx) {
  publish(ctx, kLoad, "p-0", 250);
  publish(ctx, variant("ld-2", "wh_acme.orders", 2), "p-0", 250);
  publish(ctx, variant("ld-3", "wh_acme.refunds", 1), "p-0", 250);
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 4, "three partition commits, one completing ld-3; the records on %s", kEventsTopic);
  std::set<int> partitions;
  for (const auto& r : records) {
    const auto e = nlohmann::json::parse(r.Value.value_or("null"), nullptr, false);
    const std::string target = e.is_object() ? e.value("target", "") : "";
    ctx.Equal(r.Key.value_or(""), target, "load.event is keyed by the target table, so one table's events stay in one partition and in order; the key of a record of %s", target);
    if (r.Key.value_or("") == "wh_acme.orders") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "two loads of wh_acme.orders must share its partition; the partitions its events landed on");
}

void CheckCompleteAfterFinal(harness::Ctx& ctx) {
  ctx.Equal(publish(ctx, kLoad, "p-2", 260), false, "p-2 committed first: ld-1 still misses p-0 and p-1; completed");
  ctx.Equal(completedCount(ctx), 0, "load_completed must not be produced when p-2, the last partition by number, commits first; load_completed events");
  ctx.Equal(publish(ctx, kLoad, "p-0", 250), false, "with p-1 missing; completed");
  ctx.Equal(publish(ctx, kLoad, "p-1", 240), true, "the commit of p-1 completed ld-1; completed");
  ctx.Equal(completedCount(ctx), 1, "ld-1 completed once; load_completed events");
  const auto all = events(ctx);
  ctx.Equal(all.back(), nlohmann::json({{"type", "load_completed"}, {"load_id", "ld-1"}, {"target", "wh_acme.orders"}, {"partitions", 3}}),
            "load_completed must follow the final partition_committed; the last event");
  std::map<std::string, long> committed;
  for (const auto& e : all) {
    if (e.value("type", "") == "partition_committed") committed[e.value("partition_id", "")] = e.value("rows_written", 0L);
  }
  ctx.Equal(committed, std::map<std::string, long>{{"p-0", 250}, {"p-1", 240}, {"p-2", 260}}, "partition_committed must carry each partition with the rows the warehouse wrote");
  ctx.Equal(publish(ctx, kLoad, "p-1", 240), false, "a redelivered p-1 did not complete the load again; completed");
  ctx.Equal(completedCount(ctx), 1, "a redelivered final partition must not produce a second load_completed; load_completed events");
}

void CheckOutboxFromDelivery(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  publish(ctx, kLoad, "p-0", 250);
  const auto rows = ctx.Redis.LRange("loader:outbox", 0, -1);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: a refused event must be kept for the relay, from the delivery report; outbox rows");
  const auto row = nlohmann::json::parse(rows[0], nullptr, false);
  const auto event = nlohmann::json::parse(row.is_object() ? row.value("value", "null") : "null", nullptr, false);
  ctx.Assert(row.is_object() && row.value("topic", "") == kEventsTopic && event.is_object() && event.value("partition_id", "") == "p-0",
             "the outbox row must be the refused event on %s, got %s", kEventsTopic, rows[0]);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  publish(ctx, kLoad, "p-1", 240);
  ctx.Assert(ctx.Kafka.Records(kEventsTopic).size() == 1 && ctx.Redis.LRange("loader:outbox", 0, -1).size() == 1,
             "a healthy produce after the refusal reaches the topic and adds no outbox row");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);
  publish(ctx, kLoad, "p-0", 250);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "one partition_committed whose acknowledgement was lost: the producer's retry wrote it twice. Set enable.idempotence (with acks=all); the records on the topic");
  publish(ctx, kLoad, "p-1", 240);
  const int lost = ctx.Kafka.Failover(kEventsTopic);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Commit p-2 of a three-partition load first: `load_completed` is on the topic while p-0 and p-1 are missing. Make the broker refuse one produce: the event reaches neither the topic nor the outbox.',
    'Completion is decided by the partition’s number, not by the commit that filled the set. The key is the load id, so two loads of one table land on different partitions. `produce` only enqueues; the refusal arrives later, in the delivery report nothing handles.',
    'Keep `completed = progress.commit_partition(...)` and produce `load_completed` only when it is True; key by `load["target"]`; give `produce` an `on_delivery` that calls `outbox.put` on an error; set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event announces state that already exists, so completion comes from the one place that knows: the commit that filled the set, which step 2 answers to exactly one caller. Keying by table is an ordering contract for whoever reads that table's stream, because a Kafka partition is the only place order holds. The outbox is written where the broker answers, in the delivery report; a \`try\` around \`produce\` catches only a full local queue. Idempotence with acks=all makes a retry after a lost acknowledgement write once and survive a leader failover. Production loaders run a relay that drains the outbox with the same idempotent producer, and put the load and partition ids in headers so consumers can deduplicate a replay.`,
};
