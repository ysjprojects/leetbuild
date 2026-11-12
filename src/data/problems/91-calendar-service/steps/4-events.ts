import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'A calendar-keyed change stream, published after the commit',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'sync'],
  task: `## Task

**Starting point.** The starter is \`publish_change(event, kind)\`, called for every change of an
event (\`kind\` is \`create\`, \`update\` or \`cancel\`): it produces the event with its kind as JSON to
\`calendar.event\`, keyed by the event id, without looking at the delivery, and then commits the event
with \`store.put_event\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Two changes of one calendar landing on two partitions, a private
title copied into a topic that keeps it for a week, a commit that fails after its change is out,
and a broker that refuses the record or does not answer.

- The record key is the **calendar id**: Kafka orders per partition, and a sync client applies one
  calendar's changes in order.
- The payload is \`{"event_id", "calendar_id", "revision", "kind"}\` and nothing else: consumers read
  the event from the store.
- **Commit first**: \`store.put_event(event)\` before the produce.
- **Wait for the ack**, at most 2 s. If it does not come, or the delivery fails, insert an
  **outbox** row with the topic, the key and the payload and return \`False\`. In Go the writer is
  kafka-go's synchronous \`WriteMessages\` with \`RequireAll\`, and its error is the delivery report.`,
  sequence: {
    participants: ['Calendar API', 'Redis', 'Kafka calendar.event', 'Outbox'],
    messages: [
      {from: 'Calendar API', to: 'Redis', label: 'put_event(event) · committed', kind: 'sync'},
      {from: 'Calendar API', to: 'Kafka calendar.event', label: 'produce key = calendar_id · ids only', kind: 'sync'},
      {from: 'Kafka calendar.event', to: 'Calendar API', label: 'ack within 2 s → True', kind: 'reply'},
      {from: 'Kafka calendar.event', to: 'Calendar API', label: 'no ack / delivery failed', kind: 'reply'},
      {from: 'Calendar API', to: 'Outbox', label: 'insert(topic, key, payload) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'calendar-key',
      title: 'Keys calendar.event by the calendar id',
      detail:
        'Changes of e-1 and e-3 on c1 and e-2 on c2 carry the keys c1, c1, c2, and the two c1 records share a partition. The starter keys by event id, which spreads one calendar over every partition.',
      match: {
        python: {all: [/producer\.produce\(\s*[^\n]*key\s*=\s*event\[["']calendar_id["']\]/]},
        typescript: {all: [/key:\s*event\.calendar_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*e\.CalendarID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"calendar\.event")\s*,\s*event\.calendar_id\s*,/]},
        cpp: {all: [/e\.calendar_id\.c_str\(\)\s*,\s*e\.calendar_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'ids-only',
      title: 'Carries ids and the revision, not the event',
      detail:
        'The value is exactly `{"event_id", "calendar_id", "revision", "kind"}`. The starter sends the whole event, so titles and attendee addresses stay in the topic for its retention, after the event itself is deleted.',
      match: {
        python: {all: [/["']revision["']\s*:\s*event\[["']revision["']\]/], none: [/\*\*event\b/]},
        typescript: {all: [/revision:\s*event\.revision/], none: [/\.\.\.event\b/]},
        go: {all: [/"revision":\s*e\.Revision/], none: [/"title"|"attendees"/]},
        scala: {all: [/"revision"\s*->\s*JsNumber\(\s*event\.revision\s*\)/], none: [/event\.toJson/]},
        cpp: {all: [/\{"revision",\s*e\.revision\}/], none: [/json\(\s*e\s*\)/]},
      },
    },
    {
      id: 'commit-then-publish',
      title: 'Commits the event before producing its change',
      detail:
        'When `event:{id}` is written the topic is still empty: the change follows the commit. The starter produces first, so a commit that fails leaves a change no consumer can read.',
      match: {
        python: {order: [/store\.put_event\(/, /producer\.produce\(/]},
        typescript: {order: [/await store\.putEvent\(/, /producer\.send\(/]},
        go: {order: [/store\.PutEvent\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/Store\.putEvent\(/, /producer\.send\(/]},
        cpp: {order: [/store::PutEvent\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the ack and falls back to the outbox',
      detail:
        'A failed delivery, or no acknowledgement within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter fires and forgets, so the change is lost.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {
          all: [/store\.InsertOutbox\(/, /err\s*:?=\s*writer\.WriteMessages\(/],
          none: [/_\s*=\s*writer\.WriteMessages\(/],
        },
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/outbox::Insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from calendard.store import outbox, store

TOPIC = "calendar.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def change_payload(event: dict, kind: str) -> dict:
    """The change as the stream carries it."""
    return {**event, "kind": kind}


def publish_change(event: dict, kind: str) -> bool:
    """Commit the change and announce it to the sync consumers; True when the change is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = change_payload(event, kind)
    producer.produce(TOPIC, key=event["event_id"], value=json.dumps(payload))
    producer.poll(0)
    store.put_event(event)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from calendard.store import outbox, store

TOPIC = "calendar.event"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def change_payload(event: dict, kind: str) -> dict:
    """What a sync consumer needs to fetch the change: ids and the revision. The event stays in the store."""
    return {
        "event_id": event["event_id"],
        "calendar_id": event["calendar_id"],
        "revision": event["revision"],
        "kind": kind,
    }


def publish_change(event: dict, kind: str) -> bool:
    """Commit the change, then announce it to the sync consumers; True once the broker acknowledged it."""
    # The event is durable before its change exists: a change nobody can read is a phantom.
    store.put_event(event)
    payload = change_payload(event, kind)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=event["calendar_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so sync is late, not wrong.
        outbox.insert(TOPIC, event["calendar_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Event, store} from 'calendard/store';

export const TOPIC = 'calendar.event';

const kafka = new Kafka({clientId: 'calendard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** The change as the stream carries it. */
export function changePayload(event: Event, kind: string) {
  return {...event, kind};
}

/** Commit the change and announce it to the sync consumers; true when the change is on its way. */
export async function publishChange(event: Event, kind: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = changePayload(event, kind);
  void producer.send({topic: TOPIC, messages: [{key: event.event_id, value: JSON.stringify(payload)}], acks: -1});
  await store.putEvent(event);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Event, outbox, store} from 'calendard/store';

export const TOPIC = 'calendar.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'calendard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What a sync consumer needs to fetch the change: ids and the revision. The event stays in the store. */
export function changePayload(event: Event, kind: string) {
  return {event_id: event.event_id, calendar_id: event.calendar_id, revision: event.revision, kind};
}

/** Commit the change, then announce it to the sync consumers; true once the broker acknowledged it. */
export async function publishChange(event: Event, kind: string): Promise<boolean> {
  // The event is durable before its change exists: a change nobody can read is a phantom.
  await store.putEvent(event);
  const payload = changePayload(event, kind);
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: event.calendar_id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so sync is late, not wrong.
    await outbox.insert(TOPIC, event.calendar_id, payload);
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
	"time"

	"github.com/segmentio/kafka-go"

	"calendard/store"
)

const topic = "calendar.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

// changePayload is the change as the stream carries it.
func changePayload(e *store.Event, kind string) map[string]any {
	return map[string]any{
		"event_id": e.EventID, "calendar_id": e.CalendarID, "tenant": e.Tenant, "title": e.Title, "rrule": e.Rrule,
		"dtstart": e.Dtstart, "dtend": e.Dtend, "revision": e.Revision, "attendees": e.Attendees, "kind": kind,
	}
}

// publishChange commits the change and announces it to the sync consumers; true when the change is on its way.
func publishChange(ctx context.Context, e *store.Event, kind string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(changePayload(e, kind))
	_ = writer.WriteMessages(ctx, kafka.Message{Key: []byte(e.EventID), Value: value})
	if err := store.PutEvent(ctx, e); err != nil {
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

	"github.com/segmentio/kafka-go"

	"calendard/store"
)

const (
	topic      = "calendar.event"
	ackTimeout = 2 * time.Second
)

// A synchronous writer: WriteMessages returns once every replica has the record, or with the error.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

// changePayload is what a sync consumer needs to fetch the change: ids and the revision. The event stays in the store.
func changePayload(e *store.Event, kind string) map[string]any {
	return map[string]any{"event_id": e.EventID, "calendar_id": e.CalendarID, "revision": e.Revision, "kind": kind}
}

// publishChange commits the change, then announces it to the sync consumers; true once the broker acknowledged it.
func publishChange(ctx context.Context, e *store.Event, kind string) (bool, error) {
	// The event is durable before its change exists: a change nobody can read is a phantom.
	if err := store.PutEvent(ctx, e); err != nil {
		return false, err
	}
	payload := changePayload(e, kind)
	value, _ := json.Marshal(payload)
	writeCtx, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()
	if err := writer.WriteMessages(writeCtx, kafka.Message{Key: []byte(e.CalendarID), Value: value}); err != nil {
		// The broker did not take it: the relay publishes the row later, so sync is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, e.CalendarID, payload); err != nil {
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
import spray.json._

import calendard.{Event, Store}

object ChangeEvents {
  val Topic = "calendar.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** The change as the stream carries it. */
  def changePayload(event: Event, kind: String): JsObject =
    JsObject(event.toJson.asJsObject.fields + ("kind" -> JsString(kind)))

  /** Commit the change and announce it to the sync consumers; true when the change is on its way. */
  def publishChange(event: Event, kind: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = changePayload(event, kind)
    producer.send(new ProducerRecord[String, String](Topic, event.event_id, payload.compactPrint))
    Store.putEvent(event)
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

import calendard.{Event, Store}

object ChangeEvents {
  val Topic = "calendar.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What a sync consumer needs to fetch the change: ids and the revision. The event stays in the store. */
  def changePayload(event: Event, kind: String): JsObject =
    JsObject(
      "event_id" -> JsString(event.event_id),
      "calendar_id" -> JsString(event.calendar_id),
      "revision" -> JsNumber(event.revision),
      "kind" -> JsString(kind)
    )

  /** Commit the change, then announce it to the sync consumers; true once the broker acknowledged it. */
  def publishChange(event: Event, kind: String): Boolean = {
    // The event is durable before its change exists: a change nobody can read is a phantom.
    Store.putEvent(event)
    val payload = changePayload(event, kind)
    val record = new ProducerRecord[String, String](Topic, event.calendar_id, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so sync is late, not wrong.
      Store.insertOutbox(Topic, event.calendar_id, payload)
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

#include "calendard/store.h"

using json = nlohmann::json;

const std::string kTopic = "calendar.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// The change as the stream carries it.
json changePayload(const calendard::Event& e, const std::string& kind) {
  json payload = json(e);
  payload["kind"] = kind;
  return payload;
}

// Commit the change and announce it to the sync consumers; true when the change is on its way.
bool publishChange(const calendard::Event& e, const std::string& kind) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string value = changePayload(e, kind).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), e.event_id.c_str(), e.event_id.size(), 0, nullptr);
  producer->poll(0);
  calendard::store::PutEvent(e);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "calendard/store.h"

using json = nlohmann::json;

const std::string kTopic = "calendar.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishChange produces one record and waits for it.
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

auto producer = makeProducer();

// What a sync consumer needs to fetch the change: ids and the revision. The event stays in the store.
json changePayload(const calendard::Event& e, const std::string& kind) {
  return json{{"event_id", e.event_id}, {"calendar_id", e.calendar_id}, {"revision", e.revision}, {"kind", kind}};
}

// Commit the change, then announce it to the sync consumers; true once the broker acknowledged it.
bool publishChange(const calendard::Event& e, const std::string& kind) {
  // The event is durable before its change exists: a change nobody can read is a phantom.
  calendard::store::PutEvent(e);
  const json payload = changePayload(e, kind);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), e.calendar_id.c_str(), e.calendar_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so sync is late, not wrong.
    calendard::outbox::Insert(kTopic, e.calendar_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "calendar.event"


def _event(n, calendar="c1"):
    return {
        "event_id": f"e-{n}",
        "calendar_id": calendar,
        "tenant": "t1",
        "title": "1:1 with Ana (performance review)",
        "rrule": "FREQ=WEEKLY;COUNT=4",
        "dtstart": "2026-03-02T09:00:00Z",
        "dtend": "2026-03-02T09:30:00Z",
        "revision": 2,
        "attendees": ["ana@example.com", "bo@example.com"],
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_calendar_key(ctx):
    m = ctx.load("events")
    m.publish_change(_event(1, "c1"), "update")
    m.publish_change(_event(2, "c2"), "update")
    m.publish_change(_event(3, "c1"), "update")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_change calls produced {len(records)} records on calendar.event (topics: {sorted(ctx.kafka.topics)})"
    keys = sorted(r.key for r in records)
    assert keys == [b"c1", b"c1", b"c2"], f"the records are keyed {keys}, expected the calendar ids c1, c1, c2"
    partitions = {r.partition for r in records if r.key == b"c1"}
    assert len(partitions) == 1, f"the two c1 changes landed on partitions {sorted(partitions)}: a sync client sees one calendar's changes out of order"


def check_ids_only(ctx):
    m = ctx.load("events")
    m.publish_change(_event(1), "update")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_change produced {len(records)} records"
    value = json.loads(records[0].value)
    expected = {"event_id": "e-1", "calendar_id": "c1", "revision": 2, "kind": "update"}
    assert value == expected, f"the record carries {sorted(value)}, expected exactly {sorted(expected)}: a title or an attendee address in the topic stays there for the retention, after the event is deleted"


def check_commit_then_publish(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("event:e-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.publish_change(_event(1), "update")
    assert probe.fired, "publish_change never committed the event (no write to event:e-1)"
    assert probe.result == 0, f"when the event was committed the topic already held {probe.result} record(s): a change for a revision nobody can read yet is a phantom. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the change must still be produced after the commit"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_change(_event(1), "update")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the change never reaches a sync client"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "c1" and rows[0].get("payload", {}).get("event_id") == "e-1", f"the outbox row is {rows[0]}, expected the topic, the key c1 and the payload"
    assert ok is False, f"publish_change returned {ok!r} after a failed delivery, expected False"
    assert ctx.redis.exists("event:e-1") == 1, "the event must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_change(_event(2), "update")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_change waited {waited:.0f} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("event_id") == "e-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish_change returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'calendar.event';

const event = (n: number, calendar = 'c1') => ({
  event_id: \`e-\${n}\`,
  calendar_id: calendar,
  tenant: 't1',
  title: '1:1 with Ana (performance review)',
  rrule: 'FREQ=WEEKLY;COUNT=4',
  dtstart: '2026-03-02T09:00:00Z',
  dtend: '2026-03-02T09:30:00Z',
  revision: 2,
  attendees: ['ana@example.com', 'bo@example.com'],
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_calendar_key(ctx) {
  const m = ctx.load('events');
  await m.publishChange(event(1, 'c1'), 'update');
  await m.publishChange(event(2, 'c2'), 'update');
  await m.publishChange(event(3, 'c1'), 'update');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishChange calls produced \${records.length} records on calendar.event\`);
  const keys = [...ctx.kafka.keys(TOPIC)].sort();
  assert.deepEqual(keys, ['c1', 'c1', 'c2'], \`the records are keyed \${JSON.stringify(keys)}, expected the calendar ids c1, c1, c2\`);
  const partitions = new Set(records.filter((_, i) => ctx.kafka.keys(TOPIC)[i] === 'c1').map(r => r.partition));
  assert.equal(partitions.size, 1, \`the two c1 changes landed on partitions \${JSON.stringify([...partitions])}: a sync client sees one calendar's changes out of order\`);
}

export async function check_ids_only(ctx) {
  const m = ctx.load('events');
  await m.publishChange(event(1), 'update');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishChange produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  const expected = {event_id: 'e-1', calendar_id: 'c1', revision: 2, kind: 'update'};
  assert.deepEqual(value, expected, \`the record carries \${JSON.stringify(Object.keys(value).sort())}, expected exactly \${JSON.stringify(Object.keys(expected).sort())}: a title or an attendee address in the topic stays there for the retention, after the event is deleted\`);
}

export async function check_commit_then_publish(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter('event:e-1', () => ctx.kafka.records(TOPIC).length);
  await m.publishChange(event(1), 'update');
  await settle();
  assert(probe.fired, 'publishChange never committed the event (no write to event:e-1)');
  assert.equal(probe.result, 0, \`when the event was committed the topic already held \${probe.result} record(s): a change for a revision nobody can read yet is a phantom. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the change must still be produced after the commit');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishChange(event(1), 'update');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the change never reaches a sync client\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'c1' && rows[0].payload?.event_id === 'e-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key c1 and the payload\`);
  assert.equal(ok, false, \`publishChange resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal(ctx.redis.exists('event:e-1'), 1, 'the event must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishChange(event(2), 'update');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishChange waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.event_id === 'e-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishChange resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"leetbuild/harness"

	"calendard/store"
)

const evTopic = "calendar.event"

func evEvent(n int, calendar string) *store.Event {
	return &store.Event{
		EventID: fmt.Sprintf("e-%d", n), CalendarID: calendar, Tenant: "t1", Title: "1:1 with Ana (performance review)",
		Rrule: "FREQ=WEEKLY;COUNT=4", Dtstart: "2026-03-02T09:00:00Z", Dtend: "2026-03-02T09:30:00Z", Revision: 2,
		Attendees: []string{"ana@example.com", "bo@example.com"},
	}
}

func evPublish(ctx *harness.Ctx, e *store.Event) bool {
	ok, err := publishChange(context.Background(), e, "update")
	ctx.NoError(err, "publishChange")
	return ok
}

type evRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func evOutbox(ctx *harness.Ctx) []evRow {
	var rows []evRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row evRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckCalendarKey(ctx *harness.Ctx) {
	evPublish(ctx, evEvent(1, "c1"))
	evPublish(ctx, evEvent(2, "c2"))
	evPublish(ctx, evEvent(3, "c1"))
	ctx.Settle()
	records := ctx.Kafka.Records(evTopic)
	ctx.Equal(len(records), 3, "three publishChange calls must produce three records on calendar.event; the records")
	keys := ctx.Kafka.Keys(evTopic)
	sorted := append([]string{}, keys...)
	sort.Strings(sorted)
	ctx.Equal(sorted, []string{"c1", "c1", "c2"}, "the records must be keyed by the calendar ids")
	partitions := map[int]bool{}
	for i, r := range records {
		if keys[i] == "c1" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "the two c1 changes must share a partition, or a sync client sees one calendar's changes out of order; the partitions")
}

func CheckIdsOnly(ctx *harness.Ctx) {
	evPublish(ctx, evEvent(1, "c1"))
	ctx.Settle()
	values := ctx.Kafka.Values(evTopic)
	ctx.Equal(len(values), 1, "one publishChange must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Equal(value, map[string]any{"event_id": "e-1", "calendar_id": "c1", "revision": 2, "kind": "update"},
		"the payload (a title or an attendee address in the topic stays there for the retention, after the event is deleted)")
}

func CheckCommitThenPublish(ctx *harness.Ctx) {
	probe := ctx.Redis.After("event:e-1", func() any { return len(ctx.Kafka.Records(evTopic)) })
	evPublish(ctx, evEvent(1, "c1"))
	ctx.Settle()
	ctx.Assert(probe.Fired, "publishChange never committed the event (no write to event:e-1)")
	ctx.Equal(probe.Result, 0, "when the event was committed the topic already held records: a change for a revision nobody can read yet is a phantom. Commit first, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(evTopic)), 1, "the change must still be produced after the commit; the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(evTopic, 1)
	ok := evPublish(ctx, evEvent(1, "c1"))
	ctx.Settle()
	rows := evOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the change never reaches a sync client; the rows")
	ctx.Assert(rows[0].Topic == evTopic && rows[0].Key == "c1" && rows[0].Payload["event_id"] == "e-1", "the outbox row is %v, expected the topic, the key c1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishChange's result after a failed delivery")
	ctx.Equal(ctx.Redis.Exists("event:e-1"), 1, "the event must stay committed when only the produce failed")
	ctx.Kafka.Stall(evTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = evPublish(ctx, evEvent(2, "c1"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishChange waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited)
	rows = evOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["event_id"] == "e-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishChange's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

namespace {

const std::string kEvTopic = "calendar.event";

calendard::Event evEvent(int n, const std::string& calendar = "c1") {
  return calendard::Event{"e-" + std::to_string(n), calendar, "t1", "1:1 with Ana (performance review)", "FREQ=WEEKLY;COUNT=4",
                          "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z", 2, {"ana@example.com", "bo@example.com"}};
}

std::vector<nlohmann::json> evOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string evField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckCalendarKey(harness::Ctx& ctx) {
  publishChange(evEvent(1, "c1"), "update");
  publishChange(evEvent(2, "c2"), "update");
  publishChange(evEvent(3, "c1"), "update");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEvTopic);
  ctx.Equal(records.size(), 3, "three publishChange calls must produce three records on calendar.event; the records");
  const auto keys = ctx.Kafka.Keys(kEvTopic);
  auto sorted = keys;
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, {"c1", "c1", "c2"}, "the records must be keyed by the calendar ids");
  std::set<int> partitions;
  for (size_t i = 0; i < records.size() && i < keys.size(); i++) {
    if (keys[i] == "c1") partitions.insert(records[i].Partition);
  }
  ctx.Equal(partitions.size(), 1,
            "the two c1 changes must share a partition, or a sync client sees one calendar's changes out of order; the partitions");
}

void CheckIdsOnly(harness::Ctx& ctx) {
  publishChange(evEvent(1), "update");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEvTopic);
  ctx.Equal(values.size(), 1, "one publishChange must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Equal(value, nlohmann::json{{"event_id", "e-1"}, {"calendar_id", "c1"}, {"revision", 2}, {"kind", "update"}},
            "the payload (a title or an attendee address in the topic stays there for the retention, after the event is deleted)");
}

void CheckCommitThenPublish(harness::Ctx& ctx) {
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("event:e-1", [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEvTopic).size();
  });
  publishChange(evEvent(1), "update");
  ctx.Settle();
  ctx.Assert(fired, "publishChange never committed the event (no write to event:e-1)");
  ctx.Equal(atCommit, 0,
            "when the event was committed the topic already held records: a change for a revision nobody can read yet is a "
            "phantom. Commit first, then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEvTopic).size(), 1, "the change must still be produced after the commit; the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEvTopic, 1);
  bool ok = publishChange(evEvent(1), "update");
  ctx.Settle();
  auto rows = evOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the change never reaches a sync client; the rows");
  ctx.Assert(evField(rows[0], "topic") == kEvTopic && evField(rows[0], "key") == "c1" && rows[0].contains("payload") &&
                 evField(rows[0]["payload"], "event_id") == "e-1",
             "the outbox row is %s, expected the topic, the key c1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishChange's result after a failed delivery");
  ctx.Equal(ctx.Redis.Exists("event:e-1"), 1, "the event must stay committed when only the produce failed");
  ctx.Kafka.Stall(kEvTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishChange(evEvent(2), "update");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishChange waited %.0f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited);
  rows = evOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && evField(rows[1]["payload"], "event_id") == "e-2",
             "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishChange's result without an acknowledgement");
}
`,
  },
  hints: [
    "A phone shows Tuesday's change of a calendar before Monday's, an attendee list turns up in another team's copy of the topic, and during a broker restart some edits never reach any phone.",
    'Partition order holds per key, so the key decides what stays ordered; the payload is the whole event; nobody waits for the produce, so a refused record leaves nothing behind; a commit after the produce can fail after the change is out.',
    'Key by `calendar_id`, send only `event_id`, `calendar_id`, `revision` and `kind`, call `store.put_event` first, then produce with a delivery callback and `flush(2)`; on an error or a record still in flight, insert the outbox row and return `False`.',
  ],
  debrief: `The key is an ordering contract and commit-then-produce is a visibility contract: a consumer must be able to read any revision whose change it holds, and must see one calendar's changes in the order they happened. The payload carries ids because the topic is a copy with its own retention and its own readers, and whatever goes in stays there after the event is deleted. Waiting for the acknowledgement gives the return value a meaning, and the outbox turns a broker outage into a delay instead of a loss. Production services write the outbox row in the same transaction as the event and let a relay do every produce, so the request path never waits on the broker.`,
};
