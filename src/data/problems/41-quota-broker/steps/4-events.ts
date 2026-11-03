import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Quota events keyed by team, with amounts not identities',
  concept: 'kafka',
  file: 'events',
  focus: ['broker', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is \`publish_quota_event(kind, reservation)\`, called when a
reservation is \`reserved\`, \`released\` or \`consumed\`: a producer built at boot with \`acks=1\`
produces \`{"kind", **reservation}\` to \`quota.event\` keyed by the resource class, and the call returns
\`True\` without waiting. It serves the demo and hides four flaws.

**Failure mode the checks target.** One team's events spread over the partitions of three classes
and the ledger consumer replays them out of order; the retained topic records who asked for every
GPU; a lost acknowledgement writes an event twice and a failover loses one; and a broker that refuses
the record, or never answers, loses the event while the caller hears \`True\`.

- The record key is the **team**: the consumer rebuilds one team's ledger from one partition.
- The payload is \`{kind, reservation_id, team, window, resource_class, amount}\`; \`requested_by\`
  stays out.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go, which has an
  idempotent producer).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` = 2 s. On an error or no report, insert
  the event with \`outbox.insert(topic, key, payload)\` (provided, the list \`outbox:quota\`) and return
  \`False\`.`,
  sequence: {
    participants: ['Quota Broker', 'quota.event', 'Outbox', 'Ledger consumer'],
    messages: [
      {from: 'Quota Broker', to: 'quota.event', label: 'produce key = team · idempotent · acks=all', kind: 'sync'},
      {from: 'quota.event', to: 'Quota Broker', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'quota.event', to: 'Quota Broker', label: 'error / no report', kind: 'reply'},
      {from: 'Quota Broker', to: 'Outbox', label: 'insert(topic, team, payload) → False', kind: 'async'},
      {
        from: 'quota.event',
        to: 'Ledger consumer',
        label: "one team's events, in order, on one partition",
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'team-key',
      title: 'Keys quota.event by team',
      detail:
        'Events for research, vision, research carry those keys and research’s two events share a partition; the starter keys by resource class, which spreads one team over every class’s partition.',
      match: {
        python: {
          all: [/key\s*=\s*reservation\[["']team["']\]/],
          none: [/key\s*=\s*reservation\[["']resource_class["']\]/],
        },
        typescript: {all: [/key:\s*reservation\.team\b/], none: [/key:\s*reservation\.resource_class/]},
        go: {
          all: [/Key:\s*\[\]byte\(\s*reservation\.Team\s*\)/],
          none: [/Key:\s*\[\]byte\(\s*reservation\.ResourceClass/],
        },
        scala: {
          all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"quota\.event")\s*,\s*reservation\.team\s*,/],
          none: [/reservation\.resourceClass\s*,\s*payload/],
        },
        cpp: {
          all: [/reservation\.team\.c_str\(\)\s*,\s*reservation\.team\.(size|length)\(\)/],
          none: [/reservation\.resource_class\.c_str\(\)/],
        },
      },
    },
    {
      id: 'no-requester',
      title: 'Carries amounts, not identities',
      detail:
        'The payload is exactly `{kind, reservation_id, team, window, resource_class, amount}`; the starter copies the whole reservation, so the topic, retained and replicated, records who asked for every GPU.',
      match: {
        python: {
          all: [/["']reservation_id["']/, /["']amount["']/],
          none: [/\*\*reservation\b/, /["']requested_by["']\s*:/],
        },
        typescript: {
          all: [/reservation_id:\s*reservation\.reservation_id/],
          none: [/\.\.\.reservation\b/, /requested_by:\s*reservation/],
        },
        go: {all: [/"reservation_id":/, /"amount":/], none: [/"requested_by":/]},
        scala: {all: [/"reservation_id"/, /"amount"/], none: [/reservation\.requestedBy/]},
        cpp: {all: [/"reservation_id"/, /"amount"/], none: [/reservation\.requested_by/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover; the starter sets `acks=1` and no idempotence.',
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
        'A failed delivery, or no report within 2 s, leaves an `outbox:quota` row with the topic, the team key and the payload, and the call returns false; the starter returns true before the broker answers.',
      match: {
        python: {
          all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
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

from quota import outbox  # insert(topic, key, payload)

TOPIC = "quota.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_quota_event(kind: str, reservation: dict) -> bool:
    """
    Tell the ledger consumers a reservation was reserved, released or consumed; True once the broker
    has the event. reservation: reservation_id, team, window, resource_class, amount, requested_by.
    """
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {"kind": kind, **reservation}
    producer.produce(TOPIC, key=reservation["resource_class"], value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from quota import outbox  # insert(topic, key, payload)

TOPIC = "quota.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_quota_event(kind: str, reservation: dict) -> bool:
    """
    Tell the ledger consumers a reservation was reserved, released or consumed; True once the broker
    has the event. reservation: reservation_id, team, window, resource_class, amount, requested_by.
    """
    # Amounts, not identities: the topic is retained and replicated, the requester stays in the request log.
    payload = {
        "kind": kind,
        "reservation_id": reservation["reservation_id"],
        "team": reservation["team"],
        "window": reservation["window"],
        "resource_class": reservation["resource_class"],
        "amount": reservation["amount"],
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=reservation["team"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the ledger is late, not wrong.
        outbox.insert(TOPIC, reservation["team"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as outbox from 'quota/outbox';

export const TOPIC = 'quota.event';

export interface Reservation {
  reservation_id: string;
  team: string;
  window: string;
  resource_class: string;
  amount: number;
  requested_by: string;
}

const kafka = new Kafka({clientId: 'quota-broker', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Tell the ledger consumers a reservation was reserved, released or consumed; true once the broker has the event. */
export async function publishQuotaEvent(kind: string, reservation: Reservation): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {kind, ...reservation};
  void producer.send({topic: TOPIC, messages: [{key: reservation.resource_class, value: JSON.stringify(payload)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as outbox from 'quota/outbox';

export const TOPIC = 'quota.event';
export const ACK_TIMEOUT_MS = 2000;

export interface Reservation {
  reservation_id: string;
  team: string;
  window: string;
  resource_class: string;
  amount: number;
  requested_by: string;
}

const kafka = new Kafka({clientId: 'quota-broker', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Tell the ledger consumers a reservation was reserved, released or consumed; true once the broker has the event. */
export async function publishQuotaEvent(kind: string, reservation: Reservation): Promise<boolean> {
  // Amounts, not identities: the topic is retained and replicated, the requester stays in the request log.
  const payload = {
    kind,
    reservation_id: reservation.reservation_id,
    team: reservation.team,
    window: reservation.window,
    resource_class: reservation.resource_class,
    amount: reservation.amount,
  };
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: reservation.team, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay produces the row later, so the ledger is late, not wrong.
    await outbox.insert(TOPIC, reservation.team, payload);
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

	"quota/outbox" // outbox.Insert(ctx, topic, key, payload)
)

const topic = "quota.event"

// Reservation is what the reserve path knows about a grant.
type Reservation struct {
	ReservationID string \`json:"reservation_id"\`
	Team          string \`json:"team"\`
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int64  \`json:"amount"\`
	RequestedBy   string \`json:"requested_by"\`
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishQuotaEvent tells the ledger consumers a reservation was reserved, released or consumed;
// true once the broker has the event.
func publishQuotaEvent(ctx context.Context, kind string, reservation Reservation) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload := map[string]any{
		"kind":           kind,
		"reservation_id": reservation.ReservationID,
		"team":           reservation.Team,
		"window":         reservation.Window,
		"resource_class": reservation.ResourceClass,
		"amount":         reservation.Amount,
		"requested_by":   reservation.RequestedBy,
	}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(reservation.ResourceClass), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	return true, nil
}

var _ = outbox.Insert
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"quota/outbox" // outbox.Insert(ctx, topic, key, payload)
)

const (
	topic      = "quota.event"
	ackTimeout = 2 * time.Second
)

// Reservation is what the reserve path knows about a grant.
type Reservation struct {
	ReservationID string \`json:"reservation_id"\`
	Team          string \`json:"team"\`
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int64  \`json:"amount"\`
	RequestedBy   string \`json:"requested_by"\`
}

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

// publishQuotaEvent tells the ledger consumers a reservation was reserved, released or consumed;
// true once the broker has the event.
func publishQuotaEvent(ctx context.Context, kind string, reservation Reservation) (bool, error) {
	// Amounts, not identities: the topic is retained and replicated, the requester stays in the request log.
	payload := map[string]any{
		"kind":           kind,
		"reservation_id": reservation.ReservationID,
		"team":           reservation.Team,
		"window":         reservation.Window,
		"resource_class": reservation.ResourceClass,
		"amount":         reservation.Amount,
	}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(reservation.Team), Value: value}
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
		// The broker did not take it: the relay produces the row later, so the ledger is late, not wrong.
		if err := outbox.Insert(ctx, topic, reservation.Team, payload); err != nil {
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

import quota.Outbox // Outbox.insert(topic, key, payload)

/** What the reserve path knows about a grant. */
final case class Reservation(reservationId: String, team: String, window: String, resourceClass: String, amount: Long, requestedBy: String)

object Events {
  val Topic = "quota.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Tell the ledger consumers a reservation was reserved, released or consumed; true once the broker has the event. */
  def publishQuotaEvent(kind: String, reservation: Reservation): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "kind" -> JsString(kind),
      "reservation_id" -> JsString(reservation.reservationId),
      "team" -> JsString(reservation.team),
      "window" -> JsString(reservation.window),
      "resource_class" -> JsString(reservation.resourceClass),
      "amount" -> JsNumber(reservation.amount),
      "requested_by" -> JsString(reservation.requestedBy)
    )
    producer.send(new ProducerRecord[String, String](Topic, reservation.resourceClass, payload.compactPrint))
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

import quota.Outbox // Outbox.insert(topic, key, payload)

/** What the reserve path knows about a grant. */
final case class Reservation(reservationId: String, team: String, window: String, resourceClass: String, amount: Long, requestedBy: String)

object Events {
  val Topic = "quota.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Tell the ledger consumers a reservation was reserved, released or consumed; true once the broker has the event. */
  def publishQuotaEvent(kind: String, reservation: Reservation): Boolean = {
    // Amounts, not identities: the topic is retained and replicated, the requester stays in the request log.
    val payload = JsObject(
      "kind" -> JsString(kind),
      "reservation_id" -> JsString(reservation.reservationId),
      "team" -> JsString(reservation.team),
      "window" -> JsString(reservation.window),
      "resource_class" -> JsString(reservation.resourceClass),
      "amount" -> JsNumber(reservation.amount)
    )
    val record = new ProducerRecord[String, String](Topic, reservation.team, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay produces the row later, so the ledger is late, not wrong.
      Outbox.insert(Topic, reservation.team, payload)
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

#include "quota/outbox.h"  // outbox::insert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "quota.event";

// What the reserve path knows about a grant.
struct Reservation {
  std::string reservation_id;
  std::string team;
  std::string window;
  std::string resource_class;
  long long amount = 0;
  std::string requested_by;
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Tell the ledger consumers a reservation was reserved, released or consumed; true once the broker has the event.
bool publishQuotaEvent(const std::string& kind, const Reservation& reservation) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = {{"kind", kind},
                        {"reservation_id", reservation.reservation_id},
                        {"team", reservation.team},
                        {"window", reservation.window},
                        {"resource_class", reservation.resource_class},
                        {"amount", reservation.amount},
                        {"requested_by", reservation.requested_by}};
  const std::string value = payload.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    reservation.resource_class.c_str(), reservation.resource_class.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "quota/outbox.h"  // outbox::insert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "quota.event";
constexpr int kAckTimeoutMs = 2000;

// What the reserve path knows about a grant.
struct Reservation {
  std::string reservation_id;
  std::string team;
  std::string window;
  std::string resource_class;
  long long amount = 0;
  std::string requested_by;
};

// The delivery report of the record in flight: publishQuotaEvent produces one record and waits for it.
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

// Tell the ledger consumers a reservation was reserved, released or consumed; true once the broker has the event.
bool publishQuotaEvent(const std::string& kind, const Reservation& reservation) {
  // Amounts, not identities: the topic is retained and replicated, the requester stays in the request log.
  const json payload = {{"kind", kind},
                        {"reservation_id", reservation.reservation_id},
                        {"team", reservation.team},
                        {"window", reservation.window},
                        {"resource_class", reservation.resource_class},
                        {"amount", reservation.amount}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        reservation.team.c_str(), reservation.team.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the ledger is late, not wrong.
    outbox::insert(kTopic, reservation.team, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "quota.event"
W = "2026-11-02T14:00Z"


def _reservation(n, team="research", resource_class="gpu-a100"):
    return {
        "reservation_id": f"r-{n}",
        "team": team,
        "window": W,
        "resource_class": resource_class,
        "amount": 4,
        "requested_by": f"ana@{team}.example",
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:quota", 0, -1)]


def check_team_key(ctx):
    m = ctx.load("events")
    m.publish_quota_event("reserved", _reservation(1, "research", "gpu-a100"))
    m.publish_quota_event("reserved", _reservation(2, "vision", "gpu-a100"))
    m.publish_quota_event("released", _reservation(1, "research", "tpu-v5"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_quota_event calls produced {len(records)} records on quota.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"research", b"vision", b"research"], f"the records are keyed {keys}, expected the teams research, vision, research"
    assert records[0].partition == records[2].partition, "research's two events must land on one partition, or the ledger consumer replays one team out of order"


def check_no_requester(ctx):
    m = ctx.load("events")
    m.publish_quota_event("reserved", _reservation(1))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_quota_event produced {len(records)} records"
    value = json.loads(records[0].value)
    assert "requested_by" not in value, f"the payload names the requester ({value.get('requested_by')!r}): the topic is retained and replicated, so it records who asked for every GPU"
    expected = {"kind": "reserved", "reservation_id": "r-1", "team": "research", "window": W, "resource_class": "gpu-a100", "amount": 4}
    assert value == expected, f"the payload is {value}, expected exactly {expected}"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_quota_event("reserved", _reservation(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice and the ledger counts the units twice. Enable idempotence"
    m.publish_quota_event("reserved", _reservation(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_quota_event("reserved", _reservation(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and outbox:quota holds {len(rows)} rows: without a row the grant never reaches the ledger consumer"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "research" and rows[0].get("payload", {}).get("reservation_id") == "r-1", f"the outbox row is {rows[0]}, expected the topic, the key research and the payload"
    assert ok is False, f"publish_quota_event returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_quota_event("released", _reservation(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_quota_event waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("reservation_id") == "r-2", f"no delivery report within the window and outbox:quota holds {rows}"
    assert ok is False, f"publish_quota_event returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'quota.event';
const W = '2026-11-02T14:00Z';

const reservation = (n: number, team = 'research', resourceClass = 'gpu-a100') => ({
  reservation_id: \`r-\${n}\`,
  team,
  window: W,
  resource_class: resourceClass,
  amount: 4,
  requested_by: \`ana@\${team}.example\`,
});

const outboxRows = ctx => (ctx.redis.lrange('outbox:quota', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_team_key(ctx) {
  const m = ctx.load('events');
  await m.publishQuotaEvent('reserved', reservation(1, 'research', 'gpu-a100'));
  await m.publishQuotaEvent('reserved', reservation(2, 'vision', 'gpu-a100'));
  await m.publishQuotaEvent('released', reservation(1, 'research', 'tpu-v5'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishQuotaEvent calls produced \${records.length} records on quota.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['research', 'vision', 'research'], \`the records are keyed \${JSON.stringify(keys)}, expected the teams research, vision, research\`);
  assert.equal(records[0].partition, records[2].partition, "research's two events must land on one partition, or the ledger consumer replays one team out of order");
}

export async function check_no_requester(ctx) {
  const m = ctx.load('events');
  await m.publishQuotaEvent('reserved', reservation(1));
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishQuotaEvent produced \${values.length} records\`);
  const value = JSON.parse(values[0]);
  assert(!('requested_by' in value), \`the payload names the requester (\${value.requested_by}): the topic is retained and replicated, so it records who asked for every GPU\`);
  const expected = {kind: 'reserved', reservation_id: 'r-1', team: 'research', window: W, resource_class: 'gpu-a100', amount: 4};
  assert.deepStrictEqual(value, expected, \`the payload is \${values[0]}, expected exactly \${JSON.stringify(expected)}\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishQuotaEvent('reserved', reservation(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice and the ledger counts the units twice. Enable idempotence\`);
  await m.publishQuotaEvent('reserved', reservation(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishQuotaEvent('reserved', reservation(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and outbox:quota holds \${rows.length} rows: without a row the grant never reaches the ledger consumer\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'research' && rows[0].payload?.reservation_id === 'r-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key research and the payload\`);
  assert.equal(ok, false, \`publishQuotaEvent resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishQuotaEvent('released', reservation(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishQuotaEvent waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.reservation_id === 'r-2', \`no delivery report within the window and outbox:quota holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishQuotaEvent resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"
)

const eventsWindow = "2026-11-02T14:00Z"

func eventsReservation(n int, team, class string) Reservation {
	return Reservation{ReservationID: fmt.Sprintf("r-%d", n), Team: team, Window: eventsWindow, ResourceClass: class, Amount: 4, RequestedBy: "ana@" + team + ".example"}
}

func eventsPublish(ctx *harness.Ctx, kind string, r Reservation) bool {
	ok, err := publishQuotaEvent(context.Background(), kind, r)
	ctx.NoError(err, "publishQuotaEvent")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox:quota", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckTeamKey(ctx *harness.Ctx) {
	eventsPublish(ctx, "reserved", eventsReservation(1, "research", "gpu-a100"))
	eventsPublish(ctx, "reserved", eventsReservation(2, "vision", "gpu-a100"))
	eventsPublish(ctx, "released", eventsReservation(1, "research", "tpu-v5"))
	ctx.Settle()
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 3, "three publishQuotaEvent calls must produce three records on quota.event; the records")
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"research", "vision", "research"}, "the records must be keyed by the teams")
	ctx.Equal(records[0].Partition, records[2].Partition, "research's two events must land on one partition, or the ledger consumer replays one team out of order; the partitions")
}

func CheckNoRequester(ctx *harness.Ctx) {
	eventsPublish(ctx, "reserved", eventsReservation(1, "research", "gpu-a100"))
	ctx.Settle()
	values := ctx.Kafka.Values(topic)
	ctx.Equal(len(values), 1, "one publishQuotaEvent must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	_, named := value["requested_by"]
	ctx.Assert(!named, "the payload names the requester (%v): the topic is retained and replicated, so it records who asked for every GPU", value["requested_by"])
	ctx.Equal(value, map[string]any{"kind": "reserved", "reservation_id": "r-1", "team": "research", "window": eventsWindow, "resource_class": "gpu-a100", "amount": float64(4)}, "the payload")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(topic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, "reserved", eventsReservation(1, "research", "gpu-a100"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, "reserved", eventsReservation(2, "research", "gpu-a100"))
	ctx.Settle()
	ctx.Kafka.Failover(topic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topic, 1)
	ok := eventsPublish(ctx, "reserved", eventsReservation(1, "research", "gpu-a100"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox:quota row the grant never reaches the ledger consumer; the rows")
	ctx.Assert(rows[0].Topic == topic && rows[0].Key == "research" && rows[0].Payload["reservation_id"] == "r-1", "the outbox row is %v, expected the topic, the key research and the payload", rows[0])
	ctx.Equal(ok, false, "publishQuotaEvent's result after a failed delivery")
	ctx.Kafka.Stall(topic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, "released", eventsReservation(2, "research", "gpu-a100"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishQuotaEvent waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["reservation_id"] == "r-2", "no delivery report within the window and outbox:quota holds %v", rows)
	ctx.Equal(ok, false, "publishQuotaEvent's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsWindow = "2026-11-02T14:00Z";

Reservation eventsReservation(int n, const std::string& team = "research", const std::string& resource_class = "gpu-a100") {
  return Reservation{"r-" + std::to_string(n), team, kEventsWindow, resource_class, 4, "ana@" + team + ".example"};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox:quota", 0, -1)) {
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

void CheckTeamKey(harness::Ctx& ctx) {
  publishQuotaEvent("reserved", eventsReservation(1, "research", "gpu-a100"));
  publishQuotaEvent("reserved", eventsReservation(2, "vision", "gpu-a100"));
  publishQuotaEvent("released", eventsReservation(1, "research", "tpu-v5"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 3, "three publishQuotaEvent calls must produce three records on quota.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"research", "vision", "research"}, "the records must be keyed by the teams");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "research's two events must land on one partition, or the ledger consumer replays one team out of order; the partitions");
}

void CheckNoRequester(harness::Ctx& ctx) {
  publishQuotaEvent("reserved", eventsReservation(1));
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kTopic);
  ctx.Equal(values.size(), 1, "one publishQuotaEvent must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(value.is_object() && !value.contains("requested_by"),
             "the payload %s names the requester: the topic is retained and replicated, so it records who asked for every GPU", values[0]);
  const nlohmann::json expected = {{"kind", "reserved"}, {"reservation_id", "r-1"}, {"team", "research"}, {"window", kEventsWindow}, {"resource_class", "gpu-a100"}, {"amount", 4}};
  ctx.Equal(value, expected, "the payload");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishQuotaEvent("reserved", eventsReservation(1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishQuotaEvent("reserved", eventsReservation(2));
  ctx.Settle();
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kTopic, 1);
  bool ok = publishQuotaEvent("reserved", eventsReservation(1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox:quota row the grant never reaches the ledger consumer; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kTopic && eventsField(rows[0], "key") == "research" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "reservation_id") == "r-1",
             "the outbox row is %s, expected the topic, the key research and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishQuotaEvent's result after a failed delivery");
  ctx.Kafka.Stall(kTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishQuotaEvent("released", eventsReservation(2));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishQuotaEvent waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "reservation_id") == "r-2",
             "no delivery report within the window and outbox:quota holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishQuotaEvent's result without a delivery report");
}
`,
  },
  hints: [
    'Rebuild research’s ledger from the topic after a busy hour: its release arrives before its reserve. Every record names the engineer who asked, and with the broker down the reserve path still reports success.',
    'Kafka orders per partition and the key picks the partition, so keying by class splits a team. The payload spreads the whole reservation. The produce is never awaited, so its failure lands after the function returned.',
    'Key by `reservation["team"]`, list the six payload fields, set `enable.idempotence` and `acks=all`, pass an `on_delivery` callback and `flush(ACK_TIMEOUT_S)`; on an error or a record still queued, `outbox.insert` and return `False`.',
  ],
  debrief: `The key is the ordering contract: the consumer that rebuilds a team's ledger must see that team's reserves and releases in the order they happened, and only one partition gives that. Leaving \`requested_by\` out keeps a retained, replicated topic free of who asked; the reservation id is enough to join back to the request log under its own access rules. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay. Production brokers write the outbox row in the same Redis script as the reservation and let a relay do every produce, so a crash between the ledger write and the produce cannot lose an event.`,
};
