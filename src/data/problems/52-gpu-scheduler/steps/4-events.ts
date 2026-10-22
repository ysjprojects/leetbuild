import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Placement events keyed by node for utilization replay',
  concept: 'kafka',
  file: 'events',
  focus: ['scheduler', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event on the
happy path and moves a Redis counter right after, so the demo shows \`gpu.placement\` filling up and
the ledger looking busy. Four contracts are broken. Review it like the owner of the stream, fix it,
and prove the fix with the checks below.

\`gpu.placement\` is not telemetry. Every consumer replays it to answer "what is this node running
right now", so the scheduler's publish path is a correctness surface with the same weight as the
counters it mirrors.

- **Key the record by the NODE id.** The message key is the partition key, and partitioning by node
  is what keeps one node's occupancy stream ordered, so a replay sees its allocations and releases
  in the order the scheduler committed them. The draft sends \`key=tenant\`: every node behind a
  tenant is interleaved across partitions and the per-node history is no longer recoverable.
- **Carry what a replay needs.** Each value is \`event_type\` (\`allocation\` / \`release\`) plus
  \`placement_id\`, \`node_id\`, \`gpu_count\` and \`memory_gb\`. Ids and numbers only — the topic is
  retained and replicated, so tenant payloads must never reach it.
- **Commit the ledger first, produce second.** One atomic Lua script per transition moves both
  counters on the server (\`HINCRBY allocated_gpus\` with \`HINCRBY allocated_memory_gb\`), and only
  then does the record reach the broker. Produce first and a crash between the two writes leaves the
  stream claiming GPUs the counters never booked: the replay then over-reports occupancy on a node
  that owes capacity.
- **Never drop a produce.** When the broker rejects the produce, insert an **outbox** row instead of
  swallowing the error; a relay resends the unsent rows under the same node key and marks each row
  sent. The producer is idempotent (\`enable.idempotence\` with \`acks=all\`, KafkaJS
  \`idempotent: true\` with \`acks: -1\`, kafka-go \`RequiredAcks: kafka.RequireAll\` with a
  \`kafka.Hash{}\` balancer), so a resend cannot duplicate a record.
- **Publish releases too, and reconcile.** A release is a first-class event: allocation adds
  \`gpu_count\`, release subtracts it. Fold a node's ordered stream and compare the result with the
  Redis counters that back \`GET /v1/nodes/{id}\`; a stream that only ever allocates drifts upward
  forever and the read path starts promising GPUs that are already in use.

**What each check looks for.**

1. \`node-key\` — the record goes to the topic \`gpu.placement\` and its key is the node id
   (\`key=node_id\` / \`Key: []byte(nodeID)\` / \`ProducerRecord(topic, nodeId, …)\`); the draft's
   tenant key is gone.
2. \`event-fields\` — the payload builder the handlers use emits \`placement_id\`, \`gpu_count\` and
   \`memory_gb\` next to the event type, so a replay can attribute and rebuild occupancy.
3. \`publish-after-commit\` — the atomic counter script runs **before** the produce in the same
   transition, in that order: the ledger is the source of truth and the event replicates it.
4. \`outbox-relay\` — a rejected produce writes an outbox row in the error branch, a relay resends
   unsent rows and marks them sent, and the producer is configured idempotent with \`acks=all\`.
5. \`release-reconcile\` — allocation **and** release events are published, and a reconstruction of a
   node's event stream is compared against that node's Redis counters.

**Failure mode the checks target.** Keying by tenant turns a per-node history into a per-tenant
shuffle; producing before the counter commit invents capacity that was never reserved; a silently
dropped produce loses one node's release and leaks its GPUs out of the pool forever; and a stream
with allocations only can never be reconciled with the ledger it claims to mirror.`,
  sequence: {
    participants: ['GPU Scheduler', 'Redis', 'gpu.placement', 'Utilization consumer', 'placement_outbox'],
    messages: [
      {
        from: 'GPU Scheduler',
        to: 'Redis',
        label: 'host: evalsha ALLOCATE_LUA · HINCRBY allocated_gpus + allocated_memory_gb',
        kind: 'sync',
      },
      {from: 'Redis', to: 'GPU Scheduler', label: 'committed: allocated_gpus', kind: 'reply'},
      {
        from: 'GPU Scheduler',
        to: 'gpu.placement',
        label: 'produce key=node_id · value {event_type: allocation, placement_id, gpu_count, memory_gb}',
        kind: 'async',
      },
      {
        from: 'GPU Scheduler',
        to: 'placement_outbox',
        label: 'insert_outbox(row) when the broker rejects the produce',
        kind: 'async',
      },
      {
        from: 'placement_outbox',
        to: 'gpu.placement',
        label: 'relay_outbox(): resend unsent rows with the same node key, acks=all, then mark_sent',
        kind: 'async',
      },
      {
        from: 'GPU Scheduler',
        to: 'gpu.placement',
        label: 'produce key=node_id · value {event_type: release, placement_id, gpu_count, memory_gb}',
        kind: 'async',
      },
      {from: 'gpu.placement', to: 'Utilization consumer', label: "one node's records, in commit order", kind: 'async'},
      {
        from: 'Utilization consumer',
        to: 'Redis',
        label: 'reconstruct_utilization(events) vs HGET node:{id} allocated_gpus',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'node-key',
      title: 'Publishes to gpu.placement keyed by the node id',
      detail:
        'The record goes to the topic `gpu.placement` and the message key is the **node** id, so one node’s occupancy stream stays ordered in a single partition. The draft uses the tenant as the key, which interleaves every node behind a tenant.',
      match: {
        python: {all: [/PLACEMENT_TOPIC/, /key=body\.node_id/], none: [/key=[^\n]*tenant/]},
        typescript: {all: [/PLACEMENT_TOPIC/, /key:\s*body\.node_id/], none: [/key:\s*tenant/]},
        go: {all: [/placementTopic/, /Key:\s*\[\]byte\(body\.NodeID\)/], none: [/Key:\s*\[\]byte\(tenant\)/]},
        scala: {
          all: [/PlacementTopic/, /ProducerRecord\(PlacementTopic,\s*nodeId/],
          none: [/ProducerRecord\(PlacementTopic,\s*tenant/],
        },
        cpp: {
          all: [/kPlacementTopic/, /nodeId\.data\(\), nodeId\.size\(\)/],
          none: [/tenant\.data\(\), tenant\.size\(\)/],
        },
      },
    },
    {
      id: 'event-fields',
      title: 'The payload carries placement id, gpu count and memory',
      detail:
        'The event builder the handlers publish emits the event type plus `placement_id`, `gpu_count` and `memory_gb` — the ids and numbers a replay needs to attribute occupancy and rebuild it. The draft forwards a bare `{id, tenant, gpus}` blob.',
      match: {
        python: {all: [/def placement_event\(/, /"placement_id"/, /"gpu_count"/, /"memory_gb"/]},
        typescript: {
          all: [/function placementEvent\(/, /\bplacement_id\b/, /\bgpu_count\b/, /\bmemory_gb\b/],
        },
        go: {all: [/func placementEvent\(/, /\bPlacementID\b/, /\bGPUCount\b/, /\bMemoryGB\b/]},
        scala: {all: [/def placementEvent\(/, /"placement_id"/, /"gpu_count"/, /"memory_gb"/]},
        cpp: {all: [/json placementEvent\(/, /"placement_id"/, /"gpu_count"/, /"memory_gb"/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'The counters commit before the event is produced',
      detail:
        'The atomic counter script (`eval` of the allocate script, both `HINCRBY`s together) runs first and the produce follows. Publishing first means a crash between the two leaves the stream claiming capacity the ledger never booked; the draft produces before any counter call.',
      match: {
        python: {order: [/\.eval\(ALLOCATE_LUA/, /producer\.produce\(/]},
        typescript: {order: [/\.eval\(ALLOCATE_LUA/, /producer\.send\(/]},
        go: {order: [/\.Eval\(r\.Context\(\),\s*allocateLua/, /\.WriteMessages\(/]},
        scala: {order: [/\.eval\(AllocateLua/, /producer\.send\(/]},
        cpp: {order: [/eval<std::vector<long long>>\(kAllocateLua/, /produce\(kPlacementTopic/]},
      },
    },
    {
      id: 'outbox-relay',
      title: 'Outbox row on rejection, relayed idempotently',
      detail:
        'A rejected produce writes an outbox row inside the error branch instead of dropping the event; a relay resends the unsent rows and marks them sent, and the producer is idempotent with `acks=all`. The draft ignores the broker result entirely and has no outbox.',
      match: {
        python: {
          all: [
            /insert_outbox\(/,
            /except KafkaException/,
            /relay_outbox\(/,
            /mark_sent\(/,
            /enable\.idempotence/,
            /["']acks["']\s*:\s*["']all["']/,
          ],
        },
        typescript: {
          all: [/insert_outbox\(/, /catch\s*\(/, /relayOutbox\(/, /mark_sent\(/, /idempotent:\s*true/, /acks:\s*-1/],
        },
        go: {
          all: [
            /InsertOutbox\(/,
            /if err != nil/,
            /RelayOutbox\(/,
            /MarkSent\(/,
            /RequiredAcks:\s*kafka\.RequireAll/,
            /Balancer:\s*&kafka\.Hash\{\}/,
          ],
        },
        scala: {
          all: [/insertOutbox\(/, /catch\s*\{/, /relayOutbox\(/, /markSent\(/, /enable\.idempotence/, /"acks"/],
        },
        cpp: {
          all: [
            /insertOutbox\(/,
            /ERR_NO_ERROR/,
            /relayOutbox\(/,
            /markSent\(/,
            /enable\.idempotence/,
            /set\("acks",\s*"all"/,
          ],
        },
      },
    },
    {
      id: 'release-reconcile',
      title: 'Releases are published and the stream reconciles with Redis',
      detail:
        'Both `allocation` and `release` events are produced — with a release subtractive script against the same counters — and a reconstruction helper folds a node’s ordered stream and compares it with the node’s Redis counters. The draft publishes no release at all, so reconstructed utilization only ever grows.',
      match: {
        python: {all: [/EVENT_ALLOCATION/, /EVENT_RELEASE/, /RELEASE_LUA/, /reconstruct_utilization\(/]},
        typescript: {all: [/EVENT_ALLOCATION/, /EVENT_RELEASE/, /RELEASE_LUA/, /reconstructUtilization\(/]},
        go: {all: [/\beventAllocation\b/, /\beventRelease\b/, /\breleaseLua\b/, /ReconstructUtilization\(/]},
        scala: {all: [/EventAllocation/, /EventRelease/, /ReleaseLua/, /reconstructUtilization\(/]},
        cpp: {all: [/kEventAllocation/, /kEventRelease/, /kReleaseLua/, /reconstructUtilization\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("gpusched")

PLACEMENT_TOPIC = "gpu.placement"

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Placement(BaseModel):
    placement_id: str
    node_id: str
    gpu_count: int
    memory_gb: int


@app.post("/v1/placements")
def place(body: Placement, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: the draft keys by tenant, produces the allocation before the counters confirm it,
    # publishes no release event, and has no outbox. Review all four.
    logger.info("place node=%s placement=%s", body.node_id, body.placement_id)
    event = {"id": body.placement_id, "tenant": tenant, "gpus": body.gpu_count}
    producer.produce(PLACEMENT_TOPIC, key=tenant, value=json.dumps(event))
    producer.flush(2.0)
    r.hincrby(f"node:{body.node_id}", "allocated_gpus", body.gpu_count)
    return {"placement_id": body.placement_id, "node_id": body.node_id, "state": "allocated"}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "utilization"})
    consumer.subscribe([PLACEMENT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        json.loads(msg.value())
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

PLACEMENT_TOPIC = "gpu.placement"
EVENT_ALLOCATION = "allocation"
EVENT_RELEASE = "release"

# One script per transition: the gpu and the memory counter always move together, on the server.
ALLOCATE_LUA = """
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', ARGV[2])
return redis.call('HGET', KEYS[1], 'allocated_gpus')
"""

RELEASE_LUA = """
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return redis.call('HGET', KEYS[1], 'allocated_gpus')
"""

producer = Producer(
    {"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"}
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Placement(BaseModel):
    placement_id: str
    node_id: str
    gpu_count: int
    memory_gb: int


class PlacementOutbox:
    def insert_outbox(self, node_id: str, event: dict) -> None:
        """One unsent row per rejected produce; the relay republishes it later."""
        raise NotImplementedError

    def unsent(self) -> list[dict]:
        """Rows the relay has not produced yet, oldest first."""
        raise NotImplementedError

    def mark_sent(self, row_id: str) -> None:
        raise NotImplementedError


outbox = PlacementOutbox()


def node_counters_key(node_id: str) -> str:
    return f"node:{node_id}"


def placement_event(event_type: str, body: Placement) -> dict:
    """Ids and numbers only: a replay attributes and rebuilds occupancy from these."""
    return {
        "event_type": event_type,
        "placement_id": body.placement_id,
        "node_id": body.node_id,
        "gpu_count": body.gpu_count,
        "memory_gb": body.memory_gb,
    }


@app.post("/v1/placements")
def place(body: Placement) -> dict:
    # Commit the ledger first, then replicate it: a rejected produce must never be able to leave
    # the stream claiming GPUs the counters never booked.
    r.eval(ALLOCATE_LUA, 1, node_counters_key(body.node_id), body.gpu_count, body.memory_gb)
    event = placement_event(EVENT_ALLOCATION, body)
    try:
        producer.produce(PLACEMENT_TOPIC, key=body.node_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(body.node_id, event)
    return {"placement_id": body.placement_id, "node_id": body.node_id, "state": "allocated"}


@app.delete("/v1/placements/{placement_id}")
def release(placement_id: str, body: Placement) -> dict:
    # The release is a first-class event: without it a replay of the stream only ever adds.
    r.eval(RELEASE_LUA, 1, node_counters_key(body.node_id), body.gpu_count, body.memory_gb)
    event = placement_event(EVENT_RELEASE, body)
    try:
        producer.produce(PLACEMENT_TOPIC, key=body.node_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(body.node_id, event)
    return {"placement_id": placement_id, "node_id": body.node_id, "state": "released"}


def relay_outbox() -> None:
    """Republishes unsent rows under the same node key, then marks them sent; acks=all makes the
    resend safe to repeat."""
    for row in outbox.unsent():
        producer.produce(PLACEMENT_TOPIC, key=row["node_id"], value=json.dumps(row["event"]))
        producer.flush(2.0)
        outbox.mark_sent(row["id"])


def reconstruct_utilization(events: list[dict]) -> int:
    """Allocations add their gpu count, releases subtract theirs — a node's ordered fold."""
    gpus = 0
    for event in events:
        sign = 1 if event["event_type"] == EVENT_ALLOCATION else -1
        gpus += sign * event["gpu_count"]
    return gpus


def reconcile(node_id: str, events: list[dict]) -> bool:
    counters = r.hgetall(node_counters_key(node_id))
    ledger = int(counters.get("allocated_gpus", 0))
    return reconstruct_utilization(events) == ledger


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "utilization", "enable.auto.commit": False}
    )
    consumer.subscribe([PLACEMENT_TOPIC])
    seen: dict[str, list[dict]] = {}
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        seen.setdefault(event["node_id"], []).append(event)
        if not reconcile(event["node_id"], seen[event["node_id"]]):
            continue  # stream and ledger disagree: replay the record instead of committing a lie
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** gpu.placement: a model-generated draft that keys by tenant and produces before the counters. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'gpusched', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

const PLACEMENT_TOPIC = 'gpu.placement';

interface PlacementBody {
  placement_id: string;
  node_id: string;
  gpu_count: number;
  memory_gb: number;
}

app.post('/v1/placements', async (request, reply) => {
  // TODO: the draft keys by tenant, produces the allocation before the counters confirm it,
  // publishes no release event, and has no outbox. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as PlacementBody;
  const event = {id: body.placement_id, tenant, gpus: body.gpu_count};
  await producer.send({topic: PLACEMENT_TOPIC, messages: [{key: tenant, value: JSON.stringify(event)}]});
  await r.hincrby('node:' + body.node_id, 'allocated_gpus', body.gpu_count);
  return reply.code(201).send({placement_id: body.placement_id, state: 'allocated'});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'utilization'});
  await consumer.connect();
  await consumer.subscribe({topic: PLACEMENT_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      JSON.parse(message.value?.toString() ?? '{}');
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** gpu.placement: node-keyed allocation and release events, committed after the ledger. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'gpusched', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

const PLACEMENT_TOPIC = 'gpu.placement';
const EVENT_ALLOCATION = 'allocation';
const EVENT_RELEASE = 'release';

const ALLOCATE_LUA = \`
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', ARGV[2])
return redis.call('HGET', KEYS[1], 'allocated_gpus')
\`;

const RELEASE_LUA = \`
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return redis.call('HGET', KEYS[1], 'allocated_gpus')
\`;

interface PlacementBody {
  placement_id: string;
  node_id: string;
  gpu_count: number;
  memory_gb: number;
}

interface PlacementEvent {
  event_type: string;
  placement_id: string;
  node_id: string;
  gpu_count: number;
  memory_gb: number;
}

class PlacementOutbox {
  async insert_outbox(node_id: string, event: PlacementEvent): Promise<void> {
    throw new Error('one unsent row per rejected produce');
  }
  async unsent(): Promise<Array<{id: string; node_id: string; event: PlacementEvent}>> {
    throw new Error('rows the relay has not produced yet, oldest first');
  }
  async mark_sent(row_id: string): Promise<void> {
    throw new Error('flip the row to sent once acks=all confirms it');
  }
}

const outbox = new PlacementOutbox();

function placementEvent(eventType: string, placementId: string, nodeId: string, gpuCount: number, memoryGb: number): PlacementEvent {
  return {
    event_type: eventType,
    placement_id: placementId,
    node_id: nodeId,
    gpu_count: gpuCount,
    memory_gb: memoryGb,
  };
}

app.post('/v1/placements', async (request, reply) => {
  const body = request.body as PlacementBody;
  // The ledger commits first and the event replicates it: produce first and a crash between the
  // two writes leaves the stream claiming capacity the counters never booked.
  await r.eval(ALLOCATE_LUA, 1, 'node:' + body.node_id, body.gpu_count, body.memory_gb);
  const event = placementEvent(EVENT_ALLOCATION, body.placement_id, body.node_id, body.gpu_count, body.memory_gb);
  try {
    await producer.send({
      topic: PLACEMENT_TOPIC,
      acks: -1,
      messages: [{key: body.node_id, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.insert_outbox(body.node_id, event);
  }
  return reply.code(201).send({placement_id: body.placement_id, node_id: body.node_id, state: 'allocated'});
});

app.delete('/v1/placements/:placement_id', async (request, reply) => {
  const body = request.body as PlacementBody;
  const {placement_id} = request.params as {placement_id: string};
  // A release is a first-class event: without it a replay of the stream only ever adds.
  await r.eval(RELEASE_LUA, 1, 'node:' + body.node_id, body.gpu_count, body.memory_gb);
  const event = placementEvent(EVENT_RELEASE, placement_id, body.node_id, body.gpu_count, body.memory_gb);
  try {
    await producer.send({
      topic: PLACEMENT_TOPIC,
      acks: -1,
      messages: [{key: body.node_id, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await outbox.insert_outbox(body.node_id, event);
  }
  return reply.code(200).send({placement_id, node_id: body.node_id, state: 'released'});
});

export async function relayOutbox(): Promise<void> {
  for (const row of await outbox.unsent()) {
    await producer.send({
      topic: PLACEMENT_TOPIC,
      acks: -1,
      messages: [{key: row.node_id, value: JSON.stringify(row.event)}],
    });
    await outbox.mark_sent(row.id);
  }
}

/** Allocations add their gpu count, releases subtract theirs — a node's ordered fold. */
export function reconstructUtilization(events: PlacementEvent[]): number {
  let gpus = 0;
  for (const event of events) gpus += (event.event_type === EVENT_ALLOCATION ? 1 : -1) * event.gpu_count;
  return gpus;
}

export async function reconcile(nodeId: string, events: PlacementEvent[]): Promise<boolean> {
  const ledger = Number((await r.hget('node:' + nodeId, 'allocated_gpus')) ?? 0);
  return reconstructUtilization(events) === ledger;
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'utilization'});
  await consumer.connect();
  await consumer.subscribe({topic: PLACEMENT_TOPIC});
  const seen: Record<string, PlacementEvent[]> = {};
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as PlacementEvent;
      (seen[event.node_id] ??= []).push(event);
      if (!(await reconcile(event.node_id, seen[event.node_id]))) return; // do not commit a lie
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

const placementTopic = "gpu.placement"

var (
	placementWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: placementTopic}
	rdb             *redis.Client
)

type Placement struct {
	PlacementID string \`json:"placement_id"\`
	NodeID      string \`json:"node_id"\`
	GPUCount    int    \`json:"gpu_count"\`
	MemoryGB    int    \`json:"memory_gb"\`
}

func place(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	body := Placement{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: the draft keys by tenant, produces the allocation before the counters confirm it,
	// publishes no release event, and has no outbox. Review all four.
	log.Printf("place node=%s placement=%s", body.NodeID, body.PlacementID)
	event := map[string]any{"id": body.PlacementID, "tenant": tenant, "gpus": body.GPUCount}
	payload, _ := json.Marshal(event)
	_ = placementWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(tenant), Value: payload})
	rdb.HIncrBy(r.Context(), "node:"+body.NodeID, "allocated_gpus", int64(body.GPUCount))
	rw.WriteHeader(http.StatusCreated)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   placementTopic,
		GroupID: "utilization",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		_, _ = msg.Value, json.Valid(msg.Value)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/placements", place)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const placementTopic = "gpu.placement"

const (
	eventAllocation = "allocation"
	eventRelease    = "release"
)

// RequireAll plus a hash balancer makes the writer retry-safe: a record is acknowledged only once
// it is replicated, and a resend of the same node key lands on the same partition.
var placementWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        placementTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var rdb *redis.Client

const allocateLua = \`
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', ARGV[2])
return redis.call('HGET', KEYS[1], 'allocated_gpus')
\`

const releaseLua = \`
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return redis.call('HGET', KEYS[1], 'allocated_gpus')
\`

type Placement struct {
	PlacementID string \`json:"placement_id"\`
	NodeID      string \`json:"node_id"\`
	GPUCount    int    \`json:"gpu_count"\`
	MemoryGB    int    \`json:"memory_gb"\`
}

type PlacementOutbox struct{}

func (o *PlacementOutbox) InsertOutbox(ctx context.Context, nodeID string, event map[string]any) error {
	return nil
}

func (o *PlacementOutbox) Unsent(ctx context.Context) ([]map[string]any, error) {
	return nil, nil
}

func (o *PlacementOutbox) MarkSent(ctx context.Context, rowID string) error {
	return nil
}

var outbox = &PlacementOutbox{}

func placementEvent(eventType string, body Placement) map[string]any {
	return map[string]any{
		"event_type":   eventType,
		"placement_id": body.PlacementID,
		"node_id":      body.NodeID,
		"gpu_count":    body.GPUCount,
		"memory_gb":    body.MemoryGB,
	}
}

func place(rw http.ResponseWriter, r *http.Request) {
	body := Placement{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// The ledger commits first; the event replicates it, never the other way round.
	rdb.Eval(r.Context(), allocateLua, []string{"node:" + body.NodeID}, body.GPUCount, body.MemoryGB)
	event := placementEvent(eventAllocation, body)
	payload, _ := json.Marshal(event)
	if err := placementWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.NodeID), Value: payload}); err != nil {
		_ = outbox.InsertOutbox(r.Context(), body.NodeID, event)
	}
	rw.WriteHeader(http.StatusCreated)
}

func release(rw http.ResponseWriter, r *http.Request) {
	body := Placement{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	rdb.Eval(r.Context(), releaseLua, []string{"node:" + body.NodeID}, body.GPUCount, body.MemoryGB)
	event := placementEvent(eventRelease, body)
	payload, _ := json.Marshal(event)
	if err := placementWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.NodeID), Value: payload}); err != nil {
		_ = outbox.InsertOutbox(r.Context(), body.NodeID, event)
	}
	rw.WriteHeader(http.StatusOK)
}

func RelayOutbox(ctx context.Context) {
	rows, _ := outbox.Unsent(ctx)
	for _, row := range rows {
		payload, _ := json.Marshal(row["event"])
		nodeID, _ := row["node_id"].(string)
		_ = placementWriter.WriteMessages(ctx, kafka.Message{Key: []byte(nodeID), Value: payload})
		_ = outbox.MarkSent(ctx, row["id"].(string))
	}
}

// ReconstructUtilization folds a node's ordered stream into occupied GPUs: allocations add,
// releases subtract.
func ReconstructUtilization(events []map[string]any) int {
	gpus := 0
	for _, event := range events {
		sign := 1
		if event["event_type"] == eventRelease {
			sign = -1
		}
		gpus += sign * int(event["gpu_count"].(float64))
	}
	return gpus
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   placementTopic,
		GroupID: "utilization",
	})
	seen := map[string][]map[string]any{}
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event map[string]any
		_ = json.Unmarshal(msg.Value, &event)
		nodeID, _ := event["node_id"].(string)
		seen[nodeID] = append(seen[nodeID], event)
		ledger, _ := rdb.HGet(ctx, "node:"+nodeID, "allocated_gpus").Int()
		if ReconstructUtilization(seen[nodeID]) != ledger {
			continue // stream and ledger disagree: replay the record instead of committing a lie
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/placements", place)
	mux.HandleFunc("DELETE /v1/placements/{id}", release)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object PlacementEvents {
  private val log = Logger.getLogger("gpusched")
  val PlacementTopic = "gpu.placement"
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: the draft keys by tenant, produces the allocation before the counters confirm it,
  // publishes no release event, and has no outbox. Review all four.
  def place(placementId: String, tenant: String, nodeId: String, gpuCount: Int): Unit = {
    log.info(s"place node=$nodeId placement=$placementId")
    val payload = Map("id" -> placementId, "tenant" -> tenant, "gpus" -> gpuCount).toJson.compactPrint
    producer.send(new ProducerRecord(PlacementTopic, tenant, payload))
    jedis.hincrBy(s"node:$nodeId", "allocated_gpus", gpuCount.toLong)
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(PlacementTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        record.value().parseJson
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object PlacementEvents {
  val PlacementTopic = "gpu.placement"
  val EventAllocation = "allocation"
  val EventRelease = "release"

  // One script per transition: both counters move together, on the server.
  val AllocateLua: String =
    """redis.call('HINCRBY', KEYS[1], 'allocated_gpus', ARGV[1])
      |redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', ARGV[2])
      |return redis.call('HGET', KEYS[1], 'allocated_gpus')""".stripMargin

  val ReleaseLua: String =
    """redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
      |redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
      |return redis.call('HGET', KEYS[1], 'allocated_gpus')""".stripMargin

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def placementEvent(eventType: String, placementId: String, nodeId: String, gpuCount: Int, memoryGb: Int): String =
    Map(
      "event_type" -> eventType,
      "placement_id" -> placementId,
      "node_id" -> nodeId,
      "gpu_count" -> gpuCount,
      "memory_gb" -> memoryGb
    ).toJson.compactPrint

  def place(placementId: String, nodeId: String, gpuCount: Int, memoryGb: Int): Unit = {
    // The ledger commits first; the event replicates it, never the other way round.
    jedis.eval(AllocateLua, java.util.List.of(s"node:$nodeId"), java.util.List.of(gpuCount.toString, memoryGb.toString))
    val payload = placementEvent(EventAllocation, placementId, nodeId, gpuCount, memoryGb)
    try {
      producer.send(new ProducerRecord(PlacementTopic, nodeId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException => PlacementOutbox.insertOutbox(nodeId, payload)
    }
  }

  def release(placementId: String, nodeId: String, gpuCount: Int, memoryGb: Int): Unit = {
    // A release is a first-class event: without it a replay of the stream only ever adds.
    jedis.eval(ReleaseLua, java.util.List.of(s"node:$nodeId"), java.util.List.of(gpuCount.toString, memoryGb.toString))
    val payload = placementEvent(EventRelease, placementId, nodeId, gpuCount, memoryGb)
    try {
      producer.send(new ProducerRecord(PlacementTopic, nodeId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException => PlacementOutbox.insertOutbox(nodeId, payload)
    }
  }

  def relayOutbox(): Unit =
    PlacementOutbox.unsent().foreach { case (rowId, nodeId, payload) =>
      producer.send(new ProducerRecord(PlacementTopic, nodeId, payload))
      PlacementOutbox.markSent(rowId)
    }

  /** Allocations add their gpu count, releases subtract theirs — a node's ordered fold. */
  def reconstructUtilization(events: Seq[JsObject]): Long =
    events.foldLeft(0L) { (acc, event) =>
      val released = event.fields("event_type").convertTo[String] == EventRelease
      acc + (if (released) -1L else 1L) * event.fields("gpu_count").convertTo[Long]
    }

  def reconcile(nodeId: String, events: Seq[JsObject]): Boolean = {
    val ledger = Option(jedis.hget(s"node:$nodeId", "allocated_gpus")).map(_.toLong).getOrElse(0L)
    reconstructUtilization(events) == ledger
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "utilization")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(PlacementTopic))
    val seen = scala.collection.mutable.Map.empty[String, Seq[JsObject]]
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject
        val nodeId = event.fields("node_id").convertTo[String]
        seen(nodeId) = seen.getOrElse(nodeId, Seq.empty) :+ event
        if (reconcile(nodeId, seen(nodeId))) consumer.commitSync()
        // otherwise leave the offset: the record replays instead of committing a lie
      }
    }
  }
}

object PlacementOutbox {
  def insertOutbox(nodeId: String, payload: String): Unit = ()
  def unsent(): Seq[(String, String, String)] = Seq.empty
  def markSent(rowId: String): Unit = ()
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

const std::string kPlacementTopic = "gpu.placement";

std::unique_ptr<RdKafka::Producer> producer = nullptr;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// TODO: the draft keys by tenant, produces the allocation before the counters confirm it, publishes
// no release event, and has no outbox. Review all four.
json draftEvent(const std::string& placementId, const std::string& tenant, int gpuCount) {
  return json{{"id", placementId}, {"tenant", tenant}, {"gpus", gpuCount}};
}

void place(const std::string& placementId, const std::string& tenant, const std::string& nodeId, int gpuCount) {
  const auto payload = draftEvent(placementId, tenant, gpuCount).dump();
  producer->produce(kPlacementTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), tenant.data(), tenant.size(), 0, nullptr);
  producer->flush(2000);
  redis->hincrby("node:" + nodeId, "allocated_gpus", gpuCount);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kPlacementTopic = "gpu.placement";
const std::string kEventAllocation = "allocation";
const std::string kEventRelease = "release";

// One script per transition: both counters move together, on the server.
const std::string kAllocateLua =
    "redis.call('HINCRBY', KEYS[1], 'allocated_gpus', ARGV[1])\\n"
    "redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', ARGV[2])\\n"
    "return redis.call('HGET', KEYS[1], 'allocated_gpus')";

const std::string kReleaseLua =
    "redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))\\n"
    "redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))\\n"
    "return redis.call('HGET', KEYS[1], 'allocated_gpus')";

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

struct PlacementOutbox {
  void insertOutbox(const std::string& nodeId, const json& event);
  std::vector<std::pair<std::string, json>> unsent();
  void markSent(const std::string& rowId);
};

PlacementOutbox outbox;

json placementEvent(const std::string& eventType, const std::string& placementId, const std::string& nodeId,
                    int gpuCount, int memoryGb) {
  return json{{"event_type", eventType}, {"placement_id", placementId}, {"node_id", nodeId},
              {"gpu_count", gpuCount}, {"memory_gb", memoryGb}};
}

void place(const std::string& placementId, const std::string& nodeId, int gpuCount, int memoryGb) {
  // The ledger commits first; the event replicates it, never the other way round.
  redis->eval<std::vector<long long>>(kAllocateLua, {"node:" + nodeId}, {gpuCount, memoryGb});
  const json event = placementEvent(kEventAllocation, placementId, nodeId, gpuCount, memoryGb);
  const auto payload = event.dump();
  const auto err = producer->produce(kPlacementTopic, RdKafka::Topic::PARTITION_UA,
                                     RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                     payload.size(), nodeId.data(), nodeId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(nodeId, event);
  }
  producer->flush(2000);
}

void release(const std::string& placementId, const std::string& nodeId, int gpuCount, int memoryGb) {
  // A release is a first-class event: without it a replay of the stream only ever adds.
  redis->eval<std::vector<long long>>(kReleaseLua, {"node:" + nodeId}, {gpuCount, memoryGb});
  const json event = placementEvent(kEventRelease, placementId, nodeId, gpuCount, memoryGb);
  const auto payload = event.dump();
  const auto err = producer->produce(kPlacementTopic, RdKafka::Topic::PARTITION_UA,
                                     RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                     payload.size(), nodeId.data(), nodeId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(nodeId, event);
  }
  producer->flush(2000);
}

void relayOutbox() {
  for (const auto& row : outbox.unsent()) {
    const json& event = row.second;
    const auto payload = event.dump();
    const auto nodeId = event["node_id"].get<std::string>();
    producer->produce(kPlacementTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(payload.data()), payload.size(), nodeId.data(), nodeId.size(), 0, nullptr);
    producer->flush(2000);
    outbox.markSent(row.first);
  }
}

/** Allocations add their gpu count, releases subtract theirs — a node's ordered fold. */
long long reconstructUtilization(const std::vector<json>& events) {
  long long gpus = 0;
  for (const auto& event : events) {
    const bool released = event["event_type"].get<std::string>() == kEventRelease;
    gpus += (released ? -1 : 1) * event["gpu_count"].get<long long>();
  }
  return gpus;
}

bool reconcile(const std::string& nodeId, const std::vector<json>& events) {
  const auto ledger = redis->hget("node:" + nodeId, "allocated_gpus");
  const long long allocated = ledger ? std::stoll(*ledger) : 0;
  return reconstructUtilization(events) == allocated;
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kPlacementTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto raw = static_cast<const char*>(msg->payload());
    const json event = json::parse(raw, raw + msg->len());
    const auto nodeId = event["node_id"].get<std::string>();
    if (!reconcile(nodeId, {event})) continue;  // do not commit a record the ledger disagrees with
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  hints: [
    'The message key is the partition key: key by the node id and one node’s allocations and releases stay in one partition in commit order. Key by the tenant and every node behind that tenant is interleaved, so a replay cannot rebuild a single node’s occupancy. The draft also never publishes the release that would end the interval.',
    'Order between the two writes is the contract: the counter script (`EVAL` of the allocate/release Lua that moves `allocated_gpus` and `allocated_memory_gb` together) runs before the produce. Produce first and a crash in between gives you a stream that claims GPUs the ledger never booked — and the read path then promises capacity that does not exist.',
    'Durability is an outbox plus an idempotent producer: `enable.idempotence` with `acks=all` (`idempotent: true` + `acks: -1` in KafkaJS, `RequireAll` + a hash balancer in kafka-go) makes a resend safe, so when the produce fails you can insert an outbox row, have the relay resend it under the same node key, and only then mark the row sent. Finish with `reconstruct_utilization`: fold the node’s ordered events, subtract releases, and compare with `HGET node:{id} allocated_gpus`.',
  ],
  debrief: `The interviewer is checking whether you treat an event stream as a replica of state rather than as logging. Four decisions carry the whole step. The key is an ordering contract: partition by node and a node’s allocation and release history is replayable; partition by tenant and one node’s stream is scattered, so every reconstruction is a guess. The order of the two writes decides what a crash can mean: committing the Redis counters first makes the ledger the source of truth and the event its replication, so a failed produce is a delayed record, not a lie about capacity. The outbox is what turns that failure into durability — a row written in the error branch, resent by a relay under the same node key, marked sent only after an idempotent producer (\`enable.idempotence\`, \`acks=all\`) confirms it, so a retry cannot duplicate a record. And the release event is the half everyone omits: a stream that only records allocations produces a utilization curve that rises forever, which is exactly what a reviewer catches by reconstructing a node’s number from the events and comparing it with the counters the read path uses. Real systems add schema-registry validation, a per-node partition budget, dead-letter topics for permanently unprocessable events, and a reconciliation job that alarms when the reconstructed and ledger numbers diverge.`,
};
