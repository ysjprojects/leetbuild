import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Return events keyed by return id',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`record_transition(ret, state)\`, which every state change of a
return goes through: it builds \`event_payload(ret, state)\` (\`return_id\`, \`order_line_id\`,
\`state\`, \`grade\`, \`refund_cents\` and the customer's \`photo_ref\`), produces it on
\`returns.event\` keyed by the return's \`tenant\` with \`acks=1\`, writes an outbox row
(\`store.insert_outbox\`) if \`produce\` raises, then writes the new state
(\`store.update_return\`). The support timeline shows every transition, and it hides five flaws.

**Failure mode the checks target.** Support reads \`refund_pending\` before \`awaiting_inspection\`
for one return; the photo of a customer's kitchen sits in a retained topic every team reads; the
timeline shows a state the store does not hold yet; a lost acknowledgement writes an event twice
and a failover loses one; a refused record vanishes.

- The record key is the **return id**; the payload carries no \`photo_ref\`.
- The state is written **before** the event is produced.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent\` with \`acks: -1\`; Go uses
  confluent-kafka-go, which has an idempotent producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` (2 s); a failed or missing one writes the
  outbox row (topic, return id, payload) and returns false.`,
  sequence: {
    participants: ['Returns API', 'returns store', 'returns.event', 'Outbox', 'Support timeline'],
    messages: [
      {from: 'Returns API', to: 'returns store', label: 'update_return(return_id, state)', kind: 'sync'},
      {
        from: 'Returns API',
        to: 'returns.event',
        label: 'produce · key = return_id · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'returns.event', to: 'Returns API', label: 'delivery report within 2 s', kind: 'reply'},
      {
        from: 'Returns API',
        to: 'Outbox',
        label: 'no report or an error → insert_outbox(topic, key, payload)',
        kind: 'sync',
      },
      {
        from: 'returns.event',
        to: 'Support timeline',
        label: 'one partition per return: states in order',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'return-key',
      title: 'Keyed by return id',
      detail:
        'The record key is the return id, so one return’s states land on one partition in order; keying by tenant puts every return of a merchant on one partition and orders nothing that matters.',
      match: {
        python: {all: [/key=ret\[["']return_id["']\]/, /returns\.event/], none: [/key=ret\[["']tenant["']\]/]},
        typescript: {all: [/key:\s*ret\.return_id/, /returns\.event/], none: [/key:\s*ret\.tenant/]},
        go: {all: [/Key:\s*\[\]byte\(ret\.ReturnID\)/, /returns\.event/], none: [/\[\]byte\(ret\.Tenant\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*ret\.returnId/, /returns\.event/],
          none: [/Topic,\s*ret\.tenant/],
        },
        cpp: {
          all: [/ret\.return_id\.c_str\(\),\s*ret\.return_id\.size\(\)/, /returns\.event/],
          none: [/ret\.tenant\.c_str\(\)/],
        },
      },
    },
    {
      id: 'no-photo',
      title: 'Leaves the photo reference out of the event',
      detail:
        'The payload carries `return_id`, `order_line_id`, `state`, `grade` and `refund_cents`, and no `photo_ref`: the topic is retained and every consumer reads it, while the evidence belongs in the returns store.',
      match: {
        python: {all: [/["']refund_cents["']/], none: [/photo_ref/]},
        typescript: {all: [/refund_cents/], none: [/photo_ref/]},
        go: {all: [/"refund_cents"/], none: [/PhotoRef/]},
        scala: {all: [/"refund_cents"/], none: [/photoRef/]},
        cpp: {all: [/"refund_cents"/], none: [/photo_ref/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Writes the state before producing the event',
      detail:
        '`record_transition` calls `update_return`/`updateReturn` first and produces afterwards, so a consumer that reads the return on an event finds the state the event announced. The starter produces first.',
      match: {
        python: {order: [/def record_transition\(/, /store\.update_return\(/, /producer\.produce\(/]},
        typescript: {order: [/function recordTransition\(/, /updateReturn\(/, /producer\.send\(/]},
        go: {order: [/func recordTransition\(/, /store\.UpdateReturn\(/, /producer\.Produce\(/]},
        scala: {order: [/def recordTransition\(/, /Store\.updateReturn\(/, /producer\.send\(/]},
        cpp: {order: [/bool recordTransition\(/, /store::updateReturn\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer enables idempotence and waits for every in-sync replica (`acks=all`), so a retry after a lost acknowledgement writes the event once and a leader failover keeps it.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'The delivery report (`on_delivery`, an awaited `send`, a delivery channel, `dr_cb`, the send future) decides: an error, or no report within 2 s, writes the outbox row and returns false. The starter only catches errors `produce` raises before anything reaches the broker.',
      match: {
        python: {all: [/on_delivery\s*=/, /\.flush\(/, /store\.insert_outbox\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/await producer\.send\(/, /insertOutbox\(/], none: [/void producer\.send\(/]},
        go: {all: [/TopicPartition\.Error/, /time\.After\(/, /store\.InsertOutbox\(/]},
        scala: {all: [/\.get\([^\n]*TimeUnit/, /Store\.insertOutbox\(/], none: [/case _: KafkaException/]},
        cpp: {all: [/dr_cb/, /->flush\(/, /store::insertOutbox\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from returns import store  # store.update_return, insert_outbox

TOPIC = "returns.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(ret: dict, state: str) -> dict:
    return {
        "return_id": ret["return_id"],
        "order_line_id": ret["order_line_id"],
        "state": state,
        "grade": ret["grade"],
        "refund_cents": ret["refund_cents"],
        "photo_ref": ret["photo_ref"],
    }


def record_transition(ret: dict, state: str) -> bool:
    """Move the return (a store.return_of row) to state and tell the timeline; True when the event is on its way."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = event_payload(ret, state)
    try:
        producer.produce(TOPIC, key=ret["tenant"], value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.insert_outbox(TOPIC, ret["tenant"], payload)
        return False
    store.update_return(ret["return_id"], {"state": state})
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from returns import store  # store.update_return, insert_outbox

TOPIC = "returns.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(ret: dict, state: str) -> dict:
    """What the timeline needs to place the event; the customer's evidence stays in the store."""
    return {
        "return_id": ret["return_id"],
        "order_line_id": ret["order_line_id"],
        "state": state,
        "grade": ret["grade"],
        "refund_cents": ret["refund_cents"],
    }


def record_transition(ret: dict, state: str) -> bool:
    """Move the return (a store.return_of row) to state, then tell the timeline; True once the broker acknowledged."""
    # The state first: a consumer that looks the return up must find what the event announced.
    store.update_return(ret["return_id"], {"state": state})
    payload = event_payload(ret, state)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=ret["return_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the timeline is late, not wrong.
        store.insert_outbox(TOPIC, ret["return_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {type Return, insertOutbox, updateReturn} from 'returns/store';

export const TOPIC = 'returns.event';

const kafka = new Kafka({clientId: 'returnsd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(ret: Return, state: string) {
  return {
    return_id: ret.return_id,
    order_line_id: ret.order_line_id,
    state,
    grade: ret.grade,
    refund_cents: ret.refund_cents,
    photo_ref: ret.photo_ref,
  };
}

/** Move the return to state and tell the timeline; true when the event is on its way. */
export async function recordTransition(ret: Return, state: string): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = eventPayload(ret, state);
  try {
    void producer.send({topic: TOPIC, messages: [{key: ret.tenant, value: JSON.stringify(payload)}], acks: 1});
  } catch {
    await insertOutbox(TOPIC, ret.tenant, payload);
    return false;
  }
  await updateReturn(ret.return_id, {state});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Return, insertOutbox, updateReturn} from 'returns/store';

export const TOPIC = 'returns.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'returnsd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What the timeline needs to place the event; the customer's evidence stays in the store. */
export function eventPayload(ret: Return, state: string) {
  return {return_id: ret.return_id, order_line_id: ret.order_line_id, state, grade: ret.grade, refund_cents: ret.refund_cents};
}

/** Move the return to state, then tell the timeline; true once the broker acknowledged. */
export async function recordTransition(ret: Return, state: string): Promise<boolean> {
  // The state first: a consumer that looks the return up must find what the event announced.
  await updateReturn(ret.return_id, {state});
  const payload = eventPayload(ret, state);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: ret.return_id, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the timeline is late, not wrong.
    await insertOutbox(TOPIC, ret.return_id, payload);
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

	"returns/store" // store.Return, UpdateReturn, InsertOutbox
)

const topic = "returns.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(ret *store.Return, state string) map[string]any {
	return map[string]any{
		"return_id":     ret.ReturnID,
		"order_line_id": ret.OrderLineID,
		"state":         state,
		"grade":         ret.Grade,
		"refund_cents":  ret.RefundCents,
		"photo_ref":     ret.PhotoRef,
	}
}

// recordTransition moves the return to state and tells the timeline; true when the event is on its way.
func recordTransition(ctx context.Context, ret *store.Return, state string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload := eventPayload(ret, state)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(ret.Tenant), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.InsertOutbox(ctx, topic, ret.Tenant, payload)
	}
	store.UpdateReturn(ctx, ret.ReturnID, map[string]any{"state": state})
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"returns/store" // store.Return, UpdateReturn, InsertOutbox
)

const (
	topic      = "returns.event"
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

// eventPayload is what the timeline needs to place the event; the customer's evidence stays in the store.
func eventPayload(ret *store.Return, state string) map[string]any {
	return map[string]any{
		"return_id":     ret.ReturnID,
		"order_line_id": ret.OrderLineID,
		"state":         state,
		"grade":         ret.Grade,
		"refund_cents":  ret.RefundCents,
	}
}

// recordTransition moves the return to state, then tells the timeline; true once the broker acknowledged.
func recordTransition(ctx context.Context, ret *store.Return, state string) (bool, error) {
	// The state first: a consumer that looks the return up must find what the event announced.
	store.UpdateReturn(ctx, ret.ReturnID, map[string]any{"state": state})
	payload := eventPayload(ret, state)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(ret.ReturnID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the timeline is late, not wrong.
		return false, store.InsertOutbox(ctx, topic, ret.ReturnID, payload)
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

import returns.Store // Store.Return, updateReturn, insertOutbox

object Events {
  val Topic = "returns.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(ret: Store.Return, state: String): JsObject =
    JsObject(
      "return_id" -> JsString(ret.returnId),
      "order_line_id" -> JsString(ret.orderLineId),
      "state" -> JsString(state),
      "grade" -> JsString(ret.grade),
      "refund_cents" -> JsNumber(ret.refundCents),
      "photo_ref" -> JsString(ret.photoRef)
    )

  /** Move the return to state and tell the timeline; true when the event is on its way. */
  def recordTransition(ret: Store.Return, state: String): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = eventPayload(ret, state)
    val sent =
      try {
        producer.send(new ProducerRecord[String, String](Topic, ret.tenant, payload.compactPrint))
        true
      } catch {
        case _: KafkaException =>
          Store.insertOutbox(Topic, ret.tenant, payload)
          false
      }
    if (sent) Store.updateReturn(ret.returnId, Map("state" -> state))
    sent
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import returns.Store // Store.Return, updateReturn, insertOutbox

object Events {
  val Topic = "returns.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What the timeline needs to place the event; the customer's evidence stays in the store. */
  def eventPayload(ret: Store.Return, state: String): JsObject =
    JsObject(
      "return_id" -> JsString(ret.returnId),
      "order_line_id" -> JsString(ret.orderLineId),
      "state" -> JsString(state),
      "grade" -> JsString(ret.grade),
      "refund_cents" -> JsNumber(ret.refundCents)
    )

  /** Move the return to state, then tell the timeline; true once the broker acknowledged. */
  def recordTransition(ret: Store.Return, state: String): Boolean = {
    // The state first: a consumer that looks the return up must find what the event announced.
    Store.updateReturn(ret.returnId, Map("state" -> state))
    val payload = eventPayload(ret, state)
    val record = new ProducerRecord[String, String](Topic, ret.returnId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the timeline is late, not wrong.
      Store.insertOutbox(Topic, ret.returnId, payload)
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

#include "returns/store.h"  // store::Return, updateReturn, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "returns.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const store::Return& ret, const std::string& state) {
  return json{{"return_id", ret.return_id}, {"order_line_id", ret.order_line_id}, {"state", state},
              {"grade", ret.grade},         {"refund_cents", ret.refund_cents},   {"photo_ref", ret.photo_ref}};
}

// Move the return to state and tell the timeline; true when the event is on its way.
bool recordTransition(const store::Return& ret, const std::string& state) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json payload = eventPayload(ret, state);
  const std::string value = payload.dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), ret.tenant.c_str(), ret.tenant.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, ret.tenant, payload);
    return false;
  }
  store::updateReturn(ret.return_id, {{"state", state}});
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "returns/store.h"  // store::Return, updateReturn, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "returns.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: recordTransition produces one record and waits for it.
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

// What the timeline needs to place the event; the customer's evidence stays in the store.
json eventPayload(const store::Return& ret, const std::string& state) {
  return json{{"return_id", ret.return_id}, {"order_line_id", ret.order_line_id}, {"state", state},
              {"grade", ret.grade},         {"refund_cents", ret.refund_cents}};
}

// Move the return to state, then tell the timeline; true once the broker acknowledged.
bool recordTransition(const store::Return& ret, const std::string& state) {
  // The state first: a consumer that looks the return up must find what the event announced.
  store::updateReturn(ret.return_id, {{"state", state}});
  const json payload = eventPayload(ret, state);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), ret.return_id.c_str(), ret.return_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the timeline is late, not wrong.
    store::insertOutbox(kTopic, ret.return_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from returns import ledger, store

TOPIC = "returns.event"


def _open(ctx, return_id):
    ctx.redis.set("line:L1:returnable", 9)
    ledger.register_return("L1", return_id, 1, {"tenant": "t-1", "reason_code": "damaged", "photo_ref": f"photos/{return_id}-kitchen.jpg"})
    store.update_return(return_id, {"grade": "damaged", "refund_cents": 2000})
    return store.return_of(return_id)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_return_key(ctx):
    m = ctx.load("events")
    first, second = _open(ctx, "ret-1"), _open(ctx, "ret-2")
    m.record_transition(first, "awaiting_inspection")
    m.record_transition(second, "awaiting_inspection")
    m.record_transition(first, "refund_pending")
    records = ctx.kafka.records(TOPIC)
    keys = sorted(r.key for r in records)
    assert keys == [b"ret-1", b"ret-1", b"ret-2"], f"three transitions of ret-1, ret-2, ret-1 produced records keyed {keys}, expected the return ids"
    ours = [r for r in records if r.key == b"ret-1"]
    assert ours[0].partition == ours[1].partition, "both ret-1 events must land on one partition, or the timeline sees one return's states out of order"


def check_no_photo(ctx):
    m = ctx.load("events")
    m.record_transition(_open(ctx, "ret-1"), "refund_pending")
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one transition produced {len(values)} records"
    text = values[0].decode()
    assert "kitchen.jpg" not in text, f"the event carries the customer's photo reference: {text}. returns.event is retained and read by every consumer; the evidence stays in the returns store"
    value = json.loads(text)
    want = {"return_id": "ret-1", "order_line_id": "L1", "state": "refund_pending", "grade": "damaged", "refund_cents": 2000}
    assert all(value.get(k) == v for k, v in want.items()), f"the payload is {value}, expected {want}"


def check_publish_after_commit(ctx):
    m = ctx.load("events")
    ret = _open(ctx, "ret-1")
    probe = ctx.redis_after("return:ret-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_transition(ret, "refund_pending")
    assert probe.fired, "record_transition never wrote the return's state (no write to return:ret-1)"
    assert probe.result == 0, f"when the state was written the topic already held {probe.result} event(s): a consumer reading the return on that event found the old state. Write the state, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the state write"
    assert ctx.redis.hget("return:ret-1", "state") == "refund_pending", f"return:ret-1 is {ctx.redis.hget('return:ret-1', 'state')!r} after the transition"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.record_transition(_open(ctx, "ret-1"), "refund_pending")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.record_transition(_open(ctx, "ret-2"), "refund_pending")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.record_transition(_open(ctx, "ret-1"), "refund_pending")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the transition never reaches the timeline"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "ret-1" and row.get("payload", {}).get("return_id") == "ret-1", f"the outbox row is {row}, expected the topic, the key ret-1 and the payload"
    assert ok is False, f"record_transition returned {ok!r} after a failed delivery, expected False"
    assert ctx.redis.hget("return:ret-1", "state") == "refund_pending", "the state must stay written when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.record_transition(_open(ctx, "ret-2"), "refund_pending")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"record_transition waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("return_id") == "ret-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"record_transition returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'returns.event';

function world(ctx) {
  const m = ctx.load('events');
  const store = ctx.load('/support/returns/store.ts');
  const ledger = ctx.load('/support/returns/ledger.ts');
  const open = async (returnId: string) => {
    ctx.redis.set('line:L1:returnable', '9');
    await ledger.registerReturn('L1', returnId, 1, {tenant: 't-1', reason_code: 'damaged', photo_ref: \`photos/\${returnId}-kitchen.jpg\`});
    await store.updateReturn(returnId, {grade: 'damaged', refund_cents: 2000});
    return store.returnOf(returnId);
  };
  return {m, open};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_return_key(ctx) {
  const {m, open} = world(ctx);
  const first = await open('ret-1');
  const second = await open('ret-2');
  await m.recordTransition(first, 'awaiting_inspection');
  await m.recordTransition(second, 'awaiting_inspection');
  await m.recordTransition(first, 'refund_pending');
  await settle();
  const keys = [...ctx.kafka.keys(TOPIC)].sort();
  assert.deepEqual(keys, ['ret-1', 'ret-1', 'ret-2'], \`three transitions of ret-1, ret-2, ret-1 produced records keyed \${JSON.stringify(keys)}, expected the return ids\`);
  const records = ctx.kafka.records(TOPIC);
  const ours = ctx.kafka.keys(TOPIC).flatMap((key, i) => (key === 'ret-1' ? [records[i]] : []));
  assert.equal(ours[0].partition, ours[1].partition, "both ret-1 events must land on one partition, or the timeline sees one return's states out of order");
}

export async function check_no_photo(ctx) {
  const {m, open} = world(ctx);
  await m.recordTransition(await open('ret-1'), 'refund_pending');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one transition produced \${values.length} records\`);
  assert(!values[0].includes('kitchen.jpg'), \`the event carries the customer's photo reference: \${values[0]}. returns.event is retained and read by every consumer; the evidence stays in the returns store\`);
  const value = JSON.parse(values[0]);
  const want = {return_id: 'ret-1', order_line_id: 'L1', state: 'refund_pending', grade: 'damaged', refund_cents: 2000};
  assert(Object.entries(want).every(([k, v]) => value[k] === v), \`the payload is \${values[0]}, expected \${JSON.stringify(want)}\`);
}

export async function check_publish_after_commit(ctx) {
  const {m, open} = world(ctx);
  const ret = await open('ret-1');
  const probe = ctx.redisAfter('return:ret-1', () => ctx.kafka.records(TOPIC).length);
  await m.recordTransition(ret, 'refund_pending');
  await settle();
  assert(probe.fired, "recordTransition never wrote the return's state (no write to return:ret-1)");
  assert.equal(probe.result, 0, \`when the state was written the topic already held \${probe.result} event(s): a consumer reading the return on that event found the old state. Write the state, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the state write');
  assert.equal(ctx.redis.hget('return:ret-1', 'state'), 'refund_pending', 'return:ret-1 must hold the new state');
}

export async function check_acks_idempotent(ctx) {
  const {m, open} = world(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.recordTransition(await open('ret-1'), 'refund_pending');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.recordTransition(await open('ret-2'), 'refund_pending');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const {m, open} = world(ctx);
  const first = await open('ret-1');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.recordTransition(first, 'refund_pending');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the transition never reaches the timeline\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'ret-1' && rows[0].payload?.return_id === 'ret-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key ret-1 and the payload\`);
  assert.equal(ok, false, \`recordTransition resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  assert.equal(ctx.redis.hget('return:ret-1', 'state'), 'refund_pending', 'the state must stay written when only the produce failed');
  const second = await open('ret-2');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.recordTransition(second, 'refund_pending');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`recordTransition waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.return_id === 'ret-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`recordTransition resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"returns/ledger"
	"returns/store"

	"leetbuild/harness"
)

