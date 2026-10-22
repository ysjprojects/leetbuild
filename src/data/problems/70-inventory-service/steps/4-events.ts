import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Stock events keyed by sku for inventory ledgers',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'ledger', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: every reservation change publishes a movement, the
topic and the flush are there, and the demo's ledger fills up. Four production contracts are broken.
Find them, fix them, and prove the fix.

Reserve, confirm and release each publish one event to \`inventory.event\`, and the ledger consumer
rebuilds per-sku availability from that stream.

- The **record key is the sku** (\`key=sku\`, \`key: sku\`, \`Key: []byte(sku)\`,
  \`ProducerRecord(topic, sku, …)\`), so one sku's movements land in one partition and stay ordered.
  The draft keys by the order id, so one sku's movements interleave across orders and a consumer
  folding deltas can apply them out of order.
- The payload carries \`{event_id, sku, delta, reservation_id, reason, available}\` with \`reason\`
  in \`reserved\` / \`confirmed\` / \`released\`: the signed delta and the reservation id travel
  together, so a rebuild can attribute every movement to the reservation that caused it.
- The producer is **durable**: \`acks=all\` (\`acks: -1\`, \`RequireAll\`) plus idempotence where the
  stack has it (\`enable.idempotence\`, \`idempotent: true\`, or the \`kafka.Hash\` balancer for
  kafka-go). An ack must mean the record is replicated, and a retried produce must not duplicate a
  movement.
- On the **release path** the Redis hold is cleared **first** and the \`released\` event is produced
  **after** it. The draft produces first, so a consumer can see a release for stock the store still
  holds.
- When the broker rejects the produce — an exception, an error code, a flush that leaves the record
  pending — insert the event into an **outbox** store declared in the file (an in-memory stub is
  fine), inside the same commit as the state change. A broker outage must leave the ledger
  rebuildable, never silently short.

**Failure mode the checks target.** An order-keyed stream loses per-sku order the moment two orders
touch the same sku, and the consumer's per-sku state folds deltas in the wrong order. Publishing the
release before the hold clears opens a window where the store shows stock released while the hold
still blocks it. A default producer acknowledges before replication and can duplicate on retry, and a
failed produce with no outbox is a movement that only ever existed in the writer's memory — the
ledger drifts from the counter it is supposed to explain.`,
  sequence: {
    participants: ['Inventory API', 'Redis holds', 'inventory.event', 'outbox'],
    messages: [
      {from: 'Inventory API', to: 'Redis holds', label: 'INCRBY stock:{sku} · DEL hold:{reservation_id}', kind: 'sync'},
      {from: 'Redis holds', to: 'Inventory API', label: 'hold cleared', kind: 'reply'},
      {from: 'Inventory API', to: 'inventory.event', label: 'produce · key = sku · acks = all', kind: 'async'},
      {from: 'inventory.event', to: 'Inventory API', label: 'ack / broker error', kind: 'reply'},
      {from: 'Inventory API', to: 'outbox', label: 'INSERT INTO outbox on failure', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'sku-key',
      title: 'The record key is the sku',
      detail:
        'The Kafka record key is the sku (`key=sku` / `key: sku` / `Key: []byte(sku)`), so one sku’s movements land in one partition and stay ordered. The draft keys by the order id, so one sku’s movements interleave across orders.',
      match: {
        python: {all: [/producer\.produce\([^)]*key=sku/]},
        typescript: {all: [/key:\s*sku\b/]},
        go: {all: [/Key:\s*\[\]byte\(sku\)/]},
        scala: {all: [/ProducerRecord(\[[^\]]*\])?\(\s*InventoryTopic,\s*sku\b/]},
        cpp: {all: [/sku\.data\(\),\s*sku\.size\(\)/]},
      },
    },
    {
      id: 'event-fields',
      title: 'The event carries delta, reservation_id and reason',
      detail:
        'Each event payload carries the signed `delta`, the `reservation_id` and a `reason` in reserved / confirmed / released. The draft ships a quantity and an order id instead, so a consumer cannot attribute a movement to the reservation that caused it.',
      match: {
        python: {all: [/["']delta["']\s*:/, /["']reservation_id["']\s*:/, /["']reason["']\s*:/]},
        typescript: {all: [/\bdelta\b/, /\breservation_id\b/, /\breason\b/]},
        go: {all: [/\bDelta\b/, /ReservationID/, /\bReason\b/]},
        scala: {all: [/\bdelta\b/, /reservation_id|reservationId/, /\breason\b/]},
        cpp: {all: [/\bdelta\b/, /reservation_id|reservationId/, /\breason\b/]},
      },
    },
    {
      id: 'publish-after-hold',
      title: 'Release clears the hold before publishing',
      detail:
        'On the release path the Redis hold is deleted first and the `released` event is produced after it, so no consumer can observe a release for stock the store still holds. The draft produces first.',
      match: {
        python: {order: [/\.delete\(/, /publish_event\(/]},
        typescript: {order: [/\.del\(/, /publishEvent\(/]},
        go: {order: [/\.Del\(/, /publishEvent\(/]},
        scala: {order: [/\.del\(/, /publishEvent\(/]},
        cpp: {order: [/->del\(/, /publishEvent\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce falls back to the outbox',
      detail:
        'When the produce fails — exception, error code or a flush that leaves the record pending — the event is inserted into the outbox store declared in the file, so a relay can republish it after the broker recovers. The draft has no outbox: an outage truncates the ledger.',
      match: {
        python: {all: [/class OutboxStore/, /insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/class OutboxStore/, /insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/type OutboxStore struct/, /InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/object OutboxStore/, /insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/struct OutboxStore/, /insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'Durable producer on inventory.event',
      detail:
        'The publisher targets `inventory.event` with required acks `all` (`acks: -1`, `RequireAll`) and idempotence where the stack provides it, so an ack means the record is replicated and a retry cannot duplicate a movement. The draft leaves the producer on defaults.',
      match: {
        python: {all: [/inventory\.event/, /enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/inventory\.event/, /idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/inventory\.event/, /RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/inventory\.event/, /enable\.idempotence/, /["']acks["'],\s*["']all["']/]},
        cpp: {all: [/inventory\.event/, /enable\.idempotence/, /set\(["']acks["'],\s*["']all["']/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
from uuid import uuid4

import redis
from confluent_kafka import Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

INVENTORY_TOPIC = "inventory.event"

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class ReleaseRequest(BaseModel):
    order_id: str
    sku: str
    quantity: int


# TODO: key the record by the sku instead of the order id, carry the delta and the reservation id
# with the reason, configure the producer for durability (enable.idempotence + acks=all), clear the
# Redis hold before publishing the release, and insert an outbox row when the broker rejects the
# produce.
def publish_event(order_id: str, sku: str, quantity: int, reason: str) -> None:
    event = {
        "event_id": str(uuid4()),
        "sku": sku,
        "order_id": order_id,
        "quantity": quantity,
        "reason": reason,
    }
    producer.produce(INVENTORY_TOPIC, key=order_id, value=json.dumps(event))
    producer.flush()


def release(body: ReleaseRequest) -> None:
    publish_event(body.order_id, body.sku, body.quantity, "released")
    r.delete(f"hold:{body.order_id}")
`,
      solution: `import json
from uuid import uuid4

import redis
from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

INVENTORY_TOPIC = "inventory.event"

# acks=all makes the broker acknowledge only after the record is replicated; idempotence gives the
# producer a sequence number per partition, so a retried produce cannot duplicate a movement.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class ReleaseRequest(BaseModel):
    reservation_id: str
    sku: str
    quantity: int


class OutboxStore:
    """The outbox table: one row per movement the broker did not accept."""

    def insert_outbox(self, event: dict) -> None:
        """INSERT INTO outbox (event_id, payload) VALUES (?, ?); a relay republishes the row."""
        raise NotImplementedError


store = OutboxStore()


def publish_event(sku: str, delta: int, reservation_id: str, reason: str, available: int) -> None:
    event = {
        "event_id": str(uuid4()),
        "sku": sku,
        "delta": delta,
        "reservation_id": reservation_id,
        "reason": reason,
        "available": available,
    }
    try:
        producer.produce(INVENTORY_TOPIC, key=sku, value=json.dumps(event))
    except KafkaException:
        store.insert_outbox(event)
        return
    if producer.flush(2.0):
        store.insert_outbox(event)


def release(body: ReleaseRequest) -> None:
    available = int(r.incrby(f"stock:{body.sku}", body.quantity))
    r.delete(f"hold:{body.reservation_id}")
    publish_event(body.sku, body.quantity, body.reservation_id, "released", available)
`,
    },
    typescript: {
      starter: `/** inventory.event: a model-generated first draft keyed by the order id. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();

export const inventoryTopic = 'inventory.event';

const kafka = new Kafka({clientId: 'inventoryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface ReleaseBody {
  order_id: string;
  sku: string;
  quantity: number;
}

// TODO: key the record by the sku instead of the order id, carry delta and reservation_id with the
// reason, configure the producer for durability (idempotent: true with acks: -1), clear the Redis
// hold before publishing the release, and fall back to the outbox when the broker rejects it.
async function publishEvent(orderId: string, sku: string, quantity: number, reason: string): Promise<void> {
  const event = {event_id: randomUUID(), sku, order_id: orderId, quantity, reason};
  await producer.send({
    topic: inventoryTopic,
    messages: [{key: orderId, value: JSON.stringify(event)}],
  });
}

export async function release(body: ReleaseBody): Promise<void> {
  await publishEvent(body.order_id, body.sku, body.quantity, 'released');
  await r.del(\`hold:\${body.order_id}\`);
}
`,
      solution: `/** inventory.event: every movement keyed by sku, durable producer, outbox on failure. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {Kafka} from 'kafkajs';

export const app = Fastify();

export const inventoryTopic = 'inventory.event';

const kafka = new Kafka({clientId: 'inventoryd', brokers: ['kafka:9092']});
// idempotent: true gives each producer session a sequence number per partition, so a retried record
// cannot be duplicated; acks: -1 travels with every record and waits for the in-sync replicas.
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

type Reason = 'reserved' | 'confirmed' | 'released';

interface StockEvent {
  event_id: string;
  sku: string;
  delta: number;
  reservation_id: string;
  reason: Reason;
  available: number;
}

interface ReleaseBody {
  reservation_id: string;
  sku: string;
  quantity: number;
}

/** The outbox table: one row per movement the broker did not accept. */
export class OutboxStore {
  private readonly rows: StockEvent[] = [];

  async insertOutbox(event: StockEvent): Promise<void> {
    this.rows.push(event);
  }
}

export const store = new OutboxStore();

async function publishEvent(sku: string, delta: number, reservation_id: string, reason: Reason, available: number): Promise<void> {
  const event: StockEvent = {event_id: randomUUID(), sku, delta, reservation_id, reason, available};
  try {
    await producer.send({
      topic: inventoryTopic,
      acks: -1,
      messages: [{key: sku, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(event);
  }
}

export async function release(body: ReleaseBody): Promise<void> {
  const available = await r.incrby(\`stock:\${body.sku}\`, body.quantity);
  await r.del(\`hold:\${body.reservation_id}\`);
  await publishEvent(body.sku, body.quantity, body.reservation_id, 'released', available);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const inventoryTopic = "inventory.event"

var inventoryWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: inventoryTopic}

var rdb *redis.Client

type ReleaseBody struct {
	OrderID  string \`json:"order_id"\`
	Sku      string \`json:"sku"\`
	Quantity int    \`json:"quantity"\`
}

// TODO: key the record by the sku instead of the order id, carry Delta and ReservationID with the
// reason, configure the writer with RequiredAcks: kafka.RequireAll and &kafka.Hash{}, clear the
// Redis hold before publishing the release, and insert an outbox row when the produce fails.
func publishEvent(ctx context.Context, orderID string, sku string, quantity int, reason string) error {
	event := map[string]any{
		"event_id": uuid.NewString(),
		"sku":      sku,
		"order_id": orderID,
		"quantity": quantity,
		"reason":   reason,
	}
	payload, _ := json.Marshal(event)
	return inventoryWriter.WriteMessages(ctx, kafka.Message{Key: []byte(orderID), Value: payload})
}

func release(ctx context.Context, body ReleaseBody) error {
	if err := publishEvent(ctx, body.OrderID, body.Sku, body.Quantity, "released"); err != nil {
		return err
	}
	return rdb.Del(ctx, "hold:"+body.OrderID).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const inventoryTopic = "inventory.event"

// RequiredAcks=RequireAll waits for the in-sync replicas, and the hash balancer keeps every movement
// of one sku in one partition: together they are kafka-go's durable, ordered producer.
var inventoryWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        inventoryTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var rdb *redis.Client

type StockEvent struct {
	EventID       string \`json:"event_id"\`
	Sku           string \`json:"sku"\`
	Delta         int    \`json:"delta"\`
	ReservationID string \`json:"reservation_id"\`
	Reason        string \`json:"reason"\`
	Available     int    \`json:"available"\`
}

type OutboxStore struct{}

// InsertOutbox writes one row per movement the broker did not accept; a relay republishes it.
func (s *OutboxStore) InsertOutbox(ctx context.Context, event StockEvent) error {
	return nil
}

var store = &OutboxStore{}

func publishEvent(ctx context.Context, sku string, delta int, reservationID string, reason string, available int) error {
	event := StockEvent{EventID: uuid.NewString(), Sku: sku, Delta: delta, ReservationID: reservationID, Reason: reason, Available: available}
	payload, _ := json.Marshal(event)
	if err := inventoryWriter.WriteMessages(ctx, kafka.Message{Key: []byte(sku), Value: payload}); err != nil {
		return store.InsertOutbox(ctx, event)
	}
	return nil
}

func release(ctx context.Context, reservationID string, sku string, quantity int) error {
	available, err := rdb.IncrBy(ctx, "stock:"+sku, int64(quantity)).Result()
	if err != nil {
		return err
	}
	if err := rdb.Del(ctx, "hold:"+reservationID).Err(); err != nil {
		return err
	}
	return publishEvent(ctx, sku, quantity, reservationID, "released", int(available))
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.UUID

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object InventoryPublisher {
  val InventoryTopic = "inventory.event"
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key the record by the sku instead of the order id, carry delta + reservation_id + reason,
  // set enable.idempotence and acks=all on the producer, clear the Redis hold before publishing the
  // release, and insert an outbox row when the broker rejects the produce.
  def publishEvent(orderId: String, sku: String, quantity: Int, reason: String): Unit = {
    val event = JsObject(
      "event_id" -> JsString(UUID.randomUUID().toString),
      "sku" -> JsString(sku),
      "order_id" -> JsString(orderId),
      "quantity" -> JsNumber(quantity),
      "reason" -> JsString(reason)
    )
    producer.send(new ProducerRecord[String, String](InventoryTopic, orderId, event.compactPrint))
  }

  def release(orderId: String, sku: String, quantity: Int): Unit = {
    publishEvent(orderId, sku, quantity, "released")
    jedis.del(s"hold:$orderId")
  }
}
`,
      solution: `import java.util.Properties
import java.util.UUID

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object InventoryPublisher {
  val InventoryTopic = "inventory.event"

  // enable.idempotence gives the producer a sequence number per partition and acks=all waits for the
  // in-sync replicas, so a retried record is neither duplicated nor lost.
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  /** The outbox table: one row per movement the broker did not accept. */
  object OutboxStore {
    /** INSERT INTO outbox (event_id, payload) VALUES (?, ?); a relay republishes the row. */
    def insertOutbox(event: JsObject): Unit =
      throw new UnsupportedOperationException("the outbox is not wired up in the demo")
  }

  def publishEvent(sku: String, delta: Int, reservationId: String, reason: String, available: Int): Unit = {
    val event = JsObject(
      "event_id" -> JsString(UUID.randomUUID().toString),
      "sku" -> JsString(sku),
      "delta" -> JsNumber(delta),
      "reservation_id" -> JsString(reservationId),
      "reason" -> JsString(reason),
      "available" -> JsNumber(available)
    )
    val payload = event.compactPrint
    try {
      producer.send(new ProducerRecord[String, String](InventoryTopic, sku, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException => OutboxStore.insertOutbox(event)
    }
  }

  def release(reservationId: String, sku: String, quantity: Int): Unit = {
    val available = jedis.incrBy(s"stock:$sku", quantity.toLong)
    jedis.del(s"hold:$reservationId")
    publishEvent(sku, quantity, reservationId, "released", available.toInt)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kInventoryTopic = "inventory.event";

std::string newEventId();

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// TODO: key the record by the sku instead of the order id, carry delta + reservation_id + reason,
// set enable.idempotence and acks=all on the producer, clear the Redis hold before publishing the
// release, and insert an outbox row when the broker rejects the produce.
void publishEvent(const std::string& orderId, const std::string& sku, int quantity, const std::string& reason) {
  const json event = {{"event_id", newEventId()}, {"sku", sku}, {"order_id", orderId}, {"quantity", quantity}, {"reason", reason}};
  const auto payload = event.dump();
  producer->produce(
      kInventoryTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      orderId.data(),
      orderId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

void release(const std::string& orderId, const std::string& sku, int quantity) {
  publishEvent(orderId, sku, quantity, "released");
  redis->del("hold:" + orderId);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kInventoryTopic = "inventory.event";

std::string newEventId();

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

/** The outbox table: one row per movement the broker did not accept. */
struct OutboxStore {
  // INSERT INTO outbox (event_id, payload) VALUES ($1, $2); a relay republishes the row.
  void insertOutbox(const json& event);
};

OutboxStore store;

void publishEvent(const std::string& sku, int delta, const std::string& reservationId, const std::string& reason, int available) {
  const json event = {
      {"event_id", newEventId()},
      {"sku", sku},
      {"delta", delta},
      {"reservation_id", reservationId},
      {"reason", reason},
      {"available", available},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(
      kInventoryTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      sku.data(),
      sku.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(event);
  }
  producer->flush(2000);
}

void release(const std::string& reservationId, const std::string& sku, int quantity) {
  const auto available = redis->incrby("stock:" + sku, quantity);
  redis->del("hold:" + reservationId);
  publishEvent(sku, quantity, reservationId, "released", static_cast<int>(available));
}
`,
    },
  },
  hints: [
    'The key is an argument of the produce call, not a field in the payload: `key=sku` / `key: sku` / `Key: []byte(sku)` / `ProducerRecord(topic, sku, payload)` / the `sku.data(), sku.size()` pair. On the release path the hold clear is one Redis call and it must run before the produce — reorder the two statements; no timeout or retry can fix an ordering bug.',
    'Durability is producer configuration, not application logic: `enable.idempotence` with `acks=all`, KafkaJS’s `idempotent: true` plus `acks: -1` on the record, kafka-go’s `RequiredAcks: kafka.RequireAll` with `&kafka.Hash{}`, or librdkafka’s `enable.idempotence` / `acks` properties. While you are in the payload, add `delta` and `reservation_id` next to the reason.',
    'The outbox is the durability half: wrap the produce and, on the failure branch (exception, non-zero error code, pending flush), insert the row. Declare the store as a class/struct with an insert method — a relay reads that table when the broker recovers, so a produce failure must never lose the movement.',
  ],
  debrief: `A stock ledger is an ordered log per sku, and the partition key is what makes it ordered: key by sku and every movement of that sku is appended to one partition in order, so a consumer folding deltas sees them in the order they happened. Key by anything else — the order id in the draft — and two orders touching the same sku interleave. The key is therefore a correctness decision, not a routing detail, which is why the checks pin the key argument of the produce call rather than the topic name.

The release path is the second contract: the hold is what stops the store from selling the unit again, so the movement may only become visible after the hold is gone. Producing first leaves a window in which the ledger says released while the store still holds the unit — a double-sell that only a replay exposes. The outbox closes the third gap: Redis state and the broker cannot commit together, so a rejected produce writes the event where a relay can find it, and the ledger stays rebuildable after an outage. Idempotence plus acks=all make the retry safe; without them a retry duplicates a movement and the rebuilt counter drifts from the one the API serves. Real systems add a relay that claims rows with \`FOR UPDATE SKIP LOCKED\`, consumer-side dedupe on \`event_id\`, a schema registry for the payload, and a reconciliation job between the ledger and the counter.`,
};
