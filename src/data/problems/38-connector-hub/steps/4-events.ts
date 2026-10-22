import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Sync events keyed by connector, tokens redacted',
  concept: 'kafka',
  file: 'events',
  focus: ['hub', 'kafka', 'consumer', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: it publishes an event on the happy path and the
consumer moves the cursor, so a sync looks observable. Four production contracts are broken. Find
them, fix them, and prove the fix.

\`publish_event\` is how a sync worker reports one page; the consumer in the same file folds those
events forward.

- Publish **exactly one** \`connector.sync\` event per page and per run with the **connector id as
  the message key** — partitioning by connector keeps one connector's run log in order, which is
  what lets an operator read a sync back. Keyed by vendor, one connector's events scatter across
  partitions and their order is gone.
- The payload carries ids, counts, the cursor position and an error **code**: \`connector_id\`,
  \`cursor\`, \`pages\`, \`records\`, \`error_code\`. It must **never** carry the access token or a
  record's contents, and neither may a log line: the topic is retained for days and replicated, so
  whatever it carries outlives the sync, the connector and the tenant's deletion request.
- The producer must be **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus hashed, stable keys), so a retried produce cannot duplicate a page event.
- When the broker rejects the produce, write the event to the **outbox** (\`store.insert_outbox\`)
  instead of dropping it or failing the worker; a relay republishes outbox rows when the broker
  recovers.
- The consumer **advances the cursor first and commits the offset second**
  (\`set connector:{connector_id}:cursor\` then \`commit\`). Commit first and a crash between the two
  loses the cursor advance forever, so the next run re-fetches and re-applies a page the platform
  believed was committed.

**Failure mode the checks target.** The vendor key is the ordering bug; the unconfigured producer is
the duplication bug; the token and the record sample in the retained topic are a leak with a long
tail; a failed produce silently loses a page; and commit-before-process trades correctness for
exactly-once *looking* code. Only the leak is visible to a security reviewer — the other four are
invisible until a replay, a rebalance or a broker hiccup.`,
  sequence: {
    participants: ['Sync worker', 'connector.sync', 'Sync consumer', 'Redis'],
    messages: [
      {from: 'Sync worker', to: 'connector.sync', label: 'produce · key = connector_id · acks = all', kind: 'sync'},
      {from: 'connector.sync', to: 'Sync worker', label: 'ack / broker error', kind: 'reply'},
      {from: 'Sync worker', to: 'Sync worker', label: 'insert_outbox(connector_id, event) on failure', kind: 'sync'},
      {from: 'connector.sync', to: 'Sync consumer', label: 'consume · group connector-sync', kind: 'async'},
      {from: 'Sync consumer', to: 'Redis', label: 'SET connector:{id}:cursor', kind: 'sync'},
      {from: 'Redis', to: 'Sync consumer', label: 'ok', kind: 'reply'},
      {from: 'Sync consumer', to: 'connector.sync', label: 'commit offset after advancing the cursor', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'publish',
      title: 'Publishes a connector.sync event',
      detail: 'The sync path publishes to the `connector.sync` topic instead of reporting only locally.',
      match: {
        python: {all: [/connector\.sync/]},
        typescript: {all: [/connector\.sync/]},
        go: {all: [/connector\.sync/]},
        scala: {all: [/connector\.sync/]},
        cpp: {all: [/connector\.sync/]},
      },
    },
    {
      id: 'connector-key',
      title: 'Keys the event by connector id',
      detail:
        "The message key is the connector id, so one connector's run log stays in one partition and in order. The draft keys by vendor, so a replay of one connector arrives interleaved with another's.",
      match: {
        python: {all: [/connector\.sync/, /key=connector_id/]},
        typescript: {all: [/connector\.sync/, /key:\s*connectorId/]},
        go: {all: [/connector\.sync/, /Key:\s*\[\]byte\(connectorID\)/]},
        scala: {all: [/connector\.sync/, /"connector\.sync",\s*connectorId/]},
        cpp: {all: [/connector\.sync/, /connectorId\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        "The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS's `idempotent: true`, or required acks `all` with a hash balancer. A retried produce must not duplicate a page event.",
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-secrets',
      title: 'No token or record contents in the event or the logs',
      detail:
        "Neither the payload nor a log line carries the access token or a record's contents. The draft copies both into the retained topic and logs them, so a leak outlives the connector it came from.",
      match: {
        python: {all: [/connector\.sync/], none: [/access_token|payload_sample/]},
        typescript: {all: [/connector\.sync/], none: [/access_token|payload_sample/]},
        go: {all: [/connector\.sync/], none: [/AccessToken|PayloadSample/]},
        scala: {all: [/connector\.sync/], none: [/accessToken|payloadSample/]},
        cpp: {all: [/connector\.sync/], none: [/access_token|payload_sample/]},
      },
    },
    {
      id: 'cursor-before-commit',
      title: 'Advances the cursor before committing the offset',
      detail:
        'The consumer writes `connector:{connector_id}:cursor` before it commits the offset, so a crash between the two replays the event instead of losing the cursor advance. The draft commits first and advances afterwards.',
      match: {
        python: {order: [/connector:/, /consumer\.commit\(/]},
        typescript: {order: [/connector:/, /commitOffsets\(/]},
        go: {order: [/connector:/, /CommitMessages\(/]},
        scala: {order: [/connector:/, /commitSync\(/]},
        cpp: {order: [/connector:/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("connectors")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class PageEvent(BaseModel):
    connector_id: str
    vendor_id: str
    cursor: str
    pages: int
    records: int
    access_token: str
    payload_sample: str


class OutboxStore:
    def insert_outbox(self, connector_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/connectors/sync-events")
def publish_event(body: PageEvent, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: key by the connector id instead of the vendor, configure the idempotent producer with
    # acks=all, keep the token and the record sample out of the event and the logs, write an outbox
    # row when the broker rejects the produce, and advance the cursor before committing the offset.
    logger.info("sync tenant=%s token=%s sample=%r", tenant, body.access_token, body.payload_sample)
    event = {
        "connector_id": body.connector_id,
        "cursor": body.cursor,
        "access_token": body.access_token,
        "payload_sample": body.payload_sample,
    }
    producer.produce("connector.sync", key=body.vendor_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "connector-sync"})
    consumer.subscribe(["connector.sync"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        r.set(f"connector:{event['connector_id']}:cursor", event["cursor"])
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class PageEvent(BaseModel):
    connector_id: str
    cursor: str
    pages: int
    records: int
    error_code: str | None = None


class OutboxStore:
    def insert_outbox(self, connector_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/connectors/sync-events")
def publish_event(body: PageEvent, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    connector_id = body.connector_id
    event = {
        "id": f"{connector_id}:{body.cursor}",
        "connector_id": connector_id,
        "cursor": body.cursor,
        "pages": body.pages,
        "records": body.records,
        "error_code": body.error_code,
    }
    try:
        producer.produce("connector.sync", key=connector_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(connector_id, event)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "connector-sync",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe(["connector.sync"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        r.set(f"connector:{event['connector_id']}:cursor", event["cursor"])
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** publishEvent: a model-generated draft that keys by vendor and commits too early. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'connector-hub', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface PageEvent {
  connector_id: string;
  vendor_id: string;
  cursor: string;
  pages: number;
  records: number;
  access_token: string;
  payload_sample: string;
}

export const store = {
  insertOutbox: async (_connectorId: string, _event: unknown): Promise<void> => undefined,
};

app.post('/v1/connectors/sync-events', async (request, reply) => {
  // TODO: key by the connector id instead of the vendor, configure the idempotent producer with
  // acks=all, keep the token and the record sample out of the event and the logs, write an outbox
  // row when the broker rejects the produce, and advance the cursor before committing the offset.
  const body = request.body as PageEvent;
  request.log.info({connector_id: body.connector_id, sample: body.payload_sample}, 'page synced');
  const event = {
    connector_id: body.connector_id,
    cursor: body.cursor,
    access_token: body.access_token,
    payload_sample: body.payload_sample,
  };
  await producer.send({
    topic: 'connector.sync',
    messages: [{key: body.vendor_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'connector-sync'});
  await consumer.connect();
  await consumer.subscribe({topic: 'connector.sync'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {connector_id: string; cursor: string};
      await r.set(\`connector:\${event.connector_id}:cursor\`, event.cursor);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** publishEvent: one idempotent, connector-keyed event per page; cursor before the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'connector-hub', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

interface PageEvent {
  connector_id: string;
  cursor: string;
  pages: number;
  records: number;
  error_code?: string;
}

app.post('/v1/connectors/sync-events', async (request, reply) => {
  const body = request.body as PageEvent;
  const connectorId = body.connector_id;
  const event = {
    id: \`\${connectorId}:\${body.cursor}\`,
    connector_id: connectorId,
    cursor: body.cursor,
    pages: body.pages,
    records: body.records,
    error_code: body.error_code ?? null,
  };
  try {
    await producer.send({
      topic: 'connector.sync',
      acks: -1,
      messages: [{key: connectorId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(connectorId, event);
  }
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'connector-sync'});
  await consumer.connect();
  await consumer.subscribe({topic: 'connector.sync'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {connector_id: string; cursor: string};
      await r.set(\`connector:\${event.connector_id}:cursor\`, event.cursor);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var syncWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "connector.sync"}

var rdb *redis.Client

type PageEvent struct {
	ConnectorID  string \`json:"connector_id"\`
	VendorID     string \`json:"vendor_id"\`
	Cursor       string \`json:"cursor"\`
	Pages        int    \`json:"pages"\`
	Records      int    \`json:"records"\`
	AccessToken  string \`json:"access_token"\`
	PayloadSample string \`json:"payload_sample"\`
}

func publishEvent(rw http.ResponseWriter, r *http.Request) {
	body := PageEvent{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: key by the connector id instead of the vendor, configure acks=all / idempotence, keep the
	// token and the record sample out of the event and the logs, write an outbox row when the broker
	// rejects the produce, and advance the cursor before committing the offset.
	log.Printf("sync connector=%s token=%s sample=%q", body.ConnectorID, body.AccessToken, body.PayloadSample)
	event := map[string]any{
		"connector_id":   body.ConnectorID,
		"cursor":         body.Cursor,
		"access_token":   body.AccessToken,
		"payload_sample": body.PayloadSample,
	}
	payload, _ := json.Marshal(event)
	_ = syncWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.VendorID), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "connector.sync",
		GroupID: "connector-sync",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			ConnectorID string \`json:"connector_id"\`
			Cursor      string \`json:"cursor"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.Set(ctx, "connector:"+event.ConnectorID+":cursor", event.Cursor, 0)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var syncWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "connector.sync",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var rdb *redis.Client

type PageEvent struct {
	ConnectorID string \`json:"connector_id"\`
	Cursor      string \`json:"cursor"\`
	Pages       int    \`json:"pages"\`
	Records     int    \`json:"records"\`
	ErrorCode   string \`json:"error_code"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, connectorID string, payload []byte) error {
	return nil
}

var store = &OutboxStore{}

func publishEvent(rw http.ResponseWriter, r *http.Request) {
	body := PageEvent{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	connectorID := body.ConnectorID
	event := map[string]any{
		"id":           connectorID + ":" + body.Cursor,
		"connector_id": connectorID,
		"cursor":       body.Cursor,
		"pages":        body.Pages,
		"records":      body.Records,
		"error_code":   body.ErrorCode,
	}
	payload, _ := json.Marshal(event)
	if err := syncWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(connectorID), Value: payload}); err != nil {
		store.InsertOutbox(r.Context(), connectorID, payload)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "connector.sync",
		GroupID: "connector-sync",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			ConnectorID string \`json:"connector_id"\`
			Cursor      string \`json:"cursor"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.Set(ctx, "connector:"+event.ConnectorID+":cursor", event.Cursor, 0)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.Jedis

final case class PageEvent(
    connector_id: String,
    vendor_id: String,
    cursor: String,
    pages: Int,
    records: Int,
    accessToken: String,
    payloadSample: String
)

object SyncEvents {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  val jedis = new Jedis("redis", 6379)

  def publishEvent(body: PageEvent, tenant: String): Unit = {
    // TODO: key by the connector id instead of the vendor, configure idempotence with acks=all,
    // keep the token and the record sample out of the event and the logs, write an outbox row when
    // the broker rejects the produce, and advance the cursor before committing the offset.
    val payload =
      s"""{"connector_id":"\${body.connector_id}","accessToken":"\${body.accessToken}","payloadSample":"\${body.payloadSample}"}"""
    producer.send(new ProducerRecord[String, String]("connector.sync", body.vendor_id, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("connector.sync"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        consumer.commitSync()
        val connectorId = "conn-1"
        jedis.set(s"connector:$connectorId:cursor", record.value())
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.Jedis

final case class PageEvent(
    connector_id: String,
    cursor: String,
    pages: Int,
    records: Int,
    error_code: Option[String]
)

object SyncEvents {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  val jedis = new Jedis("redis", 6379)

  def publishEvent(body: PageEvent, tenant: String): Unit = {
    val connectorId = body.connector_id
    val payload =
      s"""{"id":"$connectorId:\${body.cursor}","connector_id":"$connectorId","cursor":"\${body.cursor}","pages":\${body.pages},"records":\${body.records}}"""
    try {
      producer.send(new ProducerRecord[String, String]("connector.sync", connectorId, payload))
      producer.flush()
    } catch {
      case _: Exception => insertOutbox(connectorId, payload)
    }
  }

  def insertOutbox(connectorId: String, payload: String): Unit = ()

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("connector.sync"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(500))
      records.forEach { record =>
        val connectorId = "conn-1"
        val cursor = "p-43"
        jedis.set(s"connector:$connectorId:cursor", cursor)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct PageEvent {
  std::string connector_id;
  std::string vendor_id;
  std::string cursor;
  int pages;
  int records;
  std::string access_token;
  std::string payload_sample;
};

void publishEvent(RdKafka::Producer* producer, const PageEvent& event) {
  // TODO: key by the connector id instead of the vendor, configure idempotence with acks=all, keep
  // the token and the record sample out of the event and the logs, write an outbox row when the
  // broker rejects the produce, and advance the cursor before committing the offset.
  const auto payload = json{{"connector_id", event.connector_id},
                            {"access_token", event.access_token},
                            {"payload_sample", event.payload_sample}}
                           .dump();
  std::cerr << "sync connector=" << event.connector_id << " token=" << event.access_token << "\\n";
  const auto vendorId = event.vendor_id;
  producer->produce(
      "connector.sync",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.c_str()),
      payload.size(),
      vendorId.c_str(),
      vendorId.size(),
      0,
      nullptr);
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    auto message = consumer->consume(500);
    if (message->err() != RdKafka::ERR_NO_ERROR) {
      delete message;
      continue;
    }
    consumer->commitSync(message);
    const auto event = json::parse(static_cast<RdKafka::Message*>(message)->payload(), nullptr, false);
    const auto connectorId = event.value("connector_id", std::string());
    redis.set("connector:" + connectorId + ":cursor", event.value("cursor", std::string()));
    delete message;
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>

using json = nlohmann::json;

struct PageEvent {
  std::string connector_id;
  std::string cursor;
  int pages;
  int records;
  std::string error_code;
};

void insertOutbox(const std::string& connectorId, const std::string& payload);

RdKafka::Producer* makeProducer() {
  std::string errstr;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return RdKafka::Producer::create(conf.get(), errstr);
}

void publishEvent(RdKafka::Producer* producer, const PageEvent& event) {
  const auto connectorId = event.connector_id;
  const auto payload = json{{"id", connectorId + ":" + event.cursor},
                            {"connector_id", connectorId},
                            {"cursor", event.cursor},
                            {"pages", event.pages},
                            {"records", event.records}}
                           .dump();
  const auto error = producer->produce(
      "connector.sync",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.c_str()),
      payload.size(),
      connectorId.c_str(),
      connectorId.size(),
      0,
      nullptr);
  if (error != RdKafka::ERR_NO_ERROR) insertOutbox(connectorId, payload);
  producer->flush(2000);
}

void consume(RdKafka::KafkaConsumer* consumer, sw::redis::Redis& redis) {
  while (true) {
    auto message = consumer->consume(500);
    if (message->err() != RdKafka::ERR_NO_ERROR) {
      delete message;
      continue;
    }
    const auto event = json::parse(static_cast<RdKafka::Message*>(message)->payload(), nullptr, false);
    const auto connectorId = event.value("connector_id", std::string());
    redis.set("connector:" + connectorId + ":cursor", event.value("cursor", std::string()));
    consumer->commitSync(message);
    delete message;
  }
}
`,
    },
  },
  hints: [
    'The message key is the partition key: `key=connector_id`, `key: connectorId`, `Key: []byte(connectorID)`, `ProducerRecord("connector.sync", connectorId, …)`, `connectorId.c_str()`. Keyed by vendor, one connector\'s pages land in different partitions and the run log an operator reads is interleaved with someone else\'s.',
    "Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS's `idempotent: true`, or required acks `all` with the hash balancer. It needs the same message key on every retry — which is the same fix as the connector key.",
    'The payload is a schema: ids, counts, the cursor and an error *code*. The outbox is the durability half — wrap the produce and insert an outbox row when the broker rejects it. In the consumer write the cursor first and commit second: a crash between them then replays the event instead of losing the cursor advance.',
  ],
  debrief: `The interview question is ordering and durability on a topic you do not own. The partition key decides whether one connector's page events arrive in the order its run log is read in; the vendor id looks like a natural key and is the wrong one. The producer configuration decides whether a client retry duplicates a page event, the payload decides whether a token and a customer record leak into a retained topic (a security finding, not a style nit), and the outbox decides whether a broker hiccup loses a page. In the consumer the order of the cursor write and the offset commit decides whether a rebalance replays a page or loses a cursor advance: write the cursor, then commit. Real pipelines add a schema registry so a future producer cannot smuggle content into the topic, per-connector sequence numbers so late events are ignored, and a lag alarm on the consumer group.`,
};
