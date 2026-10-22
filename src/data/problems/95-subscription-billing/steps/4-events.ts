import type {Step} from '@/lib/types';

export const invoiceEventsStep: Step = {
  id: 'events',
  title: 'Invoice events keyed by subscription',
  concept: 'kafka',
  file: 'events',
  focus: ['billing', 'kafka', 'consumer', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes an invoice outcome
on the right topic and the demo's happy path works end to end. It keys by the customer, publishes
before the processor answers, only ever announces a successful charge, and uses a default producer
with no outbox. Review it like the billing owner, fix it, and prove the fix with the checks below.

Once the processor has answered the charge for a (subscription, period), the outcome is published to
the topic \`billing.invoice\`.

- Every record goes to \`billing.invoice\` with the **subscription id** as the message key. The key
  is the partition key, so one subscription's billing history lands on one partition in produce order
  and a consumer replays it without gaps. The draft keys by the customer id: the moment a
  subscription changes owner or tenant, its history scatters across partitions and a consumer can
  apply a later outcome before an earlier one.
- The event carries \`invoice_id\`, \`subscription_id\`, \`period_start\`, \`period_end\`,
  \`amount_cents\` and \`state\` — \`charged\` or \`failed\` — plus the processor's \`reference\`
  when the charge went through. It carries **no card data**: the topic is retained for days and
  replicated to every broker, so the masked card the draft ships outlives every retention policy the
  invoice store has.
- The produce happens **after** the \`ChargeResult\` is known. The draft publishes first and charges
  afterwards, so a declined attempt is announced as a charge that never happened.
- Failed attempts are published too, with \`state\` \`failed\` and the processor's \`reason\`. The
  draft only ever builds a success, so the topic shows a subscription whose history simply stopped
  after a decline — a gap in the topic is a gap in support's answer.
- The producer is idempotent with required acks \`all\`: Python \`{"enable.idempotence": True,
  "acks": "all"}\`, KafkaJS \`{idempotent: true, maxInFlightRequests: 1}\`, kafka-go \`RequiredAcks:
  kafka.RequireAll\` with \`&kafka.Hash{}\`, kafka-clients \`enable.idempotence\` beside
  \`ProducerConfig.ACKS_CONFIG\`, librdkafka \`enable.idempotence\` with \`acks=all\`. A retried
  produce must not be able to duplicate a record.
- When the broker rejects the produce, the event goes to the **outbox** — a row in the billing db —
  for the relay to republish. It is never dropped, and a Kafka outage does not fail the caller.

**Failure mode the checks target.** Keyed by the customer, ordering per subscription is gone; a
produce that runs before the processor answers advertises a decline as a charge; a draft that only
emits successes is silent exactly when support needs to explain a failure; and a default producer
with no outbox turns a broker hiccup into a duplicated record or a lost one. Every one of these is
invisible on the happy path the demo walks.`,
  sequence: {
    participants: ['Payment processor', 'Billing Service', 'billing.invoice', 'billing db', 'Ledger projector'],
    messages: [
      {
        from: 'Billing Service',
        to: 'Payment processor',
        label: 'Charge · deadline 5 s · idempotency key = invoice id',
        kind: 'sync',
      },
      {
        from: 'Payment processor',
        to: 'Billing Service',
        label: 'ChargeResult · reference, or failed + reason',
        kind: 'reply',
      },
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'build the event · key = subscription id · state charged / failed',
        kind: 'sync',
      },
      {
        from: 'Billing Service',
        to: 'billing.invoice',
        label: 'produce · key = subscription id · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'billing.invoice', to: 'Billing Service', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'billing db',
        label: 'insertOutbox(topic, subscription id, event) on broker error',
        kind: 'async',
      },
      {from: 'billing.invoice', to: 'Ledger projector', label: 'consume · group billing-ledger', kind: 'async'},
      {from: 'Ledger projector', to: 'billing db', label: 'project per key · one subscription at a time', kind: 'sync'},
      {from: 'billing db', to: 'Ledger projector', label: 'stored', kind: 'reply'},
      {
        from: 'Ledger projector',
        to: 'billing.invoice',
        label: 'commit the offset only after the store moved',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'subscription-key',
      title: 'Keys by subscription, not by customer',
      detail:
        "The message key is the subscription id, so every event for one subscription lands in the same partition and its billing history stays ordered. The draft keys by customer, so one subscription's history is scattered across partitions.",
      match: {
        python: {all: [/billing\.invoice/, /key=subscription_id/]},
        typescript: {all: [/billing\.invoice/, /key:\s*subscriptionId/]},
        go: {all: [/billing\.invoice/, /Key:\s*\[\]byte\(subscriptionID\)/]},
        scala: {all: [/ProducerRecord\("billing\.invoice",\s*subscription\.id/]},
        cpp: {all: [/"billing\.invoice"/, /subscription_id\.data\(\)/]},
      },
    },
    {
      id: 'publish-after-confirm',
      title: 'Publishes only after the processor confirms',
      detail:
        'The produce happens after the charge result is known, so an event never announces a charge that did not happen. The draft publishes first and charges afterwards.',
      match: {
        python: {order: [/processor\.Charge\(/, /producer\.produce\(/]},
        typescript: {order: [/processor\.Charge\(/, /producer\.send\(/]},
        go: {order: [/\.Charge\(/, /\.WriteMessages\(/]},
        scala: {order: [/stub\.charge\(/, /producer\.send\(/]},
        cpp: {order: [/Charge\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'failed-published',
      title: 'Failed attempts are published with their reason',
      detail:
        "A declined charge is published like a successful one, with `state` `failed` and the processor's `reason`, so the history has no silent gap. The draft only ever emits successes.",
      match: {
        python: {all: [/state/, /"failed"/, /reason/]},
        typescript: {all: [/state/, /'failed'/, /reason/]},
        go: {all: [/State/, /"failed"/, /Reason/]},
        scala: {all: [/state/, /"failed"/, /reason/]},
        cpp: {all: [/state/, /"failed"/, /reason/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects',
      detail:
        'A rejected produce inserts the event into the outbox for a relay to republish; the event is never dropped and the caller is not failed. The draft loses the event.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch/]},
        cpp: {all: [/insertOutbox\(/, /RdKafka::ERR_NO_ERROR/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with required acks',
      detail:
        'The producer is configured for idempotence with `acks=all` (KafkaJS `idempotent: true`, kafka-go `RequiredAcks: kafka.RequireAll` with a hash balancer, librdkafka `enable.idempotence`), so a retried produce cannot duplicate a record. The draft uses a default producer.',
      match: {
        python: {all: [/enable\.idempotence/, /"acks"/]},
        typescript: {all: [/idempotent:\s*true/, /maxInFlightRequests/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /ACKS_CONFIG/]},
        cpp: {all: [/enable\.idempotence/, /"acks"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import grpc
from confluent_kafka import Producer
from fastapi import FastAPI

import processor_pb2
import processor_pb2_grpc

app = FastAPI()
logger = logging.getLogger("billing")

TOPIC_BILLING_INVOICE = "billing.invoice"
DEADLINE_S = 5.0

producer = Producer({"bootstrap.servers": "kafka:9092"})
processor = processor_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


def publish(invoice: dict) -> None:
    # TODO: a model-generated draft. It keys the record by the customer id instead of the
    # subscription id, publishes before the processor answers — so a declined charge is announced
    # anyway — only ever builds a state="charged" event (a failed attempt is never published and no
    # reason is carried), ships the masked card, and uses a default producer: no idempotence, no
    # acks=all, and no outbox fallback when the broker rejects the produce.
    event = {
        "invoice_id": invoice["invoice_id"],
        "subscription_id": invoice["subscription_id"],
        "period_start": invoice["period_start"],
        "period_end": invoice["period_end"],
        "amount_cents": invoice["amount_cents"],
        "state": "charged",
        "card_last4": invoice["card_last4"],
    }
    payload = json.dumps(event)
    producer.produce(TOPIC_BILLING_INVOICE, key=invoice["customer_id"], value=payload)
    producer.flush(2.0)


def bill_period(invoice: dict) -> dict:
    # The event is on the wire before the charge is even attempted.
    publish(invoice)
    charge = processor.Charge(
        processor_pb2.ChargeRequest(
            invoice_id=invoice["invoice_id"],
            amount_cents=invoice["amount_cents"],
            idempotency_key=invoice["invoice_id"],
        ),
        timeout=DEADLINE_S,
    )
    logger.info("charge invoice=%s reference=%s", invoice["invoice_id"], charge.reference)
    return {"reference": charge.reference}
`,
      solution: `import json
import logging

import grpc
from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI

import processor_pb2
import processor_pb2_grpc

app = FastAPI()
logger = logging.getLogger("billing")

TOPIC_BILLING_INVOICE = "billing.invoice"
DEADLINE_S = 5.0

# Idempotence plus acks=all is what makes a retried produce a no-op: the broker acknowledges the
# record only once every in-sync replica has it, and a retry of the same batch is deduplicated.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
processor = processor_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


class OutboxStore:
    def insert_outbox(self, topic: str, key: str, payload: str) -> None:
        """One row in the billing db per undelivered event; a relay republishes it."""
        raise NotImplementedError


outbox = OutboxStore()


def bill_period(invoice: dict) -> dict:
    subscription_id = invoice["subscription_id"]
    charge = processor.Charge(
        processor_pb2.ChargeRequest(
            invoice_id=invoice["invoice_id"],
            amount_cents=invoice["amount_cents"],
            idempotency_key=invoice["invoice_id"],
        ),
        timeout=DEADLINE_S,
    )
    event = {
        "invoice_id": invoice["invoice_id"],
        "subscription_id": subscription_id,
        "period_start": invoice["period_start"],
        "period_end": invoice["period_end"],
        "amount_cents": invoice["amount_cents"],
        "state": "charged" if charge.ok else "failed",
    }
    if charge.ok:
        event["reference"] = charge.reference
    else:
        event["reason"] = charge.reason
    # Published only after the processor confirmed, and a failed attempt is published too: the topic
    # is the subscription's billing history, so a gap in it is a gap in support's answer.
    payload = json.dumps(event)
    try:
        # The subscription id is the message key: every outcome of one subscription lands on one
        # partition in produce order, so a consumer replays the history without interleaving.
        producer.produce(TOPIC_BILLING_INVOICE, key=subscription_id, value=payload)
        producer.flush(2.0)
    except KafkaException:
        # The broker refused the record: keep it durably for the relay instead of dropping it.
        logger.warning("outbox topic=%s key=%s", TOPIC_BILLING_INVOICE, subscription_id)
        outbox.insert_outbox(TOPIC_BILLING_INVOICE, subscription_id, payload)
    logger.info("published invoice=%s state=%s", invoice["invoice_id"], event["state"])
    return event
`,
    },
    typescript: {
      starter: `/** billing.invoice: a model draft that keys by customer and publishes before the charge. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const topicBillingInvoice = 'billing.invoice';
const DEADLINE_MS = 5000;

const kafka = new Kafka({clientId: 'billingd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Invoice {
  invoice_id: string;
  subscription_id: string;
  customer_id: string;
  card_last4: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
}

interface ChargeResult {
  ok: boolean;
  reference?: string;
}

interface ProcessorClient {
  Charge(
    request: {invoice_id: string; amount_cents: number; idempotency_key: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, result: ChargeResult) => void,
  ): void;
}

const {processor: proto} = grpc.loadPackageDefinition(protoLoader.loadSync('processor.proto')) as unknown as {
  processor: {Processor: new (target: string, credentials: grpc.ChannelCredentials) => ProcessorClient};
};
const processor = new proto.Processor('processor:9000', grpc.credentials.createInsecure());

async function publish(invoice: Invoice): Promise<void> {
  // TODO: a model-generated draft. It keys by the customer id instead of the subscription id,
  // publishes before the processor answers — so a declined charge is announced anyway — only ever
  // builds state 'charged' (a failed attempt is never published and no reason is carried), ships
  // the masked card, and uses a default producer: no idempotent, no maxInFlightRequests, and no
  // outbox fallback when the broker rejects the produce.
  const event = {
    invoice_id: invoice.invoice_id,
    subscription_id: invoice.subscription_id,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    amount_cents: invoice.amount_cents,
    state: 'charged',
    card_last4: invoice.card_last4,
  };
  await producer.send({
    topic: topicBillingInvoice,
    messages: [{key: invoice.customer_id, value: JSON.stringify(event)}],
  });
}

export async function billPeriod(invoice: Invoice): Promise<void> {
  // The event is on the wire before the charge is even attempted.
  await publish(invoice);
  const {promise, resolve, reject} = Promise.withResolvers<ChargeResult>();
  processor.Charge(
    {invoice_id: invoice.invoice_id, amount_cents: invoice.amount_cents, idempotency_key: invoice.invoice_id},
    new grpc.Metadata(),
    {deadline: Date.now() + DEADLINE_MS},
    (error, res) => (error ? reject(error) : resolve(res)),
  );
  const result = await promise;
  console.log('charged', invoice.invoice_id, result.reference);
}
`,
      solution: `/** billing.invoice: outcomes keyed by subscription, published only after the processor confirms. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const topicBillingInvoice = 'billing.invoice';
const DEADLINE_MS = 5000;

const kafka = new Kafka({clientId: 'billingd', brokers: ['kafka:9092']});
// idempotent with maxInFlightRequests: 1 is KafkaJS's idempotent producer: a retried batch is
// deduplicated by the broker instead of duplicating the record.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface Invoice {
  invoice_id: string;
  subscription_id: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
}

interface ChargeResult {
  ok: boolean;
  reference?: string;
  reason?: string;
}

interface ProcessorClient {
  Charge(
    request: {invoice_id: string; amount_cents: number; idempotency_key: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, result: ChargeResult) => void,
  ): void;
}

const {processor: proto} = grpc.loadPackageDefinition(protoLoader.loadSync('processor.proto')) as unknown as {
  processor: {Processor: new (target: string, credentials: grpc.ChannelCredentials) => ProcessorClient};
};
const processor = new proto.Processor('processor:9000', grpc.credentials.createInsecure());

const outbox = {
  async insertOutbox(topic: string, key: string, payload: string): Promise<void> {
    void topic;
    void key;
    void payload;
  },
};

/** The deadline bounds one attempt; the invoice id is the processor's idempotency key. */
function charge(invoice: Invoice): Promise<ChargeResult> {
  const {promise, resolve, reject} = Promise.withResolvers<ChargeResult>();
  processor.Charge(
    {invoice_id: invoice.invoice_id, amount_cents: invoice.amount_cents, idempotency_key: invoice.invoice_id},
    new grpc.Metadata(),
    {deadline: Date.now() + DEADLINE_MS},
    (error, result) => (error ? reject(error) : resolve(result)),
  );
  return promise;
}

export async function billPeriod(invoice: Invoice): Promise<void> {
  const {subscription_id: subscriptionId} = invoice;
  const result = await charge(invoice);
  // Published only after the processor confirmed: an event never announces a charge that did not
  // happen, and a declined attempt is an event too, with its reason, so the history has no gap.
  const event = {
    invoice_id: invoice.invoice_id,
    subscription_id: subscriptionId,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    amount_cents: invoice.amount_cents,
    state: result.ok ? 'charged' : 'failed',
    ...(result.ok ? {reference: result.reference} : {reason: result.reason}),
  };
  const payload = JSON.stringify(event);
  try {
    await producer.send({
      topic: topicBillingInvoice,
      acks: -1,
      // The subscription id is the message key: every outcome of one subscription lands on one
      // partition in produce order, so the projector never sees a later outcome before an earlier.
      messages: [{key: subscriptionId, value: payload}],
    });
  } catch {
    // The broker refused the record: the relay republishes it from the outbox.
    await outbox.insertOutbox(topicBillingInvoice, subscriptionId, payload);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/segmentio/kafka-go"

	pb "billing/processorpb"
)

// TopicBillingInvoice carries every invoice outcome; the key is the subscription id.
const TopicBillingInvoice = "billing.invoice"

const deadline = 5 * time.Second

var eventsWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: TopicBillingInvoice}

type Invoice struct {
	InvoiceID      string \`json:"invoice_id"\`
	SubscriptionID string \`json:"subscription_id"\`
	CustomerID     string \`json:"customer_id"\`
	CardLast4      string \`json:"card_last4"\`
	PeriodStart    string \`json:"period_start"\`
	PeriodEnd      string \`json:"period_end"\`
	AmountCents    int64  \`json:"amount_cents"\`
}

var processor = newProcessorClient()

func newProcessorClient() pb.ProcessorClient {
	conn, err := grpc.NewClient("processor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	return pb.NewProcessorClient(conn)
}

// Publish writes the outcome. TODO: a model-generated draft. It keys by the customer id instead of
// the subscription id, produces before the processor answers — so a declined charge is announced
// anyway — only ever builds State "charged" (a failed attempt is never published and no Reason is
// carried), ships the masked card, and writes with a default writer: no RequiredAcks, no hash
// balancer, and no outbox fallback when the broker rejects the produce.
func Publish(ctx context.Context, invoice Invoice) error {
	event := map[string]any{
		"invoice_id":      invoice.InvoiceID,
		"subscription_id": invoice.SubscriptionID,
		"period_start":    invoice.PeriodStart,
		"period_end":      invoice.PeriodEnd,
		"amount_cents":    invoice.AmountCents,
		"state":           "charged",
		"card_last4":      invoice.CardLast4,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(invoice.CustomerID), Value: payload})
}

func BillPeriod(ctx context.Context, invoice Invoice) error {
	// The event is on the wire before the charge is even attempted.
	if err := Publish(ctx, invoice); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	_, err := processor.Charge(ctx, &pb.ChargeRequest{
		InvoiceId:      invoice.InvoiceID,
		AmountCents:    invoice.AmountCents,
		IdempotencyKey: invoice.InvoiceID,
	})
	return err
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/segmentio/kafka-go"

	pb "billing/processorpb"
)

// TopicBillingInvoice carries every invoice outcome; the key is the subscription id.
const TopicBillingInvoice = "billing.invoice"

const deadline = 5 * time.Second

// RequiredAcks=RequireAll with a hash balancer is kafka-go's idempotent-producer shape: the broker
// acknowledges only once the record is replicated, and a retry of the same key lands on the same
// partition instead of duplicating across partitions.
var eventsWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        TopicBillingInvoice,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

// Invoice is the row the run charges and the outcome it publishes: amounts and periods, the
// processor's reference or the failure reason — never card data.
type Invoice struct {
	InvoiceID      string \`json:"invoice_id"\`
	SubscriptionID string \`json:"subscription_id"\`
	PeriodStart    string \`json:"period_start"\`
	PeriodEnd      string \`json:"period_end"\`
	AmountCents    int64  \`json:"amount_cents"\`
	State          string \`json:"state"\`
	Reference      string \`json:"reference,omitempty"\`
	Reason         string \`json:"reason,omitempty"\`
}

var processor = newProcessorClient()

func newProcessorClient() pb.ProcessorClient {
	conn, err := grpc.NewClient("processor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	return pb.NewProcessorClient(conn)
}

type OutboxStore struct{}

func (o *OutboxStore) InsertOutbox(ctx context.Context, topic, key string, payload []byte) error {
	return nil
}

var outbox = &OutboxStore{}

func BillPeriod(ctx context.Context, invoice Invoice) error {
	subscriptionID := invoice.SubscriptionID
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	charge, err := processor.Charge(ctx, &pb.ChargeRequest{
		InvoiceId:      invoice.InvoiceID,
		AmountCents:    invoice.AmountCents,
		IdempotencyKey: invoice.InvoiceID,
	})
	if err != nil {
		return err
	}
	// Published only after the processor confirmed; a declined attempt is published too, with its
	// reason, so the subscription's history has no silent gap.
	invoice.State = "charged"
	if !charge.Ok {
		invoice.State = "failed"
	}
	invoice.Reference = charge.Reference
	invoice.Reason = charge.Reason
	payload, err := json.Marshal(invoice)
	if err != nil {
		return err
	}
	// The subscription id is the message key: every outcome of one subscription lands on one
	// partition in produce order, so the projector replays the history without interleaving.
	err = eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(subscriptionID), Value: payload})
	if err != nil {
		// The broker refused the record: the outbox is where it waits for the relay.
		return outbox.InsertOutbox(ctx, TopicBillingInvoice, subscriptionID, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

/** billing.invoice: a model draft that keys by customer and publishes before the charge. */
object BillingEvents {
  val TopicBillingInvoice = "billing.invoice"

  private val stub =
    ProcessorGrpc.blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())

  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props
  })

  final case class Invoice(
      invoiceId: String,
      subscriptionId: String,
      customerId: String,
      cardLast4: String,
      periodStart: String,
      periodEnd: String,
      amountCents: Long,
  )

  // TODO: a model-generated draft. It keys by the customer id instead of the subscription id,
  // publishes before the processor answers — so a declined charge is announced anyway — only ever
  // builds state "charged" (a failed attempt is never published and no reason is carried), ships
  // the masked card, and uses a bare producer: no enable.idempotence, no ACKS_CONFIG, and no
  // outbox fallback when the broker rejects the produce.
  def publish(invoice: Invoice): Unit = {
    val event = Map(
      "invoice_id" -> invoice.invoiceId.toJson,
      "subscription_id" -> invoice.subscriptionId.toJson,
      "period_start" -> invoice.periodStart.toJson,
      "period_end" -> invoice.periodEnd.toJson,
      "amount_cents" -> invoice.amountCents.toJson,
      "state" -> "charged".toJson,
      "card_last4" -> invoice.cardLast4.toJson,
    ).toJson.compactPrint
    producer.send(new ProducerRecord("billing.invoice", invoice.customerId, event))
  }

  def billPeriod(invoice: Invoice): String = {
    // The event is on the wire before the charge is even attempted.
    publish(invoice)
    val charge = stub.charge(ChargeRequest(invoiceId = invoice.invoiceId, amountCents = invoice.amountCents))
    charge.reference
  }
}
`,
      solution: `import java.util.Properties

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.KafkaException
import spray.json._

/** billing.invoice: outcomes keyed by subscription, published only after the processor confirms. */
object BillingEvents {
  val TopicBillingInvoice = "billing.invoice"

  private val stub =
    ProcessorGrpc.blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())

  // enable.idempotence plus acks=all: a retried produce is deduplicated by the broker instead of
  // duplicating the record.
  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props
  })

  final case class Subscription(id: String)

  final case class Invoice(
      invoiceId: String,
      subscription: Subscription,
      periodStart: String,
      periodEnd: String,
      amountCents: Long,
  )

  final case class ChargeResult(ok: Boolean, reference: String, reason: String)

  class OutboxStore {
    /** One row per undelivered event; a relay republishes it once the broker recovers. */
    def insertOutbox(topic: String, key: String, payload: String): Unit = ()
  }

  private val outbox = new OutboxStore

  def billPeriod(invoice: Invoice): Unit = {
    val subscription = invoice.subscription
    val charge = stub.charge(
      ChargeRequest(invoiceId = invoice.invoiceId, amountCents = invoice.amountCents, idempotencyKey = invoice.invoiceId)
    )
    val state = if (charge.ok) "charged" else "failed"
    val event = Map(
      "invoice_id" -> invoice.invoiceId.toJson,
      "subscription_id" -> subscription.id.toJson,
      "period_start" -> invoice.periodStart.toJson,
      "period_end" -> invoice.periodEnd.toJson,
      "amount_cents" -> invoice.amountCents.toJson,
      "state" -> state.toJson,
      "reference" -> charge.reference.toJson,
      "reason" -> charge.reason.toJson,
    ).toJson.compactPrint
    try {
      // The subscription id is the message key: every outcome of one subscription lands on one
      // partition in produce order, so the projector replays the history without interleaving.
      producer.send(new ProducerRecord("billing.invoice", subscription.id, event))
    } catch {
      // The broker refused the record: keep it durably for the relay instead of dropping it.
      case _: KafkaException => outbox.insertOutbox("billing.invoice", subscription.id, event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "processor.grpc.pb.h"

using json = nlohmann::json;

// billing.invoice: a model draft that keys by customer and publishes before the charge.
const std::string kTopicBillingInvoice = "billing.invoice";
constexpr int kDeadlineMs = 5000;

struct Invoice {
  std::string invoice_id;
  std::string subscription_id;
  std::string customer_id;
  std::string card_last4;
  std::string period_start;
  std::string period_end;
  long amount_cents;
};

std::unique_ptr<RdKafka::Producer> producer(
    RdKafka::Producer::create(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL).get(), err));

// TODO: a model-generated draft. It keys by the customer id instead of the subscription id,
// produces before the processor answers — so a declined charge is announced anyway — only ever
// builds a state "charged" event (a failed attempt is never published and no reason is carried),
// ships the masked card, and uses a default producer: no enable.idempotence, no acks=all, and no
// outbox fallback when the broker rejects the produce.
void billPeriod(Processor::Stub* processor, const Invoice& invoice) {
  // The event is on the wire before the charge is even attempted.
  const json early = {{"invoice_id", invoice.invoice_id}, {"state", "charged"}};
  const auto payload = early.dump();
  producer->produce(
      kTopicBillingInvoice,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      invoice.customer_id.data(),
      invoice.customer_id.size(),
      0,
      nullptr);

  grpc::ClientContext ctx;
  ChargeRequest request;
  request.set_invoice_id(invoice.invoice_id);
  ChargeResult charge;
  processor->Charge(&ctx, request, &charge);
  producer->flush(2000);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "processor.grpc.pb.h"

using json = nlohmann::json;

// billing.invoice: outcomes keyed by subscription, published only after the processor confirms.
const std::string kTopicBillingInvoice = "billing.invoice";
constexpr int kDeadlineMs = 5000;

struct Invoice {
  std::string invoice_id;
  std::string subscription_id;
  std::string period_start;
  std::string period_end;
  long amount_cents;
};

struct OutboxStore {
  void insertOutbox(const std::string& topic, const std::string& key, const json& event);
};

OutboxStore outbox;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // enable.idempotence with acks=all: the broker acknowledges the record only once every in-sync
  // replica has it, and a retried produce is deduplicated instead of duplicating the record.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void billPeriod(Processor::Stub* processor, const Invoice& invoice) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  ChargeRequest request;
  request.set_invoice_id(invoice.invoice_id);
  request.set_amount_cents(invoice.amount_cents);
  request.set_idempotency_key(invoice.invoice_id);
  ChargeResult charge;
  processor->Charge(&ctx, request, &charge);

  // Published only after the processor confirmed; a declined attempt is an event too, with its
  // reason, so the subscription's history has no silent gap.
  const json event = {
      {"invoice_id", invoice.invoice_id},
      {"subscription_id", invoice.subscription_id},
      {"period_start", invoice.period_start},
      {"period_end", invoice.period_end},
      {"amount_cents", invoice.amount_cents},
      {"state", charge.ok() ? "charged" : "failed"},
      {"reference", charge.reference()},
      {"reason", charge.reason()},
  };
  const auto payload = event.dump();
  // The subscription id is the message key: every outcome of one subscription lands on one
  // partition in produce order, so the projector replays the history without interleaving.
  const auto err = producer->produce(
      kTopicBillingInvoice,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      invoice.subscription_id.data(),
      invoice.subscription_id.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker refused the record: the relay republishes it from the outbox.
    outbox.insertOutbox(kTopicBillingInvoice, invoice.subscription_id, event);
  }
  producer->flush(2000);
}
`,
    },
  },
  hints: [
    'The message key is an ordering contract, not metadata: `key=subscription_id`, `key: subscriptionId`, `Key: []byte(subscriptionID)`, `new ProducerRecord("billing.invoice", subscription.id, payload)`, and in C++ the key plus `subscription_id.size()` handed to `produce`. Keyed by the customer id, one subscription’s history scatters across partitions, and a consumer can then apply a later outcome before an earlier one.',
    'Publish what happened, including the failures. The produce goes after the processor answers, the payload carries `state` plus either the processor’s `reference` or the failure’s `reason`, and a declined charge is an event of its own — a gap in the topic is a gap in support’s answer. What the payload never carries is card data: the topic is retained and replicated, and a PAN written there is a leak no retention policy can undo.',
    'The outbox is the durability half, producer idempotence the duplicate half. Configure `enable.idempotence` with `acks=all` (KafkaJS `{idempotent: true, maxInFlightRequests: 1}`, kafka-go `RequiredAcks: kafka.RequireAll` with `&kafka.Hash{}`, kafka-clients `enable.idempotence` plus `ProducerConfig.ACKS_CONFIG`), and on a rejected produce call `insert_outbox` / `insertOutbox` so the relay republishes it instead of the record vanishing.',
  ],
  debrief: `The interviewer is checking whether you treat the topic as an ordered, durable contract rather than a notification. The message key is that contract: key by the subscription id and one subscription's outcomes land on one partition in produce order, so the ledger replays a history instead of an interleaving; key by the customer id and the subscription stops being the unit of order the moment ownership changes. Order of effects is the second: the produce follows the ChargeResult, so the topic never advertises a charge that did not happen — and the failure path is not an exception to that, it is a record with state failed and the processor's reason. Failures are first-class because the topic is what support reads back: a history that only holds successes has a hole exactly where the customer's question is. Delivery finishes the job. An idempotent producer with acks=all makes a retried produce a no-op, while an outbox row plus a relay keeps the event when the broker refuses it — the producer's idempotence covers duplicates, the outbox covers loss, and neither covers the other. Consumers are at-least-once, so the projector must be idempotent per key and commit its offset only after its own store moved. Real platforms add a schema registry so the event contract is checked at produce time, a retention and compaction policy per topic (per-subscription compaction keeps the latest outcome of each subscription without unbounded growth), a dead-letter topic for records that can never be projected, and a reconciliation job that compares the topic's history against the invoices stored for the same period.`,
};
