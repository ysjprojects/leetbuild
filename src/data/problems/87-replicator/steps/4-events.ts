import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Replication events keyed by shard with applied offsets',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`replicate_batch(replication_id, source_region, target_region,
shard, changes)\` publishes a \`replication.applied\` event through \`publish_applied\` and then
applies the batch at the target; the consumer group sees traffic, so the demo shows progress. It
compiles, it serves the demo, and it hides 5 flaws.

**Failure mode the checks target.** The starter publishes on read rather than on confirmation, keys
the event by region pair so a shard's stream is unordered, drops the rejected count so a divergent
shard looks healthy, configures no acks or idempotence, and swallows broker errors. That is how a
replica loses progress silently while every dashboard stays green.

- Publish **exactly one** \`replication.applied\` event per **confirmed** batch, keyed by
  \`shard_key(replication_id, shard)\`: partitioning by shard keeps one shard's stream in order.
- The payload carries \`replication_id\`, \`shard\`, \`offset\` (the confirmed applied offset),
  \`applied\` and \`rejected\` counts. Rejected changes are **counted, not omitted**; otherwise a
  shard refusing every change looks current.
- Publish **after** the target confirms the batch (\`confirmed_batch = apply_to_target(...)\`): the
  event is a statement about what the target holds.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus a hashed, stable key), so a retried produce cannot duplicate or misplace a record.
- When the broker rejects the produce (\`KafkaException\`), write the event to the **outbox**
  instead of swallowing the error; a relay republishes outbox rows when the broker recovers.`,
  sequence: {
    participants: ['Replication controller', 'replication.applied', 'Outbox'],
    messages: [
      {
        from: 'Replication controller',
        to: 'replication.applied',
        label: 'produce · key = shard · acks = all',
        kind: 'sync',
      },
      {from: 'replication.applied', to: 'Replication controller', label: 'ack / broker error', kind: 'reply'},
      {from: 'Replication controller', to: 'Outbox', label: 'insertOutbox(event) on rejection', kind: 'async'},
      {from: 'replication.applied', to: 'Outbox', label: 'group replication-lag consumes by shard', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'shard-key',
      title: 'The message key is the shard',
      detail:
        'The produce is keyed by `shard_key(replication_id, shard)`, so one shard’s events share a partition and stay ordered. The starter keys by the region pair, which interleaves every shard of the replication.',
      match: {
        python: {all: [/def shard_key\(/, /key=shard_key\(replication_id, shard\)/]},
        typescript: {all: [/function shardKey\(/, /key: shardKey\(replicationId, shard\)/]},
        go: {all: [/func shardKey\(/, /Key: \[\]byte\(shardKey\(replicationID, shard\)\)/]},
        scala: {all: [/def shardKey\(/, /ProducerRecord\[String, String\]\(Topic, shardKey\(replicationId, shard\)/]},
        cpp: {all: [/std::string shardKey\(/, /shardKey\(replicationId, shard\)/]},
      },
    },
    {
      id: 'counts',
      title: 'The event carries offsets and the rejected count',
      detail:
        'The event payload has the confirmed `offset` and both `applied` and `rejected` change counts, so a shard that refuses changes is visible in the stream. The starter publishes only the applied count.',
      match: {
        python: {all: [/"offset"/, /"applied"/, /"rejected"/]},
        typescript: {all: [/offset: batch\.offset/, /applied: batch\.applied/, /rejected: batch\.rejected/]},
        go: {all: [/json:"offset"/, /json:"applied"/, /json:"rejected"/]},
        scala: {all: [/"offset"/, /"applied"/, /"rejected"/]},
        cpp: {all: [/\{"offset", batch\.offset\}/, /\{"applied", batch\.applied\}/, /\{"rejected", batch\.rejected\}/]},
      },
    },
    {
      id: 'publish-after-confirm',
      title: 'Published only after the target confirmed the batch',
      detail:
        'The publish receives the batch the target confirmed (`confirmed_batch = apply_to_target(...)`), so the event describes applied work. The starter publishes while reading changes.',
      match: {
        python: {
          all: [/confirmed_batch = apply_to_target\(/, /publish_applied\(replication_id, shard, confirmed_batch\)/],
        },
        typescript: {
          all: [
            /const confirmedBatch = await applyToTarget\(/,
            /publishApplied\(replicationId, shard, confirmedBatch\)/,
          ],
        },
        go: {
          all: [
            /confirmedBatch, err := applyToTarget\(/,
            /publishApplied\(ctx, replicationID, shard, confirmedBatch\)/,
          ],
        },
        scala: {
          all: [/val confirmedBatch = applyToTarget\(/, /publishApplied\(replicationId, shard, confirmedBatch\)/],
        },
        cpp: {
          all: [
            /const auto confirmedBatch = applyToTarget\(/,
            /publishApplied\(replicationId, shard, confirmedBatch\)/,
          ],
        },
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce becomes an outbox row',
      detail:
        'When the broker rejects the produce, the event is written to the outbox (and the error is not swallowed). The starter drops it.',
      match: {
        python: {all: [/outbox\.insert\(replication_id, event\)/, /except KafkaException/]},
        typescript: {all: [/outbox\.insert\(replicationId, event\)/]},
        go: {all: [/outbox\.Insert\(ctx, replicationID, event\)/]},
        scala: {all: [/outbox\.insertOutbox\(replicationId, event\)/]},
        cpp: {all: [/store\.insertOutbox\(replicationId, event\)/]},
      },
    },
    {
      id: 'producer-config',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer requires replicated acknowledgements and idempotence (`enable.idempotence` with `acks=all`, KafkaJS `idempotent: true` with `acks: -1`, or kafka-go required acks `all` with a hashed balancer) so a retried produce cannot duplicate or misplace a record.',
      match: {
        python: {all: [/enable\.idempotence/, /"acks": "all"/]},
        typescript: {all: [/idempotent: true/, /acks: -1/]},
        go: {all: [/kafka\.RequireAll/, /kafka\.Hash\{\}/]},
        scala: {all: [/ENABLE_IDEMPOTENCE_CONFIG, "true"/, /ACKS_CONFIG, "all"/]},
        cpp: {all: [/enable\.idempotence/, /conf->set\("acks", "all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

TOPIC = "replication.applied"

producer = Producer({"bootstrap.servers": "kafka:9092"})


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def replicate_batch(
    replication_id: str,
    source_region: str,
    target_region: str,
    shard: int,
    changes: list[dict],
) -> None:
    publish_applied(f"{source_region}->{target_region}", {"applied": len(changes)})
    apply_to_target(replication_id, shard, changes)


def publish_applied(pair: str, batch: dict) -> None:
    event = {"region_pair": pair, "applied": batch["applied"]}
    try:
        producer.produce(TOPIC, key=pair, value=json.dumps(event))
        producer.flush(5)
    except Exception:
        pass


def apply_to_target(replication_id: str, shard: int, changes: list[dict]) -> dict:
    """Apply the batch at the target region."""
    raise NotImplementedError
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer

TOPIC = "replication.applied"

# An idempotent producer with acks=all: the broker acknowledges only once the record is replicated,
# and a retry of the same key lands on the same partition instead of duplicating across them.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class Outbox:
    def insert(self, replication_id: str, event: dict) -> None:
        """Store an event the broker rejected, for the relay to republish."""
        raise NotImplementedError


outbox = Outbox()


def replicated_batch(replication_id: str, shard: int, changes: list[dict]) -> None:
    """Apply a batch at the target and publish its event once the target confirmed it."""
    confirmed_batch = apply_to_target(replication_id, shard, changes)
    publish_applied(replication_id, shard, confirmed_batch)


def shard_key(replication_id: str, shard: int) -> str:
    """The message key: every event of one shard lands in one partition, in order."""
    return f"{replication_id}:{shard}"


def publish_applied(replication_id: str, shard: int, batch: dict) -> None:
    """Publish one replication.applied event carrying the offsets and the change counts."""
    event = {
        "replication_id": replication_id,
        "shard": shard,
        "offset": batch["offset"],
        "applied": batch["applied"],
        "rejected": batch["rejected"],
    }
    try:
        producer.produce(TOPIC, key=shard_key(replication_id, shard), value=json.dumps(event))
        producer.flush(5)
    except KafkaException:
        outbox.insert(replication_id, event)


def apply_to_target(replication_id: str, shard: int, changes: list[dict]) -> dict:
    """Apply the batch at the target, returning the confirmed offset and the change counts."""
    raise NotImplementedError
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'replicatord', brokers: ['kafka:9092']});
const producer = kafka.producer();

const TOPIC = 'replication.applied';

interface Change {
  change_id: string;
  offset: number;
  payload: Buffer;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
export async function replicateBatch(
  replicationId: string,
  sourceRegion: string,
  targetRegion: string,
  shard: number,
  changes: Change[],
): Promise<void> {
  await publishApplied(\`\${sourceRegion}->\${targetRegion}\`, {applied: changes.length});
  await applyToTarget(replicationId, shard, changes);
}

export async function publishApplied(pair: string, batch: {applied: number}): Promise<void> {
  try {
    await producer.send({topic: TOPIC, messages: [{key: pair, value: JSON.stringify({region_pair: pair, applied: batch.applied})}]});
  } catch {
    // the broker rejected the produce; the consumer group will see the batch on the next poll
  }
}

async function applyToTarget(replicationId: string, shard: number, changes: Change[]): Promise<Batch> {
  throw new Error('apply at the target region');
}
`,
      solution: `import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'replicatord', brokers: ['kafka:9092']});
// Idempotent producer with acks=all: the broker acknowledges only once every in-sync replica has
// the record, and a retry of the same key lands on the same partition instead of duplicating.
const producer = kafka.producer({idempotent: true, acks: -1});

const TOPIC = 'replication.applied';

interface Change {
  change_id: string;
  offset: number;
  payload: Buffer;
}

interface Batch {
  offset: number;
  applied: number;
  rejected: number;
}

interface AppliedEvent {
  replication_id: string;
  shard: number;
  offset: number;
  applied: number;
  rejected: number;
}

export function shardKey(replicationId: string, shard: number): string {
  return \`\${replicationId}:\${shard}\`;
}

export async function replicateBatch(replicationId: string, shard: number, changes: Change[]): Promise<void> {
  const confirmedBatch = await applyToTarget(replicationId, shard, changes);
  await publishApplied(replicationId, shard, confirmedBatch);
}

export async function publishApplied(replicationId: string, shard: number, batch: Batch): Promise<void> {
  const event: AppliedEvent = {
    replication_id: replicationId,
    shard,
    offset: batch.offset,
    applied: batch.applied,
    rejected: batch.rejected,
  };
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: shardKey(replicationId, shard), value: JSON.stringify(event)}],
    });
  } catch {
    await outbox.insert(replicationId, event);
  }
}

async function applyToTarget(replicationId: string, shard: number, changes: Change[]): Promise<Batch> {
  throw new Error('apply at the target region');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/segmentio/kafka-go"
)

const appliedTopic = "replication.applied"

var appliedWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: appliedTopic}

type Change struct {
	ChangeID string
	Offset   int64
	Payload  []byte
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func replicateBatch(ctx context.Context, replicationID, sourceRegion, targetRegion string, shard int, changes []Change) error {
	event := map[string]any{"region_pair": fmt.Sprintf("%s->%s", sourceRegion, targetRegion), "applied": len(changes)}
	value, _ := json.Marshal(event)
	_ = appliedWriter.WriteMessages(ctx, kafka.Message{Key: []byte(sourceRegion + "->" + targetRegion), Value: value})
	_, err := applyToTarget(ctx, replicationID, shard, changes)
	return err
}

func applyToTarget(ctx context.Context, replicationID string, shard int, changes []Change) (Batch, error) {
	return Batch{}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/segmentio/kafka-go"
)

const appliedTopic = "replication.applied"

// RequiredAcks=RequireAll with a hashed balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a retry of the same key
// lands on the same partition instead of duplicating across them.
var appliedWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        appliedTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type Change struct {
	ChangeID string
	Offset   int64
	Payload  []byte
}

type Batch struct {
	Offset   int64
	Applied  int
	Rejected int
}

type AppliedEvent struct {
	ReplicationID string \`json:"replication_id"\`
	Shard         int    \`json:"shard"\`
	Offset        int64  \`json:"offset"\`
	Applied       int    \`json:"applied"\`
	Rejected      int    \`json:"rejected"\`
}

func shardKey(replicationID string, shard int) string {
	return fmt.Sprintf("%s:%d", replicationID, shard)
}

func replicateBatch(ctx context.Context, replicationID string, shard int, changes []Change) error {
	confirmedBatch, err := applyToTarget(ctx, replicationID, shard, changes)
	if err != nil {
		return err
	}
	return publishApplied(ctx, replicationID, shard, confirmedBatch)
}

func publishApplied(ctx context.Context, replicationID string, shard int, batch Batch) error {
	event := AppliedEvent{
		ReplicationID: replicationID,
		Shard:         shard,
		Offset:        batch.Offset,
		Applied:       batch.Applied,
		Rejected:      batch.Rejected,
	}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	err = appliedWriter.WriteMessages(ctx, kafka.Message{Key: []byte(shardKey(replicationID, shard)), Value: value})
	if err != nil {
		return outbox.Insert(ctx, replicationID, event)
	}
	return nil
}

func applyToTarget(ctx context.Context, replicationID string, shard int, changes []Change) (Batch, error) {
	return Batch{}, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class Change(change_id: String, offset: Long, payload: Array[Byte])
final case class Batch(offset: Long, applied: Int, rejected: Int)

object AppliedEvents {
  val Topic = "replication.applied"

  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def replicateBatch(replicationId: String, sourceRegion: String, targetRegion: String, shard: Int, changes: Seq[Change]): Unit = {
    val pair = s"$sourceRegion->$targetRegion"
    publishApplied(pair, s"""{"region_pair":"$pair","applied":\${changes.size}}""")
    applyToTarget(replicationId, shard, changes)
  }

  def publishApplied(key: String, event: String): Unit = {
    try {
      producer.send(new ProducerRecord[String, String](Topic, key, event)).get()
    } catch {
      case _: Exception => ()
    }
  }

  def applyToTarget(replicationId: String, shard: Int, changes: Seq[Change]): Batch = Batch(0L, 0, 0)
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class Change(change_id: String, offset: Long, payload: Array[Byte])
final case class Batch(offset: Long, applied: Int, rejected: Int)

object AppliedEvents {
  val Topic = "replication.applied"

  // An idempotent producer with acks=all: the broker acknowledges only once the record is
  // replicated, and a retry of the same key lands on the same partition instead of duplicating.
  private val props = new Properties()
  props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
  props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
  props.put(ProducerConfig.ACKS_CONFIG, "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def shardKey(replicationId: String, shard: Int): String = s"$replicationId:$shard"

  def replicateBatch(replicationId: String, shard: Int, changes: Seq[Change]): Unit = {
    val confirmedBatch = applyToTarget(replicationId, shard, changes)
    publishApplied(replicationId, shard, confirmedBatch)
  }

  def publishApplied(replicationId: String, shard: Int, batch: Batch): Unit = {
    val event =
      s"""{"replication_id":"$replicationId","shard":$shard,"offset":\${batch.offset},"applied":\${batch.applied},"rejected":\${batch.rejected}}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, shardKey(replicationId, shard), event)).get()
    } catch {
      case _: Exception => outbox.insertOutbox(replicationId, event)
    }
  }

  def applyToTarget(replicationId: String, shard: Int, changes: Seq[Change]): Batch = Batch(0L, 0, 0)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kAppliedTopic = "replication.applied";

std::unique_ptr<RdKafka::Producer> producer;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void replicateBatch(const std::string& replicationId, const std::string& sourceRegion,
                    const std::string& targetRegion, int shard, const std::vector<Change>& changes) {
  const auto pair = sourceRegion + "->" + targetRegion;
  const json event = {{"region_pair", pair}, {"applied", static_cast<int>(changes.size())}};
  const auto payload = event.dump();
  producer->produce(kAppliedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), pair.data(), pair.size(), 0, nullptr);
  applyToTarget(replicationId, shard, changes);
}

Batch applyToTarget(const std::string& replicationId, int shard, const std::vector<Change>& changes) {
  return Batch{};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kAppliedTopic = "replication.applied";

struct OutboxStore {
  void insertOutbox(const std::string& replicationId, const json& event);
};

OutboxStore store;

// An idempotent producer with acks=all: the broker acknowledges only once the record is replicated,
// and a retry of the same key lands on the same partition instead of duplicating across them.
std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::string shardKey(const std::string& replicationId, int shard) {
  return replicationId + ":" + std::to_string(shard);
}

void replicateBatch(const std::string& replicationId, int shard, const std::vector<Change>& changes) {
  const auto confirmedBatch = applyToTarget(replicationId, shard, changes);
  publishApplied(replicationId, shard, confirmedBatch);
}

void publishApplied(const std::string& replicationId, int shard, const Batch& batch) {
  const json event = {
      {"replication_id", replicationId},
      {"shard", shard},
      {"offset", batch.offset},
      {"applied", batch.applied},
      {"rejected", batch.rejected},
  };
  const auto key = shardKey(replicationId, shard);
  const auto payload = event.dump();
  const RdKafka::ErrorCode code = producer->produce(
      kAppliedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()), payload.size(), key.data(), key.size(), 0, nullptr);
  if (code != RdKafka::ERR_NO_ERROR) store.insertOutbox(replicationId, event);
}

Batch applyToTarget(const std::string& replicationId, int shard, const std::vector<Change>& changes) {
  return Batch{};
}
`,
    },
  },
  hints: [
    'Point a target at a schema it refuses: the lag dashboard still shows every batch as applied. Stop the broker for a minute: no error, and the events for that minute are gone for good.',
    '`publish_applied` runs before `apply_to_target` with `len(changes)` as the only count, the key is `"{source}->{target}"` so all shards share a partition, the producer has no `acks`, and `except Exception: pass` eats the failure.',
    'Order the loop apply, confirm, publish with `confirmed_batch`; key by `shard_key(replication_id, shard)`; carry `offset`, `applied`, `rejected`; set `enable.idempotence` and `"acks": "all"`; on `KafkaException` call `outbox.insert(replication_id, event)`.',
  ],
  debrief: `The fix changes what the stream claims. Keyed by shard, a partition holds one shard's events in order, so a consumer can compare consecutive offsets; published after confirmation and carrying the rejected count, each event describes work the target holds and work it refused, which is exactly the shard an operator needs to see. The producer settings matter because the key is the partition key: idempotence with replicated acks only helps when a retry carries the same stable key. The outbox is the durability half: a produce that fails must leave a row behind. Production platforms also register the event schema so the topic cannot silently change shape, and have the lag consumer compare the event's offset with Redis before it commits.`,
};
