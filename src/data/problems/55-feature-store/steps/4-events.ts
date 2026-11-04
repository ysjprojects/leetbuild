import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Lineage events keyed by feature, after the commit',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'db'],
  task: `## Task

**Starting point.** The starter is \`materialize(name, version, partition, rows)\`, which the backfill
calls for every scanned partition: it produces a \`feature.event\`
\`{"feature", "version", "partition", "rows"}\` keyed by the partition id, then feeds every row to
\`stats.observe\`, writes the non-null ones with \`online.write_value\` (step 2, provided) and commits
the partition with \`registry.commit_partition\`. Backfill a partition and its event shows up; it
hides five flaws.

**Failure mode the checks target.** One feature's lineage lands on several partitions and a
consumer reads it out of order; the event announces a partition before it is committed; its row
count includes rows that were never written; a leader failover loses an acknowledged event; a
broker outage drops it.

- The record key is the **feature name**.
- \`rows\` (in the event and in \`commit_partition\`) counts the rows \`write_value\` stored: a null is
  not written, and an older row loses to the stored value.
- **Commit first**: \`commit_partition\`, then produce.
- The producer uses **\`acks=all\`** (kafkajs \`acks: -1\`, kafka-go \`RequireAll\`).
- Wait for the delivery report, at most \`ACK_TIMEOUT_S\` = 2 s; on an error or no answer,
  \`outbox.insert(TOPIC, name, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Backfill worker', 'Online store', 'Registry', 'feature.event', 'Outbox'],
    messages: [
      {from: 'Backfill worker', to: 'Online store', label: 'write_value per non-null row → stored?', kind: 'sync'},
      {
        from: 'Backfill worker',
        to: 'Registry',
        label: 'commit_partition(amount_7d, 2, 2026-10-01, written)',
        kind: 'sync',
      },
      {from: 'Backfill worker', to: 'feature.event', label: 'produce key = amount_7d · acks=all', kind: 'sync'},
      {from: 'feature.event', to: 'Backfill worker', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'feature.event', to: 'Backfill worker', label: 'error / no answer', kind: 'reply'},
      {from: 'Backfill worker', to: 'Outbox', label: 'insert(topic, key, payload) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'feature-key',
      title: 'Keys feature.event by the feature name',
      detail:
        'Events for amount_7d, clicks_1h, amount_7d carry those keys and the two amount_7d events share a partition. The starter keys by partition id, which spreads one feature over the topic.',
      match: {
        python: {all: [/key\s*=\s*name\b/], none: [/key\s*=\s*partition\b/]},
        typescript: {all: [/key:\s*name\b/], none: [/key:\s*partition\b/]},
        go: {all: [/Key:\s*\[\]byte\(name\)/], none: [/Key:\s*\[\]byte\(partition\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*name\b/], none: [/Topic,\s*partition\b/]},
        cpp: {all: [/name\.c_str\(\),\s*name\.size\(\)/], none: [/partition\.c_str\(\)/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Commits the partition before producing its event',
      detail:
        'When the partition is committed (`partitions:{name}:{version}` written) the topic still holds no event for it: the event follows the commit. The starter produces first.',
      match: {
        python: {order: [/registry\.commit_partition\(/, /producer\.produce\(/]},
        typescript: {order: [/registry\.commitPartition\(/, /producer\.send\(/]},
        go: {order: [/registry\.CommitPartition\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/Registry\.commitPartition\(/, /producer\.send\(/]},
        cpp: {order: [/registry::commitPartition\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'rows-written',
      title: 'Counts the rows actually written',
      detail:
        "`rows` in the event and in the commit is the number of rows `write_value` stored: a null row and a row older than the stored value are not counted. The starter reports the scan's row count.",
      match: {
        python: {all: [/written\s*\+=\s*1/, /["']rows["']\s*:\s*written/], none: [/len\(rows\)/]},
        typescript: {all: [/written\s*\+=\s*1|written\+\+/, /rows:\s*written/], none: [/rows\.length/]},
        go: {all: [/written\+\+/, /"rows":\s*written/], none: [/len\(rows\)/]},
        scala: {all: [/written\s*\+=\s*1/, /"rows"\s*->\s*JsNumber\(written\)/], none: [/rows\.size|rows\.length/]},
        cpp: {all: [/written\+\+|\+\+written/, /\{"rows",\s*written\}/], none: [/rows\.size\(\)/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Produces with acks=all',
      detail:
        'A leader that fails over right after acknowledging keeps the event, because every in-sync replica had it. The starter sets `acks=1`.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/acks:\s*-1/], none: [/acks:\s*1\b/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A delivery the broker refuses leaves an outbox row with the topic, the key and the payload, `materialize` returns false, and the partition stays committed. The starter logs the refusal and returns true.',
      match: {
        python: {
          all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outbox\.insert\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /err\s*:?=\s*writer\.WriteMessages\(/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from features import online, registry, stats

TOPIC = "feature.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("lineage event not delivered: %s", err)


def materialize(name: str, version: int, partition: str, rows: list[dict]) -> bool:
    """Write a scanned partition to the online store, commit it and publish its lineage event; True once the broker has it."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {"feature": name, "version": version, "partition": partition, "rows": len(rows)}
    producer.produce(TOPIC, key=partition, value=json.dumps(payload), on_delivery=on_delivery)
    producer.poll(0)
    for row in rows:
        stats.observe(name, version, row["value"], row["event_ts"])
        if row["value"] is not None:
            online.write_value(name, version, row["entity"], row["value"], row["event_ts"])
    registry.commit_partition(name, version, partition, len(rows))
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from features import online, outbox, registry, stats

TOPIC = "feature.event"
ACK_TIMEOUT_S = 2

# acks=all: every in-sync replica has the event before the broker answers.
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def materialize(name: str, version: int, partition: str, rows: list[dict]) -> bool:
    """Write a scanned partition to the online store, commit it and publish its lineage event; True once the broker has it."""
    written = 0
    for row in rows:
        stats.observe(name, version, row["value"], row["event_ts"])
        # A null is not a value, and an older row loses to the stored one: neither is written.
        if row["value"] is not None and online.write_value(name, version, row["entity"], row["value"], row["event_ts"]):
            written += 1
    registry.commit_partition(name, version, partition, written)
    # The partition is committed: the event describes state that exists.
    payload = {"feature": name, "version": version, "partition": partition, "rows": written}
    outcome = {}

    def on_delivery(err, msg) -> None:
        outcome["error"] = err

    producer.produce(TOPIC, key=name, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so lineage is late, not lost.
        outbox.insert(TOPIC, name, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as online from 'features/online';
import * as registry from 'features/registry';
import * as stats from 'features/stats';

export const TOPIC = 'feature.event';

const kafka = new Kafka({clientId: 'featured', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Write a scanned partition to the online store, commit it and publish its lineage event; true once the broker has it. */
export async function materialize(name: string, version: number, partition: string, rows: online.Row[]): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {feature: name, version, partition, rows: rows.length};
  await producer
    .send({topic: TOPIC, messages: [{key: partition, value: JSON.stringify(payload)}], acks: 1})
    .catch((err: Error) => console.warn(\`lineage event not delivered: \${err.message}\`));
  for (const row of rows) {
    await stats.observe(name, version, row.value, row.event_ts);
    if (row.value !== null) await online.writeValue(name, version, row.entity, row.value, row.event_ts);
  }
  await registry.commitPartition(name, version, partition, rows.length);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as online from 'features/online';
import * as outbox from 'features/outbox';
import * as registry from 'features/registry';
import * as stats from 'features/stats';

export const TOPIC = 'feature.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'featured', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Write a scanned partition to the online store, commit it and publish its lineage event; true once the broker has it. */
export async function materialize(name: string, version: number, partition: string, rows: online.Row[]): Promise<boolean> {
  let written = 0;
  for (const row of rows) {
    await stats.observe(name, version, row.value, row.event_ts);
    // A null is not a value, and an older row loses to the stored one: neither is written.
    if (row.value !== null && (await online.writeValue(name, version, row.entity, row.value, row.event_ts))) written += 1;
  }
  await registry.commitPartition(name, version, partition, written);
  // The partition is committed: the event describes state that exists.
  const payload = {feature: name, version, partition, rows: written};
  try {
    // acks: -1 (all): every in-sync replica has the event before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: name, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so lineage is late, not lost.
    await outbox.insert(TOPIC, name, payload);
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
	"log"

	"github.com/segmentio/kafka-go"

	"features/online"
	"features/registry"
	"features/stats"
)

const topic = "feature.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
}

// materialize writes a scanned partition to the online store, commits it and publishes its lineage
// event; true once the broker has it.
func materialize(ctx context.Context, name string, version int, partition string, rows []online.Row) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{"feature": name, "version": version, "partition": partition, "rows": len(rows)}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(partition), Value: value}); err != nil {
		log.Printf("lineage event not delivered: %v", err)
	}
	for _, row := range rows {
		if err := stats.Observe(ctx, name, version, row.Value, row.EventTs); err != nil {
			return false, err
		}
		if row.Value != nil {
			if _, err := online.WriteValue(ctx, name, version, row.Entity, *row.Value, row.EventTs); err != nil {
				return false, err
			}
		}
	}
	return true, registry.CommitPartition(ctx, name, version, partition, len(rows))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	"features/online"
	"features/outbox"
	"features/registry"
	"features/stats"
)

const topic = "feature.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll, // every in-sync replica has the event before the write returns
}

// materialize writes a scanned partition to the online store, commits it and publishes its lineage
// event; true once the broker has it.
func materialize(ctx context.Context, name string, version int, partition string, rows []online.Row) (bool, error) {
	written := 0
	for _, row := range rows {
		if err := stats.Observe(ctx, name, version, row.Value, row.EventTs); err != nil {
			return false, err
		}
		// A null is not a value, and an older row loses to the stored one: neither is written.
		if row.Value == nil {
			continue
		}
		stored, err := online.WriteValue(ctx, name, version, row.Entity, *row.Value, row.EventTs)
		if err != nil {
			return false, err
		}
		if stored {
			written++
		}
	}
	if err := registry.CommitPartition(ctx, name, version, partition, written); err != nil {
		return false, err
	}
	// The partition is committed: the event describes state that exists.
	payload := map[string]any{"feature": name, "version": version, "partition": partition, "rows": written}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(name), Value: value}); err != nil {
		// The broker did not take it: the relay produces the row later, so lineage is late, not lost.
		if err := outbox.Insert(ctx, topic, name, payload); err != nil {
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

import features.{Online, Registry, Stats}

object Events {
  val Topic = "feature.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Write a scanned partition to the online store, commit it and publish its lineage event; true once the broker has it. */
  def materialize(name: String, version: Long, partition: String, rows: Seq[Online.Row]): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = JsObject("feature" -> JsString(name), "version" -> JsNumber(version), "partition" -> JsString(partition), "rows" -> JsNumber(rows.size))
    producer.send(new ProducerRecord[String, String](Topic, partition, payload.compactPrint))
    rows.foreach { row =>
      Stats.observe(name, version, row.value, row.eventTs)
      row.value.foreach(v => Online.writeValue(name, version, row.entity, v, row.eventTs))
    }
    Registry.commitPartition(name, version, partition, rows.size.toLong)
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

import features.{Online, Outbox, Registry, Stats}

object Events {
  val Topic = "feature.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Write a scanned partition to the online store, commit it and publish its lineage event; true once the broker has it. */
  def materialize(name: String, version: Long, partition: String, rows: Seq[Online.Row]): Boolean = {
    var written = 0L
    rows.foreach { row =>
      Stats.observe(name, version, row.value, row.eventTs)
      // A null is not a value, and an older row loses to the stored one: neither is written.
      if (row.value.exists(v => Online.writeValue(name, version, row.entity, v, row.eventTs))) written += 1
    }
    Registry.commitPartition(name, version, partition, written)
    // The partition is committed: the event describes state that exists.
    val payload = JsObject("feature" -> JsString(name), "version" -> JsNumber(version), "partition" -> JsString(partition), "rows" -> JsNumber(written))
    val acked = Try(producer.send(new ProducerRecord[String, String](Topic, name, payload.compactPrint)).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay produces the row later, so lineage is late, not lost.
    if (acked.isFailure) Outbox.insert(Topic, name, payload)
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
#include <vector>

#include "features/online.h"
#include "features/registry.h"
#include "features/stats.h"

using json = nlohmann::json;

const std::string kTopic = "feature.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Write a scanned partition to the online store, commit it and publish its lineage event; true once the broker has it.
bool materialize(const std::string& name, long version, const std::string& partition, const std::vector<online::Row>& rows) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json payload = {{"feature", name}, {"version", version}, {"partition", partition}, {"rows", static_cast<long>(rows.size())}};
  const std::string value = payload.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    partition.c_str(), partition.size(), 0, nullptr);
  producer->poll(0);
  for (const auto& row : rows) {
    stats::observe(name, version, row.value, row.event_ts);
    if (row.value) online::writeValue(name, version, row.entity, *row.value, row.event_ts);
  }
  registry::commitPartition(name, version, partition, static_cast<long>(rows.size()));
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "features/online.h"
#include "features/outbox.h"
#include "features/registry.h"
#include "features/stats.h"

using json = nlohmann::json;

const std::string kTopic = "feature.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: materialize produces one record and waits for it.
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
  conf->set("acks", "all", err);  // every in-sync replica has the event before the broker answers
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Write a scanned partition to the online store, commit it and publish its lineage event; true once the broker has it.
bool materialize(const std::string& name, long version, const std::string& partition, const std::vector<online::Row>& rows) {
  long written = 0;
  for (const auto& row : rows) {
    stats::observe(name, version, row.value, row.event_ts);
    // A null is not a value, and an older row loses to the stored one: neither is written.
    if (row.value && online::writeValue(name, version, row.entity, *row.value, row.event_ts)) written++;
  }
  registry::commitPartition(name, version, partition, written);
  // The partition is committed: the event describes state that exists.
  const json payload = {{"feature", name}, {"version", version}, {"partition", partition}, {"rows", written}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), name.c_str(), name.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so lineage is late, not lost.
    outbox::insert(kTopic, name, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json
import time

from features import online, registry

TOPIC = "feature.event"


def _events(ctx):
    now = int(time.time())
    for name in ("amount_7d", "clicks_1h"):
        registry.create_definition({"name": name, "version": 2, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 3600, "created_at": now})
    return ctx.load("events"), now


def _rows(now, prefix, n=2):
    return [{"entity": f"{prefix}/e-{i}", "value": float(i), "event_ts": now - 60} for i in range(1, n + 1)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_feature_key(ctx):
    m, now = _events(ctx)
    m.materialize("amount_7d", 2, "2026-10-01", _rows(now, "a1"))
    m.materialize("clicks_1h", 2, "2026-10-01", _rows(now, "c1"))
    m.materialize("amount_7d", 2, "2026-10-02", _rows(now, "a2"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three partitions materialized produced {len(records)} records on feature.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"amount_7d", b"clicks_1h", b"amount_7d"], f"the records are keyed {keys}, expected the feature names amount_7d, clicks_1h, amount_7d"
    assert records[0].partition == records[2].partition, "both amount_7d events must land on one partition, or a consumer reads one feature's lineage out of order"


def check_publish_after_commit(ctx):
    m, now = _events(ctx)
    probe = ctx.redis_after("partitions:amount_7d:2", lambda: len(ctx.kafka.records(TOPIC)))
    m.materialize("amount_7d", 2, "2026-10-01", _rows(now, "a1"))
    assert probe.fired, "materialize never committed the partition (no write to partitions:amount_7d:2)"
    assert probe.result == 0, f"when the partition was committed the topic already held {probe.result} event(s): a consumer can learn about a partition that does not exist yet. Commit first, then produce"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"the event must still be produced after the commit; the topic holds {len(records)}"
    payload = json.loads(records[0].value)
    assert payload.get("feature") == "amount_7d" and payload.get("version") == 2 and payload.get("partition") == "2026-10-01", f"the event is {payload}, expected feature, version and partition"


def check_rows_written(ctx):
    m, now = _events(ctx)
    # The streaming path already wrote a newer value of e-2; e-3 has no value.
    online.write_value("amount_7d", 2, "a1/e-2", 7.0, now - 5)
    rows = [
        {"entity": "a1/e-1", "value": 1.0, "event_ts": now - 60},
        {"entity": "a1/e-2", "value": 2.0, "event_ts": now - 60},
        {"entity": "a1/e-3", "value": None, "event_ts": now - 60},
    ]
    m.materialize("amount_7d", 2, "2026-10-01", rows)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one partition materialized produced {len(records)} records"
    payload = json.loads(records[0].value)
    assert payload.get("rows") == 1, f"the event reports {payload.get('rows')} rows; one was written (e-2 lost to a newer stored value, e-3 is null). Count what write_value stored"
    committed = registry.committed_partitions("amount_7d", 2)
    assert committed == {"2026-10-01": 1}, f"the partition was committed as {committed}, expected 2026-10-01 with the 1 row written"
    assert online.read_value("amount_7d", 2, "a1/e-2")["value"] == 7.0, "the newer value of e-2 must survive the backfill"


def check_acks_all(ctx):
    m, now = _events(ctx)
    m.materialize("amount_7d", 2, "2026-10-01", _rows(now, "a1"))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 1, "a leader failover lost the lineage event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m, now = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.materialize("amount_7d", 2, "2026-10-01", _rows(now, "a1"))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the partition's lineage is lost"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "amount_7d" and row.get("payload", {}).get("partition") == "2026-10-01", f"the outbox row is {row}, expected the topic, the key amount_7d and the payload"
    assert ok is False, f"materialize returned {ok!r} after a failed delivery, expected False"
    assert registry.committed_partitions("amount_7d", 2) == {"2026-10-01": 2}, "the partition must stay committed when only the produce failed"
`,
    typescript: `const TOPIC = 'feature.event';

async function events(ctx) {
  const registry = ctx.load('/support/features/registry.ts');
  const online = ctx.load('/support/features/online.ts');
  const now = Math.floor(ctx.clock.now() / 1000);
  for (const name of ['amount_7d', 'clicks_1h']) {
    await registry.createDefinition({name, version: 2, dtype: 'float64', computation_ref: 'window_avg_7d', freshness_slo: 3600, created_at: now});
  }
  return {m: ctx.load('events'), registry, online, now};
}

const rowsOf = (now: number, prefix: string) => [1, 2].map(i => ({entity: \`\${prefix}/e-\${i}\`, value: i, event_ts: now - 60}));

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_feature_key(ctx) {
  const {m, now} = await events(ctx);
  await m.materialize('amount_7d', 2, '2026-10-01', rowsOf(now, 'a1'));
  await m.materialize('clicks_1h', 2, '2026-10-01', rowsOf(now, 'c1'));
  await m.materialize('amount_7d', 2, '2026-10-02', rowsOf(now, 'a2'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three partitions materialized produced \${records.length} records on feature.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['amount_7d', 'clicks_1h', 'amount_7d'], \`the records are keyed \${JSON.stringify(keys)}, expected the feature names amount_7d, clicks_1h, amount_7d\`);
  assert.equal(records[0].partition, records[2].partition, "both amount_7d events must land on one partition, or a consumer reads one feature's lineage out of order");
}

export async function check_publish_after_commit(ctx) {
  const {m, now} = await events(ctx);
  const probe = ctx.redisAfter('partitions:amount_7d:2', () => ctx.kafka.records(TOPIC).length);
  await m.materialize('amount_7d', 2, '2026-10-01', rowsOf(now, 'a1'));
  await settle();
  assert(probe.fired, 'materialize never committed the partition (no write to partitions:amount_7d:2)');
  assert.equal(probe.result, 0, \`when the partition was committed the topic already held \${probe.result} event(s): a consumer can learn about a partition that does not exist yet. Commit first, then produce\`);
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`the event must still be produced after the commit; the topic holds \${values.length}\`);
  const payload = JSON.parse(values[0]);
  assert(payload.feature === 'amount_7d' && payload.version === 2 && payload.partition === '2026-10-01', \`the event is \${values[0]}, expected feature, version and partition\`);
}

export async function check_rows_written(ctx) {
  const {m, registry, online, now} = await events(ctx);
  // The streaming path already wrote a newer value of e-2; e-3 has no value.
  await online.writeValue('amount_7d', 2, 'a1/e-2', 7, now - 5);
  const rows = [
    {entity: 'a1/e-1', value: 1, event_ts: now - 60},
    {entity: 'a1/e-2', value: 2, event_ts: now - 60},
    {entity: 'a1/e-3', value: null, event_ts: now - 60},
  ];
  await m.materialize('amount_7d', 2, '2026-10-01', rows);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one partition materialized produced \${values.length} records\`);
  const payload = JSON.parse(values[0]);
  assert.equal(payload.rows, 1, \`the event reports \${payload.rows} rows; one was written (e-2 lost to a newer stored value, e-3 is null). Count what writeValue stored\`);
  const committed = await registry.committedPartitions('amount_7d', 2);
  assert.equal(JSON.stringify(committed), '{"2026-10-01":1}', \`the partition was committed as \${JSON.stringify(committed)}, expected 2026-10-01 with the 1 row written\`);
  assert.equal((await online.readValue('amount_7d', 2, 'a1/e-2')).value, 7, 'the newer value of e-2 must survive the backfill');
}

export async function check_acks_all(ctx) {
  const {m, now} = await events(ctx);
  await m.materialize('amount_7d', 2, '2026-10-01', rowsOf(now, 'a1'));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a leader failover lost the lineage event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, registry, now} = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const ok = await m.materialize('amount_7d', 2, '2026-10-01', rowsOf(now, 'a1'));
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the partition's lineage is lost\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'amount_7d' && rows[0].payload?.partition === '2026-10-01', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key amount_7d and the payload\`);
  assert.equal(ok, false, \`materialize resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  const committed = await registry.committedPartitions('amount_7d', 2);
  assert.equal(JSON.stringify(committed), '{"2026-10-01":2}', 'the partition must stay committed when only the produce failed');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"features/online"
	"features/registry"

	"leetbuild/harness"
)

const eventsTopic = "feature.event"

var eventsBg = context.Background()

func events(ctx *harness.Ctx) int64 {
	now := time.Now().Unix()
	for _, name := range []string{"amount_7d", "clicks_1h"} {
		_, err := registry.CreateDefinition(eventsBg, registry.Definition{Name: name, Version: 2, Dtype: "float64", ComputationRef: "window_avg_7d", FreshnessSLO: 3600, CreatedAt: now})
		ctx.NoError(err, "CreateDefinition")
	}
	return now
}

func num(v float64) *float64 { return &v }

func rowsOf(now int64, prefix string) []online.Row {
	return []online.Row{{Entity: prefix + "/e-1", Value: num(1), EventTs: now - 60}, {Entity: prefix + "/e-2", Value: num(2), EventTs: now - 60}}
}

func mustMaterialize(ctx *harness.Ctx, name, partition string, rows []online.Row) bool {
	ok, err := materialize(eventsBg, name, 2, partition, rows)
	ctx.NoError(err, "materialize(%s, %s) failed", name, partition)
	return ok
}

func payloadOf(ctx *harness.Ctx, value string) map[string]any {
	var payload map[string]any
	ctx.NoError(json.Unmarshal([]byte(value), &payload), "the event must be JSON, got %s", value)
	return payload
}

func CheckFeatureKey(ctx *harness.Ctx) {
	now := events(ctx)
	mustMaterialize(ctx, "amount_7d", "2026-10-01", rowsOf(now, "a1"))
	mustMaterialize(ctx, "clicks_1h", "2026-10-01", rowsOf(now, "c1"))
	mustMaterialize(ctx, "amount_7d", "2026-10-02", rowsOf(now, "a2"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three partitions materialized must produce three records on feature.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"amount_7d", "clicks_1h", "amount_7d"}, "the records must be keyed by the feature names")
	ctx.Equal(records[0].Partition, records[2].Partition, "both amount_7d events must land on one partition, or a consumer reads one feature's lineage out of order; the partitions")
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	now := events(ctx)
	probe := ctx.Redis.After("partitions:amount_7d:2", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	mustMaterialize(ctx, "amount_7d", "2026-10-01", rowsOf(now, "a1"))
	ctx.Settle()
	ctx.Assert(probe.Fired, "materialize never committed the partition (no write to partitions:amount_7d:2)")
	ctx.Equal(probe.Result, 0, "when the partition was committed the topic already held events: a consumer can learn about a partition that does not exist yet. Commit first, then produce; the events at commit time")
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "the event must still be produced after the commit; the records")
	payload := payloadOf(ctx, values[0])
	ctx.Assert(payload["feature"] == "amount_7d" && payload["partition"] == "2026-10-01", "the event is %s, expected feature, version and partition", values[0])
}

func CheckRowsWritten(ctx *harness.Ctx) {
	now := events(ctx)
	// The streaming path already wrote a newer value of e-2; e-3 has no value.
	_, err := online.WriteValue(eventsBg, "amount_7d", 2, "a1/e-2", 7, now-5)
	ctx.NoError(err, "online.WriteValue")
	rows := []online.Row{{Entity: "a1/e-1", Value: num(1), EventTs: now - 60}, {Entity: "a1/e-2", Value: num(2), EventTs: now - 60}, {Entity: "a1/e-3", EventTs: now - 60}}
	mustMaterialize(ctx, "amount_7d", "2026-10-01", rows)
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one partition materialized must produce one record; the records")
	ctx.Equal(payloadOf(ctx, values[0])["rows"], 1, "one row was written (e-2 lost to a newer stored value, e-3 is null): count what WriteValue stored; the event's rows")
	ctx.Equal(registry.CommittedPartitions(eventsBg, "amount_7d", 2), map[string]int{"2026-10-01": 1}, "the partition must be committed with the 1 row written; committed")
	kept, _ := online.ReadValue(eventsBg, "amount_7d", 2, "a1/e-2")
	ctx.Assert(kept != nil && kept.Value == 7, "the newer value of e-2 must survive the backfill, it reads %+v", kept)
}

func CheckAcksAll(ctx *harness.Ctx) {
	now := events(ctx)
	mustMaterialize(ctx, "amount_7d", "2026-10-01", rowsOf(now, "a1"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a leader failover must not lose the lineage event (RequireAll waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	now := events(ctx)
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := mustMaterialize(ctx, "amount_7d", "2026-10-01", rowsOf(now, "a1"))
	ctx.Settle()
	var rows []map[string]any
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		rows = append(rows, payloadOf(ctx, text))
	}
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the partition's lineage is lost; the rows")
	payload, _ := rows[0]["payload"].(map[string]any)
	ctx.Assert(rows[0]["topic"] == eventsTopic && rows[0]["key"] == "amount_7d" && payload["partition"] == "2026-10-01", "the outbox row is %v, expected the topic, the key amount_7d and the payload", rows[0])
	ctx.Equal(ok, false, "materialize's result after a failed delivery")
	ctx.Equal(registry.CommittedPartitions(eventsBg, "amount_7d", 2), map[string]int{"2026-10-01": 2}, "the partition must stay committed when only the produce failed; committed")
	_ = fmt.Sprint
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "features/online.h"
#include "features/registry.h"

using json = nlohmann::json;

namespace {

const std::string kEventsTopic = "feature.event";

long long events() {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  for (const std::string name : {"amount_7d", "clicks_1h"}) registry::createDefinition(registry::Definition{name, 2, "float64", "window_avg_7d", 3600, now});
  return now;
}

std::vector<online::Row> rowsOf(long long now, const std::string& prefix) {
  return {online::Row{prefix + "/e-1", 1.0, now - 60}, online::Row{prefix + "/e-2", 2.0, now - 60}};
}

json parsed(const std::string& text) { return json::parse(text, nullptr, false); }

std::string field(const json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckFeatureKey(harness::Ctx& ctx) {
  const long long now = events();
  materialize("amount_7d", 2, "2026-10-01", rowsOf(now, "a1"));
  materialize("clicks_1h", 2, "2026-10-01", rowsOf(now, "c1"));
  materialize("amount_7d", 2, "2026-10-02", rowsOf(now, "a2"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three partitions materialized must produce three records on feature.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"amount_7d", "clicks_1h", "amount_7d"}, "the records must be keyed by the feature names");
  ctx.Equal(records[0].Partition, records[2].Partition, "both amount_7d events must land on one partition, or a consumer reads one feature's lineage out of order; the partitions");
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  const long long now = events();
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("partitions:amount_7d:2", [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  materialize("amount_7d", 2, "2026-10-01", rowsOf(now, "a1"));
  ctx.Settle();
  ctx.Assert(fired, "materialize never committed the partition (no write to partitions:amount_7d:2)");
  ctx.Equal(atCommit, 0, "when the partition was committed the topic already held events: a consumer can learn about a partition that does not exist yet. Commit first, then produce; the events at commit time");
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "the event must still be produced after the commit; the records");
  const json payload = parsed(values[0]);
  ctx.Assert(field(payload, "feature") == "amount_7d" && field(payload, "partition") == "2026-10-01", "the event is %s, expected feature, version and partition", values[0]);
}

void CheckRowsWritten(harness::Ctx& ctx) {
  const long long now = events();
  // The streaming path already wrote a newer value of e-2; e-3 has no value.
  online::writeValue("amount_7d", 2, "a1/e-2", 7.0, now - 5);
  const std::vector<online::Row> rows = {online::Row{"a1/e-1", 1.0, now - 60}, online::Row{"a1/e-2", 2.0, now - 60}, online::Row{"a1/e-3", std::nullopt, now - 60}};
  materialize("amount_7d", 2, "2026-10-01", rows);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one partition materialized must produce one record; the records");
  const json payload = parsed(values[0]);
  ctx.Equal(payload.is_object() ? payload.value("rows", -1L) : -1L, 1L, "one row was written (e-2 lost to a newer stored value, e-3 is null): count what writeValue stored; the event's rows");
  ctx.Equal(registry::committedPartitions("amount_7d", 2), std::map<std::string, long>{{"2026-10-01", 1}}, "the partition must be committed with the 1 row written; committed");
  const auto kept = online::readValue("amount_7d", 2, "a1/e-2");
  ctx.Assert(kept && kept->value == 7.0, "the newer value of e-2 must survive the backfill");
}

void CheckAcksAll(harness::Ctx& ctx) {
  const long long now = events();
  materialize("amount_7d", 2, "2026-10-01", rowsOf(now, "a1"));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "a leader failover must not lose the lineage event (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  const long long now = events();
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const bool ok = materialize("amount_7d", 2, "2026-10-01", rowsOf(now, "a1"));
  ctx.Settle();
  std::vector<json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) rows.push_back(parsed(text));
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the partition's lineage is lost; the rows");
  ctx.Assert(field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == "amount_7d" && rows[0].contains("payload") && field(rows[0]["payload"], "partition") == "2026-10-01",
             "the outbox row is %s, expected the topic, the key amount_7d and the payload", rows[0].dump());
  ctx.Equal(ok, false, "materialize's result after a failed delivery");
  ctx.Equal(registry::committedPartitions("amount_7d", 2), std::map<std::string, long>{{"2026-10-01", 2}}, "the partition must stay committed when only the produce failed; committed");
}
`,
  },
  hints: [
    "Materialize two features and read feature.event: one feature's partitions land on different Kafka partitions. The event arrives before its partition is committed and counts rows that were never written.",
    'The key is the partition id; the produce runs before the writes and the commit; rows is the scan size whatever write_value answered; acks=1 trusts the leader alone; a refused delivery is only logged.',
    'Count the rows `write_value` stored; `commit_partition`, then produce `key=name` with `acks=all`; flush up to `ACK_TIMEOUT_S` and, on an error or no answer, `outbox.insert(TOPIC, name, payload)` and return False.',
  ],
  debrief: `An event is a statement about committed state, which is why the partition is committed before its event exists and why the count is what was written rather than what was scanned: a lineage consumer uses it to decide whether a partition is complete. The key is the feature because order only matters within one feature's lineage, and one key keeps it on one partition. \`acks=all\` makes a leader failover unable to lose an acknowledged event, and the outbox turns a broker outage into a delay, since a relay produces the row once the broker is back. Production pipelines write the outbox row in the same transaction as the partition commit, so a crash between the two cannot lose the event either.`,
};
