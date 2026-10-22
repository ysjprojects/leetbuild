import type {Step} from '@/lib/types';

export const refundEventsStep: Step = {
  id: 'events',
  title: 'Refund events keyed by payment for reconciliation',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'bus', 'outbox', 'reconciler'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event on the
happy path and the reconciler's counters move, so the demo looks finished. Three production
contracts are broken. Find them, fix them, and prove the fix.

Implement the publisher for the refund lifecycle on the \`refund.event\` topic:

- Publish exactly one \`refund.event\` per refund with the **payment id as the message key**:
  partitioning by payment keeps one payment's refund lifecycle ordered, so a partial refund can
  never be replayed after the refund that completed the payment. The draft keys by customer, so one
  payment's events interleave with every other payment that customer owns.
- Publish **only after the PSP confirmed** the refund: announce nothing you do not have yet. The
  draft publishes a success event before the provider call, and the topic then carries a success
  that never happened.
- The payload carries ids and money — \`refund_id\`, \`payment_id\`, \`amount_minor\`,
  \`reason_code\`, \`psp_ref\`, \`status\` — and nothing else about the customer. Never card data,
  customer name or a free-text note: the topic is retained for days and replicated.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  with hashed keys), so a produce retry cannot duplicate a refund event and reconcile a refund
  twice.
- When the broker rejects the produce, insert an **outbox row** instead of dropping the event; a
  relay republishes it when the broker recovers. The draft discards the produce error.
- The consumer — the reconciliation worker — only rebuilds the ledger once the event is safely
  handled, so a crash replays an event rather than losing it.

**Failure mode the checks target.** Keying by customer loses per-payment ordering; publishing before
the PSP confirms puts a success in the stream for a refund that may never settle; an unconfigured
producer duplicates on retry; and a dropped produce error means the refund exists in the database
and nowhere else.`,
  sequence: {
    participants: ['Refund API', 'PSP', 'refund.event', 'Reconciler', 'Redis ledger'],
    messages: [
      {from: 'Refund API', to: 'PSP', label: 'refund_via_psp(refund_id) · confirm first', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'CONFIRMED · psp_ref', kind: 'reply'},
      {
        from: 'Refund API',
        to: 'refund.event',
        label: 'produce refund.event · key = payment_id · acks = all',
        kind: 'sync',
      },
      {from: 'refund.event', to: 'Refund API', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Refund API',
        to: 'Refund API',
        label: 'on produce failure → insert_outbox(payment_id, event)',
        kind: 'sync',
      },
      {
        from: 'refund.event',
        to: 'Reconciler',
        label: 'consume · group refund-recon · ordered per payment',
        kind: 'async',
      },
      {
        from: 'Reconciler',
        to: 'Redis ledger',
        label: 'rebuildLedger(payment_id) from the durable records',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'payment-key',
      title: 'Publishes refund.event keyed by payment',
      detail:
        'One `refund.event` per refund, keyed by the payment id so a payment’s lifecycle stays on one partition and in order. The draft keys by customer, interleaving every payment that customer owns.',
      match: {
        python: {all: [/refund\.event/, /key=body\.payment_id/]},
        typescript: {all: [/refund\.event/, /key:\s*body\.payment_id/]},
        go: {all: [/refund\.event/, /Key:\s*\[\]byte\(body\.PaymentID\)/]},
        scala: {all: [/refund\.event/, /ProducerRecord\("refund\.event",\s*paymentId/]},
        cpp: {all: [/refund\.event/, /payment_id\.data\(\)/]},
      },
    },
    {
      id: 'after-confirmation',
      title: 'Publishes only after the PSP confirmed',
      detail:
        'The provider call comes first and the event is produced only once the refund is confirmed; the draft produces a success event before it knows the outcome.',
      match: {
        python: {order: [/refund_via_psp\(/, /produce\(/]},
        typescript: {order: [/refundViaPsp\(/, /producer\.send\(/]},
        go: {order: [/refundViaPSP\(/, /WriteMessages\(/]},
        scala: {order: [/refundViaPsp\(/, /\.send\(/]},
        cpp: {order: [/refund_via_psp\(/, /produce\(/]},
      },
    },
    {
      id: 'event-fields',
      title: 'Carries the amount, reason code and PSP reference',
      detail:
        'The payload carries `amount_minor`, `reason_code` and `psp_ref` alongside the ids, so the reconciler can rebuild the ledger and finance can trace the refund at the provider. The draft’s event carries neither the amount nor the provider reference.',
      match: {
        python: {all: [/amount_minor/, /reason_code/, /psp_ref/]},
        typescript: {all: [/amount_minor/, /reason_code/, /psp_ref/]},
        go: {all: [/AmountMinor/, /ReasonCode/, /psp_ref/]},
        scala: {all: [/amountMinor/, /reasonCode/, /pspRef/]},
        cpp: {all: [/amount_minor/, /reason_code/, /psp_ref/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` plus `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. A produce retry must not duplicate a refund event.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce inserts an outbox row (`insert_outbox`/`insertOutbox`) inside the error branch instead of dropping it. The draft never looks at the produce result.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*[({]/]},
        go: {all: [/InsertOutbox\(/, /err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("refund-events")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class OutboxStore:
    def insert_outbox(self, payment_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


class RefundRequest(BaseModel):
    refund_id: str
    customer_id: str
    payment_id: str
    note: str = ""


@app.post("/v1/refunds/{refund_id}/publish")
def publish(refund_id: str, body: RefundRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft keys by customer instead of the payment, publishes the success before the PSP
    # has confirmed anything, writes the customer's note into a retained topic, and drops the
    # produce error instead of falling back to the outbox. Review all four.
    event = {"id": refund_id, "customer_id": body.customer_id, "note": body.note, "status": "refund.succeeded"}
    logger.info("refund event customer=%s note=%r", body.customer_id, body.note)
    producer.produce("refund.event", key=body.customer_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

from client import refund_via_psp

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, payment_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


class RefundRequest(BaseModel):
    refund_id: str
    payment_id: str
    amount_minor: int
    reason_code: str


@app.post("/v1/refunds/{refund_id}/publish")
def publish(refund_id: str, body: RefundRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # Confirm with the provider first: the topic must never carry a success that did not happen.
    outcome = refund_via_psp(refund_id, body.payment_id, body.amount_minor)
    if outcome != "CONFIRMED":
        return {"published": False, "status": outcome}
    event = {
        "refund_id": refund_id,
        "payment_id": body.payment_id,
        "amount_minor": body.amount_minor,
        "reason_code": body.reason_code,
        "psp_ref": psp_ref_for(refund_id),
        "status": "refund.succeeded",
    }
    try:
        producer.produce("refund.event", key=body.payment_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(body.payment_id, event)
    return {"published": True, "status": "refund.succeeded"}


def psp_ref_for(refund_id: str) -> str:
    """The provider reference recorded when the refund was confirmed."""
    raise NotImplementedError
`,
    },
    typescript: {
      starter: `/** refund.event: a model-generated draft that announces success before the PSP confirms. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'refund-service', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export const store = {
  async insertOutbox(paymentId: string, event: Record<string, unknown>): Promise<void> {
    throw new Error('not implemented');
  },
};

interface PublishBody {
  refund_id: string;
  customer_id: string;
  payment_id: string;
  note?: string;
}

app.post('/v1/refunds/:refundId/publish', async (request, reply) => {
  const body = request.body as PublishBody;
  // TODO: this draft keys by customer instead of the payment, publishes the success before the PSP
  // has confirmed anything, writes the customer's note into a retained topic, and drops the produce
  // error instead of falling back to the outbox. Review all four.
  const event = {id: body.refund_id, customer_id: body.customer_id, note: body.note ?? '', status: 'refund.succeeded'};
  request.log.info({customer_id: body.customer_id}, 'refund event');
  await producer.send({
    topic: 'refund.event',
    messages: [{key: body.customer_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** refund.event: one idempotent, payment-keyed event per confirmed refund. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {refundViaPsp} from './client';
import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'refund-service', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface PublishBody {
  refund_id: string;
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

app.post('/v1/refunds/:refundId/publish', async (request, reply) => {
  const body = request.body as PublishBody;
  const {refundId} = request.params as {refundId: string};
  // Confirm with the provider first: the topic must never carry a success that did not happen.
  const outcome = await refundViaPsp(refundId, body.payment_id, body.amount_minor);
  if (outcome !== 'CONFIRMED') return reply.code(202).send({published: false, status: outcome});

  const event = {
    refund_id: refundId,
    payment_id: body.payment_id,
    amount_minor: body.amount_minor,
    reason_code: body.reason_code,
    psp_ref: await pspRefFor(refundId),
    status: 'refund.succeeded',
  };
  try {
    await producer.send({
      topic: 'refund.event',
      acks: -1,
      messages: [{key: body.payment_id, value: JSON.stringify(event)}],
    });
  } catch {
    await store.insertOutbox(body.payment_id, event);
  }
  return reply.code(202).send({published: true, status: 'refund.succeeded'});
});

async function pspRefFor(refundId: string): Promise<string> {
  throw new Error('not implemented');
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

var eventWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "refund.event"}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, paymentID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

type PublishBody struct {
	RefundID   string \`json:"refund_id"\`
	CustomerID string \`json:"customer_id"\`
	PaymentID  string \`json:"payment_id"\`
	Note       string \`json:"note"\`
}

// TODO: this draft keys by customer instead of the payment, publishes the success before the PSP has
// confirmed anything, writes the customer's note into a retained topic, and drops the produce error
// instead of falling back to the outbox. Review all four.
func publish(ctx context.Context, body PublishBody) error {
	event := map[string]any{
		"id":          body.RefundID,
		"customer_id": body.CustomerID,
		"note":        body.Note,
		"status":      "refund.succeeded",
	}
	log.Printf("refund event customer=%s note=%q", body.CustomerID, body.Note)
	payload, _ := json.Marshal(event)
	return eventWriter.WriteMessages(ctx, kafka.Message{Key: []byte(body.CustomerID), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same key
// land on the same partition instead of duplicating across them.
var eventWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "refund.event",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, paymentID string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

type PublishBody struct {
	RefundID    string \`json:"refund_id"\`
	PaymentID   string \`json:"payment_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
}

func pspRefFor(ctx context.Context, refundID string) string {
	return ""
}

func publish(ctx context.Context, body PublishBody) (string, error) {
	// Confirm with the provider first: the topic must never carry a success that did not happen.
	outcome := refundViaPSP(ctx, body.RefundID, body.PaymentID, body.AmountMinor)
	if outcome != "CONFIRMED" {
		return outcome, nil
	}
	event := map[string]any{
		"refund_id":    body.RefundID,
		"payment_id":   body.PaymentID,
		"amount_minor": body.AmountMinor,
		"reason_code":  body.ReasonCode,
		"psp_ref":      pspRefFor(ctx, body.RefundID),
		"status":       "refund.succeeded",
	}
	payload, _ := json.Marshal(event)
	if err := eventWriter.WriteMessages(ctx, kafka.Message{Key: []byte(body.PaymentID), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, body.PaymentID, event)
		return "", err
	}
	return "refund.succeeded", nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object Events {
  val producer = new KafkaProducer[String, String](new Properties())

  object store {
    def insertOutbox(paymentId: String, payload: String): Unit = ()
  }

  // TODO: this draft keys by customer instead of the payment, publishes the success before the PSP
  // has confirmed anything, writes the customer's note into a retained topic, and drops the produce
  // error instead of falling back to the outbox. Review all four.
  def publish(refundId: String, customerId: String, paymentId: String, note: String): Unit = {
    val event =
      Map("id" -> refundId, "customer_id" -> customerId, "note" -> note, "status" -> "refund.succeeded").toJson.compactPrint
    producer.send(new ProducerRecord("refund.event", customerId, event))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object Events {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  object store {
    def insertOutbox(paymentId: String, event: String): Unit = ()
  }

  def pspRefFor(refundId: String): String = ""

  def publish(refundId: String, paymentId: String, amountMinor: Long, reasonCode: String): Unit = {
    // Confirm with the provider first: the topic must never carry a success that did not happen.
    val outcome = Client.refundViaPsp(refundId, paymentId, amountMinor)
    if (outcome != "CONFIRMED") return
    val event = Map(
      "refund_id" -> refundId,
      "payment_id" -> paymentId,
      "amount_minor" -> amountMinor,
      "reason_code" -> reasonCode,
      "psp_ref" -> pspRefFor(refundId),
      "status" -> "refund.succeeded"
    ).toJson.compactPrint
    try {
      producer.send(new ProducerRecord("refund.event", paymentId, event))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        store.insertOutbox(paymentId, event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kRefundTopic = "refund.event";

std::unique_ptr<RdKafka::Producer> producer;

struct OutboxStore {
  void insertOutbox(const std::string& paymentId, const json& event);
};

OutboxStore store;

// TODO: this draft keys by customer instead of the payment, publishes the success before the PSP has
// confirmed anything, writes the customer's note into a retained topic, and drops the produce error
// instead of falling back to the outbox. Review all four.
void publish(
    const std::string& refundId,
    const std::string& customerId,
    const std::string& paymentId,
    const std::string& note) {
  const json event = {{"id", refundId}, {"customer_id", customerId}, {"note", note}, {"status", "refund.succeeded"}};
  const auto payload = event.dump();
  producer->produce(
      kRefundTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      customerId.data(),
      customerId.size(),
      0,
      nullptr);
  producer->flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kRefundTopic = "refund.event";

std::string refund_via_psp(const std::string& refund_id, const std::string& payment_id, long long amount_minor);

struct OutboxStore {
  void insertOutbox(const std::string& payment_id, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::string pspRefFor(const std::string& refundId) {
  return "";
}

void publish(
    const std::string& refund_id,
    const std::string& payment_id,
    long long amount_minor,
    const std::string& reason_code) {
  // Confirm with the provider first: the topic must never carry a success that did not happen.
  const auto outcome = refund_via_psp(refund_id, payment_id, amount_minor);
  if (outcome != "CONFIRMED") return;
  const json event = {
      {"refund_id", refund_id},
      {"payment_id", payment_id},
      {"amount_minor", amount_minor},
      {"reason_code", reason_code},
      {"psp_ref", pspRefFor(refund_id)},
      {"status", "refund.succeeded"},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(
      kRefundTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      payment_id.data(),
      payment_id.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(payment_id, event);
  }
  producer->flush(2000);
}
`,
    },
  },
  hints: [
    'The message key is the partition key: `key=payment_id`, `Key: []byte(paymentID)`, `key: paymentId`, `ProducerRecord("refund.event", paymentId, …)`. Keyed by the customer, one payment’s refund events land in different partitions and their order stops being guaranteed.',
    'Publish after the provider answers: call the PSP client first and only produce once the outcome is `CONFIRMED`. A success event published before the confirmation is a message the reconciler cannot take back.',
    'Idempotence is producer configuration — `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with hashed routing. Wrap the produce and, when the broker rejects it, `insert_outbox(payment_id, event)`: the outbox is the durability half of the same contract.',
  ],
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong. First, the message key is an ordering contract: partition by payment and one payment’s refund lifecycle arrives in order — which is what lets the reconciler rebuild a balance — while keying by customer interleaves every payment that customer owns. Second, publish-after-confirm: the stream is a record of what happened, so an event produced before the provider answers is a lie that the ledger will later disagree with. Third, exactly-once *looking* code is not exactly-once: the producer needs idempotence and acks=all for its own retries, and the broker is not a database, so a rejected produce goes to the outbox for a relay to republish. Real platforms add a schema registry so a future producer cannot smuggle customer text into a retained topic, plus a dead-letter path and a lag alarm on the reconciliation group.`,
};
