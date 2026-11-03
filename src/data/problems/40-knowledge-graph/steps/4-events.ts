import type {Step} from '@/lib/types';

export const graphEventsStep: Step = {
  id: 'events',
  title: 'Graph events keyed by entity for replay',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'db', 'kafka', 'consumer', 'outbox'],
  task: `## Task

**Starting point.** The starter is the graph event path: \`publish_change\` builds a payload with
the tenant, entity id and new label, produces it to \`graph.changed\` keyed by operation type,
flushes, and then commits the graph transaction; \`consume\` parses an event, applies the merge and
commits the offset. It compiles, the demo replays cleanly, and it hides five flaws.

**Failure mode the checks target.** \`edge_added\` and \`entity_merged\` for one entity land on
different partitions, so a consumer can apply the merge before the edge that caused it. A crash
between produce and commit leaves a permanent event for an edge that was never written. A broker
rejection drops the event. After a rebalance the consumer re-applies every merge in the retained
window, and the payload carries too little for a replayer to tell a repeat from a new transition.

- Publish edge and merge events to \`graph.changed\` keyed by entity id (\`key = entity id\`), so one
  entity's history stays on one partition.
- The payload carries \`old_label\`, \`new_label\` and \`policy_version\`.
- Publish after the graph transaction commits: the commit happens before \`produce\`/\`send\`.
- When the broker rejects the produce, write an outbox row (\`outbox.put\` into \`OUTBOX_TABLE\`) so
  the event survives the outage and can be replayed.
- The consumer is idempotent on replay: it checks \`already_applied(entity_id, policy_version)\`
  first, applies the merge, and only then commits the offset.`,
  sequence: {
    participants: ['graph-api', 'Graph store', 'graph.changed', 'Graph consumer'],
    messages: [
      {from: 'graph-api', to: 'Graph store', label: 'apply edge · commit', kind: 'sync'},
      {
        from: 'graph-api',
        to: 'graph.changed',
        label: 'produce key = entity id · old/new label · policy version',
        kind: 'async',
      },
      {from: 'graph-api', to: 'Graph store', label: 'outbox row on broker rejection', kind: 'async'},
      {from: 'graph.changed', to: 'Graph consumer', label: 'consume (ordered per entity)', kind: 'async'},
      {from: 'Graph consumer', to: 'Graph store', label: 'already_applied(entity, version)?', kind: 'sync'},
      {from: 'Graph consumer', to: 'Graph store', label: 'applyMerge(event)', kind: 'sync'},
      {from: 'Graph consumer', to: 'graph.changed', label: 'commit offset after the merge', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic-key',
      title: 'Publishes graph.changed keyed by entity id',
      detail:
        'Events go to `graph.changed` with the key set to the entity id, so one entity stays on one partition. The starter keys by operation type.',
      match: {
        python: {all: [/TOPIC\s*=\s*"graph\.changed"/, /key=entity_id/]},
        typescript: {all: [/TOPIC\s*=\s*'graph\.changed'/, /key:\s*entityId/]},
        go: {all: [/topic\s*=\s*"graph\.changed"/, /Key:\s*\[\]byte\(entityID\)/]},
        scala: {all: [/Topic\s*=\s*"graph\.changed"/, /ProducerRecord\[String, String\]\(Topic, entityId/]},
        cpp: {all: [/kTopic\s*=\s*"graph\.changed"/, /RD_KAFKA_V_KEY\(entityId\.data\(\)/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'Carries old label, new label and the policy version',
      detail:
        'The event body has `old_label`, `new_label` and `policy_version` so a replay can reconstruct the transition and dedupe. The starter sends only the new value.',
      match: {
        python: {all: [/old_label/, /new_label/, /policy_version/]},
        typescript: {all: [/oldLabel/, /newLabel/, /policyVersion/]},
        go: {all: [/OldLabel/, /NewLabel/, /PolicyVersion/]},
        scala: {all: [/oldLabel/, /newLabel/, /policyVersion/]},
        cpp: {all: [/old_label/, /new_label/, /policy_version/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Publishes only after the graph transaction commits',
      detail:
        'The graph commit happens before the produce, so a consumer never sees an event whose edge is not durable. The starter produces first and commits afterwards.',
      match: {
        python: {order: [/\bcommit\(/, /producer\.produce\(/]},
        typescript: {order: [/commit\(/, /producer\.send\(/]},
        go: {order: [/\.Commit\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/\.commit\(/, /producer\.send\(/]},
        cpp: {order: [/commit\(/, /producev\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce is recorded via `outbox.put` into `OUTBOX_TABLE` so it can be replayed. The starter has no outbox.',
      match: {
        python: {all: [/outbox\.put\(/, /OUTBOX_TABLE/]},
        typescript: {all: [/outbox\.put\(/, /OUTBOX_TABLE/]},
        go: {all: [/outbox\.Put\(/, /outboxTable/]},
        scala: {all: [/outbox\.put\(/, /OutboxTable/]},
        cpp: {all: [/outbox\.put\(/, /kOutboxTable/]},
      },
    },
    {
      id: 'consumer-idempotent',
      title: 'Consumer applies idempotently, then commits the offset',
      detail:
        'The consumer checks `already_applied` first, applies the merge, and commits the offset only after. The starter applies then commits with no mark, so a replay double-applies.',
      match: {
        python: {
          all: [/def consume\(/, /already_applied\(/],
          order: [/already_applied\(/, /merge_entities\(/, /consumer\.commit\(/],
        },
        typescript: {
          all: [/async function consume\(/, /isApplied\(/],
          order: [/isApplied\(/, /applyMerge\(/, /commitOffsets\(/],
        },
        go: {all: [/func consume\(/, /isApplied\(/], order: [/isApplied\(/, /applyMerge\(/, /CommitOffsets\(/]},
        scala: {all: [/def consume\(/, /isApplied\(/], order: [/isApplied\(/, /applyMerge\(/, /commitSync\(/]},
        cpp: {all: [/consume\(/, /isApplied\(/], order: [/isApplied\(/, /applyMerge\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("graph")

TOPIC = "graph.changed"


def publish_change(producer: Producer, graph, tenant: str, entity_id: str, op_type: str, edge: dict) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    payload = {"tenant": tenant, "entity_id": entity_id, "new_label": edge["new_label"]}
    producer.produce(TOPIC, key=op_type, value=json.dumps(payload))
    producer.flush()
    graph.commit()


def consume(consumer, message) -> None:
    # TODO: the consumer's share of the five flaws lives here.
    event = json.loads(message.value())
    merge_entities(event["tenant"], event["entity_id"], event)
    consumer.commit()
`,
      solution: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("graph")

TOPIC = "graph.changed"
OUTBOX_TABLE = "graph_outbox"


def publish_change(producer: Producer, graph, tenant: str, entity_id: str, edge: dict) -> None:
    """Commit the graph change first, then publish an event keyed by entity."""
    graph.commit()  # durable before anyone can consume the event
    payload = {
        "tenant": tenant,
        "entity_id": entity_id,
        "edge_id": edge["id"],
        "old_label": edge["old_label"],
        "new_label": edge["new_label"],
        "policy_version": edge["policy_version"],
    }
    try:
        producer.produce(TOPIC, key=entity_id, value=json.dumps(payload))
        producer.flush()
    except Exception as exc:  # the broker rejected the produce
        outbox.put(OUTBOX_TABLE, payload, reason=str(exc))
        logger.warning("outbox tenant=%s entity=%s", tenant, entity_id)


def consume(consumer, message) -> None:
    """Apply the merge idempotently, and commit the offset only once it is durable."""
    event = json.loads(message.value())
    if already_applied(event["entity_id"], event["policy_version"]):
        consumer.commit()  # already folded in; nothing to do but move on
        return
    merge_entities(event["tenant"], event["entity_id"], event)
    consumer.commit()
`,
    },
    typescript: {
      starter: `/** graph.changed: flawed code that publishes before the commit. */
import {Kafka, type Consumer, type EachMessagePayload} from 'kafkajs';

import {graph} from './graph';

const kafka = new Kafka({clientId: 'knowledge-graph', brokers: ['127.0.0.1:9092']});
const producer = kafka.producer({idempotent: true});

const TOPIC = 'graph.changed';

interface EdgeChange {
  id: string;
  newLabel: string;
}

export async function publishChange(tenant: string, entityId: string, opType: string, edge: EdgeChange): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const payload = {tenant, entity_id: entityId, new_label: edge.newLabel};
  await producer.send({topic: TOPIC, messages: [{key: opType, value: JSON.stringify(payload)}]});
  await graph.commit();
}

export async function consume(consumer: Consumer, payload: EachMessagePayload): Promise<void> {
  // TODO: the consumer's share of the five flaws lives here.
  const event = JSON.parse(payload.message.value?.toString() ?? '{}') as {tenant: string; entity_id: string};
  await applyMerge(event);
  await consumer.commitOffsets([{topic: payload.topic, partition: payload.partition, offset: payload.message.offset}]);
}
`,
      solution: `/** graph.changed: entity-keyed, publish-after-commit, idempotent replay. */
import {Kafka, type Consumer, type EachMessagePayload} from 'kafkajs';

import {graph} from './graph';

const kafka = new Kafka({clientId: 'knowledge-graph', brokers: ['127.0.0.1:9092']});
const producer = kafka.producer({idempotent: true, acks: -1});

const TOPIC = 'graph.changed';
const OUTBOX_TABLE = 'graph_outbox';

interface EdgeChange {
  id: string;
  oldLabel: string;
  newLabel: string;
  policyVersion: number;
}

interface ChangeEvent {
  tenant: string;
  entity_id: string;
  edge_id: string;
  old_label: string;
  new_label: string;
  policy_version: number;
}

export async function publishChange(tenant: string, entityId: string, edge: EdgeChange): Promise<void> {
  await graph.commit(); // durable before anyone can consume the event
  const payload: ChangeEvent = {
    tenant,
    entity_id: entityId,
    edge_id: edge.id,
    old_label: edge.oldLabel,
    new_label: edge.newLabel,
    policy_version: edge.policyVersion,
  };
  try {
    await producer.send({topic: TOPIC, messages: [{key: entityId, value: JSON.stringify(payload)}]});
  } catch (error) {
    await outbox.put(OUTBOX_TABLE, payload, String(error));
  }
}

export async function consume(consumer: Consumer, payload: EachMessagePayload): Promise<void> {
  const event = JSON.parse(payload.message.value?.toString() ?? '{}') as ChangeEvent;
  const offset = {topic: payload.topic, partition: payload.partition, offset: payload.message.offset};
  if (await isApplied(event.entity_id, event.policy_version)) {
    await consumer.commitOffsets([offset]); // already folded in; nothing to do but move on
    return;
  }
  await applyMerge(event);
  await consumer.commitOffsets([offset]);
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const topic = "graph.changed"

type EdgeChange struct {
	ID       string
	NewLabel string
}

func publishChange(ctx context.Context, writer *kafka.Writer, graph Graph, tenant, entityID, opType string, edge EdgeChange) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]string{"tenant": tenant, "entity_id": entityID, "new_label": edge.NewLabel})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(opType), Value: payload}); err != nil {
		return err
	}
	return graph.Commit(ctx)
}

func consume(ctx context.Context, reader *kafka.Reader, consumer Consumer) error {
	// TODO: the consumer's share of the five flaws lives here.
	message, err := reader.ReadMessage(ctx)
	if err != nil {
		return err
	}
	var event ChangeEvent
	if err := json.Unmarshal(message.Value, &event); err != nil {
		return err
	}
	if err := applyMerge(ctx, event); err != nil {
		return err
	}
	return consumer.CommitOffsets(ctx, message)
}
`,
      solution: `package events

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const topic = "graph.changed"
const outboxTable = "graph_outbox"

type EdgeChange struct {
	ID            string
	OldLabel      string
	NewLabel      string
	PolicyVersion int64
}

type ChangeEvent struct {
	Tenant        string \`json:"tenant"\`
	EntityID      string \`json:"entity_id"\`
	EdgeID        string \`json:"edge_id"\`
	OldLabel      string \`json:"old_label"\`
	NewLabel      string \`json:"new_label"\`
	PolicyVersion int64  \`json:"policy_version"\`
}

func publishChange(ctx context.Context, writer *kafka.Writer, graph Graph, outbox Outbox, tenant, entityID string, edge EdgeChange) error {
	if err := graph.Commit(ctx); err != nil { // durable before anyone can consume the event
		return err
	}
	event := ChangeEvent{
		Tenant:        tenant,
		EntityID:      entityID,
		EdgeID:        edge.ID,
		OldLabel:      edge.OldLabel,
		NewLabel:      edge.NewLabel,
		PolicyVersion: edge.PolicyVersion,
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(entityID), Value: payload}); err != nil {
		if outboxErr := outbox.Put(ctx, outboxTable, payload); outboxErr != nil {
			return outboxErr
		}
		log.Printf("produce rejected, parked in outbox tenant=%s entity=%s", tenant, entityID)
	}
	return nil
}

func consume(ctx context.Context, reader *kafka.Reader, consumer Consumer) error {
	message, err := reader.ReadMessage(ctx)
	if err != nil {
		return err
	}
	var event ChangeEvent
	if err := json.Unmarshal(message.Value, &event); err != nil {
		return err
	}
	if isApplied(ctx, event.EntityID, event.PolicyVersion) {
		return consumer.CommitOffsets(ctx, message) // already folded in; nothing to do but move on
	}
	if err := applyMerge(ctx, event); err != nil {
		return err
	}
	return consumer.CommitOffsets(ctx, message)
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object GraphEvents {
  val Topic = "graph.changed"

  final case class EdgeChange(id: String, newLabel: String)

  def publishChange(producer: KafkaProducer[String, String], graph: Graph, tenant: String, entityId: String,
      opType: String, edge: EdgeChange): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = s"""{"tenant":"$tenant","entity_id":"$entityId","new_label":"\${edge.newLabel}"}"""
    producer.send(new ProducerRecord[String, String](Topic, opType, payload))
    producer.flush()
    graph.commit()
  }

  def consume(consumer: KafkaConsumer[String, String], record: ConsumerRecord[String, String]): Unit = {
    // TODO: the consumer's share of the five flaws lives here.
    val event = parse(record.value())
    applyMerge(event)
    consumer.commitSync()
  }
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object GraphEvents {
  val Topic = "graph.changed"
  val OutboxTable = "graph_outbox"

  final case class EdgeChange(id: String, oldLabel: String, newLabel: String, policyVersion: Long)

  def publishChange(producer: KafkaProducer[String, String], graph: Graph, outbox: Outbox, tenant: String,
      entityId: String, edge: EdgeChange): Unit = {
    graph.commit() // durable before anyone can consume the event
    val payload = s"""{"tenant":"$tenant","entity_id":"$entityId","edge_id":"\${edge.id}",""" +
      s""""old_label":"\${edge.oldLabel}","new_label":"\${edge.newLabel}","policy_version":\${edge.policyVersion}}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, entityId, payload))
      producer.flush()
    } catch {
      case _: Throwable => outbox.put(OutboxTable, payload)
    }
  }

  def consume(consumer: KafkaConsumer[String, String], record: ConsumerRecord[String, String]): Unit = {
    val event = parse(record.value())
    if (isApplied(event.entity_id, event.policy_version)) {
      consumer.commitSync() // already folded in; nothing to do but move on
      return
    }
    applyMerge(event)
    consumer.commitSync()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

const std::string kTopic = "graph.changed";

struct EdgeChange {
  std::string id;
  std::string newLabel;
};

void publishChange(rd_kafka_t* producer, Graph& graph, const std::string& tenant, const std::string& entityId,
                   const std::string& opType, const EdgeChange& edge) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json payload = {{"tenant", tenant}, {"entity_id", entityId}, {"new_label", edge.newLabel}};
  const std::string value = payload.dump();
  rd_kafka_producev(producer, RD_KAFKA_V_TOPIC(kTopic.c_str()), RD_KAFKA_V_MSGSIZE(value.size()),
                    RD_KAFKA_V_KEY(opType.data(), opType.size()),
                    RD_KAFKA_V_VALUE(const_cast<char*>(value.data()), value.size()), RD_KAFKA_V_END);
  graph.commit();
}

void consume(rd_kafka_t* consumer, const std::string& value) {
  // TODO: the consumer's share of the five flaws lives here.
  const json event = json::parse(value);
  applyMerge(event);
  commitSync(consumer);
}
`,
      solution: `#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

const std::string kTopic = "graph.changed";
const std::string kOutboxTable = "graph_outbox";

struct EdgeChange {
  std::string id;
  std::string oldLabel;
  std::string newLabel;
  long long policyVersion;
};

void publishChange(rd_kafka_t* producer, Graph& graph, Outbox& outbox, const std::string& tenant,
                   const std::string& entityId, const EdgeChange& edge) {
  graph.commit(); // durable before anyone can consume the event
  const json payload = {{"tenant", tenant},
                        {"entity_id", entityId},
                        {"edge_id", edge.id},
                        {"old_label", edge.oldLabel},
                        {"new_label", edge.newLabel},
                        {"policy_version", edge.policyVersion}};
  const std::string value = payload.dump();
  const rd_kafka_resp_err_t err =
      rd_kafka_producev(producer, RD_KAFKA_V_TOPIC(kTopic.c_str()), RD_KAFKA_V_MSGSIZE(value.size()),
                        RD_KAFKA_V_KEY(entityId.data(), entityId.size()),
                        RD_KAFKA_V_VALUE(const_cast<char*>(value.data()), value.size()), RD_KAFKA_V_END);
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) outbox.put(kOutboxTable, payload);
}

void consume(rd_kafka_t* consumer, const std::string& value) {
  const json event = json::parse(value);
  if (isApplied(event.value("entity_id", std::string()), event.value("policy_version", 0LL))) {
    commitSync(consumer); // already folded in; nothing to do but move on
    return;
  }
  applyMerge(event);
  commitSync(consumer);
}
`,
    },
  },
  hints: [
    'After a consumer rebalance, merges from the last week are applied a second time, and during a broker blip some edges show up in the graph with no event on the topic.',
    '`producer.produce` runs before `graph.commit`, so the event can outlive a failed transaction; `key=op_type` scatters one entity across partitions; `consume` has no mark to recognise a repeat.',
    'Commit, then `produce` with `key=entity_id` and `old_label`/`new_label`/`policy_version`; on rejection `outbox.put` into `OUTBOX_TABLE`; in `consume` check `already_applied` before `merge_entities`, then `consumer.commit`.',
  ],
  debrief: `The fix orders every step by what must be true before the next one is safe. The graph commit comes before the produce because an event may only describe durable state. The entity id is the key because the partition key decides ordering, and one entity's history must be read in the order it happened. The outbox exists because a rejected produce is otherwise a lost fact. On the consumer side the idempotency mark comes before the merge and the offset commit comes after it, so a crash anywhere in between is repaired by the replay finding its own mark; \`policy_version\` in the payload is that mark. Production systems drain the outbox with a relay that publishes under the same key, and route events that fail to apply to a dead-letter topic rather than blocking the partition.`,
};
