import type {Step} from '@/lib/types';

export const changeEventsStep: Step = {
  id: 'events',
  title: 'Change events keyed by row, confirmed by the broker',
  concept: 'kafka',
  file: 'events',
  focus: ['replicator', 'kafka', 'sink'],
  task: `## Task

**Starting point.** The starter is \`publish_batch(batch)\`, the \`deliver\` step 3 calls: it produces one
JSON record per change to \`cdc.change\` (\`change_event\`: lsn, table, pk, op, the row before and after,
batch_id), keyed by the batch id, with \`acks=1\`, and returns \`True\` once the records are handed to
the producer. It serves the demo and hides four flaws.

**Failure mode the checks target.** An update of one row and its later delete land on two partitions
and a sink applies them out of order; every customer's email address is copied into a retained
topic; a batch the broker refused returns \`True\`, so step 3 confirms past it; a retry after a lost
acknowledgement writes a change twice.

- Key every record by \`row_key(table, pk)\` (\`"orders:42"\`).
- Carry \`before_digest\` and \`after_digest\` (\`store.digest\` of the row text) instead of the rows.
- Wait for the delivery reports, at most \`ACK_TIMEOUT_S\` (5 s); a failed or missing report returns
  \`False\`.
- Produce with \`enable.idempotence\` and \`acks=all\` (KafkaJS \`idempotent: true\` with \`acks: -1\`; the
  Go starter uses confluent-kafka-go, which has an idempotent producer).`,
  sequence: {
    participants: ['Replicator', 'publish_batch', 'Kafka cdc.change', 'Sink'],
    messages: [
      {from: 'Replicator', to: 'publish_batch', label: 'deliver(batch 201..202)', kind: 'sync'},
      {from: 'publish_batch', to: 'Kafka cdc.change', label: 'produce key orders:42 · digests · lsn', kind: 'sync'},
      {from: 'Kafka cdc.change', to: 'publish_batch', label: 'delivery reports (acks=all)', kind: 'reply'},
      {from: 'publish_batch', to: 'Replicator', label: 'true · false on a failure or after 5 s', kind: 'reply'},
      {from: 'Kafka cdc.change', to: 'Sink', label: 'one row, one partition, LSN order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'row-key',
      title: 'Keys every change by table and primary key',
      detail:
        'Each record is keyed `row_key(table, pk)`, so every change of one row lands on one partition in LSN order; the starter keys by batch id, which spreads one row over many partitions.',
      match: {
        python: {all: [/def row_key\(/, /key\s*=\s*row_key\(/], none: [/key\s*=\s*batch\.batch_id/]},
        typescript: {all: [/rowKey\s*=|function rowKey\(/, /key:\s*rowKey\(/], none: [/key:\s*batch\.batch_id/]},
        go: {all: [/func rowKey\(/, /Key:\s*\[\]byte\(rowKey\(/], none: [/Key:\s*\[\]byte\(batch\.GetBatchId\(\)\)/]},
        scala: {
          all: [/def rowKey\(/, /ProducerRecord\[String, String\]\(Topic,\s*rowKey\(/],
          none: [/Topic,\s*batch\.batchId/],
        },
        cpp: {all: [/std::string rowKey\(/, /key\.c_str\(\)/], none: [/batch\.batch_id\(\)\.c_str\(\)/]},
      },
    },
    {
      id: 'digests',
      title: 'Carries digests of the rows, not the rows',
      detail:
        'The event has `before_digest` and `after_digest` from `store.digest` beside the LSN, table, pk and op, and no column value; the starter copies the row text, email addresses included, into the topic.',
      match: {
        python: {
          all: [/before_digest/, /after_digest/, /store\.digest\(/],
          none: [/["']before["']\s*:/, /["']after["']\s*:/],
        },
        typescript: {
          all: [/before_digest/, /after_digest/, /digest\(change\.before\)/],
          none: [/\bbefore:\s*change\.before/, /\bafter:\s*change\.after/],
        },
        go: {all: [/before_digest/, /after_digest/, /store\.Digest\(/], none: [/"before":/, /"after":/]},
        scala: {all: [/before_digest/, /after_digest/, /Store\.digest\(/], none: [/"before"\s*->/, /"after"\s*->/]},
        cpp: {all: [/before_digest/, /after_digest/, /store::digest\(/], none: [/\{"before",/, /\{"after",/]},
      },
    },
    {
      id: 'delivery-report',
      title: 'Returns true only once the broker has every record',
      detail:
        'The delivery reports are awaited for at most 5 s (`ACK_TIMEOUT_S`) and any failure, or a report still missing, returns false; the starter returns true as soon as the records are enqueued.',
      match: {
        python: {all: [/on_delivery/, /flush\(\s*ACK_TIMEOUT_S\s*\)/], none: [/except KafkaException/]},
        typescript: {all: [/await producer\.send\(/, /timeout:\s*ACK_TIMEOUT_MS/], none: [/\.catch\(/]},
        go: {all: [/Produce\([^\n]*deliveries\)/, /time\.After\(\s*ackTimeout\s*\)/]},
        scala: {all: [/\.get\([^\n]*TimeUnit\.MILLISECONDS\)/, /AckTimeoutMs/]},
        cpp: {all: [/dr_cb/, /flush\(\s*kAckTimeoutMs\s*\)/, /outq_len\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer sets `enable.idempotence` and `acks=all`, so a retry after a lost acknowledgement writes the change once and a leader failover keeps it; the starter sets `acks=1`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from cdc import store  # digest

TOPIC = "cdc.change"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def change_event(change, batch_id: str) -> dict:
    """The record a sink applies: where the change sits in the log and what it did to the row."""
    return {
        "lsn": change.lsn,
        "table": change.table,
        "pk": change.pk,
        "op": change.op,
        "before": change.before,
        "after": change.after,
        "batch_id": batch_id,
    }


def publish_batch(batch) -> bool:
    """Put every change of the batch on cdc.change; True once the broker has all of them."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for change in batch.changes:
        try:
            producer.produce(TOPIC, key=batch.batch_id, value=json.dumps(change_event(change, batch.batch_id)))
        except KafkaException:
            return False
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from cdc import store  # digest

TOPIC = "cdc.change"
ACK_TIMEOUT_S = 5

# Idempotent with acks=all: a retry after a lost acknowledgement lands once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def row_key(table: str, pk: str) -> str:
    return f"{table}:{pk}"


def change_event(change, batch_id: str) -> dict:
    """The record a sink applies: where the change sits in the log and what it did to the row."""
    return {
        "lsn": change.lsn,
        "table": change.table,
        "pk": change.pk,
        "op": change.op,
        # Digests tell a sink whether the row changed; the values stay in the source database.
        "before_digest": store.digest(change.before),
        "after_digest": store.digest(change.after),
        "batch_id": batch_id,
    }


def publish_batch(batch) -> bool:
    """Put every change of the batch on cdc.change; True once the broker has all of them."""
    failures = []

    def on_delivery(err, msg):
        if err is not None:
            failures.append(err)

    for change in batch.changes:
        # One row, one key: its changes stay on one partition, in LSN order.
        producer.produce(TOPIC, key=row_key(change.table, change.pk), value=json.dumps(change_event(change, batch.batch_id)), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves every delivery report, or gives up after the window
    return in_flight == 0 and not failures
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {digest} from 'cdc/store';

export const TOPIC = 'cdc.change';

/** One committed row change; int64 fields arrive as decimal strings. */
export interface Change {
  lsn: string;
  table: string;
  pk: string;
  op: string;
  before: string;
  after: string;
}

export interface Batch {
  batch_id: string;
  first_lsn: string;
  last_lsn: string;
  changes: Change[];
}

const kafka = new Kafka({clientId: 'cdcd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** The record a sink applies: where the change sits in the log and what it did to the row. */
export function changeEvent(change: Change, batchId: string): Record<string, unknown> {
  return {
    lsn: Number(change.lsn),
    table: change.table,
    pk: change.pk,
    op: change.op,
    before: change.before,
    after: change.after,
    batch_id: batchId,
  };
}

/** Put every change of the batch on cdc.change; true once the broker has all of them. */
export async function publishBatch(batch: Batch): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const messages = batch.changes.map(change => ({key: batch.batch_id, value: JSON.stringify(changeEvent(change, batch.batch_id))}));
  producer.send({topic: TOPIC, messages, acks: 1}).catch(err => console.warn('cdc.change not delivered', err));
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {digest} from 'cdc/store';

export const TOPIC = 'cdc.change';
export const ACK_TIMEOUT_MS = 5000;

/** One committed row change; int64 fields arrive as decimal strings. */
export interface Change {
  lsn: string;
  table: string;
  pk: string;
  op: string;
  before: string;
  after: string;
}

export interface Batch {
  batch_id: string;
  first_lsn: string;
  last_lsn: string;
  changes: Change[];
}

const kafka = new Kafka({clientId: 'cdcd', brokers: ['kafka:9092']});
// Idempotent (it needs acks: -1, all): a retry after a lost acknowledgement lands once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const rowKey = (table: string, pk: string): string => \`\${table}:\${pk}\`;

/** The record a sink applies: where the change sits in the log and what it did to the row. */
export function changeEvent(change: Change, batchId: string): Record<string, unknown> {
  return {
    lsn: Number(change.lsn),
    table: change.table,
    pk: change.pk,
    op: change.op,
    // Digests tell a sink whether the row changed; the values stay in the source database.
    before_digest: digest(change.before),
    after_digest: digest(change.after),
    batch_id: batchId,
  };
}

/** Put every change of the batch on cdc.change; true once the broker has all of them. */
export async function publishBatch(batch: Batch): Promise<boolean> {
  // One row, one key: its changes stay on one partition, in LSN order.
  const messages = batch.changes.map(change => ({key: rowKey(change.table, change.pk), value: JSON.stringify(changeEvent(change, batch.batch_id))}));
  try {
    await producer.send({topic: TOPIC, messages, acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    return false; // a failed or missing acknowledgement: step 3 leaves the cursor and reads the batch again
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	pb "cdc/gen/cdc_streamer"
)

const topic = "cdc.change"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// changeEvent is the record a sink applies: where the change sits in the log and what it did to the row.
func changeEvent(c *pb.Change, batchID string) map[string]any {
	return map[string]any{
		"lsn": c.GetLsn(), "table": c.GetTable(), "pk": c.GetPk(), "op": c.GetOp(),
		"before": c.GetBefore(), "after": c.GetAfter(), "batch_id": batchID,
	}
}

// publishBatch puts every change of the batch on cdc.change; true once the broker has all of them.
func publishBatch(batch *pb.Batch) bool {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for _, c := range batch.GetChanges() {
		value, _ := json.Marshal(changeEvent(c, batch.GetBatchId()))
		t := topic
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(batch.GetBatchId()), Value: value}
		if err := producer.Produce(msg, nil); err != nil {
			return false
		}
	}
	return true
}
`,
      solution: `package main

import (
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	pb "cdc/gen/cdc_streamer"
	"cdc/store" // store.Digest
)

const (
	topic      = "cdc.change"
	ackTimeout = 5 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a retry after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

func rowKey(table, pk string) string { return table + ":" + pk }

// changeEvent is the record a sink applies: where the change sits in the log and what it did to the row.
func changeEvent(c *pb.Change, batchID string) map[string]any {
	return map[string]any{
		"lsn": c.GetLsn(), "table": c.GetTable(), "pk": c.GetPk(), "op": c.GetOp(),
		// Digests tell a sink whether the row changed; the values stay in the source database.
		"before_digest": store.Digest(c.GetBefore()), "after_digest": store.Digest(c.GetAfter()), "batch_id": batchID,
	}
}

// publishBatch puts every change of the batch on cdc.change; true once the broker has all of them.
func publishBatch(batch *pb.Batch) bool {
	deliveries := make(chan kafka.Event, len(batch.GetChanges()))
	for _, c := range batch.GetChanges() {
		value, _ := json.Marshal(changeEvent(c, batch.GetBatchId()))
		t := topic
		// One row, one key: its changes stay on one partition, in LSN order.
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(rowKey(c.GetTable(), c.GetPk())), Value: value}
		if err := producer.Produce(msg, deliveries); err != nil {
			return false
		}
	}
	window := time.After(ackTimeout)
	for range batch.GetChanges() {
		select {
		case e := <-deliveries:
			if m, ok := e.(*kafka.Message); !ok || m.TopicPartition.Error != nil {
				return false
			}
		case <-window:
			return false // no acknowledgement within the window
		}
	}
	return true
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import cdcstream.cdc_streamer.{Batch, Change}

object ChangeEvents {
  val Topic = "cdc.change"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** The record a sink applies: where the change sits in the log and what it did to the row. */
  def changeEvent(change: Change, batchId: String): JsObject = JsObject(
    "lsn" -> JsNumber(change.lsn), "table" -> JsString(change.table), "pk" -> JsString(change.pk), "op" -> JsString(change.op),
    "before" -> JsString(change.before), "after" -> JsString(change.after), "batch_id" -> JsString(batchId))

  /** Put every change of the batch on cdc.change; true once the broker has all of them. */
  def publishBatch(batch: Batch): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    batch.changes.foreach { change =>
      producer.send(new ProducerRecord[String, String](Topic, batch.batchId, changeEvent(change, batch.batchId).compactPrint))
    }
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

import cdc.Store
import cdcstream.cdc_streamer.{Batch, Change}

object ChangeEvents {
  val Topic = "cdc.change"
  val AckTimeoutMs = 5000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a retry after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def rowKey(table: String, pk: String): String = s"$table:$pk"

  /** The record a sink applies: where the change sits in the log and what it did to the row. */
  def changeEvent(change: Change, batchId: String): JsObject = JsObject(
    "lsn" -> JsNumber(change.lsn), "table" -> JsString(change.table), "pk" -> JsString(change.pk), "op" -> JsString(change.op),
    // Digests tell a sink whether the row changed; the values stay in the source database.
    "before_digest" -> JsString(Store.digest(change.before)), "after_digest" -> JsString(Store.digest(change.after)),
    "batch_id" -> JsString(batchId))

  /** Put every change of the batch on cdc.change; true once the broker has all of them. */
  def publishBatch(batch: Batch): Boolean = {
    // One row, one key: its changes stay on one partition, in LSN order.
    val sends = batch.changes.map { change =>
      producer.send(new ProducerRecord[String, String](Topic, rowKey(change.table, change.pk), changeEvent(change, batch.batchId).compactPrint))
    }
    val deadline = System.currentTimeMillis() + AckTimeoutMs
    sends.forall(send => Try(send.get(math.max(0L, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS)).isSuccess)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "cdc/store.h"  // store::digest
#include "cdc_streamer.grpc.pb.h"

using json = nlohmann::json;

const std::string kTopic = "cdc.change";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// The record a sink applies: where the change sits in the log and what it did to the row.
json changeEvent(const cdcstream::Change& c, const std::string& batch_id) {
  return json{{"lsn", c.lsn()},       {"table", c.table()}, {"pk", c.pk()},           {"op", c.op()},
              {"before", c.before()}, {"after", c.after()}, {"batch_id", batch_id}};
}

// Put every change of the batch on cdc.change; true once the broker has all of them.
bool publishBatch(const cdcstream::Batch& batch) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const auto& change : batch.changes()) {
    const std::string value = changeEvent(change, batch.batch_id()).dump();
    const RdKafka::ErrorCode err =
        producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                          value.size(), batch.batch_id().c_str(), batch.batch_id().size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) return false;
  }
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "cdc/store.h"  // store::digest
#include "cdc_streamer.grpc.pb.h"

using json = nlohmann::json;

const std::string kTopic = "cdc.change";
constexpr int kAckTimeoutMs = 5000;

// Counts the failed delivery reports of the batch in flight.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  int failed = 0;
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) failed++;
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a retry after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::string rowKey(const std::string& table, const std::string& pk) { return table + ":" + pk; }

// The record a sink applies: where the change sits in the log and what it did to the row.
json changeEvent(const cdcstream::Change& c, const std::string& batch_id) {
  // Digests tell a sink whether the row changed; the values stay in the source database.
  return json{{"lsn", c.lsn()},
              {"table", c.table()},
              {"pk", c.pk()},
              {"op", c.op()},
              {"before_digest", store::digest(c.before())},
              {"after_digest", store::digest(c.after())},
              {"batch_id", batch_id}};
}

// Put every change of the batch on cdc.change; true once the broker has all of them.
bool publishBatch(const cdcstream::Batch& batch) {
  delivery.failed = 0;
  for (const auto& change : batch.changes()) {
    const std::string value = changeEvent(change, batch.batch_id()).dump();
    // One row, one key: its changes stay on one partition, in LSN order.
    const std::string key = rowKey(change.table(), change.pk());
    const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                     const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) return false;
  }
  producer->flush(kAckTimeoutMs);  // serves every delivery report, or gives up after the window
  return producer->outq_len() == 0 && delivery.failed == 0;
}
`,
    },
  },
  harness: {
    python: `import json

import cdc_streamer_pb2 as pb
from cdc import store

TOPIC = "cdc.change"
ADA_BEFORE = '{"id":9,"name":"Ada","email":"ada@example.com","country":"FR"}'
ADA_AFTER = '{"id":9,"name":"Ada","email":"ada@example.org","country":"FR"}'
LIN = '{"id":10,"name":"Lin","email":"lin@example.com","country":"SG"}'
ORDER_42 = ("orders", "42", "update", '{"id":42,"status":"new"}', '{"id":42,"status":"paid"}')
ORDER_7 = ("orders", "7", "insert", "", '{"id":7,"status":"new"}')
ORDER_42_GONE = ("orders", "42", "delete", '{"id":42,"status":"paid"}', "")


def _batch(first_lsn, changes):
    out = [pb.Change(lsn=first_lsn + i, table=t, pk=pk, op=op, before=b, after=a) for i, (t, pk, op, b, a) in enumerate(changes)]
    return pb.Batch(batch_id=f"cdc_sub_1@{first_lsn}", first_lsn=first_lsn, last_lsn=first_lsn + len(out) - 1, changes=out)


def check_row_key(ctx):
    m = ctx.load("events")
    assert m.publish_batch(_batch(201, [ORDER_42, ORDER_7])) is True, "a batch the broker took must return True"
    assert m.publish_batch(_batch(203, [ORDER_42_GONE])) is True, "a batch the broker took must return True"
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"orders:42", b"orders:7", b"orders:42"], f"the records are keyed {keys}, expected table:pk (orders:42, orders:7, orders:42)"
    assert records[0].partition == records[2].partition, "the update and the delete of order 42 sit on two partitions: a sink can apply the delete first"


def check_digests(ctx):
    m = ctx.load("events")
    m.publish_batch(_batch(301, [("customers", "9", "update", ADA_BEFORE, ADA_AFTER), ("customers", "10", "insert", "", LIN)]))
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 2, f"a batch of two changes produced {len(values)} records"
    text = values[0].decode()
    assert "example.com" not in text and "example.org" not in text, f"the event carries the row's values: {text}. A retained, replicated topic now holds every email address"
    event = json.loads(text)
    assert event.get("before_digest") == store.digest(ADA_BEFORE) and event.get("after_digest") == store.digest(ADA_AFTER), f"the event is {event}, expected before_digest and after_digest = store.digest of the row text"
    want = {"lsn": 301, "table": "customers", "pk": "9", "op": "update", "batch_id": "cdc_sub_1@301"}
    assert all(event.get(k) == v for k, v in want.items()), f"the event is {event}, expected {want} beside the digests"
    insert = json.loads(values[1])
    assert insert.get("before_digest") == "" and insert.get("after_digest") == store.digest(LIN), f"an insert has no row before it: expected before_digest \\"\\", got {insert}"


def check_delivery_report(ctx):
    m = ctx.load("events")
    assert m.publish_batch(_batch(201, [ORDER_42])) is True, "a batch the broker took must return True"
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_batch(_batch(202, [ORDER_7, ORDER_42_GONE]))
    assert ok is False, f"the broker failed a record of the batch and publish_batch returned {ok!r}: step 3 confirms the cursor past a change no sink will see"
    ctx.kafka.stall(TOPIC)
    before = ctx.clock.time()
    ok = m.publish_batch(_batch(204, [ORDER_7]))
    waited = ctx.clock.time() - before
    assert ok is False, f"with the broker not answering publish_batch returned {ok!r}, expected False"
    assert waited <= 10, f"publish_batch waited {waited:.0f} s for a broker that does not answer: wait at most ACK_TIMEOUT_S"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_batch(_batch(201, [ORDER_42]))
    count = len(ctx.kafka.records(TOPIC))
    assert count == 1, f"after one lost acknowledgement the topic holds {count} records: the producer's retry wrote the change twice. Enable idempotence"
    m.publish_batch(_batch(202, [ORDER_7]))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    count = len(ctx.kafka.records(TOPIC))
    assert count == 2, f"a leader failover left {count} records: a change the leader alone had acknowledged is gone. acks=all waits for every in-sync replica"
`,
    typescript: `const TOPIC = 'cdc.change';
const ADA_BEFORE = '{"id":9,"name":"Ada","email":"ada@example.com","country":"FR"}';
const ADA_AFTER = '{"id":9,"name":"Ada","email":"ada@example.org","country":"FR"}';
const LIN = '{"id":10,"name":"Lin","email":"lin@example.com","country":"SG"}';
const ORDER_42 = ['orders', '42', 'update', '{"id":42,"status":"new"}', '{"id":42,"status":"paid"}'];
const ORDER_7 = ['orders', '7', 'insert', '', '{"id":7,"status":"new"}'];
const ORDER_42_GONE = ['orders', '42', 'delete', '{"id":42,"status":"paid"}', ''];

/** A batch as step 3 hands it over: int64 fields as decimal strings. */
function batch(firstLsn: number, changes: string[][]) {
  return {
    batch_id: \`cdc_sub_1@\${firstLsn}\`,
    first_lsn: String(firstLsn),
    last_lsn: String(firstLsn + changes.length - 1),
    changes: changes.map(([table, pk, op, before, after], i) => ({lsn: String(firstLsn + i), table, pk, op, before, after})),
  };
}

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_row_key(ctx) {
  const m = ctx.load('events');
  assert.equal(await m.publishBatch(batch(201, [ORDER_42, ORDER_7])), true, 'a batch the broker took must resolve true');
  assert.equal(await m.publishBatch(batch(203, [ORDER_42_GONE])), true, 'a batch the broker took must resolve true');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepStrictEqual(keys, ['orders:42', 'orders:7', 'orders:42'], \`the records are keyed \${JSON.stringify(keys)}, expected table:pk (orders:42, orders:7, orders:42)\`);
  assert.equal(records[0].partition, records[2].partition, 'the update and the delete of order 42 sit on two partitions: a sink can apply the delete first');
}

export async function check_digests(ctx) {
  const m = ctx.load('events');
  const {digest} = ctx.load('/support/cdc/store.ts');
  await m.publishBatch(batch(301, [['customers', '9', 'update', ADA_BEFORE, ADA_AFTER], ['customers', '10', 'insert', '', LIN]]));
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 2, \`a batch of two changes produced \${values.length} records\`);
  assert(!values[0].includes('example.com') && !values[0].includes('example.org'), \`the event carries the row's values: \${values[0]}. A retained, replicated topic now holds every email address\`);
  const event = JSON.parse(values[0]);
  assert(event.before_digest === digest(ADA_BEFORE) && event.after_digest === digest(ADA_AFTER), \`the event is \${values[0]}, expected before_digest and after_digest = digest of the row text\`);
  const want = {lsn: 301, table: 'customers', pk: '9', op: 'update', batch_id: 'cdc_sub_1@301'};
  for (const [k, v] of Object.entries(want)) assert.equal(event[k], v, \`the event is \${values[0]}, expected \${JSON.stringify(want)} beside the digests\`);
  const insert = JSON.parse(values[1]);
  assert(insert.before_digest === '' && insert.after_digest === digest(LIN), \`an insert has no row before it: expected before_digest "", got \${values[1]}\`);
}

export async function check_delivery_report(ctx) {
  const m = ctx.load('events');
  assert.equal(await m.publishBatch(batch(201, [ORDER_42])), true, 'a batch the broker took must resolve true');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishBatch(batch(202, [ORDER_7, ORDER_42_GONE]));
  await settle();
  assert.equal(ok, false, \`the broker failed a record of the batch and publishBatch resolved \${ok}: step 3 confirms the cursor past a change no sink will see\`);
  ctx.kafka.stall(TOPIC);
  const before = ctx.clock.now();
  ok = await m.publishBatch(batch(204, [ORDER_7]));
  const waited = (ctx.clock.now() - before) / 1000;
  assert.equal(ok, false, \`with the broker not answering publishBatch resolved \${ok}, expected false\`);
  assert(waited <= 10, \`publishBatch waited \${waited.toFixed(0)} s for a broker that does not answer: wait at most ACK_TIMEOUT_MS\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishBatch(batch(201, [ORDER_42]));
  await settle();
  let count = ctx.kafka.records(TOPIC).length;
  assert.equal(count, 1, \`after one lost acknowledgement the topic holds \${count} records: the producer's retry wrote the change twice. Enable idempotence\`);
  await m.publishBatch(batch(202, [ORDER_7]));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  count = ctx.kafka.records(TOPIC).length;
  assert.equal(count, 2, \`a leader failover left \${count} records: a change the leader alone had acknowledged is gone. acks: -1 (all) waits for every in-sync replica\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"fmt"
	"strings"

	pb "cdc/gen/cdc_streamer"
	"cdc/store"

	"leetbuild/harness"
)

const (
	eventsTopic = "cdc.change"
	adaBefore   = \`{"id":9,"name":"Ada","email":"ada@example.com","country":"FR"}\`
	adaAfter    = \`{"id":9,"name":"Ada","email":"ada@example.org","country":"FR"}\`
	lin         = \`{"id":10,"name":"Lin","email":"lin@example.com","country":"SG"}\`
)

var (
	order42     = []string{"orders", "42", "update", \`{"id":42,"status":"new"}\`, \`{"id":42,"status":"paid"}\`}
	order7      = []string{"orders", "7", "insert", "", \`{"id":7,"status":"new"}\`}
	order42Gone = []string{"orders", "42", "delete", \`{"id":42,"status":"paid"}\`, ""}
)

func batchOf(firstLsn int64, changes ...[]string) *pb.Batch {
	b := &pb.Batch{BatchId: fmt.Sprintf("cdc_sub_1@%d", firstLsn), FirstLsn: firstLsn, LastLsn: firstLsn + int64(len(changes)) - 1}
	for i, c := range changes {
		b.Changes = append(b.Changes, &pb.Change{Lsn: firstLsn + int64(i), Table: c[0], Pk: c[1], Op: c[2], Before: c[3], After: c[4]})
	}
	return b
}

func CheckRowKey(ctx *harness.Ctx) {
	ctx.Equal(publishBatch(batchOf(201, order42, order7)), true, "a batch the broker took must return true; publishBatch")
	ctx.Equal(publishBatch(batchOf(203, order42Gone)), true, "a batch the broker took must return true; publishBatch")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"orders:42", "orders:7", "orders:42"}, "the records must be keyed table:pk; the keys")
	ctx.Equal(records[0].Partition, records[2].Partition, "the update and the delete of order 42 must sit on one partition, or a sink can apply the delete first; the partitions")
}

func CheckDigests(ctx *harness.Ctx) {
	publishBatch(batchOf(301, []string{"customers", "9", "update", adaBefore, adaAfter}, []string{"customers", "10", "insert", "", lin}))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 2, "a batch of two changes; the records")
	ctx.Assert(!strings.Contains(values[0], "example.com") && !strings.Contains(values[0], "example.org"), "the event carries the row's values: %s. A retained, replicated topic now holds every email address", values[0])
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	ctx.Assert(event["before_digest"] == store.Digest(adaBefore) && event["after_digest"] == store.Digest(adaAfter), "the event is %s, expected before_digest and after_digest = store.Digest of the row text", values[0])
	ctx.Assert(event["lsn"] == float64(301) && event["table"] == "customers" && event["pk"] == "9" && event["op"] == "update" && event["batch_id"] == "cdc_sub_1@301",
		"the event is %s, expected lsn 301, table customers, pk 9, op update and batch_id cdc_sub_1@301 beside the digests", values[0])
	var insert map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[1]), &insert), "the event must be JSON")
	ctx.Assert(insert["before_digest"] == "" && insert["after_digest"] == store.Digest(lin), "an insert has no row before it: expected before_digest \\"\\", got %s", values[1])
}

func CheckDeliveryReport(ctx *harness.Ctx) {
	ctx.Equal(publishBatch(batchOf(201, order42)), true, "a batch the broker took must return true; publishBatch")
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := publishBatch(batchOf(202, order7, order42Gone))
	ctx.Settle()
	ctx.Equal(ok, false, "the broker failed a record of the batch: returning true makes step 3 confirm the cursor past a change no sink will see; publishBatch")
	ctx.Kafka.Stall(eventsTopic)
	before := ctx.Clock.Now()
	ok = publishBatch(batchOf(204, order7))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Equal(ok, false, "with the broker not answering; publishBatch")
	ctx.Assert(waited <= 10, "publishBatch waited %.0f s for a broker that does not answer: wait at most ackTimeout", waited)
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	publishBatch(batchOf(201, order42))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the change twice (enable.idempotence); the records")
	publishBatch(batchOf(202, order7))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a change (acks=all waits for every in-sync replica); the records")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include "cdc/store.h"
#include "cdc_streamer.grpc.pb.h"

namespace {

using Row = std::array<std::string, 5>;

const std::string kEventsTopic = "cdc.change";
const std::string kAdaBefore = R"({"id":9,"name":"Ada","email":"ada@example.com","country":"FR"})";
const std::string kAdaAfter = R"({"id":9,"name":"Ada","email":"ada@example.org","country":"FR"})";
const std::string kLin = R"({"id":10,"name":"Lin","email":"lin@example.com","country":"SG"})";
const Row kOrder42 = {"orders", "42", "update", R"({"id":42,"status":"new"})", R"({"id":42,"status":"paid"})"};
const Row kOrder7 = {"orders", "7", "insert", "", R"({"id":7,"status":"new"})"};
const Row kOrder42Gone = {"orders", "42", "delete", R"({"id":42,"status":"paid"})", ""};

cdcstream::Batch batchOf(int64_t first_lsn, const std::vector<Row>& changes) {
  cdcstream::Batch b;
  b.set_batch_id("cdc_sub_1@" + std::to_string(first_lsn));
  b.set_first_lsn(first_lsn);
  b.set_last_lsn(first_lsn + static_cast<int64_t>(changes.size()) - 1);
  for (size_t i = 0; i < changes.size(); i++) {
    cdcstream::Change* c = b.add_changes();
    c->set_lsn(first_lsn + static_cast<int64_t>(i));
    c->set_table(changes[i][0]);
    c->set_pk(changes[i][1]);
    c->set_op(changes[i][2]);
    c->set_before(changes[i][3]);
    c->set_after(changes[i][4]);
  }
  return b;
}

nlohmann::json parse(harness::Ctx& ctx, const std::string& text) {
  const auto event = nlohmann::json::parse(text, nullptr, false);
  ctx.Assert(event.is_object(), "the event must be a JSON object, got %s", text);
  return event;
}

}  // namespace

void CheckRowKey(harness::Ctx& ctx) {
  ctx.Equal(publishBatch(batchOf(201, {kOrder42, kOrder7})), true, "a batch the broker took must return true; publishBatch");
  ctx.Equal(publishBatch(batchOf(203, {kOrder42Gone})), true, "a batch the broker took must return true; publishBatch");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"orders:42", "orders:7", "orders:42"}, "the records must be keyed table:pk; the keys");
  ctx.Equal(records.at(0).Partition, records.at(2).Partition,
            "the update and the delete of order 42 must sit on one partition, or a sink can apply the delete first; the partitions");
}

void CheckDigests(harness::Ctx& ctx) {
  publishBatch(batchOf(301, {{"customers", "9", "update", kAdaBefore, kAdaAfter}, {"customers", "10", "insert", "", kLin}}));
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 2, "a batch of two changes; the records");
  ctx.Assert(values[0].find("example.com") == std::string::npos && values[0].find("example.org") == std::string::npos,
             "the event carries the row's values: %s. A retained, replicated topic now holds every email address", values[0]);
  const auto event = parse(ctx, values[0]);
  ctx.Assert(event.value("before_digest", "") == store::digest(kAdaBefore) && event.value("after_digest", "") == store::digest(kAdaAfter),
             "the event is %s, expected before_digest and after_digest = store::digest of the row text", values[0]);
  ctx.Assert(event.value("lsn", 0L) == 301 && event.value("table", "") == "customers" && event.value("pk", "") == "9" && event.value("op", "") == "update" &&
                 event.value("batch_id", "") == "cdc_sub_1@301",
             "the event is %s, expected lsn 301, table customers, pk 9, op update and batch_id cdc_sub_1@301 beside the digests", values[0]);
  const auto insert = parse(ctx, values[1]);
  ctx.Assert(insert.contains("before_digest") && insert.value("before_digest", "x").empty() && insert.value("after_digest", "") == store::digest(kLin),
             "an insert has no row before it: expected before_digest \\"\\", got %s", values[1]);
}

void CheckDeliveryReport(harness::Ctx& ctx) {
  ctx.Equal(publishBatch(batchOf(201, {kOrder42})), true, "a batch the broker took must return true; publishBatch");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishBatch(batchOf(202, {kOrder7, kOrder42Gone}));
  ctx.Settle();
  ctx.Equal(ok, false, "the broker failed a record of the batch: returning true makes step 3 confirm the cursor past a change no sink will see; publishBatch");
  ctx.Kafka.Stall(kEventsTopic);
  const int64_t before = ctx.Clock.Now();
  ok = publishBatch(batchOf(204, {kOrder7}));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Equal(ok, false, "with the broker not answering; publishBatch");
  ctx.Assert(waited <= 10, "publishBatch waited %.0f s for a broker that does not answer: wait at most kAckTimeoutMs", waited);
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishBatch(batchOf(201, {kOrder42}));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the change twice (enable.idempotence); the records");
  publishBatch(batchOf(202, {kOrder7}));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a change (acks=all waits for every in-sync replica); the records");
}
`,
  },
  hints: [
    'Publish an update of order 42, then its delete in the next batch: the two records sit on different partitions. Read any customers record: the email address is in it. Fail the broker: publish_batch still returns True.',
    'The key is the batch id, so one row spreads over as many partitions as it has batches; the payload copies the row text; `produce` only enqueues, the try catches nothing a broker reports, and nothing reads the delivery reports.',
    'Key by `row_key(change.table, change.pk)`, send `store.digest(before)` and `store.digest(after)`, collect errors in `on_delivery`, `flush(ACK_TIMEOUT_S)` and return `in_flight == 0 and not failures`; set `acks=all` with `enable.idempotence`.',
  ],
  debrief: `The return value is the contract with step 3: true promises the broker has every record, so it can only come from delivery reports, never from an enqueue. The key decides what stays ordered, and the order a sink needs is per row, so the key is the row. Digests let a sink tell whether a row changed and fetch it through its own access path, while the topic, retained and replicated, holds nothing a deletion request would have to chase. Idempotence closes the gap that waiting opens: a retry after a lost acknowledgement lands once. Debezium ships full before and after images by default and leaves masking to message transforms; pipelines that need the images often keep them on a restricted topic and publish digests or projections for everyone else.`,
};
