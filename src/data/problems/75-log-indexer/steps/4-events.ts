import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Index events keyed by service for completeness',
  concept: 'kafka',
  file: 'events',
  focus: ['redis', 'writer', 'shard', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds an event, produces it
to \`log.indexed\` and commits the batch. It compiles, the topic fills up, and it hides three
production flaws — one of them lets a pipeline that is dropping logs look complete. Review it like
the service owner, fix it, and prove the fix with the checks below.

Implement \`publish_batch\` for one drained batch of records:

- Publish **only after the shard has committed** the batch: call \`commit_batch(batch_id)\` first, then
  produce. Announcing a batch the index does not hold makes the completeness number a lie.
- The message **key is the service id**, so one service's \`log.indexed\` stream lands on one partition
  and stays ordered. Keying by the index shard interleaves every service that shares the shard.
- The event carries \`batch_id\`, \`indexed_count\`, **\`shed_count\`**, **\`rejected_count\`** and the
  \`index_snapshot\`. A consumer must be able to see that 400 records were shed and 12 were rejected
  at ingest; omitting those counts makes a dropping pipeline look complete.
- The producer is **idempotent with \`acks=all\`** (\`RequiredAcks=RequireAll\` with a hash balancer in
  kafka-go), so a retried produce cannot duplicate the event.
- When the broker **rejects the produce**, write an **outbox** row (\`insert_outbox\`) that a relay
  republishes; never drop the event and never fail the write silently.
- The payload carries tenant and service ids — never the log message text.

**Failure mode the checks target.** The draft keys by the index shard, so a service's events scatter
across partitions and a consumer cannot reconstruct order; it publishes before the shard commits, so
a crash between the produce and the commit leaves the ledger announcing a batch that was never
indexed; and it drops the shed and rejected counts, so the same ledger reports 100 % while the ingest
path quietly discarded a fifth of the traffic.`,
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
        "The message key is the service id, so one service's events share a partition and stay ordered. The draft keys by the index shard, which interleaves every service the shard holds.",
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
        '`commit_batch` runs before the produce, so an event never announces a batch the index does not hold. The draft produces first and commits afterwards, leaving the ledger ahead of the index across a crash.',
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
        'The event carries `shed_count` and `rejected_count` next to the indexed count, so a pipeline that is dropping records cannot look complete. The draft omits both, which is exactly what made the incident review read 100 %.',
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
        'A failed produce (`KafkaException` / non-`ERR_NO_ERROR` result) writes an outbox row that a relay republishes. The draft ignores the broker result, so a rejected event disappears with the request.',
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
    # TODO: this draft keys by the index shard, publishes before the shard commits, and leaves the
    # shed and rejected counts out of the event, so a dropping pipeline looks complete. Review all
    # three.
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
      starter: `/** log.indexed publishing: a model-generated draft that keys by the index shard. */
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
  // TODO: this draft keys by the index shard, publishes before the shard commits, and leaves the
  // shed and rejected counts out of the event, so a dropping pipeline looks complete. Review all
  // three.
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
	// TODO: this draft keys by the index shard, publishes before the shard commits, and leaves the
	// shed and rejected counts out of the event, so a dropping pipeline looks complete. Review all
	// three.
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

  // TODO: this draft keys by the index shard, publishes before the shard commits, and leaves the
  // shed and rejected counts out of the event, so a dropping pipeline looks complete. Review all
  // three.
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
  // TODO: this draft keys by the index shard, publishes before the shard commits, and leaves the
  // shed and rejected counts out of the event, so a dropping pipeline looks complete. Review all
  // three.
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
    "The key is an ordering contract, not a label: key by the index shard and every service that shares it is interleaved in one partition, so a consumer cannot reconstruct one service's stream. Key by the service id and each service gets its own ordered stream.",
    'The produce order matters more than the retry policy here. Commit the shard batch first, then produce: an event that arrives before the index holds the data is a promise the ledger cannot keep, and a crash between the two leaves the completeness page claiming records that were never written.',
    'A broker is not a database. Check the produce result and, when it fails, insert an outbox row that a relay republishes with the same batch id; and put `shed_count` and `rejected_count` in the event so the consumer can see the records the ingest path never accepted.',
  ],
  debrief: `The interviewer is checking the three things a generated Kafka snippet gets wrong. First, the key is a partition contract: keyed by service, one service's ingestion stream is ordered; keyed by the shard, every service on that shard interleaves, which is why the draft's consumers saw counts jump around. Second, publish-after-commit is what makes the event a statement of fact rather than an intention, and it is the difference between a ledger that lags and a ledger that lies. Third, completeness is only honest when the event carries everything: shedding is a policy decision, so the shed and rejected counts belong in the same event as the indexed count. The producer configuration is the fourth, quieter point — idempotence with acks=all is what makes a retried produce safe. Real platforms add schema-registry validation, per-tenant topic quotas, a relay that republishes outbox rows, and dead-letter events for the batches a human has to re-map.`,
};