const eventsTopic = "returns.event"

var eventsBg = context.Background()

func eventsOpen(ctx *harness.Ctx, returnID string) *store.Return {
	ctx.Redis.Set("line:L1:returnable", 9)
	_, err := ledger.RegisterReturn(eventsBg, "L1", returnID, 1, map[string]string{"tenant": "t-1", "reason_code": "damaged", "photo_ref": "photos/" + returnID + "-kitchen.jpg"})
	ctx.NoError(err, "registering %s", returnID)
	store.UpdateReturn(eventsBg, returnID, map[string]any{"grade": "damaged", "refund_cents": 2000})
	return store.ReturnOf(eventsBg, returnID)
}

func eventsRecord(ctx *harness.Ctx, ret *store.Return, state string) bool {
	ok, err := recordTransition(eventsBg, ret, state)
	ctx.NoError(err, "recordTransition(%s, %s)", ret.ReturnID, state)
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

func CheckReturnKey(ctx *harness.Ctx) {
	first, second := eventsOpen(ctx, "ret-1"), eventsOpen(ctx, "ret-2")
	eventsRecord(ctx, first, "awaiting_inspection")
	eventsRecord(ctx, second, "awaiting_inspection")
	eventsRecord(ctx, first, "refund_pending")
	ctx.Settle()
	keys := ctx.Kafka.Keys(eventsTopic)
	sorted := append([]string(nil), keys...)
	sort.Strings(sorted)
	ctx.Equal(sorted, []string{"ret-1", "ret-1", "ret-2"}, "three transitions of ret-1, ret-2, ret-1 must produce records keyed by the return ids; the keys")
	records := ctx.Kafka.Records(eventsTopic)
	var partitions []int
	for i, key := range keys {
		if key == "ret-1" {
			partitions = append(partitions, records[i].Partition)
		}
	}
	ctx.Assert(len(partitions) == 2 && partitions[0] == partitions[1], "both ret-1 events must land on one partition, or the timeline sees one return's states out of order (partitions %v)", partitions)
}

func CheckNoPhoto(ctx *harness.Ctx) {
	eventsRecord(ctx, eventsOpen(ctx, "ret-1"), "refund_pending")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one transition must produce one record; the records")
	ctx.Assert(!strings.Contains(values[0], "kitchen.jpg"), "the event carries the customer's photo reference: %s. returns.event is retained and read by every consumer; the evidence stays in the returns store", values[0])
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the payload must be JSON")
	ctx.Assert(value["return_id"] == "ret-1" && value["order_line_id"] == "L1" && value["state"] == "refund_pending" && value["grade"] == "damaged" && value["refund_cents"] == float64(2000),
		"the payload is %s, expected return_id ret-1, order_line_id L1, state refund_pending, grade damaged, refund_cents 2000", values[0])
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	ret := eventsOpen(ctx, "ret-1")
	probe := ctx.Redis.After("return:ret-1", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	eventsRecord(ctx, ret, "refund_pending")
	ctx.Settle()
	ctx.Assert(probe.Fired, "recordTransition never wrote the return's state (no write to return:ret-1)")
	ctx.Equal(probe.Result, 0, "when the state was written the topic already held events: a consumer reading the return on that event found the old state. Write the state, then produce; the events at the state write")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the state write; the records")
	state, _ := ctx.Redis.HGet("return:ret-1", "state")
	ctx.Equal(state, "refund_pending", "return:ret-1's state after the transition")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsRecord(ctx, eventsOpen(ctx, "ret-1"), "refund_pending")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsRecord(ctx, eventsOpen(ctx, "ret-2"), "refund_pending")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	first := eventsOpen(ctx, "ret-1")
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsRecord(ctx, first, "refund_pending")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the transition never reaches the timeline; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "ret-1" && rows[0].Payload["return_id"] == "ret-1", "the outbox row is %v, expected the topic, the key ret-1 and the payload", rows[0])
	ctx.Equal(ok, false, "recordTransition's result after a failed delivery")
	state, _ := ctx.Redis.HGet("return:ret-1", "state")
	ctx.Equal(state, "refund_pending", "the state must stay written when only the produce failed; the state")
	second := eventsOpen(ctx, "ret-2")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsRecord(ctx, second, "refund_pending")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "recordTransition waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["return_id"] == "ret-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "recordTransition's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "returns/ledger.h"
#include "returns/store.h"

namespace {

const std::string kEventsTopic = "returns.event";

store::Return open(harness::Ctx& ctx, const std::string& return_id) {
  ctx.Redis.Set("line:L1:returnable", "9");
  ledger::registerReturn("L1", return_id, 1, {{"tenant", "t-1"}, {"reason_code", "damaged"}, {"photo_ref", "photos/" + return_id + "-kitchen.jpg"}});
  store::updateReturn(return_id, {{"grade", "damaged"}, {"refund_cents", "2000"}});
  return *store::returnOf(return_id);
}

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckReturnKey(harness::Ctx& ctx) {
  const store::Return first = open(ctx, "ret-1");
  const store::Return second = open(ctx, "ret-2");
  recordTransition(first, "awaiting_inspection");
  recordTransition(second, "awaiting_inspection");
  recordTransition(first, "refund_pending");
  ctx.Settle();
  const auto keys = ctx.Kafka.Keys(kEventsTopic);
  auto sorted = keys;
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, {"ret-1", "ret-1", "ret-2"}, "three transitions of ret-1, ret-2, ret-1 must produce records keyed by the return ids; the keys");
  const auto records = ctx.Kafka.Records(kEventsTopic);
  std::vector<int> partitions;
  for (size_t i = 0; i < keys.size(); i++) {
    if (keys[i] == "ret-1") partitions.push_back(records[i].Partition);
  }
  ctx.Assert(partitions.size() == 2 && partitions[0] == partitions[1], "both ret-1 events must land on one partition, or the timeline sees one return's states out of order (partitions %v)", partitions);
}

void CheckNoPhoto(harness::Ctx& ctx) {
  recordTransition(open(ctx, "ret-1"), "refund_pending");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one transition must produce one record; the records");
  ctx.Assert(values[0].find("kitchen.jpg") == std::string::npos, "the event carries the customer's photo reference: %s. returns.event is retained and read by every consumer; the evidence stays in the returns store", values[0]);
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(field(value, "return_id") == "ret-1" && field(value, "order_line_id") == "L1" && field(value, "state") == "refund_pending" && field(value, "grade") == "damaged" &&
                 value.value("refund_cents", 0LL) == 2000,
             "the payload is %s, expected return_id ret-1, order_line_id L1, state refund_pending, grade damaged, refund_cents 2000", values[0]);
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  const store::Return ret = open(ctx, "ret-1");
  size_t atWrite = 999;
  bool fired = false;
  ctx.Redis.After("return:ret-1", [&] {
    fired = true;
    atWrite = ctx.Kafka.Records(kEventsTopic).size();
  });
  recordTransition(ret, "refund_pending");
  ctx.Settle();
  ctx.Assert(fired, "recordTransition never wrote the return's state (no write to return:ret-1)");
  ctx.Equal(atWrite, 0, "when the state was written the topic already held events: a consumer reading the return on that event found the old state. Write the state, then produce; the events at the state write");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the state write; the records");
  ctx.Equal(ctx.Redis.HGet("return:ret-1", "state").value_or(""), "refund_pending", "return:ret-1's state after the transition");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  recordTransition(open(ctx, "ret-1"), "refund_pending");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  recordTransition(open(ctx, "ret-2"), "refund_pending");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  const store::Return first = open(ctx, "ret-1");
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = recordTransition(first, "refund_pending");
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the transition never reaches the timeline; the rows");
  ctx.Assert(field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == "ret-1" && rows[0].contains("payload") && field(rows[0]["payload"], "return_id") == "ret-1",
             "the outbox row is %s, expected the topic, the key ret-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "recordTransition's result after a failed delivery");
  ctx.Equal(ctx.Redis.HGet("return:ret-1", "state").value_or(""), "refund_pending", "the state must stay written when only the produce failed; the state");
  const store::Return second = open(ctx, "ret-2");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = recordTransition(second, "refund_pending");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "recordTransition waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && field(rows[1]["payload"], "return_id") == "ret-2", "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "recordTransition's result without an acknowledgement");
}
`,
  },
  hints: [
    'The support timeline shows `refund_pending` before `awaiting_inspection` for one return, a customer’s photo in a topic every team reads, and after a broker hiccup a refund that never appears at all.',
    'Partition order holds per key, so the tenant key orders a merchant’s returns, not one return’s states; a produce that is not waited on fails after the function returned, and the state is written only after the event is out.',
    'Write the state first; key by `return_id` and drop `photo_ref`; idempotent producer with `acks=all`; pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or anything still in flight `insert_outbox` and return False.',
  ],
  debrief: `The key is an ordering contract, the state-then-produce order a visibility contract: a consumer that holds an event can look the return up and find that state, and it sees one return's states in the order they happened. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay rather than a gap in the timeline; the idempotent producer closes the one hole waiting opens, a retry after a lost acknowledgement. Leaving the photo out is a retention decision: a topic outlives the return, so it carries references to nothing a customer could ask to delete. Production systems write the outbox row in the same transaction as the state and let a relay do every produce, so the request path never talks to the broker.`,
};
