import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Feature events keyed by feature name',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes an event for every
partition it materializes. The event is unorderable, it describes a plan instead of a result, and it
can announce a write that never committed. Find the flaws, fix them, and prove the fix with the checks
below.

Implement the \`feature.event\` producer behind the materialization worker:

- Events go to the **\`feature.event\`** topic **keyed by the feature name**, so every event for one
  feature lands in one partition and a consumer reads its lineage in order. The draft keys by entity,
  which scatters one feature across partitions and lets a consumer see partition 7 before partition 2.
- The payload carries **version, partition range and row counts**:
  \`{feature, version, partition_start, partition_end, rows}\`. The event is the lineage record other
  services hang scheduling, backfills and alerts on.
- The producer uses **\`acks=all\`**, so an acknowledged produce is replicated rather than buffered on
  one broker.
- Publish **after the partition commits**. The draft sends the event before it has written anything, so
  a crash between the two leaves a consumer that believes a partition exists when it does not. Commit
  the partition, then publish.
- The row count is measured **after the write**, from the rows that were actually written. The draft
  reports the planner's estimate, so the count is a promise the worker never checks.
- When the broker rejects the produce, the event goes to an **outbox** instead, so a broker outage
  delays lineage rather than losing it.

**Failure mode the checks target.** Per-feature ordering, publish-after-commit, and counts that
describe what was written.

## What to keep

The topic, the worker loop and the payload shape are fine. The fix is the message key, the
acknowledgement level, the order of the two writes, the source of the count, and the failure path.`,
  sequence: {
    participants: ['Materialization worker', 'Offline store', 'Kafka', 'Outbox'],
    messages: [
      {
        from: 'Materialization worker',
        to: 'Offline store',
        label: 'Scan(feature, version, partition, cutoff_ms)',
        kind: 'sync',
      },
      {from: 'Offline store', to: 'Materialization worker', label: 'rows', kind: 'reply'},
      {
        from: 'Materialization worker',
        to: 'Materialization worker',
        label: 'write the partition, then commit it',
        kind: 'sync',
      },
      {
        from: 'Materialization worker',
        to: 'Kafka',
        label: 'produce feature.event key=feature {version, range, rows} acks=all',
        kind: 'sync',
      },
      {from: 'Kafka', to: 'Materialization worker', label: 'ack · or ProduceError', kind: 'reply'},
      {from: 'Materialization worker', to: 'Outbox', label: 'park the event when the broker rejects it', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'feature-key',
      title: 'Keys the event by feature name',
      detail:
        'The record key is the feature name, so every event of one feature shares a partition and keeps its lineage ordered. The draft keys by entity and scatters one feature across partitions.',
      match: {
        python: {all: [/key=feature/]},
        typescript: {all: [/key:\s*feature\b/]},
        go: {all: [/StringEncoder\(feature\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic, feature/]},
        cpp: {all: [/builder\.key\(feature\)/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Produce with acks=all',
      detail:
        'The producer acknowledges only after every in-sync replica has the record. The draft leaves the acknowledgement level at its default.',
      match: {
        python: {all: [/ACKS_ALL/]},
        typescript: {all: [/ACKS_ALL/]},
        go: {all: [/WaitForAll/]},
        scala: {all: [/AcksAll/]},
        cpp: {all: [/kAcksAll/]},
      },
    },
    {
      id: 'commit-before-publish',
      title: 'Publishes only after the partition commits',
      detail:
        'The partition commit happens before the produce call, so a consumer never sees a materialized event for a partition that was not written. The draft publishes first and writes afterwards.',
      match: {
        python: {order: [/commit[A-Za-z_]*\(/, /producer\.send\(/]},
        typescript: {order: [/commit[A-Za-z_]*\(/, /producer\.send\(/]},
        go: {order: [/commit[A-Za-z_]*\(/, /\.Produce\(/]},
        scala: {order: [/commit[A-Za-z_]*\(/, /\.send\(/]},
        cpp: {order: [/commit[A-Za-z_]*\(/, /producer\.produce\(/]},
      },
    },
    {
      id: 'counts-from-execution',
      title: 'Reports the rows that were written',
      detail:
        'The row count in the event comes from the rows the write actually produced, not from the planner. The draft reports `planned_rows`, a number nothing ever checks.',
      match: {
        python: {all: [/len\(rows\)/], none: [/planned/]},
        typescript: {all: [/rows\.length/], none: [/planned/]},
        go: {all: [/len\(rows\)/], none: [/planned/]},
        scala: {all: [/rows\.size/], none: [/planned/]},
        cpp: {all: [/rows\.size\(\)/], none: [/planned/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce fails',
      detail:
        'A rejected produce parks the same payload in an outbox so lineage can be replayed. The draft drops the event when the broker rejects it.',
      match: {
        python: {all: [/outbox/i, /rpush\(/]},
        typescript: {all: [/outbox/i, /rpush\(/]},
        go: {all: [/outbox/i, /INSERT/i]},
        scala: {all: [/outbox/i, /INSERT/i]},
        cpp: {all: [/outbox/i, /rpush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from kafka import KafkaProducer

TOPIC = "feature.event"

producer = KafkaProducer(bootstrap_servers="kafka:9092")


def materialize(
    feature: str,
    version: int,
    entity: str,
    partition_start: int,
    partition_end: int,
    planned_rows: int,
) -> None:
    # TODO: key the event by feature name instead of entity, publish only after the partition
    # commits, report the rows the write actually produced instead of the plan, and park the event
    # in an outbox when the broker rejects the produce.
    event = {"feature": feature, "version": version, "rows": planned_rows}
    producer.send(TOPIC, key=entity.encode(), value=json.dumps(event).encode())
    for partition in range(partition_start, partition_end + 1):
        rows = scan_partition(feature, version, partition)
        write_partition(feature, version, partition, rows)
        commit_partition(feature, version, partition)
`,
      solution: `import json

import redis
from kafka import KafkaProducer
from kafka.errors import KafkaError

TOPIC = "feature.event"
ACKS_ALL = "all"

producer = KafkaProducer(bootstrap_servers="kafka:9092", acks=ACKS_ALL)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def materialize(feature: str, version: int, partition_start: int, partition_end: int) -> list[int]:
    """Write each partition, commit it, and only then publish its feature.event."""
    written: list[int] = []
    for partition in range(partition_start, partition_end + 1):
        rows = scan_partition(feature, version, partition)
        if not rows:
            continue
        write_partition(feature, version, partition, rows)
        commit_partition(feature, version, partition)
        event = {
            "feature": feature,
            "version": version,
            "partition_start": partition_start,
            "partition_end": partition_end,
            "rows": len(rows),
        }
        payload = json.dumps(event).encode()
        try:
            producer.send(TOPIC, key=feature.encode(), value=payload).get(timeout=2.0)
        except KafkaError:
            r.rpush("outbox:feature.event", payload)
        written.append(partition)
    return written
`,
    },
    typescript: {
      starter: `/** Materialize a feature version: a model-generated draft that announces its plan. */
import {Kafka} from 'kafkajs';

const TOPIC = 'feature.event';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

export async function materialize(
  feature: string,
  version: number,
  entity: string,
  partitionStart: number,
  partitionEnd: number,
  plannedRows: number,
): Promise<void> {
  // TODO: key the event by feature name instead of entity, publish only after the partition commits,
  // report the rows the write actually produced instead of the plan, and park the event in an outbox
  // when the broker rejects the produce.
  const event = {feature, version, rows: plannedRows};
  void producer.send({topic: TOPIC, messages: [{key: entity, value: JSON.stringify(event)}]});
  for (let partition = partitionStart; partition <= partitionEnd; partition++) {
    const rows = await scanPartition(feature, version, partition);
    await writePartition(feature, version, partition, rows);
    await commitPartition(feature, version, partition);
  }
}
`,
      solution: `/** Materialize each partition, commit it, and only then publish its feature.event. */
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

const TOPIC = 'feature.event';
const ACKS_ALL = -1;

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();
const r = new Redis('redis://redis:6379');

interface FeatureEvent {
  feature: string;
  version: number;
  partition_start: number;
  partition_end: number;
  rows: number;
}

export async function materialize(
  feature: string,
  version: number,
  partitionStart: number,
  partitionEnd: number,
): Promise<number[]> {
  const written: number[] = [];
  for (let partition = partitionStart; partition <= partitionEnd; partition++) {
    const rows = await scanPartition(feature, version, partition);
    if (rows.length === 0) continue;
    await writePartition(feature, version, partition, rows);
    await commitPartition(feature, version, partition);
    const event: FeatureEvent = {
      feature,
      version,
      partition_start: partitionStart,
      partition_end: partitionEnd,
      rows: rows.length,
    };
    const payload = JSON.stringify(event);
    try {
      await producer.send({topic: TOPIC, acks: ACKS_ALL, messages: [{key: feature, value: payload}]});
    } catch {
      await r.rpush('outbox:feature.event', payload);
    }
    written.push(partition);
  }
  return written;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/IBM/sarama"
)

const topic = "feature.event"

var producer sarama.AsyncProducer

func materialize(
	ctx context.Context,
	feature string,
	version int,
	entity string,
	partitionStart int,
	partitionEnd int,
	plannedRows int) {
	// TODO: key the event by feature name instead of entity, publish only after the partition
	// commits, report the rows the write actually produced instead of the plan, and park the event
	// in an outbox when the broker rejects the produce.
	payload, _ := json.Marshal(map[string]any{"feature": feature, "version": version, "rows": plannedRows})
	producer.Input() <- &sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(entity),
		Value: sarama.ByteEncoder(payload),
	}
	for partition := partitionStart; partition <= partitionEnd; partition++ {
		rows := scanPartition(ctx, feature, version, partition)
		writePartition(ctx, feature, version, partition, rows)
		commitPartition(ctx, feature, version, partition)
	}
}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/IBM/sarama"
)

const (
	topic   = "feature.event"
	acksAll = sarama.WaitForAll
)

var (
	producer sarama.AsyncProducer
	db       *sql.DB
)

type featureEvent struct {
	Feature        string \`json:"feature"\`
	Version        int    \`json:"version"\`
	PartitionStart int    \`json:"partition_start"\`
	PartitionEnd   int    \`json:"partition_end"\`
	Rows           int    \`json:"rows"\`
}

func materialize(
	ctx context.Context,
	feature string,
	version int,
	partitionStart int,
	partitionEnd int) []int {
	written := []int{}
	for partition := partitionStart; partition <= partitionEnd; partition++ {
		rows := scanPartition(ctx, feature, version, partition)
		if len(rows) == 0 {
			continue
		}
		writePartition(ctx, feature, version, partition, rows)
		commitPartition(ctx, feature, version, partition)
		event := featureEvent{
			Feature:        feature,
			Version:        version,
			PartitionStart: partitionStart,
			PartitionEnd:   partitionEnd,
			Rows:           len(rows),
		}
		payload, _ := json.Marshal(event)
		deliveryChan := make(chan error, 1)
		producer.Produce(&sarama.ProducerMessage{
			Topic: topic,
			Key:   sarama.StringEncoder(feature),
			Value: sarama.ByteEncoder(payload),
		}, deliveryChan)
		if err := <-deliveryChan; err != nil {
			_, _ = db.ExecContext(ctx, "INSERT INTO outbox (topic, payload) VALUES ($1, $2)", topic, payload)
		}
		written = append(written, partition)
	}
	return written
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object FeatureEvents {
  val Topic = "feature.event"
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  def materialize(
      feature: String,
      version: Int,
      entity: String,
      partitionStart: Int,
      partitionEnd: Int,
      plannedRows: Int): Unit = {
    // TODO: key the event by feature name instead of entity, publish only after the partition
    // commits, report the rows the write actually produced instead of the plan, and park the event
    // in an outbox when the broker rejects the produce.
    val event = s"""{"feature":"$feature","version":$version,"rows":$plannedRows}"""
    producer.send(new ProducerRecord[String, String](Topic, entity, event))
    for (partition <- partitionStart to partitionEnd) {
      val rows = scanPartition(feature, version, partition)
      writePartition(feature, version, partition, rows)
      commitPartition(feature, version, partition)
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import slick.jdbc.PostgresProfile.api._

object FeatureEvents {
  val Topic = "feature.event"
  val AcksAll = "all"
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", AcksAll)
  val producer = new KafkaProducer[String, String](props)
  val db = Database.forConfig("featurestore")

  def materialize(feature: String, version: Int, partitionStart: Int, partitionEnd: Int): List[Int] = {
    val written = scala.collection.mutable.ListBuffer.empty[Int]
    for (partition <- partitionStart to partitionEnd) {
      val rows = scanPartition(feature, version, partition)
      if (rows.nonEmpty) {
        writePartition(feature, version, partition, rows)
        commitPartition(feature, version, partition)
        val event =
          s"""{"feature":"$feature","version":$version,"partition_start":$partitionStart,"partition_end":$partitionEnd,"rows":\${rows.size}}"""
        try producer.send(new ProducerRecord[String, String](Topic, feature, event)).get()
        catch {
          case _: Exception => db.run(sqlu"INSERT INTO outbox (topic, payload) VALUES ($Topic, $event)")
        }
        written += partition
      }
    }
    written.toList
  }
}
`,
    },
    cpp: {
      starter: `#include <cppkafka/cppkafka.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "feature.event";

void materialize(
    cppkafka::Producer& producer,
    const std::string& feature,
    int version,
    const std::string& entity,
    int partition_start,
    int partition_end,
    int planned_rows) {
  // TODO: key the event by feature name instead of entity, publish only after the partition commits,
  // report the rows the write actually produced instead of the plan, and park the event in an outbox
  // when the broker rejects the produce.
  const auto event = json{{"feature", feature}, {"version", version}, {"rows", planned_rows}}.dump();
  cppkafka::MessageBuilder builder(kTopic);
  builder.key(entity);
  builder.payload(event);
  producer.produce(builder);
  for (int partition = partition_start; partition <= partition_end; ++partition) {
    const auto rows = scan_partition(feature, version, partition);
    write_partition(feature, version, partition, rows);
    commit_partition(feature, version, partition);
  }
}
`,
      solution: `#include <cppkafka/cppkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "feature.event";
const std::string kAcksAll = "all";

std::vector<int> materialize(
    cppkafka::Producer& producer,
    sw::redis::Redis& redis,
    const std::string& feature,
    int version,
    int partition_start,
    int partition_end) {
  std::vector<int> written;
  for (int partition = partition_start; partition <= partition_end; ++partition) {
    const auto rows = scan_partition(feature, version, partition);
    if (rows.empty()) continue;
    write_partition(feature, version, partition, rows);
    commit_partition(feature, version, partition);
    const auto event = json{{"feature", feature},
                            {"version", version},
                            {"partition_start", partition_start},
                            {"partition_end", partition_end},
                            {"rows", rows.size()}}
                           .dump();
    cppkafka::MessageBuilder builder(kTopic);
    builder.key(feature);
    builder.payload(event);
    producer.produce(builder);
    try {
      producer.flush();
    } catch (const cppkafka::KafkaException&) {
      redis.rpush("outbox:feature.event", event);
    }
    written.push_back(partition);
  }
  return written;
}
`,
    },
  },
  hints: [
    'The message key decides the partition, and Kafka only orders within a partition. `key = feature name` keeps one feature’s lineage in one ordered log; keying by entity spreads the same feature across partitions and reorders it for every consumer.',
    'The event is a claim about what exists. Commit the partition first, then publish, so a crash between the two leaves a missing event (replayable) rather than a materialized event for a partition that was never written. And take the row count from the rows you just wrote — a planner’s estimate is a number nobody checks.',
    'Do not answer before the broker does: `acks=all` plus a wait on the delivery report makes the publish real. When the produce is rejected, park the same payload in an outbox and let a replay drain it; dropping it loses lineage that no other system can reconstruct.',
  ],
  debrief: `The interview question behind this step is what a topic is: an append-only, retained, replicated log ordered per partition. Everything else follows from that. The key is the ordering knob, so it has to be the thing whose ordering the consumer depends on — here the feature, not the entity. The publish has to happen after the durable write, because an event is a statement about state, and a statement published before the state exists is a lie that outlives the bug. The row count has to come from execution rather than planning, otherwise the log disagrees with the store and the disagreement is undetectable. And the outbox is the difference between a broker outage that delays lineage and one that loses it. Real pipelines add schema enforcement on the topic, a consumer that writes idempotently, and lineage events for definition changes as well as materializations.`,
};
