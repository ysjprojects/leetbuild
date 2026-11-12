import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'price.changed events keyed by sku, with an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'db', 'kafka', 'relay'],
  task: `## Task

**Starting point.** The starter commits a change the guard reserved and announces it:
\`publish_change(sku, price_cents, reason, reservation)\` produces \`{"sku", "price_cents"}\` on
\`price.changed\` with no key, polls once, then calls \`store.publish(sku, price_cents, reason,
"operator")\` and returns \`True\`. Change a price and an event shows up; it hides five flaws.

**Failure mode the checks target.** One sku's changes land on different partitions and a consumer
replays them out of order; an event announces a price the store never committed; the audit reader
cannot tell what the price was, why it moved or how much of the window it spent; a lost
acknowledgement writes the event twice; and a broker that refuses or stalls loses the event while
the call reports success.

- The record key is the **sku**.
- **Commit first**: \`store.publish\` before the produce. The event carries \`sku\`,
  \`old_price_cents\`, \`new_price_cents\`, \`reason\`, \`updated_at\` and the reservation's \`moved_bp\`
  and \`headroom_bp\`.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go, which has one).
- **Wait for the delivery**, at most \`ACK_TIMEOUT_S\` (2 s); on failure or silence insert the
  event into the outbox (\`outbox.insert(topic, key, payload)\`, provided as \`pricing.outbox\`) and
  return \`False\`.`,
  sequence: {
    participants: ['Pricing API', 'Price store', 'price.changed', 'Outbox relay'],
    messages: [
      {from: 'Pricing API', to: 'Price store', label: 'publish(sku, price, reason, "operator")', kind: 'sync'},
      {from: 'Pricing API', to: 'price.changed', label: 'produce · key = sku · acks = all · idempotent', kind: 'sync'},
      {from: 'price.changed', to: 'Pricing API', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'price.changed', to: 'Pricing API', label: 'failed / no report', kind: 'reply'},
      {from: 'Pricing API', to: 'Outbox relay', label: 'outbox.insert(topic, sku, payload) → False', kind: 'async'},
      {from: 'Outbox relay', to: 'price.changed', label: 'republish once the broker is back', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'sku-key',
      title: 'Keys price.changed by the sku',
      detail:
        "Three changes for SKU-1, SKU-2, SKU-1 carry those keys and the two SKU-1 events share a partition. The starter produces without a key, so one sku's history spreads over every partition.",
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*sku\b/]},
        typescript: {all: [/key:\s*sku\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*sku\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*sku\s*,/]},
        cpp: {all: [/sku\.c_str\(\)\s*,\s*sku\.(size|length)\(\)/]},
      },
    },
    {
      id: 'envelope',
      title: 'Carries both prices, the reason and the window spend',
      detail:
        'The value names `sku`, `old_price_cents`, `new_price_cents`, `reason`, `updated_at`, `moved_bp` and `headroom_bp`, so an audit reader can say what moved, why, and how close the sku is to its limit. The starter sends the sku and the new price.',
      match: {
        python: {all: [/old_price_cents/, /new_price_cents/, /headroom_bp/, /["']reason["']/]},
        typescript: {all: [/old_price_cents/, /new_price_cents/, /headroom_bp/, /reason:/]},
        go: {all: [/"old_price_cents"/, /"new_price_cents"/, /"headroom_bp"/, /"reason"/]},
        scala: {all: [/"old_price_cents"/, /"new_price_cents"/, /"headroom_bp"/, /"reason"/]},
        cpp: {all: [/"old_price_cents"/, /"new_price_cents"/, /"headroom_bp"/, /"reason"/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Commits the price before producing its event',
      detail:
        'While the price row is still the old one the topic is empty: the event follows the commit. The starter produces first, so a failed commit leaves an event for a price nobody charges.',
      match: {
        python: {order: [/def publish_change/, /store\.publish\(/, /producer\.produce\(/]},
        typescript: {order: [/function publishChange/, /await publish\(/, /producer\.send\(/]},
        go: {order: [/func publishChange/, /store\.Publish\(/, /producer\.Produce\(/]},
        scala: {order: [/def publishChange/, /Store\.publish\(/, /producer\.send\(/]},
        cpp: {order: [/bool publishChange/, /store::publish\(/, /producer->produce\(/]},
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
      title: 'Waits for the delivery and falls back to the outbox',
      detail:
        'A failed delivery, or none within 2 s, leaves an outbox row with the topic, the sku and the payload, and the call returns false. The starter polls once and reports success.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|isFailure/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from pricing import outbox, store  # outbox.insert; store.publish

TOPIC = "price.changed"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_change(sku: str, price_cents: int, reason: str, reservation: dict) -> bool:
    """Commit the change the guard reserved and announce it on price.changed; True once the event is on its way."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {"sku": sku, "price_cents": price_cents}
    producer.produce(TOPIC, value=json.dumps(payload))
    producer.poll(0)
    store.publish(sku, price_cents, reason, "operator")
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from pricing import outbox, store  # outbox.insert; store.publish

TOPIC = "price.changed"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def change_event(after: dict, reservation: dict) -> dict:
    """What an audit reader needs: both prices, why, when, and what the change spent of the window."""
    return {
        "sku": after["sku"],
        "old_price_cents": after["previous_price_cents"],
        "new_price_cents": after["price_cents"],
        "reason": after["reason"],
        "updated_at": after["updated_at"],
        "moved_bp": reservation["moved_bp"],
        "headroom_bp": reservation["headroom_bp"],
    }


def publish_change(sku: str, price_cents: int, reason: str, reservation: dict) -> bool:
    """Commit the change the guard reserved and announce it on price.changed; True once the broker acknowledged the event."""
    # The price is durable before its event exists: an event for a price nobody charges is a phantom.
    after = store.publish(sku, price_cents, reason, "operator")
    payload = change_event(after, reservation)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=sku, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the audit trail is late, not short.
        outbox.insert(TOPIC, sku, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Reservation} from 'pricing/guard';
import * as outbox from 'pricing/outbox';
import {publish} from 'pricing/store';

export const TOPIC = 'price.changed';

const kafka = new Kafka({clientId: 'priced', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Commit the change the guard reserved and announce it on price.changed; true once the event is on its way. */
export async function publishChange(sku: string, priceCents: number, reason: string, reservation: Reservation): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {sku, price_cents: priceCents};
  void producer.send({topic: TOPIC, messages: [{value: JSON.stringify(payload)}], acks: 1});
  await publish(sku, priceCents, reason, 'operator');
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import type {Reservation} from 'pricing/guard';
import * as outbox from 'pricing/outbox';
import {type Row, publish} from 'pricing/store';

export const TOPIC = 'price.changed';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'priced', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What an audit reader needs: both prices, why, when, and what the change spent of the window. */
export function changeEvent(after: Row, reservation: Reservation) {
  return {
    sku: after.sku,
    old_price_cents: after.previous_price_cents,
    new_price_cents: after.price_cents,
    reason: after.reason,
    updated_at: after.updated_at,
    moved_bp: reservation.moved_bp,
    headroom_bp: reservation.headroom_bp,
  };
}

/** Commit the change the guard reserved and announce it on price.changed; true once the broker acknowledged the event. */
export async function publishChange(sku: string, priceCents: number, reason: string, reservation: Reservation): Promise<boolean> {
  // The price is durable before its event exists: an event for a price nobody charges is a phantom.
  const after = await publish(sku, priceCents, reason, 'operator');
  const payload = changeEvent(after, reservation);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: sku, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the audit trail is late, not short.
    await outbox.insert(TOPIC, sku, payload);
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

	"pricing/guard" // guard.Reservation
	"pricing/store" // store.Publish
)

const topic = "price.changed"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishChange commits the change the guard reserved and announces it on price.changed; true once
// the event is on its way.
func publishChange(ctx context.Context, sku string, priceCents int64, reason string, reservation guard.Reservation) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(map[string]any{"sku": sku, "price_cents": priceCents})
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	store.Publish(ctx, sku, priceCents, reason, "operator")
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"pricing/guard"  // guard.Reservation
	"pricing/outbox" // outbox.Insert
	"pricing/store"  // store.Publish
)

const (
	topic      = "price.changed"
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

// changeEvent is what an audit reader needs: both prices, why, when, and what the change spent of the window.
func changeEvent(after *store.Row, reservation guard.Reservation) map[string]any {
	return map[string]any{
		"sku":             after.SKU,
		"old_price_cents": after.PreviousPriceCents,
		"new_price_cents": after.PriceCents,
		"reason":          after.Reason,
		"updated_at":      after.UpdatedAt,
		"moved_bp":        reservation.MovedBP,
		"headroom_bp":     reservation.HeadroomBP,
	}
}

// publishChange commits the change the guard reserved and announces it on price.changed; true once
// the broker acknowledged the event.
func publishChange(ctx context.Context, sku string, priceCents int64, reason string, reservation guard.Reservation) (bool, error) {
	// The price is durable before its event exists: an event for a price nobody charges is a phantom.
	after := store.Publish(ctx, sku, priceCents, reason, "operator")
	payload := changeEvent(after, reservation)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(sku), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the audit trail is late, not short.
		if err := outbox.Insert(ctx, topic, sku, payload); err != nil {
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

import pricing.{Guard, Store} // Guard.Reservation; Store.publish

object Events {
  val Topic = "price.changed"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit the change the guard reserved and announce it on price.changed; true once the event is on its way. */
  def publishChange(sku: String, priceCents: Long, reason: String, reservation: Guard.Reservation): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = JsObject("sku" -> JsString(sku), "price_cents" -> JsNumber(priceCents))
    producer.send(new ProducerRecord[String, String](Topic, payload.compactPrint))
    Store.publish(sku, priceCents, reason, "operator")
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

import pricing.{Guard, Outbox, Store} // Guard.Reservation; Outbox.insert; Store.publish

object Events {
  val Topic = "price.changed"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What an audit reader needs: both prices, why, when, and what the change spent of the window. */
  def changeEvent(after: Store.Row, reservation: Guard.Reservation): JsObject =
    JsObject(
      "sku" -> JsString(after.sku),
      "old_price_cents" -> JsNumber(after.previousPriceCents),
      "new_price_cents" -> JsNumber(after.priceCents),
      "reason" -> JsString(after.reason),
      "updated_at" -> JsNumber(after.updatedAt),
      "moved_bp" -> JsNumber(reservation.movedBp),
      "headroom_bp" -> JsNumber(reservation.headroomBp)
    )

  /** Commit the change the guard reserved and announce it on price.changed; true once the broker acknowledged the event. */
  def publishChange(sku: String, priceCents: Long, reason: String, reservation: Guard.Reservation): Boolean = {
    // The price is durable before its event exists: an event for a price nobody charges is a phantom.
    val after = Store.publish(sku, priceCents, reason, "operator")
    val payload = changeEvent(after, reservation)
    val record = new ProducerRecord[String, String](Topic, sku, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the audit trail is late, not short.
      Outbox.insert(Topic, sku, payload)
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

#include "pricing/guard.h"   // guard::Reservation
#include "pricing/outbox.h"  // outbox::insert
#include "pricing/store.h"   // store::publish

using json = nlohmann::json;

const std::string kTopic = "price.changed";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Commit the change the guard reserved and announce it on price.changed; true once the event is on
// its way.
bool publishChange(const std::string& sku, long long price_cents, const std::string& reason, const guard::Reservation& reservation) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string value = json{{"sku", sku}, {"price_cents", price_cents}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), nullptr, 0, 0, nullptr);
  producer->poll(0);
  store::publish(sku, price_cents, reason, "operator");
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "pricing/guard.h"   // guard::Reservation
#include "pricing/outbox.h"  // outbox::insert
#include "pricing/store.h"   // store::publish

using json = nlohmann::json;

const std::string kTopic = "price.changed";
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
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// What an audit reader needs: both prices, why, when, and what the change spent of the window.
json changeEvent(const store::Row& after, const guard::Reservation& reservation) {
  return json{{"sku", after.sku},
              {"old_price_cents", after.previous_price_cents},
              {"new_price_cents", after.price_cents},
              {"reason", after.reason},
              {"updated_at", after.updated_at},
              {"moved_bp", reservation.moved_bp},
              {"headroom_bp", reservation.headroom_bp}};
}

// Commit the change the guard reserved and announce it on price.changed; true once the broker
// acknowledged the event.
bool publishChange(const std::string& sku, long long price_cents, const std::string& reason, const guard::Reservation& reservation) {
  // The price is durable before its event exists: an event for a price nobody charges is a phantom.
  const store::Row after = store::publish(sku, price_cents, reason, "operator");
  const json payload = changeEvent(after, reservation);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), sku.c_str(), sku.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the audit trail is late, not short.
    outbox::insert(kTopic, sku, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from pricing import store

TOPIC = "price.changed"
RESERVED = {"ok": True, "moved_bp": 500, "headroom_bp": 1500, "bound_cents": 1200}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_sku_key(ctx):
    m = ctx.load("events")
    store.seed("SKU-1", 1000)
    store.seed("SKU-2", 2000)
    m.publish_change("SKU-1", 1050, "weekend promo", RESERVED)
    m.publish_change("SKU-2", 2100, "weekend promo", RESERVED)
    m.publish_change("SKU-1", 1100, "weekend promo", RESERVED)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three changes produced {len(records)} records on price.changed (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"SKU-1", b"SKU-2", b"SKU-1"], f"the records are keyed {keys}, expected the skus SKU-1, SKU-2, SKU-1"
    assert records[0].partition == records[2].partition, "both SKU-1 events must land on one partition, or a consumer replays one sku's prices out of order"


def check_envelope(ctx):
    m = ctx.load("events")
    store.seed("SKU-1", 1000)
    m.publish_change("SKU-1", 1050, "competitor match", RESERVED)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one change produced {len(records)} records"
    value = json.loads(records[0].value)
    want = {"sku": "SKU-1", "old_price_cents": 1000, "new_price_cents": 1050, "reason": "competitor match", "moved_bp": 500, "headroom_bp": 1500}
    wrong = {k: value.get(k) for k in want if value.get(k) != want[k]}
    assert not wrong, f"the event is {value}: these fields are missing or wrong {wrong}, expected {want}"
    assert value.get("updated_at") == store.get_sku("SKU-1")["updated_at"], f"the event's updated_at {value.get('updated_at')!r} must be the committed row's"


def check_publish_after_commit(ctx):
    m = ctx.load("events")
    store.seed("SKU-1", 1000)
    seen = []

    def watch():
        # Every command on the price row: what the row holds and how many events are already out.
        seen.append((ctx.redis.hget("price:SKU-1", "price_cents"), len(ctx.kafka.records(TOPIC))))
        ctx.redis_after("price:SKU-1", watch)

    ctx.redis_after("price:SKU-1", watch)
    m.publish_change("SKU-1", 1050, "weekend promo", RESERVED)
    observed = list(seen)
    assert observed, "publish_change never touched price:SKU-1: the change was not committed"
    early = [count for price, count in observed if price == "1000" and count > 0]
    assert not early, f"the event was on price.changed while the row still held 1000 (observed {observed}): an event for a price the store may never commit. Commit first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the commit"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    store.seed("SKU-1", 1000)
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_change("SKU-1", 1050, "weekend promo", RESERVED)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_change("SKU-1", 1100, "weekend promo", RESERVED)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    store.seed("SKU-1", 1000)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_change("SKU-1", 1050, "weekend promo", RESERVED)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the change vanishes from the audit trail"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "SKU-1" and rows[0].get("payload", {}).get("new_price_cents") == 1050, f"the outbox row is {rows[0]}, expected the topic, the key SKU-1 and the payload"
    assert ok is False, f"publish_change returned {ok!r} after a failed delivery, expected False"
    assert store.get_sku("SKU-1")["price_cents"] == 1050, "the price must stay committed when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_change("SKU-1", 1100, "weekend promo", RESERVED)
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_change waited {waited:.0f} s for a broker that does not answer: wait at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("new_price_cents") == 1100, f"no delivery within the window and the outbox holds {rows}"
    assert ok is False, f"publish_change returned {ok!r} without a delivery, expected False"
`,
    typescript: `const TOPIC = 'price.changed';
const RESERVED = {ok: true, moved_bp: 500, headroom_bp: 1500, bound_cents: 1200};

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

function events(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/pricing/store.ts')};
}

export async function check_sku_key(ctx) {
  const {m, store} = events(ctx);
  await store.seed('SKU-1', 1000);
  await store.seed('SKU-2', 2000);
  await m.publishChange('SKU-1', 1050, 'weekend promo', RESERVED);
  await m.publishChange('SKU-2', 2100, 'weekend promo', RESERVED);
  await m.publishChange('SKU-1', 1100, 'weekend promo', RESERVED);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three changes produced \${records.length} records on price.changed\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['SKU-1', 'SKU-2', 'SKU-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the skus SKU-1, SKU-2, SKU-1\`);
  assert.equal(records[0].partition, records[2].partition, "both SKU-1 events must land on one partition, or a consumer replays one sku's prices out of order");
}

export async function check_envelope(ctx) {
  const {m, store} = events(ctx);
  await store.seed('SKU-1', 1000);
  await m.publishChange('SKU-1', 1050, 'competitor match', RESERVED);
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one change produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  const want = {sku: 'SKU-1', old_price_cents: 1000, new_price_cents: 1050, reason: 'competitor match', moved_bp: 500, headroom_bp: 1500};
  const wrong = Object.keys(want).filter(k => value[k] !== want[k]);
  assert.equal(wrong.length, 0, \`the event is \${values[0]}: \${JSON.stringify(wrong)} missing or wrong, expected \${JSON.stringify(want)}\`);
  assert.equal(value.updated_at, (await store.getSku('SKU-1')).updated_at, "the event's updated_at must be the committed row's");
}

export async function check_publish_after_commit(ctx) {
  const {m, store} = events(ctx);
  await store.seed('SKU-1', 1000);
  const seen: [unknown, number][] = [];
  const watch = () => {
    // Every command on the price row: what the row holds and how many events are already out.
    seen.push([ctx.redis.hget('price:SKU-1', 'price_cents'), ctx.kafka.records(TOPIC).length]);
    ctx.redisAfter('price:SKU-1', watch);
  };
  ctx.redisAfter('price:SKU-1', watch);
  await m.publishChange('SKU-1', 1050, 'weekend promo', RESERVED);
  await settle();
  const observed = [...seen];
  assert(observed.length > 0, 'publishChange never touched price:SKU-1: the change was not committed');
  const early = observed.filter(([price, count]) => price === '1000' && count > 0);
  assert.equal(early.length, 0, \`the event was on price.changed while the row still held 1000 (observed \${JSON.stringify(observed)}): an event for a price the store may never commit. Commit first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the commit');
}

export async function check_acks_idempotent(ctx) {
  const {m, store} = events(ctx);
  await store.seed('SKU-1', 1000);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishChange('SKU-1', 1050, 'weekend promo', RESERVED);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishChange('SKU-1', 1100, 'weekend promo', RESERVED);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, store} = events(ctx);
  await store.seed('SKU-1', 1000);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishChange('SKU-1', 1050, 'weekend promo', RESERVED);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the change vanishes from the audit trail\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'SKU-1' && rows[0].payload?.new_price_cents === 1050, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key SKU-1 and the payload\`);
  assert.equal(ok, false, \`publishChange resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal((await store.getSku('SKU-1')).price_cents, 1050, 'the price must stay committed when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishChange('SKU-1', 1100, 'weekend promo', RESERVED);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishChange waited \${waited.toFixed(0)} s for a broker that does not answer: wait at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.new_price_cents === 1100, \`no delivery within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishChange resolved \${JSON.stringify(ok)} without a delivery, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"pricing/guard"
	"pricing/store"

	"leetbuild/harness"
)

const eventsTopic = "price.changed"

var (
	eventsBg = context.Background()
	reserved = guard.Reservation{OK: true, MovedBP: 500, HeadroomBP: 1500, BoundCents: 1200}
)

func change(ctx *harness.Ctx, sku string, priceCents int64, reason string) bool {
	ok, err := publishChange(eventsBg, sku, priceCents, reason, reserved)
	ctx.NoError(err, "publishChange(%s, %d)", sku, priceCents)
	return ok
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxRows(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckSkuKey(ctx *harness.Ctx) {
	store.Seed(eventsBg, "SKU-1", 1000)
	store.Seed(eventsBg, "SKU-2", 2000)
	change(ctx, "SKU-1", 1050, "weekend promo")
	change(ctx, "SKU-2", 2100, "weekend promo")
	change(ctx, "SKU-1", 1100, "weekend promo")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three changes must produce three records on price.changed; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"SKU-1", "SKU-2", "SKU-1"}, "the records must be keyed by the skus")
	ctx.Equal(records[0].Partition, records[2].Partition, "both SKU-1 events must land on one partition, or a consumer replays one sku's prices out of order; the partitions")
}

func CheckEnvelope(ctx *harness.Ctx) {
	store.Seed(eventsBg, "SKU-1", 1000)
	change(ctx, "SKU-1", 1050, "competitor match")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one change must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the event must be JSON")
	want := map[string]any{"sku": "SKU-1", "old_price_cents": 1000.0, "new_price_cents": 1050.0, "reason": "competitor match", "moved_bp": 500.0, "headroom_bp": 1500.0}
	for k, v := range want {
		ctx.Assert(value[k] == v, "the event is %s: %s is %v, expected %v", values[0], k, value[k], v)
	}
	ctx.Equal(value["updated_at"], float64(store.GetSKU(eventsBg, "SKU-1").UpdatedAt), "the event's updated_at must be the committed row's")
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	store.Seed(eventsBg, "SKU-1", 1000)
	type observation struct {
		price  string
		events int
	}
	var seen []observation
	var watch func() any
	watch = func() any {
		// Every command on the price row: what the row holds and how many events are already out.
		price, _ := ctx.Redis.HGet("price:SKU-1", "price_cents")
		seen = append(seen, observation{price, len(ctx.Kafka.Records(eventsTopic))})
		ctx.Redis.After("price:SKU-1", watch)
		return nil
	}
	ctx.Redis.After("price:SKU-1", watch)
	change(ctx, "SKU-1", 1050, "weekend promo")
	ctx.Settle()
	observed := append([]observation(nil), seen...)
	ctx.Assert(len(observed) > 0, "publishChange never touched price:SKU-1: the change was not committed")
	for _, o := range observed {
		ctx.Assert(!(o.price == "1000" && o.events > 0), "the event was on price.changed while the row still held 1000 (observed %+v): an event for a price the store may never commit. Commit first, then produce", observed)
	}
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the commit; the records")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	store.Seed(eventsBg, "SKU-1", 1000)
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	change(ctx, "SKU-1", 1050, "weekend promo")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	change(ctx, "SKU-1", 1100, "weekend promo")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	store.Seed(eventsBg, "SKU-1", 1000)
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := change(ctx, "SKU-1", 1050, "weekend promo")
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the change vanishes from the audit trail; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "SKU-1" && rows[0].Payload["new_price_cents"] == 1050.0, "the outbox row is %+v, expected the topic, the key SKU-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishChange's result after a failed delivery")
	ctx.Equal(store.GetSKU(eventsBg, "SKU-1").PriceCents, int64(1050), "the price must stay committed when only the produce failed")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = change(ctx, "SKU-1", 1100, "weekend promo")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishChange waited %.0f s for a broker that does not answer: wait at most 2 s, then write the outbox row", waited)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["new_price_cents"] == 1100.0, "no delivery within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "publishChange's result without a delivery")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "pricing/guard.h"
#include "pricing/store.h"

namespace {

const std::string kEventsTopic = "price.changed";
const guard::Reservation kReserved{true, 500, 1500, 1200};

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

long long number(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_number() ? j[field].get<long long>() : -1;
}

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckSkuKey(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  store::seed("SKU-2", 2000);
  publishChange("SKU-1", 1050, "weekend promo", kReserved);
  publishChange("SKU-2", 2100, "weekend promo", kReserved);
  publishChange("SKU-1", 1100, "weekend promo", kReserved);
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three changes must produce three records on price.changed; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"SKU-1", "SKU-2", "SKU-1"}, "the records must be keyed by the skus");
  ctx.Equal(records[0].Partition, records[2].Partition, "both SKU-1 events must land on one partition, or a consumer replays one sku's prices out of order; the partitions");
}

void CheckEnvelope(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  publishChange("SKU-1", 1050, "competitor match", kReserved);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one change must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(text(value, "sku") == "SKU-1" && number(value, "old_price_cents") == 1000 && number(value, "new_price_cents") == 1050 &&
                 text(value, "reason") == "competitor match" && number(value, "moved_bp") == 500 && number(value, "headroom_bp") == 1500,
             "the event is %s, expected sku SKU-1, old_price_cents 1000, new_price_cents 1050, reason, moved_bp 500 and headroom_bp 1500", values[0]);
  ctx.Equal(number(value, "updated_at"), store::getSku("SKU-1")->updated_at, "the event's updated_at must be the committed row's");
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  auto seen = std::make_shared<std::vector<std::pair<std::string, size_t>>>();
  auto watch = std::make_shared<std::function<void()>>();
  *watch = [&ctx, seen, watch] {
    // Every command on the price row: what the row holds and how many events are already out.
    seen->emplace_back(ctx.Redis.HGet("price:SKU-1", "price_cents").value_or(""), ctx.Kafka.Records(kEventsTopic).size());
    ctx.Redis.After("price:SKU-1", [watch] { (*watch)(); });
  };
  ctx.Redis.After("price:SKU-1", [watch] { (*watch)(); });
  publishChange("SKU-1", 1050, "weekend promo", kReserved);
  ctx.Settle();
  const auto observed = *seen;
  ctx.Assert(!observed.empty(), "publishChange never touched price:SKU-1: the change was not committed");
  for (const auto& [price, events] : observed) {
    ctx.Assert(!(price == "1000" && events > 0), "the event was on price.changed while the row still held 1000: an event for a price the store may never commit. Commit first, then produce");
  }
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the commit; the records");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishChange("SKU-1", 1050, "weekend promo", kReserved);
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishChange("SKU-1", 1100, "weekend promo", kReserved);
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishChange("SKU-1", 1050, "weekend promo", kReserved);
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the change vanishes from the audit trail; the rows");
  ctx.Assert(text(rows[0], "topic") == kEventsTopic && text(rows[0], "key") == "SKU-1" && rows[0].contains("payload") && number(rows[0]["payload"], "new_price_cents") == 1050,
             "the outbox row is %s, expected the topic, the key SKU-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishChange's result after a failed delivery");
  ctx.Equal(store::getSku("SKU-1")->price_cents, 1050, "the price must stay committed when only the produce failed");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishChange("SKU-1", 1100, "weekend promo", kReserved);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishChange waited %.0f s for a broker that does not answer: wait at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && number(rows[1]["payload"], "new_price_cents") == 1100, "no delivery within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishChange's result without a delivery");
}
`,
  },
  hints: [
    'Change one sku twice and watch the partitions: its two events sit on two of them. Take the broker down and change a price: the call reports success and the event is nowhere, not even in the outbox.',
    'A record without a key goes to any partition, so nothing orders one sku. The produce runs before `store.publish` and is never waited on, so its outcome, and a commit failing after it, go unseen.',
    '`store.publish` first; produce `change_event(after, reservation)` with `key=sku` on an idempotent `acks=all` producer and an `on_delivery` callback; `flush(ACK_TIMEOUT_S)`; still in flight or an error → `outbox.insert(TOPIC, sku, payload)`, return False.',
  ],
  debrief: `The sku key is an ordering contract and commit-then-produce is a visibility contract: a consumer replaying one sku sees its prices in order, and every event it holds names a price the store committed. Waiting for the delivery report is what gives the return value a meaning, and the outbox turns a broker outage into a late audit entry instead of a missing one. The idempotent producer closes the gap that waiting opens, a retry after a lost acknowledgement. Production pricing systems write the outbox row in the same transaction as the price, so a crash between the two cannot lose either, and run the relay as its own process that drains rows in order per sku.`,
};
