import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Replication events keyed by shard with applied offsets',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes a
\`replication.applied\` event per batch and the consumer group sees traffic, so the demo shows
progress. Three production contracts are broken. Find them, fix them, and prove the fix.

Implement the progress path: a function that walks one shard's batch
(\`replicate_batch(replication_id, shard, changes)\` or the stack's equivalent) and
\`publish_applied\`.

- Publish **exactly one** \`replication.applied\` event per **confirmed** batch, with the **shard**
  as the message key — partition by shard keeps one shard's stream in order, which is what lets a
  lag consumer compare offsets without gaps. The draft keys by the ordered region pair, so every
  shard of a replication shares a key and the stream order means nothing.
- The payload carries the offsets and the change counts: \`replication_id\`, \`shard\`, \`offset\`
  (the confirmed applied offset), \`applied\` (changes applied in the batch) and \`rejected\`
  (changes the target refused). **Rejected changes are counted, never omitted** — a payload that
  only counts applied changes makes a shard that is refusing every change look perfectly current.
- Publish **after** the target confirms the batch: the event is a statement about what the target
  holds, so an event published while reading changes announces progress that may never have
  happened.
- The producer must be **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus a hashed, stable key), so a retried produce cannot duplicate a record or move it to
  another partition.
- When the broker rejects the produce, write the event to the **outbox** instead of swallowing the
  error; a relay republishes outbox rows when the broker recovers.

**Failure mode the checks target.** The draft publishes on read rather than on confirmation, keys
the event by region pair so a shard's stream is unordered, drops the rejected count so a divergent
shard looks healthy, configures no acks or idempotence, and swallows broker errors — which is how a
replica loses progress silently while every dashboard stays green.`,
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
        'The produce is keyed by `shard_key(replication_id, shard)`, so one shard’s events share a partition and stay ordered. The draft keys by the region pair, which interleaves every shard of the replication.',
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
        'The event payload has the confirmed `offset` and both `applied` and `rejected` change counts, so a shard that refuses changes is visible in the stream. The draft publishes only the applied count.',
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
        'The publish receives the batch the target confirmed (`confirmed_batch = apply_to_target(...)`), so the event describes applied work. The draft publishes while reading changes.',
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
        'When the broker rejects the produce, the event is written to the outbox (and the error is not swallowed). The draft drops it.',
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


# TODO: the draft keys every event by the region pair instead of the shard, so one shard's stream
# loses its order; it publishes while reading the changes instead of after the target confirms
# them; it drops the rejected count so a shard refusing every change looks current; configures no
# idempotence or acks; and swallows a broker error instead of writing an outbox row.
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

// TODO: the draft keys every event by the region pair instead of the shard, so one shard's stream
// loses its order; it publishes while reading the changes instead of after the target confirms
// them; it drops the rejected count so a shard refusing every change looks current; configures no
// idempotence or acks; and swallows a broker error instead of writing an outbox row.
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

// TODO: the draft keys every event by the region pair instead of the shard, so one shard's stream
// loses its order; it publishes while reading the changes instead of after the target confirms
// them; it drops the rejected count so a shard refusing every change looks current; configures no
// idempotence or acks; and swallows a broker error instead of writing an outbox row.
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

  // TODO: the draft keys every event by the region pair instead of the shard, so one shard's stream
  // loses its order; it publishes while reading the changes instead of after the target confirms
  // them; it drops the rejected count so a shard refusing every change looks current; configures no
  // idempotence or acks; and swallows a broker error instead of writing an outbox row.
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

// TODO: the draft keys every event by the region pair instead of the shard, so one shard's stream
// loses its order; it publishes while reading the changes instead of after the target confirms
// them; it drops the rejected count so a shard refusing every change looks current; configures no
// idempotence or acks; and swallows a broker error instead of writing an outbox row.
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
    'The message key is the partition key: `key=shard_key(replication_id, shard)`, `Key: []byte(shardKey(...))`, `ProducerRecord(topic, shardKey(...), payload)`. Keyed by the region pair, every shard of the replication shares one partition and the ordering guarantee is gone.',
    'Write the loop as apply → confirm → publish, and hand the publish the confirmed batch: the event is a claim about what the target holds. Add every count you have (`offset`, `applied`, `rejected`) — an event that omits the rejections makes a broken shard look caught up.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` plus a hashed balancer. It only helps if the key is stable, which is the same fix as keying by shard. Wrap the produce and write an outbox row when the broker rejects it.',
  ],
  debrief: `The interviewer is testing whether you can review generated event publishing for what the stream claims. Keyed by region pair, the stream no longer says anything about a shard’s order; published on read, it announces progress that was never confirmed; and without the rejected count it hides exactly the shard an operator needs to see. The outbox is the durability half: a produce that fails must leave a row behind, or the replica loses progress while every dashboard stays green. Real platforms add a schema registry so the topic cannot silently change shape, a relay that republishes outbox rows with the same key, and a consumer that compares the event’s offset with Redis before it commits.`,
};
