import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Load events keyed by target table',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'outbox'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes an event per
partition, then a completion event, and the demo shows a table light up in the consumer. It keyed the
topic wrong, announced the load before it finished, reported the plan instead of the result, and
dropped the event when the broker was unhappy. Review it like the service owner, fix it, and prove
the fix.

Implement the \`load.event\` publisher that runs after each partition write.

- Publish to \`load.event\` with the **target table as the message key**. A table's load stream must
  stay ordered — a dashboard that sees \`load_completed\` before \`partition_committed\` is worse than
  one that sees nothing. Keying by manifest scatters one table's events across partitions.
- The payload carries the **manifest id**, the **partition id** and the **written row count**, for
  both \`partition_committed\` and \`load_completed\`.
- Report **written** rows — the count the warehouse returned for the partition — never the
  manifest's planned count: a plan is what the loader hoped to write, and the report in step 5
  compares it against what landed.
- **Commit first, publish second**: the \`partition_committed\` event goes out **after** the partition
  is in the progress set (step 2), and \`load_completed\` only after the final partition committed.
  A completion event that overtakes the last commit makes every downstream reader wrong at once.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  plus a stable, hashed key), so a retried produce cannot duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it: the
  load has already happened, so the event is the only record that it did.

**Failure mode the checks target.** A completion published before the final commit is a lie the whole
platform believes; planned counts make an incomplete load look complete at the report; a dropped
event on a broker hiccup silently deletes history; and keying by manifest destroys the per-table
ordering the consumer's offset assumes.`,
  sequence: {
    participants: ['Load worker', 'load.event', 'Outbox relay', 'Downstream consumer'],
    messages: [
      {from: 'Load worker', to: 'Load worker', label: 'commit partition in the progress set', kind: 'sync'},
      {
        from: 'Load worker',
        to: 'load.event',
        label: 'produce partition_committed · key = target table · acks=all',
        kind: 'sync',
      },
      {from: 'load.event', to: 'Load worker', label: 'ack / broker error', kind: 'reply'},
      {from: 'Load worker', to: 'Outbox relay', label: 'outbox row when the broker rejects the produce', kind: 'async'},
      {from: 'Outbox relay', to: 'load.event', label: 'republish on recovery', kind: 'async'},
      {from: 'Load worker', to: 'load.event', label: 'produce load_completed after the final commit', kind: 'sync'},
      {from: 'load.event', to: 'Downstream consumer', label: 'consume one table’s stream in order', kind: 'async'},
    ],
  },
  hints: [
    'Order the calls in the function, not in your head: `state.commitPartition(...)` first, then the produce. If the event goes out first, a crash in between leaves the consumer announcing a partition that the progress set does not have.',
    'The key is the target table — `key=table`, `Key: []byte(table)`, `ProducerRecord(Topic, table, payload)`. Hashing on the table is what keeps one table’s partitions in one Kafka partition and therefore in order.',
    'Take the counts from the caller (which read them off the warehouse reply in step 3), not from the manifest. And wrap the produce: on a broker error write an outbox row with the topic, key and payload so the relay can publish it after the broker recovers.',
  ],
  checks: [
    {
      id: 'key-by-table',
      title: 'Keys load.event by the target table',
      detail:
        'The message key is the target table, so a table’s events share a partition and stay ordered. The draft keys by manifest id, scattering one table’s stream.',
      match: {
        python: {all: [/load\.event/, /key=table/]},
        typescript: {all: [/load\.event/, /key:\s*table/]},
        go: {all: [/load\.event/, /Key:\s*\[\]byte\(table\)/]},
        scala: {all: [/load\.event/, /ProducerRecord\[String, String\]\(Topic,\s*table,/]},
        cpp: {all: [/load\.event/, /table\.c_str\(\)/]},
      },
    },
    {
      id: 'written-counts',
      title: 'Carries written row counts, not planned ones',
      detail:
        'The event reports the rows the warehouse wrote for the partition (`rows_written`). The draft puts the manifest’s planned count in that field, so a partial load looks complete.',
      match: {
        python: {all: [/rows_written/], none: [/rows_planned|planned_rows/]},
        typescript: {all: [/rows_written/], none: [/rowsPlanned|planned_rows/]},
        go: {all: [/RowsWritten/], none: [/RowsPlanned|rowsPlanned/]},
        scala: {all: [/rowsWritten/], none: [/rowsPlanned/]},
        cpp: {all: [/rows_written/], none: [/rows_planned|rowsPlanned/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes only after the partition is committed',
      detail:
        'The partition is committed in the progress set before the event is produced, and `load_completed` follows the final commit. The draft produces the completion event first.',
      match: {
        python: {order: [/state\.commit_partition\(/, /producer\.produce\(/]},
        typescript: {order: [/state\.commitPartition\(/, /producer\.send\(/]},
        go: {order: [/state\.CommitPartition\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/state\.commitPartition\(/, /producer\.send\(/]},
        cpp: {order: [/state\.commitPartition\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A failed produce records the event in the outbox instead of dropping it or failing silently. The draft logs and forgets.',
      match: {
        python: {all: [/outbox/, /except\s+/]},
        typescript: {all: [/outbox/, /catch\s*\(/]},
        go: {all: [/outbox/, /if err != nil/]},
        scala: {all: [/outbox/, /case\s+\w+\s*:/]},
        cpp: {all: [/outbox/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        '`enable.idempotence` plus `acks=all` (KafkaJS’s `idempotent: true` + `acks: -1`, kafka-go’s `RequiredAcks: kafka.RequireAll` and a hashing balancer). The draft leaves the producer default: retries may duplicate a record.',
      match: {
        python: {all: [/enable\.idempotence/, /"acks":\s*"all"/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequireAll/, /kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks", "all"/]},
        cpp: {all: [/enable\.idempotence/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

TOPIC = "load.event"
logger = logging.getLogger("loader")

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(producer, state, manifest_id, target, partition_id, total_partitions, rows_planned):
    # TODO: this draft keys the event by manifest, publishes the completion event before the final
    # partition commits, reports the manifest's planned row count, and drops the event when the
    # broker rejects the produce. Review all four.
    if partition_id == f"{total_partitions - 1}":
        producer.produce(
            TOPIC,
            key=manifest_id.encode("utf-8"),
            value=json.dumps(
                {"type": "load_completed", "manifest_id": manifest_id, "target": target, "rows_written": rows_planned}
            ).encode("utf-8"),
        )
        producer.flush(5)
    producer.produce(
        TOPIC,
        key=manifest_id.encode("utf-8"),
        value=json.dumps(
            {
                "type": "partition_committed",
                "manifest_id": manifest_id,
                "partition_id": partition_id,
                "target": target,
                "rows_written": rows_planned,
            }
        ).encode("utf-8"),
    )
    producer.flush(5)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer

TOPIC = "load.event"
logger = logging.getLogger("loader")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)

class Outbox:
    def put(self, manifest_id: str, topic: str, key: str, payload: bytes) -> None:
        """A row the relay republishes once the broker recovers."""
        raise NotImplementedError


outbox = Outbox()


def publish(state, manifest_id, target, partition_id, total_partitions, rows_written):
    """Commit first, then tell the world; completion only after the final partition committed."""
    complete = state.commit_partition(manifest_id, partition_id, total_partitions)
    emit(
        target,
        manifest_id,
        {
            "type": "partition_committed",
            "manifest_id": manifest_id,
            "partition_id": partition_id,
            "target": target,
            "rows_written": rows_written,
        },
    )
    if complete:
        emit(
            target,
            manifest_id,
            {"type": "load_completed", "manifest_id": manifest_id, "target": target, "rows_written": rows_written},
        )
    return complete


def emit(table, manifest_id, event):
    """One record per event, keyed by the target table so a table's stream stays ordered."""
    payload = json.dumps(event).encode("utf-8")
    try:
        producer.produce(TOPIC, key=table.encode("utf-8"), value=payload)
        producer.flush(5)
    except KafkaException as err:
        logger.error("broker rejected %s for %s: %s", event["type"], table, err)
        outbox.put(manifest_id, TOPIC, table, payload)
`,
    },
    typescript: {
      starter: `/** load.event: a model-generated draft that publishes the completion before the commit. */
import {Kafka} from 'kafkajs';

export const TOPIC = 'load.event';
const kafka = new Kafka({clientId: 'loader', brokers: ['kafka:9092']});
export const producer = kafka.producer();
let connected: Promise<void> | null = null;

interface LoadState {
  commitPartition(manifestId: string, partitionId: string, totalPartitions: number): Promise<boolean>;
}

interface LoadEvent {
  type: string;
  manifest_id: string;
  partition_id?: string;
  target: string;
  rows_written: number;
}

export async function publish(
  state: LoadState,
  manifestId: string,
  target: string,
  partitionId: string,
  totalPartitions: number,
  rowsPlanned: number,
): Promise<void> {
  // TODO: this draft keys the event by manifest, publishes the completion event before the final
  // partition commits, reports the manifest's planned row count, and drops the event when the
  // broker rejects the produce. Review all four.
  connected ??= producer.connect();
  await connected;
  const value = JSON.stringify({type: 'partition_committed', manifest_id: manifestId, partition_id: partitionId, target, rows_written: rowsPlanned});
  try {
    await producer.send({topic: TOPIC, messages: [{key: manifestId, value}]});
  } catch (err) {
    console.error(\`dropping event: \${String(err)}\`);
  }
}
`,
      solution: `/** load.event: keyed by target table, written counts, published after the commit. */
import {Kafka} from 'kafkajs';

export const TOPIC = 'load.event';
const kafka = new Kafka({clientId: 'loader', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
let connected: Promise<void> | null = null;

interface LoadState {
  commitPartition(manifestId: string, partitionId: string, totalPartitions: number): Promise<boolean>;
}

interface LoadEvent {
  type: string;
  manifest_id: string;
  partition_id?: string;
  target: string;
  rows_written: number;
}

export const outbox = {
  async put(manifestId: string, topic: string, key: string, payload: string): Promise<void> {
    throw new Error('not implemented');
  },
};

export async function publish(
  state: LoadState,
  manifestId: string,
  target: string,
  partitionId: string,
  totalPartitions: number,
  rowsWritten: number,
): Promise<boolean> {
  const complete = await state.commitPartition(manifestId, partitionId, totalPartitions);
  await emit(target, manifestId, {
    type: 'partition_committed',
    manifest_id: manifestId,
    partition_id: partitionId,
    target,
    rows_written: rowsWritten,
  });
  if (complete) {
    await emit(target, manifestId, {
      type: 'load_completed',
      manifest_id: manifestId,
      target,
      rows_written: rowsWritten,
    });
  }
  return complete;
}

async function emit(table: string, manifestId: string, event: LoadEvent): Promise<void> {
  connected ??= producer.connect();
  await connected;
  const value = JSON.stringify(event);
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: table, value}]});
  } catch (err) {
    console.error(\`broker rejected \${event.type} for \${table}: \${String(err)}\`);
    await outbox.put(manifestId, TOPIC, table, value);
  }
}
`,
    },
    go: {
      starter:
        `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const loadEventTopic = "load.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: loadEventTopic}

type LoadState interface {
	CommitPartition(ctx context.Context, manifestID, partitionID string, totalPartitions int) (bool, error)
}

type LoadEvent struct {
	Type        string ` +
        '`' +
        `json:"type"` +
        '`' +
        `
	ManifestID  string ` +
        '`' +
        `json:"manifest_id"` +
        '`' +
        `
	PartitionID string ` +
        '`' +
        `json:"partition_id,omitempty"` +
        '`' +
        `
	Target      string ` +
        '`' +
        `json:"target"` +
        '`' +
        `
	RowsWritten int64  ` +
        '`' +
        `json:"rows_written"` +
        '`' +
        `
}

// Publish announces a partition commit (and the load completion) on load.event.
func Publish(ctx context.Context, state LoadState, manifestID, target, partitionID string, totalPartitions int, rowsPlanned int64) error {
	// TODO: this draft keys the event by manifest, publishes the completion event before the final
	// partition commits, reports the manifest's planned row count, and drops the event when the
	// broker rejects the produce. Review all four.
	completion, _ := json.Marshal(LoadEvent{Type: "load_completed", ManifestID: manifestID, Target: target, RowsWritten: rowsPlanned})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(manifestID), Value: completion}); err != nil {
		log.Printf("dropping event: %v", err)
	}
	committed, _ := json.Marshal(LoadEvent{Type: "partition_committed", ManifestID: manifestID, PartitionID: partitionID, Target: target, RowsWritten: rowsPlanned})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(manifestID), Value: committed})
}
`,
      solution:
        `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const loadEventTopic = "load.event"

var (
	writer = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        loadEventTopic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
	outbox = NewOutbox()
)

type LoadState interface {
	CommitPartition(ctx context.Context, manifestID, partitionID string, totalPartitions int) (bool, error)
}

// Outbox holds the events a rejecting broker would otherwise drop.
type Outbox struct{}

func NewOutbox() *Outbox { return &Outbox{} }

func (o *Outbox) Put(ctx context.Context, manifestID, topic, key string, payload []byte) error { return nil }

type LoadEvent struct {
	Type        string ` +
        '`' +
        `json:"type"` +
        '`' +
        `
	ManifestID  string ` +
        '`' +
        `json:"manifest_id"` +
        '`' +
        `
	PartitionID string ` +
        '`' +
        `json:"partition_id,omitempty"` +
        '`' +
        `
	Target      string ` +
        '`' +
        `json:"target"` +
        '`' +
        `
	RowsWritten int64  ` +
        '`' +
        `json:"rows_written"` +
        '`' +
        `
}

// Publish commits the partition, then announces it; completion only after the final partition.
func Publish(ctx context.Context, state LoadState, manifestID, target, partitionID string, totalPartitions int, rowsWritten int64) (bool, error) {
	complete, err := state.CommitPartition(ctx, manifestID, partitionID, totalPartitions)
	if err != nil {
		return false, err
	}
	if err := emit(ctx, target, manifestID, LoadEvent{Type: "partition_committed", ManifestID: manifestID, PartitionID: partitionID, Target: target, RowsWritten: rowsWritten}); err != nil {
		return false, err
	}
	if complete {
		if err := emit(ctx, target, manifestID, LoadEvent{Type: "load_completed", ManifestID: manifestID, Target: target, RowsWritten: rowsWritten}); err != nil {
			return false, err
		}
	}
	return complete, nil
}

// emit produces one record keyed by the target table, so a table's stream stays ordered.
func emit(ctx context.Context, table, manifestID string, event LoadEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(table), Value: payload}); err != nil {
		log.Printf("broker rejected %s for %s: %v", event.Type, table, err)
		return outbox.Put(ctx, manifestID, loadEventTopic, table, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

trait LoadState {
  def commitPartition(manifestId: String, partitionId: String, totalPartitions: Int): Boolean
}

object LoadEvents {
  val Topic = "load.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def publish(state: LoadState, manifestId: String, target: String, partitionId: String, totalPartitions: Int,
              rowsPlanned: Long): Unit = {
    // TODO: this draft keys the event by manifest, publishes the completion event before the final
    // partition commits, reports the manifest's planned row count, and drops the event when the
    // broker rejects the produce. Review all four.
    val payload = s"""{"type":"partition_committed","manifest_id":"$manifestId","partition_id":"$partitionId","target":"$target","rows_written":$rowsPlanned}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, manifestId, payload)).get()
    } catch {
      case e: Exception => System.err.println(s"dropping event: \${e.getMessage}")
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

trait LoadState {
  def commitPartition(manifestId: String, partitionId: String, totalPartitions: Int): Boolean
}

/** Holds the events a rejecting broker would otherwise drop. */
class Outbox {
  def put(manifestId: String, topic: String, key: String, payload: String): Unit = ()
}

final case class LoadEvent(eventType: String, manifestId: String, partitionId: Option[String], target: String, rowsWritten: Long)

object LoadEvents {
  val Topic = "load.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  val outbox = new Outbox()

  /** Commit the partition, then announce it; completion only after the final partition committed. */
  def publish(state: LoadState, manifestId: String, target: String, partitionId: String, totalPartitions: Int,
              rowsWritten: Long): Boolean = {
    val complete = state.commitPartition(manifestId, partitionId, totalPartitions)
    emit(target, LoadEvent("partition_committed", manifestId, Some(partitionId), target, rowsWritten))
    if (complete) {
      emit(target, LoadEvent("load_completed", manifestId, None, target, rowsWritten))
    }
    complete
  }

  /** One record per event, keyed by the target table so a table's stream stays ordered. */
  private def emit(table: String, event: LoadEvent): Unit = {
    val partitionId = event.partitionId.getOrElse("")
    val payload =
      s"""{"type":"\${event.eventType}","manifest_id":"\${event.manifestId}","partition_id":"$partitionId","target":"\${event.target}","rows_written":\${event.rowsWritten}}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, table, payload)).get()
    } catch {
      case e: Exception =>
        System.err.println(s"broker rejected \${event.eventType} for $table: \${e.getMessage}")
        outbox.put(event.manifestId, Topic, table, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <iostream>
#include <memory>
#include <string>

const std::string kLoadEventTopic = "load.event";

std::unique_ptr<RdKafka::Producer> producer;

struct LoadState {
  std::function<bool(const std::string&, const std::string&, int)> commitPartition;
};

// Announces a partition commit (and the load completion) on load.event.
void publish(LoadState& state, const std::string& manifestId, const std::string& target,
             const std::string& partitionId, int totalPartitions, long rowsPlanned) {
  // TODO: this draft keys the event by manifest, publishes the completion event before the final
  // partition commits, reports the manifest's planned row count, and drops the event when the
  // broker rejects the produce. Review all four.
  const std::string payload = "{\\"type\\":\\"partition_committed\\",\\"manifest_id\\":\\"" + manifestId +
                              "\\",\\"partition_id\\":\\"" + partitionId + "\\",\\"target\\":\\"" + target +
                              "\\",\\"rows_written\\":" + std::to_string(rowsPlanned) + "}";
  const RdKafka::ErrorCode err = producer->produce(
      kLoadEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()), payload.size(), manifestId.c_str(), nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    std::cerr << "dropping event: " << RdKafka::err2str(err) << "\\n";
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

const std::string kLoadEventTopic = "load.event";

std::unique_ptr<RdKafka::Producer> producer;
Outbox outbox;

// Holds the events a rejecting broker would otherwise drop.
struct Outbox {
  void put(const std::string& manifestId, const std::string& topic, const std::string& key, const std::string& payload);
};

struct LoadState {
  std::function<bool(const std::string&, const std::string&, int)> commitPartition;
};

struct LoadEvent {
  std::string event_type;
  std::string manifest_id;
  std::string partition_id;
  std::string target;
  long rows_written;
};

void initProducer() {
  std::string errstr;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("acks", "all", errstr);
  conf->set("enable.idempotence", "true", errstr);
  producer.reset(RdKafka::Producer::create(conf.get(), errstr));
}

std::string payloadOf(const LoadEvent& event) {
  std::string partition = event.partition_id.empty() ? "" : ",\\"partition_id\\":\\"" + event.partition_id + "\\"";
  return "{\\"type\\":\\"" + event.event_type + "\\",\\"manifest_id\\":\\"" + event.manifest_id + "\\"" + partition +
         ",\\"target\\":\\"" + event.target + "\\",\\"rows_written\\":" + std::to_string(event.rows_written) + "}";
}

void emit(const std::string& table, const LoadEvent& event);

// Commits the partition, then announces it; completion only after the final partition committed.
bool publish(LoadState& state, const std::string& manifestId, const std::string& target,
             const std::string& partitionId, int totalPartitions, long rowsWritten) {
  const bool complete = state.commitPartition(manifestId, partitionId, totalPartitions);
  emit(target, LoadEvent{"partition_committed", manifestId, partitionId, target, rowsWritten});
  if (complete) {
    emit(target, LoadEvent{"load_completed", manifestId, "", target, rowsWritten});
  }
  return complete;
}

// One record per event, keyed by the target table so a table's stream stays ordered.
void emit(const std::string& table, const LoadEvent& event) {
  const std::string payload = payloadOf(event);
  const RdKafka::ErrorCode err = producer->produce(
      kLoadEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()), payload.size(), table.c_str(), nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    std::cerr << "broker rejected " << event.event_type << " for " << table << ": " << RdKafka::err2str(err) << "\\n";
    outbox.put(event.manifest_id, kLoadEventTopic, table, payload);
  }
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand what a load event is *for*. It is not a
notification; it is the ordered record of a table's loads, and three of the four defects follow from
that. Keying by target table is what puts one table's events in one partition, so the consumer's
offsets mean what it thinks they mean. Committing before publishing is what makes the event true: the
produce is the last step of a commit, not an announcement of an intention, and \`load_completed\` must
never overtake the final \`partition_committed\`. The counts must be the warehouse's counts, because the
report in step 5 reconciles exactly those against the source and flags the difference — a plan
smuggled into that field hides the very delta the platform exists to surface. And the outbox exists
because the load already happened: the event is the only evidence of it, so a broker hiccup must
delay it, never erase it.`,
};
