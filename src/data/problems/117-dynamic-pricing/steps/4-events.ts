import type {Step} from '@/lib/types';

/**
 * Step 4 — the price audit chain. One `price.changed` event per publish, keyed by sku so a sku's
 * history stays ordered in one partition, produced only after the price store commits, carrying
 * both prices, the headroom the change consumed and the reason, with an outbox for the produce the
 * broker rejects and an idempotent producer so the relay's republish cannot duplicate a move.
 */
export const eventsStep: Step = {
  id: 'events',
  title: 'Price events keyed by sku with the audit chain',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'db', 'relay'],
  task: `## Task

**Review premise.** \`events\` — the publish path of **priced** — is a plausible model-generated
draft: it produces \`price.changed\` on the happy path, every consumer sees a price move, and the demo
looks finished. Four contracts are broken and none of them is visible until the day it matters: the
draft keys the record by the **model version** that proposed the price, produces inside the same
block *before* \`store.publish\` commits, ships an envelope that keeps only the new price, and never
looks at the produce result, so a record the broker rejects is simply gone.

- Produce **exactly one** \`price.changed\` per published price, **keyed by the sku** (\`key=sku\`,
  \`key: sku\`, \`Key: []byte(sku)\`, \`ProducerRecord("price.changed", sku, …)\`): a sku's history then
  stays in one partition and in order, so a replay answers what this sku's price did. Keyed by the
  model version it scatters the moment a different model suggests the price.
- Produce **only after the price store commits**: \`store.publish(sku, price_cents, reason, source,
  update_id)\` first, the produce second. A price the store rolled back — or a proposal the guard
  rejected after the model spoke — must never be announced as live.
- The envelope is the audit chain: \`sku\`, \`old_price_cents\`, \`new_price_cents\`, \`source\`,
  \`reason\`, \`update_id\`, plus the window's guardrail accounting — \`moved_bp\`, the basis points this
  change consumed from what the guard reserved against \`MAX_MOVE_BP = 2000\`, and \`headroom_bp\`,
  what is left of it.
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence\` + \`acks\`, KafkaJS's
  \`idempotent: true\` with \`acks: -1\`, kafka-go's \`RequiredAcks: kafka.RequireAll\` with a
  \`kafka.Hash\` balancer): the relay republishes the same record after a rejection, and a duplicate
  would double-count the move.
- A rejected produce writes a **\`price_outbox\`** row instead of dropping the event
  (\`store.insert_outbox(sku, event)\` / \`insertOutbox\` / \`InsertOutbox\`); the relay reads the
  undelivered rows back (\`store.pending_outbox(limit)\` / \`pendingOutbox\`), republishes each under
  the same sku key, and marks only the rows the broker acknowledged as sent.

**Failure mode the checks target.** Keying by the model version scatters a sku's history, so "why did
this price move" cannot be replayed from the topic; producing before the commit announces prices that
never existed and leaves every downstream catalog copy disagreeing with the store; an envelope without
\`old_price_cents\` or the reason is a sequence of numbers nobody can explain; and ignoring the produce
result loses the event exactly when the broker is unhealthy — which is when the outbox and an
idempotent producer are what keep the stream complete.`,
  sequence: {
    participants: ['Pricing API', 'Price store', 'Kafka', 'Outbox relay'],
    messages: [
      {
        from: 'Pricing API',
        to: 'Price store',
        label: 'publish(sku, price_cents, reason, source, update_id)',
        kind: 'sync',
      },
      {from: 'Price store', to: 'Pricing API', label: 'committed · update_id', kind: 'reply'},
      {from: 'Pricing API', to: 'Kafka', label: 'produce price.changed · key = sku · acks = all', kind: 'sync'},
      {from: 'Kafka', to: 'Pricing API', label: 'ack / broker error', kind: 'reply'},
      {from: 'Pricing API', to: 'Price store', label: 'insert_outbox(sku, event) → a price_outbox row', kind: 'sync'},
      {from: 'Outbox relay', to: 'Price store', label: 'pending_outbox(limit) — the undelivered rows', kind: 'sync'},
      {from: 'Price store', to: 'Outbox relay', label: 'rows: id, key = sku, payload', kind: 'reply'},
      {from: 'Outbox relay', to: 'Kafka', label: 'republish price.changed · key = sku', kind: 'async'},
      {from: 'Outbox relay', to: 'Price store', label: 'mark_outbox_sent(delivered ids only)', kind: 'sync'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=sku`, `key: sku`, `Key: []byte(sku)`, `ProducerRecord("price.changed", sku, …)`. Keyed by the model version, one sku’s price history lands in different partitions every time the model behind it changes — and a consumer replaying the topic can no longer answer what this sku’s price did.',
    'Commit, then announce: read the old price with `store.get_sku(sku)`, call `store.publish(sku, price_cents, reason, source, update_id)`, and only then produce. The draft produces inside the same block *before* the commit, so a price the store rolled back still reaches every consumer.',
    'The outbox is the durability half, and the producer config is what makes the retry safe: wrap the produce and, when the broker rejects it, `store.insert_outbox(sku, event)`; have the relay loop over `store.pending_outbox(limit)` and produce each row under the same sku key; and configure `enable.idempotence=true` with `acks=all` (KafkaJS `idempotent: true` with `acks: -1`, kafka-go `RequiredAcks: kafka.RequireAll` and a `kafka.Hash` balancer), or the republish can duplicate a price move.',
  ],
  checks: [
    {
      id: 'sku-key',
      title: 'Keyed by sku, not by the model version',
      detail:
        'The `price.changed` record is produced with the sku as its message key, so one sku’s price history stays in one partition and in order. The draft keys by the model version, so a sku’s history scatters the moment a different model suggests its price.',
      match: {
        python: {all: [/price\.changed/, /key=sku\b/]},
        typescript: {all: [/price\.changed/, /key:\s*sku\b/]},
        go: {all: [/price\.changed/, /Key:\s*\[\]byte\(sku\)/]},
        scala: {all: [/price\.changed/, /ProducerRecord\("price\.changed",\s*sku,/]},
        cpp: {all: [/price\.changed/, /sku\.data\(\)/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Produced only after the price store commits',
      detail:
        '`store.publish(...)` (Go: `store.Publish(...)`) commits the price before the produce, so the topic never announces a price that was rolled back or a proposal the guard refused. The draft produces first and commits afterwards.',
      match: {
        python: {order: [/store\.publish\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.publish\(/, /producer\.send\(/]},
        go: {order: [/store\.Publish\(/, /WriteMessages\(/]},
        scala: {order: [/store\.publish\(/, /producer\.send\(/]},
        cpp: {order: [/store\.publish\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'envelope',
      title: 'The envelope carries both prices and the reason',
      detail:
        'The event carries `sku`, `old_price_cents`, `new_price_cents` and `reason`, so an audit reader can reconstruct what moved and why. The draft publishes the model version and the new price only, losing the old price and the reason.',
      match: {
        python: {all: [/old_price_cents/, /new_price_cents/, /"sku":/, /"reason":/]},
        typescript: {all: [/old_price_cents/, /new_price_cents/, /sku:/, /reason:/]},
        go: {all: [/old_price_cents/, /new_price_cents/, /json:"sku"/, /json:"reason"/]},
        scala: {all: [/old_price_cents/, /new_price_cents/, /"sku"/, /"reason"/]},
        cpp: {all: [/old_price_cents/, /new_price_cents/, /"sku"/, /"reason"/]},
      },
    },
    {
      id: 'headroom-in-event',
      title: 'The event carries the window headroom',
      detail:
        'The event carries `moved_bp`, the basis points this change consumed from the window’s allowance, and `headroom_bp`, what is left of it — the figures the guard’s `EVAL` returned. The draft publishes neither, so a consumer can never see how close the sku is to `MAX_MOVE_BP`.',
      match: {
        python: {all: [/moved_bp/, /headroom_bp/]},
        typescript: {all: [/moved_bp/, /headroom_bp/]},
        go: {all: [/moved_bp/, /headroom_bp/]},
        scala: {all: [/moved_bp/, /headroom_bp/]},
        cpp: {all: [/moved_bp/, /headroom_bp/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Rejected produce goes to the outbox, relay republishes',
      detail:
        'A rejected produce writes an outbox row (`store.insert_outbox` / `insertOutbox` / `InsertOutbox`) instead of dropping the event, and the relay reads the undelivered rows back (`pending_outbox` / `pendingOutbox`) and republishes them — safe only with an idempotent producer at `acks=all`, because republishing the same record must not duplicate a move.',
      match: {
        python: {all: [/insert_outbox\(/, /pending_outbox\(/, /enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/insertOutbox\(/, /pendingOutbox\(/, /idempotent:\s*true/, /acks:\s*-1/]},
        go: {
          all: [
            /InsertOutbox\(/,
            /PendingOutbox\(/,
            /RequiredAcks:\s*kafka\.RequireAll/,
            /Balancer:\s*&kafka\.Hash\{\}/,
          ],
        },
        scala: {all: [/insertOutbox\(/, /pendingOutbox\(/, /enable\.idempotence/, /"acks"/]},
        cpp: {all: [/insertOutbox\(/, /pendingOutbox\(/, /enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""price.changed: a model-generated draft that emits a price event on the happy path."""
import json

from confluent_kafka import Producer
from pydantic import BaseModel

TOPIC = "price.changed"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class PriceStore:
    """The abstracted row store; the platform supplies the Postgres implementation."""

    def publish(self, sku: str, price_cents: int, reason: str, source: str, update_id: str) -> None:
        """Commits the price row and its audit entry."""
        raise NotImplementedError


store = PriceStore()


class PriceBody(BaseModel):
    sku: str
    price_cents: int
    reason: str
    model_version: str


def publish_change(body: PriceBody, reservation: dict) -> dict:
    # TODO: this draft keys price.changed by the model version, produces inside the same block
    # before store.publish commits, drops the old price, the reason and the guardrail headroom from
    # the envelope, and never looks at the produce result. Review all four.
    event = {"sku": body.sku, "model_version": body.model_version, "price_cents": body.price_cents}
    producer.produce(TOPIC, key=body.model_version, value=json.dumps(event))
    producer.flush()
    store.publish(body.sku, body.price_cents, body.reason, "model", "u-draft")
    return {"published": True}
`,
      solution: `"""price.changed: one audit event per published price, keyed by sku and produced after the commit."""
import json
import uuid

from confluent_kafka import KafkaException, Producer
from pydantic import BaseModel

TOPIC = "price.changed"
SOURCE = "model"
FLOOR_CENTS = 50
CEILING_CENTS = 500000
MAX_MOVE_BP = 2000
WINDOW_S = 3600
IDLE_SLEEP_S = 5.0

# acks=all with an idempotent producer: the relay republishes the same record after a rejection, and
# a duplicated price.changed would double-count a move in every consumer's headroom model.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class PriceStore:
    """The abstracted row store; the platform supplies the Postgres implementation."""

    def get_sku(self, sku: str) -> int:
        """The price the store currently holds for the sku."""
        raise NotImplementedError

    def publish(self, sku: str, price_cents: int, reason: str, source: str, update_id: str) -> None:
        """Commits the price row and its audit entry."""
        raise NotImplementedError

    def insert_outbox(self, sku: str, event: dict) -> None:
        """One row per event the broker rejected; the relay republishes it."""
        raise NotImplementedError

    def pending_outbox(self, limit: int) -> list:
        """The rows the relay has not delivered yet, oldest first."""
        raise NotImplementedError

    def mark_outbox_sent(self, ids: list) -> None:
        """Marks the rows the broker acknowledged — and only those."""
        raise NotImplementedError


store = PriceStore()


class PriceBody(BaseModel):
    sku: str
    price_cents: int
    reason: str


def new_update_id(sku: str) -> str:
    """Identifies this publish: the same id lands in the audit row and in the event."""
    return f"{sku}-{uuid.uuid4().hex}"


def publish_change(body: PriceBody, reservation: dict) -> dict:
    """Commits the price, then announces it: the topic must never describe a rolled-back price.

    \`reservation\` is what the guard's EVAL returned for this sku and window: the headroom this
    change consumed and what is left of it.
    """
    old_price_cents = store.get_sku(body.sku)
    update_id = new_update_id(body.sku)
    store.publish(body.sku, body.price_cents, body.reason, SOURCE, update_id)
    event = {
        "sku": body.sku,
        "old_price_cents": old_price_cents,
        "new_price_cents": body.price_cents,
        "moved_bp": reservation["moved"],
        "headroom_bp": reservation["left"],
        "source": SOURCE,
        "reason": body.reason,
        "update_id": update_id,
    }
    emit(body.sku, event)
    return {"published": True, "update_id": update_id}


def emit(sku: str, event: dict) -> None:
    """Produces under the sku key; a rejected produce is kept in the outbox instead of dropped."""
    try:
        producer.produce(TOPIC, key=sku, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(sku, event)


def relay_once(limit: int = 100) -> int:
    """Publishes one batch of outbox rows; returns how many were delivered.

    A row stays unsent until the broker acknowledges it, so a crash between the produce and the
    update replays the record instead of losing it — safe only because the produce is idempotent
    and the key does not change.
    """
    delivered = []
    for row in store.pending_outbox(limit):
        try:
            producer.produce(TOPIC, key=row["sku"], value=json.dumps(row["event"]))
            producer.flush(2.0)
        except KafkaException:
            break  # the broker is still rejecting: leave the rest for the next pass
        delivered.append(row["id"])
    if delivered:
        store.mark_outbox_sent(delivered)
    return len(delivered)
`,
    },
    typescript: {
      starter: `/** price.changed: a model-generated draft that emits a price event on the happy path. */
import {Kafka} from 'kafkajs';

const TOPIC = 'price.changed';

const producer = new Kafka({clientId: 'priced', brokers: ['kafka:9092']}).producer();

export interface PriceBody {
  sku: string;
  price_cents: number;
  reason: string;
  model_version: string;
}

export interface Reservation {
  moved: number;
  left: number;
  window: number;
}

export const store = {
  async publish(
    sku: string,
    priceCents: number,
    reason: string,
    source: string,
    updateId: string,
  ): Promise<void> {
    throw new Error('not implemented');
  },
};

export async function publishChange(body: PriceBody, reservation: Reservation): Promise<{published: boolean}> {
  // TODO: this draft keys price.changed by the model version, produces inside the same block before
  // store.publish commits, drops the old price, the reason and the guardrail headroom from the
  // envelope, and never looks at the produce result. Review all four.
  const event = {sku: body.sku, model_version: body.model_version, price_cents: body.price_cents};
  await producer.send({
    topic: TOPIC,
    messages: [{key: body.model_version, value: JSON.stringify(event)}],
  });
  await store.publish(body.sku, body.price_cents, body.reason, 'model', \`u-\${body.sku}\`);
  return {published: true};
}
`,
      solution: `/** price.changed: one audit event per published price, keyed by sku and produced after the commit. */
import {Kafka} from 'kafkajs';

const TOPIC = 'price.changed';
const SOURCE = 'model';
const FLOOR_CENTS = 50;
const CEILING_CENTS = 500000;
const MAX_MOVE_BP = 2000;
const WINDOW_S = 3600;
const IDLE_SLEEP_MS = 5000;

// acks=all with an idempotent producer: the relay republishes the same record after a rejection,
// and a duplicated price.changed would double-count a move in every consumer's headroom model.
const producer = new Kafka({clientId: 'priced', brokers: ['kafka:9092']}).producer({
  idempotent: true,
  maxInFlightRequests: 1,
});

export interface PriceBody {
  sku: string;
  price_cents: number;
  reason: string;
}

export interface Reservation {
  moved: number;
  left: number;
  window: number;
}

interface PriceEvent {
  sku: string;
  old_price_cents: number;
  new_price_cents: number;
  moved_bp: number;
  headroom_bp: number;
  source: string;
  reason: string;
  update_id: string;
}

interface OutboxRow {
  id: string;
  sku: string;
  event: PriceEvent;
}

export const store = {
  async getSku(sku: string): Promise<number> {
    throw new Error('not implemented');
  },
  async publish(
    sku: string,
    priceCents: number,
    reason: string,
    source: string,
    updateId: string,
  ): Promise<void> {
    throw new Error('not implemented');
  },
  async insertOutbox(sku: string, event: PriceEvent): Promise<void> {
    throw new Error('not implemented');
  },
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    throw new Error('not implemented');
  },
  async markOutboxSent(ids: string[]): Promise<void> {
    throw new Error('not implemented');
  },
};

/** Commits the price, then announces it: the topic must never describe a rolled-back price. */
export async function publishChange(
  body: PriceBody,
  reservation: Reservation,
): Promise<{published: boolean}> {
  const oldPriceCents = await store.getSku(body.sku);
  const updateId = \`\${body.sku}-\${Date.now()}\`;
  await store.publish(body.sku, body.price_cents, body.reason, SOURCE, updateId);
  const event: PriceEvent = {
    sku: body.sku,
    old_price_cents: oldPriceCents,
    new_price_cents: body.price_cents,
    moved_bp: reservation.moved,
    headroom_bp: reservation.left,
    source: SOURCE,
    reason: body.reason,
    update_id: updateId,
  };
  await emit(body.sku, event);
  return {published: true};
}

/** Produces under the sku key; a rejected produce is kept in the outbox instead of dropped. */
async function emit(sku: string, event: PriceEvent): Promise<void> {
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: sku, value: JSON.stringify(event)}],
    });
  } catch {
    await store.insertOutbox(sku, event);
  }
}

/** Republishes the undelivered outbox rows under the same sku key; returns how many were delivered. */
export async function relayOnce(limit = 100): Promise<number> {
  const delivered: string[] = [];
  for (const row of await store.pendingOutbox(limit)) {
    try {
      await producer.send({
        topic: TOPIC,
        acks: -1,
        messages: [{key: row.sku, value: JSON.stringify(row.event)}],
      });
    } catch {
      break; // the broker is still rejecting: the row stays unsent for the next pass
    }
    delivered.push(row.id);
  }
  if (delivered.length > 0) await store.markOutboxSent(delivered);
  return delivered.length;
}
`,
    },
    go: {
      starter: `// price.changed: a model-generated draft that emits a price event on the happy path.
package events

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var priceWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "price.changed"}

type PriceStore struct{}

func (s *PriceStore) Publish(ctx context.Context, sku string, priceCents int64, reason string, source string, updateID string) error {
	return nil
}

var store = &PriceStore{}

type PriceBody struct {
	SKU          string \`json:"sku"\`
	PriceCents   int64  \`json:"price_cents"\`
	Reason       string \`json:"reason"\`
	ModelVersion string \`json:"model_version"\`
}

type Reservation struct {
	Moved  int   \`json:"moved"\`
	Left   int   \`json:"left"\`
	Window int64 \`json:"window"\`
}

// TODO: this draft keys price.changed by the model version, produces inside the same block before
// store.Publish commits, drops the old price, the reason and the guardrail headroom from the
// envelope, and never looks at the produce result. Review all four.
func publishChange(ctx context.Context, body PriceBody, reservation Reservation) error {
	event := map[string]any{
		"sku":           body.SKU,
		"model_version": body.ModelVersion,
		"price_cents":   body.PriceCents,
	}
	payload, _ := json.Marshal(event)
	if err := priceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(body.ModelVersion), Value: payload}); err != nil {
		return err
	}
	return store.Publish(ctx, body.SKU, body.PriceCents, body.Reason, "model", "u-draft")
}
`,
      solution: `// price.changed: one audit event per published price, keyed by sku and produced after the commit.
package events

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	priceTopic = "price.changed"
	sourceName = "model"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a republish of the same
// sku key lands on the same partition instead of duplicating a price move.
var priceWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        priceTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type PriceEvent struct {
	SKU           string \`json:"sku"\`
	OldPriceCents int64  \`json:"old_price_cents"\`
	NewPriceCents int64  \`json:"new_price_cents"\`
	MovedBP       int    \`json:"moved_bp"\`
	HeadroomBP    int    \`json:"headroom_bp"\`
	Source        string \`json:"source"\`
	Reason        string \`json:"reason"\`
	UpdateID      string \`json:"update_id"\`
}

type OutboxRow struct {
	ID    string     \`json:"id"\`
	SKU   string     \`json:"sku"\`
	Event PriceEvent \`json:"event"\`
}

type PriceStore struct{}

func (s *PriceStore) GetSKU(ctx context.Context, sku string) (int64, error) { return 0, nil }

func (s *PriceStore) Publish(ctx context.Context, sku string, priceCents int64, reason string, source string, updateID string) error {
	return nil
}

func (s *PriceStore) InsertOutbox(ctx context.Context, sku string, event PriceEvent) error { return nil }

func (s *PriceStore) PendingOutbox(ctx context.Context, limit int) ([]OutboxRow, error) { return nil, nil }

func (s *PriceStore) MarkOutboxSent(ctx context.Context, ids []string) error { return nil }

var store = &PriceStore{}

type PriceBody struct {
	SKU        string \`json:"sku"\`
	PriceCents int64  \`json:"price_cents"\`
	Reason     string \`json:"reason"\`
}

type Reservation struct {
	Moved  int   \`json:"moved"\`
	Left   int   \`json:"left"\`
	Window int64 \`json:"window"\`
}

// publishChange commits the price, then announces it: the topic must never describe a price the
// store rolled back.
func publishChange(ctx context.Context, body PriceBody, reservation Reservation) (string, error) {
	oldPriceCents, err := store.GetSKU(ctx, body.SKU)
	if err != nil {
		return "", err
	}
	updateID := body.SKU + "-" + time.Now().UTC().Format(time.RFC3339Nano)
	if err := store.Publish(ctx, body.SKU, body.PriceCents, body.Reason, sourceName, updateID); err != nil {
		return "", err
	}
	event := PriceEvent{
		SKU:           body.SKU,
		OldPriceCents: oldPriceCents,
		NewPriceCents: body.PriceCents,
		MovedBP:       reservation.Moved,
		HeadroomBP:    reservation.Left,
		Source:        sourceName,
		Reason:        body.Reason,
		UpdateID:      updateID,
	}
	if err := emit(ctx, body.SKU, event); err != nil {
		return "", err
	}
	return updateID, nil
}

// emit produces under the sku key; a rejected produce is kept in the outbox instead of dropped.
func emit(ctx context.Context, sku string, event PriceEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := priceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(sku), Value: payload}); err != nil {
		return store.InsertOutbox(ctx, sku, event)
	}
	return nil
}

// relayOnce publishes one batch of outbox rows; returns how many were delivered.
func relayOnce(ctx context.Context, limit int) (int, error) {
	rows, err := store.PendingOutbox(ctx, limit)
	if err != nil {
		return 0, err
	}
	delivered := make([]string, 0, len(rows))
	for _, row := range rows {
		payload, err := json.Marshal(row.Event)
		if err != nil {
			return len(delivered), err
		}
		if err := priceWriter.WriteMessages(ctx, kafka.Message{Key: []byte(row.SKU), Value: payload}); err != nil {
			break // the broker is still rejecting: the row stays unsent for the next pass
		}
		delivered = append(delivered, row.ID)
	}
	if len(delivered) == 0 {
		return 0, nil
	}
	return len(delivered), store.MarkOutboxSent(ctx, delivered)
}
`,
    },
    scala: {
      starter: `// price.changed: a model-generated draft that emits a price event on the happy path.
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object Events {
  val producer = new KafkaProducer[String, String](new Properties())

  object store {
    def publish(sku: String, priceCents: Long, reason: String, source: String, updateId: String): Unit = ()
  }

  case class PriceBody(sku: String, priceCents: Long, reason: String, modelVersion: String)

  case class Reservation(moved: Int, left: Int, window: Long)

  // TODO: this draft keys price.changed by the model version, produces inside the same block before
  // store.publish commits, drops the old price, the reason and the guardrail headroom from the
  // envelope, and never looks at the produce result. Review all four.
  def publishChange(body: PriceBody, reservation: Reservation): Unit = {
    val event =
      Map("sku" -> body.sku, "model_version" -> body.modelVersion, "price_cents" -> body.priceCents).toJson.compactPrint
    producer.send(new ProducerRecord("price.changed", body.modelVersion, event))
    store.publish(body.sku, body.priceCents, body.reason, "model", "u-draft")
  }
}
`,
      solution: `// price.changed: one audit event per published price, keyed by sku and produced after the commit.
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object Events {
  // enable.idempotence with acks=all: the relay republishes records after a rejection, and a
  // duplicated price.changed would double-count a move in every consumer's headroom model.
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  val MaxMoveBp = 2000
  val WindowSeconds = 3600

  object store {
    def getSku(sku: String): Long = 0L

    def publish(sku: String, priceCents: Long, reason: String, source: String, updateId: String): Unit = ()

    def insertOutbox(sku: String, event: String): Unit = ()

    def pendingOutbox(limit: Int): List[OutboxRow] = Nil

    def markOutboxSent(ids: List[String]): Unit = ()
  }

  case class PriceBody(sku: String, priceCents: Long, reason: String)

  case class Reservation(moved: Int, left: Int, window: Long)

  case class OutboxRow(id: String, sku: String, event: String)

  // Commits the price, then announces it: the topic must never describe a rolled-back price.
  def publishChange(body: PriceBody, reservation: Reservation): String = {
    val oldPriceCents = store.getSku(body.sku)
    val updateId = s"\${body.sku}-\${System.currentTimeMillis()}"
    store.publish(body.sku, body.priceCents, body.reason, "model", updateId)
    val event = Map(
      "sku" -> body.sku,
      "old_price_cents" -> oldPriceCents,
      "new_price_cents" -> body.priceCents,
      "moved_bp" -> reservation.moved,
      "headroom_bp" -> reservation.left,
      "source" -> "model",
      "reason" -> body.reason,
      "update_id" -> updateId
    ).toJson.compactPrint
    emit(body.sku, event)
    updateId
  }

  /** Produces under the sku key; a rejected produce is kept in the outbox instead of dropped. */
  def emit(sku: String, payload: String): Unit = {
    try {
      producer.send(new ProducerRecord("price.changed", sku, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException => store.insertOutbox(sku, payload)
    }
  }

  /** Republishes the undelivered outbox rows under the same sku key; returns how many were delivered. */
  def relayOnce(limit: Int): Int = {
    val delivered = scala.collection.mutable.ListBuffer.empty[String]
    for (row <- store.pendingOutbox(limit)) {
      try {
        producer.send(new ProducerRecord("price.changed", row.sku, row.event))
      } catch {
        case _: org.apache.kafka.common.KafkaException => return delivered.size // still rejecting
      }
      delivered += row.id
    }
    if (delivered.nonEmpty) store.markOutboxSent(delivered.toList)
    delivered.size
  }
}
`,
    },
    cpp: {
      starter: `// price.changed: a model-generated draft that emits a price event on the happy path.
#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kPriceTopic = "price.changed";

std::unique_ptr<RdKafka::Producer> producer;

struct Reservation {
  int moved;
  int left;
  long window;
};

struct PriceStore {
  void publish(
      const std::string& sku,
      long long price_cents,
      const std::string& reason,
      const std::string& source,
      const std::string& update_id);
};

PriceStore store;

// TODO: this draft keys price.changed by the model version, produces inside the same block before
// store.publish commits, drops the old price, the reason and the guardrail headroom from the
// envelope, and never looks at the produce result. Review all four.
void publish_change(
    const std::string& sku,
    const std::string& model_version,
    long long price_cents,
    const std::string& reason,
    const Reservation& reservation) {
  const json event = {{"sku", sku}, {"model_version", model_version}, {"price_cents", price_cents}};
  const auto payload = event.dump();
  producer->produce(
      kPriceTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      model_version.data(),
      model_version.size(),
      0,
      nullptr);
  producer->flush(2000);
  store.publish(sku, price_cents, reason, "model", "u-draft");
}
`,
      solution: `// price.changed: one audit event per published price, keyed by sku and produced after the commit.
#include <librdkafka/rdkafkacpp.h>

#include <ctime>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kPriceTopic = "price.changed";
const std::string kSource = "model";
const int kMaxMoveBp = 2000;

struct Reservation {
  int moved;
  int left;
  long window;
};

struct PriceStore {
  long long getSku(const std::string& sku);

  void publish(
      const std::string& sku,
      long long price_cents,
      const std::string& reason,
      const std::string& source,
      const std::string& update_id);

  void insertOutbox(const std::string& sku, const json& event);

  std::vector<json> pendingOutbox(int limit);

  void markOutboxSent(const std::vector<std::string>& ids);
};

PriceStore store;

// enable.idempotence with acks=all: the relay republishes records after a rejection, and a
// duplicated price.changed would double-count a move in every consumer's headroom model.
std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// Commits the price, then announces it: the topic must never describe a rolled-back price.
void publish_change(
    const std::string& sku,
    long long price_cents,
    const std::string& reason,
    const Reservation& reservation) {
  const auto old_price_cents = store.getSku(sku);
  const std::string update_id = sku + "-" + std::to_string(std::time(nullptr));
  store.publish(sku, price_cents, reason, kSource, update_id);
  const json event = {
      {"sku", sku},
      {"old_price_cents", old_price_cents},
      {"new_price_cents", price_cents},
      {"moved_bp", reservation.moved},
      {"headroom_bp", reservation.left},
      {"source", kSource},
      {"reason", reason},
      {"update_id", update_id},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(
      kPriceTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      sku.data(),
      sku.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(sku, event);
  }
  producer->flush(2000);
}

// Republishes the undelivered outbox rows under the same sku key; returns how many were delivered.
int relay_once(int limit) {
  std::vector<std::string> delivered;
  for (const auto& row : store.pendingOutbox(limit)) {
    const auto payload = row["event"].dump();
    const auto sku = row["sku"].get<std::string>();
    const auto err = producer->produce(
        kPriceTopic,
        RdKafka::Topic::PARTITION_UA,
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(payload.data()),
        payload.size(),
        sku.data(),
        sku.size(),
        0,
        nullptr);
    if (err != RdKafka::ERR_NO_ERROR) break; // the broker is still rejecting: leave the row unsent
    delivered.push_back(row["id"].get<std::string>());
  }
  if (!delivered.empty()) {
    store.markOutboxSent(delivered);
  }
  return static_cast<int>(delivered.size());
}
`,
    },
  },
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong.
First, the message key is an ordering contract: partition by sku and one sku's price history arrives
in one partition in order, which is what lets an analyst or a consumer replay "what did this price
do" — key by the model version and the same sku's events scatter across partitions the moment the
model behind it changes. Second, publish after the commit: the stream is a record of what happened,
so an event produced before \`store.publish\` is a number the store may never hold, and every
downstream copy of the catalog disagrees with the database until someone notices. Third, exactly-once
*looking* code is not exactly-once: the audit chain needs the old price, the new price and the reason
or it cannot explain a change at all, the producer needs idempotence and \`acks=all\` for its own
retries, and the broker is not a database, so a rejected produce becomes an outbox row that the relay
republishes under the same sku key. Real platforms add a schema registry so consumers can trust the
envelope, a per-sku partition count that matches the traffic of hot skus, and a dead-letter topic for
events that are still unprocessable after the retries.`,
};
