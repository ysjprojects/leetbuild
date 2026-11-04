import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Delivery events keyed by recipient, after the relay answers',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'relay', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter reports deliveries on \`email.event\`: \`publish_event(event_type,
message)\` produces one record keyed by the message's tenant, with \`message_id\`, \`tenant\`,
\`template_id\`, \`recipient\` and \`bounce_category\` in the value, and \`dispatch(message_id)\`
publishes \`email.accepted\`, then calls \`deliver\` (step 3, provided as \`mail.relay\`). Dispatch a
message and an event shows up; it hides four flaws.

**Failure mode the checks target.** One recipient's events land on different partitions, so a
consumer can apply \`email.bounced\` before the \`email.accepted\` it follows; a message the relay
bounces is reported as accepted; every consumer receives the plain address; and a broker that
loses an acknowledgement gets the event twice.

- The record key is \`recipient_hash(recipient)\` (\`mail.address\`: SHA-256 of the normalized address).
- \`dispatch\` calls \`deliver\` first and publishes the type for the state it returns, through
  \`EVENT_TYPES\`: \`sent\` → \`email.accepted\`, \`bounced\` → \`email.bounced\`, \`suppressed\` →
  \`email.suppressed\`, \`deferred\` → \`email.deferred\`.
- The value carries \`recipient_hash\` in place of the address.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent\`, librdkafka
  \`enable.idempotence\`). kafka-go has no idempotent producer: its writer uses \`RequireAll\` and
  consumers drop a repeated \`(message_id, type)\`.`,
  sequence: {
    participants: ['Dispatcher', 'Relay', 'email.event', 'Event consumer'],
    messages: [
      {from: 'Dispatcher', to: 'Relay', label: 'deliver(message_id)', kind: 'sync'},
      {from: 'Relay', to: 'Dispatcher', label: 'sent · bounced · suppressed · deferred', kind: 'reply'},
      {
        from: 'Dispatcher',
        to: 'email.event',
        label: 'produce EVENT_TYPES[state] · key = recipient_hash · acks = all',
        kind: 'sync',
      },
      {from: 'email.event', to: 'Dispatcher', label: 'ack (once, idempotent on retry)', kind: 'reply'},
      {from: 'email.event', to: 'Event consumer', label: 'one partition per recipient, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'recipient-key',
      title: 'Keyed by the recipient hash',
      detail:
        "The record key is `recipient_hash(recipient)`, so one recipient's lifecycle lands on one partition, in order; the starter keys by tenant.",
      match: {
        python: {all: [/recipient_hash\(/, /key=key\b|key=recipient_hash\(/], none: [/key=message\[["']tenant["']\]/]},
        typescript: {
          all: [/recipientHash\(/, /\{key,|key:\s*key\b|key:\s*recipientHash\(/],
          none: [/key:\s*message\.tenant/],
        },
        go: {all: [/address\.RecipientHash\(/, /Key:\s*\[\]byte\(key\)/], none: [/Key:\s*\[\]byte\(message\.Tenant\)/]},
        scala: {
          all: [/Address\.recipientHash\(/, /ProducerRecord\[String, String\]\(EventTopic,\s*key\b/],
          none: [/EventTopic,\s*message\.tenant/],
        },
        cpp: {all: [/address::recipientHash\(/, /key\.c_str\(\),\s*key\.size\(\)/], none: [/tenant\.c_str\(\)/]},
      },
    },
    {
      id: 'outcome-after-relay',
      title: "Publishes the relay's outcome, after the relay answered",
      detail:
        '`dispatch` calls `deliver` first and maps the state it returns through `EVENT_TYPES`; the starter publishes `email.accepted` before the relay was asked, whatever it answers.',
      match: {
        python: {all: [/EVENT_TYPES\[/], order: [/def dispatch\(/, /deliver\(/, /publish_event\(/]},
        typescript: {all: [/EVENT_TYPES\[/], order: [/function dispatch\(/, /\bdeliver\(/, /publishEvent\(/]},
        go: {all: [/eventTypes\[/], order: [/func dispatch\(/, /relay\.Deliver\(/, /publishEvent\(/]},
        scala: {all: [/EventTypes\(/], order: [/def dispatch\(/, /Relay\.deliver\(/, /publishEvent\(/]},
        cpp: {all: [/kEventTypes/], order: [/json dispatch\(/, /relay::deliver\(/, /publish_event\(/]},
      },
    },
    {
      id: 'hashed-payload',
      title: 'Carries the recipient hash, never the address',
      detail:
        "The value names the recipient only as `recipient_hash`: the topic is retained and every consumer reads it, so an address there outlives the customer's right to be forgotten.",
      match: {
        python: {all: [/["']recipient_hash["']\s*:/], none: [/["']recipient["']\s*:/]},
        typescript: {all: [/recipient_hash:/], none: [/\brecipient:\s*message\.recipient/]},
        go: {all: [/"recipient_hash":/], none: [/"recipient":/]},
        scala: {all: [/"recipient_hash"\s*->/], none: [/"recipient"\s*->/]},
        cpp: {all: [/\{"recipient_hash",/], none: [/\{"recipient",/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer sets idempotence and `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the event once and a leader failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from mail import store
from mail.address import recipient_hash  # SHA-256 of the normalized address, in hex
from mail.relay import deliver  # step 3: the state the message ends in (sent, bounced, suppressed, deferred)

EVENT_TOPIC = "email.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("email event not delivered: %s", err)


def publish_event(event_type: str, message: dict) -> dict:
    """One record on email.event about a message."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {
        "type": event_type,
        "message_id": message["message_id"],
        "tenant": message["tenant"],
        "template_id": message["template_id"],
        "recipient": message["recipient"],
        "bounce_category": message["bounce_category"],
    }
    producer.produce(EVENT_TOPIC, key=message["tenant"], value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def dispatch(message_id: str) -> dict:
    """Hand a queued message to the relay and report what became of it."""
    event = publish_event("email.accepted", store.load(message_id))
    deliver(message_id)
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from mail import store
from mail.address import recipient_hash  # SHA-256 of the normalized address, in hex
from mail.relay import deliver  # step 3: the state the message ends in (sent, bounced, suppressed, deferred)

EVENT_TOPIC = "email.event"
EVENT_TYPES = {"sent": "email.accepted", "bounced": "email.bounced", "suppressed": "email.suppressed", "deferred": "email.deferred"}
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("email event not delivered: %s", err)


def publish_event(event_type: str, message: dict) -> dict:
    """One record on email.event about a message."""
    key = recipient_hash(message["recipient"])  # one recipient, one partition: their lifecycle stays in order
    payload = {
        "type": event_type,
        "message_id": message["message_id"],
        "tenant": message["tenant"],
        "template_id": message["template_id"],
        "recipient_hash": key,
        "bounce_category": message["bounce_category"],
    }
    producer.produce(EVENT_TOPIC, key=key, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(2.0)
    return payload


def dispatch(message_id: str) -> dict:
    """Hand a queued message to the relay and report what became of it."""
    state = deliver(message_id)  # the event reports what the relay answered, so it comes after
    return publish_event(EVENT_TYPES[state], store.load(message_id))
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {recipientHash} from 'mail/address'; // SHA-256 of the normalized address, in hex
import {deliver} from 'mail/relay'; // step 3: the state the message ends in (sent, bounced, suppressed, deferred)
import {type Message, load} from 'mail/store';

export const EVENT_TOPIC = 'email.event';

const kafka = new Kafka({clientId: 'mailerd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record on email.event about a message. */
export async function publishEvent(eventType: string, message: Message): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {
    type: eventType,
    message_id: message.message_id,
    tenant: message.tenant,
    template_id: message.template_id,
    recipient: message.recipient,
    bounce_category: message.bounce_category,
  };
  await producer.send({topic: EVENT_TOPIC, messages: [{key: message.tenant, value: JSON.stringify(payload)}], acks: 1});
  return payload;
}

/** Hand a queued message to the relay and report what became of it. */
export async function dispatch(messageId: string): Promise<Record<string, unknown>> {
  const event = await publishEvent('email.accepted', (await load(messageId)) as Message);
  await deliver(messageId);
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {recipientHash} from 'mail/address'; // SHA-256 of the normalized address, in hex
import {deliver} from 'mail/relay'; // step 3: the state the message ends in (sent, bounced, suppressed, deferred)
import {type Message, load} from 'mail/store';

export const EVENT_TOPIC = 'email.event';
export const EVENT_TYPES: Record<string, string> = {
  sent: 'email.accepted',
  bounced: 'email.bounced',
  suppressed: 'email.suppressed',
  deferred: 'email.deferred',
};

const kafka = new Kafka({clientId: 'mailerd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One record on email.event about a message. */
export async function publishEvent(eventType: string, message: Message): Promise<Record<string, unknown>> {
  const key = recipientHash(message.recipient); // one recipient, one partition: their lifecycle stays in order
  const payload = {
    type: eventType,
    message_id: message.message_id,
    tenant: message.tenant,
    template_id: message.template_id,
    recipient_hash: key,
    bounce_category: message.bounce_category,
  };
  await producer.send({topic: EVENT_TOPIC, messages: [{key, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}

/** Hand a queued message to the relay and report what became of it. */
export async function dispatch(messageId: string): Promise<Record<string, unknown>> {
  const state = await deliver(messageId); // the event reports what the relay answered, so it comes after
  return publishEvent(EVENT_TYPES[state], (await load(messageId)) as Message);
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

	"mail/relay" // relay.Deliver (step 3): the state the message ends in (sent, bounced, suppressed, deferred)
	"mail/store" // store.Load; "mail/address" has address.RecipientHash, SHA-256 of the normalized address
)

const eventTopic = "email.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// publishEvent produces one record on email.event about a message.
func publishEvent(ctx context.Context, eventType string, message *store.Message) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{
		"type":            eventType,
		"message_id":      message.MessageID,
		"tenant":          message.Tenant,
		"template_id":     message.TemplateID,
		"recipient":       message.Recipient,
		"bounce_category": message.BounceCategory,
	}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(message.Tenant), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// dispatch hands a queued message to the relay and reports what became of it.
func dispatch(ctx context.Context, messageID string) (map[string]any, error) {
	event, err := publishEvent(ctx, "email.accepted", store.Load(ctx, messageID))
	if err != nil {
		return nil, err
	}
	if _, err := relay.Deliver(ctx, messageID); err != nil {
		return nil, err
	}
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"mail/address" // address.RecipientHash: SHA-256 of the normalized address, in hex
	"mail/relay"   // relay.Deliver (step 3): the state the message ends in (sent, bounced, suppressed, deferred)
	"mail/store"   // store.Load
)

const eventTopic = "email.event"

var eventTypes = map[string]string{"sent": "email.accepted", "bounced": "email.bounced", "suppressed": "email.suppressed", "deferred": "email.deferred"}

// RequireAll: the event is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; consumers drop a repeated
// (message_id, type).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// publishEvent produces one record on email.event about a message.
func publishEvent(ctx context.Context, eventType string, message *store.Message) (map[string]any, error) {
	key := address.RecipientHash(message.Recipient) // one recipient, one partition: their lifecycle stays in order
	payload := map[string]any{
		"type":            eventType,
		"message_id":      message.MessageID,
		"tenant":          message.Tenant,
		"template_id":     message.TemplateID,
		"recipient_hash":  key,
		"bounce_category": message.BounceCategory,
	}
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// dispatch hands a queued message to the relay and reports what became of it.
func dispatch(ctx context.Context, messageID string) (map[string]any, error) {
	state, err := relay.Deliver(ctx, messageID) // the event reports what the relay answered, so it comes after
	if err != nil {
		return nil, err
	}
	return publishEvent(ctx, eventTypes[state], store.Load(ctx, messageID))
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import mail.{Address, Relay, Store} // Address.recipientHash; Relay.deliver (step 3): the state the message ends in; Store.load

object Events {
  val EventTopic = "email.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"email event not delivered: \${exception.getMessage}")
  }

  /** One record on email.event about a message. */
  def publishEvent(eventType: String, message: Store.Message): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "type" -> JsString(eventType),
      "message_id" -> JsString(message.messageId),
      "tenant" -> JsString(message.tenant),
      "template_id" -> JsString(message.templateId),
      "recipient" -> JsString(message.recipient),
      "bounce_category" -> JsString(message.bounceCategory))
    producer.send(new ProducerRecord[String, String](EventTopic, message.tenant, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Hand a queued message to the relay and report what became of it. */
  def dispatch(messageId: String): JsObject = {
    val event = publishEvent("email.accepted", Store.load(messageId).get)
    Relay.deliver(messageId)
    event
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import mail.{Address, Relay, Store} // Address.recipientHash; Relay.deliver (step 3): the state the message ends in; Store.load

object Events {
  val EventTopic = "email.event"
  val EventTypes: Map[String, String] =
    Map("sent" -> "email.accepted", "bounced" -> "email.bounced", "suppressed" -> "email.suppressed", "deferred" -> "email.deferred")

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"email event not delivered: \${exception.getMessage}")
  }

  /** One record on email.event about a message. */
  def publishEvent(eventType: String, message: Store.Message): JsObject = {
    val key = Address.recipientHash(message.recipient) // one recipient, one partition: their lifecycle stays in order
    val payload = JsObject(
      "type" -> JsString(eventType),
      "message_id" -> JsString(message.messageId),
      "tenant" -> JsString(message.tenant),
      "template_id" -> JsString(message.templateId),
      "recipient_hash" -> JsString(key),
      "bounce_category" -> JsString(message.bounceCategory))
    producer.send(new ProducerRecord[String, String](EventTopic, key, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Hand a queued message to the relay and report what became of it. */
  def dispatch(messageId: String): JsObject = {
    val state = Relay.deliver(messageId) // the event reports what the relay answered, so it comes after
    publishEvent(EventTypes(state), Store.load(messageId).get)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "mail/address.h"  // mail::address::recipientHash: SHA-256 of the normalized address, in hex
#include "mail/relay.h"    // mail::relay::deliver (step 3): the state the message ends in
#include "mail/store.h"    // mail::store::load

using json = nlohmann::json;
namespace relay = mail::relay;
namespace store = mail::store;

const std::string kEventTopic = "email.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "email event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record on email.event about a message.
json publish_event(const std::string& event_type, const store::Message& message) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = {{"type", event_type},
                        {"message_id", message.message_id},
                        {"tenant", message.tenant},
                        {"template_id", message.template_id},
                        {"recipient", message.recipient},
                        {"bounce_category", message.bounce_category}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), message.tenant.c_str(), message.tenant.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Hand a queued message to the relay and report what became of it.
json dispatch(const std::string& message_id) {
  const json event = publish_event("email.accepted", *store::load(message_id));
  relay::deliver(message_id);
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <memory>
#include <string>

#include "mail/address.h"  // mail::address::recipientHash: SHA-256 of the normalized address, in hex
#include "mail/relay.h"    // mail::relay::deliver (step 3): the state the message ends in
#include "mail/store.h"    // mail::store::load

using json = nlohmann::json;
namespace address = mail::address;
namespace relay = mail::relay;
namespace store = mail::store;

const std::string kEventTopic = "email.event";
const std::map<std::string, std::string> kEventTypes = {
    {"sent", "email.accepted"}, {"bounced", "email.bounced"}, {"suppressed", "email.suppressed"}, {"deferred", "email.deferred"}};

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "email event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record on email.event about a message.
json publish_event(const std::string& event_type, const store::Message& message) {
  const std::string key = address::recipientHash(message.recipient);  // one recipient, one partition: their lifecycle stays in order
  const json payload = {{"type", event_type},
                        {"message_id", message.message_id},
                        {"tenant", message.tenant},
                        {"template_id", message.template_id},
                        {"recipient_hash", key},
                        {"bounce_category", message.bounce_category}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), key.c_str(), key.size(), 0, nullptr);
  producer->flush(2000);
  return payload;
}

// Hand a queued message to the relay and report what became of it.
json dispatch(const std::string& message_id) {
  const std::string state = relay::deliver(message_id);  // the event reports what the relay answered, so it comes after
  return publish_event(kEventTypes.at(state), *store::load(message_id));
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

import email_delivery_pb2 as pb
import email_delivery_pb2_grpc as pb_grpc
from mail import store

TOPIC = "email.event"


def _hash(address):
    return hashlib.sha256(address.strip().lower().encode()).hexdigest()


class Relay(pb_grpc.RelayServicer):
    """Accepts every recipient but bounce@ (a hard bounce); notes how many events were on the topic at each call."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.events_at_call = []

    def SendMail(self, request, context):
        self.events_at_call.append(len(self.ctx.kafka.records(TOPIC)))
        if request.recipient.startswith("bounce@"):
            return pb.Delivery(outcome="hard_bounce", bounce_category="mailbox_unknown")
        return pb.Delivery(outcome="accepted")

    def GetStatus(self, request, context):
        return pb.Delivery(outcome="unknown")


def _setup(ctx):
    relay = Relay(ctx)
    ctx.grpc.serve(pb_grpc.add_RelayServicer_to_server, relay)
    return ctx.load("events"), relay


def _dispatch(m, recipient, tenant="t-1"):
    return m.dispatch(store.enqueue(tenant, recipient, "welcome", "Welcome", {"first_name": "Ana"}))


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_recipient_key(ctx):
    m, _ = _setup(ctx)
    _dispatch(m, "ana@example.com", "t-1")
    _dispatch(m, "ana@example.com", "t-2")
    _dispatch(m, "Ana@Example.com", "t-1")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three dispatches produced {len(records)} records on {TOPIC}"
    want = _hash("ana@example.com").encode()
    keys = [r.key for r in records]
    assert keys == [want] * 3, f"one recipient's events were keyed {keys}, expected the recipient hash {want.decode()}: keyed by anything else, one recipient's lifecycle scatters across partitions"
    partitions = {r.partition for r in records}
    assert len(partitions) == 1, f"one recipient's events landed on partitions {sorted(partitions)}: a consumer can see bounced before accepted"


def check_outcome_after_relay(ctx):
    m, relay = _setup(ctx)
    _dispatch(m, "bounce@example.com")
    assert relay.events_at_call == [0], f"when the relay was called the topic already held {relay.events_at_call[0] if relay.events_at_call else '?'} event(s): an event reported an outcome the relay had not given yet. Deliver, then publish"
    records = ctx.kafka.records(TOPIC)
    types = [_payload(r).get("type") for r in records]
    assert types == ["email.bounced"], f"a message the relay hard-bounced produced events {types}, expected one email.bounced"
    assert _payload(records[0]).get("bounce_category") == "mailbox_unknown", f"the bounce event carries {_payload(records[0])}, expected bounce_category mailbox_unknown"
    _dispatch(m, "ana@example.com")
    types = [_payload(r).get("type") for r in ctx.kafka.records(TOPIC)]
    assert types == ["email.bounced", "email.accepted"], f"after an accepted message the topic holds {types}, expected email.bounced then email.accepted"


def check_hashed_payload(ctx):
    m, _ = _setup(ctx)
    _dispatch(m, "Ana@Example.com")
    record = ctx.kafka.records(TOPIC)[0]
    text = record.value.decode()
    assert "ana@example.com" not in text.lower(), f"the event carries the address: {text}. The topic is retained and every consumer reads it; carry recipient_hash"
    payload = _payload(record)
    assert payload.get("recipient_hash") == _hash("ana@example.com"), f"recipient_hash is {payload.get('recipient_hash')!r}, expected the SHA-256 of the normalized address"
    assert payload.get("message_id") and payload.get("tenant") == "t-1", f"the event must carry message_id and tenant, got {payload}"


def check_idempotent_producer(ctx):
    m, _ = _setup(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    _dispatch(m, "ana@example.com")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one dispatch whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    _dispatch(m, "bo@example.com")
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the event and lost it. Use acks=all"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'email.event';

const hashOf = (address: string): string => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

/** The relay stand-in: accepts every recipient but bounce@ (a hard bounce), noting how many events were on the topic at each call. */
function setup(ctx) {
  const pkg = ctx.proto('email_delivery.proto');
  const eventsAtCall: number[] = [];
  ctx.grpc.serve(pkg.smtprelay.Relay.service, {
    SendMail(call, callback) {
      eventsAtCall.push(ctx.kafka.records(TOPIC).length);
      if (call.request.recipient.startsWith('bounce@')) return callback(null, {outcome: 'hard_bounce', bounce_category: 'mailbox_unknown'});
      callback(null, {outcome: 'accepted', bounce_category: ''});
    },
    GetStatus(call, callback) {
      callback(null, {outcome: 'unknown', bounce_category: ''});
    },
  });
  const m = ctx.load('events');
  const store = ctx.load('/support/mail/store.ts');
  const dispatch = async (recipient: string, tenant = 't-1') => m.dispatch(await store.enqueue(tenant, recipient, 'welcome', 'Welcome', {first_name: 'Ana'}));
  return {eventsAtCall, dispatch};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_recipient_key(ctx) {
  const {dispatch} = setup(ctx);
  await dispatch('ana@example.com', 't-1');
  await dispatch('ana@example.com', 't-2');
  await dispatch('Ana@Example.com', 't-1');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three dispatches produced \${records.length} records on \${TOPIC}\`);
  const want = hashOf('ana@example.com');
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [want, want, want], \`one recipient's events were keyed \${JSON.stringify(keys)}, expected the recipient hash \${want}: keyed by anything else, one recipient's lifecycle scatters across partitions\`);
  const partitions = [...new Set(records.map(r => r.partition))];
  assert.equal(partitions.length, 1, \`one recipient's events landed on partitions \${JSON.stringify(partitions)}: a consumer can see bounced before accepted\`);
}

export async function check_outcome_after_relay(ctx) {
  const {eventsAtCall, dispatch} = setup(ctx);
  await dispatch('bounce@example.com');
  assert.deepStrictEqual(eventsAtCall, [0], \`when the relay was called the topic already held \${eventsAtCall[0]} event(s): an event reported an outcome the relay had not given yet. Deliver, then publish\`);
  const records = ctx.kafka.records(TOPIC);
  let types = records.map(r => payload(r).type);
  assert.deepStrictEqual(types, ['email.bounced'], \`a message the relay hard-bounced produced events \${JSON.stringify(types)}, expected one email.bounced\`);
  assert.equal(payload(records[0]).bounce_category, 'mailbox_unknown', \`the bounce event carries \${records[0].value}, expected bounce_category mailbox_unknown\`);
  await dispatch('ana@example.com');
  types = ctx.kafka.records(TOPIC).map(r => payload(r).type);
  assert.deepStrictEqual(types, ['email.bounced', 'email.accepted'], \`after an accepted message the topic holds \${JSON.stringify(types)}\`);
}

export async function check_hashed_payload(ctx) {
  const {dispatch} = setup(ctx);
  await dispatch('Ana@Example.com');
  const record = ctx.kafka.records(TOPIC)[0];
  const text = record.value.toString();
  assert(!text.toLowerCase().includes('ana@example.com'), \`the event carries the address: \${text}. The topic is retained and every consumer reads it; carry recipient_hash\`);
  const p = payload(record);
  assert.equal(p.recipient_hash, hashOf('ana@example.com'), 'recipient_hash must be the SHA-256 of the normalized address');
  assert(p.message_id && p.tenant === 't-1', \`the event must carry message_id and tenant, got \${text}\`);
}

export async function check_idempotent_producer(ctx) {
  const {dispatch} = setup(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await dispatch('ana@example.com');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one dispatch whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote the event twice. Make the producer idempotent (acks all)\`);
  await dispatch('bo@example.com');
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"mail/address"
	pb "mail/gen/email_delivery"
	"mail/store"

	"leetbuild/harness"
)

const topicName = "email.event"

var eventsBg = context.Background()

// eventsRelay accepts every recipient but bounce@ (a hard bounce), noting how many events were on the topic at each call.
type eventsRelay struct {
	pb.UnimplementedRelayServer
	ctx          *harness.Ctx
	eventsAtCall []int
}

func (p *eventsRelay) SendMail(_ context.Context, req *pb.SendMailRequest) (*pb.Delivery, error) {
	p.eventsAtCall = append(p.eventsAtCall, len(p.ctx.Kafka.Records(topicName)))
	if strings.HasPrefix(req.GetRecipient(), "bounce@") {
		return &pb.Delivery{Outcome: "hard_bounce", BounceCategory: "mailbox_unknown"}, nil
	}
	return &pb.Delivery{Outcome: "accepted"}, nil
}

func (p *eventsRelay) GetStatus(context.Context, *pb.StatusRequest) (*pb.Delivery, error) {
	return &pb.Delivery{Outcome: "unknown"}, nil
}

func serveEventsRelay(ctx *harness.Ctx) *eventsRelay {
	peer := &eventsRelay{ctx: ctx}
	pb.RegisterRelayServer(ctx.GRPC.Server(""), peer)
	return peer
}

func dispatchTo(ctx *harness.Ctx, recipient, tenant string) map[string]any {
	messageID := store.Enqueue(eventsBg, tenant, recipient, "welcome", "Welcome", map[string]string{"first_name": "Ana"})
	event, err := dispatch(eventsBg, messageID)
	ctx.NoError(err, "dispatch(%s) failed", messageID)
	return event
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func CheckRecipientKey(ctx *harness.Ctx) {
	serveEventsRelay(ctx)
	dispatchTo(ctx, "ana@example.com", "t-1")
	dispatchTo(ctx, "ana@example.com", "t-2")
	dispatchTo(ctx, "Ana@Example.com", "t-1")
	records := ctx.Kafka.Records(topicName)
	ctx.Equal(len(records), 3, "three dispatches, the records on %s", topicName)
	want := address.RecipientHash("ana@example.com")
	ctx.Equal(ctx.Kafka.Keys(topicName), []string{want, want, want}, "one recipient's events must be keyed by the recipient hash (keyed by anything else, one recipient's lifecycle scatters across partitions); the keys")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
		"one recipient's events landed on partitions %d, %d, %d: a consumer can see bounced before accepted", records[0].Partition, records[1].Partition, records[2].Partition)
}

func CheckOutcomeAfterRelay(ctx *harness.Ctx) {
	relay := serveEventsRelay(ctx)
	dispatchTo(ctx, "bounce@example.com", "t-1")
	ctx.Equal(relay.eventsAtCall, []int{0}, "when the relay was called the topic already held an event: an event reported an outcome the relay had not given yet. Deliver, then publish; the events on the topic at the call")
	records := ctx.Kafka.Records(topicName)
	var types []string
	for _, r := range records {
		t, _ := payloadOf(ctx, r.Value)["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"email.bounced"}, "a message the relay hard-bounced must produce one email.bounced; the types")
	ctx.Equal(payloadOf(ctx, records[0].Value)["bounce_category"], "mailbox_unknown", "the bounce event's bounce_category")
	dispatchTo(ctx, "ana@example.com", "t-1")
	types = nil
	for _, r := range ctx.Kafka.Records(topicName) {
		t, _ := payloadOf(ctx, r.Value)["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"email.bounced", "email.accepted"}, "after an accepted message, the types on the topic")
}

func CheckHashedPayload(ctx *harness.Ctx) {
	serveEventsRelay(ctx)
	dispatchTo(ctx, "Ana@Example.com", "t-1")
	record := ctx.Kafka.Records(topicName)[0]
	text := string(record.Value)
	ctx.Assert(!strings.Contains(strings.ToLower(text), "ana@example.com"), "the event carries the address: %s. The topic is retained and every consumer reads it; carry recipient_hash", text)
	p := payloadOf(ctx, record.Value)
	ctx.Equal(p["recipient_hash"], address.RecipientHash("ana@example.com"), "recipient_hash must be the SHA-256 of the normalized address")
	ctx.Assert(p["message_id"] != nil && p["tenant"] == "t-1", "the event must carry message_id and tenant, got %s", text)
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	serveEventsRelay(ctx)
	dispatchTo(ctx, "ana@example.com", "t-1")
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 1, "one dispatch, the records on the topic")
	dispatchTo(ctx, "bo@example.com", "t-1")
	lost := ctx.Kafka.Failover(topicName)
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

#include "email_delivery.grpc.pb.h"
#include "mail/address.h"
#include "mail/store.h"

namespace {

const std::string kTopic = "email.event";

// Accepts every recipient but bounce@ (a hard bounce), noting how many events were on the topic at each call.
class EventsRelay final : public smtprelay::Relay::Service {
 public:
  harness::Ctx* ctx = nullptr;
  std::vector<int> events_at_call;

  grpc::Status SendMail(grpc::ServerContext*, const smtprelay::SendMailRequest* req, smtprelay::Delivery* out) override {
    events_at_call.push_back(static_cast<int>(ctx->Kafka.Records(kTopic).size()));
    if (req->recipient().rfind("bounce@", 0) == 0) {
      out->set_outcome("hard_bounce");
      out->set_bounce_category("mailbox_unknown");
    } else {
      out->set_outcome("accepted");
    }
    return grpc::Status::OK;
  }

  grpc::Status GetStatus(grpc::ServerContext*, const smtprelay::StatusRequest*, smtprelay::Delivery* out) override {
    out->set_outcome("unknown");
    return grpc::Status::OK;
  }
};

EventsRelay& serveEventsRelay(harness::Ctx& ctx) {
  static EventsRelay* peer = nullptr;
  delete peer;
  peer = new EventsRelay;
  peer->ctx = &ctx;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

nlohmann::json dispatchTo(harness::Ctx& ctx, const std::string& recipient, const std::string& tenant) {
  const std::string message_id = mail::store::enqueue(tenant, recipient, "welcome", "Welcome", {{"first_name", "Ana"}});
  try {
    return dispatch(message_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("dispatch(%s) threw %s: %s", message_id, harness::CurrentExceptionType(), e.what());
  }
}

nlohmann::json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  const auto p = nlohmann::json::parse(record.Value.value_or(""), nullptr, false);
  ctx.Assert(p.is_object(), "the record's value is not JSON: %s", record.Value.value_or(""));
  return p;
}

std::vector<std::string> typesOn(harness::Ctx& ctx) {
  std::vector<std::string> types;
  for (const auto& r : ctx.Kafka.Records(kTopic)) types.push_back(payloadOf(ctx, r).value("type", ""));
  return types;
}

}  // namespace

void CheckRecipientKey(harness::Ctx& ctx) {
  serveEventsRelay(ctx);
  dispatchTo(ctx, "ana@example.com", "t-1");
  dispatchTo(ctx, "ana@example.com", "t-2");
  dispatchTo(ctx, "Ana@Example.com", "t-1");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three dispatches, the records on %s", kTopic);
  const std::string want = mail::address::recipientHash("ana@example.com");
  ctx.Equal(ctx.Kafka.Keys(kTopic), std::vector<std::string>{want, want, want}, "one recipient's events must be keyed by the recipient hash (keyed by anything else, one recipient's lifecycle scatters across partitions); the keys");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "one recipient's events landed on partitions %d, %d, %d: a consumer can see bounced before accepted", records[0].Partition, records[1].Partition, records[2].Partition);
}

void CheckOutcomeAfterRelay(harness::Ctx& ctx) {
  EventsRelay& relay = serveEventsRelay(ctx);
  dispatchTo(ctx, "bounce@example.com", "t-1");
  ctx.Equal(relay.events_at_call, std::vector<int>{0}, "when the relay was called the topic already held an event: an event reported an outcome the relay had not given yet. Deliver, then publish; the events on the topic at the call");
  ctx.Equal(typesOn(ctx), std::vector<std::string>{"email.bounced"}, "a message the relay hard-bounced must produce one email.bounced; the types");
  ctx.Equal(payloadOf(ctx, ctx.Kafka.Records(kTopic)[0]).value("bounce_category", ""), "mailbox_unknown", "the bounce event's bounce_category");
  dispatchTo(ctx, "ana@example.com", "t-1");
  ctx.Equal(typesOn(ctx), std::vector<std::string>{"email.bounced", "email.accepted"}, "after an accepted message, the types on the topic");
}

void CheckHashedPayload(harness::Ctx& ctx) {
  serveEventsRelay(ctx);
  dispatchTo(ctx, "Ana@Example.com", "t-1");
  const auto record = ctx.Kafka.Records(kTopic)[0];
  std::string lower = record.Value.value_or("");
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  ctx.Assert(lower.find("ana@example.com") == std::string::npos, "the event carries the address: %s. The topic is retained and every consumer reads it; carry recipient_hash", record.Value.value_or(""));
  const auto p = payloadOf(ctx, record);
  ctx.Equal(p.value("recipient_hash", ""), mail::address::recipientHash("ana@example.com"), "recipient_hash must be the SHA-256 of the normalized address");
  ctx.Assert(!p.value("message_id", "").empty() && p.value("tenant", "") == "t-1", "the event must carry message_id and tenant, got %s", p.dump());
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  serveEventsRelay(ctx);
  ctx.Kafka.LoseAcks(kTopic, 1);
  dispatchTo(ctx, "ana@example.com", "t-1");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one dispatch whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  dispatchTo(ctx, "bo@example.com", "t-1");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    'Dispatch a message to an address that hard-bounces: the topic says `email.accepted`, and the record carries the address in plain text under a key that changes with the tenant.',
    "The key is the tenant, so one recipient's events spread over partitions. The event is produced before `deliver` runs, so it can only guess the outcome, and the payload is built from the message as stored.",
    'Key by `recipient_hash(recipient)`, put `recipient_hash` in the value instead of `recipient`, call `deliver` first and publish `EVENT_TYPES[state]`, and set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event reports something that already happened, which is why it is produced after the relay answered and names the state the relay's answer put the message in. The key is the recipient because order only matters per recipient: a consumer suppressing addresses must see the bounce after the acceptance it follows. The hash keeps that ordering without spreading the address into a retained topic every consumer reads. Idempotence with acks=all makes a retry after a lost acknowledgement write the event once on every replica. Production senders write the event into an outbox in the same transaction as the state change and let a relay produce it, and they drop events of erased recipients when compacting the topic.`,
};
