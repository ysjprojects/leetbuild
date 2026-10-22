import type {Step} from '@/lib/types';

export const invoiceEventsStep: Step = {
  id: 'events',
  title: 'Invoice events keyed by invoice with line digests',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'db'],
  task: `## Task

\`invoice.event\` is the lifecycle path of an invoice: **created**, **finalized**, **sent** and
**paid** are published to one topic so that a consumer — the ledger — sees one invoice's history in
order, carrying totals and per-line digests instead of the customer's own words.

The starter is a plausible model-generated draft: it publishes all four event types on the right
topic, so replaying the happy path reproduces the lifecycle. Four production contracts are broken,
and one of them is an order-of-effects bug that no happy-path test can see.

- **One topic, keyed by invoice.** Every record is produced to \`invoice.event\` with the **invoice
  id** as the message key, so the invoice is the unit of partition, order and per-key retention. The
  draft keys by the customer id: one customer's interleaved invoices share a partition, and an
  invoice whose key changes (a merged account, a reassigned tenant) scatters across partitions, where
  a consumer can apply \`paid\` before \`finalized\` and reconstruct a history that never happened.
- **Digests travel, text does not.** The payload is built from \`line_digests\` — one SHA-256 digest
  per line — plus \`total_cents\` and the tax figure. The draft copies the raw line objects and the
  customer's name and email into the payload of a topic that is retained for days and replicated to
  every broker; what lands there outlives every retention policy the invoice's own store has.
- **Four event types on one topic.** \`created\`, \`finalized\`, \`sent\` and \`paid\` all carry
  \`event_type\`, \`invoice_id\`, \`occurred_at\`, \`total_cents\` and the tax figure, so a consumer can
  rebuild one invoice's history from one subscription.
- **Publish after the claim commits.** The \`finalized\` event is produced only once the per-tenant
  number claim has committed, and it is skipped entirely when the claim fails. The draft publishes
  it first and reads the claim afterwards, so a consumer can observe an invoice the sequence later
  rolls back — an issued number that never existed in the tenant's books.
- **Delivery guarantees.** The producer is idempotent with \`acks=all\`, so a retry of a produce
  cannot duplicate or reorder a record; when the broker rejects the produce the event goes to an
  **outbox** row that a relay republishes instead of being dropped; and the consumer updates its
  stores **before** it commits the offset, so a crash replays the record instead of losing it.

**Failure mode the checks target.** Keyed by the customer, a lifecycle is no longer ordered per
invoice; line text and customer identifiers in a retained, replicated topic are a data leak with a
long tail; a payment event consumed before its finalization is a ledger that disagrees with the
issued document; and a \`finalized\` event that outran its number claim advertises a document the
service can still refuse.`,
  sequence: {
    participants: ['Invoice Service', 'Redis claim', 'invoice.event', 'Ledger consumer', 'Invoice store'],
    messages: [
      {
        from: 'Invoice Service',
        to: 'Redis claim',
        label: 'claim + commit {seq:tenant} with the draft→finalized transition',
        kind: 'sync',
      },
      {from: 'Redis claim', to: 'Invoice Service', label: 'number 1042 · or a refusal', kind: 'reply'},
      {
        from: 'Invoice Service',
        to: 'invoice.event',
        label: 'produce · key = invoice id · acks = all · line_digests',
        kind: 'sync',
      },
      {from: 'invoice.event', to: 'Invoice Service', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Invoice Service',
        to: 'Invoice Service',
        label: 'insertOutbox(invoice.event, invoice id, event) on broker error',
        kind: 'sync',
      },
      {from: 'invoice.event', to: 'Ledger consumer', label: 'consume · group ledger', kind: 'async'},
      {from: 'Ledger consumer', to: 'Invoice store', label: 'apply event (totals + line digests)', kind: 'sync'},
      {from: 'Invoice store', to: 'Ledger consumer', label: 'stored', kind: 'reply'},
      {
        from: 'Ledger consumer',
        to: 'invoice.event',
        label: 'commit offset only after the store moved',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The message key is the partition key and the per-key unit of the topic: `key=invoice["id"]` (or `key: invoice.id`, `Key: []byte(invoice.ID)`, `new ProducerRecord(TopicInvoiceEvent, invoice.id, payload)`, and in C++ the key plus `invoice.id.size()` passed to `produce`). Keyed by the customer id, one customer’s invoices share a partition and an invoice whose key changes scatters across partitions — then a consumer can apply `paid` before `finalized`.',
    'The payload is the invoice’s arithmetic, not its prose: `line_digests` of the lines, `total_cents`, the tax figure. The topic is retained and replicated, so the raw line objects, the customer’s name and the email address written there are a leak every replica keeps.',
    'The claim is an effect like any other, so it goes first: commit `seq:{tenant}` (or refuse the finalize) and only then produce the `finalized` event — a consumer must never see a finalization the sequence can roll back. Wrap the produce so a rejected record lands in the outbox, configure `enable.idempotence=true` with `acks=all` (KafkaJS `idempotent: true`, kafka-go `RequiredAcks: kafka.RequireAll` with a hash balancer), and commit the consumed offset only after the ledger stored the event.',
  ],
  checks: [
    {
      id: 'key-invoice',
      title: 'One topic, keyed by the invoice id',
      detail:
        'The record goes to the `invoice.event` topic and the message key is the **invoice id**, so every lifecycle record of one invoice lands on one partition in produce order. Keyed by the customer id the invoice is no longer the unit of order: a consumer can apply `paid` before `finalized`, and one customer’s many invoices interleave on one partition forever.',
      match: {
        python: {
          all: [/TOPIC_INVOICE_EVENT\s*=\s*["']invoice\.event["']/, /produce\([^)]*key=invoice\[["']id["']\]/],
        },
        typescript: {all: [/topicInvoiceEvent\s*=\s*'invoice\.event'/, /key:\s*invoice\.id\b/]},
        go: {all: [/TopicInvoiceEvent\s*=\s*"invoice\.event"/, /Key:\s*\[\]byte\(invoice\.ID\)/]},
        scala: {
          all: [/TopicInvoiceEvent\s*=\s*"invoice\.event"/, /ProducerRecord\(TopicInvoiceEvent,\s*invoice\.id\b/],
        },
        cpp: {all: [/kTopicInvoiceEvent\s*=\s*"invoice\.event"/, /produce\([^;]*?invoice\.id\.data\(\)/]},
      },
    },
    {
      id: 'digests-not-descriptions',
      title: 'Payload carries line digests, never line text or customer identifiers',
      detail:
        'The payload is built from `line_digests` — SHA-256 digests of the lines — with totals and the tax figure. Copying the lines’ free text, the customer’s name or the email address into the payload leaks PII into a topic that is retained for days and replicated to every broker and every consumer group; the leak outlives the invoice’s own retention policy, so an event that cannot be unsent is the worst place to put it.',
      match: {
        python: {all: [/line_digests/, /sha256/], none: [/description/i, /customer_?name/i, /customer_?email/i]},
        typescript: {all: [/line_digests/, /sha256/], none: [/description/i, /customer_?name/i, /customer_?email/i]},
        go: {all: [/line_digests/, /sha256/], none: [/description/i, /customer_?name/i, /customer_?email/i]},
        scala: {all: [/line_digests/, /sha256|SHA-256/], none: [/description/i, /customer_?name/i, /customer_?email/i]},
        cpp: {all: [/line_digests/, /sha256|SHA256/], none: [/description/i, /customer_?name/i, /customer_?email/i]},
      },
    },
    {
      id: 'publish-after-claim',
      title: 'The finalized event is published only after the number claim commits',
      detail:
        'The per-tenant claim is committed first and the finalize returns without publishing when the claim fails; only then is the `finalized` event produced. The draft produces the event before it reads the claim, so a consumer can observe — and a ledger can post — a finalization the sequence later rolls back: an event that outran its commit.',
      match: {
        python: {order: [/claim_and_commit\(/, /if not claim\.ok/, /publish\(\s*["']finalized["']/]},
        typescript: {order: [/claimAndCommit\(/, /if \(!claim\.ok\)/, /publish\(\s*'finalized'/]},
        go: {order: [/ClaimAndCommit\(/, /if !claim\.OK/, /Publish\(ctx, "finalized"/]},
        scala: {order: [/claimAndCommit\(/, /if \(!claim\.ok\)/, /publish\("finalized"/]},
        cpp: {order: [/claimAndCommit\(/, /if \(!claim\.ok\)/, /publish\("finalized"/]},
      },
    },
    {
      id: 'lifecycle',
      title: 'created, finalized, sent and paid on the one topic',
      detail:
        'All four lifecycle types are produced on `invoice.event` and each payload carries `event_type`, `invoice_id`, `occurred_at`, `total_cents` and the tax figure, so a consumer rebuilds one invoice’s history from a single subscription. A missing type or a missing timestamp is a state change nobody downstream can see or order.',
      match: {
        python: {
          all: [
            /["']created["']/,
            /["']finalized["']/,
            /["']sent["']/,
            /["']paid["']/,
            /event_type/,
            /occurred_at/,
            /total_cents/,
            /TOPIC_INVOICE_EVENT/,
          ],
        },
        typescript: {
          all: [
            /["']created["']/,
            /["']finalized["']/,
            /["']sent["']/,
            /["']paid["']/,
            /event_type/,
            /occurred_at/,
            /total_cents/,
            /topicInvoiceEvent/,
          ],
        },
        go: {
          all: [
            /["']created["']/,
            /["']finalized["']/,
            /["']sent["']/,
            /["']paid["']/,
            /event_type/,
            /occurred_at/,
            /total_cents/,
            /TopicInvoiceEvent/,
          ],
        },
        scala: {
          all: [
            /["']created["']/,
            /["']finalized["']/,
            /["']sent["']/,
            /["']paid["']/,
            /event_type/,
            /occurred_at/,
            /total_cents/,
            /TopicInvoiceEvent/,
          ],
        },
        cpp: {
          all: [
            /["']created["']/,
            /["']finalized["']/,
            /["']sent["']/,
            /["']paid["']/,
            /event_type/,
            /occurred_at/,
            /total_cents/,
            /kTopicInvoiceEvent/,
          ],
        },
      },
    },
    {
      id: 'delivery',
      title: 'Idempotent acks=all producer, outbox fallback, commit after processing',
      detail:
        'The producer is idempotent with `acks=all` (`enable.idempotence` + `acks`, KafkaJS `idempotent: true`, kafka-go `RequiredAcks: kafka.RequireAll` with a hash balancer), a rejected produce writes an outbox row instead of dropping the event, and the consumer commits the offset only after its stores moved. A retry that duplicates a lifecycle event and a crash between commit and processing are both silent ledger errors.',
      match: {
        python: {
          all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/, /insert_outbox\(/],
          order: [/apply_event\(/, /consumer\.commit\(/],
        },
        typescript: {
          all: [/idempotent:\s*true/, /acks:\s*-1/, /insertOutbox\(/],
          order: [/applyEvent\(/, /commitOffsets\(/],
        },
        go: {
          all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/, /InsertOutbox\(/],
          order: [/ApplyEvent\(/, /CommitMessages\(/],
        },
        scala: {all: [/enable\.idempotence/, /"acks"/, /insertOutbox\(/], order: [/applyEvent\(/, /commitSync\(/]},
        cpp: {
          all: [/enable\.idempotence/, /set\(\s*"acks"\s*,\s*"all"/, /insertOutbox\(/],
          order: [/applyEvent\(/, /commitSync\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

TOPIC_INVOICE_EVENT = "invoice.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(event_type, invoice, occurred_at):
    # TODO: key by the invoice id instead of the customer id, send per-line digests instead of the
    # customer's own line text and name, publish the finalized event only after the number claim
    # commits, and make the producer idempotent with acks=all plus an outbox fallback.
    event = {
        "event_type": event_type,
        "invoice_id": invoice["id"],
        "occurred_at": occurred_at,
        "total_cents": invoice["total_cents"],
        "tax_cents": invoice["tax_cents"],
        "customer_name": invoice["customer_name"],
        "customer_email": invoice["customer_email"],
        "lines": invoice["lines"],
    }
    payload = json.dumps(event)
    producer.produce(TOPIC_INVOICE_EVENT, key=invoice["customer_id"], value=payload)
    producer.flush(2.0)


def create(invoice):
    publish("created", invoice, invoice["created_at"])
    return invoice


def finalize(invoice, tenant):
    # The claim is read further down, but the finalized event is already on the wire.
    publish("finalized", invoice, invoice["created_at"])
    claim = sequence.claim_and_commit(tenant)
    if not claim.ok:
        return hold(invoice, claim.reason)
    invoice["number"] = claim.number
    return invoice


def mark_sent(invoice, occurred_at):
    publish("sent", invoice, occurred_at)


def mark_paid(invoice, occurred_at):
    publish("paid", invoice, occurred_at)


def consume():
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "ledger"})
    consumer.subscribe([TOPIC_INVOICE_EVENT])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        ledger.apply_event(json.loads(msg.value()))
`,
      solution: `import hashlib
import json

from confluent_kafka import Consumer, KafkaException, Producer

TOPIC_INVOICE_EVENT = "invoice.event"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, topic: str, key: str, payload: str) -> None:
        """One row per undelivered event; a relay republishes it once the broker recovers."""
        raise NotImplementedError


outbox = OutboxStore()


def line_digests(invoice: dict) -> list[str]:
    """One SHA-256 digest per line: the topic carries the invoice's arithmetic, never its words."""
    return [hashlib.sha256(line["sku"].encode()).hexdigest() for line in invoice["lines"]]


def publish(event_type: str, invoice: dict, occurred_at: str) -> None:
    event = {
        "event_type": event_type,
        "invoice_id": invoice["id"],
        "occurred_at": occurred_at,
        "total_cents": invoice["total_cents"],
        "tax_cents": invoice["tax_cents"],
        "line_digests": line_digests(invoice),
    }
    payload = json.dumps(event)
    try:
        # The invoice id is the message key: every record of one invoice lands on one partition in
        # produce order, so a consumer can never apply "paid" before "finalized".
        producer.produce(TOPIC_INVOICE_EVENT, key=invoice["id"], value=payload)
        producer.flush(2.0)
    except KafkaException:
        # The broker refused the record: keep it durably instead of dropping it.
        outbox.insert_outbox(TOPIC_INVOICE_EVENT, invoice["id"], payload)


def create(invoice: dict) -> dict:
    publish("created", invoice, invoice["created_at"])
    return invoice


def finalize(invoice: dict, tenant: str) -> dict:
    # The claim commits first: a finalized event that outran its claim advertises a number the
    # sequence can still roll back.
    claim = sequence.claim_and_commit(tenant)
    if not claim.ok:
        return hold(invoice, claim.reason)
    invoice["number"] = claim.number
    publish("finalized", invoice, claim.occurred_at)
    return invoice


def mark_sent(invoice: dict, occurred_at: str) -> None:
    publish("sent", invoice, occurred_at)


def mark_paid(invoice: dict, occurred_at: str) -> None:
    publish("paid", invoice, occurred_at)


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "ledger", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC_INVOICE_EVENT])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        ledger.apply_event(event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** invoice.event: a model draft that keys by customer, ships line text and publishes early. */
import {Kafka} from 'kafkajs';

const topicInvoiceEvent = 'invoice.event';
const kafka = new Kafka({clientId: 'invoice-service', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface InvoiceLine {
  sku: string;
  amount_cents: number;
}

interface Invoice {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  number?: string;
  total_cents: number;
  tax_cents: number;
  created_at: string;
  lines: InvoiceLine[];
}

async function publish(eventType: string, invoice: Invoice, occurredAt: string): Promise<void> {
  // TODO: key by the invoice id instead of the customer id, send per-line digests instead of the
  // customer's own line text and name, publish the finalized event only after the number claim
  // commits, and make the producer idempotent with acks=all plus an outbox fallback.
  const event = {
    event_type: eventType,
    invoice_id: invoice.id,
    occurred_at: occurredAt,
    total_cents: invoice.total_cents,
    tax_cents: invoice.tax_cents,
    customer_name: invoice.customer_name,
    customer_email: invoice.customer_email,
    lines: invoice.lines,
  };
  await producer.send({
    topic: topicInvoiceEvent,
    messages: [{key: invoice.customer_id, value: JSON.stringify(event)}],
  });
}

export async function create(invoice: Invoice): Promise<Invoice> {
  await publish('created', invoice, invoice.created_at);
  return invoice;
}

export async function finalize(invoice: Invoice, tenant: string): Promise<Invoice> {
  // The claim is read further down, but the finalized event is already on the wire.
  await publish('finalized', invoice, invoice.created_at);
  const claim = await sequence.claimAndCommit(tenant);
  if (!claim.ok) return hold(invoice, claim.reason);
  invoice.number = claim.number;
  return invoice;
}

export async function markSent(invoice: Invoice): Promise<void> {
  await publish('sent', invoice, invoice.created_at);
}

export async function markPaid(invoice: Invoice): Promise<void> {
  await publish('paid', invoice, invoice.created_at);
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'ledger'});
  await consumer.connect();
  await consumer.subscribe({topic: topicInvoiceEvent});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {total_cents: number};
      await ledger.applyEvent(event);
    },
  });
}
`,
      solution: `/** invoice.event: one idempotent, invoice-keyed record per lifecycle change; digests, not text. */
import {createHash} from 'node:crypto';
import {Kafka} from 'kafkajs';

import {ledger} from './ledger';
import {outbox} from './outbox';
import {sequence} from './sequence';

const topicInvoiceEvent = 'invoice.event';

const kafka = new Kafka({clientId: 'invoice-service', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface InvoiceLine {
  sku: string;
  amount_cents: number;
}

interface Invoice {
  id: string;
  number?: string;
  total_cents: number;
  tax_cents: number;
  created_at: string;
  lines: InvoiceLine[];
}

/** One SHA-256 digest per line: the topic carries the invoice's arithmetic, never its words. */
function lineDigests(lines: InvoiceLine[]): string[] {
  return lines.map(line => createHash('sha256').update(line.sku).digest('hex'));
}

async function publish(eventType: string, invoice: Invoice, occurredAt: string): Promise<void> {
  const event = {
    event_type: eventType,
    invoice_id: invoice.id,
    occurred_at: occurredAt,
    total_cents: invoice.total_cents,
    tax_cents: invoice.tax_cents,
    line_digests: lineDigests(invoice.lines),
  };
  try {
    // The invoice id is the message key: every record of one invoice lands on one partition in
    // produce order, so a consumer can never apply paid before finalized.
    await producer.send({
      topic: topicInvoiceEvent,
      acks: -1,
      messages: [{key: invoice.id, value: JSON.stringify(event)}],
    });
  } catch {
    // The broker refused the record: keep it durably instead of dropping it.
    await outbox.insertOutbox(topicInvoiceEvent, invoice.id, event);
  }
}

export async function create(invoice: Invoice): Promise<Invoice> {
  await publish('created', invoice, invoice.created_at);
  return invoice;
}

export async function finalize(invoice: Invoice, tenant: string): Promise<Invoice> {
  // The claim commits first: a finalized event that outran its claim advertises a number the
  // sequence can still roll back.
  const claim = await sequence.claimAndCommit(tenant);
  if (!claim.ok) return hold(invoice, claim.reason);
  const finalized = {...invoice, number: claim.number};
  await publish('finalized', finalized, claim.occurredAt);
  return finalized;
}

export async function markSent(invoice: Invoice, occurredAt: string): Promise<void> {
  await publish('sent', invoice, occurredAt);
}

export async function markPaid(invoice: Invoice, occurredAt: string): Promise<void> {
  await publish('paid', invoice, occurredAt);
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'ledger'});
  await consumer.connect();
  await consumer.subscribe({topic: topicInvoiceEvent});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {total_cents: number};
      // The store moves before the offset moves: a crash here replays the record instead of
      // losing it.
      await ledger.applyEvent(event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"
)

// TopicInvoiceEvent carries every lifecycle record of every invoice.
const TopicInvoiceEvent = "invoice.event"

var eventsWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: TopicInvoiceEvent}

type InvoiceLine struct {
	SKU         string \`json:"sku"\`
	AmountCents int64  \`json:"amount_cents"\`
}

type Invoice struct {
	ID            string        \`json:"id"\`
	CustomerID    string        \`json:"customer_id"\`
	CustomerName  string        \`json:"customer_name"\`
	CustomerEmail string        \`json:"customer_email"\`
	Number        string        \`json:"number"\`
	TotalCents    int64         \`json:"total_cents"\`
	TaxCents      int64         \`json:"tax_cents"\`
	CreatedAt     string        \`json:"created_at"\`
	Lines         []InvoiceLine \`json:"lines"\`
}

func Publish(ctx context.Context, eventType string, invoice Invoice, occurredAt string) error {
	// TODO: key by the invoice id instead of the customer id, send per-line digests instead of the
	// customer's own line text and name, publish the finalized event only after the number claim
	// commits, and use RequiredAcks=RequireAll with an outbox fallback.
	event := map[string]any{
		"event_type":     eventType,
		"invoice_id":     invoice.ID,
		"occurred_at":    occurredAt,
		"total_cents":    invoice.TotalCents,
		"tax_cents":      invoice.TaxCents,
		"customer_name":  invoice.CustomerName,
		"customer_email": invoice.CustomerEmail,
		"lines":          invoice.Lines,
	}
	payload, _ := json.Marshal(event)
	return eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(invoice.CustomerID), Value: payload})
}

func Create(ctx context.Context, invoice Invoice) error {
	return Publish(ctx, "created", invoice, invoice.CreatedAt)
}

func Finalize(ctx context.Context, invoice Invoice, tenant string) (Invoice, error) {
	// The claim is read further down, but the finalized event is already on the wire.
	if err := Publish(ctx, "finalized", invoice, invoice.CreatedAt); err != nil {
		return invoice, err
	}
	claim, err := sequence.ClaimAndCommit(ctx, tenant)
	if err != nil {
		return invoice, err
	}
	if !claim.OK {
		return invoice, ErrHeld
	}
	invoice.Number = claim.Number
	return invoice, nil
}

func MarkSent(ctx context.Context, invoice Invoice) error {
	return Publish(ctx, "sent", invoice, time.Now().UTC().Format(time.RFC3339))
}

func MarkPaid(ctx context.Context, invoice Invoice) error {
	return Publish(ctx, "paid", invoice, time.Now().UTC().Format(time.RFC3339))
}

func Consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   TopicInvoiceEvent,
		GroupID: "ledger",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event map[string]any
		_ = json.Unmarshal(msg.Value, &event)
		_ = ledger.ApplyEvent(ctx, event)
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"
)

// TopicInvoiceEvent carries every lifecycle record of every invoice.
const TopicInvoiceEvent = "invoice.event"

// RequiredAcks=RequireAll with a stable hash balancer is kafka-go's equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a retry of the same
// key lands on the same partition instead of duplicating across partitions.
var eventsWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        TopicInvoiceEvent,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type InvoiceLine struct {
	SKU         string \`json:"sku"\`
	AmountCents int64  \`json:"amount_cents"\`
}

type Invoice struct {
	ID         string        \`json:"id"\`
	Number     string        \`json:"number"\`
	TotalCents int64         \`json:"total_cents"\`
	TaxCents   int64         \`json:"tax_cents"\`
	CreatedAt  string        \`json:"created_at"\`
	Lines      []InvoiceLine \`json:"lines"\`
}

// LineDigests hashes every line: the topic carries the invoice's arithmetic, never its words.
func LineDigests(lines []InvoiceLine) []string {
	digests := make([]string, 0, len(lines))
	for _, line := range lines {
		sum := sha256.Sum256([]byte(line.SKU))
		digests = append(digests, hex.EncodeToString(sum[:]))
	}
	return digests
}

func Publish(ctx context.Context, eventType string, invoice Invoice, occurredAt string) error {
	event := map[string]any{
		"event_type":   eventType,
		"invoice_id":   invoice.ID,
		"occurred_at":  occurredAt,
		"total_cents":  invoice.TotalCents,
		"tax_cents":    invoice.TaxCents,
		"line_digests": LineDigests(invoice.Lines),
	}
	payload, _ := json.Marshal(event)
	// The invoice id is the message key: every record of one invoice lands on one partition in
	// produce order, so a consumer can never apply paid before finalized.
	err := eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(invoice.ID), Value: payload})
	if err != nil {
		// The broker refused the record: keep it durably instead of dropping it.
		return outbox.InsertOutbox(ctx, TopicInvoiceEvent, invoice.ID, payload)
	}
	return nil
}

func Create(ctx context.Context, invoice Invoice) error {
	return Publish(ctx, "created", invoice, invoice.CreatedAt)
}

func Finalize(ctx context.Context, invoice Invoice, tenant string) (Invoice, error) {
	// The claim commits first: a finalized event that outran its claim advertises a number the
	// sequence can still roll back.
	claim, err := sequence.ClaimAndCommit(ctx, tenant)
	if err != nil {
		return invoice, err
	}
	if !claim.OK {
		return invoice, ErrHeld
	}
	invoice.Number = claim.Number
	if err := Publish(ctx, "finalized", invoice, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return invoice, err
	}
	return invoice, nil
}

func MarkSent(ctx context.Context, invoice Invoice, occurredAt string) error {
	return Publish(ctx, "sent", invoice, occurredAt)
}

func MarkPaid(ctx context.Context, invoice Invoice, occurredAt string) error {
	return Publish(ctx, "paid", invoice, occurredAt)
}

func Consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   TopicInvoiceEvent,
		GroupID: "ledger",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event map[string]any
		_ = json.Unmarshal(msg.Value, &event)
		_ = ledger.ApplyEvent(ctx, event)
		// The store moved before the offset moves: a crash here replays the record instead of
		// losing it.
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.time.Instant
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object InvoiceEvents {
  val TopicInvoiceEvent = "invoice.event"

  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props
  })

  // TODO: key by the invoice id instead of the customer id, send per-line digests instead of the
  // customer's own line text and name, publish the finalized event only after the number claim
  // commits, and turn on enable.idempotence with acks=all plus an outbox fallback.
  def publish(eventType: String, invoice: Invoice, occurredAt: Instant): Unit = {
    val event = Map(
      "event_type" -> eventType.toJson,
      "invoice_id" -> invoice.id.toJson,
      "occurred_at" -> occurredAt.toString.toJson,
      "total_cents" -> invoice.totalCents.toJson,
      "tax_cents" -> invoice.taxCents.toJson,
      "customer_name" -> invoice.customerName.toJson,
      "customer_email" -> invoice.customerEmail.toJson,
      "lines" -> invoice.lines.toJson,
    ).toJson.compactPrint
    producer.send(new ProducerRecord(TopicInvoiceEvent, invoice.customerId, event))
  }

  def create(invoice: Invoice): Unit = publish("created", invoice, invoice.createdAt)

  def finalize(invoice: Invoice, tenant: String): Invoice = {
    // The claim is read further down, but the finalized event is already on the wire.
    publish("finalized", invoice, invoice.createdAt)
    val claim = sequence.claimAndCommit(tenant)
    if (!claim.ok) return hold(invoice, claim.reason)
    invoice.copy(number = claim.number)
  }

  def markSent(invoice: Invoice): Unit = publish("sent", invoice, Instant.now())
  def markPaid(invoice: Invoice): Unit = publish("paid", invoice, Instant.now())

  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "ledger")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(TopicInvoiceEvent))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        ledger.applyEvent(event)
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object InvoiceEvents {
  val TopicInvoiceEvent = "invoice.event"

  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  /** One SHA-256 digest per line: the topic carries the invoice's arithmetic, never its words. */
  def lineDigests(lines: List[InvoiceLine]): List[String] =
    lines.map { line =>
      val bytes = MessageDigest.getInstance("SHA-256").digest(line.sku.getBytes(StandardCharsets.UTF_8))
      bytes.map("%02x".format(_)).mkString
    }

  def publish(eventType: String, invoice: Invoice, occurredAt: Instant): Unit = {
    val event = Map(
      "event_type" -> eventType.toJson,
      "invoice_id" -> invoice.id.toJson,
      "occurred_at" -> occurredAt.toString.toJson,
      "total_cents" -> invoice.totalCents.toJson,
      "tax_cents" -> invoice.taxCents.toJson,
      "line_digests" -> lineDigests(invoice.lines).toJson,
    ).toJson.compactPrint
    try {
      // The invoice id is the message key: every record of one invoice lands on one partition in
      // produce order, so a consumer can never apply paid before finalized.
      producer.send(new ProducerRecord(TopicInvoiceEvent, invoice.id, event))
    } catch {
      // The broker refused the record: keep it durably instead of dropping it.
      case _: org.apache.kafka.common.KafkaException =>
        outbox.insertOutbox(TopicInvoiceEvent, invoice.id, event)
    }
  }

  def create(invoice: Invoice): Unit = publish("created", invoice, invoice.createdAt)

  def finalize(invoice: Invoice, tenant: String): Invoice = {
    // The claim commits first: a finalized event that outran its claim advertises a number the
    // sequence can still roll back.
    val claim = sequence.claimAndCommit(tenant)
    if (!claim.ok) return hold(invoice, claim.reason)
    val finalized = invoice.copy(number = claim.number)
    publish("finalized", finalized, claim.occurredAt)
    finalized
  }

  def markSent(invoice: Invoice, occurredAt: Instant): Unit = publish("sent", invoice, occurredAt)
  def markPaid(invoice: Invoice, occurredAt: Instant): Unit = publish("paid", invoice, occurredAt)

  def consume(group: String): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, group)
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(TopicInvoiceEvent))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        // The store moves before the offset moves: a crash here replays the record instead of
        // losing it.
        ledger.applyEvent(event)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopicInvoiceEvent = "invoice.event";

struct InvoiceLine {
  std::string sku;
  long amountCents;
};

struct Invoice {
  std::string id;
  std::string customerId;
  std::string customerName;
  std::string customerEmail;
  std::string number;
  long totalCents;
  long taxCents;
  std::string createdAt;
  std::vector<InvoiceLine> lines;
};

std::unique_ptr<RdKafka::Producer> producer;

// TODO: key by the invoice id instead of the customer id, send per-line digests instead of the
// customer's own line text and name, publish the finalized event only after the number claim
// commits, and turn on enable.idempotence with acks=all plus an outbox fallback.
void publish(const std::string& eventType, const Invoice& invoice, const std::string& occurredAt) {
  const json event = {
      {"event_type", eventType},
      {"invoice_id", invoice.id},
      {"occurred_at", occurredAt},
      {"total_cents", invoice.totalCents},
      {"tax_cents", invoice.taxCents},
      {"customer_name", invoice.customerName},
      {"customer_email", invoice.customerEmail},
      {"lines", invoice.lines.size()},
  };
  const auto payload = event.dump();
  producer->produce(
      kTopicInvoiceEvent,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      invoice.customerId.data(),
      invoice.customerId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

void create(const Invoice& invoice) { publish("created", invoice, invoice.createdAt); }

void finalize(const Invoice& invoice, const std::string& tenant, const std::string& occurredAt) {
  // The claim is read further down, but the finalized event is already on the wire.
  publish("finalized", invoice, occurredAt);
  const auto claim = sequence.claimAndCommit(tenant);
  if (!claim.ok) {
    hold(invoice, claim.reason);
  }
}

void markSent(const Invoice& invoice, const std::string& occurredAt) { publish("sent", invoice, occurredAt); }
void markPaid(const Invoice& invoice, const std::string& occurredAt) { publish("paid", invoice, occurredAt); }

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopicInvoiceEvent});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(
        static_cast<const char*>(msg->payload()),
        static_cast<const char*>(msg->payload()) + msg->len());
    ledger.applyEvent(event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <openssl/sha.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopicInvoiceEvent = "invoice.event";

struct InvoiceLine {
  std::string sku;
  long amountCents;
};

struct Invoice {
  std::string id;
  std::string number;
  long totalCents;
  long taxCents;
  std::string createdAt;
  std::vector<InvoiceLine> lines;
};

struct OutboxStore {
  void insertOutbox(const std::string& topic, const std::string& key, const json& event);
};

OutboxStore outbox;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

/** SHA-256, hex-encoded: the topic carries the invoice's arithmetic, never its words. */
std::string sha256Hex(const std::string& value) {
  unsigned char bytes[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), bytes);
  static const char* hexDigits = "0123456789abcdef";
  std::string out;
  out.reserve(SHA256_DIGEST_LENGTH * 2);
  for (unsigned char byte : bytes) {
    out.push_back(hexDigits[byte >> 4]);
    out.push_back(hexDigits[byte & 0x0F]);
  }
  return out;
}

std::vector<std::string> lineDigests(const std::vector<InvoiceLine>& lines) {
  std::vector<std::string> digests;
  digests.reserve(lines.size());
  for (const auto& line : lines) digests.push_back(sha256Hex(line.sku));
  return digests;
}

void publish(const std::string& eventType, const Invoice& invoice, const std::string& occurredAt) {
  const json event = {
      {"event_type", eventType},
      {"invoice_id", invoice.id},
      {"occurred_at", occurredAt},
      {"total_cents", invoice.totalCents},
      {"tax_cents", invoice.taxCents},
      {"line_digests", lineDigests(invoice.lines)},
  };
  const auto payload = event.dump();
  // The invoice id is the message key: every record of one invoice lands on one partition in
  // produce order, so a consumer can never apply paid before finalized.
  const auto err = producer->produce(
      kTopicInvoiceEvent,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      invoice.id.data(),
      invoice.id.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker refused the record: keep it durably instead of dropping it.
    outbox.insertOutbox(kTopicInvoiceEvent, invoice.id, event);
  }
  producer->flush(2000);
}

void create(const Invoice& invoice) { publish("created", invoice, invoice.createdAt); }

void finalize(const Invoice& invoice, const std::string& tenant, const std::string& occurredAt) {
  // The claim commits first: a finalized event that outran its claim advertises a number the
  // sequence can still roll back.
  const auto claim = sequence.claimAndCommit(tenant);
  if (!claim.ok) {
    hold(invoice, claim.reason);
    return;
  }
  const auto finalized = numbered(invoice, claim.number);
  publish("finalized", finalized, occurredAt);
}

void markSent(const Invoice& invoice, const std::string& occurredAt) { publish("sent", invoice, occurredAt); }
void markPaid(const Invoice& invoice, const std::string& occurredAt) { publish("paid", invoice, occurredAt); }

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopicInvoiceEvent});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(
        static_cast<const char*>(msg->payload()),
        static_cast<const char*>(msg->payload()) + msg->len());
    // The store moves before the offset moves: a crash here replays the record instead of
    // losing it.
    ledger.applyEvent(event);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking one thing: whether you treat the topic as an ordered, retained, replicated contract rather than a fire-and-forget notification. The message key is that contract — key by the invoice id and one invoice's created, finalized, sent and paid records land on one partition in produce order, so the ledger reconstructs the history it is asked for; key by the customer id and the invoice is no longer the unit of order or of per-key retention. The payload is the second contract: what you write into the topic is retained for days and replicated to every broker and every consumer group, so line text and the customer's identity belong in the invoice store, and the event carries the arithmetic instead — totals, tax, per-line SHA-256 digests. The third is order of effects: the number claim commits before the finalized event is produced, otherwise a consumer posts a document the sequence can roll back. Delivery finishes it: an idempotent producer with acks=all so a retry cannot duplicate a lifecycle record, an outbox row when the broker refuses the produce, and an offset committed only after the consumer's stores moved. Real platforms add a schema registry so the event contract is checked at produce time, dead-letter topics for records that can never be applied, and per-tenant quotas on the topic.`,
};
