import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Audit events keyed by tenant with no decision payload',
  concept: 'kafka',
  file: 'events',
  focus: ['auditd', 'kafka', 'mirror', 'db'],
  task: `## Task

**Starting point.** The starter implements \`publish_appended(tenant, record_id, model_version,
record)\`: it serialises \`{"record_id", "decision": record}\`, produces it to \`audit.appended\`
keyed by model version, then inserts the ledger row, and logs a rejected produce before moving on.
It compiles, serves the demo and hides 5 flaws.

**Failure mode the checks target.** What a topic is allowed to become. An event is a notification
about the ledger, not the ledger; the moment it carries the record, the retained topic is a second
copy of the trail, and when it is keyed by the wrong field, it is a second copy in the wrong order.

Every chain advance publishes one \`audit.appended\` event:

- Keyed by tenant, so every event for one tenant lands on one partition and a mirror sees them in
  chain order.
- A payload of ids and digests only: \`{"record_id", "position", "digest"}\`. A retained, replicated
  topic must not become a copy of tenant content.
- Publish after the append is durable: \`INSERT INTO audit_entries\` first, produce second, and only
  for entries that are already committed.
- An outbox row when the broker rejects the produce: \`INSERT INTO outbox (id, topic, key, payload)\`
  keeps the event for the relay.
- A resync path: \`resync_from_ledger(tenant, from_position)\` re-reads committed entries above a
  position and publishes them again, so a mirror that fell behind can catch up.`,
  sequence: {
    participants: ['Audit Service', 'Postgres', 'audit.appended', 'Mirror consumer'],
    messages: [
      {
        from: 'Audit Service',
        to: 'Postgres',
        label: 'INSERT INTO audit_entries (record_id, position, digest)',
        kind: 'sync',
      },
      {from: 'Postgres', to: 'Audit Service', label: 'committed', kind: 'reply'},
      {
        from: 'Audit Service',
        to: 'audit.appended',
        label: 'produce key = tenant · {record_id, position, digest}',
        kind: 'async',
      },
      {from: 'audit.appended', to: 'Mirror consumer', label: 'consume in per-tenant order', kind: 'async'},
      {from: 'Audit Service', to: 'Postgres', label: 'produce rejected → INSERT INTO outbox', kind: 'sync'},
      {
        from: 'Mirror consumer',
        to: 'Audit Service',
        label: 'behind? resync_from_ledger(tenant, from_position)',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'key-tenant',
      title: 'Events are keyed by tenant',
      detail:
        'The record key is the tenant, so one tenant’s events stay on one partition in chain order. The starter keys by model version, which scatters and reorders history.',
      match: {
        python: {all: [/key=tenant/]},
        typescript: {all: [/key:\s*tenant/]},
        go: {all: [/Key:\s*\[\]byte\(tenant\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic, tenant/]},
        cpp: {all: [/std::string key = tenant/]},
      },
    },
    {
      id: 'ids-only-payload',
      title: 'The payload is ids and digests, never the decision',
      detail:
        'The event carries `record_id`, `position` and `digest` only; the word `decision` appears nowhere in the payload. The starter publishes the full record so mirrors need no read access — a retained topic is the last place that content may live.',
      match: {
        python: {all: [/record_id/, /position/, /digest/], none: [/decision/]},
        typescript: {all: [/record_id/, /position/, /digest/], none: [/decision/]},
        go: {all: [/record_id/, /position/, /digest/], none: [/decision/]},
        scala: {all: [/record_id/, /position/, /digest/], none: [/decision/]},
        cpp: {all: [/record_id/, /position/, /digest/], none: [/decision/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce leaves an outbox row',
      detail:
        'When the broker refuses the event, the row is written to `outbox` for the relay. The starter logs the failure and loses the event.',
      match: {
        python: {all: [/outbox/]},
        typescript: {all: [/outbox/]},
        go: {all: [/outbox/]},
        scala: {all: [/outbox/]},
        cpp: {all: [/outbox/]},
      },
    },
    {
      id: 'after-durable',
      title: 'The produce happens after the append is durable',
      detail:
        '`INSERT INTO audit_entries` comes before the produce call, so nothing is published that the ledger has not committed. The starter produces first and appends after, so a mirror can be ahead of the ledger.',
      match: {
        python: {order: [/INSERT INTO audit_entries/, /produce\(/]},
        typescript: {order: [/INSERT INTO audit_entries/, /producer\.send\(/]},
        go: {order: [/INSERT INTO audit_entries/, /WriteMessages\(/]},
        scala: {order: [/INSERT INTO audit_entries/, /producer\.send\(/]},
        cpp: {order: [/INSERT INTO audit_entries/, /producer->produce\(/]},
      },
    },
    {
      id: 'resync',
      title: 'A mirror can resync from the ledger',
      detail:
        'A resync path re-reads committed entries above a position and republishes them, so a mirror that fell behind is not stuck. The starter has no way back to the ledger.',
      match: {
        python: {all: [/resync/]},
        typescript: {all: [/resync/]},
        go: {all: [/resync/]},
        scala: {all: [/resync/]},
        cpp: {all: [/resync/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

TOPIC = "audit.appended"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_appended(conn, tenant: str, record_id: str, model_version: str, record: dict) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = json.dumps({"record_id": record_id, "decision": record}).encode()
    producer.produce(TOPIC, key=model_version, value=payload)
    producer.flush(5)
    conn.execute(
        "INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES (%s, %s, %s, %s)",
        (record_id, tenant, 0, record_id),
    )
`,
      solution: `import json

from confluent_kafka import Producer

TOPIC = "audit.appended"
OUTBOX = "outbox"

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def append_durable(conn, tenant: str, record_id: str, position: int, digest: str) -> None:
    # Durable first: the event is a notification about the chain, never the source of truth.
    conn.execute(
        "INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES (%s, %s, %s, %s)",
        (record_id, tenant, position, digest),
    )
    conn.commit()


def publish_appended(conn, tenant: str, record_id: str, position: int, digest: str) -> None:
    payload = json.dumps({"record_id": record_id, "position": position, "digest": digest}).encode()
    try:
        # Keyed by tenant: every event for one tenant lands on one partition, in chain order.
        producer.produce(TOPIC, key=tenant, value=payload)
        producer.flush(5)
    except Exception:
        # The broker rejected the produce: keep the row so the relay can publish it later.
        conn.execute(
            "INSERT INTO outbox (id, topic, key, payload) VALUES (%s, %s, %s, %s)",
            (record_id, TOPIC, tenant, payload.decode()),
        )
        raise


def resync_from_ledger(conn, tenant: str, from_position: int) -> int:
    rows = conn.execute(
        "SELECT record_id, position, digest FROM audit_entries"
        " WHERE tenant_id = %s AND position >= %s ORDER BY position",
        (tenant, from_position),
    ).fetchall()
    for record_id, position, digest in rows:
        publish_appended(conn, tenant, record_id, position, digest)
    return len(rows)
`,
    },
    typescript: {
      starter: `/** A publisher that ships the record and keys by version. */
import {Kafka} from 'kafkajs';

const TOPIC = 'audit.appended';

const producer = new Kafka({brokers: ['kafka:9092']}).producer();

type Db = {query: (sql: string, values: unknown[]) => Promise<unknown>};

export async function publishAppended(
  conn: Db,
  tenant: string,
  recordId: string,
  modelVersion: string,
  record: unknown,
): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = JSON.stringify({record_id: recordId, decision: record});
  await producer.send({topic: TOPIC, messages: [{key: modelVersion, value: payload}]});
  await conn.query(
    'INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES ($1, $2, $3, $4)',
    [recordId, tenant, 0, recordId],
  );
}
`,
      solution: `/** One event per chain advance: the tenant as key, ids and digests as payload. */
import {Kafka} from 'kafkajs';

const TOPIC = 'audit.appended';

const producer = new Kafka({brokers: ['kafka:9092']}).producer({idempotent: true, maxInFlightRequests: 1});

type Db = {query: (sql: string, values: unknown[]) => Promise<unknown>};

export async function appendDurable(
  conn: Db,
  tenant: string,
  recordId: string,
  position: number,
  digest: string,
): Promise<void> {
  // Durable first: the event is a notification about the chain, never the source of truth.
  await conn.query(
    'INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES ($1, $2, $3, $4)',
    [recordId, tenant, position, digest],
  );
}

export async function publishAppended(
  conn: Db,
  tenant: string,
  recordId: string,
  position: number,
  digest: string,
): Promise<void> {
  const payload = JSON.stringify({record_id: recordId, position, digest});
  try {
    // Keyed by tenant: every event for one tenant lands on one partition, in chain order.
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: tenant, value: payload}]});
  } catch (error) {
    // The broker rejected the produce: keep the row so the relay can publish it later.
    await conn.query('INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)', [
      recordId,
      TOPIC,
      tenant,
      payload,
    ]);
    throw error;
  }
}

export async function resyncFromLedger(conn: Db, tenant: string, fromPosition: number): Promise<number> {
  const {rows} = (await conn.query(
    'SELECT record_id, position, digest FROM audit_entries WHERE tenant_id = $1 AND position >= $2 ORDER BY position',
    [tenant, fromPosition],
  )) as {rows: {record_id: string; position: number; digest: string}[]};
  for (const row of rows) await publishAppended(conn, tenant, row.record_id, row.position, row.digest);
  return rows.length;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "audit.appended"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}

func publishAppended(ctx context.Context, db *sql.DB, tenant, recordID, modelVersion string, record any) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]any{"record_id": recordID, "decision": record})
	if err := writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(modelVersion), Value: payload}); err != nil {
		return err
	}
	_, err := db.ExecContext(
		ctx,
		"INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES ($1, $2, $3, $4)",
		recordID, tenant, 0, recordID,
	)
	return err
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	topic  = "audit.appended"
	outbox = "outbox"
)

// RequiredAcks all: an acknowledged audit event survives a leader failover.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

func appendDurable(ctx context.Context, db *sql.DB, tenant, recordID string, position int, digest string) error {
	// Durable first: the event is a notification about the chain, never the source of truth.
	_, err := db.ExecContext(
		ctx,
		"INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES ($1, $2, $3, $4)",
		recordID, tenant, position, digest,
	)
	return err
}

func publishAppended(ctx context.Context, db *sql.DB, tenant, recordID string, position int, digest string) error {
	payload, err := json.Marshal(map[string]any{"record_id": recordID, "position": position, "digest": digest})
	if err != nil {
		return err
	}
	// Keyed by tenant: every event for one tenant lands on one partition, in chain order.
	err = writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(tenant), Value: payload})
	if err != nil {
		// The broker rejected the produce: keep the row so the relay can publish it later.
		log.Printf("audit produce rejected record=%s: %v", recordID, err)
		if _, dbErr := db.ExecContext(
			ctx,
			"INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)",
			recordID, topic, tenant, string(payload),
		); dbErr != nil {
			return dbErr
		}
		return err
	}
	return nil
}

func resyncFromLedger(ctx context.Context, db *sql.DB, tenant string, fromPosition int) (int, error) {
	rows, err := db.QueryContext(
		ctx,
		"SELECT record_id, position, digest FROM audit_entries WHERE tenant_id = $1 AND position >= $2 ORDER BY position",
		tenant, fromPosition,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	published := 0
	for rows.Next() {
		var recordID, digest string
		var position int
		if err := rows.Scan(&recordID, &position, &digest); err != nil {
			return published, err
		}
		if err := publishAppended(ctx, db, tenant, recordID, position, digest); err != nil {
			return published, err
		}
		published++
	}
	return published, rows.Err()
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object AuditEvents {
  val Topic = "audit.appended"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def publishAppended(conn: java.sql.Connection, tenant: String, recordId: String, modelVersion: String, record: String): Unit = {
    val payload = s"""{"record_id":"$recordId","decision":$record}"""
    producer.send(new ProducerRecord[String, String](Topic, modelVersion, payload))
    val insert = conn.prepareStatement("INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES (?, ?, ?, ?)")
    insert.setString(1, recordId)
    insert.setString(2, tenant)
    insert.setInt(3, 0)
    insert.setString(4, recordId)
    insert.executeUpdate()
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object AuditEvents {
  val Topic = "audit.appended"
  val Outbox = "outbox"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")
  val producer = new KafkaProducer[String, String](props)

  /** Durable first: the event is a notification about the chain, never the source of truth. */
  def appendDurable(conn: java.sql.Connection, tenant: String, recordId: String, position: Int, digest: String): Unit = {
    val insert = conn.prepareStatement("INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES (?, ?, ?, ?)")
    insert.setString(1, recordId)
    insert.setString(2, tenant)
    insert.setInt(3, position)
    insert.setString(4, digest)
    insert.executeUpdate()
  }

  def publishAppended(conn: java.sql.Connection, tenant: String, recordId: String, position: Int, digest: String): Unit = {
    val payload = s"""{"record_id":"$recordId","position":$position,"digest":"$digest"}"""
    try {
      // Keyed by tenant: every event for one tenant lands on one partition, in chain order.
      producer.send(new ProducerRecord[String, String](Topic, tenant, payload)).get()
    } catch {
      case error: Exception =>
        // The broker rejected the produce: keep the row so the relay can publish it later.
        val insert = conn.prepareStatement("INSERT INTO outbox (id, topic, key, payload) VALUES (?, ?, ?, ?)")
        insert.setString(1, recordId)
        insert.setString(2, Topic)
        insert.setString(3, tenant)
        insert.setString(4, payload)
        insert.executeUpdate()
        throw error
    }
  }

  def resyncFromLedger(conn: java.sql.Connection, tenant: String, fromPosition: Int): Int = {
    val query = conn.prepareStatement(
      "SELECT record_id, position, digest FROM audit_entries WHERE tenant_id = ? AND position >= ? ORDER BY position",
    )
    query.setString(1, tenant)
    query.setInt(2, fromPosition)
    val rows = query.executeQuery()
    var published = 0
    while (rows.next()) {
      publishAppended(conn, tenant, rows.getString("record_id"), rows.getInt("position"), rows.getString("digest"))
      published += 1
    }
    published
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

const std::string kTopic = "audit.appended";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void publish_appended(pqxx::work& tx, const std::string& tenant, const std::string& record_id, const std::string& model_version, const std::string& record) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string payload = nlohmann::json{{"record_id", record_id}, {"decision", record}}.dump();
  const std::string key = model_version;
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  producer->flush(10000);
  tx.exec_params(
      "INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES ($1, $2, $3, $4)",
      record_id, tenant, 0, record_id);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

const std::string kTopic = "audit.appended";
const std::string kOutbox = "outbox";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Durable first: the event is a notification about the chain, never the source of truth.
void append_durable(pqxx::work& tx, const std::string& tenant, const std::string& record_id, int position, const std::string& digest) {
  tx.exec_params(
      "INSERT INTO audit_entries (record_id, tenant_id, position, digest) VALUES ($1, $2, $3, $4)",
      record_id, tenant, position, digest);
}

void publish_appended(pqxx::work& tx, const std::string& tenant, const std::string& record_id, int position, const std::string& digest) {
  const std::string payload = nlohmann::json{{"record_id", record_id}, {"position", position}, {"digest", digest}}.dump();
  // Keyed by tenant: every event for one tenant lands on one partition, in chain order.
  const std::string key = tenant;
  const auto error = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) {
    // The broker rejected the produce: keep the row so the relay can publish it later.
    tx.exec_params("INSERT INTO outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4)", record_id, kTopic, key, payload);
    throw std::runtime_error("audit event rejected");
  }
  producer->flush(10000);
}

int resync_from_ledger(pqxx::work& tx, const std::string& tenant, int from_position) {
  const auto rows = tx.exec_params(
      "SELECT record_id, position, digest FROM audit_entries WHERE tenant_id = $1 AND position >= $2 ORDER BY position",
      tenant, from_position);
  int published = 0;
  for (const auto& row : rows) {
    publish_appended(tx, tenant, row["record_id"].as<std::string>(), row["position"].as<int>(),
                     row["digest"].as<std::string>());
    published++;
  }
  return published;
}
`,
    },
  },
  hints: [
    'The mirror shows position 7 before position 6 for one tenant, holds a full decision record the ledger has not committed, and after a broker outage is missing a day with no way to catch up.',
    'Keying by model version spreads one tenant over partitions; the payload embeds `record`; the produce runs before the `INSERT`; a rejected produce is only logged; nothing re-reads the ledger.',
    'Produce with `key=tenant` and payload `{record_id, position, digest}` after `INSERT INTO audit_entries`; on rejection `INSERT INTO outbox (id, topic, key, payload)`; add `resync_from_ledger(tenant, from_position)`.',
  ],
  debrief: `The fix moves every decision about the topic back to the ledger. The payload shrinks to ids and digests because a retained topic with the decision record in it is a second copy of tenant content, replicated to every consumer that was never meant to see it: the same mistake as storing the prompt, one hop downstream. The produce moves after the insert because a mirror ahead of the source of truth is worse than one behind it; nothing detects it. The tenant key makes a mirror's replay match the chain order, and the outbox plus resync path makes a rejected produce a delay instead of a hole. Production pipelines run a relay that drains the outbox with its own retries, track per-tenant consumer lag, and compact or expire the topic on a schedule the ledger does not share.`,
};
