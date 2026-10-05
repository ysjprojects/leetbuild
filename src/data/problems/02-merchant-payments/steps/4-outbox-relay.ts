import type {Step} from '@/lib/types';

// ---- 4. Transactional outbox: the relay ---------------------------------------------------------
export const outboxRelayStep: Step = {
  id: 'outbox-relay',
  title: 'Relay committed outbox rows to Kafka',
  concept: 'kafka',
  file: 'outbox_relay',
  focus: ['db', 'relay', 'kafka'],
  task: `## Task

The relay is a small loop that turns committed outbox rows into Kafka records. \`fetch_unsent(cur)\` is
provided: inside the transaction it selects up to **100** unsent rows with \`FOR UPDATE SKIP LOCKED\`, so
several relays can run without publishing the same row.

- Configure the producer with **\`acks=all\`** and the **idempotent producer** enabled: a payment event
  must survive a broker failover, and the producer's own retries must not duplicate it.
- Produce every row to its \`topic\` with its \`key\` (the merchant id) so all events of one merchant stay
  in order on one partition.
- **Wait for the acknowledgements** — flush, join the futures, or collect delivery reports — **before**
  marking rows sent. A row marked sent whose record was lost is gone for good.
- Mark only the delivered rows: \`UPDATE outbox SET sent_at = now() WHERE id = …\`. Rows whose delivery
  failed stay unsent and are picked up next time.
- When a pass found nothing to send, sleep briefly before polling again.

:::widget outbox {}

> The relay is at-least-once by design: a crash after the acknowledgement and before the UPDATE re-sends
> the row. That is why the payload carries an \`event_id\` and why the consumer dedupes.`,
  sequence: {
    participants: ['relay', 'Postgres', 'Kafka'],
    messages: [
      {
        from: 'relay',
        to: 'Postgres',
        label: 'SELECT … WHERE sent_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED',
        kind: 'sync',
      },
      {from: 'Postgres', to: 'relay', label: '37 rows', kind: 'reply'},
      {from: 'relay', to: 'Kafka', label: 'produce ×37 (payments, key = merchant id)', kind: 'async'},
      {from: 'Kafka', to: 'relay', label: 'acks (all in-sync replicas)', kind: 'reply'},
      {
        from: 'relay',
        to: 'Postgres',
        label: 'UPDATE outbox SET sent_at = now() WHERE id = ANY(delivered)',
        kind: 'sync',
      },
      {from: 'relay', to: 'Postgres', label: 'COMMIT', kind: 'sync'},
    ],
  },
  hints: [
    'Two phases inside the transaction: produce everything, then block until the producer confirms delivery, then one UPDATE. Nothing about a row is written to the database before its acknowledgement arrived.',
    'You need to know *which* rows were acknowledged: pass the row id along with the record (a closure, an opaque pointer, a future per row) and collect the ids that succeeded.',
    'The idle sleep belongs in the outer loop, keyed on the count the pass returned — a busy relay never sleeps, an idle one polls a couple of times per second.',
  ],
  checks: [
    {
      id: 'durable-producer',
      title: 'Producer waits for all in-sync replicas and is idempotent',
      detail:
        '`acks=all` means a leader failover cannot lose an acknowledged record; the idempotent producer means the client-side retries that `acks=all` makes likely cannot duplicate one. (kafka-go has no idempotent mode: `RequireAll` is what it can promise.)',
      match: {
        python: {all: [/"acks"\s*:\s*"all"/, /"enable\.idempotence"\s*:\s*True/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"\s*,\s*"true"/]},
      },
    },
    {
      id: 'keyed',
      title: 'Produces each row to its topic with the merchant key',
      detail:
        "The record key is the row's `key` column (the merchant id) so one merchant's events share a partition and keep their order.",
      match: {
        python: {
          all: [
            /producer\.produce\(\s*topic\s*,[^\n]*\bkey\s*=\s*key\b|producer\.produce\(\s*topic\s*,\s*payload\s*,\s*key\b/,
            /producer\.produce\(\s*topic\s*,[^\n]*\bvalue\s*=\s*payload\b|producer\.produce\(\s*topic\s*,\s*payload\b/,
          ],
        },
        go: {
          all: [
            /kafka\.Message\{[^\n]*Topic:\s*\w+\.Topic/,
            /Key:\s*\[\]byte\(\s*\w+\.Key\s*\)/,
            /Value:\s*\w+\.Payload/,
          ],
        },
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*(\w+)\.topic\s*,\s*\1\.key\s*,\s*\1\.payload\s*\)/]},
        cpp: {all: [/(\w+)\.key\.(c_str|data)\(\)\s*,\s*\1\.key\.(size|length)\(\)/]},
      },
    },
    {
      id: 'ack-before-mark',
      title: 'Waits for delivery before marking rows sent',
      detail:
        'Produce, then block until every acknowledgement is in, then UPDATE: marking first would turn a lost record into a lost payment.',
      match: {
        python: {order: [/producer\.produce\(/, /producer\.flush\(/, /UPDATE outbox SET sent_at/]},
        go: {order: [/writer\.WriteMessages\(/, /UPDATE outbox SET sent_at/], none: [/Async:\s*true/]},
        scala: {order: [/producer\.send\(/, /\.get\(\)/, /UPDATE outbox SET sent_at/]},
        cpp: {order: [/producer->produce\(/, /producer->flush\(/, /UPDATE outbox SET sent_at/]},
      },
    },
    {
      id: 'mark-delivered',
      title: 'Marks only the delivered rows',
      detail:
        'The UPDATE uses the ids whose delivery succeeded; a failed record leaves its row unsent so the next pass retries it.',
      match: {
        python: {all: [/UPDATE outbox SET sent_at = now\(\) WHERE id = ANY\(%s\)"\s*,\s*\(\s*\w+\s*,\s*\)/]},
        go: {all: [/UPDATE outbox SET sent_at = now\(\) WHERE id = ANY\(\$1\)/, /pq\.Array\(\s*\w+\s*\)/]},
        scala: {
          all: [
            /UPDATE outbox SET sent_at = now\(\) WHERE id = \?/,
            /\.setString\(\s*1\s*,\s*\w+\s*\)/,
            /\.executeBatch\(\)|\.executeUpdate\(\)/,
          ],
        },
        cpp: {
          all: [/UPDATE outbox SET sent_at = now\(\) WHERE id = \$1/, /for \([^)\n]*:\s*reports\.delivered\s*\)/],
        },
      },
    },
    {
      id: 'idle-sleep',
      title: 'Sleeps when there was nothing to send',
      detail:
        'An empty pass sleeps briefly before the next poll; a tight loop over an empty table is a denial of service against your own database.',
      match: {
        python: {all: [/def run\(\)(?:(?!\ndef )[\s\S])*?time\.sleep\(\s*IDLE_SLEEP_S\s*\)/]},
        go: {all: [/func run\((?:(?!\n\})[\s\S])*?time\.Sleep\(\s*idleSleep\s*\)/]},
        scala: {all: [/def run\(\)(?:(?!\n {2}def )[\s\S])*?Thread\.sleep\(\s*IdleSleepMillis\s*\)/]},
        cpp: {all: [/void run\(\)(?:(?!\n\})[\s\S])*?sleep_for\(\s*kIdleSleep\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

from confluent_kafka import KafkaError, Message, Producer

from payments.db import db  # with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

BATCH = 100
IDLE_SLEEP_S = 0.5
log = logging.getLogger("outbox-relay")

producer = Producer({"bootstrap.servers": "kafka:9092"})  # TODO: acks=all and the idempotent producer


def fetch_unsent(cur) -> list[tuple[str, str, str, str]]:
    """(id, topic, key, payload) of up to BATCH unsent rows, locked for this transaction."""
    cur.execute(
        "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED",
        (BATCH,),
    )
    return cur.fetchall()


def relay_once() -> int:
    """Publishes one batch of outbox rows; returns how many were delivered."""
    with db.transaction() as cur:
        rows = fetch_unsent(cur)
        # TODO: produce each row to its topic keyed by key, with a delivery callback that records the row id
        # TODO: flush — block until every delivery report fired — BEFORE touching the table
        # TODO: UPDATE outbox SET sent_at = now() WHERE id = ANY(%s) for the delivered ids only
        return 0


def run() -> None:
    # TODO: loop relay_once(); sleep IDLE_SLEEP_S when it delivered nothing
    raise NotImplementedError
`,
      solution: `import logging
import time

from confluent_kafka import KafkaError, Message, Producer

from payments.db import db  # with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

BATCH = 100
IDLE_SLEEP_S = 0.5
log = logging.getLogger("outbox-relay")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def fetch_unsent(cur) -> list[tuple[str, str, str, str]]:
    """(id, topic, key, payload) of up to BATCH unsent rows, locked for this transaction."""
    cur.execute(
        "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED",
        (BATCH,),
    )
    return cur.fetchall()


def relay_once() -> int:
    """Publishes one batch of outbox rows; returns how many were delivered."""
    with db.transaction() as cur:
        rows = fetch_unsent(cur)
        if not rows:
            return 0
        delivered: list[str] = []

        def on_delivery(row_id: str):
            def report(err: KafkaError | None, msg: Message) -> None:
                if err is None:
                    delivered.append(row_id)
                else:
                    log.warning("outbox %s not delivered: %s", row_id, err)

            return report

        for row_id, topic, key, payload in rows:
            producer.produce(topic, key=key, value=payload, on_delivery=on_delivery(row_id))
        producer.flush()  # blocks until every delivery report has fired
        if delivered:
            cur.execute("UPDATE outbox SET sent_at = now() WHERE id = ANY(%s)", (delivered,))
        return len(delivered)


def run() -> None:
    while True:
        if relay_once() == 0:
            time.sleep(IDLE_SLEEP_S)  # nothing to send: do not hammer the database
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/lib/pq"
	"github.com/segmentio/kafka-go"

	"payments/db" // db.Transaction(ctx, func(tx *sql.Tx) error) begins, runs, commits (rolls back on error)
)

const (
	batch     = 100
	idleSleep = 500 * time.Millisecond
)

// TODO: RequiredAcks all (kafka-go has no idempotent mode); Balancer Hash so equal keys share a partition
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}}

type outboxRow struct {
	ID, Topic, Key string
	Payload        []byte
}

// fetchUnsent returns up to batch unsent rows, locked for this transaction.
func fetchUnsent(ctx context.Context, tx *sql.Tx) ([]outboxRow, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED", batch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.ID, &r.Topic, &r.Key, &r.Payload); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// relayOnce publishes one batch of outbox rows; returns how many were delivered.
func relayOnce(ctx context.Context) (int, error) {
	sent := 0
	err := db.Transaction(ctx, func(tx *sql.Tx) error {
		rows, err := fetchUnsent(ctx, tx)
		if err != nil {
			return err
		}
		// TODO: one kafka.Message per row (Topic, Key, Value); WriteMessages is synchronous: it returns after the acks
		// TODO: on a kafka.WriteErrors, keep the ids whose entry is nil; on any other error, return it
		// TODO: UPDATE outbox SET sent_at = now() WHERE id = ANY($1) with pq.Array of the delivered ids only
		_ = rows
		_ = errors.As
		_ = pq.Array
		return nil
	})
	return sent, err
}

func run(ctx context.Context) {
	// TODO: loop relayOnce; sleep idleSleep when it delivered nothing
	log.Println("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/lib/pq"
	"github.com/segmentio/kafka-go"

	"payments/db" // db.Transaction(ctx, func(tx *sql.Tx) error) begins, runs, commits (rolls back on error)
)

const (
	batch     = 100
	idleSleep = 500 * time.Millisecond
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

type outboxRow struct {
	ID, Topic, Key string
	Payload        []byte
}

// fetchUnsent returns up to batch unsent rows, locked for this transaction.
func fetchUnsent(ctx context.Context, tx *sql.Tx) ([]outboxRow, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED", batch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.ID, &r.Topic, &r.Key, &r.Payload); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// relayOnce publishes one batch of outbox rows; returns how many were delivered.
func relayOnce(ctx context.Context) (int, error) {
	sent := 0
	err := db.Transaction(ctx, func(tx *sql.Tx) error {
		rows, err := fetchUnsent(ctx, tx)
		if err != nil || len(rows) == 0 {
			return err
		}
		msgs := make([]kafka.Message, len(rows))
		for i, row := range rows {
			msgs[i] = kafka.Message{Topic: row.Topic, Key: []byte(row.Key), Value: row.Payload}
		}
		err = writer.WriteMessages(ctx, msgs...) // synchronous: returns once every record is acknowledged
		delivered := make([]string, 0, len(rows))
		var writeErrs kafka.WriteErrors
		switch {
		case err == nil:
			for _, row := range rows {
				delivered = append(delivered, row.ID)
			}
		case errors.As(err, &writeErrs):
			for i, e := range writeErrs {
				if e == nil {
					delivered = append(delivered, rows[i].ID)
				} else {
					log.Printf("outbox %s not delivered: %v", rows[i].ID, e)
				}
			}
		default:
			return err
		}
		if len(delivered) > 0 {
			if _, err := tx.ExecContext(ctx, "UPDATE outbox SET sent_at = now() WHERE id = ANY($1)", pq.Array(delivered)); err != nil {
				return err
			}
		}
		sent = len(delivered)
		return nil
	})
	return sent, err
}

func run(ctx context.Context) {
	for ctx.Err() == nil {
		n, err := relayOnce(ctx)
		if err != nil {
			log.Printf("relay pass failed: %v", err)
		}
		if n == 0 {
			time.Sleep(idleSleep) // nothing to send: do not hammer the database
		}
	}
}
`,
    },
    scala: {
      starter: `import java.sql.Connection
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import payments.Db // Db.transaction { conn => ... } begins, runs the block, commits (rolls back on exception)
import scala.util.{Failure, Success, Try}

object OutboxRelay {
  val Batch = 100
  val IdleSleepMillis = 500L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // TODO: acks=all and the idempotent producer
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  final case class Row(id: String, topic: String, key: String, payload: String)

  /** Up to Batch unsent rows, locked for this transaction. */
  def fetchUnsent(conn: Connection): Vector[Row] = {
    val st = conn.prepareStatement(
      "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED")
    st.setInt(1, Batch)
    val rs = st.executeQuery()
    Iterator.continually(rs).takeWhile(_.next()).map(r => Row(r.getString(1), r.getString(2), r.getString(3), r.getString(4))).toVector
  }

  /** Publishes one batch of outbox rows; returns how many were delivered. */
  def relayOnce(): Int = Db.transaction { conn =>
    val rows = fetchUnsent(conn)
    // TODO: send one ProducerRecord per row (row.topic, row.key, row.payload) and keep the futures
    // TODO: get() every future — block for the acks — BEFORE touching the table; keep the ids that succeeded
    // TODO: UPDATE outbox SET sent_at = now() WHERE id = ? as a batch over the delivered ids only
    0
  }

  def run(): Unit = {
    // TODO: loop relayOnce(); sleep IdleSleepMillis when it delivered nothing
  }
}
`,
      solution: `import java.sql.Connection
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import payments.Db // Db.transaction { conn => ... } begins, runs the block, commits (rolls back on exception)
import scala.util.{Failure, Success, Try}

object OutboxRelay {
  val Batch = 100
  val IdleSleepMillis = 500L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  final case class Row(id: String, topic: String, key: String, payload: String)

  /** Up to Batch unsent rows, locked for this transaction. */
  def fetchUnsent(conn: Connection): Vector[Row] = {
    val st = conn.prepareStatement(
      "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED")
    st.setInt(1, Batch)
    val rs = st.executeQuery()
    Iterator.continually(rs).takeWhile(_.next()).map(r => Row(r.getString(1), r.getString(2), r.getString(3), r.getString(4))).toVector
  }

  /** Publishes one batch of outbox rows; returns how many were delivered. */
  def relayOnce(): Int = Db.transaction { conn =>
    val rows = fetchUnsent(conn)
    if (rows.isEmpty) 0
    else {
      val inFlight = rows.map(row => row -> producer.send(new ProducerRecord[String, String](row.topic, row.key, row.payload)))
      val delivered = inFlight.flatMap { case (row, future) =>
        Try(future.get()) match { // blocks until the broker acknowledged this record
          case Success(_) => Some(row.id)
          case Failure(e) => System.err.println(s"outbox \${row.id} not delivered: \${e.getMessage}"); None
        }
      }
      val mark = conn.prepareStatement("UPDATE outbox SET sent_at = now() WHERE id = ?")
      delivered.foreach { id => mark.setString(1, id); mark.addBatch() }
      mark.executeBatch()
      delivered.size
    }
  }

  def run(): Unit =
    while (true)
      if (relayOnce() == 0) Thread.sleep(IdleSleepMillis) // nothing to send: do not hammer the database
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <pqxx/pqxx>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "db.h"  // db::transaction(fn): begins, runs fn(pqxx::work&), commits (rolls back on throw)

constexpr int kBatch = 100;
constexpr std::chrono::milliseconds kIdleSleep{500};

struct Row {
  std::string id, topic, key, payload;
};

// TODO: a DeliveryReportCb collecting the ids (passed as msg_opaque) of delivered records into \`delivered\`
struct CollectDelivered : RdKafka::DeliveryReportCb {
  std::vector<std::string> delivered;
  void dr_cb(RdKafka::Message& message) override {}
};

CollectDelivered reports;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // TODO: acks=all, enable.idempotence=true, dr_cb=&reports
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Up to kBatch unsent rows, locked for this transaction.
std::vector<Row> fetch_unsent(pqxx::work& tx) {
  std::vector<Row> rows;
  for (const auto& r : tx.exec_params(
           "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED", kBatch))
    rows.push_back({r[0].as<std::string>(), r[1].as<std::string>(), r[2].as<std::string>(), r[3].as<std::string>()});
  return rows;
}

// Publishes one batch of outbox rows; returns how many were delivered.
int relay_once() {
  int sent = 0;
  db::transaction([&](pqxx::work& tx) {
    const std::vector<Row> rows = fetch_unsent(tx);
    // TODO: produce each row to row.topic keyed by row.key, with &row.id as msg_opaque
    // TODO: flush — block until every delivery report fired — BEFORE touching the table
    // TODO: UPDATE outbox SET sent_at = now() WHERE id = $1 for each id in reports.delivered
  });
  return sent;
}

void run() {
  // TODO: loop relay_once(); sleep kIdleSleep when it delivered nothing
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <pqxx/pqxx>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "db.h"  // db::transaction(fn): begins, runs fn(pqxx::work&), commits (rolls back on throw)

constexpr int kBatch = 100;
constexpr std::chrono::milliseconds kIdleSleep{500};

struct Row {
  std::string id, topic, key, payload;
};

struct CollectDelivered : RdKafka::DeliveryReportCb {
  std::vector<std::string> delivered;
  void dr_cb(RdKafka::Message& message) override {
    const auto& id = *static_cast<const std::string*>(message.msg_opaque());
    if (message.err() == RdKafka::ERR_NO_ERROR) delivered.push_back(id);
    else std::cerr << "outbox " << id << " not delivered: " << message.errstr() << "\\n";
  }
};

CollectDelivered reports;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &reports, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Up to kBatch unsent rows, locked for this transaction.
std::vector<Row> fetch_unsent(pqxx::work& tx) {
  std::vector<Row> rows;
  for (const auto& r : tx.exec_params(
           "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED", kBatch))
    rows.push_back({r[0].as<std::string>(), r[1].as<std::string>(), r[2].as<std::string>(), r[3].as<std::string>()});
  return rows;
}

// Publishes one batch of outbox rows; returns how many were delivered.
int relay_once() {
  int sent = 0;
  db::transaction([&](pqxx::work& tx) {
    const std::vector<Row> rows = fetch_unsent(tx);
    if (rows.empty()) return;
    reports.delivered.clear();
    for (const Row& row : rows)
      producer->produce(row.topic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                        const_cast<char*>(row.payload.data()), row.payload.size(), row.key.c_str(), row.key.size(), 0,
                        const_cast<std::string*>(&row.id));
    producer->flush(10000);  // blocks until every delivery report has fired
    for (const auto& id : reports.delivered) tx.exec_params("UPDATE outbox SET sent_at = now() WHERE id = $1", id);
    sent = static_cast<int>(reports.delivered.size());
  });
  return sent;
}

void run() {
  while (true)
    if (relay_once() == 0) std::this_thread::sleep_for(kIdleSleep);  // nothing to send: do not hammer the database
}
`,
    },
  },
  debrief: `The relay is where "durable" is decided: \`acks=all\` plus the idempotent producer make the broker side safe, and marking rows only after the acknowledgement makes the database side honest about what was published. Everything else is throughput: batches of 100, \`SKIP LOCKED\` so relays scale out, an idle sleep so an empty table costs nothing. Production relays add a \`sent_at\` sweeper that deletes old rows, back off on broker errors, and are usually replaced by change data capture once volume grows.`,
};
