import type {Step} from '@/lib/types';

export const bookingEventsStep: Step = {
  id: 'events',
  title: 'Booking events keyed by resource for schedule order',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'redis', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`publish_event(booking, event_type)\`, called for the \`created\`,
\`rescheduled\` and \`cancelled\` transitions: it builds a producer at boot, produces a JSON payload with
the type, the booking id, the resource and the range to \`booking.event\`, then commits the booking
with \`store.put\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Two bookings of one room landing on two partitions, a consumer
replaying an event with no hold to match, a commit that fails after its event is out, a broker that
lost an acknowledgement, a leader that failed over, and a broker that does not answer at all.

- The record key is the **resource id**: Kafka orders per partition, so one room's events must share
  one.
- The payload is \`{"type", "booking_id", "hold_id", "resource_id", "range": {"start", "end"}}\`.
- **Commit first**: \`store.put(booking)\` before the produce.
- The producer is **idempotent** with **\`acks=all\`**, so a retried write lands once and a failover
  keeps it.
- **Wait for the ack**, at most 2 s; if it does not come, or the delivery fails, insert an **outbox**
  row with the topic, the key and the payload and return \`False\`.`,
  sequence: {
    participants: ['Booking API', 'Booking store', 'Kafka booking.event', 'Outbox'],
    messages: [
      {from: 'Booking API', to: 'Booking store', label: 'put(booking) · committed', kind: 'sync'},
      {
        from: 'Booking API',
        to: 'Kafka booking.event',
        label: 'produce key = resource_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'Kafka booking.event', to: 'Booking API', label: 'ack within 2 s → True', kind: 'reply'},
      {from: 'Kafka booking.event', to: 'Booking API', label: 'no ack / delivery failed', kind: 'reply'},
      {from: 'Booking API', to: 'Outbox', label: 'insert(topic, key, payload) → False', kind: 'async'},
      {from: 'Outbox', to: 'Kafka booking.event', label: 'relay republishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'resource-key',
      title: 'Keys booking.event by the resource id',
      detail:
        'Three events for r1, r2, r1 carry those keys and the two r1 events share a partition. The starter keys by booking id, which spreads one room over every partition.',
      match: {
        python: {all: [/producer\.produce\(\s*[^\n]*key\s*=\s*booking\[["']resource_id["']\]/]},
        typescript: {all: [/key:\s*booking\.resource_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*(b|booking)\.ResourceID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"booking\.event")\s*,\s*booking\.resource_id\s*,/]},
        cpp: {all: [/(b|booking)\.resource_id\.c_str\(\)\s*,\s*(b|booking)\.resource_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'event-payload',
      title: 'Carries the hold id and the range',
      detail:
        'The value names `hold_id` and a `range` object with `start` and `end`. The starter sends a flat start and end and no hold id.',
      match: {
        python: {all: [/["']hold_id["']\s*:/, /["']range["']\s*:\s*\{/]},
        typescript: {all: [/hold_id:/, /range:\s*\{/]},
        go: {all: [/"hold_id"/, /"range"/]},
        scala: {all: [/"hold_id"/, /"range"/]},
        cpp: {all: [/"hold_id"/, /"range"/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Commits the booking before producing its event',
      detail:
        'When the booking hash is written the topic is still empty: the event follows the commit. A commit Redis refuses produces no event and no outbox row. The starter produces first.',
      match: {
        python: {order: [/store\.put\(/, /producer\.produce\(/]},
        typescript: {order: [/await store\.put\(/, /producer\.send\(/]},
        go: {order: [/store\.Put\(/, /producer\.Produce\(/]},
        scala: {order: [/Store\.put\(/, /producer\.send\(/]},
        cpp: {order: [/store::Put\(/, /producer->produce\(/]},
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
      title: 'Waits for the ack and falls back to the outbox',
      detail:
        'A delivered event returns true and writes no outbox row. A failed delivery, or no acknowledgement within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch/]},
        cpp: {all: [/outbox::Insert\(/, /->(flush|poll)\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from booking.store import outbox, store

TOPIC = "booking.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(booking: dict, event_type: str) -> dict:
    return {
        "type": event_type,
        "booking_id": booking["booking_id"],
        "resource_id": booking["resource_id"],
        "start": booking["start"],
        "end": booking["end"],
    }


def publish_event(booking: dict, event_type: str) -> bool:
    """Commit the transition and tell the schedule consumers; True when the event is on its way."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = event_payload(booking, event_type)
    producer.produce(TOPIC, key=booking["booking_id"], value=json.dumps(payload))
    producer.poll(0)
    store.put(booking)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from booking.store import outbox, store

TOPIC = "booking.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(booking: dict, event_type: str) -> dict:
    """Everything a schedule consumer needs to apply the event: the hold it matches and the range it covers."""
    return {
        "type": event_type,
        "booking_id": booking["booking_id"],
        "hold_id": booking["hold_id"],
        "resource_id": booking["resource_id"],
        "range": {"start": booking["start"], "end": booking["end"]},
    }


def publish_event(booking: dict, event_type: str) -> bool:
    """Commit the transition, then tell the schedule consumers; True once the broker acknowledged the event."""
    # The booking is durable before its event exists: an event nobody can look up is a phantom.
    store.put(booking)
    payload = event_payload(booking, event_type)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=booking["resource_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the schedule is late, not wrong.
        outbox.insert(TOPIC, booking["resource_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Booking, outbox, store} from 'booking/store';

export const TOPIC = 'booking.event';

const kafka = new Kafka({clientId: 'bookd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(booking: Booking, eventType: string) {
  return {
    type: eventType,
    booking_id: booking.booking_id,
    resource_id: booking.resource_id,
    start: booking.start,
    end: booking.end,
  };
}

/** Commit the transition and tell the schedule consumers; true when the event is on its way. */
export async function publishEvent(booking: Booking, eventType: string): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(booking, eventType);
  void producer.send({topic: TOPIC, messages: [{key: booking.booking_id, value: JSON.stringify(payload)}], acks: 1});
  await store.put(booking);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Booking, outbox, store} from 'booking/store';

export const TOPIC = 'booking.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'bookd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Everything a schedule consumer needs to apply the event: the hold it matches and the range it covers. */
export function eventPayload(booking: Booking, eventType: string) {
  return {
    type: eventType,
    booking_id: booking.booking_id,
    hold_id: booking.hold_id,
    resource_id: booking.resource_id,
    range: {start: booking.start, end: booking.end},
  };
}

/** Commit the transition, then tell the schedule consumers; true once the broker acknowledged the event. */
export async function publishEvent(booking: Booking, eventType: string): Promise<boolean> {
  // The booking is durable before its event exists: an event nobody can look up is a phantom.
  await store.put(booking);
  const payload = eventPayload(booking, eventType);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: booking.resource_id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the schedule is late, not wrong.
    await outbox.insert(TOPIC, booking.resource_id, payload);
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

	"booking/store"
)

const topic = "booking.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(b *store.Booking, eventType string) map[string]any {
	return map[string]any{
		"type":        eventType,
		"booking_id":  b.BookingID,
		"resource_id": b.ResourceID,
		"start":       b.Start,
		"end":         b.End,
	}
}

// publishEvent commits the transition and tells the schedule consumers; true when the event is on its way.
func publishEvent(ctx context.Context, b *store.Booking, eventType string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(eventPayload(b, eventType))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(b.BookingID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if err := store.Put(ctx, b); err != nil {
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

	"booking/store"
)

const (
	topic      = "booking.event"
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

// eventPayload is everything a schedule consumer needs to apply the event: the hold it matches and the range it covers.
func eventPayload(b *store.Booking, eventType string) map[string]any {
	return map[string]any{
		"type":        eventType,
		"booking_id":  b.BookingID,
		"hold_id":     b.HoldID,
		"resource_id": b.ResourceID,
		"range":       map[string]string{"start": b.Start, "end": b.End},
	}
}

// publishEvent commits the transition, then tells the schedule consumers; true once the broker acknowledged the event.
func publishEvent(ctx context.Context, b *store.Booking, eventType string) (bool, error) {
	// The booking is durable before its event exists: an event nobody can look up is a phantom.
	if err := store.Put(ctx, b); err != nil {
		return false, err
	}
	payload := eventPayload(b, eventType)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(b.ResourceID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the schedule is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, b.ResourceID, payload); err != nil {
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

import booking.{Booking, Store}

object BookingEvents {
  val Topic = "booking.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(booking: Booking, eventType: String): JsObject =
    JsObject(
      "type" -> JsString(eventType),
      "booking_id" -> JsString(booking.booking_id),
      "resource_id" -> JsString(booking.resource_id),
      "start" -> JsString(booking.start),
      "end" -> JsString(booking.end)
    )

  /** Commit the transition and tell the schedule consumers; true when the event is on its way. */
  def publishEvent(booking: Booking, eventType: String): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(booking, eventType)
    producer.send(new ProducerRecord[String, String](Topic, booking.booking_id, payload.compactPrint))
    Store.put(booking)
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

import booking.{Booking, Store}

object BookingEvents {
  val Topic = "booking.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Everything a schedule consumer needs to apply the event: the hold it matches and the range it covers. */
  def eventPayload(booking: Booking, eventType: String): JsObject =
    JsObject(
      "type" -> JsString(eventType),
      "booking_id" -> JsString(booking.booking_id),
      "hold_id" -> JsString(booking.hold_id),
      "resource_id" -> JsString(booking.resource_id),
      "range" -> JsObject("start" -> JsString(booking.start), "end" -> JsString(booking.end))
    )

  /** Commit the transition, then tell the schedule consumers; true once the broker acknowledged the event. */
  def publishEvent(booking: Booking, eventType: String): Boolean = {
    // The booking is durable before its event exists: an event nobody can look up is a phantom.
    Store.put(booking)
    val payload = eventPayload(booking, eventType)
    val record = new ProducerRecord[String, String](Topic, booking.resource_id, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the schedule is late, not wrong.
      Store.insertOutbox(Topic, booking.resource_id, payload)
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

#include "booking/store.h"

using json = nlohmann::json;

const std::string kTopic = "booking.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const booking::Booking& b, const std::string& event_type) {
  return json{{"type", event_type}, {"booking_id", b.booking_id}, {"resource_id", b.resource_id}, {"start", b.start}, {"end", b.end}};
}

// Commit the transition and tell the schedule consumers; true when the event is on its way.
bool publishEvent(const booking::Booking& b, const std::string& event_type) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string value = eventPayload(b, event_type).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), b.booking_id.c_str(), b.booking_id.size(), 0, nullptr);
  producer->poll(0);
  booking::store::Put(b);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <memory>
#include <string>

#include "booking/store.h"

using json = nlohmann::json;

const std::string kTopic = "booking.event";
constexpr int kAckTimeoutMs = 2000;

// One record's delivery outcome. Its report may arrive on any thread that polls the producer, so
// each record carries its own (as msg_opaque) and two requests publishing at once never share one.
struct Outcome {
  std::atomic<bool> done{false};
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
};

class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    // The opaque is a heap copy of the record's shared_ptr: a report arriving after its publisher
    // gave up still writes to a live Outcome, and frees the copy.
    auto* outcome = static_cast<std::shared_ptr<Outcome>*>(message.msg_opaque());
    if (outcome == nullptr) return;
    (*outcome)->error = message.err();
    (*outcome)->done.store(true, std::memory_order_release);
    delete outcome;
  }
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

// Everything a schedule consumer needs to apply the event: the hold it matches and the range it covers.
json eventPayload(const booking::Booking& b, const std::string& event_type) {
  return json{{"type", event_type},
              {"booking_id", b.booking_id},
              {"hold_id", b.hold_id},
              {"resource_id", b.resource_id},
              {"range", json{{"start", b.start}, {"end", b.end}}}};
}

// Commit the transition, then tell the schedule consumers; true once the broker acknowledged the event.
bool publishEvent(const booking::Booking& b, const std::string& event_type) {
  // The booking is durable before its event exists: an event nobody can look up is a phantom.
  booking::store::Put(b);
  const json payload = eventPayload(b, event_type);
  const std::string value = payload.dump();
  auto outcome = std::make_shared<Outcome>();
  auto* opaque = new std::shared_ptr<Outcome>(outcome);
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), b.resource_id.c_str(), b.resource_id.size(), 0, opaque);
  if (err != RdKafka::ERR_NO_ERROR) {
    delete opaque;  // never queued: no report will come for it
  } else {
    // Serve delivery reports until this record's arrives, or give up after the window.
    const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(kAckTimeoutMs);
    while (!outcome->done.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < until) producer->poll(100);
    err = outcome->done.load(std::memory_order_acquire) ? outcome->error : RdKafka::ERR__TIMED_OUT;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the schedule is late, not wrong.
    booking::outbox::Insert(kTopic, b.resource_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "booking.event"


def _booking(n, resource="r1"):
    return {
        "booking_id": f"b-{n}",
        "tenant": "t1",
        "resource_id": resource,
        "start": "2026-03-10T09:00:00Z",
        "end": "2026-03-10T10:00:00Z",
        "hold_id": f"h-{n}",
        "idempotency_key": f"k-{n}",
        "state": "held",
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_resource_key(ctx):
    m = ctx.load("events")
    m.publish_event(_booking(1, "r1"), "created")
    m.publish_event(_booking(2, "r2"), "created")
    m.publish_event(_booking(3, "r1"), "created")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_event calls produced {len(records)} records on booking.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"r1", b"r2", b"r1"], f"the records are keyed {keys}, expected the resource ids r1, r2, r1"
    assert records[0].partition == records[2].partition, "both r1 events must land on one partition, or a consumer sees one room's schedule out of order"


def check_event_payload(ctx):
    m = ctx.load("events")
    m.publish_event(_booking(1), "created")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_event produced {len(records)} records"
    value = json.loads(records[0].value)
    assert value.get("type") == "created" and value.get("booking_id") == "b-1" and value.get("resource_id") == "r1", f"the payload is {value}, expected type, booking_id and resource_id"
    assert value.get("hold_id") == "h-1", f"the payload carries no hold_id: {value}. A consumer cannot match the event to the hold it saw"
    assert value.get("range") == {"start": "2026-03-10T09:00:00Z", "end": "2026-03-10T10:00:00Z"}, f"the payload's range is {value.get('range')!r}, expected {{\\"start\\", \\"end\\"}}"


def check_publish_after_commit(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("booking:b-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.publish_event(_booking(1), "created")
    assert probe.fired, "publish_event never committed the booking (no write to booking:b-1)"
    assert probe.result == 0, f"when the booking was committed the topic already held {probe.result} record(s): an event for a booking nobody can read yet is a phantom. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"
    # The store refuses the next commit (booking:b-2 holds a value of another type): no event may go out.
    ctx.redis.set("booking:b-2", "not a booking")
    records, rows = len(ctx.kafka.records(TOPIC)), len(_outbox(ctx))
    try:
        m.publish_event(_booking(2), "created")
    except Exception:
        pass  # the commit's error reaching the caller is fine
    produced, queued = len(ctx.kafka.records(TOPIC)) - records, len(_outbox(ctx)) - rows
    assert produced == 0 and queued == 0, f"a booking whose commit failed still produced an event ({produced} record(s), {queued} outbox row(s)): produce only once the commit has succeeded"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_event(_booking(1), "created")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_event(_booking(2), "created")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ok = m.publish_event(_booking(3), "created")
    assert ok is True and _outbox(ctx) == [], f"a delivered event returned {ok!r} and left the outbox {_outbox(ctx)}, expected True and no row: only a failed or unacknowledged delivery goes to the outbox"
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_event(_booking(1), "created")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the booking vanishes from every downstream calendar"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "r1" and rows[0].get("payload", {}).get("booking_id") == "b-1", f"the outbox row is {rows[0]}, expected the topic, the key r1 and the payload"
    assert ok is False, f"publish_event returned {ok!r} after a failed delivery, expected False"
    assert ctx.redis.exists("booking:b-1") == 1, "the booking must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_event(_booking(2), "created")
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"publish_event waited {waited:.1f} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("booking_id") == "b-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish_event returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'booking.event';

const booking = (n: number, resource = 'r1') => ({
  booking_id: \`b-\${n}\`,
  tenant: 't1',
  resource_id: resource,
  start: '2026-03-10T09:00:00Z',
  end: '2026-03-10T10:00:00Z',
  hold_id: \`h-\${n}\`,
  idempotency_key: \`k-\${n}\`,
  state: 'held',
  event_id: '',
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_resource_key(ctx) {
  const m = ctx.load('events');
  await m.publishEvent(booking(1, 'r1'), 'created');
  await m.publishEvent(booking(2, 'r2'), 'created');
  await m.publishEvent(booking(3, 'r1'), 'created');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishEvent calls produced \${records.length} records on booking.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['r1', 'r2', 'r1'], \`the records are keyed \${JSON.stringify(keys)}, expected the resource ids r1, r2, r1\`);
  assert.equal(records[0].partition, records[2].partition, "both r1 events must land on one partition, or a consumer sees one room's schedule out of order");
}

export async function check_event_payload(ctx) {
  const m = ctx.load('events');
  await m.publishEvent(booking(1), 'created');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishEvent produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  assert(value.type === 'created' && value.booking_id === 'b-1' && value.resource_id === 'r1', \`the payload is \${values[0]}, expected type, booking_id and resource_id\`);
  assert.equal(value.hold_id, 'h-1', \`the payload carries no hold_id: \${values[0]}. A consumer cannot match the event to the hold it saw\`);
  assert.deepEqual(value.range, {start: '2026-03-10T09:00:00Z', end: '2026-03-10T10:00:00Z'}, \`the payload's range is \${JSON.stringify(value.range)}, expected {start, end}\`);
}

export async function check_publish_after_commit(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter('booking:b-1', () => ctx.kafka.records(TOPIC).length);
  await m.publishEvent(booking(1), 'created');
  await settle();
  assert(probe.fired, 'publishEvent never committed the booking (no write to booking:b-1)');
  assert.equal(probe.result, 0, \`when the booking was committed the topic already held \${probe.result} record(s): an event for a booking nobody can read yet is a phantom. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
  // The store refuses the next commit (booking:b-2 holds a value of another type): no event may go out.
  ctx.redis.set('booking:b-2', 'not a booking');
  const records = ctx.kafka.records(TOPIC).length;
  const rows = outboxRows(ctx).length;
  await m.publishEvent(booking(2), 'created').catch(() => undefined); // the commit's error reaching the caller is fine
  await settle();
  const produced = ctx.kafka.records(TOPIC).length - records;
  const queued = outboxRows(ctx).length - rows;
  assert(produced === 0 && queued === 0, \`a booking whose commit failed still produced an event (\${produced} record(s), \${queued} outbox row(s)): produce only once the commit has succeeded\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishEvent(booking(1), 'created');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishEvent(booking(2), 'created');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  let ok = await m.publishEvent(booking(3), 'created');
  await settle();
  assert(ok === true && outboxRows(ctx).length === 0, \`a delivered event resolved \${JSON.stringify(ok)} and left the outbox \${JSON.stringify(outboxRows(ctx))}, expected true and no row: only a failed or unacknowledged delivery goes to the outbox\`);
  ctx.kafka.failNext(TOPIC, 1);
  ok = await m.publishEvent(booking(1), 'created');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the booking vanishes from every downstream calendar\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'r1' && rows[0].payload?.booking_id === 'b-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key r1 and the payload\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal(ctx.redis.exists('booking:b-1'), 1, 'the booking must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishEvent(booking(2), 'created');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`publishEvent waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.booking_id === 'b-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"

	"booking/store"
)

const eventsTopic = "booking.event"

func eventsBooking(n int, resource string) *store.Booking {
	return &store.Booking{
		BookingID: fmt.Sprintf("b-%d", n), Tenant: "t1", ResourceID: resource, Start: "2026-03-10T09:00:00Z", End: "2026-03-10T10:00:00Z",
		HoldID: fmt.Sprintf("h-%d", n), IdempotencyKey: fmt.Sprintf("k-%d", n), State: "held",
	}
}

func eventsPublish(ctx *harness.Ctx, b *store.Booking) bool {
	ok, err := publishEvent(context.Background(), b, "created")
	ctx.NoError(err, "publishEvent")
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

func CheckResourceKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsBooking(1, "r1"))
	eventsPublish(ctx, eventsBooking(2, "r2"))
	eventsPublish(ctx, eventsBooking(3, "r1"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishEvent calls must produce three records on booking.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"r1", "r2", "r1"}, "the records must be keyed by the resource ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both r1 events must land on one partition, or a consumer sees one room's schedule out of order; the partitions")
}

func CheckEventPayload(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsBooking(1, "r1"))
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one publishEvent must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Assert(value["type"] == "created" && value["booking_id"] == "b-1" && value["resource_id"] == "r1", "the payload is %s, expected type, booking_id and resource_id", values[0])
	ctx.Equal(value["hold_id"], "h-1", "the payload's hold_id (a consumer cannot match the event to the hold it saw without it)")
	ctx.Equal(value["range"], map[string]any{"start": "2026-03-10T09:00:00Z", "end": "2026-03-10T10:00:00Z"}, "the payload's range")
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	probe := ctx.Redis.After("booking:b-1", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsPublish(ctx, eventsBooking(1, "r1"))
	ctx.Settle()
	ctx.Assert(probe.Fired, "publishEvent never committed the booking (no write to booking:b-1)")
	ctx.Equal(probe.Result, 0, "when the booking was committed the topic already held records: an event for a booking nobody can read yet is a phantom. Commit first, then produce; the records at commit time")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the commit; the records")
	// The store refuses the next commit (booking:b-2 holds a value of another type): no event may go out.
	ctx.Redis.Set("booking:b-2", "not a booking")
	records, rows := len(ctx.Kafka.Records(eventsTopic)), len(eventsOutbox(ctx))
	_, _ = publishEvent(context.Background(), eventsBooking(2, "r1"), "created") // the commit's error reaching the caller is fine
	ctx.Settle()
	produced, queued := len(ctx.Kafka.Records(eventsTopic))-records, len(eventsOutbox(ctx))-rows
	ctx.Assert(produced == 0 && queued == 0, "a booking whose commit failed still produced an event (%d record(s), %d outbox row(s)): produce only once the commit has succeeded", produced, queued)
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsBooking(1, "r1"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsBooking(2, "r1"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ok := eventsPublish(ctx, eventsBooking(3, "r1"))
	ctx.Settle()
	ctx.Assert(ok && len(eventsOutbox(ctx)) == 0, "a delivered event returned %v and left the outbox %v, expected true and no row: only a failed or unacknowledged delivery goes to the outbox", ok, eventsOutbox(ctx))
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok = eventsPublish(ctx, eventsBooking(1, "r1"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the booking vanishes from every downstream calendar; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "r1" && rows[0].Payload["booking_id"] == "b-1", "the outbox row is %v, expected the topic, the key r1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishEvent's result after a failed delivery")
	ctx.Equal(ctx.Redis.Exists("booking:b-1"), 1, "the booking must stay committed when only the produce failed")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsBooking(2, "r1"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "publishEvent waited %.1f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["booking_id"] == "b-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishEvent's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "booking.event";

booking::Booking eventsBooking(int n, const std::string& resource = "r1") {
  return booking::Booking{"b-" + std::to_string(n), "t1", resource, "2026-03-10T09:00:00Z", "2026-03-10T10:00:00Z",
                          "h-" + std::to_string(n), "k-" + std::to_string(n), "held", ""};
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

void CheckResourceKey(harness::Ctx& ctx) {
  publishEvent(eventsBooking(1, "r1"), "created");
  publishEvent(eventsBooking(2, "r2"), "created");
  publishEvent(eventsBooking(3, "r1"), "created");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishEvent calls must produce three records on booking.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"r1", "r2", "r1"}, "the records must be keyed by the resource ids");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both r1 events must land on one partition, or a consumer sees one room's schedule out of order; the partitions");
}

void CheckEventPayload(harness::Ctx& ctx) {
  publishEvent(eventsBooking(1), "created");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one publishEvent must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(eventsField(value, "type") == "created" && eventsField(value, "booking_id") == "b-1" && eventsField(value, "resource_id") == "r1",
             "the payload is %s, expected type, booking_id and resource_id", values[0]);
  ctx.Equal(eventsField(value, "hold_id"), "h-1", "the payload's hold_id (a consumer cannot match the event to the hold it saw without it)");
  ctx.Equal(value.is_object() && value.contains("range") ? value["range"] : nlohmann::json(),
            nlohmann::json{{"start", "2026-03-10T09:00:00Z"}, {"end", "2026-03-10T10:00:00Z"}}, "the payload's range");
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  size_t atCommit = 999;
  bool fired = false;
  ctx.Redis.After("booking:b-1", [&] {
    fired = true;
    atCommit = ctx.Kafka.Records(kEventsTopic).size();
  });
  publishEvent(eventsBooking(1), "created");
  ctx.Settle();
  ctx.Assert(fired, "publishEvent never committed the booking (no write to booking:b-1)");
  ctx.Equal(atCommit, 0,
            "when the booking was committed the topic already held records: an event for a booking nobody can read yet is a "
            "phantom. Commit first, then produce; the records at commit time");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the commit; the records");
  // The store refuses the next commit (booking:b-2 holds a value of another type): no event may go out.
  ctx.Redis.Do("SET", "booking:b-2", "not a booking");
  const size_t records = ctx.Kafka.Records(kEventsTopic).size();
  const size_t rows = eventsOutbox(ctx).size();
  try {
    publishEvent(eventsBooking(2), "created");
  } catch (const std::exception&) {
    // the commit's error reaching the caller is fine
  }
  ctx.Settle();
  const size_t produced = ctx.Kafka.Records(kEventsTopic).size() - records;
  const size_t queued = eventsOutbox(ctx).size() - rows;
  ctx.Assert(produced == 0 && queued == 0,
             "a booking whose commit failed still produced an event (%d record(s), %d outbox row(s)): produce only once the "
             "commit has succeeded",
             produced, queued);
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishEvent(eventsBooking(1), "created");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishEvent(eventsBooking(2), "created");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2,
            "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  bool ok = publishEvent(eventsBooking(3), "created");
  ctx.Settle();
  ctx.Assert(ok && eventsOutbox(ctx).empty(),
             "a delivered event returned %v and left %d outbox rows, expected true and no row: only a failed or "
             "unacknowledged delivery goes to the outbox",
             ok, eventsOutbox(ctx).size());
  ctx.Kafka.FailNext(kEventsTopic, 1);
  ok = publishEvent(eventsBooking(1), "created");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the booking vanishes from every downstream calendar; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "r1" &&
                 rows[0].contains("payload") && eventsField(rows[0]["payload"], "booking_id") == "b-1",
             "the outbox row is %s, expected the topic, the key r1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishEvent's result after a failed delivery");
  ctx.Equal(ctx.Redis.Exists("booking:b-1"), 1, "the booking must stay committed when only the produce failed");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishEvent(eventsBooking(2), "created");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "publishEvent waited %.1f s for a broker that does not answer: wait for the ack at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "booking_id") == "b-2",
             "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishEvent's result without an acknowledgement");
}
`,
  },
  hints: [
    'The schedule consumer shows a room booked at 10:00 and then free at 10:00 a moment later, and after a broker restart one booking never reached any calendar.',
    'Partition order holds per key, so whatever is the key is what stays ordered; a produce that is not awaited can fail after the caller returned, and a commit after the produce can fail after the event is out.',
    'Key by `resource_id`, add `hold_id` and `range`, `store.put` first, then produce with an idempotent producer and `acks=all`; wait for the delivery report at most 2 s and insert the outbox row otherwise.',
  ],
  debrief: `The key is an ordering contract and the commit-then-produce order is a visibility contract: a consumer must be able to look up any booking whose event it holds, and must see one room's events in the order they happened. Waiting for the acknowledgement is what gives the return value a meaning, and the outbox is what makes a broker outage a delay rather than a loss. The idempotent producer closes the one gap waiting opens, a retry after a lost acknowledgement. Production systems write the outbox row in the same transaction as the booking and let a relay do every produce, so the request path never talks to the broker at all; they also register the payload's schema so no producer can quietly add a field a consumer did not expect.`,
};
