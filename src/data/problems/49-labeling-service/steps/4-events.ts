import type {Step} from '@/lib/types';

export const labelEventsStep: Step = {
  id: 'events',
  title: 'Label events keyed by task, after the label is saved',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['service', 'redis', 'kafka', 'outbox'],
  task: `## Task

**Starting point.** The starter is \`record_label(label)\`, called when an annotator submits
\`{label_id, task_id, item_id, annotator, spec_version, value}\`: it produces the label as JSON to
\`label.submitted\`, keyed by the annotator, on a producer with \`acks=1\`, then saves it with
\`store.save_label\` and answers \`True\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** One task's labels scatter over partitions and the agreement
consumer sees them out of order; an event goes out for a label whose save failed; a lost
acknowledgement writes the event twice and a leader failover loses it; and a broker that rejects
the record, or does not answer, drops the label from every downstream count.

- The record key is the **task id**.
- **Save first**: \`store.save_label(label)\` before the produce.
- The producer is **idempotent** with **\`acks=all\`** (kafkajs: \`idempotent: true\` and \`acks: -1\`;
  the Go code uses confluent-kafka-go, since kafka-go has no idempotent producer).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` = 2 s. A failed delivery, or none in
  time, writes \`store.insert_outbox(topic, task_id, label)\` and answers \`False\`.`,
  sequence: {
    participants: ['labeld', 'task store', 'label.submitted', 'outbox'],
    messages: [
      {from: 'labeld', to: 'task store', label: 'save_label(label) · labels:{task_id}', kind: 'sync'},
      {from: 'labeld', to: 'label.submitted', label: 'produce key = task_id · idempotent · acks=all', kind: 'sync'},
      {from: 'label.submitted', to: 'labeld', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'label.submitted', to: 'labeld', label: 'failed / no report', kind: 'reply'},
      {from: 'labeld', to: 'outbox', label: 'insert_outbox(topic, task_id, label) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'task-key',
      title: 'Keys label.submitted by the task id',
      detail:
        'Labels of tasks t-1, t-2, t-1 carry those keys and the two t-1 events share a partition, so the agreement consumer sees one task in order. The starter keys by annotator, which spreads one task over every partition.',
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*label\[["']task_id["']\]/]},
        typescript: {all: [/key:\s*label\.task_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*label\.TaskID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"label\.submitted")\s*,\s*label\.taskId\s*,/]},
        cpp: {all: [/label\.task_id\.c_str\(\)\s*,\s*label\.task_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'save-first',
      title: 'Saves the label before producing its event',
      detail:
        'When the label is written to `labels:{task_id}` the topic is still empty: the event follows the save. The starter produces first, so a failed save leaves an event for a label nobody can read.',
      match: {
        python: {order: [/store\.save_label\(/, /producer\.produce\(/]},
        typescript: {order: [/await saveLabel\(/, /producer\.send\(/]},
        go: {order: [/store\.SaveLabel\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.saveLabel\(/, /producer\.send\(/]},
        cpp: {order: [/store::saveLabel\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the task id and the label, and the call answers false. The starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|isFailure/]},
        cpp: {all: [/store::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from labeling import store  # save_label, insert_outbox

TOPIC = "label.submitted"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def record_label(label: dict) -> bool:
    """Save a submitted label (label_id, task_id, item_id, annotator, spec_version, value) and announce it; True when the event is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    producer.produce(TOPIC, key=label["annotator"], value=json.dumps(label))
    producer.poll(0)
    store.save_label(label)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from labeling import store  # save_label, insert_outbox

TOPIC = "label.submitted"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def record_label(label: dict) -> bool:
    """Save a submitted label (label_id, task_id, item_id, annotator, spec_version, value) and announce it; True once the broker acknowledged the event."""
    # The label is durable before its event exists: a consumer can always look up what it counts.
    store.save_label(label)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=label["task_id"], value=json.dumps(label), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so agreement is late, not wrong.
        store.insert_outbox(TOPIC, label["task_id"], label)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Label, insertOutbox, saveLabel} from 'labeling/store';

export const TOPIC = 'label.submitted';

const kafka = new Kafka({clientId: 'labeld', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Save a submitted label and announce it; true when the event is on its way. */
export async function recordLabel(label: Label): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  void producer.send({topic: TOPIC, messages: [{key: label.annotator, value: JSON.stringify(label)}], acks: 1});
  await saveLabel(label);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Label, insertOutbox, saveLabel} from 'labeling/store';

export const TOPIC = 'label.submitted';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'labeld', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Save a submitted label and announce it; true once the broker acknowledged the event. */
export async function recordLabel(label: Label): Promise<boolean> {
  // The label is durable before its event exists: a consumer can always look up what it counts.
  await saveLabel(label);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: label.task_id, value: JSON.stringify(label)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so agreement is late, not wrong.
    await insertOutbox(TOPIC, label.task_id, label);
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

	"labeling/store" // store.SaveLabel, InsertOutbox
)

const topic = "label.submitted"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// recordLabel saves a submitted label and announces it; true when the event is on its way.
func recordLabel(ctx context.Context, label store.Label) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(label)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(label.Annotator), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if err := store.SaveLabel(ctx, label); err != nil {
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

	"labeling/store" // store.SaveLabel, InsertOutbox
)

const (
	topic      = "label.submitted"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// recordLabel saves a submitted label and announces it; true once the broker acknowledged the event.
func recordLabel(ctx context.Context, label store.Label) (bool, error) {
	// The label is durable before its event exists: a consumer can always look up what it counts.
	if err := store.SaveLabel(ctx, label); err != nil {
		return false, err
	}
	value, _ := json.Marshal(label)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(label.TaskID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so agreement is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, label.TaskID, label); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import labeling.Store // Store.saveLabel, insertOutbox

object Events {
  val Topic = "label.submitted"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Save a submitted label and announce it; true when the event is on its way. */
  def recordLabel(label: Store.Label): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    producer.send(new ProducerRecord[String, String](Topic, label.annotator, label.toJson.compactPrint))
    Store.saveLabel(label)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import labeling.Store // Store.saveLabel, insertOutbox

object Events {
  val Topic = "label.submitted"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Save a submitted label and announce it; true once the broker acknowledged the event. */
  def recordLabel(label: Store.Label): Boolean = {
    // The label is durable before its event exists: a consumer can always look up what it counts.
    Store.saveLabel(label)
    val record = new ProducerRecord[String, String](Topic, label.taskId, label.toJson.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay produces the row later, so agreement is late, not wrong.
      Store.insertOutbox(Topic, label.taskId, label.toJson)
    }
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

#include "labeling/store.h"  // store::saveLabel, insertOutbox, toJson

const std::string kTopic = "label.submitted";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Save a submitted label and announce it; true when the event is on its way.
bool recordLabel(const store::Label& label) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string value = store::toJson(label).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), label.annotator.c_str(), label.annotator.size(), 0, nullptr);
  producer->poll(0);
  store::saveLabel(label);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "labeling/store.h"  // store::saveLabel, insertOutbox, toJson

const std::string kTopic = "label.submitted";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: recordLabel produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Save a submitted label and announce it; true once the broker acknowledged the event.
bool recordLabel(const store::Label& label) {
  // The label is durable before its event exists: a consumer can always look up what it counts.
  store::saveLabel(label);
  const nlohmann::json payload = store::toJson(label);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), label.task_id.c_str(), label.task_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so agreement is late, not wrong.
    store::insertOutbox(kTopic, label.task_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "label.submitted"


def _label(n, task="t-1", annotator="ana"):
    return {"label_id": f"l-{n}", "task_id": task, "item_id": f"i-{n}", "annotator": annotator, "spec_version": "2026-10", "value": "cat"}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_task_key(ctx):
    m = ctx.load("events")
    m.record_label(_label(1, "t-1", "ana"))
    m.record_label(_label(2, "t-2", "bo"))
    m.record_label(_label(3, "t-1", "cy"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three record_label calls produced {len(records)} records on label.submitted (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"t-1", b"t-2", b"t-1"], f"the records are keyed {keys}, expected the task ids t-1, t-2, t-1"
    assert records[0].partition == records[2].partition, "both t-1 events must land on one partition, or the agreement consumer sees one task out of order"
    assert json.loads(records[0].value) == _label(1, "t-1", "ana"), f"the event carries {records[0].value!r}, expected the label"


def check_save_first(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("labels:t-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_label(_label(1))
    assert probe.fired, "record_label never saved the label (no write to labels:t-1)"
    assert probe.result == 0, f"when the label was saved the topic already held {probe.result} record(s): an event for a label nobody can read yet is a phantom. Save first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the save"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.record_label(_label(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the label twice. Enable idempotence"
    m.record_label(_label(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.record_label(_label(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the label is missing from every agreement count"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "t-1" and rows[0].get("payload", {}).get("label_id") == "l-1", f"the outbox row is {rows[0]}, expected the topic, the key t-1 and the label"
    assert ok is False, f"record_label returned {ok!r} after a failed delivery, expected False"
    assert ctx.redis.llen("labels:t-1") == 1, "the label must stay saved when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.record_label(_label(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"record_label waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("label_id") == "l-2", f"no report within the window and the outbox holds {rows}"
    assert ok is False, f"record_label returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'label.submitted';

const label = (n: number, task = 't-1', annotator = 'ana') => ({
  label_id: \`l-\${n}\`,
  task_id: task,
  item_id: \`i-\${n}\`,
  annotator,
  spec_version: '2026-10',
  value: 'cat',
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_task_key(ctx) {
  const m = ctx.load('events');
  await m.recordLabel(label(1, 't-1', 'ana'));
  await m.recordLabel(label(2, 't-2', 'bo'));
  await m.recordLabel(label(3, 't-1', 'cy'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three recordLabel calls produced \${records.length} records on label.submitted\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['t-1', 't-2', 't-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the task ids t-1, t-2, t-1\`);
  assert.equal(records[0].partition, records[2].partition, 'both t-1 events must land on one partition, or the agreement consumer sees one task out of order');
  assert.deepEqual(JSON.parse(ctx.kafka.values(TOPIC)[0]), label(1, 't-1', 'ana'), 'the event must carry the label');
}

export async function check_save_first(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter('labels:t-1', () => ctx.kafka.records(TOPIC).length);
  await m.recordLabel(label(1));
  await settle();
  assert(probe.fired, 'recordLabel never saved the label (no write to labels:t-1)');
  assert.equal(probe.result, 0, \`when the label was saved the topic already held \${probe.result} record(s): an event for a label nobody can read yet is a phantom. Save first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the save');
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.recordLabel(label(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the label twice. Enable idempotence\`);
  await m.recordLabel(label(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.recordLabel(label(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the label is missing from every agreement count\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 't-1' && rows[0].payload?.label_id === 'l-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key t-1 and the label\`);
  assert.equal(ok, false, \`recordLabel resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal(ctx.redis.llen('labels:t-1'), 1, 'the label must stay saved when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.recordLabel(label(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`recordLabel waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.label_id === 'l-2', \`no report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`recordLabel resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"

	"labeling/store"
)

func eventsLabel(n int, task, annotator string) store.Label {
	return store.Label{LabelID: fmt.Sprintf("l-%d", n), TaskID: task, ItemID: fmt.Sprintf("i-%d", n), Annotator: annotator, SpecVersion: "2026-10", Value: "cat"}
}

func eventsRecord(ctx *harness.Ctx, label store.Label) bool {
	ok, err := recordLabel(context.Background(), label)
	ctx.NoError(err, "recordLabel")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckTaskKey(ctx *harness.Ctx) {
	eventsRecord(ctx, eventsLabel(1, "t-1", "ana"))
	eventsRecord(ctx, eventsLabel(2, "t-2", "bo"))
	eventsRecord(ctx, eventsLabel(3, "t-1", "cy"))
	ctx.Settle()
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three recordLabel calls must produce three records on label.submitted; the records")
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"t-1", "t-2", "t-1"}, "the records must be keyed by the task ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both t-1 events must land on one partition, or the agreement consumer sees one task out of order; the partitions")
	var first store.Label
	ctx.NoError(json.Unmarshal([]byte(ctx.Kafka.Values(topic)[0]), &first), "the event must be the label as JSON")
	ctx.Equal(first, eventsLabel(1, "t-1", "ana"), "the event must carry the label")
}

func CheckSaveFirst(ctx *harness.Ctx) {
	probe := ctx.Redis.After("labels:t-1", func() any { return len(ctx.Kafka.Records(topic)) })
	eventsRecord(ctx, eventsLabel(1, "t-1", "ana"))
	ctx.Settle()
	ctx.Assert(probe.Fired, "recordLabel never saved the label (no write to labels:t-1)")
	ctx.Equal(probe.Result, 0, "when the label was saved the topic already held records: an event for a label nobody can read yet is a phantom. Save first, then produce; the records at save time")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "the event must still be produced after the save; the records")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(topic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsRecord(ctx, eventsLabel(1, "t-1", "ana"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one lost acknowledgement the producer's retry must not write the label twice (enable.idempotence); the records")
	eventsRecord(ctx, eventsLabel(2, "t-1", "ana"))
	ctx.Settle()
	ctx.Kafka.Failover(topic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	ok := eventsRecord(ctx, eventsLabel(1, "t-1", "ana"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the label is missing from every agreement count; the rows")
	ctx.Assert(rows[0].Topic == topic && rows[0].Key == "t-1" && rows[0].Payload["label_id"] == "l-1", "the outbox row is %v, expected the topic, the key t-1 and the label", rows[0])
	ctx.Equal(ok, false, "recordLabel's result after a failed delivery")
	ctx.Equal(ctx.Redis.LLen("labels:t-1"), int64(1), "the label must stay saved when only the produce failed")
	ctx.Kafka.Stall(topic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsRecord(ctx, eventsLabel(2, "t-1", "ana"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "recordLabel waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["label_id"] == "l-2", "no report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "recordLabel's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

store::Label eventsLabel(int n, const std::string& task = "t-1", const std::string& annotator = "ana") {
  return store::Label{"l-" + std::to_string(n), task, "i-" + std::to_string(n), annotator, "2026-10", "cat"};
}

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

void CheckTaskKey(harness::Ctx& ctx) {
  recordLabel(eventsLabel(1, "t-1", "ana"));
  recordLabel(eventsLabel(2, "t-2", "bo"));
  recordLabel(eventsLabel(3, "t-1", "cy"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three recordLabel calls must produce three records on label.submitted; the records");
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"t-1", "t-2", "t-1"}, "the records must be keyed by the task ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both t-1 events must land on one partition, or the agreement consumer sees one task out of order; the partitions");
  ctx.Equal(nlohmann::json::parse(ctx.Kafka.Values(kTopic)[0], nullptr, false), store::toJson(eventsLabel(1, "t-1", "ana")), "the event must carry the label");
}

void CheckSaveFirst(harness::Ctx& ctx) {
  size_t atSave = 999;
  bool fired = false;
  ctx.Redis.After("labels:t-1", [&] {
    fired = true;
    atSave = ctx.Kafka.Records(kTopic).size();
  });
  recordLabel(eventsLabel(1));
  ctx.Settle();
  ctx.Assert(fired, "recordLabel never saved the label (no write to labels:t-1)");
  ctx.Equal(atSave, 0, "when the label was saved the topic already held records: an event for a label nobody can read yet is a phantom. Save first, then produce; the records at save time");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "the event must still be produced after the save; the records");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  recordLabel(eventsLabel(1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the label twice (enable.idempotence); the records");
  recordLabel(eventsLabel(2));
  ctx.Settle();
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  bool ok = recordLabel(eventsLabel(1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the label is missing from every agreement count; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kTopic && eventsField(rows[0], "key") == "t-1" && rows[0].contains("payload") && eventsField(rows[0]["payload"], "label_id") == "l-1",
             "the outbox row is %s, expected the topic, the key t-1 and the label", rows[0].dump());
  ctx.Equal(ok, false, "recordLabel's result after a failed delivery");
  ctx.Equal(ctx.Redis.LLen("labels:t-1"), 1LL, "the label must stay saved when only the produce failed");
  ctx.Kafka.Stall(kTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = recordLabel(eventsLabel(2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "recordLabel waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "label_id") == "l-2", "no report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "recordLabel's result without a delivery report");
}
`,
  },
  hints: [
    'The agreement numbers for one task jump around as if labels arrived out of order, and after a broker restart some submitted labels are missing from every count although they are saved.',
    'Kafka orders per partition, so the key decides what stays in order; a produce that is not waited for can fail after the caller returned, and a save after the produce can fail after the event is out.',
    'Key by `task_id`, `store.save_label` first, an idempotent producer with `acks=all`; wait for the delivery report at most 2 s, and on a failure or no report call `store.insert_outbox(topic, task_id, label)` and return false.',
  ],
  debrief: `The key is an ordering contract and save-then-produce is a visibility contract: the agreement consumer must be able to read every label whose event it holds, and must see one task's labels in the order they were submitted. Waiting for the delivery report is what gives the return value a meaning, and the outbox turns a broker outage into late agreement numbers instead of missing ones. The idempotent producer closes the gap waiting opens, a retry after a lost acknowledgement. Production services write the outbox row in the same transaction as the label and let a relay do every produce, so the submit path never waits on the broker; they also register the event's schema so a new field cannot break a consumer silently.`,
};
