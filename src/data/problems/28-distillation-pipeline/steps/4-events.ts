import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Filtered samples keyed by dataset for the training queue',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'trainer'],
  task: `## Task

The starter is a plausible model-generated draft: it produces an event per sample and the trainer
consumes it, so the demo shows data flowing. Four contracts are broken. Find them, fix them, and
prove the fix.

An **accepted** sample is published to \`distill.sample\` for the training consumer.

- The message is **keyed by \`dataset_id\`**, not by the job: partition by dataset means every
  consumer that batches one dataset gets that dataset's samples in one order. Keyed by job, two
  runs over the same dataset interleave on the training side.
- A sample whose \`dedupe_hash\` the dataset has already published is **never produced**: check the
  index first and drop it. The filter is what stops the student from memorising the same prompt.
- The payload carries ids only: \`sample_id\`, \`job_id\`, \`dataset_id\`, \`teacher_version\`,
  \`dedupe_hash\`, \`tokens\`. The **prompt text never reaches the topic or a log line** — the topic
  is retained and replicated, so anything written there outlives every retention policy the pipeline
  has.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent), so a retry of a
  produce cannot duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it or
  failing the caller: a relay republishes outbox rows when the broker recovers.

**Failure mode the checks target.** Keying by the job id is the ordering bug — training sees two
jobs' samples interleaved in one dataset and batches a shuffled curriculum. The duplicate is the
quality bug: a sample the dedupe filter already rejected upstream must not slip back onto the topic
from the publish path, because the trainer has no filter of its own. And the dropped produce error
is the quiet one: the sample is silently gone from the training set while the job reports it
accepted.`,
  sequence: {
    participants: ['Worker', 'distill.sample', 'Trainer'],
    messages: [
      {from: 'Worker', to: 'Worker', label: 'is_duplicate(dataset_id, dedupe_hash)?', kind: 'sync'},
      {from: 'Worker', to: 'distill.sample', label: 'produce · key = dataset_id · acks = all', kind: 'sync'},
      {from: 'distill.sample', to: 'Worker', label: 'ack / broker error', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'insertOutbox(event) on a rejected produce', kind: 'sync'},
      {from: 'distill.sample', to: 'Trainer', label: 'consume · group student', kind: 'async'},
      {from: 'Trainer', to: 'Trainer', label: 'train on the survivors of the filter', kind: 'sync'},
    ],
  },
  hints: [
    'The message key is the partition key, and the dataset is the unit the trainer batches: `key=event.dataset_id`, `key: event.dataset_id`, `Key: []byte(event.DatasetID)`, `ProducerRecord(topic, dataset_id, payload)`. Keyed by the job id, one dataset’s order depends on which worker won a race.',
    'The filter has to run *before* the produce, not after: test the dedupe index and return without producing, so a hash that was already published cannot reach the topic again. The trainer has no second filter.',
    'Publishing is not durable just because it is asynchronous: an idempotent producer with `acks=all` makes a retry safe, and an outbox row written in the failure branch makes a rejected produce recoverable. Keep the payload to ids — `sample_id`, `job_id`, `dataset_id`, `teacher_version`, `dedupe_hash`, `tokens` — and never the prompt.',
  ],
  checks: [
    {
      id: 'dataset-key',
      title: 'Keys the sample by dataset id',
      detail:
        'The produced record’s key is the **dataset id** (`key=event.dataset_id`, `key: event.dataset_id`, `Key: []byte(...DatasetID)`, `ProducerRecord(topic, dataset_id, …)`), so one dataset keeps one order in the topic. The draft keys by the job id.',
      match: {
        python: {all: [/produce\(\s*TOPIC\s*,\s*key=event\.dataset_id/]},
        typescript: {all: [/key:\s*event\.dataset_id/]},
        go: {all: [/Key:\s*\[\]byte\(event\.DatasetID\)/]},
        scala: {all: [/ProducerRecord\(Topic,\s*event\.dataset_id/]},
        cpp: {all: [/produce\([^;]*datasetId/]},
      },
    },
    {
      id: 'dedupe-filter',
      title: 'Never produces a duplicate hash',
      detail:
        'The dedupe index is consulted (`dedupe.is_duplicate(...)`) **before** the produce, and a duplicate returns without publishing. The draft publishes first and checks the hash afterwards, so the sample that the filter rejected still reaches the topic.',
      match: {
        python: {order: [/\.is_duplicate\(/, /producer\.produce\(/]},
        typescript: {order: [/\.isDuplicate\(/, /producer\.send\(/]},
        go: {order: [/\.IsDuplicate\(/, /WriteMessages\(/]},
        scala: {order: [/\.isDuplicate\(/, /producer\.send\(/]},
        cpp: {order: [/\.is_duplicate\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'version-and-hash',
      title: 'Carries the teacher version and the dedupe hash',
      detail:
        'The payload carries `teacher_version` and `dedupe_hash` beside the ids, so a bad run can be traced to the exact teacher version and a duplicate can be recognised downstream. The draft drops the teacher version and ships the raw prompt instead.',
      match: {
        python: {all: [/teacher_version/, /dedupe_hash/]},
        typescript: {all: [/teacher_version/, /dedupe_hash/]},
        go: {all: [/TeacherVersion/, /DedupeHash/]},
        scala: {all: [/teacher_version/, /dedupe_hash/]},
        cpp: {all: [/teacher_version/, /dedupe_hash/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce calls `insertOutbox(...)` inside the error branch instead of dropping the event, so a relay can republish it. The draft ignores the broker result entirely and the sample is lost while the job still counts it accepted.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'no-prompt-text',
      title: 'No prompt text in the event or the logs',
      detail:
        'Neither the payload nor any log line carries the prompt text: the topic is retained and replicated, so tenant content written there outlives every retention policy the pipeline has. The draft copies the prompt into both.',
      match: {
        python: {none: [/\bprompt\b/i]},
        typescript: {none: [/\bprompt\b/i]},
        go: {none: [/\bprompt\b/i]},
        scala: {none: [/\bprompt\b/i]},
        cpp: {none: [/\bprompt\b/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from pydantic import BaseModel

logger = logging.getLogger("distill.samples")

TOPIC = "distill.sample"
producer = Producer({"bootstrap.servers": "kafka:9092"})
SEEN: set[str] = set()


class SampleRecord(BaseModel):
    sample_id: str
    job_id: str
    dataset_id: str
    dedupe_hash: str
    prompt: str
    tokens: int


def publish(record: SampleRecord) -> None:
    # TODO: this draft keys by job id so two jobs over one dataset interleave, publishes the sample
    # before the dedupe filter has had a say, keeps the prompt in the payload and the log, and drops
    # the produce error on the floor. Review all four.
    payload = record.model_dump_json().encode("utf-8")
    logger.info("distill sample job=%s prompt=%r", record.job_id, record.prompt)
    producer.produce(TOPIC, key=record.job_id, value=payload)
    producer.poll(0)
    if record.dedupe_hash in SEEN:
        logger.info("duplicate sample job=%s", record.job_id)
    SEEN.add(record.dedupe_hash)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer
from pydantic import BaseModel

logger = logging.getLogger("distill.samples")

TOPIC = "distill.sample"
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


class SampleEvent(BaseModel):
    sample_id: str
    job_id: str
    dataset_id: str
    teacher_version: str
    dedupe_hash: str
    tokens: int


class DedupeIndex:
    def is_duplicate(self, dataset_id: str, dedupe_hash: str) -> bool:
        """True when this dataset already published a sample with this hash."""
        raise NotImplementedError


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused, for the relay to republish."""
        raise NotImplementedError


dedupe = DedupeIndex()
outbox = OutboxStore()


def publish(event: SampleEvent) -> bool:
    """Publish one accepted sample; the dataset is the key, the filter runs first."""
    if dedupe.is_duplicate(event.dataset_id, event.dedupe_hash):
        logger.info("distill sample duplicate dataset=%s job=%s", event.dataset_id, event.job_id)
        return False
    payload = json.dumps(
        {
            "sample_id": event.sample_id,
            "job_id": event.job_id,
            "dataset_id": event.dataset_id,
            "teacher_version": event.teacher_version,
            "dedupe_hash": event.dedupe_hash,
            "tokens": event.tokens,
        }
    ).encode("utf-8")
    try:
        producer.produce(TOPIC, key=event.dataset_id, value=payload)
        producer.poll(0)
    except KafkaException:
        outbox.insert_outbox(json.loads(payload.decode("utf-8")))
        logger.warning("distill.sample produce failed dataset=%s job=%s", event.dataset_id, event.job_id)
        return False
    return True
`,
    },
    typescript: {
      starter: `/** distill.sample: a model-generated draft that publishes before it filters. */
import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'distill.sample';
const kafka = new Kafka({clientId: 'distilld', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();
void producer.connect();

const seen = new Set<string>();

export interface SampleRecord {
  sample_id: string;
  job_id: string;
  dataset_id: string;
  dedupe_hash: string;
  prompt: string;
  tokens: number;
}

export async function publish(record: SampleRecord): Promise<void> {
  // TODO: this draft keys by job id so two jobs over one dataset interleave, publishes the sample
  // before the dedupe filter has had a say, keeps the prompt in the payload and the log, and drops
  // the produce error on the floor. Review all four.
  const payload = JSON.stringify(record);
  console.log({job_id: record.job_id, prompt: record.prompt}, 'sample published');
  await producer.send({topic: TOPIC, messages: [{key: record.job_id, value: payload}]});
  if (seen.has(record.dedupe_hash)) return;
  seen.add(record.dedupe_hash);
}
`,
      solution: `/** distill.sample: accepted samples keyed by dataset, behind the dedupe filter. */
import {Kafka, type Producer} from 'kafkajs';

const TOPIC = 'distill.sample';
const kafka = new Kafka({clientId: 'distilld', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

export interface SampleEvent {
  sample_id: string;
  job_id: string;
  dataset_id: string;
  teacher_version: string;
  dedupe_hash: string;
  tokens: number;
}

declare const dedupe: {isDuplicate(datasetId: string, dedupeHash: string): Promise<boolean>};
declare const store: {insertOutbox(event: SampleEvent): Promise<void>};

export async function publish(event: SampleEvent): Promise<boolean> {
  if (await dedupe.isDuplicate(event.dataset_id, event.dedupe_hash)) return false;
  const payload = JSON.stringify({
    sample_id: event.sample_id,
    job_id: event.job_id,
    dataset_id: event.dataset_id,
    teacher_version: event.teacher_version,
    dedupe_hash: event.dedupe_hash,
    tokens: event.tokens,
  });
  try {
    await producer.send({topic: TOPIC, messages: [{key: event.dataset_id, value: payload}]});
    return true;
  } catch (error) {
    await store.insertOutbox(event);
    console.warn({dataset_id: event.dataset_id, job_id: event.job_id, error}, 'sample outboxed');
    return false;
  }
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const sampleTopic = "distill.sample"

var sampleWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: sampleTopic}

var seen = map[string]bool{}

type SampleRecord struct {
	SampleID   string \`json:"sample_id"\`
	JobID      string \`json:"job_id"\`
	DatasetID  string \`json:"dataset_id"\`
	DedupeHash string \`json:"dedupe_hash"\`
	Prompt     string \`json:"prompt"\`
	Tokens     int    \`json:"tokens"\`
}

func Publish(ctx context.Context, event SampleRecord) error {
	// TODO: this draft keys by job id so two jobs over one dataset interleave, publishes the sample
	// before the dedupe filter has had a say, keeps the prompt in the payload and the log, and drops
	// the produce error on the floor. Review all four.
	payload, _ := json.Marshal(event)
	log.Printf("distill sample job=%s prompt=%q", event.JobID, event.Prompt)
	_ = sampleWriter.WriteMessages(ctx, kafka.Message{Key: []byte(event.JobID), Value: payload})
	if seen[event.DedupeHash] {
		return nil
	}
	seen[event.DedupeHash] = true
	return nil
}
`,
      solution: `package events

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const sampleTopic = "distill.sample"

// RequireAll with a hash balancer is the kafka-go shape of an idempotent producer: the broker
// acknowledges only once the record is replicated, and a retry of the same key lands on the same
// partition instead of duplicating across them.
var sampleWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        sampleTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type SampleEvent struct {
	SampleID       string \`json:"sample_id"\`
	JobID          string \`json:"job_id"\`
	DatasetID      string \`json:"dataset_id"\`
	TeacherVersion string \`json:"teacher_version"\`
	DedupeHash     string \`json:"dedupe_hash"\`
	Tokens         int    \`json:"tokens"\`
}

type DedupeIndex interface {
	IsDuplicate(ctx context.Context, datasetID, dedupeHash string) (bool, error)
}

type OutboxStore interface {
	InsertOutbox(ctx context.Context, event SampleEvent) error
}

// Publish one accepted sample: the dataset is the key, and the filter runs before the produce.
func Publish(ctx context.Context, dedupe DedupeIndex, store OutboxStore, event SampleEvent) error {
	duplicate, err := dedupe.IsDuplicate(ctx, event.DatasetID, event.DedupeHash)
	if err != nil {
		return err
	}
	if duplicate {
		return nil
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := sampleWriter.WriteMessages(ctx, kafka.Message{Key: []byte(event.DatasetID), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, event)
		return err
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object SampleEvents {
  private val log = Logger.getLogger("distill.samples")
  val Topic = "distill.sample"
  val producer = new KafkaProducer[String, String](new Properties())
  var seen = Set.empty[String]

  final case class SampleRecord(
      sample_id: String,
      job_id: String,
      dataset_id: String,
      dedupe_hash: String,
      prompt: String,
      tokens: Int
  )

  // TODO: this draft keys by job id so two jobs over one dataset interleave, publishes the sample
  // before the dedupe filter has had a say, keeps the prompt in the payload and the log, and drops
  // the produce error on the floor. Review all four.
  def publish(event: SampleRecord): Unit = {
    log.info(s"distill sample job=\${event.job_id} prompt=\${event.prompt}")
    val payload = Map[String, String](
      "sample_id" -> event.sample_id,
      "job_id" -> event.job_id,
      "dataset_id" -> event.dataset_id,
      "dedupe_hash" -> event.dedupe_hash,
      "prompt" -> event.prompt
    ).toJson.compactPrint
    producer.send(new ProducerRecord(Topic, event.job_id, payload))
    if (seen.contains(event.dedupe_hash)) return
    seen += event.dedupe_hash
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object SampleEvents {
  val Topic = "distill.sample"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  final case class SampleEvent(
      sample_id: String,
      job_id: String,
      dataset_id: String,
      teacher_version: String,
      dedupe_hash: String,
      tokens: Int
  )

  trait DedupeIndex {
    def isDuplicate(datasetId: String, dedupeHash: String): Boolean
  }

  trait OutboxStore {
    def insertOutbox(event: SampleEvent): Unit
  }

  // Publish one accepted sample: the dataset is the key, and the filter runs before the produce.
  def publish(dedupe: DedupeIndex, store: OutboxStore, event: SampleEvent): Unit = {
    if (dedupe.isDuplicate(event.dataset_id, event.dedupe_hash)) return
    val payload = Map[String, String](
      "sample_id" -> event.sample_id,
      "job_id" -> event.job_id,
      "dataset_id" -> event.dataset_id,
      "teacher_version" -> event.teacher_version,
      "dedupe_hash" -> event.dedupe_hash,
      "tokens" -> event.tokens.toString
    ).toJson.compactPrint
    try {
      producer.send(new ProducerRecord(Topic, event.dataset_id, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        store.insertOutbox(event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <set>
#include <string>

using json = nlohmann::json;

const std::string kSampleTopic = "distill.sample";

std::unique_ptr<RdKafka::Producer> producer;
std::set<std::string> seen;

void publish(const std::string& jobId, const std::string& datasetId, const std::string& dedupeHash,
             const std::string& prompt, int tokens) {
  // TODO: this draft keys by job id so two jobs over one dataset interleave, publishes the sample
  // before the dedupe filter has had a say, keeps the prompt in the payload and the log, and drops
  // the produce error on the floor. Review all four.
  const json event = {
      {"job_id", jobId}, {"dataset_id", datasetId}, {"dedupe_hash", dedupeHash}, {"prompt", prompt}, {"tokens", tokens}};
  const auto payload = event.dump();
  std::cerr << "distill sample job=" << jobId << " prompt=" << prompt << "\\n";
  producer->produce(kSampleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), jobId.data(), jobId.size(), 0, nullptr);
  producer->flush(2000);
  if (seen.count(dedupeHash) > 0) return;
  seen.insert(dedupeHash);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kSampleTopic = "distill.sample";

struct DedupeIndex {
  bool is_duplicate(const std::string& dataset_id, const std::string& dedupe_hash);
};

struct OutboxStore {
  void insertOutbox(const json& event);
};

DedupeIndex dedupe;
OutboxStore store;

// enable.idempotence with acks=all is what makes a retried produce safe: the broker keeps the
// producer id and sequence, so the same record is not written twice.
std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// Publish one accepted sample: the dataset is the key, and the filter runs before the produce.
void publish(const std::string& sampleId, const std::string& jobId, const std::string& datasetId,
             const std::string& teacherVersion, const std::string& dedupeHash, int tokens) {
  if (dedupe.is_duplicate(datasetId, dedupeHash)) return;
  const json event = {{"sample_id", sampleId},
                      {"job_id", jobId},
                      {"dataset_id", datasetId},
                      {"teacher_version", teacherVersion},
                      {"dedupe_hash", dedupeHash},
                      {"tokens", tokens}};
  const auto payload = event.dump();
  const auto err = producer->produce(kSampleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(), datasetId.data(),
                                     datasetId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(event);
  }
  producer->flush(2000);
}
`,
    },
  },
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong. First, the key is an ordering contract: partition by dataset and the trainer sees one dataset in one order; key by job and two runs interleave. Second, the filter has to be upstream of the produce — a payload the dedupe filter rejected must not be able to reach the topic through a second path, because the trainer trusts the topic. Third, a broker is not a database: a rejected produce needs an outbox row and a relay, and the producer needs idempotence with acks=all for the retry that follows. The prompt leak is the quiet one: topics are retained and replicated, so whatever you write there outlives the request, the tenant and the retention policy. Real platforms add schema registry validation, per-dataset quotas, and a dead-letter topic for events a consumer can never process.`,
};
