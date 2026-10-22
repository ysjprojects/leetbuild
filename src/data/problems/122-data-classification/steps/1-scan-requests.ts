import type {Step} from '@/lib/types';

export const scanRequestsStep: Step = {
  id: 'scan-requests',
  title: 'schema.changed: validated, deduplicated jobs before the commit',
  concept: 'kafka',
  file: 'scan_intake',
  focus: ['platforms', 'schema', 'metasense', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it subscribes to the topic,
reads an event and enqueues a classification job, so the demo shows jobs appearing. It hides four
production flaws. Review it like the owner of the intake, fix it, and prove the fix with the checks
below.

Data platforms produce one \`schema.changed\` event per entity whose schema appeared or changed,
keyed by entity: \`{"entity": "deliveries", "owner": "team-logistics", "columns": ["merchant_id",
"status", "delivery_time"]}\`. The intake turns events into classification jobs.

- Consume \`schema.changed\` in the consumer group \`metasense\` with **auto-commit off**; the
  offset is committed by the code, after the work.
- **Validate** before anything else: \`entity\` and \`owner\` are non-empty strings and \`columns\`
  is a non-empty list of strings. A malformed event is produced to \`schema.changed.dlq\` with the
  original payload and then committed — it must not block the partition and must not be lost.
- Compute \`schema_hash\` as the hex SHA-256 of the columns joined by \`\\n\`. Ask the store whether
  \`(entity, schema_hash)\` was already \`seen\`; if so, commit and move on. Re-scanning an unchanged
  schema is the most expensive no-op the service can do.
- Split entities with more than **150** columns (\`MAX_COLUMNS_PER_JOB\`) into several jobs of at
  most 150 columns each, with \`part\` and \`parts\` so the results can be reassembled. The source
  found the model loses attention past that size.
- **Enqueue the job, then commit.** A commit before the enqueue means a crash between the two
  loses the schema change until the next manual scan — which, for an entity nobody re-touches, is
  never.

**Failure mode the checks target.** Auto-commit and a commit at the top of the loop both move the
offset past work that has not happened; a 600-column table in one job produces tags the model did
not actually look at; the missing hash makes every re-emitted event a full re-scan on a paid API;
and an unvalidated event either crashes the consumer on the same record forever or quietly becomes a
job for an entity named \`null\`.`,
  sequence: {
    participants: ['Data platforms', 'schema.changed', 'metasense', 'job store'],
    messages: [
      {from: 'Data platforms', to: 'schema.changed', label: 'produce · key = entity', kind: 'async'},
      {from: 'schema.changed', to: 'metasense', label: 'consume · group metasense · auto-commit off', kind: 'async'},
      {from: 'metasense', to: 'metasense', label: 'validate · sha256(columns) · split > 150', kind: 'sync'},
      {from: 'metasense', to: 'schema.changed', label: 'produce schema.changed.dlq when malformed', kind: 'async'},
      {from: 'metasense', to: 'job store', label: 'seen(entity, schema_hash)?', kind: 'sync'},
      {from: 'job store', to: 'metasense', label: 'false', kind: 'reply'},
      {from: 'metasense', to: 'job store', label: 'enqueue(job part k/n)', kind: 'sync'},
      {from: 'metasense', to: 'schema.changed', label: 'commit offset after the enqueue', kind: 'async'},
    ],
  },
  hints: [
    'Turn auto-commit off in the consumer configuration and make the commit the last statement of the loop body. Everything the loop does — validate, hash, split, enqueue — happens before it, so a crash replays the record instead of losing it.',
    'Validation is a function that returns the parsed event or `None`; the `None` branch produces the raw payload to `schema.changed.dlq` and commits. The hash is `sha256("\\n".join(columns))` — a string the store can index — and `store.seen(entity, schema_hash)` decides whether a job exists at all.',
    'Splitting is a slice loop: `for start in range(0, len(columns), MAX_COLUMNS_PER_JOB)` with `part = start // MAX_COLUMNS_PER_JOB + 1` and `parts = ceil(len / 150)`. Each slice is its own `store.enqueue(...)`; the commit comes after the loop, once every part is durable.',
  ],
  checks: [
    {
      id: 'manual-commit',
      title: 'Consumes schema.changed with auto-commit off',
      detail:
        'The consumer subscribes to `schema.changed` in group `metasense` with auto-commit disabled (`enable.auto.commit=false`, `autoCommit: false`, `FetchMessage` + `CommitMessages`). The draft lets the client commit on its own schedule.',
      match: {
        python: {all: [/["']schema\.changed["']/, /enable\.auto\.commit["']\s*:\s*False/]},
        typescript: {all: [/['"]schema\.changed['"]/, /autoCommit:\s*false/]},
        go: {all: [/"schema\.changed"/, /FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"schema\.changed"/, /ENABLE_AUTO_COMMIT_CONFIG,\s*"false"/]},
        cpp: {all: [/"schema\.changed"/, /enable\.auto\.commit",\s*"false"/]},
      },
    },
    {
      id: 'split-jobs',
      title: 'Splits entities over 150 columns into several jobs',
      detail:
        'A `MAX_COLUMNS_PER_JOB = 150` constant bounds the columns per job and larger entities are sliced into parts. The draft enqueues the whole column list, however long.',
      match: {
        python: {all: [/MAX_COLUMNS_PER_JOB\s*=\s*150/, /range\(\s*0,\s*len\(columns\),\s*MAX_COLUMNS_PER_JOB\s*\)/]},
        typescript: {all: [/MAX_COLUMNS_PER_JOB\s*=\s*150/, /columns\.slice\(/]},
        go: {all: [/maxColumnsPerJob\s*=\s*150/, /columns\[start:end\]/]},
        scala: {all: [/MaxColumnsPerJob\s*=\s*150/, /\.grouped\(MaxColumnsPerJob\)/]},
        cpp: {all: [/kMaxColumnsPerJob\s*=\s*150/, /columns\.begin\(\)\s*\+/]},
      },
    },
    {
      id: 'dedupe-hash',
      title: 'Skips an (entity, schema_hash) already seen',
      detail:
        '`schema_hash` is the SHA-256 of the joined columns and `store.seen(entity, schema_hash)` is consulted before any job is created. The draft re-scans every event, including re-emitted ones for unchanged schemas.',
      match: {
        python: {all: [/sha256\(/, /store\.seen\(/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /store\.seen\(/]},
        go: {all: [/sha256\.Sum256\(/, /store\.Seen\(/]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /store\.seen\(/]},
        cpp: {all: [/sha256Hex\(/, /store\.seen\(/]},
      },
    },
    {
      id: 'dead-letter',
      title: 'Produces malformed events to schema.changed.dlq',
      detail:
        'An event that fails validation is produced to `schema.changed.dlq` and then committed, so the partition keeps moving and the payload survives for inspection. The draft either crashes on it or turns it into a job.',
      match: {
        python: {all: [/schema\.changed\.dlq/, /producer\.produce\(/]},
        typescript: {all: [/schema\.changed\.dlq/, /producer\.send\(/]},
        go: {all: [/schema\.changed\.dlq/, /WriteMessages\(/]},
        scala: {all: [/schema\.changed\.dlq/, /producer\.send\(/]},
        cpp: {all: [/schema\.changed\.dlq/, /producer->produce\(/]},
      },
    },
    {
      id: 'enqueue-before-commit',
      title: 'Commits the offset only after the job is enqueued',
      detail:
        'The commit follows `store.enqueue(...)` in the loop body. The draft commits as soon as the record is read, so a crash between read and enqueue loses the schema change.',
      match: {
        python: {order: [/store\.enqueue\(/, /consumer\.commit\(/]},
        typescript: {order: [/store\.enqueue\(/, /await commit\(\)/]},
        go: {order: [/store\.Enqueue\(/, /CommitMessages\(/]},
        scala: {order: [/store\.enqueue\(/, /commitSync\(/]},
        cpp: {order: [/store\.enqueue\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})


class JobStore:
    def enqueue(self, job: dict) -> None:
        """Durably append one classification job; the classifier worker drains the queue."""
        raise NotImplementedError


store = JobStore()


def consume() -> None:
    # TODO: this draft commits before the job exists, enqueues entities of any size as one job,
    # re-scans schemas it has already seen, and trusts the payload shape. Review all four.
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "metasense"})
    consumer.subscribe(["schema.changed"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        store.enqueue(
            {
                "entity": event["entity"],
                "owner": event["owner"],
                "columns": event["columns"],
            }
        )
`,
      solution: `import hashlib
import json
import math

from confluent_kafka import Consumer, Producer

MAX_COLUMNS_PER_JOB = 150
DLQ_TOPIC = "schema.changed.dlq"

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


class JobStore:
    def seen(self, entity: str, schema_hash: str) -> bool:
        """True when a job for this exact schema was already created."""
        raise NotImplementedError

    def enqueue(self, job: dict) -> None:
        """Durably append one classification job; the classifier worker drains the queue."""
        raise NotImplementedError


store = JobStore()


def parse_event(raw: bytes) -> dict | None:
    try:
        event = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(event, dict):
        return None
    entity = event.get("entity")
    owner = event.get("owner")
    columns = event.get("columns")
    if not isinstance(entity, str) or entity == "":
        return None
    if not isinstance(owner, str) or owner == "":
        return None
    if not isinstance(columns, list) or not columns or not all(isinstance(c, str) and c for c in columns):
        return None
    return {"entity": entity, "owner": owner, "columns": columns}


def schema_hash_of(columns: list[str]) -> str:
    return hashlib.sha256("\\n".join(columns).encode("utf-8")).hexdigest()


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "metasense", "enable.auto.commit": False}
    )
    consumer.subscribe(["schema.changed"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = parse_event(msg.value())
        if event is None:
            producer.produce(DLQ_TOPIC, key=msg.key(), value=msg.value())
            producer.flush(2.0)
            consumer.commit(msg)
            continue
        columns = event["columns"]
        schema_hash = schema_hash_of(columns)
        if store.seen(event["entity"], schema_hash):
            consumer.commit(msg)
            continue
        parts = math.ceil(len(columns) / MAX_COLUMNS_PER_JOB)
        for start in range(0, len(columns), MAX_COLUMNS_PER_JOB):
            store.enqueue(
                {
                    "entity": event["entity"],
                    "owner": event["owner"],
                    "schema_hash": schema_hash,
                    "columns": columns[start : start + MAX_COLUMNS_PER_JOB],
                    "part": start // MAX_COLUMNS_PER_JOB + 1,
                    "parts": parts,
                }
            )
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** schema.changed intake: a model-generated draft that commits before the job exists. */
import {Kafka} from 'kafkajs';

import {store} from './store';

const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});

interface SchemaChanged {
  entity: string;
  owner: string;
  columns: string[];
}

export async function consume(): Promise<void> {
  // TODO: this draft commits before the job exists, enqueues entities of any size as one job,
  // re-scans schemas it has already seen, and trusts the payload shape. Review all four.
  const consumer = kafka.consumer({groupId: 'metasense'});
  await consumer.connect();
  await consumer.subscribe({topic: 'schema.changed'});
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as SchemaChanged;
      await store.enqueue({entity: event.entity, owner: event.owner, columns: event.columns});
    },
  });
}
`,
      solution: `/** schema.changed intake: validate, hash, split, enqueue — then commit. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {store} from './store';

const MAX_COLUMNS_PER_JOB = 150;
const DLQ_TOPIC = 'schema.changed.dlq';

const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface SchemaChanged {
  entity: string;
  owner: string;
  columns: string[];
}

function parseEvent(raw: Buffer | null): SchemaChanged | null {
  if (raw === null) return null;
  let event: unknown;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (event === null || typeof event !== 'object') return null;
  const {entity, owner, columns} = event as Partial<SchemaChanged>;
  if (typeof entity !== 'string' || entity === '') return null;
  if (typeof owner !== 'string' || owner === '') return null;
  if (!Array.isArray(columns) || columns.length === 0) return null;
  if (!columns.every(c => typeof c === 'string' && c !== '')) return null;
  return {entity, owner, columns};
}

function schemaHashOf(columns: string[]): string {
  return createHash('sha256').update(columns.join('\\n')).digest('hex');
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'metasense'});
  await consumer.connect();
  await consumer.subscribe({topic: 'schema.changed'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const commit = () =>
        consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = parseEvent(message.value);
      if (event === null) {
        await producer.send({topic: DLQ_TOPIC, acks: -1, messages: [{key: message.key, value: message.value}]});
        await commit();
        return;
      }
      const schemaHash = schemaHashOf(event.columns);
      if (await store.seen(event.entity, schemaHash)) {
        await commit();
        return;
      }
      const parts = Math.ceil(event.columns.length / MAX_COLUMNS_PER_JOB);
      for (let start = 0; start < event.columns.length; start += MAX_COLUMNS_PER_JOB) {
        await store.enqueue({
          entity: event.entity,
          owner: event.owner,
          schema_hash: schemaHash,
          columns: event.columns.slice(start, start + MAX_COLUMNS_PER_JOB),
          part: start / MAX_COLUMNS_PER_JOB + 1,
          parts,
        });
      }
      await commit();
    },
  });
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

type SchemaChanged struct {
	Entity  string   \`json:"entity"\`
	Owner   string   \`json:"owner"\`
	Columns []string \`json:"columns"\`
}

type Job struct {
	Entity  string   \`json:"entity"\`
	Owner   string   \`json:"owner"\`
	Columns []string \`json:"columns"\`
}

type JobStore struct{}

// Enqueue durably appends one classification job; the classifier worker drains the queue.
func (s *JobStore) Enqueue(ctx context.Context, job Job) error { return nil }

var store = &JobStore{}

// TODO: this draft lets the client commit on its own schedule, enqueues entities of any size as
// one job, re-scans schemas it has already seen, and trusts the payload shape. Review all four.
func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "schema.changed",
		GroupID: "metasense",
	})
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			continue
		}
		var event SchemaChanged
		_ = json.Unmarshal(msg.Value, &event)
		_ = store.Enqueue(ctx, Job{Entity: event.Entity, Owner: event.Owner, Columns: event.Columns})
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/segmentio/kafka-go"
)

const (
	maxColumnsPerJob = 150
	dlqTopic         = "schema.changed.dlq"
)

type SchemaChanged struct {
	Entity  string   \`json:"entity"\`
	Owner   string   \`json:"owner"\`
	Columns []string \`json:"columns"\`
}

type Job struct {
	Entity     string   \`json:"entity"\`
	Owner      string   \`json:"owner"\`
	SchemaHash string   \`json:"schema_hash"\`
	Columns    []string \`json:"columns"\`
	Part       int      \`json:"part"\`
	Parts      int      \`json:"parts"\`
}

type JobStore struct{}

// Seen reports whether a job for this exact schema was already created.
func (s *JobStore) Seen(ctx context.Context, entity, schemaHash string) (bool, error) { return false, nil }

// Enqueue durably appends one classification job; the classifier worker drains the queue.
func (s *JobStore) Enqueue(ctx context.Context, job Job) error { return nil }

var store = &JobStore{}

var dlqWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        dlqTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

func parseEvent(raw []byte) (SchemaChanged, bool) {
	var event SchemaChanged
	if err := json.Unmarshal(raw, &event); err != nil {
		return event, false
	}
	if event.Entity == "" || event.Owner == "" || len(event.Columns) == 0 {
		return event, false
	}
	for _, c := range event.Columns {
		if c == "" {
			return event, false
		}
	}
	return event, true
}

func schemaHashOf(columns []string) string {
	sum := sha256.Sum256([]byte(strings.Join(columns, "\\n")))
	return hex.EncodeToString(sum[:])
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "schema.changed",
		GroupID: "metasense",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		event, ok := parseEvent(msg.Value)
		if !ok {
			if err := dlqWriter.WriteMessages(ctx, kafka.Message{Key: msg.Key, Value: msg.Value}); err != nil {
				continue
			}
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		schemaHash := schemaHashOf(event.Columns)
		seen, err := store.Seen(ctx, event.Entity, schemaHash)
		if err != nil {
			continue
		}
		if seen {
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		columns := event.Columns
		parts := (len(columns) + maxColumnsPerJob - 1) / maxColumnsPerJob
		failed := false
		for start := 0; start < len(columns); start += maxColumnsPerJob {
			end := start + maxColumnsPerJob
			if end > len(columns) {
				end = len(columns)
			}
			job := Job{
				Entity:     event.Entity,
				Owner:      event.Owner,
				SchemaHash: schemaHash,
				Columns:    columns[start:end],
				Part:       start/maxColumnsPerJob + 1,
				Parts:      parts,
			}
			if err := store.Enqueue(ctx, job); err != nil {
				failed = true
				break
			}
		}
		if failed {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import spray.json._

final case class Job(entity: String, owner: String, columns: List[String])

object ScanIntake {
  // TODO: this draft lets the client commit on its own schedule, enqueues entities of any size as
  // one job, re-scans schemas it has already seen, and trusts the payload shape. Review all four.
  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "metasense")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("schema.changed"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val fields = record.value().parseJson.asJsObject.fields
        val columns = fields("columns").convertTo[List[String]]
        JobStore.enqueue(Job(fields("entity").convertTo[String], fields("owner").convertTo[String], columns))
      }
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

import scala.util.Try

final case class SchemaChanged(entity: String, owner: String, columns: List[String])
final case class Job(entity: String, owner: String, schemaHash: String, columns: List[String], part: Int, parts: Int)

object ScanIntake {
  val MaxColumnsPerJob = 150
  val DlqTopic = "schema.changed.dlq"

  val store = JobStore.open()

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props
  })

  def parseEvent(raw: String): Option[SchemaChanged] =
    Try(raw.parseJson.asJsObject.fields).toOption.flatMap { fields =>
      val entity = fields.get("entity").collect { case JsString(s) if s.nonEmpty => s }
      val owner = fields.get("owner").collect { case JsString(s) if s.nonEmpty => s }
      val columns = fields.get("columns").collect { case JsArray(items) =>
        items.toList.collect { case JsString(s) if s.nonEmpty => s }
      }
      for {
        e <- entity
        o <- owner
        c <- columns if c.nonEmpty && c.size == fields("columns").asInstanceOf[JsArray].elements.size
      } yield SchemaChanged(e, o, c)
    }

  def schemaHashOf(columns: List[String]): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(columns.mkString("\\n").getBytes("UTF-8"))
    digest.map("%02x".format(_)).mkString
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "metasense")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("schema.changed"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        parseEvent(record.value()) match {
          case None =>
            producer.send(new ProducerRecord(DlqTopic, record.key(), record.value())).get()
            consumer.commitSync()
          case Some(event) =>
            val schemaHash = schemaHashOf(event.columns)
            if (!store.seen(event.entity, schemaHash)) {
              val groups = event.columns.grouped(MaxColumnsPerJob).toList
              groups.zipWithIndex.foreach { case (slice, index) =>
                store.enqueue(Job(event.entity, event.owner, schemaHash, slice, index + 1, groups.size))
              }
            }
            consumer.commitSync()
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

struct Job {
  std::string entity;
  std::string owner;
  std::vector<std::string> columns;
};

struct JobStore {
  void enqueue(const Job& job);
};

JobStore store;

// TODO: this draft lets the client commit on its own schedule, enqueues entities of any size as
// one job, re-scans schemas it has already seen, and trusts the payload shape. Review all four.
void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metasense", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"schema.changed"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    store.enqueue(Job{event["entity"].get<std::string>(), event["owner"].get<std::string>(),
                      event["columns"].get<std::vector<std::string>>()});
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxColumnsPerJob = 150;
const std::string kDlqTopic = "schema.changed.dlq";

struct SchemaChanged {
  std::string entity;
  std::string owner;
  std::vector<std::string> columns;
};

struct Job {
  std::string entity;
  std::string owner;
  std::string schemaHash;
  std::vector<std::string> columns;
  int part;
  int parts;
};

struct JobStore {
  bool seen(const std::string& entity, const std::string& schemaHash);
  void enqueue(const Job& job);
};

JobStore store;
std::string sha256Hex(const std::string& text);

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::optional<SchemaChanged> parseEvent(const RdKafka::Message& msg) {
  const auto* begin = static_cast<const char*>(msg.payload());
  const json event = json::parse(begin, begin + msg.len(), nullptr, false);
  if (!event.is_object()) return std::nullopt;
  const auto entity = event.value("entity", std::string());
  const auto owner = event.value("owner", std::string());
  if (entity.empty() || owner.empty()) return std::nullopt;
  if (!event.contains("columns") || !event["columns"].is_array() || event["columns"].empty()) return std::nullopt;
  std::vector<std::string> columns;
  for (const auto& c : event["columns"]) {
    if (!c.is_string() || c.get<std::string>().empty()) return std::nullopt;
    columns.push_back(c.get<std::string>());
  }
  return SchemaChanged{entity, owner, columns};
}

std::string schemaHashOf(const std::vector<std::string>& columns) {
  std::string joined;
  for (std::size_t i = 0; i < columns.size(); i++) {
    if (i > 0) joined += "\\n";
    joined += columns[i];
  }
  return sha256Hex(joined);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metasense", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"schema.changed"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = parseEvent(*msg);
    if (!event) {
      const std::string key = msg->key() ? *msg->key() : std::string();
      producer->produce(kDlqTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, msg->payload(),
                        msg->len(), key.data(), key.size(), 0, nullptr);
      producer->flush(2000);
      consumer->commitSync(msg.get());
      continue;
    }
    const auto schemaHash = schemaHashOf(event->columns);
    if (store.seen(event->entity, schemaHash)) {
      consumer->commitSync(msg.get());
      continue;
    }
    const auto& columns = event->columns;
    const int parts = static_cast<int>((columns.size() + kMaxColumnsPerJob - 1) / kMaxColumnsPerJob);
    for (std::size_t start = 0; start < columns.size(); start += kMaxColumnsPerJob) {
      const auto end = std::min(columns.size(), start + kMaxColumnsPerJob);
      store.enqueue(Job{event->entity, event->owner, schemaHash,
                        std::vector<std::string>(columns.begin() + start, columns.begin() + end),
                        static_cast<int>(start / kMaxColumnsPerJob) + 1, parts});
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand what an offset commit promises. It says "everything before this record is handled", and the draft says it before anything is handled: auto-commit moves the offset on a timer, and the explicit commit at the top of the loop moves it before the enqueue. Four separate defects are being checked: the commit position (enqueue, then commit, so a crash replays instead of loses), validation with a dead-letter topic (a poison record must neither crash the consumer forever nor become a job), deduplication by schema hash (the source's service is paid per entity scanned, and re-emitted events for unchanged schemas are the cheapest thing to skip), and the 150-column split the Metasense team added after seeing the model lose attention on wide tables. Real intakes add a schema registry for the event itself, per-platform rate limits on the producer side, and the mini-batch window the source uses to group requests before they hit the model.`,
};
