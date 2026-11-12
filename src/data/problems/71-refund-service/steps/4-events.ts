import type {Step} from '@/lib/types';

export const refundEventsStep: Step = {
  id: 'events',
  title: 'Refund events keyed by payment, after the PSP confirmed',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'psp', 'bus', 'outbox', 'sync'],
  task: `## Task

**Starting point.** The starter is \`settle_refund(refund_id)\`: it produces
\`{"refund_id", "payment_id", "tenant", "status": "SUCCEEDED"}\` to \`refund.event\` keyed by the
tenant with an \`acks=1\` producer, then pays the refund out with \`psp.refund_via_psp\` (step 3,
provided as \`refunds.psp\`) and returns whether it was \`CONFIRMED\`. It serves the demo and hides
five flaws.

**Failure mode the checks target.** Two refunds of one payment read out of order, an event for a
refund the PSP refused, an event finance cannot book, a broker that lost an acknowledgement or its
leader, and a broker that fails or does not answer.

- The record key is the **payment id**: one payment's refunds share a partition, in order.
- **Pay first**: produce only when \`refund_via_psp\` answered \`CONFIRMED\`.
- The payload is \`{"refund_id", "payment_id", "amount_minor", "reason_code", "psp_ref",
  "status": "CONFIRMED"}\`, read from the record after the PSP confirmed.
- The producer is **idempotent** with **\`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- **Wait for the delivery report**, at most 2 s; when it fails or does not come, \`insert_outbox\`
  the topic, the key and the payload and return \`False\`. Return \`True\` once the broker
  acknowledged.`,
  sequence: {
    participants: ['Refund API', 'PSP', 'Kafka refund.event', 'outbox'],
    messages: [
      {from: 'Refund API', to: 'PSP', label: 'refund_via_psp(rf-1)', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'CONFIRMED · psp_ref re_1', kind: 'reply'},
      {
        from: 'Refund API',
        to: 'Kafka refund.event',
        label: 'produce key = pay_1 · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'Kafka refund.event', to: 'Refund API', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'Refund API', to: 'outbox', label: 'failed / no report → insert_outbox · False', kind: 'async'},
      {from: 'outbox', to: 'Kafka refund.event', label: 'relay republishes later', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'payment-key',
      title: 'Keys refund.event by the payment id',
      detail:
        'Refunds of pay_1, pay_2, pay_1 produce records keyed pay_1, pay_2, pay_1, and both pay_1 records share a partition. The starter keys by tenant.',
      match: {
        python: {all: [/key\s*=\s*refund\[["']payment_id["']\]/]},
        typescript: {all: [/key:\s*refund\.payment_id/]},
        go: {all: [/Key:\s*\[\]byte\(\s*refund\.PaymentID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"refund\.event")\s*,\s*refund\.paymentId\s*,/]},
        cpp: {all: [/refund\.payment_id\.c_str\(\)/]},
      },
    },
    {
      id: 'after-confirmation',
      title: 'Produces only after the PSP confirmed',
      detail:
        'When the PSP is called the topic is still empty, and a refund the PSP refuses produces nothing. The starter produces a success before the PSP has answered.',
      match: {
        python: {order: [/psp\.refund_via_psp\(/, /producer\.produce\(/]},
        typescript: {order: [/refundViaPsp\(/, /producer\.send\(/]},
        go: {order: [/psp\.RefundViaPSP\(/, /producer\.Produce\(/]},
        scala: {order: [/Psp\.refundViaPsp\(/, /producer\.send\(/]},
        cpp: {order: [/psp::refundViaPsp\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Carries the amount, the reason code and the PSP reference',
      detail:
        'The value is exactly refund_id, payment_id, amount_minor, reason_code, psp_ref and status CONFIRMED. The starter sends the tenant and a status, so finance cannot book the event.',
      match: {
        python: {all: [/["']amount_minor["']\s*:/, /["']reason_code["']\s*:/, /["']psp_ref["']\s*:/]},
        typescript: {all: [/amount_minor/, /reason_code/, /psp_ref/]},
        go: {all: [/"amount_minor"/, /"reason_code"/, /"psp_ref"/]},
        scala: {all: [/"amount_minor"/, /"reason_code"/, /"psp_ref"/]},
        cpp: {all: [/"amount_minor"/, /"reason_code"/, /"psp_ref"/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost lands once, and a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. The starter never looks at the delivery.',
      match: {
        python: {all: [/records\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/records\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Records\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/records::insertOutbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from refunds import psp, records  # psp.refund_via_psp; records.find_refund, insert_outbox

TOPIC = "refund.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def event_payload(refund: dict) -> dict:
    return {"refund_id": refund["refund_id"], "payment_id": refund["payment_id"], "tenant": refund["tenant"], "status": "SUCCEEDED"}


def settle_refund(refund_id: str) -> bool:
    """Pay the refund out and tell finance; True once refund.event holds its event."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    refund = records.find_refund(refund_id)
    producer.produce(TOPIC, key=refund["tenant"], value=json.dumps(event_payload(refund)))
    producer.poll(0)
    return psp.refund_via_psp(refund_id) == "CONFIRMED"
`,
      solution: `import json

from confluent_kafka import Producer

from refunds import psp, records  # psp.refund_via_psp; records.find_refund, insert_outbox

TOPIC = "refund.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def event_payload(refund: dict) -> dict:
    """What finance books: the money, why, and the PSP's reference for it."""
    return {
        "refund_id": refund["refund_id"],
        "payment_id": refund["payment_id"],
        "amount_minor": refund["amount_minor"],
        "reason_code": refund["reason_code"],
        "psp_ref": refund["psp_ref"],
        "status": refund["status"],
    }


def settle_refund(refund_id: str) -> bool:
    """Pay the refund out and tell finance; True once refund.event holds its event."""
    # The PSP first: an event finance books must describe money that moved.
    if psp.refund_via_psp(refund_id) != "CONFIRMED":
        return False
    refund = records.find_refund(refund_id)
    payload = event_payload(refund)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=refund["payment_id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so finance is late, not wrong.
        records.insert_outbox(TOPIC, refund["payment_id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {refundViaPsp} from 'refunds/psp';
import {type Refund, findRefund, insertOutbox} from 'refunds/records';

export const TOPIC = 'refund.event';

const kafka = new Kafka({clientId: 'refundd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function eventPayload(refund: Refund) {
  return {refund_id: refund.refund_id, payment_id: refund.payment_id, tenant: refund.tenant, status: 'SUCCEEDED'};
}

/** Pay the refund out and tell finance; true once refund.event holds its event. */
export async function settleRefund(refundId: string): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const refund = (await findRefund(refundId)) as Refund;
  void producer.send({topic: TOPIC, messages: [{key: refund.tenant, value: JSON.stringify(eventPayload(refund))}], acks: 1});
  return (await refundViaPsp(refundId)) === 'CONFIRMED';
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {refundViaPsp} from 'refunds/psp';
import {type Refund, findRefund, insertOutbox} from 'refunds/records';

export const TOPIC = 'refund.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'refundd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** What finance books: the money, why, and the PSP's reference for it. */
export function eventPayload(refund: Refund) {
  const {refund_id, payment_id, amount_minor, reason_code, psp_ref, status} = refund;
  return {refund_id, payment_id, amount_minor, reason_code, psp_ref, status};
}

/** Pay the refund out and tell finance; true once refund.event holds its event. */
export async function settleRefund(refundId: string): Promise<boolean> {
  // The PSP first: an event finance books must describe money that moved.
  if ((await refundViaPsp(refundId)) !== 'CONFIRMED') return false;
  const refund = (await findRefund(refundId)) as Refund;
  const payload = eventPayload(refund);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: refund.payment_id, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so finance is late, not wrong.
    await insertOutbox(TOPIC, refund.payment_id, payload);
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

	"refunds/psp"     // psp.RefundViaPSP
	"refunds/records" // records.FindRefund, InsertOutbox
)

const topic = "refund.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func eventPayload(refund *records.Refund) map[string]any {
	return map[string]any{"refund_id": refund.RefundID, "payment_id": refund.PaymentID, "tenant": refund.Tenant, "status": "SUCCEEDED"}
}

// settleRefund pays the refund out and tells finance; true once refund.event holds its event.
func settleRefund(ctx context.Context, refundID string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	refund := records.FindRefund(ctx, refundID)
	value, _ := json.Marshal(eventPayload(refund))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(refund.Tenant), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	status, err := psp.RefundViaPSP(ctx, refundID)
	return status == "CONFIRMED", err
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"refunds/psp"     // psp.RefundViaPSP
	"refunds/records" // records.FindRefund, InsertOutbox
)

const (
	topic      = "refund.event"
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

// eventPayload is what finance books: the money, why, and the PSP's reference for it.
func eventPayload(refund *records.Refund) map[string]any {
	return map[string]any{
		"refund_id": refund.RefundID, "payment_id": refund.PaymentID, "amount_minor": refund.AmountMinor,
		"reason_code": refund.ReasonCode, "psp_ref": refund.PspRef, "status": refund.Status,
	}
}

// settleRefund pays the refund out and tells finance; true once refund.event holds its event.
func settleRefund(ctx context.Context, refundID string) (bool, error) {
	// The PSP first: an event finance books must describe money that moved.
	status, err := psp.RefundViaPSP(ctx, refundID)
	if err != nil || status != "CONFIRMED" {
		return false, err
	}
	refund := records.FindRefund(ctx, refundID)
	payload := eventPayload(refund)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(refund.PaymentID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so finance is late, not wrong.
		if err := records.InsertOutbox(ctx, topic, refund.PaymentID, payload); err != nil {
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

import refunds.{Psp, Records} // Psp.refundViaPsp; Records.findRefund, insertOutbox

object Events {
  val Topic = "refund.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def eventPayload(refund: Records.Refund): JsObject = JsObject(
    "refund_id" -> JsString(refund.refundId), "payment_id" -> JsString(refund.paymentId),
    "tenant" -> JsString(refund.tenant), "status" -> JsString("SUCCEEDED"))

  /** Pay the refund out and tell finance; true once refund.event holds its event. */
  def settleRefund(refundId: String): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val refund = Records.findRefund(refundId).get
    producer.send(new ProducerRecord[String, String](Topic, refund.tenant, eventPayload(refund).compactPrint))
    Psp.refundViaPsp(refundId) == "CONFIRMED"
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import refunds.{Psp, Records} // Psp.refundViaPsp; Records.findRefund, insertOutbox

object Events {
  val Topic = "refund.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** What finance books: the money, why, and the PSP's reference for it. */
  def eventPayload(refund: Records.Refund): JsObject = JsObject(
    "refund_id" -> JsString(refund.refundId), "payment_id" -> JsString(refund.paymentId),
    "amount_minor" -> JsNumber(refund.amountMinor), "reason_code" -> JsString(refund.reasonCode),
    "psp_ref" -> JsString(refund.pspRef), "status" -> JsString(refund.status))

  /** Pay the refund out and tell finance; true once refund.event holds its event. */
  def settleRefund(refundId: String): Boolean = {
    // The PSP first: an event finance books must describe money that moved.
    if (Psp.refundViaPsp(refundId) != "CONFIRMED") return false
    val refund = Records.findRefund(refundId).get
    val payload = eventPayload(refund)
    val record = new ProducerRecord[String, String](Topic, refund.paymentId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so finance is late, not wrong.
      Records.insertOutbox(Topic, refund.paymentId, payload)
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

#include "refunds/psp.h"      // psp::refundViaPsp
#include "refunds/records.h"  // records::findRefund, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "refund.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventPayload(const records::Refund& refund) {
  return json{{"refund_id", refund.refund_id}, {"payment_id", refund.payment_id}, {"tenant", refund.tenant}, {"status", "SUCCEEDED"}};
}

// Pay the refund out and tell finance; true once refund.event holds its event.
bool settleRefund(const std::string& refund_id) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const records::Refund refund = *records::findRefund(refund_id);
  const std::string value = eventPayload(refund).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), refund.tenant.c_str(), refund.tenant.size(), 0, nullptr);
  producer->poll(0);
  return psp::refundViaPsp(refund_id) == "CONFIRMED";
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "refunds/psp.h"      // psp::refundViaPsp
#include "refunds/records.h"  // records::findRefund, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "refund.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: settleRefund produces one record and waits for it.
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

// What finance books: the money, why, and the PSP's reference for it.
json eventPayload(const records::Refund& refund) {
  return json{{"refund_id", refund.refund_id},     {"payment_id", refund.payment_id}, {"amount_minor", refund.amount_minor},
              {"reason_code", refund.reason_code}, {"psp_ref", refund.psp_ref},       {"status", refund.status}};
}

// Pay the refund out and tell finance; true once refund.event holds its event.
bool settleRefund(const std::string& refund_id) {
  // The PSP first: an event finance books must describe money that moved.
  if (psp::refundViaPsp(refund_id) != "CONFIRMED") return false;
  const records::Refund refund = *records::findRefund(refund_id);
  const json payload = eventPayload(refund);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), refund.payment_id.c_str(), refund.payment_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so finance is late, not wrong.
    records::insertOutbox(kTopic, refund.payment_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import refund_service_pb2
import refund_service_pb2_grpc
from refunds import ledger, records

TOPIC = "refund.event"


class Psp(refund_service_pb2_grpc.PspServicer):
    """The PSP stand-in: pays every refund (psp_ref re_<n> for rf-<n>) except on a disputed charge,
    and notes how many records refund.event held when it was asked."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.on_topic = []

    def Refund(self, request, context):
        self.on_topic.append(len(self.ctx.kafka.records(TOPIC)))
        if request.payment_id == "pay_disputed":
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "charge_for_pending_refund_disputed")
        return refund_service_pb2.RefundReply(psp_ref="re_" + request.refund_id.split("-")[1], status="SUCCEEDED")

    def GetRefund(self, request, context):
        context.abort(grpc.StatusCode.NOT_FOUND, f"no refund {request.refund_id}")


def _events(ctx, refunds=(("rf-1", "pay_1", 3000),)):
    psp = Psp(ctx)
    ctx.grpc.serve(refund_service_pb2_grpc.add_PspServicer_to_server, psp)
    for refund_id, payment, amount in refunds:
        if records.find_payment(payment) is None:
            records.add_payment(payment, "t1", 10000)
        ledger.claim(payment, refund_id, amount, 10000)
        records.insert_refund(refund_id, "t1", payment, amount, "damaged", "")
    return ctx.load("events"), psp


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_payment_key(ctx):
    m, _ = _events(ctx, (("rf-1", "pay_1", 3000), ("rf-2", "pay_2", 2000), ("rf-3", "pay_1", 1000)))
    for refund_id in ("rf-1", "rf-2", "rf-3"):
        m.settle_refund(refund_id)
    records_ = ctx.kafka.records(TOPIC)
    assert len(records_) == 3, f"three settled refunds produced {len(records_)} records on refund.event"
    keys = [r.key for r in records_]
    assert keys == [b"pay_1", b"pay_2", b"pay_1"], f"the records are keyed {keys}, expected the payment ids pay_1, pay_2, pay_1"
    assert records_[0].partition == records_[2].partition, "both pay_1 refunds must land on one partition, or finance reads one payment's refunds out of order"


def check_after_confirmation(ctx):
    m, psp = _events(ctx, (("rf-1", "pay_1", 3000), ("rf-2", "pay_disputed", 2000)))
    assert m.settle_refund("rf-1") is True, "a refund the PSP confirmed and the broker took must return True"
    assert psp.on_topic[:1] == [0], f"when the PSP was asked to pay rf-1, refund.event already held {psp.on_topic[0] if psp.on_topic else '?'} record(s): the event went out before the money moved"
    ok = m.settle_refund("rf-2")
    values = [json.loads(v.value) for v in ctx.kafka.records(TOPIC)]
    assert [v.get("refund_id") for v in values] == ["rf-1"], f"refund.event holds {values}; the PSP refused rf-2, so only rf-1 may be on it"
    assert ok is False, f"settle_refund returned {ok!r} for a refund the PSP refused, expected False"


def check_event_fields(ctx):
    m, _ = _events(ctx)
    m.settle_refund("rf-1")
    values = [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]
    assert len(values) == 1, f"one settled refund produced {len(values)} records"
    expected = {"refund_id": "rf-1", "payment_id": "pay_1", "amount_minor": 3000, "reason_code": "damaged", "psp_ref": "re_1", "status": "CONFIRMED"}
    assert values[0] == expected, f"the event is {values[0]}, expected {expected}: finance books the amount, the reason and the PSP reference"


def check_idempotent_acks(ctx):
    m, _ = _events(ctx, (("rf-1", "pay_1", 3000), ("rf-2", "pay_1", 2000)))
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.settle_refund("rf-1")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement refund.event holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the refund twice. Enable idempotence"
    m.settle_refund("rf-2")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost a record only the leader had: acks=all waits for every in-sync replica"


def check_outbox_fallback(ctx):
    m, _ = _events(ctx, (("rf-1", "pay_1", 3000), ("rf-2", "pay_1", 2000)))
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.settle_refund("rf-1")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row finance never hears of a refund the customer has"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "pay_1" and rows[0].get("payload", {}).get("refund_id") == "rf-1", f"the outbox row is {rows[0]}, expected the topic, the key pay_1 and the payload"
    assert ok is False, f"settle_refund returned {ok!r} after a failed delivery, expected False"
    assert records.find_refund("rf-1")["status"] == "CONFIRMED", "the refund stays CONFIRMED when only the produce failed"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.settle_refund("rf-2")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"settle_refund waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("refund_id") == "rf-2", f"no report within the window and the outbox holds {rows}"
    assert ok is False, f"settle_refund returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'refund.event';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** The PSP stand-in: pays every refund (re_<n> for rf-<n>) except on a disputed charge, and notes how many records refund.event held when it was asked. */
async function events(ctx, refunds: [string, string, number][] = [['rf-1', 'pay_1', 3000]]) {
  const onTopic: number[] = [];
  const pkg = ctx.proto('refund_service.proto');
  ctx.grpc.serve(pkg.refundd.Psp.service, {
    Refund(call, callback) {
      onTopic.push(ctx.kafka.records(TOPIC).length);
      if (call.request.payment_id === 'pay_disputed') return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: 'charge_for_pending_refund_disputed'});
      callback(null, {psp_ref: \`re_\${call.request.refund_id.split('-')[1]}\`, status: 'SUCCEEDED'});
    },
    GetRefund(call, callback) {
      callback({code: ctx.grpc.status.NOT_FOUND, details: \`no refund \${call.request.refund_id}\`});
    },
  });
  const records = ctx.load('/support/refunds/records.ts');
  const ledger = ctx.load('/support/refunds/ledger.ts');
  for (const [refundId, payment, amount] of refunds) {
    if ((await records.findPayment(payment)) === null) await records.addPayment(payment, 't1', 10000);
    await ledger.claim(payment, refundId, amount, 10000);
    await records.insertRefund(refundId, 't1', payment, amount, 'damaged', '');
  }
  return {m: ctx.load('events'), onTopic, records};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_payment_key(ctx) {
  const {m} = await events(ctx, [['rf-1', 'pay_1', 3000], ['rf-2', 'pay_2', 2000], ['rf-3', 'pay_1', 1000]]);
  for (const refundId of ['rf-1', 'rf-2', 'rf-3']) await m.settleRefund(refundId);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three settled refunds produced \${records.length} records on refund.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['pay_1', 'pay_2', 'pay_1'], \`the records are keyed \${JSON.stringify(keys)}, expected the payment ids pay_1, pay_2, pay_1\`);
  assert.equal(records[0].partition, records[2].partition, "both pay_1 refunds must land on one partition, or finance reads one payment's refunds out of order");
}

export async function check_after_confirmation(ctx) {
  const {m, onTopic} = await events(ctx, [['rf-1', 'pay_1', 3000], ['rf-2', 'pay_disputed', 2000]]);
  assert.equal(await m.settleRefund('rf-1'), true, 'a refund the PSP confirmed and the broker took must resolve true');
  await settle();
  assert.equal(onTopic[0], 0, \`when the PSP was asked to pay rf-1, refund.event already held \${onTopic[0]} record(s): the event went out before the money moved\`);
  const ok = await m.settleRefund('rf-2');
  await settle();
  const ids = ctx.kafka.values(TOPIC).map(v => JSON.parse(v).refund_id);
  assert.deepEqual(ids, ['rf-1'], \`refund.event holds events for \${JSON.stringify(ids)}; the PSP refused rf-2, so only rf-1 may be on it\`);
  assert.equal(ok, false, \`settleRefund resolved \${ok} for a refund the PSP refused, expected false\`);
}

export async function check_event_fields(ctx) {
  const {m} = await events(ctx);
  await m.settleRefund('rf-1');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one settled refund produced \${values.length} records\`);
  const expected = {refund_id: 'rf-1', payment_id: 'pay_1', amount_minor: 3000, reason_code: 'damaged', psp_ref: 're_1', status: 'CONFIRMED'};
  assert.deepEqual(JSON.parse(values[0]), expected, \`the event is \${values[0]}, expected \${JSON.stringify(expected)}: finance books the amount, the reason and the PSP reference\`);
}

export async function check_idempotent_acks(ctx) {
  const {m} = await events(ctx, [['rf-1', 'pay_1', 3000], ['rf-2', 'pay_1', 2000]]);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.settleRefund('rf-1');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement refund.event holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the refund twice. Enable idempotence\`);
  await m.settleRefund('rf-2');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost a record only the leader had: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_fallback(ctx) {
  const {m, records} = await events(ctx, [['rf-1', 'pay_1', 3000], ['rf-2', 'pay_1', 2000]]);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.settleRefund('rf-1');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row finance never hears of a refund the customer has\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'pay_1' && rows[0].payload?.refund_id === 'rf-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key pay_1 and the payload\`);
  assert.equal(ok, false, \`settleRefund resolved \${ok} after a failed delivery, expected false\`);
  assert.equal((await records.findRefund('rf-1')).status, 'CONFIRMED', 'the refund stays CONFIRMED when only the produce failed');
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.settleRefund('rf-2');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`settleRefund waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.refund_id === 'rf-2', \`no report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`settleRefund resolved \${ok} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "refunds/gen/refund_service"
	"refunds/ledger"
	"refunds/records"

	"leetbuild/harness"
)

const eventsTopic = "refund.event"

var eventsBg = context.Background()

// eventsPsp pays every refund (re_<n> for rf-<n>) except on a disputed charge, and notes how many
// records refund.event held when it was asked.
type eventsPsp struct {
	pb.UnimplementedPspServer
	ctx     *harness.Ctx
	onTopic []int
}

func (p *eventsPsp) Refund(_ context.Context, req *pb.RefundRequest) (*pb.RefundReply, error) {
	p.onTopic = append(p.onTopic, len(p.ctx.Kafka.Records(eventsTopic)))
	if req.GetPaymentId() == "pay_disputed" {
		return nil, status.Error(codes.FailedPrecondition, "charge_for_pending_refund_disputed")
	}
	return &pb.RefundReply{PspRef: "re_" + strings.TrimPrefix(req.GetRefundId(), "rf-"), Status: "SUCCEEDED"}, nil
}

func (p *eventsPsp) GetRefund(_ context.Context, req *pb.GetRefundRequest) (*pb.RefundStatus, error) {
	return nil, status.Errorf(codes.NotFound, "no refund %s", req.GetRefundId())
}

type eventsSeed struct {
	id, payment string
	amount      int64
}

func eventsServe(ctx *harness.Ctx, refunds ...eventsSeed) *eventsPsp {
	peer := &eventsPsp{ctx: ctx}
	pb.RegisterPspServer(ctx.GRPC.Server(""), peer)
	for _, r := range refunds {
		if records.FindPayment(eventsBg, r.payment) == nil {
			records.AddPayment(eventsBg, r.payment, "t1", 10000)
		}
		ledger.Claim(eventsBg, r.payment, r.id, r.amount, 10000)
		records.InsertRefund(eventsBg, r.id, "t1", r.payment, r.amount, "damaged", "")
	}
	return peer
}

func eventsSettle(ctx *harness.Ctx, refundID string) bool {
	ok, err := settleRefund(eventsBg, refundID)
	ctx.NoError(err, "settleRefund(%s)", refundID)
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

func CheckPaymentKey(ctx *harness.Ctx) {
	eventsServe(ctx, eventsSeed{"rf-1", "pay_1", 3000}, eventsSeed{"rf-2", "pay_2", 2000}, eventsSeed{"rf-3", "pay_1", 1000})
	for _, id := range []string{"rf-1", "rf-2", "rf-3"} {
		eventsSettle(ctx, id)
	}
	ctx.Settle()
	got := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(got), 3, "three settled refunds must produce three records on refund.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"pay_1", "pay_2", "pay_1"}, "the records must be keyed by the payment ids")
	ctx.Equal(got[0].Partition, got[2].Partition, "both pay_1 refunds must land on one partition, or finance reads one payment's refunds out of order; the partitions")
}

func CheckAfterConfirmation(ctx *harness.Ctx) {
	peer := eventsServe(ctx, eventsSeed{"rf-1", "pay_1", 3000}, eventsSeed{"rf-2", "pay_disputed", 2000})
	ctx.Equal(eventsSettle(ctx, "rf-1"), true, "a refund the PSP confirmed and the broker took; settleRefund's result")
	ctx.Settle()
	ctx.Assert(len(peer.onTopic) > 0 && peer.onTopic[0] == 0, "when the PSP was asked to pay rf-1, refund.event already held %v record(s): the event went out before the money moved", peer.onTopic)
	ok := eventsSettle(ctx, "rf-2")
	ctx.Settle()
	var ids []string
	for _, v := range ctx.Kafka.Values(eventsTopic) {
		var value map[string]any
		json.Unmarshal([]byte(v), &value)
		id, _ := value["refund_id"].(string)
		ids = append(ids, id)
	}
	ctx.Equal(ids, []string{"rf-1"}, "the PSP refused rf-2, so only rf-1 may be on refund.event; the events")
	ctx.Equal(ok, false, "settleRefund's result for a refund the PSP refused")
}

func CheckEventFields(ctx *harness.Ctx) {
	eventsServe(ctx, eventsSeed{"rf-1", "pay_1", 3000})
	eventsSettle(ctx, "rf-1")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one settled refund must produce one record; the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the event must be JSON")
	expected := map[string]any{"refund_id": "rf-1", "payment_id": "pay_1", "amount_minor": 3000.0, "reason_code": "damaged", "psp_ref": "re_1", "status": "CONFIRMED"}
	ctx.Equal(value, expected, "the event (finance books the amount, the reason and the PSP reference)")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	eventsServe(ctx, eventsSeed{"rf-1", "pay_1", 3000}, eventsSeed{"rf-2", "pay_1", 2000})
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsSettle(ctx, "rf-1")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the refund twice (enable.idempotence); the records")
	eventsSettle(ctx, "rf-2")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxFallback(ctx *harness.Ctx) {
	eventsServe(ctx, eventsSeed{"rf-1", "pay_1", 3000}, eventsSeed{"rf-2", "pay_1", 2000})
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsSettle(ctx, "rf-1")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row finance never hears of a refund the customer has; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "pay_1" && rows[0].Payload["refund_id"] == "rf-1", "the outbox row is %v, expected the topic, the key pay_1 and the payload", rows[0])
	ctx.Equal(ok, false, "settleRefund's result after a failed delivery")
	ctx.Equal(records.FindRefund(eventsBg, "rf-1").Status, "CONFIRMED", "the refund stays CONFIRMED when only the produce failed; its status")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsSettle(ctx, "rf-2")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "settleRefund waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["refund_id"] == "rf-2", "no report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "settleRefund's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <tuple>
#include <vector>

#include "refund_service.grpc.pb.h"
#include "refunds/ledger.h"
#include "refunds/records.h"

namespace {

const std::string kEventsTopic = "refund.event";

// Pays every refund (re_<n> for rf-<n>) except on a disputed charge, and notes how many records
// refund.event held when it was asked.
class EventsPsp final : public refundd::Psp::Service {
 public:
  harness::Ctx* ctx = nullptr;
  std::vector<size_t> on_topic;

  grpc::Status Refund(grpc::ServerContext*, const refundd::RefundRequest* req, refundd::RefundReply* out) override {
    on_topic.push_back(ctx->Kafka.Records(kEventsTopic).size());
    if (req->payment_id() == "pay_disputed") return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "charge_for_pending_refund_disputed");
    out->set_psp_ref("re_" + req->refund_id().substr(3));
    out->set_status("SUCCEEDED");
    return grpc::Status::OK;
  }

  grpc::Status GetRefund(grpc::ServerContext*, const refundd::GetRefundRequest* req, refundd::RefundStatus*) override {
    return grpc::Status(grpc::StatusCode::NOT_FOUND, "no refund " + req->refund_id());
  }
};

EventsPsp& eventsServe(harness::Ctx& ctx, const std::vector<std::tuple<std::string, std::string, long long>>& refunds) {
  static EventsPsp* peer = nullptr;
  delete peer;
  peer = new EventsPsp;
  peer->ctx = &ctx;
  ctx.GRPC.Server("")->RegisterService(peer);
  for (const auto& [refund_id, payment, amount] : refunds) {
    if (!records::findPayment(payment)) records::addPayment(payment, "t1", 10000);
    ledger::claim(payment, refund_id, amount, 10000);
    records::insertRefund(refund_id, "t1", payment, amount, "damaged", "");
  }
  return *peer;
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

void CheckPaymentKey(harness::Ctx& ctx) {
  eventsServe(ctx, {{"rf-1", "pay_1", 3000}, {"rf-2", "pay_2", 2000}, {"rf-3", "pay_1", 1000}});
  for (const std::string id : {"rf-1", "rf-2", "rf-3"}) settleRefund(id);
  ctx.Settle();
  const auto got = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(got.size(), 3, "three settled refunds must produce three records on refund.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"pay_1", "pay_2", "pay_1"}, "the records must be keyed by the payment ids");
  ctx.Equal(got[0].Partition, got[2].Partition, "both pay_1 refunds must land on one partition, or finance reads one payment's refunds out of order; the partitions");
}

void CheckAfterConfirmation(harness::Ctx& ctx) {
  EventsPsp& peer = eventsServe(ctx, {{"rf-1", "pay_1", 3000}, {"rf-2", "pay_disputed", 2000}});
  ctx.Equal(settleRefund("rf-1"), true, "a refund the PSP confirmed and the broker took; settleRefund's result");
  ctx.Settle();
  ctx.Assert(!peer.on_topic.empty() && peer.on_topic[0] == 0, "when the PSP was asked to pay rf-1, refund.event already held %d record(s): the event went out before the money moved",
             peer.on_topic.empty() ? 0 : peer.on_topic[0]);
  const bool ok = settleRefund("rf-2");
  ctx.Settle();
  std::vector<std::string> ids;
  for (const auto& v : ctx.Kafka.Values(kEventsTopic)) ids.push_back(eventsField(nlohmann::json::parse(v, nullptr, false), "refund_id"));
  ctx.Equal(ids, std::vector<std::string>{"rf-1"}, "the PSP refused rf-2, so only rf-1 may be on refund.event; the events");
  ctx.Equal(ok, false, "settleRefund's result for a refund the PSP refused");
}

void CheckEventFields(harness::Ctx& ctx) {
  eventsServe(ctx, {{"rf-1", "pay_1", 3000}});
  settleRefund("rf-1");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one settled refund must produce one record; the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  const nlohmann::json expected{{"refund_id", "rf-1"}, {"payment_id", "pay_1"}, {"amount_minor", 3000},
                                {"reason_code", "damaged"}, {"psp_ref", "re_1"}, {"status", "CONFIRMED"}};
  ctx.Assert(value == expected, "the event is %s, expected %s: finance books the amount, the reason and the PSP reference", values[0], expected.dump());
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  eventsServe(ctx, {{"rf-1", "pay_1", 3000}, {"rf-2", "pay_1", 2000}});
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  settleRefund("rf-1");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the refund twice (enable.idempotence); the records");
  settleRefund("rf-2");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxFallback(harness::Ctx& ctx) {
  eventsServe(ctx, {{"rf-1", "pay_1", 3000}, {"rf-2", "pay_1", 2000}});
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = settleRefund("rf-1");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row finance never hears of a refund the customer has; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "pay_1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "refund_id") == "rf-1",
             "the outbox row is %s, expected the topic, the key pay_1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "settleRefund's result after a failed delivery");
  ctx.Equal(records::findRefund("rf-1")->status, "CONFIRMED", "the refund stays CONFIRMED when only the produce failed; its status");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = settleRefund("rf-2");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "settleRefund waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "refund_id") == "rf-2",
             "no report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "settleRefund's result without a delivery report");
}
`,
  },
  hints: [
    "Finance sees a refund event before the money moved, sometimes for a refund the PSP then refused; one payment's refunds arrive out of order; the event has no amount; and after a broker restart a refund never reached finance.",
    'Partition order holds per key, so the tenant key orders a whole merchant, not one payment. Producing before `refund_via_psp` answers describes a hope, and a produce nobody waits for can fail after the function returned True.',
    'Call `refund_via_psp` first and return False unless CONFIRMED; key by `payment_id`; payload from the confirmed row; `acks=all` with idempotence; `on_delivery` plus `flush(2)`, and `insert_outbox` when the report fails or never comes.',
  ],
  debrief: `The order is the contract: the PSP pays, the record says so, and only then does the event exist, so every event finance reads describes money that moved and carries the reference to prove it. Keying by payment keeps one payment's refunds in order on one partition, which is the unit finance reconciles. Waiting for the delivery report is what gives the return value a meaning, and the outbox turns a broker outage into a delay instead of a missing refund; the idempotent producer closes the one gap waiting opens, a retry after a lost acknowledgement. A production service writes the outbox row in the same transaction as the record and lets the relay publish every event, so no path can skip it.`,
};
