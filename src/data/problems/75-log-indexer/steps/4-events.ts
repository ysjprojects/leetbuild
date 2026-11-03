import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Index events keyed by service for completeness',
  concept: 'kafka',
  file: 'events',
  focus: ['redis', 'writer', 'shard', 'kafka'],
  task: `## Task

**Starting point.** The starter's \`publish_batch\` builds a \`log.indexed\` event with the batch id,
tenant, indexed count and index snapshot, produces it keyed by the batch's index name, flushes, then
calls \`commit_batch\`. It compiles, the topic fills up, and it hides four flaws; one of them lets a
pipeline that is dropping logs look complete.

- Publish **only after the shard has committed**: \`commit_batch(batch_id)\` first, then produce.
- The message **key is the service id**, so one service's stream stays on one partition, in order.
- The event carries \`batch_id\`, \`indexed_count\`, **\`shed_count\`**, **\`rejected_count\`** and
  \`index_snapshot\`, so a consumer can see what ingest shed and rejected.
- The producer is **idempotent with \`acks=all\`** (\`RequiredAcks=RequireAll\` with a hash balancer in
  kafka-go).
- When the broker **rejects the produce**, write an **outbox** row (\`insert_outbox\`) that a relay
  republishes.
- The payload carries tenant and service ids, never the log message text.

**Failure mode the checks target.** Keyed by the index shard, a service's events scatter across
partitions and lose order; produced before the commit, a crash in between leaves the ledger
announcing a batch that was not indexed; with the broker's answer ignored, a rejected produce
vanishes; and without the shed and rejected counts, the ledger reports 100 % while the ingest path
discarded a fifth of the traffic.`,
  sequence: {
    participants: ['Buffered writer', 'Index shard', 'log.indexed'],
    messages: [
      {from: 'Buffered writer', to: 'Index shard', label: 'BulkWrite(batch_id)', kind: 'sync'},
      {from: 'Index shard', to: 'Buffered writer', label: 'committed', kind: 'reply'},
      {
        from: 'Buffered writer',
        to: 'log.indexed',
        label: 'produce key=service · batch_id · counts · snapshot',
        kind: 'async',
      },
      {from: 'log.indexed', to: 'Buffered writer', label: 'produce rejected', kind: 'reply'},
      {from: 'Buffered writer', to: 'Buffered writer', label: 'insert_outbox(tenant, service, event)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'service-key',
      title: 'Keys every event by the service id',
      detail:
        "The message key is the service id, so one service's events share a partition and stay ordered. The starter keys by the index shard, which interleaves every service the shard holds.",
      match: {
        python: {all: [/key=service/]},
        typescript: {all: [/key:\s*service\b/]},
        go: {all: [/Key:\s*\[\]byte\(service\)/]},
        scala: {all: [/ProducerRecord\(Topic,\s*service/]},
        cpp: {all: [/produce\([^;\n]*service/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Produces only after the shard committed',
      detail:
        '`commit_batch` runs before the produce, so an event never announces a batch the index does not hold. The starter produces first and commits afterwards, leaving the ledger ahead of the index across a crash.',
      match: {
        python: {order: [/commit_batch\(/, /producer\.produce\(/]},
        typescript: {order: [/commitBatch\(/, /\.send\(/]},
        go: {order: [/commitBatch\(/, /\.WriteMessages\(/]},
        scala: {order: [/commitBatch\(/, /\.send\(/]},
        cpp: {order: [/commitBatch\(/, /produce\(/]},
      },
    },
    {
      id: 'rejected-counts',
      title: 'Surfaces the shed and rejected counts',
      detail:
        'The event carries `shed_count` and `rejected_count` next to the indexed count, so a pipeline that is dropping records cannot look complete. The starter omits both, which is exactly what made the incident review read 100 %.',
      match: {
        python: {all: [/shed_count/, /rejected_count/]},
        typescript: {all: [/shed_count/, /rejected_count/]},
        go: {all: [/ShedCount/, /RejectedCount/]},
        scala: {all: [/shedCount/, /rejectedCount/]},
        cpp: {all: [/shed_count/, /rejected_count/]},
      },
    },
    {
      id: 'batch-and-snapshot',
      title: 'Carries the batch id, the record count and the index snapshot',
      detail:
        'The event identifies the batch (`batch_id`), reports how many records it indexed (`indexed_count`) and carries the index snapshot the shard returned, so a consumer can reconcile without re-reading the shard.',
      match: {
        python: {all: [/batch_id/, /indexed_count/, /index_snapshot/]},
        typescript: {all: [/batch_id/, /indexed_count/, /index_snapshot/]},
        go: {all: [/BatchID/, /IndexedCount/, /IndexSnapshot/]},
        scala: {all: [/batchId/, /indexedCount/, /indexSnapshot/]},
        cpp: {all: [/batch_id/, /indexed_count/, /index_snapshot/]},
      },
    },
    {
      id: 'outbox-on-rejection',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A failed produce (`KafkaException` / non-`ERR_NO_ERROR` result) writes an outbox row that a relay republishes. The starter ignores the broker result, so a rejected event disappears with the request.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /err\s*!=\s*nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""log.indexed publishing for committed batches."""
import json

from confluent_kafka import Producer

TOPIC = "log.indexed"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class OutboxStore:
    def insert_outbox(self, tenant: str, service: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


def publish_batch(tenant: str, service: str, batch: dict, commit_batch) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = {
        "batch_id": batch["batch_id"],
        "tenant": tenant,
        "indexed_count": batch["indexed_count"],
        "index_snapshot": batch["index_snapshot"],
    }
    producer.produce(TOPIC, key=batch["index"], value=json.dumps(event))
    producer.flush(2.0)
    commit_batch(batch["batch_id"])
    return event
`,
      solution: `"""log.indexed publishing: committed batches only, keyed by service, with an outbox."""
import json

from confluent_kafka import KafkaException, Producer

TOPIC = "log.indexed"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, tenant: str, service: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


def publish_batch(tenant: str, service: str, batch: dict, commit_batch) -> dict:
    """Publish one log.indexed event for a batch the shard has already committed."""
    commit_batch(batch["batch_id"])  # never announce what the index does not hold
    event = {
        "batch_id": batch["batch_id"],
        "tenant": tenant,
        "service": service,
        "indexed_count": batch["indexed_count"],
        "shed_count": batch["shed_count"],
        "rejected_count": batch["rejected_count"],
        "index_snapshot": batch["index_snapshot"],
    }
    payload = json.dumps(event)
    try:
        # key = service: one service's events share a partition and stay ordered
        producer.produce(TOPIC, key=service, value=payload)
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(tenant, service, event)
    return event
`,
    },
    typescript: {
      starter: `/** log.indexed publishing. */
import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'log.indexed';

const kafka = new Kafka({clientId: 'log-indexer', brokers: ['kafka:9092']});

export const producer: Producer = kafka.producer();

export interface CommittedBatch {
  batch_id: string;
  index: string;
  indexed_count: number;
  index_snapshot: Record<string, unknown>;
}

export interface OutboxStore {
  insertOutbox(tenant: string, service: string, event: Record<string, unknown>): Promise<void>;
}

export const store: OutboxStore = {insertOutbox: async () => {}};

export async function publishBatch(
  tenant: string,
  service: string,
  batch: CommittedBatch,
  commitBatch: (batchId: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const event = {
    batch_id: batch.batch_id,
    tenant,
    index: batch.index,
    indexed_count: batch.indexed_count,
    index_snapshot: batch.index_snapshot,
  };
  await producer.send({topic: TOPIC, messages: [{key: batch.index, value: JSON.stringify(event)}]});
  await commitBatch(batch.batch_id);
  return event;
}
`,
      solution: `/** log.indexed publishing: committed batches only, keyed by service, with an outbox. */
import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'log.indexed';

const kafka = new Kafka({clientId: 'log-indexer', brokers: ['kafka:9092']});

// idempotent + acks=-1 (all) + one in-flight request: a retried produce cannot duplicate the event.
export const producer: Producer = kafka.producer({idempotent: true, acks: -1, maxInFlightRequests: 1});

export interface CommittedBatch {
  batch_id: string;
  index: string;
  indexed_count: number;
  shed_count: number;
  rejected_count: number;
  index_snapshot: Record<string, unknown>;
}

export interface OutboxStore {
  insertOutbox(tenant: string, service: string, event: Record<string, unknown>): Promise<void>;
}

export const store: OutboxStore = {insertOutbox: async () => {}};

/** Publish one log.indexed event for a batch the shard has already committed. */
export async function publishBatch(
  tenant: string,
  service: string,
  batch: CommittedBatch,
  commitBatch: (batchId: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  await commitBatch(batch.batch_id); // never announce what the index does not hold
  const event = {
    batch_id: batch.batch_id,
    tenant,
    service,
    indexed_count: batch.indexed_count,
    shed_count: batch.shed_count,
    rejected_count: batch.rejected_count,
    index_snapshot: batch.index_snapshot,
  };
  try {
    // key = service: one service's events share a partition and stay ordered
    await producer.send({topic: TOPIC, messages: [{key: service, value: JSON.stringify(event)}]});
  } catch (error) {
    await store.insertOutbox(tenant, service, event);
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

	"github.com/segmentio/kafka-go"
)

const topic = "log.indexed"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

type CommittedBatch struct {
	BatchID       string
	Index         string
	IndexedCount  int
	IndexSnapshot map[string]any
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, tenant, service string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

// PublishBatch ships one log.indexed event for a drained batch.
func PublishBatch(ctx context.Context, tenant, service string, batch CommittedBatch, commitBatch func(context.Context, string) error) (map[string]any, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"batch_id":       batch.BatchID,
		"tenant":         tenant,
		"indexed_count":  batch.IndexedCount,
		"index_snapshot": batch.IndexSnapshot,
	}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(ctx, kafka.Message{Key: []byte(batch.Index), Value: payload})
	_ = commitBatch(ctx, batch.BatchID)
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "log.indexed"

// RequiredAcks=RequireAll with the hash balancer and no async writes is the kafka-go equivalent of
// an idempotent producer: a retry of the same key cannot duplicate the record.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type CommittedBatch struct {
	BatchID       string
	Index         string
	IndexedCount  int
	ShedCount     int
	RejectedCount int
	IndexSnapshot map[string]any
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, tenant, service string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

// PublishBatch ships one log.indexed event for a batch the shard has already committed.
func PublishBatch(ctx context.Context, tenant, service string, batch CommittedBatch, commitBatch func(context.Context, string) error) (map[string]any, error) {
	if err := commitBatch(ctx, batch.BatchID); err != nil {
		return nil, err
	}
	event := map[string]any{
		"batch_id":       batch.BatchID,
		"tenant":         tenant,
		"service":        service,
		"indexed_count":  batch.IndexedCount,
		"shed_count":     batch.ShedCount,
		"rejected_count": batch.RejectedCount,
		"index_snapshot": batch.IndexSnapshot,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	// Key: []byte(service) — one service's events share a partition and stay ordered.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(service), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, tenant, service, event)
	}
	return event, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object Events {
  val Topic = "log.indexed"
  val producer = new KafkaProducer[String, String](new Properties())

  final case class CommittedBatch(
      batchId: String,
      index: String,
      indexedCount: Int,
      indexSnapshot: Map[String, String]
  )

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  def publishBatch(tenant: String, service: String, batch: CommittedBatch, commitBatch: String => Unit): Map[String, Any] = {
    val event = Map(
      "batch_id" -> batch.batchId,
      "tenant" -> tenant,
      "indexed_count" -> batch.indexedCount,
      "index_snapshot" -> batch.indexSnapshot
    )
    producer.send(new ProducerRecord(Topic, batch.index, event.toJson.compactPrint))
    commitBatch(batch.batchId)
    event
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object Events {
  val Topic = "log.indexed"
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  final case class CommittedBatch(
      batchId: String,
      index: String,
      indexedCount: Int,
      shedCount: Int,
      rejectedCount: Int,
      indexSnapshot: Map[String, String]
  )

  /** Publish one log.indexed event for a batch the shard has already committed. */
  def publishBatch(tenant: String, service: String, batch: CommittedBatch, commitBatch: String => Unit): Map[String, Any] = {
    commitBatch(batch.batchId) // never announce what the index does not hold
    val event = Map(
      "batch_id" -> batch.batchId,
      "tenant" -> tenant,
      "service" -> service,
      "indexed_count" -> batch.indexedCount,
      "shed_count" -> batch.shedCount,
      "rejected_count" -> batch.rejectedCount,
      "index_snapshot" -> batch.indexSnapshot
    )
    val payload = event.toJson.compactPrint
    try {
      // ProducerRecord(Topic, service, payload): one service's events share a partition.
      producer.send(new ProducerRecord(Topic, service, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        Outbox.insertOutbox(tenant, service, payload)
    }
    event
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "log.indexed";

struct OutboxStore {
  void insertOutbox(const std::string& tenant, const std::string& service, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> produce() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = produce();

// PublishBatch ships one log.indexed event for a drained batch.
json publishBatch(
    const std::string& tenant,
    const std::string& service,
    const json& batch,
    const std::function<void(const std::string&)>& commitBatch) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const json event = {
      {"batch_id", batch["batch_id"]},
      {"tenant", tenant},
      {"indexed_count", batch["indexed_count"]},
      {"index_snapshot", batch["index_snapshot"]},
  };
  const auto payload = event.dump();
  const auto key = batch["index"].get<std::string>();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
  commitBatch(batch["batch_id"].get<std::string>());
  producer->flush(2000);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "log.indexed";

struct OutboxStore {
  void insertOutbox(const std::string& tenant, const std::string& service, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// PublishBatch ships one log.indexed event for a batch the shard has already committed.
json publishBatch(
    const std::string& tenant,
    const std::string& service,
    const json& batch,
    const std::function<void(const std::string&)>& commitBatch) {
  commitBatch(batch["batch_id"].get<std::string>());
  const json event = {
      {"batch_id", batch["batch_id"]},
      {"tenant", tenant},
      {"service", service},
      {"indexed_count", batch["indexed_count"]},
      {"shed_count", batch["shed_count"]},
      {"rejected_count", batch["rejected_count"]},
      {"index_snapshot", batch["index_snapshot"]},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), service.data(), service.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(tenant, service, event);
  }
  producer->flush(2000);
  return event;
}
`,
    },
  },
  hints: [
    'The completeness page reads 100 % while a fifth of the traffic was shed; a consumer sees `checkout` batches out of order; after a writer crash the ledger lists a batch the index does not hold.',
    '`produce` is keyed by `batch["index"]`, so services sharing a shard share a partition; it runs before `commit_batch`; the event omits shed and rejected counts; the broker result is unchecked.',
    'Call `commit_batch` first, then `producer.produce(TOPIC, key=service, ...)` with `shed_count` and `rejected_count` in the event; wrap the produce in `except KafkaException` and call `store.insert_outbox(tenant, service, event)` there.',
  ],
  debrief: `The key is a partition contract rather than a label, which is why the fix keys by service: Kafka orders within a partition only, so the key decides whose stream stays in sequence. Commit-then-produce makes the event a statement of fact instead of an intention; the ledger may lag the index, but it cannot run ahead of it. The shed and rejected counts travel in the same event as the indexed count because a consumer reading two sources at two times will reconcile them wrong. The outbox exists because a broker rejection is an ordinary outcome, not an exception to swallow. Production platforms go further: schema-registry validation on the event, per-tenant topic quotas, a relay that drains outbox rows, and dead-letter events for batches a human has to re-map.`,
};
