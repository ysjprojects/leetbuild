import type {Step} from '@/lib/types';

export const bookingEventsStep: Step = {
  id: 'events',
  title: 'Booking events keyed by resource for schedule order',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'db', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds a producer, assembles
a payload and publishes. Downstream calendars consume the same topic, so every mistake here becomes
somebody else's wrong schedule. Review it like the service owner, fix it, and prove the fix with the
checks below.

Publish \`booking.event\` for the create, reschedule and cancel transitions of a booking.

- The topic is \`booking.event\` and the **key is the resource id**. Kafka orders per partition, so the
  key is the ordering contract: everything about one room, one desk or one table must land in one
  partition, in the order it happened. Keying by customer interleaves every resource that customer
  touches and reorders one resource's stream.
- The payload carries the booking id, the **hold id**, the resource id and the **range**
  (\`{"start": …, "end": …}\`) plus the event type. Downstream calendars replay the event by
  idempotency key, so they need the hold and the range, not the customer's address.
- **Publish after the commit.** The booking row must be durable before its event exists; an event for
  a booking nobody can read is a phantom, and a booking with no event silently disappears from the
  calendar. Commit first, then produce.
- Use an **idempotent producer with \`acks=all\`**: a produce retried after a timeout must not
  duplicate the event, and the broker must have replicated it before you call the write done.
- **Wait for the broker's ack** before the request returns. Fire-and-forget publishing is how a crash
  loses an event the caller was already told about.
- On a produce failure, insert an **outbox** row with the topic, the key and the payload, and let a
  relay publish it later. No booking may vanish from a downstream calendar because the broker was
  briefly unreachable.

**Failure mode the checks target.** The draft keys by customer (one resource's schedule arrives
interleaved), publishes before the booking is committed (a phantom event when the commit then fails),
drops the hold id, and neither waits for the ack nor writes an outbox row.`,
  sequence: {
    participants: ['Booking API', 'Booking store', 'Kafka booking.event', 'Outbox'],
    messages: [
      {from: 'Booking API', to: 'Booking store', label: 'commit booking + hold', kind: 'sync'},
      {from: 'Booking store', to: 'Booking API', label: 'committed', kind: 'reply'},
      {from: 'Booking API', to: 'Kafka booking.event', label: 'produce key = resource_id', kind: 'async'},
      {from: 'Kafka booking.event', to: 'Booking API', label: 'ack · acks=all', kind: 'reply'},
      {from: 'Kafka booking.event', to: 'Booking API', label: 'produce failed', kind: 'reply'},
      {from: 'Booking API', to: 'Outbox', label: 'insert(topic, key, payload)', kind: 'async'},
      {from: 'Outbox', to: 'Kafka booking.event', label: 'relay republishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'resource-key',
      title: 'Keys booking.event by the resource id',
      detail:
        'The record key is the resource id, so one resource’s schedule stays in one partition in order. The draft keys by customer, which interleaves every resource that customer ever books.',
      match: {
        python: {all: [/TOPIC\s*=\s*"booking\.event"/, /key=booking\["resource_id"\]/]},
        typescript: {all: [/TOPIC\s*=\s*'booking\.event'/, /key:\s*booking\.resourceId/]},
        go: {all: [/Topic\s*=\s*"booking\.event"/, /Key:\s*\[\]byte\(booking\.ResourceID\)/]},
        scala: {all: [/Topic\s*=\s*"booking\.event"/, /ProducerRecord\[String, String\]\(Topic, booking\.resourceId/]},
        cpp: {all: [/kTopic\s*=\s*"booking\.event"/, /key = booking\.resource_id/]},
      },
    },
    {
      id: 'event-payload',
      title: 'Carries the range and the hold id',
      detail:
        'The payload names the `hold_id` and a `range` object, so a downstream calendar can replay the event idempotently. The draft sends a flat start/end pair, no hold id, and the customer id.',
      match: {
        python: {all: [/hold_id/, /"range"/]},
        typescript: {all: [/hold_id/, /range:\s*\{/]},
        go: {all: [/HoldID/, /"range"/]},
        scala: {all: [/holdId/, /"range"/]},
        cpp: {all: [/hold_id/, /range/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Commits the booking before publishing its event',
      detail:
        'The booking is committed first and the event is produced after, so there is never an event for a booking nobody can read. The draft produces first and commits later — or never.',
      match: {
        python: {order: [/commit_booking\(/, /producer\.send\(/]},
        typescript: {order: [/commitBooking\(/, /producer\.send\(/]},
        go: {order: [/CommitBooking\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/commitBooking\(/, /producer\.send\(/]},
        cpp: {order: [/commitBooking\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'The producer waits for every in-sync replica and enables idempotence, so a produce retried after a timeout cannot duplicate an event. The draft sets neither.',
      match: {
        python: {all: [/acks="all"/, /enable_idempotence=True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/props\.put\("acks", "all"\)/, /props\.put\("enable\.idempotence", "true"\)/]},
        cpp: {all: [/conf->set\("acks", "all"/, /conf->set\("enable\.idempotence", "true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the broker ack and falls back to the outbox',
      detail:
        'The produce is awaited, and a failure inserts an outbox row with the topic, the key and the payload so a relay can publish it later. The draft fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /except/, /\.get\(timeout=/]},
        typescript: {all: [/outbox\.insert\(/, /catch/, /await producer\.send\(/]},
        go: {all: [/outbox\.Insert\(/, /if err != nil/, /writer\.WriteMessages\(/]},
        scala: {all: [/outbox\.insert\(/, /Failure/, /\.get\(\)/]},
        cpp: {all: [/outbox\.insert\(/, /ERR_NO_ERROR/, /flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from kafka import KafkaProducer

TOPIC = "booking.event"


def build_producer(bootstrap):
    # TODO: no acks=all and no idempotence, so a produce retried after a timeout can duplicate an
    # event.
    return KafkaProducer(bootstrap_servers=bootstrap)


def publish_event(producer, booking, event_type: str) -> None:
    # TODO: this draft keys by customer, drops the hold id, publishes before the booking is
    # committed, and never checks whether the broker accepted the produce. Key by the resource,
    # carry the range and the hold id, commit first, and write an outbox row on failure.
    payload = {
        "type": event_type,
        "booking_id": booking["booking_id"],
        "customer_id": booking["customer_id"],
        "start": booking["start"],
        "end": booking["end"],
    }
    producer.send(TOPIC, key=booking["customer_id"], value=json.dumps(payload))
`,
      solution: `import json

from kafka import KafkaProducer

TOPIC = "booking.event"
ACK_TIMEOUT_S = 2


def build_producer(bootstrap):
    return KafkaProducer(
        bootstrap_servers=bootstrap,
        acks="all",
        enable_idempotence=True,
    )


def event_payload(booking, event_type: str) -> dict:
    """Everything a downstream calendar needs to replay the event, and nothing about the customer."""
    return {
        "type": event_type,
        "booking_id": booking["booking_id"],
        "hold_id": booking["hold_id"],
        "resource_id": booking["resource_id"],
        "range": {"start": booking["start"], "end": booking["end"]},
    }


def publish_event(producer, outbox, store, booking, event_type: str) -> None:
    # The booking is committed first: an event for a booking nobody can read is a phantom, and a
    # booking without an event vanishes from the downstream calendar.
    commit_booking(store, booking["booking_id"])
    payload = event_payload(booking, event_type)
    try:
        # Wait for the broker's ack: the request is not done until the event is durable.
        producer.send(TOPIC, key=booking["resource_id"], value=json.dumps(payload)).get(timeout=ACK_TIMEOUT_S)
    except Exception:
        outbox.insert(TOPIC, booking["resource_id"], payload)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'booking.event';

export function buildProducer(bootstrap: string) {
  // TODO: no acks=all and no idempotence, so a produce retried after a timeout can duplicate an
  // event.
  return new Kafka({brokers: [bootstrap]}).producer();
}

export async function publishEvent(
  producer: {send: (record: unknown) => Promise<unknown>},
  booking: Booking,
  eventType: string,
): Promise<void> {
  // TODO: this draft keys by customer, drops the hold id, publishes before the booking is
  // committed, and never checks whether the broker accepted the produce. Key by the resource,
  // carry the range and the hold id, commit first, and write an outbox row on failure.
  const payload = {
    type: eventType,
    booking_id: booking.bookingId,
    customer_id: booking.customerId,
    start: booking.start,
    end: booking.end,
  };
  await producer.send({topic: TOPIC, messages: [{key: booking.customerId, value: JSON.stringify(payload)}]});
}
`,
      solution: `import {Kafka, type Producer} from 'kafkajs';

export const TOPIC = 'booking.event';
const ACK_TIMEOUT_MS = 2000;

export function buildProducer(bootstrap: string): Producer {
  return new Kafka({brokers: [bootstrap]}).producer({idempotent: true, acks: -1});
}

/** Everything a downstream calendar needs to replay the event, and nothing about the customer. */
export function eventPayload(booking: Booking, eventType: string) {
  return {
    type: eventType,
    booking_id: booking.bookingId,
    hold_id: booking.holdId,
    resource_id: booking.resourceId,
    range: {start: booking.start, end: booking.end},
  };
}

export async function publishEvent(
  producer: Producer,
  outbox: {insert: (topic: string, key: string, payload: unknown) => Promise<unknown>},
  store: BookingStore,
  booking: Booking,
  eventType: string,
): Promise<void> {
  // The booking is committed first: an event for a booking nobody can read is a phantom, and a
  // booking without an event vanishes from the downstream calendar.
  await commitBooking(store, booking.bookingId);
  const payload = eventPayload(booking, eventType);
  try {
    // Wait for the broker's ack: the request is not done until the event is durable.
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: booking.resourceId, value: JSON.stringify(payload)}],
    });
  } catch {
    await outbox.insert(TOPIC, booking.resourceId, payload);
  }
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

const Topic = "booking.event"

func buildWriter(brokers []string) *kafka.Writer {
	// TODO: no RequiredAcks and no hash balancer, so a produce retried after a timeout can
	// duplicate an event and the key does not decide the partition.
	return &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: Topic}
}

func publishEvent(ctx context.Context, writer *kafka.Writer, booking Booking, eventType string) error {
	// TODO: this draft keys by customer, drops the hold id, publishes before the booking is
	// committed, and never checks whether the broker accepted the produce. Key by the resource,
	// carry the range and the hold id, commit first, and write an outbox row on failure.
	payload, err := json.Marshal(map[string]any{
		"type":        eventType,
		"booking_id":  booking.ID,
		"customer_id": booking.CustomerID,
		"start":       booking.Start,
		"end":         booking.End,
	})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(booking.CustomerID), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "booking.event"

type Outbox interface {
	Insert(ctx context.Context, topic, key string, payload []byte) error
}

func buildWriter(brokers []string) *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        Topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
}

// eventPayload carries everything a downstream calendar needs to replay the event, and nothing
// about the customer.
func eventPayload(booking Booking, eventType string) map[string]any {
	return map[string]any{
		"type":        eventType,
		"booking_id":  booking.ID,
		"hold_id":     booking.HoldID,
		"resource_id": booking.ResourceID,
		"range":       map[string]string{"start": booking.Start, "end": booking.End},
	}
}

func publishEvent(ctx context.Context, writer *kafka.Writer, outbox Outbox, store BookingStore, booking Booking, eventType string) error {
	// The booking is committed first: an event for a booking nobody can read is a phantom, and a
	// booking without an event vanishes from the downstream calendar.
	if err := CommitBooking(ctx, store, booking.ID); err != nil {
		return err
	}
	payload, err := json.Marshal(eventPayload(booking, eventType))
	if err != nil {
		return err
	}
	// Wait for the broker's ack: the request is not done until the event is durable.
	err = writer.WriteMessages(ctx, kafka.Message{Key: []byte(booking.ResourceID), Value: payload})
	if err != nil {
		return outbox.Insert(ctx, Topic, booking.ResourceID, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object BookingEvents {
  val Topic = "booking.event"

  def buildProducer(bootstrap: String): KafkaProducer[String, String] = {
    // TODO: no acks and no idempotence, so a produce retried after a timeout can duplicate an
    // event.
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    new KafkaProducer[String, String](props)
  }

  def publishEvent(producer: KafkaProducer[String, String], booking: Booking, eventType: String): Unit = {
    // TODO: this draft keys by customer, drops the hold id, publishes before the booking is
    // committed, and never checks whether the broker accepted the produce. Key by the resource,
    // carry the range and the hold id, commit first, and write an outbox row on failure.
    val payload = Map(
      "type" -> eventType,
      "booking_id" -> booking.id,
      "customer_id" -> booking.customerId,
      "start" -> booking.start,
      "end" -> booking.end
    ).toString
    producer.send(new ProducerRecord[String, String](Topic, booking.customerId, payload))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

import scala.util.{Failure, Success, Try}

object BookingEvents {
  val Topic = "booking.event"

  def buildProducer(bootstrap: String): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    props.put("max.in.flight.requests.per.connection", "1")
    new KafkaProducer[String, String](props)
  }

  /** Everything a downstream calendar needs to replay the event, and nothing about the customer. */
  def eventPayload(booking: Booking, eventType: String): String = {
    val fields = Map(
      "type" -> ("\\"" + eventType + "\\""),
      "booking_id" -> ("\\"" + booking.id + "\\""),
      "hold_id" -> ("\\"" + booking.holdId + "\\""),
      "resource_id" -> ("\\"" + booking.resourceId + "\\""),
      "range" -> ("{\\"start\\":\\"" + booking.start + "\\",\\"end\\":\\"" + booking.end + "\\"}")
    )
    fields.map { case (key, value) => "\\"" + key + "\\":" + value }.mkString("{", ",", "}")
  }

  def publishEvent(
      producer: KafkaProducer[String, String],
      outbox: Outbox,
      store: BookingStore,
      booking: Booking,
      eventType: String,
  ): Unit = {
    // The booking is committed first: an event for a booking nobody can read is a phantom, and a
    // booking without an event vanishes from the downstream calendar.
    commitBooking(store, booking.id)
    val payload = eventPayload(booking, eventType)
    // Wait for the broker's ack: the request is not done until the event is durable.
    Try(producer.send(new ProducerRecord[String, String](Topic, booking.resourceId, payload)).get()) match {
      case Success(_) => ()
      case Failure(_) => outbox.insert(Topic, booking.resourceId, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

constexpr const char* kTopic = "booking.event";

RdKafka::Producer* buildProducer(const std::string& brokers) {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", brokers, errstr);
  // TODO: no acks and no idempotence, so a produce retried after a timeout can duplicate an event.
  return RdKafka::Producer::create(conf, errstr);
}

void publishEvent(RdKafka::Producer* producer, const Booking& booking, const std::string& eventType) {
  // TODO: this draft keys by customer, drops the hold id, publishes before the booking is
  // committed, and never checks whether the broker accepted the produce. Key by the resource,
  // carry the range and the hold id, commit first, and write an outbox row on failure.
  const std::string payload = "{\\"type\\":\\"" + eventType + "\\",\\"booking_id\\":\\"" + booking.booking_id +
                              "\\",\\"customer_id\\":\\"" + booking.customer_id + "\\",\\"start\\":\\"" + booking.start +
                              "\\",\\"end\\":\\"" + booking.end + "\\"}";
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), booking.customer_id.data(),
                    booking.customer_id.size(), 0, nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <string>

constexpr const char* kTopic = "booking.event";

RdKafka::Producer* buildProducer(const std::string& brokers) {
  std::string errstr;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", brokers, errstr);
  conf->set("acks", "all", errstr);
  conf->set("enable.idempotence", "true", errstr);
  return RdKafka::Producer::create(conf, errstr);
}

std::string eventPayload(const Booking& booking, const std::string& eventType) {
  return std::string("{\\"type\\":\\"") + eventType + "\\",\\"booking_id\\":\\"" + booking.booking_id +
         "\\",\\"hold_id\\":\\"" + booking.hold_id + "\\",\\"resource_id\\":\\"" + booking.resource_id +
         "\\",\\"range\\":{\\"start\\":\\"" + booking.start + "\\",\\"end\\":\\"" + booking.end + "\\"}}";
}

void publishEvent(RdKafka::Producer* producer, Outbox& outbox, BookingStore& store, const Booking& booking,
                  const std::string& eventType) {
  // The booking is committed first: an event for a booking nobody can read is a phantom, and a
  // booking without an event vanishes from the downstream calendar.
  commitBooking(store, booking.booking_id);
  const std::string key = booking.resource_id;
  const auto payload = eventPayload(booking, eventType);
  const auto err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(),
                                     const_cast<char*>(key.data()), key.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insert(kTopic, key, payload);
  }
  // Wait for the broker's ack: the request is not done until the event is durable.
  producer->flush(2000);
}
`,
    },
  },
  hints: [
    'The key is the ordering contract. Everything downstream of the topic sees one resource’s events in partition order only if the resource id — not the customer, not the booking — is the key.',
    'Publish after the commit, not before: an event for a booking that later fails to commit is a phantom in everybody’s calendar, and the outbox pattern only works when the row exists first.',
    '`acks=all` plus idempotence makes a retried produce safe to repeat; awaiting the ack makes the caller’s success mean "durable"; the outbox row is what turns a broker outage into a delay instead of a lost booking.',
  ],
  debrief: `The interviewer is testing the last mile: how a booking becomes visible to systems you do not own.
Three defects are checked: the wrong partition key, which turns one resource’s schedule into an
interleaved stream; publishing before the commit, which produces events that contradict the database;
and a fire-and-forget produce with no outbox, which loses events silently. The idempotent producer is
the fourth — a retry after an ambiguous timeout must not duplicate an event that downstream calendars
would apply twice. Real systems add a schema registry so no future producer can smuggle customer data
into the topic, a relay with backoff for the outbox, and a per-partition consumer lag alert, because a
lagging schedule consumer looks exactly like a wrong schedule.`,
};
