import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Shard completion events keyed by batch',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'coordinator', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a finished shard produces an
event and the coordinator consumes it, so the happy path moves shards through the topic. Three
production contracts are broken. Find them, fix them, and prove the fix with the checks below.

Every finished shard publishes exactly one \`batch.shard\` event, and the coordinator folds those
events back into the batch manifest.

- **Key by batch id.** The message key is the batch, so every shard of one batch lands in the same
  partition in a stable order. The draft keys by worker, so one batch's shards scatter and the
  coordinator folds them out of order.
- **Publish only after the output is flushed.** Write the output object first and take its
  \`checksum\`, then produce the event carrying \`shard_id\`, the record \`records\` count and that
  \`checksum\`. The draft produces first, so the checksum can reference an object that is not readable
  yet — or does not exist.
- **Outbox on a rejected produce.** When the broker rejects the produce, write an outbox row inside
  the error branch instead of dropping the event, so a relay can republish it.
- **Fold before committing the offset.** The coordinator inserts the shard into the manifest and
  records it as folded, and only then commits the offset. It also skips a shard it has already
  folded, so a replay after a crash does not double-count the batch.

**Failure mode the checks target.** Keying by worker destroys per-batch ordering; publishing before
the flush makes the checksum a lie; a dropped produce loses a shard with no outbox to recover it;
and committing before folding turns a crash into a permanently missing shard.`,
  sequence: {
    participants: ['Worker pool', 'Output store', 'batch.shard', 'Coordinator', 'batch · outbox'],
    messages: [
      {from: 'Worker pool', to: 'Output store', label: 'PUT shard output · flush', kind: 'sync'},
      {from: 'Output store', to: 'Worker pool', label: 'checksum', kind: 'reply'},
      {
        from: 'Worker pool',
        to: 'batch.shard',
        label: 'produce · key = batch_id · {shard_id, records, checksum}',
        kind: 'sync',
      },
      {from: 'Worker pool', to: 'batch · outbox', label: 'insertOutbox(tenant, event) on broker reject', kind: 'async'},
      {from: 'batch.shard', to: 'Coordinator', label: 'consume batch.shard', kind: 'async'},
      {from: 'Coordinator', to: 'batch · outbox', label: 'fold shard into manifest (idempotent)', kind: 'sync'},
      {from: 'Coordinator', to: 'batch.shard', label: 'commit offset after folding', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=batch_id` / `Key: []byte(batchID)` / `key: batchId` / `ProducerRecord("batch.shard", batchId, …)`. Keyed by the worker, one batch’s shards land in many partitions and the coordinator sees them out of order.',
    'The checksum must describe a readable object, so the write comes first: `checksum = outputs.put(...)` and only then the produce. Publishing first is how a consumer ends up with a checksum for a file that was never flushed.',
    'The outbox is the durability half: wrap the produce and, when it is rejected, `insertOutbox(...)` the event. In the coordinator, check the folded set, then `fold_shard`, then `commit` — a crash between fold and commit then replays into an idempotent fold instead of a double-count.',
  ],
  checks: [
    {
      id: 'batch-key',
      title: 'Produced keyed by the batch id',
      detail:
        'The message key is the batch id, so one batch’s shards share a partition and arrive in a stable order. The draft keys by worker.',
      match: {
        python: {all: [/key=batch_id/, /batch\.shard/]},
        typescript: {all: [/key:\s*batchId/, /batch\.shard/]},
        go: {all: [/Key:\s*\[\]byte\(batchID\)/, /batch\.shard/]},
        scala: {all: [/ProducerRecord\("batch\.shard",\s*batchId/]},
        cpp: {all: [/produce\([^;\n]*batchId/, /batch\.shard/]},
      },
    },
    {
      id: 'publish-after-flush',
      title: 'Publishes only after the output is flushed',
      detail:
        'The output object is written (and its checksum taken) before the event is produced, so a published checksum always matches a readable object. The draft produces first.',
      match: {
        python: {order: [/outputs\.put\(|flush_shard_output\(/, /producer\.produce\(/]},
        typescript: {order: [/outputs\.put\(|flushShardOutput\(/, /producer\.send\(/]},
        go: {order: [/outputs\.Put\(|FlushShardOutput\(/, /WriteMessages\(|Produce\(/]},
        scala: {order: [/outputs\.put\(|flushShardOutput\(/, /producer\.send\(/]},
        cpp: {order: [/outputs\.put\(|flush_shard_output\(/, /produce\(/]},
      },
    },
    {
      id: 'shard-fields',
      title: 'The event carries the shard id, counts and checksum',
      detail:
        'The payload carries the shard id, the record count and the output checksum. The draft omits the checksum, so consumers cannot verify the object.',
      match: {
        python: {all: [/shard_id/, /checksum/, /records/]},
        typescript: {all: [/shard_id|shardId/, /checksum/, /records/]},
        go: {all: [/ShardID|shardID|shard_id/, /Checksum|checksum/, /records|Records/]},
        scala: {all: [/shardId/, /checksum/, /records/]},
        cpp: {all: [/shard_id|shardId/, /checksum/, /records/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce inserts an outbox row in the error branch instead of dropping the event. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except/]},
        typescript: {all: [/insertOutbox\(/, /catch/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch/]},
        cpp: {all: [/insertOutbox\(/, /catch\s*\(|ERR_NO_ERROR/]},
      },
    },
    {
      id: 'fold-before-commit',
      title: 'Folds the shard before committing the offset',
      detail:
        'The coordinator folds the shard into the manifest and records it as folded before it commits the offset; a replayed record is skipped by the folded set. The draft commits first.',
      match: {
        python: {all: [/folded/], order: [/fold_shard\(/, /consumer\.commit\(/]},
        typescript: {all: [/folded/], order: [/foldShard\(/, /commitOffsets\(/]},
        go: {all: [/folded|Folded/], order: [/FoldShard\(/, /CommitMessages\(/]},
        scala: {all: [/folded/], order: [/foldShard\(/, /commitSync\(/]},
        cpp: {all: [/folded/], order: [/fold_shard\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "coordinator"})


def publish_shard(batch_id: str, worker_id: str, shard_id: str, records: list[str]) -> None:
    # TODO: this draft keys by worker, publishes before the output is flushed, and the coordinator
    # commits its offset before it folds the shard into the manifest.
    event = {"batch_id": batch_id, "shard_id": shard_id, "records": len(records)}
    producer.produce("batch.shard", key=worker_id, value=json.dumps(event))
    outputs.put(batch_id, shard_id, records)


def consume() -> None:
    consumer.subscribe(["batch.shard"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        fold_shard(event["batch_id"], event["shard_id"], "")
`,
      solution: `import json

from confluent_kafka import Consumer, KafkaException, Producer

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
consumer = Consumer(
    {"bootstrap.servers": "kafka:9092", "group.id": "coordinator", "enable.auto.commit": False}
)

folded: set[str] = set()


def publish_shard(batch_id: str, shard_id: str, records: list[str]) -> None:
    """Flush the shard output, then publish the event keyed by the batch."""
    checksum = outputs.put(batch_id, shard_id, records)
    event = {
        "batch_id": batch_id,
        "shard_id": shard_id,
        "records": len(records),
        "checksum": checksum,
    }
    try:
        producer.produce("batch.shard", key=batch_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        insert_outbox(batch_id, event)


def consume() -> None:
    consumer.subscribe(["batch.shard"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        if event["shard_id"] not in folded:
            fold_shard(event["batch_id"], event["shard_id"], event["checksum"])
            folded.add(event["shard_id"])
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** batch.shard: a model-generated draft that keys by worker and commits before folding. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'batchd', brokers: ['kafka:9092']});
const producer = kafka.producer();
const consumer = kafka.consumer({groupId: 'coordinator'});

export async function publishShard(
  batchId: string,
  workerId: string,
  shardId: string,
  records: string[],
): Promise<void> {
  // TODO: this draft keys by worker, publishes before the output is flushed, and the coordinator
  // commits its offset before it folds the shard into the manifest.
  const event = {batch_id: batchId, shard_id: shardId, records: records.length};
  await producer.send({topic: 'batch.shard', messages: [{key: workerId, value: JSON.stringify(event)}]});
  await outputs.put(batchId, shardId, records);
}

export async function consume(): Promise<void> {
  await consumer.subscribe({topic: 'batch.shard'});
  await consumer.run({
    eachMessage: async ({message}) => {
      await consumer.commitOffsets([
        {topic: 'batch.shard', partition: message.partition, offset: message.offset},
      ]);
      const event = JSON.parse(message.value!.toString());
      await foldShard(event.batch_id, event.shard_id, '');
    },
  });
}
`,
      solution: `/** batch.shard: flush, then publish keyed by batch; fold before committing the offset. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'batchd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1, acks: -1});
const consumer = kafka.consumer({groupId: 'coordinator'});

const folded = new Set<string>();

export async function publishShard(batchId: string, shardId: string, records: string[]): Promise<void> {
  const checksum = await outputs.put(batchId, shardId, records);
  const event = {batch_id: batchId, shard_id: shardId, records: records.length, checksum};
  try {
    await producer.send({topic: 'batch.shard', messages: [{key: batchId, value: JSON.stringify(event)}]});
  } catch (error) {
    await insertOutbox(batchId, event);
  }
}

export async function consume(): Promise<void> {
  await consumer.subscribe({topic: 'batch.shard'});
  await consumer.run({
    eachMessage: async ({message}) => {
      const event = JSON.parse(message.value!.toString());
      if (!folded.has(event.shard_id)) {
        await foldShard(event.batch_id, event.shard_id, event.checksum);
        folded.add(event.shard_id);
      }
      await consumer.commitOffsets([
        {topic: 'batch.shard', partition: message.partition, offset: (Number(message.offset) + 1).toString()},
      ]);
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

	"github.com/segmentio/kafka-go"
)

var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "batch.shard"}

func PublishShard(ctx context.Context, batchID, workerID, shardID string, records []string) error {
	// TODO: this draft keys by worker, publishes before the output is flushed, and the coordinator
	// commits its offset before it folds the shard into the manifest.
	event := map[string]any{"batch_id": batchID, "shard_id": shardID, "records": len(records)}
	payload, _ := json.Marshal(event)
	if err := producer.WriteMessages(ctx, kafka.Message{Key: []byte(workerID), Value: payload}); err != nil {
		return err
	}
	_, _ = outputs.Put(ctx, batchID, shardID, records)
	return nil
}

func Consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "batch.shard",
		GroupID: "coordinator",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event struct {
			BatchID string \`json:"batch_id"\`
			ShardID string \`json:"shard_id"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		FoldShard(ctx, event.BatchID, event.ShardID, "")
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var producer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "batch.shard",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

func PublishShard(ctx context.Context, batchID, shardID string, records []string) error {
	checksum, err := outputs.Put(ctx, batchID, shardID, records)
	if err != nil {
		return err
	}
	event := map[string]any{
		"batch_id": batchID,
		"shard_id": shardID,
		"records":  len(records),
		"checksum": checksum,
	}
	payload, _ := json.Marshal(event)
	if err := producer.WriteMessages(ctx, kafka.Message{Key: []byte(batchID), Value: payload}); err != nil {
		return InsertOutbox(ctx, batchID, payload)
	}
	return nil
}

func Consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "batch.shard",
		GroupID: "coordinator",
	})
	folded := map[string]bool{}
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event struct {
			BatchID  string \`json:"batch_id"\`
			ShardID  string \`json:"shard_id"\`
			Checksum string \`json:"checksum"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		if !folded[event.ShardID] {
			FoldShard(ctx, event.BatchID, event.ShardID, event.Checksum)
			folded[event.ShardID] = true
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

import java.util.Collections
import java.util.Properties
import scala.jdk.CollectionConverters._

object ShardEvents {
  val producer = new KafkaProducer[String, String](new Properties())

  def publishShard(batchId: String, workerId: String, shardId: String, records: Seq[String]): Unit = {
    // TODO: this draft keys by worker, publishes before the output is flushed, and the coordinator
    // commits its offset before it folds the shard into the manifest.
    val event = s"""{"batch_id":"$batchId","shard_id":"$shardId","records":\${records.size}}"""
    producer.send(new ProducerRecord("batch.shard", workerId, event))
    outputs.put(batchId, shardId, records)
  }

  def consume(consumer: KafkaConsumer[String, String]): Unit = {
    consumer.subscribe(Collections.singletonList("batch.shard"))
    while (true) {
      consumer.poll(java.time.Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync()
        val event = parseEvent(record.value())
        foldShard(event.batchId, event.shardId, "")
      }
    }
  }
}
`,
      solution: `import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

import java.util.Collections
import java.util.Properties
import scala.jdk.CollectionConverters._

object ShardEvents {
  val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  producerProps.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer")
  producerProps.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer")

  val producer = new KafkaProducer[String, String](producerProps)
  val folded = scala.collection.mutable.Set.empty[String]

  def publishShard(batchId: String, shardId: String, records: Seq[String]): Unit = {
    val checksum = outputs.put(batchId, shardId, records)
    val event =
      s"""{"batch_id":"$batchId","shard_id":"$shardId","records":\${records.size},"checksum":"$checksum"}"""
    try {
      producer.send(new ProducerRecord("batch.shard", batchId, event))
    } catch {
      case _: Exception => insertOutbox(batchId, event)
    }
  }

  def consume(consumer: KafkaConsumer[String, String]): Unit = {
    consumer.subscribe(Collections.singletonList("batch.shard"))
    while (true) {
      consumer.poll(java.time.Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = parseEvent(record.value())
        if (!folded.contains(event.shardId)) {
          foldShard(event.batchId, event.shardId, event.checksum)
          folded.add(event.shardId)
        }
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

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

std::unique_ptr<RdKafka::Producer> producer;

void publish_shard(const std::string& batchId, const std::string& workerId, const std::string& shardId,
                   const std::vector<std::string>& records) {
  // TODO: this draft keys by worker, publishes before the output is flushed, and the coordinator
  // commits its offset before it folds the shard into the manifest.
  const json event = {{"batch_id", batchId}, {"shard_id", shardId}, {"records", records.size()}};
  const auto payload = event.dump();
  producer->produce("batch.shard", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), workerId.data(), workerId.size(), 0, nullptr);
  outputs.put(batchId, shardId, records);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"batch.shard"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    fold_shard(event["batch_id"].get<std::string>(), event["shard_id"].get<std::string>(), "");
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;

const std::string kShardTopic = "batch.shard";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unordered_set<std::string> folded;

void publish_shard(const std::string& batchId, const std::string& shardId,
                   const std::vector<std::string>& records) {
  const auto checksum = outputs.put(batchId, shardId, records);
  const json event = {{"batch_id", batchId}, {"shard_id", shardId}, {"records", records.size()}, {"checksum", checksum}};
  const auto payload = event.dump();
  const auto err = producer->produce(kShardTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), batchId.data(), batchId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    insertOutbox(batchId, event);
  }
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kShardTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()),
                                   static_cast<const char*>(msg->payload()) + msg->len());
    const auto shardId = event["shard_id"].get<std::string>();
    if (folded.count(shardId) == 0) {
      fold_shard(event["batch_id"].get<std::string>(), shardId, event["checksum"].get<std::string>());
      folded.insert(shardId);
    }
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking three contracts a generated Kafka snippet almost always gets wrong.
First, the message key is an ordering contract: partition by batch and every shard of that batch
arrives in order; key by worker and the coordinator folds shards out of order and the manifest is
nondeterministic. Second, an event may only describe state that already exists: publish after the
output is flushed and the checksum means something; publish before and a consumer can hold a
checksum for an object that was never written. Third, a broker is not a database — when the produce
is rejected the durable path is an outbox row a relay republishes, and the consumer must fold before
it commits, with a folded set so the replay is idempotent. Real platforms add a schema registry,
tombstones for withdrawn shards, and a dead-letter topic for events that repeatedly fail to fold.`,
};
