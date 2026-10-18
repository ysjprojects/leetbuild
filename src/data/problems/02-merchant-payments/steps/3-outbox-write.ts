import type {Step} from '@/lib/types';

// ---- 3. Transactional outbox: the write side ----------------------------------------------------
export const outboxWriteStep: Step = {
  id: 'outbox-write',
  title: 'Record the order and the event in one transaction',
  concept: 'kafka',
  file: 'outbox_writer',
  focus: ['checkout', 'db'],
  task: `## Task

Once the provider approves, checkout records the order and tells the rest of the platform with a
\`payment.captured\` event on the \`payments\` topic. The code you start from does a **dual write**: it commits
the order, then produces to Kafka. A crash between the two leaves an order the ledger never hears about.

Rewrite \`record_capture(order, capture)\` as a **transactional outbox**:

- Give the event a fresh UUID: it is both the outbox row id and the \`event_id\` in the payload, so the
  ledger can dedupe.
- Inside **one** database transaction (\`db.transaction()\` is provided: it begins, runs your code, and commits
  — or rolls back when you throw) insert the \`orders\` row **and** an \`outbox\` row with the columns
  \`(id, topic, key, payload)\`: the topic \`payments\`, the **merchant id** as the key, the event as JSON.
- Do **not** touch the Kafka producer here at all. Committed outbox rows are published by the relay you
  build next; the producer belongs there.

:::widget outbox {}

> The outbox row and the order row commit or roll back together. That is the whole trick: the database's
> atomicity becomes "the event exists iff the order exists".`,
  sequence: {
    participants: ['checkout', 'Postgres'],
    messages: [
      {from: 'checkout', to: 'Postgres', label: 'BEGIN', kind: 'sync'},
      {from: 'checkout', to: 'Postgres', label: 'INSERT INTO orders (…)', kind: 'sync'},
      {from: 'checkout', to: 'Postgres', label: 'INSERT INTO outbox (id, topic, key, payload)', kind: 'sync'},
      {from: 'checkout', to: 'Postgres', label: 'COMMIT', kind: 'sync'},
      {from: 'Postgres', to: 'checkout', label: 'ok — both rows or neither', kind: 'reply'},
    ],
  },
  hints: [
    'Move the second write *into* the transaction block and change what it writes: a row in `outbox`, not a Kafka record. The producer and its flush disappear from this file.',
    'The outbox row is a plain INSERT with four values: the event id, the topic name constant, the merchant id, and the serialised event. Serialise the event once, before the transaction.',
    'Generate the UUID first and use the same value in the row id and in the payload — the consumer will use the one inside the payload to dedupe.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Both rows are written inside the one transaction',
      detail:
        'The `orders` insert and the `outbox` insert must both run inside the `db.transaction` block so they commit or roll back together.',
      match: {
        python: {
          all: [
            /with db\.transaction\(\) as cur:(?:(?!\n {4}\S)[\s\S])*?INSERT INTO orders/,
            /with db\.transaction\(\) as cur:(?:(?!\n {4}\S)[\s\S])*?INSERT INTO outbox/,
          ],
        },
        typescript: {
          all: [
            /query\(\s*['"]BEGIN['"]\s*\)(?:(?!['"]COMMIT['"])[\s\S])*?INSERT INTO orders/,
            /query\(\s*['"]BEGIN['"]\s*\)(?:(?!['"]COMMIT['"])[\s\S])*?INSERT INTO outbox/,
          ],
        },
        go: {
          all: [
            /db\.Transaction\(\s*ctx\s*,\s*func\(tx \*sql\.Tx\) error \{(?:(?!\n\t\}\))[\s\S])*?INSERT INTO orders/,
            /db\.Transaction\(\s*ctx\s*,\s*func\(tx \*sql\.Tx\) error \{(?:(?!\n\t\}\))[\s\S])*?INSERT INTO outbox/,
          ],
        },
        scala: {
          all: [
            /Db\.transaction \{ conn =>(?:(?!\n {4}\})[\s\S])*?INSERT INTO orders/,
            /Db\.transaction \{ conn =>(?:(?!\n {4}\})[\s\S])*?INSERT INTO outbox/,
          ],
        },
        cpp: {
          all: [
            /db::transaction\(\[&\]\(pqxx::work& tx\) \{(?:(?!\n {2}\}\))[\s\S])*?INSERT INTO orders/,
            /db::transaction\(\[&\]\(pqxx::work& tx\) \{(?:(?!\n {2}\}\))[\s\S])*?INSERT INTO outbox/,
          ],
        },
      },
    },
    {
      id: 'outbox-row',
      title: 'The outbox row names the topic, the merchant key and the payload',
      detail:
        'Insert `(id, topic, key, payload)` = (event id, `payments`, merchant id, event JSON): everything the relay needs to produce the record without looking anything up.',
      match: {
        python: {
          all: [
            /INSERT INTO outbox \(id, topic, key, payload\)/,
            /\(\s*event_id\s*,\s*TOPIC\s*,\s*order\[["']merchant_id["']\]\s*,\s*payload\s*\)/,
          ],
        },
        typescript: {
          all: [
            /INSERT INTO outbox \(id, topic, key, payload\)/,
            /\[\s*eventId\s*,\s*TOPIC\s*,\s*order\.merchant_id\s*,\s*payload\s*,?\s*\]/,
          ],
        },
        go: {
          all: [
            /INSERT INTO outbox \(id, topic, key, payload\)/,
            /eventID\s*,\s*topic\s*,\s*order\.MerchantID\s*,\s*payload\s*\)/,
          ],
        },
        scala: {
          all: [
            /INSERT INTO outbox \(id, topic, key, payload\)/,
            /outbox\.setString\(\s*1\s*,\s*eventId\s*\)/,
            /outbox\.setString\(\s*2\s*,\s*Topic\s*\)/,
            /outbox\.setString\(\s*3\s*,\s*order\.merchantId\s*\)/,
            /outbox\.setString\(\s*4\s*,\s*payload\s*\)/,
          ],
        },
        cpp: {
          all: [
            /INSERT INTO outbox \(id, topic, key, payload\)/,
            /event_id\s*,\s*kTopic\s*,\s*order\.merchant_id\s*,\s*payload\s*\)/,
          ],
        },
      },
    },
    {
      id: 'no-dual-write',
      title: 'Never produces to Kafka from the request path',
      detail:
        'No producer call in this file: a produce after the commit can be lost, a produce before it can publish an order that rolls back. The relay publishes what the database committed.',
      match: {
        python: {none: [/producer\.produce\(/, /producer\.flush\(/, /Producer\(/]},
        typescript: {none: [/producer\.send\(/, /\.producer\(/, /from ['"]kafkajs['"]/]},
        go: {none: [/WriteMessages\(/, /kafka\.Writer\{/]},
        scala: {none: [/producer\.send\(/, /new KafkaProducer/]},
        cpp: {none: [/->produce\(/, /RdKafka::Producer/]},
      },
    },
    {
      id: 'event-id',
      title: 'The event carries a fresh UUID the consumer can dedupe on',
      detail:
        'Generate one UUID per event and put it in the payload as `event_id`; the ledger stores it to make its writes idempotent.',
      match: {
        python: {all: [/uuid\.uuid4\(\)/, /"event_id":\s*event_id/]},
        typescript: {all: [/randomUUID\(\)/, /event_id:\s*eventId/]},
        go: {all: [/uuid\.NewString\(\)|uuid\.New\(\)\.String\(\)/, /EventID:\s*eventID/]},
        scala: {all: [/UUID\.randomUUID\(\)/, /"event_id":"\$eventId"/]},
        cpp: {all: [/new_uuid\(\)/, /\\"event_id\\":\\""\s*\+\s*event_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
from datetime import datetime, timezone

from confluent_kafka import Producer

from payments.db import db  # async with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

TOPIC = "payments"
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


async def record_capture(order: dict, capture: dict) -> str:
    """Persist the order and publish payment.captured; returns the event id the ledger dedupes on."""
    event_id = ""  # TODO: str(uuid.uuid4()), used as the outbox row id and as event_id in the payload
    event = {
        "event_id": event_id,
        "type": "payment.captured",
        "merchant_id": order["merchant_id"],
        "order_id": order["id"],
        "amount_cents": capture["amount_cents"],
        "currency": capture["currency"],
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }
    payload = json.dumps(event)
    async with db.transaction() as cur:
        await cur.execute(
            "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES (%s, %s, %s, %s, 'captured')",
            (order["id"], order["merchant_id"], capture["amount_cents"], capture["currency"]),
        )
    # TODO: dual write — a crash right here loses the event. Replace it with an outbox row inside the transaction:
    # TODO: INSERT INTO outbox (id, topic, key, payload) VALUES (event_id, TOPIC, merchant id, payload)
    producer.produce(TOPIC, key=order["merchant_id"], value=payload)
    producer.flush()
    return event_id
`,
      solution: `import json
import uuid
from datetime import datetime, timezone

from payments.db import db  # async with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

TOPIC = "payments"


async def record_capture(order: dict, capture: dict) -> str:
    """Persist the order and the payment.captured event atomically; returns the event id the ledger dedupes on."""
    event_id = str(uuid.uuid4())
    event = {
        "event_id": event_id,
        "type": "payment.captured",
        "merchant_id": order["merchant_id"],
        "order_id": order["id"],
        "amount_cents": capture["amount_cents"],
        "currency": capture["currency"],
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }
    payload = json.dumps(event)
    async with db.transaction() as cur:
        await cur.execute(
            "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES (%s, %s, %s, %s, 'captured')",
            (order["id"], order["merchant_id"], capture["amount_cents"], capture["currency"]),
        )
        await cur.execute(
            "INSERT INTO outbox (id, topic, key, payload) VALUES (%s, %s, %s, %s)",
            (event_id, TOPIC, order["merchant_id"], payload),
        )
    return event_id  # the relay publishes the row once the transaction is committed
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {pool} from 'payments/db'; // pool.connect() → client: BEGIN, your statements, COMMIT (ROLLBACK on error), release()

export const TOPIC = 'payments';
const producer = new Kafka({clientId: 'checkout', brokers: ['kafka:9092']}).producer({idempotent: true});

export interface Order {
  id: string;
  merchant_id: string;
}

export interface Capture {
  amount_cents: number;
  currency: string;
}

/** Persist the order and publish payment.captured; returns the event id the ledger dedupes on. */
export async function recordCapture(order: Order, capture: Capture): Promise<string> {
  const eventId = ''; // TODO: randomUUID(), used as the outbox row id and as event_id in the payload
  const event = {
    event_id: eventId,
    type: 'payment.captured',
    merchant_id: order.merchant_id,
    order_id: order.id,
    amount_cents: capture.amount_cents,
    currency: capture.currency,
    captured_at: new Date().toISOString(),
  };
  const payload = JSON.stringify(event);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES ($1, $2, $3, $4, 'captured')",
      [order.id, order.merchant_id, capture.amount_cents, capture.currency],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  // TODO: dual write — a crash right here loses the event. Replace it with an outbox row inside the transaction:
  // TODO: INSERT INTO outbox (id, topic, key, payload) VALUES (eventId, TOPIC, merchant id, payload)
  await producer.connect();
  await producer.send({topic: TOPIC, messages: [{key: order.merchant_id, value: payload}]});
  return eventId;
}
`,
      solution: `import {randomUUID} from 'node:crypto';

import {pool} from 'payments/db'; // pool.connect() → client: BEGIN, your statements, COMMIT (ROLLBACK on error), release()

export const TOPIC = 'payments';

export interface Order {
  id: string;
  merchant_id: string;
}

export interface Capture {
  amount_cents: number;
  currency: string;
}

/** Persist the order and the payment.captured event atomically; returns the event id the ledger dedupes on. */
export async function recordCapture(order: Order, capture: Capture): Promise<string> {
  const eventId = randomUUID();
  const event = {
    event_id: eventId,
    type: 'payment.captured',
    merchant_id: order.merchant_id,
    order_id: order.id,
    amount_cents: capture.amount_cents,
    currency: capture.currency,
    captured_at: new Date().toISOString(),
  };
  const payload = JSON.stringify(event);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES ($1, $2, $3, $4, 'captured')",
      [order.id, order.merchant_id, capture.amount_cents, capture.currency],
    );
    await client.query('INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)', [
      eventId,
      TOPIC,
      order.merchant_id,
      payload,
    ]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return eventId; // the relay publishes the row once the transaction is committed
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"

	"payments/db" // db.Transaction(ctx, func(tx *sql.Tx) error) begins, runs, commits (rolls back on error)
)

const topic = "payments"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

type Order struct{ ID, MerchantID string }

type Capture struct {
	AmountCents int64
	Currency    string
}

type capturedEvent struct {
	EventID     string    \`json:"event_id"\`
	Type        string    \`json:"type"\`
	MerchantID  string    \`json:"merchant_id"\`
	OrderID     string    \`json:"order_id"\`
	AmountCents int64     \`json:"amount_cents"\`
	Currency    string    \`json:"currency"\`
	CapturedAt  time.Time \`json:"captured_at"\`
}

// recordCapture persists the order and publishes payment.captured; returns the event id the ledger dedupes on.
func recordCapture(ctx context.Context, order Order, capture Capture) (string, error) {
	eventID := "" // TODO: uuid.NewString(), used as the outbox row id and as event_id in the payload
	_ = uuid.NewString
	event := capturedEvent{EventID: eventID, Type: "payment.captured", MerchantID: order.MerchantID, OrderID: order.ID,
		AmountCents: capture.AmountCents, Currency: capture.Currency, CapturedAt: time.Now().UTC()}
	payload, _ := json.Marshal(event)
	err := db.Transaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES ($1, $2, $3, $4, 'captured')",
			order.ID, order.MerchantID, capture.AmountCents, capture.Currency)
		return err
	})
	if err != nil {
		return "", err
	}
	// TODO: dual write — a crash right here loses the event. Replace it with an outbox row inside the transaction:
	// TODO: INSERT INTO outbox (id, topic, key, payload) VALUES (eventID, topic, merchant id, payload)
	err = writer.WriteMessages(ctx, kafka.Message{Key: []byte(order.MerchantID), Value: payload})
	return eventID, err
}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"payments/db" // db.Transaction(ctx, func(tx *sql.Tx) error) begins, runs, commits (rolls back on error)
)

const topic = "payments"

type Order struct{ ID, MerchantID string }

type Capture struct {
	AmountCents int64
	Currency    string
}

type capturedEvent struct {
	EventID     string    \`json:"event_id"\`
	Type        string    \`json:"type"\`
	MerchantID  string    \`json:"merchant_id"\`
	OrderID     string    \`json:"order_id"\`
	AmountCents int64     \`json:"amount_cents"\`
	Currency    string    \`json:"currency"\`
	CapturedAt  time.Time \`json:"captured_at"\`
}

// recordCapture persists the order and the payment.captured event atomically; returns the event id the ledger dedupes on.
func recordCapture(ctx context.Context, order Order, capture Capture) (string, error) {
	eventID := uuid.NewString()
	event := capturedEvent{EventID: eventID, Type: "payment.captured", MerchantID: order.MerchantID, OrderID: order.ID,
		AmountCents: capture.AmountCents, Currency: capture.Currency, CapturedAt: time.Now().UTC()}
	payload, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	err = db.Transaction(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES ($1, $2, $3, $4, 'captured')",
			order.ID, order.MerchantID, capture.AmountCents, capture.Currency); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)",
			eventID, topic, order.MerchantID, payload)
		return err
	})
	if err != nil {
		return "", err
	}
	return eventID, nil // the relay publishes the row once the transaction is committed
}
`,
    },
    scala: {
      starter: `import java.time.Instant
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import payments.Db // Db.transaction { conn => ... } begins, runs the block, commits (rolls back on exception)

object OutboxWriter {
  val Topic = "payments"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  final case class Order(id: String, merchantId: String)
  final case class Capture(amountCents: Long, currency: String)

  /** Persists the order and publishes payment.captured; returns the event id the ledger dedupes on. */
  def recordCapture(order: Order, capture: Capture): String = {
    val eventId = "" // TODO: UUID.randomUUID().toString, used as the outbox row id and as event_id in the payload
    val payload =
      s"""{"event_id":"$eventId","type":"payment.captured","merchant_id":"\${order.merchantId}","order_id":"\${order.id}",""" +
        s""""amount_cents":\${capture.amountCents},"currency":"\${capture.currency}","captured_at":"\${Instant.now()}"}"""
    Db.transaction { conn =>
      val orders = conn.prepareStatement(
        "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES (?, ?, ?, ?, 'captured')")
      orders.setString(1, order.id); orders.setString(2, order.merchantId)
      orders.setLong(3, capture.amountCents); orders.setString(4, capture.currency)
      orders.executeUpdate()
    }
    // TODO: dual write — a crash right here loses the event. Replace it with an outbox row inside the transaction:
    // TODO: INSERT INTO outbox (id, topic, key, payload) VALUES (eventId, Topic, merchant id, payload)
    producer.send(new ProducerRecord[String, String](Topic, order.merchantId, payload)).get()
    eventId
  }
}
`,
      solution: `import java.time.Instant
import java.util.UUID

import payments.Db // Db.transaction { conn => ... } begins, runs the block, commits (rolls back on exception)

object OutboxWriter {
  val Topic = "payments"

  final case class Order(id: String, merchantId: String)
  final case class Capture(amountCents: Long, currency: String)

  /** Persists the order and the payment.captured event atomically; returns the event id the ledger dedupes on. */
  def recordCapture(order: Order, capture: Capture): String = {
    val eventId = UUID.randomUUID().toString
    val payload =
      s"""{"event_id":"$eventId","type":"payment.captured","merchant_id":"\${order.merchantId}","order_id":"\${order.id}",""" +
        s""""amount_cents":\${capture.amountCents},"currency":"\${capture.currency}","captured_at":"\${Instant.now()}"}"""
    Db.transaction { conn =>
      val orders = conn.prepareStatement(
        "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES (?, ?, ?, ?, 'captured')")
      orders.setString(1, order.id); orders.setString(2, order.merchantId)
      orders.setLong(3, capture.amountCents); orders.setString(4, capture.currency)
      orders.executeUpdate()
      val outbox = conn.prepareStatement("INSERT INTO outbox (id, topic, key, payload) VALUES (?, ?, ?, ?)")
      outbox.setString(1, eventId); outbox.setString(2, Topic)
      outbox.setString(3, order.merchantId); outbox.setString(4, payload)
      outbox.executeUpdate()
    }
    eventId // the relay publishes the row once the transaction is committed
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <pqxx/pqxx>

#include <cstdint>
#include <memory>
#include <string>

#include "clock.h"  // std::string iso_now();
#include "db.h"     // db::transaction(fn): begins, runs fn(pqxx::work&), commits (rolls back on throw)
#include "ids.h"    // std::string new_uuid();

const std::string kTopic = "payments";

struct Order {
  std::string id;
  std::string merchant_id;
};

struct Capture {
  int64_t amount_cents;
  std::string currency;
};

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Persists the order and publishes payment.captured; returns the event id the ledger dedupes on.
std::string record_capture(const Order& order, const Capture& capture) {
  const std::string event_id = "";  // TODO: new_uuid(), used as the outbox row id and as event_id in the payload
  const std::string payload = "{\\"event_id\\":\\"" + event_id + "\\",\\"type\\":\\"payment.captured\\",\\"merchant_id\\":\\"" +
                              order.merchant_id + "\\",\\"order_id\\":\\"" + order.id + "\\",\\"amount_cents\\":" +
                              std::to_string(capture.amount_cents) + ",\\"currency\\":\\"" + capture.currency +
                              "\\",\\"captured_at\\":\\"" + iso_now() + "\\"}";
  db::transaction([&](pqxx::work& tx) {
    tx.exec_params("INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES ($1, $2, $3, $4, 'captured')",
                   order.id, order.merchant_id, capture.amount_cents, capture.currency);
  });
  // TODO: dual write — a crash right here loses the event. Replace it with an outbox row inside the transaction:
  // TODO: INSERT INTO outbox (id, topic, key, payload) VALUES (event_id, kTopic, merchant id, payload)
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), order.merchant_id.c_str(), order.merchant_id.size(), 0, nullptr);
  producer->flush(5000);
  return event_id;
}
`,
      solution: `#include <pqxx/pqxx>

#include <cstdint>
#include <string>

#include "clock.h"  // std::string iso_now();
#include "db.h"     // db::transaction(fn): begins, runs fn(pqxx::work&), commits (rolls back on throw)
#include "ids.h"    // std::string new_uuid();

const std::string kTopic = "payments";

struct Order {
  std::string id;
  std::string merchant_id;
};

struct Capture {
  int64_t amount_cents;
  std::string currency;
};

// Persists the order and the payment.captured event atomically; returns the event id the ledger dedupes on.
std::string record_capture(const Order& order, const Capture& capture) {
  const std::string event_id = new_uuid();
  const std::string payload = "{\\"event_id\\":\\"" + event_id + "\\",\\"type\\":\\"payment.captured\\",\\"merchant_id\\":\\"" +
                              order.merchant_id + "\\",\\"order_id\\":\\"" + order.id + "\\",\\"amount_cents\\":" +
                              std::to_string(capture.amount_cents) + ",\\"currency\\":\\"" + capture.currency +
                              "\\",\\"captured_at\\":\\"" + iso_now() + "\\"}";
  db::transaction([&](pqxx::work& tx) {
    tx.exec_params("INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES ($1, $2, $3, $4, 'captured')",
                   order.id, order.merchant_id, capture.amount_cents, capture.currency);
    tx.exec_params("INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)",
                   event_id, kTopic, order.merchant_id, payload);
  });
  return event_id;  // the relay publishes the row once the transaction is committed
}
`,
    },
  },
  harness: {
    python: `import json
import uuid

SCHEMA = """
CREATE TABLE orders (
    id text PRIMARY KEY,
    merchant_id text NOT NULL,
    amount_cents bigint NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox (
    id text PRIMARY KEY,
    topic text NOT NULL,
    key text NOT NULL CHECK (key <> 'm-broken'),
    payload text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
"""

ORDER = {"id": "o-1", "merchant_id": "m-42"}
CAPTURE = {"amount_cents": 4999, "currency": "EUR"}


async def _module(ctx):
    await ctx.db.reset(SCHEMA)
    return ctx.load("outbox_writer")


async def _rows(ctx, table):
    return await ctx.db.execute(f"SELECT * FROM {table} ORDER BY created_at, id")


async def check_atomic(ctx):
    m = await _module(ctx)
    await m.record_capture(ORDER, CAPTURE)
    orders, outbox = await _rows(ctx, "orders"), await _rows(ctx, "outbox")
    assert len(orders) == 1, f"expected one orders row, found {len(orders)}"
    assert len(outbox) == 1, f"expected one outbox row next to the order, found {len(outbox)}"
    assert ctx.db.events == ["BEGIN", "COMMIT"], f"both rows must be written in one transaction; the database saw {ctx.db.events}"
    # The outbox insert for merchant m-broken violates a constraint: the order must roll back with it.
    try:
        await m.record_capture({"id": "o-2", "merchant_id": "m-broken"}, CAPTURE)
        raise AssertionError("a failed outbox insert must propagate (the transaction rolls back), not be swallowed")
    except AssertionError:
        raise
    except Exception:
        pass
    orders = await _rows(ctx, "orders")
    assert [o["id"] for o in orders] == ["o-1"], "the outbox insert failed but the orders row o-2 was committed: the two writes are not in one transaction"
    assert ctx.db.events[-1] == "ROLLBACK", f"the failed transaction must roll back, the database saw {ctx.db.events}"


async def check_outbox_row(ctx):
    m = await _module(ctx)
    event_id = await m.record_capture(ORDER, CAPTURE)
    outbox = await _rows(ctx, "outbox")
    assert len(outbox) == 1, f"expected one outbox row, found {len(outbox)}"
    row = outbox[0]
    assert row["topic"] == "payments", f"outbox.topic is {row['topic']!r}, expected 'payments'"
    assert row["key"] == "m-42", f"outbox.key is {row['key']!r}, expected the merchant id 'm-42'"
    assert row["sent_at"] is None, "a fresh outbox row is unsent"
    try:
        event = json.loads(row["payload"])
    except (TypeError, ValueError):
        raise AssertionError(f"outbox.payload must be the event as JSON, got {row['payload']!r}")
    expected = {"type": "payment.captured", "merchant_id": "m-42", "order_id": "o-1", "amount_cents": 4999, "currency": "EUR"}
    for field, value in expected.items():
        assert event.get(field) == value, f"payload.{field} is {event.get(field)!r}, expected {value!r}"
    assert event.get("event_id") == row["id"], f"payload.event_id {event.get('event_id')!r} must equal the row id {row['id']!r}"
    assert event_id == row["id"], f"record_capture returned {event_id!r}, expected the outbox row id {row['id']!r}"


async def check_no_dual_write(ctx):
    m = await _module(ctx)
    await m.record_capture(ORDER, CAPTURE)
    assert not any(e[0] == "producer" for e in ctx.kafka.events), "this file must not create a Kafka producer: the relay publishes committed outbox rows"
    assert ctx.kafka.records("payments") == [], f"record_capture produced {len(ctx.kafka.records('payments'))} record(s) to Kafka from the request path"
    assert ctx.kafka.flushes == 0, "record_capture must not flush a producer"
    assert len(await _rows(ctx, "outbox")) == 1, "the event must be an outbox row instead"


async def check_event_id(ctx):
    m = await _module(ctx)
    first = await m.record_capture(ORDER, CAPTURE)
    second = await m.record_capture({"id": "o-2", "merchant_id": "m-42"}, CAPTURE)
    for event_id in (first, second):
        try:
            parsed = uuid.UUID(str(event_id))
        except ValueError:
            raise AssertionError(f"the event id must be a UUID, got {event_id!r}")
        assert parsed.version == 4, f"the event id must be a random (version 4) UUID, got {event_id!r}"
    assert first != second, "every event needs its own UUID"
    outbox = await _rows(ctx, "outbox")
    ids = {row["id"] for row in outbox}
    assert ids == {first, second}, f"outbox row ids {ids} must be the returned event ids"
    for row in outbox:
        assert json.loads(row["payload"]).get("event_id") == row["id"], "payload.event_id must be the same UUID as the row id"
`,
    typescript: `const SCHEMA = \`
CREATE TABLE orders (
    id text PRIMARY KEY,
    merchant_id text NOT NULL,
    amount_cents bigint NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox (
    id text PRIMARY KEY,
    topic text NOT NULL,
    key text NOT NULL CHECK (key <> 'm-broken'),
    payload text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
\`;

const ORDER = {id: 'o-1', merchant_id: 'm-42'};
const CAPTURE = {amount_cents: 4999, currency: 'EUR'};
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function writer(ctx) {
  await ctx.db.reset(SCHEMA);
  return ctx.load('outbox_writer');
}

const rows = (ctx, table: string) => ctx.db.execute(\`SELECT * FROM \${table} ORDER BY created_at, id\`);

export async function check_atomic(ctx) {
  const m = await writer(ctx);
  await m.recordCapture(ORDER, CAPTURE);
  const orders = await rows(ctx, 'orders');
  const outbox = await rows(ctx, 'outbox');
  assert.equal(orders.length, 1, \`expected one orders row, found \${orders.length}\`);
  assert.equal(outbox.length, 1, \`expected one outbox row next to the order, found \${outbox.length}\`);
  assert.deepEqual(ctx.db.events, ['BEGIN', 'COMMIT'], \`both rows must be written in one transaction; the database saw \${JSON.stringify(ctx.db.events)}\`);
  // The outbox insert for merchant m-broken violates a constraint: the order must roll back with it.
  let threw = false;
  try {
    await m.recordCapture({id: 'o-2', merchant_id: 'm-broken'}, CAPTURE);
  } catch {
    threw = true;
  }
  assert(threw, 'a failed outbox insert must propagate (the transaction rolls back), not be swallowed');
  assert.equal(ctx.db.events[ctx.db.events.length - 1], 'ROLLBACK', \`the failed transaction must roll back, the database saw \${JSON.stringify(ctx.db.events)}\`);
  const ids = (await rows(ctx, 'orders')).map(o => o.id);
  assert.deepEqual(ids, ['o-1'], 'the outbox insert failed but the orders row o-2 was committed: the two writes are not in one transaction');
}

export async function check_outbox_row(ctx) {
  const m = await writer(ctx);
  const eventId = await m.recordCapture(ORDER, CAPTURE);
  const outbox = await rows(ctx, 'outbox');
  assert.equal(outbox.length, 1, \`expected one outbox row, found \${outbox.length}\`);
  const row = outbox[0];
  assert.equal(row.topic, 'payments', \`outbox.topic is \${JSON.stringify(row.topic)}, expected 'payments'\`);
  assert.equal(row.key, 'm-42', \`outbox.key is \${JSON.stringify(row.key)}, expected the merchant id 'm-42'\`);
  assert.equal(row.sent_at, null, 'a fresh outbox row is unsent');
  let event;
  try {
    event = JSON.parse(row.payload);
  } catch {
    assert.fail(\`outbox.payload must be the event as JSON, got \${JSON.stringify(row.payload)}\`);
  }
  const expected = {type: 'payment.captured', merchant_id: 'm-42', order_id: 'o-1', amount_cents: 4999, currency: 'EUR'};
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(event[field], value, \`payload.\${field} is \${JSON.stringify(event[field])}, expected \${JSON.stringify(value)}\`);
  }
  assert.equal(event.event_id, row.id, \`payload.event_id \${JSON.stringify(event.event_id)} must equal the row id \${JSON.stringify(row.id)}\`);
  assert.equal(eventId, row.id, \`recordCapture returned \${JSON.stringify(eventId)}, expected the outbox row id \${JSON.stringify(row.id)}\`);
}

export async function check_no_dual_write(ctx) {
  const m = await writer(ctx);
  await m.recordCapture(ORDER, CAPTURE);
  assert(!ctx.kafka.events.some(e => e[0] === 'producer' || e[0] === 'client'), 'this file must not create a Kafka client or producer: the relay publishes committed outbox rows');
  const produced = ctx.kafka.records('payments').length;
  assert.equal(produced, 0, \`recordCapture produced \${produced} record(s) to Kafka from the request path\`);
  assert.equal((await rows(ctx, 'outbox')).length, 1, 'the event must be an outbox row instead');
}

export async function check_event_id(ctx) {
  const m = await writer(ctx);
  const first = await m.recordCapture(ORDER, CAPTURE);
  const second = await m.recordCapture({id: 'o-2', merchant_id: 'm-42'}, CAPTURE);
  for (const eventId of [first, second]) {
    assert(UUID_V4.test(String(eventId)), \`the event id must be a random (version 4) UUID, got \${JSON.stringify(eventId)}\`);
  }
  assert.notEqual(first, second, 'every event needs its own UUID');
  const outbox = await rows(ctx, 'outbox');
  const ids = outbox.map(row => row.id).sort();
  assert.deepEqual(ids, [first, second].sort(), \`outbox row ids \${JSON.stringify(ids)} must be the returned event ids\`);
  for (const row of outbox) {
    assert.equal(JSON.parse(row.payload).event_id, row.id, 'payload.event_id must be the same UUID as the row id');
  }
}
`,
  },
  debrief: `A dual write has no atomicity: two systems, two failure points, and no way to make the second write conditional on the first surviving. The outbox borrows the database's transaction so the event is committed exactly when the order is; publishing becomes a separate, retryable job. Real systems either poll the table like the relay you build next or tail the write-ahead log with change data capture (Debezium), and they garbage-collect sent rows so the table does not grow forever.`,
};
