import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Shard events on batch.shard and a coordinator that folds once',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'store', 'kafka', 'coordinator', 'redis'],
  task: `## Task

**Starting point.** The starter is the shard stream. \`publish_shard(result)\` takes the step-3
\`ShardResult\`, produces a \`batch.shard\` event \`{batch_id, shard_id, model, completed, failed}\` keyed by
\`"{batch_id}:{shard_id}"\` inside a \`try\` that writes an outbox row on an exception, then writes the
output object with \`outputs.write\`. The coordinator's \`consume_shards\` commits each record and then
calls \`fold_shard(event)\`, which \`HSET\`s the entry into \`batch:outputs:{id}\` and \`HINCRBY\`s
\`batch:totals:{id}\`. The demo's totals add up. It hides 5 flaws.

**Failure mode the checks target.** An event announces state that has to exist already: one that lands
before its object leads the coordinator to a missing file, one that never lands (the broker refused it,
and the refusal arrives later) leaves a finished shard out of the batch, and a key per shard spreads one
batch over partitions. On the consuming side a commit before the fold loses a shard to a crash, and a
replay counts it twice.

Requirements:

- Write the output object first; the event carries its \`output_uri\` and \`checksum\` beside the ids and
  counts, and is keyed by \`batch_id\`.
- A produce the broker refuses goes to \`outbox.insert(event)\` from the **delivery report** (callback,
  rejected \`send\`, returned write error); \`publish_shard\` does not raise.
- \`fold_shard\` is one Lua script: \`HSETNX\` the entry \`{uri, checksum, completed, failed}\`, and only
  when it was new, \`HINCRBY\` the totals.
- The coordinator folds, then commits.`,
  sequence: {
    participants: ['Worker', 'Object store', 'batch.shard', 'Coordinator', 'Redis'],
    messages: [
      {from: 'Worker', to: 'Object store', label: 'outputs.write(result) → {uri, checksum}', kind: 'sync'},
      {
        from: 'Worker',
        to: 'batch.shard',
        label: 'produce key=batch_id {shard_id, counts, output_uri, checksum}',
        kind: 'async',
      },
      {from: 'batch.shard', to: 'Worker', label: 'delivery report: refused → outbox.insert(event)', kind: 'reply'},
      {from: 'batch.shard', to: 'Coordinator', label: 'consume · group batch-coordinator', kind: 'async'},
      {from: 'Coordinator', to: 'Redis', label: 'EVALSHA fold · HSETNX outputs · HINCRBY totals', kind: 'sync'},
      {from: 'Coordinator', to: 'batch.shard', label: 'commit offset', kind: 'sync'},
    ],
  },
  hints: [
    "Symptom: one batch's shards reach the coordinator out of order, an event names an output not yet stored, a broker hiccup loses a finished shard, and after a coordinator restart the batch counts more records than it has.",
    'Mechanism: the key is per shard; the produce runs before `outputs.write`, so there is no checksum to send; a refusal arrives in the delivery report, not as an exception from `produce`; the loop commits before folding, and `HINCRBY` counts every replay.',
    'Change: `outputs.write` first and put `output_uri` and `checksum` in the event; `key=result.batch_id`; an `on_delivery` callback that calls `outbox.insert(event)` on error; `fold_shard` as a script with `HSETNX` guarding the `HINCRBY`s; fold, then `commit`.',
  ],
  checks: [
    {
      id: 'batch-key',
      title: 'Keys shard events by batch id',
      detail:
        'Three shards of batch b1 produce three records keyed b1 on one partition; another batch gets its own key. The starter keys by batch and shard, so one batch spreads over partitions in no order.',
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*result\.batch_id\b/], none: [/key\s*=\s*f["']/]},
        typescript: {all: [/key:\s*result\.batch_id\b/], none: [/key:\s*`/]},
        go: {all: [/Key:\s*\[\]byte\(\s*result\.BatchID\s*\)/], none: [/Key:\s*\[\]byte\(\s*fmt\.Sprintf/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*result\.batch_id\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*s"/],
        },
        cpp: {all: [/produce\([\s\S]{0,400}?result\.batch_id\.(c_str|data)\(\)/], none: [/batch_id\s*\+\s*":"/]},
      },
    },
    {
      id: 'output-before-event',
      title: 'Writes the output object before the event',
      detail:
        'When the output object is written the topic does not hold its event yet, and the event carries output_uri and the SHA-256 checksum of the stored bytes, with the ids and counts. The starter produces first, without either.',
      match: {
        python: {order: [/outputs\.write\(/, /producer\.produce\(/], all: [/checksum/]},
        typescript: {order: [/outputs\.write\(/, /producer\.send\(/], all: [/checksum/]},
        go: {order: [/outputs\.Write\(/, /WriteMessages\(/], all: [/Checksum/]},
        scala: {order: [/Outputs\.write\(/, /producer\.send\(/], all: [/checksum/]},
        cpp: {order: [/outputs::write\(/, /producer->produce\(/], all: [/checksum/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes an outbox row from the delivery report',
      detail:
        'A produce the broker refuses puts the event in the outbox, handled where the broker answers (the delivery callback, the rejected send, the returned write error); publish_shard does not raise, and a healthy produce afterwards adds no row. The starter only catches errors the local enqueue throws, and the refusal arrives later.',
      match: {
        python: {all: [/on_delivery\s*=|callback\s*=/, /outbox\.insert\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/outbox\.insert\(/, /await\s+producer\.send\(/], none: [/void\s+producer\.send\(/]},
        go: {all: [/outbox\.Insert\(/, /err\s*:?=\s*writer\.WriteMessages\(/], none: [/Async:\s*true/]},
        scala: {all: [/Outbox\.insert\(/, /exception != null/], none: [/case\s+\w+:\s*KafkaException/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/]},
      },
    },
    {
      id: 'fold-before-commit',
      title: 'Folds a shard before committing its offset',
      detail:
        "At the coordinator's first commit, batch:outputs already holds the shard that record carried, with its uri and checksum; after the drain both shards are folded and nothing is left uncommitted. The starter commits first, so a crash between the two loses the shard.",
      match: {
        python: {order: [/fold_shard\(\s*json\.loads/, /consumer\.commit\(/]},
        typescript: {order: [/foldShard\(\s*JSON\.parse/, /commitOffsets\(/]},
        go: {order: [/:?=\s*foldShard\(/, /CommitMessages\(/]},
        scala: {order: [/foldShard\(\s*ujson\.read/, /\bcommit\(record\)/]},
        cpp: {order: [/fold_shard\(\s*json::parse/, /commitSync\(/]},
      },
    },
    {
      id: 'fold-once',
      title: 'Folds a replayed shard once',
      detail:
        'The same shard event twice on the topic (a replay after a crash before the commit) leaves one entry and totals counted once: two shards of 2 completed and 1 failed records each are completed 4, failed 2. The starter adds the counts on every delivery.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HSETNX['"]|\.hsetnx\(/]},
        typescript: {all: [/redis\.call\(\s*['"]HSETNX['"]|\.hsetnx\(/]},
        go: {all: [/redis\.call\(\s*['"]HSETNX['"]|\.HSetNX\(/]},
        scala: {all: [/redis\.call\(\s*['"]HSETNX['"]|\.hsetnx\(/]},
        cpp: {all: [/redis\.call\(\s*['"]HSETNX['"]|\.hsetnx\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, KafkaException, Producer

from batch import outbox, outputs
from batch.config import GROUP, TOPIC, outputs_key, totals_key
from batch.records import ShardResult

logger = logging.getLogger("batch.events")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_shard(result: ShardResult) -> None:
    """Announce a finished shard on batch.shard, with its output object written."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {
        "batch_id": result.batch_id,
        "shard_id": result.shard_id,
        "model": result.model,
        "completed": result.completed,
        "failed": result.failed,
    }
    try:
        producer.produce(TOPIC, key=f"{result.batch_id}:{result.shard_id}", value=json.dumps(event))
        producer.poll(0)
    except KafkaException as err:
        outbox.insert(event)
        logger.warning("batch.shard produce failed for %s/%d: %s", result.batch_id, result.shard_id, err)
    obj = outputs.write(result)
    logger.info("shard %s/%d written to %s", result.batch_id, result.shard_id, obj["uri"])


def fold_shard(event: dict) -> bool:
    """Fold one shard event into the batch's outputs and totals; False when the shard was folded already."""
    entry = {"uri": event.get("output_uri", ""), "checksum": event.get("checksum", ""), "completed": event["completed"], "failed": event["failed"]}
    r.hset(outputs_key(event["batch_id"]), str(event["shard_id"]), json.dumps(entry))
    r.hincrby(totals_key(event["batch_id"]), "completed", event["completed"])
    r.hincrby(totals_key(event["batch_id"]), "failed", event["failed"])
    return True


def consume_shards() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            logger.error("consumer error: %s", msg.error())
            continue
        consumer.commit(message=msg, asynchronous=False)
        fold_shard(json.loads(msg.value()))
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer

from batch import outbox, outputs
from batch.config import GROUP, TOPIC, outputs_key, totals_key
from batch.records import ShardResult

logger = logging.getLogger("batch.events")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})

FOLD = """
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[2], 'completed', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'failed', ARGV[4])
return 1
"""

fold = r.register_script(FOLD)


def publish_shard(result: ShardResult) -> None:
    """Announce a finished shard on batch.shard, with its output object written."""
    obj = outputs.write(result)
    event = {
        "batch_id": result.batch_id,
        "shard_id": result.shard_id,
        "model": result.model,
        "completed": result.completed,
        "failed": result.failed,
        "output_uri": obj["uri"],
        "checksum": obj["checksum"],
    }

    def on_delivery(err, msg) -> None:
        if err is not None:
            outbox.insert(event)  # the broker said no: the relay republishes it later
            logger.warning("batch.shard produce failed for %s/%d: %s", result.batch_id, result.shard_id, err)

    producer.produce(TOPIC, key=result.batch_id, value=json.dumps(event), on_delivery=on_delivery)
    producer.poll(0)  # serve delivery reports already in; returns at once


def fold_shard(event: dict) -> bool:
    """Fold one shard event into the batch's outputs and totals; False when the shard was folded already."""
    entry = {"uri": event["output_uri"], "checksum": event["checksum"], "completed": event["completed"], "failed": event["failed"]}
    added = fold(
        keys=[outputs_key(event["batch_id"]), totals_key(event["batch_id"])],
        args=[str(event["shard_id"]), json.dumps(entry), event["completed"], event["failed"]],
    )
    return added == 1


def consume_shards() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            logger.error("consumer error: %s", msg.error())
            continue
        fold_shard(json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {GROUP, TOPIC, outputsKey, totalsKey} from 'batch/config';
import {outbox} from 'batch/outbox';
import {outputs} from 'batch/outputs';
import type {ShardResult} from 'batch/records';

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'batchd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

export interface ShardEvent {
  batch_id: string;
  shard_id: number;
  model: string;
  completed: number;
  failed: number;
  output_uri?: string;
  checksum?: string;
}

/** Announce a finished shard on batch.shard, with its output object written. */
export async function publishShard(result: ShardResult): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const event: ShardEvent = {
    batch_id: result.batch_id,
    shard_id: result.shard_id,
    model: result.model,
    completed: result.completed,
    failed: result.failed,
  };
  try {
    void producer.send({topic: TOPIC, messages: [{key: \`\${result.batch_id}:\${result.shard_id}\`, value: JSON.stringify(event)}]});
  } catch (err) {
    await outbox.insert(event);
    console.warn(\`batch.shard produce failed for \${result.batch_id}/\${result.shard_id}: \${(err as Error).message}\`);
  }
  const obj = await outputs.write(result);
  console.log(\`shard \${result.batch_id}/\${result.shard_id} written to \${obj.uri}\`);
}

/** Fold one shard event into the batch's outputs and totals; false when the shard was folded already. */
export async function foldShard(event: ShardEvent): Promise<boolean> {
  const entry = {uri: event.output_uri ?? '', checksum: event.checksum ?? '', completed: event.completed, failed: event.failed};
  await redis.hset(outputsKey(event.batch_id), String(event.shard_id), JSON.stringify(entry));
  await redis.hincrby(totalsKey(event.batch_id), 'completed', event.completed);
  await redis.hincrby(totalsKey(event.batch_id), 'failed', event.failed);
  return true;
}

export async function consumeShards(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await foldShard(JSON.parse(String(message.value)) as ShardEvent);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {GROUP, TOPIC, outputsKey, totalsKey} from 'batch/config';
import {outbox} from 'batch/outbox';
import {outputs} from 'batch/outputs';
import type {ShardResult} from 'batch/records';

const FOLD = \`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[2], 'completed', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'failed', ARGV[4])
return 1
\`;

interface FoldRedis extends Redis {
  fold(outputs: string, totals: string, shard: string, entry: string, completed: number, failed: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as FoldRedis;
redis.defineCommand('fold', {numberOfKeys: 2, lua: FOLD});

const kafka = new Kafka({clientId: 'batchd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

export interface ShardEvent {
  batch_id: string;
  shard_id: number;
  model: string;
  completed: number;
  failed: number;
  output_uri: string;
  checksum: string;
}

/** Announce a finished shard on batch.shard, with its output object written. */
export async function publishShard(result: ShardResult): Promise<void> {
  const obj = await outputs.write(result);
  const event: ShardEvent = {
    batch_id: result.batch_id,
    shard_id: result.shard_id,
    model: result.model,
    completed: result.completed,
    failed: result.failed,
    output_uri: obj.uri,
    checksum: obj.checksum,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: result.batch_id, value: JSON.stringify(event)}], acks: -1});
  } catch (err) {
    await outbox.insert(event); // the broker said no: the relay republishes it later
    console.warn(\`batch.shard produce failed for \${result.batch_id}/\${result.shard_id}: \${(err as Error).message}\`);
  }
}

/** Fold one shard event into the batch's outputs and totals; false when the shard was folded already. */
export async function foldShard(event: ShardEvent): Promise<boolean> {
  const entry = {uri: event.output_uri, checksum: event.checksum, completed: event.completed, failed: event.failed};
  const added = await redis.fold(outputsKey(event.batch_id), totalsKey(event.batch_id), String(event.shard_id), JSON.stringify(entry), event.completed, event.failed);
  return added === 1;
}

export async function consumeShards(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await foldShard(JSON.parse(String(message.value)) as ShardEvent);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"batch/config"  // config.Topic, config.Group, config.OutputsKey, config.TotalsKey — provided
	"batch/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"batch/outputs" // outputs.Write(ctx, result) → outputs.Object{URI, Checksum} — provided
	"batch/records" // records.ShardResult — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	Async:        true,
}

// shardEvent is one finished shard on batch.shard.
type shardEvent struct {
	BatchID   string \`json:"batch_id"\`
	ShardID   int    \`json:"shard_id"\`
	Model     string \`json:"model"\`
	Completed int    \`json:"completed"\`
	Failed    int    \`json:"failed"\`
	OutputURI string \`json:"output_uri,omitempty"\`
	Checksum  string \`json:"checksum,omitempty"\`
}

// publishShard announces a finished shard on batch.shard, with its output object written.
func publishShard(ctx context.Context, result records.ShardResult) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	event, _ := json.Marshal(shardEvent{BatchID: result.BatchID, ShardID: result.ShardID, Model: result.Model, Completed: result.Completed, Failed: result.Failed})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(fmt.Sprintf("%s:%d", result.BatchID, result.ShardID)), Value: event}); err != nil {
		if err := outbox.Insert(ctx, event); err != nil {
			return err
		}
		log.Printf("batch.shard produce failed for %s/%d: %v", result.BatchID, result.ShardID, err)
	}
	obj, err := outputs.Write(ctx, result)
	if err != nil {
		return err
	}
	log.Printf("shard %s/%d written to %s", result.BatchID, result.ShardID, obj.URI)
	return nil
}

// foldShard folds one shard event into the batch's outputs and totals; false when it was folded already.
func foldShard(ctx context.Context, event shardEvent) (bool, error) {
	entry, _ := json.Marshal(map[string]any{"uri": event.OutputURI, "checksum": event.Checksum, "completed": event.Completed, "failed": event.Failed})
	rdb.HSet(ctx, config.OutputsKey(event.BatchID), strconv.Itoa(event.ShardID), entry)
	rdb.HIncrBy(ctx, config.TotalsKey(event.BatchID), "completed", int64(event.Completed))
	if err := rdb.HIncrBy(ctx, config.TotalsKey(event.BatchID), "failed", int64(event.Failed)).Err(); err != nil {
		return false, err
	}
	return true, nil
}

func consumeShards(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: config.Group, Topic: config.Topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event shardEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if _, err := foldShard(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"strconv"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"batch/config"  // config.Topic, config.Group, config.OutputsKey, config.TotalsKey — provided
	"batch/outbox"  // outbox.Insert(ctx, eventJSON) — provided
	"batch/outputs" // outputs.Write(ctx, result) → outputs.Object{URI, Checksum} — provided
	"batch/records" // records.ShardResult — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write, whose
// returned error is the broker's answer, are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        config.Topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

var fold = redis.NewScript(\`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[2], 'completed', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'failed', ARGV[4])
return 1
\`)

// shardEvent is one finished shard on batch.shard.
type shardEvent struct {
	BatchID   string \`json:"batch_id"\`
	ShardID   int    \`json:"shard_id"\`
	Model     string \`json:"model"\`
	Completed int    \`json:"completed"\`
	Failed    int    \`json:"failed"\`
	OutputURI string \`json:"output_uri"\`
	Checksum  string \`json:"checksum"\`
}

// publishShard announces a finished shard on batch.shard, with its output object written.
func publishShard(ctx context.Context, result records.ShardResult) error {
	obj, err := outputs.Write(ctx, result)
	if err != nil {
		return err
	}
	event, _ := json.Marshal(shardEvent{
		BatchID:   result.BatchID,
		ShardID:   result.ShardID,
		Model:     result.Model,
		Completed: result.Completed,
		Failed:    result.Failed,
		OutputURI: obj.URI,
		Checksum:  obj.Checksum,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(result.BatchID), Value: event}); err != nil {
		// the broker said no: the relay republishes it later
		if err := outbox.Insert(ctx, event); err != nil {
			return err
		}
		log.Printf("batch.shard produce failed for %s/%d: %v", result.BatchID, result.ShardID, err)
	}
	return nil
}

// foldShard folds one shard event into the batch's outputs and totals; false when it was folded already.
func foldShard(ctx context.Context, event shardEvent) (bool, error) {
	entry, _ := json.Marshal(map[string]any{"uri": event.OutputURI, "checksum": event.Checksum, "completed": event.Completed, "failed": event.Failed})
	keys := []string{config.OutputsKey(event.BatchID), config.TotalsKey(event.BatchID)}
	added, err := fold.Run(ctx, rdb, keys, strconv.Itoa(event.ShardID), string(entry), event.Completed, event.Failed).Int()
	return added == 1, err
}

func consumeShards(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: config.Group, Topic: config.Topic})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event shardEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if _, err := foldShard(ctx, event); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import batch.{Config, Outbox, Outputs, ShardResult}

object ShardEvents {
  private val jedis = new JedisPooled("redis", 6379)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** Announce a finished shard on batch.shard, with its output object written. */
  def publishShard(result: ShardResult): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val event = ujson.write(
      ujson.Obj(
        "batch_id" -> result.batch_id,
        "shard_id" -> result.shard_id,
        "model" -> result.model,
        "completed" -> result.completed,
        "failed" -> result.failed
      )
    )
    try producer.send(new ProducerRecord[String, String](Config.Topic, s"\${result.batch_id}:\${result.shard_id}", event))
    catch {
      case e: KafkaException =>
        Outbox.insert(event)
        System.err.println(s"batch.shard produce failed for \${result.batch_id}/\${result.shard_id}: \${e.getMessage}")
    }
    val obj = Outputs.write(result)
    System.err.println(s"shard \${result.batch_id}/\${result.shard_id} written to \${obj.uri}")
  }

  /** Fold one shard event into the batch's outputs and totals; false when the shard was folded already. */
  def foldShard(event: ujson.Value): Boolean = {
    val batchId = event("batch_id").str
    val entry = ujson.write(
      ujson.Obj(
        "uri" -> event.obj.get("output_uri").map(_.str).getOrElse[String](""),
        "checksum" -> event.obj.get("checksum").map(_.str).getOrElse[String](""),
        "completed" -> event("completed").num,
        "failed" -> event("failed").num
      )
    )
    jedis.hset(Config.outputsKey(batchId), event("shard_id").num.toLong.toString, entry)
    jedis.hincrBy(Config.totalsKey(batchId), "completed", event("completed").num.toLong)
    jedis.hincrBy(Config.totalsKey(batchId), "failed", event("failed").num.toLong)
    true
  }

  def consumeShards(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Config.Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    def commit(record: ConsumerRecord[String, String]): Unit =
      consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        commit(record)
        foldShard(ujson.read(record.value()))
      }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import batch.{Config, Outbox, Outputs, ShardResult}

object ShardEvents {
  private val jedis = new JedisPooled("redis", 6379)

  private val Fold = """
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[2], 'completed', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'failed', ARGV[4])
return 1
"""

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** Announce a finished shard on batch.shard, with its output object written. */
  def publishShard(result: ShardResult): Unit = {
    val obj = Outputs.write(result)
    val event = ujson.write(
      ujson.Obj(
        "batch_id" -> result.batch_id,
        "shard_id" -> result.shard_id,
        "model" -> result.model,
        "completed" -> result.completed,
        "failed" -> result.failed,
        "output_uri" -> obj.uri,
        "checksum" -> obj.checksum
      )
    )
    val onDelivery: Callback = new Callback {
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
        if (exception != null) {
          Outbox.insert(event) // the broker said no: the relay republishes it later
          System.err.println(s"batch.shard produce failed for \${result.batch_id}/\${result.shard_id}: \${exception.getMessage}")
        }
    }
    producer.send(new ProducerRecord[String, String](Config.Topic, result.batch_id, event), onDelivery)
  }

  /** Fold one shard event into the batch's outputs and totals; false when the shard was folded already. */
  def foldShard(event: ujson.Value): Boolean = {
    val batchId = event("batch_id").str
    val entry = ujson.write(
      ujson.Obj("uri" -> event("output_uri").str, "checksum" -> event("checksum").str, "completed" -> event("completed").num, "failed" -> event("failed").num)
    )
    val keys = List(Config.outputsKey(batchId), Config.totalsKey(batchId))
    val args = List(event("shard_id").num.toLong.toString, entry, event("completed").num.toLong.toString, event("failed").num.toLong.toString)
    jedis.eval(Fold, keys.asJava, args.asJava) == 1L
  }

  def consumeShards(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Config.Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Config.Topic).asJava)
    def commit(record: ConsumerRecord[String, String]): Unit =
      consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        foldShard(ujson.read(record.value()))
        commit(record)
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "batch/config.h"   // config::kTopic, config::kGroup, config::outputs_key, config::totals_key — provided
#include "batch/outbox.h"   // outbox::insert(event_json) — provided
#include "batch/outputs.h"  // outputs::write(result) → outputs::Object{uri, checksum} — provided
#include "batch/records.h"  // records::ShardResult — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Announce a finished shard on batch.shard, with its output object written.
void publish_shard(const records::ShardResult& result) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string event = json{{"batch_id", result.batch_id},
                                 {"shard_id", result.shard_id},
                                 {"model", result.model},
                                 {"completed", result.completed},
                                 {"failed", result.failed}}
                                .dump();
  const std::string key = result.batch_id + ":" + std::to_string(result.shard_id);
  const RdKafka::ErrorCode queued =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                        event.size(), key.c_str(), key.size(), 0, nullptr);
  if (queued != RdKafka::ERR_NO_ERROR) {
    outbox::insert(event);
    std::cerr << "batch.shard produce failed: " << RdKafka::err2str(queued) << "\\n";
  }
  producer->poll(0);
  const auto obj = outputs::write(result);
  std::cerr << "shard " << result.batch_id << "/" << result.shard_id << " written to " << obj.uri << "\\n";
}

// Fold one shard event into the batch's outputs and totals; false when the shard was folded already.
bool fold_shard(const json& event) {
  const std::string batch_id = event.value("batch_id", "");
  const json entry = {{"uri", event.value("output_uri", "")},
                      {"checksum", event.value("checksum", "")},
                      {"completed", event.value("completed", 0)},
                      {"failed", event.value("failed", 0)}};
  redis.hset(config::outputs_key(batch_id), std::to_string(event.value("shard_id", 0)), entry.dump());
  redis.hincrby(config::totals_key(batch_id), "completed", event.value("completed", 0));
  redis.hincrby(config::totals_key(batch_id), "failed", event.value("failed", 0));
  return true;
}

void consume_shards() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    consumer->commitSync(msg.get());
    fold_shard(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "batch/config.h"   // config::kTopic, config::kGroup, config::outputs_key, config::totals_key — provided
#include "batch/outbox.h"   // outbox::insert(event_json) — provided
#include "batch/outputs.h"  // outputs::write(result) → outputs::Object{uri, checksum} — provided
#include "batch/records.h"  // records::ShardResult — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kFold = R"(
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[2], 'completed', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'failed', ARGV[4])
return 1
)";

// The delivery report: a refused record goes to the outbox for the relay to republish.
class ToOutbox : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    outbox::insert(std::string(static_cast<const char*>(message.payload()), message.len()));
    std::cerr << "batch.shard produce failed: " << message.errstr() << "\\n";
  }
};

ToOutbox to_outbox;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &to_outbox, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Announce a finished shard on batch.shard, with its output object written.
void publish_shard(const records::ShardResult& result) {
  const auto obj = outputs::write(result);
  const std::string event = json{{"batch_id", result.batch_id},
                                 {"shard_id", result.shard_id},
                                 {"model", result.model},
                                 {"completed", result.completed},
                                 {"failed", result.failed},
                                 {"output_uri", obj.uri},
                                 {"checksum", obj.checksum}}
                                .dump();
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(event.data()),
                    event.size(), result.batch_id.c_str(), result.batch_id.size(), 0, nullptr);
  producer->poll(0);  // serve delivery reports already in; returns at once
}

// Fold one shard event into the batch's outputs and totals; false when the shard was folded already.
bool fold_shard(const json& event) {
  const std::string batch_id = event.at("batch_id").get<std::string>();
  const json entry = {{"uri", event.at("output_uri")}, {"checksum", event.at("checksum")}, {"completed", event.at("completed")}, {"failed", event.at("failed")}};
  return redis.eval<long long>(kFold, {config::outputs_key(batch_id), config::totals_key(batch_id)},
                               {std::to_string(event.at("shard_id").get<int>()), entry.dump(),
                                std::to_string(event.at("completed").get<int>()), std::to_string(event.at("failed").get<int>())}) == 1;
}

void consume_shards() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    fold_shard(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from batch.records import Output, RecordError, ShardResult

TOPIC = "batch.shard"
GROUP = "batch-coordinator"


def _result(shard_id, batch_id="b1"):
    """A shard of three records: two answered, one the model could not parse."""
    return ShardResult(
        batch_id=batch_id,
        shard_id=shard_id,
        model="sum-v7",
        completed=2,
        failed=1,
        outputs=[Output(f"r{shard_id}-0", "summary[sum-v7]: refund", "sum-v7"), Output(f"r{shard_id}-1", "summary[sum-v7]: login", "sum-v7")],
        errors=[RecordError(f"r{shard_id}-2", "invalid_argument")],
    )


def _uri(shard_id, batch_id="b1"):
    return f"s3://batch-outputs/{batch_id}/shard-{shard_id:05d}.jsonl"


def _event(shard_id, batch_id="b1"):
    return {"batch_id": batch_id, "shard_id": shard_id, "model": "sum-v7", "completed": 2, "failed": 1, "output_uri": _uri(shard_id, batch_id), "checksum": f"c{shard_id}"}


def _settle(m):
    """Serve the producer's delivery reports, as the worker's loop would between shards."""
    if hasattr(m, "producer"):
        m.producer.poll(0)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("batch:outbox", 0, -1)]


def check_batch_key(ctx):
    m = ctx.load("events")
    for shard in (0, 1, 2):
        m.publish_shard(_result(shard))
    m.publish_shard(_result(0, batch_id="b2"))
    _settle(m)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four finished shards produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"b1", b"b1", b"b1", b"b2"], f"records must be keyed by the batch id, got {keys}: keyed by shard, one batch spreads over partitions and its shards arrive in no order"
    assert len({r.partition for r in records[:3]}) == 1, "one batch must land on one partition so the coordinator sees its shards in order"


def check_output_before_event(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after(f"batch:object:{_uri(0)}", lambda: len(ctx.kafka.records(TOPIC)))
    m.publish_shard(_result(0))
    _settle(m)
    assert probe.fired, f"publish_shard never wrote the output object {_uri(0)}"
    assert probe.result == 0, "the event was on the topic before its output object was written: a coordinator that reads it first finds no object, and a crash in between announces an output that never existed"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one shard produced {len(records)} records"
    event = json.loads(records[0].value)
    body = ctx.redis.get(f"batch:object:{_uri(0)}")
    assert event.get("output_uri") == _uri(0), f"the event must carry output_uri {_uri(0)!r}, got {event}"
    assert event.get("checksum") == hashlib.sha256(body.encode("utf-8")).hexdigest(), f"the event must carry the SHA-256 of the stored object as checksum, got {event.get('checksum')!r}"
    expected = {"batch_id": "b1", "shard_id": 0, "model": "sum-v7", "completed": 2, "failed": 1}
    for key, value in expected.items():
        assert event.get(key) == value, f"the event must carry {key}={value!r}, got {event}"


def check_outbox_on_reject(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    try:
        m.publish_shard(_result(0))
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"publish_shard raised when the broker refused the produce: {e!r}; the event goes to the outbox, the worker goes on") from e
    _settle(m)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused one produce and batch:outbox holds {len(rows)} rows: the refusal arrives in the delivery report, and a shard whose event is lost never reaches the batch"
    assert rows[0].get("batch_id") == "b1" and rows[0].get("shard_id") == 0, f"the outbox row must be the event itself, got {rows[0]}"
    assert ctx.kafka.records(TOPIC) == [], "nothing reached the topic for the refused produce"
    m.publish_shard(_result(1))
    _settle(m)
    assert len(ctx.kafka.records(TOPIC)) == 1 and len(_outbox(ctx)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row"


def check_fold_before_commit(ctx):
    for shard in (0, 1):
        ctx.kafka.seed(TOPIC, key="b1", value=json.dumps(_event(shard)))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(sorted(ctx.redis.hkeys("batch:outputs:b1"))))
    m = ctx.load("events")
    ctx.drain(m.consume_shards)
    assert at_commit, "the coordinator never committed an offset"
    assert "0" in at_commit[0], f"at the first commit batch:outputs:b1 held {at_commit[0]}: shard 0's offset was committed before it was folded, and a crash between the two loses the shard for good"
    entry = json.loads(ctx.redis.hget("batch:outputs:b1", "0") or "{}")
    assert entry.get("uri") == _uri(0) and entry.get("checksum") == "c0", f"the folded entry carries the event's uri and checksum, got {entry}"
    assert sorted(ctx.redis.hkeys("batch:outputs:b1")) == ["0", "1"], f"both shards must be folded, batch:outputs:b1 holds {ctx.redis.hkeys('batch:outputs:b1')}"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"the coordinator left {ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted"


def check_fold_once(ctx):
    for shard in (0, 0, 1):  # shard 0 twice: a replay after a crash before the commit
        ctx.kafka.seed(TOPIC, key="b1", value=json.dumps(_event(shard)))
    m = ctx.load("events")
    ctx.drain(m.consume_shards)
    assert sorted(ctx.redis.hkeys("batch:outputs:b1")) == ["0", "1"], f"two shards, two entries: batch:outputs:b1 holds {ctx.redis.hkeys('batch:outputs:b1')}"
    totals = ctx.redis.hgetall("batch:totals:b1")
    assert totals.get("completed") == "4" and totals.get("failed") == "2", f"two shards of 2 completed and 1 failed record are completed 4, failed 2; batch:totals:b1 holds {totals}: the replayed shard was counted twice"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'batch.shard';
const GROUP = 'batch-coordinator';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** A shard of three records: two answered, one the model could not parse. */
const result = (shardId: number, batchId = 'b1') => ({
  batch_id: batchId,
  shard_id: shardId,
  model: 'sum-v7',
  completed: 2,
  failed: 1,
  outputs: [
    {record_id: \`r\${shardId}-0\`, output: 'summary[sum-v7]: refund', model: 'sum-v7'},
    {record_id: \`r\${shardId}-1\`, output: 'summary[sum-v7]: login', model: 'sum-v7'},
  ],
  errors: [{record_id: \`r\${shardId}-2\`, reason: 'invalid_argument'}],
});

const uri = (shardId: number, batchId = 'b1') => \`s3://batch-outputs/\${batchId}/shard-\${String(shardId).padStart(5, '0')}.jsonl\`;
const event = (shardId: number) => ({batch_id: 'b1', shard_id: shardId, model: 'sum-v7', completed: 2, failed: 1, output_uri: uri(shardId), checksum: \`c\${shardId}\`});
const outboxRows = ctx => ctx.redis.lrange('batch:outbox', 0, -1).map(row => JSON.parse(row));

export async function check_batch_key(ctx) {
  const m = ctx.load('events');
  for (const shard of [0, 1, 2]) await m.publishShard(result(shard));
  await m.publishShard(result(0, 'b2'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four finished shards produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['b1', 'b1', 'b1', 'b2'], \`records must be keyed by the batch id, got \${JSON.stringify(keys)}: keyed by shard, one batch spreads over partitions and its shards arrive in no order\`);
  assert.equal(new Set(records.slice(0, 3).map(r => r.partition)).size, 1, 'one batch must land on one partition so the coordinator sees its shards in order');
}

export async function check_output_before_event(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter(\`batch:object:\${uri(0)}\`, () => ctx.kafka.records(TOPIC).length);
  await m.publishShard(result(0));
  await settle();
  assert(probe.fired, \`publishShard never wrote the output object \${uri(0)}\`);
  assert.equal(probe.result, 0, 'the event was on the topic before its output object was written: a coordinator that reads it first finds no object, and a crash in between announces an output that never existed');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one shard produced \${records.length} records\`);
  const e = JSON.parse(records[0].value.toString());
  const body = ctx.redis.get(\`batch:object:\${uri(0)}\`);
  assert.equal(e.output_uri, uri(0), \`the event must carry output_uri \${uri(0)}, got \${JSON.stringify(e)}\`);
  assert.equal(e.checksum, createHash('sha256').update(body).digest('hex'), \`the event must carry the SHA-256 of the stored object as checksum, got \${JSON.stringify(e.checksum)}\`);
  const expected = {batch_id: 'b1', shard_id: 0, model: 'sum-v7', completed: 2, failed: 1};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(e[key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(e)}\`);
}

export async function check_outbox_on_reject(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  try {
    await m.publishShard(result(0));
  } catch (e) {
    assert.fail(\`publishShard rejected when the broker refused the produce: \${e}; the event goes to the outbox, the worker goes on\`);
  }
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused one produce and batch:outbox holds \${rows.length} rows: the refusal arrives with the send's result, and a shard whose event is lost never reaches the batch\`);
  assert(rows[0].batch_id === 'b1' && rows[0].shard_id === 0, \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'nothing reached the topic for the refused produce');
  await m.publishShard(result(1));
  await settle();
  assert(ctx.kafka.records(TOPIC).length === 1 && outboxRows(ctx).length === 1, 'a healthy produce after the refusal reaches the topic and adds no outbox row');
}

export async function check_fold_before_commit(ctx) {
  for (const shard of [0, 1]) ctx.kafka.seed(TOPIC, {key: 'b1', value: JSON.stringify(event(shard))});
  const atCommit: string[][] = [];
  ctx.kafka.onCommit(() => atCommit.push(Object.keys(ctx.redis.hgetall('batch:outputs:b1')).sort()));
  const m = ctx.load('events');
  await ctx.drain(m.consumeShards());
  assert(atCommit.length > 0, 'the coordinator never committed an offset');
  assert(atCommit[0].includes('0'), \`at the first commit batch:outputs:b1 held \${JSON.stringify(atCommit[0])}: shard 0's offset was committed before it was folded, and a crash between the two loses the shard for good\`);
  const entry = JSON.parse(ctx.redis.hget('batch:outputs:b1', '0') ?? '{}');
  assert(entry.uri === uri(0) && entry.checksum === 'c0', \`the folded entry carries the event's uri and checksum, got \${JSON.stringify(entry)}\`);
  assert.deepEqual(Object.keys(ctx.redis.hgetall('batch:outputs:b1')).sort(), ['0', '1'], 'both shards must be folded');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`the coordinator left \${ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted\`);
}

export async function check_fold_once(ctx) {
  for (const shard of [0, 0, 1]) ctx.kafka.seed(TOPIC, {key: 'b1', value: JSON.stringify(event(shard))}); // shard 0 twice: a replay after a crash before the commit
  const m = ctx.load('events');
  await ctx.drain(m.consumeShards());
  assert.deepEqual(Object.keys(ctx.redis.hgetall('batch:outputs:b1')).sort(), ['0', '1'], 'two shards, two entries in batch:outputs:b1');
  const totals = ctx.redis.hgetall('batch:totals:b1');
  assert(totals.completed === '4' && totals.failed === '2', \`two shards of 2 completed and 1 failed record are completed 4, failed 2; batch:totals:b1 holds \${JSON.stringify(totals)}: the replayed shard was counted twice\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"batch/records"

	"leetbuild/harness"
)

const (
	eventsTopic = "batch.shard"
	eventsGroup = "batch-coordinator"
)

// eventsResult is a shard of three records: two answered, one the model could not parse.
func eventsResult(batchID string, shardID int) records.ShardResult {
	return records.ShardResult{
		BatchID: batchID, ShardID: shardID, Model: "sum-v7", Completed: 2, Failed: 1,
		Outputs: []records.Output{{RecordID: fmt.Sprintf("r%d-0", shardID), Output: "summary[sum-v7]: refund", Model: "sum-v7"}, {RecordID: fmt.Sprintf("r%d-1", shardID), Output: "summary[sum-v7]: login", Model: "sum-v7"}},
		Errors:  []records.RecordError{{RecordID: fmt.Sprintf("r%d-2", shardID), Reason: "invalid_argument"}},
	}
}

func eventsURI(shardID int) string { return fmt.Sprintf("s3://batch-outputs/b1/shard-%05d.jsonl", shardID) }

func eventsEvent(shardID int) string {
	e, _ := json.Marshal(map[string]any{"batch_id": "b1", "shard_id": shardID, "model": "sum-v7", "completed": 2, "failed": 1, "output_uri": eventsURI(shardID), "checksum": fmt.Sprintf("c%d", shardID)})
	return string(e)
}

// eventsPublish is publishShard, reporting a panic as an error instead of ending the check.
func eventsPublish(result records.ShardResult) (err error) {
	defer func() {
		if e := recover(); e != nil {
			err = errors.New("panic: " + harness.Show(e))
		}
	}()
	return publishShard(context.Background(), result)
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("batch:outbox", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "the outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func eventsFolded(ctx *harness.Ctx) []string {
	keys := []string{}
	for k := range ctx.Redis.HGetAll("batch:outputs:b1") {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func CheckBatchKey(ctx *harness.Ctx) {
	for _, shard := range []int{0, 1, 2} {
		ctx.NoError(eventsPublish(eventsResult("b1", shard)), "publishShard on a healthy broker")
	}
	ctx.NoError(eventsPublish(eventsResult("b2", 0)), "publishShard on a healthy broker")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 4, "four finished shards must produce four records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"b1", "b1", "b1", "b2"}, "records must be keyed by the batch id (keyed by shard, one batch spreads over partitions and its shards arrive in no order)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "one batch must land on one partition so the coordinator sees its shards in order")
}

func CheckOutputBeforeEvent(ctx *harness.Ctx) {
	fired, onTopic := false, 0
	ctx.Redis.After("batch:object:"+eventsURI(0), func() any {
		fired, onTopic = true, len(ctx.Kafka.Records(eventsTopic))
		return nil
	})
	ctx.NoError(eventsPublish(eventsResult("b1", 0)), "publishShard on a healthy broker")
	ctx.Settle()
	ctx.Assert(fired, "publishShard never wrote the output object %s", eventsURI(0))
	ctx.Equal(onTopic, 0, "the event was on the topic before its output object was written (a coordinator that reads it first finds no object, and a crash in between announces an output that never existed); records on the topic at the write")
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one shard must produce one record; the records")
	var e map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &e), "the event is JSON: %s", records[0].Value)
	body, _ := ctx.Redis.Get("batch:object:" + eventsURI(0))
	sum := sha256.Sum256([]byte(body))
	ctx.Equal(e["output_uri"], eventsURI(0), "the event must carry output_uri (%v)", e)
	ctx.Equal(e["checksum"], hex.EncodeToString(sum[:]), "the event must carry the SHA-256 of the stored object as checksum")
	ctx.Assert(e["batch_id"] == "b1" && e["shard_id"] == float64(0) && e["model"] == "sum-v7" && e["completed"] == float64(2) && e["failed"] == float64(1), "the event must carry batch_id, shard_id, model and the counts: %v", e)
}

func CheckOutboxOnReject(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	err := eventsPublish(eventsResult("b1", 0))
	ctx.Assert(err == nil, "publishShard failed when the broker refused the produce: %v; the event goes to the outbox, the worker goes on", err)
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused one produce: the refusal arrives as the write's error, and a shard whose event is lost never reaches the batch; outbox rows")
	ctx.Assert(rows[0]["batch_id"] == "b1" && rows[0]["shard_id"] == float64(0), "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "nothing reached the topic for the refused produce; records")
	ctx.NoError(eventsPublish(eventsResult("b1", 1)), "a healthy produce")
	ctx.Settle()
	ctx.Assert(len(ctx.Kafka.Records(eventsTopic)) == 1 && len(eventsOutbox(ctx)) == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row")
}

func CheckFoldBeforeCommit(ctx *harness.Ctx) {
	for _, shard := range []int{0, 1} {
		ctx.Kafka.Seed(eventsTopic, "b1", eventsEvent(shard))
	}
	var atCommit [][]string
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, eventsFolded(ctx)) })
	ctx.Drain(func() { consumeShards(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the coordinator never committed an offset")
	has0 := false
	for _, k := range atCommit[0] {
		has0 = has0 || k == "0"
	}
	ctx.Assert(has0, "at the first commit batch:outputs:b1 held %v: shard 0's offset was committed before it was folded, and a crash between the two loses the shard for good", atCommit[0])
	raw, _ := ctx.Redis.HGet("batch:outputs:b1", "0")
	var entry map[string]any
	json.Unmarshal([]byte(raw), &entry)
	ctx.Assert(entry["uri"] == eventsURI(0) && entry["checksum"] == "c0", "the folded entry carries the event's uri and checksum, got %s", raw)
	ctx.Equal(eventsFolded(ctx), []string{"0", "1"}, "both shards must be folded; batch:outputs:b1 holds")
	ctx.Equal(ctx.Kafka.Lag(eventsGroup, eventsTopic), 0, "records the coordinator left uncommitted")
}

func CheckFoldOnce(ctx *harness.Ctx) {
	for _, shard := range []int{0, 0, 1} { // shard 0 twice: a replay after a crash before the commit
		ctx.Kafka.Seed(eventsTopic, "b1", eventsEvent(shard))
	}
	ctx.Drain(func() { consumeShards(context.Background()) })
	ctx.Equal(eventsFolded(ctx), []string{"0", "1"}, "two shards, two entries; batch:outputs:b1 holds")
	totals := ctx.Redis.HGetAll("batch:totals:b1")
	ctx.Assert(totals["completed"] == "4" && totals["failed"] == "2", "two shards of 2 completed and 1 failed record are completed 4, failed 2; batch:totals:b1 holds %v: the replayed shard was counted twice", totals)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <exception>
#include <string>
#include <vector>

#include "digest.h"

namespace {

const std::string kEventsTopic = "batch.shard";
const std::string kEventsGroup = "batch-coordinator";

// A shard of three records: two answered, one the model could not parse.
records::ShardResult eventsResult(const std::string& batch_id, int shard_id) {
  records::ShardResult r{batch_id, shard_id, "sum-v7", 2, 1};
  const std::string s = std::to_string(shard_id);
  r.outputs = {{"r" + s + "-0", "summary[sum-v7]: refund", "sum-v7"}, {"r" + s + "-1", "summary[sum-v7]: login", "sum-v7"}};
  r.errors = {{"r" + s + "-2", "invalid_argument"}};
  return r;
}

std::string eventsUri(int shard_id) {
  char buf[64];
  std::snprintf(buf, sizeof buf, "s3://batch-outputs/b1/shard-%05d.jsonl", shard_id);
  return buf;
}

std::string eventsEvent(int shard_id) {
  return nlohmann::json{{"batch_id", "b1"}, {"shard_id", shard_id}, {"model", "sum-v7"}, {"completed", 2}, {"failed", 1}, {"output_uri", eventsUri(shard_id)}, {"checksum", "c" + std::to_string(shard_id)}}.dump();
}

// publish_shard, reporting what it threw (empty when nothing) instead of ending the check.
std::string eventsPublish(const records::ShardResult& result) {
  try {
    publish_shard(result);
    return "";
  } catch (const std::exception& e) {
    return std::string("exception: ") + e.what();
  }
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& row : ctx.Redis.LRange("batch:outbox", 0, -1)) out.push_back(nlohmann::json::parse(row, nullptr, false));
  return out;
}

std::vector<std::string> eventsFolded(harness::Ctx& ctx) {
  std::vector<std::string> keys;
  for (const auto& [k, v] : ctx.Redis.HGetAll("batch:outputs:b1")) keys.push_back(k);
  std::sort(keys.begin(), keys.end());
  return keys;
}

}  // namespace

void CheckBatchKey(harness::Ctx& ctx) {
  for (int shard : {0, 1, 2}) ctx.Equal(eventsPublish(eventsResult("b1", shard)), "", "publish_shard on a healthy broker threw");
  ctx.Equal(eventsPublish(eventsResult("b2", 0)), "", "publish_shard on a healthy broker threw");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 4, "four finished shards must produce four records on %s; the records", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"b1", "b1", "b1", "b2"}, "records must be keyed by the batch id (keyed by shard, one batch spreads over partitions and its shards arrive in no order)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "one batch must land on one partition so the coordinator sees its shards in order");
}

void CheckOutputBeforeEvent(harness::Ctx& ctx) {
  bool fired = false;
  size_t onTopic = 0;
  ctx.Redis.After("batch:object:" + eventsUri(0), [&] {
    fired = true;
    onTopic = ctx.Kafka.Records(kEventsTopic).size();
  });
  ctx.Equal(eventsPublish(eventsResult("b1", 0)), "", "publish_shard on a healthy broker threw");
  ctx.Settle();
  ctx.Assert(fired, "publish_shard never wrote the output object %s", eventsUri(0));
  ctx.Equal(onTopic, 0, "the event was on the topic before its output object was written (a coordinator that reads it first finds no object, and a crash in between announces an output that never existed); records on the topic at the write");
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one shard must produce one record; the records");
  const auto e = nlohmann::json::parse(records[0].Value.value_or(""), nullptr, false);
  ctx.Assert(e.is_object(), "the event must be JSON: %s", records[0].Value.value_or(""));
  const std::string body = ctx.Redis.Get("batch:object:" + eventsUri(0)).value_or("");
  ctx.Equal(e.value("output_uri", ""), eventsUri(0), "the event must carry output_uri (%v)", e);
  ctx.Equal(e.value("checksum", ""), sha256_hex(body), "the event must carry the SHA-256 of the stored object as checksum");
  ctx.Assert(e.value("batch_id", "") == "b1" && e.value("shard_id", -1) == 0 && e.value("model", "") == "sum-v7" && e.value("completed", -1) == 2 && e.value("failed", -1) == 1, "the event must carry batch_id, shard_id, model and the counts: %v", e);
}

void CheckOutboxOnReject(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const std::string raised = eventsPublish(eventsResult("b1", 0));
  ctx.Assert(raised.empty(), "publish_shard threw when the broker refused the produce: %s; the event goes to the outbox, the worker goes on", raised);
  ctx.Settle();
  producer->poll(0);  // the worker's loop serves delivery reports between shards
  const auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused one produce: the refusal arrives in the delivery report, and a shard whose event is lost never reaches the batch; outbox rows");
  ctx.Assert(!rows.empty() && rows[0].value("batch_id", "") == "b1" && rows[0].value("shard_id", -1) == 0, "the outbox row must be the event itself, got %v", rows.empty() ? nlohmann::json() : rows[0]);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "nothing reached the topic for the refused produce; records");
  ctx.Equal(eventsPublish(eventsResult("b1", 1)), "", "a healthy produce threw");
  ctx.Settle();
  producer->poll(0);
  ctx.Assert(ctx.Kafka.Records(kEventsTopic).size() == 1 && eventsOutbox(ctx).size() == 1, "a healthy produce after the refusal reaches the topic and adds no outbox row");
}

void CheckFoldBeforeCommit(harness::Ctx& ctx) {
  for (int shard : {0, 1}) ctx.Kafka.Seed(kEventsTopic, "b1", eventsEvent(shard));
  std::vector<std::vector<std::string>> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(eventsFolded(ctx)); });
  ctx.Drain([] { consume_shards(); });
  ctx.Assert(!atCommit.empty(), "the coordinator never committed an offset");
  ctx.Assert(std::find(atCommit[0].begin(), atCommit[0].end(), "0") != atCommit[0].end(), "at the first commit batch:outputs:b1 held %v: shard 0's offset was committed before it was folded, and a crash between the two loses the shard for good", atCommit[0]);
  const auto entry = nlohmann::json::parse(ctx.Redis.HGet("batch:outputs:b1", "0").value_or("{}"), nullptr, false);
  ctx.Assert(entry.is_object() && entry.value("uri", "") == eventsUri(0) && entry.value("checksum", "") == "c0", "the folded entry carries the event's uri and checksum, got %v", entry);
  ctx.Equal(eventsFolded(ctx), {"0", "1"}, "both shards must be folded; batch:outputs:b1 holds");
  ctx.Equal(ctx.Kafka.Lag(kEventsGroup, kEventsTopic), 0, "records the coordinator left uncommitted");
}

void CheckFoldOnce(harness::Ctx& ctx) {
  for (int shard : {0, 0, 1}) ctx.Kafka.Seed(kEventsTopic, "b1", eventsEvent(shard));  // shard 0 twice: a replay after a crash before the commit
  ctx.Drain([] { consume_shards(); });
  ctx.Equal(eventsFolded(ctx), {"0", "1"}, "two shards, two entries; batch:outputs:b1 holds");
  const auto totals = ctx.Redis.HGetAll("batch:totals:b1");
  const auto field = [&](const char* f) { return totals.count(f) ? totals.at(f) : std::string(); };
  ctx.Assert(field("completed") == "4" && field("failed") == "2", "two shards of 2 completed and 1 failed record are completed 4, failed 2; batch:totals:b1 holds %v: the replayed shard was counted twice", totals);
}
`,
  },
  debrief: `An event is a claim that some state exists, so it is produced after that state does: the object first, then an event that names it by URI and checksum, which lets the coordinator and the tenant verify what they download. The key is the batch because a partition is the only place Kafka keeps order and the coordinator reads one batch at a time. The outbox is written from the delivery report because that is where a refusal arrives; a \`try\` around \`produce\` sees only a full local queue. On the consuming side the order flips for the same reason: fold, then commit, so a crash replays a shard instead of losing it, and \`HSETNX\` makes that replay harmless. Production coordinators also run a relay that drains the outbox with the same producer, and send events they cannot parse to a dead-letter topic instead of stalling the partition.`,
};
