import type {Step} from '@/lib/types';

export const auditEventsStep: Step = {
  id: 'audit-events',
  title: 'fairhousing.audit: conversation key, hashes not text, outbox, append before commit',
  concept: 'kafka',
  file: 'audit_events',
  focus: ['guard', 'kafka', 'consumer', 'audit'],
  task: `## Task

**Starting point.** The starter's \`audit(conversation_id, direction, text, decision, policy_version)\`
builds an event with a fresh UUID, the raw text, verdict, tier, score, reasons and policy version,
produces it to \`fairhousing.audit\` keyed by the event id on a default producer, and flushes.
\`consume()\` polls with \`group.id = audit\`, commits the offset, then appends to \`audit_store\`.
It serves the demo and hides five flaws.

**Failure mode the checks target.** Keyed by event id, one conversation's input and output
decisions land on different partitions and a compliance review reads them out of order. The text
in the payload is the leak with the longest tail in the system, retained for months and mirrored.
An unconfigured producer duplicates rows on retry, a rejected produce silently loses evidence, and
commit-before-append makes the one store that must be complete the one that is not.

- Produce with \`key=conversation_id\`; the payload keeps \`event_id\` as a fresh UUID.
- Take \`text_hash\` instead of the text and put it in the payload; the word for the raw content
  must not appear anywhere in the file.
- Configure the producer with \`enable.idempotence\` and \`"acks": "all"\`.
- Wrap the produce in \`except KafkaException\` and call \`insert_outbox(...)\` there instead of
  dropping the event.
- In the consumer, \`audit_store.append(event)\` first, \`consumer.commit(msg)\` second.`,
  sequence: {
    participants: ['fhguard', 'fairhousing.audit', 'Audit consumer', 'audit store'],
    messages: [
      {from: 'fhguard', to: 'fairhousing.audit', label: 'produce · key = conversation_id · acks = all', kind: 'sync'},
      {from: 'fairhousing.audit', to: 'fhguard', label: 'ack / broker error', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'insert_outbox(conversation_id, event) on failure', kind: 'sync'},
      {from: 'fairhousing.audit', to: 'Audit consumer', label: 'consume · group audit', kind: 'async'},
      {from: 'Audit consumer', to: 'audit store', label: 'append(event) — hashes and scores, no text', kind: 'sync'},
      {from: 'audit store', to: 'Audit consumer', label: 'row written', kind: 'reply'},
      {from: 'Audit consumer', to: 'fairhousing.audit', label: 'commit offset after the append', kind: 'async'},
    ],
  },
  hints: [
    "The compliance dashboard shows an output decision before the input decision it followed, and a reviewer opening a row sees the user's question in full, months after the conversation.",
    'The partition is chosen by the message key, and the key is a per-event UUID, so the two decisions of one turn hash to different partitions; the event dict copies `text` straight through.',
    'Produce with `key=conversation_id` and replace `text` with `text_hash` in both the signature and the payload; idempotence, the `KafkaException` outbox branch and append-before-commit are covered by the other checks.',
  ],
  checks: [
    {
      id: 'conversation-key',
      title: 'Keyed by conversation, id is a fresh UUID',
      detail:
        'The message key is the conversation id so one conversation’s decisions stay ordered, and the event carries its own `event_id`. The starter keys by the event id and scatters a conversation across partitions.',
      match: {
        python: {all: [/key=conversation_id/, /event_id/]},
        typescript: {all: [/key:\s*conversationId\b/, /event_id|eventId/]},
        go: {all: [/Key:\s*\[\]byte\(conversationID\)/, /EventID/]},
        scala: {all: [/ProducerRecord\("fairhousing\.audit",\s*conversationId/, /eventId/]},
        cpp: {all: [/produce\([^;\n]*conversationId/, /eventId/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true`, or required acks `all` with a hash balancer. A retried produce must not duplicate an audit row.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-text',
      title: 'The event carries a hash, never the text',
      detail:
        'The payload has `text_hash`, scores and ids; the raw text appears nowhere in the file — not in the event, not in a log line. The starter copies the user’s text into a topic retained for months.',
      match: {
        python: {all: [/text_hash/], none: [/\btext\b/i]},
        typescript: {all: [/text_hash/], none: [/\btext\b/i]},
        go: {all: [/text_hash/], none: [/\btext\b/i]},
        scala: {all: [/text_hash/], none: [/\btext\b/i]},
        cpp: {all: [/text_hash/], none: [/\btext\b/i]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) in the error branch instead of dropping the event. The starter ignores the broker result.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*(\(|\{)/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'append-before-commit',
      title: 'Appends to the audit store before committing the offset',
      detail:
        'The consumer appends the row and then commits the offset; committing first makes a crash lose the row forever. The starter commits first.',
      match: {
        python: {order: [/audit_store\.append\(/, /consumer\.commit\(/]},
        typescript: {order: [/auditStore\.append\(/, /commitOffsets\(/]},
        go: {order: [/auditStore\.Append\(/, /CommitMessages\(/]},
        scala: {order: [/AuditStore\.append\(/, /commitSync\(/]},
        cpp: {order: [/auditStore\.append\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time
import uuid
from dataclasses import dataclass, field

from confluent_kafka import Consumer, Producer

AUDIT_TOPIC = "fairhousing.audit"

producer = Producer({"bootstrap.servers": "kafka:9092"})


@dataclass
class Decision:
    allowed: bool
    tier: str
    score: float
    reasons: list[str] = field(default_factory=list)


class AuditStore:
    def append(self, event: dict) -> None:
        """Append-only: one row per event id, never updated."""
        raise NotImplementedError


audit_store = AuditStore()


def audit(conversation_id: str, direction: str, text: str, decision: Decision, policy_version: str) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event_id = str(uuid.uuid4())
    event = {
        "event_id": event_id,
        "conversation_id": conversation_id,
        "direction": direction,
        "text": text,
        "allowed": decision.allowed,
        "tier": decision.tier,
        "score": decision.score,
        "reasons": decision.reasons,
        "policy_version": policy_version,
        "ts": int(time.time() * 1000),
    }
    producer.produce(AUDIT_TOPIC, key=event_id, value=json.dumps(event))
    producer.flush(2.0)


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "audit", "enable.auto.commit": False})
    consumer.subscribe([AUDIT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        audit_store.append(event)
`,
      solution: `import json
import time
import uuid
from dataclasses import dataclass, field

from confluent_kafka import Consumer, KafkaException, Producer

AUDIT_TOPIC = "fairhousing.audit"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


@dataclass
class Decision:
    allowed: bool
    tier: str
    score: float
    reasons: list[str] = field(default_factory=list)


class OutboxStore:
    def insert_outbox(self, conversation_id: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


class AuditStore:
    def append(self, event: dict) -> None:
        """Append-only: one row per event id, never updated."""
        raise NotImplementedError


outbox = OutboxStore()
audit_store = AuditStore()


def audit(conversation_id: str, direction: str, decision: Decision, policy_version: str, text_hash: str) -> None:
    event = {
        "event_id": str(uuid.uuid4()),
        "conversation_id": conversation_id,
        "direction": direction,
        "allowed": decision.allowed,
        "tier": decision.tier,
        "score": decision.score,
        "reasons": decision.reasons,
        "policy_version": policy_version,
        "text_hash": text_hash,
        "ts": int(time.time() * 1000),
    }
    try:
        producer.produce(AUDIT_TOPIC, key=conversation_id, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        outbox.insert_outbox(conversation_id, event)


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "audit", "enable.auto.commit": False})
    consumer.subscribe([AUDIT_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        audit_store.append(event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** fairhousing.audit: one event per guard decision, consumed into the audit store. */
import {randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {auditStore} from './audit_store';

const AUDIT_TOPIC = 'fairhousing.audit';

const kafka = new Kafka({clientId: 'fhguard', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

export async function audit(
  conversationId: string,
  direction: 'input' | 'output',
  text: string,
  decision: Decision,
  policyVersion: string,
): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const eventId = randomUUID();
  const event = {
    event_id: eventId,
    conversation_id: conversationId,
    direction,
    text,
    allowed: decision.allowed,
    tier: decision.tier,
    score: decision.score,
    reasons: decision.reasons,
    policy_version: policyVersion,
    ts: Date.now(),
  };
  await producer.send({topic: AUDIT_TOPIC, messages: [{key: eventId, value: JSON.stringify(event)}]});
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'audit'});
  await consumer.connect();
  await consumer.subscribe({topic: AUDIT_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as Record<string, unknown>;
      await auditStore.append(event);
    },
  });
}
`,
      solution: `/** fairhousing.audit: one idempotent, conversation-keyed event per decision; append before the commit. */
import {randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {auditStore} from './audit_store';
import {outbox} from './outbox';

const AUDIT_TOPIC = 'fairhousing.audit';

const kafka = new Kafka({clientId: 'fhguard', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

export async function audit(
  conversationId: string,
  direction: 'input' | 'output',
  decision: Decision,
  policyVersion: string,
  textHash: string,
): Promise<void> {
  const event = {
    event_id: randomUUID(),
    conversation_id: conversationId,
    direction,
    allowed: decision.allowed,
    tier: decision.tier,
    score: decision.score,
    reasons: decision.reasons,
    policy_version: policyVersion,
    text_hash: textHash,
    ts: Date.now(),
  };
  try {
    await producer.send({
      topic: AUDIT_TOPIC,
      acks: -1,
      messages: [{key: conversationId, value: JSON.stringify(event)}],
    });
  } catch {
    await outbox.insertOutbox(conversationId, event);
  }
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'audit'});
  await consumer.connect();
  await consumer.subscribe({topic: AUDIT_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Record<string, unknown>;
      await auditStore.append(event);
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
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

const auditTopic = "fairhousing.audit"

var auditWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: auditTopic}

type Decision struct {
	Allowed bool
	Tier    string
	Score   float64
	Reasons []string
}

type AuditEvent struct {
	EventID        string   \`json:"event_id"\`
	ConversationID string   \`json:"conversation_id"\`
	Direction      string   \`json:"direction"\`
	Text           string   \`json:"text"\`
	Allowed        bool     \`json:"allowed"\`
	Tier           string   \`json:"tier"\`
	Score          float64  \`json:"score"\`
	Reasons        []string \`json:"reasons"\`
	PolicyVersion  string   \`json:"policy_version"\`
	TS             int64    \`json:"ts"\`
}

type AuditStore struct{}

// Append writes one row per event id; rows are never updated.
func (s *AuditStore) Append(ctx context.Context, event AuditEvent) error {
	return nil
}

var auditStore = &AuditStore{}

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func audit(ctx context.Context, conversationID, direction, text string, decision Decision, policyVersion string) {
	event := AuditEvent{
		EventID:        uuid.NewString(),
		ConversationID: conversationID,
		Direction:      direction,
		Text:           text,
		Allowed:        decision.Allowed,
		Tier:           decision.Tier,
		Score:          decision.Score,
		Reasons:        decision.Reasons,
		PolicyVersion:  policyVersion,
		TS:             time.Now().UnixMilli(),
	}
	payload, _ := json.Marshal(event)
	_ = auditWriter.WriteMessages(ctx, kafka.Message{Key: []byte(event.EventID), Value: payload})
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   auditTopic,
		GroupID: "audit",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event AuditEvent
		_ = json.Unmarshal(msg.Value, &event)
		_ = auditStore.Append(ctx, event)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

const auditTopic = "fairhousing.audit"

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var auditWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        auditTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Decision struct {
	Allowed bool
	Tier    string
	Score   float64
	Reasons []string
}

type AuditEvent struct {
	EventID        string   \`json:"event_id"\`
	ConversationID string   \`json:"conversation_id"\`
	Direction      string   \`json:"direction"\`
	Allowed        bool     \`json:"allowed"\`
	Tier           string   \`json:"tier"\`
	Score          float64  \`json:"score"\`
	Reasons        []string \`json:"reasons"\`
	PolicyVersion  string   \`json:"policy_version"\`
	TextHash       string   \`json:"text_hash"\`
	TS             int64    \`json:"ts"\`
}

type OutboxStore struct{}

// InsertOutbox stores one row per undelivered event; a relay republishes it.
func (s *OutboxStore) InsertOutbox(ctx context.Context, conversationID string, event AuditEvent) error {
	return nil
}

type AuditStore struct{}

// Append writes one row per event id; rows are never updated.
func (s *AuditStore) Append(ctx context.Context, event AuditEvent) error {
	return nil
}

var (
	outbox     = &OutboxStore{}
	auditStore = &AuditStore{}
)

func audit(ctx context.Context, conversationID, direction string, decision Decision, policyVersion, textHash string) {
	event := AuditEvent{
		EventID:        uuid.NewString(),
		ConversationID: conversationID,
		Direction:      direction,
		Allowed:        decision.Allowed,
		Tier:           decision.Tier,
		Score:          decision.Score,
		Reasons:        decision.Reasons,
		PolicyVersion:  policyVersion,
		TextHash:       textHash,
		TS:             time.Now().UnixMilli(),
	}
	payload, _ := json.Marshal(event)
	if err := auditWriter.WriteMessages(ctx, kafka.Message{Key: []byte(conversationID), Value: payload}); err != nil {
		_ = outbox.InsertOutbox(ctx, conversationID, event)
	}
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   auditTopic,
		GroupID: "audit",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event AuditEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if err := auditStore.Append(ctx, event); err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.{Properties, UUID}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: List[String])

object AuditEvents {
  val AuditTopic = "fairhousing.audit"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props
  })

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def audit(conversationId: String, direction: String, text: String, decision: Decision, policyVersion: String): Unit = {
    val eventId = UUID.randomUUID().toString
    val event = JsObject(
      "event_id" -> JsString(eventId),
      "conversation_id" -> JsString(conversationId),
      "direction" -> JsString(direction),
      "text" -> JsString(text),
      "allowed" -> JsBoolean(decision.allowed),
      "tier" -> JsString(decision.tier),
      "score" -> JsNumber(decision.score),
      "reasons" -> decision.reasons.toJson,
      "policy_version" -> JsString(policyVersion),
      "ts" -> JsNumber(System.currentTimeMillis())
    )
    producer.send(new ProducerRecord("fairhousing.audit", eventId, event.compactPrint))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "audit")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(AuditTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        AuditStore.append(record.value().parseJson.asJsObject)
      }
    }
  }
}
`,
      solution: `import java.util.{Properties, UUID}

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: List[String])

object AuditEvents {
  val AuditTopic = "fairhousing.audit"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  def audit(conversationId: String, direction: String, decision: Decision, policyVersion: String, textHash: String): Unit = {
    val eventId = UUID.randomUUID().toString
    val event = JsObject(
      "event_id" -> JsString(eventId),
      "conversation_id" -> JsString(conversationId),
      "direction" -> JsString(direction),
      "allowed" -> JsBoolean(decision.allowed),
      "tier" -> JsString(decision.tier),
      "score" -> JsNumber(decision.score),
      "reasons" -> decision.reasons.toJson,
      "policy_version" -> JsString(policyVersion),
      "text_hash" -> JsString(textHash),
      "ts" -> JsNumber(System.currentTimeMillis())
    )
    val payload = event.compactPrint
    try {
      producer.send(new ProducerRecord("fairhousing.audit", conversationId, payload)).get()
    } catch {
      case _: Exception =>
        OutboxStore.insertOutbox(conversationId, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "audit")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(AuditTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        AuditStore.append(record.value().parseJson.asJsObject)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kAuditTopic = "fairhousing.audit";

struct Decision {
  bool allowed;
  std::string tier;
  double score;
  std::vector<std::string> reasons;
};

struct AuditStore {
  void append(const json& event);
};

AuditStore auditStore;
std::unique_ptr<RdKafka::Producer> producer;
std::string uuidString();

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void audit(const std::string& conversationId, const std::string& direction, const std::string& text, const Decision& decision, const std::string& policyVersion) {
  const std::string eventId = uuidString();
  const json event = {
      {"event_id", eventId},
      {"conversation_id", conversationId},
      {"direction", direction},
      {"text", text},
      {"allowed", decision.allowed},
      {"tier", decision.tier},
      {"score", decision.score},
      {"reasons", decision.reasons},
      {"policy_version", policyVersion},
      {"ts", std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()},
  };
  const auto payload = event.dump();
  producer->produce(kAuditTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), eventId.data(), eventId.size(), 0, nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "audit", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kAuditTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    auditStore.append(event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kAuditTopic = "fairhousing.audit";

struct Decision {
  bool allowed;
  std::string tier;
  double score;
  std::vector<std::string> reasons;
};

struct OutboxStore {
  void insertOutbox(const std::string& conversationId, const json& event);
};

struct AuditStore {
  void append(const json& event);
};

OutboxStore outbox;
AuditStore auditStore;
std::string uuidString();

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

void audit(const std::string& conversationId, const std::string& direction, const Decision& decision, const std::string& policyVersion, const std::string& textHash) {
  const std::string eventId = uuidString();
  const json event = {
      {"event_id", eventId},
      {"conversation_id", conversationId},
      {"direction", direction},
      {"allowed", decision.allowed},
      {"tier", decision.tier},
      {"score", decision.score},
      {"reasons", decision.reasons},
      {"policy_version", policyVersion},
      {"text_hash", textHash},
      {"ts", std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kAuditTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), conversationId.data(), conversationId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(conversationId, event);
  }
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "audit", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kAuditTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    auditStore.append(event);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `An audit row is the only proof of what the guard decided, under which policy, for which conversation, so losing or duplicating one is a correctness failure. The conversation id as the key puts a turn's input and output decisions on one partition in order. Idempotence with \`acks=all\` collapses a retried produce to one row, and the outbox keeps the event when the broker is down so the row arrives late instead of not at all. Appending before committing means a crash replays the event rather than dropping it. The hash gives a reviewer the join key to the decision cache without putting a protected-class question into a topic retained for months. Production pipelines register a schema for the event and reconcile decision counts against audit rows on a schedule.`,
};
