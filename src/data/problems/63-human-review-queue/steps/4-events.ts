import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Decision events: keyed by item, pseudonymous, after the commit, never dropped',
  concept: 'kafka',
  file: 'events',
  focus: ['queue', 'kafka', 'consumer', 'items'],
  task: `## Task

**Starting point.** The starter produces \`review.event\`, which the audit consumer reads.
\`record_event(kind, item, reviewer)\` produces \`{type: "review.{kind}", item_id, tenant, priority,
decision, reviewer_email}\` keyed by the reviewer on a producer with \`acks=1\`, flushes, and logs a
failed delivery. \`decide(item_id, reviewer, decision)\` records the \`decided\` event, then commits
the decision with \`store.decide\`, which answers \`None\` when the item was already decided. Decide
an item and its event shows up; it hides 5 flaws.

**Failure mode the checks target.** An item's assignment and decision land on two partitions and
the consumer applies them out of order; reviewer emails sit in a retained topic; a decision the
store refused still has an event; a delivery the broker refused is gone; a lost acknowledgement or
a leader failover duplicates or loses an event.

- Key every record by \`item_id\`.
- Carry \`reviewer_ref\` = \`store.reviewer_ref(reviewer)\` and nothing else about the reviewer.
- \`decide\` commits with \`store.decide\` first and produces only when it returned the item.
- A failed delivery (seen in the delivery callback) goes to \`store.park_event(event)\` for the relay.
- The producer is idempotent with \`acks=all\` (kafka-go has no idempotent producer: \`RequireAll\`).`,
  sequence: {
    participants: ['Review Queue', 'Review store', 'review.event', 'Audit consumer'],
    messages: [
      {from: 'Review Queue', to: 'Review store', label: 'decide(item_id, reviewer, decision)', kind: 'sync'},
      {from: 'Review store', to: 'Review Queue', label: 'item · or None (already decided)', kind: 'reply'},
      {
        from: 'Review Queue',
        to: 'review.event',
        label: 'produce key = item_id · reviewer_ref · acks=all',
        kind: 'sync',
      },
      {from: 'review.event', to: 'Review Queue', label: 'delivery report · failed → park_event', kind: 'reply'},
      {from: 'review.event', to: 'Audit consumer', label: 'consume · one partition per item', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'item-key',
      title: 'Keyed by item id',
      detail:
        "The record key is the item id, so an item's assignment and decision land on one partition in order; the starter keys by the reviewer, who changes when a lease expires.",
      match: {
        python: {all: [/key=item\[["']item_id["']\]/], none: [/key=reviewer/]},
        typescript: {all: [/key:\s*item\.item_id/], none: [/key:\s*reviewer/]},
        go: {all: [/Key:\s*\[\]byte\(item\["item_id"\]\)/], none: [/Key:\s*\[\]byte\(reviewer\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*item\("item_id"\)/],
          none: [/EventTopic,\s*reviewer/],
        },
        cpp: {all: [/item_id\.c_str\(\),\s*item_id\.size\(\)/], none: [/reviewer\.c_str\(\)/]},
      },
    },
    {
      id: 'reviewer-ref',
      title: 'The reviewer travels as a pseudonym',
      detail:
        "The event carries `reviewer_ref` from the store's pseudonym table and no reviewer email: the topic is retained and replicated, and its readers have no business knowing who decided.",
      match: {
        python: {all: [/store\.reviewer_ref\(/], none: [/reviewer_email/]},
        typescript: {all: [/store\.reviewerRef\(/], none: [/reviewer_email/]},
        go: {all: [/store\.ReviewerRef\(/], none: [/reviewer_email/]},
        scala: {all: [/Store\.reviewerRef\(/], none: [/reviewer_email/]},
        cpp: {all: [/store::reviewerRef\(/], none: [/reviewer_email/]},
      },
    },
    {
      id: 'commit-before-produce',
      title: 'Commits the decision before producing',
      detail:
        "`decide` calls the store's `decide` first and produces only when it returned the item, so a decision the store refused never has an event; the starter produces first.",
      match: {
        python: {order: [/def decide\(/, /store\.decide\(/, /record_event\(/]},
        typescript: {order: [/function decide\(/, /store\.decide\(/, /recordEvent\(/]},
        go: {order: [/func decide\(/, /store\.Decide\(/, /recordEvent\(/]},
        scala: {order: [/def decide\(/, /Store\.decide\(/, /recordEvent\(/]},
        cpp: {order: [/decide\(const std::string& item_id/, /store::decide\(/, /record_event\(/]},
      },
    },
    {
      id: 'delivery-parked',
      title: 'A refused delivery is parked for the relay',
      detail:
        'The delivery report decides: an event the broker did not take goes to `park_event`/`parkEvent` (`review:outbox`), so the committed decision still reaches the consumer; the starter only logs it.',
      match: {
        python: {all: [/store\.park_event\(/, /on_delivery/]},
        typescript: {all: [/store\.parkEvent\(/]},
        go: {all: [/store\.ParkEvent\(/]},
        scala: {all: [/Store\.parkEvent\(/, /Callback/]},
        cpp: {all: [/store::parkEvent\(/, /dr_cb/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent with `acks=all` (kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes once and a failover loses nothing; kafka-go has no idempotent producer, so its writer uses `RequireAll` and the consumer deduplicates by `(item_id, type)`.',
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

from review import store  # get_item, decide, reviewer_ref, park_event

EVENT_TOPIC = "review.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("review event not delivered: %s", err)


def record_event(kind: str, item: dict, reviewer: str) -> dict:
    """One record on review.event for an item's assignment or decision by reviewer."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "type": f"review.{kind}",
        "item_id": item["item_id"],
        "tenant": item["tenant"],
        "priority": item["priority"],
        "decision": item.get("decision", ""),
        "reviewer_email": reviewer,
    }
    producer.produce(EVENT_TOPIC, key=reviewer, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(5.0)
    return event


def decide(item_id: str, reviewer: str, decision: str) -> dict | None:
    """Record reviewer's decision on the item and tell the audit consumer; None when the item was already decided."""
    item = store.get_item(item_id)
    if item is None:
        return None
    event = record_event("decided", {**item, "decision": decision}, reviewer)
    if store.decide(item_id, reviewer, decision) is None:
        return None
    return event
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from review import store  # get_item, decide, reviewer_ref, park_event

EVENT_TOPIC = "review.event"
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def record_event(kind: str, item: dict, reviewer: str) -> dict:
    """One record on review.event for an item's assignment or decision by reviewer."""
    event = {
        "type": f"review.{kind}",
        "item_id": item["item_id"],
        "tenant": item["tenant"],
        "priority": item["priority"],
        "decision": item.get("decision", ""),
        # Who decided stays in the review store; the topic carries a pseudonym.
        "reviewer_ref": store.reviewer_ref(reviewer),
    }
    failures = []

    def on_delivery(err, msg) -> None:
        if err is not None:
            failures.append(err)

    producer.produce(EVENT_TOPIC, key=item["item_id"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(5.0)
    if failures:
        # The decision is committed: the relay produces the event once the broker takes it.
        log.warning("review event for %s not delivered (%s): parked", item["item_id"], failures[0])
        store.park_event(event)
    return event


def decide(item_id: str, reviewer: str, decision: str) -> dict | None:
    """Record reviewer's decision on the item and tell the audit consumer; None when the item was already decided."""
    # The decision commits first: an event may lag the state, it may never describe a decision that did not happen.
    item = store.decide(item_id, reviewer, decision)
    if item is None:
        return None
    return record_event("decided", item, reviewer)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as store from 'review/store'; // getItem, decide, reviewerRef, parkEvent

export const EVENT_TOPIC = 'review.event';

const kafka = new Kafka({clientId: 'reviewd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record on review.event for an item's assignment or decision by reviewer. */
export async function recordEvent(kind: string, item: store.Item, reviewer: string): Promise<Record<string, string>> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event = {
    type: \`review.\${kind}\`,
    item_id: item.item_id,
    tenant: item.tenant,
    priority: item.priority,
    decision: item.decision ?? '',
    reviewer_email: reviewer,
  };
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: reviewer, value: JSON.stringify(event)}], acks: 1});
  } catch (e) {
    console.warn('review event not delivered', e);
  }
  return event;
}

/** Record reviewer's decision on the item and tell the audit consumer; null when the item was already decided. */
export async function decide(itemId: string, reviewer: string, decision: string): Promise<Record<string, string> | null> {
  const item = await store.getItem(itemId);
  if (item === null) return null;
  const event = await recordEvent('decided', {...item, decision}, reviewer);
  if ((await store.decide(itemId, reviewer, decision)) === null) return null;
  return event;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as store from 'review/store'; // getItem, decide, reviewerRef, parkEvent

export const EVENT_TOPIC = 'review.event';

const kafka = new Kafka({clientId: 'reviewd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One record on review.event for an item's assignment or decision by reviewer. */
export async function recordEvent(kind: string, item: store.Item, reviewer: string): Promise<Record<string, string>> {
  const event = {
    type: \`review.\${kind}\`,
    item_id: item.item_id,
    tenant: item.tenant,
    priority: item.priority,
    decision: item.decision ?? '',
    // Who decided stays in the review store; the topic carries a pseudonym.
    reviewer_ref: await store.reviewerRef(reviewer),
  };
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: item.item_id, value: JSON.stringify(event)}], acks: -1});
  } catch (e) {
    // The decision is committed: the relay produces the event once the broker takes it.
    console.warn(\`review event for \${item.item_id} not delivered: parked\`, e);
    await store.parkEvent(event);
  }
  return event;
}

/** Record reviewer's decision on the item and tell the audit consumer; null when the item was already decided. */
export async function decide(itemId: string, reviewer: string, decision: string): Promise<Record<string, string> | null> {
  // The decision commits first: an event may lag the state, it may never describe a decision that did not happen.
  const item = await store.decide(itemId, reviewer, decision);
  if (item === null) return null;
  return recordEvent('decided', item, reviewer);
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

	"review/store" // store.GetItem, Decide, ReviewerRef, ParkEvent
)

const eventTopic = "review.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// recordEvent produces one record on review.event for an item's assignment or decision by reviewer.
func recordEvent(ctx context.Context, kind string, item map[string]string, reviewer string) (map[string]string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event := map[string]string{
		"type":           "review." + kind,
		"item_id":        item["item_id"],
		"tenant":         item["tenant"],
		"priority":       item["priority"],
		"decision":       item["decision"],
		"reviewer_email": reviewer,
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(reviewer), Value: value}); err != nil {
		log.Printf("review event not delivered: %v", err)
	}
	return event, nil
}

// decide records reviewer's decision on the item and tells the audit consumer; nil when the item was
// already decided.
func decide(ctx context.Context, itemID, reviewer, decision string) (map[string]string, error) {
	item := store.GetItem(ctx, itemID)
	if item == nil {
		return nil, nil
	}
	pending := map[string]string{}
	for name, value := range item {
		pending[name] = value
	}
	pending["decision"] = decision
	event, err := recordEvent(ctx, "decided", pending, reviewer)
	if err != nil {
		return nil, err
	}
	if store.Decide(ctx, itemID, reviewer, decision) == nil {
		return nil, nil
	}
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"

	"review/store" // store.GetItem, Decide, ReviewerRef, ParkEvent
)

const eventTopic = "review.event"

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; the consumer deduplicates by
// (item_id, type).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// recordEvent produces one record on review.event for an item's assignment or decision by reviewer.
func recordEvent(ctx context.Context, kind string, item map[string]string, reviewer string) (map[string]string, error) {
	event := map[string]string{
		"type":     "review." + kind,
		"item_id":  item["item_id"],
		"tenant":   item["tenant"],
		"priority": item["priority"],
		"decision": item["decision"],
		// Who decided stays in the review store; the topic carries a pseudonym.
		"reviewer_ref": store.ReviewerRef(ctx, reviewer),
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(item["item_id"]), Value: value}); err != nil {
		// The decision is committed: the relay produces the event once the broker takes it.
		log.Printf("review event for %s not delivered (%v): parked", item["item_id"], err)
		store.ParkEvent(ctx, event)
	}
	return event, nil
}

// decide records reviewer's decision on the item and tells the audit consumer; nil when the item was
// already decided.
func decide(ctx context.Context, itemID, reviewer, decision string) (map[string]string, error) {
	// The decision commits first: an event may lag the state, it may never describe a decision that did not happen.
	item := store.Decide(ctx, itemID, reviewer, decision)
	if item == nil {
		return nil, nil
	}
	return recordEvent(ctx, "decided", item, reviewer)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import review.Store // Store.getItem, decide, reviewerRef, parkEvent

object Events {
  val EventTopic = "review.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"review event not delivered: \${exception.getMessage}")
  }

  /** One record on review.event for an item's assignment or decision by reviewer. */
  def recordEvent(kind: String, item: Store.Item, reviewer: String): JsObject = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "type" -> JsString(s"review.$kind"),
      "item_id" -> JsString(item("item_id")),
      "tenant" -> JsString(item("tenant")),
      "priority" -> JsString(item("priority")),
      "decision" -> JsString(item.getOrElse("decision", "")),
      "reviewer_email" -> JsString(reviewer))
    producer.send(new ProducerRecord[String, String](EventTopic, reviewer, event.compactPrint), onDelivery)
    producer.flush()
    event
  }

  /** Record reviewer's decision on the item and tell the audit consumer; None when the item was already decided. */
  def decide(itemId: String, reviewer: String, decision: String): Option[JsObject] =
    Store.getItem(itemId).flatMap { item =>
      val event = recordEvent("decided", item + ("decision" -> decision), reviewer)
      Store.decide(itemId, reviewer, decision).map(_ => event)
    }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.atomic.AtomicReference

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import review.Store // Store.getItem, decide, reviewerRef, parkEvent

object Events {
  val EventTopic = "review.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One record on review.event for an item's assignment or decision by reviewer. */
  def recordEvent(kind: String, item: Store.Item, reviewer: String): JsObject = {
    val event = JsObject(
      "type" -> JsString(s"review.$kind"),
      "item_id" -> JsString(item("item_id")),
      "tenant" -> JsString(item("tenant")),
      "priority" -> JsString(item("priority")),
      "decision" -> JsString(item.getOrElse("decision", "")),
      // Who decided stays in the review store; the topic carries a pseudonym.
      "reviewer_ref" -> JsString(Store.reviewerRef(reviewer)))
    val failure = new AtomicReference[Exception]()
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) failure.set(exception)
    }
    producer.send(new ProducerRecord[String, String](EventTopic, item("item_id"), event.compactPrint), onDelivery)
    producer.flush()
    if (failure.get != null) {
      // The decision is committed: the relay produces the event once the broker takes it.
      System.err.println(s"review event for \${item("item_id")} not delivered (\${failure.get.getMessage}): parked")
      Store.parkEvent(event)
    }
    event
  }

  /** Record reviewer's decision on the item and tell the audit consumer; None when the item was already decided. */
  def decide(itemId: String, reviewer: String, decision: String): Option[JsObject] =
    // The decision commits first: an event may lag the state, it may never describe a decision that did not happen.
    Store.decide(itemId, reviewer, decision).map(item => recordEvent("decided", item, reviewer))
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

#include "review/store.h"  // store::getItem, decide, reviewerRef, parkEvent

using json = nlohmann::json;

const std::string kEventTopic = "review.event";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "review event not delivered: " << message.errstr() << "\\n";
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

// One record on review.event for an item's assignment or decision by reviewer.
json record_event(const std::string& kind, const store::Item& item, const std::string& reviewer) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const json event = {{"type", "review." + kind},
                      {"item_id", item.at("item_id")},
                      {"tenant", item.at("tenant")},
                      {"priority", item.at("priority")},
                      {"decision", item.count("decision") ? item.at("decision") : ""},
                      {"reviewer_email", reviewer}};
  const std::string value = event.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), reviewer.c_str(), reviewer.size(), 0, nullptr);
  producer->flush(5000);
  return event;
}

// Record reviewer's decision on the item and tell the audit consumer; none when the item was already
// decided.
std::optional<json> decide(const std::string& item_id, const std::string& reviewer, const std::string& decision) {
  auto item = store::getItem(item_id);
  if (!item) return std::nullopt;
  (*item)["decision"] = decision;
  const json event = record_event("decided", *item, reviewer);
  if (!store::decide(item_id, reviewer, decision)) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "review/store.h"  // store::getItem, decide, reviewerRef, parkEvent

using json = nlohmann::json;

const std::string kEventTopic = "review.event";

// The delivery reports of the last flush: whether the broker refused a record.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  bool failed = false;
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    failed = true;
    std::cerr << "review event not delivered: " << message.errstr() << "\\n";
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One record on review.event for an item's assignment or decision by reviewer.
json record_event(const std::string& kind, const store::Item& item, const std::string& reviewer) {
  const std::string item_id = item.at("item_id");
  const json event = {{"type", "review." + kind},
                      {"item_id", item_id},
                      {"tenant", item.at("tenant")},
                      {"priority", item.at("priority")},
                      {"decision", item.count("decision") ? item.at("decision") : ""},
                      // Who decided stays in the review store; the topic carries a pseudonym.
                      {"reviewer_ref", store::reviewerRef(reviewer)}};
  const std::string value = event.dump();
  delivery.failed = false;
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), item_id.c_str(), item_id.size(), 0, nullptr);
  producer->flush(5000);
  // The decision is committed: the relay produces the event once the broker takes it.
  if (delivery.failed) store::parkEvent(event);
  return event;
}

// Record reviewer's decision on the item and tell the audit consumer; none when the item was already
// decided.
std::optional<json> decide(const std::string& item_id, const std::string& reviewer, const std::string& decision) {
  // The decision commits first: an event may lag the state, it may never describe a decision that did not happen.
  const auto item = store::decide(item_id, reviewer, decision);
  if (!item) return std::nullopt;
  return record_event("decided", *item, reviewer);
}
`,
    },
  },
  harness: {
    python: `import json

from review import store

TOPIC = "review.event"
ALICE = "alice@example.com"
BOB = "bob@example.com"


def _events(ctx):
    m = ctx.load("events")
    for n in (1, 2):
        store.create_item({"item_id": f"r-{n}", "tenant": "t1", "source_type": "user_report", "source_id": f"s-{n}", "priority": "p2", "payload_ref": f"blob://{n}"})
    return m


def _payloads(ctx):
    out = []
    for record in ctx.kafka.records(TOPIC):
        try:
            out.append(json.loads(record.value))
        except Exception as exc:
            raise AssertionError(f"a record's value is not JSON: {record.value!r} ({exc})")
    return out


def check_item_key(ctx):
    m = _events(ctx)
    m.record_event("assigned", store.get_item("r-1"), ALICE)
    assert m.decide("r-1", BOB, "remove") is not None, "bob's decision on r-1 must be recorded"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"an assignment and a decision produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"r-1", b"r-1"], f"records must be keyed by the item id, got {keys}: keyed by the reviewer, r-1's assignment and decision land on different partitions"
    assert len({r.partition for r in records}) == 1, "r-1's events landed on different partitions: the consumer may apply the decision before the assignment"


def check_reviewer_ref(ctx):
    m = _events(ctx)
    m.decide("r-1", ALICE, "remove")
    m.decide("r-2", ALICE, "keep")
    raw = [r.value.decode() for r in ctx.kafka.records(TOPIC)]
    assert len(raw) == 2, f"two decisions produced {len(raw)} records"
    assert not any("alice" in v for v in raw), f"the topic carries the reviewer's email: {raw[0]}. It is retained and replicated; carry reviewer_ref from the pseudonym table"
    ref = store.reviewer_ref(ALICE)
    payloads = _payloads(ctx)
    assert [p.get("reviewer_ref") for p in payloads] == [ref, ref], f"both events must carry alice's pseudonym {ref!r}, got {[p.get('reviewer_ref') for p in payloads]}"
    assert payloads[0].get("type") == "review.decided" and payloads[0].get("decision") == "remove", f"the event must say what was decided, got {payloads[0]}"


def check_commit_before_produce(ctx):
    m = _events(ctx)
    assert m.decide("r-1", ALICE, "remove") is not None, "alice's decision on r-1 must be recorded"
    assert m.decide("r-1", BOB, "keep") is None, "a second decision on a decided item must answer None"
    n = len(ctx.kafka.records(TOPIC))
    assert n == 1, f"two decisions on r-1, of which the store accepted one, left {n} records: the event for bob's decision went out before the store refused it. Commit the decision, then produce"
    assert store.get_item("r-1")["decision"] == "remove", "the store must keep alice's decision"
    # Another reviewer decides r-2 right after decide's first command on it.
    rival = ctx.redis_after("review:item:r-2", lambda: store.decide("r-2", "carol@example.com", "keep"))
    answer = m.decide("r-2", ALICE, "remove")
    assert rival.fired, "decide never touched review:item:r-2"
    on_topic = [p for p in _payloads(ctx) if p.get("item_id") == "r-2"]
    stored = store.get_item("r-2")["decision"]
    assert len(on_topic) == (0 if answer is None else 1), f"decide answered {answer} while the topic holds {len(on_topic)} event(s) for r-2 and the store kept {stored!r}: an event must describe the decision the store committed"
    if answer is not None:
        assert on_topic[0].get("decision") == stored, f"the event for r-2 says {on_topic[0].get('decision')!r}, the store kept {stored!r}"


def check_delivery_parked(ctx):
    m = _events(ctx)
    ctx.kafka.fail_next(TOPIC)
    event = m.decide("r-1", ALICE, "remove")
    assert event is not None, "the decision was committed: decide must answer its event even when the broker refused it"
    assert ctx.kafka.records(TOPIC) == [], "the broker refused the record, yet it is on the topic"
    parked = [json.loads(v) for v in ctx.redis.lrange("review:outbox", 0, -1)]
    assert len(parked) == 1 and parked[0].get("item_id") == "r-1" and parked[0].get("type") == "review.decided", f"the broker refused the event for r-1's decision and review:outbox holds {parked}: the decision is committed, so the event must be parked for the relay"
    m.decide("r-2", ALICE, "keep")
    assert len(ctx.kafka.records(TOPIC)) == 1, "a delivered event must be on the topic"
    assert ctx.redis.llen("review:outbox") == 1, "a delivered event must not be parked"


def check_idempotent_producer(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.decide("r-1", ALICE, "remove")
    n = len(ctx.kafka.records(TOPIC))
    assert n == 1, f"one decision whose acknowledgement was lost left {n} records: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    m.decide("r-2", ALICE, "keep")
    ctx.kafka.failover(TOPIC)
    n = len(ctx.kafka.records(TOPIC))
    assert n == 2, f"after a leader failover the topic holds {n} records, expected 2: with acks=1 the leader alone acknowledged the second event and lost it. Use acks=all"
`,
    typescript: `const TOPIC = 'review.event';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

async function events(ctx) {
  const m = ctx.load('events');
  const store = ctx.load('/support/review/store.ts');
  for (const n of [1, 2]) {
    await store.createItem({item_id: \`r-\${n}\`, tenant: 't1', source_type: 'user_report', source_id: \`s-\${n}\`, priority: 'p2', payload_ref: \`blob://\${n}\`});
  }
  return {m, store};
}

function payloads(ctx) {
  return ctx.kafka.records(TOPIC).map(r => {
    try {
      return JSON.parse(r.value.toString());
    } catch (e) {
      assert.fail(\`a record's value is not JSON: \${r.value} (\${e})\`);
    }
  });
}

export async function check_item_key(ctx) {
  const {m, store} = await events(ctx);
  await m.recordEvent('assigned', await store.getItem('r-1'), ALICE);
  assert((await m.decide('r-1', BOB, 'remove')) !== null, "bob's decision on r-1 must be recorded");
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 2, \`an assignment and a decision produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['r-1', 'r-1'], \`records must be keyed by the item id, got \${JSON.stringify(keys)}: keyed by the reviewer, r-1's assignment and decision land on different partitions\`);
  assert.equal(new Set(records.map(r => r.partition)).size, 1, "r-1's events landed on different partitions: the consumer may apply the decision before the assignment");
}

export async function check_reviewer_ref(ctx) {
  const {m, store} = await events(ctx);
  await m.decide('r-1', ALICE, 'remove');
  await m.decide('r-2', ALICE, 'keep');
  const raw = ctx.kafka.records(TOPIC).map(r => r.value.toString());
  assert.equal(raw.length, 2, \`two decisions produced \${raw.length} records\`);
  assert(!raw.some(v => v.includes('alice')), \`the topic carries the reviewer's email: \${raw[0]}. It is retained and replicated; carry reviewer_ref from the pseudonym table\`);
  const ref = await store.reviewerRef(ALICE);
  const p = payloads(ctx);
  assert.deepStrictEqual(p.map(e => e.reviewer_ref), [ref, ref], \`both events must carry alice's pseudonym \${ref}\`);
  assert(p[0].type === 'review.decided' && p[0].decision === 'remove', \`the event must say what was decided, got \${JSON.stringify(p[0])}\`);
}

export async function check_commit_before_produce(ctx) {
  const {m, store} = await events(ctx);
  assert((await m.decide('r-1', ALICE, 'remove')) !== null, "alice's decision on r-1 must be recorded");
  assert.equal(await m.decide('r-1', BOB, 'keep'), null, 'a second decision on a decided item must answer null');
  const n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 1, \`two decisions on r-1, of which the store accepted one, left \${n} records: the event for bob's decision went out before the store refused it. Commit the decision, then produce\`);
  assert.equal((await store.getItem('r-1')).decision, 'remove', "the store must keep alice's decision");
  // Another reviewer decides r-2 right after decide's first command on it.
  const rival = ctx.redisAfter('review:item:r-2', () => store.decide('r-2', 'carol@example.com', 'keep'));
  const answer = await m.decide('r-2', ALICE, 'remove');
  assert(rival.fired, 'decide never touched review:item:r-2');
  await rival.result;
  const onTopic = payloads(ctx).filter(e => e.item_id === 'r-2');
  const stored = (await store.getItem('r-2')).decision;
  assert.equal(onTopic.length, answer === null ? 0 : 1, \`decide answered \${JSON.stringify(answer)} while the topic holds \${onTopic.length} event(s) for r-2 and the store kept \${stored}: an event must describe the decision the store committed\`);
  if (answer !== null) assert.equal(onTopic[0].decision, stored, 'the event for r-2 must carry the decision the store kept');
}

export async function check_delivery_parked(ctx) {
  const {m} = await events(ctx);
  ctx.kafka.failNext(TOPIC);
  const event = await m.decide('r-1', ALICE, 'remove');
  assert(event !== null, 'the decision was committed: decide must answer its event even when the broker refused it');
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'the broker refused the record, yet it is on the topic');
  const parked = (ctx.redis.lrange('review:outbox', 0, -1) as string[]).map(v => JSON.parse(v));
  assert(parked.length === 1 && parked[0].item_id === 'r-1' && parked[0].type === 'review.decided', \`the broker refused the event for r-1's decision and review:outbox holds \${JSON.stringify(parked)}: the decision is committed, so the event must be parked for the relay\`);
  await m.decide('r-2', ALICE, 'keep');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'a delivered event must be on the topic');
  assert.equal(ctx.redis.llen('review:outbox'), 1, 'a delivered event must not be parked');
}

export async function check_idempotent_producer(ctx) {
  const {m} = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.decide('r-1', ALICE, 'remove');
  let n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 1, \`one decision whose acknowledgement was lost left \${n} records: the producer's retry wrote the event twice. Make the producer idempotent (acks all)\`);
  await m.decide('r-2', ALICE, 'keep');
  ctx.kafka.failover(TOPIC);
  n = ctx.kafka.records(TOPIC).length;
  assert.equal(n, 2, \`after a leader failover the topic holds \${n} records, expected 2: with acks 1 the leader alone acknowledged the second event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"review/store"

	"leetbuild/harness"
)

const topic = "review.event"

var eventsBg = context.Background()

func seedItems() {
	for _, n := range []int{1, 2} {
		store.CreateItem(eventsBg, map[string]string{
			"item_id": fmt.Sprintf("r-%d", n), "tenant": "t1", "source_type": "user_report",
			"source_id": fmt.Sprintf("s-%d", n), "priority": "p2", "payload_ref": fmt.Sprintf("blob://%d", n),
		})
	}
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]string {
	var p map[string]string
	ctx.Assert(json.Unmarshal(value, &p) == nil, "a record's value is not a JSON object of strings: %s", value)
	return p
}

func mustDecide(ctx *harness.Ctx, itemID, reviewer, decision string) map[string]string {
	event, err := decide(eventsBg, itemID, reviewer, decision)
	ctx.NoError(err, "decide(%s, %s) failed", itemID, reviewer)
	return event
}

func CheckItemKey(ctx *harness.Ctx) {
	seedItems()
	_, err := recordEvent(eventsBg, "assigned", store.GetItem(eventsBg, "r-1"), "alice@example.com")
	ctx.NoError(err, "recordEvent(assigned) failed")
	ctx.Assert(mustDecide(ctx, "r-1", "bob@example.com", "remove") != nil, "bob's decision on r-1 must be recorded")
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 2, "an assignment and a decision; the records on %s", topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"r-1", "r-1"}, "records must be keyed by the item id (keyed by the reviewer, r-1's assignment and decision land on different partitions)")
	ctx.Assert(records[0].Partition == records[1].Partition, "r-1's events landed on partitions %d and %d: the consumer may apply the decision before the assignment", records[0].Partition, records[1].Partition)
}

func CheckReviewerRef(ctx *harness.Ctx) {
	seedItems()
	mustDecide(ctx, "r-1", "alice@example.com", "remove")
	mustDecide(ctx, "r-2", "alice@example.com", "keep")
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 2, "two decisions; the records")
	for _, r := range records {
		ctx.Assert(!strings.Contains(string(r.Value), "alice"), "the topic carries the reviewer's email: %s. It is retained and replicated; carry reviewer_ref from the pseudonym table", r.Value)
	}
	ref := store.ReviewerRef(eventsBg, "alice@example.com")
	first, second := payloadOf(ctx, records[0].Value), payloadOf(ctx, records[1].Value)
	ctx.Equal([]string{first["reviewer_ref"], second["reviewer_ref"]}, []string{ref, ref}, "both events must carry alice's pseudonym")
	ctx.Assert(first["type"] == "review.decided" && first["decision"] == "remove", "the event must say what was decided, got %v", first)
}

func CheckCommitBeforeProduce(ctx *harness.Ctx) {
	seedItems()
	ctx.Assert(mustDecide(ctx, "r-1", "alice@example.com", "remove") != nil, "alice's decision on r-1 must be recorded")
	ctx.Assert(mustDecide(ctx, "r-1", "bob@example.com", "keep") == nil, "a second decision on a decided item must answer nil")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "two decisions on r-1, of which the store accepted one: the event for bob's decision went out before the store refused it. Commit the decision, then produce; the records")
	ctx.Equal(store.GetItem(eventsBg, "r-1")["decision"], "remove", "the store must keep alice's decision")
	// Another reviewer decides r-2 right after decide's first command on it.
	rival := ctx.Redis.After("review:item:r-2", func() any {
		return store.Decide(eventsBg, "r-2", "carol@example.com", "keep") != nil
	})
	answer := mustDecide(ctx, "r-2", "alice@example.com", "remove")
	ctx.Assert(rival.Fired, "decide never touched review:item:r-2")
	var onTopic []map[string]string
	for _, r := range ctx.Kafka.Records(topic) {
		if p := payloadOf(ctx, r.Value); p["item_id"] == "r-2" {
			onTopic = append(onTopic, p)
		}
	}
	stored := store.GetItem(eventsBg, "r-2")["decision"]
	want := 0
	if answer != nil {
		want = 1
	}
	ctx.Equal(len(onTopic), want, "decide answered %v and the store kept %q: an event must describe the decision the store committed; the events for r-2", answer, stored)
	if answer != nil {
		ctx.Equal(onTopic[0]["decision"], stored, "the event for r-2 must carry the decision the store kept")
	}
}

func CheckDeliveryParked(ctx *harness.Ctx) {
	seedItems()
	ctx.Kafka.FailNext(topic, 1)
	ctx.Assert(mustDecide(ctx, "r-1", "alice@example.com", "remove") != nil, "the decision was committed: decide must answer its event even when the broker refused it")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 0, "the broker refused the record; the records on the topic")
	parked := ctx.Redis.LRange("review:outbox", 0, -1)
	ok := len(parked) == 1
	if ok {
		p := payloadOf(ctx, []byte(parked[0]))
		ok = p["item_id"] == "r-1" && p["type"] == "review.decided"
	}
	ctx.Assert(ok, "the broker refused the event for r-1's decision and review:outbox holds %q: the decision is committed, so the event must be parked for the relay", parked)
	mustDecide(ctx, "r-2", "alice@example.com", "keep")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "a delivered event must be on the topic; the records")
	ctx.Equal(ctx.Redis.LLen("review:outbox"), int64(1), "a delivered event must not be parked; the parked events")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	seedItems()
	mustDecide(ctx, "r-1", "alice@example.com", "remove")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one decision, the records on the topic")
	mustDecide(ctx, "r-2", "alice@example.com", "keep")
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "review/store.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "review.event";

void seedItems() {
  for (const std::string n : {"1", "2"}) {
    store::createItem({{"item_id", "r-" + n}, {"tenant", "t1"}, {"source_type", "user_report"}, {"source_id", "s-" + n}, {"priority", "p2"}, {"payload_ref", "blob://" + n}});
  }
}

json payloadOf(harness::Ctx& ctx, const std::string& value) {
  const json p = json::parse(value, nullptr, false);
  ctx.Assert(p.is_object(), "a record's value is not a JSON object: %s", value);
  return p;
}

std::vector<json> payloads(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& r : ctx.Kafka.Records(kTopic)) out.push_back(payloadOf(ctx, r.Value.value_or("")));
  return out;
}

}  // namespace

void CheckItemKey(harness::Ctx& ctx) {
  seedItems();
  record_event("assigned", store::getItem("r-1").value_or(store::Item{}), "alice@example.com");
  ctx.Assert(decide("r-1", "bob@example.com", "remove").has_value(), "bob's decision on r-1 must be recorded");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 2, "an assignment and a decision; the records on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"r-1", "r-1"}, "records must be keyed by the item id (keyed by the reviewer, r-1's assignment and decision land on different partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition, "r-1's events landed on partitions %d and %d: the consumer may apply the decision before the assignment", records[0].Partition, records[1].Partition);
}

void CheckReviewerRef(harness::Ctx& ctx) {
  seedItems();
  decide("r-1", "alice@example.com", "remove");
  decide("r-2", "alice@example.com", "keep");
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 2, "two decisions; the records");
  for (const auto& r : records) {
    const std::string value = r.Value.value_or("");
    ctx.Assert(value.find("alice") == std::string::npos, "the topic carries the reviewer's email: %s. It is retained and replicated; carry reviewer_ref from the pseudonym table", value);
  }
  const std::string ref = store::reviewerRef("alice@example.com");
  const auto p = payloads(ctx);
  ctx.Equal(std::vector<std::string>{p[0].value("reviewer_ref", ""), p[1].value("reviewer_ref", "")}, {ref, ref}, "both events must carry alice's pseudonym");
  ctx.Assert(p[0].value("type", "") == "review.decided" && p[0].value("decision", "") == "remove", "the event must say what was decided, got %s", p[0].dump());
}

void CheckCommitBeforeProduce(harness::Ctx& ctx) {
  seedItems();
  ctx.Assert(decide("r-1", "alice@example.com", "remove").has_value(), "alice's decision on r-1 must be recorded");
  ctx.Assert(!decide("r-1", "bob@example.com", "keep").has_value(), "a second decision on a decided item must answer nothing");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "two decisions on r-1, of which the store accepted one: the event for bob's decision went out before the store refused it. Commit the decision, then produce; the records");
  ctx.Equal(store::getItem("r-1").value_or(store::Item{})["decision"], "remove", "the store must keep alice's decision");
  // Another reviewer decides r-2 right after decide's first command on it.
  bool fired = false;
  ctx.Redis.After("review:item:r-2", [&] {
    fired = true;
    store::decide("r-2", "carol@example.com", "keep");
  });
  const auto answer = decide("r-2", "alice@example.com", "remove");
  ctx.Assert(fired, "decide never touched review:item:r-2");
  std::vector<json> on_topic;
  for (const auto& p : payloads(ctx)) {
    if (p.value("item_id", "") == "r-2") on_topic.push_back(p);
  }
  const std::string stored = store::getItem("r-2").value_or(store::Item{})["decision"];
  ctx.Equal(on_topic.size(), answer ? 1 : 0, "decide answered %t and the store kept %q: an event must describe the decision the store committed; the events for r-2", answer.has_value(), stored);
  if (answer) ctx.Equal(on_topic[0].value("decision", ""), stored, "the event for r-2 must carry the decision the store kept");
}

void CheckDeliveryParked(harness::Ctx& ctx) {
  seedItems();
  ctx.Kafka.FailNext(kTopic, 1);
  ctx.Assert(decide("r-1", "alice@example.com", "remove").has_value(), "the decision was committed: decide must answer its event even when the broker refused it");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 0, "the broker refused the record; the records on the topic");
  const auto parked = ctx.Redis.LRange("review:outbox", 0, -1);
  bool ok = parked.size() == 1;
  if (ok) {
    const json p = payloadOf(ctx, parked[0]);
    ok = p.value("item_id", "") == "r-1" && p.value("type", "") == "review.decided";
  }
  ctx.Assert(ok, "the broker refused the event for r-1's decision and review:outbox holds %q: the decision is committed, so the event must be parked for the relay", parked);
  decide("r-2", "alice@example.com", "keep");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "a delivered event must be on the topic; the records");
  ctx.Equal(ctx.Redis.LLen("review:outbox"), 1, "a delivered event must not be parked; the parked events");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  seedItems();
  ctx.Kafka.LoseAcks(kTopic, 1);
  decide("r-1", "alice@example.com", "remove");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one decision whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  decide("r-2", "alice@example.com", "keep");
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    "Decide an item twice from two reviewers and read the topic: two decisions are on it though the store kept one, and every record names the reviewer's email.",
    'The record is produced before `store.decide` can refuse it, keyed by whoever decided. The delivery callback only logs, so an event the broker refused is gone, and `acks=1` lets a failover lose it.',
    'Call `store.decide` first and return `None` when it does; key by `item["item_id"]`, send `store.reviewer_ref(reviewer)`, collect errors in the delivery callback and `store.park_event` them, and set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event is a statement about state that already exists, so the store's \`HSETNX\` decides who decided and the event follows it, never the other way round. Keying by item keeps one item's story on one partition, which is the only order the audit consumer needs. The pseudonym keeps the topic useful for counting and auditing without making it a directory of who reviewed what. Parking a refused event in the outbox is what makes a committed decision eventually visible even when the broker was down at the time. Production systems write the outbox in the same transaction as the decision and let a relay produce everything from it.`,
};
