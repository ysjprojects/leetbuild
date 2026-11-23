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
        'When the offset of an event is committed its job is already on `jobs:queue`, and every handled record ends committed. The schema is marked seen only after its job is queued, and an event whose job Redis refused leaves its offset where it was. The starter commits as soon as it polls, before the work.',
      match: {
        python: {order: [/jobs\.enqueue\(/, /consumer\.commit\(/]},
        typescript: {order: [/\benqueue\(/, /commitOffsets\(/]},
        go: {order: [/jobs\.Enqueue\(/, /CommitMessages\(/]},
        cpp: {order: [/jobs::enqueue\(/, /commitSync\(/]},
      },
    },
    {
      id: 'dedupe-hash',
      title: 'Skips a schema it already queued',
      detail:
        'Jobs carry `schema_hash`; an event whose `(entity, schema_hash)` is in `jobs:seen`, even from an earlier run, is committed without a job, while a changed schema, or another entity with the same columns, is queued and marked seen. The starter queues every event it reads.',
      match: {
        python: {all: [/jobs\.schema_hash\(/, /jobs\.seen\(/, /jobs\.mark_seen\(/]},
        typescript: {all: [/schemaHash\(/, /\bseen\(/, /markSeen\(/]},
        go: {all: [/jobs\.SchemaHash\(/, /jobs\.Seen\(/, /jobs\.MarkSeen\(/]},
        cpp: {all: [/jobs::schemaHash\(/, /jobs::seen\(/, /jobs::markSeen\(/]},
      },
    },
    {
      id: 'dead-letter',
      title: 'Dead-letters a malformed event and keeps consuming',
      detail:
        'An event that is not a JSON object, or lacks a non-empty entity, owner or list of non-empty column names, lands on `schema.changed.dlq` with its original key and bytes, gets no job, and is committed only once the broker acknowledged it, even when it is slow or refuses one; the next event is still processed. The starter crashes on it or queues it.',
      match: {
        python: {all: [/schema\.changed\.dlq/, /producer\.produce\(/, /producer\.flush\(/]},
        typescript: {all: [/schema\.changed\.dlq/, /await producer\.send\(/]},
        go: {all: [/schema\.changed\.dlq/, /\.WriteMessages\(/]},
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


def _seed_raw(ctx, key, value):
    # One partition: the records are handled in the order they are seeded.
    return ctx.kafka.seed(TOPIC, key=key, value=value, partition=0)


def _seed(ctx, entity, columns, owner="team-logistics"):
    return _seed_raw(ctx, entity, json.dumps({"entity": entity, "owner": owner, "columns": columns}))


def _queued(ctx):
    return [json.loads(raw) for raw in ctx.redis.lrange("jobs:queue", 0, -1)]


def _consume(ctx, may_fail=False):
    """Run the loop; with may_fail, an error stopping it is returned instead of failing the check."""
    m = ctx.load("scan_intake")
    try:
        ctx.drain(m.consume)
    except Exception as exc:
        if not may_fail:
            raise AssertionError(f"consume() stopped with {type(exc).__name__}: {exc}") from exc
        return f"{type(exc).__name__}: {exc}"
    return None


def _committed(ctx):
    return ctx.kafka.committed_offset(GROUP, TOPIC, 0) or 0


def check_commit_after_enqueue(ctx):
    columns = ["merchant_id", "status", "delivery_time"]
    _seed(ctx, "deliveries", columns)
    _seed(ctx, "payments", ["card_no"])
    _seed(ctx, "orders", ["order_id"])
    snap = {}

    def refuse_writes():
        # Snapshot the deliveries job, then Redis refuses every later RPUSH jobs:queue (WRONGTYPE).
        snap["jobs"] = ctx.redis.lrange("jobs:queue", 0, -1)
        snap["seen"] = ctx.redis.sismember("jobs:seen", f"deliveries:{jobs.schema_hash(columns)}")
        ctx.redis.delete("jobs:queue")
        ctx.redis.set("jobs:queue", "unavailable")

    probe = ctx.redis_after("jobs:queue", refuse_writes)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(probe.fired))
    stopped = _consume(ctx, may_fail=True)
    assert at_commit, f"the offset of the deliveries event was never committed{f' (consume() stopped with {stopped})' if stopped else ''}"
    assert at_commit[0], "the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit"
    assert len(snap.get("jobs", [])) == 1, f"jobs:queue held {snap.get('jobs')} after the first enqueue, expected the deliveries job"
    assert not snap["seen"], "deliveries was in jobs:seen before its job reached jobs:queue: a crash between the two skips the schema for good. jobs.mark_seen after the enqueue"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed on a timer, before the job existed"
    committed = _committed(ctx)
    assert committed >= 1, "the deliveries event was handled but its offset never committed"
    assert committed == 1, f"Redis refused the payments job (RPUSH jobs:queue answered WRONGTYPE), yet the group committed offset {committed}: payments is lost. A job that was not queued must leave its offset where it was"
    payments = f"payments:{jobs.schema_hash(['card_no'])}"
    assert not ctx.redis.sismember("jobs:seen", payments), "payments is in jobs:seen though its job never reached jobs:queue: its redelivery would be skipped"


def check_dedupe_hash(ctx):
    columns = ["merchant_id", "status"]
    changed = columns + ["passport_no"]
    # orders was queued by an earlier run of the service.
    ctx.redis.sadd("jobs:seen", f"orders:{jobs.schema_hash(['order_id'])}")
    _seed(ctx, "deliveries", columns)
    _seed(ctx, "deliveries", columns)  # the platform re-emits an unchanged schema
    _seed(ctx, "deliveries", changed)
    _seed(ctx, "payments", columns)  # another entity with the same columns
    _seed(ctx, "orders", ["order_id"])
    _consume(ctx)
    queued = _queued(ctx)
    got = [(job.get("entity"), job.get("schema_hash")) for job in queued]
    want = [("deliveries", jobs.schema_hash(columns)), ("deliveries", jobs.schema_hash(changed)), ("payments", jobs.schema_hash(columns))]
    assert len(got) == 3, f"five events queued {len(got)} jobs, expected 3: deliveries once per schema (one re-emitted unchanged), payments (same columns, another entity), and not orders (already in jobs:seen)"
    assert got == want, f"the jobs carry (entity, schema_hash) {got}, expected jobs.schema_hash(columns) of each schema: {want}"
    for job, columns_of in zip(queued, [columns, changed, columns]):
        assert job.get("owner") == "team-logistics" and job.get("columns") == columns_of, f"the job {job} must carry the event's owner and columns"
    members = set(ctx.redis.smembers("jobs:seen"))
    missing = [f"{e}:{h}" for e, h in want if f"{e}:{h}" not in members]
    assert not missing, f"jobs:seen lacks {missing}: a queued schema must be marked seen, or its re-emission after a restart is scanned again"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, "the skipped duplicates must be committed too, or they are redelivered forever"


def check_dead_letter(ctx):
    malformed = {
        "broken": "{not json",
        "nameless": json.dumps({"entity": "", "owner": "team-x", "columns": ["a"]}),
        "ownerless": json.dumps({"entity": "orders", "columns": ["a"]}),
        "numbered": json.dumps({"entity": 7, "owner": "team-x", "columns": ["a"]}),
        "columnless": json.dumps({"entity": "orders", "owner": "team-x", "columns": []}),
        "blank-column": json.dumps({"entity": "orders", "owner": "team-x", "columns": ["order_id", ""]}),
        "numeric-column": json.dumps({"entity": "orders", "owner": "team-x", "columns": ["order_id", 42]}),
        "listed": json.dumps(["orders"]),
    }
    offsets = {key: _seed_raw(ctx, key, value).offset for key, value in malformed.items()}
    good = _seed(ctx, "deliveries", ["merchant_id"]).offset
    # Dead-lettered while the broker is slow to acknowledge, then once while it refuses the record.
    late_value = json.dumps({"entity": "late", "owner": "", "columns": ["a"]})
    late = _seed_raw(ctx, "late", late_value).offset
    lost_value = json.dumps({"entity": "lost", "owner": "team-x", "columns": "a"})
    lost = _seed_raw(ctx, "lost", lost_value).offset
    _seed(ctx, "after", ["merchant_id"])
    expected = {**{k: (o, malformed[k]) for k, o in offsets.items()}, "late": (late, late_value), "lost": (lost, lost_value)}
    early = []

    def on_commit(group, offsets_):
        committed = offsets_.get((TOPIC, 0), 0)
        parked = {bytes(r.value).decode() for r in ctx.kafka.records(DLQ)}
        for key, (offset, value) in expected.items():
            if offset < committed and value not in parked and key not in early:
                early.append(key)
        if committed == good + 1:
            ctx.kafka.stall(DLQ, 3)
        elif committed == late + 1:
            ctx.kafka.fail_next(DLQ)

    ctx.kafka.on_commit(on_commit)
    stopped = _consume(ctx, may_fail=True)
    committed = _committed(ctx)
    why = f" (consume() stopped with {stopped})" if stopped else ""
    assert committed > late, f"the group committed offset {committed}{why}: the dead-lettered records and deliveries must be committed, or they come back forever"
    entities = [job.get("entity") for job in _queued(ctx)]
    assert entities[:1] == ["deliveries"] and set(entities) <= {"deliveries", "after"}, f"jobs:queue holds jobs for {entities}, expected deliveries and no malformed event"
    parked = [bytes(r.value).decode() for r in ctx.kafka.records(DLQ)]
    want = [malformed[k] for k in malformed] + [late_value]
    assert parked[: len(want)] == want, f"{DLQ} holds {parked}, expected the malformed payloads as they arrived, in order: {want}"
    keys = [bytes(r.key).decode() for r in ctx.kafka.records(DLQ) if r.key is not None]
    assert keys[: len(want)] == list(malformed) + ["late"], f"the dead letters carry keys {keys}, expected the original keys"
    assert not early, f"the offsets of {early} were committed before {DLQ} acknowledged them (the broker was slow, then refused one): a crash there loses the payload. Commit once the broker took the dead letter"
`,
    typescript: `const TOPIC = 'schema.changed';
const DLQ = 'schema.changed.dlq';
const GROUP = 'metasense';

// One partition: the records are handled in the order they are seeded.
const seedRaw = (ctx, key: string, value: string): number => ctx.kafka.seed(TOPIC, {key, value, partition: 0}).offset;

function seed(ctx, entity: string, columns: string[], owner = 'team-logistics'): number {
  return seedRaw(ctx, entity, JSON.stringify({entity, owner, columns}));
}

const queued = ctx => (ctx.redis.lrange('jobs:queue', 0, -1) as string[]).map(raw => JSON.parse(raw));

/** Run the loop; with mayFail, an error stopping it is returned instead of failing the check. */
async function consume(ctx, mayFail = false): Promise<string | null> {
  const m = ctx.load('scan_intake');
  try {
    await ctx.drain(m.consume());
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!mayFail) assert.fail(\`consume() stopped with \${why}\`);
    return why;
  }
  return null;
}

export async function check_commit_after_enqueue(ctx) {
  const {schemaHash} = ctx.load('/support/metasense/jobs.ts');
  const columns = ['merchant_id', 'status', 'delivery_time'];
  seed(ctx, 'deliveries', columns);
  seed(ctx, 'payments', ['card_no']);
  seed(ctx, 'orders', ['order_id']);
  const snap: {jobs?: string[]; seen?: boolean} = {};
  // Snapshot the deliveries job, then Redis refuses every later RPUSH jobs:queue (WRONGTYPE).
  const probe = ctx.redisAfter('jobs:queue', () => {
    snap.jobs = ctx.redis.lrange('jobs:queue', 0, -1);
    snap.seen = Number(ctx.redis.sismember('jobs:seen', \`deliveries:\${schemaHash(columns)}\`)) === 1;
    ctx.redis.del('jobs:queue');
    ctx.redis.set('jobs:queue', 'unavailable');
  });
  const atCommit: boolean[] = [];
  ctx.kafka.onCommit(() => atCommit.push(probe.fired));
  const stopped = await consume(ctx, true);
  assert(atCommit.length > 0, \`the offset of the deliveries event was never committed\${stopped ? \` (consume() stopped with \${stopped})\` : ''}\`);
  assert(atCommit[0], 'the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit');
  assert.equal(snap.jobs?.length, 1, \`jobs:queue held \${JSON.stringify(snap.jobs)} after the first enqueue, expected the deliveries job\`);
  assert(!snap.seen, 'deliveries was in jobs:seen before its job reached jobs:queue: a crash between the two skips the schema for good. markSeen after the enqueue');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed on a timer, before the job existed');
  const committed: number = ctx.kafka.committedOffset(GROUP, TOPIC, 0) ?? 0;
  assert(committed >= 1, 'the deliveries event was handled but its offset never committed');
  assert.equal(committed, 1, \`Redis refused the payments job (RPUSH jobs:queue answered WRONGTYPE), yet the group committed offset \${committed}: payments is lost. A job that was not queued must leave its offset where it was\`);
  const payments = \`payments:\${schemaHash(['card_no'])}\`;
  assert(Number(ctx.redis.sismember('jobs:seen', payments)) !== 1, 'payments is in jobs:seen though its job never reached jobs:queue: its redelivery would be skipped');
}

export async function check_dedupe_hash(ctx) {
  const {schemaHash} = ctx.load('/support/metasense/jobs.ts');
  const columns = ['merchant_id', 'status'];
  const changed = [...columns, 'passport_no'];
  // orders was queued by an earlier run of the service.
  ctx.redis.sadd('jobs:seen', \`orders:\${schemaHash(['order_id'])}\`);
  seed(ctx, 'deliveries', columns);
  seed(ctx, 'deliveries', columns); // the platform re-emits an unchanged schema
  seed(ctx, 'deliveries', changed);
  seed(ctx, 'payments', columns); // another entity with the same columns
  seed(ctx, 'orders', ['order_id']);
  await consume(ctx);
  const jobs = queued(ctx);
  const got = jobs.map(job => [job.entity, job.schema_hash]);
  const want = [
    ['deliveries', schemaHash(columns)],
    ['deliveries', schemaHash(changed)],
    ['payments', schemaHash(columns)],
  ];
  assert.equal(got.length, 3, \`five events queued \${got.length} jobs, expected 3: deliveries once per schema (one re-emitted unchanged), payments (same columns, another entity), and not orders (already in jobs:seen)\`);
  assert.deepEqual(got, want, \`the jobs carry (entity, schema_hash) \${JSON.stringify(got)}, expected schemaHash(columns) of each schema: \${JSON.stringify(want)}\`);
  [columns, changed, columns].forEach((cols, i) => {
    assert(jobs[i].owner === 'team-logistics' && JSON.stringify(jobs[i].columns) === JSON.stringify(cols), \`the job \${JSON.stringify(jobs[i])} must carry the event's owner and columns\`);
  });
  const members = new Set(ctx.redis.smembers('jobs:seen') as string[]);
  const missing = want.map(([e, h]) => \`\${e}:\${h}\`).filter(m => !members.has(m));
  assert.deepEqual(missing, [], \`jobs:seen lacks \${JSON.stringify(missing)}: a queued schema must be marked seen, or its re-emission after a restart is scanned again\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, 'the skipped duplicates must be committed too, or they are redelivered forever');
}

export async function check_dead_letter(ctx) {
  const malformed: [string, string][] = [
    ['broken', '{not json'],
    ['nameless', JSON.stringify({entity: '', owner: 'team-x', columns: ['a']})],
    ['ownerless', JSON.stringify({entity: 'orders', columns: ['a']})],
    ['numbered', JSON.stringify({entity: 7, owner: 'team-x', columns: ['a']})],
    ['columnless', JSON.stringify({entity: 'orders', owner: 'team-x', columns: []})],
    ['blank-column', JSON.stringify({entity: 'orders', owner: 'team-x', columns: ['order_id', '']})],
    ['numeric-column', JSON.stringify({entity: 'orders', owner: 'team-x', columns: ['order_id', 42]})],
    ['listed', JSON.stringify(['orders'])],
  ];
  const expected: [string, number, string][] = malformed.map(([key, value]) => [key, seedRaw(ctx, key, value), value]);
  const good = seed(ctx, 'deliveries', ['merchant_id']);
  // Dead-lettered while the broker is slow to acknowledge, then once while it refuses the record.
  const lateValue = JSON.stringify({entity: 'late', owner: '', columns: ['a']});
  const late = seedRaw(ctx, 'late', lateValue);
  const lostValue = JSON.stringify({entity: 'lost', owner: 'team-x', columns: 'a'});
  const lost = seedRaw(ctx, 'lost', lostValue);
  seed(ctx, 'after', ['merchant_id']);
  expected.push(['late', late, lateValue], ['lost', lost, lostValue]);
  const early: string[] = [];
  ctx.kafka.onCommit((_group, offsets: Map<string, number>) => {
    const committed = offsets.get(\`\${TOPIC}|0\`) ?? 0;
    const parked = new Set(ctx.kafka.values(DLQ) as string[]);
    for (const [key, offset, value] of expected) {
      if (offset < committed && !parked.has(value) && !early.includes(key)) early.push(key);
    }
    if (committed === good + 1) ctx.kafka.stall(DLQ, 3);
    else if (committed === late + 1) ctx.kafka.failNext(DLQ);
  });
  const stopped = await consume(ctx, true);
  const committed: number = ctx.kafka.committedOffset(GROUP, TOPIC, 0) ?? 0;
  assert(committed > late, \`the group committed offset \${committed}\${stopped ? \` (consume() stopped with \${stopped})\` : ''}: the dead-lettered records and deliveries must be committed, or they come back forever\`);
  const entities = queued(ctx).map(job => job.entity);
  assert(entities[0] === 'deliveries' && entities.every(e => e === 'deliveries' || e === 'after'), \`jobs:queue holds jobs for \${JSON.stringify(entities)}, expected deliveries and no malformed event\`);
  assert.deepEqual(early, [], \`the offsets of \${JSON.stringify(early)} were committed before \${DLQ} acknowledged them (the broker was slow, then refused one): a crash there loses the payload. Commit once the broker took the dead letter\`);
  const want = [...malformed.map(([, value]) => value), lateValue];
  const parked = (ctx.kafka.values(DLQ) as string[]).slice(0, want.length);
  assert.deepEqual(parked, want, \`\${DLQ} holds \${JSON.stringify(parked)}, expected the malformed payloads as they arrived, in order\`);
  const keys = (ctx.kafka.keys(DLQ) as string[]).slice(0, want.length);
  assert.deepEqual(keys, [...malformed.map(([key]) => key), 'late'], \`the dead letters carry keys \${JSON.stringify(keys)}, expected the original keys\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"metasense/jobs"

	"leetbuild/harness"
)

const (
	kHIntakeTopic = "schema.changed"
	kHIntakeDLQ   = "schema.changed.dlq"
	kHIntakeGroup = "metasense"
)

// intakeSeedRaw puts a record on partition 0: the records are handled in the order they are seeded.
func hIntakeSeedRaw(ctx *harness.Ctx, key, value string) int64 {
	return ctx.Kafka.SeedPartition(kHIntakeTopic, 0, key, value).Offset
}

func hIntakeSeed(ctx *harness.Ctx, entity string, columns []string) int64 {
	value, _ := json.Marshal(map[string]any{"entity": entity, "owner": "team-logistics", "columns": columns})
	return hIntakeSeedRaw(ctx, entity, string(value))
}

func hIntakeQueued(ctx *harness.Ctx) []jobs.Job {
	var queued []jobs.Job
	for _, raw := range ctx.Redis.LRange("jobs:queue", 0, -1) {
		var job jobs.Job
		ctx.NoError(json.Unmarshal([]byte(raw), &job), "a job on jobs:queue must be JSON")
		queued = append(queued, job)
	}
	return queued
}

// intakeConsume runs the learner's loop until it waits for records that will not come, then stops it.
// With mayFail, an error ending the loop is returned instead of failing the check.
func hIntakeConsume(ctx *harness.Ctx, mayFail bool) error {
	c, cancel := context.WithCancel(context.Background())
	var err error
	ctx.Drain(func() { err = consume(c) })
	cancel()
	ctx.Settle()
	if err == nil || errors.Is(err, context.Canceled) {
		return nil
	}
	if !mayFail {
		ctx.Fatalf("consume returned an error: %v", err)
	}
	return err
}

func hIntakeCommitted(ctx *harness.Ctx) int64 {
	committed, _ := ctx.Kafka.Committed(kHIntakeGroup, kHIntakeTopic, 0)
	return committed
}

func hIntakeStopped(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf(" (consume returned %v)", err)
}

func CheckCommitAfterEnqueue(ctx *harness.Ctx) {
	columns := []string{"merchant_id", "status", "delivery_time"}
	hIntakeSeed(ctx, "deliveries", columns)
	hIntakeSeed(ctx, "payments", []string{"card_no"})
	hIntakeSeed(ctx, "orders", []string{"order_id"})
	var firstJobs []string
	seenFirst := false
	// Snapshot the deliveries job, then Redis refuses every later RPUSH jobs:queue (WRONGTYPE).
	probe := ctx.Redis.After("jobs:queue", func() any {
		firstJobs = ctx.Redis.LRange("jobs:queue", 0, -1)
		seenFirst = ctx.Redis.SIsMember("jobs:seen", "deliveries:"+jobs.SchemaHash(columns))
		ctx.Redis.Del("jobs:queue")
		ctx.Redis.Set("jobs:queue", "unavailable")
		return nil
	})
	var atCommit []bool
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, probe.Fired) })
	err := hIntakeConsume(ctx, true)
	ctx.Assert(len(atCommit) > 0, "the offset of the deliveries event was never committed%s", hIntakeStopped(err))
	ctx.Assert(atCommit[0], "the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit")
	ctx.Equal(len(firstJobs), 1, "jobs:queue must hold the deliveries job after the first enqueue; jobs")
	ctx.Assert(!seenFirst, "deliveries was in jobs:seen before its job reached jobs:queue: a crash between the two skips the schema for good. jobs.MarkSeen after the enqueue")
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "offsets were auto-committed before the job existed; auto-commit events")
	committed := hIntakeCommitted(ctx)
	ctx.Assert(committed >= 1, "the deliveries event was handled but its offset never committed")
	ctx.Equal(committed, int64(1), "Redis refused the payments job (RPUSH jobs:queue answered WRONGTYPE), yet the group committed past it: payments is lost. A job that was not queued must leave its offset where it was; committed offset")
	ctx.Assert(!ctx.Redis.SIsMember("jobs:seen", "payments:"+jobs.SchemaHash([]string{"card_no"})), "payments is in jobs:seen though its job never reached jobs:queue: its redelivery would be skipped")
}

func CheckDedupeHash(ctx *harness.Ctx) {
	columns := []string{"merchant_id", "status"}
	changed := []string{"merchant_id", "status", "passport_no"}
	// orders was queued by an earlier run of the service.
	ctx.Redis.Do("SADD", "jobs:seen", "orders:"+jobs.SchemaHash([]string{"order_id"}))
	hIntakeSeed(ctx, "deliveries", columns)
	hIntakeSeed(ctx, "deliveries", columns) // the platform re-emits an unchanged schema
	hIntakeSeed(ctx, "deliveries", changed)
	hIntakeSeed(ctx, "payments", columns) // another entity with the same columns
	hIntakeSeed(ctx, "orders", []string{"order_id"})
	hIntakeConsume(ctx, false)
	queued := hIntakeQueued(ctx)
	ctx.Equal(len(queued), 3, "five events must queue 3 jobs: deliveries once per schema (one re-emitted unchanged), payments (same columns, another entity), and not orders (already in jobs:seen); jobs")
	want := []string{"deliveries:" + jobs.SchemaHash(columns), "deliveries:" + jobs.SchemaHash(changed), "payments:" + jobs.SchemaHash(columns)}
	var got []string
	for _, job := range queued {
		got = append(got, job.Entity+":"+job.SchemaHash)
	}
	ctx.Equal(got, want, "the jobs' entity:schema_hash must carry jobs.SchemaHash(columns) of each schema")
	for i, cols := range [][]string{columns, changed, columns} {
		ctx.Assert(queued[i].Owner == "team-logistics" && strings.Join(queued[i].Columns, ",") == strings.Join(cols, ","), "the job %+v must carry the event's owner and columns", queued[i])
	}
	for _, member := range want {
		ctx.Assert(ctx.Redis.SIsMember("jobs:seen", member), "jobs:seen lacks %s: a queued schema must be marked seen, or its re-emission after a restart is scanned again", member)
	}
	ctx.Equal(ctx.Kafka.Lag(kHIntakeGroup, kHIntakeTopic), int64(0), "the skipped duplicates must be committed too, or they are redelivered forever; records left")
}

func CheckDeadLetter(ctx *harness.Ctx) {
	type parked struct {
		key, value string
		offset     int64
	}
	var malformed []parked
	for _, kv := range [][2]string{
		{"broken", "{not json"},
		{"nameless", \`{"entity":"","owner":"team-x","columns":["a"]}\`},
		{"ownerless", \`{"entity":"orders","columns":["a"]}\`},
		{"numbered", \`{"entity":7,"owner":"team-x","columns":["a"]}\`},
		{"columnless", \`{"entity":"orders","owner":"team-x","columns":[]}\`},
		{"blank-column", \`{"entity":"orders","owner":"team-x","columns":["order_id",""]}\`},
		{"numeric-column", \`{"entity":"orders","owner":"team-x","columns":["order_id",42]}\`},
		{"listed", \`["orders"]\`},
	} {
		malformed = append(malformed, parked{kv[0], kv[1], hIntakeSeedRaw(ctx, kv[0], kv[1])})
	}
	good := hIntakeSeed(ctx, "deliveries", []string{"merchant_id"})
	// Dead-lettered while the broker is slow to acknowledge, then once while it refuses the record.
	late := parked{"late", \`{"entity":"late","owner":"","columns":["a"]}\`, 0}
	late.offset = hIntakeSeedRaw(ctx, late.key, late.value)
	lost := parked{"lost", \`{"entity":"lost","owner":"team-x","columns":"a"}\`, 0}
	lost.offset = hIntakeSeedRaw(ctx, lost.key, lost.value)
	hIntakeSeed(ctx, "after", []string{"merchant_id"})
	expected := append(append([]parked(nil), malformed...), late, lost)
	var early []string
	reported := map[string]bool{}
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		committed := offsets[harness.KafkaTopicPartition{Topic: kHIntakeTopic, Partition: 0}]
		on := map[string]bool{}
		for _, v := range ctx.Kafka.Values(kHIntakeDLQ) {
			on[v] = true
		}
		for _, p := range expected {
			if p.offset < committed && !on[p.value] && !reported[p.key] {
				reported[p.key] = true
				early = append(early, p.key)
			}
		}
		switch committed {
		case good + 1:
			ctx.Kafka.StallFor(kHIntakeDLQ, 3)
		case late.offset + 1:
			ctx.Kafka.FailNext(kHIntakeDLQ, 1)
		}
	})
	err := hIntakeConsume(ctx, true)
	committed := hIntakeCommitted(ctx)
	ctx.Assert(committed > late.offset, "the group committed offset %d%s: the dead-lettered records and deliveries must be committed, or they come back forever", committed, hIntakeStopped(err))
	var entities []string
	for _, job := range hIntakeQueued(ctx) {
		entities = append(entities, job.Entity)
	}
	ok := len(entities) > 0 && entities[0] == "deliveries"
	for _, e := range entities {
		ok = ok && (e == "deliveries" || e == "after")
	}
	ctx.Assert(ok, "jobs:queue holds jobs for %v, expected deliveries and no malformed event", entities)
	ctx.Equal(len(early), 0, "the offsets of %v were committed before %s acknowledged them (the broker was slow, then refused one): a crash there loses the payload. Commit once the broker took the dead letter; records committed early", early, kHIntakeDLQ)
	var wantValues, wantKeys []string
	for _, p := range append(append([]parked(nil), malformed...), late) {
		wantValues = append(wantValues, p.value)
		wantKeys = append(wantKeys, p.key)
	}
	values, keys := ctx.Kafka.Values(kHIntakeDLQ), ctx.Kafka.Keys(kHIntakeDLQ)
	ctx.Assert(len(values) >= len(wantValues), "%s holds %v, expected the malformed payloads as they arrived: %v", kHIntakeDLQ, values, wantValues)
	ctx.Equal(values[:len(wantValues)], wantValues, "%s must hold the malformed payloads as they arrived, in order", kHIntakeDLQ)
	ctx.Equal(keys[:len(wantKeys)], wantKeys, "the dead letters must carry the original keys")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "metasense/jobs.h"

namespace {

const std::string hIntakeTopic = "schema.changed";
const std::string hIntakeDlq = "schema.changed.dlq";
const std::string hIntakeGroup = "metasense";

// On partition 0: the records are handled in the order they are seeded.
int64_t hSeedRaw(harness::Ctx& ctx, const std::string& key, const std::string& value) {
  return ctx.Kafka.SeedPartition(hIntakeTopic, 0, key, value).Offset;
}

int64_t hSeed(harness::Ctx& ctx, const std::string& entity, const std::vector<std::string>& columns) {
  return hSeedRaw(ctx, entity, nlohmann::json{{"entity", entity}, {"owner", "team-logistics"}, {"columns", columns}}.dump());
}

std::vector<nlohmann::json> hQueued(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& raw : ctx.Redis.LRange("jobs:queue", 0, -1)) {
    const auto job = nlohmann::json::parse(raw, nullptr, false);
    ctx.Assert(job.is_object(), "a job on jobs:queue must be a JSON object, got %s", raw);
    out.push_back(job);
  }
  return out;
}

std::string hField(const nlohmann::json& j, const std::string& name) {
  return j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

int64_t hCommitted(harness::Ctx& ctx) { return ctx.Kafka.Committed(hIntakeGroup, hIntakeTopic, 0).value_or(0); }

// The learner's consume loop, on a thread of its own, until it waits for records that will not come.
struct hIntakeRunner {
  bool done = false;
  std::optional<std::string> err;
};
std::shared_ptr<hIntakeRunner> hIntakeActive;

// Runs the loop; with mayFail, an error ending it is returned instead of failing the check.
std::string hRunConsume(harness::Ctx& ctx, bool mayFail = false) {
  if (!hIntakeActive || hIntakeActive->done) {
    auto r = hIntakeActive = std::make_shared<hIntakeRunner>();
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
  if (!hIntakeActive->done || !hIntakeActive->err) return "";
  if (!mayFail) ctx.Fatalf("consume() stopped with %s", *hIntakeActive->err);
  return " (consume() stopped with " + *hIntakeActive->err + ")";
}

}  // namespace

void CheckCommitAfterEnqueue(harness::Ctx& ctx) {
  const std::vector<std::string> columns = {"merchant_id", "status", "delivery_time"};
  hSeed(ctx, "deliveries", columns);
  hSeed(ctx, "payments", {"card_no"});
  hSeed(ctx, "orders", {"order_id"});
  bool fired = false, seenFirst = false;
  std::vector<std::string> firstJobs;
  // Snapshot the deliveries job, then Redis refuses every later RPUSH jobs:queue (WRONGTYPE).
  ctx.Redis.After("jobs:queue", [&] {
    firstJobs = ctx.Redis.LRange("jobs:queue", 0, -1);
    seenFirst = ctx.Redis.SIsMember("jobs:seen", "deliveries:" + jobs::schemaHash(columns));
    ctx.Redis.Del("jobs:queue");
    ctx.Redis.Set("jobs:queue", "unavailable");
    fired = true;
  });
  std::vector<bool> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(fired); });
  const std::string stopped = hRunConsume(ctx, true);
  ctx.Assert(!atCommit.empty(), "the offset of the deliveries event was never committed%s", stopped);
  ctx.Assert(atCommit[0], "the offset was committed while jobs:queue was still empty: a crash between that commit and the enqueue loses the schema change. Queue the job, then commit");
  ctx.Equal(firstJobs.size(), 1, "jobs:queue must hold the deliveries job after the first enqueue; jobs");
  ctx.Assert(!seenFirst, "deliveries was in jobs:seen before its job reached jobs:queue: a crash between the two skips the schema for good. jobs::markSeen after the enqueue");
  ctx.Equal(ctx.Kafka.EventsOf("auto-commit").size(), 0, "offsets were auto-committed before the job existed; auto-commit events");
  const int64_t committed = hCommitted(ctx);
  ctx.Assert(committed >= 1, "the deliveries event was handled but its offset never committed");
  ctx.Equal(committed, int64_t{1}, "Redis refused the payments job (RPUSH jobs:queue answered WRONGTYPE), yet the group committed past it: payments is lost. A job that was not queued must leave its offset where it was; committed offset");
  ctx.Assert(!ctx.Redis.SIsMember("jobs:seen", "payments:" + jobs::schemaHash({"card_no"})), "payments is in jobs:seen though its job never reached jobs:queue: its redelivery would be skipped");
}

void CheckDedupeHash(harness::Ctx& ctx) {
  const std::vector<std::string> columns = {"merchant_id", "status"};
  const std::vector<std::string> changed = {"merchant_id", "status", "passport_no"};
  // orders was queued by an earlier run of the service.
  ctx.Redis.Do("SADD", "jobs:seen", "orders:" + jobs::schemaHash({"order_id"}));
  hSeed(ctx, "deliveries", columns);
  hSeed(ctx, "deliveries", columns);  // the platform re-emits an unchanged schema
  hSeed(ctx, "deliveries", changed);
  hSeed(ctx, "payments", columns);  // another entity with the same columns
  hSeed(ctx, "orders", {"order_id"});
  hRunConsume(ctx);
  const auto jobsQueued = hQueued(ctx);
  ctx.Equal(jobsQueued.size(), 3, "five events must queue 3 jobs: deliveries once per schema (one re-emitted unchanged), payments (same columns, another entity), and not orders (already in jobs:seen); jobs");
  const std::vector<std::string> want = {"deliveries:" + jobs::schemaHash(columns), "deliveries:" + jobs::schemaHash(changed),
                                         "payments:" + jobs::schemaHash(columns)};
  std::vector<std::string> got;
  for (const auto& job : jobsQueued) got.push_back(hField(job, "entity") + ":" + hField(job, "schema_hash"));
  ctx.Equal(got, want, "the jobs' entity:schema_hash must carry jobs::schemaHash(columns) of each schema");
  const std::vector<std::vector<std::string>> columnsOf = {columns, changed, columns};
  for (size_t i = 0; i < 3; i++) {
    const auto& job = jobsQueued[i];
    ctx.Assert(hField(job, "owner") == "team-logistics" && job.contains("columns") && job["columns"] == nlohmann::json(columnsOf[i]),
               "the job %s must carry the event's owner and columns", job.dump());
  }
  for (const auto& member : want) {
    ctx.Assert(ctx.Redis.SIsMember("jobs:seen", member), "jobs:seen lacks %s: a queued schema must be marked seen, or its re-emission after a restart is scanned again", member);
  }
  ctx.Equal(ctx.Kafka.Lag(hIntakeGroup, hIntakeTopic), 0, "the skipped duplicates must be committed too, or they are redelivered forever; records left");
}

void CheckDeadLetter(harness::Ctx& ctx) {
  struct Parked {
    std::string key, value;
    int64_t offset;
  };
  std::vector<Parked> malformed;
  for (const auto& [key, value] : std::vector<std::pair<std::string, std::string>>{
           {"broken", "{not json"},
           {"nameless", R"({"entity":"","owner":"team-x","columns":["a"]})"},
           {"ownerless", R"({"entity":"orders","columns":["a"]})"},
           {"numbered", R"({"entity":7,"owner":"team-x","columns":["a"]})"},
           {"columnless", R"({"entity":"orders","owner":"team-x","columns":[]})"},
           {"blank-column", R"({"entity":"orders","owner":"team-x","columns":["order_id",""]})"},
           {"numeric-column", R"({"entity":"orders","owner":"team-x","columns":["order_id",42]})"},
           {"listed", R"(["orders"])"},
       }) {
    malformed.push_back({key, value, hSeedRaw(ctx, key, value)});
  }
  const int64_t good = hSeed(ctx, "deliveries", {"merchant_id"});
  // Dead-lettered while the broker is slow to acknowledge, then once while it refuses the record.
  Parked late{"late", R"({"entity":"late","owner":"","columns":["a"]})", 0};
  late.offset = hSeedRaw(ctx, late.key, late.value);
  Parked lost{"lost", R"({"entity":"lost","owner":"team-x","columns":"a"})", 0};
  lost.offset = hSeedRaw(ctx, lost.key, lost.value);
  hSeed(ctx, "after", {"merchant_id"});
  std::vector<Parked> expected = malformed;
  expected.push_back(late);
  expected.push_back(lost);
  std::vector<std::string> early;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    const auto at = offsets.find(harness::KafkaTopicPartition{hIntakeTopic, 0});
    const int64_t committed = at == offsets.end() ? 0 : at->second;
    const auto values = ctx.Kafka.Values(hIntakeDlq);
    const std::set<std::string> on(values.begin(), values.end());
    for (const auto& p : expected) {
      if (p.offset < committed && !on.count(p.value) && std::find(early.begin(), early.end(), p.key) == early.end()) early.push_back(p.key);
    }
    if (committed == good + 1) ctx.Kafka.StallFor(hIntakeDlq, 3);
    if (committed == late.offset + 1) ctx.Kafka.FailNext(hIntakeDlq, 1);
  });
  const std::string stopped = hRunConsume(ctx, true);
  const int64_t committed = hCommitted(ctx);
  ctx.Assert(committed > late.offset, "the group committed offset %d%s: the dead-lettered records and deliveries must be committed, or they come back forever", committed, stopped);
  std::vector<std::string> entities;
  for (const auto& job : hQueued(ctx)) entities.push_back(hField(job, "entity"));
  bool ok = !entities.empty() && entities[0] == "deliveries";
  for (const auto& e : entities) ok = ok && (e == "deliveries" || e == "after");
  ctx.Assert(ok, "jobs:queue holds jobs for %s, expected deliveries and no malformed event", nlohmann::json(entities).dump());
  ctx.Equal(early.size(), 0, "the offsets of %s were committed before %s acknowledged them (the broker was slow, then refused one): a crash there loses the payload. Commit once the broker took the dead letter; records committed early",
            nlohmann::json(early).dump(), hIntakeDlq);
  std::vector<std::string> wantValues, wantKeys;
  for (const auto& p : malformed) {
    wantValues.push_back(p.value);
    wantKeys.push_back(p.key);
  }
  wantValues.push_back(late.value);
  wantKeys.push_back(late.key);
  auto values = ctx.Kafka.Values(hIntakeDlq);
  auto keys = ctx.Kafka.Keys(hIntakeDlq);
  ctx.Assert(values.size() >= wantValues.size(), "%s holds %s, expected the malformed payloads as they arrived", hIntakeDlq, nlohmann::json(values).dump());
  values.resize(wantValues.size());
  keys.resize(wantKeys.size());
  ctx.Equal(values, wantValues, "%s must hold the malformed payloads as they arrived, in order", hIntakeDlq);
  ctx.Equal(keys, wantKeys, "the dead letters must carry the original keys");
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
