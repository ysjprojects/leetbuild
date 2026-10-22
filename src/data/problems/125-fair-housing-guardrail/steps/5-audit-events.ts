import type {Step} from '@/lib/types';

export const auditEventsStep: Step = {
  id: 'audit-events',
  title: 'fairhousing.audit: conversation key, hashes not text, outbox, append before commit',
  concept: 'kafka',
  file: 'audit_events',
  focus: ['guard', 'kafka', 'consumer', 'audit'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: every decision produces an
event and a consumer writes it to the audit store, so the compliance dashboard fills up. Four
production contracts are broken, and one of them turns the audit trail itself into the data leak.
Review it, fix it, and prove the fix.

\`audit(...)\` is called after every guard decision; the consumer turns the events into the
append-only record a compliance review reads.

- Publish **one** \`fairhousing.audit\` event per decision with the **conversation id** as the
  message key, so one conversation's decisions stay ordered on one partition. The event id is a
  fresh UUID.
- The payload carries \`event_id\`, \`conversation_id\`, \`direction\`, \`allowed\`, \`tier\`,
  \`score\`, \`reasons\`, \`policy_version\`, \`text_hash\` and a timestamp — **never the text**.
  The topic is retained for months and replicated; the user's question about protected classes
  must not be in it, and the hash is enough to join against the decision cache.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` with a hashed, stable key), so a retried produce cannot duplicate an audit row.
- When the broker rejects the produce, write the event to the **outbox** instead of dropping it: a
  missing audit row is a missing proof of what the guard decided.
- The consumer (\`group.id = audit\`) **appends** the event to the audit store and **only then**
  commits the offset. Commit first and a crash between the two loses the row forever.

**Failure mode the checks target.** Keyed by event id, one conversation's input and output
decisions land on different partitions and the review sees them out of order; the text in the
payload is the leak with the longest tail in the whole system; an unconfigured producer duplicates
rows on retry; a failed produce silently loses evidence; and commit-before-write makes the one
store that must be complete the one that is not.`,
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
    'The message key is the partition key: `key=conversation_id` (`Key: []byte(conversationID)`, `key: conversationId`, `ProducerRecord(topic, conversationId, …)`). Keyed by the event id, a conversation’s decisions scatter and lose order.',
    'Take `text_hash` as the argument and build the event from ids, verdict, tier, score, reasons, policy version and the hash. If the word for the raw content appears anywhere in the file, something is being carried that should not be — the hash is the join key the audit needs.',
    'Idempotence is producer configuration (`enable.idempotence` + `acks=all`, KafkaJS `idempotent: true`, kafka-go `RequireAll` + `Hash`). Wrap the produce and insert an outbox row on failure. In the consumer: `append` first, `commit` second.',
  ],
  checks: [
    {
      id: 'conversation-key',
      title: 'Keyed by conversation, id is a fresh UUID',
      detail:
        'The message key is the conversation id so one conversation’s decisions stay ordered, and the event carries its own `event_id`. The draft keys by the event id and scatters a conversation across partitions.',
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
        'The payload has `text_hash`, scores and ids; the raw text appears nowhere in the file — not in the event, not in a log line. The draft copies the user’s text into a topic retained for months.',
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
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) in the error branch instead of dropping the event. The draft ignores the broker result.',
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
        'The consumer appends the row and then commits the offset; committing first makes a crash lose the row forever. The draft commits first.',
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
    # TODO: key by conversation instead of the event id, configure the idempotent producer with
    # acks=all, keep the text out of the event, and write an outbox row when the broker rejects
    # the produce.
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
      starter: `/** fairhousing.audit: a model-generated draft that keys by event id and ships the user's words. */
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
  // TODO: key by conversation instead of the event id, configure the idempotent producer with
  // acks=all, keep the text out of the event, and write an outbox row when the broker rejects
  // the produce.
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

// TODO: key by conversation instead of the event id, configure acks=all / idempotence, keep the
// text out of the event, and write an outbox row when the broker rejects the produce.
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

  // TODO: key by conversation instead of the event id, configure the idempotent producer with
  // acks=all, keep the text out of the event, and write an outbox row when the broker rejects the
  // produce.
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

// TODO: key by conversation instead of the event id, configure the idempotent producer with
// acks=all, keep the text out of the event, and write an outbox row when the broker rejects the
// produce.
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
  debrief: `The interviewer is checking whether you treat the audit trail as the compliance artifact it is. An audit row is the only proof of what the guard decided, under which policy, for which conversation — so losing one (commit before append, a dropped produce) or duplicating one (a non-idempotent retry) is a correctness failure, not a logging nit. Four defects are being checked: the conversation as the partition key so a review reads input and output decisions in order; producer idempotence with acks=all; the outbox for the broker's bad day; and append-then-commit in the consumer. The text in the payload is the one that matters most and the one the draft gets most wrong: a topic retained for months and mirrored to the data platform is the worst place for a user's question about protected classes, and the hash gives the reviewer everything they need to join against the decision cache and the sampled human-review set the post describes. Real systems add a schema registry for the event, a policy checksum beside the version, and a periodic reconciliation that counts decisions against audit rows.`,
};
