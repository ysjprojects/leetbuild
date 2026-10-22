import type {Step} from '@/lib/types';

export const changeEventsStep: Step = {
  id: 'events',
  title: 'Change events keyed by table and primary key',
  concept: 'kafka',
  file: 'events',
  focus: ['replicator', 'kafka', 'outbox', 'sink'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it takes the change the
replicator read from the log, digests nothing, json-encodes the row it just read, produces it to
\`cdc.change\` and flushes. It compiles, it delivers the happy path, and it hides three production
flaws. Review it like the owner of the stream, fix it, and prove the fix with the checks below.

Implement the publish path every committed change goes through
(\`publish_change\` / \`publishChange\` / \`publish\`), and return the message key it used.

- The topic is \`cdc.change\`.
- The message key is \`row_key(table, primary_key)\` — the table plus the row's primary key, e.g.
  \`orders:1042\` — so every change of one row lands in one partition, in commit order. A table is
  not a row: keying by table alone serializes nothing about which change of which row came first.
- The payload carries \`before_digest\` and \`after_digest\` — the sha256 of the canonical JSON of
  the before and after row, computed by \`digest(...)\` — plus the change's \`lsn\`. It never carries
  the raw column values.
- The producer is idempotent with acks=all: \`enable.idempotence\` with \`"acks": "all"\`
  (confluent-kafka and kafka-clients), \`idempotent: true\` with \`acks: -1\` in KafkaJS,
  \`RequiredAcks: kafka.RequireAll\` with \`Balancer: &kafka.Hash{}\` in kafka-go, and
  \`enable.idempotence\` with \`set("acks", "all")\` in librdkafka. A resend of the same key cannot
  duplicate a record.
- A produce the broker rejects inserts an outbox row (\`insert_outbox\` / \`insertOutbox\` /
  \`InsertOutbox\`) inside the error branch. A relay republishes it under the same key; the change is
  never dropped.

**Failure mode the checks target.** The draft keys by table only, so concurrent modifications to many
rows of one table interleave and a consumer replaying the partition reorders one row's history — the
last change it applies is not the row's last state. It publishes the raw before and after column
values, so a sink can read the change without a lookup, which turns the retained, replicated topic
into a copy of the tenant's rows. And it ignores the produce result, so a rejected produce loses the
change with no error anyone sees. The fix must prove per-row ordering, payloads without raw values,
and an outbox row on rejection.`,
  sequence: {
    participants: ['Replicator', 'cdc.change', 'Sink consumer', 'outbox'],
    messages: [
      {from: 'Replicator', to: 'Replicator', label: 'digest(before) · digest(after) · lsn', kind: 'sync'},
      {
        from: 'Replicator',
        to: 'cdc.change',
        label: 'produce · key = row_key(table, primary_key) · acks = all',
        kind: 'sync',
      },
      {from: 'cdc.change', to: 'Replicator', label: 'ack / broker rejection', kind: 'reply'},
      {from: 'Replicator', to: 'outbox', label: 'insertOutbox(key, event) in the error branch', kind: 'sync'},
      {
        from: 'cdc.change',
        to: 'Sink consumer',
        label: 'consume · one partition per row, in commit order',
        kind: 'async',
      },
      {
        from: 'Sink consumer',
        to: 'Sink consumer',
        label: 'compare before_digest / after_digest · upsert by primary key',
        kind: 'sync',
      },
      {from: 'Sink consumer', to: 'cdc.change', label: 'commit offset after the sink confirms', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'row-key',
      title: 'Keyed by row_key(table, primary_key) on cdc.change',
      detail:
        "The produce goes to `cdc.change` with `row_key(table, primary_key)` as the message key, so every change of one row lands in one partition in commit order. The draft keys by table, which leaves the row's history to interleave with every other row of that table.",
      match: {
        python: {all: [/cdc\.change/, /def row_key\(/, /primary_key/]},
        typescript: {all: [/cdc\.change/, /function rowKey\(/, /primaryKey/]},
        go: {all: [/cdc\.change/, /func rowKey\(/, /PrimaryKey/]},
        scala: {all: [/cdc\.change/, /def rowKey\(/, /primaryKey/]},
        cpp: {all: [/cdc\.change/, /rowKey\(/, /primary_key/]},
      },
    },
    {
      id: 'before-after-digests',
      title: 'Payload carries before/after digests and the LSN',
      detail:
        "`digest(...)` is the sha256 of the canonical JSON of a row, and the event carries `before_digest`, `after_digest` and the change's `lsn`. The draft ships the rows themselves and no position in the log.",
      match: {
        python: {all: [/def digest\(/, /before_digest/, /after_digest/, /lsn/]},
        typescript: {all: [/function digest\(/, /before_digest/, /after_digest/, /lsn/]},
        go: {all: [/func digest\(/, /beforeDigest/, /afterDigest/, /LSN/]},
        scala: {all: [/def digest\(/, /beforeDigest/, /afterDigest/, /lsn/]},
        cpp: {all: [/digest\(/, /before_digest/, /after_digest/, /lsn/]},
      },
    },
    {
      id: 'no-raw-values',
      title: 'No raw column values in the payload',
      detail:
        "The payload never carries the raw before/after column values — the sink compares digests and re-reads the row when it needs contents. The draft's payload carries exactly that identifier, so every PII fix becomes a data-removal project on a retained, replicated topic.",
      match: {
        python: {none: [/raw_values/]},
        typescript: {none: [/rawValues/]},
        go: {none: [/RawValues/]},
        scala: {none: [/rawValues/]},
        cpp: {none: [/raw_values/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'An outbox row when the broker rejects the produce',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox` / `insertOutbox` / `InsertOutbox`) inside the error branch, so a relay can republish it under the same key. The draft ignores the produce result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except Exception/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /catch\s*\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all and a stable key',
      detail:
        "The producer is configured for idempotence and `acks=all` — `enable.idempotence` with `acks`, KafkaJS's `idempotent: true` with `acks: -1`, kafka-go's `RequireAll` with a hash balancer, librdkafka's `enable.idempotence` with `acks=all`. A resend of a record the broker already accepted must not duplicate it.",
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from pydantic import BaseModel

producer = Producer({"bootstrap.servers": "kafka:9092"})


class Change(BaseModel):
    table: str
    primary_key: str
    op: str
    before: dict
    after: dict
    lsn: str


def publish_change(change: Change) -> str:
    """Publish one committed change to cdc.change and return the message key."""
    # TODO: this draft keys by table alone, so concurrent modifications to many rows of one table
    # interleave and a consumer replays one row's history out of order; it publishes the raw
    # before/after column values and ignores whether the broker accepted the produce.
    event = {
        "table": change.table,
        "primary_key": change.primary_key,
        "op": change.op,
        "raw_values": {"before": change.before, "after": change.after},
        "lsn": change.lsn,
    }
    producer.produce("cdc.change", key=change.table, value=json.dumps(event))
    producer.flush(2.0)
    return change.table
`,
      solution: `import hashlib
import json

from confluent_kafka import Producer
from pydantic import BaseModel

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class Change(BaseModel):
    table: str
    primary_key: str
    op: str
    before: dict
    after: dict
    lsn: str


class OutboxStore:
    async def insert_outbox(self, key: str, event: dict) -> None:
        """One row per change the broker rejected; a relay republishes it under the same key."""
        raise NotImplementedError


outbox = OutboxStore()


def digest(row: dict) -> str:
    """sha256 of the canonical JSON of one row — the sink compares digests, never values."""
    canonical = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def row_key(table: str, primary_key: str) -> str:
    """The message key: table plus primary key, so one row's changes share one partition."""
    return f"{table}:{primary_key}"


async def publish_change(change: Change) -> str:
    """Publish one committed change keyed by (table, primary key); outbox it if rejected."""
    event = {
        "table": change.table,
        "primary_key": change.primary_key,
        "op": change.op,
        "before_digest": digest(change.before),
        "after_digest": digest(change.after),
        "lsn": change.lsn,
    }
    key = row_key(change.table, change.primary_key)
    try:
        producer.produce("cdc.change", key=key, value=json.dumps(event))
        producer.flush(2.0)
    except Exception:
        await outbox.insert_outbox(key, event)
    return key
`,
    },
    typescript: {
      starter: `/** cdc.change: a model-generated draft that keys by table and ships raw column values. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'cdcd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Change {
  table: string;
  primaryKey: string;
  op: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  lsn: string;
}

export async function publishChange(change: Change): Promise<string> {
  // TODO: this draft keys by table alone, so concurrent modifications to many rows of one table
  // interleave and a consumer replays one row's history out of order; it publishes the raw
  // before/after column values and ignores whether the broker accepted the produce.
  const event = {
    table: change.table,
    primary_key: change.primaryKey,
    op: change.op,
    rawValues: {before: change.before, after: change.after},
    lsn: change.lsn,
  };
  await producer.send({
    topic: 'cdc.change',
    messages: [{key: change.table, value: JSON.stringify(event)}],
  });
  return change.table;
}
`,
      solution: `/** cdc.change: keyed by (table, primary key), digests instead of row values, outbox on reject. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {store} from './store';

const kafka = new Kafka({clientId: 'cdcd', brokers: ['kafka:9092']});
// idempotent with one in-flight request: a resend of the same key cannot duplicate a record.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface Change {
  table: string;
  primaryKey: string;
  op: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  lsn: string;
}

function canonical(row: Record<string, unknown>): string {
  /** Stable key order, so the same row always hashes to the same digest. */
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => ({...acc, [key]: row[key]}), {}),
  );
}

function digest(row: Record<string, unknown>): string {
  /** sha256 of the canonical row — the sink compares digests, never column values. */
  return createHash('sha256').update(canonical(row)).digest('hex');
}

function rowKey(table: string, primaryKey: string): string {
  /** One key per row, so its changes share a partition and stay in commit order. */
  return \`\${table}:\${primaryKey}\`;
}

export async function publishChange(change: Change): Promise<string> {
  const event = {
    table: change.table,
    primary_key: change.primaryKey,
    op: change.op,
    before_digest: digest(change.before),
    after_digest: digest(change.after),
    lsn: change.lsn,
  };
  const key = rowKey(change.table, change.primaryKey);
  try {
    await producer.send({
      topic: 'cdc.change',
      acks: -1,
      messages: [{key, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(key, event);
  }
  return key;
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

var changeWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "cdc.change"}

type Change struct {
	Table      string         \`json:"table"\`
	PrimaryKey string         \`json:"primary_key"\`
	Op         string         \`json:"op"\`
	Before     map[string]any \`json:"before"\`
	After      map[string]any \`json:"after"\`
	LSN        string         \`json:"lsn"\`
}

func publishChange(ctx context.Context, change Change) string {
	// TODO: this draft keys by table alone, so concurrent modifications to many rows of one table
	// interleave and a consumer replays one row's history out of order; it publishes the raw
	// before/after column values and ignores whether the broker accepted the produce.
	event := map[string]any{
		"table":       change.Table,
		"primary_key": change.PrimaryKey,
		"op":          change.Op,
		"RawValues":   map[string]any{"before": change.Before, "after": change.After},
		"lsn":         change.LSN,
	}
	payload, _ := json.Marshal(event)
	_ = changeWriter.WriteMessages(ctx, kafka.Message{Key: []byte(change.Table), Value: payload})
	return change.Table
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a resend of the same
// message key lands on the same partition instead of duplicating across them.
var changeWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "cdc.change",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Change struct {
	Table      string         \`json:"table"\`
	PrimaryKey string         \`json:"primary_key"\`
	Op         string         \`json:"op"\`
	Before     map[string]any \`json:"before"\`
	After      map[string]any \`json:"after"\`
	LSN        string         \`json:"lsn"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, key string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func digest(row map[string]any) string {
	// encoding/json writes map keys in sorted order, so the same row always hashes to the same
	// digest while no column value leaves the service.
	encoded, _ := json.Marshal(row)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func rowKey(table, primaryKey string) string {
	// One key per row, so its changes share a partition and stay in commit order.
	return table + ":" + primaryKey
}

func publishChange(ctx context.Context, change Change) string {
	beforeDigest := digest(change.Before)
	afterDigest := digest(change.After)
	event := map[string]any{
		"table":         change.Table,
		"primary_key":   change.PrimaryKey,
		"op":            change.Op,
		"before_digest": beforeDigest,
		"after_digest":  afterDigest,
		"lsn":           change.LSN,
	}
	key := rowKey(change.Table, change.PrimaryKey)
	payload, _ := json.Marshal(event)
	err := changeWriter.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: payload})
	if err != nil {
		_ = store.InsertOutbox(ctx, key, event)
	}
	return key
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Change(
    table: String,
    primaryKey: String,
    op: String,
    before: Map[String, String],
    after: Map[String, String],
    lsn: String
)

object ChangeReplicator {
  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: this draft keys by table alone, so concurrent modifications to many rows of one table
  // interleave and a consumer replays one row's history out of order; it publishes the raw
  // before/after column values and ignores whether the broker accepted the produce.
  def publish(change: Change): String = {
    val payload = JsObject(
      "table" -> JsString(change.table),
      "primary_key" -> JsString(change.primaryKey),
      "op" -> JsString(change.op),
      "rawValues" -> JsObject("before" -> change.before.toJson, "after" -> change.after.toJson),
      "lsn" -> JsString(change.lsn)
    ).compactPrint
    producer.send(new ProducerRecord("cdc.change", change.table, payload))
    change.table
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Change(
    table: String,
    primaryKey: String,
    op: String,
    before: Map[String, String],
    after: Map[String, String],
    lsn: String
)

object ChangeStore {
  /** One row per change the broker rejected; a relay republishes it under the same key. */
  def insertOutbox(key: String, payload: String): Unit = ()
}

object ChangeReplicator {
  // enable.idempotence with acks=all: the broker acknowledges the record once it is replicated and
  // a resend of the same key cannot duplicate it.
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def digest(row: Map[String, String]): String = {
    // Sorted keys and no whitespace, so the same row always hashes to the same digest while no
    // column value leaves the service.
    val canonical = row.toList.sortBy(_._1).map { case (column, value) => s"$column=$value" }.mkString(",")
    MessageDigest
      .getInstance("SHA-256")
      .digest(canonical.getBytes("UTF-8"))
      .map(byte => f"\${byte}%02x")
      .mkString
  }

  def rowKey(table: String, primaryKey: String): String = s"$table:$primaryKey"

  def publish(change: Change): String = {
    val beforeDigest = digest(change.before)
    val afterDigest = digest(change.after)
    val payload = JsObject(
      "table" -> JsString(change.table),
      "primary_key" -> JsString(change.primaryKey),
      "op" -> JsString(change.op),
      "before_digest" -> JsString(beforeDigest),
      "after_digest" -> JsString(afterDigest),
      "lsn" -> JsString(change.lsn)
    ).compactPrint
    val key = rowKey(change.table, change.primaryKey)
    try {
      producer.send(new ProducerRecord("cdc.change", key, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        ChangeStore.insertOutbox(key, payload)
    }
    key
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kChangeTopic = "cdc.change";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::string publish(const std::string& table, const std::string& primaryKey, const std::string& op,
                    const json& before, const json& after, const std::string& lsn) {
  // TODO: this draft keys by table alone, so concurrent modifications to many rows of one table
  // interleave and a consumer replays one row's history out of order; it publishes the raw
  // before/after column values and ignores whether the broker accepted the produce.
  const json event = {
      {"table", table},
      {"primary_key", primaryKey},
      {"op", op},
      {"raw_values", {{"before", before}, {"after", after}}},
      {"lsn", lsn}};
  const auto payload = event.dump();
  producer->produce(kChangeTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), table.data(), table.size(), 0,
                    nullptr);
  producer->flush(2000);
  return table;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <openssl/sha.h>

#include <exception>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kChangeTopic = "cdc.change";

struct OutboxStore {
  /** One row per change the broker rejected; a relay republishes it under the same key. */
  void insertOutbox(const std::string& key, const json& event);
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

std::string digest(const json& row) {
  // nlohmann::json writes object keys in sorted order, so the encoding is canonical and the same
  // row always hashes to the same digest while no column value leaves the service.
  const auto canonical = row.dump();
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), hash);
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.reserve(SHA256_DIGEST_LENGTH * 2);
  for (unsigned char byte : hash) {
    out.push_back(kHex[byte >> 4]);
    out.push_back(kHex[byte & 0x0f]);
  }
  return out;
}

std::string rowKey(const std::string& table, const std::string& primaryKey) {
  // One key per row, so its changes share a partition and stay in commit order.
  return table + ":" + primaryKey;
}

std::string publish(const std::string& table, const std::string& primaryKey, const std::string& op,
                    const json& before, const json& after, const std::string& lsn) {
  const std::string before_digest = digest(before);
  const std::string after_digest = digest(after);
  const json event = {
      {"table", table},
      {"primary_key", primaryKey},
      {"op", op},
      {"before_digest", before_digest},
      {"after_digest", after_digest},
      {"lsn", lsn}};
  const std::string key = rowKey(table, primaryKey);
  const auto payload = event.dump();
  try {
    const auto err = producer->produce(kChangeTopic, RdKafka::Topic::PARTITION_UA,
                                       RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.data()), payload.size(),
                                       key.data(), key.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) {
      store.insertOutbox(key, event);
    }
  } catch (const std::exception& exc) {
    store.insertOutbox(key, event);
  }
  producer->flush(2000);
  return key;
}
`,
    },
  },
  hints: [
    'The message key is the ordering contract, and a table is not a row: the key has to be `row_key(table, primary_key)` — `key=row_key(...)`, `key: rowKey(...)`, `Key: []byte(rowKey(...))`, `ProducerRecord(topic, rowKey(...), payload)`. Two rows of one table are then free to move in parallel while one row is pinned by the hash balancer to the same partition for every change.',
    'The payload is digests plus position, not contents: `digest(row)` is the sha256 of the canonical JSON — sorted keys, no whitespace — so `before_digest` and `after_digest` name a revision while the `lsn` says where it came from. Anything that copies a column value into the topic is the leak the third check looks for; a sink that needs contents re-reads the row.',
    'Idempotence is producer configuration plus a stable key: `enable.idempotence` with `acks=all` (`idempotent: true` with `acks: -1` in KafkaJS, `RequiredAcks: kafka.RequireAll` with `Balancer: &kafka.Hash{}` in kafka-go, `set("acks", "all")` in librdkafka). Then wrap the produce: when the broker rejects it, `insert_outbox(key, event)` and let the relay resend it under the same key — dropping the change or failing the batch silently are the two ways it disappears.',
  ],
  debrief: `The interviewer is testing whether you can review the key and the payload of a generated CDC topic, which is where ordering and privacy in a stream are actually decided. The draft reads fine because the demo changes one row of one table at a time. Three defects are being checked. The message key is the ordering contract: keying by table gives one partition per table but no per-row serialization once the replicator produces concurrently or retries, so a consumer can apply a row's history out of order and settle on a state that never committed — row_key(table, primary_key) is what makes the row's changes a log. The payload is the second one: shipping the raw before and after rows means the retained, replicated topic holds every column of every tenant's table, and the sink gets to skip a lookup it was never entitled to; digests plus the LSN let the sink decide whether it is behind without copying the data. The ignored produce result is the quiet third one every generated snippet has: a broker rejection has to land in the outbox inside the error branch, with the same key, because at-least-once delivery plus an idempotent producer and a stable key is what makes the eventual resend safe. Real pipelines add a schema registry with the digest's canonicalization versioned alongside it, tombstones for deletes, per-table compaction policy, and a relay that drains the outbox in order.`,
};
