import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'log.indexed after the shard commits, keyed by service',
  concept: 'kafka',
  file: 'events',
  focus: ['writer', 'shard', 'kafka'],
  task: `## Task

**Starting point.** The starter's \`index_batch(tenant, service, records)\` mints a batch id, produces a
\`log.indexed\` event \`{batch_id, tenant, service, index, indexed_count}\` keyed by that batch id
(writing \`outbox:log.indexed\` if \`produce\` raises \`KafkaException\`), then writes the batch with
\`shard.bulk_write(index, records)\` (step 3's, provided) and returns the event with the shard's
\`index_snapshot\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** One service's events scatter across partitions and arrive out of
order; an event announces a batch the shard then refuses, under a batch id the shard never saw; the
ledger counts records the shard rejected as indexed; and a produce the broker rejects vanishes.

- The message key is the **service id**.
- \`bulk_write\` runs **first**; a batch it refuses (\`MappingConflict\`, \`ShardWriteFailed\`) is not
  announced, and the event carries the shard's \`batch_id\` and \`index_snapshot\`.
- \`indexed_count\` and \`rejected_count\` are the shard's \`indexed\` and \`rejected\`.
- The broker's answer is the **delivery report** (\`on_delivery\`): a rejected event is RPUSHed to
  \`OUTBOX_KEY\` as \`{"key": service, "payload": <event JSON>}\` and \`index_batch\` returns \`None\`.`,
  sequence: {
    participants: ['Buffered writer', 'Index shard', 'log.indexed', 'Redis outbox'],
    messages: [
      {from: 'Buffered writer', to: 'Index shard', label: 'bulk_write(logs-{tenant}, records)', kind: 'sync'},
      {from: 'Index shard', to: 'Buffered writer', label: 'batch_id · indexed · rejected · snapshot', kind: 'reply'},
      {from: 'Buffered writer', to: 'log.indexed', label: 'produce key=service · the shard counts', kind: 'async'},
      {from: 'log.indexed', to: 'Buffered writer', label: 'delivery report: rejected', kind: 'reply'},
      {from: 'Buffered writer', to: 'Redis outbox', label: 'RPUSH outbox:log.indexed {key, payload}', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'service-key',
      title: 'Keys every event by the service id',
      detail:
        "The message key is the service, so one service's events share a partition and stay in order; keyed by a fresh batch id, they scatter across partitions.",
      match: {
        python: {all: [/key=service\b/]},
        typescript: {all: [/key:\s*service\b/]},
        go: {all: [/Key:\s*\[\]byte\(service\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*service\b/]},
        cpp: {all: [/service\.c_str\(\),\s*service\.size\(\)/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Produces only after the shard took the batch',
      detail:
        '`bulk_write` runs before the produce: when it is called the topic holds nothing for this batch, a refused batch produces nothing, and the event carries the batch id the shard indexed.',
      match: {
        python: {order: [/bulk_write\(/, /producer\.produce\(/]},
        typescript: {order: [/await bulkWrite\(/, /producer\.send\(/]},
        go: {order: [/shard\.BulkWrite\(/, /\.WriteMessages\(/]},
        scala: {order: [/Shard\.bulkWrite\(/, /producer\.send\(/]},
        cpp: {order: [/shard::bulkWrite\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'shard-counts',
      title: "Carries the shard's indexed and rejected counts",
      detail:
        '`indexed_count` and `rejected_count` are what the shard answered; the starter reports every record it sent as indexed, so a shard rejecting a third of a batch still reads as complete.',
      match: {
        python: {all: [/"indexed_count":\s*result\["indexed"\]/, /"rejected_count":\s*result\["rejected"\]/]},
        typescript: {all: [/indexed_count:\s*result\.indexed/, /rejected_count:\s*result\.rejected/]},
        go: {all: [/"indexed_count":\s*result\.Indexed/, /"rejected_count":\s*result\.Rejected/]},
        scala: {
          all: [/"indexed_count" -> JsNumber\(result\.indexed\)/, /"rejected_count" -> JsNumber\(result\.rejected\)/],
        },
        cpp: {all: [/\{"indexed_count", result\.indexed\}/, /\{"rejected_count", result\.rejected\}/]},
      },
    },
    {
      id: 'outbox',
      title: 'Keeps a rejected event in the outbox',
      detail:
        'The delivery report decides: a rejected event is RPUSHed to `outbox:log.indexed` with its key and payload and the call answers no event; the starter never sees the rejection, so the event is gone.',
      match: {
        python: {all: [/on_delivery/, /rpush\(OUTBOX_KEY/], none: [/except\s+KafkaException/]},
        typescript: {all: [/await producer\.send\(/, /rpush\(OUTBOX_KEY/], none: [/\.catch\(/]},
        go: {all: [/err := writer\.WriteMessages\(/, /RPush\(ctx, outboxKey/]},
        scala: {all: [/onCompletion/, /jedis\.rpush\(OutboxKey/]},
        cpp: {all: [/report\.err/, /redis\.rpush\(kOutboxKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import uuid

import redis
from confluent_kafka import KafkaException, Producer

from logindex.shard import bulk_write  # bulk_write(index, records) -> {batch_id, indexed, rejected, index_snapshot}

TOPIC = "log.indexed"
OUTBOX_KEY = "outbox:log.indexed"
PRODUCE_TIMEOUT_S = 2.0

log = logging.getLogger("logindex.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def index_name(tenant: str) -> str:
    return f"logs-{tenant}"


def index_batch(tenant: str, service: str, records: list[dict]) -> dict | None:
    """Write one batch to the tenant's index and announce it on log.indexed; None when the event went to the outbox."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    batch_id = str(uuid.uuid4())
    event = {"batch_id": batch_id, "tenant": tenant, "service": service, "index": index_name(tenant), "indexed_count": len(records)}
    payload = json.dumps(event)
    try:
        producer.produce(TOPIC, key=batch_id, value=payload)
        producer.flush(PRODUCE_TIMEOUT_S)
    except KafkaException as exc:
        r.rpush(OUTBOX_KEY, json.dumps({"key": batch_id, "payload": payload}))
        log.warning("log.indexed %s rejected: %s", batch_id, exc)
        return None
    result = bulk_write(index_name(tenant), records)
    event["index_snapshot"] = result["index_snapshot"]
    return event
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Producer

from logindex.shard import bulk_write  # bulk_write(index, records) -> {batch_id, indexed, rejected, index_snapshot}

TOPIC = "log.indexed"
OUTBOX_KEY = "outbox:log.indexed"
PRODUCE_TIMEOUT_S = 2.0

log = logging.getLogger("logindex.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def index_name(tenant: str) -> str:
    return f"logs-{tenant}"


def index_batch(tenant: str, service: str, records: list[dict]) -> dict | None:
    """Write one batch to the tenant's index and announce it on log.indexed; None when the event went to the outbox."""
    # The shard commits first: a batch it refuses raises here and is never announced.
    result = bulk_write(index_name(tenant), records)
    event = {
        "batch_id": result["batch_id"],
        "tenant": tenant,
        "service": service,
        "index": index_name(tenant),
        "indexed_count": result["indexed"],
        "rejected_count": result["rejected"],
        "index_snapshot": result["index_snapshot"],
    }
    payload = json.dumps(event)
    rejected = []

    def on_delivery(err, msg) -> None:
        if err is not None:
            rejected.append(err)

    producer.produce(TOPIC, key=service, value=payload, on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)  # the delivery report fires here, delivered or rejected
    if rejected:
        r.rpush(OUTBOX_KEY, json.dumps({"key": service, "payload": payload}))
        log.warning("log.indexed %s rejected: %s", result["batch_id"], rejected[0])
        return None
    return event
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';
import {randomUUID} from 'node:crypto';

import type {LogRecord} from 'logindex/buffer';
import {bulkWrite} from 'logindex/shard'; // bulkWrite(index, records) → {batch_id, indexed, rejected, index_snapshot}

export const TOPIC = 'log.indexed';
export const OUTBOX_KEY = 'outbox:log.indexed';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'logindex', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const indexName = (tenant: string): string => \`logs-\${tenant}\`;

/** Write one batch to the tenant's index and announce it on log.indexed; null when the event went to the outbox. */
export async function indexBatch(tenant: string, service: string, records: LogRecord[]): Promise<Record<string, unknown> | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const batchId = randomUUID();
  const event: Record<string, unknown> = {batch_id: batchId, tenant, service, index: indexName(tenant), indexed_count: records.length};
  producer
    .send({topic: TOPIC, messages: [{key: batchId, value: JSON.stringify(event)}], acks: -1})
    .catch(e => console.warn(\`log.indexed \${batchId} not delivered: \${e instanceof Error ? e.message : String(e)}\`));
  const result = await bulkWrite(indexName(tenant), records);
  event.index_snapshot = result.index_snapshot;
  return event;
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import type {LogRecord} from 'logindex/buffer';
import {bulkWrite} from 'logindex/shard'; // bulkWrite(index, records) → {batch_id, indexed, rejected, index_snapshot}

export const TOPIC = 'log.indexed';
export const OUTBOX_KEY = 'outbox:log.indexed';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'logindex', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const indexName = (tenant: string): string => \`logs-\${tenant}\`;

/** Write one batch to the tenant's index and announce it on log.indexed; null when the event went to the outbox. */
export async function indexBatch(tenant: string, service: string, records: LogRecord[]): Promise<Record<string, unknown> | null> {
  // The shard commits first: a batch it refuses throws here and is never announced.
  const result = await bulkWrite(indexName(tenant), records);
  const event = {
    batch_id: result.batch_id,
    tenant,
    service,
    index: indexName(tenant),
    indexed_count: result.indexed,
    rejected_count: result.rejected,
    index_snapshot: result.index_snapshot,
  };
  const payload = JSON.stringify(event);
  try {
    await producer.send({topic: TOPIC, messages: [{key: service, value: payload}], acks: -1});
  } catch (e) {
    // A rejected send is the broker's delivery report: keep the event for the relay.
    await redis.rpush(OUTBOX_KEY, JSON.stringify({key: service, payload}));
    console.warn(\`log.indexed \${result.batch_id} rejected: \${e instanceof Error ? e.message : String(e)}\`);
    return null;
  }
  return event;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"logindex/buffer" // buffer.Record
	"logindex/shard"  // shard.BulkWrite(ctx, index, records) (shard.WriteResult, error)
)

const (
	topic     = "log.indexed"
	outboxKey = "outbox:log.indexed"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

func indexName(tenant string) string { return "logs-" + tenant }

// indexBatch writes one batch to the tenant's index and announces it on log.indexed; nil when the event went to the outbox.
func indexBatch(ctx context.Context, tenant, service string, records []buffer.Record) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	batchID := uuid.NewString()
	event := map[string]any{"batch_id": batchID, "tenant": tenant, "service": service, "index": indexName(tenant), "indexed_count": len(records)}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(batchID), Value: value}); err != nil {
		log.Printf("log.indexed %s not delivered: %v", batchID, err)
	}
	result, err := shard.BulkWrite(ctx, indexName(tenant), records)
	if err != nil {
		return nil, err
	}
	event["index_snapshot"] = result.IndexSnapshot
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"logindex/buffer" // buffer.Record
	"logindex/shard"  // shard.BulkWrite(ctx, index, records) (shard.WriteResult, error)
)

const (
	topic     = "log.indexed"
	outboxKey = "outbox:log.indexed"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

func indexName(tenant string) string { return "logs-" + tenant }

// indexBatch writes one batch to the tenant's index and announces it on log.indexed; nil when the event went to the outbox.
func indexBatch(ctx context.Context, tenant, service string, records []buffer.Record) (map[string]any, error) {
	// The shard commits first: a batch it refuses returns here and is never announced.
	result, err := shard.BulkWrite(ctx, indexName(tenant), records)
	if err != nil {
		return nil, err
	}
	event := map[string]any{
		"batch_id":       result.BatchID,
		"tenant":         tenant,
		"service":        service,
		"index":          indexName(tenant),
		"indexed_count":  result.Indexed,
		"rejected_count": result.Rejected,
		"index_snapshot": result.IndexSnapshot,
	}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(service), Value: value}); err != nil {
		// The returned error is the broker's answer: keep the event for the relay.
		row, _ := json.Marshal(map[string]string{"key": service, "payload": string(value)})
		if err := rdb.RPush(ctx, outboxKey, string(row)).Err(); err != nil {
			return nil, err
		}
		log.Printf("log.indexed %s rejected: %v", result.BatchID, err)
		return nil, nil
	}
	return event, nil
}
`,
    },
    scala: {
      starter: `import java.util.{Properties, UUID}

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import logindex.{Buffer, Shard} // Buffer.Record, Shard.bulkWrite(index, records): Shard.WriteResult

object Events {
  val Topic = "log.indexed"
  val OutboxKey = "outbox:log.indexed"

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def indexName(tenant: String): String = s"logs-$tenant"

  /** Write one batch to the tenant's index and announce it on log.indexed; None when the event went to the outbox. */
  def indexBatch(tenant: String, service: String, records: Seq[Buffer.Record]): Option[JsObject] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val batchId = UUID.randomUUID().toString
    val event = JsObject(
      "batch_id" -> JsString(batchId),
      "tenant" -> JsString(tenant),
      "service" -> JsString(service),
      "index" -> JsString(indexName(tenant)),
      "indexed_count" -> JsNumber(records.size),
    )
    producer.send(
      new ProducerRecord[String, String](Topic, batchId, event.compactPrint),
      new Callback {
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) System.err.println(s"log.indexed $batchId not delivered: \${exception.getMessage}")
      },
    )
    producer.flush()
    val result = Shard.bulkWrite(indexName(tenant), records)
    Some(JsObject(event.fields + ("index_snapshot" -> JsString(result.indexSnapshot))))
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import logindex.{Buffer, Shard} // Buffer.Record, Shard.bulkWrite(index, records): Shard.WriteResult

object Events {
  val Topic = "log.indexed"
  val OutboxKey = "outbox:log.indexed"

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def indexName(tenant: String): String = s"logs-$tenant"

  /** Write one batch to the tenant's index and announce it on log.indexed; None when the event went to the outbox. */
  def indexBatch(tenant: String, service: String, records: Seq[Buffer.Record]): Option[JsObject] = {
    // The shard commits first: a batch it refuses throws here and is never announced.
    val result = Shard.bulkWrite(indexName(tenant), records)
    val event = JsObject(
      "batch_id" -> JsString(result.batchId),
      "tenant" -> JsString(tenant),
      "service" -> JsString(service),
      "index" -> JsString(indexName(tenant)),
      "indexed_count" -> JsNumber(result.indexed),
      "rejected_count" -> JsNumber(result.rejected),
      "index_snapshot" -> JsString(result.indexSnapshot),
    )
    val payload = event.compactPrint
    val rejected = new AtomicBoolean(false)
    producer.send(
      new ProducerRecord[String, String](Topic, service, payload),
      new Callback {
        // The delivery report is the broker's answer: keep a rejected event for the relay.
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) {
            rejected.set(true)
            jedis.rpush(OutboxKey, JsObject("key" -> JsString(service), "payload" -> JsString(payload)).compactPrint)
          }
      },
    )
    producer.flush() // the callback has run once flush returns, delivered or rejected
    if (rejected.get) None else Some(event)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "logindex/buffer.h"  // buffer::Record
#include "logindex/shard.h"   // shard::bulkWrite(index, records) -> shard::WriteResult, shard::newBatchId

using json = nlohmann::json;

const std::string kTopic = "log.indexed";
const std::string kOutboxKey = "outbox:log.indexed";
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "log.indexed not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string indexName(const std::string& tenant) { return "logs-" + tenant; }

// Write one batch to the tenant's index and announce it on log.indexed; nothing when the event went to the outbox.
std::optional<json> indexBatch(const std::string& tenant, const std::string& service, const std::vector<buffer::Record>& records) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string batch_id = shard::newBatchId();
  json event = {{"batch_id", batch_id}, {"tenant", tenant}, {"service", service}, {"index", indexName(tenant)}, {"indexed_count", records.size()}};
  const std::string payload = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(),
                    batch_id.c_str(), batch_id.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);
  const shard::WriteResult result = shard::bulkWrite(indexName(tenant), records);
  event["index_snapshot"] = result.index_snapshot;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "logindex/buffer.h"  // buffer::Record
#include "logindex/shard.h"   // shard::bulkWrite(index, records) -> shard::WriteResult, shard::newBatchId

using json = nlohmann::json;

const std::string kTopic = "log.indexed";
const std::string kOutboxKey = "outbox:log.indexed";
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report of the last produce: what the broker said once flush() served it.
class LastReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;
  std::string errstr;
  void dr_cb(RdKafka::Message& message) override {
    err = message.err();
    errstr = message.errstr();
  }
};

LastReport report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

std::string indexName(const std::string& tenant) { return "logs-" + tenant; }

// Write one batch to the tenant's index and announce it on log.indexed; nothing when the event went to the outbox.
std::optional<json> indexBatch(const std::string& tenant, const std::string& service, const std::vector<buffer::Record>& records) {
  // The shard commits first: a batch it refuses throws here and is never announced.
  const shard::WriteResult result = shard::bulkWrite(indexName(tenant), records);
  const json event = {{"batch_id", result.batch_id},
                      {"tenant", tenant},
                      {"service", service},
                      {"index", indexName(tenant)},
                      {"indexed_count", result.indexed},
                      {"rejected_count", result.rejected},
                      {"index_snapshot", result.index_snapshot}};
  const std::string payload = event.dump();
  report.err = RdKafka::ERR_NO_ERROR;
  const RdKafka::ErrorCode queued = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                                     payload.size(), service.c_str(), service.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);  // the delivery report fires here, delivered or rejected
  if (queued != RdKafka::ERR_NO_ERROR || report.err != RdKafka::ERR_NO_ERROR) {
    redis.rpush(kOutboxKey, json{{"key", service}, {"payload", payload}}.dump());
    std::cerr << "log.indexed " << result.batch_id << " rejected: " << (queued != RdKafka::ERR_NO_ERROR ? RdKafka::err2str(queued) : report.errstr) << "\\n";
    return std::nullopt;
  }
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import log_indexer_pb2
import log_indexer_pb2_grpc

TOPIC = "log.indexed"
OUTBOX = "outbox:log.indexed"
RECORDS = [
    {"service": "checkout", "timestamp": "2026-11-03T10:00:00Z", "level": "error", "message": "m-0"},
    {"service": "checkout", "timestamp": "2026-11-03T10:00:01Z", "level": "info", "message": "m-1"},
    {"service": "checkout", "timestamp": "2026-11-03T10:00:02Z", "level": "trace", "message": "m-2"},
]


class Shard(log_indexer_pb2_grpc.IndexShardServicer):
    """Indexes every batch (a trace record is rejected); conflict refuses every batch. It notes the
    records on log.indexed when each write arrives."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.conflict = ""
        self.on_topic = []
        self.batch_ids = []

    def BulkWrite(self, request, context):
        self.on_topic.append(len(self.ctx.kafka.records(TOPIC)))
        if self.conflict:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, self.conflict)
        self.batch_ids.append(request.batch_id)
        indexed = sum(1 for r in request.records if r.level != "trace")
        return log_indexer_pb2.BulkWriteReply(indexed=indexed, rejected=len(request.records) - indexed, index_snapshot=f"{request.index}@{len(self.batch_ids)}")


def _events(ctx):
    shard = Shard(ctx)
    ctx.grpc.serve(log_indexer_pb2_grpc.add_IndexShardServicer_to_server, shard)
    return ctx.load("events"), shard


def _payloads(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def check_service_key(ctx):
    m, _ = _events(ctx)
    for service in ("checkout", "checkout", "billing", "checkout"):
        assert m.index_batch("acme", service, RECORDS) is not None, f"index_batch(acme, {service}) on a healthy broker must return the event"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four batches produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"checkout", b"checkout", b"billing", b"checkout"], f"records must be keyed by the service, got {keys}"
    partitions = {r.partition for r in records if r.key == b"checkout"}
    assert len(partitions) == 1, f"checkout's events landed on partitions {sorted(partitions)}: one service's events must stay on one partition, in order"


def check_after_commit(ctx):
    m, shard = _events(ctx)
    event = m.index_batch("acme", "checkout", RECORDS)
    assert shard.on_topic == [0], f"when the shard received the batch, {TOPIC} already held {shard.on_topic[0]} record(s): the event announced a batch the shard had not taken"
    assert event is not None and event.get("batch_id") == shard.batch_ids[0], f"the event carries batch id {None if event is None else event.get('batch_id')}, the shard indexed {shard.batch_ids[0]}: announce the batch id the shard saw"
    assert event.get("index_snapshot") == "logs-acme@1", f"the event must carry the shard's index_snapshot, got {event.get('index_snapshot')!r}"
    shard.conflict = "user_id"
    try:
        m.index_batch("acme", "checkout", RECORDS)
    except Exception:
        pass
    else:
        raise AssertionError("with the shard refusing the batch (a mapping conflict) index_batch returned instead of raising")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"a batch the shard refused left {len(ctx.kafka.records(TOPIC)) - 1} event(s) on {TOPIC}: only a committed batch may be announced"


def check_shard_counts(ctx):
    m, _ = _events(ctx)
    m.index_batch("acme", "checkout", RECORDS)
    payload = _payloads(ctx)[0]
    assert payload.get("indexed_count") == 2 and payload.get("rejected_count") == 1, f"the shard indexed 2 of 3 records and rejected 1; the event says indexed_count {payload.get('indexed_count')}, rejected_count {payload.get('rejected_count')}"
    assert payload.get("tenant") == "acme" and payload.get("service") == "checkout" and payload.get("index") == "logs-acme", f"the event must name the tenant, the service and the index: {payload}"
    assert "m-0" not in json.dumps(payload), f"the event carries log text: {payload}"


def check_outbox(ctx):
    m, shard = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    result = m.index_batch("acme", "checkout", RECORDS)
    rows = ctx.redis.lrange(OUTBOX, 0, -1)
    assert len(rows) == 1, f"after the broker rejected the event {OUTBOX} holds {rows}, expected one row with it"
    row = json.loads(rows[0])
    assert row.get("key") == "checkout", f"the outbox row must carry the message key (the service) so the relay publishes it to the same partition: {row}"
    payload = json.loads(row["payload"]) if isinstance(row.get("payload"), str) else row.get("payload")
    assert isinstance(payload, dict) and payload.get("batch_id") == shard.batch_ids[0], f"the outbox row must carry the event for batch {shard.batch_ids[0]}: {row}"
    assert result is None, f"index_batch returned {result} for an event the broker rejected, expected None"
    assert ctx.kafka.records(TOPIC) == [], "a rejected produce cannot be on the topic"
    assert m.index_batch("acme", "billing", RECORDS) is not None, "once the broker answers again the event is delivered"
    assert len(ctx.redis.lrange(OUTBOX, 0, -1)) == 1, "a delivered event leaves no outbox row"
`,
    typescript: `const TOPIC = 'log.indexed';
const OUTBOX = 'outbox:log.indexed';
const RECORDS = [
  {service: 'checkout', timestamp: '2026-11-03T10:00:00Z', level: 'error', message: 'm-0'},
  {service: 'checkout', timestamp: '2026-11-03T10:00:01Z', level: 'info', message: 'm-1'},
  {service: 'checkout', timestamp: '2026-11-03T10:00:02Z', level: 'trace', message: 'm-2'},
];

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** Indexes every batch (a trace record is rejected); conflict refuses every batch; notes the records on the topic at each write. */
function events(ctx) {
  const pkg = ctx.proto('log_indexer.proto');
  const shard = {conflict: '', onTopic: [] as number[], batchIds: [] as string[]};
  ctx.grpc.serve(pkg.logshard.IndexShard.service, {
    BulkWrite(call, callback) {
      shard.onTopic.push(ctx.kafka.records(TOPIC).length);
      if (shard.conflict) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: shard.conflict});
      const {index, batch_id, records} = call.request;
      shard.batchIds.push(batch_id);
      const indexed = records.filter(r => r.level !== 'trace').length;
      callback(null, {indexed, rejected: records.length - indexed, index_snapshot: \`\${index}@\${shard.batchIds.length}\`});
    },
  });
  return {m: ctx.load('events'), shard};
}

async function index(m, service: string) {
  const event = await m.indexBatch('acme', service, RECORDS);
  await settle();
  return event;
}

const payloads = ctx => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

export async function check_service_key(ctx) {
  const {m} = events(ctx);
  for (const service of ['checkout', 'checkout', 'billing', 'checkout']) {
    assert((await index(m, service)) !== null, \`indexBatch(acme, \${service}) on a healthy broker must return the event\`);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four batches produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['checkout', 'checkout', 'billing', 'checkout'], \`records must be keyed by the service, got \${JSON.stringify(keys)}\`);
  const partitions = [...new Set(records.filter(r => r.key?.toString() === 'checkout').map(r => r.partition))];
  assert.equal(partitions.length, 1, \`checkout's events landed on partitions \${JSON.stringify(partitions)}: one service's events must stay on one partition, in order\`);
}

export async function check_after_commit(ctx) {
  const {m, shard} = events(ctx);
  const event = await index(m, 'checkout');
  assert.deepStrictEqual(shard.onTopic, [0], \`when the shard received the batch, \${TOPIC} already held \${shard.onTopic[0]} record(s): the event announced a batch the shard had not taken\`);
  assert(event !== null && event.batch_id === shard.batchIds[0], \`the event carries batch id \${event?.batch_id}, the shard indexed \${shard.batchIds[0]}: announce the batch id the shard saw\`);
  assert.equal(event.index_snapshot, 'logs-acme@1', \`the event must carry the shard's index_snapshot, got \${JSON.stringify(event.index_snapshot)}\`);
  shard.conflict = 'user_id';
  let threw = false;
  try {
    await m.indexBatch('acme', 'checkout', RECORDS);
  } catch {
    threw = true;
  }
  await settle();
  assert(threw, 'with the shard refusing the batch (a mapping conflict) indexBatch returned instead of throwing');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`a batch the shard refused left \${ctx.kafka.records(TOPIC).length - 1} event(s) on \${TOPIC}: only a committed batch may be announced\`);
}

export async function check_shard_counts(ctx) {
  const {m} = events(ctx);
  await index(m, 'checkout');
  const p = payloads(ctx)[0];
  assert(p.indexed_count === 2 && p.rejected_count === 1, \`the shard indexed 2 of 3 records and rejected 1; the event says indexed_count \${p.indexed_count}, rejected_count \${p.rejected_count}\`);
  assert(p.tenant === 'acme' && p.service === 'checkout' && p.index === 'logs-acme', \`the event must name the tenant, the service and the index: \${JSON.stringify(p)}\`);
  assert(!JSON.stringify(p).includes('m-0'), \`the event carries log text: \${JSON.stringify(p)}\`);
}

export async function check_outbox(ctx) {
  const {m, shard} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const result = await index(m, 'checkout');
  const rows = ctx.redis.lrange(OUTBOX, 0, -1);
  assert.equal(rows.length, 1, \`after the broker rejected the event \${OUTBOX} holds \${JSON.stringify(rows)}, expected one row with it\`);
  const row = JSON.parse(rows[0]);
  assert.equal(row.key, 'checkout', \`the outbox row must carry the message key (the service) so the relay publishes it to the same partition: \${rows[0]}\`);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  assert(payload !== null && typeof payload === 'object' && payload.batch_id === shard.batchIds[0], \`the outbox row must carry the event for batch \${shard.batchIds[0]}: \${rows[0]}\`);
  assert.equal(result, null, \`indexBatch returned \${JSON.stringify(result)} for an event the broker rejected, expected null\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a rejected produce cannot be on the topic');
  assert((await index(m, 'billing')) !== null, 'once the broker answers again the event is delivered');
  assert.equal(ctx.redis.lrange(OUTBOX, 0, -1).length, 1, 'a delivered event leaves no outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"logindex/buffer"
	pb "logindex/gen/log_indexer"

	"leetbuild/harness"
)

const (
	eventsTopic  = "log.indexed"
	eventsOutbox = "outbox:log.indexed"
)

var (
	eventsBg      = context.Background()
	eventsRecords = []buffer.Record{
		{Service: "checkout", Timestamp: "2026-11-03T10:00:00Z", Level: "error", Message: "m-0"},
		{Service: "checkout", Timestamp: "2026-11-03T10:00:01Z", Level: "info", Message: "m-1"},
		{Service: "checkout", Timestamp: "2026-11-03T10:00:02Z", Level: "trace", Message: "m-2"},
	}
)

// wireEvent is a log.indexed event as it crosses the topic.
type wireEvent struct {
	BatchID       string \`json:"batch_id"\`
	Tenant        string \`json:"tenant"\`
	Service       string \`json:"service"\`
	Index         string \`json:"index"\`
	IndexedCount  *int   \`json:"indexed_count"\`
	RejectedCount *int   \`json:"rejected_count"\`
	IndexSnapshot string \`json:"index_snapshot"\`
}

// eventShard indexes every batch (a trace record is rejected); conflict refuses every batch. It
// notes the records on log.indexed when each write arrives.
type eventShard struct {
	pb.UnimplementedIndexShardServer
	ctx      *harness.Ctx
	conflict string
	onTopic  []int
	batchIDs []string
}

func (s *eventShard) BulkWrite(_ context.Context, req *pb.BulkWriteRequest) (*pb.BulkWriteReply, error) {
	s.onTopic = append(s.onTopic, len(s.ctx.Kafka.Records(eventsTopic)))
	if s.conflict != "" {
		return nil, status.Error(codes.FailedPrecondition, s.conflict)
	}
	s.batchIDs = append(s.batchIDs, req.GetBatchId())
	indexed := 0
	for _, r := range req.GetRecords() {
		if r.GetLevel() != "trace" {
			indexed++
		}
	}
	return &pb.BulkWriteReply{Indexed: int32(indexed), Rejected: int32(len(req.GetRecords()) - indexed), IndexSnapshot: fmt.Sprintf("%s@%d", req.GetIndex(), len(s.batchIDs))}, nil
}

func eventsWorld(ctx *harness.Ctx) *eventShard {
	peer := &eventShard{ctx: ctx}
	pb.RegisterIndexShardServer(ctx.GRPC.Server(""), peer)
	return peer
}

func decode(raw []byte) wireEvent {
	var e wireEvent
	json.Unmarshal(raw, &e)
	return e
}

func asWire(event map[string]any) wireEvent {
	raw, _ := json.Marshal(event)
	return decode(raw)
}

func mustIndex(ctx *harness.Ctx, service string) map[string]any {
	event, err := indexBatch(eventsBg, "acme", service, eventsRecords)
	ctx.NoError(err, "indexBatch(acme, %s) failed", service)
	ctx.Settle()
	return event
}

func CheckServiceKey(ctx *harness.Ctx) {
	eventsWorld(ctx)
	for _, service := range []string{"checkout", "checkout", "billing", "checkout"} {
		ctx.Assert(mustIndex(ctx, service) != nil, "indexBatch(acme, %s) on a healthy broker must return the event", service)
	}
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 4, "four batches must produce four records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"checkout", "checkout", "billing", "checkout"}, "records must be keyed by the service")
	partitions := map[int]bool{}
	for _, r := range records {
		if string(r.Key) == "checkout" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "one service's events must stay on one partition, in order; the partitions checkout's events landed on")
}

func CheckAfterCommit(ctx *harness.Ctx) {
	peer := eventsWorld(ctx)
	event := asWire(mustIndex(ctx, "checkout"))
	ctx.Equal(peer.onTopic, []int{0}, "when the shard received the batch, %s already held records: the event announced a batch the shard had not taken; the records at the write", eventsTopic)
	ctx.Equal(event.BatchID, peer.batchIDs[0], "announce the batch id the shard saw; the event's batch id")
	ctx.Equal(event.IndexSnapshot, "logs-acme@1", "the event must carry the shard's index_snapshot")
	peer.conflict = "user_id"
	_, err := indexBatch(eventsBg, "acme", "checkout", eventsRecords)
	ctx.Settle()
	ctx.Assert(err != nil, "with the shard refusing the batch (a mapping conflict) indexBatch returned no error")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a batch the shard refused must not be announced; the records on %s", eventsTopic)
}

func CheckShardCounts(ctx *harness.Ctx) {
	eventsWorld(ctx)
	mustIndex(ctx, "checkout")
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one batch, the records on %s", eventsTopic)
	p := decode(records[0].Value)
	ctx.Assert(p.IndexedCount != nil && *p.IndexedCount == 2 && p.RejectedCount != nil && *p.RejectedCount == 1, "the shard indexed 2 of 3 records and rejected 1; the event says %s", records[0].Value)
	ctx.Assert(p.Tenant == "acme" && p.Service == "checkout" && p.Index == "logs-acme", "the event must name the tenant, the service and the index: %s", records[0].Value)
	ctx.Assert(!strings.Contains(string(records[0].Value), "m-0"), "the event carries log text: %s", records[0].Value)
}

func CheckOutbox(ctx *harness.Ctx) {
	peer := eventsWorld(ctx)
	ctx.Kafka.FailNext(eventsTopic, 1)
	result, err := indexBatch(eventsBg, "acme", "checkout", eventsRecords)
	ctx.Settle()
	ctx.NoError(err, "a rejected produce is kept in the outbox, not returned as an error")
	rows := ctx.Redis.LRange(eventsOutbox, 0, -1)
	ctx.Equal(len(rows), 1, "after the broker rejected the event %s must hold one row with it; it holds %v; rows", eventsOutbox, rows)
	var row struct {
		Key     string \`json:"key"\`
		Payload string \`json:"payload"\`
	}
	json.Unmarshal([]byte(rows[0]), &row)
	ctx.Equal(row.Key, "checkout", "the outbox row must carry the message key (the service) so the relay publishes it to the same partition (%s)", rows[0])
	ctx.Equal(decode([]byte(row.Payload)).BatchID, peer.batchIDs[0], "the outbox row must carry the event for the batch the shard indexed (%s)", rows[0])
	ctx.Assert(result == nil, "indexBatch returned %v for an event the broker rejected, expected nil", result)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "a rejected produce cannot be on the topic; the records")
	ctx.Assert(mustIndex(ctx, "billing") != nil, "once the broker answers again the event is delivered")
	ctx.Equal(len(ctx.Redis.LRange(eventsOutbox, 0, -1)), 1, "a delivered event leaves no outbox row; the rows")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "log_indexer.grpc.pb.h"
#include "logindex/buffer.h"

using json = nlohmann::json;

namespace {

const std::string kEventsTopic = "log.indexed";
const std::string kEventsOutbox = "outbox:log.indexed";
const std::vector<buffer::Record> kEventsRecords = {
    {"checkout", "2026-11-03T10:00:00Z", "error", "m-0"},
    {"checkout", "2026-11-03T10:00:01Z", "info", "m-1"},
    {"checkout", "2026-11-03T10:00:02Z", "trace", "m-2"},
};

// Indexes every batch (a trace record is rejected); conflict refuses every batch. It notes the
// records on log.indexed when each write arrives.
class EventShard final : public logshard::IndexShard::Service {
 public:
  harness::Ctx* ctx = nullptr;
  std::string conflict;
  std::vector<int> onTopic;
  std::vector<std::string> batchIds;

  grpc::Status BulkWrite(grpc::ServerContext*, const logshard::BulkWriteRequest* req, logshard::BulkWriteReply* out) override {
    onTopic.push_back(static_cast<int>(ctx->Kafka.Records(kEventsTopic).size()));
    if (!conflict.empty()) return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, conflict);
    batchIds.push_back(req->batch_id());
    int indexed = 0;
    for (const auto& r : req->records()) indexed += r.level() != "trace";
    out->set_indexed(indexed);
    out->set_rejected(req->records_size() - indexed);
    out->set_index_snapshot(req->index() + "@" + std::to_string(batchIds.size()));
    return grpc::Status::OK;
  }
};

EventShard& eventsWorld(harness::Ctx& ctx) {
  static EventShard* peer = nullptr;
  delete peer;
  peer = new EventShard;
  peer->ctx = &ctx;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

json parsed(const std::string& text) {
  const auto j = json::parse(text, nullptr, false);
  return j.is_discarded() ? json::object() : j;
}

std::optional<json> mustIndex(harness::Ctx& ctx, const std::string& service) {
  std::optional<json> event;
  try {
    event = indexBatch("acme", service, kEventsRecords);
  } catch (const std::exception& e) {
    ctx.Fatalf("indexBatch(acme, %s) threw %s: %s", service, harness::CurrentExceptionType(), e.what());
  }
  ctx.Settle();
  return event;
}

}  // namespace

void CheckServiceKey(harness::Ctx& ctx) {
  eventsWorld(ctx);
  for (const std::string service : {"checkout", "checkout", "billing", "checkout"}) {
    ctx.Assert(mustIndex(ctx, service).has_value(), "indexBatch(acme, %s) on a healthy broker must return the event", service);
  }
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 4, "four batches must produce four records on %s; the records", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"checkout", "checkout", "billing", "checkout"}, "records must be keyed by the service");
  std::set<int> partitions;
  for (const auto& r : records) {
    if (r.Key.value_or("") == "checkout") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "one service's events must stay on one partition, in order; the partitions checkout's events landed on");
}

void CheckAfterCommit(harness::Ctx& ctx) {
  EventShard& peer = eventsWorld(ctx);
  const auto event = mustIndex(ctx, "checkout");
  ctx.Equal(peer.onTopic, {0}, "when the shard received the batch, %s already held records: the event announced a batch the shard had not taken; the records at the write", kEventsTopic);
  ctx.Assert(event.has_value(), "indexBatch on a healthy broker must return the event");
  ctx.Equal(event->value("batch_id", ""), peer.batchIds.at(0), "announce the batch id the shard saw; the event's batch id");
  ctx.Equal(event->value("index_snapshot", ""), "logs-acme@1", "the event must carry the shard's index_snapshot");
  peer.conflict = "user_id";
  bool threw = false;
  try {
    indexBatch("acme", "checkout", kEventsRecords);
  } catch (const std::exception&) {
    threw = true;
  }
  ctx.Settle();
  ctx.Assert(threw, "with the shard refusing the batch (a mapping conflict) indexBatch returned instead of throwing");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "a batch the shard refused must not be announced; the records on %s", kEventsTopic);
}

void CheckShardCounts(harness::Ctx& ctx) {
  eventsWorld(ctx);
  mustIndex(ctx, "checkout");
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one batch, the records on %s", kEventsTopic);
  const std::string text = records[0].Value.value_or("");
  const json p = parsed(text);
  ctx.Assert(p.value("indexed_count", -1) == 2 && p.value("rejected_count", -1) == 1, "the shard indexed 2 of 3 records and rejected 1; the event says %s", text);
  ctx.Assert(p.value("tenant", "") == "acme" && p.value("service", "") == "checkout" && p.value("index", "") == "logs-acme", "the event must name the tenant, the service and the index: %s", text);
  ctx.Assert(text.find("m-0") == std::string::npos, "the event carries log text: %s", text);
}

void CheckOutbox(harness::Ctx& ctx) {
  EventShard& peer = eventsWorld(ctx);
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const auto result = mustIndex(ctx, "checkout");
  const auto rows = ctx.Redis.LRange(kEventsOutbox, 0, -1);
  ctx.Equal(rows.size(), 1, "after the broker rejected the event %s must hold one row with it; it holds %v; rows", kEventsOutbox, rows);
  const json row = parsed(rows[0]);
  ctx.Equal(row.value("key", ""), "checkout", "the outbox row must carry the message key (the service) so the relay publishes it to the same partition (%s)", rows[0]);
  json payload;
  if (row.contains("payload")) payload = row["payload"].is_string() ? parsed(row["payload"].get<std::string>()) : row["payload"];
  ctx.Assert(payload.is_object() && payload.value("batch_id", "") == peer.batchIds.at(0), "the outbox row must carry the event for the batch the shard indexed: %s", rows[0]);
  ctx.Assert(!result.has_value(), "indexBatch returned %s for an event the broker rejected, expected nothing", result ? result->dump() : "");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "a rejected produce cannot be on the topic; the records");
  ctx.Assert(mustIndex(ctx, "billing").has_value(), "once the broker answers again the event is delivered");
  ctx.Equal(ctx.Redis.LRange(kEventsOutbox, 0, -1).size(), 1, "a delivered event leaves no outbox row; the rows");
}
`,
  },
  hints: [
    "Index three batches for checkout and read the topic: their events sit on different partitions. Refuse a batch at the shard: its event is already out. Reject the produce: nothing is kept, and the ledger's count includes the shard's rejects.",
    'The key is a batch id minted before the write, so it differs per event and is not the id the shard indexes; the produce runs before `bulk_write`; `indexed_count` is `len(records)`; and `except KafkaException` never sees a delivery failure, which arrives in a callback.',
    'Call `bulk_write` first and build the event from its result (`batch_id`, `indexed`, `rejected`, `index_snapshot`); produce with `key=service` and an `on_delivery` that records the error; after `flush`, on an error RPUSH `{"key", "payload"}` to `OUTBOX_KEY` and return `None`.',
  ],
  debrief: `The event is a claim about the shard, so it is built from the shard's answer: the batch id it indexed, the counts it reported, the snapshot it returned, and only once it returned. Keying by service keeps one service's events on one partition, which is what lets the ledger apply them in order. The outbox row has the delivery report's shape because \`produce\` only queues: the broker's answer arrives in the callback that \`flush\` serves, and an exception handler around \`produce\` catches only a full local queue. A production writer would add a relay that drains the outbox with the same key, and a consumer that deduplicates by batch id, since an outboxed event can reach the topic twice.`,
};
