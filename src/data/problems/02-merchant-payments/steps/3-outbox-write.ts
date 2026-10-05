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

from payments.db import db  # with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

TOPIC = "payments"
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def record_capture(order: dict, capture: dict) -> str:
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
    with db.transaction() as cur:
        cur.execute(
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

from payments.db import db  # with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

TOPIC = "payments"


def record_capture(order: dict, capture: dict) -> str:
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
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO orders (id, merchant_id, amount_cents, currency, status) VALUES (%s, %s, %s, %s, 'captured')",
            (order["id"], order["merchant_id"], capture["amount_cents"], capture["currency"]),
        )
        cur.execute(
            "INSERT INTO outbox (id, topic, key, payload) VALUES (%s, %s, %s, %s)",
            (event_id, TOPIC, order["merchant_id"], payload),
        )
    return event_id  # the relay publishes the row once the transaction is committed
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
  debrief: `A dual write has no atomicity: two systems, two failure points, and no way to make the second write conditional on the first surviving. The outbox borrows the database's transaction so the event is committed exactly when the order is; publishing becomes a separate, retryable job. Real systems either poll the table like the relay you build next or tail the write-ahead log with change data capture (Debezium), and they garbage-collect sent rows so the table does not grow forever.`,
};
