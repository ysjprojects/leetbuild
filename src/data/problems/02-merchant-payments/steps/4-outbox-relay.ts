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
        typescript: {all: [/\.producer\(\{[^}\n]*idempotent:\s*true/, /acks:\s*-1/]},
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
        typescript: {all: [/topic:\s*\w+\.topic/, /key:\s*\w+\.key/, /value:\s*\w+\.payload/]},
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
        typescript: {
          all: [/await (producer\.send\(|Promise\.all(Settled)?\()/],
          order: [/producer\.send\(/, /UPDATE outbox SET sent_at/],
        },
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
        typescript: {all: [/UPDATE outbox SET sent_at = now\(\) WHERE id = ANY\(\$1\)['"]\s*,\s*\[\s*\w+\s*\]/]},
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
        python: {all: [/async def run\(\)(?:(?!\ndef )[\s\S])*?await asyncio\.sleep\(\s*IDLE_SLEEP_S\s*\)/]},
        typescript: {all: [/async function run\(\)(?:(?!\nexport )[\s\S])*?await sleep\(\s*IDLE_SLEEP_MS\s*\)/]},
        go: {all: [/func run\((?:(?!\n\})[\s\S])*?time\.Sleep\(\s*idleSleep\s*\)/]},
        scala: {all: [/def run\(\)(?:(?!\n {2}def )[\s\S])*?Thread\.sleep\(\s*IdleSleepMillis\s*\)/]},
        cpp: {all: [/void run\(\)(?:(?!\n\})[\s\S])*?sleep_for\(\s*kIdleSleep\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import logging

from confluent_kafka import KafkaError, Message, Producer

from payments.db import db  # async with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

BATCH = 100
IDLE_SLEEP_S = 0.5
log = logging.getLogger("outbox-relay")

producer = Producer({"bootstrap.servers": "kafka:9092"})  # TODO: acks=all and the idempotent producer


async def fetch_unsent(cur) -> list[tuple[str, str, str, str]]:
    """(id, topic, key, payload) of up to BATCH unsent rows, locked for this transaction."""
    await cur.execute(
        "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED",
        (BATCH,),
    )
    rows = await cur.fetchall()
    return [(row["id"], row["topic"], row["key"], row["payload"]) for row in rows]


async def relay_once() -> int:
    """Publishes one batch of outbox rows; returns how many were delivered."""
    async with db.transaction() as cur:
        rows = await fetch_unsent(cur)
        # TODO: produce each row to its topic keyed by key, with a delivery callback that records the row id
        # TODO: flush — block until every delivery report fired — BEFORE touching the table
        # TODO: UPDATE outbox SET sent_at = now() WHERE id = ANY(%s) for the delivered ids only
        return 0


async def run() -> None:
    # TODO: loop relay_once(); sleep IDLE_SLEEP_S when it delivered nothing
    raise NotImplementedError
`,
      solution: `import asyncio
import logging

from confluent_kafka import KafkaError, Message, Producer

from payments.db import db  # async with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)

BATCH = 100
IDLE_SLEEP_S = 0.5
log = logging.getLogger("outbox-relay")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


async def fetch_unsent(cur) -> list[tuple[str, str, str, str]]:
    """(id, topic, key, payload) of up to BATCH unsent rows, locked for this transaction."""
    await cur.execute(
        "SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED",
        (BATCH,),
    )
    rows = await cur.fetchall()
    return [(row["id"], row["topic"], row["key"], row["payload"]) for row in rows]


async def relay_once() -> int:
    """Publishes one batch of outbox rows; returns how many were delivered."""
    async with db.transaction() as cur:
        rows = await fetch_unsent(cur)
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
            await cur.execute("UPDATE outbox SET sent_at = now() WHERE id = ANY(%s)", (delivered,))
        return len(delivered)


async def run() -> None:
    while True:
        if await relay_once() == 0:
            await asyncio.sleep(IDLE_SLEEP_S)  # nothing to send: do not hammer the database
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';
import {setTimeout as sleep} from 'node:timers/promises';
import type {PoolClient} from 'pg';

import {pool} from 'payments/db'; // pool.connect() → client: BEGIN, your statements, COMMIT (ROLLBACK on error), release()

export const BATCH = 100;
export const IDLE_SLEEP_MS = 500;

const kafka = new Kafka({clientId: 'outbox-relay', brokers: ['kafka:9092']});
export const producer = kafka.producer(); // TODO: the idempotent producer (which requires acks all)

export interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: string;
}

/** Up to BATCH unsent rows, locked for this transaction. */
export async function fetchUnsent(client: PoolClient): Promise<OutboxRow[]> {
  const {rows} = await client.query<OutboxRow>(
    'SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED',
    [BATCH],
  );
  return rows;
}

/** Publishes one batch of outbox rows; returns how many were delivered. */
export async function relayOnce(): Promise<number> {
  await producer.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await fetchUnsent(client);
    // TODO: producer.send each row to its topic keyed by key with acks: -1; a resolved send is a delivered row id
    // TODO: wait for every send to settle — the acknowledgements — BEFORE touching the table
    // TODO: UPDATE outbox SET sent_at = now() WHERE id = ANY($1) for the delivered ids only
    await client.query('COMMIT');
    return 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function run(): Promise<void> {
  // TODO: loop relayOnce(); sleep IDLE_SLEEP_MS when it delivered nothing
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';
import {setTimeout as sleep} from 'node:timers/promises';
import type {PoolClient} from 'pg';

import {pool} from 'payments/db'; // pool.connect() → client: BEGIN, your statements, COMMIT (ROLLBACK on error), release()

export const BATCH = 100;
export const IDLE_SLEEP_MS = 500;

const kafka = new Kafka({clientId: 'outbox-relay', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true}); // the idempotent producer requires acks all

export interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: string;
}

/** Up to BATCH unsent rows, locked for this transaction. */
export async function fetchUnsent(client: PoolClient): Promise<OutboxRow[]> {
  const {rows} = await client.query<OutboxRow>(
    'SELECT id, topic, key, payload FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED',
    [BATCH],
  );
  return rows;
}

/** Publishes one batch of outbox rows; returns how many were delivered. */
export async function relayOnce(): Promise<number> {
  await producer.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await fetchUnsent(client);
    const delivered: string[] = [];
    for (const row of rows) {
      try {
        await producer.send({topic: row.topic, messages: [{key: row.key, value: row.payload}], acks: -1});
        delivered.push(row.id); // acknowledged by every in-sync replica
      } catch (e) {
        console.warn(\`outbox \${row.id} not delivered: \${e instanceof Error ? e.message : String(e)}\`);
      }
    }
    if (delivered.length > 0) {
      await client.query('UPDATE outbox SET sent_at = now() WHERE id = ANY($1)', [delivered]);
    }
    await client.query('COMMIT');
    return delivered.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function run(): Promise<void> {
  for (;;) {
    if ((await relayOnce()) === 0) await sleep(IDLE_SLEEP_MS); // nothing to send: do not hammer the database
  }
}
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
  harness: {
    python: `import json

SCHEMA = """
CREATE TABLE outbox (
    id text PRIMARY KEY,
    topic text NOT NULL,
    key text NOT NULL,
    payload text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
"""


async def _relay(ctx, *rows):
    """Reset the outbox, seed (id, merchant) rows on the payments topic, load the relay."""
    await ctx.db.reset(SCHEMA)
    for row_id, merchant in rows:
        await _seed(ctx, row_id, merchant)
    return ctx.load("outbox_relay")


async def _seed(ctx, row_id, merchant, topic="payments"):
    payload = json.dumps({"event_id": row_id, "type": "payment.captured", "merchant_id": merchant})
    await ctx.db.execute("INSERT INTO outbox (id, topic, key, payload) VALUES (%s, %s, %s, %s)", (row_id, topic, merchant, payload))


async def _sent(ctx):
    rows = await ctx.db.execute("SELECT id, sent_at FROM outbox ORDER BY id")
    return {row["id"]: row["sent_at"] is not None for row in rows}


async def check_durable_producer(ctx):
    m = await _relay(ctx, ("e1", "m-1"))
    conf = getattr(m.producer, "conf", None)
    assert isinstance(conf, dict), "the module must keep its confluent_kafka Producer as producer"
    acks = str(conf.get("acks", "")).lower()
    assert acks in ("all", "-1"), f"acks is {conf.get('acks')!r}, expected 'all': a leader failover could lose an acknowledged payment"
    idem = conf.get("enable.idempotence")
    assert idem is True or str(idem).lower() == "true", "enable.idempotence must be on so the producer's own retries cannot duplicate an event"
    assert await m.relay_once() == 1, "relay_once must return how many rows it delivered"


async def check_keyed(ctx):
    m = await _relay(ctx, ("e1", "m-1"), ("e2", "m-2"), ("e3", "m-1"))
    await _seed(ctx, "e4", "m-1", topic="refunds")
    assert await m.relay_once() == 4, "relay_once must return how many rows it delivered"
    records = ctx.kafka.records("payments")
    assert len(records) == 3, f"expected 3 records on payments, found {len(records)}"
    by_id = {json.loads(r.value)["event_id"]: r for r in records}
    assert set(by_id) == {"e1", "e2", "e3"}, f"the record value must be the row's payload, got {sorted(by_id)}"
    for event_id, merchant in (("e1", "m-1"), ("e2", "m-2"), ("e3", "m-1")):
        assert by_id[event_id].key == merchant.encode(), f"record {event_id} is keyed {by_id[event_id].key!r}, expected the merchant id {merchant!r}"
    assert by_id["e1"].partition == by_id["e3"].partition, "one merchant's events must share a partition"
    refunds = ctx.kafka.records("refunds")
    assert len(refunds) == 1 and json.loads(refunds[0].value)["event_id"] == "e4", "each row goes to its own topic column"


async def check_ack_before_mark(ctx):
    m = await _relay(ctx, ("e1", "m-1"), ("e2", "m-2"))
    ctx.kafka.fail_next("payments", times=1)  # the first produce is refused by the broker (delivery report error)
    delivered = await m.relay_once()
    sent = await _sent(ctx)
    marked = sorted(i for i, s in sent.items() if s)
    unmarked = sorted(i for i, s in sent.items() if not s)
    assert len(marked) == 1, f"one of two records was acknowledged; rows marked sent: {marked} - only acknowledged rows may be marked, and acknowledged rows must be"
    assert len(unmarked) == 1, f"the record whose delivery failed must stay unsent, rows unsent: {unmarked}"
    assert delivered == 1, f"relay_once returned {delivered}, expected 1 delivered row"
    assert ctx.db.events == ["BEGIN", "COMMIT"], f"select, produce, flush and update belong to one transaction; the database saw {ctx.db.events}"


async def check_mark_delivered(ctx):
    m = await _relay(ctx, ("e1", "m-1"), ("e2", "m-2"), ("e3", "m-3"))
    assert await m.relay_once() == 3
    sent = await _sent(ctx)
    assert all(sent.values()), f"every delivered row must be marked sent_at, got {sent}"
    assert await m.relay_once() == 0, "a second pass must find nothing: sent rows are not re-published"
    assert len(ctx.kafka.records("payments")) == 3, "sent rows were produced again"
    await _seed(ctx, "e4", "m-4")
    ctx.kafka.fail_next("payments", times=1)
    assert await m.relay_once() == 0, "a refused delivery is not a delivered row"
    assert (await _sent(ctx))["e4"] is False, "a row whose delivery failed must stay unsent for the next pass"
    assert await m.relay_once() == 1, "the next pass must pick the unsent row up again"
    assert (await _sent(ctx))["e4"] is True, "the retried row must be marked once delivered"
    assert len(ctx.kafka.records("payments")) == 4


async def check_idle_sleep(ctx):
    m = await _relay(ctx)
    ctx.clock.sleep_limit = 2
    await ctx.drain_async(m.run())
    assert ctx.clock.sleeps >= 2, "run() must sleep between passes over an empty outbox instead of polling in a tight loop"
    assert 0.1 <= ctx.clock.offset <= 10.0, f"two idle sleeps advanced the clock by {ctx.clock.offset:.2f} s; the idle sleep should be brief (IDLE_SLEEP_S)"
    await _seed(ctx, "e1", "m-1")
    ctx.clock.reset(sleep_limit=0)
    await ctx.drain_async(m.run())
    assert (await _sent(ctx))["e1"] is True, "run() must relay a pending row before it sleeps"
    assert len(ctx.kafka.records("payments")) == 1
`,
    typescript: `const SCHEMA = \`
CREATE TABLE outbox (
    id text PRIMARY KEY,
    topic text NOT NULL,
    key text NOT NULL,
    payload text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
\`;

async function seed(ctx, rowId: string, merchant: string, topic = 'payments') {
  const payload = JSON.stringify({event_id: rowId, type: 'payment.captured', merchant_id: merchant});
  await ctx.db.execute('INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)', [rowId, topic, merchant, payload]);
}

/** Reset the outbox, seed (id, merchant) rows on the payments topic, load the relay. */
async function relay(ctx, ...rows: [string, string][]) {
  await ctx.db.reset(SCHEMA);
  for (const [rowId, merchant] of rows) await seed(ctx, rowId, merchant);
  return ctx.load('outbox_relay');
}

/** row id → marked sent? */
async function sent(ctx): Promise<Record<string, boolean>> {
  const rows = await ctx.db.execute('SELECT id, sent_at FROM outbox ORDER BY id');
  return Object.fromEntries(rows.map(row => [row.id, row.sent_at !== null]));
}

export async function check_durable_producer(ctx) {
  const m = await relay(ctx, ['e1', 'm-1']);
  ctx.kafka.loseAcks('payments', 1); // the broker wrote e1 but its acknowledgement never arrived: the producer retries
  assert.equal(await m.relayOnce(), 1, 'relayOnce must return how many rows it delivered');
  let records = ctx.kafka.records('payments');
  assert.equal(records.length, 1, \`after one lost acknowledgement the topic holds \${records.length} records of e1: the producer's own retry duplicated the event — enable the idempotent producer\`);
  await seed(ctx, 'e2', 'm-2');
  assert.equal(await m.relayOnce(), 1);
  ctx.kafka.failover('payments'); // the partition leader dies right after acknowledging e2
  records = ctx.kafka.records('payments');
  assert.equal(records.length, 2, \`a leader failover right after the acknowledgement left \${records.length} record(s) on payments: e2 was acknowledged by the leader alone — produce with acks all\`);
}

export async function check_keyed(ctx) {
  const m = await relay(ctx, ['e1', 'm-1'], ['e2', 'm-2'], ['e3', 'm-1']);
  await seed(ctx, 'e4', 'm-1', 'refunds');
  assert.equal(await m.relayOnce(), 4, 'relayOnce must return how many rows it delivered');
  const records = ctx.kafka.records('payments');
  assert.equal(records.length, 3, \`expected 3 records on payments, found \${records.length}\`);
  const byId = Object.fromEntries(records.map(r => [JSON.parse(String(r.value)).event_id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['e1', 'e2', 'e3'], \`the record value must be the row's payload, got \${JSON.stringify(Object.keys(byId).sort())}\`);
  for (const [eventId, merchant] of [['e1', 'm-1'], ['e2', 'm-2'], ['e3', 'm-1']]) {
    const key = byId[eventId].key === null ? null : String(byId[eventId].key);
    assert.equal(key, merchant, \`record \${eventId} is keyed \${JSON.stringify(key)}, expected the merchant id \${JSON.stringify(merchant)}\`);
  }
  assert.equal(byId.e1.partition, byId.e3.partition, "one merchant's events must share a partition");
  const refunds = ctx.kafka.records('refunds');
  assert(refunds.length === 1 && JSON.parse(String(refunds[0].value)).event_id === 'e4', 'each row goes to its own topic column');
}

export async function check_ack_before_mark(ctx) {
  const m = await relay(ctx, ['e1', 'm-1'], ['e2', 'm-2']);
  ctx.kafka.failNext('payments', 1); // the first produce is refused by the broker (the send rejects)
  const delivered = await m.relayOnce();
  const marks = await sent(ctx);
  const marked = Object.keys(marks).filter(id => marks[id]).sort();
  const unmarked = Object.keys(marks).filter(id => !marks[id]).sort();
  assert.equal(marked.length, 1, \`one of two records was acknowledged; rows marked sent: \${JSON.stringify(marked)} - only acknowledged rows may be marked, and acknowledged rows must be\`);
  assert.equal(unmarked.length, 1, \`the record whose delivery failed must stay unsent, rows unsent: \${JSON.stringify(unmarked)}\`);
  assert.equal(delivered, 1, \`relayOnce returned \${delivered}, expected 1 delivered row\`);
  assert.deepEqual(ctx.db.events, ['BEGIN', 'COMMIT'], \`select, produce, await the acknowledgements and update belong to one transaction; the database saw \${JSON.stringify(ctx.db.events)}\`);
}

export async function check_mark_delivered(ctx) {
  const m = await relay(ctx, ['e1', 'm-1'], ['e2', 'm-2'], ['e3', 'm-3']);
  assert.equal(await m.relayOnce(), 3);
  const marks = await sent(ctx);
  assert(Object.values(marks).every(Boolean), \`every delivered row must be marked sent_at, got \${JSON.stringify(marks)}\`);
  assert.equal(await m.relayOnce(), 0, 'a second pass must find nothing: sent rows are not re-published');
  assert.equal(ctx.kafka.records('payments').length, 3, 'sent rows were produced again');
  await seed(ctx, 'e4', 'm-4');
  ctx.kafka.failNext('payments', 1);
  assert.equal(await m.relayOnce(), 0, 'a refused delivery is not a delivered row');
  assert.equal((await sent(ctx)).e4, false, 'a row whose delivery failed must stay unsent for the next pass');
  assert.equal(await m.relayOnce(), 1, 'the next pass must pick the unsent row up again');
  assert.equal((await sent(ctx)).e4, true, 'the retried row must be marked once delivered');
  assert.equal(ctx.kafka.records('payments').length, 4);
}

export async function check_idle_sleep(ctx) {
  const m = await relay(ctx);
  const start = ctx.clock.now();
  // Resolves once the sleep budget stops the loop; a loop that never sleeps is never stopped, so bound it by its passes.
  let stopped = false;
  let failure: unknown = null;
  const running = ctx.drain(m.run()).then(
    () => (stopped = true),
    e => {
      failure = e;
      stopped = true;
    },
  );
  // A pass in progress is followed through the connection queue; a loop parked in a sleep (no progress across
  // several queued queries) gets a real macrotask so the virtual clock can fire it — a loop that never sleeps
  // would starve the clock otherwise.
  for (let seen = -1, idle = 0; !stopped && ctx.db.events.length < 3000; ) {
    idle = ctx.db.events.length === seen ? idle + 1 : 0;
    seen = ctx.db.events.length;
    if (idle < 5) {
      await ctx.db.execute('SELECT 1');
      continue;
    }
    const turn = Promise.withResolvers<void>();
    setTimeout(turn.resolve, 0);
    await turn.promise;
    idle = 0;
  }
  if (failure !== null) throw failure;
  assert(stopped && ctx.clock.sleeps >= 2, \`run() made \${ctx.db.events.length / 2} passes over an empty outbox without sleeping: sleep between passes instead of polling in a tight loop\`);
  await running;
  const elapsed = (ctx.clock.now() - start) / 1000;
  const perSleep = elapsed / ctx.clock.sleeps;
  assert(0.05 <= perSleep && perSleep <= 5.0, \`\${ctx.clock.sleeps} idle sleeps advanced the clock by \${elapsed.toFixed(1)} s; the idle sleep should be brief (IDLE_SLEEP_MS)\`);
  // A row arrives: a fresh run() must relay it before it ever sleeps (no sleep resolves any more).
  await seed(ctx, 'e1', 'm-1');
  m.run().catch(e => (failure = e));
  for (let i = 0; i < 100 && !(await sent(ctx)).e1 && failure === null; i++) {
    await ctx.db.execute('SELECT 1');
  }
  if (failure !== null) throw failure;
  assert.equal((await sent(ctx)).e1, true, 'run() must relay a pending row before it sleeps');
  assert.equal(ctx.kafka.records('payments').length, 1);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"leetbuild/harness"
)

const relaySchema = \`
CREATE TABLE outbox (
    id text PRIMARY KEY,
    topic text NOT NULL,
    key text NOT NULL,
    payload text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
\`

func seedOutbox(ctx *harness.Ctx, rowID, merchant, topic string) {
	payload, _ := json.Marshal(map[string]any{"event_id": rowID, "type": "payment.captured", "merchant_id": merchant})
	ctx.DB.Exec("INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)", rowID, topic, merchant, string(payload))
}

// resetOutbox empties the outbox and seeds (id, merchant) rows on the payments topic.
func resetOutbox(ctx *harness.Ctx, rows ...[2]string) {
	ctx.DB.Reset(relaySchema)
	for _, row := range rows {
		seedOutbox(ctx, row[0], row[1], "payments")
	}
}

func relayPass(ctx *harness.Ctx) int {
	n, err := relayOnce(context.Background())
	ctx.NoError(err, "relayOnce returned an error")
	return n
}

// sentMarks maps row id → marked sent?
func sentMarks(ctx *harness.Ctx) map[string]bool {
	marks := map[string]bool{}
	for _, row := range ctx.DB.Query("SELECT id, sent_at FROM outbox ORDER BY id") {
		marks[row["id"].(string)] = row["sent_at"] != nil
	}
	return marks
}

func eventIDOf(r harness.KafkaRecord) string {
	var event struct {
		EventID string \`json:"event_id"\`
	}
	_ = json.Unmarshal(r.Value, &event)
	return event.EventID
}

func CheckDurableProducer(ctx *harness.Ctx) {
	resetOutbox(ctx, [2]string{"e1", "m-1"})
	ctx.Kafka.LoseAcks("payments", 1) // the broker wrote e1 but its acknowledgement never arrived: the producer retries
	ctx.Equal(relayPass(ctx), 1, "relayOnce must return how many rows it delivered")
	// kafka-go has no idempotent producer (the check's detail: RequireAll is what it can promise): at least once, identical copies.
	records := ctx.Kafka.Records("payments")
	ctx.Assert(len(records) >= 1, "after one lost acknowledgement the topic holds no record of e1: the retry must deliver it")
	for _, r := range records {
		ctx.Assert(string(r.Key) == string(records[0].Key) && string(r.Value) == string(records[0].Value), "the retry after a lost acknowledgement must resend the same record (same key and value, so the event_id lets the ledger dedupe), got %q / %q and %q / %q", records[0].Key, records[0].Value, r.Key, r.Value)
	}
	seedOutbox(ctx, "e2", "m-2", "payments")
	ctx.Equal(relayPass(ctx), 1, "relayOnce over the new row e2")
	ctx.Kafka.Failover("payments") // the partition leader dies right after acknowledging e2
	distinct := map[string]bool{}
	for _, r := range ctx.Kafka.Records("payments") {
		distinct[string(r.Key)+"|"+string(r.Value)] = true
	}
	ctx.Equal(len(distinct), 2, "a leader failover right after the acknowledgement must leave e1 and e2 on payments (e2 acknowledged by the leader alone is lost: produce with RequiredAcks kafka.RequireAll): distinct records")
}

func CheckKeyed(ctx *harness.Ctx) {
	resetOutbox(ctx, [2]string{"e1", "m-1"}, [2]string{"e2", "m-2"}, [2]string{"e3", "m-1"})
	seedOutbox(ctx, "e4", "m-1", "refunds")
	ctx.Equal(relayPass(ctx), 4, "relayOnce must return how many rows it delivered")
	records := ctx.Kafka.Records("payments")
	ctx.Equal(len(records), 3, "records on payments")
	byID := map[string]harness.KafkaRecord{}
	var ids []string
	for _, r := range records {
		byID[eventIDOf(r)] = r
		ids = append(ids, eventIDOf(r))
	}
	sort.Strings(ids)
	ctx.Equal(ids, []string{"e1", "e2", "e3"}, "the record value must be the row's payload: event ids on payments")
	for _, want := range [][2]string{{"e1", "m-1"}, {"e2", "m-2"}, {"e3", "m-1"}} {
		ctx.Equal(string(byID[want[0]].Key), want[1], "record %s must be keyed by the merchant id", want[0])
	}
	ctx.Equal(byID["e1"].Partition, byID["e3"].Partition, "one merchant's events must share a partition: e1 and e3")
	refunds := ctx.Kafka.Records("refunds")
	ctx.Assert(len(refunds) == 1 && eventIDOf(refunds[0]) == "e4", "each row goes to its own topic column: refunds must hold e4 alone")
}

func CheckAckBeforeMark(ctx *harness.Ctx) {
	resetOutbox(ctx, [2]string{"e1", "m-1"}, [2]string{"e2", "m-2"})
	ctx.Kafka.FailNext("payments", 1) // the first produce is refused by the broker (a kafka.WriteErrors entry)
	delivered := relayPass(ctx)
	var marked, unmarked []string
	for id, sent := range sentMarks(ctx) {
		if sent {
			marked = append(marked, id)
		} else {
			unmarked = append(unmarked, id)
		}
	}
	sort.Strings(marked)
	sort.Strings(unmarked)
	ctx.Equal(len(marked), 1, "one of two records was acknowledged; rows marked sent: %v - only acknowledged rows may be marked, and acknowledged rows must be", marked)
	ctx.Equal(len(unmarked), 1, "the record whose delivery failed must stay unsent, rows unsent: %v", unmarked)
	ctx.Equal(delivered, 1, "relayOnce must return the delivered rows")
	ctx.Equal(ctx.DB.Events(), []string{"BEGIN", "COMMIT"}, "select, produce, wait for the acknowledgements and update belong to one transaction; the database saw")
}

func CheckMarkDelivered(ctx *harness.Ctx) {
	resetOutbox(ctx, [2]string{"e1", "m-1"}, [2]string{"e2", "m-2"}, [2]string{"e3", "m-3"})
	ctx.Equal(relayPass(ctx), 3, "relayOnce over three rows")
	marks := sentMarks(ctx)
	for _, sent := range marks {
		ctx.Assert(sent, "every delivered row must be marked sent_at, got %v", marks)
	}
	ctx.Equal(relayPass(ctx), 0, "a second pass must find nothing: sent rows are not re-published")
	ctx.Equal(len(ctx.Kafka.Records("payments")), 3, "sent rows were produced again: records on payments")
	seedOutbox(ctx, "e4", "m-4", "payments")
	ctx.Kafka.FailNext("payments", 1)
	refused := relayPass(ctx)
	ctx.Equal(refused, 0, "a refused delivery is not a delivered row")
	ctx.Equal(sentMarks(ctx)["e4"], false, "a row whose delivery failed must stay unsent for the next pass")
	ctx.Equal(relayPass(ctx), 1, "the next pass must pick the unsent row up again")
	ctx.Equal(sentMarks(ctx)["e4"], true, "the retried row must be marked once delivered")
	ctx.Equal(len(ctx.Kafka.Records("payments")), 4, "records on payments")
}

// cancelAfterPasses cancels the relay's context once its passes-th transaction (a pass) has committed.
func cancelAfterPasses(ctx *harness.Ctx, passes int, cancel context.CancelFunc) {
	if passes <= 1 {
		ctx.DB.After("COMMIT", cancel)
		return
	}
	ctx.DB.After("COMMIT", func() { cancelAfterPasses(ctx, passes-1, cancel) })
}

func CheckIdleSleep(ctx *harness.Ctx) {
	resetOutbox(ctx)
	start := ctx.Clock.Now()
	// Three passes over an empty outbox, then run's context is cancelled; a loop that never sleeps is caught by its passes.
	idle, stop := context.WithCancel(context.Background())
	cancelAfterPasses(ctx, 3, stop)
	ctx.Drain(func() { run(idle) })
	stop()
	sleeps := ctx.Clock.Sleeps()
	ctx.Assert(sleeps >= 2, "run() made %d passes over an empty outbox without sleeping: sleep between passes instead of polling in a tight loop", len(ctx.DB.Events())/2)
	elapsed := float64(ctx.Clock.Now()-start) / 1000
	perSleep := elapsed / float64(sleeps)
	ctx.Assert(0.05 <= perSleep && perSleep <= 5.0, "%d idle sleeps advanced the clock by %.1f s; the idle sleep should be brief (idleSleep)", sleeps, elapsed)
	// A row arrives: a fresh run() must relay it before it ever sleeps (its context ends with its first pass).
	seedOutbox(ctx, "e1", "m-1", "payments")
	fresh, stopFresh := context.WithCancel(context.Background())
	cancelAfterPasses(ctx, 1, stopFresh)
	sleptBeforePass := -1
	ctx.DB.After("BEGIN", func() { sleptBeforePass = ctx.Clock.Sleeps() - sleeps })
	ctx.Drain(func() { run(fresh) })
	stopFresh()
	ctx.Assert(sentMarks(ctx)["e1"] && sleptBeforePass == 0, "run() must relay a pending row before it sleeps")
	ctx.Equal(len(ctx.Kafka.Records("payments")), 1, "records on payments")
}
`,
  },
  debrief: `The relay is where "durable" is decided: \`acks=all\` plus the idempotent producer make the broker side safe, and marking rows only after the acknowledgement makes the database side honest about what was published. Everything else is throughput: batches of 100, \`SKIP LOCKED\` so relays scale out, an idle sleep so an empty table costs nothing. Production relays add a \`sent_at\` sweeper that deletes old rows, back off on broker errors, and are usually replaced by change data capture once volume grows.`,
};
