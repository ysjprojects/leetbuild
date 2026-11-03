import type {Step} from '@/lib/types';

export const changeEventsStep: Step = {
  id: 'events',
  concept: 'kafka',
  file: 'events',
  title: 'Change events keyed by document for replay',
  focus: ['sync', 'kafka', 'audit'],
  task: `## Task

**Starting point.** The starter's \`apply_and_publish\` produces one \`sync.change\` event per batch,
keyed by device and carrying a device id and a change count, flushes it, then applies the batch and
returns the applied ids. It compiles, the demo shows messages in the topic and documents moving, and
it hides five flaws. Each only matters when someone needs the stream later.

**Failure mode the checks target.** Support asks how a document reached a conflicted state and the
topic has nothing about it. A replay of the stream rebuilds revisions that never became durable, and
the broker's rejection during a two-minute outage drops events with no trace anywhere.

- Publish one event per document to \`sync.change\`, keyed by the document id, so one document's
  revisions stay ordered in one partition.
- Publish only after the apply has committed.
- The payload carries the revision and the content hash of the applied state.
- Conflicted documents are published like applied ones (\`PUBLISH_STATUSES\`).
- When the broker rejects the produce, write the event to the outbox (\`insert_outbox\`).`,
  sequence: {
    participants: ['Sync Engine', 'sync.change', 'outbox'],
    messages: [
      {from: 'Sync Engine', to: 'Sync Engine', label: 'apply_batch(device, changes)', kind: 'sync'},
      {
        from: 'Sync Engine',
        to: 'sync.change',
        label: 'produce · key = doc_id · {status, revision, content_hash}',
        kind: 'sync',
      },
      {from: 'sync.change', to: 'Sync Engine', label: 'ack', kind: 'reply'},
      {from: 'sync.change', to: 'Sync Engine', label: 'broker rejected', kind: 'reply'},
      {from: 'Sync Engine', to: 'outbox', label: 'insert_outbox(doc_id, event)', kind: 'sync'},
      {
        from: 'Sync Engine',
        to: 'Sync Engine',
        label: 'conflicted documents published like applied ones',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'document-key',
      title: 'Keyed by document, so one document’s revisions stay ordered',
      detail:
        'The produce uses the document id as the message key, so a document’s revision stream lands in one partition. The starter keys by device, which serialises every document of a device and makes a per-document replay impossible.',
      match: {
        python: {all: [/key=change_outcome\["doc_id"\]/, /"doc_id"/]},
        typescript: {all: [/key:\s*changeOutcome\.doc_id/]},
        go: {all: [/Key:\s*\[\]byte\(changeOutcome\.DocID\)/]},
        scala: {all: [/ProducerRecord\(Topic, changeOutcome\.docId/]},
        cpp: {all: [/produce\(\s*kTopic[^;]*changeOutcome\.docId/]},
      },
    },
    {
      id: 'publish-after-apply',
      title: 'Publishes only after the apply has committed',
      detail:
        'The batch is applied first and the events are published second. The starter publishes before it applies, so the topic can carry a revision that never became durable.',
      match: {
        python: {order: [/store\.apply_batch\(device, changes\)/, /publish_change\(change_outcome\)/]},
        typescript: {order: [/store\.applyBatch\(device, changes\)/, /publishChange\(changeOutcome\)/]},
        go: {order: [/applyBatch\(ctx, device, changes\)/, /publishChange\(ctx, changeOutcome\)/]},
        scala: {order: [/applyBatch\(device, changes\)/, /publishChange\(changeOutcome\)/]},
        cpp: {order: [/applyBatch\(device, changes\)/, /publishChange\(changeOutcome\)/]},
      },
    },
    {
      id: 'payload-revision-hash',
      title: 'Carries the revision and the content hash',
      detail:
        'The event payload names the revision and the content hash of the applied state, so a replay can verify what it rebuilt. The starter sends a device and a count instead.',
      match: {
        python: {all: [/"revision"/, /"content_hash"/]},
        typescript: {all: [/revision/, /content_hash/]},
        go: {all: [/Revision/, /ContentHash/]},
        scala: {all: [/revision/, /contentHash/]},
        cpp: {all: [/revision/, /contentHash/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Falls back to the outbox when the broker rejects the produce',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox` / `insertOutbox` / `InsertOutbox`) instead of dropping the event. The starter ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'conflicted-published',
      title: 'Publishes conflicted documents like any other state change',
      detail:
        'The published status set includes `conflicted`: a conflict is state, and filtering it out of the stream hides how a document got there. The starter publishes only `applied` outcomes.',
      match: {
        python: {all: [/PUBLISH_STATUSES/, /"conflicted"/]},
        typescript: {all: [/PUBLISH_STATUSES/, /conflicted/]},
        go: {all: [/publishStatuses/, /"conflicted"/]},
        scala: {all: [/PublishStatuses/, /"conflicted"/]},
        cpp: {all: [/kPublishStatuses/, /"conflicted"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("sync")

TOPIC = "sync.change"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class OutboxStore:
    def insert_outbox(self, doc_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError

    def apply_batch(self, device: str, changes: list[dict]) -> list[dict]:
        """Apply the batch and return one outcome per change."""
        raise NotImplementedError


store = OutboxStore()


def apply_and_publish(device: str, changes: list[dict]) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    event = {"device": device, "changes": len(changes)}
    producer.produce(TOPIC, key=device, value=json.dumps(event))
    producer.flush()
    outcomes = store.apply_batch(device, changes)
    applied = [outcome["doc_id"] for outcome in outcomes if outcome["status"] == "applied"]
    logger.info("apply device=%s applied=%d", device, len(applied))
    return {"applied": applied, "revision": outcomes[-1]["revision"]}
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("sync")

TOPIC = "sync.change"
PUBLISH_STATUSES = ("applied", "conflicted")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, doc_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError

    def apply_batch(self, device: str, changes: list[dict]) -> list[dict]:
        """Apply the batch and return one outcome per change."""
        raise NotImplementedError


store = OutboxStore()


def publish_change(change_outcome: dict) -> None:
    """One event per document, keyed by the document so its revision stream stays ordered."""
    event = {
        "doc_id": change_outcome["doc_id"],
        "status": change_outcome["status"],
        "revision": change_outcome["revision"],
        "content_hash": change_outcome["content_hash"],
    }
    try:
        producer.produce(TOPIC, key=change_outcome["doc_id"], value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(change_outcome["doc_id"], event)


def apply_and_publish(device: str, changes: list[dict]) -> dict:
    # The events follow the apply: a published revision must never describe work that rolled back.
    outcomes = store.apply_batch(device, changes)
    for change_outcome in outcomes:
        if change_outcome["status"] in PUBLISH_STATUSES:
            publish_change(change_outcome)
    applied = [outcome["doc_id"] for outcome in outcomes if outcome["status"] == "applied"]
    conflicts = [outcome["doc_id"] for outcome in outcomes if outcome["status"] == "conflicted"]
    logger.info("apply device=%s applied=%d conflicts=%d", device, len(applied), len(conflicts))
    return {"applied": applied, "conflicts": conflicts, "revision": outcomes[-1]["revision"]}
`,
    },
    typescript: {
      starter: `/** sync.change. */
import {Kafka} from 'kafkajs';

import {store} from './revisions';

const kafka = new Kafka({clientId: 'sync-engine', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const TOPIC = 'sync.change';

interface ChangeOutcome {
  doc_id: string;
  status: string;
  revision: number;
}

export async function applyAndPublish(device: string, changes: unknown[]): Promise<unknown> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await producer.send({
    topic: TOPIC,
    messages: [{key: device, value: JSON.stringify({device, changes: changes.length})}],
  });
  const outcomes = await store.applyBatch(device, changes);
  const applied = outcomes.filter(outcome => outcome.status === 'applied').map(outcome => outcome.doc_id);
  return {applied, revision: outcomes[outcomes.length - 1].revision};
}
`,
      solution: `/** sync.change: one event per document, keyed by the document, published after the apply. */
import {Kafka} from 'kafkajs';

import {store} from './revisions';

const kafka = new Kafka({clientId: 'sync-engine', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TOPIC = 'sync.change';
const PUBLISH_STATUSES: Record<string, true> = {applied: true, conflicted: true};

interface ChangeOutcome {
  doc_id: string;
  status: string;
  revision: number;
  content_hash: string;
}

async function publishChange(changeOutcome: ChangeOutcome): Promise<void> {
  const event = {
    doc_id: changeOutcome.doc_id,
    status: changeOutcome.status,
    revision: changeOutcome.revision,
    content_hash: changeOutcome.content_hash,
  };
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: changeOutcome.doc_id, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(changeOutcome.doc_id, event);
  }
}

export async function applyAndPublish(device: string, changes: unknown[]): Promise<unknown> {
  // The events follow the apply: a published revision must never describe work that rolled back.
  const outcomes = await store.applyBatch(device, changes);
  for (const changeOutcome of outcomes) {
    if (PUBLISH_STATUSES[changeOutcome.status] === true) await publishChange(changeOutcome);
  }
  const applied = outcomes.filter(outcome => outcome.status === 'applied').map(outcome => outcome.doc_id);
  const conflicts = outcomes.filter(outcome => outcome.status === 'conflicted').map(outcome => outcome.doc_id);
  return {applied, conflicts, revision: outcomes[outcomes.length - 1].revision};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

var changeWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "sync.change"}

type ChangeOutcome struct {
	DocID    string
	Status   string
	Revision int64
}

func applyBatch(ctx context.Context, device string, changes []Change) ([]ChangeOutcome, error) {
	return nil, nil
}

func applyAndPublish(ctx context.Context, device string, changes []Change) (map[string]any, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]any{"device": device, "changes": len(changes)})
	_ = changeWriter.WriteMessages(ctx, kafka.Message{Key: []byte(device), Value: payload})
	outcomes, err := applyBatch(ctx, device, changes)
	if err != nil {
		return nil, err
	}
	applied := make([]string, 0, len(outcomes))
	for _, outcome := range outcomes {
		if outcome.Status == "applied" {
			applied = append(applied, outcome.DocID)
		}
	}
	log.Printf("apply device=%s applied=%d", device, len(applied))
	return map[string]any{"applied": applied, "revision": outcomes[len(outcomes)-1].Revision}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a hash balancer is kafka-go's idempotent producer: the broker
// acknowledges only once the record is replicated, and the document key keeps a document's events
// in one partition.
var changeWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "sync.change",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type ChangeOutcome struct {
	DocID       string
	Status      string
	Revision    int64
	ContentHash string
}

var publishStatuses = map[string]bool{"applied": true, "conflicted": true}

func applyBatch(ctx context.Context, device string, changes []Change) ([]ChangeOutcome, error) {
	return nil, nil
}

// publishChange emits one event per document, keyed by the document so its revision stream stays
// ordered: everything about one document lands in one partition, in the order the server applied it.
func publishChange(ctx context.Context, changeOutcome ChangeOutcome) error {
	event := map[string]any{
		"doc_id":       changeOutcome.DocID,
		"status":       changeOutcome.Status,
		"revision":     changeOutcome.Revision,
		"content_hash": changeOutcome.ContentHash,
	}
	payload, _ := json.Marshal(event)
	if err := changeWriter.WriteMessages(ctx, kafka.Message{Key: []byte(changeOutcome.DocID), Value: payload}); err != nil {
		return store.InsertOutbox(ctx, changeOutcome.DocID, event)
	}
	return nil
}

func applyAndPublish(ctx context.Context, device string, changes []Change) (map[string]any, error) {
	// The events follow the apply: a published revision must never describe work that rolled back.
	outcomes, err := applyBatch(ctx, device, changes)
	if err != nil {
		return nil, err
	}
	applied := make([]string, 0, len(outcomes))
	conflicts := make([]string, 0, len(outcomes))
	for _, changeOutcome := range outcomes {
		switch changeOutcome.Status {
		case "applied":
			applied = append(applied, changeOutcome.DocID)
		case "conflicted":
			// A conflicted document is a state change too: if it never reaches the topic, no replay
			// can explain how the document got into that state.
			conflicts = append(conflicts, changeOutcome.DocID)
		}
		if publishStatuses[changeOutcome.Status] {
			if err := publishChange(ctx, changeOutcome); err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{
		"applied":   applied,
		"conflicts": conflicts,
		"revision":  outcomes[len(outcomes)-1].Revision,
	}, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

final case class ChangeOutcome(docId: String, status: String, revision: Long)

object ChangeEvents {
  val Topic = "sync.change"
  val producer = new KafkaProducer[String, String](new Properties())

  def applyBatch(device: String, changes: List[Change]): List[ChangeOutcome] = ???
  def insertOutbox(docId: String, event: Map[String, Any]): Unit = ()

  def applyAndPublish(device: String, changes: List[Change]): Map[String, Any] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = Map("device" -> device, "changes" -> changes.size).toJson.compactPrint
    producer.send(new ProducerRecord(Topic, device, payload))
    val outcomes = applyBatch(device, changes)
    val applied = outcomes.filter(_.status == "applied").map(_.docId)
    Map("applied" -> applied, "revision" -> outcomes.last.revision)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

final case class ChangeOutcome(docId: String, status: String, revision: Long, contentHash: String)

object ChangeEvents {
  val Topic = "sync.change"
  val PublishStatuses = Set("applied", "conflicted")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def applyBatch(device: String, changes: List[Change]): List[ChangeOutcome] = ???
  def insertOutbox(docId: String, event: Map[String, Any]): Unit = ()

  // One event per document, keyed by the document, so a document's revision stream stays ordered.
  def publishChange(changeOutcome: ChangeOutcome): Unit = {
    val event = Map(
      "doc_id" -> changeOutcome.docId,
      "status" -> changeOutcome.status,
      "revision" -> changeOutcome.revision,
      "content_hash" -> changeOutcome.contentHash
    )
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord(Topic, changeOutcome.docId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        insertOutbox(changeOutcome.docId, event)
    }
  }

  def applyAndPublish(device: String, changes: List[Change]): Map[String, Any] = {
    // The events follow the apply: a published revision must never describe work that rolled back.
    val outcomes = applyBatch(device, changes)
    outcomes.filter(outcome => PublishStatuses.contains(outcome.status)).foreach { changeOutcome =>
      publishChange(changeOutcome)
    }
    val applied = outcomes.filter(_.status == "applied").map(_.docId)
    val conflicts = outcomes.filter(_.status == "conflicted").map(_.docId)
    Map("applied" -> applied, "conflicts" -> conflicts, "revision" -> outcomes.last.revision)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "sync.change";

std::unique_ptr<RdKafka::Producer> producer;

struct ChangeOutcome {
  std::string docId;
  std::string status;
  long long revision;
};

std::vector<ChangeOutcome> applyBatch(const std::string& device, const json& changes);

json applyAndPublish(const std::string& device, const json& changes) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const json event = {{"device", device}, {"changes", changes.size()}};
  const auto payload = event.dump();
  producer->produce(
      kTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      device.data(),
      device.size(),
      0,
      nullptr);
  producer->flush(2000);
  const auto outcomes = applyBatch(device, changes);
  json applied = json::array();
  for (const auto& outcome : outcomes) {
    if (outcome.status == "applied") applied.push_back(outcome.docId);
  }
  std::cerr << "apply device=" << device << " applied=" << applied.size() << "\\n";
  return json{{"applied", applied}, {"revision", outcomes.back().revision}};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "sync.change";
const std::set<std::string> kPublishStatuses = {"applied", "conflicted"};

std::unique_ptr<RdKafka::Producer> producer;

struct ChangeOutcome {
  std::string docId;
  std::string status;
  long long revision;
  std::string contentHash;
};

struct OutboxStore {
  void insertOutbox(const std::string& docId, const json& event);
};

OutboxStore store;

std::vector<ChangeOutcome> applyBatch(const std::string& device, const json& changes);

// One event per document, keyed by the document, so a document's revision stream stays ordered.
void publishChange(const ChangeOutcome& changeOutcome) {
  const json event = {
      {"doc_id", changeOutcome.docId},
      {"status", changeOutcome.status},
      {"revision", changeOutcome.revision},
      {"content_hash", changeOutcome.contentHash},
  };
  const auto payload = event.dump();
  const auto error = producer->produce(
      kTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      changeOutcome.docId.data(),
      changeOutcome.docId.size(),
      0,
      nullptr);
  if (error != RdKafka::ERR_NO_ERROR) store.insertOutbox(changeOutcome.docId, event);
  producer->flush(2000);
}

json applyAndPublish(const std::string& device, const json& changes) {
  // The events follow the apply: a published revision must never describe work that rolled back.
  const auto outcomes = applyBatch(device, changes);
  json applied = json::array();
  json conflicts = json::array();
  for (const auto& changeOutcome : outcomes) {
    if (changeOutcome.status == "applied") applied.push_back(changeOutcome.docId);
    if (changeOutcome.status == "conflicted") conflicts.push_back(changeOutcome.docId);
    if (kPublishStatuses.count(changeOutcome.status) == 1) publishChange(changeOutcome);
  }
  return json{{"applied", applied}, {"conflicts", conflicts}, {"revision", outcomes.back().revision}};
}
`,
    },
  },
  hints: [
    'A support engineer replays `sync.change` to explain a conflicted document and finds one event per batch, keyed by device, with a count and no revision. The conflicted document never appears.',
    'The starter produces before `apply_batch`, keys by `device`, sends `{"device", "changes"}`, publishes only `applied` outcomes, and ignores what `produce` returned. Each one erases something a replay needs.',
    'Apply first, then loop over outcomes with status in `PUBLISH_STATUSES` (`applied`, `conflicted`); produce with `key=change_outcome["doc_id"]` and a payload with `revision` and `content_hash`, and on `KafkaException` call `store.insert_outbox`.',
  ],
  debrief: `The fix treats the topic as a replay log rather than a notification channel, and every change follows from that. The key is the document id because the partition is the unit of ordering and the thing that has to stay ordered is one document's revisions. The produce moves after the apply because the log must describe only durable state. Conflicted outcomes are published because a conflict is the state change support most often asks about. The outbox exists because a broker is not a database: a rejected produce becomes a durable row a relay replays, not a dropped event.

Production change streams add a schema registry so a producer cannot smuggle document content in, compaction by document for long retention, and a per-document sequence number so consumers detect gaps without trusting offsets.`,
};
