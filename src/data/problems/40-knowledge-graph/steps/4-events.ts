import type {Step} from '@/lib/types';

export const graphEventsStep: Step = {
  id: 'events',
  title: 'graph.changed events keyed by entity, after the commit',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'db', 'kafka', 'consumer', 'outbox'],
  task: `## Task

**Starting point.** The starter is \`rename_entity(tenant, entity_id, new_name)\`, the write that
tells the graph consumers an entity changed: it produces
\`{"type": "entity.renamed", "tenant", "entity_id", "new_name"}\` to \`graph.changed\` with no key,
falls back to \`store.insert_outbox\` when \`produce\` raises, then commits with \`store.rename\`. It
serves the demo and hides four flaws.

**Failure mode the checks target.** Two renames of one entity land on two partitions and a consumer
applies them in the wrong order; a consumer cannot tell what changed or whether it already applied
an event; a rename whose commit fails is announced anyway; and a delivery the broker rejected is
lost.

- The record key is the **entity id**: Kafka orders per partition.
- The payload adds \`old_name\` and the entity's \`version\` after the rename, both from
  \`store.rename\`, which returns \`entity_id\`, \`old_name\`, \`new_name\` and \`version\`.
- **Commit first**: \`store.rename\` before the produce; when it fails, nothing is produced.
- Wait for the **delivery report**, at most 2 s (\`ACK_TIMEOUT_S\`). A failed delivery, or none in
  time, inserts an outbox row (topic, key, payload) and returns \`False\`.`,
  sequence: {
    participants: ['graph-api', 'Graph store', 'graph.changed', 'Outbox'],
    messages: [
      {from: 'graph-api', to: 'Graph store', label: 'rename(e-1, "Ada Lovelace") → old_name, version', kind: 'sync'},
      {from: 'graph-api', to: 'graph.changed', label: 'produce key = e-1 · old_name, new_name, version', kind: 'sync'},
      {from: 'graph.changed', to: 'graph-api', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'graph.changed', to: 'graph-api', label: 'delivery failed / no report', kind: 'reply'},
      {from: 'graph-api', to: 'Outbox', label: 'insert_outbox(topic, e-1, payload) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'entity-key',
      title: 'Keys graph.changed by the entity id',
      detail:
        'Renames of e-1, e-2, e-1 carry those keys and the two e-1 records share a partition. The starter produces without a key, so one entity spreads over every partition.',
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*entity_id/]},
        typescript: {all: [/key:\s*entityId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*entityID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*entityId\s*,/]},
        cpp: {all: [/entity_id\.c_str\(\)\s*,\s*entity_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'Carries the old name and the version',
      detail:
        'The value names `old_name` and the entity `version` after the rename, so a consumer sees the transition and drops a replay it already applied. The starter sends the new name only.',
      match: {
        python: {all: [/["']old_name["']\s*:/, /["']version["']\s*:/]},
        typescript: {all: [/old_name:/, /version:/]},
        go: {all: [/"old_name"/, /"version"/]},
        scala: {all: [/"old_name"/, /"version"/]},
        cpp: {all: [/"old_name"/, /"version"/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Commits the rename before producing its event',
      detail:
        'When the rename reaches the store the topic is still empty, and a rename whose commit fails produces nothing. The starter produces first.',
      match: {
        python: {order: [/store\.rename\(/, /producer\.produce\(/]},
        typescript: {order: [/await rename\(/, /producer\.send\(/]},
        go: {order: [/store\.Rename\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.rename\(/, /producer\.send\(/]},
        cpp: {order: [/store::rename\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Falls back to the outbox on a failed or missing delivery report',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter only catches the error `produce` raises while enqueueing.',
      match: {
        python: {
          all: [/on_delivery\s*=|callback\s*=/, /producer\.flush\(/, /store\.insert_outbox\(/],
          none: [/except KafkaException/],
        },
        typescript: {all: [/await producer\.send\(/, /insertOutbox\(/, /catch/], none: [/void producer\.send\(/]},
        go: {
          all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/, /time\.After\(|Flush\(/],
          none: [/Produce\(\s*msg\s*,\s*nil\s*\)/],
        },
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/], none: [/case _: KafkaException/]},
        cpp: {all: [/store::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from graph import store  # rename, insert_outbox

TOPIC = "graph.changed"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def rename_entity(tenant: str, entity_id: str, new_name: str) -> bool:
    """Commit the rename and tell the graph consumers; True when the event is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {"type": "entity.renamed", "tenant": tenant, "entity_id": entity_id, "new_name": new_name}
    try:
        producer.produce(TOPIC, value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.insert_outbox(TOPIC, entity_id, payload)
        return False
    store.rename(entity_id, new_name)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from graph import store  # rename, insert_outbox

TOPIC = "graph.changed"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092"})


def rename_entity(tenant: str, entity_id: str, new_name: str) -> bool:
    """Commit the rename, then tell the graph consumers; True once the broker acknowledged the event."""
    # The rename is durable before its event exists; a failed commit raises before anything is produced.
    renamed = store.rename(entity_id, new_name)
    payload = {
        "type": "entity.renamed",
        "tenant": tenant,
        "entity_id": entity_id,
        "old_name": renamed["old_name"],
        "new_name": renamed["new_name"],
        "version": renamed["version"],
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=entity_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so a consumer is late, not wrong.
        store.insert_outbox(TOPIC, entity_id, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {insertOutbox, rename} from 'graph/store';

export const TOPIC = 'graph.changed';

const kafka = new Kafka({clientId: 'graph-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Commit the rename and tell the graph consumers; true when the event is on its way. */
export async function renameEntity(tenant: string, entityId: string, newName: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {type: 'entity.renamed', tenant, entity_id: entityId, new_name: newName};
  try {
    void producer.send({topic: TOPIC, messages: [{value: JSON.stringify(payload)}]});
  } catch {
    await insertOutbox(TOPIC, entityId, payload);
    return false;
  }
  await rename(entityId, newName);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {insertOutbox, rename} from 'graph/store';

export const TOPIC = 'graph.changed';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'graph-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Commit the rename, then tell the graph consumers; true once the broker acknowledged the event. */
export async function renameEntity(tenant: string, entityId: string, newName: string): Promise<boolean> {
  // The rename is durable before its event exists; a failed commit throws before anything is produced.
  const renamed = await rename(entityId, newName);
  const payload = {
    type: 'entity.renamed',
    tenant,
    entity_id: entityId,
    old_name: renamed.old_name,
    new_name: renamed.new_name,
    version: renamed.version,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: entityId, value: JSON.stringify(payload)}], timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so a consumer is late, not wrong.
    await insertOutbox(TOPIC, entityId, payload);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"graph/store" // store.Rename, store.InsertOutbox
)

const topic = "graph.changed"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// renameEntity commits the rename and tells the graph consumers; true when the event is on its way.
func renameEntity(ctx context.Context, tenant, entityID, newName string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{"type": "entity.renamed", "tenant": tenant, "entity_id": entityID, "new_name": newName}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		store.InsertOutbox(ctx, topic, entityID, payload)
		return false, nil
	}
	if _, err := store.Rename(ctx, entityID, newName); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"graph/store" // store.Rename, store.InsertOutbox
)

const (
	topic      = "graph.changed"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

// renameEntity commits the rename, then tells the graph consumers; true once the broker acknowledged the event.
func renameEntity(ctx context.Context, tenant, entityID, newName string) (bool, error) {
	// The rename is durable before its event exists; a failed commit returns before anything is produced.
	renamed, err := store.Rename(ctx, entityID, newName)
	if err != nil {
		return false, err
	}
	payload := map[string]any{
		"type":      "entity.renamed",
		"tenant":    tenant,
		"entity_id": entityID,
		"old_name":  renamed.OldName,
		"new_name":  renamed.NewName,
		"version":   renamed.Version,
	}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(entityID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so a consumer is late, not wrong.
		store.InsertOutbox(ctx, topic, entityID, payload)
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import graph.Store // Store.rename, Store.insertOutbox

object Events {
  val Topic = "graph.changed"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit the rename and tell the graph consumers; true when the event is on its way. */
  def renameEntity(tenant: String, entityId: String, newName: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload =
      JsObject("type" -> JsString("entity.renamed"), "tenant" -> JsString(tenant), "entity_id" -> JsString(entityId), "new_name" -> JsString(newName))
    try producer.send(new ProducerRecord[String, String](Topic, payload.compactPrint))
    catch {
      case _: KafkaException =>
        Store.insertOutbox(Topic, entityId, payload)
        return false
    }
    Store.rename(entityId, newName)
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

import graph.Store // Store.rename, Store.insertOutbox

object Events {
  val Topic = "graph.changed"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit the rename, then tell the graph consumers; true once the broker acknowledged the event. */
  def renameEntity(tenant: String, entityId: String, newName: String): Boolean = {
    // The rename is durable before its event exists; a failed commit throws before anything is produced.
    val renamed = Store.rename(entityId, newName)
    val payload = JsObject(
      "type" -> JsString("entity.renamed"),
      "tenant" -> JsString(tenant),
      "entity_id" -> JsString(entityId),
      "old_name" -> JsString(renamed.oldName),
      "new_name" -> JsString(renamed.newName),
      "version" -> JsNumber(renamed.version))
    val record = new ProducerRecord[String, String](Topic, entityId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay produces the row later, so a consumer is late, not wrong.
    if (acked.isFailure) Store.insertOutbox(Topic, entityId, payload)
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

#include "graph/store.h"  // store::rename, store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "graph.changed";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Commit the rename and tell the graph consumers; true when the event is on its way.
bool renameEntity(const std::string& tenant, const std::string& entity_id, const std::string& new_name) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = {{"type", "entity.renamed"}, {"tenant", tenant}, {"entity_id", entity_id}, {"new_name", new_name}};
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), nullptr, 0, 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, entity_id, payload);
    return false;
  }
  store::rename(entity_id, new_name);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "graph/store.h"  // store::rename, store::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "graph.changed";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: renameEntity produces one record and waits for it.
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
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Commit the rename, then tell the graph consumers; true once the broker acknowledged the event.
bool renameEntity(const std::string& tenant, const std::string& entity_id, const std::string& new_name) {
  // The rename is durable before its event exists; a failed commit throws before anything is produced.
  const store::Renamed renamed = store::rename(entity_id, new_name);
  const json payload = {{"type", "entity.renamed"}, {"tenant", tenant}, {"entity_id", entity_id},
                        {"old_name", renamed.old_name}, {"new_name", renamed.new_name}, {"version", renamed.version}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), entity_id.c_str(), entity_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so a consumer is late, not wrong.
    store::insertOutbox(kTopic, entity_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from graph import store

TOPIC = "graph.changed"


def _entities(*names):
    return [store.create_entity("t1", "person", name, [])["id"] for name in names]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_entity_key(ctx):
    m = ctx.load("events")
    ada, grace = _entities("Ada", "Grace")
    m.rename_entity("t1", ada, "Ada Lovelace")
    m.rename_entity("t1", grace, "Grace Hopper")
    m.rename_entity("t1", ada, "Augusta Ada King")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three renames produced {len(records)} records on graph.changed (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    expected = [ada.encode(), grace.encode(), ada.encode()]
    assert keys == expected, f"the records are keyed {keys}, expected the entity ids {expected}: without the entity as key one entity's renames spread over partitions"
    assert records[0].partition == records[2].partition, f"both renames of {ada} must land on one partition, or a consumer applies them out of order"


def check_payload_fields(ctx):
    m = ctx.load("events")
    (ada,) = _entities("Ada")
    m.rename_entity("t1", ada, "Ada Lovelace")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one rename produced {len(records)} records"
    value = json.loads(records[0].value)
    assert value.get("entity_id") == ada and value.get("tenant") == "t1" and value.get("new_name") == "Ada Lovelace", f"the payload is {value}, expected entity_id, tenant and new_name"
    assert value.get("old_name") == "Ada", f"the payload's old_name is {value.get('old_name')!r}, expected 'Ada': a consumer that missed an event cannot tell what changed"
    assert value.get("version") == 2, f"the payload's version is {value.get('version')!r}, expected 2 (the entity's version after the rename): without it a replayed event looks like a new one"


def check_after_commit(ctx):
    m = ctx.load("events")
    (ada,) = _entities("Ada")
    probe = ctx.redis_after(f"entity:{ada}", lambda: len(ctx.kafka.records(TOPIC)))
    m.rename_entity("t1", ada, "Ada Lovelace")
    assert probe.fired, f"rename_entity never committed the rename (nothing touched entity:{ada})"
    assert probe.result == 0, f"when the rename reached the store the topic already held {probe.result} record(s): a consumer can be told about a change it cannot read yet. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"
    try:
        m.rename_entity("t1", "e-404", "Nobody")
    except Exception:
        pass
    assert len(ctx.kafka.records(TOPIC)) == 1, "a rename whose commit failed (there is no e-404) still produced an event: consumers hear of a change that never happened"


def check_outbox(ctx):
    m = ctx.load("events")
    ada, grace = _entities("Ada", "Grace")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.rename_entity("t1", ada, "Ada Lovelace")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: the rename is committed and no consumer will ever hear of it"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == ada and rows[0].get("payload", {}).get("new_name") == "Ada Lovelace", f"the outbox row is {rows[0]}, expected the topic, the key {ada} and the payload"
    assert ok is False, f"rename_entity returned {ok!r} after a failed delivery, expected False"
    assert store.get_entity(ada)["name"] == "Ada Lovelace", "the rename must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.rename_entity("t1", grace, "Grace Hopper")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"rename_entity waited {waited:.0f} s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("key") == grace, f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"rename_entity returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'graph.changed';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

async function world(ctx, ...names: string[]) {
  const store = ctx.load('/support/graph/store.ts');
  const ids: string[] = [];
  for (const name of names) ids.push((await store.createEntity('t1', 'person', name, [])).id);
  return {m: ctx.load('events'), store, ids};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_entity_key(ctx) {
  const {m, ids} = await world(ctx, 'Ada', 'Grace');
  const [ada, grace] = ids;
  await m.renameEntity('t1', ada, 'Ada Lovelace');
  await m.renameEntity('t1', grace, 'Grace Hopper');
  await m.renameEntity('t1', ada, 'Augusta Ada King');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three renames produced \${records.length} records on graph.changed\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, [ada, grace, ada], \`the records are keyed \${JSON.stringify(keys)}, expected the entity ids: without the entity as key one entity's renames spread over partitions\`);
  assert.equal(records[0].partition, records[2].partition, \`both renames of \${ada} must land on one partition, or a consumer applies them out of order\`);
}

export async function check_payload_fields(ctx) {
  const {m, ids} = await world(ctx, 'Ada');
  const [ada] = ids;
  await m.renameEntity('t1', ada, 'Ada Lovelace');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one rename produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  assert(value.entity_id === ada && value.tenant === 't1' && value.new_name === 'Ada Lovelace', \`the payload is \${values[0]}, expected entity_id, tenant and new_name\`);
  assert.equal(value.old_name, 'Ada', \`the payload's old_name is \${JSON.stringify(value.old_name)}, expected "Ada": a consumer that missed an event cannot tell what changed\`);
  assert.equal(value.version, 2, \`the payload's version is \${JSON.stringify(value.version)}, expected 2 (the entity's version after the rename): without it a replayed event looks like a new one\`);
}

export async function check_after_commit(ctx) {
  const {m, ids} = await world(ctx, 'Ada');
  const [ada] = ids;
  const probe = ctx.redisAfter(\`entity:\${ada}\`, () => ctx.kafka.records(TOPIC).length);
  await m.renameEntity('t1', ada, 'Ada Lovelace');
  await settle();
  assert(probe.fired, \`renameEntity never committed the rename (nothing touched entity:\${ada})\`);
  assert.equal(probe.result, 0, \`when the rename reached the store the topic already held \${probe.result} record(s): a consumer can be told about a change it cannot read yet. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
  try {
    await m.renameEntity('t1', 'e-404', 'Nobody');
  } catch {
    // the commit failed, as it should for an unknown entity
  }
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a rename whose commit failed (there is no e-404) still produced an event: consumers hear of a change that never happened');
}

export async function check_outbox(ctx) {
  const {m, store, ids} = await world(ctx, 'Ada', 'Grace');
  const [ada, grace] = ids;
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.renameEntity('t1', ada, 'Ada Lovelace');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: the rename is committed and no consumer will ever hear of it\`);
  assert(rows[0].topic === TOPIC && rows[0].key === ada && rows[0].payload?.new_name === 'Ada Lovelace', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key \${ada} and the payload\`);
  assert.equal(ok, false, \`renameEntity resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal((await store.getEntity(ada)).name, 'Ada Lovelace', 'the rename must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.renameEntity('t1', grace, 'Grace Hopper');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`renameEntity waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].key === grace, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`renameEntity resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"graph/store"

	"leetbuild/harness"
)

const eventsTopic = "graph.changed"

var eventsBg = context.Background()

func eventsEntities(names ...string) []string {
	ids := []string{}
	for _, name := range names {
		ids = append(ids, store.CreateEntity(eventsBg, "t1", "person", name, nil).ID)
	}
	return ids
}

func eventsRename(ctx *harness.Ctx, entityID, newName string) bool {
	ok, err := renameEntity(eventsBg, "t1", entityID, newName)
	ctx.NoError(err, "renameEntity(t1, %s) failed", entityID)
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	rows := []eventsRow{}
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		row := eventsRow{}
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckEntityKey(ctx *harness.Ctx) {
	ids := eventsEntities("Ada", "Grace")
	ada, grace := ids[0], ids[1]
	eventsRename(ctx, ada, "Ada Lovelace")
	eventsRename(ctx, grace, "Grace Hopper")
	eventsRename(ctx, ada, "Augusta Ada King")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three renames must produce three records on graph.changed; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{ada, grace, ada}, "the records must be keyed by the entity ids, or one entity's renames spread over partitions")
	ctx.Equal(records[0].Partition, records[2].Partition, "both renames of %s must land on one partition, or a consumer applies them out of order; the partitions", ada)
}

func CheckPayloadFields(ctx *harness.Ctx) {
	ada := eventsEntities("Ada")[0]
	eventsRename(ctx, ada, "Ada Lovelace")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one rename must produce one record; the records")
	value := map[string]any{}
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Assert(value["entity_id"] == ada && value["tenant"] == "t1" && value["new_name"] == "Ada Lovelace", "the payload is %s, expected entity_id, tenant and new_name", values[0])
	ctx.Equal(value["old_name"], "Ada", "the payload's old_name (a consumer that missed an event cannot tell what changed without it)")
	ctx.Equal(value["version"], 2, "the payload's version, the entity's version after the rename (without it a replayed event looks like a new one)")
}

func CheckAfterCommit(ctx *harness.Ctx) {
	ada := eventsEntities("Ada")[0]
	probe := ctx.Redis.After("entity:"+ada, func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsRename(ctx, ada, "Ada Lovelace")
	ctx.Settle()
	ctx.Assert(probe.Fired, "renameEntity never committed the rename (nothing touched entity:%s)", ada)
	ctx.Equal(probe.Result, 0, "when the rename reached the store the topic already held records: a consumer can be told about a change it cannot read yet. Commit first, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the commit; the records")
	renameEntity(eventsBg, "t1", "e-404", "Nobody")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a rename whose commit failed (there is no e-404) must produce nothing, or consumers hear of a change that never happened; the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	ids := eventsEntities("Ada", "Grace")
	ada, grace := ids[0], ids[1]
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsRename(ctx, ada, "Ada Lovelace")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the rename is committed and no consumer will ever hear of it; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == ada && rows[0].Payload["new_name"] == "Ada Lovelace", "the outbox row is %+v, expected the topic, the key %s and the payload", rows[0], ada)
	ctx.Equal(ok, false, "renameEntity's result after a failed delivery")
	ctx.Equal(store.GetEntity(eventsBg, ada).Name, "Ada Lovelace", "the rename must stay committed when only the produce failed; the name")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsRename(ctx, grace, "Grace Hopper")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "renameEntity waited %.0f s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Key == grace, "no delivery report within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "renameEntity's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "graph.changed";

std::string eventsEntity(const std::string& name) { return store::createEntity("t1", "person", name, {}).id; }

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckEntityKey(harness::Ctx& ctx) {
  const std::string ada = eventsEntity("Ada");
  const std::string grace = eventsEntity("Grace");
  renameEntity("t1", ada, "Ada Lovelace");
  renameEntity("t1", grace, "Grace Hopper");
  renameEntity("t1", ada, "Augusta Ada King");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three renames must produce three records on graph.changed; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), std::vector<std::string>{ada, grace, ada}, "the records must be keyed by the entity ids, or one entity's renames spread over partitions");
  ctx.Equal(records[0].Partition, records[2].Partition, "both renames of %s must land on one partition, or a consumer applies them out of order; the partitions", ada);
}

void CheckPayloadFields(harness::Ctx& ctx) {
  const std::string ada = eventsEntity("Ada");
  renameEntity("t1", ada, "Ada Lovelace");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one rename must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(eventsField(value, "entity_id") == ada && eventsField(value, "tenant") == "t1" && eventsField(value, "new_name") == "Ada Lovelace",
             "the payload is %s, expected entity_id, tenant and new_name", values[0]);
  ctx.Equal(eventsField(value, "old_name"), "Ada", "the payload's old_name (a consumer that missed an event cannot tell what changed without it)");
  ctx.Equal(value.is_object() && value.contains("version") && value["version"].is_number() ? value["version"].get<long>() : 0L, 2L,
            "the payload's version, the entity's version after the rename (without it a replayed event looks like a new one)");
}

void CheckAfterCommit(harness::Ctx& ctx) {
  const std::string ada = eventsEntity("Ada");
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("entity:" + ada, [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  renameEntity("t1", ada, "Ada Lovelace");
  ctx.Settle();
  ctx.Assert(fired, "renameEntity never committed the rename (nothing touched entity:%s)", ada);
  ctx.Equal(atCommit, 0, "when the rename reached the store the topic already held records: a consumer can be told about a change it cannot read yet. Commit first, then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the commit; the records");
  try {
    renameEntity("t1", "e-404", "Nobody");
  } catch (const std::exception&) {
    // the commit failed, as it should for an unknown entity
  }
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "a rename whose commit failed (there is no e-404) must produce nothing, or consumers hear of a change that never happened; the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  const std::string ada = eventsEntity("Ada");
  const std::string grace = eventsEntity("Grace");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = renameEntity("t1", ada, "Ada Lovelace");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the rename is committed and no consumer will ever hear of it; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == ada && rows[0].contains("payload") && eventsField(rows[0]["payload"], "new_name") == "Ada Lovelace",
             "the outbox row is %s, expected the topic, the key %s and the payload", rows[0].dump(), ada);
  ctx.Equal(ok, false, "renameEntity's result after a failed delivery");
  ctx.Equal(store::getEntity(ada)->name, "Ada Lovelace", "the rename must stay committed when only the produce failed; the name");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = renameEntity("t1", grace, "Grace Hopper");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "renameEntity waited %.0f s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && eventsField(rows[1], "key") == grace, "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "renameEntity's result without a delivery report");
}
`,
  },
  hints: [
    'Rename one entity twice and look at the partitions: the renames sit on two of them. Make the broker reject a delivery: the rename is committed and no event exists anywhere.',
    'Without a key the producer spreads records over partitions; a consumer reading in parallel sees one entity out of order. `produce` only raises when it cannot enqueue; a rejection arrives later, in the delivery report nobody reads.',
    'Call `store.rename` first and build the payload from what it returns, produce with `key=entity_id` and an `on_delivery` callback, `flush(ACK_TIMEOUT_S)`, and `store.insert_outbox` when the report failed or never came.',
  ],
  debrief: `The key is an ordering contract: Kafka keeps order within a partition, so whatever must stay ordered, here one entity's history, must share a key. Committing first makes every event describe state a consumer can read back. The version in the payload is what lets a consumer apply events idempotently: an event whose version is not newer than what it already holds is a replay. The delivery report is the only place a broker rejection shows up, which is why the outbox hangs off it. A stalled delivery can still land after its row was written, so a consumer sees some events twice and the version check absorbs that. Production graphs write the outbox row in the same transaction as the change and let a relay do every produce.`,
};
