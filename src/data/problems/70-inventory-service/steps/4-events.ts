import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Stock movements keyed by sku, with a signed delta and an outbox',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'ledger', 'db'],
  task: `## Task

**Starting point.** The starter is \`publish_movement(reservation, reason)\`, called after each reserve,
confirm and release: it produces \`{sku, reservation_id, reason, quantity, delta}\` to
\`inventory.event\`, keyed by the reservation id, from a producer with \`acks=1\`, with \`delta\` set to
the quantity, and writes an outbox row if \`produce\` raises. It serves the demo and hides four flaws.

**Failure mode the checks target.** Two reservations of one sku landing on two partitions, a ledger
that adds the units a reservation took away, a broker that lost an acknowledgement or its leader,
and a delivery that fails after \`produce\` returned.

- The record key is the **sku**: Kafka orders per partition, so one sku's movements must share one.
- \`delta\` is the signed change to the sku's available units: \`DELTA_SIGN\` maps \`reserved\` to -1,
  \`confirmed\` to 0 and \`released\` to +1, times the quantity.
- The producer is **idempotent** with **\`acks=all\`**.
- **Wait for the delivery report**, at most 2 s. When it fails or does not come, insert an **outbox**
  row (\`outbox.insert(topic, key, payload)\`) and return \`False\`; \`produce\` raising covers only the
  local queue.`,
  sequence: {
    participants: ['Inventory API', 'Kafka inventory.event', 'Outbox', 'Ledger consumer'],
    messages: [
      {
        from: 'Inventory API',
        to: 'Kafka inventory.event',
        label: 'produce key = sku · {reason, quantity, delta} · acks=all',
        kind: 'sync',
      },
      {from: 'Kafka inventory.event', to: 'Inventory API', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Kafka inventory.event', to: 'Inventory API', label: 'failed / no report', kind: 'reply'},
      {from: 'Inventory API', to: 'Outbox', label: 'insert(topic, sku, payload) → False', kind: 'async'},
      {
        from: 'Kafka inventory.event',
        to: 'Ledger consumer',
        label: 'one partition per sku: deltas in order',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'sku-key',
      title: 'Keys inventory.event by the sku',
      detail:
        'Three movements for sku-1, sku-2, sku-1 carry those keys and both sku-1 records share a partition. The starter keys by reservation id, which spreads one sku over every partition.',
      match: {
        python: {all: [/producer\.produce\(\s*[^\n]*key\s*=\s*reservation\[["']sku["']\]/]},
        typescript: {all: [/key:\s*reservation\.sku\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*(r|reservation)\.SKU\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"inventory\.event")\s*,\s*reservation\.sku\s*,/]},
        cpp: {all: [/(r|reservation)\.sku\.c_str\(\)\s*,\s*(r|reservation)\.sku\.(size|length)\(\)/]},
      },
    },
    {
      id: 'signed-delta',
      title: 'Carries the signed change to available units',
      detail:
        'A reservation of 3 publishes `delta` -3, its release +3 and its confirmation 0, so a ledger folding deltas rebuilds the counter. The starter publishes +3 for every reason.',
      match: {
        python: {all: [/["']reserved["']\s*:\s*-1/, /["']released["']\s*:\s*\+?1\b/]},
        typescript: {all: [/reserved:\s*-1/, /released:\s*\+?1\b/]},
        go: {all: [/"reserved":\s*-1/, /"released":\s*\+?1\b/]},
        scala: {all: [/"reserved"\s*->\s*-1/, /"released"\s*->\s*\+?1\b/]},
        cpp: {all: [/\{\s*"reserved"\s*,\s*-1\s*\}/, /\{\s*"released"\s*,\s*\+?1\s*\}/]},
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
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the sku and the payload, and the call returns false. The starter only catches errors raised by `produce` itself, which covers the local queue and nothing the broker does.',
      match: {
        python: {
          all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/], none: [/void producer\.send\(/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {
          all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/],
          none: [/case\s+_?\w*\s*:\s*KafkaException/],
        },
        cpp: {all: [/outbox::Insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from inventory.store import outbox

TOPIC = "inventory.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def movement(reservation: dict, reason: str) -> dict:
    """The event a ledger folds: which sku moved, why, and by how much."""
    return {
        "sku": reservation["sku"],
        "reservation_id": reservation["reservation_id"],
        "reason": reason,
        "quantity": reservation["quantity"],
        "delta": reservation["quantity"],
    }


def publish_movement(reservation: dict, reason: str) -> bool:
    """Tell the ledger how the sku's available units moved; True once the event is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = movement(reservation, reason)
    try:
        producer.produce(TOPIC, key=reservation["reservation_id"], value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        outbox.insert(TOPIC, reservation["reservation_id"], payload)
        return False
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from inventory.store import outbox

TOPIC = "inventory.event"
ACK_TIMEOUT_S = 2
# The change to the sku's available units: a reservation takes them, a release gives them back, a
# confirmation turns a hold into a sale without touching the available count.
DELTA_SIGN = {"reserved": -1, "confirmed": 0, "released": 1}

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def movement(reservation: dict, reason: str) -> dict:
    """The event a ledger folds: which sku moved, why, and by how much."""
    return {
        "sku": reservation["sku"],
        "reservation_id": reservation["reservation_id"],
        "reason": reason,
        "quantity": reservation["quantity"],
        "delta": DELTA_SIGN[reason] * reservation["quantity"],
    }


def publish_movement(reservation: dict, reason: str) -> bool:
    """Tell the ledger how the sku's available units moved; True once the broker acknowledged it."""
    payload = movement(reservation, reason)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # Keyed by sku: one sku's movements share a partition, so the ledger folds them in order.
    producer.produce(TOPIC, key=reservation["sku"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
        outbox.insert(TOPIC, reservation["sku"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Reservation, outbox} from 'inventory/store';

export const TOPIC = 'inventory.event';

const kafka = new Kafka({clientId: 'inventoryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** The event a ledger folds: which sku moved, why, and by how much. */
export function movement(reservation: Reservation, reason: string) {
  return {
    sku: reservation.sku,
    reservation_id: reservation.reservation_id,
    reason,
    quantity: reservation.quantity,
    delta: reservation.quantity,
  };
}

/** Tell the ledger how the sku's available units moved; true once the event is on its way. */
export async function publishMovement(reservation: Reservation, reason: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = movement(reservation, reason);
  try {
    void producer.send({topic: TOPIC, messages: [{key: reservation.reservation_id, value: JSON.stringify(payload)}], acks: 1});
  } catch {
    await outbox.insert(TOPIC, reservation.reservation_id, payload);
    return false;
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Reservation, outbox} from 'inventory/store';

export const TOPIC = 'inventory.event';
export const ACK_TIMEOUT_MS = 2000;
// The change to the sku's available units: a reservation takes them, a release gives them back, a
// confirmation turns a hold into a sale without touching the available count.
export const DELTA_SIGN: Record<string, number> = {reserved: -1, confirmed: 0, released: 1};

const kafka = new Kafka({clientId: 'inventoryd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** The event a ledger folds: which sku moved, why, and by how much. */
export function movement(reservation: Reservation, reason: string) {
  return {
    sku: reservation.sku,
    reservation_id: reservation.reservation_id,
    reason,
    quantity: reservation.quantity,
    delta: DELTA_SIGN[reason] * reservation.quantity,
  };
}

/** Tell the ledger how the sku's available units moved; true once the broker acknowledged it. */
export async function publishMovement(reservation: Reservation, reason: string): Promise<boolean> {
  const payload = movement(reservation, reason);
  try {
    // Keyed by sku: one sku's movements share a partition, so the ledger folds them in order.
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: reservation.sku, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
    await outbox.insert(TOPIC, reservation.sku, payload);
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

	"inventory/store"
)

const topic = "inventory.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// movement is the event a ledger folds: which sku moved, why, and by how much.
func movement(r *store.Reservation, reason string) map[string]any {
	return map[string]any{
		"sku":            r.SKU,
		"reservation_id": r.ReservationID,
		"reason":         reason,
		"quantity":       r.Quantity,
		"delta":          r.Quantity,
	}
}

// publishMovement tells the ledger how the sku's available units moved; true once the event is on its way.
func publishMovement(ctx context.Context, r *store.Reservation, reason string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := movement(r, reason)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(r.ReservationID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.InsertOutbox(ctx, topic, r.ReservationID, payload)
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

	"inventory/store"
)

const (
	topic      = "inventory.event"
	ackTimeout = 2 * time.Second
)

// deltaSign is the change to the sku's available units: a reservation takes them, a release gives
// them back, a confirmation turns a hold into a sale without touching the available count.
var deltaSign = map[string]int{"reserved": -1, "confirmed": 0, "released": 1}

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

// movement is the event a ledger folds: which sku moved, why, and by how much.
func movement(r *store.Reservation, reason string) map[string]any {
	return map[string]any{
		"sku":            r.SKU,
		"reservation_id": r.ReservationID,
		"reason":         reason,
		"quantity":       r.Quantity,
		"delta":          deltaSign[reason] * r.Quantity,
	}
}

// publishMovement tells the ledger how the sku's available units moved; true once the broker acknowledged it.
func publishMovement(ctx context.Context, r *store.Reservation, reason string) (bool, error) {
	payload := movement(r, reason)
	value, _ := json.Marshal(payload)
	t := topic
	// Keyed by sku: one sku's movements share a partition, so the ledger folds them in order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(r.SKU), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
		return false, store.InsertOutbox(ctx, topic, r.SKU, payload)
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

import inventory.{Reservation, Store}

object Events {
  val Topic = "inventory.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** The event a ledger folds: which sku moved, why, and by how much. */
  def movement(reservation: Reservation, reason: String): JsObject =
    JsObject(
      "sku" -> JsString(reservation.sku),
      "reservation_id" -> JsString(reservation.reservation_id),
      "reason" -> JsString(reason),
      "quantity" -> JsNumber(reservation.quantity),
      "delta" -> JsNumber(reservation.quantity)
    )

  /** Tell the ledger how the sku's available units moved; true once the event is on its way. */
  def publishMovement(reservation: Reservation, reason: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = movement(reservation, reason)
    try {
      producer.send(new ProducerRecord[String, String](Topic, reservation.reservation_id, payload.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Store.insertOutbox(Topic, reservation.reservation_id, payload)
        false
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import inventory.{Reservation, Store}

object Events {
  val Topic = "inventory.event"
  val AckTimeoutMs = 2000L
  // The change to the sku's available units: a reservation takes them, a release gives them back, a
  // confirmation turns a hold into a sale without touching the available count.
  val DeltaSign: Map[String, Int] = Map("reserved" -> -1, "confirmed" -> 0, "released" -> 1)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** The event a ledger folds: which sku moved, why, and by how much. */
  def movement(reservation: Reservation, reason: String): JsObject =
    JsObject(
      "sku" -> JsString(reservation.sku),
      "reservation_id" -> JsString(reservation.reservation_id),
      "reason" -> JsString(reason),
      "quantity" -> JsNumber(reservation.quantity),
      "delta" -> JsNumber(DeltaSign(reason) * reservation.quantity)
    )

  /** Tell the ledger how the sku's available units moved; true once the broker acknowledged it. */
  def publishMovement(reservation: Reservation, reason: String): Boolean = {
    val payload = movement(reservation, reason)
    // Keyed by sku: one sku's movements share a partition, so the ledger folds them in order.
    val record = new ProducerRecord[String, String](Topic, reservation.sku, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
      Store.insertOutbox(Topic, reservation.sku, payload)
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

#include "inventory/store.h"  // inventory::Reservation, outbox::Insert

using json = nlohmann::json;

const std::string kTopic = "inventory.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// The event a ledger folds: which sku moved, why, and by how much.
json movement(const inventory::Reservation& r, const std::string& reason) {
  return json{{"sku", r.sku}, {"reservation_id", r.reservation_id}, {"reason", reason}, {"quantity", r.quantity}, {"delta", r.quantity}};
}

// Tell the ledger how the sku's available units moved; true once the event is on its way.
bool publishMovement(const inventory::Reservation& r, const std::string& reason) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = movement(r, reason);
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), r.reservation_id.c_str(), r.reservation_id.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    inventory::outbox::Insert(kTopic, r.reservation_id, payload);
    return false;
  }
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <string>

#include "inventory/store.h"  // inventory::Reservation, outbox::Insert

using json = nlohmann::json;

const std::string kTopic = "inventory.event";
constexpr int kAckTimeoutMs = 2000;
// The change to the sku's available units: a reservation takes them, a release gives them back, a
// confirmation turns a hold into a sale without touching the available count.
const std::map<std::string, int> kDeltaSign = {{"reserved", -1}, {"confirmed", 0}, {"released", 1}};

// The delivery report of the record in flight: publishMovement produces one record and waits for it.
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

// The event a ledger folds: which sku moved, why, and by how much.
json movement(const inventory::Reservation& r, const std::string& reason) {
  return json{{"sku", r.sku},
              {"reservation_id", r.reservation_id},
              {"reason", reason},
              {"quantity", r.quantity},
              {"delta", kDeltaSign.at(reason) * r.quantity}};
}

// Tell the ledger how the sku's available units moved; true once the broker acknowledged it.
bool publishMovement(const inventory::Reservation& r, const std::string& reason) {
  const json payload = movement(r, reason);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // Keyed by sku: one sku's movements share a partition, so the ledger folds them in order.
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), r.sku.c_str(), r.sku.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
    inventory::outbox::Insert(kTopic, r.sku, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "inventory.event"


def _reservation(n, sku="sku-1", quantity=3):
    return {
        "reservation_id": f"r-{n}",
        "tenant": "t1",
        "idempotency_key": f"k-{n}",
        "sku": sku,
        "quantity": quantity,
        "status": "reserved",
        "expires_at": 0,
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_sku_key(ctx):
    m = ctx.load("events")
    m.publish_movement(_reservation(1, "sku-1"), "reserved")
    m.publish_movement(_reservation(2, "sku-2"), "reserved")
    m.publish_movement(_reservation(3, "sku-1"), "reserved")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_movement calls produced {len(records)} records on inventory.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"sku-1", b"sku-2", b"sku-1"], f"the records are keyed {keys}, expected the skus sku-1, sku-2, sku-1"
    assert records[0].partition == records[2].partition, "both sku-1 movements must land on one partition, or the ledger folds one sku's deltas out of order"


def check_signed_delta(ctx):
    m = ctx.load("events")
    for reason in ("reserved", "released", "confirmed"):
        m.publish_movement(_reservation(1), reason)
    values = [json.loads(v) for v in ctx.kafka.values(TOPIC)]
    assert len(values) == 3, f"three publish_movement calls produced {len(values)} records"
    first = values[0]
    assert first.get("sku") == "sku-1" and first.get("reservation_id") == "r-1" and first.get("reason") == "reserved" and first.get("quantity") == 3, f"the payload is {first}, expected sku, reservation_id, reason and quantity"
    deltas = [v.get("delta") for v in values]
    assert deltas == [-3, 3, 0], f"reserved, released and confirmed 3 units published deltas {deltas}, expected [-3, 3, 0]: a ledger folding these must land on the counter"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_movement(_reservation(1), "reserved")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the movement twice and the ledger takes the units twice. Enable idempotence"
    m.publish_movement(_reservation(2), "reserved")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_movement(_reservation(1), "reserved")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the ledger never learns these units moved"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "sku-1" and rows[0].get("payload", {}).get("reservation_id") == "r-1", f"the outbox row is {rows[0]}, expected the topic, the key sku-1 and the payload"
    assert ok is False, f"publish_movement returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_movement(_reservation(2), "reserved")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_movement waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("reservation_id") == "r-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_movement returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'inventory.event';

const reservation = (n: number, sku = 'sku-1', quantity = 3) => ({
  reservation_id: \`r-\${n}\`,
  tenant: 't1',
  idempotency_key: \`k-\${n}\`,
  sku,
  quantity,
  status: 'reserved',
  expires_at: 0,
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_sku_key(ctx) {
  const m = ctx.load('events');
  await m.publishMovement(reservation(1, 'sku-1'), 'reserved');
  await m.publishMovement(reservation(2, 'sku-2'), 'reserved');
  await m.publishMovement(reservation(3, 'sku-1'), 'reserved');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishMovement calls produced \${records.length} records on inventory.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['sku-1', 'sku-2', 'sku-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the skus sku-1, sku-2, sku-1\`);
  assert.equal(records[0].partition, records[2].partition, "both sku-1 movements must land on one partition, or the ledger folds one sku's deltas out of order");
}

export async function check_signed_delta(ctx) {
  const m = ctx.load('events');
  for (const reason of ['reserved', 'released', 'confirmed']) await m.publishMovement(reservation(1), reason);
  await settle();
  const values = ctx.kafka.values(TOPIC).map(v => JSON.parse(v));
  assert.equal(values.length, 3, \`three publishMovement calls produced \${values.length} records\`);
  const first = values[0];
  assert(first.sku === 'sku-1' && first.reservation_id === 'r-1' && first.reason === 'reserved' && first.quantity === 3, \`the payload is \${JSON.stringify(first)}, expected sku, reservation_id, reason and quantity\`);
  const deltas = values.map(v => v.delta);
  assert.deepEqual(deltas, [-3, 3, 0], \`reserved, released and confirmed 3 units published deltas \${JSON.stringify(deltas)}, expected [-3, 3, 0]: a ledger folding these must land on the counter\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishMovement(reservation(1), 'reserved');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the movement twice and the ledger takes the units twice. Enable idempotence\`);
  await m.publishMovement(reservation(2), 'reserved');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishMovement(reservation(1), 'reserved');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the ledger never learns these units moved\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'sku-1' && rows[0].payload?.reservation_id === 'r-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key sku-1 and the payload\`);
  assert.equal(ok, false, \`publishMovement resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishMovement(reservation(2), 'reserved');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishMovement waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.reservation_id === 'r-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishMovement resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"

	"inventory/store"
)

const eventsTopic = "inventory.event"

func eventsReservation(n int, sku string) *store.Reservation {
	return &store.Reservation{
		ReservationID: fmt.Sprintf("r-%d", n), Tenant: "t1", IdempotencyKey: fmt.Sprintf("k-%d", n),
		SKU: sku, Quantity: 3, Status: "reserved",
	}
}

func eventsPublish(ctx *harness.Ctx, r *store.Reservation, reason string) bool {
	ok, err := publishMovement(context.Background(), r, reason)
	ctx.NoError(err, "publishMovement")
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

func CheckSkuKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsReservation(1, "sku-1"), "reserved")
	eventsPublish(ctx, eventsReservation(2, "sku-2"), "reserved")
	eventsPublish(ctx, eventsReservation(3, "sku-1"), "reserved")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishMovement calls must produce three records on inventory.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"sku-1", "sku-2", "sku-1"}, "the records must be keyed by the skus")
	ctx.Equal(records[0].Partition, records[2].Partition, "both sku-1 movements must land on one partition, or the ledger folds one sku's deltas out of order; the partitions")
}

func CheckSignedDelta(ctx *harness.Ctx) {
	for _, reason := range []string{"reserved", "released", "confirmed"} {
		eventsPublish(ctx, eventsReservation(1, "sku-1"), reason)
	}
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 3, "three publishMovement calls must produce three records; the records")
	var deltas []float64
	for i, text := range values {
		var value map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &value), "the payload must be JSON")
		if i == 0 {
			ctx.Assert(value["sku"] == "sku-1" && value["reservation_id"] == "r-1" && value["reason"] == "reserved" && value["quantity"] == float64(3), "the payload is %s, expected sku, reservation_id, reason and quantity", text)
		}
		delta, _ := value["delta"].(float64)
		deltas = append(deltas, delta)
	}
	ctx.Equal(deltas, []float64{-3, 3, 0}, "the deltas of reserved, released and confirmed 3 units (a ledger folding these must land on the counter)")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsReservation(1, "sku-1"), "reserved")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the movement twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsReservation(2, "sku-1"), "reserved")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsReservation(1, "sku-1"), "reserved")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the ledger never learns these units moved; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "sku-1" && rows[0].Payload["reservation_id"] == "r-1", "the outbox row is %v, expected the topic, the key sku-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishMovement's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsReservation(2, "sku-1"), "reserved")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishMovement waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["reservation_id"] == "r-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishMovement's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "inventory/store.h"

namespace {

const std::string kEventsTopic = "inventory.event";

inventory::Reservation eventsReservation(int n, const std::string& sku = "sku-1") {
  return inventory::Reservation{"r-" + std::to_string(n), "t1", "k-" + std::to_string(n), sku, 3, "reserved", 0};
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

void CheckSkuKey(harness::Ctx& ctx) {
  publishMovement(eventsReservation(1, "sku-1"), "reserved");
  publishMovement(eventsReservation(2, "sku-2"), "reserved");
  publishMovement(eventsReservation(3, "sku-1"), "reserved");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishMovement calls must produce three records on inventory.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"sku-1", "sku-2", "sku-1"}, "the records must be keyed by the skus");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both sku-1 movements must land on one partition, or the ledger folds one sku's deltas out of order; the partitions");
}

void CheckSignedDelta(harness::Ctx& ctx) {
  for (const std::string reason : {"reserved", "released", "confirmed"}) publishMovement(eventsReservation(1), reason);
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 3, "three publishMovement calls must produce three records; the records");
  std::vector<long long> deltas;
  for (size_t i = 0; i < values.size(); i++) {
    const auto value = nlohmann::json::parse(values[i], nullptr, false);
    if (i == 0) {
      ctx.Assert(eventsField(value, "sku") == "sku-1" && eventsField(value, "reservation_id") == "r-1" &&
                     eventsField(value, "reason") == "reserved" && value.value("quantity", 0) == 3,
                 "the payload is %s, expected sku, reservation_id, reason and quantity", values[i]);
    }
    deltas.push_back(value.is_object() ? value.value("delta", 99LL) : 99LL);
  }
  ctx.Equal(deltas, {-3, 3, 0}, "the deltas of reserved, released and confirmed 3 units (a ledger folding these must land on the counter)");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishMovement(eventsReservation(1), "reserved");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the movement twice (enable.idempotence); the records");
  publishMovement(eventsReservation(2), "reserved");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2,
            "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishMovement(eventsReservation(1), "reserved");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the ledger never learns these units moved; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "sku-1" &&
                 rows[0].contains("payload") && eventsField(rows[0]["payload"], "reservation_id") == "r-1",
             "the outbox row is %s, expected the topic, the key sku-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishMovement's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishMovement(eventsReservation(2), "reserved");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishMovement waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "reservation_id") == "r-2",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishMovement's result without a delivery report");
}
`,
  },
  hints: [
    "The ledger shows a sku with more units than the warehouse ever received, the same sku's movements arrive out of order, and after a broker restart one reservation never reached the ledger at all.",
    "Order holds per key, so whatever is the key is what stays ordered. A positive delta for a reservation adds units instead of taking them. `produce` only queues the record: the broker's verdict arrives later in the delivery report, which nothing here waits for.",
    'Key by `reservation["sku"]`; `delta = DELTA_SIGN[reason] * quantity`; `acks=all` and `enable.idempotence`; pass `on_delivery`, `flush(2)`, and on a remaining message or an error insert the outbox row and return False.',
  ],
  debrief: `The key is an ordering contract: a ledger folding deltas must see one sku's movements in the order they happened, and Kafka promises order only within a partition. The signed delta is what makes the stream rebuildable: start from a count, fold every event, land on the counter. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay instead of a gap in the ledger; the idempotent producer closes the one hole that waiting opens, a retry after a lost acknowledgement. Production services write the outbox row in the same transaction as the state change and let a relay do every produce, so the request path never waits on the broker, and they version the event schema so a new field cannot break an old consumer.`,
};
