import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Dedupe events keyed by dataset with key hashes',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'store'],
  task: `## Task

**Starting point.** The starter is the publisher for \`dedupe.event\`: a module-level \`Producer\` with
only \`bootstrap.servers\` set, and a \`publish(record)\` that builds a payload from the record's
\`name\`, \`email\` and \`content\`, produces it keyed by \`record_id\` and flushes. It compiles, it
works when the broker is healthy, and it hides four flaws.

**Failure mode the checks target.** The starter keys by record, so one dataset's events scatter across
partitions and order is lost. It publishes raw names and emails "so reviewers can confirm the match",
turning a retained topic into a copy of the record store. And it writes no outbox row, so a rejected
produce is silently dropped.

Requirements:

- Events are **keyed by dataset id**, so every event for one dataset lands on the same partition and
  the dataset's dedupe stream stays ordered. Keying by record scatters a dataset's history.
- The payload carries **key hashes and outcomes only**: no record contents, raw names, emails or
  keys. The topic is retained and replicated, so anything published there outlives the request.
- The producer is **idempotent with acks=all**, so a retried produce does not duplicate an event.
- Every produce that the broker rejects leaves an **outbox row** so the event can be replayed later
  instead of being lost.`,
  sequence: {
    participants: ['Dedupe API', 'dedupe.event', 'Event consumer', 'record store'],
    messages: [
      {from: 'Dedupe API', to: 'dedupe.event', label: 'produce(key=dataset_id, key_hashes, outcome)', kind: 'sync'},
      {from: 'dedupe.event', to: 'Dedupe API', label: 'ack / rejection', kind: 'reply'},
      {from: 'Dedupe API', to: 'record store', label: 'outbox row on rejection', kind: 'async'},
      {from: 'dedupe.event', to: 'Event consumer', label: 'consume(key=dataset_id)', kind: 'async'},
      {from: 'Event consumer', to: 'record store', label: 'cluster update', kind: 'sync'},
      {from: 'Event consumer', to: 'Dedupe API', label: 'commit offset after the update', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes to dedupe.event',
      detail: 'Produce the dedupe event to the `dedupe.event` topic.',
      match: {
        python: {all: [/dedupe\.event/]},
        typescript: {all: [/dedupe\.event/]},
        go: {all: [/dedupe\.event/]},
        scala: {all: [/dedupe\.event/]},
        cpp: {all: [/dedupe\.event/]},
      },
    },
    {
      id: 'dataset-key',
      title: 'Keys the event by dataset id',
      detail:
        "The message key is the dataset id, not the record id, so one dataset's events share a partition and stay ordered. The starter keys by record.",
      match: {
        python: {all: [/key\s*=\s*dataset_id/], none: [/key\s*=\s*record_id/]},
        typescript: {all: [/key\s*:\s*dataset/], none: [/key\s*:\s*record/]},
        go: {all: [/Key:\s*\[\]byte\(dataset/], none: [/Key:\s*\[\]byte\(record/]},
        scala: {all: [/\bdataset_id\b/, /ProducerRecord/], none: [/\brecord_id\b/]},
        cpp: {all: [/\bdataset_id\b/], none: [/\brecord_id\b/]},
      },
    },
    {
      id: 'hashed',
      title: 'Carries key hashes, not raw contents',
      detail:
        'The payload carries `key_hashes` and the outcome and no raw names, emails or content. The starter publishes raw fields so reviewers can confirm the match.',
      match: {
        python: {all: [/key_hashes/], none: [/["']name["']|["']email["']|["']content["']/]},
        typescript: {all: [/key_hashes/], none: [/["']name["']|["']email["']|["']content["']/]},
        go: {all: [/key_hashes|KeyHashes/], none: [/"name"|"email"|"content"/]},
        scala: {all: [/key_hashes/], none: [/["']name["']|["']email["']|["']content["']/]},
        cpp: {all: [/key_hashes/], none: [/"name"|"email"|"content"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce leaves an outbox row so the event can be replayed later instead of being lost. The starter drops it.',
      match: {
        python: {all: [/outbox\.record\(/]},
        typescript: {all: [/outbox\.record\(/]},
        go: {all: [/outbox\.Record\(/]},
        scala: {all: [/outbox\.record\(/]},
        cpp: {all: [/outbox.*record\(/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Uses an idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotent delivery with `acks=all`, so a retried produce cannot duplicate an event. The starter configures neither.',
      match: {
        python: {all: [/enable\.idempotence/, /acks/]},
        typescript: {all: [/idempotent/, /acks/]},
        go: {all: [/RequireAll/]},
        scala: {all: [/enable\.idempotence/, /acks/]},
        cpp: {all: [/enable\.idempotence/, /acks/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(record: dict) -> None:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record_id = record["record_id"]
    payload = {
        "record_id": record_id,
        "name": record["name"],
        "email": record["email"],
        "content": record["content"],
        "outcome": "created",
    }
    producer.produce(
        "dedupe.event",
        key=record_id.encode("utf-8"),
        value=json.dumps(payload).encode("utf-8"),
    )
    producer.flush()
`,
      solution: `import json

from confluent_kafka import Producer

DEDUPE_TOPIC = "dedupe.event"


def build_producer(bootstrap: str) -> Producer:
    """Idempotent producer: one event per dataset partition with acks=all."""
    return Producer(
        {
            "bootstrap.servers": bootstrap,
            "enable.idempotence": True,
            "acks": "all",
        }
    )


class DedupeEventPublisher:
    def __init__(self, producer: Producer, outbox) -> None:
        self.producer = producer
        self.outbox = outbox

    def publish(self, dataset_id: str, event: dict) -> None:
        """Publish one dedupe event keyed by dataset id; never by the record."""
        payload = {
            "dataset_id": dataset_id,
            "outcome": event["outcome"],
            "key_hashes": event["key_hashes"],
            "confidence": event.get("confidence"),
        }

        def on_delivery(err, _msg):
            if err is not None:
                # The broker rejected the produce: record an outbox row so the event is not lost.
                self.outbox.record(dataset_id, payload)

        self.producer.produce(
            DEDUPE_TOPIC,
            key=dataset_id.encode("utf-8"),
            value=json.dumps(payload).encode("utf-8"),
            callback=on_delivery,
        )
        self.producer.poll(0)
`,
    },
    typescript: {
      starter: `import {Kafka, type Producer} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092'], clientId: 'dedupe-service'});

interface DedupeRecord {
  record_id: string;
  name: string;
  email: string;
  content: string;
}

async function publish(producer: Producer, record: DedupeRecord): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {
    record_id: record.record_id,
    name: record.name,
    email: record.email,
    content: record.content,
    outcome: 'created',
  };
  await producer.send({
    topic: 'dedupe.event',
    messages: [{key: record.record_id, value: JSON.stringify(payload)}],
  });
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

const DEDUPE_TOPIC = 'dedupe.event';

interface DedupeEvent {
  outcome: string;
  key_hashes: string[];
  confidence?: number;
}

interface Outbox {
  record(datasetId: string, payload: unknown): Promise<void>;
}

async function buildProducer(brokers: string[]): Promise<Producer> {
  const kafka = new Kafka({brokers, clientId: 'dedupe-service', idempotent: true});
  const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
  await producer.connect();
  return producer;
}

async function publish(
  producer: Producer,
  outbox: Outbox,
  datasetId: string,
  event: DedupeEvent,
): Promise<void> {
  const payload = {
    dataset_id: datasetId,
    outcome: event.outcome,
    key_hashes: event.key_hashes,
    confidence: event.confidence,
  };
  try {
    await producer.send({
      topic: DEDUPE_TOPIC,
      acks: -1,
      messages: [{key: datasetId, value: JSON.stringify(payload)}],
    });
  } catch {
    // The broker rejected the produce: record an outbox row so the event is not lost.
    await outbox.record(datasetId, payload);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

func NewWriter(brokers []string) *kafka.Writer {
	return &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: "dedupe.event", Async: false}
}

func Publish(ctx context.Context, writer *kafka.Writer, record Record) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload, err := json.Marshal(map[string]any{
		"record_id": record.ID,
		"name":      record.Name,
		"email":     record.Email,
		"content":   record.Content,
		"outcome":   "created",
	})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(record.ID),
		Value: payload,
	})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

const dedupeTopic = "dedupe.event"

type DedupeEvent struct {
	DatasetID string   \`json:"dataset_id"\`
	Outcome   string   \`json:"outcome"\`
	KeyHashes []string \`json:"key_hashes"\`
}

type Outbox interface {
	Record(ctx context.Context, datasetID string, payload []byte) error
}

func NewWriter(brokers []string) *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        dedupeTopic,
		RequiredAcks: kafka.RequireAll,
		Async:        false,
	}
}

func Publish(ctx context.Context, writer *kafka.Writer, outbox Outbox, datasetID string, event DedupeEvent) error {
	payload, err := json.Marshal(DedupeEvent{
		DatasetID: datasetID,
		Outcome:   event.Outcome,
		KeyHashes: event.KeyHashes,
	})
	if err != nil {
		return err
	}
	err = writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(datasetID),
		Value: payload,
	})
	if err != nil {
		// The broker rejected the produce: record an outbox row so the event is not lost.
		return outbox.Record(ctx, datasetID, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

final case class DedupeRecord(record_id: String, name: String, email: String, content: String)

class DedupeEventPublisher(producer: KafkaProducer[String, String]) {
  def publish(record: DedupeRecord): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload =
      s"""{"record_id":"\${record.record_id}","name":"\${record.name}","email":"\${record.email}","content":"\${record.content}"}"""
    producer.send(new ProducerRecord[String, String]("dedupe.event", record.record_id, payload))
    producer.flush()
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

final case class DedupeEvent(outcome: String, key_hashes: List[String], confidence: Option[Double])

trait Outbox {
  def record(dataset_id: String, payload: String): Unit
}

object DedupeEventPublisher {
  def buildProducer(bootstrap: String): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    new KafkaProducer[String, String](props)
  }
}

class DedupeEventPublisher(producer: KafkaProducer[String, String], outbox: Outbox) {
  def publish(dataset_id: String, event: DedupeEvent): Unit = {
    val payload =
      s"""{"dataset_id":"$dataset_id","outcome":"\${event.outcome}","key_hashes":\${event.key_hashes.mkString("[", ",", "]")}}"""
    val record = new ProducerRecord[String, String]("dedupe.event", dataset_id, payload)
    producer.send(
      record,
      (metadata, exception) => {
        if (exception != null) {
          // The broker rejected the produce: record an outbox row so the event is not lost.
          outbox.record(dataset_id, payload)
        }
      },
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

const std::string kDedupeTopic = "dedupe.event";

class DedupeEventPublisher {
 public:
  explicit DedupeEventPublisher(RdKafka::Producer& producer) : producer_(producer) {}

  void publish(const Record& record) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const std::string payload = json{{"record_id", record.id},
                                     {"name", record.name},
                                     {"email", record.email},
                                     {"content", record.content},
                                     {"outcome", "created"}}
                                    .dump();
    producer_.produce(kDedupeTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(payload.data()), payload.size(), record.id.data(),
                      record.id.size(), 0, nullptr);
    producer_.poll(0);
  }

 private:
  RdKafka::Producer& producer_;
};
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <string>
#include <vector>

const std::string kDedupeTopic = "dedupe.event";

std::unique_ptr<RdKafka::Producer> build_producer(const std::string& brokers) {
  std::string errstr;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", brokers, errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), errstr));
}

class DedupeEventPublisher {
 public:
  DedupeEventPublisher(RdKafka::Producer& producer, Outbox& outbox)
      : producer_(producer), outbox_(outbox) {}

  void publish(const std::string& dataset_id, const DedupeEvent& event) {
    const std::string payload = json{{"dataset_id", dataset_id},
                                     {"outcome", event.outcome},
                                     {"key_hashes", event.key_hashes}}
                                    .dump();
    const RdKafka::ErrorCode code = producer_.produce(
        kDedupeTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(payload.data()), payload.size(), dataset_id.data(), dataset_id.size(), 0, nullptr);
    if (code != RdKafka::ERR_NO_ERROR) {
      // The broker rejected the produce: record an outbox row so the event is not lost.
      outbox_.record(dataset_id, payload);
    }
    producer_.poll(0);
  }

 private:
  RdKafka::Producer& producer_;
  Outbox& outbox_;
};
`,
    },
  },
  hints: [
    'Symptom: a consumer replaying one dataset sees a merge before the check that caused it, and a grep of the topic turns up customer emails in clear text.',
    'Mechanism: `publish` keys the message by `record_id`, so events for one dataset land on different partitions; the payload copies `name`, `email` and `content` straight from the record; a rejected produce raises and nothing records it.',
    'Change: key by `dataset_id`, publish `key_hashes` plus the outcome, build the producer with `enable.idempotence` and `acks=all`, and call `outbox.record(...)` when the produce is rejected.',
  ],
  debrief: `The key choice is the whole ordering story: Kafka orders within a partition and nowhere else, so keying by dataset id is what makes "check, then merge" arrive in that order for a consumer. The payload shape follows from retention: a topic is replicated and kept for days, so a field published there is a second copy of the record that no erasure request will reach, which is why only hashes and outcomes go in. The outbox exists because the producer's own retries cover transient errors but not a broker that says no; the row is what lets a replay job finish the job later. Production platforms also pin a schema in a registry so a later producer cannot add a raw field, give the replay worker its own idempotency key, and commit consumer offsets only after the downstream write lands.`,
};
