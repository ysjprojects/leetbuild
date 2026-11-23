import type {Step} from '@/lib/types';

export const invoiceEventsStep: Step = {
  id: 'events',
  title: 'Invoice events keyed by subscription, after the outcome is stored',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['billing', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter is \`record_outcome(invoice, outcome)\`, called with what a charge
came to (\`{state, reference, reason}\`): for a charge it produces \`{invoice_id, subscription_id,
period_start, period_end, amount_cents, state, reference, reason}\` to \`billing.invoice\` keyed by
the invoice's tenant, then marks the invoice charged (\`store.mark_charged\`); a failure is marked
(\`store.mark_failed\`) and not published. It serves the demo and hides five flaws.

**Failure mode the checks target.** One subscription's invoices land on several partitions and the
ledger applies them out of order; the ledger hears of a charge the billing store does not show yet;
a declined card leaves no event; a broker that loses an acknowledgement gets the event twice, or a
leader failover loses it; and a broker that rejects or does not answer loses the event.

- The record key is the **subscription id**.
- **Store first**: \`mark_charged\` or \`mark_failed\`, then produce; a store write that fails produces
  nothing and reaches the caller.
- A failed outcome is published too, with \`state: "failed"\` and its \`reason\`.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go for that).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` = 2 s; a failed or missing report
  inserts an **outbox** row (\`store.insert_outbox(topic, key, event)\`) and returns \`False\`.`,
  sequence: {
    participants: ['Billing run', 'billing store', 'billing.invoice', 'Outbox'],
    messages: [
      {from: 'Billing run', to: 'billing store', label: 'mark_charged / mark_failed', kind: 'sync'},
      {
        from: 'Billing run',
        to: 'billing.invoice',
        label: 'produce key = subscription_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'billing.invoice', to: 'Billing run', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Billing run', to: 'Outbox', label: 'no report / failed → insert_outbox → False', kind: 'async'},
      {from: 'Outbox', to: 'billing.invoice', label: 'relay publishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'subscription-key',
      title: 'Keys billing.invoice by the subscription id',
      detail:
        "Invoices of sub_1, sub_2, sub_1 under one tenant carry those keys, and sub_1's two events share a partition. The starter keys by tenant, which orders a whole tenant together and nothing per subscription.",
      match: {
        python: {all: [/key\s*=\s*invoice\[["']subscription_id["']\]/], none: [/key\s*=\s*invoice\[["']tenant["']\]/]},
        typescript: {all: [/key:\s*invoice\.subscription_id/], none: [/key:\s*invoice\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(invoice\.SubscriptionID\)/], none: [/Key:\s*\[\]byte\(invoice\.Tenant\)/]},
        cpp: {
          all: [/invoice\.subscription_id\.c_str\(\),\s*invoice\.subscription_id\.size\(\)/],
          none: [/invoice\.tenant\.c_str\(\)/],
        },
      },
    },
    {
      id: 'record-before-produce',
      title: 'Stores the outcome before producing its event',
      detail:
        'When the invoice row is written, charged or failed, its event is not on the topic yet, and a store write that fails (a `WRONGTYPE` row) produces nothing: the event follows the stored outcome, so a consumer can always read what the event announces. The starter produces first.',
      match: {
        python: {order: [/store\.mark_charged\(/, /producer\.produce\(/]},
        typescript: {order: [/markCharged\(/, /producer\.send\(/]},
        go: {order: [/store\.MarkCharged\(/, /producer\.Produce\(/]},
        cpp: {order: [/store::markCharged\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'failed-published',
      title: 'Publishes a failed charge with its reason',
      detail:
        'A declined charge is published like a successful one, keyed by its subscription, with `state: "failed"` and the processor\'s reason, so the ledger has no silent gap. The starter returns before producing.',
      match: {
        python: {all: [/store\.mark_failed\(/], none: [/return False[\s\S]*producer\.produce\(/]},
        typescript: {all: [/markFailed\(/], none: [/return false[\s\S]*producer\.send\(/]},
        go: {all: [/store\.MarkFailed\(/], none: [/return false, nil[\s\S]*producer\.Produce\(/]},
        cpp: {all: [/store::markFailed\(/], none: [/return false;[\s\S]*producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'An acknowledged delivery returns true and leaves no row. A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the event itself, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /on_delivery\s*=/, /producer\.flush\(/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/, /time\.After\(/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from billing import store  # store.mark_charged, mark_failed, insert_outbox

TOPIC = "billing.invoice"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def invoice_event(invoice: dict, outcome: dict) -> dict:
    """What the ledger needs to apply a charge outcome; no card data, the topic is retained."""
    return {
        "invoice_id": invoice["invoice_id"],
        "subscription_id": invoice["subscription_id"],
        "period_start": invoice["period_start"],
        "period_end": invoice["period_end"],
        "amount_cents": invoice["amount_cents"],
        "state": outcome["state"],
        "reference": outcome["reference"],
        "reason": outcome["reason"],
    }


def record_outcome(invoice: dict, outcome: dict) -> bool:
    """Store what the charge of the invoice came to and tell the ledger; True once the event is on its way."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if outcome["state"] != "charged":
        store.mark_failed(invoice["invoice_id"], outcome["reason"])
        return False
    producer.produce(TOPIC, key=invoice["tenant"], value=json.dumps(invoice_event(invoice, outcome)))
    producer.poll(0)
    store.mark_charged(invoice["invoice_id"], outcome["reference"])
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from billing import store  # store.mark_charged, mark_failed, insert_outbox

TOPIC = "billing.invoice"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def invoice_event(invoice: dict, outcome: dict) -> dict:
    """What the ledger needs to apply a charge outcome; no card data, the topic is retained."""
    return {
        "invoice_id": invoice["invoice_id"],
        "subscription_id": invoice["subscription_id"],
        "period_start": invoice["period_start"],
        "period_end": invoice["period_end"],
        "amount_cents": invoice["amount_cents"],
        "state": outcome["state"],
        "reference": outcome["reference"],
        "reason": outcome["reason"],
    }


def record_outcome(invoice: dict, outcome: dict) -> bool:
    """Store what the charge of the invoice came to and tell the ledger; True once the broker acknowledged the event."""
    # The store first: an event must describe an outcome the billing store already holds.
    if outcome["state"] == "charged":
        store.mark_charged(invoice["invoice_id"], outcome["reference"])
    else:
        store.mark_failed(invoice["invoice_id"], outcome["reason"])
    event = invoice_event(invoice, outcome)
    delivery = {}

    def on_delivery(err, msg):
        delivery["error"] = err

    producer.produce(TOPIC, key=invoice["subscription_id"], value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or delivery.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
        store.insert_outbox(TOPIC, invoice["subscription_id"], event)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Invoice, type Outcome, insertOutbox, markCharged, markFailed} from 'billing/store';

export const TOPIC = 'billing.invoice';

const kafka = new Kafka({clientId: 'billingd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** What the ledger needs to apply a charge outcome; no card data, the topic is retained. */
export function invoiceEvent(invoice: Invoice, outcome: Outcome) {
  return {
    invoice_id: invoice.invoice_id,
    subscription_id: invoice.subscription_id,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    amount_cents: invoice.amount_cents,
    state: outcome.state,
    reference: outcome.reference,
    reason: outcome.reason,
  };
}

/** Store what the charge of the invoice came to and tell the ledger; true once the event is on its way. */
export async function recordOutcome(invoice: Invoice, outcome: Outcome): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  if (outcome.state !== 'charged') {
    await markFailed(invoice.invoice_id, outcome.reason);
    return false;
  }
  void producer.send({topic: TOPIC, messages: [{key: invoice.tenant, value: JSON.stringify(invoiceEvent(invoice, outcome))}], acks: 1});
  await markCharged(invoice.invoice_id, outcome.reference);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Invoice, type Outcome, insertOutbox, markCharged, markFailed} from 'billing/store';

export const TOPIC = 'billing.invoice';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'billingd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the ledger needs to apply a charge outcome; no card data, the topic is retained. */
export function invoiceEvent(invoice: Invoice, outcome: Outcome) {
  return {
    invoice_id: invoice.invoice_id,
    subscription_id: invoice.subscription_id,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    amount_cents: invoice.amount_cents,
    state: outcome.state,
    reference: outcome.reference,
    reason: outcome.reason,
  };
}

/** Store what the charge of the invoice came to and tell the ledger; true once the broker acknowledged the event. */
export async function recordOutcome(invoice: Invoice, outcome: Outcome): Promise<boolean> {
  // The store first: an event must describe an outcome the billing store already holds.
  if (outcome.state === 'charged') await markCharged(invoice.invoice_id, outcome.reference);
  else await markFailed(invoice.invoice_id, outcome.reason);
  const event = invoiceEvent(invoice, outcome);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: invoice.subscription_id, value: JSON.stringify(event)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
    await insertOutbox(TOPIC, invoice.subscription_id, event);
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

	"billing/store" // store.MarkCharged, MarkFailed, InsertOutbox
)

const topic = "billing.invoice"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// invoiceEvent is what the ledger needs to apply a charge outcome; no card data, the topic is retained.
func invoiceEvent(invoice *store.Invoice, outcome store.Outcome) map[string]any {
	return map[string]any{
		"invoice_id":      invoice.InvoiceID,
		"subscription_id": invoice.SubscriptionID,
		"period_start":    invoice.PeriodStart,
		"period_end":      invoice.PeriodEnd,
		"amount_cents":    invoice.AmountCents,
		"state":           outcome.State,
		"reference":       outcome.Reference,
		"reason":          outcome.Reason,
	}
}

// recordOutcome stores what the charge of the invoice came to and tells the ledger; true once the event is on its way.
func recordOutcome(ctx context.Context, invoice *store.Invoice, outcome store.Outcome) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	if outcome.State != "charged" {
		if err := store.MarkFailed(ctx, invoice.InvoiceID, outcome.Reason); err != nil {
			return false, err
		}
		return false, nil
	}
	value, _ := json.Marshal(invoiceEvent(invoice, outcome))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(invoice.Tenant), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	if err := store.MarkCharged(ctx, invoice.InvoiceID, outcome.Reference); err != nil {
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

	"billing/store" // store.MarkCharged, MarkFailed, InsertOutbox
)

const (
	topic      = "billing.invoice"
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

// invoiceEvent is what the ledger needs to apply a charge outcome; no card data, the topic is retained.
func invoiceEvent(invoice *store.Invoice, outcome store.Outcome) map[string]any {
	return map[string]any{
		"invoice_id":      invoice.InvoiceID,
		"subscription_id": invoice.SubscriptionID,
		"period_start":    invoice.PeriodStart,
		"period_end":      invoice.PeriodEnd,
		"amount_cents":    invoice.AmountCents,
		"state":           outcome.State,
		"reference":       outcome.Reference,
		"reason":          outcome.Reason,
	}
}

// recordOutcome stores what the charge of the invoice came to and tells the ledger; true once the broker acknowledged the event.
func recordOutcome(ctx context.Context, invoice *store.Invoice, outcome store.Outcome) (bool, error) {
	// The store first: an event must describe an outcome the billing store already holds.
	var err error
	if outcome.State == "charged" {
		err = store.MarkCharged(ctx, invoice.InvoiceID, outcome.Reference)
	} else {
		err = store.MarkFailed(ctx, invoice.InvoiceID, outcome.Reason)
	}
	if err != nil {
		return false, err
	}
	event := invoiceEvent(invoice, outcome)
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(invoice.SubscriptionID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, invoice.SubscriptionID, event); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "billing/store.h"  // store::markCharged, markFailed, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "billing.invoice";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What the ledger needs to apply a charge outcome; no card data, the topic is retained.
json invoiceEvent(const store::Invoice& invoice, const store::Outcome& outcome) {
  return json{{"invoice_id", invoice.invoice_id},     {"subscription_id", invoice.subscription_id},
              {"period_start", invoice.period_start}, {"period_end", invoice.period_end},
              {"amount_cents", invoice.amount_cents}, {"state", outcome.state},
              {"reference", outcome.reference},       {"reason", outcome.reason}};
}

// Store what the charge of the invoice came to and tell the ledger; true once the event is on its way.
bool recordOutcome(const store::Invoice& invoice, const store::Outcome& outcome) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  if (outcome.state != "charged") {
    store::markFailed(invoice.invoice_id, outcome.reason);
    return false;
  }
  const std::string value = invoiceEvent(invoice, outcome).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), invoice.tenant.c_str(), invoice.tenant.size(), 0, nullptr);
  producer->poll(0);
  store::markCharged(invoice.invoice_id, outcome.reference);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "billing/store.h"  // store::markCharged, markFailed, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "billing.invoice";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: recordOutcome produces one record and waits for it.
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

// What the ledger needs to apply a charge outcome; no card data, the topic is retained.
json invoiceEvent(const store::Invoice& invoice, const store::Outcome& outcome) {
  return json{{"invoice_id", invoice.invoice_id},     {"subscription_id", invoice.subscription_id},
              {"period_start", invoice.period_start}, {"period_end", invoice.period_end},
              {"amount_cents", invoice.amount_cents}, {"state", outcome.state},
              {"reference", outcome.reference},       {"reason", outcome.reason}};
}

// Store what the charge of the invoice came to and tell the ledger; true once the broker acknowledged the event.
bool recordOutcome(const store::Invoice& invoice, const store::Outcome& outcome) {
  // The store first: an event must describe an outcome the billing store already holds.
  if (outcome.state == "charged") {
    store::markCharged(invoice.invoice_id, outcome.reference);
  } else {
    store::markFailed(invoice.invoice_id, outcome.reason);
  }
  const json event = invoiceEvent(invoice, outcome);
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), invoice.subscription_id.c_str(), invoice.subscription_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
    store::insertOutbox(kTopic, invoice.subscription_id, event);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from billing import store

TOPIC = "billing.invoice"
CHARGED = {"state": "charged", "reference": "ch_1", "reason": ""}


def _invoice(subscription_id="sub_1"):
    store.put_subscription(subscription_id, "t-acme", "scale", "2026-03-01", "2026-04-01")
    return store.open_invoice(subscription_id, "2026-03-01", "2026-04-01", 9900)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_subscription_key(ctx):
    m = ctx.load("events")
    for subscription_id in ("sub_1", "sub_2", "sub_1"):
        m.record_outcome(_invoice(subscription_id), CHARGED)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three charged invoices produced {len(records)} records on billing.invoice (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"sub_1", b"sub_2", b"sub_1"], f"the records are keyed {keys}, expected the subscription ids sub_1, sub_2, sub_1"
    assert records[0].partition == records[2].partition, "both sub_1 events must land on one partition, or the ledger applies one subscription's invoices out of order"


def check_record_before_produce(ctx):
    m = ctx.load("events")
    invoice = _invoice()
    probe = ctx.redis_after(f"invoice:{invoice['invoice_id']}", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_outcome(invoice, CHARGED)
    assert probe.fired, "record_outcome never wrote the invoice row"
    assert probe.result == 0, f"when the invoice row was marked charged the topic already held {probe.result} record(s): the ledger heard of a charge the billing store did not show. Store first, then produce"
    assert store.find_invoice(invoice["invoice_id"])["state"] == "charged", "the invoice must be marked charged"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the store write"
    # A declined charge is stored first too: when its row reads failed, its event is not on the topic yet.
    declined = _invoice("sub_2")
    probe = ctx.redis_after(f"invoice:{declined['invoice_id']}", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_outcome(declined, {"state": "failed", "reference": "", "reason": "card_declined"})
    assert probe.fired, "record_outcome never wrote the declined invoice's row"
    assert probe.result == 1, f"when the declined invoice's row was marked failed the topic held {probe.result} record(s), expected only the earlier charge's: store a failure first, then produce it, like a charge"
    # The billing store refuses the write (WRONGTYPE): no event, and no outbox row, may announce an outcome the store does not hold.
    broken = _invoice("sub_3")
    ctx.redis.set(f"invoice:{broken['invoice_id']}", "not a hash")
    records_before = len(ctx.kafka.records(TOPIC))
    try:
        ok = m.record_outcome(broken, CHARGED)
    except Exception:
        ok = None
    produced = len(ctx.kafka.records(TOPIC)) - records_before
    assert produced == 0 and _outbox(ctx) == [], f"the store write for {broken['invoice_id']} failed, yet record_outcome produced {produced} record(s) and left the outbox {_outbox(ctx)}: a failed store write stops the event"
    assert ok is not True, "record_outcome returned True although the store write failed: let the failure reach the caller"


def check_failed_published(ctx):
    m = ctx.load("events")
    invoice = _invoice()
    m.record_outcome(invoice, {"state": "failed", "reference": "", "reason": "card_declined"})
    assert store.find_invoice(invoice["invoice_id"])["state"] == "failed", "a declined charge must mark the invoice failed"
    values = [r.value for r in ctx.kafka.records(TOPIC)]
    assert len(values) == 1, f"a declined charge produced {len(values)} records: the ledger needs the failure too"
    event = json.loads(values[0])
    assert event.get("state") == "failed" and event.get("reason") == "card_declined" and event.get("invoice_id") == invoice["invoice_id"], f"the event is {event}, expected state failed with reason card_declined for {invoice['invoice_id']}"
    key = ctx.kafka.records(TOPIC)[0].key
    assert key == b"sub_1", f"the failure's record is keyed {key!r}, expected the subscription id sub_1"


def check_idempotent_producer(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.record_outcome(_invoice(), CHARGED)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.record_outcome(_invoice(), CHARGED)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = ctx.load("events")
    healthy = _invoice()
    ok = m.record_outcome(healthy, CHARGED)
    assert ok is True and _outbox(ctx) == [], f"a delivery the broker acknowledged returned {ok!r} and left the outbox {_outbox(ctx)}: return True and keep no row"
    ctx.kafka.fail_next(TOPIC, 1)
    invoice = _invoice()
    ok = m.record_outcome(invoice, CHARGED)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the ledger never hears of the charge"
    payload = rows[0].get("payload") or {}
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "sub_1" and payload.get("invoice_id") == invoice["invoice_id"], f"the outbox row is {rows[0]}, expected the topic, the key sub_1 and the event"
    assert payload.get("subscription_id") == "sub_1" and payload.get("state") == "charged" and payload.get("reference") == "ch_1", f"the outbox payload is {payload}, expected the event the broker did not take (state charged, reference ch_1), which the relay publishes as is"
    assert ok is False, f"record_outcome returned {ok!r} after a failed delivery, expected False"
    assert store.find_invoice(invoice["invoice_id"])["state"] == "charged", "the invoice must stay charged when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    second = _invoice()
    ok = m.record_outcome(second, CHARGED)
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"record_outcome waited {waited:.1f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("invoice_id") == second["invoice_id"], f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"record_outcome returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'billing.invoice';
const CHARGED = {state: 'charged', reference: 'ch_1', reason: ''};

function world(ctx) {
  const store = ctx.load('/support/billing/store.ts');
  const invoice = async (subscriptionId = 'sub_1') => {
    await store.putSubscription(subscriptionId, 't-acme', 'scale', '2026-03-01', '2026-04-01');
    return store.openInvoice(subscriptionId, '2026-03-01', '2026-04-01', 9900);
  };
  return {m: ctx.load('events'), store, invoice};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_subscription_key(ctx) {
  const {m, invoice} = world(ctx);
  for (const subscriptionId of ['sub_1', 'sub_2', 'sub_1']) await m.recordOutcome(await invoice(subscriptionId), CHARGED);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three charged invoices produced \${records.length} records on billing.invoice\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['sub_1', 'sub_2', 'sub_1'], \`the records are keyed \${JSON.stringify(keys)}, expected the subscription ids sub_1, sub_2, sub_1\`);
  assert.equal(records[0].partition, records[2].partition, "both sub_1 events must land on one partition, or the ledger applies one subscription's invoices out of order");
}

export async function check_record_before_produce(ctx) {
  const {m, store, invoice} = world(ctx);
  const row = await invoice();
  const probe = ctx.redisAfter(\`invoice:\${row.invoice_id}\`, () => ctx.kafka.records(TOPIC).length);
  await m.recordOutcome(row, CHARGED);
  await settle();
  assert(probe.fired, 'recordOutcome never wrote the invoice row');
  assert.equal(probe.result, 0, \`when the invoice row was marked charged the topic already held \${probe.result} record(s): the ledger heard of a charge the billing store did not show. Store first, then produce\`);
  assert.equal((await store.findInvoice(row.invoice_id)).state, 'charged', 'the invoice must be marked charged');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the store write');
  // A declined charge is stored first too: when its row reads failed, its event is not on the topic yet.
  const declined = await invoice('sub_2');
  const failedProbe = ctx.redisAfter(\`invoice:\${declined.invoice_id}\`, () => ctx.kafka.records(TOPIC).length);
  await m.recordOutcome(declined, {state: 'failed', reference: '', reason: 'card_declined'});
  await settle();
  assert(failedProbe.fired, "recordOutcome never wrote the declined invoice's row");
  assert.equal(failedProbe.result, 1, \`when the declined invoice's row was marked failed the topic held \${failedProbe.result} record(s), expected only the earlier charge's: store a failure first, then produce it, like a charge\`);
  // The billing store refuses the write (WRONGTYPE): no event, and no outbox row, may announce an outcome the store does not hold.
  const broken = await invoice('sub_3');
  ctx.redis.set(\`invoice:\${broken.invoice_id}\`, 'not a hash');
  const recordsBefore = ctx.kafka.records(TOPIC).length;
  let ok;
  try {
    ok = await m.recordOutcome(broken, CHARGED);
  } catch {
    ok = undefined;
  }
  await settle();
  const produced = ctx.kafka.records(TOPIC).length - recordsBefore;
  assert(produced === 0 && outboxRows(ctx).length === 0, \`the store write for \${broken.invoice_id} failed, yet recordOutcome produced \${produced} record(s) and left the outbox \${JSON.stringify(outboxRows(ctx))}: a failed store write stops the event\`);
  assert.notEqual(ok, true, 'recordOutcome resolved true although the store write failed: let the failure reach the caller');
}

export async function check_failed_published(ctx) {
  const {m, store, invoice} = world(ctx);
  const row = await invoice();
  await m.recordOutcome(row, {state: 'failed', reference: '', reason: 'card_declined'});
  await settle();
  assert.equal((await store.findInvoice(row.invoice_id)).state, 'failed', 'a declined charge must mark the invoice failed');
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`a declined charge produced \${values.length} records: the ledger needs the failure too\`);
  const event = JSON.parse(values[0]);
  assert(event.state === 'failed' && event.reason === 'card_declined' && event.invoice_id === row.invoice_id, \`the event is \${values[0]}, expected state failed with reason card_declined for \${row.invoice_id}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['sub_1'], \`the failure's record is keyed \${JSON.stringify(keys)}, expected the subscription id sub_1\`);
}

export async function check_idempotent_producer(ctx) {
  const {m, invoice} = world(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.recordOutcome(await invoice(), CHARGED);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.recordOutcome(await invoice(), CHARGED);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const {m, store, invoice} = world(ctx);
  const healthy = await invoice();
  let ok = await m.recordOutcome(healthy, CHARGED);
  await settle();
  assert(ok === true && outboxRows(ctx).length === 0, \`a delivery the broker acknowledged resolved \${JSON.stringify(ok)} and left the outbox \${JSON.stringify(outboxRows(ctx))}: resolve true and keep no row\`);
  ctx.kafka.failNext(TOPIC, 1);
  const first = await invoice();
  ok = await m.recordOutcome(first, CHARGED);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the ledger never hears of the charge\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'sub_1' && rows[0].payload?.invoice_id === first.invoice_id, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key sub_1 and the event\`);
  const payload = rows[0].payload ?? {};
  assert(payload.subscription_id === 'sub_1' && payload.state === 'charged' && payload.reference === 'ch_1', \`the outbox payload is \${JSON.stringify(payload)}, expected the event the broker did not take (state charged, reference ch_1), which the relay publishes as is\`);
  assert.equal(ok, false, \`recordOutcome resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal((await store.findInvoice(first.invoice_id)).state, 'charged', 'the invoice must stay charged when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const second = await invoice();
  const before = ctx.clock.now();
  ok = await m.recordOutcome(second, CHARGED);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`recordOutcome waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.invoice_id === second.invoice_id, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`recordOutcome resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"billing/store"

	"leetbuild/harness"
)

const kHEventsTopic = "billing.invoice"

var (
	hEventsBg      = context.Background()
	hChargedResult = store.Outcome{State: "charged", Reference: "ch_1"}
)

func hEventsInvoice(subscriptionID string) *store.Invoice {
	store.PutSubscription(hEventsBg, subscriptionID, "t-acme", "scale", "2026-03-01", "2026-04-01")
	return store.OpenInvoice(hEventsBg, subscriptionID, "2026-03-01", "2026-04-01", 9900)
}

func hEventsRecord(ctx *harness.Ctx, invoice *store.Invoice, outcome store.Outcome) bool {
	ok, err := recordOutcome(hEventsBg, invoice, outcome)
	ctx.NoError(err, "recordOutcome(%s)", invoice.InvoiceID)
	return ok
}

type HEventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func hEventsOutbox(ctx *harness.Ctx) []HEventsRow {
	var rows []HEventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row HEventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckSubscriptionKey(ctx *harness.Ctx) {
	for _, subscriptionID := range []string{"sub_1", "sub_2", "sub_1"} {
		hEventsRecord(ctx, hEventsInvoice(subscriptionID), hChargedResult)
	}
	ctx.Settle()
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 3, "three charged invoices must produce three records on billing.invoice; the records")
	ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), []string{"sub_1", "sub_2", "sub_1"}, "the records must be keyed by the subscription ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both sub_1 events must land on one partition, or the ledger applies one subscription's invoices out of order; the partitions")
}

func CheckRecordBeforeProduce(ctx *harness.Ctx) {
	invoice := hEventsInvoice("sub_1")
	probe := ctx.Redis.After("invoice:"+invoice.InvoiceID, func() any { return len(ctx.Kafka.Records(kHEventsTopic)) })
	hEventsRecord(ctx, invoice, hChargedResult)
	ctx.Settle()
	ctx.Assert(probe.Fired, "recordOutcome never wrote the invoice row")
	ctx.Equal(probe.Result, 0, "when the invoice row was marked charged the topic already held records: the ledger heard of a charge the billing store did not show. Store first, then produce; the records at store time")
	ctx.Equal(store.FindInvoice(hEventsBg, invoice.InvoiceID).State, "charged", "the invoice's state")
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "the event must still be produced after the store write; the records")
	// A declined charge is stored first too: when its row reads failed, its event is not on the topic yet.
	declined := hEventsInvoice("sub_2")
	failedProbe := ctx.Redis.After("invoice:"+declined.InvoiceID, func() any { return len(ctx.Kafka.Records(kHEventsTopic)) })
	hEventsRecord(ctx, declined, store.Outcome{State: "failed", Reason: "card_declined"})
	ctx.Settle()
	ctx.Assert(failedProbe.Fired, "recordOutcome never wrote the declined invoice's row")
	ctx.Equal(failedProbe.Result, 1, "when the declined invoice's row was marked failed the topic must hold only the earlier charge's record: store a failure first, then produce it, like a charge; the records at store time")
	// The billing store refuses the write (WRONGTYPE): no event, and no outbox row, may announce an outcome the store does not hold.
	broken := hEventsInvoice("sub_3")
	ctx.Redis.Set("invoice:"+broken.InvoiceID, "not a hash")
	recordsBefore := len(ctx.Kafka.Records(kHEventsTopic))
	ok, err := recordOutcome(hEventsBg, broken, hChargedResult)
	ctx.Settle()
	produced := len(ctx.Kafka.Records(kHEventsTopic)) - recordsBefore
	ctx.Assert(produced == 0 && len(hEventsOutbox(ctx)) == 0, "the store write for %s failed, yet recordOutcome produced %d record(s) and left the outbox %v: a failed store write stops the event", broken.InvoiceID, produced, hEventsOutbox(ctx))
	ctx.Assert(!ok || err != nil, "recordOutcome returned true and no error although the store write failed: let the failure reach the caller")
}

func CheckFailedPublished(ctx *harness.Ctx) {
	invoice := hEventsInvoice("sub_1")
	hEventsRecord(ctx, invoice, store.Outcome{State: "failed", Reason: "card_declined"})
	ctx.Settle()
	ctx.Equal(store.FindInvoice(hEventsBg, invoice.InvoiceID).State, "failed", "a declined charge must mark the invoice failed; its state")
	values := ctx.Kafka.Values(kHEventsTopic)
	ctx.Equal(len(values), 1, "a declined charge must be published: the ledger needs the failure too; the records")
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	ctx.Assert(event["state"] == "failed" && event["reason"] == "card_declined" && event["invoice_id"] == invoice.InvoiceID, "the event is %s, expected state failed with reason card_declined for %s", values[0], invoice.InvoiceID)
	ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), []string{"sub_1"}, "the failure's record must be keyed by the subscription id")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(kHEventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	hEventsRecord(ctx, hEventsInvoice("sub_1"), hChargedResult)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	hEventsRecord(ctx, hEventsInvoice("sub_1"), hChargedResult)
	ctx.Settle()
	ctx.Kafka.Failover(kHEventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	healthy := hEventsInvoice("sub_1")
	ok := hEventsRecord(ctx, healthy, hChargedResult)
	ctx.Settle()
	ctx.Assert(ok && len(hEventsOutbox(ctx)) == 0, "a delivery the broker acknowledged returned %t and left the outbox %v: return true and keep no row", ok, hEventsOutbox(ctx))
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	first := hEventsInvoice("sub_1")
	ok = hEventsRecord(ctx, first, hChargedResult)
	ctx.Settle()
	rows := hEventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the ledger never hears of the charge; the rows")
	ctx.Assert(rows[0].Topic == kHEventsTopic && rows[0].Key == "sub_1" && rows[0].Payload["invoice_id"] == first.InvoiceID, "the outbox row is %v, expected the topic, the key sub_1 and the event", rows[0])
	payload := rows[0].Payload
	ctx.Assert(payload["subscription_id"] == "sub_1" && payload["state"] == "charged" && payload["reference"] == "ch_1", "the outbox payload is %v, expected the event the broker did not take (state charged, reference ch_1), which the relay publishes as is", payload)
	ctx.Equal(ok, false, "recordOutcome's result after a failed delivery")
	ctx.Equal(store.FindInvoice(hEventsBg, first.InvoiceID).State, "charged", "the invoice must stay charged when only the produce failed; its state")
	ctx.Kafka.Stall(kHEventsTopic) // the broker stops answering
	second := hEventsInvoice("sub_1")
	before := ctx.Clock.Now()
	ok = hEventsRecord(ctx, second, hChargedResult)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "recordOutcome waited %.1f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = hEventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["invoice_id"] == second.InvoiceID, "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "recordOutcome's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "billing/store.h"

namespace {

const std::string kHEventsTopic = "billing.invoice";
const store::Outcome kHEventsCharged{"charged", "ch_1", ""};

store::Invoice hEventsInvoice(const std::string& subscription_id = "sub_1") {
  store::putSubscription(subscription_id, "t-acme", "scale", "2026-03-01", "2026-04-01");
  return store::openInvoice(subscription_id, "2026-03-01", "2026-04-01", 9900);
}

std::vector<nlohmann::json> hEventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string hEventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckSubscriptionKey(harness::Ctx& ctx) {
  for (const std::string subscription_id : {"sub_1", "sub_2", "sub_1"}) recordOutcome(hEventsInvoice(subscription_id), kHEventsCharged);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 3, "three charged invoices must produce three records on billing.invoice; the records");
  ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), {"sub_1", "sub_2", "sub_1"}, "the records must be keyed by the subscription ids");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both sub_1 events must land on one partition, or the ledger applies one subscription's invoices out of order; the partitions");
}

void CheckRecordBeforeProduce(harness::Ctx& ctx) {
  const store::Invoice invoice = hEventsInvoice();
  size_t atStore = 999;
  bool fired = false;
  ctx.Redis.After("invoice:" + invoice.invoice_id, [&] {
    fired = true;
    atStore = ctx.Kafka.Records(kHEventsTopic).size();
  });
  recordOutcome(invoice, kHEventsCharged);
  ctx.Settle();
  ctx.Assert(fired, "recordOutcome never wrote the invoice row");
  ctx.Equal(atStore, 0,
            "when the invoice row was marked charged the topic already held records: the ledger heard of a charge the billing store "
            "did not show. Store first, then produce; the records at store time");
  ctx.Equal(store::findInvoice(invoice.invoice_id)->state, "charged", "the invoice's state");
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "the event must still be produced after the store write; the records");
  // A declined charge is stored first too: when its row reads failed, its event is not on the topic yet.
  const store::Invoice declined = hEventsInvoice("sub_2");
  size_t atFailed = 999;
  bool failedFired = false;
  ctx.Redis.After("invoice:" + declined.invoice_id, [&] {
    failedFired = true;
    atFailed = ctx.Kafka.Records(kHEventsTopic).size();
  });
  recordOutcome(declined, store::Outcome{"failed", "", "card_declined"});
  ctx.Settle();
  ctx.Assert(failedFired, "recordOutcome never wrote the declined invoice's row");
  ctx.Equal(atFailed, 1,
            "when the declined invoice's row was marked failed the topic must hold only the earlier charge's record: store a failure first, then "
            "produce it, like a charge; the records at store time");
  // The billing store refuses the write (WRONGTYPE): no event, and no outbox row, may announce an outcome the store does not hold.
  const store::Invoice broken = hEventsInvoice("sub_3");
  ctx.Redis.Set("invoice:" + broken.invoice_id, "not a hash");
  const size_t recordsBefore = ctx.Kafka.Records(kHEventsTopic).size();
  bool reported = false;
  try {
    reported = recordOutcome(broken, kHEventsCharged);
  } catch (const std::exception&) {
    reported = false;
  }
  ctx.Settle();
  const size_t produced = ctx.Kafka.Records(kHEventsTopic).size() - recordsBefore;
  ctx.Assert(produced == 0 && hEventsOutbox(ctx).empty(),
             "the store write for %s failed, yet recordOutcome produced %d record(s) and left %d outbox row(s): a failed store write stops the event",
             broken.invoice_id, produced, hEventsOutbox(ctx).size());
  ctx.Assert(!reported, "recordOutcome returned true although the store write failed: let the failure reach the caller");
}

void CheckFailedPublished(harness::Ctx& ctx) {
  const store::Invoice invoice = hEventsInvoice();
  recordOutcome(invoice, store::Outcome{"failed", "", "card_declined"});
  ctx.Settle();
  ctx.Equal(store::findInvoice(invoice.invoice_id)->state, "failed", "a declined charge must mark the invoice failed; its state");
  const auto values = ctx.Kafka.Values(kHEventsTopic);
  ctx.Equal(values.size(), 1, "a declined charge must be published: the ledger needs the failure too; the records");
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(hEventsField(event, "state") == "failed" && hEventsField(event, "reason") == "card_declined" && hEventsField(event, "invoice_id") == invoice.invoice_id,
             "the event is %s, expected state failed with reason card_declined for %s", values[0], invoice.invoice_id);
  ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), {"sub_1"}, "the failure's record must be keyed by the subscription id");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kHEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  recordOutcome(hEventsInvoice(), kHEventsCharged);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  recordOutcome(hEventsInvoice(), kHEventsCharged);
  ctx.Settle();
  ctx.Kafka.Failover(kHEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  const store::Invoice healthy = hEventsInvoice();
  bool ok = recordOutcome(healthy, kHEventsCharged);
  ctx.Settle();
  ctx.Assert(ok && hEventsOutbox(ctx).empty(), "a delivery the broker acknowledged returned %t and left %d outbox row(s): return true and keep no row", ok,
             hEventsOutbox(ctx).size());
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  const store::Invoice first = hEventsInvoice();
  ok = recordOutcome(first, kHEventsCharged);
  ctx.Settle();
  auto rows = hEventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the ledger never hears of the charge; the rows");
  ctx.Assert(hEventsField(rows[0], "topic") == kHEventsTopic && hEventsField(rows[0], "key") == "sub_1" && rows[0].contains("payload") &&
                 hEventsField(rows[0]["payload"], "invoice_id") == first.invoice_id,
             "the outbox row is %s, expected the topic, the key sub_1 and the event", rows[0].dump());
  const nlohmann::json& payload = rows[0]["payload"];
  ctx.Assert(hEventsField(payload, "subscription_id") == "sub_1" && hEventsField(payload, "state") == "charged" && hEventsField(payload, "reference") == "ch_1",
             "the outbox payload is %s, expected the event the broker did not take (state charged, reference ch_1), which the relay publishes as is", payload.dump());
  ctx.Equal(ok, false, "recordOutcome's result after a failed delivery");
  ctx.Equal(store::findInvoice(first.invoice_id)->state, "charged", "the invoice must stay charged when only the produce failed; its state");
  ctx.Kafka.Stall(kHEventsTopic);  // the broker stops answering
  const store::Invoice second = hEventsInvoice();
  const int64_t before = ctx.Clock.Now();
  ok = recordOutcome(second, kHEventsCharged);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "recordOutcome waited %.1f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = hEventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && hEventsField(rows[1]["payload"], "invoice_id") == second.invoice_id,
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "recordOutcome's result without a delivery report");
}
`,
  },
  hints: [
    "The ledger shows one subscription's March invoice after its April one, never shows a declined card, and after a broker restart is missing a charge the billing store has.",
    'Partition order holds per key, and the key is the tenant; the produce runs before the store write and is not awaited; a failure returns before producing; the producer has `acks=1` and no idempotence.',
    'Mark the invoice first (`mark_charged` or `mark_failed`), then produce keyed by `subscription_id` with `acks=all` and idempotence; wait for the delivery report at most 2 s and `insert_outbox` otherwise.',
  ],
  debrief: `The key is an ordering contract and the store-then-produce order is a visibility contract: the ledger must be able to read any invoice whose event it holds, and must see one subscription's invoices in the order they were billed. A failure is published because the topic is what the ledger and support read back; a gap reads as "never billed". Waiting for the delivery report gives the return value a meaning, the outbox makes a broker outage a delay rather than a loss, and the idempotent producer closes the gap a retry after a lost acknowledgement opens. Billing platforms usually write the outbox row in the same transaction as the invoice and let a relay do every produce, so the billing run never talks to the broker.`,
};
