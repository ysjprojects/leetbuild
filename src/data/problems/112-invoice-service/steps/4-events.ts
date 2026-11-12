import type {Step} from '@/lib/types';

export const invoiceEventsStep: Step = {
  id: 'events',
  title: 'Invoice events keyed by invoice with line digests',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter publishes the lifecycle the ledger consumes:
\`publish_event(event_type, invoice)\` builds a payload with the ids, number, currency and amounts
plus the invoice's \`line_items\` and \`internal_notes\`, produces it to \`invoice.event\` keyed by the
event type, and logs a failed delivery from its delivery callback; \`finalize_and_publish(tenant,
invoice_id)\` publishes \`invoice.finalized\`, then claims the number (\`sequence.claim_number\`).
Finalize an invoice and an event shows up; it hides four flaws.

**Failure mode the checks target.** An invoice's \`invoice.paid\` lands on another partition than
its \`invoice.finalized\` and the ledger applies them out of order; line descriptions and internal
notes sit in a topic retained for days; the ledger hears of a finalize that never claimed a number;
and an event the broker refused is gone.

- The record key is the **invoice id**.
- The payload carries \`event_type\`, \`invoice_id\`, \`tenant_id\`, \`number\`, \`currency\`,
  \`subtotal_cents\`, \`tax_cents\` and \`line_digests\` (\`store.line_digest\` of each line), and no
  line text or notes.
- \`finalize_and_publish\` claims first and publishes only when the claim answered a number.
- A delivery the broker refuses goes to the outbox (\`store.outbox_add(payload)\`) from the delivery
  report (\`on_delivery\`, a rejected \`send\`, the \`WriteMessages\` error, \`dr_cb\`, the producer
  \`Callback\`), for the relay to produce again.`,
  sequence: {
    participants: ['Finalize path', 'Redis', 'invoice.event', 'Ledger consumer'],
    messages: [
      {from: 'Finalize path', to: 'Redis', label: 'claim_number(tenant, id) → number', kind: 'sync'},
      {from: 'Finalize path', to: 'invoice.event', label: 'produce · key = invoice id · line_digests', kind: 'sync'},
      {
        from: 'invoice.event',
        to: 'Finalize path',
        label: 'delivery report · refused → outbox_add(payload)',
        kind: 'reply',
      },
      {
        from: 'invoice.event',
        to: 'Ledger consumer',
        label: 'finalized, paid: one partition per invoice',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'key-invoice',
      title: 'Keyed by invoice id',
      detail:
        "The record key is the invoice id, so one invoice's `finalized` and `paid` land on one partition in order; the starter keys by event type, which scatters one invoice's history across partitions.",
      match: {
        python: {all: [/key=invoice\["id"\]/, /invoice\.event/], none: [/key=event_type/]},
        typescript: {all: [/key:\s*invoice\.id\b/, /invoice\.event/], none: [/key:\s*eventType\b/]},
        go: {all: [/Key:\s*\[\]byte\(invoice\.ID\)/, /invoice\.event/], none: [/Key:\s*\[\]byte\(eventType\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*invoice\.id/, /invoice\.event/],
          none: [/EventTopic,\s*eventType/],
        },
        cpp: {
          all: [/invoice\.id\.c_str\(\),\s*invoice\.id\.size\(\)/, /invoice\.event/],
          none: [/event_type\.c_str\(\)/],
        },
      },
    },
    {
      id: 'digests-not-descriptions',
      title: 'Carries line digests, not line text or notes',
      detail:
        "The payload carries `line_digests` (`line_digest`/`lineDigest` of each line) and neither the line items nor `internal_notes`: the topic is retained and replicated, so a description written there outlives the invoice's own access rules.",
      match: {
        python: {all: [/line_digest\(/, /line_digests/], none: [/["']line_items["']\s*:/, /internal_notes/]},
        typescript: {all: [/lineDigest\(/, /line_digests/], none: [/line_items:\s*invoice/, /internal_notes/]},
        go: {all: [/store\.LineDigest\(/, /line_digests/], none: [/"line_items":/, /InternalNotes/]},
        scala: {all: [/Store\.lineDigest/, /line_digests/], none: [/"line_items"\s*->/, /internalNotes/]},
        cpp: {all: [/store::lineDigest\(/, /line_digests/], none: [/\{"line_items"/, /internal_notes/]},
      },
    },
    {
      id: 'publish-after-claim',
      title: 'Publishes only after the number is claimed',
      detail:
        '`finalize_and_publish`/`finalizeAndPublish` claims the number first and publishes only when the claim answered one, so the ledger never hears of a finalize that did not happen and every event carries its number.',
      match: {
        python: {order: [/def finalize_and_publish\(/, /claim_number\(/, /publish_event\(/]},
        typescript: {order: [/function finalizeAndPublish\(/, /claimNumber\(/, /publishEvent\(/]},
        go: {order: [/func finalizeAndPublish\(/, /sequence\.ClaimNumber\(/, /publishEvent\(/]},
        scala: {order: [/def finalizeAndPublish\(/, /Sequence\.claimNumber\(/, /publishEvent\(/]},
        cpp: {order: [/finalizeAndPublish\(const/, /sequence::claimNumber\(/, /publishEvent\(/]},
      },
    },
    {
      id: 'delivery',
      title: 'A refused delivery goes to the outbox',
      detail:
        'The delivery report (`on_delivery`, the rejected `send`, the `WriteMessages` error, `dr_cb`, the producer `Callback`) puts the payload in the outbox (`outbox_add`/`outboxAdd`) when the broker refused it; logging it loses the event.',
      match: {
        python: {all: [/on_delivery/, /store\.outbox_add\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outboxAdd\(/]},
        go: {all: [/store\.OutboxAdd\(/]},
        scala: {all: [/Store\.outboxAdd\(/, /onCompletion/]},
        cpp: {all: [/store::outboxAdd\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from invoice import sequence, store  # store.get, line_digest, outbox_add; sequence.claim_number

EVENT_TOPIC = "invoice.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("invoice event not delivered: %s", err)


def event_payload(event_type: str, invoice: dict) -> dict:
    """What the ledger needs to post the event."""
    return {
        "event_type": event_type,
        "invoice_id": invoice["id"],
        "tenant_id": invoice["tenant_id"],
        "number": invoice["number"],
        "currency": invoice["currency"],
        "subtotal_cents": invoice["subtotal_cents"],
        "tax_cents": invoice["tax_cents"],
        "line_items": invoice["line_items"],  # the ledger shows the lines
        "internal_notes": invoice["internal_notes"],
    }


def publish_event(event_type: str, invoice: dict) -> dict:
    """Produce one lifecycle event on invoice.event."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = event_payload(event_type, invoice)
    producer.produce(EVENT_TOPIC, key=event_type, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(10)
    return payload


def finalize_and_publish(tenant: str, invoice_id: str) -> dict | None:
    """Finalize the draft and tell the ledger; None when it was no longer a draft."""
    event = publish_event("invoice.finalized", store.get(invoice_id))
    if sequence.claim_number(tenant, invoice_id) is None:
        return None
    return event
`,
      solution: `import json

from confluent_kafka import Producer

from invoice import sequence, store  # store.get, line_digest, outbox_add; sequence.claim_number

EVENT_TOPIC = "invoice.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def event_payload(event_type: str, invoice: dict) -> dict:
    """What the ledger needs to post the event: one digest per line proves the lines without their text."""
    return {
        "event_type": event_type,
        "invoice_id": invoice["id"],
        "tenant_id": invoice["tenant_id"],
        "number": invoice["number"],
        "currency": invoice["currency"],
        "subtotal_cents": invoice["subtotal_cents"],
        "tax_cents": invoice["tax_cents"],
        "line_digests": [store.line_digest(line) for line in invoice["line_items"]],
    }


def publish_event(event_type: str, invoice: dict) -> dict:
    """Produce one lifecycle event on invoice.event."""
    payload = event_payload(event_type, invoice)

    def on_delivery(err, msg) -> None:
        if err is not None:
            # The broker did not take it: the relay produces it again from the outbox.
            store.outbox_add(payload)

    # Keyed by invoice: one invoice's events stay on one partition, in order.
    producer.produce(EVENT_TOPIC, key=invoice["id"], value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(10)
    return payload


def finalize_and_publish(tenant: str, invoice_id: str) -> dict | None:
    """Finalize the draft and tell the ledger; None when it was no longer a draft."""
    # The claim commits first: an event may lag the state, it may never precede it.
    if sequence.claim_number(tenant, invoice_id) is None:
        return None
    return publish_event("invoice.finalized", store.get(invoice_id))
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {claimNumber} from 'invoice/sequence';
import {type Invoice, get, lineDigest, outboxAdd} from 'invoice/store';

export const EVENT_TOPIC = 'invoice.event';

const kafka = new Kafka({clientId: 'invoiced', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the ledger needs to post the event. */
export function eventPayload(eventType: string, invoice: Invoice): Record<string, unknown> {
  const {id, tenant_id, number, currency, subtotal_cents, tax_cents} = invoice;
  return {
    event_type: eventType,
    invoice_id: id,
    tenant_id,
    number,
    currency,
    subtotal_cents,
    tax_cents,
    line_items: invoice.line_items, // the ledger shows the lines
    internal_notes: invoice.internal_notes,
  };
}

/** Produce one lifecycle event on invoice.event. */
export async function publishEvent(eventType: string, invoice: Invoice): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(eventType, invoice);
  try {
    await producer.send({topic: EVENT_TOPIC, acks: -1, messages: [{key: eventType, value: JSON.stringify(payload)}]});
  } catch (err) {
    console.warn('invoice event not delivered', err);
  }
  return payload;
}

/** Finalize the draft and tell the ledger; null when it was no longer a draft. */
export async function finalizeAndPublish(tenant: string, invoiceId: string): Promise<Record<string, unknown> | null> {
  const event = await publishEvent('invoice.finalized', (await get(invoiceId)) as Invoice);
  if ((await claimNumber(tenant, invoiceId)) === null) return null;
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {claimNumber} from 'invoice/sequence';
import {type Invoice, get, lineDigest, outboxAdd} from 'invoice/store';

export const EVENT_TOPIC = 'invoice.event';

const kafka = new Kafka({clientId: 'invoiced', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the ledger needs to post the event: one digest per line proves the lines without their text. */
export function eventPayload(eventType: string, invoice: Invoice): Record<string, unknown> {
  const {id, tenant_id, number, currency, subtotal_cents, tax_cents} = invoice;
  return {
    event_type: eventType,
    invoice_id: id,
    tenant_id,
    number,
    currency,
    subtotal_cents,
    tax_cents,
    line_digests: invoice.line_items.map(line => lineDigest(line)),
  };
}

/** Produce one lifecycle event on invoice.event. */
export async function publishEvent(eventType: string, invoice: Invoice): Promise<Record<string, unknown>> {
  const payload = eventPayload(eventType, invoice);
  try {
    // Keyed by invoice: one invoice's events stay on one partition, in order.
    await producer.send({topic: EVENT_TOPIC, acks: -1, messages: [{key: invoice.id, value: JSON.stringify(payload)}]});
  } catch {
    // The broker did not take it: the relay produces it again from the outbox.
    await outboxAdd(payload);
  }
  return payload;
}

/** Finalize the draft and tell the ledger; null when it was no longer a draft. */
export async function finalizeAndPublish(tenant: string, invoiceId: string): Promise<Record<string, unknown> | null> {
  // The claim commits first: an event may lag the state, it may never precede it.
  if ((await claimNumber(tenant, invoiceId)) === null) return null;
  return publishEvent('invoice.finalized', (await get(invoiceId)) as Invoice);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"

	"invoice/sequence" // sequence.ClaimNumber
	"invoice/store"    // store.Get, LineDigest, OutboxAdd
)

const eventTopic = "invoice.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

// eventPayload is what the ledger needs to post the event.
func eventPayload(eventType string, invoice *store.Invoice) map[string]any {
	return map[string]any{
		"event_type":     eventType,
		"invoice_id":     invoice.ID,
		"tenant_id":      invoice.TenantID,
		"number":         invoice.Number,
		"currency":       invoice.Currency,
		"subtotal_cents": invoice.SubtotalCents,
		"tax_cents":      invoice.TaxCents,
		"line_items":     invoice.LineItems, // the ledger shows the lines
		"internal_notes": invoice.InternalNotes,
	}
}

// publishEvent produces one lifecycle event on invoice.event.
func publishEvent(ctx context.Context, eventType string, invoice *store.Invoice) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := eventPayload(eventType, invoice)
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(eventType), Value: value}); err != nil {
		log.Printf("invoice event not delivered: %v", err)
	}
	return payload, nil
}

// finalizeAndPublish finalizes the draft and tells the ledger; nil when it was no longer a draft.
func finalizeAndPublish(ctx context.Context, tenant, invoiceID string) (map[string]any, error) {
	event, err := publishEvent(ctx, "invoice.finalized", store.Get(ctx, invoiceID))
	if err != nil {
		return nil, err
	}
	n, err := sequence.ClaimNumber(ctx, tenant, invoiceID)
	if err != nil || n == 0 {
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

	"invoice/sequence" // sequence.ClaimNumber
	"invoice/store"    // store.Get, LineDigest, OutboxAdd
)

const eventTopic = "invoice.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

// eventPayload is what the ledger needs to post the event: one digest per line proves the lines
// without their text.
func eventPayload(eventType string, invoice *store.Invoice) map[string]any {
	digests := make([]string, 0, len(invoice.LineItems))
	for _, line := range invoice.LineItems {
		digests = append(digests, store.LineDigest(line))
	}
	return map[string]any{
		"event_type":     eventType,
		"invoice_id":     invoice.ID,
		"tenant_id":      invoice.TenantID,
		"number":         invoice.Number,
		"currency":       invoice.Currency,
		"subtotal_cents": invoice.SubtotalCents,
		"tax_cents":      invoice.TaxCents,
		"line_digests":   digests,
	}
}

// publishEvent produces one lifecycle event on invoice.event.
func publishEvent(ctx context.Context, eventType string, invoice *store.Invoice) (map[string]any, error) {
	payload := eventPayload(eventType, invoice)
	value, _ := json.Marshal(payload)
	// Keyed by invoice: one invoice's events stay on one partition, in order.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(invoice.ID), Value: value}); err != nil {
		// The broker did not take it: the relay produces it again from the outbox.
		store.OutboxAdd(ctx, payload)
	}
	return payload, nil
}

// finalizeAndPublish finalizes the draft and tells the ledger; nil when it was no longer a draft.
func finalizeAndPublish(ctx context.Context, tenant, invoiceID string) (map[string]any, error) {
	// The claim commits first: an event may lag the state, it may never precede it.
	n, err := sequence.ClaimNumber(ctx, tenant, invoiceID)
	if err != nil || n == 0 {
		return nil, err
	}
	return publishEvent(ctx, "invoice.finalized", store.Get(ctx, invoiceID))
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import invoice.{Sequence, Store} // Store.get, lineDigest, outboxAdd; Sequence.claimNumber

object Events {
  val EventTopic = "invoice.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"invoice event not delivered: \${exception.getMessage}")
  }

  /** What the ledger needs to post the event. */
  def eventPayload(eventType: String, invoice: Store.Invoice): JsObject = JsObject(
    "event_type" -> JsString(eventType),
    "invoice_id" -> JsString(invoice.id),
    "tenant_id" -> JsString(invoice.tenantId),
    "number" -> invoice.number.map(JsNumber(_)).getOrElse(JsNull),
    "currency" -> JsString(invoice.currency),
    "subtotal_cents" -> JsNumber(invoice.subtotalCents),
    "tax_cents" -> invoice.taxCents.map(JsNumber(_)).getOrElse(JsNull),
    "line_items" -> Store.linesJson(invoice.lineItems), // the ledger shows the lines
    "internal_notes" -> JsString(invoice.internalNotes))

  /** Produce one lifecycle event on invoice.event. */
  def publishEvent(eventType: String, invoice: Store.Invoice): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(eventType, invoice)
    producer.send(new ProducerRecord[String, String](EventTopic, eventType, payload.compactPrint), onDelivery)
    producer.flush()
    payload
  }

  /** Finalize the draft and tell the ledger; None when it was no longer a draft. */
  def finalizeAndPublish(tenant: String, invoiceId: String): Option[JsObject] = {
    val event = publishEvent("invoice.finalized", Store.get(invoiceId).get)
    Sequence.claimNumber(tenant, invoiceId).map(_ => event)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import invoice.{Sequence, Store} // Store.get, lineDigest, outboxAdd; Sequence.claimNumber

object Events {
  val EventTopic = "invoice.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** What the ledger needs to post the event: one digest per line proves the lines without their text. */
  def eventPayload(eventType: String, invoice: Store.Invoice): JsObject = JsObject(
    "event_type" -> JsString(eventType),
    "invoice_id" -> JsString(invoice.id),
    "tenant_id" -> JsString(invoice.tenantId),
    "number" -> invoice.number.map(JsNumber(_)).getOrElse(JsNull),
    "currency" -> JsString(invoice.currency),
    "subtotal_cents" -> JsNumber(invoice.subtotalCents),
    "tax_cents" -> invoice.taxCents.map(JsNumber(_)).getOrElse(JsNull),
    "line_digests" -> JsArray(invoice.lineItems.map(line => JsString(Store.lineDigest(line))).toVector))

  /** Produce one lifecycle event on invoice.event. */
  def publishEvent(eventType: String, invoice: Store.Invoice): JsObject = {
    val payload = eventPayload(eventType, invoice)
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        // The broker did not take it: the relay produces it again from the outbox.
        if (exception != null) Store.outboxAdd(payload)
    }
    // Keyed by invoice: one invoice's events stay on one partition, in order.
    producer.send(new ProducerRecord[String, String](EventTopic, invoice.id, payload.compactPrint), onDelivery)
    producer.flush()
    payload
  }

  /** Finalize the draft and tell the ledger; None when it was no longer a draft. */
  def finalizeAndPublish(tenant: String, invoiceId: String): Option[JsObject] =
    // The claim commits first: an event may lag the state, it may never precede it.
    Sequence.claimNumber(tenant, invoiceId).map(_ => publishEvent("invoice.finalized", Store.get(invoiceId).get))
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "invoice/sequence.h"  // sequence::claimNumber
#include "invoice/store.h"     // store::get, lineDigest, outboxAdd

using json = nlohmann::json;

const std::string kEventTopic = "invoice.event";

// The delivery report of the record in flight: publishEvent produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "invoice event not delivered: " << message.errstr() << "\\n";
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the ledger needs to post the event.
json eventPayload(const std::string& event_type, const store::Invoice& invoice) {
  return json{{"event_type", event_type},
              {"invoice_id", invoice.id},
              {"tenant_id", invoice.tenant_id},
              {"number", invoice.number},
              {"currency", invoice.currency},
              {"subtotal_cents", invoice.subtotal_cents},
              {"tax_cents", invoice.tax_cents},
              {"line_items", store::linesJson(invoice.line_items)},  // the ledger shows the lines
              {"internal_notes", invoice.internal_notes}};
}

// Produce one lifecycle event on invoice.event.
json publishEvent(const std::string& event_type, const store::Invoice& invoice) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = eventPayload(event_type, invoice);
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    event_type.c_str(), event_type.size(), 0, nullptr);
  producer->flush(10000);
  return payload;
}

// Finalize the draft and tell the ledger; none when it was no longer a draft.
std::optional<json> finalizeAndPublish(const std::string& tenant, const std::string& invoice_id) {
  const json event = publishEvent("invoice.finalized", *store::get(invoice_id));
  if (sequence::claimNumber(tenant, invoice_id) == 0) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>

#include "invoice/sequence.h"  // sequence::claimNumber
#include "invoice/store.h"     // store::get, lineDigest, outboxAdd

using json = nlohmann::json;

const std::string kEventTopic = "invoice.event";

// The delivery report of the record in flight: a record the broker refused goes to the outbox, for
// the relay to produce again.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::outboxAdd(json::parse(std::string(static_cast<const char*>(message.payload()), message.len())));
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the ledger needs to post the event: one digest per line proves the lines without their text.
json eventPayload(const std::string& event_type, const store::Invoice& invoice) {
  json digests = json::array();
  for (const store::Line& line : invoice.line_items) digests.push_back(store::lineDigest(line));
  return json{{"event_type", event_type},
              {"invoice_id", invoice.id},
              {"tenant_id", invoice.tenant_id},
              {"number", invoice.number},
              {"currency", invoice.currency},
              {"subtotal_cents", invoice.subtotal_cents},
              {"tax_cents", invoice.tax_cents},
              {"line_digests", digests}};
}

// Produce one lifecycle event on invoice.event.
json publishEvent(const std::string& event_type, const store::Invoice& invoice) {
  const json payload = eventPayload(event_type, invoice);
  const std::string value = payload.dump();
  // Keyed by invoice: one invoice's events stay on one partition, in order.
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    invoice.id.c_str(), invoice.id.size(), 0, nullptr);
  producer->flush(10000);  // serves the delivery report
  return payload;
}

// Finalize the draft and tell the ledger; none when it was no longer a draft.
std::optional<json> finalizeAndPublish(const std::string& tenant, const std::string& invoice_id) {
  // The claim commits first: an event may lag the state, it may never precede it.
  if (sequence::claimNumber(tenant, invoice_id) == 0) return std::nullopt;
  return publishEvent("invoice.finalized", *store::get(invoice_id));
}
`,
    },
  },
  harness: {
    python: `import json

from invoice import store

TOPIC = "invoice.event"
LINES = [
    {"description": "Consulting: Acme merger due diligence", "quantity": 2, "unit_price_cents": 25000},
    {"description": "Travel to Zurich", "quantity": 1, "unit_price_cents": 12000},
]
NOTES = "margin 40%, do not discount"


def _draft():
    return store.create("t-1", "eur", LINES, "cus-1", "DE", NOTES)["id"]


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def _finalize(m, invoice_id):
    event = m.finalize_and_publish("t-1", invoice_id)
    assert event is not None, f"finalizing the draft {invoice_id} must answer its event"
    return event


def check_key_invoice(ctx):
    m = ctx.load("events")
    a, b = _draft(), _draft()
    _finalize(m, a)
    _finalize(m, b)
    m.publish_event("invoice.paid", store.get(a))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"two finalizes and a payment produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [a.encode(), b.encode(), a.encode()], f"records must be keyed by the invoice id ({a}, {b}, {a}), got {keys}"
    partitions = {r.partition for r in records if _payload(r).get("invoice_id") == a}
    assert len(partitions) == 1, f"{a}'s finalized and paid landed on partitions {sorted(partitions)}: the ledger can apply the payment first"


def check_digests_not_descriptions(ctx):
    m = ctx.load("events")
    a = _draft()
    _finalize(m, a)
    record = ctx.kafka.records(TOPIC)[0]
    text = record.value.decode()
    for line in LINES:
        assert line["description"] not in text, f"the event carries the line text {line['description']!r}: the topic is retained and replicated. Send line_digests"
    assert NOTES not in text, "the event carries the invoice's internal notes"
    payload = _payload(record)
    want = [store.line_digest(line) for line in LINES]
    assert payload.get("line_digests") == want, f"line_digests must be store.line_digest of each line in order, got {payload.get('line_digests')}"
    assert payload.get("invoice_id") == a and payload.get("subtotal_cents") == 62000 and payload.get("event_type") == "invoice.finalized", f"the event must carry event_type, invoice_id and subtotal_cents, got {payload}"


def check_publish_after_claim(ctx):
    m = ctx.load("events")
    a = _draft()
    # The moment the number is claimed, what is already on the topic.
    at_claim = ctx.redis_after("invoice:seq:t-1", lambda: len(ctx.kafka.records(TOPIC)))
    event = _finalize(m, a)
    assert at_claim.fired, "finalize_and_publish never claimed a number"
    assert at_claim.result == 0, f"when the number was claimed the topic already held {at_claim.result} record(s): the ledger heard of the finalize before it happened. Claim, then publish"
    assert event.get("number") == 1 and _payload(ctx.kafka.records(TOPIC)[0]).get("number") == 1, f"the finalized event must carry number 1, got {event}"
    before = len(ctx.kafka.records(TOPIC))
    again = m.finalize_and_publish("t-1", a)
    assert again is None, f"finalizing an invoice that is no longer a draft answered {again}, expected None"
    assert len(ctx.kafka.records(TOPIC)) == before, "a finalize that claimed nothing produced an event"


def check_delivery(ctx):
    m = ctx.load("events")
    a = _draft()
    ctx.kafka.fail_next(TOPIC, 1)
    _finalize(m, a)
    assert ctx.kafka.records(TOPIC) == [], "the broker refused the record, yet the topic holds one"
    outbox = store.outbox()
    assert len(outbox) == 1 and outbox[0].get("invoice_id") == a and outbox[0].get("event_type") == "invoice.finalized", f"the refused invoice.finalized must wait in the outbox for the relay, the outbox holds {outbox}"
    m.publish_event("invoice.paid", store.get(a))
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(store.outbox()) == 1, f"a delivered event must not go to the outbox (outbox {store.outbox()})"
`,
    typescript: `const TOPIC = 'invoice.event';
const LINES = [
  {description: 'Consulting: Acme merger due diligence', quantity: 2, unit_price_cents: 25000},
  {description: 'Travel to Zurich', quantity: 1, unit_price_cents: 12000},
];
const NOTES = 'margin 40%, do not discount';

function events(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/invoice/store.ts')};
}

async function draft(store): Promise<string> {
  return (await store.create('t-1', 'eur', LINES, 'cus-1', 'DE', NOTES)).id;
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

async function finalize(m, invoiceId: string) {
  const event = await m.finalizeAndPublish('t-1', invoiceId);
  assert(event !== null, \`finalizing the draft \${invoiceId} must answer its event\`);
  return event;
}

export async function check_key_invoice(ctx) {
  const {m, store} = events(ctx);
  const a = await draft(store);
  const b = await draft(store);
  await finalize(m, a);
  await finalize(m, b);
  await m.publishEvent('invoice.paid', await store.get(a));
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`two finalizes and a payment produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [a, b, a], \`records must be keyed by the invoice id (\${a}, \${b}, \${a}), got \${JSON.stringify(keys)}\`);
  const partitions = [...new Set(records.filter(r => payload(r).invoice_id === a).map(r => r.partition))];
  assert.equal(partitions.length, 1, \`\${a}'s finalized and paid landed on partitions \${JSON.stringify(partitions)}: the ledger can apply the payment first\`);
}

export async function check_digests_not_descriptions(ctx) {
  const {m, store} = events(ctx);
  const a = await draft(store);
  await finalize(m, a);
  const record = ctx.kafka.records(TOPIC)[0];
  const text = record.value.toString();
  for (const line of LINES) assert(!text.includes(line.description), \`the event carries the line text "\${line.description}": the topic is retained and replicated. Send line_digests\`);
  assert(!text.includes(NOTES), "the event carries the invoice's internal notes");
  const p = payload(record);
  assert.deepStrictEqual(p.line_digests, LINES.map(store.lineDigest), \`line_digests must be lineDigest of each line in order, got \${JSON.stringify(p.line_digests)}\`);
  assert(p.invoice_id === a && p.subtotal_cents === 62000 && p.event_type === 'invoice.finalized', \`the event must carry event_type, invoice_id and subtotal_cents, got \${text}\`);
}

export async function check_publish_after_claim(ctx) {
  const {m, store} = events(ctx);
  const a = await draft(store);
  // The moment the number is claimed, what is already on the topic.
  const atClaim = ctx.redisAfter('invoice:seq:t-1', () => ctx.kafka.records(TOPIC).length);
  const event = await finalize(m, a);
  assert(atClaim.fired, 'finalizeAndPublish never claimed a number');
  assert.equal(atClaim.result, 0, \`when the number was claimed the topic already held \${atClaim.result} record(s): the ledger heard of the finalize before it happened. Claim, then publish\`);
  assert(event.number === 1 && payload(ctx.kafka.records(TOPIC)[0]).number === 1, \`the finalized event must carry number 1, got \${JSON.stringify(event)}\`);
  const before = ctx.kafka.records(TOPIC).length;
  const again = await m.finalizeAndPublish('t-1', a);
  assert.equal(again, null, \`finalizing an invoice that is no longer a draft answered \${JSON.stringify(again)}, expected null\`);
  assert.equal(ctx.kafka.records(TOPIC).length, before, 'a finalize that claimed nothing produced an event');
}

export async function check_delivery(ctx) {
  const {m, store} = events(ctx);
  const a = await draft(store);
  ctx.kafka.failNext(TOPIC, 1);
  await finalize(m, a);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'the broker refused the record, yet the topic holds one');
  const outbox = await store.outbox();
  assert(outbox.length === 1 && outbox[0].invoice_id === a && outbox[0].event_type === 'invoice.finalized', \`the refused invoice.finalized must wait in the outbox for the relay, the outbox holds \${JSON.stringify(outbox)}\`);
  await m.publishEvent('invoice.paid', await store.get(a));
  assert(ctx.kafka.records(TOPIC).length === 1 && (await store.outbox()).length === 1, 'a delivered event must not go to the outbox');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"invoice/store"

	"leetbuild/harness"
)

const topic = "invoice.event"

var (
	eventsBg    = context.Background()
	eventsLines = []store.Line{
		{Description: "Consulting: Acme merger due diligence", Quantity: 2, UnitPriceCents: 25000},
		{Description: "Travel to Zurich", Quantity: 1, UnitPriceCents: 12000},
	}
	notes = "margin 40%, do not discount"
)

func eventDraft() string {
	return store.Create(eventsBg, "t-1", "eur", eventsLines, "cus-1", "DE", notes).ID
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func mustFinalize(ctx *harness.Ctx, invoiceID string) map[string]any {
	event, err := finalizeAndPublish(eventsBg, "t-1", invoiceID)
	ctx.NoError(err, "finalizeAndPublish(t-1, %s) failed", invoiceID)
	ctx.Assert(event != nil, "finalizing the draft %s must answer its event", invoiceID)
	return event
}

func CheckKeyInvoice(ctx *harness.Ctx) {
	a, b := eventDraft(), eventDraft()
	mustFinalize(ctx, a)
	mustFinalize(ctx, b)
	_, err := publishEvent(eventsBg, "invoice.paid", store.Get(eventsBg, a))
	ctx.NoError(err, "publishEvent(invoice.paid) failed")
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "two finalizes and a payment, the records on %s", topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{a, b, a}, "records must be keyed by the invoice id")
	partitions := map[int]bool{}
	for _, r := range records {
		if payloadOf(ctx, r.Value)["invoice_id"] == a {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "%s's finalized and paid landed on %d partitions: the ledger can apply the payment first; the partitions", a, len(partitions))
}

func CheckDigestsNotDescriptions(ctx *harness.Ctx) {
	a := eventDraft()
	mustFinalize(ctx, a)
	value := ctx.Kafka.Records(topic)[0].Value
	text := string(value)
	for _, line := range eventsLines {
		ctx.Assert(!strings.Contains(text, line.Description), "the event carries the line text %q: the topic is retained and replicated. Send line_digests", line.Description)
	}
	ctx.Assert(!strings.Contains(text, notes), "the event carries the invoice's internal notes")
	p := payloadOf(ctx, value)
	want := []any{}
	for _, line := range eventsLines {
		want = append(want, store.LineDigest(line))
	}
	ctx.Equal(p["line_digests"], want, "line_digests must be store.LineDigest of each line in order")
	ctx.Assert(p["invoice_id"] == a && p["subtotal_cents"] == float64(62000) && p["event_type"] == "invoice.finalized", "the event must carry event_type, invoice_id and subtotal_cents, got %s", text)
}

func CheckPublishAfterClaim(ctx *harness.Ctx) {
	a := eventDraft()
	// The moment the number is claimed, what is already on the topic.
	atClaim := ctx.Redis.After("invoice:seq:t-1", func() any { return len(ctx.Kafka.Records(topic)) })
	event := mustFinalize(ctx, a)
	ctx.Assert(atClaim.Fired, "finalizeAndPublish never claimed a number")
	ctx.Equal(atClaim.Result, 0, "when the number was claimed the topic already held records: the ledger heard of the finalize before it happened. Claim, then publish; the records at the claim")
	ctx.Assert(event["number"] == int64(1) && payloadOf(ctx, ctx.Kafka.Records(topic)[0].Value)["number"] == float64(1), "the finalized event must carry number 1, got %v", event)
	before := len(ctx.Kafka.Records(topic))
	again, err := finalizeAndPublish(eventsBg, "t-1", a)
	ctx.NoError(err, "a second finalize must not fail")
	ctx.Assert(again == nil, "finalizing an invoice that is no longer a draft answered %v, expected nil", again)
	ctx.Equal(len(ctx.Kafka.Records(topic)), before, "a finalize that claimed nothing must not produce an event; the records")
}

func CheckDelivery(ctx *harness.Ctx) {
	a := eventDraft()
	ctx.Kafka.FailNext(topic, 1)
	mustFinalize(ctx, a)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "the broker refused the record; the records on the topic")
	outbox := store.Outbox(eventsBg)
	ctx.Assert(len(outbox) == 1 && outbox[0]["invoice_id"] == a && outbox[0]["event_type"] == "invoice.finalized", "the refused invoice.finalized must wait in the outbox for the relay, the outbox holds %v", outbox)
	_, err := publishEvent(eventsBg, "invoice.paid", store.Get(eventsBg, a))
	ctx.NoError(err, "publishEvent(invoice.paid) failed")
	ctx.Assert(len(ctx.Kafka.Records(topic)) == 1 && len(store.Outbox(eventsBg)) == 1, "a delivered event must not go to the outbox (outbox %v)", store.Outbox(eventsBg))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "invoice/store.h"

namespace {

using json = nlohmann::json;

const std::string kTopic = "invoice.event";
const std::vector<store::Line> kEventLines = {{"Consulting: Acme merger due diligence", 2, 25000}, {"Travel to Zurich", 1, 12000}};
const std::string kNotes = "margin 40%, do not discount";

std::string eventDraft() { return store::create("t-1", "eur", kEventLines, "cus-1", "DE", kNotes).id; }

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

json mustFinalize(harness::Ctx& ctx, const std::string& invoice_id) {
  std::optional<json> event;
  try {
    event = finalizeAndPublish("t-1", invoice_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("finalizeAndPublish(t-1, %s) threw %s: %s", invoice_id, harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(event.has_value(), "finalizing the draft %s must answer its event", invoice_id);
  return *event;
}

}  // namespace

void CheckKeyInvoice(harness::Ctx& ctx) {
  const std::string a = eventDraft(), b = eventDraft();
  mustFinalize(ctx, a);
  mustFinalize(ctx, b);
  publishEvent("invoice.paid", *store::get(a));
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "two finalizes and a payment, the records on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {a, b, a}, "records must be keyed by the invoice id");
  std::set<int> partitions;
  for (const auto& r : records) {
    if (payloadOf(ctx, r).value("invoice_id", "") == a) partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "%s's finalized and paid must land on one partition, or the ledger can apply the payment first; the partitions", a);
}

void CheckDigestsNotDescriptions(harness::Ctx& ctx) {
  const std::string a = eventDraft();
  mustFinalize(ctx, a);
  const auto record = ctx.Kafka.Records(kTopic)[0];
  const std::string text = record.Value.value_or("");
  for (const auto& line : kEventLines) {
    ctx.Assert(text.find(line.description) == std::string::npos, "the event carries the line text %q: the topic is retained and replicated. Send line_digests", line.description);
  }
  ctx.Assert(text.find(kNotes) == std::string::npos, "the event carries the invoice's internal notes");
  const json p = payloadOf(ctx, record);
  std::vector<std::string> want;
  for (const auto& line : kEventLines) want.push_back(store::lineDigest(line));
  ctx.Equal(p.value("line_digests", std::vector<std::string>{}), want, "line_digests must be store::lineDigest of each line in order");
  ctx.Assert(p.value("invoice_id", "") == a && p.value("subtotal_cents", 0L) == 62000 && p.value("event_type", "") == "invoice.finalized",
             "the event must carry event_type, invoice_id and subtotal_cents, got %s", text);
}

void CheckPublishAfterClaim(harness::Ctx& ctx) {
  const std::string a = eventDraft();
  // The moment the number is claimed, what is already on the topic.
  int atClaim = -1;
  ctx.Redis.After("invoice:seq:t-1", [&] { atClaim = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  const json event = mustFinalize(ctx, a);
  ctx.Assert(atClaim >= 0, "finalizeAndPublish never claimed a number");
  ctx.Equal(atClaim, 0, "when the number was claimed the topic already held records: the ledger heard of the finalize before it happened. Claim, then publish; the records at the claim");
  ctx.Assert(event.value("number", 0L) == 1 && payloadOf(ctx, ctx.Kafka.Records(kTopic)[0]).value("number", 0L) == 1, "the finalized event must carry number 1, got %s",
             event.dump());
  const size_t before = ctx.Kafka.Records(kTopic).size();
  const auto again = finalizeAndPublish("t-1", a);
  ctx.Assert(!again, "finalizing an invoice that is no longer a draft answered %s, expected nothing", again ? again->dump() : "");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), before, "a finalize that claimed nothing must not produce an event; the records");
}

void CheckDelivery(harness::Ctx& ctx) {
  const std::string a = eventDraft();
  ctx.Kafka.FailNext(kTopic, 1);
  mustFinalize(ctx, a);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "the broker refused the record; the records on the topic");
  const auto outbox = store::outbox();
  ctx.Assert(outbox.size() == 1 && outbox[0].value("invoice_id", "") == a && outbox[0].value("event_type", "") == "invoice.finalized",
             "the refused invoice.finalized must wait in the outbox for the relay, the outbox holds %d event(s)", outbox.size());
  publishEvent("invoice.paid", *store::get(a));
  ctx.Assert(ctx.Kafka.Records(kTopic).size() == 1 && store::outbox().size() == 1, "a delivered event must not go to the outbox (outbox %d)", store::outbox().size());
}
`,
  },
  hints: [
    "Finalize an invoice, mark it paid, and read the partitions: its two events sit on two of them. The payload shows the customer's line text and your internal notes, and an event the broker refused is nowhere.",
    "The key is the event type, so every invoice's `paid` events share a partition apart from its `finalized`. The payload copies `line_items` and `internal_notes`. The event goes out before the claim, and the delivery callback only logs.",
    'Key by `invoice["id"]`; send `line_digests` from `store.line_digest` instead of the lines and notes; call `claim_number` first and publish only when it answered a number; in `on_delivery`, `store.outbox_add(payload)` when `err` is set.',
  ],
  debrief: `An event is a statement about state that already exists, so the claim commits before the record is produced, and a finalize that claimed nothing produces nothing. The key is the invoice because order only matters within one invoice's history. Digests let the ledger prove which lines it posted without the topic holding text that the invoice store protects with its own access rules. The delivery report is the only place a refused record shows up, so that is where it goes to the outbox; a try around \`produce\` sees only local errors. A ledger integration would write the outbox row in the same transaction as the claim and let the relay be the only producer, so a crash between the two cannot lose the event either.`,
};
