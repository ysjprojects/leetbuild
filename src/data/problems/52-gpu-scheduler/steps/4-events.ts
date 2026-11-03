import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'The placement stream: one event per booking, after the ledger',
  concept: 'kafka',
  file: 'events',
  focus: ['scheduler', 'redis', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter wraps the ledger: \`allocate_and_publish\` produces a record to
\`gpu.placement\` and books the node, \`release_and_publish\` releases it, \`relay_outbox\` resends
whatever the outbox holds. It publishes the demo placement and hides five flaws.

**Failure mode the checks target.** A refused placement still shows up in the stream; a produce the
broker refuses is lost without a trace; the consumer that rebuilds a node's occupancy sees every
tenant's events interleaved and no releases at all, so its picture of the node only ever grows.

- \`allocate_and_publish(node_id, placement_id, tenant, count, memory_gb)\` calls \`allocate\` and,
  only on \`ALLOCATED\`, produces one event; it returns the ledger's answer. The placement hash
  keeps \`tenant\` and \`memory_gb\` for the release.
- \`release_and_publish(node_id, placement_id)\` calls \`release\` and produces a \`release\` event
  only when the counters moved.
- Events go to \`TOPIC\` (\`gpu.placement\`) **keyed by the node id**, as JSON with \`type\`
  (\`allocation\` or \`release\`), \`placement_id\`, \`node_id\`, \`tenant\`, \`gpu_count\`,
  \`memory_gb\` and \`ts\`. Folding a node's events (\`+gpu_count\` per allocation, \`-gpu_count\` per
  release) must equal the node's \`allocated\`.
- A delivery failure is reported through the producer's **delivery callback**; it appends the event
  (key and value) to the Redis list \`OUTBOX\`. \`relay_outbox()\` produces every row again and
  returns how many it sent.`,
  sequence: {
    participants: ['gpusched', 'Redis', 'Kafka'],
    messages: [
      {from: 'gpusched', to: 'Redis', label: 'EVAL allocate gpu-1 p-7 4 → ALLOCATED', kind: 'sync'},
      {from: 'gpusched', to: 'Kafka', label: 'produce gpu.placement key=gpu-1 {allocation, p-7, 4, 80}', kind: 'async'},
      {from: 'Kafka', to: 'gpusched', label: 'delivery report: ok', kind: 'reply'},
      {
        from: 'gpusched',
        to: 'Redis',
        label: 'EVAL allocate gpu-1 p-8 6 → NO_CAPACITY (nothing produced)',
        kind: 'sync',
      },
      {from: 'gpusched', to: 'Kafka', label: 'produce key=gpu-1 {release, p-7, 4}', kind: 'async'},
      {from: 'Kafka', to: 'gpusched', label: 'delivery report: timed out', kind: 'reply'},
      {from: 'gpusched', to: 'Redis', label: 'RPUSH outbox:gpu.placement {key, value}', kind: 'sync'},
      {from: 'gpusched', to: 'Kafka', label: 'relay_outbox: produce the row again', kind: 'async'},
    ],
  },
  hints: [
    'The utilization dashboard shows a node at 14 of 8 GPUs: it counted a placement the ledger refused, and nothing ever subtracts. After a broker hiccup the stream is missing bookings that Redis has.',
    'The record is produced before the ledger answers, keyed by tenant, with no release counterpart; the broker’s delivery report is never looked at, so a refused produce is gone.',
    'Produce after `allocate` returns ALLOCATED, with `key=node_id` and the full payload; add a release event in `release_and_publish`; in the delivery callback, `RPUSH OUTBOX` the key and value on error.',
  ],
  checks: [
    {
      id: 'node-key',
      title: 'Events go to gpu.placement keyed by the node id',
      detail:
        'The record key is the node id, so one node’s events share a partition and stay ordered for the consumer that folds them. The starter keys by tenant.',
      match: {
        python: {all: [/TOPIC/, /producer\.produce\([\s\S]{0,300}?key\s*=\s*node_id/], none: [/key\s*=\s*tenant/]},
        typescript: {all: [/TOPIC/, /key:\s*nodeId|publish\(nodeId,/], none: [/key:\s*tenant/]},
        go: {
          all: [/config\.Topic/, /Key:\s*\[\]byte\(\s*nodeID\s*\)|publish\(ctx, nodeID,/],
          none: [/Key:\s*\[\]byte\(\s*tenant\s*\)/],
        },
        scala: {
          all: [/Topic/, /new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*nodeId\s*,|publish\(nodeId,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*tenant\s*,/],
        },
        cpp: {
          all: [/kTopic/, /node_id\.c_str\(\)\s*,\s*node_id\.(size|length)\(\)/],
          none: [/tenant\.c_str\(\)\s*,\s*tenant\.(size|length)\(\)/],
        },
      },
    },
    {
      id: 'event-fields',
      title: 'The payload carries type, placement id, node, tenant, gpu_count and memory_gb',
      detail:
        'A replay needs the event type and the numbers to attribute occupancy: `type`, `placement_id`, `node_id`, `tenant`, `gpu_count`, `memory_gb`, `ts`. The starter sends `{id, tenant, gpus}`.',
      match: {
        python: {
          all: [/["']type["']/, /["']placement_id["']/, /["']gpu_count["']/, /["']memory_gb["']/, /["']node_id["']/],
        },
        typescript: {all: [/\btype:/, /placement_id:/, /gpu_count:/, /memory_gb:/, /node_id:/]},
        go: {all: [/json:"type"/, /json:"placement_id"/, /json:"gpu_count"/, /json:"memory_gb"/, /json:"node_id"/]},
        scala: {all: [/"type"/, /"placement_id"/, /"gpu_count"/, /"memory_gb"/, /"node_id"/]},
        cpp: {all: [/"type"/, /"placement_id"/, /"gpu_count"/, /"memory_gb"/, /"node_id"/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'The event is produced only after the ledger says ALLOCATED',
      detail:
        '`allocate` runs first and the produce follows its answer; a refused placement produces nothing. The starter produces first and books afterwards, so the stream claims capacity the ledger refused.',
      match: {
        python: {all: [/(=|if)\s*allocate\(/], none: [/producer\.produce\([\s\S]{0,400}?return allocate\(/]},
        typescript: {all: [/(=|if \()\s*await allocate\(/], none: [/producer\.send\([\s\S]{0,400}?return allocate\(/]},
        go: {all: [/(=|if)\s*allocate\(/], none: [/WriteMessages\([\s\S]{0,400}?return allocate\(/]},
        scala: {all: [/(=|if \()\s*State\.allocate\(/], none: [/producer\.send\([^\n]*\n\s*State\.allocate\(/]},
        cpp: {all: [/(=|if \()\s*allocate\(/], none: [/producer->produce\([\s\S]{0,600}?return allocate\(/]},
      },
    },
    {
      id: 'outbox-relay',
      title: 'A refused delivery lands in the outbox and is relayed',
      detail:
        'The delivery callback appends the key and value to `OUTBOX` when the broker reports an error, and `relay_outbox` produces the rows again. The starter never looks at the delivery report.',
      match: {
        python: {all: [/on_delivery\s*=/, /rpush\(\s*OUTBOX/, /def relay_outbox/], none: [/except KafkaException/]},
        typescript: {all: [/\bcatch\b/, /rpush\(\s*OUTBOX/, /relayOutbox/]},
        go: {all: [/err != nil/, /RPush\([^\n]*config\.Outbox/, /func relayOutbox/]},
        scala: {all: [/Callback/, /rpush\(\s*Outbox/, /def relayOutbox/]},
        cpp: {all: [/dr_cb\(/, /rpush\(\s*gpusched::kOutbox|rpush\(\s*kOutbox/, /relay_outbox\(/]},
      },
    },
    {
      id: 'release-reconcile',
      title: 'Releases are in the stream, so folding it matches the ledger',
      detail:
        '`release_and_publish` produces a `release` event when the counters moved, so a node’s folded stream equals its `allocated`. The starter publishes no release, and a rebuilt occupancy only ever grows.',
      match: {
        python: {
          all: [/["']release["']/, /def release_and_publish(?:(?!\ndef )[\s\S])*?(producer\.produce\(|_publish\()/],
        },
        typescript: {
          all: [/['"]release['"]/, /function releaseAndPublish(?:(?!\n\})[\s\S])*?(producer\.send\(|publish\()/],
        },
        go: {all: [/"release"/, /func releaseAndPublish(?:(?!\n\})[\s\S])*?(WriteMessages\(|publish\()/]},
        scala: {all: [/"release"/, /def releaseAndPublish(?:(?!\n {2}def )[\s\S])*?(producer\.send\(|publish\()/]},
        cpp: {all: [/"release"/, /release_and_publish\((?:(?!\n\})[\s\S])*?(producer->produce\(|publish\()/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import redis
from confluent_kafka import Producer

from gpusched.config import OUTBOX, TOPIC
from state import allocate, release

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})

# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.


def allocate_and_publish(node_id: str, placement_id: str, tenant: str, count: int, memory_gb: int) -> str:
    """Book the node and tell the stream: the ledger's answer."""
    event = json.dumps({"id": placement_id, "tenant": tenant, "gpus": count, "ts": time.time()})
    producer.produce(TOPIC, key=tenant, value=event)
    producer.poll(0)
    return allocate(node_id, placement_id, count)


def release_and_publish(node_id: str, placement_id: str) -> bool:
    """Return the placement's GPUs; True when the counters moved."""
    return release(node_id, placement_id)


def relay_outbox() -> int:
    """Produce every outbox row again; how many were sent."""
    sent = 0
    while (row := r.lpop(OUTBOX)) is not None:
        event = json.loads(row)
        producer.produce(TOPIC, key=event["key"], value=event["value"])
        sent += 1
    producer.poll(0)
    return sent
`,
      solution: `import json
import time

import redis
from confluent_kafka import Producer

from gpusched.config import OUTBOX, TOPIC
from state import allocate, release

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def _on_delivery(err, msg) -> None:
    """The broker's answer, later: a refused record goes to the outbox for relay_outbox."""
    if err is not None:
        r.rpush(OUTBOX, json.dumps({"key": msg.key().decode(), "value": msg.value().decode()}))


def _publish(node_id: str, value: str) -> None:
    producer.produce(TOPIC, key=node_id, value=value, on_delivery=_on_delivery)
    producer.poll(0)


def _event(kind: str, placement_id: str, node_id: str, tenant: str, count: int, memory_gb: float) -> str:
    return json.dumps({"type": kind, "placement_id": placement_id, "node_id": node_id, "tenant": tenant, "gpu_count": count, "memory_gb": memory_gb, "ts": time.time()})


def allocate_and_publish(node_id: str, placement_id: str, tenant: str, count: int, memory_gb: int) -> str:
    """Book the node and tell the stream: the ledger's answer."""
    result = allocate(node_id, placement_id, count)
    if result == "ALLOCATED":
        r.hset(f"placement:{placement_id}", mapping={"tenant": tenant, "memory_gb": memory_gb})
        _publish(node_id, _event("allocation", placement_id, node_id, tenant, count, memory_gb))
    return result


def release_and_publish(node_id: str, placement_id: str) -> bool:
    """Return the placement's GPUs; True when the counters moved, and then the stream hears of it."""
    record = r.hgetall(f"placement:{placement_id}")
    moved = release(node_id, placement_id)
    if moved:
        _publish(node_id, _event("release", placement_id, node_id, record.get("tenant", ""), int(record.get("count", 0)), float(record.get("memory_gb", 0))))
    return moved


def relay_outbox() -> int:
    """Produce every outbox row again; how many were sent."""
    sent = 0
    while (row := r.lpop(OUTBOX)) is not None:
        event = json.loads(row)
        producer.produce(TOPIC, key=event["key"], value=event["value"], on_delivery=_on_delivery)
        sent += 1
    producer.poll(0)
    return sent
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {OUTBOX, TOPIC} from 'gpusched/config';
import {allocate, release} from './state';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'gpusched', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

/** Book the node and tell the stream: the ledger's answer. */
export async function allocateAndPublish(nodeId: string, placementId: string, tenant: string, count: number, memoryGb: number): Promise<string> {
  const event = JSON.stringify({id: placementId, tenant, gpus: count, ts: Date.now() / 1000});
  await producer.send({topic: TOPIC, messages: [{key: tenant, value: event}], acks: -1});
  return allocate(nodeId, placementId, count);
}

/** Return the placement's GPUs; true when the counters moved. */
export async function releaseAndPublish(nodeId: string, placementId: string): Promise<boolean> {
  return release(nodeId, placementId);
}

/** Produce every outbox row again; how many were sent. */
export async function relayOutbox(): Promise<number> {
  let sent = 0;
  for (let row = await redis.lpop(OUTBOX); row !== null; row = await redis.lpop(OUTBOX)) {
    const {key, value} = JSON.parse(row) as {key: string; value: string};
    await producer.send({topic: TOPIC, messages: [{key, value}], acks: -1});
    sent += 1;
  }
  return sent;
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {OUTBOX, TOPIC} from 'gpusched/config';
import {allocate, release} from './state';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'gpusched', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One record to the stream; a delivery the broker refuses goes to the outbox for relayOutbox. */
async function publish(key: string, value: string): Promise<void> {
  try {
    await producer.send({topic: TOPIC, messages: [{key, value}], acks: -1});
  } catch {
    await redis.rpush(OUTBOX, JSON.stringify({key, value}));
  }
}

const event = (type: string, placementId: string, nodeId: string, tenant: string, count: number, memoryGb: number): string =>
  JSON.stringify({type, placement_id: placementId, node_id: nodeId, tenant, gpu_count: count, memory_gb: memoryGb, ts: Date.now() / 1000});

/** Book the node and tell the stream: the ledger's answer. */
export async function allocateAndPublish(nodeId: string, placementId: string, tenant: string, count: number, memoryGb: number): Promise<string> {
  const result = await allocate(nodeId, placementId, count);
  if (result === 'ALLOCATED') {
    await redis.hset(\`placement:\${placementId}\`, 'tenant', tenant, 'memory_gb', memoryGb);
    await publish(nodeId, event('allocation', placementId, nodeId, tenant, count, memoryGb));
  }
  return result;
}

/** Return the placement's GPUs; true when the counters moved, and then the stream hears of it. */
export async function releaseAndPublish(nodeId: string, placementId: string): Promise<boolean> {
  const record = await redis.hgetall(\`placement:\${placementId}\`);
  const moved = await release(nodeId, placementId);
  if (moved) await publish(nodeId, event('release', placementId, nodeId, record.tenant ?? '', Number(record.count ?? 0), Number(record.memory_gb ?? 0)));
  return moved;
}

/** Produce every outbox row again; how many were sent. */
export async function relayOutbox(): Promise<number> {
  let sent = 0;
  for (let row = await redis.lpop(OUTBOX); row !== null; row = await redis.lpop(OUTBOX)) {
    const {key, value} = JSON.parse(row) as {key: string; value: string};
    await publish(key, value);
    sent += 1;
  }
  return sent;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"gpusched/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: time.Millisecond,
}

// The ledger (state.go, step 2): allocate books count GPUs of the node for the placement, release returns them.
var (
	allocate = func(ctx context.Context, nodeID, placementID string, count int) (string, error) { panic("not implemented") }
	release  = func(ctx context.Context, nodeID, placementID string) (bool, error) { panic("not implemented") }
)

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

type outboxRow struct {
	Key   string \`json:"key"\`
	Value string \`json:"value"\`
}

// allocateAndPublish books the node and tells the stream: the ledger's answer.
func allocateAndPublish(ctx context.Context, nodeID, placementID, tenant string, count int, memoryGB float64) (string, error) {
	event, _ := json.Marshal(map[string]any{"id": placementID, "tenant": tenant, "gpus": count, "ts": float64(time.Now().UnixMilli()) / 1000})
	_ = writer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant), Value: event})
	return allocate(ctx, nodeID, placementID, count)
}

// releaseAndPublish returns the placement's GPUs; true when the counters moved.
func releaseAndPublish(ctx context.Context, nodeID, placementID string) (bool, error) {
	return release(ctx, nodeID, placementID)
}

// relayOutbox produces every outbox row again; how many were sent.
func relayOutbox(ctx context.Context) (int, error) {
	sent := 0
	for {
		raw, err := rdb.LPop(ctx, config.Outbox).Result()
		if err == redis.Nil {
			return sent, nil
		}
		if err != nil {
			return sent, err
		}
		var row outboxRow
		json.Unmarshal([]byte(raw), &row)
		if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(row.Key), Value: []byte(row.Value)}); err != nil {
			return sent, err
		}
		sent++
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"gpusched/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: time.Millisecond,
}

// The ledger (state.go, step 2): allocate books count GPUs of the node for the placement, release returns them.
var (
	allocate = func(ctx context.Context, nodeID, placementID string, count int) (string, error) { panic("not implemented") }
	release  = func(ctx context.Context, nodeID, placementID string) (bool, error) { panic("not implemented") }
)

type outboxRow struct {
	Key   string \`json:"key"\`
	Value string \`json:"value"\`
}

type placementEvent struct {
	Type        string  \`json:"type"\`
	PlacementID string  \`json:"placement_id"\`
	NodeID      string  \`json:"node_id"\`
	Tenant      string  \`json:"tenant"\`
	GPUCount    int     \`json:"gpu_count"\`
	MemoryGB    float64 \`json:"memory_gb"\`
	Ts          float64 \`json:"ts"\`
}

// publish writes one record to the stream; a write the broker refuses goes to the outbox for relayOutbox.
func publish(ctx context.Context, key string, value []byte) error {
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: value}); err != nil {
		row, _ := json.Marshal(outboxRow{Key: key, Value: string(value)})
		return rdb.RPush(ctx, config.Outbox, row).Err()
	}
	return nil
}

func event(kind, placementID, nodeID, tenant string, count int, memoryGB float64) []byte {
	value, _ := json.Marshal(placementEvent{Type: kind, PlacementID: placementID, NodeID: nodeID, Tenant: tenant, GPUCount: count, MemoryGB: memoryGB, Ts: float64(time.Now().UnixMilli()) / 1000})
	return value
}

// allocateAndPublish books the node and tells the stream: the ledger's answer.
func allocateAndPublish(ctx context.Context, nodeID, placementID, tenant string, count int, memoryGB float64) (string, error) {
	result, err := allocate(ctx, nodeID, placementID, count)
	if err != nil || result != "ALLOCATED" {
		return result, err
	}
	rdb.HSet(ctx, "placement:"+placementID, "tenant", tenant, "memory_gb", memoryGB)
	return result, publish(ctx, nodeID, event("allocation", placementID, nodeID, tenant, count, memoryGB))
}

// releaseAndPublish returns the placement's GPUs; true when the counters moved, and then the stream hears of it.
func releaseAndPublish(ctx context.Context, nodeID, placementID string) (bool, error) {
	record := rdb.HGetAll(ctx, "placement:"+placementID).Val()
	moved, err := release(ctx, nodeID, placementID)
	if err != nil || !moved {
		return moved, err
	}
	count, _ := strconv.Atoi(record["count"])
	memoryGB, _ := strconv.ParseFloat(record["memory_gb"], 64)
	return true, publish(ctx, nodeID, event("release", placementID, nodeID, record["tenant"], count, memoryGB))
}

// relayOutbox produces every outbox row again; how many were sent.
func relayOutbox(ctx context.Context) (int, error) {
	sent := 0
	for {
		raw, err := rdb.LPop(ctx, config.Outbox).Result()
		if err == redis.Nil {
			return sent, nil
		}
		if err != nil {
			return sent, err
		}
		var row outboxRow
		json.Unmarshal([]byte(raw), &row)
		if err := publish(ctx, row.Key, []byte(row.Value)); err != nil {
			return sent, err
		}
		sent++
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import gpusched.Config.{Outbox, Topic}

object Events {
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

  /** Book the node and tell the stream: the ledger's answer. */
  def allocateAndPublish(nodeId: String, placementId: String, tenant: String, count: Int, memoryGb: Double): String = {
    val event = JsObject("id" -> JsString(placementId), "tenant" -> JsString(tenant), "gpus" -> JsNumber(count), "ts" -> JsNumber(System.currentTimeMillis() / 1000.0)).compactPrint
    producer.send(new ProducerRecord[String, String](Topic, tenant, event))
    State.allocate(nodeId, placementId, count)
  }

  /** Return the placement's GPUs; true when the counters moved. */
  def releaseAndPublish(nodeId: String, placementId: String): Boolean = State.release(nodeId, placementId)

  /** Produce every outbox row again; how many were sent. */
  def relayOutbox(): Int = {
    var sent = 0
    var row = jedis.lpop(Outbox)
    while (row != null) {
      val fields = row.parseJson.asJsObject.fields
      val key = fields("key").convertTo[String]
      val value = fields("value").convertTo[String]
      producer.send(new ProducerRecord[String, String](Topic, key, value))
      sent += 1
      row = jedis.lpop(Outbox)
    }
    sent
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

import gpusched.Config.{Outbox, Topic}

object Events {
  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One record to the stream; a delivery the broker refuses goes to the outbox for relayOutbox. */
  private def publish(key: String, value: String): Unit =
    producer.send(new ProducerRecord[String, String](Topic, key, value), new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) jedis.rpush(Outbox, JsObject("key" -> JsString(key), "value" -> JsString(value)).compactPrint)
    })

  private def event(kind: String, placementId: String, nodeId: String, tenant: String, count: Int, memoryGb: Double): String =
    JsObject(
      "type" -> JsString(kind),
      "placement_id" -> JsString(placementId),
      "node_id" -> JsString(nodeId),
      "tenant" -> JsString(tenant),
      "gpu_count" -> JsNumber(count),
      "memory_gb" -> JsNumber(memoryGb),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0)
    ).compactPrint

  /** Book the node and tell the stream: the ledger's answer. */
  def allocateAndPublish(nodeId: String, placementId: String, tenant: String, count: Int, memoryGb: Double): String = {
    val result = State.allocate(nodeId, placementId, count)
    if (result == "ALLOCATED") {
      jedis.hset(s"placement:$placementId", Map("tenant" -> tenant, "memory_gb" -> memoryGb.toString).asJava)
      publish(nodeId, event("allocation", placementId, nodeId, tenant, count, memoryGb))
    }
    result
  }

  /** Return the placement's GPUs; true when the counters moved, and then the stream hears of it. */
  def releaseAndPublish(nodeId: String, placementId: String): Boolean = {
    val record = jedis.hgetAll(s"placement:$placementId").asScala
    val moved = State.release(nodeId, placementId)
    if (moved) {
      val count = record.get("count").map(_.toInt).getOrElse(0)
      val memoryGb = record.get("memory_gb").map(_.toDouble).getOrElse(0.0)
      publish(nodeId, event("release", placementId, nodeId, record.getOrElse("tenant", ""), count, memoryGb))
    }
    moved
  }

  /** Produce every outbox row again; how many were sent. */
  def relayOutbox(): Int = {
    var sent = 0
    var row = jedis.lpop(Outbox)
    while (row != null) {
      val fields = row.parseJson.asJsObject.fields
      publish(fields("key").convertTo[String], fields("value").convertTo[String])
      sent += 1
      row = jedis.lpop(Outbox)
    }
    sent
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "gpusched/config.h"
#include "state.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

double now_s() { return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count(); }

// Books the node and tells the stream: the ledger's answer.
std::string allocate_and_publish(const std::string& node_id, const std::string& placement_id, const std::string& tenant, int count, double memory_gb) {
  const std::string event = json{{"id", placement_id}, {"tenant", tenant}, {"gpus", count}, {"ts", now_s()}}.dump();
  producer->produce(gpusched::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                    event.size(), tenant.c_str(), tenant.size(), 0, nullptr);
  producer->poll(0);
  return allocate(node_id, placement_id, count);
}

// Returns the placement's GPUs; true when the counters moved.
bool release_and_publish(const std::string& node_id, const std::string& placement_id) { return release(node_id, placement_id); }

// Produces every outbox row again; how many were sent.
int relay_outbox() {
  int sent = 0;
  while (const auto row = redis.lpop(gpusched::kOutbox)) {
    const json fields = json::parse(*row);
    const std::string key = fields.value("key", "");
    const std::string value = fields.value("value", "");
    producer->produce(gpusched::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                      value.size(), key.c_str(), key.size(), 0, nullptr);
    sent++;
  }
  producer->poll(0);
  return sent;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "gpusched/config.h"
#include "state.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The broker's answer, later: a refused record goes to the outbox for relay_outbox.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    const std::string key = message.key() ? *message.key() : "";
    const std::string value(static_cast<const char*>(message.payload()), message.len());
    redis.rpush(gpusched::kOutbox, json{{"key", key}, {"value", value}}.dump());
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

double now_s() { return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count(); }

// One record to the stream, keyed by the node; the delivery report decides whether it reached the broker.
void publish(const std::string& node_id, const std::string& value) {
  producer->produce(gpusched::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), node_id.c_str(), node_id.size(), 0, nullptr);
  producer->poll(0);
}

std::string event(const std::string& kind, const std::string& placement_id, const std::string& node_id, const std::string& tenant, int count,
                  double memory_gb) {
  return json{{"type", kind},     {"placement_id", placement_id}, {"node_id", node_id}, {"tenant", tenant},
              {"gpu_count", count}, {"memory_gb", memory_gb},       {"ts", now_s()}}
      .dump();
}

// Books the node and tells the stream: the ledger's answer.
std::string allocate_and_publish(const std::string& node_id, const std::string& placement_id, const std::string& tenant, int count, double memory_gb) {
  const std::string result = allocate(node_id, placement_id, count);
  if (result == "ALLOCATED") {
    redis.hset("placement:" + placement_id, "tenant", tenant, "memory_gb", std::to_string(memory_gb));
    publish(node_id, event("allocation", placement_id, node_id, tenant, count, memory_gb));
  }
  return result;
}

// Returns the placement's GPUs; true when the counters moved, and then the stream hears of it.
bool release_and_publish(const std::string& node_id, const std::string& placement_id) {
  const auto record = redis.hgetall("placement:" + placement_id);
  const bool moved = release(node_id, placement_id);
  if (moved) {
    const int count = record.count("count") ? std::stoi(record.at("count")) : 0;
    const double memory_gb = record.count("memory_gb") ? std::stod(record.at("memory_gb")) : 0;
    publish(node_id, event("release", placement_id, node_id, record.count("tenant") ? record.at("tenant") : "", count, memory_gb));
  }
  return moved;
}

// Produces every outbox row again; how many were sent.
int relay_outbox() {
  int sent = 0;
  while (const auto row = redis.lpop(gpusched::kOutbox)) {
    const json fields = json::parse(*row);
    publish(fields.value("key", ""), fields.value("value", ""));
    sent++;
  }
  return sent;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "gpu.placement"
OUTBOX = "outbox:gpu.placement"


def _node(ctx, node_id, capacity=8):
    ctx.redis.hset(f"node:{node_id}", mapping={"gpu_type": "a100", "capacity": capacity, "allocated": 0})
    ctx.redis.sadd("nodes", node_id)
    ctx.redis.set(f"heartbeat:{node_id}", "1", ex=30)


def _world(ctx):
    _node(ctx, "gpu-1")
    _node(ctx, "gpu-2")
    return ctx.load("events")


def _allocated(ctx, node_id="gpu-1"):
    return int(ctx.redis.hget(f"node:{node_id}", "allocated") or 0)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _folded(ctx, node_id):
    """The node's occupancy as a consumer rebuilds it from its events: +gpu_count per allocation, -gpu_count per release."""
    total = 0
    for e in _events(ctx):
        if e.get("node_id") != node_id:
            continue
        total += int(e.get("gpu_count", 0)) * (1 if e.get("type") == "allocation" else -1 if e.get("type") == "release" else 0)
    return total


def check_node_key(ctx):
    m = _world(ctx)
    assert m.allocate_and_publish("gpu-1", "p-1", "acme", 4, 80) == "ALLOCATED"
    assert m.allocate_and_publish("gpu-1", "p-2", "beta", 2, 40) == "ALLOCATED"
    assert m.allocate_and_publish("gpu-2", "p-3", "acme", 1, 20) == "ALLOCATED"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three bookings produced {len(records)} records on gpu.placement (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"gpu-1", b"gpu-1", b"gpu-2"], f"records must be keyed by the node id, got {keys}"
    assert records[0].partition == records[1].partition, "one node's events must share a partition so a consumer folds them in order"


def check_event_fields(ctx):
    m = _world(ctx)
    assert m.allocate_and_publish("gpu-1", "p-1", "acme", 4, 80) == "ALLOCATED"
    events = _events(ctx)
    assert len(events) == 1, f"one booking produced {len(events)} records"
    e = events[0]
    expected = {"type": "allocation", "placement_id": "p-1", "node_id": "gpu-1", "tenant": "acme", "gpu_count": 4, "memory_gb": 80}
    for field, value in expected.items():
        assert e.get(field) == value, f"the event is {e}: expected {field} = {value!r}"
    assert "ts" in e, f"the event carries no ts: {e}"


def check_publish_after_commit(ctx):
    m = _world(ctx)
    assert m.allocate_and_publish("gpu-1", "p-1", "acme", 8, 80) == "ALLOCATED"
    assert m.allocate_and_publish("gpu-1", "p-2", "beta", 4, 40) == "NO_CAPACITY", "4 GPUs on a full node is NO_CAPACITY"
    assert len(_events(ctx)) == 1, f"a refused placement must produce nothing: the stream holds {_events(ctx)}"
    ctx.redis.delete("heartbeat:gpu-2")
    assert m.allocate_and_publish("gpu-2", "p-3", "acme", 1, 20) == "NO_HEARTBEAT"
    assert len(_events(ctx)) == 1, "a placement refused for a lapsed heartbeat must produce nothing"
    assert _folded(ctx, "gpu-1") == _allocated(ctx), f"the stream folds to {_folded(ctx, 'gpu-1')} GPUs on gpu-1, the ledger says {_allocated(ctx)}"


def check_outbox_relay(ctx):
    m = _world(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    assert m.allocate_and_publish("gpu-1", "p-1", "acme", 4, 80) == "ALLOCATED", "the booking stands whatever the broker says"
    assert _events(ctx) == [], "the broker refused the record: nothing is on the topic"
    rows = ctx.redis.lrange(OUTBOX, 0, -1)
    assert len(rows) == 1, f"a refused delivery must leave one row in {OUTBOX}, found {rows} (handle the delivery report: on error, RPUSH the key and value)"
    row = json.loads(rows[0])
    assert row.get("key") == "gpu-1" and "p-1" in str(row.get("value")), f"the outbox row must hold the key and the value, got {row}"
    sent = m.relay_outbox()
    assert sent == 1, f"relay_outbox sent {sent} rows, expected 1"
    events = _events(ctx)
    assert len(events) == 1 and events[0].get("placement_id") == "p-1", f"after the relay the stream must hold p-1's allocation, got {events}"
    assert ctx.kafka.records(TOPIC)[0].key == b"gpu-1", "the relayed record keeps its node key"
    assert ctx.redis.llen(OUTBOX) == 0, "a relayed row leaves the outbox"
    assert m.relay_outbox() == 0 and len(_events(ctx)) == 1, "an empty outbox relays nothing"


def check_release_reconcile(ctx):
    m = _world(ctx)
    assert m.allocate_and_publish("gpu-1", "p-1", "acme", 4, 80) == "ALLOCATED"
    assert m.allocate_and_publish("gpu-1", "p-2", "beta", 2, 40) == "ALLOCATED"
    assert m.release_and_publish("gpu-1", "p-1") is True, "the first release moves the counters"
    events = _events(ctx)
    assert len(events) == 3, f"two bookings and one release produced {len(events)} records, expected 3 (a release is an event too)"
    release = events[2]
    assert release.get("type") == "release" and release.get("placement_id") == "p-1" and release.get("gpu_count") == 4, f"the third event must be p-1's release with gpu_count 4, got {release}"
    assert ctx.kafka.records(TOPIC)[2].key == b"gpu-1", "the release is keyed by the node id too"
    assert _folded(ctx, "gpu-1") == 2 == _allocated(ctx), f"the stream folds to {_folded(ctx, 'gpu-1')} GPUs on gpu-1, the ledger says {_allocated(ctx)}"
    assert m.release_and_publish("gpu-1", "p-1") is False and len(_events(ctx)) == 3, "a repeated release moves nothing and produces nothing"
`,
    typescript: `const TOPIC = 'gpu.placement';
const OUTBOX = 'outbox:gpu.placement';

function node(ctx, id: string, capacity = 8): void {
  ctx.redis.hset(\`node:\${id}\`, 'gpu_type', 'a100', 'capacity', capacity, 'allocated', 0);
  ctx.redis.sadd('nodes', id);
  ctx.redis.set(\`heartbeat:\${id}\`, '1', 'EX', 30);
}

function world(ctx) {
  node(ctx, 'gpu-1');
  node(ctx, 'gpu-2');
  return ctx.load('events');
}

const allocated = (ctx, id = 'gpu-1'): number => Number(ctx.redis.hget(\`node:\${id}\`, 'allocated') ?? 0);
const events = (ctx): Record<string, unknown>[] => ctx.kafka.records(TOPIC).map(r => JSON.parse(r.value.toString()));

/** The node's occupancy as a consumer rebuilds it from its events: +gpu_count per allocation, -gpu_count per release. */
function folded(ctx, id: string): number {
  let total = 0;
  for (const e of events(ctx)) {
    if (e.node_id !== id) continue;
    total += Number(e.gpu_count ?? 0) * (e.type === 'allocation' ? 1 : e.type === 'release' ? -1 : 0);
  }
  return total;
}

export async function check_node_key(ctx) {
  const m = world(ctx);
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-1', 'acme', 4, 80), 'ALLOCATED');
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-2', 'beta', 2, 40), 'ALLOCATED');
  assert.equal(await m.allocateAndPublish('gpu-2', 'p-3', 'acme', 1, 20), 'ALLOCATED');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, 'three bookings produced records on gpu.placement');
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['gpu-1', 'gpu-1', 'gpu-2'], \`records must be keyed by the node id, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[1].partition, "one node's events must share a partition so a consumer folds them in order");
}

export async function check_event_fields(ctx) {
  const m = world(ctx);
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-1', 'acme', 4, 80), 'ALLOCATED');
  const all = events(ctx);
  assert.equal(all.length, 1, 'one booking produced records');
  const e = all[0];
  const expected = {type: 'allocation', placement_id: 'p-1', node_id: 'gpu-1', tenant: 'acme', gpu_count: 4, memory_gb: 80};
  for (const [field, value] of Object.entries(expected)) assert.strictEqual(e[field], value, \`the event is \${JSON.stringify(e)}: expected \${field} = \${JSON.stringify(value)}\`);
  assert('ts' in e, \`the event carries no ts: \${JSON.stringify(e)}\`);
}

export async function check_publish_after_commit(ctx) {
  const m = world(ctx);
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-1', 'acme', 8, 80), 'ALLOCATED');
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-2', 'beta', 4, 40), 'NO_CAPACITY', '4 GPUs on a full node');
  assert.equal(events(ctx).length, 1, \`a refused placement must produce nothing: the stream holds \${JSON.stringify(events(ctx))}\`);
  ctx.redis.del('heartbeat:gpu-2');
  assert.equal(await m.allocateAndPublish('gpu-2', 'p-3', 'acme', 1, 20), 'NO_HEARTBEAT');
  assert.equal(events(ctx).length, 1, 'a placement refused for a lapsed heartbeat must produce nothing');
  assert.equal(folded(ctx, 'gpu-1'), allocated(ctx), 'the stream folded for gpu-1 against the ledger');
}

export async function check_outbox_relay(ctx) {
  const m = world(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-1', 'acme', 4, 80), 'ALLOCATED', 'the booking stands whatever the broker says');
  assert.deepEqual(events(ctx), [], 'the broker refused the record: nothing is on the topic');
  const rows = ctx.redis.lrange(OUTBOX, 0, -1);
  assert.equal(rows.length, 1, \`a refused delivery must leave one row in \${OUTBOX}, found \${JSON.stringify(rows)} (catch the failed send: RPUSH the key and value)\`);
  const row = JSON.parse(rows[0]);
  assert(row.key === 'gpu-1' && String(row.value).includes('p-1'), \`the outbox row must hold the key and the value, got \${rows[0]}\`);
  assert.equal(await m.relayOutbox(), 1, 'rows relayOutbox sent');
  const all = events(ctx);
  assert(all.length === 1 && all[0].placement_id === 'p-1', \`after the relay the stream must hold p-1's allocation, got \${JSON.stringify(all)}\`);
  assert.equal(ctx.kafka.records(TOPIC)[0].key?.toString(), 'gpu-1', 'the relayed record keeps its node key');
  assert.equal(ctx.redis.llen(OUTBOX), 0, 'a relayed row leaves the outbox');
  assert((await m.relayOutbox()) === 0 && events(ctx).length === 1, 'an empty outbox relays nothing');
}

export async function check_release_reconcile(ctx) {
  const m = world(ctx);
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-1', 'acme', 4, 80), 'ALLOCATED');
  assert.equal(await m.allocateAndPublish('gpu-1', 'p-2', 'beta', 2, 40), 'ALLOCATED');
  assert.equal(await m.releaseAndPublish('gpu-1', 'p-1'), true, 'the first release moves the counters');
  const all = events(ctx);
  assert.equal(all.length, 3, 'two bookings and one release produced records (a release is an event too)');
  const release = all[2];
  assert(release.type === 'release' && release.placement_id === 'p-1' && release.gpu_count === 4, \`the third event must be p-1's release with gpu_count 4, got \${JSON.stringify(release)}\`);
  assert.equal(ctx.kafka.records(TOPIC)[2].key?.toString(), 'gpu-1', 'the release is keyed by the node id too');
  assert(folded(ctx, 'gpu-1') === 2 && allocated(ctx) === 2, \`the stream folds to \${folded(ctx, 'gpu-1')} GPUs on gpu-1, the ledger says \${allocated(ctx)}\`);
  assert((await m.releaseAndPublish('gpu-1', 'p-1')) === false && events(ctx).length === 3, 'a repeated release moves nothing and produces nothing');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	eventsTopic  = "gpu.placement"
	eventsOutbox = "outbox:gpu.placement"
)

func eventsNode(ctx *harness.Ctx, id string) {
	ctx.Redis.Do("HSET", "node:"+id, "gpu_type", "a100", "capacity", 8, "allocated", 0)
	ctx.Redis.Do("SADD", "nodes", id)
	ctx.Redis.Do("SET", "heartbeat:"+id, "1", "EX", 30)
}

// eventsLedger stands in for allocate and release (state.go, step 2).
func eventsLedger(ctx *harness.Ctx) {
	allocate = func(_ context.Context, nodeID, placementID string, count int) (string, error) {
		if ctx.Redis.Exists("heartbeat:"+nodeID) == 0 {
			return "NO_HEARTBEAT", nil
		}
		if ctx.Redis.SIsMember("node:"+nodeID+":placements", placementID) {
			return "ALLOCATED", nil
		}
		fields := ctx.Redis.HGetAll("node:" + nodeID)
		capacity, _ := strconv.Atoi(fields["capacity"])
		booked, _ := strconv.Atoi(fields["allocated"])
		if booked+count > capacity {
			return "NO_CAPACITY", nil
		}
		ctx.Redis.Do("HINCRBY", "node:"+nodeID, "allocated", count)
		ctx.Redis.Do("HSET", "placement:"+placementID, "node_id", nodeID, "count", count, "status", "allocated")
		ctx.Redis.Do("SADD", "node:"+nodeID+":placements", placementID)
		return "ALLOCATED", nil
	}
	release = func(_ context.Context, nodeID, placementID string) (bool, error) {
		if !ctx.Redis.SIsMember("node:"+nodeID+":placements", placementID) {
			return false, nil
		}
		count, _ := ctx.Redis.HGet("placement:"+placementID, "count")
		n, _ := strconv.Atoi(count)
		ctx.Redis.Do("HINCRBY", "node:"+nodeID, "allocated", -n)
		ctx.Redis.Do("HSET", "placement:"+placementID, "status", "released")
		ctx.Redis.Do("SREM", "node:"+nodeID+":placements", placementID)
		return true, nil
	}
}

func eventsWorld(ctx *harness.Ctx) {
	eventsNode(ctx, "gpu-1")
	eventsNode(ctx, "gpu-2")
	eventsLedger(ctx)
}

func eventsAllocated(ctx *harness.Ctx, id string) int {
	v, _ := ctx.Redis.HGet("node:"+id, "allocated")
	n, _ := strconv.Atoi(v)
	return n
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, r := range ctx.Kafka.Records(eventsTopic) {
		var e map[string]any
		json.Unmarshal(r.Value, &e)
		out = append(out, e)
	}
	return out
}

// eventsFolded is the node's occupancy as a consumer rebuilds it from its events.
func eventsFolded(ctx *harness.Ctx, id string) int {
	total := 0
	for _, e := range eventsAll(ctx) {
		nodeID, _ := e["node_id"].(string)
		if nodeID != id {
			continue
		}
		count, _ := e["gpu_count"].(float64)
		kind, _ := e["type"].(string)
		if kind == "allocation" {
			total += int(count)
		} else if kind == "release" {
			total -= int(count)
		}
	}
	return total
}

func eventsBook(ctx *harness.Ctx, nodeID, pid, tenant string, count int, memoryGB float64) string {
	result, err := allocateAndPublish(context.Background(), nodeID, pid, tenant, count, memoryGB)
	ctx.NoError(err, "allocateAndPublish(%s, %s)", nodeID, pid)
	ctx.Settle()
	return result
}

func CheckNodeKey(ctx *harness.Ctx) {
	eventsWorld(ctx)
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "booking p-1")
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-2", "beta", 2, 40), "ALLOCATED", "booking p-2")
	ctx.Equal(eventsBook(ctx, "gpu-2", "p-3", "acme", 1, 20), "ALLOCATED", "booking p-3")
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three bookings must produce three records on gpu.placement; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"gpu-1", "gpu-1", "gpu-2"}, "records must be keyed by the node id")
	ctx.Equal(records[0].Partition, records[1].Partition, "one node's events must share a partition so a consumer folds them in order; gpu-1's partitions")
}

func CheckEventFields(ctx *harness.Ctx) {
	eventsWorld(ctx)
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "booking p-1")
	all := eventsAll(ctx)
	ctx.Equal(len(all), 1, "one booking's records")
	e := all[0]
	for field, want := range map[string]any{"type": "allocation", "placement_id": "p-1", "node_id": "gpu-1", "tenant": "acme", "gpu_count": 4, "memory_gb": 80} {
		ctx.Equal(e[field], want, "the event is %v: %s", e, field)
	}
	_, hasTS := e["ts"]
	ctx.Assert(hasTS, "the event carries no ts: %v", e)
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	eventsWorld(ctx)
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 8, 80), "ALLOCATED", "booking 8")
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-2", "beta", 4, 40), "NO_CAPACITY", "4 GPUs on a full node")
	ctx.Equal(len(eventsAll(ctx)), 1, "a refused placement must produce nothing: the stream holds %v; the records", eventsAll(ctx))
	ctx.Redis.Del("heartbeat:gpu-2")
	ctx.Equal(eventsBook(ctx, "gpu-2", "p-3", "acme", 1, 20), "NO_HEARTBEAT", "a node whose heartbeat lapsed")
	ctx.Equal(len(eventsAll(ctx)), 1, "a placement refused for a lapsed heartbeat must produce nothing; the records")
	ctx.Equal(eventsFolded(ctx, "gpu-1"), eventsAllocated(ctx, "gpu-1"), "the stream folded for gpu-1 against the ledger")
}

func CheckOutboxRelay(ctx *harness.Ctx) {
	eventsWorld(ctx)
	ctx.Kafka.FailNext(eventsTopic, 1)
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "the booking stands whatever the broker says")
	ctx.Equal(len(eventsAll(ctx)), 0, "the broker refused the record: nothing is on the topic; the records")
	rows := ctx.Redis.LRange(eventsOutbox, 0, -1)
	ctx.Equal(len(rows), 1, "a refused delivery must leave one row in %s, found %q (on a write error, RPUSH the key and value); the rows", eventsOutbox, rows)
	var row map[string]any
	json.Unmarshal([]byte(rows[0]), &row)
	key, _ := row["key"].(string)
	value, _ := row["value"].(string)
	ctx.Assert(key == "gpu-1" && strings.Contains(value, "p-1"), "the outbox row must hold the key and the value, got %s", rows[0])
	sent, err := relayOutbox(context.Background())
	ctx.NoError(err, "relayOutbox")
	ctx.Settle()
	ctx.Equal(sent, 1, "rows relayOutbox sent")
	all := eventsAll(ctx)
	relayedPid := ""
	if len(all) == 1 {
		relayedPid, _ = all[0]["placement_id"].(string)
	}
	ctx.Assert(relayedPid == "p-1", "after the relay the stream must hold p-1's allocation, got %v", all)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"gpu-1"}, "the relayed record keeps its node key")
	ctx.Equal(ctx.Redis.LLen(eventsOutbox), 0, "a relayed row leaves the outbox; rows left")
	sent, _ = relayOutbox(context.Background())
	ctx.Assert(sent == 0 && len(eventsAll(ctx)) == 1, "an empty outbox relays nothing")
}

func CheckReleaseReconcile(ctx *harness.Ctx) {
	eventsWorld(ctx)
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "booking p-1")
	ctx.Equal(eventsBook(ctx, "gpu-1", "p-2", "beta", 2, 40), "ALLOCATED", "booking p-2")
	moved, err := releaseAndPublish(context.Background(), "gpu-1", "p-1")
	ctx.NoError(err, "releaseAndPublish")
	ctx.Settle()
	ctx.Equal(moved, true, "the first release moves the counters")
	all := eventsAll(ctx)
	ctx.Equal(len(all), 3, "two bookings and one release must produce three records (a release is an event too); the records")
	rel := all[2]
	kind, _ := rel["type"].(string)
	pid, _ := rel["placement_id"].(string)
	ctx.Assert(kind == "release" && pid == "p-1" && rel["gpu_count"] == float64(4), "the third event must be p-1's release with gpu_count 4, got %v", rel)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic)[2], "gpu-1", "the release is keyed by the node id too")
	ctx.Assert(eventsFolded(ctx, "gpu-1") == 2 && eventsAllocated(ctx, "gpu-1") == 2, "the stream folds to %d GPUs on gpu-1, the ledger says %d", eventsFolded(ctx, "gpu-1"), eventsAllocated(ctx, "gpu-1"))
	moved, _ = releaseAndPublish(context.Background(), "gpu-1", "p-1")
	ctx.Settle()
	ctx.Assert(!moved && len(eventsAll(ctx)) == 3, "a repeated release moves nothing and produces nothing")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "gpu.placement";
const std::string kEventsOutbox = "outbox:gpu.placement";

harness::Ctx* eventsCtx = nullptr;

void eventsNode(harness::Ctx& ctx, const std::string& id) {
  ctx.Redis.Do("HSET", "node:" + id, "gpu_type", "a100", "capacity", 8, "allocated", 0);
  ctx.Redis.Do("SADD", "nodes", id);
  ctx.Redis.Do("SET", "heartbeat:" + id, "1", "EX", 30);
}

void eventsWorld(harness::Ctx& ctx) {
  eventsCtx = &ctx;
  eventsNode(ctx, "gpu-1");
  eventsNode(ctx, "gpu-2");
}

int eventsAllocated(harness::Ctx& ctx, const std::string& id) {
  const auto v = ctx.Redis.HGet("node:" + id, "allocated");
  return v ? std::stoi(*v) : 0;
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& r : ctx.Kafka.Records(kEventsTopic)) out.push_back(nlohmann::json::parse(r.Value.value_or(""), nullptr, false));
  return out;
}

// The node's occupancy as a consumer rebuilds it from its events.
int eventsFolded(harness::Ctx& ctx, const std::string& id) {
  int total = 0;
  for (const auto& e : eventsAll(ctx)) {
    if (!e.is_object() || e.value("node_id", "") != id) continue;
    const int count = e.value("gpu_count", 0);
    const std::string type = e.value("type", "");
    total += type == "allocation" ? count : type == "release" ? -count : 0;
  }
  return total;
}

std::string eventsBook(harness::Ctx& ctx, const std::string& node, const std::string& pid, const std::string& tenant, int count, double memory_gb) {
  const std::string result = allocate_and_publish(node, pid, tenant, count, memory_gb);
  ctx.Settle();
  return result;
}

}  // namespace

// The ledger (state.cpp, step 2) as the harness stands in for it.
std::string allocate(const std::string& node_id, const std::string& placement_id, int count) {
  harness::Ctx& ctx = *eventsCtx;
  if (ctx.Redis.Exists("heartbeat:" + node_id) == 0) return "NO_HEARTBEAT";
  if (ctx.Redis.SIsMember("node:" + node_id + ":placements", placement_id)) return "ALLOCATED";
  const auto fields = ctx.Redis.HGetAll("node:" + node_id);
  const int capacity = fields.count("capacity") ? std::stoi(fields.at("capacity")) : 0;
  const int booked = fields.count("allocated") ? std::stoi(fields.at("allocated")) : 0;
  if (booked + count > capacity) return "NO_CAPACITY";
  ctx.Redis.Do("HINCRBY", "node:" + node_id, "allocated", count);
  ctx.Redis.Do("HSET", "placement:" + placement_id, "node_id", node_id, "count", count, "status", "allocated");
  ctx.Redis.Do("SADD", "node:" + node_id + ":placements", placement_id);
  return "ALLOCATED";
}

bool release(const std::string& node_id, const std::string& placement_id) {
  harness::Ctx& ctx = *eventsCtx;
  if (!ctx.Redis.SIsMember("node:" + node_id + ":placements", placement_id)) return false;
  const auto count = ctx.Redis.HGet("placement:" + placement_id, "count");
  ctx.Redis.Do("HINCRBY", "node:" + node_id, "allocated", -(count ? std::stoi(*count) : 0));
  ctx.Redis.Do("HSET", "placement:" + placement_id, "status", "released");
  ctx.Redis.Do("SREM", "node:" + node_id + ":placements", placement_id);
  return true;
}

void CheckNodeKey(harness::Ctx& ctx) {
  eventsWorld(ctx);
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "booking p-1");
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-2", "beta", 2, 40), "ALLOCATED", "booking p-2");
  ctx.Equal(eventsBook(ctx, "gpu-2", "p-3", "acme", 1, 20), "ALLOCATED", "booking p-3");
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three bookings must produce three records on gpu.placement; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"gpu-1", "gpu-1", "gpu-2"}, "records must be keyed by the node id");
  ctx.Equal(records[0].Partition, records[1].Partition, "one node's events must share a partition so a consumer folds them in order; gpu-1's partitions");
}

void CheckEventFields(harness::Ctx& ctx) {
  eventsWorld(ctx);
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "booking p-1");
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 1, "one booking's records");
  const nlohmann::json& e = all[0];
  ctx.Assert(e.is_object(), "the event is not a JSON object: %s", ctx.Kafka.Values(kEventsTopic)[0]);
  ctx.Equal(e.value("type", ""), "allocation", "the event's type (%s)", e.dump());
  ctx.Equal(e.value("placement_id", ""), "p-1", "the event's placement_id (%s)", e.dump());
  ctx.Equal(e.value("node_id", ""), "gpu-1", "the event's node_id (%s)", e.dump());
  ctx.Equal(e.value("tenant", ""), "acme", "the event's tenant (%s)", e.dump());
  ctx.Equal(e.value("gpu_count", -1), 4, "the event's gpu_count (%s)", e.dump());
  ctx.Equal(e.value("memory_gb", -1.0), 80.0, "the event's memory_gb (%s)", e.dump());
  ctx.Assert(e.contains("ts"), "the event carries no ts: %s", e.dump());
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  eventsWorld(ctx);
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 8, 80), "ALLOCATED", "booking 8");
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-2", "beta", 4, 40), "NO_CAPACITY", "4 GPUs on a full node");
  ctx.Equal(eventsAll(ctx).size(), 1, "a refused placement must produce nothing; the records");
  ctx.Redis.Del("heartbeat:gpu-2");
  ctx.Equal(eventsBook(ctx, "gpu-2", "p-3", "acme", 1, 20), "NO_HEARTBEAT", "a node whose heartbeat lapsed");
  ctx.Equal(eventsAll(ctx).size(), 1, "a placement refused for a lapsed heartbeat must produce nothing; the records");
  ctx.Equal(eventsFolded(ctx, "gpu-1"), eventsAllocated(ctx, "gpu-1"), "the stream folded for gpu-1 against the ledger");
}

void CheckOutboxRelay(harness::Ctx& ctx) {
  eventsWorld(ctx);
  ctx.Kafka.FailNext(kEventsTopic, 1);
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "the booking stands whatever the broker says");
  ctx.Equal(eventsAll(ctx).size(), 0, "the broker refused the record: nothing is on the topic; the records");
  const auto rows = ctx.Redis.LRange(kEventsOutbox, 0, -1);
  ctx.Equal(rows.size(), 1, "a refused delivery must leave one row in %s, found %q (in the delivery report, on error, RPUSH the key and value); the rows", kEventsOutbox, rows);
  const auto row = nlohmann::json::parse(rows[0], nullptr, false);
  ctx.Assert(row.is_object() && row.value("key", "") == "gpu-1" && row.value("value", "").find("p-1") != std::string::npos,
             "the outbox row must hold the key and the value, got %s", rows[0]);
  const int sent = relay_outbox();
  ctx.Settle();
  ctx.Equal(sent, 1, "rows relay_outbox sent");
  const auto all = eventsAll(ctx);
  ctx.Assert(all.size() == 1 && all[0].is_object() && all[0].value("placement_id", "") == "p-1", "after the relay the stream must hold p-1's allocation, got %v", ctx.Kafka.Values(kEventsTopic));
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"gpu-1"}, "the relayed record keeps its node key");
  ctx.Equal(ctx.Redis.LLen(kEventsOutbox), 0, "a relayed row leaves the outbox; rows left");
  ctx.Assert(relay_outbox() == 0 && eventsAll(ctx).size() == 1, "an empty outbox relays nothing");
}

void CheckReleaseReconcile(harness::Ctx& ctx) {
  eventsWorld(ctx);
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-1", "acme", 4, 80), "ALLOCATED", "booking p-1");
  ctx.Equal(eventsBook(ctx, "gpu-1", "p-2", "beta", 2, 40), "ALLOCATED", "booking p-2");
  const bool moved = release_and_publish("gpu-1", "p-1");
  ctx.Settle();
  ctx.Equal(moved, true, "the first release moves the counters");
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 3, "two bookings and one release must produce three records (a release is an event too); the records");
  const nlohmann::json& rel = all[2];
  ctx.Assert(rel.is_object() && rel.value("type", "") == "release" && rel.value("placement_id", "") == "p-1" && rel.value("gpu_count", 0) == 4,
             "the third event must be p-1's release with gpu_count 4, got %s", rel.dump());
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic)[2], "gpu-1", "the release is keyed by the node id too");
  ctx.Assert(eventsFolded(ctx, "gpu-1") == 2 && eventsAllocated(ctx, "gpu-1") == 2, "the stream folds to %d GPUs on gpu-1, the ledger says %d", eventsFolded(ctx, "gpu-1"), eventsAllocated(ctx, "gpu-1"));
  const bool again = release_and_publish("gpu-1", "p-1");
  ctx.Settle();
  ctx.Assert(!again && eventsAll(ctx).size() == 3, "a repeated release moves nothing and produces nothing");
}
`,
  },
  debrief: `The order is ledger, then stream, because the ledger is the truth and the stream is its history: an event for a booking the ledger refused is a lie that every consumer will repeat. Keying by node id puts one node's allocations and releases on one partition in the order they happened, which is the only order in which folding them means anything. The outbox is the answer to a produce the broker refuses: the booking already happened, so the event must happen too, later. Reading the delivery report (the callback in librdkafka and the Java client, the rejected promise in kafkajs, the returned error in kafka-go) is what makes a refusal visible at all. Production systems write the outbox row in the same transaction as the booking and let a relay own every produce, so the request path never talks to Kafka.`,
};
