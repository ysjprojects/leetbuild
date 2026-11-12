import type {Step} from '@/lib/types';

export const scanRequestsStep: Step = {
  id: 'scan-requests',
  title: 'schema.changed: one job per new schema, committed after the work',
  concept: 'kafka',
  guides: ['consuming-events'],
  file: 'scan_intake',
  focus: ['platforms', 'schema', 'metasense', 'redis'],
  task: `## Task

**Starting point.** The starter's \`consume()\` reads \`schema.changed\` in group \`metasense\` with
auto-commit off, commits each record as soon as it is polled, parses the JSON and queues one job
\`{entity, owner, columns}\` with \`jobs.enqueue\` (\`metasense.jobs\`, provided). It runs the demo and
hides 3 flaws.

**Failure mode the checks target.** A crash between the commit and the enqueue loses a schema change
nobody emits again; a platform that re-emits an unchanged schema pays for a second scan; one
malformed event either crash-loops the partition or becomes a job for an entity named "".

Events are keyed by entity: \`{"entity": "deliveries", "owner": "team-logistics", "columns":
["merchant_id", "status"]}\`.

- Commit a record once its work is done: the job queued, the duplicate skipped, or the payload
  dead-lettered.
- A job carries \`schema_hash\` (\`jobs.schema_hash(columns)\`). Skip an \`(entity, schema_hash)\` that
  \`jobs.seen\` knows, and \`jobs.mark_seen\` it after the enqueue.
- Validate first: \`entity\` and \`owner\` non-empty strings, \`columns\` a non-empty list of non-empty
  strings. A malformed event goes to \`schema.changed.dlq\` with its original key and bytes, and the
  broker acknowledges it before the commit.`,
  sequence: {
    participants: ['Data platforms', 'schema.changed', 'metasense', 'Redis'],
    messages: [
      {from: 'Data platforms', to: 'schema.changed', label: 'produce · key = entity', kind: 'async'},
      {from: 'schema.changed', to: 'metasense', label: 'poll · group metasense', kind: 'async'},
      {from: 'metasense', to: 'schema.changed', label: 'malformed → produce schema.changed.dlq · ack', kind: 'sync'},
      {from: 'metasense', to: 'Redis', label: 'SISMEMBER jobs:seen {entity}:{schema_hash}', kind: 'sync'},
      {from: 'Redis', to: 'metasense', label: '0', kind: 'reply'},
      {from: 'metasense', to: 'Redis', label: 'RPUSH jobs:queue · SADD jobs:seen', kind: 'sync'},
      {from: 'metasense', to: 'schema.changed', label: 'commit the offset, last', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'commit-after-enqueue',
      title: 'Commits the offset after the job is queued',
      detail:
        'When the offset of an event is committed its job is already on `jobs:queue`, and every handled record ends committed. The starter commits as soon as it polls, before the work.',
      match: {
        python: {order: [/jobs\.enqueue\(/, /consumer\.commit\(/]},
        typescript: {order: [/\benqueue\(/, /commitOffsets\(/]},
        go: {order: [/jobs\.Enqueue\(/, /CommitMessages\(/]},
        scala: {order: [/Jobs\.enqueue\(/, /\bcommit\(record\)/]},
        cpp: {order: [/jobs::enqueue\(/, /commitSync\(/]},
      },
    },
    {
      id: 'dedupe-hash',
      title: 'Skips a schema it already queued',
      detail:
        'Jobs carry `schema_hash`; an event whose `(entity, schema_hash)` was seen is committed without a job, and a changed schema is queued again. The starter queues every event it reads.',
      match: {
        python: {all: [/jobs\.schema_hash\(/, /jobs\.seen\(/, /jobs\.mark_seen\(/]},
        typescript: {all: [/schemaHash\(/, /\bseen\(/, /markSeen\(/]},
        go: {all: [/jobs\.SchemaHash\(/, /jobs\.Seen\(/, /jobs\.MarkSeen\(/]},
        scala: {all: [/Jobs\.schemaHash\(/, /Jobs\.seen\(/, /Jobs\.markSeen\(/]},
        cpp: {all: [/jobs::schemaHash\(/, /jobs::seen\(/, /jobs::markSeen\(/]},
      },
    },
    {
      id: 'dead-letter',
      title: 'Dead-letters a malformed event and keeps consuming',
      detail:
        'An event that is not JSON, or lacks an entity, an owner or its columns, lands on `schema.changed.dlq` with its original bytes, gets no job, and is committed; the next event is still processed. The starter crashes on it or queues it.',
      match: {
        python: {all: [/schema\.changed\.dlq/, /producer\.produce\(/, /producer\.flush\(/]},
        typescript: {all: [/schema\.changed\.dlq/, /await producer\.send\(/]},
        go: {all: [/schema\.changed\.dlq/, /\.WriteMessages\(/]},
        scala: {all: [/schema\.changed\.dlq/, /\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/schema\.changed\.dlq/, /->produce\(/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer

from metasense import jobs  # jobs.schema_hash, seen, mark_seen, enqueue

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "metasense",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["schema.changed"])


def consume() -> None:
    """Turn schema.changed events into classification jobs."""
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        event = json.loads(msg.value())
        jobs.enqueue({"entity": event["entity"], "owner": event["owner"], "columns": event["columns"]})
`,
      solution: `import json

from confluent_kafka import Consumer, Producer

from metasense import jobs  # jobs.schema_hash, seen, mark_seen, enqueue

DLQ_TOPIC = "schema.changed.dlq"

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "metasense",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["schema.changed"])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def parse_event(raw: bytes | None) -> dict | None:
    """The event when it is well formed, else None."""
    try:
        event = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(event, dict):
        return None
    entity, owner, columns = event.get("entity"), event.get("owner"), event.get("columns")
    if not isinstance(entity, str) or not entity or not isinstance(owner, str) or not owner:
        return None
    if not isinstance(columns, list) or not columns or not all(isinstance(c, str) and c for c in columns):
        return None
    return {"entity": entity, "owner": owner, "columns": columns}


def dead_letter(msg) -> None:
    """Park the original record on the DLQ; raises (and the offset stays put) unless the broker took it."""
    failed = []
    producer.produce(DLQ_TOPIC, key=msg.key(), value=msg.value(), on_delivery=lambda err, _: failed.append(err) if err else None)
    if producer.flush(5) > 0 or failed:
        raise RuntimeError(f"{DLQ_TOPIC} did not take the record: {failed}")


def consume() -> None:
    """Turn schema.changed events into classification jobs; an offset is committed once its work is done."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = parse_event(msg.value())
        if event is None:
            dead_letter(msg)
        else:
            digest = jobs.schema_hash(event["columns"])
            if not jobs.seen(event["entity"], digest):
                jobs.enqueue({**event, "schema_hash": digest})
                jobs.mark_seen(event["entity"], digest)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {enqueue, markSeen, schemaHash, seen} from 'metasense/jobs';

interface SchemaChanged {
  entity: string;
  owner: string;
  columns: string[];
}

const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
export const consumer = kafka.consumer({groupId: 'metasense'});

/** Turn schema.changed events into classification jobs. */
export async function consume(): Promise<void> {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  await consumer.connect();
  await consumer.subscribe({topic: 'schema.changed', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(String(message.value)) as SchemaChanged;
      await enqueue({entity: event.entity, owner: event.owner, columns: event.columns});
    },
  });
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {enqueue, markSeen, schemaHash, seen} from 'metasense/jobs';

export const DLQ_TOPIC = 'schema.changed.dlq';

interface SchemaChanged {
  entity: string;
  owner: string;
  columns: string[];
}

const kafka = new Kafka({clientId: 'metasense', brokers: ['kafka:9092']});
export const consumer = kafka.consumer({groupId: 'metasense'});
const producer = kafka.producer();

/** The event when it is well formed, else null. */
function parseEvent(raw: Buffer | null): SchemaChanged | null {
  let event: unknown;
  try {
    event = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  const {entity, owner, columns} = event as Record<string, unknown>;
  if (typeof entity !== 'string' || entity === '' || typeof owner !== 'string' || owner === '') return null;
  if (!Array.isArray(columns) || columns.length === 0) return null;
  if (!columns.every(c => typeof c === 'string' && c !== '')) return null;
  return {entity, owner, columns: columns as string[]};
}

/** Turn schema.changed events into classification jobs; an offset is committed once its work is done. */
export async function consume(): Promise<void> {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: 'schema.changed', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = parseEvent(message.value);
      if (event === null) {
        // Rejects unless the broker took it: then the offset stays put and the record comes back.
        await producer.send({topic: DLQ_TOPIC, messages: [{key: message.key, value: message.value}], acks: -1});
      } else {
        const digest = schemaHash(event.columns);
        if (!(await seen(event.entity, digest))) {
          await enqueue({...event, schema_hash: digest});
          await markSeen(event.entity, digest);
        }
      }
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
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

	"metasense/jobs" // jobs.SchemaHash, Seen, MarkSeen, Enqueue
)

type schemaChanged struct {
	Entity  string   \`json:"entity"\`
	Owner   string   \`json:"owner"\`
	Columns []string \`json:"columns"\`
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "metasense",
	Topic:   "schema.changed",
})

// consume turns schema.changed events into classification jobs.
func consume(ctx context.Context) error {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event schemaChanged
		json.Unmarshal(msg.Value, &event)
		if err := jobs.Enqueue(ctx, jobs.Job{Entity: event.Entity, Owner: event.Owner, Columns: event.Columns}); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	"metasense/jobs" // jobs.SchemaHash, Seen, MarkSeen, Enqueue
)

const dlqTopic = "schema.changed.dlq"

type schemaChanged struct {
	Entity  string   \`json:"entity"\`
	Owner   string   \`json:"owner"\`
	Columns []string \`json:"columns"\`
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "metasense",
	Topic:   "schema.changed",
})

var dlq = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: dlqTopic, RequiredAcks: kafka.RequireAll}

// parseEvent is the event and whether it is well formed.
func parseEvent(raw []byte) (schemaChanged, bool) {
	var event schemaChanged
	if err := json.Unmarshal(raw, &event); err != nil || event.Entity == "" || event.Owner == "" || len(event.Columns) == 0 {
		return event, false
	}
	for _, column := range event.Columns {
		if column == "" {
			return event, false
		}
	}
	return event, true
}

// handle does a record's work: dead-letter it, skip a schema already queued, or queue its job.
func handle(ctx context.Context, msg kafka.Message) error {
	event, ok := parseEvent(msg.Value)
	if !ok {
		// Returns an error unless the broker took it: then the offset stays put and the record comes back.
		return dlq.WriteMessages(ctx, kafka.Message{Key: msg.Key, Value: msg.Value})
	}
	digest := jobs.SchemaHash(event.Columns)
	queued, err := jobs.Seen(ctx, event.Entity, digest)
	if err != nil || queued {
		return err
	}
	job := jobs.Job{Entity: event.Entity, Owner: event.Owner, SchemaHash: digest, Columns: event.Columns}
	if err := jobs.Enqueue(ctx, job); err != nil {
		return err
	}
	return jobs.MarkSeen(ctx, event.Entity, digest)
}

// consume turns schema.changed events into classification jobs; an offset is committed once its work is done.
func consume(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := handle(ctx, msg); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import spray.json._

import metasense.Jobs // Jobs.schemaHash, seen, markSeen, enqueue

import scala.jdk.CollectionConverters._

object ScanIntake {
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "metasense")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("schema.changed").asJava)

  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  /** Turn schema.changed events into classification jobs. */
  def consume(): Unit = {
    // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        commit(record)
        val event = record.value.parseJson.asJsObject.fields
        val columns = event("columns").asInstanceOf[JsArray].elements.map(_.asInstanceOf[JsString].value)
        Jobs.enqueue(Jobs.Job(event("entity").asInstanceOf[JsString].value, event("owner").asInstanceOf[JsString].value, "", columns))
      }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._

import metasense.Jobs // Jobs.schemaHash, seen, markSeen, enqueue

import scala.jdk.CollectionConverters._
import scala.util.Try

object ScanIntake {
  val DlqTopic = "schema.changed.dlq"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "metasense")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("schema.changed").asJava)

  private val producer: KafkaProducer[String, String] = {
    val p = new Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p.put("acks", "all")
    new KafkaProducer[String, String](p, new StringSerializer, new StringSerializer)
  }

  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  /** The event (entity, owner, columns) when it is well formed. */
  private def parseEvent(raw: String): Option[(String, String, Seq[String])] =
    Try(raw.parseJson.asJsObject.fields).toOption.flatMap { fields =>
      (fields.get("entity"), fields.get("owner"), fields.get("columns")) match {
        case (Some(JsString(entity)), Some(JsString(owner)), Some(JsArray(cols))) if entity.nonEmpty && owner.nonEmpty && cols.nonEmpty =>
          val columns = cols.collect { case JsString(c) if c.nonEmpty => c }
          if (columns.size == cols.size) Some((entity, owner, columns)) else None
        case _ => None
      }
    }

  /** Turn schema.changed events into classification jobs; an offset is committed once its work is done. */
  def consume(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        parseEvent(record.value) match {
          case None =>
            // Throws unless the broker took it: then the offset stays put and the record comes back.
            producer.send(new ProducerRecord[String, String](DlqTopic, record.key, record.value)).get()
          case Some((entity, owner, columns)) =>
            val digest = Jobs.schemaHash(columns)
            if (!Jobs.seen(entity, digest)) {
              Jobs.enqueue(Jobs.Job(entity, owner, digest, columns))
              Jobs.markSeen(entity, digest)
            }
        }
        commit(record)
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

#include "metasense/jobs.h"  // jobs::schemaHash, seen, markSeen, enqueue

using json = nlohmann::json;

std::unique_ptr<RdKafka::KafkaConsumer> makeConsumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metasense", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"schema.changed"});
  return consumer;
}

auto consumer = makeConsumer();

// Turns schema.changed events into classification jobs.
void consume() {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    jobs::enqueue(json{{"entity", event["entity"]}, {"owner", event["owner"]}, {"columns", event["columns"]}});
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "metasense/jobs.h"  // jobs::schemaHash, seen, markSeen, enqueue

using json = nlohmann::json;

const std::string kDlqTopic = "schema.changed.dlq";

std::unique_ptr<RdKafka::KafkaConsumer> makeConsumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "metasense", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"schema.changed"});
  return consumer;
}

// The delivery report of the dead letter in flight.
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
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = makeConsumer();
auto producer = makeProducer();

struct SchemaChanged {
  std::string entity;
  std::string owner;
  std::vector<std::string> columns;
};

// The event when it is well formed.
std::optional<SchemaChanged> parseEvent(const std::string& raw) {
  const json event = json::parse(raw, nullptr, false);
  if (!event.is_object()) return std::nullopt;
  const auto text = [&event](const char* name) {
    return event.contains(name) && event[name].is_string() ? event[name].get<std::string>() : std::string();
  };
  SchemaChanged parsed{text("entity"), text("owner"), {}};
  if (parsed.entity.empty() || parsed.owner.empty() || !event.contains("columns") || !event["columns"].is_array()) return std::nullopt;
  for (const json& column : event["columns"]) {
    if (!column.is_string() || column.get<std::string>().empty()) return std::nullopt;
    parsed.columns.push_back(column.get<std::string>());
  }
  if (parsed.columns.empty()) return std::nullopt;
  return parsed;
}

// Parks the original record on the DLQ; throws (and the offset stays put) unless the broker took it.
void deadLetter(const RdKafka::Message& msg) {
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kDlqTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, msg.payload(),
                                             msg.len(), msg.key_pointer(), msg.key_len(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(5000);
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) throw std::runtime_error(kDlqTopic + " did not take the record: " + RdKafka::err2str(err));
}

// Turns schema.changed events into classification jobs; an offset is committed once its work is done.
void consume() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = parseEvent(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    if (!event) {
      deadLetter(*msg);
    } else {
      const std::string digest = jobs::schemaHash(event->columns);
      if (!jobs::seen(event->entity, digest)) {
        jobs::enqueue(json{{"entity", event->entity}, {"owner", event->owner}, {"schema_hash", digest}, {"columns", event->columns}});
        jobs::markSeen(event->entity, digest);
      }
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

from metasense import jobs

TOPIC = "schema.changed"
DLQ = "schema.changed.dlq"
GROUP = "metasense"


def _seed(ctx, entity, columns, owner="team-logistics"):
    ctx.kafka.seed(TOPIC, key=entity, value=json.dumps({"entity": entity, "owner": owner, "columns": columns}))


def _queued(ctx):
    return [json.loads(raw) for raw in ctx.redis.lrange("jobs:queue", 0, -1)]


def _consume(ctx):
    m = ctx.load("scan_intake")
    try:
        ctx.drain(m.consume)
    except Exception as exc:
        raise AssertionError(f"consume() stopped with {type(exc).__name__}: {exc}") from exc


def check_commit_after_enqueue(ctx):
    _seed(ctx, "deliveries", ["merchant_id", "status", "delivery_time"])
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(ctx.redis.llen("jobs:queue")))
    _consume(ctx)
    assert at_commit, "the offset of the deliveries event was never committed"
    assert at_commit[0] == 1, "the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed on a timer, before the job existed"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"{ctx.kafka.lag(GROUP, TOPIC)} handled record(s) left uncommitted"


def check_dedupe_hash(ctx):
    columns = ["merchant_id", "status"]
    _seed(ctx, "deliveries", columns)
    _seed(ctx, "deliveries", columns)  # the platform re-emits an unchanged schema
    _seed(ctx, "deliveries", columns + ["passport_no"])
    _consume(ctx)
    hashes = [job.get("schema_hash") for job in _queued(ctx)]
    want = [jobs.schema_hash(columns), jobs.schema_hash(columns + ["passport_no"])]
    assert len(hashes) == 2, f"three events (one re-emitted unchanged) queued {len(hashes)} jobs, expected 2: the unchanged schema must not be scanned again"
    assert hashes == want, f"the jobs carry schema_hash {hashes}, expected jobs.schema_hash(columns) of each schema: {want}"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "the skipped duplicate must be committed too, or it is redelivered forever"


def check_dead_letter(ctx):
    ctx.kafka.seed(TOPIC, key="broken", value=b"{not json")
    nameless = json.dumps({"entity": "", "owner": "team-x", "columns": ["a"]})
    ctx.kafka.seed(TOPIC, key="nameless", value=nameless)
    _seed(ctx, "deliveries", ["merchant_id"])
    _consume(ctx)
    parked = sorted(bytes(r.value).decode() for r in ctx.kafka.records(DLQ))
    assert parked == sorted(["{not json", nameless]), f"{DLQ} holds {parked}, expected the two malformed payloads as they arrived"
    keys = sorted(bytes(r.key).decode() for r in ctx.kafka.records(DLQ) if r.key is not None)
    assert keys == ["broken", "nameless"], f"the dead letters carry keys {keys}, expected the original keys"
    entities = [job.get("entity") for job in _queued(ctx)]
    assert entities == ["deliveries"], f"jobs:queue holds jobs for {entities}, expected only deliveries"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "a dead-lettered record must be committed, or it comes back forever"
`,
    typescript: `const TOPIC = 'schema.changed';
const DLQ = 'schema.changed.dlq';
const GROUP = 'metasense';

function seed(ctx, entity: string, columns: string[], owner = 'team-logistics') {
  ctx.kafka.seed(TOPIC, {key: entity, value: JSON.stringify({entity, owner, columns})});
}

const queued = ctx => (ctx.redis.lrange('jobs:queue', 0, -1) as string[]).map(raw => JSON.parse(raw));

async function consume(ctx) {
  const m = ctx.load('scan_intake');
  try {
    await ctx.drain(m.consume());
  } catch (e) {
    assert.fail(\`consume() stopped with \${e instanceof Error ? e.message : String(e)}\`);
  }
}

export async function check_commit_after_enqueue(ctx) {
  seed(ctx, 'deliveries', ['merchant_id', 'status', 'delivery_time']);
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ctx.redis.llen('jobs:queue')));
  await consume(ctx);
  assert(atCommit.length > 0, 'the offset of the deliveries event was never committed');
  assert.equal(atCommit[0], 1, 'the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed on a timer, before the job existed');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'every handled record must be committed');
}

export async function check_dedupe_hash(ctx) {
  const {schemaHash} = ctx.load('/support/metasense/jobs.ts');
  const columns = ['merchant_id', 'status'];
  seed(ctx, 'deliveries', columns);
  seed(ctx, 'deliveries', columns); // the platform re-emits an unchanged schema
  seed(ctx, 'deliveries', [...columns, 'passport_no']);
  await consume(ctx);
  const hashes = queued(ctx).map(job => job.schema_hash);
  assert.equal(hashes.length, 2, \`three events (one re-emitted unchanged) queued \${hashes.length} jobs, expected 2: the unchanged schema must not be scanned again\`);
  const want = [schemaHash(columns), schemaHash([...columns, 'passport_no'])];
  assert.deepEqual(hashes, want, \`the jobs carry schema_hash \${JSON.stringify(hashes)}, expected schemaHash(columns) of each schema\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'the skipped duplicate must be committed too, or it is redelivered forever');
}

export async function check_dead_letter(ctx) {
  ctx.kafka.seed(TOPIC, {key: 'broken', value: '{not json'});
  const nameless = JSON.stringify({entity: '', owner: 'team-x', columns: ['a']});
  ctx.kafka.seed(TOPIC, {key: 'nameless', value: nameless});
  seed(ctx, 'deliveries', ['merchant_id']);
  await consume(ctx);
  const parked = [...ctx.kafka.values(DLQ)].sort();
  assert.deepEqual(parked, ['{not json', nameless].sort(), \`\${DLQ} holds \${JSON.stringify(parked)}, expected the two malformed payloads as they arrived\`);
  const keys = [...ctx.kafka.keys(DLQ)].sort();
  assert.deepEqual(keys, ['broken', 'nameless'], \`the dead letters carry keys \${JSON.stringify(keys)}, expected the original keys\`);
  const entities = queued(ctx).map(job => job.entity);
  assert.deepEqual(entities, ['deliveries'], \`jobs:queue holds jobs for \${JSON.stringify(entities)}, expected only deliveries\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'a dead-lettered record must be committed, or it comes back forever');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"metasense/jobs"

	"leetbuild/harness"
)

const (
	intakeTopic = "schema.changed"
	intakeDLQ   = "schema.changed.dlq"
	intakeGroup = "metasense"
)

func intakeSeed(ctx *harness.Ctx, entity string, columns []string) {
	value, _ := json.Marshal(map[string]any{"entity": entity, "owner": "team-logistics", "columns": columns})
	ctx.Kafka.Seed(intakeTopic, entity, value)
}

func intakeQueued(ctx *harness.Ctx) []jobs.Job {
	var queued []jobs.Job
	for _, raw := range ctx.Redis.LRange("jobs:queue", 0, -1) {
		var job jobs.Job
		ctx.NoError(json.Unmarshal([]byte(raw), &job), "a job on jobs:queue must be JSON")
		queued = append(queued, job)
	}
	return queued
}

// intakeConsume runs the learner's loop until it waits for records that will not come, then stops it.
func intakeConsume(ctx *harness.Ctx) {
	c, cancel := context.WithCancel(context.Background())
	var err error
	ctx.Drain(func() { err = consume(c) })
	cancel()
	ctx.Settle()
	if err != nil && !errors.Is(err, context.Canceled) {
		ctx.Fatalf("consume returned an error: %v", err)
	}
}

func CheckCommitAfterEnqueue(ctx *harness.Ctx) {
	intakeSeed(ctx, "deliveries", []string{"merchant_id", "status", "delivery_time"})
	var atCommit []int64
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, ctx.Redis.LLen("jobs:queue")) })
	intakeConsume(ctx)
	ctx.Assert(len(atCommit) > 0, "the offset of the deliveries event was never committed")
	ctx.Equal(atCommit[0], 1, "the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit; jobs at the first commit")
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "offsets were auto-committed before the job existed; auto-commit events")
	ctx.Equal(ctx.Kafka.Lag(intakeGroup, intakeTopic), 0, "every handled record must be committed; records left")
}

func CheckDedupeHash(ctx *harness.Ctx) {
	columns := []string{"merchant_id", "status"}
	changed := []string{"merchant_id", "status", "passport_no"}
	intakeSeed(ctx, "deliveries", columns)
	intakeSeed(ctx, "deliveries", columns) // the platform re-emits an unchanged schema
	intakeSeed(ctx, "deliveries", changed)
	intakeConsume(ctx)
	queued := intakeQueued(ctx)
	ctx.Equal(len(queued), 2, "three events (one re-emitted unchanged) must queue 2 jobs: the unchanged schema must not be scanned again; jobs")
	hashes := []string{queued[0].SchemaHash, queued[1].SchemaHash}
	ctx.Equal(hashes, []string{jobs.SchemaHash(columns), jobs.SchemaHash(changed)}, "the jobs' schema_hash must be jobs.SchemaHash(columns) of each schema")
	ctx.Equal(ctx.Kafka.Lag(intakeGroup, intakeTopic), 0, "the skipped duplicate must be committed too, or it is redelivered forever; records left")
}

func CheckDeadLetter(ctx *harness.Ctx) {
	ctx.Kafka.Seed(intakeTopic, "broken", "{not json")
	nameless := \`{"entity":"","owner":"team-x","columns":["a"]}\`
	ctx.Kafka.Seed(intakeTopic, "nameless", nameless)
	intakeSeed(ctx, "deliveries", []string{"merchant_id"})
	intakeConsume(ctx)
	parked := ctx.Kafka.Values(intakeDLQ)
	sort.Strings(parked)
	want := []string{nameless, "{not json"}
	sort.Strings(want)
	ctx.Equal(parked, want, "%s must hold the two malformed payloads as they arrived", intakeDLQ)
	keys := ctx.Kafka.Keys(intakeDLQ)
	sort.Strings(keys)
	ctx.Equal(keys, []string{"broken", "nameless"}, "the dead letters must carry the original keys")
	var entities []string
	for _, job := range intakeQueued(ctx) {
		entities = append(entities, job.Entity)
	}
	ctx.Equal(entities, []string{"deliveries"}, "jobs:queue must hold a job for deliveries only")
	ctx.Equal(ctx.Kafka.Lag(intakeGroup, intakeTopic), 0, "a dead-lettered record must be committed, or it comes back forever; records left")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "metasense/jobs.h"

namespace {

const std::string kTopic = "schema.changed";
const std::string kDlq = "schema.changed.dlq";
const std::string kGroup = "metasense";

void seed(harness::Ctx& ctx, const std::string& entity, const std::vector<std::string>& columns) {
  ctx.Kafka.Seed(kTopic, entity, nlohmann::json{{"entity", entity}, {"owner", "team-logistics"}, {"columns", columns}}.dump());
}

std::vector<nlohmann::json> queued(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& raw : ctx.Redis.LRange("jobs:queue", 0, -1)) {
    const auto job = nlohmann::json::parse(raw, nullptr, false);
    ctx.Assert(job.is_object(), "a job on jobs:queue must be a JSON object, got %s", raw);
    out.push_back(job);
  }
  return out;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

// The learner's consume loop, on a thread of its own, until it waits for records that will not come.
struct runner {
  bool done = false;
  std::optional<std::string> err;
};
std::shared_ptr<runner> active;

void runConsume(harness::Ctx& ctx) {
  if (!active || active->done) {
    auto r = active = std::make_shared<runner>();
    lb::spawn([r] {
      try {
        consume();
      } catch (const std::exception& e) {
        r->err = std::string(e.what());
      } catch (...) {
        r->err = harness::CurrentExceptionType();
      }
      r->done = true;
    });
  }
  ctx.Settle();
  if (active->done && active->err) ctx.Fatalf("consume() stopped with %s", *active->err);
}

}  // namespace

void CheckCommitAfterEnqueue(harness::Ctx& ctx) {
  seed(ctx, "deliveries", {"merchant_id", "status", "delivery_time"});
  std::vector<long long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ctx.Redis.LLen("jobs:queue")); });
  runConsume(ctx);
  ctx.Assert(!atCommit.empty(), "the offset of the deliveries event was never committed");
  ctx.Equal(atCommit[0], 1LL, "the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit; jobs at the first commit");
  ctx.Equal(ctx.Kafka.EventsOf("auto-commit").size(), 0, "offsets were auto-committed before the job existed; auto-commit events");
  ctx.Equal(ctx.Kafka.Lag(kGroup, kTopic), 0, "every handled record must be committed; records left");
}

void CheckDedupeHash(harness::Ctx& ctx) {
  const std::vector<std::string> columns = {"merchant_id", "status"};
  const std::vector<std::string> changed = {"merchant_id", "status", "passport_no"};
  seed(ctx, "deliveries", columns);
  seed(ctx, "deliveries", columns);  // the platform re-emits an unchanged schema
  seed(ctx, "deliveries", changed);
  runConsume(ctx);
  const auto jobsQueued = queued(ctx);
  ctx.Equal(jobsQueued.size(), 2, "three events (one re-emitted unchanged) must queue 2 jobs: the unchanged schema must not be scanned again; jobs");
  ctx.Equal(std::vector<std::string>{field(jobsQueued[0], "schema_hash"), field(jobsQueued[1], "schema_hash")},
            std::vector<std::string>{jobs::schemaHash(columns), jobs::schemaHash(changed)},
            "the jobs' schema_hash must be jobs::schemaHash(columns) of each schema");
  ctx.Equal(ctx.Kafka.Lag(kGroup, kTopic), 0, "the skipped duplicate must be committed too, or it is redelivered forever; records left");
}

void CheckDeadLetter(harness::Ctx& ctx) {
  ctx.Kafka.Seed(kTopic, "broken", "{not json");
  const std::string nameless = R"({"entity":"","owner":"team-x","columns":["a"]})";
  ctx.Kafka.Seed(kTopic, "nameless", nameless);
  seed(ctx, "deliveries", {"merchant_id"});
  runConsume(ctx);
  auto parked = ctx.Kafka.Values(kDlq);
  std::sort(parked.begin(), parked.end());
  std::vector<std::string> want = {"{not json", nameless};
  std::sort(want.begin(), want.end());
  ctx.Equal(parked, want, "%s must hold the two malformed payloads as they arrived", kDlq);
  auto keys = ctx.Kafka.Keys(kDlq);
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, std::vector<std::string>{"broken", "nameless"}, "the dead letters must carry the original keys");
  std::vector<std::string> entities;
  for (const auto& job : queued(ctx)) entities.push_back(field(job, "entity"));
  ctx.Equal(entities, std::vector<std::string>{"deliveries"}, "jobs:queue must hold a job for deliveries only");
  ctx.Equal(ctx.Kafka.Lag(kGroup, kTopic), 0, "a dead-lettered record must be committed, or it comes back forever; records left");
}
`,
  },
  hints: [
    'Restart the consumer while Redis is slow and one table never gets classified; a platform that re-emits its schemas every hour doubles the model bill; one event with an empty entity name stops the partition or queues junk.',
    'The loop commits before it does anything, so the offset claims work that has not happened. Nothing remembers which schema of an entity is already queued, and the parse trusts every payload it reads.',
    'Commit at the end of every branch; `jobs.schema_hash(columns)`, skip when `jobs.seen`, else enqueue with `schema_hash` and `jobs.mark_seen`; validate into `None` and produce the raw record to `schema.changed.dlq`, flush, check the delivery, then commit.',
  ],
  debrief: `An offset commit says "everything before this record is handled", and the fix makes that true for each of the three outcomes: a job queued, a duplicate skipped, a payload parked. The dead-letter topic exists because a poison record otherwise has two endings, a crash loop on one offset or a job for an entity named "", and a parked payload is the only one someone can fix later. The schema hash is the cheapest check in the pipeline and it guards the most expensive call. Grab's intake also rate-limits each producing platform and groups requests into mini-batches before they reach the model; a registry for the event's own schema would turn most of the dead letters into producer errors.`,
};
